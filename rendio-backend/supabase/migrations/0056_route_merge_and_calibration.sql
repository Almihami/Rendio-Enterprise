-- 0056_route_merge_and_calibration.sql
--
-- Dos cosas: los parámetros del modelo de tiempos que faltaban, y la ventana
-- para fusionar oleadas cercanas.
--
-- 1) EL BUG DE FONDO. El código de rutas lee seis parámetros de app_settings
--    (route_service_min, route_traffic_factor, route_airport_buffer_min,
--    route_turnaround_min, route_deplane_min, route_depart_cushion_min) pero
--    esas columnas NUNCA se crearon — la 0040 solo añadió airport_leg,
--    margin_tight y default_capacity. Resultado: `Number(s.route_service_min)`
--    daba undefined y siempre caía al valor fijo del código. Los parámetros
--    "configurables" no eran configurables. Aquí se crean de verdad.
--
-- 2) LA CALIBRACIÓN. Los jefes pasaron su programación manual del 5-ago (12
--    vueltas reales). Comparada contra el modelo, el sistema pedía 511 minutos
--    donde ellos hacen 395: un 29% de más. Ajustando contra su plan:
--      route_traffic_factor  1.25 → 1.05   (a las 3am no hay tráfico que temer;
--                                           el 1.25 se puso a ojo por prudencia)
--      route_service_min        4 → 3      (la tripulante ya está en la portería)
--    Con esos valores el modelo reproduce su plan dentro de ±3 min en 10 de las
--    12 vueltas. OJO: el factor solo aplica a tiempos de OSRM (flujo libre);
--    cuando la matriz viene de TomTom el tráfico ya está adentro y no se aplica.
--
-- 3) LA FUSIÓN. route_merge_window_min: cuántos minutos de diferencia de
--    "deben estar" se pueden juntar en un mismo carro. Los jefes montan en una
--    sola vuelta a los de 03:50 y los de 04:00 y los dejan a todos a las 03:40;
--    el código agrupaba por minuto exacto y sacaba dos carros con dos pasajeros.
--    Con 0 no fusiona nada y el tablero se comporta como antes de esta migración.
--
-- Aditiva e idempotente. No toca datos operativos.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_service_min        smallint      NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS route_airport_buffer_min smallint      NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS route_traffic_factor     numeric(4, 2) NOT NULL DEFAULT 1.05,
  ADD COLUMN IF NOT EXISTS route_turnaround_min     smallint      NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS route_deplane_min        smallint      NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS route_depart_cushion_min smallint      NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS route_merge_window_min   smallint      NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.app_settings.route_service_min IS
  'Minutos que se pierde el carro en cada PORTERÍA (frenar, que suba la gente con maletas). Es por portería, no por pasajero: dos del mismo conjunto son un solo frenazo. Calibrado en 3 contra la programación manual de los jefes.';
COMMENT ON COLUMN public.app_settings.route_airport_buffer_min IS
  'Colchón al entregar en MDE: bajar maletas y entrar. Llegar justo a la hora de presentación ES llegar tarde.';
COMMENT ON COLUMN public.app_settings.route_traffic_factor IS
  'Multiplica el tiempo de manejo cuando la matriz viene de OSRM, que calcula a flujo libre. NO se aplica a TomTom (ya trae el tráfico). Calibrado en 1.05: el 1.25 anterior inflaba el día un 29% contra el plan real.';
COMMENT ON COLUMN public.app_settings.route_turnaround_min IS
  'Minutos en MDE entre entregar una vuelta y arrancar la siguiente.';
COMMENT ON COLUMN public.app_settings.route_deplane_min IS
  'Entre que el vuelo aterriza y el pasajero sale del terminal (migración + maletas).';
COMMENT ON COLUMN public.app_settings.route_depart_cushion_min IS
  'Margen extra al programar la salida de cada vuelta, sobre la hora más tarde a la que podría salir.';
COMMENT ON COLUMN public.app_settings.route_merge_window_min IS
  'Ventana para juntar oleadas cercanas en un mismo carro (30 = quien se presenta hasta 30 min después puede subirse). Solo fusiona si un carro sale más barato que dos, así que un desvío caro (Marinilla) se rechaza solo. 0 = no fusionar.';

COMMIT;
