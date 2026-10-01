-- =============================================================================
-- DOWN de 0094 — Tarifas por sector, vacaciones y balance del mes
--
-- OJO: BORRA DATOS. Se pierden las tarifas por sector, las vacaciones marcadas
-- (también las canceladas), el sector puesto a mano en cada cuenta, los cargos
-- de viajes extra (pendientes y aplicados) y los avisos de vacaciones del
-- Centro. Los avisos ya encolados en notification_outbox quedan (son de 0063) y
-- se envían igual.
--
-- Las cuentas de cobro NO se tocan: las que se recalcularon por vacaciones (o
-- que traen viajes extra de un cobro anterior) se quedan con el monto que
-- tenían; se pierde la foto de con qué vacaciones y cuántos viajes se cobraron
-- (billing_statements.vacation_id y vacation_trips), qué viajes extra trae cada
-- una, el descuento que había puesto el jefe cuando el aplicado quedó recortado
-- (discount_requested_cop: queda el aplicado) y la marca de pago automático
-- (billing_payments.automatic). Se quitan los triggers de la revisión 1-oct (el
-- recálculo al rechazar un comprobante y el candado del día de corte). La
-- mensualidad por defecto de la organización vuelve a usarse (0090).
-- La TRANSICIÓN de 0094 (a quien se cobraba con la mensualidad por defecto se le
-- puso como valor propio) NO se deshace: con 0090 da lo mismo
-- (coalesce(amount_cop, default_amount_cop)) mientras no cambie el por defecto;
-- quien lo quiera de vuelta en el por defecto, que le quite el valor propio. Si hay cuentas de $0
-- (vacaciones sin viajes), la regla de 0090 «monto > 0» vuelve como NOT VALID
-- (no revisa las filas viejas, sí las nuevas).
--
-- Restituye TAL CUAL las funciones de 0090 que 0094 redefinió (copiadas de
-- 0090_facturario.sql sin cambios).
-- =============================================================================

BEGIN;

-- Revisión 1-oct: el recálculo al salir de revisión y el candado del día de corte.
DROP TRIGGER IF EXISTS tr_billing_statements_vac_resync ON public.billing_statements;
DROP FUNCTION IF EXISTS public.billing_statement_vac_resync();
DROP TRIGGER IF EXISTS tr_auxiliar_billing_cut_day_vac ON public.auxiliar_billing;
DROP FUNCTION IF EXISTS public.guard_billing_cut_day_vacations();

-- Se cobra la diferencia (30-sep): el trigger de reservations y sus funciones.
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_ins ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_upd ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_del ON public.reservations;
DROP FUNCTION IF EXISTS public.billing_reservation_vac_sync();
DROP FUNCTION IF EXISTS public.billing_vacation_sync(uuid, date, date, boolean);
DROP FUNCTION IF EXISTS public.billing_emit_vac_extra(public.auxiliar_billing_vacations, public.billing_statements, integer, integer, boolean);
DROP FUNCTION IF EXISTS public.billing_extras_pending_json(uuid);

DROP FUNCTION IF EXISTS public.admin_billing_balance(date);
DROP FUNCTION IF EXISTS public.admin_billing_cancel_vacation(uuid, text);
DROP FUNCTION IF EXISTS public.admin_billing_set_vacation(uuid, text, date, date, integer);
DROP FUNCTION IF EXISTS public.admin_billing_sector_rates();
DROP FUNCTION IF EXISTS public.admin_billing_save_sector_rate(text, integer, integer);
DROP FUNCTION IF EXISTS public.admin_billing_set_sector(uuid, text);
DROP FUNCTION IF EXISTS public.aux_billing_cancel_vacation(text);
DROP FUNCTION IF EXISTS public.aux_billing_set_vacation(text, date, date, integer);
DROP FUNCTION IF EXISTS public.billing_vacation_cancel(uuid, text, text);
DROP FUNCTION IF EXISTS public.billing_vacation_set(uuid, text, date, date, integer, text);
DROP FUNCTION IF EXISTS public.billing_vacation_period(public.auxiliar_billing, text, date);
DROP FUNCTION IF EXISTS public.billing_emit_vacation(public.auxiliar_billing_vacations, text);
DROP FUNCTION IF EXISTS public.billing_vacation_reprice(uuid, integer, uuid, date, integer);
DROP FUNCTION IF EXISTS public.billing_vacation_reprice(uuid, integer, uuid, date);
DROP FUNCTION IF EXISTS public.billing_vacation_reprice(uuid, integer, date);
DROP FUNCTION IF EXISTS public.billing_vacation_unsettle(uuid, date);
DROP FUNCTION IF EXISTS public.billing_vacation_settle_zero(uuid, date);
DROP FUNCTION IF EXISTS public.admin_billing_use_sector_rate(text);

-- Las de 0090, como eran.
-- billing_statement_json (tal cual 0090)
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

-- billing_open_statement (tal cual 0090)
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

-- aux_billing_my_account (tal cual 0090)
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

-- admin_billing_list (tal cual 0090)
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

-- admin_billing_detail (tal cual 0090)
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

-- admin_billing_open_statement (tal cual 0090)
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

-- admin_billing_adjust_statement (tal cual 0090)
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

DROP FUNCTION IF EXISTS public.billing_vac_period_json(uuid, date, date);
DROP FUNCTION IF EXISTS public.billing_period_extras(uuid, date);
DROP FUNCTION IF EXISTS public.billing_statement_extras_json(uuid);
DROP FUNCTION IF EXISTS public.billing_extra_json(public.billing_extra_charges);
DROP FUNCTION IF EXISTS public.billing_statement_extras_cop(uuid);
DROP FUNCTION IF EXISTS public.billing_extra_label(date, integer, integer);
DROP FUNCTION IF EXISTS public.billing_statement_live(public.billing_statements, date);
DROP FUNCTION IF EXISTS public.billing_vac_json(public.auxiliar_billing_vacations);
DROP FUNCTION IF EXISTS public.billing_statement_auto_zero(uuid);
DROP FUNCTION IF EXISTS public.billing_trips_taken(uuid, date, date, date);
DROP FUNCTION IF EXISTS public.billing_trips_booked(uuid, date, date);
DROP FUNCTION IF EXISTS public.billing_rate_of(uuid);

-- Avisos: fuera los de vacaciones; vuelven la lista de claves y el NOT NULL.
DELETE FROM public.billing_alerts WHERE key IN ('vacaciones', 'vacCancel', 'admVacaciones', 'admVacCancel', 'vacExtra');
DELETE FROM public.billing_alerts WHERE statement_id IS NULL;
ALTER TABLE public.billing_alerts DROP CONSTRAINT IF EXISTS billing_alerts_key;
ALTER TABLE public.billing_alerts ADD CONSTRAINT billing_alerts_key CHECK (key IN (
  'generado', 'recordatorio', 'venceHoy', 'vencido', 'ultimoDia', 'bloqueado',
  'recibido', 'aprobado', 'rechazado', 'admRevisar', 'admMora', 'admBloqueado'));
ALTER TABLE public.billing_alerts ALTER COLUMN statement_id SET NOT NULL;

-- «Monto > 0» de 0090 (NOT VALID si quedaron cuentas de $0).
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_amounts;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.billing_statements WHERE amount_cop = 0) THEN
    ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_amounts
      CHECK (amount_cop > 0 AND discount_cop >= 0 AND discount_cop <= amount_cop) NOT VALID;
    RAISE NOTICE 'Hay cuentas de cobro de $0 (vacaciones sin viajes): la regla vuelve como NOT VALID.';
  ELSE
    ALTER TABLE public.billing_statements ADD CONSTRAINT billing_statements_amounts
      CHECK (amount_cop > 0 AND discount_cop >= 0 AND discount_cop <= amount_cop);
  END IF;
END
$do$;

-- La foto de vacaciones de cada cuenta y la marca de pago automático (los
-- pagos automáticos de $0 se quedan como pagos a mano de $0).
DROP TABLE IF EXISTS public.billing_extra_charges;
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_vacation_trips;
ALTER TABLE public.billing_statements DROP COLUMN IF EXISTS vacation_trips;
ALTER TABLE public.billing_statements DROP CONSTRAINT IF EXISTS billing_statements_discount_requested;
ALTER TABLE public.billing_statements DROP COLUMN IF EXISTS discount_requested_cop;
ALTER TABLE public.billing_statements DROP COLUMN IF EXISTS vacation_id;
ALTER TABLE public.billing_payments DROP COLUMN IF EXISTS automatic;

DROP TABLE IF EXISTS public.auxiliar_billing_vacations;
DROP TABLE IF EXISTS public.billing_sector_rates;
ALTER TABLE public.auxiliar_billing DROP CONSTRAINT IF EXISTS auxiliar_billing_sector_ok;
ALTER TABLE public.auxiliar_billing DROP COLUMN IF EXISTS sector;

COMMIT;
