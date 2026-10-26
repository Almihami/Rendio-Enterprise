-- Reversa de 0137 · vueltas terminadas fuera de la lista + recordatorio al conductor.
-- Quita el reloj, las dos funciones y las dos columnas de app_settings. La pantalla
-- vuelve a sus valores de siempre (10 y 30 min) porque los lee con respaldo.
BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'route-unmarked-reminders';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): no había reloj que quitar.', SQLERRM;
END
$do$;

DROP FUNCTION IF EXISTS public.route_unmarked_reminders(timestamptz);
DROP FUNCTION IF EXISTS public.route_expected_end(uuid);

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_route_done_hide_range;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_route_unmarked_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_done_hide_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_unmarked_min;

COMMIT;
