do $smoke$
declare
  function_oid oid;
  function_definition text;
  function_is_security_definer boolean;
  function_settings text[];
  payload json;
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

  if position('limit 6000' in function_definition) = 0
    or position('limit 1000' in function_definition) = 0
    or position('limit 4000' in function_definition) = 0
  then
    raise exception 'legacy map pin work is not bounded before aggregation';
  end if;

  if not function_is_security_definer
    or not ('row_security=off' = any(function_settings))
    or position('venue.is_public = true' in function_definition) = 0
  then
    raise exception 'legacy map pin public projection is not hardened';
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
end;
$smoke$;
