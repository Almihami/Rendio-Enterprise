// SOLO LECTURA: baja la definición viva de las funciones que toca 0178 (dev o producción).
//   node scripts/_base-0178/bajar.mjs dev|prod
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
for (const f of ['reubicar_reserva', 'detect_late_bookings']) {
  const r = (await c.query(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [f])).rows;
  r.forEach((x, i) => fs.writeFileSync(new URL(`./${amb}-${f}${r.length > 1 ? '-' + i : ''}.sql`, import.meta.url), x.def));
  console.log(amb, f, r.map((x) => x.sig).join(' | '));
}
await c.query('ROLLBACK'); await Promise.race([c.end(), new Promise((x) => setTimeout(x, 5000))]); process.exit(0);
