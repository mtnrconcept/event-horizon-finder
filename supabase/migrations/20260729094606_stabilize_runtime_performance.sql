-- Stabilize the shared database workload and collapse the four home-page
-- editorial scans into one bounded RPC.

CREATE INDEX IF NOT EXISTS global_discovery_daily_work_city_idx
  ON private.global_discovery_daily_work (city_id);

CREATE INDEX IF NOT EXISTS event_performers_performer_idx
  ON public.event_performers (performer_id);

CREATE INDEX IF NOT EXISTS venue_aliases_venue_idx
  ON public.venue_aliases (venue_id);

ALTER POLICY cities_admin_write ON public.cities
  USING (public.has_role((SELECT auth.uid()), 'admin'))
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin'));

ALTER POLICY categories_admin_write ON public.event_categories
  USING (public.has_role((SELECT auth.uid()), 'admin'))
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin'));

ALTER POLICY venues_admin_write ON public.venues
  USING (
    public.has_role((SELECT auth.uid()), 'admin')
    OR public.has_role((SELECT auth.uid()), 'moderator')
  )
  WITH CHECK (
    public.has_role((SELECT auth.uid()), 'admin')
    OR public.has_role((SELECT auth.uid()), 'moderator')
  );

ALTER POLICY events_owner_read ON public.events
  USING (
    (
      organizer_id IS NOT NULL
      AND public.is_organizer_member(organizer_id, (SELECT auth.uid()))
    )
    OR created_by = (SELECT auth.uid())
    OR public.has_role((SELECT auth.uid()), 'moderator')
    OR public.has_role((SELECT auth.uid()), 'admin')
  );

ALTER POLICY events_owner_write ON public.events
  USING (
    (
      organizer_id IS NOT NULL
      AND public.is_organizer_member(organizer_id, (SELECT auth.uid()))
    )
    OR created_by = (SELECT auth.uid())
    OR public.has_role((SELECT auth.uid()), 'admin')
  )
  WITH CHECK (
    (
      organizer_id IS NOT NULL
      AND public.is_organizer_member(organizer_id, (SELECT auth.uid()))
    )
    OR created_by = (SELECT auth.uid())
    OR public.has_role((SELECT auth.uid()), 'admin')
  );

ALTER POLICY occ_owner_write ON public.event_occurrences
  USING (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      WHERE event.id = event_id
        AND (
          (
            event.organizer_id IS NOT NULL
            AND public.is_organizer_member(event.organizer_id, (SELECT auth.uid()))
          )
          OR event.created_by = (SELECT auth.uid())
          OR public.has_role((SELECT auth.uid()), 'admin')
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.events AS event
      WHERE event.id = event_id
        AND (
          (
            event.organizer_id IS NOT NULL
            AND public.is_organizer_member(event.organizer_id, (SELECT auth.uid()))
          )
          OR event.created_by = (SELECT auth.uid())
          OR public.has_role((SELECT auth.uid()), 'admin')
        )
    )
  );

CREATE OR REPLACE FUNCTION public.discover_home_collections_v1(
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT now() + interval '365 days',
  _country_id UUID DEFAULT NULL,
  _region_id UUID DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _collection_limit INTEGER DEFAULT 8,
  _candidate_limit INTEGER DEFAULT 512
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT discovered.*
    FROM public.discover_events(
      _from => _from,
      _to => _to,
      _country_id => _country_id,
      _region_id => _region_id,
      _city_id => _city_id,
      _limit => least(1000, greatest(32, coalesce(_candidate_limit, 512))),
      _offset => 0
    ) AS discovered
  ),
  top_rows AS (
    SELECT candidate.*
    FROM candidates AS candidate
    WHERE candidate.is_verified
    ORDER BY candidate.starts_at, candidate.occurrence_id
    LIMIT least(24, greatest(1, coalesce(_collection_limit, 8)))
  ),
  free_rows AS (
    SELECT candidate.*
    FROM candidates AS candidate
    WHERE candidate.is_free
    ORDER BY candidate.starts_at, candidate.occurrence_id
    LIMIT least(24, greatest(1, coalesce(_collection_limit, 8)))
  ),
  nightlife_rows AS (
    SELECT candidate.*
    FROM candidates AS candidate
    WHERE candidate.category_slug = 'soirees'
    ORDER BY candidate.starts_at, candidate.occurrence_id
    LIMIT least(24, greatest(1, coalesce(_collection_limit, 8)))
  ),
  festival_rows AS (
    SELECT candidate.*
    FROM candidates AS candidate
    WHERE candidate.category_slug = 'festivals'
    ORDER BY candidate.starts_at, candidate.occurrence_id
    LIMIT least(24, greatest(1, coalesce(_collection_limit, 8)))
  )
  SELECT jsonb_build_object(
    'top',
      coalesce(
        (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.starts_at, item.occurrence_id)
         FROM top_rows AS item),
        '[]'::JSONB
      ),
    'free',
      coalesce(
        (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.starts_at, item.occurrence_id)
         FROM free_rows AS item),
        '[]'::JSONB
      ),
    'nightlife',
      coalesce(
        (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.starts_at, item.occurrence_id)
         FROM nightlife_rows AS item),
        '[]'::JSONB
      ),
    'festivals',
      coalesce(
        (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.starts_at, item.occurrence_id)
         FROM festival_rows AS item),
        '[]'::JSONB
      )
  );
$$;

REVOKE ALL ON FUNCTION public.discover_home_collections_v1(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, INTEGER, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_home_collections_v1(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, INTEGER, INTEGER
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.discover_home_collections_v1(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, INTEGER, INTEGER
) IS
  'Returns four bounded home-page collections from one materialized discover_events candidate scan.';

CREATE OR REPLACE FUNCTION public.upsert_ingested_event_serial_v1(
  _data_source_id UUID,
  _payload JSONB
)
RETURNS TABLE (
  event_id UUID,
  action TEXT,
  score INTEGER,
  published BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Global workers may still use their two independent admission slots. The
  -- shared lock only excludes a long Eventscrap batch from running at the same
  -- time and competing for the same event/occurrence rows.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('eventscrap_serial_import_v1', 0)
  );

  RETURN QUERY
  SELECT result.event_id, result.action, result.score, result.published
  FROM public.upsert_ingested_event_v2(_data_source_id, _payload) AS result;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event_serial_v1(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event_serial_v1(UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.upsert_ingested_event_serial_v1(UUID, JSONB) IS
  'Runs global persistence under a shared lock that excludes Eventscrap batch imports.';

CREATE OR REPLACE FUNCTION private.run_eventscrap_events_import_guarded_v1(
  _limit INTEGER DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  imported_count INTEGER;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('eventscrap_serial_import_v1', 0)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'import_already_running');
  END IF;

  SELECT public.import_eventscrap_events_batch(least(2000, greatest(1, coalesce(_limit, 1000))))
  INTO imported_count;
  RETURN jsonb_build_object(
    'ok', true,
    'skipped', false,
    'import', 'events',
    'processed', coalesce(imported_count, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.run_eventscrap_occurrences_import_guarded_v1(
  _limit INTEGER DEFAULT 2000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  imported_count INTEGER;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('eventscrap_serial_import_v1', 0)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'import_already_running');
  END IF;

  SELECT public.import_eventscrap_occurrences_batch(
    least(4000, greatest(1, coalesce(_limit, 2000)))
  )
  INTO imported_count;
  RETURN jsonb_build_object(
    'ok', true,
    'skipped', false,
    'import', 'occurrences',
    'processed', coalesce(imported_count, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION private.run_eventscrap_events_import_guarded_v1(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.run_eventscrap_occurrences_import_guarded_v1(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE private.global_discovery_scheduler_state
  ADD COLUMN IF NOT EXISTS last_external_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_external_action TEXT;

ALTER TABLE private.global_discovery_scheduler_state
  DROP CONSTRAINT IF EXISTS global_discovery_scheduler_external_action_check;
ALTER TABLE private.global_discovery_scheduler_state
  ADD CONSTRAINT global_discovery_scheduler_external_action_check
  CHECK (
    last_external_action IS NULL
    OR last_external_action IN ('plan', 'search', 'crawl')
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
  IF coalesce(_action, '') NOT IN ('plan', 'search', 'crawl') THEN
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

REVOKE ALL ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT)
  TO service_role;

COMMENT ON FUNCTION public.record_global_discovery_external_activity_v1(TEXT) IS
  'Records authenticated non-fallback discovery work so Supabase Cron remains a true fallback.';

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
  reaper_result JSONB;
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

  SELECT public.reap_global_discovery_expired_leases_v1(1000)
  INTO reaper_result;

  IF state_row.last_external_activity_at IS NOT NULL
    AND state_row.last_external_activity_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dispatched', false,
      'reason', 'recent_external_activity',
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
      AND run.status = 'running'
      AND run.end_time IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dispatched', false,
      'reason', 'eventscrap_import_running',
      'lease_reaper', reaper_result
    );
  END IF;

  IF state_row.last_dispatched_at IS NOT NULL
    AND state_row.last_dispatched_at > now() - interval '12 minutes'
  THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dispatched', false,
      'reason', 'recent_dispatch',
      'last_dispatched_at', state_row.last_dispatched_at,
      'lease_reaper', reaper_result
    );
  END IF;

  SELECT to_jsonb(health)
  INTO metrics
  FROM public.global_discovery_health_v1() AS health;
  metrics := coalesce(metrics, '{}'::JSONB)
    || jsonb_build_object('lease_reaper', reaper_result);

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

  FOR worker_index IN 1..6 LOOP
    SELECT private.enqueue_global_discovery_http_request_v1(
      dispatch_id,
      endpoint,
      jsonb_build_object(
        'action', 'crawl',
        'batch_size', 1,
        'persistence_limit', 8,
        'scheduler_dispatch_id', dispatch_id,
        'scheduler_worker', worker_index
      ),
      120000
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
  VALUES (dispatch_id, now(), request_ids, metrics);

  UPDATE private.global_discovery_scheduler_state
  SET
    last_dispatched_at = now(),
    last_dispatch_id = dispatch_id,
    last_request_ids = request_ids,
    last_metrics = metrics,
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
    'metrics', metrics,
    'lease_reaper', reaper_result
  );
END;
$$;

REVOKE ALL ON FUNCTION private.dispatch_global_discovery_fallback_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Dispatches bounded work only when external discovery and Eventscrap imports are inactive.';

DO $alter_runtime_jobs$
DECLARE
  target_job_id BIGINT;
BEGIN
  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-events-import';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      command := 'SELECT private.run_eventscrap_events_import_guarded_v1(1000);'
    );
  END IF;

  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'eventscrap-occurrences-import';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      command := 'SELECT private.run_eventscrap_occurrences_import_guarded_v1(2000);'
    );
  END IF;

  SELECT jobid INTO target_job_id
  FROM cron.job
  WHERE jobname = 'global-discovery-supabase-fallback';
  IF target_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(
      job_id := target_job_id,
      schedule := '14,29,44,59 * * * *',
      command := 'SELECT private.dispatch_global_discovery_fallback_v1();'
    );
  END IF;
END;
$alter_runtime_jobs$;
