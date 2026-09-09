#!/usr/bin/env node
// PRUEBA DE CARGA DEL OPTIMIZADOR — la tripulación real (79 personas) en un día completo.
//
// PARA QUÉ. Hasta ahora el solver se probó con 3, 11, 15 y 25 auxiliares inventados.
// Esto lo pone contra el caso real: 79 tripulantes en los 39 conjuntos donde viven
// de verdad, con 3 carros de 4 puestos. Es el escenario que revienta o valida.
//
// QUÉ ES REAL Y QUÉ NO — importa no confundirse:
//   REAL      → los nombres, los 39 conjuntos y sus coordenadas (pines confirmados
//               por la operación, catálogo 0055). La geografía es exacta.
//   SINTÉTICO → los correos (@rendio.test), las contraseñas y LAS HORAS. La lista de
//               Julian no traía horarios de vuelo, así que las oleadas se arman con
//               un patrón realista de operación 24h. Si aparecen las horas reales,
//               se cambian las WAVES de abajo y se vuelve a correr.
//
// Los 79 quedan con residence_id y SIN home_* (nullable desde 0055): así la prueba
// también verifica que el camino del catálogo funcione de punta a punta — el
// trigger fill_reservation_pickup es quien pone las coordenadas en la reserva.
//
// Uso:  node scripts/seed-prueba-79.mjs .env.dev [YYYY-MM-DD]
// Idempotente: reusa cuentas por correo y borra las reservas del día antes de
// insertar. Purgable: todos llevan employee_code TRI-### y correo @rendio.test.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const PASS = 'PruebaRendio2026!';

// ── Oleadas: hora exacta + cuántos. El tablero agrupa por (tipo + HH:MM exacto),
//    así que cada oleada es "un vuelo": varias personas con la misma hora.
const WAVES = [
  ['sal', '03:20', 5], ['sal', '04:10', 6], ['sal', '04:50', 7], ['sal', '05:30', 4],
  ['sal', '06:15', 5], ['sal', '07:00', 6], ['sal', '08:30', 4], ['sal', '10:00', 5],
  ['sal', '12:40', 4], ['sal', '15:10', 5], ['sal', '18:00', 4],
  ['lle', '09:45', 4], ['lle', '13:20', 5], ['lle', '17:30', 6], ['lle', '21:15', 5],
  ['lle', '23:40', 4],
];   // 55 salidas + 24 llegadas = 79

// Mezcla determinista (mismo resultado en cada corrida). Las tripulaciones se
// arman por vuelo, no por dónde vive la gente: mezclar es lo realista.
function shuffle(arr, seed = 20260806) {
  const a = arr.slice();
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

function loadEnv(file) {
  const t = readFileSync(file, 'utf8');
  const g = (k) => { const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^"|"$/g, '').trim() : null; };
  return { url: g('SUPABASE_URL'), key: g('SUPABASE_SERVICE_ROLE_KEY') };
}

const envFile = process.argv[2];
if (!envFile) { console.error('Uso: node scripts/seed-prueba-79.mjs <.env.dev> [YYYY-MM-DD]'); process.exit(1); }
const { url, key } = loadEnv(envFile);
if (!url || !key) { console.error(`Faltan credenciales en ${envFile}`); process.exit(1); }
if (!url.includes('lxlphbafhtphulanhzlp')) { console.error('ABORT: este script es solo para dev.'); process.exit(2); }
const admin = createClient(url, key, { auth: { persistSession: false } });

// Día operativo: por defecto mañana en hora de Colombia.
const DAY = process.argv[3] || (() => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
})();
const at = (hhmm) => `${DAY}T${hhmm}:00-05:00`;

// ── El roster: quién vive en qué conjunto (lista de Julian, 4-ago-2026) ──────
const ROSTER = {
  'Olivar Apartamentos': ['David Estrada','Farid','Sara Londoño','Manuela Velásquez','Fernando Soto','Juanita Ortiz','Jolene','Angelly Turner','Sebastián González','Daniela Villa','Melisa Arcila','Francisco Sánchez','Erika Noreña','Lina María'],
  'Solare Apartamentos': ['Jessica Duque','Lady Aguirre','Jesús Madrid','Josmar','Ana Upegui','Angely Rubiano'],
  'Edificio Cámbulo': ['Gloria Bayona','Karol Martínez','Nicol Mancilla','Catalina Rico','Sara Villegas'],
  'Río Vivo': ['Michel Rodríguez','Sebastián León','Margy','Andrés Sánchez'],
  'Edificio Los Cerezos': ['Yalimar Peñaranda','Josselyn','Melina'],
  'Boral Apartamentos': ['Shirley','Paulina Ciro','Juliana Ibarra'],
  'Forest Apartamentos': ['Camila Cano','Alison Fernández','Esteban Echavarría'],
  'Guayacán': ['Laura Ortiz','Isabela Polo','Yerly'],
  'Arándanos de Fontibón': ['Alejandra Gaitán','Sofía Villegas'],
  'Urb. Manzanillos': ['Carlos Correa','Dayana Vargas'],
  'Viverdi Apartamentos': ['Jenn Linares','Karol Lozano'],
  'Origen del Lago': ['Juan Martínez','Henry'],
  'Edificio Sendai': ['Andrea Lesmes','Andrea Núñez'],
  'Ébano Apartamentos': ['Leslie Acosta','Javier Gómez'],
  'Portón del Rosal': ['Ana Vélez','Ximena Posada'],
  'Piedemonte Apartamentos': ['Duvan'],
  'Bosques del Norte': ['Luz'],
  'Campo Santander': ['Catalina Serna'],
  'Madero del Lago': ['Daniel Gallón'],
  'Edificio Las Margaritas': ['Laura Yalanda'],
  'Edificio Eucalipto': ['Aleja Quintero'],
  'Alto Vallejo / Loma Linda': ['Alfonso'],
  'Linda Granja': ['Karol Puentes'],
  'Llanito': ['Juan Bedoya'],
  'Casa azul Llanito': ['Jesús Taborda'],
  'Tejo': ['Daniela Hincapié'],
  'Campus Reservado': ['Kriss'],
  'Séptima': ['Santi Carmona'],
  'Quintas Blancas': ['Andrés Ramírez'],
  'Quintas Amarillas': ['Sara Jaramillo'],
  'Club Verde Terra': ['Paula Londoño'],
  'Torres del Campo': ['Laura Blanco'],
  'Senderos de San Sebastián': ['Wilson'],
  'Marinilla vereda': ['Sara Valencia'],
  'Marinilla centro': ['Camila Vélez'],
  'Condominio Planté': ['Ana Lucía'],
  'Urb. Bosque Robledal': ['Dahian'],
  'Rincones de Llanogrande': ['Camilo Guancha'],
  'Llanogrande': ['Jairo García'],
};

// ── 0. Contexto ─────────────────────────────────────────────────────────────
const { data: orgRow } = await admin.from('organizations').select('id').limit(1).single();
const org = orgRow.id;
const { data: resRows, error: resErr } = await admin.from('residences').select('id,name,latitude,longitude');
if (resErr) { console.error('Sin catálogo de residencias — ¿corriste la 0055?', resErr.message); process.exit(1); }
const RES = Object.fromEntries(resRows.map((r) => [r.name, r]));

const faltan = Object.keys(ROSTER).filter((n) => !RES[n]);
if (faltan.length) { console.error('Residencias que no están en el catálogo:', faltan); process.exit(1); }

const total = Object.values(ROSTER).reduce((a, b) => a + b.length, 0);
const cupo = WAVES.reduce((a, w) => a + w[2], 0);
if (total !== cupo) { console.error(`Descuadre: ${total} tripulantes vs ${cupo} cupos en las oleadas`); process.exit(1); }
console.log(`Día operativo ${DAY} · ${total} tripulantes · ${Object.keys(ROSTER).length} conjuntos · ${WAVES.length} oleadas\n`);

// ── 1. Personas ─────────────────────────────────────────────────────────────
const gente = [];
let n = 0;
for (const [resName, nombres] of Object.entries(ROSTER)) {
  for (const nombre of nombres) {
    n++;
    const code = 'TRI-' + String(n).padStart(3, '0');
    const email = `tri.${slug(nombre)}@rendio.test`;
    gente.push({ nombre, email, code, res: RES[resName], resName });
  }
}

let creados = 0, reusados = 0;
for (const g of gente) {
  let { data: prof } = await admin.from('profiles').select('id').eq('email', g.email).maybeSingle();
  let uid = prof?.id;
  if (!uid) {
    const { data: cu, error } = await admin.auth.admin.createUser({
      email: g.email, password: PASS, email_confirm: true, user_metadata: { full_name: g.nombre },
    });
    if (error) { console.error(`  createUser ${g.email}: ${error.message}`); continue; }
    uid = cu.user.id;
    const { error: pe } = await admin.from('profiles')
      .insert({ id: uid, organization_id: org, role: 'auxiliar', full_name: g.nombre, email: g.email, is_active: true });
    if (pe) { console.error(`  profile ${g.email}: ${pe.message}`); continue; }
    creados++;
  } else { reusados++; }

  // auxiliar_profile: SOLO residence_id. home_* queda NULL a propósito (0055).
  let { data: ap } = await admin.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle();
  if (!ap) {
    const r = await admin.from('auxiliar_profiles')
      .insert({ profile_id: uid, employee_code: g.code, residence_id: g.res.id,
                home_address: null, home_latitude: null, home_longitude: null })
      .select('id').single();
    if (r.error) { console.error(`  auxiliar_profiles ${g.email}: ${r.error.message}`); continue; }
    ap = r.data;
  } else {
    await admin.from('auxiliar_profiles')
      .update({ employee_code: g.code, residence_id: g.res.id,
                home_address: null, home_latitude: null, home_longitude: null }).eq('id', ap.id);
  }
  g.apId = ap.id;
}
console.log(`Personas: ${creados} creadas, ${reusados} reusadas, ${gente.filter((g) => g.apId).length}/${total} con perfil de auxiliar`);

// ── 2. Reservas del día ─────────────────────────────────────────────────────
const listos = gente.filter((g) => g.apId);
const ids = listos.map((g) => g.apId);
const { data: viejas } = await admin.from('reservations').select('id')
  .in('auxiliar_profile_id', ids)
  .gte('required_arrival_at', DAY + 'T00:00:00-05:00')
  .lt('required_arrival_at', DAY + 'T23:59:59-05:00');
for (const v of viejas || []) {
  await admin.from('route_stops').delete().eq('reservation_id', v.id);
  await admin.from('reservation_messages').delete().eq('reservation_id', v.id);
  await admin.from('reservations').delete().eq('id', v.id);
}
if (viejas?.length) console.log(`Limpié ${viejas.length} reservas previas de este día (idempotencia)`);

const mezclado = shuffle(listos);
let i = 0, ok = 0;
const resumen = [];
for (const [tipo, hora, cuantos] of WAVES) {
  const grupo = mezclado.slice(i, i + cuantos); i += cuantos;
  const filas = grupo.map((g) => ({
    auxiliar_profile_id: g.apId,
    direction: tipo === 'lle' ? 'airport_to_home' : 'home_to_airport',
    status_h2a: tipo === 'lle' ? null : 'requested',
    status_a2h: tipo === 'lle' ? 'scheduled' : null,
    required_arrival_at: at(hora),
    residence_id: g.res.id,
    // pickup_address / latitude / longitude los pone el trigger desde la residencia.
    notes: `Prueba de carga 79 · oleada ${tipo} ${hora}`,
  }));
  const { error } = await admin.from('reservations').insert(filas);
  if (error) { console.error(`  oleada ${tipo} ${hora}: ${error.message}`); continue; }
  ok += filas.length;
  resumen.push(`  ${tipo === 'lle' ? 'LLEGADA ' : 'salida  '} ${hora} · ${cuantos} pax · ${[...new Set(grupo.map((g) => g.resName))].length} conjuntos`);
}
console.log(`\nReservas creadas: ${ok}/${total}`);
console.log(resumen.join('\n'));
console.log(`\nLISTO · día ${DAY} · contraseña de todos: ${PASS}`);
console.log(`Para borrar la prueba: reservas del día + auxiliares con employee_code TRI-%`);
