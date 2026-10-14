-- =============================================================================
-- 0105 · LA INSPECCIÓN DIFERIDA SE PUEDE HACER AL CERRAR EL TURNO
--
-- POR QUÉ. La dueña (12-oct-2026): «Que puedan hacer la inspección al finalizar
-- el turno en la noche». El inicio rápido (0039) deja arrancar sin inspección,
-- pero con un plazo fijo en minutos (90 por defecto). El de la tarde arranca a
-- las 2 p.m. con los tripulantes esperando y termina pasada la medianoche: la
-- inspección le cabe tranquila en el parqueadero, al cerrar, y no a los 90
-- minutos en plena ruta.
--
-- QUÉ CAMBIA:
--   1. app_settings.fast_start_deadline — el plazo de la inspección diferida:
--        'minutes'     → inspection_grace_minutes después de iniciar (lo de siempre).
--        'shift_close' → al cerrar el turno.
--   2. shifts.inspection_at_close — con qué regla arrancó CADA turno. Se guarda
--      en el turno y no se lee de Ajustes: si el jefe cambia el modo con gente en
--      ruta, cada uno sigue con la regla que se le dijo al arrancar.
--   3. fast_start_window_open(hora, desde, hasta) — la franja puede cruzar la
--      medianoche (14 a 2 = de 2 p.m. a 1:59 a.m.). Con desde < hasta es
--      exactamente la regla de antes; desde = hasta sigue siendo «nunca» (0 a 24
--      es todo el día). Antes desde > hasta era una franja muerta.
--   4. start_shift_deferred — en 'shift_close' marca el turno y deja en
--      inspection_due_at la hora a la que el turno se cerraría solo
--      (auto_close_hours). Ese valor solo dice «la inspección está pendiente»:
--      la app vieja (o la tarjeta) lo sigue entendiendo, y no castiga a nadie.
--   5. process_pending_inspections — con 'minutes', idéntico a 0039. Con
--      'shift_close', NO castiga mientras el turno siga abierto; castiga cuando
--      el turno quedó cerrado sin la inspección, lo haya cerrado quien lo haya
--      cerrado (el conductor con una app vieja, un admin o el auto-cierre). Así
--      el auto-cierre queda igual que el vencimiento en minutos: sin inspección,
--      strike. Cae en la siguiente vuelta del cron (cada 10 min).
--
-- QUÉ NO CAMBIA: close_shift, force_close_shift y auto_close_stale_shifts no se
-- tocan. Que el conductor haga la inspección antes de cerrar lo pide la app
-- (shift-flow.js); la base no se niega a cerrar: castiga, como con los minutos.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Parámetro + columna del turno
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS fast_start_deadline text NOT NULL DEFAULT 'minutes';
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_fast_start_deadline_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_fast_start_deadline_check
  CHECK (fast_start_deadline IN ('minutes', 'shift_close'));
COMMENT ON COLUMN public.app_settings.fast_start_deadline
  IS 'Plazo de la inspección diferida: minutes = inspection_grace_minutes después de iniciar; shift_close = al cerrar el turno (0105).';

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS inspection_at_close boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.shifts.inspection_at_close
  IS 'El turno arrancó con inspección diferida AL CERRAR (0105). inspection_due_at queda en la hora del auto-cierre y solo marca «pendiente»; el strike llega si se cierra sin inspección.';
COMMENT ON COLUMN public.shifts.inspection_due_at
  IS 'Si el turno inició con inspección diferida: fecha límite para hacerla. Con inspection_at_close (0105) es solo la marca de pendiente (hora del auto-cierre).';

-- -----------------------------------------------------------------------------
-- 2. La franja, que puede cruzar la medianoche
-- -----------------------------------------------------------------------------
-- «desde» incluida, «hasta» sin incluir, en horas de Bogotá (0–23 y 1–24).
CREATE OR REPLACE FUNCTION public.fast_start_window_open(p_hour int, p_from int, p_to int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_from < p_to THEN p_hour >= p_from AND p_hour < p_to   -- la de siempre
    WHEN p_from > p_to THEN p_hour >= p_from OR p_hour < p_to    -- cruza la medianoche
    ELSE false                                                    -- desde = hasta: vacía
  END;
$fn$;
COMMENT ON FUNCTION public.fast_start_window_open(int, int, int)
  IS 'Franja del inicio rápido: [desde, hasta) en horas; si desde > hasta cruza la medianoche (0105).';

-- -----------------------------------------------------------------------------
-- 3. start_shift_deferred — misma firma, ahora con los dos modos
-- -----------------------------------------------------------------------------
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
  v_at_close       boolean;
  v_close_hours    int;
  v_hour           int;
  v_due            timestamptz;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile'; END IF;

  SELECT COALESCE(fast_start_enabled, true), COALESCE(fast_start_from_hour, 12),
         COALESCE(fast_start_to_hour, 16), COALESCE(inspection_grace_minutes, 90),
         COALESCE(fast_start_deadline, 'minutes') = 'shift_close', COALESCE(auto_close_hours, 14)
    INTO v_enabled, v_from, v_to, v_grace, v_at_close, v_close_hours
    FROM public.app_settings WHERE id = 'singleton';
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAST_START_DISABLED: el inicio diferido no está habilitado';
  END IF;

  -- Ventana validada con la HORA DEL SERVIDOR (Bogotá) → no se burla con el celular.
  v_hour := extract(hour FROM (now() AT TIME ZONE 'America/Bogota'))::int;
  IF NOT public.fast_start_window_open(v_hour, v_from, v_to) THEN
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

  -- Al cerrar: la marca de pendiente es la hora del auto-cierre (el último
  -- momento en que el turno puede seguir abierto). En minutos: el plazo de 0039.
  v_due := now() + CASE WHEN v_at_close THEN make_interval(hours => v_close_hours)
                        ELSE make_interval(mins => v_grace) END;

  UPDATE public.shifts
     SET status = 'active', start_at = now(), opening_km = p_opening_km,
         inspection_due_at = v_due, inspection_at_close = v_at_close
   WHERE id = v_shift.id;

  UPDATE public.vehicles
     SET status = 'in_use',
         current_km = GREATEST(current_km, p_opening_km),
         last_maintenance_km = CASE WHEN COALESCE(last_maintenance_km, 0) = 0 THEN GREATEST(current_km, p_opening_km) ELSE last_maintenance_km END
   WHERE id = v_shift.vehicle_id;

  PERFORM public.log_audit_event(
    'shift_started_deferred', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'opening_km', p_opening_km,
                       'inspection_due_at', v_due, 'inspection_at_close', v_at_close)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'active',
                            'inspection_due_at', v_due, 'inspection_at_close', v_at_close);
END;
$fn$;
REVOKE ALL ON FUNCTION public.start_shift_deferred(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_shift_deferred(uuid, int) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. process_pending_inspections — minutos como siempre; al cerrar, tras cerrar
-- -----------------------------------------------------------------------------
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
  -- a) Plazo en minutos (0039, sin cambios): turno activo, plazo vencido.
  FOR v_shift IN
    SELECT * FROM public.shifts s
     WHERE s.status = 'active'
       AND NOT s.inspection_at_close
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

  -- b) Al cerrar el turno (0105): mientras esté abierto no se toca. Cerrado
  --    —por el conductor, un admin o el auto-cierre— sin inspección → strike.
  FOR v_shift IN
    SELECT * FROM public.shifts s
     WHERE s.status = 'closed'
       AND s.inspection_at_close
       AND s.inspection_due_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.inspections i WHERE i.shift_id = s.id AND i.kind = 'initial')
     FOR UPDATE
  LOOP
    SELECT profile_id INTO v_profile FROM public.driver_profiles WHERE id = v_shift.driver_id;
    IF v_profile IS NOT NULL THEN
      INSERT INTO public.driver_strikes (profile_id, reason)
      VALUES (v_profile, 'El turno se cerró sin la inspección pendiente');
    END IF;
    UPDATE public.shifts
       SET inspection_due_at = NULL,
           notes = trim(both E' \n' from coalesce(v_shift.notes || E'\n', '') || 'INSPECCIÓN NO HECHA AL CERRAR: strike automático.')
     WHERE id = v_shift.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;
REVOKE ALL ON FUNCTION public.process_pending_inspections() FROM PUBLIC;

COMMIT;
