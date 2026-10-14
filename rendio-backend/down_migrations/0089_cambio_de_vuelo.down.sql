-- Revierte 0089: quita auxiliar_change_flight y devuelve
-- enqueue_incident_alert a la de 0066 (copiada tal cual, líneas 126-184 de
-- 0066_avisos_de_madrugada.sql): flight_delay / flight_advanced vuelven a
-- titularse «Novedad en la operación».
--
-- No pierde datos: las eventualidades ya reportadas y los avisos encolados se
-- quedan. El front degrada: ApiAux.changeFlight devuelve null sin la RPC y la
-- pantalla manda al tripulante a Coordinación.

BEGIN;

DROP FUNCTION IF EXISTS public.auxiliar_change_flight(uuid, text, timestamptz);

-- ── enqueue_incident_alert de 0066 ──────────────────────────────────────────
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

COMMIT;
