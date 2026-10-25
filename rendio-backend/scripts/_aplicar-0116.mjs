// 0116 · Tiempos aprendidos de los viajes reales, contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0116.mjs            (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0116.mjs --aplicar
//
// 0116 crea dos tablas nuevas, unas funciones y el reloj «collect-trip-legs», y
// mide de una vez las marcas que ya existan. NO cambia ninguna marca del
// conductor ni ninguna ruta: dentro de la transacción se comprueba que
// route_stops y route_assignments quedan idénticos. En seco deshace todo. Solo
// dev; producción va con _migrar-produccion.mjs --desde=0116 --hasta=0116, con su OK.
//
// Después de aplicar, revisar que el reloj de verdad corre (en producción ya pasó
// que unos pg_cron nuevos nunca arrancaron): este script lo dice al final.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== DEV_REF || !(process.env.SUPABASE_URL || '').includes(DEV_REF)) {
  console.error('ABORT: este script solo trabaja contra dev (' + DEV_REF + '). Cargó: ' + (ref || '(nada)'));
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s) => (await c.query(s)).rows;
console.log(aplicar ? '\n== APLICANDO 0116 en dev ==' : '\n== 0116 EN SECO contra dev (se deshace) ==');
const foto = async () => (await q(`SELECT
    (SELECT count(*) FROM public.route_stops)::int stops,
    (SELECT count(*) FROM public.route_assignments)::int ras,
    (SELECT md5(string_agg(id::text || coalesce(actual_arrival_at::text, '') || coalesce(actual_pickup_at::text, '')
                           || coalesce(actual_dropoff_at::text, '') || status, ',' ORDER BY id)) FROM public.route_stops) firma`))[0];
let bien = false;
try {
  const antes = await foto();
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0116_tiempos_aprendidos.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  const obj = (await q(`SELECT
      to_regclass('public.route_trip_legs') IS NOT NULL t1,
      to_regclass('public.route_trip_legs_runs') IS NOT NULL t2,
      to_regprocedure('public.collect_trip_legs(timestamptz)') IS NOT NULL f1,
      to_regprocedure('public.admin_learned_times(integer,integer)') IS NOT NULL f2,
      to_regprocedure('public.admin_collect_trip_legs()') IS NOT NULL f3,
      has_function_privilege('authenticated', 'public.collect_trip_legs(timestamptz)', 'EXECUTE') auth_interna,
      has_function_privilege('anon', 'public.admin_learned_times(integer,integer)', 'EXECUTE') anon_ver,
      (SELECT count(*) FROM cron.job WHERE jobname = 'collect-trip-legs' AND schedule = '7 * * * *')::int reloj,
      (SELECT count(*) FROM public.route_trip_legs)::int tramos,
      (SELECT count(*) FROM public.route_trip_legs WHERE quality = 'dudosa')::int dudosos`))[0];
  const despues = await foto();
  const igual = JSON.stringify(antes) === JSON.stringify(despues);
  const ok1 = obj.t1 && obj.t2 && obj.f1 && obj.f2 && obj.f3, ok2 = !obj.auth_interna && !obj.anon_ver, ok3 = obj.reloj === 1;
  bien = ok1 && ok2 && ok3 && igual;
  console.log(`  ${ok1 ? '✓' : '✗'} las 2 tablas y las funciones quedaron`);
  console.log(`  ${ok2 ? '✓' : '✗'} permisos: la medición interna no la llama la app; anon no ve la pantalla`);
  console.log(`  ${ok3 ? '✓' : '✗'} el reloj «collect-trip-legs» quedó (cada hora, minuto 7)`);
  console.log(`  ${igual ? '✓' : '✗'} no se movió ninguna marca ni ruta (${antes.stops} paradas, ${antes.ras} vueltas)`);
  console.log(`  · medido de una vez lo que ya había: ${obj.tramos} tramos (${obj.dudosos} dudosos)`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: dev quedó exactamente igual.');
  if (aplicar && bien) {
    const j = (await q(`SELECT jobid, active FROM cron.job WHERE jobname = 'collect-trip-legs'`))[0];
    console.log(`  · reloj: jobid ${j && j.jobid}, activo ${j && j.active}. Revisar en una hora que corrió:`);
    console.log(`    SELECT status, start_time FROM cron.job_run_details WHERE jobid = ${j && j.jobid} ORDER BY start_time DESC LIMIT 3;`);
  }
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('  ✗ ERROR:', e.message, '\n  ROLLBACK: dev quedó exactamente igual.');
} finally {
  await c.end();
}
process.exit(bien ? 0 : 1);
