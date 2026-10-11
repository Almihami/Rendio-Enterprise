-- =============================================================================
-- DOWN de 0096 — Retención de fotos
--
-- Quita los dos relojes, las funciones y las dos columnas. OJO: los archivos que
-- la purga ya borró NO vuelven (están en el respaldo, si se corrió
-- scripts/_respaldo-fotos.mjs antes); lo único que se pierde aquí es la
-- constancia purged_at de qué fila apunta a un archivo que ya no existe, y el
-- número de días que el jefe había puesto en Ajustes.
-- Las filas que purge_cron_history ya borró de cron.job_run_details tampoco
-- vuelven (era historial de corridas, nada de la operación).
-- =============================================================================

DO $do$
BEGIN
  PERFORM cron.unschedule('purge-old-photos');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.unschedule('purge-cron-history');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

BEGIN;

DROP FUNCTION IF EXISTS public.run_photo_purge();
DROP FUNCTION IF EXISTS public.purge_cron_history(int);
DROP FUNCTION IF EXISTS public.mark_photos_purged(uuid[]);
DROP FUNCTION IF EXISTS public.photo_purge_candidates(int, int);
DROP FUNCTION IF EXISTS public._photo_purge_guard();
DROP FUNCTION IF EXISTS public._checklist_has_issue(jsonb);

ALTER TABLE public.inspection_photos DROP COLUMN IF EXISTS purged_at;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_photo_retention_days_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS photo_retention_days;

COMMIT;
