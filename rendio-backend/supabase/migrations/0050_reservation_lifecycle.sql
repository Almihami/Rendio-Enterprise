-- =============================================================================
-- Migration 0050 — ciclo de vida completo de la reserva del auxiliar.
--
-- EL HUECO: el flujo solo contemplaba el "camino feliz" (pido → me asignan →
-- me recogen → califico). Todo lo que pasa cuando la realidad cambia no existía:
--
--   1. NADIE podía cancelar. `reservations.cancelled_at` existe desde 0003 y
--      todas las consultas la filtran, pero no había una sola función que la
--      escribiera. Un vuelo que se corre = llamada por WhatsApp.
--   2. "Confirmar mi recogida" (P2 del auxiliar) solo cambiaba una variable en
--      memoria del navegador. `ready_confirmed_at` (0003) estaba sin usar.
--   3. Pernocta y "reserva en firme" se preguntaban en el formulario y se
--      botaban: no había columna donde guardarlos.
--   4. El "máx. 3 min de espera" era un letrero fijo. Sin parámetro y sin la
--      hora real de llegada, no se podía contar nada.
--
-- Todo se resuelve con el mismo patrón ya establecido en 0044/0047/0048:
-- columnas + RPC SECURITY DEFINER validada por current_auxiliar_id() /
-- current_user_role(), sin abrir UPDATE amplio por RLS. Idempotente.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas en reservations
-- -----------------------------------------------------------------------------

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS is_overnight        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_firm             boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN public.reservations.is_overnight        IS 'Pernocta: el auxiliar pasa la noche fuera entre vuelos (hotel). Lo marca en el formulario.';
COMMENT ON COLUMN public.reservations.is_firm             IS 'Reserva en firme (el viaje va seguro) vs. tentativa. Lo marca el auxiliar.';
COMMENT ON COLUMN public.reservations.cancelled_by        IS 'Quién canceló: el propio auxiliar o un admin.';
COMMENT ON COLUMN public.reservations.cancellation_reason IS 'Motivo libre de la cancelación (opcional).';

-- -----------------------------------------------------------------------------
-- 2. Parámetros nuevos en app_settings (reglas de negocio, no hardcode)
-- -----------------------------------------------------------------------------

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS aux_wait_minutes   int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS aux_min_lead_hours int NOT NULL DEFAULT 6;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_wait_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_aux_wait_range
  CHECK (aux_wait_minutes BETWEEN 1 AND 60);

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_lead_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_aux_lead_range
  CHECK (aux_min_lead_hours BETWEEN 0 AND 72);

COMMENT ON COLUMN public.app_settings.aux_wait_minutes   IS 'Minutos que el conductor espera al auxiliar en el punto de recogida antes de poder marcar "no se presentó".';
COMMENT ON COLUMN public.app_settings.aux_min_lead_hours IS 'Antelación mínima recomendada para pedir un traslado. Por debajo se avisa y queda marcado como pedido tarde (no se bloquea: la operación real tiene urgencias).';

-- -----------------------------------------------------------------------------
-- 3. Cancelar una reserva — el auxiliar dueño
--
-- Además de marcarla cancelada, la SACA de las rutas activas (borra su
-- route_stop) para que el conductor no siga yendo a un punto muerto, y
-- devuelve el profile_id del conductor afectado para que el frontend le
-- mande el push. No se permite cancelar un viaje ya en curso o entregado.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auxiliar_cancel_reservation(
  p_reservation_id uuid,
  p_reason         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux    uuid := public.current_auxiliar_id();
  v_dir    public.trip_direction;
  v_raw    text;
  v_driver uuid;
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'solo un auxiliar puede cancelar su traslado';
  END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text)
    INTO v_dir, v_raw
  FROM public.reservations r
  WHERE r.id = p_reservation_id
    AND r.auxiliar_profile_id = v_aux
    AND r.cancelled_at IS NULL
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no es tuya, no existe o ya estaba cancelada', p_reservation_id;
  END IF;

  -- Ya te recogieron: el viaje está en curso o terminó, no hay nada que cancelar.
  IF v_raw IN ('on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show') THEN
    RAISE EXCEPTION 'el viaje ya está en curso o terminó; no se puede cancelar';
  END IF;

  -- Conductor afectado (si el plan ya estaba publicado) → para avisarle.
  SELECT dp.profile_id INTO v_driver
  FROM public.route_stops rs
  JOIN public.route_assignments ra    ON ra.id = rs.route_assignment_id
  JOIN public.driver_profiles   dp    ON dp.id = ra.driver_profile_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  -- Sale de las rutas que aún no terminan (la parada deja de existir).
  DELETE FROM public.route_stops rs
  USING public.route_assignments ra
  WHERE rs.route_assignment_id = ra.id
    AND rs.reservation_id = p_reservation_id
    AND ra.status <> 'completed';

  UPDATE public.reservations
     SET cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         status_h2a          = CASE WHEN v_dir = 'home_to_airport' THEN 'cancelled'::public.reservation_status_h2a ELSE NULL END,
         status_a2h          = CASE WHEN v_dir = 'airport_to_home' THEN 'cancelled'::public.reservation_status_a2h ELSE NULL END,
         updated_at          = now()
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver);
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_cancel_reservation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_cancel_reservation(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_cancel_reservation(uuid, text)
  IS 'El auxiliar dueño cancela su traslado si aún no lo han recogido. Lo saca de las rutas activas y devuelve el profile_id del conductor afectado para notificarlo.';

-- -----------------------------------------------------------------------------
-- 4. Cancelar una reserva — el admin (mismo efecto, otro actor)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_cancel_reservation(
  p_reservation_id uuid,
  p_reason         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dir    public.trip_direction;
  v_raw    text;
  v_driver uuid;
  v_aux    uuid;
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'solo un admin puede cancelar traslados de otros';
  END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text), ap.profile_id
    INTO v_dir, v_raw, v_aux
  FROM public.reservations r
  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  WHERE r.id = p_reservation_id
    AND r.cancelled_at IS NULL
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no existe o ya estaba cancelada', p_reservation_id;
  END IF;

  IF v_raw IN ('on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show') THEN
    RAISE EXCEPTION 'el viaje ya está en curso o terminó; no se puede cancelar';
  END IF;

  SELECT dp.profile_id INTO v_driver
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  JOIN public.driver_profiles   dp ON dp.id = ra.driver_profile_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  DELETE FROM public.route_stops rs
  USING public.route_assignments ra
  WHERE rs.route_assignment_id = ra.id
    AND rs.reservation_id = p_reservation_id
    AND ra.status <> 'completed';

  UPDATE public.reservations
     SET cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         status_h2a          = CASE WHEN v_dir = 'home_to_airport' THEN 'cancelled'::public.reservation_status_h2a ELSE NULL END,
         status_a2h          = CASE WHEN v_dir = 'airport_to_home' THEN 'cancelled'::public.reservation_status_a2h ELSE NULL END,
         updated_at          = now()
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver, 'auxiliar_profile_id', v_aux);
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_cancel_reservation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_reservation(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.admin_cancel_reservation(uuid, text)
  IS 'Un admin cancela el traslado de un auxiliar (vuelo caído, cambio de plan). Mismo efecto que la cancelación del auxiliar; devuelve a quién hay que avisarle.';

-- -----------------------------------------------------------------------------
-- 5. "Confirmar mi recogida" — ahora persiste de verdad
--
-- El auxiliar avisa que estará listo. Llena ready_confirmed_at (0003, hasta hoy
-- sin usar) y, en salidas (h2a), sube el estado assigned → ready, que es
-- exactamente para lo que existe ese valor del enum.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auxiliar_confirm_ready(
  p_reservation_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'solo un auxiliar puede confirmar su recogida';
  END IF;

  UPDATE public.reservations
     SET ready_confirmed_at = now(),
         status_h2a = CASE
                        WHEN direction = 'home_to_airport' AND status_h2a IN ('requested', 'assigned')
                          THEN 'ready'::public.reservation_status_h2a
                        ELSE status_h2a
                      END,
         updated_at = now()
   WHERE id = p_reservation_id
     AND auxiliar_profile_id = v_aux
     AND cancelled_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'la reserva % no es tuya, no existe o está cancelada', p_reservation_id;
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_confirm_ready(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_confirm_ready(uuid) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_confirm_ready(uuid)
  IS 'El auxiliar confirma que estará listo en el punto de recogida. Llena ready_confirmed_at y sube el estado a ready en salidas.';

-- -----------------------------------------------------------------------------
-- 6. auxiliar_track_reservation — tres datos que faltaban
--
--   · cancelled  → antes devolvía NULL para una reserva cancelada, igual que si
--                  no fuera suya; el auxiliar se quedaba mirando "en camino".
--   · arrived_at → hora REAL en que el conductor marcó "llegué" (route_stops,
--                  0045). Sin esto no hay de dónde contar la espera.
--   · wait_minutes → el parámetro de Ajustes, para que el contador y el botón
--                  "no se presentó" usen el mismo número.
--
-- Reemplaza la versión de 0049 (CREATE OR REPLACE, misma firma).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auxiliar_track_reservation(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux         uuid := public.current_auxiliar_id();
  v_dir         public.trip_direction;
  v_raw         text;
  v_cancelled   timestamptz;
  v_ready       timestamptz;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_ra          uuid;
  v_driver      uuid;
  v_stop_status text;
  v_arrived_at  timestamptz;
  v_name        text;
  v_phone       text;
  v_plate       text;
  v_my_order    int;
  v_route_start timestamptz;
  v_total       int;
  v_before      int;
  v_pos_lat     double precision;
  v_pos_lng     double precision;
  v_pos_src     text;
  v_pos_at      timestamptz;
  v_wait        int;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text),
         r.cancelled_at, r.ready_confirmed_at, r.pickup_latitude, r.pickup_longitude
    INTO v_dir, v_raw, v_cancelled, v_ready, v_pickup_lat, v_pickup_lng
  FROM public.reservations r
  WHERE r.id = p_reservation_id AND r.auxiliar_profile_id = v_aux
  LIMIT 1;

  -- No existe o no es suya.
  IF v_dir IS NULL THEN RETURN NULL; END IF;

  -- Cancelada: se lo decimos explícitamente en vez de devolver NULL.
  IF v_cancelled IS NOT NULL THEN
    RETURN jsonb_build_object('cancelled', true, 'assigned', false, 'raw_status', v_raw);
  END IF;

  SELECT aux_wait_minutes INTO v_wait FROM public.app_settings WHERE id = 'singleton';
  v_wait := COALESCE(v_wait, 5);

  SELECT ra.id, ra.driver_profile_id, rs.status, rs.actual_arrival_at, rs.stop_order,
         ra.planned_start_at, pr.full_name, pr.phone,
         COALESCE(v.license_plate, v.internal_code)
    INTO v_ra, v_driver, v_stop_status, v_arrived_at, v_my_order,
         v_route_start, v_name, v_phone, v_plate
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
  LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
  LEFT JOIN public.vehicles v         ON v.id = ra.vehicle_id
  WHERE rs.reservation_id = p_reservation_id AND ra.status IN ('planned', 'in_progress')
  ORDER BY ra.planned_start_at DESC NULLS LAST
  LIMIT 1;

  IF v_ra IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'assigned', false, 'raw_status', v_raw,
      'direction', v_dir::text, 'ready_confirmed_at', v_ready, 'wait_minutes', v_wait,
      'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng));
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE rs2.stop_order < v_my_order
                            AND rs2.status NOT IN ('picked_up', 'delivered', 'no_show'))
    INTO v_total, v_before
  FROM public.route_stops rs2
  WHERE rs2.route_assignment_id = v_ra;

  SELECT dl.latitude, dl.longitude, dl.source, dl.recorded_at
    INTO v_pos_lat, v_pos_lng, v_pos_src, v_pos_at
  FROM public.driver_locations dl
  WHERE dl.driver_profile_id = v_driver
  ORDER BY dl.recorded_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'cancelled', false, 'assigned', true, 'raw_status', v_raw, 'direction', v_dir,
    'stop_status', v_stop_status, 'arrived_at', v_arrived_at,
    'ready_confirmed_at', v_ready, 'wait_minutes', v_wait,
    'driver', jsonb_build_object('name', v_name, 'phone', v_phone),
    'plate', v_plate,
    'stop_order', v_my_order, 'total_stops', v_total, 'remaining_before', v_before,
    'route_start', v_route_start,
    'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng),
    'pos', CASE WHEN v_pos_lat IS NULL THEN NULL
                ELSE jsonb_build_object('lat', v_pos_lat, 'lng', v_pos_lng, 'source', v_pos_src, 'at', v_pos_at) END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_track_reservation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_track_reservation(uuid) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_track_reservation(uuid)
  IS 'El auxiliar dueño obtiene posición del conductor, su lugar en la ruta, si la reserva fue cancelada, la hora real de llegada del conductor y los minutos de espera configurados. SECURITY DEFINER validado por current_auxiliar_id.';

COMMIT;
