import re, sys
import os; M=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'supabase', 'migrations') + '/'
src=open(M+'0144_avisos_por_turno_y_freno.sql',encoding='utf-8').read()
def bloque(firma):
    i=src.index(firma); j=src.index('$$;', src.index('AS $$', i)+5)+3
    return src[i:j]
nota=bloque('CREATE OR REPLACE FUNCTION public.reub_nota(')
aco=bloque('CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(')
def rep(s, old, new):
    assert s.count(old)==1, ('no está una vez', old[:90])
    return s.replace(old, new)

# ── reub_nota: la vuelta que pasó a otro conductor ──
nota=rep(nota, """                        || CASE WHEN coalesce((p->>'pooled')::boolean, false) THEN '; su conductor no alcanzaba y quedó para que otro la tome'""",
"""                        || CASE WHEN p->>'reassigned_from' IS NOT NULL   -- 0154
                                THEN '; ' || (p->>'reassigned_from') || ' no alcanzaba y se la pasé a ' || coalesce(p->>'driver_name', 'otro conductor')
                                WHEN coalesce((p->>'pooled')::boolean, false) THEN '; su conductor no alcanzaba y quedó para que otro la tome'""")

# ── acomodar_eventualidades ──
aco=rep(aco, """  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
BEGIN""", """  v_notes text; v_user text; v_regreso boolean; v_new_flight text; v_new_when timestamptz;
  v_otro jsonb; v_de text; v_corridas boolean; v_quien text; v_rid1 uuid;   -- 0154
BEGIN""")
aco=rep(aco, """      v_need := NULL; v_late := 0; v_total := 0;
      FOR m IN""", """      v_need := NULL; v_late := 0; v_total := 0;
      v_otro := NULL; v_de := NULL; v_corridas := false;   -- 0154
      FOR m IN""")
# El aviso al conductor: llave por persona (no por id de vuelta: al re-publicar el id cambia y salía 3 veces).
aco=rep(aco, """        IF v_ok THEN
          UPDATE public.route_assignments SET planned_start_at = v_start, updated_at = now() WHERE id = v.id;
          IF v_drv_prof IS NOT NULL THEN
            PERFORM public.trip_notify(v_drv_prof, 'Tu vuelta cambió de hora',
              'El vuelo viene tarde: tu llegada de las ' || public.hm_bog(v.planned_start_at) || ' ahora sale de JMC a las ' || public.hm_bog(v_start) || '.',
              '/', 'flt-drvtime:' || v.id::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'));
          END IF;
        ELSE""", """        -- 0154: la primera persona de la vuelta (para las llaves de los avisos y el texto).
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
        ELSIF NOT v_ok THEN""")
aco=rep(aco, """          -- Su conductor no alcanza: queda para tomar, todos juntos, a la hora nueva.""",
"""          -- Nadie más alcanza: queda para tomar, todos juntos, a la hora nueva.""")
aco=rep(aco, """        UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
         WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code""", """        IF NOT v_corridas THEN   -- 0154: si no se corrieron ya arriba
          UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
           WHERE route_assignment_id = v.id AND estimated_arrival_at IS NOT NULL;
        END IF;
        FOR m IN SELECT r.id AS rid, ap.profile_id AS crew, r.flight_code""")
aco=rep(aco, """                               'driver_name', v_drv_name, 'pooled', NOT v_ok, 'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok,
                               'was_delegated', false, 'removed', 0),""", """                               'driver_name', v_drv_name, 'pooled', NOT v_ok AND v_otro IS NULL,
                               'tight', v_start < p_now + interval '45 minutes' AND NOT v_ok AND v_otro IS NULL,
                               'reassigned_from', CASE WHEN v_otro IS NOT NULL THEN coalesce(v_de, 'su conductor') END,   -- 0154
                               'was_delegated', false, 'removed', 0),""")

import os; cab = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_gen-0154-cabecera.sql'),encoding='utf-8').read()
out = cab + "\n-- -----------------------------------------------------------------------------\n-- 3. reub_nota (copia de 0144; cambia lo marcado «0154»)\n-- -----------------------------------------------------------------------------\n" + nota \
  + "\nREVOKE ALL ON FUNCTION public.reub_nota(jsonb) FROM PUBLIC, anon, authenticated;\n" \
  + "\n-- -----------------------------------------------------------------------------\n-- 4. acomodar_eventualidades (copia de 0144; cambia lo marcado «0154»)\n-- -----------------------------------------------------------------------------\n" + aco \
  + "\nREVOKE ALL ON FUNCTION public.acomodar_eventualidades(timestamptz) FROM PUBLIC, anon, authenticated;\n\nCOMMIT;\n"
open(M+'0154_acomodo_asigna_conductor.sql','w',encoding='utf-8').write(out)
print('ok', len(out))
