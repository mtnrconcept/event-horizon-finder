-- Keep the spatial fast path indexed and bounded. Do not resolve every
-- coordinate-less event through its city centroid: that can concentrate large
-- result sets on one point and freeze map interactions.
--
-- La Décadanse occurrences for the current local day are assigned their city
-- coordinates only when no occurrence or venue position exists. The normal
-- spatial RPC can then include them without changing its query plan.

update public.event_occurrences as occurrence
set latitude = city.latitude,
    longitude = city.longitude,
    location = public.st_setsrid(
      public.st_makepoint(city.longitude, city.latitude),
      4326
    )::public.geography,
    updated_at = now()
from public.events as event
join public.cities as city on city.id = event.city_id
left join public.venues as venue on venue.id = event.venue_id
where occurrence.event_id = event.id
  and occurrence.location is null
  and venue.location is null
  and occurrence.local_start_date = (now() at time zone coalesce(occurrence.timezone, city.timezone, 'Europe/Zurich'))::date
  and event.official_url ilike '%ladecadanse.ch/%'
  and city.latitude is not null
  and city.longitude is not null;

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
) is 'Indexed spatial event discovery; coordinate-less events are not expanded through unbounded city-centroid fallbacks.';
