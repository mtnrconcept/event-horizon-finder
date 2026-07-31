do $smoke$
declare
  v_facets text[];
  v_missing text;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'search_facets'
      and udt_name = '_text'
  ) then
    raise exception 'search_facets_column_missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'events'
      and indexname = 'events_search_facets_gin'
      and indexdef ilike '%using gin%'
  ) then
    raise exception 'search_facets_gin_missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.events'::regclass
      and tgname = 'trg_events_01_infer_search_facets'
      and tgenabled = 'O'
  ) then
    raise exception 'search_facets_trigger_missing';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.events'::regclass
      and tgname = 'zz_events_preserve_updated_at_search_backfill'
      and not tgisinternal
  ) or pg_catalog.to_regprocedure(
    'private.backfill_event_search_facets_range_v1(uuid,uuid)'
  ) is not null then
    raise exception 'search_facets_backfill_helpers_not_removed';
  end if;

  select public.infer_event_search_facets(
    'Journée au musée et jeux d''eau en famille',
    'Cinéma familial et atelier créatif',
    'Visite du site historique avec les enfants',
    'famille',
    '{}'::text[],
    null
  )
  into v_facets;

  if not v_facets @> array[
    'family', 'museums', 'water-play', 'family-cinema',
    'family-workshops', 'historical-sites', 'family-events'
  ]::text[] then
    raise exception 'search_facets_family_culture_inference_failed:%', v_facets;
  end if;

  select public.infer_event_search_facets(
    'Concert rock', null, null, 'concerts', array['rock']::text[], null
  )
  into v_facets;
  if not v_facets @> array['music']::text[] then
    raise exception 'search_facets_music_inference_failed:%', v_facets;
  end if;

  select string_agg(procedure.proname, ', ' order by procedure.proname)
  into v_missing
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = any(array[
      'discover_event_rows_v2',
      'discover_event_rows_spatial_v2',
      'discover_event_rows_city_filtered_v2',
      'discover_event_rows_geography_v3',
      'discover_event_rows_in_viewport_v1',
      'discover_event_stats_v1',
      'discover_map_pins_in_bounds_v2'
    ]::text[])
    and pg_catalog.pg_get_functiondef(procedure.oid) not ilike '%search_facets%';

  if v_missing is not null then
    raise exception 'search_facets_rpc_patch_missing:%', v_missing;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'discover_map_event_rows_in_bounds_v1'
      and pg_catalog.pg_get_functiondef(procedure.oid) not ilike '%search_facets%'
  ) then
    raise exception 'search_facets_private_viewport_patch_missing';
  end if;

  if pg_catalog.has_function_privilege(
    'anon',
    'public.infer_event_search_facets(text,text,text,text,text[],text)',
    'execute'
  ) or not pg_catalog.has_function_privilege(
    'authenticated',
    'public.infer_event_search_facets(text,text,text,text,text[],text)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.apply_inferred_event_search_facets()',
    'execute'
  ) then
    raise exception 'search_facets_internal_functions_exposed';
  end if;
end;
$smoke$;
