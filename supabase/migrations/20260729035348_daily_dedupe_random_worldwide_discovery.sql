-- Prevent the worldwide discovery pipeline from repeating identical crawl or
-- persistence work during the same UTC day, and rotate due cities across
-- countries in a balanced random order.

CREATE TABLE IF NOT EXISTS private.global_discovery_daily_work (
  work_date DATE NOT NULL,
  work_kind TEXT NOT NULL,
  work_key TEXT NOT NULL,
  first_job_id UUID NOT NULL,
  domain TEXT,
  canonical_url TEXT,
  city_id UUID REFERENCES public.cities(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (work_date, work_kind, work_key),
  CONSTRAINT global_discovery_daily_work_kind_check
    CHECK (work_kind IN ('crawl_url', 'event_persistence')),
  CONSTRAINT global_discovery_daily_work_key_check
    CHECK (work_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT global_discovery_daily_work_domain_check
    CHECK (
      domain IS NULL
      OR (
        domain = lower(domain)
        AND domain !~ '[/@:]'
        AND length(domain) BETWEEN 1 AND 253
      )
    ),
  CONSTRAINT global_discovery_daily_work_url_check
    CHECK (
      canonical_url IS NULL
      OR canonical_url ~* '^https?://[^[:space:]]+$'
    ),
  CONSTRAINT global_discovery_daily_work_metadata_check
    CHECK (
      jsonb_typeof(metadata) = 'object'
      AND pg_column_size(metadata) <= 65536
    )
);

CREATE INDEX IF NOT EXISTS global_discovery_daily_work_created_idx
  ON private.global_discovery_daily_work (created_at, work_kind);

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_event_key_status_idx
  ON private.global_event_persistence_jobs (event_key, status, available_at, created_at);

ALTER TABLE private.global_discovery_daily_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.global_discovery_daily_work
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_global_discovery_daily_work_v1(
  _work_kind TEXT,
  _work_key TEXT,
  _job_id UUID,
  _domain TEXT DEFAULT NULL,
  _canonical_url TEXT DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  work_date_value DATE := (clock_timestamp() AT TIME ZONE 'UTC')::DATE;
  kind_value TEXT := lower(btrim(coalesce(_work_kind, '')));
  key_value TEXT := lower(btrim(coalesce(_work_key, '')));
  domain_value TEXT := nullif(lower(rtrim(btrim(coalesce(_domain, '')), '.')), '');
  canonical_url_value TEXT := nullif(left(btrim(coalesce(_canonical_url, '')), 2000), '');
  inserted_job_id UUID;
BEGIN
  IF kind_value NOT IN ('crawl_url', 'event_persistence')
    OR key_value !~ '^[a-f0-9]{64}$'
    OR _job_id IS NULL
    OR (
      domain_value IS NOT NULL
      AND (
        domain_value ~ '[/@:]'
        OR length(domain_value) > 253
      )
    )
    OR (
      canonical_url_value IS NOT NULL
      AND canonical_url_value !~* '^https?://[^[:space:]]+$'
    )
    OR jsonb_typeof(_metadata) IS DISTINCT FROM 'object'
    OR pg_column_size(_metadata) > 65536
  THEN
    RAISE EXCEPTION 'invalid_daily_discovery_work' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.global_discovery_daily_work (
    work_date,
    work_kind,
    work_key,
    first_job_id,
    domain,
    canonical_url,
    city_id,
    metadata
  )
  VALUES (
    work_date_value,
    kind_value,
    key_value,
    _job_id,
    domain_value,
    canonical_url_value,
    _city_id,
    _metadata
  )
  ON CONFLICT (work_date, work_kind, work_key) DO NOTHING
  RETURNING first_job_id INTO inserted_job_id;

  IF inserted_job_id IS NOT NULL THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM private.global_discovery_daily_work AS work
    WHERE work.work_date = work_date_value
      AND work.work_kind = kind_value
      AND work.work_key = key_value
      AND work.first_job_id = _job_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_global_event_persistence_duplicate_v1(
  _job_id UUID,
  _worker_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  persistence private.global_event_persistence_jobs%ROWTYPE;
  campaign_id_value UUID;
BEGIN
  IF _job_id IS NULL OR _worker_id IS NULL THEN
    RAISE EXCEPTION 'job_and_worker_required' USING ERRCODE = '22023';
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
    status = 'cancelled',
    lease_owner = NULL,
    lease_expires_at = NULL,
    persistence_action = 'skipped_duplicate',
    error_code = 'duplicate_work_same_day',
    error_message = 'An identical event persistence job already ran or was reserved today (UTC).',
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

-- Keep one runnable copy of each exact event key. Existing duplicate jobs are
-- retained as recoverable cancelled audit rows; no event or payload is deleted.
WITH ranked AS MATERIALIZED (
  SELECT
    persistence.id,
    persistence.status,
    row_number() OVER (
      PARTITION BY persistence.event_key
      ORDER BY
        CASE WHEN persistence.status = 'leased' THEN 0 ELSE 1 END,
        pg_column_size(persistence.event_payload) DESC,
        persistence.updated_at DESC,
        persistence.created_at DESC,
        persistence.id
    ) AS duplicate_rank
  FROM private.global_event_persistence_jobs AS persistence
  WHERE persistence.status IN ('queued', 'leased')
)
UPDATE private.global_event_persistence_jobs AS persistence
SET
  status = 'cancelled',
  lease_owner = NULL,
  lease_expires_at = NULL,
  persistence_action = 'deduplicated_backlog',
  error_code = 'deduplicated_backlog',
  error_message = 'Cancelled before execution because another runnable job has the same event key.',
  finished_at = now(),
  updated_at = now()
FROM ranked
WHERE persistence.id = ranked.id
  AND ranked.duplicate_rank > 1
  AND ranked.status = 'queued';

-- Round one selects one random due city per country, round two a second city
-- per country, and so on. Enqueueing advances each selected target's due date,
-- so later calls continue the rotation without replacement.
CREATE OR REPLACE FUNCTION public.list_due_global_city_targets_v2(
  _limit INTEGER DEFAULT 250,
  _as_of TIMESTAMPTZ DEFAULT now(),
  _country_codes TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS TABLE (
  city_id UUID, city_name TEXT, country_code TEXT, country_name TEXT,
  timezone TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  population BIGINT, country_population_rank INTEGER, search_names TEXT[],
  search_languages TEXT[], query_profile JSONB
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_codes TEXT[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT upper(btrim(code))), ARRAY[]::TEXT[])
  INTO normalized_codes
  FROM unnest(coalesce(_country_codes, ARRAY[]::TEXT[])) AS code
  WHERE btrim(code) <> '';

  IF cardinality(normalized_codes) > 20
    OR EXISTS (SELECT 1 FROM unnest(normalized_codes) AS code WHERE code !~ '^[A-Z]{2}$')
  THEN
    RAISE EXCEPTION 'invalid_country_codes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      city.id,
      city.name,
      country.id AS country_id,
      country.code,
      country.name AS selected_country_name,
      city.timezone,
      city.latitude,
      city.longitude,
      city.population,
      target.population_rank,
      target.search_names,
      target.search_languages,
      target.query_profile,
      target.priority,
      row_number() OVER (
        PARTITION BY country.id
        ORDER BY target.priority DESC, random()
      ) AS country_round,
      random() AS round_shuffle
    FROM private.global_city_targets AS target
    JOIN public.cities AS city ON city.id = target.city_id
    JOIN public.countries AS country ON country.id = target.country_id
    WHERE target.enabled
      AND (cardinality(normalized_codes) = 0 OR country.code = ANY(normalized_codes))
      AND (target.next_due_at IS NULL OR target.next_due_at <= coalesce(_as_of, now()))
  )
  SELECT
    eligible.id,
    eligible.name,
    eligible.code,
    eligible.selected_country_name,
    eligible.timezone,
    eligible.latitude,
    eligible.longitude,
    eligible.population,
    eligible.population_rank::INTEGER,
    eligible.search_names,
    eligible.search_languages,
    eligible.query_profile
  FROM eligible
  ORDER BY
    eligible.country_round,
    eligible.priority DESC,
    eligible.round_shuffle,
    eligible.id
  LIMIT greatest(1, least(coalesce(_limit, 250), 2000));
END;
$$;

CREATE OR REPLACE FUNCTION public.global_discovery_daily_guard_status_v1()
RETURNS TABLE (
  work_date DATE,
  unique_crawl_urls BIGINT,
  unique_event_persistences BIGINT,
  skipped_event_persistences BIGINT,
  deduplicated_backlog_jobs BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (now() AT TIME ZONE 'UTC')::DATE,
    count(*) FILTER (WHERE work.work_kind = 'crawl_url'),
    count(*) FILTER (WHERE work.work_kind = 'event_persistence'),
    (
      SELECT count(*)
      FROM private.global_event_persistence_jobs AS persistence
      WHERE persistence.error_code = 'duplicate_work_same_day'
        AND persistence.finished_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ),
    (
      SELECT count(*)
      FROM private.global_event_persistence_jobs AS persistence
      WHERE persistence.error_code = 'deduplicated_backlog'
    )
  FROM private.global_discovery_daily_work AS work
  WHERE work.work_date = (now() AT TIME ZONE 'UTC')::DATE;
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
  daily_work_deleted INTEGER := 0;
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

  WITH doomed AS MATERIALIZED (
    SELECT work.work_date, work.work_kind, work.work_key
    FROM private.global_discovery_daily_work AS work
    WHERE work.work_date < (now() AT TIME ZONE 'UTC')::DATE
      - greatest(14, least(coalesce(_retention_days, 45), 365))
    ORDER BY work.work_date, work.work_kind, work.work_key
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM private.global_discovery_daily_work AS work
  USING doomed
  WHERE work.work_date = doomed.work_date
    AND work.work_kind = doomed.work_kind
    AND work.work_key = doomed.work_key;
  GET DIAGNOSTICS daily_work_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'campaigns_deleted', campaigns_deleted,
    'caches_deleted', caches_deleted,
    'domains_deleted', domains_deleted,
    'daily_work_deleted', daily_work_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_global_discovery_daily_work_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_global_event_persistence_duplicate_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_discovery_daily_guard_status_v1()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_global_discovery_daily_work_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_global_event_persistence_duplicate_v1(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_discovery_daily_guard_status_v1()
  TO service_role;

COMMENT ON TABLE private.global_discovery_daily_work IS
  'UTC-day atomic guard for exact canonical crawl URLs and exact event persistence fingerprints.';
COMMENT ON FUNCTION public.claim_global_discovery_daily_work_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) IS
  'Atomically reserves exact crawl or event work for one job per UTC day; the owning job may retry safely.';
COMMENT ON FUNCTION public.skip_global_event_persistence_duplicate_v1(UUID, UUID) IS
  'Closes a leased persistence duplicate without running an upsert or consuming another retry.';
COMMENT ON FUNCTION public.list_due_global_city_targets_v2(INTEGER, TIMESTAMPTZ, TEXT[]) IS
  'Service-role due-city selector randomized without replacement and balanced by country round.';
