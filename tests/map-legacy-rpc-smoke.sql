do $smoke$
declare
  function_oid oid;
  function_definition text;
  function_is_security_definer boolean;
  function_settings text[];
  v2_function_oid oid;
  v2_function_definition text;
  v2_function_is_security_definer boolean;
  v2_function_settings text[];
  payload json;
  v2_payload json;
begin
  function_oid := to_regprocedure(
    'public.discover_map_pins_in_bounds_v1(double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,text[],boolean,text,text[],numeric,numeric,boolean,integer,integer,boolean,boolean,boolean,boolean,boolean)'
  );

  if function_oid is null then
    raise exception 'discover_map_pins_in_bounds_v1 signature is missing';
  end if;

  if not has_function_privilege('anon', function_oid, 'EXECUTE') then
    raise exception 'anon cannot execute discover_map_pins_in_bounds_v1';
  end if;

  select
    pg_get_functiondef(function_oid),
    function.prosecdef,
    function.proconfig
  into
    function_definition,
    function_is_security_definer,
    function_settings
  from pg_proc as function
  where function.oid = function_oid;

  if position('discover_map_pins_in_bounds_v2' in function_definition) = 0
    or position('_zoom => legacy_zoom' in function_definition) = 0
    or position('longitude_span >= 90' in function_definition) = 0
    or position('marker.ordinality <= 4000' in function_definition) = 0
  then
    raise exception 'legacy map pin projection is not delegated and bounded';
  end if;

  if not function_is_security_definer
    or not ('row_security=off' = any(function_settings))
  then
    raise exception 'legacy map pin public projection is not hardened';
  end if;

  v2_function_oid := to_regprocedure(
    'public.discover_map_pins_in_bounds_v2(double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,text[],boolean,text,text[],numeric,numeric,boolean,integer,integer,boolean,boolean,boolean,boolean,boolean,double precision)'
  );

  if v2_function_oid is null
    or not has_function_privilege('anon', v2_function_oid, 'EXECUTE')
  then
    raise exception 'discover_map_pins_in_bounds_v2 public signature is unavailable';
  end if;

  select
    pg_get_functiondef(v2_function_oid),
    function.prosecdef,
    function.proconfig
  into
    v2_function_definition,
    v2_function_is_security_definer,
    v2_function_settings
  from pg_proc as function
  where function.oid = v2_function_oid;

  if not v2_function_is_security_definer
    or not ('row_security=off' = any(v2_function_settings))
    or position('venue.is_public = true' in v2_function_definition) = 0
    or position('event.status in (''published'', ''cancelled'', ''postponed'', ''sold_out'')' in v2_function_definition) = 0
  then
    raise exception 'zoom-aware map pin public projection is not hardened';
  end if;

  v2_payload := public.discover_map_pins_in_bounds_v2(
    _west => -180,
    _south => -90,
    _east => 180,
    _north => 90,
    _from => now(),
    _to => now() + interval '1 day',
    _zoom => 3
  );

  if json_typeof(v2_payload) <> 'object'
    or (v2_payload::jsonb ->> 'version')::integer <> 2
    or jsonb_typeof(v2_payload::jsonb -> 'pins') <> 'array'
  then
    raise exception 'zoom-aware map pin response is malformed';
  end if;

  payload := public.discover_map_pins_in_bounds_v1(
    -180,
    -90,
    180,
    90,
    now(),
    now() + interval '30 days'
  );

  if json_typeof(payload) <> 'array' then
    raise exception 'legacy map pin response must be an array';
  end if;

  if json_array_length(payload) > 4000 then
    raise exception 'legacy map pin response exceeded its 4,000 pin cap';
  end if;

  if exists (
    select 1
    from json_array_elements(payload) as row(pin)
    where json_array_length(row.pin) <> 7
  ) then
    raise exception 'legacy map pin response contains a non-legacy row';
  end if;

  perform set_config('role', 'anon', true);

  payload := public.discover_map_pins_in_bounds_v1(
    -180,
    -90,
    180,
    90,
    now(),
    now() + interval '1 day'
  );

  if json_typeof(payload) <> 'array' then
    raise exception 'anon legacy map pin response must be an array';
  end if;

  v2_payload := public.discover_map_pins_in_bounds_v2(
    _west => -180,
    _south => -90,
    _east => 180,
    _north => 90,
    _from => now(),
    _to => now() + interval '1 day',
    _zoom => 3
  );

  if (v2_payload::jsonb ->> 'version')::integer <> 2 then
    raise exception 'anon zoom-aware map pin response is unavailable';
  end if;
end;
$smoke$;
