// Prueba LOCAL de 0181 (tienda de pines) en un Postgres en memoria (PGlite): no
// toca dev ni prod. Monta un esquema mínimo con lo que la migración usa, corre
// la migración dos veces (es idempotente), recorre lo que hace el tripulante y
// lo que hace el jefe, y al final corre el down.
// Uso: node _verify-0181-pglite.mjs <carpeta con node_modules/@electric-sql/pglite>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mods = process.argv[2];
if (!mods) { console.error('Falta la carpeta que tiene node_modules/@electric-sql/pglite'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(mods, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const here = fileURLToPath(new URL('../', import.meta.url));
const UP = readFileSync(join(here, 'supabase/migrations/0181_tienda_de_pines.sql'), 'utf8');
const DOWN = readFileSync(join(here, 'down_migrations/0181_tienda_de_pines.down.sql'), 'utf8');

// Lo mínimo de la base real que 0181 lee o llama.
const ESQUEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE SCHEMA storage;
  GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.uid', true), '')::uuid $$;
  CREATE FUNCTION public.current_user_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.org', true), '')::uuid $$;
  CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.role', true), '') $$;
  CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id),
    role text NOT NULL, full_name text NOT NULL, phone text, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz,
    receives_ops_alerts boolean NOT NULL DEFAULT false);
  CREATE TABLE public.residences (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.auxiliar_profiles (id uuid PRIMARY KEY, profile_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id), residence_id uuid);
  CREATE FUNCTION public.current_auxiliar_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT id FROM public.auxiliar_profiles WHERE profile_id = auth.uid() $$;
  CREATE FUNCTION public.auxiliar_profile_org(p uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT pr.organization_id FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id WHERE ap.id = p $$;
  CREATE TABLE public.notification_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL, title text NOT NULL,
    body text NOT NULL, url text NOT NULL DEFAULT '/', dedupe_key text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX uq_outbox_dedupe ON public.notification_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL AND sent_at IS NULL;
  CREATE FUNCTION public.ops_alert_recipients_of(p_org uuid) RETURNS TABLE (profile_id uuid) LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT p.id FROM public.profiles p WHERE p.organization_id = p_org AND p.role = 'admin' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false $$;
  CREATE FUNCTION public.trip_kick() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
  CREATE FUNCTION public.trip_notify(p_profile uuid, p_title text, p_body text, p_url text, p_key text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key) VALUES (p_profile, p_title, p_body, coalesce(p_url, '/'), p_key)
      ON CONFLICT DO NOTHING; RETURN FOUND; END $$;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT (string_to_array(name, '/'))[1 : greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
`;

await main();

async function main() {
  const db = new PGlite();
  let ok = 0, mal = 0;
  const check = (c, t, d) => { c ? ok++ : mal++; console.log((c ? '  ✓ ' : '  ✗ ') + t + (!c && d !== undefined ? ' → ' + JSON.stringify(d) : '')); };
  const q = async (s, v) => (await db.query(s, v)).rows;
  const one = async (s, v) => { const r = await q(s, v); return r[0] ? Object.values(r[0])[0] : undefined; };
  // Quién llama: como en la base real, el rol y la organización salen de la sesión.
  const soy = async (uid, role, org) => { await db.query(`SELECT set_config('t.uid', $1, false), set_config('t.role', $2, false), set_config('t.org', $3, false)`, [uid || '', role || '', org || '']); };
  const falla = async (s, v) => { try { await db.query(s, v); return null; } catch (e) { return e; } };

  const ORG = '00000000-0000-0000-0000-0000000000a1', ORG2 = '00000000-0000-0000-0000-0000000000a2';
  const JEFE = '00000000-0000-0000-0000-00000000000a', JEFE2 = '00000000-0000-0000-0000-00000000000b';
  const LAURA = '00000000-0000-0000-0000-0000000000c1', ANDRES = '00000000-0000-0000-0000-0000000000c2', CHOFER = '00000000-0000-0000-0000-0000000000d1';
  const AUX_L = '00000000-0000-0000-0000-0000000000e1', AUX_A = '00000000-0000-0000-0000-0000000000e2';

  await db.exec(ESQUEMA);
  await db.exec(`
    INSERT INTO public.organizations VALUES ('${ORG}', 'Rendio'), ('${ORG2}', 'Otra');
    INSERT INTO public.profiles (id, organization_id, role, full_name, phone) VALUES
      ('${JEFE}', '${ORG}', 'admin', 'Julián Jefe', '3000000001'), ('${JEFE2}', '${ORG2}', 'admin', 'Jefe de Otra', NULL),
      ('${LAURA}', '${ORG}', 'auxiliar', 'Laura Gómez', '3000000002'), ('${ANDRES}', '${ORG}', 'auxiliar', 'Andrés Ruiz', NULL),
      ('${CHOFER}', '${ORG}', 'driver', 'Carlos Conductor', NULL);
    INSERT INTO public.residences VALUES ('00000000-0000-0000-0000-0000000000f1', 'Conjunto El Dorado');
    INSERT INTO public.auxiliar_profiles VALUES ('${AUX_L}', '${LAURA}', '00000000-0000-0000-0000-0000000000f1'), ('${AUX_A}', '${ANDRES}', NULL);
  `);

  console.log('\n== 0181 en PGlite ==');
  await db.exec(UP);
  await db.exec(UP);
  check(true, 'la migración corre dos veces sin error (idempotente)');

  // ── Lo que deja ────────────────────────────────────────────────────────────
  check(await one(`SELECT count(*)::int FROM pin_store_settings`) === 2, 'una fila de ajustes por organización');
  check(await one(`SELECT bool_and(NOT enabled) FROM pin_store_settings`) === true, 'la tienda nace apagada');
  check(await one(`SELECT count(*)::int FROM pin_products WHERE organization_id = $1`, [ORG]) === 6, 'los seis pines quedan cargados (y no se duplican al repetir)');
  check(await one(`SELECT bool_and(status = 'soon' AND stock = 0) FROM pin_products`) === true, 'entran como «Próximamente» y con inventario 0');
  const priv = (await q(`SELECT
      has_function_privilege('anon', 'public.aux_pins_reserve(jsonb)', 'EXECUTE') a1,
      has_function_privilege('authenticated', 'public.aux_pins_reserve(jsonb)', 'EXECUTE') a2,
      has_function_privilege('anon', 'public.admin_pins_overview()', 'EXECUTE') a3,
      has_function_privilege('authenticated', 'public.pin_reservation_json(uuid)', 'EXECUTE') a4,
      has_function_privilege('authenticated', 'public.pin_admin_org()', 'EXECUTE') a5,
      has_table_privilege('authenticated', 'public.pin_products', 'UPDATE') t1,
      has_table_privilege('authenticated', 'public.pin_reservations', 'INSERT') t2,
      has_table_privilege('anon', 'public.pin_products', 'SELECT') t3,
      has_table_privilege('authenticated', 'public.pin_products', 'SELECT') t4`))[0];
  check(!priv.a1 && priv.a2 && !priv.a3, 'anon no puede llamar nada; una sesión sí');
  check(!priv.a4 && !priv.a5, 'las piezas internas no se pueden llamar desde afuera');
  check(!priv.t1 && !priv.t2 && !priv.t3 && priv.t4, 'las tablas son de solo lectura para la sesión y anon no las ve');

  // ── La cuenta de la promo ──────────────────────────────────────────────────
  const tot = async (n, on = true, qty = 2, price = 30000, unit = 18000) => one(`SELECT public.pin_total($1, $2, $3, $4, $5)`, [n, unit, on, qty, price]);
  check(await tot(1) === 18000 && await tot(2) === 30000 && await tot(3) === 54000 && await tot(4) === 72000 && await tot(5) === 90000, '2 por $30.000 solo con 2 exactos: 1→18, 2→30, 3→54, 4→72, 5→90 mil');
  check(await tot(4, false) === 72000, 'con la promo apagada, 4 pines valen 4 × 18 mil');
  check(await tot(2, true, 2, 40000) === 36000, 'una «promo» más cara que por separado no se aplica');
  check(await tot(3, true, 3, 45000) === 45000 && await tot(6, true, 3, 45000) === 108000 && await tot(2, true, 3, 45000) === 36000, '3 por $45.000: solo con 3 exactos (ni con 2 ni con 6)');
  check(await one(`SELECT public.pin_money(30000)`) === '$30.000' && await one(`SELECT public.pin_money(1250000)`) === '$1.250.000', 'la plata se escribe $30.000');

  // ── Apagada: el tripulante no ve nada ──────────────────────────────────────
  await soy(LAURA, 'auxiliar', ORG);
  let st = await one(`SELECT public.aux_pins_store()`);
  check(st.enabled === false && st.products === undefined, 'tienda apagada: al tripulante no le llega ningún pin');
  let e = await falla(`SELECT public.aux_pins_reserve('[{"product_id":"${ORG}","qty":1}]'::jsonb)`);
  check(e && /no está abierta/.test(e.message), 'tienda apagada: no se puede reservar', e && e.message);

  // ── Solo el jefe maneja la tienda ──────────────────────────────────────────
  e = await falla(`SELECT public.admin_pins_overview()`);
  check(e && e.code === '42501', 'un tripulante no puede abrir la pantalla del jefe', e && e.message);
  e = await falla(`SELECT public.admin_pins_save_settings('{"enabled":true}'::jsonb)`);
  check(e && e.code === '42501', 'un tripulante no puede encender la tienda');
  check(await one(`SELECT public.admin_pins_counts()`) === null, 'el globo del menú no le responde a quien no es jefe');
  await soy(CHOFER, 'driver', ORG);
  e = await falla(`SELECT public.admin_pins_save_product('{"name":"x"}'::jsonb)`);
  check(e && e.code === '42501', 'un conductor tampoco');
  st = await one(`SELECT public.aux_pins_store()`);
  check(st.enabled === false, 'a un conductor la tienda no le sale');

  // ── El jefe la enciende y pone el inventario ───────────────────────────────
  await soy(JEFE, 'admin', ORG);
  let ov = await one(`SELECT public.admin_pins_overview()`);
  check(ov.settings.enabled === false && ov.products.length === 6 && ov.reservations.length === 0 && ov.counts.pending === 0, 'el jefe ve ajustes, los seis pines y ninguna reserva');
  const P = Object.fromEntries(ov.products.map(x => [x.name, x.id]));
  e = await falla(`SELECT public.admin_pins_save_settings('{"promo_price_cop":36000}'::jsonb)`);
  check(e && /más barata/.test(e.message), 'no deja guardar una promo que no rebaja', e && e.message);
  e = await falla(`SELECT public.admin_pins_save_settings('{"unit_price_cop":"abc"}'::jsonb)`);
  check(e && /número válido/.test(e.message), 'un precio que no es número se rechaza con un mensaje claro', e && e.message);
  e = await falla(`SELECT public.admin_pins_save_settings('{"title":""}'::jsonb)`);
  check(e && /nombre de la tienda/.test(e.message), 'la tienda no puede quedar sin nombre');
  let se = await one(`SELECT public.admin_pins_save_settings('{"enabled":true,"card_text":"Para tu maleta."}'::jsonb)`);
  check(se.enabled === true && se.card_text === 'Para tu maleta.' && se.unit_price_cop === 18000 && se.promo_price_cop === 30000, 'encender guarda solo lo que llega y deja lo demás como estaba');
  check(se.contact_name === 'Julián', 'quien entrega es «Julián» mientras el jefe no lo cambie', se.contact_name);
  e = await falla(`SELECT public.admin_pins_save_settings('{"contact_name":"  "}'::jsonb)`);
  check(e && /quién entrega/.test(e.message), 'no puede quedar sin nombre quien entrega', e && e.message);
  const prod = async (o) => one(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify(o)]);
  await prod({ id: P['Pingüino piloto'], status: 'available', stock: 5 });
  await prod({ id: P['Pingüino cool'], status: 'available', stock: 1 });
  await prod({ id: P['Alas Rendio'], status: 'available', stock: 0 });
  await prod({ id: P['Gorra de capitán'], status: 'sold_out', stock: 9 });
  await prod({ id: P['Cola Rendio'], status: 'hidden', stock: 4 });
  let pr = await prod({ id: P['Pingüino piloto'], stock_delta: 1 });
  check(pr.stock === 6, 'el + del inventario suma una unidad', pr.stock);
  pr = await prod({ id: P['Pingüino piloto'], stock_delta: -1, name: 'Pingüino piloto' });
  check(pr.stock === 5, 'el − resta una unidad');
  e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ id: P['Alas Rendio'], stock_delta: -1 })]);
  check(e && /debajo de cero/.test(e.message), 'el inventario no baja de cero', e && e.message);
  e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ id: P['Alas Rendio'], status: 'vendido' })]);
  check(e && /estado no existe/.test(e.message), 'un estado inventado se rechaza');
  e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ name: 'Pin nuevo', image_path: 'https://otro.sitio/x.png' })]);
  check(e && /imagen/.test(e.message), 'un pin nuevo no acepta una imagen de otro sitio', e && e.message);
  e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ name: 'Pin nuevo', image_path: ORG + '/nuevo.png' })]);
  check(e && /imagen/.test(e.message), 'ni una imagen que no se subió');
  await db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('pins', $1)`, [ORG + '/nuevo.png']);
  pr = await prod({ name: '  Pin nuevo  ', image_path: ORG + '/nuevo.png' });
  check(pr.name === 'Pin nuevo' && pr.status === 'soon' && pr.stock === 0 && pr.sort === 70, 'un pin nuevo entra como «Próximamente», sin inventario y al final', pr);
  await prod({ id: pr.id, status: 'hidden' });
  await soy(JEFE2, 'admin', ORG2);
  e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ id: P['Pingüino piloto'], stock: 999 })]);
  check(e && /no existe/.test(e.message), 'el jefe de otra organización no puede tocar estos pines');

  // ── El tripulante ve la tienda ─────────────────────────────────────────────
  await soy(LAURA, 'auxiliar', ORG);
  st = await one(`SELECT public.aux_pins_store()`);
  const S = Object.fromEntries((st.products || []).map(x => [x.name, x]));
  check(st.enabled && st.contact_name === 'Julián' && st.unit_price_cop === 18000 && st.promo_on === true && st.promo_qty === 2 && st.promo_price_cop === 30000, 'la tienda llega con el precio, la promo y quién entrega');
  check(st.products.length === 5 && !S['Cola Rendio'] && !S['Pin nuevo'], 'los pines ocultos no le llegan', st.products.map(x => x.name));
  check(S['Pingüino piloto'].state === 'available' && S['Pingüino piloto'].stock === 5, 'disponible con sus unidades');
  check(S['Alas Rendio'].state === 'sold_out', 'disponible pero sin unidades sale «Agotado» solo');
  check(S['Gorra de capitán'].state === 'sold_out' && S['Gorra de capitán'].stock === 0, '«Agotado» a mano no muestra las unidades guardadas');
  check(S['Café de vuelo'].state === 'soon', '«Próximamente» se ve');
  check(st.products[0].name === 'Pingüino piloto', 'salen en el orden del jefe');

  // ── Reservar ───────────────────────────────────────────────────────────────
  const reservar = (items) => one(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify(items)]);
  const noReserva = async (items) => falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [typeof items === 'string' ? items : JSON.stringify(items)]);
  e = await noReserva([{ product_id: P['Café de vuelo'], qty: 1 }]);
  check(e && /llega pronto/.test(e.message), 'un pin «Próximamente» no se puede reservar', e && e.message);
  e = await noReserva([{ product_id: P['Gorra de capitán'], qty: 1 }]);
  check(e && /se agotó/.test(e.message), 'ni uno «Agotado» a mano');
  e = await noReserva([{ product_id: P['Alas Rendio'], qty: 1 }]);
  check(e && /se agotó/.test(e.message), 'ni uno sin unidades');
  e = await noReserva([{ product_id: P['Cola Rendio'], qty: 1 }]);
  check(e && /ya no está en la tienda/.test(e.message), 'ni uno oculto', e && e.message);
  e = await noReserva([{ product_id: P['Pingüino cool'], qty: 2 }]);
  check(e && /solo queda 1/.test(e.message), 'pedir más de lo que hay dice cuántos quedan', e && e.message);
  e = await noReserva([{ product_id: P['Pingüino piloto'], qty: 7 }]);
  check(e && /máximo 6/.test(e.message), 'respeta el máximo por reserva', e && e.message);
  for (const malo of ['[]', '{}', 'null', '[{"product_id":"x","qty":1}]', `[{"product_id":"${P['Pingüino piloto']}","qty":0}]`, `[{"product_id":"${P['Pingüino piloto']}","qty":"1.5"}]`, `[{"qty":1}]`, `[{"product_id":"${JEFE}","qty":1}]`]) {
    e = await noReserva(malo);
    if (!e) { check(false, 'una reserva mal armada se rechaza', malo); }
  }
  check(true, 'las reservas mal armadas (vacía, sin pin, cantidad 0 o con decimales, pin inexistente) se rechazan');
  check(await one(`SELECT count(*)::int FROM pin_reservations`) === 0 && await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino piloto']]) === 5, 'ningún intento fallido dejó reserva ni movió el inventario');

  let r1 = await reservar([{ product_id: P['Pingüino piloto'], qty: 1 }, { product_id: P['Pingüino cool'], qty: 1 }]);
  check(r1.ok && r1.reservation.units === 2 && r1.reservation.subtotal_cop === 36000 && r1.reservation.discount_cop === 6000 && r1.reservation.total_cop === 30000, 'dos pines distintos: $30.000 con $6.000 de descuento', r1.reservation);
  check(r1.reservation.promo_label === '2 por $30.000' && r1.reservation.status === 'reserved' && r1.reservation.items.length === 2, 'guarda la promo aplicada y los dos pines');
  check(await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino piloto']]) === 4 && await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino cool']]) === 0, 'reservar descuenta del inventario');
  const av = await q(`SELECT profile_id, title, body, url FROM notification_outbox`);
  check(av.length === 1 && av[0].profile_id === JEFE && av[0].title === 'Nueva reserva de pines' && av[0].body === 'Laura Gómez reservó 2 pines · $30.000' && av[0].url === '/#/pines', 'al jefe de SU organización le llega el aviso con quién y cuánto', av);

  await soy(ANDRES, 'auxiliar', ORG);
  e = await noReserva([{ product_id: P['Pingüino cool'], qty: 1 }]);
  check(e && /se agotó/.test(e.message), 'el que llega después ya no alcanza el último');
  st = await one(`SELECT public.aux_pins_store()`);
  check(st.products.find(x => x.name === 'Pingüino cool').state === 'sold_out' && st.my_pending === 0, 'y en su tienda ese pin ya sale «Agotado»');
  const r2 = await reservar([{ product_id: P['Pingüino piloto'], qty: 2 }, { product_id: P['Pingüino piloto'], qty: 1 }]);
  check(r2.reservation.units === 3 && r2.reservation.total_cop === 54000 && r2.reservation.discount_cop === 0 && r2.reservation.promo_label === null && r2.reservation.items.length === 1 && r2.reservation.items[0].qty === 3, 'tres pines: $54.000, sin descuento (la promo es solo por 2)', r2.reservation);
  let mias = await one(`SELECT public.aux_pins_my_reservations()`);
  check(mias.length === 1 && mias[0].id === r2.reservation.id, 'cada tripulante ve solo sus reservas');

  // RLS: leyendo las tablas directo, con el rol de la sesión.
  await db.exec(`SET ROLE authenticated`);
  const direct = await q(`SELECT id FROM public.pin_reservations`);
  const directItems = await one(`SELECT count(*)::int FROM public.pin_reservation_items`);
  const directProds = await one(`SELECT count(*)::int FROM public.pin_products`);
  e = await falla(`UPDATE public.pin_products SET stock = 99`);
  const e2 = await falla(`INSERT INTO public.pin_reservations (organization_id, auxiliar_profile_id, units, subtotal_cop, total_cop) VALUES ('${ORG}', '${AUX_A}', 1, 0, 0)`);
  await db.exec(`RESET ROLE`);
  check(direct.length === 1 && direct[0].id === r2.reservation.id && directItems === 1, 'RLS: por la tabla tampoco ve reservas ajenas');
  check(directProds === 5, 'RLS: por la tabla no ve los pines ocultos', directProds);
  check(e && /permission denied/.test(e.message) && e2 && /permission denied/.test(e2.message), 'RLS: la sesión no puede escribir las tablas directo');

  // ── El jefe: aviso, entregar, deshacer, cancelar ───────────────────────────
  await soy(JEFE, 'admin', ORG);
  ov = await one(`SELECT public.admin_pins_overview()`);
  check(ov.counts.pending === 2 && ov.counts.unseen === 2 && ov.reservations.length === 2, 'el jefe ve dos reservas por entregar, las dos nuevas', ov.counts);
  const rl = ov.reservations.find(x => x.id === r1.reservation.id);
  check(rl.crew_name === 'Laura Gómez' && rl.crew_phone === '3000000002' && rl.residence === 'Conjunto El Dorado' && rl.is_new === true, 'cada reserva dice quién es, su teléfono y su conjunto');
  const pp = ov.products.find(x => x.name === 'Pingüino piloto');
  check(pp.stock === 1 && pp.reserved_units === 4 && pp.delivered_units === 0, 'el inventario dice cuántos quedan y cuántos están reservados', pp);
  check((await one(`SELECT public.admin_pins_counts()`)).unseen === 2, 'el globo del menú cuenta las que nadie ha visto');
  check((await one(`SELECT public.admin_pins_mark_seen()`)).unseen === 0 && (await one(`SELECT public.admin_pins_counts()`)).pending === 2, 'al abrir la pantalla se apaga el globo, y siguen por entregar');

  const set = (id, a, n) => one(`SELECT public.admin_pins_set_reservation($1, $2, $3)`, [id, a, n || null]);
  let d = await set(r1.reservation.id, 'deliver');
  check(d.reservation.status === 'delivered' && d.reservation.delivered_at && d.counts.pending === 1, 'marcar entregado cambia el estado');
  e = await falla(`SELECT public.admin_pins_set_reservation($1, 'deliver', NULL)`, [r1.reservation.id]);
  check(e && /ya estaba entregada/.test(e.message), 'no se entrega dos veces');
  e = await falla(`SELECT public.admin_pins_set_reservation($1, 'cancel', NULL)`, [r1.reservation.id]);
  check(e && /deshaz la entrega/.test(e.message), 'una entregada no se cancela sin deshacer la entrega');
  check(await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino cool']]) === 0, 'entregar no devuelve nada al inventario');
  d = await set(r1.reservation.id, 'reopen');
  check(d.reservation.status === 'reserved' && d.reservation.delivered_at === null && d.counts.pending === 2, 'deshacer la entrega la devuelve a «Reservado»');
  d = await set(r1.reservation.id, 'cancel', '  Laura ya no los quiere  ');
  check(d.reservation.status === 'cancelled' && d.reservation.cancel_note === 'Laura ya no los quiere' && d.counts.pending === 1, 'cancelar guarda el motivo');
  check(await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino cool']]) === 1 && await one(`SELECT stock FROM pin_products WHERE id = $1`, [P['Pingüino piloto']]) === 2, 'cancelar devuelve las unidades al inventario');
  const avc = await q(`SELECT profile_id, body FROM notification_outbox WHERE title = 'Tu reserva de pines se canceló'`);
  check(avc.length === 1 && avc[0].profile_id === LAURA && avc[0].body === 'Laura ya no los quiere', 'a la tripulante le llega el aviso de la cancelación con el motivo');
  e = await falla(`SELECT public.admin_pins_set_reservation($1, 'cancel', NULL)`, [r1.reservation.id]);
  check(e && /ya estaba cancelada/.test(e.message), 'no se cancela dos veces (el inventario no se infla)');
  e = await falla(`SELECT public.admin_pins_set_reservation($1, 'regalar', NULL)`, [r2.reservation.id]);
  check(e && /Acción no válida/.test(e.message), 'una acción inventada se rechaza');
  await soy(JEFE2, 'admin', ORG2);
  e = await falla(`SELECT public.admin_pins_set_reservation($1, 'deliver', NULL)`, [r2.reservation.id]);
  check(e && /no existe/.test(e.message), 'el jefe de otra organización no puede entregar esta reserva');
  ov = await one(`SELECT public.admin_pins_overview()`);
  check(ov.reservations.length === 0 && ov.products.length === 6 && ov.settings.enabled === false, 'y en su pantalla solo ve lo suyo');
  check(await one(`SELECT count(*)::int FROM notification_outbox WHERE profile_id = $1`, [JEFE2]) === 0, 'ni le llegó ningún aviso');

  await soy(LAURA, 'auxiliar', ORG);
  mias = await one(`SELECT public.aux_pins_my_reservations()`);
  check(mias.length === 1 && mias[0].status === 'cancelled' && mias[0].cancel_note === 'Laura ya no los quiere', 'la tripulante ve su reserva cancelada con el motivo');
  const r3 = await reservar([{ product_id: P['Pingüino cool'], qty: 1 }]);
  check(r3.reservation.total_cop === 18000 && r3.reservation.discount_cop === 0 && r3.reservation.promo_label === null, 'un solo pin: $18.000, sin promo; y la unidad devuelta se pudo reservar otra vez');

  // Cuenta suspendida.
  await db.query(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [ANDRES]);
  await soy(ANDRES, 'auxiliar', ORG);
  e = await noReserva([{ product_id: P['Pingüino piloto'], qty: 1 }]);
  check(e && e.code === '42501' && /suspendida/.test(e.message), 'una cuenta suspendida no reserva');

  // El jefe apaga la tienda: quien tiene reservas igual se entera de que las tiene.
  await soy(JEFE, 'admin', ORG);
  await one(`SELECT public.admin_pins_save_settings('{"enabled":false}'::jsonb)`);
  await soy(LAURA, 'auxiliar', ORG);
  st = await one(`SELECT public.aux_pins_store()`);
  check(st.enabled === false && st.my_pending === 1, 'tienda apagada: la tripulante sigue sabiendo que tiene una reserva por recibir');

  // ── Down ───────────────────────────────────────────────────────────────────
  await db.exec(DOWN);
  const quedan = await one(`SELECT (SELECT count(*) FROM pg_class WHERE relname LIKE 'pin\\_%' AND relkind = 'r')::int
    + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'pin\\_%' OR proname LIKE '%\\_pins\\_%')::int
    + (SELECT count(*) FROM pg_policies WHERE policyname LIKE 'p\\_pin%')::int`);
  check(quedan === 0, 'el down no deja tablas, funciones ni políticas de pines', quedan);
  await db.exec(DOWN);
  await db.exec(UP);
  check(await one(`SELECT count(*)::int FROM pin_products WHERE organization_id = $1`, [ORG]) === 6, 'el down corre dos veces y la migración se puede volver a aplicar');

  console.log(`\n${mal ? '✗' : '✓'} ${ok} bien, ${mal} mal`);
  process.exit(mal ? 1 : 0);
}
