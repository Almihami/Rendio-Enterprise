-- =============================================================================
-- Migration 0021 — push_subscriptions (Web Push / notificaciones PWA)
-- Tarea: módulo rendio-turnos — guarda la suscripción Web Push de cada
--   dispositivo. La Edge Function 'send-push' (service_role) las lee para enviar.
--
-- iOS: solo funciona si la PWA está INSTALADA en pantalla de inicio (iOS 16.4+).
-- Idempotente.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint     text        NOT NULL UNIQUE,
  p256dh       text        NOT NULL,
  auth         text        NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_profile ON public.push_subscriptions(profile_id);

DROP TRIGGER IF EXISTS tr_push_subscriptions_set_updated_at ON public.push_subscriptions;
CREATE TRIGGER tr_push_subscriptions_set_updated_at
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS: cada quien gestiona SU propia suscripción. El envío lo hace la Edge
-- Function con service_role (bypassa RLS), así que no necesita policy de lectura
-- global. El admin puede leer para diagnóstico.
DROP POLICY IF EXISTS p_push_subscriptions_select ON public.push_subscriptions;
CREATE POLICY p_push_subscriptions_select
  ON public.push_subscriptions FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_push_subscriptions_insert_self ON public.push_subscriptions;
CREATE POLICY p_push_subscriptions_insert_self
  ON public.push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS p_push_subscriptions_update_self ON public.push_subscriptions;
CREATE POLICY p_push_subscriptions_update_self
  ON public.push_subscriptions FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS p_push_subscriptions_delete_self ON public.push_subscriptions;
CREATE POLICY p_push_subscriptions_delete_self
  ON public.push_subscriptions FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

COMMIT;
