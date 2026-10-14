// aux-rx-coord.js — P8 · Coordinación del rediseño del auxiliar (27-sep-2026).
//
// Porta RxCoord de rx-trip.jsx con su marcado: rx-scr · RxHead «Coordinación»
// (rx-ib con el teléfono a la derecha) · el bloque bajo la cabecera
// (rx-planb rx-in) · rx-body rx-chat con burbujas rx-bub in/out .pop · rx-qr
// con las tres respuestas rápidas. El diseño no trae campo para escribir: el
// pie rx-co-foot (contexto + campo + enviar) es propio (rx-aux-coord.css).
//
// Lo que cambia por decisión (plan final §1.6 y §3.11, D11):
//   · Sin nombre ni presencia («Juliana · en línea», «24/7» no existen). En la
//     cabecera va el HORARIO solo si está cargado en Ajustes y el TELÉFONO solo
//     si está cargado (ops_contact_phone); si no, no se pinta.
//   · «Plan B activo» no existe: en su lugar va la nota de entrada
//     «Le escribes a los jefes de la operación. Te responden por aquí.»
//   · Las respuestas rápidas NO envían ni contestan solas: PRELLENAN el campo
//     (data-rx-field, estado propio de este módulo; nunca auxState.form).
//   · No hay «escribiendo…» fingido: la burbuja typing del diseño era una
//     respuesta automática; aquí nadie responde en automático.
//
// Canal (#12): crew_messages, UN hilo por tripulante con los jefes (0088). Si se
// abre desde un viaje (open-coord con data-id, o #/coordinacion?r=ID), ese
// traslado viaja como CONTEXTO del mensaje (chip «Sobre tu salida del …», que
// se puede quitar). ApiAux.crewSend ya manda el push a los jefes («Mensaje de
// un tripulante», /#/coordinacion?aux=<id>): aquí no se avisa dos veces.
// Mientras la pantalla está abierta y a la vista se consulta cada 5 s, y al
// abrirla se marca leído (crewMarkRead).
//
// Animaciones (ANIMACIONES §2 y §5), mismas clases que el diseño:
//   · rx-planb rx-in (rxRise); las burbujas .pop (rxBub .35 s) al montar el
//     hilo y cada burbuja NUEVA (se inserta como nodo nuevo con .rx-anim, que
//     anima aunque la pantalla siga con .rx-noanim de un repintado);
//   · repintar la misma pantalla no anima nada (el shell pone .rx-noanim).
//
// Contrato: window.AuxRxCoord = { unread(), refreshUnread(force), open(resId),
//   html(), QR }. unread() es SÍNCRONO (lo leen Inicio y Avisos al pintar):
//   devuelve lo último que se supo y, si tiene más de 30 s, pide
//   ApiAux.crewUnread() por detrás; si el número cambia, llama a
//   AuxRxInicio.refreshBell() (y repinta Avisos si está arriba).
// Registra AuxShell 'coord' y las acciones data-rx co-qr, co-send, co-ctx-off,
// co-retry.
(function () {
  'use strict';

  const POLL_MS = 5000;          // plan §3.11: cada 5 s mientras está abierta
  const UNREAD_TTL = 30000;      // unread(): refresco perezoso de la campana
  const MAX_LEN = 500;           // crew_messages: CHECK length(btrim(body)) BETWEEN 1 AND 500
  // [rótulo del botón (el del diseño), texto que prellena el campo (plan §3.11)]
  const QR = [
    ['Mi vuelo se retrasó', 'Mi vuelo se retrasó: ahora sale a las '],
    ['No encuentro al conductor', 'No encuentro al conductor. Estoy en '],
    ['Cambiar la dirección', 'Necesito cambiar la dirección: '],
  ];
  const NO_DISP = 'Todavía no puedes escribirle a Coordinación desde la app';

  const UI = () => window.AuxRxUI || null;
  const SH = () => window.AuxShell || null;
  const AX = () => window.Auxiliar || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s) => { const u = UI(); return u && u.ic ? u.ic(n, s) : ''; };
  const hm = (v) => { const u = UI(); return v && u && u.hm ? u.hm(v) : ''; };
  const on = () => { const s = SH(); return !!(s && typeof s.on === 'function' && safe(() => s.on(), false)); };
  const auxSt = () => { const a = AX(); return (a && a.state) || {}; };
  const trips = () => (Array.isArray(auxSt().trips) ? auxSt().trips : []);
  const profileId = () => { const p = auxSt().profile; return (p && p.id) || null; };
  function settings() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof state !== 'undefined' && state && state.settings) return state.settings;
    } catch (_) { /* */ }
    return (window.state && window.state.settings) || {};
  }
  function toast(msg, icon) {
    const s = SH();
    if (s && typeof s.toast === 'function') s.toast(msg, icon || 'Check');
    else if (typeof window.toast === 'function') window.toast(msg);
  }

  // ── Días en hora de Bogotá («hoy», «mañana», «jue 16 oct») ───────────────
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function bogDay(v) {
    const u = UI(); if (u && u.bogDay) { const d = safe(() => u.bogDay(v), ''); if (d) return d; }
    try {
      const p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(v)).forEach(x => { p[x.type] = x.value; });
      return p.year ? `${p.year}-${p.month}-${p.day}` : '';
    } catch (_) { return ''; }
  }
  function shortDay(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '';
    const now = Date.now();
    if (d === bogDay(now)) return 'hoy';
    if (d === bogDay(now + 86400e3)) return 'mañana';
    if (d === bogDay(now - 86400e3)) return 'ayer';
    const x = new Date(d + 'T12:00:00-05:00');
    if (isNaN(x.getTime())) return '';
    return WD[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MO[x.getUTCMonth()];
  }
  function deDay(d) {
    const s = shortDay(d);
    if (!s) return '';
    return (s === 'hoy' || s === 'mañana' || s === 'ayer') ? 'de ' + s : 'del ' + s;
  }
  // «salida del jue 16 oct» / «llegada de mañana»
  const aboutTrip = (type, date) => ((type === 'lle' ? 'llegada' : 'salida') + (deDay(date) ? ' ' + deDay(date) : '')).trim();

  // ── Estado del módulo ────────────────────────────────────────────────────
  const co = {
    owner: null,        // perfil dueño de lo que hay en memoria (otro perfil → se vacía)
    el: null,           // la capa .rx-layer[data-scr="coord"] montada
    msgs: [],           // el hilo (forma de ApiAux.crewList) + las burbujas en envío
    loaded: false, err: false, loading: null,
    draft: '',          // lo escrito en el campo (sobrevive a un repintado)
    resId: null,        // traslado de contexto
    ops: null,          // {phone, hours} de ApiAux.getOpsContact (null = sin leer)
    unread: 0, unreadAt: 0, unreadBusy: null,
    poll: null, tmp: 0, bound: false,
  };
  function ownerCheck() {
    const me = profileId();
    if (me === co.owner) return;
    co.owner = me;
    co.msgs = []; co.loaded = false; co.err = false; co.draft = ''; co.resId = null;
    co.unread = 0; co.unreadAt = 0; co.ops = null;
  }

  // ── Teléfono y horario ───────────────────────────────────────────────────
  // Lo de ApiAux.getOpsContact manda (es lo que el jefe cargó en Ajustes); sin
  // esa lectura, lo que traiga state.settings. '' = no está cargado y no se pinta.
  function opsContact() {
    const o = co.ops;
    const s = settings();
    return {
      phone: String((o ? o.phone : s.ops_contact_phone) || '').trim(),
      hours: String((o ? o.hours : s.ops_contact_hours) || '').trim(),
    };
  }
  function telHref(p) {
    const d = String(p || '').replace(/[^\d+]/g, '');
    return d.replace(/\D/g, '').length >= 3 ? 'tel:' + d : '';
  }

  // ── Marcado ──────────────────────────────────────────────────────────────
  function headHTML() {
    const { phone, hours } = opsContact();
    const href = telHref(phone);
    const right = href ? `<a class="rx-ib" href="${esc(href)}" data-co="call" aria-label="Llamar a Coordinación">${ic('Phone', 19)}</a>` : '';
    const u = UI();
    if (u && u.head) return u.head({ title: 'Coordinación', eyebrow: hours, right });
    return '<div class="rx-head"><div class="rx-head-row">'
      + `<button type="button" class="rx-ib" data-rx="rx-pop" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`
      + `<div class="rx-head-c">${hours ? '<span>' + esc(hours) + '</span>' : ''}<b>Coordinación</b></div>`
      + `<div class="rx-head-r">${right}</div></div></div>`;
  }
  const isMine = (m) => (m && m.role ? m.role === 'auxiliar' : !!(m && m.mine));
  function metaOf(m) {
    if (m.pending) return 'Enviando…';
    const d = m.at ? bogDay(m.at) : '';
    const s = d ? shortDay(d) : '';
    const when = (s && s !== 'hoy' ? s + ' · ' : '') + hm(m.at);
    const r = m.reservation;
    const about = r && r.id ? 'Sobre tu ' + aboutTrip(r.type, r.date) : '';
    return [about, when].filter(Boolean).join(' · ');
  }
  function bubHTML(m, anim) {
    const meta = metaOf(m);
    return `<div class="rx-bub ${isMine(m) ? 'out' : 'in'} pop${anim ? ' rx-anim' : ''}${m.pending ? ' rx-co-sending' : ''}" data-co-id="${esc(m.id)}">`
      + `<span class="rx-bub-x">${esc(m.body)}</span>`
      + (meta ? `<em class="rx-bub-t">${esc(meta)}</em>` : '')
      + '</div>';
  }
  function emptyHTML() {
    return `<div class="rx-empty rx-co-empty" data-co="empty">${ic('MessageCircle', 26)}<b>Todavía no hay mensajes</b>`
      + '<span>Escribe abajo o toca una respuesta rápida para empezar el mensaje.</span></div>';
  }
  function loadingHTML() {
    return '<div class="rx-empty rx-co-empty" data-co="loading"><span>Cargando mensajes…</span></div>';
  }
  function errorHTML() {
    const u = UI();
    const b = u && u.btn ? u.btn('Reintentar', { kind: 'sec', icon: 'Refresh', attrs: { 'data-rx': 'co-retry' } })
      : '<button type="button" class="rx-btn sec" data-rx="co-retry">Reintentar</button>';
    return `<div class="rx-empty rx-co-empty" data-co="error">${ic('CloudOff', 26)}<b>No pudimos cargar los mensajes</b>`
      + '<span>Revisa tu conexión y vuelve a intentarlo. Lo que escribas igual se puede enviar.</span>' + b + '</div>';
  }
  function threadInner(anim) {
    if (!co.loaded && !co.msgs.length) return co.err ? errorHTML() : loadingHTML();
    if (!co.msgs.length) return emptyHTML();
    return co.msgs.map(m => bubHTML(m, anim)).join('');
  }
  function ctxTrip() {
    if (!co.resId) return null;
    return trips().find(t => t && t.id === co.resId) || null;
  }
  function ctxHTML() {
    const t = ctxTrip();
    if (!t) return '';
    return `<div class="rx-co-ctx" data-co="ctx">${ic(t.type === 'lle' ? 'Home' : 'Plane', 14)}`
      + `<span>Sobre tu ${esc(aboutTrip(t.type, t.date))}</span>`
      + `<button type="button" data-rx="co-ctx-off" aria-label="Quitar el traslado del mensaje">${ic('X', 14)}</button></div>`;
  }
  function footHTML() {
    const can = !!co.draft.trim();
    return '<div class="rx-co-foot">' + ctxHTML()
      + '<div class="rx-co-row"><div class="rx-input">'
      + `<input type="text" data-rx-field="coord-msg" maxlength="${MAX_LEN}" autocomplete="off" enterkeyhint="send" placeholder="Escribe tu mensaje" aria-label="Mensaje para Coordinación" value="${esc(co.draft)}">`
      + '</div>'
      + `<button type="button" class="rx-co-send" data-rx="co-send" aria-label="Enviar"${can ? '' : ' disabled'}>${ic('Send', 19)}</button>`
      + '</div></div>';
  }
  function html() {
    return '<div class="rx-scr rx-co">' + headHTML()
      + `<div class="rx-planb rx-in">${ic('Headset', 18)}<span>Le escribes a los jefes de la operación. Te responden por aquí.</span></div>`
      + `<div class="rx-body rx-chat" data-co="thread">${threadInner(false)}</div>`
      + `<div class="rx-qr">${QR.map((q, i) => `<button type="button" data-rx="co-qr" data-q="${i}">${esc(q[0])}</button>`).join('')}</div>`
      + footHTML()
      + '</div>';
  }

  // ── DOM de la pantalla montada ───────────────────────────────────────────
  function root() {
    const el = co.el;
    return el && el.isConnected && !el.classList.contains('out') ? el : null;
  }
  const $ = (sel) => { const r = root(); return r ? r.querySelector(sel) : null; };
  const thread = () => $('[data-co="thread"]');
  const input = () => $('[data-rx-field="coord-msg"]');
  function scrollEnd() { const b = thread(); if (b) { try { b.scrollTop = b.scrollHeight || 99999; } catch (_) { /* */ } } }
  function paintThread(anim) {
    const b = thread(); if (!b) return;
    b.innerHTML = threadInner(anim);
    scrollEnd();
  }
  function appendBubbles(list) {
    const b = thread(); if (!b || !list.length) return;
    const ph = b.querySelector('.rx-co-empty');
    if (ph) ph.remove();
    const h = list.map(m => bubHTML(m, true)).join('');
    // Lo que llega del servidor entra ANTES de lo que se está enviando.
    const firstPending = list.every(m => !m.pending) ? b.querySelector('.rx-bub.rx-co-sending') : null;
    if (firstPending) firstPending.insertAdjacentHTML('beforebegin', h);
    else b.insertAdjacentHTML('beforeend', h);
    scrollEnd();
  }
  function bubEl(id) {
    const b = thread(); if (!b) return null;
    return [...b.querySelectorAll('.rx-bub[data-co-id]')].find(x => x.getAttribute('data-co-id') === String(id)) || null;
  }
  function syncSend() {
    const btn = $('[data-rx="co-send"]');
    if (!btn) return;
    const can = !!co.draft.trim();
    if (can) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', '');
  }
  function repaintHead() {
    const h = $('.rx-co > .rx-head');
    if (!h) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = headHTML().trim();
    if (tpl.content.firstChild) h.replaceWith(tpl.content.firstChild);
  }
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  function isOpen() {
    const s = SH();
    const c = s && typeof s.current === 'function' ? safe(() => s.current(), null) : null;
    return !!(c && c.id === 'coord' && root() && visible());
  }

  // ── Hilo: cargar, fusionar, enviar ───────────────────────────────────────
  function load() {
    if (co.loading) return co.loading;
    const X = window.ApiAux;
    if (!X || typeof X.crewList !== 'function') {
      if (!co.loaded) { co.err = true; paintThread(false); }
      return Promise.resolve(null);
    }
    const owner = co.owner;
    co.loading = Promise.resolve()
      .then(() => X.crewList())
      .catch(() => null)
      .then((list) => {
        co.loading = null;
        if (owner !== co.owner) return null;
        if (!Array.isArray(list)) {
          // Una consulta de fondo que falla no borra lo que ya se ve.
          if (!co.loaded) { co.err = true; if (!co.msgs.length) paintThread(false); }
          return null;
        }
        co.err = false;
        merge(list);
        return list;
      });
    return co.loading;
  }
  // La copia del servidor de una burbuja que se está enviando (mismo texto,
  // escrita después de que se tocó «enviar», con 2 min de holgura de reloj).
  function twinOf(p, list, taken) {
    const t0 = Date.parse(p.at) - 120000;
    return list.find(m => m && m.id != null && !taken.has(m.id) && isMine(m) && m.body === p.body
      && (!m.at || isNaN(t0) || Date.parse(m.at) >= t0)) || null;
  }
  function adopt(p, m) {
    const old = p.id;
    p.id = m.id; p.at = m.at || p.at; p.read = !!m.read; p.pending = false;
    if (m.reservation !== undefined) p.reservation = m.reservation;
    const n = bubEl(old);
    if (n) {
      n.setAttribute('data-co-id', String(p.id));
      n.classList.remove('rx-co-sending');
      const meta = metaOf(p);
      const em = n.querySelector('.rx-bub-t');
      if (em) em.textContent = meta;
    }
  }
  function merge(list) {
    const known = new Set(co.msgs.filter(m => !m.pending).map(m => m.id));
    const taken = new Set(known);
    co.msgs.filter(m => m.pending).forEach(p => {
      const tw = twinOf(p, list.filter(m => !known.has(m.id)), taken);
      if (tw) { taken.add(tw.id); adopt(p, tw); }
    });
    if (!co.loaded) {
      // Primera carga: el hilo del servidor, y detrás lo que se esté enviando.
      const pend = co.msgs.filter(m => m.pending);
      const adopted = co.msgs.filter(m => !m.pending && taken.has(m.id) && !list.some(x => x.id === m.id));
      co.msgs = list.filter(m => m && m.id != null).map(m => co.msgs.find(p => p.id === m.id) || m).concat(adopted, pend);
      co.loaded = true;
      paintThread(true);
    } else {
      const added = list.filter(m => m && m.id != null && !taken.has(m.id));
      added.forEach(m => co.msgs.push(m));
      // Los que estaban en envío van siempre al final.
      co.msgs.sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0));
      if (added.length) appendBubbles(added);
      if (added.some(m => !isMine(m) && !m.read) && isOpen()) markRead();
    }
  }
  function send() {
    const inp = input();
    const body = String(inp ? inp.value : co.draft).trim();
    if (!body) return;
    if (body.length > MAX_LEN) { toast('El mensaje es demasiado largo (máximo 500 caracteres)', 'AlertTriangle'); return; }
    const X = window.ApiAux;
    if (!X || typeof X.crewSend !== 'function') { toast(NO_DISP, 'AlertTriangle'); return; }
    const t = ctxTrip();
    const resId = t ? t.id : null;
    const tmp = {
      id: 'tmp-' + (++co.tmp), role: 'auxiliar', mine: true, body, at: new Date().toISOString(), read: false,
      reservation: t ? { id: t.id, type: t.type, date: t.date, time: t.time } : null, pending: true,
    };
    co.msgs.push(tmp);
    appendBubbles([tmp]);
    co.draft = '';
    if (inp) inp.value = '';
    syncSend();
    const owner = co.owner;
    Promise.resolve()
      .then(() => X.crewSend(body, { reservationId: resId }))
      .then((r) => {
        if (owner !== co.owner) return;
        if (!r) { fail(tmp, NO_DISP); return; }
        if (!tmp.pending) return;                                   // ya la adoptó la consulta
        if (r.id && co.msgs.some(m => m !== tmp && m.id === r.id)) { drop(tmp); return; }
        adopt(tmp, { id: r.id || tmp.id, at: r.createdAt || tmp.at, read: false });
      })
      .catch((e) => { if (owner === co.owner) fail(tmp, (e && e.message) || 'No se pudo enviar'); });
  }
  function drop(tmp) {
    co.msgs = co.msgs.filter(m => m !== tmp);
    const n = bubEl(tmp.id); if (n) n.remove();
    if (!co.msgs.length && co.loaded) paintThread(false);
  }
  function fail(tmp, msg) {
    drop(tmp);
    // Lo escrito no se pierde: vuelve al campo si quedó vacío.
    const inp = input();
    if (!co.draft.trim()) {
      co.draft = tmp.body;
      if (inp) inp.value = tmp.body;
      syncSend();
    }
    if (!co.loaded && !co.msgs.length) paintThread(false);
    toast(msg, 'AlertTriangle');
  }

  // ── Sin leer (campana de Inicio y Avisos) ────────────────────────────────
  function bellChanged() {
    const i = window.AuxRxInicio;
    if (i && typeof i.refreshBell === 'function') safe(() => i.refreshBell(), null);
    const s = SH();
    const c = s && typeof s.current === 'function' ? safe(() => s.current(), null) : null;
    if (c && c.id === 'notifs' && typeof s.render === 'function') s.render();
  }
  function setUnread(n) {
    co.unreadAt = Date.now();
    if (n === co.unread) return;
    co.unread = n;
    bellChanged();
  }
  function refreshUnread(force) {
    ownerCheck();
    if (co.unreadBusy) return co.unreadBusy;
    const X = window.ApiAux;
    if (!X || typeof X.crewUnread !== 'function' || !on()) return Promise.resolve(co.unread);
    if (!force && Date.now() - co.unreadAt < UNREAD_TTL) return Promise.resolve(co.unread);
    co.unreadAt = Date.now();
    const owner = co.owner;
    co.unreadBusy = Promise.resolve()
      .then(() => X.crewUnread())
      .catch(() => null)
      .then((n) => {
        co.unreadBusy = null;
        if (owner !== co.owner) return co.unread;
        if (typeof n === 'number' && isFinite(n) && n >= 0) {
          // Con Coordinación abierta y a la vista, lo que llega ya se está leyendo.
          if (n > 0 && isOpen()) { load(); markRead(); return co.unread; }
          setUnread(Math.round(n));
        }
        return co.unread;
      });
    return co.unreadBusy;
  }
  function unread() {
    ownerCheck();
    if (on() && Date.now() - co.unreadAt >= UNREAD_TTL) refreshUnread(false);
    return co.unread;
  }
  function markRead() {
    const X = window.ApiAux;
    if (!X || typeof X.crewMarkRead !== 'function') return;
    const owner = co.owner;
    Promise.resolve()
      .then(() => X.crewMarkRead())
      .catch(() => null)
      .then((n) => {
        if (n == null || owner !== co.owner) return;
        co.msgs.forEach(m => { if (!isMine(m)) m.read = true; });
        setUnread(0);
      });
  }
  function loadOps() {
    const X = window.ApiAux;
    if (!X || typeof X.getOpsContact !== 'function') return;
    const owner = co.owner;
    Promise.resolve()
      .then(() => X.getOpsContact())
      .catch(() => null)
      .then((o) => {
        if (!o || owner !== co.owner) return;
        const before = JSON.stringify(opsContact());
        co.ops = { phone: String(o.phone || '').trim(), hours: String(o.hours || '').trim() };
        if (JSON.stringify(opsContact()) !== before) repaintHead();
      });
  }

  // ── Consulta cada 5 s ────────────────────────────────────────────────────
  function startPoll() {
    if (co.poll) return;
    co.poll = setInterval(() => { if (isOpen()) load(); }, POLL_MS);
  }
  function stopPoll() { if (co.poll) { clearInterval(co.poll); co.poll = null; } }

  // ── Oyentes (una sola vez, delegados: el campo se recrea al repintar) ────
  function bindOnce() {
    if (co.bound || typeof document === 'undefined') return;
    co.bound = true;
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('[data-rx-field="coord-msg"]')) return;
      co.draft = el.value;
      syncSend();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const el = e.target;
      if (!el || !el.matches || !el.matches('[data-rx-field="coord-msg"]')) return;
      e.preventDefault();
      send();
    });
  }
  // Un push de Coordinación con la app abierta: la campana (y el hilo, si se
  // está viendo) no esperan al siguiente refresco.
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (sw && typeof sw.addEventListener === 'function') {
      sw.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!d || d.type !== 'rendio-push' || !/#\/coordinacion/.test(String(d.url || ''))) return;
        if (!on()) return;
        if (isOpen()) load();
        refreshUnread(true);
      });
    }
  } catch (_) { /* sin service worker */ }

  // ── Acciones data-rx ─────────────────────────────────────────────────────
  function qrAct(el) {
    const q = QR[Number(el && el.getAttribute('data-q'))];
    if (!q) return;
    // Prellena, NO envía (D11): la persona completa el dato y toca enviar.
    co.draft = q[1];
    const inp = input();
    if (inp) {
      inp.value = q[1];
      try { inp.focus(); inp.setSelectionRange(q[1].length, q[1].length); } catch (_) { /* */ }
    }
    syncSend();
  }
  function ctxOffAct() {
    co.resId = null;
    const c = $('[data-co="ctx"]');
    if (c) c.remove();
  }
  function retryAct() {
    co.err = false;
    paintThread(false);
    load();
  }

  // ── Pantalla «coord» ─────────────────────────────────────────────────────
  const screen = {
    render(ctx) {
      ownerCheck();
      if (ctx && ctx.reason === 'enter') {
        const p = (ctx && ctx.props) || {};
        co.resId = p.reservationId || null;
        co.draft = '';
        // Cada vez que se abre, el hilo sale del servidor (y entra con su .pop
        // una sola vez, como al montar en el diseño); nada de copias viejas.
        co.msgs = []; co.loaded = false; co.err = false;
      }
      return html();
    },
    after(ctx) {
      co.el = (ctx && ctx.el) || null;
      bindOnce();
      if (ctx && ctx.reason === 'enter') {
        scrollEnd();
        load();
        loadOps();
        markRead();
      }
      startPoll();
    },
    // Una pasada del shell con la pantalla arriba (refresco de viajes, avisos):
    // aquí no cambia nada de eso y repintar borraría el foco del campo.
    patch() { return true; },
    destroy(ctx) {
      stopPoll();
      if (ctx && ctx.reason === 'leave') co.el = null;
    },
  };

  window.AuxRxCoord = {
    unread, refreshUnread,
    open: (reservationId) => { const s = SH(); return s && typeof s.push === 'function' ? s.push('coord', { reservationId: reservationId || null }) : null; },
    html: () => { ownerCheck(); return html(); },
    QR: QR.map(q => q.slice()),
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('coord', screen);
    sh.action('co-qr', qrAct);
    sh.action('co-send', () => send());
    sh.action('co-ctx-off', ctxOffAct);
    sh.action('co-retry', retryAct);
  }
})();
