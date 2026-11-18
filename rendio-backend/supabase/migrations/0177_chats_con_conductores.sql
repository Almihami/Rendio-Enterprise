-- =============================================================================
-- 0177 · Chats de tripulantes con conductores, por turno (Coordinación)
-- =============================================================================
-- Harold (17-nov-2026): en Coordinación «a veces veo chats entre la tripulante y
-- el conductor, y otras entre el tripulante y el admin: debería estar segmentada
-- y debería decir qué conductor es». Y después: «segmentar por turnos, turno tal
-- se conversó con tal, para llevar un registro». Eligió que se borren solos a
-- los 30 días.
--
-- Los dos chats ya existían y no se tocan:
--   · crew_messages (0088/0113): tripulante ↔ jefes («Con la oficina»).
--   · reservation_messages (0052/0067): el chat de CADA traslado, tripulante ↔
--     su conductor (y el jefe si escribe). Hasta hoy el jefe solo lo veía
--     entrando a Reservas, traslado por traslado, y la burbuja decía «Conductor»
--     sin nombre.
--
-- Esto agrega:
--   1. admin_chats_conductores(p_dias): un renglón por traslado con chat en los
--      últimos p_dias días, con su TURNO (turno_de, 0144, sobre la hora del
--      traslado: la madrugada cuenta en la tarde del día anterior), el conductor
--      con el que habló (el último conductor que escribió; si no escribió
--      ninguno, el de la vuelta), el tripulante y lo último que se dijo.
--      Sin «sin leer»: el jefe lee este chat SIN marcarlo leído a propósito
--      (admin-chat.js: si marcara, le apagaría el aviso al conductor).
--   2. app_settings.reservation_chat_keep_days (30) y purge_reservation_messages():
--      borra la conversación ENTERA de un traslado cuando su último mensaje
--      tiene más de esos días (no la parte por la mitad). pg_cron todos los días
--      a las 3:40 a. m. de Bogotá.
--
-- Down: down_migrations/0177_chats_con_conductores.down.sql
-- =============================================================================
BEGIN;

-- ── 1. Cuántos días se guardan ───────────────────────────────────────────────
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS reservation_chat_keep_days smallint NOT NULL DEFAULT 30;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_reservation_chat_keep_days_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_reservation_chat_keep_days_range
  CHECK (reservation_chat_keep_days BETWEEN 1 AND 365);
COMMENT ON COLUMN public.app_settings.reservation_chat_keep_days
  IS '0177: días que se guarda el chat de un traslado (tripulante ↔ conductor) después de su último mensaje.';

-- Para agrupar por traslado y purgar sin recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS reservation_messages_res_created_idx
  ON public.reservation_messages (reservation_id, created_at);

-- ── 2. La lista por turno ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_chats_conductores(p_dias integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_dias integer := least(greatest(coalesce(p_dias, 7), 1), 60);
BEGIN
  IF v_me IS NULL OR v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RETURN NULL;
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(z.j ORDER BY z.hora DESC NULLS LAST, z.last_at DESC)
    FROM (
      SELECT coalesce(v.hora, m.first_at) AS hora, m.last_at, jsonb_build_object(
          'reservation_id',       r.id,
          'dia',                  (public.turno_de(coalesce(v.hora, m.first_at))).dia,
          'turno',                (public.turno_de(coalesce(v.hora, m.first_at))).turno,
          'direction',            r.direction,
          'hora',                 coalesce(v.hora, m.first_at),
          'flight_code',          r.flight_code,
          'cancelled',            r.cancelled_at IS NOT NULL,
          'auxiliar_profile_id',  ap.id,
          'tripulante',           pa.full_name,
          'tripulante_phone',     pa.phone,
          'residence',            res.name,
          'conductor_profile_id', coalesce(w.drv, v.drv),
          'conductor',            pd.full_name,
          'conductor_phone',      pd.phone,
          'mensajes',             m.mensajes,
          'del_conductor',        m.del_conductor,
          'last_body',            l.body,
          'last_role',            l.sender_role,
          'last_at',              m.last_at
        ) AS j
      FROM (
        SELECT rm.reservation_id AS rid,
               count(*) AS mensajes,
               count(*) FILTER (WHERE rm.sender_role = 'driver') AS del_conductor,
               min(rm.created_at) AS first_at,
               max(rm.created_at) AS last_at
        FROM public.reservation_messages rm
        GROUP BY rm.reservation_id
        HAVING max(rm.created_at) > now() - make_interval(days => v_dias)
      ) m
      JOIN public.reservations r       ON r.id = m.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pa          ON pa.id = ap.profile_id AND pa.organization_id = v_org
      LEFT JOIN public.residences res  ON res.id = coalesce(r.residence_id, ap.residence_id)
      -- La vuelta del traslado (la más reciente que no se canceló): su hora y su conductor.
      LEFT JOIN LATERAL (
        SELECT coalesce(rs.estimated_arrival_at, ra.planned_start_at) AS hora, dp.profile_id AS drv
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
        WHERE rs.reservation_id = r.id AND ra.status IS DISTINCT FROM 'cancelled'
        ORDER BY ra.planned_start_at DESC NULLS LAST
        LIMIT 1
      ) v0 ON true
      CROSS JOIN LATERAL (
        SELECT coalesce(v0.hora, r.calculated_pickup_at, r.required_arrival_at) AS hora, v0.drv
      ) v
      -- El último conductor que escribió en ESTE chat (si cambiaron de carro, es con quien habló).
      LEFT JOIN LATERAL (
        SELECT rm.sender_profile_id AS drv
        FROM public.reservation_messages rm
        WHERE rm.reservation_id = r.id AND rm.sender_role = 'driver'
        ORDER BY rm.created_at DESC
        LIMIT 1
      ) w ON true
      LEFT JOIN public.profiles pd ON pd.id = coalesce(w.drv, v.drv)
      CROSS JOIN LATERAL (
        SELECT rm.body, rm.sender_role
        FROM public.reservation_messages rm
        WHERE rm.reservation_id = r.id
        ORDER BY rm.created_at DESC, rm.id DESC
        LIMIT 1
      ) l
      ORDER BY m.last_at DESC
      LIMIT 400
    ) z
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_chats_conductores(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_chats_conductores(integer) TO authenticated;
COMMENT ON FUNCTION public.admin_chats_conductores(integer)
  IS '0177: chats de traslado (tripulante ↔ conductor) de los últimos p_dias días, con su turno (turno_de) y el conductor con el que se habló. Solo jefes.';

-- ── 3. El borrado a los N días ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_reservation_messages()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dias integer;
  v_n    integer;
BEGIN
  SELECT s.reservation_chat_keep_days INTO v_dias FROM public.app_settings s WHERE s.id = 'singleton';
  v_dias := greatest(coalesce(v_dias, 30), 1);
  -- La conversación entera de un traslado, cuando su ÚLTIMO mensaje ya pasó el plazo.
  DELETE FROM public.reservation_messages rm
   WHERE rm.reservation_id IN (
     SELECT x.reservation_id FROM public.reservation_messages x
      GROUP BY x.reservation_id
     HAVING max(x.created_at) < now() - make_interval(days => v_dias));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_reservation_messages() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.purge_reservation_messages()
  IS '0177: borra el chat de los traslados cuyo último mensaje tiene más de app_settings.reservation_chat_keep_days días. La llama pg_cron (purge-reservation-chat).';

DO $$
BEGIN
  -- 3:40 a. m. en Bogotá (UTC−5) = 08:40 UTC; pg_cron corre en UTC.
  PERFORM cron.schedule('purge-reservation-chat', '40 8 * * *',
    $job$SELECT public.purge_reservation_messages();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): la purga queda creada pero nadie la llama.', SQLERRM;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
