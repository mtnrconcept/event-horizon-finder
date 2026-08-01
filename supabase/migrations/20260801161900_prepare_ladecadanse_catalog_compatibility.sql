-- Bootstrap the superset schema required by both La Décadanse ingestion
-- implementations before the historical catalog migration runs.
--
-- Production already contains the later 20260801170000 schema, while a fresh
-- database reaches this migration before either venue schema exists. Keeping
-- both column contracts available here makes the out-of-order catalog migration
-- safe to apply without deleting or rewriting migration history.

create table if not exists public.venue_sources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  data_source_id uuid references public.data_sources(id) on delete set null,
  domain text,
  source_provider text,
  external_identifier text not null,
  source_url text not null,
  canonical_url text,
  source_name text,
  attribution text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table public.venue_sources
  add column if not exists data_source_id uuid,
  add column if not exists domain text,
  add column if not exists source_provider text,
  add column if not exists canonical_url text,
  add column if not exists source_name text,
  add column if not exists attribution text;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.venue_sources'::regclass
      and conname = 'venue_sources_data_source_id_fkey'
  ) then
    alter table public.venue_sources
      add constraint venue_sources_data_source_id_fkey
      foreign key (data_source_id)
      references public.data_sources(id)
      on delete set null
      not valid;
  end if;
end;
$block$;

update public.venue_sources
set source_provider = coalesce(
      nullif(source_provider, ''),
      nullif(
        trim(
          both '_' from regexp_replace(lower(coalesce(domain, '')), '[^a-z0-9_-]+', '_', 'g')
        ),
        ''
      ),
      'ladecadanse'
    ),
    domain = coalesce(
      nullif(domain, ''),
      case
        when source_provider = 'ladecadanse' then 'www.ladecadanse.ch'
        else replace(source_provider, '_', '.')
      end,
      'www.ladecadanse.ch'
    ),
    canonical_url = coalesce(nullif(canonical_url, ''), source_url),
    source_name = coalesce(
      nullif(source_name, ''),
      case when source_provider = 'ladecadanse' then 'La Décadanse' end
    ),
    attribution = coalesce(
      nullif(attribution, ''),
      case when source_provider = 'ladecadanse' then 'La Décadanse' end
    )
where source_provider is null
   or source_provider = ''
   or domain is null
   or domain = ''
   or canonical_url is null
   or canonical_url = ''
   or source_name is null
   or attribution is null;

alter table public.venue_sources
  alter column source_provider set not null,
  alter column domain set not null,
  alter column canonical_url set not null;

create unique index if not exists venue_sources_domain_external_uidx
  on public.venue_sources(domain, external_identifier);
create unique index if not exists venue_sources_provider_external_uidx
  on public.venue_sources(source_provider, external_identifier);
create unique index if not exists venue_sources_venue_source_uidx
  on public.venue_sources(venue_id, source_url);
create index if not exists venue_sources_data_source_idx
  on public.venue_sources(data_source_id, last_seen_at desc)
  where data_source_id is not null;

create table if not exists public.venue_media (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  url text not null,
  thumbnail_url text,
  media_type text not null default 'image',
  attribution text,
  license text,
  license_url text,
  creator text,
  source_url text,
  provider text,
  source_provider text,
  is_fallback boolean not null default false,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.venue_media
  add column if not exists thumbnail_url text,
  add column if not exists media_type text not null default 'image',
  add column if not exists license_url text,
  add column if not exists creator text,
  add column if not exists source_url text,
  add column if not exists provider text,
  add column if not exists source_provider text,
  add column if not exists is_fallback boolean not null default false,
  add column if not exists is_primary boolean not null default false;

update public.venue_media
set media_type = coalesce(nullif(media_type, ''), 'image'),
    source_url = coalesce(nullif(source_url, ''), url),
    source_provider = coalesce(
      nullif(source_provider, ''),
      nullif(
        trim(
          both '_' from regexp_replace(lower(coalesce(provider, '')), '[^a-z0-9_-]+', '_', 'g')
        ),
        ''
      ),
      'ladecadanse'
    ),
    provider = coalesce(nullif(provider, ''), source_provider, 'ladecadanse'),
    is_fallback = coalesce(is_fallback, false),
    is_primary = coalesce(is_primary, false)
where media_type is null
   or media_type = ''
   or source_url is null
   or source_url = ''
   or source_provider is null
   or source_provider = ''
   or provider is null
   or provider = ''
   or is_fallback is null
   or is_primary is null;

alter table public.venue_media
  alter column media_type set not null,
  alter column source_url set not null,
  alter column source_provider set not null,
  alter column is_fallback set not null,
  alter column is_primary set not null;

create unique index if not exists venue_media_venue_url_uidx
  on public.venue_media(venue_id, url);
create index if not exists venue_media_venue_primary_sort_idx
  on public.venue_media(venue_id, is_primary desc, sort_order, created_at);
create index if not exists venue_media_provider_idx
  on public.venue_media(source_provider, created_at desc);

create or replace function public.sync_venue_source_compatibility_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.source_provider := coalesce(
    nullif(new.source_provider, ''),
    case
      when lower(coalesce(new.domain, '')) in ('www.ladecadanse.ch', 'ladecadanse.ch')
        then 'ladecadanse'
      else nullif(
        trim(
          both '_' from regexp_replace(lower(coalesce(new.domain, '')), '[^a-z0-9_-]+', '_', 'g')
        ),
        ''
      )
    end,
    'ladecadanse'
  );

  new.domain := coalesce(
    nullif(new.domain, ''),
    case
      when new.source_provider = 'ladecadanse' then 'www.ladecadanse.ch'
      else replace(new.source_provider, '_', '.')
    end
  );

  new.source_url := coalesce(nullif(new.source_url, ''), nullif(new.canonical_url, ''));
  new.canonical_url := coalesce(nullif(new.canonical_url, ''), nullif(new.source_url, ''));

  if new.source_url is null or new.canonical_url is null then
    raise exception 'venue_source_url_required';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_sync_venue_source_compatibility_v1 on public.venue_sources;
create trigger trg_sync_venue_source_compatibility_v1
before insert or update on public.venue_sources
for each row execute function public.sync_venue_source_compatibility_v1();

create or replace function public.sync_venue_media_compatibility_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.source_provider := coalesce(
    nullif(new.source_provider, ''),
    nullif(
      trim(
        both '_' from regexp_replace(lower(coalesce(new.provider, '')), '[^a-z0-9_-]+', '_', 'g')
      ),
      ''
    ),
    'ladecadanse'
  );
  new.provider := coalesce(nullif(new.provider, ''), new.source_provider);
  new.source_url := coalesce(nullif(new.source_url, ''), nullif(new.url, ''));
  new.media_type := coalesce(nullif(new.media_type, ''), 'image');
  new.is_fallback := coalesce(new.is_fallback, false);
  new.is_primary := coalesce(new.is_primary, false);
  return new;
end;
$function$;

drop trigger if exists trg_sync_venue_media_compatibility_v1 on public.venue_media;
create trigger trg_sync_venue_media_compatibility_v1
before insert or update on public.venue_media
for each row execute function public.sync_venue_media_compatibility_v1();

notify pgrst, 'reload schema';