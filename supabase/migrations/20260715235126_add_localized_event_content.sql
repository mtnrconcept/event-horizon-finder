create table public.event_translations (
  event_id uuid not null references public.events(id) on delete cascade,
  locale text not null check (locale in ('fr', 'en', 'pl', 'it', 'ru', 'es')),
  title text not null check (length(btrim(title)) > 0),
  short_description text,
  description text,
  source_hash text not null,
  translation_status text not null default 'pending'
    check (translation_status in ('pending', 'machine', 'reviewed', 'stale', 'failed')),
  translated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, locale)
);

create index event_translations_locale_event_idx
  on public.event_translations (locale, event_id)
  where translation_status in ('machine', 'reviewed');

alter table public.event_translations enable row level security;

create policy "Published event translations are readable"
  on public.event_translations
  for select
  to anon, authenticated
  using (
    translation_status in ('machine', 'reviewed')
    and exists (
      select 1
      from public.events
      where events.id = event_translations.event_id
        and events.publication_status = 'published'
    )
  );

grant select on public.event_translations to anon, authenticated;
grant all on public.event_translations to service_role;

create table public.venue_translations (
  venue_id uuid not null references public.venues(id) on delete cascade,
  locale text not null check (locale in ('fr', 'en', 'pl', 'it', 'ru', 'es')),
  name text not null check (length(btrim(name)) > 0),
  description text,
  source_hash text not null,
  translation_status text not null default 'pending'
    check (translation_status in ('pending', 'machine', 'reviewed', 'stale', 'failed')),
  translated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, locale)
);

create index venue_translations_locale_venue_idx
  on public.venue_translations (locale, venue_id)
  where translation_status in ('machine', 'reviewed');

alter table public.venue_translations enable row level security;

create policy "Public venue translations are readable"
  on public.venue_translations
  for select
  to anon, authenticated
  using (
    translation_status in ('machine', 'reviewed')
    and exists (
      select 1
      from public.venues
      where venues.id = venue_translations.venue_id
        and venues.is_public
    )
  );

grant select on public.venue_translations to anon, authenticated;
grant all on public.venue_translations to service_role;
