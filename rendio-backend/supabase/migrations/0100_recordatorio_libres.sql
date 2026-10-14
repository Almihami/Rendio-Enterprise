-- =============================================================================
-- 0100 · Recordatorio de los «libres» (disponibilidad de la semana)
-- =============================================================================
-- Pedido del 11-oct-2026: «avisarles cada semana que manden los libres:
-- notificaciones push diarias faltando 3 días».
--
-- El corte es el SÁBADO a las 4:00 p. m. hora de Bogotá (d157478, 21-sep-2026)
-- y cierra la semana que empieza el lunes siguiente. Aviso a cada conductor
-- activo que todavía NO confirmó esa semana:
--   miércoles 9:00 a. m. · «Faltan 3 días»
--   jueves    9:00 a. m. · «Faltan 2 días»
--   viernes   9:00 a. m. · «Mañana cierra»
--   sábado   12:00 m.    · «Hoy a las 4:00 p. m. cierra»
-- «Confirmada» = las 14 jornadas (7 días × mañana/tarde) marcadas: ninguna en
-- 'unset'. Desde el 15-sep las jornadas sin tocar se muestran como «Puedo» pero
-- en la base siguen 'unset' y NO entran a la programación: justo lo que hay que
-- recordar. No se le avisa a quien está suspendido esa semana (no entra a la
-- generación) ni a los inactivos/eliminados.
-- Va por la bandeja de 0063 (notification_outbox) y una sola vez por persona y
-- día (dedupe_key).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.remind_weekly_availability(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_local   timestamp := p_now AT TIME ZONE 'America/Bogota';
  v_today   date := v_local::date;
  v_dow     int  := extract(isodow FROM v_local)::int;        -- 1 = lunes … 7 = domingo
  v_week    date := (date_trunc('week', v_local)::date + 7);  -- lunes de la semana que cierra
  v_meses   text[] := ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  v_rango   text;
  v_title   text;
  v_body    text;
  v_n       int := 0;
  rec       record;
BEGIN
  -- Solo miércoles a sábado (y el sábado, antes del corte de las 4:00 p. m.).
  IF v_dow NOT IN (3, 4, 5, 6) THEN RETURN 'hoy no toca (' || v_dow || ')'; END IF;
  IF v_dow = 6 AND v_local::time >= time '16:00' THEN RETURN 'el corte ya pasó'; END IF;

  v_rango := extract(day FROM v_week)::int || ' ' || v_meses[extract(month FROM v_week)::int]
          || ' al ' || extract(day FROM v_week + 6)::int || ' ' || v_meses[extract(month FROM v_week + 6)::int];
  v_title := CASE v_dow
    WHEN 3 THEN 'Faltan 3 días para mandar tus libres'
    WHEN 4 THEN 'Faltan 2 días para mandar tus libres'
    WHEN 5 THEN 'Mañana cierra tu semana'
    ELSE        'Hoy a las 4:00 p. m. cierra tu semana' END;
  v_body := 'Confirma tu disponibilidad del ' || v_rango || ' antes del sábado a las 4:00 p. m.'
         || ' Lo que no marques no entra a la programación.';

  FOR rec IN
    SELECT p.id
      FROM public.profiles p
     WHERE p.role = 'driver'
       AND coalesce(p.is_active, true)
       AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.driver_suspensions s
                        WHERE s.profile_id = p.id AND s.week_start_date = v_week AND s.lifted_at IS NULL)
       AND (SELECT count(*) FROM public.driver_availability a
             WHERE a.profile_id = p.id AND a.week_start_date = v_week
               AND a.am_state::text <> 'unset' AND a.pm_state::text <> 'unset') < 7
  LOOP
    IF public.trip_notify(rec.id, v_title, v_body, '/',
         'avail:' || rec.id || ':' || v_week || ':' || v_today) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;

  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN format('semana %s · %s recordatorios', v_week, v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.remind_weekly_availability(timestamptz) FROM PUBLIC, anon, authenticated;

-- 9:00 a. m. Bogotá = 14:00 UTC (miércoles a viernes) · 12:00 m. = 17:00 UTC (sábado).
DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('remind-availability-weekday', 'remind-availability-saturday');
  PERFORM cron.schedule('remind-availability-weekday', '0 14 * * 3,4,5', $job$SELECT public.remind_weekly_availability();$job$);
  PERFORM cron.schedule('remind-availability-saturday', '0 17 * * 6', $job$SELECT public.remind_weekly_availability();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): remind_weekly_availability queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
