-- =============================================================================
-- 0073_repuestos.sql — Módulo Repuestos (mantenimiento preventivo por pieza)
-- =============================================================================
-- Hasta hoy la BD conocía UN solo repuesto: el aceite, con tres columnas sueltas
-- en `vehicles` (current_km / last_maintenance_km / maintenance_interval_km).
-- Esta migración generaliza eso a un catálogo de 25 repuestos con estado propio
-- por vehículo, historial con costo y "vida real" medida en nuestra operación.
--
-- Cómo entra el kilometraje (NO cambia): el conductor reporta el odómetro en la
-- inspección de inicio → start_shift/start_shift_deferred suben vehicles.current_km
-- con GREATEST(). El jefe llena UNA vez el km del último cambio de cada pieza
-- (baseline) y de ahí en adelante el sistema concatena solo, turno a turno.
--
-- Decisiones de producto (jefe, 2026-08-17):
--   · NINGÚN repuesto bloquea el vehículo — todo es semáforo y aviso. Incluye el
--     aceite, que hasta hoy sí bloqueaba: se desarma ese candado (ver bloque 7).
--   · Lo que el jefe no sepa queda SIN DATO: no calcula ni alerta, lo pide.
--   · El conductor puede reportar un cambio; queda 'pending' hasta que el admin
--     lo confirme. Solo al confirmar se mueve el semáforo.
--   · Intervalos globales por organización, con excepción por carro.
--   · Los 4 niveles preventivos (5k/10k/20k/40k) se resuelven dentro de la
--     inspección de inicio de turno: al cruzar el km, el checklist trae ítems
--     extra.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) part_catalog — los repuestos que controlamos y cada cuánto
-- -----------------------------------------------------------------------------
-- `interval_km` es NUESTRO intervalo (más corto que el de un carro particular:
-- estos carros ruedan todo el día y mueven tripulaciones con hora de
-- presentación). `reference_particular` guarda el rango del particular solo para
-- mostrarlo al lado y que se vea la diferencia.

CREATE TABLE IF NOT EXISTS public.part_catalog (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  code                  text        NOT NULL,
  name                  text        NOT NULL,
  system                text        NOT NULL,
  interval_km           int         NOT NULL,
  interval_months       int,
  reference_particular  text,
  is_critical           boolean     NOT NULL DEFAULT false,
  note                  text,
  sort_order            int         NOT NULL DEFAULT 0,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT part_catalog_code_uniq        UNIQUE (organization_id, code),
  CONSTRAINT part_catalog_interval_pos     CHECK (interval_km > 0),
  CONSTRAINT part_catalog_months_pos       CHECK (interval_months IS NULL OR interval_months > 0),
  CONSTRAINT part_catalog_system_valid     CHECK (system IN ('motor','frenos','llantas','susp','trans'))
);

CREATE INDEX IF NOT EXISTS idx_part_catalog_org ON public.part_catalog(organization_id);

DROP TRIGGER IF EXISTS tr_part_catalog_set_updated_at ON public.part_catalog;
CREATE TRIGGER tr_part_catalog_set_updated_at
  BEFORE UPDATE ON public.part_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.part_catalog ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.part_catalog IS
  'Catálogo de repuestos controlados por la organización, con NUESTRO intervalo en km (y meses donde aplique).';

-- -----------------------------------------------------------------------------
-- 2) vehicle_part_state — km del último cambio de cada pieza en cada carro
-- -----------------------------------------------------------------------------
-- Esta es la tabla que el jefe llena UNA vez desde el módulo (carga inicial).
-- last_change_km NULL = SIN DATO: la pieza no calcula semáforo ni alerta, se
-- muestra pidiendo el dato. Nunca se asume "cambiado al odómetro de hoy" porque
-- eso pintaría en verde piezas que pueden estar al límite.

CREATE TABLE IF NOT EXISTS public.vehicle_part_state (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  vehicle_id          uuid        NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  part_id             uuid        NOT NULL REFERENCES public.part_catalog(id) ON DELETE CASCADE,
  last_change_km      int,
  last_change_at      date,
  interval_km_override int,
  updated_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vps_uniq              UNIQUE (vehicle_id, part_id),
  CONSTRAINT vps_km_non_negative   CHECK (last_change_km IS NULL OR last_change_km >= 0),
  CONSTRAINT vps_override_pos      CHECK (interval_km_override IS NULL OR interval_km_override > 0)
);

CREATE INDEX IF NOT EXISTS idx_vps_vehicle ON public.vehicle_part_state(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vps_org     ON public.vehicle_part_state(organization_id);

DROP TRIGGER IF EXISTS tr_vps_set_updated_at ON public.vehicle_part_state;
CREATE TRIGGER tr_vps_set_updated_at
  BEFORE UPDATE ON public.vehicle_part_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vehicle_part_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.vehicle_part_state IS
  'Estado por vehículo × repuesto: km/fecha del último cambio (NULL = sin dato) y excepción de intervalo para ese carro.';

-- -----------------------------------------------------------------------------
-- 3) maintenance — se le engancha el repuesto, el taller y el flujo de reporte
-- -----------------------------------------------------------------------------
-- La tabla ya existía (0016) con maintenance_type en texto libre. Se conserva
-- tal cual para no romper las filas viejas (aceite, regreso a servicio) y se
-- agregan las columnas del módulo.

ALTER TABLE public.maintenance
  ADD COLUMN IF NOT EXISTS part_id      uuid REFERENCES public.part_catalog(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shop         text,
  ADD COLUMN IF NOT EXISTS duration_km  int,
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS reported_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.maintenance
    ADD CONSTRAINT maintenance_status_valid CHECK (status IN ('pending','confirmed','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_maintenance_part   ON public.maintenance(part_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON public.maintenance(status) WHERE status = 'pending';

COMMENT ON COLUMN public.maintenance.duration_km IS
  'Cuánto duró de verdad la pieza que sale: km_at_event menos el km del cambio anterior. Alimenta la vida real.';
COMMENT ON COLUMN public.maintenance.status IS
  'pending = lo reportó el conductor y espera confirmación del admin (no mueve el semáforo). confirmed = cuenta.';

-- -----------------------------------------------------------------------------
-- 4) Niveles de inspección preventiva (5k / 10k / 20k / 40k)
-- -----------------------------------------------------------------------------
-- No se espera a que la pieza llegue al límite: cada nivel es una revisión
-- preventiva que se resuelve DENTRO de la inspección de inicio de turno. Al
-- cruzar el múltiplo de km, el checklist del conductor trae los ítems del nivel.

CREATE TABLE IF NOT EXISTS public.inspection_tiers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  every_km         int         NOT NULL,
  title            text        NOT NULL,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_tiers_uniq     UNIQUE (organization_id, every_km),
  CONSTRAINT inspection_tiers_km_pos   CHECK (every_km > 0)
);

ALTER TABLE public.inspection_tiers ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS tr_inspection_tiers_set_updated_at ON public.inspection_tiers;
CREATE TRIGGER tr_inspection_tiers_set_updated_at
  BEFORE UPDATE ON public.inspection_tiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Los ítems del checklist que solo aplican a un nivel. NULL = ítem de siempre
-- (los 27 del checklist oficial que ya existen no se tocan).
ALTER TABLE public.inspection_checklist_items
  ADD COLUMN IF NOT EXISTS tier_every_km int;

COMMENT ON COLUMN public.inspection_checklist_items.tier_every_km IS
  'NULL = ítem de toda inspección. 5000/10000/20000/40000 = solo cuando el carro cruza ese múltiplo de km.';

-- Qué nivel se cumplió por última vez en cada carro, para no repetirlo cada
-- turno hasta el siguiente múltiplo.
CREATE TABLE IF NOT EXISTS public.vehicle_tier_state (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  vehicle_id       uuid        NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  every_km         int         NOT NULL,
  last_done_km     int         NOT NULL,
  last_done_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vts_uniq UNIQUE (vehicle_id, every_km)
);

ALTER TABLE public.vehicle_tier_state ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 5) Semilla: los 25 repuestos y los 4 niveles (nota del asesor, 2026-08-17)
-- -----------------------------------------------------------------------------
-- NUESTRO intervalo = punto medio del rango recomendado para flota. La columna
-- de referencia es la del carro particular, para tener la comparación a la vista.

INSERT INTO public.part_catalog
  (organization_id, code, name, system, interval_km, interval_months, reference_particular, is_critical, note, sort_order)
SELECT o.id, x.code, x.name, x.system, x.interval_km, x.interval_months, x.ref, x.crit, x.note, x.ord
FROM public.organizations o
CROSS JOIN (VALUES
  ('aceite',      'Aceite de motor',          'motor',   6500,   NULL, '8.000–10.000 km',      false, NULL,                     10),
  ('f-aceite',    'Filtro de aceite',         'motor',   6500,   NULL, 'Cada cambio de aceite',false, NULL,                     20),
  ('f-aire',      'Filtro de aire',           'motor',  11000,   NULL, '15.000–20.000 km',     false, NULL,                     30),
  ('f-cabina',    'Filtro de cabina',         'motor',  10000,   NULL, '15.000 km',            false, NULL,                     40),
  ('c-acces',     'Correa de accesorios',     'motor',  60000,   NULL, '60.000–100.000 km',    false, NULL,                     50),
  ('c-dist',      'Correa de distribución',   'motor',  80000,   NULL, 'Según fabricante',     true,  'No superar 80.000 km',   60),
  ('b-agua',      'Bomba de agua',            'motor',  90000,   NULL, '100.000–150.000 km',   false, NULL,                     70),
  ('past-del',    'Pastillas delanteras',     'frenos', 27500,   NULL, '30.000–60.000 km',     true,  NULL,                    110),
  ('band-tra',    'Bandas traseras',          'frenos', 50000,   NULL, '60.000–100.000 km',    true,  NULL,                    120),
  ('disc-del',    'Discos delanteros',        'frenos', 70000,   NULL, '80.000–120.000 km',    true,  NULL,                    130),
  ('liq-fre',     'Líquido de frenos',        'frenos', 30000,     18, '40.000 km',            true,  'Vence también por tiempo', 140),
  ('llantas',     'Llantas',                  'llantas',42500,   NULL, '40.000–70.000 km',     true,  NULL,                    210),
  ('rotacion',    'Rotación de llantas',      'llantas', 7500,   NULL, '10.000 km',            false, NULL,                    220),
  ('alineacion',  'Alineación',               'llantas', 8500,   NULL, '10.000 km',            false, NULL,                    230),
  ('balanceo',    'Balanceo',                 'llantas',10000,   NULL, '10.000 km',            false, NULL,                    240),
  ('amort',       'Amortiguadores',           'susp',   60000,   NULL, '80.000–100.000 km',    false, NULL,                    310),
  ('bujes',       'Bujes',                    'susp',   60000,   NULL, '60.000–120.000 km',    false, NULL,                    320),
  ('tijeras',     'Tijeras',                  'susp',   85000,   NULL, '80.000–150.000 km',    false, 'Antes si hay juego',    330),
  ('bieletas',    'Bieletas',                 'susp',   42500,   NULL, '40.000–80.000 km',     false, NULL,                    340),
  ('terminales',  'Terminales',               'susp',   65000,   NULL, '60.000–120.000 km',    false, NULL,                    350),
  ('rotulas',     'Rótulas',                  'susp',   75000,   NULL, '80.000–120.000 km',    false, NULL,                    360),
  ('rodamientos', 'Rodamientos',              'susp',  100000,   NULL, '100.000–150.000 km',   false, NULL,                    370),
  ('caja-mec',    'Aceite caja mecánica',     'trans',  55000,   NULL, '80.000–100.000 km',    false, NULL,                    410),
  ('caja-aut',    'Aceite caja automática',   'trans',  45000,   NULL, '60.000–80.000 km',     false, NULL,                    420),
  ('embrague',    'Embrague',                 'trans',  95000,   NULL, '80.000–150.000 km',    false, NULL,                    430)
) AS x(code, name, system, interval_km, interval_months, ref, crit, note, ord)
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO public.inspection_tiers (organization_id, every_km, title)
SELECT o.id, x.km, x.title
FROM public.organizations o
CROSS JOIN (VALUES
  ( 5000, 'Revisión rápida'),
  (10000, 'Medición'),
  (20000, 'Revisión a fondo'),
  (40000, 'Mantenimiento mayor')
) AS x(km, title)
ON CONFLICT (organization_id, every_km) DO NOTHING;

-- Ítems extra del checklist por nivel (se suman a los 27 oficiales de 0028).
INSERT INTO public.inspection_checklist_items (organization_id, label, hint, category, sort_order, is_active, tier_every_km)
SELECT o.id, x.label, x.hint, 'Revisión preventiva', x.ord, true, x.km
FROM public.organizations o
CROSS JOIN (VALUES
  ( 5000, 'Pastillas y discos a la vista',   'Sin ranuras profundas ni bordes gastados',           910),
  ( 5000, 'Llantas: labrado y presión',      'Labrado parejo, sin cortes; presión en frío',        911),
  ( 5000, 'Suspensión y dirección',          'Sin ruidos ni juego en el timón',                    912),
  ( 5000, 'Fugas de aceite y refrigerante',  'Revisar el piso debajo del carro',                   913),
  (10000, 'Espesor de pastillas y bandas',   'Medir, no estimar a ojo',                            920),
  (10000, 'Juego de rótulas y terminales',   'Mover la rueda y sentir el juego',                   921),
  (10000, 'Bujes y tijeras',                 'Revisar cauchos partidos',                           922),
  (10000, 'Estado de amortiguadores',        'Sin humedad de aceite en el vástago',                923),
  (20000, 'Suspensión en detalle',           'Revisión completa del tren delantero',               930),
  (20000, 'Soportes del motor',              'Sin cauchos rotos ni vibración al acelerar',         931),
  (20000, 'Estado de caja y transmisión',    'Cambios suaves, sin ruido',                          932),
  (40000, 'Frenos completos',                'Mantenimiento mayor de todo el sistema',             940),
  (40000, 'Cambio de líquidos que apliquen', 'Frenos, caja, refrigerante según corresponda',       941),
  (40000, 'Tren delantero completo',         'Revisión completa',                                  942)
) AS x(km, label, hint, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM public.inspection_checklist_items i
   WHERE i.organization_id = o.id AND i.label = x.label
);

-- -----------------------------------------------------------------------------
-- 6) Vistas: semáforo por pieza y vida real medida
-- -----------------------------------------------------------------------------
-- El semáforo es informativo (nada bloquea). Estados:
--   nodata = el jefe no ha cargado el km del último cambio → no calcula
--   red    = vencido (por km o por meses)
--   amber  = por vencer (último 15% de la vida útil, o a 3 meses del plazo)
--   green  = al día

CREATE OR REPLACE VIEW public.v_vehicle_part_status AS
SELECT
  v.id                        AS vehicle_id,
  v.organization_id,
  v.internal_code,
  v.license_plate,
  v.current_km,
  pc.id                       AS part_id,
  pc.code                     AS part_code,
  pc.name                     AS part_name,
  pc.system,
  pc.is_critical,
  pc.interval_months,
  pc.reference_particular,
  pc.note,
  pc.sort_order,
  COALESCE(vps.interval_km_override, pc.interval_km) AS interval_km,
  (vps.interval_km_override IS NOT NULL)             AS has_override,
  vps.last_change_km,
  vps.last_change_at,
  CASE WHEN vps.last_change_km IS NULL THEN NULL
       ELSE GREATEST(0, v.current_km - vps.last_change_km) END AS km_since,
  CASE WHEN vps.last_change_km IS NULL THEN NULL
       ELSE COALESCE(vps.interval_km_override, pc.interval_km)
            - GREATEST(0, v.current_km - vps.last_change_km) END AS km_until,
  CASE WHEN vps.last_change_at IS NULL OR pc.interval_months IS NULL THEN NULL
       ELSE floor(EXTRACT(EPOCH FROM (now() - vps.last_change_at::timestamptz)) / 2629746)::int
  END AS months_since,
  CASE
    WHEN vps.last_change_km IS NULL THEN 'nodata'
    WHEN GREATEST(0, v.current_km - vps.last_change_km)
         >= COALESCE(vps.interval_km_override, pc.interval_km) THEN 'red'
    WHEN pc.interval_months IS NOT NULL AND vps.last_change_at IS NOT NULL
         AND floor(EXTRACT(EPOCH FROM (now() - vps.last_change_at::timestamptz)) / 2629746)::int
             >= pc.interval_months THEN 'red'
    WHEN GREATEST(0, v.current_km - vps.last_change_km)
         >= COALESCE(vps.interval_km_override, pc.interval_km) * 0.85 THEN 'amber'
    WHEN pc.interval_months IS NOT NULL AND vps.last_change_at IS NOT NULL
         AND floor(EXTRACT(EPOCH FROM (now() - vps.last_change_at::timestamptz)) / 2629746)::int
             >= pc.interval_months - 3 THEN 'amber'
    ELSE 'green'
  END AS light
FROM public.vehicles v
JOIN public.part_catalog pc
  ON pc.organization_id = v.organization_id AND pc.is_active
LEFT JOIN public.vehicle_part_state vps
  ON vps.vehicle_id = v.id AND vps.part_id = pc.id
WHERE v.deleted_at IS NULL;

COMMENT ON VIEW public.v_vehicle_part_status IS
  'Semáforo por vehículo × repuesto. INFORMATIVO: ningún estado bloquea el carro. light=nodata cuando el jefe aún no cargó el km del último cambio.';

-- Vida real: cuánto dura la pieza EN NUESTRA OPERACIÓN. Solo cuenta con 3 o más
-- cambios medidos; debajo de eso el promedio no significa nada y no se sugiere
-- ajustar el intervalo.
CREATE OR REPLACE VIEW public.v_part_real_life AS
SELECT
  pc.organization_id,
  pc.id            AS part_id,
  pc.code          AS part_code,
  pc.name          AS part_name,
  pc.interval_km,
  count(m.id)                          AS n,
  round(avg(m.duration_km))::int       AS avg_km,
  min(m.duration_km)                   AS min_km,
  max(m.duration_km)                   AS max_km,
  round(avg(m.cost_cop))::numeric      AS avg_cost,
  (count(m.id) >= 3)                   AS is_reliable
FROM public.part_catalog pc
JOIN public.maintenance m
  ON m.part_id = pc.id
 AND m.status = 'confirmed'
 AND m.duration_km IS NOT NULL
 AND m.duration_km > 0
GROUP BY pc.organization_id, pc.id, pc.code, pc.name, pc.interval_km;

COMMENT ON VIEW public.v_part_real_life IS
  'Duración real promedio por repuesto, medida con los cambios registrados. is_reliable = hay 3 o más cambios.';

-- -----------------------------------------------------------------------------
-- 7) Se desarma el bloqueo por aceite
-- -----------------------------------------------------------------------------
-- Decisión del jefe: ningún repuesto detiene el carro, ni siquiera el aceite. El
-- trigger de 0016/0041 pasaba el vehículo a 'blocked' al cerrar turno cuando
-- (current_km - last_maintenance_km) >= maintenance_interval_km. Se conserva la
-- actualización de current_km (esa es la tubería del odómetro y sigue siendo la
-- fuente de verdad) y se quita el bloqueo.
--
-- Con esto quedan sin razón de ser: driver_override_oil_block (el conductor ya
-- no tiene nada que desbloquear) y el badge "!" del tablero. Las funciones NO se
-- borran para no romper el front hasta que se limpie; dejan de dispararse.

CREATE OR REPLACE FUNCTION public.shifts_close_block_vehicle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Única responsabilidad desde 0073: subir el odómetro del vehículo.
  IF NEW.closing_km IS NOT NULL THEN
    UPDATE public.vehicles
       SET current_km = GREATEST(current_km, NEW.closing_km)
     WHERE id = NEW.vehicle_id;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.shifts_close_block_vehicle() IS
  'Al cerrar turno sube vehicles.current_km con el km final. Desde 0073 ya NO bloquea el vehículo por mantenimiento (el semáforo de Repuestos es informativo).';

-- Liberar lo que quedó detenido por la regla vieja.
UPDATE public.vehicles
   SET status = 'available', oil_override_at = NULL, oil_override_by = NULL
 WHERE status = 'blocked' AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 8) RPC — carga inicial: el jefe llena los km del último cambio
-- -----------------------------------------------------------------------------
-- p_entries: [{"part_code":"aceite","last_change_km":178000,"last_change_at":"2026-07-02","interval_km_override":null}, …]
-- Lo que venga sin last_change_km se guarda como SIN DATO (NULL), a propósito.

CREATE OR REPLACE FUNCTION public.set_vehicle_part_baseline(p_vehicle_id uuid, p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_org   uuid := public.current_user_org();
  v_veh   public.vehicles%ROWTYPE;
  v_item  jsonb;
  v_part  public.part_catalog%ROWTYPE;
  v_km    int;
  v_count int := 0;
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN: solo el administrador carga el kilometraje de los repuestos';
  END IF;

  SELECT * INTO v_veh FROM public.vehicles WHERE id = p_vehicle_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND'; END IF;
  IF v_veh.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
  LOOP
    SELECT * INTO v_part FROM public.part_catalog
     WHERE organization_id = v_org AND code = (v_item->>'part_code');
    CONTINUE WHEN NOT FOUND;

    v_km := NULLIF(v_item->>'last_change_km', '')::int;

    -- El km del último cambio no puede ser mayor al odómetro actual: sería un
    -- dato imposible y dejaría el semáforo en verde para siempre.
    IF v_km IS NOT NULL AND v_km > COALESCE(v_veh.current_km, 0) THEN
      RAISE EXCEPTION 'KM_GT_ODOMETER: % (%) supera el odómetro del carro (% km)',
        v_part.name, v_km, COALESCE(v_veh.current_km, 0);
    END IF;

    INSERT INTO public.vehicle_part_state
      (organization_id, vehicle_id, part_id, last_change_km, last_change_at, interval_km_override, updated_by)
    VALUES
      (v_org, p_vehicle_id, v_part.id, v_km,
       NULLIF(v_item->>'last_change_at', '')::date,
       NULLIF(v_item->>'interval_km_override', '')::int,
       v_uid)
    ON CONFLICT (vehicle_id, part_id) DO UPDATE
      SET last_change_km       = EXCLUDED.last_change_km,
          last_change_at       = EXCLUDED.last_change_at,
          interval_km_override = EXCLUDED.interval_km_override,
          updated_by           = EXCLUDED.updated_by;

    v_count := v_count + 1;
  END LOOP;

  PERFORM public.log_audit_event(
    'vehicle_part_baseline_set', 'vehicle', p_vehicle_id,
    jsonb_build_object('by', v_uid, 'parts', v_count)
  );

  RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id, 'parts', v_count);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_vehicle_part_baseline(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_vehicle_part_baseline(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.set_vehicle_part_baseline(uuid, jsonb) IS
  'Carga inicial del jefe: km y fecha del último cambio de cada repuesto de un carro. Lo que no sepa queda NULL (sin dato). SECURITY DEFINER, solo admin.';

-- -----------------------------------------------------------------------------
-- 9) RPC — registrar un cambio de repuesto
-- -----------------------------------------------------------------------------
-- Admin: entra confirmado y mueve el semáforo a cero.
-- Conductor: entra 'pending' y NO mueve nada hasta que el admin lo confirme.

CREATE OR REPLACE FUNCTION public.register_part_change(
  p_vehicle_id uuid,
  p_part_code  text,
  p_km         int,
  p_date       date    DEFAULT NULL,
  p_cost       numeric DEFAULT NULL,
  p_shop       text    DEFAULT NULL,
  p_notes      text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_org      uuid := public.current_user_org();
  v_role     text := public.current_user_role();
  v_veh      public.vehicles%ROWTYPE;
  v_part     public.part_catalog%ROWTYPE;
  v_prev_km  int;
  v_dur      int;
  v_status   text;
  v_id       uuid;
  v_admins   uuid[];
BEGIN
  IF v_role NOT IN ('admin', 'driver') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_veh FROM public.vehicles WHERE id = p_vehicle_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND'; END IF;
  IF v_veh.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;

  SELECT * INTO v_part FROM public.part_catalog
   WHERE organization_id = v_org AND code = p_part_code AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'PART_NOT_FOUND: %', p_part_code; END IF;

  IF p_km IS NULL OR p_km < 0 THEN RAISE EXCEPTION 'KM_REQUIRED'; END IF;

  SELECT last_change_km INTO v_prev_km
    FROM public.vehicle_part_state
   WHERE vehicle_id = p_vehicle_id AND part_id = v_part.id;

  -- Solo hay duración real si sabíamos desde cuándo contar.
  v_dur := CASE WHEN v_prev_km IS NOT NULL AND p_km > v_prev_km THEN p_km - v_prev_km END;

  IF v_prev_km IS NOT NULL AND p_km < v_prev_km THEN
    RAISE EXCEPTION 'KM_LT_PREVIOUS: el km del cambio (%) es menor al del cambio anterior (%)', p_km, v_prev_km;
  END IF;

  v_status := CASE WHEN v_role = 'admin' THEN 'confirmed' ELSE 'pending' END;

  INSERT INTO public.maintenance
    (organization_id, vehicle_id, performed_by, maintenance_type, part_id, km_at_event,
     cost_cop, shop, notes, duration_km, status, reported_by,
     confirmed_by, confirmed_at, performed_at)
  VALUES
    (v_org, p_vehicle_id, CASE WHEN v_role = 'admin' THEN v_uid END, v_part.name, v_part.id, p_km,
     p_cost, p_shop, p_notes, v_dur, v_status, v_uid,
     CASE WHEN v_role = 'admin' THEN v_uid END,
     CASE WHEN v_role = 'admin' THEN now() END,
     COALESCE(p_date::timestamptz, now()))
  RETURNING id INTO v_id;

  -- El semáforo solo se mueve con un cambio confirmado.
  IF v_status = 'confirmed' THEN
    INSERT INTO public.vehicle_part_state
      (organization_id, vehicle_id, part_id, last_change_km, last_change_at, updated_by)
    VALUES
      (v_org, p_vehicle_id, v_part.id, p_km, COALESCE(p_date, current_date), v_uid)
    ON CONFLICT (vehicle_id, part_id) DO UPDATE
      SET last_change_km = EXCLUDED.last_change_km,
          last_change_at = EXCLUDED.last_change_at,
          updated_by     = EXCLUDED.updated_by;

    -- El odómetro nunca retrocede: si el cambio se hizo a un km mayor al que
    -- tenemos registrado, ese es el bueno.
    UPDATE public.vehicles SET current_km = GREATEST(current_km, p_km) WHERE id = p_vehicle_id;

    -- Compatibilidad: el aceite sigue alimentando las columnas viejas mientras
    -- el resto del front (Ajustes, tablero) las siga leyendo.
    IF v_part.code = 'aceite' THEN
      UPDATE public.vehicles
         SET last_maintenance_km = p_km, oil_override_at = NULL, oil_override_by = NULL
       WHERE id = p_vehicle_id;
    END IF;
  END IF;

  SELECT array_agg(id) INTO v_admins
    FROM public.profiles
   WHERE role = 'admin' AND organization_id = v_org
     AND COALESCE(is_active, true) = true AND deleted_at IS NULL;

  PERFORM public.log_audit_event(
    'part_change_registered', 'vehicle', p_vehicle_id,
    jsonb_build_object('by', v_uid, 'part', v_part.code, 'km', p_km,
                       'duration_km', v_dur, 'status', v_status)
  );

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status,
                            'duration_km', v_dur, 'part_name', v_part.name,
                            'admin_ids', to_jsonb(v_admins));
END;
$fn$;

REVOKE ALL ON FUNCTION public.register_part_change(uuid, text, int, date, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_part_change(uuid, text, int, date, numeric, text, text) TO authenticated;

COMMENT ON FUNCTION public.register_part_change(uuid, text, int, date, numeric, text, text) IS
  'Registra el cambio de un repuesto. Admin = confirmado y reinicia el semáforo; conductor = pendiente de confirmación. Calcula la duración real contra el cambio anterior.';

-- -----------------------------------------------------------------------------
-- 10) RPC — el admin confirma (o rechaza) lo que reportó el conductor
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_part_change(p_maintenance_id uuid, p_accept boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_m   public.maintenance%ROWTYPE;
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN';
  END IF;

  SELECT * INTO v_m FROM public.maintenance WHERE id = p_maintenance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_m.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;
  IF v_m.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'already', v_m.status);  -- idempotente
  END IF;

  IF NOT p_accept THEN
    UPDATE public.maintenance
       SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now()
     WHERE id = p_maintenance_id;
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  END IF;

  UPDATE public.maintenance
     SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now()
   WHERE id = p_maintenance_id;

  INSERT INTO public.vehicle_part_state
    (organization_id, vehicle_id, part_id, last_change_km, last_change_at, updated_by)
  VALUES
    (v_org, v_m.vehicle_id, v_m.part_id, v_m.km_at_event, v_m.performed_at::date, v_uid)
  ON CONFLICT (vehicle_id, part_id) DO UPDATE
    SET last_change_km = EXCLUDED.last_change_km,
        last_change_at = EXCLUDED.last_change_at,
        updated_by     = EXCLUDED.updated_by;

  UPDATE public.vehicles SET current_km = GREATEST(current_km, v_m.km_at_event)
   WHERE id = v_m.vehicle_id;

  PERFORM public.log_audit_event(
    'part_change_confirmed', 'vehicle', v_m.vehicle_id,
    jsonb_build_object('by', v_uid, 'maintenance_id', p_maintenance_id)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'confirmed');
END;
$fn$;

REVOKE ALL ON FUNCTION public.confirm_part_change(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_part_change(uuid, boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- 11) RPC — corregir el odómetro e intervalos
-- -----------------------------------------------------------------------------
-- El odómetro entra solo con la inspección de inicio de turno. Si el conductor
-- se equivocó al teclear, el jefe lo corrige aquí y queda el registro.

CREATE OR REPLACE FUNCTION public.correct_vehicle_odometer(p_vehicle_id uuid, p_km int, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := public.current_user_org();
  v_veh public.vehicles%ROWTYPE;
BEGIN
  IF public.current_user_role() <> 'admin' THEN RAISE EXCEPTION 'NOT_ADMIN'; END IF;
  IF p_km IS NULL OR p_km < 0 THEN RAISE EXCEPTION 'KM_REQUIRED'; END IF;

  SELECT * INTO v_veh FROM public.vehicles WHERE id = p_vehicle_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND'; END IF;
  IF v_veh.organization_id <> v_org THEN RAISE EXCEPTION 'WRONG_ORG'; END IF;

  UPDATE public.vehicles SET current_km = p_km WHERE id = p_vehicle_id;

  PERFORM public.log_audit_event(
    'vehicle_odometer_corrected', 'vehicle', p_vehicle_id,
    jsonb_build_object('by', v_uid, 'from', v_veh.current_km, 'to', p_km, 'reason', p_reason)
  );

  RETURN jsonb_build_object('ok', true, 'from', v_veh.current_km, 'to', p_km);
END;
$fn$;

REVOKE ALL ON FUNCTION public.correct_vehicle_odometer(uuid, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_vehicle_odometer(uuid, int, text) TO authenticated;

-- Cambiar el intervalo de un repuesto: global o solo para un carro.
CREATE OR REPLACE FUNCTION public.set_part_interval(
  p_part_code text, p_interval_km int, p_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_org  uuid := public.current_user_org();
  v_part public.part_catalog%ROWTYPE;
BEGIN
  IF public.current_user_role() <> 'admin' THEN RAISE EXCEPTION 'NOT_ADMIN'; END IF;
  IF p_interval_km IS NULL OR p_interval_km <= 0 THEN RAISE EXCEPTION 'INTERVAL_REQUIRED'; END IF;

  SELECT * INTO v_part FROM public.part_catalog WHERE organization_id = v_org AND code = p_part_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'PART_NOT_FOUND'; END IF;

  IF p_vehicle_id IS NULL THEN
    UPDATE public.part_catalog SET interval_km = p_interval_km WHERE id = v_part.id;
  ELSE
    INSERT INTO public.vehicle_part_state
      (organization_id, vehicle_id, part_id, interval_km_override, updated_by)
    VALUES (v_org, p_vehicle_id, v_part.id, p_interval_km, v_uid)
    ON CONFLICT (vehicle_id, part_id) DO UPDATE
      SET interval_km_override = EXCLUDED.interval_km_override, updated_by = EXCLUDED.updated_by;
  END IF;

  PERFORM public.log_audit_event(
    'part_interval_changed', 'vehicle', COALESCE(p_vehicle_id, v_part.id),
    jsonb_build_object('by', v_uid, 'part', p_part_code, 'from', v_part.interval_km,
                       'to', p_interval_km, 'scope', CASE WHEN p_vehicle_id IS NULL THEN 'global' ELSE 'vehicle' END)
  );

  RETURN jsonb_build_object('ok', true, 'part', p_part_code, 'interval_km', p_interval_km);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_part_interval(text, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_part_interval(text, int, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 12) Niveles preventivos pendientes de un carro
-- -----------------------------------------------------------------------------
-- Devuelve los niveles que el carro cruzó y todavía no se le han hecho, para que
-- la inspección de inicio de turno sume los ítems del checklist de ese nivel.

CREATE OR REPLACE FUNCTION public.pending_inspection_tiers(p_vehicle_id uuid)
RETURNS TABLE (every_km int, title text, due_at_km int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT t.every_km, t.title,
         (floor(v.current_km::numeric / t.every_km) * t.every_km)::int AS due_at_km
    FROM public.vehicles v
    JOIN public.inspection_tiers t
      ON t.organization_id = v.organization_id AND t.is_active
    LEFT JOIN public.vehicle_tier_state s
      ON s.vehicle_id = v.id AND s.every_km = t.every_km
   WHERE v.id = p_vehicle_id
     AND v.current_km >= t.every_km
     AND floor(v.current_km::numeric / t.every_km)
         > floor(COALESCE(s.last_done_km, 0)::numeric / t.every_km)
   ORDER BY t.every_km DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.pending_inspection_tiers(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_inspection_tiers_done(p_vehicle_id uuid, p_km int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org uuid;
  v_n   int := 0;
BEGIN
  SELECT organization_id INTO v_org FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'VEHICLE_NOT_FOUND'; END IF;

  INSERT INTO public.vehicle_tier_state (organization_id, vehicle_id, every_km, last_done_km)
  SELECT v_org, p_vehicle_id, t.every_km, p_km
    FROM public.pending_inspection_tiers(p_vehicle_id) t
  ON CONFLICT (vehicle_id, every_km) DO UPDATE
    SET last_done_km = EXCLUDED.last_done_km, last_done_at = now();

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'tiers', v_n);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.mark_inspection_tiers_done(uuid, int) TO authenticated;

-- -----------------------------------------------------------------------------
-- 13) RLS — el admin administra, el conductor lee y reporta
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS part_catalog_read      ON public.part_catalog;
DROP POLICY IF EXISTS part_catalog_admin     ON public.part_catalog;
CREATE POLICY part_catalog_read ON public.part_catalog
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());
CREATE POLICY part_catalog_admin ON public.part_catalog
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS vps_read  ON public.vehicle_part_state;
DROP POLICY IF EXISTS vps_admin ON public.vehicle_part_state;
CREATE POLICY vps_read ON public.vehicle_part_state
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());
CREATE POLICY vps_admin ON public.vehicle_part_state
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS tiers_read  ON public.inspection_tiers;
DROP POLICY IF EXISTS tiers_admin ON public.inspection_tiers;
CREATE POLICY tiers_read ON public.inspection_tiers
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());
CREATE POLICY tiers_admin ON public.inspection_tiers
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS vts_read ON public.vehicle_tier_state;
CREATE POLICY vts_read ON public.vehicle_tier_state
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

-- La tabla maintenance ya tenía RLS habilitada sin políticas de lectura para el
-- módulo; el historial lo necesita el admin y el conductor ve lo suyo.
DROP POLICY IF EXISTS maintenance_read  ON public.maintenance;
DROP POLICY IF EXISTS maintenance_admin ON public.maintenance;
CREATE POLICY maintenance_read ON public.maintenance
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());
CREATE POLICY maintenance_admin ON public.maintenance
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

GRANT SELECT ON public.v_vehicle_part_status TO authenticated;
GRANT SELECT ON public.v_part_real_life      TO authenticated;

COMMIT;
