-- Reversa de 0139 · externos sin app y pedidos del jefe.
-- OJO: NO borra a los externos que ya se crearon ni sus reservas (son traslados
-- reales). Solo quita la marca, las dos funciones y el candado del cobro: los que
-- existan quedan como tripulantes normales sin poder entrar.
BEGIN;

DROP TRIGGER IF EXISTS tr_auxiliar_billing_no_external ON public.auxiliar_billing;
DROP FUNCTION IF EXISTS public.guard_billing_external();
DROP FUNCTION IF EXISTS public.admin_create_reservation(uuid, text, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.admin_create_external(text, text, uuid, text);
ALTER TABLE public.auxiliar_profiles DROP COLUMN IF EXISTS external;

COMMIT;
