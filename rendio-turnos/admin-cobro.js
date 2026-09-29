// admin-cobro.js — Admin › Rutas › Equipo › Cuentas de cobro (Facturario, 0090).
// Rediseño del auxiliar (27-sep-2026), paquete P12b. Habla con la base por
// window.ApiCobro (api-cobro.js, P12a).
//
// QUÉ ES. La mensualidad de cada tripulante, del lado del jefe (AJUSTES §5):
//   · la lista de tripulantes de la organización con el estado de su cuenta de
//     cobro (por revisar, pausado, en mora, pendiente, al día, sin cuenta);
//   · los comprobantes por revisar, con la imagen (enlace firmado del bucket
//     PRIVADO payment-proofs), para aprobar o rechazar con un motivo de la lista
//     fija (CB_REASONS);
//   · editar la cuenta de un tripulante (monto, día de corte, plazos que pisan los
//     de la organización, monto desde el próximo mes, activa), abrir su cuenta de
//     cobro, corregirla o descontarle (el canje de Puntos pasa por aquí) y
//     «marcar pagado» (efectivo, transferencia que llegó sin comprobante…);
//   · los métodos de pago que ve el tripulante (banco, tipo, número, titular, NIT,
//     Nequi) y los valores por defecto de la organización.
//
// Las reglas (corte → aviso → vence → vencido → último día → pausa) viven en la
// base y las corre un reloj diario a las 7:00 a. m. Si ese reloj nunca corrió,
// la pantalla lo DICE (no es lo mismo que «todo al día»).
//
// Nada inventado: sin monto cargado la cuenta dice que falta; sin métodos, que el
// tripulante no ve a dónde pagar.
//
// Contrato con core.js: window.renderCobro() al entrar a la pestaña y
// window.stopCobroTimer() al salir (core.setTab los llama con typeof). La entrada
// «Cuentas de cobro» de la consola aparece sola cuando renderCobro existe.
//
// Enlace profundo #/cobro?aux=<auxiliar_profile_id> (la URL de las push del jefe,
// 0090): core.applyDeepLink no lo conoce, así que este módulo lo resuelve (en
// hashchange y, en frío, cuando core termina de entrar), igual que Coordinación.
(function () {
  'use strict';

  const CB_POLL_MS = 30000;   // comprobantes nuevos mientras la pestaña está abierta

  const cb = {
    list: undefined,          // undefined = nunca cargó · null = falló · []
    proofs: undefined,
    settings: undefined,
    methods: undefined,
    lastRun: undefined,       // undefined = no se sabe · null = nunca corrió
    loading: false,
    filter: 'todos',
    q: '',
    open: null,               // auxiliarProfileId con el editor abierto
    mode: null,               // 'edit' | 'paid' | 'adjust' | 'hist'
    form: {},                 // valores del formulario abierto
    detail: {},               // auxId → admin_billing_detail
    rejecting: null,          // proofId con los motivos abiertos
    reason: null,
    panel: null,              // 'methods' | 'settings' | null
    mform: null,              // método en edición (nuevo: {})
    sform: null,              // valores por defecto en edición
    urls: {},                 // proofId → {url} | {err:true}
    busy: null,
    poll: null,
    bound: false,
    pendingAux: null,
    sig: '',
  };

  // ── utilidades ───────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const say = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const api = () => (window.ApiCobro && typeof window.ApiCobro === 'object') ? window.ApiCobro : null;
  const root = () => document.getElementById('cobro-ui');
  const isObj = (v) => !!v && typeof v === 'object' && typeof v.then !== 'function' && !Array.isArray(v);
  const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
  const digits = (v) => { const s = String(v == null ? '' : v).replace(/[^\d]/g, ''); return s ? Number(s) : null; };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  // Formato del facturario (cobro-engine: cbMoney / cbFmt), propio para no
  // depender de que ApiCobro esté cargado.
  const MC = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const parts = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null; };
  const money = (n) => (n == null || !isFinite(n) ? '—' : '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
  const fmtDay = (iso) => { const p = parts(iso); return p ? p.d + ' de ' + MC[p.mo - 1] : '—'; };
  const monthLabel = (iso) => { const p = parts(iso); if (!p) return ''; const s = MES[p.mo - 1]; return s.charAt(0).toUpperCase() + s.slice(1) + ' ' + p.y; };
  const pl = (n, s, p) => n + ' ' + (n === 1 ? s : p);
  const icon = (id) => '<svg class="icon"><use href="#' + id + '"/></svg>';
  const REASONS = () => {
    const a = api();
    return a && Array.isArray(a.REASONS) && a.REASONS.length ? a.REASONS.slice()
      : ['No se lee el comprobante', 'El monto no coincide', 'No es a la cuenta de Rendio', 'La fecha es anterior al cobro'];
  };

  // Estado de una fila (la precedencia de la base: por revisar primero).
  const TONES = {
    review: ['Por revisar', 'info'], bloqueado: ['Pausado', 'block'], vencido: ['En mora', 'error'],
    venceHoy: ['Vence hoy', 'warn'], porVencer: ['Por vencer', 'warn'], pendiente: ['Pendiente', 'neutral'],
    pagado: ['Al día', 'ok'], rejected: ['Rechazado', 'error'], sinCuenta: ['Sin cuenta', 'muted'],
    sinCorte: ['Sin cuenta de cobro abierta', 'muted'], inactiva: ['Cuenta apagada', 'muted'],
  };
  function stateOf(r) {
    const acc = isObj(r.account) ? r.account : null;
    const cur = isObj(r.current) ? r.current : null;
    if (!acc) return 'sinCuenta';
    if (acc.active === false) return 'inactiva';
    if (r.proofInReview || (cur && cur.comp === 'review')) return 'review';
    if (!cur) return 'sinCorte';
    if (cur.blocked) return 'bloqueado';
    if (cur.comp === 'rejected' && !cur.paid) return 'rejected';
    return cur.base || 'pendiente';
  }
  const FILTERS = [
    ['todos', 'Todos', () => true],
    ['revisar', 'Por revisar', (s) => s === 'review'],
    ['pausados', 'Pausados', (s, r) => s === 'bloqueado' || !!(r.account && r.account.paused)],
    ['mora', 'En mora', (s) => s === 'vencido' || s === 'rejected'],
    ['pendientes', 'Pendientes', (s) => s === 'pendiente' || s === 'porVencer' || s === 'venceHoy'],
    ['aldia', 'Al día', (s) => s === 'pagado'],
    ['sincuenta', 'Sin cuenta', (s) => s === 'sinCuenta' || s === 'sinCorte' || s === 'inactiva'],
  ];

  // ── datos ────────────────────────────────────────────────────────────────
  async function tryCall(fn) { try { return { v: await fn() }; } catch (e) { return { e }; } }
  async function loadAll(quiet) {
    const a = api();
    if (!a) { cb.list = null; cb.proofs = null; paint(); return; }
    if (cb.loading) return;
    cb.loading = true;
    if (!quiet) paint();
    const [l, p, r] = await Promise.all([tryCall(() => a.adminList()), tryCall(() => a.adminProofs('review')), tryCall(() => a.adminLastRun())]);
    cb.loading = false;
    if (l.e) { if (!quiet || cb.list === undefined) cb.list = null; }
    else cb.list = Array.isArray(l.v) ? l.v.filter(isObj) : [];
    if (p.e) { if (!quiet || cb.proofs === undefined) cb.proofs = null; }
    else cb.proofs = Array.isArray(p.v) ? p.v.filter(isObj) : [];
    cb.lastRun = r.e ? undefined : (isObj(r.v) ? r.v : null);
    if (cb.pendingAux) focusAux(cb.pendingAux);
    const sig = JSON.stringify([cb.list, cb.proofs, cb.lastRun]);
    if (quiet && sig === cb.sig) return;
    cb.sig = sig;
    // Mientras escribe en un formulario, el sondeo no le borra lo que lleva.
    if (quiet && (cb.open || cb.panel || cb.rejecting || typing())) return;
    paint();
    loadUrls();
  }
  async function loadPanel() {
    const a = api(); if (!a) return;
    if (cb.panel === 'methods') {
      const r = await tryCall(() => a.adminMethods());
      cb.methods = r.e ? null : (Array.isArray(r.v) ? r.v.filter(isObj) : []);
    } else if (cb.panel === 'settings') {
      const r = await tryCall(() => a.adminSettings());
      cb.settings = r.e ? null : (isObj(r.v) ? r.v : null);
      if (isObj(cb.settings) && !cb.sform) cb.sform = settingsForm(cb.settings);
    }
    paint();
  }
  // Enlaces firmados de los comprobantes por revisar (10 min).
  function loadUrls() {
    const a = api(); if (!a || typeof a.proofUrl !== 'function' || !Array.isArray(cb.proofs)) return;
    cb.proofs.forEach(p => {
      if (!p.id || !p.path || cb.urls[p.id]) return;
      cb.urls[p.id] = { loading: true };
      Promise.resolve().then(() => a.proofUrl(p.path, 600)).then(u => {
        cb.urls[p.id] = u ? { url: u } : { err: true };
      }).catch(() => { cb.urls[p.id] = { err: true }; }).then(() => paintProofImg(p.id));
    });
  }
  function typing() {
    const el = document.activeElement;
    const r = root();
    return !!(el && r && r.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  // ── pintura ──────────────────────────────────────────────────────────────
  function rowsFiltered() {
    const f = FILTERS.find(x => x[0] === cb.filter) || FILTERS[0];
    const q = norm(cb.q).trim();
    return (cb.list || []).filter(r => f[2](stateOf(r), r)).filter(r => {
      if (!q) return true;
      const acc = r.account || {};
      return norm([r.name, r.email, r.phone, acc.reference].join(' ')).includes(q);
    });
  }
  function tag(state) {
    const t = TONES[state] || TONES.pendiente;
    return '<span class="cb-tag t-' + t[1] + '">' + esc(t[0]) + '</span>';
  }
  function clockHTML() {
    if (cb.lastRun === undefined) return '';
    if (cb.lastRun === null) {
      return '<div class="cb-note warn">' + icon('i-warn') + '<div><b>El reloj diario todavía no ha corrido.</b>'
        + '<span>Los estados se calculan al abrir esta pantalla, pero mientras el reloj no corra no se abren las cuentas de cobro del mes, no salen los avisos y nadie se pausa solo.</span></div></div>';
    }
    const d = String(cb.lastRun.runOn || '');
    const atras = parts(d) && parts(hoyISO()) ? Math.round((Date.parse(hoyISO()) - Date.parse(d)) / 86400e3) : 0;
    if (atras > 1) {
      return '<div class="cb-note warn">' + icon('i-warn') + '<div><b>El reloj diario no corre desde el ' + esc(fmtDay(d)) + '.</b>'
        + '<span>Sin él no se abren las cuentas del mes, no salen los avisos ni las pausas automáticas.</span></div></div>';
    }
    return '<div class="cb-clock">' + icon('i-clock') + 'Reloj diario: corrió el ' + esc(fmtDay(d))
      + ' · ' + esc(pl(num(cb.lastRun.opened) || 0, 'cuenta abierta', 'cuentas abiertas')) + ', ' + esc(pl(num(cb.lastRun.alerts) || 0, 'aviso', 'avisos'))
      + ', ' + esc(pl(num(cb.lastRun.paused) || 0, 'pausa', 'pausas')) + '</div>';
  }

  function proofsHTML() {
    if (cb.proofs === undefined) return '';
    if (cb.proofs === null) return '<div class="cb-sec"><h2>Comprobantes por revisar</h2><div class="cb-empty"><b>No pudimos cargar los comprobantes.</b><button class="set-btn ghost" data-cb="reload">Reintentar</button></div></div>';
    if (!cb.proofs.length) return '<div class="cb-sec"><h2>Comprobantes por revisar</h2><div class="cb-empty sm"><b>Nada por revisar.</b></div></div>';
    return '<div class="cb-sec"><h2>Comprobantes por revisar <span class="sh-ct">' + cb.proofs.length + '</span></h2><div class="cb-proofs">'
      + cb.proofs.map(proofHTML).join('') + '</div></div>';
  }
  function proofImg(p) {
    const u = cb.urls[p.id];
    const pdf = /pdf/i.test(String(p.contentType || '')) || /\.pdf$/i.test(String(p.path || ''));
    if (!u || u.loading) return '<div class="cb-proof-img">Cargando el archivo…</div>';
    if (u.err) return '<div class="cb-proof-img">No se pudo abrir el archivo.</div>';
    if (pdf) return '<div class="cb-proof-img"><a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + icon('i-doc') + 'Abrir el PDF</a></div>';
    return '<div class="cb-proof-img"><a href="' + esc(u.url) + '" target="_blank" rel="noopener"><img src="' + esc(u.url) + '" alt="Comprobante de ' + esc(p.name || '') + '"></a></div>';
  }
  function proofHTML(p) {
    const st = isObj(p.statement) ? p.statement : {};
    const due = num(st.amountDueCOP);
    const decl = num(p.declaredAmountCOP);
    const differs = decl != null && due != null && decl !== due;
    const rej = cb.rejecting === p.id;
    return '<div class="cb-proof" data-proof="' + esc(p.id) + '">'
      + proofImg(p)
      + '<div class="cb-proof-b">'
      + '<div class="cb-proof-h"><b>' + esc(p.name || 'Tripulante') + '</b><span>' + esc([p.reference, monthLabel(st.periodStart)].filter(Boolean).join(' · ')) + '</span></div>'
      + '<div class="cb-kvs">'
      + '<div><span>Cuenta del mes</span><b>' + esc(money(due)) + '</b></div>'
      + '<div><span>Dice que pagó</span><b class="' + (differs ? 'bad' : '') + '">' + esc(decl != null ? money(decl) : '—') + '</b></div>'
      + '<div><span>Pagó por</span><b>' + esc(p.viaLabel || '—') + '</b></div>'
      + '<div><span>Lo envió</span><b>' + esc(fmtDay(p.submittedOn || String(p.submittedAt || '').slice(0, 10))) + '</b></div>'
      + '<div><span>Vence</span><b>' + esc(fmtDay(st.dueDate)) + '</b></div>'
      + '</div>'
      + (st.blocked ? '<div class="cb-mini warn">Tiene las reservas pausadas: al aprobar se reactivan.</div>' : '')
      + (rej
        ? '<div class="cb-reasons"><b>¿Por qué lo rechazas?</b>' + REASONS().map(r => '<label><input type="radio" name="cb-reason" value="' + esc(r) + '"' + (cb.reason === r ? ' checked' : '') + ' data-cbr> ' + esc(r) + '</label>').join('')
          + '<div class="cb-acts"><button class="set-btn danger" data-cb="reject-go" data-id="' + esc(p.id) + '"' + (!cb.reason || cb.busy ? ' disabled' : '') + '>Rechazar</button>'
          + '<button class="set-btn ghost" data-cb="reject-cancel">Cancelar</button></div>'
          + '<span class="cb-mini">La fecha límite no cambia. El tripulante recibe el motivo y puede subir otro.</span></div>'
        : '<div class="cb-acts"><button class="set-btn" data-cb="approve" data-id="' + esc(p.id) + '"' + (cb.busy ? ' disabled' : '') + '>' + icon('i-check') + 'Aprobar</button>'
          + '<button class="set-btn ghost" data-cb="reject" data-id="' + esc(p.id) + '"' + (cb.busy ? ' disabled' : '') + '>Rechazar</button></div>')
      + '</div></div>';
  }
  function paintProofImg(id) {
    const r = root(); if (!r) return;
    const el = r.querySelector('.cb-proof[data-proof="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .cb-proof-img');
    const p = (cb.proofs || []).find(x => x.id === id);
    if (el && p) el.outerHTML = proofImg(p);
  }

  function rowHTML(r) {
    const st = stateOf(r);
    const acc = isObj(r.account) ? r.account : null;
    const cur = isObj(r.current) ? r.current : null;
    const open = cb.open === r.auxiliarProfileId;
    const amount = cur ? num(cur.amountDueCOP) : acc ? num(acc.effectiveAmountCOP) : null;
    let when = '';
    if (!acc) when = 'Sin mensualidad';
    else if (acc.effectiveAmountCOP == null) when = 'Falta el monto';
    else if (!cur) when = acc.nextCut ? 'Primer corte el ' + fmtDay(acc.nextCut) : 'Sin cuenta de cobro abierta';
    else if (cur.paid) when = 'Pagó el ' + fmtDay(cur.paidOn);
    else if (cur.blocked) when = 'Pausado desde el ' + fmtDay(cur.blockedOn || cur.blockDate);
    else when = 'Vence el ' + fmtDay(cur.dueDate);
    const acts = [];
    acts.push('<button class="set-btn ghost" data-cb="mode" data-m="edit" data-aux="' + esc(r.auxiliarProfileId) + '">' + (acc ? 'Editar cuenta' : 'Crear cuenta') + '</button>');
    if (cur && !cur.paid) {
      acts.push('<button class="set-btn ghost" data-cb="mode" data-m="paid" data-aux="' + esc(r.auxiliarProfileId) + '">Marcar pagado</button>');
      acts.push('<button class="set-btn ghost" data-cb="mode" data-m="adjust" data-aux="' + esc(r.auxiliarProfileId) + '">Ajustar</button>');
    }
    if (acc && acc.active !== false && !cur && acc.effectiveAmountCOP != null) acts.push('<button class="set-btn ghost" data-cb="open-st" data-aux="' + esc(r.auxiliarProfileId) + '"' + (cb.busy ? ' disabled' : '') + '>Abrir cuenta de cobro</button>');
    if (acc) acts.push('<button class="set-btn ghost" data-cb="mode" data-m="hist" data-aux="' + esc(r.auxiliarProfileId) + '">Historial</button>');
    return '<div class="cb-row' + (open ? ' open' : '') + '" data-aux="' + esc(r.auxiliarProfileId) + '">'
      + '<div class="cb-main">'
      + '<div class="cb-who"><b>' + esc(r.name || 'Sin nombre') + (r.isActive === false ? ' <span class="cb-tag t-muted">Suspendida</span>' : '') + '</b>'
      + '<span>' + esc([acc && acc.reference, r.phone || r.email].filter(Boolean).join(' · ')) + '</span></div>'
      + '<div class="cb-st">' + tag(st) + (acc && acc.paused && st !== 'bloqueado' ? ' <span class="cb-tag t-block">Reservas pausadas</span>' : '') + '</div>'
      + '<div class="cb-amt"><b>' + esc(amount != null ? money(amount) : '—') + '</b><span>' + esc(when) + '</span></div>'
      + '<div class="cb-rowacts">' + acts.join('') + '</div>'
      + '</div>'
      + (open ? editorHTML(r) : '')
      + '</div>';
  }

  // ── editores de una fila ─────────────────────────────────────────────────
  const field = (label, key, o) => {
    o = o || {};
    const v = cb.form[key];
    return '<label class="cb-f' + (o.wide ? ' wide' : '') + '"><span>' + esc(label) + '</span>'
      + '<input class="set-input" data-cbf="' + esc(key) + '" type="' + (o.type || 'text') + '"' + (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '')
      + (o.max ? ' max="' + esc(o.max) + '"' : '') + ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(o.ph || '') + '" autocomplete="off">'
      + (o.hint ? '<em>' + esc(o.hint) + '</em>' : '') + '</label>';
  };
  function editorHTML(r) {
    const acc = isObj(r.account) ? r.account : null;
    const cur = isObj(r.current) ? r.current : null;
    const busy = cb.busy === r.auxiliarProfileId;
    const foot = (label, act, extra) => '<div class="cb-ed-foot">' + (extra || '')
      + '<button class="set-btn ghost" data-cb="close">Cancelar</button>'
      + '<button class="set-btn" data-cb="' + act + '" data-aux="' + esc(r.auxiliarProfileId) + '"' + (busy ? ' disabled' : '') + '>' + esc(label) + '</button></div>';
    if (cb.mode === 'edit') {
      const def = isObj(cb.settings) ? cb.settings : null;
      // El valor de la organización: el de sus ajustes si ya se leyeron; si no, el
      // «efectivo» de la cuenta cuando ella no tiene uno propio (ahí es el de la org).
      const ph = (k, fb) => {
        const own = k.charAt(0).toLowerCase() + k.slice(1);
        if (def && def[own] != null) return 'De la organización: ' + def[own];
        if (acc && acc[own] == null && acc['effective' + k] != null) return 'De la organización: ' + acc['effective' + k];
        return fb;
      };
      return '<div class="cb-ed">'
        + '<p class="cb-ed-t">' + (acc ? 'Cuenta ' + esc(acc.reference || '') : 'Crear la cuenta de cobro de ' + esc(r.name || 'este tripulante')) + '</p>'
        + '<div class="cb-grid">'
        + field('Mensualidad (COP)', 'amountCOP', { inputmode: 'numeric', ph: acc && acc.amountCOP == null && acc.effectiveAmountCOP != null ? 'La de la organización: ' + money(acc.effectiveAmountCOP) : 'Ej. 180000' })
        + field('Día de corte', 'cutDay', { inputmode: 'numeric', ph: acc ? '' : 'El día en que ingresó', hint: '1 a 31. El cobro se genera ese día cada mes.' })
        + field('Días para pagar', 'dueDays', { inputmode: 'numeric', ph: ph('DueDays', 'Los de la organización') })
        + field('Aviso (días antes)', 'noticeDays', { inputmode: 'numeric', ph: ph('NoticeDays', 'Los de la organización') })
        + field('Gracia (días)', 'graceDays', { inputmode: 'numeric', ph: ph('GraceDays', 'Los de la organización') })
        + field('Desde el próximo corte (opcional)', 'amountNextCOP', { inputmode: 'numeric', ph: 'Nuevo monto' })
        + field('Cobra desde', 'startsOn', { type: 'date' })
        + '<label class="cb-f cb-chk"><input type="checkbox" data-cbf="active"' + (cb.form.active !== false ? ' checked' : '') + '><span>Cuenta activa</span></label>'
        + '</div>'
        + '<p class="cb-mini">Los plazos vacíos toman los de la organización. Cambiar el monto o los plazos NO mueve la cuenta de cobro ya abierta: para eso está «Ajustar».</p>'
        + foot('Guardar cuenta', 'save-acc')
        + '</div>';
    }
    if (cb.mode === 'paid' && cur) {
      return '<div class="cb-ed">'
        + '<p class="cb-ed-t">Marcar pagada la cuenta de ' + esc(monthLabel(cur.periodStart)) + ' · ' + esc(money(num(cur.amountDueCOP))) + '</p>'
        + '<div class="cb-grid">'
        + field('Medio', 'viaLabel', { ph: 'Efectivo, transferencia…' })
        + field('Monto recibido (COP)', 'amountCOP', { inputmode: 'numeric' })
        + field('Fecha del pago', 'paidOn', { type: 'date', max: hoyISO() })
        + field('Nota (opcional)', 'note', { wide: true })
        + '</div>'
        + '<p class="cb-mini">Queda al día' + (cur.blocked ? ' y sus reservas se reactivan' : '') + '. Si tenía un comprobante en revisión, queda aprobado con este pago. Al tripulante le llega el aviso.</p>'
        + foot('Marcar pagado', 'save-paid')
        + '</div>';
    }
    if (cb.mode === 'adjust' && cur) {
      return '<div class="cb-ed">'
        + '<p class="cb-ed-t">Ajustar la cuenta de ' + esc(monthLabel(cur.periodStart)) + '</p>'
        + '<div class="cb-grid">'
        + field('Monto de este mes (COP)', 'amountCOP', { inputmode: 'numeric' })
        + field('Descuento (COP)', 'discountCOP', { inputmode: 'numeric', ph: '0' })
        + field('Motivo del descuento', 'discountNote', { wide: true, ph: 'Ej. canje de Rendio Points: 3 días' })
        + '</div>'
        + '<p class="cb-mini">El tripulante ve el monto con el descuento aplicado. Las fechas no cambian.</p>'
        + foot('Guardar ajuste', 'save-adjust')
        + '</div>';
    }
    if (cb.mode === 'hist') {
      const d = cb.detail[r.auxiliarProfileId];
      let body;
      if (d === undefined) body = '<div class="cb-empty sm">Cargando…</div>';
      else if (d === null) body = '<div class="cb-empty sm"><b>No pudimos cargar el historial.</b></div>';
      else {
        const sts = Array.isArray(d.statements) ? d.statements.filter(isObj) : [];
        const prs = Array.isArray(d.proofs) ? d.proofs.filter(isObj) : [];
        body = sts.length ? '<table class="cb-hist"><thead><tr><th>Mes</th><th>Monto</th><th>Estado</th><th>Pago</th><th>Comprobantes</th></tr></thead><tbody>'
          + sts.map(s => {
            const ps = prs.filter(p => p.statementId === s.id);
            const stt = s.comp === 'review' ? 'review' : s.blocked ? 'bloqueado' : s.comp === 'rejected' && !s.paid ? 'rejected' : s.base;
            return '<tr><td>' + esc(monthLabel(s.periodStart)) + '</td><td>' + esc(money(num(s.amountDueCOP)))
              + (num(s.discountCOP) > 0 ? '<em>− ' + esc(money(num(s.discountCOP))) + (s.discountNote ? ' · ' + esc(s.discountNote) : '') + '</em>' : '') + '</td>'
              + '<td>' + tag(stt) + '</td><td>' + (s.paid ? esc(fmtDay(s.paidOn)) + ' · ' + esc(s.paidViaLabel || (s.paidVia === 'manual' ? 'a mano' : 'comprobante')) : '—') + '</td>'
              + '<td>' + (ps.length ? ps.map(p => esc(p.status === 'approved' ? 'Aprobado' : p.status === 'rejected' ? 'Rechazado: ' + (p.rejectReason || '') : 'En revisión')).join('<br>') : '—') + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="cb-empty sm">Todavía no tiene cuentas de cobro.</div>';
      }
      return '<div class="cb-ed">' + body + '<div class="cb-ed-foot"><button class="set-btn ghost" data-cb="close">Cerrar</button></div></div>';
    }
    return '';
  }

  // ── paneles de la organización ───────────────────────────────────────────
  const KINDS = [['bank', 'Banco'], ['nequi', 'Nequi'], ['daviplata', 'Daviplata'], ['other', 'Otro']];
  function methodsHTML() {
    if (cb.methods === undefined) return '<div class="cb-panel"><div class="cb-empty sm">Cargando…</div></div>';
    if (cb.methods === null) return '<div class="cb-panel"><div class="cb-empty sm"><b>No pudimos cargar los métodos de pago.</b></div></div>';
    const f = cb.mform;
    const mf = (label, key, o) => {
      o = o || {};
      const v = f ? f[key] : '';
      return '<label class="cb-f' + (o.wide ? ' wide' : '') + '"><span>' + esc(label) + '</span><input class="set-input" data-cbm="' + key + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(o.ph || '') + '" autocomplete="off"></label>';
    };
    return '<div class="cb-panel">'
      + '<div class="cb-panel-h"><b>Métodos de pago</b><span>Es lo que el tripulante ve en «Cómo pagar». Sin métodos activos, la app le dice que todavía no están cargados.</span></div>'
      + (cb.methods.length ? '<div class="cb-methods">' + cb.methods.map(m => '<div class="cb-method' + (m.active === false ? ' off' : '') + '">'
        + '<div><b>' + esc(m.label) + (m.accountType ? ' · ' + esc(m.accountType) : '') + '</b><span>' + esc(m.number) + (m.holderName ? ' · ' + esc(m.holderName) : '') + (m.holderNit ? ' · NIT ' + esc(m.holderNit) : '') + '</span></div>'
        + '<button class="set-btn ghost" data-cb="m-edit" data-id="' + esc(m.id) + '">Editar</button>'
        + '<button class="set-btn ghost" data-cb="m-toggle" data-id="' + esc(m.id) + '" data-on="' + (m.active === false ? '0' : '1') + '">' + (m.active === false ? 'Activar' : 'Desactivar') + '</button>'
        + '<button class="set-btn ghost" data-cb="m-del" data-id="' + esc(m.id) + '">Borrar</button>'
        + '</div>').join('') + '</div>' : '<div class="cb-empty sm"><b>No hay métodos de pago.</b><span>El tripulante no tiene a dónde transferir.</span></div>')
      + (f ? '<div class="cb-ed">'
        + '<p class="cb-ed-t">' + (f.id ? 'Editar método' : 'Nuevo método') + '</p>'
        + '<div class="cb-grid">'
        + '<label class="cb-f"><span>Tipo</span><select class="set-input" data-cbm="kind">' + KINDS.map(([k, l]) => '<option value="' + k + '"' + ((f.kind || 'bank') === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
        + mf('Nombre que ve el tripulante', 'label', { ph: 'Ej. Bancolombia' })
        + mf('Tipo de cuenta', 'accountType', { ph: 'Ahorros, corriente… (opcional)' })
        + mf('Número', 'number', { ph: 'El número de la cuenta o el celular' })
        + mf('Titular (opcional)', 'holderName', { ph: 'Si no, el de la organización' })
        + mf('NIT (opcional)', 'holderNit')
        + '</div>'
        + '<div class="cb-ed-foot"><button class="set-btn ghost" data-cb="m-cancel">Cancelar</button><button class="set-btn" data-cb="m-save"' + (cb.busy ? ' disabled' : '') + '>Guardar método</button></div>'
        + '</div>'
        : '<div class="cb-acts"><button class="set-btn ghost" data-cb="m-new">' + icon('i-plus') + 'Agregar método</button></div>')
      + '</div>';
  }
  function settingsForm(s) {
    return { defaultAmountCOP: s.defaultAmountCOP != null ? String(s.defaultAmountCOP) : '', dueDays: s.dueDays != null ? String(s.dueDays) : '',
      noticeDays: s.noticeDays != null ? String(s.noticeDays) : '', graceDays: s.graceDays != null ? String(s.graceDays) : '',
      holderName: s.holderName || '', holderNit: s.holderNit || '' };
  }
  function settingsHTML() {
    if (cb.settings === undefined) return '<div class="cb-panel"><div class="cb-empty sm">Cargando…</div></div>';
    if (cb.settings === null) return '<div class="cb-panel"><div class="cb-empty sm"><b>No pudimos cargar los valores por defecto.</b></div></div>';
    const f = cb.sform || settingsForm(cb.settings);
    const sf = (label, key, o) => {
      o = o || {};
      return '<label class="cb-f' + (o.wide ? ' wide' : '') + '"><span>' + esc(label) + '</span><input class="set-input" data-cbs="' + key + '"' + (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '')
        + ' value="' + esc(f[key] == null ? '' : f[key]) + '" placeholder="' + esc(o.ph || '') + '" autocomplete="off">' + (o.hint ? '<em>' + esc(o.hint) + '</em>' : '') + '</label>';
    };
    return '<div class="cb-panel">'
      + '<div class="cb-panel-h"><b>Valores por defecto de la organización</b><span>Los usa la cuenta de un tripulante cuando no tiene los suyos. El monto nace vacío: nadie cobra hasta que se cargue.</span></div>'
      + '<div class="cb-grid">'
      + sf('Mensualidad por defecto (COP)', 'defaultAmountCOP', { inputmode: 'numeric', ph: 'Sin monto por defecto' })
      + sf('Días para pagar', 'dueDays', { inputmode: 'numeric', hint: 'Desde el corte hasta la fecha límite.' })
      + sf('Aviso (días antes)', 'noticeDays', { inputmode: 'numeric', hint: '0 = sin recordatorio.' })
      + sf('Gracia (días)', 'graceDays', { inputmode: 'numeric', hint: 'Después de vencer, antes de pausar.' })
      + sf('Titular de las cuentas', 'holderName', { ph: 'Razón social' })
      + sf('NIT', 'holderNit')
      + '</div>'
      + '<div class="cb-ed-foot"><button class="set-btn" data-cb="s-save"' + (cb.busy ? ' disabled' : '') + '>Guardar</button></div>'
      + '</div>';
  }

  function paint() {
    const r = root(); if (!r) return;
    bind();
    const list = cb.list;
    const n = Array.isArray(list) ? list.length : 0;
    let h = '<div class="cb-wrap">'
      + '<div class="sh-phead"><div><h1>Cuentas de cobro <span class="sh-ct">' + n + '</span></h1>'
      + '<p>La mensualidad de cada tripulante. Un reloj diario (7:00 a. m.) abre el cobro de cada mes, manda los avisos y <b>pausa las reservas nuevas</b> de quien no pague a tiempo; lo que ya pidió sigue en pie. Con un comprobante en revisión no se pausa, y aprobar o marcar pagado reactiva.</p></div>'
      + '<div class="cb-acts"><button class="set-btn ghost' + (cb.panel === 'methods' ? ' on' : '') + '" data-cb="panel" data-v="methods">Métodos de pago</button>'
      + '<button class="set-btn ghost' + (cb.panel === 'settings' ? ' on' : '') + '" data-cb="panel" data-v="settings">Valores por defecto</button>'
      + '<button class="set-btn ghost" data-cb="reload">' + icon('i-refresh') + 'Refrescar</button></div></div>'
      + clockHTML();
    if (cb.panel === 'methods') h += methodsHTML();
    else if (cb.panel === 'settings') h += settingsHTML();
    if (!api()) {
      h += '<div class="cb-empty"><b>El facturario no está disponible en esta versión.</b></div></div>';
      r.innerHTML = h; return;
    }
    h += proofsHTML();
    if (list === undefined) h += '<div class="cb-empty">Cargando las cuentas…</div>';
    else if (list === null) h += '<div class="cb-empty"><b>No pudimos cargar las cuentas de cobro.</b><span>Puede que la base todavía no tenga el facturario (0090).</span><button class="set-btn ghost" data-cb="reload">Reintentar</button></div>';
    else if (!list.length) h += '<div class="cb-empty"><b>Todavía no hay tripulantes en la organización.</b></div>';
    else {
      const counts = FILTERS.map(f => list.filter(x => f[2](stateOf(x), x)).length);
      const rows = rowsFiltered();
      h += '<div class="cb-tools"><div class="cb-search">' + icon('i-search') + '<input id="cb-search" type="text" placeholder="Busca por nombre, correo, teléfono o referencia" value="' + esc(cb.q) + '" autocomplete="off"></div>'
        + '<div class="cb-filters">' + FILTERS.map((f, i) => '<button class="' + (cb.filter === f[0] ? 'on' : '') + '" data-cb="filter" data-v="' + f[0] + '">' + esc(f[1]) + ' <i>' + counts[i] + '</i></button>').join('') + '</div></div>'
        + (rows.length ? '<div class="cb-list">' + rows.map(rowHTML).join('') + '</div>' : '<div class="cb-empty"><b>Nadie en este filtro.</b></div>');
    }
    h += '</div>';
    r.innerHTML = h;
  }

  // ── acciones ─────────────────────────────────────────────────────────────
  const rowOf = (aux) => (cb.list || []).find(r => r.auxiliarProfileId === aux) || null;
  function openMode(aux, mode) {
    if (cb.open === aux && cb.mode === mode) { cb.open = null; cb.mode = null; paint(); return; }
    const r = rowOf(aux); if (!r) return;
    const acc = isObj(r.account) ? r.account : null;
    const cur = isObj(r.current) ? r.current : null;
    cb.open = aux; cb.mode = mode;
    if (mode === 'edit') {
      cb.form = acc ? {
        amountCOP: acc.amountCOP != null ? String(acc.amountCOP) : '', cutDay: acc.cutDay != null ? String(acc.cutDay) : '',
        dueDays: acc.dueDays != null ? String(acc.dueDays) : '', noticeDays: acc.noticeDays != null ? String(acc.noticeDays) : '',
        graceDays: acc.graceDays != null ? String(acc.graceDays) : '', amountNextCOP: acc.amountNextCOP != null ? String(acc.amountNextCOP) : '',
        startsOn: acc.startsOn || '', active: acc.active !== false,
      } : { amountCOP: '', cutDay: '', dueDays: '', noticeDays: '', graceDays: '', amountNextCOP: '', startsOn: '', active: true };
      if (cb.settings === undefined) {
        const a = api();
        if (a) tryCall(() => a.adminSettings()).then(x => { cb.settings = x.e ? null : (isObj(x.v) ? x.v : null); if (cb.open === aux && cb.mode === 'edit' && !typing()) paint(); });
      }
    } else if (mode === 'paid') {
      cb.form = { viaLabel: '', amountCOP: cur && cur.amountDueCOP != null ? String(cur.amountDueCOP) : '', paidOn: hoyISO(), note: '' };
    } else if (mode === 'adjust') {
      cb.form = { amountCOP: cur && cur.amountCOP != null ? String(cur.amountCOP) : '', discountCOP: cur && num(cur.discountCOP) ? String(cur.discountCOP) : '', discountNote: (cur && cur.discountNote) || '' };
    } else if (mode === 'hist') {
      cb.form = {};
      const a = api();
      cb.detail[aux] = undefined;
      if (a) tryCall(() => a.adminDetail(aux)).then(x => { cb.detail[aux] = x.e ? null : (isObj(x.v) ? x.v : null); if (cb.open === aux && cb.mode === 'hist') paint(); });
    }
    paint();
    const el = root() && root().querySelector('.cb-row.open input');
    if (el && mode !== 'hist') { try { el.focus(); } catch (_) { /* */ } }
  }
  async function run(key, fn, okMsg) {
    if (cb.busy) return;
    cb.busy = key; paint();
    let err = null, v;
    try { v = await fn(); } catch (e) { err = e; }
    cb.busy = null;
    if (err) { say((err && err.message) || 'No se pudo guardar'); paint(); return null; }
    if (okMsg) say(okMsg);
    return v === undefined ? true : v;
  }
  async function saveAcc(aux) {
    const f = cb.form;
    const r = rowOf(aux);
    const amount = digits(f.amountCOP);
    const effDefault = isObj(cb.settings) ? num(cb.settings.defaultAmountCOP) : null;
    if (amount == null && !(r && r.account && r.account.effectiveAmountCOP != null) && effDefault == null) { say('Falta la mensualidad: escribe el monto (o carga uno por defecto)'); return; }
    if (amount != null && amount <= 0) { say('La mensualidad tiene que ser mayor que cero'); return; }
    const cut = digits(f.cutDay);
    if (cut != null && (cut < 1 || cut > 31)) { say('El día de corte va de 1 a 31'); return; }
    for (const k of ['dueDays', 'noticeDays', 'graceDays']) { const d = digits(f[k]); if (d != null && d > 28) { say('Los plazos van de 0 a 28 días'); return; } }
    const a = api(); if (!a) return;
    const ok = await run(aux, () => a.adminSaveAccount(aux, {
      amountCOP: amount, cutDay: cut, dueDays: digits(f.dueDays), noticeDays: digits(f.noticeDays), graceDays: digits(f.graceDays),
      active: f.active !== false, amountNextCOP: digits(f.amountNextCOP), startsOn: f.startsOn || null,
    }), 'Cuenta guardada');
    if (ok) { cb.open = null; cb.mode = null; loadAll(false); }
  }
  async function savePaid(aux) {
    const r = rowOf(aux); const cur = r && isObj(r.current) ? r.current : null;
    if (!cur) return;
    const f = cb.form;
    if (f.paidOn && f.paidOn > hoyISO()) { say('La fecha del pago no puede ser futura'); return; }
    const a = api(); if (!a) return;
    const ok = await run(aux, () => a.adminMarkPaid(cur.id, { viaLabel: String(f.viaLabel || '').trim() || null, amountCOP: digits(f.amountCOP), paidOn: f.paidOn || null, note: String(f.note || '').trim() || null }),
      (r.name ? r.name + ' quedó al día' : 'Quedó al día'));
    if (ok) { cb.open = null; cb.mode = null; loadAll(false); }
  }
  async function saveAdjust(aux) {
    const r = rowOf(aux); const cur = r && isObj(r.current) ? r.current : null;
    if (!cur) return;
    const f = cb.form;
    const amount = digits(f.amountCOP), disc = digits(f.discountCOP);
    if (amount != null && amount <= 0) { say('El monto tiene que ser mayor que cero'); return; }
    const base = amount != null ? amount : num(cur.amountCOP);
    if (disc != null && base != null && disc > base) { say('El descuento no puede ser mayor que el monto'); return; }
    const a = api(); if (!a) return;
    const ok = await run(aux, () => a.adminAdjust(cur.id, { amountCOP: amount, discountCOP: disc == null ? 0 : disc, discountNote: String(f.discountNote || '').trim() || null }), 'Cuenta de cobro ajustada');
    if (ok) { cb.open = null; cb.mode = null; loadAll(false); }
  }
  async function openStatement(aux) {
    const a = api(); if (!a) return;
    const ok = await run(aux, () => a.adminOpenStatement(aux), 'Cuenta de cobro abierta');
    if (ok) loadAll(false);
  }
  async function approve(id) {
    const p = (cb.proofs || []).find(x => x.id === id);
    const a = api(); if (!a || !p) return;
    const ok = await run(id, () => a.adminApprove(id), (p.name ? p.name + ' quedó al día' : 'Comprobante aprobado'));
    if (ok) loadAll(false);
  }
  async function rejectGo(id) {
    const reason = cb.reason;
    if (!reason || REASONS().indexOf(reason) < 0) { say('Elige el motivo del rechazo'); return; }
    const a = api(); if (!a) return;
    const ok = await run(id, () => a.adminReject(id, reason), 'Comprobante rechazado');
    if (ok) { cb.rejecting = null; cb.reason = null; loadAll(false); }
  }
  async function saveMethod() {
    const f = cb.mform || {};
    if (!String(f.label || '').trim() || !String(f.number || '').trim()) { say('Falta el nombre o el número'); return; }
    const a = api(); if (!a) return;
    const ok = await run('m', () => a.adminSaveMethod({
      id: f.id || undefined, kind: f.kind || 'bank', label: String(f.label).trim(), accountType: String(f.accountType || '').trim() || null,
      number: String(f.number).trim(), holderName: String(f.holderName || '').trim() || null, holderNit: String(f.holderNit || '').trim() || null,
      position: f.position != null ? f.position : (cb.methods || []).length, active: f.active !== false,
    }), 'Método guardado');
    if (ok) { cb.mform = null; loadPanel(); }
  }
  async function toggleMethod(id, on) {
    const a = api(); if (!a) return;
    const ok = await run('m', () => a.adminSetMethodActive(id, !on), on ? 'Método desactivado' : 'Método activado');
    if (ok) loadPanel();
  }
  async function delMethod(id) {
    const m = (cb.methods || []).find(x => x.id === id);
    if (typeof window.confirm === 'function' && !window.confirm('¿Borrar ' + ((m && m.label) || 'este método') + '? El tripulante deja de verlo.')) return;
    const a = api(); if (!a) return;
    const ok = await run('m', () => a.adminDeleteMethod(id), 'Método borrado');
    if (ok) loadPanel();
  }
  async function saveSettings() {
    const f = cb.sform || {};
    const amt = digits(f.defaultAmountCOP);
    if (amt != null && amt <= 0) { say('La mensualidad por defecto tiene que ser mayor que cero'); return; }
    for (const k of ['dueDays', 'noticeDays', 'graceDays']) { const d = digits(f[k]); if (d != null && d > 28) { say('Los plazos van de 0 a 28 días'); return; } }
    const a = api(); if (!a) return;
    const ok = await run('s', () => a.adminSaveSettings({
      defaultAmountCOP: amt, dueDays: digits(f.dueDays), noticeDays: digits(f.noticeDays), graceDays: digits(f.graceDays),
      holderName: String(f.holderName || '').trim() || null, holderNit: String(f.holderNit || '').trim() || null,
    }), 'Valores guardados');
    if (ok) { cb.sform = null; cb.settings = undefined; loadPanel(); loadAll(true); }
  }

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-cb]') : null;
    if (!el || el.disabled) return;
    const k = el.getAttribute('data-cb');
    const aux = el.getAttribute('data-aux');
    const id = el.getAttribute('data-id');
    switch (k) {
      case 'reload': cb.urls = {}; loadAll(false); if (cb.panel) loadPanel(); break;
      case 'filter': cb.filter = el.getAttribute('data-v') || 'todos'; paint(); break;
      case 'panel': {
        const v = el.getAttribute('data-v');
        cb.panel = cb.panel === v ? null : v;
        cb.mform = null; cb.sform = null;
        if (cb.panel === 'methods') cb.methods = undefined;
        if (cb.panel === 'settings') cb.settings = undefined;
        paint(); if (cb.panel) loadPanel();
        break;
      }
      case 'mode': openMode(aux, el.getAttribute('data-m')); break;
      case 'close': cb.open = null; cb.mode = null; paint(); break;
      case 'save-acc': saveAcc(aux); break;
      case 'save-paid': savePaid(aux); break;
      case 'save-adjust': saveAdjust(aux); break;
      case 'open-st': openStatement(aux); break;
      case 'approve': approve(id); break;
      case 'reject': cb.rejecting = id; cb.reason = null; paint(); break;
      case 'reject-cancel': cb.rejecting = null; cb.reason = null; paint(); break;
      case 'reject-go': rejectGo(id); break;
      case 'm-new': cb.mform = { kind: 'bank' }; paint(); break;
      case 'm-edit': { const m = (cb.methods || []).find(x => x.id === id); if (m) { cb.mform = Object.assign({}, m); paint(); } break; }
      case 'm-cancel': cb.mform = null; paint(); break;
      case 'm-save': saveMethod(); break;
      case 'm-toggle': toggleMethod(id, el.getAttribute('data-on') === '1'); break;
      case 'm-del': delMethod(id); break;
      case 's-save': saveSettings(); break;
      default: break;
    }
  }
  function onInput(e) {
    const t = e.target; if (!t) return;
    if (t.id === 'cb-search') {
      cb.q = t.value;
      const r = root(); const list = r && r.querySelector('.cb-list, .cb-tools + .cb-empty');
      const rows = rowsFiltered();
      const html = rows.length ? '<div class="cb-list">' + rows.map(rowHTML).join('') + '</div>' : '<div class="cb-empty"><b>Nadie en este filtro.</b></div>';
      if (list) list.outerHTML = html;
      return;
    }
    if (t.hasAttribute('data-cbf')) { cb.form[t.getAttribute('data-cbf')] = t.type === 'checkbox' ? t.checked : t.value; return; }
    if (t.hasAttribute('data-cbm')) { cb.mform = cb.mform || {}; cb.mform[t.getAttribute('data-cbm')] = t.value; return; }
    if (t.hasAttribute('data-cbs')) { cb.sform = cb.sform || settingsForm(isObj(cb.settings) ? cb.settings : {}); cb.sform[t.getAttribute('data-cbs')] = t.value; return; }
    if (t.hasAttribute('data-cbr')) {
      cb.reason = t.value;
      const btn = t.closest('.cb-reasons') && t.closest('.cb-reasons').querySelector('[data-cb="reject-go"]');
      if (btn) btn.disabled = !cb.reason || !!cb.busy;
    }
  }
  function bind() {
    const r = root();
    if (!r || cb.bound) return;
    cb.bound = true;
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
    r.addEventListener('change', onInput);
  }

  // ── entrada / salida de la pestaña ───────────────────────────────────────
  function visible() {
    const r = root();
    const sec = r && r.closest('section');
    return !!(r && (!sec || !sec.classList.contains('hidden')));
  }
  function stopCobroTimer() { if (cb.poll) { clearInterval(cb.poll); cb.poll = null; } }
  function renderCobro() {
    paint();
    loadAll(cb.list !== undefined);
    if (cb.panel) loadPanel();
    stopCobroTimer();
    cb.poll = setInterval(() => { if (visible() && document.visibilityState !== 'hidden') loadAll(true); }, CB_POLL_MS);
  }
  function focusAux(aux) {
    if (!aux) return;
    if (!Array.isArray(cb.list)) { cb.pendingAux = aux; return; }
    cb.pendingAux = null;
    if (!rowOf(aux)) return;
    cb.filter = 'todos'; cb.q = '';
    const r = rowOf(aux);
    if (cb.open !== aux) openMode(aux, r && isObj(r.account) ? 'hist' : 'edit');
    else paint();
    const el = root() && root().querySelector('.cb-row[data-aux="' + (window.CSS && CSS.escape ? CSS.escape(aux) : aux) + '"]');
    if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'center' }); } catch (_) { /* */ } }
  }

  // ── enlace profundo #/cobro?aux=<id> (solo el jefe) ──────────────────────
  const esJefe = () => {
    try { return typeof state !== 'undefined' && !!state && !!state.profile && state.profile.role === 'admin'; }
    catch (_) { return false; }
  };
  function leerHash() {
    const m = String(location.hash || '').match(/^#\/cobro(?:\?(.*))?$/i);
    if (!m) return null;
    return { aux: new URLSearchParams(m[1] || '').get('aux') || null };
  }
  function tomarHash() {
    const d = leerHash(); if (!d || !esJefe()) return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* */ }
    if (d.aux) cb.pendingAux = d.aux;
    if (typeof setTab === 'function') setTab('cobro');                 // core.js (ámbito global)
    else renderCobro();
    if (d.aux && Array.isArray(cb.list)) focusAux(d.aux);
    return true;
  }
  window.addEventListener('hashchange', () => { try { tomarHash(); } catch (_) { /* */ } });
  // En frío: core cae a la consola con setTab('consola'); se espera a ese setTab
  // (state.activeTab cambia) y ahí se abre la pestaña. Tope: 60 s.
  (function cbDeepLinkAlArrancar() {
    if (!leerHash()) return;
    let inicial;
    try { inicial = (typeof state !== 'undefined' && state) ? state.activeTab : undefined; } catch (_) { /* */ }
    let n = 0;
    const iv = setInterval(() => {
      n++;
      let rol = null, entro = false;
      try {
        rol = (typeof state !== 'undefined' && state && state.profile) ? state.profile.role : null;
        entro = !!rol && state.activeTab !== inicial;
      } catch (_) { /* */ }
      if (entro || (!!rol && rol !== 'admin') || n > 240 || !leerHash()) {
        clearInterval(iv);
        if (entro && rol === 'admin') { try { tomarHash(); } catch (_) { /* */ } }
      }
    }, 250);
  })();

  renderCobro.focus = focusAux;
  renderCobro._state = () => cb;       // para pruebas
  window.renderCobro = renderCobro;
  window.stopCobroTimer = stopCobroTimer;
})();
