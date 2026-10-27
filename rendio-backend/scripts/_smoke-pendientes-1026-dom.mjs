// Pendientes de los jefes del 26-oct-2026 (0137–0140) — prueba jsdom con los
// archivos de verdad.
//
//   A) api.js · _opResultado: terminada baja 10 min después de su última entrega;
//      sin marcar a los 30 min de su fin esperado (antes «en curso» 1 h, y en una
//      llegada 2 h y media); la delegada pasada; el sin cuenta cuenta; los minutos
//      salen de Calibración (getRouteFinishRules).
//   B) Asignación: lo terminado (y lo que pasó sin marcar y la delegada pasada) baja
//      al renglón de abajo, con su cuenta; la que terminó hace 2 min sigue a la vista;
//      la que pasó su hora no dice «en curso»; el refresco de cada minuto la baja sola.
//   C) Ruta de Julián: el estado sale del resultado (ya no «En curso» para siempre) y
//      lo terminado se recoge al final.
//   D) Conductor: la vuelta vencida sin iniciar no queda de «siguiente» (Inicio y Mi
//      día), baja a «Pasaron sin marcar»; en «Vueltas para tomar» la que se cruza no
//      deja tomarla y Kriss (sin cuenta) se nombra.
//   E) Conductor: la tarjeta de entrega de turno («Entregado» / «Deshacer», recibe).
//   F) Jefe: «Entregas de turno» en Asignación (cambiar a quién, guardar).
//   G) Reservas › «Nuevo pedido»: a un externo ya cargado y a uno nuevo; la etiqueta
//      «Externo · sin app» en la fila.
//
// LO QUE NO CUBRE: el layout (jsdom no lo hace: mirarlo en Chromium y en el
// teléfono), la base real (las funciones están en _verify-0137…0140), la push.
//
//   cd rendio-backend && node scripts/_smoke-pendientes-1026-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const tx = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
const MIN = 60000, NOW = Date.now();
const iso = (m) => new Date(NOW + m * MIN).toISOString();

function ventana(html) {
  const dom = new JSDOM(html || read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  w.console.error = (...x) => errores.push(x.map((y) => (y && y.message) || String(y)).join(' '));
  w.RENDIO_CONFIG = {}; w.toast = () => {}; w.confirm = () => true;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = async () => { throw new Error('sin red'); };
  return { w, errores };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · api.js: cuándo una vuelta termina o pasa sin marcar ──');
{
  const { w, errores } = ventana('<!doctype html><body></body>');
  const settings = { id: 'singleton', route_night_cutoff_min: 120 };
  w.sb = { from: () => { const b = { select: () => b, eq: () => b, maybeSingle: () => b, then: (ok2) => Promise.resolve({ data: settings, error: null }).then(ok2) }; return b; }, auth: { getUser: async () => ({ data: { user: null } }) } };
  w.eval(read('api.js'));
  const A = w.Api;
  const R = { hide: 10, unmarked: 30 };
  const st = (status, o = {}) => ({ status, reservation_id: o.guest ? null : 'r' + Math.random(), estimated_arrival_at: o.eta != null ? iso(o.eta) : null,
    actual_dropoff_at: o.drop != null ? iso(o.drop) : null, actual_arrival_at: null,
    reservations: o.guest ? null : { required_arrival_at: o.req != null ? iso(o.req) : null, cancelled_at: null } });
  const ra = (dir, start, stops, extra = {}) => Object.assign({ id: 'x', direction: dir === 'lle' ? 'airport_to_home' : 'home_to_airport', planned_start_at: iso(start), route_stops: stops }, extra);
  const res = (r, now) => A._opResultado(r, null, NOW + now * MIN, R);

  const okRa = ra('sal', -60, [st('delivered', { req: -10, drop: -15 })]);
  t('terminada hace 5 min: «ok», todavía a la vista', res(okRa, 0).estado === 'ok' && res(okRa, -10).oculta === false);
  t('… baja 10 min después de su última entrega', res(okRa, -6).oculta === false && res(okRa, -4).oculta === true && Math.abs(res(okRa, 0).ocultaDesde - (NOW - 5 * MIN)) < 2000);
  const cur = ra('sal', -60, [st('picked_up', { req: 0 }), st('pending', { req: 0 })]);
  t('salida con alguien a bordo, 20 min después de la presentación: «en curso» (puede ir tarde)', res(cur, 20).estado === 'curso' && !res(cur, 20).oculta, res(cur, 20).estado);
  t('… a los 31 min: «sin marcar» y baja de la lista', res(cur, 31).estado === 'sinmarcar' && res(cur, 31).oculta === true);
  const lle = ra('lle', -120, [st('picked_up', { eta: -80 })]);
  t('llegada: el fin esperado es su entrega estimada (antes salida de JMC + 90 → «en curso» 2 h y media)', res(lle, 0).finEsperado === NOW - 80 * MIN && res(lle, 0).estado === 'sinmarcar', res(lle, 0).estado);
  const lleSin = ra('lle', -100, [st('picked_up', {})]);
  t('llegada sin estimado: salida de JMC + 90 min', res(lleSin, 0).finEsperado === NOW - 10 * MIN && res(lleSin, 0).estado === 'curso');
  const del = ra('sal', -60, [st('pending', { req: -5 })], { delegated_at: iso(-300) });
  t('delegada que ya pasó su hora: «delegada» (nadie la marca), baja 10 min después', res(del, 0).estado === 'delegada' && res(del, 0).oculta === false && res(del, 6).oculta === true);
  t('delegada antes de su hora: pendiente', res(del, -10).estado === 'falta');
  const gst = ra('sal', -60, [st('delivered', { guest: true, eta: -50, drop: -20 })]);
  t('la parada de un sin cuenta (Kriss) cuenta: terminada', res(gst, 0).estado === 'ok');
  t('otros minutos (5 y 15): baja antes', A._opResultado(cur, null, NOW + 16 * MIN, { hide: 5, unmarked: 15 }).estado === 'sinmarcar');
  settings.route_done_hide_min = 12; settings.route_unmarked_min = 40;
  const r1 = await A.getRouteFinishRules(true);
  t('getRouteFinishRules lee Calibración (12 y 40)', r1.hide === 12 && r1.unmarked === 40 && r1.enBase === true, JSON.stringify(r1));
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · Asignación: lo terminado baja solo ──');
const asignacion = async () => {
  const { w, errores } = ventana();
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  w.RV2Fixture.instalar(w.Api, { publicado: true });
  return { w, errores };
};
{
  const { w, errores } = await asignacion();
  const vs = w.RV2Fixture.vueltas();
  const hecha = (v) => { v.atendidas = v.pendientes.concat(v.atendidas).map((s) => ({ ...s, status: 'delivered' })); v.pendientes = []; };
  // ra-2 terminó hace 2 min (sigue a la vista 8 min más); ra-4 terminó hace una hora; ra-5
  // pasó su hora sin marcar; ra-6 delegada que ya pasó; ra-7 (en curso) pasó su hora
  // pero todavía no baja (le quedan 10 min).
  hecha(vs[1]); vs[1].fin = { estado: 'ok', motivos: [], faltan: 0, at: '06:30', ocultaDesde: NOW + 8 * MIN };
  hecha(vs[3]); vs[3].fin = { estado: 'ok', motivos: [], faltan: 0, at: '05:40', ocultaDesde: NOW - 50 * MIN };
  vs[4].fin = { estado: 'sinmarcar', motivos: [], faltan: 2, at: '', ocultaDesde: NOW - MIN };
  Object.assign(vs[5], { delegated: true, driverProfileId: null, conductor: 'Sin conductor', delegateName: 'Uber de Julián' });
  vs[5].fin = { estado: 'delegada', motivos: [], faltan: 1, at: '', ocultaDesde: NOW - MIN };
  vs[6].fin = { estado: 'sinmarcar', motivos: [], faltan: 1, at: '', ocultaDesde: NOW + 10 * MIN };
  let plan = vs;
  w.Api.getPublishedPlan = async () => ({ vueltas: JSON.parse(JSON.stringify(plan)), publicado: true });
  w.Api.listHandovers = async () => null;   // sin 0140: la tarjeta no sale
  w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-ruta-julian.js') + '\n' + read('admin-entregas.js') + '\n;window.__T = { rt, renderRoutes };');
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s), qa = (s) => [...w.document.querySelectorAll(s)];
  await w.__T.renderRoutes(); await wait(60);
  const ids = () => qa('#rv2-list .rv2-row').map((r) => r.dataset.id);
  const hb = q('#rv2-list .rv2-hechas-b');
  t('abajo: «✓ 2 vueltas terminadas · 1 pasó sin marcar · 1 delegada»', hb && /✓ 2 vueltas terminadas · 1 pasó sin marcar · 1 delegada/.test(tx(hb)), tx(hb));
  t('la que terminó hace 2 min sigue a la vista («Terminada»)', ids().includes('V-01·V2') && /Terminada/.test(tx(qa('#rv2-list .rv2-row').find((r) => r.dataset.id === 'V-01·V2'))));
  t('las que bajaron no están en la lista de arriba', !['V-01·V1', 'V-02·V1', 'V-02·V2', 'V-02·V3'].some((id) => ids().includes(id)), ids().join(','));
  const enc = qa('#rv2-list .rv2-row').find((r) => r.dataset.id === 'V-03·V1');
  t('la que pasó su hora con alguien a bordo no dice «en curso» («Pasó su hora · 1 parada sin marcar»)', enc && !/en curso/.test(tx(enc)) && /Pasó su hora · 1 parada sin marcar/.test(tx(enc)), tx(enc));
  hb.click(); await wait(20);
  const del = qa('#rv2-list .rv2-row').find((r) => r.dataset.id === 'V-02·V3');
  t('al abrir el renglón, la delegada dice «Delegada · Uber de Julián · ya pasó su hora»', del && /Delegada · Uber de Julián · ya pasó su hora/.test(tx(del)), tx(del));
  q('#rv2-list .rv2-hechas-b').click(); await wait(20);
  // El refresco: ra-2 ya pasó sus 10 min.
  plan = JSON.parse(JSON.stringify(vs)); plan[1].fin.ocultaDesde = NOW - MIN;
  const hizo = await w.RendioRutasV2._refrescarFines(); await wait(20);
  t('el refresco de cada minuto la baja sola (sin recargar)', hizo === true && !ids().includes('V-01·V2') && /✓ 3 vueltas terminadas/.test(tx(q('#rv2-list .rv2-hechas-b'))), tx(q('#rv2-list .rv2-hechas-b')));
  w.RendioRutasV2._ui.moving = 'x';
  t('… pero no mientras el jefe mueve a alguien', (await w.RendioRutasV2._refrescarFines()) === false);
  w.RendioRutasV2._ui.moving = null;
  t('sin 0140 no sale la tarjeta de entregas', q('#rv2-entregas').hidden === true);
  t('sin errores de script', errores.length === 0, errores.join(' | '));

  // ── C · Ruta de Julián ───────────────────────────────────────────────────
  console.log('\n── C · Ruta de Julián: el estado sale del resultado ──');
  const J = w.RendioRutaJulian;
  const p = (name, status, eta) => ({ stopId: name, rid: name, order: 1, status, etaAt: eta, name });
  const VJ = [
    { id: 'j1', type: 'sal', status: 'planned', startAt: iso(-200), pool: true, driverProfileId: 'd1', conductor: 'Luis Arango', atendidas: [p('Ana', 'picked_up', iso(-190))], pendientes: [], fin: { estado: 'curso', motivos: [], faltan: 1, ocultaDesde: null } },
    { id: 'j2', type: 'sal', status: 'planned', startAt: iso(-300), pool: true, driverProfileId: 'd2', conductor: 'Jorge Pérez', atendidas: [p('Bea', 'picked_up', iso(-290))], pendientes: [], fin: { estado: 'sinmarcar', motivos: [], faltan: 1, ocultaDesde: NOW + 5 * MIN } },
    { id: 'j3', type: 'sal', status: 'planned', startAt: iso(-400), pool: true, driverProfileId: 'd3', conductor: 'Pedro', atendidas: [p('Cami', 'delivered', iso(-390))], pendientes: [], fin: { estado: 'ok', motivos: [], faltan: 0, at: '6:10', ocultaDesde: NOW - 60 * MIN } },
    { id: 'j4', type: 'lle', status: 'planned', startAt: iso(120), pool: true, driverProfileId: null, conductor: 'Sin conductor', atendidas: [], pendientes: [p('Dani', 'pending', iso(150))], fin: { estado: 'falta', motivos: [], faltan: 1 } },
  ];
  const box = w.document.createElement('div'); box.innerHTML = J.diaHTML(VJ, w.RV2Fixture.DAY, 0);
  const filas = [...box.querySelectorAll('.rj-v')];
  t('lo terminado baja: quedan 3 a la vista, en orden de hora', filas.length === 3 && /Pasó su hora/.test(tx(filas[0])) && /En curso · Luis Arango/.test(tx(filas[1])) && /Disponible/.test(tx(filas[2])), filas.map(tx).join(' | '));
  t('la que pasó su hora con alguien a bordo ya no dice «En curso»', !/En curso/.test(tx(filas[0])) && filas[0].dataset.st === 'pasada');
  const bj = box.querySelector('[data-rj-dia="hechas"]');
  t('abajo: «✓ 1 vuelta terminada · Ver»', bj && /✓ 1 vuelta terminada/.test(tx(bj)) && /Ver/.test(tx(bj)), tx(bj));
  t('el encabezado cuenta las terminadas («4 vueltas · … · 1 terminada»)', /4 vueltas · .* · 1 terminada/.test(tx(box.querySelector('.rj-dia-h'))), tx(box.querySelector('.rj-dia-h')));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D · Conductor: la vencida no tapa la siguiente; «Vueltas para tomar» ──');
const hm = (m) => new Date(NOW + m * MIN).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const dia = (m) => new Date(NOW + m * MIN).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Olivar', unit: '', flight: '', dl: '', phone: '', notes: '', bags: null, quiet: false,
  meetCode: '12', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '', eta: '' }, o);
const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
const vuelta = (id, m, done, vencida) => ({ id, type: 'sal', start: hm(m), startAt: iso(m), done, vencida: !!vencida, assignmentId: 'A' + id, day: dia(m), opDay: dia(0), legs: [
  leg({ name: 'Persona ' + id, reservationId: 'R' + id, stopStatus: done ? 'delivered' : 'pending', dl: hm(m + 60) }), APT] });
let VUELTAS = [vuelta('V1', -300, true), vuelta('V2', -150, false, true), vuelta('V3', 40, false)];
let LIBRES = [
  { id: 'P1', direction: 'home_to_airport', planned_start_at: iso(60), deadline_at: iso(100), stops: [{ name: 'Laura Gómez', place: 'Olivar', at: iso(70), guest: false }], cruza: true },
  { id: 'P2', direction: 'home_to_airport', planned_start_at: iso(200), deadline_at: iso(240), stops: [{ name: 'Kriss Montoya', place: 'Campus Reservado', at: iso(210), guest: true }], cruza: false },
];
function conductor() {
  const { w, errores } = ventana();
  w.L = undefined;
  w.state = { settings: { aux_wait_minutes: 5 }, profile: { id: 'pD', full_name: 'Jorge Prueba', role: 'driver' } };
  const llamadas = [];
  let ENT = [];
  w.Api = { listMyVueltasForDriver: async () => JSON.parse(JSON.stringify(VUELTAS)), driverOpenRoutes: async () => JSON.parse(JSON.stringify(LIBRES)),
    getMyDriverProfileId: async () => 'DP1', countUnreadMessages: async () => ({}), sendDriverLocation: async () => {},
    driverMyHandovers: async () => JSON.parse(JSON.stringify(ENT)),
    driverHandoverDelivered: async (d, b, undo) => { llamadas.push([d, b, !!undo]); ENT = ENT.map((r) => Object.assign(r, { delivered_at: undo ? null : new Date().toISOString() })); return ENT[0]; } };
  for (const f of ['driver-disponibilidad.js', 'driver-entrega.js', 'driver-tabs.js', 'aux-rx-ui.js', 'driver-rutas.js']) {
    try { w.eval(read(f)); } catch (e) { errores.push(f + ': ' + e.message); }
  }
  w.DriverRutas.background = () => {}; w.DriverRutas.deepLink = () => {};
  return { w, errores, llamadas, setEnt: (x) => { ENT = x; } };
}
{
  const { w, errores } = conductor();
  const box = () => w.document.getElementById('driver-home-ruta');
  await w.eval('renderDriverHomeRuta()'); await wait(40);
  t('Inicio: solo la que falta de verdad (V3); la vencida no sale arriba', box().querySelectorAll('[data-vuelta]').length === 1 && box().querySelector('[data-vuelta-start="AV3"]') && !box().querySelector('[data-vuelta-start="AV2"]'), tx(box()).slice(0, 160));
  const tg = box().querySelector('[data-vuelta-hechas]');
  t('abajo: «1 vuelta hecha · 1 sin marcar» con «Toca para verlas y marcar las que faltan»', tg && /1 vuelta hecha · 1 sin marcar/.test(tx(tg)) && /marcar las que faltan/.test(tx(tg)), tx(tg));
  tg.click(); await wait(10);
  t('al abrirlas, la vencida dice «Sin marcar»', /Sin marcar/.test(tx(box())));
  // Mi día
  const root = () => w.document.getElementById('driver-ruta-root');
  await w.DriverRutas.open(w.state.profile); await wait(80);
  const hero = root().querySelector('.rx-lbl');
  t('Mi día: «Tu siguiente vuelta» es la V3 (no la vencida de hace 2 h y media)', hero && /Tu siguiente vuelta/.test(tx(hero)) && /V3/.test(tx(root().querySelector('#rt-base'))) , tx(hero));
  const past = root().querySelector('[data-rt="toggle-past"]');
  t('«Pasaron sin marcar · 1», cerrada', past && /Pasaron sin marcar · 1/.test(tx(past)) && past.getAttribute('aria-expanded') === 'false', tx(past));
  past.click(); await wait(20);
  const pv = [...root().querySelectorAll('#rt-base .rt-vc')].find((x) => x.dataset.v === 'V2');
  t('al abrirla, la vencida se puede abrir para marcarla (detalle, no «hecha»)', pv && pv.dataset.rt === 'detail');
  const libres = [...root().querySelectorAll('.rt-libre')];
  // 0151 (Camilo, 27-oct): se puede tomar igual; pide confirmar y a Coordinación le llega el aviso.
  t('«Vueltas para tomar»: la que se cruza dice «Se cruza con otra vuelta tuya» y AHORA sí tiene «Tomar» (marcado para confirmar)', libres[0] && /Se cruza con otra vuelta tuya/.test(tx(libres[0])) && libres[0].querySelector('[data-rt="take"][data-cruza="1"]'), libres[0] && tx(libres[0]));
  {
    const tomadas = []; const conf = [];
    w.Api.driverTakeRoute = async (id) => { tomadas.push(id); return { id, plate: 'HYU376', cruza: '11:05' }; };
    w.confirm = (m) => { conf.push(m); return false; };
    libres[0].querySelector('[data-rt="take"]').click(); await wait(20);
    t('…al tocar «Tomar» pregunta antes (se te cruza) y si dice que no, no la toma', conf.length === 1 && /Se te cruza con otra vuelta tuya/.test(conf[0]) && tomadas.length === 0, JSON.stringify(conf));
    w.confirm = (m) => { conf.push(m); return true; };
    const b0 = root().querySelector('.rt-libre [data-rt="take"][data-cruza="1"]'); if (b0) b0.click(); await wait(60);
    t('…si dice que sí, la toma y el aviso dice con cuál se cruza y que Coordinación ya sabe', tomadas.length === 1 && /Se te cruza con la de las 11:05: Coordinación ya sabe/.test(tx(w.document.body)), tx(w.document.querySelector('#rt-toast-host') || w.document.body).slice(-200));
  }
  t('la otra también, sin marca de cruce, y nombra a Kriss (sin cuenta)', libres[1] && libres[1].querySelector('[data-rt="take"]:not([data-cruza="1"])') && /Kriss/.test(tx(libres[1])));
  w.DriverRutas.close();
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── E · Conductor: la tarjeta de entrega de turno ──');
{
  const { w, errores, llamadas, setEnt } = conductor();
  const box = () => w.document.getElementById('driver-home-entrega');
  t('Inicio tiene el lugar de la tarjeta, arriba de «Tu día»', box() && box().nextElementSibling && box().compareDocumentPosition(w.document.getElementById('driver-home-ruta')) & 4);
  const due = new Date(Date.parse(dia(0) + 'T14:00:00-05:00')).toISOString();
  setEnt([{ op_day: dia(0), band: 'am', role: 'entrega', due_at: due, car: 'Carro 1', plate: 'PRW443',
    from: { id: 'pD', name: 'Jorge Prueba' }, to: { id: 'pX', name: 'Daniel Restrepo Gil', phone: '310 555 0000' }, to_text: null, delivered_at: null }]);
  await w.DriverEntrega.render(); await wait(20);
  t('«🔑 Entrega de turno · 2:00 p. m.» · «Le entregas el carro a Daniel Restrepo»', /Entrega de turno/.test(tx(box())) && /2:00 p\. m\./.test(tx(box())) && /Le entregas el carro a Daniel Restrepo/.test(tx(box())), tx(box()));
  t('con el carro y para llamarlo', /Carro PRW443/.test(tx(box())) && box().querySelector('a[href="tel:3105550000"]'));
  const b = box().querySelector('[data-ent="ok"]');
  t('el botón grande «Entregado»', b && tx(b) === 'Entregado');
  b.click(); await wait(40);
  t('tocarlo lo marca en la base (día, franja)', JSON.stringify(llamadas[0]) === JSON.stringify([dia(0), 'am', false]), JSON.stringify(llamadas));
  t('… y dice «✓ Entregado a las …» con «Deshacer»', /✓ Entregado a las/.test(tx(box())) && box().querySelector('[data-ent="undo"]'));
  box().querySelector('[data-ent="undo"]').click(); await wait(40);
  t('«Deshacer» lo quita', JSON.stringify(llamadas[1]) === JSON.stringify([dia(0), 'am', true]) && box().querySelector('[data-ent="ok"]'));
  setEnt([{ op_day: dia(0), band: 'pm', role: 'entrega', due_at: due, car: 'Carro 2', plate: null, from: { id: 'pD', name: 'Jorge Prueba' }, to: null, to_text: 'En casa de Julián', delivered_at: null }]);
  await w.DriverEntrega.render(); await wait(20);
  t('si lo deja en un lugar: «Dejas el carro: En casa de Julián»', /Dejas el carro: En casa de Julián/.test(tx(box())), tx(box()));
  setEnt([{ op_day: dia(0), band: 'pm', role: 'entrega', due_at: due, car: 'Carro 2', plate: null, from: { id: 'pD', name: 'Jorge Prueba' }, to: null, to_text: null, delivered_at: null }]);
  await w.DriverEntrega.render(); await wait(20);
  t('sin destinatario: «Todavía no está definido… Coordinación te avisa» y se puede marcar', /Todavía no está definido a quién le entregas el carro: Coordinación te avisa/.test(tx(box())) && box().querySelector('[data-ent="ok"]'), tx(box()));
  setEnt([{ op_day: dia(0), band: 'am', role: 'recibe', due_at: due, car: 'Carro 1', plate: 'PRW443', from: { id: 'pM', name: 'Miguel Peña', phone: '300' }, to: { id: 'pD', name: 'Jorge Prueba' }, delivered_at: iso(-3) }]);
  await w.DriverEntrega.render(); await wait(20);
  t('el que recibe: «Recibes el carro · De Miguel Peña · carro PRW443» y que Miguel ya marcó', /Recibes el carro/.test(tx(box())) && /De Miguel Peña · carro PRW443/.test(tx(box())) && /Miguel marcó que te lo entregó/.test(tx(box())) && !box().querySelector('[data-ent]'), tx(box()));
  setEnt([]);
  await w.DriverEntrega.render(); await wait(20);
  t('sin entrega a la vista: no hay tarjeta', tx(box()) === '');
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── F · Jefe: «Entregas de turno» en Asignación ──');
{
  const { w, errores } = await asignacion();
  const D = w.RV2Fixture.DAY;
  const due = (hm2, d = D) => new Date(`${d}T${hm2}:00-05:00`).toISOString();
  const sets = [];
  let ROWS = [
    { op_day: D, band: 'am', due_at: due('14:00'), car: 'Carro 1', plate: 'PRW443', from: { id: 'd1', name: 'Carlos Mejía Ruiz' }, to: { id: 'd4', name: 'Daniel Restrepo' }, to_text: null, manual: false, sigue: false, delivered_at: null, received_at: null },
    { op_day: D, band: 'am', due_at: due('14:00'), car: 'Carro 2', plate: null, from: { id: 'd2', name: 'Miguel Peña' }, to: { id: 'd2', name: 'Miguel Peña' }, manual: false, sigue: true, delivered_at: null },
    { op_day: D, band: 'pm', due_at: due('02:00', '2026-10-13'), car: 'Carro 1', plate: null, from: { id: 'd4', name: 'Daniel Restrepo' }, to: null, to_text: null, manual: false, sigue: false, delivered_at: null },
  ];
  w.Api.listHandovers = async () => JSON.parse(JSON.stringify(ROWS));
  w.Api.setHandover = async (d, band, from, o) => { sets.push([d, band, from, o]); ROWS = ROWS.map((r) => (r.band === band && r.from.id === from ? Object.assign(r, o.to ? { to: { id: o.to, name: 'Jorge Pérez' }, manual: true } : { to: null, to_text: o.text, manual: true }) : r)); return {}; };
  w.Api.listAdmins = async () => [{ id: 'j1', full_name: 'Camilo Jefe' }];
  w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-ruta-julian.js') + '\n' + read('admin-entregas.js') + '\n;window.__T = { rt, renderRoutes };');
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  await w.__T.renderRoutes(); await wait(80);
  const card = q('#rv2-entregas');
  t('la tarjeta sale con el día publicado: «🔑 Entregas de turno» con 1 sin definir', card && !card.hidden && /Entregas de turno/.test(tx(card)) && /Entregas de turno 1/.test(tx(card.querySelector('h2'))), tx(card).slice(0, 120));
  const filas = () => [...card.querySelectorAll('.rv2-ent')];
  t('Carlos → Daniel a las 2:00 p. m. (Carro 1 · PRW443), automático', /2:00 p\. m\./.test(tx(filas()[0])) && /Carlos Mejía → Daniel Restrepo/.test(tx(filas()[0])) && /Automático/.test(tx(filas()[0])) && /Carro 1 · PRW443/.test(tx(filas()[0])), tx(filas()[0]));
  t('Miguel «sigue con el carro» (sin botón)', /Miguel Peña → sigue/.test(tx(filas()[1])) && /Sigue con el carro/.test(tx(filas()[1])) && !filas()[1].querySelector('[data-ent-edit]'), tx(filas()[1]));
  t('Daniel (tarde → mañana) sin definir: «elige a quién»', /Sin definir/.test(tx(filas()[2])) && filas()[2].dataset.k === 'warn', tx(filas()[2]));
  filas()[2].querySelector('[data-ent-edit]').click(); await wait(30);
  const sel = card.querySelector('[data-ent-sel]');
  t('«Cambiar» abre la lista: conductores, jefes y «Otro: lo deja en un lugar…»', sel && [...sel.options].some((o) => o.value === 'p:d1') && [...sel.options].some((o) => o.value === 'p:j1') && [...sel.options].some((o) => o.value === 't:'));
  sel.value = 't:'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  const txt = card.querySelector('[data-ent-txt]');
  t('con «Otro» aparece dónde lo deja', txt && txt.hidden === false);
  txt.value = 'En casa de Julián';
  card.querySelector('[data-ent-ok]').click(); await wait(60);
  t('Guardar lo manda a la base (día, «pm», Daniel, el texto)', JSON.stringify(sets[0]) === JSON.stringify([D, 'pm', 'd4', { text: 'En casa de Julián' }]), JSON.stringify(sets));
  t('… y la fila queda «Daniel Restrepo → En casa de Julián · Elegido por Coordinación»', /Daniel Restrepo → En casa de Julián/.test(tx(filas()[2])) && /Elegido por Coordinación/.test(tx(filas()[2])), tx(filas()[2]));
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── G · Reservas › «Nuevo pedido» (externos sin app) ──');
{
  const { w, errores } = ventana();
  const log = { ext: [], res: [], recargas: 0, toasts: [] };
  w.toast = (m) => log.toasts.push(m);
  w.Api = {
    listAuxiliares: async () => [
      { id: 'a1', name: 'Laura Gómez', active: true, deleted: false, external: false, res1: { name: 'El Olivar' }, unit1: 'T2 504' },
      { id: 'a2', name: 'Kriss Montoya', active: true, deleted: false, external: true, res1: { name: 'Campus Reservado' }, unit1: '' },
      { id: 'a3', name: 'Ya Eliminada', active: false, deleted: true, external: false },
    ],
    listResidences: async () => [{ id: 'r1', name: 'El Olivar', sector: 'Rionegro' }, { id: 'r2', name: 'Campus Reservado', sector: '' }],
    createExternal: async (f) => { log.ext.push(f); return { auxiliar_profile_id: 'aNEW', name: f.name, existed: false }; },
    adminCreateReservation: async (f) => { log.res.push(f); return 'resX'; },
  };
  w.renderReservas = () => { log.recargas++; };
  w.eval(read('admin-pedido-externo.js'));
  w.RendioPedido.bind();   // lo que hace Reservas al pintarse (renderReservas)
  const q = (s) => w.document.querySelector(s);
  const box = () => q('#rv-new-box');
  t('Reservas tiene «+ Nuevo pedido» y el recuadro (cerrado)', q('#rv-new') && /Nuevo pedido/.test(tx(q('#rv-new'))) && box().hidden === true);
  q('#rv-new').click(); await wait(30);
  t('abre: «Ya está registrado» / «Externo nuevo (sin app)», salida o llegada, día, hora, vuelo y nota', !box().hidden && /Ya está registrado/.test(tx(box())) && /Externo nuevo/.test(tx(box())) && q('#rvn-fecha') && q('#rvn-hora') && q('#rvn-vuelo'));
  const input = q('#rvn-q'); input.value = 'kri'; input.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(10);
  const op = box().querySelector('[data-rvn-pick="a2"]');
  t('buscar «kri» encuentra a Kriss, marcada «Externo»', op && /Kriss Montoya/.test(tx(op)) && /Externo/.test(tx(op)) && !box().querySelector('[data-rvn-pick="a3"]'));
  op.click(); await wait(10);
  box().querySelector('[data-rvn-tipo="lle"]').click(); await wait(10);
  t('llegada: la hora es «Hora de aterrizaje»', /Hora de aterrizaje/.test(tx(box())));
  q('#rvn-fecha').value = '2026-10-28'; q('#rvn-hora').value = '18:40'; q('#rvn-vuelo').value = 'AV9563';
  box().querySelector('[data-rvn="pedir"]').click(); await wait(40);
  t('«Pedir el traslado» lo pide a nombre de Kriss (llegada, 28-oct 18:40, AV9563)', JSON.stringify(log.res[0]) === JSON.stringify({ auxId: 'a2', type: 'lle', whenIso: '2026-10-28T18:40:00-05:00', flight: 'AV9563', note: '' }), JSON.stringify(log.res[0]));
  t('… cierra el recuadro, recarga Reservas y lo dice', box().hidden === true && log.recargas === 1 && /Pedido creado: Kriss Montoya · llegada/.test(log.toasts[0] || ''), log.toasts[0]);
  // Externo nuevo
  q('#rv-new').click(); await wait(30);
  box().querySelector('[data-rvn-quien="nuevo"]').click(); await wait(10);
  q('#rvn-name').value = 'Pepe Pérez'; q('#rvn-phone').value = '300 123 4567';
  q('#rvn-res').value = 'r1'; q('#rvn-unit').value = 'Casa 4';
  q('#rvn-fecha').value = '2026-10-28';
  box().querySelector('[data-rvn="pedir"]').click(); await wait(20);
  t('sin hora no deja: «Escribe la hora de presentación.»', /Escribe la hora de presentación/.test(tx(box())) && log.ext.length === 0);
  q('#rvn-hora').value = '05:30';
  box().querySelector('[data-rvn="pedir"]').click(); await wait(40);
  t('crea al externo (nombre, teléfono, conjunto, apto)', JSON.stringify(log.ext[0]) === JSON.stringify({ name: 'Pepe Pérez', phone: '300 123 4567', residenceId: 'r1', unit: 'Casa 4' }), JSON.stringify(log.ext[0]));
  t('… y le pide la salida (presentación 5:30)', log.res[1] && log.res[1].auxId === 'aNEW' && log.res[1].type === 'sal' && log.res[1].whenIso === '2026-10-28T05:30:00-05:00');
  // La fila de Reservas
  w.state = { settings: {} };
  w.eval(read('admin-reservas.js'));
  const fila = w.rvRow({ id: 'x', type: 'sal', name: 'Kriss Montoya', status: 'pending', when: '2026-10-28T05:30:00-05:00', time: '05:30', address: 'Campus Reservado', external: true });
  t('en Reservas la fila dice «Externo · sin app»', /Externo · sin app/.test(fila));
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: el layout (Chromium y teléfono), la base real (_verify-0137…0140) ni la push.');
process.exit(bad ? 1 : 0);
