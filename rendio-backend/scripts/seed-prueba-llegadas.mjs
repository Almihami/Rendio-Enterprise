// Prueba en DEV: LLEGADAS (MDE → Rionegro). Deja 3 auxiliares que aterrizan en
// el mismo vuelo y hay que repartir en sectores distintos del municipio.
// Borra la prueba anterior de SALIDAS del Porvenir. Idempotente. Solo DEV.
//   cd rendio-backend/scripts && set -a; source ../.env.dev; set +a; node seed-prueba-llegadas.mjs
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: no es dev'); process.exit(2); }
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PASS = 'DemoRendio2026!';
const DAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const at = (t) => `${DAY}T${t}:00-05:00`;
const ATERRIZA = '19:35';        // hora en que toca tierra el vuelo
const FLIGHT_NO = 'AV-9531';

const { data: org1 } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
const org = org1.organization_id;

// ------------------------------------- 1. Fuera la prueba de SALIDAS del Porvenir
const SALIDAS = ['sofia.restrepo@rendio.demo', 'andres.villa@rendio.demo', 'marcela.ossa@rendio.demo'];
const { data: sp } = await admin.from('profiles').select('id').in('email', SALIDAS);
const { data: sap } = await admin.from('auxiliar_profiles').select('id').in('profile_id', (sp || []).map(x => x.id));
const sapIds = (sap || []).map(x => x.id);
if (sapIds.length) {
  const { data: viejas } = await admin.from('reservations').select('id')
    .in('auxiliar_profile_id', sapIds).gte('required_arrival_at', DAY + 'T00:00:00-05:00');
  for (const v of (viejas || [])) {
    await admin.from('route_stops').delete().eq('reservation_id', v.id);
    await admin.from('reservations').delete().eq('id', v.id);
  }
  console.log(`Salidas del Porvenir borradas: ${(viejas || []).length} reservas (las cuentas quedan intactas)`);
}
await admin.from('flights').delete().eq('flight_number', 'AV-9648');
console.log('Vuelo AV-9648 (el de las salidas) borrado');

// ------------------------------------------------------ 2. Vuelo de llegada real
const { data: apt } = await admin.from('airports').select('id').eq('iata_code', 'MDE').single();
await admin.from('flights').delete().eq('flight_number', FLIGHT_NO);
const { data: fl, error: flErr } = await admin.from('flights').insert({
  airport_id: apt.id, flight_number: FLIGHT_NO, direction: 'airport_to_home',
  scheduled_at: at(ATERRIZA), status: 'scheduled', required_auxiliars: 3,
}).select('id').single();
if (flErr) { console.error('vuelo', flErr.message); process.exit(1); }

// ------------------------------------------------- 3. Los 3 que hay que repartir
// Sectores REALES de Rionegro, bien separados entre sí, para que el asignador
// tenga que decidir a quién deja primero. Coordenadas verificadas contra el
// aeropuerto (6.1715, -75.4270).
const AUX = [
  ['Valeria Ochoa',  'prueba.valeria@rendio.demo', 'Km 6 vía Llanogrande, Llanogrande',   6.1290, -75.4130, 'Prueba llegada — unidad Jardines, portería 2'],
  ['Camila Suárez',  'prueba.camila@rendio.demo',  'Cra 51 #47-30, Centro',               6.1540, -75.3742, 'Prueba llegada — casa con reja verde'],
  ['Mateo Herrera',  'prueba.mateo@rendio.demo',   'Cra 50 #38-20, San Antonio de Pereira', 6.1723, -75.3573, 'Prueba llegada — portería, apto 302'],
];

for (const [name, email, addr, lat, lng, nota] of AUX) {
  let { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let uid = prof?.id;
  if (!uid) {
    const { data: cu, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true, user_metadata: { full_name: name } });
    if (error) { console.error('createUser', email, error.message); continue; }
    uid = cu.user.id;
    await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'auxiliar', full_name: name, email, is_active: true });
  } else {
    await admin.auth.admin.updateUserById(uid, { password: PASS });
  }
  let { data: ap } = await admin.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle();
  if (!ap) {
    const r = await admin.from('auxiliar_profiles')
      .insert({ profile_id: uid, home_address: addr, home_latitude: lat, home_longitude: lng, employee_code: 'PRB-' + name.slice(0, 4).toUpperCase() })
      .select('id').single();
    if (r.error) { console.error('auxiliar_profiles', email, r.error.message); continue; }
    ap = r.data;
  } else {
    await admin.from('auxiliar_profiles').update({ home_address: addr, home_latitude: lat, home_longitude: lng }).eq('id', ap.id);
  }
  // Una sola reserva de hoy por persona (re-correr no duplica).
  const { data: old } = await admin.from('reservations').select('id')
    .eq('auxiliar_profile_id', ap.id).gte('required_arrival_at', DAY + 'T00:00:00-05:00');
  for (const o of (old || [])) {
    await admin.from('route_stops').delete().eq('reservation_id', o.id);
    await admin.from('reservations').delete().eq('id', o.id);
  }
  const { error: rErr } = await admin.from('reservations').insert({
    auxiliar_profile_id: ap.id, flight_id: fl.id, direction: 'airport_to_home',
    status_h2a: null, status_a2h: 'scheduled',
    pickup_address: addr, pickup_latitude: lat, pickup_longitude: lng,
    required_arrival_at: at(ATERRIZA), notes: nota,
  });
  console.log(`  ${rErr ? 'ERROR ' + rErr.message : 'OK'} · ${name} · ${email} · ${addr}`);
}

console.log(`\nLISTO · ${FLIGHT_NO} aterriza ${ATERRIZA} · recogida en MDE ~19:55 (20 min de desembarque) · contraseña ${PASS}`);
