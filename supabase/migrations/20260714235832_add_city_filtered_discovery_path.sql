CREATE OR REPLACE FUNCTION public.discover_event_rows_city_filtered_v2(
  _from TIMESTAMPTZ,
  _to TIMESTAMPTZ,
  _category_slugs TEXT[],
  _city_id UUID,
  _free_only BOOLEAN,
  _query TEXT,
  _genres TEXT[],
  _price_min NUMERIC,
  _price_max NUMERIC,
  _priced_only BOOLEAN,
  _capacity_min INT,
  _capacity_max INT,
  _capacity_unknown BOOLEAN,
  _tickets_only BOOLEAN,
  _verified_only BOOLEAN,
  _accessible_only BOOLEAN,
  _venue_only BOOLEAN,
  _require_coordinates BOOLEAN,
  _limit INT,
  _offset INT
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
  WITH city_events AS MATERIALIZED (
    SELECT event.id
    FROM public.events AS event
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    WHERE event.city_id = _city_id
      AND venue.city_id IS NULL

    UNION ALL

    SELECT event.id
    FROM public.venues AS venue
    JOIN public.events AS event ON event.venue_id = venue.id
    WHERE venue.city_id = _city_id
  )
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
    CASE
      WHEN occurrence.latitude IS NOT NULL AND occurrence.longitude IS NOT NULL THEN 'exact'
      WHEN venue.latitude IS NOT NULL AND venue.longitude IS NOT NULL THEN 'venue'
      ELSE 'city'
    END AS location_precision,
    NULL::NUMERIC AS distance_km,
    coalesce(
      occurrence.latitude,
      venue.latitude,
      resolved_city.latitude
        + ((get_byte(decode(md5(event.id::TEXT), 'hex'), 0)::DOUBLE PRECISION / 255) - 0.5) * 0.012
    ) AS latitude,
    coalesce(
      occurrence.longitude,
      venue.longitude,
      resolved_city.longitude
        + ((get_byte(decode(md5(event.id::TEXT), 'hex'), 1)::DOUBLE PRECISION / 255) - 0.5) * 0.018
    ) AS longitude
  FROM city_events AS scoped
  JOIN public.events AS event ON event.id = scoped.id
  JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
  LEFT JOIN public.event_categories AS category ON category.id = event.category_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS resolved_city
    ON resolved_city.id = coalesce(venue.city_id, event.city_id)
  LEFT JOIN public.event_accessibility AS accessibility
    ON accessibility.event_id = event.id
  LEFT JOIN LATERAL (
    SELECT
      min(
        CASE WHEN offer.is_free THEN 0::NUMERIC
             ELSE coalesce(offer.price_min, offer.price_max) END
      ) AS price_from,
      max(
        CASE WHEN offer.is_free THEN 0::NUMERIC
             ELSE coalesce(offer.price_max, offer.price_min) END
      ) AS price_to,
      bool_or(
        offer.is_free
        OR (offer.ticket_url IS NOT NULL
            AND offer.status <> 'sold_out'::public.ticket_status)
      ) AS has_tickets
    FROM public.ticket_offers AS offer
    WHERE offer.event_id = event.id
  ) AS offers ON true
  WHERE event.status IN ('published','cancelled','postponed','sold_out')
    AND occurrence.starts_at >= _from
    AND occurrence.starts_at <= _to
    AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
    AND (_genres IS NULL OR event.genres && _genres)
    AND (_free_only = false OR event.is_free = true OR offers.price_from = 0)
    AND (_priced_only = false OR event.is_free = true OR offers.price_from IS NOT NULL)
    AND (
      _price_min IS NULL
      OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) >= _price_min
    )
    AND (
      _price_max IS NULL
      OR coalesce(offers.price_from, CASE WHEN event.is_free THEN 0::NUMERIC END) <= _price_max
    )
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
    AND (
      _require_coordinates = false
      OR (
        coalesce(occurrence.latitude, venue.latitude, resolved_city.latitude) IS NOT NULL
        AND coalesce(occurrence.longitude, venue.longitude, resolved_city.longitude) IS NOT NULL
      )
    )
  ORDER BY occurrence.starts_at ASC
  LIMIT least(greatest(_limit, 1), 1500)
  OFFSET greatest(_offset, 0);
$$;

REVOKE ALL ON FUNCTION public.discover_event_rows_city_filtered_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, TEXT[],
  NUMERIC, NUMERIC, BOOLEAN, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) FROM PUBLIC;

COMMENT ON FUNCTION public.discover_event_rows_city_filtered_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, TEXT[],
  NUMERIC, NUMERIC, BOOLEAN, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) IS 'Internal indexed city path for advanced discovery filters.';
