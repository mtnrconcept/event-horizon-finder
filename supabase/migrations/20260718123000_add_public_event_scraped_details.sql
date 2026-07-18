-- Preserve a deliberately whitelisted, visitor-facing subset of rich scraper
-- data. Raw payloads, processing errors, quality warnings and dedupe metadata
-- remain confined to the ingestion tables.

CREATE TABLE IF NOT EXISTS public.event_scraped_details (
  event_id UUID PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_scraped_details_object_check
    CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT event_scraped_details_size_check
    CHECK (pg_column_size(details) <= 524288)
);

COMMENT ON TABLE public.event_scraped_details IS
  'Public, visitor-facing subset of rich scraper data. Internal ingestion metadata remains private.';

REVOKE ALL ON TABLE public.event_scraped_details FROM PUBLIC;
GRANT SELECT ON public.event_scraped_details TO anon, authenticated;
GRANT ALL ON public.event_scraped_details TO service_role;

ALTER TABLE public.event_scraped_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_scraped_details_public_read"
  ON public.event_scraped_details;
CREATE POLICY "event_scraped_details_public_read"
ON public.event_scraped_details
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.id = event_scraped_details.event_id
      AND NOT event.is_demo
      AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
  )
);

-- Supports newest-record lookup and the one-time source_records backfill. It is
-- created in the DDL-only migration so its lock is released before backfills.
CREATE INDEX IF NOT EXISTS source_records_event_id_idx
  ON public.source_records (
    (extracted_data->>'event_id'),
    (coalesce(
      processed_at,
      fetched_at,
      '1970-01-01 00:00:00+00'::TIMESTAMPTZ
    )) DESC,
    processed_at DESC NULLS LAST,
    fetched_at DESC NULLS LAST
  )
  WHERE extracted_data->>'event_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION private.clean_public_event_text(
  _value TEXT,
  _maximum_length INTEGER DEFAULT 4000
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(_maximum_length, 0) <= 0 THEN NULL
    WHEN lower(btrim(coalesce(_value, ''))) IN (
      '', 'nan', 'none', 'null', 'undefined', 'unknown', 'n/a', 'na',
      'non renseigné', 'not provided', 'not available'
    ) THEN NULL
    ELSE left(btrim(_value), least(_maximum_length, 20000))
  END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_url(_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH cleaned AS (
    SELECT private.clean_public_event_text(_value, 2000) AS value
  )
  SELECT CASE
    WHEN value ~* '^https?://[^[:space:]]+$'
      AND length(value) <= 2000
      AND coalesce(substring(value FROM '^https?://([^/?#]+)'), '') <> ''
      AND strpos(coalesce(substring(value FROM '^https?://([^/?#]+)'), ''), '@') = 0
    THEN value
    ELSE NULL
  END
  FROM cleaned;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_email(_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH cleaned AS (
    SELECT private.clean_public_event_text(_value, 320) AS value
  )
  SELECT CASE
    WHEN value ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN value
    ELSE NULL
  END
  FROM cleaned;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_phone(_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH cleaned AS (
    SELECT private.clean_public_event_text(_value, 64) AS value
  )
  SELECT CASE
    WHEN value ~ '^[+0-9(). /-]{3,64}$' THEN value
    ELSE NULL
  END
  FROM cleaned;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_boolean(_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE lower(btrim(coalesce(_value, '')))
    WHEN 'true' THEN true
    WHEN 't' THEN true
    WHEN '1' THEN true
    WHEN 'yes' THEN true
    WHEN 'oui' THEN true
    WHEN 'false' THEN false
    WHEN 'f' THEN false
    WHEN '0' THEN false
    WHEN 'no' THEN false
    WHEN 'non' THEN false
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_integer(
  _value TEXT,
  _minimum INTEGER DEFAULT 0,
  _maximum INTEGER DEFAULT 999999999
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN coalesce(_minimum, 1) > coalesce(_maximum, 0) THEN NULL
    WHEN btrim(coalesce(_value, '')) ~ '^[0-9]{1,9}$'
      AND btrim(_value)::BIGINT BETWEEN _minimum AND _maximum
    THEN btrim(_value)::INTEGER
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_numeric(
  _value TEXT,
  _minimum NUMERIC,
  _maximum NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN _minimum > _maximum THEN NULL
    WHEN btrim(coalesce(_value, '')) ~ '^[+-]?[0-9]{1,12}([.][0-9]{1,8})?$'
      AND btrim(_value)::NUMERIC BETWEEN _minimum AND _maximum
    THEN btrim(_value)::NUMERIC
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_timestamp(_value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  cleaned TEXT := private.clean_public_event_text(_value, 96);
  parsed TIMESTAMPTZ;
BEGIN
  IF cleaned IS NULL
    OR cleaned !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([zZ]|[+-][0-9]{2}:?[0-9]{2})?)?$'
  THEN
    RETURN NULL;
  END IF;

  BEGIN
    parsed := cleaned::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF parsed < '1900-01-01 00:00:00+00'::TIMESTAMPTZ
    OR parsed >= '2200-01-01 00:00:00+00'::TIMESTAMPTZ
  THEN
    RETURN NULL;
  END IF;
  RETURN parsed;
END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_timestamp_text(_value TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN private.clean_public_event_timestamp(_value) IS NOT NULL
    THEN private.clean_public_event_text(_value, 96)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION private.clean_public_event_json(
  _value JSONB,
  _maximum_bytes INTEGER DEFAULT 65536,
  _maximum_items INTEGER DEFAULT 200
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  candidate JSONB := _value;
  cleaned TEXT;
  value_type TEXT;
  item_count INTEGER;
BEGIN
  IF candidate IS NULL OR candidate = 'null'::JSONB
    OR coalesce(_maximum_bytes, 0) <= 0
    OR coalesce(_maximum_items, 0) <= 0
    OR pg_column_size(candidate) > least(_maximum_bytes, 262144)
  THEN
    RETURN NULL;
  END IF;

  value_type := jsonb_typeof(candidate);
  IF value_type = 'string' THEN
    cleaned := private.clean_public_event_text(candidate #>> '{}', 20000);
    IF cleaned IS NULL THEN
      RETURN NULL;
    END IF;
    BEGIN
      candidate := cleaned::JSONB;
    EXCEPTION WHEN others THEN
      candidate := to_jsonb(cleaned);
    END;
    value_type := jsonb_typeof(candidate);
  END IF;

  IF pg_column_size(candidate) > least(_maximum_bytes, 262144) THEN
    RETURN NULL;
  ELSIF value_type = 'array' THEN
    IF jsonb_array_length(candidate) > least(_maximum_items, 1000) THEN
      RETURN NULL;
    END IF;
  ELSIF value_type = 'object' THEN
    SELECT count(*) INTO item_count FROM jsonb_object_keys(candidate);
    IF item_count > least(_maximum_items, 1000)
      OR EXISTS (
        SELECT 1
        FROM jsonb_object_keys(candidate) AS keys(key_name)
        WHERE lower(key_name) IN (
          'raw_json', 'raw_markdown', 'processing_error', 'error_message',
          'dedupe_key', 'data_warnings', 'quality_warnings'
        )
      )
    THEN
      RETURN NULL;
    END IF;
  ELSIF value_type NOT IN ('boolean', 'number', 'string') THEN
    RETURN NULL;
  END IF;

  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION private.public_event_scraped_details_v1(
  _payload JSONB,
  _source_url TEXT DEFAULT NULL,
  _source_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'source', coalesce(
        private.clean_public_event_text(_payload->>'source', 256),
        private.clean_public_event_text(_source_name, 256)
      ),
      'source_event_id', coalesce(
        private.clean_public_event_text(_payload->>'source_event_id', 512),
        private.clean_public_event_text(_payload->>'external_identifier', 512)
      ),
      'source_url', coalesce(
        private.clean_public_event_url(_payload->>'source_url'),
        private.clean_public_event_url(_source_url)
      ),
      'source_dataset_url', private.clean_public_event_url(_payload->>'source_dataset_url'),
      'source_license', coalesce(
        private.clean_public_event_text(_payload->>'source_license', 512),
        private.clean_public_event_text(_payload->>'license', 512)
      ),
      'source_license_url', private.clean_public_event_url(_payload->>'source_license_url'),
      'scraped_at_utc', private.clean_public_event_timestamp_text(_payload->>'scraped_at_utc'),
      'last_source_update', private.clean_public_event_timestamp_text(_payload->>'last_source_update'),
      'event_name_raw', private.clean_public_event_text(_payload->>'event_name', 1000),
      'event_type', private.clean_public_event_text(_payload->>'event_type', 256),
      'event_subtype', private.clean_public_event_text(_payload->>'event_subtype', 256),
      'category_original', private.clean_public_event_text(_payload->>'category_original', 512),
      'music_style', private.clean_public_event_text(_payload->>'music_style', 2000),
      'animation_or_program', private.clean_public_event_text(_payload->>'animation_or_program', 8000),
      'keywords', private.clean_public_event_json(_payload->'keywords', 32768, 200)
    )
    || jsonb_build_object(
      'description_short_raw', private.clean_public_event_text(_payload->>'description_short', 4000),
      'description_full_raw', private.clean_public_event_text(_payload->>'description_full', 20000),
      'start_datetime_raw', private.clean_public_event_timestamp_text(_payload->>'start_datetime'),
      'end_datetime_raw', private.clean_public_event_timestamp_text(_payload->>'end_datetime'),
      'last_occurrence_start', private.clean_public_event_timestamp_text(_payload->>'last_occurrence_start'),
      'last_occurrence_end', private.clean_public_event_timestamp_text(_payload->>'last_occurrence_end'),
      'timezone_raw', private.clean_public_event_text(_payload->>'timezone', 128),
      'all_day_raw', private.clean_public_event_boolean(_payload->>'all_day'),
      'status_raw', private.clean_public_event_text(_payload->>'status', 64),
      'date_precision', coalesce(
        private.clean_public_event_text(_payload->>'date_precision', 128),
        private.clean_public_event_text(_payload->>'time_precision', 128)
      ),
      'schedule_text', private.clean_public_event_text(_payload->>'schedule_text', 8000),
      'schedule_json', private.clean_public_event_json(_payload->'schedule_json', 65536, 200),
      'occurrence_count_in_window', private.clean_public_event_integer(
        _payload->>'occurrence_count_in_window', 0, 1000000
      ),
      'online_event', private.clean_public_event_boolean(_payload->>'online_event')
    )
    || jsonb_build_object(
      'ticket_or_registration_url', coalesce(
        private.clean_public_event_url(_payload->>'ticket_or_registration_url'),
        private.clean_public_event_url(_payload->>'ticket_url')
      ),
      'registration_conditions', private.clean_public_event_text(_payload->>'registration_conditions', 8000),
      'booking_required', private.clean_public_event_boolean(_payload->>'booking_required'),
      'price_min_raw', private.clean_public_event_numeric(_payload->>'price_min', 0, 999999999),
      'price_max_raw', private.clean_public_event_numeric(_payload->>'price_max', 0, 999999999),
      'currency_raw', upper(private.clean_public_event_text(_payload->>'currency', 8)),
      'price_text', private.clean_public_event_text(_payload->>'price_text', 2000),
      'is_free_raw', private.clean_public_event_boolean(_payload->>'is_free'),
      'organizer_raw', private.clean_public_event_text(_payload->>'organizer', 1000),
      'organizer_contact', private.clean_public_event_text(_payload->>'organizer_contact', 4000),
      'organizer_url', private.clean_public_event_url(_payload->>'organizer_url'),
      'contact_phone', coalesce(
        private.clean_public_event_phone(_payload->>'contact_phone'),
        private.clean_public_event_phone(_payload->>'phone')
      ),
      'contact_email', coalesce(
        private.clean_public_event_email(_payload->>'contact_email'),
        private.clean_public_event_email(_payload->>'email')
      ),
      'venue_website', coalesce(
        private.clean_public_event_url(_payload->>'venue_website'),
        private.clean_public_event_url(_payload->>'venue_url')
      ),
      'external_links', private.clean_public_event_json(_payload->'external_links', 65536, 200),
      'image_url_raw', private.clean_public_event_url(_payload->>'image_url'),
      'image_credit', coalesce(
        private.clean_public_event_text(_payload->>'image_credit', 2000),
        private.clean_public_event_text(_payload->>'image_attribution', 2000)
      ),
      'video_url', private.clean_public_event_url(_payload->>'video_url')
    )
    || jsonb_build_object(
      'venue_name_raw', private.clean_public_event_text(_payload->>'venue_name', 1000),
      'venue_address', coalesce(
        private.clean_public_event_text(_payload->>'venue_address', 2000),
        private.clean_public_event_text(_payload->>'address', 2000)
      ),
      'street', private.clean_public_event_text(_payload->>'street', 1000),
      'postal_code_raw', private.clean_public_event_text(_payload->>'postal_code', 64),
      'city_raw', private.clean_public_event_text(_payload->>'city', 512),
      'region_raw', private.clean_public_event_text(_payload->>'region', 512),
      'country_code_raw', upper(private.clean_public_event_text(_payload->>'country_code', 3)),
      'country_raw', private.clean_public_event_text(_payload->>'country', 512),
      'latitude_raw', private.clean_public_event_numeric(_payload->>'latitude', -90, 90),
      'longitude_raw', private.clean_public_event_numeric(_payload->>'longitude', -180, 180),
      'audience', private.clean_public_event_text(_payload->>'audience', 2000),
      'age_min', private.clean_public_event_integer(_payload->>'age_min', 0, 130),
      'age_max', private.clean_public_event_integer(_payload->>'age_max', 0, 130),
      'accessibility_raw', private.clean_public_event_json(_payload->'accessibility', 65536, 200),
      'capacity_raw', private.clean_public_event_integer(_payload->>'capacity', 0, 10000000)
    )
    || jsonb_build_object(
      'performers_raw', private.clean_public_event_json(_payload->'performers', 65536, 200),
      'series_name', private.clean_public_event_text(_payload->>'series_name', 1000),
      'requirements', private.clean_public_event_text(_payload->>'requirements', 8000),
      'indoor', private.clean_public_event_boolean(_payload->>'indoor'),
      'pets_allowed', private.clean_public_event_boolean(_payload->>'pets_allowed'),
      'merged_sources', coalesce(
        private.clean_public_event_json(_payload->'merged_sources_json', 65536, 200),
        private.clean_public_event_json(_payload->'merged_sources', 65536, 200)
      ),
      'language_raw', private.clean_public_event_text(_payload->>'language', 128)
    )
  );
$$;

-- Merge older payloads only as gap-fillers; overlapping keys from the freshest
-- payload always win. This permits enrichment without stale-value regression.
CREATE OR REPLACE FUNCTION private.store_public_event_scraped_details_v1(
  _event_id UUID,
  _details JSONB,
  _source_updated_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_updated_at TIMESTAMPTZ := coalesce(
    _source_updated_at,
    '1970-01-01 00:00:00+00'::TIMESTAMPTZ
  );
BEGIN
  IF _event_id IS NULL
    OR jsonb_typeof(_details) IS DISTINCT FROM 'object'
    OR _details = '{}'::JSONB
    OR pg_column_size(_details) > 524288
    OR NOT EXISTS (SELECT 1 FROM public.events AS event WHERE event.id = _event_id)
  THEN
    RETURN;
  END IF;

  INSERT INTO public.event_scraped_details(event_id, details, updated_at)
  VALUES (_event_id, _details, normalized_updated_at)
  ON CONFLICT (event_id) DO UPDATE SET
    details = CASE
      WHEN EXCLUDED.updated_at >= public.event_scraped_details.updated_at
        THEN public.event_scraped_details.details || EXCLUDED.details
      ELSE EXCLUDED.details || public.event_scraped_details.details
    END,
    updated_at = greatest(public.event_scraped_details.updated_at, EXCLUDED.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION private.public_eventscrap_fingerprint_fields_v1(
  _event_id TEXT,
  _source TEXT,
  _source_event_id TEXT,
  _source_url TEXT,
  _event_name TEXT,
  _start_datetime TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(
    nullif(btrim(_event_id), ''),
    nullif(btrim(_source), '') || ':' || nullif(btrim(_source_event_id), ''),
    md5(
      coalesce(btrim(_source_url), '') || '|' ||
      coalesce(btrim(_event_name), '') || '|' ||
      coalesce(btrim(_start_datetime), '')
    )
  );
$$;

CREATE OR REPLACE FUNCTION private.public_eventscrap_fingerprint_v1(_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT private.public_eventscrap_fingerprint_fields_v1(
    _payload->>'event_id',
    _payload->>'source',
    _payload->>'source_event_id',
    _payload->>'source_url',
    _payload->>'event_name',
    _payload->>'start_datetime'
  );
$$;

CREATE OR REPLACE FUNCTION private.public_event_payload_freshness_v1(_payload JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  scraped_at TIMESTAMPTZ :=
    private.clean_public_event_timestamp(_payload->>'scraped_at_utc');
  source_updated_at TIMESTAMPTZ :=
    private.clean_public_event_timestamp(_payload->>'last_source_update');
BEGIN
  IF scraped_at IS NOT NULL AND scraped_at <= now() + interval '7 days' THEN
    RETURN scraped_at;
  ELSIF source_updated_at IS NOT NULL
    AND source_updated_at <= now() + interval '7 days'
  THEN
    RETURN source_updated_at;
  END IF;
  RETURN '1970-01-01 00:00:00+00'::TIMESTAMPTZ;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_public_event_scraped_details_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_id_text TEXT := NEW.extracted_data->>'event_id';
  payload JSONB := NEW.extracted_data->'normalized_payload';
  source_name TEXT;
  public_details JSONB;
BEGIN
  IF event_id_text IS NULL
    OR event_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
  THEN
    RETURN NEW;
  END IF;

  SELECT source.name
    INTO source_name
  FROM public.data_sources AS source
  WHERE source.id = NEW.data_source_id;

  public_details := private.public_event_scraped_details_v1(
    payload,
    NEW.source_url,
    source_name
  );
  PERFORM private.store_public_event_scraped_details_v1(
    event_id_text::UUID,
    public_details,
    coalesce(NEW.processed_at, NEW.fetched_at)
  );
  RETURN NEW;
END;
$$;

-- Best-effort synchronization for the optional worldwide staging table. The
-- source-row trigger handles edits after an event exists; the event trigger
-- handles the normal staging-first import path for rows with an event_id.
CREATE OR REPLACE FUNCTION private.sync_public_eventscrap_row_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payload JSONB := to_jsonb(NEW);
  matched_event_id UUID;
  public_details JSONB;
BEGIN
  SELECT event.id
    INTO matched_event_id
  FROM public.events AS event
  WHERE event.canonical_fingerprint = private.public_eventscrap_fingerprint_v1(payload)
  LIMIT 1;

  IF matched_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  public_details := private.public_event_scraped_details_v1(
    payload,
    payload->>'source_url',
    payload->>'source'
  );
  PERFORM private.store_public_event_scraped_details_v1(
    matched_event_id,
    public_details,
    private.public_event_payload_freshness_v1(payload)
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_public_event_from_eventscrap_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payload JSONB;
  public_details JSONB;
BEGIN
  IF NEW.canonical_fingerprint IS NULL
    OR to_regclass('public.eventscrap') IS NULL
  THEN
    RETURN NEW;
  END IF;

  EXECUTE $query$
    SELECT to_jsonb(stage)
    FROM public.eventscrap AS stage
    WHERE private.public_eventscrap_fingerprint_fields_v1(
      stage.event_id::TEXT,
      stage.source::TEXT,
      stage.source_event_id::TEXT,
      stage.source_url::TEXT,
      stage.event_name::TEXT,
      stage.start_datetime::TEXT
    ) = $1
    ORDER BY
      private.public_event_payload_freshness_v1(to_jsonb(stage)) DESC,
      md5(to_jsonb(stage)::TEXT) DESC
    LIMIT 1
  $query$
  INTO payload
  USING NEW.canonical_fingerprint;

  IF payload IS NULL THEN
    RETURN NEW;
  END IF;

  public_details := private.public_event_scraped_details_v1(
    payload,
    payload->>'source_url',
    payload->>'source'
  );
  PERFORM private.store_public_event_scraped_details_v1(
    NEW.id,
    public_details,
    private.public_event_payload_freshness_v1(payload)
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.clean_public_event_text(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_url(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_email(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_phone(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_boolean(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_integer(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_numeric(TEXT, NUMERIC, NUMERIC)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_timestamp(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_timestamp_text(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clean_public_event_json(JSONB, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_event_scraped_details_v1(JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.store_public_event_scraped_details_v1(UUID, JSONB, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_eventscrap_fingerprint_fields_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_eventscrap_fingerprint_v1(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_event_payload_freshness_v1(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sync_public_event_scraped_details_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sync_public_eventscrap_row_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sync_public_event_from_eventscrap_v1()
  FROM PUBLIC, anon, authenticated;

-- Index maintenance may evaluate this immutable expression as service_role.
GRANT EXECUTE ON FUNCTION private.public_eventscrap_fingerprint_fields_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
)
  TO service_role;

DROP TRIGGER IF EXISTS trg_sync_public_event_scraped_details_v1
  ON public.source_records;
CREATE TRIGGER trg_sync_public_event_scraped_details_v1
AFTER INSERT OR UPDATE OF extracted_data, source_url, processed_at, fetched_at, data_source_id
ON public.source_records
FOR EACH ROW
EXECUTE FUNCTION private.sync_public_event_scraped_details_v1();

DO $install_optional_eventscrap_sync$
DECLARE
  staging_table REGCLASS := to_regclass('public.eventscrap');
  required_column_count INTEGER := 0;
BEGIN
  IF staging_table IS NOT NULL THEN
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
  END IF;

  IF required_column_count = 7 THEN
    EXECUTE $index$
      CREATE INDEX IF NOT EXISTS eventscrap_public_fingerprint_idx
      ON public.eventscrap (
        private.public_eventscrap_fingerprint_fields_v1(
          event_id::TEXT,
          source::TEXT,
          source_event_id::TEXT,
          source_url::TEXT,
          event_name::TEXT,
          start_datetime::TEXT
        )
      )
    $index$;

    EXECUTE 'DROP TRIGGER IF EXISTS trg_sync_public_eventscrap_row_v1 ON public.eventscrap';
    EXECUTE $trigger$
      CREATE TRIGGER trg_sync_public_eventscrap_row_v1
      AFTER INSERT OR UPDATE ON public.eventscrap
      FOR EACH ROW
      EXECUTE FUNCTION private.sync_public_eventscrap_row_v1()
    $trigger$;

    DROP TRIGGER IF EXISTS trg_sync_public_event_from_eventscrap_v1
      ON public.events;
    CREATE TRIGGER trg_sync_public_event_from_eventscrap_v1
    AFTER INSERT OR UPDATE OF canonical_fingerprint
    ON public.events
    FOR EACH ROW
    WHEN (NEW.canonical_fingerprint IS NOT NULL)
    EXECUTE FUNCTION private.sync_public_event_from_eventscrap_v1();
  END IF;
END;
$install_optional_eventscrap_sync$;
