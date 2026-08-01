-- places_of_interest.location was introduced as a stored generated column.
-- Source-specific ingestion also supplies an explicit geography value, which
-- PostgreSQL rejects for generated columns. Convert it to a normal stored
-- column and keep the same invariant with a deterministic trigger so both
-- explicit and implicit writers remain compatible.

alter table public.places_of_interest
  alter column location drop expression;

create or replace function public.sync_place_location_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.latitude is null or new.longitude is null then
    new.location := null;
  elsif new.latitude between -90 and 90
    and new.longitude between -180 and 180
  then
    new.location := public.st_setsrid(
      public.st_makepoint(new.longitude, new.latitude),
      4326
    )::public.geography;
  else
    raise exception 'invalid_place_coordinates'
      using errcode = '22023';
  end if;

  return new;
end;
$function$;

revoke all on function public.sync_place_location_v1() from public, anon, authenticated;
grant execute on function public.sync_place_location_v1() to service_role;

drop trigger if exists trg_places_of_interest_sync_location
  on public.places_of_interest;

create trigger trg_places_of_interest_sync_location
before insert or update of latitude, longitude, location
on public.places_of_interest
for each row
execute function public.sync_place_location_v1();

-- Recompute every existing row once so the stored geography is guaranteed to
-- match latitude/longitude after the generated expression is removed.
update public.places_of_interest
set latitude = latitude,
    longitude = longitude;
