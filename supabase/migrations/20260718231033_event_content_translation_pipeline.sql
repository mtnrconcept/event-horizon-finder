-- Persist complete structured event translations. The three dedicated text
-- columns keep summary reads small while `content` stores the richer map/detail
-- overlay (venue, organizer, offers, performers and scraped values).
alter table public.event_translations
  add column if not exists content jsonb not null default '{}'::jsonb,
  add column if not exists translation_scope text not null default 'summary',
  add column if not exists source_locale text,
  add column if not exists provider text,
  add column if not exists provider_model text,
  add column if not exists last_error text,
  add column if not exists attempt_count integer not null default 0;

alter table public.event_translations
  add constraint event_translations_content_object_check
    check (jsonb_typeof(content) = 'object'),
  add constraint event_translations_scope_check
    check (translation_scope in ('summary', 'full')),
  add constraint event_translations_attempt_count_check
    check (attempt_count >= 0);

create index if not exists event_translations_public_lookup_idx
  on public.event_translations (locale, translation_scope, event_id)
  include (title, short_description, description, source_hash, translated_at)
  where translation_status in ('machine', 'reviewed');

alter table public.venue_translations
  add column if not exists source_locale text,
  add column if not exists provider text,
  add column if not exists provider_model text,
  add column if not exists last_error text,
  add column if not exists attempt_count integer not null default 0;

alter table public.venue_translations
  add constraint venue_translations_attempt_count_check
    check (attempt_count >= 0);

drop trigger if exists trg_event_translations_updated on public.event_translations;
create trigger trg_event_translations_updated
  before update on public.event_translations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_venue_translations_updated on public.venue_translations;
create trigger trg_venue_translations_updated
  before update on public.venue_translations
  for each row execute function public.set_updated_at();

-- Translation generation is public-facing but paid. Only the Edge Function's
-- service role can consume this atomic hourly quota; browsers cannot mutate it.
create table public.event_translation_rate_limits (
  client_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  translated_event_count integer not null default 0 check (translated_event_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (client_hash, window_started_at)
);

create index event_translation_rate_limits_cleanup_idx
  on public.event_translation_rate_limits (window_started_at);

alter table public.event_translation_rate_limits enable row level security;
revoke all on public.event_translation_rate_limits from public, anon, authenticated;
grant all on public.event_translation_rate_limits to service_role;

create or replace function public.consume_event_translation_quota(
  _client_hash text,
  _translated_event_count integer,
  _hourly_limit integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  _window timestamptz := date_trunc('hour', now());
  _accepted text;
begin
  if _client_hash is null
     or length(_client_hash) < 32
     or _translated_event_count < 0
     or _translated_event_count > 20
     or _hourly_limit < 1 then
    return false;
  end if;

  insert into public.event_translation_rate_limits (
    client_hash,
    window_started_at,
    request_count,
    translated_event_count,
    updated_at
  ) values (
    _client_hash,
    _window,
    1,
    _translated_event_count,
    now()
  )
  on conflict (client_hash, window_started_at) do update
    set request_count = event_translation_rate_limits.request_count + 1,
        translated_event_count = event_translation_rate_limits.translated_event_count
          + excluded.translated_event_count,
        updated_at = now()
    where event_translation_rate_limits.translated_event_count
      + excluded.translated_event_count <= _hourly_limit
  returning client_hash into _accepted;

  return _accepted is not null;
end;
$$;

revoke all on function public.consume_event_translation_quota(text, integer, integer) from public;
grant execute on function public.consume_event_translation_quota(text, integer, integer)
  to service_role;

-- Central invalidation helper. It is SECURITY DEFINER so ordinary organizer
-- updates can invalidate machine translations without gaining write access to
-- the translation cache itself.
create or replace function public.mark_event_translations_stale(_event_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.event_translations
     set translation_status = 'stale',
         updated_at = now()
   where event_id = any(_event_ids)
     and translation_status in ('machine', 'reviewed');
$$;

revoke all on function public.mark_event_translations_stale(uuid[]) from public;

create or replace function public.invalidate_event_translation_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_event_translations_stale(array[new.id]);
  return new;
end;
$$;

drop trigger if exists trg_events_invalidate_translations on public.events;
create trigger trg_events_invalidate_translations
  after update of title, short_description, description, age_restriction, language,
    venue_id, organizer_id
  on public.events
  for each row
  when (
    old.title is distinct from new.title
    or old.short_description is distinct from new.short_description
    or old.description is distinct from new.description
    or old.age_restriction is distinct from new.age_restriction
    or old.language is distinct from new.language
    or old.venue_id is distinct from new.venue_id
    or old.organizer_id is distinct from new.organizer_id
  )
  execute function public.invalidate_event_translation_from_event();

create or replace function public.invalidate_event_translation_from_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _event_id uuid;
begin
  if tg_op = 'DELETE' then
    _event_id := old.event_id;
  else
    _event_id := new.event_id;
  end if;
  perform public.mark_event_translations_stale(array[_event_id]);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_event_accessibility_invalidate_translations
  on public.event_accessibility;
create trigger trg_event_accessibility_invalidate_translations
  after insert or update or delete on public.event_accessibility
  for each row execute function public.invalidate_event_translation_from_child();

drop trigger if exists trg_ticket_offers_invalidate_translations on public.ticket_offers;
create trigger trg_ticket_offers_invalidate_translations
  after insert or update or delete on public.ticket_offers
  for each row execute function public.invalidate_event_translation_from_child();

drop trigger if exists trg_event_performers_invalidate_translations on public.event_performers;
create trigger trg_event_performers_invalidate_translations
  after insert or update or delete on public.event_performers
  for each row execute function public.invalidate_event_translation_from_child();

drop trigger if exists trg_event_scraped_details_invalidate_translations
  on public.event_scraped_details;
create trigger trg_event_scraped_details_invalidate_translations
  after insert or update or delete on public.event_scraped_details
  for each row execute function public.invalidate_event_translation_from_child();

create or replace function public.invalidate_event_translation_from_venue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.venue_translations
     set translation_status = 'stale', updated_at = now()
   where venue_id = new.id
     and translation_status in ('machine', 'reviewed');

  perform public.mark_event_translations_stale(
    coalesce((select array_agg(id) from public.events where venue_id = new.id), '{}'::uuid[])
  );
  return new;
end;
$$;

drop trigger if exists trg_venues_invalidate_translations on public.venues;
create trigger trg_venues_invalidate_translations
  after update of name, description on public.venues
  for each row
  when (old.name is distinct from new.name or old.description is distinct from new.description)
  execute function public.invalidate_event_translation_from_venue();

create or replace function public.invalidate_event_translation_from_organizer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_event_translations_stale(
    coalesce((select array_agg(id) from public.events where organizer_id = new.id), '{}'::uuid[])
  );
  return new;
end;
$$;

drop trigger if exists trg_organizers_invalidate_translations on public.organizers;
create trigger trg_organizers_invalidate_translations
  after update of name, description on public.organizers
  for each row
  when (old.name is distinct from new.name or old.description is distinct from new.description)
  execute function public.invalidate_event_translation_from_organizer();

create or replace function public.invalidate_event_translation_from_performer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_event_translations_stale(
    coalesce(
      (select array_agg(event_id) from public.event_performers where performer_id = new.id),
      '{}'::uuid[]
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_performers_invalidate_translations on public.performers;
create trigger trg_performers_invalidate_translations
  after update of name, type, bio on public.performers
  for each row
  when (
    old.name is distinct from new.name
    or old.type is distinct from new.type
    or old.bio is distinct from new.bio
  )
  execute function public.invalidate_event_translation_from_performer();
