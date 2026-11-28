// Prueba LOCAL de 0182 (pines: «solo la tarjeta») en un Postgres en memoria
// (PGlite): no toca dev ni prod. Monta el mismo esquema mínimo de la prueba de
// 0181, corre 0181 y encima 0182 (dos veces: es idempotente), recorre los tres
// estados de la tienda y al final corre el down, que debe dejar 0181 funcionando.
// Uso: node _verify-0182-pglite.mjs <carpeta con node_modules/@electric-sql/pglite>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mods = process.argv[2];
if (!mods) { console.error('Falta la carpeta que tiene node_modules/@electric-sql/pglite'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(mods, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const here = fileURLToPath(new URL('../', import.meta.url));
const UP1 = readFileSync(join(here, 'supabase/migrations/0181_tienda_de_pines.sql'), 'utf8');
const UP2 = readFileSync(join(here, 'supabase/migrations/0182_pines_solo_la_tarjeta.sql'), 'utf8');
const DOWN2 = readFileSync(join(here, 'down_migrations/0182_pines_solo_la_tarjeta.down.sql'), 'utf8');
// El esquema mínimo es el de la prueba de 0181 (una sola copia).
const ESQUEMA = readFileSync(join(here, 'scripts/_verify-0181-pglite.mjs'), 'utf8').match(/const ESQUEMA = `([\s\S]*?)`;/)[1];

const db = new PGlite();
let ok = 0, mal = 0;
const check = (c, t, d) => { c ? ok++ : mal++; console.log((c ? '  ✓ ' : '  ✗ ') + t + (!c && d !== undefined ? ' → ' + JSON.stringify(d) : '')); };
const q = async (s, v) => (await db.query(s, v)).rows;
const one = async (s, v) => { const r = await q(s, v); return r[0] ? Object.values(r[0])[0] : undefined; };
const soy = async (uid, role, org) => { await db.query(`SELECT set_config('t.uid', $1, false), set_config('t.role', $2, false), set_config('t.org', $3, false)`, [uid || '', role || '', org || '']); };
const falla = async (s, v) => { try { await db.query(s, v); return null; } catch (e) { return e; } };

const ORG = '00000000-0000-0000-0000-0000000000a1';
const JEFE = '00000000-0000-0000-0000-00000000000a', LAURA = '00000000-0000-0000-0000-0000000000c1', AUX_L = '00000000-0000-0000-0000-0000000000e1';

await db.exec(ESQUEMA);
await db.exec(`
  INSERT INTO public.organizations VALUES ('${ORG}', 'Rendio');
  INSERT INTO public.profiles (id, organization_id, role, full_name) VALUES
    ('${JEFE}', '${ORG}', 'admin', 'Julián Jefe'), ('${LAURA}', '${ORG}', 'auxiliar', 'Laura Gómez');
  INSERT INTO public.auxiliar_profiles VALUES ('${AUX_L}', '${LAURA}', NULL);
`);

console.log('\n== 0182 en PGlite (encima de 0181) ==');
await db.exec(UP1);
// Como dev antes de 0182: tienda ya encendida y abierta.
await db.exec(`UPDATE public.pin_store_settings SET enabled = true`);
await db.exec(UP2);
await db.exec(UP2);
check(true, '0182 corre dos veces sin error (idempotente)');

check(await one(`SELECT card_only FROM pin_store_settings`) === true, 'la columna nace en «solo la tarjeta», también en una tienda que ya estaba encendida');
const priv = (await q(`SELECT
    has_function_privilege('anon', 'public.aux_pins_reserve(jsonb)', 'EXECUTE') a1,
    has_function_privilege('authenticated', 'public.aux_pins_reserve(jsonb)', 'EXECUTE') a2,
    has_function_privilege('anon', 'public.aux_pins_store()', 'EXECUTE') a3,
    has_function_privilege('authenticated', 'public.admin_pins_save_settings(jsonb)', 'EXECUTE') a4,
    has_function_privilege('authenticated', 'public.pin_settings_json(uuid)', 'EXECUTE') a5`))[0];
check(!priv.a1 && priv.a2 && !priv.a3 && priv.a4 && !priv.a5, 'los permisos de las funciones quedaron como en 0181');

const reservar = (items) => one(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify(items)]);
const guardar = (o) => one(`SELECT public.admin_pins_save_settings($1::jsonb)`, [JSON.stringify(o)]);

await soy(JEFE, 'admin', ORG);
let ov = await one(`SELECT public.admin_pins_overview()`);
check(ov.settings.enabled === true && ov.settings.card_only === true, 'el jefe ve la tienda encendida en «solo la tarjeta»', ov.settings);
const PIL = ov.products.find(x => x.name === 'Pingüino piloto').id;
await one(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ id: PIL, status: 'available', stock: 5 })]);

// ── Solo la tarjeta ──────────────────────────────────────────────────────────
await soy(LAURA, 'auxiliar', ORG);
let st = await one(`SELECT public.aux_pins_store()`);
check(st.enabled === true && st.card_only === true && st.products.length === 6, 'al tripulante le llega la tienda marcada como solo la tarjeta (con los pines para pintarla)', { e: st.enabled, c: st.card_only });
let e = await falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: PIL, qty: 1 }])]);
check(e && /todavía no está abierta/.test(e.message), 'con solo la tarjeta no se puede reservar, aunque el pin esté disponible', e && e.message);
check(await one(`SELECT count(*)::int FROM pin_reservations`) === 0 && await one(`SELECT stock FROM pin_products WHERE id = $1`, [PIL]) === 5
  && await one(`SELECT count(*)::int FROM notification_outbox`) === 0, 'ese intento no dejó reserva, ni movió inventario, ni avisó a nadie');

// ── El jefe la abre ──────────────────────────────────────────────────────────
await soy(LAURA, 'auxiliar', ORG);
e = await falla(`SELECT public.admin_pins_save_settings('{"card_only":false}'::jsonb)`);
check(e && e.code === '42501', 'un tripulante no puede abrir la tienda');
await soy(JEFE, 'admin', ORG);
e = await falla(`SELECT public.admin_pins_save_settings('{"card_only":"quizas"}'::jsonb)`);
check(!!e, 'un valor que no es sí/no se rechaza', e && e.message);
let se = await guardar({ title: 'Pines Rendio' });
check(se.card_only === true && se.enabled === true, 'guardar otra cosa no cambia cómo está la tienda');
se = await guardar({ card_only: false });
check(se.card_only === false && se.enabled === true, 'el jefe abre la tienda');
await soy(LAURA, 'auxiliar', ORG);
st = await one(`SELECT public.aux_pins_store()`);
check(st.card_only === false, 'al tripulante ya le llega como tienda abierta');
const r1 = await reservar([{ product_id: PIL, qty: 2 }]);
check(r1.ok && r1.reservation.total_cop === 30000, 'y puede reservar (2 pines, $30.000)', r1.reservation);

// ── Vuelve a solo la tarjeta, y apagada ──────────────────────────────────────
await soy(JEFE, 'admin', ORG);
se = await guardar({ card_only: true });
await soy(LAURA, 'auxiliar', ORG);
e = await falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: PIL, qty: 1 }])]);
st = await one(`SELECT public.aux_pins_store()`);
const mias = await one(`SELECT public.aux_pins_my_reservations()`);
check(e && /todavía no está abierta/.test(e.message) && st.card_only === true && st.my_pending === 1 && mias.length === 1, 'de vuelta en solo la tarjeta: no se reserva, y lo ya reservado sigue ahí');
await soy(JEFE, 'admin', ORG);
se = await guardar({ enabled: false });
check(se.enabled === false && se.card_only === true, 'apagarla no la deja abierta para la próxima vez');
await soy(LAURA, 'auxiliar', ORG);
st = await one(`SELECT public.aux_pins_store()`);
check(st.enabled === false && st.card_only === undefined && st.products === undefined && st.my_pending === 1, 'apagada: al tripulante no le llega nada de la tienda');

// ── Down: 0181 vuelve a funcionar sola ───────────────────────────────────────
await soy(JEFE, 'admin', ORG);
await guardar({ enabled: true });
await db.exec(DOWN2);
await db.exec(DOWN2);
check(await one(`SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'pin_store_settings' AND column_name = 'card_only'`) === 0, 'el down quita la columna (y corre dos veces)');
ov = await one(`SELECT public.admin_pins_overview()`);
check(ov.settings.card_only === undefined && ov.settings.enabled === true, 'los ajustes vuelven a ser los de 0181');
await soy(LAURA, 'auxiliar', ORG);
st = await one(`SELECT public.aux_pins_store()`);
const r2 = await reservar([{ product_id: PIL, qty: 1 }]);
check(st.card_only === undefined && r2.ok && r2.reservation.total_cop === 18000, 'tras el down la tienda encendida queda abierta, como en 0181, y se reserva');
await db.exec(UP2);
check(await one(`SELECT card_only FROM pin_store_settings`) === true, '0182 se puede volver a aplicar');

console.log(`\n${mal ? '✗' : '✓'} ${ok} bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
