-- =============================================================================
-- 0159 · Despacho de llegadas: la hora de la vuelta, el texto y un aviso que sobra
-- =============================================================================
-- Lo que mostró la prueba en vivo en dev (11-nov, 3 ventanas):
--   1. Al asignar, la vuelta conservaba la hora PROGRAMADA (21:42) aunque el vuelo
--      viniera adelantado y el aviso dijera «recoge a las 21:32». Ahora
--      despacho_asignar deja la vuelta a la hora en que recoge (redondeada a 5
--      hacia arriba), corre las paradas lo mismo y actualiza la hora del pedido.
--   2. «…ningún conductor alcanza a recogerla» salía igual para un hombre.
--   3. Con el despacho encendido, «Nadie ha tomado una vuelta ⚠️» (0125/0126)
--      sonaba por las mismas llegadas que el sistema tiene en espera. Para las
--      LLEGADAS se calla mientras despacho_activo esté encendido; las salidas y
--      todo lo demás, igual que antes. pool_unclaimed_alerts copiada DESDE 0126.
-- =============================================================================
BEGIN;

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

CREATE OR REPLACE FUNCTION public.despacho_avisar(p_ra uuid, p_tipo text, p_sale timestamptz, p_espera int DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments%ROWTYPE;
  j record; v_n int := 0; v_quien text;
BEGIN
  IF p_tipo NOT IN ('sin_carro', 'espera_larga') THEN RETURN 0; END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_ra;
  IF ra.id IS NULL OR ra.organization_id IS NULL THEN RETURN 0; END IF;
  SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
    FROM public.route_stops rs
    LEFT JOIN public.reservations r ON r.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = ra.id;
  FOR j IN SELECT profile_id FROM public.ops_alert_recipients_of(ra.organization_id) LOOP
    IF public.trip_notify(j.profile_id, 'Una llegada necesita apoyo ⚠️',
         coalesce(v_quien, 'Una llegada') || ' sale de JMC a las ' || public.hm_bog(coalesce(p_sale, ra.planned_start_at))
         || CASE WHEN p_tipo = 'sin_carro' THEN ' y ningún conductor en turno alcanza a hacer esa recogida.'
                 ELSE ' y el carro más cercano se demoraría ' || coalesce(p_espera, 0)::text || ' min en llegar.' END
         || ' Manda apoyo o asígnala en Asignación.',
         '/#/rutas', 'desp-apoyo:' || ra.id::text || ':' || j.profile_id::text) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n > 0 THEN
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, kind, exit_at, wait_min, who)
    VALUES (ra.organization_id, ra.id, p_tipo, p_sale, p_espera, v_quien);
    PERFORM public.trip_kick();
  END IF;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.pool_unclaimed_alerts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v int := 0; r record; v_desp boolean;
BEGIN
  -- 0159: con el despacho encendido, una LLEGADA en espera no es «nadie la ha tomado»:
  -- la está esperando el sistema, y si nadie alcanza avisa él (despacho_avisar).
  SELECT coalesce(despacho_activo, false) INTO v_desp FROM public.app_settings WHERE id = 'singleton';
  FOR r IN
    SELECT ra.id, ra.organization_id, ra.direction,
           coalesce((SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id), ra.planned_start_at) AS t0,
           (SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order)
              FROM public.route_stops rs JOIN public.reservations res ON res.id = rs.reservation_id
              JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = ra.id) AS quienes
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.driver_profile_id IS NULL AND ra.status = 'planned' AND ra.organization_id IS NOT NULL
       AND ra.delegated_at IS NULL   -- 0126: la delegada no espera a nadie
       AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)
  LOOP
    CONTINUE WHEN r.t0 IS NULL OR r.t0 < now() OR r.t0 > now() + interval '60 minutes';
    CONTINUE WHEN coalesce(v_desp, false) AND r.direction = 'airport_to_home';   -- 0159
    v := v + (SELECT count(*) FROM (
      SELECT public.trip_notify(j.profile_id, 'Nadie ha tomado una vuelta ⚠️',
               CASE WHEN r.direction = 'home_to_airport' THEN 'Recogida ' ELSE 'Llegada ' END || public.hm_bog(r.t0) || ' · ' || coalesce(r.quienes, '')
                 || '. Faltan ' || greatest(1, round(extract(epoch FROM (r.t0 - now())) / 60)::int) || ' min.',
               '/#/rutas', 'unclaimed:' || r.id::text || ':' || j.profile_id::text) AS ok
        FROM public.ops_alert_recipients_of(r.organization_id) j) z WHERE z.ok);
  END LOOP;
  IF v > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_asignar(uuid, uuid, timestamptz, timestamptz, int) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_avisar(uuid, text, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_avisar(uuid, text, timestamptz, int) TO service_role;
REVOKE ALL ON FUNCTION public.pool_unclaimed_alerts() FROM PUBLIC, anon, authenticated;

COMMIT;
