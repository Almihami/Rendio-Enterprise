-- =============================================================================
-- 0140 · Entrega de turno: a quién le entrega el carro cada conductor (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (26-oct): «que en el módulo administrativo nosotros podamos
-- poner a quién le entrega el turno cada conductor y a ellos les aparezca en la app
-- bien visible; cuando entreguen el turno que pongan entregado; que eso les aparezca
-- sobre las 12 ese apartado».
--
-- No hay parqueadero: al terminar su franja el conductor le pasa el carro al que
-- sigue (o lo deja en su casa o en la del jefe). Dos entregas por carro al día:
--   · la de la MAÑANA, a las 2:00 p. m. (el corte AM/PM del tablero);
--   · la de la TARDE, al corte de la madrugada (route_night_cutoff_min, 2:00 a. m.):
--     el de la tarde le deja el carro al de la mañana siguiente.
-- «Sobre las 12»: la tarjeta sale handover_lead_min (120) antes de la hora, o sea a
-- las 12 del mediodía y a las 12 de la noche.
--
-- QUIÉN RECIBE (decisión de la profa, 26-oct): lo llena el sistema y el jefe solo
-- corrige. Automático = el que maneja ESE carro del plan publicado en la franja
-- siguiente («Carro 1» del plan; si la vuelta no lo trae, la placa del turno). Si es
-- el mismo conductor, «sigue con el carro» y no hay entrega. Si el día siguiente
-- todavía no está publicado, queda sin definir hasta que el jefe lo ponga.
--
-- QUÉ HACE
--   1. shift_handovers: lo que el jefe cambió (a quién, o un texto: «a Julián», «en
--      casa de…») y cuándo el conductor tocó «Entregado». Lo automático no se
--      guarda: se calcula (handover_effective).
--   2. Jefe: admin_handovers(día) → las entregas del día (automáticas + cambiadas,
--      con su estado) · admin_set_handover(día, franja, de, a, texto, automático).
--   3. Conductor: driver_my_handovers() → la tarjeta (entregas o recibes, a quién,
--      a qué hora, su teléfono) · driver_handover_delivered(día, franja, deshacer).
--      «Recibido» no pide toque: cuando el que recibe inicia turno, queda recibido.
--   4. handover_alerts() cada 5 min (pg_cron 'handover-alerts'):
--      🔑 al que entrega, al abrir la ventana: «Hoy entregas el carro a Daniel a las 2:00 p. m.»
--      ⚠️ a los jefes, handover_late_min (15) después de la hora sin «Entregado».
--      Una vez cada uno (dedupe).
--
-- NO SE TOCA ninguna función ni fila existente. Necesita 0097 (trip_notify), 0107
-- (route_night_cutoff_min), 0117 (ops_alert_recipients_of), 0124 (plan_car),
-- 0125 (hm_bog, short_name), 0130 (hm12_bog), 0132 (plan_vehicle_id).
-- Down: down_migrations/0140_entrega_de_turno.down.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS handover_lead_min int NOT NULL DEFAULT 120;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS handover_late_min int NOT NULL DEFAULT 15;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_handover_lead_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_handover_lead_range CHECK (handover_lead_min BETWEEN 15 AND 360);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_handover_late_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_handover_late_range CHECK (handover_late_min BETWEEN 5 AND 120);
COMMENT ON COLUMN public.app_settings.handover_lead_min IS
  '0140: cuántos minutos antes de la entrega de turno le sale al conductor la tarjeta «Entregas el carro a…» (120 = a las 12 m. y a las 12 a. m.).';
COMMENT ON COLUMN public.app_settings.handover_late_min IS
  '0140: minutos después de la hora de entrega sin «Entregado» en que se les avisa a los jefes.';

-- -----------------------------------------------------------------------------
-- 1. Lo que cambió el jefe y lo que marcó el conductor
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shift_handovers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  op_day          date NOT NULL,
  band            text NOT NULL CHECK (band IN ('am', 'pm')),
  from_profile    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_profile      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_text         text CHECK (to_text IS NULL OR length(to_text) BETWEEN 2 AND 80),
  manual          boolean NOT NULL DEFAULT false,   -- true = el jefe eligió a quién
  set_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  set_at          timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_handovers_uno_por_turno UNIQUE (organization_id, op_day, band, from_profile)
);
COMMENT ON TABLE public.shift_handovers IS
  '0140: entrega de turno. Solo lo que el jefe cambió (manual) y la marca «Entregado» del conductor; lo automático se calcula en handover_effective.';
DROP TRIGGER IF EXISTS tr_shift_handovers_set_updated_at ON public.shift_handovers;
CREATE TRIGGER tr_shift_handovers_set_updated_at BEFORE UPDATE ON public.shift_handovers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.shift_handovers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_shift_handovers_select_admin ON public.shift_handovers;
CREATE POLICY p_shift_handovers_select_admin ON public.shift_handovers FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());
DROP POLICY IF EXISTS p_shift_handovers_select_driver ON public.shift_handovers;
CREATE POLICY p_shift_handovers_select_driver ON public.shift_handovers FOR SELECT TO authenticated
  USING (from_profile = auth.uid() OR to_profile = auth.uid());
-- Sin políticas de escritura: todo pasa por las funciones de abajo.

-- -----------------------------------------------------------------------------
-- 2. Cuándo empieza y termina cada franja de un día operativo
--    am: del corte de la madrugada a las 14:00 · pm: de las 14:00 al corte del día
--    siguiente. La entrega es al final de la franja (fin).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handover_window(p_day date, p_band text, OUT ini timestamptz, OUT fin timestamptz)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_band = 'am' THEN ((p_day::timestamp + make_interval(mins => s.noche)) AT TIME ZONE 'America/Bogota')
              ELSE ((p_day::timestamp + interval '14 hours') AT TIME ZONE 'America/Bogota') END,
         CASE WHEN p_band = 'am' THEN ((p_day::timestamp + interval '14 hours') AT TIME ZONE 'America/Bogota')
              ELSE (((p_day + 1)::timestamp + make_interval(mins => s.noche)) AT TIME ZONE 'America/Bogota') END
    FROM (SELECT coalesce((SELECT route_night_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 120) AS noche) s;
$$;

-- El día operativo de un instante (la madrugada antes del corte es del día anterior).
CREATE OR REPLACE FUNCTION public.handover_op_day(p_at timestamptz)
RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT ((p_at AT TIME ZONE 'America/Bogota') - make_interval(mins =>
           coalesce((SELECT route_night_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 120)))::date;
$$;

-- -----------------------------------------------------------------------------
-- 3. Quién manejó cada carro en cada franja de un día, según lo publicado.
--    El carro: «Carro N» del plan (0124); si la vuelta no lo trae (las pegadas de
--    Julián), la placa del turno. Si un carro lo manejaron dos en la misma franja,
--    cuenta el de más vueltas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handover_drivers_of(p_org uuid, p_day date)
RETURNS TABLE (band text, car_key text, car_label text, plate text, profile_id uuid, vueltas int)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH w AS (
    SELECT (SELECT ini FROM public.handover_window(p_day, 'am')) AS am_ini,
           (SELECT fin FROM public.handover_window(p_day, 'am')) AS am_fin,
           (SELECT fin FROM public.handover_window(p_day, 'pm')) AS pm_fin
  ), v AS (
    SELECT CASE WHEN ra.planned_start_at < w.am_fin THEN 'am' ELSE 'pm' END AS band,
           CASE WHEN ra.plan_car IS NOT NULL THEN 'c:' || ra.plan_car
                WHEN coalesce(ra.plan_vehicle_id, ra.vehicle_id) IS NOT NULL THEN 'v:' || coalesce(ra.plan_vehicle_id, ra.vehicle_id)::text END AS car_key,
           coalesce(ra.plan_car, vh.license_plate, vh.internal_code) AS car_label,
           coalesce(vh.license_plate, vh.internal_code) AS plate,
           dp.profile_id
      FROM w
      CROSS JOIN public.route_assignments ra
      JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      JOIN public.profiles pr        ON pr.id = dp.profile_id
      LEFT JOIN public.vehicles vh   ON vh.id = coalesce(ra.plan_vehicle_id, ra.vehicle_id)
     WHERE pr.organization_id = p_org
       AND ra.status IN ('planned', 'in_progress', 'completed')
       AND ra.delegated_at IS NULL
       AND ra.planned_start_at >= w.am_ini AND ra.planned_start_at < w.pm_fin
  )
  SELECT DISTINCT ON (x.band, x.car_key) x.band, x.car_key, x.car_label, x.plate, x.profile_id, x.n
    FROM (SELECT v.band, v.car_key, max(v.car_label) AS car_label, max(v.plate) AS plate, v.profile_id, count(*)::int AS n
            FROM v WHERE v.car_key IS NOT NULL GROUP BY v.band, v.car_key, v.profile_id) x
   ORDER BY x.band, x.car_key, x.n DESC, x.profile_id;
$$;
REVOKE ALL ON FUNCTION public.handover_drivers_of(uuid, date) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Las entregas de un día: lo automático + lo que cambió el jefe + lo marcado.
--    Una fila por conductor y franja. sigue = el mismo conductor sigue con el carro.
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  IF to_regtype('public.handover_row') IS NULL THEN
    CREATE TYPE public.handover_row AS (op_day date, band text, car_label text, plate text, from_profile uuid, to_profile uuid,
                                        to_text text, manual boolean, sigue boolean, due_at timestamptz, delivered_at timestamptz);
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION public.handover_effective(p_org uuid, p_day date)
RETURNS SETOF public.handover_row
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH hoy AS (SELECT * FROM public.handover_drivers_of(p_org, p_day)),
       sig AS (SELECT * FROM public.handover_drivers_of(p_org, p_day + 1) s WHERE s.band = 'am'),
       auto AS (
    -- Mañana → tarde del mismo día, mismo carro.
    SELECT 'am'::text AS band, a.car_label, a.plate, a.profile_id AS from_profile,
           (SELECT t.profile_id FROM hoy t WHERE t.band = 'pm' AND t.car_key = a.car_key) AS to_profile
      FROM hoy a WHERE a.band = 'am'
    UNION ALL
    -- Tarde → mañana del día siguiente, mismo carro.
    SELECT 'pm'::text, a.car_label, a.plate, a.profile_id,
           (SELECT t.profile_id FROM sig t WHERE t.car_key = a.car_key)
      FROM hoy a WHERE a.band = 'pm'
  ), auto1 AS (
    -- Un conductor que manejó dos carros en la misma franja: una sola entrega (la primera).
    SELECT DISTINCT ON (x.band, x.from_profile) x.* FROM auto x ORDER BY x.band, x.from_profile, x.car_label
  ), o AS (
    SELECT h.* FROM public.shift_handovers h WHERE h.organization_id = p_org AND h.op_day = p_day
  )
  SELECT p_day,
         coalesce(a.band, o.band),
         a.car_label, a.plate,
         coalesce(a.from_profile, o.from_profile),
         CASE WHEN o.manual THEN o.to_profile ELSE a.to_profile END,
         CASE WHEN o.manual THEN o.to_text END,
         coalesce(o.manual, false),
         (NOT coalesce(o.manual, false)) AND a.to_profile IS NOT NULL AND a.to_profile = a.from_profile,
         (SELECT w.fin FROM public.handover_window(p_day, coalesce(a.band, o.band)) w),
         o.delivered_at
    FROM auto1 a
    FULL JOIN o ON o.band = a.band AND o.from_profile = a.from_profile;
$$;
REVOKE ALL ON FUNCTION public.handover_effective(uuid, date) FROM PUBLIC, anon, authenticated;

-- Cuándo empezó el turno del que recibe (= recibido). NULL si no ha iniciado.
CREATE OR REPLACE FUNCTION public.handover_received_at(p_to uuid, p_due timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT min(s.start_at) FROM public.shifts s JOIN public.driver_profiles dp ON dp.id = s.driver_id
   WHERE dp.profile_id = p_to AND s.start_at BETWEEN p_due - interval '3 hours' AND p_due + interval '6 hours';
$$;
REVOKE ALL ON FUNCTION public.handover_received_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- Una fila efectiva → lo que ven las pantallas.
CREATE OR REPLACE FUNCTION public.handover_json(e public.handover_row)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'op_day', e.op_day, 'band', e.band, 'due_at', e.due_at,
    'car', e.car_label, 'plate', e.plate,
    'from', jsonb_build_object('id', e.from_profile, 'name', pf.full_name, 'phone', pf.phone),
    'to', CASE WHEN e.to_profile IS NULL THEN NULL ELSE jsonb_build_object('id', e.to_profile, 'name', pt.full_name, 'phone', pt.phone) END,
    'to_text', e.to_text, 'manual', e.manual, 'sigue', e.sigue,
    'delivered_at', e.delivered_at,
    'received_at', CASE WHEN e.to_profile IS NULL OR e.sigue THEN NULL ELSE public.handover_received_at(e.to_profile, e.due_at) END)
    FROM (SELECT 1) one
    LEFT JOIN public.profiles pf ON pf.id = e.from_profile
    LEFT JOIN public.profiles pt ON pt.id = e.to_profile;
$$;
REVOKE ALL ON FUNCTION public.handover_json(public.handover_row) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Jefe
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_handovers(p_day date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo un jefe ve las entregas de turno' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(public.handover_json(e) ORDER BY e.due_at, e.car_label NULLS LAST, e.from_profile)
                     FROM public.handover_effective(v_org, p_day) e), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_handovers(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_handovers(date) TO authenticated;

-- p_auto = true: vuelve a lo automático (se borra lo que eligió el jefe; si ya se
-- entregó, se conserva la marca). Si no: a p_to (un conductor o jefe de la
-- organización) o, si es otra cosa, el texto p_text («en casa de Julián»).
CREATE OR REPLACE FUNCTION public.admin_set_handover(p_day date, p_band text, p_from uuid,
                                                     p_to uuid DEFAULT NULL, p_text text DEFAULT NULL, p_auto boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  uuid := public.current_user_org();
  v_txt  text := nullif(btrim(coalesce(p_text, '')), '');
  v_due  timestamptz;
  v_lead int := coalesce((SELECT handover_lead_min FROM public.app_settings WHERE id = 'singleton'), 120);
  v_name text;
  e      public.handover_row;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo un jefe cambia las entregas de turno' USING ERRCODE = '42501';
  END IF;
  IF p_band NOT IN ('am', 'pm') THEN RAISE EXCEPTION 'Franja inválida' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles pr JOIN public.driver_profiles dp ON dp.profile_id = pr.id
                  WHERE pr.id = p_from AND pr.organization_id = v_org) THEN
    RAISE EXCEPTION 'Ese conductor no es de tu organización' USING ERRCODE = '42501';
  END IF;
  IF p_auto THEN
    DELETE FROM public.shift_handovers h
     WHERE h.organization_id = v_org AND h.op_day = p_day AND h.band = p_band AND h.from_profile = p_from AND h.delivered_at IS NULL;
    UPDATE public.shift_handovers h SET manual = false, to_profile = NULL, to_text = NULL, set_by = auth.uid(), set_at = now()
     WHERE h.organization_id = v_org AND h.op_day = p_day AND h.band = p_band AND h.from_profile = p_from;
  ELSE
    IF p_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_to AND pr.organization_id = v_org
                                          AND pr.role IN ('driver', 'admin') AND pr.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'A quien recibe tiene que ser un conductor o un jefe de tu organización' USING ERRCODE = '22023';
    END IF;
    IF p_to IS NULL AND v_txt IS NULL THEN
      RAISE EXCEPTION 'Elige a quién le entrega o escribe dónde deja el carro' USING ERRCODE = '22023';
    END IF;
    IF p_to IS NOT NULL AND p_to = p_from THEN v_txt := NULL; END IF;
    INSERT INTO public.shift_handovers (organization_id, op_day, band, from_profile, to_profile, to_text, manual, set_by, set_at)
    VALUES (v_org, p_day, p_band, p_from, p_to, CASE WHEN p_to IS NULL THEN v_txt END, true, auth.uid(), now())
    ON CONFLICT (organization_id, op_day, band, from_profile) DO UPDATE
      SET to_profile = EXCLUDED.to_profile, to_text = EXCLUDED.to_text, manual = true, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;

  SELECT * INTO e FROM public.handover_effective(v_org, p_day) x WHERE x.band = p_band AND x.from_profile = p_from;
  -- Si ya le salió la tarjeta, se le avisa del cambio (una vez por cada destino).
  v_due := (SELECT w.fin FROM public.handover_window(p_day, p_band) w);
  IF e.from_profile IS NOT NULL AND NOT e.sigue AND e.delivered_at IS NULL
     AND now() BETWEEN v_due - make_interval(mins => v_lead) AND v_due + interval '1 hour'
     AND (e.to_profile IS NOT NULL OR e.to_text IS NOT NULL) THEN
    SELECT coalesce(public.short_name(pr.full_name), e.to_text) INTO v_name FROM (SELECT 1) one LEFT JOIN public.profiles pr ON pr.id = e.to_profile;
    PERFORM public.trip_notify(p_from, '🔑 Cambió tu entrega de turno',
      CASE WHEN e.to_profile IS NOT NULL THEN 'Entregas el carro a ' || coalesce(v_name, e.to_text) ELSE 'Deja el carro: ' || e.to_text END
        || ' a las ' || public.hm12_bog((extract(hour FROM v_due AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_due AT TIME ZONE 'America/Bogota'))::int) || '.',
      '/#/', 'entrega-cambio:' || v_org::text || ':' || p_day::text || ':' || p_band || ':' || p_from::text || ':' || coalesce(e.to_profile::text, md5(e.to_text)));
    PERFORM public.trip_kick();
  END IF;
  RETURN CASE WHEN e.from_profile IS NULL THEN NULL ELSE public.handover_json(e) END;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_handover(date, text, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_handover(date, text, uuid, uuid, text, boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Conductor
-- -----------------------------------------------------------------------------
-- Las entregas que le tocan AHORA (entrega o recibe): desde handover_lead_min antes
-- de la hora hasta 3 h después; la que entrega, hasta 1 h después de marcarla.
-- p_now es para las pruebas (la app no lo manda).
CREATE OR REPLACE FUNCTION public.driver_my_handovers(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_lead int := coalesce((SELECT handover_lead_min FROM public.app_settings WHERE id = 'singleton'), 120);
  v_day  date := public.handover_op_day(p_now);
BEGIN
  IF v_me IS NULL OR v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(public.handover_json(e) || jsonb_build_object(
             'role', CASE WHEN e.from_profile = v_me THEN 'entrega' ELSE 'recibe' END,
             'show_from', e.due_at - make_interval(mins => v_lead)) ORDER BY e.due_at)
      FROM unnest(ARRAY[v_day - 1, v_day]) d(dia)
      CROSS JOIN LATERAL public.handover_effective(v_org, d.dia) e
     WHERE NOT e.sigue
       AND (e.from_profile = v_me OR e.to_profile = v_me)
       AND p_now >= e.due_at - make_interval(mins => v_lead)
       AND p_now <= e.due_at + interval '3 hours'
       AND (e.from_profile <> v_me OR e.delivered_at IS NULL OR e.delivered_at > p_now - interval '1 hour')
       AND (e.to_profile IS DISTINCT FROM v_me OR e.from_profile = v_me
            OR public.handover_received_at(v_me, e.due_at) IS NULL
            OR public.handover_received_at(v_me, e.due_at) > p_now - interval '1 hour')), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.driver_my_handovers(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_my_handovers(timestamptz) TO authenticated;

-- «Entregado» (o «Deshacer»). Solo el que entrega, y solo una entrega que le toca
-- (desde 8 h antes de la hora). p_now es para las pruebas: la marca nunca queda antes de la hora real.
CREATE OR REPLACE FUNCTION public.driver_handover_delivered(p_day date, p_band text, p_undo boolean DEFAULT false,
                                                            p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me  uuid := auth.uid();
  v_org uuid := public.current_user_org();
  e     public.handover_row;
  v_at  timestamptz := CASE WHEN p_undo THEN NULL ELSE greatest(now(), p_now) END;   -- nunca hacia atrás
BEGIN
  IF v_me IS NULL OR v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.profile_id = v_me) THEN
    RAISE EXCEPTION 'Solo el conductor marca su entrega' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.handover_effective(v_org, p_day) x WHERE x.band = p_band AND x.from_profile = v_me;
  IF e.from_profile IS NULL OR e.sigue THEN
    RAISE EXCEPTION 'No tienes entrega de carro en ese turno' USING ERRCODE = 'P0002';
  END IF;
  IF p_now < e.due_at - interval '8 hours' THEN
    RAISE EXCEPTION 'Todavía no es hora de entregar el carro' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.shift_handovers (organization_id, op_day, band, from_profile, delivered_at)
  VALUES (v_org, p_day, p_band, v_me, v_at)
  ON CONFLICT (organization_id, op_day, band, from_profile) DO UPDATE SET delivered_at = v_at;
  -- Al que recibe se le cuenta (si tiene la app): una vez por entrega.
  IF NOT p_undo AND e.to_profile IS NOT NULL THEN
    PERFORM public.trip_notify(e.to_profile, '🔑 ' || public.short_name((SELECT full_name FROM public.profiles WHERE id = v_me)) || ' te entregó el carro',
      'Marcó la entrega a las ' || public.hm_bog(now()) || coalesce(' · ' || e.plate, '') || '. Revísalo al iniciar tu turno.',
      '/#/', 'entrega-ok:' || v_org::text || ':' || p_day::text || ':' || p_band || ':' || v_me::text);
    PERFORM public.trip_kick();
  END IF;
  SELECT * INTO e FROM public.handover_effective(v_org, p_day) x WHERE x.band = p_band AND x.from_profile = v_me;
  RETURN public.handover_json(e);
END;
$$;
REVOKE ALL ON FUNCTION public.driver_handover_delivered(date, text, boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_handover_delivered(date, text, boolean, timestamptz) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Los avisos (cada 5 min). p_now es para las pruebas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handover_alerts(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead int := coalesce((SELECT handover_lead_min FROM public.app_settings WHERE id = 'singleton'), 120);
  v_late int := coalesce((SELECT handover_late_min FROM public.app_settings WHERE id = 'singleton'), 15);
  v_day  date := public.handover_op_day(p_now);
  v_n    int := 0;
  v_hm   text;
  v_to   text;
  v_from text;
  g      record;
  e      record;
  j      record;
BEGIN
  FOR g IN SELECT o.id FROM public.organizations o LOOP
    FOR e IN SELECT x.* FROM unnest(ARRAY[v_day - 1, v_day]) d(dia)
             CROSS JOIN LATERAL public.handover_effective(g.id, d.dia) x LOOP
      CONTINUE WHEN e.sigue OR e.delivered_at IS NOT NULL;
      v_hm := public.hm12_bog((extract(hour FROM e.due_at AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM e.due_at AT TIME ZONE 'America/Bogota'))::int);
      SELECT public.short_name(full_name) INTO v_to FROM public.profiles WHERE id = e.to_profile;
      v_to := coalesce(v_to, e.to_text);
      -- Al que entrega, cuando se abre la ventana (y ya se sabe a quién).
      IF v_to IS NOT NULL AND p_now >= e.due_at - make_interval(mins => v_lead) AND p_now < e.due_at THEN
        IF public.trip_notify(e.from_profile,
             CASE WHEN e.to_profile IS NOT NULL THEN '🔑 Hoy entregas el carro a ' || v_to ELSE '🔑 Hoy dejas el carro: ' || v_to END,
             'A las ' || v_hm || coalesce(' · ' || e.car_label, '') || '. Cuando se lo entregues, toca «Entregado» en Inicio.',
             '/#/', 'entrega:' || g.id::text || ':' || e.op_day::text || ':' || e.band || ':' || e.from_profile::text) THEN
          v_n := v_n + 1;
        END IF;
      END IF;
      -- A los jefes, si pasó la hora + v_late y nadie marcó.
      IF p_now >= e.due_at + make_interval(mins => v_late) AND p_now <= e.due_at + interval '3 hours' THEN
        SELECT public.short_name(full_name) INTO v_from FROM public.profiles WHERE id = e.from_profile;
        FOR j IN SELECT * FROM public.ops_alert_recipients_of(g.id) LOOP
          IF public.trip_notify(j.profile_id, '⚠️ ' || coalesce(v_from, 'Un conductor') || ' no ha marcado la entrega del carro',
               'La entrega de las ' || v_hm || coalesce(' (' || e.car_label || ')', '') || ' a ' || coalesce(v_to, 'quien sigue') || ' sigue sin «Entregado».',
               '/#/operacion', 'entrega-tarde:' || g.id::text || ':' || e.op_day::text || ':' || e.band || ':' || e.from_profile::text || ':' || j.profile_id::text) THEN
            v_n := v_n + 1;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.handover_alerts(timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.handover_alerts(timestamptz) IS
  '0140: al abrir la ventana (handover_lead_min antes) avisa al que entrega a quién y a qué hora; handover_late_min después de la hora sin «Entregado», a los jefes. Una vez cada uno.';

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'handover-alerts';
  PERFORM cron.schedule('handover-alerts', '*/5 * * * *', $job$SELECT public.handover_alerts();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): handover_alerts queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
