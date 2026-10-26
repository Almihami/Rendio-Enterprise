// App del conductor (driver-rutas.js DE VERDAD): un pasajero SIN CUENTA en la
// vuelta (0133, Kriss) — prueba jsdom.
//
// Comprueba, con una salida «Luz (con app) → Kriss (sin cuenta) → JMC»:
//   · Kriss sale como parada, con su lugar; sin chat (no tiene la app);
//   · el conteo de mensajes sin leer no manda su llave «g:…» (tumbaría el conteo);
//   · «Llegué», «a bordo» y la entrega en JMC van por driverSetGuestStopStatus con
//     el id de la PARADA; a Luz, por las de siempre;
//   · en el punto, el texto dice que no tiene la app (no «ya sabe que llegaste») y
//     no se le manda «estoy cerca».
//
// NO cubre: la base (_verify-0133.mjs), el GPS real ni el teléfono.
//
//   cd rendio-backend && node scripts/_smoke-guest-conductor-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
const errores = [];
w.addEventListener('error', (e) => errores.push(e.message));
w.RENDIO_CONFIG = {}; w.toast = () => {}; w.L = undefined;
w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
w.alert = () => {}; w.confirm = () => true;
w.Element.prototype.scrollIntoView = function () {};
let gpsCb = null;
Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition(cb) { gpsCb = cb; return 1; }, clearWatch() {} } });
const gps = async (lat, lng) => { if (gpsCb) gpsCb({ coords: { latitude: lat, longitude: lng, heading: null, speed: null } }); await wait(30); };
const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Cra 1 #2-3', unit: '', flight: '', dl: '05:30', phone: '',
  notes: '', bags: null, quiet: false, meetCode: '', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '04:50', eta: '' }, o);
const V = [{ id: 'V1', type: 'sal', start: '04:40', startAt: HOY + 'T04:40:00-05:00', done: false, assignmentId: 'RA1', day: HOY, legs: [
  leg({ name: 'Luz Bomba', reservationId: 'R1', auxProfileId: 'P1', phone: '300 000 0001' }),
  leg({ name: 'Kriss', reservationId: null, guestStopId: 'S9', guest: true, addr: 'Campus Reservado', lat: 6.1401, lng: -75.3902, phone: '300 555 0101', notes: 'Sin cuenta en la app: no le llegan avisos.', pickup: '05:00' }),
  { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.17, lng: -75.42 },
] }];
const stops = [], guest = [], unread = [], near = [], boards = [];
w.Api = {
  listMyVueltasForDriver: async () => JSON.parse(JSON.stringify(V)),
  getMyDriverProfileId: async () => 'DP1',
  driverSetStopStatus: async (rid, st) => { stops.push([rid, st]); },
  driverSetGuestStopStatus: async (sid, st) => { guest.push([sid, st]); },
  driverBoardWithCode: async (rid, code, sin) => { boards.push([rid, code, !!sin]); return { ok: true }; },
  countUnreadMessages: async (ids) => { unread.push(ids.slice()); return {}; },
  listReservationMessages: async () => [], markReservationMessagesRead: async () => 0,
  sendReservationMessage: async () => ({ notified: true }), sendDriverLocation: async () => {},
  driverMarkAirportArrival: async () => 1, driverAirportNoShow: async () => {}, driverAirportUndo: async () => 'no_show',
  driverNearStop: async (rid) => { near.push(rid); return true; },
};
w.state = { settings: { aux_wait_minutes: 5 }, profile: { role: 'driver' } };
w.eval(read('driver-rutas.js'));
const root = () => w.document.getElementById('driver-ruta-root');
await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Arango', role: 'driver' }); await wait(80);
const click = async (sel, ms = 80) => { const el = root().querySelector(sel); if (el) el.click(); await wait(ms); return !!el; };
const top = () => [...root().querySelectorAll('#rt-layers > .rx-layer:not(.out)')].pop();
const sheet = () => ((top() && top().querySelector('.rt-xs')) || { textContent: '' }).textContent.replace(/\s+/g, ' ');

console.log('\n── La vuelta con un sin cuenta ──');
await click('.rt-hero [data-rt="detail"][data-v="V1"]', 150);
const sts = [...root().querySelectorAll('#rt-layers .rt-stop')];
const txt = (e) => (e ? e.textContent.replace(/\s+/g, ' ') : '');
t('3 paradas: Luz, Kriss (con su lugar) y JMC', sts.length === 3 && /Kriss/.test(txt(sts[1])) && /Campus Reservado/.test(txt(sts[1])), sts.map(txt).join(' | ').slice(0, 200));
t('Kriss no tiene chat (Luz sí)', !!sts[0].querySelector('[data-rt="chat"]') && !sts[1].querySelector('[data-rt="chat"]'));
t('el conteo de mensajes no manda la llave del sin cuenta', unread.length > 0 && unread.every((ids) => !ids.some((x) => String(x).startsWith('g:'))) && unread.some((ids) => ids.includes('R1')), JSON.stringify(unread));

console.log('\n── Marcarla ──');
await click('#rt-layers .rx-foot [data-rt="start"]', 150);
await gps(6.1503, -75.3702);
await click('.rt-exec [data-rt="arrive"]', 120);
t('Luz: «Llegué» por la función de siempre (at_pickup R1)', stops.some((s) => s[0] === 'R1' && s[1] === 'at_pickup'));
await click('.rt-exec [data-rt="board"]', 200);
t('Luz a bordo → sigue Kriss', /Kriss/.test(sheet()), sheet().slice(0, 120));
t('«en camino» de Kriss va a SU parada (S9), no a una reserva', guest.some((g) => g[0] === 'S9' && g[1] === 'en_route') && !stops.some((s) => String(s[0]).startsWith('g:')), JSON.stringify([guest, stops]));
await gps(6.1402, -75.3903);
t('cerca de Kriss: no se le manda «estoy cerca» (no tiene la app); a Luz sí se le mandó', near.includes('R1') && !near.some((r) => String(r).startsWith('g:')), JSON.stringify(near));
await click('.rt-exec [data-rt="arrive"]', 120);
t('«Llegué» donde Kriss: driverSetGuestStopStatus(S9, at_pickup)', guest.some((g) => g[0] === 'S9' && g[1] === 'at_pickup'), JSON.stringify(guest));
t('en el punto dice que no tiene la app (no «ya sabe que llegaste»)', /no tiene la app: llámala si no sale/.test(sheet()) && !/Kriss ya sabe que llegaste/.test(sheet()) && /va sin cuenta en la app/.test(sheet()), sheet().slice(0, 200));
await click('.rt-exec [data-rt="board"]', 200);
t('«Kriss a bordo»: on_board a su parada', guest.some((g) => g[0] === 'S9' && g[1] === 'on_board') && !boards.some((b) => String(b[0]).startsWith('g:')), JSON.stringify([guest, boards]));
await gps(6.1701, -75.4201);
await click('.rt-exec [data-rt="arrive"]', 150);
await click('.rt-exec [data-rt="finish"]', 200);
t('en JMC se entregan los dos: Luz (R1) y Kriss (S9)', stops.some((s) => s[0] === 'R1' && s[1] === 'delivered') && guest.some((g) => g[0] === 'S9' && g[1] === 'delivered'), JSON.stringify([stops, guest]));
t('sin errores de script', errores.length === 0, errores.join(' | '));

console.log('\n── api.js de verdad: la base trae la parada sin reserva ──');
for (const sin0133 of [false, true]) {
  const d2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w2 = d2.window;
  const inicio = new Date(Date.now() + 3600000).toISOString();
  const RA = [{ id: 'ra1', direction: 'home_to_airport', planned_start_at: inicio, status: 'planned', route_stops: [
    { id: 'st1', stop_order: 1, reservation_id: 'R1', status: 'pending', actual_arrival_at: null, estimated_arrival_at: inicio, reservations: { pickup_address: 'El Olivar', pickup_latitude: 6.15, pickup_longitude: -75.37, required_arrival_at: inicio, calculated_pickup_at: inicio, notes: '', auxiliar_profiles: { profiles: { id: 'P1', full_name: 'Luz Bomba', phone: '300' } }, flights: null } },
    { id: 'st2', stop_order: 2, reservation_id: null, status: 'pending', actual_arrival_at: null, estimated_arrival_at: inicio, reservations: null }] }];
  const bld = (name) => {
    const st = { sel: '', isNull: false };
    const b2 = {
      select(x) { st.sel = String(x || ''); return b2; }, eq() { return b2; }, in() { return b2; }, gte() { return b2; }, lte() { return b2; }, order() { return b2; }, limit() { return b2; },
      is(c, v) { if (c === 'reservation_id' && v === null) st.isNull = true; return b2; }, maybeSingle() { st.one = true; return b2; }, single() { st.one = true; return b2; },
      then(ok2, ko) {
        let r = { data: [], error: null };
        if (name === 'driver_profiles') r = { data: st.one ? { id: 'DP1' } : [{ id: 'DP1' }], error: null };
        else if (name === 'route_assignments' && /route_stops\(/.test(st.sel)) r = { data: JSON.parse(JSON.stringify(RA)), error: null };
        else if (name === 'route_assignments') r = { data: [{ id: 'ra1', pool: true, deadline_at: null, manual_note: null }], error: null };
        else if (name === 'route_stops' && st.isNull) r = sin0133 ? { data: null, error: { code: '42703', message: 'column route_stops.guest_name does not exist' } }
          : { data: [{ id: 'st2', guest_name: 'Kriss', guest_place: 'Campus Reservado', guest_phone: '300 555 0101', guest_lat: 6.1401, guest_lng: -75.3902 }], error: null };
        else if (name === 'app_settings') r = { data: st.one ? { route_night_cutoff_min: 120 } : [], error: null };
        return Promise.resolve(r).then(ok2, ko);
      },
    };
    return b2;
  };
  w2.sb = { from: bld, rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } };
  w2.RENDIO_CONFIG = {};
  w2.eval(read('api.js'));
  const vs = await w2.Api.listMyVueltasForDriver('pD');
  const legs = (vs && vs[0] && vs[0].legs) || [];
  if (!sin0133) {
    const kr = legs.find((l) => l.guestStopId === 'st2');
    t('la parada sin reserva sale como «Kriss», con su lugar, teléfono, punto y la llave de la parada', kr && kr.name === 'Kriss' && kr.addr === 'Campus Reservado' && kr.phone === '300 555 0101' && kr.lat === 6.1401 && kr.guest === true && kr.reservationId === null && kr.kind === 'pickup', JSON.stringify(kr));
    t('…y Luz igual que siempre', legs[0] && legs[0].name === 'Luz Bomba' && legs[0].reservationId === 'R1' && !legs[0].guest);
  } else {
    t('base sin 0133: la ruta se lee igual (la parada rara queda como siempre, sin romper)', legs.length === 3 && legs[0].name === 'Luz Bomba', JSON.stringify(legs.map((l) => l.name)));
  }
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: la base (_verify-0133.mjs), el GPS real ni el teléfono.');
process.exit(bad ? 1 : 0);
