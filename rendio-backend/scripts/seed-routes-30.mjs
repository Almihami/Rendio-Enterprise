// Siembra 30 reservas de RUTAS en dev, distribuidas por Rionegro:
//   15 IDA    (home_to_airport)  = recogida en un punto de Rionegro -> aeropuerto MDE
//   15 VENIDA (airport_to_home)  = recogida en el aeropuerto MDE -> destino en Rionegro
// Todas para MAÑANA (hora Colombia) => quedan como el único día operativo => el
// planificador del admin las muestra las 30 juntas.
//
// Idempotente y SEGURO:
//   - ABORTA si SUPABASE_URL no es dev.
//   - Reutiliza auxiliares @rendio.demo existentes (conserva sus logins) y crea los faltantes.
//   - Borra SOLO las reservas de auxiliares @rendio.demo antes de recrear (no duplica).
//   - NO toca demo-admin (admin) ni demo-conductor (driver).
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: SUPABASE_URL no es dev'); process.exit(2); }
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PASS = 'DemoRendio2026!';
const D = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // mañana YYYY-MM-DD
const at = (t) => `${D}T${t}:00-05:00`;
const slug = (name) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ /g, '.');

// ---- 30 reservas en OLEADAS (mismo tipo + misma hora + sector cercano) para que el
//      asignador las agrupe de a 4/3/2 por carro (clave de oleada = type + '|' + HH:MM).
// [nombre, dirección, lat, lng, tipo('ida'|'ven'), hora]
const PEOPLE = [
  // — IDA (casa → MDE) · 15 —
  // Cada oleada = UN barrio compacto (pasajeros a ~150-250 m entre sí) para que la
  // ruta se abra hacia una sola zona y quede corta. Las 10 oleadas cubren zonas
  // distintas de Rionegro, así el mapa general sí queda repartido.
  // — IDA (casa → MDE) · 15 —
  // Oleada 1 · 05:00 · 4 pax · Centro
  ['Laura Gómez',        'Cra 50 #48-20, Centro',              6.1548, -75.3745, 'ida', '05:00'],
  ['Álvaro Correa',      'Cra 49 #50-12, Centro',              6.1556, -75.3752, 'ida', '05:00'],
  ['Mateo Cardona',      'Cra 51 #47-08, Centro',              6.1540, -75.3735, 'ida', '05:00'],
  ['Mariana Loaiza',     'Calle 48 #50-30, Centro',            6.1545, -75.3758, 'ida', '05:00'],
  // Oleada 2 · 06:30 · 3 pax · San Nicolás
  ['Melisa Vargas',      'Cra 55 #44-12, San Nicolás',         6.1470, -75.3785, 'ida', '06:30'],
  ['Patricia Díaz',      'Calle 44 #54-20, San Nicolás',       6.1478, -75.3792, 'ida', '06:30'],
  ['Simón Betancur',     'Cra 56 #45-06, San Nicolás',         6.1464, -75.3778, 'ida', '06:30'],
  // Oleada 3 · 08:00 · 2 pax · Cuatro Esquinas
  ['Camila Ríos',        'Cra 62 #42-18, Cuatro Esquinas',     6.1515, -75.3632, 'ida', '08:00'],
  ['Gabriela Salazar',   'Cra 63 #43-10, Cuatro Esquinas',     6.1522, -75.3625, 'ida', '08:00'],
  // Oleada 4 · 14:00 · 4 pax · El Porvenir
  ['Gustavo Mesa',       'Calle 47 #59-33, El Porvenir',       6.1455, -75.3845, 'ida', '14:00'],
  ['Daniel Ospina',      'Cra 60 #46-20, El Porvenir',         6.1448, -75.3852, 'ida', '14:00'],
  ['Valentina Zapata',   'Calle 48 #58-14, El Porvenir',       6.1462, -75.3838, 'ida', '14:00'],
  ['Nicolás Agudelo',    'Cra 59 #47-05, El Porvenir',         6.1458, -75.3858, 'ida', '14:00'],
  // Oleada 5 · 18:00 · 2 pax · San Antonio de Pereira
  ['Andrés Peña',        'Calle 24 #45-80, San Antonio',       6.1385, -75.3705, 'ida', '18:00'],
  ['Julio Castro',       'Cra 46 #22-30, San Antonio',         6.1378, -75.3712, 'ida', '18:00'],
  // — VENIDA (MDE → casa) · 15 —
  // Oleada 6 · 10:40 · 4 pax · Llanogrande
  ['Manuela Gil',        'Vía Llanogrande km 6',               6.1470, -75.4130, 'ven', '10:40'],
  ['Felipe Arango',      'Llanogrande, Unidad El Retiro',      6.1462, -75.4142, 'ven', '10:40'],
  ['Daniela Henao',      'Llanogrande, sector La Fe',          6.1480, -75.4120, 'ven', '10:40'],
  ['Luisa Ramírez',      'Vía Llanogrande km 7',               6.1455, -75.4150, 'ven', '10:40'],
  // Oleada 7 · 13:00 · 3 pax · Sajonia
  ['Tomás Bedoya',       'Vía Sajonia',                        6.1650, -75.4160, 'ven', '13:00'],
  ['Emiliano Duque',     'Vereda Sajonia',                     6.1660, -75.4172, 'ven', '13:00'],
  ['Martín Escobar',     'Sajonia, sector alto',              6.1642, -75.4150, 'ven', '13:00'],
  // Oleada 8 · 16:30 · 4 pax · Belchite (norte urbano)
  ['Sara Quintero',      'Calle 55 #48-22, Belchite',          6.1600, -75.3760, 'ven', '16:30'],
  ['Isabela Montoya',    'Cra 58 #54-05, Belchite',            6.1610, -75.3772, 'ven', '16:30'],
  ['Santiago Álvarez',   'Calle 57 #50-10, Belchite',          6.1592, -75.3748, 'ven', '16:30'],
  ['Carolina Restrepo',  'Cra 57 #56-20, Belchite',            6.1606, -75.3766, 'ven', '16:30'],
  // Oleada 9 · 19:00 · 2 pax · El Tablazo
  ['Antonia Vélez',      'Vereda El Tablazo',                  6.1745, -75.3960, 'ven', '19:00'],
  ['Samuel Ochoa',       'El Tablazo, sector centro',          6.1735, -75.3948, 'ven', '19:00'],
  // Oleada 10 · 21:10 · 2 pax · Cuatro Esquinas (oriente)
  ['Sebastián Marín',    'Cra 64 #46-20, Cuatro Esquinas',     6.1520, -75.3628, 'ven', '21:10'],
  ['Juliana Muñoz',      'Cra 65 #45-08, Cuatro Esquinas',     6.1512, -75.3618, 'ven', '21:10'],
];

// --- org ---
const { data: org1 } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
const org = org1.organization_id;

// --- aeropuerto MDE (crea si no existe) ---
let { data: apt } = await admin.from('airports').select('id').eq('iata_code', 'MDE').maybeSingle();
if (!apt) { const r = await admin.from('airports').insert({ organization_id: org, iata_code: 'MDE', name: 'José María Córdova', latitude: 6.1715, longitude: -75.4270 }).select('id').single(); apt = r.data; }

// --- limpieza: borra SOLO reservas de auxiliares @rendio.demo (no toca admin/driver) ---
// OJO: las reservas pueden estar referenciadas por route_stops (planes publicados en
// pruebas previas). Hay que borrar esas paradas (y las rutas huérfanas) ANTES, o la FK
// route_stops_reservation_id_fkey aborta el DELETE.
const { data: auxProfiles } = await admin.from('profiles').select('id').eq('role', 'auxiliar').like('email', '%@rendio.demo');
const auxIds = (auxProfiles || []).map(r => r.id);
if (auxIds.length) {
  const { data: aps } = await admin.from('auxiliar_profiles').select('id').in('profile_id', auxIds);
  const apIds = (aps || []).map(r => r.id);
  if (apIds.length) {
    const { data: prev } = await admin.from('reservations').select('id').in('auxiliar_profile_id', apIds);
    const prevIds = (prev || []).map(r => r.id);
    if (prevIds.length) {
      // 1) paradas que referencian esas reservas + rutas que quedan huérfanas
      const { data: stops } = await admin.from('route_stops').select('route_assignment_id').in('reservation_id', prevIds);
      const raIds = [...new Set((stops || []).map(s => s.route_assignment_id))];
      await admin.from('route_stops').delete().in('reservation_id', prevIds);
      for (const raId of raIds) {
        const { count: rem } = await admin.from('route_stops').select('id', { count: 'exact', head: true }).eq('route_assignment_id', raId);
        if ((rem || 0) === 0) await admin.from('route_assignments').delete().eq('id', raId);
      }
      // 2) ahora sí, las reservas
      const { error: delErr, count } = await admin.from('reservations').delete({ count: 'exact' }).in('id', prevIds);
      if (delErr) { console.error('LIMPIEZA reservas ERROR:', delErr.message); process.exit(1); }
      console.log('Reservas demo previas borradas: ' + (count ?? prevIds.length));
    }
  }
}

// --- helper: encuentra o crea el usuario auxiliar por email, devuelve su auxiliar_profile.id ---
async function ensureAux(name, addr, lat, lng, code) {
  const email = slug(name) + '@rendio.demo';
  // ¿ya existe el profile?
  let { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let uid = prof?.id;
  if (!uid) {
    const { data: cu, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } });
    if (error) { console.error('createUser', email, error.message); return null; }
    uid = cu.user.id;
    await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'auxiliar', full_name: name, email, is_active: true });
  }
  // auxiliar_profile: reutiliza o crea, actualiza domicilio a su punto de Rionegro
  let { data: ap } = await admin.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle();
  if (ap) {
    await admin.from('auxiliar_profiles').update({ home_address: addr, home_latitude: lat, home_longitude: lng }).eq('id', ap.id);
    return ap.id;
  }
  const { data: napi, error: e2 } = await admin.from('auxiliar_profiles').insert({ profile_id: uid, home_address: addr, home_latitude: lat, home_longitude: lng, employee_code: 'DEMO-' + code }).select('id').single();
  if (e2) { console.error('auxiliar_profile', email, e2.message); return null; }
  return napi.id;
}

// --- crea auxiliares + arma reservas ---
const rows = [];
let ida = 0, venida = 0;
for (let i = 0; i < PEOPLE.length; i++) {
  const [name, addr, lat, lng, tipo, time] = PEOPLE[i];
  const apId = await ensureAux(name, addr, lat, lng, i + 1);
  if (!apId) continue;
  const esIda = (tipo === 'ida');
  const dir = esIda ? 'home_to_airport' : 'airport_to_home';
  if (esIda) ida++; else venida++;
  rows.push({
    auxiliar_profile_id: apId,
    flight_id: null,
    direction: dir,
    status_h2a: esIda ? 'requested' : null,
    status_a2h: esIda ? null : 'scheduled',
    pickup_address: addr,
    pickup_latitude: lat,
    pickup_longitude: lng,
    required_arrival_at: at(time),
  });
}

const { error: insErr, count } = await admin.from('reservations').insert(rows, { count: 'exact' });
if (insErr) { console.error('INSERT reservations ERROR:', insErr.message); process.exit(1); }

console.log('SEED OK · fecha=' + D + ' · reservas=' + (count ?? rows.length) + ' (IDA=' + ida + ', VENIDA=' + venida + ')');
console.log('Login auxiliar demo: laura.gomez@rendio.demo / ' + PASS);
