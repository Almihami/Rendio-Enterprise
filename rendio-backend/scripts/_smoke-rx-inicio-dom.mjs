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
//
// NO CUBRE: layout ni animación real (jsdom no pinta: que el pase, el mapa o las
// entradas .rx-in se VEAN bien hay que revisarlo en el teléfono), Leaflet real
// (tiles, tamaño), push real del sistema (el SW es falso), ni la hora de Bogotá
// en los bordes del día (el saludo depende del reloj de la máquina).
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
