-- =============================================================================
-- 0087 · Mis viajes, mis cifras y el rastreo v5 del tripulante
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P9. Depende de 0085
-- (calculated_pickup_at publicada) y 0086 (columnas y notes_without_flight).
--
-- 1. public.auxiliar_my_trips(p_days_back int DEFAULT 60) → jsonb (arreglo)
--    Una sola llamada con TODO lo que pintan las tarjetas del rediseño (forma T
--    del plan §3.1). Reglas de honestidad, del lado del servidor:
--      · date/time calculados en hora de Bogotá (un traslado de las 20:30 no
--        cae en el día siguiente);
--      · published = hay ruta con conductor en 'planned' o 'in_progress';
--      · pickup_at y meet_code SOLO si está publicado (sin plan no hay hora ni
--        código que prometer);
--      · el teléfono del conductor SOLO mientras el viaje no esté cerrado;
--      · el promedio de calificación del conductor SOLO con n ≥ 10.
--    Ventana: lo de los últimos p_days_back días (1..400) MÁS todo lo que siga
--    abierto, sea de cuando sea (un pendiente viejo no se esconde).
--
-- 2. public.auxiliar_my_stats() → jsonb {done, on_time_n, on_time_pct}
--    done = entregados. on_time = salidas entregadas con hora de entrega
--    (route_stops.actual_dropoff_at, la marca el conductor al tocar
--    «entregado») antes o a la hora pedida. on_time_pct solo con n ≥ 5.
--    D20: mide la puntualidad del SERVICIO y depende de que el conductor
--    marque «entregado» a tiempo; si lo marca tarde, la cifra sale peor.
--
-- 3. public.driver_rating_summary(p_driver uuid) → (n, avg)
--    INTERNA: REVOKE de PUBLIC, anon y authenticated. Solo la llaman las RPC
--    SECURITY DEFINER de aquí (el dueño, postgres, conserva EXECUTE).
--
-- 4. public.auxiliar_track_reservation v5 = la de 0054 +
--      · pos = NULL salvo que el estado crudo sea en_route, at_pickup, on_board,
--        picked_up o en_route_home (D14, crítica 7): el tripulante no ve dónde
--        anda el conductor mientras atiende a otros ni antes de salir por él.
--        En llegadas el carro aparece desde «recogí» (picked_up);
--      · pickup_at (publicada), meet_code;
--      · vehicle {plate, brand, model, color};
--      · driver {name, phone, avatar_url, rating (n ≥ 10), rating_n};
--      · el teléfono del conductor desaparece al cerrar (entregado / no-show).
--    Todas las claves de 0054 siguen (incluida 'plate' arriba): lo heredado no
--    se entera.
--
-- 5. Policy p_driver_locations_select_aux endurecida: además de que la ruta
--    lleve una reserva suya, esa reserva tiene que estar NO cancelada y en uno
--    de los mismos estados activos. Hasta hoy (0004) el tripulante podía leer
--    por RLS, directo a la tabla, la posición de cualquier ruta en la que
--    alguna vez estuvo, a cualquier hora.
--
-- Todas SECURITY DEFINER con search_path fijo. Idempotente (CREATE OR REPLACE,
-- DROP POLICY IF EXISTS antes de CREATE).
-- Down: down_migrations/0087_aux_mis_viajes.down.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 3 (primero, porque la usan las demás). Resumen de calificaciones: interna.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_rating_summary(p_driver uuid)
RETURNS TABLE(n int, avg numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int, round(avg(r.rating)::numeric, 2)
  FROM public.reservations r
  WHERE p_driver IS NOT NULL
    AND r.rating IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.route_stops rs
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
      WHERE rs.reservation_id = r.id
        AND ra.driver_profile_id = p_driver
        AND ra.status <> 'cancelled'
    );
$$;

REVOKE ALL ON FUNCTION public.driver_rating_summary(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Mis viajes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auxiliar_my_trips(p_days_back int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_days int  := least(greatest(coalesce(p_days_back, 60), 1), 400);
BEGIN
  IF v_aux IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.ts, x.id)
    FROM (
      SELECT r.required_arrival_at AS ts, r.id,
        jsonb_build_object(
          'id',                    r.id,
          'direction',             r.direction,
          'required_arrival_at',   r.required_arrival_at,
          'date',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
          'time',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'HH24:MI'),
          'raw_status',            k.raw,
          'cancelled_at',          r.cancelled_at,
          'cancellation_reason',   r.cancellation_reason,
          'notes',                 r.notes,
          'notes_user',            public.notes_without_flight(r.notes),
          'flight_number',         f.flight_number,
          'pickup_address',        r.pickup_address,
          'pickup_latitude',       r.pickup_latitude,
          'pickup_longitude',      r.pickup_longitude,
          'residence_id',          r.residence_id,
          'residence_unit',        r.residence_unit,
          'meeting_point',         r.meeting_point,
          'is_overnight',          r.is_overnight,
          'is_firm',               r.is_firm,
          'ready_confirmed_at',    r.ready_confirmed_at,
          'service_level',         r.service_level,
          'private_status',        r.private_status,
          'price_cop',             r.price_cop,
          'private_reject_reason', r.private_reject_reason,
          'rating',                r.rating,
          'bags',                  r.bags,
          'quiet_ride',            r.quiet_ride,
          'created_at',            r.created_at,
          'published',             k.pub,
          'pickup_at',             CASE WHEN k.pub THEN r.calculated_pickup_at END,
          'meet_code',             CASE WHEN k.pub THEN r.meet_code END,
          'stop_status',           s.stop_status,
          'arrived_at',            s.arr,
          'picked_at',             s.pick,
          'dropped_at',            s.dropped,
          'driver', CASE WHEN s.ra_id IS NULL THEN NULL ELSE jsonb_build_object(
              'name',       pr.full_name,
              'avatar_url', pr.avatar_url,
              'phone',      CASE WHEN NOT k.closed AND s.ra_status <> 'completed' THEN pr.phone END,
              'rating',     CASE WHEN rt.n >= 10 THEN round(rt.avg, 1) END,
              'rating_n',   coalesce(rt.n, 0)) END,
          'vehicle', CASE WHEN s.ra_id IS NULL OR v.id IS NULL THEN NULL ELSE jsonb_build_object(
              'plate', coalesce(v.license_plate, v.internal_code),
              'brand', v.brand, 'model', v.model, 'color', v.color) END
        ) AS j
      FROM public.reservations r
      LEFT JOIN public.flights f ON f.id = r.flight_id
      LEFT JOIN LATERAL (
        SELECT ra.id AS ra_id, ra.status AS ra_status, ra.driver_profile_id AS drv, ra.vehicle_id AS veh,
               rs.status AS stop_status, rs.actual_arrival_at AS arr,
               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        WHERE rs.reservation_id = r.id
          AND ra.driver_profile_id IS NOT NULL
          AND ra.status IN ('planned', 'in_progress', 'completed')
        ORDER BY ra.planned_start_at DESC NULLS LAST
        LIMIT 1
      ) s ON true
      CROSS JOIN LATERAL (
        SELECT COALESCE(r.status_h2a::text, r.status_a2h::text) AS raw,
               (s.ra_status IN ('planned', 'in_progress')) IS TRUE AS pub,
               (r.cancelled_at IS NOT NULL
                 OR COALESCE(r.status_h2a::text, r.status_a2h::text) IN ('delivered', 'no_show', 'cancelled')) AS closed
      ) k
      LEFT JOIN public.driver_profiles dp ON dp.id = s.drv
      LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
      LEFT JOIN public.vehicles v         ON v.id = s.veh
      LEFT JOIN LATERAL public.driver_rating_summary(s.drv) rt ON s.drv IS NOT NULL
      WHERE r.auxiliar_profile_id = v_aux
        AND (r.required_arrival_at >= now() - make_interval(days => v_days) OR NOT k.closed)
    ) x
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.auxiliar_my_trips(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auxiliar_my_trips(int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Mis cifras
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auxiliar_my_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_done int;
  v_n    int;
  v_ok   int;
BEGIN
  IF v_aux IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_done
  FROM public.reservations r
  WHERE r.auxiliar_profile_id = v_aux
    AND r.cancelled_at IS NULL
    AND COALESCE(r.status_h2a::text, r.status_a2h::text) = 'delivered';

  SELECT count(*), count(*) FILTER (WHERE d.dropped <= r.required_arrival_at)
    INTO v_n, v_ok
  FROM public.reservations r
  CROSS JOIN LATERAL (
    SELECT rs.actual_dropoff_at AS dropped
    FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id AND ra.status <> 'cancelled'
    ORDER BY ra.planned_start_at DESC NULLS LAST
    LIMIT 1
  ) d
  WHERE r.auxiliar_profile_id = v_aux
    AND r.direction = 'home_to_airport'
    AND r.cancelled_at IS NULL
    AND r.status_h2a = 'delivered'
    AND d.dropped IS NOT NULL;

  RETURN jsonb_build_object(
    'done',        v_done,
    'on_time_n',   v_n,
    'on_time_pct', CASE WHEN v_n >= 5 THEN round(100.0 * v_ok / v_n)::int END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auxiliar_my_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auxiliar_my_stats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Rastreo v5
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auxiliar_track_reservation(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  v_pickup_at   timestamptz;
  v_meet        text;
  v_ra          uuid;
  v_driver      uuid;
  v_stop_status text;
  v_arrived_at  timestamptz;
  v_name        text;
  v_phone       text;
  v_avatar      text;
  v_plate       text;
  v_brand       text;
  v_model       text;
  v_color       text;
  v_rt_n        int;
  v_rt_avg      numeric;
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
  v_active      boolean;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text),
         r.cancelled_at, r.ready_confirmed_at, r.pickup_latitude, r.pickup_longitude,
         r.calculated_pickup_at, r.meet_code
    INTO v_dir, v_raw, v_cancelled, v_ready, v_pickup_lat, v_pickup_lng,
         v_pickup_at, v_meet
  FROM public.reservations r
  WHERE r.id = p_reservation_id AND r.auxiliar_profile_id = v_aux
  LIMIT 1;

  IF v_dir IS NULL THEN RETURN NULL; END IF;

  IF v_cancelled IS NOT NULL THEN
    RETURN jsonb_build_object('cancelled', true, 'assigned', false, 'raw_status', v_raw);
  END IF;

  v_lle := (v_dir = 'airport_to_home');
  -- D14: solo en estos estados el tripulante ve dónde va el carro.
  v_active := v_raw IN ('en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home');

  SELECT aux_wait_minutes INTO v_wait FROM public.app_settings WHERE id = 'singleton';
  v_wait := COALESCE(v_wait, 5);

  SELECT ra.id, ra.driver_profile_id, rs.status, rs.actual_arrival_at, rs.stop_order,
         ra.planned_start_at, pr.full_name, pr.phone, pr.avatar_url,
         COALESCE(v.license_plate, v.internal_code), v.brand, v.model, v.color
    INTO v_ra, v_driver, v_stop_status, v_arrived_at, v_my_order,
         v_route_start, v_name, v_phone, v_avatar,
         v_plate, v_brand, v_model, v_color
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
      'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng),
      'pickup_at', NULL, 'meet_code', NULL, 'pos', NULL);
  END IF;

  IF v_driver IS NOT NULL THEN
    SELECT s.n, s.avg INTO v_rt_n, v_rt_avg FROM public.driver_rating_summary(v_driver) s;
  END IF;

  -- Pendientes antes y después de mí (criterio por dirección, igual que 0054).
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

  -- Puntos que faltan (privacidad de 0051: de los compañeros solo el sector y
  -- la coordenada redondeada; la propia exacta).
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

  -- La posición solo se BUSCA en estado activo: fuera de él no se lee.
  IF v_active THEN
    SELECT dl.latitude, dl.longitude, dl.source, dl.recorded_at
      INTO v_pos_lat, v_pos_lng, v_pos_src, v_pos_at
    FROM public.driver_locations dl
    WHERE dl.driver_profile_id = v_driver
    ORDER BY dl.recorded_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'cancelled', false, 'assigned', true, 'raw_status', v_raw, 'direction', v_dir,
    'stop_status', v_stop_status, 'arrived_at', v_arrived_at,
    'ready_confirmed_at', v_ready, 'wait_minutes', v_wait,
    'driver', jsonb_build_object(
      'name', v_name,
      'phone', CASE WHEN v_raw IN ('delivered', 'no_show') THEN NULL ELSE v_phone END,
      'avatar_url', v_avatar,
      'rating', CASE WHEN v_rt_n >= 10 THEN round(v_rt_avg, 1) END,
      'rating_n', coalesce(v_rt_n, 0)),
    'plate', v_plate,
    'vehicle', jsonb_build_object('plate', v_plate, 'brand', v_brand, 'model', v_model, 'color', v_color),
    'pickup_at', v_pickup_at,
    'meet_code', v_meet,
    'stop_order', v_my_order, 'total_stops', v_total,
    'remaining_before', v_before, 'remaining_after', v_after,
    'next_stops', v_next,
    'route_start', v_route_start,
    'pickup', jsonb_build_object('lat', v_pickup_lat, 'lng', v_pickup_lng),
    'pos', CASE WHEN NOT v_active OR v_pos_lat IS NULL THEN NULL
                ELSE jsonb_build_object('lat', v_pos_lat, 'lng', v_pos_lng, 'source', v_pos_src, 'at', v_pos_at) END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_track_reservation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auxiliar_track_reservation(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. La posición del conductor por RLS: solo en estado activo
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS p_driver_locations_select_aux ON public.driver_locations;
CREATE POLICY p_driver_locations_select_aux
  ON public.driver_locations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND route_assignment_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.route_stops rs
      JOIN public.reservations r ON r.id = rs.reservation_id
      WHERE rs.route_assignment_id = driver_locations.route_assignment_id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
        AND r.cancelled_at IS NULL
        AND COALESCE(r.status_h2a::text, r.status_a2h::text)
            IN ('en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home')
    )
  );

COMMIT;
