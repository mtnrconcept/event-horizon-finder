-- Expand the allow-listed Geneva nightlife and music catalogue.
-- Only public factual metadata is collected; each event keeps its official source URL.

INSERT INTO public.source_domains(domain, is_authorized, authorized_at, notes)
VALUES
  ('scenes-culturelles.geneve.ch', true, now(), 'Agenda officiel des scènes culturelles de la Ville de Genève.'),
  ('gtg.ch', true, now(), 'Programme officiel du Grand Théâtre de Genève.'),
  ('osr.ch', true, now(), 'Programme officiel de l’Orchestre de la Suisse Romande.'),
  ('amr-geneve.ch', true, now(), 'Programme officiel de l’AMR Genève.'),
  ('cave12.org', true, now(), 'Programme officiel de la Cave12.'),
  ('lagraviere.ch', true, now(), 'Programme officiel de La Gravière.'),
  ('motelcampo.ch', true, now(), 'Programme officiel de Motel Campo.'),
  ('legroove.ch', true, now(), 'Programme officiel du Groove.'),
  ('undertown.ch', true, now(), 'Programme officiel d’Undertown.'),
  ('rez-usine.ch', true, now(), 'Programme officiel du Rez de l’Usine.'),
  ('kzern.ch', true, now(), 'Programme officiel de KZERN.'),
  ('locg.ch', true, now(), 'Programme officiel de l’Orchestre de Chambre de Genève.'),
  ('hesge.ch', true, now(), 'Agenda officiel de la Haute école de musique de Genève.'),
  ('adem.ch', true, now(), 'Agenda officiel des Ateliers d’ethnomusicologie.'),
  ('contrechamps.ch', true, now(), 'Programme officiel de l’Ensemble Contrechamps.'),
  ('archipel.org', true, now(), 'Programme officiel du Festival Archipel.'),
  ('batie.ch', true, now(), 'Programme officiel de La Bâtie — Festival de Genève.'),
  ('electronfestival.ch', true, now(), 'Programme officiel d’Electron Festival.'),
  ('mappingfestival.com', true, now(), 'Programme officiel du Mapping Festival.'),
  ('fetedelamusique.ch', true, now(), 'Programme officiel de la Fête de la musique de Genève.'),
  ('pleinleswatts.ch', true, now(), 'Programme officiel de Plein-les-Watts Festival.'),
  ('aubesmusicales.ch', true, now(), 'Programme officiel des Aubes musicales.'),
  ('lescreatives.ch', true, now(), 'Programme officiel du festival Les Créatives.'),
  ('puplinge-classique.ch', true, now(), 'Programme officiel de Puplinge Classique.'),
  ('jazzcontreband.com', true, now(), 'Programme officiel de JazzContreBand.'),
  ('voixdefete.com', true, now(), 'Programme officiel du festival Voix de Fête.'),
  ('lakeparade.ch', true, now(), 'Programme officiel de la Lake Parade.'),
  ('theatreduleman.com', true, now(), 'Programme officiel du Théâtre du Léman.'),
  ('epicentre.ch', true, now(), 'Programme officiel de l’Epicentre.'),
  ('genevacamerata.com', true, now(), 'Programme officiel de la Geneva Camerata.')
ON CONFLICT (domain) DO UPDATE SET
  is_authorized = EXCLUDED.is_authorized,
  authorized_at = COALESCE(public.source_domains.authorized_at, EXCLUDED.authorized_at),
  notes = EXCLUDED.notes;

WITH geneva AS (
  SELECT id FROM public.cities WHERE slug = 'geneve' LIMIT 1
), sources(name, source_type, base_url, domain, category_slug, page_count, priority, sync_frequency, legal_basis, metadata) AS (
  VALUES
    ('Scènes culturelles de Genève', 'official_site', 'https://scenes-culturelles.geneve.ch/agenda/', 'scenes-culturelles.geneve.ch', 'concerts', 8, 14, 'daily', 'Agenda culturel municipal officiel; métadonnées factuelles et liens sources uniquement.', '{"pagination":"page"}'::jsonb),
    ('La Gravière', 'venue_site', 'https://www.lagraviere.ch/agenda/', 'lagraviere.ch', 'soirees', 2, 16, 'daily', 'Programme public officiel du club.', '{"pagination":"page"}'::jsonb),
    ('Motel Campo', 'venue_site', 'https://motelcampo.ch/agenda/', 'motelcampo.ch', 'soirees', 1, 17, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Le Groove', 'venue_site', 'https://legroove.ch/agenda/', 'legroove.ch', 'concerts', 1, 19, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('KZERN', 'venue_site', 'https://www.kzern.ch/agenda/', 'kzern.ch', 'soirees', 1, 21, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Rez de l’Usine', 'venue_site', 'https://rez-usine.ch/agenda/', 'rez-usine.ch', 'concerts', 1, 22, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Cave12', 'venue_site', 'https://www.cave12.org/agenda/', 'cave12.org', 'concerts', 1, 23, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('AMR Genève', 'venue_site', 'https://www.amr-geneve.ch/agenda/', 'amr-geneve.ch', 'concerts', 2, 24, 'daily', 'Programme public officiel du lieu.', '{"pagination":"page"}'::jsonb),
    ('Undertown', 'venue_site', 'https://undertown.ch/agenda/', 'undertown.ch', 'concerts', 1, 27, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Grand Théâtre de Genève', 'venue_site', 'https://www.gtg.ch/agenda/', 'gtg.ch', 'concerts', 1, 31, 'daily', 'Programme public officiel du Grand Théâtre.', '{}'::jsonb),
    ('Orchestre de la Suisse Romande', 'organizer_site', 'https://www.osr.ch/fr/concerts-billetterie', 'osr.ch', 'concerts', 2, 32, 'daily', 'Programme public officiel de l’orchestre.', '{"pagination":"page"}'::jsonb),
    ('Orchestre de Chambre de Genève', 'organizer_site', 'https://www.locg.ch/agenda/', 'locg.ch', 'concerts', 1, 33, 'daily', 'Programme public officiel de l’orchestre.', '{}'::jsonb),
    ('Haute école de musique de Genève', 'official_site', 'https://www.hesge.ch/hem/agenda', 'hesge.ch', 'concerts', 3, 34, 'daily', 'Agenda public officiel de l’école.', '{"pagination":"page"}'::jsonb),
    ('Ateliers d’ethnomusicologie', 'organizer_site', 'https://adem.ch/agenda/', 'adem.ch', 'concerts', 1, 35, 'daily', 'Programme public officiel de l’association.', '{}'::jsonb),
    ('Ensemble Contrechamps', 'organizer_site', 'https://contrechamps.ch/agenda/', 'contrechamps.ch', 'concerts', 1, 36, 'daily', 'Programme public officiel de l’ensemble.', '{}'::jsonb),
    ('Théâtre du Léman', 'venue_site', 'https://www.theatreduleman.com/evenements/', 'theatreduleman.com', 'concerts', 1, 37, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Epicentre', 'venue_site', 'https://epicentre.ch/agenda/', 'epicentre.ch', 'concerts', 1, 38, 'daily', 'Programme public officiel du lieu.', '{}'::jsonb),
    ('Geneva Camerata', 'organizer_site', 'https://www.genevacamerata.com/concerts', 'genevacamerata.com', 'concerts', 1, 39, 'daily', 'Programme public officiel de l’ensemble.', '{}'::jsonb),
    ('Festival Archipel', 'organizer_site', 'https://archipel.org/agenda/', 'archipel.org', 'festivals', 1, 42, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('La Bâtie — Festival de Genève', 'organizer_site', 'https://www.batie.ch/programme/', 'batie.ch', 'festivals', 1, 43, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Electron Festival', 'organizer_site', 'https://electronfestival.ch/programme/', 'electronfestival.ch', 'festivals', 1, 44, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Mapping Festival', 'organizer_site', 'https://mappingfestival.com/programme/', 'mappingfestival.com', 'festivals', 1, 45, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Fête de la musique Genève', 'official_site', 'https://www.fetedelamusique.ch/programme/', 'fetedelamusique.ch', 'festivals', 1, 46, 'weekly', 'Programme public officiel de la manifestation.', '{}'::jsonb),
    ('Musiques en été', 'official_site', 'https://www.geneve.ch/themes/culture/musique/musiques-ete', 'geneve.ch', 'festivals', 1, 47, 'weekly', 'Programme culturel municipal officiel.', '{}'::jsonb),
    ('Plein-les-Watts Festival', 'organizer_site', 'https://pleinleswatts.ch/programmation/', 'pleinleswatts.ch', 'festivals', 1, 48, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Aubes musicales', 'organizer_site', 'https://aubesmusicales.ch/programme/', 'aubesmusicales.ch', 'festivals', 1, 49, 'weekly', 'Programme public officiel de la manifestation.', '{}'::jsonb),
    ('Festival Les Créatives', 'organizer_site', 'https://lescreatives.ch/programme/', 'lescreatives.ch', 'festivals', 1, 51, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Puplinge Classique', 'organizer_site', 'https://puplinge-classique.ch/programme/', 'puplinge-classique.ch', 'festivals', 1, 52, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('JazzContreBand', 'organizer_site', 'https://www.jazzcontreband.com/agenda/', 'jazzcontreband.com', 'festivals', 1, 53, 'weekly', 'Programme public officiel du festival transfrontalier.', '{}'::jsonb),
    ('Voix de Fête', 'organizer_site', 'https://www.voixdefete.com/programmation/', 'voixdefete.com', 'festivals', 1, 54, 'weekly', 'Programme public officiel du festival.', '{}'::jsonb),
    ('Lake Parade', 'organizer_site', 'https://www.lakeparade.ch/programme/', 'lakeparade.ch', 'festivals', 1, 55, 'weekly', 'Programme public officiel de la manifestation.', '{}'::jsonb)
)
INSERT INTO public.data_sources(
  name, source_type, base_url, domain, city_id, category_slug, page_count, priority,
  sync_frequency, is_authorized, is_verified, status, legal_basis, metadata, next_sync_at
)
SELECT
  s.name,
  s.source_type::public.data_source_type,
  s.base_url,
  s.domain,
  g.id,
  s.category_slug,
  s.page_count,
  s.priority,
  s.sync_frequency,
  true,
  true,
  'active',
  s.legal_basis,
  s.metadata,
  NULL
FROM sources s
CROSS JOIN geneva g
WHERE NOT EXISTS (
  SELECT 1 FROM public.data_sources existing WHERE existing.name = s.name
);

-- More catalogue pages are available than the initial bootstrap processed.
UPDATE public.data_sources
SET page_count = CASE name
    WHEN 'Genève — clubbing' THEN 12
    WHEN 'Genève — concerts' THEN 20
    WHEN 'Genève — festivals' THEN 12
    ELSE page_count
  END,
  next_sync_at = NULL
WHERE name IN ('Genève — clubbing', 'Genève — concerts', 'Genève — festivals');
