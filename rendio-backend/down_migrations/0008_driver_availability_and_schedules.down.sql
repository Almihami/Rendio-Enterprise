-- Rollback de 0008_driver_availability_and_schedules.sql
-- Borra policies, triggers, tablas y enum en orden inverso.

BEGIN;

DROP POLICY IF EXISTS p_app_settings_update_admin ON public.app_settings;
DROP POLICY IF EXISTS p_app_settings_select_all   ON public.app_settings;

DROP POLICY IF EXISTS p_weekly_schedules_delete_admin ON public.weekly_schedules;
DROP POLICY IF EXISTS p_weekly_schedules_update_admin ON public.weekly_schedules;
DROP POLICY IF EXISTS p_weekly_schedules_insert_admin ON public.weekly_schedules;
DROP POLICY IF EXISTS p_weekly_schedules_select_all   ON public.weekly_schedules;

DROP POLICY IF EXISTS p_driver_availability_delete_admin ON public.driver_availability;
DROP POLICY IF EXISTS p_driver_availability_update_self  ON public.driver_availability;
DROP POLICY IF EXISTS p_driver_availability_insert_self  ON public.driver_availability;
DROP POLICY IF EXISTS p_driver_availability_select_admin ON public.driver_availability;
DROP POLICY IF EXISTS p_driver_availability_select_self  ON public.driver_availability;

DROP TRIGGER IF EXISTS tr_app_settings_set_updated_at         ON public.app_settings;
DROP TRIGGER IF EXISTS tr_weekly_schedules_set_updated_at     ON public.weekly_schedules;
DROP TRIGGER IF EXISTS tr_driver_availability_set_updated_at  ON public.driver_availability;

DROP TABLE IF EXISTS public.app_settings;
DROP TABLE IF EXISTS public.weekly_schedules;
DROP TABLE IF EXISTS public.driver_availability;

DROP TYPE IF EXISTS public.availability_state;

COMMIT;
