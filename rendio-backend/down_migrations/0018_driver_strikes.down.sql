-- Down de 0018_driver_strikes
BEGIN;
DROP TRIGGER IF EXISTS tr_driver_strikes_auto_suspend ON public.driver_strikes;
DROP FUNCTION IF EXISTS public.apply_strike_suspension();
DROP TABLE IF EXISTS public.driver_suspensions;
DROP TABLE IF EXISTS public.driver_strikes;
COMMIT;
