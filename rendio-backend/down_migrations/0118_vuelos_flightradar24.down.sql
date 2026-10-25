-- =============================================================================
-- 0118 (down) · Vuelos con Flightradar24 → vuelve a como lo dejó la 0099
-- =============================================================================
-- Borra lo que guardó Flightradar24 (sus términos prohíben conservarlo y el
-- CHECK de 0099 no acepta 'flightradar24'), quita las columnas y la purga, y
-- deja flight_status_targets, flight_status_record y poll_flight_status como en
-- 0099 (salidas y llegadas, calendario de AeroDataBox, 30 s para pg_net).
-- flight_delay_alerts no se toca (sigue la de 0107).
-- =============================================================================

BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule('purge-flight-statuses');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP FUNCTION IF EXISTS public.purge_flight_statuses(integer);
DROP FUNCTION IF EXISTS public.flight_eta_report(integer);

DELETE FROM public.notification_outbox o
 USING public.flight_statuses f
 WHERE f.source = 'flightradar24' AND o.dedupe_key LIKE 'flt:' || f.id::text || ':%';
DELETE FROM public.flight_statuses WHERE source = 'flightradar24';

ALTER TABLE public.flight_statuses DROP CONSTRAINT IF EXISTS flight_statuses_poll_mode_valid;
ALTER TABLE public.flight_statuses
  DROP COLUMN IF EXISTS departed_at,
  DROP COLUMN IF EXISTS origin_icao,
  DROP COLUMN IF EXISTS provider_ref,
  DROP COLUMN IF EXISTS poll_mode,
  DROP COLUMN IF EXISTS provider_credits,
  DROP COLUMN IF EXISTS eta_log;
ALTER TABLE public.flight_statuses DROP CONSTRAINT IF EXISTS flight_statuses_source_valid;
ALTER TABLE public.flight_statuses ADD CONSTRAINT flight_statuses_source_valid
  CHECK (source IN ('aerodatabox', 'mock', 'manual'));
ALTER TABLE public.flight_statuses ALTER COLUMN source SET DEFAULT 'aerodatabox';

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_flight_code_aliases_object;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS flight_code_aliases;
COMMENT ON COLUMN public.app_settings.flight_api_enabled IS
  'Integración de estado de vuelos (0099, AeroDataBox). false = no se consulta, no se avisa y la app no pinta estados. Encenderla requiere además la llave AERODATABOX_API_KEY en la Edge Function flight-status y el secreto flight_status_url en Vault (docs/VUELOS.md).';

-- ── Las funciones de 0099, copiadas tal cual ──
DROP FUNCTION IF EXISTS public.flight_status_targets(timestamptz, integer);

CREATE FUNCTION public.flight_status_targets(
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

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)',
    'public.poll_flight_status()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$do$;

COMMIT;
