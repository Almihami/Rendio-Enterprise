-- =============================================================================
-- 0178 · La hora de recogida solo se dice con la ruta del día PUBLICADA
-- =============================================================================
-- 18-nov-2026. Tres audios de esa mañana: a los tripulantes «les cambiaron la hora».
-- Leído en producción: de 34 salidas del miércoles 18, a 23 el sistema les había dicho
-- «Ya tienes carro: te recogemos a las X» la víspera, ANTES de que existiera la lista
-- del jefe; a 21 la lista se la adelantó (5 a 40 min) y ya tenían el despertador puesto.
--
-- Por qué: «pidió con el día ya publicado» (0135) es la única regla que le dice hora a
-- alguien sin que un jefe la haya puesto, y decidía «publicado» por DEDUCCIÓN: existe
-- alguna vuelta ese día. Bastó una llegada de las 00:40 del miércoles (de la ruta del
-- martes, que un script dejó sin su día del plan) para que el miércoles entero pasara
-- por publicado desde el lunes en la noche. El 27, 28 y 29 de octubre ya se había
-- escapado uno por día de la misma forma.
--
-- Harold: «nosotros no podemos decir una hora de recogida, nunca, sino hasta la noche
-- tipo 8-9 que ya tengamos la ruta armada, porque dependemos del día».
--
-- Qué cambia:
--   1. route_published_days: la MARCA «el jefe publicó la ruta de este día». La deja un
--      disparador cuando UN JEFE crea una vuelta publicada (Publicar del tablero, pegar
--      la ruta: admin_manual_route_publish) o pasa un borrador a publicada (poner
--      conductor / delegar una vuelta). Nunca la deja el sistema: ni una vuelta que armó
--      solo, ni una que un conductor soltó, ni una que el reloj corrió de hora.
--      La vuelta de la madrugada (antes del corte) sin día del plan marca el día ANTERIOR.
--   2. reubicar_reserva: «día publicado» = hay marca (o la persona ya va en una vuelta
--      que puso un jefe). Sin marca devuelve 'unplanned', como siempre que no hay ruta:
--      el pedido queda sin hora y el tablero lo rutea al publicar.
--   3. detect_late_bookings («X no tiene carro»): la madrugada sin día del plan cuenta
--      para el día anterior, para que no les suene a los jefes un día que no han armado.
--   4. Se marcan los días que HOY ya están publicados (ayer en adelante).
--
-- Un script que publique sin pasar por admin_manual_route_publish con la sesión de un
-- jefe debe marcar el día él mismo: SELECT public.marcar_dia_publicado(org, día, quién, 'script').
--
-- Generada con scripts/_gen-0178.py desde las definiciones vivas de producción del
-- 18-nov-2026 (scripts/_base-0178/). Down: down_migrations/0178_hora_solo_con_ruta_publicada.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La marca
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_published_days (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  published_by    uuid NULL,
  source          text NOT NULL DEFAULT 'tablero',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_published_days_org_day UNIQUE (organization_id, day)
);
DROP TRIGGER IF EXISTS tr_route_published_days_set_updated_at ON public.route_published_days;
CREATE TRIGGER tr_route_published_days_set_updated_at
  BEFORE UPDATE ON public.route_published_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.route_published_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.route_published_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.route_published_days TO authenticated;
-- El jefe la puede leer (la escriben solo las funciones de abajo).
DROP POLICY IF EXISTS route_published_days_admin_read ON public.route_published_days;
CREATE POLICY route_published_days_admin_read ON public.route_published_days
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
COMMENT ON TABLE public.route_published_days
  IS '0178: el jefe publicó la ruta de este día. Sin esta marca el sistema no le arma vuelta ni le dice hora a quien pide.';

CREATE OR REPLACE FUNCTION public.marcar_dia_publicado(p_org uuid, p_day date, p_by uuid DEFAULT NULL, p_source text DEFAULT 'tablero')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_org IS NULL OR p_day IS NULL THEN RETURN false; END IF;
  INSERT INTO public.route_published_days (organization_id, day, published_by, source)
  VALUES (p_org, p_day, p_by, coalesce(nullif(btrim(p_source), ''), 'tablero'))
  ON CONFLICT (organization_id, day) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text) TO service_role;
COMMENT ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text)
  IS '0178: deja la marca «ruta publicada» de un día (una sola vez). true si la puso ahora.';

-- ¿Está publicada la ruta del día de esta hora? La madrugada (antes del corte) cuenta
-- también para el día anterior, como en 0143.
CREATE OR REPLACE FUNCTION public.dia_publicado(p_org uuid, p_when timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_org IS NOT NULL AND p_when IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.route_published_days d
     WHERE d.organization_id = p_org
       AND d.day IN ((p_when AT TIME ZONE 'America/Bogota')::date, public.dia_madrugada(p_when)));
$$;
REVOKE ALL ON FUNCTION public.dia_publicado(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dia_publicado(uuid, timestamptz) TO service_role;
COMMENT ON FUNCTION public.dia_publicado(uuid, timestamptz)
  IS '0178: true si el jefe ya publicó la ruta del día de esa hora (route_published_days).';

-- -----------------------------------------------------------------------------
-- 2. Quién deja la marca: un JEFE que publica una vuelta
-- -----------------------------------------------------------------------------
-- Una vuelta queda 'planned' por tres caminos del jefe: Publicar del tablero (la app la
-- inserta directo), pegar la ruta (admin_manual_route_publish la inserta) y poner
-- conductor o delegar un borrador (admin_route_set_driver y compañía la actualizan).
-- En los tres la sesión es la del jefe. Lo que arma el sistema lleva auto_created, lo
-- que suelta un conductor lleva la sesión del conductor y el reloj no lleva ninguna.
CREATE OR REPLACE FUNCTION public.tg_route_assignments_dia_publicado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.status::text <> 'planned' OR NEW.planned_start_at IS NULL OR coalesce(NEW.auto_created, false) THEN RETURN NULL; END IF;
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN RETURN NULL; END IF;
  v_org := public.current_user_org();
  IF v_org IS NULL OR (NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org) THEN RETURN NULL; END IF;
  PERFORM public.marcar_dia_publicado(
    v_org,
    -- El día del plan si lo trae (ruta pegada); la madrugada es del día anterior.
    coalesce(NEW.manual_day, public.dia_madrugada(NEW.planned_start_at), (NEW.planned_start_at AT TIME ZONE 'America/Bogota')::date),
    auth.uid(),
    CASE WHEN TG_OP = 'UPDATE' THEN 'vuelta' WHEN NEW.manual_day IS NOT NULL THEN 'pegar' ELSE 'tablero' END);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'marcar día publicado (%): %', NEW.id, SQLERRM;   -- publicar nunca se cae por esto
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_route_assignments_dia_publicado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_ins ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_dia_publicado_ins
  AFTER INSERT ON public.route_assignments
  FOR EACH ROW WHEN (NEW.status = 'planned')
  EXECUTE FUNCTION public.tg_route_assignments_dia_publicado();
DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_upd ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_dia_publicado_upd
  AFTER UPDATE OF status ON public.route_assignments
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'planned')
  EXECUTE FUNCTION public.tg_route_assignments_dia_publicado();

-- -----------------------------------------------------------------------------
-- 3. Los días que hoy ya están publicados (de ayer en adelante)
-- -----------------------------------------------------------------------------
INSERT INTO public.route_published_days (organization_id, day, published_at, source)
SELECT z.org, z.dia, min(z.creada), 'previa-0178'
  FROM (
    SELECT coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
              JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
             WHERE x.route_assignment_id = ra.id LIMIT 1)) AS org,
           coalesce(ra.manual_day, public.dia_madrugada(ra.planned_start_at), (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date) AS dia,
           ra.created_at AS creada
      FROM public.route_assignments ra
     WHERE ra.status IN ('planned', 'in_progress', 'completed')
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
       AND NOT coalesce(ra.auto_created, false)
       AND ra.planned_start_at >= now() - interval '3 days') z
 WHERE z.org IS NOT NULL AND z.dia >= (now() AT TIME ZONE 'America/Bogota')::date - 1
 GROUP BY 1, 2
ON CONFLICT (organization_id, day) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. reubicar_reserva: «día publicado» = la marca
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reubicar_reserva(p_res uuid, p_ready timestamp with time zone DEFAULT NULL::timestamp with time zone, p_motivo text DEFAULT 'cambio'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; cur record; o record; c record; s record; e record;
  v_buf int; v_srv int; v_cap int; v_win int; v_cut int;
  v_ap_lat double precision; v_ap_lng double precision;
  v_lle boolean; v_P timestamptz; v_ready timestamptz; v_vuelo text; v_ref timestamptz;
  v_who text; v_lugar text; v_pub_dia boolean; v_pre text; v_tit text; v_skip2 uuid;
  a_ord int[]; a_eta timestamptz[]; a_res uuid[]; a_lat double precision[]; a_lng double precision[];
  n int; k int; v_leg numeric; v_leg2 numeric;
  v_A timestamptz; v_A2 timestamptz; v_eta timestamptz; v_score numeric; v_det numeric; v_madr numeric;
  b_ra uuid; b_after int; b_eta timestamptz; b_score numeric;
  t_ok boolean := false; t_start timestamptz; t_eta timestamptz; t_ini timestamptz; t_fin timestamptz;
  v_removed int := 0; v_deleg boolean := false; v_kind text := 'unplanned';
  v_ra uuid; v_start timestamptz; v_from timestamptz; v_drv_prof uuid; v_drv_name text; v_dia date;
BEGIN
  SELECT res.*, ap.profile_id AS crew, pr.organization_id AS org, pr.full_name AS nombre,
         rz.sector AS sector, rz.name AS conjunto, f.flight_number AS vuelo_tabla
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    LEFT JOIN public.residences rz   ON rz.id = res.residence_id
    LEFT JOIN public.flights f       ON f.id = res.flight_id
   WHERE res.id = p_res;
  IF r.id IS NULL OR r.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('kind', 'none'); END IF;
  v_who := public.short_name(r.nombre);
  v_lugar := coalesce(r.conjunto, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''));
  v_vuelo := coalesce(r.vuelo_tabla, r.flight_code, nullif(upper(regexp_replace(
    coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''), '[[:space:]-]', '', 'g')), ''));

  SELECT route_airport_buffer_min, route_service_min, route_default_capacity, route_merge_window_min, route_night_cutoff_min
    INTO v_buf, v_srv, v_cap, v_win, v_cut FROM public.app_settings WHERE id = 'singleton';
  v_buf := coalesce(v_buf, 10); v_srv := coalesce(v_srv, 3); v_cap := coalesce(v_cap, 4); v_win := coalesce(v_win, 20); v_cut := coalesce(v_cut, 120);
  SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng FROM public.airports a WHERE a.organization_id = r.org ORDER BY a.created_at LIMIT 1;
  v_ap_lat := coalesce(v_ap_lat, 6.1715); v_ap_lng := coalesce(v_ap_lng, -75.4270);

  v_lle := r.direction = 'airport_to_home';
  IF v_lle THEN
    v_ready := coalesce(p_ready, r.required_arrival_at + make_interval(mins => CASE
      WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
      ELSE coalesce(public.flight_deplane_min(v_vuelo), 15) END));
  ELSE
    v_P := r.required_arrival_at;
  END IF;
  v_ref := coalesce(v_ready, v_P);
  -- 0172: 'soltada' = su conductor la soltó en JMC porque se demora (driver_llegada_soltar).
  v_pre := CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo cambió de hora: ' WHEN 'pedido' THEN 'Ya tienes carro: '
                         WHEN 'soltada' THEN 'Tu conductor tuvo que salir: ' ELSE 'Con tu hora nueva ' END;

  -- ¿El día ya tiene ruta publicada? (antes de tocar nada)
  -- 0178 (18-nov-2026, Harold: «no podemos decir una hora de recogida, nunca, sino hasta la
  -- noche, que ya tengamos la ruta armada»). Antes se DEDUCÍA: «hay alguna vuelta ese día».
  -- El 16-nov una llegada de las 00:40 del miércoles (de la ruta del martes) quedó sin su
  -- día del plan y el miércoles pasó por publicado: a 35 pedidos el sistema les armó vuelta
  -- y les dijo hora la víspera, antes de la lista; a 21 salidas la lista se la adelantó.
  -- Ahora manda la MARCA que queda cuando el jefe publica (route_published_days). A quien
  -- el jefe ya tiene en una vuelta suya se le sigue atendiendo el cambio: no se le saca.
  v_pub_dia := public.dia_publicado(r.org, r.required_arrival_at)
    OR EXISTS (
      SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
       WHERE rs.reservation_id = p_res AND ra.status IN ('planned', 'in_progress')
         AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
         AND NOT coalesce(ra.auto_created, false));

  IF NOT v_pub_dia THEN
    -- Sin ruta publicada ese día: sale del borrador (si estaba) y el tablero la rutea al publicar.
    FOR o IN SELECT rs.id AS stop_id, ra.id AS ra_id FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
              WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status IN ('draft', 'planned', 'in_progress')
    LOOP
      DELETE FROM public.route_stops WHERE id = o.stop_id;
      DELETE FROM public.route_assignments x WHERE x.id = o.ra_id AND x.status IN ('draft', 'planned')
         AND NOT EXISTS (SELECT 1 FROM public.route_stops y WHERE y.route_assignment_id = x.id);
      v_removed := v_removed + 1;
    END LOOP;
    RETURN jsonb_build_object('kind', 'unplanned', 'dir', r.direction, 'removed', v_removed, 'was_delegated', false);
  END IF;

  -- Su vuelta de ahora (sin arrancar), cuántos van y dónde empieza/termina.
  SELECT ra.id, ra.status, ra.pool, ra.delegated_at, ra.driver_profile_id AS drv, ra.planned_start_at, ra.deadline_at, rs.id AS stop_id,
         (SELECT count(*) FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
           WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL))::int AS n
    INTO cur
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
   WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status = 'planned'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
   ORDER BY ra.planned_start_at DESC LIMIT 1;
  -- Si iba sola, su vuelta se va a quitar: no le estorba a su conductor.
  v_skip2 := CASE WHEN cur.n = 1 THEN cur.id END;

  -- ── ¿Se puede correr su misma vuelta? (iba sola, sin delegar, su conductor
  --    alcanza y a esa hora está trabajando) ──
  IF cur.id IS NOT NULL AND cur.n = 1 AND cur.delegated_at IS NULL AND (cur.drv IS NOT NULL OR cur.pool) THEN
    SELECT * INTO e FROM public.reub_extremos(cur.id);
    IF v_lle THEN
      t_start := public.reub_arriba5(v_ready); t_eta := NULL;
      v_leg := public.reub_leg(NULL, v_ap_lat, v_ap_lng, true, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
      t_ini := t_start; t_fin := t_start + make_interval(mins => ceil(v_leg + v_srv)::int);
      t_ok := t_start >= now() + interval '10 minutes'
              AND public.reub_conductor_libre(cur.drv, cur.id, NULL, t_ini, NULL, v_ap_lat, v_ap_lng, true,
                                              t_fin, r.residence_id, r.pickup_latitude, r.pickup_longitude, false)
              AND public.reub_mismo_turno(cur.drv, cur.id, e.ini_at, e.fin_at, t_ini, t_fin);
    ELSE
      v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
      t_eta := public.reub_abajo5(v_P - make_interval(mins => ceil(v_leg + v_buf + v_srv)::int)); t_start := t_eta;
      t_ini := t_eta; t_fin := t_eta + make_interval(mins => ceil(v_leg + v_srv)::int);
      t_ok := t_eta >= now() + interval '15 minutes'
              AND public.reub_conductor_libre(cur.drv, cur.id, NULL, t_ini, r.residence_id, r.pickup_latitude, r.pickup_longitude, false,
                                              t_fin, NULL, v_ap_lat, v_ap_lng, true)
              AND public.reub_mismo_turno(cur.drv, cur.id, e.ini_at, e.fin_at, t_ini, t_fin);
    END IF;
  END IF;

  -- ── La mejor otra vuelta donde entre SIN mover a nadie ──
  FOR c IN SELECT * FROM public.reub_candidatas(p_res, v_cap) LOOP
    a_ord := ARRAY[]::int[]; a_eta := ARRAY[]::timestamptz[]; a_res := ARRAY[]::uuid[];
    a_lat := ARRAY[]::double precision[]; a_lng := ARRAY[]::double precision[];
    FOR s IN SELECT x.stop_order, x.estimated_arrival_at AS eta, coalesce(y.residence_id, x.guest_residence_id) AS res,
                    coalesce(y.pickup_latitude, x.guest_lat) AS lat, coalesce(y.pickup_longitude, x.guest_lng) AS lng
               FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
              WHERE x.route_assignment_id = c.ra_id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
              ORDER BY x.stop_order
    LOOP
      a_ord := a_ord || s.stop_order; a_eta := a_eta || s.eta; a_res := a_res || s.res; a_lat := a_lat || s.lat; a_lng := a_lng || s.lng;
    END LOOP;
    n := coalesce(array_length(a_ord, 1), 0);
    CONTINUE WHEN n = 0;

    IF NOT v_lle THEN
      -- SALIDA. La vuelta llega a tiempo a SU presentación sin madrugarla más que
      -- la ventana de juntar (lo mismo que el tablero); cada recogida tiene su hora.
      CONTINUE WHEN c.dl IS NULL OR c.dl > v_P OR v_P - c.dl > make_interval(mins => v_win);
      CONTINUE WHEN EXISTS (SELECT 1 FROM unnest(a_eta) t WHERE t IS NULL);
      v_madr := extract(epoch FROM (v_P - c.dl)) / 60;
      v_A := a_eta[n] + make_interval(mins => ceil(v_srv + public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, NULL, v_ap_lat, v_ap_lng, true))::int);
      FOR k IN 0..n LOOP
        -- k = entra después de la parada k (0 = de primera; n = de última).
        v_eta := NULL; v_A2 := v_A; v_det := NULL;
        IF k > 0 AND a_res[k] IS NOT NULL AND a_res[k] = r.residence_id THEN
          v_eta := a_eta[k]; v_det := 1;                                          -- con su vecina, a la misma hora
        ELSIF k = 0 THEN
          v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, a_res[1], a_lat[1], a_lng[1], false);
          IF v_leg <= 15 THEN                                                     -- de primera solo si queda cerca
            v_eta := public.reub_abajo5(a_eta[1] - make_interval(mins => ceil(v_leg + v_srv)::int)); v_det := v_leg + v_srv;
          END IF;
        ELSIF k < n THEN
          v_leg := public.reub_leg(a_res[k], a_lat[k], a_lng[k], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
          v_leg2 := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, a_res[k + 1], a_lat[k + 1], a_lng[k + 1], false);
          v_eta := a_eta[k] + make_interval(mins => ceil(v_srv + v_leg)::int);
          IF v_eta + make_interval(mins => ceil(v_srv + v_leg2)::int) > a_eta[k + 1] THEN v_eta := NULL;   -- no hay hueco
          ELSE v_det := v_leg + v_leg2 + v_srv - public.reub_leg(a_res[k], a_lat[k], a_lng[k], false, a_res[k + 1], a_lat[k + 1], a_lng[k + 1], false); END IF;
        ELSE
          v_leg := public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
          v_leg2 := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
          v_eta := a_eta[n] + make_interval(mins => ceil(v_srv + v_leg)::int);
          v_A2 := v_eta + make_interval(mins => ceil(v_srv + v_leg2)::int);
          -- De última solo si TODOS siguen llegando a su presentación.
          IF v_A2 + make_interval(mins => v_buf) > c.dl THEN v_eta := NULL;
          ELSE v_det := v_leg + v_leg2 + v_srv - public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, NULL, v_ap_lat, v_ap_lng, true); END IF;
        END IF;
        CONTINUE WHEN v_eta IS NULL;
        -- La recogida en múltiplo de 5 hacia abajo (como el tablero), nunca antes
        -- de la anterior; con la vecina, la misma de ella.
        IF k > 0 AND NOT (a_res[k] IS NOT NULL AND a_res[k] = r.residence_id) THEN
          v_eta := greatest(public.reub_abajo5(v_eta), a_eta[k]);
        END IF;
        CONTINUE WHEN v_eta < now() + interval '20 minutes';
        -- Si la vuelta arranca antes (de primera) o termina después (de última),
        -- su conductor tiene que alcanzar.
        IF c.drv IS NOT NULL AND (k = 0 OR k = n) THEN
          SELECT * INTO e FROM public.reub_extremos(c.ra_id);
          CONTINUE WHEN NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
               least(e.ini_at, v_eta), CASE WHEN k = 0 THEN r.residence_id ELSE e.ini_res END,
               CASE WHEN k = 0 THEN r.pickup_latitude ELSE e.ini_lat END, CASE WHEN k = 0 THEN r.pickup_longitude ELSE e.ini_lng END, false,
               greatest(e.fin_at, v_A2), NULL, v_ap_lat, v_ap_lng, true);
        END IF;
        v_score := v_det + 0.5 * v_madr + CASE WHEN c.drv IS NULL THEN 5 ELSE 0 END - CASE WHEN c.sector_igual THEN 3 ELSE 0 END;
        IF b_score IS NULL OR v_score < b_score THEN
          b_score := v_score; b_ra := c.ra_id; b_after := CASE WHEN k = 0 THEN 0 ELSE a_ord[k] END; b_eta := v_eta;
        END IF;
      END LOOP;
    ELSE
      -- LLEGADA: sale de JMC cuando ya bajó y la espera es corta. Con alguien de
      -- su conjunto (justo después) o de última.
      CONTINUE WHEN c.start_at < v_ready OR c.start_at > v_ready + interval '15 minutes';
      k := NULL;
      FOR i IN 1..n LOOP
        IF a_res[i] IS NOT NULL AND a_res[i] = r.residence_id THEN k := i; END IF;
      END LOOP;
      SELECT * INTO e FROM public.reub_extremos(c.ra_id);
      IF k IS NOT NULL THEN
        v_det := v_srv;
        CONTINUE WHEN c.drv IS NOT NULL AND NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
          e.ini_at, NULL, v_ap_lat, v_ap_lng, true, e.fin_at + make_interval(mins => v_srv), e.fin_res, e.fin_lat, e.fin_lng, e.fin_air);
      ELSE
        k := n;
        v_det := v_srv + public.reub_leg(a_res[n], a_lat[n], a_lng[n], false, r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
        CONTINUE WHEN c.drv IS NOT NULL AND NOT public.reub_conductor_libre(c.drv, c.ra_id, v_skip2,
          e.ini_at, NULL, v_ap_lat, v_ap_lng, true, e.fin_at + make_interval(mins => ceil(v_det)::int), r.residence_id, r.pickup_latitude, r.pickup_longitude, false);
      END IF;
      v_score := 0.5 * extract(epoch FROM (c.start_at - v_ready)) / 60 + v_det
                 + CASE WHEN c.drv IS NULL THEN 5 ELSE 0 END - CASE WHEN c.sector_igual THEN 3 ELSE 0 END;
      IF b_score IS NULL OR v_score < b_score THEN
        b_score := v_score; b_ra := c.ra_id; b_after := a_ord[k]; b_eta := NULL;
      END IF;
    END IF;
  END LOOP;

  -- ── Decide ──
  --   juntarse casi sin desvío (un viaje menos) > correr su vuelta > juntarse > vuelta nueva.
  IF b_ra IS NOT NULL AND (b_score <= 15 OR NOT t_ok) THEN
    v_kind := 'joined';
  ELSIF t_ok THEN
    v_kind := 'retimed';
  ELSE
    v_kind := 'new';
  END IF;

  -- 0144 · EL FRENO. Una vuelta nueva más no se arma si el sistema ya armó
  -- app_settings.acomodo_max_nuevas en la última media hora: algo raro está
  -- pasando (el 26-oct armó 29 en un minuto). No se toca nada: la reserva se
  -- queda donde estaba, y a los jefes les llega UN aviso por media hora.
  IF v_kind = 'new' AND public.acomodo_frenado(r.org) THEN
    PERFORM public.acomodo_aviso_freno(r.org,
      'Ya armé ' || (SELECT count(*) FROM public.acomodo_creadas x WHERE x.organization_id = r.org AND x.created_at > now() - interval '30 minutes')
      || ' vueltas para tomar en la última media hora y no armo más sola. ' || v_who
      || ' (' || CASE WHEN v_lle THEN 'llegada' ELSE 'salida' END || ' ' || public.hm_bog(r.required_arrival_at)
      || ') y las que sigan quedan como están: ubícalas en Eventualidades.');
    RETURN jsonb_build_object('kind', 'held', 'dir', r.direction, 'removed', 0, 'was_delegated', false, 'tight', true);
  END IF;

  IF v_kind = 'retimed' THEN
    v_ra := cur.id; v_from := cur.planned_start_at; v_start := t_start;
    UPDATE public.route_assignments
       SET planned_start_at = t_start,
           deadline_at = CASE WHEN deadline_at IS NOT NULL THEN v_P END,
           updated_at = now()
     WHERE id = cur.id;
    UPDATE public.route_stops
       SET estimated_arrival_at = CASE WHEN v_lle THEN estimated_arrival_at + (t_start - cur.planned_start_at) ELSE t_eta END
     WHERE id = cur.stop_id;
    SELECT dp.profile_id, pp.full_name INTO v_drv_prof, v_drv_name
      FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = cur.drv;
    v_eta := t_eta;
    PERFORM public.trip_notify(r.crew, CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: ajustamos tu traslado 🔄' END,
      v_pre || CASE WHEN v_lle THEN (CASE WHEN (coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL) THEN 'te esperamos en JMC a las ' || public.hm_bog(t_start) ELSE 'te esperamos en JMC cuando aterrices' END) /* 0171: sin la hora de salida de JMC a quien llega en un vuelo */ ELSE 'te recogemos a las ' || public.hm_bog(t_eta) END
      || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
      '/#/viaje?r=' || p_res::text, 'reub-time:' || p_res::text || ':' || to_char(t_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
        'La ' || CASE WHEN v_lle THEN 'llegada' ELSE 'salida' END || ' de ' || v_who || ' pasa de las ' || public.hm_bog(cur.planned_start_at)
        || ' a las ' || public.hm_bog(t_start) || CASE p_motivo WHEN 'vuelo' THEN ' (su vuelo cambió de hora).' ELSE ' (cambió su vuelo).' END,
        '/', 'reub-drvtime:' || cur.id::text || ':' || to_char(t_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
    PERFORM public.sync_calculated_pickup(p_res);
  ELSE
    -- Sale de su vuelta vieja (si queda vacía se quita; al conductor se le avisa).
    FOR o IN
      SELECT rs.id AS stop_id, ra.id AS ra_id, ra.planned_start_at, ra.delegated_at, dp.profile_id AS drv_prof
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
       WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status IN ('draft', 'planned', 'in_progress')
    LOOP
      DELETE FROM public.route_stops WHERE id = o.stop_id;
      DELETE FROM public.route_assignments ra
       WHERE ra.id = o.ra_id AND ra.status IN ('draft', 'planned')
         AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
      v_removed := v_removed + 1;
      IF o.delegated_at IS NOT NULL THEN v_deleg := true; END IF;
      IF o.drv_prof IS NOT NULL THEN
        PERFORM public.trip_notify(o.drv_prof, 'Cambió un traslado de tu ruta',
          v_who || CASE p_motivo WHEN 'vuelo' THEN ': su vuelo cambió de hora' ELSE ' cambió su vuelo' END
          || ', ya no va en tu vuelta de las ' || public.hm_bog(o.planned_start_at) || '.',
          '/', 'reub-out:' || p_res::text || ':' || o.ra_id::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
      END IF;
    END LOOP;
  END IF;

  IF v_kind = 'joined' THEN
    -- Entra en esa vuelta; los demás conservan su orden y su hora.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = b_ra AND stop_order > b_after;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (b_ra, p_res, b_after + 1, b_eta);
    UPDATE public.route_stops SET stop_order = stop_order - 999 WHERE route_assignment_id = b_ra AND stop_order > 1000;
    IF NOT v_lle AND b_eta IS NOT NULL THEN
      UPDATE public.route_assignments SET planned_start_at = least(planned_start_at, b_eta), updated_at = now() WHERE id = b_ra;
    END IF;
    SELECT ra.planned_start_at, dp.profile_id, pp.full_name INTO v_start, v_drv_prof, v_drv_name
      FROM public.route_assignments ra LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pp ON pp.id = dp.profile_id WHERE ra.id = b_ra;
    v_ra := b_ra; v_eta := b_eta;
    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️'
                           WHEN 'soltada' THEN 'Cambió quién te recoge 🔄' ELSE 'Listo: te movimos de vuelta 🔄' END;   -- 0172
    PERFORM public.trip_notify(r.crew, v_tit,
      v_pre || CASE WHEN v_lle THEN (CASE WHEN (coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL) THEN 'te esperamos en JMC a las ' || public.hm_bog(v_start) ELSE 'te esperamos en JMC cuando aterrices' END) /* 0171: sin la hora de salida de JMC a quien llega en un vuelo */ ELSE 'te recogemos a las ' || public.hm_bog(v_eta) END
      || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
      '/#/viaje?r=' || p_res::text, 'reub-in:' || p_res::text || ':' || v_ra::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Se sumó alguien a tu vuelta',
        v_who || ' va en tu vuelta de las ' || public.hm_bog(v_start)
        || CASE WHEN v_lle THEN coalesce(': lo dejas en ' || v_lugar, '') ELSE ': recogida ' || public.hm_bog(v_eta) || coalesce(' en ' || v_lugar, '') END || '.',
        '/', 'reub-drv:' || p_res::text || ':' || v_ra::text || ':' || to_char(v_ref AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
  ELSIF v_kind = 'new' THEN
    -- Vuelta NUEVA para tomar, solo para ella.
    IF NOT v_lle THEN
      v_leg := public.reub_leg(r.residence_id, r.pickup_latitude, r.pickup_longitude, false, NULL, v_ap_lat, v_ap_lng, true);
      v_eta := public.reub_abajo5(v_P - make_interval(mins => ceil(v_leg + v_buf + v_srv)::int));
      v_start := v_eta;
    ELSE
      v_start := public.reub_arriba5(v_ready); v_eta := NULL;
    END IF;
    -- El día del plan: lo de la madrugada (antes del corte) es del día anterior.
    v_dia := (v_start AT TIME ZONE 'America/Bogota')::date;
    IF extract(hour FROM v_start AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_start AT TIME ZONE 'America/Bogota') < v_cut THEN
      v_dia := v_dia - 1;
    END IF;
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                          pool, auto_created, organization_id, manual_day, deadline_at, manual_note)
    VALUES (NULL, NULL, r.direction, 'planned', v_start, true, true, r.org, v_dia,
            CASE WHEN NOT v_lle THEN v_P END,
            CASE p_motivo WHEN 'vuelo' THEN 'Creada sola: su vuelo cambió de hora' WHEN 'pedido' THEN 'Creada sola: pidió con el día publicado'
                          WHEN 'soltada' THEN 'Creada sola: se demora y su conductor la soltó en JMC'   -- 0172
                          ELSE 'Creada sola: cambio de vuelo' END)
    RETURNING id INTO v_ra;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (v_ra, p_res, 1, v_eta);
    -- 0144: cuenta para el freno (aunque después alguien borre la vuelta).
    INSERT INTO public.acomodo_creadas (organization_id, reservation_id, route_assignment_id) VALUES (r.org, p_res, v_ra);
    PERFORM public.trip_notify(r.crew, 'Te armamos una vuelta 🚗',
      v_pre || CASE WHEN NOT v_lle
           THEN 'te recogemos a las ' || public.hm_bog(v_eta) || ' para estar en JMC a las ' || public.hm_bog(v_P)
           ELSE (CASE WHEN (coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL) THEN 'te esperamos en JMC a las ' || public.hm_bog(v_start) ELSE 'te esperamos en JMC cuando aterrices' END) /* 0171: sin la hora de salida de JMC a quien llega en un vuelo */ END
      || '. Te avisamos quién te recoge.',
      '/#/viaje?r=' || p_res::text, 'reub-new:' || p_res::text || ':' || v_ra::text);
    -- 0144: solo a los conductores del turno de esa vuelta (antes: a todos).
    PERFORM public.avisar_vuelta_para_tomar(r.org, v_start, 'Hay una vuelta para tomar',
      CASE WHEN NOT v_lle THEN 'Salida' ELSE 'Llegada' END || ' de las ' || public.hm_bog(v_start)
      || ' (' || v_who || coalesce(', ' || v_lugar, '') || '): '
      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado'
                       WHEN 'soltada' THEN 'se demora y su conductor la soltó en JMC' ELSE 'cambió de vuelo' END   -- 0172
      || ' y no cabía en otra.',
      'reub-pool:' || v_ra::text);
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('kind', v_kind, 'dir', r.direction, 'ra_id', v_ra, 'start_at', v_start, 'from_at', v_from,
                            'pickup_at', CASE WHEN NOT v_lle THEN v_eta ELSE v_start END,
                            'driver_name', v_drv_name, 'removed', v_removed, 'was_delegated', v_deleg,
                            -- Muy encima: menos de 45 min para la recogida.
                            'tight', coalesce(CASE WHEN NOT v_lle THEN v_eta ELSE v_start END < now() + interval '45 minutes', false));
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. «X no tiene carro»: la madrugada sin día del plan es del día anterior
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_late_bookings()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
          -- 0178: una vuelta de la madrugada (antes del corte) SIN día del plan es del día
          -- anterior: ya no hace pasar por publicado el día siguiente.
          AND coalesce((to_jsonb(ra) ->> 'manual_day')::date, public.dia_madrugada(ra.planned_start_at),
                       (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date)
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
$function$;

COMMIT;
