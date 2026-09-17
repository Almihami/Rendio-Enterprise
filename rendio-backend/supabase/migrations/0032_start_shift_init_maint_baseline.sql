-- =============================================================================
-- Migration 0032 — Inicializar el baseline de mantenimiento al primer odómetro
--
-- Prevención del bug 4 (vehículos que quedaban 'blocked' solos): los vehículos
-- se crean con last_maintenance_km = 0 (default de 0002) y el alta no lo setea.
-- Cuando el conductor registra el odómetro real al iniciar turno, start_shift
-- (0022) subía current_km a ese valor pero dejaba last_maintenance_km en 0; al
-- cerrar el turno, el trigger shifts_close_block_vehicle (0016) veía
-- (current_km - 0) >= maintenance_interval_km y BLOQUEABA el vehículo. Le pasaba
-- a TODO vehículo la primera vez que se usaba con su km real.
--
-- Fix: en start_shift, cuando last_maintenance_km está en 0 (nunca inicializado),
-- lo igualamos al primer odómetro registrado. Así el conteo de mantenimiento
-- arranca desde ese punto y el vehículo no se bloquea de inmediato. Si ya tenía
-- un baseline real (> 0), no se toca y la detección de mantenimiento sigue igual.
--
-- Solo cambia el UPDATE de vehicles dentro de start_shift; el resto de la función
-- (validaciones de dueño, inspección, vehículo libre, etc.) es idéntico a 0022.
-- Idempotente: CREATE OR REPLACE FUNCTION.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.start_shift(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shift          public.shifts%ROWTYPE;
  v_vehicle_status public.vehicle_status;
  v_driver_id      uuid;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;
  IF v_shift.driver_id <> v_driver_id THEN
    RAISE EXCEPTION 'NOT_SHIFT_OWNER';
  END IF;
  IF v_shift.status NOT IN ('vehicle_selected', 'inspection_in_progress') THEN
    RAISE EXCEPTION 'INVALID_SHIFT_STATUS: %', v_shift.status;
  END IF;
  IF v_shift.opening_km IS NULL THEN
    RAISE EXCEPTION 'OPENING_KM_REQUIRED';
  END IF;

  -- Inspección inicial obligatoria
  IF NOT EXISTS (
    SELECT 1 FROM public.inspections i
     WHERE i.shift_id = v_shift.id AND i.kind = 'initial'
  ) THEN
    RAISE EXCEPTION 'INITIAL_INSPECTION_REQUIRED';
  END IF;

  -- El vehículo debe estar operable y sin otro turno abierto
  SELECT status INTO v_vehicle_status
    FROM public.vehicles
   WHERE id = v_shift.vehicle_id
   FOR UPDATE;
  IF v_vehicle_status IN ('maintenance', 'blocked') THEN
    RAISE EXCEPTION 'VEHICLE_NOT_OPERABLE: %', v_vehicle_status;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shifts s
     WHERE s.vehicle_id = v_shift.vehicle_id
       AND s.id <> v_shift.id
       AND s.status IN ('active', 'closing')
  ) THEN
    RAISE EXCEPTION 'VEHICLE_IN_USE_BY_ANOTHER_SHIFT';
  END IF;

  UPDATE public.shifts
     SET status = 'active', start_at = now()
   WHERE id = v_shift.id;

  -- Subir el odómetro y, si el baseline de mantenimiento nunca se inicializó
  -- (last_maintenance_km = 0), igualarlo al primer odómetro registrado para que
  -- el vehículo no se bloquee solo al cerrar (prevención bug 4).
  UPDATE public.vehicles
     SET status = 'in_use',
         current_km = GREATEST(current_km, v_shift.opening_km),
         last_maintenance_km = CASE
           WHEN COALESCE(last_maintenance_km, 0) = 0
             THEN GREATEST(current_km, v_shift.opening_km)
           ELSE last_maintenance_km
         END
   WHERE id = v_shift.vehicle_id;

  PERFORM public.log_audit_event(
    'shift_started', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'opening_km', v_shift.opening_km)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'active');
END;
$$;

REVOKE ALL ON FUNCTION public.start_shift(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_shift(uuid) TO authenticated;

COMMENT ON FUNCTION public.start_shift(uuid) IS 'Activa un shift tras la inspección inicial: valida dueño, inspección y vehículo libre; marca vehículo in_use e inicializa el baseline de mantenimiento al primer odómetro (prevención bug 4).';

COMMIT;
