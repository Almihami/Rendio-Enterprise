-- =============================================================================
-- 0092 · Trabajo en tierra (sin vuelo)
-- =============================================================================
-- Pedidos del 29-sep-2026, frente T8 («No todos trabajan con vuelo, solo
-- trabajan por tierra»). Es el personal de OPERACIONES DEL AEROPUERTO: van a MDE
-- y vuelven de MDE igual que la tripulación, pero sin tomar un vuelo. Respuestas
-- de la profa: manda la hora de LLEGADA AL DESTINO, lo piden desde la misma app
-- y pagan igual.
--
-- public.reservations.ground_ops boolean NOT NULL DEFAULT false
--
--   · SALIDA en tierra (casa → MDE): igual que hoy. required_arrival_at es la
--     hora a la que quiere estar en el aeropuerto y se rutea como siempre.
--   · LLEGADA en tierra (MDE → casa): no hay número de vuelo, y
--     required_arrival_at deja de ser la hora de aterrizaje: es la hora a la que
--     SALE DEL TERMINAL. El tablero (admin-rutas.js, rtDeplaneOf) no le suma
--     desembarque — ni el de la aerolínea (0058) ni el de respaldo
--     (route_deplane_min) — y solo lo junta con gente de un vuelo si esa gente
--     ya está afuera a su hora (rtSolveDay, juntableLle): nunca lo deja
--     esperando un desembarque ajeno.
--
-- Lo que NO cambia en la base, y por qué:
--   · Ningún CHECK ni trigger exige vuelo en una llegada: 0040 dejó flight_id
--     NULLABLE y el número vive en las notas («Vuelo AV9412. »). Una reserva en
--     tierra nace con flight_id NULL y sin ese prefijo; no se crea ni se liga
--     fila de flights.
--   · La exigencia de vuelo que SÍ existe está en auxiliar_change_flight (0089:
--     «Escribe el número de vuelo en el que llegas»). Esa función la redefine el
--     frente de la tarjeta del viaje (0093), no esta migración.
--   · RLS: es una columna más de reservations. El tripulante la escribe al pedir
--     (p_reservations_insert_aux no restringe columnas) y la lee en las suyas;
--     el jefe y el conductor, con las políticas de siempre.
--
-- Aditiva e idempotente: ADD COLUMN IF NOT EXISTS (el frente de la tarjeta
-- agrega la MISMA columna en 0093 con IF NOT EXISTS, así que el orden en que se
-- apliquen da igual). No toca datos: todo lo que ya existe queda en false, que
-- es exactamente lo que era (todos venían con vuelo o sin decir nada).
-- Down: down_migrations/0092_trabajo_en_tierra.down.sql
-- =============================================================================

BEGIN;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS ground_ops boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reservations.ground_ops IS
  'Trabajo en tierra (0092): operaciones del aeropuerto, sin vuelo. En una llegada, required_arrival_at es la hora a la que sale del terminal (no la de aterrizaje) y el tablero NO le suma desembarque. En una salida no cambia nada. Default false = el traslado de siempre.';

COMMIT;
