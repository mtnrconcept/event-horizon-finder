-- The venue upsert deliberately returns columns named venue_id/place_id for a
-- stable PostgREST payload. PostgreSQL exposes those output columns as PL/pgSQL
-- variables, so an unqualified ON CONFLICT (venue_id, url) target is ambiguous.
-- Patch the already-created function to target the named unique constraint.
-- This avoids changing the cluster-wide plpgsql.variable_conflict setting.

do $patch$
declare
  current_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.upsert_ladecadanse_venue_v1(uuid,jsonb)'::regprocedure
  )
  into current_definition;

  if current_definition is null then
    raise exception 'upsert_ladecadanse_venue_v1 is missing';
  end if;

  patched_definition := regexp_replace(
    current_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*venue_id[[:space:]]*,[[:space:]]*url[[:space:]]*\)[[:space:]]+do[[:space:]]+update',
    'on conflict on constraint venue_media_venue_id_url_key do update',
    'i'
  );

  if patched_definition = current_definition then
    raise exception 'venue_media ON CONFLICT target was not found in upsert_ladecadanse_venue_v1';
  end if;

  execute patched_definition;
end;
$patch$;

alter function public.upsert_ladecadanse_venue_v1(uuid, jsonb)
  set search_path = 'pg_catalog', 'public';
