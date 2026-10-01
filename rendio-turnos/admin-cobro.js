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
// 0094 (pedido de la dueña, 29-sep-2026):
//   · «Tarifas por sector» (panel junto a Métodos de pago y Valores por defecto):
//     mensualidad y valor por viaje (vacaciones) de cada sector de las residencias
//     de la organización, más los que ya tienen tarifa o se pusieron a mano, con
//     cuántos tripulantes caen en cada uno y cuántos no tienen sector.
//   · En la cuenta de cada tripulante: su sector (de su residencia o a mano) y el
//     «Valor propio»: vacío = el del sector (30-sep: ya no hay mensualidad por defecto).
//   · Vacaciones: chip y filtro en la lista; el jefe también las marca o cancela.
//   · «Balance» del mes (vista aparte): totales, por sector, por tripulante (con la
//     marca roja de «reservó más de lo que declaró»), pagos, y «Descargar Excel»
//     (window.ExcelJS, el patrón de admin-balance.js): Resumen, Por tripulante,
//     Por sector y Pagos. Los estados salen de la base (admin_billing_balance).
//
// 30-sep (respuestas de la dueña):
//   · «Todos tienen su propio valor»: la mensualidad es el valor propio → la del
//     sector. La de la organización ya no existe (el panel «Valores por defecto»
//     queda con los plazos y el titular). Sin valor no se abre cobro: chip «Sin
//     valor», su filtro, y en el Balance «N tripulantes sin valor cargado». En el
//     editor, «Valor propio» es el campo principal; vacío = la del sector.
//   · «Si reserva más viajes de los que declaró, se le cobra la diferencia»: la
//     base recalcula sola (o deja un cargo pendiente para el próximo cobro). Aquí
//     se pinta: chips «Extra pendiente» / «Incluye extra», en Vacaciones e
//     Historial declarados · reservados · cobrados · extra, y en el Balance y el
//     Excel las columnas Declarados · Reservados · Cobrados · Extra cobrado ·
//     Extra pendiente (la marca roja ahora es «tiene extra» y dice cuánto).
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
    // 0094
    view: 'cuentas',          // 'cuentas' | 'balance'
    rates: undefined,         // admin_billing_sector_rates (undefined = no cargó · null = falló)
    rform: {},                // clave del sector → {monthlyCOP, perTripCOP} en edición
    rnew: { sector: '', monthlyCOP: '', perTripCOP: '' },
    bal: undefined,           // admin_billing_balance del mes (undefined = no cargó · null = falló)
    balMonth: null,           // 'AAAA-MM' (null = el de hoy)
    balLoading: false,
    xlsx: null,               // último Excel generado {file, buf} (para pruebas)
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
  // Sin valor (30-sep): cuenta activa sin valor propio ni mensualidad de su
  // sector → la base no le abre cobro. Lo dice la base (noValue; quien solo
  // tiene un valor «desde el próximo corte» no cuenta); con una base vieja, sin
  // monto efectivo.
  function noValue(r) {
    const acc = isObj(r && r.account) ? r.account : null;
    if (!acc || acc.active === false) return false;
    return typeof acc.noValue === 'boolean' ? acc.noValue : acc.effectiveAmountCOP == null;
  }
  // Viajes extra de vacaciones (30-sep): lo que entra en su próximo cobro y lo
  // que su cuenta abierta ya trae de un cobro anterior.
  const pendOf = (r) => (r && isObj(r.extrasPending) ? (num(r.extrasPending.amountCOP) || 0) : 0);
  const incOf = (r) => (r && isObj(r.current) ? (num(r.current.extrasCOP) || 0) : 0);
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
  // Vacaciones de una fila (0094): {cur, next}, cada uno el período de
  // billing_vac_period_json ({periodStart, periodEnd, canChange, why, tripsBooked, vacation}).
  function vacOfRow(r) {
    const v = r && isObj(r.vacation) ? r.vacation : null;
    return { cur: v && isObj(v.current) ? v.current : null, next: v && isObj(v.next) ? v.next : null };
  }
  const hasVac = (p) => !!(p && isObj(p.vacation));
  // Permiso del JEFE (0094): adminCanChange / adminWhy si la base los trae (el
  // jefe sí cambia un cobro vencido y reabre el que quedó saldado solo en $0);
  // si no, los del tripulante.
  const admCan = (p) => !!p && (typeof p.adminCanChange === 'boolean' ? p.adminCanChange : !!p.canChange);
  const admWhy = (p) => (p ? ('adminWhy' in p ? p.adminWhy : p.why) : null);
  // ¿Este cobro es de vacaciones? Las activas, o la foto de la cuenta abierta
  // (vacaciones canceladas con la cuenta ya pagada: se cobró así y así se dice).
  function vacNow(r) {
    const v = vacOfRow(r);
    if (hasVac(v.cur)) return true;
    const c = isObj(r.current) ? r.current : null;
    return !!(c && c.modality === 'vacaciones' && v.cur && c.periodStart === v.cur.periodStart);
  }
  const FILTERS = [
    ['todos', 'Todos', () => true],
    ['revisar', 'Por revisar', (s) => s === 'review'],
    ['pausados', 'Pausados', (s, r) => s === 'bloqueado' || !!(r.account && r.account.paused)],
    ['mora', 'En mora', (s) => s === 'vencido' || s === 'rejected'],
    ['pendientes', 'Pendientes', (s) => s === 'pendiente' || s === 'porVencer' || s === 'venceHoy'],
    ['aldia', 'Al día', (s) => s === 'pagado'],
    ['vacaciones', 'Vacaciones', (s, r) => vacNow(r) || hasVac(vacOfRow(r).next)],
    ['sinvalor', 'Sin valor', (s, r) => noValue(r)],
    ['sincuenta', 'Sin cuenta', (s) => s === 'sinCuenta' || s === 'sinCorte' || s === 'inactiva'],
  ];
  const VAC_WHY = {
    paid: 'Ese cobro ya está pagado: sus vacaciones ya no cambian el monto.',
    review: 'Hay un comprobante en revisión en ese cobro: apruébalo o recházalo primero.',
    notStarted: 'Ese cobro todavía no corre (la cuenta cobra desde más adelante).',
    inactive: 'La cuenta está apagada.',
  };

  // Sectores y tarifas conocidos (del panel de tarifas si ya cargó; si no, de la lista).
  const skey = (s) => norm(s).trim();
  function knownSectors() {
    const out = new Map();
    const add = (s) => { const k = skey(s); if (k && !out.has(k)) out.set(k, String(s).trim()); };
    if (isObj(cb.rates) && Array.isArray(cb.rates.sectors)) cb.rates.sectors.forEach(x => isObj(x) && add(x.sector));
    (cb.list || []).forEach(r => { if (r && r.sector) add(r.sector); });
    return [...out.values()].sort((a, b) => a.localeCompare(b, 'es'));
  }
  function rateFor(sector) {
    const k = skey(sector); if (!k) return null;
    if (isObj(cb.rates) && Array.isArray(cb.rates.sectors)) {
      const x = cb.rates.sectors.find(y => isObj(y) && skey(y.sector) === k);
      return x ? { monthlyCOP: num(x.monthlyCOP), perTripCOP: num(x.perTripCOP) } : null;
    }
    const r = (cb.list || []).find(y => y && y.sector && skey(y.sector) === k && isObj(y.sectorRate));
    return r ? { monthlyCOP: num(r.sectorRate.monthlyCOP), perTripCOP: num(r.sectorRate.perTripCOP) } : null;
  }
  const vacLine = (v) => pl(num(v.trips) || 0, 'viaje', 'viajes') + ' × ' + money(num(v.perTripCOP)) + ' = ' + money(num(v.totalCOP));
  // «Declarados 3 · Reservados 5 · Cobrados 5 · Extra pendiente $20.000» de un
  // período (billing_vac_period_json): solo lo que la base trae.
  function vacCounts(p, vac) {
    if (!p) return '';
    const out = [];
    if (vac) out.push('Declarados ' + (num(vac.trips) || 0));
    if (num(p.tripsBooked) != null) out.push('Reservados ' + num(p.tripsBooked));
    if (num(p.tripsBilled) != null) out.push('Cobrados ' + num(p.tripsBilled));
    if (num(p.extraPendingCOP)) out.push('Extra pendiente ' + money(num(p.extraPendingCOP)) + ' (' + pl(num(p.extraPendingTrips) || 0, 'viaje', 'viajes') + ', entra en el próximo cobro)');
    return out.join(' · ');
  }

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
    } else if (cb.panel === 'rates') {
      await loadRates();
    }
    paint();
  }
  // Tarifas por sector (0094). Sin RPC (base sin 0094) → null: el panel lo dice.
  async function loadRates() {
    const a = api();
    if (!a || typeof a.adminSectorRates !== 'function') { cb.rates = null; return; }
    const r = await tryCall(() => a.adminSectorRates());
    cb.rates = r.e ? null : (isObj(r.v) ? r.v : null);
    cb.rform = {};
    if (isObj(cb.rates) && Array.isArray(cb.rates.sectors)) {
      cb.rates.sectors.filter(isObj).forEach(s => {
        cb.rform[skey(s.sector)] = { monthlyCOP: s.monthlyCOP != null ? String(s.monthlyCOP) : '', perTripCOP: s.perTripCOP != null ? String(s.perTripCOP) : '' };
      });
    }
  }
  // Balance del mes (0094).
  const balMonthNow = () => cb.balMonth || hoyISO().slice(0, 7);
  async function loadBal() {
    const a = api();
    if (!a || typeof a.adminBalance !== 'function') { cb.bal = null; paint(); return; }
    if (cb.balLoading) return;
    cb.balLoading = true;
    const m = balMonthNow();
    paint();
    const r = await tryCall(() => a.adminBalance(m));
    cb.balLoading = false;
    if (m !== balMonthNow()) { loadBal(); return; }       // cambió el mes mientras tanto
    cb.bal = r.e ? null : (isObj(r.v) ? r.v : null);
    if (cb.view === 'balance') paint();
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

  // Chip de vacaciones: las de este cobro; si no, «Vacaciones en <mes>» (el siguiente).
  function vacChip(r) {
    const v = vacOfRow(r);
    if (vacNow(r)) return ' <span class="cb-tag t-info" data-cb-chip="vac">Vacaciones</span>';
    if (hasVac(v.next)) return ' <span class="cb-tag t-muted" data-cb-chip="vac-next">Vacaciones en ' + esc(MES[(parts(v.next.periodStart) || { mo: 1 }).mo - 1]) + '</span>';
    return '';
  }
  // «Valor propio» (0094): su cuenta tiene monto propio y por eso NO paga la
  // mensualidad de su sector (las cuentas de 0090 casi todas tienen monto).
  function ownChip(r) {
    const acc = isObj(r.account) ? r.account : null;
    if (!acc || acc.amountSource !== 'own' || acc.sectorMonthlyCOP == null || !r.sector) return '';
    return ' <span class="cb-tag t-muted" data-cb-chip="own" title="' + esc('No paga la del sector ' + r.sector + ' (' + money(num(acc.sectorMonthlyCOP)) + ')') + '">Valor propio</span>';
  }
  // «Sin valor» (30-sep): no se le abre cobro hasta que tenga uno.
  function noValChip(r) {
    if (!noValue(r)) return '';
    return ' <span class="cb-tag t-warn" data-cb-chip="noval" title="' + esc(r.sector ? 'Sin valor propio y el sector ' + r.sector + ' no tiene mensualidad' : 'Sin valor propio y sin sector con mensualidad') + '">Sin valor</span>';
  }
  // Viajes extra de vacaciones (30-sep): lo pendiente para su próximo cobro y lo
  // que su cuenta abierta ya incluye de un cobro anterior.
  function extraChip(r) {
    const pend = pendOf(r), inc = incOf(r);
    let h = '';
    if (pend) h += ' <span class="cb-tag t-warn" data-cb-chip="extra-pend" title="Viajes de vacaciones de más: entran en su próximo cobro">Extra pendiente ' + esc(money(pend)) + '</span>';
    if (inc) h += ' <span class="cb-tag t-info" data-cb-chip="extra-inc" title="' + esc(((r.current.extras || []).filter(isObj).map(x => x.label).filter(Boolean)).join(' · ') || 'Viajes extra de un cobro anterior') + '">Incluye extra ' + esc(money(inc)) + '</span>';
    return h;
  }
  function rowHTML(r) {
    const st = stateOf(r);
    const acc = isObj(r.account) ? r.account : null;
    const cur = isObj(r.current) ? r.current : null;
    const open = cb.open === r.auxiliarProfileId;
    const amount = cur ? num(cur.amountDueCOP) : acc ? num(acc.effectiveAmountCOP) : null;
    let when = '';
    if (!acc) when = 'Sin mensualidad';
    else if (!cur && noValue(r)) when = 'Sin valor: no se le abre cobro';
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
    if (acc && acc.active !== false && isObj(r.vacation)) acts.push('<button class="set-btn ghost" data-cb="mode" data-m="vac" data-aux="' + esc(r.auxiliarProfileId) + '">Vacaciones</button>');
    if (acc) acts.push('<button class="set-btn ghost" data-cb="mode" data-m="hist" data-aux="' + esc(r.auxiliarProfileId) + '">Historial</button>');
    // Sector: solo si la base ya lo trae (0094); sin él, «Sin sector» sería un invento.
    const sec = 'sector' in r ? (r.sector || 'Sin sector') : null;
    return '<div class="cb-row' + (open ? ' open' : '') + '" data-aux="' + esc(r.auxiliarProfileId) + '">'
      + '<div class="cb-main">'
      + '<div class="cb-who"><b>' + esc(r.name || 'Sin nombre') + (r.isActive === false ? ' <span class="cb-tag t-muted">Suspendida</span>' : '') + '</b>'
      + '<span>' + esc([acc && acc.reference, sec, r.phone || r.email].filter(Boolean).join(' · ')) + '</span></div>'
      + '<div class="cb-st">' + tag(st) + (acc && acc.paused && st !== 'bloqueado' ? ' <span class="cb-tag t-block">Reservas pausadas</span>' : '') + vacChip(r) + ownChip(r) + noValChip(r) + extraChip(r) + '</div>'
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
  // «Vacío = …» del valor propio: la del sector (el escrito o el de su
  // residencia); sin ella, que escriba su valor (la mensualidad de la
  // organización ya no existe: 30-sep).
  function amtPhOf(r) {
    if (!('sector' in r)) return 'Ej. 180000';
    const secName = String(cb.form.sector || '').trim() || r.residenceSector || null;
    const sr = secName ? rateFor(secName) : null;
    return sr && sr.monthlyCOP != null ? 'Vacío = la del sector ' + secName + ': ' + money(sr.monthlyCOP)
      : secName ? 'El sector ' + secName + ' no tiene mensualidad: escribe su valor'
      : 'Sin sector con mensualidad: escribe su valor';
  }
  // Llegaron las tarifas (o cambió el sector escrito) con el editor abierto: se
  // actualizan en su lugar la lista de sectores y el «vacío = …», sin repintar
  // (no se le borra lo que va escribiendo).
  function patchEditHints() {
    const rt = root(); const r = cb.open && cb.mode === 'edit' ? rowOf(cb.open) : null;
    if (!rt || !r || !('sector' in r)) return;
    const dl = rt.querySelector('.cb-row.open #cb-sectors');
    if (dl) dl.innerHTML = knownSectors().map(s => '<option value="' + esc(s) + '"></option>').join('');
    const inp = rt.querySelector('.cb-row.open [data-cbf="amountCOP"]');
    if (inp) inp.setAttribute('placeholder', amtPhOf(r));
  }
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
      // 0094: el sector (de su residencia o a mano) y el valor propio opcional.
      const conSector = 'sector' in r;
      const amtPh = amtPhOf(r);
      const secHint = !conSector ? '' : r.residenceName
        ? 'Vive en ' + r.residenceName + (r.residenceSector ? ' (sector ' + r.residenceSector + ')' : ' (conjunto sin sector)') + '. Vacío = el de su residencia.'
        : 'Vive en casa (sin conjunto): asígnale uno a mano.';
      const secs = conSector ? knownSectors() : [];
      const secM = acc ? num(acc.sectorMonthlyCOP) : null;
      const ownHint = !conSector ? ''
        : acc && acc.amountCOP != null && secM != null && r.sector
          ? 'Tiene valor propio: no paga la del sector ' + r.sector + ' (' + money(secM) + '). Bórralo para que pague la del sector.'
          : 'Lo que paga cada mes. Vacío = la mensualidad de su sector; sin ninguna, no se le abre cobro.';
      return '<div class="cb-ed">'
        + '<p class="cb-ed-t">' + (acc ? 'Cuenta ' + esc(acc.reference || '') : 'Crear la cuenta de cobro de ' + esc(r.name || 'este tripulante')) + '</p>'
        + '<div class="cb-grid">'
        + field(conSector ? 'Valor propio (COP)' : 'Mensualidad (COP)', 'amountCOP', { inputmode: 'numeric', ph: amtPh, hint: ownHint })
        + (conSector
          ? '<label class="cb-f"><span>Sector</span><input class="set-input" data-cbf="sector" list="cb-sectors" value="' + esc(cb.form.sector || '') + '" placeholder="'
            + esc(r.residenceSector ? 'De su residencia: ' + r.residenceSector : 'Sin sector: escribe o elige uno') + '" autocomplete="off">'
            + '<em>' + esc(secHint) + '</em></label>'
            + '<datalist id="cb-sectors">' + secs.map(s => '<option value="' + esc(s) + '"></option>').join('') + '</datalist>'
          : '')
        + field('Día de corte', 'cutDay', { inputmode: 'numeric', ph: acc ? '' : 'El día en que ingresó', hint: '1 a 31. El cobro se genera ese día cada mes.' })
        + field('Días para pagar', 'dueDays', { inputmode: 'numeric', ph: ph('DueDays', 'Los de la organización') })
        + field('Aviso (días antes)', 'noticeDays', { inputmode: 'numeric', ph: ph('NoticeDays', 'Los de la organización') })
        + field('Gracia (días)', 'graceDays', { inputmode: 'numeric', ph: ph('GraceDays', 'Los de la organización') })
        + field('Desde el próximo corte (opcional)', 'amountNextCOP', { inputmode: 'numeric', ph: 'Nuevo monto' })
        + field('Cobra desde', 'startsOn', { type: 'date' })
        + '<label class="cb-f cb-chk"><input type="checkbox" data-cbf="active"' + (cb.form.active !== false ? ' checked' : '') + '><span>Cuenta activa</span></label>'
        + '</div>'
        + '<p class="cb-mini">Los plazos vacíos toman los de la organización. Cambiar el monto, el sector o los plazos NO mueve la cuenta de cobro ya abierta: para eso está «Ajustar».</p>'
        + foot('Guardar cuenta', 'save-acc')
        + '</div>';
    }
    if (cb.mode === 'vac' && acc) return vacEditorHTML(r, foot);
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
            // 30-sep: los viajes extra de un cobro anterior que trae (ya van en el monto).
            const exs = Array.isArray(s.extras) ? s.extras.filter(isObj) : [];
            // Revisión 1-oct: el descuento que puso el jefe se guarda; si el cobro de
            // vacaciones quedó por debajo, se aplica hasta el monto (y vuelve si sube).
            const dReq = num(s.discountRequestedCOP), dApl = num(s.discountCOP);
            const dCut = dReq != null && dApl != null && dReq > dApl ? ' (puso ' + money(dReq) + '; se aplica hasta el monto)' : '';
            return '<tr><td>' + esc(monthLabel(s.periodStart)) + '</td><td>' + esc(money(num(s.amountDueCOP)))
              + (num(s.discountCOP) > 0 ? '<em data-cb-hist-disc>− ' + esc(money(num(s.discountCOP))) + (s.discountNote ? ' · ' + esc(s.discountNote) : '') + esc(dCut) + '</em>' : '')
              + exs.map(x => '<em data-cb-hist-extra>Incluye: ' + esc(x.label || ('Viajes extra: ' + money(num(x.amountCOP)))) + '</em>').join('') + '</td>'
              + '<td>' + tag(stt) + '</td><td>' + (s.paid ? esc(fmtDay(s.paidOn)) + ' · ' + esc(s.paidViaLabel || (s.paidVia === 'manual' ? 'a mano' : 'comprobante')) : '—') + '</td>'
              + '<td>' + (ps.length ? ps.map(p => esc(p.status === 'approved' ? 'Aprobado' : p.status === 'rejected' ? 'Rechazado: ' + (p.rejectReason || '') : 'En revisión')).join('<br>') : '—') + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<div class="cb-empty sm">Todavía no tiene cuentas de cobro.</div>';
        // Viajes extra de vacaciones que todavía no entran en ninguna cuenta.
        const pend = (Array.isArray(d.extraCharges) ? d.extraCharges.filter(isObj) : []).filter(x => x.pending);
        if (pend.length) {
          body += '<div class="cb-note warn" data-cb-hist-pend>' + icon('i-warn') + '<div><b>Extra pendiente para su próximo cobro: '
            + esc(money(pend.reduce((a, x) => a + (num(x.amountCOP) || 0), 0))) + '</b>'
            + '<span>' + pend.map(x => esc(x.label || '')).join(' · ') + '. Reservó más viajes de los que declaró con ese cobro ya cerrado.</span></div></div>';
        }
      }
      return '<div class="cb-ed">' + body + '<div class="cb-ed-foot"><button class="set-btn ghost" data-cb="close">Cerrar</button></div></div>';
    }
    return '';
  }

  // Vacaciones de un tripulante (0094): las activas de este cobro y del
  // siguiente (con «Cancelar»: el jefe siempre puede) y el formulario para
  // marcarlas con el cálculo en vivo «N viajes × $V = $T».
  function vacPeriodOf(r, k) { const v = vacOfRow(r); return k === 'next' ? v.next : v.cur; }
  function vacCalcText(r) {
    const per = r && isObj(r.sectorRate) ? num(r.sectorRate.perTripCOP) : null;
    const n = digits(cb.form.trips);
    if (per == null || n == null) return '';
    // Se cobra la diferencia: con más reservados que los que escribe, se cobran los reservados.
    const p = vacPeriodOf(r, cb.form.period);
    const booked = p ? num(p.tripsBooked) : null;
    return pl(n, 'viaje', 'viajes') + ' × ' + money(per) + (r.sector ? ' (sector ' + r.sector + ')' : '') + ' = ' + money(per * n)
      + (booked != null && booked > n ? ' · tiene ' + pl(booked, 'viaje reservado', 'viajes reservados') + ': se cobran ' + booked + ' = ' + money(per * booked) : '');
  }
  function vacEditorHTML(r, foot) {
    const aux = r.auxiliarProfileId;
    const v = vacOfRow(r);
    const per = isObj(r.sectorRate) ? num(r.sectorRate.perTripCOP) : null;
    const pSel = vacPeriodOf(r, cb.form.period);
    const lines = [['current', 'Este cobro', v.cur], ['next', 'El siguiente', v.next]].filter(x => !!x[2]).map(([k, lbl, p]) => {
      const vac = isObj(p.vacation) ? p.vacation : null;
      const booked = num(p.tripsBooked);
      const over = vac && booked != null && booked > (num(vac.trips) || 0);
      // Se cobra la diferencia (30-sep): cuánto de más, cobrado o pendiente.
      const xt = num(p.extraTrips) || 0, xc = num(p.extraCOP) || 0;
      const counts = vac ? vacCounts(p, vac) : '';
      return '<div class="cb-method" data-cb-vac="' + k + '"><div><b>' + esc(lbl + ' · ' + fmtDay(p.periodStart) + ' – ' + fmtDay(p.periodEnd)) + '</b>'
        + '<span>' + esc(vac
          ? 'Vacaciones: ' + vacLine(vac) + ' · del ' + fmtDay(vac.startsOn) + ' al ' + fmtDay(vac.endsOn) + (vac.setBy === 'admin' ? ' · las marcó Coordinación' : ' · las marcó el tripulante')
          : 'Mensualidad') + '</span>'
        + (counts ? '<span data-cb-vac-counts>' + esc(counts) + '</span>' : '')
        + (booked != null ? '<span class="' + (over ? 'cb-bad' : '') + '">' + esc(pl(booked, 'viaje reservado', 'viajes reservados') + (over ? ' · más de lo declarado' + (xt && xc ? ': se le cobran ' + pl(xt, 'viaje', 'viajes') + ' de más (' + money(xc) + ')' : '') : '')) + '</span>' : '')
        + '</div>'
        + (vac ? '<button class="set-btn ghost" data-cb="vac-cancel" data-p="' + k + '" data-aux="' + esc(aux) + '"' + (cb.busy ? ' disabled' : '') + '>Cancelar vacaciones</button>' : '')
        + '</div>';
    }).join('');
    let form;
    if (per == null) {
      form = '<div class="cb-note warn">' + icon('i-warn') + '<div><b>' + esc(r.sector ? 'El sector ' + r.sector + ' no tiene valor por viaje.' : 'No tiene sector.') + '</b>'
        + '<span>' + esc(r.sector ? 'Cárgalo en «Tarifas por sector» para poder marcar vacaciones.' : 'Asígnale uno en «Editar cuenta» y carga su valor por viaje en «Tarifas por sector».') + '</span></div></div>';
    } else {
      const p = pSel;
      const why = p && !admCan(p) ? (VAC_WHY[admWhy(p)] || 'Ese cobro ya no se puede cambiar.') : '';
      // Lo que el tripulante no puede y el jefe sí (la base lo avisa en canChange/why).
      const info = !p || why ? ''
        : p.statementZero ? 'Ese cobro quedó saldado solo en $0 (vacaciones sin viajes). Si lo cambias, se reabre con el monto nuevo y hay que pagarlo (si ya pasó la fecha, se pausa).'
        : p.statementOverdue ? 'Ese cobro está vencido: el tripulante ya no lo puede cambiar; tú sí. El monto nuevo corre con las mismas fechas.'
        : num(p.tripsTaken) ? 'Ya hizo ' + pl(num(p.tripsTaken), 'viaje', 'viajes') + ' en ese cobro: el tripulante no puede declarar menos.' : '';
      const opt = (k, lbl) => { const pp = vacPeriodOf(r, k); return pp ? '<option value="' + k + '"' + (cb.form.period === k ? ' selected' : '') + '>' + esc(lbl + ' (desde el ' + fmtDay(pp.periodStart) + ')') + '</option>' : ''; };
      form = '<p class="cb-ed-t">Marcar vacaciones</p>'
        + '<div class="cb-grid">'
        + '<label class="cb-f"><span>Cobro</span><select class="set-input" data-cbf="period">' + opt('current', 'Este cobro') + opt('next', 'El siguiente') + '</select></label>'
        + field('Desde', 'startsOn', { type: 'date' })
        + field('Hasta', 'endsOn', { type: 'date' })
        + field('Viajes que va a tomar', 'trips', { inputmode: 'numeric', hint: '0 a 200. Cada ida o regreso es uno.' })
        + '</div>'
        + '<p class="cb-mini" data-cb-vac-calc>' + esc(vacCalcText(r)) + '</p>'
        + (why ? '<p class="cb-mini warn" data-cb-vac-why>' + esc(why) + '</p>' : '')
        + (info ? '<p class="cb-mini warn" data-cb-vac-info>' + esc(info) + '</p>' : '')
        + '<p class="cb-mini">Ese cobro vale viajes × valor por viaje en vez de la mensualidad. Si ya está abierto, su monto se recalcula; al tripulante le llega el aviso.</p>';
    }
    const busy = cb.busy === aux;
    return '<div class="cb-ed">'
      + '<p class="cb-ed-t">Vacaciones de ' + esc(r.name || 'este tripulante') + '</p>'
      + (lines ? '<div class="cb-methods">' + lines + '</div>' : '')
      + form
      + (per == null
        ? '<div class="cb-ed-foot"><button class="set-btn ghost" data-cb="close">Cerrar</button></div>'
        : '<div class="cb-ed-foot"><button class="set-btn ghost" data-cb="close">Cancelar</button>'
          + '<button class="set-btn" data-cb="save-vac" data-aux="' + esc(aux) + '"' + (busy || (pSel && !admCan(pSel)) ? ' disabled' : '') + '>Marcar vacaciones</button></div>')
      + '</div>';
  }
  // Valores del formulario para un cobro: los de sus vacaciones o los límites del cobro.
  function vacForm(r, k) {
    const p = vacPeriodOf(r, k);
    const vac = p && isObj(p.vacation) ? p.vacation : null;
    if (!p) return { period: k, startsOn: '', endsOn: '', trips: '0' };
    if (vac) return { period: k, startsOn: vac.startsOn || '', endsOn: vac.endsOn || '', trips: String(num(vac.trips) || 0) };
    return { period: k, startsOn: p.periodStart || '', endsOn: p.periodEnd || '', trips: String(num(p.tripsBooked) || 0) };
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
  // La mensualidad por defecto ya no existe (30-sep): «todos tienen su propio valor».
  function settingsForm(s) {
    return { dueDays: s.dueDays != null ? String(s.dueDays) : '',
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
      + '<div class="cb-panel-h"><b>Valores por defecto de la organización</b><span>Los plazos que usa la cuenta de un tripulante cuando no tiene los suyos, y el titular de las cuentas. La mensualidad no va aquí: cada tripulante tiene su valor propio (o paga la de su sector, en «Tarifas por sector»).</span></div>'
      + '<div class="cb-grid">'
      + sf('Días para pagar', 'dueDays', { inputmode: 'numeric', hint: 'Desde el corte hasta la fecha límite.' })
      + sf('Aviso (días antes)', 'noticeDays', { inputmode: 'numeric', hint: '0 = sin recordatorio.' })
      + sf('Gracia (días)', 'graceDays', { inputmode: 'numeric', hint: 'Después de vencer, antes de pausar.' })
      + sf('Titular de las cuentas', 'holderName', { ph: 'Razón social' })
      + sf('NIT', 'holderNit')
      + '</div>'
      + '<div class="cb-ed-foot"><button class="set-btn" data-cb="s-save"' + (cb.busy ? ' disabled' : '') + '>Guardar</button></div>'
      + '</div>';
  }

  // «Tarifas por sector» (0094).
  function ratesHTML() {
    if (cb.rates === undefined) return '<div class="cb-panel"><div class="cb-empty sm">Cargando…</div></div>';
    if (cb.rates === null) return '<div class="cb-panel"><div class="cb-empty sm"><b>No pudimos cargar las tarifas por sector.</b><span>Puede que la base todavía no tenga las tarifas (0094).</span></div></div>';
    const d = cb.rates;
    const ss = Array.isArray(d.sectors) ? d.sectors.filter(isObj) : [];
    const none = num(d.crewWithoutSector) || 0, total = num(d.crewTotal) || 0;
    const inp = (k, f, v) => '<input class="set-input" data-cbt="' + f + '" data-k="' + esc(k) + '" inputmode="numeric" value="' + esc(v == null ? '' : v) + '" placeholder="Sin valor" autocomplete="off">';
    const rows = ss.map(s => {
      const k = skey(s.sector);
      const f = cb.rform[k] || { monthlyCOP: '', perTripCOP: '' };
      const origin = [num(s.residences) ? pl(num(s.residences), 'conjunto', 'conjuntos') : (s.fromResidences ? '' : 'Puesto a mano'),
        num(s.crewManual) ? pl(num(s.crewManual), 'asignado a mano', 'asignados a mano') : ''].filter(Boolean).join(' · ');
      // Con valor propio NO pagan esta mensualidad (0094): decirlo, y ofrecer
      // quitárselo a todos si el sector ya tiene mensualidad guardada.
      const own = num(s.crewOwn) || 0;
      const ownTxt = own ? pl(own, 'con valor propio', 'con valor propio') + ' (no ' + (own === 1 ? 'usa' : 'usan') + ' esta mensualidad)' : '';
      const useBtn = own && num(s.monthlyCOP) != null
        ? '<button class="set-btn ghost" data-cb="rate-use" data-k="' + esc(k) + '"' + (cb.busy ? ' disabled' : '') + '>Que paguen la del sector</button>' : '';
      return '<tr data-cb-sector="' + esc(k) + '"><td><b>' + esc(s.sector) + '</b>' + (origin ? '<em>' + esc(origin) + '</em>' : '') + '</td>'
        + '<td>' + esc(pl(num(s.crew) || 0, 'tripulante', 'tripulantes')) + (ownTxt ? '<em class="warn" data-cb-own>' + esc(ownTxt) + '</em>' : '') + '</td>'
        + '<td>' + inp(k, 'monthlyCOP', f.monthlyCOP) + '</td>'
        + '<td>' + inp(k, 'perTripCOP', f.perTripCOP) + '</td>'
        + '<td><button class="set-btn ghost" data-cb="rate-save" data-k="' + esc(k) + '"' + (cb.busy ? ' disabled' : '') + '>Guardar</button>' + useBtn + '</td></tr>';
    }).join('');
    const nf = cb.rnew || {};
    const newRow = '<tr class="cb-rate-new"><td><input class="set-input" data-cbt-new="sector" value="' + esc(nf.sector || '') + '" placeholder="Sector nuevo" autocomplete="off"></td><td>—</td>'
      + '<td><input class="set-input" data-cbt-new="monthlyCOP" inputmode="numeric" value="' + esc(nf.monthlyCOP || '') + '" placeholder="Mensualidad" autocomplete="off"></td>'
      + '<td><input class="set-input" data-cbt-new="perTripCOP" inputmode="numeric" value="' + esc(nf.perTripCOP || '') + '" placeholder="Por viaje" autocomplete="off"></td>'
      + '<td><button class="set-btn ghost" data-cb="rate-add"' + (cb.busy ? ' disabled' : '') + '>' + icon('i-plus') + 'Agregar</button></td></tr>';
    return '<div class="cb-panel">'
      + '<div class="cb-panel-h"><b>Tarifas por sector</b><span>La mensualidad del sector es la que paga quien vive ahí, salvo que su cuenta tenga un valor propio (las cuentas creadas antes de las tarifas casi todas lo tienen: el conteo lo dice). El valor por viaje es el de las vacaciones: ese cobro vale viajes × valor en vez de la mensualidad. Vacío = sin valor: nadie cobra con un valor inventado.</span></div>'
      + '<p class="cb-mini' + (none ? ' warn' : '') + '" data-cb-rates-sum>' + esc(pl(total, 'tripulante', 'tripulantes') + ' · ' + pl(none, 'sin sector', 'sin sector')
        + (none ? ': asígnaselo en su cuenta (Editar cuenta › Sector).' : '.')) + '</p>'
      + '<table class="cb-hist cb-rates"><thead><tr><th>Sector</th><th>Tripulantes</th><th>Mensualidad (COP)</th><th>Valor por viaje (COP)</th><th></th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="5" class="cb-empty-td">Las residencias todavía no tienen sector. Agrega uno abajo o ponle sector a cada conjunto.</td></tr>')
      + newRow + '</tbody></table>'
      + '<p class="cb-mini">Cambiar una tarifa no mueve las cuentas de cobro ya abiertas: rige desde el próximo corte. Las vacaciones ya marcadas guardan el valor por viaje de cuando se marcaron.</p>'
      + '</div>';
  }

  // «Balance» del mes (0094): lo que dice admin_billing_balance, sin recalcular estados.
  const BAL_STATE = (x) => (x.paid ? 'pagado' : x.comp === 'review' ? 'review' : x.blocked ? 'bloqueado'
    : x.comp === 'rejected' ? 'rejected' : (x.base || x.status || 'pendiente'));
  const stLabel = (k) => (TONES[k] || TONES.pendiente)[0];
  function balMonthLabel(b) { return monthLabel((isObj(b) && b.month) || balMonthNow() + '-01'); }
  function balHTML() {
    const b = cb.bal;
    const m = balMonthNow();
    let h = '<div class="cb-tools cb-bal-tools"><label class="cb-f"><span>Mes</span><input class="set-input" type="month" data-cbb="month" value="' + esc(m) + '" max="' + esc(hoyISO().slice(0, 7)) + '"></label>'
      + '<div class="cb-acts"><button class="set-btn" data-cb="bal-xlsx"' + (!isObj(b) || cb.busy ? ' disabled' : '') + '>' + icon('i-doc') + 'Descargar Excel</button>'
      + '<button class="set-btn ghost" data-cb="bal-reload">' + icon('i-refresh') + 'Refrescar</button></div></div>';
    if (b === undefined) return h + '<div class="cb-empty">Cargando el balance…</div>';
    if (b === null) return h + '<div class="cb-empty"><b>No pudimos cargar el balance.</b><span>Puede que la base todavía no tenga el balance (0094).</span><button class="set-btn ghost" data-cb="bal-reload">Reintentar</button></div>';
    const T = isObj(b.totals) ? b.totals : {};
    const rows = Array.isArray(b.rows) ? b.rows.filter(isObj) : [];
    const secs = Array.isArray(b.bySector) ? b.bySector.filter(isObj) : [];
    const pays = Array.isArray(b.payments) ? b.payments.filter(isObj) : [];
    const miss = Array.isArray(b.withoutStatement) ? b.withoutStatement.filter(isObj) : [];
    const n = (k) => num(T[k]) || 0;
    const kv = (lbl, val, sub, cls) => '<div data-cb-tot="' + esc(lbl) + '"><span>' + esc(lbl) + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(val) + '</b>' + (sub ? '<em>' + esc(sub) + '</em>' : '') + '</div>';
    h += '<div class="cb-panel cb-bal"><div class="cb-panel-h"><b>' + esc(balMonthLabel(b)) + (b.organizationName ? ' · ' + esc(b.organizationName) : '') + '</b>'
      + '<span>Las cuentas de cobro que se abrieron en el mes (corte entre el ' + esc(fmtDay(b.month)) + ' y el ' + esc(fmtDay(b.monthEnd)) + '). Cobrado = lo que quedó registrado en los pagos.</span></div>'
      + '<div class="cb-kvs cb-bal-kvs">'
      + kv('Facturado (bruto)', money(n('billedGrossCOP')), pl(n('statements'), 'cuenta de cobro', 'cuentas de cobro'))
      + kv('Descuentos', money(n('discountsCOP')))
      + kv('Neto a cobrar', money(n('netCOP')))
      + kv('Cobrado', money(n('collectedCOP')), pl(n('paidCount'), 'pagada', 'pagadas'))
      + kv('Pendiente', money(n('pendingCOP')), pl(n('pendingCount'), 'sin pagar', 'sin pagar'))
      + kv('En revisión', money(n('reviewCOP')), pl(n('reviewCount'), 'comprobante', 'comprobantes'))
      + kv('En mora', money(n('overdueCOP')), pl(n('overdueCount'), 'cuenta', 'cuentas') + ' (con las pausadas)', n('overdueCount') ? 'bad' : '')
      + kv('Pausadas', money(n('pausedCOP')), pl(n('pausedCount'), 'cuenta', 'cuentas'), n('pausedCount') ? 'bad' : '')
      + kv('Mensualidades', money(n('monthlyNetCOP')), pl(n('monthlyCount'), 'cuenta', 'cuentas'))
      + kv('Vacaciones', money(n('vacationsNetCOP')), pl(n('vacationsCount'), 'cuenta', 'cuentas') + ' · ' + n('vacationsTripsDeclared') + ' viajes declarados, ' + n('vacationsTripsBooked') + ' reservados')
      // 30-sep: se cobra la diferencia (la marca roja = «tiene extra», con cuánto).
      + kv('Tienen viajes extra', String(n('overBookedCount')), n('overBookedCount') ? pl(n('extraTrips'), 'viaje', 'viajes') + ' de más · ' + money(n('extraCOP')) : '', n('overBookedCount') ? 'bad' : '')
      + kv('Extra cobrado', money(n('extraBilledCOP')), 'Viajes de más que ya entraron en una cuenta')
      + kv('Extra pendiente', money(n('extraPendingCOP')), 'Entra en el próximo cobro', n('extraPendingCOP') ? 'bad' : '')
      + kv('Extra de cobros anteriores', money(n('extrasIncludedCOP')), pl(n('extrasIncludedCount'), 'cuenta lo incluye', 'cuentas lo incluyen'))
      + kv('Sin cuenta de cobro este mes', String(miss.length), num(b.withoutAccount) ? pl(num(b.withoutAccount), 'tripulante sin cuenta', 'tripulantes sin cuenta') : '')
      + ('withoutValue' in b ? kv('Sin valor cargado', String(num(b.withoutValue) || 0), num(b.withoutValue) ? pl(num(b.withoutValue), 'tripulante sin valor cargado', 'tripulantes sin valor cargado') + ': no se les abre cobro' : '', num(b.withoutValue) ? 'bad' : '') : '')
      + '</div></div>';
    // Por sector
    h += '<div class="cb-sec"><h2>Por sector</h2>' + (secs.length
      ? '<div class="cb-scroll"><table class="cb-hist cb-bal-sec"><thead><tr><th>Sector</th><th>Tripulantes</th><th>Cuentas</th><th>Neto</th><th>Cobrado</th><th>Pendiente</th><th>Vacaciones</th><th>Tarifa vigente</th></tr></thead><tbody>'
        + secs.map(s => '<tr><td><b>' + esc(s.sector || 'Sin sector') + '</b></td><td>' + esc(num(s.crew) || 0) + '</td><td>' + esc(num(s.statements) || 0) + '</td>'
          + '<td>' + esc(money(num(s.netCOP))) + '</td><td>' + esc(money(num(s.collectedCOP))) + '</td><td>' + esc(money(num(s.pendingCOP))) + '</td>'
          + '<td>' + esc(num(s.vacationsCount) || 0) + '</td>'
          + '<td>' + esc(s.sector ? [num(s.monthlyCOP) != null ? money(num(s.monthlyCOP)) + '/mes' : 'Sin mensualidad', num(s.perTripCOP) != null ? money(num(s.perTripCOP)) + '/viaje' : 'Sin valor por viaje'].join(' · ') : '—') + '</td></tr>').join('')
        + '</tbody></table></div>'
      : '<div class="cb-empty sm">Ninguna cuenta de cobro se abrió en este mes.</div>') + '</div>';
    // Por tripulante (30-sep: Declarados · Reservados · Cobrados · Extra cobrado · Extra pendiente)
    h += '<div class="cb-sec"><h2>Por tripulante <span class="sh-ct">' + rows.length + '</span></h2>' + (rows.length
      ? '<div class="cb-scroll"><table class="cb-hist cb-bal-rows"><thead><tr><th>Tripulante</th><th>Sector</th><th>Modalidad</th><th>Declarados</th><th>Reservados</th><th>Cobrados</th><th>Extra cobrado</th><th>Extra pendiente</th><th>Monto</th><th>Descuento</th><th>Neto</th><th>Estado</th><th>Pagó</th><th>Medio · aprobó</th><th>Días de mora</th></tr></thead><tbody>'
        + rows.map(x => {
          const vac = x.modality === 'vacaciones';
          const over = !!x.overBooked;
          const xb = num(x.extraBilledCOP) || 0, xp = num(x.extraPendingCOP) || 0, inc = num(x.extrasIncludedCOP) || 0;
          const extraTxt = over ? 'Tiene extra: ' + pl(num(x.extraTrips) || 0, 'viaje', 'viajes') + ' · ' + money(num(x.extraCOP)) : '';
          return '<tr data-cb-bal="' + esc(x.statementId || '') + '"' + (over ? ' class="over"' : '') + '><td><b>' + esc(x.name || 'Sin nombre') + '</b><em>' + esc([x.reference, fmtDay(x.periodStart) + ' – ' + fmtDay(x.periodEnd)].filter(Boolean).join(' · ')) + '</em></td>'
            + '<td>' + esc(x.sector || 'Sin sector') + '</td>'
            + '<td>' + (vac ? '<span class="cb-tag t-info">Vacaciones</span>' + (x.vacationStatus === 'cancelled' ? '<em>Canceladas después de pagar</em>' : '') : 'Mensual')
            + (over ? '<em class="cb-bad" data-cb-bal-extra title="Reservó más viajes de los que declaró">' + esc(extraTxt) + '</em>' : '') + '</td>'
            + '<td>' + esc(vac ? String(num(x.tripsDeclared) || 0) : '—') + '</td>'
            + '<td' + (over ? ' class="cb-bad"' : '') + '>' + esc(String(num(x.tripsBooked) || 0)) + '</td>'
            + '<td>' + esc(vac && num(x.tripsBilled) != null ? String(num(x.tripsBilled)) : '—') + '</td>'
            + '<td' + (xb ? ' class="cb-bad"' : '') + '>' + esc(vac ? money(xb) : '—') + '</td>'
            + '<td' + (xp ? ' class="cb-bad"' : '') + '>' + esc(vac ? money(xp) : '—') + '</td>'
            + '<td>' + esc(money(num(x.amountCOP))) + (inc ? '<em data-cb-bal-inc>Incluye ' + esc(money(inc)) + ' de viajes extra de un cobro anterior</em>' : '') + '</td>'
            + '<td>' + (num(x.discountCOP) ? esc(money(num(x.discountCOP))) + (x.discountNote ? '<em>' + esc(x.discountNote) + '</em>' : '') : '—') + '</td>'
            + '<td><b>' + esc(money(num(x.netCOP))) + '</b></td>'
            + '<td>' + tag(BAL_STATE(x)) + '</td>'
            + '<td>' + esc(x.paid ? fmtDay(x.paidOn) : '—') + '</td>'
            + '<td>' + esc(x.paid ? [x.paidViaLabel || (x.paidVia === 'manual' ? 'A mano' : 'Comprobante'), x.paidAutomatic ? 'Automático' : x.approvedBy].filter(Boolean).join(' · ') : '—') + '</td>'
            + '<td' + (num(x.daysLate) ? ' class="cb-bad"' : '') + '>' + esc(num(x.daysLate) || 0) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="cb-empty sm">Ninguna cuenta de cobro se abrió en este mes.</div>') + '</div>';
    // Sin cuenta de cobro este mes
    if (miss.length) {
      h += '<div class="cb-sec"><h2>Sin cuenta de cobro este mes <span class="sh-ct">' + miss.length + '</span></h2><div class="cb-methods">'
        + miss.map(x => '<div class="cb-method"><div><b>' + esc(x.name || 'Sin nombre') + '</b><span>' + esc([x.reference, x.sector || 'Sin sector',
          (typeof x.noValue === 'boolean' ? x.noValue : x.effectiveAmountCOP == null) ? 'Sin valor (ni propio ni del sector): no se le abre cobro' : x.cutPending ? 'Su corte es el ' + fmtDay(x.cutThisMonth) : 'Su corte (' + fmtDay(x.cutThisMonth) + ') todavía no abrió la cuenta: ¿corrió el reloj?'].filter(Boolean).join(' · ')) + '</span></div></div>').join('')
        + '</div></div>';
    }
    // Pagos
    h += '<div class="cb-sec"><h2>Comprobantes y pagos <span class="sh-ct">' + pays.length + '</span></h2>' + (pays.length
      ? '<div class="cb-scroll"><table class="cb-hist cb-bal-pays"><thead><tr><th>Fecha</th><th>Tripulante</th><th>Qué</th><th>Medio</th><th>Monto</th><th>Estado</th><th>Quién</th></tr></thead><tbody>'
        + pays.map(p => '<tr><td>' + esc(fmtDay(p.date)) + '</td><td>' + esc(p.name || '—') + '<em>' + esc(monthLabel(p.periodStart)) + '</em></td>'
          + '<td>' + esc(p.kind === 'proof' ? 'Comprobante' : 'Pago') + '</td><td>' + esc(p.viaLabel || '—') + '</td>'
          + '<td>' + esc(num(p.amountCOP) != null ? money(num(p.amountCOP)) : '—') + '</td>'
          + '<td>' + esc(payState(p)) + (p.rejectReason ? '<em>' + esc(p.rejectReason) + '</em>' : '') + '</td>'
          + '<td>' + esc(p.by || (p.kind === 'payment' ? 'Automático' : '—')) + '</td></tr>').join('')
        + '</tbody></table></div>'
      : '<div class="cb-empty sm">Sin comprobantes ni pagos de las cuentas de este mes.</div>') + '</div>';
    return h;
  }
  const payState = (p) => (p.kind === 'proof'
    ? (p.status === 'approved' ? 'Aprobado' : p.status === 'rejected' ? 'Rechazado' : 'En revisión')
    : p.automatic ? 'Saldado solo ($0)' : (p.status === 'manual' ? 'Marcado a mano' : 'Con comprobante'));

  // Excel del balance (window.ExcelJS; el patrón de admin-balance.js).
  async function balExcel() {
    const X = window.ExcelJS;
    if (!X || typeof X.Workbook !== 'function') { say('No se pudo cargar la librería de Excel. Revisa tu conexión y reintenta.'); return null; }
    const b = cb.bal; if (!isObj(b)) return null;
    const T = isObj(b.totals) ? b.totals : {};
    const rows = Array.isArray(b.rows) ? b.rows.filter(isObj) : [];
    const secs = Array.isArray(b.bySector) ? b.bySector.filter(isObj) : [];
    const pays = Array.isArray(b.payments) ? b.payments.filter(isObj) : [];
    const miss = Array.isArray(b.withoutStatement) ? b.withoutStatement.filter(isObj) : [];
    const mes = balMonthLabel(b);
    const wb = new X.Workbook();
    const border = { style: 'thin', color: { argb: 'FFDDDDDD' } };
    const AB = { top: border, bottom: border, left: border, right: border };
    const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
    const TOT = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    const VAC = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2ECFB' } };
    const PESOS = '"$" #,##0';
    const F = { name: 'Arial', size: 10 };
    const RED = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFB91C1C' } };
    const sello = 'Generado el ' + new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })
      + ' · cuentas de cobro que se abrieron entre el ' + fmtDay(b.month) + ' y el ' + fmtDay(b.monthEnd) + ' · estados calculados por la base';
    const titulo = (ws, ult, texto) => {
      ws.mergeCells('A1:' + ult + '1');
      const t1 = ws.getCell('A1'); t1.value = texto;
      t1.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } }; t1.fill = HEAD; t1.alignment = { vertical: 'middle' };
      ws.getRow(1).height = 26;
      ws.mergeCells('A2:' + ult + '2');
      const t2 = ws.getCell('A2'); t2.value = sello;
      t2.font = { name: 'Arial', size: 9, color: { argb: 'FF555555' } }; t2.alignment = { vertical: 'middle', wrapText: true };
      ws.getRow(2).height = 18;
    };
    const headRow = (ws, n, hs) => {
      hs.forEach((h, i) => { const c = ws.getRow(n).getCell(i + 1); c.value = h; c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD; c.alignment = { vertical: 'middle', wrapText: true }; c.border = AB; });
      ws.getRow(n).height = 28;
    };
    // money: índices (0-based) de columnas en pesos.
    const dataRow = (ws, n, vals, money, o) => {
      o = o || {};
      const rr = ws.getRow(n);
      vals.forEach((v, i) => {
        const c = rr.getCell(i + 1);
        c.value = v == null ? '' : v;
        c.font = o.bold ? { name: 'Arial', size: 10, bold: true } : F;
        if (money.indexOf(i) >= 0) { c.numFmt = PESOS; c.alignment = { vertical: 'middle', horizontal: 'right' }; }
        else c.alignment = { vertical: 'middle', wrapText: true };
        c.border = AB;
        if (o.fill) c.fill = o.fill;
      });
      return rr;
    };
    const sumCell = (c, col, from, to, v) => { c.value = to >= from ? { formula: 'SUM(' + col + from + ':' + col + to + ')', result: v } : 0; c.numFmt = PESOS; };
    const n = (k) => num(T[k]) || 0;

    // ---- Hoja 1: Resumen ----
    const ws1 = wb.addWorksheet('Resumen', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws1.columns = [{ width: 40 }, { width: 18 }, { width: 16 }, { width: 44 }];
    titulo(ws1, 'D', 'Cuentas de cobro · ' + mes + (b.organizationName ? ' · ' + b.organizationName : ''));
    headRow(ws1, 3, ['Concepto', 'Valor', 'Cuentas', 'Nota']);
    const R1 = [
      ['Facturado (bruto)', n('billedGrossCOP'), n('statements'), 'Monto de las cuentas de cobro abiertas en el mes'],
      ['Descuentos', n('discountsCOP'), null, 'Canjes de puntos y ajustes'],
      ['Neto a cobrar', n('netCOP'), n('statements'), ''],
      ['Cobrado', n('collectedCOP'), n('paidCount'), 'Lo que quedó registrado en los pagos'],
      ['Pendiente', n('pendingCOP'), n('pendingCount'), 'Neto sin pagar (incluye revisión y mora)'],
      ['En revisión', n('reviewCOP'), n('reviewCount'), 'Con comprobante esperando aprobación'],
      ['En mora', n('overdueCOP'), n('overdueCount'), 'Vencidas o pausadas, sin pagar'],
      ['Pausadas', n('pausedCOP'), n('pausedCount'), 'Reservas nuevas frenadas'],
      ['Mensualidades', n('monthlyNetCOP'), n('monthlyCount'), ''],
      ['Vacaciones', n('vacationsNetCOP'), n('vacationsCount'), 'Viajes × valor por viaje del sector (max. de declarados y reservados)'],
      // 30-sep: se cobra la diferencia.
      ['Viajes extra cobrados', n('extraBilledCOP'), null, 'Viajes de vacaciones de más que ya entraron en una cuenta'],
      ['Viajes extra pendientes', n('extraPendingCOP'), null, 'Entran en el próximo cobro de cada tripulante'],
      ['Viajes extra de cobros anteriores', n('extrasIncludedCOP'), n('extrasIncludedCount'), 'Ya incluidos en el monto de estas cuentas'],
    ];
    let r = 4;
    R1.forEach(v => {
      const rr = dataRow(ws1, r++, v, [1]);
      if (v[0] === 'Viajes extra pendientes' && v[1]) rr.getCell(2).font = RED;
    });
    [['Viajes declarados en vacaciones', n('vacationsTripsDeclared')], ['Viajes reservados en esos cobros', n('vacationsTripsBooked')],
      ['Tienen viajes extra', n('overBookedCount')], ['Viajes de más (cobrados o pendientes)', n('extraTrips')],
      ['Sin cuenta de cobro este mes', miss.length],
      ['Tripulantes sin cuenta de cobro', num(b.withoutAccount) || 0],
      ...('withoutValue' in b ? [['Tripulantes sin valor cargado', num(b.withoutValue) || 0]] : [])].forEach(([k, v]) => {
      const rr = dataRow(ws1, r++, [k, v, null, k === 'Tripulantes sin valor cargado' ? 'Sin valor propio ni del sector: no se les abre cobro' : ''], []);
      rr.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
      if ((k === 'Tienen viajes extra' || k === 'Tripulantes sin valor cargado') && v) rr.getCell(2).font = RED;
    });

    // ---- Hoja 2: Por tripulante ----
    // 30-sep: Declarados · Reservados · Cobrados · Extra cobrado · Extra pendiente.
    const ws2 = wb.addWorksheet('Por tripulante', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws2.columns = [{ width: 28 }, { width: 11 }, { width: 18 }, { width: 13 }, { width: 22 }, { width: 11 }, { width: 11 }, { width: 11 },
      { width: 13 }, { width: 13 }, { width: 11 }, { width: 13 }, { width: 16 }, { width: 12 }, { width: 24 }, { width: 13 }, { width: 14 },
      { width: 12 }, { width: 12 }, { width: 20 }, { width: 13 }, { width: 22 }, { width: 10 }];
    titulo(ws2, 'W', 'Por tripulante · ' + mes);
    headRow(ws2, 3, ['Tripulante', 'Referencia', 'Sector', 'Modalidad', 'Período', 'Declarados', 'Reservados', 'Cobrados',
      'Extra cobrado', 'Extra pendiente', '¿Tiene extra?', 'Monto', 'Incluye extra de cobros anteriores', 'Descuento', 'Motivo del descuento',
      'Neto', 'Estado', 'Vence', 'Pagó el', 'Medio', 'Monto pagado', 'Aprobó', 'Días de mora']);
    r = 4;
    const MON2 = [8, 9, 11, 12, 13, 15, 20];
    rows.forEach(x => {
      const vac = x.modality === 'vacaciones';
      const rr = dataRow(ws2, r++, [x.name || 'Sin nombre', x.reference || '', x.sector || 'Sin sector', vac ? (x.vacationStatus === 'cancelled' ? 'Vacaciones (canceladas después de pagar)' : 'Vacaciones') : 'Mensual',
        fmtDay(x.periodStart) + ' – ' + fmtDay(x.periodEnd), vac ? num(x.tripsDeclared) || 0 : '', num(x.tripsBooked) || 0,
        vac && num(x.tripsBilled) != null ? num(x.tripsBilled) : '', vac ? num(x.extraBilledCOP) || 0 : '', vac ? num(x.extraPendingCOP) || 0 : '',
        x.overBooked ? 'Sí: ' + pl(num(x.extraTrips) || 0, 'viaje', 'viajes') : 'No',
        num(x.amountCOP) || 0, num(x.extrasIncludedCOP) || 0, num(x.discountCOP) || 0, x.discountNote || '', num(x.netCOP) || 0, stLabel(BAL_STATE(x)), fmtDay(x.dueDate),
        x.paid ? fmtDay(x.paidOn) : '', x.paid ? (x.paidViaLabel || (x.paidVia === 'manual' ? 'A mano' : 'Comprobante')) : '',
        x.paid && num(x.paidAmountCOP) != null ? num(x.paidAmountCOP) : '', x.paid ? (x.paidAutomatic || !x.approvedBy ? 'Automático' : x.approvedBy) : '', num(x.daysLate) || 0],
        MON2, vac ? { fill: VAC } : {});
      if (x.overBooked) { rr.getCell(7).font = RED; rr.getCell(11).font = RED; }
      if (num(x.extraPendingCOP)) rr.getCell(10).font = RED;
      if (num(x.daysLate)) rr.getCell(23).font = RED;
    });
    const last2 = r - 1;
    const t2 = dataRow(ws2, r, ['Total', '', '', '', '', '', '', '', null, null, '', null, null, null, '', null, '', '', '', '', null, '', ''], MON2, { bold: true, fill: TOT });
    sumCell(t2.getCell(9), 'I', 4, last2, n('extraBilledCOP'));
    sumCell(t2.getCell(10), 'J', 4, last2, n('extraPendingCOP'));
    sumCell(t2.getCell(12), 'L', 4, last2, n('billedGrossCOP'));
    sumCell(t2.getCell(13), 'M', 4, last2, n('extrasIncludedCOP'));
    sumCell(t2.getCell(14), 'N', 4, last2, n('discountsCOP'));
    sumCell(t2.getCell(16), 'P', 4, last2, n('netCOP'));
    sumCell(t2.getCell(21), 'U', 4, last2, n('collectedCOP'));

    // ---- Hoja 3: Por sector ----
    const ws3 = wb.addWorksheet('Por sector', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws3.columns = [{ width: 24 }, { width: 12 }, { width: 11 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 12 }, { width: 18 }, { width: 18 }];
    titulo(ws3, 'I', 'Por sector · ' + mes);
    headRow(ws3, 3, ['Sector', 'Tripulantes', 'Cuentas', 'Neto', 'Cobrado', 'Pendiente', 'Vacaciones', 'Mensualidad vigente', 'Valor por viaje vigente']);
    r = 4;
    secs.forEach(s => {
      dataRow(ws3, r++, [s.sector || 'Sin sector', num(s.crew) || 0, num(s.statements) || 0, num(s.netCOP) || 0, num(s.collectedCOP) || 0, num(s.pendingCOP) || 0,
        num(s.vacationsCount) || 0, num(s.monthlyCOP) != null ? num(s.monthlyCOP) : 'Sin valor', num(s.perTripCOP) != null ? num(s.perTripCOP) : 'Sin valor'], [3, 4, 5, 7, 8]);
    });
    const last3 = r - 1;
    const t3 = dataRow(ws3, r, ['Total', null, null, null, null, null, null, '', ''], [3, 4, 5], { bold: true, fill: TOT });
    t3.getCell(2).value = secs.reduce((a, s) => a + (num(s.crew) || 0), 0);
    t3.getCell(3).value = secs.reduce((a, s) => a + (num(s.statements) || 0), 0);
    sumCell(t3.getCell(4), 'D', 4, last3, n('netCOP'));
    sumCell(t3.getCell(5), 'E', 4, last3, n('collectedCOP'));
    sumCell(t3.getCell(6), 'F', 4, last3, n('pendingCOP'));
    t3.getCell(7).value = secs.reduce((a, s) => a + (num(s.vacationsCount) || 0), 0);

    // ---- Hoja 4: Pagos ----
    const ws4 = wb.addWorksheet('Pagos', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws4.columns = [{ width: 12 }, { width: 14 }, { width: 28 }, { width: 11 }, { width: 16 }, { width: 20 }, { width: 14 }, { width: 18 }, { width: 28 }, { width: 22 }, { width: 30 }];
    titulo(ws4, 'K', 'Comprobantes y pagos · ' + mes);
    headRow(ws4, 3, ['Fecha', 'Qué', 'Tripulante', 'Referencia', 'Cobro de', 'Medio', 'Monto', 'Estado', 'Motivo del rechazo', 'Quién', 'Nota']);
    r = 4;
    pays.forEach(p => {
      dataRow(ws4, r++, [fmtDay(p.date), p.kind === 'proof' ? 'Comprobante' : 'Pago', p.name || '', p.reference || '', monthLabel(p.periodStart),
        p.viaLabel || '', num(p.amountCOP) != null ? num(p.amountCOP) : '', payState(p), p.rejectReason || '', p.by || (p.kind === 'payment' ? 'Automático' : ''), p.note || ''], [6]);
    });

    const buf = await wb.xlsx.writeBuffer();
    const file = 'cuentas_de_cobro_' + String(b.month || balMonthNow()).slice(0, 7) + '.xlsx';
    cb.xlsx = { file, buf };
    try {
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) { /* */ } }, 1000);
    } catch (e) { say('No se pudo descargar el Excel: ' + ((e && e.message) || 'error del navegador')); return null; }
    return cb.xlsx;
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
      + '<button class="set-btn ghost' + (cb.panel === 'rates' ? ' on' : '') + '" data-cb="panel" data-v="rates">Tarifas por sector</button>'
      + '<button class="set-btn ghost' + (cb.panel === 'settings' ? ' on' : '') + '" data-cb="panel" data-v="settings">Valores por defecto</button>'
      + '<button class="set-btn ghost" data-cb="reload">' + icon('i-refresh') + 'Refrescar</button></div></div>'
      // 0094: las cuentas o el balance del mes (los filtros en píldora de siempre).
      + '<div class="cb-filters cb-views"><button class="' + (cb.view !== 'balance' ? 'on' : '') + '" data-cb="view" data-v="cuentas">Cuentas</button>'
      + '<button class="' + (cb.view === 'balance' ? 'on' : '') + '" data-cb="view" data-v="balance">Balance del mes</button></div>'
      + clockHTML();
    if (cb.panel === 'methods') h += methodsHTML();
    else if (cb.panel === 'rates') h += ratesHTML();
    else if (cb.panel === 'settings') h += settingsHTML();
    if (!api()) {
      h += '<div class="cb-empty"><b>El facturario no está disponible en esta versión.</b></div></div>';
      r.innerHTML = h; return;
    }
    if (cb.view === 'balance') { h += balHTML() + '</div>'; r.innerHTML = h; return; }
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
      cb.form.sector = r.manualSector || '';
      if (cb.settings === undefined) {
        const a = api();
        if (a) tryCall(() => a.adminSettings()).then(x => { cb.settings = x.e ? null : (isObj(x.v) ? x.v : null); if (cb.open === aux && cb.mode === 'edit' && !typing()) paint(); });
      }
      // Las tarifas (para la lista de sectores y el «vacío = la del sector»).
      if ('sector' in r && cb.rates === undefined) {
        loadRates().then(() => { if (cb.open === aux && cb.mode === 'edit') { if (typing()) patchEditHints(); else paint(); } });
      }
    } else if (mode === 'vac') {
      // Abre en el cobro que tiene vacaciones; si ninguno, en el primero que se pueda cambiar.
      const v = vacOfRow(r);
      const k = hasVac(v.cur) ? 'current' : hasVac(v.next) ? 'next'
        : admCan(v.cur) ? 'current' : v.next ? 'next' : 'current';
      cb.form = vacForm(r, k);
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
    // 0094 / 30-sep: vacío vale solo si su sector (el escrito o el de su
    // residencia) tiene mensualidad. La de la organización ya no cuenta.
    const conSector = !!r && 'sector' in r;
    const secNow = String(f.sector || '').trim();
    const secBefore = String((r && r.manualSector) || '').trim();
    const secChanged = conSector && skey(secNow) !== skey(secBefore);
    const secRate = conSector ? rateFor(secNow || r.residenceSector) : null;
    // Sin 0094 (filas sin sector) manda lo que diga la base del monto efectivo,
    // salvo que lo efectivo fuera el propio que se está borrando.
    const acc0 = r && isObj(r.account) ? r.account : null;
    const hasEff = !conSector && !!acc0 && acc0.effectiveAmountCOP != null && acc0.amountCOP == null;
    if (amount == null && f.active !== false && !hasEff && !(secRate && secRate.monthlyCOP != null)) {
      say(conSector ? 'Falta el valor: escribe su valor propio (o carga la mensualidad de su sector en «Tarifas por sector»)' : 'Falta la mensualidad: escribe el monto');
      return;
    }
    if (secNow.length > 80) { say('El nombre del sector es muy largo (máximo 80)'); return; }
    if (amount != null && amount <= 0) { say('La mensualidad tiene que ser mayor que cero'); return; }
    const cut = digits(f.cutDay);
    if (cut != null && (cut < 1 || cut > 31)) { say('El día de corte va de 1 a 31'); return; }
    for (const k of ['dueDays', 'noticeDays', 'graceDays']) { const d = digits(f[k]); if (d != null && d > 28) { say('Los plazos van de 0 a 28 días'); return; } }
    const a = api(); if (!a) return;
    const ok = await run(aux, async () => {
      await a.adminSaveAccount(aux, {
        amountCOP: amount, cutDay: cut, dueDays: digits(f.dueDays), noticeDays: digits(f.noticeDays), graceDays: digits(f.graceDays),
        active: f.active !== false, amountNextCOP: digits(f.amountNextCOP), startsOn: f.startsOn || null,
      });
      // El sector va aparte (necesita la cuenta creada).
      if (secChanged) {
        if (typeof a.adminSetSector !== 'function') throw new Error('La cuenta quedó guardada, pero esta versión no guarda el sector');
        await a.adminSetSector(aux, secNow || null);
      }
    }, 'Cuenta guardada');
    if (ok) { cb.open = null; cb.mode = null; if (secChanged) cb.rates = undefined; loadAll(false); }
  }
  // Vacaciones marcadas por el jefe (0094).
  async function saveVac(aux) {
    const r = rowOf(aux); if (!r) return;
    const f = cb.form;
    const trips = digits(f.trips);
    if (!parts(f.startsOn) || !parts(f.endsOn)) { say('Faltan las fechas de las vacaciones'); return; }
    if (f.startsOn > f.endsOn) { say('Revisa las fechas: el regreso no puede ser antes de la salida'); return; }
    if (trips == null || trips > 200) { say('Los viajes van de 0 a 200'); return; }
    const a = api(); if (!a || typeof a.adminSetVacation !== 'function') return;
    const res = await run(aux, () => a.adminSetVacation(aux, { period: f.period === 'next' ? 'next' : 'current', startsOn: f.startsOn, endsOn: f.endsOn, trips }));
    if (!res) return;
    const v = isObj(res) && isObj(res.vacation) ? res.vacation : null;
    say((v ? 'Vacaciones marcadas: ' + vacLine(v) : 'Vacaciones marcadas') + (isObj(res) && res.reopened ? ' · el cobro se reabrió' : ''));
    cb.open = null; cb.mode = null; loadAll(false);
  }
  async function cancelVac(aux, period) {
    const r = rowOf(aux); if (!r) return;
    const p = vacPeriodOf(r, period);
    const vac = p && isObj(p.vacation) ? p.vacation : null;
    if (!vac) return;
    if (typeof window.confirm === 'function' && !window.confirm('¿Cancelar las vacaciones de ' + (r.name || 'este tripulante') + '? '
      + (p.statementZero ? 'Ese cobro quedó saldado solo en $0: se reabre con la mensualidad y hay que pagarlo.'
        : p.statementPaid ? 'Ese cobro ya está pagado: su monto no cambia (sigue como cobro de vacaciones).'
        : 'Ese cobro vuelve a la mensualidad.'))) return;
    const a = api(); if (!a || typeof a.adminCancelVacation !== 'function') return;
    const ok = await run(aux, () => a.adminCancelVacation(aux, period), 'Vacaciones canceladas');
    if (ok) { cb.open = null; cb.mode = null; loadAll(false); }
  }
  // Tarifas por sector (0094). Los dos vacíos = se borra la tarifa.
  function rateVals(f) {
    const m = digits(f.monthlyCOP), p = digits(f.perTripCOP);
    if ((m != null && (m <= 0 || m > 10000000)) || (p != null && (p <= 0 || p > 10000000))) { say('Los valores van de $1 a $10.000.000'); return null; }
    return { monthlyCOP: m, perTripCOP: p };
  }
  async function saveRate(k) {
    const s = isObj(cb.rates) && Array.isArray(cb.rates.sectors) ? cb.rates.sectors.find(x => isObj(x) && skey(x.sector) === k) : null;
    if (!s) return;
    const v = rateVals(cb.rform[k] || {}); if (!v) return;
    const a = api(); if (!a || typeof a.adminSaveSectorRate !== 'function') return;
    const gone = v.monthlyCOP == null && v.perTripCOP == null;
    const ok = await run('r', () => a.adminSaveSectorRate(s.sector, v), gone ? 'Tarifa de ' + s.sector + ' borrada' : 'Tarifa de ' + s.sector + ' guardada');
    if (ok) { await loadRates(); paint(); loadAll(true); }
  }
  // «Que paguen la del sector» (0094): quita el valor propio a todos los de ese
  // sector. Rige desde el próximo corte (las cuentas de cobro abiertas no cambian).
  async function useRate(k) {
    const s = isObj(cb.rates) && Array.isArray(cb.rates.sectors) ? cb.rates.sectors.find(x => isObj(x) && skey(x.sector) === k) : null;
    if (!s || num(s.monthlyCOP) == null) return;
    const own = num(s.crewOwn) || 0;
    const a = api(); if (!a || typeof a.adminUseSectorRate !== 'function') return;
    if (typeof window.confirm === 'function' && !window.confirm('¿Quitar el valor propio a ' + pl(own, 'tripulante', 'tripulantes') + ' de ' + s.sector
      + '? Desde su próximo corte pagan la del sector: ' + money(num(s.monthlyCOP)) + '. Las cuentas de cobro ya abiertas no cambian.')) return;
    const r = await run('r', () => a.adminUseSectorRate(s.sector));
    if (!r) return;
    const n = isObj(r) ? num(r.cleared) : null;
    say(n == null ? 'Listo: pagan la del sector desde su próximo corte'
      : n === 0 ? 'Nadie de ' + s.sector + ' tenía valor propio'
      : pl(n, 'cuenta', 'cuentas') + ' de ' + s.sector + (n === 1 ? ' pasa' : ' pasan') + ' a la del sector desde su próximo corte');
    await loadRates(); paint(); loadAll(true);
  }
  async function addRate() {
    const f = cb.rnew || {};
    const name = String(f.sector || '').trim();
    if (!name) { say('Escribe el nombre del sector'); return; }
    if (name.length > 80) { say('El nombre del sector es muy largo (máximo 80)'); return; }
    const v = rateVals(f); if (!v) return;
    if (v.monthlyCOP == null && v.perTripCOP == null) { say('Escribe la mensualidad o el valor por viaje'); return; }
    const a = api(); if (!a || typeof a.adminSaveSectorRate !== 'function') return;
    const ok = await run('r', () => a.adminSaveSectorRate(name, v), 'Tarifa de ' + name + ' guardada');
    if (ok) { cb.rnew = { sector: '', monthlyCOP: '', perTripCOP: '' }; await loadRates(); paint(); loadAll(true); }
  }
  async function excelAct() {
    if (cb.busy) return;
    cb.busy = 'x';
    let r = null;
    try { r = await balExcel(); } catch (e) { say('No se pudo armar el Excel: ' + ((e && e.message) || 'error')); }
    cb.busy = null;
    if (r) say('Excel listo: ' + r.file);
    paint();
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
    for (const k of ['dueDays', 'noticeDays', 'graceDays']) { const d = digits(f[k]); if (d != null && d > 28) { say('Los plazos van de 0 a 28 días'); return; } }
    const a = api(); if (!a) return;
    const ok = await run('s', () => a.adminSaveSettings({
      dueDays: digits(f.dueDays), noticeDays: digits(f.noticeDays), graceDays: digits(f.graceDays),
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
      case 'reload': cb.urls = {}; loadAll(false); if (cb.panel) loadPanel(); if (cb.view === 'balance') { cb.bal = undefined; loadBal(); } break;
      case 'filter': cb.filter = el.getAttribute('data-v') || 'todos'; paint(); break;
      case 'panel': {
        const v = el.getAttribute('data-v');
        cb.panel = cb.panel === v ? null : v;
        cb.mform = null; cb.sform = null;
        if (cb.panel === 'methods') cb.methods = undefined;
        if (cb.panel === 'settings') cb.settings = undefined;
        if (cb.panel === 'rates') cb.rates = undefined;
        paint(); if (cb.panel) loadPanel();
        break;
      }
      case 'view': {
        const v = el.getAttribute('data-v') === 'balance' ? 'balance' : 'cuentas';
        if (v === cb.view) break;
        cb.view = v; cb.open = null; cb.mode = null;
        paint();
        if (v === 'balance' && cb.bal === undefined) loadBal();
        break;
      }
      case 'bal-reload': cb.bal = undefined; loadBal(); break;
      case 'bal-xlsx': excelAct(); break;
      case 'save-vac': saveVac(aux); break;
      case 'vac-cancel': cancelVac(aux, el.getAttribute('data-p') === 'next' ? 'next' : 'current'); break;
      case 'rate-save': saveRate(el.getAttribute('data-k')); break;
      case 'rate-add': addRate(); break;
      case 'rate-use': useRate(el.getAttribute('data-k')); break;
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
    if (t.hasAttribute('data-cbf')) {
      const k = t.getAttribute('data-cbf');
      cb.form[k] = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'sector' && cb.mode === 'edit') { patchEditHints(); return; }
      // Vacaciones: cambiar el cobro trae sus fechas; los viajes recalculan en vivo.
      if (cb.mode === 'vac' && cb.open) {
        const r = rowOf(cb.open);
        if (k === 'period' && r && e.type === 'change') { cb.form = vacForm(r, t.value === 'next' ? 'next' : 'current'); paint(); return; }
        const calc = r && t.closest('.cb-ed') && t.closest('.cb-ed').querySelector('[data-cb-vac-calc]');
        if (calc) calc.textContent = vacCalcText(r);
      }
      return;
    }
    if (t.hasAttribute('data-cbt')) {
      const k = t.getAttribute('data-k');
      cb.rform[k] = cb.rform[k] || { monthlyCOP: '', perTripCOP: '' };
      cb.rform[k][t.getAttribute('data-cbt')] = t.value;
      return;
    }
    if (t.hasAttribute('data-cbt-new')) { cb.rnew = cb.rnew || {}; cb.rnew[t.getAttribute('data-cbt-new')] = t.value; return; }
    if (t.hasAttribute('data-cbb')) {
      // El mes del balance: se pide al confirmar el campo (change), no en cada tecla.
      if (e.type !== 'change') return;
      const m = /^(\d{4})-(\d{2})$/.exec(String(t.value || ''));
      if (!m || m[0] === balMonthNow()) return;
      cb.balMonth = m[0]; cb.bal = undefined;
      loadBal();
      return;
    }
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
