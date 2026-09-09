-- Rollback Migration 0007. Referencia. NO automático.
BEGIN;
DROP POLICY   IF EXISTS p_profiles_auth_admin_read ON public.profiles;
REVOKE SELECT ON public.profiles FROM supabase_auth_admin;
DROP FUNCTION IF EXISTS public.custom_access_token_hook(jsonb);
COMMIT;
