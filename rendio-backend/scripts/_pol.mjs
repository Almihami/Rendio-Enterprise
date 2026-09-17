import pg from 'pg';
if(!(process.env.SUPABASE_URL||'').includes('lxlphbafhtphulanhzlp')){console.error('no dev');process.exit(2);}
const c=new pg.Client({host:'aws-1-us-east-1.pooler.supabase.com',port:5432,user:'postgres.'+process.env.SUPABASE_PROJECT_REF,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query("select polname, cmd, pg_get_expr(polqual,polrelid) qual, pg_get_expr(polwithcheck,polrelid) wcheck from pg_policy join pg_class on pg_class.oid=polrelid where relname='reservations'");
for(const p of r.rows) console.log(p.cmd+' · '+p.polname+' | using: '+(p.qual||'-')+' | check: '+(p.wcheck||'-'));
await c.end();
