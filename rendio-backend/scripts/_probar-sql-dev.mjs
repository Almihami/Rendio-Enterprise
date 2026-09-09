// PRUEBA EN SECO de una migración contra dev: la corre entera y hace ROLLBACK.
// Valida sintaxis, restricciones y que el SQL haga lo que dice, SIN dejar rastro.
// Solo dev, igual que _apply-sql-dev.mjs.
import pg from 'pg'; import { readFileSync } from 'fs';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '', url = process.env.SUPABASE_URL || '';
if (!url.includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
const file = process.argv[2]; if (!file) { console.error('uso: node _probar-sql-dev.mjs <archivo.sql> [comprobacion.sql]'); process.exit(1); }
// El BEGIN/COMMIT del propio archivo se neutraliza: mandamos todo dentro de UNA
// transacción nuestra y la deshacemos al final.
const sql = readFileSync(file, 'utf8').replace(/^\s*BEGIN\s*;\s*$/mi, '').replace(/^\s*COMMIT\s*;\s*$/mi, '');
const check = process.argv[3] ? readFileSync(process.argv[3], 'utf8') : null;
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432, user:'postgres.'+ref, password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
let ok = false;
try {
  await c.query('BEGIN');
  await c.query(sql);
  console.log('✓ la migración corre sin errores');
  if (check) {
    const r = await c.query(check);
    console.log('\n── comprobaciones ──');
    for (const row of r.rows || []) console.log('  ' + Object.values(row).join(' · '));
  }
  ok = true;
} catch (e) {
  console.error('✗ ERROR:', e.message);
  if (e.hint) console.error('  pista:', e.hint);
  if (e.position) console.error('  posición:', e.position);
} finally {
  await c.query('ROLLBACK').catch(()=>{});
  await c.end();
  console.log(ok ? '\nROLLBACK hecho — la base quedó como estaba.' : '\nROLLBACK hecho — nada se aplicó.');
  process.exit(ok ? 0 : 1);
}
