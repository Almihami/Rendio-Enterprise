-- Down de 0050 — quita cancelación, confirmación de recogida y parámetros de espera.
-- NOTA: auxiliar_track_reservation queda en la versión de 0050. Para volver a la
-- de 0049 hay que re-ejecutar 0049_auxiliar_track_position.sql (CREATE OR REPLACE).
BEGIN;

DROP FUNCTION IF EXISTS public.auxiliar_cancel_reservation(uuid, text);
DROP FUNCTION IF EXISTS public.admin_cancel_reservation(uuid, text);
DROP FUNCTION IF EXISTS public.auxiliar_confirm_ready(uuid);

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_wait_range;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_lead_range;
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS aux_wait_minutes,
  DROP COLUMN IF EXISTS aux_min_lead_hours;

ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS is_overnight,
  DROP COLUMN IF EXISTS is_firm,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancellation_reason;

COMMIT;
