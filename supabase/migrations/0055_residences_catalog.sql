-- 0055_residences_catalog.sql
--
-- Catálogo de residencias: de dónde se recoge de verdad a los tripulantes.
--
-- POR QUÉ. Hasta ahora el punto de recogida salía de que el auxiliar escribiera
-- su dirección y nosotros la geocodificáramos con Nominatim/OSM. Eso NO funciona
-- en Rionegro: de los 39 conjuntos donde vive la tripulación real, OpenStreetMap
-- solo conoce 4. Olivar, Solare, Cámbulo, Boral, Forest, Viverdi, Sendai, Ébano…
-- simplemente no existen en OSM (sí en Google Maps). Y donde OSM sí respondió,
-- el error fue de 60–143 m — salvo Senderos de San Sebastián, que quedó a
-- 2.106 m: acertó el nombre de la calle y erró el tramo. Un carro mandado a
-- 2 km del sitio a las 3 de la mañana es un vuelo perdido.
--
-- QUÉ CAMBIA. La dirección deja de ser texto libre que hay que adivinar y pasa a
-- ser una FILA de catálogo con su coordenada confirmada a mano (pin de Google
-- Maps de la operación). El auxiliar ELIGE su conjunto de una lista; no escribe.
--
-- LO QUE NO CAMBIA (a propósito):
--   · reservations.pickup_latitude/longitude SIGUEN siendo la fuente que lee el
--     asignador. No los reemplazo: los LLENO desde la residencia con un trigger.
--     Así el front y el solver no se enteran, y las reservas viejas conservan a
--     dónde fue el carro de verdad aunque la persona después se mude.
--   · auxiliar_profiles.home_address/home_latitude/home_longitude se conservan
--     como la salida de emergencia: quien NO viva en un conjunto del catálogo
--     (casa propia, se queda donde un familiar) sigue pudiendo dar su pin.
--
-- Sigue el patrón de `airports` (0003): tabla de catálogo con organization_id,
-- RLS de lectura para toda la organización y escritura solo admin.
-- Idempotente.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. El catálogo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.residences (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  latitude         double precision NOT NULL,
  longitude        double precision NOT NULL,
  access_note      text,
  sector           text,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT residences_name_len  CHECK (btrim(name) <> ''),
  -- Caja del Oriente antioqueño. No es paranoia: el bug que originó esta tabla
  -- fue precisamente una coordenada que cayó lejos del sitio. Si alguien pega
  -- una coord mal copiada, que reviente aquí y no a las 3am con el carro andando.
  CONSTRAINT residences_coords_oriente CHECK (
    latitude  BETWEEN  5.9 AND  6.5 AND
    longitude BETWEEN -75.7 AND -75.1
  )
);

-- Unicidad canónica por (org, nombre). Va como CONSTRAINT y no solo como índice
-- porque el upsert de PostgREST (`on_conflict=organization_id,name`, que usa el
-- seed) exige una constraint sobre esas columnas exactas: con un índice de
-- expresión responde 42P10 y no hay forma de sembrar de forma idempotente.
ALTER TABLE public.residences DROP CONSTRAINT IF EXISTS residences_org_name_key;
ALTER TABLE public.residences ADD  CONSTRAINT residences_org_name_key UNIQUE (organization_id, name);

-- Además, guarda contra el duplicado que la constraint de arriba NO ve:
-- "Olivar Apartamentos" vs "olivar apartamentos " serían dos filas distintas
-- para Postgres, y dos porterías distintas para el tablero.
CREATE UNIQUE INDEX IF NOT EXISTS idx_residences_org_name_ci
  ON public.residences(organization_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_residences_active
  ON public.residences(organization_id) WHERE is_active;

COMMENT ON TABLE  public.residences IS
  'Conjuntos/edificios donde vive la tripulación, con la coordenada de la PORTERÍA confirmada a mano. Reemplaza la geocodificación de direcciones: OSM no conoce los condominios privados de Rionegro.';
COMMENT ON COLUMN public.residences.latitude IS
  'Coordenada del punto donde PARA el carro (portería), no del centro del conjunto.';
COMMENT ON COLUMN public.residences.access_note IS
  'Cómo entrar o dónde esperar: "portería 2", "reja verde", "entrada por la 52".';
COMMENT ON COLUMN public.residences.sector IS
  'Etiqueta para humanos en el tablero (Norte, Llanogrande…). OJO: NO usar para agrupar rutas — se midió que agrupar por nombre de sector no corresponde a la cercanía real por vía; eso lo decide la matriz de tiempos.';

DROP TRIGGER IF EXISTS tr_residences_set_updated_at ON public.residences;
CREATE TRIGGER tr_residences_set_updated_at
  BEFORE UPDATE ON public.residences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.residences ENABLE ROW LEVEL SECURITY;

-- Leer: toda la organización. El auxiliar necesita la lista para elegir la suya
-- y el conductor necesita saber a dónde va. No hay nada sensible: es el nombre
-- de un conjunto y su portería.
DROP POLICY IF EXISTS p_residences_select_org ON public.residences;
CREATE POLICY p_residences_select_org ON public.residences
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

-- Escribir: solo admin. El catálogo es infraestructura de la operación; si cada
-- auxiliar pudiera mover la coordenada de su conjunto, un dedazo desviaría el
-- carro de todos los que viven ahí.
DROP POLICY IF EXISTS p_residences_admin_all ON public.residences;
CREATE POLICY p_residences_admin_all ON public.residences
  FOR ALL TO authenticated
  USING      (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- 2. El auxiliar vive en una residencia (o da su propio pin)
-- ---------------------------------------------------------------------------

ALTER TABLE public.auxiliar_profiles
  ADD COLUMN IF NOT EXISTS residence_id   uuid REFERENCES public.residences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS residence_unit text;

CREATE INDEX IF NOT EXISTS idx_auxiliar_profiles_residence
  ON public.auxiliar_profiles(residence_id) WHERE residence_id IS NOT NULL;

COMMENT ON COLUMN public.auxiliar_profiles.residence_id IS
  'Conjunto donde vive, elegido de una lista. NULL = vive fuera del catálogo y usa home_latitude/home_longitude.';
COMMENT ON COLUMN public.auxiliar_profiles.residence_unit IS
  'Torre/apto/interior. El carro para en la portería (una sola para los 14 de Olivar); esto es para que el conductor sepa a quién está esperando.';

-- home_* deja de ser obligatorio: quien elige conjunto no tiene por qué dar
-- coordenada propia. Relajar un NOT NULL no rompe filas existentes.
ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_address   DROP NOT NULL;
ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_latitude  DROP NOT NULL;
ALTER TABLE public.auxiliar_profiles ALTER COLUMN home_longitude DROP NOT NULL;

-- …pero SIEMPRE tiene que haber una forma de saber dónde recogerlo. O conjunto,
-- o pin propio. Nunca ninguno de los dos: eso es una reserva que no se puede rutear.
ALTER TABLE public.auxiliar_profiles DROP CONSTRAINT IF EXISTS auxiliar_profiles_pickup_known;
ALTER TABLE public.auxiliar_profiles
  ADD CONSTRAINT auxiliar_profiles_pickup_known CHECK (
    residence_id IS NOT NULL
    OR (home_latitude IS NOT NULL AND home_longitude IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 3. La reserva guarda de qué residencia salió
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS residence_id uuid REFERENCES public.residences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_residence
  ON public.reservations(residence_id) WHERE residence_id IS NOT NULL;

COMMENT ON COLUMN public.reservations.residence_id IS
  'Residencia de la que salió esta reserva (foto del momento). Si la persona se muda, las reservas viejas siguen apuntando a donde el carro fue de verdad.';

-- pickup_address deja de ser obligatorio en el INSERT: el trigger de abajo lo
-- llena con el nombre del conjunto cuando viene residence_id.
ALTER TABLE public.reservations ALTER COLUMN pickup_address DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. El puente: llenar pickup_* desde la residencia
--
-- Esto es lo que hace que NADA del asignador tenga que cambiar. El solver sigue
-- leyendo reservations.pickup_latitude/longitude como siempre; simplemente ahora
-- esos valores vienen de un pin confirmado y no de un geocodificador adivinando.
--
-- Solo llena lo que venga vacío: si la reserva trae su propia coordenada (el
-- caso "hoy no estoy en mi casa"), se respeta y no se toca.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fill_reservation_pickup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE r public.residences%ROWTYPE;
BEGIN
  -- Sin residencia explícita, heredar la del perfil del auxiliar.
  IF NEW.residence_id IS NULL THEN
    SELECT ap.residence_id INTO NEW.residence_id
      FROM public.auxiliar_profiles ap WHERE ap.id = NEW.auxiliar_profile_id;
  END IF;

  IF NEW.residence_id IS NOT NULL THEN
    SELECT * INTO r FROM public.residences WHERE id = NEW.residence_id;
    IF FOUND THEN
      IF NEW.pickup_latitude  IS NULL THEN NEW.pickup_latitude  := r.latitude;  END IF;
      IF NEW.pickup_longitude IS NULL THEN NEW.pickup_longitude := r.longitude; END IF;
      IF btrim(coalesce(NEW.pickup_address, '')) = '' THEN
        NEW.pickup_address := r.name || coalesce(' · ' || nullif(btrim(r.access_note), ''), '');
      END IF;
    END IF;
  END IF;

  -- Último recurso: el pin propio del perfil (auxiliar fuera del catálogo).
  IF NEW.pickup_latitude IS NULL OR NEW.pickup_longitude IS NULL THEN
    SELECT ap.home_latitude, ap.home_longitude, coalesce(nullif(btrim(NEW.pickup_address,''), ''), ap.home_address)
      INTO NEW.pickup_latitude, NEW.pickup_longitude, NEW.pickup_address
      FROM public.auxiliar_profiles ap WHERE ap.id = NEW.auxiliar_profile_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fill_reservation_pickup() IS
  'Completa pickup_address/latitude/longitude desde la residencia (o del pin propio del auxiliar) sin pisar lo que venga explícito. Mantiene al asignador leyendo pickup_* como siempre.';

DROP TRIGGER IF EXISTS tr_reservations_fill_pickup ON public.reservations;
CREATE TRIGGER tr_reservations_fill_pickup
  BEFORE INSERT OR UPDATE OF residence_id, pickup_latitude, pickup_longitude
  ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.fill_reservation_pickup();

COMMIT;
