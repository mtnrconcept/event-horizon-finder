-- Independent Supabase Cron fallback for worldwide discovery.
--
-- GitHub Actions schedule delivery is best-effort and has been observed to
-- collapse the configured 15-minute cadence into isolated hourly runs. This
-- migration installs a second, bounded trigger inside Supabase. The database
-- generates short-lived one-time credentials inside Postgres; no plaintext
-- secret is committed, persisted after delivery or exposed through the Data
-- API.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS private.global_discovery_scheduler_tokens (
  token_hash TEXT PRIMARY KEY,
  dispatch_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_discovery_scheduler_token_hash_check
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT global_discovery_scheduler_token_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT global_discovery_scheduler_token_claim_check
    CHECK (claimed_at IS NULL OR claimed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS global_discovery_scheduler_tokens_expiry_idx
  ON private.global_discovery_scheduler_tokens (expires_at);

CREATE TABLE IF NOT EXISTS private.global_discovery_scheduler_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  last_dispatched_at TIMESTAMPTZ,
  last_dispatch_id UUID,
  last_request_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  last_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_discovery_scheduler_request_ids_check
    CHECK (cardinality(last_request_ids) <= 16),
  CONSTRAINT global_discovery_scheduler_metrics_check
    CHECK (
      jsonb_typeof(last_metrics) = 'object'
      AND pg_column_size(last_metrics) <= 65536
    )
);

CREATE TABLE IF NOT EXISTS private.global_discovery_scheduler_dispatches (
  id UUID PRIMARY KEY,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_ids BIGINT[] NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT global_discovery_scheduler_dispatch_request_ids_check
    CHECK (cardinality(request_ids) BETWEEN 1 AND 16),
  CONSTRAINT global_discovery_scheduler_dispatch_metrics_check
    CHECK (
      jsonb_typeof(metrics) = 'object'
      AND pg_column_size(metrics) <= 65536
    )
);

CREATE INDEX IF NOT EXISTS global_discovery_scheduler_dispatches_time_idx
  ON private.global_discovery_scheduler_dispatches (dispatched_at DESC);

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_recent_yield_idx
  ON private.global_event_persistence_jobs (
    finished_at DESC,
    persistence_action
  )
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS events_created_at_idx
  ON public.events (created_at DESC);

ALTER TABLE private.global_discovery_scheduler_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_discovery_scheduler_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_discovery_scheduler_dispatches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.global_discovery_scheduler_tokens
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.global_discovery_scheduler_state
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.global_discovery_scheduler_dispatches
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.global_discovery_scheduler_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_global_discovery_scheduler_token_v1(
  _token_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH claimed AS (
    UPDATE private.global_discovery_scheduler_tokens AS token
    SET claimed_at = now()
    WHERE token.token_hash = lower(coalesce(_token_hash, ''))
      AND coalesce(_token_hash, '') ~ '^[a-f0-9]{64}$'
      AND token.claimed_at IS NULL
      AND token.expires_at >= now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

CREATE OR REPLACE FUNCTION public.global_discovery_health_v1()
RETURNS TABLE (
  checked_at TIMESTAMPTZ,
  last_event_created_at TIMESTAMPTZ,
  events_created_90m BIGINT,
  persistence_completed_90m BIGINT,
  persistence_created_90m BIGINT,
  persistence_updated_90m BIGINT,
  zero_creation_alert BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH event_metrics AS (
    SELECT
      max(event.created_at) AS last_event_created_at,
      count(*) FILTER (
        WHERE event.created_at >= now() - interval '90 minutes'
      ) AS events_created_90m
    FROM public.events AS event
  ),
  persistence_metrics AS (
    SELECT
      count(*) FILTER (
        WHERE job.status = 'completed'
          AND job.finished_at >= now() - interval '90 minutes'
      ) AS completed_90m,
      count(*) FILTER (
        WHERE job.status = 'completed'
          AND job.persistence_action = 'created'
          AND job.finished_at >= now() - interval '90 minutes'
      ) AS created_90m,
      count(*) FILTER (
        WHERE job.status = 'completed'
          AND job.persistence_action = 'updated'
          AND job.finished_at >= now() - interval '90 minutes'
      ) AS updated_90m
    FROM private.global_event_persistence_jobs AS job
  )
  SELECT
    now(),
    event_metrics.last_event_created_at,
    event_metrics.events_created_90m,
    persistence_metrics.completed_90m,
    persistence_metrics.created_90m,
    persistence_metrics.updated_90m,
    persistence_metrics.completed_90m >= 100
      AND persistence_metrics.created_90m = 0
  FROM event_metrics
  CROSS JOIN persistence_metrics;
$$;

CREATE OR REPLACE FUNCTION public.global_discovery_scheduler_status_v1()
RETURNS TABLE (
  last_dispatched_at TIMESTAMPTZ,
  last_dispatch_id UUID,
  requested_count INTEGER,
  responded_count BIGINT,
  succeeded_count BIGINT,
  failed_count BIGINT,
  metrics JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    state.last_dispatched_at,
    state.last_dispatch_id,
    cardinality(state.last_request_ids),
    count(response.id),
    count(response.id) FILTER (
      WHERE response.error_msg IS NULL
        AND response.status_code BETWEEN 200 AND 299
    ),
    count(response.id) FILTER (
      WHERE response.error_msg IS NOT NULL
        OR response.status_code NOT BETWEEN 200 AND 299
    ),
    state.last_metrics
  FROM private.global_discovery_scheduler_state AS state
  LEFT JOIN LATERAL unnest(state.last_request_ids) AS request(request_id)
    ON true
  LEFT JOIN net._http_response AS response
    ON response.id = request.request_id
  WHERE state.singleton
  GROUP BY
    state.last_dispatched_at,
    state.last_dispatch_id,
    state.last_request_ids,
    state.last_metrics;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_global_discovery_http_request_v1(
  _dispatch_id UUID,
  _endpoint TEXT,
  _body JSONB,
  _timeout_milliseconds INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_token TEXT := encode(extensions.gen_random_bytes(32), 'hex');
  request_token_hash TEXT;
  request_id BIGINT;
BEGIN
  IF _dispatch_id IS NULL
    OR _endpoint <> 'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/global-event-discovery'
    OR jsonb_typeof(_body) <> 'object'
    OR _timeout_milliseconds NOT BETWEEN 1000 AND 300000
  THEN
    RAISE EXCEPTION 'invalid global discovery scheduler request';
  END IF;

  request_token_hash := encode(extensions.digest(request_token, 'sha256'), 'hex');

  INSERT INTO private.global_discovery_scheduler_tokens (
    token_hash,
    dispatch_id,
    expires_at
  )
  VALUES (
    request_token_hash,
    _dispatch_id,
    now() + interval '10 minutes'
  );

  SELECT net.http_post(
    url := _endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'Partyfinder-Supabase-Cron/1.0',
      'x-global-discovery-cron-token', request_token
    ),
    body := _body,
    timeout_milliseconds := _timeout_milliseconds
  )
  INTO request_id;

  RETURN request_id;
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

  IF state_row.last_dispatched_at IS NOT NULL
    AND state_row.last_dispatched_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dispatched', false,
      'reason', 'recent_dispatch',
      'last_dispatched_at', state_row.last_dispatched_at
    );
  END IF;

  SELECT to_jsonb(health)
  INTO metrics
  FROM public.global_discovery_health_v1() AS health;

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

  -- Six parallel crawl calls keep total Edge concurrency at eight. Every call
  -- drains up to 25 persistence jobs before it may claim two network crawls.
  FOR worker_index IN 1..6 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id,
      endpoint,
      jsonb_build_object(
        'action', 'crawl',
        'batch_size', 2,
        'persistence_limit', 25,
        'scheduler_dispatch_id', dispatch_id,
        'scheduler_worker', worker_index
      ),
      240000
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
    coalesce(metrics, '{}'::JSONB)
  );

  UPDATE private.global_discovery_scheduler_state
  SET
    last_dispatched_at = now(),
    last_dispatch_id = dispatch_id,
    last_request_ids = request_ids,
    last_metrics = coalesce(metrics, '{}'::JSONB),
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
    'metrics', metrics
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_global_discovery_scheduler_token_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_discovery_health_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_discovery_scheduler_status_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.dispatch_global_discovery_fallback_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.enqueue_global_discovery_http_request_v1(UUID, TEXT, JSONB, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.claim_global_discovery_scheduler_token_v1(TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_discovery_health_v1()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_discovery_scheduler_status_v1()
  TO service_role;

COMMENT ON FUNCTION public.claim_global_discovery_scheduler_token_v1(TEXT) IS
  'Atomically consumes the SHA-256 fingerprint of a ten-minute one-time scheduler token; service-role only.';
COMMENT ON FUNCTION public.global_discovery_health_v1() IS
  'Reports created versus updated persistence yield and raises a zero-creation alert after 100 processed jobs in 90 minutes.';
COMMENT ON FUNCTION public.global_discovery_scheduler_status_v1() IS
  'Reports the last bounded Supabase Cron dispatch and its asynchronous HTTP outcomes; service-role only.';
COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Dispatches one locked, bounded eight-request worldwide discovery slice through pg_net.';
COMMENT ON FUNCTION private.enqueue_global_discovery_http_request_v1(UUID, TEXT, JSONB, INTEGER) IS
  'Creates a short-lived one-time bearer, stores only its hash and enqueues one fixed-origin pg_net request.';

DO $replace_scheduler_job$
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

  PERFORM cron.schedule(
    'global-discovery-supabase-fallback',
    '7,22,37,52 * * * *',
    $cron$SELECT private.dispatch_global_discovery_fallback_v1();$cron$
  );
END;
$replace_scheduler_job$;
