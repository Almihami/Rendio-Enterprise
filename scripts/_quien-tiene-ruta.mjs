import { createClient } from '@supabase/supabase-js';

// Candado: solo dev.
if (!(process.env.SUPABASE_URL || '').includes('lxlphbafhtphulanhzlp')) {
  console.error('ABORTA: no es la BD de dev');
  process.exit(2);
}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Misma regla de franja que admin-rutas.js: AM si 150 <= min < 840 (02:30-14:00), si no PM.
const COL_OFFSET_MIN = -5 * 60;
const bandOf = (iso) => {
  const utc = new Date(iso);
  const col = new Date(utc.getTime() + COL_OFFSET_MIN * 60000);
  const min = col.getUTCHours() * 60 + col.getUTCMinutes();
  return min >= 150 && min < 840 ? 'AM' : 'PM';
};
const colTime = (iso) => {
  const col = new Date(new Date(iso).getTime() + COL_OFFSET_MIN * 60000);
  return `${String(col.getUTCHours()).padStart(2, '0')}:${String(col.getUTCMinutes()).padStart(2, '0')}`;
};
const colDay = (iso) =>
  new Date(new Date(iso).getTime() + COL_OFFSET_MIN * 60000).toISOString().slice(0, 10);

const { data: ra } = await a
  .from('route_assignments')
  .select('id, driver_profile_id, status, planned_start_at, direction, vehicle_id')
  .order('planned_start_at');

// OJO: route_assignments.driver_profile_id -> driver_profiles(id), NO profiles(id).
const ids = [...new Set(ra.map((r) => r.driver_profile_id).filter(Boolean))];
const { data: dps } = await a.from('driver_profiles').select('id, profile_id').in('id', ids);
const { data: profs } = await a
  .from('profiles')
  .select('id, full_name')
  .in('id', dps.map((d) => d.profile_id));
const nameOf = (dpId) => {
  const dp = dps.find((d) => d.id === dpId);
  const p = dp && profs.find((x) => x.id === dp.profile_id);
  return p ? `${p.full_name} (profile ${dp.profile_id.slice(0, 8)})` : '(sin nombre)';
};

const { data: stops } = await a.from('route_stops').select('route_assignment_id');
const stopsOf = (id) => stops.filter((s) => s.route_assignment_id === id).length;

console.log('=== VUELTAS PUBLICADAS (hora Colombia) ===\n');
const porConductor = {};
for (const r of ra) {
  const band = bandOf(r.planned_start_at);
  const n = nameOf(r.driver_profile_id);
  const dir = r.direction === 'home_to_airport' ? 'IDA  (casa→aeropuerto)' : 'VENIDA (aeropuerto→casa)';
  console.log(
    `${colDay(r.planned_start_at)} ${colTime(r.planned_start_at)}  [${band}]  ${dir}  ${stopsOf(r.id)} pax  → ${n}`
  );
  (porConductor[n] ||= []).push(band);
}

console.log('\n=== RESUMEN POR CONDUCTOR ===');
for (const [n, bands] of Object.entries(porConductor)) {
  const am = bands.filter((b) => b === 'AM').length;
  const pm = bands.filter((b) => b === 'PM').length;
  console.log(`${n}: ${bands.length} vueltas (AM=${am}, PM=${pm})`);
}
