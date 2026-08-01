-- pg_trgm is installed in the public schema in the managed Supabase runtime.
-- The source-specific venue upsert otherwise keeps an empty search_path, so the
-- extension function cannot be resolved when its fuzzy fallback is exercised.
-- CREATE on public is revoked from untrusted application roles in this project;
-- keeping pg_catalog first also prevents accidental shadowing of built-ins.

alter function public.upsert_ladecadanse_venue_v1(uuid, jsonb)
  set search_path = 'pg_catalog', 'public';
