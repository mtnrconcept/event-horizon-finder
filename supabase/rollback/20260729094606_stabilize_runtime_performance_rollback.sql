-- Deploy the previous frontend and Edge Function revision before executing
-- this operational rollback, because they do not call the additive RPCs below.

DO $restore_runtime_jobs$
DECLARE
  target_job_id BIGINT;
BEGIN
  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-events-import';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      command := 'SELECT public.import_eventscrap_events_batch(1000);'
    );
  END IF;

  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-occurrences-import';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      command := 'SELECT public.import_eventscrap_occurrences_batch(2000);'
    );
  END IF;

  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'global-discovery-supabase-fallback';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      schedule := '7,22,37,52 * * * *',
      command := 'SELECT private.dispatch_global_discovery_fallback_v1();'
    );
  END IF;
END;
$restore_runtime_jobs$;

DROP FUNCTION IF EXISTS public.discover_home_collections_v1(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, INTEGER, INTEGER
);
DROP FUNCTION IF EXISTS public.record_global_discovery_external_activity_v1(TEXT);
DROP FUNCTION IF EXISTS public.upsert_ingested_event_serial_v1(UUID, JSONB);
DROP FUNCTION IF EXISTS private.run_eventscrap_events_import_guarded_v1(INTEGER);
DROP FUNCTION IF EXISTS private.run_eventscrap_occurrences_import_guarded_v1(INTEGER);

-- The two scheduler activity columns are intentionally retained: the deployed
-- fallback function references them, and leaving nullable additive metadata is
-- safer than replacing that security-definer function during an emergency
-- operational rollback.

DROP INDEX IF EXISTS private.global_discovery_daily_work_city_idx;
DROP INDEX IF EXISTS public.event_performers_performer_idx;
DROP INDEX IF EXISTS public.venue_aliases_venue_idx;
