-- 0171 · En las llegadas, la hora que se dice es la del VUELO (17-nov-2026)
--
-- Julián (jefe), por audio: «yo quitaría el aproximado a la hora que van a salir del
-- aeropuerto; solamente la hora a la que aterriza el avión… que el sistema lo lea,
-- pero que no lo ponga». Las pantallas ya no muestran la salida de JMC de una llegada
-- (SW v268). Esta migración hace lo mismo con lo que arma la base PARA EL TRIPULANTE
-- que llega en un vuelo, y arregla lo que pasó con Alfonso ese día:
--
--   · detect_trip_reminders   «Tu conductor sale de JMC a las …» → «Tu conductor te espera en JMC ✈️»
--   · reubicar_reserva        «te esperamos en JMC a las …» → «… cuando aterrices»
--   · acomodar_eventualidades «Tu vuelo viene tarde: te esperamos en JMC a las …» → «… cuando aterrices»
--   · admin_manual_route_set_times   correr la hora de una llegada ya no le avisa al que viene en un vuelo
--   · admin_manual_route_publish     «(sale hacia las …)» solo a tierra y reserva
--   · admin_pasar_reserva     el texto, y la REGLA: si el que entra a un combo de llegada
--                             sale del avión después de la hora del combo, el combo toma
--                             esa hora (antes el acomodo lo sacaba al minuto).
--
-- Quien NO viene en un vuelo (personal de tierra, reserva en hotel o en JMC) conserva
-- su hora en todos los avisos: para ellos esa hora es la suya, no un cálculo.
-- NO cambia: planned_start_at sigue mandando por dentro (choques, reparto, acomodo,
-- recordatorios), ni los avisos a conductores y jefes, que nombran la vuelta por esa hora.
--
-- GENERADA por scripts/_gen-0171.py desde las definiciones vigentes (scripts/_base-0171/).
-- Lo próximo que toque estas seis funciones copia DESDE 0171.
-- Deshacer: down_migrations/0171_hora_del_vuelo.down.sql (las seis como estaban).

BEGIN;

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
    SELECT r.id, r.direction, r.calculated_pickup_at,
           (coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL) AS sin_vuelo   -- 0171
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
      IF public.trip_notify(c.crew_profile, -- 0171: a quien llega en un vuelo no se le promete la hora de salida de JMC.
           CASE WHEN rec.sin_vuelo THEN 'Tu conductor sale de JMC a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️'
                ELSE 'Tu conductor te espera en JMC ✈️' END,
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
$function$;

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
    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: te movimos de vuelta 🔄' END;
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
$function$;

CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record; m record; cf record; lb record; e record;
  v_need timestamptz; v_late int; v_total int; v_start timestamptz; v_delta interval;
  v_ok boolean; v_reub jsonb; v_drv_prof uuid; v_drv_name text; v_org uuid; v_dia date; v_cut int;
  n_vuelos int := 0; n_cambios int := 0; n_sin int := 0; n_err int := 0;
  n_frenadas int := 0; v_max int; fo record; v_orgs_frenadas uuid[] := ARRAY[]::uuid[];   -- 0144
  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
  v_otro jsonb; v_de text; v_corridas boolean; v_quien text; v_rid1 uuid;   -- 0154
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
      v_otro := NULL; v_de := NULL; v_corridas := false;   -- 0154
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
        -- 0154: la primera persona de la vuelta (para las llaves de los avisos y el texto).
        SELECT rs.reservation_id INTO v_rid1 FROM public.route_stops rs WHERE rs.route_assignment_id = v.id AND rs.reservation_id IS NOT NULL
         ORDER BY rs.stop_order LIMIT 1;
        SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) INTO v_quien
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
          JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
         WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL;
        IF v_ok THEN
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            -- 0154: la llave va por conductor y persona, no por id de vuelta (al re-publicar
            -- el id cambia: a Juan le llegó «Tu vuelta cambió de hora» 3 veces el 28-oct).
            PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
              'El vuelo viene tarde: tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' ahora sale de JMC a las ' || public.hm_bog(v_start) || '.',
              '/', 'flt-drvtime:' || v_drv_prof::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
        ELSE
          -- 0154 · Su conductor no alcanza la hora nueva. Antes quedaba «para tomar» sin
          -- nadie y nadie la tomaba (Henry, Jessica y Alejandra el 28-oct: un jefe tuvo
          -- que resolver a mano). Ahora primero se corre la hora y se busca a OTRO
          -- conductor del turno, con turno abierto, que llegue a tiempo y no se le cruce
          -- (cadena_candidato, el cálculo del detector de cadena 0152). Si hay, la hace
          -- él (sigue siendo una vuelta del tablero). Si no, o si el freno de
          -- reasignaciones está puesto, queda para tomar como antes.
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
           WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
          v_corridas := true;
          IF NOT v.pool AND public.acomodo_reasignar_permitido(v.org) THEN
            v_otro := public.acomodo_otro_conductor(v.id, v.driver_profile_id);
          END IF;
        END IF;
        IF v_otro IS NOT NULL THEN
          UPDATE public.route_assignments SET driver_profile_id = (v_otro->>'dp')::uuid, updated_at = now() WHERE id = v.id;
          v_de := public.short_name(v_drv_name);
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Ya no haces una vuelta',
              'El vuelo de tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' viene tarde y a las ' || public.hm_bog(v_start)
              || ' no alcanzas: la hace ' || public.short_name(v_otro->>'name') || '.',
              '/', 'flt-reasig-de:' || v_drv_prof::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
          PERFORM public.trip_notify((v_otro->>'profile')::uuid, 'Te asignamos una llegada 🛬',
            'Sale de JMC a las ' || public.hm_bog(v_start) || coalesce(' con ' || v_quien, '') || '. El vuelo vino tarde y '
            || coalesce(v_de, 'su conductor') || ' no alcanzaba. Revísala en Ruta.',
            '/#/ruta', 'flt-reasig-a:' || (v_otro->>'profile') || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          -- A los jefes, una línea (no es un problema: ya quedó resuelto).
          PERFORM public.trip_notify(j.profile_id, 'Pasé una llegada a otro conductor 🔁',
            'Llegada de las ' || public.hm_bog(v_start) || coalesce(' (' || v_quien || ')', '') || ': el vuelo vino tarde y '
            || coalesce(v_de, 'su conductor') || ' no alcanzaba. La hace ' || public.short_name(v_otro->>'name') || '.',
            '/#/rutas', 'flt-reasig-jefe:' || j.profile_id::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'))
            FROM public.ops_alert_recipients_of(v.org) j;
          v_drv_name := v_otro->>'name';
        ELSIF NOT v_ok THEN
          -- Nadie más alcanza: queda para tomar, todos juntos, a la hora nueva.
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
        IF NOT v_corridas THEN   -- 0154: si no se corrieron ya arriba
          UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
           WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        END IF;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
                   JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          PERFORM public.sync_calculated_pickup(m.rid);
          PERFORM public.trip_notify(m.crew, 'Tu vuelo viene a otra hora ✈️',
            'Tu vuelo viene tarde: te esperamos en JMC cuando aterrices'   /* 0171: sin la hora de salida de JMC */
            || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
            '/#/viaje?r=' || m.rid::text, 'flt-time:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja más tarde: la vuelta salía de JMC a las ' || public.hm_bog(v.planned_start_at) || '.',
            jsonb_build_object('kind', 'retimed', 'dir', 'airport_to_home', 'from_at', v.planned_start_at, 'start_at', v_start, 'pickup_at', v_start,
                               'driver_name', v_drv_name, 'pooled', NOT v_ok AND v_otro IS NULL,
                               'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok AND v_otro IS NULL,
                               'reassigned_from', CASE WHEN v_otro IS NOT NULL THEN coalesce(v_de, 'su conductor') END,   -- 0154
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_manual_route_set_times(p_route uuid, p_stops jsonb DEFAULT '[]'::jsonb, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_deadline timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org      uuid := public.current_user_org();
  ra         public.route_assignments;
  s          jsonb;
  v_sid      uuid;
  v_at       timestamptz;
  v_ok       int;
  v_antes    timestamptz;     -- la hora de la vuelta antes del cambio
  v_previas  jsonb;           -- { stop_id: hora } antes del cambio
  v_dead0    timestamptz;
  v_dead     timestamptz;
  v_start    timestamptz;
  v_ultima   timestamptz;
  v_cambio   boolean := false;
  v_sello    text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n        int := 0;
  v_drv      uuid;
  v_donde    text;
  c          record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe cambia la hora de una vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  IF ra.id IS NULL OR NOT ra.pool OR ra.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Esa vuelta no es de la ruta de Julián' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status NOT IN ('draft', 'planned')
     OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: ya no se le cambia la hora' USING ERRCODE = 'P0001';
  END IF;
  IF p_stops IS NULL OR jsonb_typeof(p_stops) <> 'array' THEN p_stops := '[]'::jsonb; END IF;

  -- Lo de antes, para avisar solo a quien le cambió algo.
  SELECT coalesce(jsonb_object_agg(rs.id::text, rs.estimated_arrival_at), '{}'::jsonb) INTO v_previas
    FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;
  v_antes := ra.planned_start_at;
  v_dead0 := ra.deadline_at;

  IF ra.direction = 'home_to_airport' THEN
    FOR s IN SELECT * FROM jsonb_array_elements(p_stops) LOOP
      v_sid := nullif(s->>'stop_id', '')::uuid;
      v_at := nullif(s->>'at', '')::timestamptz;
      IF v_sid IS NULL OR v_at IS NULL THEN
        RAISE EXCEPTION 'Falta la hora de una parada' USING ERRCODE = '22023';
      END IF;
      UPDATE public.route_stops SET estimated_arrival_at = v_at WHERE id = v_sid AND route_assignment_id = ra.id;
      GET DIAGNOSTICS v_ok = ROW_COUNT;
      IF v_ok = 0 THEN RAISE EXCEPTION 'Esa parada no es de esta vuelta' USING ERRCODE = 'P0002'; END IF;
    END LOOP;
    SELECT min(rs.estimated_arrival_at), max(rs.estimated_arrival_at) INTO v_start, v_ultima
      FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;
    v_start := coalesce(v_start, ra.planned_start_at);
    v_dead := coalesce(p_deadline, ra.deadline_at);
    IF v_dead IS NOT NULL AND v_ultima IS NOT NULL AND v_dead < v_ultima THEN
      RAISE EXCEPTION '«Deben estar» (%) queda antes de la última recogida (%)', public.hm_bog(v_dead), public.hm_bog(v_ultima)
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_start IS NULL THEN RAISE EXCEPTION 'Falta la hora de salida' USING ERRCODE = '22023'; END IF;
    v_start := p_start;
    v_dead := ra.deadline_at;
  END IF;

  v_cambio := v_start IS DISTINCT FROM v_antes OR v_dead IS DISTINCT FROM v_dead0
    OR EXISTS (SELECT 1 FROM public.route_stops rs
                WHERE rs.route_assignment_id = ra.id AND rs.estimated_arrival_at IS DISTINCT FROM (v_previas->>rs.id::text)::timestamptz);
  IF NOT v_cambio THEN
    RETURN jsonb_build_object('id', ra.id, 'unchanged', true, 'start', ra.planned_start_at, 'notified', 0);
  END IF;

  UPDATE public.route_assignments SET planned_start_at = v_start, deadline_at = v_dead, updated_at = now() WHERE id = ra.id;
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  -- Los tripulantes a los que les cambió la hora (o el «Deben estar», que va en el aviso).
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at, r.reserve_place,
           (v_previas->>rs.id::text)::timestamptz IS DISTINCT FROM rs.estimated_arrival_at AS movida
      FROM public.route_stops rs
      JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    IF ra.direction = 'home_to_airport' THEN
      CONTINUE WHEN NOT c.movida AND v_dead IS NOT DISTINCT FROM v_dead0;
      IF public.trip_notify(c.crew, 'Cambió tu hora de recogida 🕒',
           'Ahora te recogemos a las ' || public.hm_bog(c.at)
             || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END || '.',
           '/#/viaje?r=' || c.id::text, 'manualhora:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
        v_n := v_n + 1;
      END IF;
    ELSE
      CONTINUE WHEN v_start IS NOT DISTINCT FROM v_antes;
      -- 0121: de reserva en un hotel o en el aeropuerto; si no, viene en un vuelo.
      v_donde := public.lugar_del_regreso(c.id);   -- 0147: también el personal de tierra
      -- 0171: a quien llega en un vuelo ya no se le dice la hora de salida de JMC:
      -- correrla no es noticia para él.
      CONTINUE WHEN v_donde IS NULL;
      IF public.trip_notify(c.crew, 'Cambió la hora de tu regreso 🕒',
           CASE WHEN v_donde IS NOT NULL THEN 'Te recogemos ' || v_donde || ' hacia las ' || public.hm_bog(v_start) || '.'
                ELSE 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || ').' END,
           '/#/viaje?r=' || c.id::text, 'manualhora:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;

  -- El conductor que la tomó (la delegada no tiene: la hace alguien de afuera).
  SELECT dp.profile_id INTO v_drv FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
  IF v_drv IS NOT NULL AND v_start IS DISTINCT FROM v_antes THEN
    PERFORM public.trip_notify(v_drv, 'Cambió la hora de una vuelta que tomaste 🕒',
      CASE WHEN ra.direction = 'home_to_airport' THEN 'La salida' ELSE 'La llegada' END
        || ' de las ' || public.hm_bog(v_antes) || ' ahora es a las ' || public.hm_bog(v_start) || '. Revísala en Ruta.',
      '/#/ruta', 'manualhora:' || ra.id::text || ':drv:' || v_drv::text || ':' || v_sello);
  ELSIF v_drv IS NOT NULL THEN
    PERFORM public.trip_notify(v_drv, 'Cambió una vuelta que tomaste 🕒',
      'Julián cambió las horas de la ' || CASE WHEN ra.direction = 'home_to_airport' THEN 'salida' ELSE 'llegada' END
        || ' de las ' || public.hm_bog(v_start) || '. Revísala en Ruta.',
      '/#/ruta', 'manualhora:' || ra.id::text || ':drv:' || v_drv::text || ':' || v_sello);
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'start', v_start, 'deadline', v_dead, 'notified', v_n,
    'driver_notified', v_drv IS NOT NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org      uuid := public.current_user_org();
  b          jsonb;
  st         jsonb;
  v_type     text;
  v_dir      public.trip_direction;
  v_ids      uuid[];
  v_sig      text;
  v_first    timestamptz;
  v_start    timestamptz;
  v_dead     timestamptz;
  v_flight   text;
  v_ra       uuid;
  v_old      record;
  v_kept     int := 0;
  v_created  int := 0;
  v_removed  int := 0;
  v_skipped  int := 0;
  v_notified int := 0;
  v_drivers  int := 0;
  v_keep     uuid[] := ARRAY[]::uuid[];
  v_busy     uuid[];
  v_used     uuid[] := ARRAY[]::uuid[];
  v_tocadas  uuid[];
  v_tablero  int := 0;
  i          int;
  v_res      record;
  v_at       timestamptz;
  v_title    text;
  v_body     text;
  v_total    int := 0;
  -- 0133: los pasajeros sin cuenta (Kriss): van en la ruta, no se les avisa.
  v_gs       jsonb;
  v_gfirst   timestamptz;
  v_gname    text;
  v_gid      uuid;
  v_grid     uuid;
  v_glat     double precision;
  v_glng     double precision;
  v_gplace   text;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica la ruta' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'Falta la ruta' USING ERRCODE = '22023';
  END IF;

  -- Reservas que ya van en una vuelta ARRANCADA de este día: no se vuelven a poner.
  SELECT coalesce(array_agg(DISTINCT rs.reservation_id), ARRAY[]::uuid[]) INTO v_busy
    FROM public.route_assignments ra JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
     AND (ra.status IN ('in_progress', 'completed')
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  FOR b IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
    v_type := CASE WHEN b->>'type' = 'lle' THEN 'lle' ELSE 'sal' END;
    v_dir := CASE WHEN v_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
    -- Solo reservas vivas de la organización y que no estén en una vuelta arrancada.
    SELECT array_agg(x.rid ORDER BY x.ord), min(x.at)
      INTO v_ids, v_first
      FROM (SELECT (s->>'reservation_id')::uuid AS rid, (s->>'at')::timestamptz AS at, o AS ord
              FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)) x
      JOIN public.reservations r ON r.id = x.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org AND r.cancelled_at IS NULL AND r.direction = v_dir
       AND NOT (x.rid = ANY (v_busy)) AND NOT (x.rid = ANY (v_used));
    -- 0133: los sin cuenta del bloque (nombre de 2 letras o más).
    SELECT jsonb_agg(s ORDER BY o), min((s->>'at')::timestamptz)
      INTO v_gs, v_gfirst
      FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)
     WHERE jsonb_typeof(s->'guest') = 'object' AND length(btrim(coalesce(s->'guest'->>'name', ''))) >= 2;
    v_skipped := v_skipped + coalesce(jsonb_array_length(b->'stops'), 0) - coalesce(cardinality(v_ids), 0) - coalesce(jsonb_array_length(v_gs), 0);
    IF coalesce(cardinality(v_ids), 0) = 0 AND v_gs IS NULL THEN CONTINUE; END IF;
    v_ids := coalesce(v_ids, ARRAY[]::uuid[]);
    v_first := least(v_first, v_gfirst);
    v_used := v_used || v_ids;
    v_total := v_total + 1;
    -- 0133: la firma también lleva a los sin cuenta (por nombre); sin ellos es la de 0125.
    v_sig := v_dir::text || ':' || coalesce((SELECT string_agg(u::text, ',' ORDER BY u::text) FROM unnest(v_ids) u), '')
          || coalesce('|g:' || (SELECT string_agg(lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')), ',' ORDER BY lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')))
                                 FROM jsonb_array_elements(v_gs) g), '');
    v_dead := nullif(b->>'deadline_at', '')::timestamptz;
    v_flight := nullif(btrim(b->>'flight'), '');
    -- La llegada sale de JMC cuando el tripulante ya bajó: aterrizaje + desembarque (0058/0099).
    v_start := CASE WHEN v_type = 'lle'
                    THEN v_first + make_interval(mins => coalesce(public.flight_deplane_min(v_flight), 15))
                    ELSE v_first END;

    -- ¿Ya estaba esta misma vuelta (las mismas personas)? Se conserva, con su conductor.
    SELECT ra.id INTO v_ra
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT coalesce(ra.auto_created, false)   -- 0143: una vuelta armada sola no es «la misma vuelta» pegada
       AND (ra.direction::text || ':' || coalesce((SELECT string_agg(rs.reservation_id::text, ',' ORDER BY rs.reservation_id::text)
                                           FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NOT NULL), '')
            || coalesce('|g:' || (SELECT string_agg(lower(rs.guest_name), ',' ORDER BY lower(rs.guest_name))
                                   FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NULL), '')) = v_sig
     LIMIT 1;
    IF v_ra IS NOT NULL THEN
      UPDATE public.route_assignments
         SET planned_start_at = v_start, deadline_at = v_dead, manual_note = nullif(btrim(b->>'note'), ''), updated_at = now()
       WHERE id = v_ra;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                            pool, organization_id, manual_day, deadline_at, manual_note)
      VALUES (NULL, NULL, v_dir, 'planned', v_start, true, v_org, p_day, v_dead, nullif(btrim(b->>'note'), ''))
      RETURNING id INTO v_ra;
      v_created := v_created + 1;
    END IF;
    v_keep := v_keep || v_ra;

    -- Las paradas, en el orden del jefe (se reescriben: orden y horas pueden cambiar).
    -- Primero se corren a números altos para no chocar con el UNIQUE del orden.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra;
    i := 0;
    FOR st IN SELECT s FROM jsonb_array_elements(b->'stops') AS t(s) LOOP
      -- 0133: un pasajero sin cuenta es una parada con nombre y lugar (sin reserva).
      IF jsonb_typeof(st->'guest') = 'object' THEN
        v_gname := nullif(regexp_replace(btrim(coalesce(st->'guest'->>'name', '')), '\s+', ' ', 'g'), '');
        CONTINUE WHEN v_gname IS NULL OR length(v_gname) < 2;
        i := i + 1;
        v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
        v_grid := NULL; v_glat := NULL; v_glng := NULL; v_gplace := NULL;
        IF coalesce(st->'guest'->>'residence_id', '') ~ '^[0-9a-fA-F-]{36}$' THEN
          SELECT re.id, re.latitude, re.longitude, re.name INTO v_grid, v_glat, v_glng, v_gplace
            FROM public.residences re WHERE re.id = (st->'guest'->>'residence_id')::uuid AND re.organization_id = v_org;
        END IF;
        v_gplace := coalesce(nullif(btrim(coalesce(st->'guest'->>'place', '')), ''), v_gplace);
        SELECT rs.id INTO v_gid FROM public.route_stops rs
         WHERE rs.route_assignment_id = v_ra AND rs.reservation_id IS NULL AND lower(rs.guest_name) = lower(v_gname) LIMIT 1;
        IF v_gid IS NOT NULL THEN
          UPDATE public.route_stops
             SET stop_order = i, estimated_arrival_at = v_at, guest_name = v_gname, guest_place = v_gplace,
                 guest_phone = nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), guest_residence_id = v_grid, guest_lat = v_glat, guest_lng = v_glng
           WHERE id = v_gid;
        ELSE
          INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at,
                                          guest_name, guest_place, guest_phone, guest_residence_id, guest_lat, guest_lng)
          VALUES (v_ra, NULL, i, v_at, v_gname, v_gplace, nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), v_grid, v_glat, v_glng);
        END IF;
        CONTINUE;
      END IF;
      CONTINUE WHEN NOT ((st->>'reservation_id')::uuid = ANY (v_ids));
      i := i + 1;
      v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
      IF EXISTS (SELECT 1 FROM public.route_stops WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid) THEN
        UPDATE public.route_stops SET stop_order = i, estimated_arrival_at = v_at
         WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid;
      ELSE
        INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES (v_ra, (st->>'reservation_id')::uuid, i, v_at);
      END IF;
    END LOOP;
    DELETE FROM public.route_stops WHERE route_assignment_id = v_ra AND stop_order > 1000;

    -- Avisarle a cada uno su hora (una vez por hora: volver a pegar sin cambios no repite).
    FOR v_res IN
      SELECT r.id, r.direction, ap.profile_id AS crew, rs.estimated_arrival_at AS at, f.flight_number
        FROM public.route_stops rs
        JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        LEFT JOIN public.flights f ON f.id = r.flight_id
       WHERE rs.route_assignment_id = v_ra
    LOOP
      IF v_res.direction = 'home_to_airport' THEN
        v_title := 'Tu recogida está lista 🚗';
        v_body := 'Te recogemos a las ' || public.hm_bog(v_res.at)
          || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END
          || '. Te avisamos quién te recoge.';
      ELSE
        v_title := 'Tu regreso está listo 🚗';
        -- 0147: de reserva en el hotel o en JMC, o de tierra, no «aterriza».
        v_body := coalesce('Te recogemos ' || public.lugar_del_regreso(v_res.id), 'Cuando aterrices te esperamos en JMC')
          -- 0171: la hora de salida solo a quien no viene en un vuelo (tierra, reserva).
          || CASE WHEN public.lugar_del_regreso(v_res.id) IS NOT NULL THEN ' (sale hacia las ' || public.hm_bog(v_start) || ')' ELSE '' END
          || '. Te avisamos quién te recoge.';
      END IF;
      IF public.trip_notify(v_res.crew, v_title, v_body, '/#/viaje?r=' || v_res.id::text,
                            'manual:' || v_res.id::text || ':' || to_char(coalesce(v_res.at, v_start) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')) THEN
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
    v_ra := NULL;
  END LOOP;

  -- Lo que Julián puso manda: esas personas salen de las vueltas del TABLERO que
  -- no han arrancado (si no, quedarían en dos carros); la que queda vacía se va.
  WITH quitadas AS (
    DELETE FROM public.route_stops rs USING public.route_assignments ra
     WHERE rs.route_assignment_id = ra.id AND (NOT ra.pool OR coalesce(ra.auto_created, false))   -- 0143: también las armadas solas
       AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  -- 0143: si una vuelta armada sola quedó vacía y ya la había tomado un conductor, se le avisa.
  PERFORM public.trip_notify(dp.profile_id, 'Cambió una vuelta que tomaste',
            'Julián cambió la vuelta de las ' || public.hm_bog(ra.planned_start_at) || '. Revisa las vueltas disponibles.',
            '/#/ruta', 'manualdrop:' || ra.id::text)
     FROM public.route_assignments ra JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
    WHERE ra.id = ANY (v_tocadas) AND coalesce(ra.auto_created, false)
      AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT coalesce(ra.auto_created, false)   -- 0143: las armadas solas no son de Julián: se quedan
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
  LOOP
    DELETE FROM public.route_assignments WHERE id = v_old.id;
    v_removed := v_removed + 1;
    IF v_old.drv_profile IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_profile, 'Cambió una vuelta que tomaste',
        'Julián cambió la vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '. Revisa las vueltas disponibles.',
        '/#/ruta', 'manualdrop:' || v_old.id::text);
    END IF;
  END LOOP;

  -- Lo que el jefe eligió a mano se aprende para la próxima vez.
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    JOIN public.auxiliar_profiles ap ON ap.id = (a->>'auxiliar_profile_id')::uuid
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();

  -- Los conductores: hay vueltas para tomar (una vez por ruta pegada).
  IF v_created > 0 THEN
    SELECT count(*) INTO v_drivers FROM (
      SELECT public.trip_notify(p.id, 'Hay vueltas para tomar',
               'Julián publicó la ruta del ' || to_char(p_day, 'DD/MM') || ': ' || v_total || ' vueltas. Toma las tuyas en Ruta.',
               '/#/ruta', 'manualpool:' || v_org::text || ':' || p_day::text || ':' || md5(array_to_string(v_keep, ',')) || ':' || p.id::text) AS ok
        FROM public.profiles p
       WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false) z
     WHERE z.ok;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('created', v_created, 'kept', v_kept, 'removed', v_removed, 'skipped', v_skipped,
                            'notified', v_notified, 'drivers', v_drivers, 'vueltas', v_total, 'from_board', v_tablero);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_pasar_reserva(p_reservation uuid, p_route uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org   uuid := public.current_user_org();
  r       record;
  ra      public.route_assignments;
  o       record;
  v_lle   boolean;
  v_eta   timestamptz;
  v_who   text;
  v_lugar text;
  v_drv   uuid;  v_drv_name text;
  v_from  timestamptz; v_quedo_vacia boolean := false;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_pax   int;
  v_sale  timestamptz; v_corrio boolean := false; k record;   -- 0171
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe pasa a alguien de vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT res.id, res.direction, res.cancelled_at, ap.profile_id AS crew, pr.full_name AS nombre,
         rz.name AS conjunto, res.pickup_address,
         res.flight_code, res.required_arrival_at,   -- 0171
         (coalesce(res.ground_ops, false) OR res.reserve_place IS NOT NULL) AS sin_vuelo
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    LEFT JOIN public.residences rz   ON rz.id = res.residence_id
   WHERE res.id = p_reservation AND pr.organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Ese pedido no existe' USING ERRCODE = 'P0002'; END IF;
  IF r.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Ese pedido está cancelado' USING ERRCODE = 'P0001'; END IF;
  v_lle := r.direction = 'airport_to_home';
  v_who := public.short_name(r.nombre);
  v_lugar := coalesce(r.conjunto, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''));

  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  IF ra.id IS NULL OR NOT (coalesce(ra.organization_id = v_org, false) OR EXISTS (
       SELECT 1 FROM public.route_stops rs JOIN public.reservations y ON y.id = rs.reservation_id
       JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
        WHERE rs.route_assignment_id = ra.id AND yp.organization_id = v_org)) THEN
    RAISE EXCEPTION 'Esa vuelta no existe' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status NOT IN ('draft', 'planned')
     OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: no se le suma nadie' USING ERRCODE = 'P0001';
  END IF;
  IF ra.direction IS DISTINCT FROM r.direction THEN
    RAISE EXCEPTION '%', CASE WHEN v_lle THEN 'Es una llegada y esa vuelta es de salidas' ELSE 'Es una salida y esa vuelta es de llegadas' END USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.reservation_id = p_reservation) THEN
    RETURN jsonb_build_object('id', ra.id, 'unchanged', true);
  END IF;

  -- Sale de donde iba (pendiente, o «no se presentó» que el jefe rescata).
  FOR o IN
    SELECT rs.id AS stop_id, rs.estimated_arrival_at AS eta, x.id AS ra_id, x.planned_start_at, dp.profile_id AS drv_prof
      FROM public.route_stops rs
      JOIN public.route_assignments x ON x.id = rs.route_assignment_id
      LEFT JOIN public.driver_profiles dp ON dp.id = x.driver_profile_id
     WHERE rs.reservation_id = p_reservation AND rs.status IN ('pending', 'no_show')
       AND x.status IN ('draft', 'planned', 'in_progress')
     ORDER BY x.planned_start_at DESC
  LOOP
    IF v_from IS NULL THEN v_from := o.planned_start_at; IF NOT v_lle THEN v_eta := o.eta; END IF; END IF;
    DELETE FROM public.route_stops WHERE id = o.stop_id;
    DELETE FROM public.route_assignments z
     WHERE z.id = o.ra_id AND z.status IN ('draft', 'planned')
       AND NOT EXISTS (SELECT 1 FROM public.route_stops y WHERE y.route_assignment_id = z.id);
    IF FOUND THEN v_quedo_vacia := true;
    ELSE
      -- Los que quedan, en orden corrido (1, 2, 3…).
      UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = o.ra_id;
      UPDATE public.route_stops t SET stop_order = n.k
        FROM (SELECT id, row_number() OVER (ORDER BY stop_order) AS k FROM public.route_stops WHERE route_assignment_id = o.ra_id) n
       WHERE t.id = n.id;
      PERFORM public.route_sync_assigned(o.ra_id);
    END IF;
    IF o.drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(o.drv_prof, 'Cambió un traslado de tu ruta',
        v_who || ' ya no va en tu vuelta de las ' || public.hm_bog(o.planned_start_at) || ': coordinación la pasó a otra.',
        '/', 'pasar-out:' || p_reservation::text || ':' || o.ra_id::text || ':' || v_sello);
    END IF;
  END LOOP;

  -- Entra en la que el jefe eligió.
  IF v_lle THEN
    SELECT max(x.estimated_arrival_at) + interval '10 minutes' INTO v_eta FROM public.route_stops x WHERE x.route_assignment_id = ra.id;
  END IF;
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
  VALUES (ra.id, p_reservation, (SELECT coalesce(max(x.stop_order), 0) + 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id), v_eta);
  -- 0171 (17-nov-2026, Alfonso): en una llegada el carro sale de JMC cuando ya salió
  -- el ÚLTIMO. Si el que entra sale del avión después de la hora del combo, el combo
  -- toma esa hora. Antes quedaba con la hora vieja y el acomodo lo sacaba al minuto
  -- («su vuelta salía de JMC a las…») y le armaba una vuelta aparte. Misma cuenta del
  -- acomodo: aterrizaje real o pedido + desembarque, al múltiplo de 5 de arriba.
  IF v_lle THEN
    v_sale := public.reub_arriba5(coalesce(public.reub_baja(v_org, r.flight_code, r.required_arrival_at), r.required_arrival_at)
      + make_interval(mins => CASE WHEN r.sin_vuelo THEN 0 ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END));
    IF v_sale IS NOT NULL AND v_sale > ra.planned_start_at THEN
      UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + (v_sale - ra.planned_start_at)
       WHERE route_assignment_id = ra.id AND estimated_arrival_at IS NOT NULL;
      UPDATE public.route_assignments SET planned_start_at = v_sale WHERE id = ra.id;
      v_corrio := true;
    END IF;
  END IF;
  IF NOT v_lle THEN
    -- Salida: el orden es el de las horas de recogida (quien no tiene hora, al final).
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = ra.id;
    UPDATE public.route_stops t SET stop_order = n.k
      FROM (SELECT id, row_number() OVER (ORDER BY estimated_arrival_at NULLS LAST, stop_order) AS k FROM public.route_stops WHERE route_assignment_id = ra.id) n
     WHERE t.id = n.id;
    IF v_eta IS NOT NULL THEN
      UPDATE public.route_assignments SET planned_start_at = least(planned_start_at, v_eta) WHERE id = ra.id;
    END IF;
  END IF;
  UPDATE public.route_assignments SET updated_at = now() WHERE id = ra.id;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route;

  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(p_reservation);
  -- 0171: si el combo se corrió, los demás quedan con su hora nueva; a los que no
  -- vienen en un vuelo (tierra, reserva) se les avisa, porque su hora sí es esa.
  IF v_corrio THEN
    FOR k IN
      SELECT y.id, ya.profile_id AS crew, public.lugar_del_regreso(y.id) AS donde
        FROM public.route_stops rs JOIN public.reservations y ON y.id = rs.reservation_id
        JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id
       WHERE rs.route_assignment_id = ra.id AND y.id <> p_reservation AND y.cancelled_at IS NULL
    LOOP
      PERFORM public.sync_calculated_pickup(k.id);
      IF k.donde IS NOT NULL THEN
        PERFORM public.trip_notify(k.crew, 'Cambió la hora de tu regreso 🕒',
          'Te recogemos ' || k.donde || ' hacia las ' || public.hm_bog(ra.planned_start_at) || '.',
          '/#/viaje?r=' || k.id::text, 'pasar-hora:' || ra.id::text || ':' || k.id::text || ':' || v_sello);
      END IF;
    END LOOP;
  END IF;

  SELECT dp.profile_id, pp.full_name INTO v_drv, v_drv_name
    FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = ra.driver_profile_id;
  SELECT count(*) INTO v_pax FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
   WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL);

  PERFORM public.trip_notify(r.crew, 'Te movimos de vuelta 🔄',
    CASE WHEN v_lle AND NOT r.sin_vuelo THEN 'Te esperamos en JMC cuando aterrices'   -- 0171: sin la hora de salida de JMC
         WHEN v_lle THEN 'Te esperamos ' || coalesce(public.lugar_del_regreso(p_reservation), 'en JMC') || ' a las ' || public.hm_bog(ra.planned_start_at)
         ELSE 'Te recogemos' || coalesce(' a las ' || public.hm_bog(v_eta), '') END
    || CASE WHEN ra.delegated_at IS NOT NULL THEN coalesce(', te lleva ' || nullif(btrim(ra.delegate_name), ''), '') || '.'
            WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || public.short_name(v_drv_name) || '.'
            ELSE '. Te avisamos quién te recoge.' END,
    '/#/viaje?r=' || p_reservation::text, 'pasar-in:' || p_reservation::text || ':' || ra.id::text || ':' || v_sello);
  IF v_drv IS NOT NULL THEN
    PERFORM public.trip_notify(v_drv, 'Se sumó alguien a tu vuelta',
      v_who || ' va en tu vuelta de las ' || public.hm_bog(ra.planned_start_at)
      || CASE WHEN v_lle THEN coalesce(': lo dejas en ' || v_lugar, '') ELSE coalesce(': recogida ' || public.hm_bog(v_eta), '') || coalesce(' en ' || v_lugar, '') END || '.',
      '/', 'pasar-drv:' || p_reservation::text || ':' || ra.id::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'start_at', ra.planned_start_at, 'pickup_at', v_eta, 'from_at', v_from,
    'driver_name', v_drv_name, 'pax', v_pax, 'removed_route', v_quedo_vacia, 'direction', r.direction);
END;
$function$;

COMMIT;
