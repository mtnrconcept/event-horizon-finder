-- Preserve every durable job while making worldwide discovery fair and each
-- pipeline stage independently drainable. Deferred jobs remain queued and can
-- be restored immediately through restore_deferred_global_crawl_jobs_v1().

CREATE OR REPLACE FUNCTION public.global_discovery_backlog()
RETURNS TABLE (
  search_backlog BIGINT,
  crawl_backlog BIGINT,
  persistence_backlog BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (
      SELECT count(*)
      FROM private.global_search_jobs AS job
      WHERE (job.status = 'queued' AND job.available_at <= now())
         OR (job.status = 'leased' AND job.lease_expires_at > now())
    ),
    (
      SELECT count(*)
      FROM private.global_crawl_jobs AS job
      WHERE (job.status = 'queued' AND job.available_at <= now())
         OR (job.status = 'leased' AND job.lease_expires_at > now())
    ),
    (
      SELECT count(*)
      FROM private.global_event_persistence_jobs AS job
      WHERE (job.status = 'queued' AND job.available_at <= now())
         OR (job.status = 'leased' AND job.lease_expires_at > now())
    );
$$;

CREATE OR REPLACE FUNCTION public.claim_global_search_jobs(
  _worker_id UUID,
  _limit INTEGER DEFAULT 5,
  _lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
  job_id UUID,
  campaign_id UUID,
  city_id UUID,
  query_kind TEXT,
  query_text TEXT,
  query_locale TEXT,
  provider TEXT,
  cache_key TEXT,
  attempt_count INTEGER,
  max_attempts INTEGER,
  cached_results JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  exhausted_campaign RECORD;
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  FOR exhausted_campaign IN
    UPDATE private.global_search_jobs AS job
    SET
      status = 'failed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = coalesce(job.error_code, 'lease_expired'),
      error_message = coalesce(job.error_message, 'Worker lease expired after the final attempt.'),
      finished_at = now(),
      updated_at = now()
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= now()
      AND job.attempt_count >= job.max_attempts
    RETURNING job.campaign_id
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(exhausted_campaign.campaign_id);
  END LOOP;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      job.id,
      row_number() OVER (
        PARTITION BY city.country_id, job.query_kind
        ORDER BY job.priority DESC, job.available_at, job.created_at, job.id
      ) AS country_family_rank
    FROM private.global_search_jobs AS job
    JOIN private.global_scrape_campaigns AS campaign
      ON campaign.id = job.campaign_id
    JOIN public.cities AS city
      ON city.id = job.city_id
    WHERE campaign.status IN ('queued', 'running')
      AND job.available_at <= now()
      AND job.attempt_count < job.max_attempts
      AND (
        job.status = 'queued'
        OR (job.status = 'leased' AND job.lease_expires_at <= now())
      )
  ),
  candidates AS MATERIALIZED (
    SELECT job.id
    FROM eligible
    JOIN private.global_search_jobs AS job ON job.id = eligible.id
    ORDER BY
      eligible.country_family_rank,
      md5(job.city_id::TEXT || '|' || job.query_kind || '|' || job.id::TEXT)
    LIMIT greatest(1, least(coalesce(_limit, 5), 50))
    FOR UPDATE OF job SKIP LOCKED
  ),
  claimed AS (
    UPDATE private.global_search_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_owner = _worker_id,
      lease_expires_at = now() + make_interval(
        secs => greatest(30, least(coalesce(_lease_seconds, 120), 900))
      ),
      started_at = coalesce(job.started_at, now()),
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.campaign_id,
    claimed.city_id,
    claimed.query_kind,
    claimed.query_text,
    claimed.query_locale,
    claimed.provider,
    claimed.cache_key,
    claimed.attempt_count::INTEGER,
    claimed.max_attempts::INTEGER,
    cache.results
  FROM claimed
  LEFT JOIN private.global_search_cache AS cache
    ON cache.cache_key = claimed.cache_key
   AND cache.provider = claimed.provider
   AND cache.expires_at > now()
  ORDER BY claimed.created_at, claimed.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_global_search_jobs(
  _worker_id UUID,
  _limit INTEGER,
  _lease_seconds INTEGER,
  _max_crawl_backlog INTEGER
)
RETURNS TABLE (
  job_id UUID,
  campaign_id UUID,
  city_id UUID,
  query_kind TEXT,
  query_text TEXT,
  query_locale TEXT,
  provider TEXT,
  cache_key TEXT,
  attempt_count INTEGER,
  max_attempts INTEGER,
  cached_results JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  crawl_backlog BIGINT;
  active_search_reservations BIGINT;
  search_capacity INTEGER;
  backlog_limit INTEGER := greatest(100, least(coalesce(_max_crawl_backlog, 5000), 250000));
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global_discovery_search_admission_v1', 0)
  );

  SELECT count(*) INTO crawl_backlog
  FROM private.global_crawl_jobs AS crawl
  WHERE (crawl.status = 'queued' AND crawl.available_at <= now())
     OR (crawl.status = 'leased' AND crawl.lease_expires_at > now());

  SELECT count(*) INTO active_search_reservations
  FROM private.global_search_jobs AS search
  WHERE search.status = 'leased'
    AND search.lease_expires_at > now();

  search_capacity := greatest(
    0,
    floor((backlog_limit - crawl_backlog - active_search_reservations * 10)::NUMERIC / 10)::INTEGER
  );
  IF search_capacity = 0 THEN RETURN; END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_global_search_jobs(
    _worker_id,
    least(greatest(1, coalesce(_limit, 5)), search_capacity),
    _lease_seconds
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rebalance_global_discovery_backlog_v1(
  _per_domain_ready_limit INTEGER DEFAULT 25,
  _defer_step_hours INTEGER DEFAULT 6,
  _batch_limit INTEGER DEFAULT 10000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ready_limit INTEGER := greatest(5, least(coalesce(_per_domain_ready_limit, 25), 250));
  step_hours INTEGER := greatest(1, least(coalesce(_defer_step_hours, 6), 24));
  batch_limit INTEGER := greatest(1, least(coalesce(_batch_limit, 10000), 50000));
  before_ready BIGINT;
  after_ready BIGINT;
  deferred_count INTEGER := 0;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global_discovery_backlog_rebalance_v1', 0)
  );

  SELECT count(*) INTO before_ready
  FROM private.global_crawl_jobs AS job
  WHERE job.status = 'queued' AND job.available_at <= now();

  WITH ranked AS MATERIALIZED (
    SELECT
      job.id,
      row_number() OVER (
        PARTITION BY job.domain
        ORDER BY
          CASE job.crawl_kind WHEN 'search_result' THEN 0 WHEN 'event' THEN 1 ELSE 2 END,
          job.crawl_depth,
          job.priority DESC,
          job.available_at,
          job.created_at,
          job.id
      ) AS domain_rank
    FROM private.global_crawl_jobs AS job
    WHERE job.status = 'queued'
      AND job.available_at <= now()
  ),
  selected AS MATERIALIZED (
    SELECT ranked.id, ranked.domain_rank
    FROM ranked
    WHERE ranked.domain_rank > ready_limit
    ORDER BY ranked.domain_rank DESC, ranked.id
    LIMIT batch_limit
  )
  UPDATE private.global_crawl_jobs AS job
  SET
    available_at = greatest(
      job.available_at,
      now() + make_interval(
        hours => least(720, step_hours * floor((selected.domain_rank - 1)::NUMERIC / ready_limit)::INTEGER)
      )
    ),
    priority = greatest(
      -32000,
      least(
        32000,
        CASE job.crawl_kind
          WHEN 'search_result' THEN 900
          WHEN 'event' THEN 700 - least(job.crawl_depth, 20) * 10
          ELSE 300 - least(job.crawl_depth, 20) * 10
        END + greatest(-99, least(job.priority, 99))
      )
    )::SMALLINT,
    updated_at = now()
  FROM selected
  WHERE job.id = selected.id;
  GET DIAGNOSTICS deferred_count = ROW_COUNT;

  SELECT count(*) INTO after_ready
  FROM private.global_crawl_jobs AS job
  WHERE job.status = 'queued' AND job.available_at <= now();

  RETURN jsonb_build_object(
    'ok', true,
    'ready_before', before_ready,
    'ready_after', after_ready,
    'deferred', deferred_count,
    'per_domain_ready_limit', ready_limit,
    'defer_step_hours', step_hours
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_deferred_global_crawl_jobs_v1(
  _domain TEXT DEFAULT NULL,
  _limit INTEGER DEFAULT 10000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  restored INTEGER := 0;
BEGIN
  WITH selected AS MATERIALIZED (
    SELECT job.id
    FROM private.global_crawl_jobs AS job
    WHERE job.status = 'queued'
      AND job.available_at > now()
      AND (_domain IS NULL OR job.domain = lower(trim(_domain)))
    ORDER BY job.available_at, job.created_at, job.id
    LIMIT greatest(1, least(coalesce(_limit, 10000), 50000))
    FOR UPDATE OF job SKIP LOCKED
  )
  UPDATE private.global_crawl_jobs AS job
  SET available_at = now(), updated_at = now()
  FROM selected
  WHERE job.id = selected.id;
  GET DIAGNOSTICS restored = ROW_COUNT;
  RETURN restored;
END;
$$;

ALTER TABLE private.global_discovery_scheduler_state
  DROP CONSTRAINT IF EXISTS global_discovery_scheduler_external_action_check;
ALTER TABLE private.global_discovery_scheduler_state
  ADD CONSTRAINT global_discovery_scheduler_external_action_check
  CHECK (
    last_external_action IS NULL
    OR last_external_action IN ('plan', 'search', 'persistence', 'crawl')
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
  IF coalesce(_action, '') NOT IN ('plan', 'search', 'persistence', 'crawl') THEN
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

  FOR worker_index IN 1..3 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id, endpoint,
      jsonb_build_object(
        'action', 'persistence', 'batch_size', 8,
        'scheduler_dispatch_id', dispatch_id, 'scheduler_worker', worker_index
      ), 120000
    ) INTO request_id;
    request_ids := array_append(request_ids, request_id);
  END LOOP;

  FOR worker_index IN 1..3 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id, endpoint,
      jsonb_build_object(
        'action', 'crawl', 'batch_size', 1,
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

REVOKE ALL ON FUNCTION public.global_discovery_backlog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebalance_global_discovery_backlog_v1(INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_deferred_global_crawl_jobs_v1(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.dispatch_global_discovery_fallback_v1()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.global_discovery_backlog() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rebalance_global_discovery_backlog_v1(INTEGER, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_deferred_global_crawl_jobs_v1(TEXT, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.rebalance_global_discovery_backlog_v1(INTEGER, INTEGER, INTEGER) IS
  'Preserves queued Crawl jobs while keeping a shallow, source-diverse executable lane per domain and staggering excess continuations.';
COMMENT ON FUNCTION public.restore_deferred_global_crawl_jobs_v1(TEXT, INTEGER) IS
  'Reverses temporary Crawl deferrals without deleting or recreating durable jobs.';
COMMENT ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER) IS
  'Claims Search jobs fairly across country and category cells before revisiting the same cell.';
COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Dispatches plan, search, three persistence workers and three crawl workers when external discovery is inactive.';

-- Apply the reversible ordering once to the existing queue. No rows are
-- deleted or made terminal; excess jobs remain queued for gradual replay.
SELECT public.rebalance_global_discovery_backlog_v1(25, 6, 10000);
