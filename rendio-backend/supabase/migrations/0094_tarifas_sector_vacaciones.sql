-- =============================================================================
-- Migration 0094 — Facturario: tarifa por SECTOR, VACACIONES y el BALANCE del mes
-- Pedido de la dueña (29-sep-2026, T4 y T9) sobre el facturario de 0090.
--
-- QUÉ HACE
--   1. TARIFA POR SECTOR. «Cada persona tiene su valor, eso funciona por
--      sectores»: el jefe carga en «Tarifas por sector» la MENSUALIDAD y el
--      VALOR POR VIAJE (el de vacaciones) de cada sector.
--        · El sector del tripulante = residences.sector de su residencia
--          (auxiliar_profiles.residence_id). Si vive en casa o su conjunto no
--          tiene sector, el jefe se lo asigna a mano en su cuenta
--          (auxiliar_billing.sector, nueva): el puesto a mano GANA.
--        · Mensualidad efectiva de una cuenta, en este orden:
--            valor propio (auxiliar_billing.amount_cop)
--            → mensualidad del sector
--            → ninguna: no se abre cuenta de cobro (nunca un monto inventado).
--          La mensualidad por defecto de la organización (billing_settings.
--          default_amount_cop, de 0090) YA NO se usa: «todos tienen su propio
--          valor» (la dueña, 30-sep). La columna se queda, pero nada la lee.
--          amount_next_cop conserva su semántica (entra al abrir el período):
--          quien solo tiene ese «desde el próximo corte» NO cuenta como sin valor.
--        · TRANSICIÓN (solo la primera vez que se aplica 0094): quien hoy se
--          cobra con la mensualidad por defecto (cuenta sin valor propio en una
--          organización que la tiene cargada) la recibe como SU valor propio.
--          Es el valor que ya tenía en efecto (0090: coalesce(amount_cop,
--          default_amount_cop)), no uno inventado: sigue pagando lo mismo y no
--          se queda sin cuenta de cobro en silencio. El jefe se lo cambia o se lo
--          quita («que paguen la del sector») cuando quiera. OJO: como es valor
--          propio, GANA sobre la mensualidad de sector que se cargue después
--          (sale con el chip «Valor propio»): para que paguen la del sector hay
--          que quitárselo (botón «Que paguen la del sector»). La dueña no lo
--          decidió: pregunta abierta.
--   2. VACACIONES POR PERÍODO DE COBRO. «Según el sector y la cantidad de viajes
--      que vayan a tomar se parametriza el valor»: el tripulante marca (debajo
--      de «Pagar») que se va de vacaciones en ESTE cobro o en el SIGUIENTE, con
--      las fechas (informativas; tienen que caer en ese cobro) y cuántos viajes
--      va a tomar. Ese cobro vale  valor por viaje del sector × viajes  en vez de
--      la mensualidad. Sin mínimo ni máximo de días.
--        · El TRIPULANTE marca o cancela mientras la cuenta de cobro de ese
--          período no esté pagada, ni con un comprobante en revisión, ni VENCIDA
--          (vencida o pausada: primero paga o se lo arregla Coordinación; así
--          nadie se «despausa» con unas vacaciones). Tampoco puede declarar
--          MENOS viajes de los que ya hizo en ese cobro (reservas de días
--          anteriores a hoy).
--        · El JEFE marca también sobre un cobro vencido y cancela siempre. Si la
--          cuenta ya está pagada, no se toca y conserva la FOTO de con qué
--          vacaciones se cobró (billing_statements.vacation_id): sigue diciendo
--          «vacaciones» en el balance aunque después se cancelen.
--        · Si la cuenta de cobro ya está abierta, su monto se recalcula al marcar
--          y al cancelar (vuelve al monto que tenía antes de las vacaciones). Si
--          es del siguiente período, el reloj diario la abre con ese monto.
--        · Nada que pagar (0 viajes, o el descuento lo cubre) = $0: el período
--          queda SALDADO solo con un pago AUTOMÁTICO de $0 (billing_payments.
--          automatic; sin persona que lo registre, sin push de «Pago confirmado»).
--          Por eso billing_statements acepta amount_cop = 0. Ese saldo solo lo
--          puede deshacer el JEFE: al cambiar o cancelar esas vacaciones la cuenta
--          se reabre con el monto nuevo (y se pausa si ya pasó la fecha).
--        · Sin valor por viaje en su sector no se puede marcar: «Tu sector
--          todavía no tiene valor por viaje; escríbele a Coordinación».
--        · Al marcar o cancelar, aviso por el MISMO mecanismo de 0090
--          (billing_alerts + notification_outbox): al jefe si lo hizo el
--          tripulante («X marcó vacaciones: N viajes × $V = $T») y al tripulante
--          si lo hizo el jefe. billing_alerts.statement_id pasa a aceptar NULL
--          (unas vacaciones del siguiente período todavía no tienen cuenta).
--   3. BALANCE DEL MES para «Cuentas de cobro» (admin_billing_balance): las
--      cuentas de cobro que se ABRIERON en ese mes calendario (period_start del
--      mes), con totales, desglose por sector, fila por tripulante (modalidad,
--      viajes declarados · reservados · cobrados, extra cobrado y pendiente, lo
--      que trae de cobros anteriores, monto, descuento, neto, estado, pago,
--      quién aprobó, días de mora), los comprobantes y pagos de esas cuentas,
--      quién no tiene cuenta de cobro ese mes y cuántos no tienen valor. Los
--      ESTADOS los calcula la base (billing_statement_json de 0090): el front no
--      calcula nada.
--   4. VALOR PROPIO vs SECTOR: las cuentas de 0090 casi siempre tienen monto, y
--      ese monto es ahora el «valor propio», que GANA sobre la tarifa del sector.
--      «Tarifas por sector» dice cuántos de cada sector tienen valor propio (no
--      pagan esa tarifa) y admin_billing_use_sector_rate se lo quita a todos los
--      de un sector de una vez (rige desde el próximo corte).
--   5. SE COBRA LA DIFERENCIA (la dueña, 30-sep: «si reserva más viajes de los
--      que declaró, se le cobra la diferencia»). Un cobro de vacaciones vale
--      valor por viaje × max(declarados, reservados): nunca baja de lo declarado.
--        · Mientras la cuenta de cobro de ese período está VIVA (sin pagar o
--          saldada sola en $0, sin comprobante en revisión, sin pasar su fecha
--          límite ni el fin del período) se recalcula sola: trigger en
--          reservations (alta, cambio de required_arrival_at, cancelación y
--          descancelación) y al marcar, cambiar o cancelar vacaciones. Si estaba
--          saldada sola en $0 se reabre con el monto nuevo.
--        · Si ya no está viva (pagada por una persona, en revisión, vencida o el
--          período cerró), la cuenta NO se toca: la diferencia queda como CARGO
--          PENDIENTE (billing_extra_charges) que entra como línea aparte en la
--          cuenta del período SIGUIENTE cuando se abra (reloj o apertura a mano),
--          con el conteo FINAL de su período (si canceló después, baja). Nunca se
--          cobra dos veces un viaje: cobrados = los de su cuenta + los extra ya
--          aplicados. Si la siguiente también es de vacaciones, se suma igual.
--        · Aviso al tripulante (mecanismo de 0090, clave 'vacExtra'): «Se sumó $V
--          a tu cuenta: reservaste N viajes y declaraste M», solo cuando lo que
--          se le cobra SUBE de verdad: la cuenta viva cobra más viajes que los
--          que ya cobraba (marcar o cambiar unas vacaciones con el mismo monto, o
--          uno más bajo, no avisa), o el cargo pendiente crece. Dedupe por
--          tripulante + período + viajes reservados + a dónde va (esa cuenta o
--          el próximo cobro): cambiar las vacaciones no reinicia el dedupe, y un
--          viaje que pasa de la cuenta viva a un cargo pendiente sí avisa.
--        · billing_statements.vacation_trips = los viajes que cobra esa cuenta
--          (la foto); el ajuste a mano del jefe se respeta (el recálculo suma o
--          resta solo la diferencia de viajes).
--        · Si el jefe cancela unas vacaciones con la cuenta ya pagada, la foto
--          manda: los viajes de más sobre lo que esa cuenta cobró se siguen
--          cobrando en la siguiente.
--        · (revisión 1-oct) Al RECHAZAR un comprobante la cuenta vuelve a estar
--          viva y se recalcula en ese momento (trigger sobre
--          billing_statements.proof_state): lo que cambió mientras estuvo en
--          revisión entra (o sale) ya, sin esperar a otra reserva.
--        · (revisión 1-oct) Un viaje que se cancela (o cambia de fecha) DESPUÉS de
--          que su cargo entró en la cuenta siguiente: si esa cuenta sigue viva,
--          la línea baja (o se anula) y la cuenta se recalcula; si ya se pagó,
--          está en revisión o venció, se queda como se cobró (no hay saldo a
--          favor: nunca se devuelve plata sola).
--        · (revisión 1-oct) Una reserva va al período de la cuenta de cobro
--          cuyas fechas la contienen (no al que daría el día de corte de hoy),
--          y el día de corte no se cambia mientras haya vacaciones marcadas en
--          este cobro o en el siguiente (primero se cancelan).
--        · (revisión 1-oct) El descuento que puso el jefe se guarda
--          (billing_statements.discount_requested_cop): si el cobro baja de ese
--          descuento se aplica solo hasta el monto, y si vuelve a subir el
--          descuento vuelve hasta lo que puso (antes se perdía).
--
-- «Viajes reservados» = reservas del tripulante no canceladas (cancelled_at
-- vacío y estado ≠ cancelled; un no_show sí cuenta) con required_arrival_at
-- dentro del período, en hora de Bogotá.
--
-- Redefine (partiendo de su ÚLTIMA definición, la de 0090, sin quitar nada):
--   billing_statement_json · billing_open_statement · aux_billing_my_account ·
--   admin_billing_list · admin_billing_detail · admin_billing_open_statement ·
--   admin_billing_adjust_statement (sigue sin aceptar un monto de $0).
-- billing_run_daily NO cambia: abre los períodos con billing_open_statement
-- (que ahora también aplica los cargos pendientes de viajes extra).
-- billing_settle NO cambia: el saldo automático de $0 va por
-- billing_vacation_settle_zero (sin auth.uid(): nunca queda «aprobado por» el
-- propio tripulante).
-- admin_billing_review_proof y admin_billing_save_account (0090) NO se
-- redefinen: el recálculo al rechazar va por un trigger en billing_statements
-- (tr_billing_statements_vac_resync) y el candado del día de corte por uno en
-- auxiliar_billing (tr_auxiliar_billing_cut_day_vac).
--
-- Privacidad: al tripulante solo le llega SU sector, SU tarifa, SUS viajes y
-- SUS cargos extra (por RPC); las tablas de tarifas y de cargos las lee solo el jefe.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. Sin tocar migraciones
-- anteriores. Down: down_migrations/0094_tarifas_sector_vacaciones.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tablas y columnas
-- -----------------------------------------------------------------------------

-- 1.0 ¿Primera vez que se aplica 0094? (sin la columna sector todavía). La
--     transición de la mensualidad por defecto (3b) corre solo entonces: volver a
--     correr la migración no le devuelve el valor a quien el jefe se lo quitó.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'auxiliar_billing' AND column_name = 'sector') THEN
    CREATE TEMP TABLE _mig0094_primera (x int) ON COMMIT DROP;
  END IF;
END
$do$;

-- 1.1 Sector puesto a mano en la cuenta del tripulante (gana sobre el de la
--     residencia). NULL = el de su residencia.
ALTER TABLE public.auxiliar_billing ADD COLUMN IF NOT EXISTS sector text;
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_sector_ok;
ALTER TABLE public.auxiliar_billing ADD CONSTRAINT auxiliar_billing_sector_ok
  CHECK (sector IS NULL OR (length(btrim(sector)) BETWEEN 1 AND 80));
COMMENT ON COLUMN public.auxiliar_billing.sector IS
  'Tarifas (0094): sector asignado a mano por el jefe (vive en casa o su conjunto no tiene sector). Si está puesto, gana sobre residences.sector.';

-- 1.2 Tarifas por sector (las escribe el jefe; el tripulante NO las lee directo).
CREATE TABLE IF NOT EXISTS public.billing_sector_rates (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sector           text        NOT NULL,
  monthly_cop      integer,
  per_trip_cop     integer,
  updated_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_sector_rates DROP CONSTRAINT IF EXISTS billing_sector_rates_sector_ok;
ALTER TABLE public.billing_sector_rates ADD CONSTRAINT billing_sector_rates_sector_ok
  CHECK (length(btrim(sector)) BETWEEN 1 AND 80);
-- Topes contra un cero de más (no son una regla de negocio).
ALTER TABLE public.billing_sector_rates DROP CONSTRAINT IF EXISTS billing_sector_rates_amounts;
ALTER TABLE public.billing_sector_rates ADD CONSTRAINT billing_sector_rates_amounts
  CHECK ((monthly_cop IS NULL OR monthly_cop BETWEEN 1 AND 10000000)
     AND (per_trip_cop IS NULL OR per_trip_cop BETWEEN 1 AND 10000000));
-- Un sector por organización sin importar mayúsculas ni espacios
-- («Llanogrande» = «llanogrande »). Es índice de expresión: por eso se escribe
-- por RPC (el upsert de PostgREST no infiere índices de expresión).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_sector_rates_org_sector
  ON public.billing_sector_rates(organization_id, lower(btrim(sector)));

COMMENT ON TABLE public.billing_sector_rates IS
  'Tarifas (0094): mensualidad y valor por viaje (vacaciones) de cada sector. NULL = sin valor cargado (nunca uno inventado).';

-- 1.3 Vacaciones: una ACTIVA por tripulante y período de cobro.
CREATE TABLE IF NOT EXISTS public.auxiliar_billing_vacations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id  uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  period_start         date        NOT NULL,
  starts_on            date        NOT NULL,
  ends_on              date        NOT NULL,
  trips                integer     NOT NULL,
  per_trip_cop         integer     NOT NULL,
  sector               text,
  set_by               text        NOT NULL DEFAULT 'aux',
  monthly_before_cop   integer,
  status               text        NOT NULL DEFAULT 'active',
  created_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz
);
ALTER TABLE public.auxiliar_billing_vacations DROP CONSTRAINT IF EXISTS auxiliar_billing_vacations_dates;
ALTER TABLE public.auxiliar_billing_vacations ADD CONSTRAINT auxiliar_billing_vacations_dates CHECK (starts_on <= ends_on);
-- 200 viajes es un tope contra un dedazo (y contra el desborde de per_trip × trips).
ALTER TABLE public.auxiliar_billing_vacations DROP CONSTRAINT IF EXISTS auxiliar_billing_vacations_trips;
ALTER TABLE public.auxiliar_billing_vacations ADD CONSTRAINT auxiliar_billing_vacations_trips CHECK (trips BETWEEN 0 AND 200);
ALTER TABLE public.auxiliar_billing_vacations DROP CONSTRAINT IF EXISTS auxiliar_billing_vacations_rate;
ALTER TABLE public.auxiliar_billing_vacations ADD CONSTRAINT auxiliar_billing_vacations_rate
  CHECK (per_trip_cop BETWEEN 1 AND 10000000 AND (monthly_before_cop IS NULL OR monthly_before_cop >= 0));
ALTER TABLE public.auxiliar_billing_vacations DROP CONSTRAINT IF EXISTS auxiliar_billing_vacations_status;
ALTER TABLE public.auxiliar_billing_vacations ADD CONSTRAINT auxiliar_billing_vacations_status
  CHECK ((status = 'active' AND cancelled_at IS NULL) OR (status = 'cancelled' AND cancelled_at IS NOT NULL));
ALTER TABLE public.auxiliar_billing_vacations DROP CONSTRAINT IF EXISTS auxiliar_billing_vacations_set_by;
ALTER TABLE public.auxiliar_billing_vacations ADD CONSTRAINT auxiliar_billing_vacations_set_by CHECK (set_by IN ('aux', 'admin'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_auxiliar_billing_vacations_active
  ON public.auxiliar_billing_vacations(auxiliar_profile_id, period_start) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_auxiliar_billing_vacations_org
  ON public.auxiliar_billing_vacations(organization_id, period_start DESC);

COMMENT ON TABLE public.auxiliar_billing_vacations IS
  'Tarifas (0094): vacaciones del tripulante por período de cobro. per_trip_cop y sector son la FOTO de la tarifa al marcar; monthly_before_cop es el monto que tenía la cuenta de cobro antes (para devolverlo al cancelar).';

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_sector_rates','auxiliar_billing_vacations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tr_%1$s_set_updated_at ON public.%1$s', t);
    EXECUTE format('CREATE TRIGGER tr_%1$s_set_updated_at BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END
$do$;

-- 1.4 Una cuenta de cobro de vacaciones con 0 viajes vale $0 (y queda saldada).
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_amounts;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_amounts
  CHECK (amount_cop >= 0 AND discount_cop >= 0 AND discount_cop <= amount_cop);

-- 1.4b La FOTO: con qué vacaciones se cobró esta cuenta (NULL = mensualidad).
--      Se pone al abrir o recalcular por vacaciones y se quita al volver a la
--      mensualidad. Si el jefe cancela las vacaciones de una cuenta YA PAGADA,
--      la cuenta no se toca y la foto se queda: sigue siendo «vacaciones».
ALTER TABLE public.billing_statements ADD COLUMN IF NOT EXISTS vacation_id uuid
  REFERENCES public.auxiliar_billing_vacations(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.billing_statements.vacation_id IS
  'Tarifas (0094): vacaciones con las que se cobró esta cuenta (viajes × valor por viaje). NULL = mensualidad. Es la foto: no cambia si se cancelan con la cuenta ya pagada.';

-- 1.4c Pago AUTOMÁTICO: el de $0 cuando unas vacaciones dejan la cuenta sin
--      nada que pagar. Lo registra la base (sin persona) y solo el jefe lo
--      deshace (billing_vacation_unsettle).
ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS automatic boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.billing_payments.automatic IS
  'Tarifas (0094): true = saldo automático de $0 por vacaciones (nadie lo aprobó). El jefe lo deshace al cambiar o cancelar esas vacaciones.';

-- 1.4d Los viajes que COBRA una cuenta de vacaciones: max(declarados,
--      reservados) mientras está viva; después se queda (la foto). NULL =
--      mensualidad. El recálculo por reservas suma o resta SOLO la diferencia de
--      viajes × valor por viaje, así un ajuste a mano del jefe no se pierde.
ALTER TABLE public.billing_statements ADD COLUMN IF NOT EXISTS vacation_trips integer;
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_vacation_trips;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_vacation_trips
  CHECK (vacation_trips IS NULL OR vacation_trips BETWEEN 0 AND 1000);
COMMENT ON COLUMN public.billing_statements.vacation_trips IS
  'Tarifas (0094): viajes que cobra esta cuenta de vacaciones (max(declarados, reservados) mientras está viva). NULL = mensualidad.';

-- 1.4d2 El descuento que PUSO el jefe (p. ej. un canje de Rendio Points). Con
--      vacaciones el monto sube y baja solo; el descuento aplicado (discount_cop)
--      nunca pasa del monto, pero lo que el jefe puso se guarda aquí para que, si
--      el monto vuelve a subir, el descuento vuelva hasta ese valor (antes el
--      recorte se quedaba para siempre). NULL = el mismo discount_cop.
ALTER TABLE public.billing_statements ADD COLUMN IF NOT EXISTS discount_requested_cop integer;
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_discount_requested;
ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_discount_requested
  CHECK (discount_requested_cop IS NULL OR discount_requested_cop >= 0);
COMMENT ON COLUMN public.billing_statements.discount_requested_cop IS
  'Tarifas (0094): descuento que puso el jefe. discount_cop = least(este, monto) al recalcular por vacaciones. NULL = discount_cop.';

-- 1.4e Cargos pendientes: los viajes de más de un período cuya cuenta ya no
--      está viva (pagada, en revisión, vencida o cerrada). Entran como línea
--      aparte en la cuenta del período SIGUIENTE cuando se abre
--      (applied_statement_id). Mientras no se aplica, los viajes se recalculan
--      con cada reserva (si canceló, baja; a 0 se cancela). Ya aplicado, baja
--      solo mientras la cuenta que lo trae siga viva. Uno pendiente por
--      tripulante y período de origen.
CREATE TABLE IF NOT EXISTS public.billing_extra_charges (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id  uuid        NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  vacation_id          uuid        REFERENCES public.auxiliar_billing_vacations(id) ON DELETE SET NULL,
  source_period_start  date        NOT NULL,
  source_statement_id  uuid        REFERENCES public.billing_statements(id) ON DELETE SET NULL,
  trips                integer     NOT NULL,
  per_trip_cop         integer     NOT NULL,
  amount_cop           integer     GENERATED ALWAYS AS (trips * per_trip_cop) STORED,
  applied_statement_id uuid        REFERENCES public.billing_statements(id) ON DELETE SET NULL,
  applied_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz
);
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_trips;
ALTER TABLE public.billing_extra_charges ADD CONSTRAINT billing_extra_charges_trips CHECK (trips BETWEEN 1 AND 1000);
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_rate;
ALTER TABLE public.billing_extra_charges ADD CONSTRAINT billing_extra_charges_rate CHECK (per_trip_cop BETWEEN 1 AND 10000000);
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_applied;
-- Con cuenta = aplicado (applied_at); aplicado sin cuenta solo si la cuenta se
-- borró (ON DELETE SET NULL). Aplicado Y cancelado = se anuló después de entrar
-- en la cuenta siguiente (canceló el viaje con esa cuenta todavía viva: la
-- línea salió de la cuenta); queda la huella de a cuál había entrado.
ALTER TABLE public.billing_extra_charges ADD CONSTRAINT billing_extra_charges_applied
  CHECK (applied_statement_id IS NULL OR applied_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_extra_charges_pending
  ON public.billing_extra_charges(auxiliar_profile_id, source_period_start)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_extra_charges_applied
  ON public.billing_extra_charges(applied_statement_id) WHERE applied_statement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_extra_charges_org
  ON public.billing_extra_charges(organization_id, source_period_start DESC);

DROP TRIGGER IF EXISTS tr_billing_extra_charges_set_updated_at ON public.billing_extra_charges;
CREATE TRIGGER tr_billing_extra_charges_set_updated_at BEFORE UPDATE ON public.billing_extra_charges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.billing_extra_charges IS
  'Tarifas (0094): viajes de vacaciones de más (reservados sobre lo declarado y lo ya cobrado) de un período cuya cuenta ya no se podía tocar. Entran en la cuenta del período siguiente (applied_statement_id). Pendiente = applied_at y cancelled_at vacíos.';

-- 1.5 Avisos de vacaciones: pueden no tener cuenta de cobro todavía.
ALTER TABLE public.billing_alerts ALTER COLUMN statement_id DROP NOT NULL;
ALTER TABLE public.billing_alerts DROP CONSTRAINT IF EXISTS billing_alerts_key;
ALTER TABLE public.billing_alerts ADD CONSTRAINT billing_alerts_key CHECK (key IN (
  'generado', 'recordatorio', 'venceHoy', 'vencido', 'ultimoDia', 'bloqueado',
  'recibido', 'aprobado', 'rechazado', 'admRevisar', 'admMora', 'admBloqueado',
  'vacaciones', 'vacCancel', 'admVacaciones', 'admVacCancel', 'vacExtra'));

-- -----------------------------------------------------------------------------
-- 2. RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.billing_sector_rates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auxiliar_billing_vacations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_sector_rates, public.auxiliar_billing_vacations FROM anon, PUBLIC, authenticated;
-- Tarifas: el jefe lee y borra directo (escribe por RPC); el tripulante no.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_sector_rates TO authenticated;
-- Vacaciones: se ESCRIBEN solo por las funciones de abajo; directo, solo se leen.
GRANT SELECT ON public.auxiliar_billing_vacations TO authenticated;

DROP POLICY IF EXISTS p_billing_sector_rates_admin ON public.billing_sector_rates;
CREATE POLICY p_billing_sector_rates_admin ON public.billing_sector_rates FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_auxiliar_billing_vacations_select_own ON public.auxiliar_billing_vacations;
CREATE POLICY p_auxiliar_billing_vacations_select_own ON public.auxiliar_billing_vacations FOR SELECT TO authenticated
  USING (auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_auxiliar_billing_vacations_select_admin ON public.auxiliar_billing_vacations;
CREATE POLICY p_auxiliar_billing_vacations_select_admin ON public.auxiliar_billing_vacations FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- Cargos de viajes extra: se ESCRIBEN solo por las funciones de abajo. Directo
-- los lee el jefe de la organización; el tripulante ve los suyos solo por RPC
-- (aux_billing_my_account), sin política propia.
ALTER TABLE public.billing_extra_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_extra_charges FROM anon, PUBLIC, authenticated;
GRANT SELECT ON public.billing_extra_charges TO authenticated;
DROP POLICY IF EXISTS p_billing_extra_charges_select_admin ON public.billing_extra_charges;
CREATE POLICY p_billing_extra_charges_select_admin ON public.billing_extra_charges FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- -----------------------------------------------------------------------------
-- 3. Sector, tarifa y mensualidad efectiva de un tripulante
-- -----------------------------------------------------------------------------
-- Una sola fuente para la base y para las pantallas. Nombres de salida con
-- prefijo propio: ninguno choca con una columna de las tablas que se consultan.
-- La mensualidad por defecto de la organización (0090) ya NO entra: sin valor
-- propio ni del sector no hay mensualidad (30-sep: «todos tienen su propio valor»).
DROP FUNCTION IF EXISTS public.billing_rate_of(uuid);   -- la versión vieja traía org_default
CREATE OR REPLACE FUNCTION public.billing_rate_of(p_aux uuid,
  OUT sector_name text,        -- el que manda (a mano o de la residencia)
  OUT sector_origin text,      -- 'manual' | 'residence' | NULL (sin sector)
  OUT manual_sector text,
  OUT res_name text,
  OUT res_sector text,
  OUT sector_monthly integer,  -- mensualidad del sector (NULL = sin cargar)
  OUT sector_per_trip integer, -- valor por viaje del sector (NULL = sin cargar)
  OUT own_amount integer,      -- valor propio de la cuenta (auxiliar_billing.amount_cop)
  OUT monthly integer,         -- la efectiva: propio → sector (NULL = sin valor)
  OUT monthly_origin text)     -- 'own' | 'sector' | NULL
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT pr.organization_id, nullif(btrim(ab.sector), ''), r.name, nullif(btrim(r.sector), ''), ab.amount_cop
    INTO v_org, manual_sector, res_name, res_sector, own_amount
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
    LEFT JOIN public.residences r ON r.id = ap.residence_id
   WHERE ap.id = p_aux;
  sector_name := coalesce(manual_sector, res_sector);
  sector_origin := CASE WHEN manual_sector IS NOT NULL THEN 'manual' WHEN res_sector IS NOT NULL THEN 'residence' END;
  IF sector_name IS NOT NULL THEN
    SELECT sr.monthly_cop, sr.per_trip_cop INTO sector_monthly, sector_per_trip
      FROM public.billing_sector_rates sr
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(sector_name);
  END IF;
  monthly := coalesce(own_amount, sector_monthly);
  monthly_origin := CASE WHEN own_amount IS NOT NULL THEN 'own'
                         WHEN sector_monthly IS NOT NULL THEN 'sector' END;
END;
$$;

COMMENT ON FUNCTION public.billing_rate_of(uuid) IS
  'Tarifas (0094): sector del tripulante (a mano gana sobre la residencia), tarifa de su sector y mensualidad efectiva (propia → sector; sin ninguna, sin valor). La mensualidad por defecto de la organización ya no se usa.';

-- 3b. TRANSICIÓN de la mensualidad por defecto (solo la primera vez, ver 1.0).
--     Quien hoy se cobra con ella (sin valor propio, en una organización que la
--     tiene cargada) la recibe como su valor propio: es lo que ya pagaba (0090:
--     coalesce(amount_cop, default_amount_cop)), así nadie se queda sin cuenta de
--     cobro en silencio al dejar de leerse. Nadie con mensualidad de sector la
--     recibe (la primera vez no hay tarifas: la tabla es nueva). Es la última vez
--     que se lee default_amount_cop.
DO $do$
DECLARE v_n integer;
BEGIN
  IF to_regclass('pg_temp._mig0094_primera') IS NULL THEN RETURN; END IF;
  UPDATE public.auxiliar_billing ab
     SET amount_cop = cfg.default_amount_cop
    FROM public.billing_settings cfg
   WHERE cfg.organization_id = ab.organization_id
     AND cfg.default_amount_cop IS NOT NULL
     AND ab.amount_cop IS NULL
     AND (SELECT rt.sector_monthly FROM public.billing_rate_of(ab.auxiliar_profile_id) rt) IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    RAISE NOTICE '0094: % cuenta(s) sin valor propio quedan con la mensualidad por defecto de su organización como valor propio.', v_n;
  END IF;
END
$do$;

-- Viajes reservados en un período (reservas no canceladas; hora de Bogotá).
CREATE OR REPLACE FUNCTION public.billing_trips_booked(p_aux uuid, p_from date, p_to date)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int
    FROM public.reservations r
   WHERE r.auxiliar_profile_id = p_aux
     AND r.cancelled_at IS NULL
     AND coalesce(r.status_h2a::text, r.status_a2h::text, '') <> 'cancelled'
     AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to;
$$;

-- Viajes que YA hizo en un período: los reservados de días anteriores a hoy
-- (hoy no cuenta: puede que todavía no haya salido). Es el mínimo que el
-- tripulante puede declarar en unas vacaciones de ese cobro.
CREATE OR REPLACE FUNCTION public.billing_trips_taken(p_aux uuid, p_from date, p_to date, p_today date)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_from >= p_today THEN 0
              ELSE public.billing_trips_booked(p_aux, p_from, least(p_to, p_today - 1)) END;
$$;

-- ¿La cuenta de cobro quedó saldada SOLA en $0 por unas vacaciones? (el pago
-- automático de billing_vacation_settle_zero; solo el jefe lo deshace).
CREATE OR REPLACE FUNCTION public.billing_statement_auto_zero(p_st_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.billing_payments py WHERE py.statement_id = p_st_id AND py.automatic);
$$;

-- ¿La cuenta de cobro está VIVA? (una reserva de más la recalcula en vez de
-- dejar un cargo pendiente): sin pagar —o saldada sola en $0—, sin comprobante
-- en revisión y sin pasar su fecha límite ni el fin de su período.
CREATE OR REPLACE FUNCTION public.billing_statement_live(p_st public.billing_statements, p_today date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_st.id IS NOT NULL
     AND (p_st.paid_at IS NULL OR public.billing_statement_auto_zero(p_st.id))
     AND (p_st.paid_at IS NOT NULL OR p_st.proof_state <> 'review')
     AND p_today <= p_st.due_date
     AND p_today <= p_st.period_end;
$$;

-- «Viajes extra de vacaciones de octubre: 2 × $20.000 = $40.000»
CREATE OR REPLACE FUNCTION public.billing_extra_label(p_source date, p_trips integer, p_per integer)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT 'Viajes extra de vacaciones de ' || public.billing_month_name(p_source) || ': '
         || p_trips::text || ' × ' || public.billing_money(p_per) || ' = '
         || public.billing_money(p_per::numeric * p_trips);
$$;

-- Lo que una cuenta de cobro incluye de cobros anteriores (cargos aplicados).
CREATE OR REPLACE FUNCTION public.billing_statement_extras_cop(p_st_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(x.amount_cop), 0)::int
    FROM public.billing_extra_charges x
   WHERE x.applied_statement_id = p_st_id AND x.cancelled_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.billing_extra_json(p_x public.billing_extra_charges)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id',                p_x.id,
    'sourcePeriodStart', p_x.source_period_start,
    'trips',             p_x.trips,
    'perTripCOP',        p_x.per_trip_cop,
    'amountCOP',         p_x.amount_cop,
    'appliedStatementId', p_x.applied_statement_id,
    'appliedAt',         p_x.applied_at,
    'pending',           p_x.applied_at IS NULL AND p_x.cancelled_at IS NULL,
    'label',             public.billing_extra_label(p_x.source_period_start, p_x.trips, p_x.per_trip_cop));
$$;

CREATE OR REPLACE FUNCTION public.billing_statement_extras_json(p_st_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(public.billing_extra_json(x) ORDER BY x.source_period_start), '[]'::jsonb)
    FROM public.billing_extra_charges x
   WHERE x.applied_statement_id = p_st_id AND x.cancelled_at IS NULL;
$$;

-- Los viajes extra de un PERÍODO de origen: los ya aplicados (cobrados en una
-- cuenta siguiente) y el pendiente.
CREATE OR REPLACE FUNCTION public.billing_period_extras(p_aux uuid, p_period_start date,
  OUT applied_trips integer, OUT applied_cop integer, OUT pending_trips integer, OUT pending_cop integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(x.trips) FILTER (WHERE x.applied_at IS NOT NULL), 0)::int,
         coalesce(sum(x.amount_cop) FILTER (WHERE x.applied_at IS NOT NULL), 0)::int,
         coalesce(sum(x.trips) FILTER (WHERE x.applied_at IS NULL), 0)::int,
         coalesce(sum(x.amount_cop) FILTER (WHERE x.applied_at IS NULL), 0)::int
    FROM public.billing_extra_charges x
   WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start AND x.cancelled_at IS NULL;
$$;

-- -----------------------------------------------------------------------------
-- 4. Vacaciones: forma para las pantallas
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_vac_json(p_v public.auxiliar_billing_vacations)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_v.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',          p_v.id,
    'periodStart', p_v.period_start,
    'startsOn',    p_v.starts_on,
    'endsOn',      p_v.ends_on,
    'trips',       p_v.trips,
    'perTripCOP',  p_v.per_trip_cop,
    'totalCOP',    p_v.per_trip_cop * p_v.trips,
    'sector',      p_v.sector,
    'setBy',       p_v.set_by,
    'status',      p_v.status,
    'createdAt',   p_v.created_at,
    'cancelledAt', p_v.cancelled_at) END;
$$;

-- Un período de cobro visto desde las vacaciones: sus fechas, si se pueden
-- marcar o cambiar y por qué no, los viajes reservados y ya hechos, y las
-- activas. Hay dos permisos porque las reglas son distintas:
--   canChange / why            el TRIPULANTE: 'inactive' | 'notStarted' | 'zero'
--                              (saldada sola en $0) | 'paid' | 'review' |
--                              'overdue' (vencida o pausada, sin pagar)
--   adminCanChange / adminWhy  el JEFE: 'inactive' | 'notStarted' | 'paid'
--                              (pagada por una persona) | 'review'. El jefe sí
--                              cambia una vencida y reabre la saldada sola.
-- Y lo de cobrar la diferencia (con vacaciones activas o la foto de la cuenta):
--   tripsBilled        viajes de este período ya cobrados (los de su cuenta +
--                      los extra aplicados después); NULL sin cuenta de vacaciones
--   extraPendingTrips / extraPendingCOP  el cargo pendiente (entra en el próximo cobro)
--   extraTrips / extraCOP  los viajes de más sobre lo declarado (cobrados o pendientes)
--   freeTrips          cuántos viajes más puede reservar sin que se le sume nada
--   statementLive      si una reserva de más recalcula esta cuenta (si no, va al próximo cobro)
CREATE OR REPLACE FUNCTION public.billing_vac_period_json(p_aux uuid, p_period_start date, p_today date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ab     public.auxiliar_billing;
  v_st     public.billing_statements;
  v_vac    public.auxiliar_billing_vacations;
  v_photo  public.auxiliar_billing_vacations;
  v_end    date;
  v_why    text;
  v_awhy   text;
  v_zero   boolean;
  v_over   boolean;
  v_booked integer;
  v_billed integer;
  v_ex     record;
  v_ref    public.auxiliar_billing_vacations;
  v_xbill  integer;
  v_xcop   integer;
BEGIN
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux;
  IF v_ab.auxiliar_profile_id IS NULL OR p_period_start IS NULL THEN RETURN NULL; END IF;
  v_end := public.billing_next_cut(p_period_start, v_ab.cut_day) - 1;
  SELECT * INTO v_st FROM public.billing_statements
   WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start;
  SELECT * INTO v_vac FROM public.auxiliar_billing_vacations
   WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start AND status = 'active';
  v_zero := v_st.id IS NOT NULL AND v_st.paid_at IS NOT NULL AND public.billing_statement_auto_zero(v_st.id);
  v_over := v_st.id IS NOT NULL AND v_st.paid_at IS NULL AND p_today > v_st.due_date;
  v_why := CASE
    WHEN NOT v_ab.active THEN 'inactive'
    WHEN p_period_start < v_ab.starts_on THEN 'notStarted'
    WHEN v_zero THEN 'zero'
    WHEN v_st.paid_at IS NOT NULL THEN 'paid'
    WHEN v_st.proof_state = 'review' THEN 'review'
    WHEN v_over THEN 'overdue' END;
  v_awhy := CASE
    WHEN NOT v_ab.active THEN 'inactive'
    WHEN p_period_start < v_ab.starts_on THEN 'notStarted'
    WHEN v_st.paid_at IS NOT NULL AND NOT v_zero THEN 'paid'
    WHEN v_st.paid_at IS NULL AND v_st.proof_state = 'review' THEN 'review' END;
  v_booked := public.billing_trips_booked(p_aux, p_period_start, v_end);
  -- Las de referencia: las activas; si no hay, la foto de su cuenta (vacaciones
  -- canceladas con la cuenta ya pagada: lo de más se sigue cobrando).
  IF v_st.vacation_id IS NOT NULL THEN
    SELECT * INTO v_photo FROM public.auxiliar_billing_vacations WHERE id = v_st.vacation_id;
  END IF;
  IF v_vac.id IS NOT NULL THEN v_ref := v_vac; ELSE v_ref := v_photo; END IF;
  SELECT * INTO v_ex FROM public.billing_period_extras(p_aux, p_period_start);
  IF v_st.id IS NOT NULL AND v_st.vacation_id IS NOT NULL THEN
    v_billed := coalesce(v_st.vacation_trips, v_photo.trips, 0) + v_ex.applied_trips;
  END IF;
  -- Los de más ya cobrados: los de su cuenta sobre lo declarado (al valor de la
  -- foto) + los aplicados después en otra cuenta.
  IF v_billed IS NOT NULL AND v_ref.id IS NOT NULL THEN
    v_xbill := greatest(0, coalesce(v_st.vacation_trips, v_photo.trips, 0) - v_ref.trips);
    v_xcop  := v_xbill * coalesce(v_photo.per_trip_cop, v_ref.per_trip_cop) + v_ex.applied_cop;
    v_xbill := v_xbill + v_ex.applied_trips;
  ELSE
    v_xbill := 0; v_xcop := 0;
  END IF;
  RETURN jsonb_build_object(
    'periodStart',      p_period_start,
    'periodEnd',        v_end,
    'statementId',      v_st.id,
    'statementPaid',    v_st.paid_at IS NOT NULL,
    'statementReview',  coalesce(v_st.proof_state = 'review' AND v_st.paid_at IS NULL, false),
    'statementZero',    v_zero,
    'statementOverdue', v_over,
    'statementLive',    public.billing_statement_live(v_st, p_today),
    'canChange',        v_why IS NULL,
    'why',              v_why,
    'adminCanChange',   v_awhy IS NULL,
    'adminWhy',         v_awhy,
    'tripsBooked',      v_booked,
    'tripsTaken',       public.billing_trips_taken(p_aux, p_period_start, v_end, p_today),
    'vacation',         public.billing_vac_json(v_vac),
    -- 0094 (30-sep): se cobra la diferencia.
    'tripsBilled',       v_billed,
    'extraPendingTrips', v_ex.pending_trips,
    'extraPendingCOP',   v_ex.pending_cop,
    'extraBilledTrips',  v_xbill,
    'extraBilledCOP',    v_xcop,
    'extraTrips',        v_xbill + v_ex.pending_trips,
    'extraCOP',          v_xcop + v_ex.pending_cop,
    'freeTrips',         CASE WHEN v_ref.id IS NULL THEN NULL
                              ELSE greatest(0, greatest(v_ref.trips, coalesce(v_billed, 0)) - v_booked) END,
    'extraPerTripCOP',   v_ref.per_trip_cop);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. La cuenta de cobro con su modalidad (0090 + «vacation» y «modality»)
-- -----------------------------------------------------------------------------
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
  v_vac     public.auxiliar_billing_vacations;
  v_extra   integer := public.billing_statement_extras_cop(p_st.id);
BEGIN
  v_comp := CASE
    WHEN p_st.paid_at IS NOT NULL THEN 'approved'
    WHEN p_st.proof_state = 'review' THEN 'review'
    WHEN p_st.proof_state = 'rejected' THEN 'rejected'
    ELSE 'none' END;
  SELECT source, via_label, amount_cop, automatic INTO v_pay FROM public.billing_payments WHERE statement_id = p_st.id;
  SELECT id, status, via_label, submitted_on, storage_path, content_type INTO v_proof
    FROM public.billing_proofs WHERE statement_id = p_st.id ORDER BY submitted_at DESC LIMIT 1;
  -- La foto de la cuenta (no las vacaciones activas de hoy): una cuenta pagada
  -- con vacaciones sigue siendo de vacaciones aunque después se cancelen.
  SELECT * INTO v_vac FROM public.auxiliar_billing_vacations WHERE id = p_st.vacation_id;
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
  ) || jsonb_build_object(
    -- 0094: ¿este cobro es de vacaciones? (viajes × valor por viaje)
    'modality',      CASE WHEN p_st.vacation_id IS NULL THEN 'mensual' ELSE 'vacaciones' END,
    'vacation',      public.billing_vac_json(v_vac),
    -- saldada sola en $0 (nadie la aprobó)
    'paidAutomatic', coalesce(v_pay.automatic, false),
    -- 30-sep: los viajes que cobra (vacaciones) y los extra de cobros anteriores
    -- que trae como línea aparte (amountCOP ya los incluye).
    'vacationTrips', p_st.vacation_trips,
    'extras',        public.billing_statement_extras_json(p_st.id),
    'extrasCOP',     v_extra,
    'baseAmountCOP', p_st.amount_cop - v_extra,
    -- revisión 1-oct: el descuento que puso el jefe (el aplicado, discountCOP,
    -- no pasa del monto; si el monto sube, vuelve hasta este).
    'discountRequestedCOP', coalesce(p_st.discount_requested_cop, p_st.discount_cop)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Abrir la cuenta de cobro de un corte (0090 + sector + vacaciones + extras)
-- -----------------------------------------------------------------------------
-- Monto = la base del período (mensualidad efectiva, o vacaciones: valor por
-- viaje × max(declarados, reservados)) + los CARGOS PENDIENTES de viajes extra
-- de cobros anteriores, recalculados con el conteo FINAL de su período y
-- marcados como aplicados a esta cuenta (una sola vez). Sin base no se abre
-- (los cargos esperan a la próxima cuenta que sí se abra).
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
  v_vac    public.auxiliar_billing_vacations;
  v_rate   record;
  v_end    date;
  v_booked integer;
  v_want   integer;
  v_src    date;
  x        public.billing_extra_charges;
  v_extra  integer := 0;
  v_ids    uuid[] := ARRAY[]::uuid[];
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
  v_end := public.billing_next_cut(p_period_start, ab.cut_day) - 1;
  -- Vacaciones en este período: valor por viaje (la foto de cuando las marcó) ×
  -- max(declarados, reservados): nunca baja de lo declarado y lo reservado se cobra.
  SELECT * INTO v_vac FROM public.auxiliar_billing_vacations
   WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start AND status = 'active';
  IF v_vac.id IS NOT NULL THEN
    v_booked := public.billing_trips_booked(p_aux, p_period_start, v_end);
    v_want   := greatest(v_vac.trips, v_booked);
    v_amount := v_vac.per_trip_cop * v_want;
  ELSE
    -- La mensualidad efectiva: propia → la del sector (sin ninguna, sin cobro).
    SELECT * INTO v_rate FROM public.billing_rate_of(p_aux);
    v_amount := v_rate.monthly;
  END IF;
  IF v_amount IS NULL THEN RETURN NULL; END IF;   -- sin monto no hay cobro (nunca uno inventado)

  -- Los cargos pendientes de cobros anteriores, con el conteo FINAL de su
  -- período: primero se recalculan (el último período con cuenta y los que ya
  -- tienen cargo) y después se toman, bloqueados, para esta cuenta.
  FOR v_src IN
    SELECT DISTINCT y.ps FROM (
      SELECT x2.source_period_start AS ps FROM public.billing_extra_charges x2
       WHERE x2.auxiliar_profile_id = p_aux AND x2.applied_at IS NULL AND x2.cancelled_at IS NULL
         AND x2.source_period_start < p_period_start
      UNION ALL
      (SELECT st.period_start FROM public.billing_statements st
        WHERE st.auxiliar_profile_id = p_aux AND st.period_start < p_period_start
        ORDER BY st.period_start DESC LIMIT 1)
    ) y
  LOOP
    PERFORM public.billing_vacation_sync(p_aux, v_src, p_today, false);
  END LOOP;
  FOR x IN
    SELECT * FROM public.billing_extra_charges x3
     WHERE x3.auxiliar_profile_id = p_aux AND x3.applied_at IS NULL AND x3.cancelled_at IS NULL
       AND x3.source_period_start < p_period_start
     ORDER BY x3.source_period_start
       FOR UPDATE
  LOOP
    v_extra := v_extra + x.amount_cop;
    v_ids := v_ids || x.id;
  END LOOP;

  INSERT INTO public.billing_statements (organization_id, auxiliar_profile_id, period_start, period_end, amount_cop,
                                         due_days, notice_days, grace_days, vacation_id, vacation_trips)
  VALUES (ab.organization_id, p_aux, p_period_start, v_end, v_amount + v_extra,
          coalesce(ab.due_days, cfg.due_days, 5),
          coalesce(ab.notice_days, cfg.notice_days, 2),
          coalesce(ab.grace_days, cfg.grace_days, 3),
          v_vac.id, v_want)
  RETURNING * INTO s;
  IF array_length(v_ids, 1) IS NOT NULL THEN
    UPDATE public.billing_extra_charges SET applied_statement_id = s.id, applied_at = now()
     WHERE id = ANY (v_ids);
  END IF;
  UPDATE public.billing_statements SET status = public.billing_statement_base(s, p_today) WHERE id = s.id;
  -- Reservó más de lo declarado antes de que abriera: se le dice cuánto se sumó.
  IF v_vac.id IS NOT NULL AND v_want > v_vac.trips THEN
    PERFORM public.billing_emit_vac_extra(v_vac, s, v_booked, v_want - v_vac.trips, true);
  END IF;
  -- Vacaciones sin viajes: no hay nada que pagar; el período queda saldado solo
  -- en $0 (pago automático, sin el aviso de «lista» ni el de «Pago confirmado»:
  -- el aviso fue el de las vacaciones). El jefe lo reabre si hace falta.
  IF v_amount + v_extra = 0 THEN
    PERFORM public.billing_vacation_settle_zero(s.id, p_today);
    RETURN s.id;
  END IF;
  -- El aviso del corte sale al abrir la cuenta; la push, solo si se abre el día del corte.
  PERFORM public.billing_emit(s, 'generado', p_period_start, '{}'::jsonb, NULL, p_period_start = p_today);
  RETURN s.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Marcar y cancelar vacaciones
-- -----------------------------------------------------------------------------

-- Saldo AUTOMÁTICO de $0 (vacaciones sin nada que pagar). A diferencia de
-- billing_settle (0090) no pone a nadie como quien aprobó (paid_by y
-- recorded_by NULL: en el balance sale «Automático», nunca el propio
-- tripulante) y no manda «Pago confirmado»: el aviso ya fue el de las
-- vacaciones. El pago queda marcado automatic para que el jefe lo pueda deshacer.
CREATE OR REPLACE FUNCTION public.billing_vacation_settle_zero(p_st_id uuid, p_today date)
RETURNS public.billing_statements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s       public.billing_statements;
  v_was   boolean;
  v_trips integer;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  IF s.id IS NULL OR s.paid_at IS NOT NULL OR s.amount_cop - s.discount_cop <> 0 THEN RETURN s; END IF;
  SELECT v.trips INTO v_trips FROM public.auxiliar_billing_vacations v WHERE v.id = s.vacation_id;
  v_was := public.billing_statement_blocked(s, p_today);
  UPDATE public.billing_statements
     SET paid_at = now(), paid_on = p_today, paid_via = 'manual', paid_by = NULL,
         was_blocked = v_was, proof_state = 'approved', rejected_reason = NULL, status = 'pagado'
   WHERE id = s.id
  RETURNING * INTO s;
  INSERT INTO public.billing_payments (statement_id, organization_id, auxiliar_profile_id, source, proof_id,
                                       amount_cop, via_label, paid_on, recorded_by, note, automatic)
  VALUES (s.id, s.organization_id, s.auxiliar_profile_id, 'manual', NULL, 0,
          CASE WHEN v_trips = 0 THEN 'Vacaciones sin viajes' ELSE 'Vacaciones cubiertas por el descuento' END,
          s.paid_on, NULL, 'Saldado solo: vacaciones sin nada que pagar', true);
  PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, p_today);
  RETURN s;
END;
$$;

-- Deshace un saldo automático de $0 (solo lo llama el jefe, al cambiar o
-- cancelar esas vacaciones): la cuenta vuelve a estar sin pagar. El monto nuevo
-- lo pone quien llama (billing_vacation_reprice) y, si ya pasó la fecha de
-- pausa, billing_block_if_due la pausa.
CREATE OR REPLACE FUNCTION public.billing_vacation_unsettle(p_st_id uuid, p_today date)
RETURNS public.billing_statements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  IF s.id IS NULL OR s.paid_at IS NULL OR NOT public.billing_statement_auto_zero(s.id) THEN RETURN s; END IF;
  DELETE FROM public.billing_payments WHERE statement_id = s.id AND automatic;
  UPDATE public.billing_statements
     SET paid_at = NULL, paid_on = NULL, paid_via = NULL, paid_by = NULL, was_blocked = NULL,
         proof_state = 'none', rejected_reason = NULL
   WHERE id = s.id
  RETURNING * INTO s;
  UPDATE public.billing_statements SET status = public.billing_statement_base(s, p_today) WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$;

-- Nuevo monto de una cuenta de cobro SIN pagar (vacaciones o su cancelación) y
-- su foto (p_vac_id: las vacaciones con que se cobra, NULL = mensualidad;
-- p_trips: los viajes que cobra, NULL = mensualidad). El descuento aplicado no
-- puede pasar del monto nuevo, pero el que puso el jefe se conserva
-- (discount_requested_cop): si el monto vuelve a subir, el descuento vuelve
-- hasta ese valor. Si queda sin nada que pagar, se salda sola (automático). Las
-- fechas no se mueven (los plazos quedaron congelados al abrir).
DROP FUNCTION IF EXISTS public.billing_vacation_reprice(uuid, integer, date);
DROP FUNCTION IF EXISTS public.billing_vacation_reprice(uuid, integer, uuid, date);
CREATE OR REPLACE FUNCTION public.billing_vacation_reprice(p_st_id uuid, p_amount integer, p_vac_id uuid, p_today date,
                                                           p_trips integer)
RETURNS public.billing_statements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements;
BEGIN
  -- (En un UPDATE todas las expresiones leen la fila de antes.)
  UPDATE public.billing_statements
     SET amount_cop = p_amount,
         discount_requested_cop = coalesce(discount_requested_cop, discount_cop),
         discount_cop = least(coalesce(discount_requested_cop, discount_cop), p_amount),
         vacation_id = p_vac_id,
         vacation_trips = CASE WHEN p_vac_id IS NULL THEN NULL ELSE p_trips END
   WHERE id = p_st_id AND paid_at IS NULL
  RETURNING * INTO s;
  IF s.id IS NULL THEN
    SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id;
    RETURN s;
  END IF;
  IF s.amount_cop - s.discount_cop = 0 THEN
    s := public.billing_vacation_settle_zero(s.id, p_today);
  END IF;
  RETURN s;
END;
$$;

-- Aviso al tripulante cuando se le suman viajes de más (mecanismo de 0090:
-- billing_alerts + push). «Se sumó $V a tu cuenta: reservaste N viajes y
-- declaraste M.» V = lo que se sumó en ESTE cambio (quien llama solo avisa si
-- lo cobrado sube). p_live: va en la cuenta de ese período (true) o en el
-- próximo cobro (false). Dedupe por tripulante + período + N + a dónde va (esa
-- cuenta o 'pend'), SIN el id de las vacaciones: cancelar y volver a reservar el
-- mismo viaje, o cambiar las vacaciones, no lo repite; un viaje que antes fue a
-- la cuenta viva y ahora queda como cargo pendiente sí avisa (dice otra cosa).
CREATE OR REPLACE FUNCTION public.billing_emit_vac_extra(p_v public.auxiliar_billing_vacations, p_st public.billing_statements,
                                                         p_booked integer, p_added integer, p_live boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_add   integer := greatest(0, coalesce(p_added, 0)) * p_v.per_trip_cop;
  v_title text := 'Viajes de más en tus vacaciones';
  v_body  text;
  v_prof  uuid;
  v_ab    public.auxiliar_billing;
  v_push  boolean := true;
  v_id    uuid;
  v_today date := public.billing_today();
BEGIN
  IF p_v.id IS NULL OR v_add <= 0 THEN RETURN false; END IF;
  v_body := 'Se sumó ' || public.billing_money(v_add) || ' a tu cuenta: reservaste '
            || public.billing_pl(p_booked, 'viaje', 'viajes') || ' y declaraste ' || p_v.trips::text || '.'
            || CASE WHEN p_live THEN ' Va en tu cobro de ' || public.billing_month_name(p_v.period_start) || '.'
                    ELSE ' Entra en tu próximo cobro.' END;
  SELECT ap.profile_id INTO v_prof FROM public.auxiliar_profiles ap WHERE ap.id = p_v.auxiliar_profile_id;
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_v.auxiliar_profile_id;
  IF v_ab.push_enabled IS FALSE THEN v_push := false; END IF;

  INSERT INTO public.billing_alerts (organization_id, auxiliar_profile_id, statement_id, proof_id, audience, key,
                                     day, day_index, title, body, tone, pushed, payload, dedupe_key)
  VALUES (p_v.organization_id, p_v.auxiliar_profile_id, p_st.id, NULL, 'aux', 'vacExtra',
          v_today, v_today - p_v.period_start, v_title, v_body, 'warn', v_push,
          jsonb_build_object('vacationId', p_v.id, 'periodStart', p_v.period_start, 'tripsBooked', p_booked,
                             'tripsDeclared', p_v.trips, 'addedTrips', p_added, 'addedCOP', v_add,
                             'perTripCOP', p_v.per_trip_cop, 'live', p_live),
          'vacx:' || p_v.auxiliar_profile_id::text || ':' || p_v.period_start::text || ':' || p_booked::text || ':'
          || CASE WHEN p_live AND p_st.id IS NOT NULL THEN p_st.id::text ELSE 'pend' END)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;
  IF v_push AND v_prof IS NOT NULL THEN
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    VALUES (v_prof, v_title, v_body, '/#/pagos', 'bill:' || v_id::text || ':' || v_prof::text, now())
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN true;
END;
$$;

-- EL RECÁLCULO de un período de vacaciones (se cobra la diferencia). Lo llaman
-- el trigger de reservations, marcar y cancelar vacaciones y la apertura de la
-- cuenta siguiente (conteo final). Idempotente.
--   · Sin vacaciones activas (ni la foto de una cuenta ya cerrada): el cargo
--     pendiente de ese período se cancela.
--   · Sin cuenta de cobro todavía: nada (al abrirla se cobra max(declarados,
--     reservados)).
--   · Cuenta VIVA (billing_statement_live): su monto pasa a valor por viaje ×
--     max(declarados, reservados) sumando o restando solo la diferencia de
--     viajes (un ajuste a mano del jefe se respeta); si estaba saldada sola en $0
--     se reabre. Lo que hubiera pendiente de ese período queda adentro.
--     p_force: lo pide marcar vacaciones (el jefe sobre una vencida): la cuenta
--     se toca aunque no esté viva, siempre que no la haya pagado una persona.
--   · Cuenta que ya no está viva: no se toca; lo reservado sobre
--     max(declarados, cobrados) queda como cargo pendiente (sube, baja o se
--     cancela) hasta que se abra la cuenta siguiente.
--     (revisión 1-oct) Si ya se cobra MÁS de lo que toca (canceló o movió un
--     viaje después de que su cargo entró en la cuenta siguiente) y esa cuenta
--     siguiente sigue viva, el cargo aplicado baja (o se anula) y esa cuenta se
--     recalcula por la diferencia. Lo que ya está en una cuenta pagada, en
--     revisión o vencida se queda (no hay saldo a favor).
CREATE OR REPLACE FUNCTION public.billing_vacation_sync(p_aux uuid, p_period_start date, p_today date,
                                                        p_force boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ab     public.auxiliar_billing;
  v_vac    public.auxiliar_billing_vacations;
  v_st     public.billing_statements;
  v_end    date;
  v_booked integer;
  v_want   integer;
  v_old    integer;
  v_prev   integer;
  v_extra  integer;
  v_amount integer;
  v_live   boolean;
  v_zero   boolean;
  v_pend   integer;
  v_x      public.billing_extra_charges;
  v_own    integer;
  v_live_x integer;
  v_dead_x integer;
  v_target integer;
  v_adj    integer;
  v_refund integer;
  v_take   integer;
  v_rs     public.billing_statements;
BEGIN
  IF p_aux IS NULL OR p_period_start IS NULL THEN RETURN; END IF;
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux;
  IF v_ab.auxiliar_profile_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_st FROM public.billing_statements
   WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start FOR UPDATE;
  SELECT * INTO v_vac FROM public.auxiliar_billing_vacations
   WHERE auxiliar_profile_id = p_aux AND period_start = p_period_start AND status = 'active';
  v_live := public.billing_statement_live(v_st, p_today);
  v_zero := v_st.id IS NOT NULL AND v_st.paid_at IS NOT NULL AND public.billing_statement_auto_zero(v_st.id);
  -- Sin vacaciones activas: la foto de una cuenta que ya no se toca sigue mandando.
  IF v_vac.id IS NULL AND v_st.vacation_id IS NOT NULL AND NOT v_live THEN
    SELECT * INTO v_vac FROM public.auxiliar_billing_vacations WHERE id = v_st.vacation_id;
  END IF;
  IF v_vac.id IS NULL OR v_st.id IS NULL THEN
    UPDATE public.billing_extra_charges SET cancelled_at = now()
     WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start
       AND applied_at IS NULL AND cancelled_at IS NULL;
    RETURN;
  END IF;

  v_end    := v_st.period_end;
  v_booked := public.billing_trips_booked(p_aux, p_period_start, v_end);
  v_want   := greatest(v_vac.trips, v_booked);

  IF (v_live OR (p_force AND (v_st.paid_at IS NULL OR v_zero))) AND v_vac.status = 'active' THEN
    -- Cuenta viva: se recalcula. Lo pendiente de este período queda adentro.
    UPDATE public.billing_extra_charges SET cancelled_at = now()
     WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start
       AND applied_at IS NULL AND cancelled_at IS NULL;
    v_old := CASE WHEN v_st.vacation_id = v_vac.id THEN v_st.vacation_trips END;
    -- Los viajes que esta cuenta YA cobraba por vacaciones, aunque fueran otras
    -- (cambiarlas crea una fila nueva): el aviso sale solo si se cobran más. Si
    -- se cobraba la mensualidad (recién marcadas), no hay aviso de viajes de
    -- más: el de las vacaciones (o la hoja) ya dice que se cobran los reservados.
    v_prev := CASE WHEN v_st.vacation_id IS NOT NULL THEN v_st.vacation_trips END;
    IF v_old IS NOT NULL AND v_old = v_want THEN RETURN; END IF;
    v_extra := public.billing_statement_extras_cop(v_st.id);
    v_amount := CASE WHEN v_old IS NOT NULL
                     THEN greatest(0, v_st.amount_cop + (v_want - v_old) * v_vac.per_trip_cop)
                     ELSE v_vac.per_trip_cop * v_want + v_extra END;
    -- Saldada sola en $0: se reabre (si vuelve a quedar en $0, se salda otra vez
    -- con la foto nueva).
    IF v_zero THEN v_st := public.billing_vacation_unsettle(v_st.id, p_today); END IF;
    v_st := public.billing_vacation_reprice(v_st.id, v_amount, v_vac.id, p_today, v_want);
    IF v_st.paid_at IS NULL THEN PERFORM public.billing_block_if_due(v_st.id, p_today); END IF;
    PERFORM public.billing_refresh_pause(p_aux, p_today);
    IF v_want > v_vac.trips AND v_prev IS NOT NULL AND v_want > v_prev THEN
      PERFORM public.billing_emit_vac_extra(v_vac, v_st, v_booked, v_want - greatest(v_prev, v_vac.trips), true);
    END IF;
    RETURN;
  END IF;

  -- Cuenta que ya no se toca: cargo pendiente por lo reservado de más.
  IF v_st.vacation_id IS NULL THEN RETURN; END IF;     -- se cobró como mensualidad
  -- Lo que ya se cobró de este período: los viajes de su cuenta (fijos) + los
  -- extra aplicados en cuentas siguientes, separados en los que están en una
  -- cuenta todavía VIVA (se pueden bajar) y los que no (se quedan).
  v_own := coalesce(v_st.vacation_trips, v_vac.trips);
  SELECT coalesce(sum(x.trips) FILTER (WHERE public.billing_statement_live(rs, p_today)), 0)::int,
         coalesce(sum(x.trips) FILTER (WHERE NOT public.billing_statement_live(rs, p_today)), 0)::int
    INTO v_live_x, v_dead_x
    FROM public.billing_extra_charges x
    LEFT JOIN public.billing_statements rs ON rs.id = x.applied_statement_id
   WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start
     AND x.applied_at IS NOT NULL AND x.cancelled_at IS NULL;
  -- Lo que toca cobrar de este período: max(declarados, reservados), nunca menos
  -- de lo que ya no se puede tocar.
  v_target := greatest(v_vac.trips, v_booked);
  v_adj    := greatest(0, v_target - (v_own + v_dead_x));   -- lo que puede ir en cargos que se mueven
  v_pend   := greatest(0, v_adj - v_live_x);
  v_refund := greatest(0, v_live_x - v_adj);

  -- Se cobra de más en una cuenta siguiente todavía viva: el cargo baja (el más
  -- nuevo primero) y esa cuenta se recalcula por la diferencia.
  IF v_refund > 0 THEN
    FOR v_x IN
      SELECT x.* FROM public.billing_extra_charges x
        JOIN public.billing_statements rs ON rs.id = x.applied_statement_id
       WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start
         AND x.applied_at IS NOT NULL AND x.cancelled_at IS NULL
         AND public.billing_statement_live(rs, p_today)
       ORDER BY x.applied_at DESC, x.created_at DESC
         FOR UPDATE OF x
    LOOP
      EXIT WHEN v_refund <= 0;
      v_take := least(v_x.trips, v_refund);
      IF v_take >= v_x.trips THEN
        UPDATE public.billing_extra_charges SET cancelled_at = now() WHERE id = v_x.id;
      ELSE
        UPDATE public.billing_extra_charges SET trips = trips - v_take WHERE id = v_x.id;
      END IF;
      SELECT * INTO v_rs FROM public.billing_statements WHERE id = v_x.applied_statement_id FOR UPDATE;
      IF v_rs.paid_at IS NOT NULL THEN v_rs := public.billing_vacation_unsettle(v_rs.id, p_today); END IF;   -- saldada sola en $0
      v_rs := public.billing_vacation_reprice(v_rs.id, greatest(0, v_rs.amount_cop - v_take * v_x.per_trip_cop),
                                              v_rs.vacation_id, p_today, v_rs.vacation_trips);
      IF v_rs.paid_at IS NULL THEN PERFORM public.billing_block_if_due(v_rs.id, p_today); END IF;
      v_refund := v_refund - v_take;
    END LOOP;
    PERFORM public.billing_refresh_pause(p_aux, p_today);
  END IF;

  SELECT * INTO v_x FROM public.billing_extra_charges
   WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start
     AND applied_at IS NULL AND cancelled_at IS NULL FOR UPDATE;
  IF v_pend = 0 THEN
    IF v_x.id IS NOT NULL THEN
      UPDATE public.billing_extra_charges SET cancelled_at = now() WHERE id = v_x.id;
    END IF;
    RETURN;
  END IF;
  IF v_x.id IS NULL THEN
    INSERT INTO public.billing_extra_charges (organization_id, auxiliar_profile_id, vacation_id, source_period_start,
                                              source_statement_id, trips, per_trip_cop)
    VALUES (v_st.organization_id, p_aux, v_vac.id, p_period_start, v_st.id, v_pend, v_vac.per_trip_cop)
    RETURNING * INTO v_x;
    PERFORM public.billing_emit_vac_extra(v_vac, v_st, v_booked, v_pend, false);
  ELSIF v_x.trips <> v_pend OR v_x.per_trip_cop <> v_vac.per_trip_cop OR v_x.vacation_id IS DISTINCT FROM v_vac.id THEN
    UPDATE public.billing_extra_charges
       SET trips = v_pend, per_trip_cop = v_vac.per_trip_cop, vacation_id = v_vac.id, source_statement_id = v_st.id
     WHERE id = v_x.id;
    IF v_pend > v_x.trips THEN
      PERFORM public.billing_emit_vac_extra(v_vac, v_st, v_booked, v_pend - v_x.trips, false);
    END IF;
  END IF;
END;
$$;

-- El trigger de reservations: alta, cambio de fecha, cancelación o
-- descancelación de una reserva recalcula el período de vacaciones de ese día
-- (el viejo y el nuevo si cambió la fecha). Solo si ese período tiene vacaciones
-- (activas o la foto de su cuenta) o un cargo pendiente; si no, no hace nada.
-- El período de un día = el de la cuenta de cobro cuyas fechas lo contienen
-- (revisión 1-oct: no el que daría el día de corte de HOY, que el jefe pudo
-- cambiar); sin cuenta que lo contenga, el del corte (vacaciones del siguiente
-- cobro, que todavía no tienen cuenta).
-- Un error del facturario NUNCA frena la reserva: queda en el log (WARNING).
CREATE OR REPLACE FUNCTION public.billing_reservation_vac_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows  jsonb := '[]'::jsonb;
  v_it    jsonb;
  v_aux   uuid;
  v_day   date;
  v_cut   smallint;
  v_ps    date;
  v_today date := public.billing_today();
  v_done  text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.auxiliar_profile_id IS NOT NULL AND OLD.required_arrival_at IS NOT NULL THEN
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('a', OLD.auxiliar_profile_id,
                'd', (OLD.required_arrival_at AT TIME ZONE 'America/Bogota')::date));
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') AND NEW.auxiliar_profile_id IS NOT NULL AND NEW.required_arrival_at IS NOT NULL THEN
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('a', NEW.auxiliar_profile_id,
                'd', (NEW.required_arrival_at AT TIME ZONE 'America/Bogota')::date));
  END IF;
  FOR v_it IN SELECT * FROM jsonb_array_elements(v_rows) LOOP
    BEGIN
      v_aux := (v_it ->> 'a')::uuid;
      v_day := (v_it ->> 'd')::date;
      SELECT ab.cut_day INTO v_cut FROM public.auxiliar_billing ab WHERE ab.auxiliar_profile_id = v_aux;
      IF v_cut IS NULL THEN CONTINUE; END IF;
      FOR v_ps IN
        SELECT st.period_start FROM public.billing_statements st
         WHERE st.auxiliar_profile_id = v_aux AND v_day BETWEEN st.period_start AND st.period_end
        UNION
        SELECT public.billing_last_cut(v_day, v_cut)
      LOOP
        IF (v_aux::text || v_ps::text) = ANY (v_done) THEN CONTINUE; END IF;
        v_done := v_done || (v_aux::text || v_ps::text);
        IF EXISTS (SELECT 1 FROM public.auxiliar_billing_vacations v
                    WHERE v.auxiliar_profile_id = v_aux AND v.period_start = v_ps AND v.status = 'active')
           OR EXISTS (SELECT 1 FROM public.billing_statements st
                       WHERE st.auxiliar_profile_id = v_aux AND st.period_start = v_ps AND st.vacation_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM public.billing_extra_charges x     -- pendiente o aplicado
                       WHERE x.auxiliar_profile_id = v_aux AND x.source_period_start = v_ps
                         AND x.cancelled_at IS NULL) THEN
          PERFORM public.billing_vacation_sync(v_aux, v_ps, v_today, false);
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Facturario: no se pudo recalcular las vacaciones de % (%): %', v_aux, v_ps, SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_billing_vac_ins ON public.reservations;
CREATE TRIGGER tr_reservations_billing_vac_ins
  AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.billing_reservation_vac_sync();
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_upd ON public.reservations;
CREATE TRIGGER tr_reservations_billing_vac_upd
  AFTER UPDATE OF required_arrival_at, cancelled_at, status_h2a, status_a2h, auxiliar_profile_id ON public.reservations
  FOR EACH ROW
  WHEN (OLD.required_arrival_at IS DISTINCT FROM NEW.required_arrival_at
     OR OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at
     OR OLD.auxiliar_profile_id IS DISTINCT FROM NEW.auxiliar_profile_id
     OR (coalesce(OLD.status_h2a::text, OLD.status_a2h::text, '') = 'cancelled')
        IS DISTINCT FROM (coalesce(NEW.status_h2a::text, NEW.status_a2h::text, '') = 'cancelled'))
  EXECUTE FUNCTION public.billing_reservation_vac_sync();
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_del ON public.reservations;
CREATE TRIGGER tr_reservations_billing_vac_del
  AFTER DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.billing_reservation_vac_sync();

-- (revisión 1-oct) Una cuenta de cobro que SALE de revisión sin pagarse (el
-- jefe rechazó el comprobante) vuelve a estar viva: se recalcula ya su período
-- de vacaciones (lo que se reservó o canceló mientras estuvo en revisión entra
-- o sale, y el cargo pendiente de ese período queda adentro) y los cobros
-- anteriores cuyos viajes extra trae (si se canceló alguno, la línea baja).
-- Antes quedaba con el monto viejo hasta la próxima reserva. Va por trigger
-- para no redefinir admin_billing_review_proof (0090). Un error del facturario
-- no frena el rechazo: queda en el log (WARNING).
CREATE OR REPLACE FUNCTION public.billing_statement_vac_resync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := public.billing_today();
  v_src   date;
BEGIN
  BEGIN
    IF NEW.vacation_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.auxiliar_billing_vacations v
                   WHERE v.auxiliar_profile_id = NEW.auxiliar_profile_id AND v.period_start = NEW.period_start
                     AND v.status = 'active')
       OR EXISTS (SELECT 1 FROM public.billing_extra_charges x
                   WHERE x.auxiliar_profile_id = NEW.auxiliar_profile_id AND x.source_period_start = NEW.period_start
                     AND x.cancelled_at IS NULL) THEN
      PERFORM public.billing_vacation_sync(NEW.auxiliar_profile_id, NEW.period_start, v_today, false);
    END IF;
    FOR v_src IN
      SELECT DISTINCT x.source_period_start FROM public.billing_extra_charges x
       WHERE x.applied_statement_id = NEW.id AND x.cancelled_at IS NULL
       ORDER BY 1
    LOOP
      PERFORM public.billing_vacation_sync(NEW.auxiliar_profile_id, v_src, v_today, false);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Facturario: no se pudo recalcular la cuenta de cobro % al salir de revisión: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_billing_statements_vac_resync ON public.billing_statements;
CREATE TRIGGER tr_billing_statements_vac_resync
  AFTER UPDATE OF proof_state ON public.billing_statements
  FOR EACH ROW
  WHEN (OLD.proof_state = 'review' AND NEW.proof_state IS DISTINCT FROM 'review' AND NEW.paid_at IS NULL)
  EXECUTE FUNCTION public.billing_statement_vac_resync();

-- (revisión 1-oct) El día de corte no se cambia mientras haya vacaciones
-- marcadas en este cobro o en el siguiente: el período de las vacaciones, el de
-- sus reservas y lo que muestran las pantallas salen del día de corte, y con
-- otro quedarían apuntando a un cobro que no es (unas del siguiente cobro nunca
-- se abrirían). Primero se cancelan; con el corte nuevo se marcan otra vez. Va
-- por trigger para no redefinir admin_billing_save_account (0090).
CREATE OR REPLACE FUNCTION public.guard_billing_cut_day_vacations()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_ps date;
BEGIN
  SELECT v.period_start INTO v_ps FROM public.auxiliar_billing_vacations v
   WHERE v.auxiliar_profile_id = NEW.auxiliar_profile_id AND v.status = 'active'
     AND v.period_start >= public.billing_last_cut(public.billing_today(), OLD.cut_day)
   ORDER BY v.period_start LIMIT 1;
  IF v_ps IS NOT NULL THEN
    RAISE EXCEPTION 'Tiene vacaciones marcadas en el cobro de %: cancélalas antes de cambiar el día de corte (y márcalas otra vez después)',
      public.billing_month_name(v_ps)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_auxiliar_billing_cut_day_vac ON public.auxiliar_billing;
CREATE TRIGGER tr_auxiliar_billing_cut_day_vac
  BEFORE UPDATE OF cut_day ON public.auxiliar_billing
  FOR EACH ROW
  WHEN (OLD.cut_day IS DISTINCT FROM NEW.cut_day)
  EXECUTE FUNCTION public.guard_billing_cut_day_vacations();

-- Aviso de vacaciones por el mecanismo de 0090 (billing_alerts + push por
-- notification_outbox). Al jefe: admVacaciones / admVacCancel. Al tripulante
-- (cuando lo hizo el jefe): vacaciones / vacCancel. Si al cancelar la cuenta ya
-- estaba pagada (no se tocó), el texto lo dice: nunca «vuelve a la mensualidad»
-- si no vuelve.
CREATE OR REPLACE FUNCTION public.billing_emit_vacation(p_v public.auxiliar_billing_vacations, p_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aud   text := CASE WHEN p_key IN ('admVacaciones', 'admVacCancel') THEN 'admin' ELSE 'aux' END;
  v_today date := public.billing_today();
  v_mes   text := public.billing_month_name(p_v.period_start);
  v_calc  text := public.billing_pl(p_v.trips, 'viaje', 'viajes') || ' × ' || public.billing_money(p_v.per_trip_cop)
                  || ' = ' || public.billing_money(p_v.per_trip_cop::numeric * p_v.trips);
  v_nom   text;
  v_prof  uuid;
  v_stid  uuid;
  v_kept  boolean := false;
  v_title text;
  v_body  text;
  v_id    uuid;
  v_push  boolean := true;
  v_ab    public.auxiliar_billing;
  v_booked integer;
  v_more  text := '';
BEGIN
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_v.auxiliar_profile_id;
  -- Se cobra la diferencia: si ya tiene más viajes reservados que los
  -- declarados, el aviso lo dice (se cobran los reservados).
  IF p_key IN ('admVacaciones', 'vacaciones') AND v_ab.cut_day IS NOT NULL THEN
    v_booked := public.billing_trips_booked(p_v.auxiliar_profile_id, p_v.period_start,
                                            public.billing_next_cut(p_v.period_start, v_ab.cut_day) - 1);
    IF v_booked > p_v.trips THEN
      v_more := CASE WHEN p_key = 'admVacaciones' THEN ' Tiene ' ELSE ' Tienes ' END
                || public.billing_pl(v_booked, 'viaje reservado', 'viajes reservados')
                || ': se cobran los ' || v_booked::text || '.';
    END IF;
  END IF;
  SELECT pr.full_name, ap.profile_id INTO v_nom, v_prof
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_v.auxiliar_profile_id;
  v_nom := coalesce(v_nom, 'Tripulante');
  SELECT st.id, (st.paid_at IS NOT NULL AND NOT public.billing_statement_auto_zero(st.id))
    INTO v_stid, v_kept
    FROM public.billing_statements st
   WHERE st.auxiliar_profile_id = p_v.auxiliar_profile_id AND st.period_start = p_v.period_start;
  v_kept := coalesce(v_kept, false);
  CASE p_key
    WHEN 'admVacaciones' THEN
      v_title := 'Vacaciones marcadas';
      v_body  := v_nom || ' marcó vacaciones: ' || v_calc || ' (cobro de ' || v_mes || ').' || v_more;
    WHEN 'admVacCancel' THEN
      v_title := 'Vacaciones canceladas';
      v_body  := v_nom || ' canceló sus vacaciones de ' || v_mes
                 || CASE WHEN v_kept THEN ' (ese cobro ya estaba pagado: no cambia).' ELSE ': vuelve la mensualidad.' END;
    WHEN 'vacaciones' THEN
      v_title := 'Coordinación marcó tus vacaciones';
      v_body  := 'Tu cobro de ' || v_mes || ': ' || v_calc || '.' || v_more;
    WHEN 'vacCancel' THEN
      v_title := 'Coordinación canceló tus vacaciones';
      v_body  := CASE WHEN v_kept THEN 'Tu cobro de ' || v_mes || ' ya estaba pagado: no cambia.'
                      ELSE 'Tu cobro de ' || v_mes || ' vuelve a la mensualidad.' END;
    ELSE
      RAISE EXCEPTION 'Aviso de vacaciones desconocido: %', p_key;
  END CASE;
  IF v_aud = 'aux' AND v_ab.push_enabled IS FALSE THEN v_push := false; END IF;

  INSERT INTO public.billing_alerts (organization_id, auxiliar_profile_id, statement_id, proof_id, audience, key,
                                     day, day_index, title, body, tone, pushed, payload, dedupe_key)
  VALUES (p_v.organization_id, p_v.auxiliar_profile_id, v_stid, NULL, v_aud, p_key,
          v_today, v_today - p_v.period_start, v_title, v_body, 'info', v_push,
          jsonb_build_object('vacationId', p_v.id, 'periodStart', p_v.period_start, 'trips', p_v.trips,
                             'perTripCOP', p_v.per_trip_cop, 'totalCOP', p_v.per_trip_cop * p_v.trips,
                             'statementKept', v_kept),
          'vac:' || p_v.id::text || ':' || p_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;
  IF NOT v_push THEN RETURN true; END IF;

  IF v_aud = 'aux' THEN
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    VALUES (v_prof, v_title, v_body, '/#/pagos', 'bill:' || v_id::text || ':' || v_prof::text, now())
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
    SELECT r.profile_id, v_title, v_body, '/#/cobro?aux=' || p_v.auxiliar_profile_id::text,
           'bill:' || v_id::text || ':' || r.profile_id::text, now()
      FROM public.ops_alert_recipients() r
      JOIN public.profiles p ON p.id = r.profile_id
     WHERE p.organization_id = p_v.organization_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN true;
END;
$$;

-- El período de cobro de 'current' (el corte vigente) o 'next' (el próximo).
CREATE OR REPLACE FUNCTION public.billing_vacation_period(p_ab public.auxiliar_billing, p_period text, p_today date)
RETURNS date
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_period = 'current' THEN RETURN public.billing_last_cut(p_today, p_ab.cut_day); END IF;
  IF p_period = 'next' THEN RETURN public.billing_next_cut(p_today, p_ab.cut_day); END IF;
  RAISE EXCEPTION 'Elige el cobro: este o el siguiente' USING ERRCODE = '22023';
END;
$$;

-- Marcar (o cambiar) las vacaciones de un período. p_actor: 'aux' | 'admin'
-- (los textos de error son para quien los va a leer). Lo que el tripulante no
-- puede y el jefe sí: cambiar un cobro vencido o pausado, declarar menos viajes
-- de los que ya hizo y reabrir un cobro que quedó saldado solo en $0.
CREATE OR REPLACE FUNCTION public.billing_vacation_set(p_aux uuid, p_period text, p_starts date, p_ends date,
                                                       p_trips integer, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today  date := public.billing_today();
  v_admin  boolean := (p_actor = 'admin');
  v_ab     public.auxiliar_billing;
  v_rate   record;
  v_start  date;
  v_end    date;
  v_st     public.billing_statements;
  v_old    public.auxiliar_billing_vacations;
  v_new    public.auxiliar_billing_vacations;
  v_before integer;
  v_zero   boolean;
  v_taken  integer;
BEGIN
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux FOR UPDATE;
  IF v_ab.auxiliar_profile_id IS NULL OR NOT v_ab.active THEN
    RAISE EXCEPTION '%', CASE WHEN v_admin THEN 'Primero crea (o activa) la cuenta de cobro del tripulante'
                              ELSE 'Todavía no tienes mensualidad registrada' END
      USING ERRCODE = 'P0002';
  END IF;
  v_start := public.billing_vacation_period(v_ab, p_period, v_today);
  v_end   := public.billing_next_cut(v_start, v_ab.cut_day) - 1;
  IF v_start < v_ab.starts_on THEN
    RAISE EXCEPTION 'Ese cobro todavía no corre: el cobro empieza el %', public.billing_fmt(v_ab.starts_on)
      USING ERRCODE = '22023';
  END IF;
  IF p_starts IS NULL OR p_ends IS NULL THEN
    RAISE EXCEPTION 'Faltan las fechas de las vacaciones' USING ERRCODE = '22023';
  END IF;
  IF p_starts > p_ends THEN
    RAISE EXCEPTION 'Revisa las fechas: el regreso no puede ser antes de la salida' USING ERRCODE = '22023';
  END IF;
  IF p_ends < v_start OR p_starts > v_end THEN
    RAISE EXCEPTION 'Esas fechas no caen en ese cobro (del % al %)', public.billing_fmt(v_start), public.billing_fmt(v_end)
      USING ERRCODE = '22023';
  END IF;
  IF p_trips IS NULL OR p_trips < 0 OR p_trips > 200 THEN
    RAISE EXCEPTION 'Los viajes van de 0 a 200' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_rate FROM public.billing_rate_of(p_aux);
  IF v_rate.sector_per_trip IS NULL THEN
    RAISE EXCEPTION '%', CASE
        WHEN v_admin AND v_rate.sector_name IS NULL THEN 'El tripulante no tiene sector: asígnale uno en su cuenta'
        WHEN v_admin THEN 'El sector ' || v_rate.sector_name || ' no tiene valor por viaje: cárgalo en «Tarifas por sector»'
        WHEN v_rate.sector_name IS NULL THEN 'Todavía no tienes un sector asignado para calcular el valor por viaje; escríbele a Coordinación'
        ELSE 'Tu sector todavía no tiene valor por viaje; escríbele a Coordinación' END
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_st FROM public.billing_statements
   WHERE auxiliar_profile_id = p_aux AND period_start = v_start FOR UPDATE;
  v_zero := v_st.id IS NOT NULL AND v_st.paid_at IS NOT NULL AND public.billing_statement_auto_zero(v_st.id);
  -- Pagada: no se toca. Solo el jefe reabre la que quedó saldada sola en $0.
  IF v_st.paid_at IS NOT NULL AND NOT (v_admin AND v_zero) THEN
    RAISE EXCEPTION '%', CASE
        WHEN v_zero THEN 'Ese cobro quedó en $0 por tus vacaciones sin viajes; si vas a viajar, escríbele a Coordinación'
        ELSE 'Este cobro ya está pagado: las vacaciones se marcan para el siguiente' END
      USING ERRCODE = 'P0001';
  END IF;
  IF v_st.paid_at IS NULL AND v_st.proof_state = 'review' THEN
    RAISE EXCEPTION '%', CASE WHEN v_admin THEN 'Hay un comprobante en revisión: apruébalo o recházalo primero'
                              ELSE 'Tienes un comprobante en revisión: espera a que lo revisen' END
      USING ERRCODE = 'P0001';
  END IF;
  -- Vencida o pausada: el tripulante no la cambia (primero paga o se lo arregla
  -- Coordinación). Así nadie se quita la pausa con unas vacaciones.
  IF NOT v_admin AND v_st.id IS NOT NULL AND v_st.paid_at IS NULL AND v_today > v_st.due_date THEN
    RAISE EXCEPTION 'Este cobro ya venció: págalo, o escríbele a Coordinación si estuviste de vacaciones'
      USING ERRCODE = 'P0001';
  END IF;
  -- Ni menos viajes de los que ya hizo en ese cobro.
  v_taken := public.billing_trips_taken(p_aux, v_start, v_end, v_today);
  IF NOT v_admin AND p_trips < v_taken THEN
    RAISE EXCEPTION 'Ya hiciste % en este cobro: no puedes declarar menos', public.billing_pl(v_taken, 'viaje', 'viajes')
      USING ERRCODE = '22023';
  END IF;

  -- Cambiar = la anterior queda cancelada y la nueva conserva el monto de antes
  -- (sin los viajes extra de cobros anteriores que traiga: esos se quedan).
  SELECT * INTO v_old FROM public.auxiliar_billing_vacations
   WHERE auxiliar_profile_id = p_aux AND period_start = v_start AND status = 'active' FOR UPDATE;
  v_before := CASE WHEN v_old.id IS NOT NULL THEN v_old.monthly_before_cop
                   ELSE v_st.amount_cop - public.billing_statement_extras_cop(v_st.id) END;
  IF v_old.id IS NOT NULL THEN
    UPDATE public.auxiliar_billing_vacations
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
     WHERE id = v_old.id;
  END IF;

  INSERT INTO public.auxiliar_billing_vacations (organization_id, auxiliar_profile_id, period_start, starts_on, ends_on,
                                                 trips, per_trip_cop, sector, set_by, monthly_before_cop, created_by)
  VALUES (v_ab.organization_id, p_aux, v_start, p_starts, p_ends, p_trips, v_rate.sector_per_trip,
          v_rate.sector_name, CASE WHEN v_admin THEN 'admin' ELSE 'aux' END, v_before, auth.uid())
  RETURNING * INTO v_new;

  -- La cuenta abierta pasa a valor por viaje × max(declarados, reservados) (+ los
  -- extra de cobros anteriores que traiga). Reabierta por el jefe con la fecha
  -- de pausa ya pasada: se pausa ahora (lo hace el recálculo).
  PERFORM public.billing_vacation_sync(p_aux, v_start, v_today, true);

  PERFORM public.billing_emit_vacation(v_new, CASE WHEN v_admin THEN 'vacaciones' ELSE 'admVacaciones' END);

  SELECT * INTO v_st FROM public.billing_statements WHERE auxiliar_profile_id = p_aux AND period_start = v_start;
  RETURN jsonb_build_object(
    'vacation',  public.billing_vac_json(v_new),
    'reopened',  coalesce(v_zero, false) AND v_st.paid_at IS NULL,
    'period',    public.billing_vac_period_json(p_aux, v_start, v_today),
    'statement', CASE WHEN v_st.id IS NULL THEN NULL ELSE public.billing_statement_json(v_st, v_today) END);
END;
$$;

-- Cancelar las vacaciones de un período. El tripulante, mientras la cuenta de
-- cobro no esté pagada, ni en revisión, ni vencida. El jefe siempre: si la
-- cuenta la pagó una persona no se toca (y conserva su foto de vacaciones); si
-- quedó saldada sola en $0, se reabre con la mensualidad.
CREATE OR REPLACE FUNCTION public.billing_vacation_cancel(p_aux uuid, p_period text, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today  date := public.billing_today();
  v_admin  boolean := (p_actor = 'admin');
  v_ab     public.auxiliar_billing;
  v_rate   record;
  v_start  date;
  v_st     public.billing_statements;
  v_vac    public.auxiliar_billing_vacations;
  v_amount integer;
  v_touch  boolean;
  v_zero   boolean;
BEGIN
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux FOR UPDATE;
  IF v_ab.auxiliar_profile_id IS NULL THEN
    RAISE EXCEPTION '%', CASE WHEN v_admin THEN 'El tripulante no tiene cuenta de cobro'
                              ELSE 'Todavía no tienes mensualidad registrada' END
      USING ERRCODE = 'P0002';
  END IF;
  v_start := public.billing_vacation_period(v_ab, p_period, v_today);
  SELECT * INTO v_vac FROM public.auxiliar_billing_vacations
   WHERE auxiliar_profile_id = p_aux AND period_start = v_start AND status = 'active' FOR UPDATE;
  IF v_vac.id IS NULL THEN
    RAISE EXCEPTION 'No hay vacaciones marcadas en ese cobro' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_st FROM public.billing_statements
   WHERE auxiliar_profile_id = p_aux AND period_start = v_start FOR UPDATE;
  v_zero := v_st.id IS NOT NULL AND v_st.paid_at IS NOT NULL AND public.billing_statement_auto_zero(v_st.id);
  IF NOT v_admin AND v_st.paid_at IS NOT NULL THEN
    RAISE EXCEPTION '%', CASE
        WHEN v_zero THEN 'Ese cobro quedó en $0 por tus vacaciones sin viajes; escríbele a Coordinación para cambiarlo'
        ELSE 'Este cobro ya está pagado: sus vacaciones ya no se pueden cancelar' END
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_admin AND v_st.proof_state = 'review' THEN
    RAISE EXCEPTION 'Tienes un comprobante en revisión: espera a que lo revisen' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_admin AND v_st.id IS NOT NULL AND v_st.paid_at IS NULL AND v_today > v_st.due_date THEN
    RAISE EXCEPTION 'Este cobro ya venció: escríbele a Coordinación para cambiarlo' USING ERRCODE = 'P0001';
  END IF;

  v_touch := v_st.id IS NOT NULL AND (v_st.paid_at IS NULL OR v_zero);
  IF v_touch THEN
    -- Vuelve el monto que tenía antes de las vacaciones; si no se sabe (se abrió
    -- ya con vacaciones), la mensualidad efectiva de hoy.
    SELECT * INTO v_rate FROM public.billing_rate_of(p_aux);
    v_amount := coalesce(v_vac.monthly_before_cop, v_rate.monthly);
    IF v_amount IS NULL THEN
      RAISE EXCEPTION '%', CASE WHEN v_admin THEN 'No hay mensualidad con qué reemplazarlas: cárgale su valor propio en la cuenta o la mensualidad de su sector en «Tarifas por sector»'
                                ELSE 'No hay una mensualidad con qué reemplazarlas; escríbele a Coordinación' END
        USING ERRCODE = 'P0001';
    END IF;
    -- Los viajes extra de cobros anteriores que trae esa cuenta se quedan.
    v_amount := v_amount + public.billing_statement_extras_cop(v_st.id);
  END IF;

  UPDATE public.auxiliar_billing_vacations
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
   WHERE id = v_vac.id
  RETURNING * INTO v_vac;

  IF v_touch THEN
    IF v_zero THEN v_st := public.billing_vacation_unsettle(v_st.id, v_today); END IF;
    v_st := public.billing_vacation_reprice(v_st.id, v_amount, NULL, v_today, NULL);
    IF v_st.paid_at IS NULL THEN PERFORM public.billing_block_if_due(v_st.id, v_today); END IF;
    PERFORM public.billing_refresh_pause(p_aux, v_today);
  END IF;
  -- El cargo pendiente de ese período: sin vacaciones se cancela; si la cuenta
  -- ya estaba pagada (la foto), se sigue cobrando lo de más.
  PERFORM public.billing_vacation_sync(p_aux, v_start, v_today, false);

  PERFORM public.billing_emit_vacation(v_vac, CASE WHEN v_admin THEN 'vacCancel' ELSE 'admVacCancel' END);

  SELECT * INTO v_st FROM public.billing_statements WHERE auxiliar_profile_id = p_aux AND period_start = v_start;
  RETURN jsonb_build_object(
    'vacation',          public.billing_vac_json(v_vac),
    'statementTouched',  coalesce(v_touch, false),
    'reopened',          coalesce(v_zero, false),
    'period',            public.billing_vac_period_json(p_aux, v_start, v_today),
    'statement',         CASE WHEN v_st.id IS NULL THEN NULL ELSE public.billing_statement_json(v_st, v_today) END);
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. RPC del tripulante
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aux_billing_set_vacation(p_period text, p_starts date, p_ends date, p_trips integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_aux uuid := public.current_auxiliar_id();
BEGIN
  IF v_aux IS NULL THEN RAISE EXCEPTION 'Solo el tripulante marca sus vacaciones' USING ERRCODE = '42501'; END IF;
  RETURN public.billing_vacation_set(v_aux, p_period, p_starts, p_ends, p_trips, 'aux');
END;
$$;

CREATE OR REPLACE FUNCTION public.aux_billing_cancel_vacation(p_period text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_aux uuid := public.current_auxiliar_id();
BEGIN
  IF v_aux IS NULL THEN RAISE EXCEPTION 'Solo el tripulante cancela sus vacaciones' USING ERRCODE = '42501'; END IF;
  RETURN public.billing_vacation_cancel(v_aux, p_period, 'aux');
END;
$$;

-- Los cargos pendientes de viajes extra de un tripulante (entran en su próximo
-- cobro): {trips, amountCOP, items[]}.
CREATE OR REPLACE FUNCTION public.billing_extras_pending_json(p_aux uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'trips',     coalesce(sum(x.trips), 0)::int,
    'amountCOP', coalesce(sum(x.amount_cop), 0)::int,
    'items',     coalesce(jsonb_agg(public.billing_extra_json(x) ORDER BY x.source_period_start), '[]'::jsonb))
    FROM public.billing_extra_charges x
   WHERE x.auxiliar_profile_id = p_aux AND x.applied_at IS NULL AND x.cancelled_at IS NULL;
$$;

-- Mi cuenta (0090 + mensualidad efectiva, sector, valor por viaje y vacaciones
-- de este cobro y del siguiente). NULL si no tengo mensualidad registrada.
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
  rt      record;
  v_open  integer;
  v_org   text;
  v_unread integer;
  v_cut_now  date;
  v_cut_next date;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = v_aux;
  IF ab.auxiliar_profile_id IS NULL OR NOT ab.active THEN RETURN NULL; END IF;
  SELECT * INTO cfg FROM public.billing_settings WHERE organization_id = ab.organization_id;
  SELECT * INTO rt FROM public.billing_rate_of(v_aux);
  -- La que manda: la más vieja sin pagar (es la que pausa); si no hay, la última.
  SELECT * INTO cur FROM public.billing_statements
   WHERE auxiliar_profile_id = v_aux AND paid_at IS NULL AND period_start <= v_today
   ORDER BY period_start LIMIT 1;
  IF cur.id IS NULL THEN
    SELECT * INTO cur FROM public.billing_statements
     WHERE auxiliar_profile_id = v_aux AND period_start <= v_today
     ORDER BY period_start DESC LIMIT 1;
  END IF;
  -- Sin cuenta todavía y sin valor (ni propio, ni del sector, ni uno que entre en
  -- el próximo corte): «Todavía no tienes mensualidad registrada».
  IF cur.id IS NULL AND rt.monthly IS NULL AND ab.amount_next_cop IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_open FROM public.billing_statements
   WHERE auxiliar_profile_id = v_aux AND paid_at IS NULL AND period_start <= v_today;
  SELECT name INTO v_org FROM public.organizations WHERE id = ab.organization_id;
  SELECT count(*) INTO v_unread FROM public.billing_alerts
   WHERE auxiliar_profile_id = v_aux AND audience = 'aux'
     AND (ab.alerts_seen_at IS NULL OR created_at > ab.alerts_seen_at);
  v_cut_now  := public.billing_last_cut(v_today, ab.cut_day);
  v_cut_next := public.billing_next_cut(v_today, ab.cut_day);

  RETURN jsonb_build_object(
    'auxiliarProfileId', v_aux,
    'organizationId',    ab.organization_id,
    'organizationName',  v_org,
    'reference',         ab.reference,
    'amountCOP',         rt.monthly,
    'amountNextCOP',     ab.amount_next_cop,
    'cutDay',            ab.cut_day,
    'dueDays',           coalesce(ab.due_days, cfg.due_days, 5),
    'noticeDays',        coalesce(ab.notice_days, cfg.notice_days, 2),
    'graceDays',         coalesce(ab.grace_days, cfg.grace_days, 3),
    'holderName',        cfg.holder_name,
    'holderNit',         cfg.holder_nit,
    'nextCut',           v_cut_next,
    'startsOn',          ab.starts_on,
    'paused',            public.billing_is_paused(v_aux, v_today),
    'openCount',         v_open,
    'unread',            v_unread,
    'prefs',             jsonb_build_object('push', ab.push_enabled, 'reminder', ab.reminder_enabled),
    'today',             v_today,
    'current',           CASE WHEN cur.id IS NULL THEN NULL ELSE public.billing_statement_json(cur, v_today) END
  ) || jsonb_build_object(
    -- 0094: de dónde sale la mensualidad, el sector y el valor por viaje (solo los suyos).
    'amountSource',      rt.monthly_origin,
    'sector',            rt.sector_name,
    'sectorSource',      rt.sector_origin,
    'perTripCOP',        rt.sector_per_trip,
    'currentCut',        v_cut_now,
    'vacations',         jsonb_build_object(
                           'current', public.billing_vac_period_json(v_aux, v_cut_now, v_today),
                           'next',    public.billing_vac_period_json(v_aux, v_cut_next, v_today)),
    -- 30-sep: los viajes extra de vacaciones que entran en el próximo cobro (solo los suyos).
    'extrasPending',     public.billing_extras_pending_json(v_aux)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. RPC del jefe
-- -----------------------------------------------------------------------------

-- Lista de «Cuentas de cobro» (0090 + mensualidad efectiva y de dónde sale,
-- sector y de dónde sale, tarifa del sector y vacaciones de este cobro y del
-- siguiente).
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
                  'effectiveAmountCOP', rt.monthly,
                  'amountSource', rt.monthly_origin,
                  'sectorMonthlyCOP', rt.sector_monthly,
                  -- Sin valor propio ni del sector (ni uno que entre en el próximo
                  -- corte): no se le abre cuenta de cobro.
                  'noValue', rt.monthly IS NULL AND ab.amount_next_cop IS NULL,
                  'cutDay', ab.cut_day,
                  'dueDays', ab.due_days, 'noticeDays', ab.notice_days, 'graceDays', ab.grace_days,
                  'effectiveDueDays', coalesce(ab.due_days, cfg.due_days, 5),
                  'effectiveNoticeDays', coalesce(ab.notice_days, cfg.notice_days, 2),
                  'effectiveGraceDays', coalesce(ab.grace_days, cfg.grace_days, 3),
                  'startsOn', ab.starts_on,
                  'paused', public.billing_is_paused(ap.id, v_today),
                  'nextCut', public.billing_next_cut(v_today, ab.cut_day),
                  'currentCut', public.billing_last_cut(v_today, ab.cut_day)) END,
               'openCount', (SELECT count(*) FROM public.billing_statements x
                              WHERE x.auxiliar_profile_id = ap.id AND x.paid_at IS NULL AND x.period_start <= v_today),
               'current', CASE WHEN (cur.st).id IS NULL THEN NULL ELSE public.billing_statement_json(cur.st, v_today) END,
               'proofInReview', CASE WHEN rv.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', rv.id, 'statementId', rv.statement_id, 'path', rv.storage_path,
                  'contentType', rv.content_type, 'viaLabel', rv.via_label,
                  'declaredAmountCOP', rv.declared_amount_cop,
                  'submittedAt', rv.submitted_at, 'submittedOn', rv.submitted_on) END
             ) || jsonb_build_object(
               'sector',          rt.sector_name,
               'sectorSource',    rt.sector_origin,
               'manualSector',    rt.manual_sector,
               'residenceName',   rt.res_name,
               'residenceSector', rt.res_sector,
               'sectorRate', CASE WHEN rt.sector_monthly IS NULL AND rt.sector_per_trip IS NULL THEN NULL
                                  ELSE jsonb_build_object('monthlyCOP', rt.sector_monthly, 'perTripCOP', rt.sector_per_trip) END,
               'vacation', CASE WHEN ab.auxiliar_profile_id IS NULL THEN NULL ELSE jsonb_build_object(
                  'current', public.billing_vac_period_json(ap.id, public.billing_last_cut(v_today, ab.cut_day), v_today),
                  'next',    public.billing_vac_period_json(ap.id, public.billing_next_cut(v_today, ab.cut_day), v_today)) END,
               -- 30-sep: viajes extra de vacaciones que entran en su próximo cobro.
               'extrasPending', CASE WHEN ab.auxiliar_profile_id IS NULL THEN NULL ELSE public.billing_extras_pending_json(ap.id) END
             ) AS row_j
        FROM public.auxiliar_profiles ap
        JOIN public.profiles pr ON pr.id = ap.profile_id
        LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
        LEFT JOIN public.billing_settings cfg ON cfg.organization_id = pr.organization_id
        LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
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

-- Detalle de un tripulante (0090 + sus vacaciones, también las canceladas).
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
                 FROM public.billing_payments py WHERE py.auxiliar_profile_id = p_aux),
    'vacations', (SELECT coalesce(jsonb_agg(public.billing_vac_json(v) ORDER BY v.period_start DESC, v.created_at DESC), '[]'::jsonb)
                    FROM public.auxiliar_billing_vacations v WHERE v.auxiliar_profile_id = p_aux),
    -- 30-sep: los cargos de viajes extra (pendientes y aplicados; los cancelados no).
    'extraCharges', (SELECT coalesce(jsonb_agg(public.billing_extra_json(x) ORDER BY x.source_period_start DESC), '[]'::jsonb)
                       FROM public.billing_extra_charges x WHERE x.auxiliar_profile_id = p_aux AND x.cancelled_at IS NULL)
  );
END;
$$;

-- Abrir a mano la cuenta de cobro de un corte (0090; el monto sale de la
-- mensualidad efectiva o de las vacaciones del período).
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
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Falta el valor: cárgale su valor propio en la cuenta o la mensualidad de su sector en «Tarifas por sector»'
      USING ERRCODE = '22023';
  END IF;
  -- Si se abrió con fecha vieja, que quede al día (y pausada si ya toca).
  PERFORM public.billing_block_if_due(v_id, v_today);
  SELECT * INTO s FROM public.billing_statements WHERE id = v_id;
  RETURN public.billing_statement_json(s, v_today);
END;
$$;

-- Corregir monto o aplicar un descuento (0090 tal cual + el monto no puede ser
-- $0: 0094 relajó la regla «monto > 0» de la tabla solo para las vacaciones sin
-- viajes, que se saldan solas; una cuenta de $0 abierta pausaría por nada).
-- Revisión 1-oct: el descuento que pone el jefe queda guardado también como
-- discount_requested_cop (el recálculo por vacaciones lo respeta).
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
  IF p_amount_cop IS NOT NULL AND p_amount_cop <= 0 THEN
    RAISE EXCEPTION 'El monto tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  UPDATE public.billing_statements
     SET amount_cop = coalesce(p_amount_cop, amount_cop),
         discount_cop = coalesce(p_discount_cop, discount_cop),
         discount_requested_cop = CASE WHEN p_discount_cop IS NOT NULL THEN p_discount_cop ELSE discount_requested_cop END,
         discount_note = CASE WHEN p_discount_cop IS NOT NULL OR p_discount_note IS NOT NULL THEN p_discount_note ELSE discount_note END
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN public.billing_statement_json(s, public.billing_today());
END;
$$;

-- Asignar (o quitar) a mano el sector de un tripulante. Si ya existe un sector
-- con ese nombre (en residencias o en tarifas), se guarda con su escritura.
-- Cambiar el sector no toca la cuenta de cobro ya abierta (como el monto en 0090).
CREATE OR REPLACE FUNCTION public.admin_billing_set_sector(p_aux uuid, p_sector text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid;
  v_clean text := nullif(btrim(coalesce(p_sector, '')), '');
  v_canon text;
  v_ab    public.auxiliar_billing;
  v_rate  record;
BEGIN
  SELECT pr.organization_id INTO v_org FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Tripulante no encontrado' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(v_org);
  SELECT * INTO v_ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux FOR UPDATE;
  IF v_ab.auxiliar_profile_id IS NULL THEN
    RAISE EXCEPTION 'Primero crea la cuenta de cobro del tripulante' USING ERRCODE = 'P0002';
  END IF;
  IF v_clean IS NOT NULL AND length(v_clean) > 80 THEN
    RAISE EXCEPTION 'El nombre del sector es muy largo (máximo 80)' USING ERRCODE = '22023';
  END IF;
  IF v_clean IS NOT NULL THEN
    SELECT x.nm INTO v_canon FROM (
      SELECT btrim(sr.sector) AS nm, 0 AS o FROM public.billing_sector_rates sr WHERE sr.organization_id = v_org
      UNION ALL
      SELECT btrim(r.sector), 1 FROM public.residences r WHERE r.organization_id = v_org AND nullif(btrim(r.sector), '') IS NOT NULL
    ) x WHERE lower(x.nm) = lower(v_clean) ORDER BY x.o LIMIT 1;
    v_clean := coalesce(v_canon, v_clean);
  END IF;
  UPDATE public.auxiliar_billing SET sector = v_clean, updated_by = auth.uid()
   WHERE auxiliar_profile_id = p_aux;
  SELECT * INTO v_rate FROM public.billing_rate_of(p_aux);
  RETURN jsonb_build_object(
    'sector', v_rate.sector_name, 'sectorSource', v_rate.sector_origin, 'manualSector', v_rate.manual_sector,
    'residenceName', v_rate.res_name, 'residenceSector', v_rate.res_sector,
    'monthlyCOP', v_rate.sector_monthly, 'perTripCOP', v_rate.sector_per_trip,
    'effectiveAmountCOP', v_rate.monthly, 'amountSource', v_rate.monthly_origin);
END;
$$;

-- Guardar la tarifa de un sector. Mensualidad y valor por viaje vacíos = se
-- borra la tarifa (el sector sigue existiendo si viene de las residencias).
CREATE OR REPLACE FUNCTION public.admin_billing_save_sector_rate(p_sector text, p_monthly_cop integer DEFAULT NULL,
                                                                 p_per_trip_cop integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_clean text := nullif(btrim(coalesce(p_sector, '')), '');
  v_canon text;
  v_row   public.billing_sector_rates;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF v_clean IS NULL THEN RAISE EXCEPTION 'Falta el nombre del sector' USING ERRCODE = '22023'; END IF;
  IF length(v_clean) > 80 THEN RAISE EXCEPTION 'El nombre del sector es muy largo (máximo 80)' USING ERRCODE = '22023'; END IF;
  IF (p_monthly_cop IS NOT NULL AND (p_monthly_cop <= 0 OR p_monthly_cop > 10000000))
     OR (p_per_trip_cop IS NOT NULL AND (p_per_trip_cop <= 0 OR p_per_trip_cop > 10000000)) THEN
    RAISE EXCEPTION 'Los valores van de $1 a $10.000.000' USING ERRCODE = '22023';
  END IF;
  IF p_monthly_cop IS NULL AND p_per_trip_cop IS NULL THEN
    DELETE FROM public.billing_sector_rates sr
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean);
    RETURN jsonb_build_object('sector', v_clean, 'monthlyCOP', NULL::integer, 'perTripCOP', NULL::integer, 'deleted', true);
  END IF;
  -- Con la escritura del sector de las residencias, si existe.
  SELECT btrim(r.sector) INTO v_canon FROM public.residences r
   WHERE r.organization_id = v_org AND lower(btrim(r.sector)) = lower(v_clean) LIMIT 1;
  INSERT INTO public.billing_sector_rates (organization_id, sector, monthly_cop, per_trip_cop, updated_by)
  VALUES (v_org, coalesce(v_canon, v_clean), p_monthly_cop, p_per_trip_cop, auth.uid())
  ON CONFLICT (organization_id, (lower(btrim(sector))))
  DO UPDATE SET monthly_cop = EXCLUDED.monthly_cop, per_trip_cop = EXCLUDED.per_trip_cop,
                updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'sector', v_row.sector, 'monthlyCOP', v_row.monthly_cop,
                            'perTripCOP', v_row.per_trip_cop, 'updatedAt', v_row.updated_at, 'deleted', false);
END;
$$;

-- «Tarifas por sector»: los sectores de las residencias de la organización + los
-- que ya tienen tarifa + los puestos a mano, con su tarifa y cuántos tripulantes
-- caen en cada uno (y cuántos no tienen sector). crewOwn = cuántos de ese sector
-- tienen VALOR PROPIO (hoy o desde el próximo corte): esos NO pagan la
-- mensualidad del sector, y el panel lo dice.
CREATE OR REPLACE FUNCTION public.admin_billing_sector_rates()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_list  jsonb;
  v_none  integer;
  v_total integer;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  WITH crew AS (
    SELECT ap.id AS aux_id, rt.sector_name AS sec, rt.sector_origin AS origin,
           (ab.amount_cop IS NOT NULL OR ab.amount_next_cop IS NOT NULL) AS own
      FROM public.auxiliar_profiles ap
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
      LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
     WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar'
  ), names AS (
    SELECT btrim(r.sector) AS nm, 'residence'::text AS kind FROM public.residences r
     WHERE r.organization_id = v_org AND nullif(btrim(r.sector), '') IS NOT NULL
    UNION ALL
    SELECT btrim(sr.sector), 'rate'::text FROM public.billing_sector_rates sr WHERE sr.organization_id = v_org
    UNION ALL
    SELECT c.sec, 'manual'::text FROM crew c WHERE c.sec IS NOT NULL
  ), keys AS (
    SELECT lower(n.nm) AS k, min(n.nm) AS nm, bool_or(n.kind = 'residence') AS in_res
      FROM names n GROUP BY lower(n.nm)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sector',         coalesce(btrim(sr.sector), ky.nm),
           'rateId',         sr.id,
           'monthlyCOP',     sr.monthly_cop,
           'perTripCOP',     sr.per_trip_cop,
           'updatedAt',      sr.updated_at,
           'fromResidences', ky.in_res,
           'residences',     (SELECT count(*) FROM public.residences r2
                               WHERE r2.organization_id = v_org AND lower(btrim(r2.sector)) = ky.k),
           'crew',           (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k),
           'crewManual',     (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k AND c.origin = 'manual'),
           'crewOwn',        (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k AND c.own))
           ORDER BY lower(coalesce(btrim(sr.sector), ky.nm))), '[]'::jsonb)
    INTO v_list
    FROM keys ky
    LEFT JOIN public.billing_sector_rates sr ON sr.organization_id = v_org AND lower(btrim(sr.sector)) = ky.k;

  SELECT count(*) FILTER (WHERE rt.sector_name IS NULL), count(*)
    INTO v_none, v_total
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
   WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar';

  RETURN jsonb_build_object('sectors', v_list, 'crewWithoutSector', v_none, 'crewTotal', v_total);
END;
$$;

-- «Que paguen la del sector»: quita el valor propio (el de hoy y el que entraba
-- en el próximo corte) a todos los tripulantes de un sector, para que paguen la
-- mensualidad del sector. Solo si el sector tiene mensualidad (nunca los deja
-- sin monto). No toca las cuentas de cobro ya abiertas: rige desde el próximo
-- corte. Devuelve cuántos cambió.
CREATE OR REPLACE FUNCTION public.admin_billing_use_sector_rate(p_sector text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_clean text := nullif(btrim(coalesce(p_sector, '')), '');
  v_rate  public.billing_sector_rates;
  v_n     integer;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF v_clean IS NULL THEN RAISE EXCEPTION 'Falta el nombre del sector' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_rate FROM public.billing_sector_rates sr
   WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean);
  IF v_rate.monthly_cop IS NULL THEN
    RAISE EXCEPTION 'El sector % no tiene mensualidad: cárgala primero en «Tarifas por sector»', v_clean
      USING ERRCODE = 'P0001';
  END IF;
  WITH t AS (
    SELECT ab.auxiliar_profile_id AS aux_id
      FROM public.auxiliar_billing ab
      CROSS JOIN LATERAL public.billing_rate_of(ab.auxiliar_profile_id) rt
     WHERE ab.organization_id = v_org
       AND (ab.amount_cop IS NOT NULL OR ab.amount_next_cop IS NOT NULL)
       AND lower(rt.sector_name) = lower(btrim(v_rate.sector))
  )
  UPDATE public.auxiliar_billing ab
     SET amount_cop = NULL, amount_next_cop = NULL, updated_by = auth.uid()
    FROM t
   WHERE ab.auxiliar_profile_id = t.aux_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('sector', btrim(v_rate.sector), 'monthlyCOP', v_rate.monthly_cop, 'cleared', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_billing_set_vacation(p_aux uuid, p_period text, p_starts date, p_ends date, p_trips integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT pr.organization_id INTO v_org FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux;
  PERFORM public.billing_assert_admin_of(v_org);
  RETURN public.billing_vacation_set(p_aux, p_period, p_starts, p_ends, p_trips, 'admin');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_billing_cancel_vacation(p_aux uuid, p_period text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT pr.organization_id INTO v_org FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux;
  PERFORM public.billing_assert_admin_of(v_org);
  RETURN public.billing_vacation_cancel(p_aux, p_period, 'admin');
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. El balance del mes (las cuentas de cobro que se ABRIERON en ese mes)
-- -----------------------------------------------------------------------------
-- p_month: cualquier día del mes (NULL = el mes de hoy en Bogotá).
--   totals: facturado bruto, descuentos, neto, cobrado (lo que se registró en
--     los pagos), pendiente (neto sin pagar), en revisión, en mora (vencidas o
--     pausadas, sin pagar), pausadas, # de cuentas, vacaciones y lo que suman.
--   bySector, rows (una por cuenta de cobro), payments (comprobantes y pagos de
--   esas cuentas), withoutStatement (cuentas activas sin cobro ese mes).
-- Los estados salen de billing_statement_json (0090): el front no calcula nada.
CREATE OR REPLACE FUNCTION public.admin_billing_balance(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org     uuid := public.current_user_org();
  v_today   date := public.billing_today();
  v_from    date;
  v_to      date;
  v_rows    jsonb;
  v_tot     jsonb;
  v_sec     jsonb;
  v_pay     jsonb;
  v_missing jsonb;
  v_noacc   integer;
  v_noval   integer;
  v_orgname text;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  v_from := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to   := (v_from + interval '1 month' - interval '1 day')::date;
  SELECT o.name INTO v_orgname FROM public.organizations o WHERE o.id = v_org;

  -- Una fila por cuenta de cobro abierta en el mes.
  SELECT coalesce(jsonb_agg(z.j ORDER BY z.nm, z.ps), '[]'::jsonb) INTO v_rows FROM (
    SELECT pr.full_name AS nm, s.period_start AS ps,
      jsonb_build_object(
        'statementId',       s.id,
        'auxiliarProfileId', s.auxiliar_profile_id,
        'name',              pr.full_name,
        'reference',         ab.reference,
        'sector',            rt.sector_name,
        'sectorSource',      rt.sector_origin,
        'modality',          CASE WHEN s.vacation_id IS NULL THEN 'mensual' ELSE 'vacaciones' END,
        'tripsDeclared',     vac.trips,
        'perTripCOP',        vac.per_trip_cop,
        'vacationStartsOn',  vac.starts_on,
        'vacationEndsOn',    vac.ends_on,
        'vacationStatus',    vac.status,          -- 'cancelled' = se cancelaron con la cuenta ya pagada
        'tripsBooked',       tb.booked,
        -- 30-sep, se cobra la diferencia. Cobrados = los de esta cuenta + los
        -- extra de este período ya aplicados en una cuenta siguiente.
        'tripsBilled',       CASE WHEN vac.id IS NULL THEN NULL ELSE coalesce(s.vacation_trips, vac.trips) + ex.applied_trips END,
        'extraBilledTrips',  CASE WHEN vac.id IS NULL THEN 0 ELSE greatest(0, coalesce(s.vacation_trips, vac.trips) - vac.trips) + ex.applied_trips END,
        'extraBilledCOP',    CASE WHEN vac.id IS NULL THEN 0
                                  ELSE greatest(0, coalesce(s.vacation_trips, vac.trips) - vac.trips) * vac.per_trip_cop + ex.applied_cop END,
        'extraPendingTrips', ex.pending_trips,
        'extraPendingCOP',   ex.pending_cop,
        'extraTrips',        CASE WHEN vac.id IS NULL THEN 0
                                  ELSE greatest(0, coalesce(s.vacation_trips, vac.trips) - vac.trips) + ex.applied_trips + ex.pending_trips END,
        'extraCOP',          CASE WHEN vac.id IS NULL THEN 0
                                  ELSE greatest(0, coalesce(s.vacation_trips, vac.trips) - vac.trips) * vac.per_trip_cop
                                       + ex.applied_cop + ex.pending_cop END,
        -- «Tiene extra» (la marca roja): reservó más de lo declarado y se le cobra (o se le va a cobrar).
        'overBooked',        vac.id IS NOT NULL AND greatest(0, coalesce(s.vacation_trips, vac.trips) - vac.trips) + ex.applied_trips + ex.pending_trips > 0,
        -- Lo que esta cuenta trae de cobros anteriores (ya va dentro de amountCOP).
        'extrasIncludedCOP', public.billing_statement_extras_cop(s.id),
        'extrasIncluded',    public.billing_statement_extras_json(s.id),
        'periodStart',       s.period_start,
        'periodEnd',         s.period_end,
        'dueDate',           s.due_date,
        'blockDate',         s.block_date,
        'amountCOP',         s.amount_cop,
        'discountCOP',       s.discount_cop,
        'discountNote',      s.discount_note,
        'netCOP',            s.amount_cop - s.discount_cop,
        'status',            sj.j ->> 'adminStatus',
        'base',              sj.j ->> 'base',
        'comp',              sj.j ->> 'comp',
        'blocked',           (sj.j ->> 'blocked')::boolean,
        'paid',              s.paid_at IS NOT NULL,
        'paidOn',            s.paid_on,
        'paidVia',           s.paid_via,
        'paidViaLabel',      py.via_label,
        'paidAmountCOP',     py.amount_cop,
        'paidAutomatic',     coalesce(py.automatic, false),
        'approvedBy',        apv.full_name,          -- NULL en el saldo automático («Automático»)
        'daysLate',          CASE WHEN coalesce(py.automatic, false) THEN 0
                                  WHEN s.paid_on IS NOT NULL THEN greatest(0, s.paid_on - s.due_date)
                                  ELSE greatest(0, v_today - s.due_date) END,
        'proofsCount',       (SELECT count(*) FROM public.billing_proofs bp WHERE bp.statement_id = s.id)
      ) AS j
      FROM public.billing_statements s
      JOIN public.auxiliar_profiles ap ON ap.id = s.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = s.auxiliar_profile_id
      LEFT JOIN LATERAL public.billing_rate_of(s.auxiliar_profile_id) rt ON true
      -- La foto de la cuenta (no las vacaciones activas de hoy).
      LEFT JOIN public.auxiliar_billing_vacations vac ON vac.id = s.vacation_id
      LEFT JOIN public.billing_payments py ON py.statement_id = s.id
      LEFT JOIN public.profiles apv ON apv.id = coalesce(s.paid_by, py.recorded_by)
      CROSS JOIN LATERAL (SELECT public.billing_trips_booked(s.auxiliar_profile_id, s.period_start, s.period_end) AS booked) tb
      CROSS JOIN LATERAL public.billing_period_extras(s.auxiliar_profile_id, s.period_start) ex
      CROSS JOIN LATERAL (SELECT public.billing_statement_json(s, v_today) AS j) sj
     WHERE s.organization_id = v_org AND s.period_start BETWEEN v_from AND v_to
  ) z;

  -- Totales (sobre las mismas filas).
  SELECT jsonb_build_object(
      'statements',       count(*),
      'billedGrossCOP',   coalesce(sum((e.j ->> 'amountCOP')::int), 0),
      'discountsCOP',     coalesce(sum((e.j ->> 'discountCOP')::int), 0),
      'netCOP',           coalesce(sum((e.j ->> 'netCOP')::int), 0),
      'collectedCOP',     coalesce(sum((e.j ->> 'paidAmountCOP')::int) FILTER (WHERE (e.j ->> 'paid')::boolean), 0),
      'paidCount',        count(*) FILTER (WHERE (e.j ->> 'paid')::boolean),
      'pendingCOP',       coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE NOT (e.j ->> 'paid')::boolean), 0),
      'pendingCount',     count(*) FILTER (WHERE NOT (e.j ->> 'paid')::boolean),
      'reviewCOP',        coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE e.j ->> 'status' = 'review'), 0),
      'reviewCount',      count(*) FILTER (WHERE e.j ->> 'status' = 'review'),
      'overdueCOP',       coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE NOT (e.j ->> 'paid')::boolean
                                                                      AND e.j ->> 'base' IN ('vencido', 'bloqueado')), 0),
      'overdueCount',     count(*) FILTER (WHERE NOT (e.j ->> 'paid')::boolean AND e.j ->> 'base' IN ('vencido', 'bloqueado')),
      'pausedCOP',        coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE NOT (e.j ->> 'paid')::boolean
                                                                      AND (e.j ->> 'blocked')::boolean), 0),
      'pausedCount',      count(*) FILTER (WHERE NOT (e.j ->> 'paid')::boolean AND (e.j ->> 'blocked')::boolean),
      'monthlyCount',     count(*) FILTER (WHERE e.j ->> 'modality' = 'mensual'),
      'monthlyNetCOP',    coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE e.j ->> 'modality' = 'mensual'), 0),
      'vacationsCount',   count(*) FILTER (WHERE e.j ->> 'modality' = 'vacaciones'),
      'vacationsNetCOP',  coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE e.j ->> 'modality' = 'vacaciones'), 0),
      'vacationsTripsDeclared', coalesce(sum((e.j ->> 'tripsDeclared')::int) FILTER (WHERE e.j ->> 'modality' = 'vacaciones'), 0),
      'vacationsTripsBooked',   coalesce(sum((e.j ->> 'tripsBooked')::int) FILTER (WHERE e.j ->> 'modality' = 'vacaciones'), 0),
      'overBookedCount',  count(*) FILTER (WHERE (e.j ->> 'overBooked')::boolean),
      -- 30-sep: los viajes extra de vacaciones.
      'extraBilledCOP',    coalesce(sum((e.j ->> 'extraBilledCOP')::int), 0),
      'extraPendingCOP',   coalesce(sum((e.j ->> 'extraPendingCOP')::int), 0),
      'extraCOP',          coalesce(sum((e.j ->> 'extraCOP')::int), 0),
      'extraTrips',        coalesce(sum((e.j ->> 'extraTrips')::int), 0),
      'extrasIncludedCOP', coalesce(sum((e.j ->> 'extrasIncludedCOP')::int), 0),
      'extrasIncludedCount', count(*) FILTER (WHERE (e.j ->> 'extrasIncludedCOP')::int > 0))
    INTO v_tot
    FROM jsonb_array_elements(v_rows) e(j);

  -- Por sector (NULL = «Sin sector»), con la tarifa vigente de referencia.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sector', g.sec, 'crew', g.crew, 'statements', g.n,
           'netCOP', g.net, 'collectedCOP', g.col, 'pendingCOP', g.pend,
           'vacationsCount', g.vacn, 'monthlyCOP', sr.monthly_cop, 'perTripCOP', sr.per_trip_cop)
           ORDER BY g.sec IS NULL, lower(g.sec)), '[]'::jsonb)
    INTO v_sec
    FROM (
      SELECT e.j ->> 'sector' AS sec,
             count(DISTINCT e.j ->> 'auxiliarProfileId') AS crew,
             count(*) AS n,
             coalesce(sum((e.j ->> 'netCOP')::int), 0) AS net,
             coalesce(sum((e.j ->> 'paidAmountCOP')::int) FILTER (WHERE (e.j ->> 'paid')::boolean), 0) AS col,
             coalesce(sum((e.j ->> 'netCOP')::int) FILTER (WHERE NOT (e.j ->> 'paid')::boolean), 0) AS pend,
             count(*) FILTER (WHERE e.j ->> 'modality' = 'vacaciones') AS vacn
        FROM jsonb_array_elements(v_rows) e(j)
       GROUP BY e.j ->> 'sector'
    ) g
    LEFT JOIN public.billing_sector_rates sr ON sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(g.sec);

  -- Comprobantes y pagos de esas cuentas de cobro, en orden.
  SELECT coalesce(jsonb_agg(p.j ORDER BY p.at), '[]'::jsonb) INTO v_pay FROM (
    SELECT bp.submitted_at AS at, jsonb_build_object(
             'kind', 'proof', 'at', bp.submitted_at, 'date', bp.submitted_on,
             'auxiliarProfileId', bp.auxiliar_profile_id, 'name', pr.full_name, 'reference', ab.reference,
             'periodStart', s.period_start, 'viaLabel', bp.via_label, 'amountCOP', bp.declared_amount_cop,
             'status', bp.status, 'rejectReason', bp.reject_reason,
             'reviewedAt', bp.reviewed_at, 'by', rvw.full_name, 'note', NULL::text) AS j
      FROM public.billing_proofs bp
      JOIN public.billing_statements s ON s.id = bp.statement_id
      JOIN public.auxiliar_profiles ap ON ap.id = bp.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = bp.auxiliar_profile_id
      LEFT JOIN public.profiles rvw ON rvw.id = bp.reviewed_by
     WHERE s.organization_id = v_org AND s.period_start BETWEEN v_from AND v_to
    UNION ALL
    SELECT py.created_at, jsonb_build_object(
             'kind', 'payment', 'at', py.created_at, 'date', py.paid_on,
             'auxiliarProfileId', py.auxiliar_profile_id, 'name', pr.full_name, 'reference', ab.reference,
             'periodStart', s.period_start, 'viaLabel', py.via_label, 'amountCOP', py.amount_cop,
             'status', py.source, 'rejectReason', NULL::text,
             'reviewedAt', py.created_at, 'by', rec.full_name, 'note', py.note, 'automatic', py.automatic)
      FROM public.billing_payments py
      JOIN public.billing_statements s ON s.id = py.statement_id
      JOIN public.auxiliar_profiles ap ON ap.id = py.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = py.auxiliar_profile_id
      LEFT JOIN public.profiles rec ON rec.id = py.recorded_by
     WHERE s.organization_id = v_org AND s.period_start BETWEEN v_from AND v_to
  ) p;

  -- Cuentas activas que no tienen cobro ese mes (y por qué puede ser).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'auxiliarProfileId', ap.id, 'name', pr.full_name, 'reference', ab.reference,
           'sector', rt.sector_name, 'effectiveAmountCOP', rt.monthly, 'cutDay', ab.cut_day,
           'noValue', rt.monthly IS NULL AND ab.amount_next_cop IS NULL,
           'startsOn', ab.starts_on,
           'cutThisMonth', public.billing_cut_date(extract(year FROM v_from)::int, extract(month FROM v_from)::int, ab.cut_day),
           'cutPending', public.billing_cut_date(extract(year FROM v_from)::int, extract(month FROM v_from)::int, ab.cut_day) > v_today)
           ORDER BY pr.full_name), '[]'::jsonb)
    INTO v_missing
    FROM public.auxiliar_billing ab
    JOIN public.auxiliar_profiles ap ON ap.id = ab.auxiliar_profile_id
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
   WHERE ab.organization_id = v_org AND ab.active AND pr.deleted_at IS NULL
     AND ab.starts_on <= v_to
     AND NOT EXISTS (SELECT 1 FROM public.billing_statements x
                      WHERE x.auxiliar_profile_id = ab.auxiliar_profile_id AND x.period_start BETWEEN v_from AND v_to);

  SELECT count(*) INTO v_noacc
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar'
     AND NOT EXISTS (SELECT 1 FROM public.auxiliar_billing b WHERE b.auxiliar_profile_id = ap.id);

  -- Cuentas activas SIN VALOR (ni propio ni del sector): no se les abre cobro.
  SELECT count(*) INTO v_noval
    FROM public.auxiliar_billing ab
    JOIN public.auxiliar_profiles ap ON ap.id = ab.auxiliar_profile_id
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
   WHERE ab.organization_id = v_org AND ab.active AND pr.deleted_at IS NULL
     AND rt.monthly IS NULL AND ab.amount_next_cop IS NULL;

  RETURN jsonb_build_object(
    'month',            v_from,
    'monthEnd',         v_to,
    'today',            v_today,
    'organizationName', v_orgname,
    'totals',           v_tot,
    'bySector',         v_sec,
    'rows',             v_rows,
    'payments',         v_pay,
    'withoutStatement', v_missing,
    'withoutAccount',   v_noacc,
    'withoutValue',     v_noval);
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. Permisos de las funciones
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  -- Internas: solo las otras funciones.
  FOREACH f IN ARRAY ARRAY[
    'public.billing_rate_of(uuid)',
    'public.billing_trips_booked(uuid, date, date)',
    'public.billing_trips_taken(uuid, date, date, date)',
    'public.billing_statement_auto_zero(uuid)',
    'public.billing_vac_json(public.auxiliar_billing_vacations)',
    'public.billing_vac_period_json(uuid, date, date)',
    'public.billing_vacation_settle_zero(uuid, date)',
    'public.billing_vacation_unsettle(uuid, date)',
    'public.billing_vacation_reprice(uuid, integer, uuid, date, integer)',
    'public.billing_statement_live(public.billing_statements, date)',
    'public.billing_extra_label(date, integer, integer)',
    'public.billing_statement_extras_cop(uuid)',
    'public.billing_extra_json(public.billing_extra_charges)',
    'public.billing_statement_extras_json(uuid)',
    'public.billing_period_extras(uuid, date)',
    'public.billing_extras_pending_json(uuid)',
    'public.billing_emit_vac_extra(public.auxiliar_billing_vacations, public.billing_statements, integer, integer, boolean)',
    'public.billing_vacation_sync(uuid, date, date, boolean)',
    'public.billing_reservation_vac_sync()',
    'public.billing_statement_vac_resync()',
    'public.guard_billing_cut_day_vacations()',
    'public.billing_emit_vacation(public.auxiliar_billing_vacations, text)',
    'public.billing_vacation_period(public.auxiliar_billing, text, date)',
    'public.billing_vacation_set(uuid, text, date, date, integer, text)',
    'public.billing_vacation_cancel(uuid, text, text)',
    -- las redefinidas conservan los permisos de 0090 (se repiten por si acaso)
    'public.billing_statement_json(public.billing_statements, date)',
    'public.billing_open_statement(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- De la app (cada una valida quién llama).
  FOREACH f IN ARRAY ARRAY[
    'public.aux_billing_set_vacation(text, date, date, integer)',
    'public.aux_billing_cancel_vacation(text)',
    'public.aux_billing_my_account()',
    'public.admin_billing_list()',
    'public.admin_billing_detail(uuid)',
    'public.admin_billing_open_statement(uuid, date)',
    'public.admin_billing_adjust_statement(uuid, integer, integer, text)',
    'public.admin_billing_set_sector(uuid, text)',
    'public.admin_billing_save_sector_rate(text, integer, integer)',
    'public.admin_billing_sector_rates()',
    'public.admin_billing_use_sector_rate(text)',
    'public.admin_billing_set_vacation(uuid, text, date, date, integer)',
    'public.admin_billing_cancel_vacation(uuid, text)',
    'public.admin_billing_balance(date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

COMMIT;
