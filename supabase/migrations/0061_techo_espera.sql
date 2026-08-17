-- 0061_techo_espera.sql
--
-- Techo de lo que el PRIMERO recogido va montado antes de presentarse.
--
-- Es una regla del jefe, medida sobre 99 vueltas suyas (scripts/reglas-jefe.mjs):
-- NUNCA la pasa. Máximos reales 45 min fuera de pico y 60 en pico, con 0
-- excepciones. Las dos franjas pico —6-9 a.m. y 12-6 p.m.— son suyas: es su
-- modelo de tráfico, aprendido en terreno.
--
-- El solver no tenía nada de esto. Peor: la rama rápida devolvía la oleada
-- entera si cabía en el CUPO, sin mirar el recorrido — así que 4 personas
-- regadas entre Ébano, Río Vivo, Cámbulo y Guayacán cabían de sobra en el carro
-- y el primero se quedaba 67 minutos adentro. Ahora el techo se aplica MIENTRAS
-- arma (al fusionar oleadas y al partirlas), no verificado al final.
--
-- MEDIDO en el día real del 11-ago (62 traslados, 3 carros, factor 0.80):
--
--   techo    │ vueltas │ tarde │ sin rutear │ espera máx │ pasan el techo
--   sin techo│   32    │   1   │     0      │   67 min   │      2
--   50 / 60  │   32    │   0   │     2      │   53 min   │      1
--
-- ES UN CANJE, y por eso NO se activa solo: respetar el techo obliga a partir
-- vueltas, y partir vueltas deja gente sin carro cuando la flota no da. Con 3
-- carros el 11-ago cuesta 2 traslados sin cubrir a cambio de bajar la peor
-- espera de 67 a 53 min y de dejar el día sin ninguna vuelta tarde.
--
-- Por eso el default es **0 = sin techo**, o sea el comportamiento actual. La
-- decisión de encenderlo (y con qué números) es de la operación, no del código:
-- hay que preguntarle al jefe si prefiere que alguien se quede sin carro o que
-- otro madrugue una hora. Se cambia desde Ajustes → Optimizador de rutas.
--
-- Idempotente.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_max_wait_min      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS route_max_wait_peak_min integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.app_settings.route_max_wait_min IS
  'Máximo de minutos que el PRIMERO recogido va montado antes de la hora de presentación, fuera de horas pico. Se aplica mientras el solver arma la vuelta (al fusionar oleadas y al partirlas). La programación manual del jefe usa 50 y nunca la pasa. 0 = sin techo.';

COMMENT ON COLUMN public.app_settings.route_max_wait_peak_min IS
  'Igual que route_max_wait_min pero de 6 a 9 a.m. y de 12 a 6 p.m., las dos franjas que la operación considera pesadas. La programación manual usa 60. 0 = usar el techo normal.';

COMMIT;
