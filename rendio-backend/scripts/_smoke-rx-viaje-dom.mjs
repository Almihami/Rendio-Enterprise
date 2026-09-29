// P4 · Viaje en vivo y calificar (rediseño del auxiliar, 27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + api.js + api-aux.js + aux-rx-ui.js + aux-shell.js
// + aux-rx-viaje.js + auxiliar.js) con la bandera del rediseño ENCENDIDA, el
// Leaflet FALSO (fixtures/fake-leaflet.js) y los escenarios de P9
// (fixtures/aux-escenarios.js). El rastreo de 6 s se acelera a 90 ms y el sondeo
// del chat de 5 s a 70 ms.
//
// Aceptación de P4 (plan final §5) y lo de §3.7:
//   · todos los ids de §2.4 del viaje en «en camino» y «a bordo» (una sola vez);
//   · 6 fases en salida y 5 en llegada (#ax-phase > .rx-tl-s[data-ph]);
//   · #ax-meet según meetVisible, y resaltado cuando el HUD recibe
//     stop_status:'arrived' SIN repintar la capa (mismo nodo, mismo mapa);
//   · sin pos no hay .rx-lf-car; con pos sí;
//   · ★ oculta con ratingN < 10, visible con 37;
//   · cancelar no menciona puntos ni «2 horas»; hoja en .rx-sheet-host por patch;
//   · el admin en el hilo sale como «Coordinación»;
//   · abrir la alarma no destruye el mapa falso (patch, sin stopTrack);
//   · compartir solo en asignado con hora, en camino y a bordo;
//   · calificar: estrellas y etiquetas por patch, key={s} del texto, enviar →
//     Api.rateReservation + «gracias» honesto; «Ahora no» → «Calificar a {first}»;
//   · un cambio de estado repinta y RECREA .rx-trip-big (key={st});
//   · sin textos prohibidos del diseño en ninguna pantalla;
//   · con la bandera APAGADA, el viaje sigue saliendo con la UI de siempre.
//
// NO CUBRE: layout (jsdom no mide: no prueba que el mapa quede detrás de la hoja,
// ni el :has() de «Sin ubicación todavía», ni tamaños), animaciones reales (solo
// que la clase/nodo correcto exista), Leaflet real (tiles, OSRM, invalidateSize),
// navigator.share, tel:, push real, ni el teléfono de verdad.
//
//   cd rendio-backend && node scripts/_smoke-rx-viaje-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIXD = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const readFix = (f) => readFileSync(FIXD + f, 'utf8');
let ok = 0, fail = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const PROHIBIDOS = ['Carlos', 'Mejía', 'AV9525', 'Juliana', 'Plan B', '24/7', 'en línea', 'Último cupo', 'Siempre hay cupo',
  ' kit', 'Kit ', 'Preparado', 'Esta noche te avisamos', '38 auxiliares', '8:00 p. m.', 'puntos', '2 horas', '$', 'pts',
  'Enlace copiado', 'Carlos va a ver', 'te escribe'];

async function boot({ rx = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  const origErr = w.console.error.bind(w.console);
  w.console.error = (...a) => { errores.push(a.map(String).join(' ')); };
  w.RENDIO_CONFIG = {};
  const toasts = [];
  w.toast = (m) => toasts.push(m);
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Trampa: cualquier uso del cliente de Supabase sería red.
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.state = { settings: {} };
  // El rastreo corre cada 6 s: aquí cada 90 ms.
  const si = w.setInterval.bind(w);
  w.setInterval = (fn, ms, ...a) => si(fn, ms === 6000 ? 90 : ms === 5000 ? 70 : ms, ...a);   // rastreo 6 s y chat 5 s
  w.eval(readFix('fake-leaflet.js'));
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  for (const f of ['api.js', 'api-aux.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'aux-rx-viaje.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errores.push(f + ': ' + e.message); }
  }
  w.eval(readFix('aux-escenarios.js'));
  red.length = 0;
  try { w.localStorage.setItem('rendio.aux.onboarded', '1'); } catch (_) {}
  if (w.AuxPresentacion && w.AuxPresentacion.markOnboarded) w.AuxPresentacion.markOnboarded();
  const A = w.Auxiliar, E = w.AuxEscenarios, L = w.L, AS = w.AuxShell;
  // init ata los oyentes; luego cada escenario escribe el estado.
  await A.init({ id: 'esc-perfil-laura', full_name: 'Laura Gómez Ruiz', role: 'auxiliar' }).catch(() => {});
  await wait(20);
  errores.length = 0;
  red.length = 0;   // init corre antes de que el escenario reemplace las lecturas: no cuenta
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  async function abrir(n, mut) {
    try { A.stopTrack(); } catch (_) {}
    if (AS && AS.popAll) { try { AS.popAll(); } catch (_) {} }
    A.state.view = 'home'; A.state.tab = 'inicio';
    L.__reset();
    const d = E.montar(n);
    if (mut) mut(d);
    await wait(10);
    A.openTrip(d.principal);
    await wait(260);    // primer tic + capa + un par de tics
    return d;
  }
  return { w, A, E, L, AS, q, qa, click, abrir, errores, red, toasts, origErr };
}

const TRIP_IDS = ['ax-track-map', 'ax-eta-label', 'ax-eta-min', 'ax-eta', 'ax-count', 'ax-wait', 'ax-late-wrap', 'ax-track-fresh',
  'ax-onboard-badge', 'ax-chat', 'ax-chat-body', 'ax-chat-input', 'ax-phase'];

const B = await boot();
const { w, A, E, L, AS, q, qa, click, abrir, errores, red } = B;
const uiText = () => (q('#auxiliar-ui') ? q('#auxiliar-ui').textContent : '');
const prohibidos = (txt) => PROHIBIDOS.filter(p => txt.includes(p));

console.log('\n── Registro y contrato ──');
t('AuxShell registra trip, rate y rate-sent', AS.registered('trip') && AS.registered('rate') && AS.registered('rate-sent'));
const X = w.AuxRxViaje;
t('window.AuxRxViaje = chatHTML, alarmHTML, bubblesHTML, setUnread (+ cancelHTML, tripHTML, rateHTML)',
  X && ['chatHTML', 'alarmHTML', 'bubblesHTML', 'setUnread', 'cancelHTML', 'tripHTML', 'rateHTML'].every(k => typeof X[k] === 'function'));

console.log('\n── Ids de §2.4 en «en camino» y «a bordo» ──');
for (const n of ['en-camino', 'llego', 'a-bordo-salida', 'a-bordo-llegada']) {
  await abrir(n);
  const faltan = TRIP_IDS.filter(id => w.document.querySelectorAll('#' + id).length !== 1);
  t(`${n}: los ${TRIP_IDS.length} ids, una vez cada uno, dentro de la capa trip`,
    faltan.length === 0 && !!q('.rx-layer[data-scr="trip"] #ax-track-map'), faltan.join(','));
}

console.log('\n── Fases ──');
await abrir('en-camino');
let ph = qa('#ax-phase > .rx-tl-s[data-ph]').map(e => e.getAttribute('data-ph'));
t('salida: 6 fases con las claves del diseño', ph.join() === 'booked,assigned,enroute,arrived,onboard,done', ph.join());
t('salida en camino: «En camino» es la actual', q('#ax-phase [data-ph="enroute"]').classList.contains('now') && q('#ax-phase [data-ph="assigned"]').classList.contains('done'));
t('salida: el texto «Llegó por ti» está', /Llegó por ti/.test(q('#ax-phase').textContent));
await abrir('a-bordo-llegada');
ph = qa('#ax-phase > .rx-tl-s[data-ph]').map(e => e.getAttribute('data-ph'));
t('llegada: 5 fases (Pedido · Conductor asignado · A bordo · Rumbo a casa · En casa)', ph.join() === 'booked,assigned,onboard,homebound,done', ph.join());
t('llegada: rejilla de 5 columnas', /repeat\(5/.test(q('#ax-phase').getAttribute('style') || ''));

console.log('\n── Código de encuentro (meetVisible) y «llegó» sin repintar ──');
let d = await abrir('asignado-publicado');
t('asignado (salida, sin llegar): sin #ax-meet', !q('#ax-meet'));
d = await abrir('a-bordo-salida');
t('a bordo: sin #ax-meet', !q('#ax-meet'));
d = await abrir('en-camino');
t('en camino (salida): #ax-meet con los 4 dígitos y --k', !!q('#ax-meet') && qa('#ax-meet .rx-meet-c b').map(b => b.textContent).join('') === E.piezas.CODIGO
  && q('#ax-meet .rx-meet-c b').getAttribute('style') === '--k:0');
t('en camino: aún no resaltado', !q('#ax-meet').classList.contains('is-arrived'));
const capa1 = q('.rx-layer[data-scr="trip"] .rx-trip');
const mapas1 = L.__liveMaps();
t('el mapa falso quedó montado en #ax-track-map', mapas1.length === 1 && mapas1[0].getContainer() === q('#ax-track-map'), mapas1.length);
t('con pos: hay carro (.rx-lf-car)', L.__markers('rx-lf-car').length === 1);
// El conductor llega: el rastreo lo dice en el próximo tic.
Object.assign(d.track[d.principal], { stop_status: 'arrived', arrived_at: new Date(Date.now() - 30e3).toISOString(), raw_status: 'at_pickup' });
await wait(260);
t('HUD con stop_status arrived: #ax-meet.is-arrived y data-arrived=1', q('#ax-meet').classList.contains('is-arrived') && q('#ax-meet').getAttribute('data-arrived') === '1');
t('HUD: la fase «Llegó por ti» pasa a ser la actual', q('#ax-phase [data-ph="arrived"]').classList.contains('now'));
t('sin repintar: el mismo nodo .rx-trip y el mismo mapa vivo', q('.rx-layer[data-scr="trip"] .rx-trip') === capa1 && L.__liveMaps()[0] === mapas1[0] && !mapas1[0]._removed);
t('la espera en el punto se muestra (#ax-wait sin hidden)', !q('#ax-wait').classList.contains('hidden'));
// Llegada con conductor el día del viaje: el código sí (en MDE es donde más se necesita).
const P = E.piezas;
d = await abrir('asignado-publicado', (dd) => {
  const h = P.enMin(40);
  const tr = dd.trips[0];
  Object.assign(tr, { type: 'lle', date: h.date, time: h.time, flight: 'JA5116', requiredAt: P.iso(h.date, h.time) });
  dd.track[tr.id].direction = 'airport_to_home';
  w.Auxiliar.state.trips[0] && Object.assign(w.Auxiliar.state.trips[0], { type: 'lle', date: h.date, time: h.time, flight: 'JA5116' });
});
t('llegada asignada HOY con conductor: #ax-meet visible', !!q('#ax-meet'), A.meetVisible(A.state.trips[0]));

console.log('\n── D14: sin pos no hay carro ──');
d = await abrir('asignado-publicado');
t('asignado (pos null): sin .rx-lf-car', L.__markers('rx-lf-car').length === 0);
t('asignado: «Sin ubicación todavía» en el hueco del mapa', /Sin ubicación todavía/.test(q('.rx-trip-map').textContent));
d = await abrir('en-camino', (dd) => { dd.track[dd.principal].pos = null; });
t('en camino SIN pos: el mapa se monta pero sin .rx-lf-car', L.__liveMaps().length === 1 && L.__markers('rx-lf-car').length === 0);

console.log('\n── Conductor, ★ y acciones ──');
d = await abrir('asignado-publicado');
t('conductor: nombre, «Marca Modelo · Color» y placa', /Mauricio Arango Pérez/.test(q('.rx-drv').textContent) && q('.rx-drv-tx span').textContent === 'Chevrolet Onix · Gris' && q('.rx-plate').textContent === 'RDO481');
t('★ oculta con 6 calificaciones (< 10)', !q('.rx-drv-st'));
t('acciones: Llamar (call), Mensaje (chat), Coordinación (open-coord con el id)', !!q('.rx-drv-acts [data-ax="call"]') && !!q('.rx-drv-acts [data-ax="chat"]')
  && q('.rx-drv-acts [data-rx="open-coord"]').getAttribute('data-id') === d.principal);
t('datos: Vuelo · En MDE · Nivel · Maletas', qa('.rx-trip-info span').map(s => s.textContent).join() === 'Vuelo,En MDE,Nivel,Maletas');
t('hora grande = recogida publicada 03:48, «Mañana te recogemos»', q('#ax-eta-min').textContent === '03:48' && q('#ax-eta-label').textContent === 'Mañana te recogemos');
t('pie: «Confirmar mi recogida» (confirm-pickup) + botón rojo (alarm)', /Confirmar mi recogida/.test(q('[data-ax="confirm-pickup"]').textContent) && !!q('.rx-trip-cta [data-ax="alarm"]'));
d = await abrir('privado-aprobado');
t('★ visible con 37 calificaciones: «4,8»', q('.rx-drv-st') && q('.rx-drv-st').textContent.trim() === '4,8');
d = await abrir('pendiente-sin-plan');
t('pendiente: «Estamos armando tu ruta», sin conductor ni acciones', /Estamos armando tu ruta/.test(q('.rx-assign').textContent) && !q('.rx-drv') && !q('.rx-drv-acts'));
t('pendiente: celdas vacías omitidas (sin maletas en null) y maletas=2 aquí', qa('.rx-trip-info span').map(s => s.textContent).includes('Maletas'));
t('pendiente: sin «Compartir»', !q('[data-ax="share-eta"]'));

console.log('\n── Compartir ──');
d = await abrir('asignado-publicado'); t('asignado con hora: Compartir', !!q('.rx-trip-top [data-ax="share-eta"]'));
d = await abrir('asignado-sin-hora'); t('asignado sin hora: sin Compartir, hora «Por confirmar»', !q('[data-ax="share-eta"]') && q('#ax-eta-min').textContent === 'Por confirmar');
d = await abrir('en-camino'); t('en camino: Compartir', !!q('[data-ax="share-eta"]'));
d = await abrir('a-bordo-salida'); t('a bordo: Compartir y la nota de Coordinación', !!q('[data-ax="share-eta"]') && /Coordinación hasta que llegues/.test(q('.rx-trip-sheet').textContent));

console.log('\n── Alarma (patch, sin tumbar el mapa) ──');
d = await abrir('en-camino');
let capa = q('.rx-layer[data-scr="trip"] .rx-trip');
let mapa = L.__liveMaps()[0];
let stops = 0; const origStop = A.stopTrack; A.stopTrack = () => { stops++; return origStop(); };
click(q('.rx-trip-cta [data-ax="alarm"], .rx-trip-alarm-w'));
await wait(20);
t('la hoja de la alarma sale en .rx-sheet-host con #ax-alarm-text', !!q('.rx-sheet-host .rx-sheet-bg[data-rx-own="alarm"] #ax-alarm-text'));
t('abrir la alarma NO destruye el mapa falso ni la capa, ni llama stopTrack', !mapa._removed && L.__liveMaps()[0] === mapa && q('.rx-layer[data-scr="trip"] .rx-trip') === capa && stops === 0, `stops=${stops}`);
t('la alarma dice «Coordinación» y el nombre del conductor', /a Coordinación y a Mauricio/.test(q('.rx-trip-alarm-sh').textContent));
const hoja = q('.rx-sheet-bg[data-rx-own="alarm"]');
click(q('[data-ax="alarm-pick"][data-v="desembarque"]'));
await wait(10);
t('elegir un motivo: .on en su lugar (misma hoja)', q('.rx-sheet-bg[data-rx-own="alarm"]') === hoja && q('[data-ax="alarm-pick"][data-v="desembarque"]').classList.contains('on'));
click(q('[data-ax="alarm-close"]'));
await wait(10);
t('Volver: la hoja sale con .out', hoja.classList.contains('out'));
await wait(240);
t('… y se desmonta a los 220 ms; el mapa sigue', !hoja.isConnected && !mapa._removed && stops === 0);
// Fondo: tocarlo cierra por el mismo camino.
click(q('.rx-trip-cta [data-ax="alarm"], .rx-trip-alarm-w'));
await wait(10);
const hoja2 = q('.rx-sheet-bg[data-rx-own="alarm"]');
hoja2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await wait(10);
t('tocar el fondo: A.state.alarm = null y la hoja sale', A.state.alarm === null && hoja2.classList.contains('out'));
A.stopTrack = origStop;
await wait(240);

console.log('\n── Cancelar ──');
d = await abrir('asignado-publicado');
click(q('[data-ax="cancel-trip"]'));
await wait(10);
const hc = q('.rx-sheet-bg[data-rx-own="cancel"]');
const txtC = hc ? hc.textContent : '';
t('cancelar: hoja con #ax-cancel-reason y el texto de la decisión', !!q('#ax-cancel-reason') && /Si ya hay conductor asignado, le avisamos y sale de su ruta\. No se puede deshacer\./.test(txtC));
t('cancelar no menciona puntos, «2 horas» ni asiento', !/punto|2 horas|asiento/i.test(txtC), txtC);
click(q('[data-ax="cancel-abort"]'));
await wait(240);
t('«Mantener mi traslado» cierra la hoja', !hc.isConnected && A.state.confirmingCancel === false);
click(q('[data-ax="cancel-trip"]'));
await wait(10);
q('#ax-cancel-reason').value = 'Cambio de programación';
click(q('[data-ax="cancel-do"]'));
await wait(40);
t('«Sí, cancelar» → Api.cancelMyReservation con el motivo', E.llamadas.some(c => c.fn === 'Api.cancelMyReservation' && c.args[1] === 'Cambio de programación'));
await wait(300);
t('al cancelar la capa se va y la hoja no queda colgada', !q('.rx-layer[data-scr="trip"]:not(.out)') && !q('.rx-sheet-bg[data-rx-own="cancel"]'));

console.log('\n── Chat: burbujas rx-bub y «Coordinación» ──');
const html = X.bubblesHTML([
  { id: 'm1', sender_role: 'driver', body: 'Voy en camino', created_at: new Date().toISOString() },
  { id: 'm2', sender_role: 'admin', body: 'Tu conductor ya salió', created_at: new Date().toISOString() },
  { id: 'm3', sender_role: 'auxiliar', body: 'Gracias <b>', created_at: new Date().toISOString() },
], 'yo');
const box = w.document.createElement('div'); box.innerHTML = html;
t('bubblesHTML: in/in/out, el admin con <b>Coordinación</b>, texto escapado',
  [...box.querySelectorAll('.rx-bub')].map(b => b.classList.contains('out') ? 'out' : 'in').join() === 'in,in,out'
  && box.querySelectorAll('.rx-bub')[1].querySelector('b').textContent === 'Coordinación' && /Gracias &lt;b&gt;/.test(html));
d = await abrir('en-camino', (dd) => {
  dd.chat[dd.principal] = [
    { id: 'c1', sender_role: 'driver', body: 'Estoy a 5 min', created_at: new Date().toISOString(), read_by: [] },
    { id: 'c2', sender_role: 'admin', body: 'Te confirmamos la hora', created_at: new Date().toISOString(), read_by: [] },
  ];
});
await wait(60);
t('sin abrir: el globo de «Mensaje» cuenta 2', q('[data-ax="chat"] .rx-trip-unread') && q('[data-ax="chat"] .rx-trip-unread').textContent === '2');
mapa = L.__liveMaps()[0]; capa = q('.rx-trip');
click(q('.rx-drv-acts [data-ax="chat"]'));
await wait(60);
t('abrir el chat: #ax-chat visible con las burbujas (el admin «Coordinación»)', !q('#ax-chat').classList.contains('hidden')
  && q('#ax-chat-body .rx-bub') && /Coordinación/.test(q('#ax-chat-body').textContent));
t('abrir el chat no repinta la capa ni tumba el mapa', q('.rx-trip') === capa && !mapa._removed);
t('al abrir, las burbujas entran con .pop (como el diseño al montar)', qa('#ax-chat-body .rx-bub').length === 2 && qa('#ax-chat-body .rx-bub.pop').length === 2);
await wait(220);   // varios sondeos de 5 s (acelerados) + un patch del shell
A.rerender();
await wait(160);
t('los sondeos siguientes NO vuelven a hacer saltar el hilo', qa('#ax-chat-body .rx-bub').length === 2 && qa('#ax-chat-body .rx-bub.pop').length === 0,
  qa('#ax-chat-body .rx-bub.pop').length);
// El espía del escenario anota el envío; aquí además lo guarda en el hilo, como
// haría la base, para ver que la copia del servidor no duplica la burbuja.
const envOrig = w.Api.sendReservationMessage;
w.Api.sendReservationMessage = async (id, body, o) => {
  const r = await envOrig(id, body, o);
  d.chat[id].push({ id: 'srv-1', sender_role: 'auxiliar', body, created_at: new Date().toISOString(), read_by: [] });
  return r;
};
q('#ax-chat-input').value = 'Bajo ya';
click(q('[data-ax="chat-send"]'));
await wait(40);
t('enviar: Api.sendReservationMessage con el texto', E.llamadas.some(c => c.fn === 'Api.sendReservationMessage' && c.args[1] === 'Bajo ya'));
t('la burbuja optimista queda UNA sola vez tras la copia del servidor',
  qa('#ax-chat-body .rx-bub.out').length === 1 && /Bajo ya/.test(q('#ax-chat-body .rx-bub.out').textContent), qa('#ax-chat-body .rx-bub.out').length);
await wait(420);
w.Api.sendReservationMessage = envOrig;
t('pasado su salto (.35 s), los sondeos la pintan quieta', qa('#ax-chat-body .rx-bub.pop').length === 0);
click(q('#ax-chat [data-ax="chat-close"]'));
await wait(20);
t('cerrar el chat: #ax-chat vuelve a hidden', q('#ax-chat').classList.contains('hidden'));

console.log('\n── Cambio de estado: repinta y recrea la hora grande (key={st}) ──');
d = await abrir('en-camino');
const big1 = q('.rx-trip-big');
Object.assign(d.track[d.principal], { raw_status: 'on_board', stop_status: 'picked_up' });
await wait(300);
t('en camino → a bordo: data-st=onboard', q('.rx-trip') && q('.rx-trip').getAttribute('data-st') === 'onboard');
t('.rx-trip-big es otro nodo y lleva .rx-anim', q('.rx-trip-big') !== big1 && q('.rx-trip-big').classList.contains('rx-anim'));
t('el rastreo se re-arrancó (hay un mapa vivo)', L.__liveMaps().length === 1);

console.log('\n── Datos nuevos por patch (sin tumbar el mapa) ──');
d = await abrir('en-camino', (dd) => { dd.trips[0].vehicle = null; dd.track[dd.principal].vehicle = null; });
mapa = L.__liveMaps()[0]; capa = q('.rx-trip');
Object.assign(d.track[d.principal], { vehicle: { plate: 'RDO481', brand: 'Chevrolet', model: 'Onix', color: 'Gris' } });
await wait(260);
t('llega el carro: «Chevrolet Onix · Gris» sin repintar la capa ni el mapa', /Chevrolet Onix · Gris/.test(q('.rx-drv').textContent) && q('.rx-trip') === capa && !mapa._removed);

console.log('\n── Sin viaje ──');
try { A.stopTrack(); } catch (_) {}
E.montar('vacio');
A.openTrip('no-existe');
await wait(40);
await wait(300);
const capaVacia = q('.rx-layer[data-scr="trip"]:not(.out)');
t('un viaje que no existe: «No tienes un traslado activo», sin ids del rastreo', !!capaVacia && /No tienes un traslado activo/.test(capaVacia.textContent) && !q('#ax-track-map'),
  capaVacia ? capaVacia.textContent.slice(0, 80) : 'sin capa trip');

console.log('\n── Cerrados ──');
d = await abrir('cancelado');
t('cancelado: «Cancelado» con el motivo, sin mapa, sin pie ni acciones', q('#ax-eta-min').textContent === 'Cancelado' && /Me cambiaron la programación/.test(q('.rx-trip-sheet').textContent)
  && !q('#ax-track-map') && !q('.rx-trip-cta') && !q('.rx-drv-acts') && !q('[data-ax="cancel-trip"]'));
t('cancelado: sin fases', !q('#ax-phase'));

console.log('\n── Calificar ──');
d = await abrir('entregado-sin-calificar');
t('entregado sin calificar: capa modal «rate» con «¿Cómo te fue con Mauricio?»', !!q('.rx-layer.modal[data-scr="rate"] .rx-rate-scr') && /¿Cómo te fue con Mauricio\?/.test(q('.rx-rate').textContent));
t('5 estrellas (data-ax=star) con --k, «Toca una estrella», enviar deshabilitado', qa('.rx-stars [data-ax="star"]').length === 5
  && q('.rx-stars [data-n="3"]').getAttribute('style') === '--k:3' && q('.rx-rate-l').textContent === 'Toca una estrella' && q('[data-ax="rate-send"]').disabled);
t('origen → destino y hora de entrega', /El Olivar → MDE · llegaste a las \d\d:\d\d/.test(q('.rx-rate p').textContent), q('.rx-rate p').textContent);
const scr = q('.rx-rate-scr');
const l0 = q('.rx-rate-l');
click(q('.rx-stars [data-n="4"]'));
await wait(10);
t('4 estrellas por patch: misma pantalla, 4 .on, texto «Bien» RECREADO', q('.rx-rate-scr') === scr && qa('.rx-stars .on').length === 4 && q('.rx-rate-l') !== l0 && q('.rx-rate-l').textContent === 'Bien');
t('etiquetas 4-5: Puntual · Manejo seguro · Carro limpio · Amable · Buena música', qa('.rx-chips [data-ax="tag"]').map(b => b.textContent).join('|') === 'Puntual|Manejo seguro|Carro limpio|Amable|Buena música');
click(q('.rx-chips [data-tag="Amable"]'));
await wait(10);
t('tocar una etiqueta: .on en su lugar', q('.rx-chips [data-tag="Amable"]').classList.contains('on') && q('.rx-rate-scr') === scr);
click(q('.rx-stars [data-n="2"]'));
await wait(10);
t('2 estrellas: etiquetas 1-3 y ninguna marcada', qa('.rx-chips [data-ax="tag"]').map(b => b.textContent).join('|') === 'Llegó tarde|Manejo brusco|Carro sucio|No encontré el carro|Otro'
  && !q('.rx-chips .on') && qa('.rx-stars .on').length === 2);
click(q('.rx-stars [data-n="5"]'));
click(q('.rx-chips [data-tag="Puntual"]'));
await wait(10);
t('enviar habilitado', !q('[data-ax="rate-send"]').disabled);
click(q('[data-ax="rate-send"]'));
await wait(60);
t('enviar → Api.rateReservation(id, 5, [Puntual])', E.llamadas.some(c => c.fn === 'Api.rateReservation' && c.args[0] === d.principal && c.args[1] === 5 && JSON.stringify(c.args[2]) === '["Puntual"]'));
t('«gracias» honesto: «Tu calificación le llega a la operación.»', !!q('.rx-full[data-scr="rate-sent"]') && /Tu calificación le llega a la operación\./.test(q('.rx-full[data-scr="rate-sent"]').textContent));
click(q('.rx-full[data-scr="rate-sent"] [data-rx="rx-tab"]'));
await wait(40);
t('«Volver al inicio» deja la pestaña Inicio sin capas', !q('.rx-full[data-scr="rate-sent"]') && A.state.view === 'home');
// «Ahora no» y luego «Calificar a {first}».
d = await abrir('entregado-sin-calificar');
w.localStorage.removeItem('rendio.aux.rateSkip');
A.openTrip(d.principal);
await wait(60);
click(q('[data-ax="rate-skip"]'));
await wait(320);
t('«Ahora no» → vuelve a Inicio y queda guardado', A.state.view === 'home' && A.rateSkipped(d.principal));
A.openTrip(d.principal);
await wait(60);
t('reabrir el viaje: pinta el viaje entregado con «Calificar a Mauricio»', !!q('.rx-trip[data-st="done"]') && /Calificar a Mauricio/.test(q('[data-rx="rate-open"]').textContent));
t('entregado: hora grande «Llegaste» y «Buen vuelo, Laura» (su nombre del perfil)', q('#ax-eta-min').textContent === 'Llegaste' && q('#ax-eta-label').textContent === 'Buen vuelo, Laura');
click(q('[data-rx="rate-open"]'));
await wait(360);
t('«Calificar a Mauricio»: se cierra y a los 280 ms entra Calificar', !!q('.rx-layer.modal[data-scr="rate"]:not(.out) .rx-rate-scr') && !A.rateSkipped(d.principal));

console.log('\n── Textos prohibidos del diseño ──');
const hallados = {};
for (const n of E.list()) {
  const dd = E.datos(n);
  if (!dd.principal) continue;
  await abrir(n);
  const txt = uiText() + (q('.rx-sheet-host') ? q('.rx-sheet-host').textContent : '');
  const p = prohibidos(txt);
  if (p.length) hallados[n] = p;
}
// Las hojas también.
await abrir('asignado-publicado');
click(q('[data-ax="alarm"]')); await wait(10);
let pa = prohibidos(q('.rx-sheet-host').textContent);
click(q('[data-ax="alarm-close"]')); await wait(240);
click(q('[data-ax="cancel-trip"]')); await wait(10);
pa = pa.concat(prohibidos(q('.rx-sheet-host').textContent));
click(q('[data-ax="cancel-abort"]')); await wait(240);
t('ningún escenario ni hoja pinta textos prohibidos', Object.keys(hallados).length === 0 && pa.length === 0, JSON.stringify(hallados) + pa.join(','));
t('ninguna excepción ni error de consola en todo el recorrido', errores.length === 0, errores.slice(0, 3).join(' | '));
t('sin red (window.sb nunca se tocó)', red.length === 0, red.slice(0, 5).join('.'));

console.log('\n── Bandera APAGADA: la UI de siempre ──');
const B0 = await boot({ rx: false });
await B0.abrir('en-camino');
t('apagada: el viaje sale con el marcado de siempre (.ax-track-map), sin .rx-trip', !!B0.q('#auxiliar-ui .ax-track-map') && !B0.q('.rx-trip') && !B0.q('.rx-app'));
t('apagada: el chat heredado (.ax-chat) y no el rediseñado', !!B0.q('#ax-chat.ax-chat') && !B0.q('.rx-trip-chat'));
t('apagada: sin errores', B0.errores.length === 0, B0.errores.slice(0, 2).join(' | '));

try { A.stopTrack(); } catch (_) {}
try { B0.A.stopTrack(); } catch (_) {}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: layout ni animación real (jsdom), el :has() de «Sin ubicación todavía», Leaflet real (tiles/OSRM/invalidateSize),');
console.log('          navigator.share, tel:, push real ni la prueba en el teléfono.');
process.exit(fail ? 1 : 0);
