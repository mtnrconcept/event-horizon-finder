-- Global Party discovery performance v3
-- Additive only: no table, row, function or existing index is removed.
BEGIN;

CREATE INDEX IF NOT EXISTS event_occurrences_discovery_window_v3_idx
  ON public.event_occurrences (starts_at, event_id)
  INCLUDE (ends_at, timezone, latitude, longitude);

CREATE INDEX IF NOT EXISTS events_discovery_filters_v3_idx
  ON public.events (status, category_id, is_free, venue_id, id)
  INCLUDE (slug, is_verified, is_demo);

CREATE INDEX IF NOT EXISTS venues_city_discovery_v3_idx
  ON public.venues (city_id, id);

ANALYZE public.event_occurrences;
ANALYZE public.events;
ANALYZE public.venues;

COMMIT;
