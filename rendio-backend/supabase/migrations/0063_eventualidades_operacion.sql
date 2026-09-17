-- 0063_eventualidades_operacion.sql
--
-- LA EVENTUALIDAD COMO OBJETO.
--
-- Hasta hoy el módulo de rutas solo sabía manejar el camino feliz: se planea el
-- día, se publica, el conductor ejecuta. Cuando la realidad se mueve —se daña el
-- carro, se atraviesa un trancón, el tripulante no baja— el sistema no se entera
-- y no avisa. Se resuelve por WhatsApp, y de madrugada no hay jefe mirando.
--
-- Esta migración NO crea una tabla nueva. `incidents` (0016) ya tiene casi todo lo
-- que hace falta —`reservation_id`, severidad, estado, evidencia, responsable— y
-- su enum de categorías ya contemplaba `traffic`, `flight_delay`, `driver_late` y
-- `vehicle_problem` desde 0001; simplemente nadie las escribía nunca. Duplicar
-- todo eso en una tabla `route_events` significaría además dos bandejas, dos
-- badges y dos criterios de "resuelto" para una operación de dos personas.
--
-- Lo que sí hace falta:
--   1. Distinguir las dos bandejas (`scope`), o el badge de Inspecciones empieza
--      a contar trancones el mismo día que esto se aplique.
--   2. Poder anclar la eventualidad a la ruta, la parada y el punto del mapa.
--   3. Que el sistema pueda reportar sin un humano detrás (`reporter_id` nullable).
--   4. Un camino de reporte que valide el vínculo, en vez de confiarle al cliente
--      de qué reserva está hablando.
--   5. Saber si alguien ya la vio (`acknowledged_at`): un push no es una alarma;
--      con no-molestar se silencia y hoy nadie se enteraría de que nadie se enteró.

-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas de `incidents`
-- -----------------------------------------------------------------------------
ALTER TABLE public.incidents
  -- 'flota'     = lo del vehículo en inicio/cierre de turno (lo que ya existía).
  -- 'operacion' = lo que pasa durante un traslado y necesita a un jefe AHORA.
  -- El default deja TODAS las filas viejas en 'flota', que es lo que son, y así
  -- la pestaña Inspecciones sigue mostrando exactamente lo mismo que hoy.
  ADD COLUMN IF NOT EXISTS scope               text NOT NULL DEFAULT 'flota',
  ADD COLUMN IF NOT EXISTS route_assignment_id uuid REFERENCES public.route_assignments(id) ON DELETE SET NULL,
  -- El trancón ocurre ENTRE la parada N y la N+1, así que guardar solo la ruta
  -- pierde el dato útil: cuál era la parada a la que iba.
  ADD COLUMN IF NOT EXISTS route_stop_id       uuid REFERENCES public.route_stops(id) ON DELETE SET NULL,
  -- Cuándo pasó, que no es lo mismo que cuándo se registró (el conductor reporta
  -- cuando puede parar el carro, no cuando ocurre).
  ADD COLUMN IF NOT EXISTS occurred_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS latitude            double precision,
  ADD COLUMN IF NOT EXISTS longitude           double precision,
  ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'driver',
  -- Lo que distingue un trancón de otro: ¿detenido o avanza? ¿accidente o
  -- tráfico habitual? Va en jsonb porque cada categoría pregunta cosas distintas
  -- y no vale la pena una columna por pregunta.
  ADD COLUMN IF NOT EXISTS details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Para los detectores automáticos (bloque B): el vigilante corre cada 5 min y
  -- refresca la misma situación; sin esto serían 12 avisos por hora de la misma
  -- demora. Los reportes humanos lo dejan NULL a propósito (ver §4).
  ADD COLUMN IF NOT EXISTS dedupe_key          text,
  ADD COLUMN IF NOT EXISTS acknowledged_at     timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.incidents.scope IS
  'flota = novedad del vehículo (pestaña Inspecciones) · operacion = eventualidad de un traslado (pestaña Eventualidades). Separa las dos bandejas y los dos badges.';
COMMENT ON COLUMN public.incidents.details IS
  'Respuestas propias de cada categoría. Trancón: {"movimiento":"detenido|lento","causa":"accidente|habitual"}.';
COMMENT ON COLUMN public.incidents.dedupe_key IS
  'Solo para eventualidades generadas por el sistema. Índice único mientras la eventualidad siga abierta, para que un detector que corre cada 5 min no la duplique.';
COMMENT ON COLUMN public.incidents.acknowledged_at IS
  'Un jefe la VIO. No es lo mismo que atenderla (status=in_progress): sirve para saber que el aviso de madrugada llegó a un ser humano y para escalar si nadie acusa.';

DO $do$
BEGIN
  ALTER TABLE public.incidents ADD CONSTRAINT incidents_scope_valid
    CHECK (scope IN ('flota', 'operacion'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

DO $do$
BEGIN
  ALTER TABLE public.incidents ADD CONSTRAINT incidents_source_valid
    CHECK (source IN ('driver', 'auxiliar', 'admin', 'system', 'flight_api'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

-- -----------------------------------------------------------------------------
-- 2. `reporter_id` deja de ser obligatorio
--    El vigilante de rutas y la API de vuelos van a crear eventualidades sin que
--    haya una persona detrás. La alternativa —inventar un perfil "sistema"— es
--    peor: ensucia Personal y miente sobre quién reportó.
-- -----------------------------------------------------------------------------
ALTER TABLE public.incidents ALTER COLUMN reporter_id DROP NOT NULL;

COMMENT ON COLUMN public.incidents.reporter_id IS
  'Quién reportó. NULL = lo detectó el sistema (vigilante de rutas, API de vuelos).';

-- -----------------------------------------------------------------------------
-- 3. Índices
-- -----------------------------------------------------------------------------
-- Las dos bandejas piden lo mismo: lo abierto de MI scope, lo más nuevo arriba.
CREATE INDEX IF NOT EXISTS idx_incidents_scope_status
  ON public.incidents(scope, status, created_at DESC);

-- Un detector no puede crear dos veces la misma eventualidad abierta. Cuando se
-- resuelve, la llave se libera y el mismo problema puede volver a levantarse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_dedupe_open
  ON public.incidents(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_reservation
  ON public.incidents(reservation_id) WHERE reservation_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. report_incident — el único camino para reportar durante un traslado
--
--    La policy de INSERT que existe (p_incidents_insert_own, 0016) solo exige
--    `reporter_id = auth.uid()`: hoy un tripulante podría colgar una eventualidad
--    de la reserva de otro, elegir la categoría que quisiera y encima decirnos a
--    qué organización pertenece. Este RPC valida el vínculo contra la ruta real,
--    igual que hace send_reservation_message (0052) con el chat, y de paso deriva
--    solo el turno, el vehículo, la ruta y la parada.
--
--    `dedupe_key` se deja NULL a propósito para los reportes humanos: si un
--    conductor reporta un trancón a las 4 y otro a las 7, son dos eventualidades,
--    no una repetida.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_incident(
  p_category       public.incident_category,
  p_description    text,
  p_severity       public.incident_severity DEFAULT 'medium',
  p_reservation_id uuid             DEFAULT NULL,
  p_details        jsonb            DEFAULT '{}'::jsonb,
  p_latitude       double precision DEFAULT NULL,
  p_longitude      double precision DEFAULT NULL,
  p_photo_paths    jsonb            DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me       uuid := auth.uid();
  v_role     text;
  v_org      uuid;
  v_aux      uuid := public.current_auxiliar_id();
  v_drv      uuid := public.current_driver_id();
  v_source   text;
  v_desc     text := btrim(coalesce(p_description, ''));
  v_ra       uuid;
  v_rs       uuid;
  v_ra_drv   uuid;
  v_res_aux  uuid;
  v_shift    uuid;
  v_vehicle  uuid;
  v_id       uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_role := public.current_user_role();
  v_org  := public.current_user_org();

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Tu perfil no tiene organización';
  END IF;

  IF v_desc = '' THEN
    RAISE EXCEPTION 'Cuéntanos qué pasó: la descripción no puede ir vacía';
  END IF;
  IF length(v_desc) > 1000 THEN
    RAISE EXCEPTION 'La descripción es demasiado larga';
  END IF;

  -- Quién habla. El rol NO se lo creemos al cliente.
  IF v_role = 'admin' THEN
    v_source := 'admin';
  ELSIF v_drv IS NOT NULL THEN
    v_source := 'driver';
  ELSIF v_aux IS NOT NULL THEN
    v_source := 'auxiliar';
  ELSE
    RAISE EXCEPTION 'Tu perfil no puede reportar eventualidades';
  END IF;

  -- Si la eventualidad es de un traslado, se valida el vínculo y se derivan la
  -- ruta y la parada. Sin esto, el jefe recibe un aviso que no sabe dónde ubicar.
  IF p_reservation_id IS NOT NULL THEN
    SELECT r.auxiliar_profile_id, ra.id, rs.id, ra.driver_profile_id
      INTO v_res_aux, v_ra, v_rs, v_ra_drv
    FROM public.reservations r
    LEFT JOIN public.route_stops rs       ON rs.reservation_id = r.id
    LEFT JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                                         AND ra.status IN ('planned', 'in_progress')
    WHERE r.id = p_reservation_id
      AND r.cancelled_at IS NULL
    ORDER BY ra.planned_start_at DESC NULLS LAST
    LIMIT 1;

    IF v_res_aux IS NULL THEN
      RAISE EXCEPTION 'La reserva no existe o fue cancelada';
    END IF;

    IF v_source = 'auxiliar' AND v_res_aux <> v_aux THEN
      RAISE EXCEPTION 'Ese traslado no es tuyo';
    END IF;
    IF v_source = 'driver' AND (v_ra_drv IS NULL OR v_ra_drv <> v_drv) THEN
      RAISE EXCEPTION 'Ese traslado no está en tu ruta';
    END IF;
  END IF;

  -- Al conductor se le adjunta su turno y su carro sin preguntárselo: es lo
  -- primero que el jefe necesita saber en una falla mecánica.
  IF v_source = 'driver' THEN
    SELECT s.id, s.vehicle_id
      INTO v_shift, v_vehicle
    FROM public.shifts s
    WHERE s.driver_id = v_drv
      AND s.status IN ('vehicle_selected', 'inspection_in_progress', 'active', 'closing')
    ORDER BY s.start_at DESC
    LIMIT 1;
  END IF;

  INSERT INTO public.incidents (
    organization_id, reporter_id, shift_id, vehicle_id, reservation_id,
    route_assignment_id, route_stop_id,
    category, severity, status, description, photo_paths,
    scope, source, details, latitude, longitude, occurred_at
  ) VALUES (
    v_org, v_me, v_shift, v_vehicle, p_reservation_id,
    v_ra, v_rs,
    p_category, coalesce(p_severity, 'medium'), 'open', v_desc,
    coalesce(p_photo_paths, '[]'::jsonb),
    'operacion', v_source, coalesce(p_details, '{}'::jsonb),
    p_latitude, p_longitude, now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.report_incident(public.incident_category, text, public.incident_severity, uuid, jsonb, double precision, double precision, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_incident(public.incident_category, text, public.incident_severity, uuid, jsonb, double precision, double precision, jsonb) TO authenticated;

COMMENT ON FUNCTION public.report_incident(public.incident_category, text, public.incident_severity, uuid, jsonb, double precision, double precision, jsonb) IS
  'Reporta una eventualidad de operación (conductor, tripulante o admin). Valida que quien reporta esté vinculado a la reserva y deriva turno, vehículo, ruta y parada. Siempre nace con scope=operacion.';

-- -----------------------------------------------------------------------------
-- 5. Se cierra el hueco del INSERT directo
--    Todo lo que tenga que ver con un traslado pasa por el RPC. El insert directo
--    queda solo para el flujo de turnos (inicio/cierre), que nunca manda reserva.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_incidents_insert_own ON public.incidents;
CREATE POLICY p_incidents_insert_own
  ON public.incidents FOR INSERT TO authenticated
  WITH CHECK (
    reporter_id = auth.uid()
    AND organization_id = public.current_user_org()
    AND reservation_id IS NULL
    AND scope = 'flota'
  );

-- -----------------------------------------------------------------------------
-- 6. Quién recibe las alertas de operación
--    No existe el rol "jefe": `role='admin'` incluye a los coordinadores. Sin
--    esta bandera, o suena en todos los admins o habría que quemar unos ids en el
--    código.
--
--    Se deja en false por defecto A PROPÓSITO, pero el cliente cae a "todos los
--    admins activos" cuando NADIE la tiene encendida: una operación sin nadie
--    marcado no puede quedarse muda: ese es justo el problema que veníamos a
--    resolver.
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS receives_ops_alerts boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.receives_ops_alerts IS
  'Recibe push de eventualidades de operación (falla mecánica, botón rojo, carro atrasado). Si NADIE la tiene en true, se avisa a todos los admins activos.';

-- -----------------------------------------------------------------------------
-- 7. notification_outbox — la bandeja de salida de los avisos
--
--    ⚠ SIN CONSUMIDOR TODAVÍA. En este bloque el push lo manda el propio cliente
--    (quien reporta siempre tiene la app abierta), así que NADA escribe aquí aún.
--    La tabla se crea ahora para que el bloque B solo tenga que agregar el
--    transporte, no el esquema.
--
--    Por qué una bandeja de salida y no que el cron llame a `send-push` derecho:
--    `send-push` exige un JWT de USUARIO (hace auth.getUser) y le devolvería 401
--    a la llave de servicio; y pg_net no lanza excepciones —encola y la respuesta
--    cae en net._http_response, que nadie lee—. O sea: daríamos por hecho que el
--    aviso de madrugada quedó programado, el teléfono no suena, y en los logs no
--    hay ni un error. Con una bandeja de salida el fallo queda escrito
--    (`attempts`, `last_error`) y toda la lógica de CUÁNDO se avisa se prueba en
--    SQL, sin HTTP y sin teléfono.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  incident_id  uuid        REFERENCES public.incidents(id) ON DELETE CASCADE,
  title        text        NOT NULL,
  body         text        NOT NULL,
  url          text        NOT NULL DEFAULT '/',
  dedupe_key   text,
  send_after   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  attempts     smallint    NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_outbox_title_not_blank CHECK (length(btrim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON public.notification_outbox(send_after) WHERE sent_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe
  ON public.notification_outbox(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND sent_at IS NULL;

DROP TRIGGER IF EXISTS tr_notification_outbox_set_updated_at ON public.notification_outbox;
CREATE TRIGGER tr_notification_outbox_set_updated_at
  BEFORE UPDATE ON public.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS encendida y SIN políticas: nadie la toca desde el cliente. La escriben los
-- detectores (SECURITY DEFINER) y la drena la función de despacho con la llave de
-- servicio.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.notification_outbox IS
  'Avisos pendientes de enviar como push. SIN CONSUMIDOR hasta la 0064: en el bloque A el push lo manda el cliente que reporta. No escribir aquí todavía.';
