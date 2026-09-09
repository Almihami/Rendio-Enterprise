-- =============================================================================
-- Migration 0013 — profiles.can_coordinate
-- Tarea: módulo rendio-turnos — permitir que ciertos CONDUCTORES entren a la
--   rotación de Coordinación AM/PM (no solo los admins).
--
-- Default FALSE: ningún conductor coordina hasta que un admin lo active desde
-- el módulo Personal (botón "Coordina/No coordina", espejo del de admins).
-- Para role='admin' sigue mandando `is_coordinator` (0011); esta columna es
-- el equivalente para role='driver'.
--
-- RLS: el UPDATE lo cubre la policy existente p_profiles_update_admin
-- (admin de la misma organización puede actualizar perfiles). No se añade policy.
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_coordinate boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.can_coordinate
  IS 'rendio-turnos: si true, este conductor (role=driver) entra en la rotación de Coordinación del horario, igual que un admin con is_coordinator. Default false.';

COMMIT;
