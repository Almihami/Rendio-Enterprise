// SOLO LECTURA: baja la definición viva de las funciones que toca 0175, de dev o de producción.
//   node _base-0175/bajar.mjs dev|prod
import { createRequire } from 'node:module'; import fs from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const amb = process.argv[2];
const envf = amb === 'prod' ? '.env.main' : '.env.dev';
const env = Object.fromEntries(fs.readFileSync('/Users/harold/Documents/Rendio-Drivers/Proyect/rendio-backend/' + envf, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const REF = amb === 'prod' ? 'wvuurnfdrrdondrbbkhd' : 'lxlphbafhtphulanhzlp';
if (env.SUPABASE_PROJECT_REF !== REF) { console.error('ambiente equivocado'); process.exit(2); }
const host = amb === 'prod' ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com';
const c = new pg.Client({ host, port: 5432, database: 'postgres', user: 'postgres.' + REF, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
await c.connect(); await c.query('BEGIN TRANSACTION READ ONLY');
const out = {};
for (const f of ['acomodar_eventualidades', 'acomodo_frenado', 'acomodo_aviso_freno', 'ops_alert_recipients_of', 'trip_notify']) {
  const r = (await c.query(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [f])).rows;
  out[f] = r;
  r.forEach((x, i) => fs.writeFileSync(new URL(`./${amb}-${f}${r.length > 1 ? '-' + i : ''}.sql`, import.meta.url), x.def));
  console.log(amb, f, r.map((x) => x.sig).join(' | '));
}
const cols = (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name='app_settings' and column_name like 'acomodo%'`)).rows.map((x) => x.column_name);
console.log('app_settings acomodo*:', cols.join(', '));
const cron = (await c.query(`select jobname, schedule, left(command, 120) cmd from cron.job order by jobname`).catch(() => ({ rows: [] }))).rows;
cron.forEach((j) => console.log('cron', j.jobname, j.schedule, j.cmd));
await c.query('ROLLBACK'); await Promise.race([c.end(), new Promise((x) => setTimeout(x, 5000))]); process.exit(0);
