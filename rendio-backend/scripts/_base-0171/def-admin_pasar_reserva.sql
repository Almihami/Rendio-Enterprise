CREATE OR REPLACE FUNCTION public.admin_pasar_reserva(p_reservation uuid, p_route uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org   uuid := public.current_user_org();
  r       record;
  ra      public.route_assignments;
  o       record;
  v_lle   boolean;
  v_eta   timestamptz;
  v_who   text;
  v_lugar text;
  v_drv   uuid;  v_drv_name text;
  v_from  timestamptz; v_quedo_vacia boolean := false;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_pax   int;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe pasa a alguien de vuelta' USING ERRCODE = '42501';
  END IF;
  SELECT res.id, res.direction, res.cancelled_at, ap.profile_id AS crew, pr.full_name AS nombre,
         rz.name AS conjunto, res.pickup_address
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    LEFT JOIN public.residences rz   ON rz.id = res.residence_id
   WHERE res.id = p_reservation AND pr.organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Ese pedido no existe' USING ERRCODE = 'P0002'; END IF;
  IF r.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Ese pedido está cancelado' USING ERRCODE = 'P0001'; END IF;
  v_lle := r.direction = 'airport_to_home';
  v_who := public.short_name(r.nombre);
  v_lugar := coalesce(r.conjunto, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''));

  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route FOR UPDATE;
  IF ra.id IS NULL OR NOT (coalesce(ra.organization_id = v_org, false) OR EXISTS (
       SELECT 1 FROM public.route_stops rs JOIN public.reservations y ON y.id = rs.reservation_id
       JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
        WHERE rs.route_assignment_id = ra.id AND yp.organization_id = v_org)) THEN
    RAISE EXCEPTION 'Esa vuelta no existe' USING ERRCODE = 'P0002';
  END IF;
  IF ra.status NOT IN ('draft', 'planned')
     OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: no se le suma nadie' USING ERRCODE = 'P0001';
  END IF;
  IF ra.direction IS DISTINCT FROM r.direction THEN
    RAISE EXCEPTION '%', CASE WHEN v_lle THEN 'Es una llegada y esa vuelta es de salidas' ELSE 'Es una salida y esa vuelta es de llegadas' END USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.reservation_id = p_reservation) THEN
    RETURN jsonb_build_object('id', ra.id, 'unchanged', true);
  END IF;

  -- Sale de donde iba (pendiente, o «no se presentó» que el jefe rescata).
  FOR o IN
    SELECT rs.id AS stop_id, rs.estimated_arrival_at AS eta, x.id AS ra_id, x.planned_start_at, dp.profile_id AS drv_prof
      FROM public.route_stops rs
      JOIN public.route_assignments x ON x.id = rs.route_assignment_id
      LEFT JOIN public.driver_profiles dp ON dp.id = x.driver_profile_id
     WHERE rs.reservation_id = p_reservation AND rs.status IN ('pending', 'no_show')
       AND x.status IN ('draft', 'planned', 'in_progress')
     ORDER BY x.planned_start_at DESC
  LOOP
    IF v_from IS NULL THEN v_from := o.planned_start_at; IF NOT v_lle THEN v_eta := o.eta; END IF; END IF;
    DELETE FROM public.route_stops WHERE id = o.stop_id;
    DELETE FROM public.route_assignments z
     WHERE z.id = o.ra_id AND z.status IN ('draft', 'planned')
       AND NOT EXISTS (SELECT 1 FROM public.route_stops y WHERE y.route_assignment_id = z.id);
    IF FOUND THEN v_quedo_vacia := true;
    ELSE
      -- Los que quedan, en orden corrido (1, 2, 3…).
      UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = o.ra_id;
      UPDATE public.route_stops t SET stop_order = n.k
        FROM (SELECT id, row_number() OVER (ORDER BY stop_order) AS k FROM public.route_stops WHERE route_assignment_id = o.ra_id) n
       WHERE t.id = n.id;
      PERFORM public.route_sync_assigned(o.ra_id);
    END IF;
    IF o.drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(o.drv_prof, 'Cambió un traslado de tu ruta',
        v_who || ' ya no va en tu vuelta de las ' || public.hm_bog(o.planned_start_at) || ': coordinación la pasó a otra.',
        '/', 'pasar-out:' || p_reservation::text || ':' || o.ra_id::text || ':' || v_sello);
    END IF;
  END LOOP;

  -- Entra en la que el jefe eligió.
  IF v_lle THEN
    SELECT max(x.estimated_arrival_at) + interval '10 minutes' INTO v_eta FROM public.route_stops x WHERE x.route_assignment_id = ra.id;
  END IF;
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
  VALUES (ra.id, p_reservation, (SELECT coalesce(max(x.stop_order), 0) + 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id), v_eta);
  IF NOT v_lle THEN
    -- Salida: el orden es el de las horas de recogida (quien no tiene hora, al final).
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = ra.id;
    UPDATE public.route_stops t SET stop_order = n.k
      FROM (SELECT id, row_number() OVER (ORDER BY estimated_arrival_at NULLS LAST, stop_order) AS k FROM public.route_stops WHERE route_assignment_id = ra.id) n
     WHERE t.id = n.id;
    IF v_eta IS NOT NULL THEN
      UPDATE public.route_assignments SET planned_start_at = least(planned_start_at, v_eta) WHERE id = ra.id;
    END IF;
  END IF;
  UPDATE public.route_assignments SET updated_at = now() WHERE id = ra.id;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_route;

  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(p_reservation);

  SELECT dp.profile_id, pp.full_name INTO v_drv, v_drv_name
    FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = ra.driver_profile_id;
  SELECT count(*) INTO v_pax FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
   WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL);

  PERFORM public.trip_notify(r.crew, 'Te movimos de vuelta 🔄',
    CASE WHEN v_lle THEN 'Te esperamos ' || coalesce(public.lugar_del_regreso(p_reservation), 'en JMC') || ' a las ' || public.hm_bog(ra.planned_start_at)
         ELSE 'Te recogemos' || coalesce(' a las ' || public.hm_bog(v_eta), '') END
    || CASE WHEN ra.delegated_at IS NOT NULL THEN coalesce(', te lleva ' || nullif(btrim(ra.delegate_name), ''), '') || '.'
            WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || public.short_name(v_drv_name) || '.'
            ELSE '. Te avisamos quién te recoge.' END,
    '/#/viaje?r=' || p_reservation::text, 'pasar-in:' || p_reservation::text || ':' || ra.id::text || ':' || v_sello);
  IF v_drv IS NOT NULL THEN
    PERFORM public.trip_notify(v_drv, 'Se sumó alguien a tu vuelta',
      v_who || ' va en tu vuelta de las ' || public.hm_bog(ra.planned_start_at)
      || CASE WHEN v_lle THEN coalesce(': lo dejas en ' || v_lugar, '') ELSE coalesce(': recogida ' || public.hm_bog(v_eta), '') || coalesce(' en ' || v_lugar, '') END || '.',
      '/', 'pasar-drv:' || p_reservation::text || ':' || ra.id::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'start_at', ra.planned_start_at, 'pickup_at', v_eta, 'from_at', v_from,
    'driver_name', v_drv_name, 'pax', v_pax, 'removed_route', v_quedo_vacia, 'direction', r.direction);
END;
$function$
