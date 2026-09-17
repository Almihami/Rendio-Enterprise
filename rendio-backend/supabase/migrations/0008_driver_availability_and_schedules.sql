-- =============================================================================
-- Migration 0008 — driver_availability + weekly_schedules + app_settings
-- Tarea: módulo "rendio-turnos" — generación semanal de turnos por jornadas
-- Spec: Arquitectura §5.4 driver_availability (adaptada a jornadas AM/PM)
--
-- Contiene:
--   - Enum availability_state (available | prefer_rest | unavailable)
--   - Tabla driver_availability: una fila por (profile, semana, día) con
--     dos estados independientes (am_state, pm_state).
--   - Tabla weekly_schedules: snapshot del horario generado por semana.
--   - Tabla app_settings: configuración singleton (cupos, etiquetas).
--   - RLS:
--       driver_availability — el conductor solo ve/edita la suya; admin todo.
--       weekly_schedules    — cualquier autenticado lee; admin escribe.
--       app_settings        — cualquier autenticado lee; admin escribe.
--   - Seed: fila default en app_settings.
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.availability_state AS ENUM ('available', 'prefer_rest', 'unavailable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- driver_availability
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_availability (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start_date date        NOT NULL,
  day_of_week     smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  am_state        public.availability_state NOT NULL DEFAULT 'available',
  pm_state        public.availability_state NOT NULL DEFAULT 'available',
  notes           text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_availability_unique_per_day UNIQUE (profile_id, week_start_date, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_driver_availability_profile_week
  ON public.driver_availability(profile_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_driver_availability_week
  ON public.driver_availability(week_start_date);

DROP TRIGGER IF EXISTS tr_driver_availability_set_updated_at ON public.driver_availability;
CREATE TRIGGER tr_driver_availability_set_updated_at
  BEFORE UPDATE ON public.driver_availability
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.driver_availability ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- weekly_schedules
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weekly_schedules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date date        NOT NULL UNIQUE,
  data            jsonb       NOT NULL,
  published       boolean     NOT NULL DEFAULT false,
  created_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tr_weekly_schedules_set_updated_at ON public.weekly_schedules;
CREATE TRIGGER tr_weekly_schedules_set_updated_at
  BEFORE UPDATE ON public.weekly_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.weekly_schedules ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- app_settings (singleton)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.app_settings (
  id              text        PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  morning_label   text        NOT NULL DEFAULT '02:30 AM - 02:00 PM',
  afternoon_label text        NOT NULL DEFAULT '02:00 PM - 01:30 AM',
  morning_slots   smallint    NOT NULL DEFAULT 2 CHECK (morning_slots BETWEEN 1 AND 8),
  afternoon_slots smallint    NOT NULL DEFAULT 2 CHECK (afternoon_slots BETWEEN 1 AND 8),
  updated_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tr_app_settings_set_updated_at ON public.app_settings;
CREATE TRIGGER tr_app_settings_set_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- RLS Policies
-- =============================================================================

-- driver_availability ---------------------------------------------------------

DROP POLICY IF EXISTS p_driver_availability_select_self ON public.driver_availability;
CREATE POLICY p_driver_availability_select_self
  ON public.driver_availability FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS p_driver_availability_select_admin ON public.driver_availability;
CREATE POLICY p_driver_availability_select_admin
  ON public.driver_availability FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_availability_insert_self ON public.driver_availability;
CREATE POLICY p_driver_availability_insert_self
  ON public.driver_availability FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    OR public.current_user_role() = 'admin'
  );

DROP POLICY IF EXISTS p_driver_availability_update_self ON public.driver_availability;
CREATE POLICY p_driver_availability_update_self
  ON public.driver_availability FOR UPDATE TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.current_user_role() = 'admin'
  )
  WITH CHECK (
    profile_id = auth.uid()
    OR public.current_user_role() = 'admin'
  );

DROP POLICY IF EXISTS p_driver_availability_delete_admin ON public.driver_availability;
CREATE POLICY p_driver_availability_delete_admin
  ON public.driver_availability FOR DELETE TO authenticated
  USING (public.current_user_role() = 'admin');

-- weekly_schedules ------------------------------------------------------------

DROP POLICY IF EXISTS p_weekly_schedules_select_all ON public.weekly_schedules;
CREATE POLICY p_weekly_schedules_select_all
  ON public.weekly_schedules FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS p_weekly_schedules_insert_admin ON public.weekly_schedules;
CREATE POLICY p_weekly_schedules_insert_admin
  ON public.weekly_schedules FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_weekly_schedules_update_admin ON public.weekly_schedules;
CREATE POLICY p_weekly_schedules_update_admin
  ON public.weekly_schedules FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_weekly_schedules_delete_admin ON public.weekly_schedules;
CREATE POLICY p_weekly_schedules_delete_admin
  ON public.weekly_schedules FOR DELETE TO authenticated
  USING (public.current_user_role() = 'admin');

-- app_settings ----------------------------------------------------------------

DROP POLICY IF EXISTS p_app_settings_select_all ON public.app_settings;
CREATE POLICY p_app_settings_select_all
  ON public.app_settings FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS p_app_settings_update_admin ON public.app_settings;
CREATE POLICY p_app_settings_update_admin
  ON public.app_settings FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE public.driver_availability IS 'Disponibilidad reportada por conductor para cada día de la semana, separada por jornadas AM/PM (módulo rendio-turnos).';
COMMENT ON TABLE public.weekly_schedules    IS 'Horario semanal generado y/o editado por el admin. data es JSONB con el snapshot de turnos.';
COMMENT ON TABLE public.app_settings        IS 'Configuración global del módulo de turnos (fila única).';
COMMENT ON COLUMN public.driver_availability.day_of_week IS '0=lunes, 1=martes, …, 6=domingo (ISO).';
COMMENT ON COLUMN public.driver_availability.week_start_date IS 'Lunes de la semana a la que aplica la disponibilidad.';

COMMIT;
