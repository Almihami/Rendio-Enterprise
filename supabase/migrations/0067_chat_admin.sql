-- 0067_chat_admin.sql — Bloque C: el jefe entra al hilo del traslado.
--
-- Hoy el chat de 0052 es una cuerda de DOS puntas: auxiliar ↔ conductor. El admin
-- lee (la policy de SELECT ya lo deja) pero no puede escribir, y hay tres
-- candados distintos que se lo impiden:
--
--   1. CHECK reservation_messages_role_valid → sender_role IN ('auxiliar','driver')
--   2. send_reservation_message → 'No participas en este traslado' (0052:145)
--   3. send_reservation_message → 'El traslado todavía no tiene conductor
--      asignado' (0052:148), que es EXACTAMENTE el caso del trancón y del tercer
--      vehículo: el momento en que más falta hace hablar es el único en que el
--      chat se cae.
--
-- Esta migración pasa el hilo a TRES puntas. Dos decisiones de fondo:
--
-- A) EL MENSAJE NO SE PIERDE POR NO HABER CONDUCTOR. Si el tripulante escribe y
--    su traslado todavía no tiene carro, el mensaje se guarda y el aviso va a los
--    jefes (los mismos de ops_alert_recipients, 0066). Hoy eso REVIENTA, y en
--    auxiliar.js:1429 el catch se lo come en silencio: el botón rojo del
--    tripulante manda un 🚨 al chat que nadie recibe ni ve.
--
-- B) "LEÍDO" DEJA DE SER UN SOLO INTERRUPTOR. Con tres participantes, read_at
--    (una columna, un booleano) no puede decir "leído por quién". Si el
--    tripulante abre el chat, hoy se marcarían leídos TAMBIÉN los mensajes que el
--    jefe le escribió al conductor, y al conductor se le apagaría el badge de un
--    mensaje que nunca vio. Se agrega read_by uuid[]: quién lo leyó, uno por uno.
--    read_at se conserva y pasa a significar "cuándo lo leyó el primero", que es
--    lo que ya mostraba la UI.
--
-- El admin NO entra a can_use_reservation_chat a propósito: si entrara, la policy
-- de INSERT lo dejaría escribir por fuera del RPC y elegir él mismo el
-- sender_role — o sea, hacerse pasar por el conductor. Su único camino es el RPC,
-- que es SECURITY DEFINER y por eso no necesita la policy.

-- ---------------------------------------------------------------------------
-- 1. El rol 'admin' cabe en el hilo
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservation_messages
  DROP CONSTRAINT IF EXISTS reservation_messages_role_valid;

ALTER TABLE public.reservation_messages
  ADD CONSTRAINT reservation_messages_role_valid
  CHECK (sender_role IN ('auxiliar', 'driver', 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Leído por quién
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservation_messages
  ADD COLUMN IF NOT EXISTS read_by uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.reservation_messages.read_by
  IS 'Quiénes leyeron este mensaje. Con tres participantes en el hilo, read_at (un solo interruptor) no alcanza: apagaría el badge de alguien que no lo abrió.';

COMMENT ON COLUMN public.reservation_messages.read_at
  IS 'Cuándo lo leyó el PRIMERO de los destinatarios. Para saber si lo leyó alguien en particular, read_by.';

-- Lo que ya estaba leído antes de esta migración se da por leído por el otro
-- extremo del hilo, que en un hilo de dos puntas es el único que pudo leerlo.
UPDATE public.reservation_messages m
   SET read_by = ARRAY(
     SELECT DISTINCT x FROM (
       SELECT ap.profile_id AS x
         FROM public.reservations r
         JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        WHERE r.id = m.reservation_id AND ap.profile_id <> m.sender_profile_id
       UNION
       SELECT dp.profile_id
         FROM public.route_stops rs
         JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
         JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
        WHERE rs.reservation_id = m.reservation_id AND dp.profile_id <> m.sender_profile_id
     ) s WHERE x IS NOT NULL)
 WHERE m.read_at IS NOT NULL AND cardinality(m.read_by) = 0;

-- ---------------------------------------------------------------------------
-- 3. Enviar: tres ramas de remitente y varios destinatarios
--
--    A quién le suena cada mensaje:
--      · el jefe escribe  → al tripulante Y al conductor (si ya hay carro)
--      · el conductor     → al tripulante
--      · el tripulante    → al conductor; y si todavía no hay carro, a los jefes
--
--    Se devuelve `recipient_profile_ids` (arreglo) y `to_admins`, para que la
--    pantalla pueda decir la verdad: "le avisamos a los jefes" no es lo mismo
--    que "le avisamos a tu conductor". `recipient_profile_id` se conserva por
--    compatibilidad con lo que ya está desplegado.
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
  v_admin     boolean := public.current_user_role() = 'admin';
  v_role      text;
  v_body      text := btrim(coalesce(p_body, ''));
  v_id        uuid;
  v_at        timestamptz;
  v_to        uuid[] := '{}';
  v_admins    boolean := false;
  v_aux_prof  uuid;
  v_drv_prof  uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'El mensaje está vacío'; END IF;
  IF length(v_body) > 500 THEN RAISE EXCEPTION 'El mensaje es demasiado largo'; END IF;

  -- Las puntas de esta conversación, según la ruta vigente.
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
    v_role := 'auxiliar';
    IF v_drv_prof IS NOT NULL THEN
      v_to := ARRAY[v_drv_prof];
    ELSE
      -- Sin conductor asignado el mensaje NO se pierde: lo reciben los jefes.
      -- Es el caso del trancón, del tercer vehículo y del botón rojo.
      SELECT array_agg(profile_id) INTO v_to FROM public.ops_alert_recipients();
      v_to := COALESCE(v_to, '{}');
      v_admins := true;
    END IF;
  ELSIF v_drv IS NOT NULL AND v_drv_prof = v_me THEN
    v_role := 'driver';
    v_to   := ARRAY[v_aux_prof];
  ELSIF v_admin THEN
    v_role := 'admin';
    v_to   := ARRAY(SELECT x FROM unnest(ARRAY[v_aux_prof, v_drv_prof]) AS t(x) WHERE x IS NOT NULL AND x <> v_me);
  ELSE
    RAISE EXCEPTION 'No participas en este traslado';
  END IF;

  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body)
  VALUES (p_reservation_id, v_me, v_role, v_body)
  RETURNING id, created_at INTO v_id, v_at;

  RETURN jsonb_build_object(
    'id', v_id, 'created_at', v_at, 'sender_role', v_role, 'body', v_body,
    'recipient_profile_id',  v_to[1],
    'recipient_profile_ids', to_jsonb(v_to),
    'to_admins', v_admins);
END;
$$;

REVOKE ALL    ON FUNCTION public.send_reservation_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_reservation_message(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.send_reservation_message(uuid, text)
  IS 'Envía un mensaje en el hilo de una reserva (auxiliar, conductor o admin). Deduce el rol del remitente contra la reserva y devuelve a quién notificar. Si el tripulante escribe sin conductor asignado, el aviso va a los jefes en vez de fallar.';

-- ---------------------------------------------------------------------------
-- 4. Marcar leído: por lector, no por mensaje
--
--    El admin queda fuera a propósito: si él abriera el hilo y marcara leído,
--    le apagaría el badge al conductor de un mensaje que el conductor no vio.
--    El jefe tiene su propia bandeja; no necesita contador de no leídos.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_reservation_messages_read(p_reservation_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer; v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR NOT public.can_use_reservation_chat(p_reservation_id) THEN RETURN 0; END IF;
  UPDATE public.reservation_messages
     SET read_at = COALESCE(read_at, now()),
         read_by = array_append(read_by, v_me)
   WHERE reservation_id = p_reservation_id
     AND sender_profile_id <> v_me
     AND NOT (v_me = ANY(read_by));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL    ON FUNCTION public.mark_reservation_messages_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_reservation_messages_read(uuid) TO authenticated;

COMMENT ON FUNCTION public.mark_reservation_messages_read(uuid)
  IS 'Marca leídos los mensajes del hilo que no escribí yo, registrándome en read_by. Solo las dos puntas del traslado: el admin lee sin marcar.';

-- Las policies de 0052 se quedan como están, a propósito:
--   · SELECT ya deja leer al admin (current_user_role() = 'admin').
--   · INSERT y UPDATE siguen cerradas al admin, y no le hacen falta: su único
--     camino es el RPC, que es SECURITY DEFINER. Abrirle el INSERT directo sería
--     dejarlo elegir sender_role a mano, o sea hacerse pasar por el conductor.
