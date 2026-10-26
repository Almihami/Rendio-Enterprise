-- =============================================================================
-- 0136 · Aviso a los jefes cuando un conductor INICIA una vuelta (26-oct-2026)
-- =============================================================================
-- Pedido de la profa (26-oct-2026), sobre el de 0128: «debe ser cuando inicia y
-- cuando termina, es lo ideal». 0128 ya avisa al terminar; esto avisa al arrancar.
--
--   🚗 Miguel Peña inició una vuelta
--      Salida de las 4:15 · recoge a Laura Gómez, Sara Ríos
--   🚗 Julián López inició una vuelta
--      Llegada de las 16:05 · recoge a Isabela Rivera en el aeropuerto
--
-- CUÁNDO INICIA. Cuando el conductor toca «Iniciar ruta». Hasta hoy ese botón solo
-- le decía algo a la base en una SALIDA (la primera recogida queda «en camino»); en
-- una LLEGADA no escribía nada hasta «Llegué al aeropuerto». Por eso hay una RPC
-- nueva, driver_route_started, que la app llama al tocar el botón (SW v222).
--
-- RED DE SEGURIDAD. Un teléfono con la app vieja (sin v222) no llama la RPC. Para
-- ese caso, un disparador en route_stops avisa con la PRIMERA marca de la vuelta
-- (llegué a la primera casa, o «Llegué al aeropuerto» en una llegada): un poco más
-- tarde que el botón, pero no se queda sin aviso.
--
-- UNA VEZ POR VUELTA Y POR JEFE. Llave ini:<vuelta>:<jefe>, mirando la bandeja
-- entera (como trip_notify): el botón y la marca no avisan dos veces, ni tocar
-- «Iniciar ruta» de nuevo tras reinstalar la app.
--
-- NO AVISA A MEDIA VUELTA. Si ya hay alguien a bordo, entregado o «no se presentó»
-- la vuelta arrancó hace rato: no se avisa (así, las vueltas que van en curso
-- cuando se aplique esto no mandan un «inició» tarde). Una vuelta con todas sus
-- reservas canceladas tampoco avisa.
--
-- SALE YA. Sin los 2 min de gracia de 0128 (no hay «Deshacer» de un inicio):
-- trip_kick lo despacha en el momento; si no se puede, lo recoge el reloj del
-- minuto. A los de ops_alert_recipients_of (los marcados en Personal; si nadie,
-- todos los jefes activos), como 0128.
--
-- NUNCA FRENA AL CONDUCTOR. Si algo falla al armar el aviso, la marca de la parada
-- se guarda igual y la RPC devuelve false (EXCEPTION → NOTICE).
--
-- NO SE TOCA: el estado de la vuelta (route_assignments.status sigue como esté),
-- driver_set_reservation_status, driver_mark_airport_arrival ni 0128. Depende de
-- 0097 (trip_kick), 0117 (ops_alert_recipients_of), 0125 (hm_bog, short_name,
-- route_assignments.organization_id) y 0133 (route_stops.guest_name).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Armar y encolar el aviso (lo llaman la RPC y el disparador)
-- ---------------------------------------------------------------------------
-- p_except: la parada que está cambiando en el disparador (puede pasar de
-- pendiente a «no se presentó» de una; no cuenta como «ya arrancó»).
-- Devuelve cuántos avisos encoló.
CREATE OR REPLACE FUNCTION public.route_started_alert_enqueue(p_ra uuid, p_except uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ra     record;
  v_org    uuid;
  v_nombres text;
  v_hora   text;
  v_titulo text;
  v_cuerpo text;
  v_n      int := 0;
  j        record;
BEGIN
  IF p_ra IS NULL THEN RETURN 0; END IF;
  -- El botón y la primera marca pueden llegar casi juntos: en fila.
  PERFORM pg_advisory_xact_lock(hashtext('ini-vuelta:' || p_ra::text));

  -- ¿Ya arrancó hace rato? (alguien a bordo, entregado o «no se presentó»)
  IF EXISTS (SELECT 1 FROM public.route_stops rs
               LEFT JOIN public.reservations r ON r.id = rs.reservation_id
              WHERE rs.route_assignment_id = p_ra
                AND rs.id IS DISTINCT FROM p_except
                AND (r.id IS NULL OR r.cancelled_at IS NULL)
                AND rs.status IN ('picked_up', 'delivered', 'no_show')) THEN
    RETURN 0;
  END IF;

  SELECT ra.id, ra.direction, ra.organization_id, ra.planned_start_at,
         pd.full_name AS conductor, pd.organization_id AS org_conductor,
         (SELECT min(rs.estimated_arrival_at) FROM public.route_stops rs
           WHERE rs.route_assignment_id = ra.id) AS t0
    INTO v_ra
    FROM public.route_assignments ra
    LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
    LEFT JOIN public.profiles pd        ON pd.id = dp.profile_id
   WHERE ra.id = p_ra
     AND ra.status IN ('planned', 'in_progress');
  IF v_ra.id IS NULL THEN RETURN 0; END IF;

  -- La organización, como 0128: la de la vuelta; si no (vueltas del tablero), la
  -- del conductor; si no, la de un tripulante de la vuelta.
  v_org := coalesce(v_ra.organization_id, v_ra.org_conductor, (
    SELECT pr.organization_id
      FROM public.route_stops rs
      JOIN public.reservations res     ON res.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
      JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = v_ra.id
     LIMIT 1));
  IF v_org IS NULL THEN RETURN 0; END IF;

  -- A quiénes va a recoger, en el orden de la vuelta (con los sin cuenta de 0133).
  SELECT string_agg(public.short_name(coalesce(pr.full_name, rs.guest_name)), ', ' ORDER BY rs.stop_order)
    INTO v_nombres
    FROM public.route_stops rs
    LEFT JOIN public.reservations res     ON res.id = rs.reservation_id
    LEFT JOIN public.auxiliar_profiles ap ON ap.id = res.auxiliar_profile_id
    LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
   WHERE rs.route_assignment_id = v_ra.id
     AND (res.id IS NULL OR res.cancelled_at IS NULL);
  -- Una vuelta sin nadie (todas canceladas) no es un servicio.
  IF v_nombres IS NULL THEN RETURN 0; END IF;

  -- La hora con la que los jefes nombran la vuelta (la misma de 0128).
  v_hora := public.hm_bog(CASE WHEN v_ra.direction = 'airport_to_home'
                               THEN coalesce(v_ra.planned_start_at, v_ra.t0)
                               ELSE coalesce(v_ra.t0, v_ra.planned_start_at) END);
  v_titulo := '🚗 '
           || CASE WHEN coalesce(btrim(v_ra.conductor), '') = '' THEN 'Un conductor'
                   ELSE public.short_name(v_ra.conductor) END
           || ' inició una vuelta';
  v_cuerpo := CASE WHEN v_ra.direction = 'home_to_airport' THEN 'Salida' ELSE 'Llegada' END
           || coalesce(' de las ' || v_hora, '')
           || ' · recoge a ' || v_nombres
           || CASE WHEN v_ra.direction = 'airport_to_home' THEN ' en el aeropuerto' ELSE '' END;

  FOR j IN SELECT r.profile_id FROM public.ops_alert_recipients_of(v_org) r LOOP
    -- Ya enviado (o ya en cola): no se repite.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.notification_outbox o
                           WHERE o.dedupe_key = 'ini:' || v_ra.id::text || ':' || j.profile_id::text);
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    VALUES (j.profile_id, v_titulo, left(v_cuerpo, 300), '/#/operacion',
            'ini:' || v_ra.id::text || ':' || j.profile_id::text)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN v_n := v_n + 1; END IF;
  END LOOP;

  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.route_started_alert_enqueue(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.route_started_alert_enqueue(uuid, uuid)
  IS '0136: encola a los jefes (ops_alert_recipients_of) «🚗 X inició una vuelta», una vez por vuelta y jefe (ini:<vuelta>:<jefe>). No avisa si la vuelta ya tiene a alguien a bordo, entregado o «no se presentó», ni si todas sus reservas están canceladas.';

-- ---------------------------------------------------------------------------
-- 2. RPC del conductor: «Iniciar ruta»
-- ---------------------------------------------------------------------------
-- Devuelve true si encoló el aviso. Una vuelta que no es suya (o que se volvió a
-- publicar y ya no existe) devuelve false sin error: es un aviso, no una marca, y
-- no debe aparecerle al conductor como «No se pudo guardar».
CREATE OR REPLACE FUNCTION public.driver_route_started(p_route_assignment_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver uuid := public.current_driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'solo un conductor puede iniciar una vuelta' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.route_assignments ra
                  WHERE ra.id = p_route_assignment_id AND ra.driver_profile_id = v_driver
                    AND ra.status IN ('planned', 'in_progress')) THEN
    RETURN false;
  END IF;
  BEGIN
    RETURN public.route_started_alert_enqueue(p_route_assignment_id) > 0;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'driver_route_started: no se armó el aviso de la vuelta % (%)', p_route_assignment_id, SQLERRM;
    RETURN false;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.driver_route_started(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_route_started(uuid) TO authenticated;

COMMENT ON FUNCTION public.driver_route_started(uuid)
  IS '0136: el conductor tocó «Iniciar ruta» en una vuelta suya: avisa a los jefes «🚗 X inició una vuelta» (una sola vez). false si no es suya o no hubo a quién avisar.';

-- ---------------------------------------------------------------------------
-- 3. Red de seguridad: la primera marca de la vuelta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_started_alert()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM public.route_started_alert_enqueue(NEW.route_assignment_id, NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'route_started_alert: no se armó el aviso de la vuelta % (%)', NEW.route_assignment_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.route_started_alert() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.route_started_alert()
  IS '0136: cuando una parada sale de «pendiente», avisa «X inició una vuelta» si nadie lo había avisado (teléfonos sin v222, que no llaman driver_route_started). Nunca frena la marca.';

-- Solo cuando una parada SALE de pendiente (OLD pendiente, NEW otra cosa).
CREATE OR REPLACE TRIGGER tr_route_stops_started_alert
  AFTER UPDATE OF status ON public.route_stops
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status IS DISTINCT FROM 'pending')
  EXECUTE FUNCTION public.route_started_alert();

COMMIT;
