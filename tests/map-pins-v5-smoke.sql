-- Contract smoke test for the additive v5 filtered map projection.
-- Run only on the disposable migration-replay database.

do $smoke$
declare
  pin_function_oid oid;
  pin_definition text;
  pin_settings text[];
  pin_security_definer boolean;
  pin_public_execute boolean;
  payload jsonb;
  v4_payload jsonb;
  first_pin jsonb;
  smoke_category_id uuid;
  smoke_event_id uuid;
  smoke_slug text := '__v5_smoke_' || replace(gen_random_uuid()::text, '-', '');
begin
  pin_function_oid := to_regprocedure(
    'public.discover_map_pins_in_bounds_v5(double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,text[],boolean,text,text[],numeric,numeric,boolean,integer,integer,boolean,boolean,boolean,boolean,boolean,double precision)'
  );

  if pin_function_oid is null then
    raise exception 'v5 compact map RPC signature is missing';
  end if;

  if not has_function_privilege('anon', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('authenticated', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('service_role', pin_function_oid, 'EXECUTE')
  then
    raise exception 'v5 compact map RPC permissions are incomplete';
  end if;

  select
    pg_get_functiondef(function.oid),
    function.prosecdef,
    function.proconfig,
    exists (
      select 1
      from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) as privilege
      where privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE'
    )
  into pin_definition, pin_security_definer, pin_settings, pin_public_execute
  from pg_proc as function
  where function.oid = pin_function_oid;

  if not pin_security_definer
    or pin_public_execute
    or not ('search_path=""' = any(pin_settings))
    or not ('row_security=off' = any(pin_settings))
    or position('candidate_occurrences as materialized' in pin_definition) = 0
    or position('combined_taxonomy_matches as materialized' in pin_definition) = 0
    or position('event.category_id = any' in pin_definition) = 0
    or position('unlocated_candidates as materialized' in pin_definition) = 0
    or position('category_event_ids as materialized' in pin_definition) = 0
    or position('search_event_ids as materialized' in pin_definition) = 0
    or position('genre_event_ids as materialized' in pin_definition) = 0
    or position('offer_stats as materialized' in pin_definition) = 0
    or position('public.discover_map_pins_in_bounds_v4' in pin_definition) = 0
    or position('left join lateral' in pin_definition) > 0
  then
    raise exception 'v5 map RPC lost its dual-plan, indexed, or security contract';
  end if;

  -- The unfiltered path delegates to the already-proven v4 implementation and
  -- must preserve its counts and compact tuples while advertising version 5.
  payload := public.discover_map_pins_in_bounds_v5(
    _west => 5.8,
    _south => 45.9,
    _east => 6.5,
    _north => 46.5,
    _from => now(),
    _to => now() + interval '30 days',
    _zoom => 10
  )::jsonb;
  v4_payload := public.discover_map_pins_in_bounds_v4(
    _west => 5.8,
    _south => 45.9,
    _east => 6.5,
    _north => 46.5,
    _from => now(),
    _to => now() + interval '30 days',
    _zoom => 10
  )::jsonb;

  if (payload ->> 'version')::integer <> 5
    or (payload ->> 'clustered')::boolean is not true
    or jsonb_typeof(payload -> 'pins') <> 'array'
    or payload - 'version' <> v4_payload - 'version'
  then
    raise exception 'v5 unfiltered delegation changed the v4 wire contract';
  end if;

  first_pin := payload -> 'pins' -> 0;
  if first_pin is not null
    and (jsonb_typeof(first_pin) <> 'array' or jsonb_array_length(first_pin) <> 10)
  then
    raise exception 'v5 clustered pin tuple must keep the ten-field wire format';
  end if;

  -- Seed one throwaway public event so the filtered comparison cannot pass
  -- vacuously. The DO statement is atomic: any assertion rolls these rows back,
  -- and the explicit deletes leave a successful disposable database unchanged.
  insert into public.event_categories (slug, name_fr, name_en, sort_order)
  values (smoke_slug, 'Test v5', 'V5 test', 9999)
  returning id into smoke_category_id;

  insert into public.events (
    slug,
    title,
    category_id,
    status,
    publication_status,
    is_free,
    is_verified,
    is_demo,
    genres,
    search_facets,
    published_at
  )
  values (
    smoke_slug,
    'Indexed v5 map smoke event ' || smoke_slug,
    smoke_category_id,
    'published',
    'published',
    true,
    true,
    false,
    array[smoke_slug],
    array[smoke_slug],
    now()
  )
  returning id into smoke_event_id;

  insert into public.event_occurrences (
    event_id,
    starts_at,
    ends_at,
    timezone,
    latitude,
    longitude,
    location,
    status,
    ticket_status
  )
  values (
    smoke_event_id,
    now() + interval '1 day',
    now() + interval '1 day 2 hours',
    'Europe/Zurich',
    46.2,
    6.1,
    public.st_setsrid(public.st_point(6.1, 46.2), 4326)::public.geography,
    'scheduled',
    'free'
  );

  payload := public.discover_map_pins_in_bounds_v5(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _zoom => 10
  )::jsonb;
  v4_payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _zoom => 10
  )::jsonb;

  if payload - 'version' <> v4_payload - 'version'
    or (payload ->> 'total_count')::integer <> 1
  then
    raise exception 'v5 non-empty filtered cluster path changed the v4 contract';
  end if;

  payload := public.discover_map_pins_in_bounds_v5(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _genres => array[smoke_slug],
    _zoom => 10
  )::jsonb;
  v4_payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _genres => array[smoke_slug],
    _zoom => 10
  )::jsonb;

  if payload - 'version' <> v4_payload - 'version'
    or (payload ->> 'total_count')::integer <> 1
  then
    raise exception 'v5 non-empty taxonomy fast path changed the v4 contract';
  end if;

  -- Keep the generic path executable after the taxonomy fast path broadens to
  -- category OR genre filters. Search and ticket-only filters must still match
  -- v4 exactly when neither taxonomy argument is present.
  payload := public.discover_map_pins_in_bounds_v5(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _query => smoke_slug,
    _tickets_only => true,
    _zoom => 10
  )::jsonb;
  v4_payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _query => smoke_slug,
    _tickets_only => true,
    _zoom => 10
  )::jsonb;

  if payload - 'version' <> v4_payload - 'version'
    or (payload ->> 'total_count')::integer <> 1
  then
    raise exception 'v5 non-empty generic filtered path changed the v4 contract';
  end if;

  -- Exercise the rewritten category, cross-table text, offer and individual
  -- branches even when the disposable database contains no matching events.
  payload := public.discover_map_pins_in_bounds_v5(
    _west => -20,
    _south => 30,
    _east => 40,
    _north => 70,
    _from => now(),
    _to => now() + interval '30 days',
    _category_slugs => array['__v5_smoke_missing__'],
    _query => '__v5_smoke_missing__',
    _tickets_only => true,
    _zoom => 14
  )::jsonb;

  if (payload ->> 'version')::integer <> 5
    or (payload ->> 'clustered')::boolean is not false
    or (payload ->> 'total_count')::integer <> 0
    or jsonb_array_length(payload -> 'pins') <> 0
  then
    raise exception 'v5 filtered individual response is malformed';
  end if;

  payload := public.discover_map_pins_in_bounds_v5(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '1 day',
    _genres => '{}'::text[],
    _zoom => 10
  )::jsonb;

  if (payload ->> 'clustered')::boolean is not true
    or (payload ->> 'total_count')::integer <> 0
    or jsonb_array_length(payload -> 'pins') <> 0
  then
    raise exception 'v5 filtered cluster path must preserve empty-array overlap semantics';
  end if;

  payload := public.discover_map_pins_in_bounds_v5(
    _west => 181,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _zoom => 10
  )::jsonb;

  if (payload ->> 'version')::integer <> 5
    or (payload ->> 'total_count')::integer <> 0
    or jsonb_array_length(payload -> 'pins') <> 0
  then
    raise exception 'v5 invalid bounds must fail closed';
  end if;

  payload := public.discover_map_pins_in_bounds_v5(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _zoom => null
  )::jsonb;
  v4_payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '2 days',
    _category_slugs => array[smoke_slug],
    _zoom => null
  )::jsonb;

  if payload - 'version' <> v4_payload - 'version'
    or (payload ->> 'clustered')::boolean is not false
  then
    raise exception 'v5 NULL zoom must preserve the v4 individual-pin contract';
  end if;

  delete from public.events where id = smoke_event_id;
  delete from public.event_categories where id = smoke_category_id;
end;
$smoke$;
