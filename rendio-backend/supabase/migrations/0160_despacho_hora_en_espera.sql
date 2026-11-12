-- =============================================================================
-- 0160 · Despacho: la llegada EN ESPERA también muestra la hora real del vuelo
-- =============================================================================
-- Prueba en vivo del 11-nov: a Mateo le adelantaron el vuelo 14 min y, como nadie
-- alcanzaba, su vuelta siguió en espera… a las 22:30 (la hora programada) cuando
-- en realidad salía a las 22:06. 0159 corrige la hora AL ASIGNAR; faltaba la de
-- las que todavía no tienen conductor, que es justo la que el jefe necesita ver
-- bien para mandar apoyo.
--
-- despacho_poner_horas(): cada llegada en espera (para tomar, sin conductor, sin
-- tocar) cuyo vuelo viene ADELANTADO 5 min o más queda a la hora en que sale la
-- persona (FlightRadar + desembarque, a múltiplo de 5 hacia arriba); se corren
-- las paradas y la hora del pedido. Los ATRASOS no se tocan aquí: de esos se
-- encarga acomodar_eventualidades, como siempre. La llama despachar_llegadas
-- (cada 2 min) antes de disparar el reparto. Solo con despacho_activo.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.despacho_poner_horas(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record; v_ini timestamptz; v_n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE id = 'singleton' AND despacho_activo) THEN RETURN 0; END IF;
  FOR r IN
    SELECT ra.id, ra.planned_start_at AS ini, t.sale
      FROM public.route_assignments ra
      JOIN LATERAL (
        SELECT count(*)::int AS pax,
               bool_and(rs.status = 'pending') AS intacta,
               max(CASE
                     WHEN res.id IS NULL THEN ra.planned_start_at
                     WHEN nullif(trim(res.flight_code), '') IS NULL OR coalesce(res.ground_ops, false) OR res.reserve_place IS NOT NULL
                       THEN res.required_arrival_at
                     ELSE coalesce(public.reub_baja(ra.organization_id, res.flight_code, res.required_arrival_at), res.required_arrival_at)
                          + make_interval(mins => coalesce(public.flight_deplane_min(res.flight_code), 20))
                   END) AS sale
          FROM public.route_stops rs
          LEFT JOIN public.reservations res ON res.id = rs.reservation_id
         WHERE rs.route_assignment_id = ra.id
           AND (rs.reservation_id IS NULL OR res.cancelled_at IS NULL)
      ) t ON true
     WHERE ra.direction = 'airport_to_home' AND ra.pool AND ra.driver_profile_id IS NULL
       AND ra.status = 'planned' AND ra.delegated_at IS NULL AND ra.organization_id IS NOT NULL
       AND ra.planned_start_at BETWEEN p_now - interval '3 hours' AND p_now + interval '4 hours'
       AND t.pax > 0 AND t.intacta AND t.sale IS NOT NULL
  LOOP
    v_ini := to_timestamp(ceil(extract(epoch FROM r.sale) / 300.0) * 300);
    CONTINUE WHEN v_ini > r.ini - interval '5 minutes';      -- solo adelantos de 5 min o más
    CONTINUE WHEN v_ini < p_now - interval '30 minutes';     -- algo muy viejo: no se toca
    UPDATE public.route_assignments SET planned_start_at = v_ini, updated_at = now()
     WHERE id = r.id AND driver_profile_id IS NULL AND status = 'planned';
    CONTINUE WHEN NOT FOUND;
    UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + (v_ini - r.ini)
     WHERE route_assignment_id = r.id AND estimated_arrival_at IS NOT NULL;
    PERFORM public.sync_calculated_pickup(rs.reservation_id)
       FROM public.route_stops rs WHERE rs.route_assignment_id = r.id AND rs.reservation_id IS NOT NULL;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION public.despacho_poner_horas(timestamptz) IS
  '0160: las llegadas en espera cuyo vuelo viene adelantado quedan a la hora en que sale la persona. Devuelve cuántas movió. Solo servidor.';

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
  -- 0160: antes de repartir, las que siguen en espera quedan a la hora que dice el vuelo.
  PERFORM public.despacho_poner_horas();
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

REVOKE ALL ON FUNCTION public.despacho_poner_horas(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despacho_poner_horas(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.despachar_llegadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.despachar_llegadas() TO service_role;

COMMIT;
