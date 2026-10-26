-- Reversa de 0147 · El aviso del regreso de reserva dice dónde lo recogen.
-- Vuelve a poner las cinco funciones como estaban (0143, 0138, 0129, 0131, 0145)
-- y quita lugar_del_regreso. Los avisos ya enviados quedan como están.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid := public.current_user_org();
  b          jsonb;
  st         jsonb;
  v_type     text;
  v_dir      public.trip_direction;
  v_ids      uuid[];
  v_sig      text;
  v_first    timestamptz;
  v_start    timestamptz;
  v_dead     timestamptz;
  v_flight   text;
  v_ra       uuid;
  v_old      record;
  v_kept     int := 0;
  v_created  int := 0;
  v_removed  int := 0;
  v_skipped  int := 0;
  v_notified int := 0;
  v_drivers  int := 0;
  v_keep     uuid[] := ARRAY[]::uuid[];
  v_busy     uuid[];
  v_used     uuid[] := ARRAY[]::uuid[];
  v_tocadas  uuid[];
  v_tablero  int := 0;
  i          int;
  v_res      record;
  v_at       timestamptz;
  v_title    text;
  v_body     text;
  v_total    int := 0;
  -- 0133: los pasajeros sin cuenta (Kriss): van en la ruta, no se les avisa.
  v_gs       jsonb;
  v_gfirst   timestamptz;
  v_gname    text;
  v_gid      uuid;
  v_grid     uuid;
  v_glat     double precision;
  v_glng     double precision;
  v_gplace   text;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica la ruta' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'Falta la ruta' USING ERRCODE = '22023';
  END IF;

  -- Reservas que ya van en una vuelta ARRANCADA de este día: no se vuelven a poner.
  SELECT coalesce(array_agg(DISTINCT rs.reservation_id), ARRAY[]::uuid[]) INTO v_busy
    FROM public.route_assignments ra JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
     AND (ra.status IN ('in_progress', 'completed')
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  FOR b IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
    v_type := CASE WHEN b->>'type' = 'lle' THEN 'lle' ELSE 'sal' END;
    v_dir := CASE WHEN v_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
    -- Solo reservas vivas de la organización y que no estén en una vuelta arrancada.
    SELECT array_agg(x.rid ORDER BY x.ord), min(x.at)
      INTO v_ids, v_first
      FROM (SELECT (s->>'reservation_id')::uuid AS rid, (s->>'at')::timestamptz AS at, o AS ord
              FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)) x
      JOIN public.reservations r ON r.id = x.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org AND r.cancelled_at IS NULL AND r.direction = v_dir
       AND NOT (x.rid = ANY (v_busy)) AND NOT (x.rid = ANY (v_used));
    -- 0133: los sin cuenta del bloque (nombre de 2 letras o más).
    SELECT jsonb_agg(s ORDER BY o), min((s->>'at')::timestamptz)
      INTO v_gs, v_gfirst
      FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)
     WHERE jsonb_typeof(s->'guest') = 'object' AND length(btrim(coalesce(s->'guest'->>'name', ''))) >= 2;
    v_skipped := v_skipped + coalesce(jsonb_array_length(b->'stops'), 0) - coalesce(cardinality(v_ids), 0) - coalesce(jsonb_array_length(v_gs), 0);
    IF coalesce(cardinality(v_ids), 0) = 0 AND v_gs IS NULL THEN CONTINUE; END IF;
    v_ids := coalesce(v_ids, ARRAY[]::uuid[]);
    v_first := least(v_first, v_gfirst);
    v_used := v_used || v_ids;
    v_total := v_total + 1;
    -- 0133: la firma también lleva a los sin cuenta (por nombre); sin ellos es la de 0125.
    v_sig := v_dir::text || ':' || coalesce((SELECT string_agg(u::text, ',' ORDER BY u::text) FROM unnest(v_ids) u), '')
          || coalesce('|g:' || (SELECT string_agg(lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')), ',' ORDER BY lower(regexp_replace(btrim(g->'guest'->>'name'), '\s+', ' ', 'g')))
                                 FROM jsonb_array_elements(v_gs) g), '');
    v_dead := nullif(b->>'deadline_at', '')::timestamptz;
    v_flight := nullif(btrim(b->>'flight'), '');
    -- La llegada sale de JMC cuando el tripulante ya bajó: aterrizaje + desembarque (0058/0099).
    v_start := CASE WHEN v_type = 'lle'
                    THEN v_first + make_interval(mins => coalesce(public.flight_deplane_min(v_flight), 15))
                    ELSE v_first END;

    -- ¿Ya estaba esta misma vuelta (las mismas personas)? Se conserva, con su conductor.
    SELECT ra.id INTO v_ra
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT coalesce(ra.auto_created, false)   -- 0143: una vuelta armada sola no es «la misma vuelta» pegada
       AND (ra.direction::text || ':' || coalesce((SELECT string_agg(rs.reservation_id::text, ',' ORDER BY rs.reservation_id::text)
                                           FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NOT NULL), '')
            || coalesce('|g:' || (SELECT string_agg(lower(rs.guest_name), ',' ORDER BY lower(rs.guest_name))
                                   FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.reservation_id IS NULL), '')) = v_sig
     LIMIT 1;
    IF v_ra IS NOT NULL THEN
      UPDATE public.route_assignments
         SET planned_start_at = v_start, deadline_at = v_dead, manual_note = nullif(btrim(b->>'note'), ''), updated_at = now()
       WHERE id = v_ra;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                            pool, organization_id, manual_day, deadline_at, manual_note)
      VALUES (NULL, NULL, v_dir, 'planned', v_start, true, v_org, p_day, v_dead, nullif(btrim(b->>'note'), ''))
      RETURNING id INTO v_ra;
      v_created := v_created + 1;
    END IF;
    v_keep := v_keep || v_ra;

    -- Las paradas, en el orden del jefe (se reescriben: orden y horas pueden cambiar).
    -- Primero se corren a números altos para no chocar con el UNIQUE del orden.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra;
    i := 0;
    FOR st IN SELECT s FROM jsonb_array_elements(b->'stops') AS t(s) LOOP
      -- 0133: un pasajero sin cuenta es una parada con nombre y lugar (sin reserva).
      IF jsonb_typeof(st->'guest') = 'object' THEN
        v_gname := nullif(regexp_replace(btrim(coalesce(st->'guest'->>'name', '')), '\s+', ' ', 'g'), '');
        CONTINUE WHEN v_gname IS NULL OR length(v_gname) < 2;
        i := i + 1;
        v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
        v_grid := NULL; v_glat := NULL; v_glng := NULL; v_gplace := NULL;
        IF coalesce(st->'guest'->>'residence_id', '') ~ '^[0-9a-fA-F-]{36}$' THEN
          SELECT re.id, re.latitude, re.longitude, re.name INTO v_grid, v_glat, v_glng, v_gplace
            FROM public.residences re WHERE re.id = (st->'guest'->>'residence_id')::uuid AND re.organization_id = v_org;
        END IF;
        v_gplace := coalesce(nullif(btrim(coalesce(st->'guest'->>'place', '')), ''), v_gplace);
        SELECT rs.id INTO v_gid FROM public.route_stops rs
         WHERE rs.route_assignment_id = v_ra AND rs.reservation_id IS NULL AND lower(rs.guest_name) = lower(v_gname) LIMIT 1;
        IF v_gid IS NOT NULL THEN
          UPDATE public.route_stops
             SET stop_order = i, estimated_arrival_at = v_at, guest_name = v_gname, guest_place = v_gplace,
                 guest_phone = nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), guest_residence_id = v_grid, guest_lat = v_glat, guest_lng = v_glng
           WHERE id = v_gid;
        ELSE
          INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at,
                                          guest_name, guest_place, guest_phone, guest_residence_id, guest_lat, guest_lng)
          VALUES (v_ra, NULL, i, v_at, v_gname, v_gplace, nullif(btrim(coalesce(st->'guest'->>'phone', '')), ''), v_grid, v_glat, v_glng);
        END IF;
        CONTINUE;
      END IF;
      CONTINUE WHEN NOT ((st->>'reservation_id')::uuid = ANY (v_ids));
      i := i + 1;
      v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
      IF EXISTS (SELECT 1 FROM public.route_stops WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid) THEN
        UPDATE public.route_stops SET stop_order = i, estimated_arrival_at = v_at
         WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid;
      ELSE
        INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES (v_ra, (st->>'reservation_id')::uuid, i, v_at);
      END IF;
    END LOOP;
    DELETE FROM public.route_stops WHERE route_assignment_id = v_ra AND stop_order > 1000;

    -- Avisarle a cada uno su hora (una vez por hora: volver a pegar sin cambios no repite).
    FOR v_res IN
      SELECT r.id, r.direction, ap.profile_id AS crew, rs.estimated_arrival_at AS at, f.flight_number
        FROM public.route_stops rs
        JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        LEFT JOIN public.flights f ON f.id = r.flight_id
       WHERE rs.route_assignment_id = v_ra
    LOOP
      IF v_res.direction = 'home_to_airport' THEN
        v_title := 'Tu recogida está lista 🚗';
        v_body := 'Te recogemos a las ' || public.hm_bog(v_res.at)
          || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END
          || '. Te avisamos quién te recoge.';
      ELSE
        v_title := 'Tu regreso está listo 🚗';
        v_body := 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || '). Te avisamos quién te recoge.';
      END IF;
      IF public.trip_notify(v_res.crew, v_title, v_body, '/#/viaje?r=' || v_res.id::text,
                            'manual:' || v_res.id::text || ':' || to_char(coalesce(v_res.at, v_start) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')) THEN
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
    v_ra := NULL;
  END LOOP;

  -- Lo que Julián puso manda: esas personas salen de las vueltas del TABLERO que
  -- no han arrancado (si no, quedarían en dos carros); la que queda vacía se va.
  WITH quitadas AS (
    DELETE FROM public.route_stops rs USING public.route_assignments ra
     WHERE rs.route_assignment_id = ra.id AND (NOT ra.pool OR coalesce(ra.auto_created, false))   -- 0143: también las armadas solas
       AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  -- 0143: si una vuelta armada sola quedó vacía y ya la había tomado un conductor, se le avisa.
  PERFORM public.trip_notify(dp.profile_id, 'Cambió una vuelta que tomaste',
            'Julián cambió la vuelta de las ' || public.hm_bog(ra.planned_start_at) || '. Revisa las vueltas disponibles.',
            '/#/ruta', 'manualdrop:' || ra.id::text)
     FROM public.route_assignments ra JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
    WHERE ra.id = ANY (v_tocadas) AND coalesce(ra.auto_created, false)
      AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT coalesce(ra.auto_created, false)   -- 0143: las armadas solas no son de Julián: se quedan
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
  LOOP
    DELETE FROM public.route_assignments WHERE id = v_old.id;
    v_removed := v_removed + 1;
    IF v_old.drv_profile IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_profile, 'Cambió una vuelta que tomaste',
        'Julián cambió la vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '. Revisa las vueltas disponibles.',
        '/#/ruta', 'manualdrop:' || v_old.id::text);
    END IF;
  END LOOP;

  -- Lo que el jefe eligió a mano se aprende para la próxima vez.
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    JOIN public.auxiliar_profiles ap ON ap.id = (a->>'auxiliar_profile_id')::uuid
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();

  -- Los conductores: hay vueltas para tomar (una vez por ruta pegada).
  IF v_created > 0 THEN
    SELECT count(*) INTO v_drivers FROM (
      SELECT public.trip_notify(p.id, 'Hay vueltas para tomar',
               'Julián publicó la ruta del ' || to_char(p_day, 'DD/MM') || ': ' || v_total || ' vueltas. Toma las tuyas en Ruta.',
               '/#/ruta', 'manualpool:' || v_org::text || ':' || p_day::text || ':' || md5(array_to_string(v_keep, ',')) || ':' || p.id::text) AS ok
        FROM public.profiles p
       WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false) z
     WHERE z.ok;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('created', v_created, 'kept', v_kept, 'removed', v_removed, 'skipped', v_skipped,
                            'notified', v_notified, 'drivers', v_drivers, 'vueltas', v_total, 'from_board', v_tablero);
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

CREATE OR REPLACE FUNCTION public.admin_route_delegate(p_route uuid, p_name text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    uuid := public.current_user_org();
  ra       public.route_assignments;
  v_name   text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_phone  text := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '\s+', ' ', 'g'), '');
  v_dig    text;
  v_prev   uuid;
  v_era    boolean;
  v_sello  text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  v_n      int := 0;
  v_cid    uuid;
  c        record;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe delega una vuelta' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'Escribe el nombre de quien hace la vuelta' USING ERRCODE = '22023';
  END IF;
  v_dig := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
  IF length(v_dig) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'Escribe un teléfono de contacto válido' USING ERRCODE = '22023';
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
  IF ra.status <> 'planned' OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'Esa vuelta ya arrancó: no se puede delegar' USING ERRCODE = 'P0001';
  END IF;
  v_era := ra.delegated_at IS NOT NULL;
  IF v_era AND ra.delegate_name IS NOT DISTINCT FROM v_name
     AND regexp_replace(coalesce(ra.delegate_phone, ''), '\D', '', 'g') = v_dig THEN
    RETURN jsonb_build_object('id', ra.id, 'delegated', true, 'unchanged', true);
  END IF;

  SELECT dp.profile_id INTO v_prev FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
  UPDATE public.route_assignments
     SET delegated_at = coalesce(delegated_at, now()), delegated_by = coalesce(delegated_by, auth.uid()),
         driver_profile_id = NULL, vehicle_id = NULL,
         delegate_name = v_name, delegate_phone = v_phone, updated_at = now()
   WHERE id = ra.id RETURNING * INTO ra;
  PERFORM public.route_sync_assigned(ra.id);
  PERFORM public.sync_calculated_pickup(rs.reservation_id) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id;

  -- La libreta: un teléfono es una persona (se actualiza el nombre y el uso).
  UPDATE public.delegate_contacts SET name = v_name, phone = v_phone, last_used_at = now()
   WHERE organization_id = v_org AND deleted_at IS NULL AND regexp_replace(phone, '\D', '', 'g') = v_dig
  RETURNING id INTO v_cid;
  IF v_cid IS NULL THEN
    INSERT INTO public.delegate_contacts (organization_id, name, phone, last_used_at, created_by)
    VALUES (v_org, v_name, v_phone, now(), auth.uid()) RETURNING id INTO v_cid;
  END IF;

  FOR c IN
    SELECT r.id, r.direction, ap.profile_id AS crew, r.calculated_pickup_at AS at
      FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE rs.route_assignment_id = ra.id AND r.cancelled_at IS NULL
  LOOP
    IF public.trip_notify(c.crew, 'Te recogerá ' || public.short_name(v_name) || ' 🤝',
         CASE WHEN c.direction = 'home_to_airport'
              THEN 'Tu recogida' || coalesce(' de las ' || public.hm_bog(c.at), '') || ' la hace ' || public.short_name(v_name) || '.'
              ELSE public.short_name(v_name) || ' te espera en JMC cuando aterrices.' END
         || ' Su número de contacto es ' || v_phone || '.',
         '/#/viaje?r=' || c.id::text, 'delegto:' || ra.id::text || ':' || c.id::text || ':' || v_sello) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_prev IS NOT NULL THEN
    PERFORM public.trip_notify(v_prev, 'Ya no haces una vuelta',
      'Coordinación delegó la vuelta de las ' || public.hm_bog(ra.planned_start_at) || ': la hace alguien de afuera.',
      '/#/ruta', 'delegdrv:' || ra.id::text || ':' || v_prev::text || ':' || v_sello);
  END IF;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', ra.id, 'delegated', true, 'name', v_name, 'phone', v_phone, 'contact_id', v_cid,
    'notified', v_n, 'driver_removed', v_prev IS NOT NULL, 'was_delegated', v_era);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_route_delegate(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_route_delegate(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.admin_route_delegate(uuid, text, text)
  IS '0131: delega UNA vuelta publicada a alguien de afuera (nombre + teléfono) o le cambia a quién; la anota en la libreta y avisa a cada tripulante «Te recogerá X · su número es Y». Solo vueltas que no han arrancado.';

CREATE OR REPLACE FUNCTION public.admin_manual_route_set_times(
  p_route uuid, p_stops jsonb DEFAULT '[]'::jsonb, p_start timestamptz DEFAULT NULL, p_deadline timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      v_donde := CASE c.reserve_place WHEN 'rio_verde' THEN 'en el Hotel Río Verde' WHEN 'movich' THEN 'en el Hotel Movich'
                                      WHEN 'aero' THEN 'en JMC' ELSE NULL END;
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
$$;
REVOKE ALL ON FUNCTION public.admin_manual_route_set_times(uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_manual_route_set_times(uuid, jsonb, timestamptz, timestamptz) TO authenticated;

DROP FUNCTION IF EXISTS public.lugar_del_regreso(uuid);

COMMIT;
