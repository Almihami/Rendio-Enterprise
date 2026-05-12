-- Rollback Migration 0005. Referencia. NO automático.
BEGIN;

-- Triggers
DROP TRIGGER  IF EXISTS tr_route_assignments_audit_created ON public.route_assignments;
DROP TRIGGER  IF EXISTS tr_reservations_audit_created ON public.reservations;

-- Trigger functions
DROP FUNCTION IF EXISTS public.tg_audit_route_assigned();
DROP FUNCTION IF EXISTS public.tg_audit_reservation_created();

-- SECURITY DEFINER functions
DROP FUNCTION IF EXISTS public.recompute_route(uuid);
DROP FUNCTION IF EXISTS public.confirm_disembarkation(uuid, text);
DROP FUNCTION IF EXISTS public.cancel_reservation(uuid, text);
DROP FUNCTION IF EXISTS public.mark_passenger_delivered(uuid);
DROP FUNCTION IF EXISTS public.mark_passenger_on_board(uuid);
DROP FUNCTION IF EXISTS public.mark_passenger_arrived(uuid);
DROP FUNCTION IF EXISTS public.mark_route_started(uuid);

-- Helpers
DROP FUNCTION IF EXISTS public.log_audit_event(text, text, uuid, jsonb);

-- Tabla
DROP POLICY   IF EXISTS p_audit_events_select_admin ON public.audit_events;
DROP TABLE    IF EXISTS public.audit_events CASCADE;

COMMIT;
