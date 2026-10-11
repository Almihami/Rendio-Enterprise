-- =============================================================================
-- DOWN de 0099 — Estado de vuelos
--
-- OJO: BORRA DATOS. Se pierde el historial de estados de vuelo (flight_statuses)
-- y la columna reservations.flight_code (se puede reconstruir: sale de las notas,
-- que no se tocan). Los avisos de vuelo ya encolados en notification_outbox
-- quedan (la tabla es de 0063) y se envían igual.
-- =============================================================================

BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule('poll-flight-status');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP FUNCTION IF EXISTS public.poll_flight_status();
DROP FUNCTION IF EXISTS public.flight_delay_alerts(timestamptz);
DROP FUNCTION IF EXISTS public.flight_status_record(jsonb);
DROP FUNCTION IF EXISTS public.flight_status_targets(timestamptz, integer);
DROP FUNCTION IF EXISTS public.flight_deplane_min(text);

DROP TABLE IF EXISTS public.flight_statuses;

DROP TRIGGER IF EXISTS tr_reservations_flight_code ON public.reservations;
DROP FUNCTION IF EXISTS public.backfill_reservation_flight_codes();
DROP FUNCTION IF EXISTS public.tg_reservations_flight_code();
DROP FUNCTION IF EXISTS public.reservation_flight_code(uuid, text);
DROP FUNCTION IF EXISTS public.flight_code_normalize(text);
DROP FUNCTION IF EXISTS public.flight_code_from_notes(text);

DROP INDEX IF EXISTS public.idx_reservations_flight_code;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_flight_code_format;
ALTER TABLE public.reservations DROP COLUMN IF EXISTS flight_code;

ALTER TABLE public.app_settings DROP COLUMN IF EXISTS flight_api_enabled;

COMMIT;
