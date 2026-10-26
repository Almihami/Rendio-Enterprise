-- =============================================================================
-- Down 0127 — «X no tiene carro» vuelve a sonar en la primera pasada
-- Devuelve detect_late_bookings EXACTAMENTE a la versión que había antes de 0127
-- (misma huella md5, para que los aplicadores de 0125/0126 la reconozcan):
--   · con route_assignments.delegated_at → la copia de 0126 (pegada + delegada);
--   · con route_assignments.pool         → la copia de 0125 (pegada);
--   · sin ninguna de las dos             → la de 0068.
-- Las tres son iguales salvo la línea del conductor (__CONDUCTOR__ abajo).
-- Quita el disparador de route_stops, su función y late_booking_candidates (las
-- anotaciones no sirven sin 0127).
-- El reloj (detect-ops-events) no se toca: 0127 no lo cambió.
-- No se le devuelve EXECUTE a anon/authenticated: nadie la llama desde la app.
-- Quitar el disparador bloquea route_stops un instante (también las lecturas):
-- correrla cuando nadie esté publicando.
-- OJO: vuelve la tormenta de avisos al re-publicar un día desde Asignación.
-- =============================================================================
BEGIN;

DO $down$
DECLARE
  v_cond text := 'ra.driver_profile_id IS NOT NULL';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = 'delegated_at') THEN
    v_cond := '(ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada';
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = 'pool') THEN
    v_cond := '(ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: también con la ruta pegada';
  END IF;

  EXECUTE replace($cuerpo$CREATE OR REPLACE FUNCTION public.detect_late_bookings()
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
          AND __CONDUCTOR__
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
$$
$cuerpo$, '__CONDUCTOR__', v_cond);
END
$down$;

REVOKE ALL    ON FUNCTION public.detect_late_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_late_bookings() TO service_role;

COMMENT ON FUNCTION public.detect_late_bookings()
  IS 'Abre una eventualidad late_booking por cada reserva viva de un día CON PLAN PUBLICADO que no tiene parada en ninguna ruta, y las cierra solas cuando entran a una ruta, se cancelan o ya pasó la hora. No calcula si cabe: eso lo hace el tablero.';

DROP TRIGGER IF EXISTS tr_route_stops_late_booking_reset ON public.route_stops;
DROP FUNCTION IF EXISTS public.late_booking_candidates_reset();
DROP TABLE IF EXISTS public.late_booking_candidates;

COMMIT;
