-- Zoom-aware permanent-place projection and rich list pagination.
-- Places remain independent from dated events while sharing the same viewport,
-- filtering and cluster interaction model.

create index if not exists places_of_interest_latitude_idx
  on public.places_of_interest(latitude);
create index if not exists places_of_interest_longitude_idx
  on public.places_of_interest(longitude);
create index if not exists places_of_interest_quality_idx
  on public.places_of_interest(quality_score desc, name)
  where is_public = true;

create or replace function public.discover_place_pins_in_bounds_v1(
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
      'version', 1,
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
      select place.*
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
      'version', 1,
      'clustered', true,
      'truncated', (select count(*) from clusters) >= 2500,
      'total_count', (select count(*) from filtered),
      'pins', coalesce(
        (
          select json_agg(
            json_build_object(
              'kind', 'cluster',
              'id', cluster.id,
              'name', 'Lieux regroupés',
              'slug', cluster.id,
              'category', cluster.category,
              'subcategory', null,
              'description', null,
              'address', null,
              'website', null,
              'source_url', null,
              'image_url', null,
              'opening_hours', null,
              'fee', null,
              'wheelchair', null,
              'latitude', cluster.latitude,
              'longitude', cluster.longitude,
              'quality_score', 0,
              'count', cluster.count
            )
          )
          from clusters as cluster
        ),
        '[]'::json
      )
    ) into result;
  else
    with filtered as materialized (
      select place.*
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
      'version', 1,
      'clustered', false,
      'truncated', (select count(*) from filtered) > (select count(*) from limited),
      'total_count', (select count(*) from filtered),
      'pins', coalesce(
        (
          select json_agg(
            json_build_object(
              'kind', 'place',
              'id', place.id,
              'name', place.name,
              'slug', place.slug,
              'category', place.category,
              'subcategory', place.subcategory,
              'description', place.description,
              'address', place.address,
              'website', place.website,
              'source_url', place.source_url,
              'image_url', place.image_url,
              'opening_hours', place.opening_hours,
              'fee', place.fee,
              'wheelchair', place.wheelchair,
              'latitude', place.latitude,
              'longitude', place.longitude,
              'quality_score', place.quality_score,
              'count', 1
            )
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

revoke all on function public.discover_place_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) from public;
grant execute on function public.discover_place_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) to anon, authenticated, service_role;

create or replace function public.discover_places_in_bounds_v1(
  _west double precision,
  _south double precision,
  _east double precision,
  _north double precision,
  _category_slugs text[] default null,
  _query text default null,
  _accessible_only boolean default false,
  _free_only boolean default false,
  _has_hours_only boolean default false,
  _zoom double precision default 10,
  _limit integer default 36,
  _offset integer default 0
)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = off
as $function$
  with filtered as materialized (
    select place.*
    from public.places_of_interest as place
    where _west between -180 and 180
      and _east between -180 and 180
      and _south between -90 and 90
      and _north between -90 and 90
      and _south < _north
      and place.is_public = true
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
  page as materialized (
    select place.*
    from filtered as place
    order by place.quality_score desc, place.name
    limit greatest(1, least(coalesce(_limit, 36), 200))
    offset greatest(0, coalesce(_offset, 0))
  ),
  totals as (
    select count(*)::integer as total_count from filtered
  )
  select json_build_object(
    'version', 1,
    'total_count', totals.total_count,
    'has_more', greatest(0, coalesce(_offset, 0)) + (select count(*) from page) < totals.total_count,
    'items', coalesce(
      (
        select json_agg(
          json_build_object(
            'id', place.id,
            'name', place.name,
            'slug', place.slug,
            'category', place.category,
            'subcategory', place.subcategory,
            'description', place.description,
            'address', place.address,
            'website', place.website,
            'source_url', place.source_url,
            'image_url', place.image_url,
            'opening_hours', place.opening_hours,
            'fee', place.fee,
            'wheelchair', place.wheelchair,
            'latitude', place.latitude,
            'longitude', place.longitude,
            'quality_score', place.quality_score
          )
        )
        from page as place
      ),
      '[]'::json
    )
  )
  from totals;
$function$;

revoke all on function public.discover_places_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision, integer, integer
) from public;
grant execute on function public.discover_places_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision, integer, integer
) to anon, authenticated, service_role;

comment on function public.discover_place_pins_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision
) is 'Zoom-aware place-of-interest clusters and individual pins for the visible map viewport.';

comment on function public.discover_places_in_bounds_v1(
  double precision, double precision, double precision, double precision,
  text[], text, boolean, boolean, boolean, double precision, integer, integer
) is 'Rich paginated place cards for the visible map viewport and active filters.';

notify pgrst, 'reload schema';
