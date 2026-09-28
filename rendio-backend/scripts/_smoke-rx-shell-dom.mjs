// P2 · SHELL del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + auxiliar.js + aux-shell.js) con la bandera
// ENCENDIDA (localStorage rendio.aux.rx='1') y pantallas FALSAS registradas con
// AuxShell.register(), para probar el marco sin depender de las pantallas de la
// Ola 1b. Comprueba la aceptación de P2 (plan final §5) y lo que AJUSTES §3/§8
// le pide al shell:
//   · 5 pestañas en el orden del diseño y el + con data-ax="new";
//   · pestaña nueva = .rx-tabview RECREADA; la misma = .rx-noanim + scrollTop;
//   · form crea .rx-layer.modal; popstate en el paso 3 lleva al 2;
//   · con la alarma abierta, popstate la cierra por patch y NO llama stopTrack;
//   · pila propia (open-coord → rx-pop con .out a 270 ms, la de abajo se revela);
//   · hoja (.out a 220 ms, tocar el fondo cierra), toast 1800 ms, banner 4000 ms;
//   · postMessage del service worker (fixtures/fake-sw.js) pinta .rx-push;
//   · #/viaje?r=X abre ese viaje (en frío y por hashchange), #/avisos, #/pagos;
//   · hooks('home.hook') devuelve uno solo; el punto de Pagos lee AuxPagos.summary();
//   · un id de §2.4 dentro de la base hace fallar la revisión (y el shell lo avisa);
//   · privado apila Select sobre el pedido; confirm y onboarding sin deslizar;
//   · registro tardío, esqueleto recreado, rekey(), bandera apagada = camino viejo.
// Al final, si ya hay pantallas REALES registradas por aux-rx-*.js, las pinta como
// pestaña y revisa que no traigan ids de §2.4 (hoy son stubs: 0 pantallas).
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba que las
// capas se deslicen de verdad, ni getAnimations/finish de .rx-noanim, ni los
// márgenes seguros), no hay gesto real de atrás de Android, ni push real del
// sistema (el SW es falso), ni Leaflet real (aquí ni se monta mapa).
//
//   cd rendio-backend/scripts && node _smoke-rx-shell-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = f => readFileSync(APP + f, 'utf8');
const readFix = f => readFileSync(FIX + f, 'utf8');
let ok = 0, bad = 0, warn = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const HOY = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const TRIPS = () => [
  { id: 'v1', type: 'sal', date: HOY, time: '05:10', address: 'El Olivar', status: 'assigned', notes: '',
    driver: { name: 'Pedro Ruiz', phone: '3000000000' }, pickupAt: null },
  { id: 'v2', type: 'lle', date: HOY, time: '21:40', address: 'El Olivar', status: 'pending', notes: '' },
  { id: 'v3', type: 'sal', date: '2026-09-01', time: '04:00', address: 'El Olivar', status: 'done', notes: '',
    driver: { name: 'Ana Gil' }, rated: true },
];
const FIXED = ['ax-track-map', 'ax-eta-label', 'ax-eta-min', 'ax-eta', 'ax-count', 'ax-wait', 'ax-late-wrap', 'ax-track-fresh',
  'ax-onboard-badge', 'ax-chat', 'ax-chat-body', 'ax-chat-input', 'ax-alarm-text', 'ax-cancel-reason', 'ax-map', 'ax-pin-row',
  'ax-time-hints', 'ax-pwa-bar', 'axr-q', 'ax-meet', 'ax-phase'];

// Arranca la app en jsdom con la bandera encendida. `screens` = true registra las
// pantallas falsas; `real` carga además los aux-rx-*.js de verdad.
async function boot({ url = 'http://localhost/', screens = true, real = false } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  w.RENDIO_CONFIG = {};
  const toasts = [];
  w.toast = (m) => toasts.push(m);
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  w.eval(readFix('fake-sw.js'));
  w.eval(readFix('fake-leaflet.js'));
  w.localStorage.setItem('rendio.aux.rx', '1');
  w.localStorage.setItem('rendio.aux.onboarded.u1', '1');   // la marca es por perfil (aux-presentacion)
  let reloads = 0;
  const data = { trips: TRIPS() };
  w.Api = {
    listMyReservations: async () => data.trips.map(x => ({ ...x })),
    getMyAuxHeader: async () => ({ airlineName: 'Avianca', joinedAt: '2026-03-14', preferredLevel: null, meetingPoint: '' }),
    listResidences: async () => [], getMyAuxiliarPlace: async () => ({}), getSettings: async () => ({ aux_min_lead_hours: 6 }),
    notesUser: (n) => String(n || ''),
  };
  w.state = { settings: { aux_min_lead_hours: 6 } };
  w.eval(read('aux-shell.js'));
  if (real) {
    for (const f of ['aux-rx-ui.js', 'api-aux.js', 'api-cobro.js', 'api-puntos.js']) { try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); } }
  }
  for (const f of ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js']) w.eval(read(f));
  if (real) {
    for (const f of ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js',
      'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js']) { try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); } }
  }
  w.eval(read('auxiliar.js'));
  const A = w.Auxiliar, AS = w.AuxShell;
  // reloadTrips de PL todavía es stub en P0: se cuenta y se deja pasar.
  const origReload = A.reloadTrips;
  A.reloadTrips = async () => { reloads++; return origReload(); };
  const log = { render: {}, after: {}, destroy: {}, patch: {} };
  if (screens) registerFakes(w, AS, log);
  await A.init({ id: 'u1', role: 'auxiliar', full_name: 'Laura Gómez', is_active: true });
  await wait(20);
  const ui = () => w.document.getElementById('auxiliar-ui');
  return { w, A, AS, ui, log, errors, toasts, data, reloads: () => reloads,
    q: (s) => ui().querySelector(s), qa: (s) => [...ui().querySelectorAll(s)] };
}

function registerFakes(w, AS, log) {
  const bump = (k, id) => { log[k][id] = (log[k][id] || 0) + 1; };
  const body = (id, extra = '') => `<div class="rx-scr"><div class="rx-body"><b class="fk">${id}</b>${extra}</div></div>`;
  const simple = (id, extra, more = {}) => AS.register(id, Object.assign({
    render: (ctx) => { bump('render', id); return body(id, typeof extra === 'function' ? extra(ctx) : (extra || '')); },
    after: () => bump('after', id),
    destroy: () => bump('destroy', id),
  }, more));
  simple('home', '<button data-rx="open-notifs" class="fk-bell">avisos</button><button data-ax="trip" data-id="v1" class="fk-v1">v1</button>');
  simple('trips');
  simple('pay');
  // 'me' queda SIN registrar para probar el registro tardío.
  simple('book', (ctx) => `<div class="rx-step" data-step="${ctx.state.step}">paso ${ctx.state.step}</div><div id="ax-time-hints"></div><button data-rx="rx-pop" class="fk-x">x</button>`);
  simple('booked', '<button data-ax="home" class="fk-listo">Listo</button>');
  simple('select', (ctx) => `<i class="fk-from">${ctx.props.from}</i>`, { dark: true });
  simple('notifs', '<button data-rx="rx-pop" class="fk-back">atrás</button>');
  simple('coord', (ctx) => `<i class="fk-res">${ctx.props.reservationId || ''}</i><button data-rx="rx-pop" class="fk-back">atrás</button>`);
  simple('onboarding');
  // trip: la alarma va por patch, en la hoja del shell, sin rehacer la capa.
  let alarmShown = null;
  const paintAlarm = (ctx) => {
    const host = w.document.querySelector('#auxiliar-ui .rx-sheet-host');
    const has = !!ctx.state.alarm;
    const el = host.querySelector('.fk-alarm');
    if (has && !el) host.insertAdjacentHTML('beforeend', '<div class="rx-sheet-bg fk-alarm"><div class="rx-sheet"><textarea id="ax-alarm-text"></textarea></div></div>');
    if (!has && el) el.remove();
    alarmShown = has;
  };
  AS.register('trip', {
    render: (ctx) => { bump('render', 'trip'); return body('trip', `<div id="ax-track-map" class="fk-map"></div><button data-ax="alarm" class="fk-alarm-btn">!</button>`
      + `<button data-rx="open-coord" data-id="${ctx.trip ? ctx.trip.id : ''}" class="fk-coord">coord</button><button data-rx="rx-pop" class="fk-back">atrás</button>`); },
    after: (ctx) => { bump('after', 'trip'); paintAlarm(ctx); },
    patch: (ctx) => {
      bump('patch', 'trip');
      if (!!ctx.state.alarm !== alarmShown) { paintAlarm(ctx); return true; }
      return false;
    },
    destroy: () => { bump('destroy', 'trip'); const a = w.document.querySelector('#auxiliar-ui .fk-alarm'); if (a) a.remove(); alarmShown = null; },
  });
}

const baseIds = (b) => FIXED.filter(id => b.q('.rx-base').querySelector('#' + id));
// El atrás del teléfono: history.back() de verdad (jsdom dispara popstate al
// sacar la entrada). Si el shell no dejó el centinela, back() no hace nada y la
// prueba lo nota.
const popstate = async (b) => { b.w.history.back(); await wait(25); };
const click = (el) => el && el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── contrato y bandera ──');
{
  const b = await boot();
  const { AS, w, q, qa, A } = b;
  const CONTRATO = ['on', 'skin', 'render', 'register', 'push', 'pop', 'popAll', 'setTab', 'current', 'sheet', 'closeSheet', 'toast',
    'banner', 'action', 'hook', 'hooks', 'refreshTrips'];
  const faltan = CONTRATO.filter(k => typeof AS[k] !== 'function');
  t('window.AuxShell trae el contrato de §5 P2', faltan.length === 0, faltan.join(','));
  t('tiempos del diseño: capa 270 · hoja 220 · toast 1800 · banner 4000',
    AS.T.layerOut === 270 && AS.T.sheetOut === 220 && AS.T.toast === 1800 && AS.T.banner === 4000, JSON.stringify(AS.T));
  t('RX_DEFAULT apagado hasta la integración', AS.RX_DEFAULT === false);
  t('bandera por localStorage: on() con «1»', AS.on() === true);
  t('#auxiliar-ui lleva rx-phone (skin)', b.ui().classList.contains('rx-phone'));
  t('esqueleto: .rx-app con base, capas, hoja, toast y banner',
    !!q('.rx-app > .rx-base > .rx-tabs') && !!q('.rx-app > .rx-layers') && !!q('.rx-app > .rx-sheet-host') && !!q('.rx-app > .rx-toast-host') && !!q('.rx-app > .rx-push-host'));

  console.log('\n── pestañas ──');
  const btns = [...q('.rx-tabs').children];
  t('5 botones en la barra: Inicio, Viajes, +, Pagos, Perfil', btns.length === 5
    && btns.map(x => x.dataset.tab || (x.classList.contains('rx-fab') ? '+' : '?')).join(',') === 'inicio,viajes,+,pagos,perfil',
    btns.map(x => x.textContent.trim() || x.className).join(','));
  t('el + es .rx-fab con data-ax="new"', btns[2].classList.contains('rx-fab') && btns[2].dataset.ax === 'new');
  t('textos de las pestañas', ['Inicio', 'Viajes', 'Pagos', 'Perfil'].every((l, i) => [btns[0], btns[1], btns[3], btns[4]][i].textContent.trim() === l));
  t('cada pestaña con su ícono (.rx-tab-ic svg)', [0, 1, 3, 4].every(i => !!btns[i].querySelector('.rx-tab-ic svg')));
  t('arranca en Inicio: .rx-tabview[data-scr=home] y Inicio .on', !!q('.rx-tabview[data-scr="home"]') && btns[0].classList.contains('on'));
  t('Inicio no deja entrada en el historial', w.history.state == null);
  t('la base no trae ids de §2.4 (Inicio)', baseIds(b).length === 0, baseIds(b).join(','));

  const tvHome = q('.rx-tabview');
  click(q('.rx-tabs [data-tab="viajes"]'));
  const tvTrips = q('.rx-tabview');
  t('pestaña nueva: la tabview se RECREA (key={tab})', tvTrips !== tvHome && tvTrips.dataset.scr === 'trips' && !tvHome.isConnected);
  t('.on pasa a Viajes', q('.rx-tabs [data-tab="viajes"]').classList.contains('on') && !btns[0].classList.contains('on'));
  t('fuera de Inicio hay una entrada en el historial', w.history.state && w.history.state.rx === 1);
  t('la tabview nueva entra sin .rx-noanim', !tvTrips.querySelector('.rx-noanim') && !tvTrips.firstChild.classList.contains('rx-noanim'));

  // Repintar la misma pestaña: mismo nodo, .rx-noanim, scroll conservado.
  q('.rx-tabview .rx-body').scrollTop = 120;
  const r0 = b.log.render.trips;
  A.rerender();
  const host = q('.rx-tabview > .rx-scrhost');
  t('misma pestaña: el nodo NO se recrea', q('.rx-tabview') === tvTrips && b.log.render.trips === r0 + 1);
  t('misma pestaña: repinta con .rx-noanim', host.classList.contains('rx-noanim'));
  t('misma pestaña: conserva el scrollTop de .rx-body', q('.rx-tabview .rx-body').scrollTop === 120, String(q('.rx-tabview .rx-body').scrollTop));
  t('repintado completo: destroy() antes de rehacer el DOM', b.log.destroy.trips >= 1);

  await popstate(b);
  t('atrás en Viajes (sin capas) vuelve a Inicio', q('.rx-tabview').dataset.scr === 'home' && A.state.view === 'home');
  await wait(30);
  t('de vuelta en Inicio el centinela se retira', w.history.state == null, JSON.stringify(w.history.state));

  console.log('\n── pedido (modal), pasos y atrás ──');
  click(q('.rx-fab'));
  const book = q('.rx-layer[data-scr="book"]');
  t('el + abre form: .rx-layer.modal[data-scr=book]', !!book && book.classList.contains('modal'));
  t('la base queda .behind', q('.rx-base').classList.contains('behind'));
  t('el pie del pedido puede llevar ids de §2.4 (fuera de la base)', !!book.querySelector('#ax-time-hints') && baseIds(b).length === 0);
  A.state.step = 3; A.rerender();
  t('paso 3 en la misma capa (sin recrearla)', q('.rx-layer[data-scr="book"]') === book && book.querySelector('.rx-step').dataset.step === '3');
  await popstate(b);
  t('popstate en el paso 3 lleva al 2', A.state.step === 2 && A.state.view === 'form', 'step=' + A.state.step);
  t('…sin recrear la capa y con .rx-noanim', q('.rx-layer[data-scr="book"]') === book && book.querySelector('.rx-scrhost').classList.contains('rx-noanim'));
  t('…y el centinela vuelve a quedar puesto', w.history.state && w.history.state.rx === 1);
  await popstate(b);
  await popstate(b);
  t('del paso 1, atrás cierra el pedido', A.state.view === 'home');
  t('la capa sale con .out (modal → rxDown)', book.classList.contains('out') && book.isConnected);
  t('la base ya no está .behind', !q('.rx-base').classList.contains('behind'));
  await wait(290);
  t('a los 270 ms la capa se quita', !book.isConnected);

  console.log('\n── viaje, alarma por patch y pila propia ──');
  let stops = 0;
  A.stopTrack = () => { stops++; };
  click(q('.fk-v1'));
  const trip = q('.rx-layer[data-scr="trip"]');
  t('data-ax="trip" abre .rx-layer[data-scr=trip] (push, no modal)', !!trip && !trip.classList.contains('modal'));
  t('abrir el viaje desmonta el rastreo anterior (stopTrack)', stops === 1, 'stops=' + stops);
  const map = trip.querySelector('.fk-map');
  const s0 = stops;
  click(trip.querySelector('.fk-alarm-btn'));
  t('alarma: se pinta por patch en .rx-sheet-host', !!q('.rx-sheet-host .fk-alarm') && b.log.patch.trip >= 1);
  t('alarma: NO llama stopTrack ni rehace la capa/mapa', stops === s0 && trip.querySelector('.fk-map') === map && q('.rx-layer[data-scr="trip"]') === trip);
  await popstate(b);
  t('popstate con la alarma abierta la cierra', A.state.alarm == null && !q('.rx-sheet-host .fk-alarm'));
  t('…y tampoco llama stopTrack', stops === s0 && trip.querySelector('.fk-map') === map, 'stops=' + stops);
  t('…la capa del viaje sigue ahí', A.state.view === 'trip' && trip.isConnected && !trip.classList.contains('out'));

  click(trip.querySelector('.fk-coord'));
  const coord = q('.rx-layer[data-scr="coord"]');
  t('open-coord apila coord encima del viaje', !!coord && AS.current().id === 'coord' && coord.querySelector('.fk-res').textContent === 'v1');
  t('el viaje queda .behind debajo', trip.classList.contains('behind'));
  const tripRenders = b.log.render.trip;
  click(coord.querySelector('.fk-back'));
  t('rx-pop saca coord con .out', coord.classList.contains('out') && AS.current().id === 'trip');
  t('el viaje se revela: sin .behind y repintado (datos frescos)', !trip.classList.contains('behind') && b.log.render.trip === tripRenders + 1);
  await wait(290);
  t('coord se quita a los 270 ms', !coord.isConnected);
  await popstate(b);
  t('atrás desde el viaje vuelve a Inicio', A.state.view === 'home' && trip.classList.contains('out'));
  await wait(300);

  console.log('\n── pila propia desde Inicio ──');
  click(q('.fk-bell'));
  const nt = q('.rx-layer[data-scr="notifs"]');
  t('open-notifs abre avisos encima de Inicio', !!nt && q('.rx-base').classList.contains('behind'));
  click(q('.rx-tabs [data-tab="pagos"]'));
  t('cambiar de pestaña vacía la pila sin animación (popAll)', !nt.isConnected && q('.rx-tabview').dataset.scr === 'pay');
  t('Pagos: view home + tab pagos', A.state.view === 'home' && A.state.tab === 'pagos');
  await popstate(b);
  t('atrás en Pagos vuelve a Inicio', q('.rx-tabview').dataset.scr === 'home');

  console.log('\n── punto de Pagos (AuxPagos.summary) ──');
  const dot = () => q('.rx-tabs [data-tab="pagos"] .rx-dot');
  t('sin AuxPagos: sin punto', !dot());
  w.AuxPagos = { summary: () => ({ status: 'vencido' }), paused: () => false };
  A.rerender();
  t('vencido → .rx-dot.err', dot() && dot().classList.contains('err'));
  const d1 = dot(); A.rerender();
  t('repintar no recrea el punto (su pulso no se reinicia)', dot() === d1);
  w.AuxPagos.summary = () => ({ status: 'porVencer' }); A.rerender();
  t('porVencer → .rx-dot.warn', dot() && dot().classList.contains('warn') && !dot().classList.contains('err'));
  w.AuxPagos.summary = () => ({ status: 'review' }); A.rerender();
  t('en revisión → sin punto', !dot());
  w.AuxPagos.summary = () => { throw new Error('x'); }; A.rerender();
  t('si summary() revienta, sin punto y sin romper', !dot() && !!q('.rx-tabview'));
  delete w.AuxPagos;

  console.log('\n── enganches ──');
  AS.hook('home.hook', { id: 'a', priority: 1, when: () => true });
  AS.hook('home.hook', { id: 'b', priority: 5, when: () => false });
  AS.hook('home.hook', { id: 'c', priority: 3, when: () => true });
  AS.hook('home.hook', { id: 'd', priority: 9, when: () => { throw new Error('x'); } });
  const hk = AS.hooks('home.hook');
  t('hooks("home.hook") devuelve UNO solo: el de mayor prioridad con when()', hk.length === 1 && hk[0].id === 'c', hk.map(h => h.id).join(','));
  AS.hook('home.strip', { id: 's1', priority: 1 }); AS.hook('home.strip', { id: 's2', priority: 2 });
  t('home.strip no es anzuelo: devuelve todos, por prioridad', AS.hooks('home.strip').map(h => h.id).join(',') === 's2,s1');
  AS.hook('home.strip', { id: 's1', priority: 7 });
  t('registrar el mismo id lo reemplaza', AS.hooks('home.strip').map(h => h.id).join(',') === 's1,s2');

  console.log('\n── hoja, toast y banner ──');
  let closed = 0;
  const sh = AS.sheet((close) => '<div class="rx-sh"><h3>Hola</h3><button data-rx="sheet-close" class="fk-c">cerrar</button></div>', { onClose: () => closed++ });
  const bg = q('.rx-sheet-bg');
  t('sheet(): .rx-sheet-bg > .rx-sheet con .rx-grab y el contenido', !!bg && !!sh && !!sh.querySelector('.rx-grab') && !!sh.querySelector('h3'));
  t('una hoja abierta pone el centinela', w.history.state && w.history.state.rx === 1);
  AS.sheet('<div class="rx-sh"><h3>Otra</h3></div>', { onClose: () => closed++ });
  t('abrir otra con una abierta cambia el contenido sin re-animar (mismo nodo)', q('.rx-sheet-bg') === bg && /Otra/.test(bg.textContent));
  click(bg);
  t('tocar el fondo la cierra con .out', bg.classList.contains('out'));
  await wait(240);
  t('a los 220 ms se desmonta y llama onClose', !bg.isConnected && closed === 1);
  await wait(20);
  AS.sheet('<div class="rx-sh"><button data-rx="sheet-close" class="fk-c">x</button></div>');
  await popstate(b);
  t('popstate cierra la hoja', q('.rx-sheet-bg') && q('.rx-sheet-bg').classList.contains('out'));
  await wait(240);

  AS.toast('Listo, ya avisamos', 'Check');
  const to = q('.rx-toast');
  t('toast: .rx-toast con ícono y texto', !!to && /Listo, ya avisamos/.test(to.textContent) && !!to.querySelector('svg'));
  AS.toast('Otro');
  t('cada toast es un nodo nuevo (key={id})', q('.rx-toast') !== to && !to.isConnected && q('.rx-toast').textContent === 'Otro');
  AS.toast('<b>x</b>');
  t('el toast escapa el texto', !q('.rx-toast b') && /<b>x<\/b>/.test(q('.rx-toast').textContent));

  const r0b = b.reloads();
  w.__fakeSW.post({ type: 'rendio-push', title: 'Tu conductor va por ti', body: 'Carro ABC123.', url: '/#/viaje?r=v1' });
  await wait(20);
  const pu = q('.rx-push');
  t('postMessage del SW pinta .rx-push («Rendio · ahora»)', !!pu && /Tu conductor va por ti/.test(pu.textContent) && /ahora/.test(pu.textContent));
  t('…y pide refrescar los viajes', b.reloads() > r0b);
  w.__fakeSW.post({ type: 'otro', title: 'no' });
  t('un mensaje que no es rendio-push se ignora', q('.rx-push') === pu);
  await wait(1800);
  t('a los 1800 ms el toast se va', !q('.rx-toast'));
  click(q('.rx-push'));
  await wait(20);
  t('tocar el banner abre el viaje de su url', A.state.view === 'trip' && A.state.editingTrip === 'v1' && !q('.rx-push'));
  AS.banner({ title: 'Prueba', body: 'x' });
  const pu2 = q('.rx-push');
  await wait(4050);
  t('el banner se va solo a los 4000 ms', !pu2.isConnected);
  AS.setTab('inicio');
  await wait(300);

  console.log('\n── enlaces profundos (hashchange) ──');
  w.location.hash = '#/avisos';
  await wait(30);
  t('#/avisos abre avisos', AS.current() && AS.current().id === 'notifs');
  t('…y limpia el hash', w.location.hash === '');
  w.location.hash = '#/pagos';
  await wait(30);
  t('#/pagos lleva a la pestaña Pagos', q('.rx-tabview').dataset.scr === 'pay' && !q('.rx-layer:not(.out)'));
  w.location.hash = '#/viaje?r=v2';
  await wait(30);
  t('#/viaje?r=v2 abre ese viaje', A.state.view === 'trip' && A.state.editingTrip === 'v2');
  w.location.hash = '#/viaje?r=NOPE';
  await wait(40);
  t('un viaje que no está: aviso honesto y no abre nada', A.state.editingTrip === 'v2' && /ya no está/.test((q('.rx-toast') || {}).textContent || ''));
  AS.setTab('inicio');
  await wait(300);

  console.log('\n── privado (Select sobre el pedido), confirm y onboarding ──');
  click(q('.rx-fab'));
  const book2 = q('.rx-layer[data-scr="book"]');
  A.state.view = 'privado'; A.rerender();
  const sel = q('.rx-layer[data-scr="select"]');
  t('privado apila Select encima del pedido (el pedido no se recrea)', !!sel && q('.rx-layer[data-scr="book"]') === book2 && book2.classList.contains('behind'));
  t('Select recibe {from:"form"} y marca data-top-dark', sel.querySelector('.fk-from').textContent === 'form' && q('.rx-app').getAttribute('data-top-dark') === '1');
  await popstate(b);
  t('atrás desde Select vuelve al pedido: Select sale con .out', A.state.view === 'form' && sel.classList.contains('out'));
  t('…el pedido se revela sin .behind', !book2.classList.contains('behind') && q('.rx-app').getAttribute('data-top-dark') == null);
  await wait(290);
  A.state.view = 'confirm'; A.state.editingTrip = 'v2'; A.rerender();
  t('confirm: .rx-full[data-scr=booked] y el pedido se quita YA (sin deslizar)', !!q('.rx-full[data-scr="booked"]') && !book2.isConnected);
  click(q('.fk-listo'));
  t('«Listo» (data-ax=home): vuelve a Inicio y quita booked sin animación', A.state.view === 'home' && !q('.rx-full') && !q('.rx-base').classList.contains('behind'));
  A.state.view = 'onboarding'; A.state.onbStep = 0; A.rerender();
  t('onboarding: pantalla completa y SIN base ni pestañas', !!q('.rx-full[data-scr="onboarding"]') && q('.rx-base').classList.contains('rx-nobase') && !q('.rx-tabview'));
  A.state.view = 'home'; A.rerender();
  t('al salir de la bienvenida la base vuelve (tabview nueva)', !!q('.rx-tabview[data-scr="home"]') && !q('.rx-base').classList.contains('rx-nobase'));
  await wait(30);

  console.log('\n── registro tardío, esqueleto, rekey ──');
  click(q('.rx-tabs [data-tab="perfil"]'));
  t('pestaña sin pantalla registrada: «Todavía no disponible» (honesto)', /Todavía no disponible/.test(q('.rx-tabview').textContent) && AS.current().placeholder);
  AS.register('me', { render: () => '<div class="rx-scr"><div class="rx-body"><b class="fk-me">perfil real</b></div></div>' });
  await wait(10);
  t('registro tardío: se repinta sola con la pantalla real', !!q('.fk-me') && !AS.current().placeholder);
  AS.register('me', { render: () => { throw new Error('boom'); } });
  A.rerender();
  t('si una pantalla revienta al pintar: aviso honesto + console.error', /No pudimos mostrar/.test(q('.rx-tabview').textContent) && b.errors.some(e => /falló al pintar/.test(e)));
  b.ui().innerHTML = '';
  A.rerender();
  t('si alguien vacía #auxiliar-ui, el esqueleto se rearma', !!q('.rx-app .rx-tabs') && !!q('.rx-tabview'));
  const wrap = w.document.createElement('div'); wrap.innerHTML = '<span class="k">1</span>'; w.document.body.appendChild(wrap);
  const old = wrap.firstChild, nu = AS.rekey(old, '<span class="k">2</span>');
  t('rekey() recrea el nodo (la animación vuelve a correr)', nu && nu !== old && !old.isConnected && nu.textContent === '2');

  console.log('\n── ids de §2.4 en la base ──');
  const e0 = b.errors.length;
  AS.register('trips', { render: () => '<div class="rx-scr"><div class="rx-body"><div id="ax-track-map"></div></div></div>' });
  AS.setTab('viajes');
  t('la revisión de la prueba DETECTA un id reservado en la base', baseIds(b).join(',') === 'ax-track-map');
  t('…y el shell lo avisa por consola', b.errors.slice(e0).some(e => /ids reservados/.test(e)));

  console.log('\n── bandera apagada ──');
  const homeRenders = b.log.render.home || 0;
  w.localStorage.setItem('rendio.aux.rx', '0');
  A.state.view = 'home'; A.state.tab = 'inicio';
  A.rerender();
  t('con rendio.aux.rx=0 auxRender vuelve al camino de siempre', !q('.rx-app') && (b.log.render.home || 0) === homeRenders && b.ui().textContent.length > 0);
  AS.skin(false);
  t('skin(false) quita rx-phone', !b.ui().classList.contains('rx-phone'));
  w.localStorage.setItem('rendio.aux.rx', '1');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── enlace profundo en frío y ?rx=1 ──');
{
  const b = await boot({ url: 'http://localhost/?rx=1#/viaje?r=v1' });
  await wait(30);
  t('en frío, #/viaje?r=v1 abre ese viaje al arrancar', b.A.state.view === 'trip' && b.A.state.editingTrip === 'v1' && !!b.q('.rx-layer[data-scr="trip"]'));
  t('…y deja el hash limpio', b.w.location.hash === '');
  t('?rx=1 fija la bandera en localStorage', b.w.localStorage.getItem('rendio.aux.rx') === '1');
  t('el viaje abierto en frío deja atrás con un nivel (centinela)', b.w.history.state && b.w.history.state.rx === 1);
  await popstate(b);
  t('atrás desde el viaje en frío → Inicio', b.A.state.view === 'home');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── pantallas reales ya registradas (aux-rx-*.js) ──');
{
  const b = await boot({ screens: false, real: true });
  const tabs = [['inicio', 'home'], ['viajes', 'trips'], ['pagos', 'pay'], ['perfil', 'me']];
  const reales = tabs.filter(([, id]) => b.AS.registered(id));
  console.log('  · pantallas de pestaña registradas por los módulos: ' + (reales.map(r => r[1]).join(', ') || 'ninguna (siguen en stub)'));
  for (const [tab, id] of reales) {
    b.AS.setTab(tab);
    await wait(20);
    const ids = baseIds(b);
    t(`«${id}» real no trae ids de §2.4 en la base`, ids.length === 0, ids.join(','));
  }
  const errs = b.errors.filter(e => !/ids reservados/.test(e));
  if (errs.length) { warn += errs.length; console.log('  ⚠ errores de consola de otros módulos (no cuentan como fallo de P2):\n    ' + errs.slice(0, 6).join('\n    ')); }
  t('el shell arranca con los módulos reales cargados', !!b.q('.rx-app .rx-tabs'));
}

console.log(`\n${ok} ✓ · ${bad} ✗${warn ? ' · ' + warn + ' ⚠' : ''}`);
console.log('NO cubre: layout ni animación real (jsdom), getAnimations/finish de .rx-noanim, márgenes seguros,');
console.log('          gesto de atrás de Android real, push real del sistema, Leaflet real.');
process.exit(bad ? 1 : 0);
