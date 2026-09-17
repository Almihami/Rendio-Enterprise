-- Down de 0026 — vuelve el rango de priority a [1,3].
-- OJO: si hay conductores con priority = 4, este down fallará por el CHECK.
-- Bájalos a 3 antes de revertir:  UPDATE public.profiles SET priority = 3 WHERE priority = 4;

BEGIN;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_priority_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_priority_range CHECK (priority BETWEEN 1 AND 3);

COMMENT ON COLUMN public.profiles.priority
  IS 'rendio-turnos: prioridad por antigüedad del conductor (1=nuevo … 3=antiguo). Desempate suave en la generación del horario.';

COMMIT;
