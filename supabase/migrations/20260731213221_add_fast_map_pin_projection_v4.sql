-- Keep the public map projection below the anon three-second statement timeout.
--
-- Unfiltered viewport requests are by far the hottest path.  They only need
-- occurrence coordinates and the compact pin fields, so do not materialize
-- the wide event/search columns or evaluate ticket/accessibility subqueries.
-- Filtered requests retain the complete v3 contract, including the newer
-- search-facet taxonomy.  Both paths derive counts and markers from a single
-- scan of their compact point set.
-- Rollback is immediate: point the client back to v3, then drop only this v4
-- overload after traffic has drained.  v3 and all source data remain intact.

create or replace function public.discover_map_pins_in_bounds_v4(
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
      'version', 4,
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

  if use_fast_path and _zoom < 14 then
    execute $query$
      with points as not materialized (
        select
          coalesce(
            occurrence.longitude,
            public.st_x(occurrence.location::public.geometry)
          ) as longitude,
          coalesce(
            occurrence.latitude,
            public.st_y(occurrence.location::public.geometry)
          ) as latitude,
          0 as approximate,
          coalesce(category.slug, '') as category_slug,
          event.is_free
        from public.event_occurrences as occurrence
        join public.events as event on event.id = occurrence.event_id
        left join public.event_categories as category on category.id = event.category_id
        where event.is_demo = false
          and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
          and occurrence.starts_at >= $5::timestamptz
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

        union all

        select
          fallback.longitude,
          fallback.latitude,
          fallback.approximate,
          fallback.category_slug,
          fallback.is_free
        from (
          select
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
            end as approximate,
            coalesce(category.slug, '') as category_slug,
            event.is_free
          from public.event_occurrences as occurrence
          join public.events as event on event.id = occurrence.event_id
          left join public.event_categories as category on category.id = event.category_id
          left join public.venues as venue
            on venue.id = event.venue_id
           and venue.is_public = true
          left join public.cities as resolved_city
            on resolved_city.id = coalesce(venue.city_id, event.city_id)
          where event.is_demo = false
            and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
            and occurrence.starts_at >= $5::timestamptz
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
      cells as (
        select
          floor(
            (point.longitude + 180)
            / (360 / power(2::numeric, floor($7::double precision)::integer + 4))
          )::integer as cell_x,
          floor(
            (point.latitude + 90)
            / (180 / power(2::numeric, floor($7::double precision)::integer + 3))
          )::integer as cell_y,
          count(*)::integer as event_count,
          count(*) filter (where point.is_free)::integer as free_count,
          round(avg(point.longitude)::numeric, 5) as longitude,
          round(avg(point.latitude)::numeric, 5) as latitude,
          min(point.category_slug) as category_slug,
          bool_or(point.is_free) as has_free,
          max(point.approximate) as approximate
        from points as point
        group by cell_y, cell_x
      ),
      ranked_cells as (
        select
          cell.*,
          row_number() over (order by cell.cell_y, cell.cell_x) as marker_rank,
          count(*) over () as marker_count,
          sum(cell.event_count) over () as total_count,
          sum(cell.free_count) over () as total_free_count
        from cells as cell
      )
      select json_build_object(
        'version', 4,
        'clustered', true,
        'truncated', coalesce(max(marker_count), 0) > 8000,
        'total_count', coalesce(max(total_count), 0),
        'free_count', coalesce(max(total_free_count), 0),
        'pins', coalesce(
          json_agg(
            json_build_array(
              'cluster',
              concat('z', floor($7::double precision)::integer, ':', cell_y, ':', cell_x),
              longitude,
              latitude,
              category_slug,
              case when has_free then 1 else 0 end,
              approximate,
              '',
              event_count,
              free_count
            )
            order by marker_rank
          ) filter (where marker_rank <= 8000),
          '[]'::json
        )
      )
      from ranked_cells
    $query$
    into result
    using _west, _south, _east, _north, _from, _to, _zoom;

  elsif use_fast_path then
    execute $query$
      with points as not materialized (
        select
          occurrence.id as occurrence_id,
          coalesce(
            occurrence.longitude,
            public.st_x(occurrence.location::public.geometry)
          ) as longitude,
          coalesce(
            occurrence.latitude,
            public.st_y(occurrence.location::public.geometry)
          ) as latitude,
          0 as approximate,
          event.slug,
          coalesce(category.slug, '') as category_slug,
          event.is_free
        from public.event_occurrences as occurrence
        join public.events as event on event.id = occurrence.event_id
        left join public.event_categories as category on category.id = event.category_id
        where event.is_demo = false
          and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
          and occurrence.starts_at >= $5::timestamptz
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
            occurrence.id as occurrence_id,
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
            end as approximate,
            event.slug,
            coalesce(category.slug, '') as category_slug,
            event.is_free
          from public.event_occurrences as occurrence
          join public.events as event on event.id = occurrence.event_id
          left join public.event_categories as category on category.id = event.category_id
          left join public.venues as venue
            on venue.id = event.venue_id
           and venue.is_public = true
          left join public.cities as resolved_city
            on resolved_city.id = coalesce(venue.city_id, event.city_id)
          where event.is_demo = false
            and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
            and occurrence.starts_at >= $5::timestamptz
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
      ranked_points as (
        select
          point.*,
          row_number() over (order by point.occurrence_id) as marker_rank,
          count(*) over () as total_count,
          count(*) filter (where point.is_free) over () as total_free_count
        from points as point
      )
      select json_build_object(
        'version', 4,
        'clustered', false,
        'truncated', coalesce(max(total_count), 0) > 12000,
        'total_count', coalesce(max(total_count), 0),
        'free_count', coalesce(max(total_free_count), 0),
        'pins', coalesce(
          json_agg(
            json_build_array(
              'event',
              occurrence_id::text,
              round(longitude::numeric, 5),
              round(latitude::numeric, 5),
              category_slug,
              case when is_free then 1 else 0 end,
              approximate,
              slug,
              1,
              case when is_free then 1 else 0 end
            )
            order by marker_rank
          ) filter (where marker_rank <= 12000),
          '[]'::json
        )
      )
      from ranked_points
    $query$
    into result
    using _west, _south, _east, _north, _from, _to;

  elsif _zoom < 14 then
    execute $query$
      with eligible_events as materialized (
        select
          event.id,
          event.city_id,
          event.is_free,
          coalesce(category.slug, '') as category_slug,
          venue.capacity as venue_capacity,
          venue.latitude as venue_latitude,
          venue.longitude as venue_longitude,
          venue.city_id as venue_city_id
        from public.events as event
        left join public.event_categories as category on category.id = event.category_id
        left join public.venues as venue
          on venue.id = event.venue_id
         and venue.is_public = true
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
          where offer.event_id = event.id
        ) as offers on (
          $8::boolean
          or $13::boolean
          or $11::numeric is not null
          or $12::numeric is not null
          or $17::boolean
        )
        where event.is_demo = false
          and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
          and ($7::text[] is null or category.slug = any($7::text[]))
          and (
            $10::text[] is null
            or event.genres && $10::text[]
            or event.search_facets && $10::text[]
          )
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
          and (
            nullif(pg_catalog.btrim($9::text), '') is null
            or event.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))
            or event.title ilike '%' || $9::text || '%'
            or venue.name ilike '%' || $9::text || '%'
          )
      ),
      points as not materialized (
        select
          coalesce(
            occurrence.longitude,
            public.st_x(occurrence.location::public.geometry)
          ) as longitude,
          coalesce(
            occurrence.latitude,
            public.st_y(occurrence.location::public.geometry)
          ) as latitude,
          0 as approximate,
          event.category_slug,
          event.is_free
        from public.event_occurrences as occurrence
        join eligible_events as event on event.id = occurrence.event_id
        where occurrence.starts_at >= $5::timestamptz
          and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is not null
          and ($16::boolean = false or coalesce(occurrence.capacity, event.venue_capacity) is null)
          and ($14::integer is null or coalesce(occurrence.capacity, event.venue_capacity) >= $14::integer)
          and ($15::integer is null or coalesce(occurrence.capacity, event.venue_capacity) <= $15::integer)
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

        union all

        select
          fallback.longitude,
          fallback.latitude,
          fallback.approximate,
          fallback.category_slug,
          fallback.is_free
        from (
          select
            coalesce(
              occurrence.longitude,
              event.venue_longitude,
              resolved_city.longitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5)
                  * 0.018
            ) as longitude,
            coalesce(
              occurrence.latitude,
              event.venue_latitude,
              resolved_city.latitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5)
                  * 0.012
            ) as latitude,
            case
              when occurrence.latitude is not null and occurrence.longitude is not null then 0
              when event.venue_latitude is not null and event.venue_longitude is not null then 0
              else 1
            end as approximate,
            event.category_slug,
            event.is_free
          from public.event_occurrences as occurrence
          join eligible_events as event on event.id = occurrence.event_id
          left join public.cities as resolved_city
            on resolved_city.id = coalesce(event.venue_city_id, event.city_id)
          where occurrence.starts_at >= $5::timestamptz
            and occurrence.starts_at <= $6::timestamptz
            and occurrence.location is null
            and ($16::boolean = false or coalesce(occurrence.capacity, event.venue_capacity) is null)
            and ($14::integer is null or coalesce(occurrence.capacity, event.venue_capacity) >= $14::integer)
            and ($15::integer is null or coalesce(occurrence.capacity, event.venue_capacity) <= $15::integer)
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
      cells as (
        select
          floor(
            (point.longitude + 180)
            / (360 / power(2::numeric, floor($21::double precision)::integer + 4))
          )::integer as cell_x,
          floor(
            (point.latitude + 90)
            / (180 / power(2::numeric, floor($21::double precision)::integer + 3))
          )::integer as cell_y,
          count(*)::integer as event_count,
          count(*) filter (where point.is_free)::integer as free_count,
          round(avg(point.longitude)::numeric, 5) as longitude,
          round(avg(point.latitude)::numeric, 5) as latitude,
          min(point.category_slug) as category_slug,
          bool_or(point.is_free) as has_free,
          max(point.approximate) as approximate
        from points as point
        group by cell_y, cell_x
      ),
      ranked_cells as (
        select
          cell.*,
          row_number() over (order by cell.cell_y, cell.cell_x) as marker_rank,
          count(*) over () as marker_count,
          sum(cell.event_count) over () as total_count,
          sum(cell.free_count) over () as total_free_count
        from cells as cell
      )
      select json_build_object(
        'version', 4,
        'clustered', true,
        'truncated', coalesce(max(marker_count), 0) > 8000,
        'total_count', coalesce(max(total_count), 0),
        'free_count', coalesce(max(total_free_count), 0),
        'pins', coalesce(
          json_agg(
            json_build_array(
              'cluster',
              concat('z', floor($21::double precision)::integer, ':', cell_y, ':', cell_x),
              longitude,
              latitude,
              category_slug,
              case when has_free then 1 else 0 end,
              approximate,
              '',
              event_count,
              free_count
            )
            order by marker_rank
          ) filter (where marker_rank <= 8000),
          '[]'::json
        )
      )
      from ranked_cells
    $query$
    into result
    using
      _west, _south, _east, _north, _from, _to, _category_slugs, _free_only,
      _query, _genres, _price_min, _price_max, _priced_only, _capacity_min,
      _capacity_max, _capacity_unknown, _tickets_only, _verified_only,
      _accessible_only, _venue_only, _zoom;

  else
    execute $query$
      with eligible_events as materialized (
        select
          event.id,
          event.slug,
          event.city_id,
          event.is_free,
          coalesce(category.slug, '') as category_slug,
          venue.capacity as venue_capacity,
          venue.latitude as venue_latitude,
          venue.longitude as venue_longitude,
          venue.city_id as venue_city_id
        from public.events as event
        left join public.event_categories as category on category.id = event.category_id
        left join public.venues as venue
          on venue.id = event.venue_id
         and venue.is_public = true
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
          where offer.event_id = event.id
        ) as offers on (
          $8::boolean
          or $13::boolean
          or $11::numeric is not null
          or $12::numeric is not null
          or $17::boolean
        )
        where event.is_demo = false
          and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
          and ($7::text[] is null or category.slug = any($7::text[]))
          and (
            $10::text[] is null
            or event.genres && $10::text[]
            or event.search_facets && $10::text[]
          )
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
          and (
            nullif(pg_catalog.btrim($9::text), '') is null
            or event.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))
            or event.title ilike '%' || $9::text || '%'
            or venue.name ilike '%' || $9::text || '%'
          )
      ),
      points as not materialized (
        select
          occurrence.id as occurrence_id,
          coalesce(
            occurrence.longitude,
            public.st_x(occurrence.location::public.geometry)
          ) as longitude,
          coalesce(
            occurrence.latitude,
            public.st_y(occurrence.location::public.geometry)
          ) as latitude,
          0 as approximate,
          event.slug,
          event.category_slug,
          event.is_free
        from public.event_occurrences as occurrence
        join eligible_events as event on event.id = occurrence.event_id
        where occurrence.starts_at >= $5::timestamptz
          and occurrence.starts_at <= $6::timestamptz
          and occurrence.location is not null
          and ($16::boolean = false or coalesce(occurrence.capacity, event.venue_capacity) is null)
          and ($14::integer is null or coalesce(occurrence.capacity, event.venue_capacity) >= $14::integer)
          and ($15::integer is null or coalesce(occurrence.capacity, event.venue_capacity) <= $15::integer)
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
            occurrence.id as occurrence_id,
            coalesce(
              occurrence.longitude,
              event.venue_longitude,
              resolved_city.longitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 1)::double precision / 255) - 0.5)
                  * 0.018
            ) as longitude,
            coalesce(
              occurrence.latitude,
              event.venue_latitude,
              resolved_city.latitude
                + ((get_byte(decode(md5(event.id::text), 'hex'), 0)::double precision / 255) - 0.5)
                  * 0.012
            ) as latitude,
            case
              when occurrence.latitude is not null and occurrence.longitude is not null then 0
              when event.venue_latitude is not null and event.venue_longitude is not null then 0
              else 1
            end as approximate,
            event.slug,
            event.category_slug,
            event.is_free
          from public.event_occurrences as occurrence
          join eligible_events as event on event.id = occurrence.event_id
          left join public.cities as resolved_city
            on resolved_city.id = coalesce(event.venue_city_id, event.city_id)
          where occurrence.starts_at >= $5::timestamptz
            and occurrence.starts_at <= $6::timestamptz
            and occurrence.location is null
            and ($16::boolean = false or coalesce(occurrence.capacity, event.venue_capacity) is null)
            and ($14::integer is null or coalesce(occurrence.capacity, event.venue_capacity) >= $14::integer)
            and ($15::integer is null or coalesce(occurrence.capacity, event.venue_capacity) <= $15::integer)
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
      ranked_points as (
        select
          point.*,
          row_number() over (order by point.occurrence_id) as marker_rank,
          count(*) over () as total_count,
          count(*) filter (where point.is_free) over () as total_free_count
        from points as point
      )
      select json_build_object(
        'version', 4,
        'clustered', false,
        'truncated', coalesce(max(total_count), 0) > 12000,
        'total_count', coalesce(max(total_count), 0),
        'free_count', coalesce(max(total_free_count), 0),
        'pins', coalesce(
          json_agg(
            json_build_array(
              'event',
              occurrence_id::text,
              round(longitude::numeric, 5),
              round(latitude::numeric, 5),
              category_slug,
              case when is_free then 1 else 0 end,
              approximate,
              slug,
              1,
              case when is_free then 1 else 0 end
            )
            order by marker_rank
          ) filter (where marker_rank <= 12000),
          '[]'::json
        )
      )
      from ranked_points
    $query$
    into result
    using
      _west, _south, _east, _north, _from, _to, _category_slugs, _free_only,
      _query, _genres, _price_min, _price_max, _priced_only, _capacity_min,
      _capacity_max, _capacity_unknown, _tickets_only, _verified_only,
      _accessible_only, _venue_only;
  end if;

  return coalesce(
    result,
    json_build_object(
      'version', 4,
      'clustered', _zoom < 14,
      'truncated', false,
      'total_count', 0,
      'free_count', 0,
      'pins', '[]'::json
    )
  );
end;
$function$;

revoke all on function public.discover_map_pins_in_bounds_v4(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) from public;
grant execute on function public.discover_map_pins_in_bounds_v4(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) to anon, authenticated, service_role;

comment on function public.discover_map_pins_in_bounds_v4(
  double precision, double precision, double precision, double precision,
  timestamptz, timestamptz, text[], boolean, text, text[], numeric, numeric,
  boolean, integer, integer, boolean, boolean, boolean, boolean, boolean,
  double precision
) is 'Compact public zoom-aware map projection. Uses a narrow unfiltered fast path, preserves search facets on filtered requests, and derives markers and counts from one point scan.';

notify pgrst, 'reload schema';
