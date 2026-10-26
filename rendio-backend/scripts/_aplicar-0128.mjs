// 0128 · Aviso a los jefes cuando un conductor termina una vuelta.
//
//   LOCAL:  node scripts/_aplicar-0128.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0128.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0128.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0117 (ops_alert_recipients_of) y 0125 (hm_bog,
// short_name, route_assignments.organization_id): la función del aviso las usa.
// Después comprueba que aplicar no mueve nada: paradas, reservas, vueltas y avisos
// idénticos (el disparador solo actúa cuando ALGUIEN marca una parada después).
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
console.log(aplicar ? `\n== APLICANDO 0128 en ${amb} ==` : `\n== 0128 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0128_aviso_vuelta_terminada.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL r0117,
      to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL AND to_regprocedure('public.short_name(text)') IS NOT NULL f0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='organization_id') c0125,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_finished_alert') ya`);
  t('0117 aplicada (ops_alert_recipients_of)', base.r0117);
  t('0125 aplicada (hm_bog, short_name, organization_id)', base.f0125 && base.c0125);
  if (base.ya) console.log('  · el disparador ya existía: se reemplaza (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_finished_alert' AND tgrelid = 'public.route_stops'::regclass) t,
      has_function_privilege('authenticated', 'public.route_finished_alert()', 'EXECUTE') app`);
  t('el disparador quedó en route_stops', ok.t === 1, ok);
  t('la app no puede llamar la función', ok.app === false, ok);
  const jefes = await q(`SELECT o.name, count(r.*)::int n FROM public.organizations o LEFT JOIN LATERAL public.ops_alert_recipients_of(o.id) r ON true GROUP BY o.name ORDER BY 2 DESC`);
  console.log('  · a quiénes les llegaría por organización:', jefes.map((j) => `${j.name}: ${j.n}`).join(' · '));

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0128 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
