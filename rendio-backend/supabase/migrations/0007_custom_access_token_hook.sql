-- =============================================================================
-- Migration 0007 — Custom Access Token Hook
-- Tarea contractual: E1.02 (parte SQL)
-- Spec: Arquitectura §6.3 (custom claims con role + organization_id en JWT).
--
-- Crea la función public.custom_access_token_hook(jsonb) que Supabase Auth
-- ejecuta al emitir cada access token, agregando 'role' y 'organization_id'
-- a los claims del JWT.
--
-- IMPORTANTE: la función se crea aquí pero NO se activa automáticamente.
-- Activación pendiente desde Supabase Dashboard:
--   Auth → Hooks (Beta) → Custom Access Token Hook → habilitar →
--   Schema: public, Function: custom_access_token_hook
-- O vía Supabase Management API. Sin esa activación, los JWT NO llevan los
-- custom claims y los helpers RLS caen al fallback de SELECT contra profiles.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id        uuid;
  v_role           text;
  v_organization   uuid;
  v_claims         jsonb;
BEGIN
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims  := COALESCE(event -> 'claims', '{}'::jsonb);

  SELECT role::text, organization_id
    INTO v_role, v_organization
  FROM public.profiles
  WHERE id = v_user_id;

  IF v_role IS NOT NULL THEN
    v_claims := v_claims
      || jsonb_build_object('role', v_role)
      || jsonb_build_object('organization_id', v_organization::text);
  END IF;

  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

-- Permisos requeridos por Supabase Auth para invocar el hook
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
GRANT USAGE  ON SCHEMA   public TO supabase_auth_admin;

-- supabase_auth_admin necesita poder leer profiles para resolver claims
GRANT SELECT ON public.profiles TO supabase_auth_admin;

-- Bypass RLS para esta lectura (la función es STABLE y solo lee role/org)
DROP POLICY IF EXISTS p_profiles_auth_admin_read ON public.profiles;
CREATE POLICY p_profiles_auth_admin_read
  ON public.profiles
  FOR SELECT TO supabase_auth_admin
  USING (true);

-- Restringir acceso a otros roles de la función (defense in depth)
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.custom_access_token_hook(jsonb) IS
  'Hook de Supabase Auth. Agrega role y organization_id a los claims del JWT al emitirlo.';

COMMIT;
