-- =============================================================================
-- Migration 0038 — Redención de recompensa con validación en el SERVIDOR
--
-- Antes, el conductor insertaba la solicitud directo en reward_redemptions y el
-- km venía del cliente (confiable solo por la UI: a una recompensa bloqueada no
-- se le muestra "Redimir"). Esto lo blinda: un RPC SECURITY DEFINER que:
--   - calcula el km acumulado REAL del conductor (suma de cierre-apertura de sus
--     turnos cerrados), sin confiar en el cliente;
--   - exige km >= umbral de la recompensa (NOT_ENOUGH_KM);
--   - exige que la recompensa esté activa (REWARD_INACTIVE);
--   - evita duplicados (ALREADY_REQUESTED) si ya hay una pendiente/aprobada/entregada;
--   - inserta la solicitud con km_at_request calculado en el servidor.
-- Idempotente (CREATE OR REPLACE).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.redeem_reward(p_reward_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_driver uuid;
  v_reward public.rewards%ROWTYPE;
  v_km     int;
  v_red_id uuid;
BEGIN
  v_driver := public.current_driver_id();
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile';
  END IF;

  SELECT * INTO v_reward FROM public.rewards WHERE id = p_reward_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REWARD_NOT_FOUND'; END IF;
  IF NOT v_reward.active THEN RAISE EXCEPTION 'REWARD_INACTIVE: la recompensa no está disponible'; END IF;

  -- km acumulado del conductor (fuente de verdad: turnos cerrados).
  SELECT COALESCE(SUM(GREATEST(0, closing_km - opening_km)), 0) INTO v_km
    FROM public.shifts
   WHERE driver_id = v_driver
     AND status = 'closed'
     AND closing_km IS NOT NULL
     AND opening_km IS NOT NULL;

  IF v_km < v_reward.km_threshold THEN
    RAISE EXCEPTION 'NOT_ENOUGH_KM: tienes % km y la recompensa requiere %', v_km, v_reward.km_threshold;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reward_redemptions
     WHERE driver_id = v_driver AND reward_id = p_reward_id
       AND status IN ('pending', 'approved', 'delivered')
  ) THEN
    RAISE EXCEPTION 'ALREADY_REQUESTED: ya solicitaste esta recompensa';
  END IF;

  INSERT INTO public.reward_redemptions (organization_id, driver_id, reward_id, km_at_request, status)
  VALUES (v_reward.organization_id, v_driver, p_reward_id, v_km, 'pending')
  RETURNING id INTO v_red_id;

  RETURN jsonb_build_object('ok', true, 'redemption_id', v_red_id, 'km', v_km);
END;
$fn$;

REVOKE ALL ON FUNCTION public.redeem_reward(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_reward(uuid) TO authenticated;

COMMENT ON FUNCTION public.redeem_reward(uuid)
  IS 'Redención de recompensa validada en servidor: calcula km del conductor, exige km>=umbral, recompensa activa y sin duplicado. SECURITY DEFINER.';

COMMIT;
