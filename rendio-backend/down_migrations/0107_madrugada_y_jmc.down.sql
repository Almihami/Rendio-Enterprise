-- Revierte 0107: vuelve los dos avisos a «MDE» (texto de 0097/0099) y quita
-- app_settings.route_night_cutoff_min. El front degrada: sin la columna, el
-- tablero usa 02:00 como corte (su default en código).

BEGIN;

CREATE OR REPLACE FUNCTION public.detect_trip_reminders()
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      IF public.trip_notify(c.crew_profile, 'Tu conductor sale de MDE a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️',
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
$$;

CREATE OR REPLACE FUNCTION public.flight_delay_alerts(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  f       record;
  v_hoy   date := (p_now AT TIME ZONE 'America/Bogota')::date;
  v_best  timestamptz;
  v_pick  timestamptz;
  v_kind  text;
  v_title text;
  v_body  text;
  v_cuan  text;
  v_n     integer;
  v_total integer := 0;
BEGIN
  IF NOT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) THEN
    RETURN 0;
  END IF;

  FOR f IN
    SELECT fs.*
      FROM public.flight_statuses fs
     WHERE fs.direction = 'airport_to_home'
       AND fs.flight_date BETWEEN v_hoy - 1 AND v_hoy + 1
       AND fs.status <> 'unknown'
       AND (
             (fs.status IN ('cancelled', 'diverted') AND fs.alerted_status IS DISTINCT FROM fs.status)
          OR (fs.status NOT IN ('cancelled', 'diverted') AND fs.delay_min IS NOT NULL
              AND abs(fs.delay_min - coalesce(fs.alerted_delay_min, 0)) >= 15)
           )
       -- Un vuelo que aterrizó hace horas ya no le sirve a nadie.
       AND coalesce(fs.actual_at, fs.estimated_at, fs.sched_at, p_now) >= p_now - interval '3 hours'
     FOR UPDATE
  LOOP
    -- ¿Alguien viene en ese vuelo todavía? Sin reservas activas no hay a quién avisar.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.reservations r
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        JOIN public.profiles pa ON pa.id = ap.profile_id
       WHERE pa.organization_id = f.organization_id
         AND r.flight_code = f.flight_code
         AND r.direction = 'airport_to_home'
         AND r.cancelled_at IS NULL
         AND coalesce(r.status_a2h::text, '') NOT IN ('delivered', 'cancelled')
         AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = f.flight_date);

    v_best := coalesce(f.actual_at, f.estimated_at, f.sched_at);
    IF f.status = 'cancelled' THEN
      v_kind  := 'cancelled';
      v_title := 'Vuelo cancelado';
      v_body  := 'Vuelo ' || f.flight_code
                 || coalesce(' de las ' || to_char(f.sched_at AT TIME ZONE 'America/Bogota', 'HH24:MI'), '')
                 || ' aparece cancelado. Confirma con el tripulante antes de mover el carro.';
    ELSIF f.status = 'diverted' THEN
      v_kind  := 'diverted';
      v_title := 'Vuelo desviado';
      v_body  := 'Vuelo ' || f.flight_code
                 || ' fue desviado: no va a aterrizar en MDE a la hora prevista. Confirma con el tripulante.';
    ELSE
      v_kind := 'delay:' || f.delay_min;
      v_pick := v_best + make_interval(mins => public.flight_deplane_min(f.flight_code));
      v_cuan := CASE WHEN f.delay_min > 0 THEN f.delay_min || ' min tarde'
                     WHEN f.delay_min < 0 THEN (-f.delay_min) || ' min antes'
                     ELSE 'a tiempo' END;
      v_title := CASE WHEN f.delay_min > 0 THEN 'Vuelo retrasado'
                      WHEN f.delay_min < 0 THEN 'Vuelo adelantado'
                      ELSE 'Vuelo a tiempo' END;
      v_body := 'Vuelo ' || f.flight_code
                || CASE WHEN f.status = 'landed' THEN ' aterrizó ' ELSE ' aterriza ' END
                || to_char(v_best AT TIME ZONE 'America/Bogota', 'HH24:MI')
                || ' (' || v_cuan || '). Recogida sugerida '
                || to_char(v_pick AT TIME ZONE 'America/Bogota', 'HH24:MI');
    END IF;

    -- Los jefes de ESA organización que reciben alertas de operación, y el
    -- conductor de cada ruta publicada (planned / in_progress) donde va alguien
    -- de ese vuelo. La regla de los jefes es la de ops_alert_recipients (0066)
    -- —los marcados en Personal; si nadie está marcado, todos los admins
    -- activos— pero aplicada DENTRO de la organización: ops_alert_recipients()
    -- mira los marcados de todas, y filtrarla después por organización dejaría
    -- muda a una organización sin marcados mientras otra sí los tenga.
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    SELECT d.pid, v_title, v_body, d.url,
           'flt:' || f.id::text || ':' || v_kind || ':' || d.pid::text
      FROM (
        SELECT adm.id AS pid, '/#/reservas' AS url
          FROM public.profiles adm
         WHERE adm.organization_id = f.organization_id
           AND adm.role = 'admin' AND adm.deleted_at IS NULL
           AND adm.is_active IS DISTINCT FROM false
           AND (adm.receives_ops_alerts OR NOT EXISTS (
                 SELECT 1 FROM public.profiles m
                  WHERE m.organization_id = f.organization_id
                    AND m.role = 'admin' AND m.deleted_at IS NULL
                    AND m.is_active IS DISTINCT FROM false AND m.receives_ops_alerts))
        UNION
        SELECT dp.profile_id, '/'
          FROM public.reservations r
          JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
          JOIN public.profiles pa          ON pa.id = ap.profile_id
          JOIN public.route_stops rs       ON rs.reservation_id = r.id
          JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
          JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
         WHERE pa.organization_id = f.organization_id
           AND r.flight_code = f.flight_code
           AND r.direction = 'airport_to_home'
           AND r.cancelled_at IS NULL
           AND coalesce(r.status_a2h::text, '') NOT IN ('delivered', 'cancelled')
           AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = f.flight_date
           AND ra.status IN ('planned', 'in_progress')
           AND rs.status <> 'no_show'
      ) d
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;

    UPDATE public.flight_statuses
       SET alerted_delay_min = CASE WHEN f.status IN ('cancelled', 'diverted') THEN alerted_delay_min ELSE f.delay_min END,
           alerted_status    = f.status,
           alerted_at        = p_now
     WHERE id = f.id;
  END LOOP;

  RETURN v_total;
END;
$$;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_route_night_cutoff_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_night_cutoff_min;

COMMIT;
