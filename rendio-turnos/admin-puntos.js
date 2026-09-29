// admin-puntos.js — P13b · Admin: Rendio Points (rediseño del auxiliar, 27-sep-2026).
//
// Pinta #puntos-ui dentro de <section data-panel="puntos"> (core.setTab →
// window.renderPuntos). Cuatro vistas:
//   · Canjes: lo que pidieron los tripulantes. El jefe lo CUMPLE (y lo aplica él
//     afuera: el colega en la ruta, el descuento en Cuentas de cobro, el
//     privado con la camioneta) o lo RECHAZA con motivo (la base devuelve los
//     puntos y el tripulante ve el motivo).
//   · Programa: el interruptor (nace APAGADO) y cuánto vale cada acción; la
//     meta anónima del conjunto con el texto que escribe el jefe.
//   · Vitrina: costo y disponibilidad de cada canje («Pronto» lo fija la base).
//   · Saldos: puntos de cada tripulante y ajuste manual con nota (la ve él).
//
// Todo pasa por window.ApiPuntos (P13a, 0091). Sin 0091 las lecturas devuelven
// null y la pantalla lo dice: nunca un saldo ni un canje inventado. Los puntos
// no son plata.
//
// Contrato: window.renderPuntos(). Además atiende el enlace del aviso de canje
// (`#/puntos`, lo manda aux_points_redeem) cuando la app ya está abierta.
(function () {
  'use strict';

  const TZ = 'America/Bogota';
  const VIEWS = [['canjes', 'Canjes'], ['programa', 'Programa'], ['vitrina', 'Vitrina'], ['saldos', 'Saldos']];
  const KIND_HINT = {
    guest_seat: 'Súmale el colega en su traslado compartido y márcalo cumplido.',
    direct_trip: 'El traslado Directo todavía no existe: recházalo con un motivo para devolverle los puntos.',
    billing_days: 'Aplícalo como descuento en su cuenta de cobro (Cuentas de cobro) y márcalo cumplido.',
    private_trip: 'Coordina el traslado privado con el tripulante y márcalo cumplido.',
  };

  const st = {
    view: 'canjes', filter: 'pending', bound: false, req: 0,
    settings: undefined, rewards: undefined, reds: undefined, balances: undefined, pending: null,
    errs: {}, busy: {}, rejecting: null, adjusting: null, q: '', msg: null,
  };

  const AP = () => window.ApiPuntos || null;
  const root = () => document.getElementById('puntos-ui');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const svg = (id, cls) => '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#' + id + '"/></svg>';
  const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmtN = (v) => n0(v).toLocaleString('es-CO');
  function fecha(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-CO', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return String(iso); }
  }
  function toastMsg(m) { if (typeof window.toast === 'function') window.toast(m); }
  function why(title, body) {
    // eslint-disable-next-line no-undef
    if (typeof rdWhy === 'function') { try { return rdWhy(title, body); } catch (_) { /* cae al marcado */ } }
    return '<details class="rd-why"><summary aria-expanded="false">' + esc(title) + svg('i-chev', 'details-chevron') + '</summary><div class="rd-why-body">' + body + '</div></details>';
  }
  const wrap = (fn) => (typeof fn === 'function' ? Promise.resolve().then(fn) : Promise.resolve(null));
  const errText = (e) => (e && e.message) || 'No se pudo completar';

  // ── Carga ──────────────────────────────────────────────────────────────────
  function load() {
    const P = AP();
    const req = ++st.req;
    if (!P) {
      st.settings = st.rewards = st.reds = st.balances = null; st.pending = null;
      paint(); return Promise.resolve();
    }
    st.errs = {};
    const one = (k, fn) => wrap(fn).then(v => ({ k, v }), e => ({ k, e }));
    return Promise.all([
      one('settings', () => P.adminSettings()),
      one('rewards', () => P.rewards()),
      one('reds', () => P.adminRedemptions(st.filter)),
      one('balances', () => P.adminBalances()),
      one('pending', () => P.adminPendingCount()),
    ]).then(res => {
      if (req !== st.req) return;
      res.forEach(({ k, v, e }) => {
        if (e) { st.errs[k] = errText(e); st[k] = null; } else st[k] = v == null ? null : v;
      });
      paint();
    });
  }
  function loadReds() {
    const P = AP();
    if (!P) return Promise.resolve();
    st.reds = undefined; paintBody();
    return Promise.all([
      wrap(() => P.adminRedemptions(st.filter)).then(v => { st.reds = v || null; delete st.errs.reds; }, e => { st.reds = null; st.errs.reds = errText(e); }),
      wrap(() => P.adminPendingCount()).then(v => { st.pending = v; }, () => { /* se queda el anterior */ }),
    ]).then(() => paint());
  }

  // ── Pintado ────────────────────────────────────────────────────────────────
  function isOn() { return !!(st.settings && st.settings.enabled === true); }
  function headHTML() {
    const cnt = st.pending == null ? '' : '<span class="sh-ct" id="pt-count">' + esc(st.pending) + '</span>';
    const state = st.settings === undefined ? ''
      : st.settings === null ? '<div class="pt-state none">' + svg('i-info') + '<span>No se pudo leer el programa' + (st.errs.settings ? ': ' + esc(st.errs.settings) : '. Puede faltar la migración 0091.') + '</span></div>'
        : '<div class="pt-state ' + (isOn() ? 'on' : 'off') + '">' + svg(isOn() ? 'i-check' : 'i-zzz') + '<span>'
          + (isOn() ? '<b>Encendido.</b> Los tripulantes ven Puntos e Invitar y ganan puntos.'
            : '<b>Apagado.</b> Los tripulantes no ven Puntos ni Invitar (en su Perfil dice «Pronto») y nadie gana puntos.')
          + '</span>' + (isOn() ? '' : '<button class="set-btn ghost sm" data-pt="view" data-v="programa">Encenderlo</button>') + '</div>';
    return '<div class="sh-phead"><div>'
      + '<h1>Rendio Points ' + cnt + '</h1>'
      + '<p>Puntos para los tripulantes: invitar colegas, avisar a tiempo que no viajan y calificar. <b>Los puntos no son plata</b>: no se retiran ni se transfieren.</p>'
      + why('¿Quién suma los puntos?', 'Los suma la <b>base de datos</b>, no el teléfono: cuando el colega invitado hace su primer viaje entregado, cuando alguien cancela con la hora de recogida ya publicada y la anticipación que pusiste, y cuando califica un viaje entregado. Un canje descuenta al pedirlo y queda pendiente hasta que lo cumples; si lo rechazas, los puntos vuelven.')
      + '</div><button class="set-btn ghost" data-pt="refresh">' + svg('i-refresh') + 'Refrescar</button></div>'
      + state
      + '<div class="pt-tabs" role="tablist">' + VIEWS.map(([k, l]) => '<button role="tab" data-pt="view" data-v="' + k + '"' + (st.view === k ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>' + esc(l)
        + (k === 'canjes' && st.pending ? ' <i>' + esc(st.pending) + '</i>' : '') + '</button>').join('') + '</div>';
  }
  function emptyHTML(title, sub, retry) {
    return '<div class="pt-empty"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '')
      + (retry ? '<button class="set-btn ghost" data-pt="' + retry + '">' + svg('i-refresh') + 'Reintentar</button>' : '') + '</div>';
  }
  const loadingHTML = () => '<div class="pt-empty"><span>Cargando…</span></div>';

  // Canjes
  function redCard(r) {
    const pend = r.status === 'pending';
    const tag = pend ? '<span class="pt-tag wait">Pendiente</span>'
      : r.status === 'fulfilled' ? '<span class="pt-tag ok">Cumplido</span>' : '<span class="pt-tag no">Rechazado</span>';
    const busy = st.busy['red:' + r.id];
    let acts = '';
    if (pend) {
      if (st.rejecting === r.id) {
        acts = '<div class="pt-rej"><label>Motivo del rechazo (el tripulante lo ve)<textarea data-pt-f="rej-note" maxlength="200" rows="2" placeholder="Ej.: ese día no hay cupo en la ruta"></textarea></label>'
          + '<div class="pt-acts"><button class="set-btn ghost" data-pt="rej-cancel">Volver</button>'
          + '<button class="set-btn danger" data-pt="rej-go" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-x') + (busy ? 'Rechazando…' : 'Rechazar y devolver ' + fmtN(r.cost) + ' pts') + '</button></div></div>';
      } else {
        acts = '<div class="pt-acts">'
          + (r.kind === 'billing_days' && typeof window.renderCobro === 'function' ? '<button class="set-btn ghost" data-pt="goto-cobro">' + svg('i-doc') + 'Ir a Cuentas de cobro</button>' : '')
          + '<button class="set-btn ghost" data-pt="rej-open" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-x') + 'Rechazar</button>'
          + '<button class="set-btn" data-pt="fulfill" data-id="' + esc(r.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-check') + (busy ? 'Guardando…' : 'Marcar cumplido') + '</button>'
          + '</div>';
      }
    }
    const err = st.errs['red:' + r.id] ? '<div class="pt-err">' + esc(st.errs['red:' + r.id]) + '</div>' : '';
    return '<div class="pt-card red ' + (pend ? 'wait' : r.status === 'fulfilled' ? 'ok' : 'no') + '">'
      + '<div class="pt-top"><div><b>' + esc(r.title || 'Canje') + '</b><span>' + esc(r.name || 'Tripulante') + (r.residence ? ' · ' + esc(r.residence) : '') + '</span></div>' + tag + '</div>'
      + '<div class="pt-meta">'
      + '<span><b>Costo</b>' + fmtN(r.cost) + ' pts</span>'
      + '<span><b>Pedido</b>' + esc(fecha(r.requestedAt)) + '</span>'
      + '<span><b>Saldo hoy</b>' + fmtN(r.balance) + ' pts</span>'
      + (r.decidedAt ? '<span><b>Decidido</b>' + esc(fecha(r.decidedAt)) + '</span>' : '')
      + '</div>'
      + (r.note ? '<p class="pt-note"><b>Nota del tripulante:</b> ' + esc(r.note) + '</p>' : '')
      + (r.decisionNote ? '<p class="pt-note"><b>Motivo:</b> ' + esc(r.decisionNote) + '</p>' : '')
      + (pend && KIND_HINT[r.kind] ? '<p class="pt-hint">' + svg('i-info') + esc(KIND_HINT[r.kind]) + '</p>' : '')
      + err + acts
      + '</div>';
  }
  function canjesHTML() {
    const filt = '<div class="pt-filter">'
      + [['pending', 'Pendientes'], ['all', 'Todos']].map(([k, l]) => '<button data-pt="filter" data-v="' + k + '"' + (st.filter === k ? ' class="on"' : '') + '>' + l + '</button>').join('')
      + '</div>';
    const r = st.reds;
    if (r === undefined) return filt + loadingHTML();
    if (r === null) return filt + emptyHTML('No se pudieron cargar los canjes', st.errs.reds || 'Puede faltar la migración 0091 o la sesión.', 'refresh');
    if (!r.length) return filt + emptyHTML(st.filter === 'pending' ? 'No hay canjes por cumplir' : 'Todavía no hay canjes', 'Cuando un tripulante canjee puntos, aparece aquí y te llega un aviso.');
    return filt + r.map(redCard).join('');
  }

  // Programa
  function field(key, label, val, o) {
    o = o || {};
    return '<label class="pt-field"><span>' + esc(label) + '</span>'
      + '<span class="pt-in"><input type="number" inputmode="numeric" data-pt-f="' + key + '" value="' + esc(val == null ? '' : val) + '"'
      + ' min="' + (o.min == null ? 0 : o.min) + '" max="' + (o.max || 5000) + '" step="1"' + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>'
      + '<em>' + esc(o.unit || 'pts') + '</em></span>'
      + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</label>';
  }
  function programaHTML() {
    const s = st.settings;
    if (s === undefined) return loadingHTML();
    if (s === null) return emptyHTML('No se pudo leer el programa', st.errs.settings || 'Puede faltar la migración 0091 o la sesión.', 'refresh');
    const m = st.msg && st.msg.k === 'settings' ? '<span class="pt-msg ' + (st.msg.ok ? 'ok' : 'bad') + '">' + esc(st.msg.t) + '</span>' : '';
    const busy = st.busy.settings;
    return '<div class="pt-card">'
      + '<label class="pt-switch"><input type="checkbox" data-pt-f="enabled"' + (s.enabled ? ' checked' : '') + '><i></i><span><b>Programa encendido</b>'
      + '<small>Apagado, los tripulantes no ven Puntos ni Invitar y nadie gana puntos. Encenderlo no reparte puntos por lo que ya pasó.</small></span></label>'
      + '</div>'
      + '<div class="pt-card"><h3>Cuánto vale cada acción</h3><div class="pt-grid">'
      + field('invite', 'Invitar a un colega', s.invite, { hint: 'Cuando el colega que usó su código hace su primer viaje entregado.' })
      + field('neighbor', 'Si el colega vive en su mismo conjunto', s.neighbor, { hint: 'Reemplaza al de arriba cuando son vecinos.' })
      + field('cancel', 'Avisar a tiempo que no viaja', s.cancel, { hint: 'Solo si ya tenía hora de recogida publicada.' })
      + field('cancelLeadHours', 'Anticipación para «a tiempo»', s.cancelLeadHours, { unit: 'h', min: 1, max: 48 })
      + field('rate', 'Calificar su viaje', s.rate, { hint: 'Una vez por viaje entregado.' })
      + '</div></div>'
      + '<div class="pt-card"><h3>Meta del conjunto <em>opcional</em></h3>'
      + '<p class="pt-hint">' + svg('i-info') + 'Cada tripulante ve cuántos de su conjunto usan Rendio frente a esta meta, sin nombres. Escribe algo que puedas cumplir: nada de prometer un carro fijo si no está confirmado.</p>'
      + '<div class="pt-grid">'
      + field('goalTarget', 'Meta', s.goalTarget, { unit: 'tripulantes', min: 1, max: 500, placeholder: 'Sin meta' })
      + '<label class="pt-field wide"><span>Texto que ven (hasta 160)</span><input type="text" maxlength="160" data-pt-f="goalText" value="' + esc(s.goalText || '') + '" placeholder="Ej.: Entre más vecinos, mejor armamos la ruta de tu conjunto"></label>'
      + '</div></div>'
      + '<div class="pt-save"><button class="set-btn" data-pt="save-settings"' + (busy ? ' disabled' : '') + '>' + svg('i-save') + (busy ? 'Guardando…' : 'Guardar') + '</button>' + m + '</div>';
  }

  // Vitrina
  function vitrinaHTML() {
    const r = st.rewards;
    if (r === undefined) return loadingHTML();
    if (r === null) return emptyHTML('No se pudo cargar la vitrina', st.errs.rewards || 'Puede faltar la migración 0091 o la sesión.', 'refresh');
    if (!r.length) return emptyHTML('La vitrina está vacía', '');
    return '<p class="pt-lead">Lo que un tripulante puede pedir con sus puntos. El nombre y «Pronto» los fija la base; tú cambias el costo y si está disponible.</p>'
      + r.map(x => {
        const busy = st.busy['rw:' + x.id];
        const m = st.msg && st.msg.k === 'rw:' + x.id ? '<span class="pt-msg ' + (st.msg.ok ? 'ok' : 'bad') + '">' + esc(st.msg.t) + '</span>' : '';
        return '<div class="pt-card rw" data-rw="' + esc(x.id) + '">'
          + '<div class="pt-top"><div><b>' + esc(x.title) + '</b><span>' + esc(x.description || '') + '</span></div>'
          + (x.soon ? '<span class="pt-tag soon">Pronto</span>' : x.enabled ? '<span class="pt-tag ok">Disponible</span>' : '<span class="pt-tag no">Oculto</span>') + '</div>'
          + '<div class="pt-rw-row">'
          + '<label class="pt-field sm"><span>Costo</span><span class="pt-in"><input type="number" inputmode="numeric" min="1" max="100000" step="1" data-pt-f="cost" value="' + esc(x.cost) + '"><em>pts</em></span></label>'
          + '<label class="pt-check"><input type="checkbox" data-pt-f="rw-enabled"' + (x.enabled ? ' checked' : '') + '><span>Se ve en la vitrina</span></label>'
          + '<button class="set-btn ghost" data-pt="save-reward" data-id="' + esc(x.id) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-save') + (busy ? 'Guardando…' : 'Guardar') + '</button>' + m
          + '</div>'
          + (x.soon ? '<p class="pt-hint">' + svg('i-info') + 'Sale como «Pronto»: nadie lo puede canjear todavía.</p>' : '')
          + (x.kind === 'billing_days' ? '<p class="pt-hint">' + svg('i-info') + 'Al cumplirlo, aplícalo como descuento en Cuentas de cobro.</p>' : '')
          + '</div>';
      }).join('');
  }

  // Saldos
  function saldosHTML() {
    const b = st.balances;
    if (b === undefined) return loadingHTML();
    if (b === null) return emptyHTML('No se pudieron cargar los saldos', st.errs.balances || 'Puede faltar la migración 0091 o la sesión.', 'refresh');
    if (!b.length) return emptyHTML('Todavía no hay tripulantes', '');
    const q = st.q.trim().toLowerCase();
    const list = q ? b.filter(x => (x.name + ' ' + (x.residence || '') + ' ' + (x.code || '')).toLowerCase().includes(q)) : b;
    const rows = list.map(x => {
      const adj = st.adjusting === x.auxId;
      const busy = st.busy['adj:' + x.auxId];
      const err = st.errs['adj:' + x.auxId] ? '<div class="pt-err">' + esc(st.errs['adj:' + x.auxId]) + '</div>' : '';
      return '<div class="pt-bal' + (adj ? ' open' : '') + '">'
        + '<div class="pt-bal-who"><b>' + esc(x.name || 'Tripulante') + '</b><span>' + esc(x.residence || 'Sin conjunto') + (x.code ? ' · código ' + esc(x.code) : '') + '</span></div>'
        + '<div class="pt-bal-n"><b>' + fmtN(x.balance) + '</b><span>pts</span></div>'
        + '<div class="pt-bal-m"><span>Ganados <b>' + fmtN(x.earned) + '</b></span><span>Invitó <b>' + fmtN(x.invitedDone) + ' de ' + fmtN(x.invited) + '</b></span><span>Canjes pendientes <b>' + fmtN(x.pending) + '</b></span></div>'
        + (adj
          ? '<div class="pt-adj"><label class="pt-field sm"><span>Puntos (+ o −)</span><span class="pt-in"><input type="number" inputmode="numeric" step="1" min="-5000" max="5000" data-pt-f="adj-pts" placeholder="Ej.: 20 o -20"><em>pts</em></span></label>'
            + '<label class="pt-field wide"><span>Por qué (el tripulante lo ve en sus movimientos)</span><input type="text" maxlength="200" data-pt-f="adj-note" placeholder="Ej.: Te faltó sumar la calificación del 12-oct"></label>'
            + err + '<div class="pt-acts"><button class="set-btn ghost" data-pt="adj-cancel">Volver</button><button class="set-btn" data-pt="adj-go" data-id="' + esc(x.auxId) + '"' + (busy ? ' disabled' : '') + '>' + svg('i-check') + (busy ? 'Guardando…' : 'Ajustar') + '</button></div></div>'
          : '<button class="set-btn ghost sm" data-pt="adj-open" data-id="' + esc(x.auxId) + '">' + svg('i-sliders') + 'Ajustar</button>')
        + '</div>';
    }).join('');
    return '<div class="pt-search">' + svg('i-search') + '<input type="search" data-pt-f="q" placeholder="Buscar por nombre, conjunto o código" value="' + esc(st.q) + '"></div>'
      + (list.length ? '<div class="pt-bals">' + rows + '</div>' : emptyHTML('Nadie coincide con la búsqueda', ''));
  }

  function bodyHTML() {
    if (!AP()) return emptyHTML('Rendio Points no está cargado', 'Falta api-puntos.js en esta versión de la app.');
    if (st.view === 'programa') return programaHTML();
    if (st.view === 'vitrina') return vitrinaHTML();
    if (st.view === 'saldos') return saldosHTML();
    return canjesHTML();
  }
  function paint() {
    const r = root(); if (!r) return;
    const focus = document.activeElement && r.contains(document.activeElement) ? document.activeElement.getAttribute('data-pt-f') : null;
    r.innerHTML = '<div class="pt-wrap">' + headHTML() + '<div id="pt-body">' + bodyHTML() + '</div></div>';
    if (focus === 'q') { const i = r.querySelector('[data-pt-f="q"]'); if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) { /* */ } } }
  }
  function paintBody() {
    const b = document.getElementById('pt-body');
    if (!b) { paint(); return; }
    b.innerHTML = bodyHTML();
  }

  // ── Acciones ───────────────────────────────────────────────────────────────
  const val = (sel) => { const r = root(); const el = r && r.querySelector(sel); return el ? el.value : ''; };
  async function saveSettings() {
    const P = AP(); const r = root(); if (!P || !r || st.busy.settings) return;
    const get = (k) => { const el = r.querySelector('[data-pt-f="' + k + '"]'); return el ? el.value.trim() : ''; };
    const intOf = (k) => { const v = get(k); return v === '' ? NaN : Number(v); };
    const patch = {
      enabled: !!(r.querySelector('[data-pt-f="enabled"]') || {}).checked,
      invite: intOf('invite'), neighbor: intOf('neighbor'), cancel: intOf('cancel'),
      cancelLeadHours: intOf('cancelLeadHours'), rate: intOf('rate'),
      goalTarget: get('goalTarget') === '' ? null : Number(get('goalTarget')),
      goalText: get('goalText'),
    };
    if (patch.goalTarget != null && !patch.goalText) { st.msg = { k: 'settings', ok: false, t: 'Escribe el texto de la meta o deja la meta vacía' }; paintBody(); return; }
    st.busy.settings = true; st.msg = null; paintBody();
    try {
      st.settings = await P.adminSaveSettings(patch);
      st.msg = { k: 'settings', ok: true, t: 'Guardado' };
      toastMsg(patch.enabled ? 'Rendio Points guardado · encendido' : 'Rendio Points guardado · apagado');
    } catch (e) { st.msg = { k: 'settings', ok: false, t: errText(e) }; }
    st.busy.settings = false;
    paint();
  }
  async function saveReward(id) {
    const P = AP(); const r = root(); if (!P || !r || st.busy['rw:' + id]) return;
    const card = r.querySelector('.pt-card.rw[data-rw="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!card) return;
    const cost = Number((card.querySelector('[data-pt-f="cost"]') || {}).value);
    const enabled = !!(card.querySelector('[data-pt-f="rw-enabled"]') || {}).checked;
    st.busy['rw:' + id] = true; st.msg = null; paintBody();
    try {
      const row = await P.adminSaveReward(id, { cost, enabled });
      if (row && Array.isArray(st.rewards)) {
        st.rewards = st.rewards.map(x => (x.id === id ? Object.assign({}, x, { cost: Number(row.cost), enabled: row.enabled === true }) : x));
      }
      st.msg = { k: 'rw:' + id, ok: true, t: 'Guardado' };
    } catch (e) { st.msg = { k: 'rw:' + id, ok: false, t: errText(e) }; }
    st.busy['rw:' + id] = false;
    paintBody();
  }
  async function decide(id, action, note) {
    const P = AP(); if (!P || st.busy['red:' + id]) return;
    st.busy['red:' + id] = true; delete st.errs['red:' + id]; paintBody();
    try {
      await P.adminDecide(id, action, note || null);
      st.rejecting = null;
      toastMsg(action === 'fulfill' ? 'Canje cumplido' : 'Canje rechazado · puntos devueltos');
      st.busy['red:' + id] = false;
      await loadReds();
      const P2 = AP();
      wrap(() => P2.adminBalances()).then(v => { st.balances = v || null; }, () => { /* */ });
      return;
    } catch (e) { st.errs['red:' + id] = errText(e); }
    st.busy['red:' + id] = false;
    paintBody();
  }
  async function adjust(auxId) {
    const P = AP(); if (!P || st.busy['adj:' + auxId]) return;
    const pts = Number(val('[data-pt-f="adj-pts"]'));
    const note = val('[data-pt-f="adj-note"]').trim();
    if (!Number.isInteger(pts) || pts === 0) { st.errs['adj:' + auxId] = 'Escribe un número de puntos distinto de 0'; paintBody(); return; }
    if (!note) { st.errs['adj:' + auxId] = 'Escribe por qué ajustas: el tripulante lo ve'; paintBody(); return; }
    st.busy['adj:' + auxId] = true; delete st.errs['adj:' + auxId]; paintBody();
    try {
      const r = await P.adminAdjust(auxId, pts, note);
      if (Array.isArray(st.balances)) st.balances = st.balances.map(x => (x.auxId === auxId ? Object.assign({}, x, { balance: n0(r && r.balance) }) : x));
      st.adjusting = null;
      toastMsg('Saldo ajustado');
    } catch (e) { st.errs['adj:' + auxId] = errText(e); }
    st.busy['adj:' + auxId] = false;
    paintBody();
  }

  function onClick(e) {
    const el = e.target.closest && e.target.closest('[data-pt]');
    if (!el || !root() || !root().contains(el) || el.disabled) return;
    const a = el.getAttribute('data-pt');
    const id = el.getAttribute('data-id');
    if (a === 'refresh') { st.msg = null; load(); paint(); return; }
    if (a === 'view') { const v = el.getAttribute('data-v'); if (VIEWS.some(x => x[0] === v)) { st.view = v; st.msg = null; paint(); } return; }
    if (a === 'filter') { const v = el.getAttribute('data-v'); if (v && v !== st.filter) { st.filter = v; loadReds(); } return; }
    if (a === 'fulfill') { decide(id, 'fulfill'); return; }
    if (a === 'rej-open') { st.rejecting = id; paintBody(); const t = root().querySelector('[data-pt-f="rej-note"]'); if (t) t.focus(); return; }
    if (a === 'rej-cancel') { st.rejecting = null; paintBody(); return; }
    if (a === 'rej-go') {
      const note = val('[data-pt-f="rej-note"]').trim();
      if (!note) { st.errs['red:' + id] = 'Escribe el motivo: el tripulante lo ve'; paintBody(); return; }
      decide(id, 'reject', note); return;
    }
    if (a === 'goto-cobro') { if (typeof window.setTab === 'function') window.setTab('cobro'); return; }
    if (a === 'save-settings') { saveSettings(); return; }
    if (a === 'save-reward') { saveReward(id); return; }
    if (a === 'adj-open') { st.adjusting = id; delete st.errs['adj:' + id]; paintBody(); const t = root().querySelector('[data-pt-f="adj-pts"]'); if (t) t.focus(); return; }
    if (a === 'adj-cancel') { st.adjusting = null; paintBody(); return; }
    if (a === 'adj-go') { adjust(id); }
  }
  function onInput(e) {
    const el = e.target;
    if (!el || el.getAttribute('data-pt-f') !== 'q') return;
    st.q = el.value || '';
    paintBody();
    const i = root() && root().querySelector('[data-pt-f="q"]');
    if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) { /* */ } }
  }
  function bind() {
    const r = root();
    if (!r || st.bound) return;
    st.bound = true;
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
  }

  function renderPuntos() {
    bind();
    paint();
    load();
  }

  // El aviso de canje abre `/#/puntos` (aux_points_redeem). Con la app ya
  // abierta llega como hashchange; al arrancar lo resuelve core.js (si no lo
  // conoce, el jefe entra por la consola).
  function deepLink() {
    const h = String(location.hash || '');
    if (!/^#\/puntos(\?|$)/.test(h)) return;
    // eslint-disable-next-line no-undef
    const g = typeof state !== 'undefined' ? state : null;
    if (!g || !g.profile || g.profile.role !== 'admin') return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* */ }
    st.view = 'canjes'; st.filter = 'pending';
    if (typeof window.setTab === 'function') window.setTab('puntos'); else renderPuntos();
  }
  window.addEventListener('hashchange', () => { try { deepLink(); } catch (_) { /* */ } });

  window.renderPuntos = renderPuntos;
})();
