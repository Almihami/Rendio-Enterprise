// 0132 · El carro del plan («Carro 1 = PRW443») y el aviso si el conductor sale en otro.
//
//   LOCAL:  node scripts/_aplicar-0132.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0132.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0132.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0117 (ops_alert_recipients_of), 0124 (el carro del
// turno) y 0125 (short_name). Después comprueba que aplicar no mueve nada (paradas,
// reservas, vueltas y avisos idénticos; la columna nueva arranca vacía) y que el
// disparador quedó en shifts. No dispara avisos: solo actúa cuando un turno se
// abre o cambia de carro DESPUÉS.
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
console.log(aplicar ? `\n== APLICANDO 0132 en ${amb} ==` : `\n== 0132 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0132_carro_del_plan.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) - 'plan_vehicle_id')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL r0117,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_shifts_vehicle_to_routes') t0124,
      to_regprocedure('public.short_name(text)') IS NOT NULL f0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_vehicle_id') ya`);
  t('0117 aplicada (ops_alert_recipients_of)', base.r0117);
  t('0124 aplicada (el carro sale del turno)', base.t0124);
  t('0125 aplicada (short_name)', base.f0125);
  if (base.ya) console.log('  · la columna ya existía: se conserva (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_shifts_plan_vehicle_alert' AND tgrelid = 'public.shifts'::regclass) t,
      has_function_privilege('authenticated', 'public.shifts_plan_vehicle_alert()', 'EXECUTE') app`);
  t('el disparador quedó en shifts', ok.t === 1, ok);
  t('la app no puede llamar la función', ok.app === false, ok);

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0132 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
