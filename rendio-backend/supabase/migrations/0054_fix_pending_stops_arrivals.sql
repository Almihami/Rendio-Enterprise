-- 0054_fix_pending_stops_arrivals.sql
--
-- BUG: al tercero de una LLEGADA, siendo el último en ser dejado, la app le
-- decía "Vas 3 de 3 · Sin paradas" cuando todavía faltaba entregar a otro.
--
-- Causa: en 0051 conté una parada como atendida cuando su route_stop estaba en
-- 'picked_up'. Eso es correcto en una SALIDA (picked_up = ya lo recogí, esa
-- parada terminó), pero es falso en una LLEGADA: ahí todos se montan juntos en
-- el aeropuerto, así que TODAS las paradas pasan a 'picked_up' apenas arranca
-- el carro — aunque no se haya dejado a nadie todavía.
--
-- Quién cierra la parada en cada caso:
--   salida  (home_to_airport) → route_stops.status = 'picked_up'
--   llegada (airport_to_home) → reservations.status_a2h = 'delivered'
--
-- Se arregla el conteo (remaining_before / remaining_after) y también la lista
-- de puntos que faltan (next_stops), que tenía el mismo criterio y por eso en
-- una llegada dejaba de dibujar las entregas pendientes.

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
  v_after       int;
  v_next        jsonb;
  v_pos_lat     double precision;
  v_pos_lng     double precision;
  v_pos_src     text;
  v_pos_at      timestamptz;
  v_wait        int;
  v_lle         boolean;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text),
         r.cancelled_at, r.ready_confirmed_at, r.pickup_latitude, r.pickup_longitude
    INTO v_dir, v_raw, v_cancelled, v_ready, v_pickup_lat, v_pickup_lng
  FROM public.reservations r
  WHERE r.id = p_reservation_id AND r.auxiliar_profile_id = v_aux
  LIMIT 1;

  IF v_dir IS NULL THEN RETURN NULL; END IF;

  IF v_cancelled IS NOT NULL THEN
    RETURN jsonb_build_object('cancelled', true, 'assigned', false, 'raw_status', v_raw);
  END IF;

  v_lle := (v_dir = 'airport_to_home');

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

  -- Pendientes antes y después de mí.
  -- El criterio de "ya terminó" DEPENDE DE LA DIRECCIÓN (ver encabezado):
  --   llegada → la reserva quedó 'delivered' (o no_show/cancelada)
  --   salida  → el stop quedó 'picked_up' (o no_show)
  WITH s AS (
    SELECT rs2.stop_order,
           CASE WHEN v_lle
                THEN COALESCE(r2.status_a2h::text, '') IN ('delivered', 'cancelled')
                     OR rs2.status = 'no_show' OR r2.cancelled_at IS NOT NULL
                ELSE rs2.status IN ('picked_up', 'delivered', 'no_show')
                     OR COALESCE(r2.status_h2a::text, '') IN ('delivered', 'no_show', 'cancelled')
                     OR r2.cancelled_at IS NOT NULL
           END AS terminada
    FROM public.route_stops rs2
    JOIN public.reservations r2 ON r2.id = rs2.reservation_id
    WHERE rs2.route_assignment_id = v_ra
  )
  SELECT count(*),
         count(*) FILTER (WHERE stop_order < v_my_order AND NOT terminada),
         count(*) FILTER (WHERE stop_order > v_my_order AND NOT terminada)
    INTO v_total, v_before, v_after
  FROM s;

  -- Los puntos que faltan por visitar, con el MISMO criterio corregido.
  -- Privacidad (igual que 0051): de los compañeros solo el sector y la
  -- coordenada redondeada a 3 decimales (~110 m). La propia va exacta.
  SELECT COALESCE(jsonb_agg(q.s ORDER BY (q.s->>'order')::int), '[]'::jsonb)
    INTO v_next
  FROM (
    SELECT jsonb_build_object(
             'order', rs3.stop_order,
             'mine',  (rs3.reservation_id = p_reservation_id),
             'lat',   CASE WHEN rs3.reservation_id = p_reservation_id
                           THEN r3.pickup_latitude
                           ELSE round(r3.pickup_latitude::numeric, 3)::double precision END,
             'lng',   CASE WHEN rs3.reservation_id = p_reservation_id
                           THEN r3.pickup_longitude
                           ELSE round(r3.pickup_longitude::numeric, 3)::double precision END,
             'sector', CASE WHEN r3.pickup_address LIKE '%,%'
                            THEN NULLIF(btrim(regexp_replace(r3.pickup_address, '^.*,', '')), '')
                            ELSE NULL END
           ) AS s
    FROM public.route_stops rs3
    JOIN public.reservations r3 ON r3.id = rs3.reservation_id
    WHERE rs3.route_assignment_id = v_ra
      AND r3.pickup_latitude IS NOT NULL
      AND r3.cancelled_at IS NULL
      AND (
        rs3.reservation_id = p_reservation_id
        OR NOT (
          CASE WHEN v_lle
               THEN COALESCE(r3.status_a2h::text, '') IN ('delivered', 'cancelled')
                    OR rs3.status = 'no_show'
               ELSE rs3.status IN ('picked_up', 'delivered', 'no_show')
                    OR COALESCE(r3.status_h2a::text, '') IN ('delivered', 'no_show', 'cancelled')
          END
        )
      )
  ) q;

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
    'stop_order', v_my_order, 'total_stops', v_total,
    'remaining_before', v_before, 'remaining_after', v_after,
    'next_stops', v_next,
    'route_start', v_route_start,
    'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng),
    'pos', CASE WHEN v_pos_lat IS NULL THEN NULL
                ELSE jsonb_build_object('lat', v_pos_lat, 'lng', v_pos_lng, 'source', v_pos_src, 'at', v_pos_at) END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_track_reservation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_track_reservation(uuid) TO authenticated;
