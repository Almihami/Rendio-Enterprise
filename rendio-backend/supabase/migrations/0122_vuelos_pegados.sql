-- =============================================================================
-- 0122 · Vuelos pegados — seguir con Flightradar24 los vuelos del plan del jefe
-- =============================================================================
-- POR QUÉ: 0118 solo sigue los vuelos de las RESERVAS de la app. La operación
-- todavía arma la ruta por el Form/WhatsApp («18:35 Paula londoño (JA5987)»), y
-- el 25-oct-2026 no había ni una reserva en producción: FR24 no seguía ninguno de
-- los 7 vuelos de esa noche. Pedido de la profa (25-oct): una pantalla Vuelos en
-- el admin donde se pega el plan, se ven las llegadas del día y un mapa con dónde
-- viene cada avión (estimado).
--
-- QUÉ HACE
--   1. public.flight_watches: un vuelo que se sigue SIN reserva. Una fila por
--      organización + código + día de Bogotá de la hora prevista. sched_at = la
--      hora del plan (en una llegada del jefe es la hora de ATERRIZAJE:
--      scripts/planes-jefe/FORMATO.md); label = quiénes vienen, tal como lo
--      escribió el jefe («Duvan y Margy»). La escriben y la leen SOLO los jefes de
--      la organización (RLS). El disparador normaliza el código y saca el día.
--   2. flight_status_targets() (0118) suma los vuelos pegados a los de las
--      reservas: mismo calendario, misma ventana (desde 2 h antes de la hora
--      prevista), una sola consulta si el vuelo está en los dos lados (gana la
--      hora más temprana).
--   3. flight_delay_alerts() (0107) también avisa de un vuelo pegado: a los jefes
--      (no hay conductor: el plan no está publicado en la app). El enlace del aviso
--      del jefe abre la pantalla Vuelos (#/vuelos). Lo demás, igual.
--   4. purge_flight_statuses() (0118) también borra los vuelos pegados de más de
--      28 días: llevan nombres de personas y no sirven para nada después.
--
-- Idempotente. Necesita 0099, 0107 y 0118. Down: down_migrations/0122_vuelos_pegados.down.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. flight_watches
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flight_watches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flight_code     text        NOT NULL,
  flight_date     date        NOT NULL,   -- día de Bogotá de sched_at (lo pone el disparador)
  sched_at        timestamptz NOT NULL,   -- hora prevista de aterrizaje (la del plan)
  label           text,                   -- quiénes vienen, como lo escribió el jefe
  source          text        NOT NULL DEFAULT 'pegado',
  created_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flight_watches_key UNIQUE (organization_id, flight_code, flight_date),
  CONSTRAINT flight_watches_code_format CHECK (flight_code ~ '^[A-Z0-9]{2,8}$'),
  CONSTRAINT flight_watches_source_valid CHECK (source IN ('pegado', 'manual')),
  CONSTRAINT flight_watches_label_len CHECK (label IS NULL OR length(label) <= 200)
);

COMMENT ON TABLE public.flight_watches IS
  'Vuelos que se siguen con Flightradar24 sin una reserva en la app (0122): los pega un jefe desde el plan de WhatsApp en la pantalla Vuelos. sched_at = hora prevista de aterrizaje. Solo los jefes de la organización la leen y escriben. Se purgan a los 28 días (llevan nombres).';

CREATE INDEX IF NOT EXISTS idx_flight_watches_day ON public.flight_watches(flight_date);

CREATE OR REPLACE FUNCTION public.tg_flight_watches_fill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.flight_code := public.flight_code_normalize(NEW.flight_code);
  NEW.flight_date := (NEW.sched_at AT TIME ZONE 'America/Bogota')::date;
  IF NEW.organization_id IS NULL THEN NEW.organization_id := public.current_user_org(); END IF;
  IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  NEW.label := nullif(btrim(coalesce(NEW.label, '')), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_flight_watches_fill ON public.flight_watches;
CREATE TRIGGER tr_flight_watches_fill
  BEFORE INSERT OR UPDATE ON public.flight_watches
  FOR EACH ROW EXECUTE FUNCTION public.tg_flight_watches_fill();

DROP TRIGGER IF EXISTS tr_flight_watches_set_updated_at ON public.flight_watches;
CREATE TRIGGER tr_flight_watches_set_updated_at
  BEFORE UPDATE ON public.flight_watches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flight_watches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_flight_watches_admin ON public.flight_watches;
CREATE POLICY p_flight_watches_admin
  ON public.flight_watches FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

REVOKE ALL ON public.flight_watches FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flight_watches TO authenticated;
GRANT ALL ON public.flight_watches TO service_role;

-- -----------------------------------------------------------------------------
-- 2. flight_status_targets: reservas + vuelos pegados (el calendario de 0118)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_status_targets(
  p_now   timestamptz DEFAULT now(),
  p_limit integer     DEFAULT 45
)
RETURNS TABLE (
  organization_id uuid,
  flight_code     text,
  flight_date     date,
  direction       public.trip_direction,
  ref_at          timestamptz,
  reservations    integer,       -- reservas de la app en ese vuelo (los pegados no cuentan)
  last_fetched_at timestamptz,
  last_status     text,
  mode            text,
  provider_ref    text,
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
  src AS (
    SELECT pa.organization_id, r.flight_code,
           (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date AS dia,
           r.required_arrival_at AS t, 1 AS es_reserva
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pa          ON pa.id = ap.profile_id
      CROSS JOIN cfg
     WHERE cfg.enabled
       AND r.direction = 'airport_to_home'
       AND r.cancelled_at IS NULL
       AND coalesce(r.ground_ops, false) = false
       AND coalesce(r.status_a2h::text, '') NOT IN
           ('landed', 'disembarking', 'picked_up', 'en_route_home', 'delivered', 'cancelled')
       AND r.flight_code ~ '^[A-Z]{1,3}[0-9]{2,5}$'
       AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN cfg.hoy - 1 AND cfg.hoy + 1
       AND r.required_arrival_at <= p_now + interval '120 minutes'
       AND r.required_arrival_at >= p_now - interval '6 hours'
    UNION ALL
    -- Los pegados del plan del jefe (0122): misma ventana.
    SELECT w.organization_id, w.flight_code, w.flight_date, w.sched_at, 0
      FROM public.flight_watches w
      CROSS JOIN cfg
     WHERE cfg.enabled
       AND w.flight_code ~ '^[A-Z]{1,3}[0-9]{2,5}$'
       AND w.flight_date BETWEEN cfg.hoy - 1 AND cfg.hoy + 1
       AND w.sched_at <= p_now + interval '120 minutes'
       AND w.sched_at >= p_now - interval '6 hours'
  ),
  grp AS (
    SELECT src.organization_id, src.flight_code, src.dia,
           min(src.t) AS ref_at, sum(src.es_reserva)::integer AS n
      FROM src
     GROUP BY src.organization_id, src.flight_code, src.dia
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
           (st.departed_at IS NULL AND st.ref_at >= p_now - interval '180 minutes')
        OR (st.departed_at IS NOT NULL AND coalesce(st.estimated_at, st.ref_at) >= p_now - interval '120 minutes')
         )
     AND (st.fetched_at IS NULL OR st.fetched_at <= p_now - CASE
           WHEN st.departed_at IS NULL AND st.ref_at >= p_now - interval '60 minutes' THEN interval '12 minutes'
           WHEN st.departed_at IS NULL THEN interval '27 minutes'
           WHEN st.mode = 'summary' THEN interval '12 minutes'
           WHEN st.estimated_at IS NULL THEN interval '12 minutes'
           WHEN st.estimated_at <= p_now + interval '60 minutes' THEN interval '12 minutes'
           ELSE interval '57 minutes' END)
   ORDER BY coalesce(st.estimated_at, st.ref_at), st.flight_code
   LIMIT greatest(coalesce(p_limit, 45), 0);
$$;

COMMENT ON FUNCTION public.flight_status_targets(timestamptz, integer) IS
  'Llegadas a consultar en Flightradar24 (0118 + 0122): reservas activas con sigla y vuelos pegados del plan del jefe (flight_watches), desde 2 h antes de su hora de aterrizaje, agrupados por organización+código+día. mode summary (antes del despegue y cuando la ETA ya llegó) o live (en el aire); cada 15 min, o cada hora si la ETA está a más de 60 min; se rinde 3 h después si nunca despegó. Vacío si flight_api_enabled = false.';

-- -----------------------------------------------------------------------------
-- 3. flight_delay_alerts: la de 0107 + los vuelos pegados (solo a los jefes)
-- -----------------------------------------------------------------------------
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
       AND coalesce(fs.actual_at, fs.estimated_at, fs.sched_at, p_now) >= p_now - interval '3 hours'
     FOR UPDATE
  LOOP
    -- ¿Alguien viene en ese vuelo todavía? Una reserva activa o un vuelo pegado
    -- del plan del jefe (0122). Sin ninguno de los dos no hay a quién avisar.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.reservations r
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        JOIN public.profiles pa ON pa.id = ap.profile_id
       WHERE pa.organization_id = f.organization_id
         AND r.flight_code = f.flight_code
         AND r.direction = 'airport_to_home'
         AND r.cancelled_at IS NULL
         AND coalesce(r.status_a2h::text, '') NOT IN ('delivered', 'cancelled')
         AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = f.flight_date)
      AND NOT EXISTS (
      SELECT 1 FROM public.flight_watches w
       WHERE w.organization_id = f.organization_id
         AND w.flight_code = f.flight_code
         AND w.flight_date = f.flight_date);

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

    -- Jefes de ESA organización (regla de 0066 aplicada dentro de la organización)
    -- → la pantalla Vuelos; conductor de cada ruta publicada donde va alguien de
    -- ese vuelo → su ruta. Un vuelo solo pegado no tiene conductor.
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    SELECT d.pid, v_title, v_body, d.url,
           'flt:' || f.id::text || ':' || v_kind || ':' || d.pid::text
      FROM (
        SELECT adm.id AS pid, '/#/vuelos' AS url
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

COMMENT ON FUNCTION public.flight_delay_alerts(timestamptz) IS
  'Encola en notification_outbox el aviso de una LLEGADA cuya hora se movió ≥ 15 min respecto a lo último avisado (o que se desvió): a los jefes de la organización que reciben alertas de operación (enlace a Vuelos) y al conductor de la ruta publicada. Cuenta las reservas activas y los vuelos pegados del plan (0122). No toca required_arrival_at.';

-- -----------------------------------------------------------------------------
-- 4. La purga de 0118 + los vuelos pegados
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_flight_statuses(p_keep_days integer DEFAULT 28)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_keep_days, 28), 1), 30);
  v_cut  timestamptz;
  v_fs   integer;
  v_ob   integer;
  v_w    integer;
BEGIN
  v_cut := now() - make_interval(days => v_days);
  DELETE FROM public.flight_statuses
   WHERE created_at < v_cut
      OR fetched_at < v_cut
      OR flight_date < (now() AT TIME ZONE 'America/Bogota')::date - v_days;
  GET DIAGNOSTICS v_fs = ROW_COUNT;
  DELETE FROM public.notification_outbox
   WHERE dedupe_key LIKE 'flt:%' AND created_at < v_cut;
  GET DIAGNOSTICS v_ob = ROW_COUNT;
  DELETE FROM public.flight_watches
   WHERE flight_date < (now() AT TIME ZONE 'America/Bogota')::date - v_days;
  GET DIAGNOSTICS v_w = ROW_COUNT;
  RETURN format('vuelos borrados %s · avisos de vuelo borrados %s · vuelos pegados borrados %s (más de %s días)', v_fs, v_ob, v_w, v_days);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Permisos: las funciones son del servidor
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.tg_flight_watches_fill()',
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
