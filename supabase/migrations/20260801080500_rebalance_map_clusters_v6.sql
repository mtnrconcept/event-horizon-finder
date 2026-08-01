-- Rebalance map density without rewriting the proven v5 query plans.
--
-- Low zooms are delegated to v5 with a lower effective zoom, which produces
-- wider grid cells and therefore fewer overlapping server clusters. From zoom
-- 12 onward, v5 receives zoom 14 and returns individual pins; the browser then
-- performs one final bounded clustering pass before revealing individual pins.

create or replace function public.discover_map_pins_in_bounds_v6(
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
  _zoom double precision default 10
)
returns json
language plpgsql
stable
security definer
set search_path = ''
set row_security = off
as $function$
declare
  result json;
  effective_zoom double precision;
begin
  effective_zoom := case
    when _zoom is null then null
    when _zoom >= 12 then 14
    else greatest(0, _zoom - 1.5)
  end;

  result := public.discover_map_pins_in_bounds_v5(
    _west,
    _south,
    _east,
    _north,
    _from,
    _to,
    _category_slugs,
    _free_only,
    _query,
    _genres,
    _price_min,
    _price_max,
    _priced_only,
    _capacity_min,
    _capacity_max,
    _capacity_unknown,
    _tickets_only,
    _verified_only,
    _accessible_only,
    _venue_only,
    effective_zoom
  );

  return (coalesce(result, '{}'::json)::jsonb || jsonb_build_object('version', 6))::json;
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v6(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;

grant execute on function public.discover_map_pins_in_bounds_v6(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v6(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Density-balanced map projection: wider low-zoom cells and earlier individual-pin handoff.';

notify pgrst, 'reload schema';
