// aux-shell.js — P2 · Shell del auxiliar (rediseño del 27-sep-2026).
//
// Es el marco del rediseño: esqueleto persistente dentro de #auxiliar-ui, las
// 5 pestañas (Inicio, Viajes, +, Pagos, Perfil), la pila de capas, la hoja
// inferior, el toast, el banner de push, el botón atrás del teléfono, los
// enlaces profundos y los enganches de Inicio. NO pinta ninguna pantalla: las
// pantallas las registran sus módulos (aux-rx-*.js) con AuxShell.register().
//
// Plan final §2 (estrangulador con bandera) + AJUSTES §3 y §8. Los tiempos son
// los del JS del diseño (rx-app.jsx y rx-core.jsx), idénticos:
//   · pila: la de arriba sale con .out y se quita a los 270 ms (pop);
//   · hoja: .out y se desmonta a los 220 ms; tocar el fondo también la cierra;
//   · toast: 1800 ms; banner de push: 4000 ms;
//   · pestaña: la .rx-tabview se RECREA al cambiar de pestaña (key={tab}), así
//     corre su rxFade; repintar la misma pantalla va con .rx-noanim.
// Las animaciones mismas están en rx-auxiliar.css (generado, de P1).
//
// Cómo decide qué se ve (§2.3):
//   base      = la pestaña (home/trips/pay/me) según Auxiliar.state.view/.tab;
//   capas     = las que pide la vista (form→book, confirm→booked, trip→trip o
//               rate, privado→book+select, support, onboarding) + la pila propia
//               del shell (notifs, coord, flight, select, residence…);
//   hoja      = AuxShell.sheet() en .rx-sheet-host.
// Un cambio de vista (o de pestaña) vacía la pila propia.
//
// Contrato (plan §5 «P2»):
//   AuxShell = { on(), skin(on), render(), register(id,{layer,dark,render,after,patch,destroy}),
//     push, pop, popAll, setTab, current, sheet, closeSheet, toast, banner, action, hook, hooks,
//     refreshTrips }
//   + extras que no rompen el contrato: registered(id), rekey(el,html), ic(name,size),
//     FIXED_IDS, RX_DEFAULT, T (tiempos).
//
// Ciclo de vida de una pantalla registrada (lo que las demás olas programan):
//   render(ctx) → string HTML (o un Node). ctx = {id, key, kind, props, tab, reason,
//                 state, trip, el, host, shell}. reason: 'enter' | 'repaint' | 'reveal'.
//   after(ctx)  → después de insertar (mapas, rastreo, foco…).
//   patch(ctx)  → solo si la MISMA pantalla sigue arriba; devuelve true si ya se
//                 actualizó sola (no se toca el DOM ni se llama stopTrack).
//   destroy(ctx)→ antes de tirar su DOM: al salir (reason 'leave') y antes de un
//                 repintado completo (reason 'repaint'/'reveal'). No se llama si
//                 patch() devolvió true, ni cuando solo queda TAPADA por otra capa
//                 (para saber si se ve, AuxShell.current()).
//   layer: 'tab' | 'push' | 'modal' | 'full' (por defecto, el de la tabla §2.3).
//   dark: true → .rx-app[data-top-dark="1"] mientras esté arriba.
//   noBase: true → la base (pestañas) no se pinta mientras esté arriba (onboarding).
(function () {
  'use strict';

  // ── Bandera (plan §2.1) ────────────────────────────────────────────────────
  // Encendido desde la integración (Ola 2). localStorage manda: '1' encendido,
  // '0' apagado (interruptor de emergencia: vuelve la UI vieja). ?rx=1 / ?rx=0 lo fija.
  const RX_DEFAULT = true;
  const LS_KEY = 'rendio.aux.rx';

  // Tiempos del diseño (ANIMACIONES §4/§5). No se tocan.
  const T = {
    layerOut: 270,     // rx-app.jsx:55  pop → setTimeout(…, 270)
    layerIn: 380,      // .rx-layer.modal rxUp .38s (la más larga de las entradas)
    sheetOut: 220,     // rx-core.jsx:136 close → setTimeout(onClose, 220)
    toast: 1800,       // rx-app.jsx:36
    banner: 4000,      // rx-app.jsx:34
    refresh: 60000,    // plan §2.7: cada 60 s con la pestaña visible
  };

  // Ids fijos del rastreo, el chat, el pedido y la PWA (plan §2.4). Viven SOLO
  // en la capa trip, el pie de book o la hoja; nunca en la base (#10).
  const FIXED_IDS = ['ax-track-map', 'ax-eta-label', 'ax-eta-min', 'ax-eta', 'ax-count', 'ax-wait',
    'ax-late-wrap', 'ax-track-fresh', 'ax-onboard-badge', 'ax-chat', 'ax-chat-body', 'ax-chat-input',
    'ax-alarm-text', 'ax-cancel-reason', 'ax-map', 'ax-pin-row', 'ax-time-hints', 'ax-pwa-bar', 'axr-q',
    'ax-meet', 'ax-phase'];

  // Pestañas: [id de la app, pantalla, texto, ícono]. El orden es el del diseño
  // (RxTabs): Inicio, Viajes, +, Pagos, Perfil.
  const TABS = [
    ['inicio', 'home', 'Inicio', 'Home'],
    ['viajes', 'trips', 'Viajes', 'Route'],
    null,
    ['pagos', 'pay', 'Pagos', 'Wallet'],
    ['perfil', 'me', 'Perfil', 'User'],
  ];
  const TAB_SCREEN = { inicio: 'home', viajes: 'trips', pagos: 'pay', perfil: 'me' };
  const TAB_ALIAS = { inicio: 'inicio', home: 'inicio', viajes: 'viajes', trips: 'viajes',
    pagos: 'pagos', pay: 'pagos', perfil: 'perfil', me: 'perfil' };
  const TAB_VIEWS = { home: 1, viajes: 1, perfil: 1 };

  // Tipo de capa por defecto de cada pantalla (plan §2.3; el diseño marca
  // .modal a RxBook, RxRate y RxUpload).
  const DEFAULT_KIND = {
    home: 'tab', trips: 'tab', pay: 'tab', me: 'tab',
    book: 'modal', rate: 'modal', upload: 'modal',
    booked: 'full', onboarding: 'full',
  };

  // Enganches que devuelven UNO solo, el de mayor prioridad (plan §3.2, D15).
  const SINGLE_HOOKS = { 'home.hook': 1 };

  // Íconos de respaldo (los del diseño, trazo 1.5 como svg.lucide) para cuando
  // AuxRxUI (P1) todavía no está: el marco no puede quedar sin pestañas.
  const FALLBACK_IC = {
    Home: '<path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 13 15 13 15 22"/>',
    Route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    Wallet: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    User: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    Plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    Bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    Check: '<polyline points="20 6 9 17 4 12"/>',
    ChevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    AlertTriangle: '<path d="M10.29 3.86l-8.18 14a2 2 0 0 0 1.71 3h16.36a2 2 0 0 0 1.71-3l-8.18-14a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  };

  // ── Estado del shell ───────────────────────────────────────────────────────
  const screens = Object.create(null);     // id → def
  const actions = Object.create(null);     // data-rx → fn(el, ev)
  const hookReg = Object.create(null);     // nombre → [def]
  const own = [];                          // pila propia: {id, props, key}
  let seq = 0;
  let sk = null;          // esqueleto: {root, app, base, tabs, layers, sheetHost, toastHost, pushHost}
  let baseM = null;       // pestaña montada: {id, key, kind:'tab', tab, def, el, host, props, placeholder}
  let layersM = [];       // capas montadas (de abajo arriba), mismo formato
  let lastTopKey = null, lastView = null, lastTab = null;
  let sheetM = null;      // {bg, sheet, onClose, closing, timer}
  let toastT = null, bannerT = null, lastBannerAt = 0;
  let inited = false, rendering = false, again = false, instantNext = false;
  const hist = { armed: false, ignore: 0 };
  let pendingDeep = null;
  let refreshing = null;

  // ── Utilidades ─────────────────────────────────────────────────────────────
  const A = () => window.Auxiliar || null;
  const S = () => (window.Auxiliar && window.Auxiliar.state) || {};
  const rootEl = () => document.getElementById('auxiliar-ui');
  function esc(s) {
    if (window.AuxRxUI && typeof AuxRxUI.esc === 'function') return AuxRxUI.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ic(name, size) {
    const s = size || 20;
    if (window.AuxRxUI && typeof AuxRxUI.ic === 'function') {
      try { const h = AuxRxUI.ic(name, s); if (h) return h; } catch (_) { /* respaldo */ }
    }
    const p = FALLBACK_IC[name] || '';
    return `<svg class="rx-ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
      + `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }
  function curTrip(st) {
    const s = st || S();
    return (s.trips || []).find(t => t && t.id === s.editingTrip) || null;
  }
  // Pestaña activa. La vista manda para viajes/perfil; en 'home' la pestaña
  // puede ser inicio o pagos (auxGoTab('pagos') deja view='home', tab='pagos').
  // Con una capa encima, la base es la pestaña de la que se vino.
  function curTab(st) {
    const s = st || S();
    if (s.view === 'viajes') return 'viajes';
    if (s.view === 'perfil') return 'perfil';
    const t = TAB_ALIAS[s.tab] || 'inicio';
    if (s.view === 'home') return t === 'pagos' ? 'pagos' : 'inicio';
    return t;
  }
  function kindOf(id, def) {
    const k = def && def.layer;
    if (k === 'tab' || k === 'base') return 'tab';
    if (k === 'push' || k === 'modal' || k === 'full') return k;
    return DEFAULT_KIND[id] || 'push';
  }
  const noBaseOf = (id, def) => !!((def && def.noBase) || id === 'onboarding');

  // Capas que pide la vista del auxiliar (plan §2.3).
  function viewLayers(st) {
    const v = st.view;
    if (v === 'onboarding') return [{ id: 'onboarding', props: {}, key: 'v:onboarding' }];
    if (v === 'form') return [{ id: 'book', props: {}, key: 'v:book' }];
    if (v === 'privado') {
      // Select se apila SOBRE el pedido (como en el diseño): al volver, el
      // pedido está ahí debajo, no entra de nuevo.
      return [{ id: 'book', props: {}, key: 'v:book' },
        { id: 'select', props: { from: 'form' }, key: 'v:select:form' }];
    }
    if (v === 'confirm') return [{ id: 'booked', props: {}, key: 'v:booked:' + (st.editingTrip || '') }];
    if (v === 'support') return [{ id: 'support', props: {}, key: 'v:support' }];
    if (v === 'trip') {
      const t = curTrip(st);
      // «Ahora no» se respeta: la regla la tiene Auxiliar.showRate (PL).
      const rate = !!(t && screens.rate && (window.Auxiliar && typeof Auxiliar.showRate === 'function'
        ? Auxiliar.showRate(t) : (t.status === 'done' && t.driver && !t.rated)));
      const id = rate ? 'rate' : 'trip';
      return [{ id, props: { tripId: st.editingTrip || null }, key: 'v:' + id + ':' + (st.editingTrip || '') }];
    }
    return [];
  }

  function on() {
    try {
      const q = new URLSearchParams(location.search || '').get('rx');
      if (q === '1' || q === '0') localStorage.setItem(LS_KEY, q);
    } catch (_) { /* sin almacenamiento: manda el default */ }
    let v = null;
    try { v = localStorage.getItem(LS_KEY); } catch (_) { v = null; }
    if (v === '1') return true;
    if (v === '0') return false;
    return RX_DEFAULT;
  }

  // ── Piel ───────────────────────────────────────────────────────────────────
  // rx-phone activa TODO el CSS del rediseño (#auxiliar-ui.rx-phone …). Sin ella,
  // el archivo cargado no aplica nada.
  function skin(onFlag) {
    const root = rootEl(); if (!root) return;
    if (onFlag) { root.classList.add('rx-phone'); return; }
    root.classList.remove('rx-phone');
    teardown();
  }
  function teardown() {
    destroyAll();
    if (sk && sk.app && sk.app.parentNode) sk.app.parentNode.removeChild(sk.app);
    sk = null;
    closeSheetNow();
  }
  function destroyAll() {
    if (baseM) destroyEntry(baseM, 'leave');
    for (const e of layersM) destroyEntry(e, 'leave');
    baseM = null; layersM = []; lastTopKey = null;
  }

  // ── Esqueleto persistente (plan §2.2) ──────────────────────────────────────
  function tabsHTML() {
    return TABS.map(tb => {
      if (!tb) {
        // El + conserva data-ax="new": pasa por el candado de suspensión de
        // auxBindOnce (y por el de pagos pausados de PI).
        return `<button type="button" class="rx-fab" data-ax="new" aria-label="Pedir traslado">${ic('Plus', 26)}</button>`;
      }
      const [id, , label, icon] = tb;
      return `<button type="button" data-rx="rx-tab" data-tab="${id}"><span class="rx-tab-ic">${ic(icon, 23)}</span>${label}</button>`;
    }).join('');
  }
  function ensureSkeleton(root) {
    if (sk && sk.app && sk.app.parentNode === root && sk.app.isConnected) return false;
    // Alguien vació #auxiliar-ui (registro, enterAppAs, camino heredado): lo
    // montado ya no existe. Se avisa a las pantallas y se arma de nuevo.
    destroyAll();
    sheetM = null;
    own.length = 0;
    root.innerHTML = '';
    const app = document.createElement('div');
    app.className = 'rx-app';
    app.innerHTML = '<div class="rx-base"><nav class="rx-tabs" aria-label="Secciones">' + tabsHTML() + '</nav></div>'
      + '<div class="rx-layers"></div><div class="rx-sheet-host"></div><div class="rx-toast-host"></div><div class="rx-push-host"></div>';
    root.appendChild(app);
    sk = {
      root, app,
      base: app.querySelector('.rx-base'),
      tabs: app.querySelector('.rx-tabs'),
      layers: app.querySelector('.rx-layers'),
      sheetHost: app.querySelector('.rx-sheet-host'),
      toastHost: app.querySelector('.rx-toast-host'),
      pushHost: app.querySelector('.rx-push-host'),
    };
    lastView = null; lastTab = null;
    return true;
  }

  // Pestaña encendida (la clase .on hace correr rxPop en su ícono, como en el
  // diseño) y el punto de Pagos, que lee window.AuxPagos.summary() (AJUSTES §8).
  function payDot() {
    let sum = null;
    try { sum = window.AuxPagos && typeof AuxPagos.summary === 'function' ? AuxPagos.summary() : null; } catch (_) { sum = null; }
    const st = sum && sum.status;
    if (st === 'vencido' || st === 'bloqueado' || st === 'rejected') return 'err';
    if (st === 'venceHoy' || st === 'porVencer') return 'warn';
    return null;   // pendiente, en revisión, pagado o sin cuenta: sin punto
  }
  function paintTabs(tab) {
    if (!sk) return;
    sk.tabs.querySelectorAll('button[data-tab]').forEach(b => {
      const onT = b.dataset.tab === tab;
      if (b.classList.contains('on') !== onT) b.classList.toggle('on', onT);
      if (onT) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const icBox = sk.tabs.querySelector('button[data-tab="pagos"] .rx-tab-ic');
    if (!icBox) return;
    const want = payDot();
    const dot = icBox.querySelector('.rx-dot');
    // Solo se toca si cambia: recrear el punto reiniciaría su pulso infinito.
    if (!want) { if (dot) dot.remove(); return; }
    if (dot && dot.classList.contains(want)) return;
    if (dot) dot.remove();
    const i = document.createElement('i');
    i.className = 'rx-dot ' + want;
    icBox.appendChild(i);
  }

  // ── Montaje de pantallas ───────────────────────────────────────────────────
  function mkCtx(entry, reason) {
    const st = S();
    return {
      id: entry.id, key: entry.key, kind: entry.kind, props: entry.props || {},
      tab: curTab(st), reason, state: st, trip: curTrip(st),
      el: entry.el || null, host: entry.host || null, shell: api,
    };
  }
  function placeholderHTML(entry) {
    // Honesto: no hay pantalla registrada todavía para este id. Nunca datos.
    const back = entry.kind === 'tab' ? ''
      : `<button type="button" class="rx-ib" data-rx="rx-pop" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`;
    return `<div class="rx-scr"><div class="rx-head"><div class="rx-head-row">${back}<div class="rx-head-c"></div><div class="rx-head-r"></div></div></div>`
      + `<div class="rx-body"><div class="rx-empty-trip"><b>Todavía no disponible</b><span>Esta pantalla aún no está lista en la app.</span></div></div></div>`;
  }
  function errorHTML(entry) {
    const back = entry.kind === 'tab' ? ''
      : `<button type="button" class="rx-ib" data-rx="rx-pop" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`;
    return `<div class="rx-scr"><div class="rx-head"><div class="rx-head-row">${back}<div class="rx-head-c"></div><div class="rx-head-r"></div></div></div>`
      + `<div class="rx-body"><div class="rx-empty-trip"><b>No pudimos mostrar esta pantalla</b><span>Vuelve a intentarlo en un momento.</span></div></div></div>`;
  }
  function fill(entry, reason) {
    const def = screens[entry.id];
    entry.def = def || null;
    entry.placeholder = !def;
    let out;
    if (!def || typeof def.render !== 'function') out = placeholderHTML(entry);
    else {
      try { out = def.render(mkCtx(entry, reason)); }
      catch (e) { console.error('[AuxShell] la pantalla «' + entry.id + '» falló al pintar:', e); out = errorHTML(entry); }
    }
    const host = entry.host;
    if (out && typeof out === 'object' && out.nodeType) { host.innerHTML = ''; host.appendChild(out); }
    else host.innerHTML = out == null ? '' : String(out);
  }
  function runAfter(entry, reason) {
    const def = entry.def;
    if (!def || typeof def.after !== 'function') return;
    try { def.after(mkCtx(entry, reason)); }
    catch (e) { console.error('[AuxShell] after() de «' + entry.id + '» falló:', e); }
  }
  function destroyEntry(entry, reason) {
    const def = entry && entry.def;
    if (!def || typeof def.destroy !== 'function') return;
    try { def.destroy(mkCtx(entry, reason)); }
    catch (e) { console.error('[AuxShell] destroy() de «' + entry.id + '» falló:', e); }
  }
  // Contenedor de la pantalla: la capa (o la tabview) lleva la animación de
  // ENTRADA; adentro, un .rx-scrhost (display:contents) recibe el HTML. Así,
  // repintar con .rx-noanim en el host nunca toca la animación de la capa.
  function makeContainer(entry) {
    const el = document.createElement('div');
    if (entry.kind === 'tab') el.className = 'rx-tabview';
    else if (entry.kind === 'full') el.className = 'rx-full';
    else el.className = 'rx-layer' + (entry.kind === 'modal' ? ' modal' : '');
    el.setAttribute('data-scr', entry.id);
    el.setAttribute('data-rx-key', entry.key);
    const host = document.createElement('div');
    host.className = 'rx-scrhost';
    el.appendChild(host);
    entry.el = el; entry.host = host;
    return el;
  }

  // Repintar SIN animaciones (la misma pantalla, o una que vuelve a quedar
  // arriba). Como en React con la misma key: nada «entra» de nuevo.
  function scrollState(host) {
    return [...host.querySelectorAll('.rx-body, [data-rx-scroll]')].map(b => b.scrollTop || 0);
  }
  function restoreScroll(host, tops) {
    const list = [...host.querySelectorAll('.rx-body, [data-rx-scroll]')];
    list.forEach((b, i) => { if (tops[i]) { try { b.scrollTop = tops[i]; } catch (_) { /* */ } } });
  }
  // .rx-noanim apaga las animaciones de una sola vez del subárbol (regla de P1
  // en rx-aux-app.css). Si el navegador tiene getAnimations(), se quita la
  // clase enseguida y se dan por TERMINADAS las de una sola vez que acaban de
  // nacer: el primer cuadro pintado ya es el final, las infinitas («En vivo»,
  // el brillo del pase) siguen, y lo que se inserte después (patch, key nueva)
  // anima normal, igual que en React. Sin getAnimations() la clase se queda.
  function settleNoanim(host) {
    if (typeof host.getAnimations !== 'function') return;
    try {
      host.classList.remove('rx-noanim');
      const list = host.getAnimations({ subtree: true });
      for (const a of list) {
        if (typeof a.animationName !== 'string') continue;          // transiciones: no
        const tm = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
        if (!tm || tm.iterations === Infinity) continue;             // infinitas: siguen
        try { a.finish(); } catch (_) { /* */ }
      }
    } catch (_) { host.classList.add('rx-noanim'); }
  }
  function repaint(entry, reason) {
    const host = entry.host;
    const tops = scrollState(host);
    const selfTop = entry.el.scrollTop || 0;
    destroyEntry(entry, reason);
    host.classList.add('rx-noanim');
    fill(entry, reason);
    restoreScroll(host, tops);
    if (selfTop) { try { entry.el.scrollTop = selfTop; } catch (_) { /* */ } }
    settleNoanim(host);
    runAfter(entry, reason);
  }
  function tryPatch(entry) {
    const def = screens[entry.id];
    if (!def || typeof def.patch !== 'function' || entry.placeholder) return false;
    entry.def = def;
    try { return def.patch(mkCtx(entry, 'patch')) === true; }
    catch (e) { console.error('[AuxShell] patch() de «' + entry.id + '» falló:', e); return false; }
  }
  function stopTrack() {
    const a = A();
    if (a && typeof a.stopTrack === 'function') { try { a.stopTrack(); } catch (_) { /* */ } }
  }
  function checkBaseIds() {
    if (!sk || !baseM) return;
    const bad = FIXED_IDS.filter(id => baseM.el.querySelector('#' + id));
    if (bad.length) console.error('[AuxShell] la pestaña «' + baseM.id + '» trae ids reservados de §2.4 (van solo en trip/book/hoja): ' + bad.join(', '));
  }

  // ── Render (plan §2.2) ─────────────────────────────────────────────────────
  function render() {
    const root = rootEl(); if (!root) return;
    if (rendering) { again = true; return; }
    rendering = true;
    try {
      let n = 0;
      do { again = false; renderOnce(root); } while (again && ++n < 4);
    } finally { rendering = false; }
    if (pendingDeep && S().view !== 'onboarding') {
      const h = pendingDeep; pendingDeep = null;
      Promise.resolve().then(() => applyDeep(h));
    }
  }

  function renderOnce(root) {
    initOnce();
    skin(true);
    ensureSkeleton(root);
    const st = S();
    const tab = curTab(st);

    // Un cambio de vista o de pestaña vacía la pila propia (§2.3).
    if ((lastView !== null && st.view !== lastView) || (lastTab !== null && tab !== lastTab)) own.length = 0;

    const desired = viewLayers(st).concat(own.map(o => ({ id: o.id, props: o.props, key: o.key })));
    desired.forEach(d => { d.def = screens[d.id] || null; d.kind = kindOf(d.id, d.def); });
    const topD = desired.length ? desired[desired.length - 1] : null;
    const hideBase = !!(topD && noBaseOf(topD.id, topD.def));
    const baseId = TAB_SCREEN[tab];
    const baseKey = 't:' + tab;
    const newTopKey = topD ? topD.key : (hideBase ? null : baseKey);
    const topChanged = newTopKey !== lastTopKey;
    const instant = instantNext; instantNext = false;

    // La pantalla de arriba cambia: se desmonta el rastreo ANTES de pintar la
    // nueva (su after() puede arrancar otro). La hoja del shell se cierra.
    if (topChanged && lastTopKey !== null) {
      stopTrack();
      if (sheetM && !sheetM.closing) closeSheet();
    }

    // ── Base (pestaña) ──
    let baseFresh = false;
    sk.base.classList.toggle('rx-nobase', hideBase);
    if (hideBase) {
      if (baseM) { destroyEntry(baseM, 'leave'); baseM.el.remove(); baseM = null; }
    } else if (!baseM || baseM.key !== baseKey) {
      // key={tab}: la tabview se RECREA y su rxFade corre.
      if (baseM) { destroyEntry(baseM, 'leave'); baseM.el.remove(); }
      const entry = { id: baseId, key: baseKey, kind: 'tab', tab, props: {} };
      sk.base.insertBefore(makeContainer(entry), sk.tabs);
      fill(entry, 'enter');
      baseM = entry; baseFresh = true;
      runAfter(entry, 'enter');
    }
    paintTabs(tab);

    // ── Capas ──
    let i = 0;
    while (i < layersM.length && i < desired.length && layersM[i].key === desired[i].key) i++;
    const removed = layersM.slice(i);
    const added = desired.slice(i);
    layersM = layersM.slice(0, i);
    if (removed.length) {
      removed.forEach(e => destroyEntry(e, 'leave'));
      const topRemoved = removed[removed.length - 1];
      if (instant || (added.length && added[added.length - 1].kind === 'full')) {
        removed.forEach(e => e.el.remove());
      } else if (!added.length) {
        // pop: la de arriba sale con .out y se quita a los 270 ms; las de
        // debajo (si salieron varias de golpe) se van sin animación.
        removed.slice(0, -1).forEach(e => e.el.remove());
        if (topRemoved.kind === 'full') topRemoved.el.remove();
        else {
          topRemoved.el.classList.remove('behind');
          topRemoved.el.classList.add('out');
          const el = topRemoved.el;
          setTimeout(() => el.remove(), T.layerOut);
        }
      } else {
        // Reemplazo (otra pantalla en el mismo lugar): la nueva entra ENCIMA y
        // la vieja se retira cuando la nueva terminó de entrar.
        removed.forEach(e => { const el = e.el; setTimeout(() => el.remove(), T.layerIn); });
      }
    }
    const freshKeys = {};
    for (const d of added) {
      const entry = { id: d.id, key: d.key, kind: d.kind, props: d.props || {} };
      sk.layers.appendChild(makeContainer(entry));
      fill(entry, 'enter');
      layersM.push(entry);
      freshKeys[entry.key] = 1;
      runAfter(entry, 'enter');
    }

    // ── La de arriba: parche, repintado o revelada ──
    const topEntry = layersM.length ? layersM[layersM.length - 1] : (hideBase ? null : baseM);
    if (topEntry && !freshKeys[topEntry.key] && !(topEntry === baseM && baseFresh)) {
      if (!topChanged) {
        if (!tryPatch(topEntry)) { stopTrack(); repaint(topEntry, 'repaint'); }
      } else {
        // Vuelve a quedar arriba (se cerró lo que la tapaba): se repinta sin
        // animaciones con los datos de ahora.
        repaint(topEntry, 'reveal');
      }
    }

    // ── Clases de la pila ──
    const nLayers = layersM.length;
    sk.base.classList.toggle('behind', nLayers > 0);
    layersM.forEach((e, k) => {
      if (e.kind === 'full') return;
      e.el.classList.toggle('behind', k < nLayers - 1);
    });
    const topDef = topEntry ? screens[topEntry.id] : null;
    if (topDef && topDef.dark) sk.app.setAttribute('data-top-dark', '1'); else sk.app.removeAttribute('data-top-dark');

    lastTopKey = topEntry ? topEntry.key : null;
    lastView = st.view; lastTab = tab;
    checkBaseIds();
    syncHistory();
  }

  // ── Registro de pantallas, acciones y enganches ────────────────────────────
  function register(id, def) {
    if (!id || !def) return;
    screens[id] = def;
    // Registro tardío: si esa pantalla estaba montada como «todavía no
    // disponible», se repinta ya con la de verdad.
    const mounted = (baseM && baseM.id === id && baseM.placeholder) || layersM.some(e => e.id === id && e.placeholder);
    if (mounted && sk && on()) Promise.resolve().then(() => { if (sk && on()) render(); });
  }
  const registered = (id) => !!screens[id];
  function action(name, fn) { if (name && typeof fn === 'function') actions[name] = fn; }
  function hook(name, def) {
    if (!name || !def) return def;
    const list = hookReg[name] || (hookReg[name] = []);
    const k = def.id != null ? list.findIndex(h => h.id === def.id) : -1;
    if (k >= 0) list[k] = def; else list.push(def);
    return def;
  }
  function hooks(name, ctx) {
    const c = ctx || { state: S(), shell: api };
    const list = (hookReg[name] || []).filter(h => {
      if (typeof h.when !== 'function') return true;
      try { return !!h.when(c); } catch (e) { console.error('[AuxShell] when() del enganche «' + (h.id || name) + '» falló:', e); return false; }
    }).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return SINGLE_HOOKS[name] ? list.slice(0, 1) : list;
  }

  // ── Navegación ─────────────────────────────────────────────────────────────
  function push(id, props) {
    if (!id) return null;
    const top = own[own.length - 1];
    if (top && top.id === id && JSON.stringify(top.props || {}) === JSON.stringify(props || {})) return top.key;
    const key = 'o:' + id + ':' + (++seq);
    own.push({ id, props: props || {}, key });
    render();
    return key;
  }
  // Volver: primero la pila propia; si no hay, la vista del auxiliar (el
  // «atrás» de una cosa de Auxiliar.back: pasos, chat, privado, trip…).
  function pop() {
    if (own.length) { own.pop(); render(); return true; }
    const a = A();
    return !!(a && typeof a.back === 'function' && a.back());
  }
  function popAll() {
    own.length = 0;
    instantNext = true;
    const st = S();
    const a = A();
    if (!TAB_VIEWS[st.view] && a && typeof a.goTab === 'function') a.goTab(curTab(st));
    else render();
  }
  function setTab(tab) {
    const t = TAB_ALIAS[tab] || 'inicio';
    own.length = 0;
    instantNext = true;
    const a = A();
    if (a && typeof a.goTab === 'function') a.goTab(t);
    else render();
  }
  function current() {
    const e = layersM.length ? layersM[layersM.length - 1] : baseM;
    if (!e) return null;
    return { id: e.id, key: e.key, kind: e.kind, props: e.props || {}, tab: curTab(S()), placeholder: !!e.placeholder };
  }

  // ── Hoja inferior (RxSheet) ────────────────────────────────────────────────
  // sheet(html | fn(close) → html, {tall, onClose, after(el)}) → elemento .rx-sheet
  function sheet(content, opts) {
    const o = opts || {};
    const root = rootEl();
    // Sin el shell montado no hay dónde pintarla: quien llama lo ve por el null.
    if (!root || !sk) return null;
    const html = typeof content === 'function' ? content(closeSheet) : content;
    if (sheetM && !sheetM.closing) {
      // Ya hay una abierta: se cambia el contenido sin volver a animar (el
      // diseño reemplaza los hijos de la misma RxSheet).
      const sh = sheetM.sheet;
      while (sh.childNodes.length > 1) sh.removeChild(sh.lastChild);
      sh.insertAdjacentHTML('beforeend', html == null ? '' : String(html));
      sh.classList.toggle('tall', !!o.tall);
      sheetM.onClose = o.onClose || null;
      if (typeof o.after === 'function') { try { o.after(sh); } catch (e) { console.error(e); } }
      syncHistory();
      return sh;
    }
    closeSheetNow();
    const bg = document.createElement('div');
    bg.className = 'rx-sheet-bg';
    bg.innerHTML = `<div class="rx-sheet${o.tall ? ' tall' : ''}" role="dialog" aria-modal="true"><div class="rx-grab"></div></div>`;
    const sh = bg.firstChild;
    sh.insertAdjacentHTML('beforeend', html == null ? '' : String(html));
    // Tocar el fondo (no la hoja) cierra con la animación.
    bg.addEventListener('click', (e) => { if (e.target === bg) closeSheet(); });
    sk.sheetHost.appendChild(bg);
    sheetM = { bg, sheet: sh, onClose: o.onClose || null, closing: false, timer: null };
    if (typeof o.after === 'function') { try { o.after(sh); } catch (e) { console.error(e); } }
    syncHistory();
    return sh;
  }
  function closeSheet() {
    const m = sheetM;
    if (!m || m.closing) return;
    m.closing = true;
    m.bg.classList.add('out');
    m.timer = setTimeout(() => {
      m.bg.remove();
      if (sheetM === m) sheetM = null;
      if (typeof m.onClose === 'function') { try { m.onClose(); } catch (e) { console.error(e); } }
    }, T.sheetOut);
    syncHistory();
  }
  function closeSheetNow() {
    const m = sheetM;
    if (!m) return;
    clearTimeout(m.timer);
    m.bg.remove();
    sheetM = null;
    if (!m.closing && typeof m.onClose === 'function') { try { m.onClose(); } catch (e) { console.error(e); } }
  }
  const sheetOpen = () => !!(sheetM && !sheetM.closing);

  // ── Toast y banner ─────────────────────────────────────────────────────────
  // key={id}: cada toast es un nodo NUEVO (su rxToast corre desde cero).
  function toast(msg, icon) {
    if (!sk || !on()) { if (typeof window.toast === 'function') window.toast(msg); return; }
    clearTimeout(toastT);
    sk.toastHost.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'rx-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = ic(icon || 'Check', 16) + esc(msg);
    sk.toastHost.appendChild(el);
    toastT = setTimeout(() => { el.remove(); }, T.toast);
    return el;
  }
  // banner({icon, title, body, go}) — el aviso «Rendio · ahora» de arriba
  // (RxPushBanner). go: función, '#/…' o '/#/…', nombre de pestaña, o
  // {tripId} / {tab} / {push, props}.
  function banner(p) {
    if (!p || !sk || !on()) return null;
    clearTimeout(bannerT);
    sk.pushHost.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'rx-push';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<span class="rx-push-ic">${ic(p.icon || 'Bell', 16)}</span>`
      + `<div><div class="rx-push-h"><b>Rendio</b><span>ahora</span></div><b>${esc(p.title || '')}</b><div>${esc(p.body || '')}</div></div>`;
    el.addEventListener('click', () => {
      clearTimeout(bannerT);
      el.remove();
      if (p.go != null) navigate(p.go);
    });
    sk.pushHost.appendChild(el);
    lastBannerAt = Date.now();
    bannerT = setTimeout(() => { el.remove(); }, T.banner);
    return el;
  }
  function navigate(go) {
    if (typeof go === 'function') { try { go(); } catch (e) { console.error(e); } return; }
    if (typeof go === 'string') {
      const k = go.indexOf('#/');
      if (k >= 0) { applyDeep(go.slice(k)); return; }
      if (TAB_ALIAS[go]) { setTab(go); return; }
      return;
    }
    if (go && typeof go === 'object') {
      if (go.tripId) { openTripSafe(go.tripId); return; }
      if (go.tab) { setTab(go.tab); return; }
      if (go.push) { push(go.push, go.props || {}); }
    }
  }

  // ── Enlaces profundos del auxiliar (plan §2.5) ─────────────────────────────
  // core.applyDeepLink sale en falso para quien no es admin, así que estos los
  // resuelve el shell: al arrancar (llegan en frío por notificationclick →
  // navigate(url)) y en hashchange.
  function parseDeep(h) {
    const m = String(h || '').match(/^#\/([a-z-]+)(?:\?(.*))?$/i);
    if (!m) return null;
    const q = new URLSearchParams(m[2] || '');
    const name = m[1].toLowerCase();
    if (name === 'viaje') return q.get('r') ? { kind: 'trip', id: q.get('r') } : { kind: 'tab', tab: 'viajes' };
    if (name === 'coordinacion') return { kind: 'push', id: 'coord', props: { reservationId: q.get('r') || null } };
    if (name === 'avisos') return { kind: 'push', id: 'notifs', props: {} };
    if (TAB_ALIAS[name]) return { kind: 'tab', tab: TAB_ALIAS[name] };
    return null;
  }
  function clearHash() {
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) { /* */ }
  }
  async function openTripSafe(id) {
    const a = A(); if (!a || typeof a.openTrip !== 'function') return;
    const has = () => (S().trips || []).some(t => t && t.id === id);
    if (!has() && typeof a.reloadTrips === 'function') {
      try { await a.reloadTrips(); } catch (_) { /* */ }
    }
    if (!has()) { toast('Ese traslado ya no está en tu lista.', 'AlertTriangle'); return; }
    own.length = 0;
    a.openTrip(id);
  }
  function applyDeep(h) {
    const d = parseDeep(h);
    if (!d) return false;
    const a = A();
    if (d.kind === 'trip') { openTripSafe(d.id); return true; }
    if (d.kind === 'tab') { setTab(d.tab); return true; }
    if (d.kind === 'push') {
      // Como onPushTap del diseño: se cierra lo que haya y se abre encima de la
      // pestaña actual.
      own.length = 0;
      const st = S();
      if (!TAB_VIEWS[st.view] && a && typeof a.goTab === 'function') { instantNext = true; a.goTab(curTab(st)); }
      push(d.id, d.props);
      return true;
    }
    return false;
  }
  function takeHash() {
    const h = String(location.hash || '');
    if (!/^#\//.test(h) || !parseDeep(h)) return null;
    clearHash();
    return h;
  }

  // ── Botón atrás del teléfono (plan §2.5) ───────────────────────────────────
  // Una sola entrada «centinela» en el historial mientras haya algo que cerrar:
  // cada atrás cierra UNA cosa y, si queda algo, se vuelve a poner. Si la app
  // vuelve sola a Inicio (un «Listo», una X), se retira con history.back() y ese
  // popstate se ignora. En Inicio sin nada abierto no se empuja nada: el atrás
  // sale de la app.
  function isRoot() {
    const st = S();
    if (sheetOpen() || own.length || st.alarm || st.confirmingCancel || st.chatOpen) return false;
    if (st.view === 'onboarding') return !st.onbStep;
    return st.view === 'home' && curTab(st) === 'inicio';
  }
  function syncHistory() {
    if (!sk || !on()) return;
    const root = isRoot();
    if (!root && !hist.armed) {
      try { history.pushState({ rx: 1 }, ''); hist.armed = true; } catch (_) { /* */ }
    } else if (root && hist.armed) {
      hist.armed = false; hist.ignore++;
      try { history.back(); } catch (_) { hist.ignore--; }
    }
  }
  function backOne() {
    const st = S();
    const a = A();
    // 1 · la hoja del shell
    if (sheetOpen()) { closeSheet(); return; }
    // 2-3 · alarma / confirmar cancelar (hojas de la pantalla trip, tapan todo)
    if (st.alarm || st.confirmingCancel) { if (a && a.back) a.back(); return; }
    // la pila propia del shell (está ENCIMA de la vista)
    if (own.length) { own.pop(); render(); return; }
    // 4-10 · chat, paso del pedido, privado→pedido, support, onboarding, vista
    const done = !!(a && typeof a.back === 'function' && a.back());
    // Con una pestaña ≠ Inicio y sin capas, vuelve a Inicio.
    if (!done && curTab(S()) !== 'inicio') setTab('inicio');
  }
  function onPopState(e) {
    if (!sk || !on()) return;
    if (hist.ignore > 0) { hist.ignore--; return; }
    if (e && e.state && e.state.rx) { hist.armed = true; return; }   // «adelante» al centinela
    hist.armed = false;
    backOne();
    syncHistory();
  }

  // ── Refresco de datos (plan §2.7) ──────────────────────────────────────────
  // Auxiliar.reloadTrips() (PL) fusiona sobre los mismos objetos; aquí solo se
  // decide si repintar. Nunca en form, confirm ni onboarding; en una pestaña,
  // solo si no hay un campo con foco; en trip, solo si cambió su estado.
  const snap = (trips) => {
    const m = {};
    (trips || []).forEach(t => { if (t && t.id) m[t.id] = { status: t.status, driver: !!(t.driver && t.driver.name) }; });
    return m;
  };
  function focusedField() {
    const ae = document.activeElement;
    const root = rootEl();
    return !!(ae && root && root.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  }
  function refreshTrips(opts) {
    if (refreshing) return refreshing;
    const a = A();
    if (!a || typeof a.reloadTrips !== 'function') return Promise.resolve(null);
    const st = S();
    const before = snap(st.trips);
    refreshing = Promise.resolve()
      .then(() => a.reloadTrips(opts))
      .catch(() => null)
      .then(() => {
        refreshing = null;
        const s2 = S();
        const after = snap(s2.trips);
        bannersFrom(before, after, s2.trips);
        if (!sk || !on()) return;
        const v = s2.view;
        if (TAB_VIEWS[v]) { if (!focusedField()) render(); return; }
        if (v === 'trip') {
          const id = s2.editingTrip;
          if (id && before[id] && after[id] && before[id].status !== after[id].status) render();
        }
      });
    return refreshing;
  }
  // Fuente 2 del banner: los cambios que trajo el refresco. Textos honestos,
  // solo con lo que el viaje trae (sin horas inventadas). Si acaba de llegar
  // un push (fuente 1), no se repite.
  const hmBog = (iso) => {
    try {
      return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(iso));
    } catch (_) { return ''; }
  };
  const dayOf = (t) => {
    if (window.AuxRxUI && typeof AuxRxUI.dayLabel === 'function') { try { return AuxRxUI.dayLabel(t.date); } catch (_) { /* */ } }
    try { return new Date(t.date + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (_) { return t.date || ''; }
  };
  const firstName = (t) => String((t.driver && (t.driver.first || t.driver.name)) || '').trim().split(/\s+/)[0] || '';
  const plateOf = (t) => (t.vehicle && t.vehicle.plate) || (t.driver && t.driver.plate) || '';
  function bannerFor(t, prev) {
    const f = firstName(t), plate = plateOf(t), day = dayOf(t);
    if (t.status === 'assigned' && prev !== 'assigned') {
      const hm = t.pickupAt ? hmBog(t.pickupAt) : '';
      return { icon: 'Car', title: 'Ya tienes conductor',
        body: hm ? `Te recogemos el ${day} a las ${hm}${plate ? ' · carro ' + plate : ''}.` : `Tu traslado del ${day} ya tiene conductor.` };
    }
    if (t.status === 'onway') return { icon: 'Nav', title: f ? `${f} va por ti` : 'Tu conductor va por ti', body: plate ? `Carro ${plate}.` : 'Ábrelo para verlo en el mapa.' };
    if (t.status === 'done') return { icon: 'Star', title: 'Llegaste', body: f ? `¿Cómo te fue con ${f}?` : 'Tu traslado terminó.' };
    if (t.status === 'cancelled') return { icon: 'AlertTriangle', title: 'Traslado cancelado', body: `Tu traslado del ${day} fue cancelado.` };
    return null;
  }
  function bannersFrom(before, after, trips) {
    if (!sk || !on()) return;
    if (Date.now() - lastBannerAt < 5000) return;
    for (const t of trips || []) {
      if (!t || !before[t.id] || !after[t.id]) continue;          // solo cambios, no viajes nuevos
      const prev = before[t.id].status;
      if (prev === t.status) continue;
      const b = bannerFor(t, prev);
      if (b) { banner(Object.assign(b, { go: { tripId: t.id } })); return; }
    }
  }

  // ── Arranque perezoso: oyentes una sola vez (plan §2.5-2.7) ────────────────
  function initOnce() {
    if (inited) return;
    const root = rootEl(); if (!root) return;
    inited = true;
    hist.armed = !!(history.state && history.state.rx);

    // data-rx: delegado en la raíz, aparte del de data-ax (auxBindOnce).
    root.addEventListener('click', (e) => {
      if (!sk || !on()) return;
      const el = e.target && e.target.closest ? e.target.closest('[data-rx]') : null;
      if (!el || !root.contains(el)) return;
      const fn = actions[el.getAttribute('data-rx')];
      if (!fn) return;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
      try { fn(el, e); } catch (err) { console.error('[AuxShell] acción «' + el.getAttribute('data-rx') + '» falló:', err); }
    });
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', () => {
      if (!on()) return;
      const h = takeHash(); if (!h) return;
      if (!sk || S().view === 'onboarding') { pendingDeep = h; return; }
      applyDeep(h);
    });
    // Fuente 1 del banner: sw.js hace postMessage({type:'rendio-push',title,body,url}).
    try {
      if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
        navigator.serviceWorker.addEventListener('message', (e) => {
          const d = e && e.data;
          if (!d || d.type !== 'rendio-push' || !sk || !on()) return;
          if (document.visibilityState !== 'visible') return;
          banner({ icon: d.icon || 'Bell', title: d.title || 'Rendio', body: d.body || '', go: d.url || null });
          refreshTrips({ silent: true });   // el banner ya avisó: la recarga no pinta otro
        });
      }
    } catch (_) { /* sin service worker */ }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && sk && on()) refreshTrips();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible' && sk && on()) refreshTrips();
    }, T.refresh);
    // Enlace profundo en frío: se aplica al primer render que no sea bienvenida.
    const h = takeHash();
    if (h) pendingDeep = h;
  }

  // ── Acciones de serie (data-rx) ────────────────────────────────────────────
  // Las pantallas pueden reemplazarlas con AuxShell.action(nombre, fn).
  action('rx-pop', () => pop());
  action('rx-tab', (el) => setTab(el.getAttribute('data-tab')));
  action('sheet-close', () => closeSheet());
  action('open-notifs', () => push('notifs', {}));
  action('open-coord', (el) => push('coord', { reservationId: el.getAttribute('data-id') || null }));
  action('open-flight', (el) => push('flight', { reservationId: el.getAttribute('data-id') || null }));
  action('open-select', (el) => push('select', { from: el.getAttribute('data-from') || 'home' }));
  action('open-residence', () => push('residence', {}));

  // Recrear un nodo para que su animación vuelva a correr (key={…} de React).
  function rekey(el, html) {
    if (!el || !el.parentNode) return null;
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html).trim();
    const nodes = [...tpl.content.childNodes];
    if (!nodes.length) { el.remove(); return null; }
    el.replaceWith(...nodes);
    return nodes.find(n => n.nodeType === 1) || null;
  }

  const api = {
    on, skin, render, register, push, pop, popAll, setTab, current, sheet, closeSheet,
    toast, banner, action, hook, hooks, refreshTrips,
    registered, rekey, ic, FIXED_IDS, RX_DEFAULT, T,
  };
  // Registro perezoso (crítica 8): este archivo carga ANTES que aux-registro,
  // aux-privado y todas las aux-rx-* (index.html), y register() acepta
  // registros tardíos (si la pantalla ya estaba montada como «todavía no
  // disponible», se repinta sola).
  window.AuxShell = api;
})();
