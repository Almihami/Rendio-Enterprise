-- Down de 0117: los avisos vuelven a como estaban en 0089/0050.
--   · se quita el disparador: los reportes de conductores y tripulantes dejan de
--     encolar el aviso (el celular vuelve a ser el único que lo intenta, y por la
--     RLS de profiles no tiene a quién mandárselo);
--   · enqueue_incident_alert vuelve a la de 0089 (títulos sin el nombre, a todos
--     los jefes sin mirar la organización, devuelve solo lo que insertó);
--   · auxiliar_cancel_reservation vuelve a la de 0050 (sin aviso al conductor:
--     lo vuelve a mandar el celular del tripulante);
--   · se borran push_allowed_recipients y ops_alert_recipients_of. OJO: la
--     send-push de 0117 necesita push_allowed_recipients; bajar esto sin volver a
--     desplegar la send-push anterior deja SIN push a todos los que llaman desde
--     la app (responde 500).
-- Los avisos ya encolados en notification_outbox se quedan (los drena igual).
BEGIN;

DROP TRIGGER IF EXISTS tr_incidents_avisar_jefes ON public.incidents;
DROP FUNCTION IF EXISTS public.incidents_avisar_jefes();
DROP FUNCTION IF EXISTS public.push_allowed_recipients(uuid[]);

-- enqueue_incident_alert de 0089
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

-- auxiliar_cancel_reservation de 0050
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

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver);
END;
$$;

COMMENT ON FUNCTION public.auxiliar_cancel_reservation(uuid, text)
  IS 'El auxiliar dueño cancela su traslado si aún no lo han recogido. Lo saca de las rutas activas y devuelve el profile_id del conductor afectado para notificarlo.';

DROP FUNCTION IF EXISTS public.ops_alert_recipients_of(uuid);

COMMIT;
