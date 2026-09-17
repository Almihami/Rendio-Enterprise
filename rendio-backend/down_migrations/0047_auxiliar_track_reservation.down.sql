-- Down de 0047 — quita el RPC de rastreo del auxiliar.
BEGIN;
DROP FUNCTION IF EXISTS public.auxiliar_track_reservation(uuid);
COMMIT;
