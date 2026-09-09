-- 0060_factor_tramo_aeropuerto.sql
--
-- El optimizador corregía TODOS los tiempos de OSRM con un solo factor
-- (route_traffic_factor). Medido contra la programación manual del jefe —6
-- mensajes de WhatsApp, 99 vueltas de salida, scripts/reglas-jefe.mjs— eso está
-- mal, porque el error de OSRM no es parejo:
--
--   · ENTRE CASA Y CASA (62 pasos): él deja 8.5 min donde OSRM dice 5.8. Le
--     SOBRAN 2.7, que es justo el tiempo de subir gente (route_service_min = 2).
--     Ahí OSRM acierta y no hay nada que corregir.
--   · TRAMO A MDE: promete 20 min desde Olivar, Río Vivo, Manzanillos o Cerezos,
--     donde OSRM dice 27.5. Ese piso de 0.72–0.73 aparece 13 veces en conjuntos y
--     días distintos, y la operación cumple todos los días.
--
-- O sea que bajar el factor global habría dañado los pasos entre casas, que
-- estaban bien. Por eso el tramo al aeropuerto pasa a tener factor propio.
--
-- MEDIDO con scripts/comparar-con-jefe.mjs, que corre el modelo real sobre las
-- vueltas del jefe tal como él las armó. Como esas vueltas sí ruedan, cada
-- "llega tarde" es un error NUESTRO:
--
--   factor │ llega después de la presentación │ desfase promedio │ tramo final
--     1.00 │           73/84  (87%)           │     +5.5 min     │  24.6 min
--     0.85 │           57/84  (68%)           │     +1.9 min     │  20.9 min
--     0.80 │           48/84  (57%)           │     +0.5 min     │  19.7 min   ← se elige
--     0.75 │           38/84  (45%)           │     -0.6 min     │  18.5 min
--     0.72 │           33/84  (39%)           │     -1.3 min     │  17.7 min
--                                             (el jefe promete 20.7 min en promedio)
--
-- Se elige 0.80: es donde el desfase contra sus horas reales se hace ~0 sin
-- pasarnos de listos. Por debajo el modelo se declara MÁS RÁPIDO de lo que el
-- jefe promete, y la prioridad #1 del tablero es no llegar tarde nunca.
--
-- EFECTO EN UN DÍA REAL (11-ago, 62 traslados, 3 carros): los traslados que se
-- quedaban SIN CARRO bajan de 6 a 2. Ese era el síntoma que se venía arrastrando
-- — el modelo lento hacía pedir más flota de la que la operación usa.
--
-- LO QUE ESTO **NO** ARREGLA, y es una decisión de operación, no un parámetro:
-- la app exige entregar route_airport_buffer_min (10) ANTES de la hora de
-- presentación; el jefe entrega A la hora. Por eso, aun con los tiempos ya
-- calibrados, el tablero seguiría marcando 'late' casi todas sus vueltas: no
-- porque el carro llegue tarde, sino porque no se toma nuestro colchón. Hay que
-- decidir con él si ese colchón es de verdad obligatorio.
--
-- No se aplica a TomTom: esos tiempos ya vienen medidos de la vía real.
-- Idempotente.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_airport_factor numeric NOT NULL DEFAULT 0.80;

UPDATE public.app_settings
   SET route_airport_factor = 0.80
 WHERE id = 'singleton';

COMMENT ON COLUMN public.app_settings.route_airport_factor IS
  'Multiplica SOLO el tramo a/desde el aeropuerto, aparte de route_traffic_factor. Va por debajo de 1 porque OSRM sobreestima ese corredor (mide ~28 min lo que la operación hace en 20). Entre paradas NO se aplica: ahí OSRM ya acierta. Calibrado en 0.80 contra 99 vueltas de la programación manual del jefe. 1 = comportamiento anterior. No aplica cuando los tiempos vienen de TomTom.';

COMMIT;
