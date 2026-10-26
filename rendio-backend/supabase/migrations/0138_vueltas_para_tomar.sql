-- =============================================================================
-- 0138 · «Vueltas para tomar»: los sin cuenta se ven y nadie toma dos a la vez
--        (26-oct-2026)
-- =============================================================================
-- Pendiente de los jefes (26-oct): «un apartado en la app de conductores para que
-- aparezca el listado completo de la ruta, en orden, el conductor se asignará los
-- servicios y a medida que el día avanza se va ir desapareciendo los servicios
-- apenas se tomen; si el jefe lo asigna, al conductor no le aparecerá».
-- Eso ya existe (0125 + 0129). Decisión (26-oct): las vueltas las pone el sistema
-- por defecto (carro y franja, según el horario) y la lista queda para lo que sobre
-- (tercer carro, vueltas extra, cambios de vuelo). Quedaban dos huecos:
--
--   1. driver_open_routes solo contaba a quien tiene reserva: Kriss (0133, sin
--      cuenta) no salía en la tarjeta y una vuelta solo con ella decía «0 personas».
--      Ahora salen todos, con o sin cuenta. Y cada vuelta trae 'cruza' = true si el
--      conductor que mira ya tiene otra a esa hora (la pantalla lo dice y no deja
--      tomarla).
--   2. driver_take_route dejaba tomar dos vueltas que se cruzan. Ahora se niega con
--      la misma cuenta del sistema (reub_extremos + reub_conductor_libre, 0135): no
--      se cruzan y alcanza a llegar de una a otra.
--      «Esa vuelta se cruza con tu vuelta de las 9:05: no alcanzas a hacer las dos.»
--      El jefe sí puede dársela a mano (0129, admin_route_set_driver): él decide.
--
-- Copias: driver_open_routes y driver_take_route son las de 0126 con lo marcado
-- «0138». Necesita 0126, 0133 (guest_*) y 0135 (reub_extremos, reub_conductor_libre).
-- Down: down_migrations/0138_vueltas_para_tomar.down.sql (las deja como en 0126).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_open_routes()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_dp uuid := public.my_driver_profile_id(); v_org uuid := public.current_user_org();
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(j ORDER BY ts) FROM (
      SELECT ra.planned_start_at AS ts, jsonb_build_object(
        'id', ra.id, 'direction', ra.direction, 'planned_start_at', ra.planned_start_at,
        'deadline_at', ra.deadline_at, 'note', ra.manual_note, 'day', ra.manual_day,
        -- 0138: con o sin cuenta (0133). Antes un JOIN a reservas dejaba por fuera a Kriss.
        'stops', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'order', rs.stop_order, 'at', rs.estimated_arrival_at,
                    'name', CASE WHEN rs.reservation_id IS NULL THEN public.short_name(rs.guest_name) ELSE public.short_name(pr.full_name) END,
                    'place', coalesce(res.name, nullif(btrim(split_part(r.pickup_address, ',', 1)), ''), nullif(btrim(rs.guest_place), ''), 'Sin dirección'),
                    'sector', res.sector, 'flight', coalesce(f.flight_number, r.flight_code),
                    'guest', rs.reservation_id IS NULL) ORDER BY rs.stop_order), '[]'::jsonb)
                  FROM public.route_stops rs
                  LEFT JOIN public.reservations r ON r.id = rs.reservation_id
                  LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                  LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
                  LEFT JOIN public.residences res ON res.id = coalesce(r.residence_id, rs.guest_residence_id)
                  LEFT JOIN public.flights f ON f.id = r.flight_id
                 WHERE rs.route_assignment_id = ra.id
                   AND ((rs.reservation_id IS NOT NULL AND r.cancelled_at IS NULL)
                        OR (rs.reservation_id IS NULL AND rs.guest_name IS NOT NULL))),
        -- 0138: ¿ya tiene otra vuelta a esa hora? (la misma cuenta que driver_take_route)
        'cruza', (SELECT e.ini_at IS NOT NULL AND e.fin_at IS NOT NULL
                         AND NOT public.reub_conductor_libre(v_dp, ra.id, NULL,
                               e.ini_at, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                               e.fin_at, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air)
                    FROM public.reub_extremos(ra.id) e)) AS j
        FROM public.route_assignments ra
       WHERE ra.pool AND ra.organization_id = v_org AND ra.driver_profile_id IS NULL AND ra.status = 'planned'
         AND ra.delegated_at IS NULL   -- 0126: la delegada no se ofrece
         AND ra.planned_start_at >= now() - interval '1 hour'
         AND ra.planned_start_at <  now() + interval '40 hours'
    ) z), '[]'::jsonb);
END;
$$;

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
           ELSE 'Te espera en JMC cuando aterrices' || coalesce(' (carro ' || v_pl || ')', '') || '.' END,
      '/#/viaje?r=' || c.id::text, 'take:' || ra.id::text || ':' || v_dp::text || ':' || c.id::text);
  END LOOP;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'vehicle_id', ra.vehicle_id, 'plate', v_pl);
END;
$$;

COMMIT;
