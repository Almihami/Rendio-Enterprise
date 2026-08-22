-- 0067_chat_admin.down.sql — vuelve el chat a dos puntas (estado de 0052).
--
-- OJO: si un admin ya escribió en algún hilo, esas filas violan el CHECK viejo.
-- Se borran, porque el rol 'admin' deja de existir en la tabla. Es una pérdida
-- real de historial: revisar antes de correr esto en un ambiente con datos.

DELETE FROM public.reservation_messages WHERE sender_role = 'admin';

ALTER TABLE public.reservation_messages
  DROP CONSTRAINT IF EXISTS reservation_messages_role_valid;
ALTER TABLE public.reservation_messages
  ADD CONSTRAINT reservation_messages_role_valid
  CHECK (sender_role IN ('auxiliar', 'driver'));

ALTER TABLE public.reservation_messages DROP COLUMN IF EXISTS read_by;

-- send_reservation_message vuelve a la versión de 0052 (un destinatario, y falla
-- si el traslado no tiene conductor).
CREATE OR REPLACE FUNCTION public.send_reservation_message(p_reservation_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me        uuid := auth.uid();
  v_aux       uuid := public.current_auxiliar_id();
  v_drv       uuid := public.current_driver_id();
  v_role      text;
  v_body      text := btrim(coalesce(p_body, ''));
  v_id        uuid;
  v_at        timestamptz;
  v_to        uuid;
  v_aux_prof  uuid;
  v_drv_prof  uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'El mensaje está vacío'; END IF;
  IF length(v_body) > 500 THEN RAISE EXCEPTION 'El mensaje es demasiado largo'; END IF;

  SELECT ap.profile_id, dp.profile_id
    INTO v_aux_prof, v_drv_prof
  FROM public.reservations r
  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  LEFT JOIN public.route_stops rs        ON rs.reservation_id = r.id
  LEFT JOIN public.route_assignments ra  ON ra.id = rs.route_assignment_id
                                        AND ra.status IN ('planned', 'in_progress')
  LEFT JOIN public.driver_profiles dp    ON dp.id = ra.driver_profile_id
  WHERE r.id = p_reservation_id AND r.cancelled_at IS NULL
  ORDER BY ra.planned_start_at DESC NULLS LAST
  LIMIT 1;

  IF v_aux_prof IS NULL THEN RAISE EXCEPTION 'La reserva no existe o fue cancelada'; END IF;

  IF v_aux IS NOT NULL AND v_aux_prof = v_me THEN
    v_role := 'auxiliar'; v_to := v_drv_prof;
  ELSIF v_drv IS NOT NULL AND v_drv_prof = v_me THEN
    v_role := 'driver';   v_to := v_aux_prof;
  ELSE
    RAISE EXCEPTION 'No participas en este traslado';
  END IF;

  IF v_to IS NULL THEN RAISE EXCEPTION 'El traslado todavía no tiene conductor asignado'; END IF;

  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body)
  VALUES (p_reservation_id, v_me, v_role, v_body)
  RETURNING id, created_at INTO v_id, v_at;

  RETURN jsonb_build_object(
    'id', v_id, 'created_at', v_at, 'sender_role', v_role,
    'body', v_body, 'recipient_profile_id', v_to);
END;
$$;

REVOKE ALL    ON FUNCTION public.send_reservation_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_reservation_message(uuid, text) TO authenticated;

-- mark_reservation_messages_read vuelve a sellar read_at a secas.
CREATE OR REPLACE FUNCTION public.mark_reservation_messages_read(p_reservation_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_use_reservation_chat(p_reservation_id) THEN RETURN 0; END IF;
  UPDATE public.reservation_messages
     SET read_at = now()
   WHERE reservation_id = p_reservation_id
     AND sender_profile_id <> auth.uid()
     AND read_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL    ON FUNCTION public.mark_reservation_messages_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_reservation_messages_read(uuid) TO authenticated;
