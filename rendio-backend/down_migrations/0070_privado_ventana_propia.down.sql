-- Reversa de 0070. Devuelve la ventana del cupo a route_turnaround_min, que es
-- el parámetro EQUIVOCADO (ver el encabezado de 0070). Solo tiene sentido como
-- paso previo a revertir también la 0069.
BEGIN;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_private_block_pos;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS aux_private_block_min;
COMMIT;
