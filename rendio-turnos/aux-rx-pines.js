// aux-rx-pines.js — Tienda de pines del tripulante (0181, 27-nov-2026).
//
// QUÉ ES
// Los pines que el tripulante le pone a la maleta. En la app se RESERVAN, no se
// pagan: la reserva aparta las unidades, les llega el aviso a los jefes y el
// pago y la entrega son en persona (Harold: «ya queda reservado, no es
// necesario escribirle a Julián»).
//
// PANTALLAS (todas por AuxShell)
//   · tarjeta en Inicio (enganche 'home.card'): nombre, el texto que pone el
//     jefe y «Ver la tienda». SIN precio ni promo (Harold: «no me gusta que salga
//     el precio al principio»); la promo sale al entrar;
//   · 'pines'       → la tienda: precio, promo y los pines con su estado
//     (Agregar / «Próximamente» / «Agotado» / «Quedan N»), y abajo la barra con
//     el total cuando hay algo agregado;
//   · hoja «Tu reserva» → cantidades, la promo ya aplicada, total y Reservar;
//   · 'pines-ok'    → «¡Reservado!»;
//   · 'pines-mias'  → Mis reservas, con su estado (Reservado / Entregado /
//     Cancelada).
//
// DATOS: solo lo que devuelve ApiPines (0181). Con la tienda apagada, o en una
// base sin 0181, no se pinta nada: ni tarjeta ni pantalla. El total que se ve
// mientras se arma la reserva es la misma fórmula de la base (ApiPines.total);
// el que queda guardado lo calcula la base. La promo es solo con su cantidad
// exacta (Harold: «si compra 3 ya no aplica el descuento»).
//
// Contrato:
//   window.AuxPines = { load({force}), store() → lo último que se trajo }
(function () {
  'use strict';

  const TTL = 60000;

  const UI = () => window.AuxRxUI || null;
  const SH = () => window.AuxShell || null;
  const AP = () => window.ApiPines || null;

  function esc(s) {
    const u = UI();
    if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s, cls, style) => { const u = UI(); return u && u.ic ? u.ic(n, s, cls, style) : ''; };
  function btn(label, o) {
    const u = UI();
    if (u && u.btn) return u.btn(label, o);
    return '<button type="button" class="rx-btn ' + ((o && o.kind) || 'pri') + '">' + esc(label) + '</button>';
  }
  const money = (n) => { const P = AP(); return P ? P.money(n) : '$' + n; };
  const pines = (n) => n + (n === 1 ? ' pin' : ' pines');
  function toast(msg, icon) { const s = SH(); if (s && typeof s.toast === 'function') s.toast(msg, icon); }
  function parse(html) { const t = document.createElement('template'); t.innerHTML = html; return t.content; }
  // Repintar sin animar: las entradas de una sola vez que acaban de nacer se dan
  // por terminadas, igual que hace el shell cuando repinta (settleNoanim). Las
  // infinitas siguen.
  function settle(el) {
    if (!el || typeof el.getAnimations !== 'function') return;
    try {
      el.getAnimations({ subtree: true }).forEach(a => {
        if (typeof a.animationName !== 'string') return;
        const tm = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
        if (!tm || tm.iterations === Infinity) return;
        try { a.finish(); } catch (_) { /* */ }
      });
    } catch (_) { /* */ }
  }

  // ── Datos ─────────────────────────────────────────────────────────────────
  // store: undefined = no se ha pedido · null = no hay (sin 0181, sin sesión o falló).
  const C = { pid: null, store: undefined, at: 0, err: '', inflight: null };
  const ST = { host: null, busy: false, err: '' };
  const MN = { host: null, list: undefined, err: '', req: 0 };
  let CART = {};   // { idDelPin: cantidad }

  function profileId() {
    // eslint-disable-next-line no-undef
    try { const g = typeof state !== 'undefined' ? state : null; return (g && g.profile && g.profile.id) || null; } catch (_) { return null; }
  }
  // Otra cuenta en el mismo teléfono: nada de lo anterior le sirve.
  function checkPid() {
    const p = profileId();
    if (p === C.pid) return;
    C.pid = p; C.store = undefined; C.at = 0; C.err = ''; C.inflight = null;
    CART = {}; MN.list = undefined; MN.err = '';
  }

  const byId = () => { const o = {}; ((C.store && C.store.products) || []).forEach(p => { o[p.id] = p; }); return o; };
  const units = () => Object.keys(CART).reduce((a, k) => a + CART[k], 0);
  const contact = () => (C.store && C.store.contactName) || 'Coordinación';

  // Lo agregado se ajusta a lo que la tienda dice AHORA (otro pudo llevarse el último).
  function fitCart() {
    const s = C.store;
    if (!s || !s.enabled) { CART = {}; return; }
    const by = byId();
    Object.keys(CART).forEach(id => {
      const p = by[id];
      if (!p || p.state !== 'available' || p.stock < 1) delete CART[id];
      else if (CART[id] > p.stock) CART[id] = p.stock;
    });
  }

  const sig = () => JSON.stringify([C.store, C.err]);

  function load(o) {
    checkPid();
    const P = AP();
    if (!P) { C.store = null; return Promise.resolve(null); }
    if (C.inflight) return C.inflight;
    if (!(o && o.force) && C.store !== undefined && Date.now() - C.at < TTL) return Promise.resolve(C.store);
    const before = sig();
    const mine = C.pid;
    C.inflight = Promise.resolve().then(() => P.store()).then(
      v => { if (mine === C.pid) { C.store = v || null; C.err = ''; } },
      e => { if (mine === C.pid) { C.err = (e && e.message) || 'No pudimos cargar la tienda'; if (C.store === undefined) C.store = null; } }
    ).then(() => {
      if (mine !== C.pid) return C.store;
      C.at = Date.now(); C.inflight = null;
      fitCart();
      if (sig() !== before) changed();
      return C.store;
    });
    return C.inflight;
  }
  // Pide por detrás si lo que hay está viejo (lo llama la tarjeta de Inicio).
  function kick() {
    checkPid();
    if (C.inflight) return;
    if (C.store === undefined || Date.now() - C.at > TTL) load();
  }
  function changed() {
    refreshStore();
    const sh = SH();
    const cur = sh && typeof sh.current === 'function' ? sh.current() : null;
    if (cur && cur.id === 'home' && typeof sh.render === 'function') sh.render();
  }

  // ── Piezas ────────────────────────────────────────────────────────────────
  function imgHTML(p) {
    return p && p.image
      ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" decoding="async">'
      : '<span class="rx-pn-noimg">' + ic('Gift', 22) + '</span>';
  }

  // ── Tarjeta de Inicio ─────────────────────────────────────────────────────
  function cardHTML(c) {
    const s = C.store;
    if (!s) return '';
    const d = c && c.d != null ? c.d : 2;
    const open = s.enabled && s.products.length > 0;
    const mine = s.myPending > 0
      ? '<i class="rx-pn-mine-n">' + esc(s.myPending === 1 ? 'Tienes 1 reserva por recibir' : 'Tienes ' + s.myPending + ' reservas por recibir') + '</i>' : '';
    if (!open) {
      // Tienda cerrada, pero con pines suyos por recibir: que no se le pierdan.
      return '<button type="button" class="rx-pn-card is-mine rx-in" style="--d:' + d + '" data-rx="pn-mine">'
        + '<span class="rx-pn-card-tx"><b>Tus pines</b>' + mine + '<em>Ver mis reservas ' + ic('ChevronRight', 15) + '</em></span>'
        + '</button>';
    }
    const any = (st) => s.products.some(p => p.state === st);
    const chip = any('available') ? 'Nuevo' : any('soon') ? 'Próximamente' : 'Agotados';
    const imgs = s.products.filter(p => p.image).slice(0, 3)
      .map((p, i) => '<img class="i' + i + '" src="' + esc(p.image) + '" alt="" decoding="async">').join('');
    return '<button type="button" class="rx-pn-card rx-in" style="--d:' + d + '" data-rx="pn-open">'
      + '<span class="rx-pn-card-tx"><i class="rx-pn-chip">' + esc(chip) + '</i><b>' + esc(s.title) + '</b>'
      + (s.cardText ? '<span>' + esc(s.cardText) + '</span>' : '')
      + mine
      + '<em>Ver la tienda ' + ic('ChevronRight', 15) + '</em></span>'
      + (imgs ? '<span class="rx-pn-card-im n' + Math.min(3, s.products.filter(p => p.image).length) + '">' + imgs + '</span>' : '')
      + '</button>';
  }
  const HOME_CARD = {
    id: 'pines', priority: 10,
    when(c) {
      kick();
      if (c && c.inCourse) return false;
      const s = C.store;
      return !!(s && ((s.enabled && s.products.length > 0) || s.myPending > 0));
    },
    render(c) { return cardHTML(c); },
  };

  // ── La tienda ─────────────────────────────────────────────────────────────
  function mineLinkInner() {
    const n = C.store ? C.store.myPending : 0;
    return 'Mis reservas' + (n > 0 ? '<i>' + esc(n) + '</i>' : '');
  }
  function addBtnHTML(p, inCart) {
    return '<button type="button" class="rx-pn-add' + (inCart ? ' on' : '') + '" data-rx="pn-toggle" data-id="' + esc(p.id) + '" aria-pressed="' + (inCart ? 'true' : 'false') + '">'
      + (inCart ? ic('Check', 14) + 'Agregado' : 'Agregar') + '</button>';
  }
  function prodHTML(p, i, s) {
    const inCart = !!CART[p.id];
    let tag = '', b;
    if (p.state === 'soon') {
      tag = '<i class="rx-pn-tag soon">Próximamente</i>';
      b = '<button type="button" class="rx-pn-add" disabled>Próximamente</button>';
    } else if (p.state === 'sold_out') {
      b = '<button type="button" class="rx-pn-add" disabled>Agotado</button>';
    } else {
      if (s.lowStockAt > 0 && p.stock <= s.lowStockAt) tag = '<i class="rx-pn-tag low">' + (p.stock === 1 ? 'Queda 1' : 'Quedan ' + esc(p.stock)) + '</i>';
      b = addBtnHTML(p, inCart);
    }
    return '<div class="rx-pn-prod rx-in is-' + esc(p.state) + (inCart ? ' on' : '') + '" style="--d:' + Math.min(i + 1, 8) + '" data-pn-p="' + esc(p.id) + '">'
      + '<div class="rx-pn-tile">' + imgHTML(p) + tag + '</div>'
      + '<b>' + esc(p.name) + '</b>' + b + '</div>';
  }
  function emptyHTML(icon, title, sub, retry) {
    return '<div class="rx-pn-empty">' + ic(icon, 26) + '<b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '')
      + (retry ? btn('Reintentar', { kind: 'sec', attrs: { 'data-rx': 'pn-retry' } }) : '') + '</div>';
  }
  function storeBody() {
    const s = C.store;
    if (s === undefined) return '<div class="rx-pn-empty"><span>Cargando la tienda…</span></div>';
    if (s === null) return emptyHTML('CloudOff', 'No pudimos abrir la tienda', C.err || 'Revisa tu conexión e inténtalo otra vez.', true);
    if (!s.enabled) return emptyHTML('Clock', 'La tienda no está abierta por ahora', s.myPending > 0 ? 'Tus reservas siguen guardadas en «Mis reservas».' : 'Vuelve pronto.');
    if (!s.products.length) return emptyHTML('Clock', 'Todavía no hay pines en la tienda', 'Vuelve pronto.');
    const promo = s.promo.on
      ? '<div class="rx-pn-promo"><i>Promo</i><span>Lleva ' + esc(s.promo.qty) + ' por <b>' + esc(money(s.promo.priceCOP)) + '</b></span></div>' : '';
    return '<div class="rx-pn-hero rx-in" style="--d:0">'
      + '<div class="rx-pn-hero-r"><h2>' + esc(s.title) + '</h2><b>' + esc(money(s.unitPriceCOP)) + ' c/u</b></div>'
      + promo
      + (s.storeNote ? '<p>' + esc(s.storeNote) + '</p>' : '')
      + '</div>'
      + '<div class="rx-pn-grid">' + s.products.map((p, i) => prodHTML(p, i, s)).join('') + '</div>';
  }
  function barHTML() {
    const s = C.store, P = AP(), n = units();
    if (!s || !s.enabled || !P || !n) return '<div class="rx-pn-bar is-off" data-pn-bar></div>';
    const tot = P.total(n, s), full = n * s.unitPriceCOP;
    return '<div class="rx-pn-bar" data-pn-bar>'
      + '<div><small>' + esc(pines(n)) + (tot < full ? ' · promo' : '') + '</small>'
      + '<span class="rx-pn-tot">' + esc(money(tot)) + (tot < full ? '<s>' + esc(money(full)) + '</s>' : '') + '</span></div>'
      + '<button type="button" class="rx-btn pri" data-rx="pn-review">Reservar</button>'
      + '</div>';
  }
  function storeHTML() {
    const u = UI();
    const right = '<button type="button" class="rx-pn-link" data-rx="pn-mine" data-pn-mine>' + mineLinkInner() + '</button>';
    const head = u && u.head ? u.head({ title: 'Tienda', right }) : '';
    return '<div class="rx-scr rx-pn-store">' + head + '<div class="rx-body">' + storeBody() + '</div>' + barHTML() + '</div>';
  }

  const storeScr = () => (ST.host && ST.host.isConnected ? ST.host.querySelector('.rx-pn-store') : null);
  function syncBar() {
    const scr = storeScr();
    const old = scr && scr.querySelector('[data-pn-bar]');
    if (old) old.replaceWith(parse(barHTML()).firstElementChild);
  }
  function syncProd(id) {
    const scr = storeScr(), p = byId()[id];
    const card = scr && scr.querySelector('[data-pn-p="' + id + '"]');
    if (!card || !p || p.state !== 'available') return;
    const inCart = !!CART[id];
    card.classList.toggle('on', inCart);
    const b = card.querySelector('.rx-pn-add');
    if (b) b.replaceWith(parse(addBtnHTML(p, inCart)).firstElementChild);
  }
  const sheetEl = () => { const r = document.getElementById('auxiliar-ui'); return r ? r.querySelector('.rx-sheet .rx-pn-sh') : null; };
  // La tienda cambió por detrás: se repinta SIN animar y sin mover el scroll.
  function refreshStore() {
    const scr = storeScr();
    if (!scr) return;
    const body = scr.querySelector(':scope > .rx-body');
    if (!body) return;
    const top = body.scrollTop;
    body.innerHTML = storeBody();
    settle(body);
    body.scrollTop = top;
    syncBar();
    const l = scr.querySelector('[data-pn-mine]');
    if (l) l.innerHTML = mineLinkInner();
    if (sheetEl() && !ST.busy) { const sh = SH(); if (units()) sh.sheet(reviewHTML()); else sh.closeSheet(); }
  }

  const STORE = {
    render(ctx) {
      if (ctx && ctx.reason === 'enter') { ST.err = ''; ST.busy = false; }
      return storeHTML();
    },
    after(ctx) {
      ST.host = ctx.host;
      load({ force: ctx.reason === 'enter' });
    },
    patch(ctx) { ST.host = ctx.host; refreshStore(); return true; },
    destroy(ctx) { if (ctx && ctx.reason === 'leave') ST.host = null; },
  };

  function toggleAct(el) {
    const id = el.getAttribute('data-id');
    const s = C.store, p = byId()[id];
    if (!s || !p || p.state !== 'available') return;
    if (CART[id]) delete CART[id];
    else {
      if (units() >= s.maxUnits) { toast('Máximo ' + pines(s.maxUnits) + ' por reserva', 'Info'); return; }
      CART[id] = 1;
    }
    syncProd(id);
    syncBar();
  }

  // ── Hoja «Tu reserva» ─────────────────────────────────────────────────────
  function reviewHTML() {
    const s = C.store, P = AP(), by = byId();
    if (!s || !P) return '';
    const n = units(), tot = P.total(n, s), full = n * s.unitPriceCOP;
    const lines = Object.keys(CART).filter(id => by[id]).map(id => {
      const p = by[id], q = CART[id];
      const more = q < p.stock && n < s.maxUnits;
      return '<div class="rx-pn-line">'
        + '<span class="rx-pn-thumb">' + imgHTML(p) + '</span>'
        + '<span class="rx-pn-line-tx"><b>' + esc(p.name) + '</b><span>' + esc(money(s.unitPriceCOP)) + '</span></span>'
        + '<div class="rx-step-ctl">'
        + '<button type="button" data-rx="pn-dec" data-id="' + esc(id) + '" aria-label="Menos"' + (ST.busy ? ' disabled' : '') + '>' + ic('Minus', 16) + '</button>'
        + '<b class="rx-noanim">' + esc(q) + '</b>'
        + '<button type="button" data-rx="pn-inc" data-id="' + esc(id) + '" aria-label="Más"' + (more && !ST.busy ? '' : ' disabled') + '>' + ic('Plus', 16) + '</button>'
        + '</div></div>';
    }).join('');
    return '<div class="rx-sh rx-pn-sh">'
      + '<h3>Tu reserva</h3>'
      + '<div class="rx-pn-lines">' + lines + '</div>'
      + '<div class="rx-pn-sum">'
      + (tot < full ? '<div class="pro"><span>Promo ' + esc(s.promo.qty) + ' por ' + esc(money(s.promo.priceCOP)) + '</span><span>−' + esc(money(full - tot)) + '</span></div>'
        // La promo es solo con su cantidad exacta: con más (o menos) se dice por qué no sale.
        : s.promo.on ? '<div class="solo"><span>La promo es solo al llevar ' + esc(pines(s.promo.qty)) + '.</span></div>' : '')
      + '<div class="tot"><span>Total</span><span>' + esc(money(tot)) + '</span></div>'
      + '</div>'
      + '<div class="rx-pn-note">' + ic('Info', 18) + '<p><b>Aquí no pagas.</b> A ' + esc(contact()) + ' le llega tu reserva y te entrega los pines.</p></div>'
      + '<div class="rx-pn-err"' + (ST.err ? '' : ' hidden') + '>' + esc(ST.err) + '</div>'
      + btn(ST.busy ? 'Reservando…' : 'Reservar', { kind: 'pri', disabled: ST.busy, attrs: { 'data-rx': 'pn-go' } })
      + btn('Seguir mirando', { kind: 'ghost', attrs: { 'data-rx': 'sheet-close' } })
      + '</div>';
  }
  function reviewAct() {
    const sh = SH();
    if (!sh || !units()) return;
    ST.err = '';
    sh.sheet(reviewHTML());
  }
  function stepAct(el, delta) {
    const id = el.getAttribute('data-id');
    const s = C.store, p = byId()[id], sh = SH();
    if (!s || !p || !CART[id] || ST.busy || !sh) return;
    const q = CART[id] + delta;
    if (delta > 0 && (q > p.stock || units() >= s.maxUnits)) return;
    if (q <= 0) delete CART[id]; else CART[id] = q;
    ST.err = '';
    syncProd(id);
    syncBar();
    if (units()) sh.sheet(reviewHTML()); else sh.closeSheet();
  }
  async function goAct() {
    const P = AP(), sh = SH();
    if (!P || !sh || ST.busy) return;
    const items = Object.keys(CART).map(id => ({ productId: id, qty: CART[id] }));
    if (!items.length) return;
    ST.busy = true; ST.err = '';
    sh.sheet(reviewHTML());
    let res = null, msg = '';
    try {
      res = await P.reserve(items);
      if (!res || !res.ok || !res.reservation) msg = 'No pudimos guardar la reserva';
    } catch (e) { msg = (e && e.message) || 'No pudimos guardar la reserva'; }
    if (msg) {
      // Lo más común: alguien se llevó el último. Se trae la tienda como está
      // ahora y lo agregado se ajusta solo.
      ST.err = msg;
      try { await load({ force: true }); } catch (_) { /* se queda la anterior */ }
      ST.busy = false;
      // Con la hoja abierta y algo todavía agregado, el motivo sale en la hoja.
      // Si ya no quedó nada (o la cerró), la hoja se va y el motivo sale arriba.
      const enHoja = !!sheetEl() && units() > 0;
      refreshStore();
      if (!enHoja) toast(msg, 'Info');
      return;
    }
    ST.busy = false; ST.err = '';
    CART = {};
    MN.list = undefined;
    if (C.store) C.store.myPending = (C.store.myPending || 0) + 1;
    sh.closeSheet();
    sh.push('pines-ok', { r: res.reservation });
    load({ force: true });
  }

  // ── «¡Reservado!» ─────────────────────────────────────────────────────────
  function okHTML(ctx) {
    const r = (ctx && ctx.props && ctx.props.r) || null;
    if (!r) return '<div class="rx-scr rx-pn-ok"><div class="rx-body"></div><div class="rx-foot">' + btn('Listo', { attrs: { 'data-rx': 'rx-pop' } }) + '</div></div>';
    const withImg = r.items.filter(i => i.image).slice(0, 2);
    const seal = '<div class="rx-pn-seal n' + withImg.length + '">'
      + withImg.map((i, k) => '<img class="i' + k + '" src="' + esc(i.image) + '" alt="" decoding="async">').join('')
      + '<span class="rx-pn-seal-ok">' + ic('Check', 22) + '</span></div>';
    const step = (n, t, d) => '<div class="rx-pn-next"><i>' + n + '</i><span><b>' + esc(t) + '</b><span>' + esc(d) + '</span></span></div>';
    return '<div class="rx-scr rx-pn-ok">'
      + '<div class="rx-body">'
      + '<div class="rx-pn-ok-top">' + seal
      + '<h2>¡Reservado!</h2>'
      + '<p>Te guardamos <b>' + esc(pines(r.units)) + '</b> por <b>' + esc(money(r.totalCOP)) + '</b>.</p></div>'
      + '<div class="rx-group rx-in" style="--d:2">'
      + step(1, contact() + ' ya lo sabe', 'Le llegó el aviso con tu nombre y tus pines.')
      + step(2, 'Te los entrega', 'Quedan en «Mis reservas» hasta que los recibas.')
      + '</div>'
      + '</div>'
      + '<div class="rx-foot">'
      + btn('Listo', { attrs: { 'data-rx': 'rx-pop' } })
      + btn('Ver mis reservas', { kind: 'sec', attrs: { 'data-rx': 'pn-ok-mine' } })
      + '</div>'
      + '</div>';
  }
  const OK = { layer: 'full', render: okHTML };

  // ── Mis reservas ──────────────────────────────────────────────────────────
  const ST_TXT = { reserved: 'Reservado', delivered: 'Entregado', cancelled: 'Cancelada' };
  function dia(iso) {
    const u = UI();
    if (!iso) return '';
    try { return u && u.dayLabel ? u.dayLabel(iso) : new Date(iso).toLocaleDateString('es-CO'); } catch (_) { return ''; }
  }
  function resHTML(r, i) {
    const st = ST_TXT[r.status] ? r.status : 'reserved';
    const items = r.items.map(it => '<div class="rx-pn-res-it"><span class="rx-pn-thumb sm">' + imgHTML(it) + '</span><b>' + esc(it.name) + '</b>'
      + (it.qty > 1 ? '<em>×' + esc(it.qty) + '</em>' : '') + '</div>').join('');
    const sub = st === 'reserved' ? 'Te los entrega ' + contact() + '.'
      : st === 'delivered' ? 'Entregado' + (r.deliveredAt ? ' · ' + dia(r.deliveredAt) : '') + '.'
        : (r.cancelNote || 'Esta reserva se canceló.');
    return '<div class="rx-pn-res rx-in is-' + st + '" style="--d:' + Math.min(i, 8) + '" data-k="r-' + esc(r.id) + '">'
      + '<div class="rx-pn-res-h"><span>' + esc(dia(r.reservedAt)) + '</span><i class="rx-pn-st ' + st + '">' + ST_TXT[st] + '</i></div>'
      + items
      + '<div class="rx-pn-res-f"><span>' + esc(sub) + '</span><b>' + esc(money(r.totalCOP)) + '</b></div>'
      + '</div>';
  }
  function mineBody() {
    const l = MN.list;
    if (l === undefined) return '<div class="rx-pn-empty"><span>Cargando tus reservas…</span></div>';
    if (l === null) return emptyHTML('CloudOff', 'No pudimos cargar tus reservas', MN.err || 'Revisa tu conexión e inténtalo otra vez.', true);
    if (!l.length) return emptyHTML('Gift', 'Todavía no has reservado pines', 'Cuando reserves, aquí ves si ya te los entregaron.');
    return l.map(resHTML).join('');
  }
  function mineHTML() {
    const u = UI();
    const head = u && u.head ? u.head({ title: 'Mis reservas' }) : '';
    return '<div class="rx-scr rx-pn-mias">' + head + '<div class="rx-body">' + mineBody() + '</div></div>';
  }
  function refreshMine(noanim) {
    const host = MN.host;
    const body = host && host.isConnected ? host.querySelector('.rx-pn-mias > .rx-body') : null;
    if (!body) return;
    const top = body.scrollTop;
    body.innerHTML = mineBody();
    if (noanim) settle(body);
    body.scrollTop = top;
  }
  function loadMine() {
    const P = AP();
    const req = ++MN.req;
    const had = Array.isArray(MN.list);
    if (!P) { MN.list = null; refreshMine(true); return Promise.resolve(); }
    return Promise.resolve().then(() => P.myReservations()).then(
      v => { if (req === MN.req) { MN.list = v == null ? null : v; MN.err = ''; } },
      e => { if (req === MN.req) { MN.err = (e && e.message) || ''; if (!had) MN.list = null; } }
    ).then(() => { if (req === MN.req) refreshMine(had); });
  }
  const MINE = {
    render() { return mineHTML(); },
    after(ctx) { MN.host = ctx.host; loadMine(); },
    patch(ctx) { MN.host = ctx.host; refreshMine(true); return true; },
    destroy(ctx) { if (ctx && ctx.reason === 'leave') MN.host = null; },
  };

  // ── Registro ──────────────────────────────────────────────────────────────
  window.AuxPines = {
    load, refresh: () => load({ force: true }),
    store: () => C.store,
    _st: () => ({ C, ST, MN, cart: CART }),
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('pines', STORE);
    sh.register('pines-ok', OK);
    sh.register('pines-mias', MINE);
    sh.hook('home.card', HOME_CARD);
    sh.action('pn-open', () => { const s = SH(); if (s) s.push('pines', {}); });
    sh.action('pn-mine', () => { const s = SH(); if (s) s.push('pines-mias', {}); });
    sh.action('pn-ok-mine', () => { const s = SH(); if (!s) return; s.pop(); s.push('pines-mias', {}); });
    sh.action('pn-toggle', toggleAct);
    sh.action('pn-review', reviewAct);
    sh.action('pn-inc', (el) => stepAct(el, 1));
    sh.action('pn-dec', (el) => stepAct(el, -1));
    sh.action('pn-go', goAct);
    sh.action('pn-retry', () => {
      const s = SH(), cur = s && s.current ? s.current() : null;
      if (cur && cur.id === 'pines-mias') { MN.list = undefined; refreshMine(true); loadMine(); return; }
      C.store = undefined; refreshStore(); load({ force: true });
    });
  }
})();
