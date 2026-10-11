-- =============================================================================
-- 0097 · Avisos del traslado desde el servidor + código de encuentro de 2 dígitos
-- =============================================================================
-- Pedido del 11-oct-2026 (arranque con tripulantes reales):
--   «cuando lo van a recoger, pum notificación push de que el conductor está
--    cerca, ya sea por ubicación o por hora» · «un código de dos dígitos para
--    gestionar rápido la llegada y asegurar que recogemos a la persona que es».
--
-- POR QUÉ DESDE EL SERVIDOR. Hasta hoy los avisos al tripulante («Eres el
-- siguiente», «Por llegar», «¡Llegó!», «No pudimos recogerte») salían del
-- CELULAR del conductor (notify() → send-push): sin reintento, y el de «por
-- llegar» dependía de que la pantalla de ruta estuviera abierta con GPS. Si el
-- conductor navegaba con Waze, el tripulante no se enteraba de nada. Y no había
-- NINGÚN aviso por hora ni NINGUNO en llegadas (aeropuerto → casa).
--
-- Ahora todo pasa por la bandeja de 0063 (notification_outbox) y lo despacha
-- dispatch-notifications (0066), que reintenta y deja el error escrito:
--   1. Trigger sobre el estado de la reserva (lo escribe el conductor con
--      driver_set_reservation_status): en camino · llegó · no se presentó.
--   2. RPC nuevas del conductor: abordar CON CÓDIGO, llegué al aeropuerto
--      (llegadas), no llegó en el aeropuerto, estoy cerca (GPS del teléfono).
--   3. Detector cada minuto: recordatorio 10 min antes de la recogida
--      publicada, «por llegar» con el último GPS del carro (aunque la app del
--      conductor esté atrás), y recordatorio al conductor 20 min antes de su
--      vuelta.
-- Cada aviso lleva una dedupe_key y NUNCA se repite (aunque el conductor toque
-- dos veces o vuelva a «Iniciar ruta»): ver trip_notify().
--
-- CÓDIGO DE ENCUENTRO: pasa de 4 a 2 dígitos (se dice en la acera en un
-- segundo). El conductor lo ESCRIBE para marcar «a bordo» y la base lo valida;
-- si el tripulante no lo tiene, «Sin código» queda registrado. Los de 4 dígitos
-- que ya existan siguen siendo válidos.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Código de 2 dígitos
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meet_code_format;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_meet_code_format
  CHECK (meet_code IS NULL OR meet_code ~ '^[0-9]{2}([0-9]{2})?$');

-- Cómo se confirmó que subió la persona correcta: con el código o sin él.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS boarding_check      text,
  ADD COLUMN IF NOT EXISTS boarding_checked_at timestamptz;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_boarding_check_valid;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_boarding_check_valid
  CHECK (boarding_check IS NULL OR boarding_check IN ('codigo', 'sin_codigo'));
COMMENT ON COLUMN public.reservations.boarding_check IS
  '0097: ''codigo'' = el conductor escribió el código de encuentro y coincidió; ''sin_codigo'' = lo subió sin código (queda registrado).';

CREATE OR REPLACE FUNCTION public.reservation_trip_extras()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ap public.auxiliar_profiles%ROWTYPE;
BEGIN
  -- El código lo pone la base (0086). Desde 0097 es de 2 dígitos. Un admin (o
  -- un script) que ya trae uno válido lo conserva; un tripulante no elige el suyo.
  IF NEW.meet_code IS NULL OR public.current_user_role() = 'auxiliar' THEN
    NEW.meet_code := lpad(floor(random() * 100)::int::text, 2, '0');
  END IF;

  NEW.meeting_point := nullif(btrim(coalesce(NEW.meeting_point, '')), '');
  IF NEW.meeting_point IS NULL AND NEW.residence_id IS NOT NULL THEN
    SELECT * INTO ap FROM public.auxiliar_profiles WHERE id = NEW.auxiliar_profile_id;
    IF FOUND AND ap.residence_id IS NOT NULL AND NEW.residence_id = ap.residence_id THEN
      NEW.meeting_point := nullif(btrim(coalesce(ap.meeting_point, '')), '');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reservation_trip_extras() FROM PUBLIC, anon, authenticated;

-- Relleno: los viajes que todavía no arrancan (más de 3 h) pasan a 2 dígitos.
-- Los que están por salir conservan el suyo: el tripulante ya lo pudo ver.
-- RELLENO:INICIO
UPDATE public.reservations
   SET meet_code = lpad(floor(random() * 100)::int::text, 2, '0')
 WHERE cancelled_at IS NULL
   AND required_arrival_at > now() + interval '3 hours'
   AND (meet_code IS NULL OR length(meet_code) = 4);
-- RELLENO:FIN

-- ---------------------------------------------------------------------------
-- 2. Ayudantes
-- ---------------------------------------------------------------------------
-- La dedupe de 0063 solo vale mientras el aviso está PENDIENTE (índice parcial):
-- una vez enviado, la misma clave podría volver a entrar. Para los avisos del
-- traslado eso sería un push repetido cada minuto, así que trip_notify mira la
-- bandeja entera. Este índice lo hace barato.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_dedupe_all
  ON public.notification_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Hora de Bogotá en el estilo de la app: «4:31 a. m.».
CREATE OR REPLACE FUNCTION public.trip_hora(p_ts timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_ts IS NULL THEN NULL ELSE
    replace(replace(to_char(p_ts AT TIME ZONE 'America/Bogota', 'FMHH12:MI AM'), 'AM', 'a. m.'), 'PM', 'p. m.')
  END;
$$;

-- Encola un aviso UNA sola vez por clave (mire o no si ya salió). Devuelve true
-- si lo encoló. Sin destinatario o sin texto no hace nada.
CREATE OR REPLACE FUNCTION public.trip_notify(
  p_profile uuid, p_title text, p_body text, p_url text, p_key text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_profile IS NULL OR coalesce(btrim(p_title), '') = '' OR coalesce(btrim(p_body), '') = '' THEN
    RETURN false;
  END IF;
  IF p_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.notification_outbox WHERE dedupe_key = p_key) THEN
    RETURN false;
  END IF;
  INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
  VALUES (p_profile, p_title, left(p_body, 300), coalesce(p_url, '/'), p_key)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.trip_notify(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- Dispara el despacho YA (no espera al cron del minuto). Nunca tumba a quien
-- lo llama: si no hay Vault o pg_net, el cron del minuto lo recoge.
CREATE OR REPLACE FUNCTION public.trip_kick()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM public.drain_notification_outbox();
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'trip_kick: el despacho inmediato no salió (%); lo recoge el cron', SQLERRM;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.trip_kick() FROM PUBLIC, anon, authenticated;

-- Todo lo que un aviso necesita decir de UN traslado: a quién, quién lo lleva,
-- en qué carro, el código, el punto de encuentro, la espera pactada y la hora.
-- Toma la ruta ACTIVA (planned / in_progress) en la que está la reserva.
CREATE OR REPLACE FUNCTION public.trip_ctx(p_reservation_id uuid)
RETURNS TABLE (
  crew_profile   uuid,
  crew_first     text,
  driver_profile uuid,
  driver_first   text,
  vehicle_txt    text,
  meet_code      text,
  meeting_point  text,
  wait_min       int,
  pickup_at      timestamptz,
  direction      public.trip_direction,
  ra_id          uuid,
  stop_status    text,
  url            text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ap.profile_id,
         nullif(split_part(btrim(coalesce(cp.full_name, '')), ' ', 1), ''),
         dp.profile_id,
         coalesce(nullif(split_part(btrim(coalesce(dpp.full_name, '')), ' ', 1), ''), 'Tu conductor'),
         nullif(concat_ws(' · ', nullif(v.internal_code, ''), nullif(v.license_plate, '')), ''),
         r.meet_code,
         r.meeting_point,
         coalesce((SELECT s.aux_wait_minutes FROM public.app_settings s LIMIT 1), 5),
         r.calculated_pickup_at,
         r.direction,
         ra.id,
         rs.status,
         '/#/viaje?r=' || r.id::text
  FROM public.reservations r
  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  LEFT JOIN public.profiles cp      ON cp.id = ap.profile_id
  LEFT JOIN LATERAL (
    SELECT rs0.* FROM public.route_stops rs0
    JOIN public.route_assignments ra0 ON ra0.id = rs0.route_assignment_id
    WHERE rs0.reservation_id = r.id AND ra0.status IN ('planned', 'in_progress')
    ORDER BY ra0.planned_start_at DESC NULLS LAST
    LIMIT 1
  ) rs ON true
  LEFT JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  LEFT JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
  LEFT JOIN public.profiles dpp         ON dpp.id = dp.profile_id
  LEFT JOIN public.vehicles v           ON v.id = ra.vehicle_id
  WHERE r.id = p_reservation_id;
$$;
REVOKE ALL ON FUNCTION public.trip_ctx(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Avisos por cambio de estado (salidas: casa → MDE)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trip_status_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
  v_code text;
  v_meet text;
  v_sent boolean := false;
BEGIN
  IF NEW.cancelled_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO c FROM public.trip_ctx(NEW.id) LIMIT 1;
  IF c.crew_profile IS NULL THEN RETURN NEW; END IF;
  v_code := CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END;
  v_meet := CASE WHEN c.meeting_point IS NOT NULL THEN ' (' || c.meeting_point || ')' ELSE '' END;

  IF NEW.status_h2a IS DISTINCT FROM OLD.status_h2a THEN
    IF NEW.status_h2a = 'en_route' THEN
      v_sent := public.trip_notify(c.crew_profile, 'Eres el siguiente 🔜',
        c.driver_first || ' va hacia ti para recogerte' || coalesce(' en el carro ' || c.vehicle_txt, '') || '.' ||
        CASE WHEN c.meet_code IS NOT NULL THEN ' Ten listo tu código: ' || c.meet_code || '.' ELSE '' END,
        c.url, 'trip:' || NEW.id || ':en_route');
    ELSIF NEW.status_h2a = 'at_pickup' THEN
      v_sent := public.trip_notify(c.crew_profile, '¡Tu conductor llegó! 📍',
        c.driver_first || ' está en el punto de recogida' || v_meet || '. Te espera ' || c.wait_min || ' min.' || v_code,
        c.url, 'trip:' || NEW.id || ':at_pickup');
    ELSIF NEW.status_h2a = 'no_show' THEN
      v_sent := public.trip_notify(c.crew_profile, 'No pudimos recogerte',
        c.driver_first || ' esperó ' || c.wait_min || ' min en el punto y siguió su ruta. Si fue un error, escribe a Coordinación.',
        c.url, 'trip:' || NEW.id || ':no_show');
    END IF;
  END IF;

  IF v_sent THEN PERFORM public.trip_kick(); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trip_status_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_reservations_trip_status_notify ON public.reservations;
CREATE TRIGGER tr_reservations_trip_status_notify
  AFTER UPDATE OF status_h2a ON public.reservations
  FOR EACH ROW
  WHEN (OLD.status_h2a IS DISTINCT FROM NEW.status_h2a)
  EXECUTE FUNCTION public.trip_status_notify();

-- ---------------------------------------------------------------------------
-- 4. RPC del conductor
-- ---------------------------------------------------------------------------
-- Valida que la reserva esté en una ruta ACTIVA de quien llama. Devuelve la
-- ruta y la dirección (o revienta con un mensaje legible).
CREATE OR REPLACE FUNCTION public._driver_trip_guard(p_reservation_id uuid)
RETURNS TABLE (ra_id uuid, direction public.trip_direction, meet_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver uuid := public.current_driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'solo un conductor puede marcar una parada';
  END IF;
  RETURN QUERY
    SELECT ra.id, r.direction, r.meet_code
    FROM public.reservations r
    JOIN public.route_stops rs       ON rs.reservation_id = r.id
    JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE r.id = p_reservation_id
      AND ra.driver_profile_id = v_driver
      AND ra.status IN ('planned', 'in_progress')
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la reserva % no está en una ruta activa asignada a este conductor', p_reservation_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._driver_trip_guard(uuid) FROM PUBLIC, anon, authenticated;

-- Abordar CON el código que dice el tripulante en la acera (o en el aeropuerto).
-- p_sin_codigo = true: el tripulante no lo tiene; sube igual y queda registrado.
CREATE OR REPLACE FUNCTION public.driver_board_with_code(
  p_reservation_id uuid,
  p_code           text,
  p_sin_codigo     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g record;
  v_code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
BEGIN
  SELECT * INTO g FROM public._driver_trip_guard(p_reservation_id) LIMIT 1;

  IF NOT coalesce(p_sin_codigo, false) THEN
    IF v_code = '' THEN
      RAISE EXCEPTION 'Escribe el código que te dice el tripulante' USING ERRCODE = 'P0001', HINT = 'codigo_vacio';
    END IF;
    IF g.meet_code IS NOT NULL AND v_code <> g.meet_code THEN
      RAISE EXCEPTION 'El código no coincide' USING ERRCODE = 'P0001', HINT = 'codigo_incorrecto';
    END IF;
  END IF;

  UPDATE public.reservations
     SET boarding_check = CASE WHEN coalesce(p_sin_codigo, false) THEN 'sin_codigo' ELSE 'codigo' END,
         boarding_checked_at = now()
   WHERE id = p_reservation_id;

  PERFORM public.driver_set_reservation_status(
    p_reservation_id,
    CASE WHEN g.direction = 'home_to_airport' THEN 'on_board' ELSE 'picked_up' END);

  RETURN jsonb_build_object('ok', true, 'verificado', NOT coalesce(p_sin_codigo, false));
END;
$$;
REVOKE ALL ON FUNCTION public.driver_board_with_code(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_board_with_code(uuid, text, boolean) TO authenticated;

-- Llegadas (MDE → casa): «Llegué al aeropuerto». Marca la llegada en todas las
-- paradas pendientes de la vuelta (el tripulante ve «Te espera en MDE» y su
-- código) y le avisa a cada uno. Deja el ancla del carro en el aeropuerto.
CREATE OR REPLACE FUNCTION public.driver_mark_airport_arrival(p_route_assignment_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver uuid := public.current_driver_id();
  v_dir    public.trip_direction;
  v_n      integer := 0;
  v_lat    double precision;
  v_lng    double precision;
  rec      record;
  c        record;
  v_sent   boolean := false;
BEGIN
  IF v_driver IS NULL THEN RAISE EXCEPTION 'solo un conductor puede marcar la llegada'; END IF;
  SELECT ra.direction INTO v_dir FROM public.route_assignments ra
   WHERE ra.id = p_route_assignment_id AND ra.driver_profile_id = v_driver
     AND ra.status IN ('planned', 'in_progress');
  IF v_dir IS NULL THEN RAISE EXCEPTION 'esa vuelta no es una ruta activa de este conductor'; END IF;
  IF v_dir <> 'airport_to_home' THEN RAISE EXCEPTION 'solo las llegadas recogen en el aeropuerto'; END IF;

  FOR rec IN
    UPDATE public.route_stops rs
       SET status = 'arrived', actual_arrival_at = coalesce(rs.actual_arrival_at, now())
     WHERE rs.route_assignment_id = p_route_assignment_id AND rs.status = 'pending'
     RETURNING rs.reservation_id
  LOOP
    v_n := v_n + 1;
    SELECT * INTO c FROM public.trip_ctx(rec.reservation_id) LIMIT 1;
    IF c.crew_profile IS NOT NULL THEN
      v_sent := public.trip_notify(c.crew_profile, '¡Tu conductor llegó al aeropuerto! ✈️',
        c.driver_first || ' te espera' || coalesce(' en ' || c.meeting_point, ' a la salida de pasajeros') ||
        coalesce(' · carro ' || c.vehicle_txt, '') || '.' ||
        CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
        c.url, 'trip:' || rec.reservation_id || ':apt_arrived') OR v_sent;
    END IF;
  END LOOP;

  -- Ancla en el aeropuerto de la organización del conductor.
  SELECT ap.latitude, ap.longitude INTO v_lat, v_lng
    FROM public.airports ap
    JOIN public.profiles pr        ON pr.organization_id = ap.organization_id
    JOIN public.driver_profiles dp ON dp.profile_id = pr.id
   WHERE dp.id = v_driver LIMIT 1;
  IF v_lat IS NOT NULL THEN
    INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
    VALUES (v_driver, p_route_assignment_id, v_lat, v_lng, 'anchor', now());
  END IF;

  IF v_sent THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_mark_airport_arrival(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_mark_airport_arrival(uuid) TO authenticated;

-- Llegadas: el tripulante no apareció en el aeropuerto. La reserva de llegada no
-- tiene estado «no se presentó» (reservation_status_a2h), así que se marca la
-- parada y se le avisa para que pida otro traslado.
CREATE OR REPLACE FUNCTION public.driver_airport_no_show(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g record;
  c record;
BEGIN
  SELECT * INTO g FROM public._driver_trip_guard(p_reservation_id) LIMIT 1;
  IF g.direction <> 'airport_to_home' THEN
    RAISE EXCEPTION 'en una salida se usa «No se presentó» del punto de recogida';
  END IF;
  UPDATE public.route_stops
     SET status = 'no_show', actual_arrival_at = coalesce(actual_arrival_at, now())
   WHERE reservation_id = p_reservation_id AND route_assignment_id = g.ra_id;
  SELECT * INTO c FROM public.trip_ctx(p_reservation_id) LIMIT 1;
  IF public.trip_notify(c.crew_profile, 'No te encontramos en el aeropuerto',
       c.driver_first || ' salió del aeropuerto sin ti. Escribe a Coordinación para que te ayuden con otro traslado.',
       c.url, 'trip:' || p_reservation_id || ':apt_no_show') THEN
    PERFORM public.trip_kick();
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_airport_no_show(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_airport_no_show(uuid) TO authenticated;

-- «Estoy cerca»: lo llama el teléfono del conductor cuando su GPS queda a menos
-- de 300 m de la recogida. El detector del minuto hace lo mismo con el último
-- GPS guardado, por si la app del conductor está en segundo plano.
CREATE OR REPLACE FUNCTION public.trip_near_notify(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.trip_ctx(p_reservation_id) LIMIT 1;
  IF c.crew_profile IS NULL OR c.direction <> 'home_to_airport' OR c.stop_status <> 'pending' THEN RETURN false; END IF;
  RETURN public.trip_notify(c.crew_profile, 'Tu conductor está por llegar 📍',
    c.driver_first || ' está muy cerca de tu punto de recogida.' ||
    CASE WHEN c.meet_code IS NOT NULL THEN ' Sal con tu código: ' || c.meet_code || '.' ELSE '' END,
    c.url, 'trip:' || p_reservation_id || ':near');
END;
$$;
REVOKE ALL ON FUNCTION public.trip_near_notify(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.driver_near_stop(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g record;
  v_ok boolean;
BEGIN
  SELECT * INTO g FROM public._driver_trip_guard(p_reservation_id) LIMIT 1;
  v_ok := public.trip_near_notify(p_reservation_id);
  IF v_ok THEN PERFORM public.trip_kick(); END IF;
  RETURN v_ok;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_near_stop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_near_stop(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Detector del minuto
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_trip_reminders()
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec record;
  c   record;
  v_rem int := 0;
  v_near int := 0;
  v_drv int := 0;
BEGIN
  -- (a) Recordatorio al tripulante 10 min antes de su recogida PUBLICADA.
  --     Salida: aún no arranca la recogida (si ya va «en camino», ese aviso ya
  --     salió). Llegada: aún no está a bordo.
  FOR rec IN
    SELECT r.id, r.direction, r.calculated_pickup_at
      FROM public.reservations r
      JOIN public.route_stops rs       ON rs.reservation_id = r.id
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
     WHERE ra.status IN ('planned', 'in_progress')
       AND r.cancelled_at IS NULL
       AND rs.status = 'pending'
       AND r.calculated_pickup_at IS NOT NULL
       AND r.calculated_pickup_at <= now() + interval '10 minutes'
       AND r.calculated_pickup_at >  now() - interval '2 minutes'
       AND ((r.direction = 'home_to_airport' AND coalesce(r.status_h2a::text, 'requested') IN ('requested', 'assigned', 'ready'))
         OR (r.direction = 'airport_to_home' AND coalesce(r.status_a2h::text, 'scheduled') IN ('scheduled', 'in_air', 'landed', 'disembarking', 'driver_assigned')))
  LOOP
    SELECT * INTO c FROM public.trip_ctx(rec.id) LIMIT 1;
    IF c.crew_profile IS NULL THEN CONTINUE; END IF;
    IF rec.direction = 'home_to_airport' THEN
      IF public.trip_notify(c.crew_profile, 'Te recogen a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ⏰',
           c.driver_first || coalesce(' (' || c.vehicle_txt || ')', '') || ' te recoge en unos 10 min' ||
           coalesce(' en ' || c.meeting_point, '') || '.' ||
           CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
           c.url, 'trip:' || rec.id || ':remind:' || extract(epoch FROM rec.calculated_pickup_at)::bigint) THEN
        v_rem := v_rem + 1;
      END IF;
    ELSE
      IF public.trip_notify(c.crew_profile, 'Tu conductor sale de MDE a las ' || public.trip_hora(rec.calculated_pickup_at) || ' ✈️',
           'Al salir del avión busca a ' || c.driver_first || coalesce(' (' || c.vehicle_txt || ')', '') ||
           coalesce(' en ' || c.meeting_point, '') || '.' ||
           CASE WHEN c.meet_code IS NOT NULL THEN ' Tu código es ' || c.meet_code || '.' ELSE '' END,
           c.url, 'trip:' || rec.id || ':remind:' || extract(epoch FROM rec.calculated_pickup_at)::bigint) THEN
        v_rem := v_rem + 1;
      END IF;
    END IF;
  END LOOP;

  -- (b) «Por llegar» con el último GPS del carro (menos de 2 min de viejo).
  FOR rec IN
    SELECT r.id
      FROM public.reservations r
      JOIN public.route_stops rs       ON rs.reservation_id = r.id AND rs.status = 'pending'
      JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id AND ra.status IN ('planned', 'in_progress')
      JOIN LATERAL (
        SELECT dl.latitude, dl.longitude FROM public.driver_locations dl
         WHERE dl.driver_profile_id = ra.driver_profile_id AND dl.source = 'gps'
           AND dl.recorded_at > now() - interval '2 minutes'
         ORDER BY dl.recorded_at DESC LIMIT 1
      ) pos ON true
     WHERE r.direction = 'home_to_airport'
       AND r.status_h2a = 'en_route'
       AND r.cancelled_at IS NULL
       AND r.pickup_latitude IS NOT NULL
       AND 2 * 6371000 * asin(sqrt(
             power(sin(radians(pos.latitude - r.pickup_latitude) / 2), 2) +
             cos(radians(r.pickup_latitude)) * cos(radians(pos.latitude)) *
             power(sin(radians(pos.longitude - r.pickup_longitude) / 2), 2))) < 400
  LOOP
    IF public.trip_near_notify(rec.id) THEN v_near := v_near + 1; END IF;
  END LOOP;

  -- (c) Al conductor, 20 min antes de una vuelta que nadie ha arrancado.
  FOR rec IN
    SELECT ra.id, ra.planned_start_at, dp.profile_id,
           count(*) AS n,
           string_agg(split_part(btrim(coalesce(cp.full_name, '')), ' ', 1), ', ' ORDER BY rs.stop_order) AS nombres
      FROM public.route_assignments ra
      JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
      JOIN public.route_stops rs       ON rs.route_assignment_id = ra.id
      JOIN public.reservations r       ON r.id = rs.reservation_id AND r.cancelled_at IS NULL
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      LEFT JOIN public.profiles cp     ON cp.id = ap.profile_id
     WHERE ra.status = 'planned'
       AND ra.planned_start_at <= now() + interval '20 minutes'
       AND ra.planned_start_at >  now() - interval '5 minutes'
     GROUP BY ra.id, ra.planned_start_at, dp.profile_id
    HAVING bool_and(rs.status = 'pending')
       AND bool_and(coalesce(r.status_h2a::text, 'requested') IN ('requested', 'assigned', 'ready'))
  LOOP
    IF public.trip_notify(rec.profile_id, 'Tu vuelta arranca a las ' || public.trip_hora(rec.planned_start_at),
         rec.n || CASE WHEN rec.n = 1 THEN ' tripulante' ELSE ' tripulantes' END || ': ' || coalesce(nullif(rec.nombres, ''), '—') ||
         '. Abre Rendio y toca «Iniciar ruta».',
         '/', 'drv:' || rec.id || ':start:' || extract(epoch FROM rec.planned_start_at)::bigint) THEN
      v_drv := v_drv + 1;
    END IF;
  END LOOP;

  IF v_rem + v_near + v_drv > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN format('recordatorios %s · por llegar %s · conductores %s', v_rem, v_near, v_drv);
END;
$$;
REVOKE ALL ON FUNCTION public.detect_trip_reminders() FROM PUBLIC, anon, authenticated;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'detect-trip-reminders';
  PERFORM cron.schedule('detect-trip-reminders', '* * * * *',
    $job$SELECT public.detect_trip_reminders();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): detect_trip_reminders queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
