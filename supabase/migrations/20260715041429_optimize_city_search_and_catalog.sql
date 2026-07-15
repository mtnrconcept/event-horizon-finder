-- Fast server-side city lookup for the discovery, map, onboarding and MCP
-- surfaces. The previous UI downloaded the complete 13k+ city catalogue in
-- 1,000-row pages on every visit.

CREATE INDEX IF NOT EXISTS cities_country_region_name_lower_idx
  ON public.cities (country_id, region_id, lower(name), id)
  WHERE is_demo = false;

CREATE OR REPLACE FUNCTION public.search_geography_cities(
  _country_id UUID DEFAULT NULL,
  _region_id UUID DEFAULT NULL,
  _query TEXT DEFAULT NULL,
  _limit INTEGER DEFAULT 80
)
RETURNS TABLE (
  id UUID,
  country_id UUID,
  region_id UUID,
  slug TEXT,
  name TEXT,
  timezone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT nullif(lower(trim(coalesce(_query, ''))), '') AS query
  )
  SELECT
    city.id,
    city.country_id,
    coalesce(city.region_id, catalog.region_id) AS region_id,
    city.slug,
    city.name,
    city.timezone,
    city.latitude,
    city.longitude
  FROM public.cities AS city
  LEFT JOIN public.city_region_catalog AS catalog ON catalog.city_id = city.id
  CROSS JOIN normalized
  WHERE city.is_demo = false
    AND (_country_id IS NULL OR city.country_id = _country_id)
    AND (
      _region_id IS NULL
      OR coalesce(city.region_id, catalog.region_id) = _region_id
    )
    AND (
      normalized.query IS NULL
      OR lower(city.name) LIKE '%' || normalized.query || '%'
      OR lower(city.slug) LIKE '%' || normalized.query || '%'
    )
  ORDER BY
    CASE
      WHEN normalized.query IS NOT NULL AND lower(city.name) = normalized.query THEN 0
      WHEN normalized.query IS NOT NULL AND lower(city.name) LIKE normalized.query || '%' THEN 1
      ELSE 2
    END,
    city.name,
    city.id
  LIMIT least(greatest(coalesce(_limit, 80), 1), 200);
$function$;

REVOKE ALL ON FUNCTION public.search_geography_cities(UUID, UUID, TEXT, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_geography_cities(UUID, UUID, TEXT, INTEGER)
  TO anon, authenticated, service_role;
