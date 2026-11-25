// HORA SIN CONDUCTOR (24-nov-2026, 0179) — prueba jsdom.
//
// 24-nov, 9:30 p. m.: 8 tripulantes del 25 no veían la hora: iban en vueltas del «Carro 3»
// y el «Carro 4» que el tablero dejó en borrador (sin conductor). Harold: «tenga o no
// conductor, debería mostrar la hora». La base (0179) ya se la muestra con el día
// publicado; aquí, el AVISO que manda el teléfono del jefe al publicar.
//
// PARTE 1 · api.js DE VERDAD (saveRoutePlan) con un `sb` FALSO → `horasBorrador`:
//   · día ya publicado: la salida en borrador lleva su hora (la de su parada);
//   · republicar sin cambio de hora → nadie; con 10 min de cambio → «cambio»;
//   · día SIN publicar y sin ninguna vuelta con conductor → nadie;
//   · el mismo guardado publica el día (una vuelta con conductor deja la marca) → sí,
//     aunque ya estuvieran en un borrador (antes no veían la hora);
//   · la llegada en borrador → nadie; sin poder leer la marca → nadie;
//   · quien tenía conductor y queda en borrador a la misma hora → nadie; a otra → «cambio»;
//   · los avisos de siempre (Conductor asignado, cambio de hora) no cambian;
//   · por vuelta (Asignación): la vuelta que no se tocó no avisa.
// PARTE 2 · el tablero DE VERDAD (admin-rutas.js + admin-rutas-v2.js) con un Api falso:
//   qué push sale de `horasBorrador` (título, texto, agrupados por hora, «mañana»,
//   «pasado mañana» para la madrugada) y que lo demás sigue igual.
//
// NO CUBRE: la base real (0179 se prueba con scripts/_aplicar-0179.mjs), el disparador que
// deja la marca (0178), un teléfono de verdad ni el push real.
//
//   cd rendio-backend && node scripts/_smoke-hora-sin-conductor-1124-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clon = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/* ═════════════ PARTE 1 · saveRoutePlan de verdad, base falsa ═════════════ */
// DB.pub: la marca del día (true/false) o 'error'; DB.marcaAlPublicar: una vuelta
// planned que se inserta deja la marca (como el disparador de 0178 con sesión de jefe).
function fakeSb(DB) {
  const log = { inserts: { route_assignments: [], route_stops: [] }, leyoMarca: 0 };
  let n = 0;
  return {
    log,
    from(table) {
      let op = 'select', row = null, single = false;
      const filtros = [];
      const b = {
        select() { return b; }, single() { single = true; return b; }, maybeSingle() { single = true; return b; },
        order() { return b; }, limit() { return b; },
        insert(r) { op = 'insert'; row = r; return b; }, delete() { op = 'delete'; return b; }, update(r) { op = 'update'; row = r; return b; },
      };
      ['eq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'lt', 'gt', 'neq'].forEach((f) => { b[f] = (...a) => { filtros.push([f, ...a]); return b; }; });
      b.then = (res, rej) => {
        let out = { data: null, error: null };
        if (op === 'delete') out = { data: null, error: null };
        else if (op === 'insert') {
          if (table === 'route_assignments') {
            const id = 'nueva-' + (++n); log.inserts.route_assignments.push(Object.assign({ id }, row));
            if (DB.marcaAlPublicar && row.status === 'planned') DB.pub = true;
            out = { data: single ? { id } : [{ id }], error: null };
          } else log.inserts[table] = (log.inserts[table] || []).concat(row);
        } else if (table === 'route_published_days') {
          log.leyoMarca++;
          const okFiltros = filtros.some((f) => f[0] === 'eq' && f[1] === 'organization_id' && f[2] === 'org1') && filtros.some((f) => f[0] === 'eq' && f[1] === 'day' && f[2] === DIA);
          out = DB.pub === 'error' ? { data: null, error: { message: 'permission denied' } } : { data: DB.pub && okFiltros ? [{ id: 'marca' }] : [], error: null };
        } else if (table === 'route_assignments') out = { data: clon(DB.plan), error: null };
        else if (table === 'driver_profiles') out = { data: [{ id: 'dp-juan', profile_id: 'p-juan' }], error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
  };
}
function bootApi(plan, pub, extra) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.map(String).join(' '));
  w.console.warn = () => {};
  w.RENDIO_CONFIG = {};
  const DB = Object.assign({ plan, pub }, extra || {});
  w.sb = fakeSb(DB);
  w.eval('var state = { profile: { id: "jefe", role: "admin", organization_id: "org1" }, settings: {} };');
  w.eval(read('api.js'));
  return { w, errors, DB, L: w.sb.log, guardar: (lanes, pv) => (pv === undefined ? w.Api.saveRoutePlan(DIA, lanes) : w.Api.saveRoutePlan(DIA, lanes, { porVuelta: pv })) };
}

const DIA = '2026-11-25';
const iso = (hm, dia = DIA) => new Date(`${dia}T${hm}:00-05:00`).toISOString();
const min = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const st = (id, rid, eta, extra) => Object.assign({ id, reservation_id: rid, status: 'pending', estimated_arrival_at: eta ? iso(eta) : null, reservations: { cancelled_at: null } }, extra || {});
const fila = (id, hm, tipo, drv, stops, extra) => Object.assign({ id, status: drv ? 'planned' : 'draft', direction: tipo === 'lle' ? 'airport_to_home' : 'home_to_airport',
  planned_start_at: `${DIA}T${hm}:00-05:00`, driver_profile_id: drv ? 'dp-' + drv : null, pool: false, para_tomar: false, auto_created: false,
  delegated_at: null, delegate_name: null, driver_profiles: drv ? { profile_id: 'p-' + drv } : null, route_stops: stops }, extra || {});
// Una vuelta del tablero: etas = { reserva: 'HH:MM' } (en minutos desde la medianoche del día, como el tablero).
const lane = (laneId, tipo, hm, drv, etas, extra) => Object.assign({ laneId, driverProfileId: drv ? 'p-' + drv : null, type: tipo,
  startAt: `${DIA}T${hm}:00-05:00`, stops: Object.keys(etas), vehicleId: null, planCar: drv ? 'Carro 1' : 'Carro 3',
  etas: Object.fromEntries(Object.entries(etas).map(([r, h]) => [r, h.startsWith('+') ? 1440 + min(h.slice(1)) : min(h)])) }, extra || {});
// El 25-nov en pequeño: la de las 4:05 del Carro 3 (Andrea 4:05, Alejandra 4:15, Gersey 4:25)
// y una con conductor (Farid 2:35 con Juan).
const conJuan = () => lane('L-juan', 'sal', '02:35', 'juan', { 'res-farid': '02:35' });
const carro3 = (extra) => lane('L-c3', 'sal', '04:05', null, Object.assign({ 'res-andrea': '04:05', 'res-alejandra': '04:15', 'res-gersey': '04:25' }, extra || {}));
const hb = (r) => (r.horasBorrador || []).map((n) => `${n.reservationId}@${new Date(n.hora).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })}${n.cambio ? '·cambio' : ''}`).sort().join(',');

console.log('\n── 1 · Día ya publicado: la salida en borrador lleva su hora ──');
{
  const B = bootApi([], true);
  const r = await B.guardar([conJuan(), carro3()]);
  t('guarda sin errores', r && r.failed === 0 && B.errors.length === 0, JSON.stringify(r && r.failMsg) + ' ' + B.errors.join(' | '));
  t('el borrador sigue siendo borrador (sin conductor)', B.L.inserts.route_assignments.find((x) => x.plan_car === 'Carro 3').status === 'draft');
  t('horasBorrador: los 3 del Carro 3 con la hora de SU parada, como primera vez', hb(r) === 'res-alejandra@04:15,res-andrea@04:05,res-gersey@04:25', hb(r));
  t('Farid (con conductor) va como siempre: «Conductor asignado», no en horasBorrador', r.notify.length === 1 && r.notify[0].reservationId === 'res-farid' && !r.notify[0].hora && r.notify[0].driverProfileId === 'p-juan', JSON.stringify(r.notify));
  t('se leyó la marca del día una sola vez (ya estaba)', B.L.leyoMarca === 1, String(B.L.leyoMarca));
}

console.log('\n── 2 · Republicar el día (vista anterior: borra y vuelve a crear) ──');
{
  const antes = [fila('c3', '04:05', 'sal', null, [st('s1', 'res-andrea', '04:05'), st('s2', 'res-alejandra', '04:15'), st('s3', 'res-gersey', '04:25')]),
    fila('j', '02:35', 'sal', 'juan', [st('s4', 'res-farid', '02:35')])];
  const B = bootApi(clon(antes), true);
  const r = await B.guardar([conJuan(), carro3()]);
  t('sin cambio de hora: a nadie (ya la ve en la app)', hb(r) === '' && r.notify.length === 0, hb(r) + ' ' + JSON.stringify(r.notify));
  const B2 = bootApi(clon(antes), true);
  const r2 = await B2.guardar([conJuan(), carro3({ 'res-alejandra': '04:25', 'res-gersey': '04:27' })]);
  t('Alejandra 10 min después → «cambio»; Gersey 2 min (redondeo) → nada', hb(r2) === 'res-alejandra@04:25·cambio', hb(r2));
}

console.log('\n── 3 · Día SIN publicar ──');
{
  const B = bootApi([], false);
  const r = await B.guardar([carro3()]);
  t('solo borradores y el día sin marca: a nadie (no ve la hora)', hb(r) === '' && r.notify.length === 0, hb(r));
  t('…se volvió a leer la marca después de guardar (por si este guardado la dejó)', B.L.leyoMarca === 2, String(B.L.leyoMarca));
}

console.log('\n── 4 · Este mismo guardado publica el día ──');
{
  // Ya estaban en un borrador guardado antes de publicar (no veían la hora).
  const antes = [fila('c3', '04:05', 'sal', null, [st('s1', 'res-andrea', '04:05'), st('s2', 'res-alejandra', '04:15'), st('s3', 'res-gersey', '04:25')])];
  const B = bootApi(clon(antes), false, { marcaAlPublicar: true });
  const r = await B.guardar([conJuan(), carro3()]);
  t('la vuelta con conductor deja la marca y a los del borrador les llega su hora (primera vez)', hb(r) === 'res-alejandra@04:15,res-andrea@04:05,res-gersey@04:25', hb(r));
}

console.log('\n── 5 · Lo que NO avisa ──');
{
  const B = bootApi([], true);
  const r = await B.guardar([lane('L-lle', 'lle', '15:10', null, { 'res-lina': '15:10' })]);
  t('la llegada en borrador: nada', hb(r) === '', hb(r));
  const B2 = bootApi([], 'error');
  const r2 = await B2.guardar([carro3()]);
  t('sin poder leer la marca (base sin 0178 o sin permiso): nada', hb(r2) === '' && B2.errors.length === 0, hb(r2) + ' ' + B2.errors.join(' | '));
  const B3 = bootApi([], true);
  const l = carro3(); l.etas = {};
  const r3 = await B3.guardar([l]);
  t('sin hora en la parada: nada (no se inventa)', hb(r3) === '', hb(r3));
}

console.log('\n── 6 · Tenía conductor y queda sin conductor ──');
{
  const antes = [fila('j', '04:05', 'sal', 'juan', [st('s1', 'res-andrea', '04:05'), st('s2', 'res-alejandra', '04:15')])];
  const B = bootApi(clon(antes), true);
  const r = await B.guardar([lane('L-c3', 'sal', '04:05', null, { 'res-andrea': '04:05', 'res-alejandra': '04:30' })]);
  t('Andrea a la misma hora: nada; Alejandra a otra: «cambio»', hb(r) === 'res-alejandra@04:30·cambio', hb(r));
}

console.log('\n── 7 · Por vuelta (Asignación): la vuelta que no se tocó no avisa ──');
{
  const antes = [fila('c3', '04:05', 'sal', null, [st('s1', 'res-andrea', '04:05'), st('s2', 'res-alejandra', '04:15'), st('s3', 'res-gersey', '04:25')]),
    fila('c4', '10:55', 'sal', null, [st('s5', 'res-carlos', '10:55')])];
  const B = bootApi(clon(antes), true);
  const pv = { quitadas: [], base: { c3: 'res-alejandra,res-andrea,res-gersey', c4: 'res-carlos' }, conocidas: ['res-andrea', 'res-alejandra', 'res-gersey', 'res-carlos'] };
  const lanes = [Object.assign(carro3(), { raId: 'c3', cambio: false }),
    Object.assign(lane('L-c4', 'sal', '10:55', null, { 'res-carlos': '11:05' }), { raId: 'c4', cambio: true })];
  const r = await B.guardar(lanes, pv);
  t('solo Carlos (su vuelta cambió de hora): «cambio»', hb(r) === 'res-carlos@11:05·cambio', hb(r) + ' ' + JSON.stringify(r.conflictos));
  t('sin errores', B.errors.length === 0, B.errors.join(' | '));
}

/* ═════════════ PARTE 2 · el tablero de verdad, Api falso ═════════════ */
async function bootTablero() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = () => {};
  w.confirm = () => true;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  w.RV2Fixture.instalar(w.Api, { publicado: true });
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') +
      '\n;window.__T = { rt, renderRoutes, rtSavePlan };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  await w.__T.renderRoutes();
  await wait(40);
  const push = [];
  let respuesta = null;
  w.Api.auxiliarUserIdsForReservations = async (rids) => rids.map((r) => 'u-' + r);
  w.Api.sendPush = async (p) => { push.push(clon(p)); };
  w.Api.saveRoutePlan = async (day, lanes, opts) => Object.assign({ saved: lanes.length, skipped: 0, kept: 0, failed: 0, failMsg: '', notify: [], ofrecer: [], horasBorrador: [] },
    opts && opts.porVuelta ? { ids: {}, porVuelta: true, intactas: 0, conflictos: [], viejas: [], quitadas: [], borradas: [] } : {}, respuesta || {});
  const publicar = async (resp) => { respuesta = resp; push.length = 0; await w.__T.rtSavePlan({ toast: () => {} }); await wait(5); return push.slice(); };
  return { w, errors, publicar };
}
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const masDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const MAN = masDias(hoy, 1), PAS = masDias(hoy, 2);

console.log('\n── 8 · El tablero: el push de «Tu hora de recogida» ──');
{
  const b = await bootTablero();
  const p = await b.publicar({ horasBorrador: [
    { reservationId: 'res-andrea', hora: iso('04:05', MAN), cambio: false },
    { reservationId: 'res-alejandra', hora: iso('04:15', MAN), cambio: false },
    { reservationId: 'res-gersey', hora: iso('04:15', MAN), cambio: false },
    { reservationId: 'res-carlos', hora: iso('11:05', MAN), cambio: true },
    { reservationId: 'res-mad', hora: iso('01:40', PAS), cambio: false },
  ] });
  const de = (u) => p.filter((x) => x.profileIds.includes(u));
  t('Andrea: «Tu hora de recogida 🕒 · Te recogemos mañana a las 4:05. Te avisamos quién te recoge.»', de('u-res-andrea').length === 1 && de('u-res-andrea')[0].title === 'Tu hora de recogida 🕒' && de('u-res-andrea')[0].body === 'Te recogemos mañana a las 4:05. Te avisamos quién te recoge.' && de('u-res-andrea')[0].url === '/#/viajes', JSON.stringify(de('u-res-andrea')));
  t('Alejandra y Gersey (misma hora) en UN solo push', de('u-res-alejandra').length === 1 && de('u-res-alejandra')[0] === de('u-res-gersey')[0] || (de('u-res-alejandra').length === 1 && JSON.stringify(de('u-res-alejandra')[0]) === JSON.stringify(de('u-res-gersey')[0]) && de('u-res-alejandra')[0].profileIds.length === 2), JSON.stringify(de('u-res-alejandra')));
  t('Carlos (le cambió): «Cambió tu hora de recogida 🕒 · Ahora te recogemos a las 11:05.»', de('u-res-carlos').length === 1 && de('u-res-carlos')[0].title === 'Cambió tu hora de recogida 🕒' && de('u-res-carlos')[0].body === 'Ahora te recogemos a las 11:05.', JSON.stringify(de('u-res-carlos')));
  t('la madrugada siguiente dice el día por su nombre, no «mañana»', de('u-res-mad').length === 1 && /^Te recogemos el \w+ \d+ a las 1:40\./.test(de('u-res-mad')[0].body), JSON.stringify(de('u-res-mad')));
  t('ningún «Ruta asignada» a conductores (no hay conductor)', !p.some((x) => x.title === 'Ruta asignada 🗺️'), JSON.stringify(p.map((x) => x.title)));
  t('4 pushes en total', p.length === 4, JSON.stringify(p.map((x) => x.title)));
  const p2 = await b.publicar({ notify: [{ reservationId: 'res-farid', changed: false, driverProfileId: 'p-juan' }] });
  t('sin horasBorrador: lo de siempre («Conductor asignado» + «Ruta asignada»), nada más', p2.length === 2 && p2[0].title === 'Conductor asignado 🚗' && p2[1].title === 'Ruta asignada 🗺️', JSON.stringify(p2.map((x) => x.title)));
  const p3 = await b.publicar({ horasBorrador: undefined });
  t('una respuesta vieja sin horasBorrador no rompe nada', p3.length === 0 && b.errors.length === 0, JSON.stringify(p3) + ' ' + b.errors.join(' | '));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

/* ═════════════ PARTE 3 · la app del tripulante con la fila que trae 0179 ═════════════ */
// La fila de Alejandra Romero tal como la daría auxiliar_my_trips con 0179 (simulada en
// producción el 24-nov: 4:15, recogida 2/3, sin conductor), contra la de antes.
async function bootAux() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  w.RENDIO_CONFIG = {};
  w.toast = () => {};
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const trampa = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : trampa), apply: () => trampa });
  w.sb = trampa;
  w.state = { settings: {} };
  w.eval(readFileSync(FIX + 'fake-sw.js', 'utf8'));
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.localStorage.setItem('rendio.aux.rx', '1');
  w.localStorage.setItem('rendio.aux.onboarded.p1', '1'); w.localStorage.setItem('rendio.aux.onboarded', '1');
  for (const f of ['api.js', 'api-aux.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js',
    'aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  if (w.AuxPresentacion && w.AuxPresentacion.markOnboarded) { try { w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ } }
  w.Api.countUnreadMessages = async () => ({});
  await w.Auxiliar.init({ id: 'p1', full_name: 'Alejandra Romero Mejia', role: 'auxiliar', is_active: true }).catch(() => {});
  await wait(30);
  w.eval(readFileSync(FIX + 'aux-escenarios.js', 'utf8'));
  return { w, errors, A: w.Auxiliar, E: w.AuxEscenarios, ui: () => w.document.getElementById('auxiliar-ui') };
}
const filaAle = (con0179) => ({
  id: 'res-ale', direction: 'home_to_airport', required_arrival_at: iso('05:10', MAN), date: MAN, time: '05:10', raw_status: 'requested',
  cancelled_at: null, cancellation_reason: null, notes: null, notes_user: '', flight_number: null, pickup_address: 'Torre 6 Apto 705', pickup_latitude: 6.15, pickup_longitude: -75.37,
  residence_id: null, residence_unit: 'Torre 6 Apto 705', meeting_point: null, is_overnight: false, is_firm: true, ready_confirmed_at: null, service_level: 'shared',
  private_status: null, price_cop: null, private_reject_reason: null, rating: null, bags: 0, quiet_ride: false, created_at: iso('14:12', hoy), ground_ops: false, reserve_place: null,
  published: con0179, pickup_at: con0179 ? iso('04:15', MAN) : null, meet_code: null, pickup_pos: con0179 ? 2 : null, pickup_total: con0179 ? 3 : null,
  stop_status: con0179 ? 'pending' : null, arrived_at: null, picked_at: null, dropped_at: null, driver_pending: con0179, delegated: false, delegate: null, driver: null, vehicle: null,
});

console.log('\n── 9 · La app del tripulante: antes y con 0179 ──');
{
  const b = await bootAux();
  const { w, A, E, ui } = b;
  const ver = async (fila) => {
    E.montar('vacio');
    const T = w.ApiAux.mapTrip(fila);
    A.state.trips = [T];
    w.Api.listMyReservations = async () => [w.ApiAux.mapTrip(fila)];
    A.rerender(); await wait(40);
    const home = (ui().querySelector('.rx-tabview[data-scr="home"]') || ui()).textContent.replace(/\s+/g, ' ');
    A.openTrip('res-ale'); await wait(40);
    const viaje = ui().textContent.replace(/\s+/g, ' ');
    return { T, home, viaje };
  };
  const antes = await ver(filaAle(false));
  t('ANTES: Inicio sin hora de recogida (no hay «Te recogemos 04:15»)', !/04:15/.test(antes.home) && !/Te recogemos \d/i.test(antes.home), antes.home.slice(0, 300));
  t('ANTES: el viaje dice «Estamos armando tu ruta»', /Estamos armando tu ruta/.test(antes.viaje), antes.viaje.slice(0, 300));
  const con = await ver(filaAle(true));
  t('0179: mapTrip trae la hora y «falta conductor»', con.T.published === true && con.T.pickupAt === iso('04:15', MAN) && con.T.driverPending === true && !con.T.driver, JSON.stringify({ p: con.T.published, h: con.T.pickupAt, dp: con.T.driverPending }));
  t('0179: Inicio dice «te recogemos» con 04:15', /te recogemos/i.test(con.home) && /04:15/.test(con.home), con.home.slice(0, 400));
  t('0179: Inicio muestra «Recogida 2/3»', /Recogida\s*2\/3/.test(con.home), con.home.slice(0, 400));
  t('0179: el viaje dice «Tu ruta está lista · Te avisamos quién te recoge…» y la hora', /Tu ruta está lista/.test(con.viaje) && /04:15/.test(con.viaje), con.viaje.slice(0, 400));
  t('0179: sin conductor inventado (ni «Llamar» ni placa)', !/Llamar/.test(con.viaje), con.viaje.slice(0, 300));
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: la base real (eso es _aplicar-0179.mjs), el disparador de la marca (0178), teléfono y push reales, layout (jsdom no pinta).');
process.exit(bad ? 1 : 0);
