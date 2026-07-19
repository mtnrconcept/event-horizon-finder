-- Canonicalize a conservatively matched legacy city onto the GeoNames id from
-- the current import. A six-kilometre ceiling plus an ambiguity check prevents
-- the former 50 km fallback from collapsing distinct same-name cities.

CREATE OR REPLACE FUNCTION public.import_global_city_targets(_rows JSONB)
RETURNS TABLE (
  countries_upserted INTEGER,
  cities_upserted INTEGER,
  targets_upserted INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item JSONB;
  country_code_value TEXT;
  country_iso3_value TEXT;
  country_name_value TEXT;
  country_id_value UUID;
  city_id_value UUID;
  city_name_value TEXT;
  city_slug_value TEXT;
  city_slug_base TEXT;
  city_geonames_value BIGINT;
  latitude_value DOUBLE PRECISION;
  longitude_value DOUBLE PRECISION;
  postgis_schema_value TEXT;
  city_location_value public.cities.location%TYPE;
  population_rank_value SMALLINT;
  country_languages_value TEXT[];
  city_search_names_value TEXT[];
  city_search_languages_value TEXT[];
BEGIN
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rows_must_be_an_array' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(_rows) > 2000 THEN
    RAISE EXCEPTION 'batch_too_large' USING ERRCODE = '22023';
  END IF;

  SELECT namespace.nspname
  INTO postgis_schema_value
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'postgis';

  IF postgis_schema_value IS NULL THEN
    RAISE EXCEPTION 'postgis_extension_required' USING ERRCODE = '55000';
  END IF;

  countries_upserted := 0;
  cities_upserted := 0;
  targets_upserted := 0;

  FOR item IN
    SELECT value
    FROM jsonb_array_elements(_rows)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'row_must_be_an_object' USING ERRCODE = '22023';
    END IF;

    country_code_value := upper(btrim(coalesce(item->>'country_code', '')));
    country_iso3_value := upper(nullif(btrim(item->>'country_iso3'), ''));
    country_name_value := left(btrim(coalesce(item->>'country_name', '')), 180);
    city_name_value := left(btrim(coalesce(item->>'city_name', '')), 180);
    city_geonames_value := nullif(item->>'city_geonames_id', '')::BIGINT;
    latitude_value := nullif(item->>'latitude', '')::DOUBLE PRECISION;
    longitude_value := nullif(item->>'longitude', '')::DOUBLE PRECISION;
    population_rank_value := nullif(item->>'country_population_rank', '')::SMALLINT;

    IF country_code_value !~ '^[A-Z]{2}$'
      OR (country_iso3_value IS NOT NULL AND country_iso3_value !~ '^[A-Z]{3}$')
      OR country_name_value = ''
      OR city_name_value = ''
      OR city_geonames_value IS NULL
      OR city_geonames_value <= 0
      OR latitude_value NOT BETWEEN -90 AND 90
      OR longitude_value NOT BETWEEN -180 AND 180
    THEN
      RAISE EXCEPTION 'invalid_geography_row: %', item USING ERRCODE = '22023';
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT %I.st_setsrid(%I.st_makepoint($1, $2), 4326)::%I.geography',
      postgis_schema_value,
      postgis_schema_value,
      postgis_schema_value
    )
    INTO city_location_value
    USING longitude_value, latitude_value;

    country_languages_value := ARRAY(
      SELECT DISTINCT left(lower(btrim(language.value)), 35)
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(item->'country_languages') = 'array'
            THEN item->'country_languages'
          ELSE '[]'::JSONB
        END
      ) AS language(value)
      WHERE btrim(language.value) <> ''
      LIMIT 16
    );

    PERFORM pg_advisory_xact_lock(
      pg_catalog.hashtextextended('global-country|' || country_code_value, 0)
    );

    INSERT INTO public.countries (
      code,
      iso3,
      name,
      geonames_id,
      population,
      area_sq_km,
      languages
    )
    VALUES (
      country_code_value,
      country_iso3_value,
      country_name_value,
      nullif(item->>'country_geonames_id', '')::BIGINT,
      nullif(item->>'country_population', '')::BIGINT,
      nullif(item->>'country_area_sq_km', '')::NUMERIC,
      country_languages_value
    )
    ON CONFLICT (code) DO UPDATE SET
      iso3 = coalesce(EXCLUDED.iso3, public.countries.iso3),
      name = CASE
        WHEN public.countries.name = public.countries.code THEN EXCLUDED.name
        ELSE public.countries.name
      END,
      geonames_id = coalesce(EXCLUDED.geonames_id, public.countries.geonames_id),
      population = coalesce(EXCLUDED.population, public.countries.population),
      area_sq_km = coalesce(EXCLUDED.area_sq_km, public.countries.area_sq_km),
      languages = CASE
        WHEN cardinality(EXCLUDED.languages) > 0 THEN EXCLUDED.languages
        ELSE public.countries.languages
      END
    RETURNING id INTO country_id_value;

    countries_upserted := countries_upserted + 1;

    city_search_names_value := ARRAY(
      SELECT DISTINCT left(btrim(candidate.value), 180)
      FROM (
        SELECT value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(item->'search_names') = 'array'
              THEN item->'search_names'
            ELSE '[]'::JSONB
          END
        )
        UNION ALL SELECT city_name_value
        UNION ALL SELECT nullif(left(btrim(item->>'city_ascii_name'), 180), '')
      ) AS candidate(value)
      WHERE nullif(btrim(candidate.value), '') IS NOT NULL
      LIMIT 32
    );

    city_search_languages_value := ARRAY(
      SELECT DISTINCT left(lower(btrim(candidate.value)), 35)
      FROM (
        SELECT value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(item->'search_languages') = 'array'
              THEN item->'search_languages'
            ELSE '[]'::JSONB
          END
        )
        UNION ALL
        SELECT unnest(country_languages_value)
        UNION ALL SELECT 'en'
      ) AS candidate(value)
      WHERE nullif(btrim(candidate.value), '') IS NOT NULL
      LIMIT 16
    );

    PERFORM pg_advisory_xact_lock(
      pg_catalog.hashtextextended('global-city|' || city_geonames_value::TEXT, 0)
    );

    SELECT city.id
    INTO city_id_value
    FROM public.cities AS city
    WHERE city.geonames_id = city_geonames_value
    LIMIT 1
    FOR UPDATE;

    IF city_id_value IS NULL THEN
      SELECT city.id
      INTO city_id_value
      FROM public.cities AS city
      WHERE city.country_id = country_id_value
        AND public.unaccent(lower(city.name)) = public.unaccent(lower(city_name_value))
        AND city.latitude IS NOT NULL
        AND city.longitude IS NOT NULL
        AND 6371 * 2 * asin(sqrt(least(
          1.0::DOUBLE PRECISION,
          power(sin(radians((city.latitude - latitude_value) / 2)), 2)
          + cos(radians(latitude_value)) * cos(radians(city.latitude))
          * power(sin(radians((city.longitude - longitude_value) / 2)), 2)
        ))) <= 6
        AND NOT EXISTS (
          SELECT 1
          FROM public.cities AS other_city
          WHERE other_city.id <> city.id
            AND other_city.country_id = country_id_value
            AND public.unaccent(lower(other_city.name)) =
              public.unaccent(lower(city_name_value))
            AND other_city.latitude IS NOT NULL
            AND other_city.longitude IS NOT NULL
            AND 6371 * 2 * asin(sqrt(least(
              1.0::DOUBLE PRECISION,
              power(sin(radians((other_city.latitude - latitude_value) / 2)), 2)
              + cos(radians(latitude_value)) * cos(radians(other_city.latitude))
              * power(sin(radians((other_city.longitude - longitude_value) / 2)), 2)
            ))) <= 6
        )
      ORDER BY
        6371 * 2 * asin(sqrt(least(
          1.0::DOUBLE PRECISION,
          power(sin(radians((city.latitude - latitude_value) / 2)), 2)
          + cos(radians(latitude_value)) * cos(radians(city.latitude))
          * power(sin(radians((city.longitude - longitude_value) / 2)), 2)
        ))),
        city.created_at
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF city_id_value IS NULL THEN
      city_slug_base := left(
        trim(both '-' from regexp_replace(
          public.unaccent(lower(
            coalesce(nullif(btrim(item->>'city_slug'), ''), city_name_value || '-' || country_code_value)
          )),
          '[^a-z0-9]+',
          '-',
          'g'
        )),
        100
      );
      city_slug_base := coalesce(nullif(city_slug_base, ''), 'city');
      city_slug_value := city_slug_base;

      IF EXISTS (SELECT 1 FROM public.cities WHERE slug = city_slug_value) THEN
        city_slug_value := left(city_slug_base, 100) || '-' || city_geonames_value::TEXT;
      END IF;

      INSERT INTO public.cities (
        country_id,
        slug,
        name,
        timezone,
        latitude,
        longitude,
        location,
        geonames_id,
        ascii_name,
        population,
        is_capital,
        country_population_rank,
        alternate_names,
        search_names,
        search_languages,
        feature_code
      )
      VALUES (
        country_id_value,
        city_slug_value,
        city_name_value,
        coalesce(nullif(btrim(item->>'timezone'), ''), 'UTC'),
        latitude_value,
        longitude_value,
        city_location_value,
        city_geonames_value,
        nullif(left(btrim(item->>'city_ascii_name'), 180), ''),
        nullif(item->>'city_population', '')::BIGINT,
        coalesce((item->>'is_capital')::BOOLEAN, false),
        population_rank_value,
        ARRAY(
          SELECT DISTINCT left(btrim(name.value), 180)
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(item->'alternate_names') = 'array'
                THEN item->'alternate_names'
              ELSE '[]'::JSONB
            END
          ) AS name(value)
          WHERE btrim(name.value) <> ''
          LIMIT 64
        ),
        city_search_names_value,
        city_search_languages_value,
        nullif(left(upper(btrim(item->>'feature_code')), 16), '')
      )
      RETURNING id INTO city_id_value;
    ELSE
      UPDATE public.cities
      SET
        geonames_id = city_geonames_value,
        ascii_name = coalesce(
          nullif(left(btrim(item->>'city_ascii_name'), 180), ''),
          public.cities.ascii_name
        ),
        timezone = coalesce(nullif(btrim(item->>'timezone'), ''), public.cities.timezone),
        latitude = latitude_value,
        longitude = longitude_value,
        location = city_location_value,
        population = coalesce(
          nullif(item->>'city_population', '')::BIGINT,
          public.cities.population
        ),
        is_capital = public.cities.is_capital OR coalesce((item->>'is_capital')::BOOLEAN, false),
        country_population_rank = coalesce(population_rank_value, public.cities.country_population_rank),
        alternate_names = CASE
          WHEN jsonb_typeof(item->'alternate_names') = 'array' THEN ARRAY(
            SELECT DISTINCT left(btrim(name.value), 180)
            FROM jsonb_array_elements_text(item->'alternate_names') AS name(value)
            WHERE btrim(name.value) <> ''
            LIMIT 64
          )
          ELSE public.cities.alternate_names
        END,
        search_names = city_search_names_value,
        search_languages = city_search_languages_value,
        feature_code = coalesce(
          nullif(left(upper(btrim(item->>'feature_code')), 16), ''),
          public.cities.feature_code
        )
      WHERE public.cities.id = city_id_value;
    END IF;

    cities_upserted := cities_upserted + 1;

    INSERT INTO private.global_city_targets (
      city_id,
      country_id,
      enabled,
      priority,
      population_rank,
      query_budget,
      cadence_hours,
      search_names,
      search_languages,
      query_profile,
      next_due_at,
      updated_at
    )
    VALUES (
      city_id_value,
      country_id_value,
      coalesce((item->>'enabled')::BOOLEAN, true),
      coalesce(nullif(item->>'priority', '')::SMALLINT, 0),
      population_rank_value,
      coalesce(nullif(item->>'query_budget', '')::SMALLINT, 16),
      coalesce(nullif(item->>'cadence_hours', '')::INTEGER, 168),
      city_search_names_value,
      city_search_languages_value,
      CASE
        WHEN jsonb_typeof(item->'query_profile') = 'object' THEN item->'query_profile'
        ELSE '{}'::JSONB
      END,
      coalesce(nullif(item->>'next_due_at', '')::TIMESTAMPTZ, now()),
      now()
    )
    ON CONFLICT (city_id) DO UPDATE SET
      country_id = EXCLUDED.country_id,
      enabled = EXCLUDED.enabled,
      priority = EXCLUDED.priority,
      population_rank = EXCLUDED.population_rank,
      query_budget = EXCLUDED.query_budget,
      cadence_hours = EXCLUDED.cadence_hours,
      search_names = EXCLUDED.search_names,
      search_languages = EXCLUDED.search_languages,
      query_profile = EXCLUDED.query_profile,
      next_due_at = CASE
        WHEN private.global_city_targets.next_due_at IS NULL THEN EXCLUDED.next_due_at
        ELSE private.global_city_targets.next_due_at
      END,
      updated_at = now();

    targets_upserted := targets_upserted + 1;
  END LOOP;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.import_global_city_targets(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_global_city_targets(JSONB)
  TO service_role;
