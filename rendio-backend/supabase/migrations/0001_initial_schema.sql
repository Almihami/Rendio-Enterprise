-- =============================================================================
-- Migration 0001 — initial schema
-- Tarea contractual: E1.04
-- Spec: Arquitectura_Tecnica_MVP_Rendio.md §5.1, §5.3, §5.4 (organizations,
--       airports, profiles).
--
-- Contiene:
--   - Extensión pgcrypto (gen_random_uuid)
--   - 9 enums del dominio
--   - Helper trigger function set_updated_at()
--   - Tablas: organizations, airports, profiles
--   - Triggers updated_at en cada tabla
--   - RLS habilitado en cada tabla SIN policies (las policies vienen en 0004)
--
-- Idempotente: usa IF NOT EXISTS y CREATE OR REPLACE donde aplica.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Extensiones
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums (Arquitectura §5.3)
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('admin', 'driver', 'auxiliar');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.trip_direction AS ENUM ('home_to_airport', 'airport_to_home');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.reservation_status_h2a AS ENUM (
    'requested',
    'assigned',
    'ready',
    'en_route',
    'at_pickup',
    'on_board',
    'delivered',
    'no_show',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.reservation_status_a2h AS ENUM (
    'scheduled',
    'in_air',
    'landed',
    'disembarking',
    'driver_assigned',
    'picked_up',
    'en_route_home',
    'delivered',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.flight_status AS ENUM (
    'scheduled',
    'boarding',
    'in_air',
    'delayed',
    'advanced',
    'landed',
    'cancelled',
    'diverted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.vehicle_status AS ENUM ('available', 'in_use', 'maintenance', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.shift_status AS ENUM (
    'vehicle_selected',
    'inspection_in_progress',
    'active',
    'closing',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.incident_severity AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.incident_category AS ENUM (
    'cant_leave_on_time',
    'address_change',
    'driver_late',
    'flight_delay',
    'flight_advanced',
    'terminal_change',
    'missed_flight',
    'traffic',
    'aux_not_responding',
    'aux_not_ready',
    'wrong_address',
    'vehicle_problem',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- Helper trigger function: actualiza updated_at en cualquier UPDATE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Tabla: organizations (§5.4)
-- Multi-tenant. En MVP hay una sola fila ("Rendio Enterprises").
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organizations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  slug        text        NOT NULL UNIQUE,
  timezone    text        NOT NULL DEFAULT 'America/Bogota',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tr_organizations_set_updated_at ON public.organizations;
CREATE TRIGGER tr_organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: airports (§5.4)
-- En MVP hay una fila: José María Córdova (MDE/Rionegro).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.airports (
  id              uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid             NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  iata_code       text             NOT NULL,
  name            text             NOT NULL,
  latitude        double precision NOT NULL,
  longitude       double precision NOT NULL,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  updated_at      timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT airports_iata_per_org_unique UNIQUE (organization_id, iata_code),
  CONSTRAINT airports_latitude_range  CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT airports_longitude_range CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_airports_organization_id ON public.airports(organization_id);

DROP TRIGGER IF EXISTS tr_airports_set_updated_at ON public.airports;
CREATE TRIGGER tr_airports_set_updated_at
  BEFORE UPDATE ON public.airports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.airports ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: profiles (§5.4)
-- Extiende auth.users (tabla nativa Supabase Auth). 1 fila por usuario.
-- ON DELETE CASCADE para que al borrar el auth.user se borre el profile.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
  id              uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  role            public.user_role NOT NULL,
  full_name       text        NOT NULL,
  email           text        NOT NULL,
  phone           text,
  avatar_url      text,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT profiles_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE INDEX IF NOT EXISTS idx_profiles_organization_id ON public.profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role            ON public.profiles(role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_email_lower     ON public.profiles(lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_email_per_org_active
  ON public.profiles(organization_id, lower(email))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS tr_profiles_set_updated_at ON public.profiles;
CREATE TRIGGER tr_profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Comentarios para documentación introspectable
-- -----------------------------------------------------------------------------

COMMENT ON TABLE public.organizations IS 'Multi-tenancy. Una sola fila en MVP (Rendio Enterprises).';
COMMENT ON TABLE public.airports      IS 'Aeropuertos servidos. Una sola fila en MVP (MDE/José María Córdova).';
COMMENT ON TABLE public.profiles      IS 'Extiende auth.users con rol y datos comunes. Sub-perfiles en migration 0002.';
COMMENT ON COLUMN public.profiles.id  IS 'FK a auth.users(id) con cascade delete.';

COMMIT;
