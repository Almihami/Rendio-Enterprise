-- Down de 0024 — revisión de inspecciones + checklist configurable
BEGIN;

DROP TABLE IF EXISTS public.inspection_checklist_items CASCADE;

DROP FUNCTION IF EXISTS public.review_inspection(uuid, text, text);

DROP TRIGGER IF EXISTS tr_inspection_set_review ON public.inspections;
DROP FUNCTION IF EXISTS public.tg_inspection_set_review();

-- Restaurar la política de UPDATE del conductor (estado previo a 0024).
DROP POLICY IF EXISTS p_inspections_update_own ON public.inspections;
CREATE POLICY p_inspections_update_own
  ON public.inspections FOR UPDATE TO authenticated
  USING (
    driver_id = public.current_driver_id()
    OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  )
  WITH CHECK (
    driver_id = public.current_driver_id()
    OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  );

DROP INDEX IF EXISTS public.idx_inspections_review_status;

ALTER TABLE public.inspections
  DROP COLUMN IF EXISTS review_notes,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS review_status;

DROP TYPE IF EXISTS public.inspection_review_status;

COMMIT;
