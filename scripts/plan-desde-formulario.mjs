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
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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
const COLCHON = process.argv.some((a) => a.startsWith('--colchon=')) ? arg('colchon', 0) : null;
const SINTABLA = process.argv.includes('--sintabla');
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '01:30';
const JSONOUT = (process.argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || null;

// ── casas ───────────────────────────────────────────────────────────────────
const sbCat = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: resid } = await sbCat.from('residences').select('*');
const { buscar } = catalogo(resid || []);

// FUENTE PREFERIDA: los planes que el jefe armó a mano. Ahí él escribe al lado
// de cada persona dónde la recoge, y eso vale más que cualquier lista: lo dice
// quien maneja la operación.
//
// `--plan-jefe=archivo.txt` usa uno solo. `--plan-jefe=todos` usa TODOS los de
// la carpeta, del más reciente al más viejo, y el primero que aparezca gana — o
// sea que si alguien se mudó, manda el plan más nuevo. Esa es la forma de que
// cada corrección suya quede aprendida para los días siguientes: él pidió
// "guarden el historial de las rutas que hago para que entiendan mis
// decisiones" (17-ago-2026).
const DIR_JEFE = new URL('./planes-jefe/', import.meta.url).pathname;
const PLAN_JEFE = (process.argv.find((a) => a.startsWith('--plan-jefe=')) || '').split('=')[1] || null;
const PLANES_JEFE = PLAN_JEFE === 'todos'
  ? readdirSync(DIR_JEFE).filter((f) => f.startsWith('plan-') && f.endsWith('.txt'))
      .sort((a, b) => statSync(DIR_JEFE + b).mtimeMs - statSync(DIR_JEFE + a).mtimeMs)
  : PLAN_JEFE ? [PLAN_JEFE] : [];
const mapaJefe = new Map();
for (const archivo of PLANES_JEFE) {
  for (const v of leerPlan(DIR_JEFE, archivo)) {
    for (const p of v.paradas) {
      if (p.vuelo || p.hotel || p.aero || !p.lugar || !p.quien) continue;
      const c = buscar(p.lugar);
      // EL PLAN MÁS NUEVO MANDA, AUNQUE EL CONJUNTO NO TENGA PIN. Si se salta el
      // renglón, la mención vieja sobrevive y el carro se va a una dirección que
      // él YA corrigió: a Leslie la seguíamos mandando a Ébano (plan del 9-ago)
      // porque "Sanan" —lo que él escribió el 20— no está en el catálogo, y a Ana
      // María Vélez a Portón del Rosal porque falta "Cantabria". Se registra la
      // casa como desconocida para que la persona salga en la lista de "sin
      // casa" en vez de rodar con un pin equivocado en silencio.
      if (!c || c.ambiguo) {
        if (c?.ambiguo) continue;
        // Ni "J65417" ni "Av9260" son casas: son vuelos con una sigla que el
        // parser todavía no conoce (el prefijo J6 no está en la lista de
        // aerolíneas que él dictó). Un conjunto no lleva dos dígitos seguidos.
        if (/\d{2,}/.test(p.lugar)) continue;
        p.quien.split(/\s*,\s*|\s+y\s+/i).map((x) => norm(x)).filter(Boolean)
          .forEach((n) => { if (!mapaJefe.has(n)) mapaJefe.set(n, { sinPin: p.lugar }); });
        continue;
      }
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
// ALIAS: cómo escribe el formulario vs cómo escribe él. Cuando las dos formas no
// comparten ni una palabra ("Laura Valentina Fernández" en el formulario, "Lau
// Ortiz" en sus planes) ninguna coincidencia difusa las va a unir. Ver
// planes-jefe/alias.json. Si el archivo no está, no pasa nada.
let ALIAS = {};
try { ALIAS = JSON.parse(readFileSync(DIR_JEFE + 'alias.json', 'utf8')).alias || {}; } catch {}

function casaDe(nombre) {
  let t = norm(nombre);
  if (!t) return null;
  if (ALIAS[t]) t = norm(ALIAS[t]);
  // 1) LO QUE DIJO EL JEFE. Él escribe "gallón", "cano", "Karol L"; el formulario
  //    trae el nombre completo. Se puntúa igual que contra el catálogo y NO se
  //    elige cuando hay empate, porque bastaba una palabra suelta para acertar de
  //    casualidad: en la tripulación hay cuatro Lauras y tres Saras, y con
  //    "laura" a secas Laura Valentina Blanco caía en la casa de Laura Idárraga.
  //    Cuantos más planes suyos se acumulan, más se cruzan los nombres de pila.
  const palT = t.split(' ').filter((x) => x.length >= 3);
  const cand = [];
  for (const [k, c] of mapaJefe) {
    if (k === t) return c.sinPin ? { sinPin: c.sinPin } : { nombre, sitio: { nombre: c.nombre, lat: c.lat, lng: c.lon }, via: 'jefe' };
    const palK = k.split(' ');
    let s = 0;
    for (const p of palT) if (palK.includes(p)) s += 2;
      else if (palK.some((x) => x.length >= 4 && p.length >= 4 && (x.startsWith(p) || p.startsWith(x)))) s += 1;
    if (s > 0) cand.push({ k, c, s });
  }
  if (cand.length) {
    // EL NOMBRE DE PILA TIENE QUE COINCIDIR. "Camilo Andres Ramirez sanchez"
    // empata a dos palabras con "Camilo Ramírez" (Quintas Blancas) y con
    // "Andrés Sánchez" (Río Vivo), porque el formulario mete cuatro nombres en
    // una casilla. El de pila desempata. Se acepta prefijo porque él escribe
    // "Lau" por "Laura" y "Cata" por "Catalina".
    const pila = palT[0] || '';
    const mismoPila = cand.filter((x) => {
      const pk = x.k.split(' ')[0] || '';
      return pk === pila || (pk.length >= 3 && pila.length >= 3 && (pk.startsWith(pila) || pila.startsWith(pk)));
    });
    // ÉL TAMBIÉN ESCRIBE SOLO EL APELLIDO: "González (Olivar)", "Rubiano
    // (Solare)", "Lesmes". Exigir el nombre de pila dejaba fuera justo esos —
    // "sebastian gonzalez" contra "gonzalez" no comparte el de pila— y el
    // formulario se iba al catálogo, que mandaba a sebastián González a
    // Portobello cuando el jefe acababa de escribir Olivar. Si el apellido
    // apunta a UN solo candidato no hay a quién confundir; el empate sigue
    // cayendo al catálogo.
    if (mismoPila.length) cand.length = 0, cand.push(...mismoPila);
    cand.sort((a, b) => b.s - a.s);
    const top = cand.filter((x) => x.s === cand[0].s);
    const casas = [...new Set(top.map((x) => x.c.nombre))];
    // Una sola palabra en común (s === 2) y más de un candidato: no alcanza para
    // decidir. Se cae al catálogo, que puntúa con el nombre completo.
    if (casas.length === 1 && (cand[0].s >= 4 || top.length === 1)) {
      const c = top[0].c;
      return c.sinPin ? { sinPin: c.sinPin } : { nombre, sitio: { nombre: c.nombre, lat: c.lat, lng: c.lon }, via: 'jefe' };
    }
  }
  // 2) el catálogo de residencias
  const exacto = gente.find((g) => g.n === t);
  if (exacto) return exacto;
  const pal = t.split(' ').filter((p) => p.length >= 3);
  // UN DEDAZO NO DEBERÍA VOLVER AMBIGUO UN NOMBRE. El formulario del 21-ago trae
  // "Laura yalsnda": con la 's' cambiada empataba con Laura Ortiz, Laura Yalanda
  // y Laura Blanco por la sola palabra "laura", y la casa salía de un empate.
  // Una letra de diferencia en una palabra larga es la misma palabra.
  const lev = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  const punt = gente.map((g) => {
    const gp = g.n.split(' ');
    let s = 0;
    for (const p of pal) if (gp.some((x) => x === p)) s += 2;
    else if (gp.some((x) => x.startsWith(p) || p.startsWith(x))) s += 1;
    else if (gp.some((x) => x.length >= 5 && p.length >= 5 && lev(x, p) <= 1)) s += 2;
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

// LA HORA DE LLEGADA DEL FORMULARIO VIENE SUELTA Y A VECES MAL. Dos arreglos,
// los dos deducidos de correcciones que hizo Julián a mano:
//
//  · Entre 00:00 y 01:59 → es la madrugada del día SIGUIENTE. En sus planes esas
//    vueltas CIERRAN el día, no lo abren (el del 17-ago termina con la llegada
//    de 0:53). Puestas al principio quedaban antes de que arranque la jornada y
//    salían "quizás no haya carro" cuando a esa hora el carro está libre.
//
//  · Antes de la presentación y entre las 02:00 y las 11:59 → venía escrita en
//    AM siendo PM. Él corrigió el AV203 de David Estrada: el formulario decía
//    03:45 y la puso en 15:45. Nadie aterriza a las 3:45 si se presenta a las
//    5:05 del mismo día.
function dlLlegada(presentacion, llegada) {
  const aMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const aHM = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const t = aMin(llegada);
  if (t < 2 * 60) return aHM(t + 24 * 60);
  //  · Antes de la presentación pero con MUCHAS horas de diferencia → no hay
  //    dedazo: aterriza en la mañana y sale en la noche, el mismo día. Julián lo
  //    escribió así en su corrección del 21-ago: Josselyn se presenta 22:00 y
  //    llega 6:00, y él puso "6:00 Josselin (Aero)" entre la vuelta de las 5:40
  //    y el vuelo de las 6:35 — o sea a las 6 de ESA mañana, con carro. A las
  //    18:00 (el +12) es imposible: es antes de que ella salga.
  //    El corte son 6 horas: el AV203 de David Estrada llegaba "03:45" con
  //    presentación 5:05 —una hora y veinte— y ahí sí era PM (él lo movió a
  //    15:45). Nadie aterriza 80 minutos antes de volver a presentarse.
  if (presentacion && t < aMin(presentacion)) {
    const p = aMin(presentacion);
    if (p - t >= 6 * 60) return llegada;              // llegada de la mañana, misma fecha
    if (t < 12 * 60) return aHM(t + 12 * 60 > p ? t + 12 * 60 : t + 24 * 60);
  }
  return llegada;
}

// ── traslados del día ───────────────────────────────────────────────────────
const filas = JSON.parse(readFileSync(FORM, 'utf8')).filter((f) => f.fecha === DIA);
const aux = {}, sinCasa = [], ambiguos = [], faltaPin = [];
let nSal = 0, nLle = 0;
filas.forEach((f, i) => {
  const casa = casaDe(f.nombre);
  if (casa?.sinPin) { faltaPin.push(`${f.nombre} → ${casa.sinPin}`); return; }
  if (!casa) { sinCasa.push(f.nombre); return; }
  // EMPATE = NO SE RUTEA. Antes se avisaba del empate y aun así se usaba la casa
  // del primer candidato: en la tripulación hay cuatro Lauras, tres Saras y tres
  // Karoles, así que ese "primero" es una moneda al aire y el carro se iba a la
  // portería de otra persona. Mejor decirlo y que él lo corrija.
  if (casa.ambiguo) { ambiguos.push(`${f.nombre} → ${casa.ambiguo.join(' / ')}`); return; }
  const base = {
    n: f.nombre, zona: casa.sitio.nombre, resId: 'r:' + norm(casa.sitio.nombre),
    // Zona de la tabla de tiempos de Julián (0062). null = todavía no la
    // confirmó para ese conjunto → esa parada se programa como antes.
    zonaJefe: zonaJefePorNombre.get(norm(casa.sitio.nombre)) || null,
    lat: casa.sitio.lat, lng: casa.sitio.lng, pax: 1,
    hotel: f.reserva, firme: false, notas: f.reserva ? 'RESERVA' : (f.pernocta ? 'pernocta' : ''),
  };
  if (f.presentacion) { aux[`s${i}`] = { ...base, dl: f.presentacion, type: 'sal', vuelo: '' }; nSal++; }
  if (f.llegada) { aux[`l${i}`] = { ...base, dl: dlLlegada(f.presentacion, f.llegada), type: 'lle', vuelo: (f.vuelo || '').toUpperCase() }; nLle++; }
});

// UN VUELO LLEGA A UNA SOLA HORA. Cada tripulante llena el formulario aparte y
// la escriben distinta: en el AV221 del 19-ago Josmar puso 14:20 y Ximena 14:40;
// en el JA5139 del 18, Fernando 11:11 y Paula 12:00. Con horas distintas el
// solver los ve como dos llegadas y los reparte en carros distintos, cuando bajan
// del mismo avión. Se unifica ANTES de resolver, con la MÁS TEMPRANA — que es lo
// que Julián hizo en los dos casos, y el lado seguro: esperar en el terminal
// cuesta menos que llegar tarde.
//
// Julián pidió resolverlo consultando la API de vuelos para tomar la hora real de
// aterrizaje. Mientras no la haya, esta es la regla que se saca de sus
// correcciones; cuando entre la API, aquí es donde se reemplaza.
{
  // Se agrupa por los DÍGITOS: unos escriben "JA5139" y otros "5139" pelado, y
  // son el mismo avión. Si las dos traen sigla y son distintas, no se tocan.
  const porVuelo = new Map();
  for (const [id, a] of Object.entries(aux)) {
    if (a.type !== 'lle' || !a.vuelo) continue;
    const num = a.vuelo.replace(/[^0-9]/g, '');
    if (!num) continue;
    const sig = a.vuelo.replace(/[^A-Z]/g, '');
    if (!porVuelo.has(num)) porVuelo.set(num, []);
    porVuelo.get(num).push({ id, sig });
  }
  const aMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  // SOLO cuando el desacuerdo es real. En el JA5477 del 18-ago las tres pusieron
  // 13:13, 13:14 y 13:15, y Julián copió las tres tal cual: dos minutos son
  // ruido de quien llenó el formulario, no dos horas de llegada distintas.
  // Se unifica desde 6 minutos de separación en adelante.
  const RUIDO = 5;
  for (const [num, lista] of porVuelo) {
    if (lista.length < 2) continue;
    const siglas = [...new Set(lista.map((x) => x.sig).filter(Boolean))];
    if (siglas.length > 1) continue;                  // AV221 y JA221 no son el mismo vuelo
    const horas = lista.map((x) => aux[x.id].dl);
    const min0 = Math.min(...horas.map(aMin)), max0 = Math.max(...horas.map(aMin));
    if (max0 - min0 <= RUIDO) continue;
    const pronto = horas.sort((x, y) => aMin(x) - aMin(y))[0];
    console.log(`VUELO ${(siglas[0] || '') + num}: el formulario trae ${[...new Set(horas)].join(' · ')} → se usa ${pronto} (${max0 - min0} min de diferencia)`);
    lista.forEach((x) => { aux[x.id].dl = pronto; });
  }
}

// ── el solver real ──────────────────────────────────────────────────────────
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: st } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
const ajustes = { ...(st || {}) };
ajustes.route_airport_factor = AERO;
// Perillas para calibrar contra sus planes sin tocar la BD ni el código de la
// PWA: --colchon= es route_zone_cushion_min y --sintabla ignora la tabla de zona
// (vuelve al modelo de distancias reales + factor de aeropuerto).
if (COLCHON != null) ajustes.route_zone_cushion_min = COLCHON;
// A/B del rescate ("adelantar antes de dejar sin carro"): --sin-rescate lo apaga.
if (process.argv.includes('--sin-rescate')) ajustes.route_rescue_early = 0;
if (process.argv.some((a) => a.startsWith('--madrugada='))) ajustes.route_rescue_max_early_min = arg('madrugada', 45);
if (process.argv.includes('--llenar')) ajustes.route_car_priority = 1;
if (HUECO) ajustes.route_merge_window_min = HUECO;
if (TECHO) ajustes.route_max_wait_min = TECHO;
if (TECHO_PICO) ajustes.route_max_wait_peak_min = TECHO_PICO;

let SRC = readFileSync(RUTAS_JS, 'utf8');
// ENSAYO: el colchón de la tabla de zona también en las vueltas de UNA parada.
// La regla `ids.length > 1` salió de 31 vueltas suyas (18 y 19 de agosto); sus
// correcciones del 20 y 21 la contradicen (tramos de 15-30 min donde la tabla
// pide 35-50). Se prueba acá antes de tocar la app.
if (process.argv.includes('--colchon-siempre')) {
  const antes = SRC;
  SRC = SRC.replace('const colchon = ids.length > 1 ? rt.ZONE_CUSHION : 0;', 'const colchon = rt.ZONE_CUSHION;');
  if (SRC === antes) { console.error('⚠  no encontré la línea del colchón en admin-rutas.js'); process.exit(3); }
}
const iFin = SRC.indexOf('return { lanes, order, unassigned };');
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = readFileSync(CONSOLA_JS, 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));
const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtCfg, rtSolveDay, rtCarCompute, rtBuildMatrix, rtStopKey, rtToMin, rtToHM, rtDurProg, rtTripParts };
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
  if (!SINTABLA && !z.error && (z.data || []).length) {
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
  vueltas,
  // LOS QUE NO CABEN TAMBIÉN NECESITAN SU HORA DE RECOGIDA. Antes solo se
  // pasaba `dl`, que en una salida es la PRESENTACIÓN, y el formato la imprimía
  // en el renglón de la recogida. Julián lo cazó el 18-ago: "puso a Jolene a las
  // 15:04 de recogida, y a esa hora tiene que estar en el aeropuerto; tenía que
  // haber puesto 14:04 o 14:05". Se estima con el mismo modelo que las vueltas
  // que sí tienen carro, para que el hueco se lea en la hora que le toca.
  sinRutear: unassigned.map((id) => {
    const a = aux[id];
    let eta = null;
    if (a.type === 'sal') {
      try {
        const { dur, hastaUltima } = S.rtTripParts([id], null);
        const llegar = S.rtToMin(a.dl) - (Number(ajustes.route_airport_buffer_min) || 10);
        eta = S.rtToHM(Math.max(0, llegar - S.rtDurProg([id], llegar, dur, hastaUltima)));
      } catch { eta = null; }
    }
    return { n: a.n, zona: a.zona, dl: a.dl, eta, tipo: a.type };
  }),
};

console.log(`\n${filas.length} personas en el formulario para ${DIA} → ${nSal} salidas + ${nLle} llegadas = ${nSal + nLle} traslados`);
// Estos son los caros: el jefe SÍ dijo dónde viven, nos falta el pin. Salen
// aparte de los desconocidos porque se arreglan con una coordenada, no con una
// pregunta.
if (faltaPin.length) console.log(`EL JEFE DIJO LA CASA Y NO TENEMOS EL PIN (falta la coordenada en el catálogo): ${[...new Set(faltaPin)].join(' · ')}`);
if (sinCasa.length) console.log(`SIN CASA EN EL CATÁLOGO (no se rutean, no se les inventa pin): ${[...new Set(sinCasa)].join(' · ')}`);
if (ambiguos.length) console.log(`NOMBRE AMBIGUO: ${ambiguos.join(' · ')}`);
const reservas = filas.filter((f) => f.reserva).map((f) => f.nombre);
if (reservas.length) console.log(`DE RESERVA (el jefe los manda al HOTEL; el formulario no dice destino): ${reservas.join(' · ')}`);
console.log(`vueltas ${vueltas.length} · tarde ${vueltas.filter((v) => v.estado === 'late').length} · sin rutear ${salida.sinRutear.length}`);

if (JSONOUT) { writeFileSync(JSONOUT, JSON.stringify(salida, null, 2)); console.log(`JSON → ${JSONOUT}`); }
