// 0130 · El corte de pedidos de las 7:40 p. m. y el aviso del Excel.
//
//   LOCAL:  node scripts/_aplicar-0130.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0130.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0130.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0097 (trip_notify), 0107 (route_night_cutoff_min) y
// 0117 (ops_alert_recipients_of). Después comprueba que aplicar no mueve nada
// (paradas, reservas, vueltas y avisos idénticos), que el corte quedó en 7:40 p. m.,
// que el reloj quedó cada 5 min y CUENTA (sin avisar) cuántos pedidos saldrían
// hoy en el Excel de mañana. OJO: con --aplicar, el reloj empieza a correr; si se
// aplica pasadas las 7:40 p. m. (y antes de las 9:40 p. m.) el aviso sale hoy.
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
console.log(aplicar ? `\n== APLICANDO 0130 en ${amb} ==` : `\n== 0130 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0130_corte_de_pedidos.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      to_regprocedure('public.trip_notify(uuid,text,text,text,text)') IS NOT NULL f0097,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='route_night_cutoff_min') c0107,
      to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL f0117,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='crew_request_cutoff_min') ya`);
  t('0097 aplicada (trip_notify)', base.f0097);
  t('0107 aplicada (corte de la madrugada)', base.c0107);
  t('0117 aplicada (ops_alert_recipients_of)', base.f0117);
  if (base.ya) console.log('  · la columna del corte ya existía: se conserva su valor (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT (SELECT crew_request_cutoff_min FROM public.app_settings WHERE id = 'singleton') corte,
      to_regprocedure('public.excel_cutoff_alerts(timestamptz)') IS NOT NULL f,
      has_function_privilege('authenticated', 'public.excel_cutoff_alerts(timestamptz)', 'EXECUTE') app,
      to_regclass('cron.job') IS NOT NULL hay_cron`);
  t('el corte quedó (7:40 p. m. = 1180, o el que ya tenía)', ok.corte != null, ok);
  t('el aviso existe y la app no lo puede disparar', ok.f && !ok.app, ok);
  if (ok.hay_cron) t('el reloj «excel-cutoff-alerts» quedó cada 5 min', !!(await one(`SELECT 1 x FROM cron.job WHERE jobname = 'excel-cutoff-alerts' AND schedule = '*/5 * * * *'`)));
  const pre = await q(`SELECT o.name, count(*)::int n
      FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id JOIN public.organizations o ON o.id = pr.organization_id
     WHERE r.cancelled_at IS NULL
       AND ((r.required_arrival_at AT TIME ZONE 'America/Bogota') - make_interval(mins => coalesce((SELECT route_night_cutoff_min FROM public.app_settings WHERE id = 'singleton'), 120)))::date
           = (now() AT TIME ZONE 'America/Bogota')::date + 1
       AND r.created_at <= least(public.crew_request_deadline(r.required_arrival_at), now())
     GROUP BY o.name`);
  console.log('  · el Excel de mañana tendría hoy:', pre.length ? pre.map((p) => `${p.name}: ${p.n} pedidos`).join(' · ') : 'nada (ningún pedido para mañana)');

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0130 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
