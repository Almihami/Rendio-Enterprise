-- =============================================================================
-- Down 0123 — Cuentas de cobro por adelantado
-- Devuelve las cinco funciones a su versión anterior (copiadas tal cual de 0090,
-- 0094 y 0115) y quita billing_open_target, billing_open_early, la marca
-- opened_early y el día de apertura. Las cuentas que se abrieron por adelantado
-- NO se borran: quedan como cuentas normales de su corte (el reloj viejo no les
-- vuelve a abrir otra del mismo período; el «está lista» que no salió, no sale).
-- =============================================================================

BEGIN;

-- billing_run_daily (de 0090_facturario.sql)
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

-- admin_billing_open_statements (de 0115_cobro_abrir_varias_y_comprobante_del_jefe.sql)
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
  v_id      uuid;
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
    v_reason := NULL; v_id := NULL; v_name := NULL; ab := NULL;
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
        v_cut := public.billing_last_cut(v_today, ab.cut_day);
        IF EXISTS (SELECT 1 FROM public.billing_statements x
                    WHERE x.auxiliar_profile_id = v_aux AND x.period_start >= v_cut) THEN
          v_reason := 'Ya tiene abierta la del ' || public.billing_fmt(v_cut);
        ELSE
          BEGIN
            v_id := public.billing_open_statement(v_aux, v_cut, v_today);
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

    IF p_from_today AND v_today > v_cut THEN
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
      'blocked', public.billing_statement_blocked(s, v_today)));
  END LOOP;

  RETURN jsonb_build_object('today', v_today, 'opened', v_opened, 'skipped', v_skipped);
END;
$$;

-- admin_billing_list (de 0094_tarifas_sector_vacaciones.sql)
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

-- aux_billing_my_account (de 0094_tarifas_sector_vacaciones.sql)
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

-- aux_billing_history (de 0090_facturario.sql)
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

DROP FUNCTION IF EXISTS public.billing_open_early(uuid, date, date);
DROP FUNCTION IF EXISTS public.billing_open_target(uuid, date);
ALTER TABLE public.billing_statements DROP COLUMN IF EXISTS opened_early;
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_early_open_day;
ALTER TABLE public.billing_settings DROP COLUMN IF EXISTS early_open_day;

COMMIT;
