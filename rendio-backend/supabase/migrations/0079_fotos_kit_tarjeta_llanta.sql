-- =============================================================================
-- Migration 0079 — Tres fotos más al iniciar turno: kit, tarjeta y llanta
--
-- Pedido del jefe (2026-09-06): además de las 8 que ya se toman (4 ángulos
-- exteriores, tablero, guantera y las 2 puertas), el conductor debe adjuntar:
--   · kit de carretera (a la vista: gato, cruceta, triángulos, extintor…)
--   · tarjeta de propiedad del vehículo
--   · la zona de la llanta de repuesto (que esté, y esté en su sitio)
--
-- POR QUÉ: el checklist ya pregunta por las tres (seg_kit, doc_tarjeta,
-- lla_repuesto), pero se responden con un toque y nadie las vuelve a ver. Estos
-- tres líos hoy se descubren cuando ya hay una varada o un retén en la vía, con
-- el turno andando hace horas y sin forma de saber con qué arrancó el carro.
--
-- Igual que 0042: solo amplía el enum inspection_photo_type y el índice único
-- parcial (una foto por tipo por inspección). La captura y la obligatoriedad
-- viven en el wizard del conductor (shift-flow.js, PHOTO_SLOTS). Aditiva: las
-- inspecciones viejas siguen válidas con las fotos que tengan.
--
--   1. inspection_photo_type += 'road_kit', 'property_card', 'spare_tire'
--   2. inspection_photos_unique_fixed_type pasa a definirse POR EXCLUSIÓN
-- =============================================================================

-- Valores nuevos del enum. Sueltos y ANTES de cualquier transacción: Postgres
-- no deja usar un valor de enum recién creado dentro de la misma transacción.
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'road_kit';
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'property_card';
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'spare_tire';

BEGIN;

-- El índice se redefine POR EXCLUSIÓN en vez de enumerar los tipos fijos.
--
-- POR QUÉ el cambio de forma: 0042 los listaba uno por uno, y por eso ni 0042 ni
-- este archivo podían aplicarse de una sola pasada — los aplicadores
-- (_apply-sql-dev.mjs y _migrar-produccion.mjs) corren el archivo entero en UNA
-- transacción, y nombrar aquí 'road_kit' revienta con "unsafe use of new value".
-- Diciéndolo al revés —fijo es todo lo que NO es golpe, adicional ni foto del
-- admin— el índice no nombra los valores nuevos, entra sin partir el archivo, y
-- la próxima foto obligatoria que pida el jefe ya no necesita tocar este índice.
--
-- Cubre exactamente lo mismo que antes más los 3 nuevos: front, left, right,
-- rear, dashboard, glovebox, door_left, door_right, road_kit, property_card,
-- spare_tire. 'damage', 'extra' y 'admin' siguen libres (varias por inspección).
DROP INDEX IF EXISTS public.inspection_photos_unique_fixed_type;
CREATE UNIQUE INDEX inspection_photos_unique_fixed_type
  ON public.inspection_photos (inspection_id, photo_type)
  WHERE photo_type NOT IN ('damage', 'extra', 'admin');

COMMIT;
