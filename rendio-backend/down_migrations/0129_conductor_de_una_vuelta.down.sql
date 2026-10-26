-- Reversa de 0129 · Cambiar el conductor de UNA vuelta publicada.
-- Quita la RPC. Las vueltas que ya se cambiaron con ella se quedan como están
-- (la reversa no deshace cambios de conductor). La app, sin la RPC, vuelve a
-- ofrecer solo «Asignar en el tablero» (se publica con «Publicar plan»).
BEGIN;
DROP FUNCTION IF EXISTS public.admin_route_set_driver(uuid, uuid);
COMMIT;
