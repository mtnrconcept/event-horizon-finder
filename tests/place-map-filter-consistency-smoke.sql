begin;

insert into public.countries (id, code, name)
values ('10000000-0000-4000-8000-000000000001', 'ZZ', 'Map filter smoke country')
on conflict (code) do update set name = excluded.name;

insert into public.cities (
  id,
  country_id,
  slug,
  name,
  timezone,
  latitude,
  longitude
)
values (
  '10000000-0000-4000-8000-000000000002',
  (select id from public.countries where code = 'ZZ'),
  'map-filter-smoke-city',
  'Map filter smoke city',
  'Europe/Zurich',
  46.20,
  6.14
)
on conflict (slug) do update set
  country_id = excluded.country_id,
  name = excluded.name,
  timezone = excluded.timezone,
  latitude = excluded.latitude,
  longitude = excluded.longitude;

delete from public.places_of_interest
where source_provider = 'map-filter-smoke';

insert into public.places_of_interest (
  city_id,
  country_id,
  source_provider,
  source_type,
  source_id,
  name,
  slug,
  category,
  description,
  address,
  opening_hours,
  fee,
  wheelchair,
  latitude,
  longitude,
  quality_score
)
values
  (
    (select id from public.cities where slug = 'map-filter-smoke-city'),
    (select id from public.countries where code = 'ZZ'),
    'map-filter-smoke', 'node', 1,
    'Free accessible garden', 'free-accessible-garden', 'nature',
    'A public botanical garden.', 'Garden street 1', 'Mo-Su 08:00-20:00',
    'free', 'yes', 46.200, 6.140, 95
  ),
  (
    (select id from public.cities where slug = 'map-filter-smoke-city'),
    (select id from public.countries where code = 'ZZ'),
    'map-filter-smoke', 'node', 2,
    'Paid museum', 'paid-museum', 'culture',
    'A paid museum.', 'Museum street 2', 'Tu-Su 10:00-18:00',
    '20 CHF', 'no', 46.205, 6.145, 90
  ),
  (
    (select id from public.cities where slug = 'map-filter-smoke-city'),
    (select id from public.countries where code = 'ZZ'),
    'map-filter-smoke', 'node', 3,
    'Unknown forest', 'unknown-forest', 'nature',
    'A forest without structured opening hours.', 'Forest road', null,
    null, 'limited', 46.210, 6.150, 80
  ),
  (
    (select id from public.cities where slug = 'map-filter-smoke-city'),
    (select id from public.countries where code = 'ZZ'),
    'map-filter-smoke', 'node', 4,
    'Outside place', 'outside-place', 'nature',
    'Outside the viewport.', 'Outside road', '24/7',
    'free', 'yes', 47.000, 7.000, 70
  );

do $smoke$
declare
  pin_result jsonb;
  list_result jsonb;
  pin_total integer;
  list_total integer;
begin
  for pin_result, list_result in
    select
      public.discover_place_pins_in_bounds_v2(
        6.10, 46.15, 6.20, 46.25,
        test_case.categories,
        test_case.query,
        test_case.accessible_only,
        test_case.free_only,
        test_case.has_hours_only,
        14
      )::jsonb,
      public.discover_places_in_bounds_v1(
        6.10, 46.15, 6.20, 46.25,
        test_case.categories,
        test_case.query,
        test_case.accessible_only,
        test_case.free_only,
        test_case.has_hours_only,
        14,
        200,
        0
      )::jsonb
    from (
      values
        (null::text[], null::text, false, false, false),
        (array['nature']::text[], null::text, false, false, false),
        (null::text[], null::text, false, true, false),
        (null::text[], null::text, true, false, false),
        (null::text[], null::text, false, false, true),
        (null::text[], 'garden'::text, false, false, false)
    ) as test_case(categories, query, accessible_only, free_only, has_hours_only)
  loop
    pin_total := coalesce((pin_result->>'total_count')::integer, -1);
    list_total := coalesce((list_result->>'total_count')::integer, -1);
    if pin_total <> list_total then
      raise exception 'place pin/list mismatch: pins %, list %', pin_total, list_total;
    end if;
  end loop;

  pin_result := public.discover_place_pins_in_bounds_v2(
    6.10, 46.15, 6.20, 46.25,
    null, null, false, false, false, 14
  )::jsonb;
  if jsonb_array_length(pin_result->'pins') <> 3 then
    raise exception 'expected 3 compact individual pins, received %',
      jsonb_array_length(pin_result->'pins');
  end if;
  if pin_result::text ~ 'description|image_urls|booking_url|source_urls' then
    raise exception 'compact place payload contains rich detail fields';
  end if;

  pin_result := public.discover_place_pins_in_bounds_v2(
    6.10, 46.15, 6.20, 46.25,
    null, null, false, false, false, 10
  )::jsonb;
  if coalesce((pin_result->>'clustered')::boolean, false) is not true then
    raise exception 'low zoom place response must be server clustered';
  end if;
  if coalesce((pin_result->>'total_count')::integer, -1) <> 3 then
    raise exception 'low zoom place cluster total mismatch';
  end if;
end;
$smoke$;

rollback;
