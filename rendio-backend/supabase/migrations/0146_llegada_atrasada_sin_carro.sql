-- =============================================================================
-- Migration 0146 — Una llegada con el vuelo atrasado no se vuelve invisible
--                  para el «no tiene carro»
--
-- 26-oct-2026, en producción: Manuela (llegada AV269, programada 3:45 p. m.).
-- A las 3:40 el acomodo vio en Flightradar24 que el vuelo bajaba a las 4:14 y la
-- puso en una vuelta nueva «para tomar». El pegado de la ruta de Julián de las
-- 4:20 borró esa vuelta (eso lo arregló 0143) y ella quedó sin carro. Nadie se
-- enteró: detect_late_bookings solo mira reservas con required_arrival_at > now(),
-- y en una llegada esa es la hora PROGRAMADA del vuelo. Pasadas las 3:45 la
-- reserva ya «era historia» para el detector, aunque ella estuviera aterrizando
-- y esperando en JMC; y si la alerta ya estaba abierta, se cerraba sola con «la
-- hora del servicio ya pasó».
--
-- QUÉ CAMBIA (solo en las LLEGADAS; las salidas quedan exactamente igual)
--   1. hora_que_importa(reserva): en una llegada, la hora real del aterrizaje
--      que tengamos de Flightradar24 (reub_baja de 0135: aterrizó, o la estimada
--      con dato en vivo) si es MÁS TARDE que la programada; si no hay dato, o el
--      vuelo viene a tiempo o adelantado, la programada. En una salida, la de
--      siempre (required_arrival_at).
--   2. detect_late_bookings (copia de 0143; cambia solo lo marcado «0146»):
--      · una llegada sigue contando como «sin carro» hasta 60 min después de esa
--        hora (c_gracia), mientras no esté cancelada, en un carro ni entregada.
--        Antes dejaba de contar en la hora programada.
--      · lo mismo para cerrar la alerta sola: una llegada se cierra cuando pasa
--        esa hora + 60 min (o la entregan, la cancelan o entra a una ruta).
--      · el texto del aviso: si el vuelo viene atrasado lo dice («su vuelo AV269
--        viene atrasado: 16:14 en vez de 15:45»), y si su hora ya pasó no dice
--        «faltan -0,3 h» sino «su llegada era a las 15:45 y sigue sin carro».
--   No toca el acomodo: una llegada cuya hora ya pasó sigue sin acomodarse sola
--   (acomodar_eventualidades pide más de 30 min por delante); el aviso es para
--   que un jefe la asigne.
--
-- Necesita 0135 (reub_baja, hm_bog) y 0143. Idempotente.
-- Down: down_migrations/0146_llegada_atrasada_sin_carro.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La hora que importa para «sin carro»
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hora_que_importa(p_res uuid)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- greatest() ignora el NULL: sin dato de Flightradar24 queda la programada.
  SELECT CASE WHEN res.direction = 'airport_to_home'
              THEN greatest(res.required_arrival_at,
                            public.reub_baja(pr.organization_id, res.flight_code, res.required_arrival_at))
              ELSE res.required_arrival_at END
    FROM public.reservations res
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
   WHERE res.id = p_res;
$$;

REVOKE ALL ON FUNCTION public.hora_que_importa(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hora_que_importa(uuid) TO service_role;

COMMENT ON FUNCTION public.hora_que_importa(uuid)
  IS '0146: la hora que cuenta para el «no tiene carro». Llegada: el aterrizaje según Flightradar24 (reub_baja) si es más tarde que el programado; si no, el programado. Salida: required_arrival_at.';

-- -----------------------------------------------------------------------------
-- 2. El detector (copia de 0143; cambia solo lo marcado «0146»)
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

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

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

REVOKE ALL    ON FUNCTION public.detect_late_bookings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_late_bookings() TO service_role;

COMMENT ON FUNCTION public.detect_late_bookings()
  IS 'Abre una eventualidad late_booking por cada reserva viva de un día CON PLAN PUBLICADO que lleva sin parada al menos una pasada del reloj seguida y sin que nadie esté publicando ese día (0127: anotada en late_booking_candidates; no suena mientras el jefe re-publica) (0141: una vuelta armada sola por el sistema no publica el día, y la pegada cuenta para el día de su plan; 0143: la madrugada cuenta también para el día anterior; 0146: una llegada cuenta hasta 60 min después de que baja su vuelo según Flightradar24, no hasta la hora programada), y las cierra solas cuando entran a una ruta, se cancelan o ya pasó la hora. No calcula si cabe: eso lo hace el tablero.';

COMMIT;
