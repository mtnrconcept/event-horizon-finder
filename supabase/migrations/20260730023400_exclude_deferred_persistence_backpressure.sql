-- Keep temporary circuit-breaker deferrals from blocking unrelated Crawl work.
-- Jobs are preserved and become eligible again at available_at; only immediately
-- executable queued jobs and live leases consume the admission budget.

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
  WHERE (
      persistence.status = 'queued'
      AND persistence.available_at <= now()
    )
    OR (
      persistence.status = 'leased'
      AND persistence.lease_expires_at > now()
    );

  IF persistence_backlog >= backlog_limit THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_global_crawl_jobs(_worker_id, _limit, _lease_seconds);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_global_crawl_jobs(
  UUID,
  INTEGER,
  INTEGER,
  INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_global_crawl_jobs(
  UUID,
  INTEGER,
  INTEGER,
  INTEGER
) TO service_role;

COMMENT ON FUNCTION public.claim_global_crawl_jobs(
  UUID,
  INTEGER,
  INTEGER,
  INTEGER
) IS
  'Claims Crawl work when executable Persistence jobs and live leases remain below the bounded admission threshold; deferred circuit-breaker jobs do not block unrelated sources.';
