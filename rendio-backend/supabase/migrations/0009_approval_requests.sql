-- =============================================================================
-- Migration 0009 — approval_requests + sync trigger + auto-resolve function
-- Tarea: módulo rendio-turnos — flujo de aprobaciones para descansos solicitados
--
-- Reglas:
--   * "No disponible" (cualquier día) → genera solicitud pending. Requiere `reason`.
--     Nunca se auto-aprueba; admin debe revisar.
--   * "Pido descanso" (estado prefer_rest):
--       - Fin de semana (sáb/dom) → siempre genera pending.
--       - Entre semana → solo genera pending si 2+ conductores piden la misma
--         jornada (conflicto). Sin conflicto, no genera solicitud.
--   * "Disponible" → elimina cualquier solicitud previa de esa jornada.
--   * Función auto_resolve_weekend_singletons():
--       - Aprueba las solicitudes de fin de semana que quedaron como
--         "singleton" (solo 1 conductor pidió esa jornada).
--       - Para correr vía pg_cron los domingos 8 PM (zona América/Bogotá) o
--         manualmente desde el panel admin.
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas en driver_availability (razones)
-- -----------------------------------------------------------------------------

ALTER TABLE public.driver_availability
  ADD COLUMN IF NOT EXISTS am_reason text,
  ADD COLUMN IF NOT EXISTS pm_reason text;

COMMENT ON COLUMN public.driver_availability.am_reason
  IS 'Justificación del conductor cuando am_state = unavailable.';
COMMENT ON COLUMN public.driver_availability.pm_reason
  IS 'Justificación del conductor cuando pm_state = unavailable.';

-- -----------------------------------------------------------------------------
-- 2. Enums de soporte
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.approval_state AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.shift_period AS ENUM ('am', 'pm');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Tabla approval_requests
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.approval_requests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start_date date        NOT NULL,
  day_of_week     smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  shift           public.shift_period NOT NULL,
  kind            public.availability_state NOT NULL CHECK (kind IN ('prefer_rest', 'unavailable')),
  reason          text,
  state           public.approval_state NOT NULL DEFAULT 'pending',
  resolved_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  admin_note      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_unique_per_shift
    UNIQUE (profile_id, week_start_date, day_of_week, shift),
  CONSTRAINT approval_requests_reason_required CHECK (
    kind <> 'unavailable' OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON public.approval_requests(week_start_date, day_of_week, shift)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_approval_requests_profile
  ON public.approval_requests(profile_id, week_start_date);

DROP TRIGGER IF EXISTS tr_approval_requests_set_updated_at ON public.approval_requests;
CREATE TRIGGER tr_approval_requests_set_updated_at
  BEFORE UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4. RLS de approval_requests
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_approval_requests_select_self ON public.approval_requests;
CREATE POLICY p_approval_requests_select_self
  ON public.approval_requests FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.current_user_role() = 'admin');

-- INSERT/UPDATE/DELETE solo ocurren vía funciones SECURITY DEFINER del trigger
-- y vía la política de admin para resolución.

DROP POLICY IF EXISTS p_approval_requests_update_admin ON public.approval_requests;
CREATE POLICY p_approval_requests_update_admin
  ON public.approval_requests FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- 5. Trigger function: sync_approval_requests
--    Reacciona a INSERT/UPDATE de driver_availability y mantiene la cola
--    de aprobaciones en sincronía con las reglas.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_approval_requests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  is_weekend boolean := NEW.day_of_week >= 5;
  am_old text;
  pm_old text;
  conflict_count int;
BEGIN
  am_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.am_state::text END;
  pm_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.pm_state::text END;

  -- ====================== JORNADA AM ======================
  IF NEW.am_state::text IS DISTINCT FROM am_old OR TG_OP = 'INSERT' THEN
    IF NEW.am_state = 'unavailable' THEN
      INSERT INTO public.approval_requests
        (profile_id, week_start_date, day_of_week, shift, kind, reason, state)
      VALUES
        (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'am', 'unavailable', NEW.am_reason, 'pending')
      ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
        SET kind = 'unavailable', reason = EXCLUDED.reason, state = 'pending',
            resolved_by = NULL, resolved_at = NULL, admin_note = NULL;

    ELSIF NEW.am_state = 'prefer_rest' THEN
      IF is_weekend THEN
        INSERT INTO public.approval_requests
          (profile_id, week_start_date, day_of_week, shift, kind, state)
        VALUES
          (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'am', 'prefer_rest', 'pending')
        ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
          SET kind = 'prefer_rest', reason = NULL, state = 'pending',
              resolved_by = NULL, resolved_at = NULL, admin_note = NULL;
      ELSE
        SELECT COUNT(*) INTO conflict_count
        FROM public.driver_availability
        WHERE week_start_date = NEW.week_start_date
          AND day_of_week = NEW.day_of_week
          AND am_state = 'prefer_rest'
          AND profile_id <> NEW.profile_id;

        IF conflict_count >= 1 THEN
          INSERT INTO public.approval_requests
            (profile_id, week_start_date, day_of_week, shift, kind, state)
          VALUES
            (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'am', 'prefer_rest', 'pending')
          ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
            SET kind = 'prefer_rest', reason = NULL, state = 'pending',
                resolved_by = NULL, resolved_at = NULL, admin_note = NULL;

          INSERT INTO public.approval_requests
            (profile_id, week_start_date, day_of_week, shift, kind, state)
          SELECT da.profile_id, NEW.week_start_date, NEW.day_of_week, 'am', 'prefer_rest', 'pending'
          FROM public.driver_availability da
          WHERE da.week_start_date = NEW.week_start_date
            AND da.day_of_week = NEW.day_of_week
            AND da.am_state = 'prefer_rest'
            AND da.profile_id <> NEW.profile_id
          ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO NOTHING;
        ELSE
          DELETE FROM public.approval_requests
          WHERE profile_id = NEW.profile_id
            AND week_start_date = NEW.week_start_date
            AND day_of_week = NEW.day_of_week
            AND shift = 'am';
        END IF;
      END IF;

    ELSE -- available
      DELETE FROM public.approval_requests
      WHERE profile_id = NEW.profile_id
        AND week_start_date = NEW.week_start_date
        AND day_of_week = NEW.day_of_week
        AND shift = 'am';

      IF NOT is_weekend THEN
        SELECT COUNT(*) INTO conflict_count
        FROM public.driver_availability
        WHERE week_start_date = NEW.week_start_date
          AND day_of_week = NEW.day_of_week
          AND am_state = 'prefer_rest';

        IF conflict_count = 1 THEN
          DELETE FROM public.approval_requests ar
          USING public.driver_availability da
          WHERE ar.profile_id = da.profile_id
            AND ar.week_start_date = da.week_start_date
            AND ar.day_of_week = da.day_of_week
            AND ar.shift = 'am'
            AND ar.kind = 'prefer_rest'
            AND ar.state = 'pending'
            AND da.week_start_date = NEW.week_start_date
            AND da.day_of_week = NEW.day_of_week
            AND da.am_state = 'prefer_rest';
        END IF;
      END IF;
    END IF;
  END IF;

  -- ====================== JORNADA PM ======================
  IF NEW.pm_state::text IS DISTINCT FROM pm_old OR TG_OP = 'INSERT' THEN
    IF NEW.pm_state = 'unavailable' THEN
      INSERT INTO public.approval_requests
        (profile_id, week_start_date, day_of_week, shift, kind, reason, state)
      VALUES
        (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'pm', 'unavailable', NEW.pm_reason, 'pending')
      ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
        SET kind = 'unavailable', reason = EXCLUDED.reason, state = 'pending',
            resolved_by = NULL, resolved_at = NULL, admin_note = NULL;

    ELSIF NEW.pm_state = 'prefer_rest' THEN
      IF is_weekend THEN
        INSERT INTO public.approval_requests
          (profile_id, week_start_date, day_of_week, shift, kind, state)
        VALUES
          (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'pm', 'prefer_rest', 'pending')
        ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
          SET kind = 'prefer_rest', reason = NULL, state = 'pending',
              resolved_by = NULL, resolved_at = NULL, admin_note = NULL;
      ELSE
        SELECT COUNT(*) INTO conflict_count
        FROM public.driver_availability
        WHERE week_start_date = NEW.week_start_date
          AND day_of_week = NEW.day_of_week
          AND pm_state = 'prefer_rest'
          AND profile_id <> NEW.profile_id;

        IF conflict_count >= 1 THEN
          INSERT INTO public.approval_requests
            (profile_id, week_start_date, day_of_week, shift, kind, state)
          VALUES
            (NEW.profile_id, NEW.week_start_date, NEW.day_of_week, 'pm', 'prefer_rest', 'pending')
          ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO UPDATE
            SET kind = 'prefer_rest', reason = NULL, state = 'pending',
                resolved_by = NULL, resolved_at = NULL, admin_note = NULL;

          INSERT INTO public.approval_requests
            (profile_id, week_start_date, day_of_week, shift, kind, state)
          SELECT da.profile_id, NEW.week_start_date, NEW.day_of_week, 'pm', 'prefer_rest', 'pending'
          FROM public.driver_availability da
          WHERE da.week_start_date = NEW.week_start_date
            AND da.day_of_week = NEW.day_of_week
            AND da.pm_state = 'prefer_rest'
            AND da.profile_id <> NEW.profile_id
          ON CONFLICT (profile_id, week_start_date, day_of_week, shift) DO NOTHING;
        ELSE
          DELETE FROM public.approval_requests
          WHERE profile_id = NEW.profile_id
            AND week_start_date = NEW.week_start_date
            AND day_of_week = NEW.day_of_week
            AND shift = 'pm';
        END IF;
      END IF;

    ELSE -- available
      DELETE FROM public.approval_requests
      WHERE profile_id = NEW.profile_id
        AND week_start_date = NEW.week_start_date
        AND day_of_week = NEW.day_of_week
        AND shift = 'pm';

      IF NOT is_weekend THEN
        SELECT COUNT(*) INTO conflict_count
        FROM public.driver_availability
        WHERE week_start_date = NEW.week_start_date
          AND day_of_week = NEW.day_of_week
          AND pm_state = 'prefer_rest';

        IF conflict_count = 1 THEN
          DELETE FROM public.approval_requests ar
          USING public.driver_availability da
          WHERE ar.profile_id = da.profile_id
            AND ar.week_start_date = da.week_start_date
            AND ar.day_of_week = da.day_of_week
            AND ar.shift = 'pm'
            AND ar.kind = 'prefer_rest'
            AND ar.state = 'pending'
            AND da.week_start_date = NEW.week_start_date
            AND da.day_of_week = NEW.day_of_week
            AND da.pm_state = 'prefer_rest';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_driver_availability_sync_approvals ON public.driver_availability;
CREATE TRIGGER tr_driver_availability_sync_approvals
  AFTER INSERT OR UPDATE ON public.driver_availability
  FOR EACH ROW EXECUTE FUNCTION public.sync_approval_requests();

-- -----------------------------------------------------------------------------
-- 6. Función de auto-resolución
--    Aprueba las solicitudes de fin de semana que quedaron como singleton.
--    Las "unavailable" nunca se auto-aprueban.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_resolve_weekend_singletons()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  resolved int;
BEGIN
  WITH grouped AS (
    SELECT week_start_date, day_of_week, shift,
           COUNT(*) FILTER (WHERE state = 'pending' AND kind = 'prefer_rest') AS pending_count
    FROM public.approval_requests
    WHERE day_of_week >= 5
    GROUP BY week_start_date, day_of_week, shift
  )
  UPDATE public.approval_requests ar
  SET state = 'approved', resolved_at = now()
  FROM grouped g
  WHERE ar.week_start_date = g.week_start_date
    AND ar.day_of_week = g.day_of_week
    AND ar.shift = g.shift
    AND ar.state = 'pending'
    AND ar.kind = 'prefer_rest'
    AND g.pending_count = 1;

  GET DIAGNOSTICS resolved = ROW_COUNT;
  RETURN resolved;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_resolve_weekend_singletons() TO authenticated;

COMMENT ON FUNCTION public.auto_resolve_weekend_singletons() IS
  'Aprueba automáticamente las solicitudes de descanso de fin de semana que '
  'quedaron como singleton (1 conductor pidió la jornada). Llamar vía pg_cron '
  'los domingos 8 PM o manualmente desde el panel admin.';

COMMIT;
