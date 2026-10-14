-- Reversa de 0100_recordatorio_libres.sql.
BEGIN;
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('remind-availability-weekday', 'remind-availability-saturday');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;
DROP FUNCTION IF EXISTS public.remind_weekly_availability(timestamptz);
COMMIT;
