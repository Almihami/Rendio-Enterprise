-- =============================================================================
-- Migration 0046 — retención de driver_locations (la deuda de 0003).
--
-- La 0003 dejó escrito "Política de retención: 7 días vía pg_cron (a configurar
-- en E3)" y NUNCA se configuró: la tabla crece para siempre.
--
-- Con el GPS del conductor pingando cada 6s, 4 carros en un turno de 12h dejan
-- ~29.000 filas/día (~870.000 al mes). Con la retención de 7 días se estabiliza
-- en ~200.000 y deja de crecer.
--
-- Ojo con qué se borra: driver_locations es el rastro CRUDO del GPS, un dato
-- operativo de "dónde va el carro ahora". La historia que importa para métricas
-- (a qué hora llegó de verdad a cada parada) vive en route_stops.actual_* y esa
-- NO se toca — la llena driver_set_reservation_status desde 0045.
--
-- Idempotente. Sigue el patrón de 0027 (job en pg_cron, tolerante a que no esté).
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.purge_old_driver_locations()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_borradas integer;
BEGIN
  DELETE FROM public.driver_locations
  WHERE recorded_at < now() - interval '7 days';
  GET DIAGNOSTICS v_borradas = ROW_COUNT;
  RETURN v_borradas;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_driver_locations() FROM PUBLIC;

COMMENT ON FUNCTION public.purge_old_driver_locations()
  IS 'Borra el rastro de GPS de más de 7 días. No toca route_stops.actual_* (la historia real de la operación). Lo corre pg_cron a diario.';

COMMIT;

-- Job diario a las 03:30 UTC (= 22:30 Bogotá): fuera de la ventana de operación,
-- que arranca ~02:30 Bogotá.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('purge-driver-locations');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM cron.schedule(
    'purge-driver-locations',
    '30 3 * * *',
    $job$SELECT public.purge_old_driver_locations();$job$
  );
  RAISE NOTICE 'pg_cron: job "purge-driver-locations" programado a diario.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible/sin permisos (%). Programa el job manualmente; driver_locations crecerá sin techo hasta entonces.', SQLERRM;
END
$$;
