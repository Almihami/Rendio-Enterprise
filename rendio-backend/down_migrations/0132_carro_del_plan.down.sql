-- Reversa de 0132 · El carro del plan y el aviso si sale en otro.
-- Quita el disparador, su función y la columna (se pierde qué carro decía el plan;
-- la placa real de cada vuelta, vehicle_id, no se toca).
BEGIN;
DROP TRIGGER IF EXISTS tr_shifts_plan_vehicle_alert ON public.shifts;
DROP FUNCTION IF EXISTS public.shifts_plan_vehicle_alert();
ALTER TABLE public.route_assignments DROP COLUMN IF EXISTS plan_vehicle_id;
COMMIT;
