-- =============================================================================
-- 0169 · El conductor ve el día de TODO el equipo y todos los vuelos
-- =============================================================================
-- Audios de los conductores (16–17 nov): «antes uno se fijaba en el grupo: saliendo
-- con Juan, finalizado con Juan… y va descartando en el iti», para notar si alguien
-- se queda sin carro. Y Harold: «a veces recogemos gente de diferentes vuelos:
-- necesitamos ver todos los vuelos».
--
-- driver_day_board(): las vueltas PUBLICADAS del día de operación (la madrugada es
-- del día anterior, dia_del_plan) de su organización, con quién la lleva y la
-- gente por nombre corto y su vuelo. SOLO LECTURA y solo para un conductor. No
-- trae teléfonos, direcciones ni notas: nombre corto, vuelo y hora.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.driver_day_board()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp  uuid := public.my_driver_profile_id();
  v_org uuid := public.current_user_org();
  v_dia date;
BEGIN
  IF v_dp IS NULL OR v_org IS NULL THEN
    RETURN jsonb_build_object('day', NULL, 'vueltas', '[]'::jsonb);
  END IF;
  v_dia := public.dia_del_plan(NULL, now());
  RETURN jsonb_build_object('day', v_dia, 'vueltas', coalesce((
    SELECT jsonb_agg(q.j ORDER BY q.ts, q.id) FROM (
      SELECT ra.planned_start_at AS ts, ra.id, jsonb_build_object(
        'id', ra.id, 'direction', ra.direction, 'start_at', ra.planned_start_at, 'status', ra.status,
        'mine', coalesce(ra.driver_profile_id = v_dp, false),
        'driver', (SELECT public.short_name(pp.full_name) FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = ra.driver_profile_id),
        'delegated', ra.delegated_at IS NOT NULL,
        'delegate', nullif(btrim(ra.delegate_name), ''),
        'stops', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'name', coalesce(public.short_name(p.full_name), rs.guest_name),
                   'status', rs.status,
                   'at', rs.estimated_arrival_at,
                   'req_at', r.required_arrival_at,
                   'reserve', r.reserve_place,
                   'flight', CASE WHEN r.reserve_place IS NOT NULL THEN NULL ELSE coalesce(
                     nullif(upper(regexp_replace(coalesce(f.flight_number, r.flight_code, ''), '[[:space:]-]', '', 'g')), ''),
                     nullif(upper(regexp_replace(coalesce(substring(r.notes FROM '(?i)vuelo\s*:?\s*([A-Za-z0-9]{0,3}\s*-?\s*[0-9]{2,5})'), ''), '[[:space:]-]', '', 'g')), '')) END
                 ) ORDER BY rs.stop_order), '[]'::jsonb)
            FROM public.route_stops rs
            LEFT JOIN public.reservations r        ON r.id = rs.reservation_id
            LEFT JOIN public.auxiliar_profiles ap  ON ap.id = r.auxiliar_profile_id
            LEFT JOIN public.profiles p            ON p.id = ap.profile_id
            LEFT JOIN public.flights f             ON f.id = r.flight_id
           WHERE rs.route_assignment_id = ra.id AND (rs.reservation_id IS NULL OR r.cancelled_at IS NULL))
      ) AS j
      FROM public.route_assignments ra
      WHERE ra.status IN ('planned', 'in_progress', 'completed')
        AND public.dia_del_plan(ra.manual_day, ra.planned_start_at) = v_dia
        AND (coalesce(ra.organization_id = v_org, false) OR EXISTS (
              SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id
                JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id
               WHERE x.route_assignment_id = ra.id AND yp.organization_id = v_org))
        AND EXISTS (SELECT 1 FROM public.route_stops x LEFT JOIN public.reservations y ON y.id = x.reservation_id
                     WHERE x.route_assignment_id = ra.id AND (x.reservation_id IS NULL OR y.cancelled_at IS NULL))
    ) q), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.driver_day_board() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_day_board() TO authenticated;

COMMIT;
