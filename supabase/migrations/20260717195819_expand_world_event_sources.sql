-- Expand the continuous collector with public, official city/destination
-- calendars. The registry is idempotent and reuses matching imported cities
-- instead of creating duplicate geography rows.

INSERT INTO public.event_categories(slug, name_fr, name_en, icon, sort_order)
VALUES
  ('concerts', 'Concerts', 'Concerts', '🎸', 10),
  ('festivals', 'Festivals', 'Festivals', '🎪', 20),
  ('expositions', 'Expositions', 'Exhibitions', '🖼️', 30),
  ('soirees', 'Soirées', 'Nightlife', '🌙', 40),
  ('theatre', 'Théâtre', 'Theatre', '🎭', 50),
  ('famille', 'Famille', 'Family', '👪', 60),
  ('sports-outdoor', 'Sport & plein air', 'Sports & outdoors', '🏃', 70),
  ('heritage', 'Visites & patrimoine', 'Tours & heritage', '🏛️', 80),
  ('gastronomy', 'Gastronomie & marchés', 'Food & markets', '🍴', 90),
  ('activities', 'Ateliers & activités', 'Workshops & activities', '🛠️', 100),
  ('conferences', 'Conférences & rencontres', 'Talks & meetups', '🎤', 110),
  ('cinema', 'Cinéma & projections', 'Cinema & screenings', '🎬', 120),
  ('leisure', 'Jeux & loisirs', 'Games & leisure', '🎯', 130),
  ('other', 'Autres événements', 'Other events', '✨', 140)
ON CONFLICT (slug) DO UPDATE SET
  name_fr = excluded.name_fr,
  name_en = excluded.name_en,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

DO $$
DECLARE
  city_source RECORD;
  resolved_country_id UUID;
  resolved_city_id UUID;
  resolved_source_id UUID;
BEGIN
  FOR city_source IN
    SELECT *
    FROM (VALUES
      ('CH', 'Suisse', 'zurich-ch', 'Zürich', ARRAY['Zürich','Zurich']::TEXT[], 'Europe/Zurich', 47.3769::DOUBLE PRECISION, 8.5417::DOUBLE PRECISION, 'Zürich — agenda officiel', 'https://www.myswitzerland.com/en/experiences/events/events-search/-/zurich/', 'myswitzerland.com', 70),
      ('CH', 'Suisse', 'basel-ch', 'Bâle', ARRAY['Bâle','Basel','Basle']::TEXT[], 'Europe/Zurich', 47.5596::DOUBLE PRECISION, 7.5886::DOUBLE PRECISION, 'Bâle — agenda officiel', 'https://www.basel.com/en/events', 'basel.com', 70),
      ('FR', 'France', 'paris-fr', 'Paris', ARRAY['Paris']::TEXT[], 'Europe/Paris', 48.8566::DOUBLE PRECISION, 2.3522::DOUBLE PRECISION, 'Paris — agenda municipal', 'https://www.paris.fr/evenements', 'paris.fr', 70),
      ('ES', 'Espagne', 'madrid-es', 'Madrid', ARRAY['Madrid']::TEXT[], 'Europe/Madrid', 40.4168::DOUBLE PRECISION, -3.7038::DOUBLE PRECISION, 'Madrid — agenda officiel', 'https://www.esmadrid.com/en/events-calendar', 'esmadrid.com', 70),
      ('ES', 'Espagne', 'barcelona-es', 'Barcelona', ARRAY['Barcelona','Barcelone']::TEXT[], 'Europe/Madrid', 41.3874::DOUBLE PRECISION, 2.1686::DOUBLE PRECISION, 'Barcelona — agenda municipal', 'https://agenda500.barcelona.cat/en', 'agenda500.barcelona.cat', 70),
      ('IT', 'Italie', 'rome-it', 'Rome', ARRAY['Rome','Roma']::TEXT[], 'Europe/Rome', 41.9028::DOUBLE PRECISION, 12.4964::DOUBLE PRECISION, 'Rome — agenda officiel', 'https://www.turismoroma.it/en/tipo-evento/events', 'turismoroma.it', 70),
      ('IT', 'Italie', 'milan-it', 'Milan', ARRAY['Milan','Milano']::TEXT[], 'Europe/Rome', 45.4642::DOUBLE PRECISION, 9.1900::DOUBLE PRECISION, 'Milan — agenda officiel', 'https://www.yesmilano.it/en/whats-on/all-events', 'yesmilano.it', 70),
      ('AT', 'Autriche', 'vienna-at', 'Vienne', ARRAY['Vienne','Vienna','Wien']::TEXT[], 'Europe/Vienna', 48.2082::DOUBLE PRECISION, 16.3738::DOUBLE PRECISION, 'Vienne — agenda officiel', 'https://www.wien.info/en/now-on/event-search', 'wien.info', 70),
      ('CZ', 'Tchéquie', 'prague-cz', 'Prague', ARRAY['Prague','Praha']::TEXT[], 'Europe/Prague', 50.0755::DOUBLE PRECISION, 14.4378::DOUBLE PRECISION, 'Prague — agenda officiel', 'https://prague.eu/en/akce-kategorie/events/', 'prague.eu', 70),
      ('PL', 'Pologne', 'warsaw-pl', 'Varsovie', ARRAY['Varsovie','Warsaw','Warszawa']::TEXT[], 'Europe/Warsaw', 52.2297::DOUBLE PRECISION, 21.0122::DOUBLE PRECISION, 'Varsovie — agenda officiel', 'https://go2warsaw.pl/en/', 'go2warsaw.pl', 85),
      ('BE', 'Belgique', 'brussels-be', 'Bruxelles', ARRAY['Bruxelles','Brussels','Brussel']::TEXT[], 'Europe/Brussels', 50.8503::DOUBLE PRECISION, 4.3517::DOUBLE PRECISION, 'Bruxelles — agenda officiel', 'https://www.visit.brussels/en/visitors/agenda', 'visit.brussels', 70),
      ('DK', 'Danemark', 'copenhagen-dk', 'Copenhague', ARRAY['Copenhague','Copenhagen','København']::TEXT[], 'Europe/Copenhagen', 55.6761::DOUBLE PRECISION, 12.5683::DOUBLE PRECISION, 'Copenhague — agenda officiel', 'https://www.visitcopenhagen.com/explore/events-cid58/events-cid59', 'visitcopenhagen.com', 85),
      ('SE', 'Suède', 'stockholm-se', 'Stockholm', ARRAY['Stockholm']::TEXT[], 'Europe/Stockholm', 59.3293::DOUBLE PRECISION, 18.0686::DOUBLE PRECISION, 'Stockholm — agenda officiel', 'https://www.visitstockholm.com/events/', 'visitstockholm.com', 70),
      ('NO', 'Norvège', 'oslo-no', 'Oslo', ARRAY['Oslo']::TEXT[], 'Europe/Oslo', 59.9139::DOUBLE PRECISION, 10.7522::DOUBLE PRECISION, 'Oslo — agenda officiel', 'https://www.visitoslo.com/en/whats-on/events/', 'visitoslo.com', 70),
      ('IE', 'Irlande', 'dublin-ie', 'Dublin', ARRAY['Dublin']::TEXT[], 'Europe/Dublin', 53.3498::DOUBLE PRECISION, -6.2603::DOUBLE PRECISION, 'Dublin — agenda officiel', 'https://www.visitdublin.com/events', 'visitdublin.com', 70),
      ('US', 'États-Unis', 'los-angeles-us', 'Los Angeles', ARRAY['Los Angeles']::TEXT[], 'America/Los_Angeles', 34.0522::DOUBLE PRECISION, -118.2437::DOUBLE PRECISION, 'Los Angeles — agenda officiel', 'https://www.discoverlosangeles.com/events', 'discoverlosangeles.com', 70),
      ('US', 'États-Unis', 'san-francisco-us', 'San Francisco', ARRAY['San Francisco']::TEXT[], 'America/Los_Angeles', 37.7749::DOUBLE PRECISION, -122.4194::DOUBLE PRECISION, 'San Francisco — agenda municipal', 'https://www.sf.gov/events/upcoming', 'sf.gov', 70),
      ('US', 'États-Unis', 'chicago-us', 'Chicago', ARRAY['Chicago']::TEXT[], 'America/Chicago', 41.8781::DOUBLE PRECISION, -87.6298::DOUBLE PRECISION, 'Chicago — agenda officiel', 'https://www.choosechicago.com/events/', 'choosechicago.com', 70),
      ('US', 'États-Unis', 'miami-us', 'Miami', ARRAY['Miami']::TEXT[], 'America/New_York', 25.7617::DOUBLE PRECISION, -80.1918::DOUBLE PRECISION, 'Miami — agenda officiel', 'https://www.miamiandbeaches.com/events', 'miamiandbeaches.com', 70),
      ('CA', 'Canada', 'vancouver-ca', 'Vancouver', ARRAY['Vancouver']::TEXT[], 'America/Vancouver', 49.2827::DOUBLE PRECISION, -123.1207::DOUBLE PRECISION, 'Vancouver — agenda officiel', 'https://www.destinationvancouver.com/events/events-calendar', 'destinationvancouver.com', 70),
      ('MX', 'Mexique', 'mexico-city-mx', 'Mexico', ARRAY['Mexico','Mexico City','Ciudad de México','Ciudad de Mexico']::TEXT[], 'America/Mexico_City', 19.4326::DOUBLE PRECISION, -99.1332::DOUBLE PRECISION, 'Mexico — agenda culturel public', 'https://cartelera.cdmx.gob.mx/', 'cartelera.cdmx.gob.mx', 70),
      ('JP', 'Japon', 'tokyo-jp', 'Tokyo', ARRAY['Tokyo','Tōkyō']::TEXT[], 'Asia/Tokyo', 35.6762::DOUBLE PRECISION, 139.6503::DOUBLE PRECISION, 'Tokyo — agenda officiel', 'https://www.gotokyo.org/en/calendar/index.html', 'gotokyo.org', 70),
      ('KR', 'Corée du Sud', 'seoul-kr', 'Séoul', ARRAY['Séoul','Seoul','Seoul-si']::TEXT[], 'Asia/Seoul', 37.5665::DOUBLE PRECISION, 126.9780::DOUBLE PRECISION, 'Séoul — agenda métropolitain', 'https://english.seoul.go.kr/category/service/amusement/cultural-event/', 'english.seoul.go.kr', 70),
      ('SG', 'Singapour', 'singapore-sg', 'Singapour', ARRAY['Singapour','Singapore']::TEXT[], 'Asia/Singapore', 1.3521::DOUBLE PRECISION, 103.8198::DOUBLE PRECISION, 'Singapour — agenda officiel', 'https://www.visitsingapore.com/whats-happening/all-happenings/', 'visitsingapore.com', 70),
      ('AE', 'Émirats arabes unis', 'dubai-ae', 'Dubaï', ARRAY['Dubaï','Dubai']::TEXT[], 'Asia/Dubai', 25.2048::DOUBLE PRECISION, 55.2708::DOUBLE PRECISION, 'Dubaï — agenda officiel', 'https://www.visitdubai.com/en/festivals-and-events/dubai-events-calendar', 'visitdubai.com', 70),
      ('AE', 'Émirats arabes unis', 'abu-dhabi-ae', 'Abou Dabi', ARRAY['Abou Dabi','Abu Dhabi']::TEXT[], 'Asia/Dubai', 24.4539::DOUBLE PRECISION, 54.3773::DOUBLE PRECISION, 'Abou Dabi — agenda officiel', 'https://visitabudhabi.ae/en/events', 'visitabudhabi.ae', 85),
      ('AU', 'Australie', 'melbourne-au', 'Melbourne', ARRAY['Melbourne']::TEXT[], 'Australia/Melbourne', -37.8136::DOUBLE PRECISION, 144.9631::DOUBLE PRECISION, 'Melbourne — agenda municipal', 'https://whatson.melbourne.vic.gov.au/', 'whatson.melbourne.vic.gov.au', 70),
      ('NZ', 'Nouvelle-Zélande', 'auckland-nz', 'Auckland', ARRAY['Auckland']::TEXT[], 'Pacific/Auckland', -36.8509::DOUBLE PRECISION, 174.7645::DOUBLE PRECISION, 'Auckland — agenda municipal', 'https://ourauckland.aucklandcouncil.govt.nz/events/', 'ourauckland.aucklandcouncil.govt.nz', 70),
      ('ZA', 'Afrique du Sud', 'cape-town-za', 'Le Cap', ARRAY['Le Cap','Cape Town']::TEXT[], 'Africa/Johannesburg', -33.9249::DOUBLE PRECISION, 18.4241::DOUBLE PRECISION, 'Le Cap — agenda officiel', 'https://www.capetown.travel/events/', 'capetown.travel', 70),
      ('MA', 'Maroc', 'marrakech-ma', 'Marrakech', ARRAY['Marrakech','Marrakesh']::TEXT[], 'Africa/Casablanca', 31.6295::DOUBLE PRECISION, -7.9811::DOUBLE PRECISION, 'Marrakech — agenda officiel', 'https://visitmarrakech.com/en/events/', 'visitmarrakech.com', 85)
    ) AS registry(
      country_code, country_name, city_slug, city_name, city_aliases,
      timezone_name, latitude, longitude, source_name, base_url, domain, priority
    )
  LOOP
    INSERT INTO public.countries(code, name)
    VALUES (city_source.country_code, city_source.country_name)
    ON CONFLICT (code) DO UPDATE SET name = excluded.name
    RETURNING id INTO resolved_country_id;

    SELECT city.id
    INTO resolved_city_id
    FROM public.cities AS city
    WHERE city.country_id = resolved_country_id
      AND (
        city.slug = city_source.city_slug
        OR EXISTS (
          SELECT 1
          FROM unnest(city_source.city_aliases) AS alias(name)
          WHERE public.unaccent(lower(city.name)) = public.unaccent(lower(alias.name))
        )
      )
    ORDER BY (city.slug = city_source.city_slug) DESC, city.created_at
    LIMIT 1;

    IF resolved_city_id IS NULL THEN
      INSERT INTO public.cities(
        country_id, slug, name, timezone, latitude, longitude, is_demo
      ) VALUES (
        resolved_country_id, city_source.city_slug, city_source.city_name,
        city_source.timezone_name, city_source.latitude, city_source.longitude, false
      )
      RETURNING id INTO resolved_city_id;
    ELSE
      UPDATE public.cities
      SET timezone = city_source.timezone_name,
          latitude = city_source.latitude,
          longitude = city_source.longitude,
          is_demo = false
      WHERE id = resolved_city_id;
    END IF;

    INSERT INTO public.source_domains(domain, is_authorized, authorized_at, notes)
    VALUES (
      city_source.domain,
      true,
      now(),
      'Agenda public officiel vérifié le 2026-07-17; ingestion limitée aux métadonnées factuelles et aux liens sources.'
    )
    ON CONFLICT (domain) DO UPDATE SET
      is_authorized = true,
      authorized_at = coalesce(public.source_domains.authorized_at, excluded.authorized_at),
      notes = excluded.notes;

    SELECT source.id
    INTO resolved_source_id
    FROM public.data_sources AS source
    WHERE source.name = city_source.source_name
    ORDER BY source.created_at
    LIMIT 1;

    IF resolved_source_id IS NULL THEN
      INSERT INTO public.data_sources(
        name, source_type, base_url, domain, city_id, category_slug,
        page_count, priority, sync_frequency, is_authorized, is_verified,
        status, legal_basis, metadata, next_sync_at
      ) VALUES (
        city_source.source_name,
        'official_site'::public.data_source_type,
        city_source.base_url,
        city_source.domain,
        resolved_city_id,
        NULL,
        1,
        city_source.priority,
        'daily',
        true,
        true,
        'active',
        'Agenda public officiel de ville ou de destination; métadonnées factuelles, dates et liens vers la source uniquement.',
        jsonb_build_object(
          'scope', 'world-expansion-2026-07',
          'locale', 'auto',
          'direct_detail_limit', 3,
          'firecrawl_attempts', 1,
          'firecrawl_timeout_ms', 70000,
          'city_aliases', city_source.city_aliases,
          'registry_key', city_source.city_slug
        ),
        NULL
      );
    ELSE
      UPDATE public.data_sources
      SET source_type = 'official_site'::public.data_source_type,
          base_url = city_source.base_url,
          domain = city_source.domain,
          city_id = resolved_city_id,
          page_count = 1,
          priority = city_source.priority,
          sync_frequency = 'daily',
          is_authorized = true,
          is_verified = true,
          status = 'active',
          legal_basis = 'Agenda public officiel de ville ou de destination; métadonnées factuelles, dates et liens vers la source uniquement.',
          metadata = coalesce(public.data_sources.metadata, '{}'::JSONB) || jsonb_build_object(
            'scope', 'world-expansion-2026-07',
            'locale', 'auto',
            'direct_detail_limit', 3,
            'firecrawl_attempts', 1,
            'firecrawl_timeout_ms', 70000,
            'city_aliases', city_source.city_aliases,
            'registry_key', city_source.city_slug
          ),
          next_sync_at = NULL
      WHERE id = resolved_source_id;
    END IF;
  END LOOP;
END
$$;

-- Keep the protected rich-ingestion entrypoint country-aware for currencies
-- as well as coordinates. This prevents non-EUR expansion cities from
-- inheriting the historical EUR fallback when a source omits its currency.
CREATE OR REPLACE FUNCTION public.upsert_ingested_event_v2(
  _data_source_id UUID,
  _payload JSONB
)
RETURNS TABLE(event_id UUID, action TEXT, score INT, published BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payload JSONB := _payload;
  v_country_code TEXT := upper(nullif(btrim(_payload->>'country_code'), ''));
  v_currency TEXT;
  v_source_latitude DOUBLE PRECISION;
  v_source_longitude DOUBLE PRECISION;
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
BEGIN
  IF v_country_code IS NULL OR v_country_code !~ '^[A-Z]{2}$' THEN
    SELECT upper(country.code)
      INTO v_country_code
    FROM public.data_sources AS source
    LEFT JOIN public.cities AS city ON city.id = source.city_id
    LEFT JOIN public.countries AS country ON country.id = city.country_id
    WHERE source.id = _data_source_id;
  END IF;

  IF coalesce(upper(btrim(_payload->>'currency')), '') !~ '^[A-Z]{3}$'
    AND v_country_code ~ '^[A-Z]{2}$'
  THEN
    v_currency := CASE v_country_code
      WHEN 'CH' THEN 'CHF' WHEN 'GB' THEN 'GBP' WHEN 'US' THEN 'USD'
      WHEN 'CA' THEN 'CAD' WHEN 'AU' THEN 'AUD' WHEN 'NZ' THEN 'NZD'
      WHEN 'JP' THEN 'JPY' WHEN 'PL' THEN 'PLN' WHEN 'CZ' THEN 'CZK'
      WHEN 'HU' THEN 'HUF' WHEN 'SE' THEN 'SEK' WHEN 'NO' THEN 'NOK'
      WHEN 'DK' THEN 'DKK' WHEN 'MX' THEN 'MXN' WHEN 'KR' THEN 'KRW'
      WHEN 'SG' THEN 'SGD' WHEN 'AE' THEN 'AED' WHEN 'ZA' THEN 'ZAR'
      WHEN 'MA' THEN 'MAD' ELSE 'EUR'
    END;
    v_payload := jsonb_set(v_payload, '{currency}', to_jsonb(v_currency), true);
  END IF;

  BEGIN
    v_source_latitude := (_payload->>'latitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_latitude := NULL;
  END;
  BEGIN
    v_source_longitude := (_payload->>'longitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_longitude := NULL;
  END;

  SELECT normalized.latitude, normalized.longitude
    INTO v_latitude, v_longitude
  FROM private.normalize_coordinate_pair(
    v_country_code,
    v_source_latitude,
    v_source_longitude
  ) AS normalized;

  v_payload := jsonb_set(
    jsonb_set(
      v_payload,
      '{latitude}',
      coalesce(to_jsonb(v_latitude), 'null'::JSONB),
      true
    ),
    '{longitude}',
    coalesce(to_jsonb(v_longitude), 'null'::JSONB),
    true
  );

  RETURN QUERY
  SELECT result.event_id, result.action, result.score, result.published
  FROM public.upsert_ingested_event_v2_catalog_core(_data_source_id, v_payload) AS result;
END
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2_catalog_core(UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) IS
  'Normalizes country-aware coordinates and currencies before atomically writing a rich scraper payload.';

-- The legacy ingestion function recognizes six historic categories. The rich
-- v2 payload is attached to source_records immediately afterwards, so this
-- trigger applies the complete taxonomy atomically without duplicating the
-- large ingestion function or losing direct-collector compatibility.
CREATE OR REPLACE FUNCTION public.sync_ingested_event_category_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_id_text TEXT := NEW.extracted_data->>'event_id';
  supplied_category TEXT := public.unaccent(lower(trim(coalesce(
    NEW.extracted_data#>>'{normalized_payload,category}',
    ''
  ))));
  classification_text TEXT := public.unaccent(lower(concat_ws(
    ' ',
    supplied_category,
    NEW.extracted_data#>>'{normalized_payload,title}',
    NEW.extracted_data#>>'{normalized_payload,description}'
  )));
  resolved_slug TEXT;
  resolved_category_id UUID;
  other_category_id UUID;
  incoming_quality INT := CASE
    WHEN coalesce(NEW.extracted_data#>>'{normalized_payload,quality_score}', '') ~ '^\d{1,3}$'
      THEN least(100, (NEW.extracted_data#>>'{normalized_payload,quality_score}')::INT)
    ELSE 0
  END;
BEGIN
  IF event_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NEW.extracted_data->'normalized_payload' IS NULL
  THEN
    RETURN NEW;
  END IF;

  resolved_slug := CASE supplied_category
    WHEN 'concert' THEN 'concerts'
    WHEN 'concerts' THEN 'concerts'
    WHEN 'festival' THEN 'festivals'
    WHEN 'festivals' THEN 'festivals'
    WHEN 'exhibition' THEN 'expositions'
    WHEN 'exposition' THEN 'expositions'
    WHEN 'expositions' THEN 'expositions'
    WHEN 'nightlife' THEN 'soirees'
    WHEN 'party' THEN 'soirees'
    WHEN 'parties' THEN 'soirees'
    WHEN 'soiree' THEN 'soirees'
    WHEN 'soirees' THEN 'soirees'
    WHEN 'theater' THEN 'theatre'
    WHEN 'theatre' THEN 'theatre'
    WHEN 'family' THEN 'famille'
    WHEN 'famille' THEN 'famille'
    WHEN 'sport' THEN 'sports-outdoor'
    WHEN 'sports' THEN 'sports-outdoor'
    WHEN 'outdoor' THEN 'sports-outdoor'
    WHEN 'sports-outdoor' THEN 'sports-outdoor'
    WHEN 'patrimoine' THEN 'heritage'
    WHEN 'heritage' THEN 'heritage'
    WHEN 'gastronomie' THEN 'gastronomy'
    WHEN 'gastronomy' THEN 'gastronomy'
    WHEN 'activity' THEN 'activities'
    WHEN 'workshop' THEN 'activities'
    WHEN 'activities' THEN 'activities'
    WHEN 'conference' THEN 'conferences'
    WHEN 'conferences' THEN 'conferences'
    WHEN 'film' THEN 'cinema'
    WHEN 'cinema' THEN 'cinema'
    WHEN 'games' THEN 'leisure'
    WHEN 'loisirs' THEN 'leisure'
    WHEN 'leisure' THEN 'leisure'
    -- Generic labels still pass through the title/description rules below.
    WHEN 'autre' THEN NULL
    WHEN 'other' THEN NULL
    ELSE NULL
  END;

  IF resolved_slug IS NULL THEN
    resolved_slug := CASE
      WHEN classification_text ~ '(^|[^a-z])(club|clubbing|rave|party|soiree|nightlife|night[[:space:]-]*club|dj[[:space:]-]*set|afterwork|techno|house|disco)([^a-z]|$)' THEN 'soirees'
      WHEN classification_text ~ '(^|[^a-z])(festival|festiwal|music[[:space:]-]*festival|open[[:space:]-]*air[[:space:]-]*festival)([^a-z]|$)' THEN 'festivals'
      WHEN classification_text ~ '(^|[^a-z])(concert|live[[:space:]-]*music|gig|konzert|concerto|concierto|orchestre|orchestra|recital)([^a-z]|$)' THEN 'concerts'
      WHEN classification_text ~ '(^|[^a-z])(family|famille|children|enfant|kids|jeune[[:space:]-]*public)([^a-z]|$)' THEN 'famille'
      WHEN classification_text ~ '(^|[^a-z])(sport|outdoor[[:space:]-]*activit|plein[[:space:]-]*air|hiking|hike|randonnee|trail|running|cycling|bike|yoga|fitness|ski|swim|football|tennis)([^a-z]|$)' THEN 'sports-outdoor'
      WHEN classification_text ~ '(^|[^a-z])(heritage|patrimoine|guided[[:space:]-]*tour|visite[[:space:]-]*guidee|historic|monument|architecture|walking[[:space:]-]*tour)([^a-z]|$)' THEN 'heritage'
      WHEN classification_text ~ '(^|[^a-z])(gastronomy|gastronomie|food|market|marche|tasting|degustation|wine|culinary|cuisine)([^a-z]|$)' THEN 'gastronomy'
      WHEN classification_text ~ '(^|[^a-z])(workshop|atelier|masterclass|course|class|creative[[:space:]-]*activit|participatory)([^a-z]|$)' THEN 'activities'
      WHEN classification_text ~ '(^|[^a-z])(conference|talk|lecture|meetup|seminar|panel|debate|rencontre)([^a-z]|$)' THEN 'conferences'
      WHEN classification_text ~ '(^|[^a-z])(cinema|film|movie|screening|projection)([^a-z]|$)' THEN 'cinema'
      WHEN classification_text ~ '(^|[^a-z])(game|gaming|leisure|loisir|escape[[:space:]-]*room|quiz|bowling|arcade)([^a-z]|$)' THEN 'leisure'
      WHEN classification_text ~ '(^|[^a-z])(theatre|theater|teatro|ballet|dance[[:space:]-]*performance|spectacle|opera|musical|stand[[:space:]-]*up|comedy|comedie|humour)([^a-z]|$)' THEN 'theatre'
      WHEN classification_text ~ '(^|[^a-z])(expo|exhibition|vernissage|gallery|galerie|museum|musee|ausstellung|mostra|wystawa|art[[:space:]-]*fair)([^a-z]|$)' THEN 'expositions'
      ELSE NULL
    END;
  END IF;

  IF resolved_slug IS NULL AND supplied_category IN ('autre', 'other') THEN
    resolved_slug := 'other';
  END IF;

  SELECT category.id
  INTO resolved_category_id
  FROM public.event_categories AS category
  WHERE category.slug = resolved_slug;

  SELECT category.id
  INTO other_category_id
  FROM public.event_categories AS category
  WHERE category.slug = 'other';

  IF resolved_category_id IS NOT NULL THEN
    UPDATE public.events
    SET category_id = resolved_category_id
    WHERE id = event_id_text::UUID
      AND category_id IS DISTINCT FROM resolved_category_id
      AND (
        category_id IS NULL
        OR category_id = other_category_id
        OR (
          resolved_slug <> 'other'
          AND incoming_quality >= coalesce(quality_score, 0)
        )
      );
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sync_ingested_event_category_v1() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_ingested_event_category_v1 ON public.source_records;
CREATE TRIGGER trg_sync_ingested_event_category_v1
AFTER INSERT OR UPDATE OF extracted_data ON public.source_records
FOR EACH ROW
EXECUTE FUNCTION public.sync_ingested_event_category_v1();
