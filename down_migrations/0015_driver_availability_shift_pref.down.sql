-- Down de 0015_driver_availability_shift_pref.
BEGIN;

ALTER TABLE public.driver_availability
  DROP CONSTRAINT IF EXISTS driver_availability_shift_pref_check;

ALTER TABLE public.driver_availability
  DROP COLUMN IF EXISTS shift_pref;

COMMIT;
