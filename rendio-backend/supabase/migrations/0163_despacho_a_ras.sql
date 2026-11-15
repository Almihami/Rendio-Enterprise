-- =============================================================================
-- 0163 · Despacho de llegadas «a ras»: lo que faltaba para operar de verdad
-- =============================================================================
-- Harold, 15-nov: «arregla lo necesario para que la operación funcione». Revisión
-- del código de dev antes de pasarlo a producción. Tres huecos:
--
--   1. LAS LLEGADAS EN ESPERA SE PODÍAN TOMAR A MANO. Son las mismas «vueltas para
--      tomar» (0125/0151): al publicar, a los conductores del turno les sonaba
--      «Hay una vuelta para tomar» y las veían con «Tomar» hasta 40 h antes. Si
--      uno la tomaba, el sistema ya no la repartía con la hora del vuelo (regla
--      del 10-nov: las llegadas NO se asignan la noche anterior). Con el despacho
--      encendido: no salen en la lista, no se toman, no suenan, y la que el
--      sistema ya dio no se suelta desde la app (la cambia Coordinación).
--      despacho_encendido() nuevo; driver_open_routes DESDE 0138, driver_take_route
--      DESDE 0151, driver_release_route y avisar_vuelta_para_tomar DESDE 0144.
--
--   2. EL DE APOYO NO SE ENTERABA. El jefe lo marcaba en Asignación y al conductor
--      no le llegaba nada hasta la primera llegada. Ahora admin_set_support_duty
--      (DESDE 0162) le avisa «Tienes el carro de apoyo» (y «Ya no lo tienes» al
--      que lo tenía). La tarjeta en su Inicio y la ubicación van en la app.
--
--   3. UNA LLEGADA YA REPARTIDA NADIE LA VOLVÍA A MIRAR. Si el conductor se atrasaba
--      con su vuelta anterior, solo salía la tarjeta «X no alcanza» (0152) cuando
--      un jefe tenía Asignación abierta. Ahora despacho_soltar_atrasadas() corre
--      antes de cada reparto: si al que la tiene le faltan 10 min o más y hay
--      otro que sí alcanza, la devuelve a la espera (una sola vez por vuelta) y el
--      motor la reparte en esa misma pasada; si nadie más alcanza, se queda con él
--      y los jefes se enteran. despachar_llegadas DESDE 0160.
--
-- Generada con scripts/_gen-0163.py. Lo próximo que toque estas funciones copia
-- DESDE 0163.
-- =============================================================================
BEGIN;

-- ¿Está encendido el despacho? Una sola pregunta para todas las funciones.
CREATE OR REPLACE FUNCTION public.despacho_encendido()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT a.despacho_activo FROM public.app_settings a WHERE a.id = 'singleton'), false);
$$;
COMMENT ON FUNCTION public.despacho_encendido() IS
  '0163: true si app_settings.despacho_activo. Con él encendido las llegadas en espera las reparte el sistema, no los conductores.';

-- ── 1. Las llegadas en espera no se toman a mano ────────────────────────────
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
  -- 0163: una llegada que reparte el sistema no se suelta desde la app: volvería a
  -- la espera y el sistema se la daría otra vez al mismo. La cambia Coordinación.
  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x
       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.driver_profile_id = v_dp) THEN
    RAISE EXCEPTION 'Esta llegada te la asignó el sistema. Si no puedes hacerla, avisa a Coordinación.' USING ERRCODE = 'P0001';
  END IF;
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

CREATE OR REPLACE FUNCTION public.avisar_vuelta_para_tomar(p_org uuid, p_start timestamptz, p_title text, p_desc text, p_key text,
                                                          p_except uuid DEFAULT NULL, p_jefes boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[]; v_n int := 0; t record;
  v_ra text;   -- 0163
BEGIN
  IF p_org IS NULL OR p_start IS NULL THEN RETURN 0; END IF;
  -- 0163: con el despacho encendido las LLEGADAS no se ofrecen a los conductores
  -- (ni «nadie del turno» a los jefes): las reparte el sistema, y si nadie
  -- alcanza es él quien avisa. Se reconoce por el texto («Llegada de las…») o
  -- por la vuelta que viene en la llave. Las salidas siguen igual.
  IF public.despacho_encendido() THEN
    v_ra := substring(p_key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');
    IF p_desc LIKE 'Llegada %'
       OR (v_ra IS NOT NULL AND EXISTS (SELECT 1 FROM public.route_assignments ra
                                         WHERE ra.id = v_ra::uuid AND ra.direction = 'airport_to_home')) THEN
      RETURN 0;
    END IF;
  END IF;
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

-- ── 2. El de apoyo se entera ────────────────────────────────────────────────
-- Aviso al conductor: tiene (o ya no tiene) el carro de apoyo de ese turno.
-- Los turnos de días que ya pasaron no avisan.
CREATE OR REPLACE FUNCTION public.apoyo_avisar(p_dp uuid, p_day date, p_band text, p_tiene boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof uuid;
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_cuando text; v_ok boolean;
BEGIN
  IF p_dp IS NULL OR p_day IS NULL OR p_day < v_hoy - 1 THEN RETURN false; END IF;
  SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;
  v_cuando := CASE WHEN p_day = v_hoy THEN 'Hoy' WHEN p_day = v_hoy + 1 THEN 'Mañana' WHEN p_day = v_hoy - 1 THEN 'Esta madrugada'
                   ELSE 'El ' || to_char(p_day, 'DD/MM') END
           || CASE WHEN p_band = 'am' THEN ', de 2:00 a. m. a 2:00 p. m.' ELSE ', de 2:00 p. m. a 2:00 a. m.' END;
  v_ok := public.trip_notify(v_prof,
    CASE WHEN p_tiene THEN 'Tienes el carro de apoyo 🚐' ELSE 'Ya no tienes el carro de apoyo' END,
    CASE WHEN p_tiene
         THEN v_cuando || '. Si los carros fijos no alcanzan con una llegada, te la mandamos aquí. Deja la app abierta para saber dónde estás.'
         ELSE v_cuando || ': Coordinación lo cambió.' END,
    '/#/', 'apoyo-duty:' || p_day::text || ':' || p_band || ':' || p_dp::text || ':' || p_tiene::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MI'));
  PERFORM public.trip_kick();
  RETURN coalesce(v_ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_support_duty(p_day date, p_band text, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v_dp uuid;
  v_prev uuid;   -- 0163: quién lo tenía
BEGIN
  IF v_org IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo Coordinación puede definir el apoyo' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_band NOT IN ('am', 'pm') THEN
    RAISE EXCEPTION 'Falta el día o el turno' USING ERRCODE = 'P0001';
  END IF;
  SELECT sd.driver_profile_id INTO v_prev FROM public.support_duty sd
   WHERE sd.organization_id = v_org AND sd.day = p_day AND sd.band = p_band;
  IF p_driver IS NULL THEN
    DELETE FROM public.support_duty WHERE organization_id = v_org AND day = p_day AND band = p_band;
    PERFORM public.apoyo_avisar(v_prev, p_day, p_band, false);   -- 0163
    RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', NULL);
  END IF;
  -- Acepta el id del conductor o el de su perfil: el tablero usa uno u otro.
  SELECT dp.id INTO v_dp FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id
   WHERE (dp.id = p_driver OR dp.profile_id = p_driver) AND pr.organization_id = v_org AND pr.deleted_at IS NULL LIMIT 1;
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Ese conductor no es de tu organización' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id, set_by)
  VALUES (v_org, p_day, p_band, v_dp, auth.uid())
  ON CONFLICT (organization_id, day, band) DO UPDATE SET driver_profile_id = EXCLUDED.driver_profile_id, set_by = EXCLUDED.set_by, updated_at = now();
  -- 0163: el conductor se entera (antes solo lo sabía el jefe).
  IF v_prev IS DISTINCT FROM v_dp THEN
    PERFORM public.apoyo_avisar(v_prev, p_day, p_band, false);
    PERFORM public.apoyo_avisar(v_dp, p_day, p_band, true);
  END IF;
  RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', v_dp);
END;
$$;

-- ── 3. Si el conductor asignado se atrasa ───────────────────────────────────
-- El rastro del despacho aprende una palabra: «devuelta».
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga', 'devuelta'));

-- Llegadas que el despacho ya repartió, que no han arrancado y arrancan ya: si a
-- su conductor le faltan 10 min o más (cadena_evaluar, 0152) y hay otro del turno
-- que sí alcanza, vuelven a la espera para que el motor las reparta de nuevo.
-- Una sola vez por vuelta (sin vaivén). Si nadie más alcanza, se queda con él y
-- los jefes se enteran (despacho_avisar no repite por la misma vuelta).
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
COMMENT ON FUNCTION public.despacho_soltar_atrasadas() IS
  '0163: devuelve a la espera las llegadas ya repartidas cuyo conductor viene 10+ min atrasado, si hay otro del turno que sí alcanza. Una vez por vuelta. La llama despachar_llegadas.';

CREATE OR REPLACE FUNCTION public.despachar_llegadas()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url text; v_key text; v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE id = 'singleton' AND despacho_activo) THEN
    RETURN 'apagado (app_settings.despacho_activo)';
  END IF;
  -- 0163: primero, las que ya se repartieron y cuyo conductor viene atrasado
  -- vuelven a la espera (si hay quién alcance). Nunca frena el reparto.
  BEGIN
    PERFORM public.despacho_soltar_atrasadas();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'despacho_soltar_atrasadas: %', SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM public.route_assignments ra
   WHERE ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
     AND ra.status = 'planned' AND ra.delegated_at IS NULL
     AND ra.planned_start_at BETWEEN now() - interval '3 hours' AND now() + interval '4 hours';
  IF v_n = 0 THEN RETURN 'sin llegadas en espera'; END IF;
  -- 0160: antes de repartir, las que siguen en espera quedan a la hora que dice el vuelo.
  PERFORM public.despacho_poner_horas();
  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'despacho_llegadas_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'vault no disponible: ' || SQLERRM;
  END;
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN 'faltan secretos en Vault: ' || concat_ws(', ', CASE WHEN v_url IS NULL THEN 'despacho_llegadas_url' END, CASE WHEN v_key IS NULL THEN 'service_role_key' END);
  END IF;
  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body    := jsonb_build_object('trigger', 'cron'),
      timeout_milliseconds := 60000
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN 'pg_net no disponible: ' || SQLERRM;
  END;
  RETURN 'disparado con ' || v_n || ' llegadas en espera';
END;
$$;

REVOKE ALL ON FUNCTION public.despacho_encendido() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_encendido() TO service_role;
REVOKE ALL ON FUNCTION public.apoyo_avisar(uuid, date, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apoyo_avisar(uuid, date, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_soltar_atrasadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_soltar_atrasadas() TO service_role;

COMMIT;
