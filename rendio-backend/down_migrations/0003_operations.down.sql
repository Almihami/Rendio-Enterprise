-- Rollback Migration 0003. Referencia. NO automático.
BEGIN;
DROP TABLE IF EXISTS public.driver_locations  CASCADE;
DROP TABLE IF EXISTS public.route_stops       CASCADE;
DROP TABLE IF EXISTS public.route_assignments CASCADE;
DROP TABLE IF EXISTS public.reservations      CASCADE;
DROP TABLE IF EXISTS public.flights           CASCADE;
COMMIT;
