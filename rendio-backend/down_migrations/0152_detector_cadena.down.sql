-- Down 0152 — quita el detector de cadena. No toca nada de antes: 0152 solo agregó.
BEGIN;
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'detect-route-chains';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%)', SQLERRM;
END
$do$;
DROP FUNCTION IF EXISTS public.admin_cadena_encender(boolean);
DROP FUNCTION IF EXISTS public.admin_cadena_descartar(uuid);
DROP FUNCTION IF EXISTS public.admin_cadena_aplicar(uuid);
DROP FUNCTION IF EXISTS public.admin_cadena_ver(uuid);
DROP FUNCTION IF EXISTS public.cadena_aviso_del_jefe(uuid);
DROP FUNCTION IF EXISTS public.detect_route_chains();
DROP FUNCTION IF EXISTS public.cadena_evaluar(uuid, boolean);
DROP FUNCTION IF EXISTS public.cadena_candidato(uuid, uuid);
DROP FUNCTION IF EXISTS public.cadena_libre(uuid, uuid, timestamptz);
DROP TABLE IF EXISTS public.route_chain_alerts;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_cadena_rangos;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS cadena_max_hora;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS cadena_horizonte_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS cadena_min_tarde;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS cadena_activa;
COMMIT;
