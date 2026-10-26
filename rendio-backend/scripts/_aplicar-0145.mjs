// 0145 · «Cambiar hora» en UNA vuelta de la ruta de Julián (admin_manual_route_set_times).
//
//   LOCAL:  node scripts/_aplicar-0145.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0145.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0145.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que están 0097 (trip_notify, trip_kick), 0121 (reserve_place), 0125
// (pool, organization_id, deadline_at, hm_bog), 0126 (sync_calculated_pickup) y 0133
// (guest_name); y que hm_bog ya dice «0:10» (0135). Después comprueba que aplicar no
// mueve nada: paradas, reservas, vueltas y avisos idénticos (la función solo actúa
// cuando un jefe toca «Guardar y avisar»), y quién la puede llamar.
// La app que la llama es la v226: aplicar esto ANTES de publicar la app (si la app
// llega primero, «Cambiar hora» dice que falta la actualización 0145).
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
console.log(aplicar ? `\n== APLICANDO 0145 en ${amb} ==` : `\n== 0145 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0145_cambiar_hora_pegada.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);
const FN = 'public.admin_manual_route_set_times(uuid,jsonb,timestamptz,timestamptz)';

try {
  await c.query('BEGIN');
  const base = await one(`SELECT
      to_regprocedure('public.trip_notify(uuid,text,text,text,text)') IS NOT NULL AND to_regprocedure('public.trip_kick()') IS NOT NULL r0097,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='reserve_place') c0121,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name IN ('pool','organization_id','deadline_at')) = 3 c0125,
      to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL f0125,
      to_regprocedure('public.sync_calculated_pickup(uuid)') IS NOT NULL f0126,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='guest_name') c0133,
      to_regprocedure('${FN}') IS NOT NULL ya`);
  t('0097 aplicada (trip_notify, trip_kick)', base.r0097);
  t('0121 aplicada (reservations.reserve_place)', base.c0121);
  t('0125 aplicada (pool, organization_id, deadline_at, hm_bog)', base.c0125 && base.f0125);
  t('0126 aplicada (sync_calculated_pickup)', base.f0126);
  t('0133 aplicada (route_stops.guest_name)', base.c0133);
  if (base.f0125) {
    const h = await one(`SELECT public.hm_bog('2026-10-26T00:10:00-05:00'::timestamptz) h`);
    t('hm_bog ya dice «0:10» (0135)', h.h === '0:10', h.h);
  }
  if (base.ya) console.log('  · la función ya existía: se reemplaza (la migración es idempotente)');
  if (fallas.length) throw new Error('faltan migraciones previas');

  const antes = await huella();
  await c.query(sql);
  const despues = await huella();
  t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
  const ok = await one(`SELECT to_regprocedure('${FN}') IS NOT NULL existe,
      has_function_privilege('authenticated', '${FN}', 'EXECUTE') auth,
      has_function_privilege('anon', '${FN}', 'EXECUTE') anon,
      (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('${FN}')) definer`);
  t('la función quedó (SECURITY DEFINER)', ok.existe === true && ok.definer === true, ok);
  t('la app la llama con sesión (authenticated sí, anon no)', ok.auth === true && ok.anon === false, ok);
  const hoy = await one(`SELECT count(*)::int n,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.status <> 'pending'))::int movibles
    FROM public.route_assignments ra
   WHERE ra.pool AND ra.status IN ('draft', 'planned')
     AND ra.manual_day >= (now() AT TIME ZONE 'America/Bogota')::date`);
  console.log(`  · vueltas pegadas de hoy en adelante: ${hoy.n} · ${hoy.movibles} sin arrancar (a esas les sale «Cambiar hora»)`);

  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0145 APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
