// 0111 · vacía los rótulos viejos de sector de los conjuntos, contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0111.mjs            (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0111.mjs --aplicar
//
// Comprueba que la MENSUALIDAD de cada tripulante no cambie (el rótulo era el
// último recurso del cobro y ninguna tarifa lo usa) y que no quede ningún rótulo.
// Solo dev; producción se decide aparte, con su propio OK.
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
const mensualidades = async () => JSON.stringify(await q(`SELECT ap.id, rt.monthly FROM public.auxiliar_profiles ap
  LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true ORDER BY ap.id`));
console.log(aplicar ? '\n== APLICANDO 0111 en dev ==' : '\n== 0111 EN SECO contra dev (se deshace) ==');
let bien = false;
try {
  const antes = await mensualidades();
  const n0 = (await q(`SELECT count(*)::int n FROM public.residences WHERE sector IS NOT NULL`))[0].n;
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0111_sin_rotulos_de_sector.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  const n1 = (await q(`SELECT count(*)::int n FROM public.residences WHERE sector IS NOT NULL`))[0].n;
  const despues = await mensualidades();
  bien = n1 === 0 && antes === despues;
  console.log(`  rótulos: ${n0} → ${n1}`);
  console.log(`  ${antes === despues ? '✓' : '✗'} la mensualidad de cada tripulante quedó igual`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: dev quedó exactamente igual.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('  ✗ ' + e.message);
} finally { await c.end(); }
process.exit(bien ? 0 : 1);
