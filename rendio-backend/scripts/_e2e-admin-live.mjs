// Prueba la lectura del admin: la MISMA consulta de Api.listLiveOperation,
// como usuario admin real (anon key + sesión), para validar RLS + embeddings.
import { createClient } from '@supabase/supabase-js';

const DEV = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORTA: no es dev'); process.exit(2); }

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: eLogin } = await admin.auth.signInWithPassword({ email: 'demo-admin@rendio.demo', password: 'DemoRendio2026!' });
if (eLogin) { console.error('login admin:', eLogin.message); process.exit(1); }

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

// Sembramos un ancla y un GPS para un conductor con ruta, para tener qué leer.
const JULIAN = '0776dcab-be80-40d9-afd6-e26218e8101e';
const { data: dp } = await svc.from('driver_profiles').select('id').eq('profile_id', JULIAN).single();
await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id);
const { data: ra1 } = await svc.from('route_assignments').select('id').eq('driver_profile_id', dp.id).limit(1).single();
await svc.from('driver_locations').insert([
  { driver_profile_id: dp.id, route_assignment_id: ra1.id, latitude: 6.1400, longitude: -75.3700, source: 'anchor', recorded_at: new Date(Date.now() - 300000).toISOString() },
  { driver_profile_id: dp.id, route_assignment_id: ra1.id, latitude: 6.1550, longitude: -75.3900, source: 'gps', recorded_at: new Date().toISOString() },
]);

console.log('1) la consulta de listLiveOperation corre como admin');
const { data, error } = await admin
  .from('route_assignments')
  .select('id, direction, planned_start_at, status, driver_profile_id, vehicle_id, vehicles(license_plate, internal_code, capacity), driver_profiles(profiles(full_name, phone)), route_stops(stop_order, status, actual_arrival_at, actual_pickup_at, actual_dropoff_at, reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, auxiliar_profiles(profiles(full_name)), flights(flight_number)))')
  .in('status', ['planned', 'in_progress'])
  .order('planned_start_at');
ok(!error, `sin error de PostgREST ${error ? '→ ' + error.message : ''}`);
if (error) { console.log('\n=== la consulta falló, no sigo ==='); process.exit(1); }
ok((data || []).length > 0, `devolvió ${data.length} vueltas`);

const withVeh = data.filter(r => r.vehicles?.license_plate).length;
ok(withVeh === data.length, `todas traen placa (${withVeh}/${data.length})`);
const withDrv = data.filter(r => r.driver_profiles?.profiles?.full_name).length;
ok(withDrv === data.length, `todas traen nombre del conductor (${withDrv}/${data.length})`);
const withStops = data.filter(r => (r.route_stops || []).length > 0).length;
ok(withStops === data.length, `todas traen paradas (${withStops}/${data.length})`);
const anyAux = data.some(r => (r.route_stops || []).some(s => s.reservations?.auxiliar_profiles?.profiles?.full_name));
ok(anyAux, 'las paradas traen el nombre del auxiliar');
const anyCoords = data.some(r => (r.route_stops || []).some(s => s.reservations?.pickup_latitude != null));
ok(anyCoords, 'las paradas traen coordenadas');

console.log('\n2) el admin lee driver_locations (RLS select_admin) y gana el más reciente');
const { data: locs, error: eLoc } = await admin
  .from('driver_locations')
  .select('driver_profile_id, latitude, longitude, source, recorded_at')
  .in('driver_profile_id', [dp.id])
  .order('recorded_at', { ascending: false })
  .limit(400);
ok(!eLoc, `sin error ${eLoc ? '→ ' + eLoc.message : ''}`);
ok((locs || []).length === 2, `ve las 2 posiciones (${locs?.length})`);
ok(locs && locs[0].source === 'gps', `la primera es la más reciente (${locs?.[0]?.source})`);

console.log('\n3) un conductor NO puede espiar la posición de otro');
const drv = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await drv.auth.signInWithPassword({ email: 'demo-conductor@rendio.demo', password: 'DemoRendio2026!' });
const { data: spy } = await drv.from('driver_locations').select('id').in('driver_profile_id', [dp.id]);
ok((spy || []).length === 0, `demo-conductor no ve las de Julián (${spy?.length} filas)`);

await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id);
console.log(`\n=== ${pass} OK · ${fail} fallos ===`);
process.exit(fail ? 1 : 0);
