-- Rich permanent-place content used by the home search, map list and detail sheet.
alter table public.places_of_interest
  add column if not exists image_urls text[] not null default '{}'::text[],
  add column if not exists booking_url text,
  add column if not exists source_urls text[] not null default '{}'::text[],
  add column if not exists content_sources jsonb not null default '[]'::jsonb;

update public.places_of_interest
set image_urls = array[image_url]
where image_url is not null
  and cardinality(image_urls) = 0;

create index if not exists places_of_interest_city_quality_idx
  on public.places_of_interest(city_id, quality_score desc, name)
  where is_public = true;

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
      image_url, image_urls, booking_url, source_urls, content_sources,
      opening_hours, fee, wheelchair, latitude, longitude, tags,
      quality_score, last_seen_at
    ) values (
      _city_id, _country_id, 'openstreetmap', item->>'source_type', (item->>'source_id')::bigint,
      item->>'source_url', item->>'name', item->>'slug', item->>'category',
      nullif(item->>'subcategory',''), nullif(item->>'description',''), nullif(item->>'address',''),
      nullif(item->>'website',''), nullif(item->>'phone',''), nullif(item->>'image_url',''),
      coalesce(array(select jsonb_array_elements_text(coalesce(item->'image_urls', '[]'::jsonb))), '{}'::text[]),
      nullif(item->>'booking_url',''),
      coalesce(array(select jsonb_array_elements_text(coalesce(item->'source_urls', '[]'::jsonb))), '{}'::text[]),
      coalesce(item->'content_sources', '[]'::jsonb),
      nullif(item->>'opening_hours',''), nullif(item->>'fee',''), nullif(item->>'wheelchair',''),
      (item->>'latitude')::double precision, (item->>'longitude')::double precision,
      coalesce(item->'tags', '{}'::jsonb), coalesce((item->>'quality_score')::integer, 0), now()
    )
    on conflict (source_provider, source_type, source_id) do update set
      city_id = excluded.city_id,
      country_id = excluded.country_id,
      source_url = excluded.source_url,
      name = excluded.name,
      slug = excluded.slug,
      category = excluded.category,
      subcategory = excluded.subcategory,
      description = coalesce(excluded.description, public.places_of_interest.description),
      address = coalesce(excluded.address, public.places_of_interest.address),
      website = coalesce(excluded.website, public.places_of_interest.website),
      phone = coalesce(excluded.phone, public.places_of_interest.phone),
      image_url = coalesce(excluded.image_url, public.places_of_interest.image_url),
      image_urls = case when cardinality(excluded.image_urls) > 0 then excluded.image_urls else public.places_of_interest.image_urls end,
      booking_url = coalesce(excluded.booking_url, public.places_of_interest.booking_url),
      source_urls = case when cardinality(excluded.source_urls) > 0 then excluded.source_urls else public.places_of_interest.source_urls end,
      content_sources = case when jsonb_array_length(excluded.content_sources) > 0 then excluded.content_sources else public.places_of_interest.content_sources end,
      opening_hours = coalesce(excluded.opening_hours, public.places_of_interest.opening_hours),
      fee = coalesce(excluded.fee, public.places_of_interest.fee),
      wheelchair = coalesce(excluded.wheelchair, public.places_of_interest.wheelchair),
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      tags = excluded.tags,
      quality_score = greatest(excluded.quality_score, public.places_of_interest.quality_score),
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

create or replace function public.discover_places_for_home_v1(
  _country_id uuid default null,
  _region_id uuid default null,
  _city_id uuid default null,
  _category_slugs text[] default null,
  _query text default null,
  _accessible_only boolean default false,
  _free_only boolean default false,
  _has_hours_only boolean default false,
  _limit integer default 36,
  _offset integer default 0
)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = off
as $function$
  with filtered as materialized (
    select place.*
    from public.places_of_interest as place
    join public.cities as city on city.id = place.city_id
    where place.is_public = true
      and (_country_id is null or place.country_id = _country_id)
      and (_region_id is null or city.region_id = _region_id)
      and (_city_id is null or place.city_id = _city_id)
      and (_category_slugs is null or place.category = any(_category_slugs))
      and (
        nullif(pg_catalog.btrim(_query), '') is null
        or place.name ilike '%' || pg_catalog.btrim(_query) || '%'
        or coalesce(place.description, '') ilike '%' || pg_catalog.btrim(_query) || '%'
        or coalesce(place.address, '') ilike '%' || pg_catalog.btrim(_query) || '%'
        or coalesce(place.subcategory, '') ilike '%' || pg_catalog.btrim(_query) || '%'
      )
      and (
        _accessible_only = false
        or lower(coalesce(place.wheelchair, '')) = any(array['yes', 'limited', 'designated'])
      )
      and (
        _free_only = false
        or lower(pg_catalog.btrim(coalesce(place.fee, ''))) ~ '^(0|false|free|gratuit|gratuito|kostenlos|no)$'
      )
      and (_has_hours_only = false or place.opening_hours is not null)
  ),
  page as materialized (
    select place.*
    from filtered as place
    order by place.quality_score desc, place.name
    limit greatest(1, least(coalesce(_limit, 36), 200))
    offset greatest(0, coalesce(_offset, 0))
  ),
  totals as (select count(*)::integer as total_count from filtered)
  select json_build_object(
    'version', 1,
    'total_count', totals.total_count,
    'has_more', greatest(0, coalesce(_offset, 0)) + (select count(*) from page) < totals.total_count,
    'items', coalesce((
      select json_agg(json_build_object(
        'id', place.id,
        'name', place.name,
        'slug', place.slug,
        'category', place.category,
        'subcategory', place.subcategory,
        'description', place.description,
        'address', place.address,
        'website', place.website,
        'source_url', place.source_url,
        'image_url', place.image_url,
        'image_urls', place.image_urls,
        'booking_url', place.booking_url,
        'source_urls', place.source_urls,
        'content_sources', place.content_sources,
        'opening_hours', place.opening_hours,
        'fee', place.fee,
        'wheelchair', place.wheelchair,
        'latitude', place.latitude,
        'longitude', place.longitude,
        'quality_score', place.quality_score
      )) from page as place
    ), '[]'::json)
  ) from totals;
$function$;

revoke all on function public.discover_places_for_home_v1(uuid, uuid, uuid, text[], text, boolean, boolean, boolean, integer, integer) from public;
grant execute on function public.discover_places_for_home_v1(uuid, uuid, uuid, text[], text, boolean, boolean, boolean, integer, integer) to anon, authenticated, service_role;

-- Extend the existing viewport RPC payloads without changing their signatures.
create or replace function public.place_to_discovery_json(place public.places_of_interest)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'id', place.id,
    'name', place.name,
    'slug', place.slug,
    'category', place.category,
    'subcategory', place.subcategory,
    'description', place.description,
    'address', place.address,
    'website', place.website,
    'source_url', place.source_url,
    'image_url', place.image_url,
    'image_urls', place.image_urls,
    'booking_url', place.booking_url,
    'source_urls', place.source_urls,
    'content_sources', place.content_sources,
    'opening_hours', place.opening_hours,
    'fee', place.fee,
    'wheelchair', place.wheelchair,
    'latitude', place.latitude,
    'longitude', place.longitude,
    'quality_score', place.quality_score
  );
$function$;

grant execute on function public.place_to_discovery_json(public.places_of_interest) to anon, authenticated, service_role;

notify pgrst, 'reload schema';