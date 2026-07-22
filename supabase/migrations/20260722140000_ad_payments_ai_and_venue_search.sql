-- Paid advertising lifecycle, privacy-safe organizer insights and venue autocomplete.
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

ALTER TABLE public.ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_status_check;
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_status_check
  CHECK (status IN ('draft', 'pending_payment', 'active', 'paused', 'completed', 'rejected'));
ALTER TABLE public.ad_campaigns ADD CONSTRAINT ad_campaigns_payment_status_check
  CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded'));
CREATE UNIQUE INDEX IF NOT EXISTS ad_campaigns_stripe_session_uidx
  ON public.ad_campaigns (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- Preserve already-running campaigns while requiring payment for every new activation.
UPDATE public.ad_campaigns SET payment_status = 'paid', paid_at = COALESCE(paid_at, created_at)
WHERE status IN ('active', 'paused', 'completed');
CREATE OR REPLACE FUNCTION private.require_paid_ad_activation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Campaign payment is required before activation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ad_campaign_payment_required ON public.ad_campaigns;
CREATE TRIGGER trg_ad_campaign_payment_required BEFORE INSERT OR UPDATE ON public.ad_campaigns
FOR EACH ROW EXECUTE FUNCTION private.require_paid_ad_activation();

-- The browser only receives aggregated engagement for events owned by the caller.
CREATE OR REPLACE FUNCTION public.get_organizer_event_ad_insights(_organizer_id uuid)
RETURNS TABLE (
  event_id uuid, title text, short_description text, genres text[], city_id uuid,
  cover_image_url text, official_url text, view_count bigint, like_count bigint,
  comment_count bigint, engagement_score bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = '' STABLE AS $$
  SELECT e.id, e.title, e.short_description, e.genres, e.city_id,
    e.cover_image_url, e.official_url,
    count(DISTINCT j.id) FILTER (WHERE j.event_name IN ('page_view','map_pin_click')) AS views,
    count(DISTINCT l.user_id) AS likes,
    count(DISTINCT c.id) FILTER (WHERE c.status = 'published') AS comments,
    count(DISTINCT j.id) FILTER (WHERE j.event_name IN ('page_view','map_pin_click'))
      + count(DISTINCT l.user_id) * 3
      + count(DISTINCT c.id) FILTER (WHERE c.status = 'published') * 4 AS score
  FROM public.events e
  LEFT JOIN public.client_journey_events j ON j.entity_type = 'event' AND j.entity_id = e.id
    AND j.occurred_at >= now() - interval '90 days'
  LEFT JOIN public.social_posts p ON p.event_id = e.id AND p.status = 'published'
  LEFT JOIN public.social_post_likes l ON l.post_id = p.id
  LEFT JOIN public.social_comments c ON c.post_id = p.id
  WHERE e.organizer_id = _organizer_id
    AND e.status = 'published'
    AND public.is_organizer_member(_organizer_id, (SELECT auth.uid()))
  GROUP BY e.id
  ORDER BY score DESC, e.updated_at DESC
  LIMIT 20
$$;
REVOKE ALL ON FUNCTION public.get_organizer_event_ad_insights(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organizer_event_ad_insights(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.search_venues(_query text, _limit integer DEFAULT 8)
RETURNS TABLE (id uuid, name text, address text, postal_code text, city_id uuid, city_name text)
LANGUAGE sql SECURITY INVOKER SET search_path = '' STABLE AS $$
  SELECT v.id, v.name, v.address, v.postal_code, v.city_id, c.name
  FROM public.venues v LEFT JOIN public.cities c ON c.id = v.city_id
  WHERE v.is_public
    AND char_length(trim(_query)) >= 1
    AND (v.name ILIKE '%' || trim(_query) || '%'
      OR coalesce(v.address, '') ILIKE '%' || trim(_query) || '%'
      OR coalesce(c.name, '') ILIKE '%' || trim(_query) || '%')
  ORDER BY CASE WHEN v.name ILIKE trim(_query) || '%' THEN 0 ELSE 1 END,
    similarity(v.name, trim(_query)) DESC, v.name
  LIMIT least(greatest(_limit, 1), 12)
$$;
REVOKE ALL ON FUNCTION public.search_venues(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_venues(text, integer) TO authenticated;
