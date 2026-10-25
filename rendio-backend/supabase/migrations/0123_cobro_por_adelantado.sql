-- =============================================================================
-- Migration 0123 — Cuentas de cobro por adelantado (la del próximo corte)
-- Pedido de la dueña (nota de voz del 25-oct-2026, 5:45 p. m.)
--
-- POR QUÉ
--   · «El sistema, de manera automática, el 21 abre las cuentas de cobro de todos,
--     pero a cada uno le empieza a cobrar y a contar los días de vencimiento a
--     partir de la fecha de su corte»: a los de corte 1 se les abre el 21 la cuenta
--     del 1, y el plazo y las notificaciones empiezan el 1.
--   · Abrir a mano a alguien de corte 1 que «cobra desde 1-nov» abría la de OCTUBRE
--     (el último corte que ya pasó, sin mirar «cobra desde»): vencida y pausada de
--     una vez («la del mes pasado queda vencida»). Lo que necesita es abrir la del
--     próximo corte para cargar los comprobantes de los que ya pagaron por
--     adelantado y dejarlos al día.
--
-- QUÉ HACE
--   1. billing_settings.early_open_day (21 por defecto; NULL = apagado): ese día se
--      abre a cada uno la cuenta del primer corte que cae de ese día en adelante.
--      Corte 21 → la del 21, como siempre. Corte 1 → la del 1 del mes siguiente,
--      desde el 21. billing_statements.opened_early marca las que se abrieron así.
--   2. billing_open_target (interna): la cuenta que le toca abrir HOY a un
--      tripulante: la de su último corte si ya le corre el cobro (≥ «cobra desde»)
--      y no tiene esa ni una más nueva; si no, desde el día de apertura, la del
--      próximo corte. Si no hay ninguna, el motivo.
--   3. billing_open_early (interna): abre la del próximo corte sin el aviso «está
--      lista» (sale el día del corte, con push).
--   4. billing_run_daily: además abre por adelantado y, el día del corte, manda
--      «Tu cuenta de cobro de <mes> está lista» de las que se abrieron antes (si
--      no está pagada ni con un comprobante en revisión). Lo demás, igual.
--   5. admin_billing_open_statements: abre la que le toca (2). La anticipada no se
--      pausa, no reinicia plazos ni avisa hasta su corte. Ya no abre un corte
--      anterior a «cobra desde».
--   6. admin_billing_list: la anticipada se ve como la cuenta actual (si no hay una
--      más vieja sin pagar) + openCut / openEarly / openReason para el botón.
--   7. aux_billing_my_account y aux_billing_history: el tripulante la ve, y la puede
--      pagar, desde que se abre.
--
-- Los días para pagar, el aviso, la gracia y la pausa NO cambian: siguen contando
-- desde el corte (period_start); el reloj solo avisa de cuentas cuyo período ya
-- empezó. Idempotente. Down: down_migrations/0123_cobro_por_adelantado.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El día de apertura y la marca de la cuenta anticipada
-- -----------------------------------------------------------------------------
ALTER TABLE public.billing_settings ADD COLUMN IF NOT EXISTS early_open_day smallint DEFAULT 21;
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_early_open_day;
ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_early_open_day
  CHECK (early_open_day IS NULL OR early_open_day BETWEEN 1 AND 28);
COMMENT ON COLUMN public.billing_settings.early_open_day IS
  'Día del mes en que se abre a todos la cuenta de cobro del primer corte que cae de ese día en adelante (0123; 21 = pedido de la dueña). NULL = cada uno el día de su corte.';

ALTER TABLE public.billing_statements ADD COLUMN IF NOT EXISTS opened_early boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.billing_statements.opened_early IS
  'Se abrió antes de su corte (0123). El plazo y los avisos igual cuentan desde period_start; el «está lista» sale el día del corte.';

-- -----------------------------------------------------------------------------
-- 2. La cuenta que le toca abrir hoy (interna)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_open_target(p_aux uuid, p_today date,
                                                      OUT cut date, OUT early boolean, OUT reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ab      public.auxiliar_billing;
  v_day   smallint;
  c0      date;
  w       date;
  v_last  date;
  v_first date;
BEGIN
  early := false;
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = p_aux;
  IF ab.auxiliar_profile_id IS NULL THEN reason := 'No tiene cuenta: créasela primero'; RETURN; END IF;
  IF NOT ab.active THEN reason := 'Su cuenta está apagada'; RETURN; END IF;

  -- La de su último corte: si ya le corre el cobro y no tiene esa ni una más nueva.
  c0 := public.billing_last_cut(p_today, ab.cut_day);
  IF c0 >= ab.starts_on AND NOT EXISTS (SELECT 1 FROM public.billing_statements x
                                         WHERE x.auxiliar_profile_id = p_aux AND x.period_start >= c0) THEN
    cut := c0;
    RETURN;
  END IF;

  -- Desde el día de apertura (el 21): la del primer corte que cae de ese día en
  -- adelante, si todavía no llega. Sin fila de ajustes, el 21 (el default).
  SELECT s.early_open_day INTO v_day FROM public.billing_settings s WHERE s.organization_id = ab.organization_id;
  IF NOT FOUND THEN v_day := 21; END IF;
  IF v_day IS NOT NULL THEN
    w := public.billing_next_cut(public.billing_last_cut(p_today, v_day) - 1, ab.cut_day);
    IF w > p_today AND w >= ab.starts_on
       AND NOT EXISTS (SELECT 1 FROM public.billing_statements x
                        WHERE x.auxiliar_profile_id = p_aux AND x.period_start >= w) THEN
      cut := w;
      early := true;
      RETURN;
    END IF;
  END IF;

  -- Ninguna: por qué.
  SELECT max(x.period_start) INTO v_last FROM public.billing_statements x WHERE x.auxiliar_profile_id = p_aux;
  IF v_last IS NOT NULL AND v_last >= c0 THEN
    reason := 'Ya tiene abierta la del ' || public.billing_fmt(v_last);
  ELSIF ab.starts_on > c0 THEN
    v_first := public.billing_next_cut(ab.starts_on - 1, ab.cut_day);
    reason := 'Cobra desde el ' || public.billing_fmt(ab.starts_on)
      || CASE WHEN v_day IS NOT NULL AND public.billing_last_cut(v_first, v_day) > p_today AND public.billing_last_cut(v_first, v_day) < v_first
              THEN ': se abre sola el ' || public.billing_fmt(public.billing_last_cut(v_first, v_day))
              ELSE '' END;
  ELSE
    reason := 'Ya tiene abierta la del ' || public.billing_fmt(c0);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.billing_open_target(uuid, date) IS
  '0123: la cuenta de cobro que le toca abrir hoy (cut, early) o el motivo por el que no hay ninguna.';

-- -----------------------------------------------------------------------------
-- 3. Abrir la del próximo corte (interna)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_open_early(p_aux uuid, p_cut date, p_today date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_cut <= p_today THEN
    RAISE EXCEPTION 'Esa cuenta de cobro no es del próximo corte' USING ERRCODE = '22023';
  END IF;
  v_id := public.billing_open_statement(p_aux, p_cut, p_today);
  IF v_id IS NOT NULL THEN
    UPDATE public.billing_statements SET opened_early = true WHERE id = v_id AND NOT opened_early;
    -- «Tu cuenta de cobro de <mes> está lista» sale el día del corte (billing_run_daily).
    DELETE FROM public.billing_alerts WHERE dedupe_key = 'stmt:' || v_id::text || ':generado' AND NOT pushed;
  END IF;
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. El reloj diario (0090 + 1b y 1c)
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
  t        record;
  v_cut    date;
  v_opened integer := 0;
  v_alerts integer := 0;
  v_paused integer := 0;
BEGIN
  FOR ab IN
    SELECT b.* FROM public.auxiliar_billing b
      JOIN public.auxiliar_profiles ap ON ap.id = b.auxiliar_profile_id
      JOIN public.profiles p ON p.id = ap.profile_id
     WHERE b.active AND p.deleted_at IS NULL
  LOOP
    -- 1. Abrir el período del corte vigente (una vez; nunca antes de starts_on).
    v_cut := public.billing_last_cut(v_today, ab.cut_day);
    IF v_cut >= ab.starts_on
       AND NOT EXISTS (SELECT 1 FROM public.billing_statements x
                        WHERE x.auxiliar_profile_id = ab.auxiliar_profile_id AND x.period_start = v_cut) THEN
      IF public.billing_open_statement(ab.auxiliar_profile_id, v_cut, v_today) IS NOT NULL THEN
        v_opened := v_opened + 1;
        v_alerts := v_alerts + 1;
      END IF;
    END IF;
    -- 1b. 0123: desde el día de apertura (el 21), la del próximo corte.
    SELECT * INTO t FROM public.billing_open_target(ab.auxiliar_profile_id, v_today);
    IF t.early THEN
      IF public.billing_open_early(ab.auxiliar_profile_id, t.cut, v_today) IS NOT NULL THEN
        v_opened := v_opened + 1;
      END IF;
    END IF;
  END LOOP;

  -- 1c. 0123: llegó el corte de una que se abrió antes → «está lista», con push.
  FOR s IN
    SELECT st.* FROM public.billing_statements st
      JOIN public.auxiliar_billing b ON b.auxiliar_profile_id = st.auxiliar_profile_id
     WHERE st.opened_early AND b.active AND st.paid_at IS NULL AND st.proof_state <> 'review'
       AND st.period_start <= v_today
       AND NOT EXISTS (SELECT 1 FROM public.billing_alerts a
                        WHERE a.dedupe_key = 'stmt:' || st.id::text || ':generado')
     ORDER BY st.period_start
  LOOP
    IF public.billing_emit(s, 'generado', v_today) THEN v_alerts := v_alerts + 1; END IF;
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
-- 5. Abrir varias (0115): la que le toca a cada uno
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_billing_open_statements(p_auxes uuid[], p_from_today boolean DEFAULT false,
                                                                p_notify boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org     uuid := public.current_user_org();
  v_today   date := public.billing_today();
  v_aux     uuid;
  v_name    text;
  v_reason  text;
  v_cut     date;
  v_early   boolean;
  v_id      uuid;
  t         record;
  ab        public.auxiliar_billing;
  s         public.billing_statements;
  v_opened  jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF p_auxes IS NULL OR cardinality(p_auxes) = 0 THEN
    RAISE EXCEPTION 'Elige al menos un tripulante' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_auxes) > 1000 THEN
    RAISE EXCEPTION 'Son demasiados de una vez (máximo 1000)' USING ERRCODE = '22023';
  END IF;

  FOR v_aux IN SELECT DISTINCT x FROM unnest(p_auxes) x WHERE x IS NOT NULL LOOP
    v_reason := NULL; v_id := NULL; v_name := NULL; ab := NULL; v_cut := NULL; v_early := false;
    SELECT pr.full_name INTO v_name
      FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE ap.id = v_aux AND pr.organization_id = v_org AND pr.deleted_at IS NULL;
    IF NOT FOUND THEN
      v_reason := 'No es un tripulante de tu organización';
    ELSE
      SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = v_aux;
      IF ab.auxiliar_profile_id IS NULL THEN
        v_reason := 'No tiene cuenta: créasela primero';
      ELSIF NOT ab.active THEN
        v_reason := 'Su cuenta está apagada';
      ELSE
        -- 0123: la de su corte si ya le corre el cobro; si no (o ya la tiene),
        -- desde el día de apertura la del próximo corte, por adelantado.
        SELECT * INTO t FROM public.billing_open_target(v_aux, v_today);
        IF t.cut IS NULL THEN
          v_reason := t.reason;
        ELSE
          v_cut := t.cut;
          v_early := t.early;
          BEGIN
            v_id := CASE WHEN v_early THEN public.billing_open_early(v_aux, v_cut, v_today)
                         ELSE public.billing_open_statement(v_aux, v_cut, v_today) END;
          EXCEPTION WHEN OTHERS THEN
            v_id := NULL;
            v_reason := SQLERRM;
          END;
          IF v_id IS NULL AND v_reason IS NULL THEN
            v_reason := 'Sin valor: ni propio ni de su sector';
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'auxiliarProfileId', v_aux, 'name', v_name, 'reason', v_reason));
      CONTINUE;
    END IF;

    IF v_early THEN
      -- Por adelantado: el plazo empieza en su corte y el «está lista» sale ese día.
      NULL;
    ELSIF p_from_today AND v_today > v_cut THEN
      PERFORM public.billing_restart_terms(v_id, v_today, p_notify);
    ELSE
      -- Abierta después del corte: el aviso «está lista» quedó sin push. Con
      -- «avisar», sale de nuevo (con push) con la fecha de hoy.
      IF p_notify AND EXISTS (SELECT 1 FROM public.billing_alerts a
                               WHERE a.dedupe_key = 'stmt:' || v_id::text || ':generado' AND NOT a.pushed) THEN
        DELETE FROM public.billing_alerts WHERE dedupe_key = 'stmt:' || v_id::text || ':generado';
        SELECT * INTO s FROM public.billing_statements WHERE id = v_id;
        PERFORM public.billing_emit(s, 'generado', v_today, '{}'::jsonb, NULL, true);
      END IF;
      -- Con la fecha del corte puede quedar vencida y pausada de una vez (como
      -- admin_billing_open_statement).
      PERFORM public.billing_block_if_due(v_id, v_today, p_notify);
    END IF;

    SELECT * INTO s FROM public.billing_statements WHERE id = v_id;
    v_opened := v_opened || jsonb_build_array(jsonb_build_object(
      'auxiliarProfileId', v_aux, 'name', v_name, 'statementId', s.id,
      'periodStart', s.period_start, 'dueDate', s.due_date, 'paid', s.paid_at IS NOT NULL,
      'blocked', public.billing_statement_blocked(s, v_today), 'early', v_early));
  END LOOP;

  RETURN jsonb_build_object('today', v_today, 'opened', v_opened, 'skipped', v_skipped);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. La lista del jefe (0094): la anticipada se ve, y qué abre el botón
-- -----------------------------------------------------------------------------
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
                  'currentCut', public.billing_last_cut(v_today, ab.cut_day),
                  -- 0123: lo que abre el botón «Abrir» (o por qué no hay nada que abrir).
                  'openCut', ot.cut, 'openEarly', coalesce(ot.early, false), 'openReason', ot.reason,
                  'earlyOpenDay', CASE WHEN cfg.organization_id IS NULL THEN 21 ELSE cfg.early_open_day END) END,
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
        -- La que manda: la más vieja sin pagar (también una abierta por adelantado,
        -- 0123); si no hay ninguna sin pagar, la más reciente.
        LEFT JOIN LATERAL (
          SELECT st FROM public.billing_statements st
           WHERE st.auxiliar_profile_id = ap.id
           ORDER BY (st.paid_at IS NULL) DESC,
                    CASE WHEN st.paid_at IS NULL THEN st.period_start END ASC,
                    st.period_start DESC
           LIMIT 1) cur ON true
        LEFT JOIN LATERAL (
          SELECT bp.* FROM public.billing_proofs bp
           WHERE bp.auxiliar_profile_id = ap.id AND bp.status = 'review'
           ORDER BY bp.submitted_at LIMIT 1) rv ON true
        LEFT JOIN LATERAL public.billing_open_target(ap.id, v_today) ot ON ab.auxiliar_profile_id IS NOT NULL
       WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar'
    ) t
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. El tripulante (0094 / 0090): la ve y la puede pagar desde que se abre
-- -----------------------------------------------------------------------------
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
  -- La que manda: la más vieja sin pagar (es la que pausa; también una abierta por
  -- adelantado, 0123); si no hay, la última.
  SELECT * INTO cur FROM public.billing_statements
   WHERE auxiliar_profile_id = v_aux AND paid_at IS NULL
   ORDER BY period_start LIMIT 1;
  IF cur.id IS NULL THEN
    SELECT * INTO cur FROM public.billing_statements
     WHERE auxiliar_profile_id = v_aux
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

CREATE OR REPLACE FUNCTION public.aux_billing_history()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- 0123: también la abierta por adelantado (antes: solo period_start <= hoy).
  SELECT coalesce(jsonb_agg(
           public.billing_statement_json(s, public.billing_today())
           || jsonb_build_object(
                'daysLate', CASE WHEN s.paid_on IS NOT NULL THEN greatest(0, s.paid_on - s.due_date) END,
                'approverLabel', CASE WHEN s.paid_at IS NOT NULL THEN 'Admin · ' || o.name END)
           ORDER BY s.period_start DESC), '[]'::jsonb)
    FROM public.billing_statements s
    JOIN public.organizations o ON o.id = s.organization_id
   WHERE s.auxiliar_profile_id = public.current_auxiliar_id();
$$;

-- -----------------------------------------------------------------------------
-- 8. Permisos: las dos nuevas son internas
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.billing_open_target(uuid, date) FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION public.billing_open_early(uuid, date, date) FROM PUBLIC, anon, authenticated';
END
$do$;

COMMIT;
