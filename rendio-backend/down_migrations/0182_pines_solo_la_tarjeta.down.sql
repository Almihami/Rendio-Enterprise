-- Deshace 0182 (pines: «solo la tarjeta»).
-- Las cuatro funciones vuelven a ser las de 0181 y se quita la columna. Ojo: la
-- tienda que estuviera encendida en «solo la tarjeta» queda ABIERTA (en 0181 no
-- existe el término medio): si no se quiere eso, apagarla antes.

BEGIN;

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

ALTER TABLE public.pin_store_settings DROP COLUMN IF EXISTS card_only;

NOTIFY pgrst, 'reload schema';

COMMIT;
