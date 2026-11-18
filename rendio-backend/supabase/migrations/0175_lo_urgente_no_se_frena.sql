-- 0175 · Lo que viaja en las próximas horas no se frena (17-nov-2026)
--
-- Harold, después de que esa noche cinco llegadas de las 23:00 se quedaran sin vuelta
-- (un Publicar de Asignación borró sus vueltas a las 7:04 p. m.) y el sistema no las
-- repusiera: «¿y si yo hubiese estado dormido?». El acomodo SÍ las vio (incidente
-- «sin carro» a las 6:45 p. m.), pero el freno de 0144 no dejó acomodar a ninguna:
-- la tanda (> 4 «sin carro» a la vez) contaba también 16 pedidos de MAÑANA, y el
-- tope de vueltas nuevas (4 en 30 min) se llenaba con esos mismos pedidos.
--
-- Qué cambia:
--   · app_settings.acomodo_urgente_horas (6): lo que viaja de aquí a esas horas es urgente.
--   · acomodar_eventualidades: lo urgente no lo cuenta la tanda y se acomoda siempre,
--     primero lo más próximo. En los tres bloques (vuelo tarde, cambio de vuelo, sin
--     carro) prende rendio.acomodo_urgente mientras reubica a una persona urgente.
--     Después de reponer, UN aviso a los jefes con nombres y horas. El aviso del freno
--     dice desde cuándo es lo frenado.
--   · acomodo_frenado: con rendio.acomodo_urgente = on no frena.
-- No cambia reubicar_reserva (decide igual dónde cabe cada persona). Funciones copiadas
-- de PRODUCCIÓN (iguales a dev) el 17-nov-2026: lo próximo que toque estas dos copia DESDE 0175.
-- Generada por scripts/_gen-0175.py.

BEGIN;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS acomodo_urgente_horas integer NOT NULL DEFAULT 6;
DO $$ BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_acomodo_urgente_horas_chk CHECK (acomodo_urgente_horas BETWEEN 0 AND 48);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.app_settings.acomodo_urgente_horas IS '0175: lo que viaja en las próximas N horas no lo detiene el freno del acomodo.';

CREATE OR REPLACE FUNCTION public.acomodo_frenado(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- 0175: mientras acomodar_eventualidades reubica a alguien que viaja en las próximas
  -- horas (rendio.acomodo_urgente = on), el tope de vueltas nuevas no lo frena.
  SELECT coalesce(current_setting('rendio.acomodo_urgente', true), '') IS DISTINCT FROM 'on'
     AND count(*) >= coalesce((SELECT s.acomodo_max_nuevas FROM public.app_settings s WHERE s.id = 'singleton'), 4)
    FROM public.acomodo_creadas x
   WHERE x.organization_id = p_org AND x.created_at > now() - interval '30 minutes';
$function$;

CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record; m record; cf record; lb record; e record;
  v_need timestamptz; v_late int; v_total int; v_start timestamptz; v_delta interval;
  v_ok boolean; v_reub jsonb; v_drv_prof uuid; v_drv_name text; v_org uuid; v_dia date; v_cut int;
  n_vuelos int := 0; n_cambios int := 0; n_sin int := 0; n_err int := 0;
  n_frenadas int := 0; v_max int; fo record; v_orgs_frenadas uuid[] := ARRAY[]::uuid[];   -- 0144
  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
  v_otro jsonb; v_de text; v_corridas boolean; v_quien text; v_rid1 uuid;   -- 0154
  v_urg_h int; v_urg_hasta timestamptz; v_rep jsonb := '{}'::jsonb; ro record;   -- 0175
BEGIN
  SELECT route_night_cutoff_min INTO v_cut FROM public.app_settings WHERE id = 'singleton';
  v_cut := coalesce(v_cut, 120);
  -- 0175: lo que viaja de aquí a acomodo_urgente_horas no se frena (ver el bloque c).
  SELECT acomodo_urgente_horas INTO v_urg_h FROM public.app_settings WHERE id = 'singleton';
  v_urg_hasta := p_now + make_interval(hours => coalesce(v_urg_h, 6));

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
      v_otro := NULL; v_de := NULL; v_corridas := false;   -- 0154
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
        -- 0154: la primera persona de la vuelta (para las llaves de los avisos y el texto).
        SELECT rs.reservation_id INTO v_rid1 FROM public.route_stops rs WHERE rs.route_assignment_id = v.id AND rs.reservation_id IS NOT NULL
         ORDER BY rs.stop_order LIMIT 1;
        SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) INTO v_quien
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
          JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
         WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL;
        IF v_ok THEN
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            -- 0154: la llave va por conductor y persona, no por id de vuelta (al re-publicar
            -- el id cambia: a Juan le llegó «Tu vuelta cambió de hora» 3 veces el 28-oct).
            PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
              'El vuelo viene tarde: tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' ahora sale de JMC a las ' || public.hm_bog(v_start) || '.',
              '/', 'flt-drvtime:' || v_drv_prof::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
        ELSE
          -- 0154 · Su conductor no alcanza la hora nueva. Antes quedaba «para tomar» sin
          -- nadie y nadie la tomaba (Henry, Jessica y Alejandra el 28-oct: un jefe tuvo
          -- que resolver a mano). Ahora primero se corre la hora y se busca a OTRO
          -- conductor del turno, con turno abierto, que llegue a tiempo y no se le cruce
          -- (cadena_candidato, el cálculo del detector de cadena 0152). Si hay, la hace
          -- él (sigue siendo una vuelta del tablero). Si no, o si el freno de
          -- reasignaciones está puesto, queda para tomar como antes.
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
           WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
          v_corridas := true;
          IF NOT v.pool AND public.acomodo_reasignar_permitido(v.org) THEN
            v_otro := public.acomodo_otro_conductor(v.id, v.driver_profile_id);
          END IF;
        END IF;
        IF v_otro IS NOT NULL THEN
          UPDATE public.route_assignments SET driver_profile_id = (v_otro->>'dp')::uuid, updated_at = now() WHERE id = v.id;
          v_de := public.short_name(v_drv_name);
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Ya no haces una vuelta',
              'El vuelo de tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' viene tarde y a las ' || public.hm_bog(v_start)
              || ' no alcanzas: la hace ' || public.short_name(v_otro->>'name') || '.',
              '/', 'flt-reasig-de:' || v_drv_prof::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
          PERFORM public.trip_notify((v_otro->>'profile')::uuid, 'Te asignamos una llegada 🛬',
            'Sale de JMC a las ' || public.hm_bog(v_start) || coalesce(' con ' || v_quien, '') || '. El vuelo vino tarde y '
            || coalesce(v_de, 'su conductor') || ' no alcanzaba. Revísala en Ruta.',
            '/#/ruta', 'flt-reasig-a:' || (v_otro->>'profile') || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          -- A los jefes, una línea (no es un problema: ya quedó resuelto).
          PERFORM public.trip_notify(j.profile_id, 'Pasé una llegada a otro conductor 🔁',
            'Llegada de las ' || public.hm_bog(v_start) || coalesce(' (' || v_quien || ')', '') || ': el vuelo vino tarde y '
            || coalesce(v_de, 'su conductor') || ' no alcanzaba. La hace ' || public.short_name(v_otro->>'name') || '.',
            '/#/rutas', 'flt-reasig-jefe:' || j.profile_id::text || ':' || coalesce(v_rid1::text, v.id::text) || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'))
            FROM public.ops_alert_recipients_of(v.org) j;
          v_drv_name := v_otro->>'name';
        ELSIF NOT v_ok THEN
          -- Nadie más alcanza: queda para tomar, todos juntos, a la hora nueva.
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
        IF NOT v_corridas THEN   -- 0154: si no se corrieron ya arriba
          UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
           WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        END IF;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
                   JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id WHERE rs.route_assignment_id = v.id AND r.cancelled_at IS NULL
        LOOP
          PERFORM public.sync_calculated_pickup(m.rid);
          PERFORM public.trip_notify(m.crew, 'Tu vuelo viene a otra hora ✈️',
            'Tu vuelo viene tarde: te esperamos en JMC cuando aterrices'   /* 0171: sin la hora de salida de JMC */
            || CASE WHEN v_drv_name IS NOT NULL THEN ', te lleva ' || split_part(btrim(v_drv_name), ' ', 1) || '.' ELSE '. Te avisamos quién te recoge.' END,
            '/#/viaje?r=' || m.rid::text, 'flt-time:' || m.rid::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          PERFORM public.reub_rastro(m.rid, 'flight_delay',
            'Vuelo ' || coalesce(m.flight_code, '') || ' baja más tarde: la vuelta salía de JMC a las ' || public.hm_bog(v.planned_start_at) || '.',
            jsonb_build_object('kind', 'retimed', 'dir', 'airport_to_home', 'from_at', v.planned_start_at, 'start_at', v_start, 'pickup_at', v_start,
                               'driver_name', v_drv_name, 'pooled', NOT v_ok AND v_otro IS NULL,
                               'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok AND v_otro IS NULL,
                               'reassigned_from', CASE WHEN v_otro IS NOT NULL THEN coalesce(v_de, 'su conductor') END,   -- 0154
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
          PERFORM set_config('rendio.acomodo_urgente', CASE WHEN m.baja <= v_urg_hasta THEN 'on' ELSE 'off' END, true);   -- 0175
          v_reub := public.reubicar_reserva(m.rid, m.baja + make_interval(mins => m.desemb), 'vuelo');
          PERFORM set_config('rendio.acomodo_urgente', 'off', true);   -- 0175
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
      PERFORM set_config('rendio.acomodo_urgente', CASE WHEN v_new_when <= v_urg_hasta THEN 'on' ELSE 'off' END, true);   -- 0175
      v_reub := public.reubicar_reserva(cf.reservation_id, NULL, 'cambio');
      PERFORM set_config('rendio.acomodo_urgente', 'off', true);   -- 0175
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
  -- 0175 (17-nov-2026, Harold: «¿y si yo hubiese estado dormido?»): esa noche un
  -- Publicar borró las vueltas de cinco llegadas de las 23:00 y el freno no dejó
  -- acomodar a NINGUNA, porque la tanda contaba también 16 pedidos de MAÑANA. Ahora
  -- lo que viaja en las próximas app_settings.acomodo_urgente_horas (6) no se frena
  -- nunca: ni lo cuenta la tanda ni lo detiene el tope de vueltas nuevas
  -- (acomodo_frenado). Se acomoda primero, por hora, y a los jefes les llega UN
  -- aviso con nombres y horas. La tanda solo cuenta lo de más adelante.
  SELECT acomodo_max_nuevas INTO v_max FROM public.app_settings WHERE id = 'singleton';
  v_max := coalesce(v_max, 4);
  FOR fo IN
    SELECT ii.organization_id AS org, count(DISTINCT ii.reservation_id)::int AS n, min(r.required_arrival_at) AS primero
      FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
     WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
       AND r.required_arrival_at > v_urg_hasta   -- 0175: lo de las próximas horas no cuenta
       AND ii.organization_id IS NOT NULL
     GROUP BY ii.organization_id
    HAVING count(DISTINCT ii.reservation_id) > v_max
  LOOP
    v_orgs_frenadas := array_append(v_orgs_frenadas, fo.org);
    n_frenadas := n_frenadas + fo.n;
    PERFORM public.acomodo_aviso_freno(fo.org,
      'Hay ' || fo.n || ' tripulantes «sin carro» para más adelante (el primero, el ' || to_char(fo.primero AT TIME ZONE 'America/Bogota', 'DD/MM')
      || ' a las ' || public.hm_bog(fo.primero) || '). Eso parece un día sin ruta, no pedidos tarde: a esos no los acomodé. A los que viajan en las próximas '
      || coalesce(v_urg_h, 6) || ' horas sí. Revisa Rutas del día.');
  END LOOP;
  FOR lb IN
    SELECT x.* FROM (
      SELECT DISTINCT ON (ii.reservation_id) ii.id, ii.reservation_id, ii.organization_id AS org, r.required_arrival_at AS req,
             r.required_arrival_at <= v_urg_hasta AS urg,   -- 0175
             (SELECT p.full_name FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id WHERE ap.id = r.auxiliar_profile_id) AS nombre
        FROM public.incidents ii JOIN public.reservations r ON r.id = ii.reservation_id
       WHERE ii.status IN ('open', 'in_progress') AND ii.category = 'late_booking' AND NOT coalesce((ii.details->>'auto')::boolean, false)
         AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
         AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                          WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))
         AND (r.required_arrival_at <= v_urg_hasta OR ii.organization_id IS NULL OR NOT (ii.organization_id = ANY (v_orgs_frenadas)))   -- 0144 + 0175
       ORDER BY ii.reservation_id, ii.created_at DESC) x
     ORDER BY x.req   -- 0175: primero lo más próximo
  LOOP
    BEGIN
      PERFORM set_config('rendio.acomodo_urgente', CASE WHEN lb.urg THEN 'on' ELSE 'off' END, true);   -- 0175
      v_reub := public.reubicar_reserva(lb.reservation_id, NULL, 'pedido');
      PERFORM set_config('rendio.acomodo_urgente', 'off', true);   -- 0175
      CONTINUE WHEN v_reub->>'kind' NOT IN ('joined', 'new', 'retimed');
      UPDATE public.incidents SET status = 'resolved', resolved_at = now(), resolution_notes = public.reub_nota(v_reub)
       WHERE reservation_id = lb.reservation_id AND status IN ('open', 'in_progress') AND category = 'late_booking';
      n_sin := n_sin + 1;
      -- 0175: quién se repuso de lo de las próximas horas, para el aviso a los jefes.
      IF lb.urg AND lb.org IS NOT NULL THEN
        v_rep := jsonb_set(v_rep, ARRAY[lb.org::text], coalesce(v_rep->(lb.org::text), '[]'::jsonb)
          || to_jsonb(btrim(split_part(coalesce(lb.nombre, 'Tripulante'), ' ', 1) || ' ' || split_part(coalesce(lb.nombre, ''), ' ', 2))
                      || ' (' || public.hm_bog(lb.req) || ')'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1;
      RAISE WARNING 'acomodar sin carro (reserva %): %', lb.reservation_id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('rendio.acomodo_urgente', 'off', true);   -- 0175
  -- 0175: UN aviso a los jefes por organización: a quién se repuso y que lo revisen.
  FOR ro IN SELECT je.key AS org, je.value AS quienes FROM jsonb_each(v_rep) je LOOP   -- «e» ya es una variable de la función
    PERFORM public.trip_notify(j.profile_id,
      'Repuse ' || jsonb_array_length(ro.quienes) || CASE WHEN jsonb_array_length(ro.quienes) = 1 THEN ' traslado sin vuelta 🔁' ELSE ' traslados sin vuelta 🔁' END,
      'Se habían quedado sin vuelta y viajan pronto: ' || (SELECT string_agg(tq.q, ', ') FROM jsonb_array_elements_text(ro.quienes) AS tq(q))
      || '. Ya van en una vuelta: revísalo en Asignación.', '/#/rutas',
      'acomodo-repuso:' || ro.org || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI') || ':' || j.profile_id::text)
      FROM public.ops_alert_recipients_of(ro.org::uuid) j;
  END LOOP;

  RETURN jsonb_build_object('vuelos', n_vuelos, 'cambios', n_cambios, 'sin_carro', n_sin, 'errores', n_err, 'frenadas', n_frenadas);
END;
$function$;

COMMIT;
