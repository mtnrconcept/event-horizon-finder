-- Recognize statement timeouts emitted by both the direct upsert and the
-- serialized compatibility wrapper. This keeps the existing circuit breaker
-- and four-attempt retry cap effective after the runtime serialization change.

CREATE OR REPLACE FUNCTION private.is_global_persistence_timeout_v1(
  _error_code TEXT,
  _error_message TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    lower(btrim(coalesce(_error_code, ''))) IN (
      'rpc_upsert_ingested_event_v2_failed',
      'rpc_upsert_ingested_event_serial_v1_failed'
    )
    AND coalesce(_error_message, '') LIKE '57014:%';
$$;

REVOKE ALL ON FUNCTION private.is_global_persistence_timeout_v1(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

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
  domain_value TEXT;
  terminal_failure BOOLEAN;
  timeout_failure BOOLEAN;
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

  timeout_failure := private.is_global_persistence_timeout_v1(
    _error_code,
    _error_message
  );
  terminal_failure := coalesce(_terminal, false)
    OR persistence.attempt_count >= persistence.max_attempts
    OR (timeout_failure AND persistence.attempt_count >= 4);

  IF timeout_failure THEN
    retry_seconds := greatest(
      retry_seconds,
      least(7200, (300 * power(2, least(persistence.attempt_count, 4)))::INTEGER)
    );
  END IF;

  UPDATE private.global_event_persistence_jobs
  SET
    status = CASE WHEN terminal_failure THEN 'failed' ELSE 'queued' END,
    available_at = CASE
      WHEN terminal_failure THEN available_at
      ELSE now() + make_interval(secs => retry_seconds)
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = CASE
      WHEN timeout_failure AND terminal_failure
      THEN 'persistence_timeout_exhausted'
      ELSE coalesce(
        lower(nullif(left(btrim(_error_code), 100), '')),
        'event_persistence_failed'
      )
    END,
    error_message = CASE
      WHEN timeout_failure AND terminal_failure
      THEN 'Persistence statement timeout reached the bounded retry limit.'
      ELSE nullif(left(btrim(_error_message), 2000), '')
    END,
    finished_at = CASE WHEN terminal_failure THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = persistence.id;

  SELECT crawl.campaign_id, crawl.domain
  INTO campaign_id_value, domain_value
  FROM private.global_crawl_jobs AS crawl
  WHERE crawl.id = persistence.crawl_job_id;

  IF timeout_failure THEN
    PERFORM private.record_global_persistence_timeout_v1(
      domain_value,
      _error_code,
      _error_message
    );
  END IF;
  PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_global_event_persistence_job(
  UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_global_event_persistence_job(
  UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN
) TO service_role;

-- Preserve exhausted serialized-wrapper rows as recoverable terminal jobs,
-- matching the retry policy already enforced for the direct upsert path.
DO $migration$
DECLARE
  campaign_id_value UUID;
BEGIN
  FOR campaign_id_value IN
    WITH candidates AS MATERIALIZED (
      SELECT persistence.id, crawl.campaign_id
      FROM private.global_event_persistence_jobs AS persistence
      JOIN private.global_crawl_jobs AS crawl
        ON crawl.id = persistence.crawl_job_id
      WHERE persistence.status = 'queued'
        AND persistence.attempt_count >= 4
        AND private.is_global_persistence_timeout_v1(
          persistence.error_code,
          persistence.error_message
        )
      FOR UPDATE OF persistence
    ),
    failed AS (
      UPDATE private.global_event_persistence_jobs AS persistence
      SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        error_code = 'persistence_timeout_exhausted',
        error_message = 'Persistence statement timeout reached the bounded retry limit.',
        finished_at = now(),
        updated_at = now()
      FROM candidates
      WHERE persistence.id = candidates.id
      RETURNING candidates.campaign_id
    )
    SELECT DISTINCT failed.campaign_id
    FROM failed
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(campaign_id_value);
  END LOOP;
END;
$migration$;

COMMENT ON FUNCTION private.is_global_persistence_timeout_v1(TEXT, TEXT) IS
  'Recognizes bounded-retry PostgreSQL 57014 failures from direct and serialized event upsert RPCs.';
COMMENT ON FUNCTION public.fail_global_event_persistence_job(
  UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN
) IS
  'Fails or retries a leased persistence job, records direct or serialized 57014 timeouts, and enforces the four-attempt circuit-breaker cap.';

DO $smoke$
BEGIN
  IF NOT private.is_global_persistence_timeout_v1(
    'rpc_upsert_ingested_event_v2_failed',
    '57014: statement timeout'
  ) THEN
    RAISE EXCEPTION 'direct upsert timeout was not recognized';
  END IF;
  IF NOT private.is_global_persistence_timeout_v1(
    'rpc_upsert_ingested_event_serial_v1_failed',
    '57014: statement timeout'
  ) THEN
    RAISE EXCEPTION 'serialized upsert timeout was not recognized';
  END IF;
  IF private.is_global_persistence_timeout_v1(
    'rpc_upsert_ingested_event_serial_v1_failed',
    'P0001: unknown error'
  ) THEN
    RAISE EXCEPTION 'non-timeout serialized error was misclassified';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.fail_global_event_persistence_job(uuid,uuid,text,text,integer,boolean)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.fail_global_event_persistence_job(uuid,uuid,text,text,integer,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'persistence failure RPC leaked beyond service_role';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.fail_global_event_persistence_job(uuid,uuid,text,text,integer,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role lost persistence failure RPC access';
  END IF;
END;
$smoke$;
