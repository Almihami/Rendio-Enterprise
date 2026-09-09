-- 0068_reserva_tardia.down.sql — quita el detector de reservas sin carro.
--
-- Las eventualidades late_booking que haya abiertas se cierran (no se borran:
-- son historial real de la operación y el jefe puede querer verlas).

UPDATE public.incidents
   SET status = 'resolved', resolved_at = COALESCE(resolved_at, now()),
       resolution_notes = COALESCE(resolution_notes, 'Cerrada al revertir 0068.')
 WHERE category = 'late_booking' AND resolved_at IS NULL;

-- El reloj vuelve a llamar solo al detector de 0066.
DO $do$
BEGIN
  PERFORM cron.schedule('detect-ops-events', '*/5 * * * *',
    $job$SELECT public.detect_ops_events();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%).', SQLERRM;
END
$do$;

DROP FUNCTION IF EXISTS public.detect_late_bookings();
