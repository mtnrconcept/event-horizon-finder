-- Reconcile the two additive La Décadanse venue schemas.
-- The catalog migration may create venue_sources and venue_media before the
-- exhaustive ingestion migration, so CREATE TABLE IF NOT EXISTS cannot add the
-- columns required by the later functions. Keep existing data and make the
-- resulting schema compatible with both pipelines.

alter table public.venue_sources
  add column if not exists source_provider text,
  add column if not exists canonical_url text;

update public.venue_sources
set source_provider = coalesce(
      nullif(source_provider, ''),
      nullif(regexp_replace(lower(coalesce(domain, '')), '[^a-z0-9_-]+', '_', 'g'), ''),
      'ladecadanse'
    ),
    canonical_url = coalesce(nullif(canonical_url, ''), source_url)
where source_provider is null
   or source_provider = ''
   or canonical_url is null
   or canonical_url = '';

alter table public.venue_sources
  alter column source_provider set not null,
  alter column canonical_url set not null;

create unique index if not exists venue_sources_provider_external_uidx
  on public.venue_sources(source_provider, external_identifier);

create index if not exists venue_sources_provider_seen_idx
  on public.venue_sources(source_provider, last_seen_at desc);

alter table public.venue_media
  add column if not exists thumbnail_url text,
  add column if not exists license_url text,
  add column if not exists creator text,
  add column if not exists source_provider text,
  add column if not exists is_fallback boolean not null default false;

update public.venue_media
set source_url = coalesce(nullif(source_url, ''), url),
    source_provider = coalesce(
      nullif(source_provider, ''),
      nullif(regexp_replace(lower(coalesce(provider, '')), '[^a-z0-9_-]+', '_', 'g'), ''),
      'ladecadanse'
    )
where source_url is null
   or source_url = ''
   or source_provider is null
   or source_provider = '';

alter table public.venue_media
  alter column source_url set not null,
  alter column source_provider set not null;

create index if not exists venue_media_provider_idx
  on public.venue_media(source_provider, created_at desc);
