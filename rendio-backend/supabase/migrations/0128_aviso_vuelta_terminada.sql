-- =============================================================================
-- 0128 · Aviso a los jefes cuando un conductor termina una vuelta (26-oct-2026)
-- =============================================================================
-- Pedido de los jefes (lista del 26-oct-2026): «cada que un conductor termine un
-- servicio que mande una notificación a los jefes indicando qué servicio
-- terminaron».
--
-- CUÁNDO TERMINA. Cuando TODAS sus paradas vivas quedan resueltas: entregada
-- ('delivered') o no se presentó ('no_show'). Es el criterio de Operación y de
-- Asignación (Api._opResultado). Las paradas de una reserva cancelada no cuentan.
-- En una salida la última marca es «Llegamos al aeropuerto» (entrega a los que
-- van a bordo); en una llegada, el último «Entregado» en una casa.
--
-- POR DÓNDE. Un disparador AFTER UPDATE OF status en route_stops: cubre todas las
-- maneras de marcar (driver_set_reservation_status de 0045, las RPC de 0097 y lo
-- que venga) sin copiar ninguna función. Un aviso por vuelta y por jefe, a los de
-- ops_alert_recipients_of (los marcados en Personal; si nadie, todos los activos).
--
--   ✅ Miguel Peña terminó una vuelta
--      Salida de las 4:15 · Laura Gómez, Sara Ríos en el aeropuerto
--   ⚠️ Julián López terminó una vuelta
--      Llegada de las 16:05 · entregó a Isabela Rivera · No se presentó: Dahian Mora
--
-- DOS MINUTOS DE GRACIA. El aviso sale 2 min después (send_after). Si en ese rato
-- la vuelta deja de estar terminada (el «Deshacer» de 0102, una marca corregida),
-- el aviso que no ha salido se borra; si se vuelve a terminar, se encola otra vez.
-- Uno que ya salió no se repite (llave fin:<vuelta>:<jefe>, como trip_notify).
--
-- NUNCA FRENA AL CONDUCTOR. Si algo falla al armar el aviso, la marca de la
-- parada se guarda igual (EXCEPTION → NOTICE).
--
-- DOS MARCAS A LA VEZ. La cola del teléfono puede mandar dos marcas de la misma
-- vuelta casi juntas. Cada una, en su transacción, vería a la otra sin guardar y
-- ninguna avisaría. Un candado por vuelta (pg_advisory_xact_lock) las pone en fila:
-- la segunda espera a la primera y, como en READ COMMITTED cada consulta mira de
-- nuevo, ya la ve. Es un candado consultivo: no choca con los de las filas que
-- toma saveRoutePlan al re-publicar.
--
-- NO SE TOCA: el estado de la vuelta (route_assignments.status sigue como esté),
-- las pantallas ni ninguna función existente. Depende de 0117 (ops_alert_recipients_of)
-- y de 0125 (route_assignments.organization_id, hm_bog, short_name).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.route_finished_alert()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ra     record;
  v_org    uuid;
  v_faltan int;
  v_ok     text;
  v_ns     text;
  v_hora   text;
  v_titulo text;
  v_cuerpo text;
  v_n      int := 0;
  j        record;
BEGIN
  -- Solo importa cuando la parada entra o sale de «resuelta».
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR ((NEW.status IN ('delivered', 'no_show')) = (OLD.status IN ('delivered', 'no_show'))) THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('fin-vuelta:' || NEW.route_assignment_id::text));

    -- ¿Le queda alguna parada viva sin resolver?
    SELECT count(*) INTO v_faltan
      FROM public.route_stops rs
      LEFT JOIN public.reservations r ON r.id = rs.reservation_id
     WHERE rs.route_assignment_id = NEW.route_assignment_id
       AND (r.id IS NULL OR r.cancelled_at IS NULL)
       AND rs.status NOT IN ('delivered', 'no_show');

    IF v_faltan > 0 THEN
      -- Dejó de estar terminada (un «Deshacer»): lo que no ha salido, se borra.
      DELETE FROM public.notification_outbox
       WHERE dedupe_key LIKE 'fin:' || NEW.route_assignment_id::text || ':%'
         AND sent_at IS NULL;
      RETURN NULL;
    END IF;

    SELECT ra.id, ra.direction, ra.organization_id, ra.planned_start_at,
           pd.full_name AS conductor, pd.organization_id AS org_conductor,
           (SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs
             WHERE rs.route_assignment_id = ra.id) AS t0
      INTO v_ra
      FROM public.route_assignments ra
      LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
      LEFT JOIN public.profiles pd        ON pd.id = dp.profile_id
     WHERE ra.id = NEW.route_assignment_id;
    IF v_ra.id IS NULL THEN RETURN NULL; END IF;

    -- La organización: la de la vuelta (0125); si no la tiene (vueltas del
    -- tablero), la del conductor; si no, la de un tripulante de la vuelta.
    v_org := coalesce(v_ra.organization_id, v_ra.org_conductor, (
      SELECT pr.organization_id
        FROM public.route_stops rs
        JOIN public.reservations res     ON res.id = rs.reservation_id
        JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
        JOIN public.profiles pr          ON pr.id = ap.profile_id
       WHERE rs.route_assignment_id = v_ra.id
       LIMIT 1));
    IF v_org IS NULL THEN RETURN NULL; END IF;

    -- Quiénes quedaron entregados y quiénes no se presentaron, en el orden de la vuelta.
    SELECT string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) FILTER (WHERE rs.status = 'delivered'),
           string_agg(public.short_name(pr.full_name), ', ' ORDER BY rs.stop_order) FILTER (WHERE rs.status = 'no_show')
      INTO v_ok, v_ns
      FROM public.route_stops rs
      JOIN public.reservations res          ON res.id = rs.reservation_id
      LEFT JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = v_ra.id
       AND res.cancelled_at IS NULL;
    -- Una vuelta sin nadie (todas canceladas) no es un servicio terminado.
    IF v_ok IS NULL AND v_ns IS NULL THEN RETURN NULL; END IF;

    -- La hora con la que los jefes nombran la vuelta: en una salida, la primera
    -- recogida; en una llegada, la salida del aeropuerto («la llegada de las 16:05»).
    v_hora := public.hm_bog(CASE WHEN v_ra.direction = 'airport_to_home'
                                 THEN coalesce(v_ra.planned_start_at, v_ra.t0)
                                 ELSE coalesce(v_ra.t0, v_ra.planned_start_at) END);
    v_titulo := CASE WHEN v_ns IS NULL THEN '✅ ' ELSE '⚠️ ' END
             || coalesce(public.short_name(v_ra.conductor), 'Un conductor') || ' terminó una vuelta';
    v_cuerpo := CASE WHEN v_ra.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END
             || coalesce(' de las ' || v_hora, '')
             || CASE
                  WHEN v_ok IS NULL THEN ''
                  WHEN v_ra.direction = 'home_to_airport' THEN ' · ' || v_ok || ' en el aeropuerto'
                  ELSE ' · entregó a ' || v_ok
                END
             || coalesce(' · No se presentó: ' || v_ns, '');

    FOR j IN SELECT r.profile_id FROM public.ops_alert_recipients_of(v_org) r LOOP
      -- Ya enviado (o ya en cola): no se repite.
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                             WHERE o.dedupe_key = 'fin:' || v_ra.id::text || ':' || j.profile_id::text);
      INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, send_after)
      VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/#/operacion',
              'fin:' || v_ra.id::text || ':' || j.profile_id::text, now() + interval '2 minutes')
      ON CONFLICT DO NOTHING;
      v_n := v_n + 1;
    END LOOP;
    -- No hace falta trip_kick: el aviso sale dentro de 2 min y lo recoge el
    -- despacho de cada minuto.
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'route_finished_alert: no se armó el aviso de la vuelta % (%)', NEW.route_assignment_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.route_finished_alert() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.route_finished_alert()
  IS '0128: cuando la última parada viva de una vuelta queda entregada o «no se presentó», encola a los jefes (ops_alert_recipients_of) «X terminó una vuelta» con 2 min de gracia; si la vuelta deja de estar terminada antes de salir, lo borra. Nunca frena la marca.';

CREATE OR REPLACE TRIGGER tr_route_stops_finished_alert
  AFTER UPDATE OF status ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.route_finished_alert();

COMMIT;
