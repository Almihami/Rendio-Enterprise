-- =============================================================================
-- Migration 0018 — driver_strikes + driver_suspensions + auto-suspensión
-- Tarea: módulo rendio-turnos — amonestaciones (strikes) a conductores.
--
-- Reglas de negocio:
--   * Un strike es una amonestación con RAZÓN obligatoria (para control).
--   * Al acumular 3 strikes ACTIVOS (no anulados, no consumidos), el conductor
--     queda SUSPENDIDO la semana SIGUIENTE de forma AUTOMÁTICA. Esos 3 strikes
--     se marcan como "consumidos" (arrancan un ciclo nuevo desde 0).
--   * La suspensión es POR SEMANA (no toca profiles.is_active, que es global).
--   * El admin puede anular un strike (voided_at) sin perder el historial.
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabla driver_strikes (historial de amonestaciones)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_strikes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason           text        NOT NULL CHECK (length(trim(reason)) > 0),
  -- Semana (lunes ISO) en la que se registra la falta. Define qué semana se
  -- suspende al llegar a 3 (la siguiente a esta).
  week_start_date  date        NOT NULL DEFAULT (date_trunc('week', (now() AT TIME ZONE 'America/Bogota'))::date),
  created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Anulado por el admin (no cuenta, pero queda en el historial).
  voided_at        timestamptz,
  voided_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Consumido al disparar una suspensión (cierra el ciclo de 3).
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_strikes_active
  ON public.driver_strikes(profile_id)
  WHERE voided_at IS NULL AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_driver_strikes_profile
  ON public.driver_strikes(profile_id, created_at DESC);

DROP TRIGGER IF EXISTS tr_driver_strikes_set_updated_at ON public.driver_strikes;
CREATE TRIGGER tr_driver_strikes_set_updated_at
  BEFORE UPDATE ON public.driver_strikes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.driver_strikes ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Tabla driver_suspensions (suspensión acotada a UNA semana)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_suspensions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start_date  date        NOT NULL,                 -- semana suspendida (lunes ISO)
  reason           text,
  source           text        NOT NULL DEFAULT 'strikes' CHECK (source IN ('strikes', 'manual')),
  created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  lifted_at        timestamptz,                          -- admin levanta la suspensión
  lifted_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_suspensions_unique_week UNIQUE (profile_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_driver_suspensions_week
  ON public.driver_suspensions(week_start_date)
  WHERE lifted_at IS NULL;

DROP TRIGGER IF EXISTS tr_driver_suspensions_set_updated_at ON public.driver_suspensions;
CREATE TRIGGER tr_driver_suspensions_set_updated_at
  BEFORE UPDATE ON public.driver_suspensions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.driver_suspensions ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. RLS
--    Conductor: lee lo propio. Admin: lee/gestiona todo.
--    Los INSERT de suspensión por acumulación los hace la función SECURITY
--    DEFINER (bypassa RLS); el admin también puede insertar manualmente.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_driver_strikes_select ON public.driver_strikes;
CREATE POLICY p_driver_strikes_select
  ON public.driver_strikes FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_strikes_insert_admin ON public.driver_strikes;
CREATE POLICY p_driver_strikes_insert_admin
  ON public.driver_strikes FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_strikes_update_admin ON public.driver_strikes;
CREATE POLICY p_driver_strikes_update_admin
  ON public.driver_strikes FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_suspensions_select ON public.driver_suspensions;
CREATE POLICY p_driver_suspensions_select
  ON public.driver_suspensions FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_suspensions_insert_admin ON public.driver_suspensions;
CREATE POLICY p_driver_suspensions_insert_admin
  ON public.driver_suspensions FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_driver_suspensions_update_admin ON public.driver_suspensions;
CREATE POLICY p_driver_suspensions_update_admin
  ON public.driver_suspensions FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- 4. Auto-suspensión: al insertar un strike, si quedan 3 activos → suspende la
--    semana siguiente y marca esos 3 como consumidos.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_strike_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_count int;
  susp_week    date;
BEGIN
  SELECT COUNT(*) INTO active_count
  FROM public.driver_strikes
  WHERE profile_id = NEW.profile_id
    AND voided_at IS NULL
    AND consumed_at IS NULL;

  IF active_count >= 3 THEN
    -- Semana siguiente a la del strike que cerró el ciclo.
    susp_week := NEW.week_start_date + 7;

    INSERT INTO public.driver_suspensions
      (profile_id, week_start_date, reason, source, created_by)
    VALUES
      (NEW.profile_id, susp_week, 'Acumuló 3 strikes', 'strikes', NEW.created_by)
    ON CONFLICT (profile_id, week_start_date) DO NOTHING;

    -- Consume los 3 strikes activos (cierra el ciclo).
    UPDATE public.driver_strikes
    SET consumed_at = now()
    WHERE profile_id = NEW.profile_id
      AND voided_at IS NULL
      AND consumed_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_driver_strikes_auto_suspend ON public.driver_strikes;
CREATE TRIGGER tr_driver_strikes_auto_suspend
  AFTER INSERT ON public.driver_strikes
  FOR EACH ROW EXECUTE FUNCTION public.apply_strike_suspension();

COMMIT;
