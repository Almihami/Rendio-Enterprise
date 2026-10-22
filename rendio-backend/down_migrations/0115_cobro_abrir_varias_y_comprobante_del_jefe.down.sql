-- Down de 0115: quita las funciones nuevas y la política de subida del jefe.
-- Los comprobantes que el jefe ya subió quedan (son comprobantes aprobados como
-- cualquier otro) y las cuentas de cobro abiertas o con «plazo desde hoy» no se tocan.
BEGIN;
DROP FUNCTION IF EXISTS public.admin_billing_mark_paid_with_proof(uuid, text, text, integer, text, integer, date, text);
DROP FUNCTION IF EXISTS public.admin_billing_open_statements(uuid[], boolean, boolean);
DROP FUNCTION IF EXISTS public.admin_billing_restart_terms(uuid);
DROP FUNCTION IF EXISTS public.billing_restart_terms(uuid, date, boolean);
DROP POLICY IF EXISTS p_payment_proofs_insert_admin ON storage.objects;
COMMIT;
