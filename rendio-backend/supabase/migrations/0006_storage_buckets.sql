-- =============================================================================
-- Migration 0006 — Storage buckets ('inspections', 'profiles')
-- Tarea contractual: E1.09
-- Spec: Arquitectura §9.
--
-- Crea:
--   - Bucket 'inspections' (privado) con file size limit y mime types.
--   - Bucket 'profiles' (público, para avatares).
--   - Policies de Storage (SELECT/INSERT) por rol según §9.3.
--
-- Estructura objetivo (path):
--   inspections/{org_id}/{vehicle_id}/{YYYY-MM-DD}/{inspection_id}/{angle}.jpg
--   profiles/{profile_id}.jpg
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. BUCKETS
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('inspections', 'inspections', false, 5 * 1024 * 1024,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('profiles', 'profiles', true, 2 * 1024 * 1024,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- =============================================================================
-- 2. POLICIES — bucket 'inspections'
-- Path convention: {org_id}/{vehicle_id}/{date}/{inspection_id}/{angle}.jpg
--   storage.foldername(name)[1] = org_id
-- Solo drivers/admins pueden insertar; lectura solo dentro de la propia org.
-- =============================================================================

DROP POLICY IF EXISTS p_inspections_insert_driver_or_admin ON storage.objects;
CREATE POLICY p_inspections_insert_driver_or_admin
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'inspections'
    AND public.current_user_role() IN ('driver', 'admin')
    AND (storage.foldername(name))[1] = public.current_user_org()::text
  );

DROP POLICY IF EXISTS p_inspections_select_org ON storage.objects;
CREATE POLICY p_inspections_select_org
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'inspections'
    AND public.current_user_role() IN ('driver', 'admin')
    AND (storage.foldername(name))[1] = public.current_user_org()::text
  );

-- DELETE: nunca para drivers; admin solo casos especiales (sin policy = bloqueado;
-- service_role siempre bypass).
-- UPDATE: igual.

-- =============================================================================
-- 3. POLICIES — bucket 'profiles' (avatares)
-- Path: {profile_id}.{ext}
-- Lectura pública (público). INSERT/UPDATE/DELETE solo el dueño.
-- =============================================================================

DROP POLICY IF EXISTS p_profiles_avatar_insert_self ON storage.objects;
CREATE POLICY p_profiles_avatar_insert_self
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'profiles'
    AND auth.uid() IS NOT NULL
    AND split_part(name, '.', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS p_profiles_avatar_update_self ON storage.objects;
CREATE POLICY p_profiles_avatar_update_self
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND split_part(name, '.', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS p_profiles_avatar_delete_self ON storage.objects;
CREATE POLICY p_profiles_avatar_delete_self
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND split_part(name, '.', 1) = auth.uid()::text
  );

-- SELECT en bucket público no requiere policy explícita (es público).
-- Pero si algún cliente queda sin marcar como public en el futuro, agregar:
DROP POLICY IF EXISTS p_profiles_avatar_select_public ON storage.objects;
CREATE POLICY p_profiles_avatar_select_public
  ON storage.objects
  FOR SELECT TO authenticated, anon
  USING (bucket_id = 'profiles');

COMMIT;
