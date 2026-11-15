-- Down de 0163: todo vuelve a como lo dejó 0162 (funciones tal cual sus fuentes).
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

CREATE OR REPLACE FUNCTION public.admin_set_support_duty(p_day date, p_band text, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v_dp uuid;
BEGIN
  IF v_org IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo Coordinación puede definir el apoyo' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_band NOT IN ('am', 'pm') THEN
    RAISE EXCEPTION 'Falta el día o el turno' USING ERRCODE = 'P0001';
  END IF;
  IF p_driver IS NULL THEN
    DELETE FROM public.support_duty WHERE organization_id = v_org AND day = p_day AND band = p_band;
    RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', NULL);
  END IF;
  -- Acepta el id del conductor o el de su perfil: el tablero usa uno u otro.
  SELECT dp.id INTO v_dp FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id
   WHERE (dp.id = p_driver OR dp.profile_id = p_driver) AND pr.organization_id = v_org AND pr.deleted_at IS NULL LIMIT 1;
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Ese conductor no es de tu organización' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id, set_by)
  VALUES (v_org, p_day, p_band, v_dp, auth.uid())
  ON CONFLICT (organization_id, day, band) DO UPDATE SET driver_profile_id = EXCLUDED.driver_profile_id, set_by = EXCLUDED.set_by, updated_at = now();
  RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', v_dp);
END;
$$;

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

DROP FUNCTION IF EXISTS public.despacho_soltar_atrasadas();
DROP FUNCTION IF EXISTS public.apoyo_avisar(uuid, date, text, boolean);
DROP FUNCTION IF EXISTS public.despacho_encendido();
DELETE FROM public.arrival_dispatch_log WHERE kind = 'devuelta';
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga'));

COMMIT;
