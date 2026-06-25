-- Down de 0014_app_settings_availability_reopen
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS reopen_until;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS reopen_week_start;
