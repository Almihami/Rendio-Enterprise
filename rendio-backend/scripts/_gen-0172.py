#!/usr/bin/env python3
# Genera supabase/migrations/0172_soltar_a_su_hora.sql (y su down) COPIANDO Y PARCHANDO las
# definiciones vivas (scripts/_base-0172/prod-*.sql, bajadas de PRODUCCIÓN el 17-nov-2026 con
# scripts/_base-0172/bajar.mjs; dev era idéntica y reubicar_reserva = la de 0171). Cada parche
# exige encontrar su texto EXACTO una vez: si la función cambió, el generador falla.
#   cd rendio-backend && python3 scripts/_gen-0172.py
import io, os
B = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(B)
leer = lambda f: io.open(os.path.join(B, '_base-0172', 'prod-%s.sql' % f), encoding='utf-8').read().rstrip('\n')
escribir = lambda p, t: io.open(os.path.join(R, p), 'w', encoding='utf-8').write(t)

def parchar(nombre, txt, parches):
    for viejo, nuevo in parches:
        n = txt.count(viejo)
        if n != 1:
            raise SystemExit('%s: el texto a cambiar aparece %d veces (esperaba 1):\n%s' % (nombre, n, viejo[:200]))
        txt = txt.replace(viejo, nuevo)
    return txt

reub0 = leer('reubicar_reserva')
soltar0 = leer('driver_llegada_soltar')

# ── reubicar_reserva: un motivo más, 'soltada' (solo cambian textos; decide igual) ──
reub = parchar('reubicar_reserva', reub0, [
    ("  v_pre := CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo cambió de hora: ' WHEN 'pedido' THEN 'Ya tienes carro: ' ELSE 'Con tu hora nueva ' END;",
     "  -- 0172: 'soltada' = su conductor la soltó en JMC porque se demora (driver_llegada_soltar).\n"
     "  v_pre := CASE p_motivo WHEN 'vuelo' THEN 'Tu vuelo cambió de hora: ' WHEN 'pedido' THEN 'Ya tienes carro: '\n"
     "                         WHEN 'soltada' THEN 'Tu conductor tuvo que salir: ' ELSE 'Con tu hora nueva ' END;"),
    ("    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️' ELSE 'Listo: te movimos de vuelta 🔄' END;",
     "    v_tit := CASE p_motivo WHEN 'pedido' THEN 'Ya tienes carro 🚗' WHEN 'vuelo' THEN 'Tu vuelo viene a otra hora ✈️'\n"
     "                           WHEN 'soltada' THEN 'Cambió quién te recoge 🔄' ELSE 'Listo: te movimos de vuelta 🔄' END;   -- 0172"),
    ("            CASE p_motivo WHEN 'vuelo' THEN 'Creada sola: su vuelo cambió de hora' WHEN 'pedido' THEN 'Creada sola: pidió con el día publicado'",
     "            CASE p_motivo WHEN 'vuelo' THEN 'Creada sola: su vuelo cambió de hora' WHEN 'pedido' THEN 'Creada sola: pidió con el día publicado'\n"
     "                          WHEN 'soltada' THEN 'Creada sola: se demora y su conductor la soltó en JMC'   -- 0172"),
    ("      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado' ELSE 'cambió de vuelo' END",
     "      || CASE p_motivo WHEN 'vuelo' THEN 'su vuelo cambió de hora' WHEN 'pedido' THEN 'pidió con el día publicado'\n"
     "                       WHEN 'soltada' THEN 'se demora y su conductor la soltó en JMC' ELSE 'cambió de vuelo' END   -- 0172"),
])

# ── driver_llegada_soltar: se demora → la siguiente recogida (reubicar_reserva) ──
SOLTAR = r"""CREATE OR REPLACE FUNCTION public.driver_llegada_soltar(p_route uuid, p_stop uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  ra    public.route_assignments;
  r     record;
  v_res uuid; v_me text; v_new uuid;
  v_sale timestamptz; v_rep boolean; v_reub jsonb; v_kind text; v_drv text;   -- 0172
  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Solo un conductor' USING ERRCODE = '42501'; END IF;
  ra := public.llegada_editable(p_route, v_dp);
  SELECT rs.reservation_id INTO v_res FROM public.route_stops rs
   WHERE rs.id = p_stop AND rs.route_assignment_id = ra.id AND rs.status IN ('pending', 'arrived') AND rs.reservation_id IS NOT NULL;
  IF v_res IS NULL THEN RAISE EXCEPTION 'Esa persona no es de tu vuelta o ya se subió' USING ERRCODE = 'P0002'; END IF;
  SELECT ap.profile_id AS crew, pr.full_name AS nombre, res.flight_code, res.required_arrival_at,
         (coalesce(res.ground_ops, false) OR res.reserve_place IS NOT NULL) AS sin_vuelo
    INTO r
    FROM public.reservations res
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE res.id = v_res;

  -- 0172: la hora en que ELLA sale de JMC, no la del combo que deja: aterrizaje
  -- (FlightRadar si lo hay; si no, su pedido) + desembarque, al múltiplo de 5 de
  -- arriba y nunca antes de ahora (la que ya aterrizó y se demora sale «ya»).
  v_sale := greatest(
    public.reub_arriba5(coalesce(public.reub_baja(v_org, r.flight_code, r.required_arrival_at), r.required_arrival_at)
      + make_interval(mins => CASE WHEN r.sin_vuelo THEN 0 ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END)),
    public.reub_arriba5(now()));
  v_sale := coalesce(v_sale, ra.planned_start_at);
  v_rep := public.despacho_encendido();

  -- Sale de la vuelta del conductor (si queda vacía, se borra).
  DELETE FROM public.route_stops WHERE id = p_stop;
  DELETE FROM public.route_assignments x WHERE x.id = ra.id
     AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = x.id);

  -- 0172 (Harold, 17-nov: «que se demora, y ya; que se le asigne a la siguiente
  -- recogida»): el mismo criterio del acomodo cuando un vuelo cambia de hora. Entra
  -- en la vuelta que sale de JMC hasta 15 min después de que ella esté afuera, si
  -- cabe sin mover a nadie; si no hay, le arma su propia vuelta a su hora. Avisa al
  -- tripulante y al conductor de esa vuelta.
  -- Es urgente por definición (está en JMC o a punto): el freno del acomodo no aplica
  -- (como 0175 con lo de las próximas horas), así no les llega «no armo más sola».
  PERFORM set_config('rendio.acomodo_urgente', 'on', true);
  v_reub := public.reubicar_reserva(v_res, v_sale, 'soltada');
  PERFORM set_config('rendio.acomodo_urgente', 'off', true);
  v_kind := coalesce(v_reub->>'kind', 'none');
  IF v_kind IN ('joined', 'new') AND (v_reub->>'ra_id') IS NOT NULL THEN
    v_new := (v_reub->>'ra_id')::uuid;
    v_sale := coalesce((v_reub->>'start_at')::timestamptz, v_sale);
    v_drv := public.short_name(v_reub->>'driver_name');
  ELSE
    -- No se pudo (día sin ruta publicada): su vuelta en espera, como siempre.
    v_kind := 'espera';
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, para_tomar, organization_id, manual_day)
    VALUES (NULL, NULL, 'airport_to_home', 'planned', v_sale, true, true, v_org,
            -- El día del plan solo si la vuelta que deja lo llevaba (ruta pegada): con el corte de la madrugada.
            CASE WHEN ra.manual_day IS NOT NULL THEN coalesce(public.dia_madrugada(v_sale), (v_sale AT TIME ZONE 'America/Bogota')::date) END)
    RETURNING id INTO v_new;
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES (v_new, v_res, 1, NULL);
    -- Con el reparto encendido esta no suena (0163): la vuelta se la da el sistema.
    PERFORM public.avisar_vuelta_para_tomar(v_org, v_sale, 'Hay una vuelta para tomar',
      'Llegada de las ' || public.hm_bog(v_sale) || ' (' || public.short_name(r.nombre) || ').',
      'llegadasuelta:' || v_new::text || ':' || v_sello, auth.uid(), false);
    IF r.crew IS NOT NULL THEN
      PERFORM public.trip_notify(r.crew, 'Cambió quién te recoge 🔄',
        'Tu conductor tuvo que salir de JMC. Te avisamos quién te recoge.',
        '/#/viaje?r=' || v_res::text, 'llegadasuelta-t:' || v_new::text || ':' || v_sello);
    END IF;
  END IF;
  PERFORM public.route_sync_assigned(v_new);   -- el pedido: «conductor asignado» solo si la vuelta tiene conductor
  PERFORM public.sync_calculated_pickup(v_res);

  SELECT pr.full_name INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
  PERFORM public.trip_notify(j.profile_id, '⚠️ ' || coalesce(public.short_name(v_me), 'Un conductor') || ' soltó a ' || public.short_name(r.nombre) || ' · se demora',
    'De su llegada de las ' || public.hm_bog(ra.planned_start_at) || '. '
    || CASE WHEN v_kind = 'joined' THEN 'Pasó a la vuelta de las ' || public.hm_bog(v_sale) || coalesce(' con ' || v_drv, ' (todavía sin conductor)') || '.'
            WHEN v_rep THEN 'Quedó en espera (sale de JMC hacia las ' || public.hm_bog(v_sale) || '): el sistema le busca carro.'
            ELSE 'Quedó para tomar (sale de JMC hacia las ' || public.hm_bog(v_sale) || '): si nadie la toma, asígnala en Asignación.' END,
    '/#/rutas', 'llegadasuelta-j:' || v_new::text || ':' || v_sello || ':' || j.profile_id::text)
    FROM public.ops_alert_recipients_of(v_org) j;
  PERFORM public.trip_kick();
  RETURN jsonb_build_object('id', v_new, 'start_at', v_sale, 'kind', v_kind, 'driver_name', v_drv);
END;
$function$"""

GRANTS = """REVOKE ALL ON FUNCTION public.driver_llegada_soltar(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_llegada_soltar(uuid, uuid) TO authenticated;"""

HEAD = """-- 0172 · «Soltar» en JMC = se demora → la siguiente recogida (17-nov-2026)
--
-- Esa noche Miguel Ángel esperaba en JMC con Julián a bordo y Taborda atrasado (LA4026),
-- y la app solo le daba «No llegó», que le dice al tripulante «salió sin ti» y lo deja
-- sin carro. «Soltar» (driver_llegada_soltar, 0151) vivía solo en el Detalle de la
-- vuelta. La app (SW v273) lo pone en la fila de JMC: el conductor DESLIZA la fila a la
-- izquierda y la persona queda «Se demora» (6 s para deshacer). Harold: «que se demora,
-- y ya; que se le asigne a la siguiente recogida; para no complicarnos».
--
-- Qué cambia en driver_llegada_soltar (misma firma; también la usa el Detalle):
--   · La hora: la de ELLA (aterrizaje por FlightRadar o su pedido + desembarque, al
--     múltiplo de 5 de arriba, nunca antes de ahora), no la del combo que deja.
--   · Dónde queda: reubicar_reserva(…, 'soltada'), el mismo criterio del acomodo cuando
--     un vuelo cambia de hora: entra en la vuelta que sale de JMC hasta 15 min después
--     de que ella esté afuera, si cabe sin mover a nadie (sin arrancar, con cupo); si no
--     hay, le arma su propia vuelta a su hora y el reparto le busca conductor. El freno
--     del acomodo no aplica (es urgente, como 0175). Si el día no tiene ruta publicada,
--     su vuelta en espera como antes.
--   · El pedido queda con el estado de su vuelta nueva (route_sync_assigned).
--   · Aviso a los jefes: «⚠️ Miguel soltó a Sebastián · se demora — pasó a la vuelta
--     de las 23:40 con Juan» / «quedó en espera…». Al tripulante y al conductor que la
--     recibe, los avisos de reubicar_reserva con el motivo nuevo 'soltada'.
--
-- reubicar_reserva: solo se le suma el motivo 'soltada' (textos); decide igual.
-- Funciones copiadas de PRODUCCIÓN (iguales a dev; reubicar = la de 0171) el 17-nov-2026:
-- lo próximo que toque cualquiera de las dos copia DESDE 0172.
-- Generada por scripts/_gen-0172.py. Deshacer: down_migrations/0172_soltar_a_su_hora.down.sql.

BEGIN;

"""

up = HEAD + reub + ";\n\n" + SOLTAR + ";\n" + GRANTS + "\n\n" \
    + "COMMENT ON FUNCTION public.driver_llegada_soltar(uuid, uuid)\n" \
    + "  IS '0172 · El conductor suelta a una persona de su llegada (pendiente o esperada en JMC) porque se demora: pasa a la siguiente recogida que salga de JMC hasta 15 min después de que ella esté afuera (reubicar_reserva, motivo soltada) o a su propia vuelta a su hora. Avisa a la persona, al conductor que la recibe y a los jefes.';\n\n" \
    + "COMMIT;\n"
down = """-- Deshace 0172: reubicar_reserva sin el motivo 'soltada' (la de 0171) y driver_llegada_soltar
-- como la de 0151 (la vuelta en espera nace con la hora del combo que deja). Copias de PRODUCCIÓN.

BEGIN;

""" + reub0 + ";\n\n" + soltar0 + ";\n" + GRANTS + "\n\nCOMMENT ON FUNCTION public.driver_llegada_soltar(uuid, uuid) IS NULL;\n\nCOMMIT;\n"

for x in (up, down):
    if 'ROLLBACK' in x: raise SystemExit('no debería decir ROLLBACK')
escribir('supabase/migrations/0172_soltar_a_su_hora.sql', up)
escribir('down_migrations/0172_soltar_a_su_hora.down.sql', down)
print('0172 generada:', len(up.splitlines()), 'líneas · down:', len(down.splitlines()), 'líneas')
