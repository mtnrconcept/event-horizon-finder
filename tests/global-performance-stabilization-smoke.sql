DO $performance_stabilization_smoke$
DECLARE
  collections JSONB;
  recorded BOOLEAN;
  scheduler_activity TIMESTAMPTZ;
  fallback_schedule TEXT;
  events_command TEXT;
  occurrences_command TEXT;
BEGIN
  SELECT public.discover_home_collections_v1(
    _from => now(),
    _to => now() + interval '365 days',
    _collection_limit => 8,
    _candidate_limit => 64
  )
  INTO collections;

  IF jsonb_typeof(collections) <> 'object'
    OR NOT collections ?& ARRAY['top', 'free', 'nightlife', 'festivals']
    OR EXISTS (
      SELECT 1
      FROM jsonb_each(collections) AS collection
      WHERE jsonb_typeof(collection.value) <> 'array'
    )
  THEN
    RAISE EXCEPTION 'home collections must return four arrays: %', collections;
  END IF;

  SELECT public.record_global_discovery_external_activity_v1('crawl')
  INTO recorded;
  SELECT last_external_activity_at
  INTO scheduler_activity
  FROM private.global_discovery_scheduler_state
  WHERE singleton;
  IF NOT recorded OR scheduler_activity IS NULL THEN
    RAISE EXCEPTION 'external discovery activity was not recorded';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.record_global_discovery_external_activity_v1(text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.record_global_discovery_external_activity_v1(text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'external discovery activity RPC must remain server-only';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.upsert_ingested_event_serial_v1(uuid,jsonb)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.upsert_ingested_event_serial_v1(uuid,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'serialized ingestion wrapper has unsafe privileges';
  END IF;

  SELECT schedule INTO fallback_schedule
  FROM cron.job
  WHERE jobname = 'global-discovery-supabase-fallback';
  SELECT command INTO events_command
  FROM cron.job
  WHERE jobname = 'eventscrap-events-import';
  SELECT command INTO occurrences_command
  FROM cron.job
  WHERE jobname = 'eventscrap-occurrences-import';

  IF fallback_schedule <> '14,29,44,59 * * * *'
    OR events_command NOT LIKE '%run_eventscrap_events_import_guarded_v1%'
    OR occurrences_command NOT LIKE '%run_eventscrap_occurrences_import_guarded_v1%'
  THEN
    RAISE EXCEPTION
      'runtime jobs were not stabilized: schedule %, events %, occurrences %',
      fallback_schedule,
      events_command,
      occurrences_command;
  END IF;
END;
$performance_stabilization_smoke$;
