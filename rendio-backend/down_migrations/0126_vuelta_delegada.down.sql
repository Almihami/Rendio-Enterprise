-- Down 0126 — quita la vuelta delegada y deja las funciones como en 0125.
-- ANTES de correrlo: las vueltas delegadas que sigan vivas quedan publicadas sin
-- conductor y sin marca; conviene asignarlas o borrarlas primero.
BEGIN;
DROP FUNCTION IF EXISTS public.admin_route_set_delegated(uuid, boolean);

CREATE OR REPLACE FUNCTION public.sync_calculated_pickup(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v timestamptz;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN;
  END IF;

  -- Si la reserva quedó en más de una ruta (una en curso que se conservó y otra
  -- nueva), manda la más reciente.
  SELECT CASE WHEN ra.direction = 'airport_to_home'
              THEN ra.planned_start_at
              ELSE rs.estimated_arrival_at END
    INTO v
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status <> 'cancelled'
    AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: la vuelta pegada se publica sin conductor
  ORDER BY ra.planned_start_at DESC NULLS LAST, ra.created_at DESC
  LIMIT 1;

  UPDATE public.reservations
     SET calculated_pickup_at = v
   WHERE id = p_reservation_id
     AND calculated_pickup_at IS DISTINCT FROM v;
END;
$$;

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
          'reserve_place',         r.reserve_place,          -- 0121: de reserva en Río Verde / Movich / Aero
          'published',             k.pub,
          'pickup_at',             CASE WHEN k.pub THEN r.calculated_pickup_at END,
          'meet_code',             CASE WHEN k.pub THEN r.meet_code END,
          'pickup_pos',            CASE WHEN k.pub THEN po.pos END,
          'pickup_total',          CASE WHEN k.pub THEN po.total END,
          'stop_status',           s.stop_status,
          'arrived_at',            s.arr,
          'picked_at',             s.pick,
          'dropped_at',            s.dropped,
          -- 0125: publicada y sin conductor (la vuelta pegada que nadie ha tomado).
          'driver_pending',        (k.pub AND s.drv IS NULL),
          'driver', CASE WHEN s.ra_id IS NULL OR s.drv IS NULL THEN NULL ELSE jsonb_build_object(
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
          AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: la vuelta pegada, sin conductor todavía
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
                         AND (ra2.driver_profile_id IS NOT NULL OR ra2.pool)
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

CREATE OR REPLACE FUNCTION public.auxiliar_change_flight(
  p_reservation_id uuid,
  p_flight text,
  p_when timestamptz,
  p_reserve_place text DEFAULT NULL
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
  v_place      text;
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

  -- 0121: el lugar de la reserva. NULL = como estaba; 'vuelo' o '' = ahora va
  -- en un vuelo; o uno de los tres lugares.
  v_place := CASE
    WHEN p_reserve_place IS NULL THEN r.reserve_place
    WHEN btrim(p_reserve_place) IN ('', 'vuelo') THEN NULL
    ELSE btrim(p_reserve_place) END;
  IF v_place IS NOT NULL AND v_place NOT IN ('rio_verde', 'movich', 'aero') THEN
    RAISE EXCEPTION 'Ese lugar de reserva no existe' USING ERRCODE = '22023';
  END IF;
  IF v_place IS NOT NULL AND coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Un traslado de trabajo en tierra no va de reserva' USING ERRCODE = '22023';
  END IF;

  -- El vuelo: sin espacios ni guion, en mayúscula. Mismo formato que escribe
  -- el pedido («Vuelo AV9412. »), y que notes_without_flight sabe quitar.
  -- De reserva no hay vuelo: lo que venga se ignora.
  v_flight := CASE WHEN v_place IS NOT NULL THEN NULL
    ELSE nullif(upper(regexp_replace(coalesce(p_flight, ''), '[[:space:]-]', '', 'g')), '') END;
  IF v_flight IS NOT NULL AND v_flight !~ '^[A-Z]{0,3}[0-9]{2,5}$' THEN
    RAISE EXCEPTION 'Ese número de vuelo no se entiende (ej.: AV9412)' USING ERRCODE = '22023';
  END IF;
  -- 0093: la llegada de tierra (ground_ops) no tiene vuelo; 0121: la de reserva tampoco.
  IF v_flight IS NULL AND v_place IS NULL AND r.direction = 'airport_to_home' AND NOT coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas' USING ERRCODE = '22023';
  END IF;

  SELECT f.flight_number INTO v_old_flight FROM public.flights f WHERE f.id = r.flight_id;
  IF v_old_flight IS NULL THEN
    v_old_flight := nullif(upper(regexp_replace(
      coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''),
      '[[:space:]-]', '', 'g')), '');
  END IF;

  IF p_when = r.required_arrival_at
     AND v_place IS NOT DISTINCT FROM r.reserve_place
     AND (v_flight IS NULL OR v_flight IS NOT DISTINCT FROM v_old_flight) THEN
    RETURN jsonb_build_object('mode', 'updated', 'unchanged', true,
                              'required_arrival_at', r.required_arrival_at,
                              'reserve_place', r.reserve_place);
  END IF;

  SELECT aux_min_lead_hours INTO v_lead FROM public.app_settings WHERE id = 'singleton';
  v_lead := coalesce(v_lead, 6);

  v_pub := EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id
      AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125
      AND ra.status IN ('planned', 'in_progress'));
  v_priv := r.service_level = 'private' AND r.private_status IN ('requested', 'approved');
  -- Cambiar de lugar (vuelo↔reserva, u otro hotel) mueve el carro igual que
  -- cambiar la hora: con la ruta publicada o dentro del plazo, decide Coordinación.
  v_ops := (p_when <> r.required_arrival_at OR v_place IS DISTINCT FROM r.reserve_place) AND (
             v_pub OR v_priv
             OR p_when < now() + make_interval(hours => v_lead)
             OR r.required_arrival_at < now() + make_interval(hours => v_lead));

  IF NOT v_ops THEN
    v_regreso := coalesce(r.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
    v_user := public.notes_without_flight(r.notes);
    IF v_place IS NOT NULL THEN
      v_notes := v_user;   -- de reserva: el vuelo viejo sale de las notas
    ELSIF v_flight IS NULL THEN
      v_notes := r.notes;  -- sin vuelo nuevo (salida o tierra): las notas quedan como estaban
    ELSE
      v_notes := btrim('Vuelo ' || v_flight || '. ' || v_user
                       || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END);
    END IF;

    UPDATE public.reservations
       SET required_arrival_at = p_when,
           reserve_place = v_place,
           notes = nullif(v_notes, ''),
           flight_id = CASE WHEN v_place IS NOT NULL THEN NULL
                            WHEN v_flight IS NOT NULL AND v_flight IS DISTINCT FROM v_old_flight
                            THEN NULL ELSE flight_id END
     WHERE id = r.id;

    RETURN jsonb_build_object('mode', 'updated', 'required_arrival_at', p_when,
                              'flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
                              'reserve_place', v_place);
  END IF;

  v_desc := format('Cambió su %s (%s): %s → %s%s',
    CASE WHEN v_place IS NOT NULL OR r.reserve_place IS NOT NULL THEN 'traslado' ELSE 'vuelo' END,
    CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    CASE
      WHEN v_place IS NOT NULL THEN ' · de reserva en ' || CASE v_place
        WHEN 'rio_verde' THEN 'Hotel Río Verde' WHEN 'movich' THEN 'Hotel Movich' ELSE 'el aeropuerto' END
      ELSE coalesce(' · vuelo ' || coalesce(v_flight, v_old_flight), '')
    END
    || CASE WHEN r.reserve_place IS NOT NULL AND v_place IS NULL THEN ' (antes de reserva)' ELSE '' END);

  v_inc := public.report_incident(
    (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay'
          WHEN p_when < r.required_arrival_at THEN 'flight_advanced'
          ELSE 'other' END)::public.incident_category,
    v_desc,
    'medium'::public.incident_severity,
    r.id,
    jsonb_build_object(
      'kind', 'aux_change_flight',
      'old_when', r.required_arrival_at, 'new_when', p_when,
      'old_flight', v_old_flight, 'new_flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
      'old_reserve_place', r.reserve_place, 'new_reserve_place', v_place,
      'direction', r.direction, 'published', v_pub, 'private', v_priv)
  );
  v_n := public.enqueue_incident_alert(v_inc);

  RETURN jsonb_build_object('mode', 'needs_ops', 'incident_id', v_inc, 'notified', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.detect_late_bookings()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nuevas integer := 0;
  r        record;
  v_id     uuid;
BEGIN
  -- (a) ABRE: reserva viva, de un día que YA tiene plan publicado, sin parada.
  --
  -- «Día con plan publicado» = existe al menos una route_assignment de ese día
  -- con conductor asignado (status planned o in_progress). Un borrador no
  -- cuenta: mientras el jefe está armando el día, que falte gente es lo normal
  -- y avisar ahí sería ruido puro.
  FOR r IN
    SELECT res.id, res.required_arrival_at, res.pickup_address, res.direction,
           pr.full_name AS pax, pr.organization_id,
           EXTRACT(EPOCH FROM (res.required_arrival_at - now())) / 3600 AS horas
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    WHERE res.cancelled_at IS NULL
      AND res.required_arrival_at > now()
      -- todavía hay tiempo de hacer algo; después ya es historia, no alerta
      AND res.required_arrival_at < now() + interval '36 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
      AND EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.status IN ('planned', 'in_progress')
          AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: también con la ruta pegada
          AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date
              = (res.required_arrival_at AT TIME ZONE 'America/Bogota')::date)
      AND NOT EXISTS (
        SELECT 1 FROM public.incidents i
        WHERE i.dedupe_key = 'late:' || res.id::text AND i.resolved_at IS NULL)
  LOOP
    INSERT INTO public.incidents (
      organization_id, reporter_id, reservation_id,
      category, severity, status, description, scope, source, details,
      dedupe_key, occurred_at)
    VALUES (
      r.organization_id, NULL, r.id,
      'late_booking',
      -- Grave solo cuando ya no hay noche de por medio para resolverlo.
      -- El cast es obligatorio: un CASE devuelve text y la columna es un enum.
      (CASE WHEN r.horas < 6 THEN 'high' ELSE 'medium' END)::public.incident_severity,
      'open',
      COALESCE(split_part(r.pax, ' ', 1), 'Un tripulante') ||
        ' no tiene carro: el plan del día ya está publicado y su traslado quedó por fuera' ||
        CASE WHEN r.horas < 6
             THEN ' (faltan ' || round(r.horas::numeric, 1) || ' h).'
             ELSE '.' END,
      'operacion', 'system',
      jsonb_build_object(
        'horas_para_el_servicio', round(r.horas::numeric, 1),
        'direccion', r.pickup_address,
        'sentido', r.direction),
      'late:' || r.id::text, now())
    RETURNING id INTO v_id;

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

  -- (b) CIERRA sola: ya la acomodaron, la cancelaron, o el servicio ya pasó.
  UPDATE public.incidents i
     SET status = 'resolved',
         resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes,
           CASE
             WHEN res.cancelled_at IS NOT NULL THEN 'Se cerró sola: la reserva fue cancelada.'
             WHEN EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
               THEN 'Se cerró sola: la reserva ya quedó en una ruta.'
             ELSE 'Se cerró sola: la hora del servicio ya pasó.'
           END)
    FROM public.reservations res
   WHERE res.id = i.reservation_id
     AND i.category = 'late_booking'
     AND i.resolved_at IS NULL
     AND (
       res.cancelled_at IS NOT NULL
       OR res.required_arrival_at <= now()
       OR EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
     );

  RETURN v_nuevas;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_open_routes()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_dp uuid := public.my_driver_profile_id(); v_org uuid := public.current_user_org();
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(j ORDER BY ts) FROM (
      SELECT ra.planned_start_at AS ts, jsonb_build_object(
        'id', ra.id, 'direction', ra.direction, 'planned_start_at', ra.planned_start_at,
        'deadline_at', ra.deadline_at, 'note', ra.manual_note, 'day', ra.manual_day,
        'stops', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'order', rs.stop_order, 'at', rs.estimated_arrival_at,
                    'name', public.short_name(pr.full_name),
                    'place', coalesce(res.name, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''), 'Sin dirección'),
                    'sector', res.sector, 'flight', f.flight_number) ORDER BY rs.stop_order), '[]'::jsonb)
                  FROM public.route_stops rs
                  JOIN public.reservations r ON r.id = rs.reservation_id
                  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                  JOIN public.profiles pr ON pr.id = ap.profile_id
                  LEFT JOIN public.residences res ON res.id = r.residence_id
                  LEFT JOIN public.flights f ON f.id = r.flight_id
                 WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL)) AS j
        FROM public.route_assignments ra
       WHERE ra.pool AND ra.organization_id = v_org AND ra.driver_profile_id IS NULL AND ra.status = 'planned'
         AND ra.planned_start_at >= now() - interval '1 hour'
         AND ra.planned_start_at <  now() + interval '40 hours'
    ) z), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_take_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_pl  text;
  c     record;
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = v_dp, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id IS NULL AND status = 'planned'
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND driver_profile_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta ya la tomó otro conductor' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Esta vuelta ya no está disponible' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_me, 'Tu conductor') || ' te recoge 🚗',
      CASE WHEN ra.direction = 'home_to_airport'
           THEN 'Te recoge a las ' || public.hm_bog(c.at) || coalesce(' en el carro ' || v_pl, '') || '.'
           ELSE 'Te espera en JMC cuando aterrices' || coalesce(' (carro ' || v_pl || ')', '') || '.' END,
      '/#/viaje?r=' || c.id::text, 'take:' || ra.id::text || ':' || v_dp::text || ':' || c.id::text);
  END LOOP;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'vehicle_id', ra.vehicle_id, 'plate', v_pl);
END;
$$;

CREATE OR REPLACE FUNCTION public.pool_unclaimed_alerts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v int := 0; r record;
BEGIN
  FOR r IN
    SELECT ra.id, ra.organization_id, ra.direction,
           coalesce((SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id), ra.planned_start_at) AS t0,
           (SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order)
              FROM public.route_stops rs JOIN public.reservations res ON res.id = rs.reservation_id
              JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id) AS quienes
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.driver_profile_id IS NULL AND ra.status = 'planned' AND ra.organization_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)
  LOOP
    CONTINUE WHEN r.t0 IS NULL OR r.t0 < now() OR r.t0 > now() + interval '60 minutes';
    v := v + (SELECT count(*) FROM (
      SELECT public.trip_notify(j.profile_id, 'Nadie ha tomado una vuelta ⚠️',
               CASE WHEN r.direction = 'home_to_airport' THEN 'Recogida ' ELSE 'Llegada ' END || public.hm_bog(r.t0) || ' · ' || coalesce(r.quienes, '')
                 || '. Faltan ' || greatest(1, round(extract(epoch FROM (r.t0 - now())) / 60)::int) || ' min.',
               '/#/rutas', 'unclaimed:' || r.id::text || ':' || j.profile_id::text) AS ok
        FROM public.ops_alert_recipients_of(r.organization_id) j) z WHERE z.ok);
  END LOOP;
  IF v > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v;
END;
$$;

ALTER TABLE public.route_assignments DROP CONSTRAINT IF EXISTS route_assignments_delegada_sin_conductor;
ALTER TABLE public.route_assignments DROP COLUMN IF EXISTS delegated_by;
ALTER TABLE public.route_assignments DROP COLUMN IF EXISTS delegated_at;
COMMIT;
