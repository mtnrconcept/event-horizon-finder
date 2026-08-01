-- Permanent places of interest discovered independently from dated events.
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

create index if not exists places_of_interest_location_gix
  on public.places_of_interest using gist(location);
create index if not exists places_of_interest_city_category_idx
  on public.places_of_interest(city_id, category, subcategory);
create index if not exists places_of_interest_last_seen_idx
  on public.places_of_interest(last_seen_at desc);
create index if not exists places_of_interest_name_trgm
  on public.places_of_interest using gin(name gin_trgm_ops);

alter table public.places_of_interest enable row level security;
grant select on public.places_of_interest to anon, authenticated;
grant all on public.places_of_interest to service_role;

drop policy if exists places_of_interest_public_read on public.places_of_interest;
create policy places_of_interest_public_read
  on public.places_of_interest for select using (is_public);

drop trigger if exists trg_places_of_interest_updated on public.places_of_interest;
create trigger trg_places_of_interest_updated
before update on public.places_of_interest
for each row execute function public.set_updated_at();

alter table public.cities
  add column if not exists places_last_discovered_at timestamptz,
  add column if not exists places_discovery_error text;

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
  select c.id, c.name, c.country_id, co.code, c.latitude, c.longitude, c.population
  from public.cities c
  left join public.countries co on co.id = c.country_id
  where c.latitude is not null
    and c.longitude is not null
    and (c.places_last_discovered_at is null or c.places_last_discovered_at < now() - interval '30 days')
  order by c.places_last_discovered_at nulls first, c.population desc nulls last, random()
  limit greatest(1, least(coalesce(_limit, 3), 10));
$$;
revoke all on function public.claim_cities_for_place_discovery(integer) from public, anon, authenticated;
grant execute on function public.claim_cities_for_place_discovery(integer) to service_role;

create or replace function public.upsert_places_of_interest(
  _city_id uuid,
  _country_id uuid,
  _places jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  affected integer := 0;
begin
  if jsonb_typeof(_places) <> 'array' then
    raise exception 'places_payload_must_be_array';
  end if;

  for item in select value from jsonb_array_elements(_places)
  loop
    insert into public.places_of_interest (
      city_id, country_id, source_provider, source_type, source_id, source_url,
      name, slug, category, subcategory, description, address, website, phone,
      image_url, opening_hours, fee, wheelchair, latitude, longitude, tags,
      quality_score, last_seen_at
    ) values (
      _city_id, _country_id, 'openstreetmap', item->>'source_type', (item->>'source_id')::bigint,
      item->>'source_url', item->>'name', item->>'slug', item->>'category',
      nullif(item->>'subcategory',''), nullif(item->>'description',''), nullif(item->>'address',''),
      nullif(item->>'website',''), nullif(item->>'phone',''), nullif(item->>'image_url',''),
      nullif(item->>'opening_hours',''), nullif(item->>'fee',''), nullif(item->>'wheelchair',''),
      (item->>'latitude')::double precision, (item->>'longitude')::double precision,
      coalesce(item->'tags', '{}'::jsonb), coalesce((item->>'quality_score')::integer, 0), now()
    )
    on conflict (source_provider, source_type, source_id) do update set
      city_id = excluded.city_id,
      country_id = excluded.country_id,
      name = excluded.name,
      slug = excluded.slug,
      category = excluded.category,
      subcategory = excluded.subcategory,
      description = excluded.description,
      address = excluded.address,
      website = excluded.website,
      phone = excluded.phone,
      image_url = excluded.image_url,
      opening_hours = excluded.opening_hours,
      fee = excluded.fee,
      wheelchair = excluded.wheelchair,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      tags = excluded.tags,
      quality_score = excluded.quality_score,
      is_public = true,
      last_seen_at = now(),
      updated_at = now();
    affected := affected + 1;
  end loop;

  update public.cities
  set places_last_discovered_at = now(), places_discovery_error = null
  where id = _city_id;
  return affected;
end;
$$;
revoke all on function public.upsert_places_of_interest(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_places_of_interest(uuid, uuid, jsonb) to service_role;
