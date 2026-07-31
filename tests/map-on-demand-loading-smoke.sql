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
