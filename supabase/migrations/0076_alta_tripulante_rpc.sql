-- 0076_alta_tripulante_rpc.sql
--
-- El procedimiento del alta: lo que corre cuando el TCP toca «Crear cuenta».
-- El modelo (columnas, catálogo de aerolíneas) va en 0075; acá está el trámite.
--
-- CÓMO ES EL RECORRIDO COMPLETO, PARA QUE SE ENTIENDA QUÉ HACE CADA PIEZA
--   1. El tripulante escribe nombre, correo, teléfono y contraseña.
--   2. El navegador llama a auth.signUp(). Supabase crea el usuario en auth.users
--      SIN confirmar y le manda al correo el código de verificación.
--   3. El tripulante teclea el código → auth.verifyOtp() → ya hay SESIÓN, pero
--      todavía NO hay perfil: para public.profiles esa persona no existe.
--   4. Con esa sesión a medias llama a signup_catalogs(), que es lo ÚNICO que
--      puede leer alguien sin perfil, y elige aerolínea y conjunto.
--   5. Llama a register_auxiliar(), que crea profiles + auxiliar_profiles.
--      A partir de acá es un auxiliar normal y las RLS de siempre lo cubren.
--
-- POR QUÉ HACEN FALTA DOS FUNCIONES SECURITY DEFINER Y NO SE ARREGLA CON RLS.
-- Entre el paso 3 y el 5 el usuario está autenticado pero no pertenece a ninguna
-- organización, y TODAS las políticas del proyecto cuelgan de current_user_org(),
-- que se resuelve leyendo public.profiles. Para él, current_user_org() es NULL:
-- no puede leer el catálogo de residencias ni insertarse a sí mismo en profiles
-- (no existe ninguna policy de INSERT sobre profiles, a propósito — hasta hoy
-- las cuentas las creaba el admin con la service_role). Estas dos funciones son
-- la puerta estrecha para ese hueco, y no hacen nada más.
--
-- LO QUE signup_catalogs() DELIBERADAMENTE NO DEVUELVE: las coordenadas de los
-- conjuntos. Para elegir «Olivar» de una lista basta el nombre; el pin lo pone el
-- servidor cuando ya hay reserva. Quien todavía no es nadie en la organización no
-- necesita —ni recibe— el mapa de dónde duerme la tripulación.
--
-- Idempotente.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A qué organización entra el que se registra
--
-- Hoy hay una sola (Rendio Enterprises) y el registro abierto no tiene forma de
-- preguntar a cuál va. En vez de escribir el uuid a mano, se resuelve; y si algún
-- día aparece una segunda organización, esto REVIENTA en vez de meter callado a
-- los tripulantes en la que no es.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.signup_organization()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE n int; org uuid;
BEGIN
  -- En dos pasos y no con min(id): Postgres no tiene min() para uuid.
  SELECT count(*) INTO n FROM public.organizations;
  IF n = 0 THEN
    RAISE EXCEPTION 'No hay ninguna organización configurada';
  ELSIF n > 1 THEN
    RAISE EXCEPTION 'Hay % organizaciones: el registro abierto no sabe a cuál entrar', n;
  END IF;
  SELECT id INTO org FROM public.organizations LIMIT 1;
  RETURN org;
END;
$$;

-- OJO: Supabase tiene ALTER DEFAULT PRIVILEGES que le regala EXECUTE a `anon` a
-- cada función nueva del esquema public. REVOKE ... FROM PUBLIC no lo quita —
-- es un grant directo al rol— así que hay que nombrar a anon explícitamente.
-- Las tres funciones ya rechazan a quien no tenga sesión; esto es el segundo
-- cerrojo, para que ni siquiera se puedan invocar sin token.
REVOKE ALL ON FUNCTION public.signup_organization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.signup_organization() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Lo que ve el que está a medio registrar
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.signup_catalogs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE org uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  org := public.signup_organization();

  RETURN jsonb_build_object(
    'airlines', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.sort_order, a.name)
        FROM public.airlines a
       WHERE a.organization_id = org AND a.is_active
    ), '[]'::jsonb),
    -- Sin latitude/longitude: ver la nota de arriba.
    'residences', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'sector', r.sector) ORDER BY r.name)
        FROM public.residences r
       WHERE r.organization_id = org AND r.is_active
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.signup_catalogs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.signup_catalogs() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. El alta
--
-- El correo NO se recibe como parámetro: se lee de auth.users. Si se aceptara del
-- cliente, cualquiera podría registrarse con la dirección de otro.
--
-- El nombre se exige completo — «al menos el primer nombre y los dos apellidos»,
-- textual del jefe. La validación se repite en la pantalla (en rojo, mientras
-- escribe) y acá, porque la pantalla se puede saltar y la base de datos no.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_auxiliar(
  p_full_name        text,
  p_phone            text,
  p_airline_id       uuid    DEFAULT NULL,
  p_residence_id     uuid    DEFAULT NULL,
  p_residence_unit   text    DEFAULT NULL,
  p_residence_id_2   uuid    DEFAULT NULL,
  p_residence_unit_2 text    DEFAULT NULL,
  p_home_address     text    DEFAULT NULL,
  p_home_latitude    double precision DEFAULT NULL,
  p_home_longitude   double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid       uuid := auth.uid();
  org       uuid;
  v_email   text;
  v_conf    timestamptz;
  v_name    text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_phone   text := btrim(coalesce(p_phone, ''));
  v_unit    text := nullif(btrim(coalesce(p_residence_unit,   '')), '');
  v_unit2   text := nullif(btrim(coalesce(p_residence_unit_2, '')), '');
  v_addr    text := nullif(btrim(coalesce(p_home_address,     '')), '');
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;

  SELECT u.email, u.email_confirmed_at INTO v_email, v_conf
    FROM auth.users u WHERE u.id = uid;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Usuario sin correo';
  END IF;
  -- El código del correo no es decorativo: sin él no se crea el perfil.
  IF v_conf IS NULL THEN
    RAISE EXCEPTION 'Primero verifica tu correo con el código que te enviamos'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid) THEN
    RAISE EXCEPTION 'Esta cuenta ya está registrada' USING ERRCODE = '23505';
  END IF;

  -- Nombre completo: tres palabras de dos letras para arriba.
  IF array_length(regexp_split_to_array(v_name, ' '), 1) < 3
     OR v_name !~ '^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'' .-]+$'
     OR EXISTS (
       SELECT 1 FROM unnest(regexp_split_to_array(v_name, ' ')) w WHERE length(w) < 2
     ) THEN
    RAISE EXCEPTION 'Escribe tu nombre completo: al menos el primer nombre y los dos apellidos';
  END IF;

  IF length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN
    RAISE EXCEPTION 'El teléfono no parece completo';
  END IF;

  -- O conjunto del catálogo, o dirección con pin. Nunca ninguno de los dos:
  -- es la misma regla que auxiliar_profiles_pickup_known, dicha antes de que
  -- reviente la constraint, para poder contestar algo legible.
  IF p_residence_id IS NULL AND (p_home_latitude IS NULL OR p_home_longitude IS NULL) THEN
    RAISE EXCEPTION 'Falta dónde te recogemos: elige tu conjunto o ubica tu dirección en el mapa';
  END IF;

  org := public.signup_organization();

  INSERT INTO public.profiles (id, organization_id, role, full_name, email, phone)
  VALUES (uid, org, 'auxiliar', v_name, v_email, nullif(v_phone, ''));

  INSERT INTO public.auxiliar_profiles (
    profile_id, airline_id, joined_at,
    residence_id, residence_unit, residence_id_2, residence_unit_2,
    home_address, home_latitude, home_longitude
  ) VALUES (
    -- La fecha en hora de Colombia, no en UTC: current_date a las 8 de la noche
    -- en Rionegro ya es el día siguiente en el servidor, y la antigüedad de la
    -- gente no puede depender de a qué hora abrió la app.
    uid, p_airline_id, (now() AT TIME ZONE 'America/Bogota')::date,
    p_residence_id, v_unit,
    -- Una segunda unidad sin conjunto no es una segunda unidad.
    CASE WHEN p_residence_id_2 IS NOT NULL THEN p_residence_id_2 END,
    CASE WHEN p_residence_id_2 IS NOT NULL THEN v_unit2 END,
    v_addr, p_home_latitude, p_home_longitude
  );

  RETURN jsonb_build_object('ok', true, 'profile_id', uid);
END;
$$;

REVOKE ALL ON FUNCTION public.register_auxiliar(text, text, uuid, uuid, text, uuid, text, text, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_auxiliar(text, text, uuid, uuid, text, uuid, text, text, double precision, double precision) TO authenticated;

COMMENT ON FUNCTION public.register_auxiliar(text, text, uuid, uuid, text, uuid, text, text, double precision, double precision) IS
  'Alta del tripulante desde la app, después de verificar el correo. Crea profiles + auxiliar_profiles para auth.uid(). El correo se lee de auth.users, nunca del cliente.';

COMMIT;
