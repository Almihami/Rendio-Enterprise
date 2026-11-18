-- Down de 0177 · Chats de tripulantes con conductores, por turno.
-- Quita la lista por turno, la purga y su tarea programada. Los mensajes que ya
-- se borraron no vuelven (no hay de dónde).
BEGIN;
DO $$
BEGIN
  PERFORM cron.unschedule('purge-reservation-chat');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'sin tarea purge-reservation-chat (%)', SQLERRM;
END
$$;
DROP FUNCTION IF EXISTS public.purge_reservation_messages();
DROP FUNCTION IF EXISTS public.admin_chats_conductores(integer);
DROP INDEX IF EXISTS public.reservation_messages_res_created_idx;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_reservation_chat_keep_days_range;
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS reservation_chat_keep_days;
NOTIFY pgrst, 'reload schema';
COMMIT;
