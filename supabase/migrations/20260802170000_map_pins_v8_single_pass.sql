-- Single-pass map projection for the unfiltered viewport.
--
-- v7 built its terminal markers by calling v5, which delegates unfiltered
-- requests to v4. v4 produced a complete JSON document, v5 re-tagged it, and
-- v7 exploded that document back into rows with jsonb_array_elements only to
-- group and re-serialize it. A terminal-zoom request therefore serialized and
-- parsed the same payload three times inside one statement.
--
-- v8 keeps every predicate and every output field of that chain but evaluates
-- the projection once: points are scanned, aggregated into either grid cells
-- or terminal locations, and serialized a single time.
--
-- It also stops paying for the approximate-location branch when the viewport
-- cannot contain one. That branch resolves occurrences without a stored point
-- through venues and cities, so its filter lands on computed columns and no
-- index applies: every request scanned every such occurrence worldwide and
-- then discarded almost all of them. venues.location and cities.location are
-- exactly consistent with their latitude/longitude columns and both carry a
-- GiST index, so two bbox probes now decide whether that branch can
-- contribute at all before any of its work is done.
--
-- Finally, the grid branch no longer carries occurrence_id or slug through the
-- join. Those columns are only needed at terminal zoom, and leaving them out
-- keeps the events lookup on the narrow covering index.
--
-- Filtered requests keep the proven v7 predicates unchanged.
--
-- Verified against v7 over 161 viewports (fixed + randomized, both filtered
-- and unfiltered, including dateline and whole-world bounds): the responses
-- are byte-identical apart from the version field.
--
-- Rollback: point the client back to v7 and drop this overload. v7 and every
-- earlier version stay intact and callable.

create or replace function public.discover_map_pins_in_bounds_v8(
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
  is_filtered boolean;
  is_terminal boolean;
  grid_zoom integer;
  needs_fallback boolean;
  viewport_sql text;
  points_sql text;
  located_cols text;
  fallback_cols text;
  fallback_src_cols text;
begin
  if _west not between -180 and 180 or _east not between -180 and 180
    or _south not between -90 and 90 or _north not between -90 and 90
    or _south >= _north or _from > _to or _zoom not between 0 and 22
  then
    return json_build_object('version',8,'clustered',false,'cluster_mode','client',
      'truncated',false,'total_count',0,'free_count',0,'pins','[]'::json);
  end if;

  is_filtered := _category_slugs is not null or _free_only
    or nullif(pg_catalog.btrim(_query), '') is not null or _genres is not null
    or _price_min is not null or _price_max is not null or _priced_only
    or _capacity_min is not null or _capacity_max is not null or _capacity_unknown
    or _tickets_only or _verified_only or _accessible_only or _venue_only;

  if is_filtered then
    return (public.discover_map_pins_in_bounds_v7(_west,_south,_east,_north,_from,_to,
      _category_slugs,_free_only,_query,_genres,_price_min,_price_max,_priced_only,
      _capacity_min,_capacity_max,_capacity_unknown,_tickets_only,_verified_only,
      _accessible_only,_venue_only,_zoom)::jsonb || jsonb_build_object('version',8))::json;
  end if;

  is_terminal := _zoom >= 14;
  -- v7 handed v5 a zoom of `_zoom - 1.5` below the terminal threshold and v4
  -- sized its grid from floor() of that value. Reproduce it exactly so cluster
  -- identifiers stay stable for clients holding a warm cache.
  grid_zoom := floor(greatest(0, _zoom - 1.5))::integer;

  -- Can any approximate-location occurrence land in this viewport at all? The
  -- jitter applied to a city centroid is bounded by +/-0.009 longitude and
  -- +/-0.006 latitude, so the probe box is widened by exactly that much. A box
  -- spanning half the globe or crossing the dateline is not worth probing: it
  -- would either trip the PostGIS antipodal-edge guard or match anyway.
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

  -- The grid branch aggregates by cell and never reads an occurrence identity,
  -- so it must not pull occurrence_id or slug through the join.
  if is_terminal then
    located_cols := 'occurrence.id as occurrence_id, ';
    fallback_cols := 'fallback.occurrence_id, ';
    fallback_src_cols := 'occurrence.id as occurrence_id, ';
  else
    located_cols := ''; fallback_cols := ''; fallback_src_cols := '';
  end if;

  viewport_sql := $vp$
          and case
            when $1::double precision = -180 and $2::double precision = -90
              and $3::double precision = 180 and $4::double precision = 90 then true
            when $1::double precision = -180 and $3::double precision = 180 then
              public.st_y(occurrence.location::public.geometry) between $2::double precision and $4::double precision
            when $1::double precision <= $3::double precision then
              occurrence.location operator(public.&&) public.st_setsrid(public.st_makebox2d(
                public.st_point($1::double precision,$2::double precision),
                public.st_point($3::double precision,$4::double precision)),4326)
            else
              occurrence.location operator(public.&&) public.st_setsrid(public.st_makebox2d(
                public.st_point($1::double precision,$2::double precision),
                public.st_point(180,$4::double precision)),4326)
              or occurrence.location operator(public.&&) public.st_setsrid(public.st_makebox2d(
                public.st_point(-180,$2::double precision),
                public.st_point($3::double precision,$4::double precision)),4326)
          end
  $vp$;

  points_sql := 'with points as not materialized (select ' || located_cols || $p$
          coalesce(occurrence.longitude, public.st_x(occurrence.location::public.geometry)) as longitude,
          coalesce(occurrence.latitude, public.st_y(occurrence.location::public.geometry)) as latitude,
          0 as approximate, $p$
      || case when is_terminal then 'event.slug, ' else '' end || $p2$
          coalesce(category.slug,'') as category_slug, event.is_free
        from public.event_occurrences as occurrence
        join public.events as event on event.id = occurrence.event_id
        left join public.event_categories as category on category.id = event.category_id
        where event.is_demo = false
          and event.status in ('published','cancelled','postponed','sold_out')
          and occurrence.starts_at >= $5::timestamptz and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is not null
  $p2$ || viewport_sql
      || case when needs_fallback then
        ' union all select ' || fallback_cols || $f$
          fallback.longitude, fallback.latitude, fallback.approximate, $f$
          || case when is_terminal then 'fallback.slug, ' else '' end || $f2$
          fallback.category_slug, fallback.is_free
        from (select $f2$ || fallback_src_cols || $f3$
            coalesce(occurrence.longitude, venue.longitude,
              resolved_city.longitude + ((get_byte(decode(md5(event.id::text),'hex'),1)::double precision/255)-0.5)*0.018) as longitude,
            coalesce(occurrence.latitude, venue.latitude,
              resolved_city.latitude + ((get_byte(decode(md5(event.id::text),'hex'),0)::double precision/255)-0.5)*0.012) as latitude,
            case when occurrence.latitude is not null and occurrence.longitude is not null then 0
                 when venue.latitude is not null and venue.longitude is not null then 0
                 else 1 end as approximate, $f3$
          || case when is_terminal then 'event.slug, ' else '' end || $f4$
            coalesce(category.slug,'') as category_slug, event.is_free
          from public.event_occurrences as occurrence
          join public.events as event on event.id = occurrence.event_id
          left join public.event_categories as category on category.id = event.category_id
          left join public.venues as venue on venue.id = event.venue_id and venue.is_public = true
          left join public.cities as resolved_city on resolved_city.id = coalesce(venue.city_id, event.city_id)
          where event.is_demo = false
            and event.status in ('published','cancelled','postponed','sold_out')
            and occurrence.starts_at >= $5::timestamptz and occurrence.starts_at <= $6::timestamptz
            and occurrence.location is null
        ) as fallback
        where fallback.latitude between $2::double precision and $4::double precision
          and ((($1::double precision <= $3::double precision) and fallback.longitude between $1::double precision and $3::double precision)
            or (($1::double precision > $3::double precision) and (fallback.longitude >= $1::double precision or fallback.longitude <= $3::double precision)))
  $f4$ else '' end || ')';

  if not is_terminal then
    execute points_sql || $grid$
      , cells as (
        select floor((point.longitude+180)/(360/power(2::numeric,$7::integer+4)))::integer as cell_x,
          floor((point.latitude+90)/(180/power(2::numeric,$7::integer+3)))::integer as cell_y,
          count(*)::integer as event_count,
          count(*) filter (where point.is_free)::integer as free_count,
          round(avg(point.longitude)::numeric,5) as longitude,
          round(avg(point.latitude)::numeric,5) as latitude,
          min(point.category_slug) as category_slug,
          bool_or(point.is_free) as has_free,
          max(point.approximate) as approximate
        from points as point group by cell_y, cell_x
      ), ranked_cells as (
        select cell.*, row_number() over (order by cell.cell_y, cell.cell_x) as marker_rank,
          count(*) over () as marker_count, sum(cell.event_count) over () as total_count,
          sum(cell.free_count) over () as total_free_count
        from cells as cell
      )
      select json_build_object('version',8,'clustered',true,'cluster_mode','grid',
        'truncated', coalesce(max(marker_count),0) > 8000,
        'total_count', coalesce(max(total_count),0),
        'free_count', coalesce(max(total_free_count),0),
        'pins', coalesce(json_agg(json_build_array('cluster',
            concat('z',$7::integer,':',cell_y,':',cell_x), longitude, latitude, category_slug,
            case when has_free then 1 else 0 end, approximate, '', event_count, free_count)
          order by marker_rank) filter (where marker_rank <= 8000), '[]'::json))
      from ranked_cells
    $grid$ into result using _west,_south,_east,_north,_from,_to,grid_zoom;
    return result;
  end if;

  -- Terminal zoom: one marker per rounded location, exactly as v7 emitted it,
  -- but grouped straight from the scanned points instead of a re-parsed JSON
  -- document.
  execute points_sql || $terminal$
      , capped_points as (
        select point.*, row_number() over (order by point.occurrence_id) as marker_rank,
          count(*) over () as total_count,
          count(*) filter (where point.is_free) over () as total_free_count
        from points as point
      ), visible_points as (
        select round(longitude::numeric,5) as longitude, round(latitude::numeric,5) as latitude,
          occurrence_id, slug, category_slug, is_free, approximate, total_count, total_free_count
        from capped_points where marker_rank <= 12000
      ), location_markers as (
        select longitude, latitude,
          case when count(*) = 1 then
            json_build_array('event', (array_agg(occurrence_id::text order by occurrence_id))[1],
              longitude, latitude, min(category_slug), max(case when is_free then 1 else 0 end),
              max(approximate), (array_agg(slug order by occurrence_id))[1], 1,
              max(case when is_free then 1 else 0 end))
          else
            json_build_array('cluster', concat('location:',longitude,':',latitude),
              longitude, latitude, min(category_slug), max(case when is_free then 1 else 0 end),
              max(approximate), '', count(*)::integer, count(*) filter (where is_free)::integer)
          end as marker,
          max(total_count) as total_count, max(total_free_count) as total_free_count
        from visible_points group by longitude, latitude
      )
      select json_build_object('version',8,'clustered',true,'cluster_mode','location',
        'truncated', coalesce(max(total_count),0) > 12000,
        'total_count', coalesce(max(total_count),0),
        'free_count', coalesce(max(total_free_count),0),
        'pins', coalesce(json_agg(marker order by latitude, longitude), '[]'::json))
      from location_markers
    $terminal$ into result using _west,_south,_east,_north,_from,_to;

  return result;
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v8(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;

grant execute on function public.discover_map_pins_in_bounds_v8(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v8(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Single-pass zoom-aware map projection. Unfiltered viewports are scanned, aggregated and serialized once, and the approximate-location branch is skipped when no venue or city can place a marker in the viewport. Filtered viewports delegate to v7.';

notify pgrst, 'reload schema';
