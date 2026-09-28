-- =============================================================================
-- Migration 0090 — Facturario: la cuenta de cobro mensual del tripulante
-- Rediseño del auxiliar (27-sep-2026) · paquete P12a · AJUSTES §5 y §8
--
-- QUÉ HACE
--   Cada tripulante tiene SU cuenta de cobro (monto, día de corte y plazos por
--   persona, con los valores por defecto de la organización). Cada mes, el día
--   de corte, se abre una cuenta de cobro del período; el tripulante sube el
--   comprobante (archivo en el bucket PRIVADO `payment-proofs`) y el jefe lo
--   aprueba o lo rechaza con un motivo de la lista, o marca el pago a mano.
--
-- LAS REGLAS SON LAS DEL DISEÑO (`cobro-engine.jsx`, `cbSimulate`), en SQL:
--     día 0  = corte (se abre el período)                 → aviso «generado»
--     vence  = corte + plazo                              → «venceHoy» (8:00 a. m.)
--     aviso  = vence − aviso (si aviso > 0 y cae después del corte) → «recordatorio»
--     vence + 1                                           → «vencido» + al jefe «admMora»
--     pausa − 1 (solo si gracia > 1)                      → «ultimoDia»
--     pausa  = vence + gracia + 1                         → «bloqueado» + al jefe «admBloqueado»
--   · Con un comprobante EN REVISIÓN no corre ningún aviso de fecha y NO se
--     pausa (así lo diseñó cbSimulate; decisión de la dueña, AJUSTES §4).
--   · Aprobar el comprobante o «marcar pagado» deja el mes al día y reactiva.
--   · Rechazar (motivo obligatorio de CB_REASONS) NO mueve la fecha límite: si
--     ya pasó la fecha de pausa, se pausa en ese mismo momento.
--   · Si ya estaba pausado y sube comprobante, sigue pausado hasta que lo
--     aprueben (cbSimulate: subir no des-bloquea). Única excepción, también de
--     cbSimulate: si sube el comprobante EL MISMO DÍA en que se pausó, ese día
--     gana el comprobante (los eventos del día van antes que la pausa).
--
-- LA PAUSA bloquea SOLO los INSERT de reservas nuevas que hace el propio
-- tripulante, con un error de texto fijo (SQLSTATE RB402). Lo ya pedido sigue en
-- pie, el jefe sí puede crearle un traslado, y NO toca la suspensión de 0081
-- (`profiles.is_active`): son dos cosas distintas.
--
-- EL RELOJ: `billing_run_daily()` con pg_cron todos los días a las 7:00 de
-- Bogotá (12:00 UTC). Abre los períodos, mueve los estados, pausa y encola los
-- avisos de CB_ALERTS en `notification_outbox`. Cada aviso queda UNA vez en
-- `billing_alerts` (clave única por cuenta de cobro + aviso): correr el reloj
-- dos veces el mismo día no repite nada.
--   · Si el reloj se salta días, NO los repite: los avisos de fecha salen solo
--     el día exacto. La pausa sí se pone tarde (es «día ≥ pausa»), y el
--     guardián de reservas la calcula en vivo, así que nunca depende del reloj.
--
-- Hoy = fecha de Bogotá (`billing_today()`). Solo una sesión `postgres` (las
-- pruebas locales) puede fijarla con `SET rendio.billing_today = 'AAAA-MM-DD'`;
-- desde PostgREST (sesión `authenticator`) se ignora.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. Sin tocar migraciones
-- anteriores. Down: down_migrations/0090_facturario.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Utilidades (fecha de hoy, formato de dinero y de fechas como el diseño)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_today()
RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN session_user = 'postgres'
     AND nullif(current_setting('rendio.billing_today', true), '') IS NOT NULL
      THEN current_setting('rendio.billing_today', true)::date
    ELSE (now() AT TIME ZONE 'America/Bogota')::date
  END;
$$;

COMMENT ON FUNCTION public.billing_today()
  IS 'Hoy en Bogotá. Solo una sesión postgres (pruebas locales) puede fijarlo con rendio.billing_today.';

-- cbMoney: '$' + miles con punto ($150.000)
CREATE OR REPLACE FUNCTION public.billing_money(p_n numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT '$' || replace(to_char(round(coalesce(p_n, 0)), 'FM999,999,999,990'), ',', '.');
$$;

-- cbFmt: toLocaleDateString('es-CO', {day:'numeric', month:'short'}).replace('.','')
-- → «19 de oct», «14 de sept» (así lo pinta el navegador; verificado en el diseño).
CREATE OR REPLACE FUNCTION public.billing_fmt(p_d date)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT extract(day FROM p_d)::int::text || ' de ' ||
    (ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'])[extract(month FROM p_d)::int];
$$;

CREATE OR REPLACE FUNCTION public.billing_month_name(p_d date)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
                'septiembre','octubre','noviembre','diciembre'])[extract(month FROM p_d)::int];
$$;

-- cbPl: «1 día» / «2 días»
CREATE OR REPLACE FUNCTION public.billing_pl(p_n int, p_s text, p_p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_n::text || ' ' || CASE WHEN p_n = 1 THEN p_s ELSE p_p END;
$$;

-- El corte del mes: el día de corte, o el último día del mes si ese mes es más
-- corto (corte 31 → 30 de noviembre, 28/29 de febrero).
CREATE OR REPLACE FUNCTION public.billing_cut_date(p_year int, p_month int, p_cut_day int)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT make_date(p_year, p_month,
    least(p_cut_day, extract(day FROM (make_date(p_year, p_month, 1) + interval '1 month - 1 day'))::int));
$$;

-- El corte vigente a una fecha: el de este mes si ya llegó; si no, el del mes anterior.
CREATE OR REPLACE FUNCTION public.billing_last_cut(p_today date, p_cut_day int)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.billing_cut_date(extract(year FROM p_today)::int, extract(month FROM p_today)::int, p_cut_day) <= p_today
      THEN public.billing_cut_date(extract(year FROM p_today)::int, extract(month FROM p_today)::int, p_cut_day)
    ELSE public.billing_cut_date(extract(year FROM (p_today - interval '1 month'))::int,
                                 extract(month FROM (p_today - interval '1 month'))::int, p_cut_day)
  END;
$$;

-- El próximo corte estrictamente después de una fecha.
CREATE OR REPLACE FUNCTION public.billing_next_cut(p_after date, p_cut_day int)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.billing_cut_date(extract(year FROM p_after)::int, extract(month FROM p_after)::int, p_cut_day) > p_after
      THEN public.billing_cut_date(extract(year FROM p_after)::int, extract(month FROM p_after)::int, p_cut_day)
    ELSE public.billing_cut_date(extract(year FROM (p_after + interval '1 month'))::int,
                                 extract(month FROM (p_after + interval '1 month'))::int, p_cut_day)
  END;
$$;

-- Los motivos de rechazo: CB_REASONS del diseño, tal cual.
CREATE OR REPLACE FUNCTION public.billing_reject_reasons()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY['No se lee el comprobante', 'El monto no coincide',
               'No es a la cuenta de Rendio', 'La fecha es anterior al cobro']::text[];
$$;

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- 1.1 Configuración de la organización: plazos por defecto (CB_CFG: plazo 5,
--     aviso 2, gracia 3) y monto por defecto SIN valor (nunca un monto inventado).
CREATE TABLE IF NOT EXISTS public.billing_settings (
  organization_id     uuid        PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  default_amount_cop  integer,
  due_days            smallint    NOT NULL DEFAULT 5,
  notice_days         smallint    NOT NULL DEFAULT 2,
  grace_days          smallint    NOT NULL DEFAULT 3,
  holder_name         text,
  holder_nit          text,
  updated_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_amount_pos;
ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_amount_pos
  CHECK (default_amount_cop IS NULL OR default_amount_cop > 0);
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_days_range;
ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_days_range
  CHECK (due_days BETWEEN 0 AND 28 AND notice_days BETWEEN 0 AND 28 AND grace_days BETWEEN 0 AND 28);

COMMENT ON TABLE public.billing_settings IS
  'Facturario (0090): plazos por defecto de la organización y titular de las cuentas. El monto por defecto nace vacío: lo carga el jefe.';

-- 1.2 Métodos de pago de la organización (los ve el tripulante en «Cómo pagar»).
CREATE TABLE IF NOT EXISTS public.billing_payment_methods (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind             text        NOT NULL DEFAULT 'bank',
  label            text        NOT NULL,
  account_type     text,
  account_number   text        NOT NULL,
  holder_name      text,
  holder_nit       text,
  position         smallint    NOT NULL DEFAULT 0,
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_payment_methods DROP CONSTRAINT IF EXISTS billing_payment_methods_kind;
ALTER TABLE public.billing_payment_methods ADD CONSTRAINT billing_payment_methods_kind
  CHECK (kind IN ('bank', 'nequi', 'daviplata', 'other'));
ALTER TABLE public.billing_payment_methods DROP CONSTRAINT IF EXISTS billing_payment_methods_not_blank;
ALTER TABLE public.billing_payment_methods ADD CONSTRAINT billing_payment_methods_not_blank
  CHECK (length(btrim(label)) > 0 AND length(btrim(account_number)) > 0);
CREATE INDEX IF NOT EXISTS idx_billing_payment_methods_org ON public.billing_payment_methods(organization_id, position);

-- 1.3 La cuenta de cobro de cada tripulante.
CREATE SEQUENCE IF NOT EXISTS public.billing_reference_seq START 1;

CREATE TABLE IF NOT EXISTS public.auxiliar_billing (
  auxiliar_profile_id uuid        PRIMARY KEY REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reference           text        NOT NULL DEFAULT ('AUX-' || lpad(nextval('public.billing_reference_seq')::text, 4, '0')),
  active              boolean     NOT NULL DEFAULT true,
  amount_cop          integer,
  amount_next_cop     integer,
  cut_day             smallint    NOT NULL,
  due_days            smallint,
  notice_days         smallint,
  grace_days          smallint,
  starts_on           date        NOT NULL DEFAULT public.billing_today(),
  paused_at           timestamptz,
  push_enabled        boolean     NOT NULL DEFAULT true,
  reminder_enabled    boolean     NOT NULL DEFAULT true,
  alerts_seen_at      timestamptz,
  created_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_reference_key;
ALTER TABLE public.auxiliar_billing ADD CONSTRAINT auxiliar_billing_reference_key UNIQUE (reference);
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_amounts_pos;
ALTER TABLE public.auxiliar_billing ADD CONSTRAINT auxiliar_billing_amounts_pos
  CHECK ((amount_cop IS NULL OR amount_cop > 0) AND (amount_next_cop IS NULL OR amount_next_cop > 0));
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_cut_day_range;
ALTER TABLE public.auxiliar_billing ADD CONSTRAINT auxiliar_billing_cut_day_range CHECK (cut_day BETWEEN 1 AND 31);
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_days_range;
ALTER TABLE public.auxiliar_billing ADD CONSTRAINT auxiliar_billing_days_range
  CHECK ((due_days IS NULL OR due_days BETWEEN 0 AND 28)
     AND (notice_days IS NULL OR notice_days BETWEEN 0 AND 28)
     AND (grace_days IS NULL OR grace_days BETWEEN 0 AND 28));
CREATE INDEX IF NOT EXISTS idx_auxiliar_billing_org ON public.auxiliar_billing(organization_id);

COMMENT ON TABLE public.auxiliar_billing IS
  'Facturario (0090): cuenta de cobro por tripulante. Plazos NULL = los de la organización. amount_next_cop se aplica al abrir el próximo período. paused_at lo mueve el reloj; la pausa real la calcula billing_is_paused() en vivo.';

-- 1.4 Cuenta de cobro de un período (una por tripulante y corte).
CREATE TABLE IF NOT EXISTS public.billing_statements (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  period_start        date        NOT NULL,
  period_end          date        NOT NULL,
  amount_cop          integer     NOT NULL,
  discount_cop        integer     NOT NULL DEFAULT 0,
  discount_note       text,
  due_days            smallint    NOT NULL,
  notice_days         smallint    NOT NULL,
  grace_days          smallint    NOT NULL,
  due_date            date        GENERATED ALWAYS AS (period_start + due_days::int) STORED,
  block_date          date        GENERATED ALWAYS AS (period_start + due_days::int + grace_days::int + 1) STORED,
  status              text        NOT NULL DEFAULT 'pendiente',
  proof_state         text        NOT NULL DEFAULT 'none',
  review_on           date,
  rejected_reason     text,
  blocked_at          timestamptz,
  blocked_on          date,
  paid_at             timestamptz,
  paid_on             date,
  paid_via            text,
  paid_by             uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  was_blocked         boolean,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_period_key;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_period_key UNIQUE (auxiliar_profile_id, period_start);
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_amounts;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_amounts
  CHECK (amount_cop > 0 AND discount_cop >= 0 AND discount_cop <= amount_cop);
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_status;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_status
  CHECK (status IN ('pendiente', 'porVencer', 'venceHoy', 'vencido', 'bloqueado', 'pagado'));
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_proof_state;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_proof_state
  CHECK (proof_state IN ('none', 'review', 'rejected', 'approved'));
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_paid_via;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_paid_via
  CHECK (paid_via IS NULL OR paid_via IN ('proof', 'manual'));
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_paid_consistent;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_paid_consistent
  CHECK ((paid_at IS NULL) = (paid_on IS NULL));
CREATE INDEX IF NOT EXISTS idx_billing_statements_org ON public.billing_statements(organization_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_billing_statements_unpaid ON public.billing_statements(auxiliar_profile_id) WHERE paid_at IS NULL;

COMMENT ON TABLE public.billing_statements IS
  'Facturario (0090): cuenta de cobro de un período. Los plazos quedan congelados al abrirla: cambiar los de la cuenta no mueve fechas ya publicadas. El estado se calcula con billing_statement_json(); status es una copia para listar.';

-- 1.5 Comprobantes (archivo en el bucket privado payment-proofs).
CREATE TABLE IF NOT EXISTS public.billing_proofs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id        uuid        NOT NULL REFERENCES public.billing_statements(id) ON DELETE CASCADE,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  storage_path        text        NOT NULL,
  content_type        text,
  size_bytes          integer,
  method_id           uuid        REFERENCES public.billing_payment_methods(id) ON DELETE SET NULL,
  via_label           text        NOT NULL,
  declared_amount_cop integer,
  status              text        NOT NULL DEFAULT 'review',
  reject_reason       text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  submitted_on        date        NOT NULL,
  reviewed_at         timestamptz,
  reviewed_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_proofs DROP CONSTRAINT IF EXISTS billing_proofs_path_key;
ALTER TABLE public.billing_proofs ADD CONSTRAINT billing_proofs_path_key UNIQUE (storage_path);
ALTER TABLE public.billing_proofs DROP CONSTRAINT IF EXISTS billing_proofs_status;
ALTER TABLE public.billing_proofs ADD CONSTRAINT billing_proofs_status CHECK (status IN ('review', 'approved', 'rejected'));
ALTER TABLE public.billing_proofs DROP CONSTRAINT IF EXISTS billing_proofs_reason;
ALTER TABLE public.billing_proofs ADD CONSTRAINT billing_proofs_reason CHECK (
  (status = 'rejected' AND reject_reason IN ('No se lee el comprobante', 'El monto no coincide',
                                             'No es a la cuenta de Rendio', 'La fecha es anterior al cobro'))
  OR (status <> 'rejected' AND reject_reason IS NULL));
ALTER TABLE public.billing_proofs DROP CONSTRAINT IF EXISTS billing_proofs_via_not_blank;
ALTER TABLE public.billing_proofs ADD CONSTRAINT billing_proofs_via_not_blank CHECK (length(btrim(via_label)) > 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_proofs_one_in_review
  ON public.billing_proofs(statement_id) WHERE status = 'review';
CREATE INDEX IF NOT EXISTS idx_billing_proofs_org_status ON public.billing_proofs(organization_id, status, submitted_at);

-- 1.6 Pagos (el que salda la cuenta: por comprobante aprobado o a mano del jefe).
CREATE TABLE IF NOT EXISTS public.billing_payments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id        uuid        NOT NULL REFERENCES public.billing_statements(id) ON DELETE CASCADE,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  source              text        NOT NULL,
  proof_id            uuid        REFERENCES public.billing_proofs(id) ON DELETE SET NULL,
  amount_cop          integer     NOT NULL,
  via_label           text,
  paid_on             date        NOT NULL,
  recorded_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_statement_key;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_statement_key UNIQUE (statement_id);
ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_source;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_source CHECK (source IN ('proof', 'manual'));
ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_amount_pos;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_amount_pos CHECK (amount_cop >= 0);

-- 1.7 Avisos: el «Centro» de notificaciones del tripulante y del jefe. Una fila
--     por cuenta de cobro + aviso (o por comprobante + aviso en los que se
--     repiten: recibido, rechazado, admRevisar). La push sale por
--     notification_outbox solo la primera vez.
CREATE TABLE IF NOT EXISTS public.billing_alerts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  statement_id        uuid        NOT NULL REFERENCES public.billing_statements(id) ON DELETE CASCADE,
  proof_id            uuid        REFERENCES public.billing_proofs(id) ON DELETE SET NULL,
  audience            text        NOT NULL,
  key                 text        NOT NULL,
  day                 date        NOT NULL,
  day_index           integer     NOT NULL,
  title               text        NOT NULL,
  body                text        NOT NULL,
  tone                text        NOT NULL,
  pushed              boolean     NOT NULL DEFAULT false,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_alerts DROP CONSTRAINT IF EXISTS billing_alerts_dedupe_key;
ALTER TABLE public.billing_alerts ADD CONSTRAINT billing_alerts_dedupe_key UNIQUE (dedupe_key);
ALTER TABLE public.billing_alerts DROP CONSTRAINT IF EXISTS billing_alerts_audience;
ALTER TABLE public.billing_alerts ADD CONSTRAINT billing_alerts_audience CHECK (audience IN ('aux', 'admin'));
ALTER TABLE public.billing_alerts DROP CONSTRAINT IF EXISTS billing_alerts_key;
ALTER TABLE public.billing_alerts ADD CONSTRAINT billing_alerts_key CHECK (key IN (
  'generado', 'recordatorio', 'venceHoy', 'vencido', 'ultimoDia', 'bloqueado',
  'recibido', 'aprobado', 'rechazado', 'admRevisar', 'admMora', 'admBloqueado'));
CREATE INDEX IF NOT EXISTS idx_billing_alerts_aux ON public.billing_alerts(auxiliar_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_alerts_org ON public.billing_alerts(organization_id, audience, created_at DESC);

-- 1.8 Bitácora del reloj (para saber si corrió; «nunca corrió» no es «todo al día»).
CREATE TABLE IF NOT EXISTS public.billing_job_runs (
  run_on     date        PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  opened     integer     NOT NULL DEFAULT 0,
  alerts     integer     NOT NULL DEFAULT 0,
  paused     integer     NOT NULL DEFAULT 0
);

-- updated_at
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_settings','billing_payment_methods','auxiliar_billing','billing_statements','billing_proofs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tr_%1$s_set_updated_at ON public.%1$s', t);
    EXECUTE format('CREATE TRIGGER tr_%1$s_set_updated_at BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 2. RLS: el tripulante solo lo suyo; el jefe su organización.
--    Las cuentas, cuentas de cobro, comprobantes, pagos y avisos se ESCRIBEN solo
--    por las funciones de abajo (SECURITY DEFINER). Directo, solo se lee.
-- -----------------------------------------------------------------------------
ALTER TABLE public.billing_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auxiliar_billing        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_statements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_proofs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_alerts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_job_runs        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_settings, public.billing_payment_methods, public.auxiliar_billing,
              public.billing_statements, public.billing_proofs, public.billing_payments,
              public.billing_alerts, public.billing_job_runs FROM anon, PUBLIC;
REVOKE ALL ON public.auxiliar_billing, public.billing_statements, public.billing_proofs,
              public.billing_payments, public.billing_alerts, public.billing_job_runs FROM authenticated;
GRANT SELECT ON public.auxiliar_billing, public.billing_statements, public.billing_proofs,
                public.billing_payments, public.billing_alerts, public.billing_job_runs TO authenticated;
REVOKE ALL ON public.billing_settings, public.billing_payment_methods FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_settings, public.billing_payment_methods TO authenticated;
REVOKE ALL ON SEQUENCE public.billing_reference_seq FROM anon, authenticated, PUBLIC;

-- Configuración de la organización: la leen todos los de la org (el tripulante
-- necesita el titular y el NIT); la escribe el jefe de esa org.
DROP POLICY IF EXISTS p_billing_settings_select ON public.billing_settings;
CREATE POLICY p_billing_settings_select ON public.billing_settings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org()
         AND public.current_user_role() IN ('admin', 'auxiliar'));
DROP POLICY IF EXISTS p_billing_settings_write_admin ON public.billing_settings;
CREATE POLICY p_billing_settings_write_admin ON public.billing_settings FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Métodos de pago: el tripulante ve los activos de su org; el jefe todos y los edita.
DROP POLICY IF EXISTS p_billing_methods_select_aux ON public.billing_payment_methods;
CREATE POLICY p_billing_methods_select_aux ON public.billing_payment_methods FOR SELECT TO authenticated
  USING (public.current_user_role() = 'auxiliar' AND active AND organization_id = public.current_user_org());
DROP POLICY IF EXISTS p_billing_methods_admin ON public.billing_payment_methods;
CREATE POLICY p_billing_methods_admin ON public.billing_payment_methods FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Lo del tripulante: su fila, o el jefe de su org.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auxiliar_billing','billing_statements','billing_proofs','billing_payments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS p_%1$s_select_own ON public.%1$s', t);
    EXECUTE format($p$CREATE POLICY p_%1$s_select_own ON public.%1$s FOR SELECT TO authenticated
      USING (auxiliar_profile_id = public.current_auxiliar_id())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS p_%1$s_select_admin ON public.%1$s', t);
    EXECUTE format($p$CREATE POLICY p_%1$s_select_admin ON public.%1$s FOR SELECT TO authenticated
      USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())$p$, t);
  END LOOP;
END
$do$;

DROP POLICY IF EXISTS p_billing_alerts_select_own ON public.billing_alerts;
CREATE POLICY p_billing_alerts_select_own ON public.billing_alerts FOR SELECT TO authenticated
  USING (audience = 'aux' AND auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_billing_alerts_select_admin ON public.billing_alerts;
CREATE POLICY p_billing_alerts_select_admin ON public.billing_alerts FOR SELECT TO authenticated
  USING (audience = 'admin' AND public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_billing_job_runs_select_admin ON public.billing_job_runs;
CREATE POLICY p_billing_job_runs_select_admin ON public.billing_job_runs FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- 3. Bucket privado de comprobantes
--    Ruta: {org_id}/{profile_id del tripulante}/{statement_id}/{archivo}
--    Sube solo el tripulante a su carpeta; lee él y el jefe de su org. Nadie
--    reemplaza ni borra desde el cliente.
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payment-proofs', 'payment-proofs', false, 10 * 1024 * 1024,
        ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']::text[])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS p_payment_proofs_insert_aux ON storage.objects;
CREATE POLICY p_payment_proofs_insert_aux ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payment-proofs'
    AND public.current_user_role() = 'auxiliar'
    AND (storage.foldername(name))[1] = public.current_user_org()::text
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS p_payment_proofs_select ON storage.objects;
CREATE POLICY p_payment_proofs_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'payment-proofs'
    AND (storage.foldername(name))[1] = public.current_user_org()::text
    AND (
      public.current_user_role() = 'admin'
      OR (public.current_user_role() = 'auxiliar' AND (storage.foldername(name))[2] = auth.uid()::text)
    )
  );

-- -----------------------------------------------------------------------------
-- 4. El estado (cbSimulate en SQL)
-- -----------------------------------------------------------------------------

-- ¿Está pausada esta cuenta de cobro HOY? Igual que cbSimulate: pausada si ya se
-- pausó (y no se ha pagado), o si ya es día de pausa y no hay comprobante en
-- revisión. Se calcula en vivo: no depende de que el reloj haya corrido.
CREATE OR REPLACE FUNCTION public.billing_statement_blocked(p_st public.billing_statements, p_today date)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_st.paid_at IS NULL
     AND (p_st.blocked_at IS NOT NULL
          OR (p_st.proof_state <> 'review' AND p_today >= p_st.block_date));
$$;

CREATE OR REPLACE FUNCTION public.billing_statement_base(p_st public.billing_statements, p_today date)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_st.paid_at IS NOT NULL THEN 'pagado'
    WHEN public.billing_statement_blocked(p_st, p_today) THEN 'bloqueado'
    WHEN p_today > p_st.due_date THEN 'vencido'
    WHEN p_today = p_st.due_date THEN 'venceHoy'
    WHEN p_st.notice_days > 0 AND p_today >= p_st.due_date - p_st.notice_days::int THEN 'porVencer'
    ELSE 'pendiente'
  END;
$$;

-- La cuenta de cobro como la necesita la pantalla: las fechas y además los
-- índices de día relativos al corte (la forma de cbSimulate).
CREATE OR REPLACE FUNCTION public.billing_statement_json(p_st public.billing_statements, p_today date)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_blocked boolean := public.billing_statement_blocked(p_st, p_today);
  v_base    text    := public.billing_statement_base(p_st, p_today);
  v_comp    text;
  v_pay     record;
  v_proof   record;
BEGIN
  v_comp := CASE
    WHEN p_st.paid_at IS NOT NULL THEN 'approved'
    WHEN p_st.proof_state = 'review' THEN 'review'
    WHEN p_st.proof_state = 'rejected' THEN 'rejected'
    ELSE 'none' END;
  SELECT source, via_label, amount_cop INTO v_pay FROM public.billing_payments WHERE statement_id = p_st.id;
  SELECT id, status, via_label, submitted_on, storage_path, content_type INTO v_proof
    FROM public.billing_proofs WHERE statement_id = p_st.id ORDER BY submitted_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'id',            p_st.id,
    'periodStart',   p_st.period_start,
    'periodEnd',     p_st.period_end,
    'nextCut',       p_st.period_end + 1,
    'amountCOP',     p_st.amount_cop,
    'discountCOP',   p_st.discount_cop,
    'discountNote',  p_st.discount_note,
    'amountDueCOP',  p_st.amount_cop - p_st.discount_cop,
    'dueDays',       p_st.due_days,
    'noticeDays',    p_st.notice_days,
    'graceDays',     p_st.grace_days,
    'dueDate',       p_st.due_date,
    'noticeDate',    CASE WHEN p_st.notice_days > 0 THEN p_st.due_date - p_st.notice_days::int END,
    'lastGraceDate', p_st.block_date - 1,
    'blockDate',     p_st.block_date,
    'today',         p_today,
    'base',          v_base,
    'comp',          v_comp,
    'adminStatus',   CASE WHEN v_comp = 'review' THEN 'review' ELSE v_base END,
    'paid',          p_st.paid_at IS NOT NULL,
    'paidOn',        p_st.paid_on,
    'paidVia',       p_st.paid_via,
    'paidViaLabel',  v_pay.via_label,
    'wasBlocked',    coalesce(p_st.was_blocked, false),
    'review',        p_st.proof_state = 'review' AND p_st.paid_at IS NULL,
    'reviewOn',      p_st.review_on,
    'rejected',      CASE WHEN p_st.proof_state = 'rejected' AND p_st.paid_at IS NULL THEN p_st.rejected_reason END,
    'blocked',       v_blocked,
    'blockedOn',     CASE WHEN p_st.blocked_on IS NOT NULL THEN p_st.blocked_on
                          WHEN v_blocked THEN p_st.block_date END,
    'daysToDue',     p_st.due_date - p_today,
    'daysToBlock',   p_st.block_date - p_today,
    'lastProof',     CASE WHEN v_proof.id IS NULL THEN NULL ELSE jsonb_build_object(
                       'id', v_proof.id, 'status', v_proof.status, 'viaLabel', v_proof.via_label,
                       'submittedOn', v_proof.submitted_on, 'path', v_proof.storage_path,
                       'contentType', v_proof.content_type) END,
    -- Índices de día relativos al corte (día 0), como cbSimulate.
    'idx', jsonb_build_object(
      'today',        p_today - p_st.period_start,
      'due',          p_st.due_days,
      'notice',       CASE WHEN p_st.notice_days > 0 THEN p_st.due_days - p_st.notice_days END,
      'blockDay',     p_st.block_date - p_st.period_start,
      'paidDay',      p_st.paid_on - p_st.period_start,
      'reviewDay',    p_st.review_on - p_st.period_start,
      'blockedSince', CASE WHEN p_st.blocked_on IS NOT NULL THEN p_st.blocked_on - p_st.period_start
                           WHEN v_blocked THEN p_st.block_date - p_st.period_start END)
  );
END;
$$;

-- ¿Está pausado el tripulante? (cuenta activa + alguna cuenta de cobro pausada)
CREATE OR REPLACE FUNCTION public.billing_is_paused(p_aux uuid, p_today date DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.auxiliar_billing ab
      JOIN public.billing_statements s ON s.auxiliar_profile_id = ab.auxiliar_profile_id
     WHERE ab.auxiliar_profile_id = p_aux
       AND ab.active
       AND public.billing_statement_blocked(s, coalesce(p_today, public.billing_today()))
  );
$$;

-- Deja paused_at de la cuenta en línea con billing_is_paused.
CREATE OR REPLACE FUNCTION public.billing_refresh_pause(p_aux uuid, p_today date)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v boolean := public.billing_is_paused(p_aux, p_today);
BEGIN
  UPDATE public.auxiliar_billing
     SET paused_at = CASE WHEN v THEN coalesce(paused_at, now()) ELSE NULL END
   WHERE auxiliar_profile_id = p_aux
     AND (paused_at IS NULL) = v;
  RETURN v;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Los avisos (CB_ALERTS, con los datos reales de la cuenta)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_alert_text(p_key text, p_st public.billing_statements, p_payload jsonb,
                                                     OUT title text, OUT body text, OUT tone text)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  m      text := public.billing_money(p_st.amount_cop - p_st.discount_cop);
  mes    text := public.billing_month_name(p_st.period_start);
  mesCap text := initcap(public.billing_month_name(p_st.period_start));
  nom    text;
BEGIN
  SELECT pr.full_name INTO nom
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_st.auxiliar_profile_id;
  nom := coalesce(nom, 'Tripulante');
  CASE p_key
    WHEN 'generado' THEN
      title := 'Tu cuenta de cobro de ' || mes || ' está lista';
      body  := m || ' · págala antes del ' || public.billing_fmt(p_st.due_date) || '.';
      tone  := 'neutral';
    WHEN 'recordatorio' THEN
      title := 'Tu cobro vence en ' || public.billing_pl(p_st.notice_days, 'día', 'días');
      body  := m || ' · sube el comprobante antes del ' || public.billing_fmt(p_st.due_date) || '.';
      tone  := 'warn';
    WHEN 'venceHoy' THEN
      title := 'Hoy vence tu cobro';
      body  := m || '. Si ya pagaste, sube el comprobante.';
      tone  := 'warn';
    WHEN 'vencido' THEN
      title := 'Tu cobro está vencido';
      body  := CASE WHEN p_st.grace_days > 0
                 THEN 'Tienes hasta el ' || public.billing_fmt(p_st.due_date + p_st.grace_days::int) || ' para pagar. Después se pausan tus reservas.'
                 ELSE 'Tus reservas quedan pausadas hasta que pagues.' END;
      tone  := 'error';
    WHEN 'ultimoDia' THEN
      title := 'Mañana se pausan tus reservas';
      body  := 'Paga hoy ' || m || ' y sube el comprobante para evitarlo.';
      tone  := 'error';
    WHEN 'bloqueado' THEN
      title := 'Tus reservas están pausadas';
      body  := 'Tu cobro de ' || mes || ' sigue pendiente. Tus viajes ya confirmados siguen en pie.';
      tone  := 'error';
    WHEN 'recibido' THEN
      title := 'Recibimos tu comprobante';
      body  := 'Lo estamos revisando. Te avisamos apenas quede aprobado.';
      tone  := 'info';
    WHEN 'aprobado' THEN
      title := 'Pago confirmado';
      body  := CASE WHEN coalesce((p_payload->>'wasBlocked')::boolean, false)
                 THEN mesCap || ' quedó al día. Ya puedes volver a reservar.'
                 ELSE mesCap || ' quedó al día. Próximo cobro: ' || public.billing_fmt(p_st.period_end + 1) || '.' END;
      tone  := 'ok';
    WHEN 'rechazado' THEN
      title := 'Tu comprobante fue rechazado';
      body  := 'Motivo: ' || lower(coalesce(p_payload->>'reason', 'sin motivo')) || '. Sube uno nuevo.';
      tone  := 'error';
    WHEN 'admRevisar' THEN
      title := 'Comprobante por revisar';
      body  := nom || ' · ' || mes || ' · ' || m;
      tone  := 'info';
    WHEN 'admMora' THEN
      title := 'Auxiliar en mora';
      body  := nom || ' no pagó ' || mes || '. Se bloquea el ' || public.billing_fmt(p_st.block_date) || '.';
      tone  := 'error';
    WHEN 'admBloqueado' THEN
      title := 'Auxiliar bloqueado';
      body  := nom || ' ya no puede reservar viajes nuevos.';
      tone  := 'error';
    ELSE
      RAISE EXCEPTION 'Aviso de cobro desconocido: %', p_key;
  END CASE;
END;
$$;

-- Registra el aviso UNA vez y, si corresponde, encola la push.
--   Canales (CB_ALERTS.ch): recibido y admMora no llevan push.
--   Preferencias del tripulante (Cb2Me): «Notificaciones push» apaga la push de
--   generado/recordatorio/venceHoy/aprobado/rechazado; «Recordatorio antes de
--   vencer» apaga la de recordatorio. «Los avisos de mora y de pausa siempre
--   llegan»: vencido, ultimoDia y bloqueado no se pueden apagar.
--   p_push = false: queda en el Centro pero sin push (días que el reloj se saltó).
CREATE OR REPLACE FUNCTION public.billing_emit(p_st public.billing_statements, p_key text, p_day date,
                                               p_payload jsonb DEFAULT '{}'::jsonb, p_proof_id uuid DEFAULT NULL,
                                               p_push boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aud   text := CASE WHEN p_key IN ('admRevisar', 'admMora', 'admBloqueado') THEN 'admin' ELSE 'aux' END;
  v_key   text;
  v_txt   record;
  v_id    uuid;
  v_ab    public.auxiliar_billing;
  v_push  boolean := p_push;
  v_send  timestamptz := now();
  v_prof  uuid;
BEGIN
  v_key := CASE WHEN p_key IN ('recibido', 'rechazado', 'admRevisar')
                THEN 'proof:' || p_proof_id::text || ':' || p_key
                ELSE 'stmt:' || p_st.id::text || ':' || p_key END;
  SELECT * INTO v_txt FROM public.billing_alert_text(p_key, p_st, coalesce(p_payload, '{}'::jsonb));
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_st.auxiliar_profile_id;

  IF p_key IN ('recibido', 'admMora') THEN v_push := false; END IF;
  IF v_aud = 'aux' AND p_key IN ('generado', 'recordatorio', 'venceHoy', 'aprobado', 'rechazado')
     AND v_ab.push_enabled IS FALSE THEN v_push := false; END IF;
  IF p_key = 'recordatorio' AND v_ab.reminder_enabled IS FALSE THEN v_push := false; END IF;

  INSERT INTO public.billing_alerts (organization_id, auxiliar_profile_id, statement_id, proof_id, audience, key,
                                     day, day_index, title, body, tone, pushed, payload, dedupe_key)
  VALUES (p_st.organization_id, p_st.auxiliar_profile_id, p_st.id, p_proof_id, v_aud, p_key,
          p_day, p_day - p_st.period_start, v_txt.title, v_txt.body, v_txt.tone, v_push,
          coalesce(p_payload, '{}'::jsonb), v_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;
  IF NOT v_push THEN RETURN true; END IF;

  -- «Día del vencimiento, 8:00 a. m.»
  IF p_key = 'venceHoy' THEN
    v_send := greatest(now(), ((p_day + time '08:00') AT TIME ZONE 'America/Bogota'));
  END IF;

  IF v_aud = 'aux' THEN
    SELECT ap.profile_id INTO v_prof FROM public.auxiliar_profiles ap WHERE ap.id = p_st.auxiliar_profile_id;
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    VALUES (v_prof, v_txt.title, v_txt.body, '/#/pagos', 'bill:' || v_id::text || ':' || v_prof::text, v_send)
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    SELECT r.profile_id, v_txt.title, v_txt.body, '/#/cobro?aux=' || p_st.auxiliar_profile_id::text,
           'bill:' || v_id::text || ':' || r.profile_id::text, v_send
      FROM public.ops_alert_recipients() r
      JOIN public.profiles p ON p.id = r.profile_id
     WHERE p.organization_id = p_st.organization_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN true;
END;
$$;

-- Pausa la cuenta de cobro (y avisa) si ya toca. Devuelve true si la pausó ahora.
CREATE OR REPLACE FUNCTION public.billing_block_if_due(p_st_id uuid, p_today date, p_push boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  IF s.id IS NULL OR s.paid_at IS NOT NULL OR s.proof_state = 'review'
     OR s.blocked_at IS NOT NULL OR p_today < s.block_date THEN
    RETURN false;
  END IF;
  UPDATE public.billing_statements
     SET blocked_at = now(), blocked_on = p_today, status = 'bloqueado'
   WHERE id = s.id
  RETURNING * INTO s;
  PERFORM public.billing_emit(s, 'bloqueado', p_today, '{}'::jsonb, NULL, p_push);
  PERFORM public.billing_emit(s, 'admBloqueado', p_today, '{}'::jsonb, NULL, p_push);
  PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, p_today);
  RETURN true;
END;
$$;

-- Abre la cuenta de cobro de un corte (si no existe). Devuelve su id.
CREATE OR REPLACE FUNCTION public.billing_open_statement(p_aux uuid, p_period_start date, p_today date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ab  public.auxiliar_billing;
  cfg public.billing_settings;
  s   public.billing_statements;
  v_amount integer;
BEGIN
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux FOR UPDATE;
  IF ab.auxiliar_profile_id IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO s.id FROM public.billing_statements WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start;
  IF s.id IS NOT NULL THEN RETURN s.id; END IF;

  SELECT * INTO cfg FROM public.billing_settings WHERE organization_id = ab.organization_id;
  -- «Desde noviembre tu mensualidad será…»: el monto nuevo entra al abrir el período.
  IF ab.amount_next_cop IS NOT NULL THEN
    UPDATE public.auxiliar_billing SET amount_cop = amount_next_cop, amount_next_cop = NULL
     WHERE auxiliar_profile_id = p_aux RETURNING * INTO ab;
  END IF;
  v_amount := coalesce(ab.amount_cop, cfg.default_amount_cop);
  IF v_amount IS NULL THEN RETURN NULL; END IF;   -- sin monto no hay cobro (nunca uno inventado)

  INSERT INTO public.billing_statements (organization_id, auxiliar_profile_id, period_start, period_end, amount_cop,
                                         due_days, notice_days, grace_days)
  VALUES (ab.organization_id, p_aux, p_period_start,
          public.billing_next_cut(p_period_start, ab.cut_day) - 1, v_amount,
          coalesce(ab.due_days, cfg.due_days, 5),
          coalesce(ab.notice_days, cfg.notice_days, 2),
          coalesce(ab.grace_days, cfg.grace_days, 3))
  RETURNING * INTO s;
  UPDATE public.billing_statements SET status = public.billing_statement_base(s, p_today) WHERE id = s.id;
  -- El aviso del corte sale al abrir la cuenta; la push, solo si se abre el día del corte.
  PERFORM public.billing_emit(s, 'generado', p_period_start, '{}'::jsonb, NULL, p_period_start = p_today);
  RETURN s.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. El reloj diario (7:00 Bogotá)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_run_daily(p_today date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today  date := coalesce(p_today, public.billing_today());
  ab       public.auxiliar_billing;
  s        public.billing_statements;
  v_cut    date;
  v_opened integer := 0;
  v_alerts integer := 0;
  v_paused integer := 0;
BEGIN
  -- 1. Abrir el período del corte vigente (una vez; nunca antes de starts_on).
  FOR ab IN
    SELECT b.* FROM public.auxiliar_billing b
      JOIN public.auxiliar_profiles ap ON ap.id = b.auxiliar_profile_id
      JOIN public.profiles p ON p.id = ap.profile_id
     WHERE b.active AND p.deleted_at IS NULL
  LOOP
    v_cut := public.billing_last_cut(v_today, ab.cut_day);
    IF v_cut >= ab.starts_on
       AND NOT EXISTS (SELECT 1 FROM public.billing_statements x
                        WHERE x.auxiliar_profile_id = ab.auxiliar_profile_id AND x.period_start = v_cut) THEN
      IF public.billing_open_statement(ab.auxiliar_profile_id, v_cut, v_today) IS NOT NULL THEN
        v_opened := v_opened + 1;
        v_alerts := v_alerts + 1;
      END IF;
    END IF;
  END LOOP;

  -- 2. Avisos de fecha y pausa de cada cuenta de cobro sin pagar (cbSimulate).
  FOR s IN
    SELECT st.* FROM public.billing_statements st
      JOIN public.auxiliar_billing b ON b.auxiliar_profile_id = st.auxiliar_profile_id
     WHERE st.paid_at IS NULL AND b.active AND st.period_start <= v_today
     ORDER BY st.period_start
  LOOP
    IF s.proof_state <> 'review' THEN
      IF s.notice_days > 0 AND v_today = s.due_date - s.notice_days::int AND s.due_date - s.notice_days::int > s.period_start THEN
        IF public.billing_emit(s, 'recordatorio', v_today) THEN v_alerts := v_alerts + 1; END IF;
      END IF;
      IF v_today = s.due_date THEN
        IF public.billing_emit(s, 'venceHoy', v_today) THEN v_alerts := v_alerts + 1; END IF;
      END IF;
      IF v_today = s.due_date + 1 AND s.blocked_at IS NULL THEN
        IF public.billing_emit(s, 'vencido', v_today) THEN v_alerts := v_alerts + 1; END IF;
        IF public.billing_emit(s, 'admMora', v_today) THEN v_alerts := v_alerts + 1; END IF;
      END IF;
      IF s.grace_days > 1 AND v_today = s.block_date - 1 THEN
        IF public.billing_emit(s, 'ultimoDia', v_today) THEN v_alerts := v_alerts + 1; END IF;
      END IF;
    END IF;
    IF public.billing_block_if_due(s.id, v_today) THEN
      v_paused := v_paused + 1;
      v_alerts := v_alerts + 2;
    END IF;
  END LOOP;

  -- 3. Estados guardados (para listar) y bandera de pausa de cada cuenta.
  UPDATE public.billing_statements st
     SET status = public.billing_statement_base(st, v_today)
   WHERE st.status IS DISTINCT FROM public.billing_statement_base(st, v_today);
  PERFORM public.billing_refresh_pause(b.auxiliar_profile_id, v_today) FROM public.auxiliar_billing b;

  INSERT INTO public.billing_job_runs (run_on, ran_at, opened, alerts, paused)
  VALUES (v_today, now(), v_opened, v_alerts, v_paused)
  ON CONFLICT (run_on) DO UPDATE
    SET ran_at = EXCLUDED.ran_at,
        opened = billing_job_runs.opened + EXCLUDED.opened,
        alerts = billing_job_runs.alerts + EXCLUDED.alerts,
        paused = billing_job_runs.paused + EXCLUDED.paused;

  RETURN jsonb_build_object('today', v_today, 'opened', v_opened, 'alerts', v_alerts, 'paused', v_paused);
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. La pausa frena SOLO reservas nuevas del propio tripulante (texto fijo)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_billing_pause()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.auxiliar_profiles ap
                  WHERE ap.id = NEW.auxiliar_profile_id AND ap.profile_id = auth.uid())
     AND public.billing_is_paused(NEW.auxiliar_profile_id, public.billing_today()) THEN
    RAISE EXCEPTION 'Tus reservas están pausadas por un cobro pendiente. Tus viajes ya confirmados siguen en pie.'
      USING ERRCODE = 'RB402', HINT = 'billing_paused';
  END IF;
  RETURN NEW;
END;
$$;

-- El nombre ordena después de tr_reservations_guard_suspended (0081): si alguien
-- está suspendido Y pausado, ve el mensaje de la suspensión.
DROP TRIGGER IF EXISTS tr_reservations_pause_by_billing ON public.reservations;
CREATE TRIGGER tr_reservations_pause_by_billing
  BEFORE INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_billing_pause();

-- -----------------------------------------------------------------------------
-- 8. RPC del tripulante
-- -----------------------------------------------------------------------------

-- Mi cuenta. NULL si no tengo mensualidad registrada (sin monto ni cuenta de
-- cobro): la pantalla dice «Todavía no tienes mensualidad registrada».
CREATE OR REPLACE FUNCTION public.aux_billing_my_account()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux   uuid := public.current_auxiliar_id();
  v_today date := public.billing_today();
  ab      public.auxiliar_billing;
  cfg     public.billing_settings;
  cur     public.billing_statements;
  v_open  integer;
  v_org   text;
  v_unread integer;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = v_aux;
  IF ab.auxiliar_profile_id IS NULL OR NOT ab.active THEN RETURN NULL; END IF;
  SELECT * INTO cfg FROM public.billing_settings WHERE organization_id = ab.organization_id;
  -- La que manda: la más vieja sin pagar (es la que pausa); si no hay, la última.
  SELECT * INTO cur FROM public.billing_statements
   WHERE auxiliar_profile_id = v_aux AND paid_at IS NULL AND period_start <= v_today
   ORDER BY period_start LIMIT 1;
  IF cur.id IS NULL THEN
    SELECT * INTO cur FROM public.billing_statements
     WHERE auxiliar_profile_id = v_aux AND period_start <= v_today
     ORDER BY period_start DESC LIMIT 1;
  END IF;
  IF cur.id IS NULL AND coalesce(ab.amount_cop, cfg.default_amount_cop) IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_open FROM public.billing_statements
   WHERE auxiliar_profile_id = v_aux AND paid_at IS NULL AND period_start <= v_today;
  SELECT name INTO v_org FROM public.organizations WHERE id = ab.organization_id;
  SELECT count(*) INTO v_unread FROM public.billing_alerts
   WHERE auxiliar_profile_id = v_aux AND audience = 'aux'
     AND (ab.alerts_seen_at IS NULL OR created_at > ab.alerts_seen_at);

  RETURN jsonb_build_object(
    'auxiliarProfileId', v_aux,
    'organizationId',    ab.organization_id,
    'organizationName',  v_org,
    'reference',         ab.reference,
    'amountCOP',         coalesce(ab.amount_cop, cfg.default_amount_cop),
    'amountNextCOP',     ab.amount_next_cop,
    'cutDay',            ab.cut_day,
    'dueDays',           coalesce(ab.due_days, cfg.due_days, 5),
    'noticeDays',        coalesce(ab.notice_days, cfg.notice_days, 2),
    'graceDays',         coalesce(ab.grace_days, cfg.grace_days, 3),
    'holderName',        cfg.holder_name,
    'holderNit',         cfg.holder_nit,
    'nextCut',           public.billing_next_cut(v_today, ab.cut_day),
    'startsOn',          ab.starts_on,
    'paused',            public.billing_is_paused(v_aux, v_today),
    'openCount',         v_open,
    'unread',            v_unread,
    'prefs',             jsonb_build_object('push', ab.push_enabled, 'reminder', ab.reminder_enabled),
    'today',             v_today,
    'current',           CASE WHEN cur.id IS NULL THEN NULL ELSE public.billing_statement_json(cur, v_today) END
  );
END;
$$;

-- Historial: todas mis cuentas de cobro, la más nueva primero, con el pago.
CREATE OR REPLACE FUNCTION public.aux_billing_history()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(
           public.billing_statement_json(s, public.billing_today())
           || jsonb_build_object(
                'daysLate', CASE WHEN s.paid_on IS NOT NULL THEN greatest(0, s.paid_on - s.due_date) END,
                'approverLabel', CASE WHEN s.paid_at IS NOT NULL THEN 'Admin · ' || o.name END)
           ORDER BY s.period_start DESC), '[]'::jsonb)
    FROM public.billing_statements s
    JOIN public.organizations o ON o.id = s.organization_id
   WHERE s.auxiliar_profile_id = public.current_auxiliar_id()
     AND s.period_start <= public.billing_today();
$$;

-- Subir el comprobante (el archivo ya está en payment-proofs/{org}/{yo}/{cuenta}/…).
CREATE OR REPLACE FUNCTION public.aux_billing_submit_proof(
  p_statement_id uuid, p_storage_path text, p_via_label text,
  p_method_id uuid DEFAULT NULL, p_content_type text DEFAULT NULL,
  p_size_bytes integer DEFAULT NULL, p_declared_amount_cop integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux   uuid := public.current_auxiliar_id();
  v_today date := public.billing_today();
  s       public.billing_statements;
  v_proof uuid;
BEGIN
  IF v_aux IS NULL THEN RAISE EXCEPTION 'Solo el tripulante sube su comprobante' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM public.billing_statements WHERE id = p_statement_id FOR UPDATE;
  IF s.id IS NULL OR s.auxiliar_profile_id <> v_aux THEN
    RAISE EXCEPTION 'Esa cuenta de cobro no es tuya' USING ERRCODE = '42501';
  END IF;
  IF s.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Esta cuenta de cobro ya está pagada' USING ERRCODE = 'P0001'; END IF;
  IF s.proof_state = 'review' THEN RAISE EXCEPTION 'Ya tienes un comprobante en revisión' USING ERRCODE = 'P0001'; END IF;
  IF p_via_label IS NULL OR length(btrim(p_via_label)) = 0 THEN
    RAISE EXCEPTION 'Falta desde dónde pagaste' USING ERRCODE = '22023';
  END IF;
  IF split_part(p_storage_path, '/', 1) <> s.organization_id::text
     OR split_part(p_storage_path, '/', 2) <> auth.uid()::text
     OR split_part(p_storage_path, '/', 3) <> s.id::text
     OR split_part(p_storage_path, '/', 4) = '' THEN
    RAISE EXCEPTION 'La ruta del comprobante no corresponde' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payment-proofs' AND o.name = p_storage_path) THEN
    RAISE EXCEPTION 'No encontramos el archivo del comprobante: vuelve a subirlo' USING ERRCODE = 'P0002';
  END IF;
  IF p_method_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.billing_payment_methods m
                                              WHERE m.id = p_method_id AND m.organization_id = s.organization_id) THEN
    p_method_id := NULL;
  END IF;

  INSERT INTO public.billing_proofs (statement_id, organization_id, auxiliar_profile_id, storage_path, content_type,
                                     size_bytes, method_id, via_label, declared_amount_cop, submitted_on)
  VALUES (s.id, s.organization_id, v_aux, p_storage_path, p_content_type, p_size_bytes, p_method_id,
          btrim(p_via_label), p_declared_amount_cop, v_today)
  RETURNING id INTO v_proof;

  -- Con comprobante en revisión no corre la gracia. Si la pausa se puso HOY, gana
  -- el comprobante (cbSimulate procesa los eventos del día antes de pausar).
  UPDATE public.billing_statements
     SET proof_state = 'review', review_on = v_today, rejected_reason = NULL,
         blocked_at = CASE WHEN blocked_on = v_today THEN NULL ELSE blocked_at END,
         blocked_on = CASE WHEN blocked_on = v_today THEN NULL ELSE blocked_on END
   WHERE id = s.id
  RETURNING * INTO s;
  UPDATE public.billing_statements SET status = public.billing_statement_base(s, v_today) WHERE id = s.id;

  PERFORM public.billing_emit(s, 'recibido', v_today, '{}'::jsonb, v_proof);
  PERFORM public.billing_emit(s, 'admRevisar', v_today, '{}'::jsonb, v_proof);
  PERFORM public.billing_refresh_pause(v_aux, v_today);

  SELECT * INTO s FROM public.billing_statements WHERE id = s.id;
  RETURN jsonb_build_object('proofId', v_proof, 'statement', public.billing_statement_json(s, v_today));
END;
$$;

CREATE OR REPLACE FUNCTION public.aux_billing_set_prefs(p_push boolean, p_reminder boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_aux uuid := public.current_auxiliar_id(); ab public.auxiliar_billing;
BEGIN
  UPDATE public.auxiliar_billing
     SET push_enabled = coalesce(p_push, push_enabled), reminder_enabled = coalesce(p_reminder, reminder_enabled)
   WHERE auxiliar_profile_id = v_aux
  RETURNING * INTO ab;
  IF ab.auxiliar_profile_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('push', ab.push_enabled, 'reminder', ab.reminder_enabled);
END;
$$;

CREATE OR REPLACE FUNCTION public.aux_billing_mark_seen()
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.auxiliar_billing SET alerts_seen_at = now()
   WHERE auxiliar_profile_id = public.current_auxiliar_id();
$$;

-- -----------------------------------------------------------------------------
-- 9. RPC del jefe
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_assert_admin_of(p_org uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR p_org IS DISTINCT FROM public.current_user_org() THEN
    RAISE EXCEPTION 'Solo el jefe de esta organización puede hacer esto' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Lista para el panel «Cuentas de cobro»: TODOS los tripulantes de la org, con
-- o sin cuenta, con el estado de la cuenta de cobro que manda y el comprobante
-- por revisar.
CREATE OR REPLACE FUNCTION public.admin_billing_list()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_today date := public.billing_today(); v_org uuid := public.current_user_org();
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  RETURN (
    SELECT coalesce(jsonb_agg(row_j ORDER BY sort_key, name), '[]'::jsonb) FROM (
      SELECT pr.full_name AS name,
             CASE WHEN (cur.st).id IS NULL THEN 9
                  WHEN rv.id IS NOT NULL THEN 0
                  WHEN public.billing_statement_blocked(cur.st, v_today) THEN 1
                  WHEN (cur.st).paid_at IS NULL AND v_today > (cur.st).due_date THEN 2
                  WHEN (cur.st).paid_at IS NULL THEN 3 ELSE 5 END AS sort_key,
             jsonb_build_object(
               'auxiliarProfileId', ap.id,
               'profileId',         pr.id,
               'name',              pr.full_name,
               'email',             pr.email,
               'phone',             pr.phone,
               'isActive',          pr.is_active,
               'joinedAt',          ap.joined_at,
               'account', CASE WHEN ab.auxiliar_profile_id IS NULL THEN NULL ELSE jsonb_build_object(
                  'reference', ab.reference, 'active', ab.active,
                  'amountCOP', ab.amount_cop, 'amountNextCOP', ab.amount_next_cop,
                  'effectiveAmountCOP', coalesce(ab.amount_cop, cfg.default_amount_cop),
                  'cutDay', ab.cut_day,
                  'dueDays', ab.due_days, 'noticeDays', ab.notice_days, 'graceDays', ab.grace_days,
                  'effectiveDueDays', coalesce(ab.due_days, cfg.due_days, 5),
                  'effectiveNoticeDays', coalesce(ab.notice_days, cfg.notice_days, 2),
                  'effectiveGraceDays', coalesce(ab.grace_days, cfg.grace_days, 3),
                  'startsOn', ab.starts_on,
                  'paused', public.billing_is_paused(ap.id, v_today),
                  'nextCut', public.billing_next_cut(v_today, ab.cut_day)) END,
               'openCount', (SELECT count(*) FROM public.billing_statements x
                              WHERE x.auxiliar_profile_id = ap.id AND x.paid_at IS NULL AND x.period_start <= v_today),
               'current', CASE WHEN (cur.st).id IS NULL THEN NULL ELSE public.billing_statement_json(cur.st, v_today) END,
               'proofInReview', CASE WHEN rv.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', rv.id, 'statementId', rv.statement_id, 'path', rv.storage_path,
                  'contentType', rv.content_type, 'viaLabel', rv.via_label,
                  'declaredAmountCOP', rv.declared_amount_cop,
                  'submittedAt', rv.submitted_at, 'submittedOn', rv.submitted_on) END
             ) AS row_j
        FROM public.auxiliar_profiles ap
        JOIN public.profiles pr ON pr.id = ap.profile_id
        LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
        LEFT JOIN public.billing_settings cfg ON cfg.organization_id = pr.organization_id
        LEFT JOIN LATERAL (
          SELECT st FROM public.billing_statements st
           WHERE st.auxiliar_profile_id = ap.id AND st.period_start <= v_today
           ORDER BY (st.paid_at IS NULL) DESC,
                    CASE WHEN st.paid_at IS NULL THEN st.period_start END ASC,
                    st.period_start DESC
           LIMIT 1) cur ON true
        LEFT JOIN LATERAL (
          SELECT bp.* FROM public.billing_proofs bp
           WHERE bp.auxiliar_profile_id = ap.id AND bp.status = 'review'
           ORDER BY bp.submitted_at LIMIT 1) rv ON true
       WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar'
    ) t
  );
END;
$$;

-- Detalle de un tripulante: cuenta + todas sus cuentas de cobro + comprobantes + pagos.
CREATE OR REPLACE FUNCTION public.admin_billing_detail(p_aux uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_today date := public.billing_today(); v_org uuid;
BEGIN
  SELECT pr.organization_id INTO v_org FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux;
  PERFORM public.billing_assert_admin_of(v_org);
  RETURN jsonb_build_object(
    'statements', (SELECT coalesce(jsonb_agg(public.billing_statement_json(s, v_today) ORDER BY s.period_start DESC), '[]'::jsonb)
                     FROM public.billing_statements s WHERE s.auxiliar_profile_id = p_aux),
    'proofs', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'id', bp.id, 'statementId', bp.statement_id, 'path', bp.storage_path, 'contentType', bp.content_type,
                  'viaLabel', bp.via_label, 'declaredAmountCOP', bp.declared_amount_cop, 'status', bp.status,
                  'rejectReason', bp.reject_reason, 'submittedAt', bp.submitted_at, 'reviewedAt', bp.reviewed_at)
                  ORDER BY bp.submitted_at DESC), '[]'::jsonb)
                 FROM public.billing_proofs bp WHERE bp.auxiliar_profile_id = p_aux),
    'payments', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'id', py.id, 'statementId', py.statement_id, 'source', py.source, 'amountCOP', py.amount_cop,
                  'viaLabel', py.via_label, 'paidOn', py.paid_on, 'note', py.note, 'createdAt', py.created_at)
                  ORDER BY py.paid_on DESC), '[]'::jsonb)
                 FROM public.billing_payments py WHERE py.auxiliar_profile_id = p_aux)
  );
END;
$$;

-- Crear o editar la cuenta de un tripulante (guardado completo del formulario).
-- Plazos NULL = los de la organización. Cambiar monto o plazos NO toca cuentas de
-- cobro ya abiertas (para eso está admin_billing_adjust_statement).
CREATE OR REPLACE FUNCTION public.admin_billing_save_account(
  p_aux uuid, p_amount_cop integer, p_cut_day smallint DEFAULT NULL,
  p_due_days smallint DEFAULT NULL, p_notice_days smallint DEFAULT NULL, p_grace_days smallint DEFAULT NULL,
  p_active boolean DEFAULT true, p_amount_next_cop integer DEFAULT NULL, p_starts_on date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    uuid;
  v_joined date;
  v_cut    smallint;
  ab       public.auxiliar_billing;
BEGIN
  SELECT pr.organization_id, ap.joined_at INTO v_org, v_joined
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Tripulante no encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(v_org);

  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux;
  -- Día de corte: el que diga el jefe; si no, el de la cuenta; si no, el día en
  -- que ingresó (cobro-engine: «ingresó el 14 mar → corte día 14»); si no, hoy.
  v_cut := coalesce(p_cut_day, ab.cut_day, extract(day FROM v_joined)::smallint,
                    extract(day FROM public.billing_today())::smallint);

  INSERT INTO public.auxiliar_billing (auxiliar_profile_id, organization_id, active, amount_cop, amount_next_cop,
                                       cut_day, due_days, notice_days, grace_days, starts_on, created_by, updated_by)
  VALUES (p_aux, v_org, coalesce(p_active, true), p_amount_cop, p_amount_next_cop, v_cut,
          p_due_days, p_notice_days, p_grace_days, coalesce(p_starts_on, public.billing_today()), auth.uid(), auth.uid())
  ON CONFLICT (auxiliar_profile_id) DO UPDATE
    SET active = EXCLUDED.active, amount_cop = EXCLUDED.amount_cop, amount_next_cop = EXCLUDED.amount_next_cop,
        cut_day = EXCLUDED.cut_day, due_days = EXCLUDED.due_days, notice_days = EXCLUDED.notice_days,
        grace_days = EXCLUDED.grace_days,
        starts_on = coalesce(p_starts_on, auxiliar_billing.starts_on),
        updated_by = auth.uid()
  RETURNING * INTO ab;
  PERFORM public.billing_refresh_pause(p_aux, public.billing_today());
  RETURN to_jsonb(ab);
END;
$$;

-- Abrir a mano la cuenta de cobro de un corte (por defecto el corte vigente),
-- p. ej. al dar de alta a alguien a mitad de mes.
CREATE OR REPLACE FUNCTION public.admin_billing_open_statement(p_aux uuid, p_period_start date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE ab public.auxiliar_billing; v_today date := public.billing_today(); v_id uuid; s public.billing_statements;
BEGIN
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux;
  IF ab.auxiliar_profile_id IS NULL THEN RAISE EXCEPTION 'Primero crea la cuenta de cobro del tripulante' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(ab.organization_id);
  IF p_period_start IS NOT NULL AND p_period_start > v_today THEN
    RAISE EXCEPTION 'No se abre una cuenta de cobro con fecha futura' USING ERRCODE = '22023';
  END IF;
  v_id := public.billing_open_statement(p_aux, coalesce(p_period_start, public.billing_last_cut(v_today, ab.cut_day)), v_today);
  IF v_id IS NULL THEN RAISE EXCEPTION 'Falta el monto de la mensualidad' USING ERRCODE = '22023'; END IF;
  -- Si se abrió con fecha vieja, que quede al día (y pausada si ya toca).
  PERFORM public.billing_block_if_due(v_id, v_today);
  SELECT * INTO s FROM public.billing_statements WHERE id = v_id;
  RETURN public.billing_statement_json(s, v_today);
END;
$$;

-- Corregir monto o aplicar un descuento (p. ej. el canje de Rendio Points) a una
-- cuenta de cobro sin pagar.
CREATE OR REPLACE FUNCTION public.admin_billing_adjust_statement(
  p_statement_id uuid, p_amount_cop integer DEFAULT NULL, p_discount_cop integer DEFAULT NULL,
  p_discount_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_statement_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Cuenta de cobro no encontrada' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(s.organization_id);
  IF s.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Esta cuenta de cobro ya está pagada' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.billing_statements
     SET amount_cop = coalesce(p_amount_cop, amount_cop),
         discount_cop = coalesce(p_discount_cop, discount_cop),
         discount_note = CASE WHEN p_discount_cop IS NOT NULL OR p_discount_note IS NOT NULL THEN p_discount_note ELSE discount_note END
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN public.billing_statement_json(s, public.billing_today());
END;
$$;

-- Deja una cuenta de cobro pagada (común a aprobar y a «marcar pagado»).
CREATE OR REPLACE FUNCTION public.billing_settle(p_st_id uuid, p_source text, p_proof_id uuid, p_amount integer,
                                                 p_via_label text, p_paid_on date, p_note text)
RETURNS public.billing_statements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements; v_today date := public.billing_today(); v_was boolean;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  v_was := public.billing_statement_blocked(s, v_today);
  UPDATE public.billing_statements
     SET paid_at = now(), paid_on = coalesce(p_paid_on, v_today), paid_via = p_source, paid_by = auth.uid(),
         was_blocked = v_was, proof_state = 'approved', rejected_reason = NULL, status = 'pagado'
   WHERE id = s.id
  RETURNING * INTO s;
  INSERT INTO public.billing_payments (statement_id, organization_id, auxiliar_profile_id, source, proof_id,
                                       amount_cop, via_label, paid_on, recorded_by, note)
  VALUES (s.id, s.organization_id, s.auxiliar_profile_id, p_source, p_proof_id,
          coalesce(p_amount, s.amount_cop - s.discount_cop), p_via_label, s.paid_on, auth.uid(), p_note);
  PERFORM public.billing_emit(s, 'aprobado', v_today,
                              jsonb_build_object('wasBlocked', v_was, 'manual', p_source = 'manual'), p_proof_id);
  PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, v_today);
  RETURN s;
END;
$$;

-- Revisar un comprobante: aprobar, o rechazar con un motivo de la lista.
CREATE OR REPLACE FUNCTION public.admin_billing_review_proof(p_proof_id uuid, p_approve boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  bp public.billing_proofs;
  s  public.billing_statements;
  v_today date := public.billing_today();
BEGIN
  SELECT * INTO bp FROM public.billing_proofs WHERE id = p_proof_id FOR UPDATE;
  IF bp.id IS NULL THEN RAISE EXCEPTION 'Comprobante no encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(bp.organization_id);
  IF bp.status <> 'review' THEN RAISE EXCEPTION 'Este comprobante ya fue revisado' USING ERRCODE = 'P0001'; END IF;

  IF p_approve THEN
    UPDATE public.billing_proofs SET status = 'approved', reviewed_at = now(), reviewed_by = auth.uid() WHERE id = bp.id;
    s := public.billing_settle(bp.statement_id, 'proof', bp.id, bp.declared_amount_cop, bp.via_label, v_today, NULL);
  ELSE
    IF p_reason IS NULL OR NOT (p_reason = ANY (public.billing_reject_reasons())) THEN
      RAISE EXCEPTION 'Elige el motivo del rechazo' USING ERRCODE = '22023';
    END IF;
    UPDATE public.billing_proofs
       SET status = 'rejected', reject_reason = p_reason, reviewed_at = now(), reviewed_by = auth.uid()
     WHERE id = bp.id;
    -- La fecha límite NO cambia.
    UPDATE public.billing_statements SET proof_state = 'rejected', rejected_reason = p_reason
     WHERE id = bp.statement_id RETURNING * INTO s;
    PERFORM public.billing_emit(s, 'rechazado', v_today, jsonb_build_object('reason', p_reason), bp.id);
    -- Si ya pasó la fecha de pausa, se pausa ya (cbSimulate: pausa después de los eventos del día).
    PERFORM public.billing_block_if_due(s.id, v_today);
    UPDATE public.billing_statements SET status = public.billing_statement_base(billing_statements, v_today) WHERE id = s.id;
    PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, v_today);
    SELECT * INTO s FROM public.billing_statements WHERE id = s.id;
  END IF;
  RETURN public.billing_statement_json(s, v_today);
END;
$$;

-- «Marcar pagado» (efectivo, transferencia que llegó sin comprobante, etc.).
CREATE OR REPLACE FUNCTION public.admin_billing_mark_paid(
  p_statement_id uuid, p_via_label text DEFAULT NULL, p_amount_cop integer DEFAULT NULL,
  p_paid_on date DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements; v_today date := public.billing_today(); v_proof uuid;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_statement_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Cuenta de cobro no encontrada' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(s.organization_id);
  IF s.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Esta cuenta de cobro ya está pagada' USING ERRCODE = 'P0001'; END IF;
  IF p_paid_on IS NOT NULL AND p_paid_on > v_today THEN
    RAISE EXCEPTION 'La fecha del pago no puede ser futura' USING ERRCODE = '22023';
  END IF;
  -- Un comprobante que estaba en revisión queda aprobado con el pago.
  UPDATE public.billing_proofs SET status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
   WHERE statement_id = s.id AND status = 'review'
  RETURNING id INTO v_proof;
  s := public.billing_settle(s.id, 'manual', v_proof, p_amount_cop, coalesce(nullif(btrim(p_via_label), ''), 'Pago registrado por el admin'),
                             p_paid_on, p_note);
  RETURN public.billing_statement_json(s, v_today);
END;
$$;

-- Comprobantes de la organización (cola «por revisar» por defecto).
CREATE OR REPLACE FUNCTION public.admin_billing_proofs(p_status text DEFAULT 'review')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid := public.current_user_org(); v_today date := public.billing_today();
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', bp.id, 'statementId', bp.statement_id, 'auxiliarProfileId', bp.auxiliar_profile_id,
             'name', pr.full_name, 'reference', ab.reference,
             'path', bp.storage_path, 'contentType', bp.content_type, 'sizeBytes', bp.size_bytes,
             'viaLabel', bp.via_label, 'declaredAmountCOP', bp.declared_amount_cop,
             'status', bp.status, 'rejectReason', bp.reject_reason,
             'submittedAt', bp.submitted_at, 'submittedOn', bp.submitted_on, 'reviewedAt', bp.reviewed_at,
             'statement', public.billing_statement_json(s, v_today))
             ORDER BY bp.submitted_at), '[]'::jsonb)
      FROM public.billing_proofs bp
      JOIN public.billing_statements s ON s.id = bp.statement_id
      JOIN public.auxiliar_profiles ap ON ap.id = bp.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = bp.auxiliar_profile_id
     WHERE bp.organization_id = v_org
       AND (p_status IS NULL OR bp.status = p_status)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. Permisos de las funciones
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  -- Internas: solo triggers, el reloj y las otras funciones.
  FOREACH f IN ARRAY ARRAY[
    'public.billing_emit(public.billing_statements, text, date, jsonb, uuid, boolean)',
    'public.billing_block_if_due(uuid, date, boolean)',
    'public.billing_open_statement(uuid, date, date)',
    'public.billing_run_daily(date)',
    'public.billing_refresh_pause(uuid, date)',
    'public.billing_settle(uuid, text, uuid, integer, text, date, text)',
    'public.billing_is_paused(uuid, date)',
    'public.billing_alert_text(text, public.billing_statements, jsonb)',
    'public.billing_statement_json(public.billing_statements, date)',
    'public.billing_statement_blocked(public.billing_statements, date)',
    'public.billing_statement_base(public.billing_statements, date)',
    'public.billing_assert_admin_of(uuid)',
    'public.guard_billing_pause()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- De la app (cada una valida quién llama).
  FOREACH f IN ARRAY ARRAY[
    'public.aux_billing_my_account()',
    'public.aux_billing_history()',
    'public.aux_billing_submit_proof(uuid, text, text, uuid, text, integer, integer)',
    'public.aux_billing_set_prefs(boolean, boolean)',
    'public.aux_billing_mark_seen()',
    'public.admin_billing_list()',
    'public.admin_billing_detail(uuid)',
    'public.admin_billing_save_account(uuid, integer, smallint, smallint, smallint, smallint, boolean, integer, date)',
    'public.admin_billing_open_statement(uuid, date)',
    'public.admin_billing_adjust_statement(uuid, integer, integer, text)',
    'public.admin_billing_review_proof(uuid, boolean, text)',
    'public.admin_billing_mark_paid(uuid, text, integer, date, text)',
    'public.admin_billing_proofs(text)',
    'public.billing_reject_reasons()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------
-- 11. El reloj: 7:00 a. m. de Bogotá = 12:00 UTC (pg_cron corre en GMT)
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('billing-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.schedule('billing-daily', '0 12 * * *', $job$SELECT public.billing_run_daily();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): el facturario queda creado pero nadie corre el reloj diario.', SQLERRM;
END
$do$;

COMMIT;
