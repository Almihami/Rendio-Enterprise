-- =============================================================================
-- 0173 · Chat del turno (jefes ↔ conductores que están en turno)
-- =============================================================================
-- Harold (17-nov-2026): «creemos un nuevo apartado de chat, donde desde el sistema
-- nos podamos comunicar con los conductores, de esta forma tener un control de la
-- operación… un chat grupal que se borre cada que cambian de turno… para dejar de
-- usar algo que sea temporal» (hoy es un grupo de WhatsApp).
--
-- Un chat GRUPAL por turno:
--   · Quiénes: los jefes de la organización y los conductores del turno de AHORA
--     (conductores_del_turno, 0144: horario publicado + cambios aceptados + los
--     que tienen el turno abierto). Nadie agrega ni saca gente.
--   · El turno es el de turno_de() (0144): 00:00–corte = tarde del día anterior;
--     corte–14:00 = mañana; 14:00–24:00 = tarde.
--   · Se LIMPIA en cada cambio de turno (cada mensaje lleva su día y su turno y
--     la pantalla solo lee el de ahora) pero NO se borra: los jefes pueden leer
--     los turnos anteriores. Se purga solo a los app_settings.shift_chat_keep_days
--     días (30).
--   · Leído: read_by guarda quién lo leyó (como reservation_messages y
--     crew_messages). El jefe ve «Leído por 2 de 2»; el conductor, ✓✓.
--   · El aviso (push) lo manda la app al enviar, como en los otros chats
--     (Api.sendPush): shift_chat_send devuelve a quién.
--
-- La tabla tiene RLS encendida y SIN políticas: solo la leen y la escriben las
-- funciones de abajo.
--
-- Down: down_migrations/0173_chat_del_turno.down.sql
-- =============================================================================
BEGIN;

-- ── 1. Cuántos días se guarda ────────────────────────────────────────────────
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS shift_chat_keep_days smallint NOT NULL DEFAULT 30;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_shift_chat_keep_days_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_shift_chat_keep_days_range CHECK (shift_chat_keep_days BETWEEN 1 AND 365);
COMMENT ON COLUMN public.app_settings.shift_chat_keep_days
  IS '0173: días que se guardan los mensajes del chat del turno antes de purgarse solos.';

-- ── 2. Los mensajes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shift_chat_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shift_day         date NOT NULL,
  shift_band        text NOT NULL CHECK (shift_band IN ('am', 'pm')),
  sender_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  sender_role       text NOT NULL CHECK (sender_role IN ('admin', 'driver')),
  body              text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
  read_by           uuid[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_chat_messages_turno_idx
  ON public.shift_chat_messages (organization_id, shift_day, shift_band, created_at);
DROP TRIGGER IF EXISTS tr_shift_chat_messages_set_updated_at ON public.shift_chat_messages;
CREATE TRIGGER tr_shift_chat_messages_set_updated_at
  BEFORE UPDATE ON public.shift_chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.shift_chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_chat_messages FROM anon, authenticated;
COMMENT ON TABLE public.shift_chat_messages
  IS '0173: chat del turno (jefes ↔ conductores en turno). Un hilo por organización, día y turno. Solo por las funciones shift_chat_*.';

-- ── 3. Quién soy y en qué turno estamos ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shift_chat_ctx(
  OUT me uuid, OUT org uuid, OUT rol text, OUT dia date, OUT turno text, OUT miembro boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE t record;
BEGIN
  me := auth.uid(); org := public.current_user_org(); rol := public.current_user_role();
  SELECT * INTO t FROM public.turno_de(now());
  dia := t.dia; turno := t.turno; miembro := false;
  IF me IS NULL OR org IS NULL THEN RETURN; END IF;
  IF rol = 'admin' THEN
    miembro := true;
  ELSIF rol = 'driver' THEN
    miembro := EXISTS (SELECT 1 FROM public.conductores_del_turno(org, now()) c WHERE c.profile_id = me);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_ctx() FROM PUBLIC, anon, authenticated;

-- Desde qué hora corre un turno (para el rótulo «Turno de la tarde · desde las 2:00 p. m.»).
CREATE OR REPLACE FUNCTION public.shift_chat_desde(p_dia date, p_turno text)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_dia::timestamp + CASE WHEN p_turno = 'am'
            THEN make_interval(mins => coalesce((SELECT s.route_night_cutoff_min FROM public.app_settings s WHERE s.id = 'singleton'), 120)::int)
            ELSE interval '14 hours' END) AT TIME ZONE 'America/Bogota';
$$;
REVOKE ALL ON FUNCTION public.shift_chat_desde(date, text) FROM PUBLIC, anon, authenticated;

-- ── 4. Leer el chat ──────────────────────────────────────────────────────────
-- Sin argumentos: el turno de ahora. Con día y turno: un turno anterior (solo jefes).
-- Quien no entra recibe { ok:false, reason } (no un error): la pantalla lo dice.
CREATE OR REPLACE FUNCTION public.shift_chat_list(p_day date DEFAULT NULL, p_band text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  x record; v_dia date; v_turno text; v_actual boolean; v_ref timestamptz; v_drv uuid[];
BEGIN
  SELECT * INTO x FROM public.shift_chat_ctx();
  IF x.me IS NULL OR x.org IS NULL OR x.rol IS NULL OR x.rol NOT IN ('admin', 'driver') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sin_acceso');
  END IF;
  v_dia := coalesce(p_day, x.dia);
  v_turno := coalesce(nullif(btrim(coalesce(p_band, '')), ''), x.turno);
  IF v_turno NOT IN ('am', 'pm') THEN
    RAISE EXCEPTION 'Ese turno no existe' USING ERRCODE = '22023';
  END IF;
  v_actual := (v_dia = x.dia AND v_turno = x.turno);
  IF NOT v_actual AND x.rol <> 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'solo_jefes');
  END IF;
  IF v_actual AND NOT x.miembro THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'fuera_de_turno', 'day', x.dia, 'band', x.turno);
  END IF;
  -- Los conductores de ESE turno (de ahora, o del horario si es uno anterior).
  v_ref := CASE WHEN v_actual THEN now() ELSE public.shift_chat_desde(v_dia, v_turno) + interval '4 hours' END;
  SELECT coalesce(array_agg(c.profile_id), '{}') INTO v_drv FROM public.conductores_del_turno(x.org, v_ref) c;

  RETURN jsonb_build_object(
    'ok', true, 'day', v_dia, 'band', v_turno, 'current', v_actual,
    'can_write', v_actual AND x.miembro,
    'since', public.shift_chat_desde(v_dia, v_turno),
    'me', x.me, 'role', x.rol,
    'drivers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', public.short_name(p.full_name)) ORDER BY p.full_name)
                           FROM public.profiles p WHERE p.id = ANY (v_drv)), '[]'::jsonb),
    'admins', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', public.short_name(p.full_name)) ORDER BY p.full_name)
                          FROM public.ops_alert_recipients_of(x.org) r JOIN public.profiles p ON p.id = r.profile_id), '[]'::jsonb),
    'messages', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'body', m.body, 'at', m.created_at,
               'sender_id', m.sender_profile_id, 'role', m.sender_role,
               'sender', (SELECT public.short_name(p.full_name) FROM public.profiles p WHERE p.id = m.sender_profile_id),
               'mine', m.sender_profile_id = x.me,
               'read_any', EXISTS (SELECT 1 FROM unnest(m.read_by) u WHERE u <> m.sender_profile_id),
               'read_drivers', (SELECT count(*) FROM unnest(m.read_by) u WHERE u <> m.sender_profile_id AND u = ANY (v_drv)),
               'read_ids', coalesce((SELECT jsonb_agg(u) FROM unnest(m.read_by) u WHERE u <> m.sender_profile_id), '[]'::jsonb),
               'read_names', coalesce((SELECT jsonb_agg(public.short_name(p.full_name) ORDER BY p.full_name)
                                         FROM public.profiles p WHERE p.id = ANY (m.read_by) AND p.id <> m.sender_profile_id), '[]'::jsonb)
             ) ORDER BY m.created_at, m.id)
        FROM public.shift_chat_messages m
       WHERE m.organization_id = x.org AND m.shift_day = v_dia AND m.shift_band = v_turno), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_list(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_chat_list(date, text) TO authenticated;

-- ── 5. Escribir ──────────────────────────────────────────────────────────────
-- Devuelve a quién avisarle (la app manda el push, como en los otros chats).
CREATE OR REPLACE FUNCTION public.shift_chat_send(p_body text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  x record; v_body text := btrim(coalesce(p_body, ''));
  v_id uuid; v_at timestamptz; v_nombre text; v_dias int;
  v_jefes uuid[]; v_cond uuid[];
BEGIN
  SELECT * INTO x FROM public.shift_chat_ctx();
  IF x.me IS NULL THEN
    RAISE EXCEPTION 'Tu sesión se cerró: vuelve a entrar' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(x.miembro, false) THEN
    RAISE EXCEPTION 'El chat es de quienes están en turno' USING ERRCODE = '42501';
  END IF;
  IF v_body = '' THEN
    RAISE EXCEPTION 'Escribe un mensaje' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) > 500 THEN
    RAISE EXCEPTION 'El mensaje es muy largo (máximo 500 letras)' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shift_chat_messages
    (organization_id, shift_day, shift_band, sender_profile_id, sender_role, body, read_by, created_at)
  VALUES (x.org, x.dia, x.turno, x.me, x.rol, v_body, ARRAY[x.me], clock_timestamp())
  RETURNING id, created_at INTO v_id, v_at;

  SELECT public.short_name(p.full_name) INTO v_nombre FROM public.profiles p WHERE p.id = x.me;
  SELECT coalesce(array_agg(DISTINCT a.profile_id), '{}') INTO v_jefes
    FROM public.ops_alert_recipients_of(x.org) a WHERE a.profile_id <> x.me;
  SELECT coalesce(array_agg(DISTINCT c.profile_id), '{}') INTO v_cond
    FROM public.conductores_del_turno(x.org, now()) c WHERE c.profile_id <> x.me;

  -- Purga de lo viejo, de paso (no hace falta un reloj aparte).
  SELECT s.shift_chat_keep_days INTO v_dias FROM public.app_settings s WHERE s.id = 'singleton';
  DELETE FROM public.shift_chat_messages
   WHERE organization_id = x.org AND created_at < now() - make_interval(days => coalesce(v_dias, 30));

  RETURN jsonb_build_object(
    'id', v_id, 'at', v_at, 'day', x.dia, 'band', x.turno,
    'sender', v_nombre, 'role', x.rol,
    'to_admins', to_jsonb(v_jefes), 'to_drivers', to_jsonb(v_cond));
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_send(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_chat_send(text) TO authenticated;

-- ── 6. Marcar leído lo del turno de ahora ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shift_chat_mark_read()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE x record; v_n int := 0;
BEGIN
  SELECT * INTO x FROM public.shift_chat_ctx();
  IF x.me IS NULL OR NOT coalesce(x.miembro, false) THEN RETURN 0; END IF;
  UPDATE public.shift_chat_messages m
     SET read_by = m.read_by || x.me
   WHERE m.organization_id = x.org AND m.shift_day = x.dia AND m.shift_band = x.turno
     AND m.sender_profile_id <> x.me AND NOT (x.me = ANY (m.read_by));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_mark_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_chat_mark_read() TO authenticated;

-- ── 7. El resumen: si entro, cuántos sin leer y el último mensaje ────────────
-- Para el globo de la pestaña y la fila «Chat del turno» del Inicio del conductor.
CREATE OR REPLACE FUNCTION public.shift_chat_unread()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE x record; v_last record;
BEGIN
  SELECT * INTO x FROM public.shift_chat_ctx();
  IF x.me IS NULL OR NOT coalesce(x.miembro, false) THEN
    RETURN jsonb_build_object('member', false, 'n', 0, 'last', NULL);
  END IF;
  SELECT m.body, m.created_at, m.sender_role, m.sender_profile_id,
         (SELECT public.short_name(p.full_name) FROM public.profiles p WHERE p.id = m.sender_profile_id) AS sender
    INTO v_last
    FROM public.shift_chat_messages m
   WHERE m.organization_id = x.org AND m.shift_day = x.dia AND m.shift_band = x.turno
   ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'member', true, 'day', x.dia, 'band', x.turno,
    'n', (SELECT count(*) FROM public.shift_chat_messages m
           WHERE m.organization_id = x.org AND m.shift_day = x.dia AND m.shift_band = x.turno
             AND m.sender_profile_id <> x.me AND NOT (x.me = ANY (m.read_by))),
    'last', CASE WHEN v_last.body IS NULL THEN NULL ELSE jsonb_build_object(
              'body', v_last.body, 'at', v_last.created_at, 'role', v_last.sender_role,
              'sender', v_last.sender, 'mine', v_last.sender_profile_id = x.me) END);
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_unread() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_chat_unread() TO authenticated;

-- ── 8. Turnos anteriores (solo jefes) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shift_chat_history(p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE x record;
BEGIN
  SELECT * INTO x FROM public.shift_chat_ctx();
  IF x.me IS NULL OR x.org IS NULL OR x.rol IS DISTINCT FROM 'admin' THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('day', q.shift_day, 'band', q.shift_band, 'n', q.n, 'first_at', q.f, 'last_at', q.l)
                     ORDER BY q.shift_day DESC, q.shift_band DESC)
      FROM (SELECT m.shift_day, m.shift_band, count(*) AS n, min(m.created_at) AS f, max(m.created_at) AS l
              FROM public.shift_chat_messages m
             WHERE m.organization_id = x.org AND NOT (m.shift_day = x.dia AND m.shift_band = x.turno)
             GROUP BY 1, 2
             ORDER BY 1 DESC, 2 DESC
             LIMIT greatest(1, least(coalesce(p_limit, 30), 120))) q), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.shift_chat_history(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shift_chat_history(integer) TO authenticated;

COMMIT;
