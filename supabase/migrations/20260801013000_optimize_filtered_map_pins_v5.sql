-- Keep filtered map requests below the anonymous three-second statement timeout.
--
-- V4 is already fast for unfiltered viewports, so v5 delegates that path to v4.
-- Filtered requests start from the bounded date/viewport occurrence set, split
-- cross-table text search into indexable UNION branches, and aggregate offers
-- once instead of probing them once per event. No table, index, or source row is
-- changed. Rollback: point the client back to v4, then drop only this overload.

create or replace function public.discover_map_pins_in_bounds_v5(
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
  use_fast_path boolean;
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
      'version', 5,
      'clustered', false,
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::json
    );
  end if;

  use_fast_path := _category_slugs is null
    and _free_only = false
    and nullif(pg_catalog.btrim(_query), '') is null
    and _genres is null
    and _price_min is null
    and _price_max is null
    and _priced_only = false
    and _capacity_min is null
    and _capacity_max is null
    and _capacity_unknown = false
    and _tickets_only = false
    and _verified_only = false
    and _accessible_only = false
    and _venue_only = false;

  if use_fast_path then
    result := public.discover_map_pins_in_bounds_v4(
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
      _zoom
    );
    return (result::jsonb || jsonb_build_object('version', 5))::json;
  end if;

  -- Event-first fast path for the UI taxonomy shape (category + facet/genre).
  -- Insert after the unfiltered v4 delegation and before the generic filtered query.
  if _category_slugs is not null or _genres is not null then
    execute $taxonomy$
      with search_event_ids as materialized (
        select event.id
        from public.events as event
        where nullif(pg_catalog.btrim($9::text), '') is not null
          and event.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))

        union

        select event.id
        from public.events as event
        where nullif(pg_catalog.btrim($9::text), '') is not null
          and event.title ilike '%' || $9::text || '%'

        union

        select event.id
        from public.venues as venue
        join public.events as event on event.venue_id = venue.id
        where nullif(pg_catalog.btrim($9::text), '') is not null
          and venue.is_public = true
          and venue.name ilike '%' || $9::text || '%'
      ),
      combined_taxonomy_matches as materialized (
        select
          event.id,
          event.slug,
          event.venue_id,
          event.is_free,
          event.is_verified,
          event.category_id
        from public.events as event
        left join search_event_ids as search_match on search_match.id = event.id
        where (
            $7::text[] is null
            or event.category_id = any(
              coalesce(
                (
                  select array_agg(category.id)
                  from public.event_categories as category
                  where category.slug = any($7::text[])
                ),
                '{}'::uuid[]
              )
            )
          )
          and (
            $10::text[] is null
            or event.genres && $10::text[]
            or event.search_facets && $10::text[]
          )
          and event.is_demo = false
          and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
          and (
            nullif(pg_catalog.btrim($9::text), '') is null
            or search_match.id is not null
          )
      ),
      combined_taxonomy_events as materialized (
        select
          event.id,
          event.slug,
          event.venue_id,
          event.is_free,
          event.is_verified,
          coalesce(category.slug, '') as category_slug
        from combined_taxonomy_matches as event
        left join public.event_categories as category on category.id = event.category_id
      ),
      offer_stats as materialized (
        select
          offer.event_id,
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
        join combined_taxonomy_events as event on event.id = offer.event_id
        where $8::boolean
          or $13::boolean
          or $11::numeric is not null
          or $12::numeric is not null
          or $17::boolean
        group by offer.event_id
      ),
      eligible_events as materialized (
        select
          event.id,
          event.slug,
          event.venue_id,
          event.is_free,
          event.category_slug,
          venue.capacity as venue_capacity
        from combined_taxonomy_events as event
        left join public.venues as venue
          on venue.id = event.venue_id
         and venue.is_public = true
         and (
           $14::integer is not null
           or $15::integer is not null
           or $16::boolean is distinct from false
           or $20::boolean is distinct from false
         )
        left join offer_stats as offers on offers.event_id = event.id
        where ($8::boolean = false or event.is_free = true or offers.price_from = 0)
          and ($13::boolean = false or event.is_free = true or offers.price_from is not null)
          and (
            $11::numeric is null
            or coalesce(offers.price_from, case when event.is_free then 0::numeric end)
              >= $11::numeric
          )
          and (
            $12::numeric is null
            or coalesce(offers.price_from, case when event.is_free then 0::numeric end)
              <= $12::numeric
          )
          and (
            $17::boolean = false
            or event.is_free = true
            or coalesce(offers.has_tickets, false)
          )
          and ($18::boolean = false or event.is_verified = true)
          and (
            $19::boolean = false
            or exists (
              select 1
              from public.event_accessibility as accessibility
              where accessibility.event_id = event.id
                and accessibility.wheelchair = true
            )
          )
          and ($20::boolean = false or venue.id is not null)
      ),
      located_candidates as materialized (
        select
          occurrence.id as occurrence_id,
          occurrence.event_id,
          occurrence.capacity,
          coalesce(
            occurrence.longitude,
            public.st_x(occurrence.location::public.geometry)
          ) as longitude,
          coalesce(
            occurrence.latitude,
            public.st_y(occurrence.location::public.geometry)
          ) as latitude
        from public.event_occurrences as occurrence
        where occurrence.starts_at >= $5::timestamptz
          and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is not null
          and case
            when $1::double precision = -180
              and $2::double precision = -90
              and $3::double precision = 180
              and $4::double precision = 90
            then true
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
      unlocated_candidates as materialized (
        select
          occurrence.id as occurrence_id,
          occurrence.event_id,
          occurrence.capacity,
          occurrence.longitude,
          occurrence.latitude
        from public.event_occurrences as occurrence
        where occurrence.starts_at >= $5::timestamptz
          and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is null
      ),
      filtered_points as materialized (
        select
          candidate.occurrence_id,
          candidate.longitude,
          candidate.latitude,
          0 as approximate,
          event.slug,
          event.category_slug,
          event.is_free
        from located_candidates as candidate
        join eligible_events as event on event.id = candidate.event_id
        where (
            $16::boolean = false
            or coalesce(candidate.capacity, event.venue_capacity) is null
          )
          and (
            $14::integer is null
            or coalesce(candidate.capacity, event.venue_capacity) >= $14::integer
          )
          and (
            $15::integer is null
            or coalesce(candidate.capacity, event.venue_capacity) <= $15::integer
          )

        union all

        select
          fallback.occurrence_id,
          fallback.longitude,
          fallback.latitude,
          fallback.approximate,
          fallback.slug,
          fallback.category_slug,
          fallback.is_free
        from (
          select
            candidate.occurrence_id,
            coalesce(
              candidate.longitude,
              venue.longitude,
              resolved_city.longitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5)
                  * 0.018
            ) as longitude,
            coalesce(
              candidate.latitude,
              venue.latitude,
              resolved_city.latitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5)
                  * 0.012
            ) as latitude,
            case
              when candidate.latitude is not null and candidate.longitude is not null then 0
              when venue.latitude is not null and venue.longitude is not null then 0
              else 1
            end as approximate,
            candidate.capacity,
            event.venue_capacity,
            event.slug,
            event.category_slug,
            event.is_free
          from unlocated_candidates as candidate
          join eligible_events as event on event.id = candidate.event_id
          left join public.venues as venue
            on venue.id = event.venue_id
           and venue.is_public = true
          join public.events as fallback_event on fallback_event.id = event.id
          left join public.cities as resolved_city
            on resolved_city.id = coalesce(venue.city_id, fallback_event.city_id)
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
          and (
            $16::boolean = false
            or coalesce(fallback.capacity, fallback.venue_capacity) is null
          )
          and (
            $14::integer is null
            or coalesce(fallback.capacity, fallback.venue_capacity) >= $14::integer
          )
          and (
            $15::integer is null
            or coalesce(fallback.capacity, fallback.venue_capacity) <= $15::integer
          )
      ),
      clustered_markers as (
        select
          0 as sort_group,
          grid.cell_y as sort_y,
          grid.cell_x as sort_x,
          ''::text as sort_id,
          count(*)::integer as returned_event_count,
          json_build_array(
            'cluster',
            concat('z', floor($21::double precision)::integer, ':', grid.cell_y, ':', grid.cell_x),
            round(avg(grid.longitude)::numeric, 5),
            round(avg(grid.latitude)::numeric, 5),
            min(grid.category_slug),
            case when bool_or(grid.is_free) then 1 else 0 end,
            max(grid.approximate),
            '',
            count(*)::integer,
            count(*) filter (where grid.is_free)::integer
          ) as marker
        from (
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
          where coalesce($21::double precision < 14, false)
        ) as grid
        group by grid.cell_y, grid.cell_x
        order by grid.cell_y, grid.cell_x
        limit 8000
      ),
      individual_markers as (
        select
          1 as sort_group,
          null::integer as sort_y,
          null::integer as sort_x,
          point.occurrence_id::text as sort_id,
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
        where coalesce($21::double precision >= 14, true)
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
          count(*) filter (where point.is_free)::integer as free_count
        from filtered_points as point
      )
      select json_build_object(
        'version', 5,
        'clustered', coalesce($21::double precision < 14, false),
        'truncated', stats.total_count > coalesce(sum(markers.returned_event_count), 0),
        'total_count', stats.total_count,
        'free_count', stats.free_count,
        'pins', coalesce(
          json_agg(
            markers.marker
            order by markers.sort_group, markers.sort_y, markers.sort_x, markers.sort_id
          ) filter (where markers.marker is not null),
          '[]'::json
        )
      )
      from response_stats as stats
      left join response_markers as markers on true
      group by stats.total_count, stats.free_count
    $taxonomy$
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
        'version', 5,
        'clustered', coalesce(_zoom < 14, false),
        'truncated', false,
        'total_count', 0,
        'free_count', 0,
        'pins', '[]'::json
      )
    );
  end if;

  execute $query$
    with located_candidates as materialized (
      select
        occurrence.id as occurrence_id,
        occurrence.event_id,
        occurrence.capacity,
        coalesce(
          occurrence.longitude,
          public.st_x(occurrence.location::public.geometry)
        ) as longitude,
        coalesce(
          occurrence.latitude,
          public.st_y(occurrence.location::public.geometry)
        ) as latitude,
        0 as approximate
      from public.event_occurrences as occurrence
      where occurrence.starts_at >= $5::timestamptz
        and occurrence.starts_at <= $6::timestamptz
        and occurrence.location is not null
        and case
          when $1::double precision = -180
            and $2::double precision = -90
            and $3::double precision = 180
            and $4::double precision = 90
          then true
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
    fallback_candidates as materialized (
      select
        fallback.occurrence_id,
        fallback.event_id,
        fallback.capacity,
        fallback.longitude,
        fallback.latitude,
        fallback.approximate
      from (
        select
          occurrence.id as occurrence_id,
          occurrence.event_id,
          occurrence.capacity,
          coalesce(
            occurrence.longitude,
            venue.longitude,
            resolved_city.longitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5)
                * 0.018
          ) as longitude,
          coalesce(
            occurrence.latitude,
            venue.latitude,
            resolved_city.latitude
              + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5)
                * 0.012
          ) as latitude,
          case
            when occurrence.latitude is not null and occurrence.longitude is not null then 0
            when venue.latitude is not null and venue.longitude is not null then 0
            else 1
          end as approximate
        from public.event_occurrences as occurrence
        join public.events as event on event.id = occurrence.event_id
        left join public.venues as venue
          on venue.id = event.venue_id
         and venue.is_public = true
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
      select * from located_candidates
      union all
      select * from fallback_candidates
    ),
    candidate_event_ids as materialized (
      select distinct candidate.event_id
      from candidate_occurrences as candidate
    ),
    category_event_ids as materialized (
      select event.id
      from public.event_categories as category
      join public.events as event on event.category_id = category.id
      where $7::text[] is not null
        and category.slug = any($7::text[])
        and event.is_demo = false
        and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
    ),
    search_event_ids as materialized (
      select event.id
      from public.events as event
      where nullif(pg_catalog.btrim($9::text), '') is not null
        and event.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))

      union

      select event.id
      from public.events as event
      where nullif(pg_catalog.btrim($9::text), '') is not null
        and event.title ilike '%' || $9::text || '%'

      union

      select event.id
      from public.venues as venue
      join public.events as event on event.venue_id = venue.id
      where nullif(pg_catalog.btrim($9::text), '') is not null
        and venue.is_public = true
        and venue.name ilike '%' || $9::text || '%'
    ),
    genre_event_ids as materialized (
      select event.id
      from public.events as event
      where $10::text[] is not null
        and event.genres && $10::text[]

      union

      select event.id
      from public.events as event
      where $10::text[] is not null
        and event.search_facets && $10::text[]
    ),
    prefiltered_event_ids as materialized (
      select candidate.event_id
      from candidate_event_ids as candidate
      left join category_event_ids as category_match
        on category_match.id = candidate.event_id
      left join search_event_ids as search_match
        on search_match.id = candidate.event_id
      left join genre_event_ids as genre_match
        on genre_match.id = candidate.event_id
      where ($7::text[] is null or category_match.id is not null)
        and (
          nullif(pg_catalog.btrim($9::text), '') is null
          or search_match.id is not null
        )
        and ($10::text[] is null or genre_match.id is not null)
    ),
    offer_stats as materialized (
      select
        offer.event_id,
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
      where $8::boolean
        or $13::boolean
        or $11::numeric is not null
        or $12::numeric is not null
        or $17::boolean
      group by offer.event_id
    ),
    eligible_events as materialized (
      select
        event.id,
        event.slug,
        event.is_free,
        coalesce(category.slug, '') as category_slug,
        venue.capacity as venue_capacity
      from prefiltered_event_ids as candidate
      join public.events as event on event.id = candidate.event_id
      left join public.event_categories as category on category.id = event.category_id
      left join public.venues as venue
        on venue.id = event.venue_id
       and venue.is_public = true
       and (
         $14::integer is not null
         or $15::integer is not null
           or $16::boolean is distinct from false
           or $20::boolean is distinct from false
       )
      left join offer_stats as offers on offers.event_id = event.id
      where event.is_demo = false
        and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
        and ($8::boolean = false or event.is_free = true or offers.price_from = 0)
        and ($13::boolean = false or event.is_free = true or offers.price_from is not null)
        and (
          $11::numeric is null
          or coalesce(offers.price_from, case when event.is_free then 0::numeric end)
            >= $11::numeric
        )
        and (
          $12::numeric is null
          or coalesce(offers.price_from, case when event.is_free then 0::numeric end)
            <= $12::numeric
        )
        and (
          $17::boolean = false
          or event.is_free = true
          or coalesce(offers.has_tickets, false)
        )
        and ($18::boolean = false or event.is_verified = true)
        and (
          $19::boolean = false
          or exists (
            select 1
            from public.event_accessibility as accessibility
            where accessibility.event_id = event.id
              and accessibility.wheelchair = true
          )
        )
        and ($20::boolean = false or venue.id is not null)
    ),
    filtered_points as materialized (
      select
        candidate.occurrence_id,
        candidate.longitude,
        candidate.latitude,
        candidate.approximate,
        event.slug,
        event.category_slug,
        event.is_free
      from candidate_occurrences as candidate
      join eligible_events as event on event.id = candidate.event_id
      where (
          $16::boolean = false
          or coalesce(candidate.capacity, event.venue_capacity) is null
        )
        and (
          $14::integer is null
          or coalesce(candidate.capacity, event.venue_capacity) >= $14::integer
        )
        and (
          $15::integer is null
          or coalesce(candidate.capacity, event.venue_capacity) <= $15::integer
        )
    ),
    clustered_markers as (
      select
        0 as sort_group,
        grid.cell_y as sort_y,
        grid.cell_x as sort_x,
        ''::text as sort_id,
        count(*)::integer as returned_event_count,
        json_build_array(
          'cluster',
          concat('z', floor($21::double precision)::integer, ':', grid.cell_y, ':', grid.cell_x),
          round(avg(grid.longitude)::numeric, 5),
          round(avg(grid.latitude)::numeric, 5),
          min(grid.category_slug),
          case when bool_or(grid.is_free) then 1 else 0 end,
          max(grid.approximate),
          '',
          count(*)::integer,
          count(*) filter (where grid.is_free)::integer
        ) as marker
      from (
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
        where coalesce($21::double precision < 14, false)
      ) as grid
      group by grid.cell_y, grid.cell_x
      order by grid.cell_y, grid.cell_x
      limit 8000
    ),
    individual_markers as (
      select
        1 as sort_group,
        null::integer as sort_y,
        null::integer as sort_x,
        point.occurrence_id::text as sort_id,
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
      where coalesce($21::double precision >= 14, true)
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
        count(*) filter (where point.is_free)::integer as free_count
      from filtered_points as point
    )
    select json_build_object(
      'version', 5,
      'clustered', coalesce($21::double precision < 14, false),
      'truncated', stats.total_count > coalesce(sum(markers.returned_event_count), 0),
      'total_count', stats.total_count,
      'free_count', stats.free_count,
      'pins', coalesce(
        json_agg(
          markers.marker
          order by markers.sort_group, markers.sort_y, markers.sort_x, markers.sort_id
        )
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
      'version', 5,
      'clustered', coalesce(_zoom < 14, false),
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::json
    )
  );
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v5(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;

grant execute on function public.discover_map_pins_in_bounds_v5(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v5(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Compact zoom-aware map projection: v4 fast path plus viewport-first indexed filtered path.';

notify pgrst, 'reload schema';
