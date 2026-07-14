-- Rich discovery filters and complete map coverage.
-- Unknown values remain unknown: no price, genre, capacity or exact address is fabricated.

CREATE INDEX IF NOT EXISTS events_genres_gin
  ON public.events USING GIN (genres);
CREATE INDEX IF NOT EXISTS ticket_offers_event_idx
  ON public.ticket_offers (event_id);
CREATE INDEX IF NOT EXISTS ticket_offers_known_price_idx
  ON public.ticket_offers (event_id, price_min, price_max)
  WHERE price_min IS NOT NULL OR price_max IS NOT NULL OR is_free = true;
CREATE INDEX IF NOT EXISTS venues_city_idx
  ON public.venues (city_id)
  WHERE is_public = true;

CREATE OR REPLACE FUNCTION public.infer_event_genres(
  _title TEXT,
  _short_description TEXT DEFAULT NULL,
  _description TEXT DEFAULT NULL
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH input AS (
    SELECT lower(concat_ws(' ', _title, _short_description, _description)) AS haystack
  ), matches(priority, genre, pattern) AS (
    VALUES
      (10, 'afro-house', '(afro[ -]?house)'),
      (20, 'techno', '(^|[^a-z])techno([^a-z]|$)'),
      (30, 'house', '(^|[^a-z])house([^a-z]|$)'),
      (40, 'electro', '(electro|electronica|electronic music|musique electronique|musique électronique)'),
      (50, 'trance', '(psytrance|goa trance|(^|[^a-z])trance([^a-z]|$))'),
      (60, 'drum-and-bass', '(drum.?and.?bass|drum.?n.?bass|(^|[^a-z])dnb([^a-z]|$)|jungle)'),
      (70, 'hip-hop', '(hip.?hop|(^|[^a-z])rap([^a-z]|$)|(^|[^a-z])trap([^a-z]|$))'),
      (80, 'r-and-b', '(r&b|(^|[^a-z])rnb([^a-z]|$)|rhythm and blues)'),
      (90, 'soul', '(^|[^a-z])soul([^a-z]|$)'),
      (100, 'reggae', '(reggae|(^|[^a-z])dub([^a-z]|$)|(^|[^a-z])ska([^a-z]|$))'),
      (110, 'dancehall', 'dancehall'),
      (120, 'disco', '(^|[^a-z])disco([^a-z]|$)'),
      (130, 'funk', '(^|[^a-z])funk([^a-z]|$)'),
      (140, 'jazz', '(^|[^a-z])jazz([^a-z]|$)'),
      (150, 'blues', '(^|[^a-z])blues([^a-z]|$)'),
      (160, 'rock', '(^|[^a-z])rock([^a-z]|$)'),
      (170, 'metal', '(^|[^a-z])metal([^a-z]|$)'),
      (180, 'punk', '(^|[^a-z])punk([^a-z]|$)'),
      (190, 'indie', '(^|[^a-z])indie([^a-z]|$)'),
      (200, 'pop', '(^|[^a-z])pop([^a-z]|$)'),
      (210, 'classical', '(classique|classical|symphon|philharmon|orchestr|musique de chambre|quatuor|sonate)'),
      (220, 'opera', '(^|[^a-z])(opera|opéra)([^a-z]|$)'),
      (230, 'latin', '(latin|salsa|bachata|cumbia|merengue)'),
      (240, 'reggaeton', 'reggaeton'),
      (250, 'afrobeat', '(afrobeat|afrobeats)'),
      (260, 'world', '(world music|musiques? du monde)'),
      (270, 'experimental', '(experimental|expérimental|avant.?garde)'),
      (280, 'ambient', '(^|[^a-z])ambient([^a-z]|$)'),
      (290, 'gospel', '(^|[^a-z])gospel([^a-z]|$)')
  )
  SELECT coalesce(array_agg(matches.genre ORDER BY matches.priority), '{}'::TEXT[])
  FROM input
  JOIN matches ON input.haystack ~ matches.pattern;
$$;

CREATE OR REPLACE FUNCTION public.apply_inferred_event_genres()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF cardinality(coalesce(NEW.genres, '{}'::TEXT[])) = 0 THEN
    NEW.genres := public.infer_event_genres(NEW.title, NEW.short_description, NEW.description);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_events_00_infer_genres ON public.events;
CREATE TRIGGER trg_events_00_infer_genres
  BEFORE INSERT OR UPDATE OF title, short_description, description, genres
  ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_inferred_event_genres();

WITH inferred AS (
  SELECT
    id,
    public.infer_event_genres(title, short_description, description) AS genres
  FROM public.events
  WHERE cardinality(coalesce(genres, '{}'::TEXT[])) = 0
)
UPDATE public.events AS event
SET genres = inferred.genres
FROM inferred
WHERE event.id = inferred.id
  AND cardinality(inferred.genres) > 0;

DROP FUNCTION IF EXISTS public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, INT, INT
);

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
  event_id UUID,
  occurrence_id UUID,
  venue_id UUID,
  slug TEXT,
  title TEXT,
  short_description TEXT,
  cover_image_url TEXT,
  category_slug TEXT,
  genres TEXT[],
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT,
  venue_name TEXT,
  city_name TEXT,
  is_free BOOLEAN,
  is_verified BOOLEAN,
  is_demo BOOLEAN,
  status public.event_status,
  price_from NUMERIC,
  price_to NUMERIC,
  has_tickets BOOLEAN,
  capacity INT,
  wheelchair BOOLEAN,
  location_precision TEXT,
  distance_km NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH offer_summary AS (
    SELECT
      offer.event_id,
      min(CASE WHEN offer.is_free THEN 0::NUMERIC ELSE coalesce(offer.price_min, offer.price_max) END) AS price_from,
      max(CASE WHEN offer.is_free THEN 0::NUMERIC ELSE coalesce(offer.price_max, offer.price_min) END) AS price_to,
      bool_or(offer.is_free OR (offer.ticket_url IS NOT NULL AND offer.status <> 'sold_out'::public.ticket_status)) AS has_tickets
    FROM public.ticket_offers AS offer
    GROUP BY offer.event_id
  ), event_points AS (
    SELECT
      event.id AS event_id,
      occurrence.id AS occurrence_id,
      venue.id AS venue_id,
      event.slug,
      event.title,
      event.short_description,
      event.cover_image_url,
      category.slug AS category_slug,
      coalesce(event.genres, '{}'::TEXT[]) AS genres,
      occurrence.starts_at,
      occurrence.ends_at,
      occurrence.timezone,
      venue.name AS venue_name,
      resolved_city.name AS city_name,
      event.is_free,
      event.is_verified,
      event.is_demo,
      event.status,
      coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) AS price_from,
      coalesce(offers.price_to, CASE WHEN event.is_free THEN 0::NUMERIC END) AS price_to,
      (coalesce(offers.has_tickets, false) OR event.is_free) AS has_tickets,
      coalesce(occurrence.capacity, venue.capacity) AS capacity,
      coalesce(accessibility.wheelchair, false) AS wheelchair,
      coalesce(occurrence.location, venue.location, resolved_city.location) AS location,
      coalesce(venue.city_id, event.city_id) AS resolved_city_id,
      CASE
        WHEN occurrence.latitude IS NOT NULL AND occurrence.longitude IS NOT NULL THEN 'exact'
        WHEN venue.latitude IS NOT NULL AND venue.longitude IS NOT NULL THEN 'venue'
        ELSE 'city'
      END AS location_precision
    FROM public.events AS event
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    LEFT JOIN public.event_categories AS category ON category.id = event.category_id
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    LEFT JOIN public.cities AS resolved_city ON resolved_city.id = coalesce(venue.city_id, event.city_id)
    LEFT JOIN public.event_accessibility AS accessibility ON accessibility.event_id = event.id
    LEFT JOIN offer_summary AS offers ON offers.event_id = event.id
    WHERE event.status IN ('published','cancelled','postponed','sold_out')
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to
      AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
      AND (_genres IS NULL OR event.genres && _genres)
      AND (_free_only = false OR event.is_free = true OR offers.price_from = 0)
      AND (_priced_only = false OR event.is_free = true OR offers.price_from IS NOT NULL)
      AND (_price_min IS NULL OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) >= _price_min)
      AND (_price_max IS NULL OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) <= _price_max)
      AND (_capacity_unknown = false OR coalesce(occurrence.capacity, venue.capacity) IS NULL)
      AND (_capacity_min IS NULL OR coalesce(occurrence.capacity, venue.capacity) >= _capacity_min)
      AND (_capacity_max IS NULL OR coalesce(occurrence.capacity, venue.capacity) <= _capacity_max)
      AND (_tickets_only = false OR event.is_free = true OR coalesce(offers.has_tickets, false))
      AND (_verified_only = false OR event.is_verified = true)
      AND (_accessible_only = false OR accessibility.wheelchair = true)
      AND (_venue_only = false OR venue.id IS NOT NULL)
      AND (
        _query IS NULL
        OR event.search_tsv @@ plainto_tsquery('simple', public.unaccent(_query))
        OR event.title ILIKE '%' || _query || '%'
        OR venue.name ILIKE '%' || _query || '%'
      )
  )
  SELECT
    point.event_id,
    point.occurrence_id,
    point.venue_id,
    point.slug,
    point.title,
    point.short_description,
    point.cover_image_url,
    point.category_slug,
    point.genres,
    point.starts_at,
    point.ends_at,
    point.timezone,
    point.venue_name,
    point.city_name,
    point.is_free,
    point.is_verified,
    point.is_demo,
    point.status,
    point.price_from,
    point.price_to,
    point.has_tickets,
    point.capacity,
    point.wheelchair,
    point.location_precision,
    CASE
      WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND point.location IS NOT NULL
      THEN round((public.st_distance(
        point.location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography
      ) / 1000)::NUMERIC, 2)
      ELSE NULL
    END AS distance_km
  FROM event_points AS point
  WHERE (_city_id IS NULL OR point.resolved_city_id = _city_id)
    AND (
      _lat IS NULL OR _lon IS NULL OR point.location IS NULL
      OR public.st_dwithin(
        point.location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography,
        _radius_km * 1000
      )
    )
  ORDER BY point.starts_at ASC
  LIMIT least(greatest(_limit, 1), 500)
  OFFSET greatest(_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, INT, INT
);

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
  event_id UUID,
  occurrence_id UUID,
  venue_id UUID,
  slug TEXT,
  title TEXT,
  short_description TEXT,
  cover_image_url TEXT,
  category_slug TEXT,
  genres TEXT[],
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT,
  venue_name TEXT,
  city_name TEXT,
  is_free BOOLEAN,
  is_verified BOOLEAN,
  is_demo BOOLEAN,
  status public.event_status,
  price_from NUMERIC,
  price_to NUMERIC,
  has_tickets BOOLEAN,
  capacity INT,
  wheelchair BOOLEAN,
  location_precision TEXT,
  distance_km NUMERIC,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH offer_summary AS (
    SELECT
      offer.event_id,
      min(CASE WHEN offer.is_free THEN 0::NUMERIC ELSE coalesce(offer.price_min, offer.price_max) END) AS price_from,
      max(CASE WHEN offer.is_free THEN 0::NUMERIC ELSE coalesce(offer.price_max, offer.price_min) END) AS price_to,
      bool_or(offer.is_free OR (offer.ticket_url IS NOT NULL AND offer.status <> 'sold_out'::public.ticket_status)) AS has_tickets
    FROM public.ticket_offers AS offer
    GROUP BY offer.event_id
  ), event_points AS (
    SELECT
      event.id AS event_id,
      occurrence.id AS occurrence_id,
      venue.id AS venue_id,
      event.slug,
      event.title,
      event.short_description,
      event.cover_image_url,
      category.slug AS category_slug,
      coalesce(event.genres, '{}'::TEXT[]) AS genres,
      occurrence.starts_at,
      occurrence.ends_at,
      occurrence.timezone,
      venue.name AS venue_name,
      resolved_city.name AS city_name,
      event.is_free,
      event.is_verified,
      event.is_demo,
      event.status,
      coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) AS price_from,
      coalesce(offers.price_to, CASE WHEN event.is_free THEN 0::NUMERIC END) AS price_to,
      (coalesce(offers.has_tickets, false) OR event.is_free) AS has_tickets,
      coalesce(occurrence.capacity, venue.capacity) AS capacity,
      coalesce(accessibility.wheelchair, false) AS wheelchair,
      coalesce(occurrence.location, venue.location, resolved_city.location) AS location,
      coalesce(venue.city_id, event.city_id) AS resolved_city_id,
      CASE
        WHEN occurrence.latitude IS NOT NULL AND occurrence.longitude IS NOT NULL THEN 'exact'
        WHEN venue.latitude IS NOT NULL AND venue.longitude IS NOT NULL THEN 'venue'
        ELSE 'city'
      END AS location_precision,
      coalesce(
        occurrence.latitude,
        venue.latitude,
        resolved_city.latitude + ((get_byte(decode(md5(event.id::TEXT), 'hex'), 0)::DOUBLE PRECISION / 255) - 0.5) * 0.012
      ) AS latitude,
      coalesce(
        occurrence.longitude,
        venue.longitude,
        resolved_city.longitude + ((get_byte(decode(md5(event.id::TEXT), 'hex'), 1)::DOUBLE PRECISION / 255) - 0.5) * 0.018
      ) AS longitude
    FROM public.events AS event
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    LEFT JOIN public.event_categories AS category ON category.id = event.category_id
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    LEFT JOIN public.cities AS resolved_city ON resolved_city.id = coalesce(venue.city_id, event.city_id)
    LEFT JOIN public.event_accessibility AS accessibility ON accessibility.event_id = event.id
    LEFT JOIN offer_summary AS offers ON offers.event_id = event.id
    WHERE event.status IN ('published','cancelled','postponed','sold_out')
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to
      AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
      AND (_genres IS NULL OR event.genres && _genres)
      AND (_free_only = false OR event.is_free = true OR offers.price_from = 0)
      AND (_priced_only = false OR event.is_free = true OR offers.price_from IS NOT NULL)
      AND (_price_min IS NULL OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) >= _price_min)
      AND (_price_max IS NULL OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) <= _price_max)
      AND (_capacity_unknown = false OR coalesce(occurrence.capacity, venue.capacity) IS NULL)
      AND (_capacity_min IS NULL OR coalesce(occurrence.capacity, venue.capacity) >= _capacity_min)
      AND (_capacity_max IS NULL OR coalesce(occurrence.capacity, venue.capacity) <= _capacity_max)
      AND (_tickets_only = false OR event.is_free = true OR coalesce(offers.has_tickets, false))
      AND (_verified_only = false OR event.is_verified = true)
      AND (_accessible_only = false OR accessibility.wheelchair = true)
      AND (_venue_only = false OR venue.id IS NOT NULL)
      AND (
        _query IS NULL
        OR event.search_tsv @@ plainto_tsquery('simple', public.unaccent(_query))
        OR event.title ILIKE '%' || _query || '%'
        OR venue.name ILIKE '%' || _query || '%'
      )
  )
  SELECT
    point.event_id,
    point.occurrence_id,
    point.venue_id,
    point.slug,
    point.title,
    point.short_description,
    point.cover_image_url,
    point.category_slug,
    point.genres,
    point.starts_at,
    point.ends_at,
    point.timezone,
    point.venue_name,
    point.city_name,
    point.is_free,
    point.is_verified,
    point.is_demo,
    point.status,
    point.price_from,
    point.price_to,
    point.has_tickets,
    point.capacity,
    point.wheelchair,
    point.location_precision,
    CASE
      WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND point.location IS NOT NULL
      THEN round((public.st_distance(
        point.location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography
      ) / 1000)::NUMERIC, 2)
      ELSE NULL
    END AS distance_km,
    point.latitude,
    point.longitude
  FROM event_points AS point
  WHERE point.latitude IS NOT NULL
    AND point.longitude IS NOT NULL
    AND (_city_id IS NULL OR point.resolved_city_id = _city_id)
    AND (
      _lat IS NULL OR _lon IS NULL OR point.location IS NULL
      OR public.st_dwithin(
        point.location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography,
        _radius_km * 1000
      )
    )
  ORDER BY point.starts_at ASC
  LIMIT least(greatest(_limit, 1), 1500)
  OFFSET greatest(_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated;

COMMENT ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) IS 'Public event discovery with price, music, capacity, ticket, verification and accessibility filters.';

COMMENT ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) IS 'Filtered map discovery. City-level coordinates are deterministically spread and marked as approximate.';
