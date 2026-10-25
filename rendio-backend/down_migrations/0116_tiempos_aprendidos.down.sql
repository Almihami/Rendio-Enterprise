-- Down de 0116: quita la medición de tiempos (el reloj, las funciones y las dos
-- tablas). Las marcas de los conductores (route_stops.actual_*) NO se tocan: de
-- ahí se puede volver a medir todo aplicando 0116 otra vez. Lo que sí se pierde
-- es la comprobación contra el GPS de lo que tenga más de 7 días.
BEGIN;
DO $do$
BEGIN
  PERFORM cron.unschedule('collect-trip-legs');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'collect-trip-legs no estaba programado (%)', SQLERRM;
END
$do$;
DROP FUNCTION IF EXISTS public.admin_learned_times(integer, integer);
DROP FUNCTION IF EXISTS public.admin_collect_trip_legs();
DROP FUNCTION IF EXISTS public.collect_trip_legs(timestamptz);
DROP FUNCTION IF EXISTS public.trip_leg_add(uuid, uuid, uuid, public.trip_direction, text, uuid, uuid, uuid, uuid,
  double precision, double precision, double precision, double precision, timestamptz, timestamptz,
  integer, timestamptz, timestamptz, integer, integer, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.marca_gps_m(uuid, timestamptz, double precision, double precision);
DROP FUNCTION IF EXISTS public.tramo_distancia_txt(integer);
DROP FUNCTION IF EXISTS public.zona_efectiva(text, double precision, double precision);
DROP FUNCTION IF EXISTS public.zona_contiene_punto(jsonb, double precision, double precision);
DROP FUNCTION IF EXISTS public.tramo_km(double precision, double precision, double precision, double precision);
DROP TABLE IF EXISTS public.route_trip_legs_runs;
DROP TABLE IF EXISTS public.route_trip_legs;
COMMIT;
