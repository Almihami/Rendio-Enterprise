-- 0075_registro_tripulantes.sql
--
-- El TCP se registra solo: el alta de tripulantes deja de ser una tarea del admin.
--
-- POR QUÉ. Hasta hoy un auxiliar solo existía si alguien del equipo le creaba la
-- cuenta a mano (los 102 perfiles de dev salieron de un seed). Eso funciona para
-- probar y no funciona para operar: cada tripulante nuevo de cada aerolínea es un
-- correo, una contraseña inventada por nosotros y un dato de dirección copiado de
-- un WhatsApp. El jefe lo pidió al revés — «que el registro tome todos los datos
-- […] y que solo sea una vez, que eso ya les quede guardado».
--
-- QUÉ ENTRA AQUÍ (solo el modelo; las pantallas van en el front):
--   1. Catálogo de aerolíneas — el desplegable del registro. Tabla y no CHECK
--      porque la profa lo pidió explícito: «no lista cerrada, pero sí una lista
--      desplegable con las opciones». Con tabla, el admin agrega una aerolínea
--      sin que haya que desplegar código.
--   2. Los datos nuevos del tripulante: aerolínea, fecha de ingreso y la SEGUNDA
--      unidad (ver abajo).
--   3. register_auxiliar() — el alta propiamente dicha, que corre DESPUÉS de que
--      el correo quedó verificado con el código de 6/8 dígitos que manda Supabase.
--   4. signup_catalogs() — lo único que puede leer alguien que ya verificó su
--      correo pero todavía no tiene perfil.
--
-- LA SEGUNDA UNIDAD. «Unidad» aquí es el apartamento / la unidad residencial, y
-- hay tripulantes que rotan entre dos sitios (el apartamento propio y donde la
-- familia). Se modela como la pareja completa conjunto+apartamento por duplicado
-- y no como un segundo número de apto suelto: así funciona igual si las dos
-- opciones están en el mismo conjunto (misma portería, distinto timbre) que si
-- están en conjuntos distintos (otra portería, y el carro se va a otro lado).
-- Cuál de las dos aplica se decide EN CADA PEDIDO, no en el perfil.
--
-- LA FECHA DE INGRESO. Se estampa sola el día que se registra, porque para el que
-- entra hoy esa ES su fecha. Los TCP que ya llevan tiempo con Rendio la corrige el
-- admin — de ahí que sea editable. Lo que NO puede es corregírsela el tripulante:
-- de esa fecha van a colgar los beneficios por antigüedad, así que la política
-- p_auxiliar_profiles_update_own se tapa con un trigger.
--
-- Los beneficios por antigüedad NO entran en esta migración. Acá solo queda el
-- dato del que van a colgar, que es lo que se pidió: «que dentro del MER tenga un
-- atributo de tiempo o fecha, para que se tenga en cuenta».
--
-- Idempotente. Sigue el patrón de 0055 (catálogo con organization_id + RLS de
-- lectura para la organización y escritura solo admin).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Catálogo de aerolíneas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.airlines (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  iata_code        text,
  sort_order       smallint    NOT NULL DEFAULT 100,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT airlines_name_len CHECK (btrim(name) <> '')
);

ALTER TABLE public.airlines DROP CONSTRAINT IF EXISTS airlines_org_name_key;
ALTER TABLE public.airlines ADD  CONSTRAINT airlines_org_name_key UNIQUE (organization_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_airlines_org_name_ci
  ON public.airlines(organization_id, lower(btrim(name)));

DROP TRIGGER IF EXISTS tr_airlines_set_updated_at ON public.airlines;
CREATE TRIGGER tr_airlines_set_updated_at
  BEFORE UPDATE ON public.airlines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.airlines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_airlines_select_org ON public.airlines;
CREATE POLICY p_airlines_select_org ON public.airlines
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_airlines_admin_all ON public.airlines;
CREATE POLICY p_airlines_admin_all ON public.airlines
  FOR ALL TO authenticated
  USING      (organization_id = public.current_user_org() AND public.current_user_role() = 'admin')
  WITH CHECK (organization_id = public.current_user_org() AND public.current_user_role() = 'admin');

COMMENT ON TABLE public.airlines IS
  'Aerolíneas que se ofrecen en el desplegable del registro del tripulante. Tabla y no CHECK para que el admin pueda agregar una sin desplegar código.';
COMMENT ON COLUMN public.airlines.iata_code IS
  'Prefijo de los números de vuelo (AV, P5, JA, LA). OJO: el desembarque por aerolínea (0058) NO lee esta columna — sigue leyendo app_settings.route_deplane_*. Acá está para que el día que se midan JetSMART y LATAM haya dónde colgarlo.';

-- Las cuatro que la operación confirmó el 25-ago. De Avianca y Wingo hay tiempo
-- de desembarque medido (0058); de JetSMART y LATAM no, y por eso van marcadas
-- en el comentario de arriba en vez de con un número inventado.
INSERT INTO public.airlines (organization_id, name, iata_code, sort_order)
SELECT o.id, v.name, v.code, v.ord
  FROM public.organizations o
  CROSS JOIN (VALUES
    ('Avianca',  'AV', 10),
    ('JetSMART', 'JA', 20),
    ('Wingo',    'P5', 30),
    ('LATAM',    'LA', 40)
  ) AS v(name, code, ord)
ON CONFLICT (organization_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Lo nuevo del tripulante
-- ---------------------------------------------------------------------------

ALTER TABLE public.auxiliar_profiles
  ADD COLUMN IF NOT EXISTS airline_id       uuid REFERENCES public.airlines(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS joined_at        date,
  ADD COLUMN IF NOT EXISTS residence_id_2   uuid REFERENCES public.residences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS residence_unit_2 text;

CREATE INDEX IF NOT EXISTS idx_auxiliar_profiles_airline
  ON public.auxiliar_profiles(airline_id) WHERE airline_id IS NOT NULL;

COMMENT ON COLUMN public.auxiliar_profiles.airline_id IS
  'Aerolínea para la que vuela. Del catálogo public.airlines.';
COMMENT ON COLUMN public.auxiliar_profiles.joined_at IS
  'Desde cuándo está con Rendio. La estampa sola el registro; el admin la corrige para los que ya llevaban tiempo. De acá cuelgan los beneficios por antigüedad. El propio tripulante NO puede cambiarla (guard_auxiliar_joined_at).';
COMMENT ON COLUMN public.auxiliar_profiles.residence_id_2 IS
  'Segunda unidad: el otro sitio donde a veces duerme. NULL = solo tiene uno. Puede ser el MISMO conjunto que residence_id con otro apartamento.';
COMMENT ON COLUMN public.auxiliar_profiles.residence_unit_2 IS
  'Apartamento/torre de la segunda unidad.';

-- La antigüedad la corrige el admin, no el interesado.
--
-- p_auxiliar_profiles_update_own deja al tripulante escribir CUALQUIER columna de
-- su propia fila, que es lo correcto para su dirección y su apartamento y lo
-- contrario de lo correcto para la fecha de la que van a salir las promociones.
-- El trigger corre para todos y solo perdona al admin y al service_role (el seed).
CREATE OR REPLACE FUNCTION public.guard_auxiliar_joined_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.joined_at IS DISTINCT FROM OLD.joined_at
     AND auth.uid() IS NOT NULL
     AND coalesce(public.current_user_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'La fecha de ingreso solo la puede cambiar un administrador'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_auxiliar_guard_joined_at ON public.auxiliar_profiles;
CREATE TRIGGER tr_auxiliar_guard_joined_at
  BEFORE UPDATE OF joined_at ON public.auxiliar_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_auxiliar_joined_at();

-- ---------------------------------------------------------------------------
-- 3. La reserva guarda a qué apartamento fue
--
-- residence_id ya decía a qué PORTERÍA va el carro (0055). Con dos unidades hace
-- falta además a qué puerta: en Olivar viven 14 tripulantes y el conductor
-- necesita saber a quién está esperando. Es la misma foto-del-momento que
-- residence_id: si la persona se muda, la reserva vieja conserva a dónde se fue.
-- ---------------------------------------------------------------------------

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS residence_unit text;

COMMENT ON COLUMN public.reservations.residence_unit IS
  'Apartamento/torre de ESTA reserva. Con dos unidades el tripulante elige en cada pedido; el carro para en la portería y el conductor timbra acá.';

-- El puente de 0055, ampliado: si la reserva no trae apartamento, se hereda el
-- del perfil — pero el de la unidad que corresponda al conjunto elegido, no el
-- primero que aparezca. Sin este cuidado, pedir desde la unidad 2 mostraría al
-- conductor el apartamento de la unidad 1.
CREATE OR REPLACE FUNCTION public.fill_reservation_pickup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  r  public.residences%ROWTYPE;
  ap public.auxiliar_profiles%ROWTYPE;
BEGIN
  SELECT * INTO ap FROM public.auxiliar_profiles WHERE id = NEW.auxiliar_profile_id;

  -- Sin residencia explícita, heredar la del perfil del auxiliar.
  IF NEW.residence_id IS NULL THEN
    NEW.residence_id := ap.residence_id;
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

  -- El apartamento: solo si no vino en el pedido, y solo el de la unidad que
  -- de verdad corresponde al conjunto de esta reserva.
  IF btrim(coalesce(NEW.residence_unit, '')) = '' AND NEW.residence_id IS NOT NULL THEN
    IF ap.residence_id_2 IS NOT NULL AND NEW.residence_id = ap.residence_id_2
       AND (ap.residence_id IS NULL OR ap.residence_id <> ap.residence_id_2) THEN
      NEW.residence_unit := nullif(btrim(coalesce(ap.residence_unit_2, '')), '');
    ELSIF NEW.residence_id = ap.residence_id THEN
      NEW.residence_unit := nullif(btrim(coalesce(ap.residence_unit, '')), '');
    END IF;
  END IF;

  -- Último recurso: el pin propio del perfil (auxiliar fuera del catálogo).
  IF NEW.pickup_latitude IS NULL OR NEW.pickup_longitude IS NULL THEN
    NEW.pickup_latitude  := ap.home_latitude;
    NEW.pickup_longitude := ap.home_longitude;
    NEW.pickup_address   := coalesce(nullif(btrim(coalesce(NEW.pickup_address, '')), ''), ap.home_address);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reservations_fill_pickup ON public.reservations;
CREATE TRIGGER tr_reservations_fill_pickup
  BEFORE INSERT OR UPDATE OF residence_id, residence_unit, pickup_latitude, pickup_longitude
  ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.fill_reservation_pickup();

COMMIT;
