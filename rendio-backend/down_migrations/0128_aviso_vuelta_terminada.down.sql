-- Reversa de 0128 · Aviso a los jefes cuando un conductor termina una vuelta.
-- Quita el disparador y su función. Los avisos que ya estén en la bandeja
-- (dedupe_key 'fin:%') se quedan: los pendientes salen igual y los enviados son
-- historia. Para que no salga ninguno pendiente, borrarlos antes a mano:
--   DELETE FROM public.notification_outbox WHERE dedupe_key LIKE 'fin:%' AND sent_at IS NULL;
BEGIN;
DROP TRIGGER IF EXISTS tr_route_stops_finished_alert ON public.route_stops;
DROP FUNCTION IF EXISTS public.route_finished_alert();
COMMIT;
