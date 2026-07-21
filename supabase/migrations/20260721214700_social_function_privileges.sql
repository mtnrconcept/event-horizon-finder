-- Restrict direct RPC execution of SECURITY DEFINER functions introduced by
-- the social/settings migration. PostgreSQL grants EXECUTE to PUBLIC by
-- default unless it is explicitly revoked.
BEGIN;

-- Trigger-only helper. It must never be callable from PostgREST.
REVOKE ALL ON FUNCTION public.ensure_user_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_user_settings() FROM anon;
REVOKE ALL ON FUNCTION public.ensure_user_settings() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_user_settings() TO service_role;

-- Intentional authenticated RPC. The function validates auth.uid(), rejects
-- self-follows, enforces block relationships and writes only the caller's row.
REVOKE ALL ON FUNCTION public.set_social_follow(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_social_follow(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_social_follow(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_social_follow(uuid, boolean) TO service_role;

-- Internal trigger helpers should not be directly executable by API roles.
REVOKE ALL ON FUNCTION private.update_social_save_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.update_social_share_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.can_manage_social_object(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.can_manage_social_post(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_social_post() FROM PUBLIC;

COMMIT;
