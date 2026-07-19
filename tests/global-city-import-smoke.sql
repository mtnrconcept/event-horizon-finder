DO $$
DECLARE
  import_result RECORD;
  imported_city_id UUID;
  imported_country_id UUID;
  legacy_near_city_id UUID;
  legacy_far_city_id UUID;
  imported_far_city_id UUID;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.countries
    WHERE code = 'XZ'
       OR geonames_id = 999999999
  ) OR EXISTS (
    SELECT 1
    FROM public.cities
    WHERE geonames_id = ANY(ARRAY[
      999999995::BIGINT,
      999999996::BIGINT,
      999999997::BIGINT,
      999999998::BIGINT
    ])
  ) THEN
    RAISE EXCEPTION 'GeoNames smoke-test sentinel already exists';
  END IF;

  INSERT INTO public.countries (code, iso3, name, geonames_id)
  VALUES ('XZ', 'XZZ', 'Schema Test Country', 999999999)
  RETURNING id INTO imported_country_id;

  INSERT INTO public.cities (
    country_id,
    slug,
    name,
    timezone,
    latitude,
    longitude,
    geonames_id
  )
  VALUES (
    imported_country_id,
    'schema-test-city-xz-legacy',
    'Schema Test City',
    'UTC',
    1.251,
    2.501,
    999999997
  )
  RETURNING id INTO legacy_near_city_id;

  SELECT *
  INTO import_result
  FROM public.import_global_city_targets(
    jsonb_build_array(
      jsonb_build_object(
        'country_code', 'XZ',
        'country_iso3', 'XZZ',
        'country_name', 'Schema Test Country',
        'country_geonames_id', 999999999,
        'country_area_sq_km', 1000,
        'country_population', 500000,
        'country_languages', jsonb_build_array('en'),
        'city_geonames_id', 999999998,
        'city_name', 'Schema Test City',
        'city_ascii_name', 'Schema Test City',
        'search_names', jsonb_build_array('Schema Test City'),
        'search_languages', jsonb_build_array('en'),
        'latitude', 1.25,
        'longitude', 2.5,
        'timezone', 'UTC',
        'city_population', 12345,
        'country_population_rank', 1,
        'is_capital', true,
        'feature_code', 'PPLC',
        'query_profile', jsonb_build_object('source', 'migration-smoke-test')
      )
    )
  );

  IF import_result.countries_upserted <> 1
     OR import_result.cities_upserted <> 1
     OR import_result.targets_upserted <> 1 THEN
    RAISE EXCEPTION 'unexpected GeoNames import counts: %', import_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM private.global_city_targets AS target
    JOIN public.cities AS city ON city.id = target.city_id
    WHERE city.geonames_id = 999999998
      AND city.location IS NOT NULL
      AND city.latitude = 1.25
      AND city.longitude = 2.5
  ) THEN
    RAISE EXCEPTION 'GeoNames smoke target was not persisted with coordinates';
  END IF;

  SELECT city.id, city.country_id
  INTO imported_city_id, imported_country_id
  FROM public.cities AS city
  WHERE city.geonames_id = 999999998;

  IF imported_city_id IS DISTINCT FROM legacy_near_city_id
     OR EXISTS (
       SELECT 1
       FROM public.cities
       WHERE geonames_id = 999999997
     )
     OR 1 <> (
       SELECT count(*)
       FROM public.cities
       WHERE country_id = imported_country_id
         AND public.unaccent(lower(name)) = public.unaccent(lower('Schema Test City'))
     ) THEN
    RAISE EXCEPTION 'nearby legacy city was not canonicalized in place';
  END IF;

  INSERT INTO public.cities (
    country_id,
    slug,
    name,
    timezone,
    latitude,
    longitude,
    geonames_id
  )
  VALUES (
    imported_country_id,
    'schema-distant-twin-xz-legacy',
    'Schema Distant Twin',
    'UTC',
    10,
    10,
    999999995
  )
  RETURNING id INTO legacy_far_city_id;

  SELECT *
  INTO import_result
  FROM public.import_global_city_targets(
    jsonb_build_array(
      jsonb_build_object(
        'country_code', 'XZ',
        'country_iso3', 'XZZ',
        'country_name', 'Schema Test Country',
        'country_geonames_id', 999999999,
        'country_languages', jsonb_build_array('en'),
        'city_geonames_id', 999999996,
        'city_name', 'Schema Distant Twin',
        'city_ascii_name', 'Schema Distant Twin',
        'latitude', 10.07,
        'longitude', 10,
        'timezone', 'UTC',
        'city_population', 54321,
        'country_population_rank', 2,
        'query_profile', jsonb_build_object('source', 'migration-smoke-test')
      )
    )
  );

  SELECT city.id
  INTO imported_far_city_id
  FROM public.cities AS city
  WHERE city.geonames_id = 999999996;

  IF imported_far_city_id IS NULL
     OR imported_far_city_id = legacy_far_city_id
     OR NOT EXISTS (
       SELECT 1
       FROM public.cities
       WHERE id = legacy_far_city_id
         AND geonames_id = 999999995
         AND latitude = 10
         AND longitude = 10
     )
     OR 2 <> (
       SELECT count(*)
       FROM public.cities
       WHERE country_id = imported_country_id
         AND public.unaccent(lower(name)) = public.unaccent(lower('Schema Distant Twin'))
     ) THEN
    RAISE EXCEPTION 'same-name cities beyond six kilometres were merged';
  END IF;

  DELETE FROM private.global_city_targets
  WHERE country_id = imported_country_id;

  DELETE FROM public.cities
  WHERE country_id = imported_country_id;

  DELETE FROM public.countries
  WHERE id = imported_country_id;
END;
$$;
