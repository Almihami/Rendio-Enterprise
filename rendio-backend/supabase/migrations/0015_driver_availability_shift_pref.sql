-- =============================================================================
-- Migration 0015 — driver_availability.shift_pref
-- Tarea: módulo rendio-turnos — preferencia de jornada (AM / PM / Indistinto)
--   por DÍA. El conductor marca "Disponible" y, opcionalmente, prefiere una
--   jornada. El generador la respeta como sesgo SUAVE (desempate después de
--   carga, antes de prioridad por antigüedad). Si AM o PM están en
--   prefer_rest/unavailable, la preferencia para ese día se ignora (no aplica).
--
-- Valores: 'am' | 'pm' | 'any' (default 'any' = sin preferencia, comportamiento previo).
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.driver_availability
  ADD COLUMN IF NOT EXISTS shift_pref text NOT NULL DEFAULT 'any';

-- CHECK como constraint nombrada para poder soltarla en el down.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'driver_availability_shift_pref_check'
  ) THEN
    ALTER TABLE public.driver_availability
      ADD CONSTRAINT driver_availability_shift_pref_check
      CHECK (shift_pref IN ('am', 'pm', 'any'));
  END IF;
END $$;

COMMENT ON COLUMN public.driver_availability.shift_pref
  IS 'rendio-turnos: preferencia de jornada del conductor para ese día (am/pm/any). Sesgo suave en el generador.';

COMMIT;
