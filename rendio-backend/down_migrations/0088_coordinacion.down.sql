-- Revierte 0088 (Coordinación).
--
-- OJO: PIERDE DATOS. Borra la tabla crew_messages con todos los mensajes entre
-- los tripulantes y los jefes, y el teléfono y el horario de Coordinación de
-- app_settings. Avisar antes de correrlo en un ambiente con uso real.
--
-- El front degrada: ApiAux.crew* y getOpsContact devuelven null sin las RPC ni
-- las columnas, y la pantalla de Coordinación dice que no está disponible.

BEGIN;

DROP FUNCTION IF EXISTS public.crew_send_message(text, uuid, uuid);
DROP FUNCTION IF EXISTS public.crew_list_messages(uuid, int);
DROP FUNCTION IF EXISTS public.crew_mark_read(uuid);
DROP FUNCTION IF EXISTS public.crew_unread();
DROP FUNCTION IF EXISTS public.crew_threads_admin();

DROP TABLE IF EXISTS public.crew_messages;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_ops_contact_phone_len;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_ops_contact_hours_len;
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS ops_contact_phone,
  DROP COLUMN IF EXISTS ops_contact_hours;

COMMIT;
