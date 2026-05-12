-- =============================================================================
-- Migration 0004 — Row Level Security policies + auth helpers
-- Tarea contractual: E1.07
-- Spec: Arquitectura §7.
--
-- DESVÍO de spec documentado:
-- La arquitectura §7.1 ubica los helpers en schema `auth` (auth.user_role(),
-- auth.user_org(), auth.auxiliar_id(), auth.driver_id()). Pero Supabase
-- managed restringe DDL en el schema `auth` al rol `supabase_auth_admin`,
-- por lo que aquí se ubican en schema `public` con prefijo `current_`.
-- Funcionalidad equivalente.
--
-- Helpers (en public):
--   - public.current_user_role()    -> 'admin' | 'driver' | 'auxiliar' | NULL
--   - public.current_user_org()     -> uuid
--   - public.current_auxiliar_id()  -> uuid (NULL si no es auxiliar)
--   - public.current_driver_id()    -> uuid (NULL si no es driver)
--
-- Cada helper lee primero del JWT custom claim si existe; sino fallback a
-- lookup contra profiles. Esto deja policies operativas incluso antes de
-- activar el Custom Claims hook (E1.02).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. AUTH HELPERS (en schema public)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claim_role text;
  fallback_role text;
BEGIN
  claim_role := nullif((auth.jwt() ->> 'role'), '');
  IF claim_role IS NOT NULL THEN
    RETURN claim_role;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT role::text INTO fallback_role
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN fallback_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claim_org text;
  fallback_org uuid;
BEGIN
  claim_org := nullif((auth.jwt() ->> 'organization_id'), '');
  IF claim_org IS NOT NULL THEN
    RETURN claim_org::uuid;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT organization_id INTO fallback_org
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN fallback_org;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_auxiliar_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM public.auxiliar_profiles WHERE profile_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_driver_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM public.driver_profiles WHERE profile_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_user_role()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_org()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_auxiliar_id()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_driver_id()    TO authenticated;

-- =============================================================================
-- 2. POLICIES — organizations
-- =============================================================================

DROP POLICY IF EXISTS p_organizations_select_own ON public.organizations;
CREATE POLICY p_organizations_select_own
  ON public.organizations
  FOR SELECT TO authenticated
  USING (id = public.current_user_org());

DROP POLICY IF EXISTS p_organizations_admin_all ON public.organizations;
CREATE POLICY p_organizations_admin_all
  ON public.organizations
  FOR ALL TO authenticated
  USING (id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (id = public.current_user_org() AND public.current_user_role() = 'admin');

-- =============================================================================
-- 3. POLICIES — airports
-- =============================================================================

DROP POLICY IF EXISTS p_airports_select_org ON public.airports;
CREATE POLICY p_airports_select_org
  ON public.airports
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_airports_admin_all ON public.airports;
CREATE POLICY p_airports_admin_all
  ON public.airports
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

-- =============================================================================
-- 4. POLICIES — profiles
-- =============================================================================

DROP POLICY IF EXISTS p_profiles_select_self ON public.profiles;
CREATE POLICY p_profiles_select_self
  ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS p_profiles_select_admin ON public.profiles;
CREATE POLICY p_profiles_select_admin
  ON public.profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_profiles_update_self ON public.profiles;
CREATE POLICY p_profiles_update_self
  ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS p_profiles_update_admin ON public.profiles;
CREATE POLICY p_profiles_update_admin
  ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_profiles_delete_admin ON public.profiles;
CREATE POLICY p_profiles_delete_admin
  ON public.profiles
  FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- =============================================================================
-- 5. POLICIES — auxiliar_profiles
-- =============================================================================

DROP POLICY IF EXISTS p_auxiliar_profiles_select_own ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_select_own
  ON public.auxiliar_profiles
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS p_auxiliar_profiles_select_admin ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_select_admin
  ON public.auxiliar_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auxiliar_profiles.profile_id
        AND p.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_auxiliar_profiles_select_driver_active ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_select_driver_active
  ON public.auxiliar_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND EXISTS (
      SELECT 1
      FROM public.reservations r
      JOIN public.route_stops rs       ON rs.reservation_id = r.id
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
      WHERE r.auxiliar_profile_id = auxiliar_profiles.id
        AND ra.driver_profile_id = public.current_driver_id()
        AND ra.status IN ('planned', 'in_progress')
    )
  );

DROP POLICY IF EXISTS p_auxiliar_profiles_update_own ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_update_own
  ON public.auxiliar_profiles
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS p_auxiliar_profiles_update_admin ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_update_admin
  ON public.auxiliar_profiles
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_auxiliar_profiles_admin_insert ON public.auxiliar_profiles;
CREATE POLICY p_auxiliar_profiles_admin_insert
  ON public.auxiliar_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

-- =============================================================================
-- 6. POLICIES — driver_profiles
-- =============================================================================

DROP POLICY IF EXISTS p_driver_profiles_select_own ON public.driver_profiles;
CREATE POLICY p_driver_profiles_select_own
  ON public.driver_profiles
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS p_driver_profiles_select_admin ON public.driver_profiles;
CREATE POLICY p_driver_profiles_select_admin
  ON public.driver_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = driver_profiles.profile_id
        AND p.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_driver_profiles_select_aux_active ON public.driver_profiles;
CREATE POLICY p_driver_profiles_select_aux_active
  ON public.driver_profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND EXISTS (
      SELECT 1
      FROM public.route_assignments ra
      JOIN public.route_stops rs   ON rs.route_assignment_id = ra.id
      JOIN public.reservations r   ON r.id = rs.reservation_id
      WHERE ra.driver_profile_id = driver_profiles.id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
        AND ra.status IN ('planned', 'in_progress')
    )
  );

DROP POLICY IF EXISTS p_driver_profiles_update_own ON public.driver_profiles;
CREATE POLICY p_driver_profiles_update_own
  ON public.driver_profiles
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS p_driver_profiles_update_admin ON public.driver_profiles;
CREATE POLICY p_driver_profiles_update_admin
  ON public.driver_profiles
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_profiles_admin_insert ON public.driver_profiles;
CREATE POLICY p_driver_profiles_admin_insert
  ON public.driver_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

-- =============================================================================
-- 7. POLICIES — vehicles
-- =============================================================================

DROP POLICY IF EXISTS p_vehicles_select_admin ON public.vehicles;
CREATE POLICY p_vehicles_select_admin
  ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    organization_id = public.current_user_org()
    AND public.current_user_role() = 'admin'
  );

DROP POLICY IF EXISTS p_vehicles_select_driver_assigned ON public.vehicles;
CREATE POLICY p_vehicles_select_driver_assigned
  ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND EXISTS (
      SELECT 1 FROM public.route_assignments ra
      WHERE ra.vehicle_id = vehicles.id
        AND ra.driver_profile_id = public.current_driver_id()
        AND ra.status IN ('planned', 'in_progress')
    )
  );

DROP POLICY IF EXISTS p_vehicles_admin_mutate ON public.vehicles;
CREATE POLICY p_vehicles_admin_mutate
  ON public.vehicles
  FOR ALL TO authenticated
  USING (
    organization_id = public.current_user_org()
    AND public.current_user_role() = 'admin'
  )
  WITH CHECK (
    organization_id = public.current_user_org()
    AND public.current_user_role() = 'admin'
  );

-- =============================================================================
-- 8. POLICIES — flights
-- =============================================================================

DROP POLICY IF EXISTS p_flights_select_admin ON public.flights;
CREATE POLICY p_flights_select_admin
  ON public.flights
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.airports a
      WHERE a.id = flights.airport_id
        AND a.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_flights_select_aux ON public.flights;
CREATE POLICY p_flights_select_aux
  ON public.flights
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.flight_id = flights.id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
    )
  );

DROP POLICY IF EXISTS p_flights_select_driver ON public.flights;
CREATE POLICY p_flights_select_driver
  ON public.flights
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND EXISTS (
      SELECT 1 FROM public.route_assignments ra
      WHERE ra.flight_id = flights.id
        AND ra.driver_profile_id = public.current_driver_id()
    )
  );

DROP POLICY IF EXISTS p_flights_admin_mutate ON public.flights;
CREATE POLICY p_flights_admin_mutate
  ON public.flights
  FOR ALL TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.airports a
      WHERE a.id = flights.airport_id
        AND a.organization_id = public.current_user_org()
    )
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.airports a
      WHERE a.id = flights.airport_id
        AND a.organization_id = public.current_user_org()
    )
  );

-- =============================================================================
-- 9. POLICIES — reservations
-- =============================================================================

DROP POLICY IF EXISTS p_reservations_select_aux ON public.reservations;
CREATE POLICY p_reservations_select_aux
  ON public.reservations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND auxiliar_profile_id = public.current_auxiliar_id()
  );

DROP POLICY IF EXISTS p_reservations_select_driver ON public.reservations;
CREATE POLICY p_reservations_select_driver
  ON public.reservations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND EXISTS (
      SELECT 1
      FROM public.route_stops rs
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
      WHERE rs.reservation_id = reservations.id
        AND ra.driver_profile_id = public.current_driver_id()
    )
  );

DROP POLICY IF EXISTS p_reservations_select_admin ON public.reservations;
CREATE POLICY p_reservations_select_admin
  ON public.reservations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1
      FROM public.auxiliar_profiles ap
      JOIN public.profiles p ON p.id = ap.profile_id
      WHERE ap.id = reservations.auxiliar_profile_id
        AND p.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_reservations_insert_aux ON public.reservations;
CREATE POLICY p_reservations_insert_aux
  ON public.reservations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'auxiliar'
    AND auxiliar_profile_id = public.current_auxiliar_id()
  );

DROP POLICY IF EXISTS p_reservations_insert_admin ON public.reservations;
CREATE POLICY p_reservations_insert_admin
  ON public.reservations
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_reservations_update_aux ON public.reservations;
CREATE POLICY p_reservations_update_aux
  ON public.reservations
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND auxiliar_profile_id = public.current_auxiliar_id()
    AND (calculated_pickup_at IS NULL OR calculated_pickup_at - now() > interval '2 hours')
  )
  WITH CHECK (
    auxiliar_profile_id = public.current_auxiliar_id()
  );

DROP POLICY IF EXISTS p_reservations_update_admin ON public.reservations;
CREATE POLICY p_reservations_update_admin
  ON public.reservations
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_reservations_delete_admin ON public.reservations;
CREATE POLICY p_reservations_delete_admin
  ON public.reservations
  FOR DELETE TO authenticated
  USING (public.current_user_role() = 'admin');

-- =============================================================================
-- 10. POLICIES — route_assignments
-- =============================================================================

DROP POLICY IF EXISTS p_route_assignments_select_driver ON public.route_assignments;
CREATE POLICY p_route_assignments_select_driver
  ON public.route_assignments
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND driver_profile_id = public.current_driver_id()
  );

DROP POLICY IF EXISTS p_route_assignments_select_admin ON public.route_assignments;
CREATE POLICY p_route_assignments_select_admin
  ON public.route_assignments
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.driver_profiles dp
      JOIN public.profiles p ON p.id = dp.profile_id
      WHERE dp.id = route_assignments.driver_profile_id
        AND p.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_route_assignments_admin_mutate ON public.route_assignments;
CREATE POLICY p_route_assignments_admin_mutate
  ON public.route_assignments
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- =============================================================================
-- 11. POLICIES — route_stops
-- =============================================================================

DROP POLICY IF EXISTS p_route_stops_select_driver ON public.route_stops;
CREATE POLICY p_route_stops_select_driver
  ON public.route_stops
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND EXISTS (
      SELECT 1 FROM public.route_assignments ra
      WHERE ra.id = route_stops.route_assignment_id
        AND ra.driver_profile_id = public.current_driver_id()
    )
  );

DROP POLICY IF EXISTS p_route_stops_select_admin ON public.route_stops;
CREATE POLICY p_route_stops_select_admin
  ON public.route_stops
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_route_stops_select_aux ON public.route_stops;
CREATE POLICY p_route_stops_select_aux
  ON public.route_stops
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.id = route_stops.reservation_id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
    )
  );

DROP POLICY IF EXISTS p_route_stops_admin_mutate ON public.route_stops;
CREATE POLICY p_route_stops_admin_mutate
  ON public.route_stops
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- =============================================================================
-- 12. POLICIES — driver_locations
-- =============================================================================

DROP POLICY IF EXISTS p_driver_locations_select_own ON public.driver_locations;
CREATE POLICY p_driver_locations_select_own
  ON public.driver_locations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND driver_profile_id = public.current_driver_id()
  );

DROP POLICY IF EXISTS p_driver_locations_select_admin ON public.driver_locations;
CREATE POLICY p_driver_locations_select_admin
  ON public.driver_locations
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_locations_select_aux ON public.driver_locations;
CREATE POLICY p_driver_locations_select_aux
  ON public.driver_locations
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'auxiliar'
    AND route_assignment_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.route_stops rs
      JOIN public.reservations r ON r.id = rs.reservation_id
      WHERE rs.route_assignment_id = driver_locations.route_assignment_id
        AND r.auxiliar_profile_id = public.current_auxiliar_id()
    )
  );

DROP POLICY IF EXISTS p_driver_locations_insert_own ON public.driver_locations;
CREATE POLICY p_driver_locations_insert_own
  ON public.driver_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'driver'
    AND driver_profile_id = public.current_driver_id()
  );

-- DELETE solo via service_role (job de retención). Sin policy = bloqueado.

COMMIT;
