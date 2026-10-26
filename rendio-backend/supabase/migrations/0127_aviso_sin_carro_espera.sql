-- =============================================================================
-- Migration 0127 — «X no tiene carro» ya no suena mientras el jefe re-publica
--
-- QUÉ PASÓ (producción, lunes 26-oct-2026, 9:00:00 a. m.): Christian volvió a
-- publicar el día desde Asignación. Publicar (saveRoutePlan, en el navegador)
-- BORRA las vueltas del día que no han arrancado y las vuelve a crear una por
-- una: 37 vueltas entre 9:00:00 y 9:00:17. En ese mismo segundo corrió el reloj
-- de 5 min (detect-ops-events → detect_late_bookings), vio el día con plan (las
-- vueltas en curso y las primeras ya creadas) y 59 reservas todavía sin parada:
-- 59 eventualidades «no tiene carro» y 177 push (59 a cada jefe). 17 segundos
-- después todas tenían vuelta y se cerraron solas, pero los avisos ya habían
-- salido. Re-publicar un día en curso lo van a seguir haciendo, así que el
-- detector no puede sonar en ese hueco.
--
-- EL ARREGLO: solo avisa si la reserva lleva 5 minutos SEGUIDOS sin vuelta
-- (dos pasadas del reloj) y nadie está publicando ese día en ese momento.
--   1. Cada pasada anota quién está sin carro (late_booking_candidates) y
--      olvida a quien ya no lo está (tiene vuelta, se canceló, ya pasó la hora
--      o su día quedó sin plan).
--   2. Solo avisa por una reserva anotada hace 4 min o más: la pasada anterior
--      (cada 5 min) ya la vio sin vuelta y esta también.
--   3. «Seguidos»: en cuanto la reserva entra a una vuelta, un disparador borra
--      su anotación al instante (no hay que esperar a la pasada siguiente). Así,
--      si una pasada la vio sin vuelta en medio de una publicación y la
--      siguiente cae en medio de OTRA publicación, la cuenta empieza de cero.
--   4. Y no avisa si se creó una vuelta de ESE día hace menos de 2 min: el jefe
--      está publicando (cubre una publicación lenta, de más de 4 min). En
--      cuanto termina, la pasada siguiente decide.
--
-- EL COSTO: el aviso de una reserva que de verdad quedó por fuera llega una
-- pasada más tarde (entre 5 y 10 min después de que quedó sin carro, en vez de
-- entre 0 y 5). Para lo que vigila —el pedido de las 11 p. m. para un vuelo de
-- las 5 a. m.— no cambia nada.
--
-- POR QUÉ ESTE Y NO OTRO:
--   · Hacer la publicación atómica (una RPC) es el arreglo de fondo, pero es
--     reescribir saveRoutePlan (candados por parada, rutas en curso, carro,
--     horas, a quién avisar) en SQL, cambiar la app y subir el service worker,
--     en la pantalla que los jefes usan todos los días. Y no cubre los demás
--     cambios que borran y crean desde el navegador.
--   · Mirar solo «se tocó el plan hace poco» (punto 4) no alcanza solo: el
--     borrado no deja huella en route_assignments, así que en el instante entre
--     borrar y crear la primera vuelta no se ve nada reciente.
--   · Todo es del servidor: no toca la app, ni cómo se publica, ni el texto del
--     aviso, ni cuándo se cierra sola. El disparador de route_stops solo borra
--     anotaciones y, si fallara, no frena la publicación (se traga el error).
--
-- 0125 y 0126 (la ruta de Julián y la vuelta delegada) también copian esta
-- función para contar «publicada sin conductor». Esta versión ya las cuenta,
-- y se puede aplicar con o sin ellas: lee pool / delegated_at con to_jsonb, que
-- da NULL si la columna todavía no existe. OJO: si 0125 o 0126 se aplican
-- DESPUÉS de 0127, su copia pisa este arreglo (sus aplicadores lo detectan:
-- la huella de detect_late_bookings ya no es la esperada). Orden correcto:
-- 0125 → 0126 → 0127, o volver a correr 0127 después de ellas.
--
-- El reloj no cambia: sigue siendo detect-ops-events cada 5 min (0066/0068).
-- Al aplicar, de las tablas de la operación solo toca route_stops (para poner el
-- disparador), con un candado que no frena lecturas; reservations, ni la toca.
-- Idempotente. Down: down_migrations/0127_aviso_sin_carro_espera.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La anotación: quién estaba sin carro y desde qué pasada
-- -----------------------------------------------------------------------------
-- created_at = la primera pasada que la vio sin carro (la fila no se actualiza:
-- si sigue sin carro se deja como está; si deja de estarlo, se borra).
-- Sin FK a reservations, a propósito: crearla (o quitarla en la reversa) bloquea
-- reservations mientras se aplica, y con el reloj y la app leyendo eso puede
-- trabarse con ellos. Si se borra una reserva, su anotación se va sola en la
-- pasada siguiente (ya no está entre las que no tienen carro).
CREATE TABLE IF NOT EXISTS public.late_booking_candidates (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT late_booking_candidates_reservation_key UNIQUE (reservation_id)
);
DROP TRIGGER IF EXISTS tr_late_booking_candidates_set_updated_at ON public.late_booking_candidates;
CREATE TRIGGER tr_late_booking_candidates_set_updated_at BEFORE UPDATE ON public.late_booking_candidates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Solo la tocan detect_late_bookings y el disparador de abajo (SECURITY DEFINER).
ALTER TABLE public.late_booking_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.late_booking_candidates FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.late_booking_candidates IS
  '0127: reservas que el detector vio sin vuelta en un día con plan publicado; created_at = la primera pasada que la vio así. Solo se avisa cuando la pasada siguiente la sigue viendo sin vuelta (no suena mientras el jefe re-publica). Se borra en cuanto la reserva entra a una vuelta (disparador en route_stops), se cancela, ya pasó o su día queda sin plan.';

-- -----------------------------------------------------------------------------
-- 2. Entra a una vuelta → la cuenta vuelve a cero
-- -----------------------------------------------------------------------------
-- Una sola sentencia por inserción (Asignación manda las paradas de una vuelta
-- juntas). Nunca debe frenar una publicación: si algo falla, solo avisa en el log
-- y la anotación se borra igual en la pasada siguiente.
CREATE OR REPLACE FUNCTION public.late_booking_candidates_reset()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    DELETE FROM public.late_booking_candidates lb
     USING nuevas n
     WHERE lb.reservation_id = n.reservation_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'late_booking_candidates_reset: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.late_booking_candidates_reset() FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE TRIGGER (no DROP + CREATE): toma un candado de route_stops
-- que NO frena a quien la está leyendo (DROP TRIGGER sí); las escrituras esperan
-- milisegundos.
CREATE OR REPLACE TRIGGER tr_route_stops_late_booking_reset
  AFTER INSERT ON public.route_stops
  REFERENCING NEW TABLE AS nuevas
  FOR EACH STATEMENT EXECUTE FUNCTION public.late_booking_candidates_reset();

-- -----------------------------------------------------------------------------
-- 3. El detector
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_late_bookings()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- La pasada siguiente del reloj (cada 5 min); 4 para que unos segundos de
  -- atraso del reloj no la hagan esperar una pasada más.
  c_espera constant interval := interval '4 minutes';
  -- Una vuelta de ese día creada hace menos de esto = el jefe está publicando.
  c_calma  constant interval := interval '2 minutes';
  v_sin_carro uuid[];
  v_nuevas integer := 0;
  r        record;
  v_id     uuid;
BEGIN
  -- (a) QUIÉN ESTÁ SIN CARRO EN ESTA PASADA: reserva viva, de un día que YA
  -- tiene plan publicado, sin parada.
  --
  -- «Día con plan publicado» = existe al menos una route_assignment de ese día,
  -- planned o in_progress, con conductor, o pegada por el jefe (pool, 0125), o
  -- delegada (delegated_at, 0126). Un borrador no cuenta: mientras el jefe está
  -- armando el día, que falte gente es lo normal y avisar ahí sería ruido puro.
  -- pool y delegated_at se leen con to_jsonb: en una base sin 0125/0126 dan NULL.
  v_sin_carro := ARRAY(
    SELECT res.id
    FROM public.reservations res
    WHERE res.cancelled_at IS NULL
      AND res.required_arrival_at > now()
      -- todavía hay tiempo de hacer algo; después ya es historia, no alerta
      AND res.required_arrival_at < now() + interval '36 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
      AND EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.status IN ('planned', 'in_progress')
          AND (ra.driver_profile_id IS NOT NULL
               OR (to_jsonb(ra) ->> 'pool')::boolean IS TRUE      -- 0125 pegada
               OR (to_jsonb(ra) ->> 'delegated_at') IS NOT NULL)  -- 0126 delegada
          AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date
              = (res.required_arrival_at AT TIME ZONE 'America/Bogota')::date));

  -- (b) LA ANOTACIÓN: se olvida a quien ya no está sin carro (lo acomodaron, lo
  -- cancelaron, pasó la hora o el día quedó sin plan) y se anota a quien
  -- aparece por primera vez. Quien ya estaba anotado conserva su hora (created_at).
  DELETE FROM public.late_booking_candidates
   WHERE NOT (reservation_id = ANY (v_sin_carro));
  INSERT INTO public.late_booking_candidates (reservation_id)
  SELECT unnest(v_sin_carro)
  ON CONFLICT (reservation_id) DO NOTHING;

  -- (c) ABRE solo lo confirmado: anotada desde la pasada anterior, sin
  -- eventualidad abierta, y sin una vuelta de ese día recién creada (el jefe
  -- está publicando: la pasada siguiente decide).
  FOR r IN
    SELECT res.id, res.required_arrival_at, res.pickup_address, res.direction,
           pr.full_name AS pax, pr.organization_id,
           EXTRACT(EPOCH FROM (res.required_arrival_at - now())) / 3600 AS horas
    FROM public.late_booking_candidates lb
    JOIN public.reservations res     ON res.id = lb.reservation_id
    JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    JOIN public.profiles pr          ON pr.id = ap.profile_id
    WHERE lb.created_at <= now() - c_espera
      AND NOT EXISTS (
        SELECT 1 FROM public.route_assignments ra
        WHERE ra.created_at > now() - c_calma
          AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date
              = (res.required_arrival_at AT TIME ZONE 'America/Bogota')::date)
      AND NOT EXISTS (
        SELECT 1 FROM public.incidents i
        WHERE i.dedupe_key = 'late:' || res.id::text AND i.resolved_at IS NULL)
  LOOP
    INSERT INTO public.incidents (
      organization_id, reporter_id, reservation_id,
      category, severity, status, description, scope, source, details,
      dedupe_key, occurred_at)
    VALUES (
      r.organization_id, NULL, r.id,
      'late_booking',
      -- Grave solo cuando ya no hay noche de por medio para resolverlo.
      -- El cast es obligatorio: un CASE devuelve text y la columna es un enum.
      (CASE WHEN r.horas < 6 THEN 'high' ELSE 'medium' END)::public.incident_severity,
      'open',
      COALESCE(split_part(r.pax, ' ', 1), 'Un tripulante') ||
        ' no tiene carro: el plan del día ya está publicado y su traslado quedó por fuera' ||
        CASE WHEN r.horas < 6
             THEN ' (faltan ' || round(r.horas::numeric, 1) || ' h).'
             ELSE '.' END,
      'operacion', 'system',
      jsonb_build_object(
        'horas_para_el_servicio', round(r.horas::numeric, 1),
        'direccion', r.pickup_address,
        'sentido', r.direction),
      'late:' || r.id::text, now())
    RETURNING id INTO v_id;

    PERFORM public.enqueue_incident_alert(v_id);
    v_nuevas := v_nuevas + 1;
  END LOOP;

  -- (d) CIERRA sola: ya la acomodaron, la cancelaron, o el servicio ya pasó.
  UPDATE public.incidents i
     SET status = 'resolved',
         resolved_at = now(),
         resolution_notes = COALESCE(i.resolution_notes,
           CASE
             WHEN res.cancelled_at IS NOT NULL THEN 'Se cerró sola: la reserva fue cancelada.'
             WHEN EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
               THEN 'Se cerró sola: la reserva ya quedó en una ruta.'
             ELSE 'Se cerró sola: la hora del servicio ya pasó.'
           END)
    FROM public.reservations res
   WHERE res.id = i.reservation_id
     AND i.category = 'late_booking'
     AND i.resolved_at IS NULL
     AND (
       res.cancelled_at IS NOT NULL
       OR res.required_arrival_at <= now()
       OR EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.reservation_id = res.id)
     );

  RETURN v_nuevas;
END;
$$;

REVOKE ALL    ON FUNCTION public.detect_late_bookings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_late_bookings() TO service_role;

COMMENT ON FUNCTION public.detect_late_bookings()
  IS 'Abre una eventualidad late_booking por cada reserva viva de un día CON PLAN PUBLICADO que lleva sin parada al menos una pasada del reloj seguida y sin que nadie esté publicando ese día (0127: anotada en late_booking_candidates; no suena mientras el jefe re-publica), y las cierra solas cuando entran a una ruta, se cancelan o ya pasó la hora. No calcula si cabe: eso lo hace el tablero.';

COMMIT;
