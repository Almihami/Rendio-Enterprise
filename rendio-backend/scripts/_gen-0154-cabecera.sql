-- =============================================================================
-- 0154 · El acomodo de llegadas le pasa la vuelta al conductor que SÍ alcanza
-- (28-oct-2026, la profa: «por qué el sistema no está automatizando las llegadas?
-- está reportando que los vuelos cambian, que se atrasó y todo, pero no los cambian»)
-- =============================================================================
--
-- Lo que se vio en producción ese día (solo lectura): el acomodo (0135/0144) SÍ
-- corrió 9 llegadas por FR24. Cuando su mismo conductor alcanzaba la hora nueva
-- quedó resuelto (Fernando 14:55→15:25 con Juan; Luz y Sara 15:40→15:50 con
-- Lennin). Cuando NO alcanzaba, la vuelta quedó «para tomar» sin conductor y nadie
-- la tomó: Jessica Sánchez (8:50), Henry (12:05, a las 4 p. m. seguía sin recoger
-- en la app) y Alejandra (13:15). Además, a Juan le llegó «Tu vuelta cambió de
-- hora» TRES veces: la llave del aviso era el id de la vuelta, y al re-publicar el
-- tablero el id cambia.
--
-- Ahora, cuando todos los de una llegada vienen tarde y su conductor no alcanza:
--   1. se corre la hora (como antes);
--   2. se busca a OTRO conductor del turno de esa hora (conductores_del_turno),
--      con turno ABIERTO (tiene carro), que llegue a tiempo y no se le cruce con lo
--      que ya tiene, con cupo: cadena_candidato de 0152. Gana el que llega antes;
--      si llegan casi igual, el que lleva más rato libre;
--   3. si hay: la vuelta queda con él (sigue siendo del tablero, no «para tomar»);
--      avisos: al que la tenía («la hace X»), al nuevo («Te asignamos una
--      llegada»), a los tripulantes («te lleva X») y una línea a los jefes;
--   4. si no hay, o ya se hicieron acomodo_max_nuevas (4) reasignaciones en 30 min
--      (freno), queda para tomar como antes.
-- Las vueltas pegadas (pool) siguen como antes. Las llaves de los avisos al
-- conductor van por conductor + persona + hora (no por id de vuelta).
--
-- Copias: reub_nota y acomodar_eventualidades DESDE 0144 (huellas en
-- _aplicar-0154.mjs). Lo próximo que las toque copia DESDE 0154.
-- Idempotente. Down: down_migrations/0154_acomodo_asigna_conductor.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ¿Quién más puede hacer esta vuelta? (la vuelta ya con su hora nueva)
--    → { dp, profile, name, eta, why } o NULL.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acomodo_otro_conductor(p_ra uuid, p_excluir uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra public.route_assignments; v_org uuid; e record; c record; k record;
  b_dp uuid; b_prof uuid; b_name text; b_eta timestamptz; b_free timestamptz; b_why text;
BEGIN
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_ra;
  IF ra.id IS NULL THEN RETURN NULL; END IF;
  v_org := coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
             JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
            WHERE x.route_assignment_id = ra.id LIMIT 1));
  SELECT * INTO e FROM public.reub_extremos(ra.id);
  IF v_org IS NULL OR e.ini_at IS NULL THEN RETURN NULL; END IF;
  FOR c IN
    SELECT dp.id AS dp, dp.profile_id, pr.full_name
      FROM public.conductores_del_turno(v_org, e.ini_at) t
      JOIN public.driver_profiles dp ON dp.profile_id = t.profile_id JOIN public.profiles pr ON pr.id = dp.profile_id
     WHERE dp.id IS DISTINCT FROM p_excluir
       -- Con turno abierto: tiene carro y está trabajando (no solo en el horario).
       AND EXISTS (SELECT 1 FROM public.shifts sh WHERE sh.driver_id = dp.id AND sh.status::text <> 'closed'
                     AND sh.start_at > now() - interval '16 hours')
  LOOP
    SELECT * INTO k FROM public.cadena_candidato(ra.id, c.dp);
    CONTINUE WHEN NOT coalesce(k.ok, false);
    -- El que llega antes; si llegan casi igual, el que lleva más rato libre (como 0152).
    IF b_dp IS NULL OR k.eta < b_eta - interval '2 minutes'
       OR (k.eta <= b_eta + interval '2 minutes' AND k.free_at < b_free) THEN
      b_dp := c.dp; b_prof := c.profile_id; b_name := c.full_name; b_eta := k.eta; b_free := k.free_at; b_why := k.why;
    END IF;
  END LOOP;
  IF b_dp IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('dp', b_dp, 'profile', b_prof, 'name', b_name, 'eta', b_eta, 'why', b_why);
END;
$$;
REVOKE ALL ON FUNCTION public.acomodo_otro_conductor(uuid, uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.acomodo_otro_conductor(uuid, uuid)
  IS '0154: el conductor del turno (con turno abierto) que mejor alcanza esta vuelta, sin contar a p_excluir; NULL si nadie.';

-- -----------------------------------------------------------------------------
-- 2. El freno: no más de acomodo_max_nuevas reasignaciones por media hora.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acomodo_reasignar_permitido(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(DISTINCT coalesce(i.details->'reubicada'->>'start_at', '') || i.reservation_id::text)
         < coalesce((SELECT s.acomodo_max_nuevas FROM public.app_settings s WHERE s.id = 'singleton'), 4)
    FROM public.incidents i
   WHERE i.organization_id IS NOT DISTINCT FROM p_org AND i.source = 'system'
     AND i.details->'reubicada'->>'reassigned_from' IS NOT NULL
     AND i.occurred_at > now() - interval '30 minutes';
$$;
REVOKE ALL ON FUNCTION public.acomodo_reasignar_permitido(uuid) FROM PUBLIC, anon, authenticated;
