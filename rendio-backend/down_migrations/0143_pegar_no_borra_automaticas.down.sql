-- Down de 0143: vuelven admin_manual_route_publish de 0133, admin_manual_route_clear de 0125,
-- y el detector y reubicar_reserva de 0141; se quita dia_madrugada.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid := public.current_user_org();
  b          jsonb;
  st         jsonb;
  v_type     text;
  v_dir      public.trip_direction;
  v_ids      uuid[];
  v_sig      text;
  v_first    timestamptz;
  v_start    timestamptz;
  v_dead     timestamptz;
  v_flight   text;
  v_ra       uuid;
  v_old      record;
  v_kept     int := 0;
  v_created  int := 0;
  v_removed  int := 0;
  v_skipped  int := 0;
  v_notified int := 0;
  v_drivers  int := 0;
  v_keep     uuid[] := ARRAY[]::uuid[];
  v_busy     uuid[];
  v_used     uuid[] := ARRAY[]::uuid[];
  v_tocadas  uuid[];
  v_tablero  int := 0;
  i          int;
  v_res      record;
  v_at       timestamptz;
  v_title    text;
  v_body     text;
  v_total    int := 0;
  -- 0133: los pasajeros sin cuenta (Kriss): van en la ruta, no se les avisa.
  v_gs       jsonb;
  v_gfirst   timestamptz;
  v_gname    text;
  v_gid      uuid;
  v_grid     uuid;
  v_glat     double precision;
  v_glng     double precision;
  v_gplace   text;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica la ruta' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'Falta la ruta' USING ERRCODE = '22023';
  END IF;

  -- Reservas que ya van en una vuelta ARRANCADA de este día: no se vuelven a poner.
  SELECT coalesce(array_agg(DISTINCT rs.reservation_id), ARRAY[]::uuid[]) INTO v_busy
    FROM public.route_assignments ra JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
     AND (ra.status IN ('in_progress', 'completed')
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  FOR b IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
    v_type := CASE WHEN b->>'type' = 'lle' THEN 'lle' ELSE 'sal' END;
    v_dir := CASE WHEN v_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
    -- Solo reservas vivas de la organización y que no estén en una vuelta arrancada.
    SELECT array_agg(x.rid ORDER BY x.ord), min(x.at)
      INTO v_ids, v_first
      FROM (SELECT (s->>'reservation_id')::uuid AS rid, (s->>'at')::timestamptz AS at, o AS ord
              FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)) x
      JOIN public.reservations r ON r.id = x.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org AND r.cancelled_at IS NULL AND r.direction = v_dir
       AND NOT (x.rid = ANY (v_busy)) AND NOT (x.rid = ANY (v_used));
    -- 0133: los sin cuenta del bloque (nombre de 2 letras o más).
    SELECT jsonb_agg(s ORDER BY o), min((s->>'at')::timestamptz)
      INTO v_gs, v_gfirst
      FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)
     WHERE jsonb_typeof(s->'guest') = 'object' AND length(btrim(coalesce(s->'guest'->>'name', ''))) >= 2;
    v_skipped := v_skipped + coalesce(jsonb_array_length(b->'stops'), 0) - coalesce(cardinality(v_ids), 0) - coalesce(jsonb_array_length(v_gs), 0);
    IF coalesce(cardinality(v_ids), 0) = 0 AND v_gs IS NULL THEN CONTINUE; END IF;
    v_ids := coalesce(v_ids, ARRAY[]::uuid[]);
    v_first := least(v_first, v_gfirst);
    v_used := v_used || v_ids;
    v_total := v_total + 1;
    -- 0133: la firma también lleva a los sin cuenta (por nombre); sin ellos es la de 0125.
    v_sig := v_dir::text || ':' || coalesce((SELECT string_agg(u::text, ',' ORDER BY u::text) FROM unnest(v_ids) u), '')
          || coalesce('|g:' || (SELECT string_agg(lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')), ',' ORDER BY lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')))
                                 FROM jsonb_array_elements(v_gs) g), '');
    v_dead := nullif(b->>'deadline_at', '')::timestamptz;
    v_flight := nullif(btrim(b->>'flight'), '');
    -- La llegada sale de JMC cuando el tripulante ya bajó: aterrizaje + desembarque (0058/0099).
    v_start := CASE WHEN v_type = 'lle'
                    THEN v_first + make_interval(mins => coalesce(public.flight_deplane_min(v_flight), 15))
                    ELSE v_first END;

    -- ¿Ya estaba esta misma vuelta (las mismas personas)? Se conserva, con su conductor.
    SELECT ra.id INTO v_ra
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND (ra.direction::text || ':' || coalesce((SELECT string_agg(rs.reservation_id::text, ',' ORDER BY rs.reservation_id::text)
                                           FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NOT NULL), '')
            || coalesce('|g:' || (SELECT string_agg(lower(rs.guest_name), ',' ORDER BY lower(rs.guest_name))
                                   FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NULL), '')) = v_sig
     LIMIT 1;
    IF v_ra IS NOT NULL THEN
      UPDATE public.route_assignments
         SET planned_start_at = v_start, deadline_at = v_dead, manual_note = nullif(btrim(b->>'note'), ''), updated_at = now()
       WHERE id = v_ra;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                            pool, organization_id, manual_day, deadline_at, manual_note)
      VALUES (NULL, NULL, v_dir, 'planned', v_start, true, v_org, p_day, v_dead, nullif(btrim(b->>'note'), ''))
      RETURNING id INTO v_ra;
      v_created := v_created + 1;
    END IF;
    v_keep := v_keep || v_ra;

    -- Las paradas, en el orden del jefe (se reescriben: orden y horas pueden cambiar).
    -- Primero se corren a números altos para no chocar con el UNIQUE del orden.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra;
    i := 0;
    FOR st IN SELECT s FROM jsonb_array_elements(b->'stops') AS t(s) LOOP
      -- 0133: un pasajero sin cuenta es una parada con nombre y lugar (sin reserva).
      IF jsonb_typeof(st->'guest') = 'object' THEN
        v_gname := nullif(regexp_replace(btrim(coalesce(st->'guest'->>'name', '')), '\s+', ' ', 'g'), '');
        CONTINUE WHEN v_gname IS NULL OR length(v_gname) < 2;
        i := i + 1;
        v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
        v_grid := NULL; v_glat := NULL; v_glng := NULL; v_gplace := NULL;
        IF coalesce(st->'guest'->>'residence_id', '') ~ '^[0-9a-fA-F-]{36}$' THEN
          SELECT re.id, re.latitude, re.longitude, re.name INTO v_grid, v_glat, v_glng, v_gplace
            FROM public.residences re WHERE re.id = (st->'guest'->>'residence_id')::uuid AND re.organization_id = v_org;
        END IF;
        v_gplace := coalesce(nullif(btrim(coalesce(st->'guest'->>'place', '')), ''), v_gplace);
        SELECT rs.id INTO v_gid FROM public.route_stops rs
         WHERE rs.route_assignment_id = v_ra AND rs.reservation_id IS NULL AND lower(rs.guest_name) = lower(v_gname) LIMIT 1;
        IF v_gid IS NOT NULL THEN
          UPDATE public.route_stops
             SET stop_order = i, estimated_arrival_at = v_at, guest_name = v_gname, guest_place = v_gplace,
                 guest_phone = nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), guest_residence_id = v_grid, guest_lat = v_glat, guest_lng = v_glng
           WHERE id = v_gid;
        ELSE
          INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at,
                                          guest_name, guest_place, guest_phone, guest_residence_id, guest_lat, guest_lng)
          VALUES (v_ra, NULL, i, v_at, v_gname, v_gplace, nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), v_grid, v_glat, v_glng);
        END IF;
        CONTINUE;
      END IF;
      CONTINUE WHEN NOT ((st->>'reservation_id')::uuid = ANY (v_ids));
      i := i + 1;
      v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
      IF EXISTS (SELECT 1 FROM public.route_stops WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid) THEN
        UPDATE public.route_stops SET stop_order = i, estimated_arrival_at = v_at
         WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid;
      ELSE
        INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES (v_ra, (st->>'reservation_id')::uuid, i, v_at);
      END IF;
    END LOOP;
    DELETE FROM public.route_stops WHERE route_assignment_id = v_ra AND stop_order > 1000;

    -- Avisarle a cada uno su hora (una vez por hora: volver a pegar sin cambios no repite).
    FOR v_res IN
      SELECT r.id, r.direction, ap.profile_id AS crew, rs.estimated_arrival_at AS at, f.flight_number
        FROM public.route_stops rs
        JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        LEFT JOIN public.flights f ON f.id = r.flight_id
       WHERE rs.route_assignment_id = v_ra
    LOOP
      IF v_res.direction = 'home_to_airport' THEN
        v_title := 'Tu recogida está lista 🚗';
        v_body := 'Te recogemos a las ' || public.hm_bog(v_res.at)
          || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END
          || '. Te avisamos quién te recoge.';
      ELSE
        v_title := 'Tu regreso está listo 🚗';
        v_body := 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || '). Te avisamos quién te recoge.';
      END IF;
      IF public.trip_notify(v_res.crew, v_title, v_body, '/#/viaje?r=' || v_res.id::text,
                            'manual:' || v_res.id::text || ':' || to_char(coalesce(v_res.at, v_start) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')) THEN
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
    v_ra := NULL;
  END LOOP;

  -- Lo que Julián puso manda: esas personas salen de las vueltas del TABLERO que
  -- no han arrancado (si no, quedarían en dos carros); la que queda vacía se va.
  WITH quitadas AS (
    DELETE FROM public.route_stops rs USING public.route_assignments ra
     WHERE rs.route_assignment_id = ra.id AND NOT ra.pool AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
  LOOP
    DELETE FROM public.route_assignments WHERE id = v_old.id;
    v_removed := v_removed + 1;
    IF v_old.drv_profile IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_profile, 'Cambió una vuelta que tomaste',
        'Julián cambió la vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '. Revisa las vueltas disponibles.',
        '/#/ruta', 'manualdrop:' || v_old.id::text);
    END IF;
  END LOOP;

  -- Lo que el jefe eligió a mano se aprende para la próxima vez.
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    JOIN public.auxiliar_profiles ap ON ap.id = (a->>'auxiliar_profile_id')::uuid
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();

  -- Los conductores: hay vueltas para tomar (una vez por ruta pegada).
  IF v_created > 0 THEN
    SELECT count(*) INTO v_drivers FROM (
      SELECT public.trip_notify(p.id, 'Hay vueltas para tomar',
               'Julián publicó la ruta del ' || to_char(p_day, 'DD/MM') || ': ' || v_total || ' vueltas. Toma las tuyas en Ruta.',
               '/#/ruta', 'manualpool:' || v_org::text || ':' || p_day::text || ':' || md5(array_to_string(v_keep, ',')) || ':' || p.id::text) AS ok
        FROM public.profiles p
       WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false) z
     WHERE z.ok;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('created', v_created, 'kept', v_kept, 'removed', v_removed, 'skipped', v_skipped,
                            'notified', v_notified, 'drivers', v_drivers, 'vueltas', v_total, 'from_board', v_tablero);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_manual_route_clear(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid := public.current_user_org(); n int;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe quita la ruta' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.route_assignments ra
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day AND ra.status IN ('draft', 'planned')
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_manual_route_publish(date, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_manual_route_publish(date, jsonb, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_manual_route_clear(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_manual_route_clear(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.detect_late_bookings()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- La pasada siguiente del reloj (cada 5 min); 4 para que unos segundos de
  -- atraso del reloj no la hagan esperar una pasada más.
  c_espera constant interval := interval '4 minutes';
  -- Una vuelta de ese día creada hace menos de esto = el jefe está publicando.
  c_calma  constant interval := interval '2 minutes';
  v_sin_carro uuid[];
  v_nuevas integer := 0;
  r        record;
  v_id     uuid;
BEGIN
  -- (a) QUIÉN ESTÁ SIN CARRO EN ESTA PASADA: reserva viva, de un día que YA
  -- tiene plan publicado, sin parada.
  --
  -- «Día con plan publicado» = existe al menos una route_assignment de ese día,
  -- planned o in_progress, con conductor, o pegada por el jefe (pool, 0125), o
  -- delegada (delegated_at, 0126), y que NO la haya armado el sistema solo
  -- (0141). Un borrador no cuenta: mientras el jefe está
  -- armando el día, que falte gente es lo normal y avisar ahí sería ruido puro.
  -- pool y delegated_at se leen con to_jsonb: en una base sin 0125/0126 dan NULL.
  v_sin_carro := ARRAY(
    SELECT res.id
    FROM public.reservations res
    WHERE res.cancelled_at IS NULL
      AND res.required_arrival_at > now()
      -- todavía hay tiempo de hacer algo; después ya es historia, no alerta
      AND res.required_arrival_at < now() + interval '36 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
      AND EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.status IN ('planned', 'in_progress')
          AND (ra.driver_profile_id IS NOT NULL
               OR (to_jsonb(ra) ->> 'pool')::boolean IS TRUE      -- 0125 pegada
               OR (to_jsonb(ra) ->> 'delegated_at') IS NOT NULL)  -- 0126 delegada
          -- 0141: una vuelta que armó el sistema solo NO publica el día.
          AND (to_jsonb(ra) ->> 'auto_created')::boolean IS NOT TRUE
          -- 0141: el día de SU plan (manual_day), no el del calendario: la
          -- madrugada pegada o armada sola es del día anterior.
          AND public.dia_del_plan((to_jsonb(ra) ->> 'manual_day')::date, ra.planned_start_at)
              = (res.required_arrival_at AT TIME ZONE 'America/Bogota')::date));

  -- (b) LA ANOTACIÓN: se olvida a quien ya no está sin carro (lo acomodaron, lo
  -- cancelaron, pasó la hora o el día quedó sin plan) y se anota a quien
  -- aparece por primera vez. Quien ya estaba anotado conserva su hora (created_at).
  DELETE FROM public.late_booking_candidates
   WHERE NOT (reservation_id = ANY (v_sin_carro));
  INSERT INTO public.late_booking_candidates (reservation_id)
  SELECT unnest(v_sin_carro)
  ON CONFLICT (reservation_id) DO NOTHING;

  -- (c) ABRE solo lo confirmado: anotada desde la pasada anterior, sin
  -- eventualidad abierta, y sin una vuelta de ese día recién creada (el jefe
  -- está publicando: la pasada siguiente decide).
  FOR r IN
    SELECT res.id, res.required_arrival_at, res.pickup_address, res.direction,
           pr.full_name AS pax, pr.organization_id,
           EXTRACT(EPOCH FROM (res.required_arrival_at - now())) / 3600 AS horas
    FROM public.late_booking_candidates lb
    JOIN public.reservations res     ON res.id = lb.reservation_id
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    WHERE lb.created_at <= now() - c_espera
      AND NOT EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.created_at > now() - c_calma
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

  -- (d) CIERRA sola: ya la acomodaron, la cancelaron, o el servicio ya pasó.
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

REVOKE ALL    ON FUNCTION public.detect_late_bookings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_late_bookings() TO service_role;

COMMENT ON FUNCTION public.detect_late_bookings()
  IS 'Abre una eventualidad late_booking por cada reserva viva de un día CON PLAN PUBLICADO que lleva sin parada al menos una pasada del reloj seguida y sin que nadie esté publicando ese día (0127: anotada en late_booking_candidates; no suena mientras el jefe re-publica) (0141: una vuelta armada sola por el sistema no publica el día, y la pegada cuenta para el día de su plan), y las cierra solas cuando entran a una ruta, se cancelan o ya pasó la hora. No calcula si cabe: eso lo hace el tablero.';

CREATE OR REPLACE FUNCTION public.reubicar_reserva(p_res uuid, p_ready timestamptz DEFAULT NULL, p_motivo text DEFAULT 'cambio')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record; cur record; o record; c record; s record; e record;
  v_buf int; v_srv int; v_cap int; v_win int; v_cut int;
  v_ap_lat double precision; v_ap_lng double precision;
  v_lle boolean; v_P timestamptz; v_ready timestamptz; v_vuelo text; v_ref timestamptz;
  v_who text; v_lugar text; v_pub_dia boolean; v_pre text; v_tit text; v_skip2 uuid;
  a_ord int[]; a_eta timestamptz[]; a_res uuid[]; a_lat double precision[]; a_lng double precision[];
  n int; k int; v_leg numeric; v_leg2 numeric;
  v_A timestamptz; v_A2 timestamptz; v_eta timestamptz; v_score numeric; v_det numeric; v_madr numeric;
  b_ra uuid; b_after int; b_eta timestamptz; b_score numeric;
  t_ok boolean := false; t_start timestamptz; t_eta timestamptz; t_ini timestamptz; t_fin timestamptz;
  v_removed int := 0; v_deleg boolean := false; v_kind text := 'unplanned';
  v_ra uuid; v_start timestamptz; v_from timestamptz; v_drv_prof uuid; v_drv_name text; v_dia date;
BEGIN
  SELECT res.*, ap.profile_id AS crew, pr.organization_id AS org, pr.full_name AS nombre,
         rz.sector AS sector, rz.name AS conjunto, f.flight_number AS vuelo_tabla
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    LEFT JOIN public.residences rz   ON rz.id = res.residence_id
    LEFT JOIN public.flights f       ON f.id = res.flight_id
   WHERE res.id = p_res;
  IF r.id IS NULL OR r.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('kind', 'none'); END IF;
  v_who := public.short_name(r.nombre);
  v_lugar := coalesce(r.conjunto, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''));
  v_vuelo := coalesce(r.vuelo_tabla, r.flight_code, nullif(upper(regexp_replace(
    coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''), '[[:space:]-]', '', 'g')), ''));

  SELECT route_airport_buffer_min, route_service_min, route_default_capacity, route_merge_window_min, route_night_cutoff_min
    INTO v_buf, v_srv, v_cap, v_win, v_cut FROM public.app_settings WHERE id = 'singleton';
  v_buf := coalesce(v_buf, 10); v_srv := coalesce(v_srv, 3); v_cap := coalesce(v_cap, 4); v_win := coalesce(v_win, 20); v_cut := coalesce(v_cut, 120);
  SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng FROM public.airports a WHERE a.organization_id = r.org ORDER BY a.created_at LIMIT 1;
  v_ap_lat := coalesce(v_ap_lat, 6.1715); v_ap_lng := coalesce(v_ap_lng, -75.4270);

  v_lle := r.direction = 'airport_to_home';
  IF v_lle THEN
    v_ready := coalesce(p_ready, r.required_arrival_at + make_interval(mins => CASE
      WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
      ELSE coalesce(public.flight_deplane_min(v_vuelo), 15) END));
  ELSE
    v_P := r.required_arrival_at;
  END IF;
  v_ref := coalesce(v_ready, v_P);
  v_pre := CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo cambió de hora: ' WHEN 'pedido' THEN 'Ya tienes carro: ' ELSE 'Con tu hora nueva ' END;

  -- ¿El día ya tiene ruta publicada? (antes de tocar nada: si era la única vuelta
  -- y se quita, el día parecería sin ruta)
  v_pub_dia := EXISTS (
    SELECT 1 FROM public.route_assignments ra
     WHERE ra.status IN ('planned', 'in_progress')
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
       AND NOT coalesce(ra.auto_created, false)   -- 0141: la que armó el sistema solo no publica el día
       AND public.dia_del_plan(ra.manual_day, ra.planned_start_at) = (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date
       AND (ra.organization_id = r.org OR EXISTS (
             SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
               JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
              WHERE x.route_assignment_id = ra.id AND yp.organization_id = r.org)));

  IF NOT v_pub_dia THEN
    -- Sin ruta publicada ese día: sale del borrador (si estaba) y el tablero la rutea al publicar.
    FOR o IN SELECT rs.id AS stop_id, ra.id AS ra_id FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
              WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status IN ('draft', 'planned', 'in_progress')
    LOOP
      DELETE FROM public.route_stops WHERE id = o.stop_id;
      DELETE FROM public.route_assignments x WHERE x.id = o.ra_id AND x.status IN ('draft', 'planned')
         AND NOT EXISTS (SELECT 1 FROM public.route_stops y WHERE y.route_assignment_id = x.id);
      v_removed := v_removed + 1;
    END LOOP;
    RETURN jsonb_build_object('kind', 'unplanned', 'dir', r.direction, 'removed', v_removed, 'was_delegated', false);
  END IF;

  -- Su vuelta de ahora (sin arrancar), cuántos van y dónde empieza/termina.
  SELECT ra.id, ra.status, ra.pool, ra.delegated_at, ra.driver_profile_id AS drv, ra.planned_start_at, ra.deadline_at, rs.id AS stop_id,
         (SELECT count(*) FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
           WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL))::int AS n
    INTO cur
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
   WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status = 'planned'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
   ORDER BY ra.planned_start_at DESC LIMIT 1;
  -- Si iba sola, su vuelta se va a quitar: no le estorba a su conductor.
  v_skip2 := CASE WHEN cur.n = 1 THEN cur.id END;

  -- ── ¿Se puede correr su misma vuelta? (iba sola, sin delegar, su conductor
  --    alcanza y a esa hora está trabajando) ──
  IF cur.id IS NOT NULL AND cur.n = 1 AND cur.delegated_at IS NULL AND (cur.drv IS NOT NULL OR cur.pool) THEN
    SELECT * INTO e FROM public.reub_extremos(cur.id);
    IF v_lle THEN
      t_start := public.reub_arriba5(v_ready); t_eta := NULL;
      v_leg := public.reub_leg(NULL, v_ap_lat, v_ap_lng, true, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
      t_ini := t_start; t_fin := t_start + make_interval(mins => ceil(v_leg + v_srv)::int);
      t_ok := t_start >= now() + interval '10 minutes'
              AND public.reub_conductor_libre(cur.drv, cur.id, NULL, t_ini, NULL, v_ap_lat, v_ap_lng, true,
                                              t_fin, r.residence_id, r.pickup_latitude, r.pickup_longitude, false)
              AND public.reub_mismo_turno(cur.drv, cur.id, e.ini_at, e.fin_at, t_ini, t_fin);
    ELSE
      v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
      t_eta := public.reub_abajo5(v_P - make_interval(mins => ceil(v_leg + v_buf + v_srv)::int)); t_start := t_eta;
      t_ini := t_eta; t_fin := t_eta + make_interval(mins => ceil(v_leg + v_srv)::int);
      t_ok := t_eta >= now() + interval '15 minutes'
              AND public.reub_conductor_libre(cur.drv, cur.id, NULL, t_ini, r.residence_id, r.pickup_latitude, r.pickup_longitude, false,
                                              t_fin, NULL, v_ap_lat, v_ap_lng, true)
              AND public.reub_mismo_turno(cur.drv, cur.id, e.ini_at, e.fin_at, t_ini, t_fin);
    END IF;
  END IF;

  -- ── La mejor otra vuelta donde entre SIN mover a nadie ──
  FOR c IN SELECT * FROM public.reub_candidatas(p_res, v_cap) LOOP
    a_ord := ARRAY[]::int[]; a_eta := ARRAY[]::timestamptz[]; a_res := ARRAY[]::uuid[];
    a_lat := ARRAY[]::double precision[]; a_lng := ARRAY[]::double precision[];
    FOR s IN SELECT x.stop_order, x.estimated_arrival_at AS eta, coalesce(y.residence_id, x.guest_residence_id) AS res,
                    coalesce(y.pickup_latitude, x.guest_lat) AS lat, coalesce(y.pickup_longitude, x.guest_lng) AS lng
               FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
              WHERE x.route_assignment_id = c.ra_id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
              ORDER BY x.stop_order
    LOOP
      a_ord := a_ord || s.stop_order; a_eta := a_eta || s.eta; a_res := a_res || s.res; a_lat := a_lat || s.lat; a_lng := a_lng || s.lng;
    END LOOP;
    n := coalesce(array_length(a_ord, 1), 0);
    CONTINUE WHEN n = 0;

    IF NOT v_lle THEN
      -- SALIDA. La vuelta llega a tiempo a SU presentación sin madrugarla más que
      -- la ventana de juntar (lo mismo que el tablero); cada recogida tiene su hora.
      CONTINUE WHEN c.dl IS NULL OR c.dl > v_P OR v_P - c.dl > make_interval(mins => v_win);
      CONTINUE WHEN EXISTS (SELECT 1 FROM unnest(a_eta) t WHERE t IS NULL);
      v_madr := extract(epoch FROM (v_P - c.dl)) / 60;
      v_A := a_eta[n] + make_interval(mins => ceil(v_srv + public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, NULL, v_ap_lat, v_ap_lng, true))::int);
      FOR k IN 0..n LOOP
        -- k = entra después de la parada k (0 = de primera; n = de última).
        v_eta := NULL; v_A2 := v_A; v_det := NULL;
        IF k > 0 AND a_res[k] IS NOT NULL AND a_res[k] = r.residence_id THEN
          v_eta := a_eta[k]; v_det := 1;                                          -- con su vecina, a la misma hora
        ELSIF k = 0 THEN
          v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, a_res[1], a_lat[1], a_lng[1], false);
          IF v_leg <= 15 THEN                                                     -- de primera solo si queda cerca
            v_eta := public.reub_abajo5(a_eta[1] - make_interval(mins => ceil(v_leg + v_srv)::int)); v_det := v_leg + v_srv;
          END IF;
        ELSIF k < n THEN
          v_leg := public.reub_leg(a_res[k], a_lat[k], a_lng[k], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
          v_leg2 := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, a_res[k + 1], a_lat[k + 1], a_lng[k + 1], false);
          v_eta := a_eta[k] + make_interval(mins => ceil(v_srv + v_leg)::int);
          IF v_eta + make_interval(mins => ceil(v_srv + v_leg2)::int) > a_eta[k + 1] THEN v_eta := NULL;   -- no hay hueco
          ELSE v_det := v_leg + v_leg2 + v_srv - public.reub_leg(a_res[k], a_lat[k], a_lng[k], false, a_res[k + 1], a_lat[k + 1], a_lng[k + 1], false); END IF;
        ELSE
          v_leg := public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
          v_leg2 := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
          v_eta := a_eta[n] + make_interval(mins => ceil(v_srv + v_leg)::int);
          v_A2 := v_eta + make_interval(mins => ceil(v_srv + v_leg2)::int);
          -- De última solo si TODOS siguen llegando a su presentación.
          IF v_A2 + make_interval(mins => v_buf) > c.dl THEN v_eta := NULL;
          ELSE v_det := v_leg + v_leg2 + v_srv - public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, NULL, v_ap_lat, v_ap_lng, true); END IF;
        END IF;
        CONTINUE WHEN v_eta IS NULL;
        -- La recogida en múltiplo de 5 hacia abajo (como el tablero), nunca antes
        -- de la anterior; con la vecina, la misma de ella.
        IF k > 0 AND NOT (a_res[k] IS NOT NULL AND a_res[k] = r.residence_id) THEN
          v_eta := greatest(public.reub_abajo5(v_eta), a_eta[k]);
        END IF;
        CONTINUE WHEN v_eta < now() + interval '20 minutes';
        -- Si la vuelta arranca antes (de primera) o termina después (de última),
        -- su conductor tiene que alcanzar.
        IF c.drv IS NOT NULL AND (k = 0 OR k = n) THEN
          SELECT * INTO e FROM public.reub_extremos(c.ra_id);
          CONTINUE WHEN NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
               least(e.ini_at, v_eta), CASE WHEN k = 0 THEN r.residence_id ELSE e.ini_res END,
               CASE WHEN k = 0 THEN r.pickup_latitude ELSE e.ini_lat END, CASE WHEN k = 0 THEN r.pickup_longitude ELSE e.ini_lng END, false,
               greatest(e.fin_at, v_A2), NULL, v_ap_lat, v_ap_lng, true);
        END IF;
        v_score := v_det + 0.5 * v_madr + CASE WHEN c.drv IS NULL THEN 5 ELSE 0 END - CASE WHEN c.sector_igual THEN 3 ELSE 0 END;
        IF b_score IS NULL OR v_score < b_score THEN
          b_score := v_score; b_ra := c.ra_id; b_after := CASE WHEN k = 0 THEN 0 ELSE a_ord[k] END; b_eta := v_eta;
        END IF;
      END LOOP;
    ELSE
      -- LLEGADA: sale de JMC cuando ya bajó y la espera es corta. Con alguien de
      -- su conjunto (justo después) o de última.
      CONTINUE WHEN c.start_at < v_ready OR c.start_at > v_ready + interval '15 minutes';
      k := NULL;
      FOR i IN 1..n LOOP
        IF a_res[i] IS NOT NULL AND a_res[i] = r.residence_id THEN k := i; END IF;
      END LOOP;
      SELECT * INTO e FROM public.reub_extremos(c.ra_id);
      IF k IS NOT NULL THEN
        v_det := v_srv;
        CONTINUE WHEN c.drv IS NOT NULL AND NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
          e.ini_at, NULL, v_ap_lat, v_ap_lng, true, e.fin_at + make_interval(mins => v_srv), e.fin_res, e.fin_lat, e.fin_lng, e.fin_air);
      ELSE
        k := n;
        v_det := v_srv + public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
        CONTINUE WHEN c.drv IS NOT NULL AND NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
          e.ini_at, NULL, v_ap_lat, v_ap_lng, true, e.fin_at + make_interval(mins => ceil(v_det)::int), r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
      END IF;
      v_score := 0.5 * extract(epoch FROM (c.start_at - v_ready)) / 60 + v_det
                 + CASE WHEN c.drv IS NULL THEN 5 ELSE 0 END - CASE WHEN c.sector_igual THEN 3 ELSE 0 END;
      IF b_score IS NULL OR v_score < b_score THEN
        b_score := v_score; b_ra := c.ra_id; b_after := a_ord[k]; b_eta := NULL;
      END IF;
    END IF;
  END LOOP;

  -- ── Decide ──
  --   juntarse casi sin desvío (un viaje menos) > correr su vuelta > juntarse > vuelta nueva.
  IF b_ra IS NOT NULL AND (b_score <= 15 OR NOT t_ok) THEN
    v_kind := 'joined';
  ELSIF t_ok THEN
    v_kind := 'retimed';
  ELSE
    v_kind := 'new';
  END IF;

  IF v_kind = 'retimed' THEN
    v_ra := cur.id; v_from := cur.planned_start_at; v_start := t_start;
    UPDATE public.route_assignments
       SET planned_start_at = t_start,
           deadline_at = CASE WHEN deadline_at IS NOT NULL THEN v_P END,
           updated_at = now()
     WHERE id = cur.id;
    UPDATE public.route_stops
       SET estimated_arrival_at = CASE WHEN v_lle THEN estimated_arrival_at + (t_start - cur.planned_start_at) ELSE t_eta END
     WHERE id = cur.stop_id;
    SELECT dp.profile_id, pp.full_name INTO v_drv_prof, v_drv_name
      FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = cur.drv;
    v_eta := t_eta;
    PERFORM public.trip_notify(r.crew, CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: ajustamos tu traslado 🔄' END,
      v_pre || CASE WHEN v_lle THEN 'te esperamos en JMC a las ' || public.hm_bog(t_start) ELSE 'te recogemos a las ' || public.hm_bog(t_eta) END
      || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
      '/#/viaje?r=' || p_res::text, 'reub-time:' || p_res::text || ':' || to_char(t_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
        'La ' || CASE WHEN v_lle THEN 'llegada' ELSE 'salida' END || ' de ' || v_who || ' pasa de las ' || public.hm_bog(cur.planned_start_at)
        || ' a las ' || public.hm_bog(t_start) || CASE p_motivo WHEN 'vuelo' THEN ' (su vuelo cambió de hora).' ELSE ' (cambió su vuelo).' END,
        '/', 'reub-drvtime:' || cur.id::text || ':' || to_char(t_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
    PERFORM public.sync_calculated_pickup(p_res);
  ELSE
    -- Sale de su vuelta vieja (si queda vacía se quita; al conductor se le avisa).
    FOR o IN
      SELECT rs.id AS stop_id, ra.id AS ra_id, ra.planned_start_at, ra.delegated_at, dp.profile_id AS drv_prof
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
       WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status IN ('draft', 'planned', 'in_progress')
    LOOP
      DELETE FROM public.route_stops WHERE id = o.stop_id;
      DELETE FROM public.route_assignments ra
       WHERE ra.id = o.ra_id AND ra.status IN ('draft', 'planned')
         AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
      v_removed := v_removed + 1;
      IF o.delegated_at IS NOT NULL THEN v_deleg := true; END IF;
      IF o.drv_prof IS NOT NULL THEN
        PERFORM public.trip_notify(o.drv_prof, 'Cambió un traslado de tu ruta',
          v_who || CASE p_motivo WHEN 'vuelo' THEN ': su vuelo cambió de hora' ELSE ' cambió su vuelo' END
          || ', ya no va en tu vuelta de las ' || public.hm_bog(o.planned_start_at) || '.',
          '/', 'reub-out:' || p_res::text || ':' || o.ra_id::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
      END IF;
    END LOOP;
  END IF;

  IF v_kind = 'joined' THEN
    -- Entra en esa vuelta; los demás conservan su orden y su hora.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = b_ra AND stop_order > b_after;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (b_ra, p_res, b_after + 1, b_eta);
    UPDATE public.route_stops SET stop_order = stop_order - 999 WHERE route_assignment_id = b_ra AND stop_order > 1000;
    IF NOT v_lle AND b_eta IS NOT NULL THEN
      UPDATE public.route_assignments SET planned_start_at = least(planned_start_at, b_eta), updated_at = now() WHERE id = b_ra;
    END IF;
    SELECT ra.planned_start_at, dp.profile_id, pp.full_name INTO v_start, v_drv_prof, v_drv_name
      FROM public.route_assignments ra LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pp ON pp.id = dp.profile_id WHERE ra.id = b_ra;
    v_ra := b_ra; v_eta := b_eta;
    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: te movimos de vuelta 🔄' END;
    PERFORM public.trip_notify(r.crew, v_tit,
      v_pre || CASE WHEN v_lle THEN 'te esperamos en JMC a las ' || public.hm_bog(v_start) ELSE 'te recogemos a las ' || public.hm_bog(v_eta) END
      || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
      '/#/viaje?r=' || p_res::text, 'reub-in:' || p_res::text || ':' || v_ra::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Se sumó alguien a tu vuelta',
        v_who || ' va en tu vuelta de las ' || public.hm_bog(v_start)
        || CASE WHEN v_lle THEN coalesce(': lo dejas en ' || v_lugar, '') ELSE ': recogida ' || public.hm_bog(v_eta) || coalesce(' en ' || v_lugar, '') END || '.',
        '/', 'reub-drv:' || p_res::text || ':' || v_ra::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
  ELSIF v_kind = 'new' THEN
    -- Vuelta NUEVA para tomar, solo para ella.
    IF NOT v_lle THEN
      v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
      v_eta := public.reub_abajo5(v_P - make_interval(mins => ceil(v_leg + v_buf + v_srv)::int));
      v_start := v_eta;
    ELSE
      v_start := public.reub_arriba5(v_ready); v_eta := NULL;
    END IF;
    -- El día del plan: lo de la madrugada (antes del corte) es del día anterior.
    v_dia := (v_start AT TIME ZONE 'America/Bogota')::date;
    IF extract(hour FROM v_start AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_start AT TIME ZONE 'America/Bogota') < v_cut THEN
      v_dia := v_dia - 1;
    END IF;
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                          pool, auto_created, organization_id, manual_day, deadline_at, manual_note)
    VALUES (NULL, NULL, r.direction, 'planned', v_start, true, true, r.org, v_dia,
            CASE WHEN NOT v_lle THEN v_P END,
            CASE p_motivo WHEN 'vuelo' THEN 'Creada sola: su vuelo cambió de hora' WHEN 'pedido' THEN 'Creada sola: pidió con el día publicado'
                          ELSE 'Creada sola: cambio de vuelo' END)
    RETURNING id INTO v_ra;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (v_ra, p_res, 1, v_eta);
    PERFORM public.trip_notify(r.crew, 'Te armamos una vuelta 🚗',
      v_pre || CASE WHEN NOT v_lle
           THEN 'te recogemos a las ' || public.hm_bog(v_eta) || ' para estar en JMC a las ' || public.hm_bog(v_P)
           ELSE 'te esperamos en JMC a las ' || public.hm_bog(v_start) END
      || '. Te avisamos quién te recoge.',
      '/#/viaje?r=' || p_res::text, 'reub-new:' || p_res::text || ':' || v_ra::text);
    PERFORM public.trip_notify(p.id, 'Hay una vuelta para tomar',
      CASE WHEN NOT v_lle THEN 'Salida' ELSE 'Llegada' END || ' de las ' || public.hm_bog(v_start)
      || ' (' || v_who || coalesce(', ' || v_lugar, '') || '): '
      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado' ELSE 'cambió de vuelo' END
      || ' y no cabía en otra. Tómala en Ruta si puedes.',
      '/#/ruta', 'reub-pool:' || v_ra::text || ':' || p.id::text)
      FROM public.profiles p
     WHERE p.organization_id = r.org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('kind', v_kind, 'dir', r.direction, 'ra_id', v_ra, 'start_at', v_start, 'from_at', v_from,
                            'pickup_at', CASE WHEN NOT v_lle THEN v_eta ELSE v_start END,
                            'driver_name', v_drv_name, 'removed', v_removed, 'was_delegated', v_deleg,
                            -- Muy encima: menos de 45 min para la recogida.
                            'tight', coalesce(CASE WHEN NOT v_lle THEN v_eta ELSE v_start END < now() + interval '45 minutes', false));
END;
$$;

REVOKE ALL ON FUNCTION public.reubicar_reserva(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.dia_madrugada(timestamptz);

COMMIT;
