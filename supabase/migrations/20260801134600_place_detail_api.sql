create or replace function public.get_place_detail_v1(_place_id uuid)
returns json
language sql
stable
security definer
set search_path = ''
set row_security = off
as $function$
  select coalesce(
    (
      select public.place_to_discovery_json(place)::json
      from public.places_of_interest as place
      where place.id = _place_id
        and place.is_public = true
      limit 1
    ),
    'null'::json
  );
$function$;

revoke all on function public.get_place_detail_v1(uuid) from public;
grant execute on function public.get_place_detail_v1(uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';