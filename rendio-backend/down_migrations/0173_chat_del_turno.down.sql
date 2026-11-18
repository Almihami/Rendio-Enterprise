-- Deshace 0173: quita el chat del turno (funciones, tabla y el ajuste de días).
-- OJO: borra los mensajes guardados.

BEGIN;

DROP FUNCTION IF EXISTS public.shift_chat_history(integer);
DROP FUNCTION IF EXISTS public.shift_chat_unread();
DROP FUNCTION IF EXISTS public.shift_chat_mark_read();
DROP FUNCTION IF EXISTS public.shift_chat_send(text);
DROP FUNCTION IF EXISTS public.shift_chat_list(date, text);
DROP FUNCTION IF EXISTS public.shift_chat_desde(date, text);
DROP FUNCTION IF EXISTS public.shift_chat_ctx();
DROP TABLE IF EXISTS public.shift_chat_messages;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_shift_chat_keep_days_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS shift_chat_keep_days;

COMMIT;
