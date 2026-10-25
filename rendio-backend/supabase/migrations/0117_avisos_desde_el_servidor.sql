-- 0117 · Los avisos a los jefes salen del servidor, y send-push deja de mandar a cualquiera (25-oct-2026).
--
-- EL HUECO. Desde 0063 el push de un reporte humano (falla mecánica, trancón,
-- botón rojo del tripulante) lo intentaba mandar el CELULAR de quien reporta:
-- `notifyOps` (ui-push.js) buscaba a los jefes leyendo `profiles` y llamaba a
-- send-push. Pero la RLS de profiles solo deja a un conductor o a un tripulante
-- ver su propio perfil (y el del tripulante de su ruta), así que la lista salía
-- VACÍA y el aviso no salía nunca. En producción, incidents.notified_at estaba en
-- 0 para todas: los reportes quedaban en la bandeja de Eventualidades sin que a
-- ningún jefe le sonara el teléfono.
--
-- LO QUE HACE ESTA MIGRACIÓN
--
--   1. Todo reporte humano de operación (scope='operacion', source conductor o
--      tripulante) encola el aviso EN LA BASE, por el mismo camino de los
--      detectores (0066): enqueue_incident_alert → notification_outbox →
--      dispatch-notifications (el reloj de cada minuto). Va con un disparador
--      AFTER INSERT en incidents, así que no hay que acordarse de llamarlo en cada
--      RPC que reporte (hoy report_incident; mañana el que venga). El reporte del
--      jefe (source='admin') NO suena: es él mismo. Si encolar falla, el reporte
--      se guarda igual y notified_at queda vacío (se ve que no avisó).
--
--   2. enqueue_incident_alert = la de 0089 +
--        · los títulos que armaba el celular (15-oct-2026: el nombre de quien
--          reporta, porque «de un tripulante» no decía de quién):
--            tripulante, botón rojo → «🚨 Emergencia de Laura Gómez» (grave)
--                                     «Novedad de Laura Gómez»        (no grave)
--            conductor              → cuerpo «Carlos Mejía: <lo que escribió>»
--          y «No encuentra la dirección» para wrong_address (caía en «Novedad»);
--        · a los jefes de LA ORGANIZACIÓN de la eventualidad, no a los de todas:
--          ops_alert_recipients_of(org) = la regla de 0066 (los marcados en
--          Personal; si nadie está marcado, todos los admins activos) aplicada
--          DENTRO de la organización, como ya hace 0099 con los vuelos. Filtrar
--          ops_alert_recipients() después dejaría muda a una organización sin
--          marcados mientras otra sí los tenga;
--        · devuelve a cuántos jefes les quedó el aviso encolado, contando lo que
--          ya estaba: así auxiliar_change_flight (0093), que reporta y después
--          llama a enqueue_incident_alert, sigue devolviendo `notified` > 0 aunque
--          el disparador ya lo haya encolado (la segunda vez choca con la llave
--          'inc:<id>:<jefe>' y no duplica nada).
--
--   3. auxiliar_cancel_reservation = la de 0050 + el aviso al conductor
--      («Traslado cancelado») por la bandeja. Antes lo mandaba el celular del
--      tripulante con send-push; con el candado del punto 4 ya no podría, porque
--      al cancelar la parada se BORRA de la ruta y deja de existir el vínculo
--      tripulante ↔ conductor que lo autoriza.
--
--   4. push_allowed_recipients(uuid[]) → uuid[]: a quién puede mandarle push el
--      usuario de la sesión. La llama send-push con el JWT del que llama (así
--      auth.uid() es él) y solo envía a lo que esta función devuelve.
--        · jefe (admin activo)  → cualquiera de su organización;
--        · conductor/tripulante → él mismo (la prueba de notificaciones);
--                                 los jefes activos de su organización (chat sin
--                                 conductor 0067, Coordinación 0088/0113,
--                                 desbloqueo de aceite 0041);
--                                 la otra punta de un traslado vigente: la misma
--                                 regla del chat (0052/0067: ruta planned o
--                                 in_progress, reserva sin cancelar) pero solo
--                                 rutas de desde hace 24 h en adelante, porque
--                                 nadie cierra las rutas (siguen 'planned' para
--                                 siempre) y sin ese límite un conductor podría
--                                 escribirle a todo el que transportó alguna vez;
--                                 el otro conductor de un cambio de turno (0019)
--                                 propuesto o decidido en las últimas 24 h.
--        · inactivo, eliminado o sin perfil → nadie.
--
--   5. enqueue_incident_alert y ops_alert_recipients_of quedan solo para la base:
--      hasta hoy anon y authenticated podían llamar a enqueue_incident_alert y
--      volver a disparar el aviso de cualquier eventualidad ya enviada.
--
-- ORDEN AL SUBIR: (1) esta migración, (2) send-push (necesita
-- push_allowed_recipients: sin ella responde 500 y no sale ningún push de la
-- app), (3) la app (SW v199, que deja de mandar el aviso desde el celular). Si la
-- app vieja sigue un rato en algún teléfono, el aviso al jefe no sale doble: su
-- notifyOps ya no encontraba jefes. El de «Traslado cancelado» sí puede salir dos
-- veces mientras send-push siga siendo la vieja.
--
-- NO TOCA la tubería: dispatch-notifications, el reloj de cada minuto y
-- notification_outbox quedan como estaban. El aviso tarda lo que tarde el próximo
-- minuto del reloj (antes, cuando salía, era inmediato).
--
-- Down: down_migrations/0117_avisos_desde_el_servidor.down.sql

BEGIN;

-- ── 1. A quién le suena, dentro de una organización ─────────────────────────
CREATE OR REPLACE FUNCTION public.ops_alert_recipients_of(p_org uuid)
RETURNS TABLE (profile_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id
  FROM public.profiles p
  WHERE p.organization_id = p_org
    AND p.role = 'admin' AND p.deleted_at IS NULL
    AND p.is_active IS DISTINCT FROM false
    AND (p.receives_ops_alerts OR NOT EXISTS (
          SELECT 1 FROM public.profiles m
          WHERE m.organization_id = p_org
            AND m.role = 'admin' AND m.deleted_at IS NULL
            AND m.is_active IS DISTINCT FROM false AND m.receives_ops_alerts));
$$;

REVOKE ALL ON FUNCTION public.ops_alert_recipients_of(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ops_alert_recipients_of(uuid)
  IS 'Jefes de UNA organización que reciben avisos de operación: los marcados en Personal; si nadie está marcado, todos los admins activos (la regla de ops_alert_recipients, 0066, dentro de la organización).';

-- ── 2. enqueue_incident_alert ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_incident_alert(p_incident_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_titulo text;
  v_cuerpo text;
  v_quien  text;
  v_n      integer := 0;
  v_inc    record;
BEGIN
  SELECT i.id, i.organization_id, i.category, i.severity, i.description, i.source,
         v.internal_code, v.license_plate,
         pr.full_name AS pax,
         rp.full_name AS reporter
    INTO v_inc
  FROM public.incidents i
  LEFT JOIN public.vehicles v ON v.id = i.vehicle_id
  LEFT JOIN public.reservations r ON r.id = i.reservation_id
  LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
  LEFT JOIN public.profiles rp ON rp.id = i.reporter_id
  WHERE i.id = p_incident_id;

  IF v_inc.id IS NULL THEN RETURN 0; END IF;

  -- «Laura Gómez»: nombre y primer apellido, igual que lo armaba el celular.
  v_quien := nullif(array_to_string(
    (regexp_split_to_array(btrim(coalesce(v_inc.reporter, '')), '\s+'))[1:2], ' '), '');

  v_titulo := CASE v_inc.category
    WHEN 'driver_late'         THEN 'Un carro va muy atrasado'
    WHEN 'aux_not_ready'       THEN 'Un tripulante no ha bajado'
    WHEN 'aux_emergency'       THEN 'Emergencia de un tripulante'
    WHEN 'vehicle_problem'     THEN 'Falla mecánica'
    WHEN 'traffic'             THEN 'Trancón reportado'
    WHEN 'wrong_address'       THEN 'No encuentra la dirección'
    WHEN 'needs_third_vehicle' THEN 'Necesitamos un tercer vehículo'
    WHEN 'flight_delay'        THEN 'Vuelo retrasado: hay que mover una recogida'
    WHEN 'flight_advanced'     THEN 'Vuelo adelantado: hay que mover una recogida'
    ELSE 'Novedad en la operación'
  END;
  -- El botón rojo del tripulante: su nombre va en el título, que es lo primero
  -- que el jefe lee en la pantalla bloqueada.
  IF v_inc.category = 'aux_emergency' AND v_inc.source = 'auxiliar' THEN
    v_titulo := CASE WHEN v_inc.severity = 'high' THEN 'Emergencia de ' ELSE 'Novedad de ' END
                || coalesce(v_quien, 'un tripulante');
  END IF;
  IF v_inc.severity = 'high' THEN v_titulo := '🚨 ' || v_titulo; END IF;

  v_cuerpo := COALESCE(v_inc.description, '');
  IF v_inc.source = 'driver' THEN
    v_cuerpo := coalesce(v_quien, 'Un conductor') || ': ' || v_cuerpo;
  END IF;
  IF v_inc.internal_code IS NOT NULL THEN
    v_cuerpo := v_inc.internal_code || ' · ' || v_cuerpo;
  END IF;
  -- El nombre del tripulante solo se agrega si el aviso no lo dice ya (en el
  -- botón rojo ya va en el título).
  IF v_inc.pax IS NOT NULL
     AND position(split_part(v_inc.pax, ' ', 1) in (v_titulo || ' ' || v_cuerpo)) = 0 THEN
    v_cuerpo := v_cuerpo || ' (' || split_part(v_inc.pax, ' ', 1) || ')';
  END IF;
  v_cuerpo := left(v_cuerpo, 280);

  INSERT INTO public.notification_outbox (profile_id, incident_id, title, body, url, dedupe_key)
  SELECT r.profile_id, p_incident_id, v_titulo, v_cuerpo,
         '/#/eventualidades?ev=' || p_incident_id::text,
         'inc:' || p_incident_id::text || ':' || r.profile_id::text
  FROM public.ops_alert_recipients_of(v_inc.organization_id) r
  ON CONFLICT DO NOTHING;

  UPDATE public.incidents SET notified_at = COALESCE(notified_at, now()) WHERE id = p_incident_id;

  -- A cuántos jefes les quedó encolado (o ya enviado), contando una llamada
  -- anterior: llamarla dos veces no duplica y da el mismo número.
  SELECT count(DISTINCT o.profile_id) INTO v_n
  FROM public.notification_outbox o
  WHERE o.incident_id = p_incident_id
    AND o.dedupe_key LIKE 'inc:%';
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_incident_alert(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enqueue_incident_alert(uuid)
  IS 'Encola el push de una eventualidad a los jefes de su organización (ops_alert_recipients_of) y sella notified_at. Idempotente: devuelve a cuántos jefes les quedó el aviso.';

-- ── 3. El disparador: todo reporte humano de operación avisa ─────────────────
CREATE OR REPLACE FUNCTION public.incidents_avisar_jefes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM public.enqueue_incident_alert(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- El reporte vale más que su aviso: se guarda igual, y notified_at vacío
    -- deja a la vista que no avisó.
    RAISE WARNING 'enqueue_incident_alert(%) falló: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.incidents_avisar_jefes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_incidents_avisar_jefes ON public.incidents;
CREATE TRIGGER tr_incidents_avisar_jefes
  AFTER INSERT ON public.incidents
  FOR EACH ROW
  WHEN (NEW.scope = 'operacion' AND NEW.source IN ('driver', 'auxiliar'))
  EXECUTE FUNCTION public.incidents_avisar_jefes();

COMMENT ON TRIGGER tr_incidents_avisar_jefes ON public.incidents
  IS 'Reporte de operación de un conductor o un tripulante → push a los jefes por la bandeja (0117). Antes lo intentaba el celular y no tenía a quién: la RLS no le deja ver a los jefes.';

-- ── 4. auxiliar_cancel_reservation (0050 + aviso al conductor) ──────────────
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

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver, 'driver_notified', v_avisos > 0);
END;
$$;
REVOKE ALL    ON FUNCTION public.auxiliar_cancel_reservation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_cancel_reservation(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_cancel_reservation(uuid, text)
  IS 'El auxiliar dueño cancela su traslado si aún no lo han recogido. Lo saca de las rutas activas y le encola el aviso al conductor afectado (0117).';

-- ── 5. push_allowed_recipients: el candado de send-push ─────────────────────
CREATE OR REPLACE FUNCTION public.push_allowed_recipients(p_profile_ids uuid[])
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_role text;
  v_org  uuid;
  v_aux  uuid;
  v_drv  uuid;
  v_out  uuid[];
BEGIN
  IF v_me IS NULL OR p_profile_ids IS NULL OR cardinality(p_profile_ids) = 0 THEN
    RETURN '{}';
  END IF;

  -- El rol sale del perfil, no del JWT: un jefe desactivado no manda nada.
  SELECT p.role::text, p.organization_id INTO v_role, v_org
  FROM public.profiles p
  WHERE p.id = v_me AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  IF v_role IS NULL THEN RETURN '{}'; END IF;

  v_aux := public.current_auxiliar_id();
  v_drv := public.current_driver_id();

  SELECT coalesce(array_agg(DISTINCT t.id), '{}') INTO v_out
  FROM public.profiles t
  WHERE t.id = ANY (p_profile_ids)
    AND t.deleted_at IS NULL
    AND t.organization_id = v_org
    AND (
      v_role = 'admin'
      -- La prueba de «Activar notificaciones».
      OR t.id = v_me
      -- Los jefes: chat sin conductor, Coordinación, desbloqueo de aceite.
      OR (t.role = 'admin' AND t.is_active IS DISTINCT FROM false)
      -- Tripulante → el conductor de su traslado vigente (regla del chat).
      OR (v_aux IS NOT NULL AND EXISTS (
            SELECT 1
            FROM public.reservations r
            JOIN public.route_stops rs       ON rs.reservation_id = r.id
            JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
            JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
            WHERE r.auxiliar_profile_id = v_aux
              AND r.cancelled_at IS NULL
              AND ra.status IN ('planned', 'in_progress')
              AND ra.planned_start_at > now() - interval '24 hours'
              AND dp.profile_id = t.id))
      -- Conductor → los tripulantes de su ruta vigente (regla del chat).
      OR (v_drv IS NOT NULL AND EXISTS (
            SELECT 1
            FROM public.route_assignments ra
            JOIN public.route_stops rs       ON rs.route_assignment_id = ra.id
            JOIN public.reservations r       ON r.id = rs.reservation_id
            JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
            WHERE ra.driver_profile_id = v_drv
              AND ra.status IN ('planned', 'in_progress')
              AND ra.planned_start_at > now() - interval '24 hours'
              AND r.cancelled_at IS NULL
              AND ap.profile_id = t.id))
      -- Conductor ↔ conductor: el cambio de turno que se acaba de proponer o decidir.
      OR (v_drv IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.shift_swaps s
            WHERE ((s.requester_id = v_me AND s.target_id = t.id)
                OR (s.requester_id = t.id AND s.target_id = v_me))
              AND s.updated_at > now() - interval '24 hours'))
    );

  RETURN v_out;
END;
$$;

REVOKE ALL    ON FUNCTION public.push_allowed_recipients(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_allowed_recipients(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.push_allowed_recipients(uuid[])
  IS 'De la lista pedida, a quiénes puede mandarles push el usuario de la sesión. Jefe: a su organización. Conductor/tripulante: a sí mismo, a los jefes y a la otra punta de un traslado o cambio de turno vigente. La usa send-push (0117).';

COMMIT;
