-- Support idempotent Geneva imports from Edge Functions.
CREATE UNIQUE INDEX IF NOT EXISTS event_occurrences_event_start_unique
  ON public.event_occurrences(event_id, starts_at);
