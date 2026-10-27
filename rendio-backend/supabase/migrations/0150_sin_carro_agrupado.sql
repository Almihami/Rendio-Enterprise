-- =============================================================================
-- 0150 · «No tiene carro»: un solo aviso por jefe con todos los de esa pasada
--        (27-oct-2026)
-- =============================================================================
-- La profa (27-oct): «cuando modifica alguna ruta llegan como 30 o 40
-- notificaciones de corrido de avisos de que no tiene carro, y se supone eso estaba
-- arreglado». Medido en producción, noche del 26: 14 «no tiene carro» × 3 jefes =
-- 42 notificaciones; seis a la vez entre las 10:20 y las 10:25 p. m. (18 de golpe).
-- Coinciden con los pegados de la ruta de Julián (el pegado viejo sacaba a la gente
-- del tablero y, con el error de admin_manual_route_publish, no la volvía a montar);
-- 8 de las 14 ya tenían vuelta 10 min después. La regla de 0127 (4 min seguidos y
-- 2 min de calma) sí sirvió al publicar el tablero: el Publicar de las 5:29 (33
-- vueltas) no disparó ninguno. Desde v235 el pegado ya no toca vueltas aparte.
--
-- QUÉ HACE
--   · late_bookings_alert(ids): NUEVA. Los de una misma pasada salen juntos: una
--     notificación por jefe («🚨 6 tripulantes no tienen carro» + nombres y horas).
--     Uno solo: el aviso de siempre (enqueue_incident_alert, 0117).
--   · detect_late_bookings: copia de 0146; cambia solo lo marcado «0150» (junta los
--     ids y llama a late_bookings_alert al final). Las eventualidades se siguen
--     abriendo una por persona, igual que antes.
-- Lo próximo que toque detect_late_bookings copia DESDE 0150.
-- Down: down_migrations/0150_sin_carro_agrupado.down.sql.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.late_bookings_alert(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g       record;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n     integer := 0;
BEGIN
  FOR g IN
    SELECT i.organization_id AS org, count(*)::int n, bool_or(i.severity = 'high') grave,
           (array_agg(i.id ORDER BY public.hora_que_importa(i.reservation_id)))[1] AS uno,
           string_agg(coalesce(split_part(pr.full_name, ' ', 1), 'Alguien') || ' ('
             || CASE WHEN r.direction = 'airport_to_home' THEN 'llega ' ELSE 'sale ' END
             || public.hm_bog(public.hora_que_importa(r.id)) || ')', ', '
             ORDER BY public.hora_que_importa(r.id)) AS quienes
      FROM public.incidents i
      JOIN public.reservations r       ON r.id = i.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles pr     ON pr.id = ap.profile_id
     WHERE i.id = ANY (p_ids)
     GROUP BY i.organization_id
  LOOP
    IF g.n = 1 THEN
      -- Una sola persona: el aviso de siempre (enqueue_incident_alert, 0117).
      v_n := v_n + public.enqueue_incident_alert(g.uno);
      CONTINUE;
    END IF;
    INSERT INTO public.notification_outbox (profile_id, incident_id, title, body, url, dedupe_key)
    SELECT j.profile_id, NULL,
           CASE WHEN g.grave THEN '🚨 ' ELSE '' END || g.n || ' tripulantes no tienen carro',
           left('El plan ya está publicado y quedaron por fuera: ' || g.quienes || '. Ubícalos en Asignación.', 280),
           '/#/rutas', 'lategrp:' || g.org::text || ':' || v_sello || ':' || j.profile_id::text
      FROM public.ops_alert_recipients_of(g.org) j
    ON CONFLICT DO NOTHING;
    UPDATE public.incidents SET notified_at = coalesce(notified_at, now())
     WHERE id = ANY (p_ids) AND organization_id = g.org;
    v_n := v_n + (SELECT count(*)::int FROM public.ops_alert_recipients_of(g.org));
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.late_bookings_alert(uuid[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.late_bookings_alert(uuid[])
  IS '0150: avisa a los jefes los «no tiene carro» abiertos en UNA pasada del detector: uno solo, como siempre (enqueue_incident_alert); varios, UNA notificación por jefe con todos los nombres y sus horas.';

-- -----------------------------------------------------------------------------
-- El detector (copia de 0146; cambia solo lo marcado «0150»)
-- -----------------------------------------------------------------------------
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
  -- 0146: una llegada sigue «sin carro» hasta una hora después de que baja su
  -- vuelo (está en JMC esperando). reub_baja acepta hasta 8 h de atraso, así que
  -- una llegada programada hace más de 9 h ya no puede estar esperando.
  c_gracia constant interval := interval '60 minutes';
  c_atraso_max constant interval := interval '9 hours';
  v_sin_carro uuid[];
  v_nuevas integer := 0;
  r        record;
  v_id     uuid;
  v_nuevos uuid[] := '{}';   -- 0150: las que se abren en esta pasada (aviso agrupado)
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
      -- 0146: la salida, hasta su hora (como antes); la llegada, hasta 60 min
      -- después de que baja su vuelo, mientras no esté en un carro ni entregada.
      AND res.required_arrival_at > now() - c_atraso_max
      AND CASE WHEN res.direction = 'airport_to_home'
               THEN coalesce(res.status_a2h::text, '') NOT IN ('picked_up', 'en_route_home', 'delivered', 'cancelled')
                    AND public.hora_que_importa(res.id) + c_gracia > now()
               ELSE res.required_arrival_at > now() END
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
          -- 0143: la madrugada (antes del corte) cuenta también para el día anterior.
          AND public.dia_del_plan((to_jsonb(ra) ->> 'manual_day')::date, ra.planned_start_at)
              IN ((res.required_arrival_at AT TIME ZONE 'America/Bogota')::date, public.dia_madrugada(res.required_arrival_at))));

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
    SELECT z.*, EXTRACT(EPOCH FROM (z.hora - now())) / 3600 AS horas,
           -- 0146: el vuelo viene atrasado según Flightradar24
           (z.direction = 'airport_to_home' AND z.hora > z.required_arrival_at) AS atrasado
    FROM (
      SELECT res.id, res.required_arrival_at, res.pickup_address, res.direction, res.flight_code,
             pr.full_name AS pax, pr.organization_id,
             public.hora_que_importa(res.id) AS hora   -- 0146 (en una salida = required_arrival_at)
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
          WHERE i.dedupe_key = 'late:' || res.id::text AND i.resolved_at IS NULL)) z
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
        CASE
          -- 0146: el vuelo viene atrasado (y, si su hora todavía no llega, cuánto falta)
          WHEN r.atrasado
            THEN ' (su vuelo ' || coalesce(r.flight_code || ' ', '') || 'viene atrasado: '
                 || public.hm_bog(r.hora) || ' en vez de ' || public.hm_bog(r.required_arrival_at)
                 || CASE WHEN r.horas > 0 AND r.horas < 6
                         THEN '; faltan ' || round(r.horas::numeric, 1) || ' h' ELSE '' END || ').'
          -- 0146: una llegada cuya hora ya pasó (antes decía «faltan -0.3 h»)
          WHEN r.horas <= 0
            THEN ' (su llegada era a las ' || public.hm_bog(r.required_arrival_at) || ' y sigue sin carro).'
          WHEN r.horas < 6
            THEN ' (faltan ' || round(r.horas::numeric, 1) || ' h).'
          ELSE '.' END,
      'operacion', 'system',
      jsonb_build_object(
        'horas_para_el_servicio', round(r.horas::numeric, 1),
        'direccion', r.pickup_address,
        'sentido', r.direction,
        -- 0146: la hora con la que se decidió (la del vuelo, si viene atrasado)
        'hora_que_importa', r.hora,
        'vuelo_atrasado', r.atrasado),
      'late:' || r.id::text, now())
    RETURNING id INTO v_id;

    -- 0150: el aviso sale al final, junto con las demás de esta pasada.
    v_nuevos := v_nuevos || v_id;
    v_nuevas := v_nuevas + 1;
  END LOOP;
  -- 0150: una sola notificación por jefe con todos los de esta pasada (antes, una
  -- por persona: 6 seguidos × 3 jefes = 18 el 26-oct a las 10:25 p. m.).
  IF array_length(v_nuevos, 1) > 0 THEN
    PERFORM public.late_bookings_alert(v_nuevos);
  END IF;

  -- (d) CIERRA sola: ya la acomodaron, la cancelaron, o el servicio ya pasó.
  -- 0146: en una llegada «ya pasó» = 60 min después de que bajó su vuelo, o ya
  -- está en un carro o entregada.
  UPDATE public.incidents i
     SET status = 'resolved',
         resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes,
           CASE
             WHEN res.cancelled_at IS NOT NULL THEN 'Se cerró sola: la reserva fue cancelada.'
             WHEN EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
               THEN 'Se cerró sola: la reserva ya quedó en una ruta.'
             WHEN res.direction = 'airport_to_home'
                  AND coalesce(res.status_a2h::text, '') IN ('picked_up', 'en_route_home', 'delivered')
               THEN 'Se cerró sola: el traslado ya figura como recogido o entregado.'
             WHEN res.direction = 'airport_to_home'
               THEN 'Se cerró sola: pasó una hora desde su llegada ('
                    || public.hm_bog(public.hora_que_importa(res.id)) || ').'
             ELSE 'Se cerró sola: la hora del servicio ya pasó.'
           END)
    FROM public.reservations res
   WHERE res.id = i.reservation_id
     AND i.category = 'late_booking'
     AND i.resolved_at IS NULL
     AND (
       res.cancelled_at IS NOT NULL
       OR (res.direction <> 'airport_to_home' AND res.required_arrival_at <= now())
       OR (res.direction = 'airport_to_home'
           AND (coalesce(res.status_a2h::text, '') IN ('picked_up', 'en_route_home', 'delivered', 'cancelled')
                OR public.hora_que_importa(res.id) + c_gracia <= now()))
       OR EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
     );

  RETURN v_nuevas;
END;
$$;

COMMIT;
