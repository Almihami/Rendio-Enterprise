-- 0051_auxiliar_track_remaining_after.sql
--
-- El auxiliar que se montaba de segundo en un carro de 3 veía "Vas al aeropuerto"
-- apenas cerraba la puerta, aunque el conductor todavía tuviera casas por recoger.
-- La causa está en el RPC: solo sabía contar las paradas ANTES de la suya
-- (remaining_before) y, una vez montado, ese número es 0 y la app se quedaba sin
-- con qué saber que el viaje seguía recogiendo. Tampoco tenía los puntos que
-- faltaban, así que el mapa dibujaba la recta a MDE ignorando el resto del recorrido.
--
-- Se agregan dos datos:
--   * remaining_after → paradas pendientes DESPUÉS de la mía (las que me demoran
--     mientras voy a bordo en un viaje de salida).
--   * next_stops      → los puntos que faltan por visitar (incluida la mía,
--     marcada con "mine"), en orden, para poder dibujar lo que sigue.
--
-- PRIVACIDAD (decisión de producto): de los compañeros NO se expone ni el nombre
-- ni la dirección. Solo el SECTOR (el texto después de la última coma de la
-- dirección: "Llanogrande", "San Antonio de Pereira") y la coordenada REDONDEADA
-- a 3 decimales (~110 m), suficiente para dibujar el camino y no para señalar
-- la casa de nadie. La parada propia sí va con su coordenada exacta.

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

  -- Pendientes antes y después de mí. "Pendiente" = el stop no está cerrado
  -- (picked_up/no_show) y la reserva tampoco terminó (delivered/no_show/cancelled):
  -- en las llegadas el stop se queda en 'picked_up' y quien cierra es la reserva.
  SELECT count(*),
         count(*) FILTER (WHERE rs2.stop_order < v_my_order
                            AND rs2.status NOT IN ('picked_up', 'delivered', 'no_show')),
         count(*) FILTER (WHERE rs2.stop_order > v_my_order
                            AND rs2.status NOT IN ('picked_up', 'delivered', 'no_show')
                            AND COALESCE(r2.status_h2a::text, r2.status_a2h::text)
                                NOT IN ('delivered', 'no_show', 'cancelled')
                            AND r2.cancelled_at IS NULL)
    INTO v_total, v_before, v_after
  FROM public.route_stops rs2
  JOIN public.reservations r2 ON r2.id = rs2.reservation_id
  WHERE rs2.route_assignment_id = v_ra;

  -- Los puntos que faltan por visitar, para dibujar el resto del camino.
  -- Ver nota de PRIVACIDAD en el encabezado: sector + coordenada redondeada.
  SELECT COALESCE(jsonb_agg(s ORDER BY (s->>'order')::int), '[]'::jsonb)
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
        OR (rs3.status NOT IN ('picked_up', 'delivered', 'no_show')
            AND COALESCE(r3.status_h2a::text, r3.status_a2h::text)
                NOT IN ('delivered', 'no_show', 'cancelled'))
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

COMMENT ON FUNCTION public.auxiliar_track_reservation(uuid)
  IS 'El auxiliar dueño obtiene posición del conductor, su lugar en la ruta, cuántas paradas faltan antes y después de la suya, los puntos que faltan por visitar (sector + coordenada redondeada de terceros), si la reserva fue cancelada, la hora real de llegada y los minutos de espera configurados. SECURITY DEFINER validado por current_auxiliar_id.';
