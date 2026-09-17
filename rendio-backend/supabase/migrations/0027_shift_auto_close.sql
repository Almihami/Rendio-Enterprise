-- =============================================================================
-- Migration 0027 — Red de seguridad del turno (módulo rendio-turnos)
--
-- Problema: el cierre de turno (Etapa 2) aún no existe, así que un turno que
-- llega a 'active' se queda activo para siempre (start_shift lo activa;
-- abort_shift solo cierra ANTES de activar). El vehículo queda 'in_use'.
--
-- Esta migración agrega una RED DE SEGURIDAD (no es la Etapa 2 completa):
--   1. app_settings.auto_close_hours — umbral configurable (default 14h; los
--      turnos son de 12h, 2h de margen).
--   2. force_close_shift(shift, reason) — RPC admin: cierra un turno colgado y
--      LIBERA el vehículo (in_use → available). Para el botón "Turnos activos".
--   3. auto_close_stale_shifts() — cierra todos los turnos activos más viejos
--      que el umbral y libera sus vehículos. Pensada para correr por cron.
--   4. pg_cron — programa auto_close_stale_shifts() cada hora (best-effort).
--
-- NOTA: el trigger shifts_close_block_vehicle (0016) NO devuelve el vehículo a
-- 'available' al cerrar; por eso ambas funciones lo liberan explícitamente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Umbral configurable de auto-cierre
-- -----------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS auto_close_hours smallint NOT NULL DEFAULT 14;

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_auto_close_hours_range;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_auto_close_hours_range CHECK (auto_close_hours BETWEEN 1 AND 72);

COMMENT ON COLUMN public.app_settings.auto_close_hours
  IS 'rendio-turnos: horas tras las cuales un turno activo se auto-cierra (red de seguridad). Default 14 (turnos de 12h).';

COMMIT;

-- -----------------------------------------------------------------------------
-- 2. force_close_shift — admin cierra un turno colgado y libera el vehículo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_close_shift(p_shift_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_shift public.shifts%ROWTYPE;
  v_uid   uuid := auth.uid();
  v_org   uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN: solo el administrador puede forzar el cierre de un turno';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_NOT_FOUND'; END IF;
  IF v_shift.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;

  -- Idempotente: si ya está cerrado, no hace nada.
  IF v_shift.status = 'closed' THEN
    RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed', 'noop', true);
  END IF;

  UPDATE public.shifts
     SET status = 'closed',
         end_at = now(),
         notes  = trim(both E' \n' from coalesce(notes || E'\n', '') ||
                  'CIERRE FORZADO (admin): ' || coalesce(p_reason, 'sin detalle'))
   WHERE id = v_shift.id;

  -- Liberar el vehículo (el trigger de cierre no lo hace). No tocar maintenance/blocked.
  UPDATE public.vehicles
     SET status = 'available'
   WHERE id = v_shift.vehicle_id
     AND status = 'in_use';

  PERFORM public.log_audit_event(
    'shift_force_closed', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'reason', p_reason, 'by', v_uid)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed');
END;
$fn$;

REVOKE ALL ON FUNCTION public.force_close_shift(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_close_shift(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.force_close_shift(uuid, text)
  IS 'Admin cierra un turno colgado y libera el vehículo (in_use→available). SECURITY DEFINER, valida rol admin + organización.';

-- -----------------------------------------------------------------------------
-- 3. auto_close_stale_shifts — cierra turnos activos más viejos que el umbral
--    (pensada para correr por cron como el rol postgres; NO se otorga a clientes)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_stale_shifts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hours int;
  v_shift public.shifts%ROWTYPE;
  v_count int := 0;
BEGIN
  SELECT COALESCE(auto_close_hours, 14) INTO v_hours
    FROM public.app_settings WHERE id = 'singleton';
  IF v_hours IS NULL THEN v_hours := 14; END IF;

  FOR v_shift IN
    SELECT * FROM public.shifts
     WHERE status IN ('active', 'closing')
       AND start_at < now() - make_interval(hours => v_hours)
     FOR UPDATE
  LOOP
    UPDATE public.shifts
       SET status = 'closed',
           end_at = now(),
           notes  = trim(both E' \n' from coalesce(v_shift.notes || E'\n', '') ||
                    'CIERRE AUTOMÁTICO: turno activo más de ' || v_hours || 'h sin cerrar.')
     WHERE id = v_shift.id;

    UPDATE public.vehicles
       SET status = 'available'
     WHERE id = v_shift.vehicle_id
       AND status = 'in_use';

    PERFORM public.log_audit_event(
      'shift_auto_closed', 'shift', v_shift.id,
      jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'hours', v_hours)
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.auto_close_stale_shifts() FROM PUBLIC;

COMMENT ON FUNCTION public.auto_close_stale_shifts()
  IS 'Cierra turnos activos más viejos que app_settings.auto_close_hours y libera sus vehículos. Para correr por pg_cron.';

-- -----------------------------------------------------------------------------
-- 4. pg_cron — programar el auto-cierre cada hora (best-effort).
--    Si pg_cron no está disponible/permitido, la migración NO falla: se emite
--    un NOTICE y el job se puede programar luego (o habilitar pg_cron en el
--    dashboard de Supabase). force_close_shift sigue funcionando igual.
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  -- Reprogramar de forma idempotente.
  BEGIN
    PERFORM cron.unschedule('auto-close-stale-shifts');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM cron.schedule(
    'auto-close-stale-shifts',
    '0 * * * *',
    $job$SELECT public.auto_close_stale_shifts();$job$
  );
  RAISE NOTICE 'pg_cron: job "auto-close-stale-shifts" programado cada hora.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible/sin permisos (%). Programa el job manualmente o habilita pg_cron en el dashboard; el auto-cierre quedará inactivo hasta entonces.', SQLERRM;
END
$do$;
