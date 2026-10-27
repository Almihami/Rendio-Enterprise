-- =============================================================================
-- 0151 · «Para tomar» desde el tablero, tomar aunque se cruce (avisa) y el
--        conductor arma su llegada (27-oct-2026)
-- =============================================================================
-- Camilo (jefe, 27-oct): «Tomás está muy restrictivo»; «que me deje meter a una
-- persona en un combo de recogida en puerto sin que me afecte horas. O incluso que
-- el conductor diga, tal persona ya llegó me la monto a mi combo, y suelto a esta
-- que no me da»; «si ese servicio que cojan afecta una recogida después, el sistema
-- tirará una alerta para que coordinación decida». La profa (27-oct) eligió:
-- «Coordinación elige» qué vueltas quedan para tomar, y el conductor «Lo hace y
-- avisa».
--
-- QUÉ HACE
--   1. route_assignments.para_tomar: la vuelta del TABLERO que Coordinación dejó
--      para tomar. Va con pool = true (así la ven y la toman driver_open_routes,
--      driver_take_route, driver_release_route, pool_unclaimed_alerts y
--      auxiliar_my_trips, sin tocarlas) y organization_id; sin manual_day. El
--      tablero la sigue mostrando como suya (no como pegada) y la vuelve a publicar.
--   2. driver_take_route (copia de 0147): si se le cruza con otra vuelta suya, ya no
--      se niega: la toma y a los jefes les llega «⚠️ X tomó una vuelta que se le
--      cruza». Devuelve 'cruza' con la hora de la otra. Lo marcado «0151».
--   3. El conductor en su LLEGADA que no ha salido de JMC:
--        driver_llegada_candidatos(vuelta): llegadas a ±90 min que no van en una
--          vuelta arrancada ni delegada (con quién van hoy).
--        driver_llegada_agregar(vuelta, reserva): se la monta; avisa al tripulante,
--          al conductor que la llevaba y a los jefes.
--        driver_llegada_soltar(vuelta, parada): queda en una vuelta para tomar a la
--          misma hora; avisa a los jefes, a los demás del turno y al tripulante.
--   4. admin_routes_offer(vueltas): al publicar, «Hay una vuelta para tomar» a los
--      del turno (avisar_vuelta_para_tomar, 0144).
-- Lo próximo que toque driver_take_route copia DESDE 0151.
-- Necesita 0125, 0126, 0135 (reub_*), 0144, 0146 (hora_que_importa), 0147.
-- Down: down_migrations/0151_para_tomar_y_conductor.down.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS para_tomar boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.route_assignments.para_tomar IS
  '0151: vuelta del tablero que Coordinación dejó «para tomar» (va con pool = true y organization_id, sin manual_day). La toma un conductor en su app.';

-- -----------------------------------------------------------------------------
-- 2. Tomar aunque se cruce (copia de 0147 + lo marcado «0151»)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_take_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_pl  text;
  c     record;
  e     record;   -- 0138
  v_otra timestamptz;   -- 0138
  v_cruza boolean := false;   -- 0151: se cruza → la toma igual y se avisa a Coordinación
  v_full  text;               -- 0151
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');   -- 0151
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  -- 0138: no se toma una vuelta que se cruza con otra suya (o a la que no alcanza a
  -- llegar desde la anterior). Solo si la vuelta sigue libre: si no, el mensaje de
  -- siempre («ya la tomó otro», «la delegó Coordinación»).
  IF EXISTS (SELECT 1 FROM public.route_assignments x WHERE x.id = p_route AND x.pool AND x.organization_id = v_org
               AND x.driver_profile_id IS NULL AND x.status = 'planned' AND x.delegated_at IS NULL) THEN
    SELECT * INTO e FROM public.reub_extremos(p_route);
    IF e.ini_at IS NOT NULL AND e.fin_at IS NOT NULL
       AND NOT public.reub_conductor_libre(v_dp, p_route, NULL, e.ini_at, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                                           e.fin_at, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air) THEN
      -- La suya más cercana a esa hora, para decirle con cuál choca.
      SELECT o.planned_start_at INTO v_otra FROM public.route_assignments o
       WHERE o.driver_profile_id = v_dp AND o.id <> p_route AND o.status IN ('planned', 'in_progress')
         AND o.planned_start_at BETWEEN e.ini_at - interval '12 hours' AND e.fin_at + interval '12 hours'
       ORDER BY abs(extract(epoch FROM o.planned_start_at - e.ini_at)) LIMIT 1;
      -- 0151 (Camilo, 27-oct): «si ese servicio que cojan afecta una recogida
      -- después, el sistema tirará una alerta para que coordinación decida». Ya no
      -- se niega: se toma y a los jefes les llega el aviso (abajo).
      v_cruza := true;
    END IF;
  END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = v_dp, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id IS NULL AND status = 'planned'
     AND delegated_at IS NULL   -- 0126
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND delegated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta la hace alguien de afuera: Coordinación la delegó' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND driver_profile_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta ya la tomó otro conductor' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Esta vuelta ya no está disponible' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_me, 'Tu conductor') || ' te recoge 🚗',
      CASE WHEN ra.direction = 'home_to_airport'
           THEN 'Te recoge a las ' || public.hm_bog(c.at) || coalesce(' en el carro ' || v_pl, '') || '.'
           ELSE 'Te espera ' || coalesce(public.lugar_del_regreso(c.id), 'en JMC cuando aterrices') || coalesce(' (carro ' || v_pl || ')', '') || '.' END,   -- 0147
      '/#/viaje?r=' || c.id::text, 'take:' || ra.id::text || ':' || v_dp::text || ':' || c.id::text);
  END LOOP;
  -- 0151: tomó una que se le cruza: Coordinación decide.
  IF v_cruza THEN
    SELECT pr.full_name INTO v_full FROM public.profiles pr WHERE pr.id = auth.uid();
    PERFORM public.trip_notify(j.profile_id, '⚠️ ' || coalesce(public.short_name(v_full), 'Un conductor') || ' tomó una vuelta que se le cruza',
      CASE WHEN ra.direction = 'home_to_airport' THEN 'La salida' ELSE 'La llegada' END || ' de las ' || public.hm_bog(ra.planned_start_at)
        || ' se le cruza con su vuelta de las ' || coalesce(public.hm_bog(v_otra), 'esa hora') || ': no alcanza a hacer las dos. Decide en Asignación.',
      '/#/rutas', 'takecruza:' || ra.id::text || ':' || v_sello || ':' || j.profile_id::text)
      FROM public.ops_alert_recipients_of(v_org) j;
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'vehicle_id', ra.vehicle_id, 'plate', v_pl,
    'cruza', CASE WHEN v_cruza THEN coalesce(public.hm_bog(v_otra), '') END);   -- 0151
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. El conductor arma su llegada (Camilo, 27-oct: «que el conductor diga, tal
--    persona ya llegó, me la monto a mi combo, y suelto a esta que no me da»)
-- -----------------------------------------------------------------------------
-- Solo en una LLEGADA suya que todavía no sale de JMC (ninguna parada marcada).
CREATE OR REPLACE FUNCTION public.llegada_editable(p_route uuid, p_dp uuid)
RETURNS public.route_assignments
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE ra public.route_assignments;
BEGIN
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  IF ra.id IS NULL OR ra.driver_profile_id IS DISTINCT FROM p_dp THEN
    RAISE EXCEPTION 'Esa vuelta no es tuya' USING ERRCODE = 'P0002';
  END IF;
  IF ra.direction <> 'airport_to_home' OR ra.status NOT IN ('planned', 'in_progress') THEN
    RAISE EXCEPTION 'Solo se agrega o se suelta gente en una llegada que no ha terminado' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya salió de JMC: ya no se le agrega ni se le suelta gente' USING ERRCODE = 'P0001';
  END IF;
  RETURN ra;
END;
$$;
REVOKE ALL ON FUNCTION public.llegada_editable(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Dónde va hoy una reserva de llegada: su parada, su vuelta y si se puede mover
-- (parada pendiente, vuelta sin arrancar y no delegada).
CREATE OR REPLACE FUNCTION public.llegada_donde_va(p_res uuid)
RETURNS TABLE (stop_id uuid, route_id uuid, driver uuid, pool boolean, movible boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT rs.id, ra.id, ra.driver_profile_id, ra.pool,
         rs.status = 'pending' AND ra.delegated_at IS NULL AND ra.status IN ('planned', 'draft')
           AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
   WHERE rs.reservation_id = p_res
   ORDER BY ra.planned_start_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.llegada_donde_va(uuid) FROM PUBLIC, anon, authenticated;

-- A quién puede montar: llegadas de su organización a ±90 min de su vuelta, que no
-- van ya en una vuelta arrancada ni delegada.
CREATE OR REPLACE FUNCTION public.driver_llegada_candidatos(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Solo un conductor' USING ERRCODE = '42501'; END IF;
  ra := public.llegada_editable(p_route, v_dp);
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'rid', z.id, 'name', z.full_name, 'hora', public.hm_bog(z.hora), 'vuelo', z.flight_code,
             'destino', z.destino, 'actual', z.actual) ORDER BY z.hora, z.full_name)
      FROM (
        SELECT r.id, pr.full_name, public.hora_que_importa(r.id) AS hora, r.flight_code,
               coalesce(re.name, nullif(btrim(split_part(r.pickup_address, ',', 1)), '')) AS destino,
               CASE WHEN d.route_id IS NULL THEN 'Sin carro'
                    WHEN d.driver IS NOT NULL THEN coalesce((SELECT public.short_name(p2.full_name) FROM public.driver_profiles dp2
                                                              JOIN public.profiles p2 ON p2.id = dp2.profile_id WHERE dp2.id = d.driver), 'Otro conductor')
                    WHEN d.pool THEN 'Para tomar' ELSE 'Sin conductor' END AS actual,
               d.route_id, d.movible
          FROM public.reservations r
          JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
          JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
          LEFT JOIN public.residences re ON re.id = r.residence_id
          LEFT JOIN LATERAL public.llegada_donde_va(r.id) d ON true
         WHERE r.direction = 'airport_to_home' AND r.cancelled_at IS NULL
           AND coalesce(r.status_a2h::text, '') NOT IN ('picked_up', 'en_route_home', 'delivered')
           AND public.hora_que_importa(r.id) BETWEEN ra.planned_start_at - interval '90 minutes' AND ra.planned_start_at + interval '90 minutes'
      ) z
     WHERE z.route_id IS DISTINCT FROM ra.id AND (z.route_id IS NULL OR z.movible)), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.driver_llegada_candidatos(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_llegada_candidatos(uuid) TO authenticated;

-- «Me la monto a mi combo»: pasa a esa persona a su llegada, al momento. Avisa al
-- tripulante, al conductor que la llevaba y a Coordinación.
CREATE OR REPLACE FUNCTION public.driver_llegada_agregar(p_route uuid, p_res uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp   uuid := public.my_driver_profile_id();
  v_org  uuid := public.current_user_org();
  ra     public.route_assignments;
  d      record;
  v_crew uuid; v_name text; v_me text; v_pl text; v_prev text; v_prevp uuid; v_prev_hora timestamptz;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Solo un conductor' USING ERRCODE = '42501'; END IF;
  ra := public.llegada_editable(p_route, v_dp);
  SELECT ap.profile_id, pr.full_name INTO v_crew, v_name
    FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE r.id = p_res AND r.direction = 'airport_to_home' AND r.cancelled_at IS NULL;
  IF v_crew IS NULL THEN RAISE EXCEPTION 'Esa persona no tiene una llegada vigente' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO d FROM public.llegada_donde_va(p_res);
  IF d.route_id = ra.id THEN RETURN jsonb_build_object('id', ra.id, 'unchanged', true); END IF;
  IF d.route_id IS NOT NULL THEN
    IF NOT d.movible THEN RAISE EXCEPTION 'Esa persona ya va en una vuelta que arrancó (o delegada): no se puede mover' USING ERRCODE = 'P0001'; END IF;
    PERFORM 1 FROM public.route_assignments WHERE id = d.route_id FOR UPDATE;
    SELECT dp.profile_id, pr.full_name, x.planned_start_at INTO v_prevp, v_prev, v_prev_hora
      FROM public.route_assignments x LEFT JOIN public.driver_profiles dp ON dp.id = x.driver_profile_id
      LEFT JOIN public.profiles pr ON pr.id = dp.profile_id WHERE x.id = d.route_id;
    DELETE FROM public.route_stops WHERE id = d.stop_id;
    -- La vuelta que se queda sin nadie sobra.
    DELETE FROM public.route_assignments x WHERE x.id = d.route_id
       AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = x.id);
  END IF;
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
  VALUES (ra.id, p_res, coalesce((SELECT max(stop_order) FROM public.route_stops WHERE route_assignment_id = ra.id), 0) + 1, NULL);
  PERFORM public.sync_calculated_pickup(p_res);
  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  PERFORM public.trip_notify(v_crew, coalesce(public.short_name(v_me), 'Tu conductor') || ' te recoge 🚗',
    'Te espera ' || coalesce(public.lugar_del_regreso(p_res), 'en JMC cuando aterrices') || coalesce(' (carro ' || v_pl || ')', '') || '.',
    '/#/viaje?r=' || p_res::text, 'llegadaadd:' || ra.id::text || ':' || p_res::text || ':' || v_sello);
  IF v_prevp IS NOT NULL AND v_prevp IS DISTINCT FROM auth.uid() THEN
    PERFORM public.trip_notify(v_prevp, 'Ya no llevas a ' || public.short_name(v_name),
      coalesce(public.short_name(v_me), 'Otro conductor') || ' la lleva en su llegada de las ' || public.hm_bog(ra.planned_start_at) || '. Revisa tu ruta.',
      '/#/ruta', 'llegadaquita:' || d.route_id::text || ':' || p_res::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_notify(j.profile_id, '🔁 ' || coalesce(public.short_name(v_me), 'Un conductor') || ' se montó a ' || public.short_name(v_name),
    'En su llegada de las ' || public.hm_bog(ra.planned_start_at) || '. '
      || CASE WHEN d.route_id IS NULL THEN 'Estaba sin carro.'
              WHEN v_prev IS NOT NULL THEN 'Iba con ' || public.short_name(v_prev) || ' (llegada de las ' || public.hm_bog(v_prev_hora) || ').'
              ELSE 'Estaba para tomar.' END,
    '/#/rutas', 'llegadaadd-j:' || ra.id::text || ':' || p_res::text || ':' || v_sello || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'from_route', d.route_id, 'prev_driver', public.short_name(v_prev));
END;
$$;
REVOKE ALL ON FUNCTION public.driver_llegada_agregar(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_llegada_agregar(uuid, uuid) TO authenticated;

-- «Suelto a esta que no me da»: sale de su llegada y queda en «Vueltas para tomar»
-- (una vuelta sola para ella, a la misma hora). Avisa a Coordinación, a los demás
-- conductores del turno y al tripulante.
CREATE OR REPLACE FUNCTION public.driver_llegada_soltar(p_route uuid, p_stop uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_res uuid; v_crew uuid; v_name text; v_me text; v_new uuid;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Solo un conductor' USING ERRCODE = '42501'; END IF;
  ra := public.llegada_editable(p_route, v_dp);
  SELECT rs.reservation_id INTO v_res FROM public.route_stops rs
   WHERE rs.id = p_stop AND rs.route_assignment_id = ra.id AND rs.status = 'pending' AND rs.reservation_id IS NOT NULL;
  IF v_res IS NULL THEN RAISE EXCEPTION 'Esa parada no es de tu vuelta' USING ERRCODE = 'P0002'; END IF;
  SELECT ap.profile_id, pr.full_name INTO v_crew, v_name FROM public.reservations r
    JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE r.id = v_res;
  DELETE FROM public.route_stops WHERE id = p_stop;
  INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, para_tomar, organization_id)
  VALUES (NULL, NULL, 'airport_to_home', 'planned', ra.planned_start_at, true, true, v_org)
  RETURNING id INTO v_new;
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES (v_new, v_res, 1, NULL);
  PERFORM public.sync_calculated_pickup(v_res);
  DELETE FROM public.route_assignments x WHERE x.id = ra.id
     AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = x.id);
  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  PERFORM public.trip_notify(j.profile_id, '⚠️ ' || coalesce(public.short_name(v_me), 'Un conductor') || ' soltó a ' || public.short_name(v_name),
    'De su llegada de las ' || public.hm_bog(ra.planned_start_at) || '. Quedó para tomar: si nadie la toma, asígnala en Asignación.',
    '/#/rutas', 'llegadasuelta-j:' || v_new::text || ':' || v_sello || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  PERFORM public.avisar_vuelta_para_tomar(v_org, ra.planned_start_at, 'Hay una vuelta para tomar',
    'Llegada de las ' || public.hm_bog(ra.planned_start_at) || ' (' || public.short_name(v_name) || ').',
    'llegadasuelta:' || v_new::text || ':' || v_sello, auth.uid(), false);
  IF v_crew IS NOT NULL THEN
    PERFORM public.trip_notify(v_crew, 'Cambió quién te recoge',
      'Te avisamos apenas un conductor tome tu traslado.', '/#/viaje?r=' || v_res::text, 'llegadasuelta-t:' || v_new::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.driver_llegada_soltar(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_llegada_soltar(uuid, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Al publicar el tablero: «Hay una vuelta para tomar» a los del turno
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_routes_offer(p_routes uuid[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v record; v_n int := 0;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica vueltas para tomar' USING ERRCODE = '42501';
  END IF;
  FOR v IN
    SELECT ra.id, ra.direction, ra.planned_start_at,
           (SELECT string_agg(coalesce(public.short_name(pr.full_name), rs.guest_name, '—'), ', ' ORDER BY rs.stop_order)
              FROM public.route_stops rs LEFT JOIN public.reservations r ON r.id = rs.reservation_id
              LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id) AS quienes
      FROM public.route_assignments ra
     WHERE ra.id = ANY (p_routes) AND ra.pool AND ra.para_tomar AND ra.organization_id = v_org
       AND ra.driver_profile_id IS NULL AND ra.status = 'planned' AND ra.delegated_at IS NULL
  LOOP
    v_n := v_n + public.avisar_vuelta_para_tomar(v_org, v.planned_start_at, 'Hay una vuelta para tomar',
      CASE WHEN v.direction = 'airport_to_home' THEN 'Llegada' ELSE 'Salida' END || ' de las ' || public.hm_bog(v.planned_start_at)
        || coalesce(' (' || v.quienes || ')', '') || '.',
      'tomarpub:' || v.id::text, NULL, true);
  END LOOP;
  PERFORM public.trip_kick();
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_routes_offer(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_routes_offer(uuid[]) TO authenticated;

COMMIT;
