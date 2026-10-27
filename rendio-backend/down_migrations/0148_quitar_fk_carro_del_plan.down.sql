-- Down de 0148: vuelve la FK de 0132 (plan_vehicle_id → vehicles).
-- OJO: con ella todo embed vehicles(...) desde route_assignments vuelve a dar
-- PGRST201. Antes de correr esto, cambiar esos embeds a
-- vehicles!route_assignments_vehicle_id_fkey(...) (api.js: getPublishedPlan y
-- listLiveOperation; scripts _e2e-admin-live.mjs y _e2e-cars.mjs).
BEGIN;

UPDATE public.route_assignments ra SET plan_vehicle_id = NULL
 WHERE ra.plan_vehicle_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = ra.plan_vehicle_id);

ALTER TABLE public.route_assignments
  ADD CONSTRAINT route_assignments_plan_vehicle_id_fkey
  FOREIGN KEY (plan_vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
