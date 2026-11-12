-- Down 0160 — despachar_llegadas vuelve a la de 0158 y se quita despacho_poner_horas.
BEGIN;
CREATE OR REPLACE FUNCTION public.despachar_llegadas()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url text; v_key text; v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE id = 'singleton' AND despacho_activo) THEN
    RETURN 'apagado (app_settings.despacho_activo)';
  END IF;
  SELECT count(*) INTO v_n FROM public.route_assignments ra
   WHERE ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
     AND ra.status = 'planned' AND ra.delegated_at IS NULL
     AND ra.planned_start_at BETWEEN now() - interval '3 hours' AND now() + interval '4 hours';
  IF v_n = 0 THEN RETURN 'sin llegadas en espera'; END IF;
  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'despacho_llegadas_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'vault no disponible: ' || SQLERRM;
  END;
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN 'faltan secretos en Vault: ' || concat_ws(', ', CASE WHEN v_url IS NULL THEN 'despacho_llegadas_url' END, CASE WHEN v_key IS NULL THEN 'service_role_key' END);
  END IF;
  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body    := jsonb_build_object('trigger', 'cron'),
      timeout_milliseconds := 60000
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN 'pg_net no disponible: ' || SQLERRM;
  END;
  RETURN 'disparado con ' || v_n || ' llegadas en espera';
END;
$$;

REVOKE ALL ON FUNCTION public.despachar_llegadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despachar_llegadas() TO service_role;
DROP FUNCTION IF EXISTS public.despacho_poner_horas(timestamptz);
COMMIT;
