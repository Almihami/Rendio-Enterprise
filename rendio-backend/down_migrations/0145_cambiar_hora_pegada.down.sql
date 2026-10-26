-- Reversa de 0145 · «Cambiar hora» en una vuelta de la ruta de Julián.
-- Quita la RPC. Las horas que ya se cambiaron con ella se quedan como están (la
-- reversa no las devuelve). La app, sin la RPC, dice que falta la actualización
-- 0145 y la hora se cambia con «Volver a pegar», como antes.
BEGIN;
DROP FUNCTION IF EXISTS public.admin_manual_route_set_times(uuid, jsonb, timestamptz, timestamptz);
COMMIT;
