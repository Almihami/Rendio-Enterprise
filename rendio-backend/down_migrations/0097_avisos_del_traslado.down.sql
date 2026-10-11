-- Reversa de 0097_avisos_del_traslado.sql. Los códigos de 2 dígitos que ya se
-- generaron se vuelven de 4 para que el CHECK de 0086 los acepte.
BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'detect-trip-reminders';
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP TRIGGER IF EXISTS tr_reservations_trip_status_notify ON public.reservations;
DROP FUNCTION IF EXISTS public.detect_trip_reminders();
DROP FUNCTION IF EXISTS public.driver_near_stop(uuid);
DROP FUNCTION IF EXISTS public.trip_near_notify(uuid);
DROP FUNCTION IF EXISTS public.driver_airport_no_show(uuid);
DROP FUNCTION IF EXISTS public.driver_mark_airport_arrival(uuid);
DROP FUNCTION IF EXISTS public.driver_board_with_code(uuid, text, boolean);
DROP FUNCTION IF EXISTS public._driver_trip_guard(uuid);
DROP FUNCTION IF EXISTS public.trip_status_notify();
DROP FUNCTION IF EXISTS public.trip_ctx(uuid);
DROP FUNCTION IF EXISTS public.trip_kick();
DROP FUNCTION IF EXISTS public.trip_notify(uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.trip_hora(timestamptz);
DROP INDEX IF EXISTS public.idx_notification_outbox_dedupe_all;

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_boarding_check_valid;
ALTER TABLE public.reservations DROP COLUMN IF EXISTS boarding_checked_at;
ALTER TABLE public.reservations DROP COLUMN IF EXISTS boarding_check;

UPDATE public.reservations SET meet_code = lpad(floor(random() * 10000)::int::text, 4, '0')
 WHERE meet_code IS NOT NULL AND length(meet_code) = 2;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meet_code_format;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_meet_code_format
  CHECK (meet_code IS NULL OR meet_code ~ '^[0-9]{4}$');

-- El trigger vuelve a generar 4 dígitos (cuerpo de 0086).
CREATE OR REPLACE FUNCTION public.reservation_trip_extras()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ap public.auxiliar_profiles%ROWTYPE;
BEGIN
  IF NEW.meet_code IS NULL OR public.current_user_role() = 'auxiliar' THEN
    NEW.meet_code := lpad(floor(random() * 10000)::int::text, 4, '0');
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

COMMIT;
