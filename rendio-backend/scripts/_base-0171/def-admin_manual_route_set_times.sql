CREATE OR REPLACE FUNCTION public.admin_manual_route_set_times(p_route uuid, p_stops jsonb DEFAULT '[]'::jsonb, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_deadline timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org      uuid := public.current_user_org();
  ra         public.route_assignments;
  s          jsonb;
  v_sid      uuid;
  v_at       timestamptz;
  v_ok       int;
  v_antes    timestamptz;     -- la hora de la vuelta antes del cambio
  v_previas  jsonb;           -- { stop_id: hora } antes del cambio
  v_dead0    timestamptz;
  v_dead     timestamptz;
  v_start    timestamptz;
  v_ultima   timestamptz;
  v_cambio   boolean := false;
  v_sello    text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n        int := 0;
  v_drv      uuid;
  v_donde    text;
  c          record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe cambia la hora de una vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  IF ra.id IS NULL OR NOT ra.pool OR ra.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Esa vuelta no es de la ruta de Julián' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status NOT IN ('draft', 'planned')
     OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: ya no se le cambia la hora' USING ERRCODE = 'P0001';
  END IF;
  IF p_stops IS NULL OR jsonb_typeof(p_stops) <> 'array' THEN p_stops := '[]'::jsonb; END IF;

  -- Lo de antes, para avisar solo a quien le cambió algo.
  SELECT coalesce(jsonb_object_agg(rs.id::text, rs.estimated_arrival_at), '{}'::jsonb) INTO v_previas
    FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;
  v_antes := ra.planned_start_at;
  v_dead0 := ra.deadline_at;

  IF ra.direction = 'home_to_airport' THEN
    FOR s IN SELECT * FROM jsonb_array_elements(p_stops) LOOP
      v_sid := nullif(s->>'stop_id', '')::uuid;
      v_at := nullif(s->>'at', '')::timestamptz;
      IF v_sid IS NULL OR v_at IS NULL THEN
        RAISE EXCEPTION 'Falta la hora de una parada' USING ERRCODE = '22023';
      END IF;
      UPDATE public.route_stops SET estimated_arrival_at = v_at WHERE id = v_sid AND route_assignment_id = ra.id;
      GET DIAGNOSTICS v_ok = ROW_COUNT;
      IF v_ok = 0 THEN RAISE EXCEPTION 'Esa parada no es de esta vuelta' USING ERRCODE = 'P0002'; END IF;
    END LOOP;
    SELECT min(rs.estimated_arrival_at), max(rs.estimated_arrival_at) INTO v_start, v_ultima
      FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;
    v_start := coalesce(v_start, ra.planned_start_at);
    v_dead := coalesce(p_deadline, ra.deadline_at);
    IF v_dead IS NOT NULL AND v_ultima IS NOT NULL AND v_dead < v_ultima THEN
      RAISE EXCEPTION '«Deben estar» (%) queda antes de la última recogida (%)', public.hm_bog(v_dead), public.hm_bog(v_ultima)
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_start IS NULL THEN RAISE EXCEPTION 'Falta la hora de salida' USING ERRCODE = '22023'; END IF;
    v_start := p_start;
    v_dead := ra.deadline_at;
  END IF;

  v_cambio := v_start IS DISTINCT FROM v_antes OR v_dead IS DISTINCT FROM v_dead0
    OR EXISTS (SELECT 1 FROM public.route_stops rs
                WHERE rs.route_assignment_id = ra.id AND rs.estimated_arrival_at IS DISTINCT FROM (v_previas->>rs.id::text)::timestamptz);
  IF NOT v_cambio THEN
    RETURN jsonb_build_object('id', ra.id, 'unchanged', true, 'start', ra.planned_start_at, 'notified', 0);
  END IF;

  UPDATE public.route_assignments SET planned_start_at = v_start, deadline_at = v_dead, updated_at = now() WHERE id = ra.id;
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  -- Los tripulantes a los que les cambió la hora (o el «Deben estar», que va en el aviso).
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at, r.reserve_place,
           (v_previas->>rs.id::text)::timestamptz IS DISTINCT FROM rs.estimated_arrival_at AS movida
      FROM public.route_stops rs
      JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    IF ra.direction = 'home_to_airport' THEN
      CONTINUE WHEN NOT c.movida AND v_dead IS NOT DISTINCT FROM v_dead0;
      IF public.trip_notify(c.crew, 'Cambió tu hora de recogida 🕒',
           'Ahora te recogemos a las ' || public.hm_bog(c.at)
             || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END || '.',
           '/#/viaje?r=' || c.id::text, 'manualhora:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
        v_n := v_n + 1;
      END IF;
    ELSE
      CONTINUE WHEN v_start IS NOT DISTINCT FROM v_antes;
      -- 0121: de reserva en un hotel o en el aeropuerto; si no, viene en un vuelo.
      v_donde := public.lugar_del_regreso(c.id);   -- 0147: también el personal de tierra
      IF public.trip_notify(c.crew, 'Cambió la hora de tu regreso 🕒',
           CASE WHEN v_donde IS NOT NULL THEN 'Te recogemos ' || v_donde || ' hacia las ' || public.hm_bog(v_start) || '.'
                ELSE 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || ').' END,
           '/#/viaje?r=' || c.id::text, 'manualhora:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;

  -- El conductor que la tomó (la delegada no tiene: la hace alguien de afuera).
  SELECT dp.profile_id INTO v_drv FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
  IF v_drv IS NOT NULL AND v_start IS DISTINCT FROM v_antes THEN
    PERFORM public.trip_notify(v_drv, 'Cambió la hora de una vuelta que tomaste 🕒',
      CASE WHEN ra.direction = 'home_to_airport' THEN 'La salida' ELSE 'La llegada' END
        || ' de las ' || public.hm_bog(v_antes) || ' ahora es a las ' || public.hm_bog(v_start) || '. Revísala en Ruta.',
      '/#/ruta', 'manualhora:' || ra.id::text || ':drv:' || v_drv::text || ':' || v_sello);
  ELSIF v_drv IS NOT NULL THEN
    PERFORM public.trip_notify(v_drv, 'Cambió una vuelta que tomaste 🕒',
      'Julián cambió las horas de la ' || CASE WHEN ra.direction = 'home_to_airport' THEN 'salida' ELSE 'llegada' END
        || ' de las ' || public.hm_bog(v_start) || '. Revísala en Ruta.',
      '/#/ruta', 'manualhora:' || ra.id::text || ':drv:' || v_drv::text || ':' || v_sello);
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'start', v_start, 'deadline', v_dead, 'notified', v_n,
    'driver_notified', v_drv IS NOT NULL);
END;
$function$
