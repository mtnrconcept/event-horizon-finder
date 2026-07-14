-- Make the map feed resilient for scraper rows without a venue/city.
CREATE OR REPLACE FUNCTION public.discover_map_events(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  _category_slugs TEXT[] DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _limit INT DEFAULT 500,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  event_id UUID,
  occurrence_id UUID,
  slug TEXT,
  title TEXT,
  short_description TEXT,
  cover_image_url TEXT,
  category_slug TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT,
  venue_name TEXT,
  city_name TEXT,
  is_free BOOLEAN,
  is_verified BOOLEAN,
  is_demo BOOLEAN,
  status public.event_status,
  distance_km NUMERIC,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH selected_city AS (
    SELECT id, name, location
    FROM public.cities
    WHERE id = _city_id
    LIMIT 1
  ), event_points AS (
    SELECT
      e.id AS event_id,
      o.id AS occurrence_id,
      e.slug,
      e.title,
      e.short_description,
      e.cover_image_url,
      c.slug AS category_slug,
      o.starts_at,
      o.ends_at,
      o.timezone,
      v.name AS venue_name,
      COALESCE(ci.name, sc.name) AS city_name,
      e.is_free,
      e.is_verified,
      e.is_demo,
      e.status,
      COALESCE(o.latitude, v.latitude) AS latitude,
      COALESCE(o.longitude, v.longitude) AS longitude,
      COALESCE(o.location, v.location) AS location,
      v.city_id,
      sc.id AS selected_city_id,
      sc.location AS selected_city_location
    FROM public.events e
    JOIN public.event_occurrences o ON o.event_id = e.id
    LEFT JOIN public.event_categories c ON c.id = e.category_id
    LEFT JOIN public.venues v ON v.id = e.venue_id
    LEFT JOIN public.cities ci ON ci.id = v.city_id
    LEFT JOIN selected_city sc ON true
    WHERE e.status IN ('published','pending_review','cancelled','postponed','sold_out')
      AND o.starts_at >= _from AND o.starts_at <= _to
      AND (_category_slugs IS NULL OR c.slug = ANY(_category_slugs))
      AND (_free_only = false OR e.is_free = true)
      AND (_query IS NULL OR e.search_tsv @@ plainto_tsquery('simple', unaccent(_query))
           OR e.title ILIKE '%'||_query||'%'
           OR v.name ILIKE '%'||_query||'%')
      AND COALESCE(o.latitude, v.latitude) IS NOT NULL
      AND COALESCE(o.longitude, v.longitude) IS NOT NULL
  )
  SELECT
    ep.event_id,
    ep.occurrence_id,
    ep.slug,
    ep.title,
    ep.short_description,
    ep.cover_image_url,
    ep.category_slug,
    ep.starts_at,
    ep.ends_at,
    ep.timezone,
    ep.venue_name,
    ep.city_name,
    ep.is_free,
    ep.is_verified,
    ep.is_demo,
    ep.status,
    CASE WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND ep.location IS NOT NULL
      THEN ROUND((ST_Distance(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography)/1000)::numeric, 2)
      ELSE NULL END AS distance_km,
    ep.latitude,
    ep.longitude
  FROM event_points ep
  WHERE (
      _city_id IS NULL
      OR ep.city_id = _city_id
      OR (
        ep.selected_city_location IS NOT NULL
        AND ep.location IS NOT NULL
        AND ST_DWithin(ep.location, ep.selected_city_location, GREATEST(_radius_km, 25) * 1000)
      )
    )
    AND (
      _lat IS NULL OR _lon IS NULL OR ep.location IS NULL OR
      ST_DWithin(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography, _radius_km*1000)
    )
  ORDER BY ep.starts_at ASC
  LIMIT _limit OFFSET _offset;
$$;

GRANT EXECUTE ON FUNCTION public.discover_map_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT) TO anon, authenticated;
