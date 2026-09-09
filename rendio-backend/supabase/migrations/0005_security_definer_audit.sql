-- =============================================================================
-- Migration 0005 — audit_events + funciones SECURITY DEFINER + triggers
-- Tarea contractual: E1.08
-- Spec: Arquitectura §5.4 (audit_events), §7.3 (funciones SECURITY DEFINER).
--
-- Contiene:
--   - Tabla public.audit_events (bitácora inmutable)
--   - Función log_audit_event() para inserts internos (SECURITY DEFINER)
--   - Funciones SECURITY DEFINER de transición de estado:
--       * mark_passenger_on_board(p_route_stop_id)
--       * mark_passenger_arrived(p_route_stop_id)             [helper para at_pickup]
--       * mark_route_started(p_route_assignment_id)
--       * mark_passenger_delivered(p_route_stop_id)
--       * cancel_reservation(p_reservation_id, p_reason)
--       * confirm_disembarkation(p_reservation_id, p_gate)
--       * recompute_route(p_route_assignment_id)              [esqueleto; ORS en E3]
--   - Triggers de audit en INSERT/UPDATE de tablas críticas
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. TABLA audit_events
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_events (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_profile_id  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  event_type        text        NOT NULL,
  entity_type       text        NOT NULL,
  entity_id         uuid        NOT NULL,
  payload           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON public.audit_events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_type
  ON public.audit_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON public.audit_events (actor_profile_id, created_at DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

-- SELECT solo admin
DROP POLICY IF EXISTS p_audit_events_select_admin ON public.audit_events;
CREATE POLICY p_audit_events_select_admin
  ON public.audit_events
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- INSERT solo via SECURITY DEFINER functions / service_role. Sin policy = bloqueado para clientes.
-- UPDATE/DELETE: nunca (auditoría inmutable). Sin policies.

COMMENT ON TABLE public.audit_events IS 'Bitácora inmutable de eventos críticos. Solo admin lee; INSERT vía funciones.';

-- =============================================================================
-- 2. HELPER log_audit_event()
-- =============================================================================

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_event_type  text,
  p_entity_type text,
  p_entity_id   uuid,
  p_payload     jsonb DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id bigint;
BEGIN
  INSERT INTO public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  VALUES (auth.uid(), p_event_type, p_entity_type, p_entity_id, p_payload)
  RETURNING id INTO v_event_id;
  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_audit_event(text, text, uuid, jsonb) FROM PUBLIC;
-- No GRANT a authenticated: solo otras funciones SECURITY DEFINER pueden invocarla,
-- y service_role siempre puede. Esto previene que un cliente loguee eventos arbitrarios.

-- =============================================================================
-- 3. FUNCIONES SECURITY DEFINER de transición
-- =============================================================================

-- ----- mark_route_started -----
-- Cambia route_assignments.status de 'planned' a 'in_progress' y setea
-- actual_start_at. Solo el conductor dueño puede dispararlo.

CREATE OR REPLACE FUNCTION public.mark_route_started(p_route_assignment_id uuid)
RETURNS public.route_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_route public.route_assignments;
  v_caller_driver_id uuid;
BEGIN
  v_caller_driver_id := public.current_driver_id();
  IF v_caller_driver_id IS NULL THEN
    RAISE EXCEPTION 'Solo conductores pueden iniciar rutas' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_route
  FROM public.route_assignments
  WHERE id = p_route_assignment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ruta no encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_route.driver_profile_id <> v_caller_driver_id THEN
    RAISE EXCEPTION 'Esta ruta no le pertenece' USING ERRCODE = '42501';
  END IF;

  IF v_route.status <> 'planned' THEN
    RAISE EXCEPTION 'La ruta debe estar en estado "planned" (actual: %)', v_route.status
      USING ERRCODE = '22000';
  END IF;

  UPDATE public.route_assignments
  SET status = 'in_progress',
      actual_start_at = now()
  WHERE id = p_route_assignment_id
  RETURNING * INTO v_route;

  PERFORM public.log_audit_event(
    'route_started', 'route_assignments', p_route_assignment_id,
    jsonb_build_object('driver_profile_id', v_caller_driver_id)
  );

  RETURN v_route;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_route_started(uuid) TO authenticated;

-- ----- mark_passenger_arrived -----
-- Marca un route_stop como 'arrived' y la reservation correspondiente como
-- 'at_pickup' (h2a). Solo el conductor dueño puede.

CREATE OR REPLACE FUNCTION public.mark_passenger_arrived(p_route_stop_id uuid)
RETURNS public.route_stops
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stop  public.route_stops;
  v_route public.route_assignments;
  v_resv  public.reservations;
  v_caller_driver_id uuid;
BEGIN
  v_caller_driver_id := public.current_driver_id();
  IF v_caller_driver_id IS NULL THEN
    RAISE EXCEPTION 'Solo conductores' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_route_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stop no encontrado' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_route FROM public.route_assignments WHERE id = v_stop.route_assignment_id;
  IF v_route.driver_profile_id <> v_caller_driver_id THEN
    RAISE EXCEPTION 'No es su ruta' USING ERRCODE = '42501';
  END IF;

  IF v_stop.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'Stop debe estar pending (actual: %)', v_stop.status USING ERRCODE = '22000';
  END IF;

  UPDATE public.route_stops
  SET status = 'arrived', actual_arrival_at = now()
  WHERE id = p_route_stop_id
  RETURNING * INTO v_stop;

  -- Sincroniza reservation a 'at_pickup' (h2a) o equivalente
  SELECT * INTO v_resv FROM public.reservations WHERE id = v_stop.reservation_id;
  IF v_resv.direction = 'home_to_airport' THEN
    UPDATE public.reservations
    SET status_h2a = 'at_pickup'
    WHERE id = v_resv.id AND status_h2a IN ('en_route', 'ready', 'assigned');
  END IF;

  PERFORM public.log_audit_event(
    'passenger_arrived', 'route_stops', p_route_stop_id,
    jsonb_build_object('reservation_id', v_stop.reservation_id)
  );

  RETURN v_stop;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_passenger_arrived(uuid) TO authenticated;

-- ----- mark_passenger_on_board -----
-- Marca un route_stop como 'picked_up' y la reservation como 'on_board'.
-- Requiere que el stop esté en 'arrived'.

CREATE OR REPLACE FUNCTION public.mark_passenger_on_board(p_route_stop_id uuid)
RETURNS public.route_stops
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stop  public.route_stops;
  v_route public.route_assignments;
  v_resv  public.reservations;
  v_caller_driver_id uuid;
BEGIN
  v_caller_driver_id := public.current_driver_id();
  IF v_caller_driver_id IS NULL THEN
    RAISE EXCEPTION 'Solo conductores' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_route_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stop no encontrado' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_route FROM public.route_assignments WHERE id = v_stop.route_assignment_id;
  IF v_route.driver_profile_id <> v_caller_driver_id THEN
    RAISE EXCEPTION 'No es su ruta' USING ERRCODE = '42501';
  END IF;

  IF v_stop.status NOT IN ('arrived') THEN
    RAISE EXCEPTION 'Debe marcar llegada antes (estado actual: %)', v_stop.status
      USING ERRCODE = '22000';
  END IF;

  UPDATE public.route_stops
  SET status = 'picked_up', actual_pickup_at = now()
  WHERE id = p_route_stop_id
  RETURNING * INTO v_stop;

  SELECT * INTO v_resv FROM public.reservations WHERE id = v_stop.reservation_id;
  IF v_resv.direction = 'home_to_airport' THEN
    UPDATE public.reservations SET status_h2a = 'on_board' WHERE id = v_resv.id;
  ELSE
    UPDATE public.reservations SET status_a2h = 'picked_up' WHERE id = v_resv.id;
  END IF;

  PERFORM public.log_audit_event(
    'passenger_on_board', 'route_stops', p_route_stop_id,
    jsonb_build_object('reservation_id', v_stop.reservation_id)
  );

  RETURN v_stop;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_passenger_on_board(uuid) TO authenticated;

-- ----- mark_passenger_delivered -----
-- Marca la reservation como 'delivered' (ambas direcciones). El stop NO cambia
-- de status — se queda en picked_up. La métrica de ruta completada se evalúa
-- viendo si todos los stops de la ruta están en delivered/no_show.

CREATE OR REPLACE FUNCTION public.mark_passenger_delivered(p_route_stop_id uuid)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stop  public.route_stops;
  v_route public.route_assignments;
  v_resv  public.reservations;
  v_caller_driver_id uuid;
  v_remaining int;
BEGIN
  v_caller_driver_id := public.current_driver_id();
  IF v_caller_driver_id IS NULL THEN
    RAISE EXCEPTION 'Solo conductores' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_route_stop_id;
  SELECT * INTO v_route FROM public.route_assignments WHERE id = v_stop.route_assignment_id;
  IF v_route.driver_profile_id <> v_caller_driver_id THEN
    RAISE EXCEPTION 'No es su ruta' USING ERRCODE = '42501';
  END IF;

  IF v_stop.status NOT IN ('picked_up') THEN
    RAISE EXCEPTION 'El pasajero debe estar a bordo antes (actual: %)', v_stop.status
      USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_resv FROM public.reservations WHERE id = v_stop.reservation_id FOR UPDATE;

  IF v_resv.direction = 'home_to_airport' THEN
    UPDATE public.reservations SET status_h2a = 'delivered' WHERE id = v_resv.id RETURNING * INTO v_resv;
  ELSE
    UPDATE public.reservations SET status_a2h = 'delivered' WHERE id = v_resv.id RETURNING * INTO v_resv;
  END IF;

  -- Si ya no quedan stops pendientes, completar la ruta
  SELECT count(*) INTO v_remaining
  FROM public.route_stops rs
  JOIN public.reservations r ON r.id = rs.reservation_id
  WHERE rs.route_assignment_id = v_route.id
    AND COALESCE(r.status_h2a::text, r.status_a2h::text) NOT IN ('delivered', 'no_show', 'cancelled');

  IF v_remaining = 0 THEN
    UPDATE public.route_assignments
    SET status = 'completed', actual_end_at = now()
    WHERE id = v_route.id;
  END IF;

  PERFORM public.log_audit_event(
    'passenger_delivered', 'reservations', v_resv.id,
    jsonb_build_object('route_stop_id', p_route_stop_id, 'route_assignment_id', v_route.id)
  );

  RETURN v_resv;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_passenger_delivered(uuid) TO authenticated;

-- ----- cancel_reservation -----
-- Cancela una reservation. Auxiliar puede si faltan >2h; admin sin restricción.

CREATE OR REPLACE FUNCTION public.cancel_reservation(p_reservation_id uuid, p_reason text DEFAULT NULL)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_resv public.reservations;
  v_caller_role text;
BEGIN
  v_caller_role := public.current_user_role();

  SELECT * INTO v_resv FROM public.reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation no encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_caller_role = 'auxiliar' THEN
    IF v_resv.auxiliar_profile_id <> public.current_auxiliar_id() THEN
      RAISE EXCEPTION 'No es su reservation' USING ERRCODE = '42501';
    END IF;
    IF v_resv.calculated_pickup_at IS NOT NULL
       AND (v_resv.calculated_pickup_at - now()) <= interval '2 hours' THEN
      RAISE EXCEPTION 'No puede cancelar a menos de 2 horas del pickup' USING ERRCODE = '22000';
    END IF;
  ELSIF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  UPDATE public.reservations
  SET cancelled_at = now(),
      status_h2a = CASE WHEN direction = 'home_to_airport' THEN 'cancelled'::reservation_status_h2a ELSE NULL END,
      status_a2h = CASE WHEN direction = 'airport_to_home' THEN 'cancelled'::reservation_status_a2h ELSE NULL END
  WHERE id = p_reservation_id
  RETURNING * INTO v_resv;

  PERFORM public.log_audit_event(
    'reservation_cancelled', 'reservations', p_reservation_id,
    jsonb_build_object('reason', p_reason, 'cancelled_by_role', v_caller_role)
  );

  RETURN v_resv;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_reservation(uuid, text) TO authenticated;

-- ----- confirm_disembarkation -----
-- Auxiliar confirma desembarque (a2h). Solo si la reservation es suya y el
-- vuelo está en 'landed'.

CREATE OR REPLACE FUNCTION public.confirm_disembarkation(p_reservation_id uuid, p_gate text)
RETURNS public.reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_resv   public.reservations;
  v_flight public.flights;
BEGIN
  IF public.current_user_role() <> 'auxiliar' THEN
    RAISE EXCEPTION 'Solo auxiliares confirman desembarque' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_resv FROM public.reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_resv.auxiliar_profile_id <> public.current_auxiliar_id() THEN
    RAISE EXCEPTION 'No es su reservation' USING ERRCODE = '42501';
  END IF;
  IF v_resv.direction <> 'airport_to_home' THEN
    RAISE EXCEPTION 'Solo aplica a reservations airport_to_home' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_flight FROM public.flights WHERE id = v_resv.flight_id;
  IF v_flight.status NOT IN ('landed') THEN
    RAISE EXCEPTION 'El vuelo aún no aterriza (estado: %)', v_flight.status USING ERRCODE = '22000';
  END IF;

  UPDATE public.reservations
  SET status_a2h = 'disembarking',
      disembark_gate = p_gate
  WHERE id = p_reservation_id
  RETURNING * INTO v_resv;

  PERFORM public.log_audit_event(
    'disembarkation_confirmed', 'reservations', p_reservation_id,
    jsonb_build_object('gate', p_gate)
  );

  RETURN v_resv;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_disembarkation(uuid, text) TO authenticated;

-- ----- recompute_route -----
-- Esqueleto. La integración real con OpenRouteService vive en E3 (Edge Function).
-- Por ahora solo registra el evento; el recompute real lo hace el Edge Function.

CREATE OR REPLACE FUNCTION public.recompute_route(p_route_assignment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_role() NOT IN ('admin') THEN
    RAISE EXCEPTION 'Solo admin puede recomputar rutas' USING ERRCODE = '42501';
  END IF;

  PERFORM public.log_audit_event(
    'route_recompute_requested', 'route_assignments', p_route_assignment_id,
    jsonb_build_object('note', 'Edge Function compute_route ejecuta el cálculo real (E3)')
  );

  -- TODO E3: invocar Edge Function compute_route via supabase.functions.invoke
  -- y actualizar route_stops + encoded_polyline + total_distance/duration.

  RETURN p_route_assignment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_route(uuid) TO authenticated;

-- =============================================================================
-- 4. TRIGGERS de audit
-- =============================================================================

-- ----- trigger function: audit reservation_created -----

CREATE OR REPLACE FUNCTION public.tg_audit_reservation_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.log_audit_event(
    'reservation_created', 'reservations', NEW.id,
    jsonb_build_object(
      'auxiliar_profile_id', NEW.auxiliar_profile_id,
      'flight_id', NEW.flight_id,
      'direction', NEW.direction
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_audit_created ON public.reservations;
CREATE TRIGGER tr_reservations_audit_created
  AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_audit_reservation_created();

-- ----- trigger function: audit route_assigned -----

CREATE OR REPLACE FUNCTION public.tg_audit_route_assigned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.log_audit_event(
    'route_assigned', 'route_assignments', NEW.id,
    jsonb_build_object(
      'driver_profile_id', NEW.driver_profile_id,
      'vehicle_id',       NEW.vehicle_id,
      'flight_id',        NEW.flight_id,
      'direction',        NEW.direction
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_route_assignments_audit_created ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_audit_created
  AFTER INSERT ON public.route_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_audit_route_assigned();

-- Triggers de inspections, incidents y vehicle_blocked se agregan en migration
-- 0006 (E2.01) cuando esas tablas existan.

COMMIT;
