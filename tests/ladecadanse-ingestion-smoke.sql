do $smoke$
declare
  context record;
  seeded jsonb;
  venue_result record;
  event_result record;
  upcoming jsonb;
  test_external_id text := '9223372036854775000';
  test_event_external_id text := '9223372036854775';
  test_venue_name text := 'GlobalParty La Décadanse Smoke Venue';
  test_event_title text := 'GlobalParty La Décadanse Smoke Event';
  starts_at_value timestamptz := date_trunc('hour', now()) + interval '7 days';
  ends_at_value timestamptz := date_trunc('hour', now()) + interval '7 days 3 hours';
  media_count integer;
  source_count integer;
  place_count integer;
begin
  if to_regprocedure('public.ladecadanse_source_context_v1()') is null
    or to_regprocedure('public.seed_ladecadanse_discovery_v1(integer,boolean)') is null
    or to_regprocedure('public.claim_ladecadanse_jobs_v1(uuid,integer,integer)') is null
    or to_regprocedure('public.upsert_ladecadanse_venue_v1(uuid,jsonb)') is null
    or to_regprocedure('public.sync_event_venue_place_v1(uuid)') is null
    or to_regprocedure('public.get_place_upcoming_events_v1(uuid,integer,integer)') is null
  then
    raise exception 'La Décadanse RPC contract is incomplete';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.upsert_ladecadanse_venue_v1(uuid,jsonb)'::regprocedure,
      'EXECUTE'
    )
    or not has_function_privilege(
      'anon',
      'public.get_place_upcoming_events_v1(uuid,integer,integer)'::regprocedure,
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.get_place_upcoming_events_v1(uuid,integer,integer)'::regprocedure,
      'EXECUTE'
    )
  then
    raise exception 'La Décadanse function permissions are incomplete';
  end if;

  select * into context from public.ladecadanse_source_context_v1();
  if context.source_id is null
    or context.city_id is null
    or context.country_code <> 'CH'
  then
    raise exception 'La Décadanse canonical source context is unavailable';
  end if;

  if not exists (
    select 1
    from public.data_sources as source
    where source.id = context.source_id
      and source.domain = 'www.ladecadanse.ch'
      and source.base_url = 'https://www.ladecadanse.ch/'
      and source.metadata->>'adapter' = 'ladecadanse_v1'
      and (source.metadata->>'crawl_delay_seconds')::integer = 15
  ) then
    raise exception 'La Décadanse data source was not upgraded to the deterministic adapter';
  end if;

  seeded := public.seed_ladecadanse_discovery_v1(7, false);
  if coalesce((seeded->>'ok')::boolean, false) is not true
    or not exists (
      select 1
      from private.ladecadanse_crawl_jobs as job
      where job.job_kind = 'venue_directory'
        and job.canonical_url = 'https://www.ladecadanse.ch/lieu/'
    )
    or not exists (
      select 1
      from private.ladecadanse_crawl_jobs as job
      where job.job_kind = 'agenda'
        and job.canonical_url like 'https://www.ladecadanse.ch/index.php?courant=%'
    )
  then
    raise exception 'La Décadanse exhaustive seed queue is malformed';
  end if;

  select * into venue_result
  from public.upsert_ladecadanse_venue_v1(
    context.source_id,
    jsonb_build_object(
      'external_id', test_external_id,
      'source_url', 'https://www.ladecadanse.ch/lieu/lieu.php?idL=' || test_external_id,
      'name', test_venue_name,
      'category', 'culture',
      'subcategory', 'nightlife-community-venue',
      'description', 'A deterministic source-specific smoke venue with a complete public description.',
      'address', 'Rue du Test 42, 1205 Genève',
      'postal_code', '1205',
      'city', 'Genève',
      'country_code', 'CH',
      'latitude', 46.1984,
      'longitude', 6.1382,
      'website', 'https://venue.example.test/',
      'opening_hours', 'Jeudi à samedi, 18h00 - 05h00',
      'booking_url', 'https://venue.example.test/reservations',
      'image_urls', jsonb_build_array('https://images.example.test/venue.jpg'),
      'media', jsonb_build_array(
        jsonb_build_object(
          'url', 'https://images.example.test/venue.jpg',
          'thumbnail_url', 'https://images.example.test/venue-small.jpg',
          'attribution', 'Smoke photographer',
          'license', 'CC BY 4.0',
          'license_url', 'https://creativecommons.org/licenses/by/4.0/',
          'creator', 'Smoke photographer',
          'source_url', 'https://commons.wikimedia.org/wiki/File:Smoke.jpg',
          'source_provider', 'wikimedia_commons',
          'is_fallback', true
        )
      ),
      'source_urls', jsonb_build_array(
        'https://www.ladecadanse.ch/lieu/lieu.php?idL=' || test_external_id,
        'https://venue.example.test/'
      ),
      'content_sources', jsonb_build_array(
        jsonb_build_object(
          'label', 'La Décadanse — smoke venue',
          'url', 'https://www.ladecadanse.ch/lieu/lieu.php?idL=' || test_external_id,
          'provider', 'ladecadanse'
        )
      ),
      'quality_score', 96
    )
  );

  if venue_result.venue_id is null or venue_result.place_id is null then
    raise exception 'venue upsert did not create both canonical venue and map place';
  end if;

  select count(*) into source_count
  from public.venue_sources
  where venue_id = venue_result.venue_id
    and source_provider = 'ladecadanse'
    and external_identifier = test_external_id;
  select count(*) into media_count
  from public.venue_media
  where venue_id = venue_result.venue_id
    and source_provider = 'wikimedia_commons'
    and license = 'CC BY 4.0';
  select count(*) into place_count
  from public.places_of_interest
  where id = venue_result.place_id
    and venue_id = venue_result.venue_id
    and cardinality(image_urls) = 1
    and booking_url = 'https://venue.example.test/reservations';

  if source_count <> 1 or media_count <> 1 or place_count <> 1 then
    raise exception 'venue source/media/place persistence is incomplete';
  end if;

  select * into event_result
  from public.upsert_ingested_event_serial_v1(
    context.source_id,
    jsonb_build_object(
      'external_identifier', test_event_external_id,
      'source_url', 'https://www.ladecadanse.ch/event/evenement.php?idE=' || test_event_external_id,
      'title', test_event_title,
      'description', 'A complete future event linked to the canonical smoke venue.',
      'starts_at', starts_at_value,
      'ends_at', ends_at_value,
      'timezone', 'Europe/Zurich',
      'time_precision', 'exact',
      'all_day', false,
      'venue_name', test_venue_name,
      'venue_url', 'https://www.ladecadanse.ch/lieu/lieu.php?idL=' || test_external_id,
      'address', 'Rue du Test 42, 1205 Genève',
      'postal_code', '1205',
      'city', 'Genève',
      'country_code', 'CH',
      'latitude', 46.1984,
      'longitude', 6.1382,
      'status', 'scheduled',
      'language', 'fr',
      'category', 'concerts',
      'genres', jsonb_build_array('electro'),
      'ticket_url', 'https://tickets.example.test/smoke-event',
      'is_free', false,
      'quality_score', 95,
      'extraction_method', 'ladecadanse_microformat_v1'
    )
  );

  if event_result.event_id is null then
    raise exception 'event upsert did not return an event';
  end if;

  perform public.sync_event_venue_place_v1(event_result.event_id);
  upcoming := public.get_place_upcoming_events_v1(venue_result.place_id, 10, 0)::jsonb;
  if coalesce((upcoming->>'total_count')::integer, 0) < 1
    or not exists (
      select 1
      from jsonb_array_elements(upcoming->'items') as item
      where item->>'event_id' = event_result.event_id::text
        and item->>'title' = test_event_title
    )
  then
    raise exception 'venue upcoming-events tab cannot resolve the linked event';
  end if;

  delete from public.events where id = event_result.event_id;
  delete from public.places_of_interest where id = venue_result.place_id;
  delete from public.venues where id = venue_result.venue_id;
end;
$smoke$;
