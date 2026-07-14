-- Explicitly remove anonymous table privileges and cover campaign foreign keys.

REVOKE ALL ON public.ad_campaigns FROM anon;
REVOKE ALL ON public.client_journey_events FROM anon;
REVOKE ALL ON public.ad_campaign_delivery_events FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS ad_campaigns_created_by_idx
  ON public.ad_campaigns (created_by);
CREATE INDEX IF NOT EXISTS ad_campaigns_promoted_event_idx
  ON public.ad_campaigns (promoted_event_id)
  WHERE promoted_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_campaigns_promoted_post_idx
  ON public.ad_campaigns (promoted_post_id)
  WHERE promoted_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_journey_city_idx
  ON public.client_journey_events (city_id)
  WHERE city_id IS NOT NULL;

-- The table is written only by the guarded RPC. This explicit deny policy makes
-- the intentional RLS posture visible to database advisors and future maintainers.
CREATE POLICY "ad_delivery_no_direct_read"
ON public.ad_campaign_delivery_events
FOR SELECT
TO authenticated
USING (false);
