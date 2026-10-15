// _seed-50-manana-dev.mjs — 50 reservas para un día en DEV, repartidas en oleadas
// de madrugada a noche, para ver el módulo de rutas con carga (pedido de la profa,
// 14-oct-2026: «inyecta 50 reservas para mañana … en dev, quiero ver algo»).
//
// Usa 50 de los tripulantes de prueba que ya existen en dev (tri.*@rendio.test,
// de seed-prueba-79.mjs): nombres y conjuntos reales, correos/horas sintéticos.
// No crea cuentas. Las coordenadas las pone el trigger desde la residencia.
//
// Idempotente: borra antes las reservas del día marcadas «Prueba 50» (y sus
// paradas/mensajes). Para quitar la prueba: las reservas con notes «Prueba 50 · %».
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _seed-50-manana-dev.mjs [AAAA-MM-DD]
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: solo dev'); process.exit(2); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = (r, what) => { if (r.error) { console.error(what, r.error.message); process.exit(1); } return r.data; };

const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const DAY = process.argv[2] || (() => { const d = new Date(hoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const at = (hhmm) => `${DAY}T${hhmm}:00-05:00`;
const NEXT = (() => { const d = new Date(DAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const TAG = 'Prueba 50';

// Oleadas: [tipo, hora, cuántos]. El tablero agrupa por tipo + HH:MM exacto, así
// que cada oleada es «un vuelo». Salidas = hora de presentación en JMC; llegadas =
// hora en que aterriza. Mismo patrón de operación 24 h que la prueba de 79.
const WAVES = [
  ['sal', '03:20', 4], ['sal', '04:10', 4], ['sal', '04:50', 5], ['sal', '05:30', 3],
  ['sal', '06:15', 4], ['sal', '07:00', 3], ['sal', '08:30', 3], ['sal', '10:00', 2],
  ['sal', '12:40', 2], ['sal', '15:10', 2], ['sal', '18:00', 2],
  ['lle', '09:45', 3], ['lle', '13:20', 4], ['lle', '17:30', 4], ['lle', '21:15', 3],
  ['lle', '23:40', 2],
];   // 34 salidas + 16 llegadas = 50
const TOTAL = WAVES.reduce((a, w) => a + w[2], 0);

// Mezcla determinista (mismo resultado en cada corrida).
function shuffle(arr, seed = 20261015) {
  const a = arr.slice(); let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── 1. Los tripulantes de prueba con conjunto ──────────────────────────────
const aps = must(await sb.from('auxiliar_profiles')
  .select('id, employee_code, residence_id, profiles!inner(email, full_name, is_active)')
  .like('profiles.email', 'tri.%@rendio.test')
  .not('residence_id', 'is', null)
  .order('employee_code'), 'tripulantes');
// residence_id y residence_id_2 apuntan a residences: el nombre se pide aparte.
const RES = Object.fromEntries(must(await sb.from('residences').select('id, name'), 'residencias').map(r => [r.id, r.name]));
const listos = aps.filter(a => a.profiles && a.profiles.is_active !== false);
if (listos.length < TOTAL) { console.error(`Solo hay ${listos.length} tripulantes de prueba con conjunto; hacen falta ${TOTAL}`); process.exit(1); }
const elegidos = shuffle(listos).slice(0, TOTAL);
console.log(`Día ${DAY} · ${TOTAL} reservas · ${WAVES.length} oleadas · ${new Set(elegidos.map(e => e.residence_id)).size} conjuntos\n`);

// ── 2. Limpieza de la corrida anterior (solo lo marcado «Prueba 50») ────────
const viejas = must(await sb.from('reservations').select('id')
  .like('notes', TAG + ' · %')
  .gte('required_arrival_at', DAY + 'T00:00:00-05:00')
  .lt('required_arrival_at', NEXT + 'T00:00:00-05:00'), 'viejas');
for (const v of viejas) {
  await sb.from('route_stops').delete().eq('reservation_id', v.id);
  await sb.from('reservation_messages').delete().eq('reservation_id', v.id);
  must(await sb.from('reservations').delete().eq('id', v.id), 'borrar ' + v.id);
}
if (viejas.length) console.log(`Limpié ${viejas.length} reservas «${TAG}» de este día (idempotencia)\n`);

// ── 3. Reservas ─────────────────────────────────────────────────────────────
let i = 0, ok = 0;
for (const [tipo, hora, cuantos] of WAVES) {
  const grupo = elegidos.slice(i, i + cuantos); i += cuantos;
  const filas = grupo.map((g) => ({
    auxiliar_profile_id: g.id,
    direction: tipo === 'lle' ? 'airport_to_home' : 'home_to_airport',
    status_h2a: tipo === 'lle' ? null : 'requested',
    status_a2h: tipo === 'lle' ? 'scheduled' : null,
    required_arrival_at: at(hora),
    residence_id: g.residence_id,
    notes: `${TAG} · oleada ${tipo} ${hora}`,
  }));
  const r = await sb.from('reservations').insert(filas);
  if (r.error) { console.error(`  oleada ${tipo} ${hora}: ${r.error.message}`); continue; }
  ok += filas.length;
  const conj = [...new Set(grupo.map(g => RES[g.residence_id] || '?'))];
  console.log(`  ${tipo === 'lle' ? 'LLEGADA' : 'salida '} ${hora} · ${cuantos} · ${conj.join(', ')}`);
}
console.log(`\nReservas creadas: ${ok}/${TOTAL} para el ${DAY}. Sin publicar: el plan se arma en Rutas › Asignación.`);
