import pg from 'pg'; import { readFileSync } from 'fs';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '', url = process.env.SUPABASE_URL || '';
if (!url.includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
const file = process.argv[2]; if (!file) { console.error('uso: node _apply-sql-dev.mjs <archivo.sql>'); process.exit(1); }
const sql = readFileSync(file, 'utf8');
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432, user:'postgres.'+ref, password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
try { await c.query(sql); console.log('APLICADO ✓ ' + file); }
catch (e) { console.error('ERROR:', e.message); process.exit(1); }
finally { await c.end(); }
