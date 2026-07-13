
-- ============ EXTENSIONS ============
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('user', 'organizer', 'moderator', 'admin');
CREATE TYPE public.event_status AS ENUM ('draft','pending_review','published','cancelled','postponed','sold_out','archived');
CREATE TYPE public.occurrence_status AS ENUM ('scheduled','cancelled','postponed','sold_out','completed');
CREATE TYPE public.ticket_status AS ENUM ('unknown','available','limited','sold_out','free','on_sale_soon');
CREATE TYPE public.ingestion_status AS ENUM ('queued','running','completed','partially_completed','failed','cancelled','awaiting_review');
CREATE TYPE public.verification_level AS ENUM ('unverified','community','partner','official');
CREATE TYPE public.data_source_type AS ENUM ('official_site','venue_site','organizer_site','partner_feed','manual','import');

-- ============ HELPER: updated_at trigger ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  locale TEXT DEFAULT 'fr',
  home_city_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_roles_select_own" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Auto profile + user role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ GEO: countries / regions / cities ============
CREATE TABLE public.countries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE public.regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id UUID NOT NULL REFERENCES public.countries(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE public.cities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id UUID NOT NULL REFERENCES public.countries(id) ON DELETE CASCADE,
  region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location geography(Point,4326),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cities_location_gix ON public.cities USING GIST(location);
CREATE INDEX cities_name_trgm ON public.cities USING GIN(name gin_trgm_ops);

GRANT SELECT ON public.countries, public.regions, public.cities TO anon, authenticated;
GRANT ALL ON public.countries, public.regions, public.cities TO service_role;
ALTER TABLE public.countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "countries_public_read" ON public.countries FOR SELECT USING (true);
CREATE POLICY "regions_public_read" ON public.regions FOR SELECT USING (true);
CREATE POLICY "cities_public_read" ON public.cities FOR SELECT USING (true);
CREATE POLICY "cities_admin_write" ON public.cities FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ============ CATEGORIES ============
CREATE TABLE public.event_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name_fr TEXT NOT NULL,
  name_en TEXT NOT NULL,
  icon TEXT,
  sort_order INT NOT NULL DEFAULT 0
);
GRANT SELECT ON public.event_categories TO anon, authenticated;
GRANT ALL ON public.event_categories TO service_role;
ALTER TABLE public.event_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "categories_public_read" ON public.event_categories FOR SELECT USING (true);
CREATE POLICY "categories_admin_write" ON public.event_categories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ============ ORGANIZERS ============
CREATE TABLE public.organizers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  website TEXT,
  logo_url TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verification_level public.verification_level NOT NULL DEFAULT 'unverified',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organizers_updated BEFORE UPDATE ON public.organizers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.organizer_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES public.organizers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner|admin|editor|member
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organizer_id, user_id)
);
CREATE TABLE public.organizer_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES public.organizers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_by UUID REFERENCES auth.users(id),
  reviewed_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.organizers TO anon, authenticated;
GRANT INSERT, UPDATE ON public.organizers TO authenticated;
GRANT ALL ON public.organizers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizer_members TO authenticated;
GRANT ALL ON public.organizer_members TO service_role;
GRANT SELECT, INSERT ON public.organizer_verifications TO authenticated;
GRANT ALL ON public.organizer_verifications TO service_role;

ALTER TABLE public.organizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_verifications ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_organizer_member(_org UUID, _user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizer_members WHERE organizer_id=_org AND user_id=_user);
$$;

CREATE POLICY "organizers_public_read" ON public.organizers FOR SELECT USING (true);
CREATE POLICY "organizers_member_update" ON public.organizers FOR UPDATE TO authenticated
  USING (public.is_organizer_member(id, auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "organizers_insert_auth" ON public.organizers FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "org_members_read_own" ON public.organizer_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_organizer_member(organizer_id, auth.uid()) OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "org_members_manage" ON public.organizer_members FOR ALL TO authenticated
  USING (public.is_organizer_member(organizer_id, auth.uid()) OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.is_organizer_member(organizer_id, auth.uid()) OR public.has_role(auth.uid(),'admin'));

CREATE POLICY "org_verif_read" ON public.organizer_verifications FOR SELECT TO authenticated
  USING (public.is_organizer_member(organizer_id, auth.uid()) OR public.has_role(auth.uid(),'moderator') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "org_verif_insert" ON public.organizer_verifications FOR INSERT TO authenticated
  WITH CHECK (public.is_organizer_member(organizer_id, auth.uid()));

-- ============ VENUES ============
CREATE TABLE public.venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  address TEXT,
  postal_code TEXT,
  city_id UUID REFERENCES public.cities(id) ON DELETE SET NULL,
  country_id UUID REFERENCES public.countries(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location geography(Point,4326),
  website TEXT,
  cover_image_url TEXT,
  capacity INT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  is_public BOOLEAN NOT NULL DEFAULT true,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX venues_location_gix ON public.venues USING GIST(location);
CREATE INDEX venues_name_trgm ON public.venues USING GIN(name gin_trgm_ops);
CREATE TRIGGER trg_venues_updated BEFORE UPDATE ON public.venues FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.venue_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  alias TEXT NOT NULL
);

GRANT SELECT ON public.venues, public.venue_aliases TO anon, authenticated;
GRANT INSERT, UPDATE ON public.venues TO authenticated;
GRANT ALL ON public.venues, public.venue_aliases TO service_role;
ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venue_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "venues_public_read" ON public.venues FOR SELECT USING (is_public);
CREATE POLICY "venues_admin_write" ON public.venues FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "venue_aliases_public_read" ON public.venue_aliases FOR SELECT USING (true);

-- ============ PERFORMERS ============
CREATE TABLE public.performers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  bio TEXT,
  image_url TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX performers_name_trgm ON public.performers USING GIN(name gin_trgm_ops);
GRANT SELECT ON public.performers TO anon, authenticated;
GRANT INSERT, UPDATE ON public.performers TO authenticated;
GRANT ALL ON public.performers TO service_role;
ALTER TABLE public.performers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "performers_public_read" ON public.performers FOR SELECT USING (true);
CREATE POLICY "performers_admin_write" ON public.performers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));

-- ============ EVENTS ============
CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  short_description TEXT,
  description TEXT,
  category_id UUID REFERENCES public.event_categories(id) ON DELETE SET NULL,
  organizer_id UUID REFERENCES public.organizers(id) ON DELETE SET NULL,
  venue_id UUID REFERENCES public.venues(id) ON DELETE SET NULL,
  status public.event_status NOT NULL DEFAULT 'draft',
  publication_status TEXT NOT NULL DEFAULT 'draft',
  age_restriction TEXT,
  is_free BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verification_level public.verification_level NOT NULL DEFAULT 'unverified',
  source_confidence NUMERIC(4,1) DEFAULT 0,
  language TEXT,
  official_url TEXT,
  cover_image_url TEXT,
  genres TEXT[] DEFAULT '{}',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  search_tsv TSVECTOR,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_status_idx ON public.events(status);
CREATE INDEX events_category_idx ON public.events(category_id);
CREATE INDEX events_search_gin ON public.events USING GIN(search_tsv);
CREATE INDEX events_title_trgm ON public.events USING GIN(title gin_trgm_ops);
CREATE TRIGGER trg_events_updated BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.events_search_tsv_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.title,''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.short_description,''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(coalesce(NEW.description,''))), 'C') ||
    setweight(to_tsvector('simple', unaccent(coalesce(array_to_string(NEW.genres,' '),''))), 'B');
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_events_tsv BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_search_tsv_update();

CREATE TABLE public.event_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  doors_open_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  local_start_date DATE,
  local_end_date DATE,
  status public.occurrence_status NOT NULL DEFAULT 'scheduled',
  ticket_status public.ticket_status NOT NULL DEFAULT 'unknown',
  capacity INT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location geography(Point,4326),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX occ_event_idx ON public.event_occurrences(event_id);
CREATE INDEX occ_starts_idx ON public.event_occurrences(starts_at);
CREATE INDEX occ_location_gix ON public.event_occurrences USING GIST(location);
CREATE TRIGGER trg_occ_updated BEFORE UPDATE ON public.event_occurrences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.event_performers (
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  performer_id UUID NOT NULL REFERENCES public.performers(id) ON DELETE CASCADE,
  is_headliner BOOLEAN DEFAULT false,
  PRIMARY KEY(event_id, performer_id)
);
CREATE TABLE public.event_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image',
  attribution TEXT,
  license TEXT,
  source_url TEXT,
  sort_order INT DEFAULT 0
);
CREATE TABLE public.ticket_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_min NUMERIC(10,2),
  price_max NUMERIC(10,2),
  currency TEXT DEFAULT 'EUR',
  is_free BOOLEAN DEFAULT false,
  ticket_url TEXT,
  status public.ticket_status DEFAULT 'unknown'
);
CREATE TABLE public.event_accessibility (
  event_id UUID PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  wheelchair BOOLEAN DEFAULT false,
  hearing_loop BOOLEAN DEFAULT false,
  sign_language BOOLEAN DEFAULT false,
  quiet_space BOOLEAN DEFAULT false,
  notes TEXT
);
CREATE TABLE public.event_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  previous_status public.event_status,
  new_status public.event_status NOT NULL,
  changed_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.events, public.event_occurrences, public.event_performers, public.event_media, public.ticket_offers, public.event_accessibility TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.events, public.event_occurrences, public.event_performers, public.event_media, public.ticket_offers, public.event_accessibility TO authenticated;
GRANT SELECT, INSERT ON public.event_status_history TO authenticated;
GRANT ALL ON public.events, public.event_occurrences, public.event_performers, public.event_media, public.ticket_offers, public.event_accessibility, public.event_status_history TO service_role;

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_performers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_accessibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_status_history ENABLE ROW LEVEL SECURITY;

-- Public read: published + cancelled (annulé reste visible) + sold_out + postponed
CREATE POLICY "events_public_read" ON public.events FOR SELECT
  USING (status IN ('published','cancelled','postponed','sold_out'));
CREATE POLICY "events_owner_read" ON public.events FOR SELECT TO authenticated
  USING (
    (organizer_id IS NOT NULL AND public.is_organizer_member(organizer_id, auth.uid()))
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(),'moderator')
    OR public.has_role(auth.uid(),'admin')
  );
CREATE POLICY "events_owner_write" ON public.events FOR ALL TO authenticated
  USING (
    (organizer_id IS NOT NULL AND public.is_organizer_member(organizer_id, auth.uid()))
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(),'admin')
  )
  WITH CHECK (
    (organizer_id IS NOT NULL AND public.is_organizer_member(organizer_id, auth.uid()))
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(),'admin')
  );

CREATE POLICY "occ_public_read" ON public.event_occurrences FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.status IN ('published','cancelled','postponed','sold_out')));
CREATE POLICY "occ_owner_write" ON public.event_occurrences FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

CREATE POLICY "ep_public_read" ON public.event_performers FOR SELECT USING (true);
CREATE POLICY "ep_owner_write" ON public.event_performers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

CREATE POLICY "em_public_read" ON public.event_media FOR SELECT USING (true);
CREATE POLICY "em_owner_write" ON public.event_media FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

CREATE POLICY "to_public_read" ON public.ticket_offers FOR SELECT USING (true);
CREATE POLICY "to_owner_write" ON public.ticket_offers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

CREATE POLICY "ea_public_read" ON public.event_accessibility FOR SELECT USING (true);
CREATE POLICY "ea_owner_write" ON public.event_accessibility FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

CREATE POLICY "esh_owner_read" ON public.event_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND (
    (e.organizer_id IS NOT NULL AND public.is_organizer_member(e.organizer_id, auth.uid()))
    OR e.created_by = auth.uid() OR public.has_role(auth.uid(),'admin'))));

-- ============ FAVORITES / FOLLOWS / CALENDAR ============
CREATE TABLE public.favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, event_id)
);
CREATE TABLE public.followed_venues (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  venue_id UUID NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, venue_id)
);
CREATE TABLE public.followed_organizers (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organizer_id UUID NOT NULL REFERENCES public.organizers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, organizer_id)
);
CREATE TABLE public.followed_performers (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  performer_id UUID NOT NULL REFERENCES public.performers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, performer_id)
);
CREATE TABLE public.calendar_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  occurrence_id UUID REFERENCES public.event_occurrences(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, occurrence_id)
);
GRANT SELECT, INSERT, DELETE ON public.favorites, public.followed_venues, public.followed_organizers, public.followed_performers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_items TO authenticated;
GRANT ALL ON public.favorites, public.followed_venues, public.followed_organizers, public.followed_performers, public.calendar_items TO service_role;

ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followed_venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followed_organizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followed_performers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fav_own_all" ON public.favorites FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE POLICY "fv_own_all" ON public.followed_venues FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE POLICY "fo_own_all" ON public.followed_organizers FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE POLICY "fp_own_all" ON public.followed_performers FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE POLICY "cal_own_all" ON public.calendar_items FOR ALL TO authenticated USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);

-- ============ DATA SOURCES / INGESTION ============
CREATE TABLE public.source_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT UNIQUE NOT NULL,
  is_authorized BOOLEAN NOT NULL DEFAULT false,
  authorized_by UUID REFERENCES auth.users(id),
  authorized_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID REFERENCES public.organizers(id) ON DELETE SET NULL,
  venue_id UUID REFERENCES public.venues(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  source_type public.data_source_type NOT NULL DEFAULT 'official_site',
  base_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  is_authorized BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  sync_frequency TEXT DEFAULT 'daily',
  last_sync_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  legal_basis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID REFERENCES public.data_sources(id) ON DELETE SET NULL,
  firecrawl_id TEXT,
  status public.ingestion_status NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  pages_found INT DEFAULT 0,
  pages_success INT DEFAULT 0,
  pages_failed INT DEFAULT 0,
  events_created INT DEFAULT 0,
  events_updated INT DEFAULT 0,
  duplicates_found INT DEFAULT 0,
  credits_used INT,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.ingestion_job_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_job_id UUID NOT NULL REFERENCES public.ingestion_jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  processed_at TIMESTAMPTZ
);
CREATE TABLE public.source_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID REFERENCES public.data_sources(id) ON DELETE SET NULL,
  ingestion_job_id UUID REFERENCES public.ingestion_jobs(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  external_identifier TEXT,
  raw_markdown TEXT,
  raw_json JSONB,
  content_hash TEXT,
  extracted_data JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_status TEXT DEFAULT 'pending',
  error_message TEXT,
  webhook_id TEXT UNIQUE
);
CREATE INDEX sr_hash_idx ON public.source_records(content_hash);
CREATE TABLE public.merge_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_a UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  event_b UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  score NUMERIC(5,1) NOT NULL,
  status TEXT DEFAULT 'pending',
  reviewed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.event_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  reported_by UUID REFERENCES auth.users(id),
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.moderation_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  status TEXT DEFAULT 'open',
  assigned_to UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.source_domains, public.data_sources, public.ingestion_jobs, public.ingestion_job_items, public.source_records, public.merge_candidates, public.moderation_cases, public.audit_logs TO service_role;
GRANT SELECT ON public.source_domains, public.data_sources, public.ingestion_jobs, public.ingestion_job_items, public.source_records, public.merge_candidates, public.moderation_cases, public.audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.event_reports TO authenticated;
GRANT ALL ON public.event_reports TO service_role;

ALTER TABLE public.source_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sd_admin_read" ON public.source_domains FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "ds_admin_read" ON public.data_sources FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "ij_admin_read" ON public.ingestion_jobs FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "iji_admin_read" ON public.ingestion_job_items FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "sr_admin_read" ON public.source_records FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "mc_admin_read" ON public.merge_candidates FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "mod_admin_read" ON public.moderation_cases FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'moderator'));
CREATE POLICY "audit_admin_read" ON public.audit_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "reports_insert_auth" ON public.event_reports FOR INSERT TO authenticated WITH CHECK (auth.uid()=reported_by OR reported_by IS NULL);
CREATE POLICY "reports_read_own" ON public.event_reports FOR SELECT TO authenticated
  USING (reported_by = auth.uid() OR public.has_role(auth.uid(),'moderator') OR public.has_role(auth.uid(),'admin'));

-- ============ DISCOVERY FUNCTION ============
CREATE OR REPLACE FUNCTION public.discover_events(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  _category_slugs TEXT[] DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _limit INT DEFAULT 40,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  event_id UUID,
  occurrence_id UUID,
  slug TEXT,
  title TEXT,
  short_description TEXT,
  cover_image_url TEXT,
  category_slug TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT,
  venue_name TEXT,
  city_name TEXT,
  is_free BOOLEAN,
  is_verified BOOLEAN,
  is_demo BOOLEAN,
  status public.event_status,
  distance_km NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    e.id AS event_id,
    o.id AS occurrence_id,
    e.slug,
    e.title,
    e.short_description,
    e.cover_image_url,
    c.slug AS category_slug,
    o.starts_at,
    o.ends_at,
    o.timezone,
    v.name AS venue_name,
    ci.name AS city_name,
    e.is_free,
    e.is_verified,
    e.is_demo,
    e.status,
    CASE WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND o.location IS NOT NULL
      THEN ROUND((ST_Distance(o.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography)/1000)::numeric, 2)
      ELSE NULL END AS distance_km
  FROM public.events e
  JOIN public.event_occurrences o ON o.event_id = e.id
  LEFT JOIN public.event_categories c ON c.id = e.category_id
  LEFT JOIN public.venues v ON v.id = e.venue_id
  LEFT JOIN public.cities ci ON ci.id = v.city_id
  WHERE e.status IN ('published','cancelled','postponed','sold_out')
    AND o.starts_at >= _from AND o.starts_at <= _to
    AND (_category_slugs IS NULL OR c.slug = ANY(_category_slugs))
    AND (_city_id IS NULL OR v.city_id = _city_id)
    AND (_free_only = false OR e.is_free = true)
    AND (_query IS NULL OR e.search_tsv @@ plainto_tsquery('simple', unaccent(_query))
         OR e.title ILIKE '%'||_query||'%'
         OR v.name ILIKE '%'||_query||'%')
    AND (
      _lat IS NULL OR _lon IS NULL OR o.location IS NULL OR
      ST_DWithin(o.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography, _radius_km*1000)
    )
  ORDER BY o.starts_at ASC
  LIMIT _limit OFFSET _offset;
$$;

GRANT EXECUTE ON FUNCTION public.discover_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_organizer_member(UUID, UUID) TO authenticated;

-- Sync location columns from lat/lon
CREATE OR REPLACE FUNCTION public.sync_location_from_latlon()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude),4326)::geography;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_venue_loc BEFORE INSERT OR UPDATE ON public.venues FOR EACH ROW EXECUTE FUNCTION public.sync_location_from_latlon();
CREATE TRIGGER trg_occ_loc BEFORE INSERT OR UPDATE ON public.event_occurrences FOR EACH ROW EXECUTE FUNCTION public.sync_location_from_latlon();
CREATE TRIGGER trg_city_loc BEFORE INSERT OR UPDATE ON public.cities FOR EACH ROW EXECUTE FUNCTION public.sync_location_from_latlon();
