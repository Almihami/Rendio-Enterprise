// 0144 · «Hay una vuelta para tomar» solo al turno, el freno del acomodo y la
// bandeja de avisos sin repetidos.
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0144.mjs [--aplicar]
//   PRODUCCIÓN (con su OK):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0144.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES exige las huellas md5 de lo que reemplaza: reubicar_reserva de 0143,
// reub_nota y acomodar_eventualidades de 0135, driver_release_route de 0125 (o
// que ya esté 0144: se puede volver a correr). Sin 0143 se niega.
// DESPUÉS, en un SAVEPOINT que siempre se deshace: a quién le llegaría hoy un
// aviso de vuelta para tomar (por turno) y una pasada de verdad del acomodo.
// La función dispatch-notifications se despliega APARTE, después de esto.
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
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 6543,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0144 en ${amb} ==` : `\n== 0144 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const SIG = {
  rr: 'public.reubicar_reserva(uuid,timestamptz,text)', nota: 'public.reub_nota(jsonb)',
  ac: 'public.acomodar_eventualidades(timestamptz)', rel: 'public.driver_release_route(uuid)',
};
// Lo de antes, calculado aplicando los archivos (_verify-0144: 0143, 0135, 0135, 0125).
const ANTES = { rr: '3419052de02792b159b641fb24bcd37f', nota: '2c1fb6f1ddc8792999d86f27c401ead6',
                ac: '23fa4ba06a8e4af5f35be4256a8e4d58', rel: '3730444f4af0310499c9b7cc55ff041f' };
const CON = { rr: '750d603886c03526e09e718200c8e87f', nota: 'a64ccbc7438a71db8de9ff0bf26410e0',
              ac: '189c3e9489a7a523ab472fd9345d1f21', rel: '211a1c775179e656265bb4ca9c166664' };
const huellas = async () => { const o = {}; for (const [k, s] of Object.entries(SIG)) o[k] = (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = to_regprocedure($1)`, [s]))?.h || null; return o; };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const h0 = await huellas();
  const estado = Object.fromEntries(Object.keys(SIG).map((k) => [k, h0[k] === ANTES[k] ? 'antes' : h0[k] === CON[k] ? '0144' : 'OTRO ' + h0[k]]));
  console.log(`  ahora: ${JSON.stringify(estado)}`);
  if (Object.values(estado).some((v) => v.startsWith('OTRO'))) throw new Error('alguien cambió una de las cuatro funciones (¿falta 0143?): mirar qué antes de pisarla');

  const contar = () => one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res`);
  const antes = await contar();
  await c.query(strip('../supabase/migrations/0144_avisos_por_turno_y_freno.sql'));
  const h1 = await huellas();
  t('las cuatro funciones quedaron como 0144', Object.keys(SIG).every((k) => h1[k] === CON[k]), h1);
  const nuevas = await one(`SELECT to_regprocedure('public.claim_notification_outbox(integer)') IS NOT NULL a,
    to_regprocedure('public.conductores_del_turno(uuid,timestamptz)') IS NOT NULL b, to_regclass('public.acomodo_creadas') IS NOT NULL c,
    (SELECT acomodo_max_nuevas FROM app_settings WHERE id = 'singleton') m`);
  t('la bandeja, el turno y el freno existen (máximo ' + nuevas.m + ' en media hora)', nuevas.a && nuevas.b && nuevas.c && nuevas.m > 0, nuevas);
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.claim_notification_outbox(integer)', 'EXECUTE') a,
    has_function_privilege('anon', 'public.claim_notification_outbox(integer)', 'EXECUTE') b,
    has_function_privilege('service_role', 'public.claim_notification_outbox(integer)', 'EXECUTE') s,
    has_function_privilege('authenticated', 'public.conductores_del_turno(uuid, timestamptz)', 'EXECUTE') d,
    has_function_privilege('authenticated', '${SIG.rr}', 'EXECUTE') f, has_function_privilege('authenticated', '${SIG.rel}', 'EXECUTE') g`);
  t('permisos: bandeja solo service_role, lo nuevo cerrado, soltar abierto al conductor', !perm.a && !perm.b && perm.s && !perm.d && !perm.f && perm.g, perm);
  t('aplicarla no movió nada (eventualidades, avisos, vueltas, paradas, reservas)', JSON.stringify(antes) === JSON.stringify(await contar()));

  // A quién le llegaría hoy (siempre se deshace; solo nombres de pila).
  await c.query('SAVEPOINT prueba');
  const org = (await one(`SELECT organization_id FROM profiles WHERE role = 'driver' AND deleted_at IS NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).organization_id;
  const activos = (await one(`SELECT count(*)::int n FROM profiles WHERE organization_id = $1 AND role = 'driver' AND deleted_at IS NULL AND is_active IS DISTINCT FROM false`, [org])).n;
  for (const h of ['now()', "now() + interval '3 hours'", "date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota' + interval '1 day 8 hours'"]) {
    const r = await one(`SELECT (SELECT dia::text || ' ' || turno FROM public.turno_de(${h})) turno,
      (SELECT string_agg(split_part(p.full_name, ' ', 1), ', ' ORDER BY p.full_name) FROM public.conductores_del_turno($1, ${h}) c JOIN profiles p ON p.id = c.profile_id) quienes,
      (SELECT count(*)::int FROM public.conductores_del_turno($1, ${h})) n`, [org]);
    console.log(`  turno ${r.turno}: le llegaría a ${r.n} de ${activos} conductores activos${r.quienes ? ' (' + r.quienes + ')' : ' → a los jefes'}`);
  }
  const ini = await contar();
  const ac = (await one(`SELECT public.acomodar_eventualidades() r`)).r;
  const fin = await contar();
  const titulos = await q(`SELECT title, count(*)::int n FROM notification_outbox WHERE created_at >= now() GROUP BY 1 ORDER BY 2 DESC`);
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  console.log(`  pasada de prueba del acomodo: ${JSON.stringify(ac)}; saldría ${JSON.stringify({ eventualidades: fin.inc - ini.inc, avisos: fin.box - ini.box, vueltas: fin.ra - ini.ra })} ${JSON.stringify(titulos)}`);

  if (fallas.length || !aplicar) { await c.query('ROLLBACK'); console.log(fallas.length ? `\n✗ ${fallas.length} fallas: NO se aplicó` : '\nEn seco: se deshizo.'); }
  else { await c.query('COMMIT'); console.log(`\nCOMMIT ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`); }
} catch (e) {
  await c.query('ROLLBACK'); console.log('  ✗ ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '')); fallas.push('error');
}
await c.end();
process.exit(fallas.length ? 1 : 0);
