-- =============================================================================
-- 0162 · El carro de apoyo: quién lo tiene, cuándo sale y cuántas vueltas hizo
-- =============================================================================
-- Harold, 11-nov: hay un carro físico más, dispuesto para cuando los dos fijos no
-- alcanzan a cubrir la operación; lo maneja «el que tenga el apoyo» y se le paga
-- solo por vuelta. Y una condición: sin llenar la app de opciones y módulos.
--
-- Por eso es UNA cosa nueva que guardar y nada más:
--   1. support_duty: quién tiene el apoyo en cada turno (día + mañana/tarde). El
--      jefe lo elige en Asignación, en la tarjeta de Conductores. No es un turno,
--      no entra al horario semanal ni a la disponibilidad.
--   2. apoyo_de_turno(org, hora): quién lo tiene a esa hora (los turnos van de
--      2:00 a 14:00 y de 14:00 a 2:00; la madrugada es del turno PM de ayer).
--   3. despacho_estado (copiada DESDE 0161): el de apoyo entra a la foto marcado
--      `apoyo`, tenga o no turno abierto. El motor ya sabía qué hacer con él: lo
--      usa solo si los carros fijos harían esperar más de `esperaMax`.
--   4. despacho_asignar (copiada DESDE 0159): si le toca al de apoyo, el aviso
--      dice «Apoyo: llegada para ti», a los jefes les llega «Salió el carro de
--      apoyo» y el rastro queda marcado.
--   5. admin_apoyo_resumen(desde, hasta): por conductor, cuántas vueltas hizo
--      teniendo el apoyo (con al menos una persona recogida). Para pagar por
--      vuelta; el valor de la vuelta no vive aquí.
-- =============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.support_duty (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day                date        NOT NULL,
  band               text        NOT NULL,
  driver_profile_id  uuid        NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  set_by             uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_duty_band_valid CHECK (band IN ('am', 'pm')),
  CONSTRAINT support_duty_unico UNIQUE (organization_id, day, band)
);
DROP TRIGGER IF EXISTS tr_support_duty_set_updated_at ON public.support_duty;
CREATE TRIGGER tr_support_duty_set_updated_at BEFORE UPDATE ON public.support_duty
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.support_duty ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_duty_admin_read ON public.support_duty;
CREATE POLICY support_duty_admin_read ON public.support_duty FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS support_duty_driver_read ON public.support_duty;
CREATE POLICY support_duty_driver_read ON public.support_duty FOR SELECT TO authenticated
  USING (driver_profile_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.profile_id = auth.uid()));
COMMENT ON TABLE public.support_duty IS
  '0162: quién tiene el carro de apoyo en cada turno (día + am/pm). Lo escribe solo admin_set_support_duty.';

-- El jefe dice quién tiene el apoyo (o lo quita con p_driver NULL).
CREATE OR REPLACE FUNCTION public.admin_set_support_duty(p_day date, p_band text, p_driver uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v_dp uuid;
BEGIN
  IF v_org IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo Coordinación puede definir el apoyo' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_band NOT IN ('am', 'pm') THEN
    RAISE EXCEPTION 'Falta el día o el turno' USING ERRCODE = 'P0001';
  END IF;
  IF p_driver IS NULL THEN
    DELETE FROM public.support_duty WHERE organization_id = v_org AND day = p_day AND band = p_band;
    RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', NULL);
  END IF;
  -- Acepta el id del conductor o el de su perfil: el tablero usa uno u otro.
  SELECT dp.id INTO v_dp FROM public.driver_profiles dp JOIN public.profiles pr ON pr.id = dp.profile_id
   WHERE (dp.id = p_driver OR dp.profile_id = p_driver) AND pr.organization_id = v_org AND pr.deleted_at IS NULL LIMIT 1;
  IF v_dp IS NULL THEN RAISE EXCEPTION 'Ese conductor no es de tu organización' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id, set_by)
  VALUES (v_org, p_day, p_band, v_dp, auth.uid())
  ON CONFLICT (organization_id, day, band) DO UPDATE SET driver_profile_id = EXCLUDED.driver_profile_id, set_by = EXCLUDED.set_by, updated_at = now();
  RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', v_dp);
END;
$$;

-- Quién tiene el apoyo a una hora dada.
CREATE OR REPLACE FUNCTION public.apoyo_de_turno(p_org uuid, p_at timestamptz)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH t AS (SELECT (p_at AT TIME ZONE 'America/Bogota') AS loc)
  SELECT sd.driver_profile_id
    FROM public.support_duty sd, t
   WHERE sd.organization_id = p_org
     AND sd.day  = CASE WHEN t.loc::time < time '02:00' THEN t.loc::date - 1 ELSE t.loc::date END
     AND sd.band = CASE WHEN t.loc::time >= time '02:00' AND t.loc::time < time '14:00' THEN 'am' ELSE 'pm' END
   LIMIT 1;
$$;

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
  v_apoyo uuid;
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
    -- 0162: quién tiene el apoyo en este turno. Entra a la foto aunque no haya
    -- abierto turno (se le llama cuando hace falta) y va marcado: el motor lo usa
    -- solo si los carros fijos harían esperar de más.
    v_apoyo := public.apoyo_de_turno(o.org, p_now);
    v_car := '[]'::jsonb;
    FOR d IN
      SELECT z.dp, max(z.cupo)::int AS cupo
        FROM (
          SELECT sh.driver_id AS dp, least(coalesce(v.capacity, s.cap), 4)::int AS cupo
            FROM public.shifts sh
            LEFT JOIN public.vehicles v ON v.id = sh.vehicle_id
           WHERE sh.organization_id = o.org
             AND sh.status::text IN ('active', 'closing')
             AND sh.start_at > p_now - interval '16 hours'
          UNION ALL
          SELECT v_apoyo, least(s.cap, 4)::int WHERE v_apoyo IS NOT NULL
        ) z
       GROUP BY z.dp
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
        'lat', l.lat, 'lng', l.lng, 'air', coalesce(l.air, false), 'salida', v_sal,
        'apoyo', d.dp IS NOT DISTINCT FROM v_apoyo);
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
  v_es_apoyo boolean := false; j record;
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

  -- 0162: ¿es el que tiene el apoyo en este turno?
  v_es_apoyo := p_dp IS NOT DISTINCT FROM public.apoyo_de_turno(ra.organization_id, now());
  -- Al conductor: qué, a quién y a qué hora.
  PERFORM public.trip_notify(v_prof, CASE WHEN v_es_apoyo THEN 'Apoyo: llegada para ti ✈️' ELSE 'Llegada para ti ✈️' END,
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

  -- 0162: cuando sale el apoyo, los jefes se enteran (es el carro que se paga por vuelta).
  IF v_es_apoyo THEN
    FOR j IN SELECT profile_id FROM public.ops_alert_recipients_of(ra.organization_id) LOOP
      PERFORM public.trip_notify(j.profile_id, 'Salió el carro de apoyo 🚐',
        coalesce(v_nom, 'El de apoyo') || ' recoge a ' || coalesce(v_quien, 'una llegada') || ' en JMC a las ' || public.hm_bog(ra.planned_start_at) || '. Los carros fijos no alcanzaban.',
        '/#/rutas', 'desp-apoyo-sale:' || ra.id::text || ':' || j.profile_id::text);
    END LOOP;
  END IF;
  INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, exit_at, pickup_at, wait_min, who, detail)
  VALUES (ra.organization_id, ra.id, p_dp, 'asignada', p_sale, ra.planned_start_at, greatest(coalesce(p_espera, 0), 0), v_quien, jsonb_build_object('apoyo', v_es_apoyo));
  PERFORM public.trip_kick();
  RETURN true;
END;
$$;

-- Cuántas vueltas hizo cada conductor teniendo el apoyo (para pagar por vuelta).
CREATE OR REPLACE FUNCTION public.admin_apoyo_resumen(p_from date, p_to date)
RETURNS TABLE (driver_profile_id uuid, nombre text, vueltas integer, personas integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid := public.current_user_org();
BEGIN
  IF v_org IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo Coordinación' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ra.driver_profile_id, pr.full_name::text, count(*)::int, sum(x.n)::int
    FROM public.route_assignments ra
    JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
    JOIN public.profiles pr ON pr.id = dp.profile_id
    JOIN LATERAL (SELECT count(*)::int AS n FROM public.route_stops rs
                   WHERE rs.route_assignment_id = ra.id AND rs.status IN ('picked_up', 'delivered')) x ON true
   WHERE pr.organization_id = v_org
     AND ra.planned_start_at >= (p_from::timestamp + time '02:00') AT TIME ZONE 'America/Bogota'
     AND ra.planned_start_at <  ((p_to + 1)::timestamp + time '02:00') AT TIME ZONE 'America/Bogota'
     AND ra.status <> 'cancelled' AND x.n > 0
     AND ra.driver_profile_id = public.apoyo_de_turno(v_org, ra.planned_start_at)
   GROUP BY ra.driver_profile_id, pr.full_name
   ORDER BY pr.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_support_duty(date, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_support_duty(date, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_apoyo_resumen(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_apoyo_resumen(date, date) TO authenticated;
REVOKE ALL ON FUNCTION public.apoyo_de_turno(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apoyo_de_turno(uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_estado(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_estado(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) TO service_role;

COMMIT;
