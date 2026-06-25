-- =============================================================================
-- Migration 0014 — app_settings.reopen_week_start / reopen_until
-- Tarea: módulo rendio-turnos — "reapertura" temporal de la disponibilidad.
--   Si muchos conductores no llenaron antes del corte (domingo 6:30 PM), el
--   admin puede reabrir esa semana por 2 horas para que TODOS corrijan.
--
--   reopen_week_start = lunes de la semana reabierta (date).
--   reopen_until      = instante (timestamptz) hasta el que está reabierta.
--   Mientras now() < reopen_until y la semana == reopen_week_start, esa semana
--   cuenta como ABIERTA (se levanta el candado del conductor y el generador
--   no excluye a nadie). Ambas NULL = sin reapertura activa.
--
--   Vive en app_settings (singleton) porque ya lo leen todos los clientes vía
--   getSettings → la reapertura es visible para todos sin esquema nuevo extra.
--
-- RLS: SELECT/UPDATE de app_settings ya cubiertos por las policies existentes
-- (lectura autenticada; update admin). No se añade policy.
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS reopen_week_start date NULL,
  ADD COLUMN IF NOT EXISTS reopen_until      timestamptz NULL;

COMMENT ON COLUMN public.app_settings.reopen_week_start
  IS 'rendio-turnos: lunes (date) de la semana cuya disponibilidad fue reabierta temporalmente por el admin. NULL = sin reapertura.';
COMMENT ON COLUMN public.app_settings.reopen_until
  IS 'rendio-turnos: instante hasta el que la semana reopen_week_start cuenta como abierta (típicamente ahora + 2h). NULL = sin reapertura.';

COMMIT;
