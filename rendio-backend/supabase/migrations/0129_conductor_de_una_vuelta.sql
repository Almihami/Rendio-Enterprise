-- =============================================================================
-- 0129 · Cambiar el conductor de UNA vuelta publicada, sin re-publicar el día
--        (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (lista del 26-oct, URGENTE): «Cuando se cambie un conductor
-- asignado a una ruta, que salga la opción de guardar y publicar, esto para que el
-- sistema no afecte todo el itinerario completo».
--
-- EL HUECO. Desde el 26-oct (SW v211) «Cambiar» en Asignación pone el conductor de
-- una sola vuelta, pero solo en el tablero: para que llegue hay que «Publicar plan»,
-- y saveRoutePlan BORRA y vuelve a crear todas las vueltas del día que no han
-- arrancado. Ese 26-oct a las 9:00 eso tardó 17 s, el detector cayó en el hueco y
-- salieron 59 avisos de «no tiene carro» a los jefes (lo arregla 0127 por su lado).
--
-- LO QUE HACE. admin_route_set_driver(vuelta, conductor | NULL) cambia SOLO esa fila
-- de route_assignments y avisa SOLO a quien le cambia algo:
--   · el conductor nuevo  → «Te asignaron una vuelta 🗺️»
--   · el que la tenía     → «Ya no haces una vuelta»
--   · sus tripulantes     → «Te cambiamos el conductor 🔄» (tenía otro) o
--                           «<Nombre> te recoge 🚗» (no tenía, o era delegada)
-- Con conductor queda 'planned'; sin conductor, la del tablero vuelve a 'draft'
-- (como la guarda saveRoutePlan) y la pegada por Julián (pool) vuelve a la lista
-- de «Vueltas para tomar». Poner conductor a una delegada la deja de delegar. La
-- placa la pone el turno del conductor (disparador de 0124). Las reservas pasan a
-- «asignada» o vuelven a «pedida» con route_sync_assigned, y la hora de recogida
-- con sync_calculated_pickup, igual que al delegar (0126).
--
-- Reglas: solo jefes de la organización de la vuelta; una vuelta que ya arrancó
-- (alguna parada atendida o en curso) no se cambia por aquí — para eso está el
-- tablero, que mueve solo lo pendiente; el conductor debe ser de la organización.
--
-- Sirve también para que el jefe le asigne una vuelta de la ruta de Julián a un
-- conductor (pedido 8 de la misma lista): queda tomada y deja de salir en la
-- lista de los demás.
--
-- NO SE TOCA ninguna función existente. Depende de 0124, 0125 y 0126.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_route_set_driver(p_route uuid, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid := public.current_user_org();
  ra         public.route_assignments;
  v_prev_dp  uuid;
  v_prev     uuid;    -- perfil del conductor que la tenía
  v_new      uuid;    -- perfil del conductor nuevo
  v_nombre   text;
  v_pl       text;
  v_deleg    boolean;
  v_hora     text;
  v_pax      int;
  v_sello    text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n        int := 0;
  c          record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe cambia el conductor de una vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  -- coalesce: una vuelta del tablero no trae organization_id (NULL) y «NULL = org»
  -- no es falso: sin él, un jefe de OTRA organización pasaba esta guarda.
  IF ra.id IS NULL OR NOT (coalesce(ra.organization_id = v_org, false) OR EXISTS (
       SELECT 1 FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
       JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
        WHERE rs.route_assignment_id = ra.id AND pr.organization_id = v_org)) THEN
    RAISE EXCEPTION 'Esa vuelta no existe' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status NOT IN ('draft', 'planned')
     OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: cámbiala en el tablero y publica' USING ERRCODE = 'P0001';
  END IF;
  IF p_driver IS NOT NULL THEN
    SELECT dp.profile_id, pr.full_name INTO v_new, v_nombre
      FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id
     WHERE dp.id = p_driver AND pr.organization_id = v_org AND pr.deleted_at IS NULL;
    IF v_new IS NULL THEN RAISE EXCEPTION 'Ese conductor no existe' USING ERRCODE = 'P0002'; END IF;
  END IF;

  v_deleg := ra.delegated_at IS NOT NULL;
  IF ra.driver_profile_id IS NOT DISTINCT FROM p_driver AND NOT (p_driver IS NOT NULL AND v_deleg) THEN
    RETURN jsonb_build_object('id', ra.id, 'driver_profile_id', ra.driver_profile_id, 'unchanged', true);
  END IF;
  v_prev_dp := ra.driver_profile_id;
  SELECT dp.profile_id INTO v_prev FROM public.driver_profiles dp WHERE dp.id = v_prev_dp;

  UPDATE public.route_assignments
     SET driver_profile_id = p_driver,
         delegated_at = CASE WHEN p_driver IS NOT NULL THEN NULL ELSE delegated_at END,
         delegated_by = CASE WHEN p_driver IS NOT NULL THEN NULL ELSE delegated_by END,
         status = CASE WHEN p_driver IS NOT NULL OR pool OR delegated_at IS NOT NULL THEN 'planned' ELSE 'draft' END,
         -- La placa era la del turno del anterior: se borra y el disparador de 0124
         -- pone la del turno del nuevo (si ya lo abrió; si no, «por confirmar»).
         vehicle_id = NULL,
         updated_at = now()
   WHERE id = ra.id;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route;   -- con la placa de su turno (0124)

  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  SELECT public.hm_bog(CASE WHEN ra.direction = 'airport_to_home' THEN coalesce(ra.planned_start_at, min(rs.estimated_arrival_at))
                            ELSE coalesce(min(rs.estimated_arrival_at), ra.planned_start_at) END),
         count(*) FILTER (WHERE r.cancelled_at IS NULL)
    INTO v_hora, v_pax
    FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
   WHERE rs.route_assignment_id = ra.id;

  -- Los tripulantes, solo si ahora tienen conductor (sin conductor no hay nada nuevo
  -- que decirles: la pantalla les muestra «por confirmar»).
  IF v_new IS NOT NULL THEN
    FOR c IN
      SELECT r.id, ap.profile_id AS crew, r.calculated_pickup_at AS at
        FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
       WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
    LOOP
      IF public.trip_notify(c.crew,
           CASE WHEN v_prev IS NOT NULL THEN 'Te cambiamos el conductor 🔄'
                ELSE public.short_name(v_nombre) || ' te recoge 🚗' END,
           CASE WHEN ra.direction = 'home_to_airport'
                THEN CASE WHEN v_prev IS NOT NULL THEN 'Ahora te recoge ' || public.short_name(v_nombre) ELSE 'Te recoge' END
                     || coalesce(' a las ' || public.hm_bog(c.at), '') || coalesce(' en el carro ' || v_pl, '') || '.'
                ELSE CASE WHEN v_prev IS NOT NULL THEN 'Ahora te espera ' || public.short_name(v_nombre) ELSE 'Te espera' END
                     || ' en JMC cuando aterrices' || coalesce(' (carro ' || v_pl || ')', '') || '.' END,
           '/#/viaje?r=' || c.id::text, 'setdrv:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
    PERFORM public.trip_notify(v_new, 'Te asignaron una vuelta 🗺️',
      CASE WHEN ra.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END || coalesce(' de las ' || v_hora, '')
        || ' · ' || v_pax || CASE WHEN v_pax = 1 THEN ' tripulante' ELSE ' tripulantes' END || '. Ábrela en Inicio › Tu día.',
      '/', 'setdrv:' || ra.id::text || ':new:' || v_new::text || ':' || v_sello);
  END IF;
  IF v_prev IS NOT NULL THEN
    PERFORM public.trip_notify(v_prev, 'Ya no haces una vuelta',
      'Coordinación le pasó la vuelta de las ' || coalesce(v_hora, '?') || ' a otro conductor.',
      '/', 'setdrv:' || ra.id::text || ':old:' || v_prev::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'driver_profile_id', ra.driver_profile_id, 'status', ra.status,
    'vehicle_id', ra.vehicle_id, 'plate', v_pl, 'notified', v_n, 'was_delegated', v_deleg AND p_driver IS NOT NULL,
    'prev_driver', v_prev_dp);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_route_set_driver(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_route_set_driver(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_route_set_driver(uuid, uuid)
  IS '0129: el jefe cambia el conductor de UNA vuelta publicada (o la deja sin conductor) sin re-publicar el día. Avisa al conductor nuevo, al anterior y a sus tripulantes. Solo vueltas que no han arrancado.';

COMMIT;
