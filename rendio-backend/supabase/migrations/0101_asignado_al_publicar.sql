-- =============================================================================
-- 0101 · Al publicar el plan, la reserva queda «asignada»
-- =============================================================================
-- Hallazgo de la prueba de punta a punta (11-oct-2026): publicar el plan creaba
-- route_assignments + route_stops con conductor, pero la reserva seguía en
-- 'requested' (salida) / 'scheduled' (llegada). Resultado: en admin › Reservas
-- los 6 tripulantes ya ruteados y con conductor salían «Sin rutear», y en el
-- Inicio del tripulante el viaje decía «Pedido» aunque ya mostraba al conductor.
--
-- Ahora, al entrar una parada a una ruta ACTIVA con conductor, la reserva pasa a
-- 'assigned' / 'driver_assigned' (los valores que el enum ya tenía para esto).
-- Solo AVANZA desde los estados de «pedido»: nunca pisa en camino, a bordo,
-- entregado, no se presentó ni cancelado. Si la parada sale del plan (re-publicar
-- sin esa persona) y no queda en otra ruta activa, vuelve a «pedido».
-- Esto NO dispara avisos: 0097 solo avisa en camino / llegó / no se presentó.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reservation_mark_assigned()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.reservation_id ELSE NEW.reservation_id END;
  v_activa boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.route_stops rs
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = v_res
      AND ra.status IN ('planned', 'in_progress')
      AND ra.driver_profile_id IS NOT NULL
      AND (TG_OP <> 'DELETE' OR rs.id <> OLD.id)
  ) INTO v_activa;

  IF v_activa THEN
    UPDATE public.reservations
       SET status_h2a = CASE WHEN direction = 'home_to_airport' AND coalesce(status_h2a::text, 'requested') = 'requested'
                             THEN 'assigned'::public.reservation_status_h2a ELSE status_h2a END,
           status_a2h = CASE WHEN direction = 'airport_to_home' AND coalesce(status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking')
                             THEN 'driver_assigned'::public.reservation_status_a2h ELSE status_a2h END,
           updated_at = now()
     WHERE id = v_res AND cancelled_at IS NULL
       AND ((direction = 'home_to_airport' AND coalesce(status_h2a::text, 'requested') = 'requested')
         OR (direction = 'airport_to_home' AND coalesce(status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking')));
  ELSE
    -- Ya no está en ninguna ruta activa: si seguía solo «asignada», vuelve a pedido.
    UPDATE public.reservations
       SET status_h2a = CASE WHEN status_h2a = 'assigned' THEN 'requested'::public.reservation_status_h2a ELSE status_h2a END,
           status_a2h = CASE WHEN status_a2h = 'driver_assigned' THEN 'scheduled'::public.reservation_status_a2h ELSE status_a2h END,
           updated_at = now()
     WHERE id = v_res AND (status_h2a = 'assigned' OR status_a2h = 'driver_assigned');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.reservation_mark_assigned() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_stops_mark_assigned ON public.route_stops;
CREATE TRIGGER tr_route_stops_mark_assigned
  AFTER INSERT OR DELETE ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.reservation_mark_assigned();

-- Relleno: lo que ya está publicado y con conductor.
-- RELLENO:INICIO
UPDATE public.reservations r
   SET status_h2a = 'assigned', updated_at = now()
 WHERE r.direction = 'home_to_airport' AND coalesce(r.status_h2a::text, 'requested') = 'requested' AND r.cancelled_at IS NULL
   AND EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
               WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress') AND ra.driver_profile_id IS NOT NULL);
UPDATE public.reservations r
   SET status_a2h = 'driver_assigned', updated_at = now()
 WHERE r.direction = 'airport_to_home' AND coalesce(r.status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking') AND r.cancelled_at IS NULL
   AND EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
               WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress') AND ra.driver_profile_id IS NOT NULL);
-- RELLENO:FIN

COMMIT;
