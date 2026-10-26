-- =============================================================================
-- 0139 · Externos sin app y pedidos que hace el jefe (26-oct-2026)
-- =============================================================================
-- Pendiente de los jefes (26-oct): «revisar cómo parametrizar para que el sistema
-- inserte en ruta a Kriss y los que no están registrados, cuando sean servicios que
-- pidan externos». 0133 ya deja escribir a alguien sin cuenta en la ruta pegada de
-- Julián, pero solo ahí: ese pedido no entraba al Excel, al tablero, a Vuelos ni a
-- Operación, porque todo eso sale de Reservas y una reserva exige un tripulante.
--
-- Decisión (26-oct): el jefe los carga y no entran al cobro.
--
-- QUÉ HACE
--   1. auxiliar_profiles.external: tripulante SIN APP. Lo crea el jefe; tiene su
--      cuenta en la base (para que todo funcione igual: Excel, tablero, Vuelos,
--      Operación, la parada del conductor) pero NO puede entrar: sin contraseña y
--      con la entrada bloqueada (auth.users.banned_until = infinity). No le llegan
--      avisos (no tiene teléfono registrado) y no tiene cuenta de cobro.
--   2. admin_create_external(nombre, teléfono, conjunto, apto) → el tripulante sin
--      app. El conjunto es obligatorio (el carro necesita a dónde ir; si no está,
--      se agrega en Conjuntos). Si ya hay un externo con ese nombre, lo devuelve en
--      vez de duplicarlo.
--   3. admin_create_reservation(tripulante, 'sal'|'lle', hora, vuelo, nota): el jefe
--      pide un traslado A NOMBRE de un tripulante, con app o sin ella. Queda igual
--      que si lo hubiera pedido él (la recogida la pone fill_reservation_pickup
--      desde su conjunto; «Vuelo AV9563.» en las notas, como la app) y entra sola
--      al día publicado (0135). No deja dos del mismo tipo a menos de 3 h.
--   4. A un externo no se le abre cuenta de cobro: un disparador en
--      auxiliar_billing lo frena («A un externo sin app no se le cobra»).
--
-- NO SE TOCA ninguna fila existente ni ninguna función existente.
-- Necesita 0055 (residencias), 0090 (cobro), 0119 (welcome_seen_at).
-- Down: down_migrations/0139_externos_sin_app.down.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.auxiliar_profiles ADD COLUMN IF NOT EXISTS external boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.auxiliar_profiles.external IS
  '0139: tripulante SIN APP que cargó el jefe (Kriss, pedidos de externos). No puede entrar, no recibe avisos y no se le cobra; sus traslados los pide el jefe (admin_create_reservation).';

-- -----------------------------------------------------------------------------
-- 2. El jefe crea al externo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_external(
  p_full_name    text,
  p_phone        text DEFAULT NULL,
  p_residence_id uuid DEFAULT NULL,
  p_unit         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_name  text := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_uid   uuid;
  v_aux   uuid;
  v_res   text;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo un jefe puede agregar externos' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 3 THEN
    RAISE EXCEPTION 'Escribe el nombre del externo (nombre y apellido)' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^\+?[0-9]{7,15}$' THEN
    RAISE EXCEPTION 'El teléfono no parece válido' USING ERRCODE = '22023';
  END IF;
  SELECT r.name INTO v_res FROM public.residences r WHERE r.id = p_residence_id AND r.organization_id = v_org;
  IF v_res IS NULL THEN
    RAISE EXCEPTION 'Elige el conjunto donde se recoge (si no está, agrégalo en Conjuntos)' USING ERRCODE = '22023';
  END IF;

  -- Ya existe un externo con ese nombre en la organización: se devuelve ese.
  SELECT ap.id, pr.id INTO v_aux, v_uid
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.external AND pr.organization_id = v_org AND pr.deleted_at IS NULL
     AND lower(pr.full_name) = lower(v_name)
   LIMIT 1;
  IF v_aux IS NOT NULL THEN
    RETURN jsonb_build_object('auxiliar_profile_id', v_aux, 'profile_id', v_uid, 'name', v_name, 'existed', true);
  END IF;

  -- La cuenta en auth sin contraseña y con la entrada bloqueada: existe solo para
  -- que el resto de la base (perfiles, reservas, rutas) la trate como a cualquiera.
  v_uid := gen_random_uuid();
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, banned_until,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'externo.' || replace(v_uid::text, '-', '') || '@sin-app.invalid', NULL, 'infinity',
          jsonb_build_object('provider', 'none', 'providers', '[]'::jsonb, 'externo', true),
          jsonb_build_object('full_name', v_name), now(), now());
  INSERT INTO public.profiles (id, organization_id, role, full_name, email, phone, welcome_seen_at)
  VALUES (v_uid, v_org, 'auxiliar', v_name, 'externo.' || replace(v_uid::text, '-', '') || '@sin-app.invalid', v_phone, now());
  INSERT INTO public.auxiliar_profiles (profile_id, residence_id, residence_unit, external, joined_at)
  VALUES (v_uid, p_residence_id, nullif(btrim(coalesce(p_unit, '')), ''), true, (now() AT TIME ZONE 'America/Bogota')::date)
  RETURNING id INTO v_aux;

  INSERT INTO public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  VALUES (auth.uid(), 'external_created', 'auxiliar_profile', v_aux,
          jsonb_build_object('name', v_name, 'residence', v_res, 'phone', v_phone));
  RETURN jsonb_build_object('auxiliar_profile_id', v_aux, 'profile_id', v_uid, 'name', v_name, 'existed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_external(text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_external(text, text, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. El jefe pide un traslado a nombre de un tripulante (con o sin app)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_reservation(
  p_aux    uuid,
  p_type   text,          -- 'sal' (casa → JMC) | 'lle' (JMC → casa)
  p_when   timestamptz,   -- salida: presentación en JMC · llegada: aterrizaje
  p_flight text DEFAULT NULL,
  p_note   text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    uuid := public.current_user_org();
  v_auxorg uuid;
  v_res    uuid;
  v_unit   text;
  v_lat    double precision;
  v_lng    double precision;
  v_addr   text;
  v_dir    public.trip_direction;
  v_code   text := upper(regexp_replace(coalesce(p_flight, ''), '[\s-]', '', 'g'));
  v_notes  text;
  v_id     uuid;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo un jefe puede pedir a nombre de otro' USING ERRCODE = '42501';
  END IF;
  SELECT pr.organization_id, ap.residence_id, ap.residence_unit, ap.home_latitude, ap.home_longitude, ap.home_address
    INTO v_auxorg, v_res, v_unit, v_lat, v_lng, v_addr
    FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
   WHERE ap.id = p_aux AND pr.deleted_at IS NULL;
  IF v_auxorg IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Ese tripulante no es de tu organización' USING ERRCODE = '42501';
  END IF;
  IF p_type NOT IN ('sal', 'lle') THEN
    RAISE EXCEPTION 'Elige si es salida o llegada' USING ERRCODE = '22023';
  END IF;
  IF p_when IS NULL OR p_when < now() - interval '2 hours' OR p_when > now() + interval '30 days' THEN
    RAISE EXCEPTION 'La hora tiene que ser de hoy en adelante (hasta 30 días)' USING ERRCODE = '22023';
  END IF;
  IF v_code <> '' AND v_code !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'El vuelo no parece válido (ej. AV9563)' USING ERRCODE = '22023';
  END IF;
  v_dir := CASE WHEN p_type = 'lle' THEN 'airport_to_home'::public.trip_direction ELSE 'home_to_airport'::public.trip_direction END;
  IF EXISTS (SELECT 1 FROM public.reservations r
              WHERE r.auxiliar_profile_id = p_aux AND r.direction = v_dir AND r.cancelled_at IS NULL
                AND r.required_arrival_at BETWEEN p_when - interval '3 hours' AND p_when + interval '3 hours') THEN
    RAISE EXCEPTION 'Ya tiene una % a esa hora (menos de 3 h): revísala en Reservas', CASE WHEN p_type = 'lle' THEN 'llegada' ELSE 'salida' END
      USING ERRCODE = '23505';
  END IF;
  -- Las notas como las escribe la app (createReservation): «Vuelo AV9563. …».
  v_notes := concat_ws(' ', CASE WHEN v_code <> '' THEN 'Vuelo ' || v_code || '.' END,
                        nullif(regexp_replace(btrim(coalesce(p_note, '')), '\s+', ' ', 'g'), ''),
                        '(Pedido por Coordinación.)');
  INSERT INTO public.reservations (auxiliar_profile_id, flight_id, direction, status_h2a, status_a2h,
                                   pickup_address, pickup_latitude, pickup_longitude, residence_id, residence_unit,
                                   required_arrival_at, notes, is_overnight, is_firm)
  VALUES (p_aux, NULL, v_dir,
          CASE WHEN p_type = 'sal' THEN 'requested'::public.reservation_status_h2a END,
          CASE WHEN p_type = 'lle' THEN 'scheduled'::public.reservation_status_a2h END,
          CASE WHEN v_res IS NULL THEN v_addr END, CASE WHEN v_res IS NULL THEN v_lat END, CASE WHEN v_res IS NULL THEN v_lng END,
          v_res, v_unit, p_when, v_notes, false, true)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  VALUES (auth.uid(), 'reservation_by_admin', 'reservation', v_id,
          jsonb_build_object('auxiliar_profile_id', p_aux, 'type', p_type, 'when', p_when, 'flight', nullif(v_code, '')));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_reservation(uuid, text, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_reservation(uuid, text, timestamptz, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sin cuenta de cobro para un externo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_billing_external()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.auxiliar_profiles ap WHERE ap.id = NEW.auxiliar_profile_id AND ap.external) THEN
    RAISE EXCEPTION 'A un externo sin app no se le cobra' USING ERRCODE = '22023', HINT = 'externo';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tr_auxiliar_billing_no_external ON public.auxiliar_billing;
CREATE TRIGGER tr_auxiliar_billing_no_external
  BEFORE INSERT ON public.auxiliar_billing
  FOR EACH ROW EXECUTE FUNCTION public.guard_billing_external();

COMMIT;
