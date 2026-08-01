-- Keep interactive map reads responsive while worldwide ingestion continues.
--
-- 1. Place pins now return only the fields needed by MapLibre. Rich content is
--    fetched by get_place_detail_v1 only after the user selects an individual
--    place.
-- 2. The two legacy EventScrap import jobs remain continuous but use smaller,
--    staggered batches so they no longer monopolize I/O during map requests.

create or replace function public.discover_place_pins_in_bounds_v2(
  _west double precision,
  _south double precision,
  _east double precision,
  _north double precision,
  _category_slugs text[] default null,
  _query text default null,
  _accessible_only boolean default false,
  _free_only boolean default false,
  _has_hours_only boolean default false,
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
  cell_longitude double precision;
  cell_latitude double precision;
begin
  if _west not between -180 and 180
    or _east not between -180 and 180
    or _south not between -90 and 90
    or _north not between -90 and 90
    or _south >= _north
    or _zoom not between 0 and 22
  then
    return json_build_object(
      'version', 2,
      'clustered', false,
      'truncated', false,
      'total_count', 0,
      'pins', '[]'::json
    );
  end if;

  if _zoom < 12 then
    cell_longitude := 180.0 / power(2.0, greatest(0.0, least(11.0, floor(_zoom))));
    cell_latitude := 90.0 / power(2.0, greatest(0.0, least(11.0, floor(_zoom))));

    with filtered as materialized (
      select
        place.id,
        place.name,
        place.category,
        place.latitude,
        place.longitude
      from public.places_of_interest as place
      where place.is_public = true
        and place.latitude between _south and _north
        and (
          (_west <= _east and place.longitude between _west and _east)
          or (_west > _east and (place.longitude >= _west or place.longitude <= _east))
        )
        and (_category_slugs is null or place.category = any(_category_slugs))
        and (
          nullif(pg_catalog.btrim(_query), '') is null
          or place.name ilike '%' || pg_catalog.btrim(_query) || '%'
          or coalesce(place.description, '') ilike '%' || pg_catalog.btrim(_query) || '%'
          or coalesce(place.address, '') ilike '%' || pg_catalog.btrim(_query) || '%'
        )
        and (
          _accessible_only = false
          or lower(coalesce(place.wheelchair, '')) = any(array['yes', 'limited', 'designated'])
        )
        and (
          _free_only = false
          or lower(pg_catalog.btrim(coalesce(place.fee, ''))) ~ '^(0|false|free|gratuit|gratuito|kostenlos|no)$'
        )
        and (_has_hours_only = false or place.opening_hours is not null)
    ),
    gridded as materialized (
      select
        floor((place.longitude + 180.0) / cell_longitude)::bigint as grid_x,
        floor((place.latitude + 90.0) / cell_latitude)::bigint as grid_y,
        place.*
      from filtered as place
    ),
    clusters as materialized (
      select
        md5(grid_x::text || ':' || grid_y::text) as id,
        avg(longitude)::double precision as longitude,
        avg(latitude)::double precision as latitude,
        case when count(distinct category) = 1 then min(category) else 'mixed' end as category,
        count(*)::integer as count
      from gridded
      group by grid_x, grid_y
      order by count(*) desc
      limit 2500
    )
    select json_build_object(
      'version', 2,
      'clustered', true,
      'truncated', (select count(*) from clusters) >= 2500,
      'total_count', (select count(*) from filtered),
      'pins', coalesce(
        (
          select json_agg(
            json_build_array(
              'cluster',
              cluster.id,
              cluster.longitude,
              cluster.latitude,
              cluster.category,
              cluster.count,
              'Lieux regroupés'
            )
          )
          from clusters as cluster
        ),
        '[]'::json
      )
    ) into result;
  else
    with filtered as materialized (
      select
        place.id,
        place.name,
        place.category,
        place.latitude,
        place.longitude,
        place.quality_score
      from public.places_of_interest as place
      where place.is_public = true
        and place.latitude between _south and _north
        and (
          (_west <= _east and place.longitude between _west and _east)
          or (_west > _east and (place.longitude >= _west or place.longitude <= _east))
        )
        and (_category_slugs is null or place.category = any(_category_slugs))
        and (
          nullif(pg_catalog.btrim(_query), '') is null
          or place.name ilike '%' || pg_catalog.btrim(_query) || '%'
          or coalesce(place.description, '') ilike '%' || pg_catalog.btrim(_query) || '%'
          or coalesce(place.address, '') ilike '%' || pg_catalog.btrim(_query) || '%'
        )
        and (
          _accessible_only = false
          or lower(coalesce(place.wheelchair, '')) = any(array['yes', 'limited', 'designated'])
        )
        and (
          _free_only = false
          or lower(pg_catalog.btrim(coalesce(place.fee, ''))) ~ '^(0|false|free|gratuit|gratuito|kostenlos|no)$'
        )
        and (_has_hours_only = false or place.opening_hours is not null)
    ),
    limited as materialized (
      select place.*
      from filtered as place
      order by place.quality_score desc, place.name
      limit 2500
    )
    select json_build_object(
      'version', 2,
      'clustered', false,
      'truncated', (select count(*) from filtered) > (select count(*) from limited),
      'total_count', (select count(*) from filtered),
      'pins', coalesce(
        (
          select json_agg(
            json_build_array(
              'place',
              place.id::text,
              place.longitude,
              place.latitude,
              place.category,
              1,
              place.name
            )
            order by place.quality_score desc, place.name
          )
          from limited as place
        ),
        '[]'::json
      )
    ) into result;
  end if;

  return result;
end;
$function$;

revoke all on function public.discover_place_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) from public;
grant execute on function public.discover_place_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) to anon, authenticated, service_role;

comment on function public.discover_place_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) is 'Compact zoom-aware place pins. Rich place content is intentionally loaded on demand.';

do $block$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname in ('eventscrap-events-import', 'eventscrap-occurrences-import')
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'eventscrap-events-import',
    '1-59/6 * * * *',
    $cron$select private.run_eventscrap_events_import_guarded_v1(500);$cron$
  );

  perform cron.schedule(
    'eventscrap-occurrences-import',
    '4-59/6 * * * *',
    $cron$select private.run_eventscrap_occurrences_import_guarded_v1(1000);$cron$
  );
end;
$block$;

notify pgrst, 'reload schema';
