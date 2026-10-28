-- Down de 0153: quita el registro de cambios y vuelve admin_create_reservation a la de 0139.
BEGIN;
DROP TRIGGER IF EXISTS tr_reservations_cambios_ins ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_cambios_upd ON public.reservations;
DROP FUNCTION IF EXISTS public.tg_reservations_cambios();
DROP FUNCTION IF EXISTS public.admin_cambios_tripulantes(timestamptz, timestamptz);
DROP TABLE IF EXISTS public.reservation_changes;
DROP FUNCTION IF EXISTS public.vuelo_de_notas(text);
DROP FUNCTION IF EXISTS public.admin_create_reservation(uuid, text, timestamptz, text, text, boolean);
COMMIT;
-- Después, volver a correr la sección 3 de 0139_externos_sin_app.sql (admin_create_reservation de 5 argumentos).
