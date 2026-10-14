-- Revierte 0085: la base deja de escribir la hora de recogida publicada y el
-- tripulante recupera la policy de UPDATE directo de 0004.
--
-- calculated_pickup_at vuelve a NULL en todas las reservas: antes de 0085 nadie
-- la escribía, así que NULL es exactamente el estado anterior. Lo que se pierde
-- es solo lo que 0085 calculó (se recalcula al volver a aplicarla).
--
-- La policy se recrea IDÉNTICA a 0004 (con el candado de 2 h sobre
-- calculated_pickup_at, que con la columna en NULL vuelve a no aplicar nunca).

BEGIN;

DROP TRIGGER IF EXISTS tr_route_stops_sync_pickup ON public.route_stops;
DROP TRIGGER IF EXISTS tr_route_assignments_sync_pickup ON public.route_assignments;
DROP FUNCTION IF EXISTS public.tg_route_stops_sync_pickup();
DROP FUNCTION IF EXISTS public.tg_route_assignments_sync_pickup();
DROP FUNCTION IF EXISTS public.sync_calculated_pickup(uuid);

UPDATE public.reservations
   SET calculated_pickup_at = NULL
 WHERE calculated_pickup_at IS NOT NULL;

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

COMMIT;
