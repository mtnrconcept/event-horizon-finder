-- Preserve the exact production implementations for an immediate rollback.
ALTER FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) RENAME TO discover_events_legacy_20260715;

ALTER FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) RENAME TO discover_map_events_legacy_20260715;

REVOKE ALL ON FUNCTION public.discover_events_legacy_20260715(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.discover_map_events_legacy_20260715(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.discover_event_rows_v2(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.discover_event_rows_city_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, BOOLEAN, INT, INT
) TO anon, authenticated;

CREATE FUNCTION public.discover_events(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  _category_slugs TEXT[] DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _genres TEXT[] DEFAULT NULL,
  _price_min NUMERIC DEFAULT NULL,
  _price_max NUMERIC DEFAULT NULL,
  _priced_only BOOLEAN DEFAULT false,
  _capacity_min INT DEFAULT NULL,
  _capacity_max INT DEFAULT NULL,
  _capacity_unknown BOOLEAN DEFAULT false,
  _tickets_only BOOLEAN DEFAULT false,
  _verified_only BOOLEAN DEFAULT false,
  _accessible_only BOOLEAN DEFAULT false,
  _venue_only BOOLEAN DEFAULT false,
  _limit INT DEFAULT 40,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  event_id UUID, occurrence_id UUID, venue_id UUID, slug TEXT, title TEXT,
  short_description TEXT, cover_image_url TEXT, category_slug TEXT, genres TEXT[],
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, timezone TEXT, venue_name TEXT,
  city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN, is_demo BOOLEAN,
  status public.event_status, price_from NUMERIC, price_to NUMERIC,
  has_tickets BOOLEAN, capacity INT, wheelchair BOOLEAN,
  location_precision TEXT, distance_km NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF _city_id IS NOT NULL
     AND _lat IS NULL AND _lon IS NULL
     AND _category_slugs IS NULL
     AND _free_only = false
     AND _query IS NULL
     AND _genres IS NULL
     AND _price_min IS NULL AND _price_max IS NULL
     AND _priced_only = false
     AND _capacity_min IS NULL AND _capacity_max IS NULL
     AND _capacity_unknown = false
     AND _tickets_only = false
     AND _verified_only = false
     AND _accessible_only = false
     AND _venue_only = false
  THEN
    RETURN QUERY
    SELECT
      row.event_id, row.occurrence_id, row.venue_id, row.slug, row.title,
      row.short_description, row.cover_image_url, row.category_slug, row.genres,
      row.starts_at, row.ends_at, row.timezone, row.venue_name, row.city_name,
      row.is_free, row.is_verified, row.is_demo, row.status, row.price_from,
      row.price_to, row.has_tickets, row.capacity, row.wheelchair,
      row.location_precision, row.distance_km
    FROM public.discover_event_rows_city_v2(
      _from, _to, _city_id, false, _limit, _offset
    ) AS row;
  ELSE
    RETURN QUERY
    SELECT
      row.event_id, row.occurrence_id, row.venue_id, row.slug, row.title,
      row.short_description, row.cover_image_url, row.category_slug, row.genres,
      row.starts_at, row.ends_at, row.timezone, row.venue_name, row.city_name,
      row.is_free, row.is_verified, row.is_demo, row.status, row.price_from,
      row.price_to, row.has_tickets, row.capacity, row.wheelchair,
      row.location_precision, row.distance_km
    FROM public.discover_event_rows_v2(
      _lat, _lon, _radius_km, _from, _to, _category_slugs, _city_id,
      _free_only, _query, _genres, _price_min, _price_max, _priced_only,
      _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
      _verified_only, _accessible_only, _venue_only, false, _limit, _offset
    ) AS row;
  END IF;
END;
$$;

CREATE FUNCTION public.discover_map_events(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  _category_slugs TEXT[] DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _genres TEXT[] DEFAULT NULL,
  _price_min NUMERIC DEFAULT NULL,
  _price_max NUMERIC DEFAULT NULL,
  _priced_only BOOLEAN DEFAULT false,
  _capacity_min INT DEFAULT NULL,
  _capacity_max INT DEFAULT NULL,
  _capacity_unknown BOOLEAN DEFAULT false,
  _tickets_only BOOLEAN DEFAULT false,
  _verified_only BOOLEAN DEFAULT false,
  _accessible_only BOOLEAN DEFAULT false,
  _venue_only BOOLEAN DEFAULT false,
  _limit INT DEFAULT 1000,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  event_id UUID, occurrence_id UUID, venue_id UUID, slug TEXT, title TEXT,
  short_description TEXT, cover_image_url TEXT, category_slug TEXT, genres TEXT[],
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, timezone TEXT, venue_name TEXT,
  city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN, is_demo BOOLEAN,
  status public.event_status, price_from NUMERIC, price_to NUMERIC,
  has_tickets BOOLEAN, capacity INT, wheelchair BOOLEAN,
  location_precision TEXT, distance_km NUMERIC,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF _city_id IS NOT NULL
     AND _lat IS NULL AND _lon IS NULL
     AND _category_slugs IS NULL
     AND _free_only = false
     AND _query IS NULL
     AND _genres IS NULL
     AND _price_min IS NULL AND _price_max IS NULL
     AND _priced_only = false
     AND _capacity_min IS NULL AND _capacity_max IS NULL
     AND _capacity_unknown = false
     AND _tickets_only = false
     AND _verified_only = false
     AND _accessible_only = false
     AND _venue_only = false
  THEN
    RETURN QUERY
    SELECT *
    FROM public.discover_event_rows_city_v2(
      _from, _to, _city_id, true, _limit, _offset
    );
  ELSE
    RETURN QUERY
    SELECT *
    FROM public.discover_event_rows_v2(
      _lat, _lon, _radius_km, _from, _to, _category_slugs, _city_id,
      _free_only, _query, _genres, _price_min, _price_max, _priced_only,
      _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
      _verified_only, _accessible_only, _venue_only, true, _limit, _offset
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

COMMENT ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) IS 'V2 indexed discovery dispatcher. Legacy implementation retained as discover_events_legacy_20260715.';

COMMENT ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) IS 'V2 indexed map dispatcher. Legacy implementation retained as discover_map_events_legacy_20260715.';

NOTIFY pgrst, 'reload schema';
