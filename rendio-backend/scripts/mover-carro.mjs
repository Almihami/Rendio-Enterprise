#!/usr/bin/env node
// Mueve un carro por la CARRETERA REAL mandando pings de GPS, como haría el
// celular del conductor. Sirve para mirar la pantalla de Operación en vivo sin
// tener que salir a manejar.
//
// No hace trampa: usa la ruta real de OSRM y el mismo insert que hace
// driver-rutas.js (con la sesión del conductor, pasando por RLS).
//
// Uso:
//   cd rendio-backend && set -a; . ./.env.dev; set +a
//   node scripts/mover-carro.mjs                 # mueve a Julián (ABC123) ~3 min
//   node scripts/mover-carro.mjs --kmh 80        # más rápido
//   node scripts/mover-carro.mjs --limpiar       # borra las posiciones
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORTA: no es dev'); process.exit(2); }
const seed = JSON.parse(readFileSync(new URL('./seed-turnos-users.json', import.meta.url)));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const KMH = Number(arg('--kmh', 60));
const PING_S = 6;            // igual que DR_PING_MS en driver-rutas.js
const LIMPIAR = process.argv.includes('--limpiar');

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Julián — el conductor de ABC123 con las vueltas AM.
const JULIAN = '0776dcab-be80-40d9-afd6-e26218e8101e';
const { data: dp } = await svc.from('driver_profiles').select('id').eq('profile_id', JULIAN).single();
const { data: pr } = await svc.from('profiles').select('email, full_name').eq('id', JULIAN).single();

if (LIMPIAR) {
  await svc.from('driver_locations').delete().eq('driver_profile_id', dp.id);
  console.log(`Posiciones de ${pr.full_name} borradas.`);
  process.exit(0);
}

const drv = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: eLogin } = await drv.auth.signInWithPassword({ email: pr.email, password: seed.default_password });
if (eLogin) { console.error('login:', eLogin.message); process.exit(1); }

// Su vuelta activa y la parada a la que va.
const { data: ra } = await svc
  .from('route_assignments')
  .select('id, planned_start_at, route_stops(stop_order, status, reservations(pickup_address, pickup_latitude, pickup_longitude))')
  .eq('driver_profile_id', dp.id)
  .order('planned_start_at').limit(1).single();
const stops = ra.route_stops.sort((a, b) => a.stop_order - b.stop_order);
const destino = stops.find(s => s.reservations?.pickup_latitude != null);
const to = [destino.reservations.pickup_latitude, destino.reservations.pickup_longitude];

// Arranca desde su última posición conocida, o desde el centro de Rionegro.
const { data: last } = await svc.from('driver_locations')
  .select('latitude, longitude').eq('driver_profile_id', dp.id)
  .order('recorded_at', { ascending: false }).limit(1);
const from = last && last[0] ? [last[0].latitude, last[0].longitude] : [6.1550, -75.3740];

// La ruta REAL por carretera.
const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
const j = await (await fetch(url)).json();
if (!j.routes || !j.routes[0]) { console.error('OSRM no devolvió ruta'); process.exit(1); }
const path = j.routes[0].geometry.coordinates.map(p => [p[1], p[0]]);
const totalM = j.routes[0].distance;

console.log(`Conductor: ${pr.full_name} (ABC123)`);
console.log(`Va hacia:  ${(destino.reservations.pickup_address || '').split(',')[0]}`);
console.log(`Ruta real: ${(totalM / 1000).toFixed(1)} km · ${path.length} puntos · a ${KMH} km/h`);
console.log(`Ping cada ${PING_S}s (igual que la app). Ctrl+C para parar.\n`);

// Avanza por la polilínea a la velocidad pedida, un ping cada PING_S.
const msPerM = 3600 / KMH; // ms por metro
const distM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

let idx = 0, acc = 0;
const avancePorPing = (KMH * 1000 / 3600) * PING_S; // metros por ping

while (idx < path.length - 1) {
  // Avanza `avancePorPing` metros por la polilínea.
  let restante = avancePorPing;
  while (restante > 0 && idx < path.length - 1) {
    const seg = distM(path[idx], path[idx + 1]);
    if (seg > restante) {
      const f = restante / seg;
      path[idx] = [path[idx][0] + (path[idx + 1][0] - path[idx][0]) * f,
                   path[idx][1] + (path[idx + 1][1] - path[idx][1]) * f];
      acc += restante; restante = 0;
    } else { restante -= seg; acc += seg; idx++; }
  }
  const pos = path[idx];
  const { error } = await drv.from('driver_locations').insert({
    driver_profile_id: dp.id, route_assignment_id: ra.id,
    latitude: pos[0], longitude: pos[1], source: 'gps', speed_kmh: KMH,
  });
  const pct = Math.min(100, Math.round((acc / totalM) * 100));
  console.log(`  ${error ? '✗ ' + error.message : '✓'} ${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}  ·  ${pct}%  ·  faltan ${((totalM - acc) / 1000).toFixed(1)} km`);
  if (idx >= path.length - 1) break;
  await new Promise(r => setTimeout(r, PING_S * 1000));
}

console.log('\nLlegó al destino. En el admin el carro debió recorrer la vía.');
console.log('Para borrar las posiciones:  node scripts/mover-carro.mjs --limpiar');
