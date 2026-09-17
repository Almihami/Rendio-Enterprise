-- =============================================================================
-- Migration 0002 — sub-perfiles por rol y flota
-- Tarea contractual: E1.05
-- Spec: Arquitectura §5.4 (auxiliar_profiles, driver_profiles, vehicles)
--       y §5.5 (vista v_vehicle_maintenance_status).
--
-- Contiene:
--   - Tabla auxiliar_profiles (extiende profiles con datos de auxiliar)
--   - Tabla driver_profiles (extiende profiles con licencia/EPS/ARL)
--   - Tabla vehicles (flota)
--   - Vista v_vehicle_maintenance_status (semáforo verde/amarillo/rojo)
--   - Triggers updated_at + RLS habilitado en cada tabla (sin policies aún)
--
-- Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Tabla: auxiliar_profiles
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.auxiliar_profiles (
  id              uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid             NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  home_address    text             NOT NULL,
  home_latitude   double precision NOT NULL,
  home_longitude  double precision NOT NULL,
  employee_code   text,
  notes           text,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  updated_at      timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT auxiliar_home_lat_range CHECK (home_latitude  BETWEEN -90  AND 90),
  CONSTRAINT auxiliar_home_lon_range CHECK (home_longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_auxiliar_profiles_profile_id ON public.auxiliar_profiles(profile_id);

DROP TRIGGER IF EXISTS tr_auxiliar_profiles_set_updated_at ON public.auxiliar_profiles;
CREATE TRIGGER tr_auxiliar_profiles_set_updated_at
  BEFORE UPDATE ON public.auxiliar_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.auxiliar_profiles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: driver_profiles
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_profiles (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid        NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  license_number      text,
  license_expires_at  date,
  eps_provider        text,
  eps_expires_at      date,
  arl_provider        text,
  arl_expires_at      date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_profiles_profile_id ON public.driver_profiles(profile_id);

DROP TRIGGER IF EXISTS tr_driver_profiles_set_updated_at ON public.driver_profiles;
CREATE TRIGGER tr_driver_profiles_set_updated_at
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tabla: vehicles
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vehicles (
  id                       uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid                  NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  internal_code            text                  NOT NULL,
  license_plate            text                  NOT NULL,
  brand                    text,
  model                    text,
  year                     int,
  capacity                 int                   NOT NULL DEFAULT 4,
  current_km               int                   NOT NULL DEFAULT 0,
  last_maintenance_km      int                   NOT NULL DEFAULT 0,
  maintenance_interval_km  int                   NOT NULL DEFAULT 7000,
  status                   public.vehicle_status NOT NULL DEFAULT 'available',
  soat_expires_at          date,
  tecnomec_expires_at      date,
  insurance_expires_at     date,
  created_at               timestamptz           NOT NULL DEFAULT now(),
  updated_at               timestamptz           NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT vehicles_internal_code_per_org_unique UNIQUE (organization_id, internal_code),
  CONSTRAINT vehicles_license_plate_per_org_unique UNIQUE (organization_id, license_plate),
  CONSTRAINT vehicles_capacity_positive             CHECK (capacity > 0),
  CONSTRAINT vehicles_capacity_max_4                CHECK (capacity <= 4),
  CONSTRAINT vehicles_km_non_negative               CHECK (current_km >= 0),
  CONSTRAINT vehicles_last_maint_non_negative       CHECK (last_maintenance_km >= 0),
  CONSTRAINT vehicles_maint_interval_positive       CHECK (maintenance_interval_km > 0),
  CONSTRAINT vehicles_year_reasonable               CHECK (year IS NULL OR year BETWEEN 1990 AND extract(year FROM now())::int + 1)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_organization_id ON public.vehicles(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status          ON public.vehicles(status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS tr_vehicles_set_updated_at ON public.vehicles;
CREATE TRIGGER tr_vehicles_set_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Vista: v_vehicle_maintenance_status (Arquitectura §5.4)
-- Semáforo:
--   green:  km_since_maintenance < interval - 500
--   yellow: interval - 500 <= km_since_maintenance < interval
--   red:    km_since_maintenance >= interval (vehículo debe pasar a 'blocked')
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_vehicle_maintenance_status AS
SELECT
  v.id,
  v.organization_id,
  v.internal_code,
  v.license_plate,
  v.current_km,
  v.last_maintenance_km,
  v.maintenance_interval_km,
  (v.current_km - v.last_maintenance_km) AS km_since_maintenance,
  GREATEST(0, v.maintenance_interval_km - (v.current_km - v.last_maintenance_km)) AS km_until_maintenance,
  CASE
    WHEN (v.current_km - v.last_maintenance_km) >= v.maintenance_interval_km THEN 'red'
    WHEN (v.current_km - v.last_maintenance_km) >= (v.maintenance_interval_km - 500) THEN 'yellow'
    ELSE 'green'
  END AS maintenance_light,
  v.status AS vehicle_status,
  v.deleted_at
FROM public.vehicles v;

COMMENT ON VIEW public.v_vehicle_maintenance_status IS
  'Semáforo de mantenimiento por vehículo. Verde: faltan >500km. Amarillo: <=500km. Rojo: vencido.';

-- -----------------------------------------------------------------------------
-- Comentarios
-- -----------------------------------------------------------------------------

COMMENT ON TABLE public.auxiliar_profiles IS 'Datos específicos del auxiliar de vuelo (dirección + lat/lon).';
COMMENT ON TABLE public.driver_profiles   IS 'Datos específicos del conductor (licencia, EPS, ARL).';
COMMENT ON TABLE public.vehicles          IS 'Flota de la organización. Mantenimiento por intervalo de km (default 7000).';

COMMIT;
