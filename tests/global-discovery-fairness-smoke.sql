DO $fairness_smoke$
DECLARE
  result JSONB;
  executable BIGINT;
  deferred BIGINT;
  restored INTEGER;
  search_claim_definition TEXT;
  fallback_definition TEXT;
BEGIN
  IF public.record_global_discovery_external_activity_v1('persistence') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Persistence must be accepted as an external scheduler action';
  END IF;

  INSERT INTO public.countries (id, code, name)
  VALUES ('71000000-0000-4000-8000-000000000001', 'ZZ', 'Fairness Test Country');

  INSERT INTO public.cities (id, country_id, slug, name, timezone, latitude, longitude)
  VALUES (
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000001',
    'fairness-test-city',
    'Fairness Test City',
    'UTC',
    0,
    0
  );

  INSERT INTO private.global_scrape_campaigns (
    id, campaign_key, period_start, period_end, provider, status
  )
  VALUES (
    '71000000-0000-4000-8000-000000000003',
    'fairness-smoke',
    current_date,
    current_date + 1,
    'searxng',
    'running'
  );

  INSERT INTO private.global_search_jobs (
    id, campaign_id, city_id, query_kind, query_text, query_locale,
    provider, cache_key, status
  )
  VALUES (
    '71000000-0000-4000-8000-000000000004',
    '71000000-0000-4000-8000-000000000003',
    '71000000-0000-4000-8000-000000000002',
    'general',
    'fairness smoke query',
    'en',
    'searxng',
    repeat('a', 64),
    'completed'
  );

  WITH inserted_results AS (
    INSERT INTO private.global_search_results (
      id, search_job_id, rank, url, canonical_url, domain
    )
    SELECT
      ('71000000-0000-4001-8000-' || lpad(series::TEXT, 12, '0'))::UUID,
      '71000000-0000-4000-8000-000000000004'::UUID,
      ((series - 1) % 10) + 1,
      'https://fairness.example/event/' || series,
      'https://fairness.example/event/' || series,
      'fairness.example'
    FROM generate_series(1, 30) AS series
    RETURNING id, canonical_url
  )
  INSERT INTO private.global_crawl_jobs (
    campaign_id, search_job_id, search_result_id, city_id, url,
    canonical_url, domain, crawl_kind, crawl_depth, status, priority
  )
  SELECT
    '71000000-0000-4000-8000-000000000003'::UUID,
    '71000000-0000-4000-8000-000000000004'::UUID,
    inserted_results.id,
    '71000000-0000-4000-8000-000000000002'::UUID,
    inserted_results.canonical_url,
    inserted_results.canonical_url,
    'fairness.example',
    'search_result',
    0,
    'queued',
    0
  FROM inserted_results;

  SELECT public.rebalance_global_discovery_backlog_v1(25, 6, 10000) INTO result;

  SELECT count(*) FILTER (WHERE available_at <= now()),
         count(*) FILTER (WHERE available_at > now())
  INTO executable, deferred
  FROM private.global_crawl_jobs
  WHERE domain = 'fairness.example' AND status = 'queued';

  IF executable <> 25 OR deferred <> 5
    OR (result ->> 'deferred')::INTEGER <> 5
  THEN
    RAISE EXCEPTION 'fairness lane was not bounded and preserved: %, %, %',
      executable, deferred, result;
  END IF;

  IF (SELECT crawl_backlog FROM public.global_discovery_backlog()) <> 25 THEN
    RAISE EXCEPTION 'backpressure must count only executable Crawl jobs';
  END IF;

  SELECT public.restore_deferred_global_crawl_jobs_v1('fairness.example', 100) INTO restored;
  IF restored <> 5 OR (
    SELECT count(*) FROM private.global_crawl_jobs
    WHERE domain = 'fairness.example' AND status = 'queued' AND available_at <= now()
  ) <> 30 THEN
    RAISE EXCEPTION 'deferred Crawl rollback did not restore every preserved job';
  END IF;

  SELECT pg_get_functiondef(
    'public.claim_global_search_jobs(uuid,integer,integer)'::regprocedure
  ) INTO search_claim_definition;
  IF search_claim_definition NOT LIKE '%PARTITION BY city.country_id, job.query_kind%' THEN
    RAISE EXCEPTION 'Search claims are not partitioned by country and category';
  END IF;

  SELECT pg_get_functiondef(
    'private.dispatch_global_discovery_fallback_v1()'::regprocedure
  ) INTO fallback_definition;
  IF fallback_definition NOT LIKE '%''action'', ''persistence''%'
    OR fallback_definition NOT LIKE '%''action'', ''crawl''%'
  THEN
    RAISE EXCEPTION 'fallback scheduler does not separate Persistence and Crawl';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.rebalance_global_discovery_backlog_v1(integer,integer,integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.restore_deferred_global_crawl_jobs_v1(text,integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.rebalance_global_discovery_backlog_v1(integer,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'fairness maintenance RPCs have unsafe privileges';
  END IF;

  -- Keep the smoke test repeatable when it is run outside the disposable CI database.
  DELETE FROM private.global_crawl_jobs
  WHERE campaign_id = '71000000-0000-4000-8000-000000000003';
  DELETE FROM private.global_search_results
  WHERE search_job_id = '71000000-0000-4000-8000-000000000004';
  DELETE FROM private.global_search_jobs
  WHERE id = '71000000-0000-4000-8000-000000000004';
  DELETE FROM private.global_scrape_campaigns
  WHERE id = '71000000-0000-4000-8000-000000000003';
  DELETE FROM public.cities
  WHERE id = '71000000-0000-4000-8000-000000000002';
  DELETE FROM public.countries
  WHERE id = '71000000-0000-4000-8000-000000000001';
END;
$fairness_smoke$;
