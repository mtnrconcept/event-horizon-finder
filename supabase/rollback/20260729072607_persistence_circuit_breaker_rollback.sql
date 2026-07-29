-- Functional rollback for the persistence timeout circuit breaker.
--
-- Restore the previous claim/complete/fail behavior and recover only jobs that
-- this migration terminalized after four PostgreSQL statement timeouts. The
-- private circuit history remains available for audit and can be removed in a
-- later destructive cleanup after explicit approval.

UPDATE private.global_event_persistence_jobs
SET
  status = 'queued',
  available_at = now(),
  lease_owner = NULL,
  lease_expires_at = NULL,
  error_code = 'persistence_circuit_rollback_requeued',
  error_message = 'Requeued by the persistence circuit breaker rollback.',
  finished_at = NULL,
  updated_at = now()
WHERE status = 'failed'
  AND error_code = 'persistence_timeout_exhausted';

UPDATE private.global_persistence_domain_circuit_breakers
SET
  state = 'closed',
  consecutive_timeouts = 0,
  open_until = NULL,
  updated_at = now();

UPDATE private.global_domain_crawl_state AS state
SET
  next_allowed_at = least(state.next_allowed_at, now() + interval '5 seconds'),
  updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  WHERE circuit.domain = state.domain
);

CREATE OR REPLACE FUNCTION public.claim_global_event_persistence_jobs(
  _worker_id UUID,
  _limit INTEGER DEFAULT 20,
  _lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  persistence_job_id UUID,
  crawl_job_id UUID,
  data_source_id UUID,
  event_key TEXT,
  event JSONB,
  attempt_count INTEGER,
  max_attempts INTEGER,
  domain TEXT,
  search_rank INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  exhausted RECORD;
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  FOR exhausted IN
    UPDATE private.global_event_persistence_jobs AS persistence
    SET
      status = 'failed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = coalesce(persistence.error_code, 'lease_expired'),
      error_message = coalesce(
        persistence.error_message,
        'Persistence lease expired after the final attempt.'
      ),
      finished_at = now(),
      updated_at = now()
    WHERE persistence.status = 'leased'
      AND persistence.lease_expires_at <= now()
      AND persistence.attempt_count >= persistence.max_attempts
    RETURNING persistence.crawl_job_id
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(
      (SELECT crawl.campaign_id
       FROM private.global_crawl_jobs AS crawl
       WHERE crawl.id = exhausted.crawl_job_id)
    );
  END LOOP;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT persistence.id
    FROM private.global_event_persistence_jobs AS persistence
    WHERE persistence.available_at <= now()
      AND persistence.attempt_count < persistence.max_attempts
      AND (
        persistence.status = 'queued'
        OR (
          persistence.status = 'leased'
          AND persistence.lease_expires_at <= now()
        )
      )
    ORDER BY persistence.available_at, persistence.created_at, persistence.id
    LIMIT greatest(1, least(coalesce(_limit, 20), 100))
    FOR UPDATE OF persistence SKIP LOCKED
  ),
  claimed AS (
    UPDATE private.global_event_persistence_jobs AS persistence
    SET
      status = 'leased',
      attempt_count = persistence.attempt_count + 1,
      lease_owner = _worker_id,
      lease_expires_at = now() + make_interval(
        secs => greatest(30, least(coalesce(_lease_seconds, 300), 900))
      ),
      started_at = coalesce(persistence.started_at, now()),
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE persistence.id = candidates.id
    RETURNING persistence.*
  )
  SELECT
    claimed.id,
    claimed.crawl_job_id,
    claimed.data_source_id,
    claimed.event_key,
    claimed.event_payload,
    claimed.attempt_count::INTEGER,
    claimed.max_attempts::INTEGER,
    crawl.domain,
    search_result.rank::INTEGER
  FROM claimed
  JOIN private.global_crawl_jobs AS crawl
    ON crawl.id = claimed.crawl_job_id
  LEFT JOIN private.global_search_results AS search_result
    ON search_result.id = crawl.search_result_id
  ORDER BY claimed.available_at, claimed.created_at, claimed.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_global_event_persistence_job(
  _job_id UUID,
  _worker_id UUID,
  _event_id UUID,
  _action TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  persistence private.global_event_persistence_jobs%ROWTYPE;
  campaign_id_value UUID;
  action_value TEXT := lower(btrim(coalesce(_action, '')));
BEGIN
  IF _event_id IS NULL OR action_value !~ '^[a-z][a-z0-9_-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_event_persistence_result' USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO persistence
  FROM private.global_event_persistence_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE private.global_event_persistence_jobs
  SET
    status = 'completed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    event_id = _event_id,
    persistence_action = action_value,
    error_code = NULL,
    error_message = NULL,
    first_completed_at = coalesce(first_completed_at, now()),
    finished_at = now(),
    updated_at = now()
  WHERE id = persistence.id;

  SELECT crawl.campaign_id
  INTO campaign_id_value
  FROM private.global_crawl_jobs AS crawl
  WHERE crawl.id = persistence.crawl_job_id;

  PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_global_event_persistence_job(
  _job_id UUID,
  _worker_id UUID,
  _error_code TEXT,
  _error_message TEXT,
  _retry_after_seconds INTEGER DEFAULT 300,
  _terminal BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  persistence private.global_event_persistence_jobs%ROWTYPE;
  campaign_id_value UUID;
  terminal_failure BOOLEAN;
  retry_seconds INTEGER := greatest(
    1,
    least(coalesce(_retry_after_seconds, 300), 604800)
  );
BEGIN
  SELECT job.*
  INTO persistence
  FROM private.global_event_persistence_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  terminal_failure := coalesce(_terminal, false)
    OR persistence.attempt_count >= persistence.max_attempts;

  UPDATE private.global_event_persistence_jobs
  SET
    status = CASE WHEN terminal_failure THEN 'failed' ELSE 'queued' END,
    available_at = CASE
      WHEN terminal_failure THEN available_at
      ELSE now() + make_interval(secs => retry_seconds)
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = coalesce(
      lower(nullif(left(btrim(_error_code), 100), '')),
      'event_persistence_failed'
    ),
    error_message = nullif(left(btrim(_error_message), 2000), ''),
    finished_at = CASE WHEN terminal_failure THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = persistence.id;

  SELECT crawl.campaign_id
  INTO campaign_id_value
  FROM private.global_crawl_jobs AS crawl
  WHERE crawl.id = persistence.crawl_job_id;

  PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  TO service_role;
