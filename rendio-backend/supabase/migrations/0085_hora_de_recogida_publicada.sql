-- =============================================================================
-- 0085 · La hora de recogida publicada llega a la reserva
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P0 · fase 0.5 y 0.7.
--
-- 1. reservations.calculated_pickup_at existe desde 0001 pero NADIE la escribía:
--    solo se leía (0004 en la RLS, 0005 en cancel_reservation). Por eso la app
--    del tripulante nunca podía decir «Te recogemos a las 03:48» con un dato de
--    verdad. Ahora la mantiene la base, sola, a partir del plan publicado:
--
--      salida  (home_to_airport) → route_stops.estimated_arrival_at de SU parada
--      llegada (airport_to_home) → route_assignments.planned_start_at (el carro
--                                  sale de MDE a esa hora, y en MDE es la cita)
--
--    Cuenta solo una ruta PUBLICADA: con conductor (driver_profile_id) y que no
--    esté cancelada. Un borrador (sin conductor) no publica hora. Una ruta que
--    pasa a 'completed' CONSERVA la hora (el filtro no excluye completed, así el
--    cierre de rutas no borra la hora de lo ya hecho). Al despublicar (ruta
--    cancelada, conductor quitado, parada borrada) vuelve a NULL.
--
--    Efecto documentado: la función vieja cancel_reservation (0005) aplica su
--    regla de «no a menos de 2 h del pickup» en cuanto hay hora. El front NO la
--    llama: cancela con auxiliar_cancel_reservation (0050), que no tiene esa
--    regla. _verify-0085.mjs lo comprueba.
--
-- 2. DROP POLICY p_reservations_update_aux (0004): dejaba al tripulante cambiar
--    CUALQUIER columna de su reserva (incluido el estado) con un UPDATE directo.
--    Verificado el 27-sep: el front no hace UPDATE a reservations como auxiliar
--    (api.js solo INSERT); cancelar, confirmar y calificar van por RPC SECURITY
--    DEFINER (auxiliar_cancel_reservation, auxiliar_confirm_ready,
--    auxiliar_rate_reservation).
--
-- Idempotente: CREATE OR REPLACE, DROP ... IF EXISTS antes de cada CREATE.
-- Down: down_migrations/0085_hora_de_recogida_publicada.down.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1a. La función que calcula y escribe la hora de UNA reserva
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_calculated_pickup(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v timestamptz;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN;
  END IF;

  -- Si la reserva quedó en más de una ruta (una en curso que se conservó y otra
  -- nueva), manda la más reciente.
  SELECT CASE WHEN ra.direction = 'airport_to_home'
              THEN ra.planned_start_at
              ELSE rs.estimated_arrival_at END
    INTO v
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status <> 'cancelled'
    AND ra.driver_profile_id IS NOT NULL
  ORDER BY ra.planned_start_at DESC NULLS LAST, ra.created_at DESC
  LIMIT 1;

  UPDATE public.reservations
     SET calculated_pickup_at = v
   WHERE id = p_reservation_id
     AND calculated_pickup_at IS DISTINCT FROM v;
END;
$$;

COMMENT ON FUNCTION public.sync_calculated_pickup(uuid) IS
  '0085: escribe reservations.calculated_pickup_at desde el plan publicado (salida: ETA de su parada; llegada: salida del carro de MDE). Solo la llaman los triggers.';

-- Nadie la llama desde el teléfono: solo los triggers de abajo (que corren como
-- dueño). Supabase da EXECUTE a anon/authenticated por defecto en funciones nuevas.
REVOKE ALL ON FUNCTION public.sync_calculated_pickup(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1b. Trigger en route_stops: parada nueva, ETA que cambia, parada que se va
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER a propósito: el admin arma el plan como `authenticated`, y
-- `authenticated` ya no puede ejecutar sync_calculated_pickup (REVOKE de arriba).
CREATE OR REPLACE FUNCTION public.tg_route_stops_sync_pickup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.sync_calculated_pickup(OLD.reservation_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND (TG_OP = 'INSERT' OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id) THEN
    PERFORM public.sync_calculated_pickup(NEW.reservation_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_route_stops_sync_pickup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_stops_sync_pickup ON public.route_stops;
CREATE TRIGGER tr_route_stops_sync_pickup
  AFTER INSERT OR UPDATE OF estimated_arrival_at, route_assignment_id, reservation_id OR DELETE
  ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.tg_route_stops_sync_pickup();

-- ---------------------------------------------------------------------------
-- 1c. Trigger en route_assignments: publicar/despublicar, mover la salida,
--     cambiar o quitar el conductor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_route_assignments_sync_pickup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res uuid;
BEGIN
  FOR v_res IN
    SELECT DISTINCT rs.reservation_id FROM public.route_stops rs
     WHERE rs.route_assignment_id = NEW.id
  LOOP
    PERFORM public.sync_calculated_pickup(v_res);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_route_assignments_sync_pickup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_assignments_sync_pickup ON public.route_assignments;
CREATE TRIGGER tr_route_assignments_sync_pickup
  AFTER UPDATE OF status, planned_start_at, driver_profile_id
  ON public.route_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_route_assignments_sync_pickup();
-- (Borrar una ruta borra sus paradas en cascada, y eso ya lo atrapa el trigger
--  de route_stops.)

-- ---------------------------------------------------------------------------
-- 1d. Relleno: lo ya publicado antes de esta migración
-- ---------------------------------------------------------------------------
-- RELLENO:INICIO (el bloque lo reusa _verify-0085.mjs tal cual)
DO $$
DECLARE
  v_res uuid;
  n int := 0;
BEGIN
  FOR v_res IN
    SELECT DISTINCT rs.reservation_id
      FROM public.route_stops rs
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
     WHERE ra.status <> 'cancelled'
       AND ra.driver_profile_id IS NOT NULL
  LOOP
    PERFORM public.sync_calculated_pickup(v_res);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0085: hora de recogida recalculada para % reservas con ruta publicada', n;
END $$;
-- RELLENO:FIN

-- ---------------------------------------------------------------------------
-- 2. El tripulante ya no hace UPDATE directo a su reserva
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS p_reservations_update_aux ON public.reservations;

COMMIT;
