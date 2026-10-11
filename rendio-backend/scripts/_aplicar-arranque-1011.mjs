// Migraciones del arranque con tripulantes (11-oct-2026: 0096–0100) contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-arranque-1011.mjs --seco
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-arranque-1011.mjs --aplicar
//
// --seco (por defecto): corre TODAS en una sola transacción y la DESHACE. Dev
//   queda igual; sirve para saber que aplican limpias sobre el esquema real.
// --aplicar: aplica cada archivo tal cual (cada uno trae su BEGIN/COMMIT), en
//   orden, y se detiene en la primera que falle. Las que ya pasaron quedan.
//
// Solo acepta el proyecto de dev (lxlphbafhtphulanhzlp). Producción NO: eso se
// decide aparte, con su propio OK. Requiere 0083 y 0085–0091 ya aplicadas
// (_aplicar-rediseno-aux.mjs) y 0092–0095 (_aplicar-pedidos-0929.mjs).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== DEV_REF || !(process.env.SUPABASE_URL || '').includes(DEV_REF)) {
  console.error('ABORT: este script solo trabaja contra dev (' + DEV_REF + '). Cargó: ' + (ref || '(nada)'));
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
// --solo=0097,0100 : solo esas (para probar por partes).
const SOLO = (process.argv.find(a => a.startsWith('--solo=')) || '').slice(7).split(',').filter(Boolean);
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const ARCHIVOS = [
  '0096_retencion_fotos.sql',
  '0097_avisos_del_traslado.sql',
  '0098_telefono_propio.sql',
  '0099_vuelos.sql',
  '0100_recordatorio_libres.sql',
];

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
c.on('notice', (n) => console.log('    NOTICE: ' + n.message));
console.log(aplicar ? '\n== APLICANDO en dev ==' : '\n== EN SECO contra dev (todo se deshace al final) ==');

let ok = 0;
try {
  if (!aplicar) await c.query('BEGIN');
  for (const f of ARCHIVOS.filter(f => !SOLO.length || SOLO.some(n => f.startsWith(n)))) {
    let sql = readFileSync(join(DIR, f), 'utf8');
    // En seco se quitan el BEGIN; y el COMMIT; propios del archivo (en mayúscula
    // o minúscula: la 0098 los trae en minúscula y su commit; cerraba la
    // transacción de la prueba, o sea que la «prueba» aplicaba de verdad).
    if (!aplicar) sql = sql.replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
    if (!aplicar && /^\s*(BEGIN|COMMIT|END)\s*;/mi.test(sql.replace(/\$\$[\s\S]*?\$\$/g, ''))) throw new Error(f + ': quedó un BEGIN/COMMIT fuera de una función; en seco no se puede garantizar el ROLLBACK');
    if (!aplicar) await c.query('SAVEPOINT paso');
    try {
      await c.query(sql);
      ok++; console.log('  ✓ ' + f);
    } catch (e) {
      console.log('  ✗ ' + f + ' → ' + e.message + (e.position ? ' (posición ' + e.position + ')' : ''));
      if (!aplicar) await c.query('ROLLBACK TO SAVEPOINT paso');
      throw e;
    }
  }
} catch (_) {
  /* ya se informó */
} finally {
  if (!aplicar) { await c.query('ROLLBACK'); console.log('  ROLLBACK: dev quedó exactamente igual.'); }
  await c.end();
}
const TOTAL = ARCHIVOS.filter(f => !SOLO.length || SOLO.some(n => f.startsWith(n))).length;
console.log(`\n${ok}/${TOTAL} ${aplicar ? 'aplicadas' : 'aplican limpias'}`);
process.exit(ok === TOTAL ? 0 : 1);
