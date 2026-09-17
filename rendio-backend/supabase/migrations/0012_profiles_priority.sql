-- =============================================================================
-- Migration 0012 — profiles.priority
-- Tarea: módulo rendio-turnos — prioridad por antigüedad del conductor.
--   1 = más nuevo, 2 = ya lleva tiempo, 3 = más antiguo.
--
-- Influye de forma SUAVE en la generación del horario: solo decide cuando hay
-- empate de carga y de preferencia (ver scheduler.js). No rompe la equidad.
--
-- Default 1: todos arrancan en prioridad 1; el admin sube a mano a los
-- antiguos desde el módulo Ajustes. Conceptualmente solo aplica a
-- role = 'driver', pero la columna vive en toda la tabla por simplicidad.
--
-- RLS: el UPDATE lo cubre la policy existente p_profiles_update_admin
-- (admin de la misma organización puede actualizar perfiles). No se añade policy.
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 1;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_priority_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_priority_range CHECK (priority BETWEEN 1 AND 3);

COMMENT ON COLUMN public.profiles.priority
  IS 'rendio-turnos: prioridad por antigüedad del conductor (1=nuevo … 3=antiguo). Desempate suave en la generación del horario.';

COMMIT;
