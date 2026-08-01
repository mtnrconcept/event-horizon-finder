create or replace function public.discover_event_rows_spatial_v2(
  _lat double precision,
  _lon double precision,
  _radius_km numeric,
  _from timestamptz,
  _to timestamptz,
  _category_slugs text[],
  _city_id uuid,
  _free_only boolean,
  _query text,
  _genres text[],
  _price_min numeric,
  _price_max numeric,
  _priced_only boolean,
  _capacity_min integer,
  _capacity_max integer,
  _capacity_unknown boolean,
  _tickets_only boolean,
  _verified_only boolean,
  _accessible_only boolean,
  _venue_only boolean,
  _limit integer,
  _offset integer
)
returns table(
  event_id uuid,
  occurrence_id uuid,
  venue_id uuid,
  slug text,
  title text,
  short_description text,
  cover_image_url text,
  category_slug text,
  genres text[],
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  venue_name text,
  city_name text,
  is_free boolean,
  is_verified boolean,
  is_demo boolean,
  status public.event_status,
  price_from numeric,
  price_to numeric,
  has_tickets boolean,
  capacity integer,
  wheelchair boolean,
  location_precision text,
  distance_km numeric,
  latitude double precision,
  longitude double precision
)
language sql
stable
set search_path = ''
as $function$
  with dated_occurrences as materialized (
    select
      occurrence.*,
      event.city_id as event_city_id,
      event.venue_id as event_venue_id,
      venue.city_id as venue_city_id,
      venue.location as venue_location,
      venue.latitude as venue_latitude,
      venue.longitude as venue_longitude,
      resolved_city.id as resolved_city_id,
      resolved_city.location as city_location,
      resolved_city.latitude as city_latitude,
      resolved_city.longitude as city_longitude,
      coalesce(occurrence.location, venue.location, resolved_city.location) as resolved_location
    from public.event_occurrences as occurrence
    join public.events as event on event.id = occurrence.event_id
    left join public.venues as venue on venue.id = event.venue_id
    left join public.cities as resolved_city
      on resolved_city.id = coalesce(venue.city_id, event.city_id)
    where occurrence.starts_at >= _from
      and occurrence.starts_at <= _to
  ),
  nearby_occurrences as materialized (
    select occurrence.*
    from dated_occurrences as occurrence
    where occurrence.resolved_location is not null
      and public.st_dwithin(
        occurrence.resolved_location,
        public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography,
        _radius_km * 1000
      )
  )
  select
    event.id as event_id,
    occurrence.id as occurrence_id,
    venue.id as venue_id,
    event.slug,
    event.title,
    event.short_description,
    event.cover_image_url,
    category.slug as category_slug,
    coalesce(event.genres, '{}'::text[]) as genres,
    occurrence.starts_at,
    occurrence.ends_at,
    occurrence.timezone,
    venue.name as venue_name,
    resolved_city.name as city_name,
    event.is_free,
    event.is_verified,
    event.is_demo,
    event.status,
    coalesce(offers.price_from, case when event.is_free then 0::numeric end) as price_from,
    coalesce(offers.price_to, case when event.is_free then 0::numeric end) as price_to,
    (coalesce(offers.has_tickets, false) or event.is_free) as has_tickets,
    coalesce(occurrence.capacity, venue.capacity) as capacity,
    coalesce(accessibility.wheelchair, false) as wheelchair,
    case
      when occurrence.latitude is not null and occurrence.longitude is not null then 'exact'
      when venue.latitude is not null and venue.longitude is not null then 'venue'
      else 'city'
    end as location_precision,
    round((public.st_distance(
      occurrence.resolved_location,
      public.st_setsrid(public.st_makepoint(_lon, _lat), 4326)::public.geography
    ) / 1000)::numeric, 2) as distance_km,
    coalesce(occurrence.latitude, venue.latitude, resolved_city.latitude) as latitude,
    coalesce(occurrence.longitude, venue.longitude, resolved_city.longitude) as longitude
  from nearby_occurrences as occurrence
  join public.events as event on event.id = occurrence.event_id
  left join public.event_categories as category on category.id = event.category_id
  left join public.venues as venue on venue.id = event.venue_id
  left join public.cities as resolved_city
    on resolved_city.id = coalesce(venue.city_id, event.city_id)
  left join public.event_accessibility as accessibility
    on accessibility.event_id = event.id
  left join lateral (
    select
      min(
        case when offer.is_free then 0::numeric
             else coalesce(offer.price_min, offer.price_max) end
      ) as price_from,
      max(
        case when offer.is_free then 0::numeric
             else coalesce(offer.price_max, offer.price_min) end
      ) as price_to,
      bool_or(
        offer.is_free
        or (
          offer.ticket_url is not null
          and offer.status <> 'sold_out'::public.ticket_status
        )
      ) as has_tickets
    from public.ticket_offers as offer
    where offer.event_id = event.id
  ) as offers on true
  where event.status in ('published', 'cancelled', 'postponed', 'sold_out')
    and (
      _city_id is null
      or venue.city_id = _city_id
      or (venue.city_id is null and event.city_id = _city_id)
    )
    and (_category_slugs is null or category.slug = any(_category_slugs))
    and (_genres is null or (event.genres && _genres or event.search_facets && _genres))
    and (_free_only = false or event.is_free = true or offers.price_from = 0)
    and (_priced_only = false or event.is_free = true or offers.price_from is not null)
    and (
      _price_min is null
      or coalesce(offers.price_from, case when event.is_free then 0::numeric end) >= _price_min
    )
    and (
      _price_max is null
      or coalesce(offers.price_from, case when event.is_free then 0::numeric end) <= _price_max
    )
    and (_capacity_unknown = false or coalesce(occurrence.capacity, venue.capacity) is null)
    and (_capacity_min is null or coalesce(occurrence.capacity, venue.capacity) >= _capacity_min)
    and (_capacity_max is null or coalesce(occurrence.capacity, venue.capacity) <= _capacity_max)
    and (_tickets_only = false or event.is_free = true or coalesce(offers.has_tickets, false))
    and (_verified_only = false or event.is_verified = true)
    and (_accessible_only = false or accessibility.wheelchair = true)
    and (_venue_only = false or venue.id is not null)
    and (
      _query is null
      or event.search_tsv @@ plainto_tsquery('simple', public.unaccent(_query))
      or event.title ilike '%' || _query || '%'
      or venue.name ilike '%' || _query || '%'
    )
  order by occurrence.starts_at asc
  limit least(greatest(_limit, 1), 1500)
  offset greatest(_offset, 0);
$function$;

comment on function public.discover_event_rows_spatial_v2(
  double precision,
  double precision,
  numeric,
  timestamptz,
  timestamptz,
  text[],
  uuid,
  boolean,
  text,
  text[],
  numeric,
  numeric,
  boolean,
  integer,
  integer,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  integer,
  integer
) is 'Spatial event discovery using occurrence, venue, then city coordinates so city-precision events remain visible.';
