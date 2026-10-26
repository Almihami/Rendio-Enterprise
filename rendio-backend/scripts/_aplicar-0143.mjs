// 0143 · Pegar la ruta de Julián ya no borra lo que armó el sistema, y la madrugada
// cuenta también para el día anterior.
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0143.mjs [--aplicar]
//   PRODUCCIÓN (con su OK):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0143.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES exige las huellas md5 de lo que reemplaza (pegar 0133, quitar 0125,
// detector y reubicar 0141; iguales en dev y producción el 26-oct 16:45), o que
// ya esté 0143.
// DESPUÉS, en un SAVEPOINT que siempre se deshace, una pasada del detector con
// los datos reales: quiénes quedan anotados «sin carro» (avisan en la pasada
// siguiente si siguen sin carro).
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
console.log(aplicar ? `\n== APLICANDO 0143 en ${amb} ==` : `\n== 0143 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const F = { pub: 'public.admin_manual_route_publish(date,jsonb,jsonb)', clr: 'public.admin_manual_route_clear(date)',
  det: 'public.detect_late_bookings()', rr: 'public.reubicar_reserva(uuid,timestamptz,text)' };
const H = { pub: '34fc4cdee3644ed9e337d657987fabeb', clr: '45cc9be26c002f5fa8cc9ff3664be5ce',
  det: 'ef0b6f54b699a25b6a8ad61019b054e8', rr: '481ec704bb105ccc831bd7ac6f976176' };
const huella = async (sig) => (await one(`SELECT md5(prosrc) h, prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig])) || {};
const es0143 = (f) => (f.prosrc || '').includes('0143');

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const h0 = {};
  for (const [k, sig] of Object.entries(F)) h0[k] = await huella(sig);
  console.log('  ' + Object.entries(h0).map(([k, f]) => `${k}: ${f.h === H[k] ? 'el de hoy' : es0143(f) ? '0143 (ya estaba)' : 'OTRO ' + f.h}`).join(' · '));
  if (!Object.entries(h0).every(([k, f]) => f.h === H[k] || es0143(f))) throw new Error('alguien cambió una de las 4 funciones: mirar qué antes de pisarla');

  const antes = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res`);
  await c.query(strip('../supabase/migrations/0143_pegar_no_borra_automaticas.sql'));
  const h1 = {};
  for (const [k, sig] of Object.entries(F)) h1[k] = await huella(sig);
  t('las 4 funciones quedaron con 0143', Object.values(h1).every(es0143), Object.fromEntries(Object.entries(h1).map(([k, f]) => [k, es0143(f)])));
  t('dia_madrugada: 0:30 es del día anterior; 9:00 no', (await one(`SELECT public.dia_madrugada('2026-10-27T00:30:00-05:00')::text a,
    public.dia_madrugada('2026-10-27T09:00:00-05:00') b`)).a === '2026-10-26');
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.dia_madrugada(timestamptz)', 'EXECUTE') a,
    has_function_privilege('authenticated', '${F.rr}', 'EXECUTE') b, has_function_privilege('authenticated', '${F.pub}', 'EXECUTE') c1,
    has_function_privilege('anon', '${F.pub}', 'EXECUTE') d, has_function_privilege('authenticated', '${F.clr}', 'EXECUTE') e`);
  t('permisos: pegar/quitar para jefes (no anon); dia_madrugada y reubicar cerradas', !perm.a && !perm.b && perm.c1 && !perm.d && perm.e, perm);
  const desp = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res`);
  t('aplicarla no movió nada (eventualidades, avisos, vueltas, paradas, reservas)', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });

  // Pasada de verdad del detector (siempre se deshace): quiénes quedan anotados.
  await c.query('SAVEPOINT prueba');
  await q(`SELECT public.detect_late_bookings()`);
  const anot = await q(`SELECT split_part(p.full_name, ' ', 1) || ' ' || split_part(p.full_name, ' ', 2) quien,
      to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'MM-DD HH24:MI') hora, r.direction::text dir
    FROM late_booking_candidates lb JOIN reservations r ON r.id = lb.reservation_id
    JOIN auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN profiles p ON p.id = ap.profile_id ORDER BY r.required_arrival_at`);
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  console.log(`  anotados «sin carro» en una pasada (avisan en la siguiente si siguen sin carro): ${anot.length}`);
  for (const a of anot) console.log(`    · ${a.quien} · ${a.hora} · ${a.dir}`);
  t('no es una tormenta (≤ 8 anotados)', anot.length <= 8, anot.length);
  if (fallas.length || !aplicar) { await c.query('ROLLBACK'); console.log(fallas.length ? `\n✗ ${fallas.length} fallas: NO se aplicó` : '\nEn seco: se deshizo.'); }
  else { await c.query('COMMIT'); console.log(`\nCOMMIT ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`); }
} catch (e) {
  await c.query('ROLLBACK'); console.log('  ✗ ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '')); fallas.push('error');
}
await c.end();
process.exit(fallas.length ? 1 : 0);
