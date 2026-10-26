// App del conductor (driver-rutas.js y api.js DE VERDAD): «Iniciar ruta» manda el
// aviso «X inició una vuelta» a los jefes (0136) — prueba jsdom.
//
// Comprueba:
//   · salida: «Iniciar ruta» llama driverRouteStarted con el id de la vuelta, una
//     vez, junto al «en camino» de la primera recogida de siempre;
//   · llegada (antes no escribía nada al iniciar): también la llama;
//   · volver a abrir la ruta ya iniciada y entrar otra vez no la repite;
//   · si la base la rechaza, al conductor no le sale «No se pudo guardar» y la ruta
//     arranca igual; sin señal va a la cola y sale al volver la red; si en la cola
//     la rechazan, tampoco hay aviso de error;
//   · api.js llama la RPC driver_route_started con p_route_assignment_id.
//
// NO cubre: la base (_verify-0136.mjs), la push de verdad ni el teléfono.
//
//   cd rendio-backend && node scripts/_smoke-aviso-inicio-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Cra 1 #2-3', unit: '', flight: '', dl: '05:30', phone: '',
  notes: '', bags: null, quiet: false, meetCode: '', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '04:50', eta: '' }, o);
const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
const SALIDA = { id: 'V1', type: 'sal', start: '04:40', startAt: HOY + 'T04:40:00-05:00', done: false, assignmentId: 'RA1', day: HOY, legs: [
  leg({ name: 'Luz Bomba', reservationId: 'R1', auxProfileId: 'P1' }),
  leg({ name: 'Sara Ríos', reservationId: 'R2', auxProfileId: 'P2', pickup: '05:00' }), APT] };
const LLEGADA = { id: 'V1', type: 'lle', start: '12:00', startAt: HOY + 'T12:00:00-05:00', done: false, assignmentId: 'RA2', day: HOY, legs: [APT,
  leg({ kind: 'dropoff', name: 'Henry Cano', reservationId: 'R3', auxProfileId: 'P3', pickup: '', dl: '' })] };

// Una ventana nueva con la app del conductor. `ini` decide qué contesta la base.
function boot(V, ini, storage) {
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
  if (storage) Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  w.Api = {
    listMyVueltasForDriver: async () => JSON.parse(JSON.stringify([V])),
    getMyDriverProfileId: async () => 'DP1',
    driverSetStopStatus: async (rid, st) => { stops.push([rid, st]); },
    driverRouteStarted: async (ra) => { avisos.push(ra); return ini.fn(ra); },
    driverSetGuestStopStatus: async () => {}, driverBoardWithCode: async () => ({ ok: true }),
    countUnreadMessages: async () => ({}), listReservationMessages: async () => [], markReservationMessagesRead: async () => 0,
    sendReservationMessage: async () => ({ notified: true }), sendDriverLocation: async () => {},
    driverMarkAirportArrival: async () => 1, driverAirportNoShow: async () => {}, driverAirportUndo: async () => 'no_show',
    driverNearStop: async () => true,
  };
  w.state = { settings: { aux_wait_minutes: 5 }, profile: { role: 'driver' } };
  w.eval(read('driver-rutas.js'));
  const root = () => w.document.getElementById('driver-ruta-root');
  const click = async (sel, ms = 80) => { const el = root().querySelector(sel); if (el) el.click(); await wait(ms); return !!el; };
  const toastTxt = () => { const h = w.document.getElementById('rt-toast-host'); return ((h && h.textContent) || '') + ' ' + toasts.join(' '); };
  const abrir = async () => { await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Arango', role: 'driver' }); await wait(80); };
  const iniciar = async () => { await click('.rt-hero [data-rt="detail"][data-v="V1"]', 150); return click('#rt-layers .rx-foot [data-rt="start"]', 150); };
  const enRuta = () => !!root().querySelector('.rt-exec');
  return { w, errores, avisos, stops, toastTxt, abrir, iniciar, enRuta, click };
}
const siempre = (r) => ({ fn: async () => r });

console.log('\n── Salida ──');
let A = boot(SALIDA, siempre(true));
await A.abrir();
t('antes de tocar nada no se avisa', A.avisos.length === 0);
const tocado = await A.iniciar();
t('«Iniciar ruta»: driverRouteStarted(RA1) una vez', tocado && A.avisos.length === 1 && A.avisos[0] === 'RA1', JSON.stringify(A.avisos));
t('…y el «en camino» de la primera recogida, como siempre', A.stops.some((s) => s[0] === 'R1' && s[1] === 'en_route'), JSON.stringify(A.stops));
t('la ruta arranca (pantalla de ejecución, «Ruta iniciada»)', A.enRuta() && /Ruta iniciada/.test(A.toastTxt()), A.toastTxt());
t('sin errores de script', A.errores.length === 0, A.errores.join(' | '));
const guardado = {};
for (let i = 0; i < A.w.localStorage.length; i++) { const k = A.w.localStorage.key(i); guardado[k] = A.w.localStorage.getItem(k); }
A.w.DriverRutas.close();

console.log('\n── Volver a abrirla ──');
const B = boot(SALIDA, siempre(true), guardado);
await B.abrir();
await B.click('.rt-hero [data-rt="detail"][data-v="V1"]', 150);
await B.click('#rt-layers .rx-foot [data-rt="start"]', 150);
t('la ruta ya iniciada (guardada en el teléfono) no vuelve a avisar', B.avisos.length === 0 && B.enRuta(), JSON.stringify(B.avisos));

console.log('\n── Llegada ──');
const C = boot(LLEGADA, siempre(true));
await C.abrir();
await C.iniciar();
t('llegada: «Iniciar ruta» también avisa (RA2); antes no escribía nada', C.avisos.length === 1 && C.avisos[0] === 'RA2', JSON.stringify(C.avisos));
t('…y no marca ninguna parada (eso es «Llegué al aeropuerto»)', C.stops.length === 0, JSON.stringify(C.stops));
t('sin errores de script', C.errores.length === 0, C.errores.join(' | '));

console.log('\n── Si la base lo rechaza ──');
const D = boot(SALIDA, { fn: async () => { throw Object.assign(new Error('solo un conductor puede iniciar una vuelta'), { code: '42501' }); } });
await D.abrir();
await D.iniciar();
t('rechazado: la ruta arranca igual y no sale «No se pudo guardar»', D.enRuta() && D.avisos.length === 1 && !/No se pudo guardar|No se guardó/.test(D.toastTxt()), D.toastTxt());

console.log('\n── Sin señal ──');
let red = false;
const E = boot(SALIDA, { fn: async () => { if (!red) throw new TypeError('Failed to fetch'); return true; } });
await E.abrir();
await E.iniciar();
const cola = () => { try { return JSON.parse(E.w.localStorage.getItem('rendio-rt-v2-cola-pD') || '[]'); } catch (e) { return []; } };
t('sin red: el aviso queda en la cola del teléfono', cola().some((op) => op.f === 'ini' && op.ra === 'RA1'), JSON.stringify(cola()));
red = true;
E.w.dispatchEvent(new E.w.Event('online')); await wait(150);
t('vuelve la red: sale (segunda llamada con RA1) y la cola queda vacía', E.avisos.length >= 2 && E.avisos[E.avisos.length - 1] === 'RA1' && !cola().some((op) => op.f === 'ini'), JSON.stringify([E.avisos, cola()]));

const F = boot(SALIDA, { fn: async () => { if (!red) throw new TypeError('Failed to fetch'); throw new Error('Could not find the function public.driver_route_started'); } });
red = false;
await F.abrir();
await F.iniciar();
red = true;
F.w.dispatchEvent(new F.w.Event('online')); await wait(150);
const colaF = (() => { try { return JSON.parse(F.w.localStorage.getItem('rendio-rt-v2-cola-pD') || '[]'); } catch (e) { return []; } })();
t('en la cola y luego rechazado (base sin 0136): sin aviso de error y sale de la cola', !/No se guardó/.test(F.toastTxt()) && !colaF.some((op) => op.f === 'ini'), JSON.stringify([F.toastTxt(), colaF]));

console.log('\n── api.js de verdad ──');
const d2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
const w2 = d2.window;
const rpcs = [];
w2.sb = { from: () => ({}), rpc: async (fn, args) => { rpcs.push([fn, args]); return { data: rpcs.length === 1, error: null }; },
  auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } };
w2.RENDIO_CONFIG = {};
w2.eval(read('api.js'));
const r1 = await w2.Api.driverRouteStarted('RA9'), r2 = await w2.Api.driverRouteStarted('RA9');
t('Api.driverRouteStarted → rpc driver_route_started { p_route_assignment_id }', rpcs[0] && rpcs[0][0] === 'driver_route_started' && rpcs[0][1].p_route_assignment_id === 'RA9', JSON.stringify(rpcs[0]));
t('devuelve true/false según la base', r1 === true && r2 === false, JSON.stringify([r1, r2]));
w2.sb.rpc = async () => ({ data: null, error: { message: 'boom' } });
let lanzo = false; try { await w2.Api.driverRouteStarted('RA9'); } catch (e) { lanzo = /boom/.test(e.message); }
t('un error de la base se lanza (driver-rutas decide qué hacer)', lanzo);

const sw = read('sw.js');
t('SW v222 o posterior', Number((/rendio-turnos-v(\d+)/.exec(sw) || [])[1]) >= 222, (/rendio-turnos-v\d+/.exec(sw) || [])[0]);

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: la base (_verify-0136.mjs), la push de verdad ni el teléfono.');
process.exit(bad ? 1 : 0);
