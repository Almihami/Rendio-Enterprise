-- =============================================================================
-- Migration 0134 — Cambió de vuelo o canceló: el sistema decide solo
-- La dueña (26-oct-2026): «si alguien cambia de vuelo, se debería cambiar el
-- vuelo en el itinerario y asignar donde pueda, automático; si alguien cancela se
-- quita automático, se deja el rastro en eventualidad, pero el sistema debería ser
-- capaz de tomar decisiones». Hasta 0126, con la ruta publicada, cambiar de vuelo
-- NO cambiaba la reserva: abría una eventualidad y la persona seguía en su vuelta
-- vieja con la hora vieja hasta que un jefe lo arreglara a mano.
--
-- Respuestas suyas: si no cabe en ninguna vuelta → VUELTA NUEVA PARA TOMAR (la de
-- 0125, que el primer conductor toma); a los que ya van en una vuelta NUNCA se les
-- mueve la hora.
--
-- QUÉ HACE
--   1. route_assignments.auto_created: la vuelta para tomar que creó el sistema
--      (el tablero no pasa por eso el día a «ruta de Julián»).
--   2. reubicar_reserva(reserva): la saca de la vuelta que no ha arrancado (si
--      queda vacía, se quita; al conductor se le avisa) y la pone:
--        · SALIDA: en una vuelta publicada del mismo día que llegue a tiempo a su
--          presentación sin madrugarla más que la ventana de juntar
--          (route_merge_window_min, la misma del tablero), con cupo, y donde
--          entre SIN mover a nadie: en su mismo conjunto (misma hora que el
--          vecino) o de PRIMERA, antes de la primera recogida, si queda cerca
--          (≤ 15 min) y el conductor no tiene otra vuelta justo antes;
--        · LLEGADA: en una vuelta que salga de JMC cuando ya bajó (aterrizaje +
--          desembarque) y la haga esperar ≤ 15 min, de ÚLTIMA (los demás llegan
--          igual);
--        · si no cabe: una vuelta NUEVA para tomar (pool, auto_created), con su
--          hora de recogida estimada (lo medido de su conjunto si hay, si no la
--          misma cuenta del tablero sin mapa), y aviso a los conductores.
--      Al tripulante, al conductor que la pierde y al que la recibe les llega el
--      aviso. Nunca una delegada ni una que ya arrancó.
--   3. auxiliar_change_flight (copia de 0126): con la ruta publicada cambia la
--      reserva y la reubica; deja la eventualidad RESUELTA con lo que pasó, o
--      ABIERTA (y suena a los jefes) si quedó muy encima de la hora o venía de una
--      vuelta delegada. El privado sigue pasando por Coordinación.
--   4. auxiliar_cancel_reservation (copia de 0117): además de sacarla, quita la
--      vuelta que quedó vacía y deja el rastro resuelto en Eventualidades.
-- Necesita 0126 (delegada), 0132 (carro del plan) y 0133 (pasajero sin cuenta).
-- Idempotente. Down: down_migrations/0134_reubicar_al_cambiar.down.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS auto_created boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.route_assignments.auto_created IS
  '0134: vuelta para tomar que creó el sistema (cambio de vuelo sin puesto). Es pool, pero el tablero no cambia el día a «ruta de Julián» por ella.';

-- -----------------------------------------------------------------------------
-- Minutos de manejo, sin mapa en el servidor: lo MEDIDO (0116) de ese conjunto al
-- aeropuerto si hay 3 o más tramos buenos; si no, la cuenta del tablero sin mapa
-- (rtHaversineMin: km × 1,4 a 30 km/h, mínimo 2) × factor de tráfico (y el del
-- aeropuerto en ese corredor).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_tramo_min(p_from_res uuid, a_lat double precision, a_lng double precision,
                                                 b_lat double precision, b_lng double precision, p_aeropuerto boolean)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v numeric; tf numeric; af numeric; km double precision;
BEGIN
  IF p_aeropuerto AND p_from_res IS NOT NULL THEN
    SELECT CASE WHEN count(*) >= 3 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY z.minutes) END INTO v
      FROM (SELECT l.minutes FROM public.route_trip_legs l
             WHERE l.kind = 'casa_aeropuerto' AND l.from_residence_id = p_from_res AND l.quality = 'ok'
               AND l.started_at > now() - interval '60 days'
             ORDER BY l.started_at DESC LIMIT 20) z;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  SELECT route_traffic_factor, route_airport_factor INTO tf, af FROM public.app_settings WHERE id = 'singleton';
  km := public.tramo_km(a_lat, a_lng, b_lat, b_lng);
  IF km IS NULL THEN RETURN NULL; END IF;
  RETURN greatest(2, km * 1.4 / 30 * 60) * coalesce(tf, 1.25) * CASE WHEN p_aeropuerto THEN coalesce(af, 1) ELSE 1 END;
END;
$$;

-- -----------------------------------------------------------------------------
-- Las vueltas donde podría entrar una reserva: publicadas (con conductor o para
-- tomar), sin arrancar, del mismo sentido, de su organización, a ±6 h de su hora
-- y con cupo. Nunca una delegada. dl = la presentación más temprana de la vuelta
-- (o su «Deben estar»): llegar a tiempo para esa = llegar a tiempo para todas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reub_candidatas(p_res uuid, p_cap int)
RETURNS TABLE (ra_id uuid, start_at timestamptz, pool boolean, drv uuid, drv_prof uuid, drv_name text,
               n int, cap int, dl timestamptz, sector_igual boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT res.id, res.direction, res.required_arrival_at AS t, pr.organization_id AS org, rz.sector
      FROM public.reservations res
      JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.residences rz ON rz.id = res.residence_id
     WHERE res.id = p_res)
  SELECT z.* FROM (
    SELECT ra.id, ra.planned_start_at, ra.pool, ra.driver_profile_id, dp.profile_id, pp.full_name,
           -- Cuentan también los pasajeros sin cuenta (0133: parada sin reserva).
           (SELECT count(*) FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
             WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL))::int AS n,
           coalesce(v.capacity, pv.capacity, p_cap)::int AS cap,   -- el carro, o el carro del plan (0132)
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
       AND (ra.organization_id = me.org OR EXISTS (
             SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
               JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
              WHERE x.route_assignment_id = ra.id AND yp.organization_id = me.org))
  ) z
  WHERE z.n < z.cap;
$$;

-- -----------------------------------------------------------------------------
-- Reubicar una reserva (ya con su hora nueva). Devuelve dónde quedó:
--   { kind: 'joined'|'new'|'unplanned', ra_id, start_at, pickup_at, driver_name,
--     removed, was_delegated, tight }
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reubicar_reserva(p_res uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r          record;
  v_buf      int;  v_srv int;  v_cap int;  v_win int;  v_cut int;
  v_ap_lat   double precision;  v_ap_lng double precision;
  v_old      record;
  c          record;
  v_f_order  int;  v_f_eta timestamptz;  v_f_lat double precision;  v_f_lng double precision;
  v_removed  int := 0;
  v_deleg    boolean := false;
  v_kind     text := 'unplanned';
  v_ra       uuid;
  v_start    timestamptz;
  v_eta      timestamptz;
  v_after    int;
  v_tramo    numeric;
  v_ready    timestamptz;
  v_drv_prof uuid;
  v_drv_name text;
  v_dia      date;
  v_lugar    text;
  v_who      text;
  v_vuelo    text;
  v_pub_dia  boolean;
BEGIN
  SELECT res.*, ap.profile_id AS crew, pr.organization_id AS org, pr.full_name AS nombre,
         rz.sector AS sector, rz.name AS conjunto, f.flight_number AS vuelo
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    LEFT JOIN public.residences rz   ON rz.id = res.residence_id
    LEFT JOIN public.flights f       ON f.id = res.flight_id
   WHERE res.id = p_res;
  IF r.id IS NULL OR r.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('kind', 'none'); END IF;
  v_who := public.short_name(r.nombre);
  -- El vuelo: el de la tabla, o el que va escrito en las notas («Vuelo AV9563.»).
  v_vuelo := coalesce(r.vuelo, nullif(upper(regexp_replace(
    coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''), '[[:space:]-]', '', 'g')), ''));
  v_lugar := coalesce(r.conjunto, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''));

  SELECT coalesce(route_airport_buffer_min, 10), coalesce(route_service_min, 3), coalesce(route_default_capacity, 4),
         coalesce(route_merge_window_min, 20), coalesce(route_night_cutoff_min, 120)
    INTO v_buf, v_srv, v_cap, v_win, v_cut
    FROM public.app_settings WHERE id = 'singleton';
  v_buf := coalesce(v_buf, 10); v_srv := coalesce(v_srv, 3); v_cap := coalesce(v_cap, 4); v_win := coalesce(v_win, 20); v_cut := coalesce(v_cut, 120);
  SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng FROM public.airports a WHERE a.organization_id = r.org ORDER BY a.created_at LIMIT 1;
  v_ap_lat := coalesce(v_ap_lat, 6.1715); v_ap_lng := coalesce(v_ap_lng, -75.4270);

  -- 2. ¿El día ya tiene ruta publicada? (se mira ANTES de sacarla: si era la única
  --    vuelta y queda vacía, al quitarla el día parecería sin ruta). Si no, el
  --    tablero la rutea al publicar.
  v_pub_dia := EXISTS (
    SELECT 1 FROM public.route_assignments ra
     WHERE ra.status IN ('planned', 'in_progress')
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
       AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date = (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date
       AND (ra.organization_id = r.org OR EXISTS (
             SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
               JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
              WHERE x.route_assignment_id = ra.id AND yp.organization_id = r.org)));

  -- 1. Sale de la vuelta que no ha arrancado (su parada pendiente).
  FOR v_old IN
    SELECT rs.id AS stop_id, ra.id AS ra_id, ra.planned_start_at, ra.delegated_at, dp.profile_id AS drv_prof
      FROM public.route_stops rs
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE rs.reservation_id = p_res AND rs.status = 'pending' AND ra.status IN ('draft', 'planned', 'in_progress')
  LOOP
    DELETE FROM public.route_stops WHERE id = v_old.stop_id;
    DELETE FROM public.route_assignments ra
     WHERE ra.id = v_old.ra_id AND ra.status IN ('draft', 'planned')
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
    v_removed := v_removed + 1;
    IF v_old.delegated_at IS NOT NULL THEN v_deleg := true; END IF;
    IF v_old.drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_prof, 'Cambió un traslado de tu ruta',
        v_who || ' cambió su vuelo: ya no va en tu vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '.',
        '/', 'reub-out:' || p_res::text || ':' || v_old.ra_id::text || ':' || to_char(r.required_arrival_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
  END LOOP;

  IF NOT v_pub_dia THEN
    RETURN jsonb_build_object('kind', 'unplanned', 'removed', v_removed, 'was_delegated', v_deleg);
  END IF;

  -- 3. Las vueltas donde podría ir (reub_candidatas): publicadas, sin arrancar,
  --    del mismo sentido y de su organización, con cupo; nunca una delegada.

  IF r.direction = 'home_to_airport' THEN
    -- Llega a tiempo a SU presentación y no la madruga más que la ventana de juntar.
    FOR c IN SELECT * FROM public.reub_candidatas(p_res, v_cap)
              WHERE dl IS NOT NULL AND dl <= r.required_arrival_at AND r.required_arrival_at - dl <= make_interval(mins => v_win)
              ORDER BY sector_igual DESC, (r.required_arrival_at - dl), start_at
    LOOP
      -- (a) Alguien de su mismo conjunto: entra justo después, a la misma hora.
      IF r.residence_id IS NOT NULL THEN
        v_f_order := NULL; v_f_eta := NULL;
        SELECT x.stop_order, x.estimated_arrival_at INTO v_f_order, v_f_eta
          FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
         WHERE x.route_assignment_id = c.ra_id AND coalesce(y.residence_id, x.guest_residence_id) = r.residence_id
           AND x.estimated_arrival_at IS NOT NULL AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
         ORDER BY x.stop_order DESC LIMIT 1;
        IF v_f_order IS NOT NULL THEN
          v_after := v_f_order; v_eta := v_f_eta; v_ra := c.ra_id; EXIT;
        END IF;
      END IF;
      -- (b) De PRIMERA, antes de la primera recogida, si queda cerca. A nadie se
      --     le mueve la hora; solo arranca antes, así que el conductor no puede
      --     tener otra vuelta en la hora y media anterior.
      v_f_order := NULL; v_f_eta := NULL; v_f_lat := NULL; v_f_lng := NULL;
      SELECT x.stop_order, x.estimated_arrival_at, coalesce(y.pickup_latitude, x.guest_lat), coalesce(y.pickup_longitude, x.guest_lng)
        INTO v_f_order, v_f_eta, v_f_lat, v_f_lng
        FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
       WHERE x.route_assignment_id = c.ra_id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL)
       ORDER BY x.stop_order LIMIT 1;
      IF v_f_eta IS NOT NULL THEN
        v_tramo := public.reub_tramo_min(NULL, r.pickup_latitude, r.pickup_longitude, v_f_lat, v_f_lng, false);
        IF v_tramo IS NOT NULL AND v_tramo <= 15 THEN
          v_eta := v_f_eta - make_interval(mins => ceil(v_tramo + v_srv)::int);
          v_eta := date_trunc('hour', v_eta) + make_interval(mins => (floor(extract(minute FROM v_eta) / 5) * 5)::int);
          IF v_eta >= now() + interval '20 minutes'
             AND (c.drv IS NULL OR NOT EXISTS (
                   SELECT 1 FROM public.route_assignments o
                    WHERE o.driver_profile_id = c.drv AND o.id <> c.ra_id AND o.status IN ('planned', 'in_progress')
                      AND o.planned_start_at < c.start_at AND o.planned_start_at >= v_eta - interval '90 minutes')) THEN
            v_after := 0; v_ra := c.ra_id; EXIT;
          END IF;
        END IF;
      END IF;
    END LOOP;
  ELSE
    -- LLEGADA: sale de JMC cuando ya bajó y la hace esperar 15 min o menos.
    v_ready := r.required_arrival_at + make_interval(mins => CASE
      WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
      ELSE coalesce(public.flight_deplane_min(v_vuelo), 15) END);
    SELECT k.ra_id INTO v_ra FROM public.reub_candidatas(p_res, v_cap) k
     WHERE k.start_at >= v_ready AND k.start_at <= v_ready + interval '15 minutes'
     ORDER BY k.sector_igual DESC, k.start_at LIMIT 1;
    IF v_ra IS NOT NULL THEN
      v_eta := NULL;
      SELECT coalesce(max(x.stop_order), 0) INTO v_after FROM public.route_stops x WHERE x.route_assignment_id = v_ra;
    END IF;
  END IF;

  IF v_ra IS NOT NULL THEN
    -- Entra en esa vuelta sin correr a nadie (se abre el hueco en el orden).
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra AND stop_order > v_after;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (v_ra, p_res, v_after + 1, v_eta);
    UPDATE public.route_stops SET stop_order = stop_order - 999 WHERE route_assignment_id = v_ra AND stop_order > 1000;
    IF r.direction = 'home_to_airport' AND v_eta IS NOT NULL THEN
      UPDATE public.route_assignments SET planned_start_at = least(planned_start_at, v_eta), updated_at = now() WHERE id = v_ra;
    END IF;
    SELECT ra.planned_start_at, dp.profile_id, pp.full_name INTO v_start, v_drv_prof, v_drv_name
      FROM public.route_assignments ra LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pp ON pp.id = dp.profile_id WHERE ra.id = v_ra;
    v_kind := 'joined';
    PERFORM public.trip_notify(r.crew, 'Listo: te movimos de vuelta 🔄',
      CASE WHEN r.direction = 'home_to_airport'
           THEN 'Con tu hora nueva te recogemos a las ' || public.hm_bog(v_eta)
           ELSE 'Con tu vuelo nuevo te esperamos en JMC a las ' || public.hm_bog(v_start) END
      || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
      '/#/viaje?r=' || p_res::text, 'reub-in:' || p_res::text || ':' || v_ra::text || ':' || to_char(r.required_arrival_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Se sumó alguien a tu vuelta',
        v_who || ' va en tu vuelta de las ' || public.hm_bog(v_start)
        || CASE WHEN r.direction = 'home_to_airport' THEN ': recogida ' || public.hm_bog(v_eta) || coalesce(' en ' || v_lugar, '') ELSE coalesce(': lo dejas en ' || v_lugar, '') END || '.',
        '/', 'reub-drv:' || p_res::text || ':' || v_ra::text || ':' || to_char(r.required_arrival_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
    END IF;
  ELSE
    -- 4. No cabe: vuelta NUEVA para tomar, solo para ella.
    IF r.direction = 'home_to_airport' THEN
      v_tramo := public.reub_tramo_min(r.residence_id, r.pickup_latitude, r.pickup_longitude, v_ap_lat, v_ap_lng, true);
      v_eta := r.required_arrival_at - make_interval(mins => ceil(coalesce(v_tramo, 40) + v_buf + v_srv)::int);
      v_eta := date_trunc('hour', v_eta) + make_interval(mins => (floor(extract(minute FROM v_eta) / 5) * 5)::int);
      v_start := v_eta;
    ELSE
      v_start := date_trunc('hour', v_ready) + make_interval(mins => (ceil(extract(minute FROM v_ready) / 5) * 5)::int);
      v_eta := NULL;
    END IF;
    -- El día del plan: lo de la madrugada (antes del corte) es del día anterior.
    v_dia := (v_start AT TIME ZONE 'America/Bogota')::date;
    IF extract(hour FROM v_start AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_start AT TIME ZONE 'America/Bogota') < v_cut THEN
      v_dia := v_dia - 1;
    END IF;
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                          pool, auto_created, organization_id, manual_day, deadline_at, manual_note)
    VALUES (NULL, NULL, r.direction, 'planned', v_start, true, true, r.org, v_dia,
            CASE WHEN r.direction = 'home_to_airport' THEN r.required_arrival_at END,
            'Creada sola: cambio de vuelo')
    RETURNING id INTO v_ra;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
    VALUES (v_ra, p_res, 1, v_eta);
    v_kind := 'new';
    PERFORM public.trip_notify(r.crew, 'Te armamos una vuelta 🚗',
      CASE WHEN r.direction = 'home_to_airport'
           THEN 'Con tu hora nueva te recogemos a las ' || public.hm_bog(v_eta) || ' para estar en JMC a las ' || public.hm_bog(r.required_arrival_at)
           ELSE 'Con tu vuelo nuevo te esperamos en JMC a las ' || public.hm_bog(v_start) END
      || '. Te avisamos quién te recoge.',
      '/#/viaje?r=' || p_res::text, 'reub-new:' || p_res::text || ':' || v_ra::text);
    PERFORM public.trip_notify(p.id, 'Hay una vuelta para tomar',
      CASE WHEN r.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END || ' de las ' || public.hm_bog(v_start)
      || ' (' || v_who || coalesce(', ' || v_lugar, '') || '): cambió de vuelo y no cabía en otra. Tómala en Ruta si puedes.',
      '/#/ruta', 'reub-pool:' || v_ra::text || ':' || p.id::text)
      FROM public.profiles p
     WHERE p.organization_id = r.org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('kind', v_kind, 'ra_id', v_ra, 'start_at', v_start,
                            'pickup_at', CASE WHEN r.direction = 'home_to_airport' THEN v_eta ELSE v_start END,
                            'driver_name', v_drv_name, 'removed', v_removed, 'was_delegated', v_deleg,
                            -- Muy encima: menos de 45 min para la recogida.
                            'tight', coalesce(CASE WHEN r.direction = 'home_to_airport' THEN v_eta ELSE v_start END < now() + interval '45 minutes', false));
END;
$$;

-- -----------------------------------------------------------------------------
-- Copias con la decisión automática (lo demás, idéntico a 0126 / 0117)
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
    v_nota := CASE v_reub->>'kind'
      WHEN 'joined' THEN 'Se resolvió sola: pasó a la vuelta de las ' || public.hm_bog((v_reub->>'start_at')::timestamptz)
                         || coalesce(' de ' || (v_reub->>'driver_name'), '')
                         || CASE WHEN r.direction = 'home_to_airport' THEN ' (recogida ' || public.hm_bog((v_reub->>'pickup_at')::timestamptz) || ')' ELSE '' END || '.'
      WHEN 'new'    THEN 'Se resolvió sola: no cabía en ninguna vuelta y se creó una vuelta nueva para tomar a las '
                         || public.hm_bog((v_reub->>'pickup_at')::timestamptz) || '.'
      ELSE 'Se actualizó la reserva: ese día todavía no tiene ruta publicada (entra al publicarla).' END
      || CASE WHEN coalesce((v_reub->>'was_delegated')::boolean, false) THEN ' OJO: estaba en una vuelta DELEGADA: avísale a quien la iba a hacer.' ELSE '' END
      || CASE WHEN coalesce((v_reub->>'tight')::boolean, false) THEN ' OJO: queda muy encima de la hora: revisa que alguien la tome.' ELSE '' END;
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

CREATE OR REPLACE FUNCTION public.auxiliar_cancel_reservation(
  p_reservation_id uuid,
  p_reason         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux    uuid := public.current_auxiliar_id();
  v_dir    public.trip_direction;
  v_raw    text;
  v_driver uuid;
  v_quien  text;
  v_avisos integer := 0;
  v_vueltas uuid[];      -- 0134: de dónde sale (para quitar la que quede vacía)
  v_hora    timestamptz;
  v_org     uuid;
  v_quitadas int := 0;
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'solo un auxiliar puede cancelar su traslado';
  END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text)
    INTO v_dir, v_raw
  FROM public.reservations r
  WHERE r.id = p_reservation_id
    AND r.auxiliar_profile_id = v_aux
    AND r.cancelled_at IS NULL
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no es tuya, no existe o ya estaba cancelada', p_reservation_id;
  END IF;

  -- Ya te recogieron: el viaje está en curso o terminó, no hay nada que cancelar.
  IF v_raw IN ('on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show') THEN
    RAISE EXCEPTION 'el viaje ya está en curso o terminó; no se puede cancelar';
  END IF;

  -- Conductor afectado (si el plan ya estaba publicado) → para avisarle.
  SELECT dp.profile_id INTO v_driver
  FROM public.route_stops rs
  JOIN public.route_assignments ra    ON ra.id = rs.route_assignment_id
  JOIN public.driver_profiles   dp    ON dp.id = ra.driver_profile_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  -- 0134: las vueltas de donde sale, y su hora (para el rastro).
  SELECT coalesce(array_agg(DISTINCT ra.id), ARRAY[]::uuid[]), min(coalesce(rs.estimated_arrival_at, ra.planned_start_at))
    INTO v_vueltas, v_hora
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
   WHERE rs.reservation_id = p_reservation_id AND ra.status <> 'completed';

  -- Sale de las rutas que aún no terminan (la parada deja de existir).
  DELETE FROM public.route_stops rs
  USING public.route_assignments ra
  WHERE rs.route_assignment_id = ra.id
    AND rs.reservation_id = p_reservation_id
    AND ra.status <> 'completed';

  UPDATE public.reservations
     SET cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         status_h2a          = CASE WHEN v_dir = 'home_to_airport' THEN 'cancelled'::public.reservation_status_h2a ELSE NULL END,
         status_a2h          = CASE WHEN v_dir = 'airport_to_home' THEN 'cancelled'::public.reservation_status_a2h ELSE NULL END,
         updated_at          = now()
   WHERE id = p_reservation_id;

  -- El aviso al conductor sale de aquí (0117): el celular del tripulante ya no
  -- puede mandarlo, porque la parada que los unía se acaba de borrar.
  IF v_driver IS NOT NULL THEN
    SELECT nullif(split_part(btrim(p.full_name), ' ', 1), '') INTO v_quien
    FROM public.profiles p WHERE p.id = auth.uid();
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    VALUES (v_driver, 'Traslado cancelado',
            coalesce(v_quien, 'Un tripulante') || ' canceló su traslado. Ya no está en tu ruta.',
            '/', 'cancel:' || p_reservation_id::text || ':' || v_driver::text)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_avisos = ROW_COUNT;
  END IF;

  -- 0134: la vuelta que quedó vacía (y no ha arrancado) se quita sola.
  WITH vacias AS (
    DELETE FROM public.route_assignments ra
     WHERE ra.id = ANY (v_vueltas) AND ra.status IN ('draft', 'planned')
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id)
    RETURNING 1)
  SELECT count(*) INTO v_quitadas FROM vacias;

  -- 0134: el rastro en Eventualidades (resuelta: el sistema ya la sacó).
  SELECT p.organization_id INTO v_org FROM public.profiles p WHERE p.id = auth.uid();
  IF v_org IS NOT NULL AND cardinality(v_vueltas) > 0 THEN
    INSERT INTO public.incidents (organization_id, reporter_id, reservation_id, category, severity, status,
                                  description, scope, source, details, occurred_at, resolved_at, resolution_notes)
    VALUES (v_org, auth.uid(), p_reservation_id, 'other', 'low', 'resolved',
            coalesce(v_quien, (SELECT nullif(split_part(btrim(p.full_name), ' ', 1), '') FROM public.profiles p WHERE p.id = auth.uid()), 'Un tripulante')
              || ' canceló su traslado' || coalesce(' de las ' || public.hm_bog(v_hora), '')
              || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '') || '.',
            'operacion', 'system',
            jsonb_build_object('kind', 'aux_cancel', 'auto', true, 'direction', v_dir, 'vueltas', v_vueltas, 'vueltas_quitadas', v_quitadas),
            now(), now(),
            'Se resolvió sola: salió de su vuelta' || CASE WHEN v_driver IS NOT NULL THEN ' y se le avisó al conductor' ELSE '' END
              || CASE WHEN v_quitadas > 0 THEN '; la vuelta quedó vacía y se quitó' ELSE '' END || '.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver, 'driver_notified', v_avisos > 0, 'vueltas_quitadas', v_quitadas);
END;
$$;

REVOKE ALL ON FUNCTION public.reubicar_reserva(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_candidatas(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reub_tramo_min(uuid, double precision, double precision, double precision, double precision, boolean) FROM PUBLIC, anon, authenticated;

COMMIT;
