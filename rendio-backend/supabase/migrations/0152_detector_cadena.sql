-- =============================================================================
-- Migration 0152 — Detector de cadena (en sombra) y «Pasar a X»
--
-- 27-oct-2026, en producción. Enrique salió de JMC a las 11:30 con un conductor
-- que terminaba otra vuelta a las 11:35 (no alcanzaba). Daniel había iniciado su
-- salida hacia JMC a las 10:50, dejó a su gente a las 11:20 y quedó libre ahí,
-- pero Enrique no le salía. El vigilante de 0053 solo mira vueltas YA arrancadas:
-- nadie cruzaba «el conductor de esta vuelta está ocupado hasta las 11:35».
--
-- EN SOMBRA: no mueve a nadie solo. Lo hace un jefe, con un toque.
--   1. detect_route_chains(), cada 5 min: para cada vuelta planeada de los
--      próximos cadena_horizonte_min (90) con conductor, calcula cuándo y dónde
--      queda libre ese conductor (su vuelta anterior: terminada, en curso o
--      planeada, con lo que se haya atrasado; o su GPS reciente) y si alcanza a
--      estar en el primer punto (JMC en una llegada, la primera casa en una
--      salida). Si llega cadena_min_tarde (10) min tarde o más, busca a otro del
--      turno que sí alcance (libre en JMC, llegando con una salida…), al que le
--      quepa la gente y al que no se le cruce lo que sigue (la cuenta de «se
--      cruza», reub_conductor_libre). Guarda la detección (route_chain_alerts) y
--      a los jefes les llega UN aviso con la recomendación: «Recomendado: Daniel»
--      o, si nadie alcanza, «delegarla».
--   2. admin_cadena_ver(aviso): lo que pinta la tarjeta del jefe (recalculado).
--   3. admin_cadena_aplicar(aviso): vuelve a revisar que el recomendado siga
--      alcanzando y publica SOLO esa vuelta con admin_route_set_driver (0147):
--      los avisos al conductor nuevo, al anterior y a los tripulantes son los de
--      siempre. Si ya no aplica, lo dice y no toca nada.
--   4. admin_cadena_descartar(aviso) y admin_cadena_encender(sí/no).
-- Tope: cadena_max_hora avisos por hora por organización; la misma vuelta no se
-- avisa dos veces en 60 min, y nunca más con el mismo conductor si un jefe la
-- descartó. Margen de 5 min para cerrar una detección (no prende y apaga).
-- No cambia ninguna función que ya exista: solo agrega. Necesita 0097
-- (trip_notify, trip_kick), 0117 (ops_alert_recipients_of), 0135 (reub_*),
-- 0144 (conductores_del_turno, turno_de) y 0147 (admin_route_set_driver).
-- Down: down_migrations/0152_detector_cadena.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Ajustes (el interruptor y los números)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS cadena_activa        boolean  NOT NULL DEFAULT true;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS cadena_min_tarde     smallint NOT NULL DEFAULT 10;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS cadena_horizonte_min smallint NOT NULL DEFAULT 90;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS cadena_max_hora      smallint NOT NULL DEFAULT 6;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_cadena_rangos;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_cadena_rangos CHECK (
  cadena_min_tarde BETWEEN 3 AND 60 AND cadena_horizonte_min BETWEEN 30 AND 240 AND cadena_max_hora BETWEEN 1 AND 30);
COMMENT ON COLUMN public.app_settings.cadena_activa IS
  '0152: el detector de cadena revisa y avisa (true) o no hace nada (false). Lo apaga un jefe desde la tarjeta del aviso.';
COMMENT ON COLUMN public.app_settings.cadena_min_tarde IS
  '0152: desde cuántos minutos tarde el conductor de una vuelta «no alcanza».';

-- -----------------------------------------------------------------------------
-- 2. Las detecciones (una abierta por vuelta)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_chain_alerts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_assignment_id  uuid        NOT NULL REFERENCES public.route_assignments(id) ON DELETE CASCADE,
  driver_profile_id    uuid        REFERENCES public.driver_profiles(id) ON DELETE SET NULL,   -- el que la tiene
  need_at              timestamptz NOT NULL,    -- a qué hora debe estar en el primer punto
  eta_at               timestamptz NOT NULL,    -- a qué hora llegaría el que la tiene
  late_min             int         NOT NULL,
  why                  text,                    -- «termina ~11:35 la vuelta de las 10:40»
  suggested_driver_id  uuid        REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  suggested_eta_at     timestamptz,
  suggested_why        text,                    -- «termina ~11:20 la vuelta de las 10:50»
  kind                 text        NOT NULL,
  notified_at          timestamptz,
  resolved_at          timestamptz,
  resolution           text,
  resolved_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_chain_alerts_kind_valid CHECK (kind IN ('reasignar', 'delegar')),
  CONSTRAINT route_chain_alerts_resolution_valid
    CHECK (resolution IS NULL OR resolution IN ('aplicado', 'descartado', 'cambio', 'ya_alcanza', 'arranco', 'vencida'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_chain_alerts_abierta ON public.route_chain_alerts(route_assignment_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_chain_alerts_org_notified ON public.route_chain_alerts(organization_id, notified_at DESC);
DROP TRIGGER IF EXISTS tr_route_chain_alerts_set_updated_at ON public.route_chain_alerts;
CREATE TRIGGER tr_route_chain_alerts_set_updated_at BEFORE UPDATE ON public.route_chain_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.route_chain_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_chain_alerts_admin_read ON public.route_chain_alerts;
CREATE POLICY route_chain_alerts_admin_read ON public.route_chain_alerts FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
COMMENT ON TABLE public.route_chain_alerts IS
  '0152: detecciones del detector de cadena: una vuelta planeada cuyo conductor no alcanza y a quién se recomienda pasarla. Solo la escribe la base.';

-- -----------------------------------------------------------------------------
-- 3. ¿Cuándo y dónde queda libre un conductor antes de una hora?
--    known = se sabe; fresh = el dato es de ahora (no una vuelta de hace horas).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadena_libre(p_drv uuid, p_skip uuid, p_antes timestamptz,
  OUT known boolean, OUT fresh boolean, OUT free_at timestamptz, OUT res uuid,
  OUT lat double precision, OUT lng double precision, OUT air boolean, OUT why text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o record; e record; g record;
  v_turn int; v_fin timestamptz; v_atraso interval;
  v_ap_lat double precision; v_ap_lng double precision;
BEGIN
  known := false; fresh := false;
  IF p_drv IS NULL THEN RETURN; END IF;
  SELECT route_turnaround_min INTO v_turn FROM public.app_settings WHERE id = 'singleton';
  v_turn := coalesce(v_turn, 8);

  -- Su vuelta inmediatamente anterior (la última que empieza antes de esa hora).
  SELECT ra.id, ra.status, ra.actual_start_at, ra.actual_end_at INTO o
    FROM public.route_assignments ra
   WHERE ra.driver_profile_id = p_drv AND ra.id IS DISTINCT FROM p_skip
     AND ra.status IN ('planned', 'in_progress', 'completed')
     AND ra.planned_start_at < p_antes AND ra.planned_start_at > p_antes - interval '12 hours'
     AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)
   ORDER BY ra.planned_start_at DESC LIMIT 1;
  IF o.id IS NOT NULL THEN
    SELECT * INTO e FROM public.reub_extremos(o.id);
    IF e.fin_at IS NOT NULL THEN
      IF o.status = 'completed' THEN
        v_fin := coalesce(o.actual_end_at, least(e.fin_at, now()));
        why := 'terminó a las ' || public.hm_bog(v_fin);
      ELSIF o.status = 'in_progress' THEN
        -- Lo que arrancó tarde, termina tarde; y si ya debía haber terminado, le faltan ~5 min.
        v_atraso := greatest(interval '0', coalesce(o.actual_start_at, now()) - e.ini_at);
        v_fin := greatest(e.fin_at + v_atraso, now() + interval '5 minutes');
        why := 'termina ~' || public.hm_bog(v_fin) || ' la vuelta de las ' || public.hm_bog(e.ini_at);
      ELSE
        -- Planeada: si ya debía haber arrancado y no lo ha hecho, todo se corre.
        v_atraso := greatest(interval '0', now() - e.ini_at);
        v_fin := e.fin_at + v_atraso;
        why := 'termina ~' || public.hm_bog(v_fin) || ' la vuelta de las ' || public.hm_bog(e.ini_at)
               || CASE WHEN v_atraso > interval '0' THEN ' (no ha arrancado)' ELSE '' END;
      END IF;
      known := true;
      free_at := v_fin + make_interval(mins => CASE WHEN e.fin_air THEN v_turn ELSE 2 END);
      res := e.fin_res; lat := e.fin_lat; lng := e.fin_lng; air := e.fin_air;
      fresh := o.status <> 'completed' OR v_fin > now() - interval '60 minutes';
    END IF;
  END IF;

  -- El GPS de los últimos 15 min manda sobre una vuelta ya terminada (se pudo mover).
  IF NOT known OR (o.status = 'completed' AND free_at <= now()) THEN
    SELECT dl.latitude, dl.longitude, dl.recorded_at INTO g FROM public.driver_locations dl
     WHERE dl.driver_profile_id = p_drv AND dl.recorded_at > now() - interval '15 minutes'
     ORDER BY dl.recorded_at DESC LIMIT 1;
    IF g.recorded_at IS NOT NULL THEN
      SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng
        FROM public.airports a JOIN public.profiles pr ON pr.organization_id = a.organization_id
        JOIN public.driver_profiles dp ON dp.profile_id = pr.id
       WHERE dp.id = p_drv ORDER BY a.created_at LIMIT 1;
      v_ap_lat := coalesce(v_ap_lat, 6.1715); v_ap_lng := coalesce(v_ap_lng, -75.4270);
      known := true; fresh := true; free_at := now(); res := NULL; lat := g.latitude; lng := g.longitude;
      air := abs(g.latitude - v_ap_lat) < 0.012 AND abs(g.longitude - v_ap_lng) < 0.012;   -- ~1,3 km
      why := CASE WHEN air THEN 'está libre en JMC' ELSE 'está libre' END || ' (GPS de las ' || public.hm_bog(g.recorded_at) || ')';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.cadena_libre(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. ¿Este conductor alcanza a hacer esta vuelta? (cupo, hora y lo que sigue)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadena_candidato(p_ra uuid, p_dp uuid,
  OUT ok boolean, OUT eta timestamptz, OUT free_at timestamptz, OUT why text, OUT motivo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE e record; l record; v_pax int; v_cap int; v_def int;
BEGIN
  ok := false;
  SELECT * INTO e FROM public.reub_extremos(p_ra);
  IF e.ini_at IS NULL THEN motivo := 'la vuelta no tiene a quién recoger'; RETURN; END IF;
  SELECT * INTO l FROM public.cadena_libre(p_dp, p_ra, e.ini_at);
  IF NOT coalesce(l.known, false) OR NOT coalesce(l.fresh, false) THEN motivo := 'no se sabe dónde está'; RETURN; END IF;
  eta := greatest(l.free_at, now())
         + make_interval(mins => ceil(public.reub_leg(l.res, l.lat, l.lng, l.air, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air))::int);
  free_at := l.free_at; why := l.why;
  IF eta > e.ini_at + interval '4 minutes' THEN motivo := l.why || ' y llegaría ' || public.hm_bog(eta); RETURN; END IF;
  IF NOT public.reub_conductor_libre(p_dp, p_ra, NULL, e.ini_at, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                                      e.fin_at, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air) THEN
    motivo := 'se le cruza con otra vuelta suya'; RETURN;
  END IF;
  SELECT count(*) INTO v_pax FROM public.route_stops rs LEFT JOIN public.reservations r ON r.id = rs.reservation_id
   WHERE rs.route_assignment_id = p_ra AND (rs.reservation_id IS NULL OR r.cancelled_at IS NULL);
  SELECT v.capacity INTO v_cap FROM public.shifts sh JOIN public.vehicles v ON v.id = sh.vehicle_id
   WHERE sh.driver_id = p_dp AND sh.status::text <> 'closed' AND sh.start_at > now() - interval '16 hours'
   ORDER BY sh.start_at DESC LIMIT 1;
  SELECT route_default_capacity INTO v_def FROM public.app_settings WHERE id = 'singleton';
  IF v_pax > coalesce(v_cap, v_def, 4) THEN motivo := 'no le caben (' || v_pax || ' personas)'; RETURN; END IF;
  ok := true;
END;
$$;
REVOKE ALL ON FUNCTION public.cadena_candidato(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. La evaluación de una vuelta: ¿su conductor alcanza? ¿quién sí?
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadena_evaluar(p_ra uuid, p_candidatos boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments; v_org uuid; e record; l record; c record; k record;
  v_eta timestamptz; v_late int; v_quien text; v_n int; v_actual text;
  b_dp uuid; b_name text; b_eta timestamptz; b_free timestamptz; b_why text;
BEGIN
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_ra;
  IF ra.id IS NULL OR ra.driver_profile_id IS NULL THEN RETURN NULL; END IF;
  SELECT pr.organization_id, pr.full_name INTO v_org, v_actual
    FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = ra.driver_profile_id;
  v_org := coalesce(ra.organization_id, v_org);
  SELECT * INTO e FROM public.reub_extremos(ra.id);
  IF e.ini_at IS NULL THEN RETURN NULL; END IF;

  SELECT count(*), string_agg(nm, ', ' ORDER BY o) INTO v_n, v_quien FROM (
    SELECT rs.stop_order o, public.short_name(coalesce(pr.full_name, rs.guest_name)) nm
      FROM public.route_stops rs LEFT JOIN public.reservations r ON r.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = ra.id AND (rs.reservation_id IS NULL OR r.cancelled_at IS NULL)) z;

  SELECT * INTO l FROM public.cadena_libre(ra.driver_profile_id, ra.id, e.ini_at);
  IF NOT coalesce(l.known, false) THEN
    RETURN jsonb_build_object('known', false, 'need_at', e.ini_at, 'org', v_org);
  END IF;
  v_eta := greatest(l.free_at, now())
           + make_interval(mins => ceil(public.reub_leg(l.res, l.lat, l.lng, l.air, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air))::int);
  v_late := ceil(extract(epoch FROM (v_eta - e.ini_at)) / 60)::int;

  IF p_candidatos THEN
    FOR c IN
      SELECT dp.id AS dp, pr.full_name FROM public.conductores_del_turno(v_org, e.ini_at) t
        JOIN public.driver_profiles dp ON dp.profile_id = t.profile_id JOIN public.profiles pr ON pr.id = dp.profile_id
       WHERE dp.id <> ra.driver_profile_id
    LOOP
      SELECT * INTO k FROM public.cadena_candidato(ra.id, c.dp);
      CONTINUE WHEN NOT coalesce(k.ok, false);
      -- El que llega antes; si llegan casi igual, el que lleva más rato libre.
      IF b_dp IS NULL OR k.eta < b_eta - interval '2 minutes'
         OR (k.eta <= b_eta + interval '2 minutes' AND k.free_at < b_free) THEN
        b_dp := c.dp; b_name := c.full_name; b_eta := k.eta; b_free := k.free_at; b_why := k.why;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'known', true, 'org', v_org, 'route', ra.id,
    'tipo', CASE WHEN ra.direction = 'airport_to_home' THEN 'Llegada' ELSE 'Salida' END,
    'quien', v_quien, 'pax', v_n, 'dia', (public.turno_de(e.ini_at)).dia,
    'need_at', e.ini_at, 'eta_at', v_eta, 'late_min', v_late, 'why', l.why,
    'driver', ra.driver_profile_id, 'driver_name', v_actual,
    'best', CASE WHEN b_dp IS NULL THEN NULL ELSE jsonb_build_object('dp', b_dp, 'name', b_name, 'eta', b_eta, 'why', b_why) END);
END;
$$;
REVOKE ALL ON FUNCTION public.cadena_evaluar(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. El detector (cada 5 min)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_route_chains()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s record; v record; j jsonb; a public.route_chain_alerts;
  v_n int := 0; v_late int; v_title text; v_body text; v_best text;
BEGIN
  SELECT coalesce(cadena_activa, true) AS on_, coalesce(cadena_min_tarde, 10) AS min_,
         coalesce(cadena_horizonte_min, 90) AS hor, coalesce(cadena_max_hora, 6) AS tope
    INTO s FROM public.app_settings WHERE id = 'singleton';
  IF NOT coalesce(s.on_, true) THEN RETURN 0; END IF;

  -- 1. Cerrar las que ya no aplican: arrancó, le cambiaron el conductor, se delegó o pasó la hora.
  UPDATE public.route_chain_alerts ch
     SET resolved_at = now(),
         resolution = CASE
           WHEN ra.status IN ('in_progress', 'completed')
             OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN 'arranco'
           WHEN ra.status = 'planned' AND (ra.driver_profile_id IS DISTINCT FROM ch.driver_profile_id OR ra.delegated_at IS NOT NULL) THEN 'cambio'
           ELSE 'vencida' END
    FROM public.route_assignments ra
   WHERE ch.resolved_at IS NULL AND ra.id = ch.route_assignment_id
     AND (ra.status <> 'planned' OR ra.driver_profile_id IS DISTINCT FROM ch.driver_profile_id OR ra.delegated_at IS NOT NULL
          OR ch.need_at < now() - interval '20 minutes'
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  -- 2. Las vueltas que vienen.
  FOR v IN
    SELECT ra.id, ra.driver_profile_id
      FROM public.route_assignments ra
     WHERE ra.status = 'planned' AND ra.driver_profile_id IS NOT NULL AND ra.delegated_at IS NULL
       AND ra.planned_start_at BETWEEN now() - interval '30 minutes' AND now() + make_interval(mins => s.hor)
       AND EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id)
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.route_chain_alerts d WHERE d.route_assignment_id = ra.id
                        AND d.resolution = 'descartado' AND d.driver_profile_id = ra.driver_profile_id)
     ORDER BY ra.planned_start_at
  LOOP
    j := public.cadena_evaluar(v.id, false);
    CONTINUE WHEN j IS NULL OR NOT coalesce((j->>'known')::boolean, false) OR j->>'org' IS NULL;
    v_late := (j->>'late_min')::int;
    SELECT * INTO a FROM public.route_chain_alerts WHERE route_assignment_id = v.id AND resolved_at IS NULL;
    IF v_late < s.min_ THEN
      IF a.id IS NOT NULL AND v_late <= s.min_ - 5 THEN
        UPDATE public.route_chain_alerts SET resolved_at = now(), resolution = 'ya_alcanza' WHERE id = a.id;
      END IF;
      CONTINUE;
    END IF;
    CONTINUE WHEN (j->>'need_at')::timestamptz < now() - interval '10 minutes';
    j := public.cadena_evaluar(v.id, true);   -- ahora sí, con a quién pasársela
    CONTINUE WHEN j IS NULL;

    IF a.id IS NULL THEN
      INSERT INTO public.route_chain_alerts (organization_id, route_assignment_id, driver_profile_id, need_at, eta_at, late_min, why,
                                             suggested_driver_id, suggested_eta_at, suggested_why, kind)
      VALUES ((j->>'org')::uuid, v.id, v.driver_profile_id, (j->>'need_at')::timestamptz, (j->>'eta_at')::timestamptz,
              (j->>'late_min')::int, j->>'why',
              (j#>>'{best,dp}')::uuid, (j#>>'{best,eta}')::timestamptz, j#>>'{best,why}',
              CASE WHEN j#>>'{best,dp}' IS NULL THEN 'delegar' ELSE 'reasignar' END)
      RETURNING * INTO a;
    ELSE
      UPDATE public.route_chain_alerts
         SET eta_at = (j->>'eta_at')::timestamptz, late_min = (j->>'late_min')::int, why = j->>'why',
             suggested_driver_id = (j#>>'{best,dp}')::uuid, suggested_eta_at = (j#>>'{best,eta}')::timestamptz,
             suggested_why = j#>>'{best,why}', kind = CASE WHEN j#>>'{best,dp}' IS NULL THEN 'delegar' ELSE 'reasignar' END
       WHERE id = a.id RETURNING * INTO a;
    END IF;

    -- 3. El aviso: una vez por detección, nunca dos de la misma vuelta en 60 min, con tope por hora.
    IF a.notified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.route_chain_alerts x WHERE x.route_assignment_id = v.id AND x.id <> a.id
                        AND x.notified_at > now() - interval '60 minutes')
       AND (SELECT count(*) FROM public.route_chain_alerts x WHERE x.organization_id = a.organization_id
             AND x.notified_at > now() - interval '60 minutes') < s.tope
    THEN
      v_best := public.short_name(j#>>'{best,name}');
      v_title := '⚠️ ' || coalesce(j->>'quien', 'Una vuelta') || ' (' || public.hm_bog(a.need_at) || '): '
                 || coalesce(public.short_name(j->>'driver_name'), 'su conductor') || ' no alcanza';
      v_body := (j->>'tipo') || ' de las ' || public.hm_bog(a.need_at) || '. '
                || coalesce(public.short_name(j->>'driver_name'), 'Su conductor') || ' ' || coalesce(a.why, '')
                || ' y llegaría ' || public.hm_bog(a.eta_at) || ' (' || a.late_min || ' min tarde). '
                || CASE WHEN a.kind = 'reasignar'
                        THEN 'Recomendado: ' || v_best || ' (' || coalesce(a.suggested_why, '') || '; llega ' || public.hm_bog(a.suggested_eta_at) || '). Toca para pasársela.'
                        ELSE 'Nadie del turno alcanza. Recomendado: delegarla (Uber o conductor de confianza).' END;
      PERFORM public.trip_notify(r.profile_id, v_title, v_body, '/#/rutas?cadena=' || a.id::text,
                                 'cadena:' || a.id::text || ':' || r.profile_id::text)
         FROM public.ops_alert_recipients_of(a.organization_id) r;
      UPDATE public.route_chain_alerts SET notified_at = now() WHERE id = a.id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.detect_route_chains() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.detect_route_chains()
  IS '0152: detector de cadena EN SOMBRA: vueltas planeadas cuyo conductor no alcanza + a quién pasarlas. Solo avisa a los jefes; no mueve nada. Para pg_cron.';

-- -----------------------------------------------------------------------------
-- 7. Lo que llama la app del jefe
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadena_aviso_del_jefe(p_alert uuid)
RETURNS public.route_chain_alerts
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE a public.route_chain_alerts;
BEGIN
  IF public.current_user_org() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.route_chain_alerts WHERE id = p_alert AND organization_id = public.current_user_org();
  IF a.id IS NULL THEN RAISE EXCEPTION 'Ese aviso no existe' USING ERRCODE = 'P0002'; END IF;
  RETURN a;
END;
$$;
REVOKE ALL ON FUNCTION public.cadena_aviso_del_jefe(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_cadena_ver(p_alert uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.route_chain_alerts; j jsonb; k record; v_sug text; v_on boolean;
  v_ok boolean; v_keta timestamptz; v_kmot text;
BEGIN
  a := public.cadena_aviso_del_jefe(p_alert);
  SELECT coalesce(cadena_activa, true) INTO v_on FROM public.app_settings WHERE id = 'singleton';
  SELECT pr.full_name INTO v_sug FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = a.suggested_driver_id;
  -- Recalculado al abrir: lo que dijo el aviso pudo cambiar.
  j := public.cadena_evaluar(a.route_assignment_id, a.resolved_at IS NULL);
  IF a.resolved_at IS NULL AND a.suggested_driver_id IS NOT NULL THEN
    SELECT * INTO k FROM public.cadena_candidato(a.route_assignment_id, a.suggested_driver_id);
    v_ok := coalesce(k.ok, false); v_keta := k.eta; v_kmot := k.motivo;
  END IF;
  RETURN jsonb_build_object(
    'id', a.id, 'route', a.route_assignment_id, 'kind', a.kind, 'activa', v_on,
    'need_at', a.need_at, 'eta_at', a.eta_at, 'late_min', a.late_min, 'why', a.why,
    'suggested', a.suggested_driver_id, 'suggested_name', v_sug, 'suggested_eta_at', a.suggested_eta_at, 'suggested_why', a.suggested_why,
    'resolved_at', a.resolved_at, 'resolution', a.resolution,
    'ahora', j,
    'sigue', CASE WHEN a.suggested_driver_id IS NULL OR a.resolved_at IS NOT NULL THEN NULL
                  ELSE jsonb_build_object('ok', v_ok, 'eta', v_keta, 'motivo', v_kmot) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cadena_aplicar(p_alert uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE a public.route_chain_alerts; ra public.route_assignments; k record; r jsonb; v_name text; v_pid uuid;
BEGIN
  a := public.cadena_aviso_del_jefe(p_alert);
  SELECT * INTO a FROM public.route_chain_alerts WHERE id = a.id FOR UPDATE;
  IF a.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', CASE a.resolution
      WHEN 'aplicado' THEN 'Ya se la pasaron al recomendado.' WHEN 'cambio' THEN 'Ya le cambiaron el conductor a esa vuelta.'
      WHEN 'arranco' THEN 'Esa vuelta ya arrancó.' WHEN 'ya_alcanza' THEN 'Ya no hace falta: su conductor ahora alcanza.'
      WHEN 'descartado' THEN 'Esa recomendación se descartó.' ELSE 'Esa recomendación ya venció.' END);
  END IF;
  IF a.suggested_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'Nadie del turno alcanza: delégala desde «Ver otras opciones».');
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = a.route_assignment_id;
  IF ra.driver_profile_id IS DISTINCT FROM a.driver_profile_id THEN
    UPDATE public.route_chain_alerts SET resolved_at = now(), resolution = 'cambio' WHERE id = a.id;
    RETURN jsonb_build_object('ok', false, 'motivo', 'Ya le cambiaron el conductor a esa vuelta.');
  END IF;
  -- Entre el aviso y el toque pudo cambiar todo: se vuelve a revisar.
  SELECT * INTO k FROM public.cadena_candidato(a.route_assignment_id, a.suggested_driver_id);
  SELECT pr.full_name, pr.id INTO v_name, v_pid FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = a.suggested_driver_id;
  IF NOT coalesce(k.ok, false) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', coalesce(public.short_name(v_name), 'El recomendado') || ' ya no alcanza: ' || coalesce(k.motivo, 'cambió su vuelta') || '.');
  END IF;
  BEGIN
    r := public.admin_route_set_driver(a.route_assignment_id, a.suggested_driver_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'motivo', SQLERRM);
  END;
  UPDATE public.route_chain_alerts SET resolved_at = now(), resolution = 'aplicado', resolved_by = auth.uid() WHERE id = a.id;
  RETURN coalesce(r, '{}'::jsonb) || jsonb_build_object('ok', true, 'name', v_name, 'profile_id', v_pid, 'route', a.route_assignment_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cadena_descartar(p_alert uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE a public.route_chain_alerts;
BEGIN
  a := public.cadena_aviso_del_jefe(p_alert);
  UPDATE public.route_chain_alerts SET resolved_at = now(), resolution = 'descartado', resolved_by = auth.uid()
   WHERE id = a.id AND resolved_at IS NULL;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cadena_encender(p_on boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_org() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe' USING ERRCODE = '42501';
  END IF;
  UPDATE public.app_settings SET cadena_activa = coalesce(p_on, true) WHERE id = 'singleton';
  RETURN coalesce(p_on, true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cadena_ver(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_cadena_aplicar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_cadena_descartar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_cadena_encender(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cadena_ver(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cadena_aplicar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cadena_descartar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cadena_encender(boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Cada 5 minutos (minuto 2, 7, 12…: no cae junto con los demás vigilantes)
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'detect-route-chains';
  PERFORM cron.schedule('detect-route-chains', '2-59/5 * * * *', $job$SELECT public.detect_route_chains();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): detect_route_chains queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
