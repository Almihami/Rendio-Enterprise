// aux-rx-pagos.js — P12b · Pagos del tripulante (rediseño del auxiliar, 27-sep-2026).
//
// Porta del diseño (entrega del 27-sep, cobro-aux2-pay.jsx + cobro-aux.jsx +
// cobro-engine.jsx + rx-home.jsx + rx-me.jsx), con el MISMO marcado y las MISMAS
// clases:
//   · Cb2Pay      → pestaña «pay» (Este mes / Historial, anillo, línea de tiempo,
//                   comprobante, cómo pagar, botón flotante, toast de copiar);
//   · Cb2Ring, Cb2Timeline, Cb2Tracker → piezas de «Este mes»;
//   · Cb2Upload   → pantalla «upload» (modal, 3 pasos + enviado) con la cámara y
//                   la galería REALES: <input type=file accept="image/*,application/pdf" capture>;
//   · Cb2Party    → la fiesta cuando el cobro queda pagado (se monta en .rx-app);
//   · RxCobroStrip → franja de Inicio, por AuxShell.hook('home.strip');
//   · cbBanner    → los textos de la franja, con el mes y la fecha reales.
// Y los avisos de cobro entran a Notificaciones por AuxShell.hook('avisos.source').
//
// Todo sale de la BASE (0090, window.ApiCobro): sin mensualidad cargada por el
// jefe la pestaña dice «Todavía no tienes mensualidad registrada». Nunca un monto,
// una cuenta bancaria, un titular ni un NIT inventados: si el jefe no los cargó,
// se dice que no están cargados.
//
// Contrato (AJUSTES §8):
//   window.AuxPagos = { summary() → null | {status, amountCOP, dueISO, blockISO, label, …},
//                       paused() → bool, refresh({force}) → Promise, cbBanner(sim, cfg, dates) }
//   summary().status = la precedencia de cbBanner: 'review' | 'rejected' | base
//   ('pendiente'|'porVencer'|'venceHoy'|'vencido'|'bloqueado'|'pagado').
//   summary() y paused() son síncronos: leen lo último que se trajo y, si está
//   viejo (60 s), piden de nuevo por detrás; al llegar algo distinto, AuxShell.render().
//
// Animaciones con total lineamiento (ANIMACIONES §4/§5): entradas .cb2-in con el
// mismo --d; se RECREAN (AuxRxUI.remount → .rx-anim) cb2-body key={view},
// cb2-acc key={how}, cb2-body key={step} y la cifra del anillo key={String(big)};
// toast de copiar 1500 ms (key={toast}); flash 260 ms; «Enviando…» dura lo que
// dure la subida real con el mismo spinner; la fiesta y el visto se montan nuevos.
// Los cambios de datos con la pantalla arriba se aplican EN SU LUGAR (patch), así
// corren las transiciones del anillo (.9 s) y de la barra (.7 s) como en React.
//
// Acciones data-rx propias (prefijo pg-): pg-view, pg-how, pg-copy, pg-hist,
// pg-upload, pg-retry, pg-up-back, pg-up-close, pg-up-via, pg-up-cam, pg-up-gal,
// pg-up-retake, pg-up-next, pg-up-send, pg-up-done. Sin nombres globales: IIFE.
(function () {
  'use strict';

  const TTL = 60000;          // cuenta vieja → se vuelve a pedir (el refresco del shell es de 60 s)
  const COPY_MS = 1500;       // cobro-aux2-pay.jsx:51 — toast de copiar
  const FLASH_MS = 260;       // cobro-aux2-pay.jsx:108 — flash de la cámara
  const ENTER_FRESH_MS = 5000; // entrar a Pagos vuelve a pedir la cuenta si tiene más de 5 s
  const LS_SEEN = 'rendio.aux.pagos.sinpagar';
  const R = 46, CIRC = 2 * Math.PI * R;
  const MAX_BYTES = 10 * 1024 * 1024;

  const UI = () => window.AuxRxUI || null;
  const SH = () => window.AuxShell || null;
  const AX = () => window.Auxiliar || null;
  const API = () => window.ApiCobro || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  // El arnés de pruebas (AuxEscenarios) deja cada función de ApiCobro devolviendo
  // una promesa de null: todo lo que llega se valida como objeto de verdad.
  const isObj = (v) => !!v && typeof v === 'object' && typeof v.then !== 'function' && !Array.isArray(v);
  const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ic(n, s) {
    const u = UI(); if (u && u.ic) return u.ic(n, s);
    const sh = SH(); return sh && sh.ic ? sh.ic(n, s) : '';
  }
  function shellOn() { const sh = SH(); return !!(sh && typeof sh.on === 'function' && safe(() => sh.on(), false)); }
  function profile() { const a = AX(); return (a && a.state && a.state.profile) || null; }

  // ── Formato: el de cobro-engine.jsx (cbMoney, cbFmt, cbPl), idéntico a ApiCobro ──
  // Propio y no el de ApiCobro: el arnés reemplaza TODAS sus funciones (también las
  // de formato) por promesas de null.
  const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const parts = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  };
  function money(n) {
    if (n == null || !isFinite(n)) return '';
    return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function fmtDay(iso) { const p = parts(iso); return p ? p.d + ' de ' + MES_CORTO[p.mo - 1] : ''; }
  function monthName(iso, cap) {
    const p = parts(iso); if (!p) return '';
    const s = MES[p.mo - 1];
    return cap ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function monthLabel(iso) { const p = parts(iso); return p ? monthName(iso, true) + ' ' + p.y : ''; }
  const pl = (n, s, p) => n + ' ' + (n === 1 ? s : p);
  function addDays(iso, n) {
    const p = parts(iso); if (!p || n == null) return null;
    return new Date(Date.UTC(p.y, p.mo - 1, p.d + n)).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const x = parts(a), y = parts(b); if (!x || !y) return null;
    return Math.round((Date.UTC(y.y, y.mo - 1, y.d) - Date.UTC(x.y, x.mo - 1, x.d)) / 86400e3);
  }

  // CB_STATUS de cobro-engine.jsx, tal cual.
  const CB_STATUS = {
    pendiente: { label: 'Pendiente', tone: 'neutral' },
    porVencer: { label: 'Por vencer', tone: 'hotel' },
    venceHoy: { label: 'Vence hoy', tone: 'hotel' },
    vencido: { label: 'En mora', tone: 'error' },
    bloqueado: { label: 'Bloqueado', tone: 'block' },
    review: { label: 'Por revisar', tone: 'info' },
    pagado: { label: 'Al día', tone: 'a2h' },
  };
  // Íconos de CB_ALERTS (los textos los escribe la base, billing_alert_text).
  const ALERT_ICON = {
    generado: 'FileText', recordatorio: 'Clock', venceHoy: 'AlertTriangle', vencido: 'AlertTriangle',
    ultimoDia: 'AlertTriangle', bloqueado: 'Lock', recibido: 'Send', aprobado: 'Check', rechazado: 'X',
  };

  // ── Datos ────────────────────────────────────────────────────────────────
  // acc: undefined = aún no se sabe · null = sin mensualidad · objeto = myAccount().
  const S = { pid: null, acc: undefined, err: null, at: 0, loading: null, methods: [], alerts: [], hist: null, histErr: false, sig: '', partyPending: null };
  let kickQueued = false;

  function resetIfOther() {
    const p = profile();
    const pid = p && p.id ? String(p.id) : null;
    if (pid === S.pid) return;
    S.pid = pid; S.acc = undefined; S.err = null; S.at = 0; S.methods = []; S.alerts = []; S.hist = null; S.histErr = false; S.sig = '';
    S.partyPending = null; S.loading = null;   // lo que venía en camino era de la otra sesión
  }
  // Pide la cuenta por detrás si está vieja. Solo con el rediseño encendido y un
  // tripulante adentro (la pausa la hace cumplir la base igual, con o sin esto).
  function kick() {
    resetIfOther();                         // otra sesión (o ninguna): lo de antes no vale
    if (kickQueued || !shellOn() || !profile()) return;
    if (S.loading || (S.at && Date.now() - S.at < TTL)) return;
    kickQueued = true;
    setTimeout(() => { kickQueued = false; load().catch(() => {}); }, 0);
  }
  async function tryCall(fn) {
    if (typeof fn !== 'function') return { v: null };
    try { return { v: await fn() }; } catch (e) { return { e }; }
  }
  function load(o) {
    const force = !!(o && o.force);
    resetIfOther();
    if (S.loading) return S.loading;
    if (!force && S.at && Date.now() - S.at < TTL) return Promise.resolve();
    const C = API();
    const pidAt = S.pid;
    const p = (async () => {
      if (!C || typeof C.myAccount !== 'function') { S.acc = null; S.err = null; return; }
      const r = await tryCall(() => C.myAccount());
      if (pidAt !== S.pid) return;          // cambió la sesión mientras tanto
      if (r.e) { S.err = r.e; return; }     // lo anterior (si había) se queda
      S.err = null;
      const acc = isObj(r.v) ? r.v : null;
      if (!acc) { S.acc = null; S.methods = []; S.alerts = []; S.hist = []; S.histErr = false; return; }
      const [m, a, h] = await Promise.all([
        tryCall(() => C.methods()), tryCall(() => C.alerts({ limit: 60 })), tryCall(() => C.history()),
      ]);
      if (pidAt !== S.pid) return;
      S.acc = acc;
      S.methods = Array.isArray(m.v) ? m.v.filter(isObj) : [];
      S.alerts = Array.isArray(a.v) ? a.v.filter(isObj) : [];
      if (h.e) { S.histErr = true; if (!Array.isArray(S.hist)) S.hist = null; }
      else { S.histErr = false; S.hist = Array.isArray(h.v) ? h.v.filter(isObj) : []; }
    })().finally(() => {
      if (S.loading === p) S.loading = null;
      if (pidAt !== S.pid) return;
      S.at = Date.now();
      checkParty();
      changed();
    });
    S.loading = p;
    return p;
  }
  // Algo que se ve cambió → el shell repinta (pestañas, franja, Pagos, campana).
  function sigNow() {
    const acc = S.acc;
    if (acc === undefined) return S.err ? 'err' : 'loading';
    if (!isObj(acc)) return 'none';
    return JSON.stringify([acc.current || null, acc.paused, acc.reference, acc.amountCOP, acc.amountNextCOP, acc.nextCut, acc.holderName, acc.holderNit,
      S.methods.map(m => [m.id, m.label, m.number, m.accountType, m.holderName, m.holderNit]),
      S.alerts.map(x => x.id), (S.hist || []).map(x => [x.id, x.paid, x.comp, x.paidOn]), S.histErr]);
  }
  function changed() {
    const sig = sigNow();
    if (sig === S.sig) return;
    S.sig = sig;
    const sh = SH();
    if (shellOn() && sh && typeof sh.current === 'function' && sh.current()) safe(() => sh.render(), null);
  }

  // cbSimulate a partir de la cuenta de la base (0090 ya trae los índices del
  // día relativos al corte; si faltara alguno se saca de las fechas).
  function toSim(acc) {
    const cur = acc && acc.current;
    if (!isObj(cur) || !parts(cur.periodStart)) return null;
    const i = isObj(cur.idx) ? cur.idx : {};
    const start = cur.periodStart;
    const today = cur.today || acc.today;
    const idx = (v, date) => (num(v) != null ? num(v) : (date ? daysBetween(start, date) : null));
    const sim = {
      paid: !!cur.paid, paidDay: cur.paid ? idx(i.paidDay, cur.paidOn) : null,
      review: !!cur.review, reviewDay: idx(i.reviewDay, cur.reviewOn),
      rejected: cur.rejected || null, blocked: !!cur.blocked, blockedSince: idx(i.blockedSince, cur.blockedOn),
      today: idx(i.today, today), due: idx(i.due, cur.dueDate), blockDay: idx(i.blockDay, cur.blockDate),
      base: cur.base || 'pendiente', comp: cur.comp || 'none', adminStatus: cur.adminStatus,
      daysToDue: num(cur.daysToDue), daysToBlock: num(cur.daysToBlock),
    };
    if (sim.today == null || sim.due == null || sim.blockDay == null) return null;
    if (sim.daysToDue == null) sim.daysToDue = sim.due - sim.today;
    if (sim.daysToBlock == null) sim.daysToBlock = sim.blockDay - sim.today;
    const cfg = {
      plazo: num(cur.dueDays) != null ? num(cur.dueDays) : sim.due,
      aviso: num(cur.noticeDays) || 0,
      gracia: num(cur.graceDays) || 0,
      monto: num(cur.amountDueCOP) != null ? num(cur.amountDueCOP) : num(cur.amountCOP),
      montoNext: num(acc.amountNextCOP),
    };
    const dates = {
      start, due: cur.dueDate || addDays(start, sim.due), block: cur.blockDate || addDays(start, sim.blockDay),
      paid: cur.paidOn || null, review: cur.reviewOn || null, today: today || addDays(start, sim.today),
      nextCut: cur.nextCut || acc.nextCut || null, at: (d) => addDays(start, d),
    };
    return { sim, cfg, dates, cur };
  }
  function statusOf(cur) {
    if (!isObj(cur)) return null;
    if (cur.comp === 'review') return 'review';
    if (cur.comp === 'rejected' && !cur.blocked && !cur.paid) return 'rejected';
    return cur.base || null;
  }
  function model() {
    const acc = S.acc;
    if (acc === undefined) return { kind: S.err ? 'err' : 'loading' };
    if (!isObj(acc)) return { kind: 'none' };
    const t = toSim(acc);
    if (!t) return { kind: 'empty', acc };
    return Object.assign({ kind: 'ok', acc }, t);
  }

  // ── Contrato AuxPagos ───────────────────────────────────────────────────
  function summary() {
    kick();
    const acc = S.acc;
    if (!isObj(acc) || !isObj(acc.current)) return null;
    const cur = acc.current;
    const status = statusOf(cur);
    if (!status) return null;
    const label = cur.paid ? monthName(cur.periodStart, true) + ' al día'
      : cur.comp === 'review' ? 'En revisión' : ((CB_STATUS[cur.base] || {}).label || '');
    return {
      status, label,
      amountCOP: num(cur.amountDueCOP) != null ? num(cur.amountDueCOP) : num(cur.amountCOP),
      dueISO: cur.dueDate || null, blockISO: cur.blockDate || null,
      month: monthLabel(cur.periodStart), paused: !!acc.paused, blocked: !!cur.blocked,
      reference: acc.reference || null, statementId: cur.id || null,
    };
  }
  function paused() { kick(); return !!(isObj(S.acc) && S.acc.paused); }

  // cbBanner (cobro-aux.jsx) con el mes, el monto y las fechas de la cuenta real.
  function cbBanner(sim, cfg, dates) {
    const m = money(cfg.monto);
    const mes = monthName(dates.start);
    const fd = (d) => fmtDay(dates.at(d));
    if (sim.comp === 'review') {
      return { tone: 'info', icon: 'Clock', title: 'Estamos revisando tu comprobante',
        body: sim.blocked ? 'Te avisamos apenas quede aprobado. Tus reservas se reactivan en ese momento.' : 'Te avisamos apenas quede aprobado. Mientras tanto puedes seguir reservando.' };
    }
    if (sim.comp === 'rejected' && !sim.blocked) {
      return { tone: 'error', icon: 'X', title: 'Tu comprobante fue rechazado', body: 'Motivo: ' + String(sim.rejected || 'sin motivo').toLowerCase() + '. Sube uno nuevo.', cta: 'Subir otro comprobante', go: 'upload' };
    }
    switch (sim.base) {
      case 'pagado': return { tone: 'ok', icon: 'Check', title: monthName(dates.start, true) + ' pagado', body: dates.nextCut ? 'Próximo cobro: ' + fmtDay(dates.nextCut) + '.' : '' };
      case 'bloqueado': return { tone: 'block', icon: 'Lock', title: 'Tus reservas están pausadas', body: 'Tu cobro de ' + mes + ' (' + m + ') sigue pendiente. Paga y sube el comprobante para reactivarlas.', cta: 'Pagar ahora' };
      case 'vencido': return { tone: 'error', icon: 'AlertTriangle', title: sim.daysToBlock === 1 ? 'Mañana se pausan tus reservas' : 'Tu cobro está vencido',
        body: m + '. Te ' + (sim.daysToBlock === 1 ? 'queda' : 'quedan') + ' ' + pl(sim.daysToBlock, 'día', 'días') + ' antes de que se pausen tus reservas (' + fd(sim.blockDay) + ').', cta: 'Pagar ahora' };
      case 'venceHoy': return { tone: 'warn', icon: 'AlertTriangle', title: 'Hoy vence tu cobro', body: m + '. Si ya pagaste, sube el comprobante.', cta: 'Subir comprobante', go: 'upload' };
      case 'porVencer': return { tone: 'warn', icon: 'Clock', title: 'Tu cobro vence en ' + pl(sim.daysToDue, 'día', 'días'), body: m + ' · fecha límite ' + fd(sim.due) + '.', cta: 'Ver y pagar' };
      default: return { tone: 'neutral', icon: 'FileText', title: 'Cuenta de cobro de ' + mes, body: m + ' · vence el ' + fd(sim.due) + '.', cta: 'Ver y pagar' };
    }
  }

  // ── RxCobroStrip (rx-home.jsx:49) por el enganche 'home.strip' ─────────────
  function stripBanner() {
    const m = model();
    if (m.kind !== 'ok') return null;
    const s = m.sim;
    if (s.paid || s.comp === 'review' || (s.base === 'pendiente' && s.comp !== 'rejected')) return null;
    return cbBanner(s, m.cfg, m.dates);
  }
  const stripHook = {
    id: 'cobro', priority: 20,
    when() { kick(); return !!stripBanner(); },
    render() {
      const b = stripBanner(); if (!b) return '';
      const m = model();
      return '<button type="button" class="rx-strip t-' + esc(b.tone) + '" data-rx="rx-tab" data-tab="pagos">'
        + ic(b.icon, 18) + '<span><b>' + esc(b.title) + '</b><span>' + esc(money(m.cfg.monto)) + ' · '
        + (m.sim.blocked ? 'toca para reactivar' : 'toca para pagar') + '</span></span>' + ic('ChevronRight', 16) + '</button>';
    },
  };

  // ── Avisos de cobro en Notificaciones ('avisos.source') ───────────────────
  const avisosSource = {
    id: 'cobro',
    when() { kick(); return isObj(S.acc); },
    list() {
      const acc = S.acc; if (!isObj(acc)) return [];
      const cur = isObj(acc.current) ? acc.current : null;
      const today = (cur && cur.today) || acc.today || '';
      return S.alerts.filter(a => !cur || a.statementId === cur.id).filter(a => a.title).map(a => ({
        id: 'cobro:' + a.id, icon: ALERT_ICON[a.key] || 'Wallet', tone: a.tone || 'neutral',
        title: a.title, body: a.body || '', when: a.day && a.day === today ? 'Hoy' : fmtDay(a.day),
      }));
    },
  };

  // ── Cb2Ring ─────────────────────────────────────────────────────────────
  function ringOf(sim, cfg) {
    let frac, big = null, bigIc = null, small, tone;
    if (sim.paid) { frac = 1; bigIc = ['Check', 30]; small = 'Al día'; tone = 'ok'; }
    else if (sim.comp === 'review') { frac = 0.3; bigIc = ['Clock', 26]; small = 'En revisión'; tone = 'info'; }
    else if (sim.blocked) { frac = 0; bigIc = ['Lock', 26]; small = 'Pausado'; tone = 'block'; }
    else if (sim.today > sim.due) { frac = sim.daysToBlock / (cfg.gracia + 1); big = sim.daysToBlock; small = sim.daysToBlock === 1 ? 'día de gracia' : 'días de gracia'; tone = 'error'; }
    else if (sim.today === sim.due) { frac = 0.04; big = 'Hoy'; small = 'vence'; tone = 'warn'; }
    else { frac = cfg.plazo > 0 ? sim.daysToDue / cfg.plazo : 0; big = sim.daysToDue; small = sim.daysToDue === 1 ? 'día para pagar' : 'días para pagar'; tone = sim.base === 'porVencer' ? 'warn' : 'accent'; }
    if (!isFinite(frac)) frac = 0;
    frac = Math.max(0, Math.min(1, frac));
    // key={String(big)}: un ícono de React es un objeto → '[object Object]' (los
    // tres íconos comparten key y NO se re-montan entre sí, como en el diseño).
    const key = bigIc ? '[object Object]' : String(big);
    return { frac, big, bigIc, small, tone, spin: sim.comp === 'review', key };
  }
  const ringCls = (r) => 'cb2-ring t-' + r.tone + (r.spin ? ' spin' : '');
  const ringBig = (r) => (r.bigIc ? ic(r.bigIc[0], r.bigIc[1]) : esc(r.big));
  const ringOffset = (r) => CIRC * (1 - r.frac);
  function ringHTML(r) {
    return '<div class="' + ringCls(r) + '" data-key="' + esc(r.key) + '">'
      + '<svg viewBox="0 0 110 110"><circle cx="55" cy="55" r="' + R + '" class="bg"></circle>'
      + '<circle cx="55" cy="55" r="' + R + '" class="fg" style="stroke-dasharray:' + CIRC + ';stroke-dashoffset:' + ringOffset(r) + '"></circle></svg>'
      + '<div class="cb2-ring-c"><b>' + ringBig(r) + '</b><span>' + esc(r.small) + '</span></div>'
      + '</div>';
  }

  // ── Cb2Timeline ─────────────────────────────────────────────────────────
  function tlOf(sim, cfg, dates) {
    const N = [[0, 'Corte']].concat(cfg.aviso > 0 ? [[sim.due - cfg.aviso, 'Aviso']] : [], [[sim.due, 'Vence'], [sim.blockDay, 'Pausa']]);
    const pos = (d) => (sim.blockDay > 0 ? (d / sim.blockDay) * 100 : 0) + '%';
    const now = Math.min(sim.today, sim.blockDay);
    return {
      bar: { width: sim.paid ? pos(sim.paidDay != null ? sim.paidDay : now) : pos(now), cls: sim.paid ? 'ok' : sim.today > sim.due ? 'late' : '' },
      nodes: N.map(([d, l]) => ({ l, past: sim.today >= d, end: l === 'Pausa', left: pos(d), date: fmtDay(dates.at(d)) })),
      now: sim.paid ? null : pos(now),
    };
  }
  function tlHTML(t) {
    return '<div class="cb2-tl">'
      + '<div class="cb2-tl-bar"><span style="width:' + t.bar.width + '" class="' + t.bar.cls + '"></span></div>'
      + t.nodes.map(n => '<div class="cb2-tl-n' + (n.past ? ' past' : '') + (n.end ? ' end' : '') + '" style="left:' + n.left + '" data-l="' + esc(n.l) + '"><i></i><b>' + esc(n.l) + '</b><span>' + esc(n.date) + '</span></div>').join('')
      + (t.now != null ? '<div class="cb2-tl-now" style="left:' + t.now + '"><span>Hoy</span></div>' : '')
      + '</div>';
  }

  // ── Cb2Tracker ──────────────────────────────────────────────────────────
  // «Te avisamos por push» solo si de verdad le llegan push; si no, «aquí».
  function pushOn() {
    const acc = S.acc;
    if (isObj(acc) && isObj(acc.prefs) && acc.prefs.push === false) return false;
    try { return typeof Notification !== 'undefined' && Notification.permission === 'granted'; } catch (_) { return false; }
  }
  const avisoTxt = () => (pushOn() ? 'Te avisamos por push' : 'Te avisamos aquí');
  function trkOf(m) {
    const sim = m.sim, cur = m.cur;
    const rej = sim.comp === 'rejected';
    const sent = m.dates.review || (isObj(cur.lastProof) && cur.lastProof.submittedOn) || m.dates.today;
    return [
      ['Enviado', 'El ' + fmtDay(sent), 'done'],
      ['En revisión', rej ? 'Rechazado' : sim.comp === 'review' ? 'El admin lo está revisando' : 'Listo', rej ? 'bad' : sim.comp === 'review' ? 'now' : 'done'],
      ['Aprobado', sim.paid ? 'El ' + fmtDay(m.dates.paid) : rej ? String(sim.rejected || '') : avisoTxt(), sim.paid ? 'done' : rej ? 'bad' : 'wait'],
    ];
  }
  const trkIcon = (s, i) => (s === 'done' ? ic('Check', 13) : s === 'bad' && i === 1 ? ic('X', 13) : '');
  function trkHTML(steps) {
    return '<div class="cb2-trk">' + steps.map(([t, d, s], i) => '<div class="cb2-trk-s ' + s + '"><i>' + trkIcon(s, i) + '</i><div><b>' + esc(t) + '</b><span>' + esc(d) + '</span></div></div>').join('') + '</div>';
  }

  // ── Cb2Pay ──────────────────────────────────────────────────────────────
  const P = { view: 'mes', how: 0, open: null, last: '', shape: '', kind: '', secs: null, prevSecs: null };
  let copyT = null;

  function methodsView() {
    const ms = S.methods;
    const counts = {};
    ms.forEach(x => { counts[x.label] = (counts[x.label] || 0) + 1; });
    return ms.map(x => ({
      id: x.id,
      seg: counts[x.label] > 1 && x.accountType ? x.label + ' · ' + x.accountType : x.label,
      t: x.label + (x.accountType ? ' · ' + x.accountType : ''),
      n: x.number || '',
      holder: x.holderName || null, nit: x.holderNit || null,
    }));
  }
  function holderLine(mv, acc) {
    const h = (mv && mv.holder) || acc.holderName || null;
    const n = (mv && mv.nit) || acc.holderNit || null;
    if (!h && !n) return 'El titular de la cuenta todavía no está cargado.';
    return (h ? 'A nombre de ' + h : 'Titular sin cargar') + (n ? ' · NIT ' + n : '');
  }
  function payFlags(m) {
    const sim = m.sim, acc = m.acc, cur = m.cur;
    const chip = sim.comp === 'review' ? { label: 'En revisión', tone: 'info' }
      : sim.comp === 'rejected' && !sim.paid ? { label: 'Rechazado', tone: 'error' } : (CB_STATUS[sim.base] || CB_STATUS.pendiente);
    const canUpload = !sim.paid && sim.comp !== 'review';
    const next = num(acc.amountNextCOP);
    const base = num(acc.amountCOP);
    return {
      chip, canUpload,
      next: next && next !== (base != null ? base : m.cfg.monto) ? next : null,
      disc: num(cur.discountCOP) > 0 ? { n: num(cur.discountCOP), note: cur.discountNote || '' } : null,
      // Sin comprobante (pago que el jefe marcó a mano) no hay nada que seguir.
      tracker: sim.comp !== 'none' && (sim.comp !== 'approved' || isObj(cur.lastProof)),
      fab: canUpload ? (sim.comp === 'rejected' ? 'Subir otro comprobante' : 'Ya pagué · subir comprobante') : null,
    };
  }
  function howHTML(m) {
    const acc = m.acc;
    const mv = methodsView();
    const k = Math.min(P.how, Math.max(0, mv.length - 1));
    const cur = mv[k] || null;
    let h = '';
    if (mv.length > 1) {
      h += '<div class="cb2-seg in">' + mv.map((x, i) => '<button type="button" class="' + (i === k ? 'on' : '') + '" data-rx="pg-how" data-i="' + i + '">' + esc(x.seg) + '</button>').join('') + '</div>';
    }
    if (cur) h += '<div class="cb2-acc">' + accInner(cur) + '</div>';
    else h += '<div class="cb2-hint">' + ic('Info', 15) + '<span>Coordinación todavía no cargó las cuentas para pagar. Escríbele para saber a dónde transferir.</span></div>';
    if (acc.reference) {
      h += '<div class="cb2-ref"><div><span>Escribe en la descripción</span><b>' + esc(acc.reference) + '</b></div><button type="button" data-rx="pg-copy" data-k="ref">Copiar</button></div>';
    }
    if (cur) h += '<div class="cb2-set-f">' + esc(holderLine(cur, acc)) + '</div>';
    return h;
  }
  const accInner = (x) => '<span>' + esc(x.t) + '</span><b>' + esc(x.n) + '</b><button type="button" data-rx="pg-copy" data-k="num">Copiar</button>';

  function mesHTML(m) {
    const f = payFlags(m);
    const sim = m.sim, cfg = m.cfg;
    let h = '<div class="cb2-hero cb2-in" style="--d:0">'
      + '<div class="cb2-hero-tx">'
      + '<div class="cb2-hero-m">' + heroM(m, f) + '</div>'
      + '<div class="cb2-hero-a">' + esc(money(cfg.monto)) + '</div>'
      + '<div class="cb2-hero-d">' + esc(heroD(m)) + '</div>'
      + '</div>'
      + ringHTML(ringOf(sim, cfg))
      + '</div>';
    h += '<div class="cb2-card cb2-in" style="--d:1">' + tlHTML(tlOf(sim, cfg, m.dates)) + '</div>';
    if (f.next) h += '<div class="cb2-hint cb2-in" style="--d:1" data-pg="next">' + ic('Info', 15) + '<span>Desde ' + esc(monthName(m.dates.nextCut) || 'el próximo corte') + ' tu mensualidad será ' + esc(money(f.next)) + '.</span></div>';
    if (f.disc) h += '<div class="cb2-hint cb2-in" style="--d:1" data-pg="disc">' + ic('Info', 15) + '<span>Este mes tiene un descuento de ' + esc(money(f.disc.n)) + (f.disc.note ? ' · ' + esc(f.disc.note) : '') + '.</span></div>';
    if (f.tracker) {
      h += '<div class="cb2-lbl cb2-in" style="--d:2" data-pg="trk">Tu comprobante</div>'
        + '<div class="cb2-card cb2-in" style="--d:2" data-pg="trk">' + trkHTML(trkOf(m))
        + (sim.comp === 'rejected' && !sim.paid ? '<button type="button" class="cb2-inline-cta" data-rx="pg-upload">' + ic('Camera', 16) + 'Subir otro comprobante</button>' : '')
        + '</div>';
    }
    if (!sim.paid) {
      h += '<div class="cb2-lbl cb2-in" style="--d:3" data-pg="how">Cómo pagar</div>'
        + '<div class="cb2-card cb2-in" style="--d:3" data-pg="how">' + howHTML(m) + '</div>';
    }
    return h;
  }
  const heroM = (m, f) => esc(monthLabel(m.dates.start)) + ' <span class="cb-chip t-' + esc(f.chip.tone) + '">' + esc(f.chip.label) + '</span>';
  const heroD = (m) => (m.sim.paid ? 'Pagado el ' + fmtDay(m.dates.paid) : 'Fecha límite ' + fmtDay(m.dates.due));

  function histItems() {
    const acc = S.acc;
    const thisYear = (parts((isObj(acc) && acc.today) || '') || {}).y;
    return (S.hist || []).filter(x => parts(x.periodStart)).map(s => {
      const p = parts(s.periodStart);
      const mes = monthName(s.periodStart, true) + (thisYear && p.y !== thisYear ? ' ' + p.y : '');
      const amt = num(s.amountDueCOP) != null ? num(s.amountDueCOP) : num(s.amountCOP);
      if (s.paid) {
        const late = num(s.daysLate);
        return {
          ok: true, mes, sub: 'Pagado el ' + fmtDay(s.paidOn), amt,
          x: [['Medio', s.paidViaLabel || (s.paidVia === 'manual' ? 'Registrado por el admin' : '—')],
            ['Puntualidad', late ? pl(late, 'día', 'días') + ' tarde' : 'A tiempo', !!late],
            ['Aprobó', s.approverLabel || '—']],
        };
      }
      const est = s.comp === 'review' ? 'En revisión' : s.comp === 'rejected' && !s.blocked ? 'Rechazado' : ((CB_STATUS[s.base] || {}).label || 'Pendiente');
      return {
        ok: false, mes, sub: (s.blocked ? 'Pausado · vencía el ' : 'Sin pagar · vence el ') + fmtDay(s.dueDate), amt,
        x: [['Estado', est], ['Fecha límite', fmtDay(s.dueDate) || '—'], ['Pausa', fmtDay(s.blockDate) || '—']],
      };
    });
  }
  function histHTML() {
    if (S.hist == null) {
      return S.histErr
        ? '<div class="rx-empty">' + ic('CloudOff', 26) + '<b>No pudimos cargar el historial</b><span>Revisa tu conexión y vuelve a intentarlo.</span><button type="button" class="rx-btn pri" data-rx="pg-retry">Reintentar</button></div>'
        : '<div class="rx-empty"><span>Cargando tu historial…</span></div>';
    }
    const items = histItems();
    if (!items.length) return '<div class="rx-empty">' + ic('FileText', 26) + '<b>Todavía no hay cuentas de cobro</b><span>Cuando llegue la primera, aquí vas a ver cada mes y cómo lo pagaste.</span></div>';
    return items.map((it, i) => '<div class="cb2-hist cb2-in' + (P.open === i ? ' open' : '') + '" style="--d:' + i + '" data-rx="pg-hist" data-i="' + i + '">'
      + '<div class="cb2-hist-r"><span class="cb2-row-ic' + (it.ok ? ' ok' : '') + '">' + ic(it.ok ? 'Check' : 'FileText', 16) + '</span>'
      + '<div><b>' + esc(it.mes) + '</b><span>' + esc(it.sub) + '</span></div><em>' + esc(money(it.amt)) + '</em><span class="cb2-chev">' + ic('ChevronRight', 16) + '</span></div>'
      + '<div class="cb2-hist-x">' + it.x.map(([k, v, late]) => '<div><span>' + esc(k) + '</span><b' + (late ? ' class="late"' : '') + '>' + esc(v) + '</b></div>').join('') + '</div>'
      + '</div>').join('');
  }

  function bodyInner(m) {
    const f = m.kind === 'ok' ? payFlags(m) : null;
    const main = P.view === 'hist' ? histHTML() : mesHTML(m);
    return main + '<div style="height:' + (f && f.canUpload && P.view === 'mes' ? 76 : 0) + 'px"></div>';
  }
  const fabHTML = (label) => '<div class="cb2-fab"><button type="button" class="r-btn r-btn-primary" data-rx="pg-upload">' + ic('Camera', 18) + esc(label) + '</button></div>';
  const HEAD = '<div class="cb2-hd"><div class="cb2-hd-tx"><div class="cb2-hd-t big">Pagos</div></div></div>';

  function stateHTML(m) {
    if (m.kind === 'loading') return '<div class="rx-empty"><span>Cargando tu cuenta…</span></div>';
    if (m.kind === 'err') {
      return '<div class="rx-empty">' + ic('CloudOff', 26) + '<b>No pudimos cargar tu cuenta de cobro</b><span>Revisa tu conexión y vuelve a intentarlo.</span><button type="button" class="rx-btn pri" data-rx="pg-retry">Reintentar</button></div>';
    }
    if (m.kind === 'empty') {
      const acc = m.acc;
      const amt = num(acc.amountCOP);
      const when = acc.nextCut ? 'Tu primera cuenta de cobro llega el ' + fmtDay(acc.nextCut) + '.' : 'Todavía no se abrió tu primera cuenta de cobro.';
      return '<div class="rx-empty">' + ic('FileText', 26) + '<b>' + esc(amt ? 'Tu mensualidad: ' + money(amt) : 'Tu mensualidad está registrada') + '</b><span>' + esc(when) + '</span></div>';
    }
    return '<div class="rx-empty">' + ic('Wallet', 26) + '<b>Todavía no tienes mensualidad registrada</b><span>Cuando Coordinación la cargue, aquí vas a ver tu cuenta del mes y cómo pagarla.</span></div>';
  }
  function payHTML(m) {
    if (m.kind !== 'ok') {
      return '<div class="cb2-scr" data-pg-kind="' + m.kind + '">' + HEAD + '<div class="cb2-body" data-rx-scroll>' + stateHTML(m) + '</div></div>';
    }
    const f = payFlags(m);
    return '<div class="cb2-scr" data-pg-kind="ok">' + HEAD
      + '<div class="cb2-seg"><button type="button" class="' + (P.view === 'mes' ? 'on' : '') + '" data-rx="pg-view" data-v="mes">Este mes</button>'
      + '<button type="button" class="' + (P.view === 'hist' ? 'on' : '') + '" data-rx="pg-view" data-v="hist">Historial</button></div>'
      + '<div class="cb2-body" data-rx-scroll data-pg-view="' + P.view + '">' + bodyInner(m) + '</div>'
      + (f.fab && P.view === 'mes' ? fabHTML(f.fab) : '')
      + '</div>';
  }
  // «Forma»: si no cambia, un cambio de datos se aplica EN SU LUGAR (transiciones
  // del anillo y la barra); si cambia, se repinta.
  function shapeOf(m) {
    if (m.kind !== 'ok') return m.kind + '|' + payHTML(m);
    if (P.view === 'hist') return 'hist|' + payHTML(m);
    const f = payFlags(m);
    return JSON.stringify(['mes', !!f.next && f.next, f.disc, f.tracker, m.sim.comp === 'rejected' && !m.sim.paid, !m.sim.paid && howHTML(m),
      f.fab, tlOf(m.sim, m.cfg, m.dates).nodes.map(n => n.l + n.date + n.left), monthLabel(m.dates.start)]);
  }

  function payRoot(ctx) {
    if (ctx && (ctx.host || ctx.el)) return ctx.host || ctx.el;
    return document.querySelector('#auxiliar-ui .rx-tabview[data-scr="pay"] .rx-scrhost');
  }
  // Secciones de «Este mes» que pueden aparecer o irse (para que una que APARECE
  // en un repintado entre con su .cb2-in, como un montaje nuevo de React).
  function secsOf(m) {
    if (m.kind !== 'ok' || P.view !== 'mes') return null;
    const f = payFlags(m);
    return [f.next && 'next', f.disc && 'disc', f.tracker && 'trk', !m.sim.paid && 'how'].filter(Boolean);
  }
  function remember() { const m = model(); P.kind = m.kind; P.last = payHTML(m); P.shape = shapeOf(m); P.secs = secsOf(m); return m; }
  function animateNew(root, prev) {
    const u = UI();
    if (!root || !prev || !P.secs || !u || !u.remount) return;
    P.secs.filter(k => prev.indexOf(k) < 0).forEach(k => {
      root.querySelectorAll('[data-pg="' + k + '"]').forEach(el => u.remount(el));
    });
  }
  function countAmount(root, m) {
    const el = root && root.querySelector('.cb2-hero-a');
    const u = UI();
    if (el && m.kind === 'ok' && u && u.countUp) u.countUp(el, m.cfg.monto, { ms: 700, from: 'prev', fmt: money });
  }

  function patchMes(root, m) {
    const f = payFlags(m);
    const hm = root.querySelector('.cb2-hero-m'); if (hm) hm.innerHTML = heroM(m, f);
    countAmount(root, m);
    const hd = root.querySelector('.cb2-hero-d'); if (hd) hd.textContent = heroD(m);
    const ringEl = root.querySelector('.cb2-ring');
    if (ringEl) {
      const r = ringOf(m.sim, m.cfg);
      if (ringEl.getAttribute('class') !== ringCls(r)) ringEl.setAttribute('class', ringCls(r));
      const fg = ringEl.querySelector('circle.fg');
      if (fg) fg.style.strokeDashoffset = String(ringOffset(r));
      const b = ringEl.querySelector('.cb2-ring-c > b');
      if (b) {
        if (ringEl.getAttribute('data-key') !== r.key) { const u = UI(); if (u && u.remount) u.remount(b, ringBig(r)); else b.innerHTML = ringBig(r); }
        else if (b.innerHTML !== ringBig(r)) b.innerHTML = ringBig(r);
      }
      ringEl.setAttribute('data-key', r.key);
      const sp = ringEl.querySelector('.cb2-ring-c > span'); if (sp) sp.textContent = r.small;
    }
    const tlEl = root.querySelector('.cb2-tl');
    if (tlEl) {
      const t = tlOf(m.sim, m.cfg, m.dates);
      const bar = tlEl.querySelector('.cb2-tl-bar > span');
      if (bar) { bar.style.width = t.bar.width; bar.className = t.bar.cls; }
      [...tlEl.querySelectorAll('.cb2-tl-n')].forEach((n, i) => {
        const d = t.nodes[i]; if (!d) return;
        n.classList.toggle('past', d.past);
        n.style.left = d.left;
        const s = n.querySelector('span'); if (s) s.textContent = d.date;
      });
      let now = tlEl.querySelector('.cb2-tl-now');
      if (t.now == null) { if (now) now.remove(); }
      else if (now) now.style.left = t.now;
      else tlEl.insertAdjacentHTML('beforeend', '<div class="cb2-tl-now" style="left:' + t.now + '"><span>Hoy</span></div>');
    }
    const trk = root.querySelector('.cb2-trk');
    if (trk && f.tracker) {
      const steps = trkOf(m);
      [...trk.querySelectorAll('.cb2-trk-s')].forEach((el, i) => {
        const st = steps[i]; if (!st) return;
        el.className = 'cb2-trk-s ' + st[2];
        const iEl = childOf(el, null, 'I'); if (iEl && iEl.innerHTML !== trkIcon(st[2], i)) iEl.innerHTML = trkIcon(st[2], i);
        const b = el.querySelector('b'); if (b) b.textContent = st[0];
        const s = el.querySelector('div > span'); if (s) s.textContent = st[1];
      });
    }
  }

  const payScreen = {
    render(ctx) {
      const enter = !ctx || ctx.reason === 'enter';
      if (enter) { P.view = 'mes'; P.how = 0; P.open = null; }
      P.prevSecs = !enter && P.kind === 'ok' ? P.secs : null;
      remember();
      return P.last;
    },
    after(ctx) {
      const root = payRoot(ctx);
      countAmount(root, model());
      // Repintado (reveal / repaint): lo que no estaba antes entra animado.
      if (P.prevSecs) animateNew(root, P.prevSecs);
      P.prevSecs = null;
      // Al entrar a la pestaña se trae de nuevo (salvo que se haya traído hace nada).
      if ((!ctx || ctx.reason === 'enter') && !(S.at && Date.now() - S.at < ENTER_FRESH_MS)) load({ force: true }).catch(() => {});
      else kick();
      showPendingParty();
    },
    patch(ctx) {
      const m = model();
      const html = payHTML(m);
      if (html === P.last) return true;
      const root = payRoot(ctx);
      if (!root) return false;
      if (m.kind !== P.kind) {
        // Llegaron los datos (o se fueron): la pantalla se monta nueva y sus
        // entradas corren, como en React al cambiar lo que se pinta.
        root.classList.remove('rx-noanim');
        root.innerHTML = html;
        remember();
        countAmount(root, m);
        return true;
      }
      if (m.kind === 'ok' && P.view === 'mes' && shapeOf(m) === P.shape) {
        patchMes(root, m);
        remember();
        return true;
      }
      if (m.kind === 'ok' && P.view === 'hist') {
        // El historial llegó o cambió: su lista se monta nueva (sus .cb2-in corren).
        const body = root.querySelector('.cb2-scr > .cb2-body');
        if (!body) return false;
        root.classList.remove('rx-noanim');
        body.innerHTML = bodyInner(m);
        remember();
        return true;
      }
      return false;
    },
    destroy() { clearTimeout(copyT); },
  };

  // ── Acciones de Pagos ───────────────────────────────────────────────────
  const scrOf = (el) => (el && el.closest ? el.closest('.cb2-scr') : null);
  const childOf = (el, cls, tag) => (el ? [...el.children].find(c => (cls ? c.classList.contains(cls) : c.tagName === tag)) || null : null);

  function viewAct(el) {
    const v = el.getAttribute('data-v');
    if ((v !== 'mes' && v !== 'hist') || v === P.view) return;
    P.view = v;
    if (v === 'hist') P.open = null;
    const scr = scrOf(el);
    const m = model();
    if (!scr || m.kind !== 'ok') { const sh = SH(); if (sh) sh.render(); return; }
    const seg = childOf(scr, 'cb2-seg');
    if (seg) [...seg.children].forEach(b => { b.className = b.getAttribute('data-v') === v ? 'on' : ''; });
    // key={view}: el cuerpo se RECREA y sus entradas .cb2-in vuelven a correr.
    const body = childOf(scr, 'cb2-body');
    const u = UI();
    if (body && u && u.remount) { const n = u.remount(body, bodyInner(m)); n.setAttribute('data-pg-view', v); n.scrollTop = 0; }
    const fab = childOf(scr, 'cb2-fab');
    const f = payFlags(m);
    if (fab) fab.remove();
    if (f.fab && v === 'mes') {
      const tpl = document.createElement('template'); tpl.innerHTML = fabHTML(f.fab);
      const b2 = childOf(scr, 'cb2-body');
      if (b2) b2.after(tpl.content.firstChild);
    }
    if (v === 'mes') countAmount(scr, m);
    remember();
    if (v === 'hist' && S.hist == null && !S.loading) load({ force: true }).catch(() => {});
  }
  function howAct(el) {
    const i = Number(el.getAttribute('data-i'));
    const mv = methodsView();
    if (!(i >= 0 && i < mv.length) || i === P.how) return;
    P.how = i;
    const card = el.closest('[data-pg="how"]');
    const seg = el.closest('.cb2-seg');
    if (seg) [...seg.children].forEach((b, k) => { b.className = k === i ? 'on' : ''; });
    // key={how}: la cuenta se RECREA (cb2In .3 s).
    const acc = card && childOf(card, 'cb2-acc');
    const u = UI();
    if (acc && u && u.remount) u.remount(acc, accInner(mv[i]));
    const sf = card && childOf(card, 'cb2-set-f');
    if (sf) sf.textContent = holderLine(mv[i], S.acc);
    remember();
  }
  function histAct(el) {
    const i = Number(el.getAttribute('data-i'));
    P.open = P.open === i ? null : i;
    const body = el.parentNode;
    if (body) [...body.querySelectorAll('.cb2-hist')].forEach(h => h.classList.toggle('open', Number(h.getAttribute('data-i')) === P.open));
    remember();
  }
  async function copyText(t) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(t); return true; }
    } catch (_) { /* sigue con el respaldo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }
  // key={toast}: mismo texto → el mismo nodo (solo se reinicia el reloj); texto
  // nuevo → nodo nuevo (su cb2Toast corre de cero). 1500 ms.
  function copyToast(scr, text, icon) {
    if (!scr) return;
    clearTimeout(copyT);
    let el = childOf(scr, 'cb2-toast');
    if (!el || el.getAttribute('data-k') !== text) {
      if (el) el.remove();
      el = document.createElement('div');
      // .rx-anim: nace nuevo aunque la pantalla venga de un repintado sin animaciones.
      el.className = 'cb2-toast rx-anim';
      el.setAttribute('data-k', text);
      el.setAttribute('role', 'status');
      el.innerHTML = ic(icon || 'Check', 15) + esc(text);
      scr.appendChild(el);
    }
    const mine = el;
    copyT = setTimeout(() => { mine.remove(); }, COPY_MS);
  }
  async function copyAct(el) {
    const k = el.getAttribute('data-k');
    const scr = scrOf(el);
    let txt = null;
    if (k === 'ref') txt = isObj(S.acc) ? S.acc.reference : null;
    else { const mv = methodsView(); const x = mv[Math.min(P.how, mv.length - 1)]; txt = x ? x.n : null; }
    if (!txt) return;
    const ok = await copyText(String(txt));
    if (ok) copyToast(scr, k === 'ref' ? 'Referencia copiada' : 'Número copiado', 'Check');
    else copyToast(scr, 'No se pudo copiar: ' + txt, 'X');
  }
  function uploadAct() { const sh = SH(); if (sh) sh.push('upload', {}); }
  function retryAct() { S.err = null; load({ force: true }).catch(() => {}); }

  // ── Cb2Upload ───────────────────────────────────────────────────────────
  const U = { step: 0, via: null, file: null, url: null, sending: false, flashT: null, host: null };
  function upReset() {
    clearTimeout(U.flashT);
    if (U.url) { try { URL.revokeObjectURL(U.url); } catch (_) { /* */ } }
    U.step = 0; U.via = null; U.file = null; U.url = null; U.sending = false;
  }
  function viasOf() {
    const ms = S.methods;
    const counts = {};
    ms.forEach(x => { counts[x.label] = (counts[x.label] || 0) + 1; });
    const out = ms.map((x, i) => ({
      k: 'm' + i, id: x.id, label: x.label,
      t: counts[x.label] > 1 && x.accountType ? x.label + ' · ' + x.accountType : x.label,
      d: x.kind === 'nequi' || x.kind === 'daviplata' ? 'Desde la app' : 'Transferencia o sucursal virtual',
    }));
    out.push({ k: 'otro', id: null, label: 'Otro banco', t: 'Otro banco', d: 'PSE o transferencia interbancaria' });
    return out;
  }
  const viaOf = () => viasOf().find(v => v.k === U.via) || null;
  const isImg = () => !!(U.file && /^image\//i.test(U.file.type || '') && U.url);
  const imgTag = () => (isImg() ? '<img class="rx-pg-img" src="' + esc(U.url) + '" alt="">' : '');
  const thumbHTML = () => '<span class="cb-thumb' + (isImg() ? ' rx-pg-thumb' : '') + '">' + imgTag() + '</span>';
  const fileName = () => (U.file && U.file.name) || 'comprobante';

  function camInner() {
    if (U.file) return '<div class="cb2-cam-shot">' + imgTag() + '<span>' + esc(fileName()) + '</span></div>';
    return '<span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>'
      + '<div class="cb2-cam-hint">Toca el botón para tomar la foto</div>';
  }
  const camRow = () => (U.file
    ? '<button type="button" class="cb2-link" data-rx="pg-up-retake">' + ic('RotateCcw', 15) + 'Tomar otra</button>'
    : '<div class="cb2-shutter-row"><button type="button" class="cb2-link" data-rx="pg-up-gal">Galería</button><button type="button" class="cb2-shutter" data-rx="pg-up-cam" aria-label="Tomar foto"><i></i></button><span style="width:64px"></span></div>');

  function stepBody(m) {
    if (U.step === 0) {
      return '<h3 class="cb2-q cb2-in">¿Desde dónde pagaste?</h3>'
        + viasOf().map((v, i) => '<button type="button" class="cb2-opt cb2-in' + (U.via === v.k ? ' on' : '') + '" style="--d:' + (i + 1) + '" data-rx="pg-up-via" data-k="' + esc(v.k) + '">'
          + '<span class="cb2-radio"><i></i></span><div><b>' + esc(v.t) + '</b><span>' + esc(v.d) + '</span></div></button>').join('');
    }
    if (U.step === 1) {
      return '<h3 class="cb2-q cb2-in">Toma la foto del comprobante</h3>'
        + '<p class="cb2-qs cb2-in" style="--d:1">Que se vean el monto, la fecha y la cuenta de destino.</p>'
        + '<div class="cb2-cam cb2-in' + (U.file ? ' has' : '') + '" style="--d:2">' + camInner() + '</div>'
        + camRow();
    }
    const v = viaOf();
    return '<h3 class="cb2-q cb2-in">Confirma los datos</h3>'
      + '<div class="cb2-card cb2-in cb2-sum" style="--d:1">' + thumbHTML()
      + '<div><div class="cb2-kv"><span>Monto</span><b>' + esc(money(m.cfg.monto)) + '</b></div>'
      + '<div class="cb2-kv"><span>Pagaste por</span><b>' + esc(v ? v.t : '') + '</b></div>'
      + '<div class="cb2-kv"><span>Mes</span><b>' + esc(monthLabel(m.dates.start)) + '</b></div></div>'
      + '</div>'
      + '<div class="cb2-hint cb2-in" style="--d:2">' + ic('Info', 15) + '<span>Si pagaste un monto distinto, avísale a Coordinación por el chat antes de enviar.</span></div>';
  }
  function bottomHTML() {
    if (U.step < 2) {
      const dis = U.step === 0 ? !U.via : !U.file;
      return '<button type="button" class="r-btn r-btn-primary"' + (dis ? ' disabled' : '') + ' data-rx="pg-up-next">Continuar</button>';
    }
    return '<button type="button" class="r-btn r-btn-primary' + (U.sending ? ' cb2-sending' : '') + '" data-rx="pg-up-send"' + (U.sending ? ' disabled' : '') + '>'
      + (U.sending ? '<span class="cb2-spin"></span>Enviando…' : 'Enviar comprobante') + '</button>';
  }
  function doneHTML(m) {
    const v = viaOf();
    return '<div class="cb2-scr cb2-done">'
      + '<div class="cb2-check info"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"></circle><polyline points="15 27 23 35 38 18"></polyline></svg></div>'
      + '<h2>Comprobante enviado</h2>'
      + '<p>' + (pushOn() ? 'Te avisamos por push apenas lo revisemos.' : 'Te avisamos aquí apenas lo revisemos.') + '</p>'
      + '<div class="cb2-done-card">' + thumbHTML() + '<div><b>' + esc(money(m.cfg.monto)) + ' · ' + esc(v ? v.t : '') + '</b><span>' + esc(monthLabel(m.dates.start)) + '</span></div></div>'
      + '<button type="button" class="r-btn r-btn-primary" data-rx="pg-up-done">Listo</button>'
      + '</div>';
  }
  const FILES = '<input type="file" hidden accept="image/*,application/pdf" capture="environment" data-pg-file="cam">'
    + '<input type="file" hidden accept="image/*,application/pdf" data-pg-file="gal">';
  function upHTML() {
    const m = model();
    if (U.step === 3 && m.kind === 'ok') return doneHTML(m);
    if (m.kind !== 'ok' || m.sim.paid || m.sim.comp === 'review') {
      const why = m.kind !== 'ok' ? 'Todavía no tienes una cuenta de cobro abierta.' : m.sim.paid ? 'Este mes ya está pagado.' : 'Ya hay un comprobante en revisión.';
      return '<div class="cb2-scr"><div class="cb2-hd"><button type="button" class="cb2-back" data-rx="pg-up-close" aria-label="Volver">' + ic('ChevronLeft', 22) + '</button>'
        + '<div class="cb2-hd-tx"><div class="cb2-hd-t">Subir comprobante</div></div></div>'
        + '<div class="cb2-body" data-rx-scroll><div class="rx-empty">' + ic('Info', 26) + '<b>' + esc(why) + '</b></div></div></div>';
    }
    return '<div class="cb2-scr">'
      + '<div class="cb2-hd"><button type="button" class="cb2-back" data-rx="pg-up-back" aria-label="Volver">' + ic('ChevronLeft', 22) + '</button>'
      + '<div class="cb2-hd-tx"><div class="cb2-hd-e">Paso ' + (U.step + 1) + ' de 3</div><div class="cb2-hd-t">Subir comprobante</div></div>'
      + '<button type="button" class="cb2-back" data-rx="pg-up-close" aria-label="Cerrar">' + ic('X', 20) + '</button></div>'
      + '<div class="r-stepper">' + [0, 1, 2].map(i => '<div class="seg' + (i <= U.step ? ' done' : '') + '"></div>').join('') + '</div>'
      + '<div class="cb2-body" data-rx-scroll data-step="' + U.step + '">' + stepBody(m) + '</div>'
      + '<div class="r-bottom">' + bottomHTML() + '</div>'
      + FILES
      + '</div>';
  }
  function upHost(el) {
    const h = el && el.closest ? el.closest('.rx-scrhost') : null;
    return h || U.host || document.querySelector('#auxiliar-ui [data-scr="upload"] .rx-scrhost');
  }
  function paintBottom(host) {
    const b = host && host.querySelector('.r-bottom');
    if (b) b.innerHTML = bottomHTML();
  }
  function upGo(host, n) {
    if (!host) return;
    U.step = n;
    const m = model();
    if (n === 3 || m.kind !== 'ok') { host.classList.remove('rx-noanim'); host.innerHTML = upHTML(); return; }
    const scr = host.querySelector('.cb2-scr');
    const e = scr && scr.querySelector('.cb2-hd-e'); if (e) e.textContent = 'Paso ' + (n + 1) + ' de 3';
    const segs = scr ? [...scr.querySelectorAll('.r-stepper .seg')] : [];
    segs.forEach((s, i) => s.classList.toggle('done', i <= n));
    // key={step}: el cuerpo se RECREA y sus entradas corren.
    const body = scr && childOf(scr, 'cb2-body');
    const u = UI();
    if (body && u && u.remount) { const nb = u.remount(body, stepBody(m)); nb.setAttribute('data-step', String(n)); nb.scrollTop = 0; }
    paintBottom(host);
  }
  function paintCam(host) {
    const cam = host && host.querySelector('.cb2-cam');
    if (!cam) return;
    cam.classList.toggle('has', !!U.file);
    cam.innerHTML = camInner();
    const shot = cam.querySelector('.cb2-cam-shot');
    if (shot) shot.classList.add('rx-anim');     // se monta nueva: su cb2Pop corre
    const row = cam.nextElementSibling;
    const tpl = document.createElement('template'); tpl.innerHTML = camRow();
    if (row && (row.classList.contains('cb2-shutter-row') || row.classList.contains('cb2-link'))) row.replaceWith(tpl.content.firstChild);
    else cam.after(tpl.content.firstChild);
    paintBottom(host);
  }
  function fileOk(file) {
    const type = String(file.type || '').toLowerCase();
    const okType = /^image\//.test(type) || type === 'application/pdf' || /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.name || '');
    if (!okType) return 'El comprobante tiene que ser una foto (JPG, PNG) o un PDF';
    if (file.size != null && file.size > MAX_BYTES) return 'El archivo pesa más de 10 MB';
    return null;
  }
  function onFile(ev) {
    const inp = ev.target;
    const file = inp && inp.files && inp.files[0];
    if (inp) { try { inp.value = ''; } catch (_) { /* */ } }
    if (!file) return;
    const bad = fileOk(file);
    const sh = SH();
    if (bad) { if (sh) sh.toast(bad, 'AlertTriangle'); return; }
    const host = upHost(inp);
    const cam = host && host.querySelector('.cb2-cam');
    if (U.url) { try { URL.revokeObjectURL(U.url); } catch (_) { /* */ } }
    U.url = null;
    // Flash de 260 ms y después la foto (snap del diseño).
    clearTimeout(U.flashT);
    if (cam && !cam.querySelector('.cb2-flash')) cam.insertAdjacentHTML('beforeend', '<div class="cb2-flash rx-anim"></div>');
    U.flashT = setTimeout(() => {
      U.file = file;
      try { if (/^image\//i.test(file.type || '') && typeof URL.createObjectURL === 'function') U.url = URL.createObjectURL(file); } catch (_) { U.url = null; }
      paintCam(host);
    }, FLASH_MS);
  }
  function bindFiles(host) {
    if (!host) return;
    host.querySelectorAll('input[data-pg-file]').forEach(inp => {
      if (inp._pgBound) return;
      inp._pgBound = true;
      inp.addEventListener('change', onFile);
    });
  }
  const pickFile = (el, which) => {
    const host = upHost(el);
    const inp = host && host.querySelector('input[data-pg-file="' + which + '"]');
    if (inp) inp.click();
  };

  function upBackAct(el) {
    if (U.sending) return;
    if (U.step === 0) { const sh = SH(); if (sh) sh.pop(); return; }
    upGo(upHost(el), U.step - 1);
  }
  function upCloseAct() { if (U.sending) return; const sh = SH(); if (sh) sh.pop(); }
  function upViaAct(el) {
    const k = el.getAttribute('data-k');
    if (!viasOf().some(v => v.k === k)) return;
    U.via = k;
    const body = el.parentNode;
    if (body) [...body.querySelectorAll('.cb2-opt')].forEach(b => b.classList.toggle('on', b.getAttribute('data-k') === k));
    paintBottom(upHost(el));
  }
  function upNextAct(el) {
    if (U.step === 0 && !U.via) return;
    if (U.step === 1 && !U.file) return;
    if (U.step < 2) upGo(upHost(el), U.step + 1);
  }
  function upRetakeAct(el) {
    if (U.url) { try { URL.revokeObjectURL(U.url); } catch (_) { /* */ } }
    U.file = null; U.url = null;
    paintCam(upHost(el));
  }
  async function upSendAct(el) {
    if (U.sending || !U.file) return;
    const host = upHost(el);
    const m = model();
    const C = API();
    const v = viaOf();
    if (m.kind !== 'ok' || !C || typeof C.uploadProof !== 'function' || !v) return;
    U.sending = true;
    paintBottom(host);
    let r = null, err = null;
    try {
      r = await C.uploadProof(U.file, { statementId: m.cur.id, viaLabel: v.label, methodId: v.id || null, declaredAmountCOP: m.cfg.monto });
    } catch (e) { err = e; }
    U.sending = false;
    if (err || !isObj(r)) {
      paintBottom(host);
      const sh = SH();
      if (sh) sh.toast((err && err.message) || 'No pudimos enviar el comprobante. Intenta de nuevo.', 'AlertTriangle');
      return;
    }
    if (isObj(r.statement) && isObj(S.acc)) S.acc.current = r.statement;
    upGo(host, 3);
    // Por detrás: los avisos («Recibimos tu comprobante») y lo demás.
    S.at = 0;
    load({ force: true }).catch(() => {});
  }
  function upDoneAct() {
    const sh = SH(); if (!sh) return;
    sh.popAll();
    sh.setTab('pay');
  }

  const upScreen = {
    render(ctx) {
      if (ctx && ctx.reason === 'enter') upReset();
      return upHTML();
    },
    after(ctx) { U.host = (ctx && (ctx.host || ctx.el)) || null; bindFiles(U.host); },
    // La pantalla lleva su propio estado (paso, foto): un render del shell no la toca.
    patch() { return true; },
    destroy(ctx) { if (!ctx || ctx.reason === 'leave') { upReset(); U.host = null; } },
  };

  // ── Cb2Party ────────────────────────────────────────────────────────────
  // Sale cuando una cuenta de cobro que ESTE teléfono vio sin pagar aparece
  // pagada (aprobada o marcada por el jefe), como el useEffect de rx-app.jsx:44.
  const seenKey = () => LS_SEEN + ':' + (S.pid || '');
  function seenGet() {
    try { const v = JSON.parse(localStorage.getItem(seenKey()) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
  }
  function seenSet(o) { try { localStorage.setItem(seenKey(), JSON.stringify(o)); } catch (_) { /* sin almacenamiento */ } }
  function checkParty() {
    const acc = S.acc;
    if (!isObj(acc) || !S.pid) return;
    const list = [];
    if (isObj(acc.current)) list.push(acc.current);
    (S.hist || []).forEach(s => { if (s && s.id && !list.some(x => x.id === s.id)) list.push(s); });
    const seen = seenGet();
    let dirty = false, win = null;
    list.forEach(s => {
      if (!s || !s.id) return;
      if (!s.paid) { if (!seen[s.id]) { seen[s.id] = 1; dirty = true; } return; }
      if (seen[s.id]) {
        delete seen[s.id]; dirty = true;
        if (!win || String(s.paidOn || '') > String(win.paidOn || '')) win = s;
      }
    });
    if (dirty) seenSet(seen);
    if (win) { S.partyPending = win; showPendingParty(); }
  }
  function showPendingParty() {
    const st = S.partyPending;
    if (!st || !shellOn()) return;
    const host = document.querySelector('#auxiliar-ui.rx-phone > .rx-app');
    if (!host) return;
    S.partyPending = null;
    const acc = S.acc;
    const back = !!st.wasBlocked && !(isObj(acc) && acc.paused);
    const full = String((profile() || {}).full_name || '').trim();
    const first = full.split(/\s+/)[0] || '';
    const u = UI();
    const next = isObj(acc) && acc.nextCut ? acc.nextCut : null;
    const old = childOf(host, 'cb2-party'); if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'cb2-party';
    el.innerHTML = (u && u.confetti ? u.confetti(22, ['#F26522', '#10B981', '#F59E0B', '#3B82F6'], { cls: 'cb2-confetti', mod: 7, step: 70 }) : '')
      + '<div class="cb2-party-c">'
      + '<div class="cb2-check ok"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"></circle><polyline points="15 27 23 35 38 18"></polyline></svg></div>'
      + '<h2>¡' + esc(monthName(st.periodStart, true)) + ' al día!</h2>'
      + '<p>' + esc((first ? 'Gracias, ' + first + '. ' : 'Gracias. ') + (back ? 'Tus reservas ya están activas otra vez.' : 'Tu pago quedó confirmado.')) + '</p>'
      + (next ? '<div class="cb2-party-n">Próximo cobro · ' + esc(fmtDay(next)) + '</div>' : '')
      + '<button type="button" class="r-btn r-btn-primary" data-pg-party="close">' + (back ? 'Reservar un viaje' : 'Seguir') + '</button>'
      + '</div>';
    // El fondo cierra; la tarjeta no (stopPropagation del diseño), su botón sí.
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.cb2-party-c') && !t.closest('[data-pg-party="close"]')) return;
      el.remove();
      if (back) { const sh = SH(); if (sh) sh.setTab('home'); }
    });
    host.appendChild(el);
  }

  // ── Registro ────────────────────────────────────────────────────────────
  window.AuxPagos = {
    summary, paused, cbBanner,
    refresh: (o) => load(o || { force: true }),
    // Para pruebas.
    _state: () => S, _model: model, _ui: () => ({ P, U }),
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('pay', payScreen);
    sh.register('upload', upScreen);
    sh.hook('home.strip', stripHook);
    sh.hook('avisos.source', avisosSource);
    sh.action('pg-view', viewAct);
    sh.action('pg-how', howAct);
    sh.action('pg-copy', copyAct);
    sh.action('pg-hist', histAct);
    sh.action('pg-upload', uploadAct);
    sh.action('pg-retry', retryAct);
    sh.action('pg-up-back', upBackAct);
    sh.action('pg-up-close', upCloseAct);
    sh.action('pg-up-via', upViaAct);
    sh.action('pg-up-cam', (el) => pickFile(el, 'cam'));
    sh.action('pg-up-gal', (el) => pickFile(el, 'gal'));
    sh.action('pg-up-retake', upRetakeAct);
    sh.action('pg-up-next', upNextAct);
    sh.action('pg-up-send', upSendAct);
    sh.action('pg-up-done', upDoneAct);
  }
})();
