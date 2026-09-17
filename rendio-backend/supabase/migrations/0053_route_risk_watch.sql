-- 0053_route_risk_watch.sql
--
-- Vigilante de rutas en curso.
--
-- El módulo administrativo asume que un jefe está mirando la pantalla. A las 4
-- de la mañana no hay nadie mirando, y es justo cuando el carro puede quedarse
-- atascado camino a una recogida. Hoy nadie se entera hasta que el auxiliar
-- llama preguntando dónde está el carro.
--
-- Esta migración pone a la base a vigilar sola: cada pocos minutos compara
-- dónde está de verdad cada conductor (driver_locations) contra la hora a la
-- que se comprometió cada parada pendiente. Si no alcanza, deja la alerta.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, A PROPÓSITO: no mueve ninguna parada de carro.
-- Solo detecta y avisa. La reasignación automática viene después, cuando este
-- detector demuestre que acierta — si se equivoca, se equivoca de madrugada con
-- gente esperando en la calle.
--
-- Por qué la distancia se calcula aquí y no con TomTom: el vigilante corre cada
-- 5 minutos sobre todas las rutas activas; pedir tiempos reales en cada pasada
-- quemaría la cuota. Para decidir "no alcanza" basta la línea recta corregida,
-- que es el mismo modelo de respaldo que ya usa el asignador.

-- -----------------------------------------------------------------------------
-- 1. Parámetros (Ajustes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_risk_threshold_min smallint NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS route_risk_speed_kmh     smallint NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS route_risk_stale_min     smallint NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.app_settings.route_risk_threshold_min
  IS 'Minutos de retraso previsto a partir de los cuales una parada se marca en riesgo.';
COMMENT ON COLUMN public.app_settings.route_risk_speed_kmh
  IS 'Velocidad promedio (km/h) para estimar cuánto tarda el carro desde donde está. El mismo supuesto del asignador.';
COMMENT ON COLUMN public.app_settings.route_risk_stale_min
  IS 'Si el último GPS del conductor es más viejo que esto, no se juzga la ruta: no se puede afirmar que va tarde con un punto viejo.';

DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_risk_threshold_range
    CHECK (route_risk_threshold_min BETWEEN 1 AND 120);
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_risk_speed_range
    CHECK (route_risk_speed_kmh BETWEEN 5 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

-- -----------------------------------------------------------------------------
-- 2. Alertas detectadas
--    Una fila por parada en riesgo. UNIQUE por parada para que el vigilante
--    pueda correr cada 5 minutos sin llenar la tabla de repetidos: si la
--    situación empeora se actualiza la misma fila.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_stop_risks (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  route_stop_id       uuid        NOT NULL REFERENCES public.route_stops(id) ON DELETE CASCADE,
  reservation_id      uuid        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  driver_profile_id   uuid        REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  minutes_late        smallint    NOT NULL,
  distance_km         numeric(6,2),
  driver_seen_at      timestamptz,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  notified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_stop_risks_stop_unique UNIQUE (route_stop_id)
);

CREATE INDEX IF NOT EXISTS idx_route_stop_risks_open
  ON public.route_stop_risks(detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_stop_risks_reservation
  ON public.route_stop_risks(reservation_id);

DROP TRIGGER IF EXISTS tr_route_stop_risks_set_updated_at ON public.route_stop_risks;
CREATE TRIGGER tr_route_stop_risks_set_updated_at
  BEFORE UPDATE ON public.route_stop_risks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.route_stop_risks ENABLE ROW LEVEL SECURITY;

-- El admin ve todo (es su tablero de operación). El auxiliar ve SOLO el riesgo
-- de su propio traslado: es su viaje y tiene derecho a saber que va demorado.
-- Nadie escribe desde el cliente: esto lo llena el vigilante.
DROP POLICY IF EXISTS route_stop_risks_select ON public.route_stop_risks;
CREATE POLICY route_stop_risks_select ON public.route_stop_risks
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.id = route_stop_risks.reservation_id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 3. El vigilante
--    Recorre las paradas PENDIENTES de rutas en curso y decide si se alcanzan.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_route_risks()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_thr    smallint;
  v_speed  smallint;
  v_stale  smallint;
  v_nuevas integer := 0;
BEGIN
  SELECT COALESCE(route_risk_threshold_min, 10), COALESCE(route_risk_speed_kmh, 30),
         COALESCE(route_risk_stale_min, 15)
    INTO v_thr, v_speed, v_stale
  FROM public.app_settings WHERE id = 'singleton';
  v_thr := COALESCE(v_thr, 10); v_speed := COALESCE(v_speed, 30); v_stale := COALESCE(v_stale, 15);

  WITH pos AS (
    -- Último punto conocido de cada conductor.
    SELECT DISTINCT ON (dl.driver_profile_id)
           dl.driver_profile_id, dl.latitude, dl.longitude, dl.recorded_at
    FROM public.driver_locations dl
    ORDER BY dl.driver_profile_id, dl.recorded_at DESC
  ),
  pend AS (
    SELECT rs.id            AS stop_id,
           rs.reservation_id,
           ra.driver_profile_id,
           r.pickup_latitude, r.pickup_longitude,
           -- La hora a la que hay que estar ahí: la estimada del plan si existe;
           -- si no, la de presentación del vuelo (que es el compromiso duro).
           COALESCE(rs.estimated_arrival_at, r.required_arrival_at) AS due_at,
           p.latitude AS drv_lat, p.longitude AS drv_lng, p.recorded_at AS seen_at
    FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    JOIN public.reservations r       ON r.id = rs.reservation_id
    LEFT JOIN pos p                  ON p.driver_profile_id = ra.driver_profile_id
    WHERE ra.status = 'in_progress'
      AND rs.status = 'pending'
      AND r.cancelled_at IS NULL
      AND r.pickup_latitude IS NOT NULL
      -- Sin GPS fresco no se juzga: afirmar "va tarde" con un punto de hace
      -- media hora es inventar. Mejor callar que alarmar en falso.
      AND p.recorded_at IS NOT NULL
      AND p.recorded_at > now() - make_interval(mins => v_stale)
  ),
  calc AS (
    SELECT pend.*,
           -- Distancia en línea recta ×1.4 (desvío real de las vías del Oriente),
           -- el mismo factor que usa el asignador cuando no hay ruta real.
           (6371 * acos(LEAST(1, GREATEST(-1,
              cos(radians(drv_lat)) * cos(radians(pickup_latitude)) *
              cos(radians(pickup_longitude) - radians(drv_lng)) +
              sin(radians(drv_lat)) * sin(radians(pickup_latitude))
           ))) * 1.4) AS km
    FROM pend
  ),
  eval AS (
    SELECT calc.*,
           km / NULLIF(v_speed, 0) * 60.0 AS min_viaje,
           EXTRACT(EPOCH FROM (due_at - now())) / 60.0 AS min_disponibles
    FROM calc
  ),
  risky AS (
    SELECT stop_id, reservation_id, driver_profile_id, km, seen_at,
           CEIL(min_viaje - min_disponibles)::smallint AS late
    FROM eval
    WHERE min_viaje - min_disponibles >= v_thr
  ),
  ins AS (
    INSERT INTO public.route_stop_risks
      (route_stop_id, reservation_id, driver_profile_id, minutes_late, distance_km, driver_seen_at)
    SELECT stop_id, reservation_id, driver_profile_id, late, ROUND(km::numeric, 2), seen_at FROM risky
    ON CONFLICT (route_stop_id) DO UPDATE
      SET minutes_late = EXCLUDED.minutes_late,
          distance_km  = EXCLUDED.distance_km,
          driver_seen_at = EXCLUDED.driver_seen_at,
          -- Si se había dado por resuelta y vuelve a estar en riesgo, se reabre.
          resolved_at  = NULL,
          detected_at  = CASE WHEN public.route_stop_risks.resolved_at IS NOT NULL
                              THEN now() ELSE public.route_stop_risks.detected_at END
    RETURNING 1
  )
  SELECT count(*) INTO v_nuevas FROM ins;

  -- Se cierran solas las que ya no aplican: la parada se atendió, se canceló,
  -- o el carro se puso al día. Una alerta que no se cierra sola deja de creerse.
  UPDATE public.route_stop_risks k
     SET resolved_at = now()
   WHERE k.resolved_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.route_stops rs
       JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
       WHERE rs.id = k.route_stop_id AND rs.status = 'pending' AND ra.status = 'in_progress'
     );

  RETURN v_nuevas;
END;
$$;

REVOKE ALL ON FUNCTION public.detect_route_risks() FROM PUBLIC;
COMMENT ON FUNCTION public.detect_route_risks()
  IS 'Marca las paradas pendientes que el conductor no alcanza desde su posición real. Solo detecta: no mueve paradas de carro. Para correr por pg_cron.';

-- -----------------------------------------------------------------------------
-- 4. pg_cron — cada 5 minutos (best-effort, igual que el auto-cierre de turnos).
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  BEGIN
    PERFORM cron.unschedule('detect-route-risks');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM cron.schedule('detect-route-risks', '*/5 * * * *', $job$SELECT public.detect_route_risks();$job$);
  RAISE NOTICE 'pg_cron: job "detect-route-risks" programado cada 5 minutos.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible/sin permisos (%). El vigilante queda inactivo hasta programarlo.', SQLERRM;
END
$do$;
