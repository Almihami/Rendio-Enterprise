#!/usr/bin/env python3
"""Genera 0163_despacho_a_ras.sql (y su down) COPIANDO las funciones que cambia
desde su última definición y aplicándoles parches exactos. Si una fuente cambió
y el parche ya no calza, falla en vez de escribir algo a medias.

  python3 rendio-backend/scripts/_gen-0163.py

Fuentes (lo próximo que toque estas funciones copia DESDE 0163):
  driver_open_routes        0138      driver_take_route      0151
  driver_release_route      0144      avisar_vuelta_para_tomar 0144
  admin_set_support_duty    0162      despachar_llegadas     0160
"""
import pathlib
import re

BACK = pathlib.Path(__file__).resolve().parent.parent
MIG = BACK / "supabase" / "migrations"
DOWN = BACK / "down_migrations"


def fn(archivo, nombre):
    t = (MIG / archivo).read_text()
    inicios = [m.start() for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\." + re.escape(nombre) + r"\(", t)]
    assert inicios, f"{nombre} no está en {archivo}"
    s = inicios[-1]
    e = t.index("\n$$;", s) + 4
    return t[s:e]


def rep(src, viejo, nuevo):
    assert src.count(viejo) == 1, f"el parche no calza ({src.count(viejo)} veces): {viejo[:70]!r}"
    return src.replace(viejo, nuevo)


O_OPEN = fn("0138_vueltas_para_tomar.sql", "driver_open_routes")
O_TAKE = fn("0151_para_tomar_y_conductor.sql", "driver_take_route")
O_REL = fn("0144_avisos_por_turno_y_freno.sql", "driver_release_route")
O_AVISAR = fn("0144_avisos_por_turno_y_freno.sql", "avisar_vuelta_para_tomar")
O_DUTY = fn("0162_carro_de_apoyo.sql", "admin_set_support_duty")
O_DESP = fn("0160_despacho_hora_en_espera.sql", "despachar_llegadas")

# ── 1. Las llegadas en espera no se toman a mano ─────────────────────────────
n_open = rep(O_OPEN,
    "         AND ra.delegated_at IS NULL   -- 0126: la delegada no se ofrece\n",
    "         AND ra.delegated_at IS NULL   -- 0126: la delegada no se ofrece\n"
    "         -- 0163: con el despacho encendido las llegadas las reparte el sistema.\n"
    "         AND NOT (ra.direction = 'airport_to_home' AND public.despacho_encendido())\n")

n_take = rep(O_TAKE,
    "  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;\n",
    "  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor toma vueltas' USING ERRCODE = '42501'; END IF;\n"
    "  -- 0163: con el despacho encendido una llegada en espera no se toma a mano (si\n"
    "  -- alguien la toma la noche anterior, el sistema ya no la reparte con el vuelo).\n"
    "  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x\n"
    "       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NULL) THEN\n"
    "    RAISE EXCEPTION 'Las llegadas las reparte el sistema cuando el vuelo confirma la hora' USING ERRCODE = 'P0001';\n"
    "  END IF;\n")

n_rel = rep(O_REL,
    "  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor suelta vueltas' USING ERRCODE = '42501'; END IF;\n",
    "  IF v_dp IS NULL THEN RAISE EXCEPTION 'Solo un conductor suelta vueltas' USING ERRCODE = '42501'; END IF;\n"
    "  -- 0163: una llegada que reparte el sistema no se suelta desde la app: volvería a\n"
    "  -- la espera y el sistema se la daría otra vez al mismo. La cambia Coordinación.\n"
    "  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x\n"
    "       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.driver_profile_id = v_dp) THEN\n"
    "    RAISE EXCEPTION 'Esta llegada te la asignó el sistema. Si no puedes hacerla, avisa a Coordinación.' USING ERRCODE = 'P0001';\n"
    "  END IF;\n")

n_avisar = rep(O_AVISAR,
    "  v_ids uuid[]; v_n int := 0; t record;\n",
    "  v_ids uuid[]; v_n int := 0; t record;\n"
    "  v_ra text;   -- 0163\n")
n_avisar = rep(n_avisar,
    "  IF p_org IS NULL OR p_start IS NULL THEN RETURN 0; END IF;\n",
    "  IF p_org IS NULL OR p_start IS NULL THEN RETURN 0; END IF;\n"
    "  -- 0163: con el despacho encendido las LLEGADAS no se ofrecen a los conductores\n"
    "  -- (ni «nadie del turno» a los jefes): las reparte el sistema, y si nadie\n"
    "  -- alcanza es él quien avisa. Se reconoce por el texto («Llegada de las…») o\n"
    "  -- por la vuelta que viene en la llave. Las salidas siguen igual.\n"
    "  IF public.despacho_encendido() THEN\n"
    "    v_ra := substring(p_key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');\n"
    "    IF p_desc LIKE 'Llegada %'\n"
    "       OR (v_ra IS NOT NULL AND EXISTS (SELECT 1 FROM public.route_assignments ra\n"
    "                                         WHERE ra.id = v_ra::uuid AND ra.direction = 'airport_to_home')) THEN\n"
    "      RETURN 0;\n"
    "    END IF;\n"
    "  END IF;\n")

# ── 2. El de apoyo se entera ────────────────────────────────────────────────
n_duty = rep(O_DUTY,
    "  v_dp uuid;\nBEGIN\n",
    "  v_dp uuid;\n  v_prev uuid;   -- 0163: quién lo tenía\nBEGIN\n")
n_duty = rep(n_duty,
    "  IF p_driver IS NULL THEN\n"
    "    DELETE FROM public.support_duty WHERE organization_id = v_org AND day = p_day AND band = p_band;\n",
    "  SELECT sd.driver_profile_id INTO v_prev FROM public.support_duty sd\n"
    "   WHERE sd.organization_id = v_org AND sd.day = p_day AND sd.band = p_band;\n"
    "  IF p_driver IS NULL THEN\n"
    "    DELETE FROM public.support_duty WHERE organization_id = v_org AND day = p_day AND band = p_band;\n"
    "    PERFORM public.apoyo_avisar(v_prev, p_day, p_band, false);   -- 0163\n")
n_duty = rep(n_duty,
    "  RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', v_dp);\n",
    "  -- 0163: el conductor se entera (antes solo lo sabía el jefe).\n"
    "  IF v_prev IS DISTINCT FROM v_dp THEN\n"
    "    PERFORM public.apoyo_avisar(v_prev, p_day, p_band, false);\n"
    "    PERFORM public.apoyo_avisar(v_dp, p_day, p_band, true);\n"
    "  END IF;\n"
    "  RETURN jsonb_build_object('day', p_day, 'band', p_band, 'driver', v_dp);\n")

# ── 3. Si el conductor asignado se atrasa, la llegada vuelve a la espera ────
n_desp = rep(O_DESP,
    "    RETURN 'apagado (app_settings.despacho_activo)';\n  END IF;\n",
    "    RETURN 'apagado (app_settings.despacho_activo)';\n  END IF;\n"
    "  -- 0163: primero, las que ya se repartieron y cuyo conductor viene atrasado\n"
    "  -- vuelven a la espera (si hay quién alcance). Nunca frena el reparto.\n"
    "  BEGIN\n"
    "    PERFORM public.despacho_soltar_atrasadas();\n"
    "  EXCEPTION WHEN OTHERS THEN\n"
    "    RAISE WARNING 'despacho_soltar_atrasadas: %', SQLERRM;\n"
    "  END;\n")

CABECERA = """-- =============================================================================
-- 0163 · Despacho de llegadas «a ras»: lo que faltaba para operar de verdad
-- =============================================================================
-- Harold, 15-nov: «arregla lo necesario para que la operación funcione». Revisión
-- del código de dev antes de pasarlo a producción. Tres huecos:
--
--   1. LAS LLEGADAS EN ESPERA SE PODÍAN TOMAR A MANO. Son las mismas «vueltas para
--      tomar» (0125/0151): al publicar, a los conductores del turno les sonaba
--      «Hay una vuelta para tomar» y las veían con «Tomar» hasta 40 h antes. Si
--      uno la tomaba, el sistema ya no la repartía con la hora del vuelo (regla
--      del 10-nov: las llegadas NO se asignan la noche anterior). Con el despacho
--      encendido: no salen en la lista, no se toman, no suenan, y la que el
--      sistema ya dio no se suelta desde la app (la cambia Coordinación).
--      despacho_encendido() nuevo; driver_open_routes DESDE 0138, driver_take_route
--      DESDE 0151, driver_release_route y avisar_vuelta_para_tomar DESDE 0144.
--
--   2. EL DE APOYO NO SE ENTERABA. El jefe lo marcaba en Asignación y al conductor
--      no le llegaba nada hasta la primera llegada. Ahora admin_set_support_duty
--      (DESDE 0162) le avisa «Tienes el carro de apoyo» (y «Ya no lo tienes» al
--      que lo tenía). La tarjeta en su Inicio y la ubicación van en la app.
--
--   3. UNA LLEGADA YA REPARTIDA NADIE LA VOLVÍA A MIRAR. Si el conductor se atrasaba
--      con su vuelta anterior, solo salía la tarjeta «X no alcanza» (0152) cuando
--      un jefe tenía Asignación abierta. Ahora despacho_soltar_atrasadas() corre
--      antes de cada reparto: si al que la tiene le faltan 10 min o más y hay
--      otro que sí alcanza, la devuelve a la espera (una sola vez por vuelta) y el
--      motor la reparte en esa misma pasada; si nadie más alcanza, se queda con él
--      y los jefes se enteran. despachar_llegadas DESDE 0160.
--
-- Generada con scripts/_gen-0163.py. Lo próximo que toque estas funciones copia
-- DESDE 0163.
-- =============================================================================
BEGIN;

-- ¿Está encendido el despacho? Una sola pregunta para todas las funciones.
CREATE OR REPLACE FUNCTION public.despacho_encendido()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT a.despacho_activo FROM public.app_settings a WHERE a.id = 'singleton'), false);
$$;
COMMENT ON FUNCTION public.despacho_encendido() IS
  '0163: true si app_settings.despacho_activo. Con él encendido las llegadas en espera las reparte el sistema, no los conductores.';

"""

APOYO_AVISAR = """-- Aviso al conductor: tiene (o ya no tiene) el carro de apoyo de ese turno.
-- Los turnos de días que ya pasaron no avisan.
CREATE OR REPLACE FUNCTION public.apoyo_avisar(p_dp uuid, p_day date, p_band text, p_tiene boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof uuid;
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_cuando text; v_ok boolean;
BEGIN
  IF p_dp IS NULL OR p_day IS NULL OR p_day < v_hoy - 1 THEN RETURN false; END IF;
  SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;
  v_cuando := CASE WHEN p_day = v_hoy THEN 'Hoy' WHEN p_day = v_hoy + 1 THEN 'Mañana' WHEN p_day = v_hoy - 1 THEN 'Esta madrugada'
                   ELSE 'El ' || to_char(p_day, 'DD/MM') END
           || CASE WHEN p_band = 'am' THEN ', de 2:00 a. m. a 2:00 p. m.' ELSE ', de 2:00 p. m. a 2:00 a. m.' END;
  v_ok := public.trip_notify(v_prof,
    CASE WHEN p_tiene THEN 'Tienes el carro de apoyo 🚐' ELSE 'Ya no tienes el carro de apoyo' END,
    CASE WHEN p_tiene
         THEN v_cuando || '. Si los carros fijos no alcanzan con una llegada, te la mandamos aquí. Deja la app abierta para saber dónde estás.'
         ELSE v_cuando || ': Coordinación lo cambió.' END,
    '/#/', 'apoyo-duty:' || p_day::text || ':' || p_band || ':' || p_dp::text || ':' || p_tiene::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MI'));
  PERFORM public.trip_kick();
  RETURN coalesce(v_ok, false);
END;
$$;

"""

SOLTAR = """-- El rastro del despacho aprende una palabra: «devuelta».
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga', 'devuelta'));

-- Llegadas que el despacho ya repartió, que no han arrancado y arrancan ya: si a
-- su conductor le faltan 10 min o más (cadena_evaluar, 0152) y hay otro del turno
-- que sí alcanza, vuelven a la espera para que el motor las reparta de nuevo.
-- Una sola vez por vuelta (sin vaivén). Si nadie más alcanza, se queda con él y
-- los jefes se enteran (despacho_avisar no repite por la misma vuelta).
CREATE OR REPLACE FUNCTION public.despacho_soltar_atrasadas()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record; ev jsonb; v_late int; v_n int := 0;
  ra public.route_assignments%ROWTYPE;
  v_prof uuid; v_quien text;
BEGIN
  IF NOT public.despacho_encendido() THEN RETURN 0; END IF;
  FOR v IN
    SELECT x.id, x.driver_profile_id AS dp, x.planned_start_at AS ini
      FROM public.route_assignments x
     WHERE x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NOT NULL
       AND x.status = 'planned' AND x.delegated_at IS NULL AND x.organization_id IS NOT NULL
       AND x.planned_start_at BETWEEN now() - interval '20 minutes' AND now() + interval '25 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = x.id AND rs.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.arrival_dispatch_log g
                    WHERE g.route_assignment_id = x.id AND g.kind = 'asignada' AND g.driver_profile_id = x.driver_profile_id)
       AND NOT EXISTS (SELECT 1 FROM public.arrival_dispatch_log g WHERE g.route_assignment_id = x.id AND g.kind = 'devuelta')
     ORDER BY x.planned_start_at
  LOOP
    ev := public.cadena_evaluar(v.id, true);
    CONTINUE WHEN ev IS NULL OR NOT coalesce((ev->>'known')::boolean, false);
    v_late := coalesce((ev->>'late_min')::int, 0);
    CONTINUE WHEN v_late < 10;
    IF ev->'best' IS NULL OR jsonb_typeof(ev->'best') <> 'object' THEN
      PERFORM public.despacho_avisar(v.id, 'espera_larga', v.ini, v_late);
      CONTINUE;
    END IF;

    UPDATE public.route_assignments
       SET driver_profile_id = NULL, vehicle_id = NULL, updated_at = now()
     WHERE id = v.id AND driver_profile_id = v.dp AND status = 'planned'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = v.id AND rs.status <> 'pending')
    RETURNING * INTO ra;
    CONTINUE WHEN ra.id IS NULL;
    PERFORM public.route_sync_assigned(ra.id);

    SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = ra.id;
    SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = v.dp;
    IF v_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_prof, 'Ya no recoges esta llegada',
        'La llegada de las ' || public.hm_bog(v.ini) || coalesce(' (' || v_quien || ')', '')
          || ' pasa a otro conductor: vas atrasado con tu vuelta anterior.',
        '/#/ruta', 'desp-dev:' || ra.id::text || ':' || v.dp::text);
    END IF;
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
    VALUES (ra.organization_id, ra.id, v.dp, 'devuelta', v.ini, v_late, v_quien,
            jsonb_build_object('mejor', ev->'best'->>'dp', 'por_que', ev->>'why'));
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION public.despacho_soltar_atrasadas() IS
  '0163: devuelve a la espera las llegadas ya repartidas cuyo conductor viene 10+ min atrasado, si hay otro del turno que sí alcanza. Una vez por vuelta. La llama despachar_llegadas.';

"""

PERMISOS = """REVOKE ALL ON FUNCTION public.despacho_encendido() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_encendido() TO service_role;
REVOKE ALL ON FUNCTION public.apoyo_avisar(uuid, date, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apoyo_avisar(uuid, date, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_soltar_atrasadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_soltar_atrasadas() TO service_role;

COMMIT;
"""

up = (CABECERA
      + "-- ── 1. Las llegadas en espera no se toman a mano ────────────────────────────\n"
      + n_open + "\n\n" + n_take + "\n\n" + n_rel + "\n\n" + n_avisar + "\n\n"
      + "-- ── 2. El de apoyo se entera ────────────────────────────────────────────────\n"
      + APOYO_AVISAR + n_duty + "\n\n"
      + "-- ── 3. Si el conductor asignado se atrasa ───────────────────────────────────\n"
      + SOLTAR + n_desp + "\n\n" + PERMISOS)

down = ("""-- Down de 0163: todo vuelve a como lo dejó 0162 (funciones tal cual sus fuentes).
BEGIN;

""" + O_OPEN + "\n\n" + O_TAKE + "\n\n" + O_REL + "\n\n" + O_AVISAR + "\n\n" + O_DUTY + "\n\n" + O_DESP + """

DROP FUNCTION IF EXISTS public.despacho_soltar_atrasadas();
DROP FUNCTION IF EXISTS public.apoyo_avisar(uuid, date, text, boolean);
DROP FUNCTION IF EXISTS public.despacho_encendido();
DELETE FROM public.arrival_dispatch_log WHERE kind = 'devuelta';
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga'));

COMMIT;
""")

(MIG / "0163_despacho_a_ras.sql").write_text(up)
(DOWN / "0163_despacho_a_ras.down.sql").write_text(down)
print("0163_despacho_a_ras.sql:", len(up.splitlines()), "líneas · down:", len(down.splitlines()), "líneas")
