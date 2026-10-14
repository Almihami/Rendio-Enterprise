-- =============================================================================
-- 0089 · «Cambió mi vuelo»
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P9 (D12, crítica 13).
-- Depende de 0086 (notes_without_flight).
--
-- public.auxiliar_change_flight(p_reservation_id uuid, p_flight text, p_when timestamptz) → jsonb
--
--   1. Valida: es SU reserva, no está cancelada, no ha empezado (estado crudo
--      fuera de en_route, at_pickup, on_board, picked_up, en_route_home,
--      delivered, no_show) y p_when está entre ahora y 14 días. En una LLEGADA
--      el número de vuelo es obligatorio; en una salida, vacío = se conserva el
--      que tenía.
--   2. ¿Hay que pasar por los jefes? v_ops es verdadero si:
--        · ya está publicado (ruta con conductor en planned / in_progress), o
--        · es un privado pedido o aprobado (la camioneta tiene cupo propio), o
--        · la hora vieja o la nueva caen dentro del plazo mínimo de pedido
--          (app_settings.aux_min_lead_hours): ahí la operación ya puede estar
--          armando la ruta y un cambio en silencio sería un pedido tardío que
--          nadie ve.
--      Si solo cambia el número de vuelo (misma hora), no hace falta: se anota.
--   3. Sin v_ops: actualiza required_arrival_at y las notas (el vuelo nuevo +
--      lo que escribió el tripulante, con notes_without_flight, conservando la
--      marca « · Regreso del mismo día» si la tenía) → {mode:'updated'}.
--      Si la reserva estaba ligada a un registro de flights con OTRO número,
--      se suelta (flight_id = NULL) para que el vuelo nuevo sea el que se ve.
--   4. Con v_ops: NO toca la reserva. Reporta la eventualidad
--      (report_incident, categoría flight_delay si la hora nueva es más tarde,
--      flight_advanced si es más temprano: ya existen en el enum desde 0001) y
--      encola el aviso a los jefes (enqueue_incident_alert) →
--      {mode:'needs_ops', incident_id}.
--   5. Un tripulante SUSPENDIDO sí puede cambiar su vuelo: sus traslados siguen
--      en pie (la suspensión solo bloquea pedidos nuevos).
--
-- enqueue_incident_alert = la de 0066 + dos títulos:
--   flight_delay    → «Vuelo retrasado: hay que mover una recogida»
--   flight_advanced → «Vuelo adelantado: hay que mover una recogida»
-- (antes caían en «Novedad en la operación»). Títulos neutros a propósito: esas
-- categorías también las puede reportar un conductor o el jefe.
--
-- SECURITY DEFINER, search_path fijo, idempotente (CREATE OR REPLACE).
-- Down: down_migrations/0089_cambio_de_vuelo.down.sql
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.auxiliar_change_flight(
  p_reservation_id uuid,
  p_flight text,
  p_when timestamptz
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

  -- El vuelo: sin espacios ni guion, en mayúscula. Mismo formato que escribe
  -- el pedido («Vuelo AV9412. »), y que notes_without_flight sabe quitar.
  v_flight := nullif(upper(regexp_replace(coalesce(p_flight, ''), '[[:space:]-]', '', 'g')), '');
  IF v_flight IS NOT NULL AND v_flight !~ '^[A-Z]{0,3}[0-9]{2,5}$' THEN
    RAISE EXCEPTION 'Ese número de vuelo no se entiende (ej.: AV9412)' USING ERRCODE = '22023';
  END IF;
  IF v_flight IS NULL AND r.direction = 'airport_to_home' THEN
    RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas' USING ERRCODE = '22023';
  END IF;

  SELECT f.flight_number INTO v_old_flight FROM public.flights f WHERE f.id = r.flight_id;
  IF v_old_flight IS NULL THEN
    v_old_flight := nullif(upper(regexp_replace(
      coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''),
      '[[:space:]-]', '', 'g')), '');
  END IF;

  IF p_when = r.required_arrival_at AND (v_flight IS NULL OR v_flight IS NOT DISTINCT FROM v_old_flight) THEN
    RETURN jsonb_build_object('mode', 'updated', 'unchanged', true,
                              'required_arrival_at', r.required_arrival_at);
  END IF;

  SELECT aux_min_lead_hours INTO v_lead FROM public.app_settings WHERE id = 'singleton';
  v_lead := coalesce(v_lead, 6);

  v_pub := EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id
      AND ra.driver_profile_id IS NOT NULL
      AND ra.status IN ('planned', 'in_progress'));
  v_priv := r.service_level = 'private' AND r.private_status IN ('requested', 'approved');
  v_ops := p_when <> r.required_arrival_at AND (
             v_pub OR v_priv
             OR p_when < now() + make_interval(hours => v_lead)
             OR r.required_arrival_at < now() + make_interval(hours => v_lead));

  IF NOT v_ops THEN
    v_regreso := coalesce(r.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
    v_user := public.notes_without_flight(r.notes);
    IF v_flight IS NULL THEN
      v_notes := r.notes;  -- salida sin vuelo nuevo: las notas quedan como estaban
    ELSE
      v_notes := btrim('Vuelo ' || v_flight || '. ' || v_user
                       || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END);
    END IF;

    UPDATE public.reservations
       SET required_arrival_at = p_when,
           notes = nullif(v_notes, ''),
           flight_id = CASE WHEN v_flight IS NOT NULL AND v_flight IS DISTINCT FROM v_old_flight
                            THEN NULL ELSE flight_id END
     WHERE id = r.id;

    RETURN jsonb_build_object('mode', 'updated', 'required_arrival_at', p_when,
                              'flight', coalesce(v_flight, v_old_flight));
  END IF;

  v_desc := format('Cambió su vuelo (%s): %s → %s%s',
    CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    coalesce(' · vuelo ' || coalesce(v_flight, v_old_flight), ''));

  v_inc := public.report_incident(
    (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay' ELSE 'flight_advanced' END)::public.incident_category,
    v_desc,
    'medium'::public.incident_severity,
    r.id,
    jsonb_build_object(
      'kind', 'aux_change_flight',
      'old_when', r.required_arrival_at, 'new_when', p_when,
      'old_flight', v_old_flight, 'new_flight', coalesce(v_flight, v_old_flight),
      'direction', r.direction, 'published', v_pub, 'private', v_priv)
  );
  v_n := public.enqueue_incident_alert(v_inc);

  RETURN jsonb_build_object('mode', 'needs_ops', 'incident_id', v_inc, 'notified', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.auxiliar_change_flight(uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auxiliar_change_flight(uuid, text, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- enqueue_incident_alert = 0066 + los títulos de vuelo
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_incident_alert(p_incident_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
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
    WHEN 'flight_delay'        THEN 'Vuelo retrasado: hay que mover una recogida'
    WHEN 'flight_advanced'     THEN 'Vuelo adelantado: hay que mover una recogida'
    ELSE 'Novedad en la operación'
  END;
  IF v_inc.severity = 'high' THEN v_titulo := '🚨 ' || v_titulo; END IF;

  v_cuerpo := COALESCE(v_inc.description, '');
  IF v_inc.internal_code IS NOT NULL THEN
    v_cuerpo := v_inc.internal_code || ' · ' || v_cuerpo;
  END IF;
  -- El nombre del tripulante solo se agrega si el texto no lo dice ya.
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

COMMIT;
