-- Revierte 0091 · Rendio Points.
--
-- PIERDE DATOS (avisar antes de correrlo donde haya gente usándolo): borra el
-- libro de puntos, los canjes (pendientes y cumplidos), los códigos de referido
-- y quién invitó a quién. Los saldos NO se pueden reconstruir después.
-- Nada de 0091 tocó tablas existentes salvo:
--   · app_settings: 8 columnas aux_points_* (se borran);
--   · triggers nuevos en reservations y route_stops (se borran);
-- register_auxiliar, auxiliar_cancel_reservation y auxiliar_rate_reservation
-- nunca cambiaron, así que no hay nada que restaurar en ellas.

BEGIN;

DROP TRIGGER IF EXISTS tr_aux_points_reservation ON public.reservations;
DROP TRIGGER IF EXISTS tr_aux_points_stash_pickup ON public.route_stops;
DROP FUNCTION IF EXISTS public.tg_aux_points_reservation();
DROP FUNCTION IF EXISTS public.tg_aux_points_stash_pickup();

DROP FUNCTION IF EXISTS public.aux_points_my_summary();
DROP FUNCTION IF EXISTS public.aux_points_my_code();
DROP FUNCTION IF EXISTS public.aux_points_my_referrals();
DROP FUNCTION IF EXISTS public.aux_points_claim_referral(text);
DROP FUNCTION IF EXISTS public.aux_points_my_goal();
DROP FUNCTION IF EXISTS public.aux_points_redeem(text, text);
DROP FUNCTION IF EXISTS public.aux_points_admin_redemptions(text);
DROP FUNCTION IF EXISTS public.aux_points_admin_decide(uuid, text, text);
DROP FUNCTION IF EXISTS public.aux_points_admin_adjust(uuid, integer, text);
DROP FUNCTION IF EXISTS public.aux_points_admin_balances();
DROP FUNCTION IF EXISTS public.aux_points_ensure_code(uuid);
DROP FUNCTION IF EXISTS public.aux_points_add(uuid, integer, text, text, uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.aux_points_balance(uuid);
DROP FUNCTION IF EXISTS public.aux_points_on();
DROP FUNCTION IF EXISTS public.aux_points_tag3(text);
DROP FUNCTION IF EXISTS public.aux_points_letters(text);
DROP FUNCTION IF EXISTS public.aux_points_display_name(text);

DROP TABLE IF EXISTS public.aux_points_ledger;
DROP TABLE IF EXISTS public.aux_points_redemptions;
DROP TABLE IF EXISTS public.aux_referrals;
DROP TABLE IF EXISTS public.aux_referral_codes;
DROP TABLE IF EXISTS public.aux_points_rewards;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_points_values_range;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_points_goal_range;
ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS aux_points_enabled,
  DROP COLUMN IF EXISTS aux_points_invite,
  DROP COLUMN IF EXISTS aux_points_neighbor,
  DROP COLUMN IF EXISTS aux_points_cancel,
  DROP COLUMN IF EXISTS aux_points_cancel_lead_hours,
  DROP COLUMN IF EXISTS aux_points_rate,
  DROP COLUMN IF EXISTS aux_points_goal_target,
  DROP COLUMN IF EXISTS aux_points_goal_text;

COMMIT;
