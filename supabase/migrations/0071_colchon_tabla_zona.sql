-- 0071_colchon_tabla_zona.sql
--
-- LA TABLA DE ZONA DE JULIÁN NO ES TIEMPO DE VIAJE: ES VIAJE + COLCHÓN.
--
-- Medido el 2026-08-17 contra sus 7 planes manuales guardados en
-- rendio-backend/scripts/planes-jefe/. Tres evidencias independientes:
--
-- 1. SUS DOS REGLAS SE CONTRADICEN ENTRE SÍ. Cuando viaja UNA sola persona,
--    "del primero al aeropuerto" (route_zone_times) y "desde la última persona
--    recogida" (route_leg_times) son EL MISMO trayecto. En las 20 combinaciones
--    de zona × franja la primera pide **25 minutos más** que la segunda, y no
--    coinciden en ninguna. (scripts/_zone-vs-leg.mjs)
--
-- 2. NINGÚN PLAN SUYO CUMPLE LA TABLA DE ZONA. Ratio de lo que él programa
--    contra lo que la tabla pide, por plan: 0,50 · 0,50 · 0,50 · 0,53 · 0,60 ·
--    0,63 · 0,67. Incluye el plan del viernes 7-ago, que es DÍA NORMAL — así
--    que no es un efecto de domingos ni festivos, como se pensó primero.
--    (scripts/_festivo-vs-normal.mjs)
--
-- 3. EL MODELO CALCULADO LE ACIERTA MEJOR QUE SU PROPIA TABLA. Sobre los 105
--    tramos finales de esos 7 planes: OSRM × route_airport_factor se desvía
--    4,3 min en promedio y se pasa por 10+ min en 1 de 105 casos; la tabla se
--    desvía 6,1 min y se pasa en 18 de 105. (scripts/_tramo-3-vias.mjs)
--
-- CÓMO SE RESUELVE SIN DESOBEDECERLO. Su palabra fue "**recomendable** recogerla
-- 15:05": la tabla de zona es su recomendación con margen adentro, no el tiempo
-- de manejo. Al meterla como piso de duración el solver creía que los carros son
-- lentísimos y pedía flota que no existe — exactamente lo que 0062 quería evitar
-- y terminó provocando. Aquí se le descuenta el colchón, que además ya está
-- modelado aparte en route_airport_buffer_min (10 min antes de la presentación,
-- que él sí confirmó explícitamente).
--
-- El default es 25 porque es la diferencia media medida entre sus dos reglas.
-- Queda editable: si la operación quiere programar con su recomendación completa
-- se pone en 0 y el sistema vuelve a comportarse como antes de esta migración.
--
-- Idempotente.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_zone_cushion_min smallint NOT NULL DEFAULT 25;

COMMENT ON COLUMN public.app_settings.route_zone_cushion_min IS
  'Minutos de colchón que trae adentro la tabla de zona de Julián (route_zone_times) y que NO son tiempo de manejo. Se le descuentan antes de usarla como piso de duración. Default 25 = diferencia media medida entre sus dos reglas sobre 7 planes suyos (17-ago-2026). En 0, el solver vuelve a usar su tabla completa.';

COMMIT;
