-- Down de 0027 — red de seguridad del turno.

DO $do$
BEGIN
  BEGIN
    PERFORM cron.unschedule('auto-close-stale-shifts');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP FUNCTION IF EXISTS public.auto_close_stale_shifts();
DROP FUNCTION IF EXISTS public.force_close_shift(uuid, text);

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_auto_close_hours_range;
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS auto_close_hours;
