-- =============================================================================
-- 0168 · Cancelar desde coordinación no deja la vuelta vacía
-- =============================================================================
-- Harold, 17-nov: canceló a Jairo desde Asignación y quedó su vuelta con «0
-- personas» y Miguel Ángel de conductor. admin_cancel_reservation (0050) borraba
-- la parada pero no la vuelta; auxiliar_cancel_reservation sí la quita desde 0134.
-- Es la función de 0050 TAL CUAL (leída de producción el 17-nov) + ese paso.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_cancel_reservation(p_reservation_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_dir    public.trip_direction;
  v_raw    text;
  v_driver uuid;
  v_aux    uuid;
  v_vueltas uuid[];
  v_quitadas int := 0;
BEGIN
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'solo un admin puede cancelar traslados de otros';
  END IF;

  SELECT r.direction, COALESCE(r.status_h2a::text, r.status_a2h::text), ap.profile_id
    INTO v_dir, v_raw, v_aux
  FROM public.reservations r
  JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  WHERE r.id = p_reservation_id
    AND r.cancelled_at IS NULL
  LIMIT 1;

  IF v_dir IS NULL THEN
    RAISE EXCEPTION 'la reserva % no existe o ya estaba cancelada', p_reservation_id;
  END IF;

  IF v_raw IN ('on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show') THEN
    RAISE EXCEPTION 'el viaje ya está en curso o terminó; no se puede cancelar';
  END IF;

  SELECT dp.profile_id INTO v_driver
  FROM public.route_stops rs
  JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  JOIN public.driver_profiles   dp ON dp.id = ra.driver_profile_id
  WHERE rs.reservation_id = p_reservation_id
    AND ra.status IN ('planned', 'in_progress')
  LIMIT 1;

  -- 0168: las vueltas de donde sale (para quitar la que quede vacía).
  SELECT coalesce(array_agg(DISTINCT ra.id), ARRAY[]::uuid[]) INTO v_vueltas
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
   WHERE rs.reservation_id = p_reservation_id AND ra.status <> 'completed';

  DELETE FROM public.route_stops rs
  USING public.route_assignments ra
  WHERE rs.route_assignment_id = ra.id
    AND rs.reservation_id = p_reservation_id
    AND ra.status <> 'completed';

  UPDATE public.reservations
     SET cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         status_h2a          = CASE WHEN v_dir = 'home_to_airport' THEN 'cancelled'::public.reservation_status_h2a ELSE NULL END,
         status_a2h          = CASE WHEN v_dir = 'airport_to_home' THEN 'cancelled'::public.reservation_status_a2h ELSE NULL END,
         updated_at          = now()
   WHERE id = p_reservation_id;

  -- 0168: la vuelta que quedó vacía (y no ha arrancado) se quita sola, como cuando
  -- cancela el tripulante (0134). Antes quedaba una vuelta de «0 personas».
  WITH vacias AS (
    DELETE FROM public.route_assignments ra
     WHERE ra.id = ANY (v_vueltas) AND ra.status IN ('draft', 'planned') AND ra.actual_start_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id)
    RETURNING 1)
  SELECT count(*) INTO v_quitadas FROM vacias;

  RETURN jsonb_build_object('ok', true, 'driver_profile_id', v_driver, 'auxiliar_profile_id', v_aux, 'removed_routes', v_quitadas);
END;
$$;

COMMIT;
