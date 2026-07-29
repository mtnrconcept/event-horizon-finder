\set ON_ERROR_STOP on

begin;

do $smoke$
declare
  function_oid oid;
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
end;
$smoke$;

set local role anon;

select json_typeof(
  public.discover_map_pins_in_bounds_v1(
    -180,
    -90,
    180,
    90,
    now(),
    now() + interval '1 day'
  )
) as anon_payload_type;

rollback;
