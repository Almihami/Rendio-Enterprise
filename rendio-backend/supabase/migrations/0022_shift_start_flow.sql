-- =============================================================================
-- Migration 0022 — flujo de inicio de turno del conductor (Etapa 1 módulo driver)
--
-- Soporta el wizard "Inicio de turno" (selección de vehículo → inspección
-- pre-operacional → fotos → kilometraje → novedades → confirmar e iniciar)
-- implementado en rendio-turnos (PWA conductor).
--
-- Contiene:
--   1. Policy: drivers pueden LISTAR vehículos de su organización
--      (antes solo veían vehículos de route_assignments, y para iniciar turno
--      necesitan elegir entre los disponibles).
--   2. Backfill idempotente: driver_profiles para profiles con role='driver'
--      que no lo tengan (los usuarios de turnos seeded ya lo tienen; esto
--      cubre cualquier alta manual previa al Edge Function create-driver).
--   3. start_shift(p_shift_id): SECURITY DEFINER — valida que el conductor sea
--      dueño del shift, que exista inspección inicial y que el vehículo esté
--      libre; activa el shift y marca el vehículo 'in_use'.
--   4. abort_shift(p_shift_id, p_reason): SECURITY DEFINER — cierra el shift
--      sin activarlo (novedad grave en inspección) y deja el vehículo en
--      'maintenance' para revisión del admin.
--
-- SECURITY DEFINER justificado (Arquitectura §7.3): el conductor no tiene (ni
-- debe tener) UPDATE sobre vehicles; la transición de estado del vehículo va
-- encapsulada aquí con validación explícita del actor.
--
-- Idempotente: DROP POLICY IF EXISTS, CREATE OR REPLACE FUNCTION,
-- INSERT ... WHERE NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Drivers pueden listar vehículos de su organización (solo lectura)
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_vehicles_select_driver_org ON public.vehicles;
CREATE POLICY p_vehicles_select_driver_org
  ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'driver'
    AND organization_id = public.current_user_org()
    AND deleted_at IS NULL
  );

-- -----------------------------------------------------------------------------
-- 2. Backfill driver_profiles para conductores sin fila (idempotente)
-- -----------------------------------------------------------------------------

INSERT INTO public.driver_profiles (profile_id)
SELECT p.id
  FROM public.profiles p
 WHERE p.role = 'driver'
   AND p.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.driver_profiles dp WHERE dp.profile_id = p.id
   );

-- -----------------------------------------------------------------------------
-- 3. start_shift — activa el turno tras la inspección inicial
-- -----------------------------------------------------------------------------

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

  UPDATE public.vehicles
     SET status = 'in_use', current_km = GREATEST(current_km, v_shift.opening_km)
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

-- -----------------------------------------------------------------------------
-- 4. abort_shift — novedad grave: no se inicia el turno, vehículo a revisión
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.abort_shift(p_shift_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shift     public.shifts%ROWTYPE;
  v_driver_id uuid;
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
    RAISE EXCEPTION 'INVALID_SHIFT_STATUS: solo se aborta antes de activar (%)', v_shift.status;
  END IF;

  UPDATE public.shifts
     SET status = 'closed',
         end_at = now(),
         notes  = trim(both E' \n' from coalesce(notes || E'\n', '') ||
                  'ABORTADO (novedad grave): ' || coalesce(p_reason, 'sin detalle'))
   WHERE id = v_shift.id;

  -- El vehículo queda fuera de servicio hasta que el admin lo revise.
  UPDATE public.vehicles
     SET status = 'maintenance'
   WHERE id = v_shift.vehicle_id
     AND status NOT IN ('blocked');

  PERFORM public.log_audit_event(
    'shift_aborted', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'reason', p_reason)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed');
END;
$$;

REVOKE ALL ON FUNCTION public.abort_shift(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.abort_shift(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- COMMENTS
-- -----------------------------------------------------------------------------

COMMENT ON FUNCTION public.start_shift(uuid)        IS 'Activa un shift tras la inspección inicial: valida dueño, inspección y vehículo libre; marca vehículo in_use.';
COMMENT ON FUNCTION public.abort_shift(uuid, text)  IS 'Aborta un shift no activado por novedad grave: lo cierra y deja el vehículo en maintenance.';

COMMIT;
