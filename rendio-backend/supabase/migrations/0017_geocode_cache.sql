-- =============================================================================
-- Migration 0017 — geocode_cache
-- Tarea: soporte para E3.01 (Edge Function geocode_address) y E2.05
-- (CRUD auxiliares con geocoding al guardar dirección).
--
-- Contiene:
--   - Tabla geocode_cache: caché de resoluciones de Nominatim para no superar
--     el rate limit (1 req/seg) ni geocodificar la misma dirección dos veces.
--   - Hash MD5 de la dirección normalizada como PK para lookup determinista.
--   - TTL implícito por columna fetched_at (la Edge Function decide vigencia).
--
-- RLS: habilitada pero sin lectura/escritura desde clientes. Solo Edge Functions
-- (service_role) tocan esta tabla, así que dejamos la tabla sin policies =
-- nadie autenticado puede leer/escribir.
--
-- Idempotente.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.geocode_cache (
  address_hash    text         PRIMARY KEY,
  address_raw     text         NOT NULL,
  lat             double precision,
  lon             double precision,
  display_name    text,
  fetched_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT geocode_cache_lat_range CHECK (lat IS NULL OR lat BETWEEN -90  AND 90),
  CONSTRAINT geocode_cache_lon_range CHECK (lon IS NULL OR lon BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_geocode_cache_fetched_at ON public.geocode_cache(fetched_at);

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;
-- No policies: tabla solo accesible vía service_role (Edge Functions).

COMMENT ON TABLE public.geocode_cache IS
  'Caché de geocoding (Nominatim). Solo accesible por Edge Functions con service_role. Hash = MD5 de la dirección normalizada en minúsculas sin espacios extra.';
COMMENT ON COLUMN public.geocode_cache.address_hash IS 'MD5 hex de la dirección normalizada (lower + trim + colapsar espacios).';
COMMENT ON COLUMN public.geocode_cache.lat IS 'NULL si Nominatim no encontró resultado para la dirección.';

COMMIT;
