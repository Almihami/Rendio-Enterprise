-- =============================================================================
-- 0153 · Los cambios de los tripulantes y el pedido desde la ruta pegada
-- (28-oct-2026, lista de Camilo de la madrugada y las 7:45 a. m.)
-- =============================================================================
--
-- 1. «Necesito una opción que me muestre los cambios que hacen los TC, porque no
--    me estoy dando cuenta de los cambios en la programación.» Hasta hoy un
--    cambio de vuelo con el día SIN publicar (auxiliar_change_flight, modo
--    'updated') cambiaba la reserva y no quedaba en ninguna parte: la hora vieja
--    se perdía. Ahora cada pedido nuevo, cancelación y cambio de hora, vuelo,
--    lugar, punto o nivel queda en reservation_changes (trigger en reservations,
--    con quién lo hizo). Nunca tumba el cambio: si el registro falla, solo avisa.
--
-- 2. admin_cambios_tripulantes(desde, hasta): lo que cambió en los pedidos de
--    esa ventana (la del día de Asignación), con lo de antes de esta migración
--    que se puede reconstruir: pedidos (created_at + audit_events), cancelaciones
--    (cancelled_at / cancelled_by) y cambios de vuelo con el día publicado (el
--    rastro de 0134/0135 en incidents).
--
-- 3. «Vamos por buen camino, pero el que se debe pegar es de la base de datos de
--    tripulantes, para que se asocie a la cuenta de cada uno y le refleje la
--    info.» Al pegar la ruta, quien tiene cuenta pero no pidió ese día se le crea
--    el pedido a su nombre (admin_create_reservation de 0139). Con el día ya
--    publicado, el trigger de 0135 lo «acomodaría» solo en otra vuelta (o una
--    para tomar, con aviso a los conductores) mientras el jefe lo está metiendo
--    en la suya. p_acomodar = false lo apaga para ESE pedido (rendio.no_acomodar,
--    el mismo interruptor que usan los scripts).
--
-- Idempotente. Down: down_migrations/0153_cambios_tripulantes_y_pedido_desde_ruta.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El registro
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservation_changes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id   uuid        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  organization_id  uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_profile_id uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role       text,                          -- 'auxiliar' | 'admin' | 'driver' | NULL (el sistema, un script)
  by_owner         boolean     NOT NULL DEFAULT false,   -- lo hizo el mismo tripulante
  kind             text        NOT NULL,
  before           jsonb,
  after            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_changes_kind_chk CHECK (kind IN ('nuevo', 'cancelado', 'hora', 'vuelo', 'lugar', 'punto', 'nivel'))
);
COMMENT ON TABLE public.reservation_changes IS
  '0153: cada pedido nuevo, cancelación y cambio de hora/vuelo/lugar/punto/nivel de una reserva, con quién lo hizo. Lo lee Asignación › Cambios.';
CREATE INDEX IF NOT EXISTS idx_reservation_changes_org_at ON public.reservation_changes (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservation_changes_res ON public.reservation_changes (reservation_id, created_at);

DROP TRIGGER IF EXISTS tr_reservation_changes_set_updated_at ON public.reservation_changes;
CREATE TRIGGER tr_reservation_changes_set_updated_at BEFORE UPDATE ON public.reservation_changes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reservation_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_reservation_changes_select_admin ON public.reservation_changes;
CREATE POLICY p_reservation_changes_select_admin ON public.reservation_changes
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());
-- INSERT solo desde el trigger (SECURITY DEFINER). UPDATE/DELETE: nunca desde la app.

-- El vuelo de una reserva vive en sus notas («Vuelo AV9563. …», createReservation).
CREATE OR REPLACE FUNCTION public.vuelo_de_notas(p_notes text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT nullif(upper(substring(coalesce(p_notes, '') FROM '(?i)vuelo\s+([A-Za-z0-9]{2,8})')), '');
$$;

CREATE OR REPLACE FUNCTION public.tg_reservations_cambios()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_owner  uuid;
  v_org    uuid;
  v_kind   text;
  v_antes  jsonb := '{}'::jsonb;
  v_ahora  jsonb := '{}'::jsonb;
  v_vo     text;
  v_vn     text;
BEGIN
  BEGIN
    SELECT ap.profile_id, pr.organization_id INTO v_owner, v_org
      FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE ap.id = NEW.auxiliar_profile_id;
    v_role := CASE WHEN v_actor IS NULL THEN NULL ELSE public.current_user_role() END;

    IF TG_OP = 'INSERT' THEN
      v_kind := 'nuevo';
      v_ahora := jsonb_strip_nulls(jsonb_build_object('when', NEW.required_arrival_at, 'vuelo', public.vuelo_de_notas(NEW.notes),
        'lugar', NEW.reserve_place, 'nivel', NEW.service_level::text));
    ELSIF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN
      v_kind := 'cancelado';
      v_antes := jsonb_strip_nulls(jsonb_build_object('when', OLD.required_arrival_at, 'vuelo', public.vuelo_de_notas(OLD.notes)));
      v_ahora := jsonb_strip_nulls(jsonb_build_object('motivo', nullif(btrim(coalesce(NEW.cancellation_reason, '')), '')));
    ELSIF NEW.cancelled_at IS NULL THEN
      v_vo := public.vuelo_de_notas(OLD.notes); v_vn := public.vuelo_de_notas(NEW.notes);
      IF v_vo IS DISTINCT FROM v_vn THEN
        v_kind := 'vuelo'; v_antes := v_antes || jsonb_build_object('vuelo', v_vo); v_ahora := v_ahora || jsonb_build_object('vuelo', v_vn);
      END IF;
      IF OLD.required_arrival_at IS DISTINCT FROM NEW.required_arrival_at THEN
        v_kind := coalesce(v_kind, 'hora');
        v_antes := v_antes || jsonb_build_object('when', OLD.required_arrival_at); v_ahora := v_ahora || jsonb_build_object('when', NEW.required_arrival_at);
      END IF;
      IF OLD.reserve_place IS DISTINCT FROM NEW.reserve_place THEN
        v_kind := coalesce(v_kind, 'lugar');
        v_antes := v_antes || jsonb_build_object('lugar', OLD.reserve_place); v_ahora := v_ahora || jsonb_build_object('lugar', NEW.reserve_place);
      END IF;
      IF OLD.residence_id IS DISTINCT FROM NEW.residence_id OR OLD.residence_unit IS DISTINCT FROM NEW.residence_unit
         OR OLD.pickup_address IS DISTINCT FROM NEW.pickup_address THEN
        v_kind := coalesce(v_kind, 'punto');
        v_antes := v_antes || jsonb_build_object('punto', (SELECT rr.name FROM public.residences rr WHERE rr.id = OLD.residence_id),
          'unidad', OLD.residence_unit, 'direccion', CASE WHEN OLD.residence_id IS NULL THEN OLD.pickup_address END);
        v_ahora := v_ahora || jsonb_build_object('punto', (SELECT rr.name FROM public.residences rr WHERE rr.id = NEW.residence_id),
          'unidad', NEW.residence_unit, 'direccion', CASE WHEN NEW.residence_id IS NULL THEN NEW.pickup_address END);
      END IF;
      IF OLD.service_level IS DISTINCT FROM NEW.service_level THEN
        v_kind := coalesce(v_kind, 'nivel');
        v_antes := v_antes || jsonb_build_object('nivel', OLD.service_level::text); v_ahora := v_ahora || jsonb_build_object('nivel', NEW.service_level::text);
      END IF;
      -- Contexto para leerlo sin abrir la reserva: la hora y el vuelo de ahora.
      IF v_kind IS NOT NULL THEN
        v_ahora := jsonb_build_object('when', NEW.required_arrival_at) || v_ahora;
        IF v_kind <> 'vuelo' AND v_vn IS NOT NULL THEN v_ahora := v_ahora || jsonb_build_object('vuelo', v_vn); END IF;
      END IF;
    END IF;

    IF v_kind IS NOT NULL THEN
      -- clock_timestamp: dos cambios en la misma transacción quedan en su orden.
      INSERT INTO public.reservation_changes (reservation_id, organization_id, actor_profile_id, actor_role, by_owner, kind, before, after, created_at, updated_at)
      VALUES (NEW.id, v_org, v_actor, v_role, v_actor IS NOT NULL AND v_actor = v_owner, v_kind,
              nullif(jsonb_strip_nulls(v_antes), '{}'::jsonb), nullif(jsonb_strip_nulls(v_ahora), '{}'::jsonb), clock_timestamp(), clock_timestamp());
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'registro de cambios (%): %', NEW.id, SQLERRM;   -- el cambio de la reserva sigue
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_reservations_cambios() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_reservations_cambios_ins ON public.reservations;
CREATE TRIGGER tr_reservations_cambios_ins AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservations_cambios();
DROP TRIGGER IF EXISTS tr_reservations_cambios_upd ON public.reservations;
CREATE TRIGGER tr_reservations_cambios_upd AFTER UPDATE ON public.reservations
  FOR EACH ROW WHEN (
       OLD.cancelled_at        IS DISTINCT FROM NEW.cancelled_at
    OR OLD.required_arrival_at IS DISTINCT FROM NEW.required_arrival_at
    OR OLD.notes               IS DISTINCT FROM NEW.notes
    OR OLD.reserve_place       IS DISTINCT FROM NEW.reserve_place
    OR OLD.residence_id        IS DISTINCT FROM NEW.residence_id
    OR OLD.residence_unit      IS DISTINCT FROM NEW.residence_unit
    OR OLD.pickup_address      IS DISTINCT FROM NEW.pickup_address
    OR OLD.service_level       IS DISTINCT FROM NEW.service_level)
  EXECUTE FUNCTION public.tg_reservations_cambios();

-- -----------------------------------------------------------------------------
-- 2. Lo que cambió en los pedidos de una ventana (el día de Asignación)
-- -----------------------------------------------------------------------------
-- Una fila por cambio, lo más nuevo primero (tope 400):
--   { id, at, rid, kind, before, after, by_owner, actor_role, name, aux_id, dir ('sal'|'lle'),
--     when (la hora de ahora), cancelled, tarde, vuelta: { at, conductor, delegada, para_tomar } | null }
-- Una reserva entra si su hora de ahora, o la de antes del cambio, cae en la ventana.
-- tarde = el cambio es posterior al corte de ese día (las 7:30 p. m. del día anterior,
-- app_settings.crew_request_cutoff_min): lo de antes ya venía en el Excel de Julián.
CREATE OR REPLACE FUNCTION public.admin_cambios_tripulantes(p_desde timestamptz, p_hasta timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_out   jsonb;
  v_corte int;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe ve los cambios de los tripulantes' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce((to_jsonb(s) ->> 'crew_request_cutoff_min')::int, 1170) INTO v_corte FROM public.app_settings s WHERE s.id = 'singleton';
  v_corte := coalesce(v_corte, 1170);
  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta <= p_desde OR p_hasta - p_desde > interval '3 days' THEN
    RAISE EXCEPTION 'Ventana inválida (máximo 3 días)' USING ERRCODE = '22023';
  END IF;

  WITH res AS (   -- los pedidos de la organización que tocan la ventana
    SELECT r.id, r.direction, r.required_arrival_at, r.cancelled_at, r.cancelled_by, r.created_at, r.notes,
           ap.id AS aux_id, ap.profile_id AS owner, pr.full_name AS name
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org
       AND (r.required_arrival_at BETWEEN p_desde AND p_hasta
            OR EXISTS (SELECT 1 FROM public.reservation_changes c WHERE c.reservation_id = r.id
                         AND (c.before->>'when')::timestamptz BETWEEN p_desde AND p_hasta))
  ), todo AS (
    -- a) el registro (desde 0153)
    SELECT c.id::text AS id, c.created_at AS at, c.reservation_id AS rid, c.kind, c.before, c.after, c.by_owner, c.actor_role
      FROM public.reservation_changes c JOIN res ON res.id = c.reservation_id
    UNION ALL
    -- b) antes de 0153: el pedido (quién lo hizo, por la bitácora de 0005)
    SELECT 'n:' || res.id, res.created_at, res.id, 'nuevo', NULL,
           jsonb_strip_nulls(jsonb_build_object('when', res.required_arrival_at, 'vuelo', public.vuelo_de_notas(res.notes))),
           EXISTS (SELECT 1 FROM public.audit_events a WHERE a.entity_id = res.id AND a.event_type = 'reservation_created' AND a.actor_profile_id = res.owner),
           NULL
      FROM res
     WHERE NOT EXISTS (SELECT 1 FROM public.reservation_changes c WHERE c.reservation_id = res.id AND c.kind = 'nuevo')
    UNION ALL
    -- c) antes de 0153: la cancelación
    SELECT 'c:' || res.id, res.cancelled_at, res.id, 'cancelado',
           jsonb_strip_nulls(jsonb_build_object('when', res.required_arrival_at, 'vuelo', public.vuelo_de_notas(res.notes))), NULL,
           res.cancelled_by IS NOT DISTINCT FROM res.owner AND res.cancelled_by IS NOT NULL, NULL
      FROM res
     WHERE res.cancelled_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.reservation_changes c WHERE c.reservation_id = res.id AND c.kind = 'cancelado')
    UNION ALL
    -- d) antes de 0153: el cambio de vuelo con el día publicado (rastro de 0134/0135)
    SELECT 'i:' || i.id, i.occurred_at, res.id,
           CASE WHEN (i.details->>'old_flight') IS DISTINCT FROM (i.details->>'new_flight') THEN 'vuelo' ELSE 'hora' END,
           jsonb_strip_nulls(jsonb_build_object('when', i.details->'old_when', 'vuelo', i.details->'old_flight', 'lugar', i.details->'old_reserve_place')),
           jsonb_strip_nulls(jsonb_build_object('when', i.details->'new_when', 'vuelo', i.details->'new_flight', 'lugar', i.details->'new_reserve_place')),
           i.reporter_id IS NOT DISTINCT FROM res.owner, NULL
      FROM public.incidents i JOIN res ON res.id = i.reservation_id
     WHERE i.details->>'kind' = 'aux_change_flight'
       AND NOT EXISTS (SELECT 1 FROM public.reservation_changes c WHERE c.reservation_id = res.id
                         AND c.kind IN ('hora', 'vuelo', 'lugar') AND abs(extract(epoch FROM c.created_at - i.occurred_at)) < 120)
  )
  SELECT coalesce(jsonb_agg(x ORDER BY x.at DESC), '[]'::jsonb) INTO v_out
    FROM (
      SELECT t.id, t.at, t.rid, t.kind, t.before, t.after, t.by_owner, t.actor_role,
             res.name, res.aux_id, CASE WHEN res.direction = 'airport_to_home' THEN 'lle' ELSE 'sal' END AS dir,
             res.required_arrival_at AS "when", res.cancelled_at IS NOT NULL AS cancelled,
             t.at > ((date_trunc('day', res.required_arrival_at AT TIME ZONE 'America/Bogota') - interval '1 day'
                      + make_interval(mins => v_corte)) AT TIME ZONE 'America/Bogota') AS tarde,
             (SELECT jsonb_build_object('at', CASE WHEN ra.direction = 'airport_to_home' THEN ra.planned_start_at ELSE coalesce(rs.estimated_arrival_at, ra.planned_start_at) END,
                                        'conductor', pd.full_name, 'delegada', ra.delegated_at IS NOT NULL,
                                        'para_tomar', coalesce(ra.pool, false) AND ra.driver_profile_id IS NULL)
                FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
                LEFT JOIN public.profiles pd ON pd.id = dp.profile_id
               WHERE rs.reservation_id = res.id AND ra.status IN ('draft', 'planned', 'in_progress')
               ORDER BY ra.planned_start_at LIMIT 1) AS vuelta
        FROM todo t JOIN res ON res.id = t.rid
       WHERE t.at IS NOT NULL
       ORDER BY t.at DESC
       LIMIT 400
    ) x;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_cambios_tripulantes(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cambios_tripulantes(timestamptz, timestamptz) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. admin_create_reservation (copia de 0139) + p_acomodar
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_create_reservation(uuid, text, timestamptz, text, text);
CREATE OR REPLACE FUNCTION public.admin_create_reservation(
  p_aux      uuid,
  p_type     text,          -- 'sal' (casa → JMC) | 'lle' (JMC → casa)
  p_when     timestamptz,   -- salida: presentación en JMC · llegada: aterrizaje
  p_flight   text DEFAULT NULL,
  p_note     text DEFAULT NULL,
  p_acomodar boolean DEFAULT true   -- 0153: false = el jefe lo mete él (ruta pegada); el sistema no lo acomoda
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    uuid := public.current_user_org();
  v_auxorg uuid;
  v_res    uuid;
  v_unit   text;
  v_lat    double precision;
  v_lng    double precision;
  v_addr   text;
  v_dir    public.trip_direction;
  v_code   text := upper(regexp_replace(coalesce(p_flight, ''), '[\s-]', '', 'g'));
  v_notes  text;
  v_id     uuid;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo un jefe puede pedir a nombre de otro' USING ERRCODE = '42501';
  END IF;
  SELECT pr.organization_id, ap.residence_id, ap.residence_unit, ap.home_latitude, ap.home_longitude, ap.home_address
    INTO v_auxorg, v_res, v_unit, v_lat, v_lng, v_addr
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux AND pr.deleted_at IS NULL;
  IF v_auxorg IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Ese tripulante no es de tu organización' USING ERRCODE = '42501';
  END IF;
  IF p_type NOT IN ('sal', 'lle') THEN
    RAISE EXCEPTION 'Elige si es salida o llegada' USING ERRCODE = '22023';
  END IF;
  IF p_when IS NULL OR p_when < now() - interval '2 hours' OR p_when > now() + interval '30 days' THEN
    RAISE EXCEPTION 'La hora tiene que ser de hoy en adelante (hasta 30 días)' USING ERRCODE = '22023';
  END IF;
  IF v_code <> '' AND v_code !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'El vuelo no parece válido (ej. AV9563)' USING ERRCODE = '22023';
  END IF;
  v_dir := CASE WHEN p_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
  IF EXISTS (SELECT 1 FROM public.reservations r
              WHERE r.auxiliar_profile_id = p_aux AND r.direction = v_dir AND r.cancelled_at IS NULL
                AND r.required_arrival_at BETWEEN p_when - interval '3 hours' AND p_when + interval '3 hours') THEN
    RAISE EXCEPTION 'Ya tiene una % a esa hora (menos de 3 h): revísala en Reservas', CASE WHEN p_type = 'lle' THEN 'llegada' ELSE 'salida' END
      USING ERRCODE = '23505';
  END IF;
  -- 0153: el jefe lo mete en su vuelta del tablero (ruta pegada): el trigger de 0135
  -- no lo acomoda por su lado. Solo en esta transacción.
  IF p_acomodar IS FALSE THEN PERFORM set_config('rendio.no_acomodar', 'on', true); END IF;
  -- Las notas como las escribe la app (createReservation): «Vuelo AV9563. …».
  v_notes := concat_ws(' ', CASE WHEN v_code <> '' THEN 'Vuelo ' || v_code || '.' END,
                        nullif(regexp_replace(btrim(coalesce(p_note, '')), '\s+', ' ', 'g'), ''),
                        '(Pedido por Coordinación.)');
  INSERT INTO public.reservations (auxiliar_profile_id, flight_id, direction, status_h2a, status_a2h,
                                   pickup_address, pickup_latitude, pickup_longitude, residence_id, residence_unit,
                                   required_arrival_at, notes, is_overnight, is_firm)
  VALUES (p_aux, NULL, v_dir,
          CASE WHEN p_type = 'sal' THEN 'requested'::public.reservation_status_h2a END,
          CASE WHEN p_type = 'lle' THEN 'scheduled'::public.reservation_status_a2h END,
          CASE WHEN v_res IS NULL THEN v_addr END, CASE WHEN v_res IS NULL THEN v_lat END, CASE WHEN v_res IS NULL THEN v_lng END,
          v_res, v_unit, p_when, v_notes, false, true)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  VALUES (auth.uid(), 'reservation_by_admin', 'reservation', v_id,
          jsonb_build_object('auxiliar_profile_id', p_aux, 'type', p_type, 'when', p_when, 'flight', nullif(v_code, ''),
                             'acomodar', coalesce(p_acomodar, true)));
  IF p_acomodar IS FALSE THEN PERFORM set_config('rendio.no_acomodar', '', true); END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_reservation(uuid, text, timestamptz, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_reservation(uuid, text, timestamptz, text, text, boolean) TO authenticated;

COMMIT;
