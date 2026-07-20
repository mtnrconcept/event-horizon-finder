-- Build a reversible public projection beside the imported source tables.
-- No source event, description, translation, media, venue, organizer or
-- performer row is updated or deleted by this migration.

CREATE TABLE IF NOT EXISTS public.event_publications_v2 (
  event_id UUID PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  short_description TEXT,
  description TEXT,
  cover_image_url TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_updated_at TIMESTAMPTZ,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  projection_version SMALLINT NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT event_publications_v2_details_object_check
    CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT event_publications_v2_details_size_check
    CHECK (pg_column_size(details) <= 65536),
  CONSTRAINT event_publications_v2_description_size_check
    CHECK (length(description) <= 4000),
  CONSTRAINT event_publications_v2_short_description_size_check
    CHECK (length(short_description) <= 280),
  CONSTRAINT event_publications_v2_projection_version_check
    CHECK (projection_version >= 2)
);

CREATE TABLE IF NOT EXISTS public.event_publication_media_v2 (
  source_media_id UUID PRIMARY KEY REFERENCES public.event_media(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  media_type TEXT NOT NULL,
  attribution TEXT,
  license TEXT,
  source_url TEXT,
  sort_order INTEGER,
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approval_reason TEXT,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_publication_media_v2_url_size_check CHECK (length(url) <= 4096),
  CONSTRAINT event_publication_media_v2_source_url_size_check
    CHECK (source_url IS NULL OR length(source_url) <= 4096)
);

CREATE INDEX IF NOT EXISTS event_publications_v2_active_updated_idx
  ON public.event_publications_v2 (source_updated_at DESC, event_id)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS event_publication_media_v2_event_approved_idx
  ON public.event_publication_media_v2 (event_id, sort_order, source_media_id)
  WHERE is_approved;

REVOKE ALL ON TABLE public.event_publications_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.event_publication_media_v2 FROM PUBLIC;
GRANT SELECT ON TABLE public.event_publications_v2 TO anon, authenticated;
GRANT SELECT ON TABLE public.event_publication_media_v2 TO anon, authenticated;
GRANT ALL ON TABLE public.event_publications_v2 TO service_role;
GRANT ALL ON TABLE public.event_publication_media_v2 TO service_role;

ALTER TABLE public.event_publications_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_publication_media_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_publications_v2_public_read"
  ON public.event_publications_v2;
CREATE POLICY "event_publications_v2_public_read"
ON public.event_publications_v2
FOR SELECT
TO anon, authenticated
USING (
  is_active
  AND EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.id = event_publications_v2.event_id
      AND event.is_demo = FALSE
      AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
  )
);

DROP POLICY IF EXISTS "event_publication_media_v2_public_read"
  ON public.event_publication_media_v2;
CREATE POLICY "event_publication_media_v2_public_read"
ON public.event_publication_media_v2
FOR SELECT
TO anon, authenticated
USING (
  is_approved
  AND EXISTS (
    SELECT 1
    FROM public.event_publications_v2 AS publication
    JOIN public.events AS event ON event.id = publication.event_id
    WHERE publication.event_id = event_publication_media_v2.event_id
      AND publication.is_active
      AND event.is_demo = FALSE
      AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
  )
);

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

CREATE OR REPLACE FUNCTION private.public_event_media_is_approved_v2(
  _license TEXT,
  _attribution TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH normalized AS (
    SELECT
      lower(btrim(coalesce(_license, ''))) AS license_value,
      nullif(btrim(_attribution), '') IS NOT NULL AS has_attribution
  )
  SELECT CASE
    -- A commercially restricted label always wins, even when it also contains
    -- the otherwise reusable "CC BY" token (for example CC BY-NC 4.0).
    WHEN license_value ~
      '(non[[:space:]_-]*commercial|no[[:space:]_-]+commercial[[:space:]_-]+use|by[[:space:]_-]*nc|(^|[^[:alnum:]])nc([^[:alnum:]]|$))'
      THEN FALSE
    -- CC0 and public-domain dedications do not require attribution.
    WHEN license_value ~
      '(cc[[:space:]_-]*0|creative[[:space:]_-]+commons[[:space:]_-]+zero|public[[:space:]_-]+domain|creativecommons[.]org/publicdomain)'
      THEN TRUE
    -- Do not accept the generic label "Creative Commons": require an
    -- attribution/BY variant or a recognized open-license family, and keep
    -- attribution mandatory for all of these licenses.
    WHEN license_value ~
      '(cc[[:space:]_-]*by|creative[[:space:]_-]+commons[[:space:]_-]+(attribution|by)|creativecommons[.]org/licenses/by(-sa)?/|licen[cs]e[[:space:]_-]+ouverte|open[[:space:]_-]+licen[cs]e|(^|[^[:alnum:]])odbl([^[:alnum:]]|$))'
      THEN has_attribution
    ELSE FALSE
  END
  FROM normalized;
$$;

CREATE OR REPLACE FUNCTION private.refresh_event_publication_v2(_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  source_details JSONB;
  source_updated TIMESTAMPTZ;
  category_name TEXT;
  venue_name TEXT;
  city_name TEXT;
  summary TEXT;
  active_projection BOOLEAN;
BEGIN
  IF _event_id IS NULL THEN
    RETURN;
  END IF;

  SELECT event.* INTO event_row
  FROM public.events AS event
  WHERE event.id = _event_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT detail.details, detail.updated_at
  INTO source_details, source_updated
  FROM public.event_scraped_details AS detail
  WHERE detail.event_id = _event_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  active_projection := event_row.created_by IS NULL AND NOT EXISTS (
    SELECT 1
    FROM public.organizer_members AS member
    WHERE member.organizer_id = event_row.organizer_id
  );

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

  summary := private.public_event_factual_summary_v1(
    event_row.title, category_name, venue_name, city_name, event_row.language
  );

  INSERT INTO public.event_publications_v2(
    event_id,
    short_description,
    description,
    cover_image_url,
    details,
    source_updated_at,
    projected_at,
    projection_version,
    is_active
  ) VALUES (
    _event_id,
    left(summary, 280),
    summary,
    NULL,
    private.sanitize_public_event_details_v2(source_details),
    source_updated,
    now(),
    2,
    active_projection
  )
  ON CONFLICT (event_id) DO UPDATE SET
    short_description = EXCLUDED.short_description,
    description = EXCLUDED.description,
    cover_image_url = EXCLUDED.cover_image_url,
    details = EXCLUDED.details,
    source_updated_at = EXCLUDED.source_updated_at,
    projected_at = EXCLUDED.projected_at,
    projection_version = EXCLUDED.projection_version,
    is_active = EXCLUDED.is_active;

  INSERT INTO public.event_publication_media_v2(
    source_media_id,
    event_id,
    url,
    media_type,
    attribution,
    license,
    source_url,
    sort_order,
    is_approved,
    approval_reason,
    projected_at
  )
  SELECT
    media.id,
    media.event_id,
    media.url,
    media.media_type,
    media.attribution,
    media.license,
    media.source_url,
    media.sort_order,
    active_projection AND private.public_event_media_is_approved_v2(
      media.license, media.attribution
    ),
    CASE
      WHEN NOT active_projection THEN 'event_not_managed_by_projection'
      WHEN private.public_event_media_is_approved_v2(media.license, media.attribution)
        THEN 'commercially_reusable_license'
      ELSE 'license_or_attribution_not_verified'
    END,
    now()
  FROM public.event_media AS media
  WHERE media.event_id = _event_id
  ON CONFLICT (source_media_id) DO UPDATE SET
    event_id = EXCLUDED.event_id,
    url = EXCLUDED.url,
    media_type = EXCLUDED.media_type,
    attribution = EXCLUDED.attribution,
    license = EXCLUDED.license,
    source_url = EXCLUDED.source_url,
    sort_order = EXCLUDED.sort_order,
    is_approved = EXCLUDED.is_approved,
    approval_reason = EXCLUDED.approval_reason,
    projected_at = EXCLUDED.projected_at;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_event_publication_trigger_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.refresh_event_publication_v2(NEW.event_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_event_publication_from_event_trigger_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.event_scraped_details AS detail WHERE detail.event_id = NEW.id
  ) THEN
    PERFORM private.refresh_event_publication_v2(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_event_publication_media_trigger_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.event_publications_v2 AS publication
    WHERE publication.event_id = NEW.event_id
  ) THEN
    PERFORM private.refresh_event_publication_v2(NEW.event_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sanitize_public_event_details_v2(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_event_factual_summary_v1(TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.public_event_media_is_approved_v2(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_event_publication_v2(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_event_publication_trigger_v2()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_event_publication_from_event_trigger_v2()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_event_publication_media_trigger_v2()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_refresh_event_publication_from_details_v2
  ON public.event_scraped_details;
CREATE TRIGGER trg_refresh_event_publication_from_details_v2
AFTER INSERT OR UPDATE OF details, updated_at
ON public.event_scraped_details
FOR EACH ROW
EXECUTE FUNCTION private.refresh_event_publication_trigger_v2();

DROP TRIGGER IF EXISTS trg_refresh_event_publication_from_event_v2
  ON public.events;
CREATE TRIGGER trg_refresh_event_publication_from_event_v2
AFTER UPDATE OF title, category_id, venue_id, city_id, language, created_by, organizer_id
ON public.events
FOR EACH ROW
EXECUTE FUNCTION private.refresh_event_publication_from_event_trigger_v2();

DROP TRIGGER IF EXISTS trg_refresh_event_publication_from_media_v2
  ON public.event_media;
CREATE TRIGGER trg_refresh_event_publication_from_media_v2
AFTER INSERT OR UPDATE OF event_id, url, media_type, attribution, license, source_url, sort_order
ON public.event_media
FOR EACH ROW
EXECUTE FUNCTION private.refresh_event_publication_media_trigger_v2();

-- Production contains more than 160,000 scraped-detail rows. Keep schema
-- installation DDL-only: the historical projection is filled by explicit,
-- short service-role calls after the migration commits. New and changed rows
-- are projected immediately by the triggers above.
CREATE OR REPLACE FUNCTION public.backfill_event_publications_v2(
  _limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  batch_limit INTEGER := greatest(1, least(coalesce(_limit, 100), 500));
  candidate_event_id UUID;
  processed_count INTEGER := 0;
  has_more BOOLEAN := FALSE;
BEGIN
  FOR candidate_event_id IN
    SELECT detail.event_id
    FROM public.event_scraped_details AS detail
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.event_publications_v2 AS publication
      WHERE publication.event_id = detail.event_id
    )
    ORDER BY detail.event_id
    LIMIT batch_limit
    FOR UPDATE OF detail SKIP LOCKED
  LOOP
    PERFORM private.refresh_event_publication_v2(candidate_event_id);
    processed_count := processed_count + 1;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM public.event_scraped_details AS detail
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.event_publications_v2 AS publication
      WHERE publication.event_id = detail.event_id
    )
  ) INTO has_more;

  RETURN jsonb_build_object(
    'processed_count', processed_count,
    'has_more', has_more
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_event_publications_v2(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_event_publications_v2(INTEGER)
  TO service_role;

COMMENT ON TABLE public.event_publications_v2 IS
  'Reversible, factual public projection for imported events. Original source data remains unchanged.';
COMMENT ON TABLE public.event_publication_media_v2 IS
  'Reversible media projection. Source media remains unchanged; only approved rows are publicly readable.';
COMMENT ON FUNCTION public.backfill_event_publications_v2(INTEGER) IS
  'Service-role-only bounded backfill. Re-run until has_more is false; each call projects at most 500 missing events.';
