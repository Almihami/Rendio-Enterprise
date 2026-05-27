-- =============================================================================
-- DOWN migration 0016 — revierte shifts/inspections/inspection_photos/
--                       incidents/maintenance.
--
-- Orden: triggers → policies → tablas → enums.
-- Idempotente (DROP ... IF EXISTS).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Triggers y funciones específicas
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_shifts_close_block_vehicle ON public.shifts;
DROP FUNCTION IF EXISTS public.shifts_close_block_vehicle();

DROP TRIGGER IF EXISTS tr_shifts_set_updated_at        ON public.shifts;
DROP TRIGGER IF EXISTS tr_inspections_set_updated_at   ON public.inspections;
DROP TRIGGER IF EXISTS tr_incidents_set_updated_at     ON public.incidents;
DROP TRIGGER IF EXISTS tr_maintenance_set_updated_at   ON public.maintenance;

-- ---------------------------------------------------------------------------
-- Policies (las tablas se borran abajo, pero los DROP explícitos sirven si
-- alguien re-corre el down después de un rollback parcial).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS p_shifts_select_own              ON public.shifts;
DROP POLICY IF EXISTS p_shifts_select_admin            ON public.shifts;
DROP POLICY IF EXISTS p_shifts_insert_own              ON public.shifts;
DROP POLICY IF EXISTS p_shifts_update_own              ON public.shifts;
DROP POLICY IF EXISTS p_shifts_delete_admin            ON public.shifts;

DROP POLICY IF EXISTS p_inspections_select_own         ON public.inspections;
DROP POLICY IF EXISTS p_inspections_select_admin       ON public.inspections;
DROP POLICY IF EXISTS p_inspections_insert_own         ON public.inspections;
DROP POLICY IF EXISTS p_inspections_update_own         ON public.inspections;
DROP POLICY IF EXISTS p_inspections_delete_admin       ON public.inspections;

DROP POLICY IF EXISTS p_inspection_photos_select_own   ON public.inspection_photos;
DROP POLICY IF EXISTS p_inspection_photos_select_admin ON public.inspection_photos;
DROP POLICY IF EXISTS p_inspection_photos_insert_own   ON public.inspection_photos;
DROP POLICY IF EXISTS p_inspection_photos_delete_admin ON public.inspection_photos;

DROP POLICY IF EXISTS p_incidents_select_own           ON public.incidents;
DROP POLICY IF EXISTS p_incidents_select_admin         ON public.incidents;
DROP POLICY IF EXISTS p_incidents_insert_own           ON public.incidents;
DROP POLICY IF EXISTS p_incidents_update_admin         ON public.incidents;
DROP POLICY IF EXISTS p_incidents_delete_admin         ON public.incidents;

DROP POLICY IF EXISTS p_maintenance_select_admin       ON public.maintenance;
DROP POLICY IF EXISTS p_maintenance_insert_admin       ON public.maintenance;
DROP POLICY IF EXISTS p_maintenance_update_admin       ON public.maintenance;
DROP POLICY IF EXISTS p_maintenance_delete_admin       ON public.maintenance;

-- ---------------------------------------------------------------------------
-- Tables (en orden de dependencias: hijos primero)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS public.inspection_photos CASCADE;
DROP TABLE IF EXISTS public.inspections       CASCADE;
DROP TABLE IF EXISTS public.incidents         CASCADE;
DROP TABLE IF EXISTS public.maintenance       CASCADE;
DROP TABLE IF EXISTS public.shifts            CASCADE;

-- ---------------------------------------------------------------------------
-- Enums introducidos por esta migration
-- (shift_status / incident_severity / incident_category SE MANTIENEN: los
--  definió 0001 y otras tablas podrían depender de ellos.)
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS public.inspection_kind;
DROP TYPE IF EXISTS public.inspection_photo_type;
DROP TYPE IF EXISTS public.incident_status;

COMMIT;
