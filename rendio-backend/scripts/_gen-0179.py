#!/usr/bin/env python3
# Genera supabase/migrations/0179_hora_sin_conductor.sql (y su down) COPIANDO Y PARCHANDO la
# definición viva de auxiliar_my_trips (scripts/_base-0179/prod-auxiliar_my_trips.sql, bajada de
# PRODUCCIÓN el 24-nov-2026 con scripts/_base-0179/bajar.mjs; dev es idéntica). Cada parche exige
# encontrar su texto EXACTO una vez: si la función cambió, el generador falla.
#   cd rendio-backend && python3 scripts/_gen-0179.py
import io, os
B = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(B)
leer = lambda f: io.open(os.path.join(B, '_base-0179', 'prod-%s.sql' % f), encoding='utf-8').read().rstrip('\n')
escribir = lambda p, t: io.open(os.path.join(R, p), 'w', encoding='utf-8').write(t)

def parchar(nombre, txt, parches):
    for viejo, nuevo in parches:
        n = txt.count(viejo)
        if n != 1:
            raise SystemExit('%s: el texto a cambiar aparece %d veces (esperaba 1):\n%s' % (nombre, n, viejo[:200]))
        txt = txt.replace(viejo, nuevo)
    return txt

amt0 = leer('auxiliar_my_trips')
amt1 = parchar('auxiliar_my_trips', amt0, [
    # La organización del tripulante (para saber si su día está publicado).
    ("""  v_days int  := least(greatest(coalesce(p_days_back, 60), 1), 400);
""", """  v_days int  := least(greatest(coalesce(p_days_back, 60), 1), 400);
  -- 0179: para saber si la ruta del día de una vuelta sin conductor ya está publicada.
  v_org  uuid := (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid());
"""),
    # La hora de la parada (la del plan), para la vuelta sin conductor.
    ("""               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped
""", """               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped,
               rs.estimated_arrival_at AS eta                              -- 0179: la hora de mi parada en el plan
"""),
    # La vuelta sin conductor (borrador) cuenta si la ruta de su día ya está publicada.
    ("""          AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
          AND ra.status IN ('planned', 'in_progress', 'completed')
""", """          AND (((ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
                 AND ra.status IN ('planned', 'in_progress', 'completed'))
               -- 0179 (24-nov-2026, Harold: «tenga o no conductor, debería mostrar la hora»):
               -- la salida en una vuelta SIN conductor (borrador del jefe: «Carro 3») de un
               -- día cuya ruta el jefe ya publicó (marca 0178). La hora es la del plan; el
               -- conductor es asunto del jefe. Antes de publicar, nada cambia: sin hora.
               OR (ra.status = 'draft' AND NOT coalesce(ra.auto_created, false)
                   AND ra.direction = 'home_to_airport'
                   AND public.dia_publicado(v_org, ra.planned_start_at)))
"""),
    ("""               (s.ra_status IN ('planned', 'in_progress')) IS TRUE AS pub,
""", """               (s.ra_status IN ('planned', 'in_progress', 'draft')) IS TRUE AS pub,
               (s.ra_status = 'draft') IS TRUE AS borr,                   -- 0179: publicada sin conductor
"""),
    # Sin conductor: la hora es la de su parada (calculated_pickup_at la llena el jefe al
    # poner conductor; en el borrador está vacía o es de un plan viejo).
    ("""          'pickup_at',             CASE WHEN k.pub THEN r.calculated_pickup_at END,
          'meet_code',             CASE WHEN k.pub THEN r.meet_code END,
""", """          'pickup_at',             CASE WHEN k.pub THEN CASE WHEN k.borr THEN s.eta ELSE r.calculated_pickup_at END END,
          -- 0179: el código es para encontrarse con el conductor: sin conductor no se dice.
          'meet_code',             CASE WHEN k.pub AND NOT k.borr THEN r.meet_code END,
"""),
    # Sin conductor no hay carro que mostrar.
    ("""          'vehicle', CASE WHEN s.ra_id IS NULL OR v.id IS NULL THEN NULL ELSE jsonb_build_object(
""", """          'vehicle', CASE WHEN s.ra_id IS NULL OR v.id IS NULL OR k.borr THEN NULL ELSE jsonb_build_object(
"""),
    # Mi lugar en el carro: en el borrador, solo dentro de MI vuelta (no hay carro del turno).
    ("""                     OR (ra2.vehicle_id = s.veh
""", """                     OR (NOT k.borr AND ra2.vehicle_id = s.veh
"""),
])
if amt1.count('0179') != 5 or amt1.count('k.borr') != 4:
    raise SystemExit('auxiliar_my_trips: faltan parches')

CAB = """-- =============================================================================
-- 0179 · La hora de recogida se dice aunque la vuelta no tenga conductor
-- =============================================================================
-- 24-nov-2026, 9:30 p. m. «Están reportando que no ven la hora». Leído en producción:
-- Cris publicó el miércoles 25 a las 8:01 p. m. (marca 0178 puesta); de 35 salidas, 27
-- veían la hora y 8 no. Las 8 iban en 5 vueltas del «Carro 3» y el «Carro 4» que el
-- tablero dejó en BORRADOR, sin conductor: 4:05 (Andrea Núñez 4:05, Alejandra Romero
-- 4:15, Gersey 4:25), 9:20, 10:55 (Carlos 10:55, Jessica 11:10), 11:25 y 13:10. Cada
-- parada YA tenía su hora en el plan; la app la escondía porque auxiliar_my_trips solo
-- daba hora con conductor, pool o delegada. Alejandra abrió la app 36 veces esa noche.
--
-- Harold: «tenga o no conductor, debería mostrar la hora, ¿por qué está esperando al
-- conductor? No tiene sentido».
--
-- Qué cambia (solo auxiliar_my_trips):
--   · Una SALIDA en una vuelta sin conductor (borrador de un jefe, no automática) cuenta
--     como publicada si la ruta de su día ya está publicada (dia_publicado, 0178).
--   · Su hora es la de su parada en el plan (route_stops.estimated_arrival_at): en el
--     borrador calculated_pickup_at está vacía. Con conductor sigue siendo la de siempre.
--   · driver_pending = true: la app dice «Tu ruta está lista · Te avisamos quién te
--     recoge…». Sin código de encuentro ni carro (no hay con quién encontrarse).
--   · Su lugar en el carro («Recogida 2/3») se cuenta dentro de su vuelta.
-- Antes de publicar el día nada cambia: el borrador sigue sin hora («te avisamos la hora
-- cuando armemos tu ruta»). Las llegadas no cambian (no quedan en borrador, 0175).
--
-- El aviso «Tu hora de recogida» al publicar lo manda el teléfono del jefe (api.js
-- saveRoutePlan → horasBorrador, admin-rutas.js), no esta migración.
--
-- Deshacer: down_migrations/0179_hora_sin_conductor.down.sql (la función de antes).
-- =============================================================================
BEGIN;

"""
PIE = """

COMMENT ON FUNCTION public.auxiliar_my_trips(integer)
  IS '0179: los viajes del tripulante; la salida en una vuelta sin conductor de un día publicado trae la hora de su parada.';

COMMIT;
"""
escribir('supabase/migrations/0179_hora_sin_conductor.sql', CAB + amt1 + ';' + PIE)
escribir('down_migrations/0179_hora_sin_conductor.down.sql',
         "-- Deshace 0179: auxiliar_my_trips como estaba (sin hora para la vuelta sin conductor).\nBEGIN;\n\n"
         + amt0 + ";\n\nCOMMENT ON FUNCTION public.auxiliar_my_trips(integer) IS NULL;\n\nCOMMIT;\n")
print('ok: 0179 y su down')
