-- Down de 0029. (No se quita 'extra' del enum: Postgres no permite DROP de un
-- valor de enum.) Re-crear la UNIQUE estricta es best-effort: falla si ya hay
-- varias fotos del mismo tipo, por eso va en bloque con captura de excepción.

DROP INDEX IF EXISTS public.inspection_photos_unique_fixed_type;

DO $do$
BEGIN
  ALTER TABLE public.inspection_photos
    ADD CONSTRAINT inspection_photos_unique_per_inspection UNIQUE (inspection_id, photo_type);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo restaurar la UNIQUE estricta (hay fotos duplicadas por tipo): %', SQLERRM;
END
$do$;
