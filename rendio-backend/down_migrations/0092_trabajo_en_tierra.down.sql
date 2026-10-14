-- Revierte 0092: quita reservations.ground_ops.
--
-- OJO: 0093 (tarjeta del viaje) agrega la MISMA columna y la devuelve en
-- auxiliar_my_trips. Si 0093 está aplicada, revertirla PRIMERO (su down), o esta
-- caída rompe esa función.
--
-- Pierde el dato: los traslados en tierra vuelven a verse como traslados de
-- siempre y, en una llegada, el tablero les vuelve a sumar el desembarque de
-- respaldo. El front degrada: Api.createReservation reintenta sin la columna y
-- Api.listRoutePlanning cae al select sin ella.

BEGIN;

ALTER TABLE public.reservations DROP COLUMN IF EXISTS ground_ops;

COMMIT;
