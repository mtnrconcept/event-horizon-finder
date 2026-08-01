-- Keep the two additive venue ingestion contracts compatible at write time.
-- The catalog pipeline writes domain/provider fields while the exhaustive
-- pipeline writes source_provider/canonical_url fields. Normalize both shapes
-- before constraints are checked so either worker can safely upsert records.

create or replace function public.sync_venue_source_compatibility_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.source_provider := coalesce(
    nullif(new.source_provider, ''),
    case
      when lower(coalesce(new.domain, '')) in ('www.ladecadanse.ch', 'ladecadanse.ch')
        then 'ladecadanse'
      else nullif(regexp_replace(lower(coalesce(new.domain, '')), '[^a-z0-9_-]+', '_', 'g'), '')
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
$$;

drop trigger if exists trg_sync_venue_source_compatibility_v1 on public.venue_sources;
create trigger trg_sync_venue_source_compatibility_v1
before insert or update on public.venue_sources
for each row execute function public.sync_venue_source_compatibility_v1();

create or replace function public.sync_venue_media_compatibility_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.source_provider := coalesce(
    nullif(new.source_provider, ''),
    nullif(regexp_replace(lower(coalesce(new.provider, '')), '[^a-z0-9_-]+', '_', 'g'), ''),
    'ladecadanse'
  );
  new.provider := coalesce(nullif(new.provider, ''), new.source_provider);
  new.source_url := coalesce(nullif(new.source_url, ''), nullif(new.url, ''));
  new.media_type := coalesce(nullif(new.media_type, ''), 'image');
  return new;
end;
$$;

drop trigger if exists trg_sync_venue_media_compatibility_v1 on public.venue_media;
create trigger trg_sync_venue_media_compatibility_v1
before insert or update on public.venue_media
for each row execute function public.sync_venue_media_compatibility_v1();

-- Normalize existing rows once more before the triggers become the permanent
-- compatibility boundary.
update public.venue_sources
set source_provider = source_provider,
    domain = domain,
    source_url = source_url,
    canonical_url = canonical_url;

update public.venue_media
set source_provider = source_provider,
    provider = provider,
    source_url = source_url,
    media_type = media_type;
