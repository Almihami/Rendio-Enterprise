// _seed-e2e-local.mjs — Escenario completo para la prueba de punta a punta en la
// base LOCAL (supabase start). NUNCA corre contra dev ni producción.
//
// Arma (idempotente, por correo): organización Rendio, aeropuerto MDE, los 39
// conjuntos del catálogo real (docs/catalogo-residencias.json), aerolíneas,
// checklist oficial, 3 carros, 1 jefe, 3 conductores (uno SIN celular, para
// probar la ventana que lo pide), 8 tripulantes en conjuntos reales, horario
// PUBLICADO de la semana y reservas de HOY y MAÑANA (salidas y llegadas, a horas
// relativas a ahora para que los recordatorios de 10 min se puedan ver).
//
// Uso (desde rendio-backend/scripts, con el stack local arriba):
//   node _seed-e2e-local.mjs            → crea/actualiza
//   node _seed-e2e-local.mjs --reservas → solo rehace las reservas de hoy/mañana
//
// Cuentas de prueba (SOLO base local): todas con la contraseña E2E_PASSWORD de
// abajo. Correos @rendio.test: jefe.local, carlos.local, diana.local,
// pedro.local (sin celular) y tripu1…tripu8.local.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { localClient } from './_local-fixtures.mjs';

export const E2E_PASSWORD = 'Prueba-Local-2026!';
const LOCAL_URL = 'http://127.0.0.1:54321';
const env = Object.fromEntries(execSync('supabase status -o env', { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
  .split('\n').map(l => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map(m => [m[1], m[2]]));
const SERVICE = env.SERVICE_ROLE_KEY || env.SECRET_KEY;
if (!/127\.0\.0\.1|localhost/.test(env.API_URL || '')) { console.error('ABORT: esto solo corre contra la base local'); process.exit(2); }
const sb = createClient(LOCAL_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const must = (r, what) => { if (r.error) { console.error(what, r.error.message); process.exit(1); } return r.data; };
const SOLO_RESERVAS = process.argv.includes('--reservas');
const pgc = await localClient();

// ------------------------------------------------------------ base
let org = (await sb.from('organizations').select('id').eq('slug', 'rendio').maybeSingle()).data;
if (!org) org = must(await sb.from('organizations').insert({ name: 'Rendio', slug: 'rendio' }).select('id').single(), 'org');
const ORG = org.id;
let apt = (await sb.from('airports').select('id').eq('iata_code', 'MDE').maybeSingle()).data;
if (!apt) apt = must(await sb.from('airports').insert({ organization_id: ORG, iata_code: 'MDE', name: 'José María Córdova', latitude: 6.1715, longitude: -75.4270 }).select('id').single(), 'aeropuerto');

const cat = JSON.parse(readFileSync(new URL('../../docs/catalogo-residencias.json', import.meta.url), 'utf8'));
const sector = (s) => s.lng > -75.33 ? 'Marinilla' : (s.lat < 6.135 ? 'Llanogrande' : 'Rionegro');
const RES = {};
if (!SOLO_RESERVAS) {
  for (const s of cat.sitios) {
    const prev = (await sb.from('residences').select('id').eq('organization_id', ORG).eq('name', s.nombre).maybeSingle()).data;
    const row = { organization_id: ORG, name: s.nombre, latitude: s.lat, longitude: s.lng, sector: sector(s) };
    const r = prev ? await sb.from('residences').update(row).eq('id', prev.id).select('id').single()
      : await sb.from('residences').insert(row).select('id').single();
    if (r.error) { console.warn('  conjunto', s.nombre, r.error.message); continue; }
    RES[s.nombre] = r.data.id;
  }
  for (const [i, [name, iata]] of [['Avianca', 'AV'], ['LATAM', 'LA'], ['JetSMART', 'JA'], ['Wingo', 'P5']].entries()) {
    const prev = (await sb.from('airlines').select('id').eq('organization_id', ORG).eq('iata_code', iata).maybeSingle()).data;
    if (!prev) must(await sb.from('airlines').insert({ organization_id: ORG, name, iata_code: iata, sort_order: i + 1, is_active: true }), 'aerolínea');
  }
  for (const [code, plate, color] of [['V-01', 'RDO101', 'Blanco'], ['V-02', 'RDO202', 'Gris'], ['V-03', 'RDO303', 'Negro']]) {
    const prev = (await sb.from('vehicles').select('id').eq('organization_id', ORG).eq('internal_code', code).maybeSingle()).data;
    const row = { organization_id: ORG, internal_code: code, license_plate: plate, brand: 'Renault', model: 'Duster', year: 2023, capacity: 4,
      current_km: 40000, last_maintenance_km: 38000, maintenance_interval_km: 5000, status: 'available', color };
    must(prev ? await sb.from('vehicles').update(row).eq('id', prev.id) : await sb.from('vehicles').insert(row), 'carro');
  }
} else {
  for (const r of must(await sb.from('residences').select('id, name').eq('organization_id', ORG), 'conjuntos')) RES[r.name] = r.id;
}

// ------------------------------------------------------------ cuentas
async function cuenta(email, full_name, role, phone) {
  let prof = (await sb.from('profiles').select('id').eq('email', email).maybeSingle()).data;
  let uid = prof && prof.id;
  if (!uid) {
    // Se busca en auth.users por SQL: listUsers revienta si alguna prueba dejó
    // filas de auth sin los tokens que GoTrue espera.
    const ya = (await pgc.query(`SELECT id FROM auth.users WHERE email = $1`, [email])).rows[0];
    if (ya) uid = ya.id;
    else uid = must(await sb.auth.admin.createUser({ email, password: E2E_PASSWORD, email_confirm: true, user_metadata: { full_name } }), 'crear ' + email).user.id;
  }
  await sb.auth.admin.updateUserById(uid, { password: E2E_PASSWORD });
  must(await sb.from('profiles').upsert({ id: uid, organization_id: ORG, role, full_name, email, phone: phone || null, is_active: true, deleted_at: null }), 'perfil ' + email);
  return uid;
}
const JEFE = await cuenta('jefe.local@rendio.test', 'Julián Prueba', 'admin', '3004445566');
if (!SOLO_RESERVAS) await sb.from('profiles').update({ receives_ops_alerts: true }).eq('id', JEFE);
const DRV = {
  carlos: await cuenta('carlos.local@rendio.test', 'Carlos Mejía', 'driver', '3001112233'),
  diana: await cuenta('diana.local@rendio.test', 'Diana Ríos', 'driver', '3015556677'),
  pedro: await cuenta('pedro.local@rendio.test', 'Pedro Gil', 'driver', null),   // sin celular: ventana obligatoria
};
for (const pid of Object.values(DRV)) {
  const prev = (await sb.from('driver_profiles').select('id').eq('profile_id', pid).maybeSingle()).data;
  if (!prev) must(await sb.from('driver_profiles').insert({ profile_id: pid, license_number: 'C2-' + pid.slice(0, 6), license_expires_at: '2028-12-31' }), 'driver_profile');
}
// Pedro: sin celular SIEMPRE al sembrar (la prueba lo pide y lo guarda).
await sb.from('profiles').update({ phone: null }).eq('id', DRV.pedro);

const AIR = Object.fromEntries((must(await sb.from('airlines').select('id, iata_code').eq('organization_id', ORG), 'aerolíneas')).map(a => [a.iata_code, a.id]));
const TRIPU = [
  ['tripu1.local@rendio.test', 'Laura Gómez', '3105550101', 'Olivar Apartamentos', 'Torre 2 · 504', 'Portería principal', 'AV'],
  ['tripu2.local@rendio.test', 'Andrés Ruiz', '3105550102', 'Olivar Apartamentos', 'Torre 1 · 302', 'Portería principal', 'AV'],
  ['tripu3.local@rendio.test', 'Camila Ortiz', '3105550103', 'Solare Apartamentos', 'Apto 801', null, 'AV'],
  ['tripu4.local@rendio.test', 'Sara Montoya', '3105550104', 'Edificio Cámbulo', 'Apto 203', 'Frente a la panadería', 'LA'],
  ['tripu5.local@rendio.test', 'Mateo Herrera', '3105550105', 'Solare Apartamentos', 'Apto 1102', null, 'AV'],
  ['tripu6.local@rendio.test', 'Valeria Ochoa', '3105550106', 'Edificio Cámbulo', 'Apto 405', null, 'JA'],
  ['tripu7.local@rendio.test', 'Daniela Villa', '3105550107', 'Olivar Apartamentos', 'Torre 3 · 110', 'Portería principal', 'AV'],
  ['tripu8.local@rendio.test', 'Nicolás Torres', '3105550108', 'Solare Apartamentos', 'Apto 602', null, 'LA'],
];
const AUX = {};
for (const [email, name, phone, conj, unit, meet, air] of TRIPU) {
  const uid = await cuenta(email, name, 'auxiliar', phone);
  const s = cat.sitios.find(x => x.nombre === conj);
  const row = { profile_id: uid, residence_id: RES[conj] || null, residence_unit: unit, meeting_point: meet,
    home_address: conj + (unit ? ' · ' + unit : ''), home_latitude: s && s.lat, home_longitude: s && s.lng,
    airline_id: AIR[air] || null, joined_at: '2026-01-15' };
  const prev = (await sb.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle()).data;
  const r = prev ? await sb.from('auxiliar_profiles').update(row).eq('id', prev.id).select('id').single()
    : await sb.from('auxiliar_profiles').insert(row).select('id').single();
  AUX[email] = { id: must(r, 'auxiliar ' + email).id, uid, name, conj, unit, meet, s };
}

// ------------------------------------------------------------ horario publicado (semana en curso y la siguiente)
const hoyBog = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const DIA = hoyBog();
const lunesDe = (iso) => { const d = new Date(iso + 'T12:00:00Z'); const w = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (w === 0 ? 6 : w - 1)); return d.toISOString().slice(0, 10); };
const NAMES = { [DRV.carlos]: 'Carlos Mejía', [DRV.diana]: 'Diana Ríos', [DRV.pedro]: 'Pedro Gil' };
for (const week of [lunesDe(DIA), (() => { const d = new Date(lunesDe(DIA) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })()]) {
  const data = { _names: NAMES };
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    data[day] = { morning: [DRV.carlos, DRV.diana], afternoon: [DRV.pedro, DRV.diana], coord_am: [DRV.carlos], coord_pm: [DRV.pedro], rest: [] };
  }
  const prev = (await sb.from('weekly_schedules').select('id').eq('week_start_date', week).maybeSingle()).data;
  must(prev ? await sb.from('weekly_schedules').update({ data, published: true }).eq('id', prev.id)
    : await sb.from('weekly_schedules').insert({ week_start_date: week, data, published: true, created_by: JEFE }), 'horario');
}

// ------------------------------------------------------------ reservas de hoy y mañana
// Se borran las de los tripulantes de prueba desde hoy (con sus paradas y rutas).
const auxIds = Object.values(AUX).map(a => a.id);
const viejas = must(await sb.from('reservations').select('id').in('auxiliar_profile_id', auxIds).gte('required_arrival_at', DIA + 'T00:00:00-05:00'), 'reservas viejas');
if (viejas.length) {
  const ids = viejas.map(r => r.id);
  const stops = must(await sb.from('route_stops').select('route_assignment_id').in('reservation_id', ids), 'paradas');
  await sb.from('route_stops').delete().in('reservation_id', ids);
  const ras = [...new Set(stops.map(s => s.route_assignment_id))];
  if (ras.length) await sb.from('route_assignments').delete().in('id', ras);
  await sb.from('reservation_messages').delete().in('reservation_id', ids);
  must(await sb.from('reservations').delete().in('id', ids), 'borrar reservas');
}
// Horas: «presentación» (salidas) o «aterrizaje» (llegadas) redondeadas a 5 min.
const enMin = (m) => { const t = new Date(Date.now() + m * 60000); t.setUTCSeconds(0, 0); t.setUTCMinutes(Math.round(t.getUTCMinutes() / 5) * 5); return t.toISOString(); };
const manana = (hhmm) => { const d = new Date(DIA + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return `${d.toISOString().slice(0, 10)}T${hhmm}:00-05:00`; };
const PLAN = [
  // Salida de HOY en ~2 h: 3 del mismo vuelo → una ruta de 3 paradas.
  ['tripu1.local@rendio.test', 'home_to_airport', enMin(120), 'AV9412'],
  ['tripu2.local@rendio.test', 'home_to_airport', enMin(120), 'AV9412'],
  ['tripu3.local@rendio.test', 'home_to_airport', enMin(120), 'AV9412'],
  // Salida de HOY más tarde, sola.
  ['tripu4.local@rendio.test', 'home_to_airport', enMin(240), 'LA4025'],
  // Llegada de HOY: dos del mismo vuelo aterrizan en ~1 h 40.
  ['tripu5.local@rendio.test', 'airport_to_home', enMin(100), 'AV9563'],
  ['tripu6.local@rendio.test', 'airport_to_home', enMin(100), 'AV9563'],
  // Mañana: salida temprano y una llegada.
  ['tripu7.local@rendio.test', 'home_to_airport', manana('05:10'), 'AV9440'],
  ['tripu8.local@rendio.test', 'airport_to_home', manana('14:20'), 'LA4031'],
];
for (const [email, dir, when, vuelo] of PLAN) {
  const a = AUX[email];
  must(await sb.from('reservations').insert({
    auxiliar_profile_id: a.id, direction: dir,
    status_h2a: dir === 'home_to_airport' ? 'requested' : null, status_a2h: dir === 'airport_to_home' ? 'scheduled' : null,
    pickup_address: a.conj + (a.unit ? ' · ' + a.unit : ''), pickup_latitude: a.s && a.s.lat, pickup_longitude: a.s && a.s.lng,
    residence_id: RES[a.conj] || null, residence_unit: a.unit, meeting_point: a.meet,
    required_arrival_at: when, notes: `Vuelo ${vuelo}`, service_level: 'shared',
  }), 'reserva ' + email);
}
console.log(`LISTO · día ${DIA} · ${Object.keys(RES).length} conjuntos · 3 carros · jefe + 3 conductores + ${TRIPU.length} tripulantes · ${PLAN.length} reservas`);
await pgc.end();
