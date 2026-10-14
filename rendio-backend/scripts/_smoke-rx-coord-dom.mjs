// P8 · COORDINACIÓN y «CAMBIÓ MI VUELO» del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + api.js + api-aux.js + aux-rx-ui.js +
// aux-shell.js + aux-residencias.js + aux-privado.js + aux-presentacion.js +
// aux-rx-inicio.js + aux-rx-avisos.js + aux-rx-coord.js + aux-rx-vuelo.js +
// auxiliar.js) y monta los escenarios de fixtures/aux-escenarios.js (P9):
// ninguna escritura sale a la red (quedan en AuxEscenarios.llamadas).
//
// Comprueba la aceptación de P8 (plan final §3.11 y §3.12):
//   · marcado y clases del diseño (RxCoord de rx-trip.jsx, RxFlight de
//     rx-home.jsx) con sus --d;
//   · Coordinación: cabecera sin nombre ni presencia; el horario y el
//     teléfono SOLO si están cargados; la nota de entrada; las respuestas
//     rápidas PRELLENAN y NO envían; enviar = ApiAux.crewSend (con el traslado
//     de contexto si se abrió desde un viaje, y sin él si se quita); Enter
//     envía; si falla, lo escrito vuelve al campo; crewMarkRead al abrir;
//     consulta cada 5 s (llega un mensaje nuevo → burbuja .pop .rx-anim);
//     unread() síncrono y la campana de Inicio; un repintado del shell no
//     borra lo escrito; el push de Coordinación refresca el contador;
//   · Cambió mi vuelo: campos propios (escribir NO cambia Auxiliar.state.form);
//     rx-flight-new con la hora de antes tachada; updated → «Actualizamos tu
//     traslado»; needs_ops → «Coordinación ajusta tu recogida y te confirma»;
//     error → toast; sin cambios del servidor → toast; llegada sin vuelo →
//     no llama a la RPC; varios candidatos → hoja para elegir; ninguno →
//     honesto; traslado en curso → «ya está en curso»;
//   · sin «en línea», «24/7», «Plan B», «Juliana», «Carlos», «AV9525»…;
//   · bandera APAGADA: nada del rediseño y sin llamadas a Coordinación.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (que rxRise, rxBub
// o rx-check se VEAN, cómo queda el pie con el teclado del teléfono abierto, el
// selector nativo de fecha/hora de iOS/Android, 390 px claro/nocturno); push real
// del sistema (el service worker es falso); tel: real; Supabase real (RLS de
// crew_messages, la RPC auxiliar_change_flight con su plazo mínimo y la cola de
// avisos a los jefes). Revisar en el teléfono antes de dar por bueno.
//
//   cd rendio-backend && node scripts/_smoke-rx-coord-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const readFix = (f) => readFileSync(FIX + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' && d != null ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const rechazos = [];
process.on('unhandledRejection', (e) => { rechazos.push((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' · ') : String(e))); });

const PROHIBIDOS = [
  ['cifra en pesos', /\$\s?\d/], ['Carlos', /Carlos/], ['Laura', /\bLaura\b/], ['AV9525', /AV9525/],
  ['Juliana', /Juliana/], ['Plan B', /Plan B/], ['24/7', /24\/7/], ['en línea', /en l[ií]nea/i], ['Último cupo', /[ÚU]ltimo cupo/],
  ['Siempre hay cupo', /Siempre hay cupo/], ['kit', /\bkit\b/i], ['Preparado', /Preparado/], ['Esta noche te avisamos', /noche te avisamos/i],
  ['38 auxiliares', /38 auxiliares/], ['Movemos tu recogida', /Movemos tu recogida|Recogida movida|ya lo sabe/], ['+N pts', /\+\s?\d+\s?pts/],
  ['auto-respuesta del diseño', /Ya lo vi|Te lo pongo en llamada|Llamando a Coordinación/],
];
const prohibidos = (html) => { const txt = String(html || '').replace(/<[^>]+>/g, ' '); return PROHIBIDOS.filter(([, re]) => re.test(txt)).map(([n]) => n); };

async function boot({ flag = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); };
  w.console.warn = () => {};
  w.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  w.RENDIO_CONFIG = {};
  const toasts = [];
  w.toast = (m) => toasts.push(m);
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.state = { settings: {} };
  w.eval(readFix('fake-sw.js'));
  w.eval(readFix('fake-leaflet.js'));
  w.localStorage.setItem('rendio.aux.rx', flag ? '1' : '0');
  for (const id of ['p1', 'esc-perfil-laura']) w.localStorage.setItem('rendio.aux.onboarded.' + id, '1');
  w.localStorage.setItem('rendio.aux.onboarded', '1');
  for (const f of ['api.js', 'api-aux.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js',
    'aux-rx-inicio.js', 'aux-rx-avisos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  if (w.AuxPresentacion && w.AuxPresentacion.markOnboarded) { try { w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ } }
  w.Api.countUnreadMessages = async () => ({});
  const A = w.Auxiliar, AS = w.AuxShell;
  // Sin escenario todavía: ApiAux de verdad contra la trampa → null (no truena).
  await A.init({ id: 'p1', full_name: 'Arranque', role: 'auxiliar', is_active: true }).catch(() => {});
  await wait(30);
  w.eval(readFix('aux-escenarios.js'));
  const E = w.AuxEscenarios;
  const ui = () => w.document.getElementById('auxiliar-ui');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  async function montar(n, o) {
    const d = E.montar(n, o);
    A.state.profile.full_name = 'Marta Ríos Vélez';
    A.rerender();
    await wait(40);
    return d;
  }
  const click = (el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const layer = (id) => q(`.rx-layer[data-scr="${id}"]:not(.out)`);
  const lastToast = () => { const x = q('.rx-toast'); return x ? x.textContent : ''; };
  const calls = (fn) => E.llamadas.filter(x => x.fn === fn);
  return { w, A, AS, E, ui, q, qa, errors, red, toasts, montar, click, type, key, layer, lastToast, calls };
}

const b = await boot();
const { w, A, AS, E, q, montar, click, type, key, layer, lastToast, calls } = b;
const FORM = () => JSON.stringify(A.state.form || {});

console.log('\n── Registro ──');
t('el shell está encendido', AS.on());
t('registra «coord» y «flight»', AS.registered('coord') && AS.registered('flight'));
t('window.AuxRxCoord con unread() síncrono y las 3 respuestas rápidas',
  !!w.AuxRxCoord && typeof w.AuxRxCoord.unread === 'function' && typeof w.AuxRxCoord.unread() === 'number' && w.AuxRxCoord.QR.length === 3);
t('window.AuxRxVuelo con candidates() y predict()', !!w.AuxRxVuelo && typeof w.AuxRxVuelo.candidates === 'function' && typeof w.AuxRxVuelo.predict === 'function');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Coordinación: la pantalla ──');
// unread() es síncrono: primero lo último que se supo; por detrás pide crewUnread.
let bells = 0;
const origBell = w.AuxRxInicio.refreshBell;
w.AuxRxInicio.refreshBell = () => { bells++; return origBell(); };
let d = await montar('coordinacion-con-mensajes');
await w.AuxRxCoord.refreshUnread(true);
t('unread(): 1 sin leer del escenario (ApiAux.crewUnread)', w.AuxRxCoord.unread() === 1, w.AuxRxCoord.unread());
t('el número cambió → AuxRxInicio.refreshBell()', bells >= 1, bells);
AS.render(); await wait(30);
const qaCoord = q('.rx-tabview[data-scr="home"] .rx-qa-b[data-rx="open-coord"]');
t('Inicio: el acceso de Coordinación dice «1 sin leer»', !!qaCoord && /1 sin leer/.test(qaCoord.textContent), qaCoord && qaCoord.textContent);
const formAntes = FORM();
click(qaCoord); await wait(60);
let co = layer('coord');
t('open-coord apila la pantalla «coord» (no el «todavía no disponible»)', !!co && !!co.querySelector('.rx-scr.rx-co') && !/Todavía no disponible/.test(co.textContent));
t('cabecera: «Coordinación», sin nombre ni presencia', co.querySelector('.rx-head-c b').textContent === 'Coordinación');
t('horario de Ajustes en la cabecera (ApiAux.getOpsContact)', (co.querySelector('.rx-head-c span') || {}).textContent === 'Todos los días · 3:00 a. m. a 11:00 p. m.', (co.querySelector('.rx-head-c span') || {}).textContent);
const tel = co.querySelector('.rx-head-r a.rx-ib');
t('teléfono cargado → a.rx-ib con tel: (el diseño: rx-ib + Phone)', !!tel && tel.getAttribute('href') === 'tel:6045551234' && !!tel.querySelector('use[href="#rx-Phone"]'), tel && tel.outerHTML.slice(0, 80));
const nota = co.querySelector('.rx-planb.rx-in');
t('nota de entrada en el lugar del bloque del diseño (rx-planb rx-in)', !!nota && nota.textContent.trim() === 'Le escribes a los jefes de la operación. Te responden por aquí.', nota && nota.textContent);
const hilo = co.querySelector('.rx-body.rx-chat');
let bubs = [...hilo.querySelectorAll('.rx-bub')];
t('el hilo: 2 burbujas (rx-bub out · rx-bub in), todas con .pop al montar',
  bubs.length === 2 && bubs[0].classList.contains('out') && bubs[1].classList.contains('in') && bubs.every(x => x.classList.contains('pop')), bubs.map(x => x.className).join(' | '));
t('burbuja propia con su contexto: «Sobre tu salida de mañana»', /Sobre tu salida de mañana/.test(bubs[0].querySelector('.rx-bub-t').textContent), bubs[0].querySelector('.rx-bub-t').textContent);
t('texto del jefe tal cual', bubs[1].querySelector('.rx-bub-x').textContent === 'Listo, movemos tu recogida y te confirmamos.');
const qrs = [...co.querySelectorAll('.rx-qr > button[data-rx="co-qr"]')];
t('rx-qr con los rótulos del diseño', qrs.map(x => x.textContent).join('|') === 'Mi vuelo se retrasó|No encuentro al conductor|Cambiar la dirección', qrs.map(x => x.textContent).join('|'));
t('al abrir: ApiAux.crewMarkRead y la campana en 0', calls('ApiAux.crewMarkRead').length === 1 && w.AuxRxCoord.unread() === 0, calls('ApiAux.crewMarkRead').length + ' / ' + w.AuxRxCoord.unread());
t('sin contexto (abierta desde Inicio): no hay chip', !co.querySelector('.rx-co-ctx'));
t('sin textos prohibidos en Coordinación', prohibidos(co.innerHTML).length === 0, prohibidos(co.innerHTML).join(', '));
t('el campo es data-rx-field (no data-field) y NO es el #ax-chat-input del viaje',
  !!co.querySelector('input[data-rx-field="coord-msg"]') && !co.querySelector('[data-field]') && !co.querySelector('#ax-chat-input'));

console.log('\n── Coordinación: respuestas rápidas y envío ──');
const inp = () => layer('coord').querySelector('input[data-rx-field="coord-msg"]');
const sendBtn = () => layer('coord').querySelector('[data-rx="co-send"]');
t('campo vacío → enviar apagado', sendBtn().hasAttribute('disabled'));
click(qrs[0]); await wait(20);
t('«Mi vuelo se retrasó» PRELLENA «Mi vuelo se retrasó: ahora sale a las »', inp().value === 'Mi vuelo se retrasó: ahora sale a las ', JSON.stringify(inp().value));
t('…y NO envía (ApiAux.crewSend sin llamar)', calls('ApiAux.crewSend').length === 0);
click(qrs[1]); await wait(20);
t('«No encuentro al conductor» → «No encuentro al conductor. Estoy en »', inp().value === 'No encuentro al conductor. Estoy en ');
click(qrs[2]); await wait(20);
t('«Cambiar la dirección» → «Necesito cambiar la dirección: »', inp().value === 'Necesito cambiar la dirección: ');
t('ninguna respuesta rápida envió; enviar quedó encendido', calls('ApiAux.crewSend').length === 0 && !sendBtn().hasAttribute('disabled'));
type(inp(), 'Necesito cambiar la dirección: Cra 50 #20-10');
t('escribir en Coordinación no toca Auxiliar.state.form', FORM() === formAntes);
// Repintado del shell (refresco de viajes) con la pantalla arriba: patch() → true.
const nodoCampo = inp();
AS.render(); await wait(20);
t('un repintado del shell no borra lo escrito (mismo nodo, mismo texto)', inp() === nodoCampo && inp().value === 'Necesito cambiar la dirección: Cra 50 #20-10');
click(sendBtn()); await wait(5);
const env = [...layer('coord').querySelectorAll('.rx-bub.out')].pop();
t('al enviar: burbuja nueva .out .pop .rx-anim (nodo nuevo, anima)', !!env && env.classList.contains('pop') && env.classList.contains('rx-anim') && /Cra 50/.test(env.textContent));
t('el campo se vacía y enviar se apaga', inp().value === '' && sendBtn().hasAttribute('disabled'));
await wait(40);
let cs = calls('ApiAux.crewSend');
t('ApiAux.crewSend(texto, {reservationId:null})', cs.length === 1 && cs[0].args[0] === 'Necesito cambiar la dirección: Cra 50 #20-10' && cs[0].args[1] && cs[0].args[1].reservationId === null, JSON.stringify(cs[0] && cs[0].args));
t('confirmada: deja de estar «Enviando…»', !env.classList.contains('rx-co-sending') && !/Enviando/.test(env.textContent) && env.getAttribute('data-co-id') === 'esc-envio');
// Enter envía.
type(inp(), 'Ya estoy en portería');
key(inp(), 'Enter'); await wait(40);
cs = calls('ApiAux.crewSend');
t('Enter en el campo envía', cs.length === 2 && cs[1].args[0] === 'Ya estoy en portería');
// Falla: la burbuja se va y lo escrito vuelve al campo.
const origSend = w.ApiAux.crewSend;
w.ApiAux.crewSend = () => Promise.reject(new Error('El mensaje es demasiado largo (máximo 500 caracteres)'));
type(inp(), 'Este no sale');
click(sendBtn()); await wait(40);
t('si falla: sin burbuja fantasma, el texto vuelve al campo y toast con el error del servidor',
  ![...layer('coord').querySelectorAll('.rx-bub')].some(x => /Este no sale/.test(x.textContent)) && inp().value === 'Este no sale' && /demasiado largo/.test(lastToast()), lastToast());
w.ApiAux.crewSend = () => Promise.resolve(null);
click(sendBtn()); await wait(40);
t('sin la RPC (null): honesto, no finge que se envió', inp().value === 'Este no sale' && /Todavía no puedes escribirle a Coordinación/.test(lastToast()), lastToast());
w.ApiAux.crewSend = origSend;
type(inp(), '');

console.log('\n── Coordinación: consulta cada 5 s ──');
const marcadas = calls('ApiAux.crewMarkRead').length;
d.crew.push({ id: 'esc-m9', role: 'admin', mine: false, body: 'Te llamamos en 5 minutos.', at: new Date().toISOString(), read: false, readAt: null, reservation: null });
await wait(5300);
bubs = [...layer('coord').querySelectorAll('.rx-bub')];
const nueva = bubs.find(x => /Te llamamos en 5 minutos/.test(x.textContent));
t('a los 5 s llega el mensaje nuevo como burbuja .in .pop .rx-anim', !!nueva && nueva.classList.contains('in') && nueva.classList.contains('pop') && nueva.classList.contains('rx-anim'));
t('las burbujas que ya estaban no se repiten', bubs.filter(x => /Listo, movemos/.test(x.textContent)).length === 1 && bubs.filter(x => /Cra 50/.test(x.textContent)).length === 1, bubs.length);
t('llegó algo del jefe con la pantalla a la vista → crewMarkRead otra vez', calls('ApiAux.crewMarkRead').length === marcadas + 1, calls('ApiAux.crewMarkRead').length - marcadas);

console.log('\n── Coordinación: abierta desde un viaje (contexto) ──');
AS.popAll(); await wait(300);
AS.push('coord', { reservationId: d.principal }); await wait(60);
co = layer('coord');
const chip = co.querySelector('.rx-co-ctx');
t('chip de contexto «Sobre tu salida de mañana»', !!chip && /Sobre tu salida de mañana/.test(chip.textContent), chip && chip.textContent);
type(inp(), 'No encuentro al conductor. Estoy en la portería 2');
click(sendBtn()); await wait(40);
cs = calls('ApiAux.crewSend');
t('se envía con el traslado como contexto (reservationId)', cs[cs.length - 1].args[1].reservationId === d.principal, JSON.stringify(cs[cs.length - 1].args[1]));
click(co.querySelector('[data-rx="co-ctx-off"]')); await wait(10);
t('la X quita el contexto', !co.querySelector('.rx-co-ctx'));
type(inp(), 'Otra cosa');
click(sendBtn()); await wait(40);
cs = calls('ApiAux.crewSend');
t('…y el siguiente mensaje sale sin traslado', cs[cs.length - 1].args[1].reservationId === null);
AS.popAll(); await wait(300);
t('rx-pop / popAll: la capa se va', !layer('coord'));

console.log('\n── Coordinación: sin teléfono ni horario, y sin hilo ──');
d = await montar('pendiente-sin-plan');
AS.push('coord', {}); await wait(60);
co = layer('coord');
t('sin ops_contact_phone: NO hay botón de llamar', !co.querySelector('.rx-head-r a, .rx-head-r button'));
t('sin horario: la cabecera no inventa nada (sin eyebrow)', !co.querySelector('.rx-head-c span'));
t('hilo vacío: rx-empty honesto', /Todavía no hay mensajes/.test(co.querySelector('.rx-chat').textContent));
AS.popAll(); await wait(300);
const origList = w.ApiAux.crewList;
w.ApiAux.crewList = () => Promise.resolve(null);
AS.push('coord', {}); await wait(60);
co = layer('coord');
t('crewList null (sin RPC o error): «No pudimos cargar los mensajes» + Reintentar', /No pudimos cargar los mensajes/.test(co.textContent) && !!co.querySelector('[data-rx="co-retry"]'));
w.ApiAux.crewList = origList;
d.crew.push({ id: 'esc-m10', role: 'admin', mine: false, body: 'Hola, ¿cómo vas?', at: new Date().toISOString(), read: true, readAt: null, reservation: null });
click(co.querySelector('[data-rx="co-retry"]')); await wait(60);
t('Reintentar carga el hilo', /Hola, ¿cómo vas\?/.test(layer('coord').querySelector('.rx-chat').textContent));
AS.popAll(); await wait(300);

console.log('\n── Coordinación: push y campana ──');
d = await montar('coordinacion-con-mensajes');
let pedidas = 0;
const origUnread = w.ApiAux.crewUnread;
w.ApiAux.crewUnread = () => { pedidas++; return origUnread(); };
w.__fakeSW.post({ type: 'rendio-push', title: 'Coordinación', body: 'Hola', url: '/#/coordinacion' });
await wait(40);
t('push de Coordinación con la app abierta → pide crewUnread ya', pedidas >= 1, pedidas);
t('…y la campana suma el sin leer', w.AuxRxCoord.unread() === 1);
w.ApiAux.crewUnread = origUnread;
AS.popAll(); await wait(300);

console.log('\n── Coordinación: teléfono desde state.settings y la consulta se apaga al salir ──');
const origOps = w.ApiAux.getOpsContact;
w.ApiAux.getOpsContact = () => Promise.resolve(null);          // sin la columna o sin sesión
// Otro perfil en el mismo teléfono: lo que se supo del anterior no se arrastra
// (con el mismo perfil, una lectura que falla deja el último dato bueno).
const idAntes = A.state.profile.id;
A.state.profile.id = 'esc-perfil-otro';
w.state.settings = Object.assign({}, w.state.settings, { ops_contact_phone: '604 555 0000', ops_contact_hours: 'Lun a dom · 4 a. m. a 10 p. m.' });
let listas = 0;
const origList2 = w.ApiAux.crewList;
w.ApiAux.crewList = (...a) => { listas++; return origList2(...a); };
AS.push('coord', {}); await wait(60);
co = layer('coord');
t('sin getOpsContact: el teléfono y el horario de state.settings', (co.querySelector('.rx-head-r a.rx-ib') || {}).getAttribute?.('href') === 'tel:6045550000'
  && co.querySelector('.rx-head-c span').textContent === 'Lun a dom · 4 a. m. a 10 p. m.');
AS.popAll(); await wait(300);
const antes = listas;
await wait(5300);
t('fuera de la pantalla no se consulta el hilo (el intervalo se apagó)', listas === antes, listas - antes);
w.ApiAux.crewList = origList2;
w.ApiAux.getOpsContact = origOps;
A.state.profile.id = idAntes;
w.state.settings = Object.assign({}, w.state.settings, { ops_contact_phone: '', ops_contact_hours: '' });

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Cambió mi vuelo: la pantalla ──');
d = await montar('pendiente-sin-plan');
// Traslado a 3 días: lejos del plazo mínimo, sin plan → «updated».
const P = E.piezas;
const sal = P.T({ id: 'fv-sal', date: P.dia(3), time: '05:10', flight: 'AV9412' });
d.trips = [sal]; A.state.trips = JSON.parse(JSON.stringify(d.trips)); A.rerender(); await wait(40);
const qaFl = q('.rx-tabview[data-scr="home"] .rx-qa-b[data-rx="open-flight"]');
t('Inicio: «Cambió mi vuelo» con data-id del traslado', !!qaFl && qaFl.getAttribute('data-id') === 'fv-sal');
const form0 = FORM();
click(qaFl); await wait(60);
let fl = layer('flight');
t('open-flight apila «flight»', !!fl && !!fl.querySelector('.rx-scr.rx-fv'));
t('cabecera «Cambió mi vuelo»', fl.querySelector('.rx-head-c b').textContent === 'Cambió mi vuelo');
const obh = fl.querySelector('.rx-body > .rx-ob-h.rx-in');
t('rx-ob-h rx-in: «¿Qué cambió?» + qué traslado', !!obh && obh.querySelector('h1').textContent === '¿Qué cambió?' && /Tu salida del /.test(obh.querySelector('p').textContent), obh && obh.querySelector('p').textContent);
const inFl = fl.querySelector('.rx-body > .rx-input.rx-in');
t('rx-input rx-in --d:1 con el avión y el campo propio del vuelo',
  !!inFl && inFl.style.getPropertyValue('--d') === '1' && !!inFl.querySelector('use[href="#rx-Plane"]') && inFl.querySelector('input').getAttribute('data-rx-field') === 'fv-flight' && inFl.querySelector('input').value === 'AV9412');
const when = fl.querySelector('.rx-fv-when.rx-in');
t('día y hora propios (data-rx-field), --d:1', !!when && when.style.getPropertyValue('--d') === '1'
  && when.querySelector('input[type="date"]').getAttribute('data-rx-field') === 'fv-date' && when.querySelector('input[type="time"]').getAttribute('data-rx-field') === 'fv-time');
t('salida: la hora es la de estar en MDE', /Estar en MDE/.test(when.textContent));
const fnw = fl.querySelector('.rx-flight-new.rx-in');
t('rx-flight-new rx-in --d:2: Antes 05:10 → Ahora (flecha)', !!fnw && fnw.style.getPropertyValue('--d') === '2' && /Antes/.test(fnw.textContent) && fnw.querySelectorAll('b')[0].textContent === '05:10' && !!fnw.querySelector('use[href="#rx-ArrowRight"]'));
const nt = fl.querySelector('.rx-note.rx-in');
t('rx-note rx-in --d:3 con el reloj', !!nt && nt.style.getPropertyValue('--d') === '3' && !!nt.querySelector('use[href="#rx-Clock"]'));
const cta = () => layer('flight').querySelector('.rx-foot [data-rx="fv-send"]');
t('sin cambios: el botón está apagado', !!cta() && cta().hasAttribute('disabled'));
t('sin «Carlos ya lo sabe» ni recogidas inventadas', prohibidos(fl.innerHTML).length === 0, prohibidos(fl.innerHTML).join(', '));
const inpFl = () => layer('flight').querySelector('[data-rx-field="fv-flight"]');
type(inpFl(), 'av 1234');
t('el vuelo se ve en mayúscula mientras se escribe', inpFl().value === 'AV 1234');
t('escribir el vuelo aquí NO cambia Auxiliar.state.form', FORM() === form0, FORM());
t('cambió solo el vuelo: la nota lo dice y el botón se enciende', /Actualizamos el vuelo de tu traslado/.test(layer('flight').querySelector('.rx-note').textContent) && !cta().hasAttribute('disabled'));
type(layer('flight').querySelector('[data-rx-field="fv-time"]'), '06:30');
const fnw2 = layer('flight').querySelector('.rx-flight-new');
t('la hora de antes queda TACHADA y la de ahora es la nueva', fnw2.querySelectorAll('b')[0].classList.contains('strike') && fnw2.querySelectorAll('b')[1].textContent === '06:30');
t('sin plan y lejos del plazo: «Actualizamos tu traslado con la hora nueva.»', /Actualizamos tu traslado con la hora nueva/.test(layer('flight').querySelector('.rx-note').textContent));
t('escribir hora tampoco toca Auxiliar.state.form', FORM() === form0);
click(cta()); await wait(60);
let cf = calls('ApiAux.changeFlight');
t('ApiAux.changeFlight(id, {flight:"AV1234", date, time:"06:30"})', cf.length === 1 && cf[0].args[0] === 'fv-sal'
  && cf[0].args[1].flight === 'AV1234' && cf[0].args[1].date === P.dia(3) && cf[0].args[1].time === '06:30', JSON.stringify(cf[0] && cf[0].args));
fl = layer('flight');
const done = fl.querySelector('.rx-body.rx-anim > .rx-center-in');
t('updated → «Actualizamos tu traslado» con rx-check (cuerpo recreado .rx-anim)', !!done && done.querySelector('h2').textContent === 'Actualizamos tu traslado' && !!done.querySelector('.rx-check.t-ok'));
t('…dice la hora nueva de verdad y «Te avisamos cuando armemos tu ruta»', /06:30/.test(done.textContent) && /vuelo AV1234/.test(done.textContent) && /Te avisamos cuando armemos tu ruta/.test(done.textContent), done && done.textContent);
const listo = fl.querySelector('.rx-foot [data-rx="rx-pop"]');
t('pie: «Listo» (pop)', !!listo && listo.textContent === 'Listo');
t('sin textos prohibidos en el «hecho»', prohibidos(fl.innerHTML).length === 0, prohibidos(fl.innerHTML).join(', '));
click(listo); await wait(320);
t('Listo cierra la capa', !layer('flight'));

console.log('\n── Cambió mi vuelo: needs_ops, error y sin cambios ──');
const origCF = w.ApiAux.changeFlight;
w.ApiAux.changeFlight = (...a) => { E.llamadas.push({ fn: 'ApiAux.changeFlight', args: a }); return Promise.resolve({ mode: 'needs_ops', incidentId: 'inc-1', requiredAt: null, unchanged: false, notified: 2 }); };
AS.push('flight', { reservationId: 'fv-sal' }); await wait(60);
type(layer('flight').querySelector('[data-rx-field="fv-time"]'), '07:00');
click(cta()); await wait(60);
fl = layer('flight');
const ops = fl.querySelector('.rx-center-in');
t('needs_ops → «Coordinación ajusta tu recogida y te confirma»', !!ops && ops.querySelector('h2').textContent === 'Coordinación ajusta tu recogida y te confirma');
t('…y dice que el traslado sigue como estaba mientras confirman', /sigue como estaba/.test(ops.textContent));
AS.popAll(); await wait(300);
w.ApiAux.changeFlight = () => Promise.reject(new Error('Esa hora ya pasó'));
AS.push('flight', { reservationId: 'fv-sal' }); await wait(60);
type(layer('flight').querySelector('[data-rx-field="fv-time"]'), '07:15');
click(cta()); await wait(60);
t('error → toast con el texto del servidor y el formulario sigue', /Esa hora ya pasó/.test(lastToast()) && !!layer('flight').querySelector('.rx-flight-new') && !cta().hasAttribute('disabled'), lastToast());
w.ApiAux.changeFlight = () => Promise.resolve({ mode: 'updated', unchanged: true });
click(cta()); await wait(60);
t('el servidor dice que no cambió nada → toast, no finge «Actualizamos»', /ya tenía ese vuelo y esa hora/.test(lastToast()) && !layer('flight').querySelector('.rx-center-in'), lastToast());
w.ApiAux.changeFlight = () => Promise.resolve(null);
click(cta()); await wait(60);
t('sin la RPC (null) → honesto', /Todavía no puedes cambiar el vuelo/.test(lastToast()) && !layer('flight').querySelector('.rx-center-in'), lastToast());
w.ApiAux.changeFlight = origCF;
AS.popAll(); await wait(300);

console.log('\n── Cambió mi vuelo: llegada, publicado, varios, ninguno, en curso ──');
const lle = P.T({ id: 'fv-lle', type: 'lle', date: P.dia(2), time: '06:18', flight: 'LA4021' });
d.trips = [lle]; A.state.trips = JSON.parse(JSON.stringify(d.trips)); A.rerender(); await wait(40);
AS.push('flight', { reservationId: 'fv-lle' }); await wait(60);
t('llegada: «Aterrizas» y el vuelo es obligatorio', /Aterrizas/.test(layer('flight').querySelector('.rx-fv-when').textContent)
  && layer('flight').querySelector('[data-rx-field="fv-flight"]').getAttribute('placeholder') === 'Número de vuelo');
const nCF = calls('ApiAux.changeFlight').length;
type(layer('flight').querySelector('[data-rx-field="fv-flight"]'), '');
click(cta()); await wait(40);
t('llegada sin vuelo → «Escribe el número de vuelo en el que llegas» y NO llama a la RPC', /Escribe el número de vuelo en el que llegas/.test(lastToast()) && calls('ApiAux.changeFlight').length === nCF, lastToast());
type(layer('flight').querySelector('[data-rx-field="fv-flight"]'), 'XX-12-99-99');
click(cta()); await wait(40);
t('vuelo que no se entiende → el texto del servidor, sin llamar', /no se entiende/.test(lastToast()) && calls('ApiAux.changeFlight').length === nCF, lastToast());
AS.popAll(); await wait(300);

d = await montar('asignado-publicado');
const pubT = A.state.trips.find(x => x.id === d.principal);
AS.push('flight', { reservationId: d.principal }); await wait(60);
t('publicado: la nota ya dice que Coordinación la ajusta (con la recogida real)',
  /Coordinación la ajusta y te confirma|Coordinación ajusta tu recogida y te confirma/.test(layer('flight').querySelector('.rx-note').textContent)
  && (!pubT.pickupAt || layer('flight').querySelector('.rx-note b')), layer('flight').querySelector('.rx-note').textContent);
t('predict() del publicado = needs_ops (misma regla que la RPC)', w.AuxRxVuelo.predict(pubT) === 'needs_ops');
t('predict() del sin plan a 3 días = updated', w.AuxRxVuelo.predict(sal, { date: sal.date, time: sal.time }) === 'updated');  // f explícito: sin él lee el formulario anterior y depende del reloj
AS.popAll(); await wait(300);

d = await montar('pendiente-sin-plan');
const s1 = P.T({ id: 'fv-a', date: P.dia(2), time: '05:10' });
const s2 = P.T({ id: 'fv-b', type: 'lle', date: P.dia(4), time: '09:40', flight: 'JA3120' });
d.trips = [s2, s1]; A.state.trips = JSON.parse(JSON.stringify(d.trips)); A.rerender(); await wait(40);
t('candidates(): los dos, por hora', w.AuxRxVuelo.candidates().map(x => x.id).join(',') === 'fv-a,fv-b');
AS.push('flight', {}); await wait(80);
let sh = q('.rx-sheet-host .rx-sheet');
const opts = sh ? [...sh.querySelectorAll('.rx-opt.rx-in[data-rx="fv-choose"]')] : [];
t('sin decir cuál y con varios: hoja para elegir (rx-sh + rx-opt rx-in --d)', opts.length === 2 && opts.map(o => o.style.getPropertyValue('--d')).join(',') === '0,1', opts.length);
t('detrás, «¿Cuál traslado cambió?» + «Elegir el traslado»', /¿Cuál traslado cambió\?/.test(layer('flight').textContent) && !!layer('flight').querySelector('[data-rx="fv-pick"]'));
click(opts[1]); await wait(260);
fl = layer('flight');
t('elegir → la hoja se cierra y sale el formulario de ESE traslado', !q('.rx-sheet-host .rx-sheet') && /Tu llegada del /.test(fl.querySelector('.rx-ob-h p').textContent)
  && fl.querySelector('[data-rx-field="fv-flight"]').value === 'JA3120' && fl.querySelector('.rx-body').classList.contains('rx-anim'));
t('con otro candidato: «Es otro traslado» vuelve a abrir la hoja', !!fl.querySelector('.rx-fv-other[data-rx="fv-pick"]'));
click(fl.querySelector('.rx-fv-other')); await wait(60);
sh = q('.rx-sheet-host .rx-sheet');
t('…la hoja marca el elegido (.on)', !!sh && !!sh.querySelector('.rx-opt.on[data-id="fv-b"]'));
click(sh.querySelector('[data-rx="sheet-close"]') || sh.parentNode); await wait(260);
AS.popAll(); await wait(300);

d = await montar('vacio');
AS.push('flight', {}); await wait(60);
t('ninguno: «No tienes traslados por cambiar» + escribir a Coordinación', /No tienes traslados por cambiar/.test(layer('flight').textContent) && !!layer('flight').querySelector('.rx-foot [data-rx="open-coord"]'));
AS.popAll(); await wait(300);

d = await montar('en-camino');
AS.push('flight', { reservationId: d.principal }); await wait(60);
t('en curso: «Tu traslado ya está en curso» y a Coordinación con el viaje', /Tu traslado ya está en curso/.test(layer('flight').textContent)
  && layer('flight').querySelector('.rx-foot [data-rx="open-coord"]').getAttribute('data-id') === d.principal);
t('en curso: no hay campo del vuelo (la RPC lo rechazaría)', !layer('flight').querySelector('[data-rx-field="fv-flight"]'));
AS.popAll(); await wait(300);

t('sin errores de consola (bandera encendida)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Bandera APAGADA ──');
const off = await boot({ flag: false });
let pedidasOff = 0;
off.E.montar('coordinacion-con-mensajes');
const oUnread = off.w.ApiAux.crewUnread;
off.w.ApiAux.crewUnread = () => { pedidasOff++; return oUnread(); };
off.A.rerender(); await wait(40);
t('apagada: los módulos cargan sin pintar nada del rediseño', !!off.w.AuxRxCoord && !!off.w.AuxRxVuelo && !off.q('.rx-app') && !off.q('.rx-co') && !off.q('.rx-fv'));
t('apagada: unread() = 0 sin pedir nada a Coordinación', off.w.AuxRxCoord.unread() === 0 && pedidasOff === 0, pedidasOff);
t('apagada: sin llamadas de Coordinación ni de vuelo', !off.E.llamadas.some(x => /crew|changeFlight/.test(x.fn)));
t('apagada: la UI de siempre', /Mis viajes/.test(off.ui().textContent));
t('apagada: sin errores', off.errors.length === 0, off.errors.slice(0, 3).join(' | '));

if (rechazos.length) console.log('\n⚠ rechazos sin atender (de otros módulos):\n  ' + rechazos.join('\n  '));
console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout ni animación real (jsdom), el pie con el teclado del teléfono abierto, el selector nativo');
console.log('          de fecha/hora, push real, tel: real, Supabase real (RLS, plazo mínimo de la RPC, cola de avisos).');
process.exit(bad ? 1 : 0);
