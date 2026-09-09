-- =============================================================================
-- Migration 0039 — Inicio de turno con inspección DIFERIDA (cambios apurados PM)
--
-- En cambios de turno de la tarde a veces no da tiempo de inspeccionar. Se permite
-- iniciar el turno SOLO con el km y hacer la inspección dentro de un plazo. Si no
-- se hace a tiempo → strike automático. Todo parametrizable por el admin.
--
-- Parámetros (app_settings):
--   fast_start_enabled        bool  (default true)  — habilita el inicio diferido.
--   fast_start_from_hour      int   (default 12)    — ventana permitida: desde (hora Bogotá).
--   fast_start_to_hour        int   (default 16)    — ventana permitida: hasta (exclusivo).
--   inspection_grace_minutes  int   (default 90)    — plazo para hacer la inspección.
--
-- shifts.inspection_due_at  timestamptz — fecha límite de la inspección (si inició diferido).
--
-- start_shift_deferred(shift, km): como start_shift pero SIN exigir inspección;
--   valida la ventana con hora del SERVIDOR (no se burla con la hora del celular),
--   activa el turno y fija inspection_due_at = now + plazo.
-- process_pending_inspections(): cron — turnos vencidos sin inspección → strike +
--   limpia inspection_due_at (no re-castiga). El strike dispara la suspensión a los N.
-- =============================================================================

-- 1) Parámetros + columna (idempotente)
BEGIN;
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS fast_start_enabled       boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fast_start_from_hour     smallint NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS fast_start_to_hour       smallint NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS inspection_grace_minutes smallint NOT NULL DEFAULT 90;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_fast_start_hours_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_fast_start_hours_range
  CHECK (fast_start_from_hour BETWEEN 0 AND 23 AND fast_start_to_hour BETWEEN 1 AND 24);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_grace_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_grace_range
  CHECK (inspection_grace_minutes BETWEEN 15 AND 480);

ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS inspection_due_at timestamptz;
COMMENT ON COLUMN public.shifts.inspection_due_at IS 'Si el turno inició con inspección diferida, fecha límite para hacerla.';
COMMIT;

-- 2) start_shift_deferred — inicia sin inspección, con plazo, validando ventana
CREATE OR REPLACE FUNCTION public.start_shift_deferred(p_shift_id uuid, p_opening_km int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_shift          public.shifts%ROWTYPE;
  v_vehicle_status public.vehicle_status;
  v_driver_id      uuid;
  v_enabled        boolean;
  v_from           int;
  v_to             int;
  v_grace          int;
  v_hour           int;
  v_due            timestamptz;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile'; END IF;

  SELECT COALESCE(fast_start_enabled, true), COALESCE(fast_start_from_hour, 12),
         COALESCE(fast_start_to_hour, 16), COALESCE(inspection_grace_minutes, 90)
    INTO v_enabled, v_from, v_to, v_grace
    FROM public.app_settings WHERE id = 'singleton';
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAST_START_DISABLED: el inicio diferido no está habilitado';
  END IF;

  -- Ventana validada con la HORA DEL SERVIDOR (Bogotá) → no se burla con el celular.
  v_hour := extract(hour FROM (now() AT TIME ZONE 'America/Bogota'))::int;
  IF NOT (v_hour >= v_from AND v_hour < v_to) THEN
    RAISE EXCEPTION 'FAST_START_NOT_ALLOWED_NOW: fuera de la franja permitida (% a % h)', v_from, v_to;
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_NOT_FOUND'; END IF;
  IF v_shift.driver_id <> v_driver_id THEN RAISE EXCEPTION 'NOT_SHIFT_OWNER'; END IF;
  IF v_shift.status NOT IN ('vehicle_selected', 'inspection_in_progress') THEN
    RAISE EXCEPTION 'INVALID_SHIFT_STATUS: %', v_shift.status;
  END IF;
  IF p_opening_km IS NULL THEN RAISE EXCEPTION 'OPENING_KM_REQUIRED'; END IF;

  SELECT status INTO v_vehicle_status FROM public.vehicles WHERE id = v_shift.vehicle_id FOR UPDATE;
  IF v_vehicle_status IN ('maintenance', 'blocked') THEN
    RAISE EXCEPTION 'VEHICLE_NOT_OPERABLE: %', v_vehicle_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shifts s
     WHERE s.vehicle_id = v_shift.vehicle_id AND s.id <> v_shift.id AND s.status IN ('active', 'closing')
  ) THEN
    RAISE EXCEPTION 'VEHICLE_IN_USE_BY_ANOTHER_SHIFT';
  END IF;

  v_due := now() + make_interval(mins => v_grace);

  UPDATE public.shifts
     SET status = 'active', start_at = now(), opening_km = p_opening_km, inspection_due_at = v_due
   WHERE id = v_shift.id;

  UPDATE public.vehicles
     SET status = 'in_use',
         current_km = GREATEST(current_km, p_opening_km),
         last_maintenance_km = CASE WHEN COALESCE(last_maintenance_km, 0) = 0 THEN GREATEST(current_km, p_opening_km) ELSE last_maintenance_km END
   WHERE id = v_shift.vehicle_id;

  PERFORM public.log_audit_event(
    'shift_started_deferred', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'opening_km', p_opening_km, 'inspection_due_at', v_due)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'active', 'inspection_due_at', v_due);
END;
$fn$;
REVOKE ALL ON FUNCTION public.start_shift_deferred(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_shift_deferred(uuid, int) TO authenticated;

-- 3) process_pending_inspections — strike a los turnos vencidos sin inspección
CREATE OR REPLACE FUNCTION public.process_pending_inspections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_shift   public.shifts%ROWTYPE;
  v_profile uuid;
  v_count   int := 0;
BEGIN
  FOR v_shift IN
    SELECT * FROM public.shifts s
     WHERE s.status = 'active'
       AND s.inspection_due_at IS NOT NULL
       AND s.inspection_due_at < now()
       AND NOT EXISTS (SELECT 1 FROM public.inspections i WHERE i.shift_id = s.id AND i.kind = 'initial')
     FOR UPDATE
  LOOP
    SELECT profile_id INTO v_profile FROM public.driver_profiles WHERE id = v_shift.driver_id;
    IF v_profile IS NOT NULL THEN
      INSERT INTO public.driver_strikes (profile_id, reason)
      VALUES (v_profile, 'No realizó la inspección del turno dentro del plazo');
    END IF;
    -- Limpia el plazo para no volver a castigar el mismo turno.
    UPDATE public.shifts
       SET inspection_due_at = NULL,
           notes = trim(both E' \n' from coalesce(v_shift.notes || E'\n', '') || 'INSPECCIÓN VENCIDA: strike automático.')
     WHERE id = v_shift.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$fn$;
REVOKE ALL ON FUNCTION public.process_pending_inspections() FROM PUBLIC;

-- 4) Cron: revisar inspecciones vencidas cada 10 min (best-effort).
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  BEGIN PERFORM cron.unschedule('process-pending-inspections'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('process-pending-inspections', '*/10 * * * *',
                        $job$SELECT public.process_pending_inspections();$job$);
  RAISE NOTICE 'pg_cron: job "process-pending-inspections" cada 10 min.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%). Corre process_pending_inspections() manualmente o habilita pg_cron.', SQLERRM;
END
$do$;
