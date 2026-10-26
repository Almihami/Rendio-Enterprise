-- Reversa de 0133 · Pasajeros sin cuenta en la ruta de Julián.
-- 1. admin_manual_route_publish vuelve EXACTAMENTE a la de 0125 (copia de su bloque).
-- 2. Se BORRAN las paradas de pasajeros sin cuenta (sin ellas, reservation_id vuelve
--    a ser obligatorio). Una vuelta que quede vacía, también.
-- 3. Quita la RPC del conductor, el CHECK y las columnas.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org      uuid := public.current_user_org();
  b          jsonb;
  st         jsonb;
  v_type     text;
  v_dir      public.trip_direction;
  v_ids      uuid[];
  v_sig      text;
  v_first    timestamptz;
  v_start    timestamptz;
  v_dead     timestamptz;
  v_flight   text;
  v_ra       uuid;
  v_old      record;
  v_kept     int := 0;
  v_created  int := 0;
  v_removed  int := 0;
  v_skipped  int := 0;
  v_notified int := 0;
  v_drivers  int := 0;
  v_keep     uuid[] := ARRAY[]::uuid[];
  v_busy     uuid[];
  v_used     uuid[] := ARRAY[]::uuid[];
  v_tocadas  uuid[];
  v_tablero  int := 0;
  i          int;
  v_res      record;
  v_at       timestamptz;
  v_title    text;
  v_body     text;
  v_total    int := 0;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe publica la ruta' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'Falta la ruta' USING ERRCODE = '22023';
  END IF;

  -- Reservas que ya van en una vuelta ARRANCADA de este día: no se vuelven a poner.
  SELECT coalesce(array_agg(DISTINCT rs.reservation_id), ARRAY[]::uuid[]) INTO v_busy
    FROM public.route_assignments ra JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
   WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
     AND (ra.status IN ('in_progress', 'completed')
          OR EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending'));

  FOR b IN SELECT * FROM jsonb_array_elements(p_blocks) LOOP
    v_type := CASE WHEN b->>'type' = 'lle' THEN 'lle' ELSE 'sal' END;
    v_dir := CASE WHEN v_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
    -- Solo reservas vivas de la organización y que no estén en una vuelta arrancada.
    SELECT array_agg(x.rid ORDER BY x.ord), min(x.at)
      INTO v_ids, v_first
      FROM (SELECT (s->>'reservation_id')::uuid AS rid, (s->>'at')::timestamptz AS at, o AS ord
              FROM jsonb_array_elements(coalesce(b->'stops', '[]'::jsonb)) WITH ORDINALITY AS t(s, o)) x
      JOIN public.reservations r ON r.id = x.rid
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE pr.organization_id = v_org AND r.cancelled_at IS NULL AND r.direction = v_dir
       AND NOT (x.rid = ANY (v_busy)) AND NOT (x.rid = ANY (v_used));
    v_skipped := v_skipped + coalesce(jsonb_array_length(b->'stops'), 0) - coalesce(cardinality(v_ids), 0);
    IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN CONTINUE; END IF;
    v_used := v_used || v_ids;
    v_total := v_total + 1;
    v_sig := v_dir::text || ':' || (SELECT string_agg(u::text, ',' ORDER BY u::text) FROM unnest(v_ids) u);
    v_dead := nullif(b->>'deadline_at', '')::timestamptz;
    v_flight := nullif(btrim(b->>'flight'), '');
    -- La llegada sale de JMC cuando el tripulante ya bajó: aterrizaje + desembarque (0058/0099).
    v_start := CASE WHEN v_type = 'lle'
                    THEN v_first + make_interval(mins => coalesce(public.flight_deplane_min(v_flight), 15))
                    ELSE v_first END;

    -- ¿Ya estaba esta misma vuelta (las mismas personas)? Se conserva, con su conductor.
    SELECT ra.id INTO v_ra
      FROM public.route_assignments ra
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND (ra.direction::text || ':' || (SELECT string_agg(rs.reservation_id::text, ',' ORDER BY rs.reservation_id::text)
                                           FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)) = v_sig
     LIMIT 1;
    IF v_ra IS NOT NULL THEN
      UPDATE public.route_assignments
         SET planned_start_at = v_start, deadline_at = v_dead, manual_note = nullif(btrim(b->>'note'), ''), updated_at = now()
       WHERE id = v_ra;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at,
                                            pool, organization_id, manual_day, deadline_at, manual_note)
      VALUES (NULL, NULL, v_dir, 'planned', v_start, true, v_org, p_day, v_dead, nullif(btrim(b->>'note'), ''))
      RETURNING id INTO v_ra;
      v_created := v_created + 1;
    END IF;
    v_keep := v_keep || v_ra;

    -- Las paradas, en el orden del jefe (se reescriben: orden y horas pueden cambiar).
    -- Primero se corren a números altos para no chocar con el UNIQUE del orden.
    UPDATE public.route_stops SET stop_order = stop_order + 1000 WHERE route_assignment_id = v_ra;
    i := 0;
    FOR st IN SELECT s FROM jsonb_array_elements(b->'stops') AS t(s) LOOP
      CONTINUE WHEN NOT ((st->>'reservation_id')::uuid = ANY (v_ids));
      i := i + 1;
      v_at := CASE WHEN v_type = 'lle' THEN NULL ELSE (st->>'at')::timestamptz END;
      IF EXISTS (SELECT 1 FROM public.route_stops WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid) THEN
        UPDATE public.route_stops SET stop_order = i, estimated_arrival_at = v_at
         WHERE route_assignment_id = v_ra AND reservation_id = (st->>'reservation_id')::uuid;
      ELSE
        INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES (v_ra, (st->>'reservation_id')::uuid, i, v_at);
      END IF;
    END LOOP;
    DELETE FROM public.route_stops WHERE route_assignment_id = v_ra AND stop_order > 1000;

    -- Avisarle a cada uno su hora (una vez por hora: volver a pegar sin cambios no repite).
    FOR v_res IN
      SELECT r.id, r.direction, ap.profile_id AS crew, rs.estimated_arrival_at AS at, f.flight_number
        FROM public.route_stops rs
        JOIN public.reservations r ON r.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        LEFT JOIN public.flights f ON f.id = r.flight_id
       WHERE rs.route_assignment_id = v_ra
    LOOP
      IF v_res.direction = 'home_to_airport' THEN
        v_title := 'Tu recogida está lista 🚗';
        v_body := 'Te recogemos a las ' || public.hm_bog(v_res.at)
          || CASE WHEN v_dead IS NOT NULL THEN ' para estar en JMC a las ' || public.hm_bog(v_dead) ELSE '' END
          || '. Te avisamos quién te recoge.';
      ELSE
        v_title := 'Tu regreso está listo 🚗';
        v_body := 'Cuando aterrices te esperamos en JMC (sale hacia las ' || public.hm_bog(v_start) || '). Te avisamos quién te recoge.';
      END IF;
      IF public.trip_notify(v_res.crew, v_title, v_body, '/#/viaje?r=' || v_res.id::text,
                            'manual:' || v_res.id::text || ':' || to_char(coalesce(v_res.at, v_start) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI')) THEN
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
    v_ra := NULL;
  END LOOP;

  -- Lo que Julián puso manda: esas personas salen de las vueltas del TABLERO que
  -- no han arrancado (si no, quedarían en dos carros); la que queda vacía se va.
  WITH quitadas AS (
    DELETE FROM public.route_stops rs USING public.route_assignments ra
     WHERE rs.route_assignment_id = ra.id AND NOT ra.pool AND rs.reservation_id = ANY (v_used)
       AND ra.status IN ('draft', 'planned') AND rs.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
    RETURNING rs.route_assignment_id)
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]), count(*) INTO v_tocadas, v_tablero FROM quitadas;
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_tocadas) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);

  -- Lo de este día que ya no está en la ruta: fuera, si no ha arrancado.
  FOR v_old IN
    SELECT ra.id, ra.driver_profile_id, dp.profile_id AS drv_profile, ra.planned_start_at
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.pool AND ra.organization_id = v_org AND ra.manual_day = p_day
       AND ra.status IN ('draft', 'planned') AND NOT (ra.id = ANY (v_keep))
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND x.status <> 'pending')
  LOOP
    DELETE FROM public.route_assignments WHERE id = v_old.id;
    v_removed := v_removed + 1;
    IF v_old.drv_profile IS NOT NULL THEN
      PERFORM public.trip_notify(v_old.drv_profile, 'Cambió una vuelta que tomaste',
        'Julián cambió la vuelta de las ' || public.hm_bog(v_old.planned_start_at) || '. Revisa las vueltas disponibles.',
        '/#/ruta', 'manualdrop:' || v_old.id::text);
    END IF;
  END LOOP;

  -- Lo que el jefe eligió a mano se aprende para la próxima vez.
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    JOIN public.auxiliar_profiles ap ON ap.id = (a->>'auxiliar_profile_id')::uuid
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();

  -- Los conductores: hay vueltas para tomar (una vez por ruta pegada).
  IF v_created > 0 THEN
    SELECT count(*) INTO v_drivers FROM (
      SELECT public.trip_notify(p.id, 'Hay vueltas para tomar',
               'Julián publicó la ruta del ' || to_char(p_day, 'DD/MM') || ': ' || v_total || ' vueltas. Toma las tuyas en Ruta.',
               '/#/ruta', 'manualpool:' || v_org::text || ':' || p_day::text || ':' || md5(array_to_string(v_keep, ',')) || ':' || p.id::text) AS ok
        FROM public.profiles p
       WHERE p.organization_id = v_org AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false) z
     WHERE z.ok;
  END IF;

  PERFORM public.trip_kick();
  RETURN jsonb_build_object('created', v_created, 'kept', v_kept, 'removed', v_removed, 'skipped', v_skipped,
                            'notified', v_notified, 'drivers', v_drivers, 'vueltas', v_total, 'from_board', v_tablero);
END;
$$;

DROP FUNCTION IF EXISTS public.driver_set_guest_stop_status(uuid, text);
-- En dos pasos: dentro de UNA instrucción, el segundo DELETE todavía vería las
-- paradas que el primero borró (la foto es la del inicio de la instrucción).
DO $do$
DECLARE v_ras uuid[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT route_assignment_id), ARRAY[]::uuid[]) INTO v_ras
    FROM public.route_stops WHERE reservation_id IS NULL;
  DELETE FROM public.route_stops WHERE reservation_id IS NULL;
  DELETE FROM public.route_assignments ra
   WHERE ra.id = ANY (v_ras) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id);
END
$do$;
ALTER TABLE public.route_stops DROP CONSTRAINT IF EXISTS route_stops_reserva_o_sin_cuenta;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_lng;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_lat;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_residence_id;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_phone;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_place;
ALTER TABLE public.route_stops DROP COLUMN IF EXISTS guest_name;
ALTER TABLE public.route_stops ALTER COLUMN reservation_id SET NOT NULL;
COMMIT;
