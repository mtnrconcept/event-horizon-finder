-- Repair country rows produced when long country names were truncated to their
-- first two letters (for example United States -> UN and South Africa -> SO).
-- Only derived sources created by the July worldwide expansion are eligible,
-- and only when the derived city name is identical to its parent source city.

DO $$
DECLARE
  mismatch RECORD;
  affected_event_ids UUID[];
  repaired_currency TEXT;
BEGIN
  FOR mismatch IN
    SELECT
      child.id AS child_source_id,
      child.city_id AS wrong_city_id,
      parent.id AS parent_source_id,
      parent.city_id AS target_city_id,
      parent_country.id AS target_country_id,
      parent_country.code AS target_country_code
    FROM public.data_sources AS child
    JOIN public.data_sources AS parent
      ON child.metadata->>'parent_source_id' = parent.id::TEXT
    JOIN public.cities AS child_city ON child_city.id = child.city_id
    JOIN public.countries AS child_country ON child_country.id = child_city.country_id
    JOIN public.cities AS parent_city ON parent_city.id = parent.city_id
    JOIN public.countries AS parent_country ON parent_country.id = parent_city.country_id
    WHERE child.metadata->>'scope' = 'world-expansion-2026-07'
      AND child.metadata->>'derived_city_source' = 'true'
      AND child_country.code IS DISTINCT FROM parent_country.code
      AND public.unaccent(lower(child_city.name)) = public.unaccent(lower(parent_city.name))
      AND child.created_at >= '2026-07-17T00:00:00Z'::TIMESTAMPTZ
  LOOP
    SELECT coalesce(array_agg((record.extracted_data->>'event_id')::UUID), ARRAY[]::UUID[])
    INTO affected_event_ids
    FROM public.source_records AS record
    WHERE record.data_source_id = mismatch.child_source_id
      AND coalesce(record.extracted_data->>'event_id', '') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    repaired_currency := CASE mismatch.target_country_code
      WHEN 'US' THEN 'USD'
      WHEN 'ZA' THEN 'ZAR'
      WHEN 'AE' THEN 'AED'
      WHEN 'CH' THEN 'CHF'
      WHEN 'GB' THEN 'GBP'
      WHEN 'CA' THEN 'CAD'
      WHEN 'AU' THEN 'AUD'
      WHEN 'NZ' THEN 'NZD'
      WHEN 'JP' THEN 'JPY'
      WHEN 'MX' THEN 'MXN'
      WHEN 'KR' THEN 'KRW'
      WHEN 'SG' THEN 'SGD'
      ELSE 'EUR'
    END;

    UPDATE public.venues
    SET city_id = mismatch.target_city_id,
        country_id = mismatch.target_country_id
    WHERE city_id = mismatch.wrong_city_id;

    UPDATE public.events
    SET city_id = mismatch.target_city_id,
        canonical_fingerprint = NULL
    WHERE city_id = mismatch.wrong_city_id
       OR id = ANY(affected_event_ids);

    UPDATE public.ticket_offers
    SET currency = repaired_currency
    WHERE event_id = ANY(affected_event_ids)
      AND coalesce(currency, 'EUR') = 'EUR';

    UPDATE public.source_records
    SET data_source_id = mismatch.parent_source_id,
        extracted_data = jsonb_set(
          jsonb_set(
            coalesce(extracted_data, '{}'::JSONB),
            '{normalized_payload,country_code}',
            to_jsonb(mismatch.target_country_code),
            true
          ),
          '{normalized_payload,currency}',
          to_jsonb(repaired_currency),
          true
        )
    WHERE data_source_id = mismatch.child_source_id;

    DELETE FROM public.data_sources WHERE id = mismatch.child_source_id;
    DELETE FROM public.cities WHERE id = mismatch.wrong_city_id;
  END LOOP;
END
$$;

-- The first successful US city crawls exposed eight legitimate nearby cities
-- without coordinates. Store municipal centroids so their events remain
-- visible as explicitly approximate pins until venue-level coordinates arrive.
UPDATE public.cities AS city
SET latitude = centroid.latitude,
    longitude = centroid.longitude,
    location = public.st_setsrid(
      public.st_makepoint(centroid.longitude, centroid.latitude),
      4326
    )::public.geography
FROM public.data_sources AS child
JOIN public.data_sources AS parent
  ON child.metadata->>'parent_source_id' = parent.id::TEXT
JOIN (VALUES
  ('chicago-us', 'Brookfield, IL', 41.8239::DOUBLE PRECISION, -87.8517::DOUBLE PRECISION),
  ('chicago-us', 'Evanston', 42.0451::DOUBLE PRECISION, -87.6877::DOUBLE PRECISION),
  ('los-angeles-us', 'Burbank', 34.1808::DOUBLE PRECISION, -118.3090::DOUBLE PRECISION),
  ('los-angeles-us', 'Long Beach', 33.7701::DOUBLE PRECISION, -118.1937::DOUBLE PRECISION),
  ('los-angeles-us', 'Mount Wilson', 34.2256::DOUBLE PRECISION, -118.0575::DOUBLE PRECISION),
  ('los-angeles-us', 'Santa Monica', 34.0195::DOUBLE PRECISION, -118.4912::DOUBLE PRECISION),
  ('los-angeles-us', 'Torrance', 33.8358::DOUBLE PRECISION, -118.3406::DOUBLE PRECISION),
  ('los-angeles-us', 'West Hollywood', 34.0900::DOUBLE PRECISION, -118.3617::DOUBLE PRECISION)
) AS centroid(registry_key, city_name, latitude, longitude)
  ON centroid.registry_key = parent.metadata->>'registry_key'
WHERE child.city_id = city.id
  AND child.metadata->>'scope' = 'world-expansion-2026-07'
  AND child.metadata->>'derived_city_source' = 'true'
  AND public.unaccent(lower(city.name)) = public.unaccent(lower(centroid.city_name))
  AND (city.latitude IS NULL OR city.longitude IS NULL);

-- Every event needs a stable visual taxonomy. The precision normalizer now
-- emits `other`; this database fallback also covers direct RPC collectors and
-- older payloads that omit a category altogether.
CREATE OR REPLACE FUNCTION public.ensure_ingested_event_category_fallback_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_id_text TEXT := NEW.extracted_data->>'event_id';
  other_category_id UUID;
BEGIN
  IF event_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NEW.extracted_data->'normalized_payload' IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT category.id
  INTO other_category_id
  FROM public.event_categories AS category
  WHERE category.slug = 'other';

  UPDATE public.events
  SET category_id = other_category_id
  WHERE id = event_id_text::UUID
    AND category_id IS NULL
    AND other_category_id IS NOT NULL;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ensure_ingested_event_category_fallback_v1()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_zz_ingested_event_category_fallback_v1 ON public.source_records;
CREATE TRIGGER trg_zz_ingested_event_category_fallback_v1
AFTER INSERT OR UPDATE OF extracted_data ON public.source_records
FOR EACH ROW
EXECUTE FUNCTION public.ensure_ingested_event_category_fallback_v1();

UPDATE public.events AS event
SET category_id = category.id
FROM public.event_categories AS category
WHERE category.slug = 'other'
  AND event.category_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.source_records AS record
    JOIN public.data_sources AS source ON source.id = record.data_source_id
    WHERE record.extracted_data->>'event_id' = event.id::TEXT
      AND source.metadata->>'scope' = 'world-expansion-2026-07'
  );

-- Requests killed by the platform cannot finalize their ingestion job. These
-- rows are older than the maximum Edge lifetime and are safe to close.
UPDATE public.ingestion_jobs
SET status = 'failed',
    finished_at = coalesce(finished_at, now()),
    error_message = coalesce(error_message, 'edge_runtime_timeout')
WHERE status = 'running'
  AND started_at < now() - interval '3 minutes';
