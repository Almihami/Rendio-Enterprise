-- 0074 — CÓMO DESPACHA JULIÁN: los tres parámetros que salieron de medir sus
-- correcciones del 18, 19, 20 y 21 de agosto de 2026 contra nuestro plan.
--
-- 1. route_cars_count — cuántos carros planea el tablero. Estaba clavado en 2 en
--    api.js (`slice(0, 2)`), así que el tercer vehículo de la flota no existía
--    para el planeador. Medido: SUS PROPIOS PLANES NECESITAN 3 CARROS
--    SIMULTÁNEOS (pico 11:35 el 20-ago y 16:00 el 21-ago) — los dos de los
--    trabajadores más el suyo o un Uber, que él dijo que usa cuando una ruta no
--    alcanza. Con 2 el plan marca 6-9 traslados "quizás no haya carro" que en la
--    operación sí se hacen. Nace en 2 para no cambiar el comportamiento sin que
--    la operación lo decida.
--
-- 2. route_rescue_early / route_rescue_max_early_min — "antes de dejar a alguien
--    sin carro, adelantarlo". Regla suya: a Melisa Arcila (presentación 13:20)
--    la sacó a las 12:20 con "estar 12:40" en vez de dejarla sin carro. El tope
--    es porque él también dijo "30 minutos es lo máximo que acepto madrugar a
--    alguien para montarlo con otro"; sin tope, el rescate metía a una persona
--    de las 13:00 en la vuelta de las 3 de la mañana (error medio 8 → 104 min).
--    En 45 min cubre su caso de Melisa y no dispara.
--
-- 3. route_car_priority — llenar un carro antes de sacar el siguiente, en vez de
--    repartir parejo entre los carros. El desempate anterior (`s.vuelta`)
--    repartía, y al darle 3 carros el solver abría vueltas nuevas donde él junta
--    gente. Medido con 3 carros: error de la hora de recogida 14,6 → 10,1 min
--    (20-ago) y 10,0 → 8,5 (21-ago), sin carro 0 y 2, y las vueltas tarde 2 → 0.
--
-- Idempotente. Ver docs/ESTUDIO-RUTAS-JULIAN.md para los números completos.

alter table public.app_settings add column if not exists route_cars_count           smallint not null default 2;
alter table public.app_settings add column if not exists route_rescue_early         boolean  not null default true;
alter table public.app_settings add column if not exists route_rescue_max_early_min smallint not null default 45;
alter table public.app_settings add column if not exists route_car_priority         boolean  not null default true;

comment on column public.app_settings.route_cars_count is
  'Cuántos carros planea el tablero de rutas. Sus planes piden 3 en el pico (los 2 de los trabajadores + el suyo o un Uber).';
comment on column public.app_settings.route_rescue_early is
  'Antes de dejar a alguien sin carro, intentar montarlo en una vuelta anterior (regla de Julián).';
comment on column public.app_settings.route_rescue_max_early_min is
  'Cuánto se le puede madrugar a alguien para ese rescate. Él dijo 30; su caso de Melisa Arcila fue 40.';
comment on column public.app_settings.route_car_priority is
  'Llenar un carro antes de sacar el siguiente, en vez de repartir parejo. Así despacha él: el tercer carro es el último recurso.';

-- 4. EL BARRIDO — dictado por él en audio el 21-ago-2026: "que hagan un barrido
--    desde lo más lejano hasta el aeropuerto siempre... llega hasta donde
--    Javier, desde ahí solo coja El Porvenir, Llanogrande o el aeropuerto".
--    Una vuelta de salida arranca en la parada más lejana EN MINUTOS DE
--    CARRETERA (no en kilómetros: Ébano queda a 7,1 km y 26 min, Olivar a 5,9 km
--    y 28 min — por eso mi plan lo hacía devolverse creyendo que avanzaba) y de
--    ahí solo puede acercarse. Sus "zonas" no son barrios: son anillos de
--    distancia (Fontibón 27-28 min, Porvenir 20-23, Llanogrande 17).
--    VALIDADO fuera de muestra: de los 32 bloques multiparada de sus
--    correcciones del 18, 19, 20 y 21 de agosto, CERO rompen el barrido.
--    La tolerancia existe porque él sí salta dentro de un mismo anillo: su plan
--    del 22-ago hace Cerezos(28)->Rio Vivo(28) y Piedemonte(27)->Olivar(28).
--    Empatar no es devolverse.
--
-- 5. route_max_early_min — cuánto se le puede madrugar a alguien para llenar un
--    carro ajeno. Medido sobre las 20 vueltas de su corrección del 22-ago: la
--    anticipación (presentación menos recogida) va de 20 a 60 min y NUNCA pasa
--    de 60. Las tres fusiones que deshizo pasaban de 60 (Erika quedaba 95 min
--    antes de su presentación por acompañar a Sara Villegas): prefirió sacar
--    otra vuelta corta. O sea: el barrido y la madrugada son restricciones;
--    llenar el carro es preferencia.
--    NO confundir con route_max_wait_min, que limita el recorrido del PRIMERO.
--    Ese se probó como techo duro y EMPEORA (error 13,8 -> 27,2 min): bloquea
--    fusiones buenas, satura los carros y todo el mundo madruga.
--
--    Las dos juntas, medidas contra su corrección del 22-ago:
--      error medio de la hora de recogida  13,8 -> 9,4 min
--      personas con 20+ min de diferencia    10 -> 3 (y una de las 3 es su
--                                                     propia anomalía: Dayana)
--      bloques que rompen el barrido        3/8 -> 0/9
--      vueltas tarde                          3 -> 2
--      sesgo                              -5,6 -> -1,5 (dejó de madrugar a todos)

alter table public.app_settings add column if not exists route_sweep_tol_min    smallint not null default 2;
alter table public.app_settings add column if not exists route_sweep_slack_pct  smallint not null default 12;
alter table public.app_settings add column if not exists route_max_early_min    smallint not null default 60;

comment on column public.app_settings.route_sweep_tol_min is
  'Barrido: cuántos minutos puede una vuelta devolverse (alejarse del aeropuerto) sin considerarse zigzag. Él salta dentro del mismo anillo, no se devuelve.';
comment on column public.app_settings.route_sweep_slack_pct is
  'Cuánto recorrido extra (%) se acepta para respetar el barrido. Él prefiere una vuelta que cierre a una corta que zigzaguee.';
comment on column public.app_settings.route_max_early_min is
  'Cuánto se le puede madrugar a alguien para llenar el carro de otro. Medido: nunca pasa de 60 min de su presentación.';

-- LA VENTANA DE FUSIÓN. Medido sobre sus correcciones del 20 y 21 de agosto:
-- con 30 min el error de la hora de recogida es 16,3 y 12,1 min; con 20 baja a
-- 10,7 y 9,7. Es el corte con el que él parte los racimos (por eso a Luz, que se
-- presenta 27 min después del grupo anterior, le da vuelta sola).
update public.app_settings set route_merge_window_min = 20 where id = 'singleton' and route_merge_window_min = 30;
