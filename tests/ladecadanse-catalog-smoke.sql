do $smoke$
declare
  source_id uuid;
  created_venue_id uuid;
  created_place_id uuid;
  created_venue_slug text;
  created_event_id uuid;
  linked_venue_id uuid;
  worker_id uuid := '90000000-0000-4000-8000-000000000001';
  claimed_id uuid;
  queue_status jsonb;
  venue_detail jsonb;
  place_detail jsonb;
  media_count integer;
  source_count integer;
  event_result record;
begin
  select source.id into source_id
  from public.data_sources source
  where source.domain = 'www.ladecadanse.ch'
    and source.status = 'active'
    and source.is_authorized = true
    and source.is_verified = true
  order by source.priority, source.id
  limit 1;

  if source_id is null then
    raise exception 'La Décadanse source was not upgraded to the current host';
  end if;

  perform public.enqueue_ladecadanse_sync_items_v1(
    jsonb_build_array(
      jsonb_build_object(
        'kind', 'event',
        'url', 'https://www.ladecadanse.ch/event/evenement.php?idE=999990',
        'external_identifier', '999990',
        'priority', 1
      )
    )
  );

  select claim.id into claimed_id
  from public.claim_ladecadanse_sync_items_v1(worker_id, 1, 180) claim
  limit 1;

  if claimed_id is null then
    raise exception 'La Décadanse queue did not claim a pending item';
  end if;

  if not public.complete_ladecadanse_sync_item_v1(
    claimed_id,
    worker_id,
    jsonb_build_object('smoke', true)
  ) then
    raise exception 'La Décadanse queue item could not be completed';
  end if;

  select result.venue_id, result.place_id, venue.slug
    into created_venue_id, created_place_id, created_venue_slug
  from public.upsert_ingested_venue_v1(
    source_id,
    jsonb_build_object(
      'external_identifier', '999991',
      'source_url', 'https://www.ladecadanse.ch/lieu/lieu.php?idL=999991',
      'name', 'La Décadanse smoke venue',
      'types', jsonb_build_array('théâtre', 'salle de concert'),
      'category', 'culture',
      'subcategory', 'theatre',
      'description', 'A complete venue created by the disposable migration smoke test.',
      'address', '99 rue du Test, 1205 Genève',
      'postal_code', '1205',
      'website', 'https://example.org/smoke-venue',
      'latitude', 46.1988,
      'longitude', 6.1452,
      'image_url', 'https://upload.wikimedia.org/smoke-venue.jpg',
      'media', jsonb_build_array(
        jsonb_build_object(
          'url', 'https://upload.wikimedia.org/smoke-venue.jpg',
          'media_type', 'image',
          'attribution', 'Smoke photographer',
          'license', 'CC BY-SA 4.0',
          'source_url', 'https://commons.wikimedia.org/wiki/File:Smoke_venue.jpg',
          'provider', 'wikimedia_commons',
          'sort_order', 0,
          'is_primary', true
        )
      ),
      'quality_score', 96,
      'tags', jsonb_build_object('smoke', true)
    )
  ) result
  join public.venues venue on venue.id = result.venue_id
  limit 1;

  if created_venue_id is null or created_place_id is null or created_venue_slug is null then
    raise exception 'Venue upsert did not create both venue and map place records';
  end if;

  select count(*) into source_count
  from public.venue_sources source
  where source.venue_id = created_venue_id
    and source.domain = 'www.ladecadanse.ch'
    and source.external_identifier = '999991';

  select count(*) into media_count
  from public.venue_media media
  where media.venue_id = created_venue_id
    and media.license = 'CC BY-SA 4.0'
    and media.attribution = 'Smoke photographer';

  if source_count <> 1 or media_count <> 1 then
    raise exception 'Venue source/media attribution was not persisted';
  end if;

  select * into event_result
  from public.upsert_ingested_event_v2(
    source_id,
    jsonb_build_object(
      'source_url', 'https://www.ladecadanse.ch/event/evenement.php?idE=999992',
      'external_identifier', '999992',
      'title', 'La Décadanse smoke event',
      'description', 'A future public event linked to the smoke venue.',
      'starts_at', '2035-08-07T20:00:00+02:00',
      'ends_at', '2035-08-07T22:00:00+02:00',
      'timezone', 'Europe/Zurich',
      'time_precision', 'exact',
      'all_day', false,
      'venue_name', 'La Décadanse smoke venue',
      'venue_url', 'https://www.ladecadanse.ch/lieu/lieu.php?idL=999991',
      'address', '99 rue du Test, 1205 Genève',
      'postal_code', '1205',
      'city', 'Genève',
      'country_code', 'CH',
      'latitude', 46.1988,
      'longitude', 6.1452,
      'language', 'fr',
      'category', 'concerts',
      'genres', jsonb_build_array('jazz'),
      'price_min', 20,
      'price_max', 20,
      'currency', 'CHF',
      'ticket_url', 'https://tickets.example.org/smoke-event',
      'ticket_status', 'available',
      'image_url', 'https://www.ladecadanse.ch/media/smoke-event.jpg',
      'quality_score', 100,
      'extraction_method', 'html'
    )
  );

  created_event_id := event_result.event_id;
  if created_event_id is null then
    raise exception 'Normalized event upsert returned no event id';
  end if;

  linked_venue_id := public.link_event_to_venue_source_v1(
    created_event_id,
    'www.ladecadanse.ch',
    '999991'
  );
  if linked_venue_id is distinct from created_venue_id then
    raise exception 'Event was not linked through the exact venue source identity';
  end if;

  update public.events
  set status = 'published', is_demo = false
  where id = created_event_id;

  venue_detail := public.get_venue_detail_v1(created_venue_slug)::jsonb;
  place_detail := public.get_place_detail_v1(created_place_id)::jsonb;

  if venue_detail is null
    or venue_detail = 'null'::jsonb
    or venue_detail->>'id' <> created_venue_id::text
    or jsonb_array_length(venue_detail->'media') <> 1
    or jsonb_array_length(venue_detail->'sources') <> 1
    or jsonb_array_length(venue_detail->'upcoming_events') <> 1
  then
    raise exception 'Venue detail RPC is missing media, sources or upcoming events';
  end if;

  if place_detail is null
    or place_detail = 'null'::jsonb
    or place_detail->>'venue_id' <> created_venue_id::text
    or place_detail->>'venue_slug' <> created_venue_slug
    or jsonb_array_length(place_detail->'upcoming_events') <> 1
  then
    raise exception 'Place detail RPC does not expose its venue event tab';
  end if;

  queue_status := public.ladecadanse_sync_status_v1()::jsonb;
  if coalesce((queue_status->>'completed')::integer, 0) < 1 then
    raise exception 'La Décadanse queue status did not record completion';
  end if;
end;
$smoke$;
