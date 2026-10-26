// 0129 · Cambiar el conductor de UNA vuelta publicada, sin re-publicar el día.
//
//   LOCAL:  node scripts/_aplicar-0129.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0129.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0129.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0124 (disparador de la placa), 0125 (route_sync_assigned,
// hm_bog, short_name) y 0126 (delegated_at): la RPC las usa.
// Después comprueba que aplicar no mueve nada: paradas, reservas, vueltas y avisos
// idénticos (la RPC solo actúa cuando un jefe la llama).
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
console.log(aplicar ? `\n== APLICANDO 0129 en ${amb} ==` : `\n== 0129 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0129_conductor_de_una_vuelta.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_route_assignments_vehicle_from_shift') t0124,
      to_regprocedure('public.route_sync_assigned(uuid)') IS NOT NULL AND to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL f0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='delegated_at') c0126,
      to_regprocedure('public.admin_route_set_driver(uuid,uuid)') IS NOT NULL ya`);
  t('0124 aplicada (la placa sale del turno)', base.t0124);
  t('0125 aplicada (route_sync_assigned, hm_bog)', base.f0125);
  t('0126 aplicada (delegated_at)', base.c0126);
  if (base.ya) console.log('  · la función ya existía: se reemplaza (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT to_regprocedure('public.admin_route_set_driver(uuid,uuid)') IS NOT NULL f,
      has_function_privilege('authenticated', 'public.admin_route_set_driver(uuid,uuid)', 'EXECUTE') app,
      has_function_privilege('anon', 'public.admin_route_set_driver(uuid,uuid)', 'EXECUTE') anon`);
  t('la función quedó, para la app (authenticated) y no para anónimos', ok.f && ok.app && !ok.anon, ok);

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0129 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
