-- =============================================================================
-- 0095 · Documentos del carro (SOAT, técnico-mecánica, seguro y demás)
-- =============================================================================
-- Pedido (29-sep-2026): «en el módulo administrativo, el módulo de Repuestos
-- también debe incluir los apartados de SOAT y demás». Respuestas de la dueña:
--   · qué documentos: «los que más quieras agregar» → los siete de abajo;
--   · aviso: AL MENOS un mes antes de que venza;
--   · vencido: SOLO alerta. NO bloquea el carro (igual que los repuestos, 0073).
--
-- QUÉ HACE
--   1. public.vehicle_documents: una fila por carro × documento (UNIQUE
--      vehicle_id + kind), con fecha de vencimiento, número, entidad, nota y
--      «No aplica». Sin fila, o con la fecha vacía = SIN DATO: no calcula ni
--      avisa, se muestra pidiendo el dato. Nunca se asume una fecha.
--        soat              SOAT
--        tecnomecanica     Revisión técnico-mecánica
--        seguro            Seguro todo riesgo
--        polizas_rc        Pólizas RCC/RCE
--        impuesto          Impuesto vehicular (la fecha es el límite de pago)
--        extintor          Recarga del extintor
--        tarjeta_propiedad Tarjeta de propiedad — no vence: solo número
--      Cualquiera se puede marcar «No aplica» para un carro.
--
--   2. UNA SOLA FUENTE DE VERDAD. vehicles.soat_expires_at, tecnomec_expires_at
--      e insurance_expires_at (0002) se quedan, porque los leen Flota
--      (admin-flota.js), el perfil del conductor y el inicio de turno; pero
--      desde hoy son el ESPEJO de vehicle_documents, en las dos direcciones:
--        · documentos → vehicles: al guardar SOAT / técnico-mecánica / seguro
--          se copia la fecha (NULL si está marcado «No aplica»);
--        · vehicles → documentos: si Flota edita el SOAT o la técnico-mecánica,
--          la fila del documento se crea o se actualiza (y deja de ser «No
--          aplica» si llega una fecha).
--      Los dos disparadores cortan con pg_trigger_depth() > 1: el cambio que
--      hace uno no rebota en el otro. Además solo escriben si el valor es
--      distinto (IS DISTINCT FROM), así que ni siquiera sin la guarda habría
--      bucle. El relleno inicial copia lo que ya tenía vehicles.
--
--   3. app_settings.vehicle_doc_alert_days: con cuántos días de anticipación se
--      avisa. 30 por defecto; entre 30 y 180, porque la dueña pidió «al menos
--      un mes». Se edita desde Repuestos.
--
--   4. EL RELOJ: vehicle_docs_run_daily(), con pg_cron a la misma hora que el
--      facturario (0090): 7:00 de Bogotá = 12:00 UTC. Les avisa a los JEFES
--      (ops_alert_recipients() de la organización del carro, el mismo camino
--      que usan 0089 y 0090) por notification_outbox, que drena
--      dispatch-notifications (0066). Umbrales, con N = vehicle_doc_alert_days:
--        faltan ≤ N días → «ventana»    faltan ≤ 15 → «faltan:15»
--        faltan ≤ 7      → «faltan:7»   falta 1     → «faltan:1»
--        vence hoy       → «hoy»
--        vencido         → «vencido:K», K = semana de vencido (una por semana)
--      La primera etapa se llama «ventana» y no «faltan:N» a propósito: si el
--      jefe sube N de 30 a 45, un documento que ya recibió su primer aviso no
--      lo vuelve a recibir; uno que recién entra a la ventana nueva, sí.
--      Cada etapa sale UNA vez por documento y fecha de vencimiento
--      (vehicle_document_alerts.dedupe_key), y a lo sumo un aviso por documento
--      por día. Se avisa la etapa en la que ESTÁ el documento, no solo el día
--      exacto: si el reloj se salta un día, o el jefe carga un SOAT al que le
--      faltan 20 días, el aviso sale igual (una vez). Renovar = fecha nueva =
--      ciclo nuevo de avisos. «No aplica», sin fecha o carro eliminado: nada.
--      No bloquea nada.
--
--   5. save_vehicle_document(...): el jefe guarda un documento (valida rol,
--      organización del carro, tipo y fecha). La tabla, directo, solo se lee.
--
--   6. driver_vehicle_documents(p_vehicle_ids): lo que ve el CONDUCTOR al
--      iniciar turno y en su perfil (pedido del 30-sep-2026: «¿el conductor
--      también debe ver los vencidos? Hoy solo ve el SOAT» → «y los más
--      relevantes»). Solo los de la vía: SOAT, técnico-mecánica, seguro,
--      pólizas RCC/RCE y extintor; sin número, entidad ni nota. La tabla sigue
--      cerrada por RLS a los jefes: el conductor lee por aquí. No bloquea nada.
--
-- Hoy = fecha de Bogotá (vehicle_docs_today()). Solo una sesión `postgres` (las
-- pruebas locales) puede fijarla con SET rendio.docs_today = 'AAAA-MM-DD'.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. Sin tocar migraciones
-- anteriores. Down: down_migrations/0095_documentos_del_carro.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Utilidades
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vehicle_docs_today()
RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN session_user = 'postgres'
     AND nullif(current_setting('rendio.docs_today', true), '') IS NOT NULL
      THEN current_setting('rendio.docs_today', true)::date
    ELSE (now() AT TIME ZONE 'America/Bogota')::date
  END;
$$;

COMMENT ON FUNCTION public.vehicle_docs_today()
  IS 'Hoy en Bogotá. Solo una sesión postgres (pruebas locales) puede fijarlo con rendio.docs_today.';

-- Los tipos de documento, en el orden en que se muestran. El CHECK de la tabla
-- repite la lista (un CHECK no puede llamar funciones de otra tabla y así el
-- error sale en la base aunque alguien escriba sin pasar por la RPC).
CREATE OR REPLACE FUNCTION public.vehicle_document_kinds()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY['soat', 'tecnomecanica', 'seguro', 'polizas_rc', 'impuesto', 'extintor', 'tarjeta_propiedad']::text[];
$$;

CREATE OR REPLACE FUNCTION public.vehicle_document_label(p_kind text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_kind
    WHEN 'soat'              THEN 'SOAT'
    WHEN 'tecnomecanica'     THEN 'Revisión técnico-mecánica'
    WHEN 'seguro'            THEN 'Seguro todo riesgo'
    WHEN 'polizas_rc'        THEN 'Pólizas RCC/RCE'
    WHEN 'impuesto'          THEN 'Impuesto vehicular'
    WHEN 'extintor'          THEN 'Recarga del extintor'
    WHEN 'tarjeta_propiedad' THEN 'Tarjeta de propiedad'
    ELSE p_kind
  END;
$$;

-- «29 de oct de 2026» (el año va: un SOAT vence el año siguiente).
CREATE OR REPLACE FUNCTION public.vehicle_doc_fmt(p_d date)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT extract(day FROM p_d)::int::text || ' de ' ||
    (ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'])[extract(month FROM p_d)::int]
    || ' de ' || extract(year FROM p_d)::int::text;
$$;

-- La etapa del aviso según los días que faltan (negativo = vencido hace tantos).
-- NULL = todavía fuera de la ventana: no se avisa. La ventana nunca baja de 30.
CREATE OR REPLACE FUNCTION public.vehicle_doc_stage(p_days integer, p_window integer)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_days IS NULL THEN NULL
    WHEN p_days < 0 THEN 'vencido:' || ((-p_days - 1) / 7)::text
    WHEN p_days = 0 THEN 'hoy'
    WHEN p_days > greatest(30, coalesce(p_window, 30)) THEN NULL
    WHEN p_days = 1 THEN 'faltan:1'
    WHEN p_days <= 7 THEN 'faltan:7'
    WHEN p_days <= 15 THEN 'faltan:15'
    ELSE 'ventana'
  END;
$$;

COMMENT ON FUNCTION public.vehicle_doc_stage(integer, integer)
  IS 'Etapa del aviso de un documento: ventana (faltan ≤ N) / faltan:15 / faltan:7 / faltan:1 / hoy / vencido:<semana>. NULL = fuera de la ventana.';

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- 1.1 Los documentos
CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  vehicle_id      uuid        NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  expires_on      date,
  number          text,
  issuer          text,
  notes           text,
  not_applicable  boolean     NOT NULL DEFAULT false,
  updated_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_vehicle_kind_key;
ALTER TABLE public.vehicle_documents ADD CONSTRAINT vehicle_documents_vehicle_kind_key UNIQUE (vehicle_id, kind);
ALTER TABLE public.vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_kind;
ALTER TABLE public.vehicle_documents ADD CONSTRAINT vehicle_documents_kind CHECK (kind IN (
  'soat', 'tecnomecanica', 'seguro', 'polizas_rc', 'impuesto', 'extintor', 'tarjeta_propiedad'));
-- La tarjeta de propiedad no vence: guardarle una fecha sería inventar un aviso.
ALTER TABLE public.vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_tarjeta_sin_fecha;
ALTER TABLE public.vehicle_documents ADD CONSTRAINT vehicle_documents_tarjeta_sin_fecha
  CHECK (kind <> 'tarjeta_propiedad' OR expires_on IS NULL);
ALTER TABLE public.vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_len;
ALTER TABLE public.vehicle_documents ADD CONSTRAINT vehicle_documents_len CHECK (
  (number IS NULL OR length(number) <= 60)
  AND (issuer IS NULL OR length(issuer) <= 80)
  AND (notes  IS NULL OR length(notes)  <= 500));

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_org     ON public.vehicle_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_expires ON public.vehicle_documents(expires_on)
  WHERE expires_on IS NOT NULL AND NOT not_applicable;

DROP TRIGGER IF EXISTS tr_vehicle_documents_set_updated_at ON public.vehicle_documents;
CREATE TRIGGER tr_vehicle_documents_set_updated_at
  BEFORE UPDATE ON public.vehicle_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.vehicle_documents IS
  'Documentos por carro (SOAT, técnico-mecánica, seguro, pólizas RCC/RCE, impuesto, extintor, tarjeta de propiedad). Sin fecha = sin dato. vehicles.soat/tecnomec/insurance_expires_at son su espejo (0095). Vencido = aviso, nunca bloqueo.';

-- 1.2 Registro de avisos: una fila por documento + fecha de vencimiento + etapa.
CREATE TABLE IF NOT EXISTS public.vehicle_document_alerts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_document_id uuid        NOT NULL REFERENCES public.vehicle_documents(id) ON DELETE CASCADE,
  vehicle_id          uuid        NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  kind                text        NOT NULL,
  expires_on          date        NOT NULL,
  stage               text        NOT NULL,
  days_left           integer     NOT NULL,
  day                 date        NOT NULL,
  title               text        NOT NULL,
  body                text        NOT NULL,
  recipients          integer     NOT NULL DEFAULT 0,
  dedupe_key          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vehicle_document_alerts DROP CONSTRAINT IF EXISTS vehicle_document_alerts_dedupe_key;
ALTER TABLE public.vehicle_document_alerts ADD CONSTRAINT vehicle_document_alerts_dedupe_key UNIQUE (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_vehicle_document_alerts_doc_day
  ON public.vehicle_document_alerts(vehicle_document_id, day);
CREATE INDEX IF NOT EXISTS idx_vehicle_document_alerts_org
  ON public.vehicle_document_alerts(organization_id, created_at DESC);

-- 1.3 Bitácora del reloj («nunca corrió» no es «todo al día»).
CREATE TABLE IF NOT EXISTS public.vehicle_document_job_runs (
  run_on  date        PRIMARY KEY,
  ran_at  timestamptz NOT NULL DEFAULT now(),
  alerts  integer     NOT NULL DEFAULT 0,
  pushes  integer     NOT NULL DEFAULT 0
);

-- 1.4 Con cuántos días de anticipación se avisa (la dueña: «al menos un mes»).
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS vehicle_doc_alert_days smallint NOT NULL DEFAULT 30;
DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_vehicle_doc_alert_days_range
    CHECK (vehicle_doc_alert_days BETWEEN 30 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;
COMMENT ON COLUMN public.app_settings.vehicle_doc_alert_days
  IS 'Días de anticipación del aviso de documentos del carro (0095). Mínimo 30: la dueña pidió al menos un mes.';

-- -----------------------------------------------------------------------------
-- 2. Relleno inicial: lo que ya tenía vehicles (0002). Si la fila ya existe
--    (la migración corre dos veces), manda la del documento.
-- -----------------------------------------------------------------------------
INSERT INTO public.vehicle_documents (organization_id, vehicle_id, kind, expires_on)
SELECT v.organization_id, v.id, x.kind, x.val
  FROM public.vehicles v
  CROSS JOIN LATERAL (VALUES ('soat', v.soat_expires_at),
                             ('tecnomecanica', v.tecnomec_expires_at),
                             ('seguro', v.insurance_expires_at)) AS x(kind, val)
 WHERE x.val IS NOT NULL
ON CONFLICT (vehicle_id, kind) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. El espejo, en las dos direcciones
-- -----------------------------------------------------------------------------

-- 3.1 documentos → vehicles (solo SOAT, técnico-mecánica y seguro tienen columna).
CREATE OR REPLACE FUNCTION public.vehicle_documents_to_vehicle()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_veh  uuid;
  v_val  date;
BEGIN
  -- Esta fila la escribió el espejo de vehicles: no se devuelve (sin bucle).
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;

  IF TG_OP = 'DELETE' THEN
    v_kind := OLD.kind; v_veh := OLD.vehicle_id; v_val := NULL;
  ELSE
    v_kind := NEW.kind; v_veh := NEW.vehicle_id;
    v_val := CASE WHEN NEW.not_applicable THEN NULL ELSE NEW.expires_on END;
  END IF;

  IF v_kind = 'soat' THEN
    UPDATE public.vehicles SET soat_expires_at = v_val
     WHERE id = v_veh AND soat_expires_at IS DISTINCT FROM v_val;
  ELSIF v_kind = 'tecnomecanica' THEN
    UPDATE public.vehicles SET tecnomec_expires_at = v_val
     WHERE id = v_veh AND tecnomec_expires_at IS DISTINCT FROM v_val;
  ELSIF v_kind = 'seguro' THEN
    UPDATE public.vehicles SET insurance_expires_at = v_val
     WHERE id = v_veh AND insurance_expires_at IS DISTINCT FROM v_val;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_vehicle_documents_to_vehicle ON public.vehicle_documents;
CREATE TRIGGER tr_vehicle_documents_to_vehicle
  AFTER INSERT OR UPDATE OF expires_on, not_applicable OR DELETE ON public.vehicle_documents
  FOR EACH ROW EXECUTE FUNCTION public.vehicle_documents_to_vehicle();

-- 3.2 vehicles → documentos. Llega una fecha: se crea o actualiza la fila (y
--     deja de ser «No aplica»). Se borra la fecha: la fila queda sin fecha.
CREATE OR REPLACE FUNCTION public.vehicle_doc_mirror_in(p_org uuid, p_vehicle uuid, p_kind text, p_val date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_val IS NULL THEN
    UPDATE public.vehicle_documents
       SET expires_on = NULL, updated_by = coalesce(auth.uid(), updated_by)
     WHERE vehicle_id = p_vehicle AND kind = p_kind AND expires_on IS NOT NULL
       AND NOT not_applicable;   -- «No aplica» ya espeja NULL: se deja como está
  ELSE
    INSERT INTO public.vehicle_documents AS vd (organization_id, vehicle_id, kind, expires_on, not_applicable, updated_by)
    VALUES (p_org, p_vehicle, p_kind, p_val, false, auth.uid())
    ON CONFLICT (vehicle_id, kind) DO UPDATE
      SET expires_on = EXCLUDED.expires_on, not_applicable = false,
          updated_by = coalesce(EXCLUDED.updated_by, vd.updated_by)
      WHERE vd.expires_on IS DISTINCT FROM EXCLUDED.expires_on OR vd.not_applicable;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.vehicle_to_documents()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Este cambio lo hizo el espejo de vehicle_documents: no se devuelve.
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.soat_expires_at IS NOT NULL THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'soat', NEW.soat_expires_at);
    END IF;
    IF NEW.tecnomec_expires_at IS NOT NULL THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'tecnomecanica', NEW.tecnomec_expires_at);
    END IF;
    IF NEW.insurance_expires_at IS NOT NULL THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'seguro', NEW.insurance_expires_at);
    END IF;
  ELSE
    IF NEW.soat_expires_at IS DISTINCT FROM OLD.soat_expires_at THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'soat', NEW.soat_expires_at);
    END IF;
    IF NEW.tecnomec_expires_at IS DISTINCT FROM OLD.tecnomec_expires_at THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'tecnomecanica', NEW.tecnomec_expires_at);
    END IF;
    IF NEW.insurance_expires_at IS DISTINCT FROM OLD.insurance_expires_at THEN
      PERFORM public.vehicle_doc_mirror_in(NEW.organization_id, NEW.id, 'seguro', NEW.insurance_expires_at);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_vehicles_to_documents ON public.vehicles;
CREATE TRIGGER tr_vehicles_to_documents
  AFTER INSERT OR UPDATE OF soat_expires_at, tecnomec_expires_at, insurance_expires_at ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.vehicle_to_documents();

-- -----------------------------------------------------------------------------
-- 4. RLS: el jefe de la organización lee. Se ESCRIBE por save_vehicle_document
--    (y por los disparadores del espejo). Directo, solo se lee.
-- -----------------------------------------------------------------------------
ALTER TABLE public.vehicle_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_document_alerts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_document_job_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.vehicle_documents, public.vehicle_document_alerts, public.vehicle_document_job_runs
  FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.vehicle_documents, public.vehicle_document_alerts, public.vehicle_document_job_runs
  TO authenticated;

DROP POLICY IF EXISTS vdoc_select_admin ON public.vehicle_documents;
CREATE POLICY vdoc_select_admin ON public.vehicle_documents FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS vdoc_alerts_select_admin ON public.vehicle_document_alerts;
CREATE POLICY vdoc_alerts_select_admin ON public.vehicle_document_alerts FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS vdoc_job_runs_select_admin ON public.vehicle_document_job_runs;
CREATE POLICY vdoc_job_runs_select_admin ON public.vehicle_document_job_runs FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- 5. RPC — el jefe guarda un documento
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_vehicle_document(
  p_vehicle_id     uuid,
  p_kind           text,
  p_expires_on     date,
  p_number         text,
  p_issuer         text,
  p_notes          text,
  p_not_applicable boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v_veh public.vehicles%ROWTYPE;
  v_exp date := p_expires_on;
  d     public.vehicle_documents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'NOT_ADMIN: solo el administrador edita los documentos del carro' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_veh FROM public.vehicles
   WHERE id = p_vehicle_id AND deleted_at IS NULL AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND: ese carro no existe o no es de tu organización' USING ERRCODE = '22023';
  END IF;

  IF p_kind IS NULL OR NOT (p_kind = ANY (public.vehicle_document_kinds())) THEN
    RAISE EXCEPTION 'BAD_KIND: documento desconocido (%)', coalesce(p_kind, 'vacío') USING ERRCODE = '22023';
  END IF;

  -- La tarjeta de propiedad no vence: la fecha se ignora.
  IF p_kind = 'tarjeta_propiedad' THEN v_exp := NULL; END IF;
  IF v_exp IS NOT NULL
     AND (v_exp < DATE '2000-01-01' OR v_exp > public.vehicle_docs_today() + 7300) THEN
    RAISE EXCEPTION 'BAD_DATE: esa fecha de vencimiento no se ve bien (%)', v_exp USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.vehicle_documents AS vd
    (organization_id, vehicle_id, kind, expires_on, number, issuer, notes, not_applicable, updated_by)
  VALUES (v_veh.organization_id, v_veh.id, p_kind, v_exp,
          nullif(btrim(coalesce(p_number, '')), ''),
          nullif(btrim(coalesce(p_issuer, '')), ''),
          nullif(btrim(coalesce(p_notes, '')), ''),
          coalesce(p_not_applicable, false), auth.uid())
  ON CONFLICT (vehicle_id, kind) DO UPDATE
    SET expires_on     = EXCLUDED.expires_on,
        number         = EXCLUDED.number,
        issuer         = EXCLUDED.issuer,
        notes          = EXCLUDED.notes,
        not_applicable = EXCLUDED.not_applicable,
        updated_by     = EXCLUDED.updated_by
  RETURNING * INTO d;

  RETURN jsonb_build_object(
    'id', d.id, 'vehicle_id', d.vehicle_id, 'kind', d.kind, 'label', public.vehicle_document_label(d.kind),
    'expires_on', d.expires_on, 'number', d.number, 'issuer', d.issuer, 'notes', d.notes,
    'not_applicable', d.not_applicable, 'updated_at', d.updated_at);
END;
$$;

COMMENT ON FUNCTION public.save_vehicle_document(uuid, text, date, text, text, text, boolean)
  IS 'El jefe guarda un documento del carro (0095). Valida rol, organización, tipo y fecha. SOAT/técnico-mecánica/seguro quedan también en vehicles (espejo). No bloquea nada.';

-- -----------------------------------------------------------------------------
-- 5b. RPC — el CONDUCTOR ve los documentos que importan para salir a la vía
-- -----------------------------------------------------------------------------
-- La dueña (30-sep-2026), sobre si el conductor debe ver los vencidos al iniciar
-- turno: «y los más relevantes». Vencido sigue siendo SOLO un aviso.
--
-- QUÉ DEVUELVE: una fila por carro × documento relevante de los carros vivos de
-- SU organización (o de los que pida, si son de su organización; los demás se
-- ignoran en silencio). También cuando no hay dato, para que la app distinga
-- «al día» de «nadie lo cargó». Relevantes = los que pide la vía:
--   soat, tecnomecanica, seguro, polizas_rc, extintor
-- Fuera: el impuesto y la tarjeta de propiedad (no son de manejar). Y de ningún
-- documento sale el número, la entidad ni la nota: el conductor no los necesita.
--
-- status (hoy = vehicle_docs_today(), Bogotá; N = vehicle_doc_alert_days, la
-- MISMA ventana del aviso a los jefes, nunca menos de 30):
--   'no_aplica'   el jefe lo marcó «No aplica» (sin fecha ni días)
--   'sin_dato'    sin fila o sin fecha (nunca se asume una)
--   'vencido'     venció (days_left negativo)
--   'hoy'         vence hoy (todavía vale hoy)
--   'por_vencer'  faltan 1..N días
--   'al_dia'      faltan más de N días
--
-- Quién: un CONDUCTOR activo (profiles.role = 'driver', is_active, sin borrar).
-- Se lee de profiles y no del JWT: un rol viejo en el token no abre nada. Ni el
-- jefe (tiene la tabla), ni el tripulante, ni anon.
CREATE OR REPLACE FUNCTION public.driver_vehicle_documents(p_vehicle_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  vehicle_id     uuid,
  kind           text,
  label          text,
  expires_on     date,
  days_left      integer,
  status         text,
  not_applicable boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_uid    uuid := auth.uid();
  v_me     public.profiles%ROWTYPE;
  v_today  date := public.vehicle_docs_today();
  v_window integer;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT * INTO v_me FROM public.profiles p WHERE p.id = v_uid;
  END IF;
  IF v_uid IS NULL OR v_me.id IS NULL OR v_me.role::text <> 'driver'
     OR v_me.deleted_at IS NOT NULL OR NOT coalesce(v_me.is_active, false) THEN
    RAISE EXCEPTION 'NOT_A_DRIVER: solo un conductor activo ve los documentos del carro' USING ERRCODE = '42501';
  END IF;

  SELECT s.vehicle_doc_alert_days INTO v_window FROM public.app_settings s WHERE s.id = 'singleton';
  v_window := greatest(30, coalesce(v_window, 30));

  RETURN QUERY
  SELECT v.id,
         k.kind,
         public.vehicle_document_label(k.kind),
         CASE WHEN coalesce(d.not_applicable, false) THEN NULL ELSE d.expires_on END,
         CASE WHEN coalesce(d.not_applicable, false) OR d.expires_on IS NULL THEN NULL
              ELSE (d.expires_on - v_today) END,
         CASE
           WHEN coalesce(d.not_applicable, false) THEN 'no_aplica'
           WHEN d.expires_on IS NULL              THEN 'sin_dato'
           WHEN d.expires_on <  v_today           THEN 'vencido'
           WHEN d.expires_on =  v_today           THEN 'hoy'
           WHEN d.expires_on - v_today <= v_window THEN 'por_vencer'
           ELSE 'al_dia'
         END,
         coalesce(d.not_applicable, false)
    FROM public.vehicles v
   CROSS JOIN unnest(ARRAY['soat', 'tecnomecanica', 'seguro', 'polizas_rc', 'extintor']::text[])
              WITH ORDINALITY AS k(kind, ord)
    LEFT JOIN public.vehicle_documents d ON d.vehicle_id = v.id AND d.kind = k.kind
   WHERE v.organization_id = v_me.organization_id
     AND v.deleted_at IS NULL
     AND (p_vehicle_ids IS NULL OR v.id = ANY (p_vehicle_ids))
   ORDER BY v.internal_code NULLS LAST, v.id, k.ord;
END;
$$;

COMMENT ON FUNCTION public.driver_vehicle_documents(uuid[])
  IS 'El conductor ve los documentos de la vía (SOAT, técnico-mecánica, seguro, pólizas RCC/RCE, extintor) de los carros de su organización, con estado (no_aplica/sin_dato/vencido/hoy/por_vencer/al_dia). Sin número, entidad ni nota. Solo aviso: no bloquea (0095).';

-- -----------------------------------------------------------------------------
-- 6. El reloj diario (7:00 Bogotá): avisa a los jefes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vehicle_docs_run_daily(p_today date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today  date := coalesce(p_today, public.vehicle_docs_today());
  v_window integer;
  r        record;
  v_days   integer;
  v_stage  text;
  v_label  text;
  v_car    text;
  v_title  text;
  v_body   text;
  v_alert  uuid;
  v_n      integer;
  v_alerts integer := 0;
  v_pushes integer := 0;
BEGIN
  SELECT vehicle_doc_alert_days INTO v_window FROM public.app_settings WHERE id = 'singleton';
  v_window := greatest(30, coalesce(v_window, 30));

  FOR r IN
    SELECT d.id, d.organization_id, d.vehicle_id, d.kind, d.expires_on,
           v.internal_code, v.license_plate
      FROM public.vehicle_documents d
      JOIN public.vehicles v ON v.id = d.vehicle_id
     WHERE v.deleted_at IS NULL
       AND NOT d.not_applicable
       AND d.expires_on IS NOT NULL
       AND d.expires_on - v_today <= v_window
     ORDER BY d.expires_on, v.internal_code
  LOOP
    v_days  := r.expires_on - v_today;
    v_stage := public.vehicle_doc_stage(v_days, v_window);
    CONTINUE WHEN v_stage IS NULL;
    -- A lo sumo un aviso por documento por día.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.vehicle_document_alerts a
                           WHERE a.vehicle_document_id = r.id AND a.day = v_today);

    v_label := public.vehicle_document_label(r.kind);
    v_car   := coalesce(r.internal_code, r.license_plate, 'Carro')
               || CASE WHEN r.internal_code IS NOT NULL AND r.license_plate IS NOT NULL
                       THEN ' (' || r.license_plate || ')' ELSE '' END;
    IF v_days < 0 THEN
      v_title := 'Vencido: ' || v_label || ' · ' || coalesce(r.internal_code, r.license_plate, 'carro');
      v_body  := v_car || '. Venció hace ' || (-v_days)::text || CASE WHEN v_days = -1 THEN ' día' ELSE ' días' END
                 || ' (el ' || public.vehicle_doc_fmt(r.expires_on) || '). Es un aviso: el carro no se bloquea.'
                 || ' Cuando se renueve, carga la fecha nueva en Repuestos.';
    ELSIF v_days = 0 THEN
      v_title := 'Vence hoy: ' || v_label || ' · ' || coalesce(r.internal_code, r.license_plate, 'carro');
      v_body  := v_car || '. Vence hoy, ' || public.vehicle_doc_fmt(r.expires_on)
                 || '. Cuando se renueve, carga la fecha nueva en Repuestos.';
    ELSE
      v_title := 'Por vencer: ' || v_label || ' · ' || coalesce(r.internal_code, r.license_plate, 'carro');
      v_body  := v_car || '. Vence en ' || v_days::text || CASE WHEN v_days = 1 THEN ' día' ELSE ' días' END
                 || ', el ' || public.vehicle_doc_fmt(r.expires_on)
                 || '. Cuando se renueve, carga la fecha nueva en Repuestos.';
    END IF;

    v_alert := NULL;
    INSERT INTO public.vehicle_document_alerts
      (organization_id, vehicle_document_id, vehicle_id, kind, expires_on, stage, days_left, day, title, body, dedupe_key)
    VALUES (r.organization_id, r.id, r.vehicle_id, r.kind, r.expires_on, v_stage, v_days, v_today, v_title, v_body,
            'vdoc:' || r.id::text || ':' || r.expires_on::text || ':' || v_stage)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_alert;
    CONTINUE WHEN v_alert IS NULL;
    v_alerts := v_alerts + 1;

    -- Mismo camino que 0089/0090: los jefes de ESA organización, por la bandeja.
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    SELECT rc.profile_id, v_title, v_body, '/#/repuestos?veh=' || r.vehicle_id::text,
           'vdoc:' || v_alert::text || ':' || rc.profile_id::text, now()
      FROM public.ops_alert_recipients() rc
      JOIN public.profiles p ON p.id = rc.profile_id
     WHERE p.organization_id = r.organization_id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE public.vehicle_document_alerts SET recipients = v_n WHERE id = v_alert;
    v_pushes := v_pushes + v_n;
  END LOOP;

  INSERT INTO public.vehicle_document_job_runs (run_on, ran_at, alerts, pushes)
  VALUES (v_today, now(), v_alerts, v_pushes)
  ON CONFLICT (run_on) DO UPDATE
    SET ran_at = EXCLUDED.ran_at,
        alerts = vehicle_document_job_runs.alerts + EXCLUDED.alerts,
        pushes = vehicle_document_job_runs.pushes + EXCLUDED.pushes;

  RETURN jsonb_build_object('today', v_today, 'window', v_window, 'alerts', v_alerts, 'pushes', v_pushes);
END;
$$;

COMMENT ON FUNCTION public.vehicle_docs_run_daily(date)
  IS 'Reloj diario de documentos del carro (0095): avisa a los jefes por notification_outbox en las etapas ventana (N días)/15/7/1, hoy y una vez por semana vencido. Nunca bloquea.';

-- -----------------------------------------------------------------------------
-- 7. Permisos de las funciones
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  -- Internas: las llaman los disparadores, el reloj o las funciones de arriba.
  FOREACH f IN ARRAY ARRAY[
    'public.vehicle_docs_today()',
    'public.vehicle_doc_stage(integer, integer)',
    'public.vehicle_doc_fmt(date)',
    'public.vehicle_documents_to_vehicle()',
    'public.vehicle_doc_mirror_in(uuid, uuid, text, date)',
    'public.vehicle_to_documents()',
    'public.vehicle_docs_run_daily(date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- De la app (save_vehicle_document y driver_vehicle_documents validan quién llama).
  FOREACH f IN ARRAY ARRAY[
    'public.save_vehicle_document(uuid, text, date, text, text, text, boolean)',
    'public.driver_vehicle_documents(uuid[])',
    'public.vehicle_document_kinds()',
    'public.vehicle_document_label(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 8. El reloj: 7:00 a. m. de Bogotá = 12:00 UTC (pg_cron corre en GMT), la
--    misma hora del facturario (0090).
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('vehicle-docs-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.schedule('vehicle-docs-daily', '0 12 * * *', $job$SELECT public.vehicle_docs_run_daily();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): los documentos quedan creados pero nadie corre el aviso diario.', SQLERRM;
END
$do$;

COMMIT;
