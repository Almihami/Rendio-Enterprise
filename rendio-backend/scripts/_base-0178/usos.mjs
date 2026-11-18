// SOLO LECTURA: qué funciones vivas deciden «día publicado» (usan dia_del_plan) y qué triggers tiene route_assignments.
//   node scripts/_base-0178/usos.mjs dev|prod
import { createRequire } from 'node:module'; import fs from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const amb = process.argv[2];
const env = Object.fromEntries(fs.readFileSync('/Users/harold/Documents/Rendio-Drivers/Proyect/rendio-backend/' + (amb === 'prod' ? '.env.main' : '.env.dev'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const REF = amb === 'prod' ? 'wvuurnfdrrdondrbbkhd' : 'lxlphbafhtphulanhzlp';
if (env.SUPABASE_PROJECT_REF !== REF) { console.error('ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: amb === 'prod' ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + REF, password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
await c.connect(); await c.query('BEGIN TRANSACTION READ ONLY');
const fns = (await c.query(`select p.proname, p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and (p.prosrc ilike '%dia_del_plan%' or p.prosrc ilike '%día publicado%' or p.prosrc ilike '%dia publicado%') order by 1`)).rows;
for (const f of fns) { const n = (f.def.match(/dia_del_plan/g) || []).length; console.log(amb, f.sig, '· dia_del_plan ×' + n); if (process.argv[3] === 'guardar') fs.writeFileSync(new URL(`./${amb}-${f.proname}.sql`, import.meta.url), f.def); }
console.log('-- triggers de route_assignments');
(await c.query(`select t.tgname, pg_get_triggerdef(t.oid) d from pg_trigger t where t.tgrelid='public.route_assignments'::regclass and not t.tgisinternal order by 1`)).rows.forEach((x) => console.log('  ', x.d.replace('CREATE TRIGGER ', '').slice(0, 190)));
console.log('-- ¿existe ya la tabla/funciones de 0178?', (await c.query(`select to_regclass('public.route_published_days') t, (select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('dia_publicado','marcar_dia_publicado')) f`)).rows[0]);
console.log('-- set_updated_at:', (await c.query(`select count(*)::int n from pg_proc where pronamespace='public'::regnamespace and proname='set_updated_at'`)).rows[0].n, '· corte de la noche:', (await c.query(`select route_night_cutoff_min from app_settings where id='singleton'`)).rows[0]);
await c.query('ROLLBACK'); await Promise.race([c.end(), new Promise((x) => setTimeout(x, 5000))]); process.exit(0);
