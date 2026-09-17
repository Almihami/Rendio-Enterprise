-- =============================================================================
-- Migration 0047 — el auxiliar ve EN VIVO por dónde viene su conductor.
--
-- EL HUECO: la pantalla "Conductor en camino" del auxiliar era una animación
-- (un carrito que se deslizaba de A a B en 9s). El GPS real y las anclas por
-- evento ya existen desde 0045, pero SOLO el admin los podía leer: el auxiliar
-- no tiene RLS sobre route_assignments ni driver_locations.
--
-- LA IDEA: un RPC SECURITY DEFINER — mismo patrón que driver_set_reservation_status
-- (0044/0045) — que recibe UNA reserva, valida que el llamante sea SU dueño
-- (current_auxiliar_id), y devuelve la última posición conocida del conductor que
-- la atiende + su identidad + el avance real. No se le abre driver_locations al
-- auxiliar: solo ve el punto de la reserva que es suya, vía esta función.
--
-- Enlace de datos (ya existente): reservations → route_stops.reservation_id →
-- route_assignments (driver_profile_id, vehicle_id) → driver_locations.
--
-- La posición mezcla las dos fuentes de 0045 y gana la más reciente por
-- recorded_at (source='gps' continuo/dudoso, source='anchor' discreto/cierto);
-- el frontend muestra la frescura para no creerle ciegamente a un punto viejo.
-- Idempotente.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.auxiliar_track_reservation(
  p_reservation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux         uuid := public.current_auxiliar_id();
  v_dir         public.trip_direction;
  v_raw         text;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_ra          uuid;
  v_driver      uuid;
  v_stop_status text;
  v_name        text;
  v_phone       text;
  v_plate       text;
  v_pos_lat     double precision;
  v_pos_lng     double precision;
  v_pos_src     text;
  v_pos_at      timestamptz;
BEGIN
  -- Solo un auxiliar puede rastrear, y solo SU reserva.
  IF v_aux IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT r.direction,
         COALESCE(r.status_h2a::text, r.status_a2h::text),
         r.pickup_latitude, r.pickup_longitude
    INTO v_dir, v_raw, v_pickup_lat, v_pickup_lng
  FROM public.reservations r
  WHERE r.id = p_reservation_id
    AND r.auxiliar_profile_id = v_aux
    AND r.cancelled_at IS NULL
  LIMIT 1;

  -- No existe, no es suya, o está cancelada.
  IF v_dir IS NULL THEN
    RETURN NULL;
  END IF;

  -- ¿La reserva ya quedó en una ruta ACTIVA? (el admin publicó el plan). Si no,
  -- todavía no hay conductor que rastrear: devolvemos el estado, sin posición.
  SELECT ra.id, ra.driver_profile_id, rs.status,
         pr.full_name, pr.phone,
         COALESCE(v.license_plate, v.internal_code)
    INTO v_ra, v_driver, v_stop_status, v_name, v_phone, v_plate
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
  LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
  LEFT JOIN public.vehicles v         ON v.id = ra.vehicle_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status IN ('planned', 'in_progress')
  ORDER BY ra.planned_start_at DESC NULLS LAST
  LIMIT 1;

  IF v_ra IS NULL THEN
    RETURN jsonb_build_object(
      'assigned',   false,
      'raw_status', v_raw,
      'direction',  v_dir::text,
      'pickup',     jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng)
    );
  END IF;

  -- Última posición conocida del conductor: gps o ancla, gana la más reciente.
  SELECT dl.latitude, dl.longitude, dl.source, dl.recorded_at
    INTO v_pos_lat, v_pos_lng, v_pos_src, v_pos_at
  FROM public.driver_locations dl
  WHERE dl.driver_profile_id = v_driver
  ORDER BY dl.recorded_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'assigned',    true,
    'raw_status',  v_raw,
    'direction',   v_dir,
    'stop_status', v_stop_status,
    'driver',      jsonb_build_object('name', v_name, 'phone', v_phone),
    'plate',       v_plate,
    'pickup',      jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng),
    'pos',         CASE
                     WHEN v_pos_lat IS NULL THEN NULL
                     ELSE jsonb_build_object(
                            'lat',    v_pos_lat,
                            'lng',    v_pos_lng,
                            'source', v_pos_src,
                            'at',     v_pos_at)
                   END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_track_reservation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_track_reservation(uuid) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_track_reservation(uuid)
  IS 'El auxiliar dueño de la reserva obtiene la última posición conocida (gps/ancla) del conductor que la atiende, su identidad (nombre/teléfono/placa) y el avance real. SECURITY DEFINER validado por current_auxiliar_id.';

COMMIT;
