-- 0068_reserva_tardia.sql — Bloque D (mitad servidor): la reserva que llegó
-- después de que el plan salió.
--
-- La eventualidad #6 de la profa. Hoy no existe ninguna señal: si alguien llena
-- el formulario a las 11 de la noche para un vuelo de las 5 de la mañana, y el
-- plan del día ya se publicó, esa persona simplemente **no tiene carro** y nadie
-- se entera hasta que llama preguntando por qué no llegó nadie.
--
-- QUÉ CUENTA COMO "TARDÍA" — y por qué NO son las horas de anticipación.
--
-- La app ya tiene `aux_min_lead_hours` (Ajustes, default 6) y la pestaña de
-- Reservas pinta con eso la etiqueta "⏱ Pedido tarde". Eso mide una cosa
-- distinta: si el tripulante avisó con poco tiempo. Es un dato de disciplina, no
-- de operación — una reserva pedida con 3 horas puede caber perfecto si el plan
-- todavía no ha salido, y una pedida con 20 horas puede quedar por fuera si se
-- publicó el plan antes de que llegara.
--
-- Lo que de verdad le importa a la operación es el hecho crudo: **hay plan
-- publicado para ese día y esta reserva no está en él**. Eso es lo que se
-- detecta acá. No es una heurística, es una verdad verificable contra la BD.
--
-- SE CIERRA SOLA en cuanto la reserva entra a una ruta o se cancela — misma
-- regla que 0053 y 0066: una alerta que no se cierra sola deja de creerse.
--
-- LO QUE ESTA MIGRACIÓN **NO** HACE, a propósito: NO pone la etiqueta "necesita
-- un tercer vehículo". Ese cálculo no se puede hacer acá. La base solo sabe
-- estimar distancias con haversine ×1.4 a 30 km/h, mientras el tablero usa
-- OSRM/TomTom con el factor del tramo al aeropuerto y el techo de espera: los
-- dos números discrepan, y la primera vez que el sistema despierte a alguien a
-- las 4am por un traslado que sí cabía, la alerta pierde el crédito y después ya
-- nadie la abre. El aviso de acá dice lo que sabe —"esta reserva no tiene
-- carro"— y el "dónde la acomodo" lo responde el tablero, con el cálculo bueno.

-- ---------------------------------------------------------------------------
-- 1. El detector
-- ---------------------------------------------------------------------------

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
          AND ra.driver_profile_id IS NOT NULL
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

REVOKE ALL    ON FUNCTION public.detect_late_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_late_bookings() TO service_role;

COMMENT ON FUNCTION public.detect_late_bookings()
  IS 'Abre una eventualidad late_booking por cada reserva viva de un día CON PLAN PUBLICADO que no tiene parada en ninguna ruta, y las cierra solas cuando entran a una ruta, se cancelan o ya pasó la hora. No calcula si cabe: eso lo hace el tablero.';

-- ---------------------------------------------------------------------------
-- 2. Que alguien lo llame
--    Se reusa el reloj que ya existe (0066) en vez de crear otro: son la misma
--    barrida de "qué se salió del plan", corre cada 5 min y así los dos
--    detectores comparten la misma ventana. `cron.schedule` con el mismo
--    jobname REEMPLAZA el comando, no duplica el job.
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
  PERFORM cron.schedule('detect-ops-events', '*/5 * * * *',
    $job$SELECT public.detect_ops_events(); SELECT public.detect_late_bookings();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): detect_late_bookings queda creada pero nadie la llama.', SQLERRM;
END
$do$;
