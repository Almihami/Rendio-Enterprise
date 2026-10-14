-- Revierte 0108: quita route_zones y las llaves foráneas que la usan.
--
-- Pierde los dibujos. Los nombres siguen vivos en route_zone_times.zone y
-- residences.zona_jefe (texto suelto, como antes de 0108), y la zona puesta a
-- mano no se toca. Ojo: un conjunto que solo tenía zona por el dibujo queda
-- «sin zona». El front degrada: sin la tabla, Api.listRouteZones devuelve null y
-- la pantalla vuelve a las zonas que haya en la tabla de tiempos.

BEGIN;

ALTER TABLE public.route_zone_times DROP CONSTRAINT IF EXISTS route_zone_times_zone_fkey;
ALTER TABLE public.residences DROP CONSTRAINT IF EXISTS residences_zona_jefe_fkey;
DROP TABLE IF EXISTS public.route_zones;

COMMIT;
