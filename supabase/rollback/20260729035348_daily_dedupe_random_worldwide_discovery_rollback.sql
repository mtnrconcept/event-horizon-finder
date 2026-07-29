-- Run only after redeploying the pre-20260729035348 Edge Function.

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
STABLE
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
  SELECT city.id, city.name, country.code, country.name, city.timezone,
    city.latitude, city.longitude, city.population, target.population_rank::INTEGER,
    target.search_names, target.search_languages, target.query_profile
  FROM private.global_city_targets AS target
  JOIN public.cities AS city ON city.id = target.city_id
  JOIN public.countries AS country ON country.id = target.country_id
  WHERE target.enabled
    AND (cardinality(normalized_codes) = 0 OR country.code = ANY(normalized_codes))
    AND (target.next_due_at IS NULL OR target.next_due_at <= coalesce(_as_of, now()))
  ORDER BY target.priority DESC, target.next_due_at ASC NULLS FIRST,
    target.population_rank ASC NULLS LAST, city.population DESC NULLS LAST, city.id
  LIMIT greatest(1, least(coalesce(_limit, 250), 2000));
END;
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

UPDATE private.global_event_persistence_jobs
SET
  status = 'queued',
  persistence_action = NULL,
  error_code = NULL,
  error_message = NULL,
  available_at = now(),
  finished_at = NULL,
  updated_at = now()
WHERE status = 'cancelled'
  AND error_code IN ('deduplicated_backlog', 'duplicate_work_same_day');

REVOKE ALL ON FUNCTION public.claim_global_discovery_daily_work_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) FROM service_role;
REVOKE ALL ON FUNCTION public.skip_global_event_persistence_duplicate_v1(UUID, UUID)
  FROM service_role;
REVOKE ALL ON FUNCTION public.global_discovery_daily_guard_status_v1()
  FROM service_role;

DROP FUNCTION IF EXISTS public.global_discovery_daily_guard_status_v1();
DROP FUNCTION IF EXISTS public.skip_global_event_persistence_duplicate_v1(UUID, UUID);
DROP FUNCTION IF EXISTS public.claim_global_discovery_daily_work_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, UUID, JSONB
);
DROP INDEX IF EXISTS private.global_event_persistence_jobs_event_key_status_idx;
DROP TABLE IF EXISTS private.global_discovery_daily_work;
