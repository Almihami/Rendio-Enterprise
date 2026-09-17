-- 0072_salud_avisos_honesta.sql — que el semáforo del canal de avisos diga la
-- verdad, y no la misma verdad para dos problemas distintos.
--
-- NOTA DE NUMERACIÓN (17-ago-2026): esto se aplicó a dev como `0069_...` y se
-- renumeró a 0072 el mismo día, sin tocar una sola línea del SQL. Motivo: otras
-- dos sesiones tomaron 0069, 0070 y 0071 en paralelo, y las suyas ya están
-- pusheadas. El SQL es idéntico al que corrió, así que no aplica la regla de
-- «no modificar migraciones ya aplicadas» (CLAUDE.md §Reglas inviolables, 5):
-- cambió el nombre del archivo, no lo que se ejecutó. El orden tampoco importa
-- acá — esto solo hace CREATE OR REPLACE de ops_alert_health(), que ninguna otra
-- migración toca.
--
-- QUÉ PASÓ. Se desplegó `dispatch-notifications` (17-ago-2026) y la prueba de
-- punta a punta salió así: la base llamó a la función, la función respondió y
-- escribió el resultado — o sea, EL CANAL QUEDÓ BUENO. Pero los 3 avisos
-- quedaron sin enviar con `last_error = 'sin dispositivo: no ha activado
-- notificaciones'`, porque ninguno de los tres jefes tiene todavía la PWA
-- instalada con el permiso aceptado.
--
-- Con `ops_alert_health()` como estaba, esas 3 filas se cuentan como
-- `pendientes` y `atascados`, y la pantalla dice:
--
--     «Los avisos no están saliendo: hay 3 en cola, el más viejo de hace 0 min.
--      Mientras esto siga así, una eventualidad de madrugada no va a sonar en
--      ningún celular.»
--
-- Eso manda a buscar una falla que no existe. Son dos problemas distintos y se
-- arreglan en sitios distintos:
--
--   · el canal caído  → es técnico, lo arreglo yo
--   · sin dispositivo → es presencial, hay que instalarle la app al jefe y que
--                       acepte el permiso; ningún arreglo de código lo resuelve
--
-- Un semáforo que da el mismo rojo para los dos hace que se revise el lado
-- equivocado, y después deja de mirarse. Se separan.

CREATE OR REPLACE FUNCTION public.ops_alert_health()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cola AS (
    SELECT attempts, created_at,
           -- Marca terminal que escribe la Edge Function cuando la persona no
           -- tiene ninguna suscripción. No es un fallo del canal: es que no hay
           -- a dónde mandarlo.
           (last_error LIKE 'sin dispositivo%') AS sin_disp
      FROM public.notification_outbox
     WHERE sent_at IS NULL
  )
  SELECT jsonb_build_object(
    -- "Pendiente" pasa a significar lo que la palabra dice: todavía puede salir.
    'pendientes',      (SELECT count(*) FROM cola WHERE NOT sin_disp),
    'atascados',       (SELECT count(*) FROM cola WHERE NOT sin_disp AND attempts >= 5),
    -- Lo que no tiene a dónde ir, aparte y con su propio nombre.
    'sin_dispositivo', (SELECT count(*) FROM cola WHERE sin_disp),
    'mas_viejo_min',   (SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - min(created_at))) / 60)::int, 0)
                          FROM cola WHERE NOT sin_disp),
    'ultimo_envio',    (SELECT max(sent_at) FROM public.notification_outbox),
    'destinatarios',   (SELECT count(*) FROM public.ops_alert_recipients()),
    -- Cuántos de los jefes marcados SÍ podrían recibir algo hoy. Si es 0, no
    -- importa que todo lo demás esté perfecto: no va a sonar ningún celular.
    'con_dispositivo', (SELECT count(*) FROM public.ops_alert_recipients() r
                         WHERE EXISTS (SELECT 1 FROM public.push_subscriptions s
                                        WHERE s.profile_id = r.profile_id))
  );
$$;

REVOKE ALL    ON FUNCTION public.ops_alert_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_alert_health() TO authenticated;

COMMENT ON FUNCTION public.ops_alert_health()
  IS 'Estado del canal de avisos, separando las dos fallas: `atascados`/`mas_viejo_min` = el despacho está caído (técnico); `sin_dispositivo`/`con_dispositivo` = los jefes no han activado notificaciones (presencial). Dar el mismo rojo para las dos manda a revisar el lado equivocado.';
