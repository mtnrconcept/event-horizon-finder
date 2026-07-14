-- Scale EVENTA's catalogue ingestion while keeping public discovery trustworthy.

ALTER TABLE public.data_sources
  ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES public.cities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_slug TEXT REFERENCES public.event_categories(slug) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS page_count INT NOT NULL DEFAULT 1 CHECK (page_count BETWEEN 1 AND 40),
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES public.cities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS quality_score SMALLINT NOT NULL DEFAULT 0 CHECK (quality_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS data_sources_sync_idx
  ON public.data_sources(status, is_authorized, is_verified, priority, last_sync_at);
CREATE INDEX IF NOT EXISTS events_city_idx ON public.events(city_id);
CREATE UNIQUE INDEX IF NOT EXISTS events_canonical_fingerprint_uidx
  ON public.events(canonical_fingerprint)
  WHERE canonical_fingerprint IS NOT NULL;
DROP TRIGGER IF EXISTS trg_data_sources_updated ON public.data_sources;
CREATE TRIGGER trg_data_sources_updated
  BEFORE UPDATE ON public.data_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Locations used by the new regional source catalogue.
WITH switzerland AS (
  SELECT id FROM public.countries WHERE code = 'CH' LIMIT 1
), vaud AS (
  INSERT INTO public.regions(country_id, name)
  SELECT id, 'Vaud' FROM switzerland
  WHERE NOT EXISTS (
    SELECT 1 FROM public.regions r JOIN switzerland s ON s.id = r.country_id WHERE r.name = 'Vaud'
  )
  RETURNING id, country_id
)
INSERT INTO public.cities(country_id, region_id, slug, name, timezone, latitude, longitude)
SELECT s.id, COALESCE(v.id, (SELECT id FROM public.regions WHERE country_id = s.id AND name = 'Vaud' LIMIT 1)), x.slug, x.name, 'Europe/Zurich', x.latitude, x.longitude
FROM switzerland s
LEFT JOIN vaud v ON v.country_id = s.id
CROSS JOIN (VALUES
  ('lausanne', 'Lausanne', 46.5197::double precision, 6.6323::double precision),
  ('nyon', 'Nyon', 46.3833::double precision, 6.2391::double precision),
  ('montreux', 'Montreux', 46.4312::double precision, 6.9107::double precision),
  ('crans-pres-celigny', 'Crans-près-Céligny', 46.3565::double precision, 6.2068::double precision)
) AS x(slug, name, latitude, longitude)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  timezone = EXCLUDED.timezone,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude;

-- The allow-list is explicit: the scraper cannot be redirected to arbitrary URLs.
INSERT INTO public.source_domains(domain, is_authorized, authorized_at, notes)
VALUES
  ('geneve.ch', true, now(), 'Agenda public officiel de la Ville de Genève; métadonnées factuelles et liens sources uniquement.'),
  ('billetterie-culture.geneve.ch', true, now(), 'Billetterie culturelle publique officielle de la Ville de Genève.'),
  ('ladecadanse.darksite.ch', true, now(), 'Agenda public genevois; métadonnées factuelles et liens vers les fiches originales.'),
  ('geneva-arena.ch', true, now(), 'Agenda public officiel de la salle.'),
  ('palexpo.ch', true, now(), 'Agenda public officiel du lieu.'),
  ('ptrnet.ch', true, now(), 'Agenda public officiel du lieu.'),
  ('lezoo.ch', true, now(), 'Agenda public officiel du club.'),
  ('villagedusoir.com', true, now(), 'Agenda public officiel du club.'),
  ('audio-club.ch', true, now(), 'Agenda public officiel du club.'),
  ('usine.ch', true, now(), 'Agenda public officiel du lieu.'),
  ('chatnoir.ch', true, now(), 'Agenda public officiel du lieu.'),
  ('lausanne.ch', true, now(), 'Agenda public officiel de la Ville de Lausanne.'),
  ('docks.ch', true, now(), 'Agenda public officiel de la salle.'),
  ('dclub.ch', true, now(), 'Agenda public officiel du club.'),
  ('mad.club', true, now(), 'Agenda public officiel du club.'),
  ('paleo.ch', true, now(), 'Programme public officiel du festival.'),
  ('montreuxjazzfestival.com', true, now(), 'Programme public officiel du festival.'),
  ('caribana.ch', true, now(), 'Programme public officiel du festival.'),
  ('antigel.ch', true, now(), 'Programme public officiel du festival.')
ON CONFLICT (domain) DO UPDATE SET
  is_authorized = EXCLUDED.is_authorized,
  authorized_at = COALESCE(public.source_domains.authorized_at, EXCLUDED.authorized_at),
  notes = EXCLUDED.notes;

WITH city_ids AS (
  SELECT
    max(id::text) FILTER (WHERE slug = 'geneve')::uuid AS geneve,
    max(id::text) FILTER (WHERE slug = 'lausanne')::uuid AS lausanne,
    max(id::text) FILTER (WHERE slug = 'nyon')::uuid AS nyon,
    max(id::text) FILTER (WHERE slug = 'montreux')::uuid AS montreux,
    max(id::text) FILTER (WHERE slug = 'crans-pres-celigny')::uuid AS crans
  FROM public.cities
), sources(name, source_type, base_url, domain, city_key, category_slug, page_count, priority, sync_frequency, legal_basis, metadata) AS (
  VALUES
    ('Genève — clubbing', 'official_site'::public.data_source_type, 'https://www.geneve.ch/agenda?f%5B0%5D=what%3AClubbing', 'geneve.ch', 'geneve', 'soirees', 3, 10, 'daily', 'Agenda public officiel; faits, dates et liens uniquement.', '{"pagination":"page"}'::jsonb),
    ('Genève — concerts', 'official_site'::public.data_source_type, 'https://www.geneve.ch/agenda?f%5B0%5D=what%3AConcert', 'geneve.ch', 'geneve', 'concerts', 10, 20, 'daily', 'Agenda public officiel; faits, dates et liens uniquement.', '{"pagination":"page"}'::jsonb),
    ('Genève — festivals', 'official_site'::public.data_source_type, 'https://www.geneve.ch/agenda?f%5B0%5D=what%3AFestival', 'geneve.ch', 'geneve', 'festivals', 5, 15, 'daily', 'Agenda public officiel; faits, dates et liens uniquement.', '{"pagination":"page"}'::jsonb),
    ('Billetterie culturelle Genève', 'official_site'::public.data_source_type, 'https://billetterie-culture.geneve.ch/list/events?lang=fr', 'billetterie-culture.geneve.ch', 'geneve', 'concerts', 1, 30, 'daily', 'Billetterie publique officielle; faits, dates et liens uniquement.', '{}'::jsonb),
    ('La Décadanse Genève', 'partner_feed'::public.data_source_type, 'https://ladecadanse.darksite.ch/agenda.php?region=ge', 'ladecadanse.darksite.ch', 'geneve', 'soirees', 1, 12, 'daily', 'Agenda public; faits, dates et liens uniquement.', '{}'::jsonb),
    ('Geneva Arena', 'venue_site'::public.data_source_type, 'https://www.geneva-arena.ch/fr/evenements', 'geneva-arena.ch', 'geneve', 'concerts', 1, 40, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Palexpo', 'venue_site'::public.data_source_type, 'https://palexpo.ch/evenements/', 'palexpo.ch', 'geneve', 'festivals', 1, 45, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('PTR / L’Usine', 'venue_site'::public.data_source_type, 'https://www.ptrnet.ch/agenda/', 'ptrnet.ch', 'geneve', 'concerts', 1, 25, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Le Zoo', 'venue_site'::public.data_source_type, 'https://lezoo.ch/agenda/', 'lezoo.ch', 'geneve', 'soirees', 1, 18, 'daily', 'Programme public officiel du club.', '{}'::jsonb),
    ('Village du Soir', 'venue_site'::public.data_source_type, 'https://villagedusoir.com/evenements/', 'villagedusoir.com', 'geneve', 'soirees', 1, 18, 'daily', 'Programme public officiel du club.', '{}'::jsonb),
    ('Audio Club', 'venue_site'::public.data_source_type, 'https://audio-club.ch/events/', 'audio-club.ch', 'geneve', 'soirees', 1, 18, 'daily', 'Programme public officiel du club.', '{}'::jsonb),
    ('L’Usine Genève', 'venue_site'::public.data_source_type, 'https://www.usine.ch/agenda/', 'usine.ch', 'geneve', 'concerts', 1, 26, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Chat Noir', 'venue_site'::public.data_source_type, 'https://chatnoir.ch/agenda/', 'chatnoir.ch', 'geneve', 'concerts', 1, 28, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Lausanne — agenda officiel', 'official_site'::public.data_source_type, 'https://www.lausanne.ch/agenda', 'lausanne.ch', 'lausanne', 'soirees', 4, 35, 'daily', 'Agenda public officiel; faits, dates et liens uniquement.', '{"pagination":"page"}'::jsonb),
    ('Les Docks', 'venue_site'::public.data_source_type, 'https://www.docks.ch/agenda/', 'docks.ch', 'lausanne', 'concerts', 1, 30, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('D! Club', 'venue_site'::public.data_source_type, 'https://www.dclub.ch/events/', 'dclub.ch', 'lausanne', 'soirees', 1, 22, 'daily', 'Programme public officiel du club.', '{}'::jsonb),
    ('MAD Club', 'venue_site'::public.data_source_type, 'https://www.mad.club/agenda/', 'mad.club', 'lausanne', 'soirees', 1, 22, 'daily', 'Programme public officiel du club.', '{}'::jsonb),
    ('Paléo Festival', 'organizer_site'::public.data_source_type, 'https://yeah.paleo.ch/fr/programme', 'paleo.ch', 'nyon', 'festivals', 1, 50, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Montreux Jazz Festival', 'organizer_site'::public.data_source_type, 'https://www.montreuxjazzfestival.com/fr/programme/', 'montreuxjazzfestival.com', 'montreux', 'festivals', 1, 50, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Caribana Festival', 'organizer_site'::public.data_source_type, 'https://caribana.ch/fr/programmation-du-caribana-festival/', 'caribana.ch', 'crans', 'festivals', 1, 50, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Festival Antigel', 'organizer_site'::public.data_source_type, 'https://antigel.ch/programme/', 'antigel.ch', 'geneve', 'festivals', 1, 50, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb)
)
INSERT INTO public.data_sources(
  name, source_type, base_url, domain, city_id, category_slug, page_count, priority,
  sync_frequency, is_authorized, is_verified, status, legal_basis, metadata
)
SELECT
  s.name,
  s.source_type,
  s.base_url,
  s.domain,
  CASE s.city_key
    WHEN 'geneve' THEN c.geneve
    WHEN 'lausanne' THEN c.lausanne
    WHEN 'nyon' THEN c.nyon
    WHEN 'montreux' THEN c.montreux
    WHEN 'crans' THEN c.crans
  END,
  s.category_slug,
  s.page_count,
  s.priority,
  s.sync_frequency,
  true,
  true,
  'active',
  s.legal_basis,
  s.metadata
FROM sources s CROSS JOIN city_ids c
WHERE NOT EXISTS (SELECT 1 FROM public.data_sources d WHERE d.name = s.name)
ON CONFLICT DO NOTHING;

-- Keep existing rows aligned with the authoritative source registry.
UPDATE public.data_sources d
SET is_authorized = true,
    is_verified = true,
    city_id = COALESCE(d.city_id, (SELECT id FROM public.cities WHERE slug = 'geneve')),
    legal_basis = CASE
      WHEN d.legal_basis IS NULL OR d.legal_basis ILIKE '%démonstration%'
        THEN 'Agenda public officiel; métadonnées factuelles et liens sources uniquement.'
      ELSE d.legal_basis
    END
WHERE d.domain IN ('geneve.ch', 'billetterie-culture.geneve.ch');

-- Transactional ingestion: validation, classification, venue resolution, fuzzy dedupe,
-- quality scoring and controlled publication happen atomically.
CREATE OR REPLACE FUNCTION public.upsert_ingested_event(
  _data_source_id UUID,
  _source_url TEXT,
  _title TEXT,
  _description TEXT,
  _starts_at TIMESTAMPTZ,
  _ends_at TIMESTAMPTZ DEFAULT NULL,
  _venue_name TEXT DEFAULT NULL,
  _address TEXT DEFAULT NULL,
  _latitude DOUBLE PRECISION DEFAULT NULL,
  _longitude DOUBLE PRECISION DEFAULT NULL,
  _category TEXT DEFAULT NULL,
  _ticket_url TEXT DEFAULT NULL,
  _image_url TEXT DEFAULT NULL,
  _is_free BOOLEAN DEFAULT false,
  _external_identifier TEXT DEFAULT NULL
)
RETURNS TABLE(event_id UUID, action TEXT, score INT, published BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source public.data_sources%ROWTYPE;
  v_title TEXT := left(trim(_title), 240);
  v_description TEXT := nullif(left(trim(coalesce(_description, '')), 6000), '');
  v_category_slug TEXT;
  v_category_id UUID;
  v_city_id UUID;
  v_city_name TEXT;
  v_venue_id UUID;
  v_venue_slug TEXT;
  v_event_id UUID;
  v_occurrence_id UUID;
  v_fingerprint TEXT;
  v_slug TEXT;
  v_score INT := 0;
  v_publish BOOLEAN := false;
  v_action TEXT := 'created';
  v_official_url TEXT;
  v_image_url TEXT;
  v_ticket_url TEXT;
BEGIN
  SELECT * INTO v_source
  FROM public.data_sources
  WHERE id = _data_source_id AND status = 'active' AND is_authorized AND is_verified;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_not_authorized';
  END IF;
  IF length(v_title) < 3 THEN
    RAISE EXCEPTION 'invalid_title';
  END IF;
  IF _starts_at IS NULL OR _starts_at < now() - interval '2 days' OR _starts_at > now() + interval '24 months' THEN
    RAISE EXCEPTION 'invalid_start_date';
  END IF;
  IF _ends_at IS NOT NULL AND _ends_at < _starts_at THEN
    _ends_at := NULL;
  END IF;
  IF _latitude IS NOT NULL AND (_latitude < -90 OR _latitude > 90) THEN _latitude := NULL; END IF;
  IF _longitude IS NOT NULL AND (_longitude < -180 OR _longitude > 180) THEN _longitude := NULL; END IF;

  v_city_id := v_source.city_id;
  SELECT name INTO v_city_name FROM public.cities WHERE id = v_city_id;

  v_category_slug := CASE
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(club|clubbing|soir|night|dj|electro|techno|house|disco|afterwork)' THEN 'soirees'
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(festival|open.?air)' THEN 'festivals'
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(concert|musique|music|live|opera)' THEN 'concerts'
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(theatre|spectacle|comedie|danse)' THEN 'theatre'
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(expo|musee|vernissage|art)' THEN 'expositions'
    WHEN unaccent(lower(coalesce(_category, ''))) ~ '(famille|enfant|kids)' THEN 'famille'
    ELSE v_source.category_slug
  END;
  SELECT id INTO v_category_id FROM public.event_categories WHERE slug = v_category_slug;

  IF nullif(trim(coalesce(_venue_name, '')), '') IS NOT NULL THEN
    SELECT v.id INTO v_venue_id
    FROM public.venues v
    WHERE (v.city_id = v_city_id OR v_city_id IS NULL)
      AND similarity(unaccent(lower(v.name)), unaccent(lower(trim(_venue_name)))) >= 0.82
    ORDER BY similarity(unaccent(lower(v.name)), unaccent(lower(trim(_venue_name)))) DESC
    LIMIT 1;

    IF v_venue_id IS NULL THEN
      v_venue_slug := left(
        trim(both '-' from regexp_replace(
          unaccent(lower(trim(_venue_name) || '-' || coalesce(v_city_name, 'suisse'))),
          '[^a-z0-9]+', '-', 'g'
        )),
        100
      );
      INSERT INTO public.venues(
        slug, name, address, city_id, country_id, latitude, longitude,
        website, is_verified, is_public, is_demo
      )
      VALUES (
        v_venue_slug,
        left(trim(_venue_name), 180),
        nullif(left(trim(coalesce(_address, '')), 300), ''),
        v_city_id,
        (SELECT country_id FROM public.cities WHERE id = v_city_id),
        _latitude,
        _longitude,
        v_source.base_url,
        v_source.is_verified,
        true,
        false
      )
      ON CONFLICT (slug) DO UPDATE SET
        address = COALESCE(public.venues.address, EXCLUDED.address),
        city_id = COALESCE(public.venues.city_id, EXCLUDED.city_id),
        latitude = COALESCE(public.venues.latitude, EXCLUDED.latitude),
        longitude = COALESCE(public.venues.longitude, EXCLUDED.longitude),
        website = COALESCE(public.venues.website, EXCLUDED.website)
      RETURNING id INTO v_venue_id;
    ELSE
      UPDATE public.venues SET
        address = COALESCE(address, nullif(left(trim(coalesce(_address, '')), 300), '')),
        latitude = COALESCE(latitude, _latitude),
        longitude = COALESCE(longitude, _longitude)
      WHERE id = v_venue_id;
    END IF;
  END IF;

  v_official_url := CASE WHEN coalesce(_source_url, '') ~ '^https?://' THEN left(_source_url, 1000) ELSE v_source.base_url END;
  v_ticket_url := CASE WHEN coalesce(_ticket_url, '') ~ '^https?://' THEN left(_ticket_url, 1000) ELSE NULL END;
  v_image_url := CASE
    WHEN coalesce(_image_url, '') ~ '^https?://' AND _image_url !~* '(transparent|placeholder|spacer)' THEN left(_image_url, 1000)
    ELSE NULL
  END;

  v_fingerprint := encode(extensions.digest(
    regexp_replace(unaccent(lower(v_title)), '[^a-z0-9]+', '', 'g') || '|' ||
    ((_starts_at AT TIME ZONE 'Europe/Zurich')::date)::text || '|' ||
    coalesce(v_city_id::text, '') || '|' || coalesce(v_venue_id::text, ''),
    'sha256'
  ), 'hex');

  SELECT e.id INTO v_event_id
  FROM public.events e
  WHERE e.canonical_fingerprint = v_fingerprint
  LIMIT 1;

  IF v_event_id IS NULL THEN
    SELECT e.id INTO v_event_id
    FROM public.events e
    JOIN public.event_occurrences o ON o.event_id = e.id
    WHERE o.starts_at BETWEEN _starts_at - interval '3 hours' AND _starts_at + interval '3 hours'
      AND (e.city_id = v_city_id OR e.city_id IS NULL OR v_city_id IS NULL)
      AND similarity(unaccent(lower(e.title)), unaccent(lower(v_title))) >= 0.86
    ORDER BY similarity(unaccent(lower(e.title)), unaccent(lower(v_title))) DESC
    LIMIT 1;
  END IF;

  v_score :=
    30 +
    15 +
    CASE WHEN length(coalesce(v_description, '')) >= 40 THEN 10 ELSE 0 END +
    CASE WHEN v_image_url IS NOT NULL THEN 10 ELSE 0 END +
    CASE WHEN v_venue_id IS NOT NULL THEN 10 ELSE 0 END +
    CASE WHEN _latitude IS NOT NULL AND _longitude IS NOT NULL THEN 10 ELSE 0 END +
    CASE WHEN v_official_url IS NOT NULL THEN 10 ELSE 0 END +
    CASE WHEN v_category_id IS NOT NULL THEN 5 ELSE 0 END;
  v_score := LEAST(v_score, 100);
  v_publish := v_source.is_authorized AND v_source.is_verified AND v_score >= 60;

  IF v_event_id IS NULL THEN
    v_slug := left(
      trim(both '-' from regexp_replace(unaccent(lower(v_title)), '[^a-z0-9]+', '-', 'g')) || '-' ||
      to_char(_starts_at AT TIME ZONE 'Europe/Zurich', 'YYYY-MM-DD') || '-' || left(v_fingerprint, 7),
      120
    );
    INSERT INTO public.events(
      slug, title, short_description, description, category_id, venue_id, city_id,
      status, publication_status, is_free, is_verified, verification_level,
      source_confidence, language, official_url, cover_image_url, is_demo,
      canonical_fingerprint, quality_score, last_seen_at, published_at
    )
    VALUES (
      v_slug, v_title, left(v_description, 280), v_description, v_category_id, v_venue_id, v_city_id,
      CASE WHEN v_publish THEN 'published'::public.event_status ELSE 'pending_review'::public.event_status END,
      CASE WHEN v_publish THEN 'published' ELSE 'draft' END,
      coalesce(_is_free, false), v_source.is_verified,
      CASE WHEN v_source.source_type IN ('official_site', 'venue_site', 'organizer_site')
        THEN 'official'::public.verification_level ELSE 'partner'::public.verification_level END,
      CASE WHEN v_source.source_type IN ('official_site', 'venue_site', 'organizer_site') THEN 90 ELSE 78 END,
      'fr', v_official_url, v_image_url, false, v_fingerprint, v_score, now(),
      CASE WHEN v_publish THEN now() ELSE NULL END
    )
    RETURNING id INTO v_event_id;
  ELSE
    v_action := 'updated';
    UPDATE public.events SET
      short_description = CASE
        WHEN length(coalesce(v_description, '')) > length(coalesce(description, '')) THEN left(v_description, 280)
        ELSE short_description
      END,
      description = CASE
        WHEN length(coalesce(v_description, '')) > length(coalesce(description, '')) THEN v_description
        ELSE description
      END,
      category_id = COALESCE(category_id, v_category_id),
      venue_id = COALESCE(venue_id, v_venue_id),
      city_id = COALESCE(city_id, v_city_id),
      official_url = COALESCE(v_official_url, official_url),
      cover_image_url = COALESCE(v_image_url, cover_image_url),
      is_free = is_free OR coalesce(_is_free, false),
      is_verified = is_verified OR v_source.is_verified,
      source_confidence = GREATEST(coalesce(source_confidence, 0), CASE WHEN v_source.source_type IN ('official_site', 'venue_site', 'organizer_site') THEN 90 ELSE 78 END),
      canonical_fingerprint = COALESCE(canonical_fingerprint, v_fingerprint),
      quality_score = GREATEST(quality_score, v_score),
      last_seen_at = now(),
      status = CASE
        WHEN status IN ('cancelled', 'postponed', 'sold_out', 'archived') THEN status
        WHEN v_publish THEN 'published'::public.event_status
        ELSE status
      END,
      publication_status = CASE WHEN v_publish THEN 'published' ELSE publication_status END,
      published_at = CASE WHEN v_publish THEN COALESCE(published_at, now()) ELSE published_at END
    WHERE id = v_event_id;
  END IF;

  INSERT INTO public.event_occurrences(
    event_id, starts_at, ends_at, timezone, local_start_date, local_end_date,
    latitude, longitude, status, ticket_status
  )
  VALUES (
    v_event_id, _starts_at, _ends_at, 'Europe/Zurich',
    (_starts_at AT TIME ZONE 'Europe/Zurich')::date,
    CASE WHEN _ends_at IS NULL THEN NULL ELSE (_ends_at AT TIME ZONE 'Europe/Zurich')::date END,
    COALESCE(_latitude, (SELECT latitude FROM public.venues WHERE id = v_venue_id)),
    COALESCE(_longitude, (SELECT longitude FROM public.venues WHERE id = v_venue_id)),
    'scheduled',
    CASE WHEN coalesce(_is_free, false) THEN 'free'::public.ticket_status ELSE 'unknown'::public.ticket_status END
  )
  ON CONFLICT (event_id, starts_at) DO UPDATE SET
    ends_at = COALESCE(EXCLUDED.ends_at, public.event_occurrences.ends_at),
    local_start_date = EXCLUDED.local_start_date,
    local_end_date = COALESCE(EXCLUDED.local_end_date, public.event_occurrences.local_end_date),
    latitude = COALESCE(EXCLUDED.latitude, public.event_occurrences.latitude),
    longitude = COALESCE(EXCLUDED.longitude, public.event_occurrences.longitude)
  RETURNING id INTO v_occurrence_id;

  IF v_ticket_url IS NOT NULL OR coalesce(_is_free, false) THEN
    UPDATE public.ticket_offers SET
      ticket_url = COALESCE(v_ticket_url, ticket_url),
      is_free = is_free OR coalesce(_is_free, false),
      status = CASE WHEN coalesce(_is_free, false) THEN 'free'::public.ticket_status ELSE status END,
      currency = 'CHF'
    WHERE id = (SELECT id FROM public.ticket_offers WHERE public.ticket_offers.event_id = v_event_id ORDER BY id LIMIT 1);
    IF NOT FOUND THEN
      INSERT INTO public.ticket_offers(event_id, name, currency, is_free, ticket_url, status)
      VALUES (
        v_event_id,
        CASE WHEN coalesce(_is_free, false) THEN 'Entrée gratuite' ELSE 'Billetterie officielle' END,
        'CHF', coalesce(_is_free, false), v_ticket_url,
        CASE WHEN coalesce(_is_free, false) THEN 'free'::public.ticket_status ELSE 'unknown'::public.ticket_status END
      );
    END IF;
  END IF;

  INSERT INTO public.source_records(
    data_source_id, source_url, external_identifier, extracted_data,
    content_hash, processing_status, processed_at
  )
  VALUES (
    v_source.id, v_official_url, _external_identifier,
    jsonb_build_object('event_id', v_event_id, 'quality_score', v_score, 'action', v_action),
    encode(extensions.digest(v_fingerprint || '|' || coalesce(_external_identifier, v_official_url), 'sha256'), 'hex'),
    'processed', now()
  );

  RETURN QUERY SELECT v_event_id, v_action, v_score, v_publish;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;

-- Backfill currently imported events so valid future events become discoverable immediately.
UPDATE public.events e
SET city_id = COALESCE(e.city_id, (SELECT id FROM public.cities WHERE slug = 'geneve')),
    category_id = COALESCE(
      e.category_id,
      (SELECT id FROM public.event_categories WHERE slug = CASE
        WHEN unaccent(lower(coalesce(e.title, '') || ' ' || coalesce(e.description, ''))) ~ '(club|soir|night|dj|electro|techno|house|disco)' THEN 'soirees'
        WHEN unaccent(lower(coalesce(e.title, '') || ' ' || coalesce(e.description, ''))) ~ '(festival|open.?air)' THEN 'festivals'
        WHEN unaccent(lower(coalesce(e.title, '') || ' ' || coalesce(e.description, ''))) ~ '(concert|musique|music|piano|orchestre|jazz|rock)' THEN 'concerts'
        WHEN unaccent(lower(coalesce(e.title, '') || ' ' || coalesce(e.description, ''))) ~ '(theatre|spectacle|comedie|danse)' THEN 'theatre'
        WHEN unaccent(lower(coalesce(e.title, '') || ' ' || coalesce(e.description, ''))) ~ '(expo|musee|vernissage|art)' THEN 'expositions'
        ELSE 'soirees'
      END)
    ),
    cover_image_url = CASE WHEN coalesce(e.cover_image_url, '') LIKE 'data:%' THEN NULL ELSE e.cover_image_url END,
    quality_score = GREATEST(e.quality_score, 65),
    last_seen_at = COALESCE(e.last_seen_at, e.updated_at),
    status = 'published',
    publication_status = 'published',
    published_at = COALESCE(e.published_at, now())
WHERE e.status = 'pending_review'
  AND e.official_url ~ '^https?://'
  AND EXISTS (
    SELECT 1 FROM public.event_occurrences o WHERE o.event_id = e.id AND o.starts_at >= now() - interval '2 hours'
  );

UPDATE public.events e
SET status = 'archived', publication_status = 'archived'
WHERE e.status = 'pending_review'
  AND NOT EXISTS (
    SELECT 1 FROM public.event_occurrences o WHERE o.event_id = e.id AND o.starts_at >= now() - interval '2 hours'
  );

-- Public discovery now supports source-level cities and coordinates, without leaking drafts.
DROP FUNCTION IF EXISTS public.discover_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT);
CREATE FUNCTION public.discover_events(
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
  event_id UUID, occurrence_id UUID, slug TEXT, title TEXT, short_description TEXT,
  cover_image_url TEXT, category_slug TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  timezone TEXT, venue_name TEXT, city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN,
  is_demo BOOLEAN, status public.event_status, distance_km NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH event_points AS (
    SELECT
      e.id AS event_id, o.id AS occurrence_id, e.slug, e.title, e.short_description,
      e.cover_image_url, c.slug AS category_slug, o.starts_at, o.ends_at, o.timezone,
      v.name AS venue_name, COALESCE(vc.name, ec.name) AS city_name,
      e.is_free, e.is_verified, e.is_demo, e.status,
      COALESCE(o.location, v.location) AS location,
      COALESCE(v.city_id, e.city_id) AS resolved_city_id
    FROM public.events e
    JOIN public.event_occurrences o ON o.event_id = e.id
    LEFT JOIN public.event_categories c ON c.id = e.category_id
    LEFT JOIN public.venues v ON v.id = e.venue_id
    LEFT JOIN public.cities vc ON vc.id = v.city_id
    LEFT JOIN public.cities ec ON ec.id = e.city_id
    WHERE e.status IN ('published','cancelled','postponed','sold_out')
      AND o.starts_at >= _from AND o.starts_at <= _to
      AND (_category_slugs IS NULL OR c.slug = ANY(_category_slugs))
      AND (_free_only = false OR e.is_free = true)
      AND (_query IS NULL OR e.search_tsv @@ plainto_tsquery('simple', unaccent(_query))
           OR e.title ILIKE '%'||_query||'%'
           OR v.name ILIKE '%'||_query||'%')
  )
  SELECT
    ep.event_id, ep.occurrence_id, ep.slug, ep.title, ep.short_description,
    ep.cover_image_url, ep.category_slug, ep.starts_at, ep.ends_at, ep.timezone,
    ep.venue_name, ep.city_name, ep.is_free, ep.is_verified, ep.is_demo, ep.status,
    CASE WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND ep.location IS NOT NULL
      THEN ROUND((ST_Distance(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography)/1000)::numeric, 2)
      ELSE NULL END AS distance_km
  FROM event_points ep
  WHERE (_city_id IS NULL OR ep.resolved_city_id = _city_id)
    AND (
      _lat IS NULL OR _lon IS NULL OR ep.location IS NULL OR
      ST_DWithin(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography, _radius_km*1000)
    )
  ORDER BY ep.starts_at ASC
  LIMIT LEAST(GREATEST(_limit, 1), 200) OFFSET GREATEST(_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.discover_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.discover_map_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT);
CREATE FUNCTION public.discover_map_events(
  _lat DOUBLE PRECISION DEFAULT NULL,
  _lon DOUBLE PRECISION DEFAULT NULL,
  _radius_km NUMERIC DEFAULT 25,
  _from TIMESTAMPTZ DEFAULT now(),
  _to TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  _category_slugs TEXT[] DEFAULT NULL,
  _city_id UUID DEFAULT NULL,
  _free_only BOOLEAN DEFAULT false,
  _query TEXT DEFAULT NULL,
  _limit INT DEFAULT 500,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  event_id UUID, occurrence_id UUID, slug TEXT, title TEXT, short_description TEXT,
  cover_image_url TEXT, category_slug TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  timezone TEXT, venue_name TEXT, city_name TEXT, is_free BOOLEAN, is_verified BOOLEAN,
  is_demo BOOLEAN, status public.event_status, distance_km NUMERIC,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH event_points AS (
    SELECT
      e.id AS event_id, o.id AS occurrence_id, e.slug, e.title, e.short_description,
      e.cover_image_url, c.slug AS category_slug, o.starts_at, o.ends_at, o.timezone,
      v.name AS venue_name, COALESCE(vc.name, ec.name) AS city_name,
      e.is_free, e.is_verified, e.is_demo, e.status,
      COALESCE(o.latitude, v.latitude) AS latitude,
      COALESCE(o.longitude, v.longitude) AS longitude,
      COALESCE(o.location, v.location) AS location,
      COALESCE(v.city_id, e.city_id) AS resolved_city_id
    FROM public.events e
    JOIN public.event_occurrences o ON o.event_id = e.id
    LEFT JOIN public.event_categories c ON c.id = e.category_id
    LEFT JOIN public.venues v ON v.id = e.venue_id
    LEFT JOIN public.cities vc ON vc.id = v.city_id
    LEFT JOIN public.cities ec ON ec.id = e.city_id
    WHERE e.status IN ('published','cancelled','postponed','sold_out')
      AND o.starts_at >= _from AND o.starts_at <= _to
      AND (_category_slugs IS NULL OR c.slug = ANY(_category_slugs))
      AND (_free_only = false OR e.is_free = true)
      AND (_query IS NULL OR e.search_tsv @@ plainto_tsquery('simple', unaccent(_query))
           OR e.title ILIKE '%'||_query||'%'
           OR v.name ILIKE '%'||_query||'%')
      AND COALESCE(o.latitude, v.latitude) IS NOT NULL
      AND COALESCE(o.longitude, v.longitude) IS NOT NULL
  )
  SELECT
    ep.event_id, ep.occurrence_id, ep.slug, ep.title, ep.short_description,
    ep.cover_image_url, ep.category_slug, ep.starts_at, ep.ends_at, ep.timezone,
    ep.venue_name, ep.city_name, ep.is_free, ep.is_verified, ep.is_demo, ep.status,
    CASE WHEN _lat IS NOT NULL AND _lon IS NOT NULL AND ep.location IS NOT NULL
      THEN ROUND((ST_Distance(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography)/1000)::numeric, 2)
      ELSE NULL END AS distance_km,
    ep.latitude, ep.longitude
  FROM event_points ep
  WHERE (_city_id IS NULL OR ep.resolved_city_id = _city_id)
    AND (
      _lat IS NULL OR _lon IS NULL OR ep.location IS NULL OR
      ST_DWithin(ep.location, ST_SetSRID(ST_MakePoint(_lon,_lat),4326)::geography, _radius_km*1000)
    )
  ORDER BY ep.starts_at ASC
  LIMIT LEAST(GREATEST(_limit, 1), 1000) OFFSET GREATEST(_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.discover_map_events(DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, BOOLEAN, TEXT, INT, INT) TO anon, authenticated;
