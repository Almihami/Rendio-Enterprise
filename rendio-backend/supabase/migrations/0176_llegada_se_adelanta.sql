-- 0176 · Una llegada se adelanta cuando alguien sale de ella (17-nov-2026)
--
-- Harold, con la llegada de Nicol (AV9259, aterrizó 22:55) que salía de JMC a las
-- 23:17: «no tiene sentido, si es una persona ¿por qué va a esperar?». Esa vuelta
-- tenía las 23:17 por Sara (P57290, 22:57 + desembarque). A las 23:05 el acomodo sacó
-- a Sara (su vuelo venía 30 min tarde) y la vuelta se quedó a las 23:17: el sistema
-- solo corre las vueltas hacia MÁS TARDE, nunca las adelanta cuando alguien sale.
--
-- Ahora, cuando sale alguien de una llegada (vuelo tarde, «pasar a otra vuelta»,
-- «Soltar», cancelar, el tablero que la saca de una vuelta del sistema…: todos borran
-- su parada), la vuelta se recalcula con los que QUEDAN: sale cuando sale del terminal
-- el último (aterrizaje real de FlightRadar24 si se sabe, si no la hora pedida; más el
-- desembarque; sin desembarque en tierra o reserva), al múltiplo de 5 de arriba, como
-- el combo de 0171 y el acomodo. Solo se ADELANTA (5 min o más), y solo si:
--   · es una llegada planeada, sin delegar, que no ha arrancado (todas las paradas pendientes);
--   · todos los que quedan tienen cuenta (de un pasajero sin cuenta no se sabe la hora);
--   · la hora nueva es de aquí a 10 min o más tarde;
--   · el conductor, si tiene, alcanza a estar en JMC (reub_conductor_libre, sus otras vueltas).
-- Al conductor le llega «Tu llegada sale antes 🕒»; a quien no viene en vuelo (tierra,
-- reserva), «Cambió la hora de tu regreso 🕒» con el lugar (a los de vuelo no se les
-- promete hora de salida: 0171). Scripts que no quieran esto: set_config('rendio.no_adelantar','on',true).
-- Funciones nuevas: no copia ninguna. Usa reub_baja, reub_arriba5, flight_deplane_min,
-- reub_extremos, reub_conductor_libre (0135), lugar_del_regreso (0147), trip_notify, hm_bog.

BEGIN;

CREATE OR REPLACE FUNCTION public.llegada_adelantar(p_ra uuid, p_salio uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ra record; e record; k record;
  v_new timestamptz; v_n int; v_quedan text; v_delta interval;
  v_drv_prof uuid; v_quien text; v_sello text;
BEGIN
  IF coalesce(current_setting('rendio.no_adelantar', true), '') = 'on' OR p_ra IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO ra FROM public.route_assignments WHERE id = p_ra FOR UPDATE;
  IF NOT FOUND OR ra.direction <> 'airport_to_home' OR ra.status <> 'planned' OR ra.delegated_at IS NOT NULL THEN RETURN NULL; END IF;
  IF ra.planned_start_at <= now() + interval '10 minutes' THEN RETURN NULL; END IF;
  -- Ya arrancó (alguien marcado) o va un pasajero sin cuenta: no se toca.
  IF EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = p_ra AND (x.status <> 'pending' OR x.reservation_id IS NULL)) THEN RETURN NULL; END IF;

  SELECT max(public.reub_arriba5(
           coalesce(public.reub_baja(coalesce(ra.organization_id, p.organization_id), r.flight_code, r.required_arrival_at), r.required_arrival_at)
           + make_interval(mins => CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0
                                        ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END))),
         count(*)::int,
         string_agg(split_part(p.full_name, ' ', 1), ', ' ORDER BY x.stop_order)
    INTO v_new, v_n, v_quedan
    FROM public.route_stops x
    JOIN public.reservations r ON r.id = x.reservation_id
    JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
    JOIN public.profiles p ON p.id = ap.profile_id
   WHERE x.route_assignment_id = p_ra AND r.cancelled_at IS NULL;
  IF coalesce(v_n, 0) = 0 OR v_new IS NULL THEN RETURN NULL; END IF;
  v_new := greatest(v_new, public.reub_arriba5(now() + interval '10 minutes'));
  IF v_new > ra.planned_start_at - interval '5 minutes' THEN RETURN NULL; END IF;
  v_delta := v_new - ra.planned_start_at;

  -- Con conductor: solo si le alcanza (sus otras vueltas, el tiempo de llegar a JMC).
  IF ra.driver_profile_id IS NOT NULL THEN
    SELECT * INTO e FROM public.reub_extremos(p_ra);
    IF e.ini_at IS NULL OR NOT public.reub_conductor_libre(ra.driver_profile_id, p_ra, NULL,
         e.ini_at + v_delta, e.ini_res, e.ini_lat, e.ini_lng, e.ini_air,
         coalesce(e.fin_at, e.ini_at) + v_delta, e.fin_res, e.fin_lat, e.fin_lng, e.fin_air) THEN
      RETURN NULL;
    END IF;
  END IF;

  UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + v_delta
   WHERE route_assignment_id = p_ra AND estimated_arrival_at IS NOT NULL;
  UPDATE public.route_assignments SET planned_start_at = v_new, updated_at = now() WHERE id = p_ra;

  v_sello := to_char(v_new AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI');
  SELECT split_part(p.full_name, ' ', 1) INTO v_quien
    FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
   WHERE r.id = p_salio;
  IF ra.driver_profile_id IS NOT NULL THEN
    SELECT dp.profile_id INTO v_drv_prof FROM public.driver_profiles dp WHERE dp.id = ra.driver_profile_id;
    IF v_drv_prof IS NOT NULL THEN
      PERFORM public.trip_notify(v_drv_prof, 'Tu llegada sale antes 🕒',
        coalesce(v_quien || ' ya no va. ', '') || 'Tu llegada de las ' || public.hm_bog(ra.planned_start_at)
        || ' ahora sale de JMC a las ' || public.hm_bog(v_new) || ' con ' || v_quedan || '.',
        '/', 'adelanta:' || p_ra::text || ':' || v_sello);
    END IF;
  END IF;
  -- A quien no viene en un vuelo (tierra, reserva) sí se le dijo una hora: se le avisa la nueva.
  FOR k IN
    SELECT r.id, ap.profile_id AS crew, public.lugar_del_regreso(r.id) AS donde
      FROM public.route_stops x JOIN public.reservations r ON r.id = x.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
     WHERE x.route_assignment_id = p_ra AND r.cancelled_at IS NULL
  LOOP
    CONTINUE WHEN k.donde IS NULL;
    PERFORM public.trip_notify(k.crew, 'Cambió la hora de tu regreso 🕒',
      'Te recogemos ' || k.donde || ' hacia las ' || public.hm_bog(v_new) || '.',
      '/#/viaje?r=' || k.id::text, 'adelanta-aux:' || k.id::text || ':' || v_sello);
  END LOOP;
  RETURN jsonb_build_object('id', p_ra, 'de', ra.planned_start_at, 'a', v_new, 'quedan', v_quedan);
END;
$$;
REVOKE ALL ON FUNCTION public.llegada_adelantar(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- El disparador: después de borrar la parada de alguien. Nunca tumba el borrado.
CREATE OR REPLACE FUNCTION public.tg_route_stops_llegada_adelanta()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.reservation_id IS NOT NULL AND OLD.route_assignment_id IS NOT NULL THEN
    BEGIN
      PERFORM public.llegada_adelantar(OLD.route_assignment_id, OLD.reservation_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'llegada_adelantar (vuelta %): %', OLD.route_assignment_id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_route_stops_llegada_adelanta() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_route_stops_llegada_adelanta ON public.route_stops;
CREATE TRIGGER tr_route_stops_llegada_adelanta
  AFTER DELETE ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.tg_route_stops_llegada_adelanta();

COMMIT;
