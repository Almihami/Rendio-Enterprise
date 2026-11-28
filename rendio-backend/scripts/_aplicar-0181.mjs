// 0181 · Tienda de pines: el tripulante reserva y el jefe entrega.
//
//   DEV (en seco / de verdad):
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0181.mjs
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0181.mjs --aplicar
//   DEV, además con la tienda ENCENDIDA para verla ya (los pines siguen todos en
//   «Próximamente», que es como entran):
//     … node scripts/_aplicar-0181.mjs --aplicar --encender
//   PRODUCCIÓN (solo con su OK, después del respaldo; --encender no se acepta):
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0181.mjs --produccion
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0181.mjs --produccion --aplicar
//
// Todo va en UNA transacción: se aplica 0181, se comprueba y, solo si todo está
// bien y se pidió --aplicar, se confirma. En seco se deshace. El recorrido de
// prueba (un jefe enciende la tienda, un tripulante reserva, el jefe entrega y
// cancela) va en un SAVEPOINT que SIEMPRE se deshace: no deja reservas, ni
// inventario movido, ni avisos encolados.
//
// Comprueba: tablas, funciones, permisos y RLS; que la tienda nace apagada y los
// seis pines entran como «Próximamente» sin unidades; la cuenta de la promo; que
// reservar aparta inventario y encola el aviso a los jefes; que nadie ve reservas
// ajenas ni escribe las tablas directo; entregar / deshacer / cancelar (devuelve
// al inventario); que quien no es jefe no maneja la tienda; el bucket `pins`; y
// que, tras deshacer el recorrido, no quedó nada.
//
// La misma migración ya se probó sin tocar ninguna base con
// scripts/_verify-0181-pglite.mjs.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const ref = process.env.SUPABASE_PROJECT_REF || '';
const prod = process.argv.includes('--produccion');
const encender = process.argv.includes('--encender');
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`
    + (prod ? '' : ' Para producción: --produccion con .env.main.'));
  process.exit(2);
}
if (prod && encender) {
  console.error('ABORT: --encender es solo para dev. En producción la tienda la enciende el jefe desde su pantalla.');
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com',
  port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => { const r = await q(s, v); return r[0] ? Object.values(r[0])[0] : undefined; };
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0181 en ${amb} ==` : `\n== 0181 EN SECO contra ${amb} (se deshace) ==`);

const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
// Una sesión de la app: el rol y la organización salen del perfil, como en la base real.
const como = async (profileId) => {
  await c.query('RESET ROLE');
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: profileId, role: 'authenticated' })]);
  await c.query('SET LOCAL ROLE authenticated');
};
const postgres = async () => { await c.query('RESET ROLE'); };
// Llama algo que DEBE fallar, sin dañar la transacción.
const falla = async (s, v) => {
  await c.query('SAVEPOINT debe_fallar');
  try { await c.query(s, v); await c.query('ROLLBACK TO SAVEPOINT debe_fallar'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT debe_fallar'); return e; }
};

try {
  const yaEstaba = (await one(`SELECT to_regclass('public.pin_products') IS NOT NULL`)) === true;
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0181_tienda_de_pines.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  console.log(yaEstaba ? '  · la tienda YA estaba (se corre igual: es idempotente)' : '  · la tienda es nueva en esta base');

  // ── Lo que deja ────────────────────────────────────────────────────────────
  const o = (await q(`SELECT
      (SELECT count(*) FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
        WHERE n.nspname = 'public' AND k.relkind = 'r' AND k.relrowsecurity
          AND k.relname IN ('pin_store_settings', 'pin_products', 'pin_reservations', 'pin_reservation_items'))::int tablas_rls,
      to_regprocedure('public.aux_pins_store()') IS NOT NULL
        AND to_regprocedure('public.aux_pins_reserve(jsonb)') IS NOT NULL
        AND to_regprocedure('public.aux_pins_my_reservations()') IS NOT NULL
        AND to_regprocedure('public.admin_pins_overview()') IS NOT NULL
        AND to_regprocedure('public.admin_pins_counts()') IS NOT NULL
        AND to_regprocedure('public.admin_pins_mark_seen()') IS NOT NULL
        AND to_regprocedure('public.admin_pins_save_settings(jsonb)') IS NOT NULL
        AND to_regprocedure('public.admin_pins_save_product(jsonb)') IS NOT NULL
        AND to_regprocedure('public.admin_pins_set_reservation(uuid, text, text)') IS NOT NULL funcs,
      has_function_privilege('anon', 'public.aux_pins_reserve(jsonb)', 'EXECUTE')
        OR has_function_privilege('anon', 'public.aux_pins_store()', 'EXECUTE')
        OR has_function_privilege('anon', 'public.admin_pins_overview()', 'EXECUTE') anon_x,
      has_function_privilege('authenticated', 'public.aux_pins_reserve(jsonb)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.admin_pins_overview()', 'EXECUTE') auth_x,
      has_function_privilege('authenticated', 'public.pin_reservation_json(uuid)', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.pin_admin_org()', 'EXECUTE') interno_x,
      has_table_privilege('authenticated', 'public.pin_products', 'UPDATE')
        OR has_table_privilege('authenticated', 'public.pin_reservations', 'INSERT')
        OR has_table_privilege('anon', 'public.pin_products', 'SELECT') escribe,
      (SELECT count(*) FROM public.organizations)::int orgs,
      (SELECT count(*) FROM public.pin_store_settings)::int ajustes,
      (SELECT count(*) FROM public.pin_store_settings WHERE enabled)::int encendidas,
      (SELECT count(*) FROM public.pin_products WHERE slug IS NOT NULL)::int pines,
      (SELECT count(*) FROM public.pin_products WHERE status <> 'soon' OR stock <> 0)::int movidos,
      (SELECT count(*) FROM public.pin_reservations)::int reservas,
      (SELECT public FROM storage.buckets WHERE id = 'pins') bucket_publico,
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN ('p_pins_insert_admin', 'p_pins_delete_admin'))::int pol_bucket`))[0];
  t('las cuatro tablas quedaron, con RLS', o.tablas_rls === 4, o.tablas_rls);
  t('las nueve funciones quedaron', o.funcs === true);
  t('anon no puede llamar nada; una sesión sí', !o.anon_x && o.auth_x);
  t('las piezas internas no se llaman desde afuera', !o.interno_x);
  t('las tablas son de solo lectura para la sesión y anon no las ve', !o.escribe);
  t(`una fila de ajustes por organización (${o.orgs})`, o.ajustes === o.orgs, `${o.ajustes} de ${o.orgs}`);
  t('los seis pines quedaron cargados en cada organización', o.pines === 6 * o.orgs, `${o.pines}`);
  if (!yaEstaba) {
    t('la tienda nace apagada', o.encendidas === 0, o.encendidas);
    t('los pines entran como «Próximamente» y sin unidades', o.movidos === 0, o.movidos);
    t('no hay ninguna reserva', o.reservas === 0, o.reservas);
  } else {
    console.log(`  · ya había: ${o.encendidas} tienda(s) encendida(s), ${o.reservas} reserva(s)`);
  }
  t('el bucket `pins` es público y solo el jefe escribe', o.bucket_publico === true && o.pol_bucket === 2, `${o.bucket_publico} / ${o.pol_bucket}`);
  const tot = (n) => one(`SELECT public.pin_total($1, 18000, true, 2, 30000)`, [n]);
  t('2 por $30.000 solo con 2 exactos: 1→18, 2→30, 3→54, 4→72 mil', await tot(1) === 18000 && await tot(2) === 30000 && await tot(3) === 54000 && await tot(4) === 72000);

  // ── Recorrido de prueba con gente real de la base (SIEMPRE se deshace) ─────
  const [jefe] = await q(`SELECT p.id, p.organization_id org FROM public.profiles p
    WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false
      AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
           WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false) >= 2
    ORDER BY p.created_at LIMIT 1`);
  const trips = jefe ? await q(`SELECT ap.id aux, x.id pid, x.full_name FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
    WHERE x.organization_id = $1 AND x.role = 'auxiliar' AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false
    ORDER BY x.created_at LIMIT 2`, [jefe.org]) : [];
  const [chofer] = jefe ? await q(`SELECT id FROM public.profiles WHERE organization_id = $1 AND role = 'driver' AND deleted_at IS NULL AND is_active IS DISTINCT FROM false LIMIT 1`, [jefe.org]) : [];
  if (jefe && trips.length === 2) {
    const [ta, tb] = trips;
    await c.query('SAVEPOINT recorrido');
    // Punto de partida conocido, sin importar cómo esté la tienda en esta base.
    await q(`DELETE FROM public.pin_reservations WHERE organization_id = $1`, [jefe.org]);
    await q(`UPDATE public.pin_store_settings SET enabled = false, unit_price_cop = 18000, promo_enabled = true, promo_qty = 2,
      promo_price_cop = 30000, max_units = 6 WHERE organization_id = $1`, [jefe.org]);
    await q(`UPDATE public.pin_products SET status = 'soon', stock = 0 WHERE organization_id = $1`, [jefe.org]);
    const P = Object.fromEntries((await q(`SELECT slug, id FROM public.pin_products WHERE organization_id = $1 AND slug IS NOT NULL`, [jefe.org])).map(r => [r.slug, r.id]));
    const stock = (slug) => one(`SELECT stock FROM public.pin_products WHERE id = $1`, [P[slug]]);
    const avisos0 = await one(`SELECT count(*)::int FROM public.notification_outbox WHERE dedupe_key LIKE 'pin-%'`);

    await como(ta.pid);
    let st = await one(`SELECT public.aux_pins_store()`);
    t('tienda apagada: al tripulante no le llega ningún pin', st.enabled === false && st.products === undefined, st);
    let e = await falla(`SELECT public.admin_pins_save_settings('{"enabled":true}'::jsonb)`);
    t('un tripulante no puede encender la tienda', !!e && e.code === '42501', e ? e.message : 'pasó');
    t('el globo del menú no le responde a quien no es jefe', (await one(`SELECT public.admin_pins_counts()`)) === null);
    if (chofer) {
      await como(chofer.id);
      e = await falla(`SELECT public.admin_pins_overview()`);
      t('un conductor tampoco maneja la tienda', !!e && e.code === '42501', e ? e.message : 'pasó');
    }

    await como(jefe.id);
    const ov0 = await one(`SELECT public.admin_pins_overview()`);
    t('el jefe abre su pantalla: ajustes, pines y reservas', ov0.settings.enabled === false && ov0.products.length >= 6 && Array.isArray(ov0.reservations), ov0.settings);
    e = await falla(`SELECT public.admin_pins_save_settings('{"promo_price_cop":36000}'::jsonb)`);
    t('no deja guardar una promo que no rebaja', !!e && /más barata/.test(e.message), e ? e.message : 'pasó');
    const se = await one(`SELECT public.admin_pins_save_settings('{"enabled":true}'::jsonb)`);
    t('el jefe enciende la tienda', se.enabled === true && se.unit_price_cop === 18000);
    const prodSave = (o2) => one(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify(o2)]);
    await prodSave({ id: P['pinguino-piloto'], status: 'available', stock: 5 });
    await prodSave({ id: P['pinguino-cool'], status: 'available', stock: 1 });
    const pr = await prodSave({ id: P['pinguino-piloto'], stock_delta: 1 });
    t('el jefe pone el inventario y el + suma una unidad', pr.stock === 6, pr.stock);
    e = await falla(`SELECT public.admin_pins_save_product($1::jsonb)`, [JSON.stringify({ id: P['alas-rendio'], stock_delta: -1 })]);
    t('el inventario no baja de cero', !!e && /debajo de cero/.test(e.message), e ? e.message : 'pasó');

    await como(ta.pid);
    st = await one(`SELECT public.aux_pins_store()`);
    const S = Object.fromEntries((st.products || []).map(x => [x.id, x]));
    t('el tripulante ve la tienda con precio, promo y estados', st.enabled === true && st.promo_on === true && st.unit_price_cop === 18000
      && S[P['pinguino-piloto']].state === 'available' && S[P['pinguino-piloto']].stock === 6 && S[P['alas-rendio']].state === 'soon', st);
    e = await falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: P['alas-rendio'], qty: 1 }])]);
    t('un pin «Próximamente» no se puede reservar', !!e && /llega pronto/.test(e.message), e ? e.message : 'pasó');
    e = await falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: P['pinguino-cool'], qty: 2 }])]);
    t('pedir más de lo que hay dice cuántos quedan', !!e && /solo queda 1/.test(e.message), e ? e.message : 'pasó');
    const r1 = await one(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: P['pinguino-piloto'], qty: 1 }, { product_id: P['pinguino-cool'], qty: 1 }])]);
    t('reservar dos pines: $30.000 con $6.000 de descuento', r1.ok === true && r1.reservation.units === 2 && r1.reservation.total_cop === 30000 && r1.reservation.discount_cop === 6000, r1.reservation);
    await postgres();
    t('reservar descuenta del inventario', await stock('pinguino-piloto') === 5 && await stock('pinguino-cool') === 0);
    const av = await q(`SELECT o.profile_id, o.title, o.body, o.url FROM public.notification_outbox o WHERE o.dedupe_key LIKE 'pin-res:' || $1 || ':%'`, [r1.reservation.id]);
    const espera = await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [jefe.org]);
    t(`el aviso quedó encolado para los jefes que reciben avisos (${espera.length})`, av.length === espera.length && av.length > 0
      && av.every(x => x.title === 'Nueva reserva de pines' && x.url === '/#/pines' && / reservó 2 pines · \$30\.000$/.test(x.body)), av);

    await como(tb.pid);
    e = await falla(`SELECT public.aux_pins_reserve($1::jsonb)`, [JSON.stringify([{ product_id: P['pinguino-cool'], qty: 1 }])]);
    t('el que llega después ya no alcanza el último', !!e && /se agotó/.test(e.message), e ? e.message : 'pasó');
    const ajenas = await q(`SELECT id FROM public.pin_reservations`);
    const mias = await one(`SELECT public.aux_pins_my_reservations()`);
    t('otro tripulante no ve esa reserva (ni por la función ni por la tabla)', ajenas.length === 0 && mias.length === 0, { ajenas: ajenas.length, mias: mias.length });
    e = await falla(`UPDATE public.pin_products SET stock = 99`);
    t('la sesión no puede escribir las tablas directo', !!e && /permission denied/.test(e.message), e ? e.message : 'pasó');

    await como(jefe.id);
    const ov = await one(`SELECT public.admin_pins_overview()`);
    const rl = ov.reservations.find(x => x.id === r1.reservation.id);
    t('el jefe ve la reserva con el nombre de quien reservó', !!rl && rl.crew_name === ta.full_name && rl.is_new === true && ov.counts.pending === 1 && ov.counts.unseen === 1, ov.counts);
    t('al abrir la pantalla el globo se apaga', (await one(`SELECT public.admin_pins_mark_seen()`)).unseen === 0);
    const set = (a, n) => one(`SELECT public.admin_pins_set_reservation($1, $2, $3)`, [r1.reservation.id, a, n || null]);
    let d = await set('deliver');
    t('marcar entregado', d.reservation.status === 'delivered' && d.counts.pending === 0, d.reservation.status);
    e = await falla(`SELECT public.admin_pins_set_reservation($1, 'deliver', NULL)`, [r1.reservation.id]);
    t('no se entrega dos veces', !!e && /ya estaba entregada/.test(e.message), e ? e.message : 'pasó');
    d = await set('reopen');
    t('deshacer la entrega', d.reservation.status === 'reserved' && d.counts.pending === 1);
    d = await set('cancel', 'Prueba de 0181');
    t('cancelar guarda el motivo', d.reservation.status === 'cancelled' && d.reservation.cancel_note === 'Prueba de 0181');
    await postgres();
    t('cancelar devuelve las unidades al inventario', await stock('pinguino-piloto') === 6 && await stock('pinguino-cool') === 1);
    const avc = await q(`SELECT profile_id FROM public.notification_outbox WHERE dedupe_key = 'pin-cancel:' || $1`, [r1.reservation.id]);
    t('al tripulante le queda encolado el aviso de la cancelación', avc.length === 1 && avc[0].profile_id === ta.pid, avc);

    await postgres();
    await c.query('ROLLBACK TO SAVEPOINT recorrido');
    const d2 = (await q(`SELECT
        (SELECT count(*) FROM public.notification_outbox WHERE dedupe_key LIKE 'pin-%')::int avisos,
        (SELECT count(*) FROM public.pin_reservations)::int reservas,
        (SELECT count(*) FROM public.pin_store_settings WHERE enabled)::int encendidas`))[0];
    t('el recorrido se deshizo: ni reservas, ni avisos, ni tienda encendida de más',
      d2.avisos === avisos0 && d2.reservas === o.reservas && d2.encendidas === o.encendidas, d2);
  } else {
    t('hay un jefe y dos tripulantes activos para el recorrido de prueba', false, 'no hay');
  }
  await postgres();

  if (encender && !fallas.length) {
    await q(`UPDATE public.pin_store_settings SET enabled = true`);
    console.log('  · --encender: tienda ENCENDIDA en dev. Los pines quedan como estén (recién aplicada: todos en «Próximamente»).');
  }

  const fin = aplicar && !fallas.length ? 'COMMIT' : 'ROLLBACK';
  await c.query(fin);
  console.log(fallas.length
    ? `\n✗ ${fallas.length} comprobación(es) fallaron: ${fin}.`
    : `\n✓ Todo bien. ${fin === 'COMMIT' ? 'APLICADA en ' + amb + '.' : 'En seco: se deshizo (usa --aplicar).'}`);
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('\n✗ Error, se deshizo todo:', e.message);
  fallas.push('error');
} finally {
  await c.end();
}
process.exit(fallas.length ? 1 : 0);
