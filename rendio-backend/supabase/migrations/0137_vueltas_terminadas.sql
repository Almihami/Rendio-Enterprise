-- =============================================================================
-- 0137 · Las vueltas terminadas salen de la lista y el conductor marca lo que falta
--        (26-oct-2026)
-- =============================================================================
-- Pendientes de los jefes (26-oct, después de v218):
--   · «que una vez finalice el servicio a los 10 minutos desaparezca del listado
--     tanto para administrativo como conductores» («aún veo servicios de la mañana»).
--   · «revisar por qué aparecen servicios en curso a pesar de que ya acabó hace horas».
--
-- La causa de los dos es la misma: la base nunca cierra una vuelta y todo depende
-- de que el conductor marque CADA parada. Si se le olvida el último «entregado», la
-- vuelta queda «en curso» todo el día; las delegadas nadie las marca.
--
-- La pantalla decide con estas dos reglas (Api._opResultado, igual en Asignación,
-- Operación, la ruta de Julián y la app del conductor). Aquí quedan como ajustes,
-- para que el jefe las cambie en Calibración:
--   app_settings.route_done_hide_min (10): minutos que una vuelta terminada sigue
--     a la vista antes de bajar a «terminadas». La delegada, desde su hora de fin.
--   app_settings.route_unmarked_min (30): minutos después de su fin esperado en que
--     una vuelta con paradas sin marcar se da por pasada (gris, «sin marcar») y baja
--     también. Antes de eso sigue a la vista: puede ser una vuelta que va tarde.
--
-- Y para que la lista quede limpia de verdad, al conductor le llega UN aviso cuando
-- su vuelta pasó su fin esperado + route_done_hide_min con paradas sin marcar:
--   ✅ ¿Ya terminaste la vuelta de las 9:05?
--      Te falta marcar a Laura Gómez y Sara Ríos. Toca para marcarlo.
-- route_unmarked_reminders() corre cada 5 min (pg_cron 'route-unmarked-reminders').
--
-- FIN ESPERADO de una vuelta (route_expected_end, la misma cuenta que la pantalla):
--   salida  → la presentación más tardía de su gente (required_arrival_at);
--   llegada → la entrega estimada más tardía (route_stops.estimated_arrival_at,
--             la escribe Publicar); sin ella, salida de JMC + 90 min.
--   Solo sin cuenta (0133) en una salida: la última recogida estimada + 40 min.
--
-- NO SE TOCA ninguna función existente ni ninguna fila: solo columnas nuevas con
-- su valor por defecto, dos funciones nuevas y un reloj. Necesita 0097 (trip_notify,
-- trip_kick), 0125 (hm_bog, short_name) y 0133 (guest_name).
-- Down: down_migrations/0137_vueltas_terminadas.down.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_done_hide_min int NOT NULL DEFAULT 10;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS route_unmarked_min  int NOT NULL DEFAULT 30;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_route_done_hide_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_route_done_hide_range CHECK (route_done_hide_min BETWEEN 0 AND 120);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_route_unmarked_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_route_unmarked_range CHECK (route_unmarked_min BETWEEN 5 AND 240);
COMMENT ON COLUMN public.app_settings.route_done_hide_min IS
  '0137: minutos que una vuelta terminada (todas sus paradas marcadas) sigue a la vista en Asignación/Operación antes de bajar a «terminadas». A la delegada se le cuentan desde su fin esperado. Al conductor se le recuerda marcar lo que falta a su fin esperado + estos minutos.';
COMMENT ON COLUMN public.app_settings.route_unmarked_min IS
  '0137: minutos después del fin esperado en que una vuelta con paradas sin marcar se da por pasada («sin marcar», gris) y sale de la lista. Antes sigue a la vista: puede ir tarde.';

-- -----------------------------------------------------------------------------
-- El fin esperado de una vuelta (ver arriba). NULL si no tiene paradas vivas.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_expected_end(p_ra uuid)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dir   public.trip_direction;
  v_start timestamptz;
  v_due   timestamptz;
  v_eta   timestamptz;
  v_n     int;
BEGIN
  SELECT ra.direction, ra.planned_start_at INTO v_dir, v_start FROM public.route_assignments ra WHERE ra.id = p_ra;
  IF v_dir IS NULL THEN RETURN NULL; END IF;
  SELECT count(*)::int, max(r.required_arrival_at), max(rs.estimated_arrival_at)
    INTO v_n, v_due, v_eta
    FROM public.route_stops rs
    LEFT JOIN public.reservations r ON r.id = rs.reservation_id
   WHERE rs.route_assignment_id = p_ra
     AND ((rs.reservation_id IS NOT NULL AND r.cancelled_at IS NULL)
          OR (rs.reservation_id IS NULL AND rs.guest_name IS NOT NULL));
  IF coalesce(v_n, 0) = 0 THEN RETURN NULL; END IF;
  IF v_dir = 'home_to_airport' THEN
    RETURN coalesce(v_due, v_eta + interval '40 minutes', v_start + interval '60 minutes');
  END IF;
  RETURN coalesce(v_eta, v_start + interval '90 minutes');
END;
$$;
REVOKE ALL ON FUNCTION public.route_expected_end(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_expected_end(uuid) TO authenticated;
COMMENT ON FUNCTION public.route_expected_end(uuid) IS
  '0137: fin esperado de una vuelta. Salida = presentación más tardía; llegada = entrega estimada más tardía (o salida de JMC + 90 min). Misma cuenta que Api._opResultado.';

-- -----------------------------------------------------------------------------
-- El recordatorio al conductor. p_now es para las pruebas; el reloj la llama sin
-- argumentos. Una vez por vuelta (dedupe 'sinmarcar:<vuelta>'). No mira las de
-- hace más de 6 h (si se cae el reloj, no despierta a nadie con lo de ayer), ni las
-- delegadas (no tienen conductor), ni las que no tienen nada pendiente.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_unmarked_reminders(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hide  int := coalesce((SELECT route_done_hide_min FROM public.app_settings WHERE id = 'singleton'), 10);
  v_n     int := 0;
  v_sent  int := 0;
  v_end   timestamptz;
  v_who   text;
  v_hora  text;
  o       record;
BEGIN
  FOR o IN
    SELECT ra.id, ra.direction, ra.planned_start_at, dp.profile_id
      FROM public.route_assignments ra
      JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
     WHERE ra.status IN ('planned', 'in_progress')
       AND ra.delegated_at IS NULL
       AND ra.planned_start_at BETWEEN p_now - interval '12 hours' AND p_now
  LOOP
    v_end := public.route_expected_end(o.id);
    CONTINUE WHEN v_end IS NULL;
    CONTINUE WHEN p_now < v_end + make_interval(mins => v_hide) OR p_now > v_end + interval '6 hours';
    -- Quiénes faltan por marcar (con o sin cuenta), en el orden de la vuelta.
    SELECT string_agg(z.n, ', ' ORDER BY z.o), count(*) INTO v_who, v_n
      FROM (SELECT rs.stop_order AS o, CASE WHEN rs.reservation_id IS NULL THEN public.short_name(rs.guest_name) ELSE public.short_name(pr.full_name) END AS n
              FROM public.route_stops rs
              LEFT JOIN public.reservations r      ON r.id = rs.reservation_id
              LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
              LEFT JOIN public.profiles pr          ON pr.id = ap.profile_id
             WHERE rs.route_assignment_id = o.id
               AND coalesce(rs.status::text, 'pending') NOT IN ('delivered', 'no_show')
               AND ((rs.reservation_id IS NOT NULL AND r.cancelled_at IS NULL)
                    OR (rs.reservation_id IS NULL AND rs.guest_name IS NOT NULL))) z;
    CONTINUE WHEN coalesce(v_n, 0) = 0;
    -- «Laura Gómez, Sara Ríos» → «Laura Gómez y Sara Ríos».
    v_who := regexp_replace(v_who, ', ([^,]+)$', ' y \1');
    -- La hora que el conductor tiene en su tarjeta: la salida de JMC en una llegada,
    -- la primera recogida en una salida.
    v_hora := public.hm_bog(CASE WHEN o.direction = 'airport_to_home' THEN o.planned_start_at
      ELSE coalesce((SELECT rs.estimated_arrival_at FROM public.route_stops rs WHERE rs.route_assignment_id = o.id
                      ORDER BY rs.stop_order LIMIT 1), o.planned_start_at) END);
    IF public.trip_notify(o.profile_id, '✅ ¿Ya terminaste la vuelta de las ' || v_hora || '?',
         'Te falta marcar a ' || v_who || '. Toca para marcarlo: así sale de la lista de los jefes.',
         '/#/ruta', 'sinmarcar:' || o.id::text) THEN
      v_sent := v_sent + 1;
    END IF;
  END LOOP;
  IF v_sent > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_sent;
END;
$$;
REVOKE ALL ON FUNCTION public.route_unmarked_reminders(timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.route_unmarked_reminders(timestamptz) IS
  '0137: a su fin esperado + route_done_hide_min, al conductor de una vuelta con paradas sin marcar le llega UN aviso con los nombres que le faltan (dedupe sinmarcar:<vuelta>). No mira las delegadas ni las de hace más de 6 h.';

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'route-unmarked-reminders';
  PERFORM cron.schedule('route-unmarked-reminders', '*/5 * * * *', $job$SELECT public.route_unmarked_reminders();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): route_unmarked_reminders queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
