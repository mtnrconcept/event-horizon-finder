-- Security and performance follow-up after the regional catalogue migration.

-- Public discovery is read-only and can safely respect the caller's RLS policies.
ALTER FUNCTION public.discover_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, INT, INT
) SECURITY INVOKER;

ALTER FUNCTION public.discover_map_events(
  DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT[], UUID, BOOLEAN, TEXT, INT, INT
) SECURITY INVOKER;

-- Trigger functions should never inherit a caller-controlled search path.
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.events_search_tsv_update() SET search_path = public;
ALTER FUNCTION public.sync_location_from_latlon() SET search_path = public;

-- Trigger-only functions do not need direct PostgREST execution privileges.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  -- This helper is installed by a production-only database hook on older projects,
  -- so it may legitimately be absent from a fresh Supabase preview branch.
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;

-- Keep only the original event occurrence uniqueness index.
DROP INDEX IF EXISTS public.event_occurrences_event_start_uidx;

-- Cover the foreign keys used by catalogue, moderation, social and personal feeds.
CREATE INDEX IF NOT EXISTS data_sources_city_idx ON public.data_sources(city_id);
CREATE INDEX IF NOT EXISTS data_sources_category_idx ON public.data_sources(category_slug);
CREATE INDEX IF NOT EXISTS data_sources_organizer_idx ON public.data_sources(organizer_id);
CREATE INDEX IF NOT EXISTS data_sources_venue_idx ON public.data_sources(venue_id);
CREATE INDEX IF NOT EXISTS events_organizer_idx ON public.events(organizer_id);
CREATE INDEX IF NOT EXISTS events_venue_idx ON public.events(venue_id);
CREATE INDEX IF NOT EXISTS events_created_by_idx ON public.events(created_by);
CREATE INDEX IF NOT EXISTS event_media_event_idx ON public.event_media(event_id);
CREATE INDEX IF NOT EXISTS event_reports_event_idx ON public.event_reports(event_id);
CREATE INDEX IF NOT EXISTS event_status_history_event_idx ON public.event_status_history(event_id);
CREATE INDEX IF NOT EXISTS favorites_event_idx ON public.favorites(event_id);
CREATE INDEX IF NOT EXISTS calendar_items_event_idx ON public.calendar_items(event_id);
CREATE INDEX IF NOT EXISTS calendar_items_occurrence_idx ON public.calendar_items(occurrence_id);
CREATE INDEX IF NOT EXISTS ingestion_jobs_source_idx ON public.ingestion_jobs(data_source_id);
CREATE INDEX IF NOT EXISTS ingestion_job_items_job_idx ON public.ingestion_job_items(ingestion_job_id);
CREATE INDEX IF NOT EXISTS source_records_source_idx ON public.source_records(data_source_id);
CREATE INDEX IF NOT EXISTS source_records_job_idx ON public.source_records(ingestion_job_id);
CREATE INDEX IF NOT EXISTS social_comments_post_status_idx ON public.social_comments(post_id, status, created_at);
