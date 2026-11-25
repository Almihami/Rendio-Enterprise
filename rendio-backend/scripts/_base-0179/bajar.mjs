// SOLO LECTURA: baja la definición viva de auxiliar_my_trips (dev o producción) para el generador de 0179.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_base-0179/bajar.mjs
import { createRequire } from 'node:module'; import { writeFileSync } from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const ref = process.env.SUPABASE_PROJECT_REF, prod = ref === 'wvuurnfdrrdondrbbkhd';
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('BEGIN TRANSACTION READ ONLY');
try {
  for (const f of ['auxiliar_my_trips']) {
    const d = (await c.query(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [f])).rows;
    if (d.length !== 1) throw new Error(f + ': ' + d.length + ' definiciones');
    writeFileSync(new URL(`./${prod ? 'prod' : 'dev'}-${f}.sql`, import.meta.url), d[0].d.trimEnd() + '\n');
    console.log(f, 'ok');
  }
  if (prod) console.log('borradores automáticos en prod:', JSON.stringify((await c.query(`select status, coalesce(auto_created,false) auto, count(*) from route_assignments where status='draft' group by 1,2`)).rows));
} finally { await c.query('ROLLBACK'); await c.end(); }
