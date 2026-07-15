-- Import jobs are internal maintenance operations, never public RPCs.

alter function public.import_eventscrap_events_batch(integer)
  set search_path = pg_catalog, public;
alter function public.import_eventscrap_occurrences_batch(integer)
  set search_path = pg_catalog, public;

revoke all on function public.import_eventscrap_events_batch(integer)
  from public, anon, authenticated;
revoke all on function public.import_eventscrap_occurrences_batch(integer)
  from public, anon, authenticated;

grant execute on function public.import_eventscrap_events_batch(integer)
  to service_role;
grant execute on function public.import_eventscrap_occurrences_batch(integer)
  to service_role;
