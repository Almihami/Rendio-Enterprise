-- Reversa de 0136 · Aviso a los jefes cuando un conductor inicia una vuelta.
-- Quita el disparador, la RPC y la función que arma el aviso. La app v222 sigue
-- llamando driver_route_started: sin la función le da error y se lo traga (el aviso
-- es opcional, no frena «Iniciar ruta»). Los avisos que ya estén en la bandeja
-- (dedupe_key 'ini:%') se quedan; para que no salga ninguno pendiente:
--   DELETE FROM public.notification_outbox WHERE dedupe_key LIKE 'ini:%' AND sent_at IS NULL;
BEGIN;
DROP TRIGGER IF EXISTS tr_route_stops_started_alert ON public.route_stops;
DROP FUNCTION IF EXISTS public.route_started_alert();
DROP FUNCTION IF EXISTS public.driver_route_started(uuid);
DROP FUNCTION IF EXISTS public.route_started_alert_enqueue(uuid, uuid);
COMMIT;
