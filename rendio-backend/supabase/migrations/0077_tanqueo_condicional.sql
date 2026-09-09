-- =============================================================================
-- 0077 · EL TANQUEO DEJA DE SER OBLIGATORIO PARA CERRAR EL TURNO
--
-- POR QUÉ. Hasta hoy, para cerrar turno había que adjuntar comprobante de
-- tanqueo sí o sí. Eso salía de que tanquear era obligatorio antes de entregar
-- el carro — pero se hacía en el cambio de turno, CON LOS TRIPULANTES A BORDO,
-- y ellos se quejaron. Julián cambió el procedimiento (nota de voz, 3-sep-2026):
-- el conductor tanquea un par de horas antes, sin pasajeros. Y como a veces no
-- va a poder, el cierre necesita preguntarlo:
--
--     ¿Ya pudo tanquear?   SÍ → comprobante, como siempre.
--                          NO → motivo, obligatorio.
--
-- OJO CON LA OBLIGATORIEDAD ANTERIOR: nunca existió en la base de datos. Vivía
-- SOLO en el navegador (shift-flow.js, receiptsValid). El RPC close_shift no
-- menciona fuel_receipts ni una vez. Por eso esta migración no "afloja" nada:
-- solo crea dónde guardar el "no pude, y por esto".
--
-- POR QUÉ NO SE TOCA fuel_receipts. Sería lo obvio —un recibo "vacío"— y sería
-- un error: amount_cop y storage_path son NOT NULL, y el UNIQUE (shift_id,
-- storage_path) es lo que hace idempotente el reintento de subida. Volverlos
-- nullable rompe las dos cosas (en Postgres NULL ≠ NULL, así que el UNIQUE deja
-- de proteger) y descuadra el total que suma el admin.
--
-- POR QUÉ LOS MOTIVOS SON UNA TABLA Y NO UN ENUM. Si el motivo fuera texto
-- libre, diez conductores escribirían "estacion cerrada", "cerrado" y "no habia
-- bomba abierta" para lo mismo, y Julián no podría contar nada. Si fuera un
-- enum, cambiar la lista exigiría una migración cada vez. Catálogo editable,
-- igual que inspection_checklist_items (0024): él ajusta los motivos desde
-- Ajustes y nadie toca código.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Catálogo de motivos (editable por el admin)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.no_fuel_reasons (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label           text        NOT NULL,
  -- El motivo "Otro": obliga al conductor a escribir. Lo marca una bandera y no
  -- el texto de la etiqueta, para que renombrarlo no rompa el comportamiento.
  requires_text   boolean     NOT NULL DEFAULT false,
  sort_order      int         NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_fuel_reasons_label_not_blank CHECK (length(btrim(label)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_no_fuel_reasons_org
  ON public.no_fuel_reasons (organization_id, sort_order);

DROP TRIGGER IF EXISTS tr_no_fuel_reasons_set_updated_at ON public.no_fuel_reasons;
CREATE TRIGGER tr_no_fuel_reasons_set_updated_at
  BEFORE UPDATE ON public.no_fuel_reasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.no_fuel_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_no_fuel_reasons_select_org ON public.no_fuel_reasons;
CREATE POLICY p_no_fuel_reasons_select_org
  ON public.no_fuel_reasons FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_no_fuel_reasons_write_admin ON public.no_fuel_reasons;
CREATE POLICY p_no_fuel_reasons_write_admin
  ON public.no_fuel_reasons FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Semilla PROVISIONAL. Son una apuesta, no una decisión: Julián todavía no ha
-- dicho cuáles son las razones que de verdad pasan. Por eso van en tabla — las
-- cambia él desde Ajustes sin que nadie vuelva aquí.
INSERT INTO public.no_fuel_reasons (organization_id, label, requires_text, sort_order)
SELECT o.id, v.label, v.requires_text, v.sort_order
  FROM public.organizations o
 CROSS JOIN (VALUES
   ('La estación estaba cerrada',            false, 10),
   ('No alcanzó el tiempo',                  false, 20),
   ('Falla con el medio de pago',            false, 30),
   ('Otro',                                  true,  90)
 ) AS v(label, requires_text, sort_order)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.no_fuel_reasons r WHERE r.organization_id = o.id
 );

-- -----------------------------------------------------------------------------
-- 2. El turno guarda si se tanqueó y, si no, por qué
-- -----------------------------------------------------------------------------
-- `fueled` queda NULLABLE y SIN default a propósito: los turnos ya cerrados no
-- respondieron esta pregunta. Ponerles `true` sería inventarles un dato, y
-- ponerles `false` los dejaría incumpliendo el CHECK.
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS fueled             boolean,
  ADD COLUMN IF NOT EXISTS no_fuel_reason_id  uuid REFERENCES public.no_fuel_reasons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_fuel_reason     text;

COMMENT ON COLUMN public.shifts.fueled IS
  'true = tanqueó y adjuntó comprobante · false = no pudo (ver no_fuel_reason) · NULL = turno anterior a 0077, no se preguntó.';
COMMENT ON COLUMN public.shifts.no_fuel_reason IS
  'Texto SIEMPRE legible: copia de la etiqueta del motivo elegido, o lo que escribió el conductor si el motivo pedía texto. Es una foto del momento — si luego renombran o borran el motivo del catálogo, el historial se sigue entendiendo.';

-- No se puede quedar sin explicación un turno que dice que no tanqueó.
ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_no_fuel_reason_required;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_no_fuel_reason_required
  CHECK (fueled IS DISTINCT FROM false
         OR (no_fuel_reason IS NOT NULL AND btrim(no_fuel_reason) <> ''));

CREATE INDEX IF NOT EXISTS idx_shifts_no_fuel
  ON public.shifts (organization_id, fueled) WHERE fueled = false;

-- -----------------------------------------------------------------------------
-- 3. close_shift con los dos campos nuevos
-- -----------------------------------------------------------------------------
-- EL DROP NO ES OPCIONAL. Con CREATE OR REPLACE, añadir parámetros no reemplaza
-- la función: crea una SOBRECARGA. Quedarían dos close_shift y PostgREST
-- respondería 300 "Could not choose the best candidate function" — o sea, NINGÚN
-- conductor podría cerrar turno. Por eso se borra la firma vieja primero, y por
-- eso hay que rehacer los REVOKE/GRANT/COMMENT, que van atados a la firma.
DROP FUNCTION IF EXISTS public.close_shift(uuid, int, boolean, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.close_shift(
  p_shift_id       uuid,
  p_closing_km     int,
  p_has_novedad    boolean DEFAULT false,
  p_novedad_text   text    DEFAULT NULL,
  p_severity       text    DEFAULT 'low',
  p_media_paths    jsonb   DEFAULT '[]'::jsonb,
  -- Nuevos. DEFAULT NULL para que un cliente viejo (o el forzar-cierre del
  -- admin) siga llamando con seis argumentos sin enterarse.
  p_fueled         boolean DEFAULT NULL,
  p_no_fuel_reason_id uuid DEFAULT NULL,
  p_no_fuel_reason text    DEFAULT NULL
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
  v_fueled    boolean;
  v_reason    text;
  v_reason_id uuid;
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

  -- ── Tanqueo ──
  -- El texto se resuelve ACÁ y no en el navegador: si el conductor eligió un
  -- motivo del catálogo, la etiqueta se copia desde la tabla. Así el cliente no
  -- puede mandar una etiqueta que no existe, y el historial queda legible
  -- aunque después renombren el motivo.
  v_fueled := p_fueled;
  IF v_fueled IS FALSE THEN
    SELECT r.id, r.label INTO v_reason_id, v_reason
      FROM public.no_fuel_reasons r
     WHERE r.id = p_no_fuel_reason_id
       AND r.organization_id = v_shift.organization_id;

    -- Motivo que pide texto (el "Otro"), o motivo desconocido: manda lo escrito.
    IF v_reason_id IS NULL
       OR EXISTS (SELECT 1 FROM public.no_fuel_reasons r
                   WHERE r.id = v_reason_id AND r.requires_text) THEN
      v_reason := NULLIF(btrim(coalesce(p_no_fuel_reason, '')), '');
      IF v_reason IS NULL THEN
        RAISE EXCEPTION 'NO_FUEL_REASON_REQUIRED: si no se tanqueó hay que decir por qué';
      END IF;
      -- "Otro: <lo que escribió>" — se conserva la categoría para poder contar.
      IF v_reason_id IS NOT NULL THEN
        v_reason := (SELECT r.label FROM public.no_fuel_reasons r WHERE r.id = v_reason_id) || ': ' || v_reason;
      END IF;
    END IF;
  ELSE
    v_reason_id := NULL;
    v_reason    := NULL;
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
     SET status = 'closed', end_at = now(), closing_km = p_closing_km,
         fueled = v_fueled, no_fuel_reason_id = v_reason_id, no_fuel_reason = v_reason
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

  -- El "no tanqueó" NO abre incident a propósito: la bandeja de Novedades es
  -- para daños del carro. Mezclarlo la ensucia y el jefe deja de mirarla.
  PERFORM public.log_audit_event(
    'shift_closed', 'shift', v_shift.id,
    jsonb_build_object('vehicle_id', v_shift.vehicle_id, 'closing_km', p_closing_km,
                       'novedad', COALESCE(p_has_novedad, false),
                       'fueled', v_fueled, 'no_fuel_reason', v_reason)
  );

  RETURN jsonb_build_object('ok', true, 'shift_id', v_shift.id, 'status', 'closed',
                            'inspection_id', v_insp_id,
                            'fueled', v_fueled,
                            'km_driven', GREATEST(0, p_closing_km - COALESCE(v_shift.opening_km, p_closing_km)));
END;
$fn$;

REVOKE ALL ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb, boolean, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.close_shift(uuid, int, boolean, text, text, jsonb, boolean, uuid, text)
  IS 'Cierre normal del turno por el conductor: valida km final, registra inspección final, cierra el turno, libera el vehículo, abre incident si hubo novedad y guarda si se tanqueó (con motivo si no). SECURITY DEFINER, idempotente.';

COMMIT;
