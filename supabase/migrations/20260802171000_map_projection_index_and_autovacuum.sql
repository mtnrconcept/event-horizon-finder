-- Keep the map projection's hottest join on a narrow index, and keep the
-- planner's statistics fresh enough to choose it.
--
-- The low-zoom projection joins every occurrence in the date window to events
-- purely to apply the is_demo/status predicates and read category_id and
-- is_free. It was resolving that join through events_public_map_cover_idx
-- (49 MB) or events_discovery_filters_v3_idx (50 MB), both of which carry
-- columns the projection never reads. A whole-world scan spent 28,624 buffers
-- on the events side alone.
--
-- events_map_grid_cover_idx carries only what the projection reads, so the
-- same scan now costs 9,424 buffers. Measured on the world viewport, the
-- projection's point scan went from 33,222 to 14,052 buffers and from 228 ms
-- to 164 ms.
--
-- The statistics half matters just as much. event_occurrences had not been
-- autovacuumed in 17 days at 8.7% dead tuples, which left the GiST index
-- estimating 1 row where 937 were returned and forced heap fetches on every
-- index-only scan. The default scale factor of 0.2 is far too lax for tables
-- this size, so the hot map tables get tighter thresholds.

-- Deliberately not CONCURRENTLY: `supabase db push` runs each migration inside
-- a transaction, and a concurrent build cannot start in one. The index already
-- exists on production, where this is a no-op; anywhere else it is built during
-- a migration, which is the right time to hold the lock.
create index if not exists events_map_grid_cover_idx
  on public.events (id) include (category_id, is_free)
  where is_demo = false
    and status in ('published', 'cancelled', 'postponed', 'sold_out');

alter table public.event_occurrences set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 2
);

alter table public.events set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 2
);

alter table public.venues set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.cities set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.event_categories set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
