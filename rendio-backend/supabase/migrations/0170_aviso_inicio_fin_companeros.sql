-- =============================================================================
-- 0170 · «Inició / terminó una vuelta» también les llega a los compañeros de turno
-- =============================================================================
-- Harold, 17-nov: «cuando un conductor inicia o termina una vuelta, que nos llega a
-- los admin, también le llegue al conductor de turno, compañero. Si Migue inició,
-- que le llegue a Juan porque está del mismo turno». Es el «saliendo con Juan /
-- finalizado con Juan» que miraban en el grupo.
--
-- Son las funciones de 0136 (iniciar) y 0128/0137 (terminar) TAL CUAL, leídas de
-- producción el 17-nov, con un lazo más: conductores_del_turno(org, now()) —los
-- del horario publicado de este turno y los que tienen turno abierto— menos el que
-- hizo la vuelta. A los jefes les sigue llegando igual (NO se quita, ver memoria
-- «avisos inicio/fin obligatorios»). Lo próximo que toque estas dos: copiar DESDE 0170.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.route_started_alert_enqueue(p_ra uuid, p_except uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ra     record;
  v_org    uuid;
  v_nombres text;
  v_hora   text;
  v_titulo text;
  v_cuerpo text;
  v_n      int := 0;
  j        record;
BEGIN
  IF p_ra IS NULL THEN RETURN 0; END IF;
  -- El botón y la primera marca pueden llegar casi juntos: en fila.
  PERFORM pg_advisory_xact_lock(hashtext('ini-vuelta:' || p_ra::text));

  -- ¿Ya arrancó hace rato? (alguien a bordo, entregado o «no se presentó»)
  IF EXISTS (SELECT 1 FROM public.route_stops rs
               LEFT JOIN public.reservations r ON r.id = rs.reservation_id
              WHERE rs.route_assignment_id = p_ra
                AND rs.id IS DISTINCT FROM p_except
                AND (r.id IS NULL OR r.cancelled_at IS NULL)
                AND rs.status IN ('picked_up', 'delivered', 'no_show')) THEN
    RETURN 0;
  END IF;

  SELECT ra.id, ra.direction, ra.organization_id, ra.planned_start_at,
         pd.full_name AS conductor, pd.organization_id AS org_conductor, pd.id AS conductor_id,
         (SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs
           WHERE rs.route_assignment_id = ra.id) AS t0
    INTO v_ra
    FROM public.route_assignments ra
    LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
    LEFT JOIN public.profiles pd        ON pd.id = dp.profile_id
   WHERE ra.id = p_ra
     AND ra.status IN ('planned', 'in_progress');
  IF v_ra.id IS NULL THEN RETURN 0; END IF;

  -- La organización, como 0128: la de la vuelta; si no (vueltas del tablero), la
  -- del conductor; si no, la de un tripulante de la vuelta.
  v_org := coalesce(v_ra.organization_id, v_ra.org_conductor, (
    SELECT pr.organization_id
      FROM public.route_stops rs
      JOIN public.reservations res     ON res.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = v_ra.id
     LIMIT 1));
  IF v_org IS NULL THEN RETURN 0; END IF;

  -- A quiénes va a recoger, en el orden de la vuelta (con los sin cuenta de 0133).
  SELECT string_agg(public.short_name(coalesce(pr.full_name, rs.guest_name)), ', ' ORDER BY rs.stop_order)
    INTO v_nombres
    FROM public.route_stops rs
    LEFT JOIN public.reservations res     ON res.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = v_ra.id
     AND (res.id IS NULL OR res.cancelled_at IS NULL);
  -- Una vuelta sin nadie (todas canceladas) no es un servicio.
  IF v_nombres IS NULL THEN RETURN 0; END IF;

  -- La hora con la que los jefes nombran la vuelta (la misma de 0128).
  v_hora := public.hm_bog(CASE WHEN v_ra.direction = 'airport_to_home'
                               THEN coalesce(v_ra.planned_start_at, v_ra.t0)
                               ELSE coalesce(v_ra.t0, v_ra.planned_start_at) END);
  v_titulo := '🚗 '
           || CASE WHEN coalesce(btrim(v_ra.conductor), '') = '' THEN 'Un conductor'
                   ELSE public.short_name(v_ra.conductor) END
           || ' inició una vuelta';
  v_cuerpo := CASE WHEN v_ra.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END
           || coalesce(' de las ' || v_hora, '')
           || ' · recoge a ' || v_nombres
           || CASE WHEN v_ra.direction = 'airport_to_home' THEN ' en el aeropuerto' ELSE '' END;

  FOR j IN SELECT r.profile_id FROM public.ops_alert_recipients_of(v_org) r LOOP
    -- Ya enviado (o ya en cola): no se repite.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                           WHERE o.dedupe_key = 'ini:' || v_ra.id::text || ':' || j.profile_id::text);
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/#/operacion',
            'ini:' || v_ra.id::text || ':' || j.profile_id::text)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN v_n := v_n + 1; END IF;
  END LOOP;

  -- 0170: también a los COMPAÑEROS que están en turno ahora (no al que la inició).
  FOR j IN SELECT c.profile_id FROM public.conductores_del_turno(v_org, now()) c
            WHERE c.profile_id IS DISTINCT FROM v_ra.conductor_id LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                           WHERE o.dedupe_key = 'ini:' || v_ra.id::text || ':' || j.profile_id::text);
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/',
            'ini:' || v_ra.id::text || ':' || j.profile_id::text)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN v_n := v_n + 1; END IF;
  END LOOP;

  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.route_finished_alert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ra     record;
  v_org    uuid;
  v_faltan int;
  v_ok     text;
  v_ns     text;
  v_hora   text;
  v_titulo text;
  v_cuerpo text;
  v_n      int := 0;
  j        record;
BEGIN
  -- Solo importa cuando la parada entra o sale de «resuelta».
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR ((NEW.status IN ('delivered', 'no_show')) = (OLD.status IN ('delivered', 'no_show'))) THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('fin-vuelta:' || NEW.route_assignment_id::text));

    -- ¿Le queda alguna parada viva sin resolver?
    SELECT count(*) INTO v_faltan
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
     WHERE rs.route_assignment_id = NEW.route_assignment_id
       AND (r.id IS NULL OR r.cancelled_at IS NULL)
       AND rs.status NOT IN ('delivered', 'no_show');

    IF v_faltan > 0 THEN
      -- Dejó de estar terminada (un «Deshacer»): lo que no ha salido, se borra.
      DELETE FROM public.notification_outbox
       WHERE dedupe_key LIKE 'fin:' || NEW.route_assignment_id::text || ':%'
         AND sent_at IS NULL;
      RETURN NULL;
    END IF;

    SELECT ra.id, ra.direction, ra.organization_id, ra.planned_start_at,
           pd.full_name AS conductor, pd.organization_id AS org_conductor, pd.id AS conductor_id,
           (SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs
             WHERE rs.route_assignment_id = ra.id) AS t0
      INTO v_ra
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pd        ON pd.id = dp.profile_id
     WHERE ra.id = NEW.route_assignment_id;
    IF v_ra.id IS NULL THEN RETURN NULL; END IF;

    -- La organización: la de la vuelta (0125); si no la tiene (vueltas del
    -- tablero), la del conductor; si no, la de un tripulante de la vuelta.
    v_org := coalesce(v_ra.organization_id, v_ra.org_conductor, (
      SELECT pr.organization_id
        FROM public.route_stops rs
        JOIN public.reservations res     ON res.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
        JOIN public.profiles pr          ON pr.id = ap.profile_id
       WHERE rs.route_assignment_id = v_ra.id
       LIMIT 1));
    IF v_org IS NULL THEN RETURN NULL; END IF;

    -- Quiénes quedaron entregados y quiénes no se presentaron, en el orden de la vuelta.
    SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) FILTER (WHERE rs.status = 'delivered'),
           string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) FILTER (WHERE rs.status = 'no_show')
      INTO v_ok, v_ns
      FROM public.route_stops rs
      JOIN public.reservations res          ON res.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = v_ra.id
       AND res.cancelled_at IS NULL;
    -- Una vuelta sin nadie (todas canceladas) no es un servicio terminado.
    IF v_ok IS NULL AND v_ns IS NULL THEN RETURN NULL; END IF;

    -- La hora con la que los jefes nombran la vuelta: en una salida, la primera
    -- recogida; en una llegada, la salida del aeropuerto («la llegada de las 16:05»).
    v_hora := public.hm_bog(CASE WHEN v_ra.direction = 'airport_to_home'
                                 THEN coalesce(v_ra.planned_start_at, v_ra.t0)
                                 ELSE coalesce(v_ra.t0, v_ra.planned_start_at) END);
    v_titulo := CASE WHEN v_ns IS NULL THEN '✅ ' ELSE '⚠️ ' END
             || coalesce(public.short_name(v_ra.conductor), 'Un conductor') || ' terminó una vuelta';
    v_cuerpo := CASE WHEN v_ra.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END
             || coalesce(' de las ' || v_hora, '')
             || CASE
                  WHEN v_ok IS NULL THEN ''
                  WHEN v_ra.direction = 'home_to_airport' THEN ' · ' || v_ok || ' en el aeropuerto'
                  ELSE ' · entregó a ' || v_ok
                END
             || coalesce(' · No se presentó: ' || v_ns, '');

    FOR j IN SELECT r.profile_id FROM public.ops_alert_recipients_of(v_org) r LOOP
      -- Ya enviado (o ya en cola): no se repite.
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                             WHERE o.dedupe_key = 'fin:' || v_ra.id::text || ':' || j.profile_id::text);
      INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
      VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/#/operacion',
              'fin:' || v_ra.id::text || ':' || j.profile_id::text, now() + interval '2 minutes')
      ON CONFLICT DO NOTHING;
      v_n := v_n + 1;
    END LOOP;
    -- 0170: también a los COMPAÑEROS que están en turno ahora (no al que la terminó).
    -- Misma llave «fin:…»: si deshace la última parada, también se les borra.
    FOR j IN SELECT c.profile_id FROM public.conductores_del_turno(v_org, now()) c
              WHERE c.profile_id IS DISTINCT FROM v_ra.conductor_id LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                             WHERE o.dedupe_key = 'fin:' || v_ra.id::text || ':' || j.profile_id::text);
      INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
      VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/',
              'fin:' || v_ra.id::text || ':' || j.profile_id::text, now() + interval '2 minutes')
      ON CONFLICT DO NOTHING;
      v_n := v_n + 1;
    END LOOP;
    -- No hace falta trip_kick: el aviso sale dentro de 2 min y lo recoge el
    -- despacho de cada minuto.
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'route_finished_alert: no se armó el aviso de la vuelta % (%)', NEW.route_assignment_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

COMMIT;
