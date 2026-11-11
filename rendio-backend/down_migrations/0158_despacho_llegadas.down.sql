-- Down 0158 — quita el despacho de llegadas y los ajustes del optimizador V2.
-- No toca nada de antes: 0158 solo agregó.
BEGIN;
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'despachar-llegadas';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%)', SQLERRM;
END
$do$;
DROP FUNCTION IF EXISTS public.despachar_llegadas();
DROP FUNCTION IF EXISTS public.despacho_avisar(uuid, text, timestamptz, int);
DROP FUNCTION IF EXISTS public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int);
DROP FUNCTION IF EXISTS public.despacho_estado(timestamptz);
DROP TABLE IF EXISTS public.arrival_dispatch_log;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_despacho_rangos;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS despacho_espera_max_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS despacho_juntar_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS despacho_horizonte_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS despacho_activo;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_band_factors;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_buffer_flex_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_apoyo_car;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS route_solver_v2;
COMMIT;
