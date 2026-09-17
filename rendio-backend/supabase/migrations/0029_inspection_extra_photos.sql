-- =============================================================================
-- Migration 0029 — Fotos adicionales en la inspección (a criterio del conductor)
--
-- El conductor puede subir fotos extra además de los 5 ángulos fijos y la del
-- golpe, si lo ve necesario. La tabla inspection_photos (0016) tenía un UNIQUE
-- (inspection_id, photo_type) que solo permitía UNA foto por tipo. Lo relajamos
-- a un índice único PARCIAL que aplica solo a los 5 ángulos fijos, dejando
-- múltiples fotos 'damage' y 'extra'.
--
--   1. inspection_photo_type += 'extra' — foto adicional libre.
--   2. UNIQUE(inspection_id, photo_type) → índice único parcial solo para los
--      tipos fijos (front/left/right/rear/dashboard).
-- Aditivo y sin pérdida de datos.
-- =============================================================================

-- Nuevo valor de enum (suelto, no se usa en esta misma migración → seguro en PG15).
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'extra';

BEGIN;

-- Quitar la unicidad global por tipo...
ALTER TABLE public.inspection_photos
  DROP CONSTRAINT IF EXISTS inspection_photos_unique_per_inspection;

-- ...y dejarla solo para los 5 ángulos fijos (esos sí, uno por inspección).
-- 'damage' y 'extra' quedan libres (varias por inspección).
CREATE UNIQUE INDEX IF NOT EXISTS inspection_photos_unique_fixed_type
  ON public.inspection_photos (inspection_id, photo_type)
  WHERE photo_type IN ('front', 'left', 'right', 'rear', 'dashboard');

COMMIT;
