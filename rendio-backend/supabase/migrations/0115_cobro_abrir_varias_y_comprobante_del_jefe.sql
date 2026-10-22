-- =============================================================================
-- Migration 0115 — Cuentas de cobro: abrir varias a la vez, «plazo desde hoy» y
-- el comprobante que sube el jefe
-- Pedido de la dueña (22-oct-2026, notas de voz de las 8:43 y las 9:59)
--
-- POR QUÉ
--   · En producción el reloj diario (billing-daily) nunca corrió: las cuentas de
--     cobro de octubre no se abrieron solas y el jefe las abrió una por una. Hace
--     falta poder seleccionar a varios (o a todos los de un día de corte) y
--     abrirles la cuenta de una vez.
--   · Abrir tarde con la fecha del corte deja al tripulante vencido (y pausado) de
--     una vez: hoy hay uno pausado así. «Plazo desde hoy» le vuelve a contar los
--     días para pagar desde hoy, en la MISMA cuenta de cobro (mismo período, así
--     el reloj no le abre otra ni se le cobra dos veces).
--   · Varios ya pagaron por fuera: el jefe marca el pago a mano y ahora también
--     puede adjuntar el comprobante, para que el tripulante vea el flujo completo
--     (enviado → revisado → aprobado) con la imagen.
--
-- QUÉ HACE
--   1. Política del bucket privado payment-proofs: el jefe sube archivos SOLO a
--      carpetas de su organización ({org}/{profile del tripulante}/{cuenta}/…).
--   2. billing_restart_terms (interna): los días para pagar vuelven a contar desde
--      hoy (due_days crece; nunca baja), se quita la pausa, y los avisos de fecha
--      de esa cuenta vuelven a correr con las fechas nuevas (sale de nuevo «Tu
--      cuenta de cobro de <mes> está lista», con la fecha límite nueva).
--   3. admin_billing_restart_terms(statement): «Plazo desde hoy» del jefe.
--   4. admin_billing_open_statements(auxes[], desde_hoy, avisar): abre la cuenta de
--      cobro del corte vigente a cada uno; a quien no se le puede, lo dice con el
--      motivo (sin cuenta, apagada, ya la tiene, sin valor). Con «avisar», la push
--      «está lista» sale aunque se abra después del día del corte.
--   5. admin_billing_mark_paid_with_proof: registra el archivo como comprobante y
--      lo aprueba con el pago (por dentro, el mismo admin_billing_mark_paid).
--
-- No cambia ninguna función existente. Idempotente. Down:
-- down_migrations/0115_cobro_abrir_varias_y_comprobante_del_jefe.down.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El jefe sube el comprobante a la carpeta del tripulante (solo su organización)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_payment_proofs_insert_admin ON storage.objects;
CREATE POLICY p_payment_proofs_insert_admin ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payment-proofs'
    AND public.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = public.current_user_org()::text
  );

-- -----------------------------------------------------------------------------
-- 2. Los plazos vuelven a contar desde hoy (interna)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_restart_terms(p_st_id uuid, p_today date, p_push boolean DEFAULT true)
RETURNS public.billing_statements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s   public.billing_statements;
  ab  public.auxiliar_billing;
  cfg public.billing_settings;
  v_due integer;
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_st_id FOR UPDATE;
  IF s.id IS NULL OR s.paid_at IS NOT NULL THEN RETURN s; END IF;
  SELECT * INTO ab FROM public.auxiliar_billing WHERE auxiliar_profile_id = s.auxiliar_profile_id;
  SELECT * INTO cfg FROM public.billing_settings WHERE organization_id = s.organization_id;
  -- Fecha límite = hoy + los días para pagar de su cuenta (o de la organización).
  -- Nunca se acorta un plazo que ya era más largo.
  v_due := greatest(s.due_days::integer,
                    (p_today - s.period_start) + coalesce(ab.due_days, cfg.due_days, 5)::integer);
  UPDATE public.billing_statements
     SET due_days = v_due::smallint, blocked_at = NULL, blocked_on = NULL
   WHERE id = s.id
  RETURNING * INTO s;
  -- Los avisos de fecha vuelven a correr con las fechas nuevas (los del
  -- comprobante —recibido, rechazado, por revisar— se quedan).
  DELETE FROM public.billing_alerts
   WHERE statement_id = s.id
     AND key IN ('generado', 'recordatorio', 'venceHoy', 'vencido', 'ultimoDia', 'bloqueado', 'admMora', 'admBloqueado');
  PERFORM public.billing_emit(s, 'generado', p_today, '{}'::jsonb, NULL, p_push);
  UPDATE public.billing_statements
     SET status = public.billing_statement_base(billing_statements, p_today)
   WHERE id = s.id
  RETURNING * INTO s;
  PERFORM public.billing_refresh_pause(s.auxiliar_profile_id, p_today);
  RETURN s;
END;
$$;

COMMENT ON FUNCTION public.billing_restart_terms(uuid, date, boolean)
  IS '0115: los días para pagar de una cuenta de cobro sin pagar vuelven a contar desde hoy (mismo período), se quita la pausa y los avisos de fecha vuelven a correr.';

-- -----------------------------------------------------------------------------
-- 3. «Plazo desde hoy» (el jefe)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_billing_restart_terms(p_statement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.billing_statements; v_today date := public.billing_today();
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_statement_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Cuenta de cobro no encontrada' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(s.organization_id);
  IF s.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Esta cuenta de cobro ya está pagada' USING ERRCODE = 'P0001'; END IF;
  s := public.billing_restart_terms(s.id, v_today, true);
  RETURN public.billing_statement_json(s, v_today);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Abrir varias a la vez
--    p_from_today: los días para pagar cuentan desde hoy (si no, desde su corte).
--    p_notify:     la push «está lista» sale aunque se abra después del corte.
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

-- -----------------------------------------------------------------------------
-- 5. «Marcar pagado» con el comprobante que sube el jefe
--    El archivo ya está en payment-proofs/{org}/{profile del tripulante}/{cuenta}/…
--    Queda como comprobante enviado el día del pago y aprobado con el pago.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_billing_mark_paid_with_proof(
  p_statement_id uuid, p_storage_path text, p_content_type text DEFAULT NULL, p_size_bytes integer DEFAULT NULL,
  p_via_label text DEFAULT NULL, p_amount_cop integer DEFAULT NULL, p_paid_on date DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s       public.billing_statements;
  v_today date := public.billing_today();
  v_prof  uuid;
  v_path  text := btrim(coalesce(p_storage_path, ''));
BEGIN
  SELECT * INTO s FROM public.billing_statements WHERE id = p_statement_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Cuenta de cobro no encontrada' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.billing_assert_admin_of(s.organization_id);
  IF s.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Esta cuenta de cobro ya está pagada' USING ERRCODE = 'P0001'; END IF;
  IF p_paid_on IS NOT NULL AND p_paid_on > v_today THEN
    RAISE EXCEPTION 'La fecha del pago no puede ser futura' USING ERRCODE = '22023';
  END IF;
  SELECT ap.profile_id INTO v_prof FROM public.auxiliar_profiles ap WHERE ap.id = s.auxiliar_profile_id;
  IF split_part(v_path, '/', 1) <> s.organization_id::text
     OR split_part(v_path, '/', 2) <> coalesce(v_prof::text, '-')
     OR split_part(v_path, '/', 3) <> s.id::text
     OR split_part(v_path, '/', 4) = '' OR split_part(v_path, '/', 5) <> '' THEN
    RAISE EXCEPTION 'El archivo no corresponde a esta cuenta de cobro' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payment-proofs' AND o.name = v_path) THEN
    RAISE EXCEPTION 'No encontramos el archivo del comprobante: vuelve a subirlo' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_proofs WHERE statement_id = s.id AND status = 'review') THEN
    RAISE EXCEPTION 'Ya tiene un comprobante en revisión de esta cuenta: apruébalo en «Comprobantes por revisar»'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.billing_proofs (statement_id, organization_id, auxiliar_profile_id, storage_path, content_type,
                                     size_bytes, via_label, declared_amount_cop, status, submitted_at, submitted_on)
  VALUES (s.id, s.organization_id, s.auxiliar_profile_id, v_path, nullif(btrim(coalesce(p_content_type, '')), ''),
          p_size_bytes, coalesce(nullif(btrim(p_via_label), ''), 'Pago registrado por el admin'), p_amount_cop,
          'review', now(), coalesce(p_paid_on, v_today));
  -- El mismo «marcar pagado» de siempre: aprueba el comprobante en revisión (este)
  -- y deja la cuenta al día.
  RETURN public.admin_billing_mark_paid(s.id, p_via_label, p_amount_cop, p_paid_on, p_note);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Permisos
-- -----------------------------------------------------------------------------
DO $do$
DECLARE f text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.billing_restart_terms(uuid, date, boolean) FROM PUBLIC, anon, authenticated';
  FOREACH f IN ARRAY ARRAY[
    'public.admin_billing_restart_terms(uuid)',
    'public.admin_billing_open_statements(uuid[], boolean, boolean)',
    'public.admin_billing_mark_paid_with_proof(uuid, text, text, integer, text, integer, date, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

COMMIT;
