-- Down de 0025 — quita los parámetros de política de app_settings.
BEGIN;

ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS coord_slots,
  DROP COLUMN IF EXISTS shift_hours;

COMMIT;
