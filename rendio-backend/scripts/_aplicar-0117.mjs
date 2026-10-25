// 0117 · Avisos a los jefes desde el servidor + candado de send-push, contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0117.mjs            (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0117.mjs --aplicar
//
// 0117 crea funciones y un disparador; NO toca filas: dentro de la transacción se
// comprueba que incidents, notification_outbox, reservations y route_stops quedan
// idénticos (el disparador solo actúa en lo que se reporte de aquí en adelante).
// En seco deshace todo. Solo dev; producción va con
// _migrar-produccion.mjs --desde=0117 --hasta=0117, con su OK.
//
// OJO, orden: después de aplicar hay que desplegar send-push (la de 0117 le
// pregunta a push_allowed_recipients) y recién ahí subir la app.
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
console.log(aplicar ? '\n== APLICANDO 0117 en dev ==' : '\n== 0117 EN SECO contra dev (se deshace) ==');
const foto = async () => (await q(`SELECT
    (SELECT count(*) FROM public.incidents)::int incidents,
    (SELECT count(*) FROM public.notification_outbox)::int outbox,
    (SELECT count(*) FROM public.reservations)::int reservas,
    (SELECT count(*) FROM public.route_stops)::int paradas,
    (SELECT md5(coalesce(string_agg(id::text || coalesce(notified_at::text, ''), ',' ORDER BY id), '')) FROM public.incidents) firma_inc,
    (SELECT md5(coalesce(string_agg(id::text || coalesce(sent_at::text, '') || attempts, ',' ORDER BY id), '')) FROM public.notification_outbox) firma_out`))[0];
let bien = false;
try {
  await c.query('BEGIN');
  const antes = await foto();
  await c.query(readFileSync(new URL('../supabase/migrations/0117_avisos_desde_el_servidor.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  const obj = (await q(`SELECT
      to_regprocedure('public.push_allowed_recipients(uuid[])') IS NOT NULL f1,
      to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL f2,
      to_regprocedure('public.incidents_avisar_jefes()') IS NOT NULL f3,
      (SELECT count(*) FROM pg_trigger WHERE tgname = 'tr_incidents_avisar_jefes'
         AND tgrelid = 'public.incidents'::regclass AND tgenabled = 'O')::int disparador,
      has_function_privilege('authenticated', 'public.enqueue_incident_alert(uuid)', 'EXECUTE') enq_auth,
      has_function_privilege('anon', 'public.enqueue_incident_alert(uuid)', 'EXECUTE') enq_anon,
      has_function_privilege('authenticated', 'public.push_allowed_recipients(uuid[])', 'EXECUTE') pa_auth,
      has_function_privilege('anon', 'public.push_allowed_recipients(uuid[])', 'EXECUTE') pa_anon,
      (SELECT count(*) FROM public.ops_alert_recipients_of((SELECT id FROM public.organizations ORDER BY created_at LIMIT 1)))::int jefes`))[0];
  const despues = await foto();
  const igual = JSON.stringify(antes) === JSON.stringify(despues);
  const ok1 = obj.f1 && obj.f2 && obj.f3 && obj.disparador === 1;
  const ok2 = !obj.enq_auth && !obj.enq_anon && obj.pa_auth && !obj.pa_anon;
  bien = ok1 && ok2 && igual;
  console.log(`  ${ok1 ? '✓' : '✗'} las 3 funciones y el disparador quedaron (prendido)`);
  console.log(`  ${ok2 ? '✓' : '✗'} permisos: nadie de la app encola avisos; push_allowed_recipients solo con sesión`);
  console.log(`  ${igual ? '✓' : '✗'} no se movió ninguna fila (${antes.incidents} eventualidades, ${antes.outbox} avisos en la bandeja)`);
  console.log(`  · jefes que recibirían una eventualidad hoy: ${obj.jefes}`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: dev quedó exactamente igual.');
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('  ✗ ERROR:', e.message, '\n  ROLLBACK: dev quedó exactamente igual.');
} finally {
  await c.end();
}
process.exit(bien ? 0 : 1);
