# Genera 0165 copiando de 0163 las funciones que toca y parchándolas (sin copiar a mano).
import re, pathlib
M = pathlib.Path(__file__).resolve().parent.parent / 'supabase' / 'migrations'
src = (M / '0163_despacho_a_ras.sql').read_text()

def fn(nombre):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + nombre + r'\(.*?\n\$\$;\n', src, re.S)
    assert m, nombre
    return m.group(0)

def cambia(txt, viejo, nuevo):
    assert txt.count(viejo) == 1, ('no está una sola vez', viejo[:60], txt.count(viejo))
    return txt.replace(viejo, nuevo)

abrir = cambia(fn('driver_open_routes'),
"""         -- 0163: con el despacho encendido las llegadas las reparte el sistema.
         AND NOT (ra.direction = 'airport_to_home' AND public.despacho_encendido())
""",
"""         -- 0165: con el despacho encendido, una llegada en espera se ofrece cuando ya
         -- está por salir (despacho_tomable) y nunca al que tiene el carro de apoyo.
         AND (ra.direction <> 'airport_to_home' OR NOT public.despacho_encendido()
              OR (public.despacho_tomable(ra.id) AND v_dp IS DISTINCT FROM public.apoyo_de_turno(v_org, now())))
""")

tomar = fn('driver_take_route')
tomar = cambia(tomar,
"""  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');   -- 0151
BEGIN""",
"""  v_sello text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');   -- 0151
  v_espera boolean := false;   -- 0165: era una llegada en espera del despacho
  v_quien  text;               -- 0165
BEGIN""")
tomar = cambia(tomar,
"""  -- 0163: con el despacho encendido una llegada en espera no se toma a mano (si
  -- alguien la toma la noche anterior, el sistema ya no la reparte con el vuelo).
  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x
       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NULL) THEN
    RAISE EXCEPTION 'Las llegadas las reparte el sistema cuando el vuelo confirma la hora' USING ERRCODE = 'P0001';
  END IF;
""",
"""  -- 0165: con el despacho encendido una llegada en espera SÍ se puede tomar, pero
  -- solo cuando ya está por salir (no la noche anterior: regla del 10-nov) y nunca
  -- por el que tiene el carro de apoyo (ese solo sale si los fijos no alcanzan).
  IF public.despacho_encendido() AND EXISTS (SELECT 1 FROM public.route_assignments x
       WHERE x.id = p_route AND x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NULL) THEN
    IF v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(v_org, now()) THEN
      RAISE EXCEPTION 'Tienes el carro de apoyo: las llegadas te las da el sistema o Coordinación' USING ERRCODE = 'P0001';
    END IF;
    IF NOT public.despacho_tomable(p_route) THEN
      RAISE EXCEPTION 'Todavía no: esta llegada se puede tomar cuando falten 40 min o menos para que salga de JMC' USING ERRCODE = 'P0001';
    END IF;
    v_espera := true;
  END IF;
""")
tomar = cambia(tomar,
"""  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
""",
"""  PERFORM public.route_sync_assigned(ra.id);
  SELECT * INTO ra FROM public.route_assignments WHERE id = ra.id;   -- con el carro de su turno (0124)
  -- 0165: queda escrito que la tomó un conductor. Con ese rastro el sistema no se
  -- la quita aunque se atrase (despacho_soltar_atrasadas): avisa a los jefes.
  IF v_espera THEN
    SELECT string_agg(split_part(coalesce(pr.full_name, rs.guest_name, 'Tripulante'), ' ', 1), ', ' ORDER BY rs.stop_order) INTO v_quien
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = ra.id;
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
    VALUES (ra.organization_id, ra.id, v_dp, 'tomada', ra.planned_start_at, 0, v_quien, jsonb_build_object('por', 'conductor'));
  END IF;
  SELECT split_part(pr.full_name, ' ', 1) INTO v_me FROM public.profiles pr WHERE pr.id = auth.uid();
""")

soltar = fn('despacho_soltar_atrasadas')
soltar = cambia(soltar,
"""  IF NOT public.despacho_encendido() THEN RETURN 0; END IF;
""",
"""  IF NOT public.despacho_encendido() THEN RETURN 0; END IF;
  -- 0165: las que TOMÓ un conductor no se le quitan. Si viene 10+ min atrasado,
  -- se enteran los jefes (una vez por vuelta) y ellos deciden.
  FOR v IN
    SELECT x.id, x.driver_profile_id AS dp, x.planned_start_at AS ini
      FROM public.route_assignments x
     WHERE x.direction = 'airport_to_home' AND x.pool AND x.driver_profile_id IS NOT NULL
       AND x.status = 'planned' AND x.delegated_at IS NULL AND x.organization_id IS NOT NULL
       AND x.planned_start_at BETWEEN now() - interval '20 minutes' AND now() + interval '25 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = x.id AND rs.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.arrival_dispatch_log g
                    WHERE g.route_assignment_id = x.id AND g.kind = 'tomada' AND g.driver_profile_id = x.driver_profile_id)
     ORDER BY x.planned_start_at
  LOOP
    BEGIN
      ev := public.cadena_evaluar(v.id, true);
      CONTINUE WHEN ev IS NULL OR NOT coalesce((ev->>'known')::boolean, false);
      v_late := coalesce((ev->>'late_min')::int, 0);
      CONTINUE WHEN v_late < 10;
      PERFORM public.despacho_avisar(v.id, 'espera_larga', v.ini, v_late);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'despacho_soltar_atrasadas (tomada %): %', v.id, SQLERRM;
    END;
  END LOOP;
""")
# 0165: una que tomó un conductor nunca entra al lazo de «devolver» (aunque antes la hubiera dado el sistema al mismo).
soltar = cambia(soltar,
"""       AND NOT EXISTS (SELECT 1 FROM public.arrival_dispatch_log g WHERE g.route_assignment_id = x.id AND g.kind = 'devuelta')
""",
"""       AND NOT EXISTS (SELECT 1 FROM public.arrival_dispatch_log g WHERE g.route_assignment_id = x.id AND g.kind = 'devuelta')
       AND NOT EXISTS (SELECT 1 FROM public.arrival_dispatch_log g
                        WHERE g.route_assignment_id = x.id AND g.kind = 'tomada' AND g.driver_profile_id = x.driver_profile_id)   -- 0165
""")

cab = """-- =============================================================================
-- 0165 · Llegadas: el sistema reparte Y el conductor puede tomar
-- =============================================================================
-- Harold, 15-nov (noche), después de oír a un conductor: «es mucho mejor que
-- aparezca un listado y uno como conductor los vaya tomando… porque no sabemos a
-- qué hora realmente van a salir». Decisión: las dos cosas. El sistema sigue
-- repartiendo las llegadas en espera (0158–0163); además el conductor que está en
-- el aeropuerto puede tomar una. Y lo que toma un conductor, el sistema NO se lo
-- quita ni lo reasigna.
--
--   · despacho_tomable(vuelta): una llegada en espera se puede tomar cuando faltan
--     40 min o menos para que salga de JMC (su hora ya viene corrida por el vuelo:
--     despacho_poner_horas). Antes de eso no: nada de tomarlas la noche anterior
--     ni de guardarse las de toda la tarde.
--   · driver_open_routes (DESDE 0163): con el despacho encendido muestra esas
--     llegadas. Al que tiene el carro de apoyo no (sale solo si los fijos no alcanzan).
--   · driver_take_route (DESDE 0163): la deja tomar con esas dos condiciones y
--     escribe el rastro «tomada». Si se le cruza con otra suya se toma igual y
--     se avisa a Coordinación (0151, sin cambio). Gana el primero que guarde: si
--     el sistema la repartió un instante antes, dice «ya la tomó otro conductor».
--   · despacho_soltar_atrasadas (DESDE 0163): una «tomada» nunca vuelve a la
--     espera; si su conductor viene 10+ min atrasado, avisa a los jefes.
--
-- Sin cambios en la app: «Vueltas para tomar» pinta lo que devuelve
-- driver_open_routes. Soltar una llegada sigue siendo de Coordinación (0163).
-- Con el despacho APAGADO todo queda como antes de 0163.
-- Generada con scripts/_gen-0165.py. Lo próximo que toque estas tres funciones
-- copia DESDE 0165.
-- =============================================================================
BEGIN;

-- El rastro del despacho aprende otra palabra: «tomada» (por un conductor).
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga', 'devuelta', 'tomada'));

-- ¿Ya se puede tomar esta llegada en espera?
CREATE OR REPLACE FUNCTION public.despacho_tomable(p_ra uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT ra.planned_start_at <= now() + interval '40 minutes'
                     FROM public.route_assignments ra WHERE ra.id = p_ra), false);
$$;
COMMENT ON FUNCTION public.despacho_tomable(uuid) IS
  '0165: true si a la llegada le faltan 40 min o menos para salir de JMC: desde ahí un conductor la puede tomar aunque el despacho esté encendido.';

"""
pie = """
REVOKE ALL ON FUNCTION public.despacho_tomable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_tomable(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.despacho_soltar_atrasadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_soltar_atrasadas() TO service_role;

COMMIT;
"""
(M / '0165_llegadas_reparte_y_se_toman.sql').write_text(cab + abrir + '\n' + tomar + '\n' + soltar + pie)

down = """-- Reversa de 0165: las tres funciones vuelven a 0163 y el rastro olvida «tomada».
BEGIN;
""" + fn('driver_open_routes') + '\n' + fn('driver_take_route') + '\n' + fn('despacho_soltar_atrasadas') + """
REVOKE ALL ON FUNCTION public.despacho_soltar_atrasadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_soltar_atrasadas() TO service_role;
DROP FUNCTION IF EXISTS public.despacho_tomable(uuid);
DELETE FROM public.arrival_dispatch_log WHERE kind = 'tomada';
ALTER TABLE public.arrival_dispatch_log DROP CONSTRAINT IF EXISTS arrival_dispatch_log_kind_valid;
ALTER TABLE public.arrival_dispatch_log ADD CONSTRAINT arrival_dispatch_log_kind_valid
  CHECK (kind IN ('asignada', 'sin_carro', 'espera_larga', 'devuelta'));
COMMIT;
"""
(M.parent.parent / 'down_migrations' / '0165_llegadas_reparte_y_se_toman.down.sql').write_text(down)
print('ok')
