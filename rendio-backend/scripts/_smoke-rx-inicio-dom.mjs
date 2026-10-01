// P3 · Inicio, Viajes y Avisos del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga la app de verdad (index.html + api.js + api-aux.js + aux-rx-ui.js +
// aux-shell.js + aux-rx-inicio/viajes/avisos.js + auxiliar.js) con la bandera
// ENCENDIDA y monta los escenarios de fixtures/aux-escenarios.js. Comprueba la
// aceptación de P3 (plan final §3.2–§3.6):
//   · sin publicar NUNCA /Te recogemos \d/; publicado sin hora → «hora por confirmar»;
//   · sin «Presentación» ni «Trayecto»; con onway no hay anzuelo (ni ningún otro);
//   · Repetir dice «Salida · {conjunto}» (y se esconde suspendido);
//   · Inicio y Viajes coinciden en los próximos (mismos ids y mismo número);
//   · «llegó»: el código de encuentro sale en RxLive, con «Te espera hasta»;
//   · barrido de textos prohibidos (§7.2) en Inicio, Viajes (las dos vistas) y Avisos;
//   · el carro del mapa solo con I.pos real (fake-leaflet), el rastreo se apaga
//     al salir de Inicio y un repintado sin cambios NO rehace el mapa (patch);
//   · campana = avisos no vistos + Coordinación; al abrir Avisos se marcan vistos;
//   · segmentados: indicador sin repintar + cuerpo RECREADO con .rx-anim (key);
//   · historial: «Sin realizar», estrellas, «Calificar» (abre con rate:true);
//   · ids reservados de §2.4 fuera de la base; bandera APAGADA = UI de siempre.
//   · pedido del 29-sep: MDE con «JMC» y «Rionegro» en dos líneas (Inicio y
//     Viajes); «Recogida 2/3» / «Parada 3/3» / «1/1» SOLO publicado, como última
//     celda en la fila de Maletas; sin publicar o sin el dato, nada; mapTrip de
//     0093; tierra sin «Vuelo» y «Sales del aeropuerto»; la regla de «Cambió mi
//     vuelo» (canChangeFlight) en todos los escenarios; lectura estática de 0093
//     (cuenta la vuelta del CARRO, no la route_assignment: el caso de la ruta en
//     curso + la nueva que saveRoutePlan crea al lado; 0093 = 0087/0089 + lo
//     nuevo) y de su down (las funciones EXACTAS de 0087 y 0089).
//
// NO CUBRE: layout ni animación real (jsdom no pinta: que el pase, el mapa o las
// entradas .rx-in se VEAN bien hay que revisarlo en el teléfono), Leaflet real
// (tiles, tamaño), push real del sistema (el SW es falso), ni la hora de Bogotá
// en los bordes del día (el saludo depende del reloj de la máquina). Tampoco que
// las dos líneas de MDE queden alineadas con CASA ni que «Recogida 2/3» quepa en
// un teléfono de 320 px (eso es layout), ni la SQL de 0093 contra una base: solo
// se lee el archivo (que compile, que el cruce de tramos junte bien a Ana, Beto
// y Carla y no la vuelta siguiente, y el down aplicado, hay que verlo en la base
// local).
//
//   cd rendio-backend && node scripts/_smoke-rx-inicio-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const readFix = (f) => readFileSync(FIX + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' && d != null ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const PROHIBIDOS = [
  ['cifra en pesos', /\$\s?\d/], ['Carlos Mejía', /Carlos Mej[ií]a/], ['Laura', /\bLaura\b/], ['AV9525', /AV9525/],
  ['Juliana', /Juliana/], ['Plan B', /Plan B/], ['24/7', /24\/7/], ['en línea', /en l[ií]nea/i], ['Último cupo', /[ÚU]ltimo cupo/],
  ['Siempre hay cupo', /Siempre hay cupo/], ['kit', /\bkit\b/i], ['Preparado', /Preparado/], ['Esta noche te avisamos', /noche te avisamos|te avisamos esta noche/i],
  ['38 auxiliares', /38 auxiliares/], ['Presentación', /Presentaci[oó]n/], ['Trayecto', /Trayecto/i], ['Enlace copiado', /Enlace copiado/],
  ['Movemos tu recogida', /Movemos tu recogida/], ['+N pts', /\+\s?\d+\s?pts/],
];

async function boot({ flag = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  w.RENDIO_CONFIG = {};
  w.toast = () => {};
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Cualquier uso del cliente de Supabase sería red: se anota.
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
    'aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  if (w.AuxPresentacion && w.AuxPresentacion.markOnboarded) { try { w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ } }
  const chat = { counts: {} };
  w.Api.countUnreadMessages = async () => ({ ...chat.counts });
  const A = w.Auxiliar, AS = w.AuxShell;
  await A.init({ id: 'p1', full_name: 'Arranque', role: 'auxiliar', is_active: true }).catch(() => {});
  await wait(30);
  w.eval(readFix('aux-escenarios.js'));
  const E = w.AuxEscenarios;
  const ui = () => w.document.getElementById('auxiliar-ui');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  // El perfil del arnés se llama «Laura»: se cambia por otro nombre para que el
  // barrido de «Laura» pruebe el CÓDIGO y no el dato del escenario.
  async function montar(n, o) {
    E.montar(n, o);
    A.state.profile.full_name = 'Marta Ríos Vélez';
    A.rerender();
    await wait(40);
  }
  const homeEl = () => q('.rx-tabview[data-scr="home"]');
  const tripsEl = () => q('.rx-tabview[data-scr="trips"]');
  const notifsEl = () => q('[data-scr="notifs"]:not(.out)');
  const click = (el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { w, A, AS, E, ui, q, qa, errors, red, chat, montar, homeEl, tripsEl, notifsEl, click };
}

const b = await boot();
const { w, A, AS, E, q, qa, montar, homeEl, tripsEl, notifsEl, click, chat } = b;

console.log('\n── Registro ──');
t('AuxRxInicio / AuxRxViajes / AuxRxAvisos exportados', !!(w.AuxRxInicio && w.AuxRxInicio.passHTML && w.AuxRxInicio.liveHTML && w.AuxRxViajes && w.AuxRxAvisos && typeof w.AuxRxAvisos.unseen === 'function'));
t('home, trips y notifs registradas en el shell', AS.registered('home') && AS.registered('trips') && AS.registered('notifs'));
t('el shell está encendido y pinta la base', AS.on() && !!q('.rx-app .rx-tabs'));

console.log('\n── Inicio por escenario ──');
await montar('vacio');
let h = homeEl();
t('vacío: «No tienes traslados programados» con Pedir (data-ax="new")', /No tienes traslados programados/.test(h.textContent) && !!h.querySelector('.rx-empty-trip [data-ax="new"]'));
t('vacío: el texto de espera es el honesto (sin «vuelo y calculamos»)', /Pídelo y armamos tu ruta: la hora de recogida te la confirmamos cuando esté lista\./.test(h.textContent));
t('vacío: saludo según la hora y nombre de pila', /Buen(os días|as tardes|as noches)/.test(h.querySelector('.rx-home-g span').textContent) && h.querySelector('.rx-home-g b').textContent === 'Marta');
t('vacío: avatar con iniciales y va a Perfil', h.querySelector('.rx-home-av .rx-av').textContent === 'MV' && h.querySelector('.rx-home-av').getAttribute('data-tab') === 'perfil');
t('vacío: accesos rápidos solo Coordinación (--n:1), sin «En línea 24/7»', qa('.rx-tabview[data-scr="home"] .rx-qa-b').length === 1 && /--n:1/.test(h.querySelector('.rx-qa').getAttribute('style')) && /Escríbenos/.test(h.querySelector('.rx-qa').textContent));
t('vacío: anzuelo de Select (único, --d:4 del diseño, open-select from=home)', qa('.rx-tabview[data-scr="home"] .rx-select-teaser').length === 1 && h.querySelector('.rx-select-teaser').getAttribute('data-from') === 'home' && h.querySelector('.rx-select-teaser').getAttribute('style') === '--d:4' && h.querySelector('.rx-select-teaser').classList.contains('rx-in'));
t('vacío: entradas escalonadas del diseño (bloque --d:0, accesos --d:1)', /--d:0/.test(h.querySelector('.rx-body.home > .rx-in').getAttribute('style')) && /--d:1/.test(h.querySelector('.rx-qa.rx-in').getAttribute('style')));
t('vacío: Select sin «kit» ni cifras', !/\bkit\b|\$\s?\d/i.test(h.querySelector('.rx-select-teaser').textContent));

await montar('error-carga');
h = homeEl();
t('error de carga: rx-empty-trip con Reintentar (data-ax="reload")', !!h.querySelector('.rx-empty-trip [data-ax="reload"]') && /No pudimos cargar tus viajes/.test(h.textContent));

await montar('pendiente-sin-plan');
h = homeEl();
t('sin plan: NUNCA /Te recogemos \\d/', !/Te recogemos\s*\d/.test(h.textContent));
t('sin plan: «Estar en MDE» + 05:10 y la nota honesta', /Estar en MDE\s*05:10/.test(h.querySelector('.rx-pass-time').textContent) && /Hora de recogida: te avisamos cuando armemos tu ruta/.test(h.querySelector('.rx-pass-note').textContent));
t('sin plan: pase con CASA → MDE, Compartido, «Asignando conductor»', h.querySelector('.rx-pass-main').textContent.replace(/\s+/g, ' ').includes('CASA') && /MDE/.test(h.querySelector('.rx-pass-main').textContent) && /Compartido/.test(h.querySelector('.rx-pass-lv').textContent) && /Asignando conductor/.test(h.querySelector('.rx-pass-bot').textContent));
t('sin plan: grilla sin «En MDE» (la grande ya es esa), con Vuelo y Maletas', (() => { const g = h.querySelector('.rx-pass-grid').textContent; return !/En MDE/.test(g) && /Vuelo\s*AV9412/.test(g) && /Maletas\s*2/.test(g); })());
t('sin plan: «Cambió mi vuelo» → «Actualizamos tu traslado» (open-flight con id)', (() => { const b2 = h.querySelector('.rx-qa-b[data-rx="open-flight"]'); return !!b2 && b2.getAttribute('data-id') === A.state.trips[0].id && /Actualizamos tu traslado/.test(b2.textContent); })());
t('sin plan: el pase abre el viaje (data-ax="trip")', h.querySelector('.rx-pass').getAttribute('data-ax') === 'trip');

await montar('asignado-sin-hora');
h = homeEl();
t('publicado sin hora: «hora por confirmar» y sin «Te recogemos»', /hora por confirmar/.test(h.textContent) && !/Te recogemos/.test(h.textContent));
t('publicado sin hora: conductor y carro reales en el pie', /Mauricio Arango Pérez/.test(h.querySelector('.rx-pass-bot').textContent) && /Chevrolet Onix · Gris · RDO481/.test(h.querySelector('.rx-pass-bot').textContent));

await montar('asignado-publicado');
h = homeEl();
t('publicado: «Te recogemos 03:48»', /Te recogemos\s*03:48/.test(h.querySelector('.rx-pass-time').textContent));
t('publicado: grilla [En MDE 05:10][Vuelo][Maletas], sin nota', /En MDE\s*05:10/.test(h.querySelector('.rx-pass-grid').textContent) && !h.querySelector('.rx-pass-note'));
t('publicado: sec-h «Tu próximo traslado · Confirmado»', /Tu próximo traslado\s*Confirmado/.test(h.querySelector('.rx-sec-h').textContent));
t('publicado: el código NO sale antes de «en camino» (meetVisible)', !h.querySelector('.rx-pass-code'));
t('publicado: sin viaje en curso NO hay RxLive y hay anzuelo', !h.querySelector('.rx-live') && !!h.querySelector('.rx-select-teaser'));
t('publicado: sin «Compartir» (solo en camino o a bordo)', !h.querySelector('[data-rx="inicio-share"]'));
t('publicado: «Cambió mi vuelo» → «Coordinación te confirma»', /Coordinación te confirma/.test(h.querySelector('.rx-qa-b[data-rx="open-flight"]').textContent));
t('publicado: sin carro en ningún mapa (no hay rastreo en curso)', w.L.__markers('rx-lf-car').length === 0 && w.L.__liveMaps().length === 0);

await montar('en-camino');
await wait(40);
h = homeEl();
t('en camino: RxLive «Mauricio va por ti» con «En vivo»', !!h.querySelector('.rx-live') && h.querySelector('.rx-live-t').textContent === 'Mauricio va por ti' && /En vivo/.test(h.querySelector('.rx-live-tag').textContent));
t('en camino: NO hay anzuelo (D15)', !h.querySelector('.rx-select-teaser'));
t('en camino: sin ETA inventado (no «Llega en N min»)', !/Llega en \d/.test(h.textContent));
t('en camino: subtítulo placa + frescura del GPS real', /RDO481 · GPS · (ahora|hace \d+ s)/.test(h.querySelector('.rx-live-s').textContent), h.querySelector('.rx-live-s').textContent);
t('en camino: mapa real con casa, aeropuerto y carro en I.pos', w.L.__liveMaps().length === 1 && w.L.__markers('rx-lf-car').length === 1 && w.L.__markers('rx-lf-pin').length === 1 && w.L.__markers('rx-lf-apt').length === 1);
t('en camino: «Compartir viaje» presente', !!h.querySelector('[data-rx="inicio-share"]'));
t('en camino: el código se ve en el pase? (no hay pase: el viaje es el RxLive)', !h.querySelector('.rx-pass'));
const mapaAntes = w.L.__liveMaps()[0];
AS.render(); await wait(20);
t('repintado sin cambios: patch() deja el MISMO mapa montado', w.L.__liveMaps().length === 1 && w.L.__liveMaps()[0] === mapaAntes && !!homeEl().querySelector('.rx-live-lf.on'));
// Salir de Inicio apaga el mapa y el rastreo.
AS.setTab('viajes'); await wait(30);
t('al ir a Viajes, el mapa de Inicio se desmonta', w.L.__liveMaps().length === 0 && w.AuxRxInicio._live() === null);
AS.setTab('inicio'); await wait(40);

await montar('llego');
await wait(40);
h = homeEl();
t('llegó: RxLive «Llegó por ti»', h.querySelector('.rx-live-t').textContent === 'Llegó por ti');
t('llegó: el código 4827 aparece en RxLive', (h.querySelector('.rx-live .rx-code-inline') || {}).textContent === '4827');
t('llegó: «Te espera hasta las HH:MM»', /Te espera hasta las \d{2}:\d{2}/.test(h.querySelector('.rx-live').textContent));
t('llegó: sin «Cambió mi vuelo» (ya llegó por ti)', !h.querySelector('[data-rx="open-flight"]'));

await montar('a-bordo-salida');
await wait(30);
h = homeEl();
t('a bordo salida: «A bordo · rumbo a MDE» + texto de auxLateness', h.querySelector('.rx-live-t').textContent === 'A bordo · rumbo a MDE' && h.querySelector('.rx-live-s').textContent === ((A.lateness(A.state.trips[0]) || {}).text || ''), h.querySelector('.rx-live-s') && h.querySelector('.rx-live-s').textContent);
await montar('a-bordo-llegada');
await wait(30);
t('a bordo llegada: «A bordo · rumbo a casa»', homeEl().querySelector('.rx-live-t').textContent === 'A bordo · rumbo a casa');

await montar('entregado-sin-calificar');
h = homeEl();
t('entregado < 24 h: tarjeta «¿Cómo te fue con Mauricio?»', /¿Cómo te fue con Mauricio\?/.test(h.querySelector('.rx-rate-card').textContent) && h.querySelectorAll('.rx-rate-card .rx-stars svg').length === 5);
t('entregado: «Llegaste a MDE a las HH:MM · N min de margen» con la hora REAL de entrega', /Llegaste a MDE a las \d{2}:\d{2} · 10 min de margen/.test(h.querySelector('.rx-rate-card').textContent), h.querySelector('.rx-rate-card span').textContent);
t('entregado: «Repetir último» → «Salida · El Olivar»', (h.querySelector('.rx-qa-b[data-ax="repeat"] em') || {}).textContent === 'Salida · El Olivar');
const idCal = A.state.trips[0].id;
click(h.querySelector('.rx-rate-card')); await wait(20);
t('tocar la tarjeta abre el viaje con la calificación (rateOpen)', A.state.view === 'trip' && A.state.rateOpen === idCal && A.state.editingTrip === idCal);
AS.setTab('inicio'); await wait(20);
try { w.localStorage.setItem('rendio.aux.rateSkip', JSON.stringify([idCal])); } catch (_) { /* */ }
A.state.rateOpen = null;   // lo deja openTrip({rate:true}); «Ahora no» lo limpia en la app
A.rerender(); await wait(20);
t('con «Ahora no» guardado, la tarjeta NO sale', !homeEl().querySelector('.rx-rate-card'));
w.localStorage.removeItem('rendio.aux.rateSkip');

await montar('historial');
h = homeEl();
t('historial: Repetir dice «Salida · El Olivar»', (h.querySelector('.rx-qa-b[data-ax="repeat"] em') || {}).textContent === 'Salida · El Olivar');
t('historial: el próximo (dentro de 3 días) sale; el vencido NO', h.querySelectorAll('.rx-pass').length === 1 && !/Sin realizar/.test(h.textContent));
A.state.profile.is_active = false; A.state.profile.suspended_reason = 'Prueba'; A.rerender(); await wait(20);
h = homeEl();
t('suspendido: franja t-block y SIN Repetir', !!h.querySelector('.rx-strip.t-block') && !h.querySelector('[data-ax="repeat"]') && /Tu cuenta está suspendida/.test(h.textContent));

await montar('suspendido');
t('escenario suspendido: franja t-block con el motivo', /Tres ausencias sin aviso/.test(homeEl().querySelector('.rx-strip.t-block').textContent));

await montar('privado-solicitado');
h = homeEl();
t('privado pedido: «Privado · por confirmar» + «Coordinación confirma tu privado», sin cifras', /Privado · por confirmar/.test(h.querySelector('.rx-pass-lv').textContent) && /Coordinación confirma tu privado/.test(h.querySelector('.rx-pass-bot').textContent) && !/\$\s?\d/.test(h.textContent) && !h.querySelector('.rx-pass.vip'));
await montar('privado-aprobado');
h = homeEl();
t('privado aprobado: pase .vip «Privado» con la camioneta', !!h.querySelector('.rx-pass.vip') && h.querySelector('.rx-pass-lv').textContent === 'Privado' && /Toyota Fortuner · Negro · KTQ220/.test(h.querySelector('.rx-pass-bot').textContent));
await montar('privado-rechazado');
t('privado rechazado: vuelve a «Compartido»', homeEl().querySelector('.rx-pass-lv').textContent === 'Compartido' && !homeEl().querySelector('.rx-pass.vip'));

await montar('traslado-noche');
h = homeEl();
t('dos próximos: «Ver tus 2 traslados» lleva a Viajes', /Ver tus 2 traslados/.test(h.textContent) && h.querySelector('.rx-home-more').getAttribute('data-tab') === 'viajes');
t('noche: la salida de las 20:30 es «Mañana» (día de Bogotá)', /^Mañana/.test(h.querySelector('.rx-pass-day').textContent), h.querySelector('.rx-pass-day').textContent);

console.log('\n── Pedido 29-sep: MDE con «JMC» y «Rionegro» en dos líneas ──');
const lineas = (pt) => (pt ? [...pt.querySelectorAll('span')].map(s => s.textContent).join('|') : '');
await montar('asignado-publicado');
h = homeEl();
t('salida: a la derecha (.r) «MDE» grande y debajo «JMC» y «Rionegro»', h.querySelector('.rx-pass-pt.r b').textContent === 'MDE' && lineas(h.querySelector('.rx-pass-pt.r')) === 'JMC|Rionegro', lineas(h.querySelector('.rx-pass-pt.r')));
t('salida: a la izquierda «CASA» con una sola línea (el conjunto)', h.querySelector('.rx-pass-pt:not(.r) b').textContent === 'CASA' && lineas(h.querySelector('.rx-pass-pt:not(.r)')) === 'El Olivar');
t('ya no queda «JMC · Rionegro» en una sola línea (Inicio)', !/JMC\s*·\s*Rionegro/.test(h.textContent));
await montar('llegada-parada');
h = homeEl();
t('llegada: a la izquierda «MDE» con «JMC» y «Rionegro»; a la derecha «CASA»', h.querySelector('.rx-pass-pt:not(.r) b').textContent === 'MDE' && lineas(h.querySelector('.rx-pass-pt:not(.r)')) === 'JMC|Rionegro'
  && h.querySelector('.rx-pass-pt.r b').textContent === 'CASA' && lineas(h.querySelector('.rx-pass-pt.r')) === 'El Olivar');
AS.setTab('viajes'); await wait(20);
t('Viajes pinta el mismo pase (dos líneas, sin «JMC · Rionegro»)', lineas(tripsEl().querySelector('.rx-pass-pt:not(.r)')) === 'JMC|Rionegro' && !/JMC\s*·\s*Rionegro/.test(tripsEl().textContent));
AS.setTab('inicio'); await wait(10);

console.log('\n── Pedido 29-sep: orden en el carro («Recogida 2/3») ──');
const ordDe = (el) => el && el.querySelector('.rx-pass-grid .rx-pass-ord');
const celdas = (el) => [...el.querySelectorAll('.rx-pass-grid > div')].map(c => c.querySelector('span').textContent + ' ' + c.querySelector('b').textContent);
await montar('ruta-2-de-3');
h = homeEl();
let od = ordDe(h);
t('publicado con orden: celda «Recogida» «2/3»', !!od && od.querySelector('span').textContent === 'Recogida' && od.querySelector('b').textContent === '2/3', od && od.textContent);
t('…es la ÚLTIMA celda, en la misma fila que Maletas (4 celdas → 4 columnas)', od && od === h.querySelector('.rx-pass-grid').lastElementChild
  && celdas(h).join('|') === 'En MDE 05:10|Vuelo AV9412|Maletas 1|Recogida 2/3' && /repeat\(4,\s*1fr\)/.test(h.querySelector('.rx-pass-grid').getAttribute('style') || ''), celdas(h).join('|'));
AS.setTab('viajes'); await wait(20);
t('Viajes: el mismo «Recogida 2/3»', (ordDe(tripsEl()) || {}).textContent === 'Recogida2/3');
AS.setTab('inicio'); await wait(10);
await montar('ruta-sola');
od = ordDe(homeEl());
t('va sola en el carro: «1/1»', !!od && od.querySelector('b').textContent === '1/1');
await montar('llegada-parada');
od = ordDe(homeEl());
t('llegada: el orden en que la dejan, «Parada 3/3»', !!od && od.querySelector('span').textContent === 'Parada' && od.querySelector('b').textContent === '3/3');
t('llegada con 3 celdas: la grilla sigue en 3 columnas (sin style)', !homeEl().querySelector('.rx-pass-grid').getAttribute('style') && celdas(homeEl()).join('|') === 'Vuelo LA4021|Aterriza 21:40|Parada 3/3', celdas(homeEl()).join('|'));
await montar('pendiente-sin-plan');
h = homeEl();
t('sin publicar: NO hay celda de orden (ni placeholder) y la grilla queda como el diseño', !ordDe(h) && !/\d\/\d/.test(h.querySelector('.rx-pass-grid').textContent) && !h.querySelector('.rx-pass-grid').getAttribute('style'));
await montar('asignado-publicado');
t('publicado pero sin el dato (0093 sin aplicar): no se pinta nada', !ordDe(homeEl()));
// El front no confía a ciegas: sin published o con números incoherentes, nada.
await montar('ruta-2-de-3');
A.state.trips[0].published = false; A.rerender(); await wait(20);
t('con pickupPos pero published ≠ true: NO se pinta', !ordDe(homeEl()));
A.state.trips[0].published = true; A.state.trips[0].pickupPos = 4; A.rerender(); await wait(20);
t('pos > total (4/3): NO se pinta', !ordDe(homeEl()));
A.state.trips[0].pickupPos = 1.5; A.rerender(); await wait(20);
t('pos no entero: NO se pinta', !ordDe(homeEl()));
t('AuxRxInicio.pickupOrder: el mismo criterio', w.AuxRxInicio.pickupOrder({ published: true, pickupPos: 2, pickupTotal: 3, type: 'sal' }).text === '2/3'
  && w.AuxRxInicio.pickupOrder({ published: true, pickupPos: 1, pickupTotal: 1, type: 'lle' }).label === 'Parada'
  && w.AuxRxInicio.pickupOrder({ published: false, pickupPos: 1, pickupTotal: 1 }) === null && w.AuxRxInicio.pickupOrder({ published: true, pickupPos: null, pickupTotal: 3 }) === null);

console.log('\n── Pedido 29-sep: ApiAux.mapTrip (0093) ──');
const fila = (o) => w.ApiAux.mapTrip(Object.assign({ id: 'x', direction: 'home_to_airport', raw_status: 'assigned' }, o));
let mt = fila({ published: true, pickup_pos: 2, pickup_total: 3, ground_ops: true });
t('publicado: pickupPos 2 · pickupTotal 3 · groundOps true', mt.pickupPos === 2 && mt.pickupTotal === 3 && mt.groundOps === true);
mt = fila({ published: false, pickup_pos: 2, pickup_total: 3 });
t('sin publicar: los dos en null aunque la fila los traiga', mt.pickupPos === null && mt.pickupTotal === null && mt.groundOps === false);
mt = fila({ published: true, pickup_pos: 3, pickup_total: 2 });
t('incoherente (3 de 2): null', mt.pickupPos === null && mt.pickupTotal === null);
mt = fila({ published: true });
t('fila de 0087 (sin las claves nuevas): null y groundOps false, sin romper nada', mt.pickupPos === null && mt.pickupTotal === null && mt.groundOps === false && mt.published === true);

console.log('\n── Pedido 29-sep: traslado de tierra (groundOps) ──');
await montar('tierra-llegada');
h = homeEl();
t('tierra, llegada sin plan: la hora grande dice «Sales del aeropuerto» (no «Aterrizas»)', /^Sales del aeropuerto\s*14:00$/.test(h.querySelector('.rx-pass-time').textContent.trim()) && !/Aterriza/.test(h.querySelector('.rx-pass').textContent), h.querySelector('.rx-pass-time').textContent);
t('tierra: sin celda «Vuelo»', !/Vuelo/.test((h.querySelector('.rx-pass-grid') || { textContent: '' }).textContent) && celdas(h).join('|') === 'Maletas 1', celdas(h).join('|'));
await montar('llegada-parada');
Object.assign(A.state.trips[0], { groundOps: true }); A.rerender(); await wait(20);
h = homeEl();
t('tierra, llegada publicada: sin «Vuelo» aunque viniera y la celda dice «Sales», no «Aterriza»', celdas(h).join('|') === 'Sales 21:40|Parada 3/3' && /Te esperamos en MDE/.test(h.querySelector('.rx-pass-time').textContent), celdas(h).join('|'));
await montar('asignado-publicado');
Object.assign(A.state.trips[0], { groundOps: true }); A.rerender(); await wait(20);
t('tierra, salida: sin «Vuelo»; «Estar en MDE» no cambia', !/Vuelo/.test(homeEl().querySelector('.rx-pass-grid').textContent) && /En MDE\s*05:10/.test(homeEl().querySelector('.rx-pass-grid').textContent));

console.log('\n── Pedido 29-sep: la regla de «Cambió mi vuelo» es una sola ──');
const CF = w.AuxRxInicio.canChangeFlight;
t('AuxRxInicio.canChangeFlight exportada', typeof CF === 'function');
const reglaOk = [];
for (const n of E.list()) {
  await montar(n); await wait(5);
  const qaB = homeEl().querySelector('.rx-qa-b[data-rx="open-flight"]');
  const esperado = A.upcoming().find(x => CF(x));
  if ((!!qaB) !== (!!esperado) || (qaB && esperado && qaB.getAttribute('data-id') !== esperado.id)) reglaOk.push(n);
}
t(`${E.list().length} escenarios: «Cambió mi vuelo» sale justo cuando canChangeFlight lo dice (y con ese id)`, reglaOk.length === 0, reglaOk.join(','));
await montar('en-camino'); t('en camino: canChangeFlight = false', !CF(A.state.trips[0]));
await montar('llego'); t('llegó por ti: canChangeFlight = false', !CF(A.state.trips[0]));
await montar('pendiente-vencido'); t('vencido: canChangeFlight = false (no es próximo)', !CF(A.state.trips[0]));
await montar('pendiente-sin-plan'); t('pedido: canChangeFlight = true', CF(A.state.trips[0]) === true);

console.log('\n── 0093 (lectura del archivo, sin base) ──');
const M93 = readFileSync(new URL('../supabase/migrations/0093_orden_de_recogida.sql', import.meta.url), 'utf8');
t('0093: BEGIN/COMMIT y ADD COLUMN IF NOT EXISTS ground_ops boolean NOT NULL DEFAULT false', /\nBEGIN;/.test(M93) && /\nCOMMIT;\s*$/.test(M93) && /ADD COLUMN IF NOT EXISTS ground_ops boolean NOT NULL DEFAULT false/.test(M93));
t('0093: pickup_pos / pickup_total SOLO con k.pub', /'pickup_pos',\s*CASE WHEN k\.pub THEN po\.pos END/.test(M93) && /'pickup_total',\s*CASE WHEN k\.pub THEN po\.total END/.test(M93));
t('0093: sin cancelados ni no-show y misma dirección', /r2\.direction = r\.direction/.test(M93) && /r2\.cancelled_at IS NULL/.test(M93)
  && /rs2\.status <> 'no_show'/.test(M93) && /NOT IN \('cancelled', 'no_show'\)/.test(M93));
// La revisión del 29-sep: saveRoutePlan nunca le agrega paradas a una ruta
// 'in_progress'; al republicar, el pasajero nuevo de un carro que ya va rodando
// queda en OTRA route_assignment del mismo carro (su parada 1). Contar solo la
// route_assignment le decía «1/1» a Carla siendo la 3.ª de 3 (y «x/2» a Ana y
// Beto). Sin base no se puede correr: se comprueba que la SQL junte la vuelta
// del carro y no la route_assignment.
{
  const po = (M93.match(/LEFT JOIN LATERAL \(\s*SELECT o\.pos, o\.total[\s\S]*?\) po ON true/) || [''])[0];
  const sw = (M93.match(/LEFT JOIN LATERAL \(\s*SELECT greatest\(s\.ra_start, max\(ms\.estimated_arrival_at\)\) AS w1[\s\S]*?\) sw ON true/) || [''])[0];
  t('0093 (revisión): «s» trae la dirección y el arranque de mi ruta', /ra\.direction AS ra_dir, ra\.planned_start_at AS ra_start/.test(M93));
  t('0093 (revisión): el tramo de mi ruta va del arranque a la última hora estimada, solo publicado', !!sw && /WHERE k\.pub AND ms\.route_assignment_id = s\.ra_id/.test(sw) && M93.indexOf(sw) < M93.indexOf(po));
  t('0093 (revisión): cuenta la VUELTA DEL CARRO — mi ruta o las del mismo vehículo, dirección, con conductor y publicadas', !!po
    && /ra2\.id = s\.ra_id\s*OR \(ra2\.vehicle_id = s\.veh/.test(po) && /ra2\.direction = s\.ra_dir/.test(po) && /ra2\.driver_profile_id IS NOT NULL/.test(po)
    && /ra2\.status IN \('planned', 'in_progress', 'completed'\)/.test(po) && !/rs2\.route_assignment_id = s\.ra_id/.test(po));
  t('0093 (revisión): …solo si los tramos se cruzan (la vuelta siguiente del carro no entra)', /ra2\.planned_start_at <= sw\.w1/.test(po)
    && /s\.ra_start <= \(\s*SELECT greatest\(ra2\.planned_start_at, max\(os\.estimated_arrival_at\)\)\s*FROM public\.route_stops os\s*WHERE os\.route_assignment_id = ra2\.id\)/.test(po));
  t('0093 (revisión): una reserva en dos rutas cuenta una vez (la mía primero)', /SELECT DISTINCT ON \(rs2\.reservation_id\)/.test(po) && /ORDER BY rs2\.reservation_id, \(ra2\.id = s\.ra_id\) DESC/.test(po));
  t('0093 (revisión): una ruta = stop_order como antes; varias = la hora estimada de cada parada manda', /bool_or\(cand\.ra_id <> s\.ra_id\) OVER \(\) AS varias/.test(po)
    && /row_number\(\) OVER \(ORDER BY CASE WHEN cv\.varias THEN cv\.t_k END,\s*cv\.ra_start, cv\.stop_order, cv\.id\)/.test(po)
    && /coalesce\(rs2\.estimated_arrival_at, ra2\.planned_start_at\) AS t_k/.test(po) && /\(count\(\*\) OVER \(\)\)::int AS total/.test(po));
}
// 0093 = 0087 + líneas nuevas (ninguna de 0087 se pierde ni cambia), y el
// cambio de vuelo = 0089 salvo la exigencia de vuelo en la llegada.
const M87 = readFileSync(new URL('../supabase/migrations/0087_aux_mis_viajes.sql', import.meta.url), 'utf8');
const M89 = readFileSync(new URL('../supabase/migrations/0089_cambio_de_vuelo.sql', import.meta.url), 'utf8');
const bloque = (sql, fn) => (sql.match(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fn + '\\([\\s\\S]*?GRANT EXECUTE ON FUNCTION public\\.' + fn + '\\([^;]*;')) || [''])[0];
const subsec = (base, nuevo, fuera = []) => {
  const b = base.split('\n').filter(l => !fuera.some(f => l.includes(f))), n = nuevo.split('\n');
  let j = 0; for (const l of n) if (j < b.length && l === b[j]) j++;
  return b.length > 10 && j === b.length;
};
t('0093: auxiliar_my_trips conserva TODAS las líneas de 0087, en orden', subsec(bloque(M87, 'auxiliar_my_trips'), bloque(M93, 'auxiliar_my_trips')));
t('0093: auxiliar_change_flight = 0089 salvo la exigencia de vuelo y su comentario', subsec(bloque(M89, 'auxiliar_change_flight'), bloque(M93, 'auxiliar_change_flight'),
  ["IF v_flight IS NULL AND r.direction = 'airport_to_home' THEN", 'v_notes := r.notes;  -- salida sin vuelo nuevo']));
// El down (revisión del 29-sep): sin él, revertir 0092 como dice su down dejaba
// las funciones de 0093 leyendo r.ground_ops sin la columna.
{
  let D93 = '';
  try { D93 = readFileSync(new URL('../down_migrations/0093_orden_de_recogida.down.sql', import.meta.url), 'utf8'); } catch (_) {}
  const D92 = readFileSync(new URL('../down_migrations/0092_trabajo_en_tierra.down.sql', import.meta.url), 'utf8');
  t('down de 0093: existe, con BEGIN/COMMIT, y la cabecera de 0093 lo nombra', !!D93 && /\nBEGIN;/.test(D93) && /\nCOMMIT;\s*$/.test(D93) && /Down: down_migrations\/0093_orden_de_recogida\.down\.sql/.test(M93));
  t('down de 0093: auxiliar_my_trips EXACTA de 0087 (con REVOKE/GRANT)', !!bloque(D93, 'auxiliar_my_trips') && bloque(D93, 'auxiliar_my_trips') === bloque(M87, 'auxiliar_my_trips'));
  t('down de 0093: auxiliar_change_flight EXACTA de 0089 (con REVOKE/GRANT)', !!bloque(D93, 'auxiliar_change_flight') && bloque(D93, 'auxiliar_change_flight') === bloque(M89, 'auxiliar_change_flight'));
  t('down de 0093: no toca ground_ops (es de 0092) ni nombra las claves nuevas', !/ground_ops/.test(D93.replace(/^--.*$/gm, '')) && !/pickup_pos|pickup_total/.test(D93.replace(/^--.*$/gm, '')) && !/DROP COLUMN/.test(D93));
  t('el down de 0092 pide correr primero el de 0093', /0093[\s\S]{0,200}PRIMERO/.test(D92));
}
t('0093: devuelve ground_ops y conserva las claves de 0087', /'ground_ops',\s*r\.ground_ops/.test(M93) && ['published', 'pickup_at', 'meet_code', 'driver', 'vehicle', 'stop_status', 'dropped_at', 'notes_user'].every(k => M93.includes(`'${k}'`)));
t('0093: la llegada de tierra acepta vuelo vacío (y el resto de 0089 igual)', /AND NOT coalesce\(r\.ground_ops, false\) THEN\s*RAISE EXCEPTION 'Escribe el número de vuelo en el que llegas'/.test(M93) && /enqueue_incident_alert\(v_inc\)/.test(M93));
t('0093: SECURITY DEFINER con search_path fijo y los GRANT de 0087/0089', (M93.match(/SECURITY DEFINER\s*\nSET search_path = public, pg_temp/g) || []).length === 2
  && /REVOKE ALL ON FUNCTION public\.auxiliar_my_trips\(int\) FROM PUBLIC, anon;\s*GRANT EXECUTE ON FUNCTION public\.auxiliar_my_trips\(int\) TO authenticated;/.test(M93)
  && /REVOKE ALL ON FUNCTION public\.auxiliar_change_flight\(uuid, text, timestamptz\) FROM PUBLIC, anon;\s*GRANT EXECUTE ON FUNCTION public\.auxiliar_change_flight\(uuid, text, timestamptz\) TO authenticated;/.test(M93));

console.log('\n── Anzuelo, franjas, ajustes y permiso de notificaciones ──');
await montar('asignado-publicado');
AS.hook('home.hook', { id: 'prueba-alta', priority: 50, when: () => true, render: (c) => `<button class="rx-pocket rx-in fk-alto" style="--d:${c.d}">alto</button>` });
A.rerender(); await wait(20);
h = homeEl();
t('un solo anzuelo: gana el de mayor prioridad y Select no sale', !!h.querySelector('.fk-alto') && !h.querySelector('.rx-select-teaser'));
AS.hook('home.hook', { id: 'prueba-alta', priority: 50, when: () => false, render: () => '' });
AS.hook('home.strip', { id: 'prueba-cobro', priority: 1, render: () => '<button class="rx-strip t-warn fk-cobro">cobro</button>' });
A.rerender(); await wait(20);
t('home.strip se pinta (no cuenta como anzuelo: Select sigue)', !!homeEl().querySelector('.fk-cobro') && !!homeEl().querySelector('.rx-select-teaser'));
AS.hook('home.strip', { id: 'prueba-cobro', when: () => false });
await montar('en-camino'); await wait(20);
AS.hook('home.hook', { id: 'prueba-alta2', priority: 60, when: () => true, render: () => '<button class="fk-alto2">x</button>' });
A.rerender(); await wait(20);
t('con onway NO hay ningún anzuelo (ni uno registrado por otro módulo)', !homeEl().querySelector('.fk-alto2') && !homeEl().querySelector('.rx-select-teaser'));
AS.hook('home.hook', { id: 'prueba-alta2', priority: 60, when: () => false });
await montar('vacio');
w.state.settings._loaded = false; A.rerender(); await wait(20);
t('ajustes sin leer: franja rx-strip t-error', !!homeEl().querySelector('.rx-strip.t-error'));
t('franja de notificaciones sin push soportado: oculta', homeEl().querySelector('.rx-home-push').classList.contains('is-off'));
w.pushSupported = () => true;
if (!w.Notification) w.Notification = { permission: 'default' };
if (!('PushManager' in w)) w.PushManager = function () {};
// El permiso se mira al ENTRAR a Inicio (after), no en cada parche.
AS.setTab('viajes'); await wait(20); AS.setTab('inicio'); await wait(60);
const ps = homeEl().querySelector('.rx-home-push');
t('push soportado y sin suscripción: franja «Activa las notificaciones» (data-ax="enable-push")', ps && !ps.classList.contains('is-off') && ps.getAttribute('data-ax') === 'enable-push' && /Activa las notificaciones/.test(ps.textContent));
t('ningún id reservado de §2.4 en la base (tampoco #ax-pwa-bar)', !AS.FIXED_IDS.some(id => homeEl().querySelector('#' + id)));
delete w.pushSupported;

console.log('\n── Inicio y Viajes coinciden en los próximos ──');
const idsDe = (el, sel) => [...el.querySelectorAll(sel)].map(x => x.getAttribute('data-id'));
for (const n of E.list()) {
  await montar(n); await wait(10);
  const hh = homeEl();
  const hIds = idsDe(hh, '.rx-pass[data-id], .rx-live[data-id]');
  const m = /Ver tus (\d+) traslados/.exec(hh.textContent);
  const hN = m ? Number(m[1]) : hIds.length;
  AS.setTab('viajes'); await wait(20);
  const tIds = idsDe(tripsEl(), '.rx-pass[data-id]');
  const up = A.upcoming().map(x => x.id);
  t(`${n}: Inicio (${hN}) = Viajes (${tIds.length}) = upcoming (${up.length})`, hN === tIds.length && tIds.length === up.length && hIds.every(id => tIds.includes(id)) && tIds.every(id => up.includes(id)),
    `home ${hIds.join(',')} / viajes ${tIds.join(',')}`);
  AS.setTab('inicio'); await wait(10);
}

console.log('\n── Viajes: segmentado e historial ──');
await montar('historial');
AS.setTab('viajes'); await wait(20);
let tv = tripsEl();
t('cabecera grande «Viajes» sin atrás', /Viajes/.test(tv.querySelector('.rx-head.lg h1').textContent) && !tv.querySelector('.rx-head [data-rx="rx-pop"]'));
const segBtn = tv.querySelector('.rx-seg button[data-v="past"]');
const bodyAntes = tv.querySelector('.rx-body');
const segAntes = tv.querySelector('.rx-seg');
click(segBtn); await wait(10);
tv = tripsEl();
t('Historial: el cuerpo se RECREA con .rx-anim (key={v}) y el segmentado NO se repinta', tv.querySelector('.rx-body') !== bodyAntes && tv.querySelector('.rx-body').classList.contains('rx-anim') && tv.querySelector('.rx-seg') === segAntes && /translateX\(100%\)/.test(segAntes.querySelector('.rx-seg-ind').style.transform));
const rows = [...tv.querySelectorAll('.rx-hist')];
t('historial: 6 filas (entregados, cancelado, no-show, vencido)', rows.length === 6, rows.length);
t('historial: filas .rx-in con --d escalonado', rows.every((r, i) => r.classList.contains('rx-in') && r.getAttribute('style') === '--d:' + Math.min(i, 8)));
t('historial: vencido con chip «Sin realizar»', rows.some(r => /Sin realizar/.test(r.textContent)));
t('historial: ★5 y ★4 pintadas', rows.some(r => r.querySelectorAll('.rx-hist-s i.on').length === 5) && rows.some(r => r.querySelectorAll('.rx-hist-s i.on').length === 4));
t('historial: el entregado sin calificar (3 días) dice «Calificar»', rows.filter(r => r.querySelector('.rx-hist-rate')).length === 1);
t('historial: cancelado y no-show con su chip', rows.some(r => /Cancelado/.test(r.textContent)) && rows.some(r => /No te presentaste/.test(r.textContent)));
t('historial: «El Olivar → MDE» y «MDE → El Olivar» con su fecha · vuelo', rows.some(r => /El Olivar → MDE/.test(r.textContent)) && rows.some(r => /MDE → El Olivar/.test(r.querySelector('b').textContent)) && rows.every(r => / · /.test(r.querySelector('.rx-row-tx span').textContent)));
const rowCal = rows.find(r => r.querySelector('.rx-hist-rate'));
const idRow = rowCal.getAttribute('data-id');
click(rowCal.querySelector('.rx-hist-rate')); await wait(20);
t('«Calificar» abre el viaje con rate:true', A.state.view === 'trip' && A.state.editingTrip === idRow && A.state.rateOpen === idRow);
AS.setTab('viajes'); await wait(20);
t('volver del viaje deja Viajes en «Historial» (la pestaña no se re-montó, como en React)', w.AuxRxViajes.view() === 'past' && /translateX\(100%\)/.test(tripsEl().querySelector('.rx-seg-ind').style.transform) && tripsEl().querySelectorAll('.rx-hist').length === 6);
AS.setTab('inicio'); await wait(10); AS.setTab('viajes'); await wait(20);
t('ir a otra pestaña y volver: Viajes empieza en «Próximos» (key={tab})', w.AuxRxViajes.view() === 'next' && !tripsEl().querySelector('.rx-hist'));
click(tripsEl().querySelector('.rx-seg button[data-v="past"]')); await wait(10);
const rowOtra = [...tripsEl().querySelectorAll('.rx-hist')].find(r => !r.querySelector('.rx-hist-rate'));
click(rowOtra); await wait(20);
t('tocar otra fila abre el viaje SIN calificación', A.state.view === 'trip' && A.state.editingTrip === rowOtra.getAttribute('data-id') && !A.state.rateOpen);
await montar('vacio');
AS.setTab('viajes'); await wait(20);
t('Viajes vacío: «Sin traslados programados» + Pedir traslado (sec)', /Sin traslados programados/.test(tripsEl().textContent) && !!tripsEl().querySelector('.rx-btn.sec[data-ax="new"]'));
t('Viajes: ningún id reservado de §2.4', !AS.FIXED_IDS.some(id => tripsEl().querySelector('#' + id)));
AS.setTab('inicio'); await wait(10);

console.log('\n── Avisos y campana ──');
w.localStorage.removeItem('rendio.aux.avisos.seen');
await montar('asignado-publicado');
h = homeEl();
t('publicado: la campana muestra 1 (aviso «Ya tienes conductor» sin ver)', (h.querySelector('.rx-bell span') || {}).textContent === '1', h.querySelector('.rx-bell').textContent);
t('AuxRxAvisos.unseen() = 1', w.AuxRxAvisos.unseen() === 1);
click(h.querySelector('.rx-bell')); await wait(30);
let nt = notifsEl();
t('la campana abre «Notificaciones» (pila del shell)', !!nt && AS.current().id === 'notifs');
t('aviso «Ya tienes conductor» con conductor, hora y el día del viaje', /Ya tienes conductor/.test(nt.textContent) && /Mauricio Arango Pérez · Te recogemos a las 03:48/.test(nt.textContent) && /^Mañana/.test(nt.querySelector('.rx-nt em').textContent));
t('el no leído lleva su punto en esta visita', !!nt.querySelector('.rx-nt .rx-unread'));
t('al abrir quedan vistos (localStorage rendio.aux.avisos.seen)', w.AuxRxAvisos.unseen() === 0 && /pub:/.test(w.localStorage.getItem('rendio.aux.avisos.seen') || ''));
t('segmento Todas · Viajes · Mensajes (sin Pagos si nadie lo registra)', [...nt.querySelectorAll('.rx-seg button')].map(x => x.textContent).join('|') === 'Todas|Viajes|Mensajes');
const idPub = A.state.trips[0].id;
click(nt.querySelector('.rx-nt')); await wait(20);
t('tocar el aviso: pop() primero (la capa sale con .out)', !!q('[data-scr="notifs"].out') || !notifsEl());
await wait(300);
t('…y a los 280 ms abre ese viaje', A.state.view === 'trip' && A.state.editingTrip === idPub);
AS.setTab('inicio'); await wait(20);
t('de vuelta en Inicio la campana queda sin globo', !homeEl().querySelector('.rx-bell span'));
w.AuxRxCoord = { unread: () => 2 };
w.AuxRxInicio.refreshBell();
const globo = homeEl().querySelector('.rx-bell span');
t('cambia el conteo: el globo se RECREA con .rx-anim (key={unread}) sin repintar Inicio', !!globo && globo.textContent === '2' && globo.classList.contains('rx-anim'));
w.AuxRxCoord = { unread: () => 3 };
w.AuxRxInicio.refreshBell();
t('…y otra vez con el nuevo número', homeEl().querySelector('.rx-bell span') !== globo && homeEl().querySelector('.rx-bell span').textContent === '3');
delete w.AuxRxCoord; w.AuxRxInicio.refreshBell();

w.localStorage.removeItem('rendio.aux.avisos.seen');   // los ids del arnés se repiten entre escenarios
await montar('coordinacion-con-mensajes');
w.AuxRxCoord = { unread: () => 1 };
chat.counts = { [A.state.trips[0].id]: 2 };
await w.AuxRxAvisos.refresh(true);
A.rerender(); await wait(30);
h = homeEl();
t('campana = avisos no vistos + Coordinación (1 pub + 1 chat + 1 coord = 3)', (h.querySelector('.rx-bell span') || {}).textContent === '3', h.querySelector('.rx-bell').textContent);
t('Coordinación en accesos rápidos: «1 sin leer»', /1 sin leer/.test(h.querySelector('.rx-qa-b[data-rx="open-coord"]').textContent));
AS.push('notifs'); await wait(30);
nt = notifsEl();
t('aviso de chat «Tienes 2 mensajes sin leer» y el de Coordinación', /Tienes 2 mensajes sin leer/.test(nt.textContent) && /Coordinación te escribió/.test(nt.textContent));
const cuerpoAntes = nt.querySelector('.rx-body');
click(nt.querySelector('.rx-seg button[data-v="msg"]')); await wait(10);
nt = notifsEl();
const items = [...nt.querySelectorAll('.rx-nt')];
t('Mensajes: cuerpo RECREADO (.rx-anim) con solo chat y Coordinación', nt.querySelector('.rx-body') !== cuerpoAntes && nt.querySelector('.rx-body').classList.contains('rx-anim') && items.length === 2 && !/Ya tienes conductor/.test(nt.textContent));
t('avisos .rx-in con --d escalonado', items.every((x, i) => x.getAttribute('style') === '--d:' + i));
click(items.find(x => /Coordinación te escribió/.test(x.textContent))); await wait(320);
t('el de Coordinación: pop y a los 280 ms push(«coord»)', AS.current() && AS.current().id === 'coord');
AS.popAll(); await wait(20);
delete w.AuxRxCoord; chat.counts = {};

AS.hook('avisos.source', { id: 'prueba-pagos', list: () => [{ id: 'venc-1', icon: 'Wallet', tone: 'warn', title: 'Tu mensualidad vence mañana', body: 'Toca para pagar', when: 'Hoy' }] });
AS.push('notifs'); await wait(30);
nt = notifsEl();
t('con avisos.source registrado aparece «Pagos» y su aviso', [...nt.querySelectorAll('.rx-seg button')].some(x => x.textContent === 'Pagos') && /Tu mensualidad vence mañana/.test(nt.textContent));
AS.hook('avisos.source', { id: 'prueba-pagos', when: () => false, list: () => [] });
AS.popAll(); await wait(20);

w.localStorage.removeItem('rendio.aux.avisos.seen');
await montar('cancelado');
AS.push('notifs'); await wait(30);
t('cancelado: aviso «Traslado cancelado» con el motivo', /Traslado cancelado/.test(notifsEl().textContent) && /Me cambiaron la programación/.test(notifsEl().textContent));
AS.popAll(); await wait(20);
await montar('privado-rechazado');
AS.push('notifs'); await wait(30);
t('privado rechazado: aviso con el motivo y «Sigue como compartido»', /Tu privado no se pudo confirmar/.test(notifsEl().textContent) && /La camioneta ya está ocupada a esa hora\. Sigue como compartido\./.test(notifsEl().textContent));
AS.popAll(); await wait(20);
await montar('llego');
AS.push('notifs'); await wait(30);
t('llegó: aviso «Mauricio llegó por ti» con el código', /Mauricio llegó por ti/.test(notifsEl().textContent) && /Código de encuentro 4827/.test(notifsEl().textContent));
AS.popAll(); await wait(20);
await montar('vacio');
AS.push('notifs'); await wait(30);
t('sin nada: «Todo al día»', /Todo al día/.test(notifsEl().querySelector('.rx-empty').textContent));
AS.popAll(); await wait(20);

console.log('\n── Barrido de textos prohibidos (Inicio, Viajes ×2, Avisos) ──');
const malos = {};
for (const n of E.list()) {
  for (const noche of [false, true]) {
    await montar(n, { noche }); await wait(10);
    let txt = homeEl().textContent;
    AS.setTab('viajes'); await wait(15);
    txt += '\n' + tripsEl().textContent;
    click(tripsEl().querySelector('.rx-seg button[data-v="past"]')); await wait(5);
    txt += '\n' + tripsEl().textContent;
    AS.setTab('inicio'); await wait(10);
    AS.push('notifs'); await wait(20);
    txt += '\n' + (notifsEl() ? notifsEl().textContent : '');
    AS.popAll(); await wait(10);
    if (/Te recogemos\s*\d/.test(txt) && !E.datos(n).trips.some(x => x.published && x.pickupAt)) (malos['Te recogemos sin publicar'] = malos['Te recogemos sin publicar'] || []).push(n);
    for (const [nom, re] of PROHIBIDOS) if (re.test(txt)) (malos[nom] = malos[nom] || []).push(n + (noche ? ' (noche)' : ''));
  }
}
t(`${E.list().length} escenarios × día/noche sin textos prohibidos ni «Te recogemos» sin publicar`, Object.keys(malos).length === 0, JSON.stringify(malos));

console.log('\n── Errores ──');
const errs = b.errors.filter(e => !/ids reservados/.test(e) || true);
t('sin errores de consola ni excepciones', errs.length === 0, errs.slice(0, 4).join(' | '));

console.log('\n── Bandera APAGADA ──');
const off = await boot({ flag: false });
off.E.montar('asignado-publicado'); await wait(30);
t('apagada: los módulos cargan sin pintar nada del rediseño', !!off.w.AuxRxInicio && !off.q('.rx-app') && !off.q('.rx-pass'));
t('apagada: la UI de siempre (ax-head «Mis viajes»)', /Mis viajes/.test(off.ui().textContent));
t('apagada: sin errores', off.errors.length === 0, off.errors.slice(0, 3).join(' | '));

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout ni animación real (jsdom), Leaflet real (tiles/tamaño), push real, el saludo en los');
console.log('          bordes de hora (usa el reloj de la máquina). Revisar en el teléfono antes de dar por bueno.');
process.exit(bad ? 1 : 0);
