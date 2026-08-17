-- =============================================================================
-- Migration 0065 — driver_availability: 'unset' pasa a ser el punto de partida
-- Tarea: rediseño de Disponibilidad del conductor (2026-08-16), Modelo A.
-- Depende de la 0064, que crea el valor 'unset' en el enum.
--
-- Qué hace:
--   1. DEFAULT de am_state/pm_state: 'available' → 'unset'. Una fila creada sin
--      estado explícito ya no significa "puedo trabajar", significa "no respondí".
--   2. Documenta las columnas.
--
-- Qué NO hace, a propósito:
--   · NO reescribe filas históricas. Las semanas ya guardadas conservan sus
--     'available' explícitos: eso fue una respuesta real del conductor en su
--     momento y reinterpretarla ahora falsearía el histórico (y el Balance, que
--     compara publicado vs trabajado, lee de ahí).
--   · NO toca el trigger sync_approval_requests() de la 0009: su rama final ya
--     trata a 'unset' correctamente (borra la solicitud de esa jornada).
--   · NO elimina shift_pref. El rediseño deja de escribirla (la fila
--     "Prefiero AM/PM/Indistinto" desapareció de la UI), pero la columna y el
--     sesgo suave del generador se quedan: quitarlos es una decisión aparte y
--     habría que migrar los datos que ya están.
--
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.driver_availability ALTER COLUMN am_state SET DEFAULT 'unset';
ALTER TABLE public.driver_availability ALTER COLUMN pm_state SET DEFAULT 'unset';

COMMENT ON COLUMN public.driver_availability.am_state
  IS 'rendio-turnos: jornada de la mañana. unset = el conductor no respondió (no entra a la generación) · available = puede trabajar · prefer_rest = preferiría no (preferencia blanda) · unavailable = no puede (bloqueo duro, exige motivo y crea solicitud).';
COMMENT ON COLUMN public.driver_availability.pm_state
  IS 'rendio-turnos: jornada de la tarde. Mismos valores que am_state.';

COMMIT;
