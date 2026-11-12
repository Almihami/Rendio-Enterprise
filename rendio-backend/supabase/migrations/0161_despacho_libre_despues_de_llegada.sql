-- =============================================================================
-- 0161 · Despacho: quien ya tiene una llegada asignada queda libre DESPUÉS de ella
-- =============================================================================
-- Prueba en vivo del 11-nov. El mismo caso dio dos resultados:
--   · dos llegadas decididas en la MISMA revisión → las dos al mismo conductor, la
--     segunda con 39 min de espera y aviso «necesita apoyo»;
--   · decididas en revisiones DISTINTAS → «ningún conductor alcanza», porque la
--     llegada que el conductor ya tenía se contaba como un compromiso al que debía
--     alcanzar a llegar, y no como trabajo tras el cual queda libre.
-- Harold decidió (11-nov): con espera larga, el sistema ASIGNA al carro que llega
-- primero y AVISA. despacho_estado ahora suma las llegadas ya asignadas que
-- arrancan en la próxima hora al «cuándo queda libre» del conductor. Las salidas
-- siguen siendo compromiso: las salidas mandan. Copiada DESDE 0158.
-- =============================================================================
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

REVOKE ALL ON FUNCTION public.despacho_estado(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_estado(timestamptz) TO service_role;

COMMIT;
