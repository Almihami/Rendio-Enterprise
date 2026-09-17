-- =============================================================================
-- Migration 0041 — Desbloqueo de vehículo por el conductor (aceite pendiente)
--
-- Contexto: cuando un vehículo supera el intervalo de cambio de aceite, al cerrar
-- el turno el trigger shifts_close_block_vehicle (0016) lo deja en 'blocked' y
-- SOLO el admin podía liberarlo (return_vehicle_to_service, 0031), reiniciando el
-- contador.
--
-- Solicitud de los jefes: darle al CONDUCTOR una válvula de escape para poder
-- seguir operando, PERO:
--   · asumiendo la responsabilidad (advertencia en la app antes de desbloquear),
--   · SIN reiniciar el contador (el aceite sigue sin cambiarse), y
--   · notificando al administrador (alerta en panel + push).
-- El desbloqueo es PERSISTENTE: el carro queda usable (no se re-bloquea al cerrar)
-- hasta que el admin registre el cambio de aceite.
--
-- Esta migración agrega:
--   1. Columnas vehicles.oil_override_at / oil_override_by (marca del desbloqueo).
--   2. shifts_close_block_vehicle: no re-bloquea si hay override activo.
--   3. driver_override_oil_block(p_vehicle_id) — el conductor libera el carro
--      bajo su responsabilidad; devuelve los IDs de admin para el push.
--   4. register_oil_change(p_vehicle_id) — el admin registra el cambio de aceite:
--      reinicia contador, limpia el override y deja registro. Funciona esté el
--      carro 'blocked' o disponible-por-override.
--
-- SECURITY DEFINER justificado (Arquitectura §7.3): ni conductor ni admin tienen
-- UPDATE directo sobre vehicles; la transición va encapsulada con validación
-- explícita de rol y organización del actor.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Marca del desbloqueo por conductor
-- -----------------------------------------------------------------------------
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS oil_override_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS oil_override_by uuid NULL
    REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.vehicles.oil_override_at
  IS 'Si no es NULL: un conductor desbloqueó el carro bajo su responsabilidad pese a tener cambio de aceite pendiente. El admin lo limpia al registrar el cambio (register_oil_change).';
COMMENT ON COLUMN public.vehicles.oil_override_by
  IS 'Perfil del conductor que desbloqueó el carro con aceite pendiente.';

-- -----------------------------------------------------------------------------
-- 2) El trigger de cierre NO re-bloquea un carro con override activo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shifts_close_block_vehicle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_km        int;
  v_last_maint_km     int;
  v_interval_km       int;
  v_override_at       timestamptz;
BEGIN
  -- Solo nos interesa la transición a 'closed'
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  -- Si el shift trae closing_km, actualizamos el vehículo (la fuente de verdad
  -- queda en vehicles.current_km).
  IF NEW.closing_km IS NOT NULL THEN
    UPDATE public.vehicles
       SET current_km = GREATEST(current_km, NEW.closing_km)
     WHERE id = NEW.vehicle_id;
  END IF;

  SELECT current_km, last_maintenance_km, maintenance_interval_km, oil_override_at
    INTO v_current_km, v_last_maint_km, v_interval_km, v_override_at
    FROM public.vehicles
   WHERE id = NEW.vehicle_id;

  IF v_current_km IS NULL THEN
    RETURN NEW;
  END IF;

  -- Si un conductor ya asumió la responsabilidad (override activo), NO re-bloquear:
  -- el carro queda usable hasta que el admin registre el cambio de aceite.
  IF v_override_at IS NULL AND (v_current_km - v_last_maint_km) >= v_interval_km THEN
    UPDATE public.vehicles
       SET status = 'blocked'
     WHERE id = NEW.vehicle_id
       AND status <> 'blocked';
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3) El conductor desbloquea el carro bajo su responsabilidad
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_override_oil_block(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_vehicle   public.vehicles%ROWTYPE;
  v_uid       uuid := auth.uid();
  v_org       uuid := public.current_user_org();
  v_admins    uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;
  IF v_vehicle.organization_id <> v_org THEN
    RAISE EXCEPTION 'WRONG_ORG';
  END IF;

  -- Solo aplica al bloqueo por cambio de aceite ('blocked'). El 'maintenance'
  -- (NO APTO) NO lo puede levantar el conductor: eso es una falla real del carro.
  IF v_vehicle.status <> 'blocked' THEN
    RAISE EXCEPTION 'NOT_OIL_BLOCK: solo se puede desbloquear un carro detenido por cambio de aceite';
  END IF;

  -- Sanidad: confirmar que efectivamente está vencido por km.
  IF (COALESCE(v_vehicle.current_km, 0) - COALESCE(v_vehicle.last_maintenance_km, 0))
       < COALESCE(v_vehicle.maintenance_interval_km, 7000) THEN
    RAISE EXCEPTION 'NOT_DUE: el vehículo no está vencido por cambio de aceite';
  END IF;

  -- Libera el carro SIN reiniciar el contador (el aceite sigue pendiente) y deja
  -- la marca del override para que el trigger de cierre no lo vuelva a bloquear.
  UPDATE public.vehicles
     SET status          = 'available',
         oil_override_at = now(),
         oil_override_by = v_uid
   WHERE id = v_vehicle.id;

  INSERT INTO public.maintenance
    (organization_id, vehicle_id, performed_by, maintenance_type, km_at_event, notes)
  VALUES
    (v_vehicle.organization_id, v_vehicle.id, v_uid, 'Desbloqueo por conductor (aceite pendiente)',
     COALESCE(v_vehicle.current_km, 0),
     'El conductor asumió la responsabilidad de operar con el cambio de aceite pendiente.');

  PERFORM public.log_audit_event(
    'vehicle_oil_override', 'vehicle', v_vehicle.id,
    jsonb_build_object('by', v_uid, 'current_km', v_vehicle.current_km,
                       'last_maintenance_km', v_vehicle.last_maintenance_km)
  );

  -- Admins de la organización → destinatarios del push (el cliente lo dispara).
  SELECT COALESCE(array_agg(id), '{}') INTO v_admins
    FROM public.profiles
   WHERE role = 'admin'
     AND organization_id = v_org
     AND COALESCE(is_active, true) = true
     AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'vehicle_id', v_vehicle.id,
    'vehicle_label', COALESCE(v_vehicle.internal_code, v_vehicle.license_plate),
    'status', 'available',
    'admin_ids', to_jsonb(v_admins)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.driver_override_oil_block(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_override_oil_block(uuid) TO authenticated;

COMMENT ON FUNCTION public.driver_override_oil_block(uuid)
  IS 'El conductor desbloquea un carro detenido por cambio de aceite (blocked → available) SIN reiniciar el contador, marcando el override para que no se re-bloquee. Devuelve admin_ids para el push. SECURITY DEFINER.';

-- -----------------------------------------------------------------------------
-- 4) El admin registra el cambio de aceite (cierra el ciclo)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_oil_change(p_vehicle_id uuid, p_reason text DEFAULT NULL)
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
    RAISE EXCEPTION 'NOT_ADMIN: solo el administrador puede registrar el cambio de aceite';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;
  IF v_vehicle.organization_id <> v_org THEN
    RAISE EXCEPTION 'WRONG_ORG';
  END IF;

  -- Reinicia el contador, limpia el override y, si estaba detenido por aceite,
  -- lo regresa a servicio. Si está 'in_use' (turno en curso) se conserva el
  -- estado y solo se reinicia el contador. 'maintenance' (NO APTO) no se libera.
  UPDATE public.vehicles
     SET last_maintenance_km = current_km,
         oil_override_at     = NULL,
         oil_override_by     = NULL,
         status              = CASE WHEN status = 'blocked' THEN 'available' ELSE status END
   WHERE id = v_vehicle.id;

  INSERT INTO public.maintenance
    (organization_id, vehicle_id, performed_by, maintenance_type, km_at_event, notes)
  VALUES
    (v_vehicle.organization_id, v_vehicle.id, v_uid, 'Cambio de aceite',
     COALESCE(v_vehicle.current_km, 0),
     COALESCE(p_reason, 'Cambio de aceite registrado desde Ajustes'));

  PERFORM public.log_audit_event(
    'vehicle_oil_change_registered', 'vehicle', v_vehicle.id,
    jsonb_build_object('by', v_uid, 'km_at_event', v_vehicle.current_km,
                       'was_override', (v_vehicle.oil_override_at IS NOT NULL))
  );

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id,
                            'status', (CASE WHEN v_vehicle.status = 'blocked' THEN 'available' ELSE v_vehicle.status END));
END;
$fn$;

REVOKE ALL ON FUNCTION public.register_oil_change(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_oil_change(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.register_oil_change(uuid, text)
  IS 'Admin registra el cambio de aceite: reinicia el contador (last_maintenance_km = current_km), limpia el override del conductor y regresa a servicio si estaba blocked. SECURITY DEFINER, valida rol admin + organización.';

COMMIT;
