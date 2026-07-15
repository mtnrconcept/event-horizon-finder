-- Supabase projects can define default function privileges for API roles.
-- The trigger function is internal and must never be exposed as an RPC.
REVOKE ALL ON FUNCTION public.promote_real_event_geography()
  FROM PUBLIC, anon, authenticated;
