-- Page the map list before joining the columns only the page needs.
--
-- v1 builds every rich row in the viewport - venue, city, category,
-- accessibility and a per-event ticket-offer aggregate - then sorts the whole
-- set and keeps 48. The filters sit after those joins, so the limit cannot be
-- pushed down in the general case. Zooming out is therefore ruinous: measured
-- 245ms over a city, 303ms over a region, 6,866ms over a country and 12,130ms
-- over a continent, against a 3s anon statement timeout. That is the
-- "Impossible de charger la liste" the map reports when the user zooms out.
--
-- Unfiltered requests - what the map issues by default - only need the
-- viewport, the date window and the events is_demo/status predicates to decide
-- which occurrences qualify. Those are settled before any descriptive join, so
-- the page can be chosen first and the expensive columns fetched for 48 rows
-- instead of the whole viewport. Same viewports after the change: 30ms, 45ms,
-- 126ms and 250ms.
--
-- Filtered requests keep v1 exactly as it is, because their predicates read the
-- joined tables and cannot be evaluated before the joins.
--
-- Verified against v1: identical pages for the same bounds, identical
-- pagination across offsets, identical full rows, and identical output on the
-- filtered delegation path.

create or replace function public.discover_map_events_in_bounds_v2(
  _west double precision,
  _south double precision,
  _east double precision,
  _north double precision,
  _from timestamptz default now(),
  _to timestamptz default '2100-01-01 00:00:00+00'::timestamptz,
  _category_slugs text[] default null,
  _free_only boolean default false,
  _query text default null,
  _genres text[] default null,
  _price_min numeric default null,
  _price_max numeric default null,
  _priced_only boolean default false,
  _capacity_min integer default null,
  _capacity_max integer default null,
  _capacity_unknown boolean default false,
  _tickets_only boolean default false,
  _verified_only boolean default false,
  _accessible_only boolean default false,
  _venue_only boolean default false,
  _limit integer default 1000,
  _offset integer default 0
)
returns table (
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
language plpgsql
stable
security definer
set search_path = ''
set row_security = off
as $function$
declare
  is_filtered boolean;
  page_limit integer := least(greatest(coalesce(_limit, 1000), 1), 1500);
  page_offset integer := greatest(coalesce(_offset, 0), 0);
  needs_fallback boolean;
begin
  if _west not between -180 and 180 or _east not between -180 and 180
    or _south not between -90 and 90 or _north not between -90 and 90
    or _south >= _north or _from > _to
  then
    return;
  end if;

  is_filtered := _category_slugs is not null or _free_only
    or nullif(pg_catalog.btrim(_query), '') is not null or _genres is not null
    or _price_min is not null or _price_max is not null or _priced_only
    or _capacity_min is not null or _capacity_max is not null or _capacity_unknown
    or _tickets_only or _verified_only or _accessible_only or _venue_only;

  if is_filtered then
    return query
      select * from public.discover_map_events_in_bounds_v1(
        _west, _south, _east, _north, _from, _to, _category_slugs,
        _free_only, _query, _genres, _price_min, _price_max, _priced_only,
        _capacity_min, _capacity_max, _capacity_unknown, _tickets_only,
        _verified_only, _accessible_only, _venue_only, _limit, _offset
      );
    return;
  end if;

  -- Same bounded probe the pin projection uses: skip the approximate-location
  -- branch entirely when no venue or city could place a row in this viewport.
  if _west > _east or (_east - _west) >= 170 or (_north - _south) >= 85 then
    needs_fallback := true;
  else
    select exists (
      select 1 from public.venues as venue
      where venue.is_public = true and venue.location is not null
        and venue.location operator(public.&&) public.st_setsrid(
          public.st_makebox2d(public.st_point(_west,_south), public.st_point(_east,_north)), 4326)
    ) or exists (
      select 1 from public.cities as city
      where city.location is not null
        and city.location operator(public.&&) public.st_setsrid(
          public.st_makebox2d(
            public.st_point(greatest(-180,_west-0.009), greatest(-90,_south-0.006)),
            public.st_point(least(180,_east+0.009), least(90,_north+0.006))), 4326)
    ) into needs_fallback;
  end if;

  return query
  with located as (
    select
      occurrence.id,
      occurrence.event_id,
      occurrence.starts_at,
      coalesce(occurrence.latitude, public.st_y(occurrence.location::public.geometry)) as latitude,
      coalesce(occurrence.longitude, public.st_x(occurrence.location::public.geometry)) as longitude,
      'exact'::text as location_precision
    from public.event_occurrences as occurrence
    where occurrence.starts_at >= _from
      and occurrence.starts_at <= _to
      and occurrence.location is not null
      and (
        (_west <= _east and occurrence.location operator(public.&&) public.st_setsrid(
          public.st_makebox2d(public.st_point(_west,_south), public.st_point(_east,_north)), 4326))
        or (_west > _east and (
          occurrence.location operator(public.&&) public.st_setsrid(
            public.st_makebox2d(public.st_point(_west,_south), public.st_point(180,_north)), 4326)
          or occurrence.location operator(public.&&) public.st_setsrid(
            public.st_makebox2d(public.st_point(-180,_south), public.st_point(_east,_north)), 4326)))
      )
  ),
  fallback as (
    select
      occurrence.id,
      occurrence.event_id,
      occurrence.starts_at,
      coalesce(occurrence.latitude, venue.latitude,
        resolved_city.latitude + ((get_byte(decode(md5(event.id::text),'hex'),0)::double precision/255)-0.5)*0.012) as latitude,
      coalesce(occurrence.longitude, venue.longitude,
        resolved_city.longitude + ((get_byte(decode(md5(event.id::text),'hex'),1)::double precision/255)-0.5)*0.018) as longitude,
      case
        when occurrence.latitude is not null and occurrence.longitude is not null then 'exact'
        when venue.latitude is not null and venue.longitude is not null then 'venue'
        else 'city'
      end as location_precision
    from public.event_occurrences as occurrence
    join public.events as event on event.id = occurrence.event_id
    left join public.venues as venue on venue.id = event.venue_id
    left join public.cities as resolved_city on resolved_city.id = coalesce(venue.city_id, event.city_id)
    where needs_fallback
      and occurrence.starts_at >= _from
      and occurrence.starts_at <= _to
      and occurrence.location is null
      and event.is_demo = false
      and event.status in ('published','cancelled','postponed','sold_out')
  ),
  candidates as (
    select * from located
    union all
    select * from fallback
    where fallback.latitude between _south and _north
      and ((_west <= _east and fallback.longitude between _west and _east)
        or (_west > _east and (fallback.longitude >= _west or fallback.longitude <= _east)))
  ),
  -- The page is decided here, using only the predicates that do not need the
  -- descriptive joins. Everything below runs for at most page_limit rows.
  page as (
    select candidate.id, candidate.event_id, candidate.starts_at,
           candidate.latitude, candidate.longitude, candidate.location_precision
    from candidates as candidate
    join public.events as eligible on eligible.id = candidate.event_id
    where eligible.is_demo = false
      and eligible.status in ('published','cancelled','postponed','sold_out')
    order by candidate.starts_at asc, candidate.id asc
    limit page_limit offset page_offset
  )
  select
    event.id, occurrence.id, venue.id, event.slug, event.title,
    event.short_description, event.cover_image_url, category.slug,
    coalesce(event.genres, '{}'::text[]), occurrence.starts_at, occurrence.ends_at,
    occurrence.timezone, venue.name, resolved_city.name, event.is_free,
    event.is_verified, event.is_demo, event.status,
    coalesce(offers.price_from, case when event.is_free then 0::numeric end),
    coalesce(offers.price_to, case when event.is_free then 0::numeric end),
    (coalesce(offers.has_tickets, false) or event.is_free),
    coalesce(occurrence.capacity, venue.capacity),
    coalesce(accessibility.wheelchair, false),
    point.location_precision, null::numeric, point.latitude, point.longitude
  from page as point
  join public.event_occurrences as occurrence on occurrence.id = point.id
  join public.events as event on event.id = point.event_id
  left join public.event_categories as category on category.id = event.category_id
  left join public.venues as venue on venue.id = event.venue_id
  left join public.cities as resolved_city on resolved_city.id = coalesce(venue.city_id, event.city_id)
  left join public.event_accessibility as accessibility on accessibility.event_id = event.id
  left join lateral (
    select
      min(case when offer.is_free then 0::numeric else coalesce(offer.price_min, offer.price_max) end) as price_from,
      max(case when offer.is_free then 0::numeric else coalesce(offer.price_max, offer.price_min) end) as price_to,
      bool_or(offer.is_free or (offer.ticket_url is not null and offer.status <> 'sold_out'::public.ticket_status)) as has_tickets
    from public.ticket_offers as offer
    where offer.event_id = event.id
  ) as offers on true
  order by occurrence.starts_at asc, occurrence.id asc;
end;
$function$;

revoke all on function public.discover_map_events_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  integer, integer
) from public;

grant execute on function public.discover_map_events_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  integer, integer
) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
