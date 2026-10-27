-- =============================================================================
-- 0148 · Sin la FK de plan_vehicle_id (0132): Asignación y Operación vuelven a
--        leer lo publicado   (26-oct-2026)
-- =============================================================================
-- 0132 creó route_assignments.plan_vehicle_id REFERENCES vehicles. Con eso entre
-- route_assignments y vehicles quedan DOS relaciones (vehicle_id y plan_vehicle_id)
-- y PostgREST ya no sabe cuál usar: todo select que embebe `vehicles(...)` desde
-- route_assignments falla con PGRST201 («more than one relationship was found for
-- 'route_assignments' and 'vehicles'»). En la app: getPublishedPlan (Asignación
-- muestra el día «sin publicar») y listLiveOperation (Operación sin vueltas).
--
-- En PRODUCCIÓN ya se quitó a mano el 26-oct (~1 p. m., con OK de la profa):
--   ALTER TABLE public.route_assignments DROP CONSTRAINT route_assignments_plan_vehicle_id_fkey;
--   NOTIFY pgrst, 'reload schema';
-- (definición guardada en Rendio-Drivers/respaldo-produccion-2026-10-26-pre-quitar-fk-0132/amarre.sql).
-- Esta migración deja eso escrito y lo hace donde falte (dev, local). En
-- producción no cambia nada (IF EXISTS).
--
-- La COLUMNA se queda igual: es la indicación del plan («Carro 1 = PRW443»).
-- Nadie la embebe: el front saca la placa de la flota (placasDelPlan) y las
-- funciones SQL (0132, 0134, 0135, 0140) la cruzan con LEFT JOIN, que no necesita
-- la FK. Los carros se borran con deleted_at, así que el ON DELETE SET NULL no se
-- usaba; un id que ya no exista sale sin placa («otro carro»), nunca un error.
--
-- Para volver a ponerla, ANTES cambiar cada embed a
-- vehicles!route_assignments_vehicle_id_fkey(...): api.js (getPublishedPlan y
-- listLiveOperation) y scripts _e2e-admin-live.mjs y _e2e-cars.mjs.
-- =============================================================================

BEGIN;

ALTER TABLE public.route_assignments
  DROP CONSTRAINT IF EXISTS route_assignments_plan_vehicle_id_fkey;

COMMENT ON COLUMN public.route_assignments.plan_vehicle_id IS
  '0132: el carro físico que el plan le pone a esta vuelta («Carro 1 = PRW443»). Indicación para el conductor; la placa real (vehicle_id) la sigue poniendo el turno (0124). Si inicia turno en otro, se avisa a los jefes. 0148: sin FK a vehicles (con ella todo embed vehicles(...) desde route_assignments da PGRST201).';

COMMIT;

NOTIFY pgrst, 'reload schema';
