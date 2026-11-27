// App del conductor (driver-rutas.js DE VERDAD): el «entregado» es obligatorio
// (26-nov-2026) — prueba jsdom.
//
// Caso real del 25-nov: vuelta de las 10:30 con dos a bordo (10:35 y 10:45) que nunca
// se entregaron, y a las 11:25 el conductor inició la siguiente desde «Más tarde».
// Esa gente quedó «en curso» en la app del tripulante para siempre.
//
// Comprueba:
//   · con otra vuelta abierta y gente a bordo, «Iniciar ruta» NO arranca la nueva:
//     sale «¿Ya entregaste la vuelta de las 10:30?» con los nombres;
//   · «Ir a esa vuelta» lleva a la abierta sin escribir nada;
//   · «Sí, ya están en JMC» entrega a los de a bordo (delivered) y SOLO entonces
//     arranca la nueva (aviso de inicio + «en camino» de su primera recogida);
//   · con alguien sin marcar en la abierta no hay atajo: «Primero termina…»;
//   · sin vuelta abierta (o una arrancada sin nadie pendiente) arranca como siempre.
//
// NO cubre: la base, la push de verdad ni el teléfono.
//
//   cd rendio-backend && node scripts/_smoke-entregado-obligatorio-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Cra 1 #2-3', unit: '', flight: '', dl: '11:30', phone: '',
  notes: '', bags: null, quiet: false, meetCode: '', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '10:35', eta: '' }, o);
const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
// La vuelta de las 10:30: Luz y Sara según `st` (estado de la parada en la base).
const V1 = (st1, st2) => ({ id: 'V1', type: 'sal', start: '10:30', startAt: HOY + 'T10:30:00-05:00', done: false, assignmentId: 'RA1', day: HOY, legs: [
  leg({ name: 'Luz Bomba', reservationId: 'R1', auxProfileId: 'P1', stopStatus: st1 }),
  leg({ name: 'Sara Ríos', reservationId: 'R2', auxProfileId: 'P2', pickup: '10:45', stopStatus: st2 }), APT] });
// La siguiente, de las 11:25, sin tocar.
const V2 = { id: 'V2', type: 'sal', start: '11:25', startAt: HOY + 'T11:25:00-05:00', done: false, assignmentId: 'RA2', day: HOY, legs: [
  leg({ name: 'Henry Cano', reservationId: 'R3', auxProfileId: 'P3', pickup: '11:25' }), APT] };

function boot(vueltas) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [], avisos = [], stops = [], toasts = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  w.console.warn = () => {}; w.console.error = () => {};
  w.RENDIO_CONFIG = {}; w.toast = (m) => toasts.push(m); w.L = undefined;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.alert = () => {}; w.confirm = () => true;
  w.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition() { return 1; }, clearWatch() {} } });
  w.Api = {
    listMyVueltasForDriver: async () => JSON.parse(JSON.stringify(vueltas)),
    getMyDriverProfileId: async () => 'DP1',
    driverSetStopStatus: async (rid, st) => { stops.push([rid, st]); },
    driverRouteStarted: async (ra) => { avisos.push(ra); return true; },
    driverSetGuestStopStatus: async () => {}, driverBoardWithCode: async () => ({ ok: true }),
    countUnreadMessages: async () => ({}), listReservationMessages: async () => [], markReservationMessagesRead: async () => 0,
    sendReservationMessage: async () => ({ notified: true }), sendDriverLocation: async () => {},
    driverMarkAirportArrival: async () => 1, driverAirportNoShow: async () => {}, driverAirportUndo: async () => 'no_show',
    driverNearStop: async () => true,
  };
  w.state = { settings: { aux_wait_minutes: 5 }, profile: { role: 'driver' } };
  w.eval(read('aux-rx-ui.js'));   // las hojas (RxSheet) del conductor
  w.eval(read('driver-rutas.js'));
  const doc = w.document;
  const root = () => doc.getElementById('driver-ruta-root');
  const q = (sel) => doc.querySelector(sel);
  const click = async (el, ms = 120) => { if (el) el.click(); await wait(ms); return !!el; };
  const sheet = () => q('#rt-sheet-host');
  const sheetTxt = () => ((sheet() && sheet().textContent) || '').replace(/\s+/g, ' ');
  const toastTxt = () => { const h = doc.getElementById('rt-toast-host'); return ((h && h.textContent) || '') + ' ' + toasts.join(' '); };
  const abrir = async () => { await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Arango', role: 'driver' }); await wait(100); };
  // Desde «Más tarde» (o la tarjeta grande): abrir la de las 11:25 y tocar «Iniciar ruta».
  const iniciarV2 = async () => {
    await click(root().querySelector('[data-rt="detail"][data-v="V2"]'), 150);
    return click(q('#rt-layers .rx-foot [data-rt="start"][data-v="V2"]'), 150);
  };
  const enRuta = (vid) => !!root().querySelector('.rt-exec') && (!vid || !!root().querySelector(`.rt-exec [data-v="${vid}"]`));
  return { w, errores, avisos, stops, toastTxt, sheet, sheetTxt, q, click, abrir, iniciarV2, enRuta };
}

console.log('\n── Vuelta de las 10:30 con dos a bordo ──');
let A = boot([V1('picked_up', 'picked_up'), V2]);
await A.abrir();
t('la de las 11:25 se puede abrir desde la lista', !!A.w.document.querySelector('#driver-ruta-root [data-rt="detail"][data-v="V2"]'));
const tocoA = await A.iniciarV2();
t('«Iniciar ruta» de la 11:25: sale «¿Ya entregaste la vuelta de las 10:30?»', tocoA && /¿Ya entregaste la vuelta de las 10:30\?/.test(A.sheetTxt()), A.sheetTxt());
t('…con los dos nombres a bordo', /a bordo a Luz y Sara/.test(A.sheetTxt()), A.sheetTxt());
t('…y la 11:25 NO arrancó (ni aviso de inicio ni «en camino» de Henry)', !A.avisos.includes('RA2') && !A.stops.some((s) => s[0] === 'R3'), JSON.stringify([A.avisos, A.stops]));
t('…ni se marcó nada de la 10:30 todavía', !A.stops.some((s) => s[0] === 'R1' || s[0] === 'R2'), JSON.stringify(A.stops));
await A.click(A.q('#rt-sheet-host [data-rt="cerrar-ir"]'), 150);
t('«Ir a esa vuelta» lleva a la de las 10:30, sin escribir nada', A.enRuta('V1') && A.stops.length === 0 && A.avisos.length === 0, JSON.stringify([A.stops, A.avisos, A.w.document.querySelector('.rt-exec') ? 'exec' : 'sin exec']));
t('sin errores de script', A.errores.length === 0, A.errores.join(' | '));

console.log('\n── «Sí, ya están en JMC» ──');
const B = boot([V1('picked_up', 'picked_up'), V2]);
await B.abrir();
await B.iniciarV2();
const si = B.q('#rt-sheet-host [data-rt="cerrar-yes"]');
t('el botón dice «Sí, ya están en JMC»', si && /Sí, ya están en JMC/.test(si.textContent), si && si.textContent);
await B.click(si, 200);
t('entrega a Luz y a Sara (delivered)', B.stops.some((s) => s[0] === 'R1' && s[1] === 'delivered') && B.stops.some((s) => s[0] === 'R2' && s[1] === 'delivered'), JSON.stringify(B.stops));
t('…y SOLO entonces arranca la 11:25 (aviso RA2 + «en camino» de Henry)', B.avisos.includes('RA2') && B.stops.some((s) => s[0] === 'R3' && s[1] === 'en_route')
  && B.stops.findIndex((s) => s[0] === 'R3') > B.stops.findIndex((s) => s[0] === 'R2'), JSON.stringify([B.avisos, B.stops]));
t('queda en ruta con la 11:25 («Ruta iniciada»)', B.enRuta('V2') && /Ruta iniciada/.test(B.toastTxt()), B.toastTxt());
t('sin errores de script', B.errores.length === 0, B.errores.join(' | '));

console.log('\n── Uno a bordo y otro sin marcar ──');
const C = boot([V1('picked_up', 'pending'), V2]);
await C.abrir();
await C.iniciarV2();
t('«Primero termina la vuelta de las 10:30»', /Primero termina la vuelta de las 10:30/.test(C.sheetTxt()), C.sheetTxt());
t('…dice a quién falta marcar y quién va a bordo', /Te falta marcar a Sara y todavía tienes a bordo a Luz/.test(C.sheetTxt()), C.sheetTxt());
t('…sin atajo para darla por entregada', !C.q('#rt-sheet-host [data-rt="cerrar-yes"]') && !!C.q('#rt-sheet-host [data-rt="cerrar-ir"]'));
t('…y nada arrancó ni se marcó', C.avisos.length === 0 && C.stops.length === 0, JSON.stringify([C.avisos, C.stops]));

console.log('\n── Sin vuelta abierta: como siempre ──');
const D = boot([V1('delivered', 'delivered'), V2]);
await D.abrir();
await D.iniciarV2();
t('la 10:30 ya entregada: la 11:25 arranca directo, sin hoja', !/entregaste|Primero termina/.test(D.sheetTxt()) && D.avisos.includes('RA2') && D.enRuta('V2'), JSON.stringify([D.sheetTxt(), D.avisos]));
const E = boot([V1('no_show', 'no_show'), V2]);
await E.abrir();
await E.iniciarV2();
t('la 10:30 con los dos «no se presentó» (nadie a bordo ni sin marcar): tampoco frena', !/entregaste|Primero termina/.test(E.sheetTxt()) && E.avisos.includes('RA2'), JSON.stringify([E.sheetTxt(), E.avisos]));
const F = boot([V2]);
await F.abrir();
await F.iniciarV2();
t('una sola vuelta: arranca como siempre', F.avisos.includes('RA2') && F.enRuta('V2'), JSON.stringify(F.avisos));
t('sin errores de script', [D, E, F].every((x) => x.errores.length === 0), [D, E, F].map((x) => x.errores.join(' | ')).join(' / '));

const sw = read('sw.js');
t('SW v282 o posterior', Number((/rendio-turnos-v(\d+)/.exec(sw) || [])[1]) >= 282, (/rendio-turnos-v\d+/.exec(sw) || [])[0]);

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: la base, la push de verdad ni el teléfono.');
process.exit(bad ? 1 : 0);
