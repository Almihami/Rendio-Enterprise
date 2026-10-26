-- =============================================================================
-- Migration 0135 — Las eventualidades se acomodan solas, en el mejor sitio
-- La dueña (26-oct-2026): «necesito que las eventualidades todas, las que
-- lleguen y las alertas de los vuelos se ajusten a donde puedan caber de manera
-- idónea, no chambona» y «más que tomes decisiones aquí, es que el sistema tome
-- las decisiones cuando le llega una eventualidad».
--
-- 0134 ya reubicaba al cambiar de vuelo, pero solo miraba dos puestos (con su
-- vecina o de primera) y, si no, armaba una vuelta nueva aunque su conductor
-- pudiera correrse. Los pedidos con el día publicado se quedaban «sin carro»
-- hasta que un jefe los ubicara, y los retrasos de Flightradar24 solo avisaban.
--
-- QUÉ HACE
--   1. Tiempos y conductores, sin mapa en el servidor:
--      · reub_leg: minutos de un punto a otro (lo MEDIDO por 0116 si hay 3 o más
--        tramos buenos; si no, la cuenta del tablero sin mapa);
--      · reub_extremos: dónde y cuándo empieza y termina una vuelta;
--      · reub_conductor_libre: el conductor no se cruza con sus otras vueltas y
--        alcanza a llegar de una a otra (tiempo de vuelta en JMC incluido);
--      · reub_mismo_turno: la hora nueva cae dentro de lo que ya trabaja ese día
--        (no se le corre una vuelta a una hora en la que no está).
--   2. reubicar_reserva(reserva, lista_en_jmc, motivo) — reemplaza la de 0134.
--      Decide, en este orden:
--        a) otra vuelta donde entre casi sin desvío (≤ 15 «puntos»: minutos de
--           desvío + media espera, con conductor; su sector ayuda): se junta y
--           su vuelta vieja se quita (un viaje menos);
--        b) iba SOLA y su conductor alcanza y está de turno a la hora nueva: su
--           misma vuelta se corre de hora (mismo conductor);
--        c) la mejor otra vuelta donde entre SIN mover a nadie: salida de
--           primera, entre dos recogidas si hay hueco, de última si los demás
--           igual llegan a su presentación, o con alguien de su conjunto;
--           llegada en la que sale de JMC cuando ya bajó (≤ 15 min de espera);
--        d) vuelta NUEVA para tomar (como en 0134).
--      A los que ya van NUNCA se les mueve la hora de recogida.
--   3. auxiliar_change_flight (copia de 0134): la nota del rastro sale de
--      reub_nota (incluye «se corrió su vuelta»).
--   4. Pidió con el día YA publicado: al pedir, entra solo (trigger AFTER INSERT
--      en reservations; si algo falla, el pedido se guarda igual).
--   5. acomodar_eventualidades(), cada 5 min (pg_cron):
--      · LLEGADAS cuyo vuelo (Flightradar24) baja después de que su vuelta sale
--        de JMC: si vienen tarde TODOS los de la vuelta, la vuelta entera se
--        corre (mismo conductor si alcanza; si no, queda para tomar, juntos); si
--        solo algunos, esos se reubican;
--      · cambios de vuelo que quedaron esperando a Coordinación (antes de 0134):
--        se aplica el último que pidió y se reubica;
--      · «X no tiene carro» abierta: se reubica.
--      Cada decisión deja su rastro en Eventualidades: RESUELTA con lo que pasó,
--      o ABIERTA (y suena a los jefes) si quedó muy encima o venía de una
--      delegada.
-- Los scripts que crean reservas a propósito pueden apagar el paso 4 con
--   SELECT set_config('rendio.no_acomodar', 'on', true);
-- Necesita 0134. Idempotente. Down: down_migrations/0135_acomodar_eventualidades.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1a. Minutos de manejo entre dos puntos. Mismo conjunto o JMC→JMC = 0.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_leg(a_res uuid, a_lat double precision, a_lng double precision, a_air boolean,
                                           b_res uuid, b_lat double precision, b_lng double precision, b_air boolean)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v numeric; tf numeric; af numeric; km double precision; v_kind text;
BEGIN
  IF a_air AND b_air THEN RETURN 0; END IF;
  IF NOT a_air AND NOT b_air AND a_res IS NOT NULL AND a_res = b_res THEN RETURN 0; END IF;
  v_kind := CASE WHEN b_air THEN 'casa_aeropuerto' WHEN a_air THEN 'aeropuerto_casa' ELSE 'casa_casa' END;
  -- Lo medido (0116): de ese conjunto al aeropuerto, del aeropuerto a ese conjunto, o entre esos dos.
  IF (v_kind = 'casa_aeropuerto' AND a_res IS NOT NULL) OR (v_kind = 'aeropuerto_casa' AND b_res IS NOT NULL)
     OR (v_kind = 'casa_casa' AND a_res IS NOT NULL AND b_res IS NOT NULL) THEN
    SELECT CASE WHEN count(*) >= 3 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY z.minutes) END INTO v
      FROM (SELECT l.minutes FROM public.route_trip_legs l
             WHERE l.kind = v_kind AND l.quality = 'ok' AND l.started_at > now() - interval '60 days'
               AND (v_kind = 'aeropuerto_casa' OR l.from_residence_id = a_res)
               AND (v_kind = 'casa_aeropuerto' OR l.to_residence_id = b_res)
             ORDER BY l.started_at DESC LIMIT 20) z;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  -- La cuenta del tablero sin mapa (rtHaversineMin): km × 1,4 a 30 km/h, mínimo 2.
  SELECT route_traffic_factor, route_airport_factor INTO tf, af FROM public.app_settings WHERE id = 'singleton';
  km := public.tramo_km(a_lat, a_lng, b_lat, b_lng);
  IF km IS NULL THEN RETURN 15; END IF;   -- sin coordenadas: un tramo prudente, nunca cero
  RETURN greatest(2, km * 1.4 / 30 * 60) * coalesce(tf, 1.25) * CASE WHEN a_air OR b_air THEN coalesce(af, 1) ELSE 1 END;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1b. Dónde y cuándo EMPIEZA y TERMINA una vuelta. Salida: de la primera
--     recogida a JMC; llegada: de JMC a la última casa.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_extremos(p_ra uuid,
  OUT ini_at timestamptz, OUT ini_res uuid, OUT ini_lat double precision, OUT ini_lng double precision, OUT ini_air boolean,
  OUT fin_at timestamptz, OUT fin_res uuid, OUT fin_lat double precision, OUT fin_lng double precision, OUT fin_air boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dir public.trip_direction; v_start timestamptz; v_org uuid; s record;
  v_srv int; v_ap_lat double precision; v_ap_lng double precision;
  t timestamptz; pr uuid; pla double precision; plo double precision; pair boolean;
BEGIN
  SELECT ra.direction, ra.planned_start_at,
         coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                                         JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
                                        WHERE x.route_assignment_id = ra.id LIMIT 1))
    INTO v_dir, v_start, v_org FROM public.route_assignments ra WHERE ra.id = p_ra;
  IF v_dir IS NULL THEN RETURN; END IF;
  SELECT route_service_min INTO v_srv FROM public.app_settings WHERE id = 'singleton';
  v_srv := coalesce(v_srv, 3);
  SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng FROM public.airports a WHERE a.organization_id = v_org ORDER BY a.created_at LIMIT 1;
  v_ap_lat := coalesce(v_ap_lat, 6.1715); v_ap_lng := coalesce(v_ap_lng, -75.4270);
  IF v_dir = 'home_to_airport' THEN
    FOR s IN SELECT x.estimated_arrival_at AS eta, coalesce(y.residence_id, x.guest_residence_id) AS res,
                    coalesce(y.pickup_latitude, x.guest_lat) AS lat, coalesce(y.pickup_longitude, x.guest_lng) AS lng
               FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
              WHERE x.route_assignment_id = p_ra AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
              ORDER BY x.stop_order
    LOOP
      IF ini_at IS NULL THEN ini_at := coalesce(s.eta, v_start); ini_res := s.res; ini_lat := s.lat; ini_lng := s.lng; ini_air := false; END IF;
      t := coalesce(s.eta, v_start); pr := s.res; pla := s.lat; plo := s.lng;
    END LOOP;
    IF t IS NULL THEN RETURN; END IF;
    fin_at := t + make_interval(mins => ceil(v_srv + public.reub_leg(pr, pla, plo, false, NULL, v_ap_lat, v_ap_lng, true))::int);
    fin_lat := v_ap_lat; fin_lng := v_ap_lng; fin_air := true;
  ELSE
    ini_at := v_start; ini_lat := v_ap_lat; ini_lng := v_ap_lng; ini_air := true;
    t := v_start; pla := v_ap_lat; plo := v_ap_lng; pair := true;
    FOR s IN SELECT coalesce(y.residence_id, x.guest_residence_id) AS res,
                    coalesce(y.pickup_latitude, x.guest_lat) AS lat, coalesce(y.pickup_longitude, x.guest_lng) AS lng
               FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
              WHERE x.route_assignment_id = p_ra AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
              ORDER BY x.stop_order
    LOOP
      t := t + make_interval(mins => ceil(v_srv + public.reub_leg(pr, pla, plo, pair, s.res, s.lat, s.lng, false))::int);
      pr := s.res; pla := s.lat; plo := s.lng; pair := false;
    END LOOP;
    fin_at := t; fin_res := pr; fin_lat := pla; fin_lng := plo; fin_air := pair;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1c. ¿El conductor puede hacer una vuelta de (ini) a (fin) sin cruzarse con sus
--     otras vueltas y alcanzando a llegar de una a otra? Tras una salida queda
--     en JMC + route_turnaround_min; tras una llegada, en la última casa (+2).
--     4 min de tolerancia (redondeos). p_skip / p_skip2: vueltas que no cuentan
--     (la que se está moviendo, la que se va a quitar).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_conductor_libre(p_drv uuid, p_skip uuid, p_skip2 uuid,
  p_ini_at timestamptz, p_ini_res uuid, p_ini_lat double precision, p_ini_lng double precision, p_ini_air boolean,
  p_fin_at timestamptz, p_fin_res uuid, p_fin_lat double precision, p_fin_lng double precision, p_fin_air boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE o record; e record; v_turn int;
BEGIN
  IF p_drv IS NULL THEN RETURN true; END IF;
  SELECT route_turnaround_min INTO v_turn FROM public.app_settings WHERE id = 'singleton';
  v_turn := coalesce(v_turn, 8);
  FOR o IN SELECT ra.id FROM public.route_assignments ra
            WHERE ra.driver_profile_id = p_drv AND ra.id IS DISTINCT FROM p_skip AND ra.id IS DISTINCT FROM p_skip2
              AND ra.status IN ('planned', 'in_progress')
              AND ra.planned_start_at BETWEEN p_ini_at - interval '12 hours' AND p_fin_at + interval '12 hours'
  LOOP
    SELECT * INTO e FROM public.reub_extremos(o.id);
    CONTINUE WHEN e.ini_at IS NULL OR e.fin_at IS NULL;
    IF e.ini_at < p_fin_at AND p_ini_at < e.fin_at THEN RETURN false; END IF;          -- se cruzan
    IF e.fin_at <= p_ini_at THEN                                                          -- esa va antes
      IF e.fin_at + make_interval(mins => CASE WHEN e.fin_air THEN v_turn ELSE 2 END)
           + make_interval(mins => ceil(public.reub_leg(e.fin_res, e.fin_lat, e.fin_lng, e.fin_air, p_ini_res, p_ini_lat, p_ini_lng, p_ini_air))::int)
         > p_ini_at + interval '4 minutes' THEN RETURN false; END IF;
    ELSE                                                                                  -- esa va después
      IF p_fin_at + make_interval(mins => CASE WHEN p_fin_air THEN v_turn ELSE 2 END)
           + make_interval(mins => ceil(public.reub_leg(p_fin_res, p_fin_lat, p_fin_lng, p_fin_air, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air))::int)
         > e.ini_at + interval '4 minutes' THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1d. ¿La hora nueva cae dentro de lo que ese conductor ya trabaja? Desde 60 min
--     antes de su primera vuelta hasta 60 min después de que termina la última
--     (contando la que se mueve, a su hora vieja). Sin conductor (para tomar): sí.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_mismo_turno(p_drv uuid, p_skip uuid, p_old_ini timestamptz, p_old_fin timestamptz,
                                                   p_ini timestamptz, p_fin timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_lo timestamptz := p_old_ini; v_hi timestamptz := p_old_fin; o record; e record;
BEGIN
  IF p_drv IS NULL THEN RETURN true; END IF;
  FOR o IN SELECT ra.id FROM public.route_assignments ra
            WHERE ra.driver_profile_id = p_drv AND ra.id IS DISTINCT FROM p_skip AND ra.status IN ('planned', 'in_progress', 'completed')
              AND ra.planned_start_at BETWEEN p_old_ini - interval '10 hours' AND p_old_fin + interval '10 hours'
  LOOP
    SELECT * INTO e FROM public.reub_extremos(o.id);
    v_lo := least(v_lo, e.ini_at); v_hi := greatest(v_hi, e.fin_at);
  END LOOP;
  RETURN p_ini >= v_lo - interval '60 minutes' AND p_fin <= v_hi + interval '60 minutes';
END;
$$;

-- Hora «de cita»: hacia abajo a múltiplo de 5 (la recogida, como el tablero) /
-- hacia arriba (la salida de JMC: nunca antes de que haya bajado).
CREATE OR REPLACE FUNCTION public.reub_abajo5(p timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('minute', p) - make_interval(mins => (extract(minute FROM p)::int % 5)) $$;
CREATE OR REPLACE FUNCTION public.reub_arriba5(p timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p = date_trunc('minute', p) AND extract(minute FROM p)::int % 5 = 0 THEN p
              ELSE date_trunc('minute', p) - make_interval(mins => (extract(minute FROM p)::int % 5)) + interval '5 minutes' END $$;

-- -----------------------------------------------------------------------------
-- 1e. Cuándo baja un vuelo de llegada según Flightradar24 (aterrizó, o la
--     estimada si hay dato en vivo). NULL si no hay dato, si está cancelado o
--     desviado, o si la hora no cuadra con la reserva (otro vuelo con el mismo
--     número): fuera de −3 h / +8 h de lo programado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_baja(p_org uuid, p_code text, p_ref timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b FROM (
    SELECT coalesce(fs.actual_at, CASE WHEN fs.delay_min IS NOT NULL
                                       THEN coalesce(fs.estimated_at, fs.sched_at + make_interval(mins => fs.delay_min)) END) AS b
      FROM public.flight_statuses fs
     WHERE fs.organization_id = p_org AND fs.flight_code = p_code AND fs.direction = 'airport_to_home'
       AND fs.flight_date = (p_ref AT TIME ZONE 'America/Bogota')::date
       AND fs.status NOT IN ('cancelled', 'diverted')
     ORDER BY fs.fetched_at DESC LIMIT 1) z
   WHERE z.b BETWEEN p_ref - interval '3 hours' AND p_ref + interval '8 hours';
$$;

-- -----------------------------------------------------------------------------
-- 1f. Las vueltas donde podría entrar (como 0134) + nunca la de un privado, y
--     la de reserva en un hotel solo con los de ese mismo hotel.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_candidatas(p_res uuid, p_cap int)
RETURNS TABLE (ra_id uuid, start_at timestamptz, pool boolean, drv uuid, drv_prof uuid, drv_name text,
               n int, cap int, dl timestamptz, sector_igual boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT res.id, res.direction, res.required_arrival_at AS t, pr.organization_id AS org, rz.sector, res.reserve_place AS place
      FROM public.reservations res
      JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.residences rz ON rz.id = res.residence_id
     WHERE res.id = p_res)
  SELECT z.* FROM (
    SELECT ra.id, ra.planned_start_at, ra.pool, ra.driver_profile_id, dp.profile_id, pp.full_name,
           (SELECT count(*) FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
             WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL))::int AS n,
           coalesce(v.capacity, pv.capacity, p_cap)::int AS cap,
           coalesce(ra.deadline_at, (SELECT min(y.required_arrival_at) FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                                      WHERE x.route_assignment_id = ra.id AND y.cancelled_at IS NULL)) AS dl,
           EXISTS (SELECT 1 FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
                     JOIN public.residences yz ON yz.id = coalesce(y.residence_id, x.guest_residence_id)
                    WHERE x.route_assignment_id = ra.id AND me.sector IS NOT NULL AND yz.sector = me.sector) AS sector_igual
      FROM me
      JOIN public.route_assignments ra ON ra.direction = me.direction
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pp        ON pp.id = dp.profile_id
      LEFT JOIN public.vehicles v         ON v.id = ra.vehicle_id
      LEFT JOIN public.vehicles pv        ON pv.id = ra.plan_vehicle_id
     WHERE ra.status = 'planned' AND ra.delegated_at IS NULL
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool)
       AND ra.planned_start_at BETWEEN me.t - interval '6 hours' AND me.t + interval '6 hours'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id)
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.reservation_id = me.id)
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                        WHERE x.route_assignment_id = ra.id AND y.service_level = 'private')
       -- De reserva en un hotel (0121) la recogen / la dejan en el hotel: solo con
       -- gente del MISMO hotel; y quien va de JMC, nunca con alguien de hotel.
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
                        WHERE x.route_assignment_id = ra.id
                          AND coalesce(CASE WHEN y.reserve_place IN ('rio_verde', 'movich') THEN y.reserve_place END, '')
                              <> coalesce(CASE WHEN me.place IN ('rio_verde', 'movich') THEN me.place END, ''))
       AND (ra.organization_id = me.org OR EXISTS (
             SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
               JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
              WHERE x.route_assignment_id = ra.id AND yp.organization_id = me.org))
  ) z
  WHERE z.n < z.cap;
$$;

-- -----------------------------------------------------------------------------
-- 2. Reubicar una reserva (ya con su hora nueva).
--    p_ready: cuándo queda lista en JMC una LLEGADA (si no se da: aterrizaje +
--    desembarque). p_motivo: 'cambio' (cambió de vuelo) · 'vuelo' (Flightradar24)
--    · 'pedido' (pidió con el día publicado).
--    Devuelve { kind: 'joined'|'retimed'|'new'|'unplanned'|'none', dir, ra_id,
--    start_at, pickup_at, from_at, driver_name, removed, was_delegated, tight }.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reubicar_reserva(uuid);
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
       AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date = (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date
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
    PERFORM public.trip_notify(r.crew, 'Te armamos una vuelta 🚗',
      v_pre || CASE WHEN NOT v_lle
           THEN 'te recogemos a las ' || public.hm_bog(v_eta) || ' para estar en JMC a las ' || public.hm_bog(v_P)
           ELSE 'te esperamos en JMC a las ' || public.hm_bog(v_start) END
      || '. Te avisamos quién te recoge.',
      '/#/viaje?r=' || p_res::text, 'reub-new:' || p_res::text || ':' || v_ra::text);
    PERFORM public.trip_notify(p.id, 'Hay una vuelta para tomar',
      CASE WHEN NOT v_lle THEN 'Salida' ELSE 'Llegada' END || ' de las ' || public.hm_bog(v_start)
      || ' (' || v_who || coalesce(', ' || v_lugar, '') || '): '
      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado' ELSE 'cambió de vuelo' END
      || ' y no cabía en otra. Tómala en Ruta si puedes.',
      '/#/ruta', 'reub-pool:' || v_ra::text || ':' || p.id::text)
      FROM public.profiles p
     WHERE p.organization_id = r.org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('kind', v_kind, 'dir', r.direction, 'ra_id', v_ra, 'start_at', v_start, 'from_at', v_from,
                            'pickup_at', CASE WHEN NOT v_lle THEN v_eta ELSE v_start END,
                            'driver_name', v_drv_name, 'removed', v_removed, 'was_delegated', v_deleg,
                            -- Muy encima: menos de 45 min para la recogida.
                            'tight', coalesce(CASE WHEN NOT v_lle THEN v_eta ELSE v_start END < now() + interval '45 minutes', false));
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. La frase de lo que decidió el sistema (para resolution_notes).
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
    ELSE 'Se actualizó la reserva: ese día todavía no tiene ruta publicada (entra al publicarla).' END
    || CASE WHEN coalesce((p->>'was_delegated')::boolean, false) THEN ' OJO: estaba en una vuelta DELEGADA: avísale a quien la iba a hacer.' ELSE '' END
    || CASE WHEN coalesce((p->>'tight')::boolean, false) THEN ' OJO: queda muy encima de la hora: revisa que alguien la tome.' ELSE '' END;
$$;

-- El rastro en Eventualidades de una decisión automática: RESUELTA con lo que
-- pasó, o ABIERTA (y suena a los jefes) si quedó muy encima o venía de una
-- vuelta delegada.
CREATE OR REPLACE FUNCTION public.reub_rastro(p_res uuid, p_cat text, p_desc text, p_reub jsonb, p_dedupe text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid; v_inc uuid; v_abierta boolean;
BEGIN
  SELECT pr.organization_id INTO v_org FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    JOIN public.profiles pr ON pr.id = ap.profile_id WHERE r.id = p_res;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  -- La misma decisión no se anota dos veces.
  IF p_dedupe IS NOT NULL AND EXISTS (SELECT 1 FROM public.incidents WHERE dedupe_key = p_dedupe) THEN RETURN NULL; END IF;
  v_abierta := coalesce((p_reub->>'tight')::boolean, false) OR coalesce((p_reub->>'was_delegated')::boolean, false);
  INSERT INTO public.incidents (organization_id, reporter_id, reservation_id, category, severity, status,
                                description, scope, source, details, dedupe_key, occurred_at, resolved_at, resolution_notes)
  VALUES (v_org, auth.uid(), p_res, p_cat::public.incident_category,
          (CASE WHEN v_abierta THEN 'high' ELSE 'low' END)::public.incident_severity,
          (CASE WHEN v_abierta THEN 'open' ELSE 'resolved' END)::public.incident_status,
          p_desc, 'operacion', 'system', p_details || jsonb_build_object('auto', true, 'reubicada', p_reub), p_dedupe,
          now(), CASE WHEN v_abierta THEN NULL ELSE now() END, public.reub_nota(p_reub))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inc;
  IF v_inc IS NOT NULL AND v_abierta THEN PERFORM public.enqueue_incident_alert(v_inc); END IF;
  RETURN v_inc;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Pidió con el día YA publicado: entra solo, al pedir. Nunca tumba el pedido.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_reservations_acomodar()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v jsonb;
BEGIN
  IF coalesce(current_setting('rendio.no_acomodar', true), '') = 'on' THEN RETURN NULL; END IF;
  IF NEW.cancelled_at IS NOT NULL OR coalesce(NEW.service_level::text, 'shared') = 'private'
     OR NEW.required_arrival_at <= now() + interval '30 minutes' THEN RETURN NULL; END IF;
  -- Ya va en una vuelta publicada (la metió quien la creó): nada que hacer.
  IF EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
              WHERE rs.reservation_id = NEW.id AND ra.status IN ('planned', 'in_progress')) THEN RETURN NULL; END IF;
  BEGIN
    v := public.reubicar_reserva(NEW.id, NULL, 'pedido');
    IF v->>'kind' IN ('joined', 'new', 'retimed') THEN
      PERFORM public.reub_rastro(NEW.id, 'late_booking',
        'Pidió su traslado (' || CASE WHEN NEW.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END || ' '
        || to_char(NEW.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') || ') con el día ya publicado.',
        v, 'lateauto:' || NEW.id::text, jsonb_build_object('kind', 'late_booking_auto'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'acomodar al pedir (%): %', NEW.id, SQLERRM;   -- el pedido se guarda igual
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS tr_reservations_acomodar ON public.reservations;
CREATE TRIGGER tr_reservations_acomodar AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservations_acomodar();

-- -----------------------------------------------------------------------------
-- 5. Cada 5 minutos el sistema revisa y decide.
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
          PERFORM public.trip_notify(p.id, 'Hay una vuelta para tomar',
            'Llegada de las ' || public.hm_bog(v_start) || ': el vuelo viene tarde y su conductor no alcanza. Tómala en Ruta si puedes.',
            '/#/ruta', 'flt-pool:' || v.id::text || ':' || p.id::text)
            FROM public.profiles p WHERE p.organization_id = v.org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
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
  FOR lb IN
    SELECT DISTINCT ON (ii.reservation_id) ii.id, ii.reservation_id FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
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

  RETURN jsonb_build_object('vuelos', n_vuelos, 'cambios', n_cambios, 'sin_carro', n_sin, 'errores', n_err);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. auxiliar_change_flight: copia de 0134; solo cambia la nota del rastro.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auxiliar_change_flight(
  p_reservation_id uuid,
  p_flight text,
  p_when timestamptz,
  p_reserve_place text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux        uuid := public.current_auxiliar_id();
  r            public.reservations%ROWTYPE;
  v_raw        text;
  v_old_flight text;
  v_flight     text;
  v_place      text;
  v_lead       int;
  v_pub        boolean;
  v_priv       boolean;
  v_ops        boolean;
  v_regreso    boolean;
  v_user       text;
  v_notes      text;
  v_inc        uuid;
  v_n          int;
  v_desc       text;
  v_reub       jsonb;     -- 0134: dónde quedó
  v_abierta    boolean;   -- 0134: hace falta un jefe
  v_nota       text;
BEGIN
  IF auth.uid() IS NULL OR v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo el tripulante dueño del traslado puede cambiar su vuelo' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.reservations
   WHERE id = p_reservation_id AND auxiliar_profile_id = v_aux
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese traslado no es tuyo' USING ERRCODE = '42501';
  END IF;
  IF r.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ese traslado está cancelado' USING ERRCODE = '22023';
  END IF;

  v_raw := COALESCE(r.status_h2a::text, r.status_a2h::text);
  IF v_raw IN ('en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show', 'cancelled') THEN
    RAISE EXCEPTION 'Tu traslado ya está en curso: escríbele a Coordinación' USING ERRCODE = '22023';
  END IF;

  IF p_when IS NULL THEN
    RAISE EXCEPTION 'Falta la hora nueva' USING ERRCODE = '22023';
  END IF;
  IF p_when <= now() THEN
    RAISE EXCEPTION 'Esa hora ya pasó' USING ERRCODE = '22023';
  END IF;
  IF p_when > now() + interval '14 days' THEN
    RAISE EXCEPTION 'Solo puedes cambiarlo hasta 14 días adelante' USING ERRCODE = '22023';
  END IF;

  -- 0121: el lugar de la reserva. NULL = como estaba; 'vuelo' o '' = ahora va
  -- en un vuelo; o uno de los tres lugares.
  v_place := CASE
    WHEN p_reserve_place IS NULL THEN r.reserve_place
    WHEN btrim(p_reserve_place) IN ('', 'vuelo') THEN NULL
    ELSE btrim(p_reserve_place) END;
  IF v_place IS NOT NULL AND v_place NOT IN ('rio_verde', 'movich', 'aero') THEN
    RAISE EXCEPTION 'Ese lugar de reserva no existe' USING ERRCODE = '22023';
  END IF;
  IF v_place IS NOT NULL AND coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Un traslado de trabajo en tierra no va de reserva' USING ERRCODE = '22023';
  END IF;

  -- El vuelo: sin espacios ni guion, en mayúscula. Mismo formato que escribe
  -- el pedido («Vuelo AV9412. »), y que notes_without_flight sabe quitar.
  -- De reserva no hay vuelo: lo que venga se ignora.
  v_flight := CASE WHEN v_place IS NOT NULL THEN NULL
    ELSE nullif(upper(regexp_replace(coalesce(p_flight, ''), '[[:space:]-]', '', 'g')), '') END;
  IF v_flight IS NOT NULL AND v_flight !~ '^[A-Z]{0,3}[0-9]{2,5}$' THEN
    RAISE EXCEPTION 'Ese número de vuelo no se entiende (ej.: AV9412)' USING ERRCODE = '22023';
  END IF;
  -- 0093: la llegada de tierra (ground_ops) no tiene vuelo; 0121: la de reserva tampoco.
  IF v_flight IS NULL AND v_place IS NULL AND r.direction = 'airport_to_home' AND NOT coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas' USING ERRCODE = '22023';
  END IF;

  SELECT f.flight_number INTO v_old_flight FROM public.flights f WHERE f.id = r.flight_id;
  IF v_old_flight IS NULL THEN
    v_old_flight := nullif(upper(regexp_replace(
      coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''),
      '[[:space:]-]', '', 'g')), '');
  END IF;

  IF p_when = r.required_arrival_at
     AND v_place IS NOT DISTINCT FROM r.reserve_place
     AND (v_flight IS NULL OR v_flight IS NOT DISTINCT FROM v_old_flight) THEN
    RETURN jsonb_build_object('mode', 'updated', 'unchanged', true,
                              'required_arrival_at', r.required_arrival_at,
                              'reserve_place', r.reserve_place);
  END IF;

  SELECT aux_min_lead_hours INTO v_lead FROM public.app_settings WHERE id = 'singleton';
  v_lead := coalesce(v_lead, 6);

  v_pub := EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id
      AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
      AND ra.status IN ('planned', 'in_progress'));
  v_priv := r.service_level = 'private' AND r.private_status IN ('requested', 'approved');
  -- Cambiar de lugar (vuelo↔reserva, u otro hotel) mueve el carro igual que
  -- cambiar la hora: con la ruta publicada o dentro del plazo, decide Coordinación.
  v_ops := (p_when <> r.required_arrival_at OR v_place IS DISTINCT FROM r.reserve_place) AND (
             v_pub OR v_priv
             OR p_when < now() + make_interval(hours => v_lead)
             OR r.required_arrival_at < now() + make_interval(hours => v_lead));

  -- 0134: con la ruta publicada (o encima de la hora) YA NO se queda esperando a
  -- Coordinación: se cambia la reserva y el sistema la reubica solo. Solo el
  -- privado (camioneta, con precio aprobado) sigue pasando por Coordinación.
  IF NOT v_ops OR NOT v_priv THEN
    v_regreso := coalesce(r.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
    v_user := public.notes_without_flight(r.notes);
    IF v_place IS NOT NULL THEN
      v_notes := v_user;   -- de reserva: el vuelo viejo sale de las notas
    ELSIF v_flight IS NULL THEN
      v_notes := r.notes;  -- sin vuelo nuevo (salida o tierra): las notas quedan como estaban
    ELSE
      v_notes := btrim('Vuelo ' || v_flight || '. ' || v_user
                       || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END);
    END IF;

    UPDATE public.reservations
       SET required_arrival_at = p_when,
           reserve_place = v_place,
           notes = nullif(v_notes, ''),
           flight_id = CASE WHEN v_place IS NOT NULL THEN NULL
                            WHEN v_flight IS NOT NULL AND v_flight IS DISTINCT FROM v_old_flight
                            THEN NULL ELSE flight_id END
     WHERE id = r.id;

    IF NOT v_ops THEN
      RETURN jsonb_build_object('mode', 'updated', 'required_arrival_at', p_when,
                                'flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
                                'reserve_place', v_place);
    END IF;

    -- 0134: sale de su vuelta y queda donde le sirva (o en una vuelta nueva para
    -- tomar). La eventualidad queda como rastro: resuelta sola, o abierta si hace
    -- falta un jefe (muy encima de la hora, o estaba en una vuelta delegada).
    v_reub := public.reubicar_reserva(r.id);
    v_abierta := coalesce((v_reub->>'tight')::boolean, false) OR coalesce((v_reub->>'was_delegated')::boolean, false);
    v_nota := public.reub_nota(v_reub);   -- 0135: la misma frase en todas las decisiones
    v_desc := format('Cambió su %s (%s): %s → %s%s',
      CASE WHEN v_place IS NOT NULL OR r.reserve_place IS NOT NULL THEN 'traslado' ELSE 'vuelo' END,
      CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
      to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
      coalesce(' · vuelo ' || CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END, ''));
    INSERT INTO public.incidents (organization_id, reporter_id, reservation_id, category, severity, status,
                                  description, scope, source, details, occurred_at, resolved_at, resolution_notes)
    SELECT pr.organization_id, auth.uid(), r.id,
           (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay'
                 WHEN p_when < r.required_arrival_at THEN 'flight_advanced' ELSE 'other' END)::public.incident_category,
           (CASE WHEN v_abierta THEN 'high' ELSE 'low' END)::public.incident_severity,
           (CASE WHEN v_abierta THEN 'open' ELSE 'resolved' END)::public.incident_status,
           v_desc, 'operacion', 'system',
           jsonb_build_object('kind', 'aux_change_flight', 'auto', true, 'old_when', r.required_arrival_at, 'new_when', p_when,
                              'old_flight', v_old_flight, 'new_flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
                              'old_reserve_place', r.reserve_place, 'new_reserve_place', v_place, 'direction', r.direction,
                              'published', v_pub, 'reubicada', v_reub),
           now(), CASE WHEN v_abierta THEN NULL ELSE now() END, v_nota
      FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE ap.id = v_aux
    RETURNING id INTO v_inc;
    -- A los jefes solo les suena lo que necesita a una persona.
    IF v_abierta THEN v_n := public.enqueue_incident_alert(v_inc); END IF;

    RETURN jsonb_build_object('mode', 'reassigned', 'required_arrival_at', p_when,
                              'flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
                              'reserve_place', v_place, 'incident_id', v_inc, 'reassign', v_reub);
  END IF;

  v_desc := format('Cambió su %s (%s): %s → %s%s',
    CASE WHEN v_place IS NOT NULL OR r.reserve_place IS NOT NULL THEN 'traslado' ELSE 'vuelo' END,
    CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    CASE
      WHEN v_place IS NOT NULL THEN ' · de reserva en ' || CASE v_place
        WHEN 'rio_verde' THEN 'Hotel Río Verde' WHEN 'movich' THEN 'Hotel Movich' ELSE 'el aeropuerto' END
      ELSE coalesce(' · vuelo ' || coalesce(v_flight, v_old_flight), '')
    END
    || CASE WHEN r.reserve_place IS NOT NULL AND v_place IS NULL THEN ' (antes de reserva)' ELSE '' END);

  v_inc := public.report_incident(
    (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay'
          WHEN p_when < r.required_arrival_at THEN 'flight_advanced'
          ELSE 'other' END)::public.incident_category,
    v_desc,
    'medium'::public.incident_severity,
    r.id,
    jsonb_build_object(
      'kind', 'aux_change_flight',
      'old_when', r.required_arrival_at, 'new_when', p_when,
      'old_flight', v_old_flight, 'new_flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
      'old_reserve_place', r.reserve_place, 'new_reserve_place', v_place,
      'direction', r.direction, 'published', v_pub, 'private', v_priv)
  );
  v_n := public.enqueue_incident_alert(v_inc);

  RETURN jsonb_build_object('mode', 'needs_ops', 'incident_id', v_inc, 'notified', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.reubicar_reserva(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_candidatas(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_leg(uuid, double precision, double precision, boolean, uuid, double precision, double precision, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_extremos(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_conductor_libre(uuid, uuid, uuid, timestamptz, uuid, double precision, double precision, boolean, timestamptz, uuid, double precision, double precision, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_mismo_turno(uuid, uuid, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_baja(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_rastro(uuid, text, text, jsonb, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_nota(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_reservations_acomodar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acomodar_eventualidades(timestamptz) FROM PUBLIC, anon, authenticated;

-- Cada 5 minutos (si pg_cron está; en local puede no estar).
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'acomodar-eventualidades';
  PERFORM cron.schedule('acomodar-eventualidades', '*/5 * * * *', $job$SELECT public.acomodar_eventualidades();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): acomodar_eventualidades queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
