-- Organizer onboarding, consented client journeys and privacy-safe advertising.

-- ---------------------------------------------------------------------------
-- Client / organizer profiles and consent
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS birth_year SMALLINT,
  ADD COLUMN IF NOT EXISTS music_preferences TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS analytics_consent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS personalized_ads_consent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_account_type_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_account_type_check
      CHECK (account_type IN ('client', 'organizer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_birth_year_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_birth_year_check
      CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_music_preferences_size_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_music_preferences_size_check
      CHECK (cardinality(music_preferences) <= 20);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_home_city_id_fkey'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_home_city_id_fkey
      FOREIGN KEY (home_city_id) REFERENCES public.cities(id) ON DELETE SET NULL;
  END IF;
END;
$$;

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
ON public.profiles
FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK ((SELECT auth.uid()) = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metadata JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::JSONB);
  v_account_type TEXT;
  v_display_name TEXT;
  v_organizer_name TEXT;
  v_organizer_id UUID;
  v_organizer_slug TEXT;
  v_home_city_id UUID;
  v_birth_year SMALLINT;
  v_music_preferences TEXT[] := '{}'::TEXT[];
  v_analytics_consent BOOLEAN;
  v_ads_consent BOOLEAN;
BEGIN
  v_account_type := CASE
    WHEN v_metadata->>'account_type' = 'organizer' THEN 'organizer'
    ELSE 'client'
  END;
  v_display_name := NULLIF(left(trim(COALESCE(v_metadata->>'display_name', '')), 100), '');
  v_display_name := COALESCE(v_display_name, split_part(COALESCE(NEW.email, ''), '@', 1), 'Membre EVENTA');

  SELECT city.id
  INTO v_home_city_id
  FROM public.cities AS city
  WHERE city.id::TEXT = v_metadata->>'home_city_id'
  LIMIT 1;

  IF COALESCE(v_metadata->>'birth_year', '') ~ '^\d{4}$' THEN
    v_birth_year := (v_metadata->>'birth_year')::SMALLINT;
    IF v_birth_year < 1900 OR v_birth_year > EXTRACT(YEAR FROM CURRENT_DATE)::INT THEN
      v_birth_year := NULL;
    END IF;
  END IF;

  IF jsonb_typeof(v_metadata->'music_preferences') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT left(preference, 60)), '{}'::TEXT[])
    INTO v_music_preferences
    FROM jsonb_array_elements_text(v_metadata->'music_preferences') AS preference
    WHERE preference ~ '^[a-z0-9][a-z0-9-]{0,59}$';
  END IF;
  v_music_preferences := COALESCE(v_music_preferences[1:20], '{}'::TEXT[]);

  v_analytics_consent := COALESCE(v_metadata->>'analytics_consent', 'false') = 'true';
  v_ads_consent := COALESCE(v_metadata->>'personalized_ads_consent', 'false') = 'true';

  INSERT INTO public.profiles (
    id,
    display_name,
    home_city_id,
    account_type,
    birth_year,
    music_preferences,
    analytics_consent,
    personalized_ads_consent,
    consent_updated_at
  ) VALUES (
    NEW.id,
    v_display_name,
    v_home_city_id,
    v_account_type,
    v_birth_year,
    v_music_preferences,
    v_analytics_consent,
    v_ads_consent,
    CASE
      WHEN v_metadata ? 'analytics_consent' OR v_metadata ? 'personalized_ads_consent' THEN now()
      ELSE NULL
    END
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  IF v_account_type = 'organizer' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'organizer'::public.app_role)
    ON CONFLICT (user_id, role) DO NOTHING;

    v_organizer_name := NULLIF(left(trim(COALESCE(v_metadata->>'organizer_name', '')), 120), '');
    v_organizer_name := COALESCE(v_organizer_name, v_display_name);
    IF char_length(v_organizer_name) < 2 THEN
      v_organizer_name := 'Organisation EVENTA';
    END IF;

    v_organizer_slug := lower(public.unaccent(v_organizer_name));
    v_organizer_slug := regexp_replace(v_organizer_slug, '[^a-z0-9]+', '-', 'g');
    v_organizer_slug := trim(BOTH '-' FROM v_organizer_slug);
    v_organizer_slug := left(COALESCE(NULLIF(v_organizer_slug, ''), 'organisation'), 84)
      || '-' || substr(md5(NEW.id::TEXT), 1, 8);

    INSERT INTO public.organizers (name, slug, verification_level)
    VALUES (v_organizer_name, v_organizer_slug, 'unverified'::public.verification_level)
    RETURNING id INTO v_organizer_id;

    INSERT INTO public.organizer_members (organizer_id, user_id, role)
    VALUES (v_organizer_id, NEW.id, 'owner')
    ON CONFLICT (organizer_id, user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

UPDATE public.profiles AS profile
SET account_type = 'organizer'
WHERE EXISTS (
  SELECT 1
  FROM public.user_roles AS role
  WHERE role.user_id = profile.id
    AND role.role = 'organizer'::public.app_role
);

CREATE OR REPLACE FUNCTION public.create_organizer(_name TEXT, _slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_organizer_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF char_length(trim(_name)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Organizer name must contain between 2 and 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(_slug) NOT BETWEEN 2 AND 100
     OR _slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Invalid organizer slug' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizers (name, slug, verification_level)
  VALUES (trim(_name), _slug, 'unverified'::public.verification_level)
  RETURNING id INTO v_organizer_id;

  INSERT INTO public.organizer_members (organizer_id, user_id, role)
  VALUES (v_organizer_id, v_user_id, 'owner');

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'organizer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  UPDATE public.profiles
  SET account_type = 'organizer', updated_at = now()
  WHERE id = v_user_id;

  RETURN v_organizer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organizer(TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_organizer(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Consented client journey collection
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.client_journey_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  event_name TEXT NOT NULL,
  path TEXT NOT NULL,
  referrer_path TEXT,
  entity_type TEXT,
  entity_id UUID,
  city_id UUID REFERENCES public.cities(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_journey_event_name_check
    CHECK (event_name ~ '^[a-z0-9][a-z0-9_.:-]{1,63}$'),
  CONSTRAINT client_journey_path_check
    CHECK (char_length(path) BETWEEN 1 AND 500),
  CONSTRAINT client_journey_metadata_size_check
    CHECK (pg_column_size(metadata) <= 4096)
);

CREATE INDEX IF NOT EXISTS client_journey_user_time_idx
  ON public.client_journey_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_journey_event_time_idx
  ON public.client_journey_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_journey_entity_idx
  ON public.client_journey_events (entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

ALTER TABLE public.client_journey_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.client_journey_events TO authenticated;
GRANT ALL ON public.client_journey_events TO service_role;

CREATE POLICY "client_journeys_insert_consented_own"
ON public.client_journey_events
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.account_type = 'client'
      AND profile.analytics_consent
  )
);

CREATE POLICY "client_journeys_read_own"
ON public.client_journey_events
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "client_journeys_delete_own"
ON public.client_journey_events
FOR DELETE
TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.delete_my_client_journey()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM public.client_journey_events
  WHERE user_id = (SELECT auth.uid());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_client_journey() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_client_journey() TO authenticated;

-- ---------------------------------------------------------------------------
-- Organizer advertising campaigns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES public.organizers(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  objective TEXT NOT NULL DEFAULT 'awareness',
  promoted_event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  promoted_post_id UUID REFERENCES public.social_posts(id) ON DELETE SET NULL,
  headline TEXT NOT NULL,
  body TEXT,
  image_url TEXT,
  cta_label TEXT NOT NULL DEFAULT 'Découvrir',
  cta_url TEXT,
  placements TEXT[] NOT NULL DEFAULT ARRAY['discover', 'social']::TEXT[],
  target_city_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  target_age_min SMALLINT,
  target_age_max SMALLINT,
  target_music_genres TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  daily_budget NUMERIC(10,2) NOT NULL DEFAULT 10,
  total_budget NUMERIC(10,2) NOT NULL DEFAULT 70,
  currency TEXT NOT NULL DEFAULT 'CHF',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ad_campaigns_name_check CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  CONSTRAINT ad_campaigns_status_check
    CHECK (status IN ('draft', 'active', 'paused', 'completed', 'rejected')),
  CONSTRAINT ad_campaigns_objective_check
    CHECK (objective IN ('awareness', 'engagement', 'event_visits', 'ticket_sales')),
  CONSTRAINT ad_campaigns_entity_check
    CHECK (NOT (promoted_event_id IS NOT NULL AND promoted_post_id IS NOT NULL)),
  CONSTRAINT ad_campaigns_dates_check CHECK (ends_at > starts_at),
  CONSTRAINT ad_campaigns_budget_check
    CHECK (daily_budget > 0 AND total_budget >= daily_budget),
  CONSTRAINT ad_campaigns_age_check CHECK (
    (target_age_min IS NULL OR target_age_min BETWEEN 13 AND 100)
    AND (target_age_max IS NULL OR target_age_max BETWEEN 13 AND 100)
    AND (target_age_min IS NULL OR target_age_max IS NULL OR target_age_max >= target_age_min)
  ),
  CONSTRAINT ad_campaigns_target_size_check
    CHECK (cardinality(target_city_ids) <= 100 AND cardinality(target_music_genres) <= 20),
  CONSTRAINT ad_campaigns_placements_check
    CHECK (placements <@ ARRAY['discover', 'social', 'event']::TEXT[] AND cardinality(placements) > 0),
  CONSTRAINT ad_campaigns_urls_check CHECK (
    (image_url IS NULL OR image_url ~ '^https?://')
    AND (cta_url IS NULL OR cta_url ~ '^https?://')
  ),
  CONSTRAINT ad_campaigns_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS ad_campaigns_organizer_time_idx
  ON public.ad_campaigns (organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_campaigns_delivery_idx
  ON public.ad_campaigns (status, starts_at, ends_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ad_campaigns_target_cities_idx
  ON public.ad_campaigns USING GIN (target_city_ids);
CREATE INDEX IF NOT EXISTS ad_campaigns_target_genres_idx
  ON public.ad_campaigns USING GIN (target_music_genres);

ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_campaigns TO authenticated;
GRANT ALL ON public.ad_campaigns TO service_role;

CREATE OR REPLACE FUNCTION private.can_manage_ad_campaign(_organizer_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.organizer_members AS membership
        WHERE membership.organizer_id = _organizer_id
          AND membership.user_id = (SELECT auth.uid())
          AND membership.role IN ('owner', 'admin', 'editor')
      )
      OR public.has_role((SELECT auth.uid()), 'admin'::public.app_role)
    );
$$;

REVOKE ALL ON FUNCTION private.can_manage_ad_campaign(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_manage_ad_campaign(UUID) TO authenticated, service_role;

CREATE POLICY "ad_campaigns_member_read"
ON public.ad_campaigns
FOR SELECT
TO authenticated
USING ((SELECT private.can_manage_ad_campaign(organizer_id)));

CREATE POLICY "ad_campaigns_member_insert"
ON public.ad_campaigns
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND (SELECT private.can_manage_ad_campaign(organizer_id))
);

CREATE POLICY "ad_campaigns_member_update"
ON public.ad_campaigns
FOR UPDATE
TO authenticated
USING ((SELECT private.can_manage_ad_campaign(organizer_id)))
WITH CHECK (
  created_by IS NOT NULL
  AND (SELECT private.can_manage_ad_campaign(organizer_id))
);

CREATE POLICY "ad_campaigns_member_delete"
ON public.ad_campaigns
FOR DELETE
TO authenticated
USING ((SELECT private.can_manage_ad_campaign(organizer_id)));

CREATE OR REPLACE FUNCTION private.validate_ad_campaign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_by IS NULL AND (SELECT auth.uid()) IS NOT NULL THEN
    NEW.created_by := (SELECT auth.uid());
  END IF;

  IF NEW.promoted_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.events AS event
    WHERE event.id = NEW.promoted_event_id
      AND event.organizer_id = NEW.organizer_id
  ) THEN
    RAISE EXCEPTION 'The promoted event must belong to the campaign organizer'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.promoted_post_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.social_posts AS post
    WHERE post.id = NEW.promoted_post_id
      AND post.organizer_id = NEW.organizer_id
  ) THEN
    RAISE EXCEPTION 'The promoted post must belong to the campaign organizer'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' AND char_length(trim(NEW.headline)) < 2 THEN
    RAISE EXCEPTION 'An active campaign requires a headline' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' AND NEW.promoted_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.events AS event
    WHERE event.id = NEW.promoted_event_id
      AND event.status = 'published'::public.event_status
  ) THEN
    RAISE EXCEPTION 'Only a published event can be promoted' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' AND NEW.promoted_post_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.social_posts AS post
    WHERE post.id = NEW.promoted_post_id
      AND post.status = 'published'::public.social_post_status
  ) THEN
    RAISE EXCEPTION 'Only a published post can be promoted' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.validate_ad_campaign() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_ad_campaign ON public.ad_campaigns;
CREATE TRIGGER validate_ad_campaign
BEFORE INSERT OR UPDATE ON public.ad_campaigns
FOR EACH ROW EXECUTE FUNCTION private.validate_ad_campaign();

CREATE TABLE IF NOT EXISTS public.ad_campaign_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  placement TEXT NOT NULL,
  path TEXT NOT NULL,
  event_day DATE NOT NULL DEFAULT CURRENT_DATE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ad_campaign_delivery_type_check CHECK (event_type IN ('impression', 'click')),
  CONSTRAINT ad_campaign_delivery_placement_check CHECK (placement IN ('discover', 'social', 'event')),
  CONSTRAINT ad_campaign_delivery_path_check CHECK (char_length(path) BETWEEN 1 AND 500),
  UNIQUE (campaign_id, user_id, session_id, event_type, placement, event_day)
);

CREATE INDEX IF NOT EXISTS ad_campaign_delivery_campaign_time_idx
  ON public.ad_campaign_delivery_events (campaign_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ad_campaign_delivery_user_time_idx
  ON public.ad_campaign_delivery_events (user_id, occurred_at DESC);

ALTER TABLE public.ad_campaign_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_campaign_delivery_events FROM anon, authenticated;
GRANT ALL ON public.ad_campaign_delivery_events TO service_role;

CREATE OR REPLACE FUNCTION public.eligible_ad_campaigns(
  _placement TEXT DEFAULT 'discover',
  _limit INT DEFAULT 3
)
RETURNS TABLE (
  campaign_id UUID,
  organizer_name TEXT,
  headline TEXT,
  body TEXT,
  image_url TEXT,
  cta_label TEXT,
  cta_url TEXT,
  promoted_event_slug TEXT,
  promoted_post_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    campaign.id,
    organizer.name,
    campaign.headline,
    campaign.body,
    COALESCE(campaign.image_url, event.cover_image_url, organizer.logo_url),
    campaign.cta_label,
    campaign.cta_url,
    event.slug,
    campaign.promoted_post_id
  FROM public.profiles AS profile
  JOIN public.ad_campaigns AS campaign ON true
  JOIN public.organizers AS organizer ON organizer.id = campaign.organizer_id
  LEFT JOIN public.events AS event ON event.id = campaign.promoted_event_id
  WHERE profile.id = (SELECT auth.uid())
    AND profile.account_type = 'client'
    AND profile.personalized_ads_consent
    AND campaign.status = 'active'
    AND now() BETWEEN campaign.starts_at AND campaign.ends_at
    AND _placement = ANY(campaign.placements)
    AND (
      cardinality(campaign.target_city_ids) = 0
      OR profile.home_city_id = ANY(campaign.target_city_ids)
    )
    AND (
      campaign.target_age_min IS NULL
      OR profile.birth_year IS NOT NULL
         AND EXTRACT(YEAR FROM CURRENT_DATE)::INT - profile.birth_year >= campaign.target_age_min
    )
    AND (
      campaign.target_age_max IS NULL
      OR profile.birth_year IS NOT NULL
         AND EXTRACT(YEAR FROM CURRENT_DATE)::INT - profile.birth_year <= campaign.target_age_max
    )
    AND (
      cardinality(campaign.target_music_genres) = 0
      OR profile.music_preferences && campaign.target_music_genres
    )
  ORDER BY campaign.created_at DESC
  LIMIT least(greatest(_limit, 1), 10);
$$;

REVOKE ALL ON FUNCTION public.eligible_ad_campaigns(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eligible_ad_campaigns(TEXT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_ad_campaign_delivery(
  _campaign_id UUID,
  _event_type TEXT,
  _placement TEXT,
  _session_id UUID,
  _path TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row_count BIGINT;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR _event_type NOT IN ('impression', 'click')
     OR _placement NOT IN ('discover', 'social', 'event')
     OR char_length(_path) NOT BETWEEN 1 AND 500 THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.eligible_ad_campaigns(_placement, 10) AS eligible
    WHERE eligible.campaign_id = _campaign_id
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.ad_campaign_delivery_events (
    campaign_id, user_id, session_id, event_type, placement, path
  ) VALUES (
    _campaign_id, (SELECT auth.uid()), _session_id, _event_type, _placement, left(_path, 500)
  )
  ON CONFLICT (campaign_id, user_id, session_id, event_type, placement, event_day)
  DO NOTHING;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ad_campaign_delivery(UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_ad_campaign_delivery(UUID, TEXT, TEXT, UUID, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ad_campaign_performance(_organizer_id UUID)
RETURNS TABLE (
  campaign_id UUID,
  impression_count BIGINT,
  click_count BIGINT,
  unique_reach BIGINT,
  click_through_rate NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.can_manage_ad_campaign(_organizer_id) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    campaign.id,
    count(delivery.id) FILTER (WHERE delivery.event_type = 'impression'),
    count(delivery.id) FILTER (WHERE delivery.event_type = 'click'),
    count(DISTINCT delivery.user_id) FILTER (WHERE delivery.event_type = 'impression'),
    CASE
      WHEN count(delivery.id) FILTER (WHERE delivery.event_type = 'impression') = 0 THEN 0::NUMERIC
      ELSE round(
        100::NUMERIC * count(delivery.id) FILTER (WHERE delivery.event_type = 'click')
        / count(delivery.id) FILTER (WHERE delivery.event_type = 'impression'),
        2
      )
    END
  FROM public.ad_campaigns AS campaign
  LEFT JOIN public.ad_campaign_delivery_events AS delivery ON delivery.campaign_id = campaign.id
  WHERE campaign.organizer_id = _organizer_id
  GROUP BY campaign.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ad_campaign_performance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_campaign_performance(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.estimate_ad_campaign_audience(
  _city_ids UUID[] DEFAULT '{}'::UUID[],
  _age_min SMALLINT DEFAULT NULL,
  _age_max SMALLINT DEFAULT NULL,
  _genres TEXT[] DEFAULT '{}'::TEXT[]
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.organizer_members AS membership
    WHERE membership.user_id = (SELECT auth.uid())
      AND membership.role IN ('owner', 'admin', 'editor')
  ) THEN
    RAISE EXCEPTION 'Organizer access required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO v_count
  FROM public.profiles AS profile
  WHERE profile.account_type = 'client'
    AND profile.personalized_ads_consent
    AND (cardinality(_city_ids) = 0 OR profile.home_city_id = ANY(_city_ids))
    AND (
      _age_min IS NULL
      OR profile.birth_year IS NOT NULL
         AND EXTRACT(YEAR FROM CURRENT_DATE)::INT - profile.birth_year >= _age_min
    )
    AND (
      _age_max IS NULL
      OR profile.birth_year IS NOT NULL
         AND EXTRACT(YEAR FROM CURRENT_DATE)::INT - profile.birth_year <= _age_max
    )
    AND (cardinality(_genres) = 0 OR profile.music_preferences && _genres);

  -- Never expose tiny audience counts that could reveal an individual profile.
  IF v_count < 20 THEN
    RETURN 0;
  END IF;
  RETURN round(v_count::NUMERIC / 10)::BIGINT * 10;
END;
$$;

REVOKE ALL ON FUNCTION public.estimate_ad_campaign_audience(UUID[], SMALLINT, SMALLINT, TEXT[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estimate_ad_campaign_audience(UUID[], SMALLINT, SMALLINT, TEXT[])
  TO authenticated;

COMMENT ON TABLE public.client_journey_events IS
  'First-party client journey events stored only after explicit analytics consent.';
COMMENT ON TABLE public.ad_campaign_delivery_events IS
  'Private delivery events. Organizers receive aggregate campaign performance only.';
