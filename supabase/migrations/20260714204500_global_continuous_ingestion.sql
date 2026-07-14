-- International starter registry for the resumable event collector.
-- Only public factual metadata from official destination/city calendars is ingested.

INSERT INTO public.countries(code, name)
VALUES
  ('GB', 'Royaume-Uni'),
  ('DE', 'Allemagne'),
  ('NL', 'Pays-Bas'),
  ('PT', 'Portugal'),
  ('US', 'États-Unis'),
  ('CA', 'Canada'),
  ('AU', 'Australie')
ON CONFLICT (code) DO UPDATE SET name = excluded.name;

WITH city_values(country_code, slug, name, timezone, latitude, longitude) AS (
  VALUES
    ('GB', 'london', 'Londres', 'Europe/London', 51.5074::DOUBLE PRECISION, -0.1278::DOUBLE PRECISION),
    ('DE', 'berlin', 'Berlin', 'Europe/Berlin', 52.5200::DOUBLE PRECISION, 13.4050::DOUBLE PRECISION),
    ('NL', 'amsterdam', 'Amsterdam', 'Europe/Amsterdam', 52.3676::DOUBLE PRECISION, 4.9041::DOUBLE PRECISION),
    ('PT', 'lisbon', 'Lisbonne', 'Europe/Lisbon', 38.7223::DOUBLE PRECISION, -9.1393::DOUBLE PRECISION),
    ('US', 'new-york', 'New York', 'America/New_York', 40.7128::DOUBLE PRECISION, -74.0060::DOUBLE PRECISION),
    ('CA', 'montreal', 'Montréal', 'America/Toronto', 45.5019::DOUBLE PRECISION, -73.5674::DOUBLE PRECISION),
    ('CA', 'toronto', 'Toronto', 'America/Toronto', 43.6532::DOUBLE PRECISION, -79.3832::DOUBLE PRECISION),
    ('AU', 'sydney', 'Sydney', 'Australia/Sydney', -33.8688::DOUBLE PRECISION, 151.2093::DOUBLE PRECISION)
)
INSERT INTO public.cities(country_id, slug, name, timezone, latitude, longitude, is_demo)
SELECT country.id, value.slug, value.name, value.timezone, value.latitude, value.longitude, false
FROM city_values AS value
JOIN public.countries AS country ON country.code = value.country_code
ON CONFLICT (slug) DO UPDATE SET
  country_id = excluded.country_id,
  name = excluded.name,
  timezone = excluded.timezone,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  is_demo = false;

INSERT INTO public.source_domains(domain, is_authorized, authorized_at, notes)
VALUES
  ('visitlondon.com', true, now(), 'Guide officiel de Londres; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('visitberlin.de', true, now(), 'Site touristique officiel de Berlin; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('iamsterdam.com', true, now(), 'Guide officiel d’Amsterdam; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('visitlisboa.com', true, now(), 'Guide officiel de Lisbonne; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('nyctourism.com', true, now(), 'Organisation touristique officielle de New York; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('mtl.org', true, now(), 'Tourisme Montréal; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('destinationtoronto.com', true, now(), 'Destination Toronto; calendrier public, métadonnées factuelles et liens sources uniquement.'),
  ('whatson.cityofsydney.nsw.gov.au', true, now(), 'Agenda public officiel de la Ville de Sydney; métadonnées factuelles et liens sources uniquement.')
ON CONFLICT (domain) DO UPDATE SET
  is_authorized = excluded.is_authorized,
  authorized_at = coalesce(public.source_domains.authorized_at, excluded.authorized_at),
  notes = excluded.notes;

WITH source_values(name, base_url, domain, city_slug, priority, legal_basis) AS (
  VALUES
    ('Londres — agenda officiel', 'https://www.visitlondon.com/things-to-do/whats-on', 'visitlondon.com', 'london', 110, 'Guide officiel soutenu par la mairie; faits, dates et liens uniquement.'),
    ('Berlin — agenda officiel', 'https://www.visitberlin.de/en/events-berlin', 'visitberlin.de', 'berlin', 110, 'Site touristique officiel; faits, dates et liens uniquement.'),
    ('Amsterdam — agenda officiel', 'https://www.iamsterdam.com/en/whats-on/calendar', 'iamsterdam.com', 'amsterdam', 110, 'Guide officiel de la ville; faits, dates et liens uniquement.'),
    ('Lisbonne — agenda officiel', 'https://www.visitlisboa.com/en/events', 'visitlisboa.com', 'lisbon', 120, 'Guide touristique officiel; faits, dates et liens uniquement.'),
    ('New York — agenda officiel', 'https://www.nyctourism.com/events/', 'nyctourism.com', 'new-york', 120, 'Organisation touristique officielle; faits, dates et liens uniquement.'),
    ('Montréal — festivals et événements', 'https://www.mtl.org/en/what-to-do/festivals-and-events', 'mtl.org', 'montreal', 115, 'Tourisme Montréal; faits, dates et liens uniquement.'),
    ('Toronto — agenda officiel', 'https://www.destinationtoronto.com/events/', 'destinationtoronto.com', 'toronto', 120, 'Destination Toronto; faits, dates et liens uniquement.'),
    ('Sydney — agenda municipal', 'https://whatson.cityofsydney.nsw.gov.au/', 'whatson.cityofsydney.nsw.gov.au', 'sydney', 115, 'Agenda public de la Ville de Sydney; faits, dates et liens uniquement.')
)
INSERT INTO public.data_sources(
  name,
  source_type,
  base_url,
  domain,
  city_id,
  category_slug,
  page_count,
  priority,
  sync_frequency,
  is_authorized,
  is_verified,
  status,
  legal_basis,
  metadata,
  next_sync_at
)
SELECT
  value.name,
  'official_site'::public.data_source_type,
  value.base_url,
  value.domain,
  city.id,
  NULL,
  1,
  value.priority,
  'daily',
  true,
  true,
  'active',
  value.legal_basis,
  jsonb_build_object('scope', 'global-starter', 'locale', 'auto'),
  NULL
FROM source_values AS value
JOIN public.cities AS city ON city.slug = value.city_slug
WHERE NOT EXISTS (
  SELECT 1 FROM public.data_sources AS existing WHERE existing.name = value.name
);

CREATE INDEX IF NOT EXISTS data_sources_due_idx
  ON public.data_sources(next_sync_at, priority)
  WHERE status = 'active' AND is_authorized = true AND is_verified = true;
