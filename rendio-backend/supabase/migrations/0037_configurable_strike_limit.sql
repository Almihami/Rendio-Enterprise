-- =============================================================================
-- Migration 0037 — Umbral de strikes configurable por el admin
--
-- El "3 strikes → suspensión" estaba hardcodeado en apply_strike_suspension()
-- (0018). Lo volvemos parametrizable: app_settings.strike_limit (default 3). El
-- trigger ahora lee ese límite. La idea: el admin lo configura y el sistema lo
-- detecta/aplica solo. (reservation_idle_minutes ya existía desde 0033.)
-- Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS strike_limit smallint NOT NULL DEFAULT 3;
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_strike_limit_range;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_strike_limit_range CHECK (strike_limit BETWEEN 1 AND 10);
COMMENT ON COLUMN public.app_settings.strike_limit
  IS 'Cuántos strikes activos disparan la suspensión automática de la semana siguiente. Default 3.';

-- Trigger de auto-suspensión, ahora con umbral configurable.
CREATE OR REPLACE FUNCTION public.apply_strike_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_count int;
  susp_week    date;
  v_limit      int;
BEGIN
  SELECT COALESCE(strike_limit, 3) INTO v_limit FROM public.app_settings WHERE id = 'singleton';
  IF v_limit IS NULL OR v_limit < 1 THEN v_limit := 3; END IF;

  SELECT COUNT(*) INTO active_count
  FROM public.driver_strikes
  WHERE profile_id = NEW.profile_id
    AND voided_at IS NULL
    AND consumed_at IS NULL;

  IF active_count >= v_limit THEN
    susp_week := NEW.week_start_date + 7;

    INSERT INTO public.driver_suspensions
      (profile_id, week_start_date, reason, source, created_by)
    VALUES
      (NEW.profile_id, susp_week, 'Acumuló ' || v_limit || ' strikes', 'strikes', NEW.created_by)
    ON CONFLICT (profile_id, week_start_date) DO NOTHING;

    -- Consume los strikes activos (cierra el ciclo).
    UPDATE public.driver_strikes
    SET consumed_at = now()
    WHERE profile_id = NEW.profile_id
      AND voided_at IS NULL
      AND consumed_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
