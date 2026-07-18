create index if not exists event_occurrences_map_window_idx
  on public.event_occurrences (starts_at, id)
  include (event_id);

create index if not exists events_public_map_cover_idx
  on public.events (id)
  include (category_id, venue_id, city_id, is_free, slug)
  where is_demo = false
    and status in ('published', 'cancelled', 'postponed', 'sold_out');

-- Covers the events lookup performed by the public event_occurrences RLS
-- policy. Without the id in the index, an anonymous world query has to read
-- the wide events heap before it can return any occurrence.
create index if not exists events_public_status_id_idx
  on public.events (status, id);

drop function if exists public.discover_all_map_pins_v1(timestamptz, timestamptz);

create function public.discover_all_map_pins_v1(
  _from timestamptz default now(),
  _to timestamptz default now() + interval '365 days'
)
returns json
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  result json;
begin
  -- Dynamic execution produces a custom plan for the requested time window.
  -- A cached generic plan crosses Supabase's anonymous statement timeout on
  -- the worldwide data set even though the custom plan completes quickly.
  execute $query$
    select coalesce(
      json_agg(
        json_build_array(
          occurrence.id::text,
          round(coalesce(
            occurrence.longitude,
            venue.longitude,
            resolved_city.longitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5) * 0.018
          )::numeric, 5),
          round(coalesce(
            occurrence.latitude,
            venue.latitude,
            resolved_city.latitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5) * 0.012
          )::numeric, 5),
          coalesce(category.slug, ''),
          case when event.is_free then 1 else 0 end,
          case
            when occurrence.latitude is not null and occurrence.longitude is not null then 0
            when venue.latitude is not null and venue.longitude is not null then 0
            else 1
          end,
          event.slug
        )
      ),
      '[]'::json
    )
    from public.event_occurrences as occurrence
    join public.events as event on event.id = occurrence.event_id
    left join public.event_categories as category on category.id = event.category_id
    left join public.venues as venue on venue.id = event.venue_id
    left join public.cities as resolved_city
      on resolved_city.id = coalesce(venue.city_id, event.city_id)
    where event.status in ('published', 'cancelled', 'postponed', 'sold_out')
      and event.is_demo = false
      and occurrence.starts_at >= $1
      and occurrence.starts_at <= $2
      and coalesce(occurrence.latitude, venue.latitude, resolved_city.latitude) is not null
      and coalesce(occurrence.longitude, venue.longitude, resolved_city.longitude) is not null
  $query$
  into result
  using _from, _to;

  return result;
end;
$function$;

revoke all on function public.discover_all_map_pins_v1(timestamptz, timestamptz) from public;
grant execute on function public.discover_all_map_pins_v1(timestamptz, timestamptz)
  to anon, authenticated, service_role;

comment on function public.discover_all_map_pins_v1(timestamptz, timestamptz)
  is 'Returns every public map pin in one compact JSON response, without PostgREST row pagination.';

notify pgrst, 'reload schema';
