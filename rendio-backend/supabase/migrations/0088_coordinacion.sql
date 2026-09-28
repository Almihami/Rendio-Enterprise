-- =============================================================================
-- 0088 · Coordinación: el canal del tripulante con los jefes de la operación
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P9 (D11, crítica 12).
--
-- POR QUÉ UN CANAL APARTE. Con conductor asignado, send_reservation_message
-- (0067) manda lo que escribe el tripulante SOLO al conductor: «No encuentro al
-- conductor» nunca les llegaría a los jefes. Así que:
--   · lo que es DE UN TRASLADO sigue en reservation_messages (el hilo de 3
--     puntas del viaje: «Mensaje» en la pantalla del viaje);
--   · lo que es con LOS JEFES va aquí, en crew_messages: UN hilo por
--     tripulante. Si se abre desde un viaje, reservation_id viaja como CONTEXTO
--     (el jefe ve «Sobre el traslado del jue 16 · Salida»), no como hilo.
--
-- Tabla public.crew_messages
--   · RLS encendida. SELECT: el tripulante solo su hilo; el jefe los de su
--     organización. SIN policies de INSERT/UPDATE/DELETE: se escribe solo por
--     las RPC de abajo.
--   · Privilegios por columna: authenticated NO puede leer sender_profile_id
--     ni read_by directo. El tripulante ve «Coordinación», nunca QUÉ jefe
--     escribió (D11); las RPC tampoco lo devuelven.
--   · read_at = cuándo lo leyó EL OTRO LADO (el hilo tiene dos lados: el
--     tripulante y el equipo). Un mensaje del tripulante queda leído cuando
--     CUALQUIER jefe lo abre; read_by guarda quiénes.
--
-- RPC (todas SECURITY DEFINER, search_path fijo, EXECUTE solo authenticated):
--   crew_send_message(p_body, p_auxiliar_profile_id DEFAULT NULL, p_reservation_id DEFAULT NULL) → jsonb
--       tripulante → su hilo; destinatarios = ops_alert_recipients() de SU
--       organización. Jefe → el hilo p_auxiliar_profile_id (misma org);
--       destinatario = el tripulante. Valida que la reserva sea de ese hilo.
--       Devuelve {id, created_at, sender_role, auxiliar_profile_id,
--       recipient_profile_ids[]}; el push lo manda el cliente (igual que 0067).
--   crew_list_messages(p_auxiliar_profile_id DEFAULT NULL, p_limit DEFAULT 100) → jsonb
--       los últimos p_limit (1..300) en orden de llegada; SIN sender_profile_id.
--   crew_mark_read(p_auxiliar_profile_id DEFAULT NULL) → int
--   crew_unread() → int  (tripulante: lo del equipo sin leer; jefe: lo de los
--       tripulantes de su organización sin leer por nadie del equipo)
--   crew_threads_admin() → jsonb  (bandeja del jefe: un renglón por hilo)
--
-- app_settings.ops_contact_phone / ops_contact_hours: teléfono y horario de
-- Coordinación. Vacíos = la app no muestra ni teléfono ni horario (nunca «24/7»).
-- Los lee cualquiera autenticado (p_app_settings_select_all) y los cambia el
-- jefe (p_app_settings_update_admin).
--
-- Idempotente. Down: down_migrations/0088_coordinacion.down.sql (borra la tabla
-- con sus mensajes: avisar).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tabla
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crew_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  sender_profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_role         text NOT NULL,
  body                text NOT NULL,
  reservation_id      uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  read_at             timestamptz,
  read_by             uuid[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- clock_timestamp() y no now(): dos mensajes en la misma transacción (un
-- script, una prueba) quedan en el orden en que se escribieron.
ALTER TABLE public.crew_messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();

ALTER TABLE public.crew_messages DROP CONSTRAINT IF EXISTS crew_messages_sender_role_valid;
ALTER TABLE public.crew_messages ADD  CONSTRAINT crew_messages_sender_role_valid
  CHECK (sender_role IN ('auxiliar', 'admin'));
ALTER TABLE public.crew_messages DROP CONSTRAINT IF EXISTS crew_messages_body_len;
ALTER TABLE public.crew_messages ADD  CONSTRAINT crew_messages_body_len
  CHECK (length(btrim(body)) BETWEEN 1 AND 500);

CREATE INDEX IF NOT EXISTS idx_crew_messages_thread ON public.crew_messages (auxiliar_profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crew_messages_org_unread ON public.crew_messages (organization_id, created_at)
  WHERE read_at IS NULL;

DROP TRIGGER IF EXISTS tr_crew_messages_set_updated_at ON public.crew_messages;
CREATE TRIGGER tr_crew_messages_set_updated_at
  BEFORE UPDATE ON public.crew_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.crew_messages IS
  'Coordinación: un hilo por tripulante con los jefes. reservation_id = contexto opcional. Se escribe solo por RPC. 0088.';

-- ---------------------------------------------------------------------------
-- 2. RLS y privilegios
-- ---------------------------------------------------------------------------
ALTER TABLE public.crew_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.crew_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organization_id, auxiliar_profile_id, sender_role, body, reservation_id,
              read_at, created_at, updated_at)
  ON public.crew_messages TO authenticated;

DROP POLICY IF EXISTS p_crew_messages_select_own ON public.crew_messages;
CREATE POLICY p_crew_messages_select_own
  ON public.crew_messages
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND auxiliar_profile_id = public.current_auxiliar_id()
  );

DROP POLICY IF EXISTS p_crew_messages_select_admin ON public.crew_messages;
CREATE POLICY p_crew_messages_select_admin
  ON public.crew_messages
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- ---------------------------------------------------------------------------
-- 3. Enviar
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

-- ---------------------------------------------------------------------------
-- 4. Leer el hilo
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Marcar leído
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_mark_read(p_auxiliar_profile_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_role text := public.current_user_role();
  v_aux  uuid;
  v_from text;
  v_n    integer := 0;
BEGIN
  IF v_me IS NULL THEN RETURN 0; END IF;

  IF v_role = 'auxiliar' THEN
    v_aux := public.current_auxiliar_id();
    IF v_aux IS NULL OR (p_auxiliar_profile_id IS NOT NULL AND p_auxiliar_profile_id <> v_aux) THEN
      RETURN 0;
    END IF;
    v_from := 'admin';
  ELSIF v_role = 'admin' THEN
    v_aux := p_auxiliar_profile_id;
    IF v_aux IS NULL OR public.auxiliar_profile_org(v_aux) IS DISTINCT FROM public.current_user_org() THEN
      RETURN 0;
    END IF;
    v_from := 'auxiliar';
  ELSE
    RETURN 0;
  END IF;

  UPDATE public.crew_messages c
     SET read_at = coalesce(c.read_at, now()),
         read_by = CASE WHEN v_me = ANY (c.read_by) THEN c.read_by ELSE c.read_by || v_me END
   WHERE c.auxiliar_profile_id = v_aux
     AND c.sender_role = v_from
     AND (c.read_at IS NULL OR NOT (v_me = ANY (c.read_by)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Sin leer (globo de la campana / de la bandeja)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_unread()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_aux  uuid;
  v_n    integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;

  IF v_role = 'auxiliar' THEN
    v_aux := public.current_auxiliar_id();
    IF v_aux IS NULL THEN RETURN NULL; END IF;
    SELECT count(*) INTO v_n FROM public.crew_messages
     WHERE auxiliar_profile_id = v_aux AND sender_role = 'admin' AND read_at IS NULL;
  ELSIF v_role = 'admin' THEN
    SELECT count(*) INTO v_n FROM public.crew_messages
     WHERE organization_id = public.current_user_org() AND sender_role = 'auxiliar' AND read_at IS NULL;
  ELSE
    RETURN NULL;
  END IF;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Bandeja del jefe
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
REVOKE ALL ON FUNCTION public.crew_mark_read(uuid)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_unread()                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_threads_admin()               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_send_message(text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_list_messages(uuid, int)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_mark_read(uuid)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_unread()                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_threads_admin()               TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Teléfono y horario de Coordinación
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS ops_contact_phone text,
  ADD COLUMN IF NOT EXISTS ops_contact_hours text;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_ops_contact_phone_len;
ALTER TABLE public.app_settings ADD  CONSTRAINT app_settings_ops_contact_phone_len
  CHECK (ops_contact_phone IS NULL OR length(ops_contact_phone) <= 30);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_ops_contact_hours_len;
ALTER TABLE public.app_settings ADD  CONSTRAINT app_settings_ops_contact_hours_len
  CHECK (ops_contact_hours IS NULL OR length(ops_contact_hours) <= 60);

COMMENT ON COLUMN public.app_settings.ops_contact_phone IS
  'Teléfono de Coordinación que ve el tripulante. Vacío = no se muestra. 0088.';
COMMENT ON COLUMN public.app_settings.ops_contact_hours IS
  'Horario de Coordinación en texto («Lun a dom · 4:00 a. m. a 10:00 p. m.»). Vacío = no se muestra. 0088.';

COMMIT;
