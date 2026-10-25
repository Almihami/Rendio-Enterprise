-- =============================================================================
-- 0122 (down) · Vuelos pegados → vuelve a como lo dejaron 0118 y 0107
-- =============================================================================
-- Quita la tabla de vuelos pegados y deja flight_status_targets y
-- purge_flight_statuses como en 0118, y flight_delay_alerts como en 0107 (los
-- avisos del jefe vuelven a abrir Reservas). Los avisos ya encolados de vuelos
-- pegados se quedan en la bandeja (la purga de 0118 los borra a los 28 días).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.flight_status_targets(
  p_now   timestamptz DEFAULT now(),
  p_limit integer     DEFAULT 45
)
RETURNS TABLE (
  organization_id uuid,
  flight_code     text,
  flight_date     date,
  direction       public.trip_direction,
  ref_at          timestamptz,   -- la hora de aterrizaje de la reserva más temprana del grupo
  reservations    integer,
  last_fetched_at timestamptz,
  last_status     text,
  mode            text,          -- 'summary' («¿ya despegó?» / «¿ya aterrizó?») | 'live' (la ETA)
  provider_ref    text,          -- fr24_id si ya se sabe
  departed_at     timestamptz,
  estimated_at    timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cfg AS (
    SELECT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) AS enabled,
           (p_now AT TIME ZONE 'America/Bogota')::date AS hoy
  ),
  res AS (
    SELECT pa.organization_id, r.flight_code, r.required_arrival_at,
           (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date AS dia
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pa          ON pa.id = ap.profile_id
      CROSS JOIN cfg
     WHERE cfg.enabled
       AND r.direction = 'airport_to_home'
       AND r.cancelled_at IS NULL
       AND coalesce(r.ground_ops, false) = false
       -- Ya en tierra con el conductor (o entregado): el vuelo aterrizó.
       AND coalesce(r.status_a2h::text, '') NOT IN
           ('landed', 'disembarking', 'picked_up', 'en_route_home', 'delivered', 'cancelled')
       -- Con sigla: un «5116» pelado no se le puede preguntar a nadie.
       AND r.flight_code ~ '^[A-Z]{1,3}[0-9]{2,5}$'
       AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN cfg.hoy - 1 AND cfg.hoy + 1
       -- Desde 2 h antes de la hora de aterrizaje de la reserva (el supuesto de
       -- arriba) hasta 6 h después.
       AND r.required_arrival_at <= p_now + interval '120 minutes'
       AND r.required_arrival_at >= p_now - interval '6 hours'
  ),
  grp AS (
    SELECT res.organization_id, res.flight_code, res.dia,
           min(res.required_arrival_at) AS ref_at, count(*)::integer AS n
      FROM res
     GROUP BY res.organization_id, res.flight_code, res.dia
  ),
  st AS (
    SELECT g.organization_id, g.flight_code, g.dia, g.ref_at, g.n,
           fs.fetched_at, fs.status, fs.provider_ref, fs.departed_at, fs.estimated_at,
           CASE WHEN fs.departed_at IS NULL THEN 'summary'
                WHEN fs.estimated_at IS NOT NULL AND fs.estimated_at <= p_now + interval '5 minutes' THEN 'summary'
                ELSE 'live' END AS mode
      FROM grp g
      LEFT JOIN public.flight_statuses fs
             ON fs.organization_id = g.organization_id AND fs.flight_code = g.flight_code
            AND fs.flight_date = g.dia AND fs.direction = 'airport_to_home'
  )
  SELECT st.organization_id, st.flight_code, st.dia, 'airport_to_home'::public.trip_direction,
         st.ref_at, st.n, st.fetched_at, st.status,
         st.mode, st.provider_ref, st.departed_at, st.estimated_at
    FROM st
   WHERE coalesce(st.status, '') NOT IN ('landed', 'cancelled', 'diverted')
     AND (
           -- Sin despegar: hasta 3 h después de la hora de la reserva.
           (st.departed_at IS NULL AND st.ref_at >= p_now - interval '180 minutes')
           -- En el aire: hasta 2 h después de la última ETA (más allá se perdió el rastro).
        OR (st.departed_at IS NOT NULL AND coalesce(st.estimated_at, st.ref_at) >= p_now - interval '120 minutes')
         )
     -- El cron corre cada 15 min: «12 min» = en cada vuelta, «27» = una sí y una
     -- no, «57» = una de cada cuatro (el margen absorbe que la corrida tarda).
     AND (st.fetched_at IS NULL OR st.fetched_at <= p_now - CASE
           WHEN st.departed_at IS NULL AND st.ref_at >= p_now - interval '60 minutes' THEN interval '12 minutes'
           WHEN st.departed_at IS NULL THEN interval '27 minutes'
           WHEN st.mode = 'summary' THEN interval '12 minutes'
           -- Recién despegado: la primera ETA en la vuelta siguiente.
           WHEN st.estimated_at IS NULL THEN interval '12 minutes'
           WHEN st.estimated_at <= p_now + interval '60 minutes' THEN interval '12 minutes'
           ELSE interval '57 minutes' END)
   ORDER BY coalesce(st.estimated_at, st.ref_at), st.flight_code
   LIMIT greatest(coalesce(p_limit, 45), 0);
$$;

CREATE OR REPLACE FUNCTION public.purge_flight_statuses(p_keep_days integer DEFAULT 28)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Nunca más de 30 días, aunque alguien pida más.
  v_days integer := least(greatest(coalesce(p_keep_days, 28), 1), 30);
  v_cut  timestamptz;
  v_fs   integer;
  v_ob   integer;
BEGIN
  v_cut := now() - make_interval(days => v_days);
  DELETE FROM public.flight_statuses
   WHERE created_at < v_cut
      OR fetched_at < v_cut
      OR flight_date < (now() AT TIME ZONE 'America/Bogota')::date - v_days;
  GET DIAGNOSTICS v_fs = ROW_COUNT;
  -- Los avisos de vuelo llevan horas de FR24 en el texto.
  DELETE FROM public.notification_outbox
   WHERE dedupe_key LIKE 'flt:%' AND created_at < v_cut;
  GET DIAGNOSTICS v_ob = ROW_COUNT;
  RETURN format('vuelos borrados %s · avisos de vuelo borrados %s (más de %s días)', v_fs, v_ob, v_days);
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
                 || ' fue desviado: no va a aterrizar en JMC a la hora prevista. Confirma con el tripulante.';
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

DROP TABLE IF EXISTS public.flight_watches;
DROP FUNCTION IF EXISTS public.tg_flight_watches_fill();

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_delay_alerts(timestamptz)',
    'public.purge_flight_statuses(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_delay_alerts(timestamptz)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$do$;

COMMIT;
