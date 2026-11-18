// SOLO LECTURA (dev): qué funciones de la base arman textos con la hora de salida de JMC de una llegada.
import { createRequire } from 'node:module'; import fs from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const REF = process.env.SUPABASE_PROJECT_REF; const DEV = 'lxlphbafhtphulanhzlp';
if (REF !== DEV) { console.error('no es dev'); process.exit(2); }
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + DEV, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect(); await c.query('BEGIN TRANSACTION READ ONLY');
const rows = (await c.query(`select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosrc, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
  and p.prosrc ~* '(JMC a las|hacia las|sale de JMC|salía de JMC|arranca a las|Llegada de las|vuelta de las|llegada de las|Recoge en JMC|sale de JMC a las)' order by 1`)).rows;
const pat = /(JMC a las|hacia las|sale de JMC|salía de JMC|arranca a las|[Ll]legada de las|vuelta de las|Recoge en JMC)/;
for (const r of rows) {
  fs.writeFileSync(new URL(`./def-${r.proname}.sql`, import.meta.url), r.def);
  const ls = r.prosrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => pat.test(l) && !/^\s*--/.test(l));
  console.log(`\n== ${r.proname}(${r.args.slice(0, 60)}) · ${ls.length}`);
  ls.forEach(([i, l]) => console.log(`  ${i}: ${l.trim().slice(0, 230)}`));
}
await c.query('ROLLBACK'); await c.end();
