// PL · LÓGICA DEL AUXILIAR del rediseño (27-sep-2026).
//
// Prueba lo que PL llenó en auxiliar.js (plan final §2.7, §2.9, §3.7, §5 «PL»),
// con un AuxShell FALSO (espía) para el modo encendido y sin él para el de
// siempre:
//   · reloadTrips funde sobre los MISMOS objetos (driver/_info siguen, el estado
//     no retrocede, lo final gana, rated no vuelve a false, nuevos/quitados);
//   · «Ahora no» al calificar persiste (rateSkip) y no reaparece al recargar;
//   · goStep('nivel') deja nivel y pregunta el cupo; el nivel preferido (D19)
//     se preselecciona y se suelta si la camioneta está ocupada;
//   · un pendiente vencido no es «próximo» (un solo criterio, #20);
//   · share(t) por fase: en «asignado» no dice «Voy en camino» y no usa el ETA
//     de otro viaje (#19);
//   · el rastreo FUNDE (#6) y el HUD marca «llegó» y el código sin repintar (#5);
//   · la guarda del listener input (#9), atrás de a una cosa sin bucle con el
//     shell, candados con hoja (suspensión y pausa), avance solo del paso 1 a
//     los 260 ms, submit con prime() sincrónico, syncCta sin innerHTML, toasts.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no se ve que
// rxFlip/rxRise corran de verdad: solo que el nodo se RECREA), no hay Leaflet
// real (L no existe: el mapa no se monta), ni OSRM, ni Supabase (API falsa), ni
// push real, ni el shell real de P2 (se usa uno falso para aislar la lógica).
//
//   cd rendio-backend && node scripts/_smoke-pl-logica-dom.mjs
process.env.TZ = 'Europe/Madrid';   // el teléfono en OTRA zona
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = f => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; global.window = window; global.document = window.document;
window.RENDIO_CONFIG = {}; window.L = undefined;
const toasts = []; window.toast = (m) => toasts.push(m);
window.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Horas de prueba en Bogotá, relativas a AHORA.
const bogDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const bogHM = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const at = (ms) => { const d = new Date(Date.now() + ms); return { date: bogDay(d), time: bogHM(d) }; };
const H = 3600000;

// ── API falsa ──
let serverTrips = [];
let busyAsked = [], created = [], trackInfo = null;
const clone = (x) => JSON.parse(JSON.stringify(x));
window.Api = {
  listMyReservations: async () => clone(serverTrips),
  getMyAuxHeader: async () => ({ airlineName: 'Avianca', joinedAt: '2026-03-14', preferredLevel: null, meetingPoint: '' }),
  listResidences: async () => [], getMyAuxiliarPlace: async () => ({}),
  getSettings: async () => window.state.settings,
  notesUser: (n) => String(n || ''),
  privateBusyAt: async (iso) => { busyAsked.push(iso); return window.__busy === true; },
  createReservation: async (f) => { created.push(clone(f)); return 'srv' + created.length; },
  trackReservation: async () => trackInfo,
  listReservationMessages: async () => [],
};
window.state = { settings: { aux_min_lead_hours: 6, aux_private_enabled: true, aux_private_vehicle_id: 'v1', aux_private_price_cop: 1 } };
global.state = window.state;
for (const f of ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'aux-celebracion.js', 'auxiliar.js']) window.eval(read(f));
const A = window.Auxiliar;
const S = A.state;
const ui = () => window.document.getElementById('auxiliar-ui');
window.localStorage.setItem('rendio.aux.onboarded', '1');
if (window.AuxPresentacion && window.AuxPresentacion.markOnboarded) window.AuxPresentacion.markOnboarded();

// ── Shell FALSO (espía) ──
const shell = { onFlag: false, renders: 0, sheets: [], closed: 0, banners: [], toasts: [], pops: 0 };
function instalarShell() {
  window.AuxShell = {
    on: () => shell.onFlag,
    render: () => { shell.renders++; },
    toast: (m, ic) => shell.toasts.push([m, ic]),
    banner: (b) => shell.banners.push(b),
    sheet: (html, o) => {
      const host = window.document.createElement('div');
      host.className = 'rx-sheet'; host.innerHTML = html; ui().appendChild(host);
      shell.sheets.push({ html, host });
      if (o && typeof o.after === 'function') o.after(host);
      return host;
    },
    closeSheet: () => { shell.closed++; },
    // Como el de P2: si su pila está vacía llama a Auxiliar.back(). Si back()
    // lo llamara de vuelta, esto sería un bucle infinito.
    pop: () => { shell.pops++; if (shell.pops > 20) throw new Error('bucle pop↔back'); return !!A.back(); },
    ic: (n) => `<svg data-ic="${n}"></svg>`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── reloadTrips: fusión sobre los MISMOS objetos (§2.7) ──');
{
  const f1 = at(30 * H);
  serverTrips = [{ id: 'a', type: 'sal', ...f1, status: 'assigned', driver: null, rated: false, notes: '' }];
  await A.init({ id: 'p1', full_name: 'Laura Gómez', role: 'auxiliar' }); await wait(40);
  const obj = S.trips.find(x => x.id === 'a');
  obj.driver = { name: 'Pedro Pérez', plate: 'ABC123', phone: '300' };
  obj._info = { stop_status: 'pending' };
  obj.readyAt = '2026-09-27T10:00:00Z';
  const arr = S.trips;
  await A.reloadTrips();
  const obj2 = S.trips.find(x => x.id === 'a');
  t('mismo objeto después del refresco (el rastreo lo tiene agarrado)', obj2 === obj);
  t('mismo arreglo', S.trips === arr);
  t('driver.name sigue aunque el servidor lo trae null', obj2.driver && obj2.driver.name === 'Pedro Pérez');
  t('_info y readyAt siguen', !!obj2._info && obj2.readyAt === '2026-09-27T10:00:00Z');

  // El estado no retrocede
  obj.status = 'onway';
  serverTrips[0].status = 'assigned';
  await A.reloadTrips();
  t('el estado no retrocede (onway no vuelve a assigned)', obj.status === 'onway');
  serverTrips[0].status = 'cancelled';
  await A.reloadTrips();
  t('a cancelado sí (es final)', obj.status === 'cancelled');
  serverTrips[0].status = 'assigned';
  await A.reloadTrips();
  t('un final no se deshace', obj.status === 'cancelled');

  // rated
  serverTrips = [{ id: 'b', type: 'sal', ...at(-30 * H), status: 'done', rated: false, rating: 0, notes: '' }];
  await A.reloadTrips();
  const b = S.trips.find(x => x.id === 'b');
  b.rated = true; b.rating = 5;
  await A.reloadTrips();
  t('rated ya en true no vuelve a false (ni se borra la nota)', b.rated === true && b.rating === 5);
  t('lo que el servidor ya no trae se quita', !S.trips.some(x => x.id === 'a'));

  // El viaje abierto no desaparece
  S.editingTrip = 'b'; S.view = 'trip';
  serverTrips = [];
  await A.reloadTrips();
  t('el viaje abierto se queda aunque el servidor ya no lo traiga', S.trips.some(x => x.id === 'b'));
  S.editingTrip = null; S.view = 'home';

  // Conductor reasignado: la ficha se arma de cero
  serverTrips = [{ id: 'c', type: 'sal', ...at(20 * H), status: 'assigned', notes: '', driver: { name: 'Ana Ruiz', avatarUrl: 'x.png', phone: '1' } }];
  await A.reloadTrips();
  const c = S.trips.find(x => x.id === 'c');
  serverTrips[0].driver = { name: 'Beto Díaz', phone: null };
  await A.reloadTrips();
  t('conductor reasignado: no hereda la foto del anterior', c.driver.name === 'Beto Díaz' && !c.driver.avatarUrl);
  serverTrips[0].driver = { name: 'Beto Díaz', phone: '555', ratingN: 12 };
  c.driver.avatarUrl = 'b.png';
  await A.reloadTrips();
  t('mismo conductor: se funde campo a campo', c.driver.avatarUrl === 'b.png' && c.driver.phone === '555' && c.driver.ratingN === 12);

  // Uno a la vez
  let calls = 0; const orig = window.Api.listMyReservations;
  window.Api.listMyReservations = async () => { calls++; await wait(20); return clone(serverTrips); };
  await Promise.all([A.reloadTrips(), A.reloadTrips(), A.reloadTrips()]);
  t('tres refrescos a la vez = una sola consulta', calls === 1, String(calls));
  window.Api.listMyReservations = async () => null;
  const antes = S.trips.length;
  await A.reloadTrips();
  t('si falla un refresco se queda lo que había', S.trips.length === antes && S.source === 'live');
  window.Api.listMyReservations = orig;
  // ApiAux primero
  window.ApiAux = { listMyTrips: async () => [{ id: 'z', type: 'lle', ...at(40 * H), status: 'pending', notes: '' }] };
  await A.reloadTrips();
  t('usa ApiAux.listMyTrips si existe', S.trips.some(x => x.id === 'z'));
  window.ApiAux = { listMyTrips: async () => null };
  await A.reloadTrips();
  t('ApiAux sin RPC (null) → cae a Api.listMyReservations', S.trips.some(x => x.id === 'c'));
  delete window.ApiAux;
}

console.log('\n── «Ahora no» al calificar (rateSkip) ──');
{
  serverTrips = [{ id: 'r1', type: 'sal', ...at(-5 * H), status: 'done', rated: false, rating: 0, notes: '', driver: { name: 'Pedro Pérez' } }];
  await A.reloadTrips();
  const r = S.trips.find(x => x.id === 'r1');
  t('entregado sin calificar → toca calificar', A.showRate(r) === true);
  A.openTrip('r1'); await wait(10);
  t('sin shell: abre la pantalla de calificar', /Califica tu viaje/.test(ui().textContent));
  ui().querySelector('[data-ax="rate-skip"]').click(); await wait(10);
  t('«Ahora no» queda en localStorage', JSON.parse(window.localStorage.getItem('rendio.aux.rateSkip') || '[]').includes('r1'));
  t('el viaje NO queda calificado en memoria', r.rated === false);
  await A.init(S.profile); await wait(40);   // «recargar la app»
  const r2 = S.trips.find(x => x.id === 'r1');
  t('tras recargar, no reaparece', A.showRate(r2) === false && A.rateSkipped('r1'));
  A.openTrip('r1'); await wait(10);
  t('abrir el viaje muestra el detalle, no la calificación', !/Califica tu viaje/.test(ui().textContent));
  A.openTrip('r1', { rate: true }); await wait(10);
  t('openTrip(id,{rate:true}) sí la abre (desde el historial)', /Califica tu viaje/.test(ui().textContent) && !A.rateSkipped('r1'));
  S.view = 'home';
}

console.log('\n── un solo criterio de «próximo» (#20) ──');
{
  serverTrips = [
    { id: 'viejo', type: 'sal', ...at(-3 * 24 * H), status: 'pending', notes: '', address: 'Olivar, Rionegro' },
    { id: 'ayerTarde', type: 'sal', ...at(-5 * H), status: 'pending', notes: '', address: 'Olivar' },
    { id: 'semana', type: 'sal', ...at(6 * 24 * H), status: 'pending', notes: '', address: 'Olivar' },
    { id: 'manana', type: 'lle', ...at(20 * H), status: 'assigned', notes: '', address: 'Olivar' },
    { id: 'curso', type: 'sal', ...at(-9 * H), status: 'onway', notes: '', address: 'Olivar' },
  ];
  S.editingTrip = null;
  await A.init(S.profile); await wait(40);
  const up = A.upcoming().map(x => x.id);
  t('un pendiente de hace 3 días NO es próximo', !up.includes('viejo') && A.expired(S.trips.find(x => x.id === 'viejo')));
  t('dentro de las 6 h de gracia sigue próximo', up.includes('ayerTarde'));
  t('en curso es próximo aunque su hora pasó', up.includes('curso'));
  t('próximos ordenados por hora', up.indexOf('manana') < up.indexOf('semana'), up.join(','));
  t('el vencido está en el historial', A.past().some(x => x.id === 'viejo'));
  t('isUpcoming = lo que usa upcoming()', S.trips.every(x => A.isUpcoming(x) === up.includes(x.id)));
  S.view = 'home'; A.rerender();
  const hero = ui().querySelector('.ax-trip.hero');
  t('Inicio (heredado) no pone el vencido como «Próximo viaje»', hero && hero.dataset.id !== 'viejo', hero && hero.dataset.id);
  const card = [...ui().querySelectorAll('.ax-trip')].find(e => e.dataset.id === 'viejo');
  t('el vencido sale como «Sin realizar», no «Sin rutear»', card && /Sin realizar/.test(card.textContent));
}

console.log('\n── compartir por fase (#19) ──');
{
  const f = at(26 * H);
  const asig = { id: 's1', type: 'sal', ...f, status: 'assigned', driver: { name: 'Pedro Pérez', plate: 'ABC123' } };
  const txt1 = A.shareText(asig);
  t('asignado sin hora: «Tengo traslado a MDE … debo estar allá a las …»', /^Tengo traslado a MDE .+; debo estar allá a las \d\d:\d\d\.$/.test(txt1), txt1);
  t('asignado NO dice «Voy en camino»', !/Voy en camino/.test(txt1));
  const pub = new Date(Date.now() + 25 * H);
  const txt2 = A.shareText({ ...asig, pickupAt: pub.toISOString(), vehicle: { plate: 'XYZ987' } });
  t('asignado con hora: «Me recogen {día} a las HH:MM, carro PLACA.»', /^Me recogen (hoy|mañana|el .+) a las \d\d:\d\d, carro XYZ987\.$/.test(txt2) && txt2.includes(bogHM(pub)), txt2);
  // ETA de OTRO viaje no se usa
  S.etaTrip = 'otro'; S.etaKind = 'pickup'; S.etaSecs = 600; S.etaAt = Date.now();
  const txt3 = A.shareText({ ...asig, status: 'onway' });
  t('en camino sin ETA propio: «Mi conductor va por mí.»', txt3 === 'Mi conductor va por mí.', txt3);
  S.etaTrip = 's1';
  const txt4 = A.shareText({ ...asig, status: 'onway' });
  t('en camino con su ETA: «…, llega sobre las HH:MM (estimado).»', /^Mi conductor va por mí, llega sobre las \d\d:\d\d \(estimado\)\.$/.test(txt4), txt4);
  S.etaKind = 'dest';
  const txt5 = A.shareText({ ...asig, status: 'onboard' });
  t('a bordo: «Voy en camino al aeropuerto MDE, llego … Carro PLACA.»', /^Voy en camino al aeropuerto MDE, llego sobre las \d\d:\d\d \(estimado\)\. Carro ABC123\.$/.test(txt5), txt5);
  t('pendiente o cerrado: nada que compartir', A.shareText({ ...asig, status: 'pending' }) === null && A.shareText({ ...asig, status: 'done' }) === null);
  const lle = A.shareText({ ...asig, type: 'lle' });
  t('llegada asignada: habla de aterrizar, no de «estar allá»', /aterrizo a las/.test(lle), lle);
  S.etaTrip = null; S.etaSecs = null; S.etaAt = 0; S.etaKind = null;
  let shared = null; window.navigator.share = async (o) => { shared = o.text; };
  const r = await A.share(asig);
  t('share(t) comparte el texto de ESE viaje', r === true && shared === txt1);
  t('share de un pendiente no comparte nada', (await A.share({ ...asig, status: 'pending' })) === false);
}

console.log('\n── pasos del pedido: goStep, nivel y dirección (#18) ──');
{
  S.header = null; A.header = { preferredLevel: null };
  busyAsked = []; window.__busy = false;
  A.newTrip(); await wait(10);
  S.form.type = 'sal'; const f = at(30 * H); S.form.date = f.date; S.form.time = f.time;
  const ok1 = A.goStep('nivel');
  t('goStep(\'nivel\') entra al paso', ok1 === true && A.stepKind() === 'nivel');
  t('…con un nivel elegido', S.form.level === 'shared');
  await wait(10);
  t('…y pregunta el cupo de la camioneta', busyAsked.length === 1, String(busyAsked.length));
  t('la dirección queda registrada (fwd)', S.stepDir === 'fwd');
  A.goStep('vuelo');
  t('volver a un paso anterior = bwd', S.stepDir === 'bwd' && A.stepKind() === 'vuelo');
  t('goStep a un paso que no existe → false', A.goStep('nada') === false);

  // D19: nivel preferido privado
  A.header = { preferredLevel: 'private' };
  if (window.AuxPrivado.resetCupo) window.AuxPrivado.resetCupo();
  A.newTrip(); await wait(10);
  S.form.type = 'sal'; S.form.date = f.date; S.form.time = f.time;
  window.__busy = true;
  A.goStep('nivel'); await wait(20);
  t('D19: con «privado» preferido entra preseleccionado', S.form.levelAuto === true);
  A.rerender();
  t('…y si la camioneta está ocupada se suelta a compartido', S.form.level === 'shared', S.form.level);
  window.__busy = false; A.header = { preferredLevel: null };
  if (window.AuxPrivado.resetCupo) window.AuxPrivado.resetCupo();
}

console.log('\n── submit y prime() sincrónico (iOS) ──');
{
  let primes = 0, primeAntesDeCrear = null;
  window.AuxCelebracion.prime = () => { primes++; };
  const origCreate = window.Api.createReservation;
  window.Api.createReservation = async (fm) => { primeAntesDeCrear = primes; return origCreate(fm); };
  A.newTrip(); await wait(5);
  const f = at(30 * H);
  Object.assign(S.form, { type: 'sal', date: f.date, time: f.time, residenceId: 'r1', address: 'Olivar', level: 'shared', bags: 2 });
  const p = A.submit();
  t('submit() llama a prime() ANTES del primer await', primes === 1);
  await p; await wait(10);
  t('…y después crea la reserva', primeAntesDeCrear === 1 && created.length >= 1);
  const nuevo = S.trips.find(x => x.id === 'srv' + created.length);
  t('el viaje nuevo nace con la forma T (bags, sin hora ni código inventados)', nuevo && nuevo.bags === 2 && nuevo.pickupAt === null && nuevo.meetCode === null);
  A.newTrip(); await wait(5);
  Object.assign(S.form, { type: 'sal', date: f.date, time: f.time, residenceId: 'r1', address: 'Olivar', level: 'shared' });
  await A.submit({ primed: true });
  t('submit({primed:true}) no vuelve a llamar a prime()', primes === 1);
  window.Api.createReservation = origCreate;
  S.view = 'home';
}

console.log('\n── rastreo: fusiona (#6), fases y código sin repintar (#5) ──');
{
  instalarShell(); shell.onFlag = true;
  const f = at(1 * H);
  const tr = { id: 'tk', type: 'sal', ...f, status: 'onway', notes: '', meetCode: '4827', lat: 6.15, lng: -75.37,
    driver: { name: 'Pedro Pérez', plate: 'ABC123', phone: '300', avatarUrl: 'p.png', rating: 4.9, ratingN: 15 } };
  S.trips.length = 0; S.trips.push(tr);
  S.view = 'trip'; S.editingTrip = 'tk';
  ui().innerHTML = `<div class="rx-trip-big"><b id="ax-eta-min">En camino</b><span id="ax-eta-label">x</span></div>
    <div id="ax-phase">${A.phases(tr).steps.map(s => `<div class="rx-tl-s" data-ph="${s.key}"><i></i><span>${s.label}</span></div>`).join('')}</div>
    <div id="ax-meet" class="rx-meet"><div class="rx-meet-c"><b>4</b><b>8</b><b>2</b><b>7</b></div></div><i id="marca"></i>`;
  const meetC = ui().querySelector('.rx-meet-c');
  const bigAntes = ui().querySelector('.rx-trip-big');
  trackInfo = { assigned: true, raw_status: 'en_route', driver: { name: 'Pedro Pérez', phone: '' }, plate: 'ABC123',
    stop_status: 'pending', pos: { lat: 6.1, lng: -75.3, at: new Date().toISOString(), source: 'gps' } };
  const rendersAntes = shell.renders;
  await window.eval('auxTrackTick')(tr);
  t('el tic NO borra foto, calificación ni teléfono', tr.driver.avatarUrl === 'p.png' && tr.driver.rating === 4.9 && tr.driver.ratingN === 15 && tr.driver.phone === '300');
  t('…y llena t.vehicle.plate (conserva driver.plate)', tr.vehicle && tr.vehicle.plate === 'ABC123' && tr.driver.plate === 'ABC123');
  t('fase actual «En camino»', ui().querySelector('[data-ph="enroute"]').classList.contains('now') && ui().querySelector('[data-ph="assigned"]').classList.contains('done'));
  trackInfo = { ...trackInfo, stop_status: 'arrived', arrived_at: new Date().toISOString(), wait_minutes: 5 };
  await window.eval('auxTrackTick')(tr);
  t('«llegó»: la fase [data-ph="arrived"] queda actual', ui().querySelector('[data-ph="arrived"]').classList.contains('now'));
  t('«llegó»: #ax-meet resaltado', ui().querySelector('#ax-meet').classList.contains('is-arrived'));
  t('«llegó»: los dígitos se RECREAN (rxFlip vuelve a correr)', ui().querySelector('.rx-meet-c') !== meetC && ui().querySelector('.rx-meet-c').textContent === '4827');
  t('«llegó»: la hora grande dice «Llegó» + «Pedro te espera afuera»', ui().querySelector('#ax-eta-min').textContent === 'Llegó' && /Pedro te espera afuera/.test(ui().querySelector('#ax-eta-label').textContent));
  t('…y el bloque grande se recreó (key={st})', ui().querySelector('.rx-trip-big') !== bigAntes);
  t('sin repintar la capa (el shell no volvió a pintar, la marca sigue)', shell.renders === rendersAntes && !!ui().querySelector('#marca'));
  t('meetVisible en «llegó»', A.meetVisible(tr, trackInfo) === true);
  // conductor reasignado por el rastreo
  trackInfo = { ...trackInfo, driver: { name: 'Luis Mora', phone: '' } };
  await window.eval('auxTrackTick')(tr);
  t('reasignado en el rastreo: no hereda la foto del anterior', tr.driver.name === 'Luis Mora' && !tr.driver.avatarUrl);
  // v5: hora publicada y código nuevos → un repintado (patch del shell)
  const tr2 = { id: 'tk2', type: 'sal', ...f, status: 'assigned', notes: '', driver: { name: 'Pedro Pérez' } };
  S.trips.push(tr2); S.editingTrip = 'tk2';
  const r0 = shell.renders;
  trackInfo = { assigned: true, raw_status: 'assigned', driver: { name: 'Pedro Pérez' }, plate: 'ABC123', pickup_at: new Date(Date.now() + 30 * 60000).toISOString(), meet_code: '1234', vehicle: { brand: 'Renault', model: 'Kangoo', color: 'Blanca' } };
  await window.eval('auxTrackTick')(tr2);
  t('v5: toma pickup_at, meet_code y el carro', tr2.pickupAt && tr2.meetCode === '1234' && tr2.vehicle.color === 'Blanca');
  t('…y pide UN repintado al shell (patch)', shell.renders === r0 + 1);
  // fases de llegada
  const ph = A.phases({ type: 'lle', status: 'onboard' }, { remaining_before: 0 });
  t('llegada: 5 fases y «Rumbo a casa» sin paradas antes', ph.steps.length === 5 && ph.current === 'homebound');
  t('salida: 6 fases', A.phases({ type: 'sal', status: 'pending' }).steps.length === 6);
  window.eval('auxStopTrack')();
  S.view = 'home'; S.editingTrip = null;
}

console.log('\n── guarda del listener input (#9) ──');
{
  A.newTrip(); await wait(5);
  ui().innerHTML = `<div data-scr="book"><input data-field="notes" id="n1"></div><div data-scr="coord"><input data-field="notes" id="n2"></div>`;
  const fire = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  fire(ui().querySelector('#n2'), 'escrito en coordinación');
  t('un campo fuera del pedido NO escribe en auxState.form', S.form.notes !== 'escrito en coordinación');
  fire(ui().querySelector('#n1'), 'portería 3');
  t('un campo del pedido sí', S.form.notes === 'portería 3');
  shell.onFlag = false;
  fire(ui().querySelector('#n2'), 'sin shell');
  t('sin el rediseño la guarda no aplica (como siempre)', S.form.notes === 'sin shell');
  shell.onFlag = true;
  // clic de un campo del pedido fuera del pedido
  ui().innerHTML = `<div data-scr="me"><button data-ax="toggle" data-key="isPernocta" id="tg"></button></div>`;
  const antes = !!S.form.isPernocta;
  ui().querySelector('#tg').click();
  t('un toggle fuera del pedido no toca el pedido', !!S.form.isPernocta === antes);
}

console.log('\n── pie del pedido sin innerHTML (#17) ──');
{
  A.newTrip(); await wait(5);
  ui().innerHTML = `<div data-scr="book"><div class="ax-cta-bar"><div class="rx-slide" id="sl"></div></div><input data-field="time" id="tm"></div>`;
  const sl = ui().querySelector('#sl');
  A.syncCta();
  t('sin AuxRxPedir.syncCta: el deslizador NO se rehace y queda apagado (paso 1 sin tipo)', ui().querySelector('#sl') === sl && sl.classList.contains('off') && sl.getAttribute('aria-disabled') === 'true');
  let visto = null;
  window.AuxRxPedir = { syncCta: (el) => { visto = el || 'sin-el'; } };
  const tm = ui().querySelector('#tm'); tm.value = '05:10'; tm.dispatchEvent(new window.Event('input', { bubbles: true }));
  t('con AuxRxPedir.syncCta: el input se lo pasa con el campo', visto === tm);
  const cs = A.ctaState();
  t('ctaState() trae la regla como dato', typeof cs.disabled === 'boolean' && cs.kind === 'tipo' && cs.label === 'Continuar');
  delete window.AuxRxPedir;
}

console.log('\n── avance solo del paso 1 a los 260 ms ──');
{
  A.newTrip(); await wait(5);
  ui().innerHTML = `<div data-scr="book"><button data-ax="type" data-type="sal" id="ty"></button></div>`;
  ui().querySelector('#ty').click();
  t('con el rediseño: marca el tipo y todavía no avanza', S.form.type === 'sal' && A.stepKind() === 'tipo');
  await wait(200);
  t('…a los 200 ms sigue en el paso 1', A.stepKind() === 'tipo');
  await wait(90);
  t('…a los 260 ms avanza (fwd)', A.stepKind() === 'vuelo' && S.stepDir === 'fwd');
  shell.onFlag = false;
  A.newTrip(); await wait(5);
  ui().querySelector('[data-ax="type"][data-type="sal"]').click();
  await wait(300);
  t('sin el rediseño: no avanza solo (el «Continuar» de siempre)', A.stepKind() === 'tipo');
  shell.onFlag = true;
}

console.log('\n── atrás de a UNA cosa, sin bucle con el shell ──');
{
  const tr = { id: 'bk', type: 'sal', ...at(20 * H), status: 'assigned', notes: '', driver: { name: 'Pedro Pérez' } };
  S.trips.push(tr);
  A.openTrip('bk');
  S.alarm = { motivo: null }; S.confirmingCancel = true; S.chatOpen = true;
  t('1º cierra la alarma', A.back() === true && S.alarm === null && S.confirmingCancel === true);
  t('2º la confirmación de cancelar', A.back() === true && S.confirmingCancel === false && S.chatOpen === true);
  t('3º el chat', A.back() === true && S.chatOpen === false && S.view === 'trip');
  t('4º el viaje vuelve a la pestaña de la que vino', A.back() === true && S.view === 'home');
  S.tab = 'viajes'; S.view = 'viajes';
  shell.pops = 0;
  let r; try { r = window.AuxShell.pop(); } catch (e) { r = e.message; }
  t('AuxShell.pop() (que llama a back) no entra en bucle', r === true && shell.pops === 1, String(r));
  t('…y una pestaña ≠ Inicio vuelve a Inicio', S.view === 'home' && S.tab === 'inicio');
  t('en Inicio sin nada abierto: false', A.back() === false);
  A.newTrip(); await wait(5); S.form.type = 'sal'; A.goStep('vuelo');
  t('en el pedido: un paso atrás (bwd)', A.back() === true && A.stepKind() === 'tipo' && S.stepDir === 'bwd');
  t('en el paso 1: cierra el pedido', A.back() === true && S.view === 'home');
}

console.log('\n── candados con hoja: suspensión y pausa por no pago ──');
{
  shell.sheets = []; shell.closed = 0;
  S.profile.is_active = false; S.profile.suspended_reason = 'Documentos vencidos';
  t('suspendido: newTrip() no abre el pedido', A.newTrip() === false && S.view === 'home');
  const sh = shell.sheets[shell.sheets.length - 1];
  t('…y abre la HOJA (no un toast) con el texto honesto', sh && /Tu cuenta está suspendida/.test(sh.html) && /siguen en pie/.test(sh.html) && /Documentos vencidos/.test(sh.html));
  t('…con la estructura del diseño (.rx-sh, .rx-sh-ic.blk, .rx-btn)', sh && /class="rx-sh"/.test(sh.html) && /rx-sh-ic blk/.test(sh.html) && /rx-btn ghost/.test(sh.html));
  sh.host.querySelector('[data-pl-lock="close"]').click();
  t('«Entendido» cierra la hoja', shell.closed === 1);
  S.profile.is_active = true;
  window.AuxPagos = { paused: () => true, summary: () => ({ status: 'bloqueado', amountCOP: 0, dueISO: null }) };
  shell.sheets = [];
  ui().innerHTML = '<button data-ax="new" id="nv"></button>';
  ui().querySelector('#nv').click();
  const sp = shell.sheets[0];
  t('pausado: el + abre la hoja «Tus reservas están pausadas»', sp && /Tus reservas están pausadas/.test(sp.html) && S.view !== 'form');
  t('sin monto cargado no se inventa ninguno', sp && !/\$\s?\d/.test(sp.html));
  sp.host.querySelector('[data-pl-lock="pay"]').click();
  t('«Ir a pagos» cierra y todavía no cambia de pestaña', shell.closed === 2 && S.tab !== 'pagos');
  await wait(240);
  t('…a los 230 ms va a Pagos (view home + tab pagos, como lee el shell)', S.tab === 'pagos' && S.view === 'home');
  delete window.AuxPagos;
  shell.onFlag = false; toasts.length = 0;
  S.profile.is_active = false;
  A.newTrip();
  t('sin el rediseño: el toast de siempre', /suspendida/.test(toasts[0] || ''));
  S.profile.is_active = true; shell.onFlag = true;
}

console.log('\n── avisos de cambios que el shell no ve ──');
{
  shell.banners = [];
  S.view = 'home'; S.tab = 'inicio';
  serverTrips = [{ id: 'pv', type: 'sal', ...at(30 * H), status: 'pending', notes: '', level: 'private', privateStatus: 'requested' }];
  await A.reloadTrips();
  serverTrips[0].privateStatus = 'approved';
  await A.reloadTrips();
  t('privado aprobado → un aviso', shell.banners.length === 1 && /privado quedó confirmado/.test(shell.banners[0].title));
  await A.reloadTrips();
  t('el mismo cambio no se avisa dos veces', shell.banners.length === 1);
  serverTrips[0].status = 'assigned';
  await A.reloadTrips();
  t('un cambio de ESTADO lo avisa el shell, no PL', shell.banners.length === 1);
  serverTrips[0].pickupAt = new Date(Date.now() + 29 * H).toISOString();
  await A.reloadTrips();
  const last = shell.banners[shell.banners.length - 1];
  t('hora publicada con el viaje ya asignado → «Ya tienes hora de recogida»', shell.banners.length === 2 && /hora de recogida/.test(last.title) && /a las \d\d:\d\d/.test(last.body));
  t('el aviso abre ese viaje', typeof last.go === 'function');
  await A.reloadTrips({ silent: true });
  serverTrips[0].privateStatus = 'rejected';
  await A.reloadTrips({ silent: true });
  t('silent: sin avisos', shell.banners.length === 2);
  t('lastChanges queda como dato para el shell', Array.isArray(S.lastChanges) && S.lastChanges.some(c => c.kind === 'private'));
}

console.log('\n── toasts y textos ──');
{
  shell.toasts = []; toasts.length = 0;
  window.eval('auxToast')('hola', 'Copy');
  t('con el rediseño: AuxShell.toast(msg, icon)', shell.toasts.length === 1 && shell.toasts[0][1] === 'Copy' && toasts.length === 0);
  shell.onFlag = false;
  window.eval('auxToast')('hola');
  t('sin él: el toast de core', toasts.length === 1);
  // Barrido de textos prohibidos en lo que PL escribe
  const src = read('auxiliar.js');
  const pl = src.slice(src.indexOf('function auxLockNotice'), src.indexOf('function auxCloseSheet'))
    + src.slice(src.indexOf('function auxShareText'), src.indexOf('function auxPlate'))
    + src.slice(src.indexOf('function auxBannerFor'), src.indexOf('// ---------- eventos ----------'))
    + src.slice(src.indexOf('function auxHeroRx'), src.indexOf('function auxUpdateTrackHUD'));
  const PROHIBIDOS = [/\$\s?\d/, /150\.000/, /Carlos/, /AV9525/, /Juliana/, /Plan B/, /24\/7/, /en línea/i, /Último cupo/, /Siempre hay cupo/, /\bkit\b/i, /Preparado/];
  const hallados = PROHIBIDOS.filter(r => r.test(pl)).map(String);
  t('ningún texto prohibido en hojas, compartir, avisos ni hora grande', hallados.length === 0, hallados.join(' '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout, animación real (solo que el nodo se recrea), Leaflet/OSRM reales, Supabase real, push real y el shell real de P2.');
process.exit(bad ? 1 : 0);
