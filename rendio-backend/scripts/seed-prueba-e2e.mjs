#!/usr/bin/env node
// seed-prueba-e2e.mjs — Datos de PRUEBA REALES en dev para el recorrido completo
// auxiliar → admin → conductor. 2026-07-25.
//
// No es "data mockeada": son usuarios y reservas de verdad en la BD, que pasan
// por el mismo camino que los datos de producción. Lo que se quitó de la app
// fueron los objetos hardcodeados en el frontend (ver [project-sin-datos-demo]).
//
// Crea/asegura (idempotente, por email y por reserva del día):
//   · 4 auxiliares en sectores distintos de Rionegro (uno es el de la profa)
//   · 3 reservas para el día objetivo (la 4ª la crea la profa desde la app)
//   · horario PUBLICADO de esa semana con el conductor Tester en AM y PM
//
// Uso:  set -a; source ../.env.dev; set +a; node seed-prueba-e2e.mjs [--limpiar]
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: no es dev'); process.exit(2); }

const PASSWORD = 'DemoRendio2026!';
const ORG_SLUG = 'rendio';
const TESTER_EMAIL = 'tester@rendio.co';

// Día objetivo: el próximo LUNES (día operativo limpio, semana sin horario aún).
function proximoLunes() {
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const d = new Date(hoy); d.setHours(0, 0, 0, 0);
  const delta = (8 - d.getDay()) % 7 || 7;   // siempre el lunes SIGUIENTE
  d.setDate(d.getDate() + delta);
  return d.toLocaleDateString('en-CA');
}
const DIA = process.env.DIA_PRUEBA || proximoLunes();
const SEMANA = DIA; // el día objetivo ES lunes → arranque de semana

const AUXILIARES = [
  // Los 4 viven en El Porvenir, a menos de ~400 m entre sí: la ruta queda corta
  // y se ve claro cómo el asignador los junta en un solo carro.
  { email: 'auxiliar.prueba@rendio.demo', full_name: 'Auxiliar Prueba', esDeLaProfa: true,
    dir: 'Calle 47 #59-33, B. El Porvenir, Rionegro', lat: 6.1468, lng: -75.3849,
    vuelo: 'AV-9412', hora: '05:10' },
  { email: 'prueba.valeria@rendio.demo', full_name: 'Valeria Ochoa',
    dir: 'Cra 60 #46-15, B. El Porvenir, Rionegro', lat: 6.1455, lng: -75.3861,
    vuelo: 'AV-9412', hora: '05:10' },
  { email: 'prueba.mateo@rendio.demo', full_name: 'Mateo Herrera',
    dir: 'Calle 45 #58-20, B. El Porvenir, Rionegro', lat: 6.1449, lng: -75.3838,
    vuelo: 'AV-9412', hora: '05:10' },
  { email: 'prueba.camila@rendio.demo', full_name: 'Camila Suárez',
    dir: 'Cra 58 #48-40, B. El Porvenir, Rionegro', lat: 6.1477, lng: -75.3832,
    vuelo: 'LA-4011', hora: '06:20' },
];

const log = (s) => console.log(s);

async function orgId() {
  const { data } = await sb.from('organizations').select('id').eq('slug', ORG_SLUG).single();
  return data.id;
}
async function buscarAuth(email) {
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error('listUsers: ' + error.message);
    const u = data.users.find(x => x.email?.toLowerCase() === email.toLowerCase());
    if (u) return u;
    if (data.users.length < 200) break;
  }
  return null;
}

async function asegurarAuxiliar(org, a) {
  let user = await buscarAuth(a.email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: a.email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: a.full_name },
    });
    if (error) throw new Error(`createUser(${a.email}): ${error.message}`);
    user = data.user;
    log(`  + usuario creado: ${a.email}`);
  } else {
    // Reafirma la contraseña: si el usuario ya existía de otra prueba, la profa
    // necesita entrar con la que le vamos a dar.
    await sb.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
    log(`  ✓ usuario ya existía (contraseña reafirmada): ${a.email}`);
  }

  const { data: prof } = await sb.from('profiles').select('id, role').eq('id', user.id).maybeSingle();
  if (!prof) {
    const { error } = await sb.from('profiles').insert({
      id: user.id, organization_id: org, role: 'auxiliar', full_name: a.full_name,
      email: a.email, is_active: true,
    });
    if (error) throw new Error(`profiles(${a.email}): ${error.message}`);
    log('    + perfil (auxiliar)');
  } else if (prof.role !== 'auxiliar') {
    await sb.from('profiles').update({ role: 'auxiliar', is_active: true }).eq('id', user.id);
    log('    ! perfil existía con otro rol → corregido a auxiliar');
  } else log('    ✓ perfil ok');

  const { data: ap } = await sb.from('auxiliar_profiles').select('id').eq('profile_id', user.id).maybeSingle();
  let apId = ap?.id;
  if (!apId) {
    const { data, error } = await sb.from('auxiliar_profiles').insert({
      profile_id: user.id, home_address: a.dir, home_latitude: a.lat, home_longitude: a.lng,
      employee_code: 'PRB-' + a.full_name.split(' ')[0].toUpperCase().slice(0, 4),
      notes: 'Auxiliar de prueba E2E (2026-07-25).',
    }).select('id').single();
    if (error) throw new Error(`auxiliar_profiles(${a.email}): ${error.message}`);
    apId = data.id;
    log('    + auxiliar_profile');
  } else log('    ✓ auxiliar_profile ok');
  return { profileId: user.id, auxProfileId: apId };
}

async function asegurarReserva(a, apId) {
  const cuando = `${DIA}T${a.hora}:00-05:00`;
  const { data: ya } = await sb.from('reservations')
    .select('id').eq('auxiliar_profile_id', apId).eq('required_arrival_at', new Date(cuando).toISOString())
    .is('cancelled_at', null).maybeSingle();
  if (ya) { log(`    ✓ ya tenía reserva ese día (${a.hora})`); return ya.id; }
  const { data, error } = await sb.from('reservations').insert({
    auxiliar_profile_id: apId, flight_id: null, direction: 'home_to_airport',
    status_h2a: 'requested', status_a2h: null,
    pickup_address: a.dir, pickup_latitude: a.lat, pickup_longitude: a.lng,
    required_arrival_at: cuando,
    notes: `Vuelo ${a.vuelo}. Reserva de prueba E2E.`,
    is_overnight: false, is_firm: true,
  }).select('id').single();
  if (error) throw new Error(`reservations(${a.email}): ${error.message}`);
  log(`    + reserva ${a.hora} · ${a.vuelo}`);
  return data.id;
}

async function publicarHorario() {
  const { data: tester } = await sb.from('profiles').select('id, full_name').eq('email', TESTER_EMAIL).single();
  // Un segundo conductor para llenar el cupo de la franja (el tablero pide 2).
  const { data: otro } = await sb.from('profiles').select('id, full_name')
    .eq('role', 'driver').eq('is_active', true).neq('email', TESTER_EMAIL)
    .not('full_name', 'ilike', '%DEMO%').limit(1).single();

  const DIAS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const data = { _names: { [tester.id]: tester.full_name, [otro.id]: otro.full_name } };
  // Tester en AM y PM TODOS los días: así la profa puede asignarle cualquier
  // vuelta sin importar la franja en que caiga (AM 02:30–14:00 / PM 14:00–01:30).
  DIAS.forEach(d => {
    data[d] = {
      morning: [tester.id, otro.id],
      afternoon: [tester.id, otro.id],
      coord_am: [tester.id],
      coord_pm: [otro.id],
    };
  });
  const { error } = await sb.from('weekly_schedules')
    .upsert({ week_start_date: SEMANA, data, published: true }, { onConflict: 'week_start_date' });
  if (error) throw new Error('weekly_schedules: ' + error.message);
  log(`  + horario PUBLICADO semana ${SEMANA} · ${tester.full_name} en AM y PM todos los días (+ ${otro.full_name})`);
  return tester;
}

(async () => {
  log(`\n=== Datos de prueba E2E · día objetivo ${DIA} ===\n`);
  const org = await orgId();

  log('AUXILIARES:');
  const creados = [];
  for (const a of AUXILIARES) {
    log(`— ${a.full_name} (${a.email})`);
    const { profileId, auxProfileId } = await asegurarAuxiliar(org, a);
    // La reserva de la profa NO se crea: la hace ella desde la app (es parte de
    // la prueba del rol auxiliar). Las otras 3 quedan listas para asignar.
    if (!a.esDeLaProfa) await asegurarReserva(a, auxProfileId);
    else log('    · sin reserva a propósito: la crea la profa desde la app');
    creados.push({ ...a, profileId, auxProfileId });
  }

  log('\nHORARIO:');
  const tester = await publicarHorario();

  log('\n=== LISTO ===');
  log(`\nUsuario de prueba de la profa (rol AUXILIAR):`);
  log(`   correo:      auxiliar.prueba@rendio.demo`);
  log(`   contraseña:  ${PASSWORD}`);
  log(`\nConductor para la ruta: ${tester.full_name} · ${TESTER_EMAIL}`);
  log(`Día del plan: ${DIA}  ·  semana publicada: ${SEMANA}`);
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
