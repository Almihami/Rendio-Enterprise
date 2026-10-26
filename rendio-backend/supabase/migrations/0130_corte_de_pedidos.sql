-- =============================================================================
-- 0130 · El corte de pedidos de las 7:40 p. m. y el aviso del Excel (26-oct-2026)
-- =============================================================================
-- Pedidos de los jefes (lista del 26-oct, URGENTE):
--   · «Programar el sistema para que una vez sean las 7:40 nos saque el
--     consolidado de solicitud de ruta en un formato excel, que será tal cual como
--     era el anterior, esto para que Julián haga la ruta manual.»
--   · «En reservas crear un apartado al lado derecho de En pie, que diga Late, es
--     decir, quienes llenen después de las 7:40 el sistema los colocará allí.»
-- La profa eligió (26-oct) que el Excel llegue por NOTIFICACIÓN: al tocarla se
-- abre Asignación en ese día y se descarga, solo con lo pedido hasta el corte.
--
-- EL CORTE. app_settings.crew_request_cutoff_min = minutos desde medianoche
-- (1180 = 19:40), editable en Ajustes. Vale para el día operativo SIGUIENTE: a las
-- 7:40 p. m. del domingo se cierra el lunes. El día operativo es el de la ruta de
-- Julián: de las 02:00 (route_night_cutoff_min, 0107) a las 02:00 del día
-- siguiente — la madrugada (0:00–2:00) es del turno PM del día anterior y la arma
-- Julián con ese día. Ejemplo: un pedido del martes 0:30 es del lunes; su corte,
-- el domingo 7:40 p. m.
--
--   crew_request_deadline(hora del traslado) → el corte que le toca.
--   Late = se pidió (created_at) después de su corte.
--
-- EL AVISO. excel_cutoff_alerts() corre cada 5 min (pg_cron). Pasado el corte de
-- hoy (y hasta 2 h después, por si el reloj estuvo caído), a los jefes de cada
-- organización que tenga pedidos para el día operativo de mañana les llega UNA vez:
--   📋 El Excel de mañana está listo
--   mar 27 oct · 23 pedidos hasta las 7:40 p. m. Toca para descargarlo.
-- con enlace /#/rutas?excel=2026-10-27. Van a ops_alert_recipients_of (los
-- marcados en Personal; si nadie, todos los jefes activos). Julián tiene que ser
-- jefe para recibirlo y para descargar (la pantalla es de jefes).
--
-- NO SE TOCA ninguna función existente. Depende de 0107 (route_night_cutoff_min),
-- 0117 (ops_alert_recipients_of) y 0097 (trip_notify, trip_kick).
-- =============================================================================

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS crew_request_cutoff_min int NOT NULL DEFAULT 1180;
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_crew_request_cutoff_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_crew_request_cutoff_range
  CHECK (crew_request_cutoff_min BETWEEN 0 AND 1439);
COMMENT ON COLUMN public.app_settings.crew_request_cutoff_min IS
  '0130: hora de corte de los pedidos del día operativo siguiente, en minutos desde medianoche (1180 = 7:40 p. m.). Después del corte el pedido es «Late» y no sale en el Excel del día; a esa hora a los jefes les llega el aviso del Excel.';

-- El corte que le toca a un traslado a esa hora.
CREATE OR REPLACE FUNCTION public.crew_request_deadline(p_when timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_when IS NULL THEN NULL ELSE
    (((((p_when AT TIME ZONE 'America/Bogota') - make_interval(mins => s.noche))::date - 1)::timestamp
      + make_interval(mins => s.corte)) AT TIME ZONE 'America/Bogota') END
  FROM (SELECT coalesce((SELECT route_night_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 120) AS noche,
               coalesce((SELECT crew_request_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 1180) AS corte) s;
$$;
GRANT EXECUTE ON FUNCTION public.crew_request_deadline(timestamptz) TO authenticated;
COMMENT ON FUNCTION public.crew_request_deadline(timestamptz)
  IS '0130: el corte de pedidos que le toca a un traslado a esa hora: el día operativo (desde route_night_cutoff_min) menos uno, a crew_request_cutoff_min, en hora de Bogotá.';

-- «7:40 p. m.»
CREATE OR REPLACE FUNCTION public.hm12_bog(p_min int)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT ((CASE WHEN (p_min / 60) % 12 = 0 THEN 12 ELSE (p_min / 60) % 12 END)::text
          || ':' || lpad((p_min % 60)::text, 2, '0')
          || CASE WHEN p_min < 720 THEN ' a. m.' ELSE ' p. m.' END);
$$;

-- p_now es para las pruebas (simular la hora); el reloj la llama sin argumentos.
CREATE OR REPLACE FUNCTION public.excel_cutoff_alerts(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_noche  int := coalesce((SELECT route_night_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 120);
  v_corte  int := coalesce((SELECT crew_request_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 1180);
  v_local  timestamp := p_now AT TIME ZONE 'America/Bogota';
  v_min    int := extract(hour FROM v_local)::int * 60 + extract(minute FROM v_local)::int;
  v_dia    date := v_local::date + 1;   -- el día operativo que se cierra hoy
  v_n      int := 0;
  v_txt    text;
  o        record;
BEGIN
  IF v_min < v_corte OR v_min > v_corte + 120 THEN RETURN 0; END IF;
  -- «mar 27 oct» (sin depender del idioma de la base).
  v_txt := (ARRAY['dom','lun','mar','mié','jue','vie','sáb'])[extract(dow FROM v_dia)::int + 1] || ' '
        || extract(day FROM v_dia)::int || ' '
        || (ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'])[extract(month FROM v_dia)::int];
  FOR o IN
    SELECT pr.organization_id AS org, count(*)::int AS n
      FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE r.cancelled_at IS NULL
       AND ((r.required_arrival_at AT TIME ZONE 'America/Bogota') - make_interval(mins => v_noche))::date = v_dia
       AND r.created_at <= least(public.crew_request_deadline(r.required_arrival_at), p_now)
     GROUP BY pr.organization_id
  LOOP
    v_n := v_n + (SELECT count(*) FROM (
      SELECT public.trip_notify(j.profile_id, '📋 El Excel de mañana está listo',
               v_txt || ' · ' || o.n || CASE WHEN o.n = 1 THEN ' pedido' ELSE ' pedidos' END
                 || ' hasta las ' || public.hm12_bog(v_corte) || ' Toca para descargarlo.',   -- «p. m.» ya cierra con punto
               '/#/rutas?excel=' || to_char(v_dia, 'YYYY-MM-DD'),
               'excel:' || o.org::text || ':' || to_char(v_dia, 'YYYY-MM-DD') || ':' || j.profile_id::text) AS ok
        FROM public.ops_alert_recipients_of(o.org) j) z WHERE z.ok);
  END LOOP;
  IF v_n > 0 THEN PERFORM public.trip_kick(); END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.excel_cutoff_alerts(timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.excel_cutoff_alerts(timestamptz)
  IS '0130: pasado el corte de pedidos (crew_request_cutoff_min, hasta 2 h después) avisa UNA vez a los jefes de cada organización con pedidos para el día operativo de mañana que el Excel está listo (enlace #/rutas?excel=AAAA-MM-DD).';

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'excel-cutoff-alerts';
  PERFORM cron.schedule('excel-cutoff-alerts', '*/5 * * * *', $job$SELECT public.excel_cutoff_alerts();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): excel_cutoff_alerts queda creada pero nadie la llama.', SQLERRM;
END
$do$;

COMMIT;
