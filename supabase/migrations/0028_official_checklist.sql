-- =============================================================================
-- Migration 0028 — Checklist diario oficial de vehículo (módulo rendio-turnos)
--
-- Los jefes entregaron el checklist oficial: 27 ítems en 6 secciones, más
-- estado APTO/NO APTO, firma del conductor y foto del golpe. Esta migración
-- agrega SOLO el schema; los 27 ítems se cargan con scripts/seed-official-checklist.mjs
-- (data por organización, idempotente).
--
--   1. inspection_checklist_items.category — sección del ítem (Exterior, Llantas,
--      Niveles y motor, Seguridad, Operación, Documentación).
--   2. inspections.is_apt    — estado explícito APTO (true) / NO APTO (false).
--   3. inspections.signed_name — firma digital: nombre del conductor que confirma.
--   4. inspection_photo_type += 'damage' — foto específica del golpe (1 por inspección,
--      cabe en el UNIQUE(inspection_id, photo_type) existente de 0016).
-- Todo aditivo (IF NOT EXISTS) → no toca datos existentes.
-- =============================================================================

-- Nuevo valor del enum de tipos de foto. Va suelto (autocommit) y NO se usa en
-- esta misma migración (solo lo usa la app en runtime), así que es seguro en PG15.
ALTER TYPE public.inspection_photo_type ADD VALUE IF NOT EXISTS 'damage';

BEGIN;

-- 1. Sección/categoría del ítem de checklist.
ALTER TABLE public.inspection_checklist_items
  ADD COLUMN IF NOT EXISTS category text;

COMMENT ON COLUMN public.inspection_checklist_items.category
  IS 'rendio-turnos: sección del checklist oficial (Exterior, Llantas, Niveles y motor, Seguridad, Operación, Documentación).';

-- 2 + 3. Estado APTO/NO APTO explícito y firma digital del conductor.
ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS is_apt      boolean,
  ADD COLUMN IF NOT EXISTS signed_name text;

COMMENT ON COLUMN public.inspections.is_apt
  IS 'rendio-turnos: estado oficial del vehículo en la inspección. true=APTO PARA OPERAR, false=NO APTO, null=no aplica/legado.';
COMMENT ON COLUMN public.inspections.signed_name
  IS 'rendio-turnos: firma digital — nombre del conductor que confirmó la inspección (la hora va en performed_at).';

COMMIT;
