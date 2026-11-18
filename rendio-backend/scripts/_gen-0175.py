#!/usr/bin/env python3
# Genera supabase/migrations/0175_lo_urgente_no_se_frena.sql (y su down) COPIANDO Y PARCHANDO
# las definiciones vigentes (scripts/_base-0175/def-*.sql, sacadas de PRODUCCIÓN el 17-nov-2026
# con scripts/_base-0175/bajar.mjs; dev era idéntica). Cada parche exige encontrar su texto
# EXACTO una vez: si la función cambió, el generador falla.
#   cd rendio-backend && python3 scripts/_gen-0175.py
import io, os
B = os.path.dirname(os.path.abspath(__file__))
leer = lambda f: io.open(os.path.join(B, '_base-0175', 'def-%s.sql' % f), encoding='utf-8').read().rstrip('\n')

def parchar(nombre, txt, parches):
    for viejo, nuevo in parches:
        n = txt.count(viejo)
        if n != 1:
            raise SystemExit('%s: el texto a cambiar aparece %d veces (esperaba 1):\n%s' % (nombre, n, viejo[:200]))
        txt = txt.replace(viejo, nuevo)
    return txt

URG = lambda cond: "PERFORM set_config('rendio.acomodo_urgente', CASE WHEN %s THEN 'on' ELSE 'off' END, true);   -- 0175" % cond
OFF = "PERFORM set_config('rendio.acomodo_urgente', 'off', true);   -- 0175"
SIN_VUELTA = """       AND r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private' AND r.required_arrival_at > p_now + interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                        WHERE rs.reservation_id = r.id AND ra.status IN ('planned', 'in_progress'))"""

acomodar = leer('acomodar_eventualidades')
viejo_c = acomodar[acomodar.index("  -- c) «X no tiene carro» abierta (0068/0127): se reubica.\n"):acomodar.index("  RETURN jsonb_build_object('vuelos', n_vuelos")]
nuevo_c = """  -- c) «X no tiene carro» abierta (0068/0127): se reubica.
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
""" + SIN_VUELTA + """
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
""" + SIN_VUELTA.replace('\n       ', '\n         ').replace('       AND r.cancelled', '         AND r.cancelled', 1) + """
         AND (r.required_arrival_at <= v_urg_hasta OR ii.organization_id IS NULL OR NOT (ii.organization_id = ANY (v_orgs_frenadas)))   -- 0144 + 0175
       ORDER BY ii.reservation_id, ii.created_at DESC) x
     ORDER BY x.req   -- 0175: primero lo más próximo
  LOOP
    BEGIN
      """ + URG('lb.urg') + """
      v_reub := public.reubicar_reserva(lb.reservation_id, NULL, 'pedido');
      """ + OFF + """
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
  """ + OFF + """
  -- 0175: UN aviso a los jefes por organización: a quién se repuso y que lo revisen.
  FOR ro IN SELECT je.key AS org, je.value AS quienes FROM jsonb_each(v_rep) je LOOP   -- «e» ya es una variable de la función
    PERFORM public.trip_notify(j.profile_id,
      'Repuse ' || jsonb_array_length(ro.quienes) || CASE WHEN jsonb_array_length(ro.quienes) = 1 THEN ' traslado sin vuelta 🔁' ELSE ' traslados sin vuelta 🔁' END,
      'Se habían quedado sin vuelta y viajan pronto: ' || (SELECT string_agg(tq.q, ', ') FROM jsonb_array_elements_text(ro.quienes) AS tq(q))
      || '. Ya van en una vuelta: revísalo en Asignación.', '/#/rutas',
      'acomodo-repuso:' || ro.org || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI') || ':' || j.profile_id::text)
      FROM public.ops_alert_recipients_of(ro.org::uuid) j;
  END LOOP;

"""
assert viejo_c.count('-- c) «X no tiene carro»') == 1
acomodar = acomodar.replace(viejo_c, nuevo_c)
acomodar = parchar('acomodar_eventualidades', acomodar, [
 ("  v_otro jsonb; v_de text; v_corridas boolean; v_quien text; v_rid1 uuid;   -- 0154\n",
  "  v_otro jsonb; v_de text; v_corridas boolean; v_quien text; v_rid1 uuid;   -- 0154\n"
  "  v_urg_h int; v_urg_hasta timestamptz; v_rep jsonb := '{}'::jsonb; ro record;   -- 0175\n"),
 ("  v_cut := coalesce(v_cut, 120);\n",
  "  v_cut := coalesce(v_cut, 120);\n"
  "  -- 0175: lo que viaja de aquí a acomodo_urgente_horas no se frena (ver el bloque c).\n"
  "  SELECT acomodo_urgente_horas INTO v_urg_h FROM public.app_settings WHERE id = 'singleton';\n"
  "  v_urg_hasta := p_now + make_interval(hours => coalesce(v_urg_h, 6));\n"),
 ("          v_reub := public.reubicar_reserva(m.rid, m.baja + make_interval(mins => m.desemb), 'vuelo');\n",
  "          " + URG('m.baja <= v_urg_hasta') + "\n"
  "          v_reub := public.reubicar_reserva(m.rid, m.baja + make_interval(mins => m.desemb), 'vuelo');\n"
  "          " + OFF + "\n"),
 ("      v_reub := public.reubicar_reserva(cf.reservation_id, NULL, 'cambio');\n",
  "      " + URG('v_new_when <= v_urg_hasta') + "\n"
  "      v_reub := public.reubicar_reserva(cf.reservation_id, NULL, 'cambio');\n"
  "      " + OFF + "\n"),
])

frenado = parchar('acomodo_frenado', leer('acomodo_frenado'), [
 ("AS $function$\n  SELECT count(*) >= ",
  "AS $function$\n"
  "  -- 0175: mientras acomodar_eventualidades reubica a alguien que viaja en las próximas\n"
  "  -- horas (rendio.acomodo_urgente = on), el tope de vueltas nuevas no lo frena.\n"
  "  SELECT coalesce(current_setting('rendio.acomodo_urgente', true), '') IS DISTINCT FROM 'on'\n"
  "     AND count(*) >= "),
])

CAB = """-- 0175 · Lo que viaja en las próximas horas no se frena (17-nov-2026)
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

"""
up = CAB + frenado + ";\n\n" + acomodar + ";\n\nCOMMIT;\n"
down = ("-- Deshace 0175: vuelven acomodo_frenado (0144) y acomodar_eventualidades (0171) tal como estaban.\nBEGIN;\n\n"
        + leer('acomodo_frenado') + ";\n\n" + leer('acomodar_eventualidades') + ";\n\n"
        + "ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_acomodo_urgente_horas_chk;\n"
        + "ALTER TABLE public.app_settings DROP COLUMN IF EXISTS acomodo_urgente_horas;\n\nCOMMIT;\n")
M = os.path.join(B, '..', 'supabase', 'migrations', '0175_lo_urgente_no_se_frena.sql')
D = os.path.join(B, '..', 'down_migrations', '0175_lo_urgente_no_se_frena.down.sql')
io.open(M, 'w', encoding='utf-8').write(up)
io.open(D, 'w', encoding='utf-8').write(down)
print('escrita', os.path.normpath(M), len(up), 'bytes ·', os.path.normpath(D), len(down), 'bytes')
