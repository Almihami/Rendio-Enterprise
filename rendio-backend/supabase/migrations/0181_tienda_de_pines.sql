-- =============================================================================
-- 0181 · Tienda de pines: el tripulante reserva y el jefe entrega
-- =============================================================================
-- 27-nov-2026. Harold: «la forma de vender va a ser como "reservar"» … «ya queda
-- reservado, no es necesario escribirle a Julián, más bien en el módulo
-- administrativo llega una notificación que reservaron pines, con eso Julián
-- sabe a quién, y en el módulo administrativo esté el inventario, para que el
-- sistema tenga en cuenta cuándo está agotado y cuándo no. Con eso Julián se lo
-- entrega y ya, y Julián mismo en el módulo cambia el estado» … «que tenga
-- opción de que sea próximamente o agotado, para poder generar expectativa en
-- los tripulantes, pero todo es parametrizable o editable desde el módulo
-- administrativo».
--
-- Los pines son los que el tripulante le pone a la maleta. Valen $18.000 y dos
-- salen en $30.000 (los dos valores se cambian desde el admin). La promo es solo
-- por llevar exactamente dos: «si compra 3 ya no aplica el descuento».
--
-- EN LA APP NO SE PAGA. Reservar aparta las unidades del inventario y le avisa a
-- los jefes; el pago y la entrega son en persona. Por eso esto NO toca el
-- facturario (0090) ni Rendio Points (0091).
--
-- Esto agrega:
--   1. pin_store_settings — una fila por organización: encendida/apagada, los
--      textos de la tarjeta de Inicio, quién entrega, el precio, la promo «N por $X», desde
--      cuántas unidades se dice «Quedan N» y el máximo por reserva.
--      NACE APAGADA: hasta que el jefe la enciende, el tripulante no ve nada.
--   2. pin_products — cada pin: nombre, imagen, inventario y estado:
--        available → se puede reservar (sin unidades sale «Agotado» solo);
--        soon      → «Próximamente»: se ve y no se puede reservar;
--        sold_out  → «Agotado» a mano, aunque queden unidades;
--        hidden    → no sale en la tienda.
--      Los seis pines entran como «Próximamente» y con inventario 0: el jefe
--      pone cuántos hay y los pasa a disponibles.
--   3. pin_reservations + pin_reservation_items — la reserva (Reservado →
--      Entregado, o Cancelado) con el precio que se le mostró al tripulante.
--   4. Funciones del tripulante: aux_pins_store, aux_pins_reserve,
--      aux_pins_my_reservations.
--   5. Funciones del jefe: admin_pins_overview, admin_pins_counts,
--      admin_pins_mark_seen, admin_pins_save_settings, admin_pins_save_product,
--      admin_pins_set_reservation.
--   6. El bucket público `pins`, para que el jefe suba la imagen de un pin nuevo.
--
-- Todo lo que escribe pasa por funciones SECURITY DEFINER que revisan quién
-- llama; las tablas quedan de solo lectura para la sesión.
--
-- Down: down_migrations/0181_tienda_de_pines.down.sql
-- =============================================================================

BEGIN;

-- ── 1. Ajustes de la tienda ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pin_store_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled         boolean  NOT NULL DEFAULT false,
  title           text     NOT NULL DEFAULT 'Pines Rendio',
  card_text       text     NOT NULL DEFAULT 'Para tu maleta. Edición limitada.',
  store_note      text,
  contact_name    text     NOT NULL DEFAULT 'Julián',
  unit_price_cop  integer  NOT NULL DEFAULT 18000,
  promo_enabled   boolean  NOT NULL DEFAULT true,
  promo_qty       smallint NOT NULL DEFAULT 2,
  promo_price_cop integer  NOT NULL DEFAULT 30000,
  low_stock_at    smallint NOT NULL DEFAULT 3,
  max_units       smallint NOT NULL DEFAULT 6,
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pin_store_settings_text_ok CHECK (
    length(btrim(title)) BETWEEN 1 AND 40
    AND length(card_text) <= 90
    AND (store_note IS NULL OR length(store_note) <= 160)
    AND length(btrim(contact_name)) BETWEEN 1 AND 30),
  CONSTRAINT pin_store_settings_values_ok CHECK (
    unit_price_cop BETWEEN 100 AND 1000000
    AND promo_qty BETWEEN 2 AND 12
    AND promo_price_cop BETWEEN 100 AND 12000000
    AND low_stock_at BETWEEN 0 AND 50
    AND max_units BETWEEN 1 AND 50)
);
COMMENT ON TABLE public.pin_store_settings IS
  '0181: ajustes de la tienda de pines, una fila por organización. Nace apagada.';

INSERT INTO public.pin_store_settings (organization_id)
SELECT o.id FROM public.organizations o
ON CONFLICT (organization_id) DO NOTHING;

DROP TRIGGER IF EXISTS tr_pin_store_settings_set_updated_at ON public.pin_store_settings;
CREATE TRIGGER tr_pin_store_settings_set_updated_at BEFORE UPDATE ON public.pin_store_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 2. Los pines ─────────────────────────────────────────────────────────────
-- image_path: «assets/pines/…» es un archivo que viene con la app; cualquier
-- otro valor es el nombre de un objeto del bucket `pins` ({organización}/archivo).
CREATE TABLE IF NOT EXISTS public.pin_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug            text,
  name            text     NOT NULL,
  description     text,
  image_path      text     NOT NULL,
  status          text     NOT NULL DEFAULT 'soon',
  stock           integer  NOT NULL DEFAULT 0,
  sort            smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pin_products_slug_unique UNIQUE (organization_id, slug),
  CONSTRAINT pin_products_name_ok   CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT pin_products_desc_ok   CHECK (description IS NULL OR length(description) <= 120),
  CONSTRAINT pin_products_status_ok CHECK (status IN ('available', 'soon', 'sold_out', 'hidden')),
  CONSTRAINT pin_products_stock_ok  CHECK (stock BETWEEN 0 AND 100000)
);
COMMENT ON TABLE public.pin_products IS
  '0181: los pines de la tienda. stock = unidades que todavía se pueden reservar (reservar descuenta, cancelar devuelve).';
CREATE INDEX IF NOT EXISTS idx_pin_products_org ON public.pin_products (organization_id, sort);

INSERT INTO public.pin_products (organization_id, slug, name, image_path, status, stock, sort)
SELECT o.id, v.slug, v.name, v.image_path, 'soon', 0, v.sort
FROM public.organizations o
CROSS JOIN (VALUES
  ('pinguino-piloto', 'Pingüino piloto',  'assets/pines/pinguino-saludo.webp', 10),
  ('pinguino-cool',   'Pingüino cool',    'assets/pines/pinguino-gafas.webp',  20),
  ('alas-rendio',     'Alas Rendio',      'assets/pines/alas-r.webp',          30),
  ('cafe-de-vuelo',   'Café de vuelo',    'assets/pines/vaso-cafe.webp',       40),
  ('gorra-capitan',   'Gorra de capitán', 'assets/pines/gorra-piloto.webp',    50),
  ('cola-rendio',     'Cola Rendio',      'assets/pines/cola-avion.webp',      60)
) AS v(slug, name, image_path, sort)
ON CONFLICT (organization_id, slug) DO NOTHING;

DROP TRIGGER IF EXISTS tr_pin_products_set_updated_at ON public.pin_products;
CREATE TRIGGER tr_pin_products_set_updated_at BEFORE UPDATE ON public.pin_products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 3. Las reservas ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pin_reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auxiliar_profile_id uuid NOT NULL REFERENCES public.auxiliar_profiles(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'reserved',
  units               integer NOT NULL,
  subtotal_cop        integer NOT NULL,
  discount_cop        integer NOT NULL DEFAULT 0,
  total_cop           integer NOT NULL,
  promo_label         text,
  reserved_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at        timestamptz,
  delivered_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancel_note         text,
  admin_seen_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pin_reservations_status_ok CHECK (status IN ('reserved', 'delivered', 'cancelled')),
  CONSTRAINT pin_reservations_units_pos CHECK (units > 0),
  CONSTRAINT pin_reservations_money_ok  CHECK (
    subtotal_cop >= 0 AND discount_cop >= 0 AND discount_cop <= subtotal_cop
    AND total_cop = subtotal_cop - discount_cop)
);
COMMENT ON TABLE public.pin_reservations IS
  '0181: reservas de pines. No es un cobro: el total es lo que el tripulante le paga al jefe al recibirlos.';
CREATE INDEX IF NOT EXISTS idx_pin_reservations_org ON public.pin_reservations (organization_id, status, reserved_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_reservations_aux ON public.pin_reservations (auxiliar_profile_id, reserved_at DESC);

DROP TRIGGER IF EXISTS tr_pin_reservations_set_updated_at ON public.pin_reservations;
CREATE TRIGGER tr_pin_reservations_set_updated_at BEFORE UPDATE ON public.pin_reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- El nombre, la imagen y el precio quedan como estaban al reservar.
CREATE TABLE IF NOT EXISTS public.pin_reservation_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.pin_reservations(id) ON DELETE CASCADE,
  product_id     uuid REFERENCES public.pin_products(id) ON DELETE SET NULL,
  product_name   text NOT NULL,
  image_path     text,
  qty            integer NOT NULL,
  unit_price_cop integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pin_reservation_items_qty_pos  CHECK (qty > 0),
  CONSTRAINT pin_reservation_items_price_ok CHECK (unit_price_cop >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pin_reservation_items_res  ON public.pin_reservation_items (reservation_id);
CREATE INDEX IF NOT EXISTS idx_pin_reservation_items_prod ON public.pin_reservation_items (product_id);

-- ── RLS: la sesión solo lee; escribir es por las funciones de abajo ──────────
ALTER TABLE public.pin_store_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_reservations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_reservation_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pin_store_settings, public.pin_products, public.pin_reservations, public.pin_reservation_items FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.pin_store_settings, public.pin_products, public.pin_reservations, public.pin_reservation_items FROM authenticated;
GRANT SELECT ON public.pin_store_settings, public.pin_products, public.pin_reservations, public.pin_reservation_items TO authenticated;

DROP POLICY IF EXISTS p_pin_store_settings_select ON public.pin_store_settings;
CREATE POLICY p_pin_store_settings_select ON public.pin_store_settings
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_pin_products_select ON public.pin_products;
CREATE POLICY p_pin_products_select ON public.pin_products
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org()
         AND (status <> 'hidden' OR public.current_user_role() = 'admin'));

DROP POLICY IF EXISTS p_pin_reservations_select_own ON public.pin_reservations;
CREATE POLICY p_pin_reservations_select_own ON public.pin_reservations
  FOR SELECT TO authenticated
  USING (auxiliar_profile_id = public.current_auxiliar_id());

DROP POLICY IF EXISTS p_pin_reservations_select_admin ON public.pin_reservations;
CREATE POLICY p_pin_reservations_select_admin ON public.pin_reservations
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_pin_reservation_items_select ON public.pin_reservation_items;
CREATE POLICY p_pin_reservation_items_select ON public.pin_reservation_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pin_reservations r
    WHERE r.id = reservation_id
      AND (r.auxiliar_profile_id = public.current_auxiliar_id()
           OR (public.current_user_role() = 'admin' AND r.organization_id = public.current_user_org()))));

-- ── Piezas internas ──────────────────────────────────────────────────────────
-- «$30.000»
CREATE OR REPLACE FUNCTION public.pin_money(p_n integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT '$' || replace(to_char(coalesce(p_n, 0), 'FM999,999,999,990'), ',', '.');
$$;

-- Lo que valen p_units pines. La promo «p_qty por p_price» aplica SOLO al llevar
-- exactamente p_qty pines (Harold, 27-nov-2026: «si compra 3 ya no aplica el
-- descuento»): con «2 por $30.000», 2 pines valen $30.000 y 3 valen 3 × $18.000.
CREATE OR REPLACE FUNCTION public.pin_total(p_units integer, p_unit integer, p_promo boolean, p_qty integer, p_price integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN coalesce(p_promo, false) AND p_qty >= 2 AND p_price < p_qty * p_unit AND p_units = p_qty
      THEN p_price
    ELSE p_units * p_unit
  END;
$$;

CREATE OR REPLACE FUNCTION public.pin_admin_org()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR v_org IS NULL THEN
    RAISE EXCEPTION 'Solo el jefe maneja la tienda de pines' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END;
$$;

CREATE OR REPLACE FUNCTION public.pin_settings_json(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'enabled', s.enabled, 'title', s.title, 'card_text', s.card_text, 'store_note', s.store_note,
    'contact_name', s.contact_name, 'unit_price_cop', s.unit_price_cop,
    'promo_enabled', s.promo_enabled, 'promo_qty', s.promo_qty, 'promo_price_cop', s.promo_price_cop,
    'low_stock_at', s.low_stock_at, 'max_units', s.max_units, 'updated_at', s.updated_at)
  FROM public.pin_store_settings s
  WHERE s.organization_id = p_org;
$$;

CREATE OR REPLACE FUNCTION public.pin_counts_json(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE r.status = 'reserved'),
    'unseen',  count(*) FILTER (WHERE r.status = 'reserved' AND r.admin_seen_at IS NULL))
  FROM public.pin_reservations r
  WHERE r.organization_id = p_org;
$$;

-- El pin como lo ve el jefe: con lo reservado (por entregar) y lo ya entregado.
CREATE OR REPLACE FUNCTION public.pin_product_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'image_path', p.image_path,
    'status', p.status, 'stock', p.stock, 'sort', p.sort,
    'reserved_units', coalesce((
      SELECT sum(i.qty) FROM public.pin_reservation_items i
      JOIN public.pin_reservations r ON r.id = i.reservation_id
      WHERE i.product_id = p.id AND r.status = 'reserved'), 0),
    'delivered_units', coalesce((
      SELECT sum(i.qty) FROM public.pin_reservation_items i
      JOIN public.pin_reservations r ON r.id = i.reservation_id
      WHERE i.product_id = p.id AND r.status = 'delivered'), 0))
  FROM public.pin_products p
  WHERE p.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.pin_reservation_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'units', r.units,
    'subtotal_cop', r.subtotal_cop, 'discount_cop', r.discount_cop, 'total_cop', r.total_cop,
    'promo_label', r.promo_label,
    'reserved_at', r.reserved_at, 'delivered_at', r.delivered_at,
    'cancelled_at', r.cancelled_at, 'cancel_note', r.cancel_note,
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', i.product_id, 'name', i.product_name, 'image_path', i.image_path,
               'qty', i.qty, 'unit_price_cop', i.unit_price_cop)
             ORDER BY i.product_name, i.id)
      FROM public.pin_reservation_items i
      WHERE i.reservation_id = r.id), '[]'::jsonb))
  FROM public.pin_reservations r
  WHERE r.id = p_id;
$$;

-- ── 4. Tripulante ────────────────────────────────────────────────────────────
-- La tienda como la ve el tripulante. Apagada (o sin ser tripulante) devuelve
-- solo enabled=false y cuántas reservas suyas siguen por entregar.
CREATE OR REPLACE FUNCTION public.aux_pins_store()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux  uuid := public.current_auxiliar_id();
  v_org  uuid;
  v_mine int := 0;
  s      public.pin_store_settings%ROWTYPE;
BEGIN
  IF v_aux IS NULL THEN
    RETURN jsonb_build_object('enabled', false, 'my_pending', 0);
  END IF;
  v_org := public.auxiliar_profile_org(v_aux);
  SELECT count(*)::int INTO v_mine FROM public.pin_reservations r
   WHERE r.auxiliar_profile_id = v_aux AND r.status = 'reserved';
  SELECT * INTO s FROM public.pin_store_settings WHERE organization_id = v_org;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('enabled', false, 'my_pending', v_mine);
  END IF;
  RETURN jsonb_build_object(
    'enabled', true,
    'title', s.title, 'card_text', s.card_text, 'store_note', s.store_note,
    'contact_name', s.contact_name, 'unit_price_cop', s.unit_price_cop,
    'promo_on', (s.promo_enabled AND s.promo_price_cop < s.promo_qty * s.unit_price_cop),
    'promo_qty', s.promo_qty, 'promo_price_cop', s.promo_price_cop,
    'low_stock_at', s.low_stock_at, 'max_units', s.max_units,
    'my_pending', v_mine,
    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description, 'image_path', p.image_path,
               'state', CASE WHEN p.status = 'soon' THEN 'soon'
                             WHEN p.status = 'sold_out' OR p.stock <= 0 THEN 'sold_out'
                             ELSE 'available' END,
               'stock', CASE WHEN p.status = 'available' THEN p.stock ELSE 0 END)
             ORDER BY p.sort, p.name, p.id)
      FROM public.pin_products p
      WHERE p.organization_id = v_org AND p.status <> 'hidden'), '[]'::jsonb));
END;
$$;
COMMENT ON FUNCTION public.aux_pins_store() IS
  '0181: la tienda de pines para el tripulante (precio, promo y pines visibles con su estado).';

-- Reservar. p_items = [{"product_id": "<uuid>", "qty": 1}, …]. Aparta las
-- unidades, guarda el precio (con la promo si le toca) y les avisa a los jefes.
CREATE OR REPLACE FUNCTION public.aux_pins_reserve(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux   uuid := public.current_auxiliar_id();
  v_org   uuid;
  v_name  text;
  s       public.pin_store_settings%ROWTYPE;
  v_ids   uuid[];
  v_qtys  int[];
  v_units int := 0;
  v_found int := 0;
  v_promo boolean;
  v_sub   int;
  v_tot   int;
  v_id    uuid;
  r       record;
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'Solo un tripulante puede reservar pines' USING ERRCODE = '42501';
  END IF;
  SELECT p.organization_id, p.full_name INTO v_org, v_name
  FROM public.auxiliar_profiles ap
  JOIN public.profiles p ON p.id = ap.profile_id
  WHERE ap.id = v_aux AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tu cuenta está suspendida: no puedes reservar pines. Habla con tu jefe.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.pin_store_settings WHERE organization_id = v_org;
  IF NOT FOUND OR NOT s.enabled THEN
    RAISE EXCEPTION 'La tienda de pines no está abierta por ahora';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Elige al menos un pin' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'No entendimos la reserva. Cierra la tienda y vuelve a intentarlo.' USING ERRCODE = '22023';
  END IF;
  BEGIN
    SELECT array_agg(t.pid ORDER BY t.pid), array_agg(t.q ORDER BY t.pid), coalesce(sum(t.q), 0)::int
      INTO v_ids, v_qtys, v_units
    FROM (SELECT (e->>'product_id')::uuid AS pid, sum((e->>'qty')::int)::int AS q
          FROM jsonb_array_elements(p_items) e
          GROUP BY 1) t;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'No entendimos la reserva. Cierra la tienda y vuelve a intentarlo.' USING ERRCODE = '22023';
  END;
  IF v_ids IS NULL
     OR EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE x IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(v_qtys) q WHERE q IS NULL OR q < 1) THEN
    RAISE EXCEPTION 'No entendimos la reserva. Cierra la tienda y vuelve a intentarlo.' USING ERRCODE = '22023';
  END IF;
  IF v_units > s.max_units THEN
    RAISE EXCEPTION 'Puedes reservar máximo % pines a la vez', s.max_units;
  END IF;

  -- Una reserva a la vez por tripulante (dos toques seguidos no se pisan) y los
  -- pines bloqueados en orden: dos personas no se llevan la misma última unidad.
  PERFORM pg_advisory_xact_lock(hashtextextended('pins:' || v_aux::text, 0));
  FOR r IN
    SELECT p.id, p.name, p.status, p.stock, x.q
    FROM unnest(v_ids, v_qtys) AS x(pid, q)
    JOIN public.pin_products p ON p.id = x.pid AND p.organization_id = v_org
    ORDER BY p.id
    FOR UPDATE OF p
  LOOP
    v_found := v_found + 1;
    IF r.status = 'hidden' THEN
      RAISE EXCEPTION '«%» ya no está en la tienda', r.name;
    ELSIF r.status = 'soon' THEN
      RAISE EXCEPTION '«%» llega pronto: todavía no se puede reservar', r.name;
    ELSIF r.status = 'sold_out' OR r.stock <= 0 THEN
      RAISE EXCEPTION '«%» se agotó', r.name;
    ELSIF r.stock < r.q THEN
      RAISE EXCEPTION 'De «%» solo queda%', r.name, CASE WHEN r.stock = 1 THEN ' 1' ELSE 'n ' || r.stock END;
    END IF;
  END LOOP;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'Uno de los pines ya no está en la tienda. Vuelve a entrar e inténtalo otra vez.';
  END IF;

  v_promo := s.promo_enabled AND s.promo_price_cop < s.promo_qty * s.unit_price_cop;
  v_sub := v_units * s.unit_price_cop;
  v_tot := public.pin_total(v_units, s.unit_price_cop, v_promo, s.promo_qty, s.promo_price_cop);

  INSERT INTO public.pin_reservations (organization_id, auxiliar_profile_id, units, subtotal_cop, discount_cop, total_cop, promo_label)
  VALUES (v_org, v_aux, v_units, v_sub, v_sub - v_tot, v_tot,
          CASE WHEN v_sub > v_tot THEN s.promo_qty || ' por ' || public.pin_money(s.promo_price_cop) END)
  RETURNING id INTO v_id;

  INSERT INTO public.pin_reservation_items (reservation_id, product_id, product_name, image_path, qty, unit_price_cop)
  SELECT v_id, p.id, p.name, p.image_path, x.q, s.unit_price_cop
  FROM unnest(v_ids, v_qtys) AS x(pid, q)
  JOIN public.pin_products p ON p.id = x.pid;

  UPDATE public.pin_products p
     SET stock = p.stock - x.q
    FROM unnest(v_ids, v_qtys) AS x(pid, q)
   WHERE p.id = x.pid;

  -- El aviso a los jefes (lo despacha dispatch-notifications). Si falla, la
  -- reserva queda igual: el jefe la ve en su lista.
  BEGIN
    INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key)
    SELECT a.profile_id, 'Nueva reserva de pines',
           left(coalesce(nullif(btrim(v_name), ''), 'Un tripulante') || ' reservó ' || v_units
                || CASE WHEN v_units = 1 THEN ' pin' ELSE ' pines' END || ' · ' || public.pin_money(v_tot), 280),
           '/#/pines', 'pin-res:' || v_id::text || ':' || a.profile_id::text
    FROM public.ops_alert_recipients_of(v_org) a
    ON CONFLICT DO NOTHING;
    PERFORM public.trip_kick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pines: no se pudo avisar la reserva %: %', v_id, SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true, 'reservation', public.pin_reservation_json(v_id));
END;
$$;
COMMENT ON FUNCTION public.aux_pins_reserve(jsonb) IS
  '0181: el tripulante reserva pines. Aparta inventario, aplica la promo y avisa a los jefes. No cobra nada.';

CREATE OR REPLACE FUNCTION public.aux_pins_my_reservations()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(public.pin_reservation_json(t.id) ORDER BY t.reserved_at DESC), '[]'::jsonb)
  FROM (SELECT r.id, r.reserved_at
        FROM public.pin_reservations r
        WHERE r.auxiliar_profile_id = public.current_auxiliar_id()
        ORDER BY r.reserved_at DESC
        LIMIT 40) t;
$$;
COMMENT ON FUNCTION public.aux_pins_my_reservations() IS
  '0181: las reservas de pines del tripulante que llama, de la más nueva a la más vieja.';

-- ── 5. Jefe ──────────────────────────────────────────────────────────────────
-- Todo lo de la pantalla Pines en una sola llamada.
CREATE OR REPLACE FUNCTION public.admin_pins_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.pin_admin_org();
BEGIN
  INSERT INTO public.pin_store_settings (organization_id) VALUES (v_org)
  ON CONFLICT (organization_id) DO NOTHING;
  RETURN jsonb_build_object(
    'settings', public.pin_settings_json(v_org),
    'counts', public.pin_counts_json(v_org),
    'products', coalesce((
      SELECT jsonb_agg(public.pin_product_json(p.id) ORDER BY p.sort, p.name, p.id)
      FROM public.pin_products p
      WHERE p.organization_id = v_org), '[]'::jsonb),
    'reservations', coalesce((
      SELECT jsonb_agg(t.j ORDER BY t.pend DESC, t.reserved_at DESC)
      FROM (
        SELECT public.pin_reservation_json(r.id)
                 || jsonb_build_object('crew_name', pr.full_name, 'crew_phone', pr.phone,
                                       'residence', res.name, 'is_new', r.admin_seen_at IS NULL) AS j,
               (r.status = 'reserved') AS pend, r.reserved_at
        FROM public.pin_reservations r
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
        JOIN public.profiles pr ON pr.id = ap.profile_id
        LEFT JOIN public.residences res ON res.id = ap.residence_id
        WHERE r.organization_id = v_org
        ORDER BY (r.status = 'reserved') DESC, r.reserved_at DESC
        LIMIT 400) t), '[]'::jsonb));
END;
$$;
COMMENT ON FUNCTION public.admin_pins_overview() IS
  '0181: ajustes, inventario y reservas de pines para la pantalla del jefe.';

-- Para el globo del menú: por entregar y sin ver. Quien no es jefe recibe null.
CREATE OR REPLACE FUNCTION public.admin_pins_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' OR public.current_user_org() IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public.pin_counts_json(public.current_user_org());
END;
$$;
COMMENT ON FUNCTION public.admin_pins_counts() IS
  '0181: cuántas reservas de pines hay por entregar y cuántas no ha visto ningún jefe.';

CREATE OR REPLACE FUNCTION public.admin_pins_mark_seen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.pin_admin_org();
BEGIN
  UPDATE public.pin_reservations
     SET admin_seen_at = now()
   WHERE organization_id = v_org AND admin_seen_at IS NULL;
  RETURN public.pin_counts_json(v_org);
END;
$$;
COMMENT ON FUNCTION public.admin_pins_mark_seen() IS
  '0181: el jefe ya vio las reservas nuevas (apaga el globo del menú).';

-- p trae solo lo que cambia: enabled, title, card_text, store_note, contact_name,
-- unit_price_cop, promo_enabled, promo_qty, promo_price_cop, low_stock_at, max_units.
CREATE OR REPLACE FUNCTION public.admin_pins_save_settings(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.pin_admin_org();
  s     public.pin_store_settings%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'No llegó nada para guardar' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pin_store_settings (organization_id) VALUES (v_org)
  ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO s FROM public.pin_store_settings WHERE organization_id = v_org FOR UPDATE;

  BEGIN
    IF p ? 'enabled'         THEN s.enabled         := (p->>'enabled')::boolean; END IF;
    IF p ? 'title'           THEN s.title           := btrim(coalesce(p->>'title', '')); END IF;
    IF p ? 'card_text'       THEN s.card_text       := btrim(coalesce(p->>'card_text', '')); END IF;
    IF p ? 'store_note'      THEN s.store_note      := nullif(btrim(coalesce(p->>'store_note', '')), ''); END IF;
    IF p ? 'contact_name'    THEN s.contact_name    := btrim(coalesce(p->>'contact_name', '')); END IF;
    IF p ? 'unit_price_cop'  THEN s.unit_price_cop  := (p->>'unit_price_cop')::int; END IF;
    IF p ? 'promo_enabled'   THEN s.promo_enabled   := (p->>'promo_enabled')::boolean; END IF;
    IF p ? 'promo_qty'       THEN s.promo_qty       := (p->>'promo_qty')::int; END IF;
    IF p ? 'promo_price_cop' THEN s.promo_price_cop := (p->>'promo_price_cop')::int; END IF;
    IF p ? 'low_stock_at'    THEN s.low_stock_at    := (p->>'low_stock_at')::int; END IF;
    IF p ? 'max_units'       THEN s.max_units       := (p->>'max_units')::int; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Hay un valor que no es un número válido. Revísalos y guarda otra vez.' USING ERRCODE = '22023';
  END;

  IF s.enabled IS NULL OR s.promo_enabled IS NULL THEN
    RAISE EXCEPTION 'Falta decir si la tienda o la promo están encendidas';
  END IF;
  IF length(s.title) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'El nombre de la tienda va de 1 a 40 letras';
  END IF;
  IF length(s.card_text) > 90 THEN
    RAISE EXCEPTION 'El texto de la tarjeta va hasta 90 letras';
  END IF;
  IF s.store_note IS NOT NULL AND length(s.store_note) > 160 THEN
    RAISE EXCEPTION 'La nota de la tienda va hasta 160 letras';
  END IF;
  IF length(s.contact_name) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'Escribe quién entrega los pines (hasta 30 letras)';
  END IF;
  IF s.unit_price_cop IS NULL OR s.unit_price_cop NOT BETWEEN 100 AND 1000000 THEN
    RAISE EXCEPTION 'El precio de un pin va de $100 a $1.000.000';
  END IF;
  IF s.promo_qty IS NULL OR s.promo_qty NOT BETWEEN 2 AND 12 THEN
    RAISE EXCEPTION 'La promo es por 2 pines o más (hasta 12)';
  END IF;
  IF s.promo_price_cop IS NULL OR s.promo_price_cop NOT BETWEEN 100 AND 12000000 THEN
    RAISE EXCEPTION 'Escribe cuánto vale la promo';
  END IF;
  IF s.promo_enabled AND s.promo_price_cop >= s.promo_qty * s.unit_price_cop THEN
    RAISE EXCEPTION 'La promo debe salir más barata que llevar % pines sueltos (%)',
      s.promo_qty, public.pin_money(s.promo_qty * s.unit_price_cop);
  END IF;
  IF s.low_stock_at IS NULL OR s.low_stock_at NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION '«Quedan pocas» va de 0 a 50 unidades';
  END IF;
  IF s.max_units IS NULL OR s.max_units NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'El máximo por reserva va de 1 a 50 pines';
  END IF;

  UPDATE public.pin_store_settings
     SET enabled = s.enabled, title = s.title, card_text = s.card_text, store_note = s.store_note,
         contact_name = s.contact_name, unit_price_cop = s.unit_price_cop, promo_enabled = s.promo_enabled, promo_qty = s.promo_qty,
         promo_price_cop = s.promo_price_cop, low_stock_at = s.low_stock_at, max_units = s.max_units,
         updated_by = auth.uid()
   WHERE organization_id = v_org;
  RETURN public.pin_settings_json(v_org);
END;
$$;
COMMENT ON FUNCTION public.admin_pins_save_settings(jsonb) IS
  '0181: el jefe guarda los ajustes de la tienda de pines (solo las llaves que llegan).';

-- p trae solo lo que cambia: name, description, image_path, status, stock (el
-- valor exacto) o stock_delta (sumar/restar), sort. Sin id crea un pin nuevo.
CREATE OR REPLACE FUNCTION public.admin_pins_save_product(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.pin_admin_org();
  v_id  uuid;
  v_new boolean := false;
  r     public.pin_products%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'No llegó nada para guardar' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_id := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Ese pin no existe';
  END;

  IF v_id IS NULL THEN
    v_new := true;
    r.id := gen_random_uuid();
    r.organization_id := v_org;
    r.status := 'soon';
    r.stock := 0;
    r.sort := least(32000, coalesce((SELECT max(x.sort) FROM public.pin_products x WHERE x.organization_id = v_org), 0) + 10);
  ELSE
    SELECT * INTO r FROM public.pin_products WHERE id = v_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ese pin no existe';
    END IF;
  END IF;

  BEGIN
    IF p ? 'name'        THEN r.name        := btrim(coalesce(p->>'name', '')); END IF;
    IF p ? 'description' THEN r.description := nullif(btrim(coalesce(p->>'description', '')), ''); END IF;
    IF p ? 'image_path'  THEN r.image_path  := btrim(coalesce(p->>'image_path', '')); END IF;
    IF p ? 'status'      THEN r.status      := coalesce(p->>'status', ''); END IF;
    IF p ? 'stock'       THEN r.stock       := (p->>'stock')::int; END IF;
    IF p ? 'stock_delta' THEN r.stock       := r.stock + (p->>'stock_delta')::int; END IF;
    IF p ? 'sort'        THEN r.sort        := (p->>'sort')::int; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Hay un valor que no es un número válido. Revísalo y guarda otra vez.' USING ERRCODE = '22023';
  END;

  IF r.name IS NULL OR length(r.name) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'El nombre del pin va de 1 a 40 letras';
  END IF;
  IF r.description IS NOT NULL AND length(r.description) > 120 THEN
    RAISE EXCEPTION 'La descripción va hasta 120 letras';
  END IF;
  IF r.status NOT IN ('available', 'soon', 'sold_out', 'hidden') THEN
    RAISE EXCEPTION 'Ese estado no existe';
  END IF;
  IF r.stock IS NULL OR r.stock < 0 THEN
    RAISE EXCEPTION 'El inventario no puede quedar por debajo de cero';
  END IF;
  IF r.stock > 100000 THEN
    RAISE EXCEPTION 'El inventario va hasta 100.000 unidades';
  END IF;
  IF r.sort IS NULL THEN r.sort := 0; END IF;
  IF r.image_path IS NULL OR r.image_path = '' THEN
    RAISE EXCEPTION 'Falta la imagen del pin';
  END IF;
  IF r.image_path !~ '^assets/pines/[a-z0-9][a-z0-9._-]*\.(webp|png|jpg|jpeg)$' THEN
    IF r.image_path !~ ('^' || v_org::text || '/[a-z0-9][a-z0-9._-]*\.(webp|png|jpg|jpeg)$')
       OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'pins' AND o.name = r.image_path) THEN
      RAISE EXCEPTION 'No encontramos la imagen del pin. Súbela otra vez.';
    END IF;
  END IF;

  IF v_new THEN
    INSERT INTO public.pin_products (id, organization_id, name, description, image_path, status, stock, sort)
    VALUES (r.id, r.organization_id, r.name, r.description, r.image_path, r.status, r.stock, r.sort);
  ELSE
    UPDATE public.pin_products
       SET name = r.name, description = r.description, image_path = r.image_path,
           status = r.status, stock = r.stock, sort = r.sort
     WHERE id = r.id;
  END IF;
  RETURN public.pin_product_json(r.id);
END;
$$;
COMMENT ON FUNCTION public.admin_pins_save_product(jsonb) IS
  '0181: el jefe crea o edita un pin: nombre, imagen, estado (disponible / próximamente / agotado / oculto) e inventario.';

-- deliver: Reservado → Entregado.   reopen: Entregado → Reservado (se marcó por
-- error).   cancel: Reservado → Cancelado, y las unidades vuelven al inventario.
CREATE OR REPLACE FUNCTION public.admin_pins_set_reservation(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  uuid := public.pin_admin_org();
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_to   uuid;
  r      public.pin_reservations%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('deliver', 'reopen', 'cancel') THEN
    RAISE EXCEPTION 'Acción no válida: usa deliver, reopen o cancel';
  END IF;
  SELECT * INTO r FROM public.pin_reservations WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa reserva no existe';
  END IF;

  IF p_action = 'deliver' THEN
    IF r.status = 'delivered' THEN RAISE EXCEPTION 'Esa reserva ya estaba entregada'; END IF;
    IF r.status = 'cancelled' THEN RAISE EXCEPTION 'Esa reserva está cancelada'; END IF;
    UPDATE public.pin_reservations
       SET status = 'delivered', delivered_at = now(), delivered_by = auth.uid(),
           admin_seen_at = coalesce(admin_seen_at, now())
     WHERE id = r.id;

  ELSIF p_action = 'reopen' THEN
    IF r.status <> 'delivered' THEN RAISE EXCEPTION 'Solo se deshace una entrega'; END IF;
    UPDATE public.pin_reservations
       SET status = 'reserved', delivered_at = NULL, delivered_by = NULL
     WHERE id = r.id;

  ELSE
    IF r.status = 'cancelled' THEN RAISE EXCEPTION 'Esa reserva ya estaba cancelada'; END IF;
    IF r.status = 'delivered' THEN RAISE EXCEPTION 'Esa reserva ya se entregó: deshaz la entrega antes de cancelarla'; END IF;
    UPDATE public.pin_reservations
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_note = v_note,
           admin_seen_at = coalesce(admin_seen_at, now())
     WHERE id = r.id;
    UPDATE public.pin_products p
       SET stock = least(100000, p.stock + i.q)
      FROM (SELECT x.product_id, sum(x.qty)::int AS q
            FROM public.pin_reservation_items x
            WHERE x.reservation_id = r.id AND x.product_id IS NOT NULL
            GROUP BY x.product_id) i
     WHERE p.id = i.product_id;
    -- Al tripulante sí se le avisa: su reserva ya no está.
    BEGIN
      SELECT ap.profile_id INTO v_to FROM public.auxiliar_profiles ap WHERE ap.id = r.auxiliar_profile_id;
      PERFORM public.trip_notify(v_to, 'Tu reserva de pines se canceló',
        left(CASE WHEN v_note IS NULL THEN 'Si quieres, puedes reservar otra vez en la tienda.' ELSE v_note END, 280),
        '/', 'pin-cancel:' || r.id::text);
      PERFORM public.trip_kick();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'pines: no se pudo avisar la cancelación %: %', r.id, SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('ok', true,
                            'reservation', public.pin_reservation_json(r.id),
                            'counts', public.pin_counts_json(v_org));
END;
$$;
COMMENT ON FUNCTION public.admin_pins_set_reservation(uuid, text, text) IS
  '0181: el jefe cambia el estado de una reserva de pines (entregar, deshacer la entrega o cancelar y devolver al inventario).';

-- ── Permisos de las funciones ────────────────────────────────────────────────
DO $do$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.aux_pins_store()',
    'public.aux_pins_reserve(jsonb)',
    'public.aux_pins_my_reservations()',
    'public.admin_pins_overview()',
    'public.admin_pins_counts()',
    'public.admin_pins_mark_seen()',
    'public.admin_pins_save_settings(jsonb)',
    'public.admin_pins_save_product(jsonb)',
    'public.admin_pins_set_reservation(uuid, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  -- Las piezas internas no las llama nadie desde afuera.
  FOREACH f IN ARRAY ARRAY[
    'public.pin_money(integer)',
    'public.pin_total(integer, integer, boolean, integer, integer)',
    'public.pin_admin_org()',
    'public.pin_settings_json(uuid)',
    'public.pin_counts_json(uuid)',
    'public.pin_product_json(uuid)',
    'public.pin_reservation_json(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END
$do$;

-- ── 6. Imágenes de pines nuevos: bucket público, solo el jefe escribe ────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pins', 'pins', true, 2 * 1024 * 1024, ARRAY['image/png', 'image/webp', 'image/jpeg']::text[])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS p_pins_insert_admin ON storage.objects;
CREATE POLICY p_pins_insert_admin ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pins' AND public.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = public.current_user_org()::text);

DROP POLICY IF EXISTS p_pins_delete_admin ON storage.objects;
CREATE POLICY p_pins_delete_admin ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pins' AND public.current_user_role() = 'admin'
    AND (storage.foldername(name))[1] = public.current_user_org()::text);

NOTIFY pgrst, 'reload schema';

COMMIT;
