-- =============================================================================
-- Migration 0044 — el conductor marca el avance de sus paradas (Pieza 1).
--
-- El conductor ejecuta su ruta y marca: en camino / llegué / a bordo / entregado /
-- no se presenta. Eso debe escribirse en reservations.status_h2a|status_a2h para que
-- el AUXILIAR vea su estado en vivo y el ADMIN vea el avance de la operación.
--
-- En vez de abrir un UPDATE amplio de reservations por RLS, se expone UNA función
-- SECURITY DEFINER que:
--   1. exige que quien llama sea un conductor (current_driver_id()),
--   2. exige que la reserva esté en una ruta ACTIVA asignada a ESE conductor
--      (route_assignments.driver_profile_id = él, status planned|in_progress),
--   3. escribe el estado en la columna correcta según la dirección de la reserva.
-- El cast a los enums reservation_status_* valida el valor (falla si es inválido).
--
-- Sigue el patrón de 0043 (current_driver_id / SECURITY DEFINER / grants).
-- Idempotente.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.driver_set_reservation_status(
  p_reservation_id uuid,
  p_status         text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver uuid := public.current_driver_id();
  v_dir    public.trip_direction;
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'solo un conductor puede actualizar el estado de una parada';
  END IF;

  -- La reserva debe estar en una ruta ACTIVA asignada a ESTE conductor.
  SELECT r.direction INTO v_dir
  FROM public.reservations r
  JOIN public.route_stops rs       ON rs.reservation_id = r.id
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE r.id = p_reservation_id
    AND ra.driver_profile_id = v_driver
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no está en una ruta activa asignada a este conductor', p_reservation_id;
  END IF;

  -- Escribe en la columna que corresponde a la dirección (el cast valida el enum).
  IF v_dir = 'home_to_airport' THEN
    UPDATE public.reservations
      SET status_h2a = p_status::public.reservation_status_h2a, updated_at = now()
      WHERE id = p_reservation_id;
  ELSE
    UPDATE public.reservations
      SET status_a2h = p_status::public.reservation_status_a2h, updated_at = now()
      WHERE id = p_reservation_id;
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.driver_set_reservation_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_set_reservation_status(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.driver_set_reservation_status(uuid, text)
  IS 'El conductor asignado marca el avance de una parada de su ruta (recogí/entregué/no-show…). Valida propiedad de la ruta y escribe en status_h2a|status_a2h según la dirección.';

COMMIT;
