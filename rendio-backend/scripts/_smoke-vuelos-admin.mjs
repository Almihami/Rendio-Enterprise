// ADMIN › Rutas › Vuelos (0118 + 0122) — prueba en node + jsdom.
//
// Carga index.html + Leaflet + api.js + api-vuelos.js + vuelos-ui.js +
// admin-vuelos.js con un `sb` FALSO (reservations, flight_statuses,
// flight_watches, app_settings) y comprueba:
//   · el lector del plan de WhatsApp con el mensaje real de la profa (25-oct):
//     7 llegadas, las salidas y los «Debe estar» fuera, Lina repetida una vez; y
//     los dedazos (18;35, av 9563, P7617), la madrugada siguiente, hotel/Aero;
//   · la posición estimada: mitad del camino a mitad del vuelo, la posición real
//     de FR24 si es reciente, en tierra en el origen, en JMC al aterrizar, la ETA
//     ya pasada (se queda llegando), sin origen conocido = fuera del mapa;
//   · la pantalla: una fila por vuelo juntando reservas, pegados y FR24; el
//     resumen; quiénes vienen; el retraso; el mapa con un avión por vuelo en el
//     aire o en tierra; pegar → leer → seguir (upsert a flight_watches); quitar un
//     pegado; Mañana; bandera apagada; sin 0122.
//
// LO QUE NO CUBRE: cómo se ve (jsdom no hace layout ni carga los mosaicos del
// mapa: hay que mirarlo en el navegador y en el celular), la base real (RLS: eso
// es _verify-0122.mjs), Flightradar24.
//
//   cd rendio-backend && node scripts/_smoke-vuelos-admin.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const MIN = 60000;

// «Ahora»: domingo 25-oct-2026, 21:00 en Bogotá (02:00Z del 26).
const FAKE_NOW = Date.parse('2026-10-26T02:00:00Z');
const bog = (hhmm, dia = '2026-10-25') => new Date(`${dia}T${hhmm}:00-05:00`).toISOString();

const PLAN = `18:35 Paula londoño (JA5987)
18:40 Leslie (AV9563)

21:10 Guillermo (Terra)
Debe estar 21:30

21:15 Fabiana (P57617)
21:30 Lina (AV9384)
21:40 Andrea Núñez (P57278)
21:30 Lina (AV9384)

22:00 Jessica Duque (Solare)
Debe estar 22:20

22:00 Daniel Gallon (AV8441)

22:50 Duvan y Margy (AV9318)`;

// ── datos de PRUEBA ─────────────────────────────────────────────────────────
const RES = [{
  id: 'r1', direction: 'airport_to_home', pickup_address: 'El Olivar', required_arrival_at: bog('21:30'),
  status_h2a: null, status_a2h: 'scheduled', notes: 'Vuelo AV9384. ', cancelled_at: null, created_at: '2026-10-20T12:00:00Z',
  rating: null, rating_tags: null, rated_at: null, is_overnight: false, is_firm: true, cancellation_reason: null,
  ready_confirmed_at: null, ground_ops: false, reserve_place: null,
  auxiliar_profiles: { profiles: { id: 'p-r1', full_name: 'Valentina Ríos', phone: '' } },
}];
// Lista de los jefes (26-oct): una llegada SIN vuelo (se ve aparte), una de tierra
// y una de reserva en hotel (esas no tienen vuelo a propósito: no salen).
const R2 = (id, hh, nombre, o = {}) => Object.assign({}, RES[0], { id, required_arrival_at: bog(hh), notes: '', auxiliar_profiles: { profiles: { id: 'p-' + id, full_name: nombre, phone: '' } } }, o);
RES.push(R2('r2', '19:10', 'Marcela Gómez'), R2('r3', '20:00', 'Tierra Pérez', { ground_ops: true }), R2('r4', '20:30', 'Hotel Ruiz', { reserve_place: 'rio_verde' }));
const W = (id, code, hh, label, dia = '2026-10-25') => ({ id, flight_code: code, flight_date: dia, sched_at: bog(hh, dia), label, source: 'pegado' });
const WATCHES = [W('w1', 'JA5987', '18:35', 'Paula Londoño'), W('w2', 'AV9563', '18:40', 'Leslie'), W('w3', 'P57617', '21:15', 'Fabiana'), W('w4', 'AV9384', '21:30', 'Lina'),
  W('w9', 'AV231', '18:20', 'Mañana', '2026-10-26')];
const F = (code, o) => Object.assign({ flight_code: code, flight_date: '2026-10-25', direction: 'airport_to_home', sched_at: null, estimated_at: null, actual_at: null, departed_at: null,
  status: 'unknown', delay_min: null, origin_icao: null, source: 'flightradar24', fetched_at: new Date(FAKE_NOW - 4 * MIN).toISOString(), poll_mode: 'summary', raw: {} }, o);
const FS = [
  F('JA5987', { status: 'landed', sched_at: bog('18:35'), departed_at: bog('17:30'), actual_at: bog('18:50'), delay_min: 15, origin_icao: 'SKBO' }),
  F('AV9563', { status: 'landed', sched_at: bog('18:40'), departed_at: bog('17:45'), actual_at: bog('18:38'), delay_min: -2, origin_icao: 'SKBO' }),
  F('P57617', { status: 'in_air', sched_at: bog('21:15'), departed_at: bog('20:00'), estimated_at: bog('21:20'), delay_min: 5, origin_icao: 'SKBQ', poll_mode: 'live' }),
  F('AV9384', { status: 'in_air', sched_at: bog('21:30'), departed_at: bog('20:50'), estimated_at: bog('21:58'), delay_min: 28, origin_icao: 'SKBO', poll_mode: 'live',
    raw: { vuelo: { lat: 5.6, lon: -74.9, timestamp: new Date(FAKE_NOW - 3 * MIN).toISOString() } } }),
  F('AV9318', { status: 'scheduled', sched_at: bog('22:50'), origin_icao: 'SKCG' }),
];

function fakeSb(DB, log) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const tabla = (name) => {
    if (name === 'reservations') return DB.res;
    if (name === 'flight_statuses') return DB.fs;
    if (name === 'flight_watches') return DB.sin0122 ? null : DB.w;
    if (name === 'app_settings') return [{ id: 'singleton', flight_api_enabled: DB.enabled }];
    return null;
  };
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const q = { table: name, ops: [] };
    log.push(q);
    let one = null, borrar = false;
    const b = {
      select(cols) { q.ops.push(['select', cols]); return b; },
      eq(c, v) { q.ops.push(['eq', c, v]); return b; },
      gte(c, v) { q.ops.push(['gte', c, v]); return b; },
      lte(c, v) { q.ops.push(['lte', c, v]); return b; },
      order() { return b; },
      maybeSingle() { one = true; return b; },
      upsert(rows, opts) { q.upsert = { rows: cl(rows), opts }; return Promise.resolve({ data: null, error: null }); },
      delete() { borrar = true; q.borrar = true; return b; },
      then(res, rej) {
        const src = tabla(name);
        if (!src) return Promise.resolve({ data: null, error: { message: `relation "public.${name}" does not exist` } }).then(res, rej);
        let rows = src.slice();
        for (const [op, c, v] of q.ops) {
          if (op === 'eq') rows = rows.filter(r => r[c] === v);
          else if (op === 'gte') rows = rows.filter(r => val(r[c]) >= val(v));
          else if (op === 'lte') rows = rows.filter(r => val(r[c]) <= val(v));
        }
        if (borrar) { const ids = rows.map(r => r.id); DB.w = DB.w.filter(r => !ids.includes(r.id)); q.borrados = ids; return Promise.resolve({ data: null, error: null }).then(res, rej); }
        return Promise.resolve({ data: one ? (rows[0] ? cl(rows[0]) : null) : cl(rows), error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { from, rpc: async () => ({ data: null, error: { message: 'rpc' } }), auth: { getSession: async () => ({ data: { session: null } }) } };
}

async function boot({ enabled = true, sin0122 = false } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], log = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.console.warn = () => {};
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`Date.now = () => ${FAKE_NOW};`);
  w.RENDIO_CONFIG = {};
  const DB = { res: RES, fs: FS, w: WATCHES.slice(), enabled, sin0122 };
  w.sb = fakeSb(DB, log);
  for (const f of ['vendor/leaflet/leaflet.js', 'api.js', 'api-vuelos.js', 'vuelos-ui.js', 'admin-vuelos.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  w.document.querySelector('section[data-panel="vuelos"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const row = (code) => q(`#vu-lista [data-code="${code}"]`);
  const click = (el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return { w, DB, log, errors, q, qa, row, click };
}

// ══════════════════════════════════════════════════════════════════════════
const b0 = await boot();
const V = b0.w.renderVuelos;
t('admin-vuelos.js exporta renderVuelos y stopVuelosTimer', typeof V === 'function' && typeof b0.w.stopVuelosTimer === 'function', b0.errors.join(' | '));

console.log('\n── El plan de WhatsApp (el de la profa, 25-oct) ──');
{
  const r = V._leerPlan(PLAN, '2026-10-25');
  eq('7 llegadas, en orden de hora', r.vuelos.map(v => `${v.hora} ${v.code}`), ['18:35 JA5987', '18:40 AV9563', '21:15 P57617', '21:30 AV9384', '21:40 P57278', '22:00 AV8441', '22:50 AV9318']);
  eq('quiénes, como los escribió el jefe (Lina repetida, una vez)', r.vuelos.map(v => v.label), ['Paula londoño', 'Leslie', 'Fabiana', 'Lina', 'Andrea Núñez', 'Daniel Gallon', 'Duvan y Margy']);
  eq('las 2 salidas (Terra, Solare) y los 2 «Debe estar» quedan fuera', [r.salidas, r.deadlines, r.raras.length], [2, 2, 0]);
  eq('hora de Bogotá: 18:35 = 23:35Z', new Date(r.vuelos[0].ms).toISOString(), '2026-10-25T23:35:00.000Z');
  const d = V._leerPlan(`18;35 Ana (av 9563)\n13.45 Pepe (P7617)\n3:20 gloria (Cambulo)\n16:00 kris (Aero)\n11:30 Lau idarraga (hotel)\n00:40 Juan (AV9318)\n25:10 X (AV1234)`, '2026-10-25');
  eq('dedazos: 18;35 y «av 9563»; Wingo sin el 5 (P7617 → P57617)', d.vuelos.filter(v => v.dia === '2026-10-25').map(v => `${v.hora} ${v.code}`), ['13:45 P57617', '18:35 AV9563']);
  eq('00:40 en un plan con horas de la tarde = madrugada siguiente', d.vuelos.filter(v => v.code === 'AV9318').map(v => v.dia), ['2026-10-26']);
  eq('conjunto, Aero y hotel son salidas; 25:10 no es hora', [d.salidas, d.raras], [3, ['25:10 X (AV1234)']]);
  const s = V._leerPlan(`3:20 Isa (JA5477)\n5:40 Leo (AV9316)`, '2026-10-26');
  eq('un plan de pura madrugada se queda en su día', s.vuelos.map(v => v.dia), ['2026-10-26', '2026-10-26']);
  eq('texto vacío o sin vuelos: nada', [V._leerPlan('', '2026-10-25').vuelos.length, V._leerPlan('hola\n21:10 Guillermo (Terra)', '2026-10-25').vuelos.length], [0, 0]);
}

console.log('\n── Dónde va el avión (estimado) ──');
{
  const now = FAKE_NOW;
  const iso = (m) => new Date(now + m * MIN).toISOString();
  const v = (st) => ({ code: 'X', ref: now, quienes: [], st: Object.assign({ status: 'in_air', origin_icao: 'SKBO', raw: {} }, st) });
  let p = V._posicion(v({ departed_at: iso(-30), estimated_at: iso(30) }), now);
  const bog = V._aeropuerto('SKBO'), jmc = V._aeropuerto('SKRG');
  t('a mitad del vuelo: a mitad del camino Bogotá → JMC', p && Math.abs(p.frac - 0.5) < 0.01 && Math.abs(p.lat - (bog.lat + jmc.lat) / 2) < 0.05 && Math.abs(p.lon - (bog.lon + jmc.lon) / 2) < 0.05 && p.real === false, p);
  t('…apuntando hacia JMC (noroeste desde Bogotá: rumbo entre 270 y 360)', p && p.rumbo > 270 && p.rumbo < 360, p && p.rumbo);
  p = V._posicion(v({ departed_at: iso(-30), estimated_at: iso(30), raw: { vuelo: { lat: 5.9, lon: -75.0, timestamp: iso(-5) } } }), now);
  t('con posición real de FR24 de hace 5 min: arranca de ahí (real)', p && p.real === true && p.lat > 5.9 && p.lat < 6.17 && p.lon < -75.0 && p.lon > -75.43, p);
  p = V._posicion(v({ departed_at: iso(-30), estimated_at: iso(30), raw: { vuelo: { lat: 5.9, lon: -75.0, timestamp: iso(-50) } } }), now);
  t('posición real de hace 50 min: ya no se usa (sale del origen)', p && p.real === false, p);
  p = V._posicion(v({ departed_at: iso(-90), estimated_at: iso(-10) }), now);
  t('la ETA ya pasó y no ha aterrizado: se queda llegando (98,5 %)', p && p.frac === 0.985, p && p.frac);
  p = V._posicion(v({ departed_at: iso(-20), estimated_at: null }), now);
  t('sin ETA: se calcula con la distancia (Bogotá: llega en ~30 min)', p && p.llegaMs > now && p.llegaMs < now + 40 * MIN, p && (p.llegaMs - now) / MIN);
  p = V._posicion(v({ status: 'scheduled' }), now);
  t('en tierra: en su aeropuerto', p && p.en === 'tierra' && p.lat === bog.lat, p);
  p = V._posicion(v({ status: 'landed', actual_at: iso(-10) }), now);
  t('aterrizó: en JMC', p && p.en === 'jmc', p);
  t('origen que no está en la lista y sin posición real: fuera del mapa', V._posicion(v({ origin_icao: 'ZZZZ', departed_at: iso(-30), estimated_at: iso(30) }), now) === null);
  t('sin estado de FR24: fuera del mapa', V._posicion({ code: 'X', st: null }, now) === null);
  eq('estado sin dato, faltan 3 h: «Se empieza a seguir a las …»', V._estado({ ref: now + 3 * 60 * MIN, st: null }, now).txt, 'Se empieza a seguir a las 22:00');
  eq('estado unknown y ya pasaron 4 h: «No apareció en Flightradar24»', V._estado({ ref: now - 4 * 60 * MIN, st: { status: 'unknown' } }, now).txt, 'No apareció en Flightradar24');
}

console.log('\n── La pantalla ──');
{
  const b = b0;
  await b.w.renderVuelos(); await wait(60);
  t('carga y pinta sin errores', b.errors.length === 0 && !!b.q('#vu-card'), b.errors.join(' | '));
  const codes = b.qa('#vu-lista .vu-row').map(r => r.dataset.code);
  eq('una fila por vuelo, en orden de hora (pegados + reserva + FR24)', codes, ['JA5987', 'AV9563', 'P57617', 'AV9384', 'AV9318']);
  const res = txt(b.q('#vu-resumen'));
  t('resumen: «Hoy · 5 llegadas · 2 en el aire · 2 aterrizaron · 2 con retraso»', res === 'Hoy · 5 llegadas · 2 en el aire · 2 aterrizaron · 2 con retraso', res);
  const r4 = b.row('AV9384');
  const a = b.w.renderVuelos._armar([], [{ id: 'x', flight_code: 'JA5987', sched_at: bog('18:35'), label: 'Paula londoño, Ana' }], [{ flight: 'JA5987', name: 'Paula Londoño', when: bog('18:35') }]);
  eq('el mismo nombre con otra tilde o mayúscula sale una vez', a[0].quienes, ['Paula Londoño', 'Ana']);
  t('AV9384: quiénes = la reserva y el pegado juntos', txt(r4 && r4.querySelector('.vu-l2')) === 'Valentina Ríos, Lina', txt(r4 && r4.querySelector('.vu-l2')));
  t('…«1 reserva · pegado», desde Bogotá, Avianca', /1 reserva · pegado/.test(txt(r4)) && /desde Bogotá/.test(txt(r4)) && /Avianca/.test(txt(r4)), txt(r4));
  t('…«En el aire · llega 21:58» y «+28 min» en ámbar', /En el aire · llega 21:58/.test(txt(r4)) && !!r4.querySelector('.rvu-chip--warn') && /\+28 min/.test(txt(r4)), txt(r4));
  t('…la fila retrasada lleva su marca', r4 && r4.classList.contains('tarde'));
  t('JA5987: «Aterrizó 18:50», «+15 min», real 18:50', /Aterrizó 18:50/.test(txt(b.row('JA5987'))) && /\+15 min/.test(txt(b.row('JA5987'))), txt(b.row('JA5987')));
  t('AV9563 aterrizó 2 min antes: «a tiempo»', /a tiempo/.test(txt(b.row('AV9563'))), txt(b.row('AV9563')));
  t('AV9318 (solo FR24): «En tierra en Cartagena», sin botón de quitar', /En tierra en Cartagena/.test(txt(b.row('AV9318'))) && !b.row('AV9318').querySelector('.vu-x'), txt(b.row('AV9318')));
  t('los pegados traen su botón para dejar de seguirlos', !!b.row('JA5987').querySelector('.vu-x') && !!r4.querySelector('.vu-x'));
  const aviones = b.qa('#vu-map .vu-plane');
  eq('el mapa: un avión por vuelo en el aire o en tierra (P57617, AV9384, AV9318)', aviones.map(a => txt(a.querySelector('.vu-plane-tx'))).sort(), ['AV9318', 'AV9384', 'P57617']);
  t('…el retrasado en ámbar, el de tierra quieto', aviones.some(a => a.classList.contains('vu-plane--warn') && /AV9384/.test(txt(a))) && aviones.some(a => a.classList.contains('quieto') && /AV9318/.test(txt(a))));
  t('…y JMC marcado', !!b.q('#vu-map .vu-jmc'));
  t('el aviso de «posición estimada» está a la vista', /Posición estimada/.test(txt(b.q('.vu-maphint'))) && /Último dato de Flightradar24: 20:56/.test(txt(b.q('.vu-maphint'))), txt(b.q('.vu-maphint')));
  const qs = b.log.filter(x => x.table === 'flight_statuses' || x.table === 'flight_watches');
  t('pide los estados y los pegados solo de HOY (2026-10-25)', qs.length >= 2 && qs.every(x => x.ops.some(o => o[0] === 'eq' && o[1] === 'flight_date' && o[2] === '2026-10-25')), JSON.stringify(qs.map(x => x.ops)));

  // Lista de los jefes (26-oct): las llegadas de Reservas sin vuelo se ven aparte.
  const sv = b.q('#vu-lista .vu-sinvuelo');
  t('las llegadas de Reservas sin vuelo se ven aparte: «1 llegada sin número de vuelo · 19:10 Marcela Gómez»', sv && /1 llegada sin número de vuelo/.test(txt(sv)) && b.qa('#vu-lista .vu-sinvuelo-r').length === 1 && /19:10 Marcela Gómez/.test(txt(sv)), sv && txt(sv));
  t('…no salen las de tierra ni las de reserva en hotel', sv && !/Tierra Pérez|Hotel Ruiz/.test(txt(sv)));
  t('«Pegar la ruta» dice que es opcional y que Vuelos se llena solo', /opcional/.test(txt(b.q('#vu-pegar-card h2'))) && /se llena solo con las llegadas de Reservas y con la ruta de Julián/.test(txt(b.q('#vu-pegar-card'))));
  // La ruta de Julián (Asignación) pasa sola: seguirDesdeTexto.
  const nJ = b.log.length;
  const nV = await b.w.renderVuelos.seguirDesdeTexto(PLAN, '2026-10-25');
  const upJ = b.log.slice(nJ).find(x => x.upsert);
  t('seguirDesdeTexto (lo que usa la ruta de Julián): 7 vuelos a flight_watches, igual que pegar', nV === 7 && upJ && upJ.table === 'flight_watches' && upJ.upsert.rows.length === 7 && upJ.upsert.rows[0].source === 'pegado', JSON.stringify([nV, upJ && upJ.upsert.rows.length]));
  t('…un texto sin llegadas no guarda nada', (await b.w.renderVuelos.seguirDesdeTexto('3:10 Isa (Mota)\nDeben estar 3:40', '2026-10-25')) === 0);

  // Pegar → leer → seguir
  b.click(b.q('[data-vu="pegar-toggle"]')); await wait();
  const ta = b.q('#vu-texto');
  t('«Pegar» abre el cuadro de texto', !!ta);
  ta.value = PLAN; ta.dispatchEvent(new b.w.Event('input', { bubbles: true }));
  b.click(b.q('[data-vu="leer"]')); await wait();
  const prev = b.qa('.vu-prev-r');
  t('«Leer» muestra los 7 vuelos y «2 salidas ignoradas»', prev.length === 7 && /2 salidas ignoradas/.test(txt(b.q('.vu-prev-h'))), txt(b.q('.vu-prev')));
  t('el botón dice «Seguir 7 vuelos»', txt(b.q('[data-vu="guardar"]')) === 'Seguir 7 vuelos', txt(b.q('[data-vu="guardar"]')));
  const n0 = b.log.length;
  b.click(b.q('[data-vu="guardar"]')); await wait(60);
  const up = b.log.slice(n0).find(x => x.upsert);
  t('«Seguir» guarda en flight_watches (upsert por organización + vuelo + día)', up && up.table === 'flight_watches' && up.upsert.opts.onConflict === 'organization_id,flight_code,flight_date' && up.upsert.rows.length === 7, up && up.upsert);
  t('…con la hora de Bogotá en UTC y quiénes', up && up.upsert.rows[0].flight_code === 'JA5987' && up.upsert.rows[0].sched_at === '2026-10-25T23:35:00.000Z' && up.upsert.rows[0].label === 'Paula londoño' && up.upsert.rows[0].source === 'pegado', up && up.upsert.rows[0]);
  t('…dice «Listo: 7 vuelos» y cierra el cuadro', /Listo: 7 vuelos/.test(txt(b.q('#vu-pegar'))) && !b.q('#vu-texto'), txt(b.q('#vu-pegar')));

  // Quitar un pegado
  const n1 = b.log.length;
  b.click(b.row('JA5987').querySelector('.vu-x')); await wait(60);
  const del = b.log.slice(n1).find(x => x.borrar);
  t('× quita el vuelo pegado (delete por id)', del && del.table === 'flight_watches' && del.borrados && del.borrados[0] === 'w1', del);

  // Mañana
  const n2 = b.log.length;
  b.click(b.q('[data-vu="dia"][data-dia="manana"]')); await wait(60);
  const qm = b.log.slice(n2).filter(x => x.table === 'flight_watches');
  t('«Mañana» pide el 26 y muestra su pegado (AV231)', qm.some(x => x.ops.some(o => o[1] === 'flight_date' && o[2] === '2026-10-26')) && !!b.row('AV231') && /^Mañana · 1 llegada/.test(txt(b.q('#vu-resumen'))), txt(b.q('#vu-resumen')));
  b.w.stopVuelosTimer();
  t('stopVuelosTimer frena los relojes', b.w.renderVuelos._st.timerMapa === null && b.w.renderVuelos._st.timerDatos === null);
}

console.log('\n── Bandera apagada y base sin 0122 ──');
{
  const b = await boot({ enabled: false });
  await b.w.renderVuelos(); await wait(60);
  t('bandera apagada: lo dice arriba (y muestra lo último que se guardó)', /apagado/.test(txt(b.q('#vu-aviso'))) && b.qa('#vu-lista .vu-row').length === 5, txt(b.q('#vu-aviso')));
  b.w.stopVuelosTimer();
  const c = await boot({ sin0122: true });
  await c.w.renderVuelos(); await wait(60);
  t('sin 0122: «Falta la migración 0122», sin botón de pegar; el resto sigue', /Falta la migración 0122/.test(txt(c.q('#vu-pegar'))) && c.q('#vu-pegar-toggle').hidden && c.qa('#vu-lista .vu-row').length === 5, txt(c.q('#vu-pegar')));
  c.w.stopVuelosTimer();
  t('sin errores en consola', b.errors.length === 0 && c.errors.length === 0, [...b.errors, ...c.errors].join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
