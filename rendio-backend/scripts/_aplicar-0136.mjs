// 0136 · Aviso a los jefes cuando un conductor inicia una vuelta.
//
//   LOCAL:  node scripts/_aplicar-0136.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0136.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0136.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0097 (trip_kick), 0117 (ops_alert_recipients_of), 0125
// (hm_bog, short_name, route_assignments.organization_id) y 0133 (guest_name): la
// función del aviso las usa. Después comprueba que aplicar no mueve nada: paradas,
// reservas, vueltas y avisos idénticos (el disparador solo actúa cuando ALGUIEN
// marca una parada después, y la RPC cuando un conductor toca «Iniciar ruta»).
// La app que la llama es la v222: aplicar esto ANTES de publicar la app (si la app
// llega primero, la llamada falla callada y no hay aviso de inicio hasta aplicarla).
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
console.log(aplicar ? `\n== APLICANDO 0136 en ${amb} ==` : `\n== 0136 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0136_aviso_vuelta_iniciada.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      to_regprocedure('public.trip_kick()') IS NOT NULL r0097,
      to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL r0117,
      to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL AND to_regprocedure('public.short_name(text)') IS NOT NULL f0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='organization_id') c0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='guest_name') c0133,
      to_regprocedure('public.route_finished_alert()') IS NOT NULL r0128,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_started_alert') ya`);
  t('0097 aplicada (trip_kick)', base.r0097);
  t('0117 aplicada (ops_alert_recipients_of)', base.r0117);
  t('0125 aplicada (hm_bog, short_name, organization_id)', base.f0125 && base.c0125);
  t('0133 aplicada (route_stops.guest_name)', base.c0133);
  if (!base.r0128) console.log('  · ojo: 0128 («terminó una vuelta») no está; 0136 no la necesita, pero los jefes recibirían solo el inicio');
  if (base.ya) console.log('  · el disparador ya existía: se reemplaza (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_started_alert' AND tgrelid = 'public.route_stops'::regclass) t,
      has_function_privilege('authenticated', 'public.driver_route_started(uuid)', 'EXECUTE') rpc,
      has_function_privilege('anon', 'public.driver_route_started(uuid)', 'EXECUTE') rpc_anon,
      has_function_privilege('authenticated', 'public.route_started_alert_enqueue(uuid,uuid)', 'EXECUTE') enq,
      has_function_privilege('authenticated', 'public.route_started_alert()', 'EXECUTE') trg`);
  t('el disparador quedó en route_stops', ok.t === 1, ok);
  t('la app llama driver_route_started (anon no)', ok.rpc === true && ok.rpc_anon === false, ok);
  t('la app no puede llamar las funciones que arman el aviso', ok.enq === false && ok.trg === false, ok);
  const jefes = await q(`SELECT o.name, count(r.*)::int n FROM public.organizations o LEFT JOIN LATERAL public.ops_alert_recipients_of(o.id) r ON true GROUP BY o.name ORDER BY 2 DESC`);
  console.log('  · a quiénes les llegaría por organización:', jefes.map((j) => `${j.name}: ${j.n}`).join(' · '));
  const hoy = await one(`SELECT
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.status <> 'pending'))::int sin_arrancar,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.status IN ('picked_up', 'delivered', 'no_show')))::int a_medias
    FROM public.route_assignments ra
   WHERE ra.status IN ('planned', 'in_progress')
     AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date`);
  console.log(`  · vueltas de hoy: ${hoy.sin_arrancar} sin arrancar (avisarán al iniciar) · ${hoy.a_medias} ya con alguien a bordo o entregado (no avisarán)`);

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0136 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
