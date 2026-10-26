-- Reversa de 0130 · El corte de pedidos de las 7:40 p. m. y el aviso del Excel.
-- Quita el reloj, las funciones y la columna del corte (se pierde el valor que
-- hayan puesto en Ajustes). Los avisos del Excel ya enviados se quedan.
BEGIN;
DO $do$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'excel-cutoff-alerts';
EXCEPTION WHEN OTHERS THEN NULL; END $do$;
DROP FUNCTION IF EXISTS public.excel_cutoff_alerts(timestamptz);
DROP FUNCTION IF EXISTS public.hm12_bog(int);
DROP FUNCTION IF EXISTS public.crew_request_deadline(timestamptz);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_crew_request_cutoff_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS crew_request_cutoff_min;
COMMIT;
