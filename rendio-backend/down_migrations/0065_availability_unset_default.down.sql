-- =============================================================================
-- Down de 0065 — devuelve el punto de partida de driver_availability a 'available'
--
-- OJO: esto revierte el DEFAULT, no los datos. Las filas que ya quedaron en
-- 'unset' siguen en 'unset', y el front las seguiría leyendo como "Sin marcar".
-- Para volver de verdad al comportamiento viejo hay que además:
--   UPDATE public.driver_availability SET am_state='available' WHERE am_state='unset';
--   UPDATE public.driver_availability SET pm_state='available' WHERE pm_state='unset';
-- que NO se hace acá porque destruye información real (se pierde el saber quién
-- no respondió). Queda como decisión explícita de quien haga el rollback.
--
-- El valor 'unset' del enum (migración 0064) NO se puede quitar: Postgres no
-- soporta quitar valores de un enum sin recrear el tipo y todas sus columnas.
-- Se deja: un valor de enum sin usar no molesta.
-- =============================================================================

BEGIN;

ALTER TABLE public.driver_availability ALTER COLUMN am_state SET DEFAULT 'available';
ALTER TABLE public.driver_availability ALTER COLUMN pm_state SET DEFAULT 'available';

COMMIT;
