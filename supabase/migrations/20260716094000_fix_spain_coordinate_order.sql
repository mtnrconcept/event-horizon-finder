-- Correct the Barcelona feed's latitude/longitude inversion without touching
-- Spanish sources that already publish standard latitude/longitude pairs.
-- The catalog trigger is the final safety net for every ingestion path, while
-- the v2 wrapper normalizes before a new city is seeded from scraper data.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.normalize_coordinate_pair(
  _country_code TEXT,
  _latitude DOUBLE PRECISION,
  _longitude DOUBLE PRECISION
)
RETURNS TABLE(
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  was_swapped BOOLEAN,
  is_valid BOOLEAN
)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH flags AS (
    SELECT
      upper(btrim(coalesce(_country_code, ''))) AS country_code,
      _latitude AS latitude,
      _longitude AS longitude,
      _latitude IS NOT NULL
        AND _longitude IS NOT NULL
        AND _latitude BETWEEN -90 AND 90
        AND _longitude BETWEEN -180 AND 180 AS globally_valid,
      _latitude IS NOT NULL
        AND _longitude IS NOT NULL
        AND (
          (_latitude BETWEEN 35 AND 44.5 AND _longitude BETWEEN -10 AND 5)
          OR (_latitude BETWEEN 27 AND 30 AND _longitude BETWEEN -19 AND -13)
        ) AS valid_in_spain,
      _latitude IS NOT NULL
        AND _longitude IS NOT NULL
        AND (
          (_longitude BETWEEN 35 AND 44.5 AND _latitude BETWEEN -10 AND 5)
          OR (_longitude BETWEEN 27 AND 30 AND _latitude BETWEEN -19 AND -13)
        ) AS valid_in_spain_after_swap
  )
  SELECT
    CASE
      WHEN country_code = 'ES' AND valid_in_spain THEN latitude
      WHEN country_code = 'ES' AND valid_in_spain_after_swap THEN longitude
      WHEN country_code <> 'ES' AND globally_valid THEN latitude
    END,
    CASE
      WHEN country_code = 'ES' AND valid_in_spain THEN longitude
      WHEN country_code = 'ES' AND valid_in_spain_after_swap THEN latitude
      WHEN country_code <> 'ES' AND globally_valid THEN longitude
    END,
    country_code = 'ES' AND NOT valid_in_spain AND valid_in_spain_after_swap,
    CASE
      WHEN country_code = 'ES' THEN valid_in_spain OR valid_in_spain_after_swap
      ELSE globally_valid
    END
  FROM flags;
$$;

COMMENT ON FUNCTION private.normalize_coordinate_pair(TEXT, DOUBLE PRECISION, DOUBLE PRECISION) IS
  'Validates an atomic coordinate pair and repairs proven latitude/longitude inversions for Spain, including the Canary Islands.';

CREATE OR REPLACE FUNCTION private.normalize_catalog_coordinate_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_country_code TEXT;
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
  v_was_swapped BOOLEAN;
  v_is_valid BOOLEAN;
  v_postgis_schema TEXT;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'unsupported coordinate trigger schema: %', TG_TABLE_SCHEMA;
  ELSIF TG_TABLE_NAME = 'cities' THEN
    SELECT country.code
      INTO v_country_code
    FROM public.countries AS country
    WHERE country.id = NEW.country_id;
  ELSIF TG_TABLE_NAME = 'venues' THEN
    SELECT country.code
      INTO v_country_code
    FROM public.countries AS country
    WHERE country.id = coalesce(
      (SELECT city.country_id FROM public.cities AS city WHERE city.id = NEW.city_id),
      NEW.country_id
    );
  ELSIF TG_TABLE_NAME = 'event_occurrences' THEN
    -- Match discovery RPC geography: venue city takes precedence over event city.
    SELECT country.code
      INTO v_country_code
    FROM public.events AS event
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    LEFT JOIN public.cities AS city ON city.id = coalesce(venue.city_id, event.city_id)
    LEFT JOIN public.countries AS country
      ON country.id = coalesce(city.country_id, venue.country_id)
    WHERE event.id = NEW.event_id;
  ELSE
    RAISE EXCEPTION 'unsupported coordinate trigger table: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  SELECT normalized.latitude,
         normalized.longitude,
         normalized.was_swapped,
         normalized.is_valid
    INTO v_latitude, v_longitude, v_was_swapped, v_is_valid
  FROM private.normalize_coordinate_pair(v_country_code, NEW.latitude, NEW.longitude) AS normalized;

  NEW.latitude := v_latitude;
  NEW.longitude := v_longitude;

  IF NOT v_is_valid THEN
    -- Keep latitude, longitude and PostGIS location atomic.
    NEW.location := NULL;
  ELSE
    SELECT namespace.nspname
      INTO v_postgis_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'postgis';

    IF v_postgis_schema IS NULL THEN
      RAISE EXCEPTION 'postgis extension is required to normalize catalog coordinates';
    END IF;

    EXECUTE format(
      'SELECT %1$I.st_setsrid(%1$I.st_makepoint($1, $2), 4326)::%1$I.geography',
      v_postgis_schema
    )
    INTO NEW.location
    USING v_longitude, v_latitude;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION private.normalize_catalog_coordinate_order() IS
  'Country-aware coordinate guard for cities, venues and event occurrences. It also keeps the PostGIS point synchronized.';

REVOKE ALL ON FUNCTION private.normalize_coordinate_pair(TEXT, DOUBLE PRECISION, DOUBLE PRECISION)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.normalize_catalog_coordinate_order()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a00_normalize_coordinate_order ON public.cities;
CREATE TRIGGER a00_normalize_coordinate_order
BEFORE INSERT OR UPDATE OF country_id, latitude, longitude
ON public.cities
FOR EACH ROW EXECUTE FUNCTION private.normalize_catalog_coordinate_order();

DROP TRIGGER IF EXISTS a00_normalize_coordinate_order ON public.venues;
CREATE TRIGGER a00_normalize_coordinate_order
BEFORE INSERT OR UPDATE OF city_id, country_id, latitude, longitude
ON public.venues
FOR EACH ROW EXECUTE FUNCTION private.normalize_catalog_coordinate_order();

DROP TRIGGER IF EXISTS a00_normalize_coordinate_order ON public.event_occurrences;
CREATE TRIGGER a00_normalize_coordinate_order
BEFORE INSERT OR UPDATE OF event_id, latitude, longitude
ON public.event_occurrences
FOR EACH ROW EXECUTE FUNCTION private.normalize_catalog_coordinate_order();

-- The staging table is optional in clean preview databases. When it exists,
-- normalize at write time so the legacy batch importer receives a clean pair.
CREATE OR REPLACE FUNCTION private.normalize_eventscrap_coordinate_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_country_code TEXT := upper(btrim(coalesce(NEW.country_code, '')));
  v_source_latitude DOUBLE PRECISION;
  v_source_longitude DOUBLE PRECISION;
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
  v_was_swapped BOOLEAN;
  v_is_valid BOOLEAN;
  v_warning TEXT;
BEGIN
  IF v_country_code = '' AND NEW.source = 'Ajuntament de Barcelona – agenda' THEN
    v_country_code := 'ES';
  END IF;

  IF btrim(coalesce(NEW.latitude, '')) ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$' THEN
    v_source_latitude := btrim(NEW.latitude)::DOUBLE PRECISION;
  END IF;
  IF btrim(coalesce(NEW.longitude, '')) ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$' THEN
    v_source_longitude := btrim(NEW.longitude)::DOUBLE PRECISION;
  END IF;

  SELECT normalized.latitude,
         normalized.longitude,
         normalized.was_swapped,
         normalized.is_valid
    INTO v_latitude, v_longitude, v_was_swapped, v_is_valid
  FROM private.normalize_coordinate_pair(
    v_country_code,
    v_source_latitude,
    v_source_longitude
  ) AS normalized;

  NEW.latitude := CASE WHEN v_is_valid THEN v_latitude::TEXT END;
  NEW.longitude := CASE WHEN v_is_valid THEN v_longitude::TEXT END;

  v_warning := CASE
    WHEN v_was_swapped THEN 'coordinate_order_normalized'
    WHEN NOT v_is_valid AND (v_source_latitude IS NOT NULL OR v_source_longitude IS NOT NULL)
      THEN 'invalid_coordinates_removed'
  END;
  IF v_warning IS NOT NULL
     AND strpos(coalesce(NEW.data_warnings, ''), v_warning) = 0 THEN
    NEW.data_warnings := concat_ws('; ', nullif(btrim(NEW.data_warnings), ''), v_warning);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.normalize_eventscrap_coordinate_order()
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  staging_table REGCLASS := to_regclass('public.eventscrap');
  staging_column_count INTEGER := 0;
BEGIN
  IF staging_table IS NOT NULL THEN
    SELECT count(*)
      INTO staging_column_count
    FROM pg_catalog.pg_attribute
    WHERE attrelid = staging_table
      AND attnum > 0
      AND NOT attisdropped
      AND attname = ANY (ARRAY[
        'source', 'country_code', 'latitude', 'longitude', 'data_warnings'
      ]);
  END IF;

  IF staging_column_count = 5 THEN
    EXECUTE 'DROP TRIGGER IF EXISTS a00_normalize_coordinate_order ON public.eventscrap';
    EXECUTE $trigger$
      CREATE TRIGGER a00_normalize_coordinate_order
      BEFORE INSERT OR UPDATE OF source, country_code, latitude, longitude
      ON public.eventscrap
      FOR EACH ROW EXECUTE FUNCTION private.normalize_eventscrap_coordinate_order()
    $trigger$;
  END IF;
END;
$$;

-- Normalize rich scraper payloads before upsert_ingested_event_v2 seeds a
-- city. Renaming the existing implementation keeps this migration small and
-- preserves its complete organizer/ticket/media behavior behind the wrapper.
DO $$
DECLARE
  core_definition TEXT;
  postgis_schema TEXT;
BEGIN
  IF to_regprocedure('public.upsert_ingested_event_v2(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'upsert_ingested_event_v2(uuid,jsonb) is required';
  END IF;
  IF to_regprocedure('public.upsert_ingested_event_v2_catalog_core(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'upsert_ingested_event_v2_catalog_core(uuid,jsonb) already exists';
  END IF;

  ALTER FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
    RENAME TO upsert_ingested_event_v2_catalog_core;

  -- The live project keeps PostGIS in public while clean preview projects may
  -- keep it in extensions. Repair only the PostGIS references in the preserved
  -- core; pgcrypto's extensions.digest reference must remain unchanged.
  SELECT namespace.nspname
    INTO postgis_schema
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'postgis';

  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.upsert_ingested_event_v2_catalog_core(uuid,jsonb)')
         )
    INTO core_definition;
  core_definition := replace(
    core_definition,
    'extensions.st_setsrid',
    format('%I.st_setsrid', postgis_schema)
  );
  core_definition := replace(
    core_definition,
    'extensions.st_makepoint',
    format('%I.st_makepoint', postgis_schema)
  );
  core_definition := replace(
    core_definition,
    '::extensions.geography',
    format('::%I.geography', postgis_schema)
  );
  EXECUTE core_definition;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_ingested_event_v2(
  _data_source_id UUID,
  _payload JSONB
)
RETURNS TABLE(event_id UUID, action TEXT, score INT, published BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payload JSONB := _payload;
  v_country_code TEXT := upper(nullif(btrim(_payload->>'country_code'), ''));
  v_source_latitude DOUBLE PRECISION;
  v_source_longitude DOUBLE PRECISION;
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
BEGIN
  IF v_country_code IS NULL OR v_country_code !~ '^[A-Z]{2}$' THEN
    SELECT upper(country.code)
      INTO v_country_code
    FROM public.data_sources AS source
    LEFT JOIN public.cities AS city ON city.id = source.city_id
    LEFT JOIN public.countries AS country ON country.id = city.country_id
    WHERE source.id = _data_source_id;
  END IF;

  BEGIN
    v_source_latitude := (_payload->>'latitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_latitude := NULL;
  END;
  BEGIN
    v_source_longitude := (_payload->>'longitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_longitude := NULL;
  END;

  SELECT normalized.latitude, normalized.longitude
    INTO v_latitude, v_longitude
  FROM private.normalize_coordinate_pair(
    v_country_code,
    v_source_latitude,
    v_source_longitude
  ) AS normalized;

  v_payload := jsonb_set(
    jsonb_set(
      v_payload,
      '{latitude}',
      coalesce(to_jsonb(v_latitude), 'null'::JSONB),
      true
    ),
    '{longitude}',
    coalesce(to_jsonb(v_longitude), 'null'::JSONB),
    true
  );

  RETURN QUERY
  SELECT result.event_id, result.action, result.score, result.published
  FROM public.upsert_ingested_event_v2_catalog_core(_data_source_id, v_payload) AS result;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2_catalog_core(UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) IS
  'Normalizes country-aware coordinates before atomically writing a rich scraper payload to the event catalog.';

-- Repair the optional raw staging rows first. The trigger performs the actual
-- source-aware conversion and leaves already-correct OpenAgenda/Wikidata rows
-- unchanged.
DO $$
DECLARE
  staging_table REGCLASS := to_regclass('public.eventscrap');
  staging_column_count INTEGER := 0;
BEGIN
  IF staging_table IS NOT NULL THEN
    SELECT count(*)
      INTO staging_column_count
    FROM pg_catalog.pg_attribute
    WHERE attrelid = staging_table
      AND attnum > 0
      AND NOT attisdropped
      AND attname = ANY (ARRAY[
        'source', 'country_code', 'latitude', 'longitude', 'data_warnings', 'venue_name'
      ]);
  END IF;

  IF staging_column_count = 6 THEN
    EXECUTE $repair$
      UPDATE public.eventscrap
      SET latitude = latitude,
          longitude = longitude
      WHERE source = 'Ajuntament de Barcelona – agenda'
        AND upper(btrim(coalesce(country_code, ''))) = 'ES'
        AND (latitude IS NOT NULL OR longitude IS NOT NULL)
    $repair$;

    EXECUTE $repair$
      UPDATE public.eventscrap
      SET latitude = '41.442414', longitude = '2.232144'
      WHERE source = 'Ajuntament de Barcelona – agenda'
        AND upper(btrim(coalesce(country_code, ''))) = 'ES'
        AND venue_name = 'Palau Olímpic de Badalona'
    $repair$;

    EXECUTE $repair$
      UPDATE public.eventscrap
      SET latitude = '41.347812', longitude = '2.075597'
      WHERE source = 'Ajuntament de Barcelona – agenda'
        AND upper(btrim(coalesce(country_code, ''))) = 'ES'
        AND venue_name = 'RCDE Stadium'
    $repair$;
  END IF;
END;
$$;

-- Re-run every existing Spanish catalog point through the same guard. Updating
-- both coordinate columns intentionally fires this migration's BEFORE trigger.
WITH target AS MATERIALIZED (
  SELECT city.id
  FROM public.cities AS city
  JOIN public.countries AS country ON country.id = city.country_id
  WHERE upper(country.code) = 'ES'
)
UPDATE public.cities AS city
SET latitude = city.latitude,
    longitude = city.longitude
FROM target
WHERE city.id = target.id
  AND (city.latitude IS NOT NULL OR city.longitude IS NOT NULL OR city.location IS NOT NULL);

WITH target AS MATERIALIZED (
  SELECT venue.id
  FROM public.venues AS venue
  LEFT JOIN public.cities AS city ON city.id = venue.city_id
  JOIN public.countries AS country
    ON country.id = coalesce(city.country_id, venue.country_id)
  WHERE upper(country.code) = 'ES'
)
UPDATE public.venues AS venue
SET latitude = venue.latitude,
    longitude = venue.longitude
FROM target
WHERE venue.id = target.id
  AND (venue.latitude IS NOT NULL OR venue.longitude IS NOT NULL OR venue.location IS NOT NULL);

WITH target AS MATERIALIZED (
  SELECT occurrence.id
  FROM public.event_occurrences AS occurrence
  JOIN public.events AS event ON event.id = occurrence.event_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city ON city.id = coalesce(venue.city_id, event.city_id)
  JOIN public.countries AS country
    ON country.id = coalesce(city.country_id, venue.country_id)
  WHERE upper(country.code) = 'ES'
)
UPDATE public.event_occurrences AS occurrence
SET latitude = occurrence.latitude,
    longitude = occurrence.longitude
FROM target
WHERE occurrence.id = target.id
  AND (
    occurrence.latitude IS NOT NULL
    OR occurrence.longitude IS NOT NULL
    OR occurrence.location IS NOT NULL
  );

-- Replace the two rejected placeholder pairs with verified venue positions.
-- City coordinates remain useful fallbacks for events without a precise venue.
UPDATE public.cities AS city
SET latitude = 41.45, longitude = 2.24
FROM public.countries AS country
WHERE country.id = city.country_id
  AND upper(country.code) = 'ES'
  AND city.name = 'Badalona';

UPDATE public.cities AS city
SET latitude = 41.359722, longitude = 2.059722
FROM public.countries AS country
WHERE country.id = city.country_id
  AND upper(country.code) = 'ES'
  AND city.name IN ('Cornella Llobregat', 'Cornellà de Llobregat');

UPDATE public.venues AS venue
SET latitude = 41.442414, longitude = 2.232144
FROM public.cities AS city, public.countries AS country
WHERE city.id = venue.city_id
  AND country.id = city.country_id
  AND upper(country.code) = 'ES'
  AND venue.name = 'Palau Olímpic de Badalona';

UPDATE public.venues AS venue
SET latitude = 41.347812, longitude = 2.075597
FROM public.cities AS city, public.countries AS country
WHERE city.id = venue.city_id
  AND country.id = city.country_id
  AND upper(country.code) = 'ES'
  AND venue.name = 'RCDE Stadium';

-- Migration-level regression tests: Barcelona is swapped, Madrid is kept,
-- Canary coordinates are supported and unrelated placeholder pairs are removed.
DO $$
DECLARE
  normalized RECORD;
  invalid_count BIGINT;
  postgis_schema TEXT;
BEGIN
  SELECT * INTO normalized
  FROM private.normalize_coordinate_pair('ES', 2.1734, 41.3851);
  IF normalized.latitude IS DISTINCT FROM 41.3851
     OR normalized.longitude IS DISTINCT FROM 2.1734
     OR NOT normalized.was_swapped
     OR NOT normalized.is_valid THEN
    RAISE EXCEPTION 'Barcelona coordinate-order regression';
  END IF;

  SELECT * INTO normalized
  FROM private.normalize_coordinate_pair('ES', 40.4168, -3.7038);
  IF normalized.latitude IS DISTINCT FROM 40.4168
     OR normalized.longitude IS DISTINCT FROM -3.7038
     OR normalized.was_swapped
     OR NOT normalized.is_valid THEN
    RAISE EXCEPTION 'Madrid coordinate-order regression';
  END IF;

  SELECT * INTO normalized
  FROM private.normalize_coordinate_pair('ES', -15.4363, 28.1235);
  IF normalized.latitude IS DISTINCT FROM 28.1235
     OR normalized.longitude IS DISTINCT FROM -15.4363
     OR NOT normalized.was_swapped
     OR NOT normalized.is_valid THEN
    RAISE EXCEPTION 'Canary coordinate-order regression';
  END IF;

  SELECT * INTO normalized
  FROM private.normalize_coordinate_pair('ES', -1.4894678, -0.0010943);
  IF normalized.latitude IS NOT NULL
     OR normalized.longitude IS NOT NULL
     OR normalized.is_valid THEN
    RAISE EXCEPTION 'Invalid Spanish coordinate regression';
  END IF;

  SELECT count(*) INTO invalid_count
  FROM public.cities AS city
  JOIN public.countries AS country ON country.id = city.country_id
  WHERE upper(country.code) = 'ES'
    AND (
      (city.latitude IS NULL) <> (city.longitude IS NULL)
      OR (city.latitude IS NULL AND city.location IS NOT NULL)
      OR (
        city.latitude IS NOT NULL
        AND NOT (
          (city.latitude BETWEEN 35 AND 44.5 AND city.longitude BETWEEN -10 AND 5)
          OR (city.latitude BETWEEN 27 AND 30 AND city.longitude BETWEEN -19 AND -13)
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '% invalid Spanish city coordinate rows remain', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM public.venues AS venue
  LEFT JOIN public.cities AS city ON city.id = venue.city_id
  JOIN public.countries AS country
    ON country.id = coalesce(city.country_id, venue.country_id)
  WHERE upper(country.code) = 'ES'
    AND (
      (venue.latitude IS NULL) <> (venue.longitude IS NULL)
      OR (venue.latitude IS NULL AND venue.location IS NOT NULL)
      OR (
        venue.latitude IS NOT NULL
        AND NOT (
          (venue.latitude BETWEEN 35 AND 44.5 AND venue.longitude BETWEEN -10 AND 5)
          OR (venue.latitude BETWEEN 27 AND 30 AND venue.longitude BETWEEN -19 AND -13)
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '% invalid Spanish venue coordinate rows remain', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
  FROM public.event_occurrences AS occurrence
  JOIN public.events AS event ON event.id = occurrence.event_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city ON city.id = coalesce(venue.city_id, event.city_id)
  JOIN public.countries AS country
    ON country.id = coalesce(city.country_id, venue.country_id)
  WHERE upper(country.code) = 'ES'
    AND (
      (occurrence.latitude IS NULL) <> (occurrence.longitude IS NULL)
      OR (occurrence.latitude IS NULL AND occurrence.location IS NOT NULL)
      OR (
        occurrence.latitude IS NOT NULL
        AND NOT (
          (occurrence.latitude BETWEEN 35 AND 44.5 AND occurrence.longitude BETWEEN -10 AND 5)
          OR (occurrence.latitude BETWEEN 27 AND 30 AND occurrence.longitude BETWEEN -19 AND -13)
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '% invalid Spanish occurrence coordinate rows remain', invalid_count;
  END IF;

  SELECT namespace.nspname
    INTO postgis_schema
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'postgis';

  EXECUTE format(
    $location_audit$
      SELECT count(*)
      FROM (
        SELECT city.latitude, city.longitude, city.location
        FROM public.cities AS city
        JOIN public.countries AS country ON country.id = city.country_id
        WHERE upper(country.code) = 'ES'

        UNION ALL

        SELECT venue.latitude, venue.longitude, venue.location
        FROM public.venues AS venue
        LEFT JOIN public.cities AS city ON city.id = venue.city_id
        JOIN public.countries AS country
          ON country.id = coalesce(city.country_id, venue.country_id)
        WHERE upper(country.code) = 'ES'

        UNION ALL

        SELECT occurrence.latitude, occurrence.longitude, occurrence.location
        FROM public.event_occurrences AS occurrence
        JOIN public.events AS event ON event.id = occurrence.event_id
        LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
        LEFT JOIN public.cities AS city ON city.id = coalesce(venue.city_id, event.city_id)
        JOIN public.countries AS country
          ON country.id = coalesce(city.country_id, venue.country_id)
        WHERE upper(country.code) = 'ES'
      ) AS coordinate
      WHERE (coordinate.latitude IS NULL AND coordinate.location IS NOT NULL)
         OR (
           coordinate.latitude IS NOT NULL
           AND (
             coordinate.location IS NULL
             OR abs(%1$I.st_y(coordinate.location::%1$I.geometry) - coordinate.latitude) > 1e-9
             OR abs(%1$I.st_x(coordinate.location::%1$I.geometry) - coordinate.longitude) > 1e-9
           )
         )
    $location_audit$,
    postgis_schema
  ) INTO invalid_count;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '% Spanish PostGIS locations are missing or out of sync', invalid_count;
  END IF;
END;
$$;
