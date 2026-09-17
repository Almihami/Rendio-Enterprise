-- =============================================================================
-- Migration 0003 — operaciones (vuelos, reservas, ruteo, tracking)
-- Tarea contractual: E1.06
-- Spec: Arquitectura §5.4 (flights, reservations, route_assignments,
--       route_stops, driver_locations).
--
-- Decisión de scope: el backlog literal lista flights + reservations +
-- route_assignments + route_stops. Incluyo también driver_locations en esta
-- migration porque es parte del mismo flujo "ruta en ejecución + tracking"
-- y E1.07 necesita poder activarle RLS (sin requerir esperar a 0006).
-- shifts/inspections/incidents quedan para 0006 según E2.01.
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Tabla: flights
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.flights (
  id                  uuid                NOT NULL DEFAULT gen_random_uuid(),
  airport_id          uuid                NOT NULL REFERENCES public.airports(id) ON DELETE RESTRICT,
  flight_number       text                NOT NULL,
  direction           public.trip_direction NOT NULL,
  scheduled_at        timestamptz         NOT NULL,
  actual_at           timestamptz,
  status              public.flight_status NOT NULL DEFAULT 'scheduled',
  terminal            text,
  gate                text,
  required_auxiliars  int                 NOT NULL DEFAULT 1,
  created_at          timestamptz         NOT NULL DEFAULT now(),
  updated_at          timestamptz         NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT flights_airport_number_scheduled_unique UNIQUE (airport_id, flight_number, scheduled_at),
  CONSTRAINT flights_required_aux_positive CHECK (required_auxiliars > 0)
);

CREATE INDEX IF NOT EXISTS idx_flights_airport_id    ON public.flights(airport_id);
CREATE INDEX IF NOT EXISTS idx_flights_scheduled_at  ON public.flights(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_flights_status        ON public.flights(status);
CREATE INDEX IF NOT EXISTS idx_flights_direction     ON public.flights(direction);

DROP TRIGGER IF EXISTS tr_flights_set_updated_at ON public.flights;
CREATE TRIGGER tr_flights_set_updated_at
  BEFORE UPDATE ON public.flights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flights ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: reservations
-- CHECK direccional: status_h2a/a2h debe coincidir con direction.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reservations (
  id                    uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
  auxiliar_profile_id   uuid                            NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE RESTRICT,
  flight_id             uuid                            NOT NULL REFERENCES public.flights(id) ON DELETE RESTRICT,
  direction             public.trip_direction           NOT NULL,
  status_h2a            public.reservation_status_h2a,
  status_a2h            public.reservation_status_a2h,
  pickup_address        text                            NOT NULL,
  pickup_latitude       double precision,
  pickup_longitude      double precision,
  calculated_pickup_at  timestamptz,
  required_arrival_at   timestamptz                     NOT NULL,
  ready_confirmed_at    timestamptz,
  disembark_gate        text,
  notes                 text,
  cancelled_at          timestamptz,
  created_at            timestamptz                     NOT NULL DEFAULT now(),
  updated_at            timestamptz                     NOT NULL DEFAULT now(),
  CONSTRAINT reservations_status_matches_direction CHECK (
       (direction = 'home_to_airport' AND status_h2a IS NOT NULL AND status_a2h IS NULL)
    OR (direction = 'airport_to_home' AND status_a2h IS NOT NULL AND status_h2a IS NULL)
  ),
  CONSTRAINT reservations_pickup_lat_range CHECK (pickup_latitude  IS NULL OR pickup_latitude  BETWEEN -90  AND 90),
  CONSTRAINT reservations_pickup_lon_range CHECK (pickup_longitude IS NULL OR pickup_longitude BETWEEN -180 AND 180),
  CONSTRAINT reservations_disembark_gate_only_a2h CHECK (
       direction = 'airport_to_home' OR disembark_gate IS NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_reservations_aux_profile     ON public.reservations(auxiliar_profile_id);
CREATE INDEX IF NOT EXISTS idx_reservations_flight          ON public.reservations(flight_id);
CREATE INDEX IF NOT EXISTS idx_reservations_direction       ON public.reservations(direction);
CREATE INDEX IF NOT EXISTS idx_reservations_status_h2a      ON public.reservations(status_h2a) WHERE status_h2a IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_status_a2h      ON public.reservations(status_a2h) WHERE status_a2h IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_required_arrive ON public.reservations(required_arrival_at);

DROP TRIGGER IF EXISTS tr_reservations_set_updated_at ON public.reservations;
CREATE TRIGGER tr_reservations_set_updated_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: route_assignments
-- Una ruta asignada a un conductor con uno o más auxiliares (máx 4 vía
-- restricción funcional en INSERT a route_stops + capacidad del vehículo).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_assignments (
  id                  uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_profile_id   uuid                  NOT NULL REFERENCES public.driver_profiles(id) ON DELETE RESTRICT,
  vehicle_id          uuid                  NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  flight_id           uuid                  REFERENCES public.flights(id) ON DELETE SET NULL,
  direction           public.trip_direction NOT NULL,
  planned_start_at    timestamptz,
  actual_start_at     timestamptz,
  actual_end_at       timestamptz,
  status              text                  NOT NULL DEFAULT 'planned',
  total_distance_m    int,
  total_duration_s    int,
  encoded_polyline    text,
  created_at          timestamptz           NOT NULL DEFAULT now(),
  updated_at          timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT route_assignments_status_valid
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT route_assignments_distance_non_negative CHECK (total_distance_m IS NULL OR total_distance_m >= 0),
  CONSTRAINT route_assignments_duration_non_negative CHECK (total_duration_s IS NULL OR total_duration_s >= 0)
);

CREATE INDEX IF NOT EXISTS idx_route_assignments_driver  ON public.route_assignments(driver_profile_id);
CREATE INDEX IF NOT EXISTS idx_route_assignments_vehicle ON public.route_assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_route_assignments_flight  ON public.route_assignments(flight_id);
CREATE INDEX IF NOT EXISTS idx_route_assignments_status  ON public.route_assignments(status);

DROP TRIGGER IF EXISTS tr_route_assignments_set_updated_at ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_set_updated_at
  BEFORE UPDATE ON public.route_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.route_assignments ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: route_stops
-- Cada parada de una ruta. UNIQUE (route_assignment_id, stop_order) y
-- (route_assignment_id, reservation_id).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_stops (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  route_assignment_id   uuid        NOT NULL REFERENCES public.route_assignments(id) ON DELETE CASCADE,
  reservation_id        uuid        NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  stop_order            int         NOT NULL,
  estimated_arrival_at  timestamptz,
  actual_arrival_at     timestamptz,
  actual_pickup_at      timestamptz,
  status                text        NOT NULL DEFAULT 'pending',
  CONSTRAINT route_stops_order_unique         UNIQUE (route_assignment_id, stop_order),
  CONSTRAINT route_stops_reservation_unique   UNIQUE (route_assignment_id, reservation_id),
  CONSTRAINT route_stops_status_valid         CHECK (status IN ('pending', 'arrived', 'picked_up', 'no_show')),
  CONSTRAINT route_stops_order_positive       CHECK (stop_order > 0),
  CONSTRAINT route_stops_order_max_4          CHECK (stop_order <= 4)
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route       ON public.route_stops(route_assignment_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_reservation ON public.route_stops(reservation_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_status      ON public.route_stops(status);

ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: driver_locations (timeseries para Realtime tracking)
-- Política de retención: 7 días vía pg_cron job (a configurar en E3).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_locations (
  id                    bigint           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_profile_id     uuid             NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  route_assignment_id   uuid             REFERENCES public.route_assignments(id) ON DELETE SET NULL,
  latitude              double precision NOT NULL,
  longitude             double precision NOT NULL,
  heading               real,
  speed_kmh             real,
  recorded_at           timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT driver_locations_lat_range   CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT driver_locations_lon_range   CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT driver_locations_speed_valid CHECK (speed_kmh IS NULL OR speed_kmh >= 0)
);

CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_recent ON public.driver_locations(driver_profile_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_locations_route         ON public.driver_locations(route_assignment_id) WHERE route_assignment_id IS NOT NULL;

ALTER TABLE public.driver_locations ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Comentarios
-- -----------------------------------------------------------------------------

COMMENT ON TABLE public.flights           IS 'Vuelos. En MVP carga manual; en V1 sync vía API.';
COMMENT ON TABLE public.reservations      IS 'Solicitud de transporte de un auxiliar para un vuelo. Direccional h2a/a2h.';
COMMENT ON TABLE public.route_assignments IS 'Ruta asignada a un conductor con 1-4 auxiliares.';
COMMENT ON TABLE public.route_stops       IS 'Paradas ordenadas de una ruta. Máx 4 por capacidad de vehículo.';
COMMENT ON TABLE public.driver_locations  IS 'Stream de GPS para Realtime tracking. Retención 7 días vía pg_cron.';

COMMIT;
