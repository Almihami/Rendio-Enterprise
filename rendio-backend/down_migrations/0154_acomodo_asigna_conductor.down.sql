-- Down de 0154: reub_nota y acomodar_eventualidades vuelven a las de 0144; se quitan las ayudantes.
-- (Generado copiando los cuerpos de 0144_avisos_por_turno_y_freno.sql.)
BEGIN;

CREATE OR REPLACE FUNCTION public.reub_nota(p jsonb)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p->>'kind'
    WHEN 'retimed' THEN 'Se resolvió sola: su vuelta pasó de las ' || coalesce(public.hm_bog((p->>'from_at')::timestamptz), '?')
                        || ' a las ' || public.hm_bog((p->>'start_at')::timestamptz)
                        || CASE WHEN coalesce((p->>'pooled')::boolean, false) THEN '; su conductor no alcanzaba y quedó para que otro la tome'
                                WHEN p->>'driver_name' IS NOT NULL THEN ' (sigue con ' || (p->>'driver_name') || ')' ELSE '' END || '.'
    WHEN 'joined'  THEN 'Se resolvió sola: pasó a la vuelta de las ' || public.hm_bog((p->>'start_at')::timestamptz)
                        || coalesce(' de ' || (p->>'driver_name'), ' (para tomar)')
                        || CASE WHEN p->>'dir' = 'home_to_airport' AND p->>'pickup_at' IS NOT NULL
                                THEN ', recogida ' || public.hm_bog((p->>'pickup_at')::timestamptz) ELSE '' END || '.'
    WHEN 'new'     THEN 'Se resolvió sola: no cabía en ninguna vuelta y se creó una vuelta nueva para tomar a las '
                        || public.hm_bog((p->>'pickup_at')::timestamptz) || '.'
    WHEN 'held'    THEN 'No se acomodó sola: el freno del acomodo estaba puesto (ya había armado varias vueltas en poco tiempo). Un jefe tiene que ubicarla.'
    ELSE 'Se actualizó la reserva: ese día todavía no tiene ruta publicada (entra al publicarla).' END
    || CASE WHEN coalesce((p->>'was_delegated')::boolean, false) THEN ' OJO: estaba en una vuelta DELEGADA: avísale a quien la iba a hacer.' ELSE '' END
    || CASE WHEN coalesce((p->>'tight')::boolean, false) AND p->>'kind' IS DISTINCT FROM 'held' THEN ' OJO: queda muy encima de la hora: revisa que alguien la tome.' ELSE '' END;
$$;
REVOKE ALL ON FUNCTION public.reub_nota(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record; m record; cf record; lb record; e record;
  v_need timestamptz; v_late int; v_total int; v_start timestamptz; v_delta interval;
  v_ok boolean; v_reub jsonb; v_drv_prof uuid; v_drv_name text; v_org uuid; v_dia date; v_cut int;
  n_vuelos int := 0; n_cambios int := 0; n_sin int := 0; n_err int := 0;
  n_frenadas int := 0; v_max int; fo record; v_orgs_frenadas uuid[] := ARRAY[]::uuid[];   -- 0144
  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
BEGIN
  SELECT route_night_cutoff_min INTO v_cut FROM public.app_settings WHERE id = 'singleton';
  v_cut := coalesce(v_cut, 120);

  -- a) LLEGADAS: vuelta por vuelta (sin arrancar, sin delegar), quién baja después
  --    de que la vuelta sale de JMC según Flightradar24.
  FOR v IN
    SELECT ra.id, ra.planned_start_at, ra.driver_profile_id, ra.pool, ra.manual_day,
           coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                     JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
                    WHERE x.route_assignment_id = ra.id LIMIT 1)) AS org
      FROM public.route_assignments ra
     WHERE ra.direction = 'airport_to_home' AND ra.status = 'planned' AND ra.delegated_at IS NULL
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool)
       AND ra.planned_start_at BETWEEN p_now - interval '1 hour' AND p_now + interval '30 hours'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.reservation_id IS NOT NULL)
  LOOP
    BEGIN
      v_need := NULL; v_late := 0; v_total := 0;
      FOR m IN
        SELECT r.id AS rid, r.required_arrival_at, r.flight_code, public.reub_baja(v.org, r.flight_code, r.required_arrival_at) AS baja,
               CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
                    ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END AS desemb
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
         WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
      LOOP
        v_total := v_total + 1;
        IF m.baja IS NOT NULL AND m.baja + make_interval(mins => m.desemb) > v.planned_start_at + interval '5 minutes' THEN
          v_late := v_late + 1;
        END IF;
        v_need := greatest(v_need, coalesce(m.baja, m.required_arrival_at) + make_interval(mins => m.desemb));
      END LOOP;
      CONTINUE WHEN v_late = 0;

      IF v_late = v_total THEN
        -- Vienen tarde TODOS: la vuelta entera se corre (nadie queda atrás).
        v_start := public.reub_arriba5(v_need);
        v_delta := v_start - v.planned_start_at;
        SELECT * INTO e FROM public.reub_extremos(v.id);
        v_ok := public.reub_conductor_libre(v.driver_profile_id, v.id, NULL, e.ini_at + v_delta, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
                                            e.fin_at + v_delta, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air)
                AND public.reub_mismo_turno(v.driver_profile_id, v.id, e.ini_at, e.fin_at, e.ini_at + v_delta, e.fin_at + v_delta);
        SELECT dp.profile_id, pp.full_name INTO v_drv_prof, v_drv_name
          FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = v.driver_profile_id;
        IF v_ok THEN
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
              'El vuelo viene tarde: tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' ahora sale de JMC a las ' || public.hm_bog(v_start) || '.',
              '/', 'flt-drvtime:' || v.id::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
        ELSE
          -- Su conductor no alcanza: queda para tomar, todos juntos, a la hora nueva.
          v_dia := (v_start AT TIME ZONE 'America/Bogota')::date;
          IF extract(hour FROM v_start AT TIME ZONE 'America/Bogota') * 60 + extract(minute FROM v_start AT TIME ZONE 'America/Bogota') < v_cut THEN
            v_dia := v_dia - 1;
          END IF;
          UPDATE public.route_assignments
             SET planned_start_at = v_start, driver_profile_id = NULL, vehicle_id = NULL, pool = true, auto_created = true,
                 organization_id = v.org, manual_day = coalesce(manual_day, v_dia),
                 manual_note = 'Quedó para tomar sola: el vuelo llegó tarde y su conductor no alcanzaba', updated_at = now()
           WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Ya no haces una vuelta',
              'El vuelo de tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' viene tarde y a las ' || public.hm_bog(v_start)
              || ' no alcanzas: quedó para que otro conductor la tome.', '/', 'flt-drop:' || v.id::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
          -- 0144: solo a los conductores del turno de esa vuelta.
          PERFORM public.avisar_vuelta_para_tomar(v.org, v_start, 'Hay una vuelta para tomar',
            'Llegada de las ' || public.hm_bog(v_start) || ': el vuelo viene tarde y su conductor no alcanza.',
            'flt-pool:' || v.id::text);
          v_drv_name := NULL;
        END IF;
        UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
         WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
                   JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          PERFORM public.sync_calculated_pickup(m.rid);
          PERFORM public.trip_notify(m.crew, 'Tu vuelo viene a otra hora ✈️',
            'Tu vuelo viene tarde: te esperamos en JMC a las ' || public.hm_bog(v_start)
            || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
            '/#/viaje?r=' || m.rid::text, 'flt-time:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja más tarde: la vuelta salía de JMC a las ' || public.hm_bog(v.planned_start_at) || '.',
            jsonb_build_object('kind', 'retimed', 'dir', 'airport_to_home', 'from_at', v.planned_start_at, 'start_at', v_start, 'pickup_at', v_start,
                               'driver_name', v_drv_name, 'pooled', NOT v_ok, 'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok,
                               'was_delegated', false, 'removed', 0),
            'fltauto:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'), jsonb_build_object('kind', 'flight_api'));
        END LOOP;
        PERFORM public.trip_kick();
        n_vuelos := n_vuelos + v_total;
      ELSE
        -- Solo algunos vienen tarde: esos se reubican; los demás siguen igual.
        FOR m IN
          SELECT r.id AS rid, r.flight_code, public.reub_baja(v.org, r.flight_code, r.required_arrival_at) AS baja,
                 CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
                      ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END AS desemb
            FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
           WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          CONTINUE WHEN m.baja IS NULL OR m.baja + make_interval(mins => m.desemb) <= v.planned_start_at + interval '5 minutes';
          v_reub := public.reubicar_reserva(m.rid, m.baja + make_interval(mins => m.desemb), 'vuelo');
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja a las ' || public.hm_bog(m.baja) || ' y su vuelta salía de JMC a las '
            || public.hm_bog(v.planned_start_at) || '.',
            v_reub, 'fltauto:' || m.rid::text || ':' || to_char(m.baja AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'), jsonb_build_object('kind', 'flight_api'));
          n_vuelos := n_vuelos + 1;
          IF v_reub->>'kind' = 'held' THEN n_frenadas := n_frenadas + 1; END IF;   -- 0144
        END LOOP;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar vuelo (vuelta %): %', v.id, SQLERRM;
    END;
  END LOOP;

  -- b) Cambios de vuelo que se quedaron esperando a Coordinación: el ÚLTIMO de
  --    cada reserva, si la reserva sigue como estaba y la hora nueva no ha pasado.
  FOR cf IN
    SELECT DISTINCT ON (inc.reservation_id) inc.id, inc.reservation_id, inc.details, r.required_arrival_at, r.notes
      FROM public.incidents inc JOIN public.reservations r ON r.id = inc.reservation_id
     WHERE inc.status IN ('open', 'in_progress') AND inc.details->>'kind' = 'aux_change_flight'
       AND NOT coalesce((inc.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private'
     ORDER BY inc.reservation_id, inc.created_at DESC
  LOOP
    BEGIN
      v_new_when := (cf.details->>'new_when')::timestamptz;
      CONTINUE WHEN v_new_when IS NULL OR v_new_when <= p_now + interval '30 minutes';
      CONTINUE WHEN cf.required_arrival_at IS DISTINCT FROM (cf.details->>'old_when')::timestamptz;   -- alguien ya lo aplicó a mano
      v_new_flight := nullif(cf.details->>'new_flight', '');
      v_regreso := coalesce(cf.notes, '') ~* '\s*·\s*Regreso del mismo día\s*$';
      v_user := public.notes_without_flight(cf.notes);
      v_notes := CASE WHEN nullif(cf.details->>'new_reserve_place', '') IS NOT NULL THEN v_user
                      WHEN v_new_flight IS NULL THEN cf.notes
                      ELSE btrim('Vuelo ' || v_new_flight || '. ' || coalesce(v_user, '') || CASE WHEN v_regreso THEN ' · Regreso del mismo día' ELSE '' END) END;
      UPDATE public.reservations
         SET required_arrival_at = v_new_when,
             reserve_place = CASE WHEN cf.details ? 'new_reserve_place' THEN nullif(cf.details->>'new_reserve_place', '') ELSE reserve_place END,
             notes = nullif(v_notes, ''),
             flight_id = CASE WHEN nullif(cf.details->>'new_reserve_place', '') IS NOT NULL THEN NULL
                              WHEN v_new_flight IS NOT NULL AND v_new_flight IS DISTINCT FROM nullif(cf.details->>'old_flight', '') THEN NULL
                              ELSE flight_id END
       WHERE id = cf.reservation_id;
      v_reub := public.reubicar_reserva(cf.reservation_id, NULL, 'cambio');
      -- 0144: frenado. La reserva ya tiene su hora nueva (la pidió ella), su
      -- eventualidad sigue ABIERTA para un jefe y la próxima pasada no la repite
      -- (ya no está como old_when).
      IF v_reub->>'kind' = 'held' THEN n_frenadas := n_frenadas + 1; CONTINUE; END IF;
      UPDATE public.incidents SET status = 'resolved', resolved_at = now(),
             resolution_notes = 'El sistema aplicó el cambio que había pedido (' || to_char(v_new_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI')
                                || coalesce(' · vuelo ' || v_new_flight, '') || '). ' || public.reub_nota(v_reub)
       WHERE reservation_id = cf.reservation_id AND status IN ('open', 'in_progress') AND details->>'kind' = 'aux_change_flight'
         AND NOT coalesce((details->>'auto')::boolean, false);
      -- Si quedó encima o venía de una delegada, una abierta que les suene a los jefes.
      IF coalesce((v_reub->>'tight')::boolean, false) OR coalesce((v_reub->>'was_delegated')::boolean, false) THEN
        PERFORM public.reub_rastro(cf.reservation_id, CASE WHEN v_new_when > cf.required_arrival_at THEN 'flight_delay' ELSE 'flight_advanced' END,
          'Cambió su vuelo (' || to_char(cf.required_arrival_at AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') || ' → '
          || to_char(v_new_when AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') || coalesce(' · vuelo ' || v_new_flight, '') || ').',
          v_reub, 'cfauto:' || cf.id::text, jsonb_build_object('kind', 'aux_change_flight_auto'));
      END IF;
      n_cambios := n_cambios + 1;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar cambio de vuelo (reserva %): %', cf.reservation_id, SQLERRM;
    END;
  END LOOP;

  -- c) «X no tiene carro» abierta (0068/0127): se reubica.
  -- 0144 · FRENO por tanda: si a la vez hay más «sin carro» de los que el sistema
  -- puede armar en media hora, eso no son pedidos tarde: es un día sin ruta (el
  -- 26-oct fueron 34). No se acomoda ninguno de esa organización y a los jefes les
  -- llega UN aviso.
  SELECT acomodo_max_nuevas INTO v_max FROM public.app_settings WHERE id = 'singleton';
  v_max := coalesce(v_max, 4);
  FOR fo IN
    SELECT ii.organization_id AS org, count(DISTINCT ii.reservation_id)::int AS n
      FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
       AND ii.organization_id IS NOT NULL
     GROUP BY ii.organization_id
    HAVING count(DISTINCT ii.reservation_id) > v_max
  LOOP
    v_orgs_frenadas := array_append(v_orgs_frenadas, fo.org);
    n_frenadas := n_frenadas + fo.n;
    PERFORM public.acomodo_aviso_freno(fo.org,
      'Hay ' || fo.n || ' tripulantes «sin carro» al mismo tiempo. Eso parece un día sin ruta, no pedidos tarde: no acomodé a ninguno. Revisa Rutas del día.');
  END LOOP;
  FOR lb IN
    SELECT DISTINCT ON (ii.reservation_id) ii.id, ii.reservation_id FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
       AND (ii.organization_id IS NULL OR NOT (ii.organization_id = ANY (v_orgs_frenadas)))   -- 0144
     ORDER BY ii.reservation_id, ii.created_at DESC
  LOOP
    BEGIN
      v_reub := public.reubicar_reserva(lb.reservation_id, NULL, 'pedido');
      CONTINUE WHEN v_reub->>'kind' NOT IN ('joined', 'new', 'retimed');
      UPDATE public.incidents SET status = 'resolved', resolved_at = now(), resolution_notes = public.reub_nota(v_reub)
       WHERE reservation_id = lb.reservation_id AND status IN ('open', 'in_progress') AND category = 'late_booking';
      n_sin := n_sin + 1;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar sin carro (reserva %): %', lb.reservation_id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('vuelos', n_vuelos, 'cambios', n_cambios, 'sin_carro', n_sin, 'errores', n_err, 'frenadas', n_frenadas);
END;
$$;
REVOKE ALL ON FUNCTION public.acomodar_eventualidades(timestamptz) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.acomodo_otro_conductor(uuid, uuid);
DROP FUNCTION IF EXISTS public.acomodo_reasignar_permitido(uuid);

COMMIT;
