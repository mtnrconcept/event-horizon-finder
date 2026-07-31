-- Contract smoke test for the additive v4 map projection.
-- Run after the migration replay; it does not modify application data.

do $smoke$
declare
  pin_function_oid oid;
  pin_definition text;
  pin_settings text[];
  pin_security_definer boolean;
  payload jsonb;
  first_pin jsonb;
begin
  pin_function_oid := to_regprocedure(
    'public.discover_map_pins_in_bounds_v4(double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,text[],boolean,text,text[],numeric,numeric,boolean,integer,integer,boolean,boolean,boolean,boolean,boolean,double precision)'
  );

  if pin_function_oid is null then
    raise exception 'v4 compact map RPC signature is missing';
  end if;

  if not has_function_privilege('anon', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('authenticated', pin_function_oid, 'EXECUTE')
    or not has_function_privilege('service_role', pin_function_oid, 'EXECUTE')
  then
    raise exception 'v4 compact map RPC permissions are incomplete';
  end if;

  select
    pg_get_functiondef(function.oid),
    function.prosecdef,
    function.proconfig
  into pin_definition, pin_security_definer, pin_settings
  from pg_proc as function
  where function.oid = pin_function_oid;

  if not pin_security_definer
    or not ('search_path=""' = any(pin_settings))
    or not ('row_security=off' = any(pin_settings))
    or position('use_fast_path' in pin_definition) = 0
    or position('event.search_facets && $10::text[]' in pin_definition) = 0
    or position('response_stats' in pin_definition) > 0
    or regexp_count(pin_definition, 'points as not materialized') <> 4
    or position('row_number() over' in pin_definition) = 0
    or position('count(*) over ()' in pin_definition) = 0
  then
    raise exception 'v4 map RPC lost its fast path, facet filter, or single-scan contract';
  end if;

  payload := public.discover_map_pins_in_bounds_v4(
    _west => 5.8,
    _south => 45.9,
    _east => 6.5,
    _north => 46.5,
    _from => now(),
    _to => now() + interval '30 days',
    _zoom => 10
  )::jsonb;

  if (payload ->> 'version')::integer <> 4
    or (payload ->> 'clustered')::boolean is not true
    or jsonb_typeof(payload -> 'pins') <> 'array'
    or (payload ->> 'total_count')::integer < 0
    or (payload ->> 'free_count')::integer < 0
  then
    raise exception 'v4 clustered response is malformed';
  end if;

  first_pin := payload -> 'pins' -> 0;
  if first_pin is not null
    and (jsonb_typeof(first_pin) <> 'array' or jsonb_array_length(first_pin) <> 10)
  then
    raise exception 'v4 clustered pin tuple must keep the ten-field wire format';
  end if;

  payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '1 day',
    _zoom => 14
  )::jsonb;

  if (payload ->> 'version')::integer <> 4
    or (payload ->> 'clustered')::boolean is not false
    or jsonb_typeof(payload -> 'pins') <> 'array'
  then
    raise exception 'v4 individual-pin response is malformed';
  end if;

  first_pin := payload -> 'pins' -> 0;
  if first_pin is not null
    and (jsonb_typeof(first_pin) <> 'array' or jsonb_array_length(first_pin) <> 10)
  then
    raise exception 'v4 individual pin tuple must keep the ten-field wire format';
  end if;

  payload := public.discover_map_pins_in_bounds_v4(
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
    raise exception 'v4 filtered cluster path must preserve empty-array overlap semantics';
  end if;

  payload := public.discover_map_pins_in_bounds_v4(
    _west => 6.0,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _from => now(),
    _to => now() + interval '1 day',
    _genres => '{}'::text[],
    _zoom => 14
  )::jsonb;

  if (payload ->> 'total_count')::integer <> 0
    or jsonb_array_length(payload -> 'pins') <> 0
  then
    raise exception 'v4 filtered path must preserve empty-array overlap semantics';
  end if;

  payload := public.discover_map_pins_in_bounds_v4(
    _west => 181,
    _south => 46.0,
    _east => 6.2,
    _north => 46.3,
    _zoom => 10
  )::jsonb;

  if (payload ->> 'version')::integer <> 4
    or (payload ->> 'total_count')::integer <> 0
    or jsonb_array_length(payload -> 'pins') <> 0
  then
    raise exception 'v4 invalid bounds must fail closed';
  end if;
end;
$smoke$;
