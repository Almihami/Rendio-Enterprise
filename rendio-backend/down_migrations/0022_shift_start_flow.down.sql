-- Down migration 0022 — flujo de inicio de turno del conductor
-- Nota: el backfill de driver_profiles NO se revierte (es data, no schema).

BEGIN;

DROP FUNCTION IF EXISTS public.abort_shift(uuid, text);
DROP FUNCTION IF EXISTS public.start_shift(uuid);

DROP POLICY IF EXISTS p_vehicles_select_driver_org ON public.vehicles;

COMMIT;
