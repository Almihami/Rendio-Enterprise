-- Down de 0028 — checklist oficial. (No se quita el valor 'damage' del enum:
-- Postgres no permite DROP de un valor de enum; queda inocuo.)

ALTER TABLE public.inspections
  DROP COLUMN IF EXISTS signed_name,
  DROP COLUMN IF EXISTS is_apt;

ALTER TABLE public.inspection_checklist_items
  DROP COLUMN IF EXISTS category;
