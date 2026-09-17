-- Rollback Migration 0004. Referencia. NO automático.
BEGIN;

DROP FUNCTION IF EXISTS public.current_driver_id();
DROP FUNCTION IF EXISTS public.current_auxiliar_id();
DROP FUNCTION IF EXISTS public.current_user_org();
DROP FUNCTION IF EXISTS public.current_user_role();

DROP POLICY IF EXISTS p_organizations_select_own            ON public.organizations;
DROP POLICY IF EXISTS p_organizations_admin_all             ON public.organizations;

DROP POLICY IF EXISTS p_airports_select_org                 ON public.airports;
DROP POLICY IF EXISTS p_airports_admin_all                  ON public.airports;

DROP POLICY IF EXISTS p_profiles_select_self                ON public.profiles;
DROP POLICY IF EXISTS p_profiles_select_admin               ON public.profiles;
DROP POLICY IF EXISTS p_profiles_update_self                ON public.profiles;
DROP POLICY IF EXISTS p_profiles_update_admin               ON public.profiles;
DROP POLICY IF EXISTS p_profiles_delete_admin               ON public.profiles;

DROP POLICY IF EXISTS p_auxiliar_profiles_select_own        ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_auxiliar_profiles_select_admin      ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_auxiliar_profiles_select_driver_active ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_auxiliar_profiles_update_own        ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_auxiliar_profiles_update_admin      ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_auxiliar_profiles_admin_insert      ON public.auxiliar_profiles;

DROP POLICY IF EXISTS p_driver_profiles_select_own          ON public.driver_profiles;
DROP POLICY IF EXISTS p_driver_profiles_select_admin        ON public.driver_profiles;
DROP POLICY IF EXISTS p_driver_profiles_select_aux_active   ON public.driver_profiles;
DROP POLICY IF EXISTS p_driver_profiles_update_own          ON public.driver_profiles;
DROP POLICY IF EXISTS p_driver_profiles_update_admin        ON public.driver_profiles;
DROP POLICY IF EXISTS p_driver_profiles_admin_insert        ON public.driver_profiles;

DROP POLICY IF EXISTS p_vehicles_select_admin               ON public.vehicles;
DROP POLICY IF EXISTS p_vehicles_select_driver_assigned     ON public.vehicles;
DROP POLICY IF EXISTS p_vehicles_admin_mutate               ON public.vehicles;

DROP POLICY IF EXISTS p_flights_select_admin                ON public.flights;
DROP POLICY IF EXISTS p_flights_select_aux                  ON public.flights;
DROP POLICY IF EXISTS p_flights_select_driver               ON public.flights;
DROP POLICY IF EXISTS p_flights_admin_mutate                ON public.flights;

DROP POLICY IF EXISTS p_reservations_select_aux             ON public.reservations;
DROP POLICY IF EXISTS p_reservations_select_driver          ON public.reservations;
DROP POLICY IF EXISTS p_reservations_select_admin           ON public.reservations;
DROP POLICY IF EXISTS p_reservations_insert_aux             ON public.reservations;
DROP POLICY IF EXISTS p_reservations_insert_admin           ON public.reservations;
DROP POLICY IF EXISTS p_reservations_update_aux             ON public.reservations;
DROP POLICY IF EXISTS p_reservations_update_admin           ON public.reservations;
DROP POLICY IF EXISTS p_reservations_delete_admin           ON public.reservations;

DROP POLICY IF EXISTS p_route_assignments_select_driver     ON public.route_assignments;
DROP POLICY IF EXISTS p_route_assignments_select_admin      ON public.route_assignments;
DROP POLICY IF EXISTS p_route_assignments_admin_mutate      ON public.route_assignments;

DROP POLICY IF EXISTS p_route_stops_select_driver           ON public.route_stops;
DROP POLICY IF EXISTS p_route_stops_select_admin            ON public.route_stops;
DROP POLICY IF EXISTS p_route_stops_select_aux              ON public.route_stops;
DROP POLICY IF EXISTS p_route_stops_admin_mutate            ON public.route_stops;

DROP POLICY IF EXISTS p_driver_locations_select_own         ON public.driver_locations;
DROP POLICY IF EXISTS p_driver_locations_select_admin       ON public.driver_locations;
DROP POLICY IF EXISTS p_driver_locations_select_aux         ON public.driver_locations;
DROP POLICY IF EXISTS p_driver_locations_insert_own         ON public.driver_locations;

COMMIT;
