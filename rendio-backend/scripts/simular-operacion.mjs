#!/usr/bin/env node
// Simula lo que haría el celular de los conductores, para poder MIRAR la pantalla
// de Operación en vivo sin tener carros rodando de verdad.
//
// No inyecta nada a la fuerza: marca los estados llamando al MISMO RPC que usa la
// app del conductor (con la sesión del conductor, pasando por RLS), y manda los
// pings de GPS con el mismo insert que hace driver-rutas.js. Lo que veas en el
// admin es dato real recorriendo el camino real.
//
// Uso:
//   cd rendio-backend && set -a; . ./.env.dev; set +a
//   node scripts/simular-operacion.mjs           # simula
//   node scripts/simular-operacion.mjs --limpiar # borra las posiciones y resetea
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORTA: no es dev'); process.exit(2); }
const seed = JSON.parse(readFileSync(new URL('./seed-turnos-users.json', import.meta.url)));
const LIMPIAR = process.argv.includes('--limpiar');

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const asDriver = async (email) => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: seed.default_password });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
};

// Los dos conductores con vueltas AM el día operativo.
const CONDUCTORES = [
  { profile: '0776dcab-be80-40d9-afd6-e26218e8101e', pos: [6.1490, -75.3590] }, // Julián — San Antonio de Pereira
  { profile: '8e6cb653-416b-4763-b703-c2e19c440ed2', pos: [6.1736, -75.3376] }, // Daniel — Marinilla
];

for (const c of CONDUCTORES) {
  const { data: dp } = await svc.from('driver_profiles').select('id').eq('profile_id', c.profile).single();
  const { data: pr } = await svc.from('profiles').select('email, full_name').eq('id', c.profile).single();
  c.dp = dp.id; c.email = pr.email; c.name = pr.full_name;

  if (LIMPIAR) {
    await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id);
    const { data: ras } = await svc.from('route_assignments').select('id').eq('driver_profile_id', dp.id);
    const ids = ras.map(r => r.id);
    if (ids.length) {
      await svc.from('route_stops').update({ status: 'pending', actual_arrival_at: null, actual_pickup_at: null, actual_dropoff_at: null }).in('route_assignment_id', ids);
      const { data: rs } = await svc.from('route_stops').select('reservation_id').in('route_assignment_id', ids);
      await svc.from('reservations').update({ status_h2a: 'assigned' }).in('id', rs.map(x => x.rereservation_id ?? x.reservation_id)).eq('direction', 'home_to_airport');
    }
    console.log(`limpiado: ${pr.full_name}`);
    continue;
  }

  const drv = await asDriver(pr.email);

  // Su vuelta activa del día operativo más próximo.
  const { data: ra } = await svc
    .from('route_assignments')
    .select('id, direction, planned_start_at, route_stops(id, stop_order, reservation_id, reservations(pickup_address))')
    .eq('driver_profile_id', dp.id)
    .order('planned_start_at')
    .limit(1).single();
  const stops = ra.route_stops.sort((a, b) => a.stop_order - b.stop_order);

  // Marca la primera parada como "llegué" → deja el ancla en esa dirección.
  const first = stops[0];
  const { error: e1 } = await drv.rpc('driver_set_reservation_status', { p_reservation_id: first.reservation_id, p_status: 'at_pickup' });
  if (e1) { console.error(`  ✗ ${pr.full_name}: ${e1.message}`); continue; }

  // Y un ping de GPS fresco donde va rodando (como haría watchPosition).
  const { error: e2 } = await drv.from('driver_locations').insert({
    driver_profile_id: dp.id, route_assignment_id: ra.id,
    latitude: c.pos[0], longitude: c.pos[1], source: 'gps', speed_kmh: 42,
  });
  if (e2) { console.error(`  ✗ GPS ${pr.full_name}: ${e2.message}`); continue; }

  console.log(`✓ ${pr.full_name}`);
  console.log(`    ancla: llegó donde ${(first.reservations?.pickup_address || '').split(',')[0]}`);
  console.log(`    GPS:   ${c.pos[0]}, ${c.pos[1]}`);
}

if (!LIMPIAR) {
  console.log('\nAbre el admin → Rutas → Operación. Deberías ver 2 carros con posición real.');
  console.log('Nota: el semáforo saldrá "A tiempo" porque la presentación es mañana y sobra holgura.');
  console.log('Para volver atrás:  node scripts/simular-operacion.mjs --limpiar');
}
