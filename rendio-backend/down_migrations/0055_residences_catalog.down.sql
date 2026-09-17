-- 0055_residences_catalog.down.sql — revierte 0055.
--
-- OJO: al bajar se pierde qué residencia tenía cada auxiliar y cada reserva.
-- Las coordenadas NO se pierden: ya quedaron copiadas en reservations.pickup_*
-- por el trigger, que es justo el punto del diseño.
--
-- Los NOT NULL de auxiliar_profiles.home_* solo se restauran si NINGUNA fila
-- quedó sin coordenada; si alguien se registró eligiendo conjunto y sin pin
-- propio, se deja nullable y se avisa (forzarlo botaría el dato).

BEGIN;

DROP TRIGGER   IF EXISTS tr_reservations_fill_pickup ON public.reservations;
DROP FUNCTION  IF EXISTS public.fill_reservation_pickup();

ALTER TABLE public.reservations DROP COLUMN IF EXISTS residence_id;

ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_pickup_known;
ALTER TABLE public.auxiliar_profiles DROP COLUMN IF EXISTS residence_unit;
ALTER TABLE public.auxiliar_profiles DROP COLUMN IF EXISTS residence_id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auxiliar_profiles
                 WHERE home_latitude IS NULL OR home_longitude IS NULL
                    OR btrim(coalesce(home_address,'')) = '') THEN
    ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_address   SET NOT NULL;
    ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_latitude  SET NOT NULL;
    ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_longitude SET NOT NULL;
  ELSE
    RAISE WARNING 'auxiliar_profiles.home_* se quedan NULLABLE: hay filas sin coordenada propia (vivían solo por residence_id).';
  END IF;
END $$;

-- pickup_address vuelve a obligatorio solo si no quedó ninguna vacía.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.reservations WHERE pickup_address IS NULL) THEN
    ALTER TABLE public.reservations ALTER COLUMN pickup_address SET NOT NULL;
  ELSE
    RAISE WARNING 'reservations.pickup_address se queda NULLABLE: hay filas sin dirección.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.residences;   -- se lleva sus constraints e índices

COMMIT;
