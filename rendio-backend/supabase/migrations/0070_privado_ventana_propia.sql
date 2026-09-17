-- 0070_privado_ventana_propia.sql — El cupo del privado necesitaba su propio
-- parámetro, no uno prestado.
--
-- QUÉ SALIÓ MAL EN 0069
-- La 0069 calculaba "¿está ocupada la camioneta en esa franja?" con una ventana
-- tomada de `route_turnaround_min`. Suena razonable leído, y es incorrecto: ese
-- parámetro vale **8 minutos** en dev y describe otra cosa — cuánto tarda un
-- carro en dar la vuelta entre dos tramos de una misma ruta —, no cuánto queda
-- comprometido un vehículo por un viaje de ida y vuelta al aeropuerto.
--
-- CÓMO SE DETECTÓ
-- La prueba e2e aprobó dos traslados privados con media hora de diferencia. Con
-- una ventana de 8 minutos no se pisaban, así que el servidor dejó pasar los
-- dos: la camioneta quedaba prometida dos veces y alguien se iba a quedar sin
-- carro a las 5 de la mañana. Es exactamente el caso que 0069 decía impedir.
--
-- LA CORRECCIÓN
-- Un parámetro propio, `aux_private_block_min`, default 90 minutos, editable en
-- Ajustes. La lección de fondo: un número que significa una cosa no sirve para
-- otra solo porque las dos se midan en minutos.
--
-- Idempotente.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS aux_private_block_min integer NOT NULL DEFAULT 90;

COMMENT ON COLUMN public.app_settings.aux_private_block_min IS
  'Cuántos minutos queda apartada la camioneta a lado y lado de un traslado privado. De aquí sale el cupo. NO reutilizar route_turnaround_min: ese vale 8 y significa otra cosa.';

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_private_block_pos;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_private_block_pos CHECK (aux_private_block_min > 0);

CREATE OR REPLACE FUNCTION public.private_vehicle_busy_at(
  p_when      timestamptz,
  p_exclude   uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reservations r
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT aux_private_block_min FROM public.app_settings LIMIT 1), 90) AS win
    ) s
    WHERE r.service_level = 'private'
      AND r.private_status IN ('requested', 'approved')
      AND r.cancelled_at IS NULL
      AND (p_exclude IS NULL OR r.id <> p_exclude)
      AND r.required_arrival_at BETWEEN p_when - (s.win || ' minutes')::interval
                                    AND p_when + (s.win || ' minutes')::interval
  );
$$;

REVOKE ALL ON FUNCTION public.private_vehicle_busy_at(timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.private_vehicle_busy_at(timestamptz, uuid) TO authenticated;

COMMIT;
