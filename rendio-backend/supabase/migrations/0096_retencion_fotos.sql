-- =============================================================================
-- 0096_retencion_fotos.sql — Las fotos de inspección se guardan máximo N días
--
-- EL PROBLEMA
-- Producción tiene 873 MB de 1 GB del plan gratuito de Storage y crece ~280 MB
-- al mes: 11 fotos por inicio de turno, ~280 KB cada una, y nada se borra
-- nunca. A ese ritmo el bucket se llena en semanas y lo primero que se rompe es
-- justo el inicio de turno (la foto no sube).
--
-- LA DECISIÓN (de la dueña): guardar máximo 2 meses, con excepciones. Lo que se
-- borra es la RUTINA: las fotos de un inicio de turno que salió bien y que ya
-- nadie va a mirar. Lo que puede ser prueba de algo se queda:
--
--   · NUNCA la foto del golpe/daño, la foto adicional del conductor ni la que
--     sube el jefe al resolver (photo_type damage / extra / admin).
--   · NUNCA un comprobante de tanqueo (fuel_receipts), aunque su fila se haya
--     perdido: el archivo receipt-* sigue siendo un comprobante.
--   · NUNCA las fotos de una inspección pendiente o rechazada, con algún ítem
--     del checklist en 'issue', con gravedad media/grave, NO APTA, o de un turno
--     que tiene una novedad (incidents.shift_id). La inspección y la novedad no
--     tienen una columna que las una: el turno es lo que las une, y se toma
--     cualquier novedad del turno (también el aviso de km o el cierre sin km):
--     ante la duda, se guarda.
--   · NUNCA lo que referencia una novedad (incidents.photo_paths: la evidencia
--     del cierre y la de las eventualidades vive en este mismo bucket).
--
-- Y además se limpian las HUÉRFANAS: archivos del bucket 'inspections' que no
-- referencia ninguna fila, con más de 3 días (para no borrar una subida en
-- curso: la fila se escribe DESPUÉS de subir el archivo). Si la huérfana vive
-- en la carpeta de una inspección o de un cierre que todavía existe, se trata
-- como de ese registro: solo se va si ese registro también se podría purgar.
--
-- CÓMO SE BORRA
-- Esta migración NO borra archivos. Borrar con DELETE en storage.objects deja
-- el archivo físico huérfano en el disco de Storage (la fila desaparece, el
-- archivo no, y el espacio no se libera). Por eso la base solo DICE qué se
-- puede borrar (photo_purge_candidates) y la Edge Function purge-old-photos lo
-- borra con la API de Storage y después marca inspection_photos.purged_at.
--
-- Mismo patrón de 0066: el cron solo dispara; la URL y la llave viven en Vault
-- (scripts/_set-vault-secrets.mjs), nunca en una migración.
--
-- Y de paso: cron.job_run_details guarda una fila por cada corrida de cada cron
-- (el despacho de avisos corre cada minuto) y nadie la limpia: en producción
-- van 100.000 filas, 18 MB. Se limpia cada semana y se dejan 7 días.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Cuántos días se guardan (Ajustes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS photo_retention_days int NOT NULL DEFAULT 60;

DO $do$
BEGIN
  ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_photo_retention_days_range
    CHECK (photo_retention_days BETWEEN 30 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

COMMENT ON COLUMN public.app_settings.photo_retention_days
  IS 'Días que se guardan las fotos de RUTINA de las inspecciones (30–365). No aplica a golpes, comprobantes, inspecciones con fallas/novedad ni pendientes/rechazadas: esas no se borran nunca.';

-- -----------------------------------------------------------------------------
-- 2. Constancia de que la foto se borró por antigüedad
--    La fila se queda (el detalle de la inspección muestra «Foto eliminada por
--    antigüedad» en vez de un hueco); el archivo ya no está.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inspection_photos
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

COMMENT ON COLUMN public.inspection_photos.purged_at
  IS 'Cuándo la purga por antigüedad (0096) borró el archivo de Storage. La fila se conserva como constancia; con purged_at puesto el archivo ya no existe.';

-- -----------------------------------------------------------------------------
-- 3. Piezas internas
-- -----------------------------------------------------------------------------

-- ¿Algún ítem del checklist quedó en 'issue'? Dos formas guardadas: la de hoy
-- ({severity, items:[{result}]}) y la vieja (un mapa itemId → 'ok'|'issue').
CREATE OR REPLACE FUNCTION public._checklist_has_issue(p_checklist jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_checklist IS NULL THEN false
    WHEN jsonb_typeof(p_checklist -> 'items') = 'array' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_checklist -> 'items') e
       WHERE jsonb_typeof(e) = 'object' AND e ->> 'result' = 'issue')
    WHEN jsonb_typeof(p_checklist) = 'object' THEN EXISTS (
      SELECT 1 FROM jsonb_each(p_checklist) e WHERE e.value = '"issue"'::jsonb)
    ELSE false
  END;
$$;

-- Solo la llave de servicio (la Edge Function) o la base misma (el cron, psql).
-- Los GRANT ya lo cierran; esto es el cinturón por si algún día alguien le da
-- EXECUTE a authenticated sin pensar.
CREATE OR REPLACE FUNCTION public._photo_purge_guard()
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  BEGIN
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'SOLO_SERVICIO: la purga de fotos solo la corre la llave de servicio'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Qué se puede borrar
--    Devuelve lotes ordenados (rutina primero, de la más vieja a la más nueva;
--    después las huérfanas). p_offset sirve para recorrer en modo de prueba,
--    donde nada se borra y el conjunto no cambia entre llamadas.
--      bytes       tamaño en Storage (NULL si el archivo ya no está)
--      in_storage  false = la fila de rutina apunta a un archivo que ya no
--                  existe: no hay nada que borrar, solo marcarla purgada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.photo_purge_candidates(p_limit int DEFAULT 200, p_offset int DEFAULT 0)
RETURNS TABLE (bucket text, path text, motivo text, photo_id uuid, bytes bigint, in_storage boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days   int;
  v_cutoff timestamptz;
  v_limit  int := greatest(1, least(coalesce(p_limit, 200), 1000));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  PERFORM public._photo_purge_guard();

  SELECT s.photo_retention_days INTO v_days FROM public.app_settings s WHERE s.id = 'singleton';
  v_days   := greatest(30, least(365, coalesce(v_days, 60)));
  v_cutoff := now() - make_interval(days => v_days);

  RETURN QUERY
  WITH insp_ok AS (
    -- Inspecciones cuya rutina ya se puede borrar.
    SELECT i.id
      FROM public.inspections i
     WHERE i.performed_at < v_cutoff
       AND i.review_status = 'approved'
       AND NOT i.has_damage
       AND i.is_apt IS DISTINCT FROM false
       AND lower(coalesce(i.checklist ->> 'severity', '')) NOT IN ('media', 'grave', 'medium', 'high', 'alta')
       AND NOT public._checklist_has_issue(i.checklist)
       AND NOT EXISTS (SELECT 1 FROM public.incidents x WHERE x.shift_id = i.shift_id)
  ),
  rutina AS (
    SELECT ip.id AS pid, ip.storage_path AS spath, i.performed_at AS ts
      FROM public.inspection_photos ip
      JOIN insp_ok ok ON ok.id = ip.inspection_id
      JOIN public.inspections i ON i.id = ip.inspection_id
     WHERE ip.purged_at IS NULL
       -- Las de tipo fijo. Se define POR EXCLUSIÓN, igual que el índice único de
       -- 0079: la próxima foto obligatoria que se agregue cae sola en la rutina.
       AND ip.photo_type::text NOT IN ('damage', 'extra', 'admin')
       -- El mismo archivo no puede estar sosteniendo otra cosa.
       AND NOT EXISTS (
         SELECT 1 FROM public.inspection_photos o2
          WHERE o2.storage_path = ip.storage_path AND o2.id <> ip.id
            AND (o2.photo_type::text IN ('damage', 'extra', 'admin')
                 OR NOT EXISTS (SELECT 1 FROM insp_ok k WHERE k.id = o2.inspection_id)))
       AND NOT EXISTS (SELECT 1 FROM public.fuel_receipts fr WHERE fr.storage_path = ip.storage_path)
       AND NOT EXISTS (SELECT 1 FROM public.incidents x
                        WHERE jsonb_typeof(x.photo_paths) = 'array' AND x.photo_paths ? ip.storage_path)
  ),
  huerf AS (
    SELECT o.name AS spath, o.created_at AS ts, (o.metadata ->> 'size')::bigint AS sz,
           -- La carpeta donde vive: <org>/<carro>/<fecha>/<CARPETA>/<archivo>.
           CASE WHEN o.name ~ '/' THEN regexp_replace(o.name, '^(?:.*/)?([^/]+)/[^/]+$', '\1') ELSE '' END AS carpeta,
           regexp_replace(o.name, '^.*/', '') AS archivo
      FROM storage.objects o
     WHERE o.bucket_id = 'inspections'
       AND o.created_at < now() - interval '3 days'
       AND NOT EXISTS (SELECT 1 FROM public.inspection_photos ip WHERE ip.storage_path = o.name)
       AND NOT EXISTS (SELECT 1 FROM public.fuel_receipts fr WHERE fr.storage_path = o.name)
       AND NOT EXISTS (SELECT 1 FROM public.incidents x
                        WHERE jsonb_typeof(x.photo_paths) = 'array' AND x.photo_paths ? o.name)
  ),
  huerf_ok AS (
    SELECT h.* FROM huerf h
     WHERE h.archivo NOT LIKE 'receipt-%'
       -- Carpeta de una inspección que existe: solo si esa inspección se puede purgar.
       AND NOT (h.carpeta ~ c_uuid
                AND EXISTS (SELECT 1 FROM public.inspections i WHERE i.id = h.carpeta::uuid)
                AND NOT EXISTS (SELECT 1 FROM insp_ok k WHERE k.id = h.carpeta::uuid))
       -- Carpeta de un cierre (close-<turno>): solo si el turno no tiene novedades.
       AND NOT (h.carpeta LIKE 'close-%'
                AND substr(h.carpeta, 7) ~ c_uuid
                AND EXISTS (SELECT 1 FROM public.incidents x WHERE x.shift_id = substr(h.carpeta, 7)::uuid))
  ),
  todo AS (
    SELECT 1 AS orden, r.ts, r.spath, 'rutina_vencida'::text AS mot, r.pid,
           (o.metadata ->> 'size')::bigint AS sz, (o.id IS NOT NULL) AS hay
      FROM rutina r
      LEFT JOIN storage.objects o ON o.bucket_id = 'inspections' AND o.name = r.spath
    UNION ALL
    SELECT 2, h.ts, h.spath, 'huerfana'::text, NULL::uuid, h.sz, true
      FROM huerf_ok h
  )
  SELECT 'inspections'::text, t.spath, t.mot, t.pid, t.sz, t.hay
    FROM todo t
   ORDER BY t.orden, t.ts, t.spath
   LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.photo_purge_candidates(int, int)
  IS 'Fotos que la purga por antigüedad puede borrar: rutina de inspecciones aprobadas sin fallas ni novedad más viejas que app_settings.photo_retention_days, y huérfanas del bucket inspections con más de 3 días. Solo llave de servicio. No borra nada.';

-- -----------------------------------------------------------------------------
-- 5. Marcar las que ya se borraron
--    Solo marca filas cuyo archivo YA NO está en Storage: purged_at quiere decir
--    «el archivo no existe», y así un llamado equivocado no puede marcar como
--    borrada una foto que sigue ahí.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_photos_purged(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._photo_purge_guard();
  UPDATE public.inspection_photos ip
     SET purged_at = now()
   WHERE ip.id = ANY (coalesce(p_ids, '{}'::uuid[]))
     AND ip.purged_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM storage.objects o
                      WHERE o.bucket_id = 'inspections' AND o.name = ip.storage_path);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.mark_photos_purged(uuid[])
  IS 'Sella purged_at en las fotos cuyo archivo ya no está en Storage. Devuelve cuántas marcó. Solo llave de servicio.';

-- -----------------------------------------------------------------------------
-- 6. El disparo nocturno
--    Primero los secretos (que el texto diga lo que falta aunque esta noche no
--    haya nada que borrar) y después si hay candidatos: sin candidatos no se
--    despierta a la Edge Function.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_photo_purge()
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url  text;
  v_key  text;
  v_hay  boolean;
  v_req  bigint;
BEGIN
  PERFORM public._photo_purge_guard();

  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'purge_photos_url';
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'vault no disponible: ' || SQLERRM || ' — no se borró nada';
  END;

  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN 'faltan secretos en Vault ('
      || concat_ws(' y ', CASE WHEN v_url IS NULL THEN 'purge_photos_url' END,
                          CASE WHEN v_key IS NULL THEN 'service_role_key' END)
      || '): no se borró nada';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.photo_purge_candidates(1, 0)) INTO v_hay;
  IF NOT v_hay THEN
    RETURN 'sin fotos por purgar';
  END IF;

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('trigger', 'cron'),
    -- Una purga grande (la primera) tarda: 2 minutos antes de soltar la respuesta.
    timeout_milliseconds := 120000
  ) INTO v_req;
  RETURN 'disparado (pg_net #' || coalesce(v_req::text, '?') || ')';
END;
$$;

COMMENT ON FUNCTION public.run_photo_purge()
  IS 'Lo llama el cron nocturno: dispara la Edge Function purge-old-photos con la URL y la llave de Vault. Devuelve en texto lo que hizo o lo que falta.';

-- -----------------------------------------------------------------------------
-- 7. Limpieza del historial de pg_cron
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_cron_history(p_keep_days int DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  PERFORM public._photo_purge_guard();
  DELETE FROM cron.job_run_details
   WHERE coalesce(end_time, start_time) < now() - make_interval(days => greatest(1, coalesce(p_keep_days, 7)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION public.purge_cron_history(int)
  IS 'Borra de cron.job_run_details las corridas de más de N días (7 por defecto). La llama el cron semanal purge-cron-history.';

-- -----------------------------------------------------------------------------
-- 8. Permisos: nada de esto lo llama la app
--    (Supabase le da EXECUTE a anon y authenticated por defecto a toda función
--    nueva de public: hay que quitárselo explícitamente.)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._checklist_has_issue(jsonb)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._photo_purge_guard()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.photo_purge_candidates(int, int)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_photos_purged(uuid[])           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_photo_purge()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_cron_history(int)              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._checklist_has_issue(jsonb)       TO service_role;
GRANT EXECUTE ON FUNCTION public._photo_purge_guard()              TO service_role;
GRANT EXECUTE ON FUNCTION public.photo_purge_candidates(int, int)  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_photos_purged(uuid[])        TO service_role;
GRANT EXECUTE ON FUNCTION public.run_photo_purge()                 TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_cron_history(int)           TO service_role;

COMMIT;

-- -----------------------------------------------------------------------------
-- 9. Los relojes (fuera de la transacción, como en 0066: si pg_cron no está,
--    la migración queda aplicada igual y lo dice)
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('purge-old-photos');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  PERFORM cron.unschedule('purge-cron-history');
EXCEPTION WHEN OTHERS THEN NULL;
END
$do$;

DO $do$
BEGIN
  -- 3:15 a. m. en Bogotá (UTC−5, sin horario de verano) = 08:15 UTC. pg_cron
  -- corre en UTC. A esa hora no hay inicios de turno subiendo fotos.
  PERFORM cron.schedule('purge-old-photos', '15 8 * * *',
    $job$SELECT public.run_photo_purge();$job$);
  -- Domingo 3:45 a. m. en Bogotá.
  PERFORM cron.schedule('purge-cron-history', '45 8 * * 0',
    $job$SELECT public.purge_cron_history(7);$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): la purga queda creada pero nadie la llama.', SQLERRM;
END
$do$;
