-- Geography records initially created by demo seed data can later become the
-- canonical destination for imported, real events. Keep their visibility in
-- sync so public city search and map filters do not silently discard them.

UPDATE public.venues AS venue
SET is_demo = false
WHERE venue.is_demo = true
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.venue_id = venue.id
      AND event.is_demo = false
  );

UPDATE public.cities AS city
SET is_demo = false
WHERE city.is_demo = true
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    WHERE event.is_demo = false
      AND coalesce(venue.city_id, event.city_id) = city.id
  );

CREATE OR REPLACE FUNCTION public.promote_real_event_geography()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.is_demo IS NOT FALSE THEN
    RETURN NEW;
  END IF;

  IF NEW.venue_id IS NOT NULL THEN
    UPDATE public.venues
    SET is_demo = false
    WHERE id = NEW.venue_id
      AND is_demo = true;

    UPDATE public.cities AS city
    SET is_demo = false
    FROM public.venues AS venue
    WHERE venue.id = NEW.venue_id
      AND city.id = venue.city_id
      AND city.is_demo = true;
  END IF;

  IF NEW.city_id IS NOT NULL THEN
    UPDATE public.cities
    SET is_demo = false
    WHERE id = NEW.city_id
      AND is_demo = true;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.promote_real_event_geography()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS promote_real_event_geography_on_write ON public.events;
CREATE TRIGGER promote_real_event_geography_on_write
AFTER INSERT OR UPDATE OF is_demo, venue_id, city_id
ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.promote_real_event_geography();

-- Match city names accent-insensitively as well as their slugs. This makes
-- "Geneve" and "Genève" equivalent without downloading the city catalogue.
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
    SELECT nullif(public.unaccent(lower(trim(coalesce(_query, '')))), '') AS query
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
      OR public.unaccent(lower(city.name)) LIKE '%' || normalized.query || '%'
      OR public.unaccent(lower(city.slug)) LIKE '%' || normalized.query || '%'
    )
  ORDER BY
    CASE
      WHEN normalized.query IS NOT NULL
        AND public.unaccent(lower(city.name)) = normalized.query THEN 0
      WHEN normalized.query IS NOT NULL
        AND public.unaccent(lower(city.name)) LIKE normalized.query || '%' THEN 1
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

NOTIFY pgrst, 'reload schema';
