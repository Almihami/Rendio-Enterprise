// ¿SIGUE TODO EN SU SITIO DESPUÉS DE MIGRAR? Compara producción contra el
// respaldo tomado ANTES. Solo lectura.
import pg from 'pg'; import { readFileSync, readdirSync } from 'fs';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT'); process.exit(2); }
const R = process.argv[2]; if (!R) { console.error('uso: <carpeta-respaldo>'); process.exit(1); }
const c = new pg.Client({ host:'aws-1-us-west-2.pooler.supabase.com', port:5432, user:'postgres.'+ref,
  password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
let ok=0, bad=0;
const t=(n,cond,d='')=>{ if(cond){ok++;console.log('  ✓ '+n);} else {bad++;console.log('  ✗ '+n+(d?' → '+d:''));} };

console.log('── ninguna fila se perdió ──');
for (const f of readdirSync(R).filter(x=>x.endsWith('.json') && !x.startsWith('_'))) {
  const tabla = f.replace('.json','');
  const antes = JSON.parse(readFileSync(`${R}/${f}`,'utf8')).length;
  if (!antes) continue;
  const [{ n }] = (await c.query(`SELECT count(*)::int n FROM public."${tabla}"`)).rows;
  t(`${tabla}: ${n} (antes ${antes})`, n >= antes, `PERDIÓ ${antes-n} filas`);
}
console.log('\n── lo nuevo existe ──');
const sondas = [
  ['tabla residences',        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='residences'`],
  ['tabla route_zone_times',  `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='route_zone_times'`],
  ['tabla no_fuel_reasons',   `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='no_fuel_reasons'`],
  ['columna shifts.fueled',   `SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='fueled'`],
  ['enum unset',              `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='availability_state' AND e.enumlabel='unset'`],
  ['close_shift sin sobrecarga', `SELECT 1 FROM (SELECT count(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname='close_shift') s WHERE s.n=1`],
];
for (const [n, sql] of sondas) t(n, (await c.query(sql)).rows.length>0);

console.log('\n── la disponibilidad NO se reinterpretó ──');
const av = (await c.query(`SELECT am_state s, count(*)::int n FROM public.driver_availability GROUP BY 1 ORDER BY 1`)).rows;
console.log('   ' + av.map(r=>`${r.s}:${r.n}`).join(' · '));
const antesAv = JSON.parse(readFileSync(`${R}/driver_availability.json`,'utf8'));
const cuentaAntes = antesAv.reduce((m,r)=>{m[r.am_state]=(m[r.am_state]||0)+1;return m;},{});
t('mismos estados que antes de migrar',
  av.every(r => cuentaAntes[r.s] === r.n) && av.length === Object.keys(cuentaAntes).length,
  JSON.stringify(cuentaAntes));

console.log('\n── la nómina cuadra ──');
const [{ n: turnos }] = (await c.query(`SELECT count(*)::int n FROM public.shifts WHERE end_at IS NOT NULL`)).rows;
const antesT = JSON.parse(readFileSync(`${R}/shifts.json`,'utf8')).filter(s=>s.end_at).length;
t(`turnos cerrados: ${turnos} (antes ${antesT})`, turnos === antesT);
const [{ s: suma }] = (await c.query(`SELECT COALESCE(sum(amount_cop),0)::bigint s FROM public.fuel_receipts`)).rows;
const antesS = JSON.parse(readFileSync(`${R}/fuel_receipts.json`,'utf8')).reduce((a,r)=>a+Number(r.amount_cop||0),0);
t(`comprobantes suman $${Number(suma).toLocaleString('es-CO')} (antes $${antesS.toLocaleString('es-CO')})`, Number(suma) === antesS);

await c.end();
console.log(`\n${ok}/${ok+bad} pasaron${bad?` · ${bad} FALLARON`:''}`);
process.exit(bad?1:0);
