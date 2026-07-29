DO $daily_guard_smoke$
DECLARE
  expected_work_key CONSTANT TEXT := repeat('a', 64);
  first_job CONSTANT UUID := '10000000-0000-4000-8000-000000000001';
  second_job CONSTANT UUID := '10000000-0000-4000-8000-000000000002';
BEGIN
  IF NOT public.claim_global_discovery_daily_work_v1(
    'event_persistence',
    expected_work_key,
    first_job,
    'events.example.com',
    'https://events.example.com/show',
    NULL,
    '{"test":true}'::JSONB
  ) THEN
    RAISE EXCEPTION 'first daily work claim must succeed';
  END IF;

  IF NOT public.claim_global_discovery_daily_work_v1(
    'event_persistence',
    expected_work_key,
    first_job,
    'events.example.com',
    'https://events.example.com/show',
    NULL,
    '{"retry":true}'::JSONB
  ) THEN
    RAISE EXCEPTION 'the owning job must be allowed to retry';
  END IF;

  IF public.claim_global_discovery_daily_work_v1(
    'event_persistence',
    expected_work_key,
    second_job,
    'events.example.com',
    'https://events.example.com/show',
    NULL,
    '{}'::JSONB
  ) THEN
    RAISE EXCEPTION 'a second job must not claim identical work on the same UTC day';
  END IF;

  IF (
    SELECT count(*)
    FROM private.global_discovery_daily_work AS work
    WHERE work.work_date = (now() AT TIME ZONE 'UTC')::DATE
      AND work.work_kind = 'event_persistence'
      AND work.work_key = expected_work_key
  ) <> 1 THEN
    RAISE EXCEPTION 'daily work guard must retain exactly one atomic claim';
  END IF;

  DELETE FROM private.global_discovery_daily_work AS work
  WHERE work.work_date = (now() AT TIME ZONE 'UTC')::DATE
    AND work.work_kind = 'event_persistence'
    AND work.work_key = expected_work_key
    AND work.first_job_id = first_job;
END;
$daily_guard_smoke$;
