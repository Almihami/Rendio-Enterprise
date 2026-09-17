-- =============================================================================
-- Migration 0011 — profiles.is_coordinator
-- Tarea: módulo rendio-turnos — marca qué admins entran a la rotación de
--   Coordinación AM/PM del horario. Un "admin de sistema" puede seguir siendo
--   admin sin coordinar (is_coordinator = false).
--
-- Default true: los admins existentes siguen coordinando hasta que el flag se
-- apague desde el módulo Personal. Solo es relevante para role = 'admin'.
--
-- RLS: el UPDATE lo cubre la policy existente p_profiles_update_admin
-- (admin de la misma organización puede actualizar perfiles). No se añade policy.
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_coordinator boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.is_coordinator
  IS 'Solo aplica a role=admin: si true, el admin entra en la rotación de Coordinación del horario (rendio-turnos).';

COMMIT;
