#!/usr/bin/env python3
# Genera supabase/migrations/0178_hora_solo_con_ruta_publicada.sql (y su down) COPIANDO Y PARCHANDO
# las definiciones vivas (scripts/_base-0178/prod-*.sql, bajadas de PRODUCCIÓN el 18-nov-2026 con
# scripts/_base-0178/usos.mjs; dev era idéntica). Cada parche exige encontrar su texto EXACTO una
# vez: si la función cambió, el generador falla.
#   cd rendio-backend && python3 scripts/_gen-0178.py
import io, os
B = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(B)
leer = lambda f: io.open(os.path.join(B, '_base-0178', 'prod-%s.sql' % f), encoding='utf-8').read().rstrip('\n')
escribir = lambda p, t: io.open(os.path.join(R, p), 'w', encoding='utf-8').write(t)

def parchar(nombre, txt, parches):
    for viejo, nuevo in parches:
        n = txt.count(viejo)
        if n != 1:
            raise SystemExit('%s: el texto a cambiar aparece %d veces (esperaba 1):\n%s' % (nombre, n, viejo[:200]))
        txt = txt.replace(viejo, nuevo)
    return txt

reub0 = leer('reubicar_reserva')
det0 = leer('detect_late_bookings')

# ── reubicar_reserva: «día publicado» = la MARCA del jefe, no «hay alguna vuelta ese día» ──
a = reub0.index("  -- ¿El día ya tiene ruta publicada?")
b = reub0.index("  IF NOT v_pub_dia THEN")
viejo_pub = reub0[a:b]
if viejo_pub.count('dia_del_plan') != 1 or viejo_pub.count('v_pub_dia := EXISTS (') != 1:
    raise SystemExit('reubicar_reserva: el bloque de «día publicado» no es el esperado:\n' + viejo_pub)
nuevo_pub = """  -- ¿El día ya tiene ruta publicada? (antes de tocar nada)
  -- 0178 (18-nov-2026, Harold: «no podemos decir una hora de recogida, nunca, sino hasta la
  -- noche, que ya tengamos la ruta armada»). Antes se DEDUCÍA: «hay alguna vuelta ese día».
  -- El 16-nov una llegada de las 00:40 del miércoles (de la ruta del martes) quedó sin su
  -- día del plan y el miércoles pasó por publicado: a 35 pedidos el sistema les armó vuelta
  -- y les dijo hora la víspera, antes de la lista; a 21 salidas la lista se la adelantó.
  -- Ahora manda la MARCA que queda cuando el jefe publica (route_published_days). A quien
  -- el jefe ya tiene en una vuelta suya se le sigue atendiendo el cambio: no se le saca.
  v_pub_dia := public.dia_publicado(r.org, r.required_arrival_at)
    OR EXISTS (
      SELECT 1 FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
       WHERE rs.reservation_id = p_res AND ra.status IN ('planned', 'in_progress')
         AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
         AND NOT coalesce(ra.auto_created, false));

"""
reub = reub0[:a] + nuevo_pub + reub0[b:]

# ── detect_late_bookings: la madrugada sin día del plan es del día ANTERIOR ──
det = parchar('detect_late_bookings', det0, [
    ("          AND public.dia_del_plan((to_jsonb(ra) ->> 'manual_day')::date, ra.planned_start_at)\n"
     "              IN (",
     "          -- 0178: una vuelta de la madrugada (antes del corte) SIN día del plan es del día\n"
     "          -- anterior: ya no hace pasar por publicado el día siguiente.\n"
     "          AND coalesce((to_jsonb(ra) ->> 'manual_day')::date, public.dia_madrugada(ra.planned_start_at),\n"
     "                       (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date)\n"
     "              IN ("),
])

CAB = """-- =============================================================================
-- 0178 · La hora de recogida solo se dice con la ruta del día PUBLICADA
-- =============================================================================
-- 18-nov-2026. Tres audios de esa mañana: a los tripulantes «les cambiaron la hora».
-- Leído en producción: de 34 salidas del miércoles 18, a 23 el sistema les había dicho
-- «Ya tienes carro: te recogemos a las X» la víspera, ANTES de que existiera la lista
-- del jefe; a 21 la lista se la adelantó (5 a 40 min) y ya tenían el despertador puesto.
--
-- Por qué: «pidió con el día ya publicado» (0135) es la única regla que le dice hora a
-- alguien sin que un jefe la haya puesto, y decidía «publicado» por DEDUCCIÓN: existe
-- alguna vuelta ese día. Bastó una llegada de las 00:40 del miércoles (de la ruta del
-- martes, que un script dejó sin su día del plan) para que el miércoles entero pasara
-- por publicado desde el lunes en la noche. El 27, 28 y 29 de octubre ya se había
-- escapado uno por día de la misma forma.
--
-- Harold: «nosotros no podemos decir una hora de recogida, nunca, sino hasta la noche
-- tipo 8-9 que ya tengamos la ruta armada, porque dependemos del día».
--
-- Qué cambia:
--   1. route_published_days: la MARCA «el jefe publicó la ruta de este día». La deja un
--      disparador cuando UN JEFE crea una vuelta publicada (Publicar del tablero, pegar
--      la ruta: admin_manual_route_publish) o pasa un borrador a publicada (poner
--      conductor / delegar una vuelta). Nunca la deja el sistema: ni una vuelta que armó
--      solo, ni una que un conductor soltó, ni una que el reloj corrió de hora.
--      La vuelta de la madrugada (antes del corte) sin día del plan marca el día ANTERIOR.
--   2. reubicar_reserva: «día publicado» = hay marca (o la persona ya va en una vuelta
--      que puso un jefe). Sin marca devuelve 'unplanned', como siempre que no hay ruta:
--      el pedido queda sin hora y el tablero lo rutea al publicar.
--   3. detect_late_bookings («X no tiene carro»): la madrugada sin día del plan cuenta
--      para el día anterior, para que no les suene a los jefes un día que no han armado.
--   4. Se marcan los días que HOY ya están publicados (ayer en adelante).
--
-- Un script que publique sin pasar por admin_manual_route_publish con la sesión de un
-- jefe debe marcar el día él mismo: SELECT public.marcar_dia_publicado(org, día, quién, 'script').
--
-- Generada con scripts/_gen-0178.py desde las definiciones vivas de producción del
-- 18-nov-2026 (scripts/_base-0178/). Down: down_migrations/0178_hora_solo_con_ruta_publicada.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La marca
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_published_days (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  published_by    uuid NULL,
  source          text NOT NULL DEFAULT 'tablero',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_published_days_org_day UNIQUE (organization_id, day)
);
DROP TRIGGER IF EXISTS tr_route_published_days_set_updated_at ON public.route_published_days;
CREATE TRIGGER tr_route_published_days_set_updated_at
  BEFORE UPDATE ON public.route_published_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.route_published_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.route_published_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.route_published_days TO authenticated;
-- El jefe la puede leer (la escriben solo las funciones de abajo).
DROP POLICY IF EXISTS route_published_days_admin_read ON public.route_published_days;
CREATE POLICY route_published_days_admin_read ON public.route_published_days
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');
COMMENT ON TABLE public.route_published_days
  IS '0178: el jefe publicó la ruta de este día. Sin esta marca el sistema no le arma vuelta ni le dice hora a quien pide.';

CREATE OR REPLACE FUNCTION public.marcar_dia_publicado(p_org uuid, p_day date, p_by uuid DEFAULT NULL, p_source text DEFAULT 'tablero')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_org IS NULL OR p_day IS NULL THEN RETURN false; END IF;
  INSERT INTO public.route_published_days (organization_id, day, published_by, source)
  VALUES (p_org, p_day, p_by, coalesce(nullif(btrim(p_source), ''), 'tablero'))
  ON CONFLICT (organization_id, day) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text) TO service_role;
COMMENT ON FUNCTION public.marcar_dia_publicado(uuid, date, uuid, text)
  IS '0178: deja la marca «ruta publicada» de un día (una sola vez). true si la puso ahora.';

-- ¿Está publicada la ruta del día de esta hora? La madrugada (antes del corte) cuenta
-- también para el día anterior, como en 0143.
CREATE OR REPLACE FUNCTION public.dia_publicado(p_org uuid, p_when timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_org IS NOT NULL AND p_when IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.route_published_days d
     WHERE d.organization_id = p_org
       AND d.day IN ((p_when AT TIME ZONE 'America/Bogota')::date, public.dia_madrugada(p_when)));
$$;
REVOKE ALL ON FUNCTION public.dia_publicado(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dia_publicado(uuid, timestamptz) TO service_role;
COMMENT ON FUNCTION public.dia_publicado(uuid, timestamptz)
  IS '0178: true si el jefe ya publicó la ruta del día de esa hora (route_published_days).';

-- -----------------------------------------------------------------------------
-- 2. Quién deja la marca: un JEFE que publica una vuelta
-- -----------------------------------------------------------------------------
-- Una vuelta queda 'planned' por tres caminos del jefe: Publicar del tablero (la app la
-- inserta directo), pegar la ruta (admin_manual_route_publish la inserta) y poner
-- conductor o delegar un borrador (admin_route_set_driver y compañía la actualizan).
-- En los tres la sesión es la del jefe. Lo que arma el sistema lleva auto_created, lo
-- que suelta un conductor lleva la sesión del conductor y el reloj no lleva ninguna.
CREATE OR REPLACE FUNCTION public.tg_route_assignments_dia_publicado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.status::text <> 'planned' OR NEW.planned_start_at IS NULL OR coalesce(NEW.auto_created, false) THEN RETURN NULL; END IF;
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN RETURN NULL; END IF;
  v_org := public.current_user_org();
  IF v_org IS NULL OR (NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org) THEN RETURN NULL; END IF;
  PERFORM public.marcar_dia_publicado(
    v_org,
    -- El día del plan si lo trae (ruta pegada); la madrugada es del día anterior.
    coalesce(NEW.manual_day, public.dia_madrugada(NEW.planned_start_at), (NEW.planned_start_at AT TIME ZONE 'America/Bogota')::date),
    auth.uid(),
    CASE WHEN TG_OP = 'UPDATE' THEN 'vuelta' WHEN NEW.manual_day IS NOT NULL THEN 'pegar' ELSE 'tablero' END);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'marcar día publicado (%): %', NEW.id, SQLERRM;   -- publicar nunca se cae por esto
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_route_assignments_dia_publicado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_ins ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_dia_publicado_ins
  AFTER INSERT ON public.route_assignments
  FOR EACH ROW WHEN (NEW.status = 'planned')
  EXECUTE FUNCTION public.tg_route_assignments_dia_publicado();
DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_upd ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_dia_publicado_upd
  AFTER UPDATE OF status ON public.route_assignments
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'planned')
  EXECUTE FUNCTION public.tg_route_assignments_dia_publicado();

-- -----------------------------------------------------------------------------
-- 3. Los días que hoy ya están publicados (de ayer en adelante)
-- -----------------------------------------------------------------------------
INSERT INTO public.route_published_days (organization_id, day, published_at, source)
SELECT z.org, z.dia, min(z.creada), 'previa-0178'
  FROM (
    SELECT coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
              JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
             WHERE x.route_assignment_id = ra.id LIMIT 1)) AS org,
           coalesce(ra.manual_day, public.dia_madrugada(ra.planned_start_at), (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date) AS dia,
           ra.created_at AS creada
      FROM public.route_assignments ra
     WHERE ra.status IN ('planned', 'in_progress', 'completed')
       AND (ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)
       AND NOT coalesce(ra.auto_created, false)
       AND ra.planned_start_at >= now() - interval '3 days') z
 WHERE z.org IS NOT NULL AND z.dia >= (now() AT TIME ZONE 'America/Bogota')::date - 1
 GROUP BY 1, 2
ON CONFLICT (organization_id, day) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. reubicar_reserva: «día publicado» = la marca
-- -----------------------------------------------------------------------------
"""

up = CAB + reub + ";\n\n" + """-- -----------------------------------------------------------------------------
-- 5. «X no tiene carro»: la madrugada sin día del plan es del día anterior
-- -----------------------------------------------------------------------------
""" + det + ";\n\nCOMMIT;\n"

down = """-- Down de 0178: vuelve la deducción («hay alguna vuelta ese día») y se quita la marca.
BEGIN;

DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_ins ON public.route_assignments;
DROP TRIGGER IF EXISTS tr_route_assignments_dia_publicado_upd ON public.route_assignments;

""" + reub0 + ";\n\n" + det0 + """;

DROP FUNCTION IF EXISTS public.tg_route_assignments_dia_publicado();
DROP FUNCTION IF EXISTS public.dia_publicado(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.marcar_dia_publicado(uuid, date, uuid, text);
DROP TABLE IF EXISTS public.route_published_days;

COMMIT;
"""

escribir('supabase/migrations/0178_hora_solo_con_ruta_publicada.sql', up)
escribir('down_migrations/0178_hora_solo_con_ruta_publicada.down.sql', down)
print('0178: up %d líneas · down %d líneas' % (up.count('\n'), down.count('\n')))
