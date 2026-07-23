-- Allow operators to exhaust the due-city queue for one or more countries,
-- rather than waiting for those cities in the worldwide priority rotation.
CREATE OR REPLACE FUNCTION public.list_due_global_city_targets_v2(
  _limit INTEGER DEFAULT 250,
  _as_of TIMESTAMPTZ DEFAULT now(),
  _country_codes TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS TABLE (
  city_id UUID, city_name TEXT, country_code TEXT, country_name TEXT,
  timezone TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  population BIGINT, country_population_rank INTEGER, search_names TEXT[],
  search_languages TEXT[], query_profile JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_codes TEXT[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT upper(btrim(code))), ARRAY[]::TEXT[])
  INTO normalized_codes
  FROM unnest(coalesce(_country_codes, ARRAY[]::TEXT[])) AS code
  WHERE btrim(code) <> '';

  IF cardinality(normalized_codes) > 20
    OR EXISTS (SELECT 1 FROM unnest(normalized_codes) AS code WHERE code !~ '^[A-Z]{2}$')
  THEN
    RAISE EXCEPTION 'invalid_country_codes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT city.id, city.name, country.code, country.name, city.timezone,
    city.latitude, city.longitude, city.population, target.population_rank::INTEGER,
    target.search_names, target.search_languages, target.query_profile
  FROM private.global_city_targets AS target
  JOIN public.cities AS city ON city.id = target.city_id
  JOIN public.countries AS country ON country.id = target.country_id
  WHERE target.enabled
    AND (cardinality(normalized_codes) = 0 OR country.code = ANY(normalized_codes))
    AND (target.next_due_at IS NULL OR target.next_due_at <= coalesce(_as_of, now()))
  ORDER BY target.priority DESC, target.next_due_at ASC NULLS FIRST,
    target.population_rank ASC NULLS LAST, city.population DESC NULLS LAST, city.id
  LIMIT greatest(1, least(coalesce(_limit, 250), 2000));
END;
$$;

REVOKE ALL ON FUNCTION public.list_due_global_city_targets_v2(INTEGER, TIMESTAMPTZ, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_global_city_targets_v2(INTEGER, TIMESTAMPTZ, TEXT[])
  TO service_role;

COMMENT ON FUNCTION public.list_due_global_city_targets_v2(INTEGER, TIMESTAMPTZ, TEXT[]) IS
  'Service-role planner queue with an optional bounded ISO country filter; an empty filter preserves worldwide discovery.';
