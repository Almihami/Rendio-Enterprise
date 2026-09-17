import pg from 'pg';
const ref=process.env.SUPABASE_PROJECT_REF;
const c=new pg.Client({host:'aws-1-us-west-2.pooler.supabase.com',port:5432,user:'postgres.'+ref,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
await c.connect(); await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
const dia=process.argv[2], DIAS=['mon','tue','wed','thu','fri','sat','sun'];
const k=DIAS[(new Date(dia+'T12:00:00').getDay()+6)%7];
const f=(await c.query(`SELECT week_start_date, data FROM public.weekly_schedules WHERE week_start_date <= $1::date AND week_start_date + 6 >= $1::date ORDER BY week_start_date DESC LIMIT 1`,[dia])).rows[0];
const N=Object.fromEntries((await c.query(`SELECT id, full_name, email FROM public.profiles`)).rows.map(r=>[r.id,r]));
const d=f.data[k]||{};
const ETQ={morning:'MAÑANA (arranca de madrugada)',afternoon:'TARDE',coord_am:'Líder de turno AM',coord_pm:'Líder de turno PM',rest:'Descansa'};
console.log(`${dia} (${k}) · semana del ${String(f.week_start_date).slice(0,10)}\n`);
for (const [grupo, ids] of Object.entries(d)) {
  if (!Array.isArray(ids) || !ids.length) continue;
  console.log(`${ETQ[grupo]||grupo}:`);
  ids.forEach(id=>{ const p=N[id]; console.log(`   · ${p?p.full_name:'(desconocido)'}${p?'  <'+p.email+'>':''}`); });
  console.log('');
}
await c.end();
