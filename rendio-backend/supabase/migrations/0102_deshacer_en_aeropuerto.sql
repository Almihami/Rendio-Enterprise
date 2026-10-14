-- =============================================================================
-- 0102 · «Deshacer» en la lista del aeropuerto (ruta del conductor v2, 12-oct-2026)
-- =============================================================================
-- En una LLEGADA (MDE → casa) el conductor resuelve a cada tripulante en la acera
-- del aeropuerto: le escribe su código (queda a bordo), lo sube «sin código» o lo
-- marca «No llegó». La entrega del diseñador del 12-oct pone un «Deshacer» en cada
-- fila resuelta: un toque equivocado en la acera no puede dejar a alguien por fuera
-- ni subir a quien no es.
--
-- driver_airport_undo(reserva) devuelve la parada a «llegó» (pendiente de resolver)
-- mientras el carro siga en el aeropuerto. Reglas:
--   · Solo el conductor de esa vuelta activa (mismo guardián de 0097).
--   · Solo llegadas (en una salida no hay lista del aeropuerto).
--   · Solo si la parada está «a bordo» o «no llegó». Si el carro ya salió hacia las
--     casas (la reserva va en camino a casa o entregada), no se deshace.
--   · A bordo → se borra la marca de abordaje (código / sin código) y la hora de
--     recogida; la reserva vuelve a «conductor asignado».
--   · «No llegó» → al tripulante ya le llegó «No te encontramos en el aeropuerto»:
--     se le avisa UNA vez que el conductor sigue esperándolo (dedupe propio).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_airport_undo(p_reservation_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g        record;
  c        record;
  v_stop   text;
  v_a2h    text;
BEGIN
  SELECT * INTO g FROM public._driver_trip_guard(p_reservation_id) LIMIT 1;
  IF g.direction <> 'airport_to_home' THEN
    RAISE EXCEPTION 'solo en una llegada se deshace en el aeropuerto';
  END IF;

  SELECT rs.status INTO v_stop
    FROM public.route_stops rs
   WHERE rs.reservation_id = p_reservation_id AND rs.route_assignment_id = g.ra_id;
  SELECT r.status_a2h::text INTO v_a2h FROM public.reservations r WHERE r.id = p_reservation_id;

  IF v_stop NOT IN ('picked_up', 'no_show') THEN
    RAISE EXCEPTION 'esa parada no está resuelta: no hay nada que deshacer' USING HINT = 'nada_que_deshacer';
  END IF;
  IF v_a2h IN ('en_route_home', 'delivered') THEN
    RAISE EXCEPTION 'el carro ya salió del aeropuerto: ya no se puede deshacer' USING HINT = 'ya_salio';
  END IF;

  UPDATE public.route_stops
     SET status = 'arrived', actual_pickup_at = NULL
   WHERE reservation_id = p_reservation_id AND route_assignment_id = g.ra_id;

  IF v_stop = 'picked_up' THEN
    UPDATE public.reservations
       SET status_a2h = 'driver_assigned', boarding_check = NULL, boarding_checked_at = NULL, updated_at = now()
     WHERE id = p_reservation_id;
  ELSE
    SELECT * INTO c FROM public.trip_ctx(p_reservation_id) LIMIT 1;
    IF c.crew_profile IS NOT NULL AND public.trip_notify(c.crew_profile, 'Tu conductor todavía te espera ✈️',
         c.driver_first || ' sigue en el aeropuerto' || coalesce(' (' || c.meeting_point || ')', '') ||
         '. Si ya estás afuera, búscalo.' ||
         CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
         c.url, 'trip:' || p_reservation_id || ':apt_undo') THEN
      PERFORM public.trip_kick();
    END IF;
  END IF;

  RETURN v_stop;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_airport_undo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_airport_undo(uuid) TO authenticated;

COMMENT ON FUNCTION public.driver_airport_undo(uuid)
  IS '0102 · Llegadas: el conductor deshace «a bordo» o «no llegó» de un tripulante mientras sigue en el aeropuerto. Devuelve el estado que deshizo.';

COMMIT;
