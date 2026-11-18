#!/usr/bin/env python3
# Genera supabase/migrations/0171_hora_del_vuelo.sql (y su down) COPIANDO Y PARCHANDO
# las definiciones vigentes de la base (scripts/_base-0171/def-*.sql, sacadas de DEV
# con pg_get_functiondef el 17-nov-2026: scripts/_base-0171/buscar.mjs). Cada parche
# exige encontrar su texto EXACTO una vez: si la función cambió, el generador falla.
#   cd rendio-backend && python3 scripts/_gen-0171.py
import io, os
B = os.path.dirname(os.path.abspath(__file__))
leer = lambda f: io.open(os.path.join(B, '_base-0171', 'def-%s.sql' % f), encoding='utf-8').read().rstrip('\n')
SV = "(coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL)"
P = {}

P['detect_trip_reminders'] = [
 ("    SELECT r.id, r.direction, r.calculated_pickup_at\n      FROM public.reservations r\n",
  "    SELECT r.id, r.direction, r.calculated_pickup_at,\n           " + SV + " AS sin_vuelo   -- 0171\n      FROM public.reservations r\n"),
 ("'Tu conductor sale de JMC a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️',",
  "-- 0171: a quien llega en un vuelo no se le promete la hora de salida de JMC.\n           CASE WHEN rec.sin_vuelo THEN 'Tu conductor sale de JMC a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️'\n                ELSE 'Tu conductor te espera en JMC ✈️' END,"),
]
def lle(var): return ("'te esperamos en JMC a las ' || public.hm_bog(%s)" % var,
  "(CASE WHEN " + SV + " THEN 'te esperamos en JMC a las ' || public.hm_bog(%s) ELSE 'te esperamos en JMC cuando aterrices' END) /* 0171: sin la hora de salida de JMC a quien llega en un vuelo */" % var)
P['reubicar_reserva'] = [lle('t_start') + (1,), lle('v_start') + (2,)]
P['acomodar_eventualidades'] = [
 ("'Tu vuelo viene tarde: te esperamos en JMC a las ' || public.hm_bog(v_start)",
  "'Tu vuelo viene tarde: te esperamos en JMC cuando aterrices'   /* 0171: sin la hora de salida de JMC */"),
]
P['admin_manual_route_set_times'] = [
 ("      v_donde := public.lugar_del_regreso(c.id);   -- 0147: también el personal de tierra\n",
  "      v_donde := public.lugar_del_regreso(c.id);   -- 0147: también el personal de tierra\n"
  "      -- 0171: a quien llega en un vuelo ya no se le dice la hora de salida de JMC:\n"
  "      -- correrla no es noticia para él.\n"
  "      CONTINUE WHEN v_donde IS NULL;\n"),
]
P['admin_manual_route_publish'] = [
 ("          || ' (sale hacia las ' || public.hm_bog(v_start) || '). Te avisamos quién te recoge.';",
  "          -- 0171: la hora de salida solo a quien no viene en un vuelo (tierra, reserva).\n"
  "          || CASE WHEN public.lugar_del_regreso(v_res.id) IS NOT NULL THEN ' (sale hacia las ' || public.hm_bog(v_start) || ')' ELSE '' END\n"
  "          || '. Te avisamos quién te recoge.';"),
]
P['admin_pasar_reserva'] = [
 ("  v_pax   int;\nBEGIN", "  v_pax   int;\n  v_sale  timestamptz; v_corrio boolean := false; k record;   -- 0171\nBEGIN"),
 ("         rz.name AS conjunto, res.pickup_address\n",
  "         rz.name AS conjunto, res.pickup_address,\n"
  "         res.flight_code, res.required_arrival_at,   -- 0171\n"
  "         (coalesce(res.ground_ops, false) OR res.reserve_place IS NOT NULL) AS sin_vuelo\n"),
 ("  VALUES (ra.id, p_reservation, (SELECT coalesce(max(x.stop_order), 0) + 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id), v_eta);\n",
  "  VALUES (ra.id, p_reservation, (SELECT coalesce(max(x.stop_order), 0) + 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id), v_eta);\n"
  "  -- 0171 (17-nov-2026, Alfonso): en una llegada el carro sale de JMC cuando ya salió\n"
  "  -- el ÚLTIMO. Si el que entra sale del avión después de la hora del combo, el combo\n"
  "  -- toma esa hora. Antes quedaba con la hora vieja y el acomodo lo sacaba al minuto\n"
  "  -- («su vuelta salía de JMC a las…») y le armaba una vuelta aparte. Misma cuenta del\n"
  "  -- acomodo: aterrizaje real o pedido + desembarque, al múltiplo de 5 de arriba.\n"
  "  IF v_lle THEN\n"
  "    v_sale := public.reub_arriba5(coalesce(public.reub_baja(v_org, r.flight_code, r.required_arrival_at), r.required_arrival_at)\n"
  "      + make_interval(mins => CASE WHEN r.sin_vuelo THEN 0 ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END));\n"
  "    IF v_sale IS NOT NULL AND v_sale > ra.planned_start_at THEN\n"
  "      UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + (v_sale - ra.planned_start_at)\n"
  "       WHERE route_assignment_id = ra.id AND estimated_arrival_at IS NOT NULL;\n"
  "      UPDATE public.route_assignments SET planned_start_at = v_sale WHERE id = ra.id;\n"
  "      v_corrio := true;\n"
  "    END IF;\n"
  "  END IF;\n"),
 ("  PERFORM public.sync_calculated_pickup(p_reservation);\n",
  "  PERFORM public.sync_calculated_pickup(p_reservation);\n"
  "  -- 0171: si el combo se corrió, los demás quedan con su hora nueva; a los que no\n"
  "  -- vienen en un vuelo (tierra, reserva) se les avisa, porque su hora sí es esa.\n"
  "  IF v_corrio THEN\n"
  "    FOR k IN\n"
  "      SELECT y.id, ya.profile_id AS crew, public.lugar_del_regreso(y.id) AS donde\n"
  "        FROM public.route_stops rs JOIN public.reservations y ON y.id = rs.reservation_id\n"
  "        JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id\n"
  "       WHERE rs.route_assignment_id = ra.id AND y.id <> p_reservation AND y.cancelled_at IS NULL\n"
  "    LOOP\n"
  "      PERFORM public.sync_calculated_pickup(k.id);\n"
  "      IF k.donde IS NOT NULL THEN\n"
  "        PERFORM public.trip_notify(k.crew, 'Cambió la hora de tu regreso 🕒',\n"
  "          'Te recogemos ' || k.donde || ' hacia las ' || public.hm_bog(ra.planned_start_at) || '.',\n"
  "          '/#/viaje?r=' || k.id::text, 'pasar-hora:' || ra.id::text || ':' || k.id::text || ':' || v_sello);\n"
  "      END IF;\n"
  "    END LOOP;\n"
  "  END IF;\n"),
 ("    CASE WHEN v_lle THEN 'Te esperamos ' || coalesce(public.lugar_del_regreso(p_reservation), 'en JMC') || ' a las ' || public.hm_bog(ra.planned_start_at)\n",
  "    CASE WHEN v_lle AND NOT r.sin_vuelo THEN 'Te esperamos en JMC cuando aterrices'   -- 0171: sin la hora de salida de JMC\n"
  "         WHEN v_lle THEN 'Te esperamos ' || coalesce(public.lugar_del_regreso(p_reservation), 'en JMC') || ' a las ' || public.hm_bog(ra.planned_start_at)\n"),
]

CAB = """-- 0171 · En las llegadas, la hora que se dice es la del VUELO (17-nov-2026)
--
-- Julián (jefe), por audio: «yo quitaría el aproximado a la hora que van a salir del
-- aeropuerto; solamente la hora a la que aterriza el avión… que el sistema lo lea,
-- pero que no lo ponga». Las pantallas ya no muestran la salida de JMC de una llegada
-- (SW v268). Esta migración hace lo mismo con lo que arma la base PARA EL TRIPULANTE
-- que llega en un vuelo, y arregla lo que pasó con Alfonso ese día:
--
--   · detect_trip_reminders   «Tu conductor sale de JMC a las …» → «Tu conductor te espera en JMC ✈️»
--   · reubicar_reserva        «te esperamos en JMC a las …» → «… cuando aterrices»
--   · acomodar_eventualidades «Tu vuelo viene tarde: te esperamos en JMC a las …» → «… cuando aterrices»
--   · admin_manual_route_set_times   correr la hora de una llegada ya no le avisa al que viene en un vuelo
--   · admin_manual_route_publish     «(sale hacia las …)» solo a tierra y reserva
--   · admin_pasar_reserva     el texto, y la REGLA: si el que entra a un combo de llegada
--                             sale del avión después de la hora del combo, el combo toma
--                             esa hora (antes el acomodo lo sacaba al minuto).
--
-- Quien NO viene en un vuelo (personal de tierra, reserva en hotel o en JMC) conserva
-- su hora en todos los avisos: para ellos esa hora es la suya, no un cálculo.
-- NO cambia: planned_start_at sigue mandando por dentro (choques, reparto, acomodo,
-- recordatorios), ni los avisos a conductores y jefes, que nombran la vuelta por esa hora.
--
-- GENERADA por scripts/_gen-0171.py desde las definiciones vigentes (scripts/_base-0171/).
-- Lo próximo que toque estas seis funciones copia DESDE 0171.
-- Deshacer: down_migrations/0171_hora_del_vuelo.down.sql (las seis como estaban).
"""
up, down = [CAB, '\nBEGIN;\n'], ["-- Deshace 0171: las seis funciones como estaban el 17-nov-2026 (scripts/_base-0171/).\n\nBEGIN;\n"]
for f, parches in P.items():
    src = leer(f); nuevo = src
    for p in parches:
        a, b, n = (p + (1,))[:3]
        assert nuevo.count(a) == n, (f, nuevo.count(a), n, a[:80])
        nuevo = nuevo.replace(a, b)
    assert nuevo != src
    up.append('\n' + nuevo + ';\n'); down.append('\n' + src + ';\n')
up.append('\nCOMMIT;\n'); down.append('\nCOMMIT;\n')
io.open(os.path.join(B, '..', 'supabase', 'migrations', '0171_hora_del_vuelo.sql'), 'w', encoding='utf-8').write(''.join(up))
io.open(os.path.join(B, '..', 'down_migrations', '0171_hora_del_vuelo.down.sql'), 'w', encoding='utf-8').write(''.join(down))
print('ok · funciones:', ', '.join(P))
