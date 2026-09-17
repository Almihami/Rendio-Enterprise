-- Down migration 0023 — restaura las policies inline de 0004 (vuelven los
-- ciclos de recursión; solo usar como referencia de rollback).

BEGIN;

DROP POLICY IF EXISTS p_vehicles_select_driver_assigned ON public.vehicles;
DROP POLICY IF EXISTS p_route_stops_select_aux ON public.route_stops;
DROP POLICY IF EXISTS p_reservations_select_admin ON public.reservations;
DROP POLICY IF EXISTS p_reservations_select_driver ON public.reservations;
DROP POLICY IF EXISTS p_route_assignments_select_admin ON public.route_assignments;
DROP POLICY IF EXISTS p_auxiliar_profiles_select_driver_active ON public.auxiliar_profiles;
DROP POLICY IF EXISTS p_driver_profiles_select_aux_active ON public.driver_profiles;
-- (re-crear las versiones originales desde 0004 si se requiere)

DROP FUNCTION IF EXISTS public.driver_has_route_with_vehicle(uuid);
DROP FUNCTION IF EXISTS public.reservation_belongs_to_current_aux(uuid);
DROP FUNCTION IF EXISTS public.driver_has_stop_for_reservation(uuid);
DROP FUNCTION IF EXISTS public.auxiliar_profile_org(uuid);
DROP FUNCTION IF EXISTS public.driver_profile_org(uuid);
DROP FUNCTION IF EXISTS public.driver_has_active_route_with_aux(uuid);
DROP FUNCTION IF EXISTS public.aux_has_active_route_with_driver(uuid);

COMMIT;
