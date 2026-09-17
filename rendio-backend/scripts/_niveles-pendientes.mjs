// ¿Cuántos ítems verá mañana el conductor? SOLO LECTURA.
import pg from 'pg';
const ref=process.env.SUPABASE_PROJECT_REF;
if (ref!=='wvuurnfdrrdondrbbkhd'){console.error('ABORT');process.exit(2);}
const c=new pg.Client({host:'aws-1-us-west-2.pooler.supabase.com',port:5432,user:'postgres.'+ref,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
await c.connect(); await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
const base=(await c.query(`SELECT count(*)::int n FROM public.inspection_checklist_items WHERE is_active AND tier_every_km IS NULL`)).rows[0].n;
const est=(await c.query(`SELECT count(*)::int n FROM public.vehicle_tier_state`)).rows[0].n;
console.log(`checklist diario (sin niveles): ${base} ítems`);
console.log(`vehicle_tier_state: ${est} filas  ${est?'':'← VACÍA: ningún nivel se ha marcado como hecho'}`);
const v=(await c.query(`SELECT internal_code, license_plate, current_km FROM public.vehicles ORDER BY internal_code`)).rows;
console.log('\nvehículos y niveles que saldrían pendientes:');
for (const x of v) {
  const p=(await c.query(`SELECT * FROM public.pending_inspection_tiers($1)`,[ (await c.query(`SELECT id FROM public.vehicles WHERE internal_code=$1`,[x.internal_code])).rows[0].id ]).catch(()=>({rows:null})));
  const kms=p.rows? p.rows.map(r=>r.every_km) : null;
  const extra=kms? (await c.query(`SELECT count(*)::int n FROM public.inspection_checklist_items WHERE is_active AND tier_every_km = ANY($1)`,[kms])).rows[0].n : 0;
  console.log(`  ${String(x.internal_code).padEnd(6)} ${String(x.license_plate).padEnd(9)} ${String(x.current_km||0).padStart(7)} km → niveles ${kms?JSON.stringify(kms):'?'} · TOTAL ${base+extra} ítems`);
}
await c.end();
