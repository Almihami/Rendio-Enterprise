-- Deshace 0176: sin el disparador, una llegada ya no se adelanta cuando alguien sale.
BEGIN;
DROP TRIGGER IF EXISTS tr_route_stops_llegada_adelanta ON public.route_stops;
DROP FUNCTION IF EXISTS public.tg_route_stops_llegada_adelanta();
DROP FUNCTION IF EXISTS public.llegada_adelantar(uuid, uuid);
COMMIT;
