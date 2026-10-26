-- =============================================================================
-- Migration 0125 — La ruta de Julián: se pega, se avisa y los conductores la toman
-- Estrategia del jefe (Camilo, 25-oct-2026, 11:04 p. m.) con las respuestas de la
-- dueña (1A, 2 sí, 3 sí, 4A):
--   1. Los tripulantes piden todo por la app.
--   2. Julián descarga el Excel del día (estructura del Formulario) y hace la ruta
--      a mano a las 8 p. m.
--   3. La pega en la app (el mismo mensaje del grupo): el sistema la lee y avisa a
--      cada tripulante su hora de recogida.
--   4. El sistema no asigna: los conductores ven las vueltas en una lista y toman
--      la vuelta completa (un bloque del WhatsApp = un carro). La pueden soltar
--      mientras no haya arrancado; si a una hora de la primera recogida nadie la
--      ha tomado, les llega un aviso a los jefes.
--
-- QUÉ HACE
--   1. route_assignments: pool (vuelta pegada, publicada SIN conductor),
--      organization_id, manual_day, deadline_at, manual_note.
--   2. crew_aliases: cómo escribe Julián a cada tripulante → su cuenta (lo que él
--      elige a mano se aprende).
--   3. admin_manual_route_publish(día, bloques, apodos): crea/conserva/quita las
--      vueltas del día (la misma vuelta con las mismas personas conserva a su
--      conductor) y avisa a cada tripulante su hora; a los conductores, que hay
--      vueltas para tomar. admin_manual_route_clear(día): volver al tablero.
--   4. driver_open_routes / driver_take_route / driver_release_route.
--   5. pool_unclaimed_alerts + pg_cron cada 5 min.
--   6. «Publicada» también es una vuelta pegada sin conductor en: la hora de
--      recogida (sync_calculated_pickup), mis viajes del tripulante (+
--      driver_pending), el cambio de vuelo y la reserva tardía.
-- Idempotente. Down: down_migrations/0125_ruta_de_julian.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La vuelta de Julián: disponible para tomar
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS pool boolean NOT NULL DEFAULT false;
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS manual_day date;
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS manual_note text;
COMMENT ON COLUMN public.route_assignments.pool IS
  '0125: vuelta de la ruta que pega el jefe (Julián). Publicada SIN conductor: los conductores la toman en su app.';
COMMENT ON COLUMN public.route_assignments.organization_id IS
  '0125: organización de una vuelta pegada (las del tablero no lo llevan: se deduce de sus paradas).';
COMMENT ON COLUMN public.route_assignments.manual_day IS
  '0125: el día del plan del jefe al que pertenece la vuelta pegada (volver a pegar reemplaza ESE día).';
COMMENT ON COLUMN public.route_assignments.deadline_at IS
  '0125: «Deben estar 3:40» del jefe (salidas).';
COMMENT ON COLUMN public.route_assignments.manual_note IS
  '0125: lo que el jefe escribe en el bloque además de las paradas («Van a hotel»).';
CREATE INDEX IF NOT EXISTS idx_route_assignments_pool_open
  ON public.route_assignments (organization_id, planned_start_at) WHERE pool AND driver_profile_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_assignments_manual_day
  ON public.route_assignments (organization_id, manual_day) WHERE pool;

-- -----------------------------------------------------------------------------
-- 2. Apodos: cómo escribe Julián a cada tripulante («Karol L», «cano»)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crew_aliases (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  alias_norm          text        NOT NULL,
  auxiliar_profile_id uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  created_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_aliases_org_alias_key UNIQUE (organization_id, alias_norm),
  CONSTRAINT crew_aliases_alias_not_blank CHECK (length(btrim(alias_norm)) > 0)
);
ALTER TABLE public.crew_aliases ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS tr_crew_aliases_set_updated_at ON public.crew_aliases;
CREATE TRIGGER tr_crew_aliases_set_updated_at BEFORE UPDATE ON public.crew_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Lo leen los jefes de la organización (el emparejamiento corre en su pantalla);
-- se escribe solo por admin_manual_route_publish.
DROP POLICY IF EXISTS p_crew_aliases_select_admin ON public.crew_aliases;
CREATE POLICY p_crew_aliases_select_admin ON public.crew_aliases FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
COMMENT ON TABLE public.crew_aliases IS
  '0125: cómo escribe el jefe a un tripulante en su ruta de WhatsApp (minúsculas, sin tildes) → su cuenta. Se aprende cuando el jefe elige a mano.';

-- -----------------------------------------------------------------------------
-- 3. Ayudas internas
-- -----------------------------------------------------------------------------
-- Las reservas de UNA vuelta quedan «asignadas» (o vuelven a «pedido») según
-- tenga conductor. Es la regla de reservation_mark_assigned (0101), que solo
-- corre al insertar o borrar paradas; tomar o soltar una vuelta no toca paradas.
CREATE OR REPLACE FUNCTION public.route_sync_assigned(p_ra uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.reservations r
     SET status_h2a = CASE WHEN r.direction = 'home_to_airport' AND coalesce(r.status_h2a::text, 'requested') = 'requested'
                           THEN 'assigned'::public.reservation_status_h2a ELSE r.status_h2a END,
         status_a2h = CASE WHEN r.direction = 'airport_to_home' AND coalesce(r.status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking')
                           THEN 'driver_assigned'::public.reservation_status_a2h ELSE r.status_a2h END,
         updated_at = now()
   WHERE r.cancelled_at IS NULL
     AND r.id IN (SELECT rs.reservation_id FROM public.route_stops rs WHERE rs.route_assignment_id = p_ra)
     AND EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                  WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress') AND ra.driver_profile_id IS NOT NULL)
     AND ((r.direction = 'home_to_airport' AND coalesce(r.status_h2a::text, 'requested') = 'requested')
       OR (r.direction = 'airport_to_home' AND coalesce(r.status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking')));
  UPDATE public.reservations r
     SET status_h2a = CASE WHEN r.status_h2a = 'assigned' THEN 'requested'::public.reservation_status_h2a ELSE r.status_h2a END,
         status_a2h = CASE WHEN r.status_a2h = 'driver_assigned' THEN 'scheduled'::public.reservation_status_a2h ELSE r.status_a2h END,
         updated_at = now()
   WHERE r.id IN (SELECT rs.reservation_id FROM public.route_stops rs WHERE rs.route_assignment_id = p_ra)
     AND (r.status_h2a = 'assigned' OR r.status_a2h = 'driver_assigned')
     AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                      WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress') AND ra.driver_profile_id IS NOT NULL);
END;
$$;

-- «3:10», en Bogotá.
CREATE OR REPLACE FUNCTION public.hm_bog(p timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE ltrim(to_char(p AT TIME ZONE 'America/Bogota', 'HH24:MI'), '0') END;
$$;

-- Primer nombre + primer apellido («Isabela Rivera»).
CREATE OR REPLACE FUNCTION public.short_name(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p IS NULL OR btrim(p) = '' THEN 'Tripulante'
              ELSE initcap(split_part(btrim(p), ' ', 1)) || coalesce(' ' || nullif(initcap(split_part(btrim(p), ' ', 2)), ''), '') END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Publicar la ruta que pega el jefe
--    p_blocks: [{ type: 'sal'|'lle', stops: [{ reservation_id, at }], deadline_at,
--                 note, flight }]   (las horas ya resueltas a fecha y hora por la pantalla)
--    p_aliases: [{ alias, auxiliar_profile_id }]  (lo que el jefe eligió a mano)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid := public.current_user_org();
  b          jsonb;
  st         jsonb;
  v_type     text;
  v_dir      public.trip_direction;
  v_ids      uuid[];
  v_sig      text;
  v_first    timestamptz;
  v_start    timestamptz;
  v_dead     timestamptz;
  v_flight   text;
  v_ra       uuid;
  v_old      record;
  v_kept     int := 0;
  v_created  int := 0;
  v_removed  int := 0;
  v_skipped  int := 0;
  v_notified int := 0;
  v_drivers  int := 0;
  v_keep     uuid[] := ARRAY[]::uuid[];
  v_busy     uuid[];
  v_used     uuid[] := ARRAY[]::uuid[];
  v_tocadas  uuid[];
  v_tablero  int := 0;
  i          int;
  v_res      record;
  v_at       timestamptz;
  v_title    text;
  v_body     text;
  v_total    int := 0;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica la ruta' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'Falta la ruta' USING ERRCODE = '22023';
  END IF;

  -- Reservas que ya van en una vuelta ARRANCADA de este día: no se vuelven a poner.
  SELECT coalesce(array_agg(DISTINCT rs.reservation_id), ARRAY[]::uuid[]) INTO v_busy
    FROM public.route_assignments ra JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
     AND (ra.status IN ('in_progress', 'completed')
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  FOR b IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
    v_type := CASE WHEN b->>'type' = 'lle' THEN 'lle' ELSE 'sal' END;
    v_dir := CASE WHEN v_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
    -- Solo reservas vivas de la organización y que no estén en una vuelta arrancada.
    SELECT array_agg(x.rid ORDER BY x.ord), min(x.at)
      INTO v_ids, v_first
      FROM (SELECT (s->>'reservation_id')::uuid AS rid, (s->>'at')::timestamptz AS at, o AS ord
              FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)) x
      JOIN public.reservations r ON r.id = x.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org AND r.cancelled_at IS NULL AND r.direction = v_dir
       AND NOT (x.rid = ANY (v_busy)) AND NOT (x.rid = ANY (v_used));
    v_skipped := v_skipped + coalesce(jsonb_array_length(b->'stops'), 0) - coalesce(cardinality(v_ids), 0);
    IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN CONTINUE; END IF;
    v_used := v_used || v_ids;
    v_total := v_total + 1;
    v_sig := v_dir::text || ':' || (SELECT string_agg(u::text, ',' ORDER BY u::text) FROM unnest(v_ids) u);
    v_dead := nullif(b->>'deadline_at', '')::timestamptz;
    v_flight := nullif(btrim(b->>'flight'), '');
    -- La llegada sale de JMC cuando el tripulante ya bajó: aterrizaje + desembarque (0058/0099).
    v_start := CASE WHEN v_type = 'lle'
                    THEN v_first + make_interval(mins => coalesce(public.flight_deplane_min(v_flight), 15))
                    ELSE v_first END;

    -- ¿Ya estaba esta misma vuelta (las mismas personas)? Se conserva, con su conductor.
    SELECT ra.id INTO v_ra
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND (ra.direction::text || ':' || (SELECT string_agg(rs.reservation_id::text, ',' ORDER BY rs.reservation_id::text)
                                           FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)) = v_sig
     LIMIT 1;
    IF v_ra IS NOT NULL THEN
      UPDATE public.route_assignments
         SET planned_start_at = v_start, deadline_at = v_dead, manual_note = nullif(btrim(b->>'note'), ''), updated_at = now()
       WHERE id = v_ra;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                            pool, organization_id, manual_day, deadline_at, manual_note)
      VALUES (NULL, NULL, v_dir, 'planned', v_start, true, v_org, p_day, v_dead, nullif(btrim(b->>'note'), ''))
      RETURNING id INTO v_ra;
      v_created := v_created + 1;
    END IF;
    v_keep := v_keep || v_ra;

    -- Las paradas, en el orden del jefe (se reescriben: orden y horas pueden cambiar).
    -- Primero se corren a números altos para no chocar con el UNIQUE del orden.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra;
    i := 0;
    FOR st IN SELECT s FROM jsonb_array_elements(b->'stops') AS t(s) LOOP
      CONTINUE WHEN NOT ((st->>'reservation_id')::uuid = ANY (v_ids));
      i := i + 1;
      v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
      IF EXISTS (SELECT 1 FROM public.route_stops WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid) THEN
        UPDATE public.route_stops SET stop_order = i, estimated_arrival_at = v_at
         WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid;
      ELSE
        INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES (v_ra, (st->>'reservation_id')::uuid, i, v_at);
      END IF;
    END LOOP;
    DELETE FROM public.route_stops WHERE route_assignment_id = v_ra AND stop_order > 1000;

    -- Avisarle a cada uno su hora (una vez por hora: volver a pegar sin cambios no repite).
    FOR v_res IN
      SELECT r.id, r.direction, ap.profile_id AS crew, rs.estimated_arrival_at AS at, f.flight_number
        FROM public.route_stops rs
        JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        LEFT JOIN public.flights f ON f.id = r.flight_id
       WHERE rs.route_assignment_id = v_ra
    LOOP
      IF v_res.direction = 'home_to_airport' THEN
        v_title := 'Tu recogida está lista 🚗';
        v_body := 'Te recogemos a las ' || public.hm_bog(v_res.at)
          || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END
          || '. Te avisamos quién te recoge.';
      ELSE
        v_title := 'Tu regreso está listo 🚗';
        v_body := 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || '). Te avisamos quién te recoge.';
      END IF;
      IF public.trip_notify(v_res.crew, v_title, v_body, '/#/viaje?r=' || v_res.id::text,
                            'manual:' || v_res.id::text || ':' || to_char(coalesce(v_res.at, v_start) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')) THEN
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
    v_ra := NULL;
  END LOOP;

  -- Lo que Julián puso manda: esas personas salen de las vueltas del TABLERO que
  -- no han arrancado (si no, quedarían en dos carros); la que queda vacía se va.
  WITH quitadas AS (
    DELETE FROM public.route_stops rs USING public.route_assignments ra
     WHERE rs.route_assignment_id = ra.id AND NOT ra.pool AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
  LOOP
    DELETE FROM public.route_assignments WHERE id = v_old.id;
    v_removed := v_removed + 1;
    IF v_old.drv_profile IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_profile, 'Cambió una vuelta que tomaste',
        'Julián cambió la vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '. Revisa las vueltas disponibles.',
        '/#/ruta', 'manualdrop:' || v_old.id::text);
    END IF;
  END LOOP;

  -- Lo que el jefe eligió a mano se aprende para la próxima vez.
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    JOIN public.auxiliar_profiles ap ON ap.id = (a->>'auxiliar_profile_id')::uuid
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();

  -- Los conductores: hay vueltas para tomar (una vez por ruta pegada).
  IF v_created > 0 THEN
    SELECT count(*) INTO v_drivers FROM (
      SELECT public.trip_notify(p.id, 'Hay vueltas para tomar',
               'Julián publicó la ruta del ' || to_char(p_day, 'DD/MM') || ': ' || v_total || ' vueltas. Toma las tuyas en Ruta.',
               '/#/ruta', 'manualpool:' || v_org::text || ':' || p_day::text || ':' || md5(array_to_string(v_keep, ',')) || ':' || p.id::text) AS ok
        FROM public.profiles p
       WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false) z
     WHERE z.ok;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('created', v_created, 'kept', v_kept, 'removed', v_removed, 'skipped', v_skipped,
                            'notified', v_notified, 'drivers', v_drivers, 'vueltas', v_total, 'from_board', v_tablero);
END;
$$;

-- Quitar la ruta pegada de un día (volver al tablero): lo que no ha arrancado.
CREATE OR REPLACE FUNCTION public.admin_manual_route_clear(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid := public.current_user_org(); n int;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe quita la ruta' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.route_assignments ra
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day AND ra.status IN ('draft', 'planned')
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. El conductor: ver, tomar y soltar
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_driver_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT dp.id FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id
   WHERE dp.profile_id = auth.uid() AND p.deleted_at IS NULL LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.driver_open_routes()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_dp uuid := public.my_driver_profile_id(); v_org uuid := public.current_user_org();
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(j ORDER BY ts) FROM (
      SELECT ra.planned_start_at AS ts, jsonb_build_object(
        'id', ra.id, 'direction', ra.direction, 'planned_start_at', ra.planned_start_at,
        'deadline_at', ra.deadline_at, 'note', ra.manual_note, 'day', ra.manual_day,
        'stops', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'order', rs.stop_order, 'at', rs.estimated_arrival_at,
                    'name', public.short_name(pr.full_name),
                    'place', coalesce(res.name, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''), 'Sin dirección'),
                    'sector', res.sector, 'flight', f.flight_number) ORDER BY rs.stop_order), '[]'::jsonb)
                  FROM public.route_stops rs
                  JOIN public.reservations r ON r.id = rs.reservation_id
                  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                  JOIN public.profiles pr ON pr.id = ap.profile_id
                  LEFT JOIN public.residences res ON res.id = r.residence_id
                  LEFT JOIN public.flights f ON f.id = r.flight_id
                 WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL)) AS j
        FROM public.route_assignments ra
       WHERE ra.pool AND ra.organization_id = v_org AND ra.driver_profile_id IS NULL AND ra.status = 'planned'
         AND ra.planned_start_at >= now() - interval '1 hour'
         AND ra.planned_start_at <  now() + interval '40 hours'
    ) z), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_take_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_pl  text;
  c     record;
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = v_dp, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id IS NULL AND status = 'planned'
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND driver_profile_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta ya la tomó otro conductor' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Esta vuelta ya no está disponible' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_me, 'Tu conductor') || ' te recoge 🚗',
      CASE WHEN ra.direction = 'home_to_airport'
           THEN 'Te recoge a las ' || public.hm_bog(c.at) || coalesce(' en el carro ' || v_pl, '') || '.'
           ELSE 'Te espera en JMC cuando aterrices' || coalesce(' (carro ' || v_pl || ')', '') || '.' END,
      '/#/viaje?r=' || c.id::text, 'take:' || ra.id::text || ':' || v_dp::text || ':' || c.id::text);
  END LOOP;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'vehicle_id', ra.vehicle_id, 'plate', v_pl);
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_release_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_n   int;
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor suelta vueltas' USING ERRCODE = '42501'; END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = NULL, vehicle_id = NULL, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id = v_dp AND status = 'planned'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = p_route AND x.status <> 'pending')
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    RAISE EXCEPTION 'No puedes soltar esta vuelta: ya arrancó o no es tuya' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT count(*) INTO v_n FROM public.route_stops WHERE route_assignment_id = ra.id;
  -- Los jefes, y los demás conductores: hay una vuelta libre otra vez.
  PERFORM public.trip_notify(j.profile_id, 'Soltaron una vuelta',
    coalesce(public.short_name(v_me), 'Un conductor') || ' soltó la vuelta de las ' || public.hm_bog(ra.planned_start_at)
      || ' (' || v_n || CASE WHEN v_n = 1 THEN ' persona' ELSE ' personas' END || '). Quedó disponible.',
    '/#/rutas', 'release:' || ra.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS') || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  PERFORM public.trip_notify(p.id, 'Hay una vuelta libre',
    'Se liberó la vuelta de las ' || public.hm_bog(ra.planned_start_at) || '. Tómala en Ruta si puedes.',
    '/#/ruta', 'releasedrv:' || ra.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISS') || ':' || p.id::text)
    FROM public.profiles p
   WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false
     AND p.id <> auth.uid();
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Nadie la tomó: aviso a los jefes una hora antes de la primera recogida
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pool_unclaimed_alerts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v int := 0; r record;
BEGIN
  FOR r IN
    SELECT ra.id, ra.organization_id, ra.direction,
           coalesce((SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id), ra.planned_start_at) AS t0,
           (SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order)
              FROM public.route_stops rs JOIN public.reservations res ON res.id = rs.reservation_id
              JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id) AS quienes
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.driver_profile_id IS NULL AND ra.status = 'planned' AND ra.organization_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)
  LOOP
    CONTINUE WHEN r.t0 IS NULL OR r.t0 < now() OR r.t0 > now() + interval '60 minutes';
    v := v + (SELECT count(*) FROM (
      SELECT public.trip_notify(j.profile_id, 'Nadie ha tomado una vuelta ⚠️',
               CASE WHEN r.direction = 'home_to_airport' THEN 'Recogida ' ELSE 'Llegada ' END || public.hm_bog(r.t0) || ' · ' || coalesce(r.quienes, '')
                 || '. Faltan ' || greatest(1, round(extract(epoch FROM (r.t0 - now())) / 60)::int) || ' min.',
               '/#/rutas', 'unclaimed:' || r.id::text || ':' || j.profile_id::text) AS ok
        FROM public.ops_alert_recipients_of(r.organization_id) j) z WHERE z.ok);
  END LOOP;
  IF v > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v;
END;
$$;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pool-unclaimed-alerts';
  PERFORM cron.schedule('pool-unclaimed-alerts', '*/5 * * * *', $job$SELECT public.pool_unclaimed_alerts();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): pool_unclaimed_alerts queda creada pero nadie la llama.', SQLERRM;
END
$do$;

-- -----------------------------------------------------------------------------
-- 7. «Publicada» = con conductor O vuelta pegada (copias de 0085, 0121, 0121 y
--    0068; solo cambia esa condición y, en mis viajes, driver_pending)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_calculated_pickup(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v timestamptz;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN;
  END IF;

  -- Si la reserva quedó en más de una ruta (una en curso que se conservó y otra
  -- nueva), manda la más reciente.
  SELECT CASE WHEN ra.direction = 'airport_to_home'
              THEN ra.planned_start_at
              ELSE rs.estimated_arrival_at END
    INTO v
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status <> 'cancelled'
    AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: la vuelta pegada se publica sin conductor
  ORDER BY ra.planned_start_at DESC NULLS LAST, ra.created_at DESC
  LIMIT 1;

  UPDATE public.reservations
     SET calculated_pickup_at = v
   WHERE id = p_reservation_id
     AND calculated_pickup_at IS DISTINCT FROM v;
END;
$$;

CREATE OR REPLACE FUNCTION public.auxiliar_my_trips(p_days_back int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_days int  := least(greatest(coalesce(p_days_back, 60), 1), 400);
BEGIN
  IF v_aux IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.ts, x.id)
    FROM (
      SELECT r.required_arrival_at AS ts, r.id,
        jsonb_build_object(
          'id',                    r.id,
          'direction',             r.direction,
          'required_arrival_at',   r.required_arrival_at,
          'date',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
          'time',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'HH24:MI'),
          'raw_status',            k.raw,
          'cancelled_at',          r.cancelled_at,
          'cancellation_reason',   r.cancellation_reason,
          'notes',                 r.notes,
          'notes_user',            public.notes_without_flight(r.notes),
          'flight_number',         f.flight_number,
          'pickup_address',        r.pickup_address,
          'pickup_latitude',       r.pickup_latitude,
          'pickup_longitude',      r.pickup_longitude,
          'residence_id',          r.residence_id,
          'residence_unit',        r.residence_unit,
          'meeting_point',         r.meeting_point,
          'is_overnight',          r.is_overnight,
          'is_firm',               r.is_firm,
          'ready_confirmed_at',    r.ready_confirmed_at,
          'service_level',         r.service_level,
          'private_status',        r.private_status,
          'price_cop',             r.price_cop,
          'private_reject_reason', r.private_reject_reason,
          'rating',                r.rating,
          'bags',                  r.bags,
          'quiet_ride',            r.quiet_ride,
          'created_at',            r.created_at,
          'ground_ops',            r.ground_ops,
          'reserve_place',         r.reserve_place,          -- 0121: de reserva en Río Verde / Movich / Aero
          'published',             k.pub,
          'pickup_at',             CASE WHEN k.pub THEN r.calculated_pickup_at END,
          'meet_code',             CASE WHEN k.pub THEN r.meet_code END,
          'pickup_pos',            CASE WHEN k.pub THEN po.pos END,
          'pickup_total',          CASE WHEN k.pub THEN po.total END,
          'stop_status',           s.stop_status,
          'arrived_at',            s.arr,
          'picked_at',             s.pick,
          'dropped_at',            s.dropped,
          -- 0125: publicada y sin conductor (la vuelta pegada que nadie ha tomado).
          'driver_pending',        (k.pub AND s.drv IS NULL),
          'driver', CASE WHEN s.ra_id IS NULL OR s.drv IS NULL THEN NULL ELSE jsonb_build_object(
              'name',       pr.full_name,
              'avatar_url', pr.avatar_url,
              'phone',      CASE WHEN NOT k.closed AND s.ra_status <> 'completed' THEN pr.phone END,
              'rating',     CASE WHEN rt.n >= 10 THEN round(rt.avg, 1) END,
              'rating_n',   coalesce(rt.n, 0)) END,
          'vehicle', CASE WHEN s.ra_id IS NULL OR v.id IS NULL THEN NULL ELSE jsonb_build_object(
              'plate', coalesce(v.license_plate, v.internal_code),
              'brand', v.brand, 'model', v.model, 'color', v.color) END
        ) AS j
      FROM public.reservations r
      LEFT JOIN public.flights f ON f.id = r.flight_id
      LEFT JOIN LATERAL (
        SELECT ra.id AS ra_id, ra.status AS ra_status, ra.driver_profile_id AS drv, ra.vehicle_id AS veh,
               ra.direction AS ra_dir, ra.planned_start_at AS ra_start,   -- 0093: para juntar la vuelta del carro
               rs.status AS stop_status, rs.actual_arrival_at AS arr,
               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        WHERE rs.reservation_id = r.id
          AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: la vuelta pegada, sin conductor todavía
          AND ra.status IN ('planned', 'in_progress', 'completed')
        ORDER BY ra.planned_start_at DESC NULLS LAST
        LIMIT 1
      ) s ON true
      CROSS JOIN LATERAL (
        SELECT COALESCE(r.status_h2a::text, r.status_a2h::text) AS raw,
               (s.ra_status IN ('planned', 'in_progress')) IS TRUE AS pub,
               (r.cancelled_at IS NOT NULL
                 OR COALESCE(r.status_h2a::text, r.status_a2h::text) IN ('delivered', 'no_show', 'cancelled')) AS closed
      ) k
      -- El tramo de MI ruta en el tiempo: de su arranque a la última hora
      -- estimada de sus paradas (greatest ignora los NULL: sin horas estimadas
      -- el tramo es solo el arranque). Solo con la ruta publicada.
      LEFT JOIN LATERAL (
        SELECT greatest(s.ra_start, max(ms.estimated_arrival_at)) AS w1
        FROM public.route_stops ms
        WHERE k.pub AND ms.route_assignment_id = s.ra_id
      ) sw ON true
      -- Mi lugar en el carro: solo con la ruta publicada, sobre la VUELTA DEL
      -- CARRO: mi route_assignment («s») y las otras publicadas del mismo
      -- vehículo y dirección cuyo tramo se cruza con el mío (la que quedó en
      -- curso + la que saveRoutePlan le creó al lado al republicar). Misma
      -- dirección, sin cancelados ni no-show; una reserva en dos rutas cuenta
      -- una vez. Si yo quedé fuera, no hay fila → NULL.
      LEFT JOIN LATERAL (
        SELECT o.pos, o.total
        FROM (
          SELECT cv.reservation_id,
                 -- Una sola ruta: stop_order. Varias: la hora estimada de cada
                 -- parada manda (el plan), luego el arranque y stop_order.
                 row_number() OVER (ORDER BY CASE WHEN cv.varias THEN cv.t_k END,
                                             cv.ra_start, cv.stop_order, cv.id)::int AS pos,
                 (count(*) OVER ())::int AS total
          FROM (
            SELECT cand.*, bool_or(cand.ra_id <> s.ra_id) OVER () AS varias
            FROM (
              SELECT DISTINCT ON (rs2.reservation_id)
                     rs2.reservation_id, rs2.id, rs2.stop_order,
                     ra2.id AS ra_id, ra2.planned_start_at AS ra_start,
                     coalesce(rs2.estimated_arrival_at, ra2.planned_start_at) AS t_k
              FROM public.route_assignments ra2
              JOIN public.route_stops rs2 ON rs2.route_assignment_id = ra2.id
              JOIN public.reservations r2 ON r2.id = rs2.reservation_id
              WHERE k.pub
                AND (ra2.id = s.ra_id
                     OR (ra2.vehicle_id = s.veh
                         AND ra2.direction = s.ra_dir
                         AND (ra2.driver_profile_id IS NOT NULL OR ra2.pool)
                         AND ra2.status IN ('planned', 'in_progress', 'completed')
                         AND ra2.planned_start_at <= sw.w1
                         AND s.ra_start <= (
                               SELECT greatest(ra2.planned_start_at, max(os.estimated_arrival_at))
                               FROM public.route_stops os
                               WHERE os.route_assignment_id = ra2.id)))
                AND r2.direction = r.direction
                AND r2.cancelled_at IS NULL
                AND rs2.status <> 'no_show'
                AND COALESCE(r2.status_h2a::text, r2.status_a2h::text, '') NOT IN ('cancelled', 'no_show')
              -- Si una reserva quedara en dos rutas: la mía primero, si no la más reciente.
              ORDER BY rs2.reservation_id, (ra2.id = s.ra_id) DESC, ra2.planned_start_at DESC NULLS LAST
            ) cand
          ) cv
        ) o
        WHERE o.reservation_id = r.id
      ) po ON true
      LEFT JOIN public.driver_profiles dp ON dp.id = s.drv
      LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
      LEFT JOIN public.vehicles v         ON v.id = s.veh
      LEFT JOIN LATERAL public.driver_rating_summary(s.drv) rt ON s.drv IS NOT NULL
      WHERE r.auxiliar_profile_id = v_aux
        AND (r.required_arrival_at >= now() - make_interval(days => v_days) OR NOT k.closed)
    ) x
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.auxiliar_change_flight(
  p_reservation_id uuid,
  p_flight text,
  p_when timestamptz,
  p_reserve_place text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux        uuid := public.current_auxiliar_id();
  r            public.reservations%ROWTYPE;
  v_raw        text;
  v_old_flight text;
  v_flight     text;
  v_place      text;
  v_lead       int;
  v_pub        boolean;
  v_priv       boolean;
  v_ops        boolean;
  v_regreso    boolean;
  v_user       text;
  v_notes      text;
  v_inc        uuid;
  v_n          int;
  v_desc       text;
BEGIN
  IF auth.uid() IS NULL OR v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo el tripulante dueño del traslado puede cambiar su vuelo' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.reservations
   WHERE id = p_reservation_id AND auxiliar_profile_id = v_aux
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ese traslado no es tuyo' USING ERRCODE = '42501';
  END IF;
  IF r.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ese traslado está cancelado' USING ERRCODE = '22023';
  END IF;

  v_raw := COALESCE(r.status_h2a::text, r.status_a2h::text);
  IF v_raw IN ('en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show', 'cancelled') THEN
    RAISE EXCEPTION 'Tu traslado ya está en curso: escríbele a Coordinación' USING ERRCODE = '22023';
  END IF;

  IF p_when IS NULL THEN
    RAISE EXCEPTION 'Falta la hora nueva' USING ERRCODE = '22023';
  END IF;
  IF p_when <= now() THEN
    RAISE EXCEPTION 'Esa hora ya pasó' USING ERRCODE = '22023';
  END IF;
  IF p_when > now() + interval '14 days' THEN
    RAISE EXCEPTION 'Solo puedes cambiarlo hasta 14 días adelante' USING ERRCODE = '22023';
  END IF;

  -- 0121: el lugar de la reserva. NULL = como estaba; 'vuelo' o '' = ahora va
  -- en un vuelo; o uno de los tres lugares.
  v_place := CASE
    WHEN p_reserve_place IS NULL THEN r.reserve_place
    WHEN btrim(p_reserve_place) IN ('', 'vuelo') THEN NULL
    ELSE btrim(p_reserve_place) END;
  IF v_place IS NOT NULL AND v_place NOT IN ('rio_verde', 'movich', 'aero') THEN
    RAISE EXCEPTION 'Ese lugar de reserva no existe' USING ERRCODE = '22023';
  END IF;
  IF v_place IS NOT NULL AND coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Un traslado de trabajo en tierra no va de reserva' USING ERRCODE = '22023';
  END IF;

  -- El vuelo: sin espacios ni guion, en mayúscula. Mismo formato que escribe
  -- el pedido («Vuelo AV9412. »), y que notes_without_flight sabe quitar.
  -- De reserva no hay vuelo: lo que venga se ignora.
  v_flight := CASE WHEN v_place IS NOT NULL THEN NULL
    ELSE nullif(upper(regexp_replace(coalesce(p_flight, ''), '[[:space:]-]', '', 'g')), '') END;
  IF v_flight IS NOT NULL AND v_flight !~ '^[A-Z]{0,3}[0-9]{2,5}$' THEN
    RAISE EXCEPTION 'Ese número de vuelo no se entiende (ej.: AV9412)' USING ERRCODE = '22023';
  END IF;
  -- 0093: la llegada de tierra (ground_ops) no tiene vuelo; 0121: la de reserva tampoco.
  IF v_flight IS NULL AND v_place IS NULL AND r.direction = 'airport_to_home' AND NOT coalesce(r.ground_ops, false) THEN
    RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas' USING ERRCODE = '22023';
  END IF;

  SELECT f.flight_number INTO v_old_flight FROM public.flights f WHERE f.id = r.flight_id;
  IF v_old_flight IS NULL THEN
    v_old_flight := nullif(upper(regexp_replace(
      coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z]{0,3}\s*-?\s*[0-9]{2,5})'), ''),
      '[[:space:]-]', '', 'g')), '');
  END IF;

  IF p_when = r.required_arrival_at
     AND v_place IS NOT DISTINCT FROM r.reserve_place
     AND (v_flight IS NULL OR v_flight IS NOT DISTINCT FROM v_old_flight) THEN
    RETURN jsonb_build_object('mode', 'updated', 'unchanged', true,
                              'required_arrival_at', r.required_arrival_at,
                              'reserve_place', r.reserve_place);
  END IF;

  SELECT aux_min_lead_hours INTO v_lead FROM public.app_settings WHERE id = 'singleton';
  v_lead := coalesce(v_lead, 6);

  v_pub := EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = r.id
      AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125
      AND ra.status IN ('planned', 'in_progress'));
  v_priv := r.service_level = 'private' AND r.private_status IN ('requested', 'approved');
  -- Cambiar de lugar (vuelo↔reserva, u otro hotel) mueve el carro igual que
  -- cambiar la hora: con la ruta publicada o dentro del plazo, decide Coordinación.
  v_ops := (p_when <> r.required_arrival_at OR v_place IS DISTINCT FROM r.reserve_place) AND (
             v_pub OR v_priv
             OR p_when < now() + make_interval(hours => v_lead)
             OR r.required_arrival_at < now() + make_interval(hours => v_lead));

  IF NOT v_ops THEN
    v_regreso := coalesce(r.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
    v_user := public.notes_without_flight(r.notes);
    IF v_place IS NOT NULL THEN
      v_notes := v_user;   -- de reserva: el vuelo viejo sale de las notas
    ELSIF v_flight IS NULL THEN
      v_notes := r.notes;  -- sin vuelo nuevo (salida o tierra): las notas quedan como estaban
    ELSE
      v_notes := btrim('Vuelo ' || v_flight || '. ' || v_user
                       || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END);
    END IF;

    UPDATE public.reservations
       SET required_arrival_at = p_when,
           reserve_place = v_place,
           notes = nullif(v_notes, ''),
           flight_id = CASE WHEN v_place IS NOT NULL THEN NULL
                            WHEN v_flight IS NOT NULL AND v_flight IS DISTINCT FROM v_old_flight
                            THEN NULL ELSE flight_id END
     WHERE id = r.id;

    RETURN jsonb_build_object('mode', 'updated', 'required_arrival_at', p_when,
                              'flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
                              'reserve_place', v_place);
  END IF;

  v_desc := format('Cambió su %s (%s): %s → %s%s',
    CASE WHEN v_place IS NOT NULL OR r.reserve_place IS NOT NULL THEN 'traslado' ELSE 'vuelo' END,
    CASE WHEN r.direction = 'airport_to_home' THEN 'llegada' ELSE 'salida' END,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    to_char(p_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI'),
    CASE
      WHEN v_place IS NOT NULL THEN ' · de reserva en ' || CASE v_place
        WHEN 'rio_verde' THEN 'Hotel Río Verde' WHEN 'movich' THEN 'Hotel Movich' ELSE 'el aeropuerto' END
      ELSE coalesce(' · vuelo ' || coalesce(v_flight, v_old_flight), '')
    END
    || CASE WHEN r.reserve_place IS NOT NULL AND v_place IS NULL THEN ' (antes de reserva)' ELSE '' END);

  v_inc := public.report_incident(
    (CASE WHEN p_when > r.required_arrival_at THEN 'flight_delay'
          WHEN p_when < r.required_arrival_at THEN 'flight_advanced'
          ELSE 'other' END)::public.incident_category,
    v_desc,
    'medium'::public.incident_severity,
    r.id,
    jsonb_build_object(
      'kind', 'aux_change_flight',
      'old_when', r.required_arrival_at, 'new_when', p_when,
      'old_flight', v_old_flight, 'new_flight', CASE WHEN v_place IS NULL THEN coalesce(v_flight, v_old_flight) END,
      'old_reserve_place', r.reserve_place, 'new_reserve_place', v_place,
      'direction', r.direction, 'published', v_pub, 'private', v_priv)
  );
  v_n := public.enqueue_incident_alert(v_inc);

  RETURN jsonb_build_object('mode', 'needs_ops', 'incident_id', v_inc, 'notified', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.detect_late_bookings()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nuevas integer := 0;
  r        record;
  v_id     uuid;
BEGIN
  -- (a) ABRE: reserva viva, de un día que YA tiene plan publicado, sin parada.
  --
  -- «Día con plan publicado» = existe al menos una route_assignment de ese día
  -- con conductor asignado (status planned o in_progress). Un borrador no
  -- cuenta: mientras el jefe está armando el día, que falte gente es lo normal
  -- y avisar ahí sería ruido puro.
  FOR r IN
    SELECT res.id, res.required_arrival_at, res.pickup_address, res.direction,
           pr.full_name AS pax, pr.organization_id,
           EXTRACT(EPOCH FROM (res.required_arrival_at - now())) / 3600 AS horas
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    WHERE res.cancelled_at IS NULL
      AND res.required_arrival_at > now()
      -- todavía hay tiempo de hacer algo; después ya es historia, no alerta
      AND res.required_arrival_at < now() + interval '36 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
      AND EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.status IN ('planned', 'in_progress')
          AND (ra.driver_profile_id IS NOT NULL OR ra.pool)   -- 0125: también con la ruta pegada
          AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date
              = (res.required_arrival_at AT TIME ZONE 'America/Bogota')::date)
      AND NOT EXISTS (
        SELECT 1 FROM public.incidents i
        WHERE i.dedupe_key = 'late:' || res.id::text AND i.resolved_at IS NULL)
  LOOP
    INSERT INTO public.incidents (
      organization_id, reporter_id, reservation_id,
      category, severity, status, description, scope, source, details,
      dedupe_key, occurred_at)
    VALUES (
      r.organization_id, NULL, r.id,
      'late_booking',
      -- Grave solo cuando ya no hay noche de por medio para resolverlo.
      -- El cast es obligatorio: un CASE devuelve text y la columna es un enum.
      (CASE WHEN r.horas < 6 THEN 'high' ELSE 'medium' END)::public.incident_severity,
      'open',
      COALESCE(split_part(r.pax, ' ', 1), 'Un tripulante') ||
        ' no tiene carro: el plan del día ya está publicado y su traslado quedó por fuera' ||
        CASE WHEN r.horas < 6
             THEN ' (faltan ' || round(r.horas::numeric, 1) || ' h).'
             ELSE '.' END,
      'operacion', 'system',
      jsonb_build_object(
        'horas_para_el_servicio', round(r.horas::numeric, 1),
        'direccion', r.pickup_address,
        'sentido', r.direction),
      'late:' || r.id::text, now())
    RETURNING id INTO v_id;

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

  -- (b) CIERRA sola: ya la acomodaron, la cancelaron, o el servicio ya pasó.
  UPDATE public.incidents i
     SET status = 'resolved',
         resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes,
           CASE
             WHEN res.cancelled_at IS NOT NULL THEN 'Se cerró sola: la reserva fue cancelada.'
             WHEN EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
               THEN 'Se cerró sola: la reserva ya quedó en una ruta.'
             ELSE 'Se cerró sola: la hora del servicio ya pasó.'
           END)
    FROM public.reservations res
   WHERE res.id = i.reservation_id
     AND i.category = 'late_booking'
     AND i.resolved_at IS NULL
     AND (
       res.cancelled_at IS NOT NULL
       OR res.required_arrival_at <= now()
       OR EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
     );

  RETURN v_nuevas;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Permisos
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.route_sync_assigned(uuid)', 'public.pool_unclaimed_alerts()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.admin_manual_route_publish(date, jsonb, jsonb)', 'public.admin_manual_route_clear(date)',
    'public.driver_open_routes()', 'public.driver_take_route(uuid)', 'public.driver_release_route(uuid)',
    'public.my_driver_profile_id()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

COMMIT;
