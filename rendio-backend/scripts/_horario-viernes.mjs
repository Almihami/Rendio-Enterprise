import { createClient } from '@supabase/supabase-js';

if (!(process.env.SUPABASE_URL || '').includes('lxlphbafhtphulanhzlp')) {
  console.error('ABORTA: no es la BD de dev');
  process.exit(2);
}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: ws, error } = await a
  .from('weekly_schedules')
  .select('week_start_date, published, data')
  .order('week_start_date');
if (error) {
  console.error('ERROR:', error.message);
  process.exit(1);
}
console.log('=== weekly_schedules en dev ===');
for (const w of ws) {
  console.log(`week_start_date=${w.week_start_date}  published=${w.published}`);
}

// La semana que contiene el viernes 2026-07-17
const target = ws.find((w) => w.week_start_date === '2026-07-13');
if (!target) {
  console.log('\nNo hay horario para la semana del 2026-07-13');
  process.exit(0);
}
const fri = target.data?.fri;
console.log('\n=== VIERNES 2026-07-17 (semana 2026-07-13) ===');
console.log(JSON.stringify(fri, null, 2));

const ids = [...new Set([...(fri?.morning || []), ...(fri?.afternoon || []), fri?.coord_am, fri?.coord_pm].filter(Boolean))];
const { data: profs } = await a.from('profiles').select('id, full_name').in('id', ids);
const { data: dps } = await a.from('driver_profiles').select('id, profile_id').in('profile_id', ids);
const n = (id) => profs.find((p) => p.id === id)?.full_name || '(desconocido)';
const hasDp = (id) => (dps.some((d) => d.profile_id === id) ? 'tiene driver_profile' : '⚠ SIN driver_profile');

console.log('\nAM (morning):');
(fri?.morning || []).forEach((id) => console.log(`  ${n(id)}  [${id.slice(0, 8)}]  ${hasDp(id)}`));
console.log('PM (afternoon):');
(fri?.afternoon || []).forEach((id) => console.log(`  ${n(id)}  [${id.slice(0, 8)}]  ${hasDp(id)}`));

console.log('\n=== ¿demo-conductor (4d31a265) está en el horario? ===');
const demo = '4d31a265';
const inAm = (fri?.morning || []).some((id) => id.startsWith(demo));
const inPm = (fri?.afternoon || []).some((id) => id.startsWith(demo));
console.log(`AM=${inAm}  PM=${inPm}`);
