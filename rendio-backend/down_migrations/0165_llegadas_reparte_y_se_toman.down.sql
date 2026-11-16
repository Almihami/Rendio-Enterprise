-- Reversa de 0165: las tres funciones vuelven a 0163 y el rastro olvida «tomada».
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
         -- 0163: con el despacho encendido las llegadas las reparte el sistema.
         AND NOT (ra.direction = 'airport_to_home' AND public.despacho_encendido())
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
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  -- 0163: con el despacho encendido una llegada en espera no se toma a mano (si
  -- alguien la toma la noche anterior, el sistema ya no la reparte con el vuelo).
  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x
       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NULL) THEN
    RAISE EXCEPTION 'Las llegadas las reparte el sistema cuando el vuelo confirma la hora' USING ERRCODE = 'P0001';
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

CREATE OR REPLACE FUNCTION public.despacho_soltar_atrasadas()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record; ev jsonb; v_late int; v_n int := 0;
  ra public.route_assignments%ROWTYPE;
  v_prof uuid; v_quien text;
BEGIN
  IF NOT public.despacho_encendido() THEN RETURN 0; END IF;
  FOR v IN
    SELECT x.id, x.driver_profile_id AS dp, x.planned_start_at AS ini
      FROM public.route_assignments x
     WHERE x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NOT NULL
       AND x.status = 'planned' AND x.delegated_at IS NULL AND x.organization_id IS NOT NULL
       AND x.planned_start_at BETWEEN now() - interval '20 minutes' AND now() + interval '25 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = x.id AND rs.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.arrival_dispatch_log g
                    WHERE g.route_assignment_id = x.id AND g.kind = 'asignada' AND g.driver_profile_id = x.driver_profile_id)
       AND NOT EXISTS (SELECT 1 FROM public.arrival_dispatch_log g WHERE g.route_assignment_id = x.id AND g.kind = 'devuelta')
     ORDER BY x.planned_start_at
  LOOP
    ev := public.cadena_evaluar(v.id, true);
    CONTINUE WHEN ev IS NULL OR NOT coalesce((ev->>'known')::boolean, false);
    v_late := coalesce((ev->>'late_min')::int, 0);
    CONTINUE WHEN v_late < 10;
    IF ev->'best' IS NULL OR jsonb_typeof(ev->'best') <> 'object' THEN
      PERFORM public.despacho_avisar(v.id, 'espera_larga', v.ini, v_late);
      CONTINUE;
    END IF;

    UPDATE public.route_assignments
       SET driver_profile_id = NULL, vehicle_id = NULL, updated_at = now()
     WHERE id = v.id AND driver_profile_id = v.dp AND status = 'planned'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = v.id AND rs.status <> 'pending')
    RETURNING * INTO ra;
    CONTINUE WHEN ra.id IS NULL;
    PERFORM public.route_sync_assigned(ra.id);

    SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = ra.id;
    SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = v.dp;
    IF v_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_prof, 'Ya no recoges esta llegada',
        'La llegada de las ' || public.hm_bog(v.ini) || coalesce(' (' || v_quien || ')', '')
          || ' pasa a otro conductor: vas atrasado con tu vuelta anterior.',
        '/#/ruta', 'desp-dev:' || ra.id::text || ':' || v.dp::text);
    END IF;
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
    VALUES (ra.organization_id, ra.id, v.dp, 'devuelta', v.ini, v_late, v_quien,
            jsonb_build_object('mejor', ev->'best'->>'dp', 'por_que', ev->>'why'));
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.despacho_soltar_atrasadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_soltar_atrasadas() TO service_role;
DROP FUNCTION IF EXISTS public.despacho_tomable(uuid);
DELETE FROM public.arrival_dispatch_log WHERE kind = 'tomada';
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga', 'devuelta'));
COMMIT;
