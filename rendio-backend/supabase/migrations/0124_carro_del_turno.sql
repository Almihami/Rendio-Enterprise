-- =============================================================================
-- Migration 0124 — El carro de la vuelta sale del turno del conductor
-- Pedido de la dueña (25-oct-2026, noche): «¿por qué asumes que existe un
-- vehículo? El carro debe salir cuando el conductor haga la inspección, y debe
-- coincidir».
--
-- POR QUÉ
--   · El tablero tomaba los primeros carros de la flota en orden alfabético y les
--     ponía conductor según el horario: el plan decía «HYU376 · Juan» mientras
--     Juan había abierto turno en PRW443 y el HYU376 lo tenía Daniel.
--   · Ahora el plan reparte las vueltas por CONDUCTOR («Carro 1 · Juan»), y la
--     placa se pone sola cuando ese conductor inicia turno (elige carro e
--     inspecciona: shifts.status = 'active').
--
-- QUÉ HACE
--   1. route_assignments.plan_car: el carro del plan («Carro 1»), para rearmar el
--      tablero igual aunque la vuelta todavía no tenga placa.
--   2. route_vehicle_from_shift(conductor, hora) (interna): el carro del turno
--      abierto ('active' o 'closing') de ese conductor que cubre esa hora: desde
--      3 h antes de que lo inicie hasta el cierre automático (auto_close_hours,
--      14 h por defecto).
--   3. Al publicar o cambiar una vuelta (conductor, hora o estado), si su conductor
--      tiene un turno abierto que la cubre, la vuelta queda en ESE carro.
--   4. Cuando un conductor inicia turno (o cambia de carro), sus vueltas sin
--      terminar de esa ventana pasan a ese carro.
--   5. Una vez: las vueltas sin terminar de los turnos que ya están abiertos.
--
-- Lo demás ya aguantaba una vuelta sin carro (0040 dejó vehicle_id opcional; las
-- funciones del tripulante, los avisos y el rastreo lo cruzan con LEFT JOIN).
-- Idempotente. Down: down_migrations/0124_carro_del_turno.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El carro del plan
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS plan_car text;
COMMENT ON COLUMN public.route_assignments.plan_car IS
  'Carro del plan del tablero («Carro 1»), 0124. La placa real (vehicle_id) sale del turno que abre el conductor.';
COMMENT ON COLUMN public.route_assignments.vehicle_id IS
  'Vehículo de la vuelta: el del turno abierto de su conductor (0124). NULL mientras el conductor no ha iniciado turno.';

-- -----------------------------------------------------------------------------
-- 2. El carro del turno que cubre una hora (interna)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_vehicle_from_shift(p_driver uuid, p_at timestamptz)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.vehicle_id
    FROM public.shifts s
   WHERE p_driver IS NOT NULL AND p_at IS NOT NULL
     AND s.driver_id = p_driver
     AND s.status IN ('active', 'closing')
     AND p_at >= s.start_at - interval '3 hours'
     AND p_at <  s.start_at + make_interval(hours => coalesce(
           (SELECT a.auto_close_hours FROM public.app_settings a ORDER BY a.id LIMIT 1), 14))
   ORDER BY s.start_at DESC
   LIMIT 1;
$$;
COMMENT ON FUNCTION public.route_vehicle_from_shift(uuid, timestamptz) IS
  '0124: el carro del turno abierto del conductor que cubre esa hora (3 h antes del inicio → cierre automático), o NULL.';

-- -----------------------------------------------------------------------------
-- 3. Al publicar o cambiar una vuelta
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_assignments_vehicle_from_shift()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v uuid;
BEGIN
  IF NEW.driver_profile_id IS NULL OR NEW.status NOT IN ('draft', 'planned', 'in_progress') THEN
    RETURN NEW;
  END IF;
  v := public.route_vehicle_from_shift(NEW.driver_profile_id, NEW.planned_start_at);
  IF v IS NOT NULL THEN NEW.vehicle_id := v; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_route_assignments_vehicle_from_shift ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_vehicle_from_shift
  BEFORE INSERT OR UPDATE OF driver_profile_id, planned_start_at, status
  ON public.route_assignments
  FOR EACH ROW EXECUTE FUNCTION public.route_assignments_vehicle_from_shift();

-- -----------------------------------------------------------------------------
-- 4. Al iniciar turno (o cambiar de carro)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shifts_vehicle_to_routes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_h int;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active'
     AND OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id
     AND OLD.start_at IS NOT DISTINCT FROM NEW.start_at THEN
    RETURN NULL;
  END IF;
  v_h := coalesce((SELECT a.auto_close_hours FROM public.app_settings a ORDER BY a.id LIMIT 1), 14);
  UPDATE public.route_assignments ra
     SET vehicle_id = NEW.vehicle_id
   WHERE ra.driver_profile_id = NEW.driver_id
     AND ra.status IN ('draft', 'planned', 'in_progress')
     AND ra.planned_start_at >= NEW.start_at - interval '3 hours'
     AND ra.planned_start_at <  NEW.start_at + make_interval(hours => v_h)
     AND ra.vehicle_id IS DISTINCT FROM NEW.vehicle_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_shifts_vehicle_to_routes ON public.shifts;
CREATE TRIGGER tr_shifts_vehicle_to_routes
  AFTER INSERT OR UPDATE OF status, vehicle_id, start_at
  ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.shifts_vehicle_to_routes();

-- -----------------------------------------------------------------------------
-- 5. Una vez: los turnos que ya están abiertos
-- -----------------------------------------------------------------------------
UPDATE public.route_assignments ra
   SET vehicle_id = public.route_vehicle_from_shift(ra.driver_profile_id, ra.planned_start_at)
 WHERE ra.status IN ('draft', 'planned', 'in_progress')
   AND public.route_vehicle_from_shift(ra.driver_profile_id, ra.planned_start_at) IS NOT NULL
   AND ra.vehicle_id IS DISTINCT FROM public.route_vehicle_from_shift(ra.driver_profile_id, ra.planned_start_at);

-- -----------------------------------------------------------------------------
-- 6. Permisos: todo es interno
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.route_vehicle_from_shift(uuid, timestamptz) FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION public.route_assignments_vehicle_from_shift() FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION public.shifts_vehicle_to_routes() FROM PUBLIC, anon, authenticated';
END
$do$;

COMMIT;
