BEGIN;

DO $$
DECLARE
  import_result RECORD;
BEGIN
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
END;
$$;

ROLLBACK;
