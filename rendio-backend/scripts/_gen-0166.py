# Genera 0166 copiando de 0165 las dos funciones que toca y parchándolas.
import re, pathlib
M = pathlib.Path(__file__).resolve().parent.parent / 'supabase' / 'migrations'
src = (M / '0165_llegadas_reparte_y_se_toman.sql').read_text()
def fn(nombre):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + nombre + r'\(.*?\n\$\$;\n', src, re.S); assert m, nombre; return m.group(0)
def cambia(txt, viejo, nuevo):
    assert txt.count(viejo) == 1, ('no está una sola vez', viejo[:60], txt.count(viejo)); return txt.replace(viejo, nuevo)

abrir = cambia(fn('driver_open_routes'),
"""         -- 0165: con el despacho encendido, una llegada en espera se ofrece cuando ya
         -- está por salir (despacho_tomable) y nunca al que tiene el carro de apoyo.
         AND (ra.direction <> 'airport_to_home' OR NOT public.despacho_encendido()
              OR (public.despacho_tomable(ra.id) AND v_dp IS DISTINCT FROM public.apoyo_de_turno(v_org, now())))
""",
"""         -- 0165: con el despacho encendido, una llegada en espera se ofrece cuando ya
         -- está por salir (despacho_tomable). 0166: también al que tiene el apoyo.
         AND (ra.direction <> 'airport_to_home' OR NOT public.despacho_encendido() OR public.despacho_tomable(ra.id))
""")
tomar = fn('driver_take_route')
tomar = cambia(tomar,
"""  v_quien  text;               -- 0165
BEGIN""",
"""  v_quien  text;               -- 0165
  v_apoyo  boolean := false;   -- 0166: la tomó el que tiene el carro de apoyo
BEGIN""")
tomar = cambia(tomar,
"""  -- 0165: con el despacho encendido una llegada en espera SÍ se puede tomar, pero
  -- solo cuando ya está por salir (no la noche anterior: regla del 10-nov) y nunca
  -- por el que tiene el carro de apoyo (ese solo sale si los fijos no alcanzan).
""",
"""  -- 0165: con el despacho encendido una llegada en espera SÍ se puede tomar, pero
  -- solo cuando ya está por salir (no la noche anterior: regla del 10-nov).
  -- 0166: el que tiene el carro de apoyo también (Harold: «si necesitamos un apoyo
  -- el sistema se las asigna… él debería poder verlas»); como ese carro se paga por
  -- vuelta, los jefes se enteran cada vez que toma una (abajo).
""")
tomar = cambia(tomar,
"""    IF v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(v_org, now()) THEN
      RAISE EXCEPTION 'Tienes el carro de apoyo: las llegadas te las da el sistema o Coordinación' USING ERRCODE = 'P0001';
    END IF;
""", "")
tomar = cambia(tomar,
"""    VALUES (ra.organization_id, ra.id, v_dp, 'tomada', ra.planned_start_at, 0, v_quien, jsonb_build_object('por', 'conductor'));
  END IF;
""",
"""    v_apoyo := v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(ra.organization_id, now());
    VALUES (ra.organization_id, ra.id, v_dp, 'tomada', ra.planned_start_at, 0, v_quien, jsonb_build_object('por', 'conductor', 'apoyo', v_apoyo));
    -- 0166: salió el carro de apoyo por decisión del conductor: los jefes se enteran.
    IF v_apoyo THEN
      SELECT pr.full_name INTO v_full FROM public.profiles pr WHERE pr.id = auth.uid();
      PERFORM public.trip_notify(j.profile_id, 'Salió el carro de apoyo 🚐',
        coalesce(public.short_name(v_full), 'El de apoyo') || ' tomó la llegada de ' || coalesce(v_quien, 'una persona') || ' en JMC a las ' || public.hm_bog(ra.planned_start_at) || '.',
        '/#/rutas', 'desp-apoyo-sale:' || ra.id::text || ':' || j.profile_id::text)
        FROM public.ops_alert_recipients_of(ra.organization_id) j;
    END IF;
  END IF;
""")
# el INSERT quedó partido: v_apoyo va ANTES del INSERT
tomar = cambia(tomar,
"""    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
    v_apoyo := v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(ra.organization_id, now());
""",
"""    v_apoyo := v_dp IS NOT DISTINCT FROM public.apoyo_de_turno(ra.organization_id, now());
    INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, pickup_at, wait_min, who, detail)
""")
cab = """-- =============================================================================
-- 0166 · El que tiene el carro de apoyo también ve y toma las llegadas
-- =============================================================================
-- Harold, 15-nov (noche), sobre 0165: «Julián no las ve, pero si necesitamos un
-- apoyo el sistema se las asigna… no tiene sentido, él debería poder verlas».
-- 0165 le escondía las llegadas al de apoyo (carro que se paga por vuelta). Ahora
-- las ve y las toma como los demás, con la misma ventana de 40 min, y cada vez que
-- toma una les llega a los jefes «Salió el carro de apoyo» (igual que cuando se la
-- da el sistema). El rastro guarda detail.apoyo. Balance ya cuenta sus vueltas
-- (admin_apoyo_resumen, 0162). driver_open_routes y driver_take_route DESDE 0165:
-- lo próximo que las toque copia DESDE 0166.
-- =============================================================================
BEGIN;

"""
(M / '0166_apoyo_ve_y_toma.sql').write_text(cab + abrir + '\n' + tomar + '\nCOMMIT;\n')
(M.parent.parent / 'down_migrations' / '0166_apoyo_ve_y_toma.down.sql').write_text(
  "-- Reversa de 0166: las dos funciones vuelven a 0165 (el de apoyo no ve ni toma llegadas).\nBEGIN;\n" + fn('driver_open_routes') + '\n' + fn('driver_take_route') + '\nCOMMIT;\n')
print('ok')
