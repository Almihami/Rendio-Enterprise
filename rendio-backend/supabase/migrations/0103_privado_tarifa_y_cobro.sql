-- =============================================================================
-- Migration 0103 — El privado: tarifa de $50.000, se cobra en la cuenta de
-- cobro, y el nivel «Directo» sale de la vitrina.
-- Decisiones de la dueña (12-oct-2026) sobre el traslado privado (0069) y el
-- facturario (0090 · 0094).
--
-- QUÉ HACE
--   1. VALOR DEL PRIVADO = $50.000. El default de app_settings.aux_private_price_cop
--      pasa de 150000 (un valor provisional, ver 0069) a 50000, y las filas que
--      seguían con ese 150000 quedan en 50000. Una tarifa distinta que alguien ya
--      haya puesto a mano NO se toca. El precio se sigue congelando por reserva
--      (reservations.price_cop, 0069): cambiar la tarifa no reescribe lo pedido.
--   2. «DIRECTO» SE QUITA. El canje «Un traslado Directo» (aux_points_rewards,
--      kind 'direct_trip', 0091) queda APAGADO (enabled = false) y un CHECK
--      impide volver a encenderlo: ese nivel no existe. La fila se conserva (no
--      se borra historia; ningún canje la usó: siempre fue «Pronto»).
--   3. EL PRIVADO APROBADO SE COBRA EN LA CUENTA DE COBRO, como una línea más:
--        · Reusa billing_extra_charges (0094), con kind = 'private' y la reserva
--          (reservation_id, UNA fila por reserva). Monto = trips (1) × per_trip_cop
--          (= reservations.price_cop, el precio congelado). Así entra en el total
--          igual que los viajes extra de vacaciones: billing_statement_extras_cop
--          lo suma, billing_statement_json lo trae en `extras` (con `kind` y la
--          etiqueta «Traslado privado · 14 de oct · $50.000») y todo el cálculo de
--          vacaciones lo respeta como «lo que va aparte».
--        · CUÁNDO: al APROBARLO (decisión de la dueña), en la cuenta del MES DEL
--          VIAJE: la cuenta de cobro cuyas fechas contienen el día del viaje
--          (hora de Bogotá).
--        · REGLA DE CARGOS TARDÍOS (la de 0094 para los viajes extra): la línea
--          entra YA en la cuenta solo si esa cuenta está VIVA
--          (billing_statement_live: sin pagar —o saldada sola en $0—, sin
--          comprobante en revisión, sin pasar su fecha límite ni el fin del
--          período). Si no lo está (pagada, en revisión, vencida, cerrada) queda
--          PENDIENTE y entra como línea aparte en la siguiente cuenta viva: la
--          que esté abierta ahora (si su período es posterior al viaje) o la que
--          abra el reloj. Un viaje de un mes que todavía no abre espera a SU
--          cuenta. Nunca se cambia en silencio una cuenta pagada.
--        · SI SE CANCELA O SE RECHAZA, la línea sale sola: pendiente se anula; en
--          una cuenta SIN PAGAR (también vencida o pausada: solo baja lo que
--          debe) se resta. En una cuenta PAGADA por una persona se queda (no hay
--          saldo a favor ni devolución automática: lo arregla Coordinación con un
--          descuento en la siguiente). En una cuenta EN REVISIÓN espera: si el
--          comprobante se rechaza, se recalcula en ese momento (trigger, como en
--          0094); si se aprueba, se queda.
--        · Cambiar la fecha, el precio o el tripulante de un privado aprobado =
--          la línea vieja sale (si se puede) y entra la nueva.
--        · Los privados aprobados ANTES de esta migración NO se cobran (la regla
--          entonces era «no se cobra en la app»): solo crea línea una aprobación
--          nueva (cambio de private_status) o un privado creado ya aprobado.
--        · Si un jefe crea un privado sin precio (guard_private_insert no se lo
--          pone a un admin), al aprobarlo se congela la tarifa vigente.
--        · Un error del facturario NUNCA frena la reserva (regla de 0094): queda
--          en el log (WARNING).
--   4. LOS PRIVADOS NO CUENTAN COMO VIAJES DE VACACIONES. billing_trips_booked
--      (0094) deja fuera la reserva que tiene su línea de privado activa: se
--      cobra una vez, como privado, y no otra vez × valor por viaje. Un privado
--      pedido (sin decidir) o rechazado sale en compartido y sí cuenta.
--   5. PANTALLAS (la base sigue calculando): billing_extra_json trae `kind`,
--      `reservationId` y `tripOn`; billing_extras_pending_json separa lo de
--      vacaciones (trips · amountCOP · items, igual que antes) de lo de privados
--      (`private`: count · amountCOP · items) y suma `totalCOP`; el balance del
--      mes (admin_billing_balance) separa los privados (`privateCOP`,
--      `privateCount`, `privateIncluded`) de los viajes extra de vacaciones
--      (`extrasIncludedCOP` vuelve a ser solo eso).
--
-- Redefine (partiendo de su ÚLTIMA definición, la de 0094, sin quitar nada):
--   billing_trips_booked · billing_period_extras · billing_extra_json ·
--   billing_statement_extras_json · billing_extras_pending_json ·
--   billing_vacation_sync (sus consultas de cargos pasan a kind = 'vacation') ·
--   billing_open_statement (además toma los privados pendientes) ·
--   admin_billing_balance. Rehace el trigger tr_reservations_billing_vac_upd
--   (también recuenta al aprobar o des-aprobar un privado).
-- NO toca: admin_decide_private (0069), billing_statement_json, la RPC del
-- tripulante ni la del jefe: todo entra por triggers y por las funciones de
-- arriba.
--
-- Idempotente. SECURITY DEFINER con search_path fijo. Sin tocar migraciones
-- anteriores. Down: down_migrations/0103_privado_tarifa_y_cobro.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Valor del privado: $50.000
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings ALTER COLUMN aux_private_price_cop SET DEFAULT 50000;
-- Solo las filas que seguían con el valor provisional de 0069.
UPDATE public.app_settings SET aux_private_price_cop = 50000 WHERE aux_private_price_cop = 150000;

COMMENT ON COLUMN public.app_settings.aux_private_price_cop IS
  'Tarifa del traslado privado por trayecto, en pesos (0103: $50.000, decisión de la dueña). Se le muestra al tripulante al pedir, se congela en reservations.price_cop y, al aprobarse, se suma a su cuenta de cobro.';
COMMENT ON COLUMN public.reservations.price_cop IS
  'Precio en pesos del privado, congelado al pedir (o al aprobar, si un jefe lo creó sin precio). NO se recalcula si cambia la tarifa. Desde 0103 se cobra: al aprobarse entra como línea en la cuenta de cobro del tripulante (billing_extra_charges, kind = private).';

-- Un jefe que crea (o aprueba) un privado sin precio: se congela la tarifa
-- vigente al aprobar. Va DESPUÉS de los guardias de 0069 (orden alfabético de
-- los BEFORE: tr_guard_private_* < tr_reservations_private_price_fill).
CREATE OR REPLACE FUNCTION public.reservations_private_price_fill()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.service_level = 'private' AND NEW.private_status = 'approved' AND NEW.price_cop IS NULL THEN
    SELECT s.aux_private_price_cop INTO NEW.price_cop FROM public.app_settings s LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_private_price_fill ON public.reservations;
CREATE TRIGGER tr_reservations_private_price_fill
  BEFORE INSERT OR UPDATE OF service_level, private_status, price_cop ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.reservations_private_price_fill();

-- -----------------------------------------------------------------------------
-- 2. «Directo» sale de la vitrina de Puntos
-- -----------------------------------------------------------------------------
UPDATE public.aux_points_rewards SET enabled = false WHERE kind = 'direct_trip' AND enabled;
ALTER TABLE public.aux_points_rewards DROP CONSTRAINT IF EXISTS aux_points_rewards_no_direct;
ALTER TABLE public.aux_points_rewards ADD CONSTRAINT aux_points_rewards_no_direct
  CHECK (kind <> 'direct_trip' OR NOT enabled);
COMMENT ON CONSTRAINT aux_points_rewards_no_direct ON public.aux_points_rewards IS
  '0103: el nivel Directo no existe (decisión de la dueña, 12-oct-2026): su canje no se puede encender.';

-- -----------------------------------------------------------------------------
-- 3. La línea del privado en billing_extra_charges
-- -----------------------------------------------------------------------------
ALTER TABLE public.billing_extra_charges
  ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'vacation',
  ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trip_on        date;

ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_kind;
ALTER TABLE public.billing_extra_charges ADD CONSTRAINT billing_extra_charges_kind
  CHECK (kind IN ('vacation', 'private'));
-- Un privado es UN trayecto con su día; no viene de unas vacaciones.
ALTER TABLE public.billing_extra_charges DROP CONSTRAINT IF EXISTS billing_extra_charges_private_shape;
ALTER TABLE public.billing_extra_charges ADD CONSTRAINT billing_extra_charges_private_shape
  CHECK (kind = 'vacation' OR (trips = 1 AND trip_on IS NOT NULL AND vacation_id IS NULL));

-- El «uno pendiente por tripulante y período» de 0094 es de los viajes extra de
-- vacaciones: dos privados del mismo mes son dos líneas.
DROP INDEX IF EXISTS public.uq_billing_extra_charges_pending;
CREATE UNIQUE INDEX uq_billing_extra_charges_pending
  ON public.billing_extra_charges(auxiliar_profile_id, source_period_start)
  WHERE kind = 'vacation' AND applied_at IS NULL AND cancelled_at IS NULL;
-- UNA fila por reserva (aprobar dos veces, o volver a aprobar, la reusa).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_extra_charges_reservation
  ON public.billing_extra_charges(reservation_id)
  WHERE kind = 'private';

COMMENT ON COLUMN public.billing_extra_charges.kind IS
  '0103: vacation = viajes de vacaciones de más (0094) · private = un traslado privado aprobado (una fila por reserva).';
COMMENT ON COLUMN public.billing_extra_charges.reservation_id IS
  '0103: la reserva del privado (kind = private). NULL en los de vacaciones, o si la reserva se borró.';
COMMENT ON COLUMN public.billing_extra_charges.trip_on IS
  '0103: día del viaje del privado (hora de Bogotá). Define el mes en que se cobra.';

-- -----------------------------------------------------------------------------
-- 4. Formas para las pantallas
-- -----------------------------------------------------------------------------
-- «Traslado privado · 14 de oct · $50.000» (los formatos del facturario: cbFmt, cbMoney)
CREATE OR REPLACE FUNCTION public.billing_private_label(p_trip_on date, p_amount integer)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT 'Traslado privado · ' || public.billing_fmt(p_trip_on) || ' · ' || public.billing_money(p_amount);
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
    -- 0103: de qué es la línea (vacation | private), y para el privado su reserva y su día.
    'kind',              p_x.kind,
    'reservationId',     p_x.reservation_id,
    'tripOn',            p_x.trip_on,
    'label',             CASE WHEN p_x.kind = 'private'
                              THEN public.billing_private_label(p_x.trip_on, p_x.amount_cop)
                              ELSE public.billing_extra_label(p_x.source_period_start, p_x.trips, p_x.per_trip_cop) END);
$$;

CREATE OR REPLACE FUNCTION public.billing_statement_extras_json(p_st_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(public.billing_extra_json(x)
                            ORDER BY x.source_period_start, x.trip_on NULLS FIRST, x.created_at), '[]'::jsonb)
    FROM public.billing_extra_charges x
   WHERE x.applied_statement_id = p_st_id AND x.cancelled_at IS NULL;
$$;

-- Lo que una cuenta de cobro trae de un tipo de línea (para el balance).
CREATE OR REPLACE FUNCTION public.billing_statement_kind_cop(p_st_id uuid, p_kind text)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(x.amount_cop), 0)::int
    FROM public.billing_extra_charges x
   WHERE x.applied_statement_id = p_st_id AND x.cancelled_at IS NULL AND x.kind = p_kind;
$$;

CREATE OR REPLACE FUNCTION public.billing_statement_kind_json(p_st_id uuid, p_kind text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(public.billing_extra_json(x)
                            ORDER BY x.source_period_start, x.trip_on NULLS FIRST, x.created_at), '[]'::jsonb)
    FROM public.billing_extra_charges x
   WHERE x.applied_statement_id = p_st_id AND x.cancelled_at IS NULL AND x.kind = p_kind;
$$;

-- Lo pendiente (todavía en ninguna cuenta). trips · amountCOP · items siguen
-- siendo SOLO los viajes extra de vacaciones (como en 0094); los privados van
-- en `private`, y `totalCOP` suma las dos cosas.
CREATE OR REPLACE FUNCTION public.billing_extras_pending_json(p_aux uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'trips',     coalesce(sum(x.trips) FILTER (WHERE x.kind = 'vacation'), 0)::int,
    'amountCOP', coalesce(sum(x.amount_cop) FILTER (WHERE x.kind = 'vacation'), 0)::int,
    'items',     coalesce(jsonb_agg(public.billing_extra_json(x) ORDER BY x.source_period_start)
                            FILTER (WHERE x.kind = 'vacation'), '[]'::jsonb),
    'private',   jsonb_build_object(
                   'count',     count(*) FILTER (WHERE x.kind = 'private'),
                   'amountCOP', coalesce(sum(x.amount_cop) FILTER (WHERE x.kind = 'private'), 0)::int,
                   'items',     coalesce(jsonb_agg(public.billing_extra_json(x) ORDER BY x.trip_on, x.created_at)
                                           FILTER (WHERE x.kind = 'private'), '[]'::jsonb)),
    'totalCOP',  coalesce(sum(x.amount_cop), 0)::int)
    FROM public.billing_extra_charges x
   WHERE x.auxiliar_profile_id = p_aux AND x.applied_at IS NULL AND x.cancelled_at IS NULL;
$$;

-- Los viajes extra de VACACIONES de un período de origen (0094; los privados no
-- son «viajes de más»).
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
   WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start AND x.cancelled_at IS NULL
     AND x.kind = 'vacation';
$$;

-- -----------------------------------------------------------------------------
-- 5. Viajes de vacaciones: sin los que se cobran como privado
-- -----------------------------------------------------------------------------
-- Viajes reservados en un período (reservas no canceladas; hora de Bogotá),
-- MENOS los que tienen su línea de privado activa: esos ya se cobran aparte.
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
     AND (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
     AND NOT EXISTS (SELECT 1 FROM public.billing_extra_charges x
                      WHERE x.kind = 'private' AND x.reservation_id = r.id AND x.cancelled_at IS NULL);
$$;

-- -----------------------------------------------------------------------------
-- 6. El recálculo de vacaciones (0094) solo mira sus propios cargos, y la
--    apertura de una cuenta toma también los privados pendientes
-- -----------------------------------------------------------------------------

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
     WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start AND kind = 'vacation'
       AND applied_at IS NULL AND cancelled_at IS NULL;
    RETURN;
  END IF;

  v_end    := v_st.period_end;
  v_booked := public.billing_trips_booked(p_aux, p_period_start, v_end);
  v_want   := greatest(v_vac.trips, v_booked);

  IF (v_live OR (p_force AND (v_st.paid_at IS NULL OR v_zero))) AND v_vac.status = 'active' THEN
    -- Cuenta viva: se recalcula. Lo pendiente de este período queda adentro.
    UPDATE public.billing_extra_charges SET cancelled_at = now()
     WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start AND kind = 'vacation'
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
   WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start AND x.kind = 'vacation'
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
       WHERE x.auxiliar_profile_id = p_aux AND x.source_period_start = p_period_start AND x.kind = 'vacation'
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
   WHERE auxiliar_profile_id = p_aux AND source_period_start = p_period_start AND kind = 'vacation'
     AND applied_at IS NULL AND cancelled_at IS NULL FOR UPDATE;
  IF v_pend = 0 THEN
    IF v_x.id IS NOT NULL THEN
      UPDATE public.billing_extra_charges SET cancelled_at = now() WHERE id = v_x.id;
    END IF;
    RETURN;
  END IF;
  IF v_x.id IS NULL THEN
    INSERT INTO public.billing_extra_charges (organization_id, auxiliar_profile_id, kind, vacation_id, source_period_start,
                                              source_statement_id, trips, per_trip_cop)
    VALUES (v_st.organization_id, p_aux, 'vacation', v_vac.id, p_period_start, v_st.id, v_pend, v_vac.per_trip_cop)
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
  v_res    uuid;
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
       WHERE x2.auxiliar_profile_id = p_aux AND x2.kind = 'vacation' AND x2.applied_at IS NULL AND x2.cancelled_at IS NULL
         AND x2.source_period_start < p_period_start
      UNION ALL
      (SELECT st.period_start FROM public.billing_statements st
        WHERE st.auxiliar_profile_id = p_aux AND st.period_start < p_period_start
        ORDER BY st.period_start DESC LIMIT 1)
    ) y
  LOOP
    PERFORM public.billing_vacation_sync(p_aux, v_src, p_today, false);
  END LOOP;
  -- 0103: los traslados privados aprobados que esperan cuenta (viaje de este
  -- período, o de uno anterior cuya cuenta ya no se podía tocar). Antes se
  -- revisa cada uno contra su reserva (por si se canceló o se rechazó).
  FOR v_res IN
    SELECT x4.reservation_id FROM public.billing_extra_charges x4
     WHERE x4.auxiliar_profile_id = p_aux AND x4.kind = 'private' AND x4.reservation_id IS NOT NULL
       AND x4.applied_at IS NULL AND x4.cancelled_at IS NULL AND x4.trip_on <= v_end
  LOOP
    PERFORM public.billing_private_sync(v_res, p_today, false);
  END LOOP;
  FOR x IN
    SELECT * FROM public.billing_extra_charges x3
     WHERE x3.auxiliar_profile_id = p_aux AND x3.applied_at IS NULL AND x3.cancelled_at IS NULL
       AND ((x3.kind = 'vacation' AND x3.source_period_start < p_period_start)
         OR (x3.kind = 'private' AND x3.trip_on <= v_end))
     ORDER BY x3.source_period_start, x3.trip_on NULLS FIRST, x3.created_at
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
-- 7. La línea del privado: dónde entra, entrar, salir, y la sincronía
-- -----------------------------------------------------------------------------

-- La cuenta donde un privado de ese día entra YA: la primera cuenta VIVA cuyo
-- período termina el día del viaje o después (la del mes del viaje si está
-- viva; si no, la que esté abierta ahora para un viaje que ya pasó). Sin
-- ninguna: NULL (queda pendiente para la cuenta que abra el reloj).
CREATE OR REPLACE FUNCTION public.billing_private_target(p_aux uuid, p_day date, p_today date)
RETURNS public.billing_statements
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT st.*
    FROM public.billing_statements st
    JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = st.auxiliar_profile_id AND ab.active
   WHERE st.auxiliar_profile_id = p_aux
     AND st.period_end >= p_day
     AND public.billing_statement_live(st, p_today)
   ORDER BY st.period_start
   LIMIT 1;
$$;

-- Mete una línea pendiente en una cuenta: el monto sube (el descuento que puso
-- el jefe se respeta, billing_vacation_reprice de 0094) y si estaba saldada sola
-- en $0 se reabre.
CREATE OR REPLACE FUNCTION public.billing_private_apply(p_x_id uuid, p_st_id uuid, p_today date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  x public.billing_extra_charges;
  s public.billing_statements;
BEGIN
  SELECT * INTO x FROM public.billing_extra_charges WHERE id = p_x_id FOR UPDATE;
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  IF x.id IS NULL OR s.id IS NULL OR x.cancelled_at IS NOT NULL OR x.applied_at IS NOT NULL THEN RETURN; END IF;
  IF s.paid_at IS NOT NULL THEN
    IF NOT public.billing_statement_auto_zero(s.id) THEN RETURN; END IF;   -- pagada por una persona: no se toca
    s := public.billing_vacation_unsettle(s.id, p_today);
  END IF;
  s := public.billing_vacation_reprice(s.id, s.amount_cop + x.amount_cop, s.vacation_id, p_today, s.vacation_trips);
  UPDATE public.billing_extra_charges SET applied_statement_id = s.id, applied_at = now() WHERE id = x.id;
  IF s.paid_at IS NULL THEN PERFORM public.billing_block_if_due(s.id, p_today); END IF;
  PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, p_today);
END;
$$;

-- Saca una línea. Pendiente: se anula. En una cuenta sin pagar (también vencida
-- o pausada) o saldada sola en $0: se anula y el monto baja. En una cuenta
-- PAGADA por una persona o EN REVISIÓN: no se toca y devuelve false (en revisión
-- se vuelve a mirar al rechazar el comprobante).
CREATE OR REPLACE FUNCTION public.billing_private_unplace(p_x_id uuid, p_today date)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  x public.billing_extra_charges;
  s public.billing_statements;
BEGIN
  SELECT * INTO x FROM public.billing_extra_charges WHERE id = p_x_id FOR UPDATE;
  IF x.id IS NULL OR x.cancelled_at IS NOT NULL THEN RETURN true; END IF;
  IF x.applied_statement_id IS NULL THEN
    UPDATE public.billing_extra_charges SET cancelled_at = now() WHERE id = x.id;
    RETURN true;
  END IF;
  SELECT * INTO s FROM public.billing_statements WHERE id = x.applied_statement_id FOR UPDATE;
  IF s.id IS NOT NULL THEN
    IF s.paid_at IS NOT NULL AND NOT public.billing_statement_auto_zero(s.id) THEN RETURN false; END IF;
    IF s.paid_at IS NULL AND s.proof_state = 'review' THEN RETURN false; END IF;
  END IF;
  -- Aplicado y anulado: queda la huella de a qué cuenta había entrado (como 0094).
  UPDATE public.billing_extra_charges SET cancelled_at = now() WHERE id = x.id;
  IF s.id IS NOT NULL THEN
    IF s.paid_at IS NOT NULL THEN s := public.billing_vacation_unsettle(s.id, p_today); END IF;
    s := public.billing_vacation_reprice(s.id, greatest(0, s.amount_cop - x.amount_cop), s.vacation_id, p_today, s.vacation_trips);
    IF s.paid_at IS NULL THEN PERFORM public.billing_block_if_due(s.id, p_today); END IF;
    PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, p_today);
  END IF;
  RETURN true;
END;
$$;

-- LA SINCRONÍA de un privado con su línea de cobro. Idempotente: correrla dos
-- veces no hace nada la segunda. p_create: puede crear la línea si la reserva
-- todavía no tiene (solo lo pide una aprobación nueva; así un privado aprobado
-- antes de 0103 no se cobra por un cambio cualquiera).
CREATE OR REPLACE FUNCTION public.billing_private_sync(p_res uuid, p_today date DEFAULT NULL, p_create boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := coalesce(p_today, public.billing_today());
  r       public.reservations;
  x       public.billing_extra_charges;
  v_want  boolean;
  v_day   date;
  v_org   uuid;
  v_cut   smallint;
  v_ps    date;
  v_home  public.billing_statements;
  v_tgt   public.billing_statements;
BEGIN
  IF p_res IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.reservations WHERE id = p_res;
  SELECT * INTO x FROM public.billing_extra_charges WHERE kind = 'private' AND reservation_id = p_res FOR UPDATE;
  -- ¿Se cobra? Privado APROBADO, no cancelado, con precio.
  v_want := r.id IS NOT NULL
        AND r.service_level = 'private' AND r.private_status = 'approved'
        AND r.cancelled_at IS NULL
        AND coalesce(r.status_h2a::text, r.status_a2h::text, '') <> 'cancelled'
        AND coalesce(r.price_cop, 0) > 0
        AND r.auxiliar_profile_id IS NOT NULL AND r.required_arrival_at IS NOT NULL;
  IF v_want THEN v_day := (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date; END IF;

  IF x.id IS NOT NULL AND x.cancelled_at IS NULL THEN
    IF v_want AND x.auxiliar_profile_id = r.auxiliar_profile_id AND x.trip_on = v_day AND x.per_trip_cop = r.price_cop THEN
      -- La misma línea. Si espera cuenta y ya hay una viva donde entra, entra.
      IF x.applied_at IS NULL THEN
        v_tgt := public.billing_private_target(x.auxiliar_profile_id, x.trip_on, v_today);
        IF v_tgt.id IS NOT NULL THEN PERFORM public.billing_private_apply(x.id, v_tgt.id, v_today); END IF;
      END IF;
      RETURN;
    END IF;
    -- Ya no va (cancelado, rechazado) o cambió (fecha, precio, tripulante): sale.
    IF NOT public.billing_private_unplace(x.id, v_today) THEN
      RETURN;   -- quedó en una cuenta pagada o en revisión: no se toca
    END IF;
    SELECT * INTO x FROM public.billing_extra_charges WHERE id = x.id;
  END IF;

  IF NOT v_want THEN RETURN; END IF;
  IF x.id IS NULL AND NOT p_create THEN RETURN; END IF;

  SELECT pr.organization_id INTO v_org
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = r.auxiliar_profile_id;
  SELECT ab.cut_day INTO v_cut FROM public.auxiliar_billing ab WHERE ab.auxiliar_profile_id = r.auxiliar_profile_id;
  -- El período del viaje: la cuenta cuyas fechas lo contienen; sin cuenta, el del
  -- día de corte (o el mes, si todavía no tiene cuenta de cobro).
  SELECT * INTO v_home FROM public.billing_statements st
   WHERE st.auxiliar_profile_id = r.auxiliar_profile_id AND v_day BETWEEN st.period_start AND st.period_end
   ORDER BY st.period_start DESC LIMIT 1;
  v_ps := coalesce(v_home.period_start,
                   CASE WHEN v_cut IS NOT NULL THEN public.billing_last_cut(v_day, v_cut) END,
                   date_trunc('month', v_day)::date);

  IF x.id IS NULL THEN
    INSERT INTO public.billing_extra_charges (organization_id, auxiliar_profile_id, kind, reservation_id, trip_on,
                                              source_period_start, source_statement_id, trips, per_trip_cop)
    VALUES (v_org, r.auxiliar_profile_id, 'private', r.id, v_day, v_ps, v_home.id, 1, r.price_cop)
    RETURNING * INTO x;
  ELSE
    UPDATE public.billing_extra_charges
       SET organization_id = v_org, auxiliar_profile_id = r.auxiliar_profile_id, trip_on = v_day,
           source_period_start = v_ps, source_statement_id = v_home.id, trips = 1, per_trip_cop = r.price_cop,
           applied_statement_id = NULL, applied_at = NULL, cancelled_at = NULL
     WHERE id = x.id
    RETURNING * INTO x;
  END IF;
  v_tgt := public.billing_private_target(r.auxiliar_profile_id, v_day, v_today);
  IF v_tgt.id IS NOT NULL THEN PERFORM public.billing_private_apply(x.id, v_tgt.id, v_today); END IF;
END;
$$;

COMMENT ON FUNCTION public.billing_private_sync(uuid, date, boolean) IS
  '0103: deja la línea de cobro de un privado en línea con su reserva (aprobado → entra en la cuenta del mes del viaje si está viva, si no queda pendiente; cancelado/rechazado → sale, salvo de una cuenta pagada o en revisión). Idempotente.';

-- -----------------------------------------------------------------------------
-- 8. Triggers
-- -----------------------------------------------------------------------------

-- Reservations: alta y cambios de un privado. Corre ANTES que el recálculo de
-- vacaciones (orden alfabético de los AFTER: ..._private_* < ..._vac_*), así ese
-- recálculo ya ve si el viaje se cobra como privado.
CREATE OR REPLACE FUNCTION public.billing_reservation_private_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_create boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_create := true;
  ELSE
    v_create := OLD.private_status IS DISTINCT FROM NEW.private_status
             OR OLD.service_level IS DISTINCT FROM NEW.service_level;
  END IF;
  BEGIN
    PERFORM public.billing_private_sync(NEW.id, public.billing_today(), v_create);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Facturario: no se pudo sincronizar el cobro del privado %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_billing_private_ins ON public.reservations;
CREATE TRIGGER tr_reservations_billing_private_ins
  AFTER INSERT ON public.reservations
  FOR EACH ROW
  WHEN (NEW.service_level = 'private' AND NEW.private_status = 'approved')
  EXECUTE FUNCTION public.billing_reservation_private_sync();

DROP TRIGGER IF EXISTS tr_reservations_billing_private_upd ON public.reservations;
CREATE TRIGGER tr_reservations_billing_private_upd
  AFTER UPDATE OF service_level, private_status, price_cop, cancelled_at, status_h2a, status_a2h,
                  required_arrival_at, auxiliar_profile_id ON public.reservations
  FOR EACH ROW
  WHEN ((OLD.service_level = 'private' OR NEW.service_level = 'private') AND (
        OLD.service_level IS DISTINCT FROM NEW.service_level
     OR OLD.private_status IS DISTINCT FROM NEW.private_status
     OR OLD.price_cop IS DISTINCT FROM NEW.price_cop
     OR OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at
     OR OLD.required_arrival_at IS DISTINCT FROM NEW.required_arrival_at
     OR OLD.auxiliar_profile_id IS DISTINCT FROM NEW.auxiliar_profile_id
     OR (coalesce(OLD.status_h2a::text, OLD.status_a2h::text, '') = 'cancelled')
        IS DISTINCT FROM (coalesce(NEW.status_h2a::text, NEW.status_a2h::text, '') = 'cancelled')))
  EXECUTE FUNCTION public.billing_reservation_private_sync();

-- Borrar la reserva: la línea sale ANTES (después la llave foránea la deja en NULL).
CREATE OR REPLACE FUNCTION public.billing_reservation_private_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_x uuid;
BEGIN
  BEGIN
    SELECT x.id INTO v_x FROM public.billing_extra_charges x
     WHERE x.kind = 'private' AND x.reservation_id = OLD.id AND x.cancelled_at IS NULL;
    IF v_x IS NOT NULL THEN PERFORM public.billing_private_unplace(v_x, public.billing_today()); END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Facturario: no se pudo quitar el cobro del privado borrado %: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_billing_private_del ON public.reservations;
CREATE TRIGGER tr_reservations_billing_private_del
  BEFORE DELETE ON public.reservations
  FOR EACH ROW
  WHEN (OLD.service_level = 'private')
  EXECUTE FUNCTION public.billing_reservation_private_delete();

-- El recálculo de vacaciones (0094) también al aprobar o des-aprobar un privado
-- (el viaje entra o sale del conteo de vacaciones). Igual al de 0094 + esa condición.
DROP TRIGGER IF EXISTS tr_reservations_billing_vac_upd ON public.reservations;
CREATE TRIGGER tr_reservations_billing_vac_upd
  AFTER UPDATE OF required_arrival_at, cancelled_at, status_h2a, status_a2h, auxiliar_profile_id,
                  service_level, private_status, price_cop ON public.reservations
  FOR EACH ROW
  WHEN (OLD.required_arrival_at IS DISTINCT FROM NEW.required_arrival_at
     OR OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at
     OR OLD.auxiliar_profile_id IS DISTINCT FROM NEW.auxiliar_profile_id
     OR (coalesce(OLD.status_h2a::text, OLD.status_a2h::text, '') = 'cancelled')
        IS DISTINCT FROM (coalesce(NEW.status_h2a::text, NEW.status_a2h::text, '') = 'cancelled')
     OR (OLD.service_level = 'private' AND OLD.private_status = 'approved')
        IS DISTINCT FROM (NEW.service_level = 'private' AND NEW.private_status = 'approved')
     OR ((OLD.service_level = 'private' OR NEW.service_level = 'private')
         AND OLD.price_cop IS DISTINCT FROM NEW.price_cop))
  EXECUTE FUNCTION public.billing_reservation_vac_sync();

-- Una cuenta que SALE de revisión sin pagarse (el jefe rechazó el comprobante)
-- vuelve a estar viva: los privados que esperaban por ella entran, y los que se
-- cancelaron mientras estaba en revisión salen. Corre antes que el de 0094
-- (tr_billing_statements_private_resync < tr_billing_statements_vac_resync).
CREATE OR REPLACE FUNCTION public.billing_statement_private_resync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := public.billing_today();
  v_res   uuid;
BEGIN
  BEGIN
    FOR v_res IN
      SELECT DISTINCT x.reservation_id FROM public.billing_extra_charges x
       WHERE x.kind = 'private' AND x.reservation_id IS NOT NULL AND x.cancelled_at IS NULL
         AND (x.applied_statement_id = NEW.id
              OR (x.applied_at IS NULL AND x.auxiliar_profile_id = NEW.auxiliar_profile_id
                  AND x.trip_on <= NEW.period_end))
    LOOP
      PERFORM public.billing_private_sync(v_res, v_today, false);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Facturario: no se pudo recalcular los privados de la cuenta de cobro % al salir de revisión: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_billing_statements_private_resync ON public.billing_statements;
CREATE TRIGGER tr_billing_statements_private_resync
  AFTER UPDATE OF proof_state ON public.billing_statements
  FOR EACH ROW
  WHEN (OLD.proof_state = 'review' AND NEW.proof_state IS DISTINCT FROM 'review' AND NEW.paid_at IS NULL)
  EXECUTE FUNCTION public.billing_statement_private_resync();

-- -----------------------------------------------------------------------------
-- 9. El balance del mes (0094 + los privados aparte)
-- -----------------------------------------------------------------------------
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
        -- 0103: solo los viajes extra de vacaciones (los privados van aparte, abajo).
        'extrasIncludedCOP', public.billing_statement_kind_cop(s.id, 'vacation'),
        'extrasIncluded',    public.billing_statement_kind_json(s.id, 'vacation'),
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
      ) || jsonb_build_object(
        -- 0103: los traslados privados aprobados que esta cuenta cobra (ya van dentro de amountCOP).
        'privateCOP',        public.billing_statement_kind_cop(s.id, 'private'),
        'privateCount',      jsonb_array_length(public.billing_statement_kind_json(s.id, 'private')),
        'privateIncluded',   public.billing_statement_kind_json(s.id, 'private')
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
    || jsonb_build_object(
      -- 0103: traslados privados cobrados en las cuentas del mes.
      'privateCOP',        coalesce(sum((e.j ->> 'privateCOP')::int), 0),
      'privateCount',      coalesce(sum((e.j ->> 'privateCount')::int), 0),
      'privateStatements', count(*) FILTER (WHERE (e.j ->> 'privateCOP')::int > 0))
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
-- 10. Permisos: todo lo nuevo es interno (lo llaman los triggers y las demás
--     funciones). Las redefinidas conservan los permisos de 0094 (se repiten).
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.reservations_private_price_fill()',
    'public.billing_private_label(date, integer)',
    'public.billing_statement_kind_cop(uuid, text)',
    'public.billing_statement_kind_json(uuid, text)',
    'public.billing_private_target(uuid, date, date)',
    'public.billing_private_apply(uuid, uuid, date)',
    'public.billing_private_unplace(uuid, date)',
    'public.billing_private_sync(uuid, date, boolean)',
    'public.billing_reservation_private_sync()',
    'public.billing_reservation_private_delete()',
    'public.billing_statement_private_resync()',
    'public.billing_trips_booked(uuid, date, date)',
    'public.billing_period_extras(uuid, date)',
    'public.billing_extra_json(public.billing_extra_charges)',
    'public.billing_statement_extras_json(uuid)',
    'public.billing_extras_pending_json(uuid)',
    'public.billing_vacation_sync(uuid, date, date, boolean)',
    'public.billing_open_statement(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION public.admin_billing_balance(date) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_billing_balance(date) TO authenticated';
END
$do$;

COMMIT;
