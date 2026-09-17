-- =============================================================================
-- Migration 0034 — Cierre de turno del conductor (Etapa 2)
--
-- Hasta ahora un turno llegaba a 'active' y solo lo cerraba el admin/cron
-- (force_close_shift / auto_close). Esta migración da el cierre normal del
-- conductor:
--   1. fuel_receipts — comprobantes de tanqueo del turno (foto + valor). El admin
--      los revisa para control de gasto. Foto en el bucket privado 'inspections'.
--   2. close_shift(...) — RPC SECURITY DEFINER (conductor): valida dueño, turno
--      activo y km final >= apertura; registra la inspección FINAL (kind='final',
--      odómetro = km final), cierra el turno (status closed, end_at, closing_km)
--      y libera el vehículo (in_use -> available). Si hubo novedad, abre un
--      incident con su evidencia. Todo en una transacción (atómico/idempotente:
--      si ya está cerrado, no hace nada).
--
-- La inspección 'final' se anexa al MISMO turno que la inicial → el panel admin
-- de Inspecciones puede mostrar inicio + cierre juntos.
--
-- Reusa: tabla incidents (0016), enum inspection_kind 'final' (0016), bucket
-- 'inspections' (0006), trigger shifts_close_block_vehicle (0016, bloquea por
-- mantto si corresponde al cerrar).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. fuel_receipts — comprobantes de tanqueo
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fuel_receipts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid          NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shift_id          uuid          NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  vehicle_id        uuid          NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  driver_id         uuid          NOT NULL REFERENCES public.driver_profiles(id) ON DELETE RESTRICT,
  amount_cop        numeric(12,0) NOT NULL,
  storage_path      text          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT fuel_receipts_amount_non_negative CHECK (amount_cop >= 0),
  CONSTRAINT fuel_receipts_unique_path UNIQUE (shift_id, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_fuel_receipts_shift_id   ON public.fuel_receipts(shift_id);
CREATE INDEX IF NOT EXISTS idx_fuel_receipts_driver_id  ON public.fuel_receipts(driver_id);
CREATE INDEX IF NOT EXISTS idx_fuel_receipts_org        ON public.fuel_receipts(organization_id);

DROP TRIGGER IF EXISTS tr_fuel_receipts_set_updated_at ON public.fuel_receipts;
CREATE TRIGGER tr_fuel_receipts_set_updated_at
  BEFORE UPDATE ON public.fuel_receipts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.fuel_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_fuel_receipts_select_own ON public.fuel_receipts;
CREATE POLICY p_fuel_receipts_select_own
  ON public.fuel_receipts FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_id());

DROP POLICY IF EXISTS p_fuel_receipts_select_admin ON public.fuel_receipts;
CREATE POLICY p_fuel_receipts_select_admin
  ON public.fuel_receipts FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_fuel_receipts_insert_own ON public.fuel_receipts;
CREATE POLICY p_fuel_receipts_insert_own
  ON public.fuel_receipts FOR INSERT TO authenticated
  WITH CHECK (driver_id = public.current_driver_id() AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_fuel_receipts_delete_own ON public.fuel_receipts;
CREATE POLICY p_fuel_receipts_delete_own
  ON public.fuel_receipts FOR DELETE TO authenticated
  USING (driver_id = public.current_driver_id() OR (public.current_user_role() = 'admin' AND organization_id = public.current_user_org()));

COMMENT ON TABLE public.fuel_receipts IS 'Comprobantes de tanqueo de un turno (foto en bucket inspections + valor en COP). Para control de gasto del admin.';

-- -----------------------------------------------------------------------------
-- 2. close_shift — cierre normal del turno por el conductor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_shift(
  p_shift_id     uuid,
  p_closing_km   int,
  p_has_novedad  boolean DEFAULT false,
  p_novedad_text text    DEFAULT NULL,
  p_severity     text    DEFAULT 'low',
  p_media_paths  jsonb   DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_shift     public.shifts%ROWTYPE;
  v_driver_id uuid;
  v_insp_id   uuid;
  v_sev       public.incident_severity;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_DRIVER: el usuario no tiene driver_profile';
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;
  IF v_shift.driver_id <> v_driver_id THEN
    RAISE EXCEPTION 'NOT_SHIFT_OWNER';
  END IF;

  -- Idempotente: si ya está cerrado, no hace nada (retry seguro).
  IF v_shift.status = 'closed' THEN
    RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed', 'noop', true);
  END IF;
  IF v_shift.status NOT IN ('active', 'closing') THEN
    RAISE EXCEPTION 'INVALID_SHIFT_STATUS: solo se cierra un turno activo (%)', v_shift.status;
  END IF;
  IF p_closing_km IS NULL THEN
    RAISE EXCEPTION 'CLOSING_KM_REQUIRED';
  END IF;
  IF v_shift.opening_km IS NOT NULL AND p_closing_km < v_shift.opening_km THEN
    RAISE EXCEPTION 'CLOSING_KM_LT_OPENING: el km final (%) no puede ser menor al de apertura (%)', p_closing_km, v_shift.opening_km;
  END IF;

  -- Inspección FINAL (registro de odómetro de cierre). Anexa al mismo turno.
  INSERT INTO public.inspections (organization_id, shift_id, vehicle_id, driver_id, kind, odometer_km, has_damage, notes)
  VALUES (v_shift.organization_id, v_shift.id, v_shift.vehicle_id, v_driver_id, 'final', p_closing_km,
          COALESCE(p_has_novedad, false),
          NULLIF(btrim(coalesce(p_novedad_text, '')), ''))
  ON CONFLICT (shift_id, kind) DO UPDATE
    SET odometer_km = EXCLUDED.odometer_km, has_damage = EXCLUDED.has_damage, notes = EXCLUDED.notes
  RETURNING id INTO v_insp_id;

  -- Cerrar el turno (dispara shifts_close_block_vehicle: actualiza current_km y
  -- bloquea por mantto si corresponde).
  UPDATE public.shifts
     SET status = 'closed', end_at = now(), closing_km = p_closing_km
   WHERE id = v_shift.id;

  -- Liberar el vehículo si quedó 'in_use' (el trigger no lo libera; si lo dejó
  -- 'blocked' por mantto, se respeta).
  UPDATE public.vehicles
     SET status = 'available'
   WHERE id = v_shift.vehicle_id AND status = 'in_use';

  -- Novedad de cierre → incident con evidencia (fotos/video en p_media_paths).
  IF COALESCE(p_has_novedad, false) AND NULLIF(btrim(coalesce(p_novedad_text, '')), '') IS NOT NULL THEN
    v_sev := CASE lower(coalesce(p_severity, 'low'))
               WHEN 'high' THEN 'high'::public.incident_severity
               WHEN 'grave' THEN 'high'::public.incident_severity
               WHEN 'medium' THEN 'medium'::public.incident_severity
               WHEN 'media' THEN 'medium'::public.incident_severity
               ELSE 'low'::public.incident_severity
             END;
    INSERT INTO public.incidents (organization_id, reporter_id, shift_id, vehicle_id, category, severity, description, photo_paths)
    VALUES (v_shift.organization_id, auth.uid(), v_shift.id, v_shift.vehicle_id,
            'vehicle_problem', v_sev,
            'Cierre de turno — ' || btrim(p_novedad_text),
            COALESCE(p_media_paths, '[]'::jsonb));
  END IF;

  PERFORM public.log_audit_event(
    'shift_closed', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'closing_km', p_closing_km, 'novedad', COALESCE(p_has_novedad, false))
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed',
                            'inspection_id', v_insp_id,
                            'km_driven', GREATEST(0, p_closing_km - COALESCE(v_shift.opening_km, p_closing_km)));
END;
$fn$;

REVOKE ALL ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb)
  IS 'Cierre normal del turno por el conductor: valida km final, registra inspección final, cierra el turno, libera el vehículo y abre incident si hubo novedad. SECURITY DEFINER, idempotente.';

COMMIT;
