// aux-rx-avisos.js — P3 · Avisos (Notificaciones) del rediseño del auxiliar (27-sep-2026).
//
// Porta RxNotifs de rx-home.jsx con el mismo marcado (rx-head, rx-px + rx-seg,
// rx-body key={f}, rx-nt rx-in --d:min(i,8), rx-nt-ic t-tone, rx-nt-tx,
// rx-unread, rx-empty «Todo al día»). El toque en un aviso de viaje hace lo del
// diseño: pop() y, a los 280 ms, abre el viaje.
//
// Los avisos NO se guardan en ningún lado: se DERIVAN de los datos reales cada
// vez (plan final §3.5):
//   · publicado → «Ya tienes conductor»;  · privado aprobado / rechazado;
//   · cancelado;  · no-show;  · va por ti (onway);  · llegó (stop arrived);
//   · mensajes sin leer del hilo del traslado (Api.countUnreadMessages);
//   · Coordinación sin leer (AuxRxCoord.unread()).
// Solo de los viajes próximos, de los de ±3 días y de los cancelados hace menos de 3 días.
// «No leído» = su id (tipo:reserva:estado) no está en
// localStorage['rendio.aux.avisos.seen']. Se marcan vistos al abrir la pantalla
// (el punto se ve en esa visita). La marca de tiempo es el DÍA DEL VIAJE.
// Segmento Todas · Viajes · Mensajes; «Pagos» aparece cuando alguien registra
// AuxShell.hook('avisos.source', {id, list(ctx) → [{id, icon, tone, title,
// body, when, go?}]}) (el Facturario).
//
// Contrato: window.AuxRxAvisos = { unseen(), list(), refresh(force), bell(),
//   markAllSeen() }. Registra AuxShell 'notifs' y las acciones data-rx
//   «notifs-seg» y «notifs-open».
(function () {
  'use strict';

  const SEEN_KEY = 'rendio.aux.avisos.seen';
  const RECENT_MS = 3 * 86400e3;
  const CHAT_TTL_MS = 30000;
  const POP_PUSH_MS = 280;   // rx-home.jsx:155 — pop() y push('trip') a los 280 ms

  const UI = () => window.AuxRxUI || null;
  const AX = () => window.Auxiliar || null;
  const SH = () => window.AuxShell || null;
  const IN = () => window.AuxRxInicio || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s) => { const u = UI(); return u && u.ic ? u.ic(n, s) : ''; };
  const hm = (v) => { const u = UI(); return u && u.hm ? u.hm(v) : ''; };
  const dayLabel = (d) => { const u = UI(); return u && u.dayLabel ? u.dayLabel(d) : String(d || ''); };

  const auxSt = () => { const a = AX(); return (a && a.state) || {}; };
  const trips = () => (Array.isArray(auxSt().trips) ? auxSt().trips : []);
  function whenTs(t) {
    const i = IN(); if (i && i.whenTs) return i.whenTs(t);
    if (!t || !t.date || !t.time) return null;
    const x = new Date(t.date + 'T' + t.time + ':00-05:00').getTime();
    return isNaN(x) ? null : x;
  }
  const isUp = (t) => { const a = AX(); return !!(a && typeof a.isUpcoming === 'function' && safe(() => a.isUpcoming(t), false)); };
  const arrived = (t) => !!((t && t._info && t._info.stop_status === 'arrived') || (t && t.stopStatus === 'arrived'));
  const isPublished = (t) => { const i = IN(); return i && i.isPublished ? i.isPublished(t) : t && t.published === true; };
  const conjunto = (t) => { const i = IN(); return i && i.conjunto ? i.conjunto(t) : (String((t && t.address) || '').split(/[,·]/)[0].trim() || 'Casa'); };
  const firstOf = (t) => { const d = t && t.driver; return (d && (d.first || String(d.name || '').trim().split(/\s+/)[0])) || ''; };
  const plateOf = (t) => (t && ((t.vehicle && t.vehicle.plate) || (t.driver && t.driver.plate))) || '';
  const routeLine = (t) => (t.type === 'lle' ? 'Llegada · MDE → ' + conjunto(t) : 'Salida · ' + conjunto(t) + ' → MDE');

  // ── Vistos ───────────────────────────────────────────────────────────────
  function seenList() {
    try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function markSeen(ids) {
    if (!ids || !ids.length) return;
    try {
      const l = seenList().filter(x => !ids.includes(x)).concat(ids);
      localStorage.setItem(SEEN_KEY, JSON.stringify(l.slice(-300)));
    } catch (_) { /* sin almacenamiento: quedan como no leídos */ }
  }

  // ── Mensajes sin leer de los hilos de los traslados ──────────────────────
  const chat = { counts: {}, at: 0, busy: null };
  function chatIds() {
    return trips().filter(t => isUp(t) && ['assigned', 'onway', 'onboard'].includes(t.status)).map(t => t.id);
  }
  function refresh(force) {
    if (chat.busy) return chat.busy;
    if (!force && chat.at && Date.now() - chat.at < CHAT_TTL_MS) return Promise.resolve(false);
    const Api = window.Api;
    const ids = chatIds();
    if (!Api || typeof Api.countUnreadMessages !== 'function' || !ids.length) {
      const changed = Object.keys(chat.counts).length > 0;
      chat.counts = {}; chat.at = Date.now();
      if (changed) onChange();
      return Promise.resolve(changed);
    }
    chat.busy = Promise.resolve()
      .then(() => Api.countUnreadMessages(ids, ['driver', 'admin']))
      .then((res) => {
        const next = {};
        if (res && typeof res === 'object') Object.keys(res).forEach(k => { const n = Number(res[k]) || 0; if (n > 0) next[k] = n; });
        const changed = JSON.stringify(next) !== JSON.stringify(chat.counts);
        chat.counts = next; chat.at = Date.now(); chat.busy = null;
        if (changed) onChange();
        return changed;
      })
      .catch(() => { chat.busy = null; chat.at = Date.now(); return false; });
    return chat.busy;
  }
  function onChange() {
    const i = IN(); if (i && typeof i.refreshBell === 'function') safe(() => i.refreshBell(), null);
    const sh = SH();
    const cur = sh && typeof sh.current === 'function' ? sh.current() : null;
    if (cur && cur.id === 'notifs' && typeof sh.render === 'function') sh.render();
  }

  function coordUnread() {
    const c = window.AuxRxCoord;
    if (!c || typeof c.unread !== 'function') return 0;
    const v = safe(() => c.unread(), 0);
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  // ── Derivar los avisos ───────────────────────────────────────────────────
  // {id, kind:'trip'|'msg'|'pay', rank, icon, tone, title, body, when, ts, tripId?, coord?, go?}
  function derive() {
    const out = [];
    const now = Date.now();
    trips().forEach(t => {
      if (!t || !t.id) return;
      const up = isUp(t);
      const ts = whenTs(t);
      // Reciente: el viaje es de estos días, o lo cancelaron hace poco (aunque
      // fuera para dentro de dos semanas).
      const cAt = t.cancelledAt ? Date.parse(t.cancelledAt) : NaN;
      const recent = (ts != null && Math.abs(now - ts) < RECENT_MS) || (!isNaN(cAt) && now - cAt < RECENT_MS);
      if (!up && !recent) return;
      const when = dayLabel(t.date);
      const route = routeLine(t);
      const first = firstOf(t) || 'Tu conductor';
      const add = (type, estado, o) => out.push(Object.assign({
        id: type + ':' + t.id + ':' + estado, kind: 'trip', rank: 5, when, ts, tripId: t.id,
      }, o));
      if (t.status === 'cancelled') {
        add('cancel', 'cancelled', { icon: 'X', tone: 'error', title: 'Traslado cancelado', body: route + (t.cancelReason ? ' · ' + t.cancelReason : '') });
      } else if (t.status === 'noshow') {
        add('noshow', 'noshow', { icon: 'AlertTriangle', tone: 'warn', title: 'Quedó como no presentado', body: route + ' · Si fue un error, escríbele a Coordinación.' });
      } else if (up && (t.status === 'onway' || t.status === 'assigned') && arrived(t)) {
        const code = String(t.meetCode || (t._info && t._info.meet_code) || '');
        add('arrived', 'arrived', { rank: 0, icon: 'MapPin', tone: 'ok', title: first + ' llegó por ti', body: code ? 'Código de encuentro ' + code : route });
      } else if (up && t.status === 'onway') {
        add('onway', 'onway', { rank: 1, icon: 'Car', tone: 'ok', title: first + ' va por ti', body: [plateOf(t), route].filter(Boolean).join(' · ') });
      } else if (up && t.status === 'assigned' && isPublished(t)) {
        const pk = t.pickupAt && hm(t.pickupAt);
        const hora = pk ? (t.type === 'lle' ? 'Te esperamos en MDE a las ' + pk : 'Te recogemos a las ' + pk) : 'Hora de recogida por confirmar';
        add('pub', 'assigned' + (pk ? '@' + t.pickupAt : ''), {
          icon: 'Car', tone: 'ok', title: 'Ya tienes conductor',
          body: [(t.driver && t.driver.name) || '', hora, route].filter(Boolean).join(' · '),
        });
      }
      if (t.level === 'private' && t.status !== 'cancelled' && (t.privateStatus === 'approved' || t.privateStatus === 'rejected')) {
        if (t.privateStatus === 'approved') {
          add('priv', 'approved', { icon: 'Sparkle', tone: 'ok', title: 'Tu traslado privado está confirmado', body: route });
        } else {
          add('priv', 'rejected', { icon: 'Info', tone: 'warn', title: 'Tu privado no se pudo confirmar', body: (t.privateReason ? t.privateReason + '. ' : '') + 'Sigue como compartido.' });
        }
      }
      const n = chat.counts[t.id] || 0;
      if (n > 0) {
        out.push({
          id: 'chat:' + t.id + ':' + n, kind: 'msg', rank: 2, when, ts, tripId: t.id, icon: 'MessageCircle', tone: 'info',
          title: n === 1 ? 'Tienes un mensaje sin leer' : 'Tienes ' + n + ' mensajes sin leer', body: 'Del traslado · ' + route,
        });
      }
    });
    const cu = coordUnread();
    if (cu > 0) {
      out.push({
        id: 'coord', kind: 'msg', rank: 3, coord: true, when: '', ts: now, icon: 'Headset', tone: 'info',
        title: 'Coordinación te escribió', body: cu === 1 ? 'Un mensaje sin leer' : cu + ' mensajes sin leer',
      });
    }
    // Pagos: lo que registre el Facturario.
    const sh = SH();
    const srcs = sh && typeof sh.hooks === 'function' ? (safe(() => sh.hooks('avisos.source', { state: auxSt(), shell: sh }), []) || []) : [];
    srcs.forEach(h => {
      const l = safe(() => (typeof h.list === 'function' ? h.list({ state: auxSt(), shell: sh }) : []), []) || [];
      l.forEach(x => {
        if (!x || !x.title) return;
        out.push({
          id: 'pay:' + (x.id != null ? x.id : x.title), kind: 'pay', rank: 4, when: x.when || '', ts: now,
          icon: x.icon || 'Wallet', tone: x.tone || 'info', title: x.title, body: x.body || '', go: typeof x.go === 'function' ? x.go : null,
        });
      });
    });
    const seen = new Set(seenList());
    out.forEach(x => { x.unseen = x.coord ? true : !seen.has(x.id); });
    return out.sort((a, b) => (b.unseen - a.unseen) || (a.rank - b.rank)
      || (Math.abs((a.ts == null ? now : a.ts) - now) - Math.abs((b.ts == null ? now : b.ts) - now)));
  }
  const hasPay = () => {
    const sh = SH();
    return !!(sh && typeof sh.hooks === 'function' && (safe(() => sh.hooks('avisos.source', { state: auxSt(), shell: sh }), []) || []).length);
  };
  // Lo que suma a la campana (sin Coordinación: ese lo suma Inicio aparte).
  function unseen() { return derive().filter(x => !x.coord && x.unseen).length; }
  function bell() { return unseen() + coordUnread(); }

  // ── Pantalla «notifs» ────────────────────────────────────────────────────
  let filter = 'all';
  let dots = new Set();     // no leídos AL ABRIR: su punto se ve durante la visita
  let shown = [];           // los avisos pintados, por índice (para el toque)
  function opts() {
    const o = [['all', 'Todas'], ['trip', 'Viajes'], ['msg', 'Mensajes']];
    if (hasPay()) o.push(['pay', 'Pagos']);
    return o;
  }
  function bodyInner(list) {
    if (!list.length) return '<div class="rx-empty">' + ic('Check', 26) + '<b>Todo al día</b></div>';
    return list.map((n, i) => '<button type="button" class="rx-nt rx-in" style="--d:' + Math.min(i, 8) + '" data-rx="notifs-open" data-i="' + i + '">'
      + '<span class="rx-nt-ic t-' + esc(n.tone) + '">' + ic(n.icon, 17) + '</span>'
      + '<span class="rx-nt-tx"><b>' + esc(n.title) + '</b>' + (n.body ? '<span>' + esc(n.body) + '</span>' : '') + (n.when ? '<em>' + esc(n.when) + '</em>' : '') + '</span>'
      + ((n.coord || dots.has(n.id)) ? '<i class="rx-unread"></i>' : '')
      + '</button>').join('');
  }
  function current(all) {
    const o = opts();
    if (!o.some(x => x[0] === filter)) filter = 'all';
    shown = (all || derive()).filter(x => filter === 'all' || x.kind === filter);
    return shown;
  }
  function html() {
    const u = UI();
    const all = derive();
    all.forEach(x => { if (x.unseen && !x.coord) dots.add(x.id); });
    const list = current(all);
    const head = u && u.head ? u.head({ title: 'Notificaciones' }) : '<div class="rx-head"><div class="rx-head-row"><button type="button" class="rx-ib" data-rx="rx-pop">‹</button><div class="rx-head-c"><b>Notificaciones</b></div><div class="rx-head-r"></div></div></div>';
    const seg = u && u.seg ? u.seg(filter, opts(), { name: 'notifs', action: 'notifs-seg' }) : '';
    return '<div class="rx-scr">' + head
      + '<div class="rx-px">' + seg + '</div>'
      + '<div class="rx-body" data-f="' + filter + '">' + bodyInner(list) + '</div>'
      + '</div>';
  }
  function markAllSeen() {
    const ids = derive().filter(x => !x.coord).map(x => x.id);
    markSeen(ids);
    const i = IN(); if (i && typeof i.refreshBell === 'function') safe(() => i.refreshBell(), null);
  }

  function segAct(el) {
    const v = el && el.getAttribute('data-v');
    if (!v || !opts().some(o => o[0] === v)) return;
    const u = UI();
    if (u && u.segSet) u.segSet(el, v);
    if (v === filter) return;
    filter = v;
    const scr = el.closest('.rx-scr');
    const body = scr && scr.querySelector('.rx-body');
    if (!body) { const sh = SH(); if (sh) sh.render(); return; }
    // key={f}: el cuerpo se recrea y sus avisos vuelven a entrar.
    const n = document.createElement('div');
    n.className = 'rx-body rx-anim';
    n.setAttribute('data-f', v);
    n.innerHTML = bodyInner(current());
    body.replaceWith(n);
  }
  function openAct(el) {
    const n = shown[Number(el && el.getAttribute('data-i'))];
    if (!n) return;
    const sh = SH();
    const a = AX();
    if (n.kind === 'pay') {
      if (n.go) { safe(() => n.go(), null); return; }
      if (sh && typeof sh.setTab === 'function') sh.setTab('pay');
      return;
    }
    if (sh && typeof sh.pop === 'function') sh.pop();
    setTimeout(() => {
      if (n.coord) { if (sh && typeof sh.push === 'function') sh.push('coord', {}); return; }
      if (n.tripId && a && typeof a.openTrip === 'function') a.openTrip(n.tripId);
    }, POP_PUSH_MS);
  }

  let lastHTML = null;
  const screen = {
    render(ctx) {
      if (ctx && ctx.reason === 'enter') { dots = new Set(); filter = 'all'; }
      lastHTML = html();
      return lastHTML;
    },
    after(ctx) {
      markAllSeen();
      if (ctx && ctx.reason === 'enter') refresh(true);
    },
    patch() { return html() === lastHTML; },
  };

  window.AuxRxAvisos = { unseen, bell, list: derive, refresh, markAllSeen, SEEN_KEY };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('notifs', screen);
    sh.action('notifs-seg', segAct);
    sh.action('notifs-open', openAct);
  }
})();
