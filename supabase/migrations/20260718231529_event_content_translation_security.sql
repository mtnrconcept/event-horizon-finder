-- Supabase grants function execution to API roles through its schema defaults.
-- These helpers are invoked only by database triggers or the translation Edge
-- Function, so they must not be exposed as public RPC endpoints.
revoke all on function public.consume_event_translation_quota(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_event_translation_quota(text, integer, integer)
  to service_role;

revoke all on function public.mark_event_translations_stale(uuid[])
  from public, anon, authenticated;
revoke all on function public.invalidate_event_translation_from_event()
  from public, anon, authenticated;
revoke all on function public.invalidate_event_translation_from_child()
  from public, anon, authenticated;
revoke all on function public.invalidate_event_translation_from_venue()
  from public, anon, authenticated;
revoke all on function public.invalidate_event_translation_from_organizer()
  from public, anon, authenticated;
revoke all on function public.invalidate_event_translation_from_performer()
  from public, anon, authenticated;
