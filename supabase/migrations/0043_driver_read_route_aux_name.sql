-- =============================================================================
-- Migration 0043 — el conductor puede leer el NOMBRE del auxiliar de su ruta.
--
-- Gap detectado: p_auxiliar_profiles_select_driver_active (0023) deja al
-- conductor leer auxiliar_profiles de su ruta activa, pero NO el profiles.full_name
-- detrás (profiles solo tenía select_self / select_admin). Resultado: en la app
-- del conductor las paradas salían como "Auxiliar" en vez del nombre real.
--
-- Solución: helper SECURITY DEFINER (evita recursión de RLS) + policy en profiles.
-- Idempotente.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.driver_has_active_route_with_aux_profile(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.auxiliar_profiles ap
    JOIN public.reservations r        ON r.auxiliar_profile_id = ap.id
    JOIN public.route_stops rs        ON rs.reservation_id = r.id
    JOIN public.route_assignments ra  ON ra.id = rs.route_assignment_id
    WHERE ap.profile_id = p_profile_id
      AND ra.driver_profile_id = public.current_driver_id()
      AND ra.status IN ('planned', 'in_progress')
  );
$$;

REVOKE ALL   ON FUNCTION public.driver_has_active_route_with_aux_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_has_active_route_with_aux_profile(uuid) TO authenticated;

DROP POLICY IF EXISTS p_profiles_select_driver_route_aux ON public.profiles;
CREATE POLICY p_profiles_select_driver_route_aux
  ON public.profiles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND public.driver_has_active_route_with_aux_profile(profiles.id)
  );

COMMIT;
