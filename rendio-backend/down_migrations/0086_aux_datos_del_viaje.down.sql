-- Revierte 0086 (datos del viaje del rediseño del auxiliar).
--
-- OJO: PIERDE DATOS. Borra las columnas quiet_ride, bags, meet_code y
-- meeting_point de reservations; preferred_service_level y meeting_point de
-- auxiliar_profiles; y color de vehicles. Lo que los tripulantes y el jefe
-- hayan cargado ahí no vuelve al re-aplicar 0086 (los códigos de encuentro sí
-- se regeneran, con otros números).
--
-- Correr ANTES los downs de 0089 y 0087, que usan notes_without_flight y estas
-- columnas. El front degrada solo: api.js y api-aux.js piden estas columnas en
-- un escalón propio y, si faltan, siguen sin ellas.

BEGIN;

DROP TRIGGER IF EXISTS tr_reservations_trip_extras ON public.reservations;
DROP FUNCTION IF EXISTS public.reservation_trip_extras();
DROP FUNCTION IF EXISTS public.notes_without_flight(text);

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_quiet_only_private;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_bags_range;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meet_code_format;
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meeting_point_len;
ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS quiet_ride,
  DROP COLUMN IF EXISTS bags,
  DROP COLUMN IF EXISTS meet_code,
  DROP COLUMN IF EXISTS meeting_point;

ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_meeting_point_len;
ALTER TABLE public.auxiliar_profiles
  DROP COLUMN IF EXISTS preferred_service_level,
  DROP COLUMN IF EXISTS meeting_point;

ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_color_len;
ALTER TABLE public.vehicles DROP COLUMN IF EXISTS color;

COMMIT;
