-- Rollback Migration 0006. Referencia. NO automático.
BEGIN;

DROP POLICY IF EXISTS p_inspections_insert_driver_or_admin ON storage.objects;
DROP POLICY IF EXISTS p_inspections_select_org             ON storage.objects;
DROP POLICY IF EXISTS p_profiles_avatar_insert_self        ON storage.objects;
DROP POLICY IF EXISTS p_profiles_avatar_update_self        ON storage.objects;
DROP POLICY IF EXISTS p_profiles_avatar_delete_self        ON storage.objects;
DROP POLICY IF EXISTS p_profiles_avatar_select_public      ON storage.objects;

DELETE FROM storage.buckets WHERE id IN ('inspections', 'profiles');

COMMIT;
