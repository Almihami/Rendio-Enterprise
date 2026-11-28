// admin-pines.js — Pines del jefe (0181, 27-nov-2026).
//
// La pantalla «Pines» de la consola (Rutas › Equipo). Tres vistas:
//   · Reservas    → quién reservó, qué pines y cuánto es. El jefe entrega en
//                   persona y aquí cambia el estado: «Marcar entregado»,
//                   «Deshacer la entrega» o «Cancelar» (los pines vuelven al
//                   inventario y al tripulante le llega el aviso).
//   · Inventario  → cuántos hay de cada pin y cómo sale en la tienda: Disponible,
//                   Próximamente (se ve y no se reserva), Agotado u Oculto.
//                   También crear un pin nuevo con su imagen.
//   · Ajustes     → encender la tienda, los textos, quién entrega, el precio, la
//                   promo, desde cuándo se dice «Quedan N» y el máximo por reserva.
//
// Todo sale de window.ApiPines (0181). EN LA APP NO SE PAGA: el total de una
// reserva es lo que el tripulante le paga al jefe al recibir los pines.
//
// El aviso de una reserva nueva llega por notificación del teléfono (lo encola
// la base) y aquí como globo rojo en el menú, que se revisa cada 30 s. Al abrir
// la pantalla las reservas nuevas quedan vistas y el globo se apaga.
//
// Contrato (lo usan core.js y admin-consola.js):
//   window.renderPines()       — pinta y carga (setTab('pines'))
//   window.renderPines.badge() — refresca el globo del menú
//   window.stopPinesTimer()    — al salir de la pantalla
(function () {
  'use strict';

  const TZ = 'America/Bogota';
  const POLL_MS = 30000;
  const BADGE_MS = 30000;
  const VIEWS = [['reservas', 'Reservas'], ['inventario', 'Inventario'], ['ajustes', 'Ajustes']];
  const FILTERS = [['reserved', 'Por entregar'], ['delivered', 'Entregadas'], ['cancelled', 'Canceladas']];
  const STATUS = [['available', 'Disponible'], ['soon', 'Próximamente'], ['sold_out', 'Agotado'], ['hidden', 'Oculto']];

  // data: undefined = cargando · null = no se pudo (o falta 0181) · {settings, counts, products, reservations}
  const st = {
    view: 'reservas', filter: 'reserved', bound: false, req: 0,
    data: undefined, err: '', busy: {}, errs: {},
    cancelling: null, editing: null, draftName: '', file: null, fileUrl: '',
    fresh: {}, timer: null,
  };

  const AP = () => window.ApiPines || null;
  const root = () => document.getElementById('pines-ui');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const svg = (id, cls) => '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#' + id + '"/></svg>';
  const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const money = (n) => { const P = AP(); return P ? P.money(n) : '$' + n0(n); };
  const pines = (n) => n + (n === 1 ? ' pin' : ' pines');
  function fecha(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-CO', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return ''; }
  }
  function toastMsg(m) { if (typeof window.toast === 'function') window.toast(m); }
  function why(title, body) {
    // eslint-disable-next-line no-undef
    return typeof rdWhy === 'function' ? rdWhy(title, body) : '';
  }
  const wrap = (fn) => (typeof fn === 'function' ? Promise.resolve().then(fn) : Promise.resolve(null));
  const errText = (e) => (e && e.message) || 'No se pudo completar';
  const img = (o) => (o && o.image ? '<img src="' + esc(o.image) + '" alt="" loading="lazy" decoding="async">' : svg('i-gift'));
  function esJefe() {
    // eslint-disable-next-line no-undef
    try { const g = typeof state !== 'undefined' ? state : null; return !!(g && g.profile && g.profile.role === 'admin'); } catch (_) { return false; }
  }
  function visible() {
    const r = root();
    return !!(r && r.offsetParent !== null);
  }
  const anyBusy = () => Object.keys(st.busy).some(k => st.busy[k]);

  // ── Globo del menú ─────────────────────────────────────────────────────────
  let lastUnseen = null;
  let badgeBusy = false;
  function paintBadge(n) {
    const v = Math.max(0, n0(n));
    lastUnseen = v;
    const b = document.getElementById('pines-badge');
    if (!b) return;
    b.textContent = v > 99 ? '99+' : String(v);
    b.classList.toggle('hidden', !v);
    b.setAttribute('aria-label', v === 1 ? '1 reserva nueva' : v + ' reservas nuevas');
  }
  async function refreshBadge() {
    if (badgeBusy || !esJefe()) return;
    const P = AP();
    if (!P || typeof P.adminCounts !== 'function') return;
    badgeBusy = true;
    let c = null;
    try { c = await P.adminCounts(); } catch (_) { c = null; }
    badgeBusy = false;
    if (!c) return;
    // Con la pantalla abierta la cuenta la lleva ella (y las marca vistas).
    if (visible()) return;
    if (lastUnseen != null && c.unseen > lastUnseen) {
      toastMsg(c.unseen - lastUnseen === 1 ? 'Nueva reserva de pines' : 'Hay reservas nuevas de pines');
    }
    paintBadge(c.unseen);
  }
  setInterval(() => { if (!document.hidden) refreshBadge(); }, BADGE_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadge(); });

  // ── Carga ──────────────────────────────────────────────────────────────────
  const sigOf = (d) => (d ? JSON.stringify([d.settings, d.counts, d.products, d.reservations]) : String(d));
  // ¿Se puede repintar sin pisarle nada al jefe? (un formulario abierto, algo guardándose)
  function canRepaint() {
    if (st.cancelling || st.editing || st.view === 'ajustes' || anyBusy()) return false;
    const r = root(), a = document.activeElement;
    return !(r && a && r.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function markSeen() {
    const P = AP();
    if (!P) return;
    wrap(() => P.adminMarkSeen()).then(c => {
      if (!c) return;
      if (st.data) st.data.counts = c;
      paintBadge(c.unseen);
    }, () => { /* se intenta en la próxima carga */ });
  }
  function load(silent) {
    const P = AP();
    const req = ++st.req;
    if (!P) { st.data = null; paint(); return Promise.resolve(); }
    return wrap(() => P.adminOverview()).then(v => {
      if (req !== st.req) return;
      const was = sigOf(st.data);
      st.data = v == null ? null : v;
      st.err = '';
      if (v) {
        v.reservations.forEach(r => { if (r.isNew && r.status === 'reserved') st.fresh[r.id] = true; });
        if (v.counts.unseen > 0 && visible()) markSeen(); else paintBadge(v.counts.unseen);
      }
      if (!silent || (sigOf(st.data) !== was && canRepaint())) paint();
    }, e => {
      if (req !== st.req) return;
      if (silent && st.data) return;
      st.data = null; st.err = errText(e);
      paint();
    });
  }
  function startTimer() {
    clearInterval(st.timer);
    st.timer = setInterval(() => { if (visible() && !document.hidden) load(true); }, POLL_MS);
  }
  function dropFile() {
    if (st.fileUrl) { try { URL.revokeObjectURL(st.fileUrl); } catch (_) { /* */ } }
    st.file = null; st.fileUrl = '';
  }
  function stopPinesTimer() {
    clearInterval(st.timer); st.timer = null;
    st.fresh = {}; st.cancelling = null; st.editing = null; st.errs = {};
    dropFile();
  }

  // ── Pintado ────────────────────────────────────────────────────────────────
  const isOn = () => !!(st.data && st.data.settings && st.data.settings.enabled === true);
  const pending = () => (st.data && st.data.counts ? st.data.counts.pending : 0);
  const hayParaReservar = () => !!(st.data && st.data.products.some(p => p.status === 'available' && p.stock > 0));
  // Cómo está la tienda: 'off' apagada · 'card' solo la tarjeta (0182) · 'open' abierta.
  const modo = () => { const s = st.data && st.data.settings; return !s || !s.enabled ? 'off' : s.cardOnly ? 'card' : 'open'; };
  function estadoHTML() {
    const m = modo();
    const ir = (t) => '<button class="set-btn ghost sm" data-pn="view" data-v="ajustes">' + t + '</button>';
    if (m === 'off') {
      return '<div class="pn-state off">' + svg('i-zzz') + '<span><b>Tienda apagada.</b> Los tripulantes no ven nada de pines.</span>' + ir('Encenderla') + '</div>';
    }
    if (m === 'card') {
      return '<div class="pn-state card">' + svg('i-info') + '<span><b>Solo la tarjeta.</b> Los tripulantes ven el anuncio de pines en su Inicio, pero todavía no pueden entrar a la tienda ni reservar.</span>' + ir('Abrir la tienda') + '</div>';
    }
    return '<div class="pn-state on">' + svg('i-check') + '<span>' + (hayParaReservar()
      ? '<b>Tienda abierta.</b> Los tripulantes entran desde la tarjeta de su Inicio y pueden reservar.'
      : '<b>Tienda abierta.</b> Los tripulantes entran y ven los pines, pero todavía no pueden reservar: ninguno está «Disponible» con unidades.')
      + '</span></div>';
  }

  function headHTML() {
    const cnt = st.data && pending() ? '<span class="sh-ct">' + esc(pending()) + '</span>' : '';
    const state = st.data === undefined ? ''
      : st.data === null ? '<div class="pn-state none">' + svg('i-info') + '<span>No se pudo abrir la tienda de pines' + (st.err ? ': ' + esc(st.err) : '. Puede faltar la migración 0181.') + '</span></div>'
        : estadoHTML();
    return '<div class="sh-phead"><div>'
      + '<h1>Pines ' + cnt + '</h1>'
      + '<p>Los pines que los tripulantes reservan desde su app. <b>En la app no se paga</b>: tú entregas y cobras en persona, y aquí marcas la reserva como entregada.</p>'
      + why('¿Cómo se mueve el inventario?', 'Cuando un tripulante reserva, esas unidades <b>se descuentan solas</b> de «Disponibles» para que nadie más se las lleve. Si cancelas la reserva, <b>vuelven</b>. Marcar entregado no mueve nada: ya estaban apartadas. Un pin disponible que se queda sin unidades sale «Agotado» solo.')
      + '</div><button class="set-btn ghost" data-pn="refresh">' + svg('i-refresh') + 'Refrescar</button></div>'
      + state
      + '<div class="pn-tabs" role="tablist">' + VIEWS.map(([k, l]) => '<button role="tab" data-pn="view" data-v="' + k + '"' + (st.view === k ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>' + esc(l)
        + (k === 'reservas' && pending() ? ' <i>' + esc(pending()) + '</i>' : '') + '</button>').join('') + '</div>';
  }
  function emptyHTML(title, sub, retry) {
    return '<div class="pn-empty"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '')
      + (retry ? '<button class="set-btn ghost" data-pn="refresh">' + svg('i-refresh') + 'Reintentar</button>' : '') + '</div>';
  }
  const loadingHTML = () => '<div class="pn-empty"><span>Cargando…</span></div>';
  const errHTML = (k) => (st.errs[k] ? '<div class="pn-err">' + esc(st.errs[k]) + '</div>' : '');

  // Reservas
  function resCard(r) {
    const k = 'res:' + r.id;
    const busy = st.busy[k];
    const tag = r.status === 'reserved' ? '<span class="pn-tag wait">Reservado</span>'
      : r.status === 'delivered' ? '<span class="pn-tag ok">Entregado</span>' : '<span class="pn-tag no">Cancelada</span>';
    const fresh = r.status === 'reserved' && st.fresh[r.id] ? ' <span class="pn-tag new">Nueva</span>' : '';
    const items = r.items.map(i => '<span class="pn-it"><span class="pn-th">' + img(i) + '</span><span>' + esc(i.name) + (i.qty > 1 ? ' <em>×' + esc(i.qty) + '</em>' : '') + '</span></span>').join('');
    let acts = '';
    if (r.status === 'reserved') {
      if (st.cancelling === r.id) {
        acts = '<div class="pn-rej"><label>Motivo (opcional; al tripulante le llega en el aviso)<textarea data-pn-f="cancel-note" maxlength="200" rows="2" placeholder="Ej.: ese pin se agotó"></textarea></label>'
          + '<div class="pn-acts"><button class="set-btn ghost" data-pn="cancel-back">Volver</button>'
          + '<button class="set-btn danger" data-pn="cancel-go" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-x') + (busy ? 'Cancelando…' : 'Cancelar la reserva') + '</button></div></div>';
      } else {
        acts = '<div class="pn-acts">'
          + '<button class="set-btn ghost" data-pn="cancel-open" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-x') + 'Cancelar</button>'
          + '<button class="set-btn" data-pn="deliver" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-check') + (busy ? 'Guardando…' : 'Marcar entregado') + '</button>'
          + '</div>';
      }
    } else if (r.status === 'delivered') {
      acts = '<div class="pn-acts"><button class="set-btn ghost sm" data-pn="reopen" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Guardando…' : 'Deshacer la entrega') + '</button></div>';
    }
    return '<div class="pn-card res ' + (r.status === 'reserved' ? 'wait' : r.status === 'delivered' ? 'ok' : 'no') + '">'
      + '<div class="pn-top"><div><b>' + esc(r.crewName || 'Tripulante') + fresh + '</b><span>' + esc(r.residence || 'Sin conjunto') + (r.crewPhone ? ' · ' + esc(r.crewPhone) : '') + '</span></div>' + tag + '</div>'
      + '<div class="pn-its">' + items + '</div>'
      + '<div class="pn-meta">'
      + '<span><b>Pines</b>' + esc(r.units) + '</span>'
      + '<span><b>Total</b>' + esc(money(r.totalCOP)) + '</span>'
      + (r.discountCOP > 0 ? '<span><b>Promo</b>' + esc(r.promoLabel || 'Sí') + ' · −' + esc(money(r.discountCOP)) + '</span>' : '')
      + '<span><b>Reservó</b>' + esc(fecha(r.reservedAt)) + '</span>'
      + (r.deliveredAt ? '<span><b>Entregado</b>' + esc(fecha(r.deliveredAt)) + '</span>' : '')
      + (r.cancelledAt ? '<span><b>Cancelada</b>' + esc(fecha(r.cancelledAt)) + '</span>' : '')
      + '</div>'
      + (r.cancelNote ? '<p class="pn-note"><b>Motivo:</b> ' + esc(r.cancelNote) + '</p>' : '')
      + errHTML(k) + acts
      + '</div>';
  }
  function reservasHTML() {
    const d = st.data;
    const count = (s) => d.reservations.filter(r => r.status === s).length;
    const filter = '<div class="pn-filter">' + FILTERS.map(([k, l]) => '<button data-pn="filter" data-v="' + k + '"' + (st.filter === k ? ' class="on"' : '') + '>' + esc(l) + ' · ' + count(k) + '</button>').join('') + '</div>';
    let list = d.reservations.filter(r => r.status === st.filter);
    // Por entregar: la que más lleva esperando, arriba. Lo demás, lo último primero.
    if (st.filter === 'reserved') list = list.slice().sort((a, b) => String(a.reservedAt).localeCompare(String(b.reservedAt)));
    else if (st.filter === 'delivered') list = list.slice().sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)));
    else list = list.slice().sort((a, b) => String(b.cancelledAt).localeCompare(String(a.cancelledAt)));
    const m = modo();
    const vacio = st.filter === 'reserved' ? ['No hay pines por entregar', m === 'open' ? 'Cuando un tripulante reserve, aparece aquí y te llega la notificación.'
      : m === 'card' ? 'La tienda está en «solo la tarjeta»: nadie puede reservar todavía.' : 'La tienda está apagada: nadie puede reservar todavía.']
      : st.filter === 'delivered' ? ['Todavía no has entregado pines', ''] : ['No hay reservas canceladas', ''];
    return filter + (list.length ? list.map(resCard).join('') : emptyHTML(vacio[0], vacio[1]));
  }

  // Inventario
  function efectivo(p, s) {
    if (p.status === 'hidden') return ['no', 'Oculto'];
    if (p.status === 'soon') return ['soon', 'Próximamente'];
    if (p.status === 'sold_out' || p.stock <= 0) return ['out', 'Agotado'];
    if (s && s.lowStockAt > 0 && p.stock <= s.lowStockAt) return ['wait', p.stock === 1 ? 'Queda 1' : 'Quedan ' + p.stock];
    return ['ok', 'Disponible'];
  }
  function editCard(p) {
    const isNew = !p;
    const key = isNew ? 'new' : p.id;
    const k = 'p:' + key;
    const busy = st.busy[k];
    const prev = st.fileUrl ? '<img src="' + esc(st.fileUrl) + '" alt="">' : (p ? img(p) : svg('i-plus'));
    return '<div class="pn-card edit" data-p="' + esc(key) + '">'
      + '<h3>' + (isNew ? 'Pin nuevo' : 'Editar pin') + '</h3>'
      + '<div class="pn-edit"><span class="pn-th xl" data-pn-prev>' + prev + '</span>'
      + '<div class="pn-edit-f">'
      + '<label class="pn-field"><span>Nombre</span><input type="text" maxlength="40" data-pn-f="name" value="' + esc(st.draftName) + '" placeholder="Ej.: Pingüino piloto"></label>'
      + '<label class="pn-field"><span>Imagen' + (isNew ? '' : ' (déjala vacía si no cambia)') + '</span><input type="file" accept="image/png,image/webp,image/jpeg" data-pn-f="file"><small>PNG o WebP con fondo transparente, hasta 2 MB.</small></label>'
      + '</div></div>'
      + (isNew ? '<p class="pn-hint">' + svg('i-info') + 'Entra como «Próximamente» y sin unidades. Después le pones el inventario y lo pasas a «Disponible».</p>' : '')
      + errHTML(k)
      + '<div class="pn-acts"><button class="set-btn ghost" data-pn="edit-back"' + (busy ? ' disabled' : '') + '>Volver</button>'
      + '<button class="set-btn" data-pn="edit-save" data-id="' + esc(key) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-save') + (busy ? 'Guardando…' : isNew ? 'Crear pin' : 'Guardar') + '</button></div>'
      + '</div>';
  }
  function prodCard(p) {
    if (st.editing === p.id) return editCard(p);
    const k = 'p:' + p.id;
    const busy = st.busy[k];
    const ef = efectivo(p, st.data.settings);
    const sub = (p.reservedUnits ? p.reservedUnits + (p.reservedUnits === 1 ? ' reservado' : ' reservados') + ' por entregar' : 'Sin reservas por entregar')
      + (p.deliveredUnits ? ' · ' + p.deliveredUnits + (p.deliveredUnits === 1 ? ' entregado' : ' entregados') : '');
    return '<div class="pn-card prod' + (p.status === 'hidden' ? ' off' : '') + '" data-p="' + esc(p.id) + '">'
      + '<div class="pn-p-row">'
      + '<span class="pn-th lg">' + img(p) + '</span>'
      + '<div class="pn-p-tx"><b>' + esc(p.name) + ' <span class="pn-tag ' + ef[0] + '">' + esc(ef[1]) + '</span></b><span>' + esc(sub) + '</span></div>'
      + '<label class="pn-field sm"><span>Cómo sale</span><select data-pn-f="status" data-id="' + esc(p.id) + '"' + (busy ? ' disabled' : '') + '>'
      + STATUS.map(([v, l]) => '<option value="' + v + '"' + (p.status === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>'
      + '<div class="pn-field sm"><span>Disponibles</span><div class="pn-stock">'
      + '<button type="button" data-pn="stock-dec" data-id="' + esc(p.id) + '" aria-label="Restar uno"' + (busy || p.stock <= 0 ? ' disabled' : '') + '>−</button>'
      + '<input type="number" inputmode="numeric" min="0" max="100000" step="1" data-pn-f="stock" data-id="' + esc(p.id) + '" value="' + esc(p.stock) + '" aria-label="Unidades disponibles"' + (busy ? ' disabled' : '') + '>'
      + '<button type="button" data-pn="stock-inc" data-id="' + esc(p.id) + '" aria-label="Sumar uno"' + (busy ? ' disabled' : '') + '>+</button>'
      + '</div></div>'
      + '<button class="set-btn ghost sm" data-pn="edit" data-id="' + esc(p.id) + '">' + svg('i-edit') + 'Editar</button>'
      + '</div>'
      + errHTML(k)
      + '</div>';
  }
  function inventarioHTML() {
    const d = st.data;
    return '<div class="pn-lead-row"><p class="pn-lead">Cuántos hay de cada pin y cómo sale en la tienda. <b>Disponible</b>: se puede reservar. <b>Próximamente</b>: se ve y todavía no se reserva. <b>Agotado</b>: sale agotado aunque queden unidades. <b>Oculto</b>: no sale.</p>'
      + (st.editing === 'new' ? '' : '<button class="set-btn" data-pn="new">' + svg('i-plus') + 'Agregar pin</button>') + '</div>'
      + (st.editing === 'new' ? editCard(null) : '')
      + (d.products.length ? d.products.map(prodCard).join('') : emptyHTML('Todavía no hay pines', 'Agrega el primero con su imagen.'));
  }

  // Ajustes
  function field(key, label, val, o) {
    o = o || {};
    const num = o.type === 'number';
    return '<label class="pn-field' + (o.wide ? ' wide' : '') + '"><span>' + esc(label) + '</span>'
      + '<span class="pn-in' + (num ? ' num' : '') + '">' + (o.pre ? '<em>' + esc(o.pre) + '</em>' : '')
      + '<input type="' + (num ? 'number' : 'text') + '"' + (num ? ' inputmode="numeric" step="1" min="' + (o.min == null ? 0 : o.min) + '" max="' + o.max + '"' : ' maxlength="' + o.max + '"')
      + ' data-pn-f="' + key + '" value="' + esc(val == null ? '' : val) + '"' + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + '>'
      + (o.unit ? '<em>' + esc(o.unit) + '</em>' : '') + '</span>'
      + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</label>';
  }
  function previewText(s) {
    const P = AP();
    if (!P || !(s.unitPriceCOP > 0)) return '';
    const cfg = { unitPriceCOP: s.unitPriceCOP, promo: { on: !!s.promoEnabled, qty: s.promoQty, priceCOP: s.promoPriceCOP } };
    return [1, 2, 3, 4].map(n => pines(n) + ' ' + money(P.total(n, cfg))).join(' · ');
  }
  function ajustesHTML() {
    const s = st.data.settings;
    if (!s) return emptyHTML('No se pudieron leer los ajustes', '', true);
    const m = modo();
    const opt = (v, t, d) => '<label class="pn-mode"><input type="radio" name="pn-mode" data-pn-f="mode" value="' + v + '"' + (m === v ? ' checked' : '') + '><span><b>' + t + '</b><small>' + d + '</small></span></label>';
    return '<div class="pn-card"><h3>Cómo está la tienda</h3><div class="pn-modes">'
      + opt('off', 'Apagada', 'Los tripulantes no ven nada de pines. Las reservas que ya existen se quedan.')
      // «Solo la tarjeta» existe desde 0182: en una base sin ella no se ofrece.
      + (s.cardOnlySupported ? opt('card', 'Solo la tarjeta', 'Ven el anuncio en su Inicio. No pueden entrar a la tienda ni reservar.') : '')
      + opt('open', 'Abierta', 'Entran a la tienda desde la tarjeta y reservan los pines que estén disponibles.')
      + '</div></div>'
      + '<div class="pn-card"><h3>Lo que ve el tripulante</h3><div class="pn-grid">'
      + field('title', 'Nombre de la tienda', s.title, { max: 40 })
      + field('contactName', 'Quién entrega', s.contactName, { max: 30, hint: 'Sale así: «A ' + (s.contactName || 'Julián') + ' le llega tu reserva y te entrega los pines».' })
      + field('cardText', 'Texto de la tarjeta de Inicio', s.cardText, { max: 90, wide: true, hint: 'La tarjeta no muestra precio ni promo: solo invita a entrar.' })
      + field('storeNote', 'Nota dentro de la tienda (opcional)', s.storeNote, { max: 160, wide: true, ph: 'Ej.: Se pagan al recibirlos.' })
      + '</div></div>'
      + '<div class="pn-card"><h3>Precio y promo</h3><div class="pn-grid">'
      + field('unitPriceCOP', 'Precio de un pin', s.unitPriceCOP, { type: 'number', min: 100, max: 1000000, pre: '$' })
      + '<label class="pn-check wide"><input type="checkbox" data-pn-f="promoEnabled"' + (s.promoEnabled ? ' checked' : '') + '><span>Hay promo</span></label>'
      + field('promoQty', 'La promo es por llevar exactamente', s.promoQty, { type: 'number', min: 2, max: 12, unit: 'pines', hint: 'Con más o con menos, cada pin va a precio normal.' })
      + field('promoPriceCOP', 'Y valen', s.promoPriceCOP, { type: 'number', min: 100, max: 12000000, pre: '$' })
      + '</div><p class="pn-hint">' + svg('i-info') + '<span>Así queda: <b data-pn-preview>' + esc(previewText(s)) + '</b></span></p></div>'
      + '<div class="pn-card"><h3>Reglas</h3><div class="pn-grid">'
      + field('lowStockAt', 'Decir «Quedan N» desde', s.lowStockAt, { type: 'number', min: 0, max: 50, unit: 'unidades', hint: 'Con 0 nunca se dice cuántos quedan.' })
      + field('maxUnits', 'Máximo por reserva', s.maxUnits, { type: 'number', min: 1, max: 50, unit: 'pines' })
      + '</div></div>'
      + '<div class="pn-save"><button class="set-btn" data-pn="save-settings">' + svg('i-save') + 'Guardar</button><span class="pn-msg" data-pn-msg></span></div>';
  }

  function bodyHTML() {
    if (!AP()) return emptyHTML('La tienda de pines no está cargada', 'Falta api-pines.js en esta versión de la app.');
    if (st.data === undefined) return loadingHTML();
    if (st.data === null) return emptyHTML('No se pudo cargar', st.err || 'Puede faltar la migración 0181 o la sesión.', true);
    if (st.view === 'inventario') return inventarioHTML();
    if (st.view === 'ajustes') return ajustesHTML();
    return reservasHTML();
  }
  function paint() {
    const r = root();
    if (!r) return;
    r.innerHTML = '<div class="pn-wrap">' + headHTML() + '<div id="pn-body">' + bodyHTML() + '</div></div>';
  }
  function paintBody() {
    const b = document.getElementById('pn-body');
    if (!b) { paint(); return; }
    b.innerHTML = bodyHTML();
  }

  // ── Acciones ───────────────────────────────────────────────────────────────
  const q = (sel) => { const r = root(); return r ? r.querySelector(sel) : null; };
  const val = (key) => { const el = q('[data-pn-f="' + key + '"]'); return el ? String(el.value || '').trim() : ''; };

  async function setReservation(id, action, note) {
    const P = AP();
    const k = 'res:' + id;
    if (!P || st.busy[k]) return;
    st.busy[k] = true; delete st.errs[k]; paintBody();
    try {
      const res = await P.adminSetReservation(id, action, note || null);
      if (res.reservation && st.data) {
        st.data.reservations = st.data.reservations.map(r => (r.id === id ? Object.assign({}, r, res.reservation, { crewName: r.crewName, crewPhone: r.crewPhone, residence: r.residence }) : r));
        if (res.counts) { st.data.counts = res.counts; paintBadge(res.counts.unseen); }
      }
      delete st.fresh[id];
      st.cancelling = null;
      toastMsg(action === 'deliver' ? 'Reserva entregada' : action === 'reopen' ? 'La reserva volvió a «Por entregar»' : 'Reserva cancelada · los pines volvieron al inventario');
      st.busy[k] = false;
      paint();
      load(true);   // el inventario y los contadores, como quedaron en la base
      return;
    } catch (e) { st.errs[k] = errText(e); }
    st.busy[k] = false;
    paintBody();
  }

  async function saveProduct(key, patch, okMsg) {
    const P = AP();
    const k = 'p:' + key;
    if (!P || st.busy[k]) return false;
    st.busy[k] = true; delete st.errs[k]; paintBody();
    let ok = false;
    try {
      const row = await P.adminSaveProduct(patch);
      if (row && st.data) {
        const i = st.data.products.findIndex(x => x.id === row.id);
        if (i >= 0) st.data.products[i] = row; else st.data.products.push(row);
      }
      ok = true;
      if (okMsg) toastMsg(okMsg);
    } catch (e) { st.errs[k] = errText(e); }
    st.busy[k] = false;
    paintBody();
    return ok;
  }

  function openEdit(id) {
    dropFile();
    st.editing = id;
    delete st.errs['p:' + id];
    const p = id === 'new' ? null : (st.data.products.find(x => x.id === id) || null);
    st.draftName = p ? p.name : '';
    paintBody();
    const i = q('[data-pn-f="name"]');
    if (i) i.focus();
  }
  async function saveEdit(key) {
    const P = AP();
    const k = 'p:' + key;
    if (!P || st.busy[k]) return;
    const isNew = key === 'new';
    const name = st.draftName.trim();
    if (!name) { st.errs[k] = 'Escribe el nombre del pin'; paintBody(); return; }
    if (isNew && !st.file) { st.errs[k] = 'Elige la imagen del pin'; paintBody(); return; }
    const patch = { name };
    if (!isNew) patch.id = key;
    if (st.file) {
      st.busy[k] = true; delete st.errs[k]; paintBody();
      try { patch.imagePath = await P.adminUploadImage(st.file); }
      catch (e) { st.busy[k] = false; st.errs[k] = errText(e); paintBody(); return; }
      st.busy[k] = false;
    }
    const ok = await saveProduct(key, patch, isNew ? 'Pin creado' : 'Pin guardado');
    if (ok) { st.editing = null; dropFile(); paintBody(); }
  }

  function setMsg(ok, text) {
    const m = q('[data-pn-msg]');
    if (!m) return;
    m.className = 'pn-msg' + (text ? (ok ? ' ok' : ' bad') : '');
    m.textContent = text || '';
  }
  function readSettings() {
    const r = root();
    const chk = (k) => !!((r && r.querySelector('[data-pn-f="' + k + '"]')) || {}).checked;
    const num = (k) => { const v = val(k); return v === '' ? NaN : Number(v); };
    const mode = ((r && r.querySelector('[data-pn-f="mode"]:checked')) || {}).value || 'off';
    const sup = !!(st.data && st.data.settings && st.data.settings.cardOnlySupported);
    return {
      // Apagada deja «solo la tarjeta» puesto: al volver a encender no se abre sola.
      enabled: mode !== 'off', cardOnly: sup ? mode !== 'open' : undefined, mode, title: val('title'), cardText: val('cardText'), storeNote: val('storeNote'),
      contactName: val('contactName'), unitPriceCOP: num('unitPriceCOP'), promoEnabled: chk('promoEnabled'),
      promoQty: num('promoQty'), promoPriceCOP: num('promoPriceCOP'), lowStockAt: num('lowStockAt'), maxUnits: num('maxUnits'),
    };
  }
  // El formulario NO se repinta al fallar: lo que el jefe escribió se queda.
  async function saveSettings() {
    const P = AP();
    if (!P || st.busy.settings) return;
    const s = readSettings();
    const nums = ['unitPriceCOP', 'promoQty', 'promoPriceCOP', 'lowStockAt', 'maxUnits'];
    if (nums.some(k => !Number.isInteger(s[k]))) { setMsg(false, 'Revisa los números: hay uno vacío o con decimales'); return; }
    if (!s.title) { setMsg(false, 'Escribe el nombre de la tienda'); return; }
    if (!s.contactName) { setMsg(false, 'Escribe quién entrega los pines'); return; }
    const b = q('[data-pn="save-settings"]');
    st.busy.settings = true;
    if (b) b.disabled = true;
    setMsg(true, 'Guardando…');
    try {
      const saved = await P.adminSaveSettings(s);
      st.busy.settings = false;
      if (saved && st.data) st.data.settings = saved;
      toastMsg('Pines guardado · ' + (s.mode === 'open' ? 'tienda abierta' : s.mode === 'card' ? 'solo la tarjeta' : 'tienda apagada'));
      paint();
      setMsg(true, 'Guardado');
      return;
    } catch (e) { setMsg(false, errText(e)); }
    st.busy.settings = false;
    if (b) b.disabled = false;
  }

  function onClick(e) {
    const el = e.target.closest && e.target.closest('[data-pn]');
    if (!el || !root() || !root().contains(el) || el.disabled) return;
    const a = el.getAttribute('data-pn');
    const id = el.getAttribute('data-id');
    if (a === 'refresh') { st.errs = {}; if (st.data === null) { st.data = undefined; paint(); } load(); return; }
    if (a === 'view') {
      const v = el.getAttribute('data-v');
      if (VIEWS.some(x => x[0] === v) && v !== st.view) { st.view = v; st.cancelling = null; st.editing = null; st.errs = {}; dropFile(); paint(); }
      return;
    }
    if (!st.data) return;
    if (a === 'filter') { const v = el.getAttribute('data-v'); if (v && v !== st.filter) { st.filter = v; st.cancelling = null; paintBody(); } return; }
    if (a === 'deliver') { setReservation(id, 'deliver'); return; }
    if (a === 'reopen') { setReservation(id, 'reopen'); return; }
    if (a === 'cancel-open') { st.cancelling = id; delete st.errs['res:' + id]; paintBody(); const t = q('[data-pn-f="cancel-note"]'); if (t) t.focus(); return; }
    if (a === 'cancel-back') { st.cancelling = null; paintBody(); return; }
    if (a === 'cancel-go') { setReservation(id, 'cancel', val('cancel-note')); return; }
    if (a === 'stock-inc') { saveProduct(id, { id, stockDelta: 1 }); return; }
    if (a === 'stock-dec') { saveProduct(id, { id, stockDelta: -1 }); return; }
    if (a === 'new') { openEdit('new'); return; }
    if (a === 'edit') { openEdit(id); return; }
    if (a === 'edit-back') { st.editing = null; dropFile(); st.errs = {}; paintBody(); return; }
    if (a === 'edit-save') { saveEdit(id); return; }
    if (a === 'save-settings') { saveSettings(); }
  }
  function onChange(e) {
    const el = e.target;
    const f = el && el.getAttribute ? el.getAttribute('data-pn-f') : null;
    if (!f || !st.data) return;
    const id = el.getAttribute('data-id');
    if (f === 'status') {
      const label = (STATUS.find(x => x[0] === el.value) || [])[1];
      saveProduct(id, { id, status: el.value }, label ? 'Ahora sale como «' + label + '»' : '');
      return;
    }
    if (f === 'stock') {
      const p = st.data.products.find(x => x.id === id);
      const v = el.value.trim() === '' ? NaN : Number(el.value);
      if (!Number.isInteger(v) || v < 0) { st.errs['p:' + id] = 'Escribe un número entero, de 0 en adelante'; paintBody(); return; }
      if (p && v === p.stock) return;
      saveProduct(id, { id, stock: v });
      return;
    }
    if (f === 'file') {
      dropFile();
      const file = el.files && el.files[0] ? el.files[0] : null;
      if (file) { st.file = file; try { st.fileUrl = URL.createObjectURL(file); } catch (_) { st.fileUrl = ''; } }
      const prev = q('[data-pn-prev]');
      if (prev && st.fileUrl) prev.innerHTML = '<img src="' + esc(st.fileUrl) + '" alt="">';
    }
  }
  function onInput(e) {
    const el = e.target;
    const f = el && el.getAttribute ? el.getAttribute('data-pn-f') : null;
    if (f === 'name') { st.draftName = el.value || ''; return; }
    if (st.view === 'ajustes' && f) {
      const p = q('[data-pn-preview]');
      if (p) p.textContent = previewText(readSettings());
      setMsg(true, '');
    }
  }
  function bind() {
    const r = root();
    if (!r || st.bound) return;
    st.bound = true;
    r.addEventListener('click', onClick);
    r.addEventListener('change', onChange);
    r.addEventListener('input', onInput);
  }

  function renderPines() {
    bind();
    paint();
    load();
    startTimer();
  }

  // El aviso de una reserva abre `/#/pines` (aux_pins_reserve). Con la app ya
  // abierta llega como hashchange; al arrancar lo resuelve core.js.
  function deepLink() {
    const h = String(location.hash || '');
    if (!/^#\/pines(\?|$)/.test(h)) return;
    if (!esJefe()) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* */ }
    st.view = 'reservas'; st.filter = 'reserved';
    if (typeof window.setTab === 'function') window.setTab('pines'); else renderPines();
  }
  window.addEventListener('hashchange', () => { try { deepLink(); } catch (_) { /* */ } });

  renderPines.badge = refreshBadge;
  window.renderPines = renderPines;
  window.stopPinesTimer = stopPinesTimer;
})();
