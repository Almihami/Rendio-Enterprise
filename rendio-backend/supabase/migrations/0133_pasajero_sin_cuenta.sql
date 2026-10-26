-- =============================================================================
-- 0133 · Pasajeros sin cuenta en la ruta de Julián (Kriss) (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (lista del 26-oct, URGENTE): «revisar cómo parametrizar
-- para que el diurna inserte en ruta a Kriss y los que no están registrados».
-- Leído (dicho a la profa el 26-oct): que la ruta de Julián pueda llevar a quien
-- no tiene cuenta en la app. Hasta hoy una parada ERA una reserva (y una reserva
-- exige un tripulante con cuenta): el 26-oct Kriss se quedó por fuera y hubo que
-- meterla como nota.
--
-- QUÉ HACE
--   1. route_stops: la parada puede ser de un PASAJERO SIN CUENTA — sin reserva,
--      con nombre, lugar (texto y, si se reconoce, el conjunto con su punto) y
--      teléfono opcional. Una de dos: reserva o nombre (CHECK).
--      Revisado: ningún disparador ni función revienta con reservation_id vacío
--      (los de route_stops hacen «WHERE id = NULL» = nada) y ninguna consulta usa
--      «NOT IN (SELECT reservation_id …)», que con un NULL se apagaría sola.
--   2. admin_manual_route_publish: la copia de 0125 + los sin cuenta. El bloque
--      trae {"guest": {"name", "place", "residence_id", "phone"}, "at"}. A ellos no
--      se les avisa (no tienen app); la firma de la vuelta los incluye por nombre,
--      así volver a pegar sin cambios conserva la vuelta y su conductor. Lo único
--      nuevo son las líneas marcadas «0133».
--   3. driver_set_guest_stop_status(parada, estado): el conductor marca la parada
--      del sin cuenta igual que las demás (llegó, a bordo, entregado, no se
--      presentó; «Deshacer» la devuelve a «llegó»). Así su vuelta TERMINA (0128).
-- Lo que NO cambia: lo del tripulante (avisos, «mis viajes») va por reservas y no
-- los ve; el número «Vas 2 de 3» del tripulante no los cuenta.
-- Idempotente. Necesita 0125. Down: down_migrations/0133_pasajero_sin_cuenta.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La parada del pasajero sin cuenta
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_stops ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_name         text;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_place        text;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_phone        text;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_residence_id uuid REFERENCES public.residences(id) ON DELETE SET NULL;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_lat          double precision;
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS guest_lng          double precision;
ALTER TABLE public.route_stops DROP CONSTRAINT IF EXISTS route_stops_reserva_o_sin_cuenta;
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_reserva_o_sin_cuenta
  CHECK ((reservation_id IS NOT NULL AND guest_name IS NULL)
      OR (reservation_id IS NULL AND guest_name IS NOT NULL AND length(btrim(guest_name)) >= 2));
COMMENT ON COLUMN public.route_stops.guest_name IS
  '0133: pasajero SIN CUENTA en la app (Kriss): la parada no tiene reserva. Lo pone la ruta de Julián; no recibe avisos.';

-- -----------------------------------------------------------------------------
-- 2. El conductor marca la parada del sin cuenta
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_set_guest_stop_status(p_stop uuid, p_status text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_drv uuid := public.current_driver_id();
  v_st  text;
BEGIN
  IF v_drv IS NULL THEN
    RAISE EXCEPTION 'solo un conductor puede actualizar el estado de una parada' USING ERRCODE = '42501';
  END IF;
  v_st := CASE
    WHEN p_status = 'at_pickup'                THEN 'arrived'
    WHEN p_status IN ('on_board', 'picked_up') THEN 'picked_up'
    WHEN p_status = 'delivered'                THEN 'delivered'
    WHEN p_status = 'no_show'                  THEN 'no_show'
    WHEN p_status IN ('en_route', 'en_route_home') THEN NULL   -- va rodando: la parada sigue igual
    ELSE '?' END;
  IF v_st = '?' THEN RAISE EXCEPTION 'estado no válido: %', p_status USING ERRCODE = '22023'; END IF;
  IF v_st IS NULL THEN
    PERFORM 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
     WHERE rs.id = p_stop AND rs.reservation_id IS NULL AND ra.driver_profile_id = v_drv AND ra.status IN ('planned', 'in_progress');
    IF NOT FOUND THEN RAISE EXCEPTION 'esa parada no está en una vuelta activa tuya' USING ERRCODE = 'P0002'; END IF;
    RETURN;
  END IF;
  UPDATE public.route_stops rs
     SET status = v_st,
         actual_arrival_at = CASE WHEN v_st IN ('arrived', 'no_show') THEN coalesce(rs.actual_arrival_at, now()) ELSE rs.actual_arrival_at END,
         -- «Deshacer» (vuelve a «llegó»): se borra la hora de abordar, como en 0102.
         actual_pickup_at  = CASE WHEN v_st = 'picked_up' THEN coalesce(rs.actual_pickup_at, now())
                                  WHEN v_st = 'arrived' THEN NULL ELSE rs.actual_pickup_at END,
         actual_dropoff_at = CASE WHEN v_st = 'delivered' THEN coalesce(rs.actual_dropoff_at, now()) ELSE rs.actual_dropoff_at END
    FROM public.route_assignments ra
   WHERE rs.id = p_stop AND rs.reservation_id IS NULL
     AND ra.id = rs.route_assignment_id AND ra.driver_profile_id = v_drv AND ra.status IN ('planned', 'in_progress');
  IF NOT FOUND THEN RAISE EXCEPTION 'esa parada no está en una vuelta activa tuya' USING ERRCODE = 'P0002'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_set_guest_stop_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_set_guest_stop_status(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.driver_set_guest_stop_status(uuid, text)
  IS '0133: el conductor marca la parada de un pasajero sin cuenta (llegó / a bordo / entregado / no se presentó; at_pickup = Deshacer). Solo en su vuelta activa.';

-- -----------------------------------------------------------------------------
-- 3. Publicar la ruta de Julián con los sin cuenta (copia de 0125 + «0133»)
-- -----------------------------------------------------------------------------
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
     WHERE rs.route_assignment_id = ra.id AND NOT ra.pool AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
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

COMMIT;
