-- =============================================================================
-- ROLLBACK Migration 0001 — initial schema
-- Referencia para rollback manual. NO se ejecuta automáticamente.
-- Aplicar con: psql "$DB_URL" -f 0001_initial_schema.down.sql
-- =============================================================================

BEGIN;

-- Drop tables (cascade tira triggers, indexes y constraints)
DROP TABLE IF EXISTS public.profiles      CASCADE;
DROP TABLE IF EXISTS public.airports      CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;

-- Drop helper function
DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE;

-- Drop enums (en orden inverso de dependencia; ninguno depende del otro pero
-- puede haber columnas residuales que los referencien — el CASCADE no aplica
-- a tipos, así que verificar antes)
DROP TYPE IF EXISTS public.incident_category;
DROP TYPE IF EXISTS public.incident_severity;
DROP TYPE IF EXISTS public.shift_status;
DROP TYPE IF EXISTS public.vehicle_status;
DROP TYPE IF EXISTS public.flight_status;
DROP TYPE IF EXISTS public.reservation_status_a2h;
DROP TYPE IF EXISTS public.reservation_status_h2a;
DROP TYPE IF EXISTS public.trip_direction;
DROP TYPE IF EXISTS public.user_role;

-- pgcrypto extension: NO la dropeamos porque otras migrations futuras la requieren.

COMMIT;
