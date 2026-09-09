// Prueba en DEV: horario publicado de la semana + 3 reservas reales en El Porvenir
// para la jornada de la TARDE de hoy. Deja el pool listo para que el admin
// optimice, asigne conductor y publique el plan.
// Idempotente. Solo DEV. Uso:
//   cd rendio-backend/scripts && set -a; source ../.env.dev; set +a; node seed-prueba-porvenir.mjs
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: no es dev'); process.exit(2); }
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PASS = 'DemoRendio2026!';
// Día operativo = HOY en hora de Colombia.
const DAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const at = (t) => `${DAY}T${t}:00-05:00`;
const PRESENTACION = '19:30';  // "deben estar" en MDE (lo que ve el tablero)
const VUELO_SALE = '20:30';

const { data: org1 } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
const org = org1.organization_id;

// ---------------------------------------------------------------- 1. HORARIO
// Semana en curso (lunes). Rotación coherente con las reglas del scheduler:
// 2 AM + 2 PM por día, líder ⊆ jornada, sin doble turno, sin PM→AM al día
// siguiente, respetando los descansos fijos de driver_rules.
const d = new Date(DAY + 'T00:00:00'); const wd = d.getDay();
d.setDate(d.getDate() - wd + (wd === 0 ? -6 : 1));
const WEEK = d.toISOString().slice(0, 10);

const P = {
  daniel:    '8e6cb653-416b-4763-b703-c2e19c440ed2', // líder
  jefferson: '5dd26752-14e2-4437-87e9-37da757d8aa8', // líder
  franco:    '9ae89885-2230-4f68-9615-510ccac86d9b', // líder
  andres:    '72efebfd-8f9c-4cc2-bb13-549e31c5f3f2', // descanso fijo: domingo
  mario:     '51bda402-1bc8-448e-ad71-ad0d0c367093',
  mery:      'c2256252-dbdb-406e-af4f-09718160ea90', // descansos fijos: mar PM, mié, jue PM
  julian:    '0776dcab-be80-40d9-afd6-e26218e8101e',
  sebastian: 'a03b9b05-4ca1-456b-b984-c896ab8d06b2',
  tester:    'c4b9cd3a-109f-49ce-8521-b95682ef57e0',
};
const NAMES = {
  [P.daniel]: 'Daniel Alvarez Torres', [P.jefferson]: 'Jefferson Cardona Arias',
  [P.franco]: 'Juan Jose Franco', [P.andres]: 'Andres Felipe Cardona Arias',
  [P.mario]: 'Carlos Mario Roldan Valencia', [P.mery]: 'Juan Andres Mery Franco',
  [P.julian]: 'Julián David López', [P.sebastian]: 'Sebastian Gomez Ciro',
  [P.tester]: 'Tester Rendio',
};
const ALL = Object.values(P);
// [líderAM, acompañanteAM, líderPM, acompañantePM]
const ROT = {
  mon: [P.daniel, P.andres,    P.jefferson, P.mario],
  tue: [P.franco, P.mery,      P.daniel,    P.julian],
  wed: [P.jefferson, P.sebastian, P.franco, P.tester],
  thu: [P.daniel, P.mario,     P.jefferson, P.andres],
  fri: [P.franco, P.julian,    P.daniel,    P.sebastian],
  sat: [P.jefferson, P.tester, P.franco,    P.julian],   // ← Julián: TARDE del sábado
  sun: [P.daniel, P.mery,      P.jefferson, P.mario],
};
const schedule = { _names: NAMES };
for (const [day, [lam, am2, lpm, pm2]] of Object.entries(ROT)) {
  const morning = [lam, am2], afternoon = [lpm, pm2];
  schedule[day] = {
    morning, afternoon,
    coord_am: [lam], coord_pm: [lpm],
    rest: ALL.filter(id => !morning.includes(id) && !afternoon.includes(id)),
  };
}

const { data: prev } = await admin.from('weekly_schedules').select('id').eq('week_start_date', WEEK).maybeSingle();
if (prev) {
  const { error } = await admin.from('weekly_schedules').update({ data: schedule, published: true }).eq('id', prev.id);
  if (error) { console.error('horario update', error.message); process.exit(1); }
  console.log(`Horario semana ${WEEK}: ACTUALIZADO y publicado (id ${prev.id})`);
} else {
  const { error } = await admin.from('weekly_schedules').insert({ week_start_date: WEEK, data: schedule, published: true });
  if (error) { console.error('horario insert', error.message); process.exit(1); }
  console.log(`Horario semana ${WEEK}: CREADO y publicado`);
}

// ------------------------------------------------- 2. Contraseña conocida a los
// conductores en turno PM de hoy (dev: cuentas de prueba).
const DAYKEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(DAY + 'T00:00:00').getDay()];
for (const pid of schedule[DAYKEY].afternoon) {
  const { error } = await admin.auth.admin.updateUserById(pid, { password: PASS });
  console.log(`  conductor PM ${NAMES[pid]} → contraseña ${error ? 'ERROR ' + error.message : 'fijada'}`);
}

// ------------------------------------------------------------------ 3. VUELO
const { data: apt } = await admin.from('airports').select('id').eq('iata_code', 'MDE').single();
const FLIGHT_NO = 'AV-9648';
await admin.from('flights').delete().eq('flight_number', FLIGHT_NO);
const { data: fl, error: flErr } = await admin.from('flights').insert({
  airport_id: apt.id, flight_number: FLIGHT_NO, direction: 'home_to_airport',
  scheduled_at: at(VUELO_SALE), status: 'scheduled', required_auxiliars: 3,
}).select('id').single();
if (flErr) { console.error('vuelo', flErr.message); process.exit(1); }
console.log(`Vuelo ${FLIGHT_NO} sale ${VUELO_SALE} · presentación ${PRESENTACION}`);

// ------------------------------------------- 4. AUXILIARES + RESERVAS (Porvenir)
// Mismo "deben estar" para los tres → una sola oleada → una ruta de 3 paradas.
const AUX = [
  ['Sofía Restrepo', 'sofia.restrepo@rendio.demo', 'Cra 59 #48-22, El Porvenir', 6.1461, -75.3856, 'PRV-1'],
  ['Andrés Villa',   'andres.villa@rendio.demo',   'Calle 47 #57-40, El Porvenir', 6.1451, -75.3833, 'PRV-2'],
  ['Marcela Ossa',   'marcela.ossa@rendio.demo',   'Cra 61 #45-18, El Porvenir', 6.1443, -75.3861, 'PRV-3'],
];

for (const [name, email, addr, lat, lng, code] of AUX) {
  // ¿ya existe? (idempotencia: se reusa la cuenta y se limpia su reserva de hoy)
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
      .insert({ profile_id: uid, home_address: addr, home_latitude: lat, home_longitude: lng, employee_code: code })
      .select('id').single();
    if (r.error) { console.error('auxiliar_profiles', email, r.error.message); continue; }
    ap = r.data;
  } else {
    await admin.from('auxiliar_profiles').update({ home_address: addr, home_latitude: lat, home_longitude: lng }).eq('id', ap.id);
  }
  // Limpia una reserva previa del mismo día (re-correr el script no duplica).
  const { data: old } = await admin.from('reservations').select('id')
    .eq('auxiliar_profile_id', ap.id).gte('required_arrival_at', DAY + 'T00:00:00-05:00');
  for (const o of (old || [])) {
    await admin.from('route_stops').delete().eq('reservation_id', o.id);
    await admin.from('reservations').delete().eq('id', o.id);
  }
  const { error: rErr } = await admin.from('reservations').insert({
    auxiliar_profile_id: ap.id, flight_id: fl.id, direction: 'home_to_airport',
    status_h2a: 'requested', status_a2h: null,
    pickup_address: addr, pickup_latitude: lat, pickup_longitude: lng,
    required_arrival_at: at(PRESENTACION),
  });
  console.log(`  ${rErr ? 'ERROR ' + rErr.message : 'OK'} · ${name} · ${email} · ${addr}`);
}

console.log(`\nLISTO · día operativo ${DAY} · presentación ${PRESENTACION} · contraseña única: ${PASS}`);
