-- 0058_desembarque_por_aerolinea.sql
--
-- EL DESEMBARQUE NO ES IGUAL PARA TODOS LOS VUELOS.
--
-- Hasta hoy el modelo usaba UN número —route_deplane_min, 20 minutos— entre que
-- el vuelo aterriza y el tripulante sale del terminal. La operación (2026-08-06)
-- lo desmiente: depende de la aerolínea y de si el vuelo es nacional o
-- internacional, y la diferencia va de 15 a 35 minutos.
--
--   Avianca   nacional      (AV + 4 dígitos)          15–20 min
--   Avianca   internacional (AV + 2 o 3 dígitos)      20–30 min
--   JetSmart  nacional      (JEC/JA + 4 dígitos)      25–30 min
--   JetSmart  internacional (JEC/JA + 58**)           30–35 min
--   Wingo     cualquiera    (P5 + 4 dígitos)          20–30 min
--
-- POR QUÉ IMPORTA, si nadie pierde un vuelo por esto: el error no llega tarde,
-- inmoviliza. Con 20 planos, en un vuelo de JetSmart internacional el carro se
-- planta 15 minutos en el terminal esperando a alguien que todavía está en
-- migración — y esos 15 minutos son justo los que faltan para alcanzar la
-- siguiente vuelta. En el día del 7-ago hay 6 vueltas de llegada afectadas.
--
-- POR QUÉ EL EXTREMO BAJO DEL RANGO como default: si el carro llega antes, el
-- que espera es el carro; si llega después, el que espera es la tripulante en el
-- andén. Lo segundo es lo que genera queja. Quien quiera apretar la flota sube
-- estos números desde Ajustes — son editables, como el resto de reglas.
--
-- LO QUE NO ENTRA AQUÍ. La operación también reporta que el desembarque depende
-- de cuánta gente traiga el vuelo y de si termina en remota o en muelle. Ninguno
-- de los dos datos existe hoy en el sistema (el formulario no los pregunta y no
-- hay fuente de vuelos), así que NO se modela: se deja dicho, no se inventa.
--
-- route_deplane_min se conserva como respaldo: es el que se usa cuando el vuelo
-- no viene o no se puede clasificar (hoy, 1 de cada 3 llegadas del formulario).
--
-- Aditiva e idempotente. No toca datos operativos.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_deplane_av_nac_min smallint NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS route_deplane_av_int_min smallint NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS route_deplane_js_nac_min smallint NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS route_deplane_js_int_min smallint NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS route_deplane_wingo_min  smallint NOT NULL DEFAULT 20;

COMMENT ON COLUMN public.app_settings.route_deplane_av_nac_min IS
  'Minutos entre que aterriza y sale del terminal — AVIANCA NACIONAL (AV + 4 dígitos). Rango reportado por la operación 15–20; default en el extremo bajo para que el que espere sea el carro y no la tripulante.';
COMMENT ON COLUMN public.app_settings.route_deplane_av_int_min IS
  'Minutos de desembarque — AVIANCA INTERNACIONAL (AV + 2 o 3 dígitos). Rango reportado 20–30.';
COMMENT ON COLUMN public.app_settings.route_deplane_js_nac_min IS
  'Minutos de desembarque — JETSMART NACIONAL (JEC/JA + 4 dígitos). Rango reportado 25–30.';
COMMENT ON COLUMN public.app_settings.route_deplane_js_int_min IS
  'Minutos de desembarque — JETSMART INTERNACIONAL (JEC/JA + 4 dígitos que empiezan en 58). Rango reportado 30–35.';
COMMENT ON COLUMN public.app_settings.route_deplane_wingo_min IS
  'Minutos de desembarque — WINGO (P5 + 4 dígitos), igual sea nacional o internacional. Rango reportado 20–30.';
COMMENT ON COLUMN public.app_settings.route_deplane_min IS
  'Desembarque de RESPALDO: se usa cuando la reserva no trae número de vuelo o el código no se puede clasificar. Las aerolíneas conocidas tienen su propia columna (route_deplane_*_min).';

COMMIT;
