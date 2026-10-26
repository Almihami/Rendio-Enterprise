-- =============================================================================
-- Migration 0144 — «Hay una vuelta para tomar» solo al turno, freno del acomodo
--                  y avisos que no salen repetidos
--
-- 26-oct-2026, en producción. La profa: «esto le llegó a todos los conductores,
-- ¿por qué?» y «llegaron más de 100 notificaciones». Tres cosas, además de la
-- causa de fondo (el día publicado por calendario), que arreglaron 0141 y 0143:
--
--   1. «Hay una vuelta para tomar» (0134/0135) y «Hay una vuelta libre» (0125)
--      les llegaban a TODOS los conductores activos, trabajaran o no. La profa:
--      «eso le debería aparecer a los que vayan a ese turno». Ahora van a los
--      conductores del turno de esa vuelta en el horario PUBLICADO (con los
--      cambios de turno aceptados encima) y, si el turno es el de ahora, a los
--      que tienen el turno abierto. El turno, como en el tablero: 00:00 al corte
--      (route_night_cutoff_min) = tarde del día anterior; corte–14:00 = mañana;
--      14:00–24:00 = tarde. Si nadie del turno está en el horario, el aviso les
--      llega a los jefes (una vez) en vez de a todos.
--      La LISTA de vueltas para tomar en Ruta sigue igual: cualquiera la ve.
--
--   2. EL FRENO. A las 4:20 p. m. el acomodo armó 29 vueltas sueltas en una
--      pasada. Ahora:
--        · no arma más de app_settings.acomodo_max_nuevas vueltas nuevas en media
--          hora (4 de entrada); pasado eso la reserva se queda como estaba
--          (kind 'held') y su eventualidad queda ABIERTA para un jefe;
--        · si a la vez hay más «sin carro» que ese número, no acomoda ninguno
--          (eso es un día sin ruta, no pedidos tarde);
--        · a los jefes les llega UN aviso «Frené el acomodo automático» por media
--          hora, no uno por reserva.
--
--   3. REPETIDOS. Cada decisión pide «despacha ya» (trip_kick), y varias en la
--      misma pasada salen JUNTAS al confirmar: varias corridas de
--      dispatch-notifications leían las mismas filas pendientes y cada una las
--      mandaba. claim_notification_outbox() aparta las filas (FOR UPDATE SKIP
--      LOCKED + claimed_at) y la función solo manda lo que apartó. La función
--      nueva de dispatch-notifications la usa; si no existe, lee como antes.
--
-- Copias (lo cambiado va marcado «0144»):
--   reubicar_reserva       ← 0143 (la regla del día publicado de 0141 + 0143)
--   reub_nota              ← 0135
--   acomodar_eventualidades← 0135
--   driver_release_route   ← 0125
-- NO toca detect_late_bookings, admin_manual_route_publish ni
-- admin_manual_route_clear (son de 0141/0143).
--
-- Necesita 0125, 0134, 0135, 0141 y 0143. Idempotente.
-- Down: down_migrations/0144_avisos_por_turno_y_freno.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Lo que se guarda
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS acomodo_max_nuevas smallint NOT NULL DEFAULT 4;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_acomodo_max_nuevas_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_acomodo_max_nuevas_range CHECK (acomodo_max_nuevas BETWEEN 1 AND 50);
COMMENT ON COLUMN public.app_settings.acomodo_max_nuevas
  IS '0144: el freno del acomodo. Máximo de vueltas para tomar que el sistema arma solo en media hora, y máximo de «sin carro» que acomoda en una tanda.';

-- Cada vuelta que el acomodo armó solo, para contar (la vuelta se puede borrar).
CREATE TABLE IF NOT EXISTS public.acomodo_creadas (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reservation_id      uuid        REFERENCES public.reservations(id) ON DELETE SET NULL,
  route_assignment_id uuid,       -- sin FK a propósito: la vuelta se borra y la cuenta sigue
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acomodo_creadas_org_created ON public.acomodo_creadas (organization_id, created_at);
DROP TRIGGER IF EXISTS tr_acomodo_creadas_set_updated_at ON public.acomodo_creadas;
CREATE TRIGGER tr_acomodo_creadas_set_updated_at
  BEFORE UPDATE ON public.acomodo_creadas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- RLS encendida y SIN políticas: solo la escriben y la leen funciones del servidor.
ALTER TABLE public.acomodo_creadas ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.acomodo_creadas IS '0144: vueltas para tomar que armó el acomodo solo (reubicar_reserva, kind new). La cuenta el freno.';

-- La fila que una corrida de dispatch-notifications apartó para mandar.
ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
COMMENT ON COLUMN public.notification_outbox.claimed_at
  IS '0144: cuándo la apartó una corrida de dispatch-notifications. Otra corrida no la toca en 2 minutos.';

-- -----------------------------------------------------------------------------
-- 2. El turno de una hora (igual que el tablero)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.turno_de(p_at timestamptz, OUT dia date, OUT turno text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN y.m < z.c THEN x.l::date - 1 ELSE x.l::date END,
         CASE WHEN y.m < z.c OR y.m >= 14 * 60 THEN 'pm' ELSE 'am' END
    FROM (SELECT p_at AT TIME ZONE 'America/Bogota' AS l) x,
         LATERAL (SELECT (extract(hour FROM x.l) * 60 + extract(minute FROM x.l))::int AS m) y,
         LATERAL (SELECT coalesce((SELECT s.route_night_cutoff_min FROM public.app_settings s WHERE s.id = 'singleton'), 120) AS c) z;
$$;
REVOKE ALL ON FUNCTION public.turno_de(timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.turno_de(timestamptz)
  IS '0144: el turno al que pertenece una hora: 00:00–corte = tarde (pm) del día anterior; corte–14:00 = mañana (am); 14:00–24:00 = tarde. Como el tablero.';

-- -----------------------------------------------------------------------------
-- 3. Los conductores de ese turno
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conductores_del_turno(p_org uuid, p_at timestamptz)
RETURNS TABLE (profile_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record; v_now record;
  v_idx int; v_week date; v_key text; v_slot text; v_data jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  s record;
BEGIN
  SELECT * INTO t FROM public.turno_de(p_at);
  v_idx  := extract(isodow FROM t.dia)::int - 1;              -- 0 = lunes, como el horario y shift_swaps
  v_week := t.dia - v_idx;
  v_key  := (ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[v_idx + 1];
  v_slot := CASE t.turno WHEN 'am' THEN 'morning' ELSE 'afternoon' END;

  -- El horario PUBLICADO de esa semana (lo mismo que usa el tablero).
  SELECT ws.data INTO v_data FROM public.weekly_schedules ws WHERE ws.week_start_date = v_week AND ws.published;
  IF v_data IS NOT NULL AND jsonb_typeof(v_data #> ARRAY[v_key, v_slot]) = 'array' THEN
    SELECT coalesce(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO v_ids
      FROM jsonb_array_elements_text(v_data #> ARRAY[v_key, v_slot]) x
     WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    -- Los cambios de turno aceptados (0019) van encima, como en la pantalla:
    -- A (requester) estaba en «from» y B (target) en «to»; se cambian.
    FOR s IN
      SELECT sw.requester_id, sw.target_id, sw.from_day, sw.from_shift::text AS fs, sw.to_day, sw.to_shift::text AS ts
        FROM public.shift_swaps sw
       WHERE sw.week_start_date = v_week AND sw.state = 'accepted'
       ORDER BY sw.decided_at NULLS LAST, sw.created_at
    LOOP
      IF s.from_day = v_idx AND s.fs = t.turno AND s.requester_id = ANY (v_ids) THEN
        v_ids := array_append(array_remove(v_ids, s.requester_id), s.target_id);
      ELSIF s.to_day = v_idx AND s.ts = t.turno AND s.target_id = ANY (v_ids) THEN
        v_ids := array_append(array_remove(v_ids, s.target_id), s.requester_id);
      END IF;
    END LOOP;
  END IF;

  -- Si es el turno de AHORA, también los que tienen el turno abierto.
  SELECT * INTO v_now FROM public.turno_de(now());
  IF v_now.dia = t.dia AND v_now.turno = t.turno THEN
    v_ids := v_ids || coalesce((
      SELECT array_agg(DISTINCT dp.profile_id)
        FROM public.shifts sh JOIN public.driver_profiles dp ON dp.id = sh.driver_id
       WHERE sh.organization_id = p_org AND sh.status::text <> 'closed' AND sh.start_at > now() - interval '16 hours'), ARRAY[]::uuid[]);
  END IF;

  RETURN QUERY
    SELECT DISTINCT p.id
      FROM public.profiles p
     WHERE p.id = ANY (v_ids) AND p.organization_id = p_org AND p.role = 'driver'
       AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
END;
$$;
REVOKE ALL ON FUNCTION public.conductores_del_turno(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.conductores_del_turno(uuid, timestamptz)
  IS '0144: conductores del turno de esa hora: horario publicado + cambios de turno aceptados; si es el turno de ahora, también los de turno abierto.';

-- -----------------------------------------------------------------------------
-- 4. «Hay una vuelta para tomar» / «Hay una vuelta libre»: solo a ese turno
-- -----------------------------------------------------------------------------
-- p_desc: qué es la vuelta («Salida de las 18:15 (Ana, Olivar): …»).
-- p_key:  prefijo de la llave; cada conductor la recibe con «:<su id>» (las
--         mismas llaves de antes, así no se repite lo que ya salió).
-- Si nadie del turno está en el horario: a los jefes, una vez (p_jefes).
CREATE OR REPLACE FUNCTION public.avisar_vuelta_para_tomar(p_org uuid, p_start timestamptz, p_title text, p_desc text, p_key text,
                                                          p_except uuid DEFAULT NULL, p_jefes boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[]; v_n int := 0; t record;
BEGIN
  IF p_org IS NULL OR p_start IS NULL THEN RETURN 0; END IF;
  SELECT coalesce(array_agg(c.profile_id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.conductores_del_turno(p_org, p_start) c WHERE c.profile_id IS DISTINCT FROM p_except;
  IF cardinality(v_ids) > 0 THEN
    SELECT count(*) INTO v_n FROM (
      SELECT public.trip_notify(x, p_title, p_desc || ' Tómala en Ruta si puedes.', '/#/ruta', p_key || ':' || x::text) AS ok
        FROM unnest(v_ids) x) z
     WHERE z.ok;
  ELSIF p_jefes THEN
    SELECT * INTO t FROM public.turno_de(p_start);
    PERFORM public.trip_notify(j.profile_id, 'Nadie del turno para esta vuelta ⚠️',
      'Ningún conductor del turno de la ' || CASE t.turno WHEN 'am' THEN 'mañana' ELSE 'tarde' END || ' del ' || to_char(t.dia, 'DD/MM')
      || ' está en el horario publicado. ' || p_desc || ' Asígnala en Rutas del día.',
      '/#/rutas', p_key || ':sinturno:' || j.profile_id::text)
      FROM public.ops_alert_recipients_of(p_org) j;
  END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.avisar_vuelta_para_tomar(uuid, timestamptz, text, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. El freno
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acomodo_frenado(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*) >= coalesce((SELECT s.acomodo_max_nuevas FROM public.app_settings s WHERE s.id = 'singleton'), 4)
    FROM public.acomodo_creadas x
   WHERE x.organization_id = p_org AND x.created_at > now() - interval '30 minutes';
$$;
REVOKE ALL ON FUNCTION public.acomodo_frenado(uuid) FROM PUBLIC, anon, authenticated;

-- UN aviso a los jefes por organización y por media hora (la llave lleva la media hora).
CREATE OR REPLACE FUNCTION public.acomodo_aviso_freno(p_org uuid, p_body text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_media text := to_char(date_trunc('hour', now()) + (floor(extract(minute FROM now()) / 30) * 30) * interval '1 minute', 'YYYYMMDDHH24MI');
BEGIN
  PERFORM public.trip_notify(j.profile_id, 'Frené el acomodo automático ⚠️', p_body, '/#/rutas',
                             'acomodo-freno:' || p_org::text || ':' || v_media || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(p_org) j;
END;
$$;
REVOKE ALL ON FUNCTION public.acomodo_aviso_freno(uuid, text) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5b. La bandeja de avisos: cada fila la manda UNA sola corrida
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notification_outbox(p_limit integer DEFAULT 50)
RETURNS SETOF public.notification_outbox
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.notification_outbox o
     SET claimed_at = now()
   WHERE o.id IN (
     SELECT x.id FROM public.notification_outbox x
      WHERE x.sent_at IS NULL AND x.send_after <= now() AND x.attempts < 5
        AND (x.claimed_at IS NULL OR x.claimed_at < now() - interval '2 minutes')
      ORDER BY x.created_at
      LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
      FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
$$;
REVOKE ALL ON FUNCTION public.claim_notification_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox(integer) TO service_role;
COMMENT ON FUNCTION public.claim_notification_outbox(integer)
  IS '0144: aparta hasta p_limit avisos pendientes para UNA corrida de dispatch-notifications (las demás corridas no los ven en 2 minutos).';


-- -----------------------------------------------------------------------------
-- 6. reubicar_reserva (copia de 0143; cambia lo marcado «0144»)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reubicar_reserva(p_res uuid, p_ready timestamptz DEFAULT NULL, p_motivo text DEFAULT 'cambio')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_pre := CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo cambió de hora: ' WHEN 'pedido' THEN 'Ya tienes carro: ' ELSE 'Con tu hora nueva ' END;

  -- ¿El día ya tiene ruta publicada? (antes de tocar nada: si era la única vuelta
  -- y se quita, el día parecería sin ruta)
  v_pub_dia := EXISTS (
    SELECT 1 FROM public.route_assignments ra
     WHERE ra.status IN ('planned', 'in_progress')
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
       AND NOT coalesce(ra.auto_created, false)   -- 0141: la que armó el sistema solo no publica el día
       AND public.dia_del_plan(ra.manual_day, ra.planned_start_at) IN ((r.required_arrival_at AT TIME ZONE 'America/Bogota')::date, public.dia_madrugada(r.required_arrival_at))   -- 0143: la madrugada también es del día anterior
       AND (ra.organization_id = r.org OR EXISTS (
             SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
               JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
              WHERE x.route_assignment_id = ra.id AND yp.organization_id = r.org)));

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
      v_pre || CASE WHEN v_lle THEN 'te esperamos en JMC a las ' || public.hm_bog(t_start) ELSE 'te recogemos a las ' || public.hm_bog(t_eta) END
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
    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: te movimos de vuelta 🔄' END;
    PERFORM public.trip_notify(r.crew, v_tit,
      v_pre || CASE WHEN v_lle THEN 'te esperamos en JMC a las ' || public.hm_bog(v_start) ELSE 'te recogemos a las ' || public.hm_bog(v_eta) END
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
                          ELSE 'Creada sola: cambio de vuelo' END)
    RETURNING id INTO v_ra;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (v_ra, p_res, 1, v_eta);
    -- 0144: cuenta para el freno (aunque después alguien borre la vuelta).
    INSERT INTO public.acomodo_creadas (organization_id, reservation_id, route_assignment_id) VALUES (r.org, p_res, v_ra);
    PERFORM public.trip_notify(r.crew, 'Te armamos una vuelta 🚗',
      v_pre || CASE WHEN NOT v_lle
           THEN 'te recogemos a las ' || public.hm_bog(v_eta) || ' para estar en JMC a las ' || public.hm_bog(v_P)
           ELSE 'te esperamos en JMC a las ' || public.hm_bog(v_start) END
      || '. Te avisamos quién te recoge.',
      '/#/viaje?r=' || p_res::text, 'reub-new:' || p_res::text || ':' || v_ra::text);
    -- 0144: solo a los conductores del turno de esa vuelta (antes: a todos).
    PERFORM public.avisar_vuelta_para_tomar(r.org, v_start, 'Hay una vuelta para tomar',
      CASE WHEN NOT v_lle THEN 'Salida' ELSE 'Llegada' END || ' de las ' || public.hm_bog(v_start)
      || ' (' || v_who || coalesce(', ' || v_lugar, '') || '): '
      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado' ELSE 'cambió de vuelo' END
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
$$;

REVOKE ALL ON FUNCTION public.reubicar_reserva(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. reub_nota (copia de 0135; suma la frase del freno)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_nota(p jsonb)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p->>'kind'
    WHEN 'retimed' THEN 'Se resolvió sola: su vuelta pasó de las ' || coalesce(public.hm_bog((p->>'from_at')::timestamptz), '?')
                        || ' a las ' || public.hm_bog((p->>'start_at')::timestamptz)
                        || CASE WHEN coalesce((p->>'pooled')::boolean, false) THEN '; su conductor no alcanzaba y quedó para que otro la tome'
                                WHEN p->>'driver_name' IS NOT NULL THEN ' (sigue con ' || (p->>'driver_name') || ')' ELSE '' END || '.'
    WHEN 'joined'  THEN 'Se resolvió sola: pasó a la vuelta de las ' || public.hm_bog((p->>'start_at')::timestamptz)
                        || coalesce(' de ' || (p->>'driver_name'), ' (para tomar)')
                        || CASE WHEN p->>'dir' = 'home_to_airport' AND p->>'pickup_at' IS NOT NULL
                                THEN ', recogida ' || public.hm_bog((p->>'pickup_at')::timestamptz) ELSE '' END || '.'
    WHEN 'new'     THEN 'Se resolvió sola: no cabía en ninguna vuelta y se creó una vuelta nueva para tomar a las '
                        || public.hm_bog((p->>'pickup_at')::timestamptz) || '.'
    WHEN 'held'    THEN 'No se acomodó sola: el freno del acomodo estaba puesto (ya había armado varias vueltas en poco tiempo). Un jefe tiene que ubicarla.'
    ELSE 'Se actualizó la reserva: ese día todavía no tiene ruta publicada (entra al publicarla).' END
    || CASE WHEN coalesce((p->>'was_delegated')::boolean, false) THEN ' OJO: estaba en una vuelta DELEGADA: avísale a quien la iba a hacer.' ELSE '' END
    || CASE WHEN coalesce((p->>'tight')::boolean, false) AND p->>'kind' IS DISTINCT FROM 'held' THEN ' OJO: queda muy encima de la hora: revisa que alguien la tome.' ELSE '' END;
$$;

REVOKE ALL ON FUNCTION public.reub_nota(jsonb) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. acomodar_eventualidades (copia de 0135; cambia lo marcado «0144»)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record; m record; cf record; lb record; e record;
  v_need timestamptz; v_late int; v_total int; v_start timestamptz; v_delta interval;
  v_ok boolean; v_reub jsonb; v_drv_prof uuid; v_drv_name text; v_org uuid; v_dia date; v_cut int;
  n_vuelos int := 0; n_cambios int := 0; n_sin int := 0; n_err int := 0;
  n_frenadas int := 0; v_max int; fo record; v_orgs_frenadas uuid[] := ARRAY[]::uuid[];   -- 0144
  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
BEGIN
  SELECT route_night_cutoff_min INTO v_cut FROM public.app_settings WHERE id = 'singleton';
  v_cut := coalesce(v_cut, 120);

  -- a) LLEGADAS: vuelta por vuelta (sin arrancar, sin delegar), quién baja después
  --    de que la vuelta sale de JMC según Flightradar24.
  FOR v IN
    SELECT ra.id, ra.planned_start_at, ra.driver_profile_id, ra.pool, ra.manual_day,
           coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                     JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
                    WHERE x.route_assignment_id = ra.id LIMIT 1)) AS org
      FROM public.route_assignments ra
     WHERE ra.direction = 'airport_to_home' AND ra.status = 'planned' AND ra.delegated_at IS NULL
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool)
       AND ra.planned_start_at BETWEEN p_now - interval '1 hour' AND p_now + interval '30 hours'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.reservation_id IS NOT NULL)
  LOOP
    BEGIN
      v_need := NULL; v_late := 0; v_total := 0;
      FOR m IN
        SELECT r.id AS rid, r.required_arrival_at, r.flight_code, public.reub_baja(v.org, r.flight_code, r.required_arrival_at) AS baja,
               CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
                    ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END AS desemb
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
         WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
      LOOP
        v_total := v_total + 1;
        IF m.baja IS NOT NULL AND m.baja + make_interval(mins => m.desemb) > v.planned_start_at + interval '5 minutes' THEN
          v_late := v_late + 1;
        END IF;
        v_need := greatest(v_need, coalesce(m.baja, m.required_arrival_at) + make_interval(mins => m.desemb));
      END LOOP;
      CONTINUE WHEN v_late = 0;

      IF v_late = v_total THEN
        -- Vienen tarde TODOS: la vuelta entera se corre (nadie queda atrás).
        v_start := public.reub_arriba5(v_need);
        v_delta := v_start - v.planned_start_at;
        SELECT * INTO e FROM public.reub_extremos(v.id);
        v_ok := public.reub_conductor_libre(v.driver_profile_id, v.id, NULL, e.ini_at + v_delta, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                                            e.fin_at + v_delta, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air)
                AND public.reub_mismo_turno(v.driver_profile_id, v.id, e.ini_at, e.fin_at, e.ini_at + v_delta, e.fin_at + v_delta);
        SELECT dp.profile_id, pp.full_name INTO v_drv_prof, v_drv_name
          FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = v.driver_profile_id;
        IF v_ok THEN
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
              'El vuelo viene tarde: tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' ahora sale de JMC a las ' || public.hm_bog(v_start) || '.',
              '/', 'flt-drvtime:' || v.id::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
        ELSE
          -- Su conductor no alcanza: queda para tomar, todos juntos, a la hora nueva.
          v_dia := (v_start AT TIME ZONE 'America/Bogota')::date;
          IF extract(hour FROM v_start AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_start AT TIME ZONE 'America/Bogota') < v_cut THEN
            v_dia := v_dia - 1;
          END IF;
          UPDATE public.route_assignments
             SET planned_start_at = v_start, driver_profile_id = NULL, vehicle_id = NULL, pool = true, auto_created = true,
                 organization_id = v.org, manual_day = coalesce(manual_day, v_dia),
                 manual_note = 'Quedó para tomar sola: el vuelo llegó tarde y su conductor no alcanzaba', updated_at = now()
           WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Ya no haces una vuelta',
              'El vuelo de tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' viene tarde y a las ' || public.hm_bog(v_start)
              || ' no alcanzas: quedó para que otro conductor la tome.', '/', 'flt-drop:' || v.id::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
          -- 0144: solo a los conductores del turno de esa vuelta.
          PERFORM public.avisar_vuelta_para_tomar(v.org, v_start, 'Hay una vuelta para tomar',
            'Llegada de las ' || public.hm_bog(v_start) || ': el vuelo viene tarde y su conductor no alcanza.',
            'flt-pool:' || v.id::text);
          v_drv_name := NULL;
        END IF;
        UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
         WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
                   JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          PERFORM public.sync_calculated_pickup(m.rid);
          PERFORM public.trip_notify(m.crew, 'Tu vuelo viene a otra hora ✈️',
            'Tu vuelo viene tarde: te esperamos en JMC a las ' || public.hm_bog(v_start)
            || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
            '/#/viaje?r=' || m.rid::text, 'flt-time:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja más tarde: la vuelta salía de JMC a las ' || public.hm_bog(v.planned_start_at) || '.',
            jsonb_build_object('kind', 'retimed', 'dir', 'airport_to_home', 'from_at', v.planned_start_at, 'start_at', v_start, 'pickup_at', v_start,
                               'driver_name', v_drv_name, 'pooled', NOT v_ok, 'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok,
                               'was_delegated', false, 'removed', 0),
            'fltauto:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'), jsonb_build_object('kind', 'flight_api'));
        END LOOP;
        PERFORM public.trip_kick();
        n_vuelos := n_vuelos + v_total;
      ELSE
        -- Solo algunos vienen tarde: esos se reubican; los demás siguen igual.
        FOR m IN
          SELECT r.id AS rid, r.flight_code, public.reub_baja(v.org, r.flight_code, r.required_arrival_at) AS baja,
                 CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
                      ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END AS desemb
            FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
           WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          CONTINUE WHEN m.baja IS NULL OR m.baja + make_interval(mins => m.desemb) <= v.planned_start_at + interval '5 minutes';
          v_reub := public.reubicar_reserva(m.rid, m.baja + make_interval(mins => m.desemb), 'vuelo');
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja a las ' || public.hm_bog(m.baja) || ' y su vuelta salía de JMC a las '
            || public.hm_bog(v.planned_start_at) || '.',
            v_reub, 'fltauto:' || m.rid::text || ':' || to_char(m.baja AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'), jsonb_build_object('kind', 'flight_api'));
          n_vuelos := n_vuelos + 1;
          IF v_reub->>'kind' = 'held' THEN n_frenadas := n_frenadas + 1; END IF;   -- 0144
        END LOOP;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar vuelo (vuelta %): %', v.id, SQLERRM;
    END;
  END LOOP;

  -- b) Cambios de vuelo que se quedaron esperando a Coordinación: el ÚLTIMO de
  --    cada reserva, si la reserva sigue como estaba y la hora nueva no ha pasado.
  FOR cf IN
    SELECT DISTINCT ON (inc.reservation_id) inc.id, inc.reservation_id, inc.details, r.required_arrival_at, r.notes
      FROM public.incidents inc JOIN public.reservations r ON r.id = inc.reservation_id
     WHERE inc.status IN ('open', 'in_progress') AND inc.details->>'kind' = 'aux_change_flight'
       AND NOT coalesce((inc.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private'
     ORDER BY inc.reservation_id, inc.created_at DESC
  LOOP
    BEGIN
      v_new_when := (cf.details->>'new_when')::timestamptz;
      CONTINUE WHEN v_new_when IS NULL OR v_new_when <= p_now + interval '30 minutes';
      CONTINUE WHEN cf.required_arrival_at IS DISTINCT FROM (cf.details->>'old_when')::timestamptz;   -- alguien ya lo aplicó a mano
      v_new_flight := nullif(cf.details->>'new_flight', '');
      v_regreso := coalesce(cf.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
      v_user := public.notes_without_flight(cf.notes);
      v_notes := CASE WHEN nullif(cf.details->>'new_reserve_place', '') IS NOT NULL THEN v_user
                      WHEN v_new_flight IS NULL THEN cf.notes
                      ELSE btrim('Vuelo ' || v_new_flight || '. ' || coalesce(v_user, '') || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END) END;
      UPDATE public.reservations
         SET required_arrival_at = v_new_when,
             reserve_place = CASE WHEN cf.details ? 'new_reserve_place' THEN nullif(cf.details->>'new_reserve_place', '') ELSE reserve_place END,
             notes = nullif(v_notes, ''),
             flight_id = CASE WHEN nullif(cf.details->>'new_reserve_place', '') IS NOT NULL THEN NULL
                              WHEN v_new_flight IS NOT NULL AND v_new_flight IS DISTINCT FROM nullif(cf.details->>'old_flight', '') THEN NULL
                              ELSE flight_id END
       WHERE id = cf.reservation_id;
      v_reub := public.reubicar_reserva(cf.reservation_id, NULL, 'cambio');
      -- 0144: frenado. La reserva ya tiene su hora nueva (la pidió ella), su
      -- eventualidad sigue ABIERTA para un jefe y la próxima pasada no la repite
      -- (ya no está como old_when).
      IF v_reub->>'kind' = 'held' THEN n_frenadas := n_frenadas + 1; CONTINUE; END IF;
      UPDATE public.incidents SET status = 'resolved', resolved_at = now(),
             resolution_notes = 'El sistema aplicó el cambio que había pedido (' || to_char(v_new_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI')
                                || coalesce(' · vuelo ' || v_new_flight, '') || '). ' || public.reub_nota(v_reub)
       WHERE reservation_id = cf.reservation_id AND status IN ('open', 'in_progress') AND details->>'kind' = 'aux_change_flight'
         AND NOT coalesce((details->>'auto')::boolean, false);
      -- Si quedó encima o venía de una delegada, una abierta que les suene a los jefes.
      IF coalesce((v_reub->>'tight')::boolean, false) OR coalesce((v_reub->>'was_delegated')::boolean, false) THEN
        PERFORM public.reub_rastro(cf.reservation_id, CASE WHEN v_new_when > cf.required_arrival_at THEN 'flight_delay' ELSE 'flight_advanced' END,
          'Cambió su vuelo (' || to_char(cf.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') || ' → '
          || to_char(v_new_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') || coalesce(' · vuelo ' || v_new_flight, '') || ').',
          v_reub, 'cfauto:' || cf.id::text, jsonb_build_object('kind', 'aux_change_flight_auto'));
      END IF;
      n_cambios := n_cambios + 1;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar cambio de vuelo (reserva %): %', cf.reservation_id, SQLERRM;
    END;
  END LOOP;

  -- c) «X no tiene carro» abierta (0068/0127): se reubica.
  -- 0144 · FRENO por tanda: si a la vez hay más «sin carro» de los que el sistema
  -- puede armar en media hora, eso no son pedidos tarde: es un día sin ruta (el
  -- 26-oct fueron 34). No se acomoda ninguno de esa organización y a los jefes les
  -- llega UN aviso.
  SELECT acomodo_max_nuevas INTO v_max FROM public.app_settings WHERE id = 'singleton';
  v_max := coalesce(v_max, 4);
  FOR fo IN
    SELECT ii.organization_id AS org, count(DISTINCT ii.reservation_id)::int AS n
      FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
       AND ii.organization_id IS NOT NULL
     GROUP BY ii.organization_id
    HAVING count(DISTINCT ii.reservation_id) > v_max
  LOOP
    v_orgs_frenadas := array_append(v_orgs_frenadas, fo.org);
    n_frenadas := n_frenadas + fo.n;
    PERFORM public.acomodo_aviso_freno(fo.org,
      'Hay ' || fo.n || ' tripulantes «sin carro» al mismo tiempo. Eso parece un día sin ruta, no pedidos tarde: no acomodé a ninguno. Revisa Rutas del día.');
  END LOOP;
  FOR lb IN
    SELECT DISTINCT ON (ii.reservation_id) ii.id, ii.reservation_id FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
       AND (ii.organization_id IS NULL OR NOT (ii.organization_id = ANY (v_orgs_frenadas)))   -- 0144
     ORDER BY ii.reservation_id, ii.created_at DESC
  LOOP
    BEGIN
      v_reub := public.reubicar_reserva(lb.reservation_id, NULL, 'pedido');
      CONTINUE WHEN v_reub->>'kind' NOT IN ('joined', 'new', 'retimed');
      UPDATE public.incidents SET status = 'resolved', resolved_at = now(), resolution_notes = public.reub_nota(v_reub)
       WHERE reservation_id = lb.reservation_id AND status IN ('open', 'in_progress') AND category = 'late_booking';
      n_sin := n_sin + 1;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar sin carro (reserva %): %', lb.reservation_id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('vuelos', n_vuelos, 'cambios', n_cambios, 'sin_carro', n_sin, 'errores', n_err, 'frenadas', n_frenadas);
END;
$$;

REVOKE ALL ON FUNCTION public.acomodar_eventualidades(timestamptz) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. driver_release_route (copia de 0125; el aviso a los conductores, por turno)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_release_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_n   int;
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor suelta vueltas' USING ERRCODE = '42501'; END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = NULL, vehicle_id = NULL, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id = v_dp AND status = 'planned'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = p_route AND x.status <> 'pending')
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    RAISE EXCEPTION 'No puedes soltar esta vuelta: ya arrancó o no es tuya' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT count(*) INTO v_n FROM public.route_stops WHERE route_assignment_id = ra.id;
  -- Los jefes, y los demás conductores: hay una vuelta libre otra vez.
  PERFORM public.trip_notify(j.profile_id, 'Soltaron una vuelta',
    coalesce(public.short_name(v_me), 'Un conductor') || ' soltó la vuelta de las ' || public.hm_bog(ra.planned_start_at)
      || ' (' || v_n || CASE WHEN v_n = 1 THEN ' persona' ELSE ' personas' END || '). Quedó disponible.',
    '/#/rutas', 'release:' || ra.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS') || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  -- 0144: solo a los demás conductores del turno de esa vuelta (a los jefes ya les llegó «Soltaron una vuelta»).
  PERFORM public.avisar_vuelta_para_tomar(v_org, ra.planned_start_at, 'Hay una vuelta libre',
    'Se liberó la vuelta de las ' || public.hm_bog(ra.planned_start_at) || '.',
    'releasedrv:' || ra.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS'), auth.uid(), false);
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id);
END;
$$;

COMMIT;
