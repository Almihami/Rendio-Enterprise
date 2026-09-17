-- =============================================================================
-- Migration 0042 — Fotos de interior "sin basura" al iniciar turno
--
-- Solicitud de los jefes: además de los 5 ángulos exteriores, el conductor debe
-- adjuntar al iniciar turno fotos de los espacios de almacenamiento del carro
-- para garantizar que arranca sin basura:
--   · guantera (abierta, vacía)
--   · bolsillo de la puerta del conductor
--   · bolsillo de la puerta del pasajero
--
-- Esta migración solo amplía el enum inspection_photo_type con 3 valores nuevos
-- y los suma al índice único parcial (una foto por tipo por inspección, igual
-- que los 5 ángulos fijos). La captura y obligatoriedad se manejan en el wizard
-- del conductor (shift-flow.js). Aditivo, sin pérdida de datos.
--
--   1. inspection_photo_type += 'glovebox', 'door_left', 'door_right'
--   2. inspection_photos_unique_fixed_type += esos 3 tipos
-- =============================================================================

-- Valores nuevos del enum (sueltos, no se usan en esta misma transacción →
-- seguro en PG15, mismo patrón que 0028/0029/0030).
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'glovebox';
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'door_left';
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'door_right';

BEGIN;

-- Extender la unicidad "una por inspección" a los 3 tipos nuevos (son fotos
-- fijas y únicas, como los 5 ángulos; 'damage'/'extra' siguen libres).
DROP INDEX IF EXISTS public.inspection_photos_unique_fixed_type;
CREATE UNIQUE INDEX IF NOT EXISTS inspection_photos_unique_fixed_type
  ON public.inspection_photos (inspection_id, photo_type)
  WHERE photo_type IN ('front', 'left', 'right', 'rear', 'dashboard',
                       'glovebox', 'door_left', 'door_right');

COMMIT;
