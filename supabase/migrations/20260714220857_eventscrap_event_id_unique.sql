CREATE UNIQUE INDEX IF NOT EXISTS eventscrap_event_id_uidx
  ON public.eventscrap (event_id)
  WHERE event_id IS NOT NULL;
