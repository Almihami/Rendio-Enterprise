-- =============================================================================
-- Down 0124 — El carro de la vuelta sale del turno del conductor
-- Quita los dos disparadores, sus funciones y route_assignments.plan_car. Las
-- placas que los disparadores ya pusieron en las vueltas se quedan (son las de
-- los turnos reales); una vuelta publicada sin placa sigue sin placa.
-- =============================================================================
BEGIN;
DROP TRIGGER IF EXISTS tr_shifts_vehicle_to_routes ON public.shifts;
DROP TRIGGER IF EXISTS tr_route_assignments_vehicle_from_shift ON public.route_assignments;
DROP FUNCTION IF EXISTS public.shifts_vehicle_to_routes();
DROP FUNCTION IF EXISTS public.route_assignments_vehicle_from_shift();
DROP FUNCTION IF EXISTS public.route_vehicle_from_shift(uuid, timestamptz);
ALTER TABLE public.route_assignments DROP COLUMN IF EXISTS plan_car;
COMMENT ON COLUMN public.route_assignments.vehicle_id
  IS 'Vehículo (carro) de la ruta. NULL solo en borradores tempranos; normalmente se fija al crear la ruta.';
COMMIT;
