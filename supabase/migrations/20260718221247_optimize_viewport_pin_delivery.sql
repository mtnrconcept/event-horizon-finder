-- Keep the exhaustive viewport response, but avoid building the rich event
-- detail graph for pins. Dynamic SQL forces a custom spatial plan for every
-- viewport instead of reusing a generic PostgREST plan, and the unordered
-- aggregate avoids a global sort that has no visual value for MapLibre.

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
  result json;
begin
  if _west not between -180 and 180
    or _east not between -180 and 180
    or _south not between -90 and 90
    or _north not between -90 and 90
    or _south >= _north
    or _from > _to
  then
    return '[]'::json;
  end if;

  execute $query$
    with indexed_occurrences as materialized (
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
        0 as approximate
      from public.event_occurrences as occurrence
      where occurrence.starts_at >= $5::timestamptz
        and occurrence.starts_at <= $6::timestamptz
        and occurrence.location is not null
        and case
          -- A geography rectangle with an exact 180-degree edge is invalid.
          -- A full-width viewport already includes every longitude. Preserve
          -- its latitude window without constructing an antipodal polygon.
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
          end as approximate
        from public.event_occurrences as occurrence
        join public.events as event on event.id = occurrence.event_id
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
    )
    select coalesce(
      json_agg(
        json_build_array(
          point.occurrence_id::text,
          round(point.longitude::numeric, 5),
          round(point.latitude::numeric, 5),
          coalesce(category.slug, ''),
          case when event.is_free then 1 else 0 end,
          point.approximate,
          event.slug
        )
      ),
      '[]'::json
    )
    from candidate_occurrences as point
    join public.events as event on event.id = point.event_id
    left join public.event_categories as category on category.id = event.category_id
    left join public.venues as venue on venue.id = event.venue_id
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
      and ($10::text[] is null or event.genres && $10::text[])
      and ($8::boolean = false or event.is_free = true or offers.price_from = 0)
      and ($13::boolean = false or event.is_free = true or offers.price_from is not null)
      and (
        $11::numeric is null
        or coalesce(offers.price_from, case when event.is_free then 0::numeric end) >= $11::numeric
      )
      and (
        $12::numeric is null
        or coalesce(offers.price_from, case when event.is_free then 0::numeric end) <= $12::numeric
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
      and ($20::boolean = false or event.venue_id is not null)
      and (
        $9::text is null
        or event.search_tsv @@ plainto_tsquery('simple', public.unaccent($9::text))
        or event.title ilike '%' || $9::text || '%'
        or venue.name ilike '%' || $9::text || '%'
      )
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
    _venue_only;

  return coalesce(result, '[]'::json);
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
) is 'Returns every filtered viewport pin through a custom spatial plan without rich detail joins or global sorting.';

notify pgrst, 'reload schema';
