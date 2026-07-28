-- Controlled rollback for timeout-safe global discovery workers.
BEGIN;

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

DROP FUNCTION IF EXISTS public.release_global_discovery_worker_leases_v1(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.reap_global_discovery_expired_leases_v1(INTEGER);

COMMENT ON FUNCTION private.dispatch_global_discovery_fallback_v1() IS
  'Dispatches one locked, bounded eight-request worldwide discovery slice through pg_net.';

COMMIT;
