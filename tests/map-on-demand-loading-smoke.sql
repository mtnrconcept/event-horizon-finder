do $smoke$
declare
  pin_function_oid oid;
  detail_function_oid oid;
  pin_definition text;
  pin_settings text[];
  pin_security_definer boolean;
  detail_security_definer boolean;
  payload jsonb;
  occurrence_id uuid;
  detail jsonb;
begin
  pin_function_oid := to_regprocedure(
    'public.discover_map_pins_in_bounds_v3(double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,text[],boolean,text,text[],numeric,numeric,boolean,integer,integer,boolean,boolean,boolean,boolean,boolean,double precision)'
  );
  detail_function_oid := to_regprocedure('public.get_map_occurrence_detail_v1(uuid)');

  if pin_function_oid is null or detail_function_oid is null then
    raise exception 'on-demand map RPC signatures are missing';
  end if;

  if not has_function_privilege('anon', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('authenticated', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('anon', detail_function_oid, 'EXECUTE')
    or not has_function_privilege('authenticated', detail_function_oid, 'EXECUTE')
  then
    raise exception 'on-demand map RPC permissions are incomplete';
  end if;

  select
    pg_get_functiondef(function.oid),
    function.prosecdef,
    function.proconfig
  into pin_definition, pin_security_definer, pin_settings
  from pg_proc as function
  where function.oid = pin_function_oid;

  select function.prosecdef
  into detail_security_definer
  from pg_proc as function
  where function.oid = detail_function_oid;

  if not pin_security_definer
    or not ('row_security=off' = any(pin_settings))
    or position('$21::double precision < 14' in pin_definition) = 0
    or position('$21::double precision >= 14' in pin_definition) = 0
  then
    raise exception 'v3 map pins are not safely clustered through medium zoom';
  end if;

  if detail_security_definer then
    raise exception 'map detail must remain security invoker so RLS is enforced';
  end if;

  payload := public.discover_map_pins_in_bounds_v3(
    _west => 5.8,
    _south => 45.9,
    _east => 6.5,
    _north => 46.5,
    _from => now(),
    _to => now() + interval '30 days',
    _zoom => 10
  )::jsonb;

  if (payload ->> 'version')::integer <> 3
    or (payload ->> 'clustered')::boolean is not true
    or jsonb_typeof(payload -> 'pins') <> 'array'
  then
    raise exception 'v3 compact pin response is malformed';
  end if;

  payload := public.discover_map_pins_in_bounds_v3(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '1 day',
    _zoom => 14
  )::jsonb;

  if (payload ->> 'clustered')::boolean is not false then
    raise exception 'v3 must expose individual pins at close zoom';
  end if;

  select occurrence.id
  into occurrence_id
  from public.event_occurrences as occurrence
  join public.events as event on event.id = occurrence.event_id
  where event.is_demo = false
    and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
  order by occurrence.id
  limit 1;

  perform set_config('role', 'anon', true);

  if occurrence_id is not null then
    detail := public.get_map_occurrence_detail_v1(occurrence_id);

    if detail is null
      or detail ->> 'id' <> occurrence_id::text
      or jsonb_typeof(detail -> 'event') <> 'object'
      or jsonb_typeof(detail -> 'event' -> 'occurrences') <> 'array'
      or jsonb_typeof(detail -> 'event' -> 'offers') <> 'array'
      or jsonb_typeof(detail -> 'event' -> 'media') <> 'array'
      or jsonb_typeof(detail -> 'event' -> 'performers') <> 'array'
    then
      raise exception 'anon on-demand event detail response is malformed';
    end if;
  end if;
end;
$smoke$;

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

do $place_smoke$
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
$place_smoke$;

rollback;
