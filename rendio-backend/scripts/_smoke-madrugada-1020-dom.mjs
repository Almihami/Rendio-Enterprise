// La madrugada es del turno PM de la noche anterior (20-oct-2026) — prueba jsdom.
//
// Pedido de la profa: «a la 1 de la mañana es llegada del turno anterior y
// pareciera que es de la ruta siguiente». El turno PM pasa la medianoche y todo
// se agrupaba por fecha de calendario. Comprueba, con los archivos de verdad:
//   A) Asignación: una llegada de las 23:45 ya NO se guarda 24 h antes (antes la
//      vuelta quedaba «00:05» del mismo día, en la madrugada del PM de ayer y «a
//      tiempo»); la de las 00:40 va aparte como «cierre del turno PM del lunes»;
//      al final del día se anuncia la madrugada siguiente; «Turno PM del lunes»
//      en vez de «PM de ayer»; el WhatsApp rotula la madrugada.
//   B) api.js de verdad (sb falso): el conductor del PM ve la vuelta de la 1 a. m.
//      como la ÚLTIMA de su noche (no como «la ruta de mañana»); Operación en vivo
//      la muestra antes de medianoche; el conteo de la madrugada siguiente;
//      rtHHMM en hora de Bogotá.
//   C) Tripulante: el aviso de la fecha pasada la medianoche y la fecha del
//      regreso del mismo día; el rótulo «Madrugada» del conductor; Reservas.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: cómo se ve el bloque de madrugada,
// que el rótulo quepa en la tarjeta del conductor), la base real (RLS de
// app_settings para el conductor, que PostgREST acepte las consultas), el solver
// con tiempos reales (la matriz es inventada) ni un teléfono de verdad.
//
//   cd rendio-backend && node scripts/_smoke-madrugada-1020-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const leer = (el) => { if (!el) return null; const p = []; const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 3) p.push(c.textContent); else { walk(c); p.push(' '); } }); }; walk(el); return p.join('').replace(/\s+/g, ' ').trim(); };

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · Asignación: la madrugada aparte, la llegada de las 23:45 en su día ──');
{
  const DAY = '2026-10-20';   // martes
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
  const log = w.RV2Fixture.instalar(w.Api, { publicado: false });
  // El día de prueba: martes con una llegada de las 00:40 (madrugada = PM del
  // lunes), salidas de la mañana, una llegada de la tarde y una de las 23:45.
  const CREW = [
    ['X', 'Ximena Mad', 20, 'lle', '00:40', { vuelo: 'AV9001' }],
    ['A', 'Ana Mañana', 30, 'sal', '05:00'],
    ['B', 'Beto Mañana', 25, 'sal', '05:10'],
    ['F', 'Fabio Tarde', 15, 'lle', '15:00', { vuelo: 'AV9412' }],
    ['Y', 'Yolanda Noche', 18, 'lle', '23:45', { vuelo: 'AV9999' }],
  ];
  const aux = {}, colors = {};
  CREW.forEach(([k, n, x, type, dl, extra], i) => {
    aux['r' + k] = Object.assign({ n, zona: 'Conjunto ' + k, sector: 'Rionegro', resId: null, zonaJefe: null, dir: 'Conjunto ' + k + ', Rionegro',
      lat: 6 + x / 1000, lng: -75.4 - i * 0.0001, dl, pax: 1, type, reservationId: 'res-' + k, tel: '', vuelo: '', tierra: false, notas: '', hotel: false }, extra || {});
    colors['r' + k] = '#3B82F6';
  });
  const CARS = [
    { id: 'V-01', avail0: '00:00', driver: null, capacity: 4, vehicleId: 'veh-1' },
    { id: 'V-02', avail0: '00:00', driver: null, capacity: 4, vehicleId: 'veh-2' },
  ];
  w.Api.listRoutePlanning = async (tipo, day) => {
    log.planning.push(day === undefined ? null : day);
    if ((day || DAY) !== DAY) return null;
    return { aux: JSON.parse(JSON.stringify(aux)), colors, cars: JSON.parse(JSON.stringify(CARS)), drivers: w.RV2Fixture.DRIVERS(), plan: {}, source: 'live', day: DAY };
  };
  // Horario: el martes AM d1/d2, PM d4/d5; el lunes PM d3 (hace la madrugada del martes).
  w.Api.listDriversOnShift = async (day) => (day === '2026-10-19'
    ? { am: [], pm: [{ id: 'd3', n: 'Carlos Mejía' }], coordAm: [], coordPm: [] }
    : w.RV2Fixture.SHIFT());
  const madPedidas = [];
  w.Api.getMadrugadaSiguiente = async (day, corte) => { madPedidas.push([day, corte]); return { dia: '2026-10-21', vueltas: 2, sinConductor: 1, reservas: 3 }; };
  w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-whatsapp.js') +
    '\n;window.__T = { rt, rtCarCompute, renderRoutes, rtBandOf, rtBandName, rtBandLabel, rtTexto: (o) => window.RendioWhatsApp.texto(o) };');
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const T = w.__T, rt = T.rt;
  await T.renderRoutes();
  await wait(60);
  t('cargó el martes sin plan publicado', rt.day === DAY && !rt.lanes.some((l) => (rt.order[l.id] || []).length), JSON.stringify([rt.day, rt.lanes.length]));
  t('pidió la madrugada del día siguiente con el corte (02:00 = 120)', madPedidas.length >= 1 && madPedidas[0][0] === DAY && madPedidas[0][1] === 120, JSON.stringify(madPedidas));
  // Optimizar
  const reopt = q('#routes-v2 [data-act="reopt"]');
  reopt.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 60 && !rt.lanes.some((l) => (rt.order[l.id] || []).length); i++) await wait(40);
  await wait(60);
  const laneDe = (k) => rt.lanes.find((l) => (rt.order[l.id] || []).includes('r' + k));
  const lY = laneDe('Y'), lX = laneDe('X');
  t('las cinco personas quedaron en un carro', ['X', 'A', 'B', 'F', 'Y'].every((k) => laneDe(k)), JSON.stringify(rt.pool));
  t('llegada de las 23:45: la vuelta queda a las 23:59 del MISMO día (antes «00:05», 24 h antes)', lY && lY.start === '23:59', lY && lY.start);
  t('… y es del turno PM de ese día, no de la madrugada', lY && T.rtBandOf(lY) === 'pm', lY && T.rtBandOf(lY));
  const cY = lY && T.rtCarCompute(lY.id);
  t('… y entrega a la casa pasada la medianoche (ETA ≥ 24:00, sale cuando la gente sale)', cY && cY.stops[0].eta >= 1440 && cY.wait === 0, cY && JSON.stringify([cY.stops, cY.wait]));
  t('la llegada de las 00:40 es franja de madrugada', lX && T.rtBandOf(lX) === 'mad', lX && [lX.start, T.rtBandOf(lX)].join(' '));
  t('la franja se llama «PM del lunes» (antes «PM de ayer»)', T.rtBandName('mad') === 'PM del lunes' && /turno PM del lunes/.test(T.rtBandLabel('mad')), T.rtBandName('mad'));
  t('la franja PM de este día termina a las 24:00 (su madrugada es del día siguiente)', T.rtBandLabel('pm') === '14:00–24:00', T.rtBandLabel('pm'));
  // La lista
  const lista = q('#rv2-list');
  const mad = lista.querySelector('.rv2-mad');
  t('la madrugada va aparte, ARRIBA, con su título', mad && lista.firstElementChild === mad && /Madrugada · cierre del turno PM del lunes/.test(leer(mad)), leer(mad));
  t('… y adentro solo está la vuelta de las 00:40', mad && [...mad.querySelectorAll('.rv2-row')].map((r) => r.dataset.id).join() === lX.id, mad && [...mad.querySelectorAll('.rv2-row')].map((r) => r.dataset.id).join());
  const dayh = lista.querySelector('.rv2-dayh');
  t('después, el rótulo del día: «Mar 20 oct · desde las 02:00»', dayh && leer(dayh) === 'Mar 20 oct · desde las 02:00', dayh && leer(dayh));
  const filasDia = [...lista.querySelectorAll('.rv2-row')].filter((r) => !mad.contains(r)).map((r) => r.dataset.id);
  t('la vuelta de las 23:45 cierra el día (última fila, fuera de la madrugada)', filasDia[filasDia.length - 1] === lY.id, JSON.stringify(filasDia));
  const sig = lista.querySelector('.rv2-madsig');
  t('al final: «Sigue después de medianoche · madrugada del mié 21 oct» con lo que hay', sig && lista.lastElementChild === sig && /Sigue después de medianoche · madrugada del mié 21 oct/.test(leer(sig)) && /2 vueltas \(1 sin conductor\)/.test(leer(sig)), sig && leer(sig));
  t('… con un botón que lleva al día siguiente', sig && sig.querySelector('[data-act="nav"][data-dir="1"]'));
  const yRow = lista.querySelector(`.rv2-row[data-id="${lY.id}"]`);
  t('la fila de la 23:45 dice cuándo recoge de verdad («Recoge en JMC 00:05»)', yRow && /Recoge en JMC 00:0\d/.test(leer(yRow)), yRow && leer(yRow));
  const cond = leer(q('#rv2-drivers')) || leer(q('#routes-v2'));
  t('Conductores: la columna dice «Turno PM del lunes»', /Turno PM del lunes/.test(cond), cond && cond.slice(0, 200));
  // WhatsApp
  const wa = T.rtTexto();
  const lineas = wa.split('\n');
  const iMad = lineas.findIndex((l) => l === '— Madrugada: cierre del turno PM del lunes —');
  const iDia = lineas.findIndex((l) => l === '— Martes desde las 2:00 —');
  t('WhatsApp: la madrugada rotulada primero y luego «Martes desde las 2:00»', iMad > 0 && iDia > iMad, wa.split('\n').slice(0, 8).join(' | '));
  t('… y la llegada de las 0:40 queda entre los dos rótulos', (() => { const i = lineas.findIndex((l) => /^0:40 /.test(l)); return i > iMad && i < iDia; })(), wa);
  t('sin errores de consola', errors.length === 0, errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · api.js de verdad (sb falso): conductor, Operación, madrugada siguiente ──');
{
  const bog = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const sumar = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  // Día de turno de AHORA (la madrugada cuenta como la noche anterior).
  const OP = bog(Date.now() - 120 * 60000), SIG = sumar(OP, 1);
  const at = (d, hm) => new Date(`${d}T${hm}:00-05:00`).toISOString();
  const stop = (id, hm, d) => ({ stop_order: 1, reservation_id: 'res-' + id, status: 'pending', actual_arrival_at: null, estimated_arrival_at: null,
    reservations: { pickup_address: 'Casa ' + id, pickup_latitude: 6.15, pickup_longitude: -75.37, required_arrival_at: at(d, hm), calculated_pickup_at: null, notes: '', residence_unit: '', auxiliar_profiles: { profiles: { id: 'p' + id, full_name: 'T ' + id, phone: '' } }, flights: null } });
  const RA = (id, d, hm, veh) => ({ id, direction: 'airport_to_home', planned_start_at: at(d, hm), status: 'planned', driver_profile_id: 'dp1', vehicle_id: veh,
    vehicles: { license_plate: 'AAA' + veh.slice(-1), internal_code: 'V-0' + veh.slice(-1), capacity: 4 }, driver_profiles: { profiles: { full_name: 'Diego', phone: '' } },
    route_stops: [stop(id, hm, d)] });
  const tablas = {
    driver_profiles: [{ id: 'dp1', profile_id: 'u1' }],
    app_settings: [{ id: 'singleton', route_night_cutoff_min: 120 }],
    route_assignments: [RA('ra-pm', OP, '20:00', 'veh-1'), RA('ra-mad', SIG, '00:40', 'veh-2'), RA('ra-am', SIG, '05:00', 'veh-3'), Object.assign(RA('ra-mad2', SIG, '01:30', 'veh-1'), { driver_profile_id: null })],
    reservations: [{ id: 'm1', cancelled_at: null, required_arrival_at: at(SIG, '00:40') }, { id: 'm2', cancelled_at: null, required_arrival_at: at(SIG, '01:50') }, { id: 'm3', cancelled_at: null, required_arrival_at: at(SIG, '02:10') }],
    driver_locations: [],
  };
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.sb = {
    from(name) {
      const ops = []; let one = null;
      const bld = {
        select() { return bld; }, eq(c, v) { ops.push(['eq', c, v]); return bld; }, gte(c, v) { ops.push(['gte', c, v]); return bld; },
        lte(c, v) { ops.push(['lte', c, v]); return bld; }, lt(c, v) { ops.push(['lt', c, v]); return bld; }, in(c, v) { ops.push(['in', c, v]); return bld; },
        is(c, v) { ops.push(['is', c, v]); return bld; }, order(c) { ops.push(['order', c]); return bld; }, limit() { return bld; },
        maybeSingle() { one = 'maybe'; return bld; }, single() { one = 'single'; return bld; },
        then(ok2, ko) {
          let rows = (tablas[name] || []).slice();
          for (const [op, c, v] of ops) {
            if (op === 'eq') rows = rows.filter((r) => r[c] === v);
            else if (op === 'gte') rows = rows.filter((r) => val(r[c]) >= val(v));
            else if (op === 'lte') rows = rows.filter((r) => val(r[c]) <= val(v));
            else if (op === 'lt') rows = rows.filter((r) => val(r[c]) < val(v));
            else if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
            else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
            else if (op === 'order') rows.sort((a, z) => (val(a[c]) > val(z[c]) ? 1 : -1));
          }
          return Promise.resolve({ data: JSON.parse(JSON.stringify(one ? (rows[0] || null) : rows)), error: null }).then(ok2, ko);
        },
      };
      return bld;
    },
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
  };
  w.RENDIO_CONFIG = {};
  w.eval(read('api.js'));
  const A = w.Api;
  const vs = await A.listMyVueltasForDriver('u1');
  t('conductor: su noche trae la vuelta de las 20:00 Y la de las 00:40 (no la de las 05:00)', vs && vs.map((v) => v.assignmentId).join() === 'ra-pm,ra-mad', vs && vs.map((v) => v.assignmentId).join());
  t('… las dos del mismo día de turno, y la de las 00:40 con su fecha de calendario', vs && vs.every((v) => v.opDay === OP) && vs[1].day === SIG && vs[0].day === OP, vs && JSON.stringify(vs.map((v) => [v.day, v.opDay])));
  const op = await A.listLiveOperation();
  t('Operación en vivo: el día de turno de ahora, con la madrugada adentro (veh-1 y veh-2)', op && op.day === OP && op.cars.length === 2, op && JSON.stringify([op.day, op.cars.length]));
  const m = await A.getMadrugadaSiguiente(OP, 120);
  t('madrugada siguiente: 2 vueltas (1 sin conductor) y 2 tripulantes antes de las 02:00', m && m.dia === SIG && m.vueltas === 2 && m.sinConductor === 1 && m.reservas === 2, JSON.stringify(m));
  t('… y un día mal escrito devuelve null', (await A.getMadrugadaSiguiente('20-10-2026', 120)) === null);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C · tripulante, conductor y Reservas ──');
{
  // auxMadrugadaHint / auxSumarDia, sacadas tal cual de auxiliar.js.
  const src = read('auxiliar.js');
  const fn = (name) => { const i = src.indexOf('  function ' + name + '('); const j = src.indexOf('\n  }\n', i); return src.slice(i, j + 4); };
  const ctx = new Function('auxHM', fn('auxMadrugadaHint') + '\n' + fn('auxSumarDia') + '\nreturn { auxMadrugadaHint, auxSumarDia };')((x) => x || '--:--');
  const h = ctx.auxMadrugadaHint({ date: '2026-10-21', time: '00:40', type: 'lle' });
  t('aviso al pedir: «las 00:40 del miércoles 21 es la madrugada, justo después de la noche del martes 20… elige el jueves 22»',
    h === 'Ojo con la fecha: las 00:40 del miércoles 21 es la madrugada, justo después de la noche del martes 20. Si aterrizas la noche del miércoles 21, elige el jueves 22.', h);
  t('… no sale a las 02:00 ni a las 23:30', ctx.auxMadrugadaHint({ date: '2026-10-21', time: '02:00', type: 'lle' }) === null && ctx.auxMadrugadaHint({ date: '2026-10-21', time: '23:30', type: 'sal' }) === null);
  t('regreso del mismo día: el día siguiente cuando la hora es menor que la ida', ctx.auxSumarDia('2026-10-31') === '2026-11-01' && /date: f\.backTime <= f\.time \? auxSumarDia\(f\.date\) : f\.date/.test(src));
  t('cambio de vuelo usa el mismo aviso', /auxMadrugadaHint\(\{ date: fv\.date, time: fv\.time/.test(read('aux-rx-vuelo.js')));
  // Conductor: el rótulo de la madrugada (driver-rutas.js)
  const dr = read('driver-rutas.js');
  const fmt = dr.slice(dr.indexOf('  const DOW = '), dr.indexOf('  function hmToMin('));
  const mk = new Function(fmt + '\nreturn { madrugadaDe, fmtDay };')();
  t('conductor: «Madrugada del MIÉ 21 OCT» en la vuelta de después de medianoche', mk.madrugadaDe({ day: '2026-10-21', opDay: '2026-10-20' }) === 'Madrugada del MIÉ 21 OCT' && mk.madrugadaDe({ day: '2026-10-20', opDay: '2026-10-20' }) === '', mk.madrugadaDe({ day: '2026-10-21', opDay: '2026-10-20' }));
  t('… y «Mi día» se titula con el día de turno', /fmtDay\(list\[0\]\.opDay \|\| list\[0\]\.day\)/.test(dr));
  // Reservas: el rótulo de la madrugada
  const rv = read('admin-reservas.js');
  const rvFn = rv.slice(rv.indexOf('  const rvDayShort = '), rv.indexOf('  // En el filtro, los días cercanos'));
  const r2 = new Function(rvFn + '\nreturn { rvMadrugada };')();
  t('Reservas: una de la 01:00 del miércoles dice «PM del mar 20»', r2.rvMadrugada('2026-10-21T01:00:00-05:00') === 'mar 20' && r2.rvMadrugada('2026-10-21T02:30:00-05:00') === '', r2.rvMadrugada('2026-10-21T01:00:00-05:00'));
  // Acomodar: el día del plan en hora de Bogotá
  t('Acomodar: busca el plan del día de Bogotá (no el UTC)', /new Date\(res\.dueAt\)\.toLocaleDateString\('en-CA', \{ timeZone: 'America\/Bogota' \}\)/.test(read('admin-acomodar.js')));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
process.exit(bad ? 1 : 0);
