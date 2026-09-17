-- =============================================================================
-- Migration 0019 — shift_swaps (cambio de turno entre conductores)
-- Tarea: módulo rendio-turnos — un conductor (A) propone a otro (B) intercambiar
--   dos turnos del horario PUBLICADO. B acepta o rechaza. Sin paso de admin.
--
-- Diseño: el swap NO modifica weekly_schedules (los conductores son read-only
--   ahí). Un swap 'accepted' se aplica como OVERLAY al mostrar el horario, tanto
--   al conductor como al admin. La validación (no genera indisponibilidad ni
--   viola reglas) la hace el cliente antes de aceptar.
--
-- Idempotente.
-- =============================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE public.swap_state AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.shift_swaps (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start_date  date        NOT NULL,
  from_day         smallint    NOT NULL CHECK (from_day BETWEEN 0 AND 6),
  from_shift       public.shift_period NOT NULL,
  to_day           smallint    NOT NULL CHECK (to_day BETWEEN 0 AND 6),
  to_shift         public.shift_period NOT NULL,
  note             text,                                   -- mensaje opcional de A
  decided_note     text,                                   -- nota opcional de B al decidir
  state            public.swap_state NOT NULL DEFAULT 'pending',
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_swaps_not_self CHECK (requester_id <> target_id),
  CONSTRAINT shift_swaps_distinct_slot CHECK (NOT (from_day = to_day AND from_shift = to_shift))
);

CREATE INDEX IF NOT EXISTS idx_shift_swaps_target_pending
  ON public.shift_swaps(target_id, week_start_date) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_shift_swaps_week_accepted
  ON public.shift_swaps(week_start_date) WHERE state = 'accepted';
CREATE INDEX IF NOT EXISTS idx_shift_swaps_requester
  ON public.shift_swaps(requester_id, week_start_date);

DROP TRIGGER IF EXISTS tr_shift_swaps_set_updated_at ON public.shift_swaps;
CREATE TRIGGER tr_shift_swaps_set_updated_at
  BEFORE UPDATE ON public.shift_swaps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.shift_swaps ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- RLS
--   SELECT: las dos partes involucradas o el admin.
--   INSERT: solo el propio solicitante (requester_id = auth.uid()).
--   UPDATE: la parte involucrada (B acepta/rechaza, A cancela) o el admin.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_shift_swaps_select ON public.shift_swaps;
CREATE POLICY p_shift_swaps_select
  ON public.shift_swaps FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR target_id = auth.uid() OR public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_shift_swaps_insert_self ON public.shift_swaps;
CREATE POLICY p_shift_swaps_insert_self
  ON public.shift_swaps FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid() AND public.current_user_role() = 'driver');

DROP POLICY IF EXISTS p_shift_swaps_update_involved ON public.shift_swaps;
CREATE POLICY p_shift_swaps_update_involved
  ON public.shift_swaps FOR UPDATE TO authenticated
  USING (requester_id = auth.uid() OR target_id = auth.uid() OR public.current_user_role() = 'admin')
  WITH CHECK (requester_id = auth.uid() OR target_id = auth.uid() OR public.current_user_role() = 'admin');

COMMIT;
