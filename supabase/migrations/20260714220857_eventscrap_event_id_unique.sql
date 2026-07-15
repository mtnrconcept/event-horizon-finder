-- `eventscrap` is an optional import staging table and is not copied to every
-- Supabase preview branch. Keep the migration replayable on clean databases.
DO $block$
BEGIN
  IF to_regclass('public.eventscrap') IS NOT NULL THEN
    EXECUTE $sql$
      CREATE UNIQUE INDEX IF NOT EXISTS eventscrap_event_id_uidx
        ON public.eventscrap (event_id)
        WHERE event_id IS NOT NULL
    $sql$;
  END IF;
END;
$block$;
