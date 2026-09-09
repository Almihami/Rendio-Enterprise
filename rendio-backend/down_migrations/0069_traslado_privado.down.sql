-- Reversa de 0069_traslado_privado.sql
--
-- OJO: esto BORRA las solicitudes de privado que se hayan hecho (el nivel, el
-- estado, el precio pactado y quién lo aprobó). Las reservas en sí no se tocan:
-- vuelven a ser traslados normales. Si ya hay privados aprobados en operación,
-- exporta antes.

BEGIN;

DROP TRIGGER IF EXISTS tr_guard_private_insert ON public.reservations;
DROP TRIGGER IF EXISTS tr_guard_private_decision ON public.reservations;
DROP FUNCTION IF EXISTS public.guard_private_insert();
DROP FUNCTION IF EXISTS public.guard_private_decision();
DROP FUNCTION IF EXISTS public.admin_decide_private(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.private_vehicle_busy_at(timestamptz, uuid);

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_private_coherente;
DROP INDEX IF EXISTS public.idx_reservations_private;

ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS private_reject_reason,
  DROP COLUMN IF EXISTS private_decided_by,
  DROP COLUMN IF EXISTS private_decided_at,
  DROP COLUMN IF EXISTS private_vehicle_id,
  DROP COLUMN IF EXISTS price_cop,
  DROP COLUMN IF EXISTS private_status,
  DROP COLUMN IF EXISTS service_level;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_private_price_pos;
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS aux_private_enabled,
  DROP COLUMN IF EXISTS aux_private_vehicle_id,
  DROP COLUMN IF EXISTS aux_private_price_cop;

DROP TYPE IF EXISTS public.private_status;
DROP TYPE IF EXISTS public.service_level;

COMMIT;
