// E2E de la 0045 contra dev: el conductor marca estados como usuario REAL
// (anon key + su sesión, pasando por RLS) y comprobamos que:
//   1. route_stops queda con status + hora real,
//   2. driver_locations recibe el ancla en las coords correctas,
//   3. 'en_route' NO ancla (va en movimiento),
//   4. un no-conductor no puede marcar.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORTA: no es dev'); process.exit(2); }
const seed = JSON.parse(readFileSync(new URL('./seed-turnos-users.json', import.meta.url)));

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const asUser = async (email, password) => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
};

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

// Julián tiene vueltas AM el viernes.
const JULIAN = '0776dcab-be80-40d9-afd6-e26218e8101e';
const { data: dp } = await svc.from('driver_profiles').select('id').eq('profile_id', JULIAN).single();
const { data: prof } = await svc.from('profiles').select('email').eq('id', JULIAN).single();

// Una parada suya, con coords.
const { data: ra } = await svc
  .from('route_assignments')
  .select('id, direction, route_stops(id, reservation_id, status, reservations(pickup_latitude, pickup_longitude, flight_id))')
  .eq('driver_profile_id', dp.id)
  .eq('direction', 'home_to_airport')
  .limit(1).single();
const stop = ra.route_stops.find(s => s.reservations?.pickup_latitude != null);
const resId = stop.reservation_id;
console.log(`Conductor: ${prof.email}\nReserva de prueba: ${resId.slice(0, 8)} (${ra.direction})\n`);

// Estado inicial, para restaurar al final.
const { data: before } = await svc.from('reservations').select('status_h2a').eq('id', resId).single();
const clean = async () => {
  await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id).eq('source', 'anchor');
  await svc.from('route_stops').update({ status: 'pending', actual_arrival_at: null, actual_pickup_at: null, actual_dropoff_at: null }).eq('id', stop.id);
  await svc.from('reservations').update({ status_h2a: before.status_h2a }).eq('id', resId);
};
await clean();

const drv = await asUser(prof.email, seed.default_password);
const lastAnchor = async () => {
  const { data } = await svc.from('driver_locations')
    .select('latitude, longitude, source, recorded_at')
    .eq('driver_profile_id', dp.id).order('recorded_at', { ascending: false }).limit(1);
  return data && data[0];
};

console.log('1) en_route → NO debe anclar (va rodando)');
await drv.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'en_route' });
ok(!(await lastAnchor()), 'no dejó ancla');
const { data: rs1 } = await svc.from('route_stops').select('status').eq('id', stop.id).single();
ok(rs1.status === 'pending', `la parada sigue pending (${rs1.status})`);

console.log('\n2) at_pickup → ancla en la dirección de la reserva');
await drv.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'at_pickup' });
const a2 = await lastAnchor();
ok(!!a2 && a2.source === 'anchor', 'dejó ancla source=anchor');
ok(!!a2 && Math.abs(a2.latitude - stop.reservations.pickup_latitude) < 1e-6, 'ancla en la lat de la reserva');
ok(!!a2 && Math.abs(a2.longitude - stop.reservations.pickup_longitude) < 1e-6, 'ancla en la lng de la reserva');
const { data: rs2 } = await svc.from('route_stops').select('status, actual_arrival_at').eq('id', stop.id).single();
ok(rs2.status === 'arrived', `parada = arrived (${rs2.status})`);
ok(!!rs2.actual_arrival_at, 'guardó actual_arrival_at');

console.log('\n3) on_board → parada picked_up + hora de recogida');
await drv.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'on_board' });
const { data: rs3 } = await svc.from('route_stops').select('status, actual_arrival_at, actual_pickup_at').eq('id', stop.id).single();
ok(rs3.status === 'picked_up', `parada = picked_up (${rs3.status})`);
ok(!!rs3.actual_pickup_at, 'guardó actual_pickup_at');
ok(rs3.actual_arrival_at === rs2.actual_arrival_at, 'no pisó la hora de llegada original');

console.log('\n4) delivered (casa→aeropuerto) → ancla EN EL AEROPUERTO');
// Las reservas de dev no tienen vuelo (0040 hizo flight_id nullable), así que
// esto ejercita justamente el respaldo por organización.
console.log(`   (la reserva ${stop.reservations.flight_id ? 'tiene' : 'NO tiene'} vuelo → ${stop.reservations.flight_id ? 'vía flights' : 'vía aeropuerto de la organización'})`);
const { data: org } = await svc.from('profiles').select('organization_id').eq('id', JULIAN).single();
const { data: air } = await svc.from('airports').select('latitude, longitude').eq('organization_id', org.organization_id).limit(1).single();
await drv.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'delivered' });
const a4 = await lastAnchor();
ok(!!a4 && Math.abs(a4.latitude - air.latitude) < 1e-6, 'ancla en la lat del aeropuerto');
ok(!!a4 && Math.abs(a4.longitude - air.longitude) < 1e-6, 'ancla en la lng del aeropuerto');
const { data: rs4 } = await svc.from('route_stops').select('status, actual_dropoff_at').eq('id', stop.id).single();
ok(rs4.status === 'delivered', `parada = delivered (${rs4.status})`);
ok(!!rs4.actual_dropoff_at, 'guardó actual_dropoff_at');

console.log('\n5) seguridad');
const aux = await asUser('laura.gomez@rendio.demo', 'DemoRendio2026!');
const { error: eAux } = await aux.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'at_pickup' });
ok(!!eAux, 'un auxiliar NO puede marcar estados');
const { error: eBad } = await drv.rpc('driver_set_reservation_status', { p_reservation_id: resId, p_status: 'inventado' });
ok(!!eBad, 'un estado inválido se rechaza');

console.log('\n6) el conductor puede insertar su GPS (RLS insert_own)');
const { error: eGps } = await drv.from('driver_locations').insert({ driver_profile_id: dp.id, latitude: 6.15, longitude: -75.37, source: 'gps' });
ok(!eGps, `insert de GPS propio ${eGps ? '→ ' + eGps.message : 'OK'}`);
const { error: eGps2 } = await drv.from('driver_locations').insert({ driver_profile_id: '00000000-0000-0000-0000-000000000000', latitude: 6.15, longitude: -75.37, source: 'gps' });
ok(!!eGps2, 'NO puede insertar GPS de otro conductor');

await clean();
await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id);
console.log(`\n=== ${pass} OK · ${fail} fallos ===`);
process.exit(fail ? 1 : 0);
