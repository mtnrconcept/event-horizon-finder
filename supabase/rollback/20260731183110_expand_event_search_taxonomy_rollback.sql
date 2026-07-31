-- Roll back the additive search taxonomy while preserving every event and all
-- legacy music genres.

set local lock_timeout = '10s';
set local statement_timeout = '5min';

do $rollback$
declare
  v_function record;
  v_definition text;
  v_replaced text;
begin
  for v_function in
    select procedure.oid, procedure.proname
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where (
      namespace.nspname = 'public'
      and procedure.proname = any(array[
        'discover_event_rows_v2',
        'discover_event_rows_spatial_v2',
        'discover_event_rows_city_filtered_v2',
        'discover_event_rows_geography_v3',
        'discover_event_rows_in_viewport_v1',
        'discover_event_stats_v1'
      ]::text[])
    ) or (
      namespace.nspname = 'private'
      and procedure.proname = 'discover_map_event_rows_in_bounds_v1'
    )
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_function.oid);
    v_replaced := pg_catalog.regexp_replace(
      v_definition,
      '\(event\.genres[[:space:]]*&&[[:space:]]*_genres[[:space:]]+or[[:space:]]+event\.search_facets[[:space:]]*&&[[:space:]]*_genres\)',
      'event.genres && _genres',
      'gi'
    );
    if v_replaced = v_definition then
      raise exception 'search_facet_rollback_missing:%', v_function.proname;
    end if;
    execute v_replaced;
  end loop;
end;
$rollback$;

do $rollback$
declare
  v_oid oid;
  v_definition text;
  v_replaced text;
begin
  select procedure.oid
  into v_oid
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'discover_map_pins_in_bounds_v2';

  if v_oid is null then
    raise exception 'search_facet_map_rollback_function_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  v_replaced := pg_catalog.regexp_replace(
    v_definition,
    '\(point\.genres[[:space:]]*&&[[:space:]]*\$10::text\[\][[:space:]]+or[[:space:]]+point\.search_facets[[:space:]]*&&[[:space:]]*\$10::text\[\]\)',
    'point.genres && $10::text[]',
    'g'
  );
  v_replaced := pg_catalog.regexp_replace(
    v_replaced,
    '([[:space:]]+)event\.search_facets,',
    '',
    'g'
  );

  if v_replaced = v_definition then
    raise exception 'search_facet_map_rollback_patch_missing';
  end if;
  execute v_replaced;
end;
$rollback$;

drop trigger if exists zz_events_preserve_updated_at_search_backfill on public.events;
drop trigger if exists trg_events_01_infer_search_facets on public.events;
drop function if exists private.backfill_event_search_facets_range_v1(uuid, uuid);
drop function if exists private.preserve_event_updated_at_for_search_backfill();
drop function if exists public.apply_inferred_event_search_facets();
drop function if exists public.infer_event_search_facets(text, text, text, text, text[], text);
drop index if exists public.events_search_facets_gin;
alter table public.events drop column if exists search_facets;

notify pgrst, 'reload schema';
