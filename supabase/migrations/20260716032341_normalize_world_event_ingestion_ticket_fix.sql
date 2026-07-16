-- Keep the scraper payload aligned with the normalized catalog. Geography,
-- organizers, venues, occurrences, tickets, media and performers are written
-- in the same transaction instead of being patched by the collector later.

CREATE OR REPLACE FUNCTION public.upsert_ingested_event_v2(
  _data_source_id UUID,
  _payload JSONB
)
RETURNS TABLE(event_id UUID, action TEXT, score INT, published BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_source public.data_sources%ROWTYPE;
  v_effective_source public.data_sources%ROWTYPE;
  v_result RECORD;
  v_country_id UUID;
  v_region_id UUID;
  v_city_id UUID;
  v_organizer_id UUID;
  v_venue_id UUID;
  v_performer_id UUID;
  v_country_code TEXT := upper(nullif(trim(_payload->>'country_code'), ''));
  v_country_name TEXT := nullif(trim(_payload->>'country_name'), '');
  v_region_name TEXT := nullif(left(trim(_payload->>'region'), 180), '');
  v_city_name TEXT := nullif(left(trim(_payload->>'city'), 180), '');
  v_timezone TEXT := nullif(trim(_payload->>'timezone'), '');
  v_city_slug TEXT;
  v_slug TEXT;
  v_genres TEXT[] := ARRAY[]::TEXT[];
  v_status TEXT := lower(coalesce(nullif(_payload->>'status', ''), 'scheduled'));
  v_time_precision TEXT := lower(coalesce(nullif(_payload->>'time_precision', ''), 'exact'));
  v_ticket_status TEXT := lower(coalesce(nullif(_payload->>'ticket_status', ''), 'unknown'));
  v_quality_score INT := greatest(0, least(100, coalesce((_payload->>'quality_score')::INT, 0)));
  v_capacity INT;
  v_price_min NUMERIC;
  v_price_max NUMERIC;
  v_currency TEXT := upper(nullif(trim(_payload->>'currency'), ''));
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
  v_item JSONB;
BEGIN
  IF jsonb_typeof(_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT * INTO v_source
  FROM public.data_sources
  WHERE id = _data_source_id
    AND status = 'active'
    AND is_authorized
    AND is_verified;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_not_authorized';
  END IF;

  BEGIN v_latitude := (_payload->>'latitude')::DOUBLE PRECISION; EXCEPTION WHEN OTHERS THEN v_latitude := NULL; END;
  BEGIN v_longitude := (_payload->>'longitude')::DOUBLE PRECISION; EXCEPTION WHEN OTHERS THEN v_longitude := NULL; END;
  BEGIN v_capacity := greatest(1, (_payload->>'capacity')::INT); EXCEPTION WHEN OTHERS THEN v_capacity := NULL; END;
  BEGIN v_price_min := greatest(0, (_payload->>'price_min')::NUMERIC); EXCEPTION WHEN OTHERS THEN v_price_min := NULL; END;
  BEGIN v_price_max := greatest(0, (_payload->>'price_max')::NUMERIC); EXCEPTION WHEN OTHERS THEN v_price_max := NULL; END;

  IF v_country_code !~ '^[A-Z]{2}$' THEN
    SELECT upper(country.code), country.name
      INTO v_country_code, v_country_name
    FROM public.cities city
    JOIN public.countries country ON country.id = city.country_id
    WHERE city.id = v_source.city_id;
  END IF;

  IF v_country_code ~ '^[A-Z]{2}$' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('country|' || v_country_code, 0));
    INSERT INTO public.countries(code, name)
    VALUES (v_country_code, coalesce(v_country_name, v_country_code))
    ON CONFLICT (code) DO UPDATE SET
      name = CASE WHEN public.countries.name = public.countries.code AND EXCLUDED.name <> EXCLUDED.code
        THEN EXCLUDED.name ELSE public.countries.name END
    RETURNING id INTO v_country_id;
  END IF;

  IF v_country_id IS NOT NULL AND v_region_name IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('region|' || v_country_id || '|' || public.unaccent(lower(v_region_name)), 0));
    SELECT id INTO v_region_id FROM public.regions
    WHERE country_id = v_country_id AND public.unaccent(lower(name)) = public.unaccent(lower(v_region_name))
    LIMIT 1;
    IF v_region_id IS NULL THEN
      INSERT INTO public.regions(country_id, name) VALUES (v_country_id, v_region_name)
      RETURNING id INTO v_region_id;
    END IF;
  END IF;

  IF v_country_id IS NOT NULL AND v_city_name IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('city|' || v_country_id || '|' || public.unaccent(lower(v_city_name)), 0));
    SELECT id INTO v_city_id FROM public.cities
    WHERE country_id = v_country_id AND public.unaccent(lower(name)) = public.unaccent(lower(v_city_name))
    ORDER BY (region_id = v_region_id) DESC NULLS LAST
    LIMIT 1;

    IF v_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_timezone) THEN
      SELECT timezone INTO v_timezone FROM public.cities WHERE id = v_source.city_id;
      v_timezone := coalesce(v_timezone, 'UTC');
    END IF;
    IF v_city_id IS NULL THEN
      v_city_slug := left(trim(both '-' from regexp_replace(
        public.unaccent(lower(v_city_name || '-' || v_country_code)), '[^a-z0-9]+', '-', 'g'
      )), 120);
      INSERT INTO public.cities(country_id, region_id, slug, name, timezone, latitude, longitude, location)
      VALUES (
        v_country_id, v_region_id, v_city_slug, v_city_name, v_timezone,
        v_latitude, v_longitude,
        CASE WHEN v_latitude BETWEEN -90 AND 90 AND v_longitude BETWEEN -180 AND 180
          THEN extensions.st_setsrid(extensions.st_makepoint(v_longitude, v_latitude), 4326)::extensions.geography END
      )
      ON CONFLICT (slug) DO UPDATE SET
        region_id = coalesce(public.cities.region_id, EXCLUDED.region_id),
        latitude = coalesce(public.cities.latitude, EXCLUDED.latitude),
        longitude = coalesce(public.cities.longitude, EXCLUDED.longitude),
        location = coalesce(public.cities.location, EXCLUDED.location)
      RETURNING id INTO v_city_id;
    ELSE
      UPDATE public.cities SET
        region_id = coalesce(region_id, v_region_id),
        latitude = coalesce(latitude, v_latitude),
        longitude = coalesce(longitude, v_longitude)
      WHERE id = v_city_id;
    END IF;
  ELSE
    v_city_id := v_source.city_id;
  END IF;

  -- Multi-city feeds get a stable city-scoped source. This preserves the
  -- existing ingestion function's city-distance safeguards and fingerprints.
  v_effective_source := v_source;
  IF v_city_id IS NOT NULL AND v_city_id IS DISTINCT FROM v_source.city_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('source-city|' || v_source.id || '|' || v_city_id, 0));
    SELECT * INTO v_effective_source FROM public.data_sources
    WHERE city_id = v_city_id AND metadata->>'parent_source_id' = v_source.id::TEXT
    LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO public.data_sources(
        organizer_id, venue_id, name, source_type, base_url, domain,
        is_authorized, is_verified, sync_frequency, status, legal_basis,
        city_id, category_slug, page_count, priority, metadata
      ) VALUES (
        v_source.organizer_id, v_source.venue_id,
        left(v_source.name || ' — ' || v_city_name, 240), v_source.source_type,
        v_source.base_url, v_source.domain, v_source.is_authorized, v_source.is_verified,
        v_source.sync_frequency, 'active', v_source.legal_basis, v_city_id,
        v_source.category_slug, v_source.page_count, v_source.priority,
        v_source.metadata || jsonb_build_object('parent_source_id', v_source.id, 'derived_city_source', true)
      ) RETURNING * INTO v_effective_source;
    END IF;
  END IF;

  SELECT * INTO v_result FROM public.upsert_ingested_event(
    v_effective_source.id,
    _payload->>'source_url',
    _payload->>'title',
    _payload->>'description',
    (_payload->>'starts_at')::TIMESTAMPTZ,
    nullif(_payload->>'ends_at', '')::TIMESTAMPTZ,
    _payload->>'venue_name',
    _payload->>'address',
    v_latitude,
    v_longitude,
    _payload->>'category',
    _payload->>'ticket_url',
    _payload->>'image_url',
    coalesce((_payload->>'is_free')::BOOLEAN, false),
    _payload->>'external_identifier'
  );

  IF jsonb_typeof(_payload->'genres') = 'array' THEN
    SELECT coalesce(array_agg(DISTINCT left(lower(trim(value)), 60)) FILTER (WHERE trim(value) <> ''), ARRAY[]::TEXT[])
    INTO v_genres FROM jsonb_array_elements_text(_payload->'genres');
  END IF;

  IF nullif(trim(_payload->>'organizer_name'), '') IS NOT NULL THEN
    v_slug := left(trim(both '-' from regexp_replace(public.unaccent(lower(_payload->>'organizer_name')), '[^a-z0-9]+', '-', 'g'))
      || '-' || substr(encode(extensions.digest(coalesce(v_country_code, '') || '|' || lower(_payload->>'organizer_name'), 'sha256'), 'hex'), 1, 8), 120);
    INSERT INTO public.organizers(slug, name, website, is_verified, verification_level)
    VALUES (v_slug, left(trim(_payload->>'organizer_name'), 180), nullif(_payload->>'organizer_url', ''), v_source.is_verified,
      CASE WHEN v_source.is_verified THEN 'partner'::public.verification_level ELSE 'unverified'::public.verification_level END)
    ON CONFLICT (slug) DO UPDATE SET website = coalesce(public.organizers.website, EXCLUDED.website)
    RETURNING id INTO v_organizer_id;
  END IF;

  UPDATE public.events SET
    organizer_id = coalesce(organizer_id, v_organizer_id),
    genres = CASE WHEN cardinality(v_genres) > 0 THEN ARRAY(SELECT DISTINCT unnest(coalesce(genres, ARRAY[]::TEXT[]) || v_genres)) ELSE genres END,
    language = CASE WHEN coalesce(language, '', 'und') IN ('', 'und') AND (_payload->>'language') ~ '^[a-zA-Z]{2,8}$'
      THEN lower(_payload->>'language') ELSE language END,
    age_restriction = coalesce(age_restriction, nullif(left(_payload->>'age_restriction', 80), '')),
    quality_score = greatest(quality_score, v_quality_score)
  WHERE id = v_result.event_id;

  SELECT venue_id INTO v_venue_id FROM public.events WHERE id = v_result.event_id;
  IF v_venue_id IS NOT NULL THEN
    UPDATE public.venues SET
      city_id = coalesce(city_id, v_city_id), country_id = coalesce(country_id, v_country_id),
      postal_code = coalesce(postal_code, nullif(left(_payload->>'postal_code', 40), '')),
      website = coalesce(website, nullif(_payload->>'venue_url', '')),
      capacity = coalesce(capacity, v_capacity), cover_image_url = coalesce(cover_image_url, nullif(_payload->>'image_url', ''))
    WHERE id = v_venue_id;
  END IF;

  UPDATE public.event_occurrences SET
    timezone = v_timezone,
    time_precision = CASE WHEN v_time_precision IN ('exact','date','tbd','unknown') THEN v_time_precision ELSE 'unknown' END,
    all_day = coalesce((_payload->>'all_day')::BOOLEAN, false),
    capacity = coalesce(capacity, v_capacity),
    status = CASE WHEN v_status IN ('cancelled','postponed','sold_out') THEN v_status::public.occurrence_status ELSE status END,
    ticket_status = CASE WHEN v_ticket_status IN ('unknown','available','limited','sold_out','free','on_sale_soon')
      THEN v_ticket_status::public.ticket_status ELSE ticket_status END
  WHERE event_id = v_result.event_id AND starts_at = (_payload->>'starts_at')::TIMESTAMPTZ;

  UPDATE public.ticket_offers SET
    price_min = coalesce(price_min, v_price_min, v_price_max),
    price_max = coalesce(price_max, v_price_max, v_price_min),
    currency = coalesce(v_currency, currency),
    status = CASE WHEN v_ticket_status IN ('available','limited','sold_out','free','on_sale_soon')
      THEN v_ticket_status::public.ticket_status ELSE status END
  WHERE id = (SELECT id FROM public.ticket_offers WHERE event_id = v_result.event_id ORDER BY id LIMIT 1);
  IF NOT FOUND AND (v_price_min IS NOT NULL OR v_price_max IS NOT NULL OR nullif(_payload->>'ticket_url', '') IS NOT NULL) THEN
    INSERT INTO public.ticket_offers(event_id, name, price_min, price_max, currency, is_free, ticket_url, status)
    VALUES (
      v_result.event_id, 'Billetterie officielle', coalesce(v_price_min, v_price_max),
      coalesce(v_price_max, v_price_min), coalesce(v_currency, 'EUR'), false,
      nullif(_payload->>'ticket_url', ''),
      CASE WHEN v_ticket_status IN ('available','limited','sold_out','on_sale_soon')
        THEN v_ticket_status::public.ticket_status ELSE 'unknown'::public.ticket_status END
    );
  END IF;

  IF nullif(_payload->>'image_url', '') ~ '^https?://' THEN
    INSERT INTO public.event_media(event_id, url, media_type, attribution, license, source_url, sort_order)
    SELECT v_result.event_id, left(_payload->>'image_url', 1000), 'image', nullif(_payload->>'image_attribution', ''),
      nullif(_payload->>'license', ''), _payload->>'source_url', 0
    WHERE NOT EXISTS (SELECT 1 FROM public.event_media WHERE event_id=v_result.event_id AND url=left(_payload->>'image_url',1000));
  END IF;

  IF jsonb_typeof(_payload->'performers') = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(_payload->'performers') LOOP
      IF nullif(trim(v_item->>'name'), '') IS NOT NULL THEN
        v_slug := left(trim(both '-' from regexp_replace(public.unaccent(lower(v_item->>'name')), '[^a-z0-9]+', '-', 'g'))
          || '-' || substr(encode(extensions.digest(lower(v_item->>'name'), 'sha256'), 'hex'), 1, 8), 120);
        INSERT INTO public.performers(slug, name, type, image_url)
        VALUES (v_slug, left(trim(v_item->>'name'),180), nullif(left(v_item->>'type',80),''), nullif(v_item->>'image_url',''))
        ON CONFLICT (slug) DO UPDATE SET image_url=coalesce(public.performers.image_url,EXCLUDED.image_url)
        RETURNING id INTO v_performer_id;
        INSERT INTO public.event_performers(event_id, performer_id, is_headliner)
        VALUES (v_result.event_id, v_performer_id, coalesce((v_item->>'is_headliner')::BOOLEAN,false))
        ON CONFLICT (event_id, performer_id) DO UPDATE SET is_headliner=public.event_performers.is_headliner OR EXCLUDED.is_headliner;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(_payload->'accessibility') = 'object' THEN
    INSERT INTO public.event_accessibility(event_id,wheelchair,hearing_loop,sign_language,quiet_space,notes)
    VALUES (v_result.event_id, coalesce((_payload#>>'{accessibility,wheelchair}')::BOOLEAN,false),
      coalesce((_payload#>>'{accessibility,hearing_loop}')::BOOLEAN,false),
      coalesce((_payload#>>'{accessibility,sign_language}')::BOOLEAN,false),
      coalesce((_payload#>>'{accessibility,quiet_space}')::BOOLEAN,false),
      nullif(_payload#>>'{accessibility,notes}',''))
    ON CONFLICT (event_id) DO UPDATE SET
      wheelchair=public.event_accessibility.wheelchair OR EXCLUDED.wheelchair,
      hearing_loop=public.event_accessibility.hearing_loop OR EXCLUDED.hearing_loop,
      sign_language=public.event_accessibility.sign_language OR EXCLUDED.sign_language,
      quiet_space=public.event_accessibility.quiet_space OR EXCLUDED.quiet_space,
      notes=coalesce(public.event_accessibility.notes,EXCLUDED.notes);
  END IF;

  UPDATE public.source_records SET
    raw_json = coalesce(raw_json, _payload),
    extracted_data = coalesce(extracted_data, '{}'::JSONB) || jsonb_build_object(
      'event_id', v_result.event_id, 'normalized_payload', _payload,
      'schema_version', 3, 'root_source_id', v_source.id
    )
  WHERE id = (
    SELECT id FROM public.source_records
    WHERE data_source_id=v_effective_source.id AND extracted_data->>'event_id'=v_result.event_id::TEXT
    ORDER BY processed_at DESC NULLS LAST LIMIT 1
  );

  RETURN QUERY SELECT v_result.event_id, v_result.action, v_result.score, v_result.published;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) TO service_role;

COMMENT ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) IS
  'Atomically normalizes a rich scraper payload into geography, venue, organizer, event, occurrence, ticket, media, performer and source-record tables.';

