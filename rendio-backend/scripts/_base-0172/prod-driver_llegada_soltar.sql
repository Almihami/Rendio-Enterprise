CREATE OR REPLACE FUNCTION public.driver_llegada_soltar(p_route uuid, p_stop uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_res uuid; v_crew uuid; v_name text; v_me text; v_new uuid;
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Solo un conductor' USING ERRCODE = '42501'; END IF;
  ra := public.llegada_editable(p_route, v_dp);
  SELECT rs.reservation_id INTO v_res FROM public.route_stops rs
   WHERE rs.id = p_stop AND rs.route_assignment_id = ra.id AND rs.status IN ('pending', 'arrived') AND rs.reservation_id IS NOT NULL;
  IF v_res IS NULL THEN RAISE EXCEPTION 'Esa persona no es de tu vuelta o ya se subió' USING ERRCODE = 'P0002'; END IF;
  SELECT ap.profile_id, pr.full_name INTO v_crew, v_name FROM public.reservations r
    JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE r.id = v_res;
  DELETE FROM public.route_stops WHERE id = p_stop;
  INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, para_tomar, organization_id)
  VALUES (NULL, NULL, 'airport_to_home', 'planned', ra.planned_start_at, true, true, v_org)
  RETURNING id INTO v_new;
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES (v_new, v_res, 1, NULL);
  PERFORM public.sync_calculated_pickup(v_res);
  DELETE FROM public.route_assignments x WHERE x.id = ra.id
     AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = x.id);
  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  PERFORM public.trip_notify(j.profile_id, '⚠️ ' || coalesce(public.short_name(v_me), 'Un conductor') || ' soltó a ' || public.short_name(v_name),
    'De su llegada de las ' || public.hm_bog(ra.planned_start_at) || '. Quedó para tomar: si nadie la toma, asígnala en Asignación.',
    '/#/rutas', 'llegadasuelta-j:' || v_new::text || ':' || v_sello || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  PERFORM public.avisar_vuelta_para_tomar(v_org, ra.planned_start_at, 'Hay una vuelta para tomar',
    'Llegada de las ' || public.hm_bog(ra.planned_start_at) || ' (' || public.short_name(v_name) || ').',
    'llegadasuelta:' || v_new::text || ':' || v_sello, auth.uid(), false);
  IF v_crew IS NOT NULL THEN
    PERFORM public.trip_notify(v_crew, 'Cambió quién te recoge',
      'Te avisamos apenas un conductor tome tu traslado.', '/#/viaje?r=' || v_res::text, 'llegadasuelta-t:' || v_new::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', v_new);
END;
$function$
