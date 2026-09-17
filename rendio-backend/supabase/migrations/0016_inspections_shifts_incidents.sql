-- =============================================================================
-- Migration 0016 — shifts + inspections + inspection_photos + incidents + maintenance
-- Tarea contractual: E2.01 (brief de pendientes §2.1).
-- Nota de numeración: el brief llamaba a esta migration "0006", pero ese slot
-- ya está ocupado por 0006_storage_buckets.sql (bucket inspections, E1.09).
-- Aquí va el bloque de tablas operativas de turno e inspección.
--
-- Contiene:
--   - Enums nuevos: inspection_kind, inspection_photo_type, incident_status
--   - Tablas: shifts, inspections, inspection_photos, incidents, maintenance
--   - Triggers tr_*_set_updated_at
--   - Trigger trg_shifts_close_block_vehicle:
--       al cerrar un shift, si current_km - last_maintenance_km >= maintenance_interval_km,
--       el vehículo queda con status = 'blocked' (forzando mantenimiento).
--   - RLS habilitado + policies por rol/organización.
--
-- Enums REUTILIZADOS (ya existen en 0001):
--   shift_status, incident_severity, incident_category.
--
-- Helpers RLS REUTILIZADOS (ya existen en 0004/0010):
--   public.current_user_role(), public.current_user_org(), public.current_driver_id().
--
-- Idempotente: CREATE TABLE IF NOT EXISTS, DO $$ ... duplicate_object para enums,
-- DROP TRIGGER IF EXISTS, DROP POLICY IF EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Enums nuevos
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.inspection_kind AS ENUM ('initial', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.inspection_photo_type AS ENUM (
    'front',
    'left',
    'right',
    'rear',
    'dashboard'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.incident_status AS ENUM ('open', 'in_progress', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- shifts — turno operativo del driver con un vehículo asignado
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shifts (
  id                 uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid                 NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  driver_id          uuid                 NOT NULL REFERENCES public.driver_profiles(id) ON DELETE RESTRICT,
  vehicle_id         uuid                 NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  status             public.shift_status  NOT NULL DEFAULT 'vehicle_selected',
  start_at           timestamptz          NOT NULL DEFAULT now(),
  end_at             timestamptz,
  opening_km         int,
  closing_km         int,
  notes              text,
  created_at         timestamptz          NOT NULL DEFAULT now(),
  updated_at         timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT shifts_opening_km_non_negative CHECK (opening_km IS NULL OR opening_km >= 0),
  CONSTRAINT shifts_closing_km_non_negative CHECK (closing_km IS NULL OR closing_km >= 0),
  CONSTRAINT shifts_closing_ge_opening      CHECK (
    closing_km IS NULL OR opening_km IS NULL OR closing_km >= opening_km
  ),
  CONSTRAINT shifts_end_ge_start             CHECK (end_at IS NULL OR end_at >= start_at)
);

CREATE INDEX IF NOT EXISTS idx_shifts_organization_id ON public.shifts(organization_id);
CREATE INDEX IF NOT EXISTS idx_shifts_driver_id       ON public.shifts(driver_id);
CREATE INDEX IF NOT EXISTS idx_shifts_vehicle_id      ON public.shifts(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status          ON public.shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_driver_open
  ON public.shifts(driver_id)
  WHERE status <> 'closed';

DROP TRIGGER IF EXISTS tr_shifts_set_updated_at ON public.shifts;
CREATE TRIGGER tr_shifts_set_updated_at
  BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- inspections — inspección vehicular ligada a un shift (initial | final)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inspections (
  id                 uuid                       PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid                       NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shift_id           uuid                       NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  vehicle_id         uuid                       NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  driver_id          uuid                       NOT NULL REFERENCES public.driver_profiles(id) ON DELETE RESTRICT,
  kind               public.inspection_kind     NOT NULL,
  odometer_km        int                        NOT NULL,
  checklist          jsonb                      NOT NULL DEFAULT '{}'::jsonb,
  has_damage         boolean                    NOT NULL DEFAULT false,
  notes              text,
  performed_at       timestamptz                NOT NULL DEFAULT now(),
  created_at         timestamptz                NOT NULL DEFAULT now(),
  updated_at         timestamptz                NOT NULL DEFAULT now(),
  CONSTRAINT inspections_odometer_non_negative CHECK (odometer_km >= 0),
  CONSTRAINT inspections_one_kind_per_shift    UNIQUE (shift_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_inspections_organization_id ON public.inspections(organization_id);
CREATE INDEX IF NOT EXISTS idx_inspections_shift_id        ON public.inspections(shift_id);
CREATE INDEX IF NOT EXISTS idx_inspections_vehicle_id      ON public.inspections(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_inspections_driver_id       ON public.inspections(driver_id);
CREATE INDEX IF NOT EXISTS idx_inspections_kind            ON public.inspections(kind);

DROP TRIGGER IF EXISTS tr_inspections_set_updated_at ON public.inspections;
CREATE TRIGGER tr_inspections_set_updated_at
  BEFORE UPDATE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- inspection_photos — fotos vinculadas (front/left/right/rear/dashboard)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inspection_photos (
  id                 uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id      uuid                            NOT NULL REFERENCES public.inspections(id) ON DELETE CASCADE,
  organization_id    uuid                            NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  photo_type         public.inspection_photo_type   NOT NULL,
  storage_path       text                            NOT NULL,
  size_bytes         int,
  taken_at           timestamptz                     NOT NULL DEFAULT now(),
  created_at         timestamptz                     NOT NULL DEFAULT now(),
  CONSTRAINT inspection_photos_unique_per_inspection UNIQUE (inspection_id, photo_type),
  CONSTRAINT inspection_photos_size_non_negative     CHECK (size_bytes IS NULL OR size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection_id ON public.inspection_photos(inspection_id);
CREATE INDEX IF NOT EXISTS idx_inspection_photos_organization_id ON public.inspection_photos(organization_id);

ALTER TABLE public.inspection_photos ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- incidents — reportes de novedades operativas
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.incidents (
  id                 uuid                          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid                          NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  reporter_id        uuid                          NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  shift_id           uuid                          REFERENCES public.shifts(id) ON DELETE SET NULL,
  vehicle_id         uuid                          REFERENCES public.vehicles(id) ON DELETE SET NULL,
  reservation_id     uuid                          REFERENCES public.reservations(id) ON DELETE SET NULL,
  category           public.incident_category      NOT NULL,
  severity           public.incident_severity      NOT NULL DEFAULT 'low',
  status             public.incident_status        NOT NULL DEFAULT 'open',
  description        text                          NOT NULL,
  photo_paths        jsonb                         NOT NULL DEFAULT '[]'::jsonb,
  assigned_to        uuid                          REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution_notes   text,
  resolved_at        timestamptz,
  created_at         timestamptz                   NOT NULL DEFAULT now(),
  updated_at         timestamptz                   NOT NULL DEFAULT now(),
  CONSTRAINT incidents_description_not_blank CHECK (length(btrim(description)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_incidents_organization_id ON public.incidents(organization_id);
CREATE INDEX IF NOT EXISTS idx_incidents_reporter_id     ON public.incidents(reporter_id);
CREATE INDEX IF NOT EXISTS idx_incidents_shift_id        ON public.incidents(shift_id);
CREATE INDEX IF NOT EXISTS idx_incidents_vehicle_id      ON public.incidents(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status          ON public.incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity        ON public.incidents(severity);

DROP TRIGGER IF EXISTS tr_incidents_set_updated_at ON public.incidents;
CREATE TRIGGER tr_incidents_set_updated_at
  BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- maintenance — historial de mantenimientos por vehículo
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.maintenance (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid          NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  vehicle_id         uuid          NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  performed_by       uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  maintenance_type   text          NOT NULL,
  km_at_event        int           NOT NULL,
  cost_cop           numeric(12,0),
  performed_at       timestamptz   NOT NULL DEFAULT now(),
  notes              text,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_type_not_blank      CHECK (length(btrim(maintenance_type)) > 0),
  CONSTRAINT maintenance_km_non_negative     CHECK (km_at_event >= 0),
  CONSTRAINT maintenance_cost_non_negative   CHECK (cost_cop IS NULL OR cost_cop >= 0)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_organization_id ON public.maintenance(organization_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle_id      ON public.maintenance(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_performed_at    ON public.maintenance(performed_at);

DROP TRIGGER IF EXISTS tr_maintenance_set_updated_at ON public.maintenance;
CREATE TRIGGER tr_maintenance_set_updated_at
  BEFORE UPDATE ON public.maintenance
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.maintenance ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- TRIGGER: al cerrar shift, bloquear vehículo si superó intervalo de mantto
-- =============================================================================

CREATE OR REPLACE FUNCTION public.shifts_close_block_vehicle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_km        int;
  v_last_maint_km     int;
  v_interval_km       int;
BEGIN
  -- Solo nos interesa la transición a 'closed'
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  -- Si el shift trae closing_km, actualizamos el vehículo (la fuente de verdad
  -- queda en vehicles.current_km).
  IF NEW.closing_km IS NOT NULL THEN
    UPDATE public.vehicles
       SET current_km = GREATEST(current_km, NEW.closing_km)
     WHERE id = NEW.vehicle_id;
  END IF;

  SELECT current_km, last_maintenance_km, maintenance_interval_km
    INTO v_current_km, v_last_maint_km, v_interval_km
    FROM public.vehicles
   WHERE id = NEW.vehicle_id;

  IF v_current_km IS NULL THEN
    RETURN NEW;
  END IF;

  IF (v_current_km - v_last_maint_km) >= v_interval_km THEN
    UPDATE public.vehicles
       SET status = 'blocked'
     WHERE id = NEW.vehicle_id
       AND status <> 'blocked';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shifts_close_block_vehicle ON public.shifts;
CREATE TRIGGER trg_shifts_close_block_vehicle
  AFTER UPDATE OF status, closing_km ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.shifts_close_block_vehicle();

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- shifts
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_shifts_select_own ON public.shifts;
CREATE POLICY p_shifts_select_own
  ON public.shifts FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_id());

DROP POLICY IF EXISTS p_shifts_select_admin ON public.shifts;
CREATE POLICY p_shifts_select_admin
  ON public.shifts FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_shifts_insert_own ON public.shifts;
CREATE POLICY p_shifts_insert_own
  ON public.shifts FOR INSERT TO authenticated
  WITH CHECK (
    (driver_id = public.current_driver_id() AND organization_id = public.current_user_org())
    OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  );

DROP POLICY IF EXISTS p_shifts_update_own ON public.shifts;
CREATE POLICY p_shifts_update_own
  ON public.shifts FOR UPDATE TO authenticated
  USING (
    driver_id = public.current_driver_id()
    OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  )
  WITH CHECK (
    driver_id = public.current_driver_id()
    OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  );

DROP POLICY IF EXISTS p_shifts_delete_admin ON public.shifts;
CREATE POLICY p_shifts_delete_admin
  ON public.shifts FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- -----------------------------------------------------------------------------
-- inspections
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_inspections_select_own ON public.inspections;
CREATE POLICY p_inspections_select_own
  ON public.inspections FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_id());

DROP POLICY IF EXISTS p_inspections_select_admin ON public.inspections;
CREATE POLICY p_inspections_select_admin
  ON public.inspections FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_inspections_insert_own ON public.inspections;
CREATE POLICY p_inspections_insert_own
  ON public.inspections FOR INSERT TO authenticated
  WITH CHECK (
    driver_id = public.current_driver_id()
    AND organization_id = public.current_user_org()
  );

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

DROP POLICY IF EXISTS p_inspections_delete_admin ON public.inspections;
CREATE POLICY p_inspections_delete_admin
  ON public.inspections FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- -----------------------------------------------------------------------------
-- inspection_photos
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_inspection_photos_select_own ON public.inspection_photos;
CREATE POLICY p_inspection_photos_select_own
  ON public.inspection_photos FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inspections i
       WHERE i.id = inspection_photos.inspection_id
         AND i.driver_id = public.current_driver_id()
    )
  );

DROP POLICY IF EXISTS p_inspection_photos_select_admin ON public.inspection_photos;
CREATE POLICY p_inspection_photos_select_admin
  ON public.inspection_photos FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_inspection_photos_insert_own ON public.inspection_photos;
CREATE POLICY p_inspection_photos_insert_own
  ON public.inspection_photos FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.current_user_org()
    AND EXISTS (
      SELECT 1 FROM public.inspections i
       WHERE i.id = inspection_photos.inspection_id
         AND i.driver_id = public.current_driver_id()
         AND i.organization_id = public.current_user_org()
    )
  );

DROP POLICY IF EXISTS p_inspection_photos_delete_admin ON public.inspection_photos;
CREATE POLICY p_inspection_photos_delete_admin
  ON public.inspection_photos FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- -----------------------------------------------------------------------------
-- incidents
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_incidents_select_own ON public.incidents;
CREATE POLICY p_incidents_select_own
  ON public.incidents FOR SELECT TO authenticated
  USING (reporter_id = auth.uid());

DROP POLICY IF EXISTS p_incidents_select_admin ON public.incidents;
CREATE POLICY p_incidents_select_admin
  ON public.incidents FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_incidents_insert_own ON public.incidents;
CREATE POLICY p_incidents_insert_own
  ON public.incidents FOR INSERT TO authenticated
  WITH CHECK (
    reporter_id = auth.uid()
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_incidents_update_admin ON public.incidents;
CREATE POLICY p_incidents_update_admin
  ON public.incidents FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_incidents_delete_admin ON public.incidents;
CREATE POLICY p_incidents_delete_admin
  ON public.incidents FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- -----------------------------------------------------------------------------
-- maintenance (admin-only)
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS p_maintenance_select_admin ON public.maintenance;
CREATE POLICY p_maintenance_select_admin
  ON public.maintenance FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_maintenance_insert_admin ON public.maintenance;
CREATE POLICY p_maintenance_insert_admin
  ON public.maintenance FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_maintenance_update_admin ON public.maintenance;
CREATE POLICY p_maintenance_update_admin
  ON public.maintenance FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

DROP POLICY IF EXISTS p_maintenance_delete_admin ON public.maintenance;
CREATE POLICY p_maintenance_delete_admin
  ON public.maintenance FOR DELETE TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND organization_id = public.current_user_org()
  );

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.shifts             IS 'Turno operativo del driver (vehículo asignado, km de apertura/cierre, status).';
COMMENT ON TABLE public.inspections        IS 'Inspección vehicular ligada a un shift, kind=initial|final, con checklist en jsonb.';
COMMENT ON TABLE public.inspection_photos  IS 'Fotos de inspección (5 por inspección): front, left, right, rear, dashboard. storage_path apunta al bucket inspections.';
COMMENT ON TABLE public.incidents          IS 'Reportes operativos de auxiliares/drivers/admin: novedades, daños, demoras, etc.';
COMMENT ON TABLE public.maintenance        IS 'Historial de mantenimientos realizados a un vehículo.';

COMMENT ON COLUMN public.shifts.status              IS 'vehicle_selected → inspection_in_progress → active → closing → closed.';
COMMENT ON COLUMN public.inspections.kind           IS 'initial: apertura de turno; final: cierre de turno.';
COMMENT ON COLUMN public.inspections.checklist      IS 'JSONB con cada item del checklist (frenos, luces, llantas, niveles, espejos, cinturones).';
COMMENT ON COLUMN public.inspection_photos.photo_type IS 'Una sola foto por tipo por inspección (constraint UNIQUE).';
COMMENT ON COLUMN public.incidents.photo_paths      IS 'Array JSONB de paths del bucket inspections (o uno paralelo si se requiere).';
COMMENT ON COLUMN public.maintenance.cost_cop       IS 'Costo en pesos colombianos (sin decimales).';

COMMIT;
