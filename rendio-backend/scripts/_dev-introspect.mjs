import pg from 'pg';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '', url = process.env.SUPABASE_URL || '';
if (!url.includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432, user:'postgres.'+ref, password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s) => (await c.query(s)).rows;
console.log('org=' + (await q("select count(*)::int n from organizations"))[0].n);
console.log('airports cols=' + JSON.stringify((await q("select column_name from information_schema.columns where table_name='airports' order by ordinal_position")).map(r=>r.column_name)));
console.log('airports=' + JSON.stringify(await q("select * from airports limit 3")));
console.log('reservations=' + (await q("select count(*)::int n from reservations"))[0].n + ' | auxiliar_profiles=' + (await q("select count(*)::int n from auxiliar_profiles"))[0].n + ' | flights=' + (await q("select count(*)::int n from flights"))[0].n);
console.log('0040? flight_id nullable=' + (await q("select is_nullable from information_schema.columns where table_name='reservations' and column_name='flight_id'"))[0].is_nullable);
console.log('route_assignments status check=' + JSON.stringify(await q("select pg_get_constraintdef(oid) d from pg_constraint where conname='route_assignments_status_valid'")));
await c.end();
