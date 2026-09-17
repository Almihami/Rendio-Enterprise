-- =============================================================================
-- Migration 0033 — Reserva dura del vehículo al iniciar inspección (bug 5)
--
-- Problema: dos conductores podían elegir el MISMO vehículo y hacer toda la
-- inspección en paralelo; recién en start_shift el segundo chocaba
-- (VEHICLE_IN_USE_BY_ANOTHER_SHIFT) tras desperdiciar su inspección.
--
-- Solución (reserva dura): apenas el conductor elige el vehículo y entra a la
-- inspección, se RESERVA el vehículo (status 'reserved') y los demás lo ven
-- ocupado. La reserva se libera automáticamente si se abandona.
--
-- Contiene:
--   1. vehicle_status += 'reserved'.
--   2. app_settings.reservation_idle_minutes (default 60) — tras cuántos minutos
--      sin avanzar una reserva se considera abandonada.
--   3. reserve_vehicle_for_shift(vehicle, opening_km): SECURITY DEFINER driver —
--      crea/reusa el draft del conductor y marca el vehículo 'reserved'. Lock
--      FOR UPDATE para serializar. Si otro conductor lo tiene reservado pero su
--      reserva está vieja, la libera (auto-sanado) y procede; si está vigente o
--      el carro está activo, rechaza.
--   4. release_stale_reservations(): cierra drafts (reservas) más viejas que el
--      umbral y libera sus vehículos. Para cron (cada 15 min, best-effort).
--   5. force_close_shift: ahora también libera vehículos 'reserved' (no solo
--      'in_use'), para que el admin pueda soltar una reserva colgada.
--
-- start_shift (0022/0032) no necesita cambios: 'reserved' no está en su guard de
-- (maintenance/blocked) y la activación ya pone el vehículo 'in_use'.
-- =============================================================================

-- 1) Nuevo valor de enum (suelto: no se EJECUTA en esta migración; los cuerpos
--    plpgsql resuelven el literal en runtime, así que es seguro).
ALTER TYPE public.vehicle_status ADD VALUE IF NOT EXISTS 'reserved';

BEGIN;

-- 2) Umbral configurable de reserva abandonada
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS reservation_idle_minutes smallint NOT NULL DEFAULT 60;
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_reservation_idle_range;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_reservation_idle_range CHECK (reservation_idle_minutes BETWEEN 5 AND 240);
COMMENT ON COLUMN public.app_settings.reservation_idle_minutes
  IS 'rendio-turnos: minutos sin avanzar tras los cuales una reserva de vehículo (draft) se considera abandonada y se libera. Default 60.';

-- 3) reserve_vehicle_for_shift — reserva el vehículo al entrar a la inspección
CREATE OR REPLACE FUNCTION public.reserve_vehicle_for_shift(p_vehicle_id uuid, p_opening_km int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_driver    uuid;
  v_veh       public.vehicles%ROWTYPE;
  v_existing  public.shifts%ROWTYPE;
  v_other     public.shifts%ROWTYPE;
  v_idle      int;
  v_shift_id  uuid;
BEGIN
  v_driver := public.current_driver_id();
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile';
  END IF;

  SELECT COALESCE(reservation_idle_minutes, 60) INTO v_idle FROM public.app_settings WHERE id = 'singleton';
  IF v_idle IS NULL THEN v_idle := 60; END IF;

  -- Turno abierto del conductor (si tiene). Lock para serializar.
  SELECT * INTO v_existing FROM public.shifts
   WHERE driver_id = v_driver AND status <> 'closed'
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;
  IF FOUND AND v_existing.status IN ('active', 'closing') THEN
    RAISE EXCEPTION 'ALREADY_ON_SHIFT: ya tienes un turno activo';
  END IF;

  -- Lock del vehículo objetivo: serializa reservas concurrentes.
  SELECT * INTO v_veh FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND OR v_veh.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;
  IF v_veh.status IN ('maintenance', 'blocked') THEN
    RAISE EXCEPTION 'VEHICLE_NOT_OPERABLE: %', v_veh.status;
  END IF;

  -- ¿Lo tiene otro conductor en un turno abierto?
  SELECT * INTO v_other FROM public.shifts s
   WHERE s.vehicle_id = p_vehicle_id
     AND s.status <> 'closed'
     AND s.driver_id <> v_driver
   ORDER BY s.start_at DESC LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    IF v_other.status IN ('active', 'closing') THEN
      RAISE EXCEPTION 'VEHICLE_IN_USE_BY_ANOTHER_SHIFT';
    -- Es una reserva (draft) de otro: si está vieja, la liberamos (auto-sanado).
    ELSIF v_other.start_at < now() - make_interval(mins => v_idle) THEN
      UPDATE public.shifts
         SET status = 'closed', end_at = now(),
             notes = trim(both E' \n' from coalesce(v_other.notes || E'\n', '') || 'RESERVA EXPIRADA (liberada al reasignar el vehículo)')
       WHERE id = v_other.id;
    ELSE
      RAISE EXCEPTION 'VEHICLE_RESERVED_BY_ANOTHER';
    END IF;
  END IF;

  -- Si el conductor venía reservando OTRO vehículo, lo liberamos.
  IF v_existing.id IS NOT NULL AND v_existing.vehicle_id <> p_vehicle_id THEN
    UPDATE public.vehicles SET status = 'available'
     WHERE id = v_existing.vehicle_id AND status = 'reserved';
  END IF;

  -- Crear o reusar el draft del conductor.
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.shifts
       SET vehicle_id = p_vehicle_id,
           opening_km = COALESCE(p_opening_km, opening_km),
           status = 'inspection_in_progress',
           start_at = now()
     WHERE id = v_existing.id;
    v_shift_id := v_existing.id;
  ELSE
    INSERT INTO public.shifts (driver_id, organization_id, vehicle_id, opening_km, status)
    VALUES (v_driver, v_veh.organization_id, p_vehicle_id, p_opening_km, 'inspection_in_progress')
    RETURNING id INTO v_shift_id;
  END IF;

  -- Reservar el vehículo (si estaba disponible; si ya estaba 'reserved' por este
  -- mismo conductor, queda igual).
  UPDATE public.vehicles SET status = 'reserved'
   WHERE id = p_vehicle_id AND status = 'available';

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift_id, 'vehicle_id', p_vehicle_id, 'status', 'reserved');
END;
$fn$;

REVOKE ALL ON FUNCTION public.reserve_vehicle_for_shift(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_vehicle_for_shift(uuid, int) TO authenticated;
COMMENT ON FUNCTION public.reserve_vehicle_for_shift(uuid, int)
  IS 'Reserva dura: al entrar a la inspección marca el vehículo reserved y crea/reusa el draft del conductor. Serializa por lock, auto-sana reservas viejas. SECURITY DEFINER (conductor).';

-- 4) release_stale_reservations — libera reservas abandonadas (para cron)
CREATE OR REPLACE FUNCTION public.release_stale_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_idle  int;
  v_shift public.shifts%ROWTYPE;
  v_count int := 0;
BEGIN
  SELECT COALESCE(reservation_idle_minutes, 60) INTO v_idle FROM public.app_settings WHERE id = 'singleton';
  IF v_idle IS NULL THEN v_idle := 60; END IF;

  FOR v_shift IN
    SELECT * FROM public.shifts
     WHERE status IN ('vehicle_selected', 'inspection_in_progress')
       AND start_at < now() - make_interval(mins => v_idle)
     FOR UPDATE
  LOOP
    UPDATE public.shifts
       SET status = 'closed', end_at = now(),
           notes = trim(both E' \n' from coalesce(v_shift.notes || E'\n', '') || 'RESERVA EXPIRADA: inspección sin avanzar más de ' || v_idle || ' min.')
     WHERE id = v_shift.id;
    UPDATE public.vehicles SET status = 'available'
     WHERE id = v_shift.vehicle_id AND status = 'reserved';
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;
REVOKE ALL ON FUNCTION public.release_stale_reservations() FROM PUBLIC;
COMMENT ON FUNCTION public.release_stale_reservations()
  IS 'Cierra reservas (drafts) más viejas que app_settings.reservation_idle_minutes y libera sus vehículos. Para pg_cron.';

-- 5) force_close_shift — ahora también libera vehículos 'reserved'
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

  IF v_shift.status = 'closed' THEN
    RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed', 'noop', true);
  END IF;

  UPDATE public.shifts
     SET status = 'closed', end_at = now(),
         notes  = trim(both E' \n' from coalesce(notes || E'\n', '') ||
                  'CIERRE FORZADO (admin): ' || coalesce(p_reason, 'sin detalle'))
   WHERE id = v_shift.id;

  -- Liberar el vehículo: in_use (turno activo) o reserved (draft sin terminar).
  UPDATE public.vehicles
     SET status = 'available'
   WHERE id = v_shift.vehicle_id
     AND status IN ('in_use', 'reserved');

  PERFORM public.log_audit_event(
    'shift_force_closed', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'reason', p_reason, 'by', v_uid)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed');
END;
$fn$;
REVOKE ALL ON FUNCTION public.force_close_shift(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_close_shift(uuid, text) TO authenticated;

COMMIT;

-- 6) Cron: liberar reservas abandonadas cada 15 min (best-effort).
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  BEGIN
    PERFORM cron.unschedule('release-stale-reservations');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM cron.schedule('release-stale-reservations', '*/15 * * * *',
                        $job$SELECT public.release_stale_reservations();$job$);
  RAISE NOTICE 'pg_cron: job "release-stale-reservations" programado cada 15 min.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible/sin permisos (%). El admin puede liberar reservas colgadas desde "Turnos activos".', SQLERRM;
END
$do$;
