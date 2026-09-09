-- 0059_hotel_como_punto.sql
--
-- EL HOTEL EXISTÍA COMO ETIQUETA, NO COMO LUGAR.
--
-- Desde 0050 hay `reservations.is_overnight` y el tablero pinta esas paradas en
-- ámbar, pero el hotel no tenía coordenada: el solver mandaba a esa persona al
-- aeropuerto igual que a todas. En los planes manuales del jefe el hotel es un
-- PUNTO del recorrido, y aparece de cuatro formas distintas (domingo 9-ago):
--
--   "Hotel y aero"        → deja a una en el hotel y sigue al aeropuerto
--   "Estar 11:20 y hotel" → la vuelta al aeropuerto termina en el hotel
--   "11:30 Lau (hotel)"   → la recogida es EN el hotel
--   "va a hotel"          → casa → hotel, el aeropuerto ni se toca
--
-- POR QUÉ SALE BARATO. El hotel queda sobre la vía Rionegro→MDE, a 3,3 km del
-- terminal (8,3 min por OSRM). Medido contra las 5 residencias más frecuentes,
-- meterlo como parada de paso cuesta +0,2 min — doce segundos. Es decir: el
-- ruteo no se complica, lo único que faltaba era el dato.
--
-- Pin entregado por la profa el 10-ago-2026 (Google Maps, no geocodificador).
--
-- Y DE PASO, EL AEROPUERTO. `airports` tenía 6.1715/-75.4270; el punto donde de
-- verdad se deja y se recoge tripulación está 126 m al sur. Se corrige aquí para
-- que la BD y el front (RT_AIRPORT en admin-rutas.js) digan lo mismo.
--
-- Idempotente. Aditivo: nada de esto borra ni invalida datos existentes.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_hotel_name text             NOT NULL DEFAULT 'Hotel tripulación',
  ADD COLUMN IF NOT EXISTS route_hotel_lat  double precision,
  ADD COLUMN IF NOT EXISTS route_hotel_lng  double precision;

COMMENT ON COLUMN public.app_settings.route_hotel_name IS
  'Rutas: nombre del hotel donde pernocta la tripulación (se muestra en el tablero como destino de la parada).';
COMMENT ON COLUMN public.app_settings.route_hotel_lat IS
  'Rutas: latitud del hotel. NULL = el solver no puede rutear paradas de hotel y las trata como aeropuerto (comportamiento anterior a 0059).';
COMMENT ON COLUMN public.app_settings.route_hotel_lng IS
  'Rutas: longitud del hotel. Ver route_hotel_lat.';

UPDATE public.app_settings
   SET route_hotel_lat = 6.156731281692223,
       route_hotel_lng = -75.43564276278455
 WHERE id = 'singleton'
   AND route_hotel_lat IS NULL;

-- El terminal de pasajeros de MDE, donde para el carro. 126 m al sur del punto
-- que había. No se toca el iata_code ni el nombre.
UPDATE public.airports
   SET latitude  = 6.170795254426601,
       longitude = -75.42788741654356
 WHERE iata_code = 'MDE';

COMMIT;
