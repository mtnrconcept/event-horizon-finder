-- Controlled rollback for 20260722014500_discovery_performance_v3.sql.
-- Run only after confirming no query plan depends critically on these indexes.
BEGIN;
DROP INDEX IF EXISTS public.event_occurrences_discovery_window_v3_idx;
DROP INDEX IF EXISTS public.events_discovery_filters_v3_idx;
DROP INDEX IF EXISTS public.venues_city_discovery_v3_idx;
COMMIT;
