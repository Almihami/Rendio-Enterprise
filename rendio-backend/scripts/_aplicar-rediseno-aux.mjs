// Migraciones del rediseño del tripulante (0083, 0085–0091) contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-rediseno-aux.mjs --seco
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-rediseno-aux.mjs --aplicar
//
// --seco (por defecto): corre TODAS en una sola transacción y la DESHACE. Dev
//   queda igual; sirve para saber que aplican limpias sobre el esquema real.
// --aplicar: aplica cada archivo tal cual (cada uno trae su BEGIN/COMMIT), en
//   orden, y se detiene en la primera que falle. Las que ya pasaron quedan.
//
// Solo acepta el proyecto de dev (lxlphbafhtphulanhzlp). Producción NO: eso se
// decide aparte, con su propio OK. La 0084 (ruta en curso) está pausada a
// propósito y no va aquí.
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
  '0083_pin_manual_sin_conjunto.sql',
  '0085_hora_de_recogida_publicada.sql',
  '0086_aux_datos_del_viaje.sql',
  '0087_aux_mis_viajes.sql',
  '0088_coordinacion.sql',
  '0089_cambio_de_vuelo.sql',
  '0090_facturario.sql',
  '0091_rendio_points.sql',
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
