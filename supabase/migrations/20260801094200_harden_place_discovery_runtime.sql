-- Make permanent-place discovery resilient to overloaded Overpass instances,
-- support targeted city runs, and schedule a conservative continuous worker.
--
-- This migration must be independently replayable from an empty database. The
-- permanent-place schema was originally added by later timestamped migrations,
-- so create every city scheduling column and the base places table before any
-- earlier map projection migration references them.
alter table public.cities
  add column if not exists places_last_discovered_at timestamptz,
  add column if not exists places_discovery_error text,
  add column if not exists places_last_attempted_at timestamptz,
  add column if not exists places_discovery_failure_count integer not null default 0,
  add column if not exists places_discovery_next_retry_at timestamptz;

create table if not exists public.places_of_interest (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete cascade,
  country_id uuid references public.countries(id) on delete set null,
  venue_id uuid references public.venues(id) on delete set null,
  source_provider text not null default 'openstreetmap',
  source_type text not null,
  source_id bigint not null,
  source_url text,
  name text not null,
  slug text not null,
  category text not null,
  subcategory text,
  description text,
  address text,
  website text,
  phone text,
  image_url text,
  opening_hours text,
  fee text,
  wheelchair text,
  latitude double precision not null,
  longitude double precision not null,
  location geography(point, 4326) generated always as (
    st_setsrid(st_makepoint(longitude, latitude), 4326)::geography
  ) stored,
  tags jsonb not null default '{}'::jsonb,
  quality_score integer not null default 0 check (quality_score between 0 and 100),
  is_public boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_provider, source_type, source_id),
  unique (city_id, slug)
);

create index if not exists cities_place_discovery_schedule_idx
  on public.cities (
    places_discovery_next_retry_at,
    places_last_discovered_at,
    places_discovery_failure_count,
    population desc
  )
  where latitude is not null and longitude is not null;

create or replace function public.claim_cities_for_place_discovery_v2(
  _limit integer default 1,
  _city_ids uuid[] default null
)
returns table (
  city_id uuid,
  city_name text,
  country_id uuid,
  country_code text,
  latitude double precision,
  longitude double precision,
  population bigint
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.name, c.country_id, co.code, c.latitude, c.longitude, c.population
  from public.cities c
  left join public.countries co on co.id = c.country_id
  where c.latitude is not null
    and c.longitude is not null
    and (_city_ids is null or c.id = any(_city_ids))
    and (
      _city_ids is not null
      or (
        (c.places_discovery_next_retry_at is not null and c.places_discovery_next_retry_at <= now())
        or (
          c.places_discovery_next_retry_at is null
          and (
            c.places_last_discovered_at is null
            or c.places_last_discovered_at < now() - interval '30 days'
          )
        )
      )
    )
  order by
    case when _city_ids is not null then array_position(_city_ids, c.id) end nulls last,
    c.places_last_discovered_at nulls first,
    c.places_discovery_failure_count asc,
    case
      when c.population between 50000 and 2000000 then 0
      when c.population is null then 1
      when c.population < 50000 then 2
      else 3
    end,
    c.population desc nulls last,
    random()
  limit greatest(1, least(coalesce(_limit, 1), 10));
$$;

revoke all on function public.claim_cities_for_place_discovery_v2(integer, uuid[])
  from public, anon, authenticated;
grant execute on function public.claim_cities_for_place_discovery_v2(integer, uuid[])
  to service_role;

create or replace function public.claim_cities_for_place_discovery(_limit integer default 3)
returns table (
  city_id uuid,
  city_name text,
  country_id uuid,
  country_code text,
  latitude double precision,
  longitude double precision,
  population bigint
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.claim_cities_for_place_discovery_v2(_limit, null::uuid[]);
$$;

revoke all on function public.claim_cities_for_place_discovery(integer)
  from public, anon, authenticated;
grant execute on function public.claim_cities_for_place_discovery(integer)
  to service_role;

create or replace function public.mark_place_discovery_failure(
  _city_id uuid,
  _error text,
  _retry_after_seconds integer default 3600
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.cities
  set
    places_last_attempted_at = now(),
    places_discovery_error = left(coalesce(_error, 'place_discovery_failed'), 500),
    places_discovery_failure_count = least(100, places_discovery_failure_count + 1),
    places_discovery_next_retry_at = now() + make_interval(
      secs => greatest(300, least(coalesce(_retry_after_seconds, 3600), 604800))
    )
  where id = _city_id;
$$;

revoke all on function public.mark_place_discovery_failure(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.mark_place_discovery_failure(uuid, text, integer)
  to service_role;

create or replace function public.mark_place_discovery_success(_city_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.cities
  set
    places_last_attempted_at = now(),
    places_last_discovered_at = now(),
    places_discovery_error = null,
    places_discovery_failure_count = 0,
    places_discovery_next_retry_at = null
  where id = _city_id;
$$;

revoke all on function public.mark_place_discovery_success(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_place_discovery_success(uuid)
  to service_role;

create or replace function public.invoke_global_place_discovery(
  _limit integer default 1,
  _city_ids uuid[] default null
)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  scraper_secret text;
  request_body jsonb;
begin
  select decrypted_secret
  into scraper_secret
  from vault.decrypted_secrets
  where name in ('GLOBAL_SCRAPER_SECRET', 'global_scraper_secret')
  order by case when name = 'GLOBAL_SCRAPER_SECRET' then 0 else 1 end, created_at desc
  limit 1;

  if scraper_secret is null or length(scraper_secret) < 32 then
    raise exception 'global_scraper_secret_missing';
  end if;

  request_body := jsonb_build_object(
    'limit', greatest(1, least(coalesce(_limit, 1), 10))
  );
  if _city_ids is not null and cardinality(_city_ids) > 0 then
    request_body := request_body || jsonb_build_object('city_ids', _city_ids);
  end if;

  return net.http_post(
    url := 'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/global-place-discovery',
    body := request_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-global-scraper-secret', scraper_secret
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.invoke_global_place_discovery(integer, uuid[])
  from public, anon, authenticated;
grant execute on function public.invoke_global_place_discovery(integer, uuid[])
  to service_role;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'global-place-discovery-quarter-hour'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'global-place-discovery-quarter-hour',
    '4,19,34,49 * * * *',
    $cron$select public.invoke_global_place_discovery(1, null::uuid[]);$cron$
  );
end;
$$;
