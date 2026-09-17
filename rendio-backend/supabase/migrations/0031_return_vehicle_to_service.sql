-- =============================================================================
-- Migration 0031 — Regresar un vehículo a servicio (módulo rendio-turnos)
--
-- Problema (bug reportado por usuarios en prod): vehículos que quedaban fuera de
-- servicio sin forma de recuperarlos desde la app:
--   - 'maintenance': lo deja abort_shift (0022) cuando el conductor marca NO APTO.
--   - 'blocked':     lo deja el trigger shifts_close_block_vehicle (0016) cuando
--                    se supera el intervalo de mantenimiento al cerrar un turno.
-- El panel Ajustes→Vehículos solo permitía VER el estado y ELIMINAR; no había
-- cómo regresar el carro a 'available'. (Los 'in_use' colgados ya se liberan con
-- force_close_shift, 0027.)
--
-- Esta migración agrega:
--   return_vehicle_to_service(p_vehicle_id, p_reason) — SECURITY DEFINER, solo
--   admin de la organización: maintenance/blocked → available.
--     · Si venía 'blocked' (mantenimiento por km): además reinicia el contador
--       (last_maintenance_km = current_km) para que no se vuelva a bloquear en el
--       próximo cierre, y deja registro en maintenance.
--     · Si venía 'maintenance' (p.ej. NO APTO): solo reactiva, sin tocar el km.
--   Rechaza si el vehículo tiene un turno activo/closing (ciérralo primero).
--
-- SECURITY DEFINER justificado (Arquitectura §7.3): el admin no tiene UPDATE
-- directo sobre vehicles; la transición de estado va encapsulada con validación
-- explícita del rol y la organización del actor.
--
-- Idempotente: CREATE OR REPLACE FUNCTION; si el vehículo ya está available, noop.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.return_vehicle_to_service(p_vehicle_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_vehicle public.vehicles%ROWTYPE;
  v_uid     uuid := auth.uid();
  v_org     uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN: solo el administrador puede regresar un vehículo a servicio';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;
  IF v_vehicle.organization_id <> v_org THEN
    RAISE EXCEPTION 'WRONG_ORG';
  END IF;

  -- Solo aplica a vehículos fuera de servicio; si ya está disponible, noop.
  IF v_vehicle.status NOT IN ('maintenance', 'blocked') THEN
    RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id, 'status', v_vehicle.status, 'noop', true);
  END IF;

  -- No liberar un carro que alguien está usando ahora mismo.
  IF EXISTS (
    SELECT 1 FROM public.shifts s
     WHERE s.vehicle_id = v_vehicle.id
       AND s.status IN ('active', 'closing')
  ) THEN
    RAISE EXCEPTION 'VEHICLE_HAS_ACTIVE_SHIFT: hay un turno en curso; ciérralo primero en Turnos activos';
  END IF;

  IF v_vehicle.status = 'blocked' THEN
    -- Bloqueo por intervalo de mantenimiento: el admin confirma que ya se atendió
    -- → reiniciamos el contador y dejamos registro de mantenimiento.
    UPDATE public.vehicles
       SET status = 'available',
           last_maintenance_km = current_km
     WHERE id = v_vehicle.id;

    INSERT INTO public.maintenance
      (organization_id, vehicle_id, performed_by, maintenance_type, km_at_event, notes)
    VALUES
      (v_vehicle.organization_id, v_vehicle.id, v_uid, 'Regreso a servicio (mantenimiento)',
       COALESCE(v_vehicle.current_km, 0),
       COALESCE(p_reason, 'Regreso a servicio desde Ajustes'));
  ELSE
    -- 'maintenance' (p.ej. NO APTO): solo reactivar, sin tocar el contador de km.
    UPDATE public.vehicles
       SET status = 'available'
     WHERE id = v_vehicle.id;
  END IF;

  PERFORM public.log_audit_event(
    'vehicle_returned_to_service', 'vehicle', v_vehicle.id,
    jsonb_build_object('from_status', v_vehicle.status, 'reason', p_reason, 'by', v_uid)
  );

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id, 'status', 'available');
END;
$fn$;

REVOKE ALL ON FUNCTION public.return_vehicle_to_service(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_vehicle_to_service(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.return_vehicle_to_service(uuid, text)
  IS 'Admin regresa un vehículo a servicio (maintenance/blocked → available). Si venía blocked reinicia el contador de mantto y registra maintenance. SECURITY DEFINER, valida rol admin + organización.';

COMMIT;
