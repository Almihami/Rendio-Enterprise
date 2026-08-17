#!/usr/bin/env node
// SOLO LECTURA (no escribe nada en la BD) — arma el plan del día a partir del
// FORMULARIO crudo, sin pasar por reservas sembradas.
//
// POR QUÉ. La programación entra por un Google Form y sale por WhatsApp. Entre
// esos dos extremos hoy no hay nada automático: alguien la transcribe. Esto cubre
// el tramo completo con el solver REAL de la app (se recorta admin-rutas.js igual
// que plan-del-dia.mjs, no se reimplementa nada).
//
// Cómo lee el formulario (una fila = una persona, y puede dar DOS traslados):
//   · HORA DE PRESENTACIÓN → SALIDA: casa → MDE, esa es la hora de presentación.
//   · HORA DE LLEGADA      → LLEGADA: MDE → casa, esa es la hora en que aterriza.
//   · ¿ES UNA PERNOCTA?    → duerme FUERA de Rionegro; por eso trae un solo tramo.
//   · ¿ES UNA RESERVA?     → queda de reserva. En los planes del jefe estos son
//     los que van al HOTEL (Taborda y Ramírez, Ana Upegui y Henry, el 16-ago).
//     Se marcan, pero el formulario NO dice el destino: eso hay que confirmarlo.
//
// La casa sale de docs/catalogo-residencias.json (pines confirmados por ellos).
// A quien no aparezca NO se le inventa coordenada: se lista aparte.
//
// Uso:
//   python3 scripts/_form-dump.py "<archivo.xlsx>" /tmp/form.json
//   set -a; source .env.dev; set +a
//   node scripts/plan-desde-formulario.mjs /tmp/form.json 2026-08-16 --carros=3
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { norm, catalogo, leerPlan } from './planes-jefe/lib-plan.mjs';

const RUTAS_JS = new URL('../../rendio-turnos/admin-rutas.js', import.meta.url).pathname;
const CONSOLA_JS = new URL('../../rendio-turnos/admin-consola.js', import.meta.url).pathname;
const CATALOGO = new URL('../../docs/catalogo-residencias.json', import.meta.url).pathname;

const FORM = process.argv[2];
const DIA = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!FORM || !DIA) { console.error('uso: node plan-desde-formulario.mjs <form.json> YYYY-MM-DD [--carros=3] [--aero=0.80] [--techo=50]'); process.exit(1); }
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
const NCARROS = arg('carros', 3), AERO = arg('aero', 0.80), TECHO = arg('techo', 0), TECHO_PICO = arg('techopico', 0);
// Ventana de fusión de oleadas (route_merge_window_min). El jefe junta mucho más
// ancho de lo que tenemos calibrado: el 16-ago metió a Luz (se presenta 4:22) en
// la vuelta de Leon (3:50), 32 min de diferencia.
const HUECO = arg('hueco', 0);
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '01:30';
const JSONOUT = (process.argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || null;

// ── casas ───────────────────────────────────────────────────────────────────
const sbCat = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: resid } = await sbCat.from('residences').select('*');
const { buscar } = catalogo(resid || []);

// FUENTE PREFERIDA: el plan que el jefe armó PARA ESTE MISMO DÍA. Ahí él escribe
// al lado de cada persona dónde la recoge, y eso vale más que cualquier lista:
// es de ese día y lo dice quien maneja la operación. Se pasa por --plan-jefe=.
const PLAN_JEFE = (process.argv.find((a) => a.startsWith('--plan-jefe=')) || '').split('=')[1] || null;
const mapaJefe = new Map();
if (PLAN_JEFE) {
  for (const v of leerPlan(new URL('./planes-jefe/', import.meta.url).pathname, PLAN_JEFE)) {
    for (const p of v.paradas) {
      if (p.vuelo || p.hotel || p.aero || !p.lugar || !p.quien) continue;
      const c = buscar(p.lugar);
      if (!c || c.ambiguo) continue;
      // "farid, Manu V y lady" son varias personas en una línea.
      p.quien.split(/\s*,\s*|\s+y\s+/i).map((x) => norm(x)).filter(Boolean)
        .forEach((n) => { if (!mapaJefe.has(n)) mapaJefe.set(n, c); });
    }
  }
}

const cat = JSON.parse(readFileSync(CATALOGO, 'utf8'));
const gente = [];
for (const s of cat.sitios) for (const t of (s.tripulantes || [])) gente.push({ n: norm(t), nombre: t, sitio: s });
// El formulario trae apodos y solo el nombre de pila ("luzb", "Karol l", "Cata
// rico"). Se amarra por palabras compartidas, y si empatan dos personas se
// reporta en vez de elegir una.
function casaDe(nombre) {
  const t = norm(nombre);
  if (!t) return null;
  // 1) lo que dijo el jefe ese día, buscando por cualquier palabra del nombre
  //    (él escribe "gallón", "cano", "Karol L"; el formulario, el nombre completo).
  for (const p of t.split(' ').filter((x) => x.length >= 3)) {
    for (const [k, c] of mapaJefe) {
      if (k === t || k.split(' ').includes(p)) return { nombre, sitio: { nombre: c.nombre, lat: c.lat, lng: c.lon }, via: 'jefe' };
    }
  }
  // 2) el catálogo de residencias
  const exacto = gente.find((g) => g.n === t);
  if (exacto) return exacto;
  const pal = t.split(' ').filter((p) => p.length >= 3);
  const punt = gente.map((g) => {
    const gp = g.n.split(' ');
    let s = 0;
    for (const p of pal) if (gp.some((x) => x === p)) s += 2;
    else if (gp.some((x) => x.startsWith(p) || p.startsWith(x))) s += 1;
    return { g, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!punt.length) return null;
  if (punt.length > 1 && punt[1].s === punt[0].s) return { ...punt[0].g, ambiguo: punt.filter((x) => x.s === punt[0].s).map((x) => x.g.nombre) };
  return punt[0].g;
}

// Zona del jefe por conjunto (0062). Sin la migración el Map queda vacío y
// todo el día se programa con el modelo calculado, como antes.
const zonaJefePorNombre = new Map();
for (const r of resid || []) if (r.zona_jefe) zonaJefePorNombre.set(norm(r.name), r.zona_jefe);

// ── traslados del día ───────────────────────────────────────────────────────
const filas = JSON.parse(readFileSync(FORM, 'utf8')).filter((f) => f.fecha === DIA);
const aux = {}, sinCasa = [], ambiguos = [];
let nSal = 0, nLle = 0;
filas.forEach((f, i) => {
  const casa = casaDe(f.nombre);
  if (!casa) { sinCasa.push(f.nombre); return; }
  if (casa.ambiguo) ambiguos.push(`${f.nombre} → ${casa.ambiguo.join(' / ')}`);
  const base = {
    n: f.nombre, zona: casa.sitio.nombre, resId: 'r:' + norm(casa.sitio.nombre),
    // Zona de la tabla de tiempos de Julián (0062). null = todavía no la
    // confirmó para ese conjunto → esa parada se programa como antes.
    zonaJefe: zonaJefePorNombre.get(norm(casa.sitio.nombre)) || null,
    lat: casa.sitio.lat, lng: casa.sitio.lng, pax: 1,
    hotel: f.reserva, firme: false, notas: f.reserva ? 'RESERVA' : (f.pernocta ? 'pernocta' : ''),
  };
  if (f.presentacion) { aux[`s${i}`] = { ...base, dl: f.presentacion, type: 'sal', vuelo: '' }; nSal++; }
  if (f.llegada) { aux[`l${i}`] = { ...base, dl: f.llegada, type: 'lle', vuelo: (f.vuelo || '').toUpperCase() }; nLle++; }
});

// ── el solver real ──────────────────────────────────────────────────────────
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: st } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
const ajustes = { ...(st || {}) };
ajustes.route_airport_factor = AERO;
if (HUECO) ajustes.route_merge_window_min = HUECO;
if (TECHO) ajustes.route_max_wait_min = TECHO;
if (TECHO_PICO) ajustes.route_max_wait_peak_min = TECHO_PICO;

const SRC = readFileSync(RUTAS_JS, 'utf8');
const iFin = SRC.indexOf('return { lanes, order, unassigned };');
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = readFileSync(CONSOLA_JS, 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));
const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtCfg, rtSolveDay, rtCarCompute, rtBuildMatrix, rtStopKey, rtToMin, rtToHM };
`);
const S = fabrica({ settings: ajustes }, {}, {}, () => {}, () => null, globalThis.fetch);
S.rtCfg();
S.rt.aux = aux;
S.rt.day = DIA;
// LA TABLA DE JULIÁN (0062). Aquí no hay Api, así que se carga a mano y se
// enchufa en rt: el solver que se acaba de evaluar es el mismo de la PWA, así
// que en cuanto ve rt.ZONAS programa con la tabla.
{
  const [z, l] = await Promise.all([
    sb.from('route_zone_times').select('zone, band_from, band_to, min_minutes, max_minutes'),
    sb.from('route_leg_times').select('band_from, band_to, min_minutes, max_minutes'),
  ]);
  if (!z.error && (z.data || []).length) {
    const zonas = {};
    z.data.forEach((r) => { (zonas[r.zone] = zonas[r.zone] || []).push(r); });
    Object.values(zonas).forEach((a) => a.sort((x, y) => x.band_from - y.band_from));
    S.rt.ZONAS = zonas;
    S.rt.TRAMOS = (l.data || []).sort((x, y) => x.band_from - y.band_from);
  }
  // Domingo por fecha; festivo por tabla (en Colombia se corren al lunes).
  const esDomingo = new Date(DIA + 'T12:00:00').getDay() === 0;
  const { data: fest } = await sb.from('holidays').select('name').eq('day', DIA).maybeSingle();
  S.rt.esDiaLento = esDomingo || !!fest;
  S.rt.diaLentoNombre = fest ? fest.name : (esDomingo ? 'domingo' : null);
}
S.rt.cars = Array.from({ length: NCARROS }, (_, i) => ({ id: `V-0${i + 1}`, avail0: DESDE, capacity: 4 }));

let fuente = await S.rtBuildMatrix();
for (let k = 0; k < 3 && fuente === 'haversine'; k++) { await new Promise((r) => setTimeout(r, 1500)); fuente = await S.rtBuildMatrix(); }
if (fuente === 'haversine') { console.error('⚠  SIN OSRM — línea recta. No sirve para enseñar. Vuelve a correrlo.'); process.exit(3); }

const { lanes, order, unassigned } = S.rtSolveDay();
S.rt.lanes = lanes; S.rt.order = order;

// ── salida, con la forma que espera plan-a-whatsapp.mjs ─────────────────────
const vueltas = lanes.map((l) => {
  const c = S.rtCarCompute(l.id);
  const paradas = [];
  c.stops.forEach((s) => {
    const a = aux[s.id], k = S.rtStopKey(s.id), ult = paradas[paradas.length - 1];
    const p = { n: a.n, dl: a.dl, vuelo: a.vuelo, hotel: a.hotel, firme: a.firme };
    if (ult && ult.key === k) { ult.personas.push(p); return; }
    paradas.push({ key: k, zona: a.zona, eta: S.rtToHM(s.eta), personas: [p] });
  });
  return {
    id: l.id, carro: l.car, vuelta: l.vuelta, tipo: l.type, sale: l.start,
    origen: l.origin === 'airport' ? 'MDE' : (l.origin ? (aux[l.origin]?.zona || 'casa') : 'base'),
    aterriza: l.landing || null,
    llega: c.arrival != null ? S.rtToHM(c.arrival) : null,
    presentacion: l.type === 'sal' && c.hardDL != null ? S.rtToHM(c.hardDL) : null,
    holgura: c.holg, espera: c.wait || 0, estado: c.status, pax: c.pax, paradas,
  };
}).sort((a, b) => S.rtToMin(a.sale) - S.rtToMin(b.sale));

const salida = {
  dia: DIA, fuenteTiempos: fuente,
  ajustes: { hueco: S.rt.MERGE_WINDOW, servicio: S.rt.SERVICE_MIN, colchonAeropuerto: S.rt.AIRPORT_BUFFER, trafico: S.rt.TRAFFIC_FACTOR, turnaround: S.rt.TURNAROUND, desembarque: S.rt.DEPLANE, colchonSalida: S.rt.CUSHION, cupo: S.rt.CAP, factorAeropuerto: S.rt.AIRPORT_FACTOR, techoEspera: S.rt.MAX_WAIT, techoEsperaPico: S.rt.MAX_WAIT_PEAK },
  carros: S.rt.cars.map((c) => ({ id: c.id, cupo: c.capacity })),
  traslados: nSal + nLle, salidas: nSal, llegadas: nLle,
  diaLento: S.rt.diaLentoNombre,
  diaLentoShift: S.rt.esDiaLento ? S.rt.HOLIDAY_SHIFT : 0,
  conTabla: !!S.rt.ZONAS,
  vueltas, sinRutear: unassigned.map((id) => ({ n: aux[id].n, zona: aux[id].zona, dl: aux[id].dl, tipo: aux[id].type })),
};

console.log(`\n${filas.length} personas en el formulario para ${DIA} → ${nSal} salidas + ${nLle} llegadas = ${nSal + nLle} traslados`);
if (sinCasa.length) console.log(`SIN CASA EN EL CATÁLOGO (no se rutean, no se les inventa pin): ${[...new Set(sinCasa)].join(' · ')}`);
if (ambiguos.length) console.log(`NOMBRE AMBIGUO: ${ambiguos.join(' · ')}`);
const reservas = filas.filter((f) => f.reserva).map((f) => f.nombre);
if (reservas.length) console.log(`DE RESERVA (el jefe los manda al HOTEL; el formulario no dice destino): ${reservas.join(' · ')}`);
console.log(`vueltas ${vueltas.length} · tarde ${vueltas.filter((v) => v.estado === 'late').length} · sin rutear ${salida.sinRutear.length}`);

if (JSONOUT) { writeFileSync(JSONOUT, JSON.stringify(salida, null, 2)); console.log(`JSON → ${JSONOUT}`); }
