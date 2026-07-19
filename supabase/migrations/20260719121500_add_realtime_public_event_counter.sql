-- Maintain one lightweight public counter row instead of recounting the full
-- event catalogue for every visitor or every imported event.

CREATE TABLE IF NOT EXISTS public.public_event_counters (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  published_event_count BIGINT NOT NULL DEFAULT 0 CHECK (published_event_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.public_event_counters FROM PUBLIC;
GRANT SELECT ON TABLE public.public_event_counters TO anon, authenticated;
GRANT ALL ON TABLE public.public_event_counters TO service_role;

ALTER TABLE public.public_event_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_event_counters REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS "public_event_counters_read" ON public.public_event_counters;
CREATE POLICY "public_event_counters_read"
ON public.public_event_counters
FOR SELECT
TO anon, authenticated
USING (singleton);

INSERT INTO public.public_event_counters(
  singleton,
  published_event_count,
  updated_at
)
SELECT
  TRUE,
  count(*)::BIGINT,
  now()
FROM public.events AS event
WHERE event.is_demo = FALSE
  AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
ON CONFLICT (singleton) DO UPDATE SET
  published_event_count = EXCLUDED.published_event_count,
  updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION private.sync_public_event_counter_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_is_public BOOLEAN := FALSE;
  new_is_public BOOLEAN := FALSE;
  count_delta INTEGER := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_is_public := OLD.is_demo = FALSE
      AND OLD.status IN ('published', 'cancelled', 'postponed', 'sold_out');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_is_public := NEW.is_demo = FALSE
      AND NEW.status IN ('published', 'cancelled', 'postponed', 'sold_out');
  END IF;

  count_delta := new_is_public::INTEGER - old_is_public::INTEGER;
  IF count_delta = 0 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.public_event_counters(
    singleton,
    published_event_count,
    updated_at
  ) VALUES (
    TRUE,
    greatest(count_delta, 0),
    now()
  )
  ON CONFLICT (singleton) DO UPDATE SET
    published_event_count = greatest(
      0,
      public.public_event_counters.published_event_count + count_delta
    ),
    updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_public_event_counter_v1()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_public_event_counter_v1 ON public.events;
CREATE TRIGGER trg_sync_public_event_counter_v1
AFTER INSERT OR DELETE OR UPDATE OF status, is_demo
ON public.events
FOR EACH ROW
EXECUTE FUNCTION private.sync_public_event_counter_v1();

DO $enable_public_event_counter_realtime$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'public_event_counters'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.public_event_counters;
  END IF;
END;
$enable_public_event_counter_realtime$;

COMMENT ON TABLE public.public_event_counters IS
  'Realtime singleton counter for non-demo public events. Updated transactionally by an events trigger.';
