-- =============================================================================
-- 0113 · Coordinación por conversaciones + el nombre del jefe que escribe
-- =============================================================================
-- Pedido de la profa (16-oct-2026), después de probar el chat en dev:
--
--   · «No se creó un nuevo chat, debería haber como un historial de
--     conversación». Hasta aquí cada tripulante tenía UN hilo sin fin con los
--     jefes (0088). Ahora el hilo se parte en CONVERSACIONES: a lo sumo una
--     abierta por tripulante. Se cierra cuando un jefe la marca «Resuelta» o,
--     si nadie la cierra, sola tras app_settings.crew_chat_idle_hours (12 h)
--     sin mensajes. El siguiente mensaje —de cualquiera de los dos lados— abre
--     una nueva. Las cerradas quedan como historial, para releer.
--
--   · «¿Cómo sé qué jefe me está hablando? Coordinación (Julián)». Se levanta
--     la decisión D11 de 0088 (el tripulante nunca veía QUÉ jefe escribió): los
--     mensajes del equipo traen sender_name = el primer nombre de quien los
--     escribió, para el tripulante y para los demás jefes. sender_profile_id
--     sigue sin exponerse: hace falta el nombre, no el id.
--
-- EL CIERRE POR TIEMPO ES PEREZOSO: no hay cron. Una conversación con
-- closed_at NULL y sin mensajes hace más de N horas se trata como cerrada en
-- todas las lecturas (crew_conv_is_open) y la cierra de verdad el siguiente
-- mensaje (crew_send_message), con closed_at = último mensaje + N horas.
--
-- LO QUE YA HABÍA se reparte en conversaciones por los mismos huecos de N
-- horas, así el historial nace con sentido (solo para quien todavía no tiene
-- ninguna conversación: volver a correr esto no duplica nada).
--
-- COMPATIBILIDAD: las firmas de 0088 se conservan (la app vieja, con su caché,
-- sigue funcionando); crew_list_messages suma un parámetro opcional
-- p_conversation_id (se borra la firma vieja para que no queden dos). Lo nuevo:
--   crew_conversations_list(p_auxiliar_profile_id DEFAULT NULL) → jsonb
--   crew_close_conversation(p_conversation_id) → jsonb   (solo jefes)
--
-- Idempotente. Down: down_migrations/0113_conversaciones_coordinacion.down.sql
-- (deja las conversaciones sin efecto y vuelve a las funciones de 0088; los
-- mensajes no se tocan).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Cuántas horas sin mensajes cierran una conversación (Ajustes, 12 por defecto)
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS crew_chat_idle_hours smallint NOT NULL DEFAULT 12;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_crew_chat_idle_hours_range;
ALTER TABLE public.app_settings ADD  CONSTRAINT app_settings_crew_chat_idle_hours_range
  CHECK (crew_chat_idle_hours BETWEEN 1 AND 168);
COMMENT ON COLUMN public.app_settings.crew_chat_idle_hours IS
  'Horas sin mensajes tras las cuales una conversación de Coordinación se da por cerrada (la siguiente empieza nueva). 0113.';

CREATE OR REPLACE FUNCTION public.crew_idle_interval()
RETURNS interval
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT make_interval(hours => COALESCE(
    (SELECT s.crew_chat_idle_hours FROM public.app_settings s WHERE s.id = 'singleton'), 12)::int);
$$;

-- ¿Sigue abierta? Cerrada a mano, o quieta más de N horas.
CREATE OR REPLACE FUNCTION public.crew_conv_is_open(p_closed_at timestamptz, p_last timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_closed_at IS NULL AND p_last >= now() - public.crew_idle_interval();
$$;

-- ---------------------------------------------------------------------------
-- 2. Tabla de conversaciones
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crew_conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  opened_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_message_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at           timestamptz,
  closed_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  close_reason        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crew_conversations DROP CONSTRAINT IF EXISTS crew_conversations_close_reason_valid;
ALTER TABLE public.crew_conversations ADD  CONSTRAINT crew_conversations_close_reason_valid
  CHECK ((closed_at IS NULL AND close_reason IS NULL)
      OR (closed_at IS NOT NULL AND close_reason IN ('admin', 'auto')));

-- A lo sumo UNA abierta por tripulante (la que recibe los mensajes nuevos).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_conversations_open
  ON public.crew_conversations (auxiliar_profile_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crew_conversations_aux
  ON public.crew_conversations (auxiliar_profile_id, last_message_at DESC);

DROP TRIGGER IF EXISTS tr_crew_conversations_set_updated_at ON public.crew_conversations;
CREATE TRIGGER tr_crew_conversations_set_updated_at
  BEFORE UPDATE ON public.crew_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.crew_conversations IS
  'Coordinación: las conversaciones de cada tripulante con los jefes (una abierta a la vez). Se escribe solo por RPC. 0113.';

ALTER TABLE public.crew_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crew_conversations FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organization_id, auxiliar_profile_id, opened_at, last_message_at, closed_at, close_reason,
              created_at, updated_at)
  ON public.crew_conversations TO authenticated;

DROP POLICY IF EXISTS p_crew_conversations_select_own ON public.crew_conversations;
CREATE POLICY p_crew_conversations_select_own
  ON public.crew_conversations FOR SELECT TO authenticated
  USING (public.current_user_role() = 'auxiliar' AND auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_crew_conversations_select_admin ON public.crew_conversations;
CREATE POLICY p_crew_conversations_select_admin
  ON public.crew_conversations FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Cada mensaje, en su conversación.
ALTER TABLE public.crew_messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.crew_conversations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_crew_messages_conversation ON public.crew_messages (conversation_id, created_at);
GRANT SELECT (conversation_id) ON public.crew_messages TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Lo que ya había: repartido por los huecos de N horas
-- ---------------------------------------------------------------------------
WITH m AS (
  SELECT c.id, c.organization_id, c.auxiliar_profile_id, c.created_at,
         CASE WHEN lag(c.created_at) OVER w IS NULL
                OR c.created_at - lag(c.created_at) OVER w > public.crew_idle_interval()
              THEN 1 ELSE 0 END AS nuevo
  FROM public.crew_messages c
  WHERE c.conversation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.crew_conversations x WHERE x.auxiliar_profile_id = c.auxiliar_profile_id)
  WINDOW w AS (PARTITION BY c.auxiliar_profile_id ORDER BY c.created_at, c.id)
), g AS (
  SELECT m.*, sum(m.nuevo) OVER (PARTITION BY m.auxiliar_profile_id ORDER BY m.created_at, m.id) AS grp
  FROM m
), conv AS (
  SELECT g.auxiliar_profile_id, g.grp, (array_agg(g.organization_id))[1] AS org,
         min(g.created_at) AS opened, max(g.created_at) AS last
  FROM g GROUP BY g.auxiliar_profile_id, g.grp
), conv2 AS (
  SELECT conv.*, max(conv.grp) OVER (PARTITION BY conv.auxiliar_profile_id) AS maxgrp FROM conv
)
INSERT INTO public.crew_conversations (organization_id, auxiliar_profile_id, opened_at, last_message_at, closed_at, close_reason)
SELECT org, auxiliar_profile_id, opened, last,
       CASE WHEN grp < maxgrp OR last < now() - public.crew_idle_interval() THEN last + public.crew_idle_interval() END,
       CASE WHEN grp < maxgrp OR last < now() - public.crew_idle_interval() THEN 'auto' END
FROM conv2;

-- Las conversaciones de un tripulante no se pisan en el tiempo: cada mensaje
-- cae en la que contiene su hora.
UPDATE public.crew_messages c
   SET conversation_id = cv.id
  FROM public.crew_conversations cv
 WHERE c.conversation_id IS NULL
   AND cv.auxiliar_profile_id = c.auxiliar_profile_id
   AND c.created_at BETWEEN cv.opened_at AND cv.last_message_at;

-- ---------------------------------------------------------------------------
-- 4. Enviar: el mensaje entra en la conversación abierta (o abre una)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_send_message(
  p_body text,
  p_auxiliar_profile_id uuid DEFAULT NULL,
  p_reservation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me     uuid := auth.uid();
  v_role   text := public.current_user_role();
  v_body   text := btrim(coalesce(p_body, ''));
  v_aux    uuid;
  v_org    uuid;
  v_aux_pf uuid;
  v_to     uuid[];
  v_id     uuid;
  v_at     timestamptz;
  v_idle   interval := public.crew_idle_interval();
  v_conv   uuid;
  v_new    boolean := false;
  v_name   text;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  IF v_body = '' THEN
    RAISE EXCEPTION 'Escribe el mensaje' USING ERRCODE = '22023';
  END IF;
  IF length(v_body) > 500 THEN
    RAISE EXCEPTION 'El mensaje es demasiado largo (máximo 500 caracteres)' USING ERRCODE = '22023';
  END IF;

  IF v_role = 'auxiliar' THEN
    v_aux := public.current_auxiliar_id();
    IF v_aux IS NULL THEN
      RAISE EXCEPTION 'Tu perfil de tripulante no existe' USING ERRCODE = '42501';
    END IF;
    IF p_auxiliar_profile_id IS NOT NULL AND p_auxiliar_profile_id <> v_aux THEN
      RAISE EXCEPTION 'Solo puedes escribir en tu propio hilo' USING ERRCODE = '42501';
    END IF;
  ELSIF v_role = 'admin' THEN
    IF p_auxiliar_profile_id IS NULL THEN
      RAISE EXCEPTION 'Falta el tripulante' USING ERRCODE = '22023';
    END IF;
    v_aux := p_auxiliar_profile_id;
  ELSE
    RAISE EXCEPTION 'Tu perfil no puede usar Coordinación' USING ERRCODE = '42501';
  END IF;

  SELECT p.organization_id, p.id INTO v_org, v_aux_pf
  FROM public.auxiliar_profiles ap
  JOIN public.profiles p ON p.id = ap.profile_id
  WHERE ap.id = v_aux;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Ese tripulante no existe' USING ERRCODE = '22023';
  END IF;
  IF v_role = 'admin' AND v_org IS DISTINCT FROM public.current_user_org() THEN
    RAISE EXCEPTION 'Ese tripulante no es de tu organización' USING ERRCODE = '42501';
  END IF;

  IF p_reservation_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.reservations r
       WHERE r.id = p_reservation_id AND r.auxiliar_profile_id = v_aux) THEN
    RAISE EXCEPTION 'Ese traslado no es de este tripulante' USING ERRCODE = '42501';
  END IF;

  -- La abierta que lleva más de N horas quieta se cierra de verdad (perezoso)…
  UPDATE public.crew_conversations
     SET closed_at = last_message_at + v_idle, close_reason = 'auto'
   WHERE auxiliar_profile_id = v_aux AND closed_at IS NULL AND last_message_at < now() - v_idle;
  -- …y si no queda ninguna abierta, este mensaje abre una nueva.
  INSERT INTO public.crew_conversations (organization_id, auxiliar_profile_id)
  VALUES (v_org, v_aux)
  ON CONFLICT (auxiliar_profile_id) WHERE closed_at IS NULL DO NOTHING
  RETURNING id INTO v_conv;
  v_new := v_conv IS NOT NULL;
  IF v_conv IS NULL THEN
    SELECT id INTO v_conv FROM public.crew_conversations
     WHERE auxiliar_profile_id = v_aux AND closed_at IS NULL;
  END IF;

  INSERT INTO public.crew_messages
    (organization_id, auxiliar_profile_id, sender_profile_id, sender_role, body, reservation_id, read_by, created_at, conversation_id)
  VALUES
    (v_org, v_aux, v_me, v_role, v_body, p_reservation_id, ARRAY[v_me], clock_timestamp(), v_conv)
  RETURNING id, created_at INTO v_id, v_at;

  UPDATE public.crew_conversations SET last_message_at = v_at WHERE id = v_conv;

  IF v_role = 'auxiliar' THEN
    SELECT coalesce(array_agg(DISTINCT r.profile_id), '{}')
      INTO v_to
    FROM public.ops_alert_recipients() r
    JOIN public.profiles p ON p.id = r.profile_id
    WHERE p.organization_id = v_org;
  ELSE
    v_to := ARRAY[v_aux_pf];
    SELECT nullif(split_part(btrim(p.full_name), ' ', 1), '') INTO v_name FROM public.profiles p WHERE p.id = v_me;
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'created_at', v_at,
    'sender_role', v_role,
    'sender_name', v_name,
    'auxiliar_profile_id', v_aux,
    'reservation_id', p_reservation_id,
    'conversation_id', v_conv,
    'new_conversation', v_new,
    'recipient_profile_ids', to_jsonb(v_to)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Leer una conversación
-- ---------------------------------------------------------------------------
-- Sin p_conversation_id:
--   · tripulante → la abierta; si no hay, la última SOLO si trae algo del equipo
--     sin leer (que no se le pierda una respuesta); si no, [] = chat nuevo.
--   · jefe → la abierta o, si no hay, la última (para tener el contexto).
-- Cada mensaje trae conversation_id y conversation_open (la de ese hilo).
DROP FUNCTION IF EXISTS public.crew_list_messages(uuid, int);
CREATE OR REPLACE FUNCTION public.crew_list_messages(
  p_auxiliar_profile_id uuid DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_role text := public.current_user_role();
  v_aux  uuid;
  v_lim  int  := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_conv uuid;
  v_open boolean;
BEGIN
  IF v_me IS NULL THEN RETURN NULL; END IF;

  IF v_role = 'auxiliar' THEN
    v_aux := public.current_auxiliar_id();
    IF v_aux IS NULL OR (p_auxiliar_profile_id IS NOT NULL AND p_auxiliar_profile_id <> v_aux) THEN
      RETURN NULL;
    END IF;
  ELSIF v_role = 'admin' THEN
    v_aux := p_auxiliar_profile_id;
    IF v_aux IS NULL OR public.auxiliar_profile_org(v_aux) IS DISTINCT FROM public.current_user_org() THEN
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  IF p_conversation_id IS NOT NULL THEN
    SELECT cv.id INTO v_conv FROM public.crew_conversations cv
     WHERE cv.id = p_conversation_id AND cv.auxiliar_profile_id = v_aux;
    IF v_conv IS NULL THEN RETURN '[]'::jsonb; END IF;
  ELSE
    SELECT cv.id INTO v_conv FROM public.crew_conversations cv
     WHERE cv.auxiliar_profile_id = v_aux AND public.crew_conv_is_open(cv.closed_at, cv.last_message_at);
    IF v_conv IS NULL AND v_role = 'auxiliar' THEN
      SELECT cv.id INTO v_conv FROM public.crew_conversations cv
       WHERE cv.auxiliar_profile_id = v_aux
         AND EXISTS (SELECT 1 FROM public.crew_messages u
                      WHERE u.conversation_id = cv.id AND u.sender_role = 'admin' AND u.read_at IS NULL)
       ORDER BY cv.last_message_at DESC LIMIT 1;
    ELSIF v_conv IS NULL THEN
      SELECT cv.id INTO v_conv FROM public.crew_conversations cv
       WHERE cv.auxiliar_profile_id = v_aux
       ORDER BY cv.last_message_at DESC LIMIT 1;
    END IF;
    IF v_conv IS NULL THEN RETURN '[]'::jsonb; END IF;
  END IF;

  SELECT public.crew_conv_is_open(cv.closed_at, cv.last_message_at) INTO v_open
    FROM public.crew_conversations cv WHERE cv.id = v_conv;

  RETURN COALESCE((
    SELECT jsonb_agg(m.j ORDER BY m.created_at, m.id)
    FROM (
      SELECT c.created_at, c.id, jsonb_build_object(
          'id',                c.id,
          'sender_role',       c.sender_role,
          'sender_name',       CASE WHEN c.sender_role = 'admin'
                                    THEN nullif(split_part(btrim(sp.full_name), ' ', 1), '') END,
          'mine',              c.sender_profile_id = v_me,
          'body',              c.body,
          'created_at',        c.created_at,
          'read',              c.read_at IS NOT NULL,
          'read_at',           c.read_at,
          'conversation_id',   c.conversation_id,
          'conversation_open', v_open,
          'reservation', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id',        r.id,
              'direction', r.direction,
              'date',      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
              'time',      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'HH24:MI')) END
        ) AS j
      FROM public.crew_messages c
      LEFT JOIN public.reservations r ON r.id = c.reservation_id
      LEFT JOIN public.profiles sp ON sp.id = c.sender_profile_id
      WHERE c.auxiliar_profile_id = v_aux AND c.conversation_id = v_conv
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT v_lim
    ) m
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Historial: las conversaciones de un tripulante (la más reciente primero)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_conversations_list(p_auxiliar_profile_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_aux  uuid;
  v_idle interval := public.crew_idle_interval();
  v_from text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF v_role = 'auxiliar' THEN
    v_aux := public.current_auxiliar_id();
    IF v_aux IS NULL OR (p_auxiliar_profile_id IS NOT NULL AND p_auxiliar_profile_id <> v_aux) THEN RETURN NULL; END IF;
    v_from := 'admin';
  ELSIF v_role = 'admin' THEN
    v_aux := p_auxiliar_profile_id;
    IF v_aux IS NULL OR public.auxiliar_profile_org(v_aux) IS DISTINCT FROM public.current_user_org() THEN RETURN NULL; END IF;
    v_from := 'auxiliar';
  ELSE
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(t.j ORDER BY t.last DESC)
    FROM (
      SELECT cv.last_message_at AS last, jsonb_build_object(
          'id',             cv.id,
          'opened_at',      cv.opened_at,
          'last_at',        cv.last_message_at,
          'open',           public.crew_conv_is_open(cv.closed_at, cv.last_message_at),
          'closed_at',      CASE WHEN public.crew_conv_is_open(cv.closed_at, cv.last_message_at) THEN NULL
                                 ELSE coalesce(cv.closed_at, cv.last_message_at + v_idle) END,
          'close_reason',   CASE WHEN public.crew_conv_is_open(cv.closed_at, cv.last_message_at) THEN NULL
                                 ELSE coalesce(cv.close_reason, 'auto') END,
          'closed_by_name', nullif(split_part(btrim(cb.full_name), ' ', 1), ''),
          'messages',       (SELECT count(*) FROM public.crew_messages c WHERE c.conversation_id = cv.id),
          'unread',         (SELECT count(*) FROM public.crew_messages c
                              WHERE c.conversation_id = cv.id AND c.sender_role = v_from AND c.read_at IS NULL),
          'first_body',     (SELECT c.body FROM public.crew_messages c WHERE c.conversation_id = cv.id
                              ORDER BY c.created_at, c.id LIMIT 1),
          'last_body',      (SELECT c.body FROM public.crew_messages c WHERE c.conversation_id = cv.id
                              ORDER BY c.created_at DESC, c.id DESC LIMIT 1)
        ) AS j
      FROM public.crew_conversations cv
      LEFT JOIN public.profiles cb ON cb.id = cv.closed_by
      WHERE cv.auxiliar_profile_id = v_aux
      ORDER BY cv.last_message_at DESC
      LIMIT 60
    ) t
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. «Resuelta»: un jefe cierra la conversación abierta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_close_conversation(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_org  uuid;
  v_at   timestamptz;
  v_name text;
BEGIN
  IF v_me IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe puede cerrar una conversación' USING ERRCODE = '42501';
  END IF;
  SELECT cv.organization_id INTO v_org FROM public.crew_conversations cv WHERE cv.id = p_conversation_id;
  IF v_org IS NULL OR v_org IS DISTINCT FROM public.current_user_org() THEN
    RAISE EXCEPTION 'Esa conversación no existe' USING ERRCODE = '22023';
  END IF;

  UPDATE public.crew_conversations
     SET closed_at = clock_timestamp(), closed_by = v_me, close_reason = 'admin'
   WHERE id = p_conversation_id AND closed_at IS NULL
  RETURNING closed_at INTO v_at;

  SELECT nullif(split_part(btrim(p.full_name), ' ', 1), '') INTO v_name FROM public.profiles p WHERE p.id = v_me;
  RETURN jsonb_build_object('id', p_conversation_id, 'closed', true, 'closed_at', v_at,
                            'already_closed', v_at IS NULL, 'closed_by_name', v_name);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Bandeja del jefe: lo de 0088 + si la conversación sigue abierta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_threads_admin()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(t.j ORDER BY t.last_at DESC)
    FROM (
      SELECT last.created_at AS last_at, jsonb_build_object(
          'auxiliar_profile_id', ap.id,
          'profile_id',          p.id,
          'name',                p.full_name,
          'phone',               p.phone,
          'residence',           res.name,
          'sector',              res.sector,
          'last_body',           last.body,
          'last_role',           last.sender_role,
          'last_sender_name',    last.sender_name,
          'last_at',             last.created_at,
          'last_reservation_id', last.reservation_id,
          'conversation_id',     cur.id,
          'open',                coalesce(public.crew_conv_is_open(cur.closed_at, cur.last_message_at), false),
          'conversations',       (SELECT count(*) FROM public.crew_conversations x WHERE x.auxiliar_profile_id = ap.id),
          'unread',              (SELECT count(*) FROM public.crew_messages u
                                   WHERE u.auxiliar_profile_id = ap.id
                                     AND u.sender_role = 'auxiliar' AND u.read_at IS NULL),
          'total',               (SELECT count(*) FROM public.crew_messages u
                                   WHERE u.auxiliar_profile_id = ap.id)
        ) AS j
      FROM (SELECT DISTINCT c.auxiliar_profile_id FROM public.crew_messages c
             WHERE c.organization_id = v_org) th
      JOIN public.auxiliar_profiles ap ON ap.id = th.auxiliar_profile_id
      JOIN public.profiles p ON p.id = ap.profile_id
      LEFT JOIN public.residences res ON res.id = ap.residence_id
      CROSS JOIN LATERAL (
        SELECT c.body, c.sender_role, c.created_at, c.reservation_id,
               CASE WHEN c.sender_role = 'admin'
                    THEN nullif(split_part(btrim(sp.full_name), ' ', 1), '') END AS sender_name
        FROM public.crew_messages c
        LEFT JOIN public.profiles sp ON sp.id = c.sender_profile_id
        WHERE c.auxiliar_profile_id = ap.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      ) last
      LEFT JOIN LATERAL (
        SELECT cv.id, cv.closed_at, cv.last_message_at FROM public.crew_conversations cv
        WHERE cv.auxiliar_profile_id = ap.id
        ORDER BY cv.last_message_at DESC LIMIT 1
      ) cur ON true
      ORDER BY last.created_at DESC
      LIMIT 200
    ) t
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Permisos
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.crew_idle_interval()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_conv_is_open(timestamptz, timestamptz)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_send_message(text, uuid, uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_list_messages(uuid, int, uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_conversations_list(uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_close_conversation(uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_threads_admin()                         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_idle_interval()                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_conv_is_open(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_send_message(text, uuid, uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_list_messages(uuid, int, uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_conversations_list(uuid)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_close_conversation(uuid)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_threads_admin()                        TO authenticated;

COMMIT;
