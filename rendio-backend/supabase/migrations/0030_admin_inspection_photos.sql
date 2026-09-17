-- =============================================================================
-- Migration 0030 — El admin puede adjuntar foto al resolver una inspección
--
-- Al resolver una inspección pendiente, el admin puede dejar una nota (ya existe
-- vía review_inspection.review_notes) y adjuntar una foto de ser necesario. El
-- storage ('inspections' bucket) ya permite subir a admin (0006), pero la tabla
-- inspection_photos solo tenía INSERT para el conductor. Agregamos:
--   1. photo_type 'admin' — foto que sube el administrador como evidencia/resolución.
--   2. Policy de INSERT para admin en inspection_photos.
-- =============================================================================

ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'admin';

-- INSERT de fotos por el administrador (de su organización).
DROP POLICY IF EXISTS p_inspection_photos_insert_admin ON public.inspection_photos;
CREATE POLICY p_inspection_photos_insert_admin
  ON public.inspection_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );
