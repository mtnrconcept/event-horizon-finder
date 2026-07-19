-- Durable event-level persistence, redirect handoffs, queue admission and
-- bounded retention for worldwide discovery.

CREATE TABLE IF NOT EXISTS private.global_event_persistence_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_job_id UUID NOT NULL
    REFERENCES private.global_crawl_jobs(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL
    REFERENCES public.data_sources(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 6,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  persistence_action TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  first_completed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_event_persistence_jobs_identity_unique
    UNIQUE (crawl_job_id, event_key),
  CONSTRAINT global_event_persistence_jobs_key_check
    CHECK (event_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT global_event_persistence_jobs_payload_check
    CHECK (
      jsonb_typeof(event_payload) = 'object'
      AND pg_column_size(event_payload) <= 262144
    ),
  CONSTRAINT global_event_persistence_jobs_status_check
    CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
  CONSTRAINT global_event_persistence_jobs_attempts_check
    CHECK (attempt_count BETWEEN 0 AND 100 AND max_attempts BETWEEN 1 AND 100),
  CONSTRAINT global_event_persistence_jobs_action_check
    CHECK (
      persistence_action IS NULL
      OR persistence_action ~ '^[a-z][a-z0-9_-]{0,63}$'
    ),
  CONSTRAINT global_event_persistence_jobs_lease_check
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR status <> 'leased'
    )
);

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_claim_idx
  ON private.global_event_persistence_jobs (available_at, created_at, id)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_crawl_status_idx
  ON private.global_event_persistence_jobs (crawl_job_id, status);

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_expired_lease_idx
  ON private.global_event_persistence_jobs (lease_expires_at)
  WHERE status = 'leased';

ALTER TABLE private.global_event_persistence_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.global_event_persistence_jobs
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.should_reopen_global_event_persistence_v1(
  _status TEXT,
  _old_payload JSONB,
  _new_payload JSONB,
  _finished_at TIMESTAMPTZ,
  _updated_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    (
      _status = 'completed'
      AND _old_payload IS DISTINCT FROM _new_payload
    )
    OR (
      _status IN ('failed', 'cancelled')
      AND coalesce(_finished_at, _updated_at) <= now() - interval '24 hours'
    );
$$;

CREATE OR REPLACE FUNCTION public.enqueue_global_event_persistence_jobs(
  _parent_job_id UUID,
  _worker_id UUID,
  _data_source_id UUID,
  _events JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parent_job private.global_crawl_jobs%ROWTYPE;
  item JSONB;
  event_value JSONB;
  event_key_value TEXT;
  source_url_value TEXT;
  source_hostname_value TEXT;
  accepted_count INTEGER := 0;
BEGIN
  IF _worker_id IS NULL
    OR _data_source_id IS NULL
    OR jsonb_typeof(_events) IS DISTINCT FROM 'array'
    OR jsonb_array_length(_events) > 50
    OR pg_column_size(_events) > 2097152
  THEN
    RAISE EXCEPTION 'invalid_event_persistence_batch' USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO parent_job
  FROM private.global_crawl_jobs AS job
  WHERE job.id = _parent_job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_job_lease_not_owned' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.data_sources AS source
    WHERE source.id = _data_source_id
      AND source.city_id = parent_job.city_id
      AND lower(source.domain) = parent_job.domain
      AND source.status = 'active'
      AND source.is_authorized
      AND source.is_verified
      AND coalesce(source.metadata->>'global_discovery', 'false') = 'true'
      AND coalesce(source.metadata->>'automated_discovery', 'false') = 'true'
      AND source.metadata->>'verification_scope' = 'crawl_eligibility_only'
  ) THEN
    RAISE EXCEPTION 'invalid_event_persistence_source' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(_events)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_event_persistence_item' USING ERRCODE = '22023';
    END IF;

    event_key_value := lower(btrim(coalesce(item->>'event_key', '')));
    event_value := item->'event';
    source_url_value := left(
      btrim(coalesce(event_value->'source'->>'source_url', '')),
      2000
    );
    source_hostname_value := nullif(lower(rtrim(
      substring(source_url_value FROM '^https?://([^/?#:]+)'),
      '.'
    )), '');

    IF event_key_value !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(event_value) IS DISTINCT FROM 'object'
      OR pg_column_size(event_value) > 262144
      OR jsonb_typeof(event_value->'payload') IS DISTINCT FROM 'object'
      OR jsonb_typeof(event_value->'source') IS DISTINCT FROM 'object'
      OR length(btrim(coalesce(event_value->'source'->>'title', ''))) < 2
      OR coalesce(event_value->'source'->>'fingerprint', '') = ''
      OR coalesce(event_value->'source'->>'starts_at', '') = ''
      OR coalesce(event_value->'payload'->>'source_url', '')
        IS DISTINCT FROM source_url_value
      OR source_url_value !~* '^https?://[^[:space:]]+$'
      OR source_hostname_value IS DISTINCT FROM parent_job.domain
    THEN
      RAISE EXCEPTION 'invalid_event_persistence_item: %', item USING ERRCODE = '22023';
    END IF;

    INSERT INTO private.global_event_persistence_jobs (
      crawl_job_id,
      data_source_id,
      event_key,
      event_payload
    )
    VALUES (
      parent_job.id,
      _data_source_id,
      event_key_value,
      event_value
    )
    ON CONFLICT (crawl_job_id, event_key) DO UPDATE SET
      data_source_id = EXCLUDED.data_source_id,
      event_payload = EXCLUDED.event_payload,
      status = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN 'queued'
        ELSE private.global_event_persistence_jobs.status
      END,
      attempt_count = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN 0
        ELSE private.global_event_persistence_jobs.attempt_count
      END,
      available_at = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN now()
        ELSE private.global_event_persistence_jobs.available_at
      END,
      lease_owner = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.lease_owner
      END,
      lease_expires_at = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.lease_expires_at
      END,
      finished_at = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.finished_at
      END,
      event_id = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.event_id
      END,
      persistence_action = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.persistence_action
      END,
      error_code = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.error_code
      END,
      error_message = CASE
        WHEN private.should_reopen_global_event_persistence_v1(
          private.global_event_persistence_jobs.status,
          private.global_event_persistence_jobs.event_payload,
          EXCLUDED.event_payload,
          private.global_event_persistence_jobs.finished_at,
          private.global_event_persistence_jobs.updated_at
        )
          THEN NULL
        ELSE private.global_event_persistence_jobs.error_message
      END,
      updated_at = now();

    accepted_count := accepted_count + 1;
  END LOOP;

  RETURN accepted_count;
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

-- A cached exact-host robots denial immediately terminalizes matching work.
-- The currently leased job remains owned by its worker so its attempt can be
-- recorded normally; queued and stale-leased siblings cannot clog the backlog.
CREATE OR REPLACE FUNCTION private.apply_cached_global_robots_denial_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'queued'
    AND EXISTS (
      SELECT 1
      FROM private.global_domain_crawl_state AS state
      WHERE state.domain = NEW.domain
        AND state.robots_status = 'disallowed'
        AND state.robots_expires_at > now()
    )
  THEN
    NEW.status := 'skipped';
    NEW.lease_owner := NULL;
    NEW.lease_expires_at := NULL;
    NEW.http_status := 403;
    NEW.error_code := 'robots_disallowed_cached';
    NEW.error_message := 'Fresh exact-host robots policy disallows crawling.';
    NEW.finished_at := now();
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_cached_global_robots_denial_v1
  ON private.global_crawl_jobs;
CREATE TRIGGER apply_cached_global_robots_denial_v1
BEFORE INSERT OR UPDATE OF status, domain, available_at
ON private.global_crawl_jobs
FOR EACH ROW
EXECUTE FUNCTION private.apply_cached_global_robots_denial_v1();

CREATE OR REPLACE FUNCTION private.drain_global_robots_denial_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected RECORD;
BEGIN
  IF NEW.robots_status IS DISTINCT FROM 'disallowed'
    OR NEW.robots_expires_at <= now()
  THEN
    RETURN NEW;
  END IF;

  FOR affected IN
    WITH skipped AS (
      UPDATE private.global_crawl_jobs AS job
      SET
        status = 'skipped',
        lease_owner = NULL,
        lease_expires_at = NULL,
        http_status = 403,
        error_code = 'robots_disallowed_cached',
        error_message = 'Fresh exact-host robots policy disallows crawling.',
        finished_at = now(),
        updated_at = now()
      WHERE job.domain = NEW.domain
        AND job.id IS DISTINCT FROM NEW.active_crawl_job_id
        AND (
          job.status = 'queued'
          OR (job.status = 'leased' AND job.lease_expires_at <= now())
        )
      RETURNING job.campaign_id
    )
    SELECT DISTINCT skipped.campaign_id FROM skipped
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(affected.campaign_id);
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS drain_global_robots_denial_v1
  ON private.global_domain_crawl_state;
CREATE TRIGGER drain_global_robots_denial_v1
AFTER UPDATE OF robots_status, robots_expires_at
ON private.global_domain_crawl_state
FOR EACH ROW
EXECUTE FUNCTION private.drain_global_robots_denial_v1();

-- A redirect to a related hostname is never fetched under the parent's robots
-- decision. It becomes a durable child job with independent hostname state.
CREATE OR REPLACE FUNCTION public.enqueue_global_crawl_redirect(
  _parent_job_id UUID,
  _worker_id UUID,
  _redirect_url TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parent_job private.global_crawl_jobs%ROWTYPE;
  redirect_url_value TEXT := left(btrim(coalesce(_redirect_url, '')), 2000);
  target_hostname TEXT;
  parent_site_domain TEXT;
  target_site_domain TEXT;
  related_hostname BOOLEAN;
  target_kind TEXT;
BEGIN
  SELECT job.*
  INTO parent_job
  FROM private.global_crawl_jobs AS job
  WHERE job.id = _parent_job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_job_lease_not_owned' USING ERRCODE = '55000';
  END IF;

  target_hostname := nullif(lower(rtrim(
    substring(redirect_url_value FROM '^https?://([^/?#:]+)'),
    '.'
  )), '');
  parent_site_domain := private.global_discovery_domain(parent_job.domain);
  target_site_domain := private.global_discovery_domain(target_hostname);
  related_hostname := target_site_domain IS NOT NULL
    AND parent_site_domain IS NOT NULL
    AND (
      target_site_domain = parent_site_domain
      OR target_site_domain LIKE ('%.' || parent_site_domain)
      OR parent_site_domain LIKE ('%.' || target_site_domain)
  );

  IF parent_job.crawl_depth >= 64
    OR redirect_url_value !~* '^https?://[^[:space:]]+$'
    OR target_hostname IS NULL
    OR target_hostname = parent_job.domain
    OR NOT related_hostname
  THEN
    RAISE EXCEPTION 'invalid_related_crawl_redirect' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.global_domain_crawl_state (domain)
  VALUES (target_hostname)
  ON CONFLICT (domain) DO NOTHING;

  target_kind := CASE
    WHEN parent_job.crawl_kind = 'pagination' THEN 'pagination'
    ELSE 'event'
  END;

  INSERT INTO private.global_crawl_jobs (
    campaign_id,
    search_job_id,
    search_result_id,
    parent_job_id,
    city_id,
    url,
    canonical_url,
    domain,
    crawl_kind,
    crawl_depth,
    priority,
    available_at
  )
  VALUES (
    parent_job.campaign_id,
    parent_job.search_job_id,
    NULL,
    parent_job.id,
    parent_job.city_id,
    redirect_url_value,
    redirect_url_value,
    target_hostname,
    target_kind,
    parent_job.crawl_depth + 1,
    greatest(-1000, parent_job.priority - 1),
    now()
  )
  ON CONFLICT (campaign_id, city_id, canonical_url) DO UPDATE SET
    priority = greatest(private.global_crawl_jobs.priority, EXCLUDED.priority),
    status = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN 'queued'
      ELSE private.global_crawl_jobs.status
    END,
    attempt_count = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN 0
      ELSE private.global_crawl_jobs.attempt_count
    END,
    available_at = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN now()
      ELSE private.global_crawl_jobs.available_at
    END,
    lease_owner = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN NULL
      ELSE private.global_crawl_jobs.lease_owner
    END,
    lease_expires_at = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN NULL
      ELSE private.global_crawl_jobs.lease_expires_at
    END,
    finished_at = CASE
      WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
        AND coalesce(
          private.global_crawl_jobs.finished_at,
          private.global_crawl_jobs.updated_at
        ) <= now() - interval '24 hours'
        THEN NULL
      ELSE private.global_crawl_jobs.finished_at
    END,
    updated_at = now();

  RETURN true;
END;
$$;

-- Include durable event writes in campaign completion. A fetched page can be
-- terminal while its event rows continue safely in the persistence queue.
CREATE OR REPLACE FUNCTION private.refresh_global_scrape_campaign_v1(
  _campaign_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  has_pending BOOLEAN;
  has_jobs BOOLEAN;
  failed_persistence_jobs BIGINT;
BEGIN
  SELECT
    EXISTS (
      SELECT 1
      FROM private.global_search_jobs AS job
      WHERE job.campaign_id = _campaign_id
        AND job.status IN ('queued', 'leased')
      UNION ALL
      SELECT 1
      FROM private.global_crawl_jobs AS job
      WHERE job.campaign_id = _campaign_id
        AND job.status IN ('queued', 'leased')
      UNION ALL
      SELECT 1
      FROM private.global_event_persistence_jobs AS persistence
      JOIN private.global_crawl_jobs AS crawl
        ON crawl.id = persistence.crawl_job_id
      WHERE crawl.campaign_id = _campaign_id
        AND persistence.status IN ('queued', 'leased')
    ),
    EXISTS (
      SELECT 1
      FROM private.global_search_jobs AS job
      WHERE job.campaign_id = _campaign_id
    )
  INTO has_pending, has_jobs;

  SELECT count(*)
  INTO failed_persistence_jobs
  FROM private.global_event_persistence_jobs AS persistence
  JOIN private.global_crawl_jobs AS crawl
    ON crawl.id = persistence.crawl_job_id
  WHERE crawl.campaign_id = _campaign_id
    AND persistence.status = 'failed';

  UPDATE private.global_scrape_campaigns
  SET
    status = CASE
      WHEN status IN ('failed', 'cancelled') THEN status
      WHEN has_pending THEN 'running'
      WHEN has_jobs THEN 'completed'
      ELSE status
    END,
    started_at = CASE
      WHEN has_jobs THEN coalesce(started_at, now())
      ELSE started_at
    END,
    finished_at = CASE
      WHEN status NOT IN ('failed', 'cancelled') AND has_jobs AND NOT has_pending
        THEN coalesce(finished_at, now())
      ELSE finished_at
    END,
    metadata = coalesce(metadata, '{}'::JSONB) || jsonb_build_object(
      'persistence_failed_jobs', failed_persistence_jobs,
      'completed_with_errors',
        (has_jobs AND NOT has_pending AND failed_persistence_jobs > 0)
    ),
    updated_at = now()
  WHERE id = _campaign_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.global_event_persistence_campaign_status(
  _campaign_id UUID
)
RETURNS TABLE (
  total_jobs BIGINT,
  queued_jobs BIGINT,
  leased_jobs BIGINT,
  completed_jobs BIGINT,
  failed_jobs BIGINT,
  completed_with_errors BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE persistence.status = 'queued'),
    count(*) FILTER (WHERE persistence.status = 'leased'),
    count(*) FILTER (WHERE persistence.status = 'completed'),
    count(*) FILTER (WHERE persistence.status = 'failed'),
    count(*) FILTER (WHERE persistence.status = 'failed') > 0
      AND count(*) FILTER (
        WHERE persistence.status IN ('queued', 'leased')
      ) = 0
  FROM private.global_event_persistence_jobs AS persistence
  JOIN private.global_crawl_jobs AS crawl
    ON crawl.id = persistence.crawl_job_id
  WHERE crawl.campaign_id = _campaign_id;
$$;

-- Admission control reserves ten crawl slots for every active search lease.
-- The advisory lock makes the reservation calculation atomic across workers.
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
  backlog_limit INTEGER := greatest(
    100,
    least(coalesce(_max_crawl_backlog, 5000), 250000)
  );
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global_discovery_search_admission_v1', 0)
  );

  SELECT count(*)
  INTO crawl_backlog
  FROM private.global_crawl_jobs AS crawl
  WHERE crawl.status IN ('queued', 'leased');

  SELECT count(*)
  INTO active_search_reservations
  FROM private.global_search_jobs AS search
  WHERE search.status = 'leased'
    AND search.lease_expires_at > now();

  search_capacity := greatest(
    0,
    floor(
      (backlog_limit - crawl_backlog - active_search_reservations * 10)::NUMERIC / 10
    )::INTEGER
  );
  IF search_capacity = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_global_search_jobs(
    _worker_id,
    least(greatest(1, coalesce(_limit, 5)), search_capacity),
    _lease_seconds
  );
END;
$$;

-- Pages pause when the downstream event queue is saturated. Persistence jobs
-- are processed before this claim, so pressure drains without dropping pages.
CREATE OR REPLACE FUNCTION public.claim_global_crawl_jobs(
  _worker_id UUID,
  _limit INTEGER,
  _lease_seconds INTEGER,
  _max_persistence_backlog INTEGER
)
RETURNS TABLE (
  job_id UUID,
  campaign_id UUID,
  search_job_id UUID,
  city_id UUID,
  url TEXT,
  canonical_url TEXT,
  domain TEXT,
  attempt_count INTEGER,
  max_attempts INTEGER,
  search_rank INTEGER,
  crawl_kind TEXT,
  crawl_depth INTEGER,
  parent_job_id UUID,
  robots_status TEXT,
  robots_rules JSONB,
  robots_expires_at TIMESTAMPTZ,
  crawl_delay_ms INTEGER,
  city_name TEXT,
  country_code TEXT,
  timezone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  data_source_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  persistence_backlog BIGINT;
  backlog_limit INTEGER := greatest(
    100,
    least(coalesce(_max_persistence_backlog, 5000), 250000)
  );
BEGIN
  SELECT count(*)
  INTO persistence_backlog
  FROM private.global_event_persistence_jobs AS persistence
  WHERE persistence.status IN ('queued', 'leased');

  IF persistence_backlog >= backlog_limit THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_global_crawl_jobs(_worker_id, _limit, _lease_seconds);
END;
$$;

DROP FUNCTION public.global_discovery_backlog();
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
      WHERE job.status IN ('queued', 'leased')
    ),
    (
      SELECT count(*)
      FROM private.global_crawl_jobs AS job
      WHERE job.status IN ('queued', 'leased')
    ),
    (
      SELECT count(*)
      FROM private.global_event_persistence_jobs AS job
      WHERE job.status IN ('queued', 'leased')
    );
$$;

CREATE OR REPLACE FUNCTION public.prune_global_discovery_history(
  _retention_days INTEGER DEFAULT 45,
  _batch_limit INTEGER DEFAULT 2000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  retention_interval INTERVAL := make_interval(
    days => greatest(14, least(coalesce(_retention_days, 45), 365))
  );
  batch_limit INTEGER := greatest(1, least(coalesce(_batch_limit, 2000), 10000));
  campaigns_deleted INTEGER := 0;
  caches_deleted INTEGER := 0;
  domains_deleted INTEGER := 0;
BEGIN
  WITH doomed AS MATERIALIZED (
    SELECT campaign.id
    FROM private.global_scrape_campaigns AS campaign
    WHERE campaign.status IN ('completed', 'failed', 'cancelled')
      AND coalesce(campaign.finished_at, campaign.updated_at)
        < now() - retention_interval
      AND NOT EXISTS (
        SELECT 1
        FROM private.global_event_persistence_jobs AS persistence
        JOIN private.global_crawl_jobs AS crawl
          ON crawl.id = persistence.crawl_job_id
        WHERE crawl.campaign_id = campaign.id
          AND persistence.status = 'failed'
      )
    ORDER BY coalesce(campaign.finished_at, campaign.updated_at), campaign.id
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM private.global_scrape_campaigns AS campaign
  USING doomed
  WHERE campaign.id = doomed.id;
  GET DIAGNOSTICS campaigns_deleted = ROW_COUNT;

  WITH doomed AS MATERIALIZED (
    SELECT cache.cache_key
    FROM private.global_search_cache AS cache
    WHERE cache.expires_at < now() - interval '7 days'
    ORDER BY cache.expires_at, cache.cache_key
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM private.global_search_cache AS cache
  USING doomed
  WHERE cache.cache_key = doomed.cache_key;
  GET DIAGNOSTICS caches_deleted = ROW_COUNT;

  WITH doomed AS MATERIALIZED (
    SELECT state.domain
    FROM private.global_domain_crawl_state AS state
    WHERE state.active_crawl_job_id IS NULL
      AND state.updated_at < now() - retention_interval
      AND NOT EXISTS (
        SELECT 1
        FROM private.global_crawl_jobs AS crawl
        WHERE crawl.domain = state.domain
      )
    ORDER BY state.updated_at, state.domain
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM private.global_domain_crawl_state AS state
  USING doomed
  WHERE state.domain = doomed.domain;
  GET DIAGNOSTICS domains_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'campaigns_deleted', campaigns_deleted,
    'caches_deleted', caches_deleted,
    'domains_deleted', domains_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION private.apply_cached_global_robots_denial_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.drain_global_robots_denial_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.should_reopen_global_event_persistence_v1(
  TEXT, JSONB, JSONB, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_global_event_persistence_jobs(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_global_crawl_redirect(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_crawl_jobs(UUID, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_discovery_backlog()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_event_persistence_campaign_status(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_global_discovery_history(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_global_event_persistence_jobs(UUID, UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_event_persistence_jobs(UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_global_event_persistence_job(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_global_event_persistence_job(UUID, UUID, TEXT, TEXT, INTEGER, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_global_crawl_redirect(UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_crawl_jobs(UUID, INTEGER, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_discovery_backlog()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_event_persistence_campaign_status(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_global_discovery_history(INTEGER, INTEGER)
  TO service_role;

COMMENT ON TABLE private.global_event_persistence_jobs IS
  'Event-level durable queue: dense agenda pages complete after payload checkpointing, while small idempotent workers persist every event and source link.';
COMMENT ON FUNCTION public.enqueue_global_crawl_redirect(UUID, UUID, TEXT) IS
  'Creates a related-host redirect child with its own exact-host robots state; the parent robots decision is never reused.';
COMMENT ON FUNCTION public.prune_global_discovery_history(INTEGER, INTEGER) IS
  'Bounded service-role retention of terminal discovery campaigns, expired search cache and orphan hostname state. Public events and source links are preserved.';
