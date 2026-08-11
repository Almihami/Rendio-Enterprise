#!/usr/bin/env node
// Carga en dev las RESPUESTAS REALES del formulario de programación, como si los
// tripulantes las acabaran de llenar. Insumo para probar el optimizador de rutas
// con demanda real sobre la geografía real (catálogo de residencias, mig 0055).
//
// FUENTE: "Copia de PROGRAMACIÓN RENDIO.xlsx", hoja RESPUESTAS (57 filas).
//   HORA DE PRESENTACIÓN → SALIDA  (casa → MDE, deadline duro)
//   HORA DE LLEGADA      → LLEGADA (MDE → casa, hora en que aterriza)
//   41 de las 57 filas traen AMBAS: esa persona sale y vuelve el mismo día, son
//   DOS traslados. Y algunas llegan antes de presentarse (aterriza 09:21, se
//   presenta 12:15): la dejan en la casa y la recogen después. Es válido.
//
// DECISIONES DE LA PROFA (2026-08-05):
//   · FECHAS REALES, sin correr nada. Se carga UN día —por defecto mañana— tal
//     como viene en la hoja. (La primera versión corría las fechas un día para
//     poder ver un día completo; se descartó por irreal.)
//   · "Ximena Jaramillo" = Ximena Posada (Portón del Rosal).
//   · "Sara vanessa"     = Sara Villegas (Edificio Cámbulo).
//   · "Carlos Correa" ×3 idénticas = un solo envío duplicado → una.
//   · "Margy y Andres Sanchez" = DOS personas en una fila, ambas de Río Vivo.
//
// Uso:
//   node scripts/seed-form-respuestas.mjs .env.dev              → mañana
//   node scripts/seed-form-respuestas.mjs .env.dev 2026-08-07   → un día puntual
//   node scripts/seed-form-respuestas.mjs .env.dev --todo       → la hoja entera
//   XLSX=/ruta/otra.xlsx node scripts/...                       → otro archivo
//
// Las personas se crean con correo sintético @rendio.test y employee_code TRI-###
// (purgables). Van con residence_id y SIN home_* — el trigger de 0055 es quien
// pone las coordenadas en la reserva.
//
// Uso:  node scripts/seed-form-respuestas.mjs .env.dev [--dry]

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const XLSX = process.env.XLSX || '/Users/harold/Downloads/Copia de PROGRAMACIÓN RENDIO.xlsx';
const PASS = 'PruebaRendio2026!';
// REAL: sin correr fechas. Se carga el día que pidan tal como está en la hoja.
// (La primera versión corría un día para poder ver un día completo en el tablero;
//  ya no hace falta: se filtra al día pedido, que por defecto es mañana.)
const CORRIMIENTO_DIAS = 0;

// Nombre del form → nombre del roster. Solo los que el cruce automático no
// resuelve o resuelve mal; el resto sale por apellido/similitud.
//
// Todos resueltos por la profa, porque son ambiguos de verdad: comparten el
// nombre con una persona del roster y el apellido con otra, y el conjunto de
// una y otra está en extremos opuestos de Rionegro. Adivinar = mandar el carro
// al lugar equivocado, que es justo lo que este catálogo vino a evitar.
const ALIAS = {
  'ximena jaramillo': 'Ximena Posada',      // vs Sara Jaramillo → Portón del Rosal
  'lina correa':      'Lina María',         // vs Carlos Correa → Olivar
  // OJO: "Sara vanessa" (dos eses, hoja del 5-ago) la resolvió como Sara
  // Villegas, y "Sara vanesa" (una, hoja del 6-ago) como Sara Londoño. Se
  // respetan las dos como vinieron; si resulta que es la misma persona, aquí
  // es donde se corrige.
  'sara vanessa':     'Sara Villegas',
  'sara vanesa':      'Sara Londoño',
  // Hoja del 10-ago (día 11): el cruce por parecido se quedaba con el apellido
  // MATERNO y lo mandaba a Andrés Sánchez (Río Vivo, Norte). Es Andrés Ramírez,
  // Quintas Blancas (Sur-oeste) — el mismo "Ramírez (Quintas)" de los mensajes
  // del jefe. Dos sectores distintos: adivinar aquí es perder el viaje.
  'camilo andres ramirez sanchez': 'Andrés Ramírez',
  // "Carlos rincon adc (leslie acosta)": el cruce se iba a Carlos Correa
  // (Manzanillos, Norte) por el nombre de pila. La profa confirmó que NO es
  // Correa. La única del roster en esa fila es Leslie Acosta → Ébano, en el Sur.
  // Si el que viaja es Carlos Rincón, falta su conjunto y hay que cambiarlo aquí.
  'carlos rincon adc (leslie acosta)': 'Leslie Acosta',
};
// Tripulantes que NO estaban en la lista de residencias de Julian. La profa da
// el conjunto directamente; el conjunto sí tiene que existir en el catálogo.
const NUEVOS = {
  'laura idarraga': { nombre: 'Laura Idárraga', res: 'Río Vivo' },
  // Familiares que viajan y NO son tripulantes: no tienen cuenta, pero ocupan
  // puesto y se recogen en la casa de quien sí lo es. Sin esta entrada el cruce
  // por parecido los confunde con la tripulante (aquí: "Melina").
  'papa de melina': { nombre: 'Papá de Melina', res: 'Edificio Los Cerezos' },
};
// Filas que son más de una persona. Ojo con el ORDEN: la misma pareja escribió
// "Margy y Andres Sanchez" el 5-ago y "Andrés Sánchez y Margy" el 7 — sin la
// segunda entrada, Margy se caía del plan en silencio (el cruce por parecido se
// queda con Andrés y nadie la recoge).
const MULTI = {
  'margy y andres sanchez': ['Margy', 'Andrés Sánchez'],
  'andres sanchez y margy': ['Andrés Sánchez', 'Margy'],
};

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

// ── Leer el Excel con python (openpyxl) y recibir JSON ──────────────────────
const PY = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb['RESPUESTAS']
out = []
for r in ws.iter_rows(min_row=2, values_only=True):
    if not any(c is not None for c in r[:6]): continue
    hm = lambda t: t.strftime('%H:%M') if hasattr(t, 'strftime') else None
    out.append({
        'nombre': r[1], 'fecha': str(r[2])[:10] if r[2] else None,
        'pres': hm(r[3]), 'lleg': hm(r[4]),
        'vuelo': str(r[5]).replace('.0','') if r[5] is not None else None,
        'reserva': r[6], 'pernocta': r[7],
    })
print(json.dumps(out, ensure_ascii=False))
`;
let FILAS = JSON.parse(execFileSync('python3', ['-c', PY, XLSX], { encoding: 'utf8', maxBuffer: 8e6 }));

// Día que se va a cargar. Por defecto MAÑANA en hora de Colombia: la hoja trae
// varios días y solo interesa la solicitud vigente. --todo carga la hoja entera.
const bogHoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const argDia = (process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)));
const DIA_PEDIDO = argDia || (() => {
  const d = new Date(bogHoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
if (!process.argv.includes('--todo')) {
  const antes = FILAS.length;
  FILAS = FILAS.filter((f) => f.fecha === DIA_PEDIDO);
  console.log(`Día a cargar: ${DIA_PEDIDO} (hoy en Colombia es ${bogHoy}) — ${FILAS.length} de ${antes} filas de la hoja`);
  if (!FILAS.length) { console.error(`La hoja no trae filas con fecha ${DIA_PEDIDO}. Días disponibles: ${[...new Set(JSON.parse(execFileSync('python3', ['-c', PY, XLSX], { encoding: 'utf8', maxBuffer: 8e6 })).map((f) => f.fecha))].sort().join(', ')}`); process.exit(1); }
}

// ── Roster: nombre → residencia (del catálogo confirmado) ───────────────────
const cat = JSON.parse(readFileSync('/Users/harold/Documents/Rendio-Drivers/Proyect/docs/catalogo-residencias.json', 'utf8'));
const ROSTER = [];
for (const s of cat.sitios) for (const n of s.tripulantes) ROSTER.push({ nombre: n, res: s.nombre });

function cruzar(raw) {
  const nuevo = NUEVOS[norm(raw)];
  if (nuevo) return { nombre: nuevo.nombre, res: nuevo.res };
  const a = ALIAS[norm(raw)];
  if (a) return ROSTER.find((r) => norm(r.nombre) === norm(a)) || null;
  const exact = ROSTER.find((r) => norm(r.nombre) === norm(raw));
  if (exact) return exact;
  const tr = norm(raw).split(' ').filter((t) => t.length > 1);
  let best = null;
  for (const r of ROSTER) {
    const tn = norm(r.nombre).split(' ').filter((t) => t.length > 1);
    const common = tr.filter((t) => tn.includes(t));
    if (!common.length) continue;
    // Apellido compartido pesa más que nombre de pila (hay 4 Saras, 3 Karol).
    const score = common.length * 10 + (tn.length > 1 && common.includes(tn[tn.length - 1]) ? 5 : 0)
                + (common.includes(tn[0]) ? 2 : 0);
    if (!best || score > best.score) best = { ...r, score };
  }
  return best;
}

// ── Expandir filas → viajes ─────────────────────────────────────────────────
const corre = (f) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + CORRIMIENTO_DIAS); return d.toISOString().slice(0, 10); };

const viajes = [];
const sinCruce = [];
const aBrava = [];
const vistos = new Set();
let dupes = 0;
for (const f of FILAS) {
  const personas = MULTI[norm(f.nombre)] || [f.nombre];
  for (const p of personas) {
    const m = cruzar(p);
    if (!m) { sinCruce.push(p); continue; }
    // Emparejado POR PARECIDO, no por nombre igual ni por alias resuelto a mano.
    // Se lista porque un parecido malo manda el carro a otra casa: "Esteban
    // Lopera" cruzó con "Esteban Echavarría" solo por el nombre de pila.
    if (norm(p) !== norm(m.nombre) && !ALIAS[norm(p)] && !NUEVOS[norm(p)]) aBrava.push(`${p} → ${m.nombre} (${m.res})`);
    const dia = corre(f.fecha);
    for (const [tipo, hora] of [['sal', f.pres], ['lle', f.lleg]]) {
      if (!hora) continue;
      const clave = `${m.nombre}|${dia}|${tipo}|${hora}`;
      if (vistos.has(clave)) { dupes++; continue; }   // Carlos Correa ×3
      vistos.add(clave);
      viajes.push({ persona: m.nombre, res: m.res, dia, tipo, hora, vuelo: f.vuelo,
                    pernocta: norm(f.pernocta) === 'si', reserva: norm(f.reserva) === 'si',
                    origenFila: f.nombre });
    }
  }
}
viajes.sort((a, b) => (a.dia + a.hora).localeCompare(b.dia + b.hora));

const porDia = {};
for (const v of viajes) { porDia[v.dia] = porDia[v.dia] || { sal: 0, lle: 0 }; porDia[v.dia][v.tipo]++; }
console.log(`Filas del form: ${FILAS.length}`);
console.log(`Viajes a crear: ${viajes.length}  (duplicados descartados: ${dupes})`);
for (const [d, c] of Object.entries(porDia).sort()) console.log(`   ${d}: ${c.sal} salidas + ${c.lle} llegadas = ${c.sal + c.lle}`);
if (sinCruce.length) console.log(`⚠ sin cruce: ${[...new Set(sinCruce)].join(', ')}`);
if (aBrava.length) { console.log(`⚠ emparejados por parecido (revisar, ${new Set(aBrava).size}):`); [...new Set(aBrava)].forEach((x) => console.log(`     ${x}`)); }

// Oleadas = (tipo + hora exacta) — así las agrupa el tablero.
const oleadas = {};
for (const v of viajes) { const k = `${v.dia}|${v.tipo}|${v.hora}`; (oleadas[k] = oleadas[k] || []).push(v); }
console.log(`Oleadas (tipo + hora exacta): ${Object.keys(oleadas).length}`);
const multi = Object.entries(oleadas).filter(([, g]) => g.length > 1);
console.log(`   con más de 1 pax: ${multi.length}`);
for (const [k, g] of multi) console.log(`     ${k.replace('|', ' ')} → ${g.length} pax: ${[...new Set(g.map((x) => x.res))].join(' · ')}`);

if (process.argv.includes('--dry')) { console.log('\n[--dry] no se escribió nada.'); process.exit(0); }

// ── Escribir en dev ─────────────────────────────────────────────────────────
const envFile = process.argv[2];
const t = readFileSync(envFile, 'utf8');
const g = (k) => { const m = t.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^"|"$/g, '').trim() : null; };
const url = g('SUPABASE_URL'), key = g('SUPABASE_SERVICE_ROLE_KEY');
if (!url.includes('lxlphbafhtphulanhzlp')) { console.error('ABORT: solo dev.'); process.exit(2); }
const admin = createClient(url, key, { auth: { persistSession: false } });

const { data: orgRow } = await admin.from('organizations').select('id').limit(1).single();
const org = orgRow.id;
const { data: resRows } = await admin.from('residences').select('id,name');
const RES = Object.fromEntries(resRows.map((r) => [r.name, r.id]));

// Personas: solo las que aparecen en el form.
const necesarias = [...new Set(viajes.map((v) => v.persona))].map((n) =>
  ROSTER.find((r) => r.nombre === n)
  || { nombre: n, res: viajes.find((v) => v.persona === n).res });   // los de NUEVOS
console.log(`\nPersonas involucradas: ${necesarias.length} de las 79 del roster`);

const apPorNombre = {};
let creados = 0, reusados = 0, idx = 0;
for (const p of necesarias) {
  idx++;
  const email = `tri.${slug(p.nombre)}@rendio.test`;
  const code = 'TRI-' + String(idx).padStart(3, '0');
  let { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let uid = prof?.id;
  if (!uid) {
    const { data: cu, error } = await admin.auth.admin.createUser({
      email, password: PASS, email_confirm: true, user_metadata: { full_name: p.nombre } });
    if (error) { console.error(`  createUser ${email}: ${error.message}`); continue; }
    uid = cu.user.id;
    const { error: pe } = await admin.from('profiles').insert({
      id: uid, organization_id: org, role: 'auxiliar', full_name: p.nombre, email, is_active: true });
    if (pe) { console.error(`  profile ${email}: ${pe.message}`); continue; }
    creados++;
  } else { reusados++; }

  let { data: ap } = await admin.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle();
  const campos = { employee_code: code, residence_id: RES[p.res], home_address: null, home_latitude: null, home_longitude: null };
  if (!ap) {
    const r = await admin.from('auxiliar_profiles').insert({ profile_id: uid, ...campos }).select('id').single();
    if (r.error) { console.error(`  auxiliar_profiles ${email}: ${r.error.message}`); continue; }
    ap = r.data;
  } else {
    await admin.from('auxiliar_profiles').update(campos).eq('id', ap.id);
  }
  apPorNombre[p.nombre] = ap.id;
}
console.log(`   ${creados} creadas, ${reusados} reusadas`);

// Limpiar TODA reserva previa de la tripulación de prueba (TRI-###), sin
// importar la fecha. Antes se limpiaba solo el rango del día que se estaba
// cargando y quedaban colgando las siembras anteriores (las de fechas corridas).
const dias = [...new Set(viajes.map((v) => v.dia))].sort();
const { data: todosTri } = await admin.from('auxiliar_profiles').select('id').like('employee_code', 'TRI-%');
const apIds = [...new Set([...(todosTri || []).map((x) => x.id), ...Object.values(apPorNombre)])];
const { data: viejas } = await admin.from('reservations').select('id').in('auxiliar_profile_id', apIds);
for (const v of viejas || []) {
  await admin.from('route_stops').delete().eq('reservation_id', v.id);
  await admin.from('reservation_messages').delete().eq('reservation_id', v.id);
  await admin.from('reservations').delete().eq('id', v.id);
}
if (viejas?.length) console.log(`Limpié ${viejas.length} reservas previas de la tripulación de prueba`);

const filas = viajes.filter((v) => apPorNombre[v.persona]).map((v) => ({
  auxiliar_profile_id: apPorNombre[v.persona],
  direction: v.tipo === 'lle' ? 'airport_to_home' : 'home_to_airport',
  status_h2a: v.tipo === 'lle' ? null : 'requested',
  status_a2h: v.tipo === 'lle' ? 'scheduled' : null,
  required_arrival_at: `${v.dia}T${v.hora}:00-05:00`,
  residence_id: RES[v.res],
  is_overnight: v.pernocta,
  is_firm: v.reserva,
  notes: (v.vuelo ? `Vuelo ${v.vuelo}. ` : '') + `Form ${v.origenFila.trim()}`,
}));
const { error: insErr, count } = await admin.from('reservations').insert(filas, { count: 'exact' });
if (insErr) { console.error('insert reservas:', insErr.message); process.exit(1); }
console.log(`\nReservas creadas: ${count ?? filas.length}`);
console.log(`Días: ${dias.join(', ')} · contraseña de todos: ${PASS}`);
