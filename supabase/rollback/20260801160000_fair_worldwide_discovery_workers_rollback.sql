-- Operational rollback for 20260801160000_fair_worldwide_discovery_workers.
-- Redeploy the preceding global-event-discovery version first, then execute
-- this script. Every deferred Crawl job is made executable again; no event or
-- job is deleted and the additive server-only RPCs may safely remain present.

BEGIN;

SELECT public.restore_deferred_global_crawl_jobs_v1(NULL, 50000);

ALTER TABLE private.global_discovery_scheduler_state
  DROP CONSTRAINT IF EXISTS global_discovery_scheduler_external_action_check;
ALTER TABLE private.global_discovery_scheduler_state
  ADD CONSTRAINT global_discovery_scheduler_external_action_check
  CHECK (
    last_external_action IS NULL
    OR last_external_action IN ('plan', 'search', 'crawl')
  );

CREATE OR REPLACE FUNCTION public.record_global_discovery_external_activity_v1(
  _action TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(_action, '') NOT IN ('plan', 'search', 'crawl') THEN
    RAISE EXCEPTION 'invalid global discovery action';
  END IF;

  UPDATE private.global_discovery_scheduler_state
  SET
    last_external_activity_at = now(),
    last_external_action = _action,
    updated_at = now()
  WHERE singleton;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION private.dispatch_global_discovery_fallback_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  endpoint TEXT := 'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/global-event-discovery';
  request_ids BIGINT[] := ARRAY[]::BIGINT[];
  request_id BIGINT;
  dispatch_id UUID := gen_random_uuid();
  metrics JSONB;
  reaper_result JSONB;
  state_row private.global_discovery_scheduler_state%ROWTYPE;
  worker_index INTEGER;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global_discovery_supabase_fallback_v1', 0)
  );

  SELECT state.* INTO state_row
  FROM private.global_discovery_scheduler_state AS state
  WHERE state.singleton
  FOR UPDATE;

  SELECT public.reap_global_discovery_expired_leases_v1(1000) INTO reaper_result;

  IF state_row.last_external_activity_at IS NOT NULL
    AND state_row.last_external_activity_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true, 'dispatched', false, 'reason', 'recent_external_activity',
      'last_external_activity_at', state_row.last_external_activity_at,
      'last_external_action', state_row.last_external_action,
      'lease_reaper', reaper_result
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cron.job_run_details AS run
    JOIN cron.job AS job ON job.jobid = run.jobid
    WHERE job.jobname IN ('eventscrap-events-import', 'eventscrap-occurrences-import')
      AND run.status = 'running' AND run.end_time IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', true, 'dispatched', false, 'reason', 'eventscrap_import_running',
      'lease_reaper', reaper_result
    );
  END IF;

  IF state_row.last_dispatched_at IS NOT NULL
    AND state_row.last_dispatched_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true, 'dispatched', false, 'reason', 'recent_dispatch',
      'last_dispatched_at', state_row.last_dispatched_at,
      'lease_reaper', reaper_result
    );
  END IF;

  SELECT to_jsonb(health) INTO metrics FROM public.global_discovery_health_v1() AS health;
  metrics := coalesce(metrics, '{}'::JSONB) || jsonb_build_object('lease_reaper', reaper_result);

  SELECT private.enqueue_global_discovery_http_request_v1(
    dispatch_id, endpoint,
    jsonb_build_object(
      'action', 'plan', 'batch_size', 25,
      'target_date', to_char(current_date + 1, 'YYYY-MM-DD'),
      'scheduler_dispatch_id', dispatch_id
    ), 60000
  ) INTO request_id;
  request_ids := array_append(request_ids, request_id);

  SELECT private.enqueue_global_discovery_http_request_v1(
    dispatch_id, endpoint,
    jsonb_build_object('action', 'search', 'batch_size', 5, 'scheduler_dispatch_id', dispatch_id),
    90000
  ) INTO request_id;
  request_ids := array_append(request_ids, request_id);

  FOR worker_index IN 1..6 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id, endpoint,
      jsonb_build_object(
        'action', 'crawl', 'batch_size', 1, 'persistence_limit', 8,
        'scheduler_dispatch_id', dispatch_id, 'scheduler_worker', worker_index
      ), 120000
    ) INTO request_id;
    request_ids := array_append(request_ids, request_id);
  END LOOP;

  INSERT INTO private.global_discovery_scheduler_dispatches (id, dispatched_at, request_ids, metrics)
  VALUES (dispatch_id, now(), request_ids, metrics);

  UPDATE private.global_discovery_scheduler_state
  SET last_dispatched_at = now(), last_dispatch_id = dispatch_id,
      last_request_ids = request_ids, last_metrics = metrics, updated_at = now()
  WHERE singleton;

  DELETE FROM private.global_discovery_scheduler_dispatches
  WHERE dispatched_at < now() - interval '7 days';
  DELETE FROM private.global_discovery_scheduler_tokens
  WHERE expires_at < now() - interval '1 hour';

  RETURN jsonb_build_object(
    'ok', true, 'dispatched', true, 'dispatch_id', dispatch_id,
    'request_count', cardinality(request_ids), 'metrics', metrics,
    'lease_reaper', reaper_result
  );
END;
$$;

REVOKE ALL ON FUNCTION private.dispatch_global_discovery_fallback_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Rollback-compatible scheduler: plan, search and six combined Crawl/Persistence workers.';

COMMIT;
