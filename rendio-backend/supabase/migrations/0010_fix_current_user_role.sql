-- =============================================================================
-- Migration 0010 — fix current_user_role() / current_user_org()
--
-- Bug: las funciones leían `auth.jwt() ->> 'role'` directo, pero ese claim
-- en los JWT de Supabase contiene 'authenticated' (rol Postgres) cuando el
-- Custom Access Token Hook no está activado. Resultado: ningún RLS reconocía
-- al admin como admin y la pestaña Solicitudes salía vacía.
--
-- Fix: aceptar el claim solo si pertenece al enum public.user_role; si no,
-- caer al fallback (lookup en profiles).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claim_role text;
  fallback_role text;
BEGIN
  claim_role := nullif((auth.jwt() ->> 'role'), '');
  IF claim_role IS NOT NULL AND claim_role IN ('admin', 'driver', 'auxiliar') THEN
    RETURN claim_role;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT role::text INTO fallback_role
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN fallback_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claim_org text;
  fallback_org uuid;
BEGIN
  claim_org := nullif((auth.jwt() ->> 'organization_id'), '');
  IF claim_org IS NOT NULL THEN
    BEGIN
      RETURN claim_org::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      -- el claim no es un UUID válido; cae al fallback
      NULL;
    END;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT organization_id INTO fallback_org
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN fallback_org;
END;
$$;

COMMIT;
