-- Avoid retry storms for temporarily unresponsive sources and remove a duplicate social index.
DROP INDEX IF EXISTS public.social_comments_post_status_idx;

UPDATE public.data_sources
SET next_sync_at = GREATEST(
      COALESCE(next_sync_at, '-infinity'::timestamptz),
      now() + CASE WHEN sync_frequency = 'weekly' THEN interval '24 hours' ELSE interval '6 hours' END
    ),
    updated_at = now()
WHERE status = 'active'
  AND last_sync_at IS NULL
  AND domain IN (
    'usine.ch',
    'billetterie-culture.geneve.ch',
    'montreuxjazzfestival.com'
  );
