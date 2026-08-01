-- The venue upsert deliberately returns columns named venue_id/place_id for a
-- stable PostgREST payload. Those output variables can otherwise conflict with
-- the venue_media unique-key columns while PL/pgSQL compiles ON CONFLICT.
-- Prefer SQL columns inside this function; all procedural variables use
-- explicit *_value names, so this setting is deterministic and narrowly scoped.

alter function public.upsert_ladecadanse_venue_v1(uuid, jsonb)
  set plpgsql.variable_conflict = 'use_column';
