-- Deterministic, source-specific ingestion for La Décadanse.
--
-- The generic worldwide crawler remains unchanged. This adapter owns the
-- exhaustive Geneva source queue, honours the site's crawl delay and persists
-- canonical venues before their events so map pins and venue pages converge.

create table if not exists public.venue_sources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  source_provider text not null,
  external_identifier text not null,
  source_url text not null,
  canonical_url text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (source_provider, external_identifier),
  constraint venue_sources_provider_check
    check (source_provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint venue_sources_url_check
    check (source_url ~* '^https?://[^[:space:]]+$' and canonical_url ~* '^https?://[^[:space:]]+$'),
  constraint venue_sources_metadata_check
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 65536)
);

create index if not exists venue_sources_venue_idx
  on public.venue_sources (venue_id, last_seen_at desc);

create table if not exists public.venue_media (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  url text not null,
  thumbnail_url text,
  attribution text,
  license text,
  license_url text,
  creator text,
  source_url text not null,
  source_provider text not null,
  is_fallback boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, url),
  constraint venue_media_url_check
    check (
      url ~* '^https?://[^[:space:]]+$'
      and source_url ~* '^https?://[^[:space:]]+$'
      and (thumbnail_url is null or thumbnail_url ~* '^https?://[^[:space:]]+$')
      and (license_url is null or license_url ~* '^https?://[^[:space:]]+$')
    ),
  constraint venue_media_provider_check
    check (source_provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint venue_media_sort_check check (sort_order between 0 and 1000)
);

create index if not exists venue_media_venue_sort_idx
  on public.venue_media (venue_id, sort_order, created_at);

alter table public.venue_media enable row level security;
alter table public.venue_sources enable row level security;

drop policy if exists venue_media_public_read on public.venue_media;
create policy venue_media_public_read
  on public.venue_media
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.venues as venue
      where venue.id = venue_media.venue_id
        and venue.is_public = true
        and venue.is_demo = false
    )
  );

revoke all on table public.venue_sources from public, anon, authenticated;
revoke all on table public.venue_media from public;
grant select on table public.venue_media to anon, authenticated, service_role;
grant select, insert, update, delete on table public.venue_sources to service_role;
grant insert, update, delete on table public.venue_media to service_role;

create table if not exists private.ladecadanse_crawl_jobs (
  id uuid primary key default gen_random_uuid(),
  parent_job_id uuid references private.ladecadanse_crawl_jobs(id) on delete set null,
  data_source_id uuid not null references public.data_sources(id) on delete cascade,
  city_id uuid not null references public.cities(id) on delete cascade,
  url text not null,
  canonical_url text not null unique,
  job_kind text not null,
  crawl_depth smallint not null default 0,
  priority smallint not null default 0,
  refresh_after_seconds integer not null default 43200,
  status text not null default 'queued',
  available_at timestamptz not null default now(),
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 5,
  lease_owner uuid,
  lease_expires_at timestamptz,
  http_status smallint,
  content_hash text,
  response_metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ladecadanse_crawl_url_check
    check (
      url ~ '^https://www\.ladecadanse\.ch(?:/|$)'
      and canonical_url ~ '^https://www\.ladecadanse\.ch(?:/|$)'
    ),
  constraint ladecadanse_crawl_kind_check
    check (job_kind in ('agenda', 'event', 'venue_directory', 'venue', 'rss')),
  constraint ladecadanse_crawl_status_check
    check (status in ('queued', 'leased', 'completed', 'failed', 'skipped', 'cancelled')),
  constraint ladecadanse_crawl_depth_check check (crawl_depth between 0 and 16),
  constraint ladecadanse_crawl_attempt_check
    check (attempt_count between 0 and 100 and max_attempts between 1 and 100),
  constraint ladecadanse_crawl_refresh_check
    check (refresh_after_seconds between 300 and 31536000),
  constraint ladecadanse_crawl_metadata_check
    check (jsonb_typeof(response_metadata) = 'object' and pg_column_size(response_metadata) <= 131072),
  constraint ladecadanse_crawl_lease_check
    check (
      (status = 'leased' and lease_owner is not null and lease_expires_at is not null)
      or status <> 'leased'
    )
);

create index if not exists ladecadanse_crawl_ready_idx
  on private.ladecadanse_crawl_jobs (priority desc, available_at, created_at)
  where status in ('queued', 'leased');

create index if not exists ladecadanse_crawl_kind_status_idx
  on private.ladecadanse_crawl_jobs (job_kind, status, updated_at desc);

create table if not exists private.ladecadanse_runtime (
  singleton boolean primary key default true check (singleton),
  worker_owner uuid,
  worker_expires_at timestamptz,
  last_request_at timestamptz,
  last_seed_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ladecadanse_runtime_result_check
    check (jsonb_typeof(last_result) = 'object' and pg_column_size(last_result) <= 65536)
);

insert into private.ladecadanse_runtime (singleton)
values (true)
on conflict (singleton) do nothing;

alter table private.ladecadanse_crawl_jobs enable row level security;
alter table private.ladecadanse_runtime enable row level security;
revoke all on table private.ladecadanse_crawl_jobs from public, anon, authenticated, service_role;
revoke all on table private.ladecadanse_runtime from public, anon, authenticated, service_role;

-- Replace the stale historical host with the canonical public source. The
-- source remains verified/authorised, but the deterministic adapter is now the
-- only writer for this domain.
with geneva as (
  select city.id
  from public.cities as city
  join public.countries as country on country.id = city.country_id
  where upper(country.code) = 'CH'
    and public.unaccent(lower(city.name)) in ('geneve', 'geneva')
  order by city.population desc nulls last, city.id
  limit 1
)
insert into public.data_sources (
  name,
  source_type,
  base_url,
  domain,
  is_authorized,
  is_verified,
  sync_frequency,
  status,
  legal_basis,
  city_id,
  page_count,
  priority,
  metadata
)
select
  'La Décadanse Genève',
  'partner_feed',
  'https://www.ladecadanse.ch/',
  'www.ladecadanse.ch',
  true,
  true,
  'daily',
  'active',
  'public_web_source_with_attribution',
  geneva.id,
  4,
  100,
  jsonb_build_object(
    'adapter', 'ladecadanse_v1',
    'locale', 'fr',
    'source_specific', true,
    'crawl_delay_seconds', 15,
    'future_days', 366,
    'venue_directory', true
  )
from geneva
where not exists (
  select 1
  from public.data_sources as source
  where lower(source.name) = lower('La Décadanse Genève')
     or lower(source.domain) in ('ladecadanse.darksite.ch', 'www.ladecadanse.ch', 'ladecadanse.ch')
);

update public.data_sources as source
set
  base_url = 'https://www.ladecadanse.ch/',
  domain = 'www.ladecadanse.ch',
  status = 'active',
  is_authorized = true,
  is_verified = true,
  page_count = greatest(source.page_count, 4),
  priority = greatest(source.priority, 100),
  sync_frequency = 'daily',
  next_sync_at = now(),
  metadata = source.metadata || jsonb_build_object(
    'adapter', 'ladecadanse_v1',
    'locale', 'fr',
    'source_specific', true,
    'crawl_delay_seconds', 15,
    'future_days', 366,
    'venue_directory', true,
    'legacy_domain', coalesce(source.domain, '')
  ),
  updated_at = now()
where lower(source.name) = lower('La Décadanse Genève')
   or lower(source.domain) in ('ladecadanse.darksite.ch', 'www.ladecadanse.ch', 'ladecadanse.ch');

create or replace function public.ladecadanse_source_context_v1()
returns table (
  source_id uuid,
  source_name text,
  city_id uuid,
  city_name text,
  timezone text,
  latitude double precision,
  longitude double precision,
  country_id uuid,
  country_code text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    source.id,
    source.name,
    city.id,
    city.name,
    city.timezone,
    city.latitude,
    city.longitude,
    country.id,
    upper(country.code)
  from public.data_sources as source
  join public.cities as city on city.id = source.city_id
  join public.countries as country on country.id = city.country_id
  where source.status = 'active'
    and source.is_authorized
    and source.is_verified
    and source.metadata->>'adapter' = 'ladecadanse_v1'
  order by source.updated_at desc, source.id
  limit 1;
$function$;

revoke all on function public.ladecadanse_source_context_v1() from public, anon, authenticated;
grant execute on function public.ladecadanse_source_context_v1() to service_role;

create or replace function private.enqueue_ladecadanse_url_v1(
  _data_source_id uuid,
  _city_id uuid,
  _url text,
  _kind text,
  _priority integer,
  _refresh_after_seconds integer,
  _parent_job_id uuid,
  _crawl_depth integer,
  _force boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_url text := regexp_replace(left(btrim(coalesce(_url, '')), 2000), '#.*$', '');
  changed boolean := false;
begin
  if normalized_url !~ '^https://www\.ladecadanse\.ch(?:/|$)'
    or _kind not in ('agenda', 'event', 'venue_directory', 'venue', 'rss')
    or _crawl_depth not between 0 and 16
  then
    raise exception 'invalid_ladecadanse_url' using errcode = '22023';
  end if;

  insert into private.ladecadanse_crawl_jobs (
    parent_job_id,
    data_source_id,
    city_id,
    url,
    canonical_url,
    job_kind,
    crawl_depth,
    priority,
    refresh_after_seconds,
    status,
    available_at
  ) values (
    _parent_job_id,
    _data_source_id,
    _city_id,
    normalized_url,
    normalized_url,
    _kind,
    _crawl_depth,
    greatest(-1000, least(coalesce(_priority, 0), 1000)),
    greatest(300, least(coalesce(_refresh_after_seconds, 43200), 31536000)),
    'queued',
    now()
  )
  on conflict (canonical_url) do update set
    parent_job_id = coalesce(private.ladecadanse_crawl_jobs.parent_job_id, excluded.parent_job_id),
    data_source_id = excluded.data_source_id,
    city_id = excluded.city_id,
    job_kind = excluded.job_kind,
    priority = greatest(private.ladecadanse_crawl_jobs.priority, excluded.priority),
    refresh_after_seconds = least(
      private.ladecadanse_crawl_jobs.refresh_after_seconds,
      excluded.refresh_after_seconds
    ),
    status = case
      when _force then 'queued'
      when private.ladecadanse_crawl_jobs.status in ('completed', 'failed', 'skipped')
        and coalesce(
          private.ladecadanse_crawl_jobs.finished_at,
          private.ladecadanse_crawl_jobs.updated_at
        ) <= now() - make_interval(secs => excluded.refresh_after_seconds)
        then 'queued'
      else private.ladecadanse_crawl_jobs.status
    end,
    attempt_count = case
      when _force then 0
      when private.ladecadanse_crawl_jobs.status in ('completed', 'failed', 'skipped')
        and coalesce(
          private.ladecadanse_crawl_jobs.finished_at,
          private.ladecadanse_crawl_jobs.updated_at
        ) <= now() - make_interval(secs => excluded.refresh_after_seconds)
        then 0
      else private.ladecadanse_crawl_jobs.attempt_count
    end,
    available_at = case
      when _force then now()
      when private.ladecadanse_crawl_jobs.status in ('completed', 'failed', 'skipped')
        and coalesce(
          private.ladecadanse_crawl_jobs.finished_at,
          private.ladecadanse_crawl_jobs.updated_at
        ) <= now() - make_interval(secs => excluded.refresh_after_seconds)
        then now()
      else private.ladecadanse_crawl_jobs.available_at
    end,
    lease_owner = case when _force then null else private.ladecadanse_crawl_jobs.lease_owner end,
    lease_expires_at = case when _force then null else private.ladecadanse_crawl_jobs.lease_expires_at end,
    finished_at = case when _force then null else private.ladecadanse_crawl_jobs.finished_at end,
    error_code = case when _force then null else private.ladecadanse_crawl_jobs.error_code end,
    error_message = case when _force then null else private.ladecadanse_crawl_jobs.error_message end,
    updated_at = now();

  get diagnostics changed = row_count;
  return changed;
end;
$function$;

create or replace function public.seed_ladecadanse_discovery_v1(
  _future_days integer default 366,
  _force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  context record;
  day_offset integer;
  seeded integer := 0;
  future_days integer := greatest(7, least(coalesce(_future_days, 366), 366));
  target_date date;
begin
  select * into context from public.ladecadanse_source_context_v1();
  if context.source_id is null then
    raise exception 'ladecadanse_source_missing' using errcode = '55000';
  end if;

  if private.enqueue_ladecadanse_url_v1(
    context.source_id, context.city_id,
    'https://www.ladecadanse.ch/', 'agenda', 70, 43200, null, 0, _force
  ) then seeded := seeded + 1; end if;
  if private.enqueue_ladecadanse_url_v1(
    context.source_id, context.city_id,
    'https://www.ladecadanse.ch/lieu/', 'venue_directory', 80, 86400, null, 0, _force
  ) then seeded := seeded + 1; end if;
  if private.enqueue_ladecadanse_url_v1(
    context.source_id, context.city_id,
    'https://www.ladecadanse.ch/event/rss.php?type=evenements_ajoutes',
    'rss', 90, 7200, null, 0, _force
  ) then seeded := seeded + 1; end if;

  for day_offset in 0..future_days loop
    target_date := current_date + day_offset;
    if private.enqueue_ladecadanse_url_v1(
      context.source_id,
      context.city_id,
      'https://www.ladecadanse.ch/index.php?courant=' || to_char(target_date, 'YYYY-MM-DD'),
      'agenda',
      case when day_offset <= 14 then 75 when day_offset <= 60 then 60 else 40 end,
      case when day_offset <= 14 then 21600 when day_offset <= 60 then 43200 else 86400 end,
      null,
      0,
      _force
    ) then seeded := seeded + 1; end if;
  end loop;

  update private.ladecadanse_runtime
  set last_seed_at = now(), updated_at = now()
  where singleton;

  return jsonb_build_object(
    'ok', true,
    'future_days', future_days,
    'seeded', seeded,
    'source_id', context.source_id,
    'city_id', context.city_id
  );
end;
$function$;

revoke all on function public.seed_ladecadanse_discovery_v1(integer, boolean)
  from public, anon, authenticated;
grant execute on function public.seed_ladecadanse_discovery_v1(integer, boolean)
  to service_role;

create or replace function public.enqueue_ladecadanse_urls_v1(
  _parent_job_id uuid,
  _worker_id uuid,
  _items jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  parent private.ladecadanse_crawl_jobs%rowtype;
  context record;
  item jsonb;
  accepted integer := 0;
  kind_value text;
  refresh_value integer;
  priority_value integer;
  url_value text;
begin
  if _worker_id is null
    or jsonb_typeof(_items) is distinct from 'array'
    or jsonb_array_length(_items) > 500
    or pg_column_size(_items) > 524288
  then
    raise exception 'invalid_ladecadanse_items' using errcode = '22023';
  end if;

  select * into parent
  from private.ladecadanse_crawl_jobs as job
  where job.id = _parent_job_id
    and job.status = 'leased'
    and job.lease_owner = _worker_id
    and job.lease_expires_at > now()
  for update;
  if not found then
    raise exception 'ladecadanse_job_lease_not_owned' using errcode = '55000';
  end if;

  select * into context from public.ladecadanse_source_context_v1();
  for item in select value from jsonb_array_elements(_items) loop
    url_value := item->>'url';
    kind_value := lower(coalesce(item->>'kind', ''));
    begin
      refresh_value := (item->>'refresh_after_seconds')::integer;
    exception when others then
      refresh_value := 43200;
    end;
    begin
      priority_value := (item->>'priority')::integer;
    exception when others then
      priority_value := 0;
    end;
    perform private.enqueue_ladecadanse_url_v1(
      context.source_id,
      context.city_id,
      url_value,
      kind_value,
      priority_value,
      refresh_value,
      parent.id,
      parent.crawl_depth + 1,
      false
    );
    accepted := accepted + 1;
  end loop;
  return accepted;
end;
$function$;

revoke all on function public.enqueue_ladecadanse_urls_v1(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_ladecadanse_urls_v1(uuid, uuid, jsonb)
  to service_role;

create or replace function public.begin_ladecadanse_worker_v1(
  _worker_id uuid,
  _lease_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if _worker_id is null then return false; end if;
  update private.ladecadanse_runtime
  set
    worker_owner = _worker_id,
    worker_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(_lease_seconds, 180), 300))),
    last_run_at = now(),
    updated_at = now()
  where singleton
    and (
      worker_owner is null
      or worker_owner = _worker_id
      or worker_expires_at is null
      or worker_expires_at <= now()
    );
  return found;
end;
$function$;

create or replace function public.finish_ladecadanse_worker_v1(
  _worker_id uuid,
  _result jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if jsonb_typeof(_result) is distinct from 'object' or pg_column_size(_result) > 65536 then
    raise exception 'invalid_ladecadanse_worker_result' using errcode = '22023';
  end if;
  update private.ladecadanse_runtime
  set
    worker_owner = null,
    worker_expires_at = null,
    last_result = _result,
    updated_at = now()
  where singleton and worker_owner = _worker_id;
  return found;
end;
$function$;

create or replace function public.reserve_ladecadanse_request_slot_v1(
  _worker_id uuid,
  _minimum_delay_seconds integer default 15
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state private.ladecadanse_runtime%rowtype;
  scheduled_at timestamptz;
  wait_ms integer;
begin
  select * into state
  from private.ladecadanse_runtime
  where singleton
    and worker_owner = _worker_id
    and worker_expires_at > now()
  for update;
  if not found then
    raise exception 'ladecadanse_worker_lease_not_owned' using errcode = '55000';
  end if;
  scheduled_at := greatest(
    now(),
    coalesce(state.last_request_at, '-infinity'::timestamptz)
      + make_interval(secs => greatest(15, least(coalesce(_minimum_delay_seconds, 15), 120)))
  );
  wait_ms := greatest(0, ceil(extract(epoch from (scheduled_at - now())) * 1000)::integer);
  update private.ladecadanse_runtime
  set
    last_request_at = scheduled_at,
    worker_expires_at = greatest(worker_expires_at, scheduled_at + interval '90 seconds'),
    updated_at = now()
  where singleton;
  return wait_ms;
end;
$function$;

create or replace function public.claim_ladecadanse_jobs_v1(
  _worker_id uuid,
  _limit integer default 5,
  _lease_seconds integer default 180
)
returns table (
  job_id uuid,
  parent_job_id uuid,
  url text,
  job_kind text,
  crawl_depth integer,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from private.ladecadanse_runtime
    where singleton and worker_owner = _worker_id and worker_expires_at > now()
  ) then
    return;
  end if;

  update private.ladecadanse_crawl_jobs as job
  set
    status = case when job.attempt_count >= job.max_attempts then 'failed' else 'queued' end,
    available_at = case
      when job.attempt_count >= job.max_attempts then job.available_at
      else now() + interval '2 minutes'
    end,
    lease_owner = null,
    lease_expires_at = null,
    error_code = coalesce(job.error_code, 'lease_expired'),
    error_message = coalesce(job.error_message, 'Previous worker lease expired.'),
    finished_at = case when job.attempt_count >= job.max_attempts then now() else null end,
    updated_at = now()
  where job.status = 'leased' and job.lease_expires_at <= now();

  return query
  with candidates as (
    select job.id
    from private.ladecadanse_crawl_jobs as job
    where job.status = 'queued'
      and job.available_at <= now()
      and job.attempt_count < job.max_attempts
    order by job.priority desc, job.available_at, job.created_at, job.id
    limit greatest(1, least(coalesce(_limit, 5), 6))
    for update skip locked
  ),
  claimed as (
    update private.ladecadanse_crawl_jobs as job
    set
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_owner = _worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(90, least(coalesce(_lease_seconds, 180), 300))),
      started_at = coalesce(job.started_at, now()),
      error_code = null,
      error_message = null,
      updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select
    claimed.id,
    claimed.parent_job_id,
    claimed.url,
    claimed.job_kind,
    claimed.crawl_depth::integer,
    claimed.attempt_count::integer,
    claimed.max_attempts::integer
  from claimed
  order by claimed.priority desc, claimed.created_at, claimed.id;
end;
$function$;

create or replace function public.complete_ladecadanse_job_v1(
  _job_id uuid,
  _worker_id uuid,
  _http_status integer,
  _content_hash text,
  _metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if jsonb_typeof(_metadata) is distinct from 'object' or pg_column_size(_metadata) > 131072 then
    raise exception 'invalid_ladecadanse_result' using errcode = '22023';
  end if;
  update private.ladecadanse_crawl_jobs
  set
    status = 'completed',
    lease_owner = null,
    lease_expires_at = null,
    http_status = case when _http_status between 100 and 599 then _http_status::smallint else null end,
    content_hash = nullif(left(_content_hash, 512), ''),
    response_metadata = _metadata,
    error_code = null,
    error_message = null,
    finished_at = now(),
    updated_at = now()
  where id = _job_id
    and status = 'leased'
    and lease_owner = _worker_id
    and lease_expires_at > now();
  if found then
    update public.data_sources
    set last_sync_at = now(), next_sync_at = now() + interval '1 day', updated_at = now()
    where metadata->>'adapter' = 'ladecadanse_v1';
  end if;
  return found;
end;
$function$;

create or replace function public.fail_ladecadanse_job_v1(
  _job_id uuid,
  _worker_id uuid,
  _error_code text,
  _error_message text,
  _retry_after_seconds integer default 300,
  _terminal boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job private.ladecadanse_crawl_jobs%rowtype;
begin
  select * into job
  from private.ladecadanse_crawl_jobs
  where id = _job_id
    and status = 'leased'
    and lease_owner = _worker_id
  for update;
  if not found then return false; end if;
  update private.ladecadanse_crawl_jobs
  set
    status = case when _terminal or job.attempt_count >= job.max_attempts then 'failed' else 'queued' end,
    available_at = case
      when _terminal or job.attempt_count >= job.max_attempts then available_at
      else now() + make_interval(secs => greatest(60, least(coalesce(_retry_after_seconds, 300), 86400)))
    end,
    lease_owner = null,
    lease_expires_at = null,
    error_code = left(coalesce(_error_code, 'unexpected_error'), 120),
    error_message = left(coalesce(_error_message, 'Unexpected La Décadanse error.'), 2000),
    finished_at = case when _terminal or job.attempt_count >= job.max_attempts then now() else null end,
    updated_at = now()
  where id = job.id;
  return true;
end;
$function$;

create or replace function public.ladecadanse_discovery_status_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'checked_at', now(),
    'queued', count(*) filter (where job.status = 'queued'),
    'leased', count(*) filter (where job.status = 'leased'),
    'completed', count(*) filter (where job.status = 'completed'),
    'failed', count(*) filter (where job.status = 'failed'),
    'events_completed', count(*) filter (where job.status = 'completed' and job.job_kind = 'event'),
    'venues_completed', count(*) filter (where job.status = 'completed' and job.job_kind = 'venue'),
    'last_completed_at', max(job.finished_at) filter (where job.status = 'completed'),
    'runtime', (select to_jsonb(runtime) from private.ladecadanse_runtime as runtime where runtime.singleton)
  )
  from private.ladecadanse_crawl_jobs as job;
$function$;

revoke all on function public.begin_ladecadanse_worker_v1(uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_ladecadanse_worker_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.reserve_ladecadanse_request_slot_v1(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_ladecadanse_jobs_v1(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_ladecadanse_job_v1(uuid, uuid, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_ladecadanse_job_v1(uuid, uuid, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.ladecadanse_discovery_status_v1() from public, anon, authenticated;
grant execute on function public.begin_ladecadanse_worker_v1(uuid, integer) to service_role;
grant execute on function public.finish_ladecadanse_worker_v1(uuid, jsonb) to service_role;
grant execute on function public.reserve_ladecadanse_request_slot_v1(uuid, integer) to service_role;
grant execute on function public.claim_ladecadanse_jobs_v1(uuid, integer, integer) to service_role;
grant execute on function public.complete_ladecadanse_job_v1(uuid, uuid, integer, text, jsonb) to service_role;
grant execute on function public.fail_ladecadanse_job_v1(uuid, uuid, text, text, integer, boolean) to service_role;
grant execute on function public.ladecadanse_discovery_status_v1() to service_role;

create or replace function public.upsert_ladecadanse_venue_v1(
  _data_source_id uuid,
  _venue jsonb
)
returns table (venue_id uuid, place_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source public.data_sources%rowtype;
  city public.cities%rowtype;
  external_id text := nullif(left(btrim(_venue->>'external_id'), 120), '');
  source_url text := nullif(left(btrim(_venue->>'source_url'), 2000), '');
  venue_name text := nullif(left(btrim(_venue->>'name'), 180), '');
  venue_address text := nullif(left(btrim(_venue->>'address'), 300), '');
  category_value text := coalesce(nullif(left(btrim(_venue->>'category'), 80), ''), 'culture');
  subcategory_value text := nullif(left(btrim(_venue->>'subcategory'), 120), '');
  description_value text := nullif(left(btrim(_venue->>'description'), 6000), '');
  website_value text := nullif(left(btrim(_venue->>'website'), 2000), '');
  opening_hours_value text := nullif(left(btrim(_venue->>'opening_hours'), 1000), '');
  postal_code_value text := nullif(left(btrim(_venue->>'postal_code'), 40), '');
  latitude_value double precision;
  longitude_value double precision;
  source_id_value bigint;
  venue_id_value uuid;
  place_id_value uuid;
  venue_slug text;
  first_image text;
  image_urls_value text[] := array[]::text[];
  source_urls_value text[] := array[]::text[];
  content_sources_value jsonb := coalesce(_venue->'content_sources', '[]'::jsonb);
  media_item jsonb;
  quality_value integer := 70;
begin
  if jsonb_typeof(_venue) is distinct from 'object'
    or external_id is null
    or external_id !~ '^\d{1,18}$'
    or source_url !~ '^https://www\.ladecadanse\.ch/lieu/lieu\.php\?idL=\d+$'
    or venue_name is null
    or venue_address is null
  then
    raise exception 'invalid_ladecadanse_venue' using errcode = '22023';
  end if;

  select * into source
  from public.data_sources
  where id = _data_source_id
    and status = 'active'
    and is_authorized
    and is_verified
    and metadata->>'adapter' = 'ladecadanse_v1';
  if not found then raise exception 'ladecadanse_source_not_authorized' using errcode = '42501'; end if;
  select * into city from public.cities where id = source.city_id;
  source_id_value := external_id::bigint;
  begin latitude_value := (_venue->>'latitude')::double precision; exception when others then latitude_value := null; end;
  begin longitude_value := (_venue->>'longitude')::double precision; exception when others then longitude_value := null; end;
  if latitude_value not between -90 and 90 or longitude_value not between -180 and 180 then
    latitude_value := null; longitude_value := null;
  end if;
  begin quality_value := greatest(0, least(100, (_venue->>'quality_score')::integer)); exception when others then quality_value := 70; end;
  if jsonb_typeof(_venue->'image_urls') = 'array' then
    select coalesce(array_agg(distinct left(value, 2000)), array[]::text[])
    into image_urls_value
    from jsonb_array_elements_text(_venue->'image_urls')
    where value ~* '^https?://[^[:space:]]+$';
  end if;
  if jsonb_typeof(_venue->'source_urls') = 'array' then
    select coalesce(array_agg(distinct left(value, 2000)), array[]::text[])
    into source_urls_value
    from jsonb_array_elements_text(_venue->'source_urls')
    where value ~* '^https?://[^[:space:]]+$';
  end if;
  if not source_url = any(source_urls_value) then source_urls_value := array_prepend(source_url, source_urls_value); end if;
  first_image := image_urls_value[1];

  perform pg_advisory_xact_lock(hashtextextended('ladecadanse-venue|' || external_id, 0));
  select mapping.venue_id into venue_id_value
  from public.venue_sources as mapping
  where mapping.source_provider = 'ladecadanse'
    and mapping.external_identifier = external_id
  limit 1;

  if venue_id_value is null then
    select venue.id into venue_id_value
    from public.venues as venue
    where venue.city_id = source.city_id
      and similarity(public.unaccent(lower(venue.name)), public.unaccent(lower(venue_name))) >= 0.88
      and (
        venue.address is null
        or similarity(public.unaccent(lower(venue.address)), public.unaccent(lower(venue_address))) >= 0.55
      )
    order by
      similarity(public.unaccent(lower(venue.name)), public.unaccent(lower(venue_name))) desc,
      similarity(public.unaccent(lower(coalesce(venue.address, ''))), public.unaccent(lower(venue_address))) desc
    limit 1;
  end if;

  if venue_id_value is null then
    venue_slug := left(
      trim(both '-' from regexp_replace(public.unaccent(lower(venue_name)), '[^a-z0-9]+', '-', 'g'))
      || '-ldc-' || external_id,
      120
    );
    insert into public.venues (
      slug, name, description, address, postal_code, city_id, country_id,
      latitude, longitude, location, website, cover_image_url,
      is_verified, is_public, is_demo
    ) values (
      venue_slug, venue_name, description_value, venue_address, postal_code_value,
      source.city_id, city.country_id, latitude_value, longitude_value,
      case when latitude_value is not null and longitude_value is not null
        then public.st_setsrid(public.st_makepoint(longitude_value, latitude_value), 4326)::public.geography end,
      website_value, first_image, source.is_verified, true, false
    )
    on conflict (slug) do update set
      description = coalesce(excluded.description, public.venues.description),
      address = coalesce(excluded.address, public.venues.address),
      postal_code = coalesce(excluded.postal_code, public.venues.postal_code),
      city_id = coalesce(public.venues.city_id, excluded.city_id),
      country_id = coalesce(public.venues.country_id, excluded.country_id),
      latitude = coalesce(excluded.latitude, public.venues.latitude),
      longitude = coalesce(excluded.longitude, public.venues.longitude),
      location = coalesce(excluded.location, public.venues.location),
      website = coalesce(excluded.website, public.venues.website),
      cover_image_url = coalesce(excluded.cover_image_url, public.venues.cover_image_url),
      is_public = true,
      updated_at = now()
    returning id into venue_id_value;
  else
    update public.venues
    set
      name = case when length(venue_name) > length(name) then venue_name else name end,
      description = case
        when length(coalesce(description_value, '')) > length(coalesce(description, '')) then description_value
        else description
      end,
      address = coalesce(venue_address, address),
      postal_code = coalesce(postal_code_value, postal_code),
      city_id = coalesce(city_id, source.city_id),
      country_id = coalesce(country_id, city.country_id),
      latitude = coalesce(latitude_value, latitude),
      longitude = coalesce(longitude_value, longitude),
      location = case
        when latitude_value is not null and longitude_value is not null
          then public.st_setsrid(public.st_makepoint(longitude_value, latitude_value), 4326)::public.geography
        else location
      end,
      website = coalesce(website_value, website),
      cover_image_url = coalesce(first_image, cover_image_url),
      is_verified = is_verified or source.is_verified,
      is_public = true,
      updated_at = now()
    where id = venue_id_value;
  end if;

  insert into public.venue_sources (
    venue_id, source_provider, external_identifier, source_url, canonical_url, metadata, last_seen_at
  ) values (
    venue_id_value, 'ladecadanse', external_id, source_url, source_url,
    jsonb_build_object('data_source_id', source.id), now()
  )
  on conflict (source_provider, external_identifier) do update set
    venue_id = excluded.venue_id,
    source_url = excluded.source_url,
    canonical_url = excluded.canonical_url,
    metadata = public.venue_sources.metadata || excluded.metadata,
    last_seen_at = now();

  if jsonb_typeof(_venue->'media') = 'array' then
    for media_item in select value from jsonb_array_elements(_venue->'media') loop
      if coalesce(media_item->>'url', '') ~* '^https?://[^[:space:]]+$'
        and coalesce(media_item->>'source_url', '') ~* '^https?://[^[:space:]]+$'
      then
        insert into public.venue_media (
          venue_id, url, thumbnail_url, attribution, license, license_url,
          creator, source_url, source_provider, is_fallback, sort_order
        ) values (
          venue_id_value,
          left(media_item->>'url', 2000),
          nullif(left(media_item->>'thumbnail_url', 2000), ''),
          nullif(left(media_item->>'attribution', 1000), ''),
          nullif(left(media_item->>'license', 200), ''),
          nullif(left(media_item->>'license_url', 2000), ''),
          nullif(left(media_item->>'creator', 500), ''),
          left(media_item->>'source_url', 2000),
          coalesce(nullif(left(media_item->>'source_provider', 64), ''), 'ladecadanse'),
          coalesce((media_item->>'is_fallback')::boolean, false),
          0
        )
        on conflict (venue_id, url) do update set
          thumbnail_url = coalesce(excluded.thumbnail_url, public.venue_media.thumbnail_url),
          attribution = coalesce(excluded.attribution, public.venue_media.attribution),
          license = coalesce(excluded.license, public.venue_media.license),
          license_url = coalesce(excluded.license_url, public.venue_media.license_url),
          creator = coalesce(excluded.creator, public.venue_media.creator),
          source_url = excluded.source_url,
          source_provider = excluded.source_provider,
          is_fallback = public.venue_media.is_fallback or excluded.is_fallback,
          updated_at = now();
      end if;
    end loop;
  end if;

  if latitude_value is not null and longitude_value is not null then
    insert into public.places_of_interest (
      city_id, country_id, venue_id, source_provider, source_type, source_id,
      source_url, name, slug, category, subcategory, description, address,
      website, image_url, image_urls, booking_url, source_urls, content_sources,
      opening_hours, latitude, longitude, location, tags, quality_score,
      is_public, last_seen_at
    ) values (
      source.city_id, city.country_id, venue_id_value, 'ladecadanse', 'venue', source_id_value,
      source_url, venue_name,
      left(trim(both '-' from regexp_replace(public.unaccent(lower(venue_name)), '[^a-z0-9]+', '-', 'g')) || '-ldc-' || external_id, 120),
      category_value, subcategory_value, description_value, venue_address,
      website_value, first_image, image_urls_value, nullif(_venue->>'booking_url', ''),
      source_urls_value, content_sources_value, opening_hours_value,
      latitude_value, longitude_value,
      public.st_setsrid(public.st_makepoint(longitude_value, latitude_value), 4326)::public.geography,
      jsonb_build_object('source', 'ladecadanse', 'external_id', external_id),
      quality_value, true, now()
    )
    on conflict (source_provider, source_type, source_id) do update set
      city_id = excluded.city_id,
      country_id = excluded.country_id,
      venue_id = excluded.venue_id,
      source_url = excluded.source_url,
      name = excluded.name,
      category = excluded.category,
      subcategory = coalesce(excluded.subcategory, public.places_of_interest.subcategory),
      description = case
        when length(coalesce(excluded.description, '')) > length(coalesce(public.places_of_interest.description, '')) then excluded.description
        else public.places_of_interest.description
      end,
      address = coalesce(excluded.address, public.places_of_interest.address),
      website = coalesce(excluded.website, public.places_of_interest.website),
      image_url = coalesce(excluded.image_url, public.places_of_interest.image_url),
      image_urls = case when cardinality(excluded.image_urls) > 0 then excluded.image_urls else public.places_of_interest.image_urls end,
      booking_url = coalesce(excluded.booking_url, public.places_of_interest.booking_url),
      source_urls = case when cardinality(excluded.source_urls) > 0 then excluded.source_urls else public.places_of_interest.source_urls end,
      content_sources = case when jsonb_array_length(excluded.content_sources) > 0 then excluded.content_sources else public.places_of_interest.content_sources end,
      opening_hours = coalesce(excluded.opening_hours, public.places_of_interest.opening_hours),
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      location = excluded.location,
      quality_score = greatest(excluded.quality_score, public.places_of_interest.quality_score),
      is_public = true,
      last_seen_at = now(),
      updated_at = now()
    returning id into place_id_value;
  end if;

  return query select venue_id_value, place_id_value;
end;
$function$;

revoke all on function public.upsert_ladecadanse_venue_v1(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_ladecadanse_venue_v1(uuid, jsonb)
  to service_role;

create or replace function public.sync_event_venue_place_v1(_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_row public.events%rowtype;
  venue_row public.venues%rowtype;
  existing_place uuid;
  source_id_value bigint;
  category_value text;
  subcategory_value text;
begin
  select * into event_row from public.events where id = _event_id;
  if event_row.venue_id is null then return null; end if;
  select * into venue_row from public.venues where id = event_row.venue_id and is_public and not is_demo;
  if not found or venue_row.address is null or venue_row.latitude is null or venue_row.longitude is null then return null; end if;
  select id into existing_place
  from public.places_of_interest
  where venue_id = venue_row.id and is_public
  order by (source_provider = 'ladecadanse') desc, quality_score desc, created_at
  limit 1;
  if existing_place is not null then return existing_place; end if;

  source_id_value := ('x' || substr(md5(venue_row.id::text), 1, 15))::bit(60)::bigint;
  if public.unaccent(lower(venue_row.name)) ~ '(bar|cafe|restaurant|bistrot|brasserie)' then
    category_value := 'food-drink'; subcategory_value := 'bar-cafe-restaurant';
  else
    category_value := 'culture'; subcategory_value := 'event-venue';
  end if;
  insert into public.places_of_interest (
    city_id, country_id, venue_id, source_provider, source_type, source_id,
    source_url, name, slug, category, subcategory, description, address,
    website, image_url, image_urls, latitude, longitude, location,
    tags, quality_score, is_public, last_seen_at
  ) values (
    venue_row.city_id, venue_row.country_id, venue_row.id,
    'event_venue', 'venue', source_id_value,
    coalesce(venue_row.website, event_row.official_url),
    venue_row.name,
    left(venue_row.slug || '-place', 120),
    category_value, subcategory_value, venue_row.description, venue_row.address,
    venue_row.website, venue_row.cover_image_url,
    case when venue_row.cover_image_url is null then array[]::text[] else array[venue_row.cover_image_url] end,
    venue_row.latitude, venue_row.longitude,
    public.st_setsrid(public.st_makepoint(venue_row.longitude, venue_row.latitude), 4326)::public.geography,
    jsonb_build_object('source', 'event_venue', 'venue_id', venue_row.id),
    72, true, now()
  )
  on conflict (source_provider, source_type, source_id) do update set
    venue_id = excluded.venue_id,
    address = coalesce(excluded.address, public.places_of_interest.address),
    website = coalesce(excluded.website, public.places_of_interest.website),
    image_url = coalesce(excluded.image_url, public.places_of_interest.image_url),
    image_urls = case when cardinality(excluded.image_urls) > 0 then excluded.image_urls else public.places_of_interest.image_urls end,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    location = excluded.location,
    is_public = true,
    last_seen_at = now(),
    updated_at = now()
  returning id into existing_place;
  return existing_place;
end;
$function$;

revoke all on function public.sync_event_venue_place_v1(uuid) from public, anon, authenticated;
grant execute on function public.sync_event_venue_place_v1(uuid) to service_role;

create or replace function public.get_place_upcoming_events_v1(
  _place_id uuid,
  _limit integer default 24,
  _offset integer default 0
)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = off
as $function$
  with selected_place as (
    select place.venue_id
    from public.places_of_interest as place
    where place.id = _place_id and place.is_public and place.venue_id is not null
  ),
  filtered as materialized (
    select
      occurrence.id as occurrence_id,
      event.id as event_id,
      event.slug,
      event.title,
      event.short_description,
      event.cover_image_url,
      event.is_free,
      occurrence.starts_at,
      occurrence.ends_at,
      occurrence.timezone,
      category.slug as category_slug,
      category.name_fr as category_name,
      venue.name as venue_name,
      (
        select offer.ticket_url
        from public.ticket_offers as offer
        where offer.event_id = event.id and offer.ticket_url is not null
        order by offer.is_free desc nulls last, offer.id
        limit 1
      ) as ticket_url
    from selected_place
    join public.events as event on event.venue_id = selected_place.venue_id
    join public.event_occurrences as occurrence on occurrence.event_id = event.id
    left join public.event_categories as category on category.id = event.category_id
    left join public.venues as venue on venue.id = event.venue_id
    where event.is_demo = false
      and event.publication_status = 'published'
      and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
      and occurrence.starts_at >= now() - interval '2 hours'
  ),
  page as (
    select * from filtered
    order by starts_at, title, occurrence_id
    limit greatest(1, least(coalesce(_limit, 24), 100))
    offset greatest(0, coalesce(_offset, 0))
  ),
  totals as (select count(*)::integer as total_count from filtered)
  select json_build_object(
    'version', 1,
    'total_count', totals.total_count,
    'has_more', greatest(0, coalesce(_offset, 0)) + (select count(*) from page) < totals.total_count,
    'items', coalesce((select json_agg(page order by page.starts_at, page.title) from page), '[]'::json)
  )
  from totals;
$function$;

revoke all on function public.get_place_upcoming_events_v1(uuid, integer, integer) from public;
grant execute on function public.get_place_upcoming_events_v1(uuid, integer, integer)
  to anon, authenticated, service_role;

-- Independent pg_net trigger. It reuses the existing one-time scheduler token
-- table and claim function, so no long-lived secret is stored in the database.
create table if not exists private.ladecadanse_scheduler_state (
  singleton boolean primary key default true check (singleton),
  last_dispatched_at timestamptz,
  last_request_id bigint,
  last_status jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ladecadanse_scheduler_status_check
    check (jsonb_typeof(last_status) = 'object' and pg_column_size(last_status) <= 65536)
);
insert into private.ladecadanse_scheduler_state (singleton)
values (true)
on conflict (singleton) do nothing;
alter table private.ladecadanse_scheduler_state enable row level security;
revoke all on table private.ladecadanse_scheduler_state from public, anon, authenticated, service_role;

create or replace function private.dispatch_ladecadanse_discovery_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  endpoint constant text := 'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/ladecadanse-discovery';
  request_token text := encode(extensions.gen_random_bytes(32), 'hex');
  request_token_hash text;
  dispatch_id uuid := gen_random_uuid();
  request_id bigint;
  state private.ladecadanse_scheduler_state%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('ladecadanse-discovery-dispatch-v1', 0));
  select * into state from private.ladecadanse_scheduler_state where singleton for update;
  if state.last_dispatched_at is not null and state.last_dispatched_at > now() - interval '12 minutes' then
    return jsonb_build_object('ok', true, 'dispatched', false, 'reason', 'recent_dispatch');
  end if;
  request_token_hash := encode(extensions.digest(request_token, 'sha256'), 'hex');
  insert into private.global_discovery_scheduler_tokens (token_hash, dispatch_id, expires_at)
  values (request_token_hash, dispatch_id, now() + interval '10 minutes');
  select net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'User-Agent', 'GlobalParty-LaDecadanse-Cron/1.0',
      'x-global-discovery-cron-token', request_token
    ),
    body := jsonb_build_object('action', 'run', 'batch_size', 5, 'seed', true, 'future_days', 366),
    timeout_milliseconds := 240000
  ) into request_id;
  update private.ladecadanse_scheduler_state
  set last_dispatched_at = now(), last_request_id = request_id,
      last_status = jsonb_build_object('dispatch_id', dispatch_id, 'request_id', request_id),
      updated_at = now()
  where singleton;
  delete from private.global_discovery_scheduler_tokens where expires_at < now() - interval '1 hour';
  return jsonb_build_object('ok', true, 'dispatched', true, 'request_id', request_id);
end;
$function$;

revoke all on function private.dispatch_ladecadanse_discovery_v1()
  from public, anon, authenticated, service_role;

DO $schedule_ladecadanse$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for job_id in select jobid from cron.job where jobname = 'ladecadanse-complete-discovery'
    loop
      perform cron.unschedule(job_id);
    end loop;
    perform cron.schedule(
      'ladecadanse-complete-discovery',
      '3,18,33,48 * * * *',
      $cron$select private.dispatch_ladecadanse_discovery_v1();$cron$
    );
  end if;
end;
$schedule_ladecadanse$;

select public.seed_ladecadanse_discovery_v1(366, true);
notify pgrst, 'reload schema';
