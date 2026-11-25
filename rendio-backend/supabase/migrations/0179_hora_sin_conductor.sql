-- =============================================================================
-- 0179 · La hora de recogida se dice aunque la vuelta no tenga conductor
-- =============================================================================
-- 24-nov-2026, 9:30 p. m. «Están reportando que no ven la hora». Leído en producción:
-- Cris publicó el miércoles 25 a las 8:01 p. m. (marca 0178 puesta); de 35 salidas, 27
-- veían la hora y 8 no. Las 8 iban en 5 vueltas del «Carro 3» y el «Carro 4» que el
-- tablero dejó en BORRADOR, sin conductor: 4:05 (Andrea Núñez 4:05, Alejandra Romero
-- 4:15, Gersey 4:25), 9:20, 10:55 (Carlos 10:55, Jessica 11:10), 11:25 y 13:10. Cada
-- parada YA tenía su hora en el plan; la app la escondía porque auxiliar_my_trips solo
-- daba hora con conductor, pool o delegada. Alejandra abrió la app 36 veces esa noche.
--
-- Harold: «tenga o no conductor, debería mostrar la hora, ¿por qué está esperando al
-- conductor? No tiene sentido».
--
-- Qué cambia (solo auxiliar_my_trips):
--   · Una SALIDA en una vuelta sin conductor (borrador de un jefe, no automática) cuenta
--     como publicada si la ruta de su día ya está publicada (dia_publicado, 0178).
--   · Su hora es la de su parada en el plan (route_stops.estimated_arrival_at): en el
--     borrador calculated_pickup_at está vacía. Con conductor sigue siendo la de siempre.
--   · driver_pending = true: la app dice «Tu ruta está lista · Te avisamos quién te
--     recoge…». Sin código de encuentro ni carro (no hay con quién encontrarse).
--   · Su lugar en el carro («Recogida 2/3») se cuenta dentro de su vuelta.
-- Antes de publicar el día nada cambia: el borrador sigue sin hora («te avisamos la hora
-- cuando armemos tu ruta»). Las llegadas no cambian (no quedan en borrador, 0175).
--
-- El aviso «Tu hora de recogida» al publicar lo manda el teléfono del jefe (api.js
-- saveRoutePlan → horasBorrador, admin-rutas.js), no esta migración.
--
-- Deshacer: down_migrations/0179_hora_sin_conductor.down.sql (la función de antes).
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.auxiliar_my_trips(p_days_back integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_days int  := least(greatest(coalesce(p_days_back, 60), 1), 400);
  -- 0179: para saber si la ruta del día de una vuelta sin conductor ya está publicada.
  v_org  uuid := (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid());
BEGIN
  IF v_aux IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.ts, x.id)
    FROM (
      SELECT r.required_arrival_at AS ts, r.id,
        jsonb_build_object(
          'id',                    r.id,
          'direction',             r.direction,
          'required_arrival_at',   r.required_arrival_at,
          'date',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
          'time',                  to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'HH24:MI'),
          'raw_status',            k.raw,
          'cancelled_at',          r.cancelled_at,
          'cancellation_reason',   r.cancellation_reason,
          'notes',                 r.notes,
          'notes_user',            public.notes_without_flight(r.notes),
          'flight_number',         f.flight_number,
          'pickup_address',        r.pickup_address,
          'pickup_latitude',       r.pickup_latitude,
          'pickup_longitude',      r.pickup_longitude,
          'residence_id',          r.residence_id,
          'residence_unit',        r.residence_unit,
          'meeting_point',         r.meeting_point,
          'is_overnight',          r.is_overnight,
          'is_firm',               r.is_firm,
          'ready_confirmed_at',    r.ready_confirmed_at,
          'service_level',         r.service_level,
          'private_status',        r.private_status,
          'price_cop',             r.price_cop,
          'private_reject_reason', r.private_reject_reason,
          'rating',                r.rating,
          'bags',                  r.bags,
          'quiet_ride',            r.quiet_ride,
          'created_at',            r.created_at,
          'ground_ops',            r.ground_ops,
          'reserve_place',         r.reserve_place,          -- 0121: de reserva en Río Verde / Movich / Aero
          'published',             k.pub,
          'pickup_at',             CASE WHEN k.pub THEN CASE WHEN k.borr THEN s.eta ELSE r.calculated_pickup_at END END,
          -- 0179: el código es para encontrarse con el conductor: sin conductor no se dice.
          'meet_code',             CASE WHEN k.pub AND NOT k.borr THEN r.meet_code END,
          'pickup_pos',            CASE WHEN k.pub THEN po.pos END,
          'pickup_total',          CASE WHEN k.pub THEN po.total END,
          'stop_status',           s.stop_status,
          'arrived_at',            s.arr,
          'picked_at',             s.pick,
          'dropped_at',            s.dropped,
          -- 0125: publicada y sin conductor (la vuelta pegada que nadie ha tomado).
          -- 0126: la delegada NO cuenta: nadie de Rendio la va a tomar.
          'driver_pending',        (k.pub AND s.drv IS NULL AND s.deleg IS NULL),
          -- 0126: la vuelta la hace alguien de afuera; lo contactan por WhatsApp.
          'delegated',             (k.pub AND s.deleg IS NOT NULL),
          -- 0131: a quién se delegó («Te recogerá X, su número es Y»). El teléfono, solo
          -- mientras el viaje no haya terminado (como el del conductor).
          'delegate',              CASE WHEN k.pub AND s.deleg IS NOT NULL AND s.dname IS NOT NULL
                                        THEN jsonb_build_object('name', s.dname, 'phone', CASE WHEN NOT k.closed THEN s.dphone END) END,
          'driver', CASE WHEN s.ra_id IS NULL OR s.drv IS NULL THEN NULL ELSE jsonb_build_object(
              'name',       pr.full_name,
              'avatar_url', pr.avatar_url,
              'phone',      CASE WHEN NOT k.closed AND s.ra_status <> 'completed' THEN pr.phone END,
              'rating',     CASE WHEN rt.n >= 10 THEN round(rt.avg, 1) END,
              'rating_n',   coalesce(rt.n, 0)) END,
          'vehicle', CASE WHEN s.ra_id IS NULL OR v.id IS NULL OR k.borr THEN NULL ELSE jsonb_build_object(
              'plate', coalesce(v.license_plate, v.internal_code),
              'brand', v.brand, 'model', v.model, 'color', v.color) END
        ) AS j
      FROM public.reservations r
      LEFT JOIN public.flights f ON f.id = r.flight_id
      LEFT JOIN LATERAL (
        SELECT ra.id AS ra_id, ra.status AS ra_status, ra.driver_profile_id AS drv, ra.vehicle_id AS veh,
               ra.direction AS ra_dir, ra.planned_start_at AS ra_start,   -- 0093: para juntar la vuelta del carro
               ra.delegated_at AS deleg,                                  -- 0126: la hace alguien de afuera
               ra.delegate_name AS dname, ra.delegate_phone AS dphone,      -- 0131: quién la hace y su número
               rs.status AS stop_status, rs.actual_arrival_at AS arr,
               rs.actual_pickup_at AS pick, rs.actual_dropoff_at AS dropped,
               rs.estimated_arrival_at AS eta                              -- 0179: la hora de mi parada en el plan
        FROM public.route_stops rs
        JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
        WHERE rs.reservation_id = r.id
          AND (((ra.driver_profile_id IS NOT NULL OR ra.pool OR ra.delegated_at IS NOT NULL)   -- 0125 pegada · 0126 delegada
                 AND ra.status IN ('planned', 'in_progress', 'completed'))
               -- 0179 (24-nov-2026, Harold: «tenga o no conductor, debería mostrar la hora»):
               -- la salida en una vuelta SIN conductor (borrador del jefe: «Carro 3») de un
               -- día cuya ruta el jefe ya publicó (marca 0178). La hora es la del plan; el
               -- conductor es asunto del jefe. Antes de publicar, nada cambia: sin hora.
               OR (ra.status = 'draft' AND NOT coalesce(ra.auto_created, false)
                   AND ra.direction = 'home_to_airport'
                   AND public.dia_publicado(v_org, ra.planned_start_at)))
        ORDER BY ra.planned_start_at DESC NULLS LAST
        LIMIT 1
      ) s ON true
      CROSS JOIN LATERAL (
        SELECT COALESCE(r.status_h2a::text, r.status_a2h::text) AS raw,
               (s.ra_status IN ('planned', 'in_progress', 'draft')) IS TRUE AS pub,
               (s.ra_status = 'draft') IS TRUE AS borr,                   -- 0179: publicada sin conductor
               (r.cancelled_at IS NOT NULL
                 OR COALESCE(r.status_h2a::text, r.status_a2h::text) IN ('delivered', 'no_show', 'cancelled')) AS closed
      ) k
      -- El tramo de MI ruta en el tiempo: de su arranque a la última hora
      -- estimada de sus paradas (greatest ignora los NULL: sin horas estimadas
      -- el tramo es solo el arranque). Solo con la ruta publicada.
      LEFT JOIN LATERAL (
        SELECT greatest(s.ra_start, max(ms.estimated_arrival_at)) AS w1
        FROM public.route_stops ms
        WHERE k.pub AND ms.route_assignment_id = s.ra_id
      ) sw ON true
      -- Mi lugar en el carro: solo con la ruta publicada, sobre la VUELTA DEL
      -- CARRO: mi route_assignment («s») y las otras publicadas del mismo
      -- vehículo y dirección cuyo tramo se cruza con el mío (la que quedó en
      -- curso + la que saveRoutePlan le creó al lado al republicar). Misma
      -- dirección, sin cancelados ni no-show; una reserva en dos rutas cuenta
      -- una vez. Si yo quedé fuera, no hay fila → NULL.
      LEFT JOIN LATERAL (
        SELECT o.pos, o.total
        FROM (
          SELECT cv.reservation_id,
                 -- Una sola ruta: stop_order. Varias: la hora estimada de cada
                 -- parada manda (el plan), luego el arranque y stop_order.
                 row_number() OVER (ORDER BY CASE WHEN cv.varias THEN cv.t_k END,
                                             cv.ra_start, cv.stop_order, cv.id)::int AS pos,
                 (count(*) OVER ())::int AS total
          FROM (
            SELECT cand.*, bool_or(cand.ra_id <> s.ra_id) OVER () AS varias
            FROM (
              SELECT DISTINCT ON (rs2.reservation_id)
                     rs2.reservation_id, rs2.id, rs2.stop_order,
                     ra2.id AS ra_id, ra2.planned_start_at AS ra_start,
                     coalesce(rs2.estimated_arrival_at, ra2.planned_start_at) AS t_k
              FROM public.route_assignments ra2
              JOIN public.route_stops rs2 ON rs2.route_assignment_id = ra2.id
              JOIN public.reservations r2 ON r2.id = rs2.reservation_id
              WHERE k.pub
                AND (ra2.id = s.ra_id
                     OR (NOT k.borr AND ra2.vehicle_id = s.veh
                         AND ra2.direction = s.ra_dir
                         AND (ra2.driver_profile_id IS NOT NULL OR ra2.pool OR ra2.delegated_at IS NOT NULL)
                         AND ra2.status IN ('planned', 'in_progress', 'completed')
                         AND ra2.planned_start_at <= sw.w1
                         AND s.ra_start <= (
                               SELECT greatest(ra2.planned_start_at, max(os.estimated_arrival_at))
                               FROM public.route_stops os
                               WHERE os.route_assignment_id = ra2.id)))
                AND r2.direction = r.direction
                AND r2.cancelled_at IS NULL
                AND rs2.status <> 'no_show'
                AND COALESCE(r2.status_h2a::text, r2.status_a2h::text, '') NOT IN ('cancelled', 'no_show')
              -- Si una reserva quedara en dos rutas: la mía primero, si no la más reciente.
              ORDER BY rs2.reservation_id, (ra2.id = s.ra_id) DESC, ra2.planned_start_at DESC NULLS LAST
            ) cand
          ) cv
        ) o
        WHERE o.reservation_id = r.id
      ) po ON true
      LEFT JOIN public.driver_profiles dp ON dp.id = s.drv
      LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
      LEFT JOIN public.vehicles v         ON v.id = s.veh
      LEFT JOIN LATERAL public.driver_rating_summary(s.drv) rt ON s.drv IS NOT NULL
      WHERE r.auxiliar_profile_id = v_aux
        AND (r.required_arrival_at >= now() - make_interval(days => v_days) OR NOT k.closed)
    ) x
  ), '[]'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.auxiliar_my_trips(integer)
  IS '0179: los viajes del tripulante; la salida en una vuelta sin conductor de un día publicado trae la hora de su parada.';

COMMIT;
