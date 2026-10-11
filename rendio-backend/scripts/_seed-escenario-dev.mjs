// _seed-escenario-dev.mjs — Escenario de prueba en DEV para recorrer el flujo
// completo (admin → conductor → tripulante) en el teléfono. Autorizado por la
// dueña el 11-oct-2026 («puedes inyectar información en la BD de desarrollo»).
//
// Idempotente. SOLO dev (lxlphbafhtphulanhzlp). Usa las cuentas demo que ya
// existen en dev (sus contraseñas no se tocan):
//   · horario PUBLICADO de esta semana y la siguiente con los conductores demo;
//   · celular de prueba a dos conductores (el tercero queda SIN celular para ver
//     la ventana que lo pide) y a los tripulantes del escenario;
//   · reservas del DÍA indicado (por defecto mañana): 3 salidas del mismo vuelo
//     en El Olivar, 1 salida sola y 2 llegadas del mismo vuelo. Sin publicar: el
//     plan se arma y se publica desde Rutas › Asignación.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _seed-escenario-dev.mjs [AAAA-MM-DD]
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: solo dev'); process.exit(2); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = (r, what) => { if (r.error) { console.error(what, r.error.message); process.exit(1); } return r.data; };

const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const DIA = process.argv[2] || (() => { const d = new Date(hoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const at = (hhmm) => `${DIA}T${hhmm}:00-05:00`;
const lunesDe = (iso) => { const d = new Date(iso + 'T12:00:00Z'); const w = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (w === 0 ? 6 : w - 1)); return d.toISOString().slice(0, 10); };
const mas7 = (iso) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };

const prof = async (email) => must(await sb.from('profiles').select('id, full_name, organization_id').eq('email', email).maybeSingle(), email);
const C = {
  julian: await prof('julian.lopez@rendio.com'),
  franco: await prof('juan.franco@rendio.co'),
  demo: await prof('demo-conductor@rendio.demo'),
};
for (const [k, v] of Object.entries(C)) if (!v) { console.error('falta el conductor', k); process.exit(1); }
await sb.from('profiles').update({ phone: '3001110001' }).eq('id', C.julian.id);
await sb.from('profiles').update({ phone: '3001110002' }).eq('id', C.franco.id);
await sb.from('profiles').update({ phone: null }).eq('id', C.demo.id);   // ventana obligatoria del celular

// Horario publicado (semana del día y la siguiente).
const NAMES = Object.fromEntries(Object.values(C).map(c => [c.id, c.full_name]));
for (const week of [lunesDe(DIA), mas7(lunesDe(DIA))]) {
  const data = { _names: NAMES };
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    data[d] = { morning: [C.julian.id, C.franco.id], afternoon: [C.demo.id, C.franco.id], coord_am: [C.julian.id], coord_pm: [C.demo.id], rest: [] };
  }
  const prev = must(await sb.from('weekly_schedules').select('id').eq('week_start_date', week).maybeSingle(), 'horario');
  must(prev ? await sb.from('weekly_schedules').update({ data, published: true }).eq('id', prev.id)
    : await sb.from('weekly_schedules').insert({ week_start_date: week, data, published: true }), 'horario ' + week);
  console.log(`horario ${week}: publicado`);
}

// Tripulantes del escenario (cuentas demo existentes).
const TRIPU = [
  ['laura.gomez@rendio.demo', '3105550201', 'home_to_airport', '06:00', 'AV9412'],
  ['camila.rios@rendio.demo', '3105550202', 'home_to_airport', '06:00', 'AV9412'],
  ['andres.pena@rendio.demo', '3105550203', 'home_to_airport', '06:00', 'AV9412'],
  ['sara.quintero@rendio.demo', '3105550204', 'home_to_airport', '09:30', 'LA4025'],
  ['mateo.cardona@rendio.demo', '3105550205', 'airport_to_home', '14:20', 'AV9563'],
  ['manuela.gil@rendio.demo', '3105550206', 'airport_to_home', '14:20', 'AV9563'],
];
for (const [email, phone, dir, hhmm, vuelo] of TRIPU) {
  const p = await prof(email); if (!p) { console.warn('  no existe', email); continue; }
  await sb.from('profiles').update({ phone }).eq('id', p.id);
  const ap = must(await sb.from('auxiliar_profiles').select('id, residence_id, residence_unit, meeting_point, home_address, home_latitude, home_longitude').eq('profile_id', p.id).maybeSingle(), 'aux ' + email);
  if (!ap) { console.warn('  sin perfil de tripulante', email); continue; }
  // auxiliar_profiles tiene dos llaves a residences (residence_id y _2): se trae aparte.
  ap.residences = ap.residence_id ? must(await sb.from('residences').select('name, latitude, longitude').eq('id', ap.residence_id).maybeSingle(), 'conjunto') : null;
  const lat = ap.residences?.latitude ?? ap.home_latitude, lng = ap.residences?.longitude ?? ap.home_longitude;
  if (lat == null) { console.warn('  sin punto de recogida', email); continue; }
  // Limpia lo del mismo día de esta persona (re-correr no duplica).
  const old = must(await sb.from('reservations').select('id').eq('auxiliar_profile_id', ap.id)
    .gte('required_arrival_at', DIA + 'T00:00:00-05:00').lt('required_arrival_at', DIA + 'T23:59:59-05:00'), 'viejas');
  for (const o of old) {
    const st = must(await sb.from('route_stops').select('route_assignment_id').eq('reservation_id', o.id), 'paradas');
    await sb.from('route_stops').delete().eq('reservation_id', o.id);
    for (const s of st) {
      // La vuelta se borra solo si quedó sin paradas (no se tocan las de otros).
      const { count } = await sb.from('route_stops').select('id', { count: 'exact', head: true }).eq('route_assignment_id', s.route_assignment_id);
      if (!count) await sb.from('route_assignments').delete().eq('id', s.route_assignment_id);
    }
    await sb.from('reservation_messages').delete().eq('reservation_id', o.id);
    await sb.from('reservations').delete().eq('id', o.id);
  }
  must(await sb.from('reservations').insert({
    auxiliar_profile_id: ap.id, direction: dir,
    status_h2a: dir === 'home_to_airport' ? 'requested' : null, status_a2h: dir === 'airport_to_home' ? 'scheduled' : null,
    pickup_address: ap.residences?.name || ap.home_address || 'Punto de recogida', pickup_latitude: lat, pickup_longitude: lng,
    residence_id: ap.residence_id, residence_unit: ap.residence_unit, meeting_point: ap.meeting_point,
    required_arrival_at: at(hhmm), notes: `Vuelo ${vuelo}`, service_level: 'shared',
  }), 'reserva ' + email);
  console.log(`  ${email} · ${dir === 'home_to_airport' ? 'salida, presentación' : 'llegada, aterriza'} ${hhmm} · vuelo ${vuelo}`);
}
console.log(`LISTO · día ${DIA} · reservas sin publicar (publicar desde Rutas › Asignación)`);
