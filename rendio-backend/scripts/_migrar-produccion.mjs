// APLICADOR DE MIGRACIONES A PRODUCCIÓN.
//
// Por defecto ENSAYA: corre todo dentro de una transacción y hace ROLLBACK.
// Solo aplica de verdad con --aplicar, y aun así en UNA transacción: o entran
// todas o no entra ninguna. Nunca deja la base a medias.
//
//   node scripts/_migrar-produccion.mjs            → ensayo (rollback)
//   node scripts/_migrar-produccion.mjs --aplicar  → de verdad (commit)
//
// El registro supabase_migrations.schema_migrations de este proyecto está
// desactualizado (dice 0039 con objetos de 0040+ ya creados), así que no se
// consulta: se confía en la idempotencia de los propios archivos
// (IF NOT EXISTS / CREATE OR REPLACE) y en que el ensayo delate lo que falle.
import pg from 'pg';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: no es producción'); process.exit(2); }
const APLICAR = process.argv.includes('--aplicar');
const DESDE = (process.argv.find(a => a.startsWith('--desde=')) || '--desde=0040').split('=')[1];
const HASTA = (process.argv.find(a => a.startsWith('--hasta=')) || '--hasta=9999').split('=')[1];

const DIR = new URL('../supabase/migrations/', import.meta.url).pathname;
const archivos = readdirSync(DIR).filter(f => f.endsWith('.sql') && f >= DESDE && f <= HASTA + 'zz').sort();

const c = new pg.Client({ host: 'aws-1-us-west-2.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();

console.log(`${APLICAR ? '⚠  APLICANDO DE VERDAD' : '🧪 ENSAYO (todo se deshace al final)'} · ${archivos.length} archivos\n`);
const bien = [], mal = [];
await c.query('BEGIN');
for (const f of archivos) {
  // El BEGIN/COMMIT de cada archivo se quita: van todos dentro de LA transacción.
  const sql = readFileSync(DIR + f, 'utf8')
    .replace(/^\s*BEGIN\s*;\s*$/gmi, '').replace(/^\s*COMMIT\s*;\s*$/gmi, '');
  await c.query('SAVEPOINT sp');
  try {
    await c.query(sql);
    await c.query('RELEASE SAVEPOINT sp');
    bien.push(f); console.log(`  ✓ ${f}`);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp');
    mal.push({ f, err: e.message, detalle: e.detail || '', hint: e.hint || '' });
    console.log(`  ✗ ${f}\n      ${e.message.slice(0, 170)}`);
    if (e.hint) console.log(`      pista: ${e.hint.slice(0, 120)}`);
  }
}
const fin = (APLICAR && !mal.length) ? 'COMMIT' : 'ROLLBACK';
await c.query(fin);
await c.end();

console.log(`\n${bien.length}/${archivos.length} corrieron · ${mal.length} fallaron`);
console.log(fin === 'COMMIT' ? '\n✅ APLICADO Y CONFIRMADO EN PRODUCCIÓN.'
  : APLICAR ? '\n⛔ NO se aplicó nada: hubo fallos y se deshizo todo.' : '\n↩  Ensayo deshecho: producción quedó igual.');
writeFileSync(new URL('./_migrar-produccion.ultimo.json', import.meta.url).pathname,
  JSON.stringify({ aplicar: APLICAR, resultado: fin, bien, mal }, null, 1));
process.exit(mal.length ? 1 : 0);
