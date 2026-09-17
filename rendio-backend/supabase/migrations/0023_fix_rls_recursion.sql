-- =============================================================================
-- Migration 0023 — fix: recursión infinita en políticas RLS (0004)
--
-- Bug: varias policies de 0004 usan EXISTS inline contra tablas cuyas policies
-- a su vez referencian la tabla original. Postgres detecta el ciclo al expandir
-- los quals y responde 42P17 "infinite recursion detected in policy":
--   · driver_profiles  ↔ route_assignments
--   · reservations     ↔ route_stops
--   · auxiliar_profiles ↔ reservations (vía route_*)
-- Cualquier SELECT a driver_profiles, vehicles, reservations o route_stops
-- fallaba para cualquier rol (el planner expande TODAS las policies de la
-- tabla, sin importar el rol del caller).
--
-- Fix: mover los EXISTS cross-tabla a funciones SECURITY DEFINER (bypasean
-- RLS al evaluar, igual que los helpers current_*_id de 0004/0010) y recrear
-- las policies cíclicas usando esas funciones. La semántica es idéntica.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Helpers SECURITY DEFINER (rompen los ciclos)
-- -----------------------------------------------------------------------------

-- ¿El auxiliar actual tiene ruta activa con este conductor?
CREATE OR REPLACE FUNCTION public.aux_has_active_route_with_driver(p_driver_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.route_assignments ra
    JOIN public.route_stops rs   ON rs.route_assignment_id = ra.id
    JOIN public.reservations r   ON r.id = rs.reservation_id
    WHERE ra.driver_profile_id = p_driver_profile_id
      AND r.auxiliar_profile_id = public.current_auxiliar_id()
      AND ra.status IN ('planned', 'in_progress')
  );
$$;

-- ¿El conductor actual tiene ruta activa con este auxiliar?
CREATE OR REPLACE FUNCTION public.driver_has_active_route_with_aux(p_auxiliar_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reservations r
    JOIN public.route_stops rs       ON rs.reservation_id = r.id
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE r.auxiliar_profile_id = p_auxiliar_profile_id
      AND ra.driver_profile_id = public.current_driver_id()
      AND ra.status IN ('planned', 'in_progress')
  );
$$;

-- Organización de un driver_profile (para policy admin de route_assignments).
CREATE OR REPLACE FUNCTION public.driver_profile_org(p_driver_profile_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.organization_id
  FROM public.driver_profiles dp
  JOIN public.profiles p ON p.id = dp.profile_id
  WHERE dp.id = p_driver_profile_id;
$$;

-- Organización de un auxiliar_profile (para policy admin de reservations).
CREATE OR REPLACE FUNCTION public.auxiliar_profile_org(p_auxiliar_profile_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.organization_id
  FROM public.auxiliar_profiles ap
  JOIN public.profiles p ON p.id = ap.profile_id
  WHERE ap.id = p_auxiliar_profile_id;
$$;

-- ¿El conductor actual tiene una parada para esta reserva?
CREATE OR REPLACE FUNCTION public.driver_has_stop_for_reservation(p_reservation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = p_reservation_id
      AND ra.driver_profile_id = public.current_driver_id()
  );
$$;

-- ¿La reserva pertenece al auxiliar actual? (para policy aux de route_stops)
CREATE OR REPLACE FUNCTION public.reservation_belongs_to_current_aux(p_reservation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.id = p_reservation_id
      AND r.auxiliar_profile_id = public.current_auxiliar_id()
  );
$$;

-- ¿El conductor actual tiene ruta activa/planeada con este vehículo?
CREATE OR REPLACE FUNCTION public.driver_has_route_with_vehicle(p_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.route_assignments ra
    WHERE ra.vehicle_id = p_vehicle_id
      AND ra.driver_profile_id = public.current_driver_id()
      AND ra.status IN ('planned', 'in_progress')
  );
$$;

REVOKE ALL ON FUNCTION public.aux_has_active_route_with_driver(uuid)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_active_route_with_aux(uuid)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_profile_org(uuid)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auxiliar_profile_org(uuid)               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_stop_for_reservation(uuid)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reservation_belongs_to_current_aux(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_route_with_vehicle(uuid)      FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aux_has_active_route_with_driver(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_active_route_with_aux(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_profile_org(uuid)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.auxiliar_profile_org(uuid)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_stop_for_reservation(uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.reservation_belongs_to_current_aux(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_route_with_vehicle(uuid)      TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Recrear las policies cíclicas con los helpers (misma semántica)
-- -----------------------------------------------------------------------------

-- driver_profiles ← auxiliar con ruta activa
DROP POLICY IF EXISTS p_driver_profiles_select_aux_active ON public.driver_profiles;
CREATE POLICY p_driver_profiles_select_aux_active
  ON public.driver_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND public.aux_has_active_route_with_driver(driver_profiles.id)
  );

-- auxiliar_profiles ← conductor con ruta activa
DROP POLICY IF EXISTS p_auxiliar_profiles_select_driver_active ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_select_driver_active
  ON public.auxiliar_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND public.driver_has_active_route_with_aux(auxiliar_profiles.id)
  );

-- route_assignments ← admin de la organización
DROP POLICY IF EXISTS p_route_assignments_select_admin ON public.route_assignments;
CREATE POLICY p_route_assignments_select_admin
  ON public.route_assignments
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND public.driver_profile_org(route_assignments.driver_profile_id) = public.current_user_org()
  );

-- reservations ← conductor con parada asignada / admin de la organización
DROP POLICY IF EXISTS p_reservations_select_driver ON public.reservations;
CREATE POLICY p_reservations_select_driver
  ON public.reservations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND public.driver_has_stop_for_reservation(reservations.id)
  );

DROP POLICY IF EXISTS p_reservations_select_admin ON public.reservations;
CREATE POLICY p_reservations_select_admin
  ON public.reservations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND public.auxiliar_profile_org(reservations.auxiliar_profile_id) = public.current_user_org()
  );

-- route_stops ← auxiliar dueño de la reserva
DROP POLICY IF EXISTS p_route_stops_select_aux ON public.route_stops;
CREATE POLICY p_route_stops_select_aux
  ON public.route_stops
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND public.reservation_belongs_to_current_aux(route_stops.reservation_id)
  );

-- vehicles ← conductor con ruta asignada (también lo pasamos a helper por
-- consistencia y para no re-expandir policies de route_assignments)
DROP POLICY IF EXISTS p_vehicles_select_driver_assigned ON public.vehicles;
CREATE POLICY p_vehicles_select_driver_assigned
  ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND public.driver_has_route_with_vehicle(vehicles.id)
  );

COMMENT ON FUNCTION public.aux_has_active_route_with_driver(uuid) IS 'Helper RLS (0023): rompe ciclo driver_profiles↔route_assignments.';
COMMENT ON FUNCTION public.driver_has_stop_for_reservation(uuid)  IS 'Helper RLS (0023): rompe ciclo reservations↔route_stops.';

COMMIT;
