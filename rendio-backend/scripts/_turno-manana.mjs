// Quién tiene turno un día dado, en producción. SOLO LECTURA.
import pg from 'pg';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: no es producción'); process.exit(2); }
const c = new pg.Client({ host:'aws-1-us-west-2.pooler.supabase.com', port:5432, user:'postgres.'+ref,
  password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect(); await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
const dia = process.argv[2] || new Date(Date.now()+864e5).toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
console.log(`Día consultado: ${dia}\n`);
const w = (await c.query(`SELECT week_start_date, published FROM public.weekly_schedules ORDER BY week_start_date DESC LIMIT 4`)).rows;
console.log('Horarios guardados (últimas semanas):');
w.forEach(r=>console.log(`  ${String(r.week_start_date).slice(0,10)} · ${r.published?'PUBLICADO':'borrador'}`));
const fila = (await c.query(`SELECT week_start_date, published, data FROM public.weekly_schedules
   WHERE week_start_date <= $1::date AND week_start_date + 6 >= $1::date ORDER BY week_start_date DESC LIMIT 1`, [dia])).rows[0];
if (!fila) { console.log(`\n⚠ NO hay horario que cubra ${dia}.`); await c.end(); process.exit(0); }
console.log(`\nSemana que lo cubre: ${String(fila.week_start_date).slice(0,10)} · ${fila.published?'PUBLICADO':'⚠ SIN PUBLICAR'}`);
console.log('\nForma de los datos guardados:');
console.log('  ' + JSON.stringify(fila.data).slice(0,400));
const nombres = (await c.query(`SELECT id, full_name, email FROM public.profiles WHERE role='driver' AND is_active`)).rows;
console.log(`\n${nombres.length} conductores activos en producción:`);
nombres.forEach(r=>console.log(`  · ${r.full_name}  <${r.email}>`));
await c.end();
