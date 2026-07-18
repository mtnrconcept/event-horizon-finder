-- Supersedes the unapplied 20260718125000 backfill. Production already
-- contains migrations 20260718123000, 20260718124000 and 20260718130000,
-- so this migration deliberately has a later timestamp.
--
-- The worldwide staging table contains more than 157,000 wide rows. Running
-- every sanitizer in one statement exceeds the protected branch's two-minute
-- statement timeout. Each top-level call below handles one indexed two-hex
-- range, remains well below that limit, and is safe to replay after a partial
-- failure because every write is an idempotent upsert.

SET statement_timeout = '90s';
SET lock_timeout = '10s';

-- Avoid invoking the sanitizer bodies for absent optional values. These
-- functions already returned NULL for NULL inputs, so this changes only their
-- execution cost, not their result.
ALTER FUNCTION private.clean_public_event_text(TEXT, INTEGER)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_url(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_email(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_phone(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_boolean(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_integer(TEXT, INTEGER, INTEGER)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_numeric(TEXT, NUMERIC, NUMERIC)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_timestamp(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_timestamp_text(TEXT)
  RETURNS NULL ON NULL INPUT;
ALTER FUNCTION private.clean_public_event_json(JSONB, INTEGER, INTEGER)
  RETURNS NULL ON NULL INPUT;

DO $validate_optional_eventscrap_schema$
DECLARE
  staging_table REGCLASS := to_regclass('public.eventscrap');
  required_column_count INTEGER := 0;
BEGIN
  IF staging_table IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)
    INTO required_column_count
  FROM pg_catalog.pg_attribute
  WHERE attrelid = staging_table
    AND attnum > 0
    AND NOT attisdropped
    AND attname = ANY (ARRAY[
      'event_id', 'source', 'source_event_id', 'source_url',
      'event_name', 'start_datetime', 'scraped_at_utc'
    ]);

  IF required_column_count <> 7 THEN
    RAISE EXCEPTION
      'public.eventscrap exists but its visitor-detail columns are incomplete';
  END IF;
END;
$validate_optional_eventscrap_schema$;

CREATE OR REPLACE FUNCTION private.backfill_public_eventscrap_range_v1(
  _lower_bound TEXT,
  _upper_bound TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  affected_rows BIGINT := 0;
BEGIN
  IF _lower_bound IS NULL
    OR _upper_bound IS NULL
    OR _lower_bound >= _upper_bound
  THEN
    RAISE EXCEPTION 'Invalid eventscrap backfill bounds';
  END IF;

  IF to_regclass('public.eventscrap') IS NULL THEN
    RETURN 0;
  END IF;

  EXECUTE $query$
    WITH candidates AS MATERIALIZED (
      SELECT
        event.id AS event_id,
        to_jsonb(stage) AS payload
      FROM public.eventscrap AS stage
      JOIN public.events AS event
        ON event.canonical_fingerprint =
          private.public_eventscrap_fingerprint_fields_v1(
            stage.event_id::TEXT,
            stage.source::TEXT,
            stage.source_event_id::TEXT,
            stage.source_url::TEXT,
            stage.event_name::TEXT,
            stage.start_datetime::TEXT
          )
      WHERE stage.event_id >= $1
        AND stage.event_id < $2
    ), prepared AS MATERIALIZED (
      SELECT
        candidate.event_id,
        private.public_event_scraped_details_v1(
          candidate.payload,
          candidate.payload->>'source_url',
          candidate.payload->>'source'
        ) AS details,
        private.public_event_payload_freshness_v1(candidate.payload)
          AS source_updated_at
      FROM candidates AS candidate
    )
    INSERT INTO public.event_scraped_details(event_id, details, updated_at)
    SELECT event_id, details, source_updated_at
    FROM prepared
    WHERE details <> '{}'::JSONB
      AND pg_column_size(details) <= 524288
    ON CONFLICT (event_id) DO UPDATE SET
      details = CASE
        WHEN EXCLUDED.updated_at >= public.event_scraped_details.updated_at
          THEN public.event_scraped_details.details || EXCLUDED.details
        ELSE EXCLUDED.details || public.event_scraped_details.details
      END,
      updated_at = greatest(
        public.event_scraped_details.updated_at,
        EXCLUDED.updated_at
      )
  $query$
  USING _lower_bound, _upper_bound;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$function$;

CREATE OR REPLACE FUNCTION private.backfill_public_eventscrap_remaining_v1()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  affected_rows BIGINT := 0;
BEGIN
  IF to_regclass('public.eventscrap') IS NULL THEN
    RETURN 0;
  END IF;

  EXECUTE $query$
    WITH ranked AS MATERIALIZED (
      SELECT DISTINCT ON (event.id)
        event.id AS event_id,
        to_jsonb(stage) AS payload
      FROM public.eventscrap AS stage
      JOIN public.events AS event
        ON event.canonical_fingerprint =
          private.public_eventscrap_fingerprint_fields_v1(
            stage.event_id::TEXT,
            stage.source::TEXT,
            stage.source_event_id::TEXT,
            stage.source_url::TEXT,
            stage.event_name::TEXT,
            stage.start_datetime::TEXT
          )
      WHERE stage.event_id IS NULL
        OR stage.event_id !~ '^[0-9a-f]{2}'
      ORDER BY
        event.id,
        private.public_event_payload_freshness_v1(to_jsonb(stage)) DESC,
        md5(to_jsonb(stage)::TEXT) DESC
    ), prepared AS MATERIALIZED (
      SELECT
        ranked.event_id,
        private.public_event_scraped_details_v1(
          ranked.payload,
          ranked.payload->>'source_url',
          ranked.payload->>'source'
        ) AS details,
        private.public_event_payload_freshness_v1(ranked.payload)
          AS source_updated_at
      FROM ranked
    )
    INSERT INTO public.event_scraped_details(event_id, details, updated_at)
    SELECT event_id, details, source_updated_at
    FROM prepared
    WHERE details <> '{}'::JSONB
      AND pg_column_size(details) <= 524288
    ON CONFLICT (event_id) DO UPDATE SET
      details = CASE
        WHEN EXCLUDED.updated_at >= public.event_scraped_details.updated_at
          THEN public.event_scraped_details.details || EXCLUDED.details
        ELSE EXCLUDED.details || public.event_scraped_details.details
      END,
      updated_at = greatest(
        public.event_scraped_details.updated_at,
        EXCLUDED.updated_at
      )
  $query$;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$function$;

REVOKE ALL ON FUNCTION private.backfill_public_eventscrap_range_v1(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.backfill_public_eventscrap_remaining_v1()
  FROM PUBLIC, anon, authenticated;

SELECT private.backfill_public_eventscrap_range_v1('00', '01');
SELECT private.backfill_public_eventscrap_range_v1('01', '02');
SELECT private.backfill_public_eventscrap_range_v1('02', '03');
SELECT private.backfill_public_eventscrap_range_v1('03', '04');
SELECT private.backfill_public_eventscrap_range_v1('04', '05');
SELECT private.backfill_public_eventscrap_range_v1('05', '06');
SELECT private.backfill_public_eventscrap_range_v1('06', '07');
SELECT private.backfill_public_eventscrap_range_v1('07', '08');
SELECT private.backfill_public_eventscrap_range_v1('08', '09');
SELECT private.backfill_public_eventscrap_range_v1('09', '0a');
SELECT private.backfill_public_eventscrap_range_v1('0a', '0b');
SELECT private.backfill_public_eventscrap_range_v1('0b', '0c');
SELECT private.backfill_public_eventscrap_range_v1('0c', '0d');
SELECT private.backfill_public_eventscrap_range_v1('0d', '0e');
SELECT private.backfill_public_eventscrap_range_v1('0e', '0f');
SELECT private.backfill_public_eventscrap_range_v1('0f', '10');
SELECT private.backfill_public_eventscrap_range_v1('10', '11');
SELECT private.backfill_public_eventscrap_range_v1('11', '12');
SELECT private.backfill_public_eventscrap_range_v1('12', '13');
SELECT private.backfill_public_eventscrap_range_v1('13', '14');
SELECT private.backfill_public_eventscrap_range_v1('14', '15');
SELECT private.backfill_public_eventscrap_range_v1('15', '16');
SELECT private.backfill_public_eventscrap_range_v1('16', '17');
SELECT private.backfill_public_eventscrap_range_v1('17', '18');
SELECT private.backfill_public_eventscrap_range_v1('18', '19');
SELECT private.backfill_public_eventscrap_range_v1('19', '1a');
SELECT private.backfill_public_eventscrap_range_v1('1a', '1b');
SELECT private.backfill_public_eventscrap_range_v1('1b', '1c');
SELECT private.backfill_public_eventscrap_range_v1('1c', '1d');
SELECT private.backfill_public_eventscrap_range_v1('1d', '1e');
SELECT private.backfill_public_eventscrap_range_v1('1e', '1f');
SELECT private.backfill_public_eventscrap_range_v1('1f', '20');
SELECT private.backfill_public_eventscrap_range_v1('20', '21');
SELECT private.backfill_public_eventscrap_range_v1('21', '22');
SELECT private.backfill_public_eventscrap_range_v1('22', '23');
SELECT private.backfill_public_eventscrap_range_v1('23', '24');
SELECT private.backfill_public_eventscrap_range_v1('24', '25');
SELECT private.backfill_public_eventscrap_range_v1('25', '26');
SELECT private.backfill_public_eventscrap_range_v1('26', '27');
SELECT private.backfill_public_eventscrap_range_v1('27', '28');
SELECT private.backfill_public_eventscrap_range_v1('28', '29');
SELECT private.backfill_public_eventscrap_range_v1('29', '2a');
SELECT private.backfill_public_eventscrap_range_v1('2a', '2b');
SELECT private.backfill_public_eventscrap_range_v1('2b', '2c');
SELECT private.backfill_public_eventscrap_range_v1('2c', '2d');
SELECT private.backfill_public_eventscrap_range_v1('2d', '2e');
SELECT private.backfill_public_eventscrap_range_v1('2e', '2f');
SELECT private.backfill_public_eventscrap_range_v1('2f', '30');
SELECT private.backfill_public_eventscrap_range_v1('30', '31');
SELECT private.backfill_public_eventscrap_range_v1('31', '32');
SELECT private.backfill_public_eventscrap_range_v1('32', '33');
SELECT private.backfill_public_eventscrap_range_v1('33', '34');
SELECT private.backfill_public_eventscrap_range_v1('34', '35');
SELECT private.backfill_public_eventscrap_range_v1('35', '36');
SELECT private.backfill_public_eventscrap_range_v1('36', '37');
SELECT private.backfill_public_eventscrap_range_v1('37', '38');
SELECT private.backfill_public_eventscrap_range_v1('38', '39');
SELECT private.backfill_public_eventscrap_range_v1('39', '3a');
SELECT private.backfill_public_eventscrap_range_v1('3a', '3b');
SELECT private.backfill_public_eventscrap_range_v1('3b', '3c');
SELECT private.backfill_public_eventscrap_range_v1('3c', '3d');
SELECT private.backfill_public_eventscrap_range_v1('3d', '3e');
SELECT private.backfill_public_eventscrap_range_v1('3e', '3f');
SELECT private.backfill_public_eventscrap_range_v1('3f', '40');
SELECT private.backfill_public_eventscrap_range_v1('40', '41');
SELECT private.backfill_public_eventscrap_range_v1('41', '42');
SELECT private.backfill_public_eventscrap_range_v1('42', '43');
SELECT private.backfill_public_eventscrap_range_v1('43', '44');
SELECT private.backfill_public_eventscrap_range_v1('44', '45');
SELECT private.backfill_public_eventscrap_range_v1('45', '46');
SELECT private.backfill_public_eventscrap_range_v1('46', '47');
SELECT private.backfill_public_eventscrap_range_v1('47', '48');
SELECT private.backfill_public_eventscrap_range_v1('48', '49');
SELECT private.backfill_public_eventscrap_range_v1('49', '4a');
SELECT private.backfill_public_eventscrap_range_v1('4a', '4b');
SELECT private.backfill_public_eventscrap_range_v1('4b', '4c');
SELECT private.backfill_public_eventscrap_range_v1('4c', '4d');
SELECT private.backfill_public_eventscrap_range_v1('4d', '4e');
SELECT private.backfill_public_eventscrap_range_v1('4e', '4f');
SELECT private.backfill_public_eventscrap_range_v1('4f', '50');
SELECT private.backfill_public_eventscrap_range_v1('50', '51');
SELECT private.backfill_public_eventscrap_range_v1('51', '52');
SELECT private.backfill_public_eventscrap_range_v1('52', '53');
SELECT private.backfill_public_eventscrap_range_v1('53', '54');
SELECT private.backfill_public_eventscrap_range_v1('54', '55');
SELECT private.backfill_public_eventscrap_range_v1('55', '56');
SELECT private.backfill_public_eventscrap_range_v1('56', '57');
SELECT private.backfill_public_eventscrap_range_v1('57', '58');
SELECT private.backfill_public_eventscrap_range_v1('58', '59');
SELECT private.backfill_public_eventscrap_range_v1('59', '5a');
SELECT private.backfill_public_eventscrap_range_v1('5a', '5b');
SELECT private.backfill_public_eventscrap_range_v1('5b', '5c');
SELECT private.backfill_public_eventscrap_range_v1('5c', '5d');
SELECT private.backfill_public_eventscrap_range_v1('5d', '5e');
SELECT private.backfill_public_eventscrap_range_v1('5e', '5f');
SELECT private.backfill_public_eventscrap_range_v1('5f', '60');
SELECT private.backfill_public_eventscrap_range_v1('60', '61');
SELECT private.backfill_public_eventscrap_range_v1('61', '62');
SELECT private.backfill_public_eventscrap_range_v1('62', '63');
SELECT private.backfill_public_eventscrap_range_v1('63', '64');
SELECT private.backfill_public_eventscrap_range_v1('64', '65');
SELECT private.backfill_public_eventscrap_range_v1('65', '66');
SELECT private.backfill_public_eventscrap_range_v1('66', '67');
SELECT private.backfill_public_eventscrap_range_v1('67', '68');
SELECT private.backfill_public_eventscrap_range_v1('68', '69');
SELECT private.backfill_public_eventscrap_range_v1('69', '6a');
SELECT private.backfill_public_eventscrap_range_v1('6a', '6b');
SELECT private.backfill_public_eventscrap_range_v1('6b', '6c');
SELECT private.backfill_public_eventscrap_range_v1('6c', '6d');
SELECT private.backfill_public_eventscrap_range_v1('6d', '6e');
SELECT private.backfill_public_eventscrap_range_v1('6e', '6f');
SELECT private.backfill_public_eventscrap_range_v1('6f', '70');
SELECT private.backfill_public_eventscrap_range_v1('70', '71');
SELECT private.backfill_public_eventscrap_range_v1('71', '72');
SELECT private.backfill_public_eventscrap_range_v1('72', '73');
SELECT private.backfill_public_eventscrap_range_v1('73', '74');
SELECT private.backfill_public_eventscrap_range_v1('74', '75');
SELECT private.backfill_public_eventscrap_range_v1('75', '76');
SELECT private.backfill_public_eventscrap_range_v1('76', '77');
SELECT private.backfill_public_eventscrap_range_v1('77', '78');
SELECT private.backfill_public_eventscrap_range_v1('78', '79');
SELECT private.backfill_public_eventscrap_range_v1('79', '7a');
SELECT private.backfill_public_eventscrap_range_v1('7a', '7b');
SELECT private.backfill_public_eventscrap_range_v1('7b', '7c');
SELECT private.backfill_public_eventscrap_range_v1('7c', '7d');
SELECT private.backfill_public_eventscrap_range_v1('7d', '7e');
SELECT private.backfill_public_eventscrap_range_v1('7e', '7f');
SELECT private.backfill_public_eventscrap_range_v1('7f', '80');
SELECT private.backfill_public_eventscrap_range_v1('80', '81');
SELECT private.backfill_public_eventscrap_range_v1('81', '82');
SELECT private.backfill_public_eventscrap_range_v1('82', '83');
SELECT private.backfill_public_eventscrap_range_v1('83', '84');
SELECT private.backfill_public_eventscrap_range_v1('84', '85');
SELECT private.backfill_public_eventscrap_range_v1('85', '86');
SELECT private.backfill_public_eventscrap_range_v1('86', '87');
SELECT private.backfill_public_eventscrap_range_v1('87', '88');
SELECT private.backfill_public_eventscrap_range_v1('88', '89');
SELECT private.backfill_public_eventscrap_range_v1('89', '8a');
SELECT private.backfill_public_eventscrap_range_v1('8a', '8b');
SELECT private.backfill_public_eventscrap_range_v1('8b', '8c');
SELECT private.backfill_public_eventscrap_range_v1('8c', '8d');
SELECT private.backfill_public_eventscrap_range_v1('8d', '8e');
SELECT private.backfill_public_eventscrap_range_v1('8e', '8f');
SELECT private.backfill_public_eventscrap_range_v1('8f', '90');
SELECT private.backfill_public_eventscrap_range_v1('90', '91');
SELECT private.backfill_public_eventscrap_range_v1('91', '92');
SELECT private.backfill_public_eventscrap_range_v1('92', '93');
SELECT private.backfill_public_eventscrap_range_v1('93', '94');
SELECT private.backfill_public_eventscrap_range_v1('94', '95');
SELECT private.backfill_public_eventscrap_range_v1('95', '96');
SELECT private.backfill_public_eventscrap_range_v1('96', '97');
SELECT private.backfill_public_eventscrap_range_v1('97', '98');
SELECT private.backfill_public_eventscrap_range_v1('98', '99');
SELECT private.backfill_public_eventscrap_range_v1('99', '9a');
SELECT private.backfill_public_eventscrap_range_v1('9a', '9b');
SELECT private.backfill_public_eventscrap_range_v1('9b', '9c');
SELECT private.backfill_public_eventscrap_range_v1('9c', '9d');
SELECT private.backfill_public_eventscrap_range_v1('9d', '9e');
SELECT private.backfill_public_eventscrap_range_v1('9e', '9f');
SELECT private.backfill_public_eventscrap_range_v1('9f', 'a0');
SELECT private.backfill_public_eventscrap_range_v1('a0', 'a1');
SELECT private.backfill_public_eventscrap_range_v1('a1', 'a2');
SELECT private.backfill_public_eventscrap_range_v1('a2', 'a3');
SELECT private.backfill_public_eventscrap_range_v1('a3', 'a4');
SELECT private.backfill_public_eventscrap_range_v1('a4', 'a5');
SELECT private.backfill_public_eventscrap_range_v1('a5', 'a6');
SELECT private.backfill_public_eventscrap_range_v1('a6', 'a7');
SELECT private.backfill_public_eventscrap_range_v1('a7', 'a8');
SELECT private.backfill_public_eventscrap_range_v1('a8', 'a9');
SELECT private.backfill_public_eventscrap_range_v1('a9', 'aa');
SELECT private.backfill_public_eventscrap_range_v1('aa', 'ab');
SELECT private.backfill_public_eventscrap_range_v1('ab', 'ac');
SELECT private.backfill_public_eventscrap_range_v1('ac', 'ad');
SELECT private.backfill_public_eventscrap_range_v1('ad', 'ae');
SELECT private.backfill_public_eventscrap_range_v1('ae', 'af');
SELECT private.backfill_public_eventscrap_range_v1('af', 'b0');
SELECT private.backfill_public_eventscrap_range_v1('b0', 'b1');
SELECT private.backfill_public_eventscrap_range_v1('b1', 'b2');
SELECT private.backfill_public_eventscrap_range_v1('b2', 'b3');
SELECT private.backfill_public_eventscrap_range_v1('b3', 'b4');
SELECT private.backfill_public_eventscrap_range_v1('b4', 'b5');
SELECT private.backfill_public_eventscrap_range_v1('b5', 'b6');
SELECT private.backfill_public_eventscrap_range_v1('b6', 'b7');
SELECT private.backfill_public_eventscrap_range_v1('b7', 'b8');
SELECT private.backfill_public_eventscrap_range_v1('b8', 'b9');
SELECT private.backfill_public_eventscrap_range_v1('b9', 'ba');
SELECT private.backfill_public_eventscrap_range_v1('ba', 'bb');
SELECT private.backfill_public_eventscrap_range_v1('bb', 'bc');
SELECT private.backfill_public_eventscrap_range_v1('bc', 'bd');
SELECT private.backfill_public_eventscrap_range_v1('bd', 'be');
SELECT private.backfill_public_eventscrap_range_v1('be', 'bf');
SELECT private.backfill_public_eventscrap_range_v1('bf', 'c0');
SELECT private.backfill_public_eventscrap_range_v1('c0', 'c1');
SELECT private.backfill_public_eventscrap_range_v1('c1', 'c2');
SELECT private.backfill_public_eventscrap_range_v1('c2', 'c3');
SELECT private.backfill_public_eventscrap_range_v1('c3', 'c4');
SELECT private.backfill_public_eventscrap_range_v1('c4', 'c5');
SELECT private.backfill_public_eventscrap_range_v1('c5', 'c6');
SELECT private.backfill_public_eventscrap_range_v1('c6', 'c7');
SELECT private.backfill_public_eventscrap_range_v1('c7', 'c8');
SELECT private.backfill_public_eventscrap_range_v1('c8', 'c9');
SELECT private.backfill_public_eventscrap_range_v1('c9', 'ca');
SELECT private.backfill_public_eventscrap_range_v1('ca', 'cb');
SELECT private.backfill_public_eventscrap_range_v1('cb', 'cc');
SELECT private.backfill_public_eventscrap_range_v1('cc', 'cd');
SELECT private.backfill_public_eventscrap_range_v1('cd', 'ce');
SELECT private.backfill_public_eventscrap_range_v1('ce', 'cf');
SELECT private.backfill_public_eventscrap_range_v1('cf', 'd0');
SELECT private.backfill_public_eventscrap_range_v1('d0', 'd1');
SELECT private.backfill_public_eventscrap_range_v1('d1', 'd2');
SELECT private.backfill_public_eventscrap_range_v1('d2', 'd3');
SELECT private.backfill_public_eventscrap_range_v1('d3', 'd4');
SELECT private.backfill_public_eventscrap_range_v1('d4', 'd5');
SELECT private.backfill_public_eventscrap_range_v1('d5', 'd6');
SELECT private.backfill_public_eventscrap_range_v1('d6', 'd7');
SELECT private.backfill_public_eventscrap_range_v1('d7', 'd8');
SELECT private.backfill_public_eventscrap_range_v1('d8', 'd9');
SELECT private.backfill_public_eventscrap_range_v1('d9', 'da');
SELECT private.backfill_public_eventscrap_range_v1('da', 'db');
SELECT private.backfill_public_eventscrap_range_v1('db', 'dc');
SELECT private.backfill_public_eventscrap_range_v1('dc', 'dd');
SELECT private.backfill_public_eventscrap_range_v1('dd', 'de');
SELECT private.backfill_public_eventscrap_range_v1('de', 'df');
SELECT private.backfill_public_eventscrap_range_v1('df', 'e0');
SELECT private.backfill_public_eventscrap_range_v1('e0', 'e1');
SELECT private.backfill_public_eventscrap_range_v1('e1', 'e2');
SELECT private.backfill_public_eventscrap_range_v1('e2', 'e3');
SELECT private.backfill_public_eventscrap_range_v1('e3', 'e4');
SELECT private.backfill_public_eventscrap_range_v1('e4', 'e5');
SELECT private.backfill_public_eventscrap_range_v1('e5', 'e6');
SELECT private.backfill_public_eventscrap_range_v1('e6', 'e7');
SELECT private.backfill_public_eventscrap_range_v1('e7', 'e8');
SELECT private.backfill_public_eventscrap_range_v1('e8', 'e9');
SELECT private.backfill_public_eventscrap_range_v1('e9', 'ea');
SELECT private.backfill_public_eventscrap_range_v1('ea', 'eb');
SELECT private.backfill_public_eventscrap_range_v1('eb', 'ec');
SELECT private.backfill_public_eventscrap_range_v1('ec', 'ed');
SELECT private.backfill_public_eventscrap_range_v1('ed', 'ee');
SELECT private.backfill_public_eventscrap_range_v1('ee', 'ef');
SELECT private.backfill_public_eventscrap_range_v1('ef', 'f0');
SELECT private.backfill_public_eventscrap_range_v1('f0', 'f1');
SELECT private.backfill_public_eventscrap_range_v1('f1', 'f2');
SELECT private.backfill_public_eventscrap_range_v1('f2', 'f3');
SELECT private.backfill_public_eventscrap_range_v1('f3', 'f4');
SELECT private.backfill_public_eventscrap_range_v1('f4', 'f5');
SELECT private.backfill_public_eventscrap_range_v1('f5', 'f6');
SELECT private.backfill_public_eventscrap_range_v1('f6', 'f7');
SELECT private.backfill_public_eventscrap_range_v1('f7', 'f8');
SELECT private.backfill_public_eventscrap_range_v1('f8', 'f9');
SELECT private.backfill_public_eventscrap_range_v1('f9', 'fa');
SELECT private.backfill_public_eventscrap_range_v1('fa', 'fb');
SELECT private.backfill_public_eventscrap_range_v1('fb', 'fc');
SELECT private.backfill_public_eventscrap_range_v1('fc', 'fd');
SELECT private.backfill_public_eventscrap_range_v1('fd', 'fe');
SELECT private.backfill_public_eventscrap_range_v1('fe', 'ff');
SELECT private.backfill_public_eventscrap_range_v1('ff', 'fg');

-- Process any future staging identifiers that do not start with two lower-case
-- hexadecimal characters. The current worldwide import has none.
SELECT private.backfill_public_eventscrap_remaining_v1();

DO $verify_eventscrap_backfill$
DECLARE
  staging_table REGCLASS := to_regclass('public.eventscrap');
  matched_rows BIGINT := 0;
  projected_rows BIGINT := 0;
  unmatched_rows BIGINT := 0;
BEGIN
  IF staging_table IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $query$
    SELECT
      count(event.id),
      count(detail.event_id),
      count(*) FILTER (WHERE event.id IS NULL)
    FROM public.eventscrap AS stage
    LEFT JOIN public.events AS event
      ON event.canonical_fingerprint =
        private.public_eventscrap_fingerprint_fields_v1(
          stage.event_id::TEXT,
          stage.source::TEXT,
          stage.source_event_id::TEXT,
          stage.source_url::TEXT,
          stage.event_name::TEXT,
          stage.start_datetime::TEXT
        )
    LEFT JOIN public.event_scraped_details AS detail
      ON detail.event_id = event.id
  $query$
  INTO matched_rows, projected_rows, unmatched_rows;

  IF unmatched_rows <> 0 THEN
    RAISE EXCEPTION
      'eventscrap backfill left % staging rows without an event match',
      unmatched_rows;
  END IF;

  IF projected_rows <> matched_rows THEN
    RAISE EXCEPTION
      'eventscrap backfill projected % of % matched rows',
      projected_rows,
      matched_rows;
  END IF;

  RAISE NOTICE
    'eventscrap backfill verified: % matched rows, % public projections',
    matched_rows,
    projected_rows;
END;
$verify_eventscrap_backfill$;

DROP FUNCTION private.backfill_public_eventscrap_range_v1(TEXT, TEXT);
DROP FUNCTION private.backfill_public_eventscrap_remaining_v1();

ANALYZE public.event_scraped_details;
NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
RESET statement_timeout;
