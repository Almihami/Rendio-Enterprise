// Operación en vivo por CARRO y vueltas terminadas (26-oct-2026) — prueba jsdom.
//
// Pedido de la profa (captura de Operación del lunes 26):
//   1) «los turnos que ya se hicieron siguen apareciendo como si todavía no se
//      hicieran: degradados, verde si fueron exitosos, rojo si pasó alguna novedad».
//   2) «veo muchísimas tarjetas, hasta de Juan Ospina: una tarjeta por carro con
//      su placa, que cambie según la actividad, y al darle clic me diga qué está
//      haciendo; la actividad en vivo segmentada por carro y sin cortar».
// Causas: la base nunca pasa una vuelta a 'completed', y desde 0124 la placa
// llega solo al iniciar turno → se agrupaba por `vehicle_id || vuelta`.
//
// Comprueba, con los archivos de verdad:
//   A) api.js (sb falso): listLiveOperation agrupa por carro (las vueltas sin
//      placa van con su conductor, o con la placa que ya tenga hoy), cómo terminó
//      cada vuelta (ok / no-show / tarde / reporte / sin marcar / en curso), la
//      frase de «qué hace ahora», el orden, la actividad por carro con nombre
//      completo y sin «V..», y que solo se lea desde el día de turno.
//   B) getPublishedPlan trae el mismo resultado por vuelta (para Asignación).
//   C) admin-operacion.js: tarjetas, detalle al tocar (sigue abierto tras el
//      refresco), actividad separada por carro, «Sin turno» y KPIs.
//   D) Asignación (admin-rutas-v2.js): la vuelta terminada sale degradada en
//      verde o roja con su motivo, y la pasada sin marcas en gris.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: ver las capturas con Chromium de
// la sesión y revisarlo en el equipo del jefe), la base real (RLS de incidents
// y shifts para el jefe, que PostgREST acepte las consultas), el mapa Leaflet
// real ni OSRM.
//
//   cd rendio-backend && node scripts/_smoke-operacion-1026-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// Como se lee en pantalla: un espacio entre elementos (textContent los pega).
const leer = (el) => { if (!el) return null; const p = []; const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 3) p.push(c.textContent); else { walk(c); p.push(' '); } }); }; walk(el); return p.join('').replace(/\s+/g, ' ').trim(); };

// ── El día de prueba: lunes 26-oct-2026, 10:00 a. m. en Bogotá ──────────────
const DAY = '2026-10-26';
const at = (hm, d = DAY) => new Date(`${d}T${hm}:00-05:00`).toISOString();
const AHORA = Date.parse(at('10:00'));
const veh = (k) => ({ AAA: { license_plate: 'AAA111', internal_code: 'AAA111', capacity: 4 }, BBB: { license_plate: 'BBB222', internal_code: 'BBB222', capacity: 4 }, CCC: { license_plate: 'CCC333', internal_code: 'CCC333', capacity: 4 } })[k];
const DRV = { m: 'Miguel Ángel Peña', j: 'Julián David López', o: 'Juan Ospina', a: 'Juan Andrés Mery' };
let nStop = 0;
// stop(nombre, conjunto, estado, { req, arr, pick, drop, cancel })
const stop = (n, lugar, status, o = {}) => {
  nStop++;
  return { stop_order: nStop, status, reservation_id: 'res-' + nStop,
    actual_arrival_at: o.arr ? at(o.arr) : null, actual_pickup_at: o.pick ? at(o.pick) : null, actual_dropoff_at: o.drop ? at(o.drop) : null,
    reservations: { pickup_address: lugar + ', Rionegro', pickup_latitude: 6.15, pickup_longitude: -75.37, required_arrival_at: o.req ? at(o.req) : null,
      cancelled_at: o.cancel ? at('01:00') : null, notes: 'Vuelo AV9412.', ground_ops: false, reserve_place: null,
      residences: { name: lugar }, auxiliar_profiles: { profiles: { full_name: n } }, flights: null } };
};
const RA = (id, dir, hm, d, v, stops, dia = DAY) => ({ id, direction: dir === 'lle' ? 'airport_to_home' : 'home_to_airport', planned_start_at: at(hm, dia), status: 'planned',
  driver_profile_id: d ? 'dp-' + d : null, vehicle_id: v ? 'veh-' + v : null, vehicles: v ? veh(v) : null,
  driver_profiles: d ? { profiles: { full_name: DRV[d], phone: d === 'm' ? '300 111 2233' : '' } } : null, route_stops: stops });
const tablas = {
  app_settings: [{ id: 'singleton', route_night_cutoff_min: 120 }],
  route_assignments: [
    RA('ra1', 'sal', '03:00', 'm', 'AAA', [stop('Sebastian Velez Gaviria', 'Edificio Portobello', 'delivered', { req: '04:30', arr: '03:05', pick: '03:10', drop: '03:50' })]),
    RA('ra2', 'sal', '05:00', 'm', 'AAA', [stop('Andrea Núñez Pérez', 'Riovivo', 'delivered', { req: '06:00', pick: '05:20', drop: '06:20' })]),
    RA('ra3', 'sal', '07:00', 'm', 'AAA', [stop('Laura N.', 'Ruta 39', 'no_show', { req: '08:00', arr: '07:05' }), stop('Sara Villegas', 'Edificio Cámbulo', 'delivered', { req: '08:00', pick: '07:20', drop: '07:50' })]),
    RA('ra4', 'sal', '08:00', 'm', 'AAA', [stop('Luz Bomba', 'Bosques del Norte', 'delivered', { req: '09:00', pick: '08:10', drop: '08:45' })]),
    RA('ra5', 'sal', '09:40', 'm', 'AAA', [stop('Karol <b>Martínez</b>', 'Edificio Cámbulo', 'picked_up', { req: '11:00', arr: '09:45', pick: '09:50' }), stop('Michell Rodriguez Calderon', 'Riovivo', 'pending', { req: '11:00' }), stop('Cancelada', 'X', 'pending', { req: '11:00', cancel: true })]),
    RA('ra6', 'lle', '12:00', 'm', 'AAA', [stop('Isabella Páez', 'Marinilla vereda', 'pending')]),
    RA('ra7', 'sal', '04:00', 'j', 'BBB', [stop('Manuela Velasquez', 'Boral Apartamentos', 'pending', { req: '05:00' })]),
    RA('ra8', 'sal', '09:50', 'j', 'BBB', [stop('Margy Evans', 'Riovivo', 'pending', { req: '10:40' })]),
    RA('ra9', 'lle', '22:00', 'j', null, [stop('Farid Restrepo', 'Olivar Apartamentos', 'pending')]),
    RA('ra10', 'sal', '14:00', 'o', null, [stop('Wilson Ruiz', 'Origen del Lago', 'pending', { req: '15:00' })]),
    RA('ra11', 'sal', '11:40', null, null, [stop('Yalimar Peñaranda', 'Edificio Los Cerezos', 'pending', { req: '12:30' })]),
    RA('ra12', 'sal', '18:00', 'm', 'AAA', [stop('De Ayer', 'Riovivo', 'pending', { req: '19:00' })], '2026-10-25'),
    RA('ra13', 'sal', '03:30', 'a', 'CCC', [stop('Maria Camila Cano', 'Ruta 39', 'delivered', { req: '04:30', arr: '03:20', pick: '03:42', drop: '03:57' })]),
  ],
  shifts: [
    { driver_id: 'dp-m', status: 'active', start_at: at('02:18'), end_at: null },
    { driver_id: 'dp-j', status: 'active', start_at: at('02:43'), end_at: null },
    { driver_id: 'dp-a', status: 'closed', start_at: at('01:52'), end_at: at('04:30') },
  ],
  incidents: [
    { id: 'i1', category: 'traffic', source: 'driver', scope: 'operacion', route_assignment_id: 'ra4', reservation_id: null, occurred_at: at('08:20') },
    // Lo automático y los cambios de vuelo NO son novedad.
    { id: 'i2', category: 'late_booking', source: 'system', scope: 'operacion', route_assignment_id: 'ra1', reservation_id: null, occurred_at: at('02:30') },
    { id: 'i3', category: 'flight_delay', source: 'auxiliar', scope: 'operacion', route_assignment_id: null, reservation_id: 'res-1', occurred_at: at('02:40') },
    { id: 'i4', category: 'vehicle_problem', source: 'driver', scope: 'flota', route_assignment_id: 'ra1', reservation_id: null, occurred_at: at('02:50') },
  ],
  driver_locations: [
    { driver_profile_id: 'dp-m', latitude: 6.16, longitude: -75.40, source: 'gps', recorded_at: at('09:59'), route_assignment_id: 'ra5' },
  ],
};
const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
function fakeSb(log) {
  return {
    from(name) {
      const ops = []; let one = null;
      const bld = {
        select(c) { ops.push(['select', c]); return bld; }, eq(c, v) { ops.push(['eq', c, v]); return bld; }, gte(c, v) { ops.push(['gte', c, v]); return bld; },
        lte(c, v) { ops.push(['lte', c, v]); return bld; }, lt(c, v) { ops.push(['lt', c, v]); return bld; }, in(c, v) { ops.push(['in', c, v]); return bld; },
        is(c, v) { ops.push(['is', c, v]); return bld; }, order(c, o) { ops.push(['order', c, o]); return bld; }, limit() { return bld; },
        maybeSingle() { one = 'maybe'; return bld; }, single() { one = 'single'; return bld; },
        then(ok2, ko) {
          log.push({ name, ops });
          let rows = (tablas[name] || []).slice();
          for (const [op, c, v] of ops) {
            if (op === 'eq') rows = rows.filter((r) => r[c] === v);
            else if (op === 'gte') rows = rows.filter((r) => val(r[c]) >= val(v));
            else if (op === 'lte') rows = rows.filter((r) => val(r[c]) <= val(v));
            else if (op === 'lt') rows = rows.filter((r) => val(r[c]) < val(v));
            else if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
            else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
            else if (op === 'order') rows.sort((a, z) => ((val(a[c]) > val(z[c]) ? 1 : -1) * (v && v.ascending === false ? -1 : 1)));
          }
          return Promise.resolve({ data: JSON.parse(JSON.stringify(one ? (rows[0] || null) : rows)), error: null }).then(ok2, ko);
        },
      };
      return bld;
    },
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
  };
}
function apiReal() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const log = [];
  w.sb = fakeSb(log);
  w.RENDIO_CONFIG = {};
  w.Date.now = () => AHORA;
  w.eval(read('api.js'));
  return { A: w.Api, log };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · listLiveOperation: una tarjeta por carro y cómo terminó cada vuelta ──');
let LIVE;
{
  const { A, log } = apiReal();
  const op = await A.listLiveOperation();
  LIVE = op;
  const cars = op.cars;
  const de = (p) => cars.find((c) => c.plate === p);
  t('una tarjeta por carro: AAA111, BBB222, la de Juan Ospina (sin placa) y CCC333 — no una por vuelta', cars.length === 4 && op.day === DAY, JSON.stringify(cars.map((c) => c.id)));
  t('orden: el que va en ruta, el que espera con turno, el que no ha iniciado, y el que terminó al final', cars.map((c) => c.plate || c.driver).join(',') === 'AAA111,BBB222,Juan Ospina,CCC333', cars.map((c) => c.plate || c.driver).join(','));
  t('la vuelta sin conductor ni placa no hace tarjeta, y la de ayer no entra', !cars.some((c) => c.vueltas.some((v) => v.id === 'ra11' || v.id === 'ra12')));
  const ra = log.find((x) => x.name === 'route_assignments');
  t('solo se lee desde el inicio del día de turno (antes se traía toda la historia cada 5 s)', ra && ra.ops.some((o) => o[0] === 'gte' && o[1] === 'planned_start_at' && o[2] === at('02:00')), ra && JSON.stringify(ra.ops.filter((o) => o[0] !== 'select')));
  t('…y trae también las que la base sí haya cerrado (completed)', ra && JSON.stringify(ra.ops.find((o) => o[0] === 'in')[2]) === '["planned","in_progress","completed"]');

  const a = de('AAA111');
  const est = (c) => c.vueltas.map((v) => v.estado).join(',');
  t('AAA111: hecha · tarde · no-show · reporte · en curso · pendiente', est(a) === 'ok,bad,bad,bad,curso,falta', est(a));
  t('rojo por llegar después de la hora pedida: «llegó 20 min después de la hora pedida»', a.vueltas[1].motivos.join() === 'llegó 20 min después de la hora pedida', a.vueltas[1].motivos.join('|'));
  t('rojo por no-show: «1 no se presentó»', a.vueltas[2].motivos.join() === '1 no se presentó', a.vueltas[2].motivos.join('|'));
  t('rojo por reporte del conductor: «trancón»', a.vueltas[3].motivos.join() === 'trancón', a.vueltas[3].motivos.join('|'));
  t('verde: el aviso automático (reserva tardía), el cambio de vuelo y la novedad de flota NO cuentan', a.vueltas[0].estado === 'ok' && !a.vueltas[0].motivos.length && a.vueltas[0].fin === '03:50', JSON.stringify(a.vueltas[0]));
  t('AAA111 «En ruta» y en una frase: «Recogiendo · va por Michell Rodriguez Calderon a Riovivo · 1 a bordo»', a.status === 'En ruta' && a.enCurso && a.ahora === 'Recogiendo · va por Michell Rodriguez Calderon a Riovivo · 1 a bordo', a.ahora);
  t('la parada cancelada no cuenta (2 personas en la vuelta en curso, 1 a bordo)', a.paxTotal === 2 && a.pax === 1, JSON.stringify([a.paxTotal, a.pax]));
  t('resumen: 4 hechas, 3 con novedad, 0 sin marcar, 2 por hacer', JSON.stringify(a.resumen) === '{"hechas":4,"conNovedad":3,"sinMarcar":0,"faltan":2}', JSON.stringify(a.resumen));
  t('conductor y teléfono del carro', a.driver === DRV.m && a.driverPhone === '300 111 2233' && a.turno === 'abierto');

  const b = de('BBB222');
  t('BBB222: la vuelta de las 04:00 que nadie marcó queda «sin marcar» (no verde)', b.vueltas[0].estado === 'sinmarcar' && b.vueltas[0].faltan === 1, JSON.stringify(b.vueltas[0]));
  t('la vuelta SIN placa de Julián (22:00) va a la tarjeta de su carro, no a una aparte', b.vueltas.map((v) => v.id).join() === 'ra7,ra8,ra9', b.vueltas.map((v) => v.id).join());
  t('arrancó hace 10 min sin marcas: «Sin marcar» y «La vuelta de las 09:50 no tiene marcas todavía · primera: Margy Evans en Riovivo»', b.status === 'Sin marcar' && !b.enCurso && b.ahora === 'La vuelta de las 09:50 no tiene marcas todavía · primera: Margy Evans en Riovivo', b.status + ' | ' + b.ahora);

  const o = cars.find((c) => c.driver === DRV.o);
  t('Juan Ospina: sin placa, «Sin iniciar turno · primera vuelta 14:00»', o.plate === '' && o.key === 'd:dp-o' && o.turno === 'sin' && o.status === 'Sin iniciar turno' && o.ahora === 'Sin iniciar turno · primera vuelta 14:00', JSON.stringify([o.plate, o.key, o.turno, o.status, o.ahora]));
  const c = de('CCC333');
  t('CCC333: «Terminó · 1 vuelta hecha · turno cerrado»', c.done && c.status === 'Terminó' && c.ahora === 'Terminó · 1 vuelta hecha · turno cerrado', c.ahora);

  const evs = a.feed.map((e) => e.h);
  t('actividad de AAA111 con nombre completo y lugar: «recogió a Sebastian Velez Gaviria en Edificio Portobello»', evs.includes('recogió a Sebastian Velez Gaviria en Edificio Portobello'), evs.slice(-4).join(' | '));
  t('…«dejó a … en el aeropuerto · 20 min después de la hora pedida» en rojo, y el no-show y el reporte también', a.feed.some((e) => e.k === 'bad' && e.h === 'dejó a Andrea Núñez Pérez en el aeropuerto · 20 min después de la hora pedida') && a.feed.some((e) => e.k === 'bad' && /Laura N\. no se presentó \(Ruta 39\)/.test(e.h)) && a.feed.some((e) => e.k === 'bad' && e.h === 'reporte: trancón'));
  t('ningún «V..» ni nombre abreviado en la actividad', !op.feed.some((e) => /\.\./.test(e.h)) && !cars.some((k) => k.feed.some((e) => /\.\./.test(e.h))));
  t('la actividad de cada carro va de lo más nuevo a lo más viejo', a.feed.every((e, i) => i === 0 || a.feed[i - 1].at >= e.at));
  t('la lista general marca la placa y escapa lo que viene de la base', op.feed.some((e) => e.h.startsWith('<b>AAA111</b> ') && /Karol &lt;b&gt;Martínez&lt;\/b&gt;/.test(e.h)) && !op.feed.some((e) => /<b>Martínez/.test(e.h)), op.feed.find((e) => /Karol/.test(e.h))?.h);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · getPublishedPlan: el mismo resultado por vuelta (para Asignación) ──');
{
  const { A, log } = apiReal();
  const pp = await A.getPublishedPlan(DAY, { estados: ['draft', 'planned', 'in_progress', 'completed'] });
  const f = (id) => pp.vueltas.find((v) => v.id === id).fin;
  t('ra1 ok (03:50) · ra2/ra3/ra4 bad · ra5 en curso · ra7 sin marcar · ra10 pendiente', f('ra1').estado === 'ok' && f('ra1').at === '03:50' && ['ra2', 'ra3', 'ra4'].every((id) => f(id).estado === 'bad') && f('ra5').estado === 'curso' && f('ra7').estado === 'sinmarcar' && f('ra10').estado === 'falta',
    JSON.stringify(pp.vueltas.map((v) => [v.id, v.fin.estado])));
  t('con su motivo: «1 no se presentó» / «trancón»', f('ra3').motivos.join() === '1 no se presentó' && f('ra4').motivos.join() === 'trancón');
  const sel = log.filter((x) => x.name === 'route_assignments').at(-1).ops.find((o) => o[0] === 'select')[1];
  t('pide la hora real de entrega de cada parada (actual_dropoff_at)', /actual_dropoff_at/.test(sel));
  t('los reportes se leen una vez, solo de operación y solo de personas', log.filter((x) => x.name === 'incidents').length === 1 && (() => { const ops = log.find((x) => x.name === 'incidents').ops; return ops.some((o) => o[0] === 'eq' && o[1] === 'scope' && o[2] === 'operacion') && JSON.stringify(ops.find((o) => o[0] === 'in' && o[1] === 'source')[2]) === '["driver","auxiliar","admin"]'; })());
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C · Operación en vivo: tarjetas, detalle al tocar, actividad por carro ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], opened = [];
  w.console.error = (...x) => errors.push(x.map((y) => (y && y.message) || String(y)).join(' '));
  w.addEventListener('error', (e) => errors.push(e.message));
  w.state = { activeTab: 'oper', settings: {}, profile: { id: 'jefe', role: 'admin' } };
  w.toast = (m) => toasts.push(m);
  w.open = (u) => opened.push(u);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  let datos = JSON.parse(JSON.stringify(LIVE));
  w.Api = { listLiveOperation: async () => JSON.parse(JSON.stringify(datos)), listOpenRouteRisks: async () => [{ minutesLate: 7, km: 3, at: at('09:55'), aux: 'Margy <i>E</i>' }] };
  w.eval(read('admin-operacion.js') + '\n;window.__O = { opState, loadRealOps, stopOperTimers, renderOperacion };');
  w.document.querySelector('section[data-panel="oper"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s), qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const O = w.__O;
  O.renderOperacion();
  await wait(80);
  const cards = () => qa('#oper-carlist .op-cc');
  t('4 tarjetas en pantalla, una por carro', cards().length === 4, cards().length);
  const card = (k) => q(`#oper-carlist [data-key="${k}"]`);
  const kA = 'v:veh-AAA', kB = 'v:veh-BBB';
  t('AAA111: la frase de qué hace y la tira de vueltas «4 de 6 hechas · 3 con novedad»', /Recogiendo · va por Michell Rodriguez Calderon a Riovivo · 1 a bordo/.test(txt(card(kA))) && /4 de 6 hechas · 3 con novedad/.test(txt(card(kA))), txt(card(kA)));
  t('la tira pinta cada vuelta con su resultado (verde, rojo, en curso, pendiente)', qa(`#oper-carlist [data-key="${kA}"] .op-vd`).map((x) => x.className.replace('op-vd ', '')).join(',') === 'ok,bad,bad,bad,curso,falta');
  t('Juan Ospina: «Sin placa», píldora «Sin turno» (una línea, sin repetir al lado de la placa)', /^Sin placa$/.test(txt(card('d:dp-o').querySelector('.op-cc-id'))) && txt(card('d:dp-o').querySelector('.op-cc-state')) === 'Sin turno', txt(card('d:dp-o').querySelector('.op-cc-top')));
  t('BBB222: la píldora dice «Sin marcar» en ámbar', txt(card(kB).querySelector('.op-cc-state')) === 'Sin marcar' && card(kB).querySelector('.op-cc-state').classList.contains('warn'));
  t('CCC333 al final, degradada («Terminó»)', cards().at(-1).dataset.key === 'v:veh-CCC' && cards().at(-1).classList.contains('done'));
  t('KPIs: 1 terminó; los que esperan no cuentan como «A tiempo»', txt(q('#oper-kDone b')) === '1' && txt(q('#oper-kOn b')) === '1', [txt(q('#oper-kOn b')), txt(q('#oper-kLate b')), txt(q('#oper-kDone b'))].join('/'));
  t('sin detalle hasta que se toca', !q('.op-cc-det'));
  click(card(kB).querySelector('.op-cc-top'));
  await wait(10);
  const det = () => card(kB) && card(kB).querySelector('.op-cc-det');
  t('al tocar BBB222 se abre su detalle con sus 3 vueltas', !!det() && qa(`#oper-carlist [data-key="${kB}"] .op-vt`).length === 3, det() && txt(det()).slice(0, 200));
  t('la vuelta sin marcas dice «Sin marcar · faltan 1» y la gente con su lugar', /Sin marcar · faltan 1/.test(leer(det())) && /Manuela Velasquez en Boral Apartamentos · pendiente · al aeropuerto 05:00/.test(leer(det())), leer(det()));
  t('la vuelta de las 22:00 (aún sin placa) también está en el detalle de BBB222', /22:00 Llegada/.test(leer(det())));
  await O.loadRealOps(); await wait(10);
  t('tras el refresco (cada 5 s) sigue abierta', !!det());
  click(det());
  t('tocar dentro del detalle no lo cierra', !!det());
  click(card(kB).querySelector('.op-cc-top')); await wait(5);
  t('tocar la tarjeta otra vez lo cierra', !det());
  click(card(kA).querySelector('.op-cc-top')); await wait(5);
  const dA = card(kA).querySelector('.op-cc-det');
  t('AAA111 abierta: la hecha en una línea, la en curso persona por persona', !!dA && /Sebastian Velez Gaviria \(Edificio Portobello\)/.test(leer(dA)) && /Karol <b>Martínez<\/b> en Edificio Cámbulo · a bordo · recogida 09:50/.test(leer(dA)), dA && leer(dA).slice(0, 600));
  t('las rojas dicen por qué', /1 no se presentó/.test(txt(dA)) && /llegó 20 min después de la hora pedida/.test(txt(dA)) && /trancón/.test(txt(dA)));
  t('el nombre que viene de la base se escapa (no se vuelve HTML)', !dA.querySelector('.op-vp b b'));
  click(dA.querySelector('[data-op-call]'));
  t('«Llamar a Miguel» marca su teléfono', opened.includes('tel:3001112233'), opened.join());
  const secs = qa('#oper-feed .op-fs-h b').map(txt);
  t('actividad separada por carro, en el orden de las tarjetas, con los avisos del vigilante arriba', secs.join(',') === 'Avisos del vigilante,AAA111,BBB222,Sin placa,CCC333', secs.join(','));
  t('…el aviso del vigilante va escapado', /Margy &lt;i&gt;E&lt;\/i&gt;|Margy <i>E<\/i>/.test(q('#oper-feed .op-fs.warn').innerHTML) && !q('#oper-feed .op-fs.warn i'));
  t('en la actividad no hay «V..» y se lee el nombre completo', !/\.\./.test(txt(q('#oper-feed'))) && /dejó a Maria Camila Cano en el aeropuerto/.test(txt(q('#oper-feed'))));
  t('el que no ha iniciado turno dice «Todavía no inicia turno.»', /Todavía no inicia turno\./.test(txt(q('#oper-feed'))));
  click(q('#oper-feed [data-op-fs="v:veh-CCC"]')); await wait(5);
  t('tocar el carro en la actividad abre su tarjeta', !!card('v:veh-CCC').querySelector('.op-cc-det'));
  // Cuando Juan Ospina inicia turno con BBB222, sus vueltas pasan a esa placa.
  datos = JSON.parse(JSON.stringify(LIVE));
  const jo = datos.cars.find((c) => c.key === 'd:dp-o'); const bb = datos.cars.find((c) => c.key === kB);
  bb.vueltas = bb.vueltas.concat(jo.vueltas); datos.cars = datos.cars.filter((c) => c !== jo);
  await O.loadRealOps(); await wait(10);
  t('al tomar la placa en el relevo, la tarjeta de Juan Ospina se junta con la de su carro', cards().length === 3 && !card('d:dp-o'));
  t('sin errores de consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  w.state.activeTab = 'otra'; O.stopOperTimers();
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D · Asignación: la vuelta terminada degradada, verde o roja ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = () => {}; w.confirm = () => true;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  w.RV2Fixture.instalar(w.Api, { publicado: true });
  const vs = w.RV2Fixture.vueltas();
  const hecha = (v) => { v.atendidas = v.pendientes.concat(v.atendidas).map((s) => ({ ...s, status: 'delivered' })); v.pendientes = []; };
  // ra-2 (V-01 04:45) terminada sin novedad; ra-4 (V-02 04:35) terminada con un no-show;
  // ra-5 (V-02 06:45) pasó su hora sin marcas; ra-1 queda con el 'completed' de la base.
  hecha(vs[1]); vs[1].fin = { estado: 'ok', motivos: [], faltan: 0, at: '06:30' };
  hecha(vs[3]); vs[3].atendidas[0].status = 'no_show'; vs[3].fin = { estado: 'bad', motivos: ['1 no se presentó'], faltan: 0, at: '05:40' };
  vs[4].fin = { estado: 'sinmarcar', motivos: [], faltan: 2, at: '' };
  w.Api.getPublishedPlan = async () => ({ vueltas: vs, publicado: true });
  w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n;window.__T = { rt, renderRoutes };');
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await w.__T.renderRoutes(); await wait(60);
  // Lista de los jefes (26-oct): las terminadas se recogen al final; se abren para mirarlas.
  const hb = q('#rv2-list .rv2-hechas-b');
  t('las terminadas están recogidas al final («✓ 3 vueltas terminadas · Ver»)', hb && /✓ 3 vueltas terminadas/.test(txt(hb)) && /con novedad/.test(txt(hb)), hb && txt(hb));
  if (hb) { click(hb); await wait(20); }
  const rt = w.__T.rt;
  const laneDe = (k) => Object.keys(rt.order).find((l) => rt.order[l].includes('r' + k));
  const fila = (k) => q(`#rv2-list .rv2-row[data-id="${laneDe(k)}"]`);
  t('la terminada sin novedad: degradada en verde, «Terminada 06:30 · sin novedad»', fila('D') && fila('D').dataset.fin === 'ok' && /Terminada 06:30 · sin novedad/.test(txt(fila('D'))), fila('D') && [fila('D').dataset.fin, txt(fila('D').querySelector('.when'))].join(' | '));
  t('…y ya no dice «en curso» ni deja mover a nadie', !/en curso/.test(txt(fila('D'))) && [...fila('D').querySelectorAll('.rv2-p')].every((b) => b.disabled));
  t('la terminada con no-show: en rojo y con su motivo', fila('E') && fila('E').dataset.fin === 'bad' && /Terminada · 1 no se presentó/.test(txt(fila('E'))), fila('E') && [fila('E').dataset.fin, txt(fila('E').querySelector('.when'))].join(' | '));
  t('la que pasó su hora sin marcas: gris, «Pasó su hora · 2 paradas sin marcar»', fila('H') && fila('H').dataset.fin === 'sinmarcar' && /Pasó su hora · 2 paradas sin marcar/.test(txt(fila('H'))), fila('H') && [fila('H').dataset.fin, txt(fila('H').querySelector('.when'))].join(' | '));
  t('la que la base sí cerró sigue «Terminada»', fila('A') && fila('A').dataset.fin === 'ok' && /Terminada/.test(txt(fila('A'))));
  t('una vuelta normal no se degrada', fila('M') && !fila('M').dataset.fin);
  click(fila('E').querySelector('.when')); await wait(10);
  t('el detalle de la roja: «Terminada con novedad · 1 no se presentó» en el aviso rojo', /Terminada con novedad · 1 no se presentó/.test(txt(q('#rv2-detail .rv2-alert'))) && q('#rv2-detail .rv2-alert').classList.contains('rv2-alert--risk'), txt(q('#rv2-detail .rv2-alert')));
  click(fila('H').querySelector('.when')); await wait(10);
  t('el detalle de la gris: «no se sabe si se hizo»', /no se sabe si se hizo/.test(txt(q('#rv2-detail .rv2-alert'))) && q('#rv2-detail .rv2-alert').classList.contains('rv2-alert--sinmarcar'), txt(q('#rv2-detail .rv2-alert')));
  t('sin errores de consola', errors.length === 0, errors.slice(0, 3).join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout real (ver las capturas con Chromium y revisar en el equipo del jefe), RLS de incidents/shifts en la base real, Leaflet y OSRM reales.');
process.exit(bad ? 1 : 0);
