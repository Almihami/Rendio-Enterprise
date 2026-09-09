-- Rollback de 0009_approval_requests.sql

BEGIN;

DROP TRIGGER IF EXISTS tr_driver_availability_sync_approvals ON public.driver_availability;
DROP FUNCTION IF EXISTS public.sync_approval_requests();
DROP FUNCTION IF EXISTS public.auto_resolve_weekend_singletons();

DROP POLICY IF EXISTS p_approval_requests_update_admin ON public.approval_requests;
DROP POLICY IF EXISTS p_approval_requests_select_self ON public.approval_requests;
DROP TRIGGER IF EXISTS tr_approval_requests_set_updated_at ON public.approval_requests;

DROP TABLE IF EXISTS public.approval_requests;

DROP TYPE IF EXISTS public.shift_period;
DROP TYPE IF EXISTS public.approval_state;

ALTER TABLE public.driver_availability
  DROP COLUMN IF EXISTS am_reason,
  DROP COLUMN IF EXISTS pm_reason;

COMMIT;
