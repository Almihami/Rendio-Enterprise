-- =============================================================================
-- 0091 · Rendio Points (programa de puntos del tripulante) — nace APAGADO
-- =============================================================================
-- Rediseño del auxiliar (entrega del 27-sep-2026), paquete P13a (AJUSTES §6 y §8).
--
-- QUÉ ES
--   Un libro de puntos por tripulante. Se ganan por cosas que le ahorran plata o
--   le traen gente a la operación, y se canjean por cosas que el jefe CUMPLE a
--   mano. Los puntos NO son plata: no se retiran, no se transfieren, no tienen
--   equivalencia en pesos en ningún lado de la base.
--
-- INTERRUPTOR
--   app_settings.aux_points_enabled, por defecto FALSE. Apagado: ningún trigger
--   acredita, no se reclaman códigos y no se canjea. Lo ya ganado se conserva.
--
-- CÓMO SE GANA (lo acredita la BASE, nunca el teléfono)
--   · Invitar: el colega que se registró con TU código hace su primer viaje
--     ENTREGADO (status 'delivered') → aux_points_invite (40). Si vive en tu
--     mismo conjunto (residence_id principal igual) → aux_points_neighbor (80).
--     Se acredita una sola vez por colega, en la primera entrega que ocurra con
--     el programa encendido.
--   · Avisar a tiempo: cancelas TÚ (cancelled_by = tu cuenta) un traslado que ya
--     tenía hora de recogida PUBLICADA (calculated_pickup_at, 0085) con al menos
--     aux_points_cancel_lead_hours (2 h) de anticipación → aux_points_cancel (20).
--     Sin hora publicada no hay asiento que liberar y no suma (así tampoco se
--     pueden fabricar puntos pidiendo y cancelando).
--   · Calificar: la PRIMERA calificación de un viaje ENTREGADO → aux_points_rate (5).
--
--   Idempotencia: cada movimiento lleva una dedupe_key ÚNICA ('ref:<colega>',
--   'cancel:<reserva>', 'rate:<reserva>', 'redeem:<canje>', 'refund:<canje>'),
--   así que ningún reintento ni doble evento acredita dos veces.
--
--   Los triggers NUNCA tumban la operación: si algo del cálculo de puntos falla,
--   se deja un WARNING y la entrega / cancelación / calificación sigue.
--
-- CÓMO SE CANJEA
--   aux_points_redeem(reward): descuenta al instante (no deja saldo negativo, con
--   candado por tripulante) y deja el canje 'pending'. El jefe lo marca
--   'fulfilled' o 'rejected' (con motivo; rechazar DEVUELVE los puntos).
--   Vitrina (aux_points_rewards): colega gratis 180 · 3 días de mensualidad 400
--   (el jefe lo aplica como descuento en Cuentas de cobro, 0090) · Privado 600
--   (solicitud que aprueba el jefe) · Directo «Pronto» (soon=true: no se canjea,
--   ese nivel no existe todavía).
--
-- CÓDIGO DE REFERIDO
--   Tipo LAURA-OLV: primer nombre + 3 letras del conjunto (o del primer apellido
--   si no tiene conjunto). Se crea la primera vez que el tripulante lo pide
--   (aux_points_my_code) con el programa encendido. register_auxiliar NO cambia:
--   el código de quien te invitó se guarda DESPUÉS con aux_points_claim_referral.
--
-- PRIVACIDAD
--   · Nadie ve el saldo ni los movimientos de otro tripulante (RLS: solo lo suyo;
--     el jefe, lo de su organización).
--   · «Invitaste a» (aux_points_my_referrals) devuelve SOLO a quienes se
--     registraron con TU código, como «Nombre I.» (primer nombre + inicial del
--     primer apellido). Nunca correo, teléfono ni id.
--   · La meta del conjunto (aux_points_my_goal) es un número anónimo (cuántos
--     tripulantes activos hay en tu conjunto) y su texto lo escribe el jefe.
--
-- Idempotente: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- Down: down_migrations/0091_rendio_points.down.sql (borra el libro: avisar).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Interruptor y valores (app_settings, fila única)
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS aux_points_enabled          boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS aux_points_invite           smallint NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS aux_points_neighbor         smallint NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS aux_points_cancel           smallint NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS aux_points_cancel_lead_hours smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS aux_points_rate             smallint NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS aux_points_goal_target      smallint,
  ADD COLUMN IF NOT EXISTS aux_points_goal_text        text;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_points_values_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_aux_points_values_range CHECK (
  aux_points_invite   BETWEEN 0 AND 5000 AND
  aux_points_neighbor BETWEEN 0 AND 5000 AND
  aux_points_cancel   BETWEEN 0 AND 5000 AND
  aux_points_rate     BETWEEN 0 AND 5000 AND
  aux_points_cancel_lead_hours BETWEEN 1 AND 48);
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_aux_points_goal_range;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_aux_points_goal_range CHECK (
  (aux_points_goal_target IS NULL OR aux_points_goal_target BETWEEN 1 AND 500) AND
  (aux_points_goal_text IS NULL OR length(aux_points_goal_text) <= 160));

COMMENT ON COLUMN public.app_settings.aux_points_enabled IS
  'Rendio Points (0091). Apagado por defecto: nada acredita, no se reclaman códigos ni se canjea.';
COMMENT ON COLUMN public.app_settings.aux_points_goal_text IS
  'Texto de la meta del conjunto, lo escribe el jefe (no prometer «carro fijo»). Sin texto o sin meta, no hay tarjeta.';

-- ---------------------------------------------------------------------------
-- 2. Vitrina de canjes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.aux_points_rewards (
  id          text PRIMARY KEY,
  title       text     NOT NULL,
  description text     NOT NULL,
  cost        integer  NOT NULL,
  kind        text     NOT NULL,
  amount      integer,                         -- p. ej. 3 (días) en billing_days
  enabled     boolean  NOT NULL DEFAULT true,
  soon        boolean  NOT NULL DEFAULT false, -- «Pronto»: se muestra, no se canjea
  sort        smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aux_points_rewards_cost_pos CHECK (cost BETWEEN 1 AND 100000),
  CONSTRAINT aux_points_rewards_kind_ok  CHECK (kind IN ('guest_seat','direct_trip','billing_days','private_trip'))
);
COMMENT ON TABLE public.aux_points_rewards IS
  'Rendio Points (0091): lo que se puede canjear. Los puntos no son plata. El jefe edita costo y si está disponible.';

INSERT INTO public.aux_points_rewards (id, title, description, cost, kind, amount, enabled, soon, sort) VALUES
  ('colega',  'Traer a un colega gratis', 'Un cupo en tu traslado compartido',          180, 'guest_seat',   1, true, false, 1),
  ('directo', 'Un traslado Directo',      'Sin paradas, derecho a tu destino',          320, 'direct_trip',  1, true, true,  2),
  ('mensual', '3 días de tu mensualidad', 'Se descuentan de tu próximo cobro',          400, 'billing_days', 3, true, false, 3),
  ('privado', 'Un traslado Privado',      'Carro solo para ti · lo confirma Coordinación', 600, 'private_trip', 1, true, false, 4)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS tr_aux_points_rewards_updated_at ON public.aux_points_rewards;
CREATE TRIGGER tr_aux_points_rewards_updated_at BEFORE UPDATE ON public.aux_points_rewards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Códigos de referido y referidos
-- ---------------------------------------------------------------------------
-- Tablas de solo inserción (un código no se edita): sin updated_at.
CREATE TABLE IF NOT EXISTS public.aux_referral_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aux_referral_codes_aux_key UNIQUE (auxiliar_profile_id),
  CONSTRAINT aux_referral_codes_code_key UNIQUE (code),
  CONSTRAINT aux_referral_codes_format CHECK (code ~ '^[A-Z]{2,10}-[A-Z]{3}[0-9]{0,3}$')
);

CREATE TABLE IF NOT EXISTS public.aux_referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referred_aux_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  referrer_aux_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  code            text NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  credited_at     timestamptz,
  credited_points integer,
  neighbor        boolean,
  first_reservation_id uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aux_referrals_referred_key UNIQUE (referred_aux_id),   -- a cada quien lo invita UNA persona
  CONSTRAINT aux_referrals_not_self CHECK (referred_aux_id <> referrer_aux_id)
);
CREATE INDEX IF NOT EXISTS idx_aux_referrals_referrer ON public.aux_referrals (referrer_aux_id);
DROP TRIGGER IF EXISTS tr_aux_referrals_updated_at ON public.aux_referrals;
CREATE TRIGGER tr_aux_referrals_updated_at BEFORE UPDATE ON public.aux_referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Canjes y libro de puntos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.aux_points_redemptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  reward_id           text NOT NULL REFERENCES public.aux_points_rewards(id),
  reward_title        text NOT NULL,           -- el título al momento del canje
  cost                integer NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  note                text,
  -- clock_timestamp(): la hora real de la fila, no la de la transacción (dos
  -- movimientos en la misma transacción quedan en su orden verdadero).
  requested_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at          timestamptz,
  decided_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decision_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aux_points_redemptions_status_ok CHECK (status IN ('pending','fulfilled','rejected')),
  CONSTRAINT aux_points_redemptions_cost_pos  CHECK (cost > 0)
);
CREATE INDEX IF NOT EXISTS idx_aux_points_redemptions_aux ON public.aux_points_redemptions (auxiliar_profile_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_aux_points_redemptions_pending ON public.aux_points_redemptions (requested_at) WHERE status = 'pending';
DROP TRIGGER IF EXISTS tr_aux_points_redemptions_updated_at ON public.aux_points_redemptions;
CREATE TRIGGER tr_aux_points_redemptions_updated_at BEFORE UPDATE ON public.aux_points_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- El libro es de SOLO INSERCIÓN (un movimiento nunca se edita ni se borra; una
-- corrección es otro movimiento): por eso no lleva updated_at.

CREATE TABLE IF NOT EXISTS public.aux_points_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  points              integer NOT NULL,
  kind                text NOT NULL,
  dedupe_key          text NOT NULL,
  reservation_id      uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
  referred_aux_id     uuid REFERENCES public.auxiliar_profiles(id) ON DELETE SET NULL,
  redemption_id       uuid REFERENCES public.aux_points_redemptions(id) ON DELETE SET NULL,
  note                text,
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aux_points_ledger_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT aux_points_ledger_points_nonzero CHECK (points <> 0),
  CONSTRAINT aux_points_ledger_kind_ok CHECK (kind IN
    ('referral','referral_neighbor','cancel_early','rate','redeem','redeem_refund','adjust'))
);
CREATE INDEX IF NOT EXISTS idx_aux_points_ledger_aux ON public.aux_points_ledger (auxiliar_profile_id, created_at DESC);
COMMENT ON TABLE public.aux_points_ledger IS
  'Rendio Points (0091): libro de movimientos. Saldo = suma de points. Los puntos NO son plata. Solo escriben las funciones de 0091.';

-- ---------------------------------------------------------------------------
-- 5. RLS: lo tuyo es tuyo; el jefe ve su organización; nadie escribe directo
-- ---------------------------------------------------------------------------
ALTER TABLE public.aux_points_rewards     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aux_referral_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aux_referrals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aux_points_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aux_points_ledger      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.aux_points_rewards, public.aux_referral_codes, public.aux_referrals,
              public.aux_points_redemptions, public.aux_points_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.aux_points_rewards, public.aux_referral_codes, public.aux_referrals,
     public.aux_points_redemptions, public.aux_points_ledger FROM authenticated;
GRANT SELECT ON public.aux_points_rewards, public.aux_referral_codes, public.aux_referrals,
                public.aux_points_redemptions, public.aux_points_ledger TO authenticated;
-- El jefe edita SOLO costo y disponibilidad de la vitrina (título, tipo y
-- «Pronto» los fija la migración: Directo no existe como nivel).
GRANT UPDATE (cost, enabled) ON public.aux_points_rewards TO authenticated;

DROP POLICY IF EXISTS p_aux_points_rewards_select ON public.aux_points_rewards;
CREATE POLICY p_aux_points_rewards_select ON public.aux_points_rewards
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS p_aux_points_rewards_update_admin ON public.aux_points_rewards;
CREATE POLICY p_aux_points_rewards_update_admin ON public.aux_points_rewards
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

DROP POLICY IF EXISTS p_aux_referral_codes_select_own ON public.aux_referral_codes;
CREATE POLICY p_aux_referral_codes_select_own ON public.aux_referral_codes
  FOR SELECT TO authenticated USING (auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_aux_referral_codes_select_admin ON public.aux_referral_codes;
CREATE POLICY p_aux_referral_codes_select_admin ON public.aux_referral_codes
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND public.auxiliar_profile_org(auxiliar_profile_id) = public.current_user_org());

-- El referido ve SU fila (sabe si ya reclamó). El que invita NO lee la tabla:
-- ve a sus invitados solo por aux_points_my_referrals (nombre + inicial).
DROP POLICY IF EXISTS p_aux_referrals_select_own ON public.aux_referrals;
CREATE POLICY p_aux_referrals_select_own ON public.aux_referrals
  FOR SELECT TO authenticated USING (referred_aux_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_aux_referrals_select_admin ON public.aux_referrals;
CREATE POLICY p_aux_referrals_select_admin ON public.aux_referrals
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND public.auxiliar_profile_org(referred_aux_id) = public.current_user_org());

DROP POLICY IF EXISTS p_aux_points_redemptions_select_own ON public.aux_points_redemptions;
CREATE POLICY p_aux_points_redemptions_select_own ON public.aux_points_redemptions
  FOR SELECT TO authenticated USING (auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_aux_points_redemptions_select_admin ON public.aux_points_redemptions;
CREATE POLICY p_aux_points_redemptions_select_admin ON public.aux_points_redemptions
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND public.auxiliar_profile_org(auxiliar_profile_id) = public.current_user_org());

DROP POLICY IF EXISTS p_aux_points_ledger_select_own ON public.aux_points_ledger;
CREATE POLICY p_aux_points_ledger_select_own ON public.aux_points_ledger
  FOR SELECT TO authenticated USING (auxiliar_profile_id = public.current_auxiliar_id());
DROP POLICY IF EXISTS p_aux_points_ledger_select_admin ON public.aux_points_ledger;
CREATE POLICY p_aux_points_ledger_select_admin ON public.aux_points_ledger
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND public.auxiliar_profile_org(auxiliar_profile_id) = public.current_user_org());

-- ---------------------------------------------------------------------------
-- 6. Ayudas internas (nadie de afuera las llama)
-- ---------------------------------------------------------------------------

-- «Nombre I.»: primer nombre + inicial del primer apellido. La app pide nombre
-- y DOS apellidos (register_auxiliar), así que con 3+ palabras el primer
-- apellido es la penúltima; con 2, la última. Se saltan partículas (de, del…).
CREATE OR REPLACE FUNCTION public.aux_points_display_name(p_full_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  w text[];
  n int;
  sur text;
BEGIN
  SELECT coalesce(array_agg(x ORDER BY i), '{}') INTO w
  FROM unnest(regexp_split_to_array(btrim(coalesce(p_full_name, '')), '\s+')) WITH ORDINALITY AS t(x, i)
  WHERE x <> '' AND lower(x) NOT IN ('de','del','la','las','los','y','da','van','von');
  n := coalesce(array_length(w, 1), 0);
  IF n = 0 THEN RETURN NULL; END IF;
  IF n = 1 THEN RETURN initcap(w[1]); END IF;
  sur := CASE WHEN n >= 3 THEN w[n - 1] ELSE w[2] END;
  RETURN initcap(w[1]) || ' ' || upper(left(sur, 1)) || '.';
END;
$$;

-- Letras A-Z en mayúscula, sin tildes ni símbolos.
CREATE OR REPLACE FUNCTION public.aux_points_letters(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT regexp_replace(
           upper(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ', 'aeiouunAEIOUUNaeiouAEIOU')),
           '[^A-Z]', '', 'g');
$$;

-- Tres letras de una palabra: la inicial + las dos consonantes siguientes
-- (OLIVAR → OLV, LLANOGRANDE → LLN); si no alcanzan, las primeras tres.
CREATE OR REPLACE FUNCTION public.aux_points_tag3(p_word text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  w text := public.aux_points_letters(p_word);
  s text;
BEGIN
  IF length(w) < 3 THEN RETURN NULL; END IF;
  s := left(w, 1) || left(regexp_replace(substr(w, 2), '[AEIOU]', '', 'g'), 2);
  IF length(s) < 3 THEN s := left(w, 3); END IF;
  RETURN s;
END;
$$;

-- Crea (una vez) el código del tripulante. Devuelve el que tenga.
CREATE OR REPLACE FUNCTION public.aux_points_ensure_code(p_aux uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code  text;
  v_name  text;
  v_res   text;
  v_first text;
  v_tag   text;
  w       text;
  i       int;
  cand    text;
BEGIN
  SELECT code INTO v_code FROM public.aux_referral_codes WHERE auxiliar_profile_id = p_aux;
  IF v_code IS NOT NULL THEN RETURN v_code; END IF;

  SELECT p.full_name, r.name INTO v_name, v_res
  FROM public.auxiliar_profiles ap
  JOIN public.profiles p ON p.id = ap.profile_id
  LEFT JOIN public.residences r ON r.id = ap.residence_id
  WHERE ap.id = p_aux;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_first := left(public.aux_points_letters(split_part(btrim(coalesce(v_name, '')), ' ', 1)), 10);
  IF length(v_first) < 2 THEN v_first := 'RENDIO'; END IF;

  -- Del conjunto: la primera palabra con sustancia (sin «El», «Conjunto»…).
  IF v_res IS NOT NULL THEN
    FOR w IN SELECT x FROM unnest(regexp_split_to_array(btrim(v_res), '\s+')) AS x LOOP
      IF upper(public.aux_points_letters(w)) NOT IN
         ('EL','LA','LOS','LAS','DE','DEL','Y','CONJUNTO','CONJ','URBANIZACION','URB','EDIFICIO',
          'ED','UNIDAD','RESIDENCIAL','QUINTAS','CONDOMINIO','CR','PARCELACION') THEN
        v_tag := public.aux_points_tag3(w);
        EXIT WHEN v_tag IS NOT NULL;
      END IF;
    END LOOP;
  END IF;
  -- Sin conjunto: el primer apellido.
  IF v_tag IS NULL THEN
    v_tag := public.aux_points_tag3(split_part(coalesce(public.aux_points_display_name(v_name), ''), ' ', 2));
    IF v_tag IS NULL THEN
      w := (regexp_split_to_array(btrim(coalesce(v_name, '')), '\s+'))[2];
      v_tag := public.aux_points_tag3(w);
    END IF;
  END IF;
  v_tag := coalesce(v_tag, 'AUX');

  FOR i IN 1..999 LOOP
    cand := v_first || '-' || v_tag || CASE WHEN i > 1 THEN i::text ELSE '' END;
    BEGIN
      INSERT INTO public.aux_referral_codes (auxiliar_profile_id, code) VALUES (p_aux, cand);
      RETURN cand;
    EXCEPTION WHEN unique_violation THEN
      -- ¿Lo creó otra llamada del mismo tripulante al mismo tiempo?
      SELECT code INTO v_code FROM public.aux_referral_codes WHERE auxiliar_profile_id = p_aux;
      IF v_code IS NOT NULL THEN RETURN v_code; END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'No pudimos crear tu código. Intenta de nuevo.';
END;
$$;

-- Inserta un movimiento. Devuelve true si entró, false si esa dedupe_key ya
-- existía (idempotencia: el doble evento no acredita dos veces).
CREATE OR REPLACE FUNCTION public.aux_points_add(
  p_aux uuid, p_points integer, p_kind text, p_key text,
  p_reservation uuid DEFAULT NULL, p_note text DEFAULT NULL, p_by uuid DEFAULT NULL,
  p_referred uuid DEFAULT NULL, p_redemption uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n int;
BEGIN
  IF p_aux IS NULL OR coalesce(p_points, 0) = 0 THEN RETURN false; END IF;
  INSERT INTO public.aux_points_ledger
    (auxiliar_profile_id, points, kind, dedupe_key, reservation_id, note, created_by, referred_aux_id, redemption_id)
  VALUES (p_aux, p_points, p_kind, p_key, p_reservation, p_note, p_by, p_referred, p_redemption)
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.aux_points_balance(p_aux uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(points), 0)::int FROM public.aux_points_ledger WHERE auxiliar_profile_id = p_aux;
$$;

CREATE OR REPLACE FUNCTION public.aux_points_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT aux_points_enabled FROM public.app_settings WHERE id = 'singleton'), false);
$$;

REVOKE ALL ON FUNCTION public.aux_points_display_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_letters(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_tag3(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_ensure_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_add(uuid, integer, text, text, uuid, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aux_points_on() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Acreditación automática (triggers)
-- ---------------------------------------------------------------------------

-- 7a. La hora publicada antes de que la cancelación la borre.
--     auxiliar_cancel_reservation (0050) BORRA la parada antes de marcar la
--     reserva, y 0085 pone calculated_pickup_at en NULL al borrarla. Para saber
--     si se avisó «a tiempo» hay que mirar la hora que HABÍA: este BEFORE DELETE
--     la deja en una variable de la transacción (se borra sola al terminar).
CREATE OR REPLACE FUNCTION public.tg_aux_points_stash_pickup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v timestamptz;
BEGIN
  BEGIN
    IF OLD.reservation_id IS NOT NULL THEN
      SELECT calculated_pickup_at INTO v FROM public.reservations WHERE id = OLD.reservation_id;
      IF v IS NOT NULL THEN
        PERFORM set_config('rendio_pts.pk_' || replace(OLD.reservation_id::text, '-', ''), v::text, true);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'rendio points (stash): %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_aux_points_stash_pickup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_aux_points_stash_pickup ON public.route_stops;
CREATE TRIGGER tr_aux_points_stash_pickup
  BEFORE DELETE ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.tg_aux_points_stash_pickup();

-- 7b. Entregado (referido), cancelado a tiempo y calificado.
CREATE OR REPLACE FUNCTION public.tg_aux_points_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s        public.app_settings%ROWTYPE;
  v_new    text := coalesce(NEW.status_h2a::text, NEW.status_a2h::text);
  v_old    text := coalesce(OLD.status_h2a::text, OLD.status_a2h::text);
  v_ref    public.aux_referrals%ROWTYPE;
  v_nb     boolean;
  v_pts    int;
  v_name   text;
  v_owner  uuid;
  v_pk     timestamptz;
  v_raw    text;
BEGIN
  BEGIN
    SELECT * INTO s FROM public.app_settings WHERE id = 'singleton';
    IF NOT coalesce(s.aux_points_enabled, false) THEN RETURN NULL; END IF;

    -- (1) Primer viaje ENTREGADO de alguien que llegó con un código.
    IF v_new = 'delivered' AND v_old IS DISTINCT FROM 'delivered' THEN
      SELECT * INTO v_ref FROM public.aux_referrals
       WHERE referred_aux_id = NEW.auxiliar_profile_id AND credited_at IS NULL
       FOR UPDATE;
      IF FOUND THEN
        SELECT (a.residence_id IS NOT NULL AND a.residence_id = b.residence_id), p.full_name
          INTO v_nb, v_name
        FROM public.auxiliar_profiles a
        JOIN public.auxiliar_profiles b ON b.id = v_ref.referrer_aux_id
        JOIN public.profiles p ON p.id = a.profile_id
        WHERE a.id = v_ref.referred_aux_id;
        v_nb  := coalesce(v_nb, false);
        v_pts := CASE WHEN v_nb THEN s.aux_points_neighbor ELSE s.aux_points_invite END;
        IF v_pts > 0 THEN
          PERFORM public.aux_points_add(v_ref.referrer_aux_id, v_pts,
            CASE WHEN v_nb THEN 'referral_neighbor' ELSE 'referral' END,
            'ref:' || v_ref.referred_aux_id::text, NULL,
            coalesce(public.aux_points_display_name(v_name), 'Tu colega')
              || CASE WHEN v_nb THEN ' · vive en tu conjunto, cuenta doble' ELSE '' END,
            NULL, v_ref.referred_aux_id, NULL);
        END IF;
        UPDATE public.aux_referrals
           SET credited_at = now(), credited_points = v_pts, neighbor = v_nb, first_reservation_id = NEW.id
         WHERE referred_aux_id = v_ref.referred_aux_id;
      END IF;
    END IF;

    -- (2) Cancelaste TÚ, con hora publicada, con la anticipación pedida.
    IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL AND s.aux_points_cancel > 0 THEN
      SELECT ap.profile_id INTO v_owner FROM public.auxiliar_profiles ap WHERE ap.id = NEW.auxiliar_profile_id;
      IF v_owner IS NOT NULL AND NEW.cancelled_by = v_owner THEN
        v_raw := nullif(current_setting('rendio_pts.pk_' || replace(NEW.id::text, '-', ''), true), '');
        v_pk  := coalesce(v_raw::timestamptz, OLD.calculated_pickup_at, NEW.calculated_pickup_at);
        IF v_pk IS NOT NULL
           AND v_pk - NEW.cancelled_at >= make_interval(hours => s.aux_points_cancel_lead_hours) THEN
          PERFORM public.aux_points_add(NEW.auxiliar_profile_id, s.aux_points_cancel, 'cancel_early',
            'cancel:' || NEW.id::text, NEW.id,
            'Con ' || floor(extract(epoch FROM (v_pk - NEW.cancelled_at)) / 3600)::int || ' h de anticipación',
            v_owner, NULL, NULL);
        END IF;
      END IF;
    END IF;

    -- (3) Primera calificación de un viaje ENTREGADO.
    IF OLD.rating IS NULL AND NEW.rating IS NOT NULL AND v_new = 'delivered' AND s.aux_points_rate > 0 THEN
      PERFORM public.aux_points_add(NEW.auxiliar_profile_id, s.aux_points_rate, 'rate',
        'rate:' || NEW.id::text, NEW.id, NULL, NULL, NULL, NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Los puntos nunca tumban una entrega, una cancelación ni una calificación.
    RAISE WARNING 'rendio points (reserva %): %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_aux_points_reservation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_aux_points_reservation ON public.reservations;
CREATE TRIGGER tr_aux_points_reservation
  AFTER UPDATE OF status_h2a, status_a2h, cancelled_at, rating ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_aux_points_reservation();

-- ---------------------------------------------------------------------------
-- 8. RPC del tripulante
-- ---------------------------------------------------------------------------

-- Saldo, canjes por cumplir y los valores vigentes. Con el programa apagado
-- devuelve enabled=false y el saldo que tenga (no se borra nada).
CREATE OR REPLACE FUNCTION public.aux_points_my_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
  s public.app_settings%ROWTYPE;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.app_settings WHERE id = 'singleton';
  RETURN jsonb_build_object(
    'enabled', coalesce(s.aux_points_enabled, false),
    'balance', public.aux_points_balance(v_aux),
    'pending_count', (SELECT count(*) FROM public.aux_points_redemptions WHERE auxiliar_profile_id = v_aux AND status = 'pending'),
    'pending_points', (SELECT coalesce(sum(cost), 0) FROM public.aux_points_redemptions WHERE auxiliar_profile_id = v_aux AND status = 'pending'),
    'earned_total', (SELECT coalesce(sum(points), 0) FROM public.aux_points_ledger WHERE auxiliar_profile_id = v_aux AND points > 0 AND kind <> 'redeem_refund'),
    'invited_count', (SELECT count(*) FROM public.aux_referrals WHERE referrer_aux_id = v_aux),
    'invited_done', (SELECT count(*) FROM public.aux_referrals WHERE referrer_aux_id = v_aux AND credited_at IS NOT NULL),
    'values', jsonb_build_object(
      'invite', s.aux_points_invite, 'neighbor', s.aux_points_neighbor,
      'cancel', s.aux_points_cancel, 'cancel_lead_hours', s.aux_points_cancel_lead_hours,
      'rate', s.aux_points_rate));
END;
$$;

-- Mi código (se crea la primera vez, solo con el programa encendido).
CREATE OR REPLACE FUNCTION public.aux_points_my_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
  v text;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;
  SELECT code INTO v FROM public.aux_referral_codes WHERE auxiliar_profile_id = v_aux;
  IF v IS NOT NULL OR NOT public.aux_points_on() THEN RETURN v; END IF;
  RETURN public.aux_points_ensure_code(v_aux);
END;
$$;

-- «Invitaste a»: SOLO quien se registró con tu código, como «Nombre I.».
CREATE OR REPLACE FUNCTION public.aux_points_my_referrals()
RETURNS TABLE (display_name text, initials text, status text, points integer, neighbor boolean,
               claimed_at timestamptz, credited_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
BEGIN
  IF v_aux IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT coalesce(public.aux_points_display_name(p.full_name), 'Tu colega'),
           upper(left(coalesce(public.aux_points_display_name(p.full_name), 'T'), 1)
                 || coalesce(left(split_part(public.aux_points_display_name(p.full_name), ' ', 2), 1), '')),
           CASE WHEN r.credited_at IS NOT NULL THEN 'ok' ELSE 'wait' END,
           r.credited_points, r.neighbor, r.claimed_at, r.credited_at
    FROM public.aux_referrals r
    JOIN public.auxiliar_profiles ap ON ap.id = r.referred_aux_id
    JOIN public.profiles p ON p.id = ap.profile_id
    WHERE r.referrer_aux_id = v_aux
    ORDER BY (r.credited_at IS NULL), coalesce(r.credited_at, r.claimed_at) DESC;
END;
$$;

-- «¿Te invitó alguien?»: se guarda DESPUÉS de registrarse (register_auxiliar no
-- cambia). Reglas: programa encendido, una sola vez por cuenta, no tu propio
-- código, la misma organización, y todavía sin viajes entregados (el bono es por
-- tu PRIMER viaje). Tampoco se vale el «yo te invito, tú me invitas».
CREATE OR REPLACE FUNCTION public.aux_points_claim_referral(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_code text := upper(regexp_replace(translate(btrim(coalesce(p_code, '')), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'), '\s+', '', 'g'));
  v_ref  uuid;
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo un tripulante puede usar un código de invitación' USING ERRCODE = '42501';
  END IF;
  IF NOT public.aux_points_on() THEN
    RAISE EXCEPTION 'Rendio Points todavía no está activo';
  END IF;
  IF v_code = '' THEN
    RAISE EXCEPTION 'Escribe el código de quien te invitó';
  END IF;
  IF EXISTS (SELECT 1 FROM public.aux_referrals WHERE referred_aux_id = v_aux) THEN
    RAISE EXCEPTION 'Ya registraste el código de quien te invitó';
  END IF;

  SELECT c.auxiliar_profile_id INTO v_ref
  FROM public.aux_referral_codes c
  WHERE c.code = v_code
    AND public.auxiliar_profile_org(c.auxiliar_profile_id) = public.auxiliar_profile_org(v_aux);
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Ese código no existe. Revísalo con quien te invitó';
  END IF;
  IF v_ref = v_aux THEN
    RAISE EXCEPTION 'Ese es tu propio código';
  END IF;
  IF EXISTS (SELECT 1 FROM public.aux_referrals WHERE referred_aux_id = v_ref AND referrer_aux_id = v_aux) THEN
    RAISE EXCEPTION 'Tú invitaste a esa persona: su código no cuenta para ti';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations
             WHERE auxiliar_profile_id = v_aux
               AND 'delivered' IN (status_h2a::text, status_a2h::text)) THEN
    RAISE EXCEPTION 'El código de invitación es para quien todavía no ha hecho su primer viaje';
  END IF;

  INSERT INTO public.aux_referrals (referred_aux_id, referrer_aux_id, code)
  VALUES (v_aux, v_ref, v_code);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Meta del conjunto: número anónimo (tripulantes activos en tu conjunto) contra
-- la meta y el texto que escribe el jefe. Sin meta, sin texto, apagado o sin
-- conjunto → NULL (no hay tarjeta).
CREATE OR REPLACE FUNCTION public.aux_points_my_goal()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
  s public.app_settings%ROWTYPE;
  v_res uuid;
  v_name text;
  v_n int;
BEGIN
  IF v_aux IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.app_settings WHERE id = 'singleton';
  IF NOT coalesce(s.aux_points_enabled, false) OR s.aux_points_goal_target IS NULL
     OR nullif(btrim(coalesce(s.aux_points_goal_text, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT ap.residence_id, r.name INTO v_res, v_name
  FROM public.auxiliar_profiles ap JOIN public.residences r ON r.id = ap.residence_id
  WHERE ap.id = v_aux;
  IF v_res IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_n
  FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
  WHERE ap.residence_id = v_res AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  RETURN jsonb_build_object('residence_name', v_name, 'count', v_n,
                            'target', s.aux_points_goal_target, 'text', btrim(s.aux_points_goal_text));
END;
$$;

-- Canjear: descuenta ya y deja el canje pendiente para que el jefe lo cumpla.
CREATE OR REPLACE FUNCTION public.aux_points_redeem(p_reward_id text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_rw   public.aux_points_rewards%ROWTYPE;
  v_bal  int;
  v_id   uuid;
  v_org  uuid;
  v_name text;
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo un tripulante puede canjear puntos' USING ERRCODE = '42501';
  END IF;
  IF NOT public.aux_points_on() THEN
    RAISE EXCEPTION 'Rendio Points todavía no está activo';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
             WHERE ap.id = v_aux AND (p.is_active IS FALSE OR p.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Tu cuenta está suspendida: no puedes canjear puntos. Habla con tu jefe.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_rw FROM public.aux_points_rewards WHERE id = p_reward_id;
  IF NOT FOUND OR NOT v_rw.enabled THEN
    RAISE EXCEPTION 'Ese canje no está disponible';
  END IF;
  IF v_rw.soon THEN
    RAISE EXCEPTION '«%» llega pronto: todavía no se puede canjear', v_rw.title;
  END IF;

  -- Un canje a la vez por tripulante: sin esto, dos toques seguidos gastarían
  -- el mismo saldo dos veces.
  PERFORM pg_advisory_xact_lock(hashtextextended('aux_points:' || v_aux::text, 0));
  v_bal := public.aux_points_balance(v_aux);
  IF v_bal < v_rw.cost THEN
    RAISE EXCEPTION 'Te faltan % pts para este canje', v_rw.cost - v_bal;
  END IF;

  INSERT INTO public.aux_points_redemptions (auxiliar_profile_id, reward_id, reward_title, cost, note)
  VALUES (v_aux, v_rw.id, v_rw.title, v_rw.cost, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING id INTO v_id;
  PERFORM public.aux_points_add(v_aux, -v_rw.cost, 'redeem', 'redeem:' || v_id::text,
                                NULL, v_rw.title, auth.uid(), NULL, v_id);

  -- Aviso al jefe (lo despacha dispatch-notifications, como las novedades).
  SELECT p.organization_id, p.full_name INTO v_org, v_name
  FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id WHERE ap.id = v_aux;
  INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
  SELECT a.id, 'Canje de Rendio Points',
         left(coalesce(public.aux_points_display_name(v_name), 'Un tripulante') || ' canjeó «' || v_rw.title
              || '» (' || v_rw.cost || ' pts). Queda pendiente para que lo cumplas.', 280),
         '/#/puntos', 'pts-redeem:' || v_id::text || ':' || a.id::text
  FROM public.profiles a
  WHERE a.role = 'admin' AND a.organization_id = v_org AND a.deleted_at IS NULL
    AND a.is_active IS DISTINCT FROM false
    AND (a.receives_ops_alerts OR NOT EXISTS (
          SELECT 1 FROM public.profiles b
          WHERE b.role = 'admin' AND b.organization_id = v_org AND b.deleted_at IS NULL
            AND b.is_active IS DISTINCT FROM false AND b.receives_ops_alerts))
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'redemption_id', v_id, 'balance', v_bal - v_rw.cost);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. RPC del jefe
-- ---------------------------------------------------------------------------

-- Canjes (por defecto los pendientes) de su organización, con nombre y saldo.
CREATE OR REPLACE FUNCTION public.aux_points_admin_redemptions(p_status text DEFAULT 'pending')
RETURNS TABLE (id uuid, auxiliar_profile_id uuid, full_name text, residence_name text,
               reward_id text, reward_title text, reward_kind text, reward_amount integer,
               cost integer, status text, note text, requested_at timestamptz,
               decided_at timestamptz, decision_note text, balance integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo el jefe ve los canjes' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT x.id, x.auxiliar_profile_id, p.full_name, r.name, x.reward_id, x.reward_title, rw.kind, rw.amount,
           x.cost, x.status, x.note, x.requested_at, x.decided_at, x.decision_note,
           public.aux_points_balance(x.auxiliar_profile_id)
    FROM public.aux_points_redemptions x
    JOIN public.auxiliar_profiles ap ON ap.id = x.auxiliar_profile_id
    JOIN public.profiles p ON p.id = ap.profile_id
    LEFT JOIN public.residences r ON r.id = ap.residence_id
    LEFT JOIN public.aux_points_rewards rw ON rw.id = x.reward_id
    WHERE p.organization_id = public.current_user_org()
      AND (p_status IS NULL OR p_status = 'all' OR x.status = p_status)
    ORDER BY (x.status <> 'pending'), x.requested_at;
END;
$$;

-- Cumplir o rechazar (con motivo). Rechazar devuelve los puntos.
CREATE OR REPLACE FUNCTION public.aux_points_admin_decide(p_redemption_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_x    public.aux_points_redemptions%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo el jefe decide los canjes' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('fulfill', 'reject') THEN
    RAISE EXCEPTION 'Acción no válida: usa fulfill o reject';
  END IF;
  SELECT * INTO v_x FROM public.aux_points_redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND OR public.auxiliar_profile_org(v_x.auxiliar_profile_id) IS DISTINCT FROM public.current_user_org() THEN
    RAISE EXCEPTION 'Ese canje no existe';
  END IF;
  IF v_x.status <> 'pending' THEN
    RAISE EXCEPTION 'Ese canje ya estaba decidido';
  END IF;
  IF p_action = 'reject' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Escribe el motivo del rechazo: el tripulante lo ve';
  END IF;

  UPDATE public.aux_points_redemptions
     SET status = CASE WHEN p_action = 'fulfill' THEN 'fulfilled' ELSE 'rejected' END,
         decided_at = now(), decided_by = auth.uid(), decision_note = v_note
   WHERE id = p_redemption_id;

  IF p_action = 'reject' THEN
    PERFORM public.aux_points_add(v_x.auxiliar_profile_id, v_x.cost, 'redeem_refund',
      'refund:' || v_x.id::text, NULL, v_x.reward_title || ' · ' || v_note, auth.uid(), NULL, v_x.id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN p_action = 'fulfill' THEN 'fulfilled' ELSE 'rejected' END,
                            'balance', public.aux_points_balance(v_x.auxiliar_profile_id));
END;
$$;

-- Ajuste manual del jefe (con nota). No deja el saldo en negativo.
CREATE OR REPLACE FUNCTION public.aux_points_admin_adjust(p_aux uuid, p_points integer, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_bal  int;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo el jefe ajusta puntos' USING ERRCODE = '42501';
  END IF;
  IF public.auxiliar_profile_org(p_aux) IS DISTINCT FROM public.current_user_org() THEN
    RAISE EXCEPTION 'Ese tripulante no existe';
  END IF;
  IF coalesce(p_points, 0) = 0 OR abs(p_points) > 5000 THEN
    RAISE EXCEPTION 'El ajuste va de -5000 a 5000 y no puede ser 0';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'Escribe por qué ajustas: el tripulante lo ve en sus movimientos';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aux_points:' || p_aux::text, 0));
  v_bal := public.aux_points_balance(p_aux);
  IF v_bal + p_points < 0 THEN
    RAISE EXCEPTION 'El saldo quedaría en negativo (tiene % pts)', v_bal;
  END IF;
  PERFORM public.aux_points_add(p_aux, p_points, 'adjust', 'adj:' || gen_random_uuid()::text,
                                NULL, v_note, auth.uid(), NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'balance', v_bal + p_points);
END;
$$;

-- Saldos de la organización (para el panel del jefe).
CREATE OR REPLACE FUNCTION public.aux_points_admin_balances()
RETURNS TABLE (auxiliar_profile_id uuid, full_name text, residence_name text, balance integer,
               earned integer, invited integer, invited_done integer, pending integer, code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo el jefe ve los saldos' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT ap.id, p.full_name, r.name,
           coalesce((SELECT sum(l.points) FROM public.aux_points_ledger l WHERE l.auxiliar_profile_id = ap.id), 0)::int,
           coalesce((SELECT sum(l.points) FROM public.aux_points_ledger l WHERE l.auxiliar_profile_id = ap.id
                     AND l.points > 0 AND l.kind <> 'redeem_refund'), 0)::int,
           (SELECT count(*) FROM public.aux_referrals f WHERE f.referrer_aux_id = ap.id)::int,
           (SELECT count(*) FROM public.aux_referrals f WHERE f.referrer_aux_id = ap.id AND f.credited_at IS NOT NULL)::int,
           (SELECT count(*) FROM public.aux_points_redemptions x WHERE x.auxiliar_profile_id = ap.id AND x.status = 'pending')::int,
           (SELECT c.code FROM public.aux_referral_codes c WHERE c.auxiliar_profile_id = ap.id)
    FROM public.auxiliar_profiles ap
    JOIN public.profiles p ON p.id = ap.profile_id
    LEFT JOIN public.residences r ON r.id = ap.residence_id
    WHERE p.organization_id = public.current_user_org() AND p.deleted_at IS NULL
    ORDER BY 4 DESC, p.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.aux_points_my_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_my_code() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_my_referrals() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_claim_referral(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_my_goal() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_redeem(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_admin_redemptions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_admin_decide(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_admin_adjust(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aux_points_admin_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aux_points_my_summary(), public.aux_points_my_code(),
  public.aux_points_my_referrals(), public.aux_points_claim_referral(text), public.aux_points_my_goal(),
  public.aux_points_redeem(text, text), public.aux_points_admin_redemptions(text),
  public.aux_points_admin_decide(uuid, text, text), public.aux_points_admin_adjust(uuid, integer, text),
  public.aux_points_admin_balances() TO authenticated;

COMMIT;
