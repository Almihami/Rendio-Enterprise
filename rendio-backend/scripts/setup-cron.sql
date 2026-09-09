-- =============================================================================
-- Setup opcional de pg_cron para auto-resolver descansos de fin de semana.
--
-- Corre la función public.auto_resolve_weekend_singletons() todos los domingos
-- a las 8 PM hora Bogotá (= 01:00 UTC del lunes).
--
-- Pre-requisito: tener pg_cron habilitado en el proyecto Supabase.
--   Dashboard → Database → Extensions → pg_cron → Enable.
--
-- Si no quieres habilitar pg_cron, el admin puede hacer clic en
-- "Auto-aprobar singletons" desde la pestaña Solicitudes y se logra lo mismo
-- manualmente.
-- =============================================================================

-- Quita el job si ya existía (para que el script sea re-ejecutable).
SELECT cron.unschedule('rendio-turnos-auto-resolve')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'rendio-turnos-auto-resolve'
);

-- Domingo 8 PM Bogotá = Lunes 01:00 UTC
-- Cron: "minuto hora día-mes mes día-semana" → 0 1 * * 1 (lunes 01:00)
SELECT cron.schedule(
  'rendio-turnos-auto-resolve',
  '0 1 * * 1',
  $$ SELECT public.auto_resolve_weekend_singletons(); $$
);
