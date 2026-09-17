-- =============================================================================
-- Migration 0024 — Revisión/aprobación de inspecciones + checklist configurable
--
-- Soporta el módulo admin "Inspecciones" (rendio-turnos):
--   1. Estado de revisión en `inspections` (review_status / reviewed_by /
--      reviewed_at / review_notes). El estado lo fija el SERVIDOR vía trigger en
--      INSERT: 'pending' si la inspección inicial trae novedad (has_damage), de
--      lo contrario 'approved' automático (sin admin). El conductor NO puede
--      setearlo ni cambiarlo.
--   2. RPC `review_inspection` (SECURITY DEFINER, admin-only): aprueba/rechaza
--      y, al rechazar, abre una novedad (incident) para seguimiento. NO manda
--      el vehículo a mantenimiento automáticamente (decisión de producto).
--   3. Se elimina el UPDATE directo del conductor sobre `inspections`
--      (no lo usa; cierra el hueco de auto-aprobación). Toda revisión va por RPC.
--   4. Tabla `inspection_checklist_items`: checklist configurable por el admin
--      (CRUD + orden + activo), global por organización. Semilla = los 12 ítems
--      que estaban hardcodeados en el wizard. El wizard del conductor leerá de
--      aquí y guarda un snapshot por inspección (en inspections.checklist) para
--      que el historial no se altere si el checklist cambia luego.
--
-- Idempotente: DO/EXCEPTION, ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- DROP POLICY IF EXISTS, INSERT ... WHERE NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. review_status + columnas de revisión en inspections
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.inspection_review_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS review_status public.inspection_review_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes  text;

CREATE INDEX IF NOT EXISTS idx_inspections_review_status
  ON public.inspections (organization_id, review_status, performed_at DESC);

-- -----------------------------------------------------------------------------
-- 2. El estado de revisión lo fija el SERVIDOR en el INSERT.
--    Cualquier review_status entrante del cliente se sobreescribe → el conductor
--    no puede auto-aprobarse al crear la inspección.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_inspection_set_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'initial' AND NEW.has_damage THEN
    NEW.review_status := 'pending';
    NEW.reviewed_by   := NULL;
    NEW.reviewed_at   := NULL;
    NEW.review_notes  := NULL;
  ELSE
    -- sin novedad (o no es inspección inicial): aprobada automáticamente
    NEW.review_status := 'approved';
    NEW.reviewed_by   := NULL;
    NEW.reviewed_at   := now();
    NEW.review_notes  := NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tr_inspection_set_review ON public.inspections;
CREATE TRIGGER tr_inspection_set_review
  BEFORE INSERT ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.tg_inspection_set_review();

-- -----------------------------------------------------------------------------
-- 3. Cerrar el UPDATE directo del conductor (evita auto-aprobación).
--    La revisión se hace SOLO por la RPC review_inspection (SECURITY DEFINER).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_inspections_update_own ON public.inspections;

CREATE OR REPLACE FUNCTION public.review_inspection(
  p_inspection_id uuid,
  p_status        text,
  p_notes         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_insp public.inspections%ROWTYPE;
  v_uid  uuid := auth.uid();
  v_org  uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN';
  END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status;
  END IF;

  SELECT * INTO v_insp FROM public.inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSPECTION_NOT_FOUND'; END IF;
  IF v_insp.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;

  UPDATE public.inspections
     SET review_status = p_status::public.inspection_review_status,
         reviewed_by   = v_uid,
         reviewed_at   = now(),
         review_notes  = p_notes
   WHERE id = p_inspection_id;

  -- Al rechazar: abrir novedad formal para seguimiento (sin sacar el vehículo).
  IF p_status = 'rejected' THEN
    INSERT INTO public.incidents (organization_id, reporter_id, shift_id, vehicle_id, category, severity, description)
    VALUES (
      v_insp.organization_id, v_uid, v_insp.shift_id, v_insp.vehicle_id,
      'vehicle_problem', 'medium',
      'Inspección de inicio rechazada por el administrador'
        || COALESCE(': ' || NULLIF(btrim(p_notes), ''), '')
    );
  END IF;

  PERFORM public.log_audit_event(
    'inspection_reviewed', 'inspection', p_inspection_id,
    jsonb_build_object('status', p_status)
  );

  RETURN jsonb_build_object('ok', true, 'inspection_id', p_inspection_id, 'status', p_status);
END; $$;

REVOKE ALL ON FUNCTION public.review_inspection(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_inspection(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.review_inspection(uuid, text, text)
  IS 'Admin aprueba/rechaza una inspección. Al rechazar abre un incident. SECURITY DEFINER, valida rol admin + organización.';

-- -----------------------------------------------------------------------------
-- 4. Checklist configurable por el admin (global por organización)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inspection_checklist_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label           text        NOT NULL,
  hint            text,
  sort_order      int         NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_checklist_label_not_blank CHECK (length(btrim(label)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_inspection_checklist_org
  ON public.inspection_checklist_items (organization_id, sort_order);

DROP TRIGGER IF EXISTS tr_inspection_checklist_set_updated_at ON public.inspection_checklist_items;
CREATE TRIGGER tr_inspection_checklist_set_updated_at
  BEFORE UPDATE ON public.inspection_checklist_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inspection_checklist_items ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier usuario autenticado de la organización (drivers necesitan
-- los activos para el wizard; admins ven todos para configurar).
DROP POLICY IF EXISTS p_checklist_select_org ON public.inspection_checklist_items;
CREATE POLICY p_checklist_select_org
  ON public.inspection_checklist_items FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

-- Escritura (insert/update/delete): solo admin de la organización.
DROP POLICY IF EXISTS p_checklist_write_admin ON public.inspection_checklist_items;
CREATE POLICY p_checklist_write_admin
  ON public.inspection_checklist_items FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Semilla: los 12 ítems que estaban hardcodeados (una sola vez por organización).
INSERT INTO public.inspection_checklist_items (organization_id, label, hint, sort_order)
SELECT o.id, x.label, NULLIF(x.hint, ''), x.ord
  FROM public.organizations o
  CROSS JOIN (VALUES
    ('Llantas (4 + repuesto)',          'Presión y estado visual',     1),
    ('Luces delanteras',                'Altas, bajas, exploradoras',  2),
    ('Luces traseras y stops',          '',                            3),
    ('Direccionales',                   '',                            4),
    ('Frenos',                          'Pedal firme, sin ruidos',     5),
    ('Pito y cinturones',               '',                            6),
    ('Nivel de aceite',                 '',                            7),
    ('Refrigerante',                    '',                            8),
    ('Limpiaparabrisas y agua',         '',                            9),
    ('Espejos y vidrios',               '',                           10),
    ('SOAT, técnico-mecánica, tarjeta', '',                           11),
    ('Kit carretera + extintor',        '',                           12)
  ) AS x(label, hint, ord)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.inspection_checklist_items ci WHERE ci.organization_id = o.id
 );

COMMIT;
