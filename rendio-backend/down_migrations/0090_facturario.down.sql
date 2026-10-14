-- =============================================================================
-- DOWN de 0090 — Facturario
--
-- OJO: BORRA DATOS. Se pierden las cuentas de cobro de cada tripulante, las
-- cuentas de cobro por período, los comprobantes (sus filas), los pagos, los
-- avisos y los métodos de pago de la organización. Los avisos ya encolados en
-- notification_outbox quedan (son de 0063) y se envían igual.
--
-- Los ARCHIVOS del bucket `payment-proofs` NO se borran desde SQL (Storage lo
-- prohíbe a propósito). El bucket solo se elimina si está vacío; si tiene
-- archivos, queda con sus políticas quitadas (nadie lo lee desde la app) y hay
-- que vaciarlo desde el panel de Storage.
-- =============================================================================

BEGIN;

DO $do$
BEGIN
  PERFORM cron.unschedule('billing-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DROP TRIGGER IF EXISTS tr_reservations_pause_by_billing ON public.reservations;

DROP POLICY IF EXISTS p_payment_proofs_insert_aux ON storage.objects;
DROP POLICY IF EXISTS p_payment_proofs_select ON storage.objects;

DO $do$
BEGIN
  -- Storage protege el borrado directo; solo se abre la puerta (en esta
  -- transacción) para borrar el bucket VACÍO.
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payment-proofs') THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
  END IF;
  DELETE FROM storage.buckets b
   WHERE b.id = 'payment-proofs'
     AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payment-proofs');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo borrar el bucket payment-proofs (%): queda sin políticas.', SQLERRM;
END
$do$;

DROP FUNCTION IF EXISTS public.admin_billing_proofs(text);
DROP FUNCTION IF EXISTS public.admin_billing_mark_paid(uuid, text, integer, date, text);
DROP FUNCTION IF EXISTS public.admin_billing_review_proof(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.billing_settle(uuid, text, uuid, integer, text, date, text);
DROP FUNCTION IF EXISTS public.admin_billing_adjust_statement(uuid, integer, integer, text);
DROP FUNCTION IF EXISTS public.admin_billing_open_statement(uuid, date);
DROP FUNCTION IF EXISTS public.admin_billing_save_account(uuid, integer, smallint, smallint, smallint, smallint, boolean, integer, date);
DROP FUNCTION IF EXISTS public.admin_billing_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_billing_list();
DROP FUNCTION IF EXISTS public.billing_assert_admin_of(uuid);
DROP FUNCTION IF EXISTS public.aux_billing_mark_seen();
DROP FUNCTION IF EXISTS public.aux_billing_set_prefs(boolean, boolean);
DROP FUNCTION IF EXISTS public.aux_billing_submit_proof(uuid, text, text, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.aux_billing_history();
DROP FUNCTION IF EXISTS public.aux_billing_my_account();
DROP FUNCTION IF EXISTS public.guard_billing_pause();
DROP FUNCTION IF EXISTS public.billing_run_daily(date);
DROP FUNCTION IF EXISTS public.billing_open_statement(uuid, date, date);
DROP FUNCTION IF EXISTS public.billing_block_if_due(uuid, date, boolean);
DROP FUNCTION IF EXISTS public.billing_emit(public.billing_statements, text, date, jsonb, uuid, boolean);
DROP FUNCTION IF EXISTS public.billing_alert_text(text, public.billing_statements, jsonb);
DROP FUNCTION IF EXISTS public.billing_refresh_pause(uuid, date);
DROP FUNCTION IF EXISTS public.billing_is_paused(uuid, date);
DROP FUNCTION IF EXISTS public.billing_statement_json(public.billing_statements, date);
DROP FUNCTION IF EXISTS public.billing_statement_base(public.billing_statements, date);
DROP FUNCTION IF EXISTS public.billing_statement_blocked(public.billing_statements, date);

DROP TABLE IF EXISTS public.billing_job_runs;
DROP TABLE IF EXISTS public.billing_alerts;
DROP TABLE IF EXISTS public.billing_payments;
DROP TABLE IF EXISTS public.billing_proofs;
DROP TABLE IF EXISTS public.billing_statements;
DROP TABLE IF EXISTS public.auxiliar_billing;
DROP TABLE IF EXISTS public.billing_payment_methods;
DROP TABLE IF EXISTS public.billing_settings;
DROP SEQUENCE IF EXISTS public.billing_reference_seq;

DROP FUNCTION IF EXISTS public.billing_reject_reasons();
DROP FUNCTION IF EXISTS public.billing_next_cut(date, int);
DROP FUNCTION IF EXISTS public.billing_last_cut(date, int);
DROP FUNCTION IF EXISTS public.billing_cut_date(int, int, int);
DROP FUNCTION IF EXISTS public.billing_pl(int, text, text);
DROP FUNCTION IF EXISTS public.billing_month_name(date);
DROP FUNCTION IF EXISTS public.billing_fmt(date);
DROP FUNCTION IF EXISTS public.billing_money(numeric);
DROP FUNCTION IF EXISTS public.billing_today();

COMMIT;
