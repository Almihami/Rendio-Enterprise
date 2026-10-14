-- =============================================================================
-- 0106 · Personal de tierra en el registro
-- =============================================================================
-- Pedido del 13-oct-2026: no todos los que se registran son tripulación de una
-- aerolínea. Hay personal de TIERRA: trabajan en el aeropuerto (operaciones,
-- mostrador, servicios) y no vuelan. Hasta hoy el registro obligaba a elegir una
-- aerolínea, así que esa persona escogía una que no era la suya.
--
-- 0092 ya resolvió el VIAJE en tierra (reservations.ground_ops: sin vuelo, y en
-- la llegada la hora es la de salir del terminal). Esta migración marca a la
-- PERSONA:
--
-- public.auxiliar_profiles.ground_staff boolean NOT NULL DEFAULT false
--
--   · true  = personal de tierra: sin aerolínea (airline_id NULL). Su primer
--     pedido arranca con «Trabajo en tierra» encendido (después manda lo que
--     eligió en su último pedido, como ya hacía 0092).
--   · false = tripulación de una aerolínea (lo de siempre).
--
-- La regla «tierra ⇒ sin aerolínea» va como CHECK: la app manda las dos cosas
-- juntas (ApiAux.saveMyPrefs) y una escritura incoherente falla en voz alta en
-- vez de dejar a alguien de tierra «en Avianca».
--
-- Lo que NO cambia, y por qué:
--   · register_auxiliar (0076) ya acepta p_airline_id NULL. El registro la llama
--     sin aerolínea y, enseguida, marca ground_staff con la política de siempre
--     (p_auxiliar_profiles_update_own, 0004): cada quien actualiza su fila. No
--     hace falta otra firma ni otra RPC.
--   · RLS: una columna más de auxiliar_profiles. El tripulante la lee y la
--     cambia en la suya; el jefe, en todas (p_auxiliar_profiles_update_admin).
--
-- Aditiva e idempotente. No toca datos: todos quedan en false, que es lo que
-- eran. Down: down_migrations/0106_personal_de_tierra.down.sql
-- =============================================================================

BEGIN;

ALTER TABLE public.auxiliar_profiles
  ADD COLUMN IF NOT EXISTS ground_staff boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.auxiliar_profiles.ground_staff IS
  'Personal de tierra (trabaja en el aeropuerto, no vuela): sin aerolínea y su primer pedido arranca en tierra (0092). 0106, 13-oct-2026.';

ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_ground_sin_aerolinea;
ALTER TABLE public.auxiliar_profiles ADD CONSTRAINT auxiliar_profiles_ground_sin_aerolinea
  CHECK (NOT ground_staff OR airline_id IS NULL);

COMMENT ON CONSTRAINT auxiliar_profiles_ground_sin_aerolinea ON public.auxiliar_profiles IS
  '0106: el personal de tierra no tiene aerolínea. Para pasar a una aerolínea se manda ground_staff=false con el airline_id.';

COMMIT;
