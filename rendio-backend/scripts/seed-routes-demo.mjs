// Siembra datos demo de RUTAS en dev: aeropuerto MDE + auxiliares + vuelos + reservas.
// Idempotente: limpia lo demo previo (@rendio.demo) antes de recrear. Solo DEV.
import { createClient } from '@supabase/supabase-js';
const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL||'').includes(DEV_REF)) { console.error('ABORT: no es dev'); process.exit(2); }
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PASS = 'DemoRendio2026!';
const D = new Date(Date.now() + 86400000).toISOString().slice(0,10); // mañana
const at = (t) => `${D}T${t}:00-05:00`;

const { data: org1 } = await admin.from('profiles').select('organization_id').not('organization_id','is',null).limit(1).single();
const org = org1.organization_id;

// --- limpieza idempotente de lo demo previo ---
const { data: oldAux } = await admin.from('profiles').select('id').like('email','%@rendio.demo');
const oldIds = (oldAux||[]).map(r=>r.id);
if (oldIds.length) {
  const { data: aps } = await admin.from('auxiliar_profiles').select('id').in('profile_id', oldIds);
  const apIds = (aps||[]).map(r=>r.id);
  if (apIds.length) await admin.from('reservations').delete().in('auxiliar_profile_id', apIds);
  await admin.from('auxiliar_profiles').delete().in('profile_id', oldIds);
  await admin.from('profiles').delete().in('id', oldIds);
  for (const id of oldIds) { try { await admin.auth.admin.deleteUser(id); } catch(e){} }
}
const FLIGHTNOS = ['AV-9412','AV-9520','AV-9308','AV-9527','AV-9533'];
await admin.from('flights').delete().in('flight_number', FLIGHTNOS);

// --- aeropuerto MDE (crea si no existe) ---
let { data: apt } = await admin.from('airports').select('id').eq('iata_code','MDE').maybeSingle();
if (!apt) { const r = await admin.from('airports').insert({ organization_id: org, iata_code:'MDE', name:'José María Córdova', latitude:6.1715, longitude:-75.4270 }).select('id').single(); apt = r.data; }
const airportId = apt.id;

// --- vuelos ---
const flights = {};
for (const [no, dir, t] of [
  ['AV-9412','home_to_airport','06:00'], ['AV-9520','home_to_airport','07:00'], ['AV-9308','home_to_airport','05:30'],
  ['AV-9527','airport_to_home','10:40'], ['AV-9533','airport_to_home','21:10'],
]) {
  const r = await admin.from('flights').insert({ airport_id: airportId, flight_number: no, direction: dir, scheduled_at: at(t), status:'scheduled', required_auxiliars: 2 }).select('id').single();
  flights[no] = r.data.id;
}

// --- auxiliares + reservas (direcciones reales de Rionegro) ---
const AUX = [
  ['Laura Gómez',    'Cra 51 #49-06, Centro',          6.1529,-75.3752,'sal','AV-9412','05:10'],
  ['Andrés Peña',    'Calle 47 #59-33, El Porvenir',   6.1468,-75.3849,'sal','AV-9412','05:10'],
  ['Camila Ríos',    'Cra 62 #42-18, Cuatro Esquinas', 6.1512,-75.3628,'sal','AV-9520','06:30'],
  ['Melisa Vargas',  'Cra 55 #44-12, San Nicolás',     6.1470,-75.3781,'sal','AV-9520','06:30'],
  ['Julio Castro',   'Calle 24 #45-80, San Antonio',   6.1310,-75.3795,'sal','AV-9308','05:00'],
  ['Patricia Díaz',  'Calle 43 #55-20, San Nicolás',   6.1473,-75.3778,'lle','AV-9527','10:40'],
  ['Álvaro Correa',  'Cra 51 #50-12, Centro',          6.1535,-75.3748,'lle','AV-9527','10:40'],
  ['Gustavo Mesa',   'Vía Llanogrande km 6',           6.1290,-75.4130,'lle','AV-9533','21:10'],
];
let n = 0;
for (const [name, addr, lat, lng, type, flightNo, time] of AUX) {
  const email = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/ /g,'.') + '@rendio.demo';
  const { data: cu, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } });
  if (error) { console.error('createUser', email, error.message); continue; }
  const uid = cu.user.id;
  await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'auxiliar', full_name: name, email, is_active: true });
  const { data: ap } = await admin.from('auxiliar_profiles').insert({ profile_id: uid, home_address: addr, home_latitude: lat, home_longitude: lng, employee_code: 'DEMO-'+(++n) }).select('id').single();
  const dir = type === 'lle' ? 'airport_to_home' : 'home_to_airport';
  await admin.from('reservations').insert({
    auxiliar_profile_id: ap.id, flight_id: flights[flightNo], direction: dir,
    status_h2a: type === 'lle' ? null : 'requested', status_a2h: type === 'lle' ? 'scheduled' : null,
    pickup_address: addr, pickup_latitude: lat, pickup_longitude: lng, required_arrival_at: at(time),
  });
}
console.log('SEED OK · fecha=' + D + ' · auxiliares=' + AUX.length + ' · vuelos=' + FLIGHTNOS.length + ' · aeropuerto MDE=' + airportId);
console.log('Login auxiliar demo: laura.gomez@rendio.demo / ' + PASS);
