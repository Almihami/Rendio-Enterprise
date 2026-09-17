-- =============================================================================
-- Migration 0045 — la posición del carro se ancla en los eventos del conductor.
--
-- EL PROBLEMA: el GPS del celular es poco fiable — salta, se va, se congela
-- cuando la app pasa a segundo plano. Si el mapa del admin depende solo del GPS,
-- muestra carros quietos o teletransportados.
--
-- LA IDEA: cuando el conductor marca un estado, sabemos DÓNDE está con certeza:
--   · 'at_pickup' / 'on_board' / 'no_show'      → en la dirección de la reserva
--   · 'delivered'  en casa→aeropuerto           → en el aeropuerto del vuelo
--   · 'picked_up'  en aeropuerto→casa           → en el aeropuerto del vuelo
--   · 'delivered'  en aeropuerto→casa           → en la dirección de la reserva
--   · 'en_route' / 'en_route_home'              → NO ancla (va en movimiento)
--
-- Esos eventos se insertan en driver_locations como pings source='anchor'. Así
-- el admin lee UNA sola fuente de posición y "gana el más reciente" sale solo,
-- por recorded_at. Sin mezclar dos tablas en el frontend.
--
-- De paso llena route_stops.status / actual_arrival_at / actual_pickup_at, que
-- existen desde 0003 y nunca se escribieron: son las que dan las métricas de
-- puntualidad reales (hora real de llegada vs. estimada).
--
-- Extiende la función de 0044 (misma firma, mismas validaciones). Idempotente.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. route_stops — faltaba el estado final y la hora de entrega.
--    El CHECK de 0003 solo llegaba hasta 'picked_up'.
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_stops DROP CONSTRAINT IF EXISTS route_stops_status_valid;
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_status_valid
  CHECK (status IN ('pending', 'arrived', 'picked_up', 'delivered', 'no_show'));

ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS actual_dropoff_at timestamptz;

COMMENT ON COLUMN public.route_stops.actual_arrival_at
  IS 'Hora real en que el conductor marcó "llegué" a esta parada. La escribe driver_set_reservation_status.';
COMMENT ON COLUMN public.route_stops.actual_dropoff_at
  IS 'Hora real en que el conductor entregó a este pasajero (aeropuerto o casa, según la dirección).';

-- -----------------------------------------------------------------------------
-- 2. driver_locations — de dónde viene el punto.
--    'gps'    = ping del navigator.geolocation del conductor (continuo, dudoso).
--    'anchor' = evento de estado (discreto, pero de certeza).
--    El admin usa esto para mostrar la frescura ("GPS · hace 12s" vs
--    "última parada · 05:18") en vez de creerle ciegamente al punto.
-- -----------------------------------------------------------------------------
ALTER TABLE public.driver_locations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'gps';

ALTER TABLE public.driver_locations DROP CONSTRAINT IF EXISTS driver_locations_source_valid;
ALTER TABLE public.driver_locations ADD CONSTRAINT driver_locations_source_valid
  CHECK (source IN ('gps', 'anchor'));

COMMENT ON COLUMN public.driver_locations.source
  IS 'gps = ping del dispositivo. anchor = posición cierta derivada de un evento de estado del conductor.';

-- Índice para "la última posición de cada conductor" (el read del admin).
CREATE INDEX IF NOT EXISTS idx_driver_locations_recent_all
  ON public.driver_locations(recorded_at DESC);

-- -----------------------------------------------------------------------------
-- 3. driver_set_reservation_status — ahora, además del estado en reservations:
--    (a) marca el avance de la parada con su hora real,
--    (b) deja el ancla de posición si el evento la implica.
--    Las validaciones de 0044 quedan intactas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_set_reservation_status(
  p_reservation_id uuid,
  p_status         text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver  uuid := public.current_driver_id();
  v_dir     public.trip_direction;
  v_ra      uuid;
  v_lat     double precision;
  v_lng     double precision;
  v_stop_st text;
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'solo un conductor puede actualizar el estado de una parada';
  END IF;

  -- La reserva debe estar en una ruta ACTIVA asignada a ESTE conductor.
  -- De paso traemos la ruta y las coords de la dirección (posible ancla).
  SELECT r.direction, ra.id, r.pickup_latitude, r.pickup_longitude
    INTO v_dir, v_ra, v_lat, v_lng
  FROM public.reservations r
  JOIN public.route_stops rs       ON rs.reservation_id = r.id
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE r.id = p_reservation_id
    AND ra.driver_profile_id = v_driver
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no está en una ruta activa asignada a este conductor', p_reservation_id;
  END IF;

  -- (0044) Estado en la columna que corresponde a la dirección. El cast valida.
  IF v_dir = 'home_to_airport' THEN
    UPDATE public.reservations
      SET status_h2a = p_status::public.reservation_status_h2a, updated_at = now()
      WHERE id = p_reservation_id;
  ELSE
    UPDATE public.reservations
      SET status_a2h = p_status::public.reservation_status_a2h, updated_at = now()
      WHERE id = p_reservation_id;
  END IF;

  -- (a) Avance de la parada. 'en_route'/'en_route_home' no la mueven: sigue
  --     pendiente hasta que el conductor llegue.
  v_stop_st := CASE
    WHEN p_status = 'at_pickup'               THEN 'arrived'
    WHEN p_status IN ('on_board', 'picked_up') THEN 'picked_up'
    WHEN p_status = 'delivered'               THEN 'delivered'
    WHEN p_status = 'no_show'                 THEN 'no_show'
    ELSE NULL
  END;

  IF v_stop_st IS NOT NULL THEN
    UPDATE public.route_stops rs
      SET status = v_stop_st,
          -- COALESCE: la primera marca manda. Si el conductor toca dos veces,
          -- no se pisa la hora real del evento.
          actual_arrival_at = CASE WHEN p_status IN ('at_pickup', 'no_show')
                                   THEN COALESCE(rs.actual_arrival_at, now())
                                   ELSE rs.actual_arrival_at END,
          actual_pickup_at  = CASE WHEN p_status IN ('on_board', 'picked_up')
                                   THEN COALESCE(rs.actual_pickup_at, now())
                                   ELSE rs.actual_pickup_at END,
          actual_dropoff_at = CASE WHEN p_status = 'delivered'
                                   THEN COALESCE(rs.actual_dropoff_at, now())
                                   ELSE rs.actual_dropoff_at END
      WHERE rs.reservation_id = p_reservation_id
        AND rs.route_assignment_id = v_ra;
  END IF;

  -- (b) Ancla de posición. v_lat/v_lng vienen con la dirección de la reserva;
  --     solo hay que corregir los casos que ocurren EN EL AEROPUERTO y anular
  --     los que no anclan.
  IF (v_dir = 'home_to_airport' AND p_status = 'delivered')
     OR (v_dir = 'airport_to_home' AND p_status = 'picked_up') THEN
    SELECT ap.latitude, ap.longitude INTO v_lat, v_lng
    FROM public.reservations r
    JOIN public.flights f   ON f.id  = r.flight_id
    JOIN public.airports ap ON ap.id = f.airport_id
    WHERE r.id = p_reservation_id;

    -- 0040 hizo reservations.flight_id NULLABLE: el auxiliar puede reservar antes
    -- de que se le asigne vuelo. Sin vuelo no hay aeropuerto por esa vía, así que
    -- caemos al aeropuerto de la organización del conductor. Sin este respaldo el
    -- carro no anclaría nunca al entregar (hoy TODAS las reservas están sin vuelo).
    IF v_lat IS NULL THEN
      SELECT ap.latitude, ap.longitude INTO v_lat, v_lng
      FROM public.airports ap
      JOIN public.profiles pr        ON pr.organization_id = ap.organization_id
      JOIN public.driver_profiles dp ON dp.profile_id = pr.id
      WHERE dp.id = v_driver
      LIMIT 1;
    END IF;
  ELSIF p_status NOT IN ('at_pickup', 'on_board', 'no_show', 'delivered') THEN
    -- en_route / en_route_home: va rodando, no sabemos dónde. Sin ancla.
    v_lat := NULL;
    v_lng := NULL;
  END IF;

  -- pickup_latitude es nullable: si la reserva no tiene pin, no hay ancla.
  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    INSERT INTO public.driver_locations
      (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
    VALUES (v_driver, v_ra, v_lat, v_lng, 'anchor', now());
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.driver_set_reservation_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_set_reservation_status(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.driver_set_reservation_status(uuid, text)
  IS 'El conductor asignado marca el avance de una parada. Escribe el estado en reservations, el avance real en route_stops, y deja un ancla de posición en driver_locations cuando el evento implica una ubicación cierta.';

COMMIT;
