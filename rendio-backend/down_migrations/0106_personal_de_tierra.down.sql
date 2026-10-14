-- Revierte 0106: quita auxiliar_profiles.ground_staff y su regla.
--
-- Pierde el dato: el personal de tierra queda como «sin aerolínea» y su primer
-- pedido vuelve a arrancar con el interruptor de tierra apagado. El front degrada:
-- Api.getMyAuxHeader y Api.listAuxiliares caen al select sin la columna, y
-- ApiAux.saveMyPrefs devuelve null (la pantalla dice que no se pudo guardar).

BEGIN;

ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_ground_sin_aerolinea;
ALTER TABLE public.auxiliar_profiles DROP COLUMN IF EXISTS ground_staff;

COMMIT;
