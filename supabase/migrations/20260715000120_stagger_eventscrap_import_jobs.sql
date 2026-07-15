-- Keep the staging importer continuous without overlapping long transactions
-- that starve public discovery RPCs.
DO $$
DECLARE
  events_job_id BIGINT;
  occurrences_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; skipping eventscrap job staggering';
    RETURN;
  END IF;

  SELECT jobid INTO events_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-events-import';

  SELECT jobid INTO occurrences_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-occurrences-import';

  IF events_job_id IS NULL OR occurrences_job_id IS NULL THEN
    RAISE NOTICE 'eventscrap import cron jobs are missing; skipping job staggering';
    RETURN;
  END IF;

  PERFORM cron.alter_job(
    events_job_id,
    schedule := '*/5 * * * *',
    command := 'select public.import_eventscrap_events_batch(1000);',
    active := true
  );

  PERFORM cron.alter_job(
    occurrences_job_id,
    schedule := '2-59/5 * * * *',
    command := 'select public.import_eventscrap_occurrences_batch(2000);',
    active := true
  );
END;
$$;
