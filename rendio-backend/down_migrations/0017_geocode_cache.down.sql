-- =============================================================================
-- DOWN migration 0017 — drop geocode_cache.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.geocode_cache;

COMMIT;
