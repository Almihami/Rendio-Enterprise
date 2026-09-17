-- =============================================================================
-- Migration 0035 — Cédula y base/sede en el perfil
--
-- El perfil del conductor muestra cédula y base (ciudad/sede). No existían como
-- columnas. Se agregan a profiles (las gestiona el admin al crear/editar al
-- conductor). Aditivo y nullable.
-- =============================================================================

BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS document_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS home_base   text;

COMMENT ON COLUMN public.profiles.document_id IS 'Cédula / documento de identidad (lo gestiona el admin).';
COMMENT ON COLUMN public.profiles.home_base   IS 'Base/sede del conductor (ciudad o aeropuerto). Lo gestiona el admin.';

COMMIT;
