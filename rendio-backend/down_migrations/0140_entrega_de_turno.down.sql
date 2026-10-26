-- Reversa de 0140 · entrega de turno. OJO: borra la tabla shift_handovers (lo que
-- los jefes cambiaron y las marcas «Entregado»). Respaldarla antes si importa.
BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'handover-alerts';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): no había reloj que quitar.', SQLERRM;
END
$do$;

DROP FUNCTION IF EXISTS public.handover_alerts(timestamptz);
DROP FUNCTION IF EXISTS public.driver_handover_delivered(date, text, boolean, timestamptz);
DROP FUNCTION IF EXISTS public.driver_my_handovers(timestamptz);
DROP FUNCTION IF EXISTS public.admin_set_handover(date, text, uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.admin_handovers(date);
DROP FUNCTION IF EXISTS public.handover_json(public.handover_row);
DROP FUNCTION IF EXISTS public.handover_received_at(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.handover_effective(uuid, date);
DROP FUNCTION IF EXISTS public.handover_drivers_of(uuid, date);
DROP FUNCTION IF EXISTS public.handover_op_day(timestamptz);
DROP FUNCTION IF EXISTS public.handover_window(date, text);
DROP TYPE IF EXISTS public.handover_row;
DROP TABLE IF EXISTS public.shift_handovers;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_handover_lead_range;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_handover_late_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS handover_lead_min;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS handover_late_min;

COMMIT;
