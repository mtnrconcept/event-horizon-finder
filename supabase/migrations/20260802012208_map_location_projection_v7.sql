-- Keep map work proportional to visible locations rather than event rows.
--
-- v6 hands every occurrence to MapLibre from zoom 12 onward. Dense venues can
-- therefore turn a small viewport into thousands of GeoJSON features. v7
-- keeps the proven v5 predicates, uses server grid clusters below zoom 14 and
-- emits at most one marker per rounded location from zoom 14 onward. Events at
-- a grouped location are loaded through the existing paginated viewport RPC
-- only after the user selects that marker.

create or replace function public.discover_map_pins_in_bounds_v7(
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
  source_result jsonb;
  effective_zoom double precision;
  result jsonb;
begin
  effective_zoom := case
    when _zoom is null then null
    when _zoom >= 14 then 14
    else greatest(0, _zoom - 1.5)
  end;

  source_result := public.discover_map_pins_in_bounds_v5(
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
  )::jsonb;

  if coalesce(_zoom < 14, true) then
    return (
      coalesce(source_result, '{}'::jsonb)
      || jsonb_build_object(
        'version', 7,
        'clustered', true,
        'cluster_mode', 'grid'
      )
    )::json;
  end if;

  with source_markers as materialized (
    select marker
    from jsonb_array_elements(coalesce(source_result -> 'pins', '[]'::jsonb)) as source(marker)
    where jsonb_typeof(marker) = 'array'
      and jsonb_array_length(marker) = 10
      and marker ->> 0 = 'event'
  ), normalized_markers as materialized (
    select
      marker,
      round((marker ->> 2)::numeric, 5) as longitude,
      round((marker ->> 3)::numeric, 5) as latitude,
      marker ->> 4 as category_slug,
      (marker ->> 5)::integer as is_free,
      (marker ->> 6)::integer as approximate,
      (marker ->> 9)::integer as free_count
    from source_markers
  ), location_markers as (
    select
      longitude,
      latitude,
      count(*)::integer as event_count,
      case
        when count(*) = 1 then (array_agg(marker order by marker ->> 1))[1]
        else jsonb_build_array(
          'cluster',
          concat('location:', longitude, ':', latitude),
          longitude,
          latitude,
          min(category_slug),
          max(is_free),
          max(approximate),
          '',
          count(*)::integer,
          sum(free_count)::integer
        )
      end as marker
    from normalized_markers
    group by longitude, latitude
  )
  select jsonb_build_object(
    'version', 7,
    'clustered', true,
    'cluster_mode', 'location',
    'truncated', coalesce((source_result ->> 'truncated')::boolean, false),
    'total_count', coalesce((source_result ->> 'total_count')::integer, 0),
    'free_count', coalesce((source_result ->> 'free_count')::integer, 0),
    'pins', coalesce(
      jsonb_agg(marker order by latitude, longitude),
      '[]'::jsonb
    )
  )
  into result
  from location_markers;

  return coalesce(
    result,
    jsonb_build_object(
      'version', 7,
      'clustered', true,
      'cluster_mode', 'location',
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::jsonb
    )
  )::json;
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v7(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;

grant execute on function public.discover_map_pins_in_bounds_v7(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v7(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Zoom-aware map projection with one terminal marker per rounded location and on-demand event details.';

notify pgrst, 'reload schema';
