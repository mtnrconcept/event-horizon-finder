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
  request_id bigint;
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

  request_id := net.http_post(
    url := 'https://xtwxmdbobehovnghfkes.supabase.co/functions/v1/global-place-discovery',
    body := request_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-global-scraper-secret', scraper_secret
    ),
    timeout_milliseconds := 120000
  );
  perform net.wake();
  return request_id;
end;
$$;

revoke all on function public.invoke_global_place_discovery(integer, uuid[])
  from public, anon, authenticated;
grant execute on function public.invoke_global_place_discovery(integer, uuid[])
  to service_role;
