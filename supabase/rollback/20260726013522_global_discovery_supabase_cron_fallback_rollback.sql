-- Controlled rollback for the independent worldwide discovery scheduler.
-- pg_cron and pg_net are deliberately retained because other jobs may use them.
BEGIN;

DO $remove_scheduler_job$
DECLARE
  existing_job_id BIGINT;
BEGIN
  FOR existing_job_id IN
    SELECT job.jobid
    FROM cron.job AS job
    WHERE job.jobname = 'global-discovery-supabase-fallback'
  LOOP
    PERFORM cron.unschedule(existing_job_id);
  END LOOP;
END;
$remove_scheduler_job$;

DROP FUNCTION IF EXISTS private.dispatch_global_discovery_fallback_v1();
DROP FUNCTION IF EXISTS private.enqueue_global_discovery_http_request_v1(UUID, TEXT, JSONB, INTEGER);
DROP FUNCTION IF EXISTS public.global_discovery_scheduler_status_v1();
DROP FUNCTION IF EXISTS public.global_discovery_health_v1();
DROP FUNCTION IF EXISTS public.claim_global_discovery_scheduler_token_v1(TEXT);

DROP TABLE IF EXISTS private.global_discovery_scheduler_dispatches;
DROP TABLE IF EXISTS private.global_discovery_scheduler_state;
DROP TABLE IF EXISTS private.global_discovery_scheduler_tokens;

DROP INDEX IF EXISTS private.global_event_persistence_jobs_recent_yield_idx;
DROP INDEX IF EXISTS public.events_created_at_idx;

COMMIT;
