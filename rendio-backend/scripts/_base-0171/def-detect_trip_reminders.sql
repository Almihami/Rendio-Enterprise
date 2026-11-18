CREATE OR REPLACE FUNCTION public.detect_trip_reminders()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rec record;
  c   record;
  v_rem int := 0;
  v_near int := 0;
  v_drv int := 0;
BEGIN
  -- (a) Recordatorio al tripulante 10 min antes de su recogida PUBLICADA.
  --     Salida: aún no arranca la recogida (si ya va «en camino», ese aviso ya
  --     salió). Llegada: aún no está a bordo.
  FOR rec IN
    SELECT r.id, r.direction, r.calculated_pickup_at
      FROM public.reservations r
      JOIN public.route_stops rs       ON rs.reservation_id = r.id
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
     WHERE ra.status IN ('planned', 'in_progress')
       AND r.cancelled_at IS NULL
       AND rs.status = 'pending'
       AND r.calculated_pickup_at IS NOT NULL
       AND r.calculated_pickup_at <= now() + interval '10 minutes'
       AND r.calculated_pickup_at >  now() - interval '2 minutes'
       AND ((r.direction = 'home_to_airport' AND coalesce(r.status_h2a::text, 'requested') IN ('requested', 'assigned', 'ready'))
         OR (r.direction = 'airport_to_home' AND coalesce(r.status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking', 'driver_assigned')))
  LOOP
    SELECT * INTO c FROM public.trip_ctx(rec.id) LIMIT 1;
    IF c.crew_profile IS NULL THEN CONTINUE; END IF;
    IF rec.direction = 'home_to_airport' THEN
      IF public.trip_notify(c.crew_profile, 'Te recogen a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ⏰',
           c.driver_first || coalesce(' (' || c.vehicle_txt || ')', '') || ' te recoge en unos 10 min' ||
           coalesce(' en ' || c.meeting_point, '') || '.' ||
           CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
           c.url, 'trip:' || rec.id || ':remind:' || extract(epoch FROM rec.calculated_pickup_at)::bigint) THEN
        v_rem := v_rem + 1;
      END IF;
    ELSE
      IF public.trip_notify(c.crew_profile, 'Tu conductor sale de JMC a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️',
           'Al salir del avión busca a ' || c.driver_first || coalesce(' (' || c.vehicle_txt || ')', '') ||
           coalesce(' en ' || c.meeting_point, '') || '.' ||
           CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
           c.url, 'trip:' || rec.id || ':remind:' || extract(epoch FROM rec.calculated_pickup_at)::bigint) THEN
        v_rem := v_rem + 1;
      END IF;
    END IF;
  END LOOP;

  -- (b) «Por llegar» con el último GPS del carro (menos de 2 min de viejo).
  FOR rec IN
    SELECT r.id
      FROM public.reservations r
      JOIN public.route_stops rs       ON rs.reservation_id = r.id AND rs.status = 'pending'
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id AND ra.status IN ('planned', 'in_progress')
      JOIN LATERAL (
        SELECT dl.latitude, dl.longitude FROM public.driver_locations dl
         WHERE dl.driver_profile_id = ra.driver_profile_id AND dl.source = 'gps'
           AND dl.recorded_at > now() - interval '2 minutes'
         ORDER BY dl.recorded_at DESC LIMIT 1
      ) pos ON true
     WHERE r.direction = 'home_to_airport'
       AND r.status_h2a = 'en_route'
       AND r.cancelled_at IS NULL
       AND r.pickup_latitude IS NOT NULL
       AND 2 * 6371000 * asin(sqrt(
             power(sin(radians(pos.latitude - r.pickup_latitude) / 2), 2) +
             cos(radians(r.pickup_latitude)) * cos(radians(pos.latitude)) *
             power(sin(radians(pos.longitude - r.pickup_longitude) / 2), 2))) < 400
  LOOP
    IF public.trip_near_notify(rec.id) THEN v_near := v_near + 1; END IF;
  END LOOP;

  -- (c) Al conductor, 20 min antes de una vuelta que nadie ha arrancado.
  FOR rec IN
    SELECT ra.id, ra.planned_start_at, dp.profile_id,
           count(*) AS n,
           string_agg(split_part(btrim(coalesce(cp.full_name, '')), ' ', 1), ', ' ORDER BY rs.stop_order) AS nombres
      FROM public.route_assignments ra
      JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
      JOIN public.route_stops rs       ON rs.route_assignment_id = ra.id
      JOIN public.reservations r       ON r.id = rs.reservation_id AND r.cancelled_at IS NULL
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles cp     ON cp.id = ap.profile_id
     WHERE ra.status = 'planned'
       AND ra.planned_start_at <= now() + interval '20 minutes'
       AND ra.planned_start_at >  now() - interval '5 minutes'
     GROUP BY ra.id, ra.planned_start_at, dp.profile_id
    HAVING bool_and(rs.status = 'pending')
       AND bool_and(coalesce(r.status_h2a::text, 'requested') IN ('requested', 'assigned', 'ready'))
  LOOP
    IF public.trip_notify(rec.profile_id, 'Tu vuelta arranca a las ' || public.trip_hora(rec.planned_start_at),
         rec.n || CASE WHEN rec.n = 1 THEN ' tripulante' ELSE ' tripulantes' END || ': ' || coalesce(nullif(rec.nombres, ''), '—') ||
         '. Abre Rendio y toca «Iniciar ruta».',
         '/', 'drv:' || rec.id || ':start:' || extract(epoch FROM rec.planned_start_at)::bigint) THEN
      v_drv := v_drv + 1;
    END IF;
  END LOOP;

  IF v_rem + v_near + v_drv > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN format('recordatorios %s · por llegar %s · conductores %s', v_rem, v_near, v_drv);
END;
$function$
