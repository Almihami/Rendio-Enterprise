// 0113 · Coordinación por conversaciones + nombre del jefe, contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0113.mjs            (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0113.mjs --aplicar
//
// Comprueba, dentro de la transacción, que ningún mensaje quede sin
// conversación, que nadie quede con dos abiertas y que el número de mensajes no
// cambie. En seco deshace todo. Solo dev; producción se decide aparte, con su OK.
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
console.log(aplicar ? '\n== APLICANDO 0113 en dev ==' : '\n== 0113 EN SECO contra dev (se deshace) ==');
let bien = false;
try {
  const m0 = (await q(`SELECT count(*)::int n FROM public.crew_messages`))[0].n;
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0113_conversaciones_coordinacion.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  const m1 = (await q(`SELECT count(*)::int n FROM public.crew_messages`))[0].n;
  const sin = (await q(`SELECT count(*)::int n FROM public.crew_messages WHERE conversation_id IS NULL`))[0].n;
  const dobles = (await q(`SELECT count(*)::int n FROM (SELECT auxiliar_profile_id FROM public.crew_conversations
                             WHERE closed_at IS NULL GROUP BY 1 HAVING count(*) > 1) x`))[0].n;
  const conv = (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE public.crew_conv_is_open(closed_at, last_message_at))::int abiertas
                          FROM public.crew_conversations`))[0];
  bien = m0 === m1 && sin === 0 && dobles === 0;
  console.log(`  mensajes: ${m0} → ${m1} · sin conversación: ${sin} · conversaciones: ${conv.n} (abiertas ahora: ${conv.abiertas})`);
  console.log(`  ${m0 === m1 ? '✓' : '✗'} no se perdió ni se creó ningún mensaje`);
  console.log(`  ${sin === 0 ? '✓' : '✗'} todos los mensajes quedaron en una conversación`);
  console.log(`  ${dobles === 0 ? '✓' : '✗'} nadie quedó con dos abiertas`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: dev quedó exactamente igual.');
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('  ✗ ERROR:', e.message, '\n  ROLLBACK: dev quedó exactamente igual.');
} finally {
  await c.end();
}
process.exit(bien ? 0 : 1);
