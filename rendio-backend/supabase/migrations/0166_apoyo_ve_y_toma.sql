-- =============================================================================
-- 0166 · El que tiene el carro de apoyo también ve y toma las llegadas
-- =============================================================================
-- Harold, 15-nov (noche), sobre 0165: «Julián no las ve, pero si necesitamos un
-- apoyo el sistema se las asigna… no tiene sentido, él debería poder verlas».
-- 0165 le escondía las llegadas al de apoyo (carro que se paga por vuelta). Ahora
-- las ve y las toma como los demás, con la misma ventana de 40 min, y cada vez que
-- toma una les llega a los jefes «Salió el carro de apoyo» (igual que cuando se la
-- da el sistema). El rastro guarda detail.apoyo. Balance ya cuenta sus vueltas
-- (admin_apoyo_resumen, 0162). driver_open_routes y driver_take_route DESDE 0165:
-- lo próximo que las toque copia DESDE 0166.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.driver_open_routes()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_dp uuid := public.my_driver_profile_id(); v_org uuid := public.current_user_org();
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(j ORDER BY ts) FROM (
      SELECT ra.planned_start_at AS ts, jsonb_build_object(
        'id', ra.id, 'direction', ra.direction, 'planned_start_at', ra.planned_start_at,
        'deadline_at', ra.deadline_at, 'note', ra.manual_note, 'day', ra.manual_day,
        -- 0138: con o sin cuenta (0133). Antes un JOIN a reservas dejaba por fuera a Kriss.
        'stops', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'order', rs.stop_order, 'at', rs.estimated_arrival_at,
                    'name', CASE WHEN rs.reservation_id IS NULL THEN public.short_name(rs.guest_name) ELSE public.short_name(pr.full_name) END,
                    'place', coalesce(res.name, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''), nullif(btrim(rs.guest_place), ''), 'Sin dirección'),
                    'sector', res.sector, 'flight', coalesce(f.flight_number, r.flight_code),
                    'guest', rs.reservation_id IS NULL) ORDER BY rs.stop_order), '[]'::jsonb)
                  FROM public.route_stops rs
                  LEFT JOIN public.reservations r ON r.id = rs.reservation_id
                  LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                  LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
                  LEFT JOIN public.residences res ON res.id = coalesce(r.residence_id, rs.guest_residence_id)
                  LEFT JOIN public.flights f ON f.id = r.flight_id
                 WHERE rs.route_assignment_id = ra.id
                   AND ((rs.reservation_id IS NOT NULL AND r.cancelled_at IS NULL)
                        OR (rs.reservation_id IS NULL AND rs.guest_name IS NOT NULL))),
        -- 0138: ¿ya tiene otra vuelta a esa hora? (la misma cuenta que driver_take_route)
        'cruza', (SELECT e.ini_at IS NOT NULL AND e.fin_at IS NOT NULL
                         AND NOT public.reub_conductor_libre(v_dp, ra.id, NULL,
                               e.ini_at, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                               e.fin_at, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air)
                    FROM public.reub_extremos(ra.id) e)) AS j
        FROM public.route_assignments ra
       WHERE ra.pool AND ra.organization_id = v_org AND ra.driver_profile_id IS NULL AND ra.status = 'planned'
         AND ra.delegated_at IS NULL   -- 0126: la delegada no se ofrece
         -- 0165: con el despacho encendido, una llegada en espera se ofrece cuando ya
         -- está por salir (despacho_tomable). 0166: también al que tiene el apoyo.
         AND (ra.direction <> 'airport_to_home' OR NOT public.despacho_encendido() OR public.despacho_tomable(ra.id))
         AND ra.planned_start_at >= now() - interval '1 hour'
         AND ra.planned_start_at <  now() + interval '40 hours'
    ) z), '[]'::jsonb);
END;
$$;

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
  v_espera boolean := false;   -- 0165: era una llegada en espera del despacho
  v_quien  text;               -- 0165
  v_apoyo  boolean := false;   -- 0166: la tomó el que tiene el carro de apoyo
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  -- 0165: con el despacho encendido una llegada en espera SÍ se puede tomar, pero
  -- solo cuando ya está por salir (no la noche anterior: regla del 10-nov).
  -- 0166: el que tiene el carro de apoyo también (Harold: «si necesitamos un apoyo
  -- el sistema se las asigna… él debería poder verlas»); como ese carro se paga por
  -- vuelta, los jefes se enteran cada vez que toma una (abajo).
  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x
       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NULL) THEN
    IF NOT public.despacho_tomable(p_route) THEN
      RAISE EXCEPTION 'Todavía no: esta llegada se puede tomar cuando falten 40 min o menos para que salga de JMC' USING ERRCODE = 'P0001';
    END IF;
    v_espera := true;
  END IF;
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
  -- 0165: queda escrito que la tomó un conductor. Con ese rastro el sistema no se
  -- la quita aunque se atrase (despacho_soltar_atrasadas): avisa a los jefes.
  IF v_espera THEN
    SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = ra.id;
    v_apoyo := v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(ra.organization_id, now());
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
    VALUES (ra.organization_id, ra.id, v_dp, 'tomada', ra.planned_start_at, 0, v_quien, jsonb_build_object('por', 'conductor', 'apoyo', v_apoyo));
    -- 0166: salió el carro de apoyo por decisión del conductor: los jefes se enteran.
    IF v_apoyo THEN
      SELECT pr.full_name INTO v_full FROM public.profiles pr WHERE pr.id = auth.uid();
      PERFORM public.trip_notify(j.profile_id, 'Salió el carro de apoyo 🚐',
        coalesce(public.short_name(v_full), 'El de apoyo') || ' tomó la llegada de ' || coalesce(v_quien, 'una persona') || ' en JMC a las ' || public.hm_bog(ra.planned_start_at) || '.',
        '/#/rutas', 'desp-apoyo-sale:' || ra.id::text || ':' || j.profile_id::text)
        FROM public.ops_alert_recipients_of(ra.organization_id) j;
    END IF;
  END IF;
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

COMMIT;
