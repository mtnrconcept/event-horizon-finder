-- Backfill the optional worldwide CSV staging table in its own migration. Its
-- source timestamp, never migration execution time, determines merge priority.

DO $backfill_optional_eventscrap$
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
    EXECUTE $backfill$
      WITH candidates AS MATERIALIZED (
        SELECT
          private.public_eventscrap_fingerprint_v1(to_jsonb(stage)) AS fingerprint,
          to_jsonb(stage) AS payload,
          private.public_event_payload_freshness_v1(to_jsonb(stage)) AS source_updated_at
        FROM public.eventscrap AS stage
        WHERE private.clean_public_event_text(stage.event_name::TEXT, 1000) IS NOT NULL
      ), ranked AS MATERIALIZED (
        SELECT
          candidate.*,
          row_number() OVER (
            PARTITION BY candidate.fingerprint
            ORDER BY
              candidate.source_updated_at DESC,
              md5(candidate.payload::TEXT) DESC
          ) AS source_rank
        FROM candidates AS candidate
        WHERE candidate.fingerprint IS NOT NULL
      ), prepared AS MATERIALIZED (
        SELECT
          event.id AS event_id,
          private.public_event_scraped_details_v1(
            ranked.payload,
            ranked.payload->>'source_url',
            ranked.payload->>'source'
          ) AS details,
          ranked.source_updated_at
        FROM ranked
        JOIN public.events AS event ON event.canonical_fingerprint = ranked.fingerprint
        WHERE ranked.source_rank = 1
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
        updated_at = greatest(public.event_scraped_details.updated_at, EXCLUDED.updated_at)
    $backfill$;
  END IF;
END;
$backfill_optional_eventscrap$;
