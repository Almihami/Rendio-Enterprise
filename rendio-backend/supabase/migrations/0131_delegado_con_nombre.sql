-- =============================================================================
-- 0131 · Delegar con nombre y teléfono, y la libreta de conductores de afuera
--        (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (lista del 26-oct, URGENTE): «al momento de quitar una
-- vuelta a un conductor, si se va a delegar se pueda seleccionar DELEGAR, y
-- automáticamente aparezca una opción de seleccionar el conductor inscrito o de
-- manera manual colocar nombre y teléfono, y que al tripulante le aparezca en la
-- app: Te recogerá tal conductor, su número de contacto es…».
-- La profa eligió (26-oct): una LIBRETA de conductores de afuera (nombre +
-- teléfono, se guarda para elegirlos la próxima vez) + escribir uno nuevo a mano.
-- A los conductores de Rendio ya se les da la vuelta con «Cambiar» (0129).
--
-- QUÉ HACE
--   1. delegate_contacts: la libreta, por organización (solo jefes). Un teléfono
--      es una persona: volver a delegarle actualiza el nombre y la fecha de uso.
--   2. route_assignments.delegate_name / delegate_phone: a quién se delegó. Un
--      disparador los borra cuando la vuelta deja de ser delegada (Devolver, 0126;
--      ponerle conductor, 0129), así ninguna función de antes tiene que cambiar.
--   3. admin_route_delegate(vuelta, nombre, teléfono): delega una vuelta ya
--      publicada A ALGUIEN (o le cambia a quién), la anota en la libreta y le
--      avisa a cada tripulante «Te recogerá Carlos 🤝 · Tu recogida de las 4:30 la
--      hace Carlos. Su número de contacto es 300 123 4567.» Si un conductor de
--      Rendio la tenía, «Ya no haces una vuelta».
--   4. auxiliar_my_trips: la copia de 0126 + «delegate» {name, phone}. Lo único
--      nuevo son las líneas marcadas «0131».
--   3b. admin_route_set_delegated: la copia de 0126 con la guarda de organización
--      arreglada (coalesce): con organization_id NULL dejaba pasar a un jefe de otra
--      organización. Mismo arreglo en admin_route_set_driver (0129) y aquí.
-- Sin nombre (la de antes, 0126) se sigue viendo «Te contactaremos por WhatsApp».
-- Idempotente. Necesita 0126. Down: down_migrations/0131_delegado_con_nombre.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La libreta
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delegate_contacts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  phone           text        NOT NULL,
  last_used_at    timestamptz,
  created_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT delegate_contacts_name_len CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  CONSTRAINT delegate_contacts_phone_digits CHECK (length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 7 AND 15)
);
COMMENT ON TABLE public.delegate_contacts IS
  '0131: la libreta de conductores de afuera (el carro del jefe, un Uber) a quienes se delegan vueltas. Un teléfono = una persona por organización.';
CREATE UNIQUE INDEX IF NOT EXISTS ux_delegate_contacts_phone
  ON public.delegate_contacts (organization_id, (regexp_replace(phone, '\D', '', 'g'))) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS tr_delegate_contacts_set_updated_at ON public.delegate_contacts;
CREATE TRIGGER tr_delegate_contacts_set_updated_at
  BEFORE UPDATE ON public.delegate_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.delegate_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_delegate_contacts_admin ON public.delegate_contacts;
CREATE POLICY p_delegate_contacts_admin
  ON public.delegate_contacts FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
REVOKE ALL ON public.delegate_contacts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delegate_contacts TO authenticated;
GRANT ALL ON public.delegate_contacts TO service_role;

-- -----------------------------------------------------------------------------
-- 2. A quién se delegó la vuelta
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS delegate_name  text;
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS delegate_phone text;
COMMENT ON COLUMN public.route_assignments.delegate_name IS
  '0131: quién hace la vuelta delegada (lo ve el tripulante: «Te recogerá …»). Vacío = delegada sin nombre (0126: «te contactaremos por WhatsApp»).';
COMMENT ON COLUMN public.route_assignments.delegate_phone IS '0131: su número de contacto.';

-- Deja de ser delegada (Devolver, o se le pone conductor) → se borra a quién.
CREATE OR REPLACE FUNCTION public.route_assignments_delegate_clear()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.delegated_at IS NULL THEN
    NEW.delegate_name := NULL;
    NEW.delegate_phone := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tr_route_assignments_delegate_clear ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_delegate_clear
  BEFORE INSERT OR UPDATE OF delegated_at, delegate_name, delegate_phone ON public.route_assignments
  FOR EACH ROW EXECUTE FUNCTION public.route_assignments_delegate_clear();

-- -----------------------------------------------------------------------------
-- 3. Delegar a alguien
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_route_delegate(p_route uuid, p_name text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    uuid := public.current_user_org();
  ra       public.route_assignments;
  v_name   text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_phone  text := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '\s+', ' ', 'g'), '');
  v_dig    text;
  v_prev   uuid;
  v_era    boolean;
  v_sello  text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n      int := 0;
  v_cid    uuid;
  c        record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe delega una vuelta' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'Escribe el nombre de quien hace la vuelta' USING ERRCODE = '22023';
  END IF;
  v_dig := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
  IF length(v_dig) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'Escribe un teléfono de contacto válido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  -- coalesce: una vuelta del tablero no trae organization_id (NULL) y «NULL = org»
  -- no es falso: sin él, un jefe de OTRA organización pasaba esta guarda.
  IF ra.id IS NULL OR NOT (coalesce(ra.organization_id = v_org, false) OR EXISTS (
       SELECT 1 FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
       JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
        WHERE rs.route_assignment_id = ra.id AND pr.organization_id = v_org)) THEN
    RAISE EXCEPTION 'Esa vuelta no existe' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status <> 'planned' OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: no se puede delegar' USING ERRCODE = 'P0001';
  END IF;
  v_era := ra.delegated_at IS NOT NULL;
  IF v_era AND ra.delegate_name IS NOT DISTINCT FROM v_name
     AND regexp_replace(coalesce(ra.delegate_phone, ''), '\D', '', 'g') = v_dig THEN
    RETURN jsonb_build_object('id', ra.id, 'delegated', true, 'unchanged', true);
  END IF;

  SELECT dp.profile_id INTO v_prev FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
  UPDATE public.route_assignments
     SET delegated_at = coalesce(delegated_at, now()), delegated_by = coalesce(delegated_by, auth.uid()),
         driver_profile_id = NULL, vehicle_id = NULL,
         delegate_name = v_name, delegate_phone = v_phone, updated_at = now()
   WHERE id = ra.id RETURNING * INTO ra;
  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  -- La libreta: un teléfono es una persona (se actualiza el nombre y el uso).
  UPDATE public.delegate_contacts SET name = v_name, phone = v_phone, last_used_at = now()
   WHERE organization_id = v_org AND deleted_at IS NULL AND regexp_replace(phone, '\D', '', 'g') = v_dig
  RETURNING id INTO v_cid;
  IF v_cid IS NULL THEN
    INSERT INTO public.delegate_contacts (organization_id, name, phone, last_used_at, created_by)
    VALUES (v_org, v_name, v_phone, now(), auth.uid()) RETURNING id INTO v_cid;
  END IF;

  FOR c IN
    SELECT r.id, r.direction, ap.profile_id AS crew, r.calculated_pickup_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    IF public.trip_notify(c.crew, 'Te recogerá ' || public.short_name(v_name) || ' 🤝',
         CASE WHEN c.direction = 'home_to_airport'
              THEN 'Tu recogida' || coalesce(' de las ' || public.hm_bog(c.at), '') || ' la hace ' || public.short_name(v_name) || '.'
              ELSE public.short_name(v_name) || ' te espera en JMC cuando aterrices.' END
         || ' Su número de contacto es ' || v_phone || '.',
         '/#/viaje?r=' || c.id::text, 'delegto:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_prev IS NOT NULL THEN
    PERFORM public.trip_notify(v_prev, 'Ya no haces una vuelta',
      'Coordinación delegó la vuelta de las ' || public.hm_bog(ra.planned_start_at) || ': la hace alguien de afuera.',
      '/#/ruta', 'delegdrv:' || ra.id::text || ':' || v_prev::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'delegated', true, 'name', v_name, 'phone', v_phone, 'contact_id', v_cid,
    'notified', v_n, 'driver_removed', v_prev IS NOT NULL, 'was_delegated', v_era);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_route_delegate(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_route_delegate(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.admin_route_delegate(uuid, text, text)
  IS '0131: delega UNA vuelta publicada a alguien de afuera (nombre + teléfono) o le cambia a quién; la anota en la libreta y avisa a cada tripulante «Te recogerá X · su número es Y». Solo vueltas que no han arrancado.';

-- -----------------------------------------------------------------------------
-- 3b. admin_route_set_delegated (0126) con la guarda de organización arreglada
--     (hallazgo 26-oct): una vuelta del tablero tiene organization_id NULL, y
--     «NULL = org» no es falso, así que un jefe de OTRA organización podía delegarla
--     o devolverla. Lo único que cambia es el coalesce de la guarda.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_route_set_delegated(p_route uuid, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  ra      public.route_assignments;
  v_prev  uuid;   -- perfil del conductor que la tenía (si alguno)
  v_n     int := 0;
  c       record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe delega una vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  -- De esta organización: la pegada lo dice; la del tablero, por sus paradas.
  -- 0131: coalesce (una vuelta del tablero no trae organization_id; ver arriba).
  IF ra.id IS NULL OR NOT (coalesce(ra.organization_id = v_org, false) OR EXISTS (
       SELECT 1 FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
       JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
        WHERE rs.route_assignment_id = ra.id AND pr.organization_id = v_org)) THEN
    RAISE EXCEPTION 'Esa vuelta no existe' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status <> 'planned' OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: no se puede delegar ni devolver' USING ERRCODE = 'P0001';
  END IF;
  IF p_on AND ra.delegated_at IS NOT NULL THEN RETURN jsonb_build_object('id', ra.id, 'delegated', true, 'unchanged', true); END IF;
  IF NOT p_on AND ra.delegated_at IS NULL THEN RETURN jsonb_build_object('id', ra.id, 'delegated', false, 'unchanged', true); END IF;

  SELECT dp.profile_id INTO v_prev FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
  IF p_on THEN
    UPDATE public.route_assignments
       SET delegated_at = now(), delegated_by = auth.uid(), driver_profile_id = NULL, vehicle_id = NULL, updated_at = now()
     WHERE id = ra.id RETURNING * INTO ra;
  ELSE
    UPDATE public.route_assignments
       SET delegated_at = NULL, delegated_by = NULL, updated_at = now()
     WHERE id = ra.id RETURNING * INTO ra;
  END IF;
  -- Sin conductor de Rendio: sus reservas vuelven a «pedido» si estaban asignadas,
  -- y la hora de recogida se queda (la delegada cuenta como publicada).
  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  FOR c IN
    SELECT r.id, r.direction, ap.profile_id AS crew, r.calculated_pickup_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    IF p_on THEN
      IF public.trip_notify(c.crew, 'Tu servicio fue delegado 🤝',
           CASE WHEN c.direction = 'home_to_airport'
                THEN 'Te contactaremos por WhatsApp para coordinar tu recogida' || coalesce(' de las ' || public.hm_bog(c.at), '') || '.'
                ELSE 'Te contactaremos por WhatsApp para coordinar tu regreso desde JMC.' END,
           '/#/viaje?r=' || c.id::text, 'deleg:' || ra.id::text || ':' || c.id::text || ':' || to_char(ra.delegated_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS')) THEN
        v_n := v_n + 1;
      END IF;
    ELSE
      IF public.trip_notify(c.crew, 'Tu traslado vuelve con Rendio 🚗',
           'Ya no es delegado. Te avisamos quién te recoge' || coalesce(' a las ' || public.hm_bog(c.at), '') || '.',
           '/#/viaje?r=' || c.id::text, 'undeleg:' || ra.id::text || ':' || c.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS')) THEN
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;
  -- El conductor que la había tomado ya no la hace.
  IF p_on AND v_prev IS NOT NULL THEN
    PERFORM public.trip_notify(v_prev, 'Ya no haces una vuelta',
      'Coordinación delegó la vuelta de las ' || public.hm_bog(ra.planned_start_at) || ': la hace alguien de afuera.',
      '/#/ruta', 'delegdrv:' || ra.id::text || ':' || v_prev::text);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'delegated', ra.delegated_at IS NOT NULL, 'notified', v_n, 'driver_removed', v_prev IS NOT NULL AND p_on);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Lo que ve el tripulante: la copia de 0126 + «delegate»
-- -----------------------------------------------------------------------------
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
          -- 0126: la delegada NO cuenta: nadie de Rendio la va a tomar.
          'driver_pending',        (k.pub AND s.drv IS NULL AND s.deleg IS NULL),
          -- 0126: la vuelta la hace alguien de afuera; lo contactan por WhatsApp.
          'delegated',             (k.pub AND s.deleg IS NOT NULL),
          -- 0131: a quién se delegó («Te recogerá X, su número es Y»). El teléfono, solo
          -- mientras el viaje no haya terminado (como el del conductor).
          'delegate',              CASE WHEN k.pub AND s.deleg IS NOT NULL AND s.dname IS NOT NULL
                                        THEN jsonb_build_object('name', s.dname, 'phone', CASE WHEN NOT k.closed THEN s.dphone END) END,
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
               ra.delegated_at AS deleg,                                  -- 0126: la hace alguien de afuera
               ra.delegate_name AS dname, ra.delegate_phone AS dphone,      -- 0131: quién la hace y su número
               rs.status AS stop_status, rs.actual_arrival_at AS arr,
               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        WHERE rs.reservation_id = r.id
          AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
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
                         AND (ra2.driver_profile_id IS NOT NULL OR ra2.pool OR ra2.delegated_at IS NOT NULL)
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

COMMIT;
