-- =============================================================================
-- DOWN de 0095 — Documentos del carro
--
-- OJO: BORRA DATOS. Se pierden los números, las entidades, las notas, los «No
-- aplica» y las fechas del seguro RCC/RCE, el impuesto y el extintor (no tienen
-- columna en vehicles). El SOAT, la técnico-mecánica y el seguro todo riesgo NO
-- se pierden: vehicles.soat/tecnomec/insurance_expires_at eran su espejo y se
-- quedan con la última fecha guardada. Los avisos ya encolados en
-- notification_outbox quedan (son de 0063) y se envían igual.
-- =============================================================================

BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule('vehicle-docs-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP TRIGGER IF EXISTS tr_vehicles_to_documents ON public.vehicles;
DROP TRIGGER IF EXISTS tr_vehicle_documents_to_vehicle ON public.vehicle_documents;

DROP FUNCTION IF EXISTS public.vehicle_docs_run_daily(date);
DROP FUNCTION IF EXISTS public.driver_vehicle_documents(uuid[]);
DROP FUNCTION IF EXISTS public.save_vehicle_document(uuid, text, date, text, text, text, boolean);
DROP FUNCTION IF EXISTS public.vehicle_to_documents();
DROP FUNCTION IF EXISTS public.vehicle_doc_mirror_in(uuid, uuid, text, date);
DROP FUNCTION IF EXISTS public.vehicle_documents_to_vehicle();

DROP TABLE IF EXISTS public.vehicle_document_job_runs;
DROP TABLE IF EXISTS public.vehicle_document_alerts;
DROP TABLE IF EXISTS public.vehicle_documents;

DROP FUNCTION IF EXISTS public.vehicle_doc_stage(integer, integer);
DROP FUNCTION IF EXISTS public.vehicle_doc_fmt(date);
DROP FUNCTION IF EXISTS public.vehicle_document_label(text);
DROP FUNCTION IF EXISTS public.vehicle_document_kinds();
DROP FUNCTION IF EXISTS public.vehicle_docs_today();

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_vehicle_doc_alert_days_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS vehicle_doc_alert_days;

COMMIT;
