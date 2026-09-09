import pg from 'pg';
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432,
  user:'postgres.'+process.env.SUPABASE_PROJECT_REF, password:process.env.SUPABASE_DB_PASSWORD,
  database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
const e = await c.query("select enumlabel from pg_enum join pg_type t on t.oid=enumtypid where t.typname='availability_state' order by enumsortorder");
console.log('enum availability_state:', e.rows.map(r=>r.enumlabel).join(' | '));
const d = await c.query("select column_name, column_default from information_schema.columns where table_name='driver_availability' and column_name in ('am_state','pm_state') order by column_name");
d.rows.forEach(r => console.log('  ' + r.column_name + ' default = ' + r.column_default));
const n = await c.query("select count(*)::int total, count(*) filter (where am_state='unset')::int am_unset from driver_availability");
console.log('filas existentes:', n.rows[0].total, '| ya en unset:', n.rows[0].am_unset);
const w = await c.query("select week_start_date, count(*)::int n from driver_availability group by 1 order by 1 desc limit 3");
w.rows.forEach(r => console.log('  semana ' + r.week_start_date.toISOString().slice(0,10) + ': ' + r.n + ' filas'));
await c.end();
