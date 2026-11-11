-- =============================================================================
-- 0158 · Despacho de llegadas en StandBy + ajustes del optimizador V2
-- =============================================================================
-- (0155 = acomodo no cambia conductor, 0156 = eliminar mi cuenta, 0157 = horas de
-- apoyo: son de otras ramas; esta no las necesita ni las toca.)
--
-- POR QUÉ. Las llegadas se le daban a un carro la noche anterior, con la hora
-- PROGRAMADA del vuelo. Medido en producción (27–29 oct, 101 vuelos): 43 llegaron
-- 10 min o más ANTES, 22 más tarde, y el tripulante esperó 38 min de mediana desde
-- que aterrizó. Regla nueva (Harold, 10-nov): las llegadas quedan en espera
-- («para tomar», 0151) y el sistema las reparte cuando FlightRadar ya confirmó la
-- hora, al conductor que está o va a estar en el aeropuerto, sin hacer esperar.
--
-- QUÉ HACE
--   1. Ajustes del optimizador V2 (los lee admin-rutas.js; nacen APAGADOS).
--   2. Ajustes del despacho (nace APAGADO: despacho_activo = false).
--   3. arrival_dispatch_log: lo que el despacho decidió y por qué.
--   4. despacho_estado(): la foto que necesita el motor (llegadas en espera con la
--      hora en que sale cada una, conductores con turno abierto, dónde y cuándo
--      quedan libres, y su siguiente compromiso).
--   5. despacho_asignar() / despacho_avisar(): lo que el motor manda hacer.
--   6. despachar_llegadas() + cron cada 2 min: dispara la Edge Function
--      despacho-llegadas (el motor es rendio-turnos/despacho-llegadas.js, el mismo
--      que se midió con scripts/simular-despacho.mjs).
--
-- LO QUE NO HACE: no cambia la hora de la vuelta (de eso se sigue encargando
-- acomodar_eventualidades con FlightRadar), no junta dos vueltas en una (reparte
-- cada vuelta en espera como la publicó el jefe) y no toca las salidas.
--
-- PARA ENCENDER (después de desplegar la función y crear el secreto):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/despacho-llegadas', 'despacho_llegadas_url');
--   update app_settings set despacho_activo = true where id = 'singleton';
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Optimizador V2 (rtCfg en admin-rutas.js). 0 = como antes.
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_solver_v2       smallint NOT NULL DEFAULT 0;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_apoyo_car       smallint NOT NULL DEFAULT 0;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_buffer_flex_min smallint NOT NULL DEFAULT 0;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_band_factors    jsonb;
COMMENT ON COLUMN public.app_settings.route_solver_v2 IS
  '0158: 1 = el optimizador reparte por la hora en que arranca cada vuelta y reacomoda (huecos, mover tardes) antes de dejar a alguien sin carro. 0 = como antes.';
COMMENT ON COLUMN public.app_settings.route_apoyo_car IS
  '0158: 1 = si con los carros fijos queda alguien sin carro o tarde, el optimizador abre UN carro de apoyo solo con eso y dice en qué tramos. Requiere route_solver_v2.';
COMMENT ON COLUMN public.app_settings.route_buffer_flex_min IS
  '0158: minutos del colchón de entrega que el optimizador puede gastar antes de pedir apoyo (0 = ninguno).';
COMMENT ON COLUMN public.app_settings.route_band_factors IS
  '0158: tiempos por franja. Lista [{"from":0,"to":6,"f":0.8},…] en horas; f multiplica el manejo de esa franja. NULL = un solo tiempo todo el día.';

-- -----------------------------------------------------------------------------
-- 2. Despacho de llegadas
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS despacho_activo         boolean  NOT NULL DEFAULT false;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS despacho_horizonte_min  smallint NOT NULL DEFAULT 20;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS despacho_juntar_min     smallint NOT NULL DEFAULT 6;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS despacho_espera_max_min smallint NOT NULL DEFAULT 15;
COMMENT ON COLUMN public.app_settings.despacho_activo IS
  '0158: true = el sistema reparte solo las llegadas en espera (para tomar, sin conductor) cuando FlightRadar confirma la hora. Nace apagado.';
COMMENT ON COLUMN public.app_settings.despacho_horizonte_min IS
  '0158: minutos antes de que la persona salga del avión en que se le asigna carro. Más temprano no: el vuelo se puede mover.';
COMMENT ON COLUMN public.app_settings.despacho_juntar_min IS
  '0158: minutos que el primero que salió puede esperar a otro para irse juntos.';
COMMENT ON COLUMN public.app_settings.despacho_espera_max_min IS
  '0158: espera a partir de la cual se avisa a los jefes que esa llegada necesita apoyo.';
DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_despacho_rangos CHECK (
    despacho_horizonte_min BETWEEN 5 AND 90 AND despacho_juntar_min BETWEEN 0 AND 30
    AND despacho_espera_max_min BETWEEN 5 AND 60 AND route_buffer_flex_min BETWEEN 0 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

-- -----------------------------------------------------------------------------
-- 3. Lo que el despacho decidió
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arrival_dispatch_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_assignment_id  uuid        REFERENCES public.route_assignments(id) ON DELETE SET NULL,   -- sin CASCADE: el historial queda aunque se re-publique el día
  driver_profile_id    uuid        REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  kind                 text        NOT NULL,
  exit_at              timestamptz,             -- cuándo se calculó que salía la persona
  pickup_at            timestamptz,             -- cuándo la recoge el carro elegido
  wait_min             int,
  who                  text,                    -- nombres, para leerlo sin la vuelta
  detail               jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arrival_dispatch_log_kind_valid CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga'))
);
CREATE INDEX IF NOT EXISTS idx_arrival_dispatch_log_org_created ON public.arrival_dispatch_log(organization_id, created_at DESC);
DROP TRIGGER IF EXISTS tr_arrival_dispatch_log_set_updated_at ON public.arrival_dispatch_log;
CREATE TRIGGER tr_arrival_dispatch_log_set_updated_at BEFORE UPDATE ON public.arrival_dispatch_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.arrival_dispatch_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arrival_dispatch_log_admin_read ON public.arrival_dispatch_log;
CREATE POLICY arrival_dispatch_log_admin_read ON public.arrival_dispatch_log FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
COMMENT ON TABLE public.arrival_dispatch_log IS
  '0158: cada decisión del despacho de llegadas (a quién le dio la vuelta, o que nadie alcanzaba). Solo la escribe la base.';

-- -----------------------------------------------------------------------------
-- 4. La foto para el motor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.despacho_estado(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s record; o record;
  v_out jsonb := '[]'::jsonb; v_lle jsonb; v_car jsonb;
  v_ap_lat double precision; v_ap_lng double precision;
BEGIN
  SELECT coalesce(despacho_activo, false) AS on_, coalesce(despacho_horizonte_min, 20) AS hor,
         coalesce(despacho_juntar_min, 6) AS jun, coalesce(despacho_espera_max_min, 15) AS esp,
         coalesce(route_default_capacity, 4) AS cap, coalesce(route_service_min, 2) AS srv,
         coalesce(route_traffic_factor, 1.25) AS traf
    INTO s FROM public.app_settings WHERE id = 'singleton';
  IF NOT coalesce(s.on_, false) THEN RETURN v_out; END IF;

  FOR o IN
    SELECT DISTINCT ra.organization_id AS org
      FROM public.route_assignments ra
     WHERE ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
       AND ra.status = 'planned' AND ra.delegated_at IS NULL AND ra.organization_id IS NOT NULL
       AND ra.planned_start_at BETWEEN p_now - interval '3 hours' AND p_now + interval '4 hours'
  LOOP
    SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng
      FROM public.airports a WHERE a.organization_id = o.org ORDER BY a.created_at LIMIT 1;
    v_ap_lat := coalesce(v_ap_lat, 6.1708); v_ap_lng := coalesce(v_ap_lng, -75.4279);

    -- Llegadas en espera: una por vuelta, tal como la publicó el jefe. `sale` es
    -- cuando sale el ÚLTIMO de la vuelta: aterrizaje (FlightRadar si lo hay, si no
    -- la hora de la reserva) + desembarque de su aerolínea; en tierra o de reserva,
    -- la hora de la reserva tal cual; un «sin cuenta», la hora de la vuelta.
    SELECT coalesce(jsonb_agg(q.x ORDER BY q.sale), '[]'::jsonb) INTO v_lle
      FROM (
        SELECT t.sale, jsonb_build_object('ra', ra.id, 'sale', t.sale, 'pax', t.pax,
                                          'lat', t.lat, 'lng', t.lng, 'quien', t.quien) AS x
          FROM public.route_assignments ra
          JOIN LATERAL (
            SELECT count(*)::int AS pax,
                   bool_and(rs.status = 'pending') AS intacta,
                   max(CASE
                         WHEN r.id IS NULL THEN ra.planned_start_at
                         WHEN nullif(trim(r.flight_code), '') IS NULL OR coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL
                           THEN r.required_arrival_at
                         ELSE coalesce(public.reub_baja(o.org, r.flight_code, r.required_arrival_at), r.required_arrival_at)
                              + make_interval(mins => coalesce(public.flight_deplane_min(r.flight_code), 20))
                       END) AS sale,
                   (array_agg(coalesce(r.pickup_latitude, rs.guest_lat) ORDER BY rs.stop_order DESC))[1] AS lat,
                   (array_agg(coalesce(r.pickup_longitude, rs.guest_lng) ORDER BY rs.stop_order DESC))[1] AS lng,
                   string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) AS quien
              FROM public.route_stops rs
              LEFT JOIN public.reservations r        ON r.id = rs.reservation_id
              LEFT JOIN public.auxiliar_profiles ap  ON ap.id = r.auxiliar_profile_id
              LEFT JOIN public.profiles pr           ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id
               AND (rs.reservation_id IS NULL OR r.cancelled_at IS NULL)
          ) t ON true
         WHERE ra.organization_id = o.org
           AND ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
           AND ra.status = 'planned' AND ra.delegated_at IS NULL
           AND ra.planned_start_at BETWEEN p_now - interval '3 hours' AND p_now + interval '4 hours'
           AND t.pax > 0 AND t.intacta AND t.sale IS NOT NULL
           AND t.sale > p_now - interval '90 minutes'          -- lo muy viejo ya es de un jefe, no del despacho
      ) q;

    -- Conductores con turno abierto: cuándo y dónde quedan libres (cadena_libre,
    -- 0152: su vuelta anterior o el GPS reciente) y su siguiente compromiso (la
    -- primera parada pendiente de su próxima vuelta; si es una llegada, JMC).
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'dp', d.dp, 'cupo', d.cupo, 'known', d.known, 'free_at', d.free_at,
             'lat', d.lat, 'lng', d.lng, 'air', d.air, 'salida', d.salida)), '[]'::jsonb) INTO v_car
      FROM (
        SELECT DISTINCT ON (sh.driver_id)
               sh.driver_id AS dp,
               least(coalesce(v.capacity, s.cap), 4) AS cupo,
               coalesce(l.known, false) AS known,
               greatest(coalesce(l.free_at, p_now), p_now) AS free_at,
               l.lat, l.lng, coalesce(l.air, false) AS air,
               (SELECT jsonb_build_object(
                         'eta', CASE WHEN n.direction = 'airport_to_home' THEN n.planned_start_at ELSE coalesce(rs.estimated_arrival_at, n.planned_start_at) END,
                         'air', n.direction = 'airport_to_home',
                         'lat', CASE WHEN n.direction = 'airport_to_home' THEN v_ap_lat ELSE coalesce(r.pickup_latitude, rs.guest_lat) END,
                         'lng', CASE WHEN n.direction = 'airport_to_home' THEN v_ap_lng ELSE coalesce(r.pickup_longitude, rs.guest_lng) END)
                  FROM public.route_assignments n
                  JOIN public.route_stops rs ON rs.route_assignment_id = n.id
                  LEFT JOIN public.reservations r ON r.id = rs.reservation_id
                 WHERE n.driver_profile_id = sh.driver_id AND n.status = 'planned' AND n.delegated_at IS NULL
                   AND n.planned_start_at > p_now AND n.planned_start_at < p_now + interval '6 hours'
                   AND rs.status = 'pending'
                 ORDER BY n.planned_start_at, rs.stop_order LIMIT 1) AS salida
          FROM public.shifts sh
          LEFT JOIN public.vehicles v ON v.id = sh.vehicle_id
          LEFT JOIN LATERAL public.cadena_libre(sh.driver_id, NULL, p_now + interval '1 minute') l ON true
         WHERE sh.organization_id = o.org
           AND sh.status::text IN ('active', 'closing')
           AND sh.start_at > p_now - interval '16 hours'
         ORDER BY sh.driver_id, sh.start_at DESC
      ) d;

    v_out := v_out || jsonb_build_object(
      'org', o.org, 'ahora', p_now,
      'aeropuerto', jsonb_build_object('lat', v_ap_lat, 'lng', v_ap_lng),
      'cfg', jsonb_build_object('horizonte', s.hor, 'juntar', s.jun, 'esperaMax', s.esp, 'servicio', s.srv, 'trafico', s.traf),
      'llegadas', v_lle, 'carros', v_car);
  END LOOP;
  RETURN v_out;
END;
$$;
COMMENT ON FUNCTION public.despacho_estado(timestamptz) IS
  '0158: la foto para el motor de despacho: por organización, las llegadas en espera (con la hora en que sale la persona) y los conductores con turno abierto (cuándo/dónde quedan libres y su siguiente compromiso). Vacía si despacho_activo está apagado.';

-- -----------------------------------------------------------------------------
-- 5. Lo que el motor manda hacer
-- -----------------------------------------------------------------------------
-- Darle una llegada en espera a un conductor. Misma puerta que driver_take_route
-- (0151): solo si sigue en espera, sin conductor y sin delegar; si alguien se
-- adelantó (un conductor la tomó, un jefe la asignó) no hace nada y devuelve false.
CREATE OR REPLACE FUNCTION public.despacho_asignar(p_ra uuid, p_dp uuid, p_recoge timestamptz, p_sale timestamptz, p_espera int DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments%ROWTYPE;
  c record;
  v_prof uuid; v_nom text; v_pl text; v_quien text;
BEGIN
  IF p_ra IS NULL OR p_dp IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE id = 'singleton' AND despacho_activo) THEN RETURN false; END IF;
  SELECT dp.profile_id, split_part(pr.full_name, ' ', 1) INTO v_prof, v_nom
    FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;

  UPDATE public.route_assignments
     SET driver_profile_id = p_dp, updated_at = now()
   WHERE id = p_ra AND pool AND driver_profile_id IS NULL AND status = 'planned'
     AND delegated_at IS NULL AND direction = 'airport_to_home'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = p_ra AND rs.status <> 'pending')
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN RETURN false; END IF;

  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;      -- con el carro de su turno (0124)
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
    FROM public.route_stops rs
    LEFT JOIN public.reservations r ON r.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = ra.id;

  -- Al conductor: qué, a quién y a qué hora.
  PERFORM public.trip_notify(v_prof, 'Llegada para ti ✈️',
    'Recoge en JMC a las ' || public.hm_bog(coalesce(p_recoge, ra.planned_start_at)) || ': ' || coalesce(v_quien, 'una llegada') || '.',
    '/#/rutas', 'desp:' || ra.id::text || ':' || p_dp::text);
  -- A cada tripulante: quién lo recoge (mismo texto que cuando un conductor la toma).
  FOR c IN
    SELECT r.id, ap.profile_id AS crew
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_nom, 'Tu conductor') || ' te recoge 🚗',
      'Te espera ' || coalesce(public.lugar_del_regreso(c.id), 'en JMC cuando aterrices') || coalesce(' (carro ' || v_pl || ')', '') || '.',
      '/#/viaje?r=' || c.id::text, 'desp-tr:' || ra.id::text || ':' || p_dp::text || ':' || c.id::text);
  END LOOP;

  INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, exit_at, pickup_at, wait_min, who)
  VALUES (ra.organization_id, ra.id, p_dp, 'asignada', p_sale, p_recoge, greatest(coalesce(p_espera, 0), 0), v_quien);
  PERFORM public.trip_kick();
  RETURN true;
END;
$$;
COMMENT ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) IS
  '0158: el despacho le da una llegada en espera a un conductor (solo si sigue sin conductor y sin tocar), avisa al conductor y a los tripulantes y deja el rastro. Solo servidor.';

-- Nadie alcanza (o alcanza con mucha espera): UN aviso por vuelta a los jefes.
CREATE OR REPLACE FUNCTION public.despacho_avisar(p_ra uuid, p_tipo text, p_sale timestamptz, p_espera int DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments%ROWTYPE;
  j record; v_n int := 0; v_quien text;
BEGIN
  IF p_tipo NOT IN ('sin_carro', 'espera_larga') THEN RETURN 0; END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_ra;
  IF ra.id IS NULL OR ra.organization_id IS NULL THEN RETURN 0; END IF;
  SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
    FROM public.route_stops rs
    LEFT JOIN public.reservations r ON r.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = ra.id;
  FOR j IN SELECT profile_id FROM public.ops_alert_recipients_of(ra.organization_id) LOOP
    IF public.trip_notify(j.profile_id, 'Una llegada necesita apoyo ⚠️',
         coalesce(v_quien, 'Una llegada') || ' sale de JMC a las ' || public.hm_bog(coalesce(p_sale, ra.planned_start_at))
         || CASE WHEN p_tipo = 'sin_carro' THEN ' y ningún conductor en turno alcanza a recogerla.'
                 ELSE ' y el carro más cercano la haría esperar ' || coalesce(p_espera, 0)::text || ' min.' END
         || ' Manda apoyo o asígnala en Asignación.',
         '/#/rutas', 'desp-apoyo:' || ra.id::text || ':' || j.profile_id::text) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n > 0 THEN
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, kind, exit_at, wait_min, who)
    VALUES (ra.organization_id, ra.id, p_tipo, p_sale, p_espera, v_quien);
    PERFORM public.trip_kick();
  END IF;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION public.despacho_avisar(uuid, text, timestamptz, int) IS
  '0158: avisa UNA vez por vuelta a los jefes que una llegada en espera no tiene quién la recoja a tiempo. Solo servidor.';

-- -----------------------------------------------------------------------------
-- 6. El disparo (igual que poll_flight_status, 0118)
-- -----------------------------------------------------------------------------
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
COMMENT ON FUNCTION public.despachar_llegadas() IS
  '0158: la llama pg_cron cada 2 min: si el despacho está encendido y hay llegadas en espera, dispara la Edge Function despacho-llegadas (URL y llave del Vault).';

-- -----------------------------------------------------------------------------
-- 7. Permisos: todo esto es del servidor
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.despacho_estado(timestamptz)',
    'public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int)',
    'public.despacho_avisar(uuid, text, timestamptz, int)',
    'public.despachar_llegadas()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 8. Cada 2 minutos
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'despachar-llegadas';
  PERFORM cron.schedule('despachar-llegadas', '*/2 * * * *', $job$SELECT public.despachar_llegadas();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): despachar_llegadas queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
