-- Rollback de 0010: restaura el comportamiento original de 0004.
-- (Útil solo si se revierte por completo el módulo de turnos.)

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
  IF claim_role IS NOT NULL THEN
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
    RETURN claim_org::uuid;
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
