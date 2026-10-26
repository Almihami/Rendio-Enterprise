// 0147 · El aviso del regreso de reserva dice dónde lo recogen (hotel / JMC).
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0147.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0147.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES exige las huellas md5 de las cinco funciones que reemplaza, tal como
// estaban el 26-oct a las 5:25 p. m. (pegar 0143, tomar 0138, poner conductor 0129,
// delegar 0131, cambiar hora 0145), o que ya esté 0147. Si otra sesión cambió una,
// se para: hay que volver a copiarla DESDE la nueva.
// DESPUÉS: las cinco quedan con 0147, permisos iguales, y aplicar no movió nada.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0147 en ${amb} ==` : `\n== 0147 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0147_aviso_regreso_hotel.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const F = { pub: 'public.admin_manual_route_publish(date,jsonb,jsonb)', take: 'public.driver_take_route(uuid)',
  setd: 'public.admin_route_set_driver(uuid,uuid)', deleg: 'public.admin_route_delegate(uuid,text,text)',
  st: 'public.admin_manual_route_set_times(uuid,jsonb,timestamptz,timestamptz)' };
const H = { pub: '178cf9abee03eafe497992613ce90895', take: '94dda6282a594af63c9e2e3c8b1ef4ee', setd: '8013ea64c63d3302dd837731e4edd493',
  deleg: '206286b1bc80309f319ec6673904eb65', st: '8d7ae14b06d8de2d32b4802b3cb0aa82' };
const huella = async (sig) => (await one(`SELECT md5(prosrc) h, prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig])) || {};
const es0147 = (f) => (f.prosrc || '').includes('lugar_del_regreso');
const permisos = async () => one(`SELECT ${Object.entries(F).map(([k, sig]) => `has_function_privilege('authenticated', '${sig}', 'EXECUTE') ${k}, has_function_privilege('anon', '${sig}', 'EXECUTE') ${k}_anon`).join(', ')}`);
const cuentas = () => one(`SELECT (SELECT count(*) FROM notification_outbox)::int box, (SELECT count(*) FROM route_assignments)::int ra,
    (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas`);

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const h0 = {};
  for (const [k, sig] of Object.entries(F)) h0[k] = await huella(sig);
  console.log('  ' + Object.entries(h0).map(([k, f]) => `${k}: ${f.h === H[k] ? 'la de hoy' : es0147(f) ? '0147 (ya estaba)' : 'OTRA ' + f.h}`).join(' · '));
  if (!Object.entries(h0).every(([k, f]) => f.h === H[k] || es0147(f))) throw new Error('alguien cambió una de las 5 funciones: mirar qué antes de pisarla');
  const reservas = await one(`SELECT count(*) FILTER (WHERE reserve_place IN ('rio_verde', 'movich'))::int hotel, count(*) FILTER (WHERE reserve_place = 'aero')::int aero,
      count(*) FILTER (WHERE ground_ops)::int tierra FROM public.reservations WHERE direction = 'airport_to_home' AND cancelled_at IS NULL AND required_arrival_at >= now() - interval '1 day'`);
  console.log(`  · regresos vigentes que cambian de texto: ${reservas.hotel} de hotel · ${reservas.aero} de reserva en JMC · ${reservas.tierra} de tierra`);

  const p0 = await permisos(), antes = await cuentas();
  await c.query(sql);
  const h1 = {};
  for (const [k, sig] of Object.entries(F)) h1[k] = await huella(sig);
  t('las 5 funciones quedaron con 0147', Object.values(h1).every(es0147), Object.fromEntries(Object.entries(h1).map(([k, f]) => [k, es0147(f)])));
  const p1 = await permisos();
  t('permisos de las 5 iguales que antes (sesión sí, anon no)', JSON.stringify(p0) === JSON.stringify(p1) && Object.keys(F).every((k) => p1[k] && !p1[k + '_anon']), { p0, p1 });
  const ayuda = await one(`SELECT has_function_privilege('authenticated', 'public.lugar_del_regreso(uuid)', 'EXECUTE') a, has_function_privilege('anon', 'public.lugar_del_regreso(uuid)', 'EXECUTE') b`);
  t('lugar_del_regreso cerrada para la app', !ayuda.a && !ayuda.b, ayuda);
  const desp = await cuentas();
  t('aplicarla no movió nada (avisos, vueltas, paradas, reservas)', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });
  const ej = await one(`SELECT (SELECT public.lugar_del_regreso(id) FROM public.reservations WHERE reserve_place = 'rio_verde' AND direction = 'airport_to_home' LIMIT 1) hotel,
      (SELECT count(*) FROM public.reservations r WHERE r.direction = 'airport_to_home' AND coalesce(r.reserve_place, 'vuelo') = 'vuelo' AND NOT r.ground_ops AND public.lugar_del_regreso(r.id) IS NOT NULL)::int vuelo_con_lugar`);
  t('un regreso de vuelo nunca recibe lugar (su texto queda igual)', ej.vuelo_con_lugar === 0, ej);
  if (ej.hotel) console.log(`  · un regreso del Río Verde dirá: «Te recogemos ${ej.hotel} (sale hacia las …)»`);

  if (fallas.length || !aplicar) { await c.query('ROLLBACK'); console.log(fallas.length ? `\n✗ ${fallas.length} fallas: NO se aplicó` : `\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
  else { await c.query('COMMIT'); console.log(`\n✓ 0147 APLICADA en ${amb} · ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
