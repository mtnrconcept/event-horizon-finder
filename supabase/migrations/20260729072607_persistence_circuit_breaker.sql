-- Protect event persistence from retry storms and advisory-lock contention.
--
-- Domains with repeated PostgreSQL statement timeouts are paused without
-- deleting their jobs. After a bounded cooldown, the existing queue supplies a
-- probe. A successful probe closes the circuit; another timeout reopens it.

CREATE TABLE IF NOT EXISTS private.global_persistence_domain_circuit_breakers (
  domain TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed',
  consecutive_timeouts INTEGER NOT NULL DEFAULT 0,
  opened_count INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ,
  open_until TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_persistence_domain_circuit_domain_check
    CHECK (
      domain = lower(domain)
      AND domain !~ '[/@:[:space:]]'
      AND length(domain) BETWEEN 1 AND 253
    ),
  CONSTRAINT global_persistence_domain_circuit_state_check
    CHECK (state IN ('closed', 'open')),
  CONSTRAINT global_persistence_domain_circuit_counter_check
    CHECK (consecutive_timeouts >= 0 AND opened_count >= 0),
  CONSTRAINT global_persistence_domain_circuit_open_check
    CHECK (state = 'closed' OR open_until IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS global_persistence_domain_circuit_open_idx
  ON private.global_persistence_domain_circuit_breakers (open_until, domain)
  WHERE state = 'open';

ALTER TABLE private.global_persistence_domain_circuit_breakers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.global_persistence_domain_circuit_breakers
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.record_global_persistence_timeout_v1(
  _domain TEXT,
  _error_code TEXT,
  _error_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_domain TEXT := private.global_discovery_hostname(_domain);
  breaker private.global_persistence_domain_circuit_breakers%ROWTYPE;
  next_timeout_count INTEGER;
  should_open BOOLEAN;
  next_open_until TIMESTAMPTZ;
BEGIN
  IF normalized_domain IS NULL
    OR normalized_domain ~ '[/@:[:space:]]'
    OR length(normalized_domain) > 253
  THEN
    RAISE EXCEPTION 'invalid_persistence_circuit_domain' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.global_persistence_domain_circuit_breakers (domain)
  VALUES (normalized_domain)
  ON CONFLICT (domain) DO NOTHING;

  SELECT circuit.*
  INTO breaker
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  WHERE circuit.domain = normalized_domain
  FOR UPDATE;

  next_timeout_count := CASE
    WHEN breaker.last_failure_at IS NULL
      OR breaker.last_failure_at < now() - interval '15 minutes'
    THEN 1
    ELSE breaker.consecutive_timeouts + 1
  END;
  should_open := next_timeout_count >= 3
    OR (
      breaker.state = 'open'
      AND breaker.open_until IS NOT NULL
      AND breaker.open_until <= now()
    );
  next_open_until := CASE
    WHEN should_open THEN greatest(
      coalesce(breaker.open_until, now()),
      now() + interval '2 hours'
    )
    ELSE breaker.open_until
  END;

  UPDATE private.global_persistence_domain_circuit_breakers AS circuit
  SET
    state = CASE WHEN should_open THEN 'open' ELSE circuit.state END,
    consecutive_timeouts = next_timeout_count,
    opened_count = circuit.opened_count + CASE
      WHEN should_open
        AND (breaker.state <> 'open' OR breaker.open_until IS NULL OR breaker.open_until <= now())
      THEN 1
      ELSE 0
    END,
    opened_at = CASE
      WHEN should_open
        AND (breaker.state <> 'open' OR breaker.open_until IS NULL OR breaker.open_until <= now())
      THEN now()
      ELSE circuit.opened_at
    END,
    open_until = next_open_until,
    last_failure_at = now(),
    last_error_code = nullif(left(btrim(coalesce(_error_code, '')), 100), ''),
    last_error_message = nullif(left(btrim(coalesce(_error_message, '')), 500), ''),
    updated_at = now()
  WHERE circuit.domain = normalized_domain
  RETURNING circuit.* INTO breaker;

  IF breaker.state = 'open' AND breaker.open_until > now() THEN
    UPDATE private.global_domain_crawl_state AS state
    SET
      next_allowed_at = greatest(state.next_allowed_at, breaker.open_until),
      updated_at = now()
    WHERE state.domain = normalized_domain;

    UPDATE private.global_event_persistence_jobs AS persistence
    SET
      available_at = greatest(persistence.available_at, breaker.open_until),
      updated_at = now()
    FROM private.global_crawl_jobs AS crawl
    WHERE crawl.id = persistence.crawl_job_id
      AND crawl.domain = normalized_domain
      AND persistence.status = 'queued'
      AND persistence.available_at < breaker.open_until;
  END IF;

  RETURN jsonb_build_object(
    'domain', breaker.domain,
    'state', breaker.state,
    'consecutive_timeouts', breaker.consecutive_timeouts,
    'opened_count', breaker.opened_count,
    'open_until', breaker.open_until
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.record_global_persistence_success_v1(
  _domain TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_domain TEXT := private.global_discovery_hostname(_domain);
BEGIN
  IF normalized_domain IS NULL THEN
    RETURN;
  END IF;

  -- An in-flight success must not cancel a freshly opened cooldown. Only a
  -- probe that runs after the cooldown may close the circuit.
  UPDATE private.global_persistence_domain_circuit_breakers AS circuit
  SET
    state = 'closed',
    consecutive_timeouts = 0,
    open_until = NULL,
    last_success_at = now(),
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now()
  WHERE circuit.domain = normalized_domain
    AND (circuit.open_until IS NULL OR circuit.open_until <= now());
END;
$$;

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
  active_leases INTEGER;
  available_slots INTEGER;
  claim_limit INTEGER;
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  -- Serialize admission, then keep no more than two persistence upserts leased
  -- at once. Each worker receives at most one job so the two slots can be
  -- shared by independent workers instead of processed serially by one worker.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global_event_persistence_admission_v1', 0)
  );

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

  -- Timeout retries are capped at four attempts. Rows remain available for
  -- audit or an explicit, recoverable requeue.
  FOR exhausted IN
    WITH candidates AS MATERIALIZED (
      SELECT persistence.id, crawl.campaign_id
      FROM private.global_event_persistence_jobs AS persistence
      JOIN private.global_crawl_jobs AS crawl
        ON crawl.id = persistence.crawl_job_id
      WHERE persistence.status = 'queued'
        AND persistence.attempt_count >= 4
        AND persistence.error_code = 'rpc_upsert_ingested_event_v2_failed'
        AND persistence.error_message LIKE '57014:%'
      ORDER BY persistence.updated_at, persistence.id
      LIMIT 500
      FOR UPDATE OF persistence SKIP LOCKED
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
    SELECT DISTINCT failed.campaign_id FROM failed
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(exhausted.campaign_id);
  END LOOP;

  SELECT count(*)::INTEGER
  INTO active_leases
  FROM private.global_event_persistence_jobs AS persistence
  WHERE persistence.status = 'leased'
    AND persistence.lease_expires_at > now();

  available_slots := greatest(0, 2 - active_leases);
  claim_limit := least(
    1,
    available_slots,
    greatest(1, least(coalesce(_limit, 20), 100))
  );
  IF claim_limit <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT persistence.id
    FROM private.global_event_persistence_jobs AS persistence
    JOIN private.global_crawl_jobs AS crawl
      ON crawl.id = persistence.crawl_job_id
    WHERE persistence.available_at <= now()
      AND persistence.attempt_count < persistence.max_attempts
      AND (
        persistence.status = 'queued'
        OR (
          persistence.status = 'leased'
          AND persistence.lease_expires_at <= now()
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM private.global_persistence_domain_circuit_breakers AS circuit
        WHERE circuit.domain = crawl.domain
          AND circuit.state = 'open'
          AND circuit.open_until > now()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM private.global_event_persistence_jobs AS active
        JOIN private.global_crawl_jobs AS active_crawl
          ON active_crawl.id = active.crawl_job_id
        WHERE active.status = 'leased'
          AND active.lease_expires_at > now()
          AND lower(active_crawl.domain) = lower(crawl.domain)
          AND active.id IS DISTINCT FROM persistence.id
      )
    ORDER BY persistence.available_at, persistence.created_at, persistence.id
    LIMIT claim_limit
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
  domain_value TEXT;
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

  SELECT crawl.campaign_id, crawl.domain
  INTO campaign_id_value, domain_value
  FROM private.global_crawl_jobs AS crawl
  WHERE crawl.id = persistence.crawl_job_id;

  PERFORM private.record_global_persistence_success_v1(domain_value);
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

  timeout_failure :=
    lower(btrim(coalesce(_error_code, ''))) = 'rpc_upsert_ingested_event_v2_failed'
    AND coalesce(_error_message, '') LIKE '57014:%';
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

CREATE OR REPLACE FUNCTION public.global_persistence_circuit_breaker_status_v1()
RETURNS TABLE (
  domain TEXT,
  state TEXT,
  consecutive_timeouts INTEGER,
  opened_count INTEGER,
  opened_at TIMESTAMPTZ,
  open_until TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  queued_jobs BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    circuit.domain,
    circuit.state,
    circuit.consecutive_timeouts,
    circuit.opened_count,
    circuit.opened_at,
    circuit.open_until,
    circuit.last_failure_at,
    circuit.last_success_at,
    count(persistence.id) FILTER (WHERE persistence.status = 'queued')
  FROM private.global_persistence_domain_circuit_breakers AS circuit
  LEFT JOIN private.global_crawl_jobs AS crawl
    ON crawl.domain = circuit.domain
  LEFT JOIN private.global_event_persistence_jobs AS persistence
    ON persistence.crawl_job_id = crawl.id
  GROUP BY
    circuit.domain,
    circuit.state,
    circuit.consecutive_timeouts,
    circuit.opened_count,
    circuit.opened_at,
    circuit.open_until,
    circuit.last_failure_at,
    circuit.last_success_at
  ORDER BY
    (circuit.state = 'open' AND circuit.open_until > now()) DESC,
    circuit.last_failure_at DESC NULLS LAST,
    circuit.domain;
$$;

-- Open the two currently confirmed hot sources immediately. Their queued work
-- is retained and postponed for a controlled probe after the cooldown.
INSERT INTO private.global_persistence_domain_circuit_breakers (
  domain,
  state,
  consecutive_timeouts,
  opened_count,
  opened_at,
  open_until,
  last_failure_at,
  last_error_code,
  last_error_message
)
VALUES
  (
    'whatson.cityofsydney.nsw.gov.au',
    'open',
    3,
    1,
    now(),
    now() + interval '2 hours',
    now(),
    'rpc_upsert_ingested_event_v2_failed',
    '57014: statement timeout circuit breaker'
  ),
  (
    'agenda.lesoir.be',
    'open',
    3,
    1,
    now(),
    now() + interval '2 hours',
    now(),
    'rpc_upsert_ingested_event_v2_failed',
    '57014: statement timeout circuit breaker'
  )
ON CONFLICT (domain) DO UPDATE
SET
  state = 'open',
  consecutive_timeouts = greatest(
    private.global_persistence_domain_circuit_breakers.consecutive_timeouts,
    EXCLUDED.consecutive_timeouts
  ),
  opened_count = private.global_persistence_domain_circuit_breakers.opened_count + CASE
    WHEN private.global_persistence_domain_circuit_breakers.state <> 'open'
      OR private.global_persistence_domain_circuit_breakers.open_until IS NULL
      OR private.global_persistence_domain_circuit_breakers.open_until <= now()
    THEN 1
    ELSE 0
  END,
  opened_at = CASE
    WHEN private.global_persistence_domain_circuit_breakers.state <> 'open'
      OR private.global_persistence_domain_circuit_breakers.open_until IS NULL
      OR private.global_persistence_domain_circuit_breakers.open_until <= now()
    THEN now()
    ELSE private.global_persistence_domain_circuit_breakers.opened_at
  END,
  open_until = greatest(
    coalesce(private.global_persistence_domain_circuit_breakers.open_until, now()),
    EXCLUDED.open_until
  ),
  last_failure_at = now(),
  last_error_code = EXCLUDED.last_error_code,
  last_error_message = EXCLUDED.last_error_message,
  updated_at = now();

UPDATE private.global_domain_crawl_state AS state
SET
  next_allowed_at = greatest(state.next_allowed_at, circuit.open_until),
  updated_at = now()
FROM private.global_persistence_domain_circuit_breakers AS circuit
WHERE circuit.domain = state.domain
  AND circuit.state = 'open'
  AND circuit.open_until > now();

UPDATE private.global_event_persistence_jobs AS persistence
SET
  available_at = greatest(persistence.available_at, circuit.open_until),
  updated_at = now()
FROM private.global_crawl_jobs AS crawl
JOIN private.global_persistence_domain_circuit_breakers AS circuit
  ON circuit.domain = crawl.domain
WHERE crawl.id = persistence.crawl_job_id
  AND persistence.status = 'queued'
  AND circuit.state = 'open'
  AND circuit.open_until > now();

REVOKE ALL ON FUNCTION private.record_global_persistence_timeout_v1(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.record_global_persistence_success_v1(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_persistence_circuit_breaker_status_v1()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_persistence_circuit_breaker_status_v1()
  TO service_role;

COMMENT ON TABLE private.global_persistence_domain_circuit_breakers IS
  'Private, recoverable per-domain persistence timeout circuit state.';
COMMENT ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER) IS
  'Claims at most one job per worker and two globally, while excluding open persistence circuits.';
COMMENT ON FUNCTION public.global_persistence_circuit_breaker_status_v1() IS
  'Reports private per-domain persistence circuit state and queued work; service-role only.';
