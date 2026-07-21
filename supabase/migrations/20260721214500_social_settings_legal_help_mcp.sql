-- Global Party / Partyfinder social network, settings, legal and help-center foundation.
-- Additive migration: existing events, posts, comments and likes are preserved.
BEGIN;

-- ---------------------------------------------------------------------------
-- Public profile fields and a large, typed settings surface
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS website_url text,
  ADD COLUMN IF NOT EXISTS pronouns text,
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS social_onboarding_completed boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_uidx
  ON public.profiles (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_visibility text NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public','followers','private')),
  show_online_status boolean NOT NULL DEFAULT true,
  show_activity_status boolean NOT NULL DEFAULT true,
  show_followers_count boolean NOT NULL DEFAULT true,
  show_following_count boolean NOT NULL DEFAULT true,
  allow_follow_requests boolean NOT NULL DEFAULT true,
  allow_messages_from text NOT NULL DEFAULT 'following' CHECK (allow_messages_from IN ('everyone','following','none')),
  allow_mentions_from text NOT NULL DEFAULT 'everyone' CHECK (allow_mentions_from IN ('everyone','following','none')),
  allow_tagging_from text NOT NULL DEFAULT 'following' CHECK (allow_tagging_from IN ('everyone','following','none')),
  discoverable_by_email boolean NOT NULL DEFAULT false,
  discoverable_by_phone boolean NOT NULL DEFAULT false,
  search_engine_indexing boolean NOT NULL DEFAULT false,
  feed_ranking text NOT NULL DEFAULT 'balanced' CHECK (feed_ranking IN ('recommended','balanced','chronological')),
  show_suggested_posts boolean NOT NULL DEFAULT true,
  show_sponsored_posts boolean NOT NULL DEFAULT true,
  sensitive_content_level text NOT NULL DEFAULT 'standard' CHECK (sensitive_content_level IN ('less','standard','more')),
  autoplay_videos boolean NOT NULL DEFAULT true,
  autoplay_muted boolean NOT NULL DEFAULT true,
  preferred_categories text[] NOT NULL DEFAULT '{}',
  muted_keywords text[] NOT NULL DEFAULT '{}',
  notification_push_enabled boolean NOT NULL DEFAULT true,
  notification_email_enabled boolean NOT NULL DEFAULT true,
  notification_in_app_enabled boolean NOT NULL DEFAULT true,
  notify_new_follower boolean NOT NULL DEFAULT true,
  notify_follow_request boolean NOT NULL DEFAULT true,
  notify_post_like boolean NOT NULL DEFAULT true,
  notify_post_comment boolean NOT NULL DEFAULT true,
  notify_post_share boolean NOT NULL DEFAULT true,
  notify_mentions boolean NOT NULL DEFAULT true,
  notify_event_reminders boolean NOT NULL DEFAULT true,
  notify_event_changes boolean NOT NULL DEFAULT true,
  notify_nearby_events boolean NOT NULL DEFAULT false,
  notify_recommendations boolean NOT NULL DEFAULT true,
  notify_marketing boolean NOT NULL DEFAULT false,
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start time NOT NULL DEFAULT '22:00',
  quiet_hours_end time NOT NULL DEFAULT '08:00',
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  high_contrast boolean NOT NULL DEFAULT false,
  reduced_motion boolean NOT NULL DEFAULT false,
  compact_mode boolean NOT NULL DEFAULT false,
  font_scale numeric(3,2) NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.80 AND 1.50),
  locale text NOT NULL DEFAULT 'fr',
  timezone text NOT NULL DEFAULT 'Europe/Zurich',
  week_starts_on smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
  precise_location boolean NOT NULL DEFAULT false,
  nearby_recommendations boolean NOT NULL DEFAULT true,
  background_location boolean NOT NULL DEFAULT false,
  location_history boolean NOT NULL DEFAULT false,
  data_saver boolean NOT NULL DEFAULT false,
  media_quality text NOT NULL DEFAULT 'auto' CHECK (media_quality IN ('auto','standard','high')),
  download_on_wifi_only boolean NOT NULL DEFAULT true,
  login_alerts boolean NOT NULL DEFAULT true,
  remember_devices boolean NOT NULL DEFAULT true,
  personalized_recommendations boolean NOT NULL DEFAULT true,
  personalized_ads boolean NOT NULL DEFAULT false,
  analytics_enabled boolean NOT NULL DEFAULT false,
  crash_reports_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;
DROP POLICY IF EXISTS user_settings_own_all ON public.user_settings;
CREATE POLICY user_settings_own_all ON public.user_settings
  FOR ALL TO authenticated USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.ensure_user_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_settings (user_id, locale)
  VALUES (NEW.id, COALESCE(NEW.locale, 'fr'))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_ensure_settings ON public.profiles;
CREATE TRIGGER trg_profiles_ensure_settings
AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.ensure_user_settings();

INSERT INTO public.user_settings (user_id, locale, personalized_ads, analytics_enabled)
SELECT id, COALESCE(locale, 'fr'), COALESCE(personalized_ads_consent, false), COALESCE(analytics_consent, false)
FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Social graph and richer posts
-- ---------------------------------------------------------------------------
ALTER TABLE public.social_posts ALTER COLUMN organizer_id DROP NOT NULL;
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS author_display_name text,
  ADD COLUMN IF NOT EXISTS author_avatar_url text,
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS location_name text,
  ADD COLUMN IF NOT EXISTS mood text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allow_sharing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS share_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_request_id uuid,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_visibility_check') THEN
    ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_visibility_check
      CHECK (visibility IN ('public','followers','private'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_author_check') THEN
    ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_author_check
      CHECK (organizer_id IS NOT NULL OR author_user_id IS NOT NULL OR created_by IS NOT NULL);
  END IF;
END $$;

UPDATE public.social_posts AS post
SET author_user_id = COALESCE(post.author_user_id, post.created_by),
    author_display_name = COALESCE(post.author_display_name, profile.display_name, 'Utilisateur'),
    author_avatar_url = COALESCE(post.author_avatar_url, profile.avatar_url)
FROM public.profiles AS profile
WHERE profile.id = post.created_by
  AND (post.author_user_id IS NULL OR post.author_display_name IS NULL);

CREATE INDEX IF NOT EXISTS social_posts_feed_idx ON public.social_posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS social_posts_author_idx ON public.social_posts (author_user_id, published_at DESC);
CREATE INDEX IF NOT EXISTS social_posts_tags_gin ON public.social_posts USING gin(tags);
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_client_request_uidx
  ON public.social_posts (author_user_id, client_request_id)
  WHERE author_user_id IS NOT NULL AND client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.social_user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX IF NOT EXISTS social_user_follows_followed_idx
  ON public.social_user_follows (followed_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.social_post_saves (
  post_id uuid NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.social_user_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS public.social_user_mutes (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_organizer_id uuid REFERENCES public.organizers(id) ON DELETE CASCADE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((muted_user_id IS NOT NULL)::int + (muted_organizer_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS social_user_mutes_user_uidx
  ON public.social_user_mutes (user_id, muted_user_id) WHERE muted_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS social_user_mutes_org_uidx
  ON public.social_user_mutes (user_id, muted_organizer_id) WHERE muted_organizer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.social_content_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('post','comment','profile','organizer')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('spam','harassment','hate','violence','nudity','misinformation','copyright','other')),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (reporter_id, subject_type, subject_id, reason)
);

CREATE TABLE IF NOT EXISTS public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id uuid,
  action_url text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_notifications_inbox_idx
  ON public.user_notifications (user_id, read_at, created_at DESC);

ALTER TABLE public.social_user_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_user_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_user_follows, public.social_post_saves,
  public.social_user_blocks, public.social_user_mutes, public.social_content_reports TO authenticated;
GRANT SELECT, UPDATE, DELETE ON public.user_notifications TO authenticated;
GRANT ALL ON public.social_user_follows, public.social_post_saves, public.social_user_blocks,
  public.social_user_mutes, public.social_content_reports, public.user_notifications TO service_role;

DROP POLICY IF EXISTS social_follows_visible ON public.social_user_follows;
CREATE POLICY social_follows_visible ON public.social_user_follows FOR SELECT TO authenticated
  USING (follower_id = (SELECT auth.uid()) OR followed_id = (SELECT auth.uid()) OR status = 'accepted');
DROP POLICY IF EXISTS social_follows_insert_own ON public.social_user_follows;
CREATE POLICY social_follows_insert_own ON public.social_user_follows FOR INSERT TO authenticated
  WITH CHECK (follower_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_follows_update_involved ON public.social_user_follows;
CREATE POLICY social_follows_update_involved ON public.social_user_follows FOR UPDATE TO authenticated
  USING (follower_id = (SELECT auth.uid()) OR followed_id = (SELECT auth.uid()))
  WITH CHECK (follower_id = (SELECT auth.uid()) OR followed_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_follows_delete_involved ON public.social_user_follows;
CREATE POLICY social_follows_delete_involved ON public.social_user_follows FOR DELETE TO authenticated
  USING (follower_id = (SELECT auth.uid()) OR followed_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS social_saves_own_all ON public.social_post_saves;
CREATE POLICY social_saves_own_all ON public.social_post_saves FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_blocks_own_all ON public.social_user_blocks;
CREATE POLICY social_blocks_own_all ON public.social_user_blocks FOR ALL TO authenticated
  USING (blocker_id = (SELECT auth.uid())) WITH CHECK (blocker_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_mutes_own_all ON public.social_user_mutes;
CREATE POLICY social_mutes_own_all ON public.social_user_mutes FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_reports_insert_own ON public.social_content_reports;
CREATE POLICY social_reports_insert_own ON public.social_content_reports FOR INSERT TO authenticated
  WITH CHECK (reporter_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_reports_read_own ON public.social_content_reports;
CREATE POLICY social_reports_read_own ON public.social_content_reports FOR SELECT TO authenticated
  USING (reporter_id = (SELECT auth.uid()) OR public.has_role((SELECT auth.uid()), 'moderator') OR public.has_role((SELECT auth.uid()), 'admin'));
DROP POLICY IF EXISTS notifications_own_read ON public.user_notifications;
CREATE POLICY notifications_own_read ON public.user_notifications FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS notifications_own_update ON public.user_notifications;
CREATE POLICY notifications_own_update ON public.user_notifications FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS notifications_own_delete ON public.user_notifications;
CREATE POLICY notifications_own_delete ON public.user_notifications FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION private.can_manage_social_post(_post_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.social_posts AS post
    WHERE post.id = _post_id
      AND (
        post.author_user_id = (SELECT auth.uid())
        OR post.created_by = (SELECT auth.uid())
        OR (post.organizer_id IS NOT NULL AND private.can_publish_for_organizer(post.organizer_id))
        OR private.can_moderate_social_content()
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.validate_social_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE author_profile record;
BEGIN
  IF NEW.created_by IS NULL AND (SELECT auth.uid()) IS NOT NULL THEN
    NEW.created_by := (SELECT auth.uid());
  END IF;
  IF NEW.author_user_id IS NULL AND NEW.organizer_id IS NULL THEN
    NEW.author_user_id := COALESCE(NEW.created_by, (SELECT auth.uid()));
  END IF;
  IF NEW.author_user_id IS NOT NULL THEN
    SELECT display_name, avatar_url INTO author_profile
    FROM public.profiles WHERE id = NEW.author_user_id;
    NEW.author_display_name := COALESCE(NULLIF(trim(NEW.author_display_name), ''), author_profile.display_name, 'Utilisateur');
    NEW.author_avatar_url := COALESCE(NEW.author_avatar_url, author_profile.avatar_url);
  END IF;
  IF NEW.event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.events AS event
    WHERE event.id = NEW.event_id
      AND (NEW.organizer_id IS NULL OR event.organizer_id = NEW.organizer_id)
      AND event.status IN ('published','postponed','sold_out')
  ) THEN
    RAISE EXCEPTION 'The linked event must be public and belong to the organizer when an organizer is set' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published'::public.social_post_status THEN
    IF NULLIF(trim(NEW.body), '') IS NULL AND NEW.event_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.social_post_media AS media WHERE media.post_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'A published post requires text, an event, or media' USING ERRCODE = '23514';
    END IF;
    NEW.published_at := COALESCE(NEW.published_at, now());
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.body IS DISTINCT FROM OLD.body THEN NEW.edited_at := now(); END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS social_posts_public_read ON public.social_posts;
CREATE POLICY social_posts_public_read ON public.social_posts FOR SELECT TO anon, authenticated
  USING (status = 'published'::public.social_post_status AND published_at IS NOT NULL
    AND published_at <= now() AND visibility = 'public');
DROP POLICY IF EXISTS social_posts_network_read ON public.social_posts;
CREATE POLICY social_posts_network_read ON public.social_posts FOR SELECT TO authenticated
  USING (
    status = 'published'::public.social_post_status AND published_at IS NOT NULL AND published_at <= now()
    AND (
      author_user_id = (SELECT auth.uid())
      OR visibility = 'public'
      OR (visibility = 'followers' AND EXISTS (
        SELECT 1 FROM public.social_user_follows f
        WHERE f.follower_id = (SELECT auth.uid()) AND f.followed_id = social_posts.author_user_id AND f.status = 'accepted'
      ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.social_user_blocks b
      WHERE (b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = social_posts.author_user_id)
         OR (b.blocker_id = social_posts.author_user_id AND b.blocked_id = (SELECT auth.uid()))
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.social_user_mutes m
      WHERE m.user_id = (SELECT auth.uid())
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND (m.muted_user_id = social_posts.author_user_id OR m.muted_organizer_id = social_posts.organizer_id)
    )
  );
DROP POLICY IF EXISTS social_posts_publishers_insert ON public.social_posts;
CREATE POLICY social_posts_publishers_insert ON public.social_posts FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND status IN ('draft'::public.social_post_status, 'published'::public.social_post_status)
    AND (
      (author_user_id = (SELECT auth.uid()) AND organizer_id IS NULL)
      OR (organizer_id IS NOT NULL AND private.can_publish_for_organizer(organizer_id))
    )
  );
DROP POLICY IF EXISTS social_posts_publishers_read ON public.social_posts;
CREATE POLICY social_posts_publishers_read ON public.social_posts FOR SELECT TO authenticated
  USING (author_user_id = (SELECT auth.uid()) OR created_by = (SELECT auth.uid())
    OR (organizer_id IS NOT NULL AND private.can_publish_for_organizer(organizer_id)));
DROP POLICY IF EXISTS social_posts_publishers_update ON public.social_posts;
CREATE POLICY social_posts_publishers_update ON public.social_posts FOR UPDATE TO authenticated
  USING (status <> 'hidden'::public.social_post_status AND private.can_manage_social_post(id))
  WITH CHECK (status IN ('draft'::public.social_post_status, 'published'::public.social_post_status)
    AND private.can_manage_social_post(id));
DROP POLICY IF EXISTS social_posts_publishers_delete ON public.social_posts;
CREATE POLICY social_posts_publishers_delete ON public.social_posts FOR DELETE TO authenticated
  USING (private.can_manage_social_post(id));

CREATE OR REPLACE FUNCTION private.update_social_save_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_id uuid := COALESCE(NEW.post_id, OLD.post_id);
BEGIN
  UPDATE public.social_posts SET save_count = (
    SELECT count(*)::integer FROM public.social_post_saves WHERE post_id = target_id
  ) WHERE id = target_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_social_post_saves_count ON public.social_post_saves;
CREATE TRIGGER trg_social_post_saves_count AFTER INSERT OR DELETE ON public.social_post_saves
FOR EACH ROW EXECUTE FUNCTION private.update_social_save_count();

CREATE OR REPLACE FUNCTION public.set_social_follow(_followed_id uuid, _active boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_user uuid := auth.uid(); next_status text;
BEGIN
  IF current_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF current_user = _followed_id THEN RAISE EXCEPTION 'You cannot follow yourself' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM social_user_blocks WHERE (blocker_id=current_user AND blocked_id=_followed_id) OR (blocker_id=_followed_id AND blocked_id=current_user)) THEN
    RAISE EXCEPTION 'Follow is unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT _active THEN
    DELETE FROM social_user_follows WHERE follower_id=current_user AND followed_id=_followed_id;
    RETURN 'not_following';
  END IF;
  SELECT CASE WHEN COALESCE(s.profile_visibility, CASE WHEN p.is_private THEN 'private' ELSE 'public' END)='private' THEN 'pending' ELSE 'accepted' END
    INTO next_status FROM profiles p LEFT JOIN user_settings s ON s.user_id=p.id WHERE p.id=_followed_id;
  IF next_status IS NULL THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO social_user_follows(follower_id, followed_id, status) VALUES(current_user,_followed_id,next_status)
  ON CONFLICT(follower_id,followed_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now();
  RETURN next_status;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_social_follow(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- Connected accounts: metadata only. OAuth tokens must stay server-side.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connected_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('facebook','instagram','google','spotify','apple','tiktok','x','linkedin')),
  provider_account_id text,
  display_name text,
  avatar_url text,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','revoked','error')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(user_id, provider, provider_account_id)
);
ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON public.connected_accounts TO authenticated;
GRANT ALL ON public.connected_accounts TO service_role;
DROP POLICY IF EXISTS connected_accounts_own_read ON public.connected_accounts;
CREATE POLICY connected_accounts_own_read ON public.connected_accounts FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
DROP POLICY IF EXISTS connected_accounts_own_delete ON public.connected_accounts;
CREATE POLICY connected_accounts_own_delete ON public.connected_accounts FOR DELETE TO authenticated USING (user_id=(SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- Cookie consent, legal documents, FAQ and support center
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cookie_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_id text,
  necessary boolean NOT NULL DEFAULT true CHECK (necessary),
  analytics boolean NOT NULL DEFAULT false,
  personalization boolean NOT NULL DEFAULT false,
  advertising boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL DEFAULT '2026-07-21',
  source text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cookie_consents_user_idx ON public.cookie_consents(user_id, updated_at DESC);
ALTER TABLE public.cookie_consents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.cookie_consents TO authenticated;
GRANT ALL ON public.cookie_consents TO service_role;
DROP POLICY IF EXISTS cookie_consents_own_all ON public.cookie_consents;
CREATE POLICY cookie_consents_own_all ON public.cookie_consents FOR ALL TO authenticated
  USING (user_id=(SELECT auth.uid())) WITH CHECK (user_id=(SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK (document_type IN ('terms','privacy','cookies','community_guidelines')),
  locale text NOT NULL DEFAULT 'fr',
  version text NOT NULL,
  title text NOT NULL,
  summary text,
  body_markdown text NOT NULL,
  effective_at timestamptz NOT NULL,
  published_at timestamptz,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_type, locale, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_current_uidx
  ON public.legal_documents(document_type, locale) WHERE is_current;

CREATE TABLE IF NOT EXISTS public.help_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  description text,
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.help_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES public.help_categories(id) ON DELETE SET NULL,
  slug text UNIQUE NOT NULL,
  locale text NOT NULL DEFAULT 'fr',
  title text NOT NULL,
  excerpt text,
  body_markdown text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  is_featured boolean NOT NULL DEFAULT false,
  is_published boolean NOT NULL DEFAULT true,
  view_count bigint NOT NULL DEFAULT 0,
  helpful_count bigint NOT NULL DEFAULT 0,
  unhelpful_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS help_articles_search_gin ON public.help_articles USING gin(keywords);
CREATE TABLE IF NOT EXISTS public.faq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  locale text NOT NULL DEFAULT 'fr',
  question text NOT NULL,
  answer_markdown text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  subject text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_user','resolved','closed')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.legal_documents, public.help_categories, public.help_articles, public.faq_items TO anon, authenticated;
GRANT SELECT, INSERT ON public.support_tickets TO authenticated;
GRANT ALL ON public.legal_documents, public.help_categories, public.help_articles, public.faq_items, public.support_tickets TO service_role;

DROP POLICY IF EXISTS legal_public_read ON public.legal_documents;
CREATE POLICY legal_public_read ON public.legal_documents FOR SELECT TO anon, authenticated USING (is_current AND published_at IS NOT NULL AND published_at <= now());
DROP POLICY IF EXISTS help_categories_public_read ON public.help_categories;
CREATE POLICY help_categories_public_read ON public.help_categories FOR SELECT TO anon, authenticated USING (is_published);
DROP POLICY IF EXISTS help_articles_public_read ON public.help_articles;
CREATE POLICY help_articles_public_read ON public.help_articles FOR SELECT TO anon, authenticated USING (is_published);
DROP POLICY IF EXISTS faq_public_read ON public.faq_items;
CREATE POLICY faq_public_read ON public.faq_items FOR SELECT TO anon, authenticated USING (is_published);
DROP POLICY IF EXISTS support_tickets_own_insert ON public.support_tickets;
CREATE POLICY support_tickets_own_insert ON public.support_tickets FOR INSERT TO authenticated WITH CHECK (user_id=(SELECT auth.uid()));
DROP POLICY IF EXISTS support_tickets_own_read ON public.support_tickets;
CREATE POLICY support_tickets_own_read ON public.support_tickets FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid()) OR public.has_role((SELECT auth.uid()),'moderator') OR public.has_role((SELECT auth.uid()),'admin'));

INSERT INTO public.help_categories(slug,title,description,icon,sort_order) VALUES
 ('getting-started','Bien démarrer','Créer son compte et personnaliser son expérience.','rocket',10),
 ('events','Événements','Découvrir, enregistrer, partager et organiser des sorties.','calendar',20),
 ('social','Réseau social','Publications, commentaires, abonnements et sécurité.','users',30),
 ('privacy','Confidentialité et sécurité','Contrôler ses données, sa visibilité et ses connexions.','shield',40),
 ('organizers','Organisateurs','Publier des événements et animer sa communauté.','megaphone',50)
ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, icon=EXCLUDED.icon, sort_order=EXCLUDED.sort_order;

INSERT INTO public.faq_items(category,question,answer_markdown,sort_order) VALUES
 ('Compte','Comment modifier mes préférences ?','Ouvrez **Paramètres** depuis votre profil. Chaque section peut être enregistrée séparément et les choix sensibles sont désactivés par défaut.',10),
 ('Événements','Comment enregistrer un événement ?','Touchez l’icône cœur sur une fiche. Vous le retrouverez dans **Favoris** et pourrez l’ajouter à votre agenda.',20),
 ('Réseau social','Qui peut voir mes publications ?','Vous choisissez pour chaque publication : public, abonnés ou privé. Les blocages et mises en sourdine sont appliqués au fil.',30),
 ('Sécurité','Comment signaler un contenu ?','Utilisez le menu de la publication ou du commentaire, choisissez un motif et ajoutez des précisions. Le signalement reste confidentiel.',40),
 ('Données','Comment exporter ou supprimer mes données ?','La section **Paramètres > Données et compte** permet de demander un export ou une suppression. Une vérification d’identité peut être demandée pour protéger le compte.',50),
 ('Cookies','Puis-je refuser les cookies non essentiels ?','Oui. Les catégories analyse, personnalisation et publicité sont facultatives et modifiables à tout moment.',60)
ON CONFLICT DO NOTHING;

-- Realtime: additions are guarded to remain idempotent.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['social_posts','social_comments','social_post_likes','social_post_saves','user_notifications'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
