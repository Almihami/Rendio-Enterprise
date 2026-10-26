// 0127 · «X no tiene carro» ya no suena mientras el jefe re-publica.
//
//   LOCAL:  node scripts/_aplicar-0127.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0127.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0127.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES dice qué detector hay (0068, 0125 o 0126, por la huella md5 del cuerpo).
// Si es otro, no aplica: alguien lo cambió y hay que mirar qué antes de pisarlo.
// Aplicarla cuando nadie esté publicando en Asignación: toca route_stops y
// reservations, y con lock_timeout de 5 s se rinde en vez de frenar a un jefe
// (si pasa, volver a correrla).
//
// DESPUÉS comprueba: la tabla, el disparador y los permisos; que el reloj no
// cambió; que aplicar no movió nada (eventualidades, avisos, paradas,
// reservas, vueltas idénticas); y, en un SAVEPOINT que siempre se deshace, una
// pasada con los datos de verdad: cuántas reservas sin carro anota hoy y que la
// primera pasada NO avisa a nadie (las avisa la siguiente, si siguen sin carro).
// Antes de aplicar, en otro SAVEPOINT, cuántas abriría el detector de hoy.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
let c, amb;
if (local) {
  c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  amb = 'LOCAL';
} else {
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  const esperado = prod ? PROD : DEV;
  if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
    console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`);
    process.exit(2);
  }
  c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com',
    port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
    ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  amb = prod ? 'PRODUCCIÓN' : 'dev';
}
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
console.log(aplicar ? `\n== APLICANDO 0127 en ${amb} ==` : `\n== 0127 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };

// md5(prosrc) de detect_late_bookings en cada versión (calculadas en la base local, 26-oct-2026).
const CONOCIDAS = {
  a10a56bb5b6187f67b328f9c0191effa: '0068 (la de siempre)',
  ef7a9c6bbdcd2f7bfb1e8095ed9a8266: '0125 (ruta de Julián)',
  cb66e2e1e4c5c9d7dea16867ca8264e8: '0126 (vuelta delegada)',
};
const H0127 = 'cfd8c22d60b87b40561568fdb6073cbc';
const huellaFn = async () => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE proname = 'detect_late_bookings'`)).h;
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(i)::text, ',' ORDER BY id), '')) FROM public.incidents i) eventualidades,
    (SELECT md5(coalesce(string_agg(to_jsonb(o)::text, ',' ORDER BY id), '')) FROM public.notification_outbox o) avisos,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas`);
const pasadaDeshecha = async () => {
  await c.query('SAVEPOINT pasada');
  try {
    const n = (await one(`SELECT public.detect_late_bookings() n`)).n;
    const hay = (await one(`SELECT to_regclass('public.late_booking_candidates') IS NOT NULL ok`)).ok;
    const anot = hay ? (await one(`SELECT count(*)::int n FROM public.late_booking_candidates`)).n : null;
    return { abre: n, anota: anot };
  } finally { await c.query('ROLLBACK TO SAVEPOINT pasada'); }
};

try {
  // REPEATABLE READ: todas las comparaciones ven la misma foto de la base, aunque
  // en ese momento alguien pida un traslado o salga un push.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const hoy = await huellaFn();
  if (hoy === H0127) console.log('  · el detector YA es el de 0127: se vuelve a correr (es idempotente).');
  else t(`el detector de hoy es una versión conocida: ${CONOCIDAS[hoy] || hoy}`, !!CONOCIDAS[hoy], hoy);
  if (fallas.length) throw new Error('detect_late_bookings no es ninguna de las versiones conocidas: mirar quién la cambió antes de aplicar');

  const ahora = await pasadaDeshecha();
  console.log(`  · el detector de hoy, si corriera ahora: abriría ${ahora.abre} eventualidad(es)`);

  const antes = await huella();
  const job0 = (await one(`SELECT command FROM cron.job WHERE jobname = 'detect-ops-events'`))?.command || null;
  await c.query(readFileSync(new URL('../supabase/migrations/0127_aviso_sin_carro_espera.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  t('el detector quedó en la versión de 0127', (await huellaFn()) === H0127, await huellaFn());
  const o = await one(`SELECT to_regclass('public.late_booking_candidates') IS NOT NULL tabla,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_late_booking_reset' AND tgrelid = 'public.route_stops'::regclass) disp,
      has_table_privilege('authenticated', 'public.late_booking_candidates', 'SELECT') leer_auth,
      has_function_privilege('authenticated', 'public.detect_late_bookings()', 'EXECUTE') correr_auth,
      has_function_privilege('anon', 'public.detect_late_bookings()', 'EXECUTE') correr_anon`);
  t('la tabla de anotaciones y el disparador de route_stops quedaron; la app no los toca', o.tabla && o.disp === 1 && !o.leer_auth && !o.correr_auth && !o.correr_anon, o);
  const job1 = (await one(`SELECT command FROM cron.job WHERE jobname = 'detect-ops-events'`))?.command || null;
  t('el reloj de 5 min no cambió', job0 === job1 && /detect_late_bookings/.test(job1 || ''), { job0, job1 });
  const durante = await huella();
  t('aplicar no movió nada: eventualidades, avisos, paradas, reservas y vueltas idénticas', JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });

  const primera = await pasadaDeshecha();
  console.log(`  · primera pasada con 0127 (se deshace): anota ${primera.anota} reserva(s) sin carro`);
  t('la primera pasada no avisa a nadie (las anotadas avisan en la siguiente si siguen sin carro)', primera.abre === 0, primera);
  t('después de deshacer la pasada, todo como recién aplicada', JSON.stringify(durante) === JSON.stringify(await huella()));

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
