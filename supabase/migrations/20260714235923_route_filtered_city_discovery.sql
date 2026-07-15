-- Route every non-spatial city query, including advanced filters, through
-- the indexed city scope validated before this switch.

CREATE OR REPLACE FUNCTION public.discover_events(
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
  IF _city_id IS NOT NULL AND _lat IS NULL AND _lon IS NULL
  THEN
    RETURN QUERY
    SELECT
      row.event_id, row.occurrence_id, row.venue_id, row.slug, row.title,
      row.short_description, row.cover_image_url, row.category_slug, row.genres,
      row.starts_at, row.ends_at, row.timezone, row.venue_name, row.city_name,
      row.is_free, row.is_verified, row.is_demo, row.status, row.price_from,
      row.price_to, row.has_tickets, row.capacity, row.wheelchair,
      row.location_precision, row.distance_km
    FROM public.discover_event_rows_city_filtered_v2(
      _from, _to, _category_slugs, _city_id, _free_only, _query, _genres,
      _price_min, _price_max, _priced_only, _capacity_min, _capacity_max,
      _capacity_unknown, _tickets_only, _verified_only, _accessible_only,
      _venue_only, false, _limit, _offset
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
  IF _city_id IS NOT NULL AND _lat IS NULL AND _lon IS NULL
  THEN
    RETURN QUERY
    SELECT *
    FROM public.discover_event_rows_city_filtered_v2(
      _from, _to, _category_slugs, _city_id, _free_only, _query, _genres,
      _price_min, _price_max, _priced_only, _capacity_min, _capacity_max,
      _capacity_unknown, _tickets_only, _verified_only, _accessible_only,
      _venue_only, true, _limit, _offset
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


GRANT EXECUTE ON FUNCTION public.discover_event_rows_city_filtered_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, TEXT[],
  NUMERIC, NUMERIC, BOOLEAN, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
