-- Down de 0052 — quita el chat entre auxiliar y conductor.
-- OJO: borra las conversaciones. Si se revierte con datos reales encima, se
-- pierde la constancia de lo que se dijo en los traslados.
BEGIN;

DROP FUNCTION IF EXISTS public.mark_reservation_messages_read(uuid);
DROP FUNCTION IF EXISTS public.send_reservation_message(uuid, text);
DROP TABLE    IF EXISTS public.reservation_messages;   -- las policies se van con la tabla
DROP FUNCTION IF EXISTS public.can_use_reservation_chat(uuid);

COMMIT;
