-- =============================================================================
-- 0118 · Vuelos con Flightradar24 — solo llegadas, calendario por fase, 30 días
-- =============================================================================
-- 0099 dejó la cadena armada (flight_statuses, flight_status_targets,
-- flight_status_record, flight_delay_alerts, poll_flight_status + pg_cron,
-- bandera app_settings.flight_api_enabled) con AeroDataBox. La prueba real del
-- 14-oct mostró que AeroDataBox no trae el aterrizaje de los vuelos nacionales en
-- MDE; Flightradar24 sí. Esta migración cambia lo que depende del proveedor. El
-- lector vive en functions/flight-status/fr24.mjs.
--
-- LO QUE CAMBIA CON FR24
--   · FR24 no tiene horarios ni cancelaciones: un vuelo existe en la API solo
--     cuando el avión transmite. La hora «programada» (sched_at) es la de la
--     RESERVA —en una llegada, la hora de aterrizaje que escribió el tripulante—
--     y delay_min = ETA (o aterrizaje real) − esa hora.
--   · Cobra por vuelo devuelto: summary light = 1 crédito (despegue y aterrizaje
--     reales, sin ETA), live full = 8 (con ETA), respuesta vacía = 1. Plan
--     Explorer: 30.000 créditos al mes (60.000 hasta el 31-dic-2026).
--   · Términos: prohibido mezclar con otro proveedor y guardar sus datos más de
--     30 días (incluye raw). Aquí: una fila que cambia de proveedor se pisa
--     entera, y una purga diaria borra lo de más de 28 días.
--
-- QUÉ HACE
--   1. flight_statuses: 'flightradar24' en el CHECK de source (y por defecto), y
--      columnas nuevas: departed_at (despegue real en el origen), origin_icao,
--      provider_ref (fr24_id del tramo: después se pregunta por él, exacto),
--      poll_mode (lo último que se preguntó), provider_credits (créditos que ha
--      costado ese vuelo, para medir el presupuesto) y eta_log (las ETA que fue
--      dando, para medir qué tan exacta es: flight_eta_report).
--   2. app_settings.flight_code_aliases: sigla de la reserva → siglas con que
--      preguntarle a FR24. Nace VACÍO: se pregunta lo que escribió el tripulante.
--      Lo PRIMERO que hay que confirmar con el token real es JetSmart: los
--      tripulantes escriben JA5116; si FR24 lo conoce como J65116, se pone
--        update app_settings set flight_code_aliases = '{"JA": ["J6"]}' where id = 'singleton';
--      ({"JA": ["JA","J6"]} pregunta los dos en la misma petición.)
--   3. flight_status_targets(): SOLO LLEGADAS, con el calendario de FR24. Cada
--      vuelo sale con su `mode`:
--        a. Antes del despegue — mode 'summary' («¿ya despegó?»), cada 15 min.
--           SUPUESTO: sin horario no hay forma de saber el despegue esperado (no
--           se sabe el origen hasta que el avión transmite), así que se empieza
--           2 h antes de la hora de aterrizaje de la reserva. Un nacional (≈1 h de
--           vuelo) queda preguntado desde ~1 h antes de despegar; un vuelo largo
--           ya está en el aire en la primera pregunta y no se pierde nada.
--           Si pasa la hora de la reserva y no ha despegado (retraso en el
--           origen), sigue cada 15 min la primera hora y cada 30 min hasta 3 h
--           después; ahí se rinde (queda 'unknown': no se inventa nada).
--        b. En el aire — mode 'live' (la ETA): la primera en la vuelta siguiente
--           al despegue; después cada 15 min si la ETA está a 60 min o menos, y
--           cada hora si está más lejos (un vuelo largo no se lee cada 15 min
--           durante horas: son 8 créditos cada vez).
--        c. La ETA ya llegó — mode 'summary' («¿ya aterrizó?»), cada 15 min.
--           Aterrizó o se desvió → no se vuelve a preguntar. (Si en live el vuelo
--           ya no aparece, la Edge Function confirma con summary en la misma
--           corrida.)
--        Tampoco se pregunta si el tripulante ya está en tierra con el conductor
--        (desembarcando, recogido, entregado) ni por reservas de tierra.
--        Presupuesto con este calendario (simulación de _verify-0118.mjs, con el
--        modo prueba del lector): 20 créditos un nacional a tiempo, 27 uno que
--        sale 40 min tarde, 34 uno largo de 3 h; ≈ 22 por llegada contando las
--        respuestas vacías → ~16.600 al mes con 25 llegadas al día (el Explorer
--        trae 30.000). FR24 real puede costar algo más: un avión que transmite
--        mucho rato en tierra en el origen cuesta 1 crédito por vuelta.
--   4. flight_status_record(rows): igual que 0099 + las columnas nuevas. Un
--      «unknown» después de un dato bueno del MISMO proveedor no lo borra; de
--      OTRO proveedor se pisa todo. El despegue, el origen y el fr24_id ya
--      sabidos no se pierden. Las ETA se van anotando en eta_log (las últimas 40).
--   5. purge_flight_statuses() + pg_cron diario: borra los vuelos guardados hace
--      más de 28 días (FR24 permite 30) y los avisos de vuelo de la bandeja de esa
--      edad (su texto trae horas de FR24).
--   6. flight_eta_report(): por cada llegada que aterrizó, el error de la ETA a
--      60/30/15 min del aterrizaje, el retraso real y los créditos. Para medir
--      unas semanas y decidir si se automatiza algo. Solo desde el editor SQL.
--   7. poll_flight_status(): igual que 0099, con 2 min de espera para pg_net (una
--      corrida con varias peticiones a FR24 puede pasar de 30 s).
--
-- QUÉ NO CAMBIA: flight_delay_alerts (0107) avisa igual —«Vuelo AV9563 aterriza
-- 14:35 (25 min tarde). Recogida sugerida 14:50»— a los jefes de la organización
-- y al conductor de la ruta publicada, y NO mueve required_arrival_at. Sin
-- cancelaciones de FR24, el aviso «cancelado» ya no sale; «desviado» sí.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. No toca la 0099 ni la
-- 0117 (avisos desde el servidor, otra rama). Down: down_migrations/0118_vuelos_flightradar24.down.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. flight_statuses
-- -----------------------------------------------------------------------------
ALTER TABLE public.flight_statuses DROP CONSTRAINT IF EXISTS flight_statuses_source_valid;
ALTER TABLE public.flight_statuses ADD CONSTRAINT flight_statuses_source_valid
  CHECK (source IN ('flightradar24', 'aerodatabox', 'mock', 'manual'));
ALTER TABLE public.flight_statuses ALTER COLUMN source SET DEFAULT 'flightradar24';

ALTER TABLE public.flight_statuses
  ADD COLUMN IF NOT EXISTS departed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS origin_icao      text,
  ADD COLUMN IF NOT EXISTS provider_ref     text,
  ADD COLUMN IF NOT EXISTS poll_mode        text,
  ADD COLUMN IF NOT EXISTS provider_credits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eta_log          jsonb   NOT NULL DEFAULT '[]'::jsonb;

DO $do$
BEGIN
  ALTER TABLE public.flight_statuses ADD CONSTRAINT flight_statuses_poll_mode_valid
    CHECK (poll_mode IS NULL OR poll_mode IN ('summary', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

COMMENT ON TABLE public.flight_statuses IS
  'Último estado conocido de un vuelo de LLEGADA (0099, Flightradar24 desde 0118). Una fila por organización + código + día local de la reserva + sentido. La escribe solo la Edge Function flight-status (llave de servicio). status: scheduled (FR24 lo ve en tierra en el origen) · in_air · landed · diverted · unknown (FR24 no lo tiene: todavía no transmite o el número no es el suyo). Datos de FR24: se purgan a los 28 días (purge_flight_statuses).';
COMMENT ON COLUMN public.flight_statuses.sched_at IS
  'Con FR24 (sin horarios): la hora de la RESERVA (en una llegada, la hora de aterrizaje que escribió el tripulante). delay_min = (actual_at o estimated_at) − sched_at.';
COMMENT ON COLUMN public.flight_statuses.departed_at IS 'Despegue real en el origen (FR24 datetime_takeoff; o first_seen si FR24 no captó el despegue).';
COMMENT ON COLUMN public.flight_statuses.provider_ref IS 'fr24_id del tramo. Con él se pregunta exacto (flight_ids) en vez de por número y fechas.';
COMMENT ON COLUMN public.flight_statuses.provider_credits IS 'Créditos de FR24 que ha costado este vuelo (estimado por la Edge Function; las respuestas vacías no se cargan a ningún vuelo).';
COMMENT ON COLUMN public.flight_statuses.eta_log IS 'ETA que dio FR24 en cada consulta en vivo: [{at, eta}], las últimas 40. Para flight_eta_report.';

-- -----------------------------------------------------------------------------
-- 2. app_settings: alias de siglas y el texto de la bandera
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS flight_code_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_flight_code_aliases_object
    CHECK (jsonb_typeof(flight_code_aliases) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

COMMENT ON COLUMN public.app_settings.flight_code_aliases IS
  'Sigla de la reserva → siglas con que se le pregunta a Flightradar24 (0118). {"JA": ["J6"]} = JA5116 se pregunta como J65116; {"JA": ["JA","J6"]} = los dos en la misma petición. Vacío = se pregunta lo que escribió el tripulante. JetSmart es lo primero que hay que confirmar con el token real (docs/VUELOS.md).';
COMMENT ON COLUMN public.app_settings.flight_api_enabled IS
  'Estado de vuelos (0099; Flightradar24 desde 0118). false = no se consulta, no se avisa y la app no pinta estados. Encenderla requiere además FLIGHT_PROVIDER=fr24 + FR24_API_TOKEN en la Edge Function flight-status y el secreto flight_status_url en Vault (docs/VUELOS.md).';

-- -----------------------------------------------------------------------------
-- 3. Qué vuelos consultar ahora (solo llegadas, calendario de FR24)
--    Cambian las columnas que devuelve: hay que borrarla y crearla otra vez.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.flight_status_targets(timestamptz, integer);

CREATE FUNCTION public.flight_status_targets(
  p_now   timestamptz DEFAULT now(),
  p_limit integer     DEFAULT 45
)
RETURNS TABLE (
  organization_id uuid,
  flight_code     text,
  flight_date     date,
  direction       public.trip_direction,
  ref_at          timestamptz,   -- la hora de aterrizaje de la reserva más temprana del grupo
  reservations    integer,
  last_fetched_at timestamptz,
  last_status     text,
  mode            text,          -- 'summary' («¿ya despegó?» / «¿ya aterrizó?») | 'live' (la ETA)
  provider_ref    text,          -- fr24_id si ya se sabe
  departed_at     timestamptz,
  estimated_at    timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cfg AS (
    SELECT coalesce((SELECT a.flight_api_enabled FROM public.app_settings a WHERE a.id = 'singleton'), false) AS enabled,
           (p_now AT TIME ZONE 'America/Bogota')::date AS hoy
  ),
  res AS (
    SELECT pa.organization_id, r.flight_code, r.required_arrival_at,
           (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date AS dia
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pa          ON pa.id = ap.profile_id
      CROSS JOIN cfg
     WHERE cfg.enabled
       AND r.direction = 'airport_to_home'
       AND r.cancelled_at IS NULL
       AND coalesce(r.ground_ops, false) = false
       -- Ya en tierra con el conductor (o entregado): el vuelo aterrizó.
       AND coalesce(r.status_a2h::text, '') NOT IN
           ('landed', 'disembarking', 'picked_up', 'en_route_home', 'delivered', 'cancelled')
       -- Con sigla: un «5116» pelado no se le puede preguntar a nadie.
       AND r.flight_code ~ '^[A-Z]{1,3}[0-9]{2,5}$'
       AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN cfg.hoy - 1 AND cfg.hoy + 1
       -- Desde 2 h antes de la hora de aterrizaje de la reserva (el supuesto de
       -- arriba) hasta 6 h después.
       AND r.required_arrival_at <= p_now + interval '120 minutes'
       AND r.required_arrival_at >= p_now - interval '6 hours'
  ),
  grp AS (
    SELECT res.organization_id, res.flight_code, res.dia,
           min(res.required_arrival_at) AS ref_at, count(*)::integer AS n
      FROM res
     GROUP BY res.organization_id, res.flight_code, res.dia
  ),
  st AS (
    SELECT g.organization_id, g.flight_code, g.dia, g.ref_at, g.n,
           fs.fetched_at, fs.status, fs.provider_ref, fs.departed_at, fs.estimated_at,
           CASE WHEN fs.departed_at IS NULL THEN 'summary'
                WHEN fs.estimated_at IS NOT NULL AND fs.estimated_at <= p_now + interval '5 minutes' THEN 'summary'
                ELSE 'live' END AS mode
      FROM grp g
      LEFT JOIN public.flight_statuses fs
             ON fs.organization_id = g.organization_id AND fs.flight_code = g.flight_code
            AND fs.flight_date = g.dia AND fs.direction = 'airport_to_home'
  )
  SELECT st.organization_id, st.flight_code, st.dia, 'airport_to_home'::public.trip_direction,
         st.ref_at, st.n, st.fetched_at, st.status,
         st.mode, st.provider_ref, st.departed_at, st.estimated_at
    FROM st
   WHERE coalesce(st.status, '') NOT IN ('landed', 'cancelled', 'diverted')
     AND (
           -- Sin despegar: hasta 3 h después de la hora de la reserva.
           (st.departed_at IS NULL AND st.ref_at >= p_now - interval '180 minutes')
           -- En el aire: hasta 2 h después de la última ETA (más allá se perdió el rastro).
        OR (st.departed_at IS NOT NULL AND coalesce(st.estimated_at, st.ref_at) >= p_now - interval '120 minutes')
         )
     -- El cron corre cada 15 min: «12 min» = en cada vuelta, «27» = una sí y una
     -- no, «57» = una de cada cuatro (el margen absorbe que la corrida tarda).
     AND (st.fetched_at IS NULL OR st.fetched_at <= p_now - CASE
           WHEN st.departed_at IS NULL AND st.ref_at >= p_now - interval '60 minutes' THEN interval '12 minutes'
           WHEN st.departed_at IS NULL THEN interval '27 minutes'
           WHEN st.mode = 'summary' THEN interval '12 minutes'
           -- Recién despegado: la primera ETA en la vuelta siguiente.
           WHEN st.estimated_at IS NULL THEN interval '12 minutes'
           WHEN st.estimated_at <= p_now + interval '60 minutes' THEN interval '12 minutes'
           ELSE interval '57 minutes' END)
   ORDER BY coalesce(st.estimated_at, st.ref_at), st.flight_code
   LIMIT greatest(coalesce(p_limit, 45), 0);
$$;

COMMENT ON FUNCTION public.flight_status_targets(timestamptz, integer) IS
  'Llegadas a consultar en Flightradar24 (0118): reservas activas con sigla desde 2 h antes de su hora de aterrizaje, agrupadas por organización+código+día. mode summary (antes del despegue y cuando la ETA ya llegó) o live (en el aire, por la ETA); cada 15 min, o cada hora si la ETA está a más de 60 min; se rinde 3 h después de la reserva si nunca despegó; nada que ya aterrizó o se desvió. Vacío si flight_api_enabled = false.';

-- -----------------------------------------------------------------------------
-- 4. Guardar lo que trajo la Edge Function
--    p_rows = [{organization_id, flight_code, flight_date, direction, sched_at,
--               estimated_at, actual_at, departed_at, status, delay_min,
--               terminal, gate, origin_icao, provider_ref, poll_mode, credits,
--               eta, source, raw, fetched_at?}, …]
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
    sched_at, estimated_at, actual_at, departed_at, status, delay_min, terminal, gate,
    origin_icao, provider_ref, poll_mode, provider_credits, eta_log,
    source, raw, fetched_at)
  SELECT (x->>'organization_id')::uuid,
         public.flight_code_normalize(x->>'flight_code'),
         (x->>'flight_date')::date,
         (x->>'direction')::public.trip_direction,
         (x->>'sched_at')::timestamptz,
         (x->>'estimated_at')::timestamptz,
         (x->>'actual_at')::timestamptz,
         (x->>'departed_at')::timestamptz,
         coalesce(nullif(x->>'status', ''), 'unknown'),
         (x->>'delay_min')::integer,
         nullif(x->>'terminal', ''),
         nullif(x->>'gate', ''),
         nullif(x->>'origin_icao', ''),
         nullif(x->>'provider_ref', ''),
         nullif(x->>'poll_mode', ''),
         greatest(coalesce((x->>'credits')::integer, 0), 0),
         CASE WHEN nullif(x->>'eta', '') IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(jsonb_build_object(
                     'at',  coalesce((x->>'fetched_at')::timestamptz, now()),
                     'eta', (x->>'eta')::timestamptz)) END,
         coalesce(nullif(x->>'source', ''), 'flightradar24'),
         coalesce(x->'raw', '{}'::jsonb),
         coalesce((x->>'fetched_at')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) x
  ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET
    fetched_at       = EXCLUDED.fetched_at,
    poll_mode        = EXCLUDED.poll_mode,
    provider_credits = fs.provider_credits + EXCLUDED.provider_credits,
    -- «No apareció» después de un dato bueno del MISMO proveedor: tuvo un mal
    -- rato; se anota la consulta y se conserva lo bueno. De OTRO proveedor se
    -- pisa todo: los términos de FR24 prohíben mezclar sus datos con otros.
    sched_at     = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.sched_at     ELSE EXCLUDED.sched_at     END,
    estimated_at = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.estimated_at ELSE EXCLUDED.estimated_at END,
    actual_at    = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.actual_at    ELSE EXCLUDED.actual_at    END,
    status       = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.status       ELSE EXCLUDED.status       END,
    delay_min    = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.delay_min    ELSE EXCLUDED.delay_min    END,
    terminal     = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.terminal     ELSE EXCLUDED.terminal     END,
    gate         = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.gate         ELSE EXCLUDED.gate         END,
    raw          = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.raw          ELSE EXCLUDED.raw          END,
    -- Lo que ya se supo de ESTE proveedor no se pierde por una consulta sin dato.
    departed_at  = CASE WHEN EXCLUDED.source = fs.source THEN coalesce(EXCLUDED.departed_at, fs.departed_at)   ELSE EXCLUDED.departed_at  END,
    origin_icao  = CASE WHEN EXCLUDED.source = fs.source THEN coalesce(EXCLUDED.origin_icao, fs.origin_icao)   ELSE EXCLUDED.origin_icao  END,
    provider_ref = CASE WHEN EXCLUDED.source = fs.source THEN coalesce(EXCLUDED.provider_ref, fs.provider_ref) ELSE EXCLUDED.provider_ref END,
    eta_log      = CASE WHEN EXCLUDED.source = fs.source
                        THEN (SELECT coalesce(jsonb_agg(t.e ORDER BY t.n), '[]'::jsonb)
                                FROM (SELECT e, n FROM jsonb_array_elements(fs.eta_log || EXCLUDED.eta_log) WITH ORDINALITY AS l(e, n)
                                       ORDER BY n DESC LIMIT 40) t)
                        ELSE EXCLUDED.eta_log END,
    source       = CASE WHEN EXCLUDED.status = 'unknown' AND fs.status <> 'unknown' AND EXCLUDED.source = fs.source THEN fs.source ELSE EXCLUDED.source END;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.flight_status_record(jsonb) IS
  'La Edge Function flight-status guarda aquí lo que trajo del proveedor (upsert por organización+código+día+sentido). Un unknown no pisa un dato bueno del mismo proveedor; uno de otro proveedor se pisa entero (0118). Suma créditos y anota las ETA en eta_log.';

-- -----------------------------------------------------------------------------
-- 5. Purga: nada de FR24 guardado más de 28 días (sus términos permiten 30)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_flight_statuses(p_keep_days integer DEFAULT 28)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Nunca más de 30 días, aunque alguien pida más.
  v_days integer := least(greatest(coalesce(p_keep_days, 28), 1), 30);
  v_cut  timestamptz;
  v_fs   integer;
  v_ob   integer;
BEGIN
  v_cut := now() - make_interval(days => v_days);
  DELETE FROM public.flight_statuses
   WHERE created_at < v_cut
      OR fetched_at < v_cut
      OR flight_date < (now() AT TIME ZONE 'America/Bogota')::date - v_days;
  GET DIAGNOSTICS v_fs = ROW_COUNT;
  -- Los avisos de vuelo llevan horas de FR24 en el texto.
  DELETE FROM public.notification_outbox
   WHERE dedupe_key LIKE 'flt:%' AND created_at < v_cut;
  GET DIAGNOSTICS v_ob = ROW_COUNT;
  RETURN format('vuelos borrados %s · avisos de vuelo borrados %s (más de %s días)', v_fs, v_ob, v_days);
END;
$$;

COMMENT ON FUNCTION public.purge_flight_statuses(integer) IS
  'Borra los estados de vuelo (y los avisos de vuelo de notification_outbox) de más de p_keep_days días (28 por defecto, nunca más de 30): los términos de Flightradar24 no permiten guardar sus datos más de 30 días. La llama pg_cron a diario (0118).';

-- -----------------------------------------------------------------------------
-- 6. ¿Qué tan exacta es la ETA? (para medir unas semanas antes de automatizar)
--    error = ETA que se tenía X min antes del aterrizaje − aterrizaje real.
--    Positivo = FR24 decía que llegaba más tarde de lo que llegó.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flight_eta_report(p_days integer DEFAULT 28)
RETURNS TABLE (
  flight_code     text,
  flight_date     date,
  origen          text,
  reserva         timestamptz,
  despego         timestamptz,
  aterrizo        timestamptz,
  retraso_min     integer,     -- aterrizaje real − hora de la reserva
  eta_60_err_min  integer,
  eta_30_err_min  integer,
  eta_15_err_min  integer,
  etas            integer,     -- cuántas ETA dio
  creditos        integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT fs.flight_code, fs.flight_date, fs.origin_icao, fs.sched_at, fs.departed_at, fs.actual_at,
         round(extract(epoch FROM fs.actual_at - fs.sched_at) / 60)::integer,
         (SELECT round(extract(epoch FROM (e->>'eta')::timestamptz - fs.actual_at) / 60)::integer
            FROM jsonb_array_elements(fs.eta_log) e
           WHERE (e->>'at')::timestamptz <= fs.actual_at - interval '60 minutes'
           ORDER BY (e->>'at')::timestamptz DESC LIMIT 1),
         (SELECT round(extract(epoch FROM (e->>'eta')::timestamptz - fs.actual_at) / 60)::integer
            FROM jsonb_array_elements(fs.eta_log) e
           WHERE (e->>'at')::timestamptz <= fs.actual_at - interval '30 minutes'
           ORDER BY (e->>'at')::timestamptz DESC LIMIT 1),
         (SELECT round(extract(epoch FROM (e->>'eta')::timestamptz - fs.actual_at) / 60)::integer
            FROM jsonb_array_elements(fs.eta_log) e
           WHERE (e->>'at')::timestamptz <= fs.actual_at - interval '15 minutes'
           ORDER BY (e->>'at')::timestamptz DESC LIMIT 1),
         jsonb_array_length(fs.eta_log),
         fs.provider_credits
    FROM public.flight_statuses fs
   WHERE fs.source = 'flightradar24'
     AND fs.direction = 'airport_to_home'
     AND fs.status = 'landed'
     AND fs.actual_at IS NOT NULL
     AND fs.flight_date >= (now() AT TIME ZONE 'America/Bogota')::date - greatest(coalesce(p_days, 28), 0)
   ORDER BY fs.flight_date, fs.actual_at;
$$;

COMMENT ON FUNCTION public.flight_eta_report(integer) IS
  'Por cada llegada que aterrizó (Flightradar24): retraso real contra la reserva y error de la ETA que se tenía 60/30/15 min antes del aterrizaje (positivo = FR24 la daba más tarde). Solo desde el editor SQL (0118).';

-- -----------------------------------------------------------------------------
-- 7. El disparo: igual que 0099, con 2 min de espera para pg_net
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
      timeout_milliseconds := 120000
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
-- 8. Permisos: todo esto es del servidor
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)',
    'public.purge_flight_statuses(integer)',
    'public.flight_eta_report(integer)',
    'public.poll_flight_status()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- La Edge Function entra con la llave de servicio.
  FOREACH f IN ARRAY ARRAY[
    'public.flight_status_targets(timestamptz, integer)',
    'public.flight_status_record(jsonb)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 9. El reloj de la purga: a diario, 03:20 de Bogotá (08:20 UTC)
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('purge-flight-statuses');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.schedule('purge-flight-statuses', '20 8 * * *', $job$SELECT public.purge_flight_statuses();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): la purga de vuelos queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
