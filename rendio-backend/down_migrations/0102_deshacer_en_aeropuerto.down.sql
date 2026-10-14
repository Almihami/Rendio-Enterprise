-- Reversa de 0102_deshacer_en_aeropuerto.sql (las paradas ya deshechas se quedan en «llegó»).
BEGIN;
DROP FUNCTION IF EXISTS public.driver_airport_undo(uuid);
COMMIT;
