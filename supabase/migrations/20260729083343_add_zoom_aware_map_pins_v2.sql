-- Bound map responses by viewport and zoom. Low zooms return deterministic
-- server-side grid aggregates; close zooms return individual occurrences.
-- v1 remains available as an immediate application rollback target.

create or replace function public.discover_map_pins_in_bounds_v2(
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
security invoker
set search_path = ''
as $function$
declare
  result json;
begin
  if _west not between -180 and 180
    or _east not between -180 and 180
    or _south not between -90 and 90
    or _north not between -90 and 90
    or _south >= _north
    or _from > _to
    or _zoom not between 0 and 22
  then
    return json_build_object(
      'version', 2,
      'clustered', false,
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::json
    );
  end if;

  execute $query$
    with published_events as not materialized (
      select
        event.id,
        event.slug,
        event.category_id,
        event.venue_id,
        event.city_id,
        event.is_free,
        event.is_verified,
        event.genres,
        event.search_tsv,
        event.title
      from public.events as event
      where event.is_demo = false
        and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
    ),
    indexed_occurrences as materialized (
      select
        occurrence.id as occurrence_id,
        occurrence.event_id,
        occurrence.capacity,
        coalesce(
          occurrence.latitude,
          public.st_y(occurrence.location::public.geometry)
        ) as latitude,
        coalesce(
          occurrence.longitude,
          public.st_x(occurrence.location::public.geometry)
        ) as longitude,
        0 as approximate,
        event.slug,
        event.category_id,
        event.venue_id,
        event.is_free,
        event.is_verified,
        event.genres,
        event.search_tsv,
        event.title
      from public.event_occurrences as occurrence
      join published_events as event on event.id = occurrence.event_id
      where occurrence.starts_at >= $5::timestamptz
        and occurrence.starts_at <= $6::timestamptz
        and occurrence.location is not null
        and case
          when $1::double precision = -180 and $3::double precision = 180 then
            public.st_y(occurrence.location::public.geometry)
              between $2::double precision and $4::double precision
          when $1::double precision <= $3::double precision then
            occurrence.location operator(public.&&) public.st_setsrid(
              public.st_makebox2d(
                public.st_point($1::double precision, $2::double precision),
                public.st_point($3::double precision, $4::double precision)
              ),
              4326
            )
          else
            occurrence.location operator(public.&&) public.st_setsrid(
              public.st_makebox2d(
                public.st_point($1::double precision, $2::double precision),
                public.st_point(180, $4::double precision)
              ),
              4326
            )
            or occurrence.location operator(public.&&) public.st_setsrid(
              public.st_makebox2d(
                public.st_point(-180, $2::double precision),
                public.st_point($3::double precision, $4::double precision)
              ),
              4326
            )
        end
    ),
    fallback_points as materialized (
      select fallback.*
      from (
        select
          occurrence.id as occurrence_id,
          occurrence.event_id,
          occurrence.capacity,
          coalesce(
            occurrence.latitude,
            venue.latitude,
            resolved_city.latitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5)
                * 0.012
          ) as latitude,
          coalesce(
            occurrence.longitude,
            venue.longitude,
            resolved_city.longitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5)
                * 0.018
          ) as longitude,
          case
            when occurrence.latitude is not null and occurrence.longitude is not null then 0
            when venue.latitude is not null and venue.longitude is not null then 0
            else 1
          end as approximate,
          event.slug,
          event.category_id,
          event.venue_id,
          event.is_free,
          event.is_verified,
          event.genres,
          event.search_tsv,
          event.title
        from public.event_occurrences as occurrence
        join published_events as event on event.id = occurrence.event_id
        left join public.venues as venue on venue.id = event.venue_id
        left join public.cities as resolved_city
          on resolved_city.id = coalesce(venue.city_id, event.city_id)
        where occurrence.starts_at >= $5::timestamptz
          and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is null
      ) as fallback
      where fallback.latitude between $2::double precision and $4::double precision
        and (
          (
            $1::double precision <= $3::double precision
            and fallback.longitude between $1::double precision and $3::double precision
          )
          or (
            $1::double precision > $3::double precision
            and (
              fallback.longitude >= $1::double precision
              or fallback.longitude <= $3::double precision
            )
          )
        )
    ),
    candidate_occurrences as materialized (
      select * from indexed_occurrences
      union all
      select * from fallback_points
    ),
    filtered_points as materialized (
      select
        point.occurrence_id,
        point.event_id,
        point.longitude,
        point.latitude,
        point.approximate,
        point.slug,
        coalesce(category.slug, '') as category_slug,
        point.is_free
      from candidate_occurrences as point
      left join public.event_categories as category on category.id = point.category_id
      left join public.venues as venue on venue.id = point.venue_id
      left join lateral (
        select
          min(
            case
              when offer.is_free then 0::numeric
              else coalesce(offer.price_min, offer.price_max)
            end
          ) as price_from,
          bool_or(
            offer.is_free
            or (
              offer.ticket_url is not null
              and offer.status <> 'sold_out'::public.ticket_status
            )
          ) as has_tickets
        from public.ticket_offers as offer
        where offer.event_id = point.event_id
      ) as offers on (
        $8::boolean
        or $13::boolean
        or $11::numeric is not null
        or $12::numeric is not null
        or $17::boolean
      )
      where ($7::text[] is null or category.slug = any($7::text[]))
        and ($10::text[] is null or point.genres && $10::text[])
        and ($8::boolean = false or point.is_free = true or offers.price_from = 0)
        and ($13::boolean = false or point.is_free = true or offers.price_from is not null)
        and (
          $11::numeric is null
          or coalesce(offers.price_from, case when point.is_free then 0::numeric end)
            >= $11::numeric
        )
        and (
          $12::numeric is null
          or coalesce(offers.price_from, case when point.is_free then 0::numeric end)
            <= $12::numeric
        )
        and (
          $16::boolean = false
          or coalesce(point.capacity, venue.capacity) is null
        )
        and (
          $14::integer is null
          or coalesce(point.capacity, venue.capacity) >= $14::integer
        )
        and (
          $15::integer is null
          or coalesce(point.capacity, venue.capacity) <= $15::integer
        )
        and (
          $17::boolean = false
          or point.is_free = true
          or coalesce(offers.has_tickets, false)
        )
        and ($18::boolean = false or point.is_verified = true)
        and (
          $19::boolean = false
          or exists (
            select 1
            from public.event_accessibility as accessibility
            where accessibility.event_id = point.event_id
              and accessibility.wheelchair = true
          )
        )
        and ($20::boolean = false or point.venue_id is not null)
        and (
          $9::text is null
          or point.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))
          or point.title ilike '%' || $9::text || '%'
          or venue.name ilike '%' || $9::text || '%'
        )
    ),
    grid_points as materialized (
      select
        point.*,
        floor(
          (point.longitude + 180)
          / (360 / power(2::numeric, floor($21::double precision)::integer + 4))
        )::integer as cell_x,
        floor(
          (point.latitude + 90)
          / (180 / power(2::numeric, floor($21::double precision)::integer + 3))
        )::integer as cell_y
      from filtered_points as point
      where $21::double precision < 8
    ),
    clustered_markers as (
      select
        0 as sort_group,
        concat(cell_y, ':', cell_x) as sort_key,
        count(*)::integer as returned_event_count,
        json_build_array(
          'cluster',
          concat('z', floor($21::double precision)::integer, ':', cell_y, ':', cell_x),
          round(avg(longitude)::numeric, 5),
          round(avg(latitude)::numeric, 5),
          min(category_slug),
          case when bool_or(is_free) then 1 else 0 end,
          max(approximate),
          '',
          count(*)::integer,
          count(*) filter (where is_free)::integer
        ) as marker
      from grid_points
      group by cell_y, cell_x
      order by cell_y, cell_x
      limit 8000
    ),
    individual_markers as (
      select
        1 as sort_group,
        point.occurrence_id::text as sort_key,
        1 as returned_event_count,
        json_build_array(
          'event',
          point.occurrence_id::text,
          round(point.longitude::numeric, 5),
          round(point.latitude::numeric, 5),
          point.category_slug,
          case when point.is_free then 1 else 0 end,
          point.approximate,
          point.slug,
          1,
          case when point.is_free then 1 else 0 end
        ) as marker
      from filtered_points as point
      where $21::double precision >= 8
      order by point.occurrence_id
      limit 12000
    ),
    response_markers as materialized (
      select * from clustered_markers
      union all
      select * from individual_markers
    ),
    response_stats as (
      select
        count(*)::integer as total_count,
        count(*) filter (where is_free)::integer as free_count
      from filtered_points
    )
    select json_build_object(
      'version', 2,
      'clustered', $21::double precision < 8,
      'truncated', stats.total_count > coalesce(sum(markers.returned_event_count), 0),
      'total_count', stats.total_count,
      'free_count', stats.free_count,
      'pins', coalesce(
        json_agg(markers.marker order by markers.sort_group, markers.sort_key)
          filter (where markers.marker is not null),
        '[]'::json
      )
    )
    from response_stats as stats
    left join response_markers as markers on true
    group by stats.total_count, stats.free_count
  $query$
  into result
  using
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
    _zoom;

  return coalesce(
    result,
    json_build_object(
      'version', 2,
      'clustered', _zoom < 8,
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::json
    )
  );
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;
grant execute on function public.discover_map_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v2(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Returns zoom-aware bounded map markers: server grid aggregates below zoom 8 and deterministic individual pins at close zooms.';

notify pgrst, 'reload schema';
