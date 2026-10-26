-- =============================================================================
-- 0132 · El carro del plan («Carro 1 = PRW443») y el aviso si sale en otro
--        (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (lista del 26-oct, URGENTE): «En el apartado de conductores
-- en asignación, que al hacer click en carro 1 o 2, despliegue el listado de
-- carros para uno seleccionar qué carro se le asigna a cada conductor según la
-- programación».
-- La profa decidió (26-oct): si el conductor inspecciona un carro distinto al del
-- plan, MANDA LA INSPECCIÓN (el tripulante ve la placa real, como desde 0124) y a
-- los jefes les llega un aviso.
--
-- QUÉ HACE
--   1. route_assignments.plan_vehicle_id: el carro físico que el plan le pone a
--      «Carro N». No cambia vehicle_id (lo sigue poniendo el turno, 0124) ni lo que
--      ve el tripulante: es la indicación para el conductor (al iniciar turno, ese
--      carro sale primero con «Según el plan») y la referencia para el aviso.
--   2. Disparador en shifts: al quedar el turno 'active' (o cambiar de carro), si
--      alguna vuelta suya de esa ventana (3 h antes → auto_close_hours, la misma de
--      0124) tiene un carro del plan DISTINTO, avisa una vez a los jefes:
--        🚗 Miguel Peña salió en HYU376
--        El plan decía PRW443 para sus vueltas de hoy. Manda la inspección: sus
--        tripulantes ven HYU376.
--   Nunca frena el inicio de turno (EXCEPTION → NOTICE).
--
-- NO SE TOCA ninguna función existente (0124 sigue igual). Depende de 0117
-- (ops_alert_recipients_of), 0097 (trip_notify) y 0125 (short_name).
-- =============================================================================

BEGIN;

ALTER TABLE public.route_assignments
  ADD COLUMN IF NOT EXISTS plan_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.route_assignments.plan_vehicle_id IS
  '0132: el carro físico que el plan le pone a esta vuelta («Carro 1 = PRW443»). Indicación para el conductor; la placa real (vehicle_id) la sigue poniendo el turno (0124). Si inicia turno en otro, se avisa a los jefes.';

CREATE OR REPLACE FUNCTION public.shifts_plan_vehicle_alert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_horas  int;
  v_plan   uuid;
  v_txt_pl text;
  v_txt_re text;
  v_nom    text;
  v_org    uuid;
  j        record;
  v_n      int := 0;
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' OR NEW.vehicle_id IS NULL OR NEW.driver_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id THEN RETURN NULL; END IF;
  BEGIN
    v_horas := coalesce((SELECT auto_close_hours FROM public.app_settings WHERE id = 'singleton'), 14);
    -- El carro del plan de sus vueltas de esta ventana (la primera que lo tenga).
    SELECT ra.plan_vehicle_id INTO v_plan
      FROM public.route_assignments ra
     WHERE ra.driver_profile_id = NEW.driver_id
       AND ra.status IN ('draft', 'planned', 'in_progress')
       AND ra.plan_vehicle_id IS NOT NULL
       AND ra.planned_start_at BETWEEN coalesce(NEW.start_at, now()) - interval '3 hours'
                                   AND coalesce(NEW.start_at, now()) + make_interval(hours => v_horas)
     ORDER BY ra.planned_start_at
     LIMIT 1;
    IF v_plan IS NULL OR v_plan = NEW.vehicle_id THEN RETURN NULL; END IF;

    SELECT coalesce(v.license_plate, v.internal_code) INTO v_txt_pl FROM public.vehicles v WHERE v.id = v_plan;
    SELECT coalesce(v.license_plate, v.internal_code) INTO v_txt_re FROM public.vehicles v WHERE v.id = NEW.vehicle_id;
    SELECT public.short_name(pr.full_name), pr.organization_id INTO v_nom, v_org
      FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = NEW.driver_id;
    v_org := coalesce(NEW.organization_id, v_org);
    IF v_org IS NULL THEN RETURN NULL; END IF;

    FOR j IN SELECT r.profile_id FROM public.ops_alert_recipients_of(v_org) r LOOP
      IF public.trip_notify(j.profile_id, '🚗 ' || coalesce(v_nom, 'Un conductor') || ' salió en ' || coalesce(v_txt_re, 'otro carro'),
           'El plan decía ' || coalesce(v_txt_pl, 'otro carro') || ' para sus vueltas de hoy. Manda la inspección: sus tripulantes ven ' || coalesce(v_txt_re, 'el carro real') || '.',
           '/#/rutas', 'plancar:' || NEW.id::text || ':' || NEW.vehicle_id::text || ':' || j.profile_id::text) THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
    IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'shifts_plan_vehicle_alert: no se armó el aviso del turno % (%)', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.shifts_plan_vehicle_alert() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.shifts_plan_vehicle_alert()
  IS '0132: al quedar activo un turno (o cambiar de carro), si sus vueltas de la ventana tienen un carro del plan distinto, avisa una vez a los jefes («X salió en HYU376 · el plan decía PRW443»). Nunca frena el turno.';

DROP TRIGGER IF EXISTS tr_shifts_plan_vehicle_alert ON public.shifts;
CREATE TRIGGER tr_shifts_plan_vehicle_alert
  AFTER INSERT OR UPDATE OF status, vehicle_id ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.shifts_plan_vehicle_alert();

COMMIT;
