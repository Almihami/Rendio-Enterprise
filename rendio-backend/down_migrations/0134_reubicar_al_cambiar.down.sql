-- Down 0134 — vuelve el cambio de vuelo a «decide Coordinación» (0126) y la cancelación a 0117.
BEGIN;
DROP FUNCTION IF EXISTS public.reubicar_reserva(uuid);
DROP FUNCTION IF EXISTS public.reub_candidatas(uuid, int);
DROP FUNCTION IF EXISTS public.reub_tramo_min(uuid, double precision, double precision, double precision, double precision, boolean);

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
      AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
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
  v_quien  text;
  v_avisos integer := 0;
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

  -- El aviso al conductor sale de aquí (0117): el celular del tripulante ya no
  -- puede mandarlo, porque la parada que los unía se acaba de borrar.
  IF v_driver IS NOT NULL THEN
    SELECT nullif(split_part(btrim(p.full_name), ' ', 1), '') INTO v_quien
    FROM public.profiles p WHERE p.id = auth.uid();
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    VALUES (v_driver, 'Traslado cancelado',
            coalesce(v_quien, 'Un tripulante') || ' canceló su traslado. Ya no está en tu ruta.',
            '/', 'cancel:' || p_reservation_id::text || ':' || v_driver::text)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_avisos = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver, 'driver_notified', v_avisos > 0);
END;
$$;

ALTER TABLE public.route_assignments DROP COLUMN IF EXISTS auto_created;
COMMIT;
