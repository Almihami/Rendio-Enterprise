// Siembra en la base LOCAL una organización aparte para MIRAR la tarjeta
// «Tiempos reales de los viajes» (0116) con dos semanas de viajes FICTICIOS.
//
//   cd rendio-backend && eval "$(supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')" \
//     && node scripts/_seed-tiempos-0116-local.mjs
//
// Aplica 0116 a la base local y crea la org «Prueba tiempos 0116» con su jefa,
// dos conductores, ocho conjuntos del Oriente (con su zona de Julián) y 14 días
// de salidas y llegadas con marcas y GPS. Uno de los conductores, a veces, marca
// todo junto al llegar al aeropuerto (para ver los «dudosos»). Un domingo cae en
// la mitad (para ver «Domingo y festivo»). Se puede correr otra vez: borra la org
// de la corrida anterior y la vuelve a crear. Nunca apunta a dev ni a producción.
//
// La jefa de prueba entra con JEFA_EMAIL / JEFA_CLAVE (solo existen en la base local).
import fs from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

export const JEFA_EMAIL = 'jefa.tiempos0116@prueba.local';
export const JEFA_CLAVE = 'Tiempos0116-local!';
const ORG_NAME = 'Prueba tiempos 0116';
const API = process.env.API_URL || 'http://127.0.0.1:54321';
const SRK = process.env.SERVICE_ROLE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(API)) { console.error('ABORT: solo la base local'); process.exit(2); }
if (!SRK) { console.error('Falta SERVICE_ROLE_KEY (supabase status -o env)'); process.exit(2); }

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];

// 1. 0116 en la base local (idempotente).
await c.query(fs.readFileSync(new URL('../supabase/migrations/0116_tiempos_aprendidos.sql', import.meta.url), 'utf8'));
console.log('✓ 0116 aplicada a la base local');

// 2. La org de la corrida anterior, fuera.
for (const o of await q(`SELECT id FROM public.organizations WHERE name = $1`, [ORG_NAME])) {
  const ras = (await q(`SELECT DISTINCT rs.route_assignment_id id FROM public.route_stops rs
      JOIN public.reservations r ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr ON pr.id = ap.profile_id WHERE pr.organization_id = $1`, [o.id])).map(x => x.id);
  await q(`DELETE FROM public.route_trip_legs WHERE organization_id = $1`, [o.id]);
  if (ras.length) {
    await q(`DELETE FROM public.route_stops WHERE route_assignment_id = ANY($1::uuid[])`, [ras]);
    await q(`DELETE FROM public.driver_locations WHERE route_assignment_id = ANY($1::uuid[])`, [ras]);
    await q(`DELETE FROM public.route_assignments WHERE id = ANY($1::uuid[])`, [ras]);
  }
  await q(`DELETE FROM public.reservations WHERE auxiliar_profile_id IN (SELECT ap.id FROM public.auxiliar_profiles ap
      JOIN public.profiles pr ON pr.id = ap.profile_id WHERE pr.organization_id = $1)`, [o.id]);
  const users = (await q(`SELECT id FROM public.profiles WHERE organization_id = $1`, [o.id])).map(x => x.id);
  await q(`DELETE FROM public.driver_locations WHERE driver_profile_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.profile_id = ANY($1::uuid[]))`, [users]);
  await q(`DELETE FROM public.auxiliar_profiles WHERE profile_id = ANY($1::uuid[])`, [users]);
  await q(`DELETE FROM public.driver_profiles WHERE profile_id = ANY($1::uuid[])`, [users]);
  await q(`DELETE FROM public.vehicles WHERE organization_id = $1`, [o.id]);
  await q(`DELETE FROM public.residences WHERE organization_id = $1`, [o.id]);
  await q(`DELETE FROM public.airports WHERE organization_id = $1`, [o.id]);
  await q(`DELETE FROM public.profiles WHERE organization_id = $1`, [o.id]);
  await q(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
  await q(`DELETE FROM public.organizations WHERE id = $1`, [o.id]);
}
await q(`DELETE FROM auth.users WHERE email = $1`, [JEFA_EMAIL]);

const org = (await one(`INSERT INTO public.organizations (name, slug) VALUES ($1, 'prueba-tiempos-0116-' || substr(md5(random()::text), 1, 6)) RETURNING id`, [ORG_NAME])).id;
const APT = { lat: 6.170795, lng: -75.427887 };   // JMC (0059)
await q(`INSERT INTO public.airports (organization_id, iata_code, name, latitude, longitude) VALUES ($1, 'MDE', 'José María Córdova', $2, $3)`, [org, APT.lat, APT.lng]);

// Ocho conjuntos ficticios en sitios reales del Oriente, con su zona de Julián
// puesta a mano (las zonas son globales y no se dibujan aquí). `vel` = km/h
// típicos hasta el aeropuerto (Marinilla es lo caro).
const CONJ = [
  { name: 'Olivar (prueba)',          lat: 6.1523, lng: -75.3781, zona: 'Fontibón',           vel: 34 },
  { name: 'Solare (prueba)',          lat: 6.1489, lng: -75.3822, zona: 'Fontibón',           vel: 34 },
  { name: 'Cámbulo (prueba)',         lat: 6.1611, lng: -75.3712, zona: 'Porvenir',           vel: 38 },
  { name: 'Los Cerezos (prueba)',     lat: 6.1540, lng: -75.3745, zona: 'Porvenir',           vel: 38 },
  { name: 'Sendai (prueba)',          lat: 6.1402, lng: -75.3904, zona: 'Sendai/San Antonio', vel: 36 },
  { name: 'Llanogrande (prueba)',     lat: 6.1175, lng: -75.4152, zona: null,                 vel: 40 },
  { name: 'Marinilla Centro (prueba)', lat: 6.1739, lng: -75.3360, zona: 'Marinilla',         vel: 42 },
  { name: 'Marinilla Vereda (prueba)', lat: 6.1820, lng: -75.3250, zona: 'Marinilla',         vel: 40 },
];
for (const cj of CONJ) {
  cj.id = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector, zona_jefe)
    VALUES ($1, $2, $3, $4, 'Prueba', $5) RETURNING id`, [org, cj.name, cj.lat, cj.lng, cj.zona])).id;
}

// 3. La jefa (con clave, por la API de auth local).
const r = await fetch(API + '/auth/v1/admin/users', {
  method: 'POST', headers: { apikey: SRK, Authorization: 'Bearer ' + SRK, 'content-type': 'application/json' },
  body: JSON.stringify({ email: JEFA_EMAIL, password: JEFA_CLAVE, email_confirm: true }),
});
const ju = await r.json();
if (!r.ok || !ju.id) { console.error('No se pudo crear la jefa:', JSON.stringify(ju)); process.exit(1); }
await q(`INSERT INTO public.profiles (id, organization_id, role, full_name, email) VALUES ($1, $2, 'admin', 'Jefa de prueba (tiempos)', $3)
         ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'admin', full_name = EXCLUDED.full_name, deleted_at = NULL`, [ju.id, org, JEFA_EMAIL]);

async function usuario(role, name) {
  const email = role + '.' + name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '') + '.t0116@prueba.local';
  const u = (await one(`INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now()) RETURNING id`, [email])).id;
  await q(`INSERT INTO public.profiles (id, organization_id, role, full_name, email) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = EXCLUDED.role, full_name = EXCLUDED.full_name`, [u, org, role, name, email]);
  return u;
}
const conductores = [];
for (const n of ['Andrés Prueba', 'Mario Prueba']) {
  const u = await usuario('driver', n);
  conductores.push({ n, id: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id });
}
const carro = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'T-16', 'TMP116') RETURNING id`, [org])).id;

// Un tripulante por reserva (así ninguna regla de «una por día» estorba).
let nTrip = 0;
async function reserva(dir, cj, dl) {
  const u = await usuario('auxiliar', 'Tripulante ' + (++nTrip));
  const aux = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, cj.id])).id;
  return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at,
      residence_id, pickup_address, pickup_latitude, pickup_longitude, notes)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      $3, $4, $5, $6, $7, 'Prueba tiempos 0116') RETURNING id`, [aux, dir, dl, cj.id, cj.name, cj.lat, cj.lng])).id;
}

// Azar con semilla: la misma siembra cada vez.
let seed = 116;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const km = (a, b) => {
  const R = 6371, t = (x) => x * Math.PI / 180;
  const s = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
// Minutos de manejo con desvío de vías ×1,4, más ruido; de madrugada más rápido.
const manejo = (a, b, vel, hora) => {
  const v = vel * (hora >= 2 && hora < 6 ? 1.15 : hora >= 6 && hora < 9 ? 0.8 : 1);
  return Math.max(3, km(a, b) * 1.4 / v * 60 * (0.9 + rnd() * 0.35));
};
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const iso = (d) => d.toISOString();
async function ping(drv, ra, p, at) {
  await q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
    VALUES ($1, $2, $3, $4, 'gps', $5)`, [drv, ra, p.lat + (rnd() - 0.5) * 0.0006, p.lng + (rnd() - 0.5) * 0.0006, iso(at)]);
}

// 4. Catorce días hacia atrás (hora de Bogotá = UTC−5).
const hoy = new Date();
let nVueltas = 0, nMal = 0;
for (let d = 14; d >= 1; d--) {
  const dia = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - d));
  const domingo = dia.getUTCDay() === 0;
  const aBogota = (h, m) => new Date(dia.getTime() + ((h + 5) * 60 + m) * 60000);
  // Salidas: presentaciones repartidas en el día, más de madrugada.
  const presentaciones = [[4, 0], [4, 40], [5, 20], [6, 30], [10, 0], [15, 30]].filter(() => rnd() > (domingo ? 0.5 : 0.15));
  for (const [h, m] of presentaciones) {
    const drv = pick(conductores);
    // Mario, a veces, marca todo junto al llegar al aeropuerto.
    const marcaMal = drv.n === 'Mario Prueba' && rnd() < 0.3;
    const n = 1 + Math.floor(rnd() * 3);
    const paradas = [];
    const primero = pick(CONJ);
    paradas.push(primero);
    for (let i = 1; i < n; i++) paradas.push(rnd() < 0.3 ? paradas[i - 1] : pick(CONJ));
    // Barrido hacia el aeropuerto: el más lejano primero.
    paradas.sort((a, b) => km(b, APT) - km(a, APT));
    const pres = aBogota(h, m);
    // Hacia atrás desde la llegada al aeropuerto (con margen de 8–25 min, a veces menos).
    const margen = rnd() < 0.1 ? -3 + rnd() * 8 : 8 + rnd() * 17;
    let llegaApt = addMin(pres, -margen);
    const tramos = [];
    let t = llegaApt;
    let prev = APT;
    for (let i = paradas.length - 1; i >= 0; i--) {
      const p = paradas[i];
      const viaje = p === prev ? 0 : manejo(p, prev, p.vel, h);
      const recoge = addMin(t, -viaje);
      const espera = 0.5 + rnd() * (rnd() < 0.2 ? 9 : 4);
      const llega = addMin(recoge, -espera);
      tramos.unshift({ p, llega, recoge });
      t = llega; prev = p;
    }
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'completed', $3) RETURNING id`, [drv.id, carro, iso(addMin(tramos[0].llega, -15))])).id;
    let orden = 0;
    for (const x of tramos) {
      const rid = await reserva('home_to_airport', x.p, iso(pres));
      // El plan dijo una hora un poco distinta (el carro llega −4…+9 min de lo planeado).
      const eta = addMin(x.llega, -(-4 + rnd() * 13));
      const arr = marcaMal ? addMin(llegaApt, 0.2 * orden) : x.llega;
      const pk = marcaMal ? addMin(llegaApt, 0.2 * orden + 0.1) : x.recoge;
      await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at,
          actual_arrival_at, actual_pickup_at, actual_dropoff_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'delivered')`,
        [ra, rid, ++orden, iso(eta), iso(arr), iso(pk), iso(addMin(llegaApt, marcaMal ? 1 : 0))]);
      if (marcaMal) await ping(drv.id, ra, APT, arr);
      else { await ping(drv.id, ra, x.p, x.llega); await ping(drv.id, ra, x.p, x.recoge); }
    }
    await ping(drv.id, ra, APT, addMin(llegaApt, marcaMal ? 1 : 0));
    nVueltas++; if (marcaMal) nMal++;
  }
  // Llegadas.
  for (const [h, m] of [[9, 40], [17, 10], [21, 30]].filter(() => rnd() > 0.35)) {
    const drv = pick(conductores);
    const n = 1 + Math.floor(rnd() * 3);
    const paradas = [];
    for (let i = 0; i < n; i++) paradas.push(pick(CONJ));
    paradas.sort((a, b) => km(a, APT) - km(b, APT));   // el más cercano primero
    const sale = aBogota(h, m + 20 + Math.round(rnd() * 15));
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'airport_to_home', 'completed', $3) RETURNING id`, [drv.id, carro, iso(aBogota(h, m))])).id;
    let t = sale, prev = APT, orden = 0;
    await ping(drv.id, ra, APT, sale);
    for (const p of paradas) {
      const rid = await reserva('airport_to_home', p, iso(aBogota(h, m)));
      t = addMin(t, p === prev ? 0.5 : manejo(prev, p, p.vel, h));
      orden++;
      await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order,
          actual_arrival_at, actual_pickup_at, actual_dropoff_at, status) VALUES ($1, $2, $3, $4, $5, $6, 'delivered')`,
        [ra, rid, orden, iso(addMin(sale, -12)), iso(addMin(sale, -(n - orden) * 0.7)), iso(t)]);
      await ping(drv.id, ra, p, t);
      prev = p;
    }
    nVueltas++;
  }
}
console.log(`✓ ${nVueltas} vueltas ficticias en 14 días (${nMal} marcadas todas juntas en el aeropuerto)`);

const med = await one(`SELECT public.collect_trip_legs('2000-01-01'::timestamptz) AS r`);
console.log('✓ medición:', JSON.stringify(med.r));
console.log(`\nJefa de prueba: ${JEFA_EMAIL} / ${JEFA_CLAVE}  (Rutas › Configuración › Calibración › Tiempos reales)`);
await c.end();
