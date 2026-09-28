-- =============================================================================
-- 0086 · Datos del viaje que pide el rediseño del auxiliar
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P9.
--
-- Columnas nuevas (todas opcionales; nada de lo que ya existe cambia):
--
--   reservations.quiet_ride      boolean NOT NULL DEFAULT false
--       «Prefiero silencio» (D4). Solo tiene sentido en un privado: el CHECK
--       reservations_quiet_only_private lo exige. Un privado RECHAZADO sigue
--       siendo service_level='private' (0069), así que el rechazo no choca.
--   reservations.bags            smallint 0..3 (NULL = no lo dijo)
--   reservations.meet_code       text '^[0-9]{4}$'
--       Código de encuentro: el conductor se lo pide al tripulante («Pídele el
--       código: 4827»). Lo genera la base al insertar; el teléfono no lo elige.
--   reservations.meeting_point   text ≤ 120 («portería 2», «frente al Éxito»)
--   auxiliar_profiles.preferred_service_level  service_level (NULL = sin preferencia)
--   auxiliar_profiles.meeting_point            text ≤ 120
--   vehicles.color               text ≤ 30 (lo carga el jefe en Flota)
--
-- public.notes_without_flight(text): gemela SQL de Api.notesUser (api.js). Misma
-- expresión: quita el «Vuelo AV9412. » del principio y el « · Regreso del mismo
-- día» del final. La usan 0087 (notes_user) y 0089 (cambió mi vuelo).
--
-- Trigger BEFORE INSERT tr_reservations_trip_extras (función
-- reservation_trip_extras):
--   · meet_code: siempre lo pone la base si el que inserta es un tripulante (o
--     si vino vacío). 4 dígitos al azar: no es un secreto, es para reconocerse
--     en la acera.
--   · meeting_point: si el pedido no trae uno y sale del MISMO conjunto
--     principal del perfil, hereda el del perfil. Desde otro conjunto o desde
--     un pin manual no se hereda: «portería 2» es de SU conjunto.
--   El nombre ordena DESPUÉS de tr_reservations_fill_pickup (Postgres dispara
--   los BEFORE por orden alfabético), así ve residence_id ya resuelto.
--   Es un trigger APARTE a propósito: no se reescribe fill_reservation_pickup
--   de 0083 (ya en dev) y el down no tiene que restaurar nada.
--
-- Relleno: meet_code para reservas futuras (desde ayer) no canceladas.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS antes de cada
-- ADD CONSTRAINT; CREATE OR REPLACE; DROP TRIGGER IF EXISTS antes de CREATE.
-- Down: down_migrations/0086_aux_datos_del_viaje.down.sql (PIERDE los datos de
-- estas columnas: avisar antes de correrlo en un ambiente con uso real).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columnas
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS quiet_ride    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bags          smallint,
  ADD COLUMN IF NOT EXISTS meet_code     text,
  ADD COLUMN IF NOT EXISTS meeting_point text;

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_bags_range;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_bags_range
  CHECK (bags IS NULL OR bags BETWEEN 0 AND 3);
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meet_code_format;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_meet_code_format
  CHECK (meet_code IS NULL OR meet_code ~ '^[0-9]{4}$');
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meeting_point_len;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_meeting_point_len
  CHECK (meeting_point IS NULL OR length(meeting_point) <= 120);
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_quiet_only_private;
ALTER TABLE public.reservations ADD  CONSTRAINT reservations_quiet_only_private
  CHECK (NOT quiet_ride OR service_level = 'private');

COMMENT ON COLUMN public.reservations.quiet_ride IS
  'Prefiere silencio (solo privado). Lo ve el conductor en su ruta. 0086.';
COMMENT ON COLUMN public.reservations.bags IS
  'Maletas que dijo el tripulante (0..3). NULL = no lo dijo. 0086.';
COMMENT ON COLUMN public.reservations.meet_code IS
  'Código de encuentro de 4 dígitos, lo genera la base al insertar. 0086.';
COMMENT ON COLUMN public.reservations.meeting_point IS
  'Punto de encuentro en texto libre (portería, torre). 0086.';

ALTER TABLE public.auxiliar_profiles
  ADD COLUMN IF NOT EXISTS preferred_service_level public.service_level,
  ADD COLUMN IF NOT EXISTS meeting_point text;
ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_meeting_point_len;
ALTER TABLE public.auxiliar_profiles ADD  CONSTRAINT auxiliar_profiles_meeting_point_len
  CHECK (meeting_point IS NULL OR length(meeting_point) <= 120);

COMMENT ON COLUMN public.auxiliar_profiles.preferred_service_level IS
  'Nivel que prefiere (preselecciona el paso Nivel del pedido). NULL = sin preferencia. 0086.';
COMMENT ON COLUMN public.auxiliar_profiles.meeting_point IS
  'Punto de encuentro habitual en su conjunto principal; lo heredan sus reservas. 0086.';

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_color_len;
ALTER TABLE public.vehicles ADD  CONSTRAINT vehicles_color_len
  CHECK (color IS NULL OR length(color) <= 30);

COMMENT ON COLUMN public.vehicles.color IS 'Color del carro (lo ve el tripulante para reconocerlo). 0086.';

-- ---------------------------------------------------------------------------
-- 2. notes_without_flight: gemela de Api.notesUser (api.js)
-- ---------------------------------------------------------------------------
-- JS:  .replace(/^\s*vuelo\s*:?\s*[A-Za-z]{0,3}\s*-?\s*\d{2,5}\.\s*/i, '')
--      .replace(/\s*·\s*Regreso del mismo día\s*$/i, '')
--      .trim()
-- NULL → '' (igual que el helper JS, que hace String(n || '')).
CREATE OR REPLACE FUNCTION public.notes_without_flight(p_notes text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(coalesce(p_notes, ''),
               '^\s*vuelo\s*:?\s*[A-Za-z]{0,3}\s*-?\s*[0-9]{2,5}\.\s*', '', 'i'),
             '\s*·\s*Regreso del mismo día\s*$', '', 'i'),
           '^\s+|\s+$', '', 'g');
$$;

COMMENT ON FUNCTION public.notes_without_flight(text) IS
  'Lo que escribió el tripulante en las notas, sin el vuelo ni la marca de regreso que pega la app. Gemela de Api.notesUser. 0086.';

-- ---------------------------------------------------------------------------
-- 3. Trigger: código de encuentro y punto de encuentro heredado
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reservation_trip_extras()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ap public.auxiliar_profiles%ROWTYPE;
BEGIN
  -- El código lo pone la base. Un admin (o un script) que ya trae uno válido lo
  -- conserva; un tripulante no puede elegir el suyo.
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

DROP TRIGGER IF EXISTS tr_reservations_trip_extras ON public.reservations;
CREATE TRIGGER tr_reservations_trip_extras
  BEFORE INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.reservation_trip_extras();

-- ---------------------------------------------------------------------------
-- 4. Relleno del código para lo que viene (el historial no lo necesita)
-- ---------------------------------------------------------------------------
-- RELLENO:INICIO
UPDATE public.reservations
   SET meet_code = lpad(floor(random() * 10000)::int::text, 4, '0')
 WHERE meet_code IS NULL
   AND cancelled_at IS NULL
   AND required_arrival_at >= now() - interval '1 day';
-- RELLENO:FIN

COMMIT;
