-- =============================================================================
-- Migration 0026 — profiles.priority: agrega nivel 4 (máxima prioridad)
-- Tarea: módulo rendio-turnos.
--   1 = más nuevo … 3 = más antiguo … 4 = MÁXIMA (Julián): entra SIEMPRE primero.
--
-- A diferencia de 1–3 (desempate suave), el nivel 4 es prioridad DURA en el
-- generador (ver scheduler.js, pickForShift): el conductor 4 disponible se
-- asigna por encima de la carga y de los demás. Se asigna a mano desde Ajustes.
--
-- Solo amplía el rango del CHECK existente de [1,3] a [1,4]. Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_priority_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_priority_range CHECK (priority BETWEEN 1 AND 4);

COMMENT ON COLUMN public.profiles.priority
  IS 'rendio-turnos: prioridad por antigüedad del conductor (1=nuevo … 3=antiguo, desempate suave; 4=máxima, prioridad dura: entra siempre primero).';

COMMIT;
