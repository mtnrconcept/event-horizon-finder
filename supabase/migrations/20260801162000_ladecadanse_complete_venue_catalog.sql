-- Complete, resumable ingestion for La Décadanse without duplicating the global
-- discovery catalog. Events continue through the normalized event upsert while
-- source venues are first-class places with attributed media and event tabs.

insert into public.source_domains(domain, is_authorized, authorized_at, notes)
values (
  'www.ladecadanse.ch',
  true,
  now(),
  'Agenda culturel public genevois. Collecte limitée aux faits publics, liens sources et médias attribués.'
)
on conflict (domain) do update set
  is_authorized = excluded.is_authorized,
  authorized_at = coalesce(public.source_domains.authorized_at, excluded.authorized_at),
  notes = excluded.notes;

update public.data_sources
set base_url = 'https://www.ladecadanse.ch/',
    domain = 'www.ladecadanse.ch',
    page_count = 1,
    priority = least(priority, 12),
    sync_frequency = 'daily',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'adapter', 'ladecadanse-v1',
      'direct_exact_host', true,
      'venue_catalog_url', 'https://www.ladecadanse.ch/lieu/lieux.php',
      'venue_catalog_pages', 4,
      'event_path', '/event/evenement.php',
      'venue_path', '/lieu/lieu.php',
      'licensed_media_fallback', 'wikimedia_commons',
      'facts_and_attributed_media_only', true
    ),
    updated_at = now()
where name = 'La Décadanse Genève'
   or domain in ('ladecadanse.darksite.ch', 'www.ladecadanse.ch');

create table if not exists public.venue_sources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  data_source_id uuid references public.data_sources(id) on delete set null,
  domain text not null,
  external_identifier text not null,
  source_url text not null,
  source_name text,
  attribution text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(domain, external_identifier),
  unique(venue_id, source_url)
);

create index if not exists venue_sources_venue_idx
  on public.venue_sources(venue_id, last_seen_at desc);
create index if not exists venue_sources_data_source_idx
  on public.venue_sources(data_source_id, last_seen_at desc)
  where data_source_id is not null;

create table if not exists public.venue_media (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  url text not null,
  media_type text not null default 'image' check (media_type in ('image', 'logo')),
  attribution text,
  license text,
  source_url text,
  provider text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(venue_id, url)
);

create index if not exists venue_media_venue_sort_idx
  on public.venue_media(venue_id, is_primary desc, sort_order, created_at);

drop trigger if exists trg_venue_media_updated on public.venue_media;
create trigger trg_venue_media_updated
  before update on public.venue_media
  for each row execute function public.set_updated_at();

alter table public.venue_sources enable row level security;
alter table public.venue_media enable row level security;

drop policy if exists venue_sources_public_read on public.venue_sources;
create policy venue_sources_public_read
  on public.venue_sources for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.venues venue
      where venue.id = venue_sources.venue_id
        and venue.is_public = true
        and venue.is_demo = false
    )
  );

drop policy if exists venue_media_public_read on public.venue_media;
create policy venue_media_public_read
  on public.venue_media for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.venues venue
      where venue.id = venue_media.venue_id
        and venue.is_public = true
        and venue.is_demo = false
    )
  );

revoke all on public.venue_sources from anon, authenticated;
revoke all on public.venue_media from anon, authenticated;
grant select on public.venue_sources to anon, authenticated;
grant select on public.venue_media to anon, authenticated;

create table if not exists private.ladecadanse_sync_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('agenda', 'venue_catalog', 'venue', 'event')),
  source_url text not null unique,
  external_identifier text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by uuid,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ladecadanse_sync_queue_claim_idx
  on private.ladecadanse_sync_queue(status, available_at, priority, discovered_at)
  where status in ('pending', 'failed');

create or replace function private.ladecadanse_slug(value text, suffix text default null)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    trim(both '-' from regexp_replace(public.unaccent(lower(coalesce(value, 'lieu'))), '[^a-z0-9]+', '-', 'g'))
    || case when nullif(suffix, '') is null then '' else '-' || suffix end,
    120
  );
$$;

create or replace function public.enqueue_ladecadanse_sync_items_v1(_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
declare
  item jsonb;
  inserted_count integer := 0;
  item_url text;
  item_kind text;
  item_external_id text;
begin
  if jsonb_typeof(_items) <> 'array' then
    raise exception 'invalid_items';
  end if;

  for item in select value from jsonb_array_elements(_items)
  loop
    item_url := nullif(left(trim(item->>'url'), 1000), '');
    item_kind := lower(nullif(trim(item->>'kind'), ''));
    item_external_id := nullif(left(trim(item->>'external_identifier'), 180), '');
    if item_url is null
       or item_url !~ '^https://www\.ladecadanse\.ch/'
       or item_kind not in ('agenda', 'venue_catalog', 'venue', 'event') then
      continue;
    end if;

    insert into private.ladecadanse_sync_queue(
      kind, source_url, external_identifier, status, priority,
      available_at, last_seen_at, metadata
    ) values (
      item_kind,
      item_url,
      item_external_id,
      'pending',
      greatest(1, least(1000, coalesce((item->>'priority')::integer, 100))),
      now(),
      now(),
      coalesce(item->'metadata', '{}'::jsonb)
    )
    on conflict (source_url) do update set
      kind = excluded.kind,
      external_identifier = coalesce(excluded.external_identifier, private.ladecadanse_sync_queue.external_identifier),
      last_seen_at = now(),
      metadata = private.ladecadanse_sync_queue.metadata || excluded.metadata,
      status = case
        when private.ladecadanse_sync_queue.status = 'processing' then 'processing'
        else 'pending'
      end,
      available_at = case
        when private.ladecadanse_sync_queue.status = 'processing'
          then private.ladecadanse_sync_queue.available_at
        else now()
      end,
      last_error = case
        when private.ladecadanse_sync_queue.status = 'processing'
          then private.ladecadanse_sync_queue.last_error
        else null
      end;
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end;
$$;

create or replace function public.claim_ladecadanse_sync_items_v1(
  _worker_id uuid,
  _limit integer default 4,
  _lease_seconds integer default 180
)
returns table(
  id uuid,
  kind text,
  source_url text,
  external_identifier text,
  attempt_count integer,
  max_attempts integer,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
begin
  update private.ladecadanse_sync_queue queue
  set status = 'pending',
      locked_at = null,
      locked_by = null,
      available_at = now(),
      last_error = coalesce(queue.last_error, 'lease_expired')
  where queue.status = 'processing'
    and queue.locked_at < now() - make_interval(secs => greatest(30, least(900, _lease_seconds)));

  return query
  with selected as (
    select queue.id
    from private.ladecadanse_sync_queue queue
    where queue.status in ('pending', 'failed')
      and queue.available_at <= now()
      and queue.attempt_count < queue.max_attempts
    order by queue.priority, queue.available_at, queue.discovered_at
    for update skip locked
    limit greatest(1, least(20, _limit))
  )
  update private.ladecadanse_sync_queue queue
  set status = 'processing',
      attempt_count = queue.attempt_count + 1,
      locked_at = now(),
      locked_by = _worker_id,
      last_error = null
  from selected
  where queue.id = selected.id
  returning queue.id, queue.kind, queue.source_url, queue.external_identifier,
            queue.attempt_count, queue.max_attempts, queue.metadata;
end;
$$;

create or replace function public.complete_ladecadanse_sync_item_v1(
  _item_id uuid,
  _worker_id uuid,
  _metadata jsonb default '{}'::jsonb
)
returns boolean
language sql
security definer
set search_path = ''
set row_security = 'off'
as $$
  with updated as (
    update private.ladecadanse_sync_queue queue
    set status = 'completed',
        processed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = null,
        metadata = queue.metadata || coalesce(_metadata, '{}'::jsonb)
    where queue.id = _item_id
      and queue.status = 'processing'
      and queue.locked_by = _worker_id
    returning 1
  )
  select exists(select 1 from updated);
$$;

create or replace function public.fail_ladecadanse_sync_item_v1(
  _item_id uuid,
  _worker_id uuid,
  _error text,
  _retry_after_seconds integer default 300,
  _terminal boolean default false
)
returns boolean
language sql
security definer
set search_path = ''
set row_security = 'off'
as $$
  with updated as (
    update private.ladecadanse_sync_queue queue
    set status = case
          when _terminal or queue.attempt_count >= queue.max_attempts then 'failed'
          else 'pending'
        end,
        available_at = case
          when _terminal or queue.attempt_count >= queue.max_attempts
            then now() + interval '365 days'
          else now() + make_interval(secs => greatest(30, least(86400, _retry_after_seconds)))
        end,
        locked_at = null,
        locked_by = null,
        last_error = left(coalesce(_error, 'unknown_error'), 1000)
    where queue.id = _item_id
      and queue.status = 'processing'
      and queue.locked_by = _worker_id
    returning 1
  )
  select exists(select 1 from updated);
$$;

create or replace function public.ladecadanse_sync_status_v1()
returns json
language sql
stable
security definer
set search_path = ''
set row_security = 'off'
as $$
  select json_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'processing', count(*) filter (where status = 'processing'),
    'completed', count(*) filter (where status = 'completed'),
    'failed', count(*) filter (where status = 'failed'),
    'events_pending', count(*) filter (where kind = 'event' and status in ('pending','processing')),
    'venues_pending', count(*) filter (where kind = 'venue' and status in ('pending','processing')),
    'last_processed_at', max(processed_at),
    'last_error', (array_agg(last_error order by available_at desc) filter (where last_error is not null))[1]
  )
  from private.ladecadanse_sync_queue;
$$;

create or replace function public.upsert_ingested_venue_v1(
  _data_source_id uuid,
  _payload jsonb
)
returns table(venue_id uuid, place_id uuid, action text)
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
#variable_conflict use_column
declare
  source public.data_sources%rowtype;
  city public.cities%rowtype;
  country_id uuid;
  resolved_venue_id uuid;
  resolved_place_id uuid;
  external_id text := nullif(left(trim(_payload->>'external_identifier'), 180), '');
  source_url text := nullif(left(trim(_payload->>'source_url'), 1000), '');
  venue_name text := nullif(left(trim(_payload->>'name'), 240), '');
  venue_description text := nullif(left(trim(_payload->>'description'), 8000), '');
  venue_address text := nullif(left(trim(_payload->>'address'), 500), '');
  venue_postal_code text := nullif(left(trim(_payload->>'postal_code'), 40), '');
  venue_website text := nullif(left(trim(_payload->>'website'), 1000), '');
  venue_category text := coalesce(nullif(left(trim(_payload->>'category'), 80), ''), 'culture');
  venue_subcategory text := nullif(left(trim(_payload->>'subcategory'), 120), '');
  venue_slug text;
  latitude double precision;
  longitude double precision;
  quality integer := greatest(0, least(100, coalesce((_payload->>'quality_score')::integer, 60)));
  media_item jsonb;
  image_urls text[] := array[]::text[];
  primary_image text;
  operation text := 'updated';
begin
  if jsonb_typeof(_payload) <> 'object' then raise exception 'invalid_payload'; end if;
  if external_id is null or source_url is null or venue_name is null then
    raise exception 'missing_venue_identity';
  end if;
  if source_url !~ '^https://www\.ladecadanse\.ch/lieu/lieu\.php\?idL=[0-9]+' then
    raise exception 'invalid_venue_source_url';
  end if;

  select * into source
  from public.data_sources
  where id = _data_source_id and status = 'active' and is_authorized and is_verified;
  if not found then raise exception 'source_not_authorized'; end if;

  select * into city from public.cities where id = source.city_id;
  if city.id is null then raise exception 'source_city_missing'; end if;
  country_id := city.country_id;

  begin latitude := (_payload->>'latitude')::double precision; exception when others then latitude := null; end;
  begin longitude := (_payload->>'longitude')::double precision; exception when others then longitude := null; end;
  if latitude not between -90 and 90 then latitude := null; end if;
  if longitude not between -180 and 180 then longitude := null; end if;

  select venue_source.venue_id into resolved_venue_id
  from public.venue_sources venue_source
  where venue_source.domain = 'www.ladecadanse.ch'
    and venue_source.external_identifier = external_id
  limit 1;

  if resolved_venue_id is null then
    select venue.id into resolved_venue_id
    from public.venues venue
    where venue.city_id = city.id
      and public.unaccent(lower(venue.name)) = public.unaccent(lower(venue_name))
      and (
        venue_address is null
        or venue.address is null
        or public.unaccent(lower(venue.address)) = public.unaccent(lower(venue_address))
      )
    order by (venue.address is not null) desc, venue.updated_at desc
    limit 1;
  end if;

  if jsonb_typeof(_payload->'media') = 'array' then
    select coalesce(array_agg(distinct value->>'url') filter (where value->>'url' ~ '^https?://'), array[]::text[])
      into image_urls
    from jsonb_array_elements(_payload->'media');
  end if;
  primary_image := nullif(_payload->>'image_url', '');
  if primary_image is null and cardinality(image_urls) > 0 then primary_image := image_urls[1]; end if;

  if resolved_venue_id is null then
    venue_slug := private.ladecadanse_slug(
      venue_name,
      substr(encode(extensions.digest('ladecadanse|' || external_id, 'sha256'), 'hex'), 1, 8)
    );
    insert into public.venues(
      slug, name, description, address, postal_code, city_id, country_id,
      latitude, longitude, location, website, cover_image_url,
      is_verified, is_public, is_demo
    ) values (
      venue_slug, venue_name, venue_description, venue_address, venue_postal_code,
      city.id, country_id, latitude, longitude,
      case when latitude is not null and longitude is not null
        then extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography end,
      venue_website, primary_image, source.is_verified, true, false
    )
    returning id into resolved_venue_id;
    operation := 'created';
  else
    update public.venues venue
    set name = case when length(venue_name) > length(venue.name) then venue_name else venue.name end,
        description = coalesce(venue.description, venue_description),
        address = coalesce(venue.address, venue_address),
        postal_code = coalesce(venue.postal_code, venue_postal_code),
        city_id = coalesce(venue.city_id, city.id),
        country_id = coalesce(venue.country_id, country_id),
        latitude = coalesce(venue.latitude, latitude),
        longitude = coalesce(venue.longitude, longitude),
        location = coalesce(
          venue.location,
          case when latitude is not null and longitude is not null
            then extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography end
        ),
        website = coalesce(venue.website, venue_website),
        cover_image_url = coalesce(venue.cover_image_url, primary_image),
        is_public = true,
        is_demo = false,
        updated_at = now()
    where venue.id = resolved_venue_id;
  end if;

  insert into public.venue_sources(
    venue_id, data_source_id, domain, external_identifier, source_url,
    source_name, attribution, last_seen_at, metadata
  ) values (
    resolved_venue_id, source.id, 'www.ladecadanse.ch', external_id, source_url,
    'La Décadanse', 'La Décadanse', now(),
    coalesce(_payload->'source_metadata', '{}'::jsonb)
  )
  on conflict (domain, external_identifier) do update set
    venue_id = excluded.venue_id,
    data_source_id = excluded.data_source_id,
    source_url = excluded.source_url,
    last_seen_at = now(),
    metadata = public.venue_sources.metadata || excluded.metadata;

  if jsonb_typeof(_payload->'media') = 'array' then
    for media_item in select value from jsonb_array_elements(_payload->'media')
    loop
      if media_item->>'url' ~ '^https?://' then
        insert into public.venue_media(
          venue_id, url, media_type, attribution, license, source_url,
          provider, sort_order, is_primary
        ) values (
          resolved_venue_id,
          left(media_item->>'url', 1000),
          case when media_item->>'media_type' = 'logo' then 'logo' else 'image' end,
          nullif(left(media_item->>'attribution', 500), ''),
          nullif(left(media_item->>'license', 160), ''),
          nullif(left(media_item->>'source_url', 1000), ''),
          nullif(left(media_item->>'provider', 80), ''),
          greatest(0, least(100, coalesce((media_item->>'sort_order')::integer, 0))),
          coalesce((media_item->>'is_primary')::boolean, false)
        )
        on conflict (venue_id, url) do update set
          attribution = coalesce(public.venue_media.attribution, excluded.attribution),
          license = coalesce(public.venue_media.license, excluded.license),
          source_url = coalesce(public.venue_media.source_url, excluded.source_url),
          provider = coalesce(public.venue_media.provider, excluded.provider),
          is_primary = public.venue_media.is_primary or excluded.is_primary,
          updated_at = now();
      end if;
    end loop;
  end if;

  if latitude is not null and longitude is not null then
    venue_slug := private.ladecadanse_slug(venue_name, external_id);
    insert into public.places_of_interest(
      city_id, country_id, venue_id, source_provider, source_type, source_id,
      source_url, name, slug, category, subcategory, description, address,
      website, image_url, image_urls, latitude, longitude, location, tags,
      quality_score, is_public, last_seen_at, source_urls, content_sources
    ) values (
      city.id, country_id, resolved_venue_id, 'ladecadanse', 'venue', external_id::bigint,
      source_url, venue_name, venue_slug, venue_category, venue_subcategory,
      venue_description, venue_address, venue_website, primary_image, image_urls,
      latitude, longitude,
      extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography,
      coalesce(_payload->'tags', '{}'::jsonb) || jsonb_build_object('venue_external_id', external_id),
      quality, true, now(),
      array_remove(array[source_url, venue_website], null),
      jsonb_build_array(jsonb_build_object(
        'label', 'La Décadanse', 'url', source_url, 'provider', 'ladecadanse'
      ))
    )
    on conflict (source_provider, source_type, source_id) do update set
      venue_id = excluded.venue_id,
      name = excluded.name,
      category = excluded.category,
      subcategory = coalesce(excluded.subcategory, public.places_of_interest.subcategory),
      description = coalesce(public.places_of_interest.description, excluded.description),
      address = coalesce(public.places_of_interest.address, excluded.address),
      website = coalesce(public.places_of_interest.website, excluded.website),
      image_url = coalesce(public.places_of_interest.image_url, excluded.image_url),
      image_urls = array(select distinct unnest(public.places_of_interest.image_urls || excluded.image_urls)),
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      location = excluded.location,
      tags = public.places_of_interest.tags || excluded.tags,
      quality_score = greatest(public.places_of_interest.quality_score, excluded.quality_score),
      is_public = true,
      last_seen_at = now(),
      source_urls = array(select distinct unnest(public.places_of_interest.source_urls || excluded.source_urls)),
      content_sources = public.places_of_interest.content_sources || excluded.content_sources,
      updated_at = now()
    returning id into resolved_place_id;
  else
    select place.id into resolved_place_id
    from public.places_of_interest place
    where place.venue_id = resolved_venue_id
    limit 1;
  end if;

  return query select resolved_venue_id, resolved_place_id, operation;
end;
$$;

create or replace function public.link_event_to_venue_source_v1(
  _event_id uuid,
  _domain text,
  _external_identifier text
)
returns uuid
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
declare resolved_venue_id uuid;
begin
  select source.venue_id into resolved_venue_id
  from public.venue_sources source
  where source.domain = lower(trim(_domain))
    and source.external_identifier = trim(_external_identifier)
  limit 1;
  if resolved_venue_id is null then return null; end if;
  update public.events set venue_id = resolved_venue_id where id = _event_id;
  return resolved_venue_id;
end;
$$;

create or replace function public.get_venue_detail_v1(_slug text)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = 'off'
as $$
  select coalesce((
    select jsonb_build_object(
      'id', venue.id,
      'slug', venue.slug,
      'name', venue.name,
      'description', venue.description,
      'address', venue.address,
      'postal_code', venue.postal_code,
      'latitude', venue.latitude,
      'longitude', venue.longitude,
      'website', venue.website,
      'cover_image_url', venue.cover_image_url,
      'capacity', venue.capacity,
      'is_verified', venue.is_verified,
      'city', jsonb_build_object(
        'id', city.id, 'name', city.name, 'timezone', city.timezone,
        'country_code', country.code, 'country_name', country.name
      ),
      'media', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', media.id, 'url', media.url, 'media_type', media.media_type,
          'attribution', media.attribution, 'license', media.license,
          'source_url', media.source_url, 'provider', media.provider,
          'is_primary', media.is_primary
        ) order by media.is_primary desc, media.sort_order, media.created_at)
        from public.venue_media media where media.venue_id = venue.id
      ), '[]'::jsonb),
      'sources', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', source.id, 'domain', source.domain,
          'external_identifier', source.external_identifier,
          'source_url', source.source_url, 'source_name', source.source_name,
          'attribution', source.attribution, 'last_seen_at', source.last_seen_at
        ) order by source.last_seen_at desc)
        from public.venue_sources source where source.venue_id = venue.id
      ), '[]'::jsonb),
      'upcoming_events', coalesce((
        select jsonb_agg(event_row.payload order by event_row.starts_at)
        from (
          select occurrence.starts_at, jsonb_build_object(
            'id', event.id, 'slug', event.slug, 'title', event.title,
            'short_description', event.short_description,
            'cover_image_url', event.cover_image_url,
            'is_free', event.is_free, 'status', event.status,
            'starts_at', occurrence.starts_at, 'ends_at', occurrence.ends_at,
            'timezone', occurrence.timezone,
            'category', case when category.id is null then null else jsonb_build_object(
              'slug', category.slug, 'name_fr', category.name_fr
            ) end
          ) as payload
          from public.events event
          join public.event_occurrences occurrence on occurrence.event_id = event.id
          left join public.event_categories category on category.id = event.category_id
          where event.venue_id = venue.id
            and event.is_demo = false
            and event.status in ('published','postponed','sold_out')
            and occurrence.starts_at >= now() - interval '2 hours'
          order by occurrence.starts_at
          limit 100
        ) event_row
      ), '[]'::jsonb),
      'past_events', coalesce((
        select jsonb_agg(event_row.payload order by event_row.starts_at desc)
        from (
          select occurrence.starts_at, jsonb_build_object(
            'id', event.id, 'slug', event.slug, 'title', event.title,
            'short_description', event.short_description,
            'cover_image_url', event.cover_image_url,
            'is_free', event.is_free, 'status', event.status,
            'starts_at', occurrence.starts_at, 'ends_at', occurrence.ends_at,
            'timezone', occurrence.timezone,
            'category', case when category.id is null then null else jsonb_build_object(
              'slug', category.slug, 'name_fr', category.name_fr
            ) end
          ) as payload
          from public.events event
          join public.event_occurrences occurrence on occurrence.event_id = event.id
          left join public.event_categories category on category.id = event.category_id
          where event.venue_id = venue.id
            and event.is_demo = false
            and occurrence.starts_at < now() - interval '2 hours'
          order by occurrence.starts_at desc
          limit 50
        ) event_row
      ), '[]'::jsonb)
    )
    from public.venues venue
    left join public.cities city on city.id = venue.city_id
    left join public.countries country on country.id = venue.country_id
    where venue.slug = _slug and venue.is_public = true and venue.is_demo = false
    limit 1
  ), 'null'::jsonb)::json;
$$;

create or replace function public.get_place_detail_v1(_place_id uuid)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = 'off'
as $$
  select coalesce((
    select (
      public.place_to_discovery_json(place)
      || jsonb_build_object(
        'venue_id', place.venue_id,
        'venue_slug', venue.slug,
        'upcoming_events', coalesce((
          select jsonb_agg(event_row.payload order by event_row.starts_at)
          from (
            select occurrence.starts_at, jsonb_build_object(
              'id', event.id, 'slug', event.slug, 'title', event.title,
              'cover_image_url', event.cover_image_url,
              'is_free', event.is_free, 'status', event.status,
              'starts_at', occurrence.starts_at, 'ends_at', occurrence.ends_at,
              'timezone', occurrence.timezone
            ) payload
            from public.events event
            join public.event_occurrences occurrence on occurrence.event_id = event.id
            where event.venue_id = place.venue_id
              and event.is_demo = false
              and event.status in ('published','postponed','sold_out')
              and occurrence.starts_at >= now() - interval '2 hours'
            order by occurrence.starts_at
            limit 24
          ) event_row
        ), '[]'::jsonb)
      )
    )::json
    from public.places_of_interest place
    left join public.venues venue on venue.id = place.venue_id
    where place.id = _place_id and place.is_public = true
    limit 1
  ), 'null'::json)::json;
$$;

revoke all on function public.enqueue_ladecadanse_sync_items_v1(jsonb) from public, anon, authenticated;
revoke all on function public.claim_ladecadanse_sync_items_v1(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_ladecadanse_sync_item_v1(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_ladecadanse_sync_item_v1(uuid, uuid, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.ladecadanse_sync_status_v1() from public, anon, authenticated;
revoke all on function public.upsert_ingested_venue_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.link_event_to_venue_source_v1(uuid, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_ladecadanse_sync_items_v1(jsonb) to service_role;
grant execute on function public.claim_ladecadanse_sync_items_v1(uuid, integer, integer) to service_role;
grant execute on function public.complete_ladecadanse_sync_item_v1(uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_ladecadanse_sync_item_v1(uuid, uuid, text, integer, boolean) to service_role;
grant execute on function public.ladecadanse_sync_status_v1() to service_role;
grant execute on function public.upsert_ingested_venue_v1(uuid, jsonb) to service_role;
grant execute on function public.link_event_to_venue_source_v1(uuid, text, text) to service_role;

revoke all on function public.get_venue_detail_v1(text) from public;
revoke all on function public.get_place_detail_v1(uuid) from public;
grant execute on function public.get_venue_detail_v1(text) to anon, authenticated;
grant execute on function public.get_place_detail_v1(uuid) to anon, authenticated;

select public.enqueue_ladecadanse_sync_items_v1(jsonb_build_array(
  jsonb_build_object('kind','agenda','url','https://www.ladecadanse.ch/','priority',5),
  jsonb_build_object('kind','venue_catalog','url','https://www.ladecadanse.ch/lieu/lieux.php','priority',10),
  jsonb_build_object('kind','venue_catalog','url','https://www.ladecadanse.ch/lieu/lieux.php?page=2','priority',11),
  jsonb_build_object('kind','venue_catalog','url','https://www.ladecadanse.ch/lieu/lieux.php?page=3','priority',12),
  jsonb_build_object('kind','venue_catalog','url','https://www.ladecadanse.ch/lieu/lieux.php?page=4','priority',13)
));
