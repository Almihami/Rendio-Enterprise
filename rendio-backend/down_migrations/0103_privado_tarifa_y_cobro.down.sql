-- =============================================================================
-- Down de 0103 — deshace la tarifa de $50.000, el cobro del privado en la
-- cuenta de cobro y el apagado de «Directo».
--
-- Ojo con la plata: las líneas de privado que estaban dentro de una cuenta SIN
-- PAGAR se restan de esa cuenta (vuelve al monto sin el privado); en una cuenta
-- ya pagada la cuenta no se toca (no se des-paga nada) y la línea desaparece.
-- Después se borran todas las líneas de privado (no existían antes de 0103).
-- Las funciones vuelven a su definición de 0094, copiadas tal cual.
-- La tarifa vuelve al default 150000 y las filas en 50000 vuelven a 150000.
-- =============================================================================

BEGIN;

-- 1. Las líneas de privado fuera de las cuentas sin pagar, y fuera de la tabla.
WITH p AS (
  SELECT x.applied_statement_id AS sid, sum(x.amount_cop)::int AS amt
    FROM public.billing_extra_charges x
   WHERE x.kind = 'private' AND x.applied_statement_id IS NOT NULL AND x.cancelled_at IS NULL
   GROUP BY 1)
UPDATE public.billing_statements s
   SET amount_cop   = greatest(0, s.amount_cop - p.amt),
       discount_cop = least(s.discount_cop, greatest(0, s.amount_cop - p.amt))
  FROM p
 WHERE s.id = p.sid AND s.paid_at IS NULL;
DELETE FROM public.billing_extra_charges WHERE kind = 'private';

-- 2. Triggers de 0103 (y el de vacaciones vuelve al de 0094).
DROP TRIGGER IF EXISTS tr_reservations_billing_private_ins ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_billing_private_upd ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_billing_private_del ON public.reservations;
DROP TRIGGER IF EXISTS tr_reservations_private_price_fill ON public.reservations;
DROP TRIGGER IF EXISTS tr_billing_statements_private_resync ON public.billing_statements;
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

-- 3. Las funciones redefinidas vuelven a 0094 (texto de 0094 tal cual).

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

-- 4. Las funciones nuevas de 0103.
DROP FUNCTION IF EXISTS public.billing_statement_private_resync();
DROP FUNCTION IF EXISTS public.billing_reservation_private_delete();
DROP FUNCTION IF EXISTS public.billing_reservation_private_sync();
DROP FUNCTION IF EXISTS public.billing_private_sync(uuid, date, boolean);
DROP FUNCTION IF EXISTS public.billing_private_unplace(uuid, date);
DROP FUNCTION IF EXISTS public.billing_private_apply(uuid, uuid, date);
DROP FUNCTION IF EXISTS public.billing_private_target(uuid, date, date);
DROP FUNCTION IF EXISTS public.billing_statement_kind_json(uuid, text);
DROP FUNCTION IF EXISTS public.billing_statement_kind_cop(uuid, text);
DROP FUNCTION IF EXISTS public.billing_private_label(date, integer);
DROP FUNCTION IF EXISTS public.reservations_private_price_fill();

-- 5. billing_extra_charges vuelve a 0094.
DROP INDEX IF EXISTS public.uq_billing_extra_charges_reservation;
DROP INDEX IF EXISTS public.uq_billing_extra_charges_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_extra_charges_pending
  ON public.billing_extra_charges(auxiliar_profile_id, source_period_start)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_private_shape;
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_kind;
ALTER TABLE public.billing_extra_charges
  DROP COLUMN IF EXISTS trip_on,
  DROP COLUMN IF EXISTS reservation_id,
  DROP COLUMN IF EXISTS kind;

-- 6. «Directo» vuelve como estaba (encendido y «Pronto»: no se canjea igual).
ALTER TABLE public.aux_points_rewards DROP CONSTRAINT IF EXISTS aux_points_rewards_no_direct;
UPDATE public.aux_points_rewards SET enabled = true WHERE kind = 'direct_trip' AND NOT enabled;

-- 7. La tarifa y los comentarios de 0069.
ALTER TABLE public.app_settings ALTER COLUMN aux_private_price_cop SET DEFAULT 150000;
UPDATE public.app_settings SET aux_private_price_cop = 150000 WHERE aux_private_price_cop = 50000;
COMMENT ON COLUMN public.app_settings.aux_private_price_cop IS
  'Tarifa del traslado privado, en pesos. El 150000 del default es un VALOR PROVISIONAL puesto por quien implementó la pantalla, no una tarifa acordada por la operación: hay que reemplazarlo.';
COMMENT ON COLUMN public.reservations.price_cop IS
  'Precio en pesos que se le mostró al auxiliar al pedir. Congelado: NO se recalcula si cambia la tarifa. Informativo — no hay cobro en la app.';

COMMIT;
