-- =============================================================================
-- 0099 · Estado de vuelos (AeroDataBox) — la base se entera sola de un retraso
-- =============================================================================
-- HOY: el número de vuelo es texto libre dentro de reservations.notes
-- («Vuelo AV9563. …», ver _flightFromNotes en api.js), la tabla `flights` (0003)
-- está muerta —reservations.flight_id va siempre NULL— y la hora la escribe la
-- persona: required_arrival_at = hora de presentación (salidas) u hora de
-- aterrizaje (llegadas). Si el vuelo se atrasa, nadie se entera hasta que el
-- tripulante escribe por WhatsApp o el carro ya está esperando en el andén.
--
-- QUÉ HACE
--   1. reservations.flight_code: el código normalizado (AV9563, LA4025, J65417),
--      sacado de las notas con LA MISMA expresión que usa la app (relleno de lo
--      que ya existe + disparador para lo nuevo). Las notas siguen siendo la
--      fuente: si cambian (p. ej. «Cambió mi vuelo», 0089), el código se recalcula.
--      Un vuelo de solo dígitos («5116», reservas viejas) se guarda igual que lo
--      lee la app, pero NO se consulta: sin sigla no hay a quién preguntarle.
--   2. public.flight_statuses: el último estado conocido de cada vuelo, por
--      organización + código + día + sentido. OJO con el nombre: `flight_status`
--      (singular) ya es un TIPO enum desde 0001, y una tabla crea un tipo con su
--      mismo nombre, así que `CREATE TABLE public.flight_status` revienta. Además
--      las tablas van en plural (CLAUDE.md del backend).
--      La escribe SOLO la llave de servicio (Edge Function flight-status). La leen
--      los jefes y conductores de la organización, y cada tripulante SOLO los
--      vuelos de sus propias reservas (el vuelo de un compañero no es asunto suyo).
--   3. flight_status_targets(): qué vuelos consultar ahora. Reservas activas con
--      sigla, de hoy y mañana en Bogotá (más las de anoche que siguen en el aire),
--      que pasan en las próximas 12 h; sin repetir y sin volver a preguntar por el
--      mismo vuelo antes de 20 min (120 min si todavía falta más de 3 h: cada
--      consulta cuesta unidades del plan, ver docs/VUELOS.md). Lo que ya aterrizó,
--      despegó, se canceló o se desvió no se vuelve a consultar.
--   4. flight_status_record(rows): la Edge Function guarda lo que trajo. Un «no
--      encontrado» después de un dato bueno NO borra el dato bueno.
--   5. flight_delay_alerts(): cuando la hora de una LLEGADA se mueve ≥ 15 min
--      respecto a lo último que se avisó (o el vuelo se cancela o se desvía),
--      encola en notification_outbox (0063/0066; la drena dispatch-notifications)
--      un aviso a los jefes que reciben alertas de operación de esa organización
--      y al conductor de la ruta si el plan ya está publicado:
--        «Vuelo AV9563 aterriza 14:35 (25 min tarde). Recogida sugerida 14:50»
--      Recogida sugerida = hora estimada (o real) + desembarque de la aerolínea
--      (el mismo cálculo de rtDeplaneVuelo en admin-rutas.js, sobre las columnas
--      route_deplane_*_min de 0058; respaldo route_deplane_min = 20).
--      NO MUEVE required_arrival_at: eso lo decide un jefe.
--   6. poll_flight_status() + pg_cron cada 15 min: dispara la Edge Function con
--      la URL y la llave del Vault ('flight_status_url', 'service_role_key'),
--      igual que drain_notification_outbox (0066). Si falta algo lo DICE en el
--      texto que devuelve, sin fallar.
--   7. app_settings.flight_api_enabled (false por defecto): el interruptor. Con
--      la bandera apagada no se consulta nada, no se avisa nada y la app no pinta
--      ningún estado de vuelo.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. No toca migraciones
-- anteriores. Down: down_migrations/0099_vuelos.down.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El interruptor
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS flight_api_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_settings.flight_api_enabled IS
  'Integración de estado de vuelos (0099, AeroDataBox). false = no se consulta, no se avisa y la app no pinta estados. Encenderla requiere además la llave AERODATABOX_API_KEY en la Edge Function flight-status y el secreto flight_status_url en Vault (docs/VUELOS.md).';

-- -----------------------------------------------------------------------------
-- 2. reservations.flight_code
-- -----------------------------------------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS flight_code text;

DO $do$
BEGIN
  ALTER TABLE public.reservations ADD CONSTRAINT reservations_flight_code_format
    CHECK (flight_code IS NULL OR flight_code ~ '^[A-Z0-9]{2,8}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

COMMENT ON COLUMN public.reservations.flight_code IS
  'Código de vuelo normalizado (AV9563). Se deriva de notes con la misma expresión que _flightFromNotes de api.js (o de flights.flight_number si hay flight_id). Lo mantiene el disparador tr_reservations_flight_code: si cambian las notas, se recalcula.';

CREATE INDEX IF NOT EXISTS idx_reservations_flight_code
  ON public.reservations(flight_code) WHERE flight_code IS NOT NULL;

-- El gemelo SQL de _flightFromNotes (api.js) y flightFromNotes (api-aux.js):
--   /vuelo\s*:?\s*([A-Za-z]{0,3})\s*-?\s*(\d{2,5})/i  →  (sigla + dígitos) en mayúscula
-- Misma expresión a propósito: si el servidor y el teléfono leyeran vuelos
-- distintos de la misma nota, el chip pintaría el estado de otro vuelo.
-- (_verify-0099.mjs compara las dos sobre una batería de notas.)
CREATE OR REPLACE FUNCTION public.flight_code_from_notes(p_notes text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN m IS NULL THEN NULL ELSE upper(coalesce(m[1], '') || m[2]) END
    FROM (SELECT regexp_match(coalesce(p_notes, ''),
                              'vuelo\s*:?\s*([A-Za-z]{0,3})\s*-?\s*(\d{2,5})', 'i') AS m) s;
$$;

-- Sin espacios ni guiones, en mayúscula; vacío = NULL. Es lo mismo que hace
-- auxiliar_change_flight (0089) con lo que escribe el tripulante.
CREATE OR REPLACE FUNCTION public.flight_code_normalize(p_code text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT nullif(upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g')), '');
$$;

-- Lo que la app muestra como vuelo de una reserva: flights.flight_number si la
-- reserva está ligada (nunca, hoy) y si no, lo que dicen las notas.
CREATE OR REPLACE FUNCTION public.reservation_flight_code(p_flight_id uuid, p_notes text)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT public.flight_code_normalize(f.flight_number) FROM public.flights f WHERE f.id = p_flight_id),
    public.flight_code_from_notes(p_notes));
$$;

CREATE OR REPLACE FUNCTION public.tg_reservations_flight_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.flight_code IS NOT NULL THEN
      NEW.flight_code := public.flight_code_normalize(NEW.flight_code);
    ELSE
      NEW.flight_code := public.reservation_flight_code(NEW.flight_id, NEW.notes);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. Si alguien escribe el código a propósito, gana lo que escribió.
  IF NEW.flight_code IS DISTINCT FROM OLD.flight_code AND NEW.flight_code IS NOT NULL THEN
    NEW.flight_code := public.flight_code_normalize(NEW.flight_code);
  -- Si viene NULL, o cambió de dónde sale el vuelo (las notas o el registro de
  -- flights), se vuelve a leer. Unas notas sin vuelo dejan el código en NULL:
  -- es lo mismo que la app lee de esas notas.
  ELSIF NEW.flight_code IS NULL
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.flight_id IS DISTINCT FROM OLD.flight_id THEN
    NEW.flight_code := public.reservation_flight_code(NEW.flight_id, NEW.notes);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_flight_code ON public.reservations;
CREATE TRIGGER tr_reservations_flight_code
  BEFORE INSERT OR UPDATE OF notes, flight_id, flight_code ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservations_flight_code();

-- Relleno de lo que ya existe. Función aparte para poder probarlo
-- (_verify-0099.mjs) y volver a correrlo si hiciera falta. No mueve updated_at:
-- el relleno no es un cambio de la reserva, y apagar SOLO ese disparador mientras
-- tanto evita que todas las reservas con vuelo amanezcan «modificadas hoy».
CREATE OR REPLACE FUNCTION public.backfill_reservation_flight_codes()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  ALTER TABLE public.reservations DISABLE TRIGGER tr_reservations_set_updated_at;
  UPDATE public.reservations r
     SET flight_code = public.reservation_flight_code(r.flight_id, r.notes)
   WHERE r.flight_code IS NULL
     AND public.reservation_flight_code(r.flight_id, r.notes) IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ALTER TABLE public.reservations ENABLE TRIGGER tr_reservations_set_updated_at;
  RETURN v_n;
END;
$$;

SELECT public.backfill_reservation_flight_codes();

-- -----------------------------------------------------------------------------
-- 3. public.flight_statuses
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flight_statuses (
  id                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid                  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flight_code        text                  NOT NULL,
  -- Día LOCAL (Bogotá) de la reserva —required_arrival_at—, que es como la app
  -- agrupa el día. La hora real del vuelo va en sched_at.
  flight_date        date                  NOT NULL,
  direction          public.trip_direction NOT NULL,
  sched_at           timestamptz,          -- programada (llegada a MDE / salida de MDE)
  estimated_at       timestamptz,          -- estimada en vivo (revisedTime del proveedor)
  actual_at          timestamptz,          -- real: aterrizó / despegó
  status             text                  NOT NULL DEFAULT 'unknown',
  delay_min          integer,              -- (real o estimada) − programada; NULL = sin dato en vivo
  terminal           text,
  gate               text,
  source             text                  NOT NULL DEFAULT 'aerodatabox',
  raw                jsonb                 NOT NULL DEFAULT '{}'::jsonb,
  fetched_at         timestamptz           NOT NULL DEFAULT now(),
  -- Lo último que se avisó (flight_delay_alerts): sin esto, el mismo retraso
  -- sonaría cada 20 min.
  alerted_delay_min  integer,
  alerted_status     text,
  alerted_at         timestamptz,
  created_at         timestamptz           NOT NULL DEFAULT now(),
  updated_at         timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT flight_statuses_key UNIQUE (organization_id, flight_code, flight_date, direction),
  CONSTRAINT flight_statuses_status_valid
    CHECK (status IN ('scheduled', 'delayed', 'in_air', 'landed', 'cancelled', 'diverted', 'unknown')),
  CONSTRAINT flight_statuses_source_valid
    CHECK (source IN ('aerodatabox', 'mock', 'manual'))
);

COMMENT ON TABLE public.flight_statuses IS
  'Último estado conocido de un vuelo (0099). Una fila por organización + código + día local de la reserva + sentido. La escribe solo la Edge Function flight-status (llave de servicio). status: scheduled (solo horario) · delayed · in_air · landed · cancelled · diverted · unknown (el proveedor no lo encontró).';
COMMENT ON COLUMN public.flight_statuses.flight_date IS
  'Día local (America/Bogota) de reservations.required_arrival_at. En una salida de las 00:30 con presentación a las 23:30 es el día de la presentación: así casa con la reserva.';

CREATE INDEX IF NOT EXISTS idx_flight_statuses_day ON public.flight_statuses(flight_date);

DROP TRIGGER IF EXISTS tr_flight_statuses_set_updated_at ON public.flight_statuses;
CREATE TRIGGER tr_flight_statuses_set_updated_at
  BEFORE UPDATE ON public.flight_statuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flight_statuses ENABLE ROW LEVEL SECURITY;

-- Leer: jefes y conductores de la organización; el tripulante solo los vuelos de
-- SUS reservas. Escribir: nadie desde el cliente (sin políticas de escritura; la
-- llave de servicio se salta RLS y las funciones de abajo son SECURITY DEFINER).
DROP POLICY IF EXISTS p_flight_statuses_select ON public.flight_statuses;
CREATE POLICY p_flight_statuses_select
  ON public.flight_statuses FOR SELECT TO authenticated
  USING (
    organization_id = public.current_user_org()
    AND (
      public.current_user_role() IN ('admin', 'driver')
      OR EXISTS (
        SELECT 1 FROM public.reservations r
         WHERE r.auxiliar_profile_id = public.current_auxiliar_id()
           AND r.flight_code = flight_statuses.flight_code
           AND r.direction = flight_statuses.direction
           AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = flight_statuses.flight_date)
    )
  );

REVOKE ALL ON public.flight_statuses FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.flight_statuses FROM authenticated;
GRANT SELECT ON public.flight_statuses TO authenticated;
GRANT ALL ON public.flight_statuses TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Desembarque de un vuelo — el gemelo SQL de rtDeplaneVuelo (admin-rutas.js)
--    Mismas siglas, mismo orden (las de 3 letras primero), mismos respaldos: un
--    valor en 0 o vacío cae a route_deplane_min, y sin nada, 20.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_deplane_min(p_code text)
RETURNS integer
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  s       text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  c       record;
  v_fb    integer := 20;
  v_sigla text;
  v_num   text;
BEGIN
  SELECT nullif(route_deplane_min, 0)        AS fb,
         nullif(route_deplane_av_nac_min, 0) AS av_nac,
         nullif(route_deplane_av_int_min, 0) AS av_int,
         nullif(route_deplane_js_nac_min, 0) AS js_nac,
         nullif(route_deplane_js_int_min, 0) AS js_int,
         nullif(route_deplane_wingo_min, 0)  AS wingo
    INTO c
    FROM public.app_settings WHERE id = 'singleton';
  v_fb := coalesce(c.fb, 20);
  IF s = '' THEN RETURN v_fb; END IF;

  v_sigla := CASE
    WHEN s LIKE 'JEC%' THEN 'JEC' WHEN s LIKE 'J6%' THEN 'J6' WHEN s LIKE 'JA%' THEN 'JA'
    WHEN s LIKE 'JE%'  THEN 'JE'  WHEN s LIKE 'AV%' THEN 'AV' WHEN s LIKE 'P5%' THEN 'P5'
    WHEN s LIKE 'LA%'  THEN 'LA'  ELSE '' END;
  v_num := substr(s, length(v_sigla) + 1);
  IF v_num !~ '^[0-9]+$' THEN RETURN v_fb; END IF;

  IF v_sigla = 'P5' THEN RETURN coalesce(c.wingo, v_fb); END IF;
  IF v_sigla = 'LA' THEN RETURN v_fb; END IF;
  IF v_sigla IN ('JEC', 'JA', 'J6', 'JE') THEN
    RETURN CASE WHEN v_num LIKE '58%' THEN coalesce(c.js_int, v_fb) ELSE coalesce(c.js_nac, v_fb) END;
  END IF;
  IF v_sigla = 'AV' THEN
    RETURN CASE WHEN length(v_num) <= 3 THEN coalesce(c.av_int, v_fb) ELSE coalesce(c.av_nac, v_fb) END;
  END IF;
  -- Sin sigla: por la forma del número (inferencia, ver rtDeplaneVuelo).
  IF length(v_num) <= 3 THEN RETURN coalesce(c.av_int, v_fb); END IF;
  IF length(v_num) = 4 AND v_num LIKE '58%' THEN RETURN coalesce(c.js_int, v_fb); END IF;
  IF length(v_num) = 4 AND v_num LIKE '5%'  THEN RETURN coalesce(c.js_nac, v_fb); END IF;
  RETURN coalesce(c.av_nac, v_fb);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Qué vuelos consultar ahora
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_status_targets(
  p_now   timestamptz DEFAULT now(),
  p_limit integer     DEFAULT 20
)
RETURNS TABLE (
  organization_id uuid,
  flight_code     text,
  flight_date     date,
  direction       public.trip_direction,
  ref_at          timestamptz,   -- la hora de la reserva (aterrizaje / presentación) más temprana del grupo
  reservations    integer,
  last_fetched_at timestamptz,
  last_status     text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cfg AS (
    SELECT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) AS enabled,
           (p_now AT TIME ZONE 'America/Bogota')::date AS hoy
  ),
  res AS (
    SELECT pa.organization_id, r.flight_code, r.direction, r.required_arrival_at,
           (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date AS dia
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pa          ON pa.id = ap.profile_id
      CROSS JOIN cfg
     WHERE cfg.enabled
       AND r.cancelled_at IS NULL
       AND coalesce(r.ground_ops, false) = false
       AND coalesce(r.status_h2a::text, r.status_a2h::text, '') NOT IN ('delivered', 'no_show', 'cancelled')
       -- Con sigla: un «5116» pelado no se le puede preguntar a nadie.
       AND r.flight_code ~ '^[A-Z]{1,3}[0-9]{2,5}$'
       -- Hoy y mañana en Bogotá; y ayer solo para el vuelo de anoche que se
       -- corrió pasada la medianoche (la ventana de abajo lo acota a 6 h).
       AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN cfg.hoy - 1 AND cfg.hoy + 1
       AND r.required_arrival_at <= p_now + interval '12 hours'
       AND r.required_arrival_at >= p_now - interval '6 hours'
  ),
  grp AS (
    SELECT res.organization_id, res.flight_code, res.dia, res.direction,
           min(res.required_arrival_at) AS ref_at, count(*)::integer AS n
      FROM res
     GROUP BY res.organization_id, res.flight_code, res.dia, res.direction
  )
  SELECT g.organization_id, g.flight_code, g.dia, g.direction, g.ref_at, g.n,
         fs.fetched_at, fs.status
    FROM grp g
    LEFT JOIN public.flight_statuses fs
           ON fs.organization_id = g.organization_id AND fs.flight_code = g.flight_code
          AND fs.flight_date = g.dia AND fs.direction = g.direction
   WHERE
     -- Lo que ya terminó no se vuelve a consultar. En una SALIDA, que despegó ya
     -- es el final que nos importa.
         coalesce(fs.status, '') NOT IN ('landed', 'cancelled', 'diverted')
     AND NOT (g.direction = 'home_to_airport' AND coalesce(fs.status, '') = 'in_air')
     -- La hora de la reserva ya pasó: solo si sabemos que el vuelo sigue por llegar.
     AND (g.ref_at >= p_now - interval '30 minutes'
          OR (fs.id IS NOT NULL AND fs.status <> 'unknown'
              AND coalesce(fs.actual_at, fs.estimated_at, fs.sched_at) >= p_now - interval '30 minutes'))
     -- Nunca dos veces el mismo vuelo en 20 min; si falta más de 3 h, cada 2 h.
     AND (fs.fetched_at IS NULL
          OR fs.fetched_at <= p_now - CASE
               WHEN least(g.ref_at, coalesce(fs.estimated_at, g.ref_at)) <= p_now + interval '3 hours'
               THEN interval '20 minutes' ELSE interval '120 minutes' END)
   ORDER BY least(g.ref_at, coalesce(fs.estimated_at, g.ref_at)), g.flight_code
   LIMIT greatest(coalesce(p_limit, 20), 0);
$$;

COMMENT ON FUNCTION public.flight_status_targets(timestamptz, integer) IS
  'Vuelos a consultar (0099): reservas activas con sigla de hoy/mañana (Bogotá) que pasan en las próximas 12 h, agrupadas por organización+código+día+sentido; mínimo 20 min entre consultas del mismo vuelo (120 si falta más de 3 h); nada que ya terminó. Vacío si flight_api_enabled = false.';

-- -----------------------------------------------------------------------------
-- 6. Guardar lo que trajo la Edge Function
--    p_rows = [{organization_id, flight_code, flight_date, direction, sched_at,
--               estimated_at, actual_at, status, delay_min, terminal, gate,
--               source, raw, fetched_at?}, …]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_status_record(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;

  INSERT INTO public.flight_statuses AS fs (
    organization_id, flight_code, flight_date, direction,
    sched_at, estimated_at, actual_at, status, delay_min, terminal, gate,
    source, raw, fetched_at)
  SELECT (x->>'organization_id')::uuid,
         public.flight_code_normalize(x->>'flight_code'),
         (x->>'flight_date')::date,
         (x->>'direction')::public.trip_direction,
         (x->>'sched_at')::timestamptz,
         (x->>'estimated_at')::timestamptz,
         (x->>'actual_at')::timestamptz,
         coalesce(nullif(x->>'status', ''), 'unknown'),
         (x->>'delay_min')::integer,
         nullif(x->>'terminal', ''),
         nullif(x->>'gate', ''),
         coalesce(nullif(x->>'source', ''), 'aerodatabox'),
         coalesce(x->'raw', '{}'::jsonb),
         coalesce((x->>'fetched_at')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) x
  ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET
    fetched_at   = EXCLUDED.fetched_at,
    -- «No lo encontré» después de un dato bueno: el proveedor tuvo un mal rato.
    -- Se anota la consulta (para respetar los 20 min) y se conserva lo bueno.
    sched_at     = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.sched_at     ELSE EXCLUDED.sched_at     END,
    estimated_at = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.estimated_at ELSE EXCLUDED.estimated_at END,
    actual_at    = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.actual_at    ELSE EXCLUDED.actual_at    END,
    status       = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.status       ELSE EXCLUDED.status       END,
    delay_min    = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.delay_min    ELSE EXCLUDED.delay_min    END,
    terminal     = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.terminal     ELSE EXCLUDED.terminal     END,
    gate         = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.gate         ELSE EXCLUDED.gate         END,
    source       = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.source       ELSE EXCLUDED.source       END,
    raw          = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' THEN fs.raw          ELSE EXCLUDED.raw          END;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.flight_status_record(jsonb) IS
  'La Edge Function flight-status guarda aquí lo que trajo del proveedor (upsert por organización+código+día+sentido). Un unknown no pisa un dato bueno.';

-- -----------------------------------------------------------------------------
-- 7. Avisar cuando se mueve la hora de una llegada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_delay_alerts(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  f       record;
  v_hoy   date := (p_now AT TIME ZONE 'America/Bogota')::date;
  v_best  timestamptz;
  v_pick  timestamptz;
  v_kind  text;
  v_title text;
  v_body  text;
  v_cuan  text;
  v_n     integer;
  v_total integer := 0;
BEGIN
  IF NOT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) THEN
    RETURN 0;
  END IF;

  FOR f IN
    SELECT fs.*
      FROM public.flight_statuses fs
     WHERE fs.direction = 'airport_to_home'
       AND fs.flight_date BETWEEN v_hoy - 1 AND v_hoy + 1
       AND fs.status <> 'unknown'
       AND (
             (fs.status IN ('cancelled', 'diverted') AND fs.alerted_status IS DISTINCT FROM fs.status)
          OR (fs.status NOT IN ('cancelled', 'diverted') AND fs.delay_min IS NOT NULL
              AND abs(fs.delay_min - coalesce(fs.alerted_delay_min, 0)) >= 15)
           )
       -- Un vuelo que aterrizó hace horas ya no le sirve a nadie.
       AND coalesce(fs.actual_at, fs.estimated_at, fs.sched_at, p_now) >= p_now - interval '3 hours'
     FOR UPDATE
  LOOP
    -- ¿Alguien viene en ese vuelo todavía? Sin reservas activas no hay a quién avisar.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.reservations r
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        JOIN public.profiles pa ON pa.id = ap.profile_id
       WHERE pa.organization_id = f.organization_id
         AND r.flight_code = f.flight_code
         AND r.direction = 'airport_to_home'
         AND r.cancelled_at IS NULL
         AND coalesce(r.status_a2h::text, '') NOT IN ('delivered', 'cancelled')
         AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = f.flight_date);

    v_best := coalesce(f.actual_at, f.estimated_at, f.sched_at);
    IF f.status = 'cancelled' THEN
      v_kind  := 'cancelled';
      v_title := 'Vuelo cancelado';
      v_body  := 'Vuelo ' || f.flight_code
                 || coalesce(' de las ' || to_char(f.sched_at AT TIME ZONE 'America/Bogota', 'HH24:MI'), '')
                 || ' aparece cancelado. Confirma con el tripulante antes de mover el carro.';
    ELSIF f.status = 'diverted' THEN
      v_kind  := 'diverted';
      v_title := 'Vuelo desviado';
      v_body  := 'Vuelo ' || f.flight_code
                 || ' fue desviado: no va a aterrizar en MDE a la hora prevista. Confirma con el tripulante.';
    ELSE
      v_kind := 'delay:' || f.delay_min;
      v_pick := v_best + make_interval(mins => public.flight_deplane_min(f.flight_code));
      v_cuan := CASE WHEN f.delay_min > 0 THEN f.delay_min || ' min tarde'
                     WHEN f.delay_min < 0 THEN (-f.delay_min) || ' min antes'
                     ELSE 'a tiempo' END;
      v_title := CASE WHEN f.delay_min > 0 THEN 'Vuelo retrasado'
                      WHEN f.delay_min < 0 THEN 'Vuelo adelantado'
                      ELSE 'Vuelo a tiempo' END;
      v_body := 'Vuelo ' || f.flight_code
                || CASE WHEN f.status = 'landed' THEN ' aterrizó ' ELSE ' aterriza ' END
                || to_char(v_best AT TIME ZONE 'America/Bogota', 'HH24:MI')
                || ' (' || v_cuan || '). Recogida sugerida '
                || to_char(v_pick AT TIME ZONE 'America/Bogota', 'HH24:MI');
    END IF;

    -- Los jefes de ESA organización que reciben alertas de operación, y el
    -- conductor de cada ruta publicada (planned / in_progress) donde va alguien
    -- de ese vuelo. La regla de los jefes es la de ops_alert_recipients (0066)
    -- —los marcados en Personal; si nadie está marcado, todos los admins
    -- activos— pero aplicada DENTRO de la organización: ops_alert_recipients()
    -- mira los marcados de todas, y filtrarla después por organización dejaría
    -- muda a una organización sin marcados mientras otra sí los tenga.
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    SELECT d.pid, v_title, v_body, d.url,
           'flt:' || f.id::text || ':' || v_kind || ':' || d.pid::text
      FROM (
        SELECT adm.id AS pid, '/#/reservas' AS url
          FROM public.profiles adm
         WHERE adm.organization_id = f.organization_id
           AND adm.role = 'admin' AND adm.deleted_at IS NULL
           AND adm.is_active IS DISTINCT FROM false
           AND (adm.receives_ops_alerts OR NOT EXISTS (
                 SELECT 1 FROM public.profiles m
                  WHERE m.organization_id = f.organization_id
                    AND m.role = 'admin' AND m.deleted_at IS NULL
                    AND m.is_active IS DISTINCT FROM false AND m.receives_ops_alerts))
        UNION
        SELECT dp.profile_id, '/'
          FROM public.reservations r
          JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
          JOIN public.profiles pa          ON pa.id = ap.profile_id
          JOIN public.route_stops rs       ON rs.reservation_id = r.id
          JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
          JOIN public.driver_profiles dp   ON dp.id = ra.driver_profile_id
         WHERE pa.organization_id = f.organization_id
           AND r.flight_code = f.flight_code
           AND r.direction = 'airport_to_home'
           AND r.cancelled_at IS NULL
           AND coalesce(r.status_a2h::text, '') NOT IN ('delivered', 'cancelled')
           AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date = f.flight_date
           AND ra.status IN ('planned', 'in_progress')
           AND rs.status <> 'no_show'
      ) d
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;

    UPDATE public.flight_statuses
       SET alerted_delay_min = CASE WHEN f.status IN ('cancelled', 'diverted') THEN alerted_delay_min ELSE f.delay_min END,
           alerted_status    = f.status,
           alerted_at        = p_now
     WHERE id = f.id;
  END LOOP;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.flight_delay_alerts(timestamptz) IS
  'Encola en notification_outbox el aviso de una LLEGADA cuya hora se movió ≥ 15 min respecto a lo último avisado (o que se canceló o desvió): a los jefes de la organización que reciben alertas de operación y al conductor de la ruta publicada. No toca required_arrival_at. La llama la Edge Function flight-status después de guardar.';

-- -----------------------------------------------------------------------------
-- 8. El disparo (cron → Edge Function)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.poll_flight_status()
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_n     integer;
  v_url   text;
  v_key   text;
  v_falta text[] := ARRAY[]::text[];
BEGIN
  IF NOT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) THEN
    RETURN 'apagado: app_settings.flight_api_enabled = false';
  END IF;

  -- Sin vuelos que consultar no se despierta la Edge Function (cuesta una
  -- invocación y no trae nada).
  SELECT count(*) INTO v_n FROM public.flight_status_targets();
  IF v_n = 0 THEN RETURN 'sin vuelos por consultar'; END IF;

  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'flight_status_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'vault no disponible: ' || SQLERRM;
  END;

  IF v_url IS NULL THEN v_falta := array_append(v_falta, 'flight_status_url'); END IF;
  IF v_key IS NULL THEN v_falta := array_append(v_falta, 'service_role_key'); END IF;
  IF array_length(v_falta, 1) > 0 THEN
    RETURN 'faltan secretos en Vault: ' || array_to_string(v_falta, ', ')
           || ' (' || v_n || ' vuelos esperando)';
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key),
      body    := jsonb_build_object('trigger', 'cron'),
      timeout_milliseconds := 30000
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN 'pg_net no disponible: ' || SQLERRM;
  END;
  RETURN 'disparado con ' || v_n || ' vuelos por consultar';
END;
$$;

COMMENT ON FUNCTION public.poll_flight_status() IS
  'La llama pg_cron cada 15 min: si la bandera está encendida y hay vuelos por consultar, dispara la Edge Function flight-status (URL y llave del Vault). Devuelve en texto lo que hizo o lo que falta.';

-- -----------------------------------------------------------------------------
-- 9. Permisos: todo esto es del servidor
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.tg_reservations_flight_code()',
    'public.backfill_reservation_flight_codes()',
    'public.flight_deplane_min(text)',
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)',
    'public.flight_delay_alerts(timestamptz)',
    'public.poll_flight_status()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- La Edge Function entra con la llave de servicio.
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)',
    'public.flight_delay_alerts(timestamptz)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 10. El reloj: cada 15 min. Con la bandera apagada devuelve en el acto.
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('poll-flight-status');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.schedule('poll-flight-status', '*/15 * * * *', $job$SELECT public.poll_flight_status();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): la consulta de vuelos queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
