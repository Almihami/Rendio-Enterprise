// Migraciones de los pedidos del 29/30-sep (0092–0095) contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-pedidos-0929.mjs --seco
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-pedidos-0929.mjs --aplicar
//
// --seco (por defecto): corre TODAS en una sola transacción y la DESHACE. Dev
//   queda igual; sirve para saber que aplican limpias sobre el esquema real.
// --aplicar: aplica cada archivo tal cual (cada uno trae su BEGIN/COMMIT), en
//   orden, y se detiene en la primera que falle. Las que ya pasaron quedan.
//
// Solo acepta el proyecto de dev (lxlphbafhtphulanhzlp). Producción NO: eso se
// decide aparte, con su propio OK. Requiere 0083 y 0085–0091 ya aplicadas
// (_aplicar-rediseno-aux.mjs).
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
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const ARCHIVOS = [
  '0092_trabajo_en_tierra.sql',
  '0093_orden_de_recogida.sql',
  '0094_tarifas_sector_vacaciones.sql',
  '0095_documentos_del_carro.sql',
];

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
c.on('notice', (n) => console.log('    NOTICE: ' + n.message));
console.log(aplicar ? '\n== APLICANDO en dev ==' : '\n== EN SECO contra dev (todo se deshace al final) ==');

let ok = 0;
try {
  if (!aplicar) await c.query('BEGIN');
  for (const f of ARCHIVOS) {
    let sql = readFileSync(join(DIR, f), 'utf8');
    if (!aplicar) sql = sql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
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
console.log(`\n${ok}/${ARCHIVOS.length} ${aplicar ? 'aplicadas' : 'aplican limpias'}`);
process.exit(ok === ARCHIVOS.length ? 0 : 1);
