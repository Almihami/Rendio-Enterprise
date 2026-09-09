-- =============================================================================
-- 0078 · LOS NIVELES PREVENTIVOS ARRANCAN AL DÍA, NO VENCIDOS
--
-- EL PROBLEMA. La 0073 trajo la revisión preventiva por kilometraje (5k, 10k,
-- 20k, 40k) y su tabla de control `vehicle_tier_state`, pero no la sembró. Con
-- la tabla vacía, pending_inspection_tiers compara contra COALESCE(last_done_km,
-- 0), así que un carro con 190.000 km sale debiendo LOS CUATRO NIVELES A LA VEZ
-- desde el primer minuto.
--
-- Qué pasaba mañana a las 4 a. m. (medido en producción el 4-sep-2026):
--
--   HNV760              190.679 km → niveles [40k,20k,10k,5k] → 41 ítems
--   HYU376              238.153 km → niveles [40k,20k,10k,5k] → 41 ítems
--   LOCALIZA REEMPLAZO  133.431 km → niveles [40k,20k,10k,5k] → 41 ítems
--   PRW443               15.550 km → niveles [10k,5k]         → 35 ítems
--
-- El conductor de madrugada, en un parqueadero y a oscuras, tendría que
-- responder "espesor de pastillas y bandas" y "juego de rótulas y terminales"
-- para poder arrancar — y el asistente no deja pasar sin contestar.
--
-- LA CORRECCIÓN. Se marca cada nivel como recién hecho AL KILOMETRAJE ACTUAL de
-- cada carro. No es inventar un dato: es declarar el punto de partida del
-- contador, que es justo lo que faltaba. A partir de aquí los niveles vencen
-- solos y de a uno, cuando el carro recorra los kilómetros de verdad.
--
-- Ojo con el carro en 0 km (LFO714): no se le siembra nada. Su primer nivel
-- llegará cuando empiece a rodar, que es lo correcto.
-- =============================================================================

BEGIN;

INSERT INTO public.vehicle_tier_state (organization_id, vehicle_id, every_km, last_done_km, last_done_at)
SELECT v.organization_id, v.id, t.every_km, COALESCE(v.current_km, 0), now()
  FROM public.vehicles v
  CROSS JOIN (SELECT DISTINCT every_km FROM public.inspection_tiers) t
 WHERE COALESCE(v.current_km, 0) > 0
ON CONFLICT (vehicle_id, every_km) DO NOTHING;

COMMIT;
