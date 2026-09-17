-- =============================================================================
-- Migration 0049 — el auxiliar ve su POSICIÓN en la ruta (contador).
--
-- Extiende auxiliar_track_reservation (0047) para devolver, además de la posición
-- del conductor: stop_order (mi lugar en la ruta), total_stops, remaining_before
-- (recogidas pendientes ANTES de mí) y route_start (hora de salida). Con eso el
-- frontend muestra "Faltan X antes de ti / Vas N de M / Sale HH:MM" y dispara
-- "eres el siguiente" y "está por llegar". Idempotente (CREATE OR REPLACE).
--
-- "Recogido" = route_stops.status IN ('picked_up','delivered','no_show') (0045).
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.auxiliar_track_reservation(p_reservation_id uuid)
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
  v_my_order    int;
  v_route_start timestamptz;
  v_total       int;
  v_before      int;
  v_pos_lat     double precision;
  v_pos_lng     double precision;
  v_pos_src     text;
  v_pos_at      timestamptz;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text),
         r.pickup_latitude, r.pickup_longitude
    INTO v_dir, v_raw, v_pickup_lat, v_pickup_lng
  FROM public.reservations r
  WHERE r.id = p_reservation_id AND r.auxiliar_profile_id = v_aux AND r.cancelled_at IS NULL
  LIMIT 1;

  IF v_dir IS NULL THEN RETURN NULL; END IF;

  SELECT ra.id, ra.driver_profile_id, rs.status, rs.stop_order, ra.planned_start_at,
         pr.full_name, pr.phone, COALESCE(v.license_plate, v.internal_code)
    INTO v_ra, v_driver, v_stop_status, v_my_order, v_route_start, v_name, v_phone, v_plate
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
  LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
  LEFT JOIN public.vehicles v         ON v.id = ra.vehicle_id
  WHERE rs.reservation_id = p_reservation_id AND ra.status IN ('planned', 'in_progress')
  ORDER BY ra.planned_start_at DESC NULLS LAST
  LIMIT 1;

  IF v_ra IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'raw_status', v_raw, 'direction', v_dir::text,
      'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng));
  END IF;

  -- Total de paradas y cuántas faltan por recoger ANTES de la mía.
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
    'assigned', true, 'raw_status', v_raw, 'direction', v_dir, 'stop_status', v_stop_status,
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
  IS 'El auxiliar dueño obtiene posición del conductor + su posición en la ruta (stop_order/total_stops/remaining_before) + hora de salida. SECURITY DEFINER validado por current_auxiliar_id.';

COMMIT;
