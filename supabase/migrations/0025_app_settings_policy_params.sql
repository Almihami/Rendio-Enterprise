-- =============================================================================
-- Migration 0025 — app_settings: parámetros de política parametrizables
-- Tarea: módulo rendio-turnos — sacar reglas hardcodeadas del código y dejar
--   que el admin las configure desde Ajustes.
--
--   coord_slots = nº de coordinadores requeridos por jornada (AM y PM).
--                 Antes hardcode COORD_SLOTS=1 en scheduler.js.
--   shift_hours = horas que cuenta cada turno en el Balance.
--                 Antes hardcode 12 repetido en app.js.
--
--   Viven en app_settings (singleton) porque ya lo leen todos los clientes vía
--   getSettings. El front tolera que estas columnas no existan (usa defaults
--   1 y 12), así que aplicar esta migración es seguro y aditivo.
--
-- RLS: SELECT/UPDATE de app_settings ya cubiertos por policies existentes.
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS coord_slots smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shift_hours smallint NOT NULL DEFAULT 12;

COMMENT ON COLUMN public.app_settings.coord_slots
  IS 'rendio-turnos: nº de coordinadores requeridos por jornada (AM y PM). Default 1.';
COMMENT ON COLUMN public.app_settings.shift_hours
  IS 'rendio-turnos: horas que cuenta cada turno en el Balance. Default 12.';

COMMIT;
