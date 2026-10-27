-- Down de 0151: driver_take_route vuelve a la de 0147 (no deja tomar si se cruza) y se
-- quitan las funciones nuevas. La columna para_tomar se deja (las vueltas que la usan
-- siguen siendo pool y se pueden tomar como antes).
BEGIN;
CREATE OR REPLACE FUNCTION public.driver_take_route(p_route uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  v_me  text;
  v_pl  text;
  c     record;
  e     record;   -- 0138
  v_otra timestamptz;   -- 0138
BEGIN
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;
  -- 0138: no se toma una vuelta que se cruza con otra suya (o a la que no alcanza a
  -- llegar desde la anterior). Solo si la vuelta sigue libre: si no, el mensaje de
  -- siempre («ya la tomó otro», «la delegó Coordinación»).
  IF EXISTS (SELECT 1 FROM public.route_assignments x WHERE x.id = p_route AND x.pool AND x.organization_id = v_org
               AND x.driver_profile_id IS NULL AND x.status = 'planned' AND x.delegated_at IS NULL) THEN
    SELECT * INTO e FROM public.reub_extremos(p_route);
    IF e.ini_at IS NOT NULL AND e.fin_at IS NOT NULL
       AND NOT public.reub_conductor_libre(v_dp, p_route, NULL, e.ini_at, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                                           e.fin_at, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air) THEN
      -- La suya más cercana a esa hora, para decirle con cuál choca.
      SELECT o.planned_start_at INTO v_otra FROM public.route_assignments o
       WHERE o.driver_profile_id = v_dp AND o.id <> p_route AND o.status IN ('planned', 'in_progress')
         AND o.planned_start_at BETWEEN e.ini_at - interval '12 hours' AND e.fin_at + interval '12 hours'
       ORDER BY abs(extract(epoch FROM o.planned_start_at - e.ini_at)) LIMIT 1;
      RAISE EXCEPTION 'Esa vuelta se cruza con tu vuelta de las %: no alcanzas a hacer las dos. Si de verdad puedes, pídesela a Coordinación.',
        coalesce(public.hm_bog(v_otra), 'esa hora') USING ERRCODE = 'P0001', HINT = 'se_cruza';
    END IF;
  END IF;
  UPDATE public.route_assignments
     SET driver_profile_id = v_dp, updated_at = now()
   WHERE id = p_route AND pool AND organization_id = v_org AND driver_profile_id IS NULL AND status = 'planned'
     AND delegated_at IS NULL   -- 0126
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND delegated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta la hace alguien de afuera: Coordinación la delegó' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.route_assignments WHERE id = p_route AND driver_profile_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta vuelta ya la tomó otro conductor' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Esta vuelta ya no está disponible' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  FOR c IN
    SELECT r.id, ap.profile_id AS crew, rs.estimated_arrival_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_me, 'Tu conductor') || ' te recoge 🚗',
      CASE WHEN ra.direction = 'home_to_airport'
           THEN 'Te recoge a las ' || public.hm_bog(c.at) || coalesce(' en el carro ' || v_pl, '') || '.'
           ELSE 'Te espera ' || coalesce(public.lugar_del_regreso(c.id), 'en JMC cuando aterrices') || coalesce(' (carro ' || v_pl || ')', '') || '.' END,   -- 0147
      '/#/viaje?r=' || c.id::text, 'take:' || ra.id::text || ':' || v_dp::text || ':' || c.id::text);
  END LOOP;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'vehicle_id', ra.vehicle_id, 'plate', v_pl);
END;
$$;
DROP FUNCTION IF EXISTS public.admin_routes_offer(uuid[]);
DROP FUNCTION IF EXISTS public.driver_llegada_soltar(uuid, uuid);
DROP FUNCTION IF EXISTS public.driver_llegada_agregar(uuid, uuid);
DROP FUNCTION IF EXISTS public.driver_llegada_candidatos(uuid);
DROP FUNCTION IF EXISTS public.llegada_donde_va(uuid);
DROP FUNCTION IF EXISTS public.llegada_editable(uuid, uuid);
COMMIT;
