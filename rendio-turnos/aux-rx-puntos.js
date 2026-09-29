// aux-rx-puntos.js — P13b · Puntos e Invitar del rediseño del auxiliar (27-sep-2026).
//
// Porta RxPoints, RxInvite y RX_SHELF de rx-me.jsx, y la billetera (rx-pocket)
// y el bono (rx-bono) de rx-home.jsx, con el MISMO marcado y las MISMAS clases
// (rx-pts-hero, rx-pts-n, rx-pts-bar, rx-seg, rx-list, rx-shelf, rx-plus,
// rx-minus, rx-note, rx-over, rx-confetti, rx-check, rx-inv-hero, rx-bono-dots,
// rx-code, rx-share, rx-lbl, rx-group, rx-goal, rx-pocket, rx-bono, rx-sh).
// Lo que el diseño no trae (espera, error, «Pronto», subtítulo del héroe) va en
// rx-aux-puntos.css.
//
// APAGADO por defecto (AJUSTES §4 y §6): con app_settings.aux_points_enabled en
// false no aparece nada en Inicio y el Perfil dice «Pronto» (lo pinta P7).
//
// Datos: SOLO lo que devuelve ApiPuntos (0091). Nada inventado:
//   · la vitrina es aux_points_rewards (Directo sale «Pronto»: no existe el nivel);
//   · el héroe apunta al canje más barato que aún no alcanzas (nextReward), no a
//     un «traslado Directo» fijo;
//   · el bono «3 de 4 · te falta 1 colega para un privado» NO existe como regla:
//     su tarjeta queda como la entrada a Invitar, con lo real (cuántos se
//     registraron con tu código y cuántos ya viajaron);
//   · «Invitaste a» es SOLO quien se registró con tu código (nombre + inicial);
//   · la meta del conjunto es un número anónimo con el texto que escribe el jefe;
//   · un canje queda PENDIENTE hasta que Coordinación lo aplica (no «lo verás en
//     tu próximo traslado»).
//
// Contrato (AJUSTES §8):
//   window.AuxPuntos = { enabled() → bool, summary() → null | {balance,
//     nextRewardPts, nextRewardName, …}, cancelBonus(t) → null | {pts} }
//   + load({force}) → Promise, y para pruebas pointsHTML/inviteHTML/pocketHTML.
//   Registra las pantallas 'points' e 'invite', el enganche 'home.hook'
//   (prioridad 20: uno solo a la vez con Select, D15) y las acciones data-rx
//   pts-open, inv-open, pts-seg, pts-redeem, pts-redeem-go, pts-party-close,
//   pts-retry, inv-copy, inv-wa, inv-share, inv-retry.
//
// Animaciones (ANIMACIONES §2, §4, §5), idénticas al diseño:
//   · entradas .rx-in con los mismos --d; RxCount 800 ms desde 0 (AuxRxUI.countUp);
//   · el segmentado mueve su indicador sin repintar y la lista se RECREA
//     (key={tab}); canje → hoja se cierra (220 ms) → fiesta a los 240 ms;
//   · lo que llega de la red se concilia por data-k: lo que ya estaba se
//     actualiza EN SU LUGAR (no vuelve a entrar) y lo nuevo entra con .rx-anim,
//     como React con keys.
(function () {
  'use strict';

  const TTL = 60000;                       // mismo ritmo que el refresco del shell
  const PARTY_MS = 240;                    // canje → fiesta (ANIMACIONES §4)
  const PARTY_COLORS = ['#6A3FC0', '#8A63DC', '#F26522', '#C7A971'];
  const TZ = 'America/Bogota';

  const UI = () => window.AuxRxUI || null;
  const SH = () => window.AuxShell || null;
  const AX = () => window.Auxiliar || null;
  const AP = () => window.ApiPuntos || null;
  const PUB = () => window.AuxPuntos || null;   // lo público (el arnés puede reemplazarlo)

  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s, cls, style) => { const u = UI(); return u && u.ic ? u.ic(n, s, cls, style) : ''; };
  const num = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
  const lowerFirst = (s) => {
    s = String(s || '');
    // «Un traslado Privado» → «un traslado Privado»; siglas (dos mayúsculas) quedan.
    return /^[A-ZÁÉÍÓÚÑ][^A-ZÁÉÍÓÚÑ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  };
  function btn(label, o) {
    const u = UI(); if (u && u.btn) return u.btn(label, o);
    return '<button type="button" class="rx-btn ' + ((o && o.kind) || 'pri') + '">' + esc(label) + '</button>';
  }
  // RxPts({n, size}) — mismo marcado: React escribe size*.55 con «px» y sin redondear.
  function ptsHTML(n, size) {
    size = size == null ? 15 : size;
    const w = String(size * 0.55) + 'px';
    return '<span class="rx-pts" style="font-size:' + size + 'px"><i style="width:' + w + ';height:' + w + '"></i>' + esc(n) + ' pts</span>';
  }

  // ════════════════════════════════════════════════════════════════════════
  // Caché: resumen + vitrina (lo leen Inicio y Perfil de forma SÍNCRONA)
  // ════════════════════════════════════════════════════════════════════════
  // summary: undefined = nunca se pidió · null = sin dato (sin 0091, sin sesión,
  // no es tripulante) · objeto = el de ApiPuntos.summary(). Igual rewards.
  const C = { pid: undefined, summary: undefined, rewards: undefined, at: 0, err: false, inflight: null };

  function profileId() {
    const a = AX();
    const p = a && a.state && a.state.profile;
    return p && p.id ? String(p.id) : null;
  }
  // Otra cuenta en el mismo teléfono: nada de lo de la anterior se queda.
  function checkPid() {
    const p = profileId();
    if (p === C.pid) return;
    C.pid = p; C.summary = undefined; C.rewards = undefined; C.at = 0; C.err = false;
    INV.code = undefined; INV.refs = undefined; INV.goal = undefined;
    PT.moves = undefined; PT.reds = undefined; PT.lastBal = undefined;
  }
  function cacheSig() {
    return JSON.stringify([C.summary === undefined ? 'u' : C.summary, C.rewards === undefined ? 'u' : C.rewards]);
  }
  function call(fn, args) {
    return Promise.resolve().then(() => (typeof fn === 'function' ? fn.apply(null, args || []) : null));
  }
  // load({force}) → Promise<bool enabled>. Una sola carga a la vez.
  function load(o) {
    o = o || {};
    checkPid();
    if (C.inflight) return C.inflight;
    if (!o.force && C.at && Date.now() - C.at < TTL) return Promise.resolve(enabledRaw());
    const P = AP();
    if (!P) { C.summary = null; C.rewards = null; C.at = Date.now(); return Promise.resolve(false); }
    const before = cacheSig();
    const pid = C.pid;
    C.inflight = Promise.all([
      call(P.summary).then(v => ({ v }), e => ({ e })),
      call(P.rewards).then(v => ({ v }), e => ({ e })),
    ]).then(([s, r]) => {
      C.inflight = null;
      if (pid !== C.pid) return enabledRaw();         // cambió la cuenta en el camino
      C.at = Date.now();
      // Un error de red NO borra lo que ya había: se sigue mostrando lo último.
      if (s.e) C.err = true; else { C.err = false; C.summary = s.v || null; }
      if (!r.e) C.rewards = Array.isArray(r.v) ? r.v : null;
      else if (C.rewards === undefined) C.rewards = null;
      if (s.e && C.summary === undefined) C.summary = null;
      if (cacheSig() !== before) changed();
      return enabledRaw();
    });
    return C.inflight;
  }
  function kick() {
    checkPid();
    if (!C.inflight && (!C.at || Date.now() - C.at >= TTL) && AP()) load();
  }
  // Algo cambió en la caché: la pantalla de arriba se pone al día (Inicio compara
  // su firma, Perfil parcha sus filas, las nuestras concilian por data-k).
  function changed() {
    refreshPoints();
    refreshInvite();
    // Solo Inicio y Perfil muestran la caché fuera de nuestras pantallas; las
    // demás la leen al volver a quedar arriba (el shell las repinta).
    const sh = SH();
    const top = sh && typeof sh.on === 'function' && safe(() => sh.on(), false) ? safe(() => sh.current(), null) : null;
    if (top && (top.id === 'home' || top.id === 'me')) {
      try { sh.render(); } catch (e) { console.error('[AuxPuntos] repintar falló:', e); }
    }
  }

  function enabledRaw() {
    const s = C.summary;
    if (s) return s.enabled === true;
    if (s === undefined) {
      // Mientras llega el resumen: el interruptor de app_settings si ya lo trajo
      // Api.getSettings (core.js). Si no lo trajo, apagado.
      // eslint-disable-next-line no-undef
      const g = typeof state !== 'undefined' ? state : null;
      return !!(g && g.settings && g.settings.aux_points_enabled === true);
    }
    return false;
  }
  function enabled() { kick(); return enabledRaw(); }

  // Las ayudas puras de ApiPuntos son síncronas; si alguien las cambió por otra
  // cosa (el arnés de escenarios las vuelve promesas), se usa la regla local,
  // que es la misma: el canje más barato que aún no alcanzas, sin «Pronto».
  const isPromise = (v) => !!(v && typeof v.then === 'function');
  function nextRewardOf(bal, list) {
    const P = AP();
    const r = P && typeof P.nextReward === 'function' ? safe(() => P.nextReward(bal, list), undefined) : undefined;
    if (r === null) return null;
    if (r && !isPromise(r) && num(r.cost) != null) return r;
    const n = (list || []).filter(x => x && x.enabled && !x.soon && num(x.cost) != null).sort((a, z) => a.cost - z.cost).find(x => x.cost > bal);
    return n ? { id: n.id, title: n.title, cost: n.cost, missing: n.cost - bal } : null;
  }
  function strHelper(name, arg, fb) {
    const P = AP();
    const v = P && typeof P[name] === 'function' ? safe(() => P[name](arg), null) : null;
    return typeof v === 'string' && v ? v : fb;
  }

  // Vitrina que se puede canjear hoy (sin «Pronto» ni apagados), de menor a mayor.
  function availRewards() {
    const list = Array.isArray(C.rewards) ? C.rewards : null;
    if (!list) return null;
    return list.filter(r => r && r.enabled && !r.soon && num(r.cost) != null).sort((a, z) => a.cost - z.cost);
  }
  function summary() {
    if (!enabled()) return null;
    const s = C.summary;
    if (!s) return null;
    const bal = num(s.balance) || 0;
    const nx = Array.isArray(C.rewards) ? nextRewardOf(bal, C.rewards) : null;
    const v = s.values || {};
    return {
      balance: bal,
      nextRewardPts: nx ? nx.cost : null,
      nextRewardName: nx ? lowerFirst(nx.title) : null,
      pendingCount: num(s.pendingCount) || 0,
      pendingPoints: num(s.pendingPoints) || 0,
      earnedTotal: num(s.earnedTotal) || 0,
      invitedCount: num(s.invitedCount) || 0,
      invitedDone: num(s.invitedDone) || 0,
      values: {
        invite: num(v.invite) || 0, neighbor: num(v.neighbor) || 0, cancel: num(v.cancel) || 0,
        cancelLeadHours: num(v.cancelLeadHours) || 2, rate: num(v.rate) || 0,
      },
    };
  }
  // ¿Cancelar ESTE viaje ahora suma? Misma regla que el trigger (ApiPuntos.cancelEarns).
  function cancelBonus(t) {
    if (!t || !enabled()) return null;
    const P = AP(), s = C.summary;
    if (!P || typeof P.cancelEarns !== 'function' || !s) return null;
    const pts = safe(() => P.cancelEarns(t, { enabled: true, values: s.values || {} }), null);
    return typeof pts === 'number' && pts > 0 ? { pts: pts } : null;
  }

  // Lo público leído a través de window.AuxPuntos (el arnés de escenarios lo cambia).
  function pubEnabled() { const p = PUB(); return !!(p && typeof p.enabled === 'function' && safe(() => p.enabled(), false)); }
  function pubSummary() { const p = PUB(); return p && typeof p.summary === 'function' ? safe(() => p.summary(), null) : null; }
  function pubValues() {
    const s = pubSummary();
    if (s && s.values) return s.values;
    const c = C.summary;
    return c && c.values ? c.values : null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Conciliar por data-k (React con keys, sin React)
  // ════════════════════════════════════════════════════════════════════════
  // El nodo que sigue (misma key) se actualiza EN SU LUGAR: sus animaciones no
  // vuelven a correr. El que aparece entra con .rx-anim (su entrada corre aunque
  // la capa tenga .rx-noanim). El que se va, se quita.
  const KEEP_CLS = ['rx-anim', 'rx-noanim'];
  function morph(o, n) {
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) {
      if (n.nodeType === 1) n.classList.add('rx-anim');
      o.replaceWith(n);
      return n;
    }
    if (o.nodeType === 3 || o.nodeType === 8) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return o; }
    if (o.nodeType !== 1) return o;
    const keep = KEEP_CLS.filter(c => o.classList.contains(c));
    [...o.attributes].forEach(a => { if (!n.hasAttribute(a.name)) o.removeAttribute(a.name); });
    [...n.attributes].forEach(a => { if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value); });
    keep.forEach(c => o.classList.add(c));
    // La cifra que cuenta (RxCount): si el valor no cambió, su texto es del contador.
    if (o.hasAttribute('data-pts-n') && o.__rxPtsV != null && String(o.__rxPtsV) === o.getAttribute('data-pts-n')) return o;
    if ([...n.children].some(c => c.hasAttribute('data-k'))) { reconcile(o, n); return o; }
    const oc = [...o.childNodes], nc = [...n.childNodes];
    for (let i = 0; i < nc.length; i++) {
      if (oc[i]) morph(oc[i], nc[i]);
      else { if (nc[i].nodeType === 1) nc[i].classList.add('rx-anim'); o.appendChild(nc[i]); }
    }
    for (let i = nc.length; i < oc.length; i++) oc[i].remove();
    return o;
  }
  function reconcile(box, fresh) {
    const byKey = new Map();
    [...box.children].forEach(o => { const k = o.getAttribute('data-k'); if (k != null) byKey.set(k, o); });
    const out = [...fresh.children].map(n => {
      const k = n.getAttribute('data-k');
      const o = k != null ? byKey.get(k) : null;
      if (o) { byKey.delete(k); return morph(o, n); }
      n.classList.add('rx-anim');
      return n;
    });
    [...box.children].forEach(o => { if (!out.includes(o)) o.remove(); });
    out.forEach((n, i) => { if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null); });
  }
  function parse(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }
  function isTop(id) { const sh = SH(); const c = sh && safe(() => sh.current(), null); return !!(c && c.id === id); }

  // RxCount: 800 ms desde 0 al montar, y desde 0 otra vez si cambia la cifra.
  function countEl(el, v) {
    const u = UI();
    if (!el || v == null) return;
    if (u && u.countUp) u.countUp(el, v);
    else el.textContent = String(v);
    el.__rxPtsV = v;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Pantalla «points» (RxPoints)
  // ════════════════════════════════════════════════════════════════════════
  const PT = { tab: 'use', moves: undefined, reds: undefined, movesReq: 0, movesBusy: false, busy: null, party: null, lastBal: undefined, host: null, partyT: null };
  const TABS = [['use', 'Canjear'], ['earn', 'Ganar'], ['log', 'Movimientos']];
  const RW_IC = { colega: 'Users', directo: 'ArrowRight', mensual: 'Wallet', privado: 'Sparkle' };
  const KIND_IC = { guest_seat: 'Users', direct_trip: 'ArrowRight', billing_days: 'Wallet', private_trip: 'Sparkle' };
  const rwIcon = (r) => RW_IC[r.id] || KIND_IC[r.kind] || 'Gift';

  function heroHTML(s) {
    const bal = s ? num(s.balance) : null;
    const rw = availRewards();
    let pct = null, sub = '';
    if (bal == null) sub = s === undefined ? 'Cargando tu saldo…' : 'Todavía no hay datos de tu saldo';
    else {
      const nxPts = num(s.nextRewardPts);
      if (nxPts != null && nxPts > bal) {
        pct = Math.min(100, (bal / nxPts) * 100);
        sub = 'Te faltan ' + (nxPts - bal) + ' pts para ' + lowerFirst(s.nextRewardName || 'tu próximo canje');
      } else if (rw && rw.length) {
        pct = 100;
        sub = 'Te alcanza para cualquier canje de la vitrina';
      }
    }
    return '<div class="rx-pts-hero rx-in" data-k="hero">'
      + '<span class="rx-pts-l" data-k="l">Tu saldo</span>'
      + '<div class="rx-pts-n" data-k="n"><i></i><b data-pts-n="' + (bal == null ? '' : bal) + '">' + (bal == null ? '—' : bal) + '</b><span>pts</span></div>'
      + (pct != null ? '<div class="rx-pts-bar" data-k="bar"><i style="width:' + pct + '%"></i></div>' : '')
      + (sub ? '<span class="rx-pts-s" data-k="sub">' + esc(sub) + '</span>' : '')
      + '</div>';
  }
  function waitRow(k, text, retry) {
    return '<div class="rx-pts-wait" data-k="' + k + '">' + ic('Info', 15) + '<span>' + esc(text) + '</span>'
      + (retry ? '<button type="button" data-rx="' + retry + '">Reintentar</button>' : '') + '</div>';
  }
  function useRows(bal) {
    const list = Array.isArray(C.rewards) ? C.rewards.filter(r => r && (r.enabled || r.soon)).sort((a, z) => (a.sort || 0) - (z.sort || 0)) : C.rewards;
    if (list === undefined) return waitRow('w-use', 'Cargando la vitrina…');
    if (!list) return waitRow('w-use', C.err ? 'No pudimos cargar la vitrina.' : 'La vitrina todavía no está disponible.', C.err ? 'pts-retry' : '');
    if (!list.length) return waitRow('w-use', 'Por ahora no hay canjes en la vitrina.');
    return list.map((r, i) => {
      const soon = !!r.soon || !r.enabled;
      const ok = !soon && bal != null && bal >= r.cost;
      const busy = PT.busy === r.id;
      return '<div class="rx-shelf rx-in ' + (ok ? '' : 'no') + '" style="--d:' + i + '" data-k="rw-' + esc(r.id) + '">'
        + '<span class="rx-row-ic t-pts">' + ic(rwIcon(r), 19) + '</span>'
        + '<span class="rx-row-tx"><b>' + esc(r.title) + '</b><span>' + esc(r.description || '') + '</span></span>'
        + (soon
          ? '<button type="button" disabled class="rx-pts-soon"><span>Pronto</span></button>'
          : '<button type="button"' + (ok && !busy ? '' : ' disabled') + ' data-rx="pts-redeem" data-id="' + esc(r.id) + '">' + ptsHTML(r.cost, 12) + '</button>')
        + '</div>';
    }).join('');
  }
  function earnRows() {
    const v = pubValues();
    if (!v) return waitRow('w-earn', C.summary === undefined ? 'Cargando…' : 'Todavía no hay datos de cuánto vale cada acción.');
    const inv = num(v.invite) || 0, nb = num(v.neighbor) || 0, can = num(v.cancel) || 0, rate = num(v.rate) || 0;
    const lead = num(v.cancelLeadHours) || 2;
    const rows = [];
    if (inv > 0) rows.push(['Users', 'Invitas a un colega', 'Cuando hace su primer viaje.' + (nb > inv ? ' Si vive en tu conjunto: ' + nb + '.' : ''), inv, 'e-inv']);
    if (can > 0) rows.push(['Bell', 'Avisas a tiempo que no viajas', 'Cancelas con ' + lead + ' h o más de anticipación y con tu hora de recogida ya publicada.', can, 'e-can']);
    if (rate > 0) rows.push(['Star', 'Calificas tu viaje', 'Nos ayuda a cuidar a los conductores buenos.', rate, 'e-rate']);
    if (!rows.length) return waitRow('w-earn', 'Por ahora ninguna acción suma puntos.');
    return rows.map(([i1, t, d, n, k], i) => '<div class="rx-shelf rx-in" style="--d:' + i + '" data-k="' + k + '">'
      + '<span class="rx-row-ic t-pts">' + ic(i1, 19) + '</span>'
      + '<span class="rx-row-tx"><b>' + esc(t) + '</b><span>' + esc(d) + '</span></span>'
      + '<em class="rx-plus">+' + n + '</em></div>').join('');
  }
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function bogDay(v) {
    const u = UI(); if (u && u.bogDay) return u.bogDay(v);
    try { return new Date(v).toLocaleDateString('en-CA', { timeZone: TZ }); } catch (_) { return ''; }
  }
  function addDay(day, n) {
    const p = day.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10);
  }
  // «hoy» · «ayer» · «mar 7 oct» (como la lista de Movimientos del diseño).
  function whenLabel(iso, now) {
    const d = bogDay(iso);
    if (!d) return '';
    const today = bogDay(now || new Date());
    if (d === today) return 'hoy';
    if (d === addDay(today, -1)) return 'ayer';
    const p = d.split('-').map(Number);
    return WD[new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay()] + ' ' + p[2] + ' ' + MO[p[1] - 1];
  }
  const RED_ST = { pending: 'por aplicar', fulfilled: 'aplicado', rejected: 'rechazado' };
  function logRows() {
    const m = PT.moves;
    if (m === undefined) return waitRow('w-log', 'Cargando tus movimientos…');
    if (m === 'err') return waitRow('w-log', 'No pudimos cargar tus movimientos.', 'pts-retry');
    if (m === null) return waitRow('w-log', 'Tus movimientos todavía no están disponibles.');
    if (!m.length) return waitRow('w-log', 'Todavía no tienes movimientos.');
    const reds = Array.isArray(PT.reds) ? PT.reds : [];
    return m.map((x, i) => {
      const n = num(x.points) || 0;
      const parts = [];
      if (x.sub) parts.push(x.sub);
      if (x.kind === 'redeem' && x.redemptionId) {
        const r = reds.find(y => y.id === x.redemptionId);
        if (r && RED_ST[r.status]) parts.push(RED_ST[r.status]);
      }
      const w = whenLabel(x.at);
      if (w) parts.push(w);
      return '<div class="rx-shelf rx-in" style="--d:' + Math.min(i, 8) + '" data-k="m-' + esc(x.id) + '">'
        + '<span class="rx-row-tx"><b>' + esc(x.title) + '</b><span>' + esc(parts.join(' · ')) + '</span></span>'
        + '<em class="' + (n > 0 ? 'rx-plus' : 'rx-minus') + '">' + (n > 0 ? '+' : '') + n + '</em></div>';
    }).join('');
  }
  function listHTML(tab, bal) {
    const inner = tab === 'use' ? useRows(bal) : tab === 'earn' ? earnRows() : logRows();
    return '<div class="rx-list" data-v="' + tab + '" data-k="list-' + tab + '">' + inner + '</div>';
  }
  function partyHTML(p) {
    const u = UI();
    return '<div class="rx-over pts" data-rx="pts-party-close">'
      + (u && u.confetti ? u.confetti(26, PARTY_COLORS) : '')
      + '<div class="rx-over-c">' + (u && u.check ? u.check('pts') : '')
      + '<h2>¡Canjeado!</h2>'
      + '<p>' + esc(p.title) + '. Coordinación lo aplica; el estado lo ves en Movimientos.</p>'
      + btn('Genial', { kind: 'pts', attrs: { 'data-rx': 'pts-party-close' } })
      + '</div></div>';
  }
  function pointsBodyInner() {
    const u = UI();
    if (!pubEnabled()) {
      return '<div class="rx-empty" data-k="off">' + ic('Gift', 28) + '<b>Rendio Points todavía no está disponible</b>'
        + '<span>Cuando la operación lo encienda, aquí ves tus puntos y la vitrina.</span></div>';
    }
    const s = pubSummary();
    const sArg = s || (C.summary === undefined && !C.at ? undefined : null);
    const bal = s ? num(s.balance) : null;
    return heroHTML(sArg)
      + (u && u.seg ? u.seg(PT.tab, TABS, { name: 'pts', action: 'pts-seg', attrs: { 'data-k': 'seg' } }) : '')
      + listHTML(PT.tab, bal)
      + '<div class="rx-note" data-k="note">' + ic('Info', 15) + 'Los puntos no son plata: no se retiran ni se transfieren.</div>';
  }
  function pointsHTML() {
    const u = UI();
    const head = u && u.head ? u.head({ title: 'Puntos Rendio' }) : '';
    return '<div class="rx-scr">' + head
      + '<div class="rx-body">' + pointsBodyInner() + '</div>'
      + (PT.party ? partyHTML(PT.party) : '')
      + '</div>';
  }
  function freshBody() { return parse('<div class="rx-body">' + pointsBodyInner() + '</div>').firstElementChild; }
  // RxCount del héroe: al montar la pantalla, o cuando cambia la cifra (desde 0,
  // useEffect [to]). Un repintado con la misma cifra la deja quieta.
  function heroCount(root, mount) {
    const b = root && root.querySelector('.rx-pts-n b[data-pts-n]');
    if (!b) return;
    const v = num(b.getAttribute('data-pts-n'));
    if (v == null) { PT.lastBal = undefined; return; }
    if (mount || PT.lastBal !== v) countEl(b, v);
    else b.__rxPtsV = v;
    PT.lastBal = v;
  }
  // Pone la pantalla al día sin repintarla. false = no está montada.
  function patchPoints(host) {
    host = host || PT.host;
    if (!host || !host.isConnected) return false;
    const body = host.querySelector('.rx-scr > .rx-body');
    if (!body) return false;
    reconcile(body, freshBody());
    heroCount(host);
    return true;
  }
  function refreshPoints() {
    if (!PT.host || !PT.host.isConnected) return;
    patchPoints(PT.host);
    if (PT.moves === undefined && !PT.movesBusy && pubEnabled()) loadMoves();
  }

  function loadMoves() {
    const P = AP();
    const req = ++PT.movesReq;
    if (!P) { PT.moves = null; PT.reds = null; refreshPoints(); return Promise.resolve(); }
    PT.movesBusy = true;
    return Promise.all([
      call(P.movements, [{ limit: 50 }]).then(v => (Array.isArray(v) ? v : null), () => 'err'),
      call(P.myRedemptions).then(v => (Array.isArray(v) ? v : null), () => null),
    ]).then(([m, r]) => {
      if (req !== PT.movesReq) return;
      PT.movesBusy = false;
      PT.moves = m; PT.reds = r;
      refreshPoints();
    });
  }

  const POINTS = {
    render(ctx) {
      if (ctx && ctx.reason === 'enter') {
        // useState('use') y sin fiesta: cada vez que la pantalla se monta.
        PT.tab = 'use'; PT.party = null; PT.busy = null; PT.lastBal = undefined;
        clearTimeout(PT.partyT);
      }
      return pointsHTML();
    },
    after(ctx) {
      PT.host = ctx.host;
      if (ctx.reason === 'enter') {
        PT.lastBal = undefined;
        heroCount(ctx.host, true);
        PT.moves = PT.moves === 'err' ? undefined : PT.moves;
        load({ force: true }).then(() => refreshPoints());
        if (pubEnabled()) loadMoves();
      } else heroCount(ctx.host);
    },
    patch(ctx) { return patchPoints(ctx.host); },
    destroy(ctx) {
      if (ctx && ctx.reason === 'leave') {
        PT.host = null; PT.party = null; PT.busy = null;
        clearTimeout(PT.partyT);
      }
    },
  };

  // Segmentado: el indicador se desliza (segSet) y la lista se RECREA (key={tab}).
  function segAct(el) {
    const v = el && el.getAttribute('data-v');
    if (!v || !TABS.some(t => t[0] === v)) return;
    const u = UI();
    if (u && u.segSet) u.segSet(el, v);
    if (v === PT.tab) return;
    PT.tab = v;
    const scr = el.closest('.rx-scr');
    const old = scr && scr.querySelector('.rx-body > .rx-list');
    if (!old) { patchPoints(); return; }
    const s = pubSummary();
    const n = parse(listHTML(v, s ? num(s.balance) : null)).firstElementChild;
    n.classList.add('rx-anim');
    old.replaceWith(n);
    if (v === 'log' && (PT.moves === undefined || PT.moves === 'err')) loadMoves();
  }

  function findReward(id) { return Array.isArray(C.rewards) ? C.rewards.find(r => r && r.id === id) || null : null; }
  function redeemSheetHTML(r, bal) {
    const left = bal - r.cost;
    return '<div class="rx-sh" data-pts-sheet="' + esc(r.id) + '">'
      + '<div class="rx-sh-ic pts">' + ic(rwIcon(r), 24) + '</div>'
      + '<h3>' + esc(r.title) + '</h3>'
      + '<p>' + esc(String(r.description || '').replace(/\.\s*$/, '')) + '. Se descuentan <b>' + esc(r.cost) + ' pts</b> y te quedan ' + esc(left) + '.</p>'
      + '<div class="rx-pts-err" hidden></div>'
      + btn('Canjear por ' + r.cost + ' pts', { kind: 'pts', attrs: { 'data-rx': 'pts-redeem-go', 'data-id': r.id } })
      + btn('Ahora no', { kind: 'ghost', attrs: { 'data-rx': 'sheet-close' } })
      + '</div>';
  }
  function redeemAct(el) {
    const r = findReward(el && el.getAttribute('data-id'));
    const s = pubSummary();
    const bal = s ? num(s.balance) : null;
    const sh = SH();
    if (!r || bal == null || bal < r.cost || r.soon || !r.enabled || !sh) return;
    sh.sheet(redeemSheetHTML(r, bal));
  }
  async function redeemGo(el) {
    const id = el && el.getAttribute('data-id');
    const r = findReward(id);
    const P = AP(), sh = SH();
    if (!r || PT.busy || !sh) return;
    const box = el.closest('.rx-sh');
    const err = box && box.querySelector('.rx-pts-err');
    const label = el.textContent;
    PT.busy = id;
    el.disabled = true;
    el.textContent = 'Canjeando…';
    if (err) { err.hidden = true; err.textContent = ''; }
    let res = null, msg = '';
    try {
      res = P && typeof P.redeem === 'function' ? await P.redeem(id) : null;
      if (!res || !res.ok) msg = 'Rendio Points todavía no está disponible';
    } catch (e) { msg = (e && e.message) || 'No pudimos hacer el canje'; }
    PT.busy = null;
    if (msg) {
      el.disabled = false;
      el.textContent = label;
      if (err) { err.textContent = msg; err.hidden = false; }
      return;
    }
    // El saldo que devolvió la base (no se resta a ojo).
    if (C.summary) {
      C.summary.balance = num(res.balance) != null ? num(res.balance) : C.summary.balance;
      C.summary.pendingCount = (num(C.summary.pendingCount) || 0) + 1;
    }
    sh.closeSheet();
    refreshPoints();
    const host = PT.host;
    clearTimeout(PT.partyT);
    PT.partyT = setTimeout(() => showParty(host, r), PARTY_MS);
    loadMoves();
    load({ force: true });
  }
  function showParty(host, r) {
    if (!host || !host.isConnected || host !== PT.host) return;
    const scr = host.querySelector('.rx-scr');
    if (!scr) return;
    PT.party = { title: r.title };
    const old = scr.querySelector(':scope > .rx-over');
    if (old) old.remove();
    const n = parse(partyHTML(PT.party)).firstElementChild;
    n.classList.add('rx-anim');
    scr.appendChild(n);
  }
  function partyClose() {
    PT.party = null;
    const host = PT.host;
    const o = host && host.querySelector('.rx-scr > .rx-over');
    if (o) o.remove();
  }
  function retryAct() {
    if (C.err || C.rewards === null) load({ force: true });
    if (PT.moves === 'err' || PT.moves === null) { PT.moves = undefined; refreshPoints(); loadMoves(); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Pantalla «invite» (RxInvite)
  // ════════════════════════════════════════════════════════════════════════
  const INV = { code: undefined, refs: undefined, goal: undefined, req: 0, host: null, loading: false };
  const MAX_DOTS = 10;

  function dotsHTML(refs, lg) {
    if (!Array.isArray(refs) || !refs.length) return '';
    const list = refs.slice(0, MAX_DOTS);
    // Un punto por colega que se registró con tu código (lleno = ya viajó). Sin
    // meta inventada: la cuadrícula tiene tantas columnas como colegas.
    return '<div class="rx-bono-dots' + (lg ? ' lg' : '') + '" data-n="' + list.length + '" style="--n:' + list.length + '"' + (lg ? ' data-k="dots"' : '') + '>'
      + list.map((r, k) => '<i' + (r.status === 'ok' ? ' class="on"' : '') + (lg ? ' style="--k:' + k + '" data-k="d' + k + '"' : '') + '></i>').join('')
      + '</div>';
  }
  function inviteValues() {
    const v = pubValues();
    return { inv: v ? num(v.invite) || 0 : 0, nb: v ? num(v.neighbor) || 0 : 0, known: !!v };
  }
  function invHeroHTML() {
    const { inv, nb, known } = inviteValues();
    const h2 = !known ? 'Invita a tus colegas a pedir sus traslados con Rendio'
      : inv > 0 ? 'Ganas ' + inv + ' pts por cada colega que haga su primer viaje'
        : 'Invita a tus colegas a pedir sus traslados con Rendio';
    const sub = known && nb > inv ? 'Si vive en tu conjunto, cuenta doble: ' + nb + ' pts.' : '';
    return '<div class="rx-inv-hero rx-in" data-k="hero">'
      + '<span data-k="l">Invitar colegas</span><h2 data-k="h">' + esc(h2) + '</h2>'
      + (sub ? '<p class="rx-inv-sub" data-k="s">' + esc(sub) + '</p>' : '')
      + dotsHTML(INV.refs, true)
      + '</div>';
  }
  function refRowsHTML() {
    const r = INV.refs;
    const empty = (k, b, s) => '<div class="rx-row static" data-k="' + k + '"><span class="rx-row-tx"><b>' + esc(b) + '</b><span>' + esc(s) + '</span></span></div>';
    if (r === undefined) return empty('r-wait', 'Cargando…', 'Buscando quién se registró con tu código.');
    if (r === 'err') return empty('r-err', 'No pudimos cargar tus invitados', 'Vuelve a intentarlo en un momento.');
    if (!Array.isArray(r)) return empty('r-none', 'Todavía no hay datos', 'Cuando un colega se registre con tu código, aparece aquí.');
    if (!r.length) return empty('r-none', 'Todavía nadie', 'Cuando un colega se registre con tu código, aparece aquí.');
    const u = UI();
    return r.map((x, i) => {
      const ok = x.status === 'ok';
      const s = ok ? 'Hizo su primer viaje' + (x.neighbor ? ' · vive en tu conjunto' : '') : 'Se registró · falta su primer viaje';
      const ini = x.initials || (u && u.initials ? u.initials(x.name) : 'A');
      return '<div class="rx-row static" data-k="r-' + i + '-' + esc(x.claimedAt || x.name) + '">'
        + (u && u.av ? u.av(ini, 'sm') : '')
        + '<span class="rx-row-tx"><b>' + esc(x.name || 'Tu colega') + '</b><span>' + esc(s) + '</span></span>'
        + (ok ? (num(x.points) != null ? '<em class="rx-plus">+' + num(x.points) + '</em>' : '') : '<span class="rx-wait-dot"></span>')
        + '</div>';
    }).join('');
  }
  function goalHTML() {
    const g = INV.goal;
    if (!g || typeof g !== 'object' || !g.text) return '';
    const count = num(g.count) || 0, target = num(g.target) || 0;
    const pct = num(g.pct) != null ? num(g.pct) : (target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0);
    return '<div class="rx-goal rx-in" style="--d:4" data-k="goal">'
      + '<span>Tu conjunto' + (g.residenceName ? ' · ' + esc(g.residenceName) : '') + '</span><b>' + esc(g.text) + '</b>'
      + '<div class="rx-pts-bar"><i style="width:' + pct + '%"></i></div><em>' + count + ' de ' + target + '</em>'
      + '</div>';
  }
  function inviteBodyInner() {
    if (!pubEnabled()) {
      return '<div class="rx-empty" data-k="off">' + ic('Users', 28) + '<b>Invitar colegas todavía no está disponible</b>'
        + '<span>Cuando la operación encienda Rendio Points, aquí tienes tu código.</span></div>';
    }
    const code = typeof INV.code === 'string' && INV.code ? INV.code : '';
    const wait = INV.code === undefined;
    return invHeroHTML()
      + '<div class="rx-code rx-in" style="--d:1" data-k="code"><div><span>Tu código</span><b>' + (code ? esc(code) : '—') + '</b></div>'
      + '<button type="button" data-rx="inv-copy"' + (code ? '' : ' disabled') + '>' + ic('Copy', 17) + 'Copiar</button></div>'
      + (!code && !wait ? waitRow('w-code', 'No pudimos traer tu código. Vuelve a intentarlo en un momento.', 'inv-retry') : '')
      + '<div class="rx-share rx-in" style="--d:2" data-k="share">'
      + btn('Enviar por WhatsApp', { icon: 'MessageCircle', disabled: !code, attrs: { 'data-rx': 'inv-wa' } })
      + btn('Compartir enlace', { kind: 'sec', icon: 'Share', disabled: !code, attrs: { 'data-rx': 'inv-share' } })
      + '</div>'
      + '<div class="rx-lbl" data-k="lbl">Invitaste a</div>'
      + '<div class="rx-group rx-in" style="--d:3" data-k="group">' + refRowsHTML() + '</div>'
      + goalHTML();
  }
  function inviteHTML() {
    const u = UI();
    const head = u && u.head ? u.head({ title: 'Invitar colegas' }) : '';
    return '<div class="rx-scr">' + head + '<div class="rx-body">' + inviteBodyInner() + '</div></div>';
  }
  function patchInvite(host) {
    host = host || INV.host;
    if (!host || !host.isConnected) return false;
    const body = host.querySelector('.rx-scr > .rx-body');
    if (!body) return false;
    reconcile(body, parse('<div>' + inviteBodyInner() + '</div>').firstElementChild);
    return true;
  }
  function refreshInvite() {
    if (!INV.host || !INV.host.isConnected) return;
    patchInvite(INV.host);
    // Se encendió con la pantalla abierta: ahora sí se pide el código.
    if (INV.code === undefined && !INV.loading && pubEnabled()) loadInvite();
  }
  function loadInvite() {
    const P = AP();
    const req = ++INV.req;
    if (!P) { INV.code = null; INV.refs = null; INV.goal = null; refreshInvite(); return Promise.resolve(); }
    INV.loading = true;
    return Promise.all([
      call(P.myCode).then(v => (v ? String(v) : null), () => null),
      call(P.myReferrals).then(v => (Array.isArray(v) ? v : null), () => 'err'),
      call(P.goal).then(v => v || null, () => null),
    ]).then(([code, refs, goal]) => {
      if (req !== INV.req) return;
      INV.loading = false;
      INV.code = code; INV.refs = refs; INV.goal = goal;
      refreshInvite();
    });
  }
  const INVITE = {
    render() { return inviteHTML(); },
    after(ctx) {
      INV.host = ctx.host;
      // Con el programa apagado no se pide nada: myCode() CREA el código.
      if (ctx.reason === 'enter') { load({ force: true }); if (pubEnabled()) loadInvite(); }
    },
    patch(ctx) { return patchInvite(ctx.host); },
    destroy(ctx) { if (ctx && ctx.reason === 'leave') INV.host = null; },
  };

  function toast(msg, icon) {
    const sh = SH();
    if (sh && typeof sh.toast === 'function') sh.toast(msg, icon);
    else if (typeof window.toast === 'function') window.toast(msg);
  }
  async function copyText(txt) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(txt);
        return true;
      }
    } catch (_) { /* cae al respaldo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }
  const myCode = () => (typeof INV.code === 'string' && INV.code ? INV.code : '');
  function shareText(code) {
    return strHelper('inviteText', code, 'Te invito a pedir tus traslados con Rendio. Cuando te registres, escribe mi código ' + code + '.');
  }
  async function copyAct() {
    const code = myCode(); if (!code) return;
    if (await copyText(code)) toast('Código copiado', 'Copy');
    else toast('No se pudo copiar. Tu código es ' + code, 'Info');
  }
  function waAct() {
    const code = myCode(); if (!code) return;
    const url = 'https://wa.me/?text=' + encodeURIComponent(shareText(code));
    let w = null;
    try { w = window.open(url, '_blank', 'noopener'); } catch (_) { w = null; }
    if (w === null) { try { location.href = url; } catch (_) { /* */ } }
    toast('Abriendo WhatsApp…', 'Send');
  }
  async function shareAct() {
    const code = myCode(); if (!code) return;
    const link = strHelper('inviteLink', code, '');
    if (navigator.share) {
      try { await navigator.share({ title: 'Rendio', text: shareText(code) }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (await copyText(link || shareText(code))) toast('Enlace copiado', 'Copy');
    else toast('No se pudo copiar el enlace', 'Info');
  }

  // ════════════════════════════════════════════════════════════════════════
  // Inicio: billetera (rx-pocket) y bono (rx-bono) en 'home.hook'
  // ════════════════════════════════════════════════════════════════════════
  function pocketSub(s) {
    const bal = num(s.balance) || 0;
    const rw = availRewards();
    if (rw && rw.length) {
      const can = rw.filter(r => r.cost <= bal);
      if (can.length) return 'Ya te alcanza para ' + lowerFirst(can[can.length - 1].title);
      return 'Te faltan ' + (rw[0].cost - bal) + ' para ' + lowerFirst(rw[0].title);
    }
    const nx = num(s.nextRewardPts);
    if (nx != null && nx > bal && s.nextRewardName) return 'Te faltan ' + (nx - bal) + ' para ' + lowerFirst(s.nextRewardName);
    return 'Mira cómo ganar y canjear';
  }
  function bonoHTML(s, d) {
    const v = s.values || pubValues() || {};
    const inv = num(v.invite) || 0;
    const count = num(s.invitedCount) || 0, done = num(s.invitedDone) || 0;
    if (inv <= 0 && !count) return '';
    const right = count ? done + ' de ' + count : '+' + inv + ' pts';
    const pend = count - done;
    const t = !count ? 'Tu colega hace su primer viaje y ganas ' + inv + ' pts'
      : pend > 0 ? (pend === 1 ? '1 colega aún no hace su primer viaje' : pend + ' colegas aún no hacen su primer viaje')
        : (inv > 0 ? 'Invita a otro colega y ganas ' + inv + ' pts' : 'Tus invitados ya viajaron');
    // Los puntos del bono salen del resumen (invitedDone/invitedCount); no hay
    // lista de nombres en Inicio.
    const refs = [];
    for (let k = 0; k < Math.min(count, MAX_DOTS); k++) refs.push({ status: k < done ? 'ok' : 'wait' });
    return '<button type="button" class="rx-bono rx-in" style="--d:' + d + '" data-rx="inv-open">'
      + '<div class="rx-bono-h"><span>Invitar colegas</span><b>' + esc(right) + '</b></div>'
      + '<div class="rx-bono-t">' + esc(t) + '</div>'
      + dotsHTML(refs, false)
      + '</button>';
  }
  function pocketHTML(c) {
    const s = pubSummary();
    if (!s || num(s.balance) == null) return '';
    const d = c && num(c.d) != null ? num(c.d) : 2;
    const bal = num(s.balance);
    return '<button type="button" class="rx-pocket rx-in" style="--d:' + d + '" data-rx="pts-open">'
      + '<span class="rx-pocket-ic"><i></i></span>'
      + '<span class="rx-pocket-tx"><b><span data-pts-n="' + bal + '">' + bal + '</span> puntos</b><span>' + esc(pocketSub(s)) + '</span></span>'
      + ic('ChevronRight', 18)
      + '</button>'
      + bonoHTML(s, d + 1);
  }

  // Cuándo se pinta Inicio y cómo: al entrar la pestaña su host está VACÍO
  // (la tabview es nueva y sus .rx-in corren solas); en un repintado ya tiene
  // lo anterior (y el shell le pone .rx-noanim).
  let homeMode = 'enter';
  let settleQ = false;
  function homeTab() {
    const ui = document.getElementById('auxiliar-ui');
    return ui ? ui.querySelector('.rx-tabview[data-scr="home"]') : null;
  }
  function noteHome() {
    const tv = homeTab();
    const host = tv && tv.querySelector('.rx-scrhost');
    homeMode = !host || !host.firstChild ? 'enter' : 'repaint';
    if (settleQ) return;
    settleQ = true;
    Promise.resolve().then(() => { settleQ = false; settleHome(); });
  }
  // Después de pintar Inicio: RxCount al montar (800 ms desde 0), y si la
  // billetera APARECE en una pestaña que ya estaba (llegó el resumen), entra
  // con su rxRise como un componente que React monta.
  function settleHome() {
    const tv = homeTab();
    if (!tv) return;
    const pocket = tv.querySelector('.rx-pocket');
    if (!pocket) { tv.__rxPtsBal = undefined; return; }
    if (pocket.__rxSeen) return;
    const b = pocket.querySelector('[data-pts-n]');
    const bal = b ? num(b.getAttribute('data-pts-n')) : null;
    const prev = tv.__rxPtsBal;
    pocket.__rxSeen = true;
    const u = UI();
    if (homeMode === 'repaint' && prev === undefined && u && u.remount) {
      const np = u.remount(pocket);
      np.__rxSeen = true;
      const bono = tv.querySelector('.rx-bono');
      if (bono) u.remount(bono);
      countEl(np.querySelector('[data-pts-n]'), bal);
    } else if (homeMode === 'enter' || prev !== bal) countEl(b, bal);
    else if (b) b.__rxPtsV = bal;
    tv.__rxPtsBal = bal;
  }
  const HOME_HOOK = {
    id: 'points', priority: 20,
    when(c) {
      noteHome();
      if (c && c.inCourse) return false;
      if (!pubEnabled()) return false;
      const s = pubSummary();
      return !!(s && num(s.balance) != null);
    },
    render(c) { return pocketHTML(c); },
  };
  // Inicio no consulta 'home.hook' con un viaje en curso: este vigía (nunca se
  // pinta) avisa igual que Inicio se volvió a pintar, para saber si la billetera
  // estaba o no.
  const HOME_WATCH = { id: 'points-watch', priority: -1000, when() { noteHome(); return false; }, render() { return ''; } };

  // ════════════════════════════════════════════════════════════════════════
  window.AuxPuntos = {
    enabled, summary, cancelBonus,
    load, refresh: () => load({ force: true }),
    // Para pruebas y vistas previas.
    pointsHTML, inviteHTML, pocketHTML, whenLabel,
    _st: () => ({ C, PT, INV }),
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('points', POINTS);
    sh.register('invite', INVITE);
    sh.hook('home.hook', HOME_HOOK);
    sh.hook('home.strip', HOME_WATCH);
    sh.action('pts-open', () => { const s = SH(); if (s) s.push('points', {}); });
    sh.action('inv-open', () => { const s = SH(); if (s) s.push('invite', {}); });
    sh.action('pts-seg', segAct);
    sh.action('pts-redeem', redeemAct);
    sh.action('pts-redeem-go', redeemGo);
    sh.action('pts-party-close', partyClose);
    sh.action('pts-retry', retryAct);
    sh.action('inv-copy', copyAct);
    sh.action('inv-wa', waAct);
    sh.action('inv-share', shareAct);
    sh.action('inv-retry', () => { INV.code = undefined; refreshInvite(); loadInvite(); });
  }
})();
