-- Rollback Migration 0040. Referencia. NO automático.
-- Nota: revertir los NOT NULL puede fallar si existen filas con NULL (borradores
-- o salidas sin vuelo). Limpiar/poblar esas filas antes de revertir.
BEGIN;

-- 5. app_settings: parámetros de ruteo
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS route_airport_leg_min,
  DROP COLUMN IF EXISTS route_margin_tight_min,
  DROP COLUMN IF EXISTS route_default_capacity;

-- 4. reservations.flight_id vuelve a NOT NULL
ALTER TABLE public.reservations ALTER COLUMN flight_id SET NOT NULL;

-- 3. route_stops: restaurar tope de 4
ALTER TABLE public.route_stops
  ADD CONSTRAINT route_stops_order_max_4 CHECK (stop_order <= 4);

-- 1 + 2. route_assignments: estado y NOT NULL originales
ALTER TABLE public.route_assignments DROP CONSTRAINT IF EXISTS route_assignments_status_valid;
ALTER TABLE public.route_assignments
  ADD CONSTRAINT route_assignments_status_valid
  CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled'));

ALTER TABLE public.route_assignments ALTER COLUMN vehicle_id        SET NOT NULL;
ALTER TABLE public.route_assignments ALTER COLUMN driver_profile_id SET NOT NULL;

COMMIT;
