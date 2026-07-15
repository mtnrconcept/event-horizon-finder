-- Normalize the geographic hierarchy already present in the worldwide import,
-- then expose country / subdivision / city filters through one non-overloaded
-- discovery RPC. Pagination remains unbounded across successive calls while
-- every individual response stays small enough for browsers and PostgREST.
-- Applied to production as migration 20260715020659.

CREATE UNIQUE INDEX IF NOT EXISTS regions_country_name_ci_uidx
  ON public.regions(country_id, lower(name));

-- Updating administrative metadata must not rebuild PostGIS points. Coordinates
-- stay synchronized on inserts and whenever latitude / longitude actually change.
DROP TRIGGER IF EXISTS trg_city_loc ON public.cities;
CREATE TRIGGER trg_city_loc
BEFORE INSERT OR UPDATE OF latitude, longitude ON public.cities
FOR EACH ROW EXECUTE FUNCTION public.sync_location_from_latlon();

DO $block$
BEGIN
  IF to_regclass('public.eventscrap') IS NOT NULL THEN
    EXECUTE $sql$
      WITH region_signals AS (
        SELECT
          upper(trim(country_code)) AS country_code,
          lower(public.unaccent(trim(region))) AS region_key,
          trim(region) AS region_name,
          count(*) AS signal_count
        FROM public.eventscrap
        WHERE country_code ~ '^[A-Za-z]{2}$'
          AND nullif(trim(region), '') IS NOT NULL
          AND lower(trim(region)) NOT IN ('nan', 'none', 'null', 'unknown', 'n/a')
          AND length(trim(region)) <= 120
        GROUP BY 1, 2, 3
      ),
      canonical_regions AS (
        SELECT DISTINCT ON (country_code, region_key)
          country_code,
          region_key,
          region_name
        FROM region_signals
        ORDER BY country_code, region_key, signal_count DESC, region_name
      )
      INSERT INTO public.regions(country_id, name)
      SELECT country.id, canonical.region_name
      FROM canonical_regions AS canonical
      JOIN public.countries AS country ON country.code = canonical.country_code
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.regions AS existing
        WHERE existing.country_id = country.id
          AND lower(public.unaccent(existing.name)) = canonical.region_key
      )
      ON CONFLICT DO NOTHING
    $sql$;

    IF to_regclass('public.city_region_catalog') IS NULL THEN
      EXECUTE $sql$
      CREATE TABLE public.city_region_catalog AS
      WITH city_region_signals AS (
        SELECT
          upper(trim(country_code)) AS country_code,
          lower(public.unaccent(trim(city))) AS city_key,
          lower(public.unaccent(trim(region))) AS region_key,
          count(*) AS signal_count
        FROM public.eventscrap
        WHERE country_code ~ '^[A-Za-z]{2}$'
          AND nullif(trim(city), '') IS NOT NULL
          AND nullif(trim(region), '') IS NOT NULL
          AND lower(trim(city)) NOT IN ('nan', 'none', 'null', 'unknown', 'n/a')
          AND lower(trim(region)) NOT IN ('nan', 'none', 'null', 'unknown', 'n/a')
          AND length(trim(city)) <= 160
          AND length(trim(region)) <= 120
        GROUP BY 1, 2, 3
      ),
      ranked_signals AS (
        SELECT
          signal.*,
          row_number() OVER (
            PARTITION BY signal.country_code, signal.city_key
            ORDER BY signal.signal_count DESC, signal.region_key
          ) AS rank
        FROM city_region_signals AS signal
      )
      SELECT
        city.id AS city_id,
        region.id AS region_id,
        'eventscrap'::TEXT AS source,
        now() AS updated_at
      FROM ranked_signals AS signal
      JOIN public.countries AS country ON country.code = signal.country_code
      JOIN public.regions AS region
        ON region.country_id = country.id
       AND lower(public.unaccent(region.name)) = signal.region_key
      JOIN public.cities AS city
        ON city.country_id = country.id
       AND lower(public.unaccent(city.name)) = signal.city_key
      WHERE signal.rank = 1
      $sql$;
    END IF;
  END IF;
END;
$block$;

-- Keep the schema valid even on installations without the optional import
-- staging table. On populated projects, the CTAS above avoids thousands of
-- row-level foreign-key checks during the initial catalogue build.
CREATE TABLE IF NOT EXISTS public.city_region_catalog (
  city_id UUID NOT NULL,
  region_id UUID NOT NULL,
  source TEXT NOT NULL DEFAULT 'eventscrap',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.city_region_catalog
  ALTER COLUMN city_id SET NOT NULL,
  ALTER COLUMN region_id SET NOT NULL,
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN source SET DEFAULT 'eventscrap',
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now();

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.city_region_catalog'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.city_region_catalog
      ADD CONSTRAINT city_region_catalog_pkey PRIMARY KEY (city_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.city_region_catalog'::regclass
      AND conname = 'city_region_catalog_city_id_fkey'
  ) THEN
    ALTER TABLE public.city_region_catalog
      ADD CONSTRAINT city_region_catalog_city_id_fkey
      FOREIGN KEY (city_id) REFERENCES public.cities(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.city_region_catalog'::regclass
      AND conname = 'city_region_catalog_region_id_fkey'
  ) THEN
    ALTER TABLE public.city_region_catalog
      ADD CONSTRAINT city_region_catalog_region_id_fkey
      FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE NOT VALID;
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS city_region_catalog_region_idx
  ON public.city_region_catalog(region_id, city_id);

CREATE INDEX IF NOT EXISTS cities_country_region_catalog_idx
  ON public.cities(country_id, region_id, name, id);

ALTER TABLE public.city_region_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS city_region_catalog_public_read
  ON public.city_region_catalog;
CREATE POLICY city_region_catalog_public_read
  ON public.city_region_catalog
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON TABLE public.city_region_catalog TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_geography_cities(
  _limit INTEGER DEFAULT 1000,
  _offset INTEGER DEFAULT 0
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
  WHERE city.is_demo = false
  ORDER BY city.name, city.id
  LIMIT least(greatest(coalesce(_limit, 1000), 1), 1000)
  OFFSET greatest(coalesce(_offset, 0), 0);
$function$;

REVOKE ALL ON FUNCTION public.list_geography_cities(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_geography_cities(INTEGER, INTEGER)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.discover_venues_geography_v1(
  _country_id UUID DEFAULT NULL,
  _region_id UUID DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _limit INTEGER DEFAULT 1000,
  _offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  slug TEXT,
  name TEXT,
  address TEXT,
  capacity INTEGER,
  is_verified BOOLEAN,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  city_id UUID,
  city_name TEXT,
  city_latitude DOUBLE PRECISION,
  city_longitude DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT
    venue.id,
    venue.slug,
    venue.name,
    venue.address,
    venue.capacity,
    venue.is_verified,
    venue.latitude,
    venue.longitude,
    city.id AS city_id,
    city.name AS city_name,
    city.latitude AS city_latitude,
    city.longitude AS city_longitude
  FROM public.venues AS venue
  JOIN public.cities AS city ON city.id = venue.city_id
  LEFT JOIN public.city_region_catalog AS catalog ON catalog.city_id = city.id
  WHERE venue.is_public = true
    AND venue.is_demo = false
    AND (_country_id IS NULL OR city.country_id = _country_id)
    AND (_region_id IS NULL OR coalesce(city.region_id, catalog.region_id) = _region_id)
    AND (_city_id IS NULL OR city.id = _city_id)
  ORDER BY venue.name, venue.id
  LIMIT least(greatest(coalesce(_limit, 1000), 1), 1000)
  OFFSET greatest(coalesce(_offset, 0), 0);
$function$;

REVOKE ALL ON FUNCTION public.discover_venues_geography_v1(
  UUID, UUID, UUID, INTEGER, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_venues_geography_v1(
  UUID, UUID, UUID, INTEGER, INTEGER
) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.discover_event_rows_geography_v3(
  _from TIMESTAMPTZ,
  _to TIMESTAMPTZ,
  _category_slugs TEXT[],
  _country_id UUID,
  _region_id UUID,
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
AS $function$
  WITH scoped_cities AS MATERIALIZED (
    SELECT city.id
    FROM public.cities AS city
    LEFT JOIN public.city_region_catalog AS catalog ON catalog.city_id = city.id
    WHERE (_country_id IS NULL OR city.country_id = _country_id)
      AND (_region_id IS NULL OR coalesce(city.region_id, catalog.region_id) = _region_id)
  ),
  geographic_events AS MATERIALIZED (
    SELECT event.id
    FROM public.events AS event
    JOIN scoped_cities AS city ON city.id = event.city_id
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    WHERE venue.city_id IS NULL

    UNION ALL

    SELECT event.id
    FROM public.venues AS venue
    JOIN scoped_cities AS city ON city.id = venue.city_id
    JOIN public.events AS event ON event.venue_id = venue.id
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
  FROM geographic_events AS scoped
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
        OR (
          offer.ticket_url IS NOT NULL
          AND offer.status <> 'sold_out'::public.ticket_status
        )
      ) AS has_tickets
    FROM public.ticket_offers AS offer
    WHERE offer.event_id = event.id
  ) AS offers ON true
  WHERE event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
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
  ORDER BY occurrence.starts_at ASC, occurrence.id ASC
  LIMIT least(greatest(_limit, 1), 1500)
  OFFSET greatest(_offset, 0);
$function$;

REVOKE ALL ON FUNCTION public.discover_event_rows_geography_v3(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, UUID, BOOLEAN, TEXT, TEXT[],
  NUMERIC, NUMERIC, BOOLEAN, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.discover_event_rows_geography_v3(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, UUID, BOOLEAN, TEXT, TEXT[],
  NUMERIC, NUMERIC, BOOLEAN, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN,
  BOOLEAN, BOOLEAN, BOOLEAN, INT, INT
) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN, INTEGER,
  INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
);

CREATE FUNCTION public.discover_events(
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
  _limit INTEGER DEFAULT 40,
  _offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  event_id UUID, occurrence_id UUID, venue_id UUID, slug TEXT, title TEXT,
  short_description TEXT, cover_image_url TEXT, category_slug TEXT,
  genres TEXT[], starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, timezone TEXT,
  venue_name TEXT, city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN,
  is_demo BOOLEAN, status public.event_status, price_from NUMERIC,
  price_to NUMERIC, has_tickets BOOLEAN, capacity INTEGER, wheelchair BOOLEAN,
  location_precision TEXT, distance_km NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY
    SELECT
      row.event_id, row.occurrence_id, row.venue_id, row.slug, row.title,
      row.short_description, row.cover_image_url, row.category_slug, row.genres,
      row.starts_at, row.ends_at, row.timezone, row.venue_name, row.city_name,
      row.is_free, row.is_verified, row.is_demo, row.status, row.price_from,
      row.price_to, row.has_tickets, row.capacity, row.wheelchair,
      row.location_precision, row.distance_km
    FROM public.discover_event_rows_spatial_v2(
      _lat, _lon, _radius_km, _from, _to, _category_slugs, _city_id,
      _free_only, _query, _genres, _price_min, _price_max, _priced_only,
      _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
      _verified_only, _accessible_only, _venue_only, _limit, _offset
    ) AS row;
  ELSIF _city_id IS NOT NULL THEN
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
  ELSIF _country_id IS NOT NULL OR _region_id IS NOT NULL THEN
    RETURN QUERY
    SELECT
      row.event_id, row.occurrence_id, row.venue_id, row.slug, row.title,
      row.short_description, row.cover_image_url, row.category_slug, row.genres,
      row.starts_at, row.ends_at, row.timezone, row.venue_name, row.city_name,
      row.is_free, row.is_verified, row.is_demo, row.status, row.price_from,
      row.price_to, row.has_tickets, row.capacity, row.wheelchair,
      row.location_precision, row.distance_km
    FROM public.discover_event_rows_geography_v3(
      _from, _to, _category_slugs, _country_id, _region_id, _free_only,
      _query, _genres, _price_min, _price_max, _priced_only, _capacity_min,
      _capacity_max, _capacity_unknown, _tickets_only, _verified_only,
      _accessible_only, _venue_only, false, _limit, _offset
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
$function$;

REVOKE ALL ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN, INTEGER,
  INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
);

CREATE FUNCTION public.discover_map_events(
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
  _limit INTEGER DEFAULT 1000,
  _offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  event_id UUID, occurrence_id UUID, venue_id UUID, slug TEXT, title TEXT,
  short_description TEXT, cover_image_url TEXT, category_slug TEXT,
  genres TEXT[], starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, timezone TEXT,
  venue_name TEXT, city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN,
  is_demo BOOLEAN, status public.event_status, price_from NUMERIC,
  price_to NUMERIC, has_tickets BOOLEAN, capacity INTEGER, wheelchair BOOLEAN,
  location_precision TEXT, distance_km NUMERIC, latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF _lat IS NOT NULL AND _lon IS NOT NULL THEN
    RETURN QUERY
    SELECT * FROM public.discover_event_rows_spatial_v2(
      _lat, _lon, _radius_km, _from, _to, _category_slugs, _city_id,
      _free_only, _query, _genres, _price_min, _price_max, _priced_only,
      _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
      _verified_only, _accessible_only, _venue_only, _limit, _offset
    );
  ELSIF _city_id IS NOT NULL THEN
    RETURN QUERY
    SELECT * FROM public.discover_event_rows_city_filtered_v2(
      _from, _to, _category_slugs, _city_id, _free_only, _query, _genres,
      _price_min, _price_max, _priced_only, _capacity_min, _capacity_max,
      _capacity_unknown, _tickets_only, _verified_only, _accessible_only,
      _venue_only, true, _limit, _offset
    );
  ELSIF _country_id IS NOT NULL OR _region_id IS NOT NULL THEN
    RETURN QUERY
    SELECT * FROM public.discover_event_rows_geography_v3(
      _from, _to, _category_slugs, _country_id, _region_id, _free_only,
      _query, _genres, _price_min, _price_max, _priced_only, _capacity_min,
      _capacity_max, _capacity_unknown, _tickets_only, _verified_only,
      _accessible_only, _venue_only, true, _limit, _offset
    );
  ELSE
    RETURN QUERY
    SELECT * FROM public.discover_event_rows_v2(
      _lat, _lon, _radius_km, _from, _to, _category_slugs, _city_id,
      _free_only, _query, _genres, _price_min, _price_max, _priced_only,
      _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
      _verified_only, _accessible_only, _venue_only, true, _limit, _offset
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) IS 'Paginated event discovery with country, subdivision and city filters.';

COMMENT ON FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, UUID, UUID, BOOLEAN, TEXT, TEXT[], NUMERIC, NUMERIC, BOOLEAN,
  INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, INTEGER, INTEGER
) IS 'Paginated map discovery with country, subdivision and city filters.';
