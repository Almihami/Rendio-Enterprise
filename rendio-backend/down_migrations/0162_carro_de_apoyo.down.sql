-- Down 0162 — quita el apoyo: despacho_estado vuelve a 0161 y despacho_asignar a 0159.
BEGIN;
CREATE OR REPLACE FUNCTION public.despacho_estado(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s record; o record;
  v_out jsonb := '[]'::jsonb; v_lle jsonb; v_car jsonb;
  v_ap_lat double precision; v_ap_lng double precision;
  d record; l record; nx record; v_corte timestamptz; v_sal jsonb;
BEGIN
  SELECT coalesce(despacho_activo, false) AS on_, coalesce(despacho_horizonte_min, 20) AS hor,
         coalesce(despacho_juntar_min, 6) AS jun, coalesce(despacho_espera_max_min, 15) AS esp,
         coalesce(route_default_capacity, 4) AS cap, coalesce(route_service_min, 2) AS srv,
         coalesce(route_traffic_factor, 1.25) AS traf
    INTO s FROM public.app_settings WHERE id = 'singleton';
  IF NOT coalesce(s.on_, false) THEN RETURN v_out; END IF;

  FOR o IN
    SELECT DISTINCT ra.organization_id AS org
      FROM public.route_assignments ra
     WHERE ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
       AND ra.status = 'planned' AND ra.delegated_at IS NULL AND ra.organization_id IS NOT NULL
       AND ra.planned_start_at BETWEEN p_now - interval '3 hours' AND p_now + interval '4 hours'
  LOOP
    SELECT a.latitude, a.longitude INTO v_ap_lat, v_ap_lng
      FROM public.airports a WHERE a.organization_id = o.org ORDER BY a.created_at LIMIT 1;
    v_ap_lat := coalesce(v_ap_lat, 6.1708); v_ap_lng := coalesce(v_ap_lng, -75.4279);

    -- Llegadas en espera: una por vuelta, tal como la publicó el jefe. `sale` es
    -- cuando sale el ÚLTIMO de la vuelta: aterrizaje (FlightRadar si lo hay, si no
    -- la hora de la reserva) + desembarque de su aerolínea; en tierra o de reserva,
    -- la hora de la reserva tal cual; un «sin cuenta», la hora de la vuelta.
    SELECT coalesce(jsonb_agg(q.x ORDER BY q.sale), '[]'::jsonb) INTO v_lle
      FROM (
        SELECT t.sale, jsonb_build_object('ra', ra.id, 'sale', t.sale, 'pax', t.pax,
                                          'lat', t.lat, 'lng', t.lng, 'quien', t.quien) AS x
          FROM public.route_assignments ra
          JOIN LATERAL (
            SELECT count(*)::int AS pax,
                   bool_and(rs.status = 'pending') AS intacta,
                   max(CASE
                         WHEN r.id IS NULL THEN ra.planned_start_at
                         WHEN nullif(trim(r.flight_code), '') IS NULL OR coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL
                           THEN r.required_arrival_at
                         ELSE coalesce(public.reub_baja(o.org, r.flight_code, r.required_arrival_at), r.required_arrival_at)
                              + make_interval(mins => coalesce(public.flight_deplane_min(r.flight_code), 20))
                       END) AS sale,
                   (array_agg(coalesce(r.pickup_latitude, rs.guest_lat) ORDER BY rs.stop_order DESC))[1] AS lat,
                   (array_agg(coalesce(r.pickup_longitude, rs.guest_lng) ORDER BY rs.stop_order DESC))[1] AS lng,
                   string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) AS quien
              FROM public.route_stops rs
              LEFT JOIN public.reservations r        ON r.id = rs.reservation_id
              LEFT JOIN public.auxiliar_profiles ap  ON ap.id = r.auxiliar_profile_id
              LEFT JOIN public.profiles pr           ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id
               AND (rs.reservation_id IS NULL OR r.cancelled_at IS NULL)
          ) t ON true
         WHERE ra.organization_id = o.org
           AND ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
           AND ra.status = 'planned' AND ra.delegated_at IS NULL
           AND ra.planned_start_at BETWEEN p_now - interval '3 hours' AND p_now + interval '4 hours'
           AND t.pax > 0 AND t.intacta AND t.sale IS NOT NULL
           AND t.sale > p_now - interval '90 minutes'          -- lo muy viejo ya es de un jefe, no del despacho
      ) q;

    -- Conductores con turno abierto: cuándo y dónde quedan libres (cadena_libre,
    -- 0152) y su siguiente compromiso.
    -- 0161: una LLEGADA que ya tiene asignada y arranca en la próxima hora no es un
    -- «compromiso al que hay que alcanzar a llegar»: es trabajo que va a hacer, y
    -- queda libre DESPUÉS de ella, en la última casa. Antes se modelaba como
    -- compromiso y a quien tenía una llegada encima no se le podía dar otra para
    -- después: salía «ningún conductor alcanza» cuando sí había quién, tarde
    -- (regla de Harold, 11-nov: con espera larga se ASIGNA y se AVISA).
    v_car := '[]'::jsonb;
    FOR d IN
      SELECT DISTINCT ON (sh.driver_id) sh.driver_id AS dp, least(coalesce(v.capacity, s.cap), 4) AS cupo
        FROM public.shifts sh
        LEFT JOIN public.vehicles v ON v.id = sh.vehicle_id
       WHERE sh.organization_id = o.org
         AND sh.status::text IN ('active', 'closing')
         AND sh.start_at > p_now - interval '16 hours'
       ORDER BY sh.driver_id, sh.start_at DESC
    LOOP
      v_corte := p_now + interval '1 minute';
      FOR k IN 1..4 LOOP
        SELECT n.id, n.direction, n.planned_start_at INTO nx
          FROM public.route_assignments n
         WHERE n.driver_profile_id = d.dp AND n.status = 'planned' AND n.delegated_at IS NULL
           AND n.planned_start_at >= v_corte AND n.planned_start_at < p_now + interval '6 hours'
           AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = n.id AND rs.status = 'pending')
         ORDER BY n.planned_start_at LIMIT 1;
        EXIT WHEN nx.id IS NULL OR nx.direction <> 'airport_to_home' OR nx.planned_start_at > p_now + interval '60 minutes';
        v_corte := nx.planned_start_at + interval '1 minute';
      END LOOP;
      SELECT * INTO l FROM public.cadena_libre(d.dp, NULL, v_corte);
      -- Su siguiente compromiso después de eso (una salida, o una llegada más lejana).
      SELECT jsonb_build_object(
               'eta', CASE WHEN n.direction = 'airport_to_home' THEN n.planned_start_at ELSE coalesce(rs.estimated_arrival_at, n.planned_start_at) END,
               'air', n.direction = 'airport_to_home',
               'lat', CASE WHEN n.direction = 'airport_to_home' THEN v_ap_lat ELSE coalesce(r.pickup_latitude, rs.guest_lat) END,
               'lng', CASE WHEN n.direction = 'airport_to_home' THEN v_ap_lng ELSE coalesce(r.pickup_longitude, rs.guest_lng) END)
        INTO v_sal
        FROM public.route_assignments n
        JOIN public.route_stops rs ON rs.route_assignment_id = n.id
        LEFT JOIN public.reservations r ON r.id = rs.reservation_id
       WHERE n.driver_profile_id = d.dp AND n.status = 'planned' AND n.delegated_at IS NULL
         AND n.planned_start_at >= v_corte AND n.planned_start_at < p_now + interval '6 hours'
         AND rs.status = 'pending'
       ORDER BY n.planned_start_at, rs.stop_order LIMIT 1;
      v_car := v_car || jsonb_build_object(
        'dp', d.dp, 'cupo', d.cupo, 'known', coalesce(l.known, false),
        'free_at', greatest(coalesce(l.free_at, p_now), p_now),
        'lat', l.lat, 'lng', l.lng, 'air', coalesce(l.air, false), 'salida', v_sal);
    END LOOP;

    v_out := v_out || jsonb_build_object(
      'org', o.org, 'ahora', p_now,
      'aeropuerto', jsonb_build_object('lat', v_ap_lat, 'lng', v_ap_lng),
      'cfg', jsonb_build_object('horizonte', s.hor, 'juntar', s.jun, 'esperaMax', s.esp, 'servicio', s.srv, 'trafico', s.traf),
      'llegadas', v_lle, 'carros', v_car);
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.despacho_asignar(p_ra uuid, p_dp uuid, p_recoge timestamptz, p_sale timestamptz, p_espera int DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments%ROWTYPE;
  c record;
  v_prof uuid; v_nom text; v_pl text; v_quien text;
  v_antes timestamptz; v_ini timestamptz;
BEGIN
  IF p_ra IS NULL OR p_dp IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE id = 'singleton' AND despacho_activo) THEN RETURN false; END IF;
  SELECT dp.profile_id, split_part(pr.full_name, ' ', 1) INTO v_prof, v_nom
    FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;

  -- 0159: la vuelta queda a la hora en que de verdad recoge (múltiplo de 5 hacia
  -- arriba, como el tablero), no a la programada: si el vuelo viene adelantado, el
  -- conductor y el tripulante tienen que ver la hora nueva, no solo el aviso.
  SELECT planned_start_at INTO v_antes FROM public.route_assignments WHERE id = p_ra;
  v_ini := CASE WHEN p_recoge IS NULL THEN v_antes
                ELSE to_timestamp(ceil(extract(epoch FROM p_recoge) / 300.0) * 300) END;

  UPDATE public.route_assignments
     SET driver_profile_id = p_dp, planned_start_at = coalesce(v_ini, planned_start_at), updated_at = now()
   WHERE id = p_ra AND pool AND driver_profile_id IS NULL AND status = 'planned'
     AND delegated_at IS NULL AND direction = 'airport_to_home'
     AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = p_ra AND rs.status <> 'pending')
  RETURNING * INTO ra;
  IF ra.id IS NULL THEN RETURN false; END IF;

  IF v_ini IS DISTINCT FROM v_antes AND v_antes IS NOT NULL THEN
    UPDATE public.route_stops
       SET estimated_arrival_at = estimated_arrival_at + (v_ini - v_antes)
     WHERE route_assignment_id = ra.id AND estimated_arrival_at IS NOT NULL;
  END IF;
  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(rs.reservation_id)
     FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NOT NULL;
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;      -- con el carro de su turno (0124)
  SELECT coalesce(v.license_plate, v.internal_code) INTO v_pl FROM public.vehicles v WHERE v.id = ra.vehicle_id;
  SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
    FROM public.route_stops rs
    LEFT JOIN public.reservations r ON r.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = ra.id;

  -- Al conductor: qué, a quién y a qué hora.
  PERFORM public.trip_notify(v_prof, 'Llegada para ti ✈️',
    'Recoge en JMC a las ' || public.hm_bog(ra.planned_start_at) || ': ' || coalesce(v_quien, 'una llegada') || '.',
    '/#/rutas', 'desp:' || ra.id::text || ':' || p_dp::text);
  -- A cada tripulante: quién lo recoge (mismo texto que cuando un conductor la toma).
  FOR c IN
    SELECT r.id, ap.profile_id AS crew
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    PERFORM public.trip_notify(c.crew, coalesce(v_nom, 'Tu conductor') || ' te recoge 🚗',
      'Te espera ' || coalesce(public.lugar_del_regreso(c.id), 'en JMC cuando aterrices') || coalesce(' (carro ' || v_pl || ')', '') || '.',
      '/#/viaje?r=' || c.id::text, 'desp-tr:' || ra.id::text || ':' || p_dp::text || ':' || c.id::text);
  END LOOP;

  INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, exit_at, pickup_at, wait_min, who)
  VALUES (ra.organization_id, ra.id, p_dp, 'asignada', p_sale, ra.planned_start_at, greatest(coalesce(p_espera, 0), 0), v_quien);
  PERFORM public.trip_kick();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.despacho_estado(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_estado(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) TO service_role;
DROP FUNCTION IF EXISTS public.admin_apoyo_resumen(date, date);
DROP FUNCTION IF EXISTS public.apoyo_de_turno(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.admin_set_support_duty(date, text, uuid);
DROP TABLE IF EXISTS public.support_duty;
COMMIT;
