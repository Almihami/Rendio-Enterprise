-- =============================================================================
-- Migration 0040 — planeación de rutas de auxiliares (admin)
-- Tarea: feature de rutas (casa↔aeropuerto MDE) — pantalla de Asignación.
--
-- Ajusta el schema operativo de 0003 para soportar el flujo real de planeación:
--
--   1. route_assignments.driver_profile_id NULLABLE + estado 'draft'.
--      Decisión de producto: el admin ARMA la ruta primero (carro + paradas) y
--      asigna el conductor AL FINAL. Antes driver_profile_id era NOT NULL, lo que
--      impedía guardar una ruta en borrador sin conductor.
--   2. route_assignments.vehicle_id NULLABLE.
--      Permite un borrador antes de fijar el carro (aunque el flujo normal fija
--      el carro desde el inicio: cada "lane" del tablero es un vehículo).
--   3. route_stops: quitar el CHECK rígido stop_order <= 4.
--      El tope real es la capacidad del vehículo (variable, vehicles.capacity) y
--      una parada puede llevar varias personas. La capacidad se valida en la app.
--   4. reservations.flight_id NULLABLE.
--      Las SALIDAS (home_to_airport) se rigen por "hora de presentación" y pueden
--      no traer número de vuelo; obligar flight_id estorbaba ese caso.
--   5. app_settings: parámetros de ruteo (singleton, leídos vía getSettings).
--      El front tolera que no existan (usa defaults), así que es aditivo y seguro.
--
-- RLS: no crea tablas nuevas; las policies de 0004/0023 (admin mutate, driver
--      select propio) ya cubren route_assignments/route_stops/reservations/flights.
-- Idempotente.
-- =============================================================================

BEGIN;

-- 1 + 2. route_assignments: driver y vehicle nullable, estado 'draft' --------
ALTER TABLE public.route_assignments ALTER COLUMN driver_profile_id DROP NOT NULL;
ALTER TABLE public.route_assignments ALTER COLUMN vehicle_id        DROP NOT NULL;

ALTER TABLE public.route_assignments DROP CONSTRAINT IF EXISTS route_assignments_status_valid;
ALTER TABLE public.route_assignments
  ADD CONSTRAINT route_assignments_status_valid
  CHECK (status IN ('draft', 'planned', 'in_progress', 'completed', 'cancelled'));

COMMENT ON COLUMN public.route_assignments.driver_profile_id
  IS 'Conductor asignado. NULL mientras la ruta está en borrador (status=draft): se asigna al final.';
COMMENT ON COLUMN public.route_assignments.vehicle_id
  IS 'Vehículo (carro) de la ruta. NULL solo en borradores tempranos; normalmente se fija al crear la ruta.';

-- 3. route_stops: quitar el tope rígido de 4 paradas -------------------------
ALTER TABLE public.route_stops DROP CONSTRAINT IF EXISTS route_stops_order_max_4;
-- (stop_order > 0 se conserva vía route_stops_order_positive; el máximo lo
--  impone la capacidad del vehículo, validada en la app.)

-- 4. reservations.flight_id nullable -----------------------------------------
ALTER TABLE public.reservations ALTER COLUMN flight_id DROP NOT NULL;
COMMENT ON COLUMN public.reservations.flight_id
  IS 'Vuelo asociado. NULL permitido para SALIDAS sin número de vuelo (se rigen por required_arrival_at = hora de presentación).';

-- 5. app_settings: parámetros de ruteo ---------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_airport_leg_min   smallint NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS route_margin_tight_min  smallint NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS route_default_capacity  smallint NOT NULL DEFAULT 4;

COMMENT ON COLUMN public.app_settings.route_airport_leg_min
  IS 'Rutas: minutos estimados del último tramo (última parada → aeropuerto MDE). Default 16.';
COMMENT ON COLUMN public.app_settings.route_margin_tight_min
  IS 'Rutas: holgura (min) bajo la cual una ruta pasa de "a tiempo" a "ajustado". Default 15.';
COMMENT ON COLUMN public.app_settings.route_default_capacity
  IS 'Rutas: capacidad por carro por defecto cuando vehicles.capacity no aplica. Default 4.';

COMMIT;
