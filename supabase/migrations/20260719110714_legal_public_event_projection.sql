-- Keep scraper evidence private while exposing only facts needed by visitors.
-- Copyright-sensitive descriptions and unlicensed media are never published.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.event_scraped_details FROM anon, authenticated;
REVOKE ALL ON TABLE public.source_records FROM anon, authenticated;
GRANT SELECT ON TABLE public.source_records TO authenticated;

DO $revoke_optional_staging_access$
BEGIN
  IF to_regclass('public.eventscrap') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.eventscrap FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.eventscrap TO service_role';
  END IF;
END;
$revoke_optional_staging_access$;

CREATE OR REPLACE FUNCTION private.sanitize_public_event_details_v2(_details JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(_details) IS DISTINCT FROM 'object' THEN '{}'::JSONB
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'source', coalesce(
        private.clean_public_event_text(_details->>'source', 256),
        private.clean_public_event_text(_details#>>'{merged_sources,0,source}', 256)
      ),
      'source_url', coalesce(
        private.clean_public_event_url(_details->>'source_url'),
        private.clean_public_event_url(_details#>>'{merged_sources,0,url}')
      ),
      'source_license', private.clean_public_event_text(_details->>'source_license', 512),
      'source_license_url', private.clean_public_event_url(_details->>'source_license_url'),
      'event_type', private.clean_public_event_text(_details->>'event_type', 256),
      'event_subtype', private.clean_public_event_text(_details->>'event_subtype', 256),
      'ticket_or_registration_url', private.clean_public_event_url(
        _details->>'ticket_or_registration_url'
      ),
      'booking_required', private.clean_public_event_boolean(_details->>'booking_required'),
      'price_min_raw', private.clean_public_event_numeric(
        _details->>'price_min_raw', 0, 999999999
      ),
      'price_max_raw', private.clean_public_event_numeric(
        _details->>'price_max_raw', 0, 999999999
      ),
      'currency_raw', upper(private.clean_public_event_text(_details->>'currency_raw', 8)),
      'is_free_raw', private.clean_public_event_boolean(_details->>'is_free_raw'),
      'venue_website', private.clean_public_event_url(_details->>'venue_website'),
      'organizer_url', private.clean_public_event_url(_details->>'organizer_url'),
      'online_event', private.clean_public_event_boolean(_details->>'online_event'),
      'audience', private.clean_public_event_text(_details->>'audience', 1000),
      'age_min', private.clean_public_event_integer(_details->>'age_min', 0, 130),
      'age_max', private.clean_public_event_integer(_details->>'age_max', 0, 130),
      'capacity_raw', private.clean_public_event_integer(
        _details->>'capacity_raw', 0, 10000000
      ),
      'indoor', private.clean_public_event_boolean(_details->>'indoor'),
      'pets_allowed', private.clean_public_event_boolean(_details->>'pets_allowed'),
      'language_raw', private.clean_public_event_text(_details->>'language_raw', 32)
    ))
  END;
$$;

CREATE OR REPLACE FUNCTION private.public_event_scraped_details_v1(
  _payload JSONB,
  _source_url TEXT DEFAULT NULL,
  _source_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT private.sanitize_public_event_details_v2(jsonb_strip_nulls(jsonb_build_object(
    'source', coalesce(
      private.clean_public_event_text(_payload->>'source', 256),
      private.clean_public_event_text(_source_name, 256)
    ),
    'source_url', coalesce(
      private.clean_public_event_url(_payload->>'source_url'),
      private.clean_public_event_url(_source_url)
    ),
    'source_license', coalesce(
      private.clean_public_event_text(_payload->>'source_license', 512),
      private.clean_public_event_text(_payload->>'license', 512)
    ),
    'source_license_url', private.clean_public_event_url(_payload->>'source_license_url'),
    'event_type', private.clean_public_event_text(_payload->>'event_type', 256),
    'event_subtype', private.clean_public_event_text(_payload->>'event_subtype', 256),
    'ticket_or_registration_url', coalesce(
      private.clean_public_event_url(_payload->>'ticket_or_registration_url'),
      private.clean_public_event_url(_payload->>'ticket_url')
    ),
    'booking_required', private.clean_public_event_boolean(_payload->>'booking_required'),
    'price_min_raw', private.clean_public_event_numeric(_payload->>'price_min', 0, 999999999),
    'price_max_raw', private.clean_public_event_numeric(_payload->>'price_max', 0, 999999999),
    'currency_raw', upper(private.clean_public_event_text(_payload->>'currency', 8)),
    'is_free_raw', private.clean_public_event_boolean(_payload->>'is_free'),
    'venue_website', coalesce(
      private.clean_public_event_url(_payload->>'venue_website'),
      private.clean_public_event_url(_payload->>'venue_url')
    ),
    'organizer_url', private.clean_public_event_url(_payload->>'organizer_url'),
    'online_event', private.clean_public_event_boolean(_payload->>'online_event'),
    'audience', private.clean_public_event_text(_payload->>'audience', 1000),
    'age_min', private.clean_public_event_integer(_payload->>'age_min', 0, 130),
    'age_max', private.clean_public_event_integer(_payload->>'age_max', 0, 130),
    'capacity_raw', private.clean_public_event_integer(_payload->>'capacity', 0, 10000000),
    'indoor', private.clean_public_event_boolean(_payload->>'indoor'),
    'pets_allowed', private.clean_public_event_boolean(_payload->>'pets_allowed'),
    'language_raw', private.clean_public_event_text(_payload->>'language', 32)
  )));
$$;

CREATE OR REPLACE FUNCTION private.store_public_event_scraped_details_v1(
  _event_id UUID,
  _details JSONB,
  _source_updated_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  safe_details JSONB := private.sanitize_public_event_details_v2(_details);
  normalized_updated_at TIMESTAMPTZ := coalesce(
    _source_updated_at,
    '1970-01-01 00:00:00+00'::TIMESTAMPTZ
  );
BEGIN
  IF _event_id IS NULL
    OR safe_details = '{}'::JSONB
    OR NOT EXISTS (SELECT 1 FROM public.events AS event WHERE event.id = _event_id)
  THEN
    RETURN;
  END IF;

  INSERT INTO public.event_scraped_details(event_id, details, updated_at)
  VALUES (_event_id, safe_details, normalized_updated_at)
  ON CONFLICT (event_id) DO UPDATE SET
    details = EXCLUDED.details,
    updated_at = greatest(public.event_scraped_details.updated_at, EXCLUDED.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION private.public_event_factual_summary_v1(
  _title TEXT,
  _category TEXT,
  _venue TEXT,
  _city TEXT,
  _language TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  title_value TEXT := left(nullif(btrim(_title), ''), 500);
  category_value TEXT := left(nullif(btrim(_category), ''), 200);
  venue_value TEXT := left(nullif(btrim(_venue), ''), 300);
  city_value TEXT := left(nullif(btrim(_city), ''), 200);
  language_value TEXT := split_part(lower(coalesce(_language, 'en')), '-', 1);
  location_value TEXT;
BEGIN
  IF title_value IS NULL THEN
    RETURN NULL;
  END IF;
  location_value := nullif(concat_ws(', ', venue_value, city_value), '');

  RETURN CASE language_value
    WHEN 'fr' THEN concat(
      '« ', title_value, ' » est ',
      CASE WHEN category_value IS NULL THEN 'un événement' ELSE 'un événement de type ' || category_value END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' proposé à ' || location_value || '.' END,
      ' Retrouvez ici les dates, horaires, tarifs et modalités de réservation disponibles.'
    )
    WHEN 'de' THEN concat(
      '„', title_value, '“ ist ',
      CASE WHEN category_value IS NULL THEN 'eine Veranstaltung' ELSE 'eine Veranstaltung der Kategorie ' || category_value END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' in ' || location_value || '.' END,
      ' Hier finden Sie die verfügbaren Angaben zu Datum, Uhrzeit, Preis und Reservierung.'
    )
    WHEN 'it' THEN concat(
      '“', title_value, '” è ',
      CASE WHEN category_value IS NULL THEN 'un evento' ELSE 'un evento della categoria ' || category_value END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' a ' || location_value || '.' END,
      ' Qui trovi le informazioni disponibili su date, orari, prezzi e prenotazioni.'
    )
    WHEN 'es' THEN concat(
      '«', title_value, '» es ',
      CASE WHEN category_value IS NULL THEN 'un evento' ELSE 'un evento de la categoría ' || category_value END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' en ' || location_value || '.' END,
      ' Consulta aquí la información disponible sobre fechas, horarios, precios y reservas.'
    )
    WHEN 'pt' THEN concat(
      '“', title_value, '” é ',
      CASE WHEN category_value IS NULL THEN 'um evento' ELSE 'um evento da categoria ' || category_value END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' em ' || location_value || '.' END,
      ' Consulte aqui as informações disponíveis sobre datas, horários, preços e reservas.'
    )
    ELSE concat(
      '“', title_value, '” is ',
      CASE WHEN category_value IS NULL THEN 'an event' ELSE 'an event in the ' || category_value || ' category' END,
      CASE WHEN location_value IS NULL THEN '.' ELSE ' at ' || location_value || '.' END,
      ' View the available date, time, pricing and booking information here.'
    )
  END;
END;
$$;

CREATE OR REPLACE FUNCTION private.enforce_scraped_event_publication_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  category_name TEXT;
  venue_name TEXT;
  city_name TEXT;
  safe_summary TEXT;
BEGIN
  SELECT event.* INTO event_row
  FROM public.events AS event
  WHERE event.id = NEW.event_id;
  IF NOT FOUND OR event_row.created_by IS NOT NULL OR (
    event_row.organizer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.organizer_members AS member
      WHERE member.organizer_id = event_row.organizer_id
    )
  ) THEN
    RETURN NEW;
  END IF;

  SELECT CASE split_part(lower(coalesce(event_row.language, 'en')), '-', 1)
    WHEN 'fr' THEN category.name_fr
    WHEN 'en' THEN category.name_en
    ELSE NULL
  END INTO category_name
  FROM public.event_categories AS category
  WHERE category.id = event_row.category_id;
  SELECT venue.name INTO venue_name
  FROM public.venues AS venue
  WHERE venue.id = event_row.venue_id;
  SELECT city.name INTO city_name
  FROM public.cities AS city
  WHERE city.id = event_row.city_id;

  safe_summary := private.public_event_factual_summary_v1(
    event_row.title, category_name, venue_name, city_name, event_row.language
  );

  UPDATE public.events
  SET short_description = left(safe_summary, 280),
      description = safe_summary,
      cover_image_url = NULL
  WHERE id = event_row.id
    AND (
      short_description IS DISTINCT FROM left(safe_summary, 280)
      OR description IS DISTINCT FROM safe_summary
      OR cover_image_url IS NOT NULL
    );

  DELETE FROM public.event_media AS media
  WHERE media.event_id = event_row.id
    AND NOT (
      lower(coalesce(media.license, '')) ~
        '(cc0|public domain|creative commons|cc[- ]?by|licen[cs]e ouverte|open licen[cs]e|odbl)'
      AND (
        lower(coalesce(media.license, '')) ~ '(cc0|public domain)'
        OR nullif(btrim(media.attribution), '') IS NOT NULL
      )
    );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.sanitize_public_event_details_write_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.details := private.sanitize_public_event_details_v2(NEW.details);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sanitize_public_event_details_v2(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_event_factual_summary_v1(TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.enforce_scraped_event_publication_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sanitize_public_event_details_write_v2()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sanitize_public_event_details_write_v2
  ON public.event_scraped_details;
CREATE TRIGGER trg_sanitize_public_event_details_write_v2
BEFORE INSERT OR UPDATE OF details
ON public.event_scraped_details
FOR EACH ROW
EXECUTE FUNCTION private.sanitize_public_event_details_write_v2();

DROP TRIGGER IF EXISTS trg_enforce_scraped_event_publication_v1
  ON public.event_scraped_details;
CREATE TRIGGER trg_enforce_scraped_event_publication_v1
AFTER INSERT OR UPDATE OF details
ON public.event_scraped_details
FOR EACH ROW
EXECUTE FUNCTION private.enforce_scraped_event_publication_v1();

-- One-time cleanup. Source evidence remains in source_records behind admin/
-- moderator RLS, while the public relation is reduced to the safe whitelist.
ALTER TABLE public.event_scraped_details
  DISABLE TRIGGER trg_event_scraped_details_invalidate_translations;
ALTER TABLE public.event_scraped_details
  DISABLE TRIGGER trg_enforce_scraped_event_publication_v1;
UPDATE public.event_scraped_details
SET details = private.sanitize_public_event_details_v2(details)
WHERE details IS DISTINCT FROM private.sanitize_public_event_details_v2(details);
ALTER TABLE public.event_scraped_details
  ENABLE TRIGGER trg_enforce_scraped_event_publication_v1;
ALTER TABLE public.event_scraped_details
  ENABLE TRIGGER trg_event_scraped_details_invalidate_translations;

ALTER TABLE public.events DISABLE TRIGGER trg_events_invalidate_translations;
ALTER TABLE public.events DISABLE TRIGGER trg_sync_public_event_from_eventscrap_v1;

WITH imported AS (
  SELECT detail.event_id
  FROM public.event_scraped_details AS detail
), sanitized AS (
  SELECT
    event.id,
    private.public_event_factual_summary_v1(
      event.title,
      CASE split_part(lower(coalesce(event.language, 'en')), '-', 1)
        WHEN 'fr' THEN category.name_fr
        WHEN 'en' THEN category.name_en
        ELSE NULL
      END,
      venue.name,
      city.name,
      event.language
    ) AS summary
  FROM public.events AS event
  JOIN imported ON imported.event_id = event.id
  LEFT JOIN public.event_categories AS category ON category.id = event.category_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city ON city.id = event.city_id
  WHERE event.created_by IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.organizer_members AS member
      WHERE member.organizer_id = event.organizer_id
    )
)
UPDATE public.events AS event
SET short_description = left(sanitized.summary, 280),
    description = sanitized.summary,
    cover_image_url = NULL
FROM sanitized
WHERE event.id = sanitized.id
  AND sanitized.summary IS NOT NULL
  AND (
    event.short_description IS DISTINCT FROM left(sanitized.summary, 280)
    OR event.description IS DISTINCT FROM sanitized.summary
    OR event.cover_image_url IS NOT NULL
  );

ALTER TABLE public.events ENABLE TRIGGER trg_sync_public_event_from_eventscrap_v1;
ALTER TABLE public.events ENABLE TRIGGER trg_events_invalidate_translations;

-- Translation rows may contain the previous source prose in both dedicated
-- columns and the rich JSON overlay. They will be regenerated on demand from
-- the new factual summaries.
DELETE FROM public.event_translations AS translation
USING public.event_scraped_details AS detail
WHERE translation.event_id = detail.event_id;

DELETE FROM public.event_media AS media
USING public.event_scraped_details AS detail, public.events AS event
WHERE detail.event_id = media.event_id
  AND event.id = media.event_id
  AND event.created_by IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.organizer_members AS member
    WHERE member.organizer_id = event.organizer_id
  )
  AND NOT (
    lower(coalesce(media.license, '')) ~
      '(cc0|public domain|creative commons|cc[- ]?by|licen[cs]e ouverte|open licen[cs]e|odbl)'
    AND (
      lower(coalesce(media.license, '')) ~ '(cc0|public domain)'
      OR nullif(btrim(media.attribution), '') IS NOT NULL
    )
  );

UPDATE public.venues AS venue
SET description = NULL,
    cover_image_url = NULL
WHERE (venue.description IS NOT NULL OR venue.cover_image_url IS NOT NULL)
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    JOIN public.event_scraped_details AS detail ON detail.event_id = event.id
    WHERE event.venue_id = venue.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.venue_id = venue.id
      AND (
        event.created_by IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.organizer_members AS member
          WHERE member.organizer_id = event.organizer_id
        )
      )
  );

DELETE FROM public.venue_translations AS translation
USING public.venues AS venue
WHERE translation.venue_id = venue.id
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    JOIN public.event_scraped_details AS detail ON detail.event_id = event.id
    WHERE event.venue_id = venue.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.venue_id = venue.id
      AND (
        event.created_by IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.organizer_members AS member
          WHERE member.organizer_id = event.organizer_id
        )
      )
  );

UPDATE public.organizers AS organizer
SET description = NULL,
    logo_url = NULL
WHERE (organizer.description IS NOT NULL OR organizer.logo_url IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM public.organizer_members AS member
    WHERE member.organizer_id = organizer.id
  )
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    JOIN public.event_scraped_details AS detail ON detail.event_id = event.id
    WHERE event.organizer_id = organizer.id
  );

UPDATE public.performers AS performer
SET bio = NULL,
    image_url = NULL
WHERE (performer.bio IS NOT NULL OR performer.image_url IS NOT NULL)
  AND EXISTS (
    SELECT 1
    FROM public.event_performers AS event_performer
    JOIN public.event_scraped_details AS detail
      ON detail.event_id = event_performer.event_id
    WHERE event_performer.performer_id = performer.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.event_performers AS event_performer
    JOIN public.events AS event ON event.id = event_performer.event_id
    LEFT JOIN public.event_scraped_details AS detail ON detail.event_id = event.id
    WHERE event_performer.performer_id = performer.id
      AND (
        detail.event_id IS NULL
        OR event.created_by IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.organizer_members AS member
          WHERE member.organizer_id = event.organizer_id
        )
      )
  );

COMMENT ON TABLE public.event_scraped_details IS
  'Public factual projection for imported events. Raw source evidence is private and never exposed to visitors.';
