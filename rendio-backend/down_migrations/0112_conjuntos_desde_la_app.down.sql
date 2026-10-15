-- Reversa de 0112: las reservas vuelven a quedarse con el punto que copiaron al
-- nacer (las que ya se pusieron al día no se devuelven: el punto viejo no se guarda).
BEGIN;
DROP TRIGGER IF EXISTS tr_residences_point_to_trips ON public.residences;
DROP FUNCTION IF EXISTS public.residence_point_to_trips();
COMMIT;
