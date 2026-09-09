-- 0052_reservation_chat.sql
--
-- Chat entre el auxiliar y el conductor de un traslado.
--
-- Hasta ahora el único canal era el botón de llamar (tel:), que sigue existiendo
-- y es el que sirve cuando no hay datos. El chat resuelve lo que la llamada no:
-- deja constancia. "Estoy en la portería 3, torre B" escrito no se pierde, y el
-- admin puede revisarlo si después hay un reclamo.
--
-- La conversación vive atada a UNA reserva: se abre cuando hay conductor
-- asignado y deja de ser escribible cuando el viaje termina. No es un chat
-- permanente entre dos personas, es el hilo de ese viaje.

CREATE TABLE IF NOT EXISTS public.reservation_messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id      uuid        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  sender_profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  sender_role         text        NOT NULL,
  body                text        NOT NULL,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_messages_role_valid CHECK (sender_role IN ('auxiliar', 'driver')),
  CONSTRAINT reservation_messages_body_len   CHECK (btrim(body) <> '' AND length(body) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_resv_messages_reservation ON public.reservation_messages(reservation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_resv_messages_unread      ON public.reservation_messages(reservation_id) WHERE read_at IS NULL;

DROP TRIGGER IF EXISTS tr_reservation_messages_set_updated_at ON public.reservation_messages;
CREATE TRIGGER tr_reservation_messages_set_updated_at
  BEFORE UPDATE ON public.reservation_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reservation_messages ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ¿Quién puede ver esta conversación?
-- El auxiliar dueño de la reserva y el conductor que la tiene asignada. Nadie
-- más: son dos personas hablando, no un canal público de la operación.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_use_reservation_chat(p_reservation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.id = p_reservation_id
      AND r.auxiliar_profile_id = public.current_auxiliar_id()
  )
  OR EXISTS (
    SELECT 1
    FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = p_reservation_id
      AND ra.driver_profile_id = public.current_driver_id()
      AND ra.status IN ('planned', 'in_progress')
  );
$$;

REVOKE ALL    ON FUNCTION public.can_use_reservation_chat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_use_reservation_chat(uuid) TO authenticated;

-- Leer: las dos partes. El admin también, porque el sentido de dejar constancia
-- es que alguien pueda revisarla cuando hay un reclamo.
DROP POLICY IF EXISTS reservation_messages_select ON public.reservation_messages;
CREATE POLICY reservation_messages_select ON public.reservation_messages
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.can_use_reservation_chat(reservation_id)
  );

-- Escribir: solo las dos partes, y solo en nombre propio. El admin NO escribe
-- aquí: si necesita decir algo, tiene su propio canal — meterse en la
-- conversación haciéndose pasar por uno de los dos sería peor que no tenerla.
DROP POLICY IF EXISTS reservation_messages_insert ON public.reservation_messages;
CREATE POLICY reservation_messages_insert ON public.reservation_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_profile_id = auth.uid()
    AND public.can_use_reservation_chat(reservation_id)
  );

-- Actualizar: solo para marcar como leído, y solo mensajes que YO recibí (los
-- del otro). Nadie edita ni borra lo que ya se dijo.
DROP POLICY IF EXISTS reservation_messages_update ON public.reservation_messages;
CREATE POLICY reservation_messages_update ON public.reservation_messages
  FOR UPDATE TO authenticated
  USING (sender_profile_id <> auth.uid() AND public.can_use_reservation_chat(reservation_id))
  WITH CHECK (sender_profile_id <> auth.uid() AND public.can_use_reservation_chat(reservation_id));

-- ---------------------------------------------------------------------------
-- Enviar un mensaje.
-- Va por RPC y no por INSERT directo por dos razones: valida el rol del que
-- escribe contra la reserva (no se lo cree del cliente), y devuelve a QUIÉN hay
-- que notificar — el que envía no tiene por qué conocer el profile_id del otro
-- para poder mandarle el push.
-- ---------------------------------------------------------------------------

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

  -- Las dos puntas de esta conversación, según la ruta vigente.
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

  -- El rol NO se lo creemos al cliente: sale de quién es contra esta reserva.
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

COMMENT ON FUNCTION public.send_reservation_message(uuid, text)
  IS 'Envía un mensaje en el hilo de una reserva. Deduce el rol del remitente contra la reserva (no confía en el cliente) y devuelve el profile_id del destinatario para poder notificarlo. SECURITY DEFINER validado por auth.uid().';

-- Marcar como leídos los mensajes que me escribieron en este hilo.
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
