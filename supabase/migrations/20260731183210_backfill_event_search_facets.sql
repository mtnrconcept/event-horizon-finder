-- Enrich the searchable catalogue in bounded, idempotent primary-key ranges.
-- The preceding DDL migration has already released its table lock, installed
-- inference for concurrent writes and prepared a temporary timestamp guard.

set statement_timeout = '90s';
set lock_timeout = '10s';

create or replace function private.backfill_event_search_facets_range_v1(
  _lower_bound uuid,
  _upper_bound uuid default null
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_affected_rows bigint := 0;
begin
  if _lower_bound is null
    or (_upper_bound is not null and _lower_bound >= _upper_bound)
  then
    raise exception 'invalid_event_search_facet_backfill_bounds';
  end if;

  with candidates as materialized (
    select
      event.id,
      public.infer_event_search_facets(
        event.title,
        event.short_description,
        event.description,
        category.slug,
        event.genres,
        event.age_restriction
      ) as search_facets
    from public.events as event
    join public.event_categories as category on category.id = event.category_id
    where event.id >= _lower_bound
      and (_upper_bound is null or event.id < _upper_bound)
      and event.is_demo = false
      and event.status in ('published', 'cancelled', 'postponed', 'sold_out')
      and exists (
        select 1
        from public.event_occurrences as occurrence
        where occurrence.event_id = event.id
          and occurrence.starts_at >= current_date - interval '1 day'
      )
  )
  update public.events as event
  set search_facets = candidate.search_facets
  from candidates as candidate
  where event.id = candidate.id
    and event.search_facets is distinct from candidate.search_facets;

  get diagnostics v_affected_rows = row_count;
  return v_affected_rows;
end;
$function$;

revoke all on function private.backfill_event_search_facets_range_v1(uuid, uuid)
  from public, anon, authenticated;

select private.backfill_event_search_facets_range_v1(
  '00000000-0000-0000-0000-000000000000',
  '10000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '10000000-0000-0000-0000-000000000000',
  '20000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '20000000-0000-0000-0000-000000000000',
  '30000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '30000000-0000-0000-0000-000000000000',
  '40000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '40000000-0000-0000-0000-000000000000',
  '50000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '50000000-0000-0000-0000-000000000000',
  '60000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '60000000-0000-0000-0000-000000000000',
  '70000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '70000000-0000-0000-0000-000000000000',
  '80000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '80000000-0000-0000-0000-000000000000',
  '90000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  '90000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'a0000000-0000-0000-0000-000000000000',
  'b0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'b0000000-0000-0000-0000-000000000000',
  'c0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'c0000000-0000-0000-0000-000000000000',
  'd0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'd0000000-0000-0000-0000-000000000000',
  'e0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'e0000000-0000-0000-0000-000000000000',
  'f0000000-0000-0000-0000-000000000000'
);
select private.backfill_event_search_facets_range_v1(
  'f0000000-0000-0000-0000-000000000000',
  null
);

drop trigger if exists zz_events_preserve_updated_at_search_backfill on public.events;
drop function if exists private.preserve_event_updated_at_for_search_backfill();
drop function if exists private.backfill_event_search_facets_range_v1(uuid, uuid);

-- Patch the active functions in place so signatures, result shapes, grants
-- and optimized execution paths remain unchanged. Every replacement is
-- asserted to prevent a silent partial rollout.
do $migration$
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
      'event\.genres[[:space:]]*&&[[:space:]]*_genres',
      '(event.genres && _genres or event.search_facets && _genres)',
      'gi'
    );
    if v_replaced = v_definition then
      raise exception 'search_facet_patch_missing:%', v_function.proname;
    end if;
    execute v_replaced;
  end loop;
end;
$migration$;

do $migration$
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
    raise exception 'search_facet_map_function_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  v_replaced := pg_catalog.regexp_replace(
    v_definition,
    '([[:space:]]+)event\.genres,',
    E'\\1event.genres,\\1event.search_facets,',
    'g'
  );
  v_replaced := pg_catalog.regexp_replace(
    v_replaced,
    'point\.genres[[:space:]]*&&[[:space:]]*\$10::text\[\]',
    '(point.genres && $10::text[] or point.search_facets && $10::text[])',
    'g'
  );

  if v_replaced = v_definition
    or pg_catalog.strpos(v_replaced, 'point.search_facets && $10::text[]') = 0
    or pg_catalog.strpos(v_replaced, 'event.search_facets') = 0
  then
    raise exception 'search_facet_map_patch_missing';
  end if;
  execute v_replaced;
end;
$migration$;

notify pgrst, 'reload schema';
