import { createClient } from '@supabase/supabase-js';

if (!(process.env.SUPABASE_URL || '').includes('lxlphbafhtphulanhzlp')) {
  console.error('ABORTA: no es la BD de dev');
  process.exit(2);
}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: veh } = await a.from('vehicles').select('id, license_plate, internal_code, capacity, status');
console.log('=== VEHÍCULOS en dev ===');
veh.forEach((v) => console.log(`  ${v.license_plate}  status=${v.status}  [${v.id.slice(0, 8)}]`));

const { data: ra } = await a
  .from('route_assignments')
  .select('vehicle_id, driver_profile_id, planned_start_at')
  .order('planned_start_at');

const { data: dps } = await a.from('driver_profiles').select('id, profile_id');
const { data: profs } = await a.from('profiles').select('id, full_name');
const nameOfDp = (dpId) => {
  const dp = dps.find((d) => d.id === dpId);
  return (dp && profs.find((p) => p.id === dp.profile_id)?.full_name) || '(?)';
};
const plateOf = (vid) => veh.find((v) => v.id === vid)?.license_plate || '(sin vehículo)';

console.log('\n=== VUELTAS POR VEHÍCULO ===');
const byVeh = {};
ra.forEach((r) => ((byVeh[plateOf(r.vehicle_id)] ||= []).push(nameOfDp(r.driver_profile_id))));
for (const [plate, drivers] of Object.entries(byVeh)) {
  console.log(`  ${plate}: ${drivers.length} vueltas → ${[...new Set(drivers)].join(' / ')}`);
}

console.log('\n=== ¿DEMO Conductor tiene vueltas? ===');
const demoProfile = '4d31a265-6f46-4f4b-95d2-36a7800eeb84';
const demoDp = dps.find((d) => d.profile_id === demoProfile);
console.log(`driver_profile de DEMO Conductor: ${demoDp ? demoDp.id : 'NO TIENE'}`);
const suyas = ra.filter((r) => r.driver_profile_id === demoDp?.id);
console.log(`vueltas asignadas a DEMO Conductor: ${suyas.length}`);
