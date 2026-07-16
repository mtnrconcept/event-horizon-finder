-- Exact discovery counters independent from the paginated result set.
-- Candidate occurrences follow the same four indexed routes as discover_events:
-- spatial, city, country/region, and worldwide.

CREATE OR REPLACE FUNCTION public.discover_event_stats_v1(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT now() + interval '30 days',
  _category_slugs TEXT[] DEFAULT NULL,
  _country_id UUID DEFAULT NULL,
  _region_id UUID DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _genres TEXT[] DEFAULT NULL,
  _price_min NUMERIC DEFAULT NULL,
  _price_max NUMERIC DEFAULT NULL,
  _priced_only BOOLEAN DEFAULT false,
  _capacity_min INTEGER DEFAULT NULL,
  _capacity_max INTEGER DEFAULT NULL,
  _capacity_unknown BOOLEAN DEFAULT false,
  _tickets_only BOOLEAN DEFAULT false,
  _verified_only BOOLEAN DEFAULT false,
  _accessible_only BOOLEAN DEFAULT false,
  _venue_only BOOLEAN DEFAULT false,
  _require_coordinates BOOLEAN DEFAULT false
)
RETURNS TABLE (
  total_count BIGINT,
  free_count BIGINT,
  verified_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  -- The common case (dates, geography, categories, genres and verification)
  -- does not need venue, offer or accessibility joins. Keeping four explicit
  -- routes here prevents a generic plan from performing hundreds of thousands
  -- of unnecessary lateral ticket lookups for worldwide counts.
  IF _free_only = false
    AND _query IS NULL
    AND _price_min IS NULL
    AND _price_max IS NULL
    AND _priced_only = false
    AND _capacity_min IS NULL
    AND _capacity_max IS NULL
    AND _capacity_unknown = false
    AND _tickets_only = false
    AND _accessible_only = false
    AND _venue_only = false
    AND _require_coordinates = false
  THEN
    IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
      RETURN QUERY
      SELECT
        count(*)::BIGINT,
        count(*) FILTER (WHERE event.is_free = true)::BIGINT,
        count(*) FILTER (WHERE event.is_verified = true)::BIGINT
      FROM public.event_occurrences AS occurrence
      JOIN public.events AS event ON event.id = occurrence.event_id
      LEFT JOIN public.event_categories AS category ON category.id = event.category_id
      LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
      WHERE occurrence.starts_at >= _from
        AND occurrence.starts_at <= _to
        AND occurrence.location IS NOT NULL
        AND public.st_dwithin(
          occurrence.location,
          public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography,
          _radius_km * 1000
        )
        AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
        AND (
          _city_id IS NULL
          OR venue.city_id = _city_id
          OR (venue.city_id IS NULL AND event.city_id = _city_id)
        )
        AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
        AND (_genres IS NULL OR event.genres && _genres)
        AND (_verified_only = false OR event.is_verified = true);
      RETURN;
    ELSIF _city_id IS NOT NULL THEN
      RETURN QUERY
      WITH city_candidates AS MATERIALIZED (
        SELECT occurrence.id, occurrence.event_id
        FROM public.events AS event
        JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
        LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
        WHERE event.city_id = _city_id
          AND venue.city_id IS NULL
          AND occurrence.starts_at >= _from
          AND occurrence.starts_at <= _to

        UNION ALL

        SELECT occurrence.id, occurrence.event_id
        FROM public.venues AS venue
        JOIN public.events AS event ON event.venue_id = venue.id
        JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
        WHERE venue.city_id = _city_id
          AND occurrence.starts_at >= _from
          AND occurrence.starts_at <= _to
      )
      SELECT
        count(*)::BIGINT,
        count(*) FILTER (WHERE event.is_free = true)::BIGINT,
        count(*) FILTER (WHERE event.is_verified = true)::BIGINT
      FROM city_candidates AS candidate
      JOIN public.events AS event ON event.id = candidate.event_id
      LEFT JOIN public.event_categories AS category ON category.id = event.category_id
      WHERE event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
        AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
        AND (_genres IS NULL OR event.genres && _genres)
        AND (_verified_only = false OR event.is_verified = true);
      RETURN;
    ELSIF _country_id IS NOT NULL OR _region_id IS NOT NULL THEN
      RETURN QUERY
      WITH scoped_cities AS MATERIALIZED (
        SELECT city.id
        FROM public.cities AS city
        WHERE (_country_id IS NULL OR city.country_id = _country_id)
          AND (
            _region_id IS NULL
            OR city.region_id = _region_id
            OR (
              city.region_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM public.city_region_catalog AS catalog
                WHERE catalog.city_id = city.id
                  AND catalog.region_id = _region_id
              )
            )
          )
      ),
      geography_candidates AS MATERIALIZED (
        SELECT occurrence.id, occurrence.event_id
        FROM scoped_cities AS city
        JOIN public.events AS event ON event.city_id = city.id
        JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
        LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
        WHERE venue.city_id IS NULL
          AND occurrence.starts_at >= _from
          AND occurrence.starts_at <= _to

        UNION ALL

        SELECT occurrence.id, occurrence.event_id
        FROM scoped_cities AS city
        JOIN public.venues AS venue ON venue.city_id = city.id
        JOIN public.events AS event ON event.venue_id = venue.id
        JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
        WHERE occurrence.starts_at >= _from
          AND occurrence.starts_at <= _to
      )
      SELECT
        count(*)::BIGINT,
        count(*) FILTER (WHERE event.is_free = true)::BIGINT,
        count(*) FILTER (WHERE event.is_verified = true)::BIGINT
      FROM geography_candidates AS candidate
      JOIN public.events AS event ON event.id = candidate.event_id
      LEFT JOIN public.event_categories AS category ON category.id = event.category_id
      WHERE event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
        AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
        AND (_genres IS NULL OR event.genres && _genres)
        AND (_verified_only = false OR event.is_verified = true);
      RETURN;
    ELSE
      RETURN QUERY
      SELECT
        count(*)::BIGINT,
        count(*) FILTER (WHERE event.is_free = true)::BIGINT,
        count(*) FILTER (WHERE event.is_verified = true)::BIGINT
      FROM public.event_occurrences AS occurrence
      JOIN public.events AS event ON event.id = occurrence.event_id
      LEFT JOIN public.event_categories AS category ON category.id = event.category_id
      WHERE occurrence.starts_at >= _from
        AND occurrence.starts_at <= _to
        AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
        AND (_category_slugs IS NULL OR category.slug = ANY(_category_slugs))
        AND (_genres IS NULL OR event.genres && _genres)
        AND (_verified_only = false OR event.is_verified = true);
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH scoped_cities AS MATERIALIZED (
    SELECT city.id
    FROM public.cities AS city
    WHERE (_country_id IS NULL OR city.country_id = _country_id)
      AND (
        _region_id IS NULL
        OR city.region_id = _region_id
        OR (
          city.region_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.city_region_catalog AS catalog
            WHERE catalog.city_id = city.id
              AND catalog.region_id = _region_id
          )
        )
      )
  ),
  candidate_occurrences AS MATERIALIZED (
    -- Spatial discovery deliberately uses the occurrence GiST index, just as
    -- discover_event_rows_spatial_v2 does, instead of wrapping locations in
    -- COALESCE and forcing a worldwide scan.
    SELECT occurrence.id, occurrence.event_id
    FROM public.event_occurrences AS occurrence
    WHERE _lat IS NOT NULL
      AND _lon IS NOT NULL
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to
      AND occurrence.location IS NOT NULL
      AND public.st_dwithin(
        occurrence.location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography,
        _radius_km * 1000
      )

    UNION ALL

    -- Direct city events without a resolved venue city.
    SELECT occurrence.id, occurrence.event_id
    FROM public.events AS event
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    WHERE (_lat IS NULL OR _lon IS NULL)
      AND _city_id IS NOT NULL
      AND event.city_id = _city_id
      AND venue.city_id IS NULL
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to

    UNION ALL

    -- Venue-backed city events use venues_city_id_idx before joining events.
    SELECT occurrence.id, occurrence.event_id
    FROM public.venues AS venue
    JOIN public.events AS event ON event.venue_id = venue.id
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    WHERE (_lat IS NULL OR _lon IS NULL)
      AND _city_id IS NOT NULL
      AND venue.city_id = _city_id
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to

    UNION ALL

    -- Country/subdivision events attached directly to a city.
    SELECT occurrence.id, occurrence.event_id
    FROM scoped_cities AS city
    JOIN public.events AS event ON event.city_id = city.id
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    WHERE (_lat IS NULL OR _lon IS NULL)
      AND _city_id IS NULL
      AND (_country_id IS NOT NULL OR _region_id IS NOT NULL)
      AND venue.city_id IS NULL
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to

    UNION ALL

    -- Country/subdivision events attached through a venue.
    SELECT occurrence.id, occurrence.event_id
    FROM scoped_cities AS city
    JOIN public.venues AS venue ON venue.city_id = city.id
    JOIN public.events AS event ON event.venue_id = venue.id
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    WHERE (_lat IS NULL OR _lon IS NULL)
      AND _city_id IS NULL
      AND (_country_id IS NOT NULL OR _region_id IS NOT NULL)
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to

    UNION ALL

    -- Worldwide discovery starts from the occurrence date index.
    SELECT occurrence.id, occurrence.event_id
    FROM public.event_occurrences AS occurrence
    WHERE (_lat IS NULL OR _lon IS NULL)
      AND _city_id IS NULL
      AND _country_id IS NULL
      AND _region_id IS NULL
      AND occurrence.starts_at >= _from
      AND occurrence.starts_at <= _to
  ),
  filtered AS (
    SELECT
      event.is_free,
      event.is_verified
    FROM candidate_occurrences AS candidate
    JOIN public.event_occurrences AS occurrence ON occurrence.id = candidate.id
    JOIN public.events AS event ON event.id = candidate.event_id
    LEFT JOIN public.event_categories AS category
      ON category.id = event.category_id
      AND _category_slugs IS NOT NULL
    LEFT JOIN public.venues AS venue
      ON venue.id = event.venue_id
      AND (
        (_lat IS NOT NULL AND _lon IS NOT NULL AND _city_id IS NOT NULL)
        OR _query IS NOT NULL
        OR _capacity_unknown = true
        OR _capacity_min IS NOT NULL
        OR _capacity_max IS NOT NULL
        OR _venue_only = true
        OR _require_coordinates = true
      )
    LEFT JOIN public.cities AS resolved_city
      ON resolved_city.id = coalesce(venue.city_id, event.city_id)
      AND _require_coordinates = true
    LEFT JOIN public.event_accessibility AS accessibility
      ON accessibility.event_id = event.id
      AND _accessible_only = true
    LEFT JOIN LATERAL (
      SELECT
        min(
          CASE
            WHEN offer.is_free THEN 0::NUMERIC
            ELSE coalesce(offer.price_min, offer.price_max)
          END
        ) AS price_from,
        bool_or(
          offer.is_free
          OR (
            offer.ticket_url IS NOT NULL
            AND offer.status <> 'sold_out'::public.ticket_status
          )
        ) AS has_tickets
      FROM public.ticket_offers AS offer
      WHERE offer.event_id = event.id
        AND (
          _free_only = true
          OR _priced_only = true
          OR _price_min IS NOT NULL
          OR _price_max IS NOT NULL
          OR _tickets_only = true
        )
    ) AS offers ON true
    WHERE event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
      AND (
        _lat IS NULL
        OR _lon IS NULL
        OR _city_id IS NULL
        OR venue.city_id = _city_id
        OR (venue.city_id IS NULL AND event.city_id = _city_id)
      )
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
  )
  SELECT
    count(*)::BIGINT AS total_count,
    count(*) FILTER (WHERE is_free = true)::BIGINT AS free_count,
    count(*) FILTER (WHERE is_verified = true)::BIGINT AS verified_count
  FROM filtered;
END;
$function$;

REVOKE ALL ON FUNCTION public.discover_event_stats_v1(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.discover_event_stats_v1(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.discover_event_stats_v1(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN
) IS 'Exact occurrence counters for the active discovery filters, independent from pagination.';

NOTIFY pgrst, 'reload schema';
