-- 0057_calibrar_contra_plan_julian.sql
--
-- Recalibra el optimizador contra el plan manual de Julián del 6-ago (18 vueltas
-- de salida hechas a mano sobre las mismas reservas que tiene el sistema).
--
-- Va junto con el cambio de código que agrupa por HUECO ENTRE HORAS en vez de
-- por distancia a la primera hora del grupo. El día empieza así:
--
--     3:30 Juan Martínez · 3:30 Juanita · 3:40 Ximena · 3:50 Jesús · 4:00 David
--     4:00 Manuela · 4:30 Javier · 5:00 Lina · 5:40 Cata · 6:20 Luz · 6:40 Gallón
--
-- Entre 3:30 y 4:00 los saltos son de 10 minutos: es UN racimo, que el cupo de 4
-- parte en 4+2. El corte de verdad está en 4:00 → 4:30, donde se abre el hueco.
-- Midiendo desde la primera hora del grupo, Jesús (3:50) quedaba a 20 min de Juan
-- Martínez (3:30) y se caía del grupo que la operación arma sin pensarlo.
--
-- MEDIDO corriendo el solver real sobre las 53 reservas del día y comparando
-- vuelta por vuelta contra su plan (agrupaciones de personas que coinciden):
--
--   hueco  servicio │ = a Julián │ vueltas │ tarde │ sin rutear
--       0         — │   10/18    │   34    │   3   │    12       (sin fusión)
--      30         3 │    8/18    │   26    │   1   │     3       (0056, sin encadenar)
--      30         2 │    7/18    │   25    │   0   │     3
--      20         2 │   10/18    │   27    │   1   │     3
--      15         2 │   12/18    │   29    │   0   │     3       ← se elige
--      10         2 │   12/18    │   32    │   0   │     3
--
-- Se elige 15: empata en parecido con 10 pero con 3 vueltas menos, y no deja
-- ninguna llegada tarde.
--
-- route_service_min 3 → 2: de su plan se deduce ~1.7 min por portería (en su
-- vuelta de 4 paradas le quedan 7 minutos para todas, medido contra OSRM).
--
-- LO QUE NO SE PUDO CERRAR. Nuestros carros salen en promedio 20 min ANTES que
-- los suyos. No es un parámetro mal puesto: se probó con colchón 0 y hasta sin
-- colchón de aeropuerto y el número no se mueve. Es estructural — el solver
-- encadena vueltas y saca el carro apenas se desocupa, mientras Julián acomoda
-- cada vuelta a una hora cómoda. Y él entrega la primera vuelta a las 3:35 para
-- una presentación de 3:30: se toma 5 minutos de juego que el sistema, por
-- diseño, no se toma.
--
-- Idempotente.

BEGIN;

ALTER TABLE public.app_settings
  ALTER COLUMN route_merge_window_min   SET DEFAULT 15,
  ALTER COLUMN route_service_min        SET DEFAULT 2,
  ALTER COLUMN route_depart_cushion_min SET DEFAULT 5;

UPDATE public.app_settings
   SET route_merge_window_min   = 15,
       route_service_min        = 2,
       route_depart_cushion_min = 5
 WHERE id = 'singleton';

COMMENT ON COLUMN public.app_settings.route_merge_window_min IS
  'Hueco máximo entre una hora de presentación y la siguiente para que sigan siendo el mismo racimo (encadenado: 3:30·3:40·3:50·4:00 son un racimo; el corte llega en 4:00→4:30). Calibrado en 15 contra el plan manual de Julián. Solo fusiona si un carro sale más barato que dos, así que un desvío caro (Marinilla) se rechaza solo. 0 = no fusionar.';

COMMIT;
