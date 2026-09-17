-- =============================================================================
-- Migration 0020 — driver_rules (parametrización editable de descansos fijos)
-- Tarea: módulo rendio-turnos — mueve las reglas "duras" por conductor (hoy
--   hardcodeadas por email en scheduler.js) a una tabla editable desde la app.
--   Cada fila = un (día, jornada) BLOQUEADO para un conductor (descanso fijo).
--
-- El scheduler trata estos turnos como 'No disponible' y las vistas (admin y
-- conductor) los muestran 🔒 read-only.
--
-- Se SIEMBRAN las reglas existentes (Juan Andrés, Cardona) para no perder nada.
-- Idempotente.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_rules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day_of_week  smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=lun … 6=dom
  shift        public.shift_period NOT NULL,                              -- 'am' | 'pm'
  note         text,
  created_by   uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_rules_unique UNIQUE (profile_id, day_of_week, shift)
);

CREATE INDEX IF NOT EXISTS idx_driver_rules_profile ON public.driver_rules(profile_id);

DROP TRIGGER IF EXISTS tr_driver_rules_set_updated_at ON public.driver_rules;
CREATE TRIGGER tr_driver_rules_set_updated_at
  BEFORE UPDATE ON public.driver_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.driver_rules ENABLE ROW LEVEL SECURITY;

-- RLS: lectura para todos los autenticados (no es dato sensible y el conductor
-- necesita ver sus propios bloqueos y validar swaps). Escritura: solo admin.
DROP POLICY IF EXISTS p_driver_rules_select ON public.driver_rules;
CREATE POLICY p_driver_rules_select
  ON public.driver_rules FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS p_driver_rules_write_admin ON public.driver_rules;
CREATE POLICY p_driver_rules_write_admin
  ON public.driver_rules FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- Seed de las reglas existentes (por email). day: 0=lun…6=dom.
--   Juan Andrés (juan.mery@rendio.co): mié AM+PM, jue PM, mar PM.
--   Cardona (andres.cardona@rendio.co): vie/sáb/dom AM+PM (solo lun-jue).
-- -----------------------------------------------------------------------------
INSERT INTO public.driver_rules (profile_id, day_of_week, shift, note)
SELECT p.id, v.day_of_week, v.shift::public.shift_period, v.note
FROM (VALUES
  ('juan.mery@rendio.co', 2, 'am', 'Descansa miércoles'),
  ('juan.mery@rendio.co', 2, 'pm', 'Descansa miércoles'),
  ('juan.mery@rendio.co', 3, 'pm', 'Jueves descansa PM'),
  ('juan.mery@rendio.co', 1, 'pm', 'Martes solo madruga (AM)'),
  ('andres.cardona@rendio.co', 4, 'am', 'Solo lun-jue'),
  ('andres.cardona@rendio.co', 4, 'pm', 'Solo lun-jue'),
  ('andres.cardona@rendio.co', 5, 'am', 'Solo lun-jue'),
  ('andres.cardona@rendio.co', 5, 'pm', 'Solo lun-jue'),
  ('andres.cardona@rendio.co', 6, 'am', 'Solo lun-jue'),
  ('andres.cardona@rendio.co', 6, 'pm', 'Solo lun-jue')
) AS v(email, day_of_week, shift, note)
JOIN public.profiles p ON lower(p.email) = v.email
ON CONFLICT (profile_id, day_of_week, shift) DO NOTHING;

COMMIT;
