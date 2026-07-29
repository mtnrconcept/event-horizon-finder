-- Keep pre-v2 clients functional while the updated service worker purges stale
-- application shells. The legacy response remains an array of seven-value
-- event pins, but is deterministic and bounded instead of exhaustive.

create or replace function public.discover_map_pins_in_bounds_v1(
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
  _venue_only boolean default false
)
returns json
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v2_payload jsonb;
  legacy_payload jsonb;
begin
  v2_payload := public.discover_map_pins_in_bounds_v2(
    _west => _west,
    _south => _south,
    _east => _east,
    _north => _north,
    _from => _from,
    _to => _to,
    _category_slugs => _category_slugs,
    _free_only => _free_only,
    _query => _query,
    _genres => _genres,
    _price_min => _price_min,
    _price_max => _price_max,
    _priced_only => _priced_only,
    _capacity_min => _capacity_min,
    _capacity_max => _capacity_max,
    _capacity_unknown => _capacity_unknown,
    _tickets_only => _tickets_only,
    _verified_only => _verified_only,
    _accessible_only => _accessible_only,
    _venue_only => _venue_only,
    _zoom => 8
  )::jsonb;

  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        marker.pin ->> 1,
        marker.pin -> 2,
        marker.pin -> 3,
        marker.pin ->> 4,
        marker.pin -> 5,
        marker.pin -> 6,
        marker.pin ->> 7
      )
      order by marker.ordinality
    ),
    '[]'::jsonb
  )
  into legacy_payload
  from jsonb_array_elements(coalesce(v2_payload -> 'pins', '[]'::jsonb))
    with ordinality as marker(pin, ordinality)
  where marker.pin ->> 0 = 'event'
    and marker.ordinality <= 4000;

  return legacy_payload::json;
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean
) from public;
grant execute on function public.discover_map_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean
) is 'Compatibility endpoint for pre-v2 clients. Returns at most 4,000 deterministic legacy event pins through the bounded v2 query.';

notify pgrst, 'reload schema';
