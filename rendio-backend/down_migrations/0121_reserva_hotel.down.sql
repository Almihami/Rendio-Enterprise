-- Revierte 0121: vuelven auxiliar_my_trips y auxiliar_change_flight de 0093
-- (sin el lugar de la reserva) y se quita la columna. Lo que los tripulantes
-- hayan marcado como reserva se pierde: sacar antes un respaldo de
-- reservations.reserve_place si hace falta.
BEGIN;

DROP FUNCTION IF EXISTS public.auxiliar_change_flight(uuid, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.auxiliar_change_flight(
  p_reservation_id uuid,
  p_flight text,
  p_when timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux        uuid := public.current_auxiliar_id();
  r            public.reservations%ROWTYPE;
  v_raw        text;
  v_old_flight text;
  v_flight     text;
  v_lead       int;
  v_pub        boolean;
  v_priv       boolean;
  v_ops        boolean;
  v_regreso    boolean;
  v_user       text;
  v_notes      text;
  v_inc        uuid;
  v_n          int;
  v_desc       text;
BEGIN
  IF auth.uid() IS NULL OR v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo el tripulante dueño del traslado puede cambiar su vuelo' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.reservations
   WHERE id = p_reservation_id AND auxiliar_profile_id = v_aux
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese traslado no es tuyo' USING ERRCODE = '42501';
  END IF;
  IF r.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ese traslado está cancelado' USING ERRCODE = '22023';
  END IF;

  v_raw := COALESCE(r.status_h2a::text, r.status_a2h::text);
  IF v_raw IN ('en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show', 'cancelled') THEN
    RAISE EXCEPTION 'Tu traslado ya está en curso: escríbele a Coordinación' USING ERRCODE = '22023';
  END IF;

  IF p_when IS NULL THEN
    RAISE EXCEPTION 'Falta la hora nueva' USING ERRCODE = '22023';
  END IF;
  IF p_when <= now() THEN
    RAISE EXCEPTION 'Esa hora ya pasó' USING ERRCODE = '22023';
  END IF;
  IF p_when > now() + interval '14 days' THEN
    RAISE EXCEPTION 'Solo puedes cambiarlo hasta 14 días adelante' USING ERRCODE = '22023';
  END IF;

  -- El vuelo: sin espacios ni guion, en mayúscula. Mismo formato que escribe
  -- el pedido («Vuelo AV9412. »), y que notes_without_flight sabe quitar.
  v_flight := nullif(upper(regexp_replace(coalesce(p_flight, ''), '[[:space:]-]', '', 'g')), '');
  IF v_flight IS NOT NULL AND v_flight !~ '^[A-Z]{0,3}[0-9]{2,5}$' THEN
    RAISE EXCEPTION 'Ese número de vuelo no se entiende (ej.: AV9412)' USING ERRCODE = '22023';
  END IF;
  -- 0093: la llegada de tierra (ground_ops) no tiene vuelo; solo cambia la hora.
  IF v_flight IS NULL AND r.direction = 'airport_to_home' AND NOT coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas' USING ERRCODE = '22023';
  END IF;

  SELECT f.flight_number INTO v_old_flight FROM public.flights f WHERE f.id = r.flight_id;
  IF v_old_flight IS NULL THEN
    v_old_flight := nullif(upper(regexp_replace(
      coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''),
      '[[:space:]-]', '', 'g')), '');
  END IF;

  IF p_when = r.required_arrival_at AND (v_flight IS NULL OR v_flight IS NOT DISTINCT FROM v_old_flight) THEN
    RETURN jsonb_build_object('mode', 'updated', 'unchanged', true,
                              'required_arrival_at', r.required_arrival_at);
  END IF;

  SELECT aux_min_lead_hours INTO v_lead FROM public.app_settings WHERE id = 'singleton';
  v_lead := coalesce(v_lead, 6);

  v_pub := EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id
      AND ra.driver_profile_id IS NOT NULL
      AND ra.status IN ('planned', 'in_progress'));
  v_priv := r.service_level = 'private' AND r.private_status IN ('requested', 'approved');
  v_ops := p_when <> r.required_arrival_at AND (
             v_pub OR v_priv
             OR p_when < now() + make_interval(hours => v_lead)
             OR r.required_arrival_at < now() + make_interval(hours => v_lead));

  IF NOT v_ops THEN
    v_regreso := coalesce(r.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
    v_user := public.notes_without_flight(r.notes);
    IF v_flight IS NULL THEN
      v_notes := r.notes;  -- sin vuelo nuevo (salida o tierra): las notas quedan como estaban
    ELSE
      v_notes := btrim('Vuelo ' || v_flight || '. ' || v_user
                       || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END);
    END IF;

    UPDATE public.reservations
       SET required_arrival_at = p_when,
           notes = nullif(v_notes, ''),
           flight_id = CASE WHEN v_flight IS NOT NULL AND v_flight IS DISTINCT FROM v_old_flight
                            THEN NULL ELSE flight_id END
     WHERE id = r.id;

    RETURN jsonb_build_object('mode', 'updated', 'required_arrival_at', p_when,
                              'flight', coalesce(v_flight, v_old_flight));
  END IF;

  v_desc := format('Cambió su vuelo (%s): %s → %s%s',
    CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    coalesce(' · vuelo ' || coalesce(v_flight, v_old_flight), ''));

  v_inc := public.report_incident(
    (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay' ELSE 'flight_advanced' END)::public.incident_category,
    v_desc,
    'medium'::public.incident_severity,
    r.id,
    jsonb_build_object(
      'kind', 'aux_change_flight',
      'old_when', r.required_arrival_at, 'new_when', p_when,
      'old_flight', v_old_flight, 'new_flight', coalesce(v_flight, v_old_flight),
      'direction', r.direction, 'published', v_pub, 'private', v_priv)
  );
  v_n := public.enqueue_incident_alert(v_inc);

  RETURN jsonb_build_object('mode', 'needs_ops', 'incident_id', v_inc, 'notified', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.auxiliar_change_flight(uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auxiliar_change_flight(uuid, text, timestamptz) TO authenticated;

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
          'ground_ops',            r.ground_ops,
          'published',             k.pub,
          'pickup_at',             CASE WHEN k.pub THEN r.calculated_pickup_at END,
          'meet_code',             CASE WHEN k.pub THEN r.meet_code END,
          'pickup_pos',            CASE WHEN k.pub THEN po.pos END,
          'pickup_total',          CASE WHEN k.pub THEN po.total END,
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
               ra.direction AS ra_dir, ra.planned_start_at AS ra_start,   -- 0093: para juntar la vuelta del carro
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
      -- El tramo de MI ruta en el tiempo: de su arranque a la última hora
      -- estimada de sus paradas (greatest ignora los NULL: sin horas estimadas
      -- el tramo es solo el arranque). Solo con la ruta publicada.
      LEFT JOIN LATERAL (
        SELECT greatest(s.ra_start, max(ms.estimated_arrival_at)) AS w1
        FROM public.route_stops ms
        WHERE k.pub AND ms.route_assignment_id = s.ra_id
      ) sw ON true
      -- Mi lugar en el carro: solo con la ruta publicada, sobre la VUELTA DEL
      -- CARRO: mi route_assignment («s») y las otras publicadas del mismo
      -- vehículo y dirección cuyo tramo se cruza con el mío (la que quedó en
      -- curso + la que saveRoutePlan le creó al lado al republicar). Misma
      -- dirección, sin cancelados ni no-show; una reserva en dos rutas cuenta
      -- una vez. Si yo quedé fuera, no hay fila → NULL.
      LEFT JOIN LATERAL (
        SELECT o.pos, o.total
        FROM (
          SELECT cv.reservation_id,
                 -- Una sola ruta: stop_order. Varias: la hora estimada de cada
                 -- parada manda (el plan), luego el arranque y stop_order.
                 row_number() OVER (ORDER BY CASE WHEN cv.varias THEN cv.t_k END,
                                             cv.ra_start, cv.stop_order, cv.id)::int AS pos,
                 (count(*) OVER ())::int AS total
          FROM (
            SELECT cand.*, bool_or(cand.ra_id <> s.ra_id) OVER () AS varias
            FROM (
              SELECT DISTINCT ON (rs2.reservation_id)
                     rs2.reservation_id, rs2.id, rs2.stop_order,
                     ra2.id AS ra_id, ra2.planned_start_at AS ra_start,
                     coalesce(rs2.estimated_arrival_at, ra2.planned_start_at) AS t_k
              FROM public.route_assignments ra2
              JOIN public.route_stops rs2 ON rs2.route_assignment_id = ra2.id
              JOIN public.reservations r2 ON r2.id = rs2.reservation_id
              WHERE k.pub
                AND (ra2.id = s.ra_id
                     OR (ra2.vehicle_id = s.veh
                         AND ra2.direction = s.ra_dir
                         AND ra2.driver_profile_id IS NOT NULL
                         AND ra2.status IN ('planned', 'in_progress', 'completed')
                         AND ra2.planned_start_at <= sw.w1
                         AND s.ra_start <= (
                               SELECT greatest(ra2.planned_start_at, max(os.estimated_arrival_at))
                               FROM public.route_stops os
                               WHERE os.route_assignment_id = ra2.id)))
                AND r2.direction = r.direction
                AND r2.cancelled_at IS NULL
                AND rs2.status <> 'no_show'
                AND COALESCE(r2.status_h2a::text, r2.status_a2h::text, '') NOT IN ('cancelled', 'no_show')
              -- Si una reserva quedara en dos rutas: la mía primero, si no la más reciente.
              ORDER BY rs2.reservation_id, (ra2.id = s.ra_id) DESC, ra2.planned_start_at DESC NULLS LAST
            ) cand
          ) cv
        ) o
        WHERE o.reservation_id = r.id
      ) po ON true
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

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_reserve_place_chk;
ALTER TABLE public.reservations DROP COLUMN IF EXISTS reserve_place;

COMMIT;
