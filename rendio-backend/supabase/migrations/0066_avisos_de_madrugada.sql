-- 0066_avisos_de_madrugada.sql
--
-- QUE LA BASE AVISE SOLA.
--
-- El bloque anterior (0062/0063) dejó a los conductores y a los tripulantes
-- reportando, y el aviso al jefe sale del celular de quien reporta: cuando una
-- persona aprieta un botón, su app está despierta. Pero las eventualidades que
-- NADIE reporta —el carro que se va quedando atrás, el tripulante que no bajó—
-- solo las ve la base, y a las 4 de la mañana no hay ninguna app abierta que
-- pueda mandar el push por ella.
--
-- POR QUÉ NO SE LLAMA A `send-push` DIRECTO DESDE EL CRON:
-- esa Edge Function exige un JWT de USUARIO (hace `auth.getUser`), y la llave de
-- servicio no es un usuario: le devolvería 401. Y pg_net no lanza excepciones —
-- encola la petición y la respuesta cae en `net._http_response`, que nadie lee—.
-- O sea que la falla sería invisible: daríamos por hecho que el aviso quedó
-- programado, el teléfono no sonaría, y en los logs no habría ni un error. Eso es
-- exactamente lo que no se puede permitir en una falla mecánica de madrugada.
--
-- LA FORMA QUE SÍ AGUANTA: bandeja de salida + la función de despacho JALA.
--   1. Los detectores escriben en `notification_outbox` en SQL puro. Toda la
--      lógica de CUÁNDO se avisa se prueba sin HTTP, sin VAPID y sin teléfono.
--   2. El cron hace UNA llamada de disparo a `dispatch-notifications`.
--   3. Esa función lee la bandeja con la llave de servicio, manda los push y
--      escribe el resultado — `sent_at` si salió, `last_error` si no.
-- Si el disparo se pierde, las filas siguen pendientes y `ops_alert_health()` lo
-- dice. Nada se marca como enviado sin que alguien lo haya visto salir.

-- -----------------------------------------------------------------------------
-- 1. pg_net (el único camino del servidor hacia afuera)
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net no se pudo instalar (%). La bandeja de salida se llena igual; solo no se despacha sola.', SQLERRM;
  END;
END
$do$;

-- -----------------------------------------------------------------------------
-- 2. Parámetros (Ajustes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  -- El vigilante marca riesgo a los 10 min (0053). Eso sirve para pintar un
  -- aviso en pantalla, pero no para despertar a alguien: hay que dejar margen a
  -- que el carro se ponga al día solo. A los 20 ya no se pone al día.
  ADD COLUMN IF NOT EXISTS route_risk_incident_min smallint NOT NULL DEFAULT 20,
  -- Minutos DESPUÉS de vencerse la espera pactada para avisar que el tripulante
  -- no bajó. La espera ya es un colchón; esto es el colchón del colchón.
  ADD COLUMN IF NOT EXISTS aux_noshow_alert_min    smallint NOT NULL DEFAULT 3;

COMMENT ON COLUMN public.app_settings.route_risk_incident_min
  IS 'Minutos de retraso a partir de los cuales un riesgo de ruta se vuelve una eventualidad que suena en el celular del jefe. Debe ser mayor que route_risk_threshold_min.';
COMMENT ON COLUMN public.app_settings.aux_noshow_alert_min
  IS 'Minutos después de cumplirse la espera pactada para avisar que el tripulante no ha bajado.';

DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_risk_incident_range
    CHECK (route_risk_incident_min BETWEEN 1 AND 240);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_noshow_alert_range
    CHECK (aux_noshow_alert_min BETWEEN 0 AND 60);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

-- -----------------------------------------------------------------------------
-- 3. A quién le suena
--    No existe el rol "jefe": `admin` incluye a los coordinadores. Se avisa a
--    quien esté marcado en Personal; y si NADIE está marcado, a todos los admins
--    activos. Una operación sin nadie marcado no puede quedarse muda: ese es
--    justo el problema que vinimos a resolver.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_alert_recipients()
RETURNS TABLE (profile_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_marcados integer;
BEGIN
  SELECT count(*) INTO v_marcados
  FROM public.profiles
  WHERE role = 'admin' AND deleted_at IS NULL
    AND is_active IS DISTINCT FROM false AND receives_ops_alerts;

  IF v_marcados > 0 THEN
    RETURN QUERY
      SELECT p.id FROM public.profiles p
      WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND p.is_active IS DISTINCT FROM false AND p.receives_ops_alerts;
  ELSE
    RETURN QUERY
      SELECT p.id FROM public.profiles p
      WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND p.is_active IS DISTINCT FROM false;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.ops_alert_recipients()
  IS 'Admins que reciben avisos de operación. Si nadie está marcado en Personal, caen todos los admins activos.';

-- -----------------------------------------------------------------------------
-- 4. Encolar un aviso
--    Una fila por destinatario. `dedupe_key` evita que la misma eventualidad le
--    llegue doce veces a la misma persona porque el detector corre cada 5 min.
-- -----------------------------------------------------------------------------
-- Cuándo se ENCOLÓ el aviso. La entrega real la sella notification_outbox.sent_at:
-- son dos cosas distintas y confundirlas es lo que hace que un canal caído se vea
-- igual que un día tranquilo.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS notified_at timestamptz;
COMMENT ON COLUMN public.incidents.notified_at
  IS 'Cuándo se encoló el aviso a los jefes. La entrega real la sella notification_outbox.sent_at.';

CREATE OR REPLACE FUNCTION public.enqueue_incident_alert(p_incident_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_titulo text;
  v_cuerpo text;
  v_n      integer := 0;
  v_inc    record;
BEGIN
  SELECT i.id, i.category, i.severity, i.description,
         v.internal_code, v.license_plate,
         pr.full_name AS pax
    INTO v_inc
  FROM public.incidents i
  LEFT JOIN public.vehicles v ON v.id = i.vehicle_id
  LEFT JOIN public.reservations r ON r.id = i.reservation_id
  LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
  WHERE i.id = p_incident_id;

  IF v_inc.id IS NULL THEN RETURN 0; END IF;

  v_titulo := CASE v_inc.category
    WHEN 'driver_late'         THEN 'Un carro va muy atrasado'
    WHEN 'aux_not_ready'       THEN 'Un tripulante no ha bajado'
    WHEN 'aux_emergency'       THEN 'Emergencia de un tripulante'
    WHEN 'vehicle_problem'     THEN 'Falla mecánica'
    WHEN 'traffic'             THEN 'Trancón reportado'
    WHEN 'needs_third_vehicle' THEN 'Necesitamos un tercer vehículo'
    ELSE 'Novedad en la operación'
  END;
  IF v_inc.severity = 'high' THEN v_titulo := '🚨 ' || v_titulo; END IF;

  v_cuerpo := COALESCE(v_inc.description, '');
  IF v_inc.internal_code IS NOT NULL THEN
    v_cuerpo := v_inc.internal_code || ' · ' || v_cuerpo;
  END IF;
  -- El nombre del tripulante solo se agrega si el texto no lo dice ya. Algunas
  -- descripciones lo llevan adentro ("Ana no ha bajado…") y repetirlo al final
  -- se lee como un error del sistema.
  IF v_inc.pax IS NOT NULL AND position(split_part(v_inc.pax, ' ', 1) in v_cuerpo) = 0 THEN
    v_cuerpo := v_cuerpo || ' (' || split_part(v_inc.pax, ' ', 1) || ')';
  END IF;
  v_cuerpo := left(v_cuerpo, 280);

  INSERT INTO public.notification_outbox (profile_id, incident_id, title, body, url, dedupe_key)
  SELECT r.profile_id, p_incident_id, v_titulo, v_cuerpo,
         '/#/eventualidades?ev=' || p_incident_id::text,
         'inc:' || p_incident_id::text || ':' || r.profile_id::text
  FROM public.ops_alert_recipients() r
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.incidents SET notified_at = COALESCE(notified_at, now()) WHERE id = p_incident_id;
  RETURN v_n;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. El detector de eventualidades de operación
--
--    Dos señales, que son cosas distintas y el jefe decide distinto en cada una:
--
--    (a) EL CARRO NO ALCANZA — se apoya en `route_stop_risks` (0053), que ya
--        está probado. Solo se promueve a eventualidad cuando cruza un umbral
--        más alto: a los 10 min el carro todavía se pone al día solo.
--
--    (b) EL TRIPULANTE NO BAJÓ — esta señal no existía. El vigilante de 0053
--        solo mira paradas PENDIENTES: en cuanto el conductor marca "Llegué", la
--        parada pasa a `arrived` y el vigilante deja de verla, justo cuando
--        empieza el problema que la operación describió ("retraso de un
--        tripulante en casa"). Aquí se mira lo contrario: paradas donde el carro
--        YA está en la puerta y la espera pactada se venció.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_ops_events()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_umbral  smallint;
  v_espera  smallint;
  v_colchon smallint;
  v_org     uuid;
  v_nuevas  integer := 0;
  r         record;
  v_id      uuid;
BEGIN
  SELECT COALESCE(route_risk_incident_min, 20), COALESCE(aux_wait_minutes, 5),
         COALESCE(aux_noshow_alert_min, 3)
    INTO v_umbral, v_espera, v_colchon
  FROM public.app_settings WHERE id = 'singleton';
  v_umbral := COALESCE(v_umbral, 20); v_espera := COALESCE(v_espera, 5); v_colchon := COALESCE(v_colchon, 3);

  -- (a) Riesgos de ruta que ya son graves ------------------------------------
  FOR r IN
    SELECT k.route_stop_id, k.reservation_id, k.minutes_late, k.distance_km,
           ra.id AS ra_id, ra.vehicle_id, dp.profile_id AS driver_profile,
           pr.full_name AS conductor, r2.organization_id
    FROM public.route_stop_risks k
    JOIN public.route_stops rs        ON rs.id = k.route_stop_id
    JOIN public.route_assignments ra  ON ra.id = rs.route_assignment_id
    JOIN public.reservations res      ON res.id = k.reservation_id
    JOIN public.auxiliar_profiles ap  ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles r2           ON r2.id = ap.profile_id
    LEFT JOIN public.driver_profiles dp ON dp.id = k.driver_profile_id
    LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
    WHERE k.resolved_at IS NULL
      AND k.minutes_late >= v_umbral
      AND NOT EXISTS (
        SELECT 1 FROM public.incidents i
        WHERE i.dedupe_key = 'risk:' || k.route_stop_id::text AND i.resolved_at IS NULL)
  LOOP
    INSERT INTO public.incidents (
      organization_id, reporter_id, vehicle_id, reservation_id,
      route_assignment_id, route_stop_id, category, severity, status,
      description, scope, source, details, dedupe_key, occurred_at)
    VALUES (
      r.organization_id, NULL, r.vehicle_id, r.reservation_id,
      r.ra_id, r.route_stop_id, 'driver_late', 'high', 'open',
      COALESCE(r.conductor, 'El conductor') || ' no alcanza esta recogida por ~' ||
        r.minutes_late || ' min' ||
        CASE WHEN r.distance_km IS NOT NULL THEN ' (está a ' || r.distance_km || ' km)' ELSE '' END || '.',
      'operacion', 'system',
      jsonb_build_object('minutes_late', r.minutes_late, 'distance_km', r.distance_km),
      'risk:' || r.route_stop_id::text, now())
    RETURNING id INTO v_id;

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

  -- (b) El carro está en la puerta y el tripulante no baja -------------------
  FOR r IN
    SELECT rs.id AS stop_id, rs.reservation_id, rs.actual_arrival_at,
           ra.id AS ra_id, ra.vehicle_id,
           pr.full_name AS pax, pr.organization_id
    FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    JOIN public.reservations res     ON res.id = rs.reservation_id
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    WHERE ra.status = 'in_progress'
      AND rs.status = 'arrived'
      AND res.cancelled_at IS NULL
      AND res.direction = 'home_to_airport'
      AND rs.actual_arrival_at IS NOT NULL
      AND rs.actual_arrival_at < now() - make_interval(mins => (v_espera + v_colchon)::int)
      AND NOT EXISTS (
        SELECT 1 FROM public.incidents i
        WHERE i.dedupe_key = 'wait:' || rs.id::text AND i.resolved_at IS NULL)
  LOOP
    INSERT INTO public.incidents (
      organization_id, reporter_id, vehicle_id, reservation_id,
      route_assignment_id, route_stop_id, category, severity, status,
      description, scope, source, details, dedupe_key, occurred_at)
    VALUES (
      r.organization_id, NULL, r.vehicle_id, r.reservation_id,
      r.ra_id, r.stop_id, 'aux_not_ready', 'medium', 'open',
      COALESCE(split_part(r.pax, ' ', 1), 'El tripulante') ||
        ' no ha bajado: el carro lleva más de ' || (v_espera + v_colchon) ||
        ' min esperando en la puerta.',
      'operacion', 'system',
      jsonb_build_object('esperando_desde', r.actual_arrival_at),
      'wait:' || r.stop_id::text, now())
    RETURNING id INTO v_id;

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

  -- (c) Se cierran solas cuando la realidad las desmiente ---------------------
  -- Una alerta que no se cierra sola deja de creerse (misma regla que 0053).
  UPDATE public.incidents i
     SET status = 'resolved', resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes, 'Se resolvió sola: la parada se atendió o la ruta terminó.')
   WHERE i.resolved_at IS NULL
     AND i.source = 'system'
     AND i.dedupe_key LIKE 'risk:%'
     AND NOT EXISTS (
       SELECT 1 FROM public.route_stop_risks k
       WHERE k.route_stop_id = i.route_stop_id AND k.resolved_at IS NULL);

  UPDATE public.incidents i
     SET status = 'resolved', resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes, 'Se resolvió sola: el tripulante subió o se marcó que no se presentó.')
   WHERE i.resolved_at IS NULL
     AND i.source = 'system'
     AND i.dedupe_key LIKE 'wait:%'
     AND NOT EXISTS (
       SELECT 1 FROM public.route_stops rs
       WHERE rs.id = i.route_stop_id AND rs.status = 'arrived');

  RETURN v_nuevas;
END;
$$;

COMMENT ON FUNCTION public.detect_ops_events()
  IS 'Convierte en eventualidades las dos señales que nadie reporta: el carro que ya no alcanza y el tripulante que no bajó. Encola el aviso y cierra solas las que dejan de aplicar.';

-- -----------------------------------------------------------------------------
-- 6. El disparo del despacho
--    Solo dispara: quien lee la bandeja, manda los push y escribe el resultado
--    es la Edge Function `dispatch-notifications`. Así la falla queda escrita en
--    `last_error` en vez de perderse en el aire de pg_net.
--
--    La URL y la llave viven en Vault (scripts/_set-vault-secrets.mjs), nunca en
--    una migración: esto se commitea.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drain_notification_outbox()
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url  text;
  v_key  text;
  v_pend integer;
BEGIN
  SELECT count(*) INTO v_pend FROM public.notification_outbox
   WHERE sent_at IS NULL AND send_after <= now() AND attempts < 5;
  IF v_pend = 0 THEN RETURN 'sin pendientes'; END IF;

  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'dispatch_notifications_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'vault no disponible: ' || SQLERRM;
  END;

  IF v_url IS NULL OR v_key IS NULL THEN
    -- Se dice en voz alta en vez de fallar callado: las filas siguen pendientes
    -- y ops_alert_health() lo reporta.
    RETURN 'faltan secretos en Vault (dispatch_notifications_url / service_role_key)';
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('trigger', 'cron'),
    timeout_milliseconds := 8000
  );
  RETURN 'disparado con ' || v_pend || ' pendientes';
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Salud del canal de avisos
--    Si el despacho se cae, hay que poder VERLO. Sin esto, "no llegó ninguna
--    alerta" y "no pasó nada" se ven exactamente igual.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_alert_health()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'pendientes',      (SELECT count(*) FROM public.notification_outbox WHERE sent_at IS NULL),
    'atascados',       (SELECT count(*) FROM public.notification_outbox WHERE sent_at IS NULL AND attempts >= 5),
    'mas_viejo_min',   (SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - min(created_at))) / 60)::int, 0)
                          FROM public.notification_outbox WHERE sent_at IS NULL),
    'ultimo_envio',    (SELECT max(sent_at) FROM public.notification_outbox),
    'destinatarios',   (SELECT count(*) FROM public.ops_alert_recipients())
  );
$$;

REVOKE ALL    ON FUNCTION public.ops_alert_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_alert_health() TO authenticated;

COMMENT ON FUNCTION public.ops_alert_health()
  IS 'Estado del canal de avisos: si "mas_viejo_min" crece, el despacho está caído y los jefes no se están enterando de nada.';

-- -----------------------------------------------------------------------------
-- 8. Los relojes
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('detect-ops-events');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.unschedule('drain-notification-outbox');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  -- Detectar cada 5 min, igual que el vigilante en el que se apoya.
  PERFORM cron.schedule('detect-ops-events', '*/5 * * * *',
    $job$SELECT public.detect_ops_events();$job$);
  -- Despachar cada minuto: un aviso de madrugada que llega 5 minutos tarde ya no
  -- sirve de mucho.
  PERFORM cron.schedule('drain-notification-outbox', '* * * * *',
    $job$SELECT public.drain_notification_outbox();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): los detectores quedan creados pero nadie los llama.', SQLERRM;
END
$do$;
