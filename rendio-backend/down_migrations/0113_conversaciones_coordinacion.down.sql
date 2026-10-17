-- =============================================================================
-- 0113 DOWN · vuelve a Coordinación de 0088 (un hilo por tripulante)
-- =============================================================================
-- Los MENSAJES no se tocan: solo pierden la conversación a la que pertenecían.
-- Vuelven las funciones de 0088 tal cual (copiadas de ahí) y se borran las de
-- 0113, la tabla de conversaciones y la columna de Ajustes.
-- =============================================================================
BEGIN;

DROP FUNCTION IF EXISTS public.crew_conversations_list(uuid);
DROP FUNCTION IF EXISTS public.crew_close_conversation(uuid);
DROP FUNCTION IF EXISTS public.crew_list_messages(uuid, int, uuid);

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

  INSERT INTO public.crew_messages
    (organization_id, auxiliar_profile_id, sender_profile_id, sender_role, body, reservation_id, read_by, created_at)
  VALUES
    (v_org, v_aux, v_me, v_role, v_body, p_reservation_id, ARRAY[v_me], clock_timestamp())
  RETURNING id, created_at INTO v_id, v_at;

  IF v_role = 'auxiliar' THEN
    SELECT coalesce(array_agg(DISTINCT r.profile_id), '{}')
      INTO v_to
    FROM public.ops_alert_recipients() r
    JOIN public.profiles p ON p.id = r.profile_id
    WHERE p.organization_id = v_org;
  ELSE
    v_to := ARRAY[v_aux_pf];
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'created_at', v_at,
    'sender_role', v_role,
    'auxiliar_profile_id', v_aux,
    'reservation_id', p_reservation_id,
    'recipient_profile_ids', to_jsonb(v_to)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.crew_list_messages(
  p_auxiliar_profile_id uuid DEFAULT NULL,
  p_limit int DEFAULT 100
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

  RETURN COALESCE((
    SELECT jsonb_agg(m.j ORDER BY m.created_at, m.id)
    FROM (
      SELECT c.created_at, c.id, jsonb_build_object(
          'id',          c.id,
          'sender_role', c.sender_role,
          'mine',        c.sender_profile_id = v_me,
          'body',        c.body,
          'created_at',  c.created_at,
          'read',        c.read_at IS NOT NULL,
          'read_at',     c.read_at,
          'reservation', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id',        r.id,
              'direction', r.direction,
              'date',      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
              'time',      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'HH24:MI')) END
        ) AS j
      FROM public.crew_messages c
      LEFT JOIN public.reservations r ON r.id = c.reservation_id
      WHERE c.auxiliar_profile_id = v_aux
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT v_lim
    ) m
  ), '[]'::jsonb);
END;
$$;

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
          'last_at',             last.created_at,
          'last_reservation_id', last.reservation_id,
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
        SELECT c.body, c.sender_role, c.created_at, c.reservation_id
        FROM public.crew_messages c
        WHERE c.auxiliar_profile_id = ap.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      ) last
      ORDER BY last.created_at DESC
      LIMIT 200
    ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.crew_send_message(text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_list_messages(uuid, int)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_threads_admin()               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_send_message(text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_list_messages(uuid, int)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_threads_admin()               TO authenticated;

DROP INDEX IF EXISTS public.idx_crew_messages_conversation;
ALTER TABLE public.crew_messages DROP COLUMN IF EXISTS conversation_id;
DROP TABLE IF EXISTS public.crew_conversations;
DROP FUNCTION IF EXISTS public.crew_conv_is_open(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.crew_idle_interval();
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_crew_chat_idle_hours_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS crew_chat_idle_hours;

COMMIT;
