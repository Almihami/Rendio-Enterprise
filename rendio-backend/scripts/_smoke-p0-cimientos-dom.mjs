// P0 · CIMIENTOS del rediseño del auxiliar (27-sep-2026).
//
// Comprueba lo que P0 dejó en la Ola 0, con la bandera APAGADA:
//   · api.js: fecha y hora en Bogotá (0.8), pickupAt (0.5), notesUser (0.10),
//     la escalera de createReservation que solo baja por columnas que faltan y
//     nunca convierte un privado en compartido (0.9), getMyAuxHeader, y las
//     columnas nuevas del conductor en listMyVueltasForDriver.
//   · auxiliar.js: el gancho de la bandera, el contrato de window.Auxiliar
//     (§2.9), la cabecera en auxInit, «en MDE» en vez de «pres.» y la demora
//     medida contra la hora de recogida publicada.
//   · index.html / sw.js: todos los stubs registrados, en orden, en APP_SHELL,
//     v165, las tres secciones admin; los stubs no definen nada en window.
//   · admin-consola.js: las entradas nuevas solo aparecen cuando su módulo existe.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre el service worker (no prueba
// que cache.addAll instale de verdad), no hay Supabase real (el cliente es
// falso: la degradación contra una base sin 0086 se prueba simulando PGRST204),
// ni push, ni Leaflet, ni animaciones.
//
//   cd rendio-backend && node scripts/_smoke-p0-cimientos-dom.mjs
process.env.TZ = 'Europe/Madrid';   // el teléfono en OTRA zona: la hora tiene que salir en Bogotá igual
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = f => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Cliente Supabase FALSO: cada consulta se resuelve con handler(tabla, estado).
// ─────────────────────────────────────────────────────────────────────────────
function fakeSb(handler) {
  const log = [];
  const builder = (table) => {
    const st = { table, op: 'select', cols: null, row: null, filters: [] };
    const b = {
      select(c) { if (st.op === 'select') st.cols = c; else st.returning = c; return b; },
      insert(row) { st.op = 'insert'; st.row = row; return b; },
      update(row) { st.op = 'update'; st.row = row; return b; },
      eq(k, v) { st.filters.push(['eq', k, v]); return b; },
      in(k, v) { st.filters.push(['in', k, v]); return b; },
      gte() { return b; }, lte() { return b; }, order() { return b; }, limit() { return b; },
      single() { st.single = true; return b; }, maybeSingle() { st.single = true; return b; },
      then(res, rej) { log.push(st); return Promise.resolve(handler(table, st)).then(res, rej); },
    };
    return b;
  };
  return { log, from: builder, auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }), getSession: async () => ({ data: { session: null } }) }, rpc: async () => ({ data: null, error: null }) };
}
function apiWith(handler) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.sb = fakeSb(handler);
  w.eval(read('api.js'));
  return { Api: w.Api, log: w.sb.log };
}
const colErr = { code: 'PGRST204', message: "Could not find the 'x' column of 'reservations' in the schema cache" };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── api.js · listMyReservations en hora de Bogotá, pickupAt y notesUser ──');
{
  const rows = [{
    id: 'a1', direction: 'home_to_airport', pickup_address: 'El Olivar', pickup_latitude: 6.15, pickup_longitude: -75.37,
    required_arrival_at: '2026-09-28T01:30:00+00:00',   // 20:30 del 27-sep en Bogotá
    status_h2a: 'assigned', status_a2h: null, notes: 'Vuelo AV9412. Portería 3 · Regreso del mismo día', cancelled_at: null, rating: null, flights: null,
    calculated_pickup_at: '2026-09-28T00:10:00+00:00',
  }];
  const { Api, log } = apiWith((table, st) => {
    if (table === 'auxiliar_profiles') return { data: { id: 'ap1' }, error: null };
    if (table === 'reservations') return st.cols.includes('calculated_pickup_at') ? { data: rows, error: null } : { data: null, error: colErr };
    return { data: null, error: null };
  });
  const trips = await Api.listMyReservations();
  const x = trips && trips[0];
  t('un traslado a las 20:30 de Bogotá sale con la fecha de ESE día', x && x.date === '2026-09-27', x && x.date);
  t('y con la hora de Bogotá aunque el teléfono esté en Madrid', x && x.time === '20:30', x && x.time);
  t('pickupAt = calculated_pickup_at (hora publicada)', x && x.pickupAt === '2026-09-28T00:10:00+00:00', x && x.pickupAt);
  t('notesUser sin el vuelo ni la marca del regreso', x && x.notesUser === 'Portería 3', x && x.notesUser);
  t('la columna nueva va en el escalón de arriba', log.some(s => s.table === 'reservations' && /calculated_pickup_at/.test(s.cols)));
  t('Api.notesUser existe (un solo helper)', typeof Api.notesUser === 'function' && Api.notesUser('Vuelo JA-5116. hola') === 'hola');

  // Sin 0085 en la base (columna pedida y rechazada): baja un escalón y pickupAt null.
  const b = apiWith((table, st) => {
    if (table === 'auxiliar_profiles') return { data: { id: 'ap1' }, error: null };
    if (table === 'reservations') return st.cols.includes('calculated_pickup_at') ? { data: null, error: colErr } : { data: rows.map(({ calculated_pickup_at, ...r }) => r), error: null };
    return { data: null, error: null };
  });
  const y = (await b.Api.listMyReservations())[0];
  t('sin la columna: baja de escalón y pickupAt = null (nada inventado)', y && y.pickupAt === null && y.date === '2026-09-27', JSON.stringify(y && { p: y.pickupAt, d: y.date }));
}

console.log('\n── api.js · createReservation: solo degrada por columnas que faltan ──');
{
  const base = { type: 'sal', date: '2026-10-01', time: '05:10', address: 'El Olivar', lat: 6.15, lng: -75.37, residenceId: 'r1', residenceUnit: 'T3 302', isReserva: true };
  const inserts = [];
  const mk = (fn) => apiWith((table, st) => {
    if (table === 'auxiliar_profiles') return { data: { id: 'ap1' }, error: null };
    if (table === 'reservations' && st.op === 'insert') { inserts.push(st.row); return fn(st.row, inserts.length); }
    return { data: null, error: null };
  }).Api;

  // 1. Privado que el servidor rechaza por una regla (no por columna): se LANZA.
  inserts.length = 0;
  let A = mk(() => ({ data: null, error: { code: 'P0001', message: 'La camioneta ya está comprometida' } }));
  let err = null; try { await A.createReservation({ ...base, level: 'private', quietRide: true, bags: 2 }); } catch (e) { err = e; }
  t('privado rechazado por el servidor → error, sin reintentos', err && /comprometida/.test(err.message) && inserts.length === 1, `${err && err.message} · intentos ${inserts.length}`);
  t('ningún intento se mandó sin service_level (no se volvió compartido)', inserts.every(r => r.service_level === 'private'));

  // 2. Privado en una base sin 0086: baja sin maletas y sin silencio, pero sigue privado.
  inserts.length = 0;
  A = mk(row => ('bags' in row || 'quiet_ride' in row) ? { data: null, error: colErr } : { data: { id: 'n1' }, error: null });
  const id = await A.createReservation({ ...base, level: 'private', quietRide: true, bags: 2 });
  t('sin columnas de 0086: se crea igual', id === 'n1', id);
  t('primer intento con bags y quiet_ride dentro del privado', inserts[0].bags === 2 && inserts[0].quiet_ride === true && inserts[0].service_level === 'private', JSON.stringify(inserts[0]));
  t('el que quedó sigue siendo privado', inserts[inserts.length - 1].service_level === 'private');

  // 3. Compartido con «silencio» marcado: quiet_ride NO viaja (solo existe en privado).
  inserts.length = 0;
  A = mk(() => ({ data: { id: 'n2' }, error: null }));
  await A.createReservation({ ...base, level: 'shared', quietRide: true, bags: 1 });
  t('compartido: sin quiet_ride y sin service_level', !('quiet_ride' in inserts[0]) && !('service_level' in inserts[0]), JSON.stringify(inserts[0]));
  t('compartido: las maletas sí viajan', inserts[0].bags === 1);

  // 4. Suspendido (42501): se lanza tal cual.
  inserts.length = 0;
  A = mk(() => ({ data: null, error: { code: '42501', message: 'Tu cuenta está suspendida' } }));
  err = null; try { await A.createReservation({ ...base }); } catch (e) { err = e; }
  t('suspensión 42501 → se lanza al primer intento', err && err.code === '42501' && inserts.length === 1, `${err && err.code} · ${inserts.length}`);

  // 5. Base vieja (sin nada de lo nuevo): la escalera llega al payload mínimo.
  inserts.length = 0;
  A = mk((row) => ['bags', 'residence_id', 'residence_unit', 'is_overnight', 'is_firm'].some(k => k in row)
    ? { data: null, error: { code: '42703', message: 'column does not exist' } } : { data: { id: 'n5' }, error: null });
  const id5 = await A.createReservation({ ...base, bags: 0 });
  t('compartido en base vieja: termina en el payload mínimo', id5 === 'n5' && !('is_overnight' in inserts[inserts.length - 1]) && !('residence_id' in inserts[inserts.length - 1]), JSON.stringify(inserts[inserts.length - 1]));
  t('sin escalones repetidos', new Set(inserts.map(r => JSON.stringify(Object.keys(r).sort()))).size === inserts.length);
}

console.log('\n── api.js · getMyAuxHeader y las columnas del conductor ──');
{
  const { Api, log } = apiWith((table, st) => {
    if (table !== 'auxiliar_profiles') return { data: null, error: null };
    if (/preferred_service_level/.test(st.cols)) return { data: null, error: colErr };   // sin 0086
    return { data: { id: 'ap1', joined_at: '2026-03-14', residence_id: 'r1', residence_unit: 'T3 302', residence_id_2: null, residence_unit_2: null,
      residences: { id: 'r1', name: 'El Olivar', sector: 'Rionegro' }, residencia2: null, airlines: { name: 'Avianca', iata_code: 'av' } }, error: null };
  });
  const H = await Api.getMyAuxHeader();
  t('sin 0086 baja de escalón y responde', H && H.airlineName === 'Avianca' && H.joinedAt === '2026-03-14', JSON.stringify(H));
  t('nivel preferido y punto de encuentro vacíos (no inventados)', H && H.preferredLevel === null && H.meetingPoint === '');
  t('residencia y unidad', H && H.residence && H.residence.name === 'El Olivar' && H.unit === 'T3 302');
  t('no trae teléfono (ya llega en getCurrentProfile)', H && !('phone' in H));
  t('intentó primero con las columnas de 0086', log[0] && /preferred_service_level/.test(log[0].cols));

  const V = apiWith((table, st) => {
    if (table === 'driver_profiles') return { data: { id: 'dp1' }, error: null };
    if (table === 'route_assignments') {
      if (/bags/.test(st.cols)) return { data: null, error: colErr };
      const hoy = new Date().toISOString();
      return { data: [{ id: 'ra1', direction: 'home_to_airport', planned_start_at: hoy, status: 'planned',
        route_stops: [{ stop_order: 1, reservation_id: 'x1', reservations: { pickup_address: 'El Olivar', required_arrival_at: hoy, notes: '', service_level: 'private', private_status: 'approved', auxiliar_profiles: { profiles: { id: 'p', full_name: 'Ana', phone: '' } } } }] }], error: null };
    }
    return { data: null, error: null };
  }).Api;
  const vs = await V.listMyVueltasForDriver('p-driver');
  const s0 = vs && vs[0] && vs[0].legs[0];
  t('conductor: sin 0086 la ruta sale igual', !!s0 && s0.name === 'Ana', JSON.stringify(s0));
  t('conductor: nivel del traslado llega', s0 && s0.level === 'private' && s0.privateStatus === 'approved');
  t('conductor: maletas/código/silencio vacíos sin la columna', s0 && s0.bags === null && s0.meetCode === '' && s0.quiet === false);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── auxiliar.js · gancho de la bandera y contrato de window.Auxiliar ──');
const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; global.window = window; global.document = window.document;
window.RENDIO_CONFIG = {}; window.toast = () => {}; window.L = undefined;
window.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const antes = new Set(Object.keys(window));
const STUBS_JS = ['api-aux.js', 'api-cobro.js', 'api-puntos.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-rx-inicio.js', 'aux-rx-viajes.js',
  'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js', 'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js',
  'aux-rx-vuelo.js', 'admin-coordinacion.js', 'admin-cobro.js', 'admin-puntos.js'];
for (const f of STUBS_JS) window.eval(read(f));
const nuevos = Object.keys(window).filter(k => !antes.has(k));
// Los archivos nacieron vacíos (P0) y cada paquete los va llenando: lo que se
// exige es que carguen sin error y que solo publiquen nombres del contrato
// (Api*, Aux*, render*/stop*Timer de los paneles admin), nada suelto.
const NOMBRES_CONTRATO = /^(Api(Aux|Cobro|Puntos)|Aux[A-Z]\w*|render(Coordinacion|Cobro|Puntos)|stop(Coord|Cobro|Puntos)Timer)$/;
const sueltos = nuevos.filter(k => !NOMBRES_CONTRATO.test(k));
t('los 18 archivos nuevos cargan y solo publican nombres del contrato', sueltos.length === 0, sueltos.join(',') || nuevos.join(','));

let headerPedido = 0;
window.Api = {
  listMyReservations: async () => [
    { id: 'v1', type: 'sal', date: '2026-10-01', time: '05:10', address: 'El Olivar, Rionegro', status: 'pending', notes: '' },
  ],
  getMyAuxHeader: async () => { headerPedido++; return { airlineName: 'Avianca', joinedAt: '2026-03-14', preferredLevel: null, meetingPoint: '' }; },
  listResidences: async () => [], getMyAuxiliarPlace: async () => ({}), getSettings: async () => ({ aux_min_lead_hours: 6 }),
  notesUser: (n) => String(n || '').replace(/^\s*vuelo[^.]*\.\s*/i, '').trim(),
};
window.state = { settings: { aux_min_lead_hours: 6 } }; global.state = window.state;
for (const f of ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'auxiliar.js']) window.eval(read(f));
const A = window.Auxiliar;
const CONTRATO = ['init', 'state', 'rerender', 'fieldHTML', 'toggleHTML', 'stepKind', 'kinds', 'submit', 'goStep', 'syncCta', 'openTrip', 'newTrip',
  'goTab', 'back', 'reloadTrips', 'stopTrack', 'afterForm', 'afterTrip', 'setupPwa', 'upcoming', 'past', 'isUpcoming', 'lastTrip', 'typeMeta',
  'statusMeta', 'lateHTML', 'leadCheck', 'whenISO', 'settingsWarnHTML', 'freshLabel', 'share', 'meetVisible', 'suspended'];
const faltan = CONTRATO.filter(k => typeof A[k] !== 'function' && !(k === 'state' && typeof A[k] === 'object'));
t('window.Auxiliar trae todo el contrato de §2.9', faltan.length === 0, faltan.join(','));
t('header existe en el contrato (null antes de init)', 'header' in A && A.header === null);

window.localStorage.setItem('rendio.aux.onboarded', '1');
// Desde la integración el rediseño viene ENCENDIDO por defecto: esta parte
// prueba el camino de siempre, así que usa el interruptor de emergencia.
window.localStorage.setItem('rendio.aux.rx', '0');
if (window.AuxPresentacion && window.AuxPresentacion.markOnboarded) window.AuxPresentacion.markOnboarded();
await A.init({ id: 'p1', full_name: 'Laura Gómez', role: 'auxiliar' }); await wait(60);
const ui = () => window.document.getElementById('auxiliar-ui');
t('auxInit llena Auxiliar.header con Api.getMyAuxHeader', headerPedido === 1 && A.header && A.header.airlineName === 'Avianca', JSON.stringify(A.header));
A.state.view = 'home'; A.rerender();
t('sin AuxShell: pinta la UI de hoy (Mis viajes)', /Mis viajes/.test(ui().textContent));
t('la tarjeta dice «en MDE», no «pres.»', /en MDE 05:10/.test(ui().textContent) && !/pres\./.test(ui().textContent), ui().querySelector('.ax-trip-bot')?.textContent);
t('sin la clase rx-phone (nada del rediseño aplica)', !ui().classList.contains('rx-phone'));

let renders = 0;
window.AuxShell = { on: () => false, render: () => { renders++; } };
const htmlAntes = ui().innerHTML; A.rerender();
t('AuxShell con la bandera apagada: camino de siempre', renders === 0 && ui().innerHTML === htmlAntes);
window.AuxShell = { on: () => true, render: () => { renders++; } };
ui().innerHTML = '<i id="marca"></i>'; A.rerender();
t('AuxShell encendido: pinta el shell y no toca el DOM heredado', renders === 1 && !!ui().querySelector('#marca'));
window.AuxShell = {};   // un stub a medio llenar no rompe
A.rerender();
t('AuxShell sin on(): camino de siempre', /Mis viajes/.test(ui().textContent));
delete window.AuxShell;

console.log('\n── auxiliar.js · la demora contra la hora de recogida publicada ──');
{
  const hhmm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const dia = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const en = new Date(Date.now() + 90 * 60000);   // quiere estar en MDE en 90 min
  const trip = { id: 'z1', type: 'sal', date: dia(en), time: hhmm(en), status: 'assigned' };
  const sin = window.eval('auxLateness')(trip, null);
  t('sin hora publicada: regla de siempre (recogida ~1 h antes) → a tiempo', sin && sin.level === 'ok', JSON.stringify(sin));
  const con = window.eval('auxLateness')({ ...trip, pickupAt: new Date(Date.now() - 5 * 60000).toISOString() }, null);
  t('con la recogida publicada hace 5 min → «Vas sobre el tiempo»', con && con.level === 'tight', JSON.stringify(con));
  const tarde = window.eval('auxLateness')({ ...trip, date: dia(new Date(Date.now() - 3600000)), time: hhmm(new Date(Date.now() - 3600000)) }, null);
  t('pasada la hora: el texto habla de la hora en el aeropuerto, no de «presentación»', tarde && /hora a la que querías estar en el aeropuerto/.test(tarde.text) && !/presentaci/i.test(tarde.text), tarde && tarde.text);
}

console.log('\n── auxiliar.js · stubs seguros ──');
{
  t('isUpcoming: un cancelado no es próximo', A.isUpcoming({ status: 'cancelled' }) === false && A.isUpcoming({ status: 'pending' }) === true);
  t('meetVisible: sin código nunca', A.meetVisible({ type: 'sal', status: 'onway' }) === false);
  t('meetVisible: salida en camino con código', A.meetVisible({ type: 'sal', status: 'onway', meetCode: '4827' }) === true);
  t('meetVisible: a bordo ya no', A.meetVisible({ type: 'sal', status: 'onboard', meetCode: '4827' }) === false);
  t('typeMeta acepta el viaje o el tipo', A.typeMeta({ type: 'lle' }).label === 'Llegada' && A.typeMeta('sal').label === 'Salida');
  t('suspended() refleja is_active', (A.state.profile.is_active = false, A.suspended() === true) && (A.state.profile.is_active = true, A.suspended() === false));
  A.newTrip(); await wait(20);
  t('newTrip abre el pedido en el paso 1', A.state.view === 'form' && A.state.step === 1);
  t('goStep por nombre', A.goStep('vuelo') === true && A.state.step === 2);
  t('back retrocede un paso', A.back() === true && A.state.step === 1);
  A.state.profile.is_active = false;
  A.state.view = 'home'; A.rerender();
  t('newTrip con suspensión no abre el pedido', A.newTrip() === false && A.state.view === 'home');
  A.state.profile.is_active = true;
  A.openTrip('v1'); await wait(20);
  t('openTrip abre ese viaje', A.state.view === 'trip' && A.state.editingTrip === 'v1');
  A.stopTrack();
  t('reloadTrips (stub) no pierde los viajes', (await A.reloadTrips()).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── index.html y sw.js · registro de los archivos nuevos ──');
{
  const html = read('index.html'), sw = read('sw.js');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const css = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  const pos = (a, f) => a.indexOf(f);
  const antesDe = (a, x, y) => pos(a, x) >= 0 && pos(a, y) >= 0 && pos(a, x) < pos(a, y);
  t('api-aux/api-cobro/api-puntos justo después de api.js', scripts.slice(pos(scripts, 'api.js') + 1, pos(scripts, 'api.js') + 4).join() === 'api-aux.js,api-cobro.js,api-puntos.js');
  t('aux-rx-ui.js y aux-shell.js ANTES de aux-registro.js', antesDe(scripts, 'aux-rx-ui.js', 'aux-shell.js') && antesDe(scripts, 'aux-shell.js', 'aux-registro.js'));
  const pant = ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js', 'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js'];
  t('las pantallas entre aux-presentacion.js y auxiliar.js, en orden', pant.every((f, i) => antesDe(scripts, 'aux-presentacion.js', f) && antesDe(scripts, f, 'auxiliar.js') && (i === 0 || antesDe(scripts, pant[i - 1], f))));
  t('admin-coordinacion (y cobro, puntos) después de admin-chat', antesDe(scripts, 'admin-chat.js', 'admin-coordinacion.js') && antesDe(scripts, 'admin-coordinacion.js', 'admin-cobro.js') && antesDe(scripts, 'admin-cobro.js', 'admin-puntos.js'));
  const CSS = ['rc-auxiliar.css', 'rx-auxiliar.css', 'rx-aux-app.css', 'rx-aux-shell.css', 'rx-aux-inicio.css', 'rx-aux-viaje.css', 'rx-aux-pedir.css', 'rx-aux-select.css', 'rx-aux-perfil.css', 'rx-aux-pagos.css', 'rx-aux-puntos.css', 'rx-aux-coord.css', 'rx-aux-onboard.css', 'login-rx.css', 'admin-coordinacion.css', 'admin-cobro.css', 'admin-puntos.css'];
  t('CSS después de rc-auxiliar.css en el orden del plan', CSS.every((f, i) => i === 0 || antesDe(css, CSS[i - 1], f)), css.join(' '));
  const locales = [...scripts, ...css].filter(f => !/^https?:/.test(f) && !f.startsWith('vendor/exceljs'));
  const fueraShell = locales.filter(f => !sw.includes(`'/${f}'`));
  t('todo archivo local de index.html está en APP_SHELL', fueraShell.length === 0, fueraShell.join(','));
  const shell = [...sw.split('APP_SHELL')[1].split('];')[0].matchAll(/'(\/[^']+)'/g)].map(m => m[1]).filter(p => p !== '/');
  const sinArchivo = shell.filter(p => !existsSync(APP + p.slice(1)));
  t('todo lo de APP_SHELL existe (si no, el SW no instala)', sinArchivo.length === 0, sinArchivo.join(','));
  t('CACHE_VERSION subió (≥ v165)', Number((sw.match(/CACHE_VERSION = 'rendio-turnos-v(\d+)'/) || [])[1]) >= 165);
  for (const [p, id] of [['coordinacion', 'coordinacion-ui'], ['cobro', 'cobro-ui'], ['puntos', 'puntos-ui']]) {
    const sec = window.document.querySelector(`section[data-panel="${p}"]`);
    t(`sección admin «${p}» con #${id}, oculta`, sec && sec.classList.contains('hidden') && sec.querySelector('#' + id));
  }
  const core = read('core.js');
  t('core.setTab llama renderCoordinacion/stopCoordTimer, renderCobro, renderPuntos con typeof', /name === 'coordinacion'[\s\S]{0,120}typeof window\.renderCoordinacion/.test(core) && /typeof window\.stopCoordTimer/.test(core) && /typeof window\.renderCobro/.test(core) && /typeof window\.renderPuntos/.test(core));
}

console.log('\n── admin-consola.js · entradas nuevas solo con su módulo ──');
{
  window.$ = (s) => window.document.querySelector(s); window.$$ = (s) => window.document.querySelectorAll(s);
  window.state = { activeTab: 'consola', profile: { role: 'admin' } }; global.state = window.state;
  for (const f of ['refreshPendingBadge', 'refreshInspectionsBadge', 'refreshShiftsBadge', 'refreshOilBadge', 'refreshEventsBadge', 'setTab', 'onLogout']) window[f] = () => {};
  window.eval(read('admin-consola.js'));
  // El espacio «Rutas» se elige como lo hace el jefe: con el switcher del sidebar.
  // (cnWs es un `let` del script: desde otro eval no se alcanza.)
  window.eval('bindAdminSidebar()');
  window.document.querySelector('#adm-wstabs button[data-ws="rutas"]').click();
  // Los tres paneles ya existen de verdad (tanda B): para probar que la entrada
  // aparece SOLO con su módulo, se quitan un momento y se vuelven a poner.
  const reales = { c: window.renderCoordinacion, b: window.renderCobro, p: window.renderPuntos };
  delete window.renderCoordinacion; delete window.renderCobro; delete window.renderPuntos;
  window.eval('renderConsola()');
  const cards = () => [...window.document.querySelectorAll('#cn-groups .mcard')].map(c => c.textContent);
  const sinStub = cards();
  t('sin sus módulos: ni Coordinación, ni Cuentas de cobro, ni Rendio Points', !sinStub.some(x => /Coordinación|Cuentas de cobro|Rendio Points/.test(x)), sinStub.length + ' tarjetas');
  const totalAntes = window.document.getElementById('cn-title').textContent;
  window.renderCoordinacion = reales.c || (() => {}); window.renderCobro = reales.b || (() => {}); window.renderPuntos = reales.p || (() => {});
  window.eval('renderConsola()');
  const con = cards();
  t('cuando existen: aparecen las tres', ['Coordinación', 'Cuentas de cobro', 'Rendio Points'].every(n => con.some(x => x.includes(n))));
  t('y el contador de módulos sube en 3', parseInt(window.document.getElementById('cn-title').textContent.match(/(\d+) módulos/)[1]) === parseInt(totalAntes.match(/(\d+) módulos/)[1]) + 3, totalAntes);
  window.eval('renderAdminSidebar()');
  t('el sidebar las lleva a su tab', !!window.document.querySelector('#adm-snav .nav-i[data-mod="coordinacion"]') && !!window.document.querySelector('#adm-snav .nav-i[data-mod="cobro"]') && !!window.document.querySelector('#adm-snav .nav-i[data-mod="puntos"]'));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout, el service worker instalando de verdad, Supabase real (cliente falso), push, Leaflet y animaciones.');
process.exit(bad ? 1 : 0);
