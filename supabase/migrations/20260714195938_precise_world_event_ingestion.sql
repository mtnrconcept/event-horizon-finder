-- Precision pass adapted from the modular world-event scraper:
-- preserve time semantics, use each city's timezone, reject implausible coordinates,
-- prefer stable source identities, and publish only sufficiently complete records.

ALTER TABLE public.event_occurrences
  ADD COLUMN IF NOT EXISTS time_precision TEXT NOT NULL DEFAULT 'exact',
  ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.event_occurrences
  DROP CONSTRAINT IF EXISTS event_occurrences_time_precision_check;

ALTER TABLE public.event_occurrences
  ADD CONSTRAINT event_occurrences_time_precision_check
  CHECK (time_precision IN ('exact', 'date', 'tbd', 'unknown'));

COMMENT ON COLUMN public.event_occurrences.time_precision IS
  'Whether the advertised start time is exact, date-only, TBD, or unknown.';
COMMENT ON COLUMN public.event_occurrences.all_day IS
  'True only when the source explicitly advertises an all-day occurrence.';

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
#variable_conflict use_column
DECLARE
  v_source public.data_sources%ROWTYPE;
  v_title TEXT := left(trim(_title), 240);
  v_description TEXT := nullif(left(trim(coalesce(_description, '')), 6000), '');
  v_classification_text TEXT;
  v_category_slug TEXT;
  v_category_id UUID;
  v_city_id UUID;
  v_city_name TEXT;
  v_city_timezone TEXT := 'UTC';
  v_city_latitude DOUBLE PRECISION;
  v_city_longitude DOUBLE PRECISION;
  v_country_code TEXT;
  v_currency TEXT := 'EUR';
  v_max_distance_km DOUBLE PRECISION := 250;
  v_language TEXT := 'und';
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
  IF unaccent(lower(v_title)) ~ '(gift[[:space:]]*card|carte[[:space:]]*cadeau|newsletter|privacy|cookie|membership|abonnement|contact|faq)' THEN
    RAISE EXCEPTION 'navigation_or_commerce';
  END IF;
  IF _starts_at IS NULL OR _starts_at < now() - interval '2 days' OR _starts_at > now() + interval '24 months' THEN
    RAISE EXCEPTION 'invalid_start_date';
  END IF;
  IF _ends_at IS NOT NULL AND _ends_at < _starts_at THEN
    _ends_at := NULL;
  END IF;

  v_city_id := v_source.city_id;
  SELECT c.name, c.timezone, c.latitude, c.longitude, upper(country.code)
  INTO v_city_name, v_city_timezone, v_city_latitude, v_city_longitude, v_country_code
  FROM public.cities AS c
  LEFT JOIN public.countries AS country ON country.id = c.country_id
  WHERE c.id = v_city_id;
  v_city_timezone := coalesce(nullif(v_city_timezone, ''), 'UTC');

  IF coalesce(v_source.metadata->>'max_distance_km', '') ~ '^\d+(\.\d+)?$' THEN
    v_max_distance_km := greatest(
      5,
      least(2000, (v_source.metadata->>'max_distance_km')::double precision)
    );
  END IF;

  IF coalesce(v_source.metadata->>'locale', '') ~ '^[a-zA-Z]{2}([_-][a-zA-Z]{2})?$' THEN
    v_language := lower(left(v_source.metadata->>'locale', 2));
  END IF;

  v_currency := CASE v_country_code
    WHEN 'CH' THEN 'CHF'
    WHEN 'GB' THEN 'GBP'
    WHEN 'US' THEN 'USD'
    WHEN 'CA' THEN 'CAD'
    WHEN 'AU' THEN 'AUD'
    WHEN 'NZ' THEN 'NZD'
    WHEN 'JP' THEN 'JPY'
    WHEN 'PL' THEN 'PLN'
    WHEN 'CZ' THEN 'CZK'
    WHEN 'HU' THEN 'HUF'
    WHEN 'SE' THEN 'SEK'
    WHEN 'NO' THEN 'NOK'
    WHEN 'DK' THEN 'DKK'
    ELSE 'EUR'
  END;

  -- Coordinates are an indivisible pair. Values far outside the source city's
  -- declared coverage are discarded rather than creating a moving or false pin.
  IF (_latitude IS NULL) <> (_longitude IS NULL) THEN
    _latitude := NULL;
    _longitude := NULL;
  END IF;
  IF _latitude IS NOT NULL AND (_latitude < -90 OR _latitude > 90) THEN
    _latitude := NULL;
    _longitude := NULL;
  END IF;
  IF _longitude IS NOT NULL AND (_longitude < -180 OR _longitude > 180) THEN
    _latitude := NULL;
    _longitude := NULL;
  END IF;
  IF _latitude IS NOT NULL
    AND _longitude IS NOT NULL
    AND v_city_latitude IS NOT NULL
    AND v_city_longitude IS NOT NULL
    AND 6371 * 2 * asin(sqrt(
      power(sin(radians((_latitude - v_city_latitude) / 2)), 2) +
      cos(radians(v_city_latitude)) * cos(radians(_latitude)) *
      power(sin(radians((_longitude - v_city_longitude) / 2)), 2)
    )) > v_max_distance_km
  THEN
    _latitude := NULL;
    _longitude := NULL;
  END IF;

  v_classification_text := unaccent(lower(concat_ws(' ', _category, v_title, v_description)));
  v_category_slug := CASE
    WHEN v_classification_text ~ '(^|[^a-z])(club|clubbing|rave|party|soiree|night|dj[[:space:]]*set|afterwork|techno|house|disco)([^a-z]|$)' THEN 'soirees'
    WHEN v_classification_text ~ '(^|[^a-z])(festival|open[[:space:]-]*air|festiwal)([^a-z]|$)' THEN 'festivals'
    WHEN v_classification_text ~ '(^|[^a-z])(concert|live[[:space:]]*music|gig|konzert|concerto|concierto|orchestre|orchestra|recital)([^a-z]|$)' THEN 'concerts'
    WHEN v_classification_text ~ '(^|[^a-z])(theatre|theater|teatro|ballet|spectacle|opera|musical|stand[[:space:]-]*up|comedy|comedie|humour)([^a-z]|$)' THEN 'theatre'
    WHEN v_classification_text ~ '(^|[^a-z])(expo|exhibition|vernissage|gallery|galerie|museum|musee|ausstellung|mostra|wystawa)([^a-z]|$)' THEN 'expositions'
    WHEN v_classification_text ~ '(^|[^a-z])(famille|family|enfant|children|kids|jeune[[:space:]]*public)([^a-z]|$)' THEN 'famille'
    ELSE v_source.category_slug
  END;
  SELECT id INTO v_category_id FROM public.event_categories WHERE slug = v_category_slug;

  IF nullif(trim(coalesce(_venue_name, '')), '') IS NOT NULL THEN
    SELECT venue.id INTO v_venue_id
    FROM public.venues AS venue
    WHERE (venue.city_id = v_city_id OR v_city_id IS NULL)
      AND similarity(unaccent(lower(venue.name)), unaccent(lower(trim(_venue_name)))) >= 0.84
    ORDER BY similarity(unaccent(lower(venue.name)), unaccent(lower(trim(_venue_name)))) DESC
    LIMIT 1;

    IF v_venue_id IS NULL THEN
      v_venue_slug := left(
        trim(both '-' from regexp_replace(
          unaccent(lower(trim(_venue_name) || '-' || coalesce(v_city_name, 'world'))),
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

  v_official_url := CASE
    WHEN coalesce(_source_url, '') ~ '^https?://' THEN left(_source_url, 1000)
    ELSE v_source.base_url
  END;
  v_ticket_url := CASE
    WHEN coalesce(_ticket_url, '') ~ '^https?://' THEN left(_ticket_url, 1000)
    ELSE NULL
  END;
  v_image_url := CASE
    WHEN coalesce(_image_url, '') ~ '^https?://'
      AND _image_url !~* '(transparent|placeholder|spacer|logo)([._/-]|$)'
      THEN left(_image_url, 1000)
    ELSE NULL
  END;

  v_fingerprint := encode(extensions.digest(
    regexp_replace(unaccent(lower(v_title)), '[^a-z0-9]+', '', 'g') || '|' ||
    to_char(_starts_at AT TIME ZONE v_city_timezone, 'YYYY-MM-DD"T"HH24:MI') || '|' ||
    coalesce(v_city_id::text, '') || '|' || coalesce(v_venue_id::text, ''),
    'sha256'
  ), 'hex');

  -- Serialize only potentially identical candidates. This keeps the unique
  -- fingerprint upsert race-free while unrelated sources continue in parallel.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    regexp_replace(unaccent(lower(v_title)), '[^a-z0-9]+', '', 'g') || '|' ||
    ((_starts_at AT TIME ZONE v_city_timezone)::date)::text || '|' ||
    coalesce(v_city_id::text, '') || '|' || coalesce(v_venue_id::text, ''),
    0
  ));

  -- A stable source ID identifies an occurrence only when its advertised time
  -- also matches. Recurring shows often reuse the same series identifier.
  IF nullif(trim(coalesce(_external_identifier, '')), '') IS NOT NULL THEN
    SELECT CASE
      WHEN coalesce(record.extracted_data->>'event_id', '') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (record.extracted_data->>'event_id')::uuid
      ELSE NULL
    END INTO v_event_id
    FROM public.source_records AS record
    JOIN public.event_occurrences AS occurrence
      ON occurrence.event_id = CASE
        WHEN coalesce(record.extracted_data->>'event_id', '') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (record.extracted_data->>'event_id')::uuid
        ELSE NULL
      END
      AND occurrence.starts_at BETWEEN _starts_at - interval '15 minutes'
        AND _starts_at + interval '15 minutes'
    WHERE record.data_source_id = v_source.id
      AND record.external_identifier = left(trim(_external_identifier), 500)
      AND coalesce(record.extracted_data->>'event_id', '') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY record.processed_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_event_id IS NULL THEN
    SELECT event.id INTO v_event_id
    FROM public.events AS event
    WHERE event.canonical_fingerprint = v_fingerprint
    LIMIT 1;
  END IF;

  IF v_event_id IS NULL THEN
    SELECT event.id INTO v_event_id
    FROM public.events AS event
    JOIN public.event_occurrences AS occurrence ON occurrence.event_id = event.id
    WHERE occurrence.starts_at BETWEEN _starts_at - interval '15 minutes'
      AND _starts_at + interval '15 minutes'
      AND (event.city_id = v_city_id OR event.city_id IS NULL OR v_city_id IS NULL)
      AND (v_venue_id IS NULL OR event.venue_id IS NULL OR event.venue_id = v_venue_id)
      AND similarity(unaccent(lower(event.title)), unaccent(lower(v_title))) >= 0.90
    ORDER BY
      similarity(unaccent(lower(event.title)), unaccent(lower(v_title))) DESC,
      abs(extract(epoch FROM occurrence.starts_at - _starts_at)) ASC
    LIMIT 1;
  END IF;

  -- Same weighted completeness model as the deterministic normalizer.
  v_score :=
    22 +
    22 +
    CASE WHEN _ends_at IS NOT NULL THEN 10 ELSE 0 END +
    CASE WHEN v_venue_id IS NOT NULL OR nullif(trim(coalesce(_address, '')), '') IS NOT NULL THEN 12 ELSE 0 END +
    CASE WHEN v_city_id IS NOT NULL THEN 8 ELSE 0 END +
    CASE WHEN length(coalesce(v_description, '')) >= 40 THEN 8 ELSE 0 END +
    CASE WHEN v_image_url IS NOT NULL THEN 6 ELSE 0 END +
    CASE WHEN v_ticket_url IS NOT NULL THEN 5 ELSE 0 END +
    CASE WHEN v_category_id IS NOT NULL THEN 4 ELSE 0 END +
    CASE WHEN _latitude IS NOT NULL AND _longitude IS NOT NULL THEN 3 ELSE 0 END;
  v_score := LEAST(v_score, 100);
  v_publish := v_source.is_authorized AND v_source.is_verified AND v_score >= 65;

  IF v_event_id IS NULL THEN
    v_slug := left(
      trim(both '-' from regexp_replace(unaccent(lower(v_title)), '[^a-z0-9]+', '-', 'g')) || '-' ||
      to_char(_starts_at AT TIME ZONE v_city_timezone, 'YYYY-MM-DD') || '-' || left(v_fingerprint, 7),
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
      v_language, v_official_url, v_image_url, false, v_fingerprint, v_score, now(),
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
      source_confidence = GREATEST(
        coalesce(source_confidence, 0),
        CASE WHEN v_source.source_type IN ('official_site', 'venue_site', 'organizer_site') THEN 90 ELSE 78 END
      ),
      language = CASE WHEN language IN ('', 'und', 'fr') AND v_language <> 'und' THEN v_language ELSE language END,
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
    latitude, longitude, status, ticket_status, time_precision, all_day
  )
  VALUES (
    v_event_id, _starts_at, _ends_at, v_city_timezone,
    (_starts_at AT TIME ZONE v_city_timezone)::date,
    CASE WHEN _ends_at IS NULL THEN NULL ELSE (_ends_at AT TIME ZONE v_city_timezone)::date END,
    COALESCE(_latitude, (SELECT latitude FROM public.venues WHERE id = v_venue_id)),
    COALESCE(_longitude, (SELECT longitude FROM public.venues WHERE id = v_venue_id)),
    'scheduled',
    CASE WHEN coalesce(_is_free, false) THEN 'free'::public.ticket_status ELSE 'unknown'::public.ticket_status END,
    'exact',
    false
  )
  ON CONFLICT (event_id, starts_at) DO UPDATE SET
    ends_at = COALESCE(EXCLUDED.ends_at, public.event_occurrences.ends_at),
    timezone = EXCLUDED.timezone,
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
      currency = COALESCE(currency, v_currency)
    WHERE id = (
      SELECT offer.id
      FROM public.ticket_offers AS offer
      WHERE offer.event_id = v_event_id
      ORDER BY offer.id
      LIMIT 1
    );
    IF NOT FOUND THEN
      INSERT INTO public.ticket_offers(event_id, name, currency, is_free, ticket_url, status)
      VALUES (
        v_event_id,
        CASE WHEN coalesce(_is_free, false) THEN 'Entrée gratuite' ELSE 'Billetterie officielle' END,
        v_currency, coalesce(_is_free, false), v_ticket_url,
        CASE WHEN coalesce(_is_free, false) THEN 'free'::public.ticket_status ELSE 'unknown'::public.ticket_status END
      );
    END IF;
  END IF;

  INSERT INTO public.source_records(
    data_source_id, source_url, external_identifier, extracted_data,
    content_hash, processing_status, processed_at
  )
  VALUES (
    v_source.id, v_official_url, nullif(left(trim(coalesce(_external_identifier, '')), 500), ''),
    jsonb_build_object(
      'event_id', v_event_id,
      'quality_score', v_score,
      'action', v_action,
      'starts_at', _starts_at,
      'timezone', v_city_timezone,
      'precision_version', 2
    ),
    encode(extensions.digest(v_fingerprint || '|' || coalesce(_external_identifier, v_official_url), 'sha256'), 'hex'),
    'processed', now()
  );

  RETURN QUERY SELECT v_event_id, v_action, v_score, v_publish;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

CREATE INDEX IF NOT EXISTS source_records_source_external_idx
  ON public.source_records(data_source_id, external_identifier)
  WHERE external_identifier IS NOT NULL;
