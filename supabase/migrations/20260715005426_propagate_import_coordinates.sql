-- New occurrence rows must be map-ready at insert time. Prefer source-level
-- coordinates when present, otherwise inherit the event venue coordinates.

create or replace function public.import_eventscrap_occurrences_batch(
  p_limit integer default 10000
)
returns integer
language plpgsql
security definer
as $function$
declare
  v_inserted integer := 0;
begin
  with src as (
    select
      coalesce(
        nullif(trim(e.event_id), ''),
        nullif(trim(e.source), '') || ':' || nullif(trim(e.source_event_id), ''),
        md5(
          coalesce(trim(e.source_url), '') || '|' ||
          coalesce(trim(e.event_name), '') || '|' ||
          coalesce(trim(e.start_datetime), '')
        )
      ) as fingerprint,
      nullif(trim(e.start_datetime), '') as start_text,
      nullif(trim(e.end_datetime), '') as end_text,
      nullif(trim(e.timezone), '') as tz,
      nullif(trim(e.latitude), '') as latitude_text,
      nullif(trim(e.longitude), '') as longitude_text,
      e.all_day is true as all_day
    from public.eventscrap e
    where nullif(trim(e.event_name), '') is not null
  ), normalized as (
    select
      s.fingerprint,
      case
        when s.start_text ~ '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?$'
          then s.start_text::timestamptz
      end as starts_at,
      case
        when s.end_text ~ '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?$'
          then s.end_text::timestamptz
      end as ends_at,
      coalesce(s.tz, 'Europe/Paris') as timezone,
      s.all_day,
      case
        when s.latitude_text ~ '^[+-]?[0-9]+([.][0-9]+)?$'
         and s.latitude_text::numeric between -90 and 90
          then s.latitude_text::double precision
      end as latitude,
      case
        when s.longitude_text ~ '^[+-]?[0-9]+([.][0-9]+)?$'
         and s.longitude_text::numeric between -180 and 180
          then s.longitude_text::double precision
      end as longitude
    from src s
  ), candidate as (
    select distinct on (e.id, n.starts_at)
      e.id as event_id,
      n.starts_at,
      n.ends_at,
      n.timezone,
      n.all_day,
      case
        when n.latitude is not null and n.longitude is not null then n.latitude
        else v.latitude
      end as latitude,
      case
        when n.latitude is not null and n.longitude is not null then n.longitude
        else v.longitude
      end as longitude,
      case
        when n.latitude is not null and n.longitude is not null then
          st_setsrid(st_makepoint(n.longitude, n.latitude), 4326)::geography
        else v.location
      end as location
    from normalized n
    join public.events e on e.canonical_fingerprint = n.fingerprint
    left join public.venues v on v.id = e.venue_id
    left join public.event_occurrences eo
      on eo.event_id = e.id
     and eo.starts_at = n.starts_at
    where n.starts_at is not null
      and eo.id is null
    order by e.id, n.starts_at
    limit p_limit
  ), ins as (
    insert into public.event_occurrences (
      event_id,
      starts_at,
      ends_at,
      timezone,
      status,
      ticket_status,
      all_day,
      time_precision,
      latitude,
      longitude,
      location,
      created_at,
      updated_at
    )
    select
      c.event_id,
      c.starts_at,
      c.ends_at,
      c.timezone,
      'scheduled'::public.occurrence_status,
      'unknown'::public.ticket_status,
      c.all_day,
      case when c.all_day then 'date' else 'exact' end,
      c.latitude,
      c.longitude,
      c.location,
      now(),
      now()
    from candidate c
    on conflict do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return coalesce(v_inserted, 0);
end;
$function$;

revoke all on function public.import_eventscrap_occurrences_batch(integer) from public;
grant execute on function public.import_eventscrap_occurrences_batch(integer) to service_role;

comment on function public.import_eventscrap_occurrences_batch(integer) is
  'Imports occurrence batches and makes each row map-ready from source or venue coordinates.';
