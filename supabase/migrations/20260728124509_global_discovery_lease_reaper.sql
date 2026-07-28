-- Recover abandoned global-discovery leases without waiting for another
-- worker to claim the same queue, and keep every Edge invocation below the
-- hosted runtime timeout.
BEGIN;

CREATE OR REPLACE FUNCTION public.reap_global_discovery_expired_leases_v1(
  _batch_limit INTEGER DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  batch_limit INTEGER := greatest(1, least(coalesce(_batch_limit, 500), 5000));
  reaped_at TIMESTAMPTZ := clock_timestamp();
  search_requeued INTEGER := 0;
  search_failed INTEGER := 0;
  crawl_requeued INTEGER := 0;
  crawl_failed INTEGER := 0;
  persistence_requeued INTEGER := 0;
  persistence_failed INTEGER := 0;
  campaign_id_value UUID;
  campaigns_refreshed INTEGER := 0;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('global_discovery_expired_lease_reaper_v1', 0)
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'locked', false,
      'requeued', 0,
      'failed', 0
    );
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT job.id
    FROM private.global_search_jobs AS job
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= reaped_at
    ORDER BY job.lease_expires_at, job.id
    LIMIT batch_limit
    FOR UPDATE OF job SKIP LOCKED
  ),
  recovered AS (
    UPDATE private.global_search_jobs AS job
    SET
      status = CASE
        WHEN job.attempt_count >= job.max_attempts THEN 'failed'
        ELSE 'queued'
      END,
      available_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN job.available_at
        ELSE reaped_at + make_interval(
          secs => least(
            300,
            5 * power(
              2::NUMERIC,
              greatest(0, least(job.attempt_count::INTEGER, 7) - 1)
            )::INTEGER
          )
        )
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'lease_expired_final'
        ELSE 'lease_expired_reaped'
      END,
      error_message = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'Search lease expired after the final attempt.'
        ELSE 'Expired search lease recovered with progressive retry delay.'
      END,
      finished_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN reaped_at
        ELSE NULL
      END,
      updated_at = reaped_at
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.status
  )
  SELECT
    count(*) FILTER (WHERE status = 'queued'),
    count(*) FILTER (WHERE status = 'failed')
  INTO search_requeued, search_failed
  FROM recovered;

  WITH candidates AS MATERIALIZED (
    SELECT job.id
    FROM private.global_crawl_jobs AS job
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= reaped_at
    ORDER BY job.lease_expires_at, job.id
    LIMIT batch_limit
    FOR UPDATE OF job SKIP LOCKED
  ),
  recovered AS (
    UPDATE private.global_crawl_jobs AS job
    SET
      status = CASE
        WHEN job.attempt_count >= job.max_attempts THEN 'failed'
        ELSE 'queued'
      END,
      available_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN job.available_at
        ELSE reaped_at + make_interval(
          secs => least(
            600,
            15 * power(
              2::NUMERIC,
              greatest(0, least(job.attempt_count::INTEGER, 7) - 1)
            )::INTEGER
          )
        )
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'lease_expired_final'
        ELSE 'lease_expired_reaped'
      END,
      error_message = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'Crawl lease expired after the final attempt.'
        ELSE 'Expired crawl lease recovered with progressive retry delay.'
      END,
      finished_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN reaped_at
        ELSE NULL
      END,
      updated_at = reaped_at
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.status
  )
  SELECT
    count(*) FILTER (WHERE status = 'queued'),
    count(*) FILTER (WHERE status = 'failed')
  INTO crawl_requeued, crawl_failed
  FROM recovered;

  WITH candidates AS MATERIALIZED (
    SELECT job.id
    FROM private.global_event_persistence_jobs AS job
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= reaped_at
    ORDER BY job.lease_expires_at, job.id
    LIMIT batch_limit
    FOR UPDATE OF job SKIP LOCKED
  ),
  recovered AS (
    UPDATE private.global_event_persistence_jobs AS job
    SET
      status = CASE
        WHEN job.attempt_count >= job.max_attempts THEN 'failed'
        ELSE 'queued'
      END,
      available_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN job.available_at
        ELSE reaped_at + make_interval(
          secs => least(
            60,
            power(
              2::NUMERIC,
              greatest(0, least(job.attempt_count::INTEGER, 7) - 1)
            )::INTEGER
          )
        )
      END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'lease_expired_final'
        ELSE 'lease_expired_reaped'
      END,
      error_message = CASE
        WHEN job.attempt_count >= job.max_attempts
          THEN 'Persistence lease expired after the final attempt.'
        ELSE 'Expired persistence lease recovered with progressive retry delay.'
      END,
      finished_at = CASE
        WHEN job.attempt_count >= job.max_attempts THEN reaped_at
        ELSE NULL
      END,
      updated_at = reaped_at
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.status
  )
  SELECT
    count(*) FILTER (WHERE status = 'queued'),
    count(*) FILTER (WHERE status = 'failed')
  INTO persistence_requeued, persistence_failed
  FROM recovered;

  FOR campaign_id_value IN
    SELECT DISTINCT affected.campaign_id
    FROM (
      SELECT search.campaign_id
      FROM private.global_search_jobs AS search
      WHERE search.updated_at = reaped_at
        AND search.error_code IN ('lease_expired_reaped', 'lease_expired_final')
      UNION
      SELECT crawl.campaign_id
      FROM private.global_crawl_jobs AS crawl
      WHERE crawl.updated_at = reaped_at
        AND crawl.error_code IN ('lease_expired_reaped', 'lease_expired_final')
      UNION
      SELECT crawl.campaign_id
      FROM private.global_event_persistence_jobs AS persistence
      JOIN private.global_crawl_jobs AS crawl
        ON crawl.id = persistence.crawl_job_id
      WHERE persistence.updated_at = reaped_at
        AND persistence.error_code IN ('lease_expired_reaped', 'lease_expired_final')
    ) AS affected
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
    campaigns_refreshed := campaigns_refreshed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'locked', true,
    'reaped_at', reaped_at,
    'search_requeued', coalesce(search_requeued, 0),
    'search_failed', coalesce(search_failed, 0),
    'crawl_requeued', coalesce(crawl_requeued, 0),
    'crawl_failed', coalesce(crawl_failed, 0),
    'persistence_requeued', coalesce(persistence_requeued, 0),
    'persistence_failed', coalesce(persistence_failed, 0),
    'requeued',
      coalesce(search_requeued, 0)
      + coalesce(crawl_requeued, 0)
      + coalesce(persistence_requeued, 0),
    'failed',
      coalesce(search_failed, 0)
      + coalesce(crawl_failed, 0)
      + coalesce(persistence_failed, 0),
    'campaigns_refreshed', campaigns_refreshed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_global_discovery_worker_leases_v1(
  _worker_id UUID,
  _retry_after_seconds INTEGER DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  released_at TIMESTAMPTZ := clock_timestamp();
  retry_seconds INTEGER := greatest(
    1,
    least(coalesce(_retry_after_seconds, 5), 300)
  );
  search_released INTEGER := 0;
  crawl_released INTEGER := 0;
  persistence_released INTEGER := 0;
  campaign_id_value UUID;
  campaigns_refreshed INTEGER := 0;
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  UPDATE private.global_search_jobs AS job
  SET
    status = 'queued',
    attempt_count = greatest(0, job.attempt_count - 1),
    available_at = released_at + make_interval(secs => retry_seconds),
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = 'worker_budget_released',
    error_message = 'Worker exited before starting this claimed search job.',
    finished_at = NULL,
    updated_at = released_at
  WHERE job.status = 'leased'
    AND job.lease_owner = _worker_id;
  GET DIAGNOSTICS search_released = ROW_COUNT;

  UPDATE private.global_crawl_jobs AS job
  SET
    status = 'queued',
    attempt_count = greatest(0, job.attempt_count - 1),
    available_at = released_at + make_interval(secs => retry_seconds),
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = 'worker_budget_released',
    error_message = 'Worker exited before starting this claimed crawl job.',
    finished_at = NULL,
    updated_at = released_at
  WHERE job.status = 'leased'
    AND job.lease_owner = _worker_id;
  GET DIAGNOSTICS crawl_released = ROW_COUNT;

  UPDATE private.global_event_persistence_jobs AS job
  SET
    status = 'queued',
    attempt_count = greatest(0, job.attempt_count - 1),
    available_at = released_at + make_interval(secs => retry_seconds),
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = 'worker_budget_released',
    error_message = 'Worker exited before starting this claimed persistence job.',
    finished_at = NULL,
    updated_at = released_at
  WHERE job.status = 'leased'
    AND job.lease_owner = _worker_id;
  GET DIAGNOSTICS persistence_released = ROW_COUNT;

  FOR campaign_id_value IN
    SELECT DISTINCT affected.campaign_id
    FROM (
      SELECT search.campaign_id
      FROM private.global_search_jobs AS search
      WHERE search.updated_at = released_at
        AND search.error_code = 'worker_budget_released'
      UNION
      SELECT crawl.campaign_id
      FROM private.global_crawl_jobs AS crawl
      WHERE crawl.updated_at = released_at
        AND crawl.error_code = 'worker_budget_released'
      UNION
      SELECT crawl.campaign_id
      FROM private.global_event_persistence_jobs AS persistence
      JOIN private.global_crawl_jobs AS crawl
        ON crawl.id = persistence.crawl_job_id
      WHERE persistence.updated_at = released_at
        AND persistence.error_code = 'worker_budget_released'
    ) AS affected
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
    campaigns_refreshed := campaigns_refreshed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'worker_id', _worker_id,
    'search_released', search_released,
    'crawl_released', crawl_released,
    'persistence_released', persistence_released,
    'released', search_released + crawl_released + persistence_released,
    'campaigns_refreshed', campaigns_refreshed
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.dispatch_global_discovery_fallback_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  endpoint TEXT :=
    'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/global-event-discovery';
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

  SELECT state.*
  INTO state_row
  FROM private.global_discovery_scheduler_state AS state
  WHERE state.singleton
  FOR UPDATE;

  SELECT public.reap_global_discovery_expired_leases_v1(1000)
  INTO reaper_result;

  IF state_row.last_dispatched_at IS NOT NULL
    AND state_row.last_dispatched_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dispatched', false,
      'reason', 'recent_dispatch',
      'last_dispatched_at', state_row.last_dispatched_at,
      'lease_reaper', reaper_result
    );
  END IF;

  SELECT to_jsonb(health)
  INTO metrics
  FROM public.global_discovery_health_v1() AS health;
  metrics := coalesce(metrics, '{}'::JSONB)
    || jsonb_build_object('lease_reaper', reaper_result);

  SELECT private.enqueue_global_discovery_http_request_v1(
    dispatch_id,
    endpoint,
    jsonb_build_object(
      'action', 'plan',
      'batch_size', 25,
      'target_date', to_char(current_date + 1, 'YYYY-MM-DD'),
      'scheduler_dispatch_id', dispatch_id
    ),
    60000
  )
  INTO request_id;
  request_ids := array_append(request_ids, request_id);

  SELECT private.enqueue_global_discovery_http_request_v1(
    dispatch_id,
    endpoint,
    jsonb_build_object(
      'action', 'search',
      'batch_size', 5,
      'scheduler_dispatch_id', dispatch_id
    ),
    90000
  )
  INTO request_id;
  request_ids := array_append(request_ids, request_id);

  -- Six parallel calls drain at most 36 writes and one page each. The worker
  -- budget releases any claimed-but-unstarted job before the Edge timeout.
  FOR worker_index IN 1..6 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id,
      endpoint,
      jsonb_build_object(
        'action', 'crawl',
        'batch_size', 1,
        'persistence_limit', 6,
        'scheduler_dispatch_id', dispatch_id,
        'scheduler_worker', worker_index
      ),
      120000
    )
    INTO request_id;
    request_ids := array_append(request_ids, request_id);
  END LOOP;

  INSERT INTO private.global_discovery_scheduler_dispatches (
    id,
    dispatched_at,
    request_ids,
    metrics
  )
  VALUES (
    dispatch_id,
    now(),
    request_ids,
    metrics
  );

  UPDATE private.global_discovery_scheduler_state
  SET
    last_dispatched_at = now(),
    last_dispatch_id = dispatch_id,
    last_request_ids = request_ids,
    last_metrics = metrics,
    updated_at = now()
  WHERE singleton;

  DELETE FROM private.global_discovery_scheduler_dispatches
  WHERE dispatched_at < now() - interval '7 days';
  DELETE FROM private.global_discovery_scheduler_tokens
  WHERE expires_at < now() - interval '1 hour';

  RETURN jsonb_build_object(
    'ok', true,
    'dispatched', true,
    'dispatch_id', dispatch_id,
    'request_count', cardinality(request_ids),
    'metrics', metrics,
    'lease_reaper', reaper_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reap_global_discovery_expired_leases_v1(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_global_discovery_worker_leases_v1(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reap_global_discovery_expired_leases_v1(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_global_discovery_worker_leases_v1(UUID, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.reap_global_discovery_expired_leases_v1(INTEGER) IS
  'Idempotently recovers bounded expired Search, Crawl and Persistence leases with progressive retry delays; service-role only.';
COMMENT ON FUNCTION public.release_global_discovery_worker_leases_v1(UUID, INTEGER) IS
  'Releases every unfinished lease owned by one bounded Edge worker; service-role only.';
COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Reaps expired leases, then dispatches one locked eight-request slice with timeout-safe worker batches.';

COMMIT;
