-- Rollback Migration 0002. Referencia. NO automático.
BEGIN;
DROP VIEW  IF EXISTS public.v_vehicle_maintenance_status;
DROP TABLE IF EXISTS public.vehicles          CASCADE;
DROP TABLE IF EXISTS public.driver_profiles   CASCADE;
DROP TABLE IF EXISTS public.auxiliar_profiles CASCADE;
COMMIT;
