-- Reversa de 0101_asignado_al_publicar.sql (los estados ya escritos se quedan:
-- 'assigned'/'driver_assigned' son valores válidos del enum desde 0001).
BEGIN;
DROP TRIGGER IF EXISTS tr_route_stops_mark_assigned ON public.route_stops;
DROP FUNCTION IF EXISTS public.reservation_mark_assigned();
COMMIT;
