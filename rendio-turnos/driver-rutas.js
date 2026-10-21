// driver-rutas.js — Ruta del conductor v2.
//
// DISEÑO: entrega del diseñador del 12-oct-2026 (Visual/entrega-ruta-conductor-2026-10-12/:
// rt-core, rt-screens, rt-exec, rt-sheets, rt-app .jsx + rt.css sobre el sistema rx del
// auxiliar). Se porta FIEL: mismas clases, misma estructura, mismos textos y las mismas
// animaciones (el CSS lo copia regla por regla _portar-css-ruta-conductor.mjs →
// rt-conductor.css; los ajustes de la app viven en rt-conductor-app.css). Ver
// [feedback-seguir-diseno-ux] y [feedback-animaciones-fieles].
//
// Lo que el prototipo simulaba se conecta a lo real:
//   · mapa abstracto (RtMap)        → Leaflet + OSM con el tono del diseño: mismos pines
//                                     numerados, tramos hechos / ahora / siguientes, y el
//                                     carro en la posición REAL del GPS (sin GPS no hay carro).
//   · datos demo (RT_V)             → Api.listMyVueltasForDriver (vueltas publicadas).
//   · tell() de la demo             → los avisos los manda la base (0097) al cambiar el estado.
//   · código validado en el cliente → driver_board_with_code (la base lo vuelve a validar).
//   · distancia simulada            → GPS en vivo (una sola distancia).
//
// CAMBIOS DE LÓGICA de la entrega (README, «Cambios que tocan lógica»):
//   1. La ubicación sigue activa al salir de Ejecución mientras la vuelta esté en curso
//      (barra «Ruta en curso» para volver con un toque).
//   2. «Llegué al aeropuerto» en llegadas compara con el GPS: si está lejos, pide confirmar
//      antes de avisar a los auxiliares. Lo mismo con «Llegué» en una casa: el aviso falso
//      «¡Tu conductor llegó!» le llegaba igual al tripulante.
//   3. «No se presentó» pide confirmación.
//   4. Chat con cualquier auxiliar de la vuelta desde el Detalle y la lista del aeropuerto.
//   5. Una sola distancia en Ejecución: la del GPS en vivo.
//
// Escrituras a la base: si no hay señal, se encolan (localStorage) y se reintentan en el
// siguiente punto de GPS o al volver la conexión. El avance local nunca se bloquea.

(function () {
  'use strict';

  // ── Constantes ────────────────────────────────────────────────────────────────
  const MDE = { lat: 6.1715, lng: -75.4270 };
  const PING_MS = 6000;                       // cada cuánto se escribe la posición
  const FAR_APT_KM = 1.5;                     // «Llegué al aeropuerto» lejos de JMC
  const FAR_HOME_KM = 0.6;                    // «Llegué» lejos de la casa
  const RT_ON = ['onboard', 'nocode', 'delivered'];
  const RT_NO = ['noshow', 'notarrived'];
  const RT_RES = { onboard: ['A bordo', 'ok'], nocode: ['A bordo sin código', 'warn'], noshow: ['No se presentó', 'err'], notarrived: ['No llegó al aeropuerto', 'err'], delivered: ['Entregado', 'ok'] };
  const RT_QR = ['Ya llegué, estoy afuera', 'Voy 5 min tarde', 'Estoy en la portería', 'No encuentro la dirección'];
  const RT_KINDS = [['mec', 'Falla mecánica', 'Wrench'], ['tra', 'Trancón', 'Traffic'], ['dir', 'No encuentro la dirección', 'MapPin'], ['otr', 'Otra cosa', 'Help']];
  const RT_CAT = { mec: 'vehicle_problem', tra: 'traffic', dir: 'wrong_address', otr: 'other' };
  const RT_CAT_LABEL = { mec: 'Falla mecánica', tra: 'Trancón', dir: 'No encuentro la dirección', otr: 'Otra cosa' };

  // Íconos que la ruta agrega a los del auxiliar (rt-core.jsx, Object.assign(RXI, …)).
  // Se inyectan en el mismo sprite #rx-sprite con los trazos copiados tal cual.
  const RT_ICONS = {
    Expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    Bag: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/><line x1="9" y1="11" x2="9" y2="16"/><line x1="15" y1="11" x2="15" y2="16"/>',
    Quiet: '<path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>',
    Send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    Door: '<path d="M4 21h16"/><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><circle cx="14.5" cy="12" r="1"/>',
    Note: '<path d="M4 4h16v12H8l-4 4z"/><line x1="8" y1="8.5" x2="16" y2="8.5"/><line x1="8" y1="12" x2="13" y2="12"/>',
    Help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.8-3 2.8"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    Traffic: '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
    Ban: '<circle cx="12" cy="12" r="9.5"/><line x1="5.3" y1="5.3" x2="18.7" y2="18.7"/>',
    Play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  };

  // ── Estado ────────────────────────────────────────────────────────────────────
  const RT = {
    profile: null, source: 'empty', driverProfileId: null, vueltas: [], loaded: false,
    stack: [],                 // capas sobre Mi día: { id:'detail'|'exec'|'done', vid, key }
    maps: {},                  // key de capa (o 'big') → manejador del mapa
    sheet: null,               // { kind, close, ... }
    unread: {}, lastMsg: {}, unreadPoll: null,
    chat: null, chatMsgs: [], chatPoll: null, chatSending: false, chatWarned: false,
    watchId: null, sharing: false, lastPos: null, lastPingAt: 0,
    tick: null, toastT: null, pushT: null, bound: false, open: false,
    code: {},                  // rid → { val, st }   (código que se está escribiendo)
    nc: {},                    // rid → true  («No tiene el código» elegido)
    ask: {},                   // rid → 'nocode'|'notarrived'  (confirmación en la fila)
    report: null, busy: false, keySeq: 0,
  };
  window.DriverRutas = { open: rtOpen, close: rtClose, background: rtBackground, deepLink: rtDeepLink };

  // ── Utilidades ────────────────────────────────────────────────────────────────
  const host = () => document.getElementById('driver-ruta-root');
  const ui = () => document.getElementById('driver-ruta-ui');
  // Búsquedas DENTRO de la ruta (y no «#driver-ruta-ui X» sobre el documento: el motor de
  // selectores de jsdom, el de las pruebas, no resuelve bien ese descendiente).
  const uiq = (sel) => { const u = ui(); return u ? u.querySelector(sel) : null; };
  const uiqa = (sel) => { const u = ui(); return u ? [...u.querySelectorAll(sel)] : []; };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const initials = (n) => (window.AuxRxUI ? AuxRxUI.initials(n) : (first(n)[0] || 'A').toUpperCase());
  const waitMin = () => (typeof state !== 'undefined' && state.settings && state.settings.aux_wait_minutes != null) ? Number(state.settings.aux_wait_minutes) : 5;
  const waitSec = () => Math.max(60, waitMin() * 60);
  const key = () => 'k' + (++RT.keySeq);
  const fmtSec = (sec) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const kmTxt = (k) => `${k.toFixed(1).replace('.', ',')} km`;
  function hav(a, b) {
    const R = 6371, r = (x) => x * Math.PI / 180;
    const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bogHM(d) {
    try { return new Date(d).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch (e) { return ''; }
  }
  // «LUN 12 OCT» (rt-core.jsx, RT_DAY), del día de Bogotá AAAA-MM-DD.
  const DOW = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
  const MON = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  function fmtDay(day) {
    const d = day || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); if (!m) return 'HOY';
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    return `${DOW[dt.getUTCDay()]} ${+m[3]} ${MON[+m[2] - 1]}`;
  }
  // La vuelta de después de medianoche que es del turno de esta noche (opDay ≠ day,
  // ver listMyVueltasForDriver): «Madrugada del MAR 21 OCT». 20-oct-2026.
  const madrugadaDe = (v) => (v && v.opDay && v.day && v.day !== v.opDay ? `Madrugada del ${fmtDay(v.day)}` : '');
  function hmToMin(hm) { const m = /^(\d{1,2}):(\d{2})/.exec(hm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }

  // Sprite: los íconos del auxiliar (AuxRxUI) + los de la ruta.
  function ensureIcons() {
    const sp = window.AuxRxUI ? AuxRxUI.ensureSprite() : null;
    if (!sp) return;
    Object.keys(RT_ICONS).forEach((n) => {
      if (document.getElementById('rx-' + n)) return;
      const sym = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
      sym.setAttribute('id', 'rx-' + n); sym.setAttribute('viewBox', '0 0 24 24');
      sym.innerHTML = RT_ICONS[n];
      sp.appendChild(sym);
    });
  }
  // <Ic n s style/> del diseño, con el mismo marcado que AuxRxUI.ic.
  function ic(n, s, style) {
    s = s == null ? 20 : s;
    return '<svg class="rx-ic lucide" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
      + (style ? ' style="' + esc(style) + '"' : '') + '><use href="#rx-' + n + '"></use></svg>';
  }
  function attrs(a) {
    if (!a) return '';
    return Object.keys(a).map((k) => (a[k] == null || a[k] === false) ? '' : ' ' + k + (a[k] === true ? '' : '="' + esc(a[k]) + '"')).join('');
  }
  // <RxBtn kind icon className …/>
  function btn(label, o) {
    o = o || {};
    return '<button type="button" class="rx-btn ' + (o.kind || 'pri') + (o.cls ? ' ' + o.cls : '') + '"' + (o.disabled ? ' disabled' : '')
      + (o.style ? ' style="' + esc(o.style) + '"' : '') + attrs(o.attrs) + '>' + (o.icon ? ic(o.icon, 19) : '') + esc(label) + '</button>';
  }
  const av = (ini, size) => '<span class="rx-av ' + (size || 'md') + '">' + esc(ini) + '</span>';
  const chip = (icon, tone, text) => '<span class="rt-chip ' + (tone || '') + '">' + (icon ? ic(icon, 13) : '') + '<span class="rt-chip-t">' + esc(text) + '</span></span>';
  const check = (size, tone) => '<div class="rx-check t-' + (tone || 'ok') + '" style="width:' + size + 'px;height:' + size + 'px"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"></circle><polyline points="15 27 23 35 38 18"></polyline></svg></div>';
  function confetti() {
    const C = ['#F26522', '#10B981', '#F59E0B', '#6A3FC0', '#3B82F6']; let h = '';
    for (let i = 0; i < 26; i++) h += '<i style="left:' + ((i * 37) % 100) + '%;animation-delay:' + ((i % 8) * 60) + 'ms;--r:' + ((i * 53) % 360) + 'deg;--c:' + C[i % C.length] + '"></i>';
    return '<div class="rx-confetti">' + h + '</div>';
  }

  // ── Modelo: vueltas de la API → forma del diseño ─────────────────────────────
  const tone = (v) => v.type === 'llegada'
    ? { c: 'var(--r-a2h)', s: 'var(--r-a2h-soft)', fg: 'var(--rx-ok)', l: 'Llegada' }
    : { c: 'var(--r-h2a)', s: 'var(--r-h2a-soft)', fg: 'var(--rx-acc)', l: 'Salida' };
  const crew = (v) => v.legs.filter((l) => l.k !== 'apt');
  const vById = (id) => RT.vueltas.find((v) => v.id === id);
  const S = (v) => v._s;
  const legNum = (v, i) => v.legs.slice(0, i + 1).filter((l) => l.k !== 'apt').length;
  const names = (v) => { const f = crew(v).map((c) => first(c.name)); return f.length > 1 ? `${f.slice(0, -1).join(', ')} y ${f[f.length - 1]}` : (f[0] || ''); };
  const quiet = (l) => !!(l && l.quiet === true && l.level === 'private' && l.privateStatus === 'approved');
  // La dirección escrita en el registro ya trae la unidad («Olivar · Torre 2 · 504»):
  // se agrega solo si no está, para no pintarla dos veces.
  const hasUnit = (l) => !!(l.unit && String(l.addr || '').toLowerCase().includes(String(l.unit).toLowerCase()));
  const unitTxt = (l) => (l.unit && !hasUnit(l) ? l.unit : '');

  // Presentación en MDE de una salida = la hora límite más temprana de su gente.
  function present(v) {
    const t = crew(v).map((l) => l.dl).filter(Boolean).sort();
    return t[0] || '';
  }
  // Fin de la vuelta: salida → presentación; llegada → entrega estimada de la última casa.
  function endOf(v) {
    if (v.type === 'salida') return present(v);
    const c = crew(v); const last = c[c.length - 1];
    return (last && last.eta) || '';
  }
  // Duración estimada (min): distancia por carretera aprox. + 3 min por parada.
  function minsOf(v) {
    const pts = v.legs.filter((l) => l.lat != null).map((l) => [l.lat, l.lng]);
    let km = 0; for (let i = 1; i < pts.length; i++) km += hav(pts[i - 1], pts[i]) * 1.4;
    return Math.max(8, Math.round(km / 30 * 60 + crew(v).length * 3));
  }
  function soon(v) {
    if (!v.startAt) return '';
    const m = Math.round((Date.parse(v.startAt) - Date.now()) / 60000);
    if (m >= 60) return `En ${Math.floor(m / 60)} h`;
    if (m > 0) return `Arranca en ${m} min`;
    return `Salía a las ${v.start}`;
  }
  // Vuelo de la vuelta: uno solo si todos comparten el mismo. { code, st, tone } | null
  function flightOf(v, leg) {
    const codes = leg ? [leg.flight].filter(Boolean) : [...new Set(crew(v).map((l) => l.flight).filter(Boolean))];
    if (codes.length !== 1) return null;
    const code = codes[0];
    let st = '', tn = '';
    try {
      if (window.RendioVuelos && RendioVuelos.describir) {
        const d = RendioVuelos.describir(RendioVuelos.para(code, v.day, v.type === 'llegada' ? 'lle' : 'sal'), Date.now());
        if (d) { st = d.text.replace(/^[^·]*·\s*/, ''); tn = d.tone === 'ok' ? 'ok' : d.tone === 'warn' ? 'warn' : d.tone === 'bad' ? 'err' : ''; }
      }
    } catch (e) { /* sin dato de vuelo: solo el código */ }
    return { code, st, tone: tn };
  }
  function rtBuild(list) {
    return (list || []).map((v) => {
      v.n = v.id;
      v.type = v.type === 'lle' ? 'llegada' : 'salida';
      v.legs.forEach((l) => {
        l.k = l.kind === 'airport' ? 'apt' : (l.kind === 'pickup' ? 'pick' : 'drop');
        l.rid = l.reservationId || null;
        if (l.k !== 'apt') l.ini = initials(l.name);
      });
      v.from = v.type === 'salida' ? 'Casas' : 'JMC';
      v.to = v.type === 'salida' ? 'JMC' : 'Casas';
      return v;
    });
  }
  // Resultado de cada tripulante según la base.
  function resOf(v, l) {
    if (l.stopStatus === 'picked_up') return l.boardedNoCode ? 'nocode' : 'onboard';
    if (l.stopStatus === 'delivered') return 'delivered';
    if (l.stopStatus === 'no_show') return v.type === 'llegada' ? 'notarrived' : 'noshow';
    return null;
  }
  // Dónde va la vuelta según la BASE (0045/0097): sirve para retomar aunque se haya
  // perdido el teléfono, y para no repetirle el «Eres el siguiente» al primero.
  function serverProgress(v) {
    const c = crew(v);
    if (!c.some((l) => l.stopStatus && l.stopStatus !== 'pending')) return null;
    if (v.type === 'llegada') {
      if (c.some((l) => l.stopStatus === 'pending' || l.stopStatus === 'arrived')) return { idx: 0, phase: 'at' };
      const i = v.legs.findIndex((l) => l.k === 'drop' && l.stopStatus === 'picked_up');
      return i >= 0 ? { idx: i, phase: 'road' } : null;
    }
    const i = v.legs.findIndex((l) => l.k === 'pick' && (l.stopStatus === 'pending' || l.stopStatus === 'arrived'));
    if (i >= 0) return { idx: i, phase: v.legs[i].stopStatus === 'arrived' ? 'at' : 'road' };
    return { idx: v.legs.length - 1, phase: 'road' };
  }

  // ── Avance guardado en el teléfono ────────────────────────────────────────────
  const PKEY = () => 'rendio-rt-v2-' + ((RT.profile && RT.profile.id) || 'anon');
  function loadSaved() { try { return JSON.parse(localStorage.getItem(PKEY()) || '{}') || {}; } catch (e) { return {}; } }
  function save() {
    try {
      const out = { v: {} };
      RT.vueltas.forEach((v) => {
        const s = S(v); if (!s || !s.started) return;
        out.v[v.assignmentId] = { day: v.day, idx: s.idx, phase: s.phase, at: s.at, startedAt: s.startedAt, finishedAt: s.finishedAt, aptAt: s.aptAt, done: s.done, nocode: Object.keys(s.res).filter((r) => s.res[r] === 'nocode') };
      });
      localStorage.setItem(PKEY(), JSON.stringify(out));
    } catch (e) { /* modo privado */ }
  }
  function initProgress(v, saved) {
    const s = { started: false, idx: 0, phase: 'road', at: null, res: {}, done: !!v.done, startedAt: null, finishedAt: null, aptAt: null };
    crew(v).forEach((l) => { const r = resOf(v, l); if (r && l.rid) s.res[l.rid] = r; });
    const sp = serverProgress(v);
    if (sp) { s.started = true; s.idx = sp.idx; s.phase = sp.phase; }
    const sv = saved && saved.v && saved.v[v.assignmentId];
    if (sv && (!sv.day || sv.day === v.day)) {
      s.started = true;
      if (sv.idx > s.idx || (sv.idx === s.idx && sv.phase === 'at')) { s.idx = Math.min(sv.idx, v.legs.length - 1); s.phase = sv.phase || 'road'; }
      s.startedAt = sv.startedAt || null; s.at = sv.at || null; s.aptAt = sv.aptAt || null;
      s.finishedAt = sv.finishedAt || null;
      (sv.nocode || []).forEach((r) => { if (s.res[r] === 'onboard') s.res[r] = 'nocode'; });
      if (sv.done) s.done = true;
    }
    // La hora real de «Llegué» viene de la base: el reloj de espera sigue donde iba.
    const l = v.legs[s.idx];
    if (s.phase === 'at' && l && l.arrivedAt && l.k === 'pick') { const t = Date.parse(l.arrivedAt); if (isFinite(t)) s.at = t; }
    if (s.phase === 'at' && !s.at) s.at = Date.now();
    if (v.done) { s.done = true; s.started = true; }
    v._s = s;
  }

  // ── Cola de escrituras (sin señal no se pierde ningún avance) ─────────────────
  const QKEY = () => 'rendio-rt-v2-cola-' + ((RT.profile && RT.profile.id) || 'anon');
  function qLoad() { try { return JSON.parse(localStorage.getItem(QKEY()) || '[]') || []; } catch (e) { return []; } }
  function qSave(q) { try { localStorage.setItem(QKEY(), JSON.stringify(q)); } catch (e) { /* modo privado */ } }
  async function qRun(op) {
    if (!window.Api) throw new Error('sin Api');
    if (op.f === 'status') return Api.driverSetStopStatus(op.rid, op.st);
    if (op.f === 'board') return Api.driverBoardWithCode(op.rid, op.code, op.sin);
    if (op.f === 'apt') return Api.driverMarkAirportArrival(op.ra);
    if (op.f === 'aptno') return Api.driverAirportNoShow(op.rid);
    if (op.f === 'undo') return Api.driverAirportUndo(op.rid);
    return null;
  }
  // Escribe ya; si falla por red, queda en cola. Devuelve true si entró.
  async function write(op) {
    if (RT.source !== 'live') return true;
    const q = qLoad();
    if (q.length) { q.push(op); qSave(q); flushQueue(); return false; }
    try { await qRun(op); return true; }
    catch (e) {
      if (isNetErr(e)) { q.push(op); qSave(q); toast('Sin señal: lo guardamos y lo enviamos apenas vuelva', 'CloudOff'); return false; }
      throw e;
    }
  }
  // ¿Vale la pena reintentar? Sí: sin red, servidor caído (5xx) o la base ocupada
  // (timeout, bloqueo). No: lo que la base RECHAZA (no es tu ruta, código malo…): eso
  // se le dice al conductor de una vez, no se esconde en la cola.
  function isNetErr(e) {
    if (!e) return true;
    const m = String(e.message || e) + ' ' + String(e.code || '') + ' ' + String(e.details || '');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (e.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|network request|offline/i.test(m)) return true;
    if (Number(e.status || e.statusCode || 0) >= 500) return true;
    return /timeout|57014|40P01|55P03|PGRST00[0-3]|503|502|504/i.test(m);
  }
  const OP_TXT = { status: 'el estado de la parada', board: 'el abordaje', apt: 'la llegada al aeropuerto', aptno: '«no llegó»', undo: 'el «deshacer»' };
  let flushing = false;
  async function flushQueue() {
    if (flushing || RT.source !== 'live') return;
    flushing = true;
    try {
      let q = qLoad();
      while (q.length) {
        const op = q[0];
        try { await qRun(op); }
        catch (e) {
          op.n = (op.n || 0) + 1;
          // Reintentable y todavía con intentos: se queda primero en la cola.
          if (isNetErr(e) && op.n < 40) { q[0] = op; qSave(q); break; }
          // Nunca en silencio: el conductor ve qué no quedó guardado (y por qué).
          console.error('[ruta] no se pudo guardar', op, e);
          toast(`No se guardó ${OP_TXT[op.f] || 'un cambio'}: ${(e && e.message) || 'error'}`, 'AlertTriangle');
        }
        q = qLoad(); q.shift(); qSave(q);
      }
    } finally { flushing = false; }
  }
  window.addEventListener('online', () => flushQueue());

  // ── Abrir / cerrar ────────────────────────────────────────────────────────────
  async function load(profile) {
    RT.profile = profile;
    let vs = null;
    try { if (window.Api && Api.listMyVueltasForDriver && profile && profile.id) vs = await Api.listMyVueltasForDriver(profile.id); } catch (e) { vs = null; }
    RT.source = (vs && vs.length) ? 'live' : 'empty';
    RT.vueltas = rtBuild(vs && vs.length ? vs : []);
    const saved = loadSaved();
    RT.vueltas.forEach((v) => initProgress(v, saved));
    if (RT.source === 'live' && window.Api && Api.getMyDriverProfileId) {
      try { RT.driverProfileId = await Api.getMyDriverProfileId(profile.id); } catch (e) { RT.driverProfileId = null; }
    }
    RT.loaded = true;
    loadFlights();
    flushQueue();
  }
  const active = () => RT.vueltas.find((v) => S(v).started && !S(v).done);

  // opts.startAssignment: abre directo en Ejecución esa vuelta («Iniciar ruta» del Inicio).
  async function rtOpen(profile, opts) {
    const root = host(); if (!root) return;
    ensureIcons();
    RT.open = true;
    root.classList.remove('hidden');
    root.classList.add('rt-v2');
    root.innerHTML = shellHTML('<div class="rt-scr"><div class="rt-body rt-loading"><div class="rt-title"><span>Rutas</span><h1>Mi día</h1><p>Cargando tu ruta…</p></div></div></div>');
    await load(profile);
    if (!RT.open) return;
    RT.stack = [];
    root.innerHTML = shellHTML(dayHTML());
    bindOnce();
    if (active()) gpsStart();
    syncUnread();
    if (RT.unreadPoll) clearInterval(RT.unreadPoll);
    RT.unreadPoll = setInterval(syncUnread, 15000);
    if (!RT.tick) RT.tick = setInterval(tick, 1000);
    const pedida = opts && opts.startAssignment ? RT.vueltas.find((v) => v.assignmentId === opts.startAssignment && !S(v).done) : null;
    if (pedida) start(pedida.id);
  }
  function rtClose() {
    RT.open = false;
    closeSheet(true);
    Object.keys(RT.maps).forEach(mapDrop);
    if (RT.unreadPoll) { clearInterval(RT.unreadPoll); RT.unreadPoll = null; }
    if (RT.chatPoll) { clearInterval(RT.chatPoll); RT.chatPoll = null; }
    if (RT.tick) { clearInterval(RT.tick); RT.tick = null; }
    // La ubicación sigue si hay una vuelta en curso (cambio 1 de la entrega).
    if (!active()) gpsStop();
    const root = host();
    if (root) { root.classList.add('hidden'); root.innerHTML = ''; }
    RT.stack = [];
    if (window.setDriverTab) try { setDriverTab('home'); } catch (e) { /* sin pestañas */ }
  }
  // Desde el Inicio del conductor: si al abrir la app hay una vuelta en curso, la
  // ubicación vuelve a compartirse sin tener que entrar a la ruta.
  async function rtBackground(profile, vueltas) {
    try {
      if (!profile || !vueltas || !vueltas.length || RT.open) return;
      if (!vueltas.some((v) => (v.legs || []).some((l) => l.stopStatus && l.stopStatus !== 'pending') && !v.done)) return;
      if (RT.watchId != null) return;
      await load(profile);
      if (active()) gpsStart();
    } catch (e) { /* best-effort */ }
  }

  // Avisos del chat: «Mensaje de tu pasajero» y «Mensaje de Rendio» traen
  // #/viaje?r=<reserva> (el mismo enlace que abre el viaje en la app del tripulante).
  // En el conductor abre la ruta con el chat de ESE traslado.
  function hashRid() {
    const m = /^#\/(?:viaje|ruta)\?(?:r|chat)=([0-9a-f-]{36})/i.exec(String(location.hash || ''));
    return m ? m[1] : null;
  }
  async function rtDeepLink(profile) {
    const rid = hashRid();
    if (!rid || !profile || profile.role !== 'driver') return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* */ }
    if (!RT.open) await rtOpen(profile);
    const v = RT.vueltas.find((x) => x.legs.some((l) => l.rid === rid));
    if (v) chatOpen(v.id, rid);
    else toast('Ese traslado ya no está en tu ruta', 'Info');
    return true;
  }
  window.addEventListener('hashchange', () => {
    try { if (typeof state !== 'undefined' && state.profile) rtDeepLink(state.profile); } catch (e) { /* */ }
  });

  // ── Armazón: Mi día de base + capas + hoja + avisos ───────────────────────────
  // Nocturno = el tema oscuro que el conductor eligió en su Perfil (driver-tabs.js).
  function night() {
    try { return typeof rcTheme === 'function' ? rcTheme() === 'dark' : localStorage.getItem('rendio.driver.theme') === 'dark'; }
    catch (e) { return false; }
  }
  function shellHTML(baseHTML) {
    const n = night();
    const root = host(); if (root) root.classList.toggle('night', n);
    return '<div id="driver-ruta-ui" class="rx-phone" data-ax-night="' + (n ? 'on' : 'off') + '">'
      + '<div class="rx-base" id="rt-base">' + baseHTML + '</div>'
      + '<div id="rt-layers"></div><div id="rt-sheet-host"></div><div id="rt-toast-host"></div><div id="rt-push-host"></div>'
      + '</div>';
  }
  function repaintBase() {
    const b = document.getElementById('rt-base'); if (!b) return;
    b.innerHTML = dayHTML();
    b.classList.add('rx-noanim');
  }

  // ── Pila de pantallas (rt-app.jsx: push / pop / popAll / reset / swapExec) ────
  function layerHTML(L) {
    const v = vById(L.vid);
    if (!v) return '<div class="rt-scr"></div>';
    if (L.id === 'detail') return detailHTML(v);
    if (L.id === 'exec') return execHTML(v);
    if (L.id === 'done') return doneHTML(v);
    return '<div class="rt-scr"></div>';
  }
  function syncBehind() {
    const base = document.getElementById('rt-base');
    const els = [...document.querySelectorAll('#rt-layers > .rx-layer:not(.out)')];
    if (base) base.classList.toggle('behind', els.length > 0);
    els.forEach((el, i) => el.classList.toggle('behind', i < els.length - 1));
  }
  function push(id, vid) {
    const L = { id, vid, key: key() };
    RT.stack.push(L);
    const box = document.getElementById('rt-layers'); if (!box) return;
    box.insertAdjacentHTML('beforeend', '<div class="rx-layer" data-key="' + L.key + '">' + layerHTML(L) + '</div>');
    syncBehind();
    afterMount(L);
  }
  function afterMount(L) {
    const el = layerEl(L.key); if (!el) return;
    // Repintar la misma capa no repite las entradas (rx-noanim, tramo generado).
    setTimeout(() => { if (el.isConnected) el.classList.add('rx-noanim'); }, 700);
    const v = vById(L.vid);
    if (L.id === 'detail') mapMount(L.key, el.querySelector('.rt-mapcard .rt-lf'), v, 'detail');
    if (L.id === 'exec') { mapMount(L.key, el.querySelector('.rt-map-full .rt-lf'), v, 'exec'); focusCode(el); }
    bindCodes(el);
  }
  const layerEl = (k) => document.querySelector('#rt-layers > .rx-layer[data-key="' + k + '"]');
  function pop() {
    const L = RT.stack[RT.stack.length - 1]; if (!L) { rtClose(); return; }
    const el = layerEl(L.key);
    RT.stack.pop();
    mapDrop(L.key);
    if (el) { el.classList.add('out'); setTimeout(() => el.remove(), 270); }
    syncBehind();
    refreshVisible();
  }
  function popAll() {
    RT.stack.forEach((L) => mapDrop(L.key));
    RT.stack = [];
    const box = document.getElementById('rt-layers'); if (box) box.innerHTML = '';
    syncBehind();
    repaintBase();
  }
  function reset(list) {
    popAll();
    list.forEach((x) => push(x.id, x.vid));
  }
  // Ejecución reemplaza a la Ejecución anterior (y a Vuelta completa de la misma vuelta).
  function swapExec(id, vid) {
    const keep = [];
    RT.stack.forEach((L) => {
      if (L.id === 'exec' || (L.id === 'done' && L.vid === vid)) { mapDrop(L.key); const el = layerEl(L.key); if (el) el.remove(); }
      else keep.push(L);
    });
    RT.stack = keep;
    push(id, vid);
  }
  // Repinta lo que se ve cuando cambia el estado (sin re-animar entradas).
  function refreshVisible() {
    repaintBase();
    RT.stack.forEach((L) => {
      const el = layerEl(L.key); if (!el) return;
      const v = vById(L.vid); if (!v) return;
      if (L.id === 'detail') paintDetail(el, v);
      else if (L.id === 'exec') paintExec(el, v, false);
      else if (L.id === 'done') { el.innerHTML = doneHTML(v); }
    });
  }

  // ── Mi día (RtDay) ────────────────────────────────────────────────────────────
  function heroHTML(v) {
    const s = S(v), t = tone(v), c = crew(v);
    const unread = c.reduce((a, l) => a + (RT.unread[l.rid] || 0), 0);
    const end = endOf(v);
    return '<div class="rt-hero rx-in" style="--tone:' + t.c + '">'
      + '<div class="rt-hero-top"><span class="rt-hero-tag"><b>' + esc(v.n) + '</b>' + t.l + '</span>'
      + '<span class="rt-hero-st ' + (s.started ? 'live' : '') + '">' + (s.started ? '<i></i>' + esc(`En curso · parada ${s.idx + 1} de ${v.legs.length}`) : esc(soon(v))) + '</span></div>'
      + '<div class="rt-hero-time"><b>' + esc(v.start) + '</b><span>' + (madrugadaDe(v) ? esc(madrugadaDe(v)) + '<br>' : '') + (v.type === 'salida'
        ? 'sale hacia la 1.ª casa<br>' + (end ? 'llega a JMC ' + esc(end) : 'destino JMC')
        : 'recoges en JMC<br>' + (end ? 'última casa ~' + esc(end) : 'reparte en las casas')) + '</span></div>'
      + '<div class="rt-hero-route"><span>' + v.from.toUpperCase() + '</span><i></i><span class="rt-hero-pl">' + ic(v.type === 'salida' ? 'Plane' : 'Home', 15) + '</span><i></i><span>' + v.to.toUpperCase() + '</span></div>'
      + '<button type="button" class="rt-crew" data-rt="detail" data-v="' + esc(v.id) + '">'
      + '<span class="rt-stack">' + c.map((l) => '<span>' + esc(l.ini) + '</span>').join('') + '</span>'
      + '<span class="rt-crew-tx"><b>' + c.length + ' auxiliares</b><span>' + esc(s.started ? doing(v) : names(v)) + '</span></span>'
      + (unread > 0 ? '<span class="rt-badge in">' + ic('MessageCircle', 11) + unread + '</span>' : '')
      + ic('ChevronRight', 18) + '</button>'
      + btn(s.started ? `Seguir ruta · parada ${s.idx + 1}` : `Iniciar ruta · ${v.start}`, { cls: 'tone', icon: s.started ? 'Nav' : 'Play', attrs: { 'data-rt': 'start', 'data-v': v.id } })
      + '</div>';
  }
  function vcardHTML(v, i) {
    const s = S(v), t = tone(v), c = crew(v), end = endOf(v);
    return '<button type="button" class="rt-vc rx-in ' + (s.done ? 'done' : '') + '" style="--tone:' + t.c + ';--d:' + i + '" data-rt="' + (s.done ? 'done' : 'detail') + '" data-v="' + esc(v.id) + '">'
      + '<span class="rt-vc-t"><em>' + esc(`${v.n} · ${t.l}`) + '</em><b>' + esc(v.start) + '</b>' + (madrugadaDe(v) ? '<em title="' + esc(madrugadaDe(v)) + '">Madrugada</em>' : '') + '</span>'
      + '<span class="rt-vc-m"><b>' + esc(`${v.from} → ${v.to}`) + '</b><span>' + esc(`${c.length} auxiliares · ${v.type === 'salida' ? (end ? `llega ${end}` : 'destino JMC') : 'recoge en JMC'}`) + '</span></span>'
      + (s.done ? chip('Check', 'ok', 'Hecha') : ic('ChevronRight', 18, 'color: var(--r-text-3);'))
      + '</button>';
  }
  function nowbarHTML(hide) {
    const v = active();
    if (!v || v.id === hide) return '';
    const t = tone(v);
    return '<button type="button" class="rt-nowbar" style="--tone:' + t.c + '" data-rt="exec" data-v="' + esc(v.id) + '">'
      + '<span class="rt-nb-ic">' + ic('Nav', 18) + '</span>'
      + '<span class="rt-nb-tx"><em><i></i>' + esc(`${v.n} en curso · ${RT.sharing ? 'ubicación activa' : 'sin GPS'}`) + '</em><b>' + esc(doing(v)) + '</b></span>'
      + ic('ChevronRight', 20) + '</button>';
  }
  function liveHTML(on) { return '<span class="rt-live ' + (on ? '' : 'off') + '"><i></i>' + (on ? 'Compartiendo ubicación' : 'Ubicación off') + '</span>'; }
  function dayHTML() {
    const list = RT.vueltas;
    const head = '<div class="rt-head"><button type="button" class="rx-ib" data-rt="close" aria-label="Volver">' + ic('ChevronLeft', 22) + '</button><span style="flex:1"></span>' + liveHTML(RT.sharing && !!active()) + '</div>';
    if (!list.length) {
      return '<div class="rt-scr">' + head + '<div class="rt-body">'
        + '<div class="rt-title"><span>Rutas · ' + esc(fmtDay(null)) + '</span><h1>Mi día</h1><p>Sin vueltas asignadas</p></div>'
        + '<div class="rt-alldone rx-in"><span class="rt-empty-ic">' + ic('Route', 30) + '</span><b>No tienes ruta asignada</b><span>Cuando coordinación publique el plan con tu nombre, tus vueltas aparecen aquí y te llega una notificación.</span></div>'
        + '</div></div>';
    }
    const focus = list.find((v) => !S(v).done);
    const later = list.filter((v) => v !== focus && !S(v).done);
    const done = list.filter((v) => S(v).done);
    const crewN = list.reduce((a, v) => a + crew(v).length, 0);
    return '<div class="rt-scr">' + head + '<div class="rt-body">'
      + '<div class="rt-title"><span>' + esc(`Rutas · ${fmtDay(list[0].opDay || list[0].day)}`) + '</span><h1>Mi día</h1><p>' + esc(`${list.length} ${list.length === 1 ? 'vuelta' : 'vueltas'} · ${crewN} auxiliares · JMC`) + '</p></div>'
      + '<div class="rt-dayprog"><div>' + list.map((v) => '<i class="' + (S(v).done ? 'on' : v === focus ? 'now' : '') + '"></i>').join('') + '</div><span>' + esc(`${done.length} de ${list.length} ${list.length === 1 ? 'vuelta' : 'vueltas'}`) + '</span></div>'
      + (focus ? '<div class="rx-lbl">' + (S(focus).started ? 'Ahora' : 'Tu siguiente vuelta') + '</div>' + heroHTML(focus)
        : '<div class="rt-alldone rx-in">' + check(64) + '<b>Terminaste tus rutas de hoy</b><span>' + esc(`Las ${list.length} ${list.length === 1 ? 'vuelta quedó entregada' : 'vueltas quedaron entregadas'}.`) + '</span></div>')
      + (later.length ? '<div class="rx-lbl">Más tarde</div>' + later.map((v, i) => vcardHTML(v, i)).join('') : '')
      + (done.length ? '<div class="rx-lbl">Completadas</div>' + done.map((v, i) => vcardHTML(v, i)).join('') : '')
      + '</div>' + nowbarHTML() + '</div>';
  }
  function doing(v) {
    const s = S(v), st = v.legs[s.idx]; if (!st) return '';
    const f = st.k === 'apt' ? '' : first(st.name);
    if (s.phase === 'at') return st.k === 'pick' ? `Esperando a ${f}` : st.k === 'drop' ? `En la casa de ${f}` : 'En el aeropuerto';
    return st.k === 'pick' ? `Vas por ${f}` : st.k === 'drop' ? `Llevas a ${f} a su casa` : 'Vas al aeropuerto';
  }

  // ── Detalle de la vuelta (RtDetail) ───────────────────────────────────────────
  function pinState(v, i) {
    const s = S(v), r = s.res[v.legs[i].rid];
    if (s.done || (s.started && i < s.idx)) return RT_NO.includes(r) ? 'no' : 'done';
    if (s.started && i === s.idx) return 'cur';
    if (RT_NO.includes(r)) return 'no';
    return 'next';
  }
  function stopRowHTML(v, i) {
    const s = S(v), st = v.legs[i], ps = pinState(v, i), r = s.res[st.rid], apt = st.k === 'apt';
    const lt = st.k === 'pick' ? ['recoge', st.pickup || st.eta] : st.k === 'drop' ? ['llega aprox.', st.eta] : v.type === 'salida' ? ['presentación', present(v)] : ['recoges', v.start];
    const u = RT.unread[st.rid] || 0;
    const f = apt && v.type === 'llegada' ? flightOf(v) : null;
    const pinIn = apt ? ic('Plane', 16) : ps === 'done' ? ic('Check', 16) : ps === 'no' ? ic('X', 15) : legNum(v, i);
    const aptName = 'Aeropuerto JMC';
    const aptAddr = v.type === 'salida' ? 'José María Córdova · Salidas' : 'José María Córdova · Llegadas';
    return '<div class="rt-stop ' + ps + '">'
      + '<span class="rt-pin ' + (apt ? 'apt' : '') + ' ' + ps + '">' + pinIn + '</span>'
      + '<div class="rt-stop-tx">'
      + '<div class="rt-stop-h"><b>' + esc(apt ? aptName : st.name) + '</b>' + (lt[1] ? '<span><em>' + lt[0] + '</em>' + esc(lt[1]) + '</span>' : '') + '</div>'
      + '<span class="rt-stop-a">' + esc(apt ? aptAddr : st.addr) + (!apt && unitTxt(st) ? ' · ' + esc(unitTxt(st)) : '') + '</span>'
      + '<div class="rt-chips">'
      + (r ? chip('', RT_RES[r][1], v.type === 'llegada' && r === 'onboard' && s.done ? 'Entregado' : RT_RES[r][0]) : '')
      + (f ? chip('Plane', f.tone || 'ok', `${f.code}${f.st ? ' ' + f.st : ''}`) : '')
      + (!apt && st.bags > 0 ? chip('Bag', '', String(st.bags)) : '')
      + (!apt && quiet(st) ? chip('Quiet', 'plus', 'Silencio') : '')
      + (!apt && st.meetingPoint ? chip('Door', '', st.meetingPoint) : '')
      + '</div></div>'
      + (!apt && st.rid ? '<button type="button" class="rt-act sm" data-rt="chat" data-v="' + esc(v.id) + '" data-rid="' + esc(st.rid) + '" aria-label="' + esc('Escribir a ' + st.name) + '">' + ic('MessageCircle', 18) + (u > 0 ? '<span class="rt-badge">' + u + '</span>' : '') + '</button>' : '')
      + '</div>';
  }
  function detailHTML(v) {
    const s = S(v), t = tone(v), c = crew(v), f = flightOf(v), end = endOf(v);
    return '<div class="rt-scr" style="--tone:' + t.c + ';--tone-s:' + t.s + '">'
      + '<div class="rt-head"><button type="button" class="rx-ib" data-rt="pop" aria-label="Volver">' + ic('ChevronLeft', 22) + '</button>'
      + '<div class="rt-head-c"><span style="color:' + t.fg + '">' + esc(`${v.n} · ${t.l}`) + '</span><b>' + (v.type === 'salida' ? 'Recoges en casa · destino JMC' : 'Recoges en el aeropuerto') + '</b></div>'
      + '<button type="button" class="rx-ib" data-rt="bigmap" data-v="' + esc(v.id) + '" aria-label="Mapa grande">' + ic('Expand', 18) + '</button></div>'
      + '<div class="rt-body">'
      + '<div class="rt-sum"><div class="rt-sum-t"><b>' + esc(v.start) + '</b>' + (end ? '<i></i><b class="lt">' + esc(end) + '</b>' : '') + '</div>'
      + '<div class="rt-chips">' + chip('Users', '', `${c.length} ${v.type === 'salida' ? 'auxiliares' : 'entregas'}`) + chip('MapPin', '', `${v.legs.length} paradas`) + chip('Clock', '', `~${minsOf(v)} min`)
      + (f ? chip('Plane', f.tone, `${f.code}${f.st ? ' · ' + f.st : ''}`) : '') + '</div></div>'
      + '<button type="button" class="rt-mapcard" data-rt="bigmap" data-v="' + esc(v.id) + '" aria-label="Abrir mapa grande"><div class="rx-map rt-map rt-lf"></div><span class="rt-mapcard-x">' + ic('Expand', 15) + '</span></button>'
      + '<div class="rx-lbl">Paradas en orden</div>'
      + '<div class="rt-stops">' + v.legs.map((_, i) => stopRowHTML(v, i)).join('') + '</div>'
      + (v.type === 'llegada' ? '<div class="rx-note">' + ic('Info', 15) + esc('La hora de cada casa es un estimado de entrega.' + (f && /aterrizó/.test(f.st) ? ` El vuelo ${f.st}.` : '')) + '</div>' : '')
      + '</div>'
      + '<div class="rx-foot">' + (s.done ? btn('Vuelta completada · ver resumen', { kind: 'sec', icon: 'Check', attrs: { 'data-rt': 'done', 'data-v': v.id } })
        : btn(s.started ? `Seguir ruta · parada ${s.idx + 1} de ${v.legs.length}` : `Iniciar ruta · sale ${v.start}`, { cls: 'tone', icon: s.started ? 'Nav' : 'Play', attrs: { 'data-rt': 'start', 'data-v': v.id } })) + '</div>'
      + nowbarHTML(v.id)
      + '</div>';
  }
  // Repinta el Detalle sin tocar su mapa (Leaflet vive en .rt-mapcard).
  function paintDetail(el, v) {
    const scr = el.querySelector('.rt-scr'); if (!scr) return;
    const tmp = document.createElement('div'); tmp.innerHTML = detailHTML(v);
    const fresh = tmp.firstChild;
    ['.rt-sum', '.rt-stops', '.rx-foot'].forEach((sel) => {
      const a = scr.querySelector(sel), b = fresh.querySelector(sel);
      if (a && b) a.replaceWith(b);
    });
    const oldNb = scr.querySelector('.rt-nowbar'), newNb = fresh.querySelector('.rt-nowbar');
    if (oldNb && !newNb) oldNb.remove();
    else if (!oldNb && newNb) scr.appendChild(newNb);
    else if (oldNb && newNb) oldNb.replaceWith(newNb);
    const h = RT.maps[el.dataset.key]; if (h) mapPaint(h);
  }

  // ── Vuelta completa (RtDone) ──────────────────────────────────────────────────
  function doneHTML(v) {
    const s = S(v), t = tone(v), c = crew(v);
    const ok = c.filter((l) => RT_ON.includes(s.res[l.rid])), no = c.filter((l) => RT_NO.includes(s.res[l.rid]));
    const next = RT.vueltas.find((x) => x.id !== v.id && !S(x).done), nt = next && tone(next);
    const mins = s.startedAt && s.finishedAt ? Math.max(1, Math.round((s.finishedAt - s.startedAt) / 60000)) : minsOf(v);
    return '<div class="rt-scr" style="--tone:' + t.c + '">'
      + (!next ? confetti() : '')
      + '<div class="rt-head"><button type="button" class="rx-ib" data-rt="popall" aria-label="Cerrar">' + ic('X', 20) + '</button></div>'
      + '<div class="rt-body rt-done">' + check(92)
      + '<h1 class="rx-c-h">¡Vuelta completa!</h1>'
      + '<p class="rx-c-p">' + esc(`${v.n} · ${t.l} · ${v.type === 'salida' ? `${ok.length} auxiliares entregados en JMC` : `${ok.length} auxiliares en su casa`}`) + '</p>'
      + '<div class="rt-stats"><div><b>' + ok.length + '</b><span>' + (v.type === 'salida' ? 'entregados' : 'en casa') + '</span></div><div><b>' + no.length + '</b><span>' + (v.type === 'salida' ? 'no se presentaron' : 'no llegaron') + '</span></div><div><b>' + mins + '</b><span>' + (mins === 1 ? 'minuto' : 'minutos') + '</span></div></div>'
      + '<div class="rx-group rt-done-list">' + c.map((l) => { const r = s.res[l.rid] || 'delivered'; return '<div class="rt-dl">' + av(l.ini, 'sm') + '<b>' + esc(l.name) + '</b>' + chip('', RT_RES[r][1], RT_NO.includes(r) ? RT_RES[r][0] : r === 'nocode' ? 'Sin código' : 'Entregado') + '</div>'; }).join('') + '</div>'
      + (next ? '<button type="button" class="rt-vc" style="--tone:' + nt.c + '" data-rt="nextv" data-v="' + esc(next.id) + '">'
        + '<span class="rt-vc-t"><em>' + esc(`${next.n} · ${nt.l}`) + '</em><b>' + esc(next.start) + '</b></span>'
        + '<span class="rt-vc-m"><b>' + esc(`Sale a las ${next.start}`) + '</b><span>' + esc(`${next.from} → ${next.to} · ${crew(next).length} auxiliares`) + '</span></span>'
        + ic('ChevronRight', 18) + '</button>' : '')
      + '</div>'
      + '<div class="rx-foot">' + (next
        ? btn(`Ver la vuelta ${next.n}`, { cls: 'tone', style: '--tone:' + nt.c, attrs: { 'data-rt': 'nextv', 'data-v': next.id } }) + btn('Volver a Mi día', { kind: 'ghost', attrs: { 'data-rt': 'popall' } })
        : '<p class="rt-last">Terminaste tus rutas de hoy.</p>' + btn('Volver a Mi día', { attrs: { 'data-rt': 'popall' } }))
      + '</div></div>';
  }

  // ── Ejecución (RtExec) ────────────────────────────────────────────────────────
  function stepsHTML(v) {
    const s = S(v);
    return '<div class="rt-steps">' + v.legs.map((st, i) => {
      const ps = pinState(v, i);
      return '<i class="' + ps + ' ' + (st.k === 'apt' ? 'apt' : '') + '">' + (st.k === 'apt' ? '✈' : ps === 'done' ? ic('Check', 12) : ps === 'no' ? ic('X', 12) : legNum(v, i)) + '</i>';
    }).join('') + '<span>' + esc(`Parada ${s.idx + 1} de ${v.legs.length}`) + '</span></div>';
  }
  // Distancia y minutos en vivo hasta la parada actual (GPS). '' si no hay GPS.
  function liveDist(v) {
    const st = v.legs[S(v).idx];
    const pt = st && (st.k === 'apt' ? [MDE.lat, MDE.lng] : (st.lat != null ? [st.lat, st.lng] : null));
    if (!RT.lastPos || !pt) return '';
    const km = Math.max(0.05, hav(RT.lastPos, pt) * 1.35);
    return `${kmTxt(km)} · ${Math.max(1, Math.round(km / 0.55))} min`;
  }
  // «25 min» · «2 h 05 min» (como el resto de la app, horas en h y min).
  function minTxt(m) { m = Math.round(m); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; }
  function aptLine(v, eta) {
    const pres = present(v);
    const late = eta && pres ? Math.round((eta.getTime() - new Date(v.day + 'T' + pres + ':00-05:00').getTime()) / 60000) : null;
    return { ok: late != null && late <= 0, txt: `Llegas aprox. ${bogHM(eta)}${late == null ? '' : late <= 0 ? ' · vas a tiempo' : ` · ${minTxt(late)} después de la presentación`}` };
  }
  function etaApt(v) {
    if (!RT.lastPos) return null;
    const km = hav(RT.lastPos, [MDE.lat, MDE.lng]) * 1.35;
    return new Date(Date.now() + Math.max(1, Math.round(km / 0.55)) * 60000);
  }
  function personHTML(v, st, compact) {
    const u = RT.unread[st.rid] || 0;
    return '<div class="rt-person ' + (compact ? 'cp' : '') + '">' + av(st.ini)
      + '<div class="rt-person-tx"><b>' + esc(st.name) + '</b>' + (!compact ? '<span>' + esc(hasUnit(st) ? String(st.addr).replace(new RegExp('\\s*·?\\s*' + st.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '') : st.addr) + '</span>' : '') + (st.unit ? '<em>' + esc(st.unit) + '</em>' : '') + '</div>'
      + (st.rid ? '<button type="button" class="rt-act" data-rt="chat" data-v="' + esc(v.id) + '" data-rid="' + esc(st.rid) + '" aria-label="' + esc('Escribir a ' + st.name) + '">' + ic('MessageCircle', 20) + (u > 0 ? '<span class="rt-badge">' + u + '</span>' : '') + '</button>' : '')
      + (st.phone ? '<a class="rt-act" href="tel:' + esc(String(st.phone).replace(/\s/g, '')) + '" aria-label="Llamar">' + ic('Phone', 19) + '</a>' : '')
      + '</div>';
  }
  function infoHTML(st) {
    if (!st.meetingPoint && !st.notes) return '';
    return '<div class="rt-info">'
      + (st.meetingPoint ? '<div>' + ic('Door', 17) + '<span><em>Punto de encuentro</em>' + esc(st.meetingPoint) + '</span></div>' : '')
      + (st.notes ? '<div>' + ic('Note', 17) + '<span><em>' + esc(`Nota de ${first(st.name)}`) + '</em>' + esc(st.notes) + '</span></div>' : '')
      + '</div>';
  }
  function tagsHTML(st) {
    const b = st.bags != null && Number(st.bags) > 0 ? Number(st.bags) : 0;
    if (!b && !quiet(st)) return '';
    return '<div class="rt-chips">' + (b ? chip('Bag', '', `${b} ${b === 1 ? 'maleta' : 'maletas'}`) : '') + (quiet(st) ? chip('Quiet', 'plus', 'Prefiere silencio') : '') + '</div>';
  }
  function footHTML(v, leg, noShow) {
    const f = flightOf(v, leg && leg.k !== 'apt' ? leg : null);
    return '<div class="rt-foot">'
      + (f ? '<span class="rt-foot-f">' + ic('Plane', 15) + esc(f.code) + (f.st ? '<em class="' + f.tone + '">' + esc(f.st) + '</em>' : '') + '</span>' : '<span class="rt-foot-f"></span>')
      + '<span class="rt-foot-r">'
      + (noShow ? '<button type="button" class="rt-link err" data-rt="noshow" data-v="' + esc(v.id) + '"' + (noShow.left > 0 ? ' disabled' : '') + '>' + (noShow.left > 0 ? ic('Lock', 13) + esc(`No se presentó · ${fmtSec(noShow.left)}`) : 'No se presentó') + '</button>' : '')
      + '<button type="button" class="rt-link" data-rt="report" data-v="' + esc(v.id) + '">Reportar novedad</button>'
      + '</span></div>';
  }
  function ringHTML(pct, inner) {
    const C = 2 * Math.PI * 31;
    return '<div class="rt-ring"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="31" class="tr"></circle><circle cx="36" cy="36" r="31" class="pr" style="stroke-dasharray:' + C + ';stroke-dashoffset:' + (C * (1 - pct)) + '"></circle></svg><b>' + inner + '</b></div>';
  }
  // Casillas del código (RtCode). El código nuevo es de 2 dígitos (0097); los de 4
  // que ya existían siguen valiendo, así que hay tantas casillas como dígitos tenga.
  const codeLen = (l) => Math.max(2, String((l && l.meetCode) || '').trim().length || 2);
  function codeBoxesHTML(rid, size, cs, n) {
    n = n || 2;
    const val = (cs && cs.val) || '', st = (cs && cs.st) || '';
    const cols = n === 2 ? '' : ' style="grid-template-columns:repeat(' + n + ',' + (size === 'sm' ? '34px' : '1fr') + ')"';
    return '<label class="rt-boxes ' + size + ' ' + st + '"' + cols + '>'
      + Array.from({ length: n }, (_, i) => '<span class="' + (!st && val.length === i ? 'cur' : '') + '">' + esc(val[i] || '') + '</span>').join('')
      + '<input inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="' + n + '" value="' + esc(val) + '" data-code="' + esc(rid) + '" aria-label="Código de encuentro"' + (st === 'ok' ? ' disabled' : '') + '>'
      + '</label>';
  }
  const waitLeft = (v) => { const s = S(v); return s.at ? waitSec() - (Date.now() - s.at) / 1000 : waitSec(); };

  function pickHTML(v, st) {
    const s = S(v), at = s.phase === 'at', f = first(st.name);
    const code = String(st.meetCode || '').trim();
    const cs = RT.code[st.rid] || {}, nc = !!RT.nc[st.rid];
    const left = at ? waitLeft(v) : waitSec();
    const pres = present(v);
    let h = '<div class="rt-eb">' + (at ? '<i class="ok"></i><span>' + esc(`En el punto · ${f} ya sabe que llegaste`) + '</span>'
      : '<i></i><span>' + esc(`Vas por ${f}`) + '</span><span class="dist">' + esc(liveDist(v)) + '</span>') + '</div>';
    if (!at) h += '<div class="rt-big"><b>' + esc((st.pickup || st.eta) ? `Recoges ${st.pickup || st.eta}` : `Recoges a ${f}`) + '</b><span>' + esc(pres ? `Presentación en JMC ${pres}` : 'Destino JMC') + '</span></div>';
    h += personHTML(v, st, at);
    if (!at) h += tagsHTML(st) + infoHTML(st);
    if (at) {
      h += '<div class="rt-wait ' + (left <= 0 ? 'ok' : '') + '">' + ringHTML(Math.max(0, left) / waitSec(), left <= 0 ? ic('Check', 24) : fmtSec(left))
        + '<div><b>' + (left <= 0 ? 'Espera cumplida' : 'Espera acordada') + '</b><span>' + esc(left <= 0 ? `Si ${f} no aparece, ya puedes seguir.` : `${f} ve este mismo reloj en su app.${pres ? ` Presentación ${pres}.` : ''}`) + '</span></div></div>';
    }
    if (at && code && !nc) {
      h += '<div class="rt-code"><div class="rt-code-h"><b>' + esc(`Pídele a ${f} su código`) + '</b><span>' + codeLen(st) + ' dígitos</span></div>'
        + codeBoxesHTML(st.rid, 'lg', cs, codeLen(st))
        + '<div class="rt-code-m ' + (cs.st || '') + '">' + (cs.st === 'ok' ? esc(`✓ Código correcto · ${f} a bordo`) : cs.st === 'err' ? esc(cs.msg || `Ese no es el código de ${f}. Pídele que lo mire en su app.`)
          : esc(`Está en la app de ${f}, en su viaje. `) + '<button type="button" class="rt-link lt" data-rt="nc" data-rid="' + esc(st.rid) + '">No tiene el código</button>') + '</div></div>';
    }
    if (at && code && nc) h += '<div class="rt-hint">' + ic('Info', 16) + '<span>' + esc(`Va a quedar registrado que ${f} subió sin código. `) + '<button type="button" class="rt-link" data-rt="nc-off" data-rid="' + esc(st.rid) + '">Mejor se lo pido</button></span></div>';
    h += '<div class="rt-cta">'
      + (!at ? btn('Navegar', { kind: 'sec', cls: 'rt-nav', icon: 'Nav', attrs: { 'data-rt': 'nav', 'data-v': v.id, 'aria-label': 'Navegar con Waze' } }) : '')
      + (!at ? btn('Llegué', { cls: 'dark', icon: 'MapPin', attrs: { 'data-rt': 'arrive', 'data-v': v.id } })
        : !code ? btn(`${f} a bordo · siguiente`, { cls: 'tone', icon: 'Check', attrs: { 'data-rt': 'board', 'data-v': v.id, 'data-how': 'onboard' } })
          : nc ? btn(`Subir a ${f} sin código`, { cls: 'warn', icon: 'Check', attrs: { 'data-rt': 'board', 'data-v': v.id, 'data-how': 'nocode' } })
            : btn(cs.st === 'ok' ? `${f} a bordo` : 'Escribe el código para seguir', { cls: cs.st === 'ok' ? 'ok' : '', icon: cs.st === 'ok' ? 'Check' : 'Lock', disabled: cs.st !== 'ok', attrs: { 'data-rt': 'focus-code' } }))
      + '</div>';
    h += footHTML(v, st, at ? { left } : null);
    return h;
  }
  function dropHTML(v, st) {
    const s = S(v), at = s.phase === 'at', f = first(st.name);
    const barrio = (String(st.addr || '').split(',')[1] || st.addr || '').trim();
    const b = st.bags != null ? Number(st.bags) : null;
    let h = '<div class="rt-eb">' + (at ? '<i class="ok"></i><span>' + esc(`En la casa de ${f}`) + '</span>'
      : '<i></i><span>' + esc(`Llevas a ${f} a su casa`) + '</span><span class="dist">' + esc(liveDist(v)) + '</span>') + '</div>';
    h += '<div class="rt-big">' + (at
      ? '<b>' + esc(`Entrega a ${f}`) + '</b>' + (b > 0 ? '<span>' + esc(`Que baje con ${b === 1 ? 'su maleta' : `sus ${b} maletas`}.`) + '</span>' : '')
      : '<b>' + esc(st.eta ? `Llega aprox. ${st.eta}` : `Llevas a ${f}`) + '</b><span>' + esc([st.unit, barrio].filter(Boolean).join(' · ')) + '</span>') + '</div>';
    h += personHTML(v, st, at);
    if (!at) h += infoHTML(st);
    h += '<div class="rt-cta">'
      + (!at ? btn('Navegar', { kind: 'sec', cls: 'rt-nav', icon: 'Nav', attrs: { 'data-rt': 'nav', 'data-v': v.id, 'aria-label': 'Navegar con Waze' } }) : '')
      + (!at ? btn('Llegué a la casa', { cls: 'dark', icon: 'Home', attrs: { 'data-rt': 'arrive', 'data-v': v.id } })
        : btn(`Entregué a ${f} · siguiente`, { cls: 'tone', icon: 'Check', attrs: { 'data-rt': 'drop', 'data-v': v.id } }))
      + '</div>';
    h += footHTML(v, st, null);
    return h;
  }
  function crewListHTML(v, withChat) {
    const s = S(v);
    return '<div class="rx-group">' + crew(v).map((c) => {
      const r = s.res[c.rid], u = RT.unread[c.rid] || 0, b = c.bags != null ? Number(c.bags) : null;
      return '<div class="rt-cl ' + (r || '') + '">' + av(c.ini, 'sm')
        + '<span class="rt-cl-tx"><b>' + esc(c.name) + '</b><span>' + esc(r ? RT_RES[r][0] : (b != null ? `${b} ${b === 1 ? 'maleta' : 'maletas'}` : (c.unit || ''))) + '</span></span>'
        + (r && RT_ON.includes(r) ? '<span class="rt-cl-ok">' + ic('Check', 15) + '</span>' : '')
        + (withChat && !RT_NO.includes(r) && c.rid ? '<button type="button" class="rt-act sm" data-rt="chat" data-v="' + esc(v.id) + '" data-rid="' + esc(c.rid) + '" aria-label="' + esc('Escribir a ' + c.name) + '">' + ic('MessageCircle', 17) + (u > 0 ? '<span class="rt-badge">' + u + '</span>' : '') + '</button>' : '')
        + '</div>';
    }).join('') + '</div>';
  }
  function aptOutHTML(v, st) {
    const s = S(v), at = s.phase === 'at', c = crew(v);
    const onb = c.filter((l) => RT_ON.includes(s.res[l.rid]));
    const pres = present(v), eta = etaApt(v), line = eta ? aptLine(v, eta) : null;
    let h = '<div class="rt-eb">' + (at ? '<i class="ok"></i><span>En JMC · Salidas</span>'
      : '<i></i><span>Vas al aeropuerto</span><span class="dist">' + esc(liveDist(v)) + '</span>') + '</div>';
    h += '<div class="rt-big">' + (at
      ? '<b>' + esc(`Entrega ${onb.length} auxiliares`) + '</b><span>' + esc([pres ? `Presentación ${pres}` : '', s.aptAt ? `llegaste ${bogHM(s.aptAt)}` : ''].filter(Boolean).join(' · ')) + '</span>'
      : '<b>' + esc(pres ? `Presentación ${pres}` : 'Aeropuerto JMC') + '</b>' + (line ? '<span class="' + (line.ok ? 'ok' : '') + '">' + esc(line.txt) + '</span>' : '')) + '</div>';
    h += crewListHTML(v, !at);
    h += '<div class="rt-cta">'
      + (!at ? btn('Navegar', { kind: 'sec', cls: 'rt-nav', icon: 'Nav', attrs: { 'data-rt': 'nav', 'data-v': v.id, 'aria-label': 'Navegar con Waze' } }) : '')
      + (!at ? btn('Llegué al aeropuerto', { cls: 'dark', icon: 'Plane', attrs: { 'data-rt': 'arrive', 'data-v': v.id } })
        : btn(onb.length ? `Entregué a los ${onb.length}` : 'Terminar vuelta', { cls: 'tone', icon: 'Check', attrs: { 'data-rt': 'finish', 'data-v': v.id } }))
      + '</div>';
    h += footHTML(v, st, null);
    return h;
  }
  function crewRowHTML(v, c) {
    const s = S(v), r = s.res[c.rid], u = RT.unread[c.rid] || 0, f = first(c.name);
    const code = String(c.meetCode || '').trim(), cs = RT.code[c.rid] || {}, ask = RT.ask[c.rid] || null;
    const b = c.bags != null ? Number(c.bags) : null;
    if (r) {
      return '<div class="rt-cr done ' + RT_RES[r][1] + '" data-row="' + esc(c.rid) + '">' + av(c.ini, 'sm')
        + '<span class="rt-cl-tx"><b>' + esc(c.name) + '</b><span>' + esc(r === 'onboard' ? '✓ A bordo' : RT_RES[r][0]) + '</span></span>'
        + '<button type="button" class="rt-link" data-rt="undo" data-v="' + esc(v.id) + '" data-rid="' + esc(c.rid) + '">Deshacer</button></div>';
    }
    const sub = cs.st === 'err' ? 'Ese no es su código' : cs.st === 'ok' ? '✓ Código correcto' : (b != null ? `${b} ${b === 1 ? 'maleta' : 'maletas'}` : (code ? 'Pídele su código' : 'Sin código en su reserva'));
    return '<div class="rt-cr" data-row="' + esc(c.rid) + '">'
      + '<div class="rt-cr-top">' + av(c.ini, 'sm')
      + '<span class="rt-cl-tx"><b>' + esc(c.name) + '</b><span class="' + (cs.st === 'err' ? 'err' : '') + '">' + esc(sub) + '</span></span>'
      + (code ? codeBoxesHTML(c.rid, 'sm', cs, codeLen(c)) : '') + '</div>'
      + (!ask ? '<div class="rt-cr-acts">'
        + '<button type="button" data-rt="chat" data-v="' + esc(v.id) + '" data-rid="' + esc(c.rid) + '">' + ic('MessageCircle', 15) + '<span>Escribir</span>' + (u > 0 ? '<span class="rt-badge in">' + u + '</span>' : '') + '</button>'
        + '<button type="button" data-rt="ask" data-rid="' + esc(c.rid) + '" data-ask="nocode">' + (code ? 'Sin código' : 'A bordo') + '</button>'
        + '<button type="button" class="err" data-rt="ask" data-rid="' + esc(c.rid) + '" data-ask="notarrived">No llegó</button></div>'
        : '<div class="rt-cr-ask"><span>' + esc(ask === 'nocode' ? (code ? `¿Subir a ${f} sin código?` : `¿${f} ya está a bordo?`) : `¿Marcar que ${f} no llegó? Le avisamos.`) + '</span>'
        + '<button type="button" data-rt="ask-no" data-rid="' + esc(c.rid) + '">No</button>'
        + '<button type="button" class="' + (ask === 'notarrived' ? 'err' : 'pri') + '" data-rt="ask-yes" data-v="' + esc(v.id) + '" data-rid="' + esc(c.rid) + '">Sí</button></div>')
      + '</div>';
  }
  // Punto de encuentro común en MDE (si todos dijeron el mismo); si no, el general.
  function aptMeet(v) {
    const m = [...new Set(crew(v).map((l) => String(l.meetingPoint || '').trim()))];
    return m.length === 1 && m[0] ? m[0] : 'Salida de pasajeros';
  }
  function aptInHTML(v, st) {
    const s = S(v), at = s.phase === 'at', c = crew(v);
    const open = c.filter((l) => !s.res[l.rid]).length, onb = c.filter((l) => RT_ON.includes(s.res[l.rid])).length;
    const f = flightOf(v), meet = aptMeet(v);
    let h = '<div class="rt-eb">' + (at ? '<i class="ok"></i><span>' + esc(`En JMC · les avisamos a los ${c.length}`) + '</span>'
      : '<i></i><span>Vas a JMC</span><span class="dist">' + esc(liveDist(v)) + '</span>') + '</div>';
    if (!at) h += '<div class="rt-big"><b>' + esc(`Recoges ${v.start}`) + '</b><span class="ok">' + esc([f ? `${f.code}${f.st ? ' ' + f.st : ''}` : '', meet].filter(Boolean).join(' · ')) + '</span></div>';
    if (at) h += '<div class="rt-big sm"><b>Pídele el código a cada uno</b><span>' + esc(`${meet} · cuando lo encuentres, escribe sus 2 dígitos.`) + '</span></div>';
    h += at ? '<div class="rx-group">' + c.map((l) => crewRowHTML(v, l)).join('') + '</div>' : crewListHTML(v, true);
    const nobody = at && open === 0 && onb === 0;
    h += '<div class="rt-cta">'
      + (!at ? btn('Navegar', { kind: 'sec', cls: 'rt-nav', icon: 'Nav', attrs: { 'data-rt': 'nav', 'data-v': v.id, 'aria-label': 'Navegar con Waze' } }) : '')
      + (!at ? btn('Llegué al aeropuerto', { cls: 'dark', icon: 'Plane', attrs: { 'data-rt': 'arrive', 'data-v': v.id } })
        : btn(open ? `Faltan ${open} por resolver` : nobody ? 'Terminar vuelta · nadie llegó' : `Salir del aeropuerto · ${onb} a bordo`, { cls: 'tone', disabled: open > 0, icon: open ? 'Lock' : 'Nav', attrs: { 'data-rt': 'leave', 'data-v': v.id } }))
      + '</div>';
    h += footHTML(v, st, null);
    return h;
  }
  function xsHTML(v) {
    const s = S(v), st = v.legs[s.idx];
    const body = st.k === 'pick' ? pickHTML(v, st) : st.k === 'drop' ? dropHTML(v, st) : v.type === 'salida' ? aptOutHTML(v, st) : aptInHTML(v, st);
    return '<div class="rx-grab"></div>' + stepsHTML(v) + body;
  }
  function pillHTML(v) {
    const s = S(v), t = tone(v), c = crew(v);
    const onb = c.filter((l) => RT_ON.includes(s.res[l.rid])).length;
    const count = v.type === 'llegada' && s.idx > 0
      ? `${c.filter((l) => v.legs.indexOf(l) < s.idx && s.res[l.rid] === 'delivered').length}/${onb} en casa`
      : `${onb}/${c.length} a bordo`;
    return '<b style="color:' + t.fg + '">' + esc(`${v.n} · ${t.l}`) + '</b><span class="sep"></span>' + ic('Users', 15) + '<span>' + esc(count) + '</span>'
      + '<span class="rt-x-live ' + (RT.sharing ? '' : 'off') + '"><i></i>' + (RT.sharing ? 'En vivo' : 'Sin GPS') + '</span>';
  }
  function execHTML(v) {
    const s = S(v), t = tone(v);
    if (!s.started || s.done) return '<div class="rt-scr"></div>';
    return '<div class="rt-scr rt-exec" style="--tone:' + t.c + ';--tone-s:' + t.s + '">'
      + '<div class="rt-map-full"><div class="rx-map rt-map rt-lf"></div></div>'
      + '<div class="rt-x-top"><button type="button" class="rx-ib glass" data-rt="pop" aria-label="Volver">' + ic('ChevronLeft', 22) + '</button>'
      + '<div class="rt-x-pill">' + pillHTML(v) + '</div>'
      + '<button type="button" class="rt-sos" data-rt="sos" data-v="' + esc(v.id) + '">SOS</button></div>'
      + '<div class="rt-x-tools"><button type="button" class="rx-ib glass" data-rt="bigmap" data-v="' + esc(v.id) + '" aria-label="Mapa grande">' + ic('Expand', 18) + '</button>'
      + '<button type="button" class="rx-ib glass rt-recenter" data-rt="recenter" aria-label="Centrarme" hidden>' + ic('Nav', 18) + '</button></div>'
      + '<div class="rt-xs" data-xs="' + s.idx + '-' + s.phase + '">' + xsHTML(v) + '</div>'
      + '</div>';
  }
  // Repinta la Ejecución sin tocar el mapa. Si cambió la parada o la fase, la hoja
  // vuelve a entrar con su animación (key={`${s.idx}-${s.phase}`} en el diseño).
  function paintExec(el, v, force) {
    const s = S(v);
    if (!s.started || s.done) return;
    const pill = el.querySelector('.rt-x-pill'); if (pill) pill.innerHTML = pillHTML(v);
    const xs = el.querySelector('.rt-xs'); if (!xs) return;
    const k = s.idx + '-' + s.phase;
    const changed = xs.dataset.xs !== k;
    // No se repinta mientras escribe un código (se le borraría lo escrito).
    const ae = document.activeElement;
    const typing = !!(ae && ae.matches && ae.matches('input[data-code]') && el.contains(ae));
    if (!changed && !force && typing) return;
    const n = document.createElement('div');
    n.className = 'rt-xs' + (changed ? ' rx-anim' : '');
    n.dataset.xs = k;
    n.innerHTML = xsHTML(v);
    xs.replaceWith(n);
    bindCodes(el);
    if (changed) focusCode(el);
    const h = RT.maps[el.dataset.key]; if (h) { mapPaint(h); if (changed) { h.follow = true; mapFit(h); } }
  }
  function focusCode(el) {
    const i = el.querySelector('.rt-code .rt-boxes input:not([disabled])');
    if (i) setTimeout(() => { try { i.focus({ preventScroll: true }); } catch (e) { /* sin foco */ } }, 420);
  }

  // ── Código de 2 dígitos (RtCode + useRtCode) ──────────────────────────────────
  function bindCodes(el) {
    (el || ui() || document).querySelectorAll('input[data-code]').forEach((inp) => {
      if (inp._rt) return; inp._rt = true;
      inp.addEventListener('input', () => codeInput(inp));
    });
  }
  function codeBoxPaint(label, val, st) {
    if (!label) return;
    label.className = 'rt-boxes ' + (label.classList.contains('sm') ? 'sm' : 'lg') + (st ? ' ' + st : '');   // el estilo de columnas (4 dígitos) no se toca
    const sp = label.querySelectorAll('span');
    sp.forEach((x, i) => { x.textContent = val[i] || ''; x.className = !st && val.length === i ? 'cur' : ''; });
  }
  function codeInput(inp) {
    const rid = inp.dataset.code;
    const v = RT.vueltas.find((x) => x.legs.some((l) => l.rid === rid)); if (!v) return;
    const leg = v.legs.find((l) => l.rid === rid);
    const n = codeLen(leg);
    const x = inp.value.replace(/\D/g, '').slice(0, n);
    inp.value = x;
    const cs = RT.code[rid] = RT.code[rid] || { val: '', st: '' };
    cs.val = x;
    const label = inp.closest('.rt-boxes');
    const row = inp.closest('.rt-cr');
    if (x.length < n) { cs.st = ''; codeBoxPaint(label, x, ''); return; }
    const expected = String(leg.meetCode || '').trim();
    if (expected && x !== expected) { codeFail(v, leg, label, row, null); return; }
    cs.st = 'ok';
    codeBoxPaint(label, x, 'ok');
    inp.disabled = true;
    const f = first(leg.name);
    if (row) { const sub = row.querySelector('.rt-cl-tx > span'); if (sub) { sub.textContent = '✓ Código correcto'; sub.className = ''; } }
    else {
      const m = uiq('.rt-code-m'); if (m) { m.className = 'rt-code-m ok'; m.textContent = `✓ Código correcto · ${f} a bordo`; }
      const cta = uiq('.rt-cta .rx-btn[data-rt="focus-code"]');
      if (cta) { cta.className = 'rx-btn pri ok'; cta.disabled = false; cta.innerHTML = ic('Check', 19) + esc(`${f} a bordo`); }
    }
    setTimeout(async () => {
      const ok = await board(v, leg, x, false, true);
      if (!ok) codeFail(v, leg, label, row, RT.lastBoardErr);
    }, row ? 500 : 900);
  }
  function codeFail(v, leg, label, row, msg) {
    const rid = leg.rid, f = first(leg.name);
    const cs = RT.code[rid] = RT.code[rid] || {};
    cs.st = 'err'; cs.msg = msg || '';
    codeBoxPaint(label, cs.val || '', 'err');
    if (row) { const sub = row.querySelector('.rt-cl-tx > span'); if (sub) { sub.textContent = msg || 'Ese no es su código'; sub.className = 'err'; } }
    else {
      const m = uiq('.rt-code-m'); if (m) { m.className = 'rt-code-m err'; m.textContent = msg || `Ese no es el código de ${f}. Pídele que lo mire en su app.`; }
      const cta = uiq('.rt-cta .rx-btn[data-rt="focus-code"]');
      if (cta) { cta.className = 'rx-btn pri'; cta.disabled = true; cta.innerHTML = ic('Lock', 19) + 'Escribe el código para seguir'; }
    }
    setTimeout(() => {
      RT.code[rid] = { val: '', st: '' };
      const el = label && label.isConnected ? label : null;
      if (el) { const i = el.querySelector('input'); if (i) { i.value = ''; i.disabled = false; try { i.focus({ preventScroll: true }); } catch (e) { /* */ } } codeBoxPaint(el, '', ''); }
      if (row && row.isConnected) { const sub = row.querySelector('.rt-cl-tx > span'); if (sub) { sub.className = ''; sub.textContent = leg.bags != null ? `${leg.bags} ${Number(leg.bags) === 1 ? 'maleta' : 'maletas'}` : 'Pídele su código'; } }
      else if (!row) {
        const m = uiq('.rt-code-m');
        if (m) { m.className = 'rt-code-m'; m.innerHTML = esc(`Está en la app de ${f}, en su viaje. `) + '<button type="button" class="rt-link lt" data-rt="nc" data-rid="' + esc(rid) + '">No tiene el código</button>'; }
      }
    }, 1300);
  }

  // ── Acciones (rt-app.jsx: start, arrive, board, drop, finish, leaveApt, noShow, setRes) ──
  function start(vid) {
    const v = vById(vid); if (!v) return;
    const s = S(v);
    if (s.done) { swapExec('done', vid); return; }
    if (!s.started) {
      s.started = true; s.idx = 0; s.phase = 'road'; s.at = null; s.startedAt = Date.now();
      save();
      markEnRoute(v);
      toast('Ruta iniciada · compartiendo ubicación', 'Nav');
    }
    gpsStart();
    swapExec('exec', vid);
    repaintBase();
  }
  // El aviso «en camino» de la parada que sigue (la base no lo repite: dedupe de 0097).
  function markEnRoute(v) {
    const st = v.legs[S(v).idx]; if (!st || !st.rid) return;
    if (st.k === 'pick') write({ f: 'status', rid: st.rid, st: 'en_route' }).catch(writeErr);
    else if (st.k === 'drop') write({ f: 'status', rid: st.rid, st: 'en_route_home' }).catch(writeErr);
  }
  function writeErr(e) { console.error('[ruta]', e); toast('No se pudo guardar: ' + ((e && e.message) || 'revisa la señal'), 'AlertTriangle'); }

  // Cambio 2 de la entrega: si el GPS dice que está lejos, se confirma antes de avisar.
  function arrive(vid, force) {
    const v = vById(vid); if (!v) return;
    const s = S(v), st = v.legs[s.idx]; if (!st || s.phase === 'at') return;
    const notifies = st.k === 'pick' || (st.k === 'apt' && v.type === 'llegada');
    if (notifies && !force) {
      const pt = st.k === 'apt' ? [MDE.lat, MDE.lng] : (st.lat != null ? [st.lat, st.lng] : null);
      const lim = st.k === 'apt' ? FAR_APT_KM : FAR_HOME_KM;
      const km = RT.lastPos && pt ? hav(RT.lastPos, pt) : null;
      if (pt && (km == null || km > lim)) { openGpsConfirm(v, st, km); return; }
    }
    s.phase = 'at'; s.at = Date.now();
    if (st.k === 'apt') s.aptAt = Date.now();
    if (st.k === 'pick' && st.rid) { st.stopStatus = 'arrived'; write({ f: 'status', rid: st.rid, st: 'at_pickup' }).catch(writeErr); }
    if (st.k === 'apt' && v.type === 'llegada') {
      crew(v).forEach((l) => { if (!l.stopStatus || l.stopStatus === 'pending') l.stopStatus = 'arrived'; });
      if (v.assignmentId) write({ f: 'apt', ra: v.assignmentId }).catch(writeErr);
    }
    save();
    refreshVisible();
  }
  async function board(v, leg, code, sin, fromCode) {
    if (!leg || RT.busy) return false;
    RT.busy = true; RT.lastBoardErr = null;
    const f = first(leg.name);
    try {
      await write({ f: 'board', rid: leg.rid, code: code == null ? null : String(code), sin: !!sin });
    } catch (e) {
      RT.busy = false;
      const wrong = e && (e.hint === 'codigo_incorrecto' || /no coincide/i.test(e.message || ''));
      RT.lastBoardErr = wrong ? `Ese no es el código de ${f}. Pídele que lo mire en su app.` : ('No se pudo marcar: ' + ((e && e.message) || 'revisa la señal'));
      if (!fromCode) toast(RT.lastBoardErr, 'AlertTriangle');
      return false;
    }
    RT.busy = false;
    leg.stopStatus = 'picked_up';
    delete RT.code[leg.rid]; delete RT.nc[leg.rid]; delete RT.ask[leg.rid];
    const how = sin ? 'nocode' : 'onboard';
    if (v.type === 'llegada') { S(v).res[leg.rid] = how; save(); refreshVisible(); }
    else { toast(`${f} a bordo`, 'Check'); advance(v, { [leg.rid]: how }); }
    return true;
  }
  function advance(v, patch) {
    const s = S(v);
    Object.assign(s.res, patch || {});
    let i = s.idx + 1;
    while (i < v.legs.length && v.legs[i].k === 'drop' && RT_NO.includes(s.res[v.legs[i].rid])) i++;
    if (i >= v.legs.length) {
      s.done = true; s.phase = 'road'; s.finishedAt = Date.now(); v.done = true;
      save();
      if (!active()) gpsStop();
      swapExec('done', v.id);
      repaintBase();
      return;
    }
    s.idx = i; s.phase = 'road'; s.at = null;
    save();
    markEnRoute(v);
    refreshVisible();
  }
  function drop(vid) {
    const v = vById(vid); if (!v) return;
    const st = v.legs[S(v).idx]; if (!st) return;
    st.stopStatus = 'delivered';
    if (st.rid) write({ f: 'status', rid: st.rid, st: 'delivered' }).catch(writeErr);
    toast(`${first(st.name)} entregado`, 'Check');
    advance(v, { [st.rid]: 'delivered' });
  }
  // Salida en MDE: se entregan los que van A BORDO (no el que no se presentó).
  function finish(vid) {
    const v = vById(vid); if (!v) return;
    const s = S(v);
    crew(v).forEach((l) => {
      if (RT_ON.includes(s.res[l.rid]) && l.rid) {
        l.stopStatus = 'delivered';
        write({ f: 'status', rid: l.rid, st: 'delivered' }).catch(writeErr);
      }
    });
    advance(v);
  }
  function leaveApt(vid) {
    const v = vById(vid); if (!v) return;
    const s = S(v);
    if (crew(v).some((l) => !s.res[l.rid])) return;
    advance(v);
  }
  function noShow(vid) {
    const v = vById(vid); if (!v) return;
    const s = S(v), st = v.legs[s.idx]; if (!st || st.k !== 'pick') return;
    if (waitLeft(v) > 0) return;
    openSheet('noshow', '<div class="rx-sh"><div class="rx-sh-ic rt-ic err">' + ic('Ban', 26) + '</div>'
      + '<h3>' + esc(`¿${first(st.name)} no se presentó?`) + '</h3>'
      + '<p>' + esc(`${waitMin() === 1 ? 'Esperaste el minuto acordado' : `Esperaste los ${waitMin()} minutos acordados`}. Le avisamos a ${first(st.name)} que no pudimos recogerle y sigues a la siguiente parada.`) + '</p>'
      + btn('Sí, no se presentó', { kind: 'danger', attrs: { 'data-rt': 'noshow-yes', 'data-v': v.id } })
      + btn('Seguir esperando', { kind: 'ghost', attrs: { 'data-rt': 'sheet-close' } }) + '</div>');
  }
  function noShowYes(vid) {
    const v = vById(vid); if (!v) return;
    const st = v.legs[S(v).idx]; if (!st) return;
    closeSheet();
    st.stopStatus = 'no_show';
    if (st.rid) write({ f: 'status', rid: st.rid, st: 'no_show' }).catch(writeErr);
    toast(`${first(st.name)}: no se presentó`, 'Check');
    advance(v, { [st.rid]: 'noshow' });
  }
  // Fila del aeropuerto (llegadas).
  async function setRes(vid, rid, val) {
    const v = vById(vid); if (!v) return;
    const leg = v.legs.find((l) => l.rid === rid); if (!leg) return;
    const s = S(v);
    delete RT.ask[rid];
    if (val === 'nocode') { await board(v, leg, null, true); return; }
    if (val === 'notarrived') {
      try { await write({ f: 'aptno', rid }); }
      catch (e) { writeErr(e); refreshVisible(); return; }
      leg.stopStatus = 'no_show'; s.res[rid] = 'notarrived';
      toast(`${first(leg.name)}: no llegó (le avisamos)`, 'Check');
      save(); refreshVisible();
      return;
    }
    if (val === undefined) {
      try { await write({ f: 'undo', rid }); }
      catch (e) {
        const msg = e && e.hint === 'ya_salio' ? 'El carro ya salió del aeropuerto: ya no se puede deshacer' : ('No se pudo deshacer: ' + ((e && e.message) || 'revisa la señal'));
        toast(msg, 'AlertTriangle'); return;
      }
      leg.stopStatus = 'arrived'; delete s.res[rid]; delete RT.code[rid];
      save(); refreshVisible();
    }
  }

  // ── Hojas (RxSheet): chat, novedad, mapa grande, confirmaciones ───────────────
  function openSheet(kind, html, o) {
    closeSheet(true);
    const box = document.getElementById('rt-sheet-host'); if (!box || !window.AuxRxUI) return null;
    const h = AuxRxUI.sheetOpen(box, html, { tall: o && o.tall, onClose: () => sheetGone(kind) });
    RT.sheet = { kind, close: h && h.close, el: h && h.el };
    return h;
  }
  function closeSheet(now) {
    const sh = RT.sheet; if (!sh) return;
    if (now) {
      const box = document.getElementById('rt-sheet-host'); if (box) box.innerHTML = '';
      sheetGone(sh.kind);
    } else if (sh.close) sh.close();
  }
  function sheetGone(kind) {
    if (RT.sheet && RT.sheet.kind === kind) RT.sheet = null;
    if (kind === 'chat') { RT.chat = null; RT.chatMsgs = []; if (RT.chatPoll) { clearInterval(RT.chatPoll); RT.chatPoll = null; } refreshVisible(); }
    if (kind === 'big') mapDrop('big');
    if (kind === 'report') RT.report = null;
  }
  function openGpsConfirm(v, st, km) {
    const n = crew(v).length, apt = st.k === 'apt', f = first(st.name);
    const title = km == null ? (apt ? 'No vemos tu ubicación' : 'No vemos tu ubicación') : (apt ? 'Todavía no estás en JMC' : `Todavía no estás donde ${f}`);
    const body = km == null
      ? (apt ? `No pudimos confirmar que estés en el aeropuerto. Si avisas ahora, los ${n} auxiliares van a salir a buscarte.` : `No pudimos confirmar que estés en la casa de ${f}. Si avisas ahora, va a salir a buscarte.`)
      : (apt ? `Tu ubicación dice que estás a ${kmTxt(km)} del aeropuerto. Si avisas ahora, los ${n} auxiliares van a salir a buscarte.` : `Tu ubicación dice que estás a ${kmTxt(km)} de la casa de ${f}. Si avisas ahora, va a salir a buscarte.`);
    openSheet('gps', '<div class="rx-sh"><div class="rx-sh-ic rt-ic warn">' + ic('MapPin', 26) + '</div>'
      + '<h3>' + esc(title) + '</h3><p>' + esc(body).replace(esc(km == null ? '§' : kmTxt(km)), '<b>' + esc(km == null ? '' : kmTxt(km)) + '</b>') + '</p>'
      + btn('Avisar cuando llegue', { cls: 'dark', attrs: { 'data-rt': 'sheet-close' } })
      + btn(apt ? 'Ya estoy aquí, avisar igual' : 'Ya llegué, avisar igual', { kind: 'ghost', attrs: { 'data-rt': 'arrive-force', 'data-v': v.id } }) + '</div>');
  }

  // Chat (RtChat). Mismo hilo que ve el tripulante; si Rendio escribe, sale marcado.
  function chatOpen(vid, rid) {
    const v = vById(vid); if (!v) return;
    const st = v.legs.find((l) => l.rid === rid); if (!st) return;
    const f = first(st.name);
    RT.chat = { rid, vid, name: st.name, phone: st.phone };
    RT.chatMsgs = [];
    openSheet('chat', '<div class="rt-chat">'
      + '<div class="rt-chat-h">' + av(st.ini) + '<span class="rt-cl-tx"><b>' + esc(st.name) + '</b><span>' + esc(`Mensajes de este traslado · ${v.n}`) + '</span></span>'
      + (st.phone ? '<a class="rt-act" href="tel:' + esc(String(st.phone).replace(/\s/g, '')) + '" aria-label="Llamar">' + ic('Phone', 19) + '</a>' : '') + '</div>'
      + '<div class="rt-thread" id="rt-thread"><div class="rt-chat-empty">' + ic('MessageCircle', 22) + 'Escríbele si no lo encuentras o si vas retrasado.</div></div>'
      + '<div class="rt-qr">' + RT_QR.map((q) => '<button type="button" data-rt="qr" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div>'
      + '<div class="rt-compose"><div class="rx-input"><input id="rt-chat-in" maxlength="500" autocomplete="off" placeholder="' + esc(`Escribe a ${f}`) + '"></div>'
      + '<button type="button" class="rt-send" data-rt="send" disabled aria-label="Enviar">' + ic('Send', 19) + '</button></div>'
      + '</div>', { tall: true });
    const inp = document.getElementById('rt-chat-in');
    if (inp) {
      inp.addEventListener('input', () => { const b = uiq('.rt-send'); if (b) b.disabled = !inp.value.trim(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chatSend(inp.value); } });
    }
    chatSync();
    if (RT.chatPoll) clearInterval(RT.chatPoll);
    RT.chatPoll = setInterval(chatSync, 5000);
  }
  function bubbleHTML(m, pop) {
    const mine = m.sender_role === 'driver';
    return '<div class="rx-bub ' + (mine ? 'out' : 'in') + (pop ? ' pop' : '') + '" data-mid="' + esc(m.id) + '">' + (m.sender_role === 'admin' ? '<b>Rendio</b>' : '') + esc(m.body) + '</div>';
  }
  function chatPaint(msgs) {
    const th = document.getElementById('rt-thread'); if (!th) return;
    if (!msgs.length) { th.innerHTML = '<div class="rt-chat-empty">' + ic('MessageCircle', 22) + 'Escríbele si no lo encuentras o si vas retrasado.</div>'; return; }
    const have = new Set([...th.querySelectorAll('.rx-bub')].map((b) => b.dataset.mid));
    const fresh = th.querySelector('.rx-bub') == null;
    if (fresh) th.innerHTML = '';
    // Los temporales («tmp…») se reemplazan por el mensaje real.
    th.querySelectorAll('.rx-bub[data-mid^="tmp"]').forEach((b) => { if (!msgs.some((m) => m.id === b.dataset.mid)) b.remove(); });
    msgs.forEach((m) => { if (!have.has(String(m.id))) th.insertAdjacentHTML('beforeend', bubbleHTML(m, !fresh || msgs.length < 8)); });
    th.scrollTop = 99999;
  }
  async function chatSync() {
    const c = RT.chat; if (!c || !window.Api || !Api.listReservationMessages) return;
    let msgs = [];
    try { msgs = await Api.listReservationMessages(c.rid); } catch (e) { return; }
    if (!RT.chat || RT.chat.rid !== c.rid) return;
    RT.chatMsgs = msgs || [];
    chatPaint(RT.chatMsgs);
    if (Api.markReservationMessagesRead) { try { await Api.markReservationMessagesRead(c.rid); } catch (e) { /* */ } }
    RT.unread[c.rid] = 0;
  }
  async function chatSend(text) {
    const body = String(text || '').trim();
    const c = RT.chat;
    if (!body || !c || RT.chatSending) return;
    RT.chatSending = true;
    const inp = document.getElementById('rt-chat-in'); if (inp && inp.value.trim() === body) inp.value = '';
    const b = uiq('.rt-send'); if (b) b.disabled = true;
    const temp = { id: 'tmp' + Date.now(), sender_role: 'driver', body, created_at: new Date().toISOString() };
    RT.chatMsgs = RT.chatMsgs.concat([temp]);
    chatPaint(RT.chatMsgs);
    try {
      const r = await Api.sendReservationMessage(c.rid, body, { title: 'Mensaje de tu conductor', url: '/#/viaje?r=' + encodeURIComponent(c.rid) });
      if (r && r.notified === false && !RT.chatWarned) { RT.chatWarned = true; toast('Enviado. No tiene notificaciones: lo verá al abrir la app', 'Bell'); }
      await chatSync();
    } catch (e) {
      RT.chatMsgs = RT.chatMsgs.filter((m) => m.id !== temp.id);
      const th = document.querySelector('#rt-thread .rx-bub[data-mid="' + temp.id + '"]'); if (th) th.remove();
      if (inp) inp.value = body;
      toast((e && e.message) ? e.message : 'No se pudo enviar el mensaje', 'AlertTriangle');
    } finally { RT.chatSending = false; }
  }
  // Sin leer de todas las paradas del día + el aviso de arriba (RxPushBanner) cuando
  // llega un mensaje y el chat de esa parada no está abierto.
  async function syncUnread() {
    if (!window.Api || !Api.countUnreadMessages || RT.source !== 'live') return;
    const ids = [...new Set(RT.vueltas.flatMap((v) => crew(v).map((l) => l.rid).filter(Boolean)))];
    if (!ids.length) return;
    let counts = {};
    try { counts = await Api.countUnreadMessages(ids, ['auxiliar', 'admin']) || {}; } catch (e) { return; }
    let changed = false, newer = null;
    ids.forEach((id) => {
      const a = RT.unread[id] || 0, b = counts[id] || 0;
      if (a !== b) changed = true;
      if (b > a && !(RT.chat && RT.chat.rid === id)) newer = id;
    });
    RT.unread = counts;
    if (newer) bannerFor(newer);
    if (changed && !(RT.sheet && RT.sheet.kind === 'chat')) refreshVisible();
  }
  async function bannerFor(rid) {
    const v = RT.vueltas.find((x) => x.legs.some((l) => l.rid === rid)); if (!v) return;
    const st = v.legs.find((l) => l.rid === rid);
    let body = 'Te escribió un mensaje.';
    try {
      const msgs = await Api.listReservationMessages(rid);
      const last = (msgs || []).filter((m) => m.sender_role !== 'driver').slice(-1)[0];
      if (last) body = (last.sender_role === 'admin' ? 'Rendio: ' : '') + last.body;
    } catch (e) { /* sin texto */ }
    pushBanner({ icon: 'MessageCircle', title: st.name, body, vid: v.id, rid });
  }
  function pushBanner(p) {
    const box = document.getElementById('rt-push-host'); if (!box) return;
    clearTimeout(RT.pushT);
    box.innerHTML = '<div class="rx-push" data-rt="push-tap" data-v="' + esc(p.vid || '') + '" data-rid="' + esc(p.rid || '') + '"><span class="rx-push-ic">' + ic(p.icon || 'Bell', 16) + '</span>'
      + '<div><div class="rx-push-h"><b>Rendio</b><span>ahora</span></div><b>' + esc(p.title) + '</b><div>' + esc(p.body) + '</div></div></div>';
    RT.pushT = setTimeout(() => { box.innerHTML = ''; }, 4200);
  }
  function toast(m, icon) {
    const box = document.getElementById('rt-toast-host');
    if (!box) { if (typeof window.toast === 'function') window.toast(m); return; }
    clearTimeout(RT.toastT);
    box.innerHTML = '<div class="rx-toast">' + ic(icon || 'Check', 16) + esc(m) + '</div>';
    RT.toastT = setTimeout(() => { box.innerHTML = ''; }, 1800);
  }

  // Reportar novedad / SOS (RtReport).
  function reportOpen(vid, sos) {
    RT.report = { vid, sos: !!sos, k: sos ? 'mec' : null, a: sos ? 'no' : null, b: null, txt: '', sent: false, sending: false, grave: false };
    openSheet('report', reportHTML(), { tall: true });
    bindReportInput();
  }
  const reportGrave = (r) => (r.k === 'mec' && r.a === 'no') || (r.k === 'tra' && r.a === 'det' && r.b === 'acc');
  const reportReady = (r) => r.k && r.txt.trim().length > 2 && (r.k !== 'mec' || r.a) && (r.k !== 'tra' || (r.a && r.b));
  function rq(q, val, opts, act) {
    return '<div class="rt-q"><span>' + esc(q) + '</span><div class="rx-chips">' + opts.map((o) => '<button type="button" class="' + (val === o[0] ? 'on' : '') + '" data-rt="' + act + '" data-x="' + o[0] + '">' + esc(o[1]) + '</button>').join('') + '</div></div>';
  }
  function reportHTML() {
    const r = RT.report; if (!r) return '';
    const v = vById(r.vid), s = v ? S(v) : null;
    const st = v && s.started && !s.done ? v.legs[s.idx] : null;
    const grave = reportGrave(r);
    if (r.sent) {
      return '<div class="rx-sh rt-sent">' + check(72, r.grave ? 'info' : 'ok')
        + '<h3>' + (r.grave ? 'Los jefes ya lo saben' : 'Aviso enviado') + '</h3>'
        + '<p>' + (r.grave ? 'Coordinación recibió tu aviso con tu ubicación. Si puedes, quédate con las luces de parqueo prendidas.' : 'Coordinación lo recibe con tu ubicación. Si hace falta, te escriben por aquí.') + '</p>'
        + btn('Volver a la ruta', { cls: 'dark', attrs: { 'data-rt': 'sheet-close' } }) + '</div>';
    }
    const where = RT.lastPos ? 'Sale con tu ubicación' : 'Sin señal de GPS: el aviso sale sin ubicación';
    return '<div class="rx-sh">'
      + (r.sos ? '<div class="rt-sos-b"><b>SOS</b>Elegimos «Falla mecánica · estoy varado». Cámbialo si es otra cosa.</div>' : '')
      + '<h3>¿Qué está pasando?</h3>'
      + '<p class="rt-meta">' + ic('MapPin', 14) + '<span>' + esc(`${where}${v ? ' · ' + v.n : ''}${st && st.k !== 'apt' ? ' · ' + st.name : ''}`) + '</span></p>'
      + '<div class="rt-opts">' + RT_KINDS.map((o) => '<button type="button" class="rt-opt ' + (r.k === o[0] ? 'on' : '') + '" data-rt="rep-k" data-x="' + o[0] + '">' + ic(o[2], 22) + '<b>' + esc(o[1]) + '</b></button>').join('') + '</div>'
      + (r.k === 'mec' ? rq('¿Puedes seguir manejando?', r.a, [['si', 'Sí, sigo'], ['no', 'No, estoy varado']], 'rep-a') : '')
      + (r.k === 'tra' ? rq('¿Estás detenido o lento?', r.a, [['det', 'Detenido'], ['len', 'Lento']], 'rep-a') + rq('¿Es accidente o tráfico habitual?', r.b, [['acc', 'Accidente'], ['hab', 'Tráfico habitual']], 'rep-b') : '')
      + (r.k ? '<div class="rx-input"><input id="rt-rep-in" maxlength="500" autocomplete="off" value="' + esc(r.txt) + '" placeholder="Cuéntalo en una línea"></div>' : '')
      + btn(r.sending ? 'Enviando…' : grave ? 'Avisar YA a los jefes' : 'Enviar aviso', { kind: grave ? 'danger' : 'pri', cls: grave ? '' : 'dark', disabled: !reportReady(r) || r.sending, attrs: { 'data-rt': 'rep-send' } })
      + btn('Cancelar', { kind: 'ghost', attrs: { 'data-rt': 'sheet-close' } })
      + '</div>';
  }
  function reportPaint() {
    const sh = document.querySelector('#rt-sheet-host .rx-sheet'); if (!sh || !RT.report) return;
    const had = document.activeElement && document.activeElement.id === 'rt-rep-in';
    sh.innerHTML = '<div class="rx-grab"></div>' + reportHTML();
    bindReportInput();
    if (had) { const i = document.getElementById('rt-rep-in'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }
  function bindReportInput() {
    const i = document.getElementById('rt-rep-in'); if (!i) return;
    i.addEventListener('input', () => {
      if (!RT.report) return;
      RT.report.txt = i.value;
      const b = document.querySelector('#rt-sheet-host [data-rt="rep-send"]');
      if (b) b.disabled = !reportReady(RT.report) || RT.report.sending;
    });
  }
  async function reportSend() {
    const r = RT.report; if (!r || r.sending || !reportReady(r)) return;
    r.sending = true; r.grave = reportGrave(r); reportPaint();
    const v = vById(r.vid), s = v ? S(v) : null;
    const st = v && s.started && !s.done ? v.legs[s.idx] : null;
    const details = {};
    if (r.k === 'tra') { details.movimiento = r.a === 'det' ? 'detenido' : 'lento'; details.causa = r.b === 'acc' ? 'accidente' : 'habitual'; }
    if (r.k === 'mec') details.puede_seguir = r.a === 'si';
    if (r.sos) details.sos = true;
    try {
      const id = await Api.reportIncident({
        category: RT_CAT[r.k], description: r.txt.trim(), severity: r.grave ? 'high' : 'medium',
        reservationId: (st && st.rid) || null, details,
        latitude: RT.lastPos ? RT.lastPos[0] : null, longitude: RT.lastPos ? RT.lastPos[1] : null,
      });
      const quien = (RT.profile && RT.profile.full_name) || 'Un conductor';
      const titulo = r.grave ? `🚨 ${RT_CAT_LABEL[r.k]}` : RT_CAT_LABEL[r.k];
      if (typeof notifyOps === 'function') notifyOps(titulo, `${quien}: ${r.txt.trim()}`.slice(0, 200), id);
      r.sent = true; r.sending = false; reportPaint();
    } catch (e) {
      console.error(e);
      r.sending = false; reportPaint();
      toast('No se pudo enviar: ' + ((e && e.message) || 'revisa la señal'), 'AlertTriangle');
    }
  }

  // Mapa grande (RtBigMap).
  function bigMapOpen(vid) {
    const v = vById(vid); if (!v) return;
    const s = S(v), t = tone(v);
    openSheet('big', '<div class="rt-big-map" style="--tone:' + t.c + ';--tone-s:' + t.s + '">'
      + '<div class="rt-bm-h"><b>' + esc(`${v.n} · ${t.l}`) + '</b><span>' + esc(s.started && !s.done ? doing(v) : `${v.legs.length} paradas · ~${minsOf(v)} min`) + '</span></div>'
      + '<div class="rt-bm-map"><div class="rx-map rt-map rt-lf"></div></div>'
      + '<div class="rt-legend"><span><i class="done"></i>Hechas</span><span><i class="cur"></i>Siguiente</span><span><i class="next"></i>Pendientes</span><span><i class="car"></i>Tú</span></div>'
      + '</div>', { tall: true });
    const el = document.querySelector('#rt-sheet-host .rt-bm-map .rt-lf');
    if (el) mapMount('big', el, v, 'big');
  }

  // ── Mapa real (Leaflet) con los pines y tramos del diseño ─────────────────────
  function legPt(l) { return l.k === 'apt' ? [MDE.lat, MDE.lng] : (l.lat != null && isFinite(l.lat) ? [l.lat, l.lng] : null); }
  const osrmCache = new Map();
  async function road(a, b) {
    const k = a.map((n) => n.toFixed(4)).join(',') + ';' + b.map((n) => n.toFixed(4)).join(',');
    if (osrmCache.has(k)) return osrmCache.get(k);
    const p = (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
        const j = await (await fetch(url)).json();
        if (j.code === 'Ok' && j.routes && j.routes[0]) return j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
      } catch (e) { /* sin OSRM: línea directa */ }
      return null;
    })();
    osrmCache.set(k, p);
    const r = await p;
    if (!r) osrmCache.delete(k);
    return r;
  }
  function cssVar(el, n, fb) { try { const x = getComputedStyle(el).getPropertyValue(n).trim(); return x || fb; } catch (e) { return fb; } }
  function pinIcon(txt, ps, apt, label, dx) {
    const R = ps === 'cur' ? 17 : 14;
    const S0 = Math.ceil(R * 1.9) * 2 + 4;
    const half = S0 / 2;
    dx = dx || 0;
    const shape = apt ? '<rect x="' + (-R) + '" y="' + (-R) + '" width="' + 2 * R + '" height="' + 2 * R + '" rx="' + (R * 0.38) + '" style="stroke-width:3px"></rect>'
      : '<circle r="' + R + '" style="stroke-width:3px"></circle>';
    const html = '<svg viewBox="' + (-half) + ' ' + (-half) + ' ' + S0 + ' ' + S0 + '" width="' + S0 + '" height="' + S0 + '" aria-hidden="true">'
      + '<g class="rt-pg ' + ps + (apt ? ' apt' : '') + '">' + (ps === 'cur' ? '<circle r="' + (R * 1.9) + '" class="rt-halo"></circle>' : '') + shape
      + '<text y="' + (R * 0.37) + '" text-anchor="middle" style="font-size:' + (R * 1.05) + 'px">' + esc(txt) + '</text>'
      + (label ? '<text x="' + (R + 7) + '" y="4" class="lbl" style="font-size:13px;stroke-width:4px">' + esc(label) + '</text>' : '')
      + '</g></svg>';
    return L.divIcon({ className: 'rt-lf-pin', html, iconSize: [S0, S0], iconAnchor: [half - dx, half] });
  }
  // En el punto, el diseño corre el carro (+22, +18) para que no tape el pin de la parada.
  function carIcon(label, off) {
    const o = off ? [-22, -18] : [0, 0];
    const html = '<svg viewBox="-24 -24 48 48" width="48" height="48" aria-hidden="true"><g class="car"><circle r="20" class="car-halo"></circle><circle r="11" class="car-dot" style="stroke-width:3px"></circle><circle r="4" class="car-in"></circle>'
      + (label ? '<text y="-18" text-anchor="middle" class="lbl" style="font-size:13px;stroke-width:4px">Estás aquí</text>' : '') + '</g></svg>';
    return L.divIcon({ className: 'rt-lf-car', html, iconSize: [48, 48], iconAnchor: [24 + o[0], 24 + o[1]] });
  }
  function mapMount(k, el, v, mode) {
    if (!el || typeof L === 'undefined' || !v) return;
    mapDrop(k);
    const still = mode === 'detail';
    const map = L.map(el, {
      zoomControl: false, attributionControl: false, preferCanvas: true, tap: false,
      dragging: !still, scrollWheelZoom: !still, doubleClickZoom: !still, boxZoom: false, keyboard: false, touchZoom: !still,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    const h = { k, el, map, v, mode, layers: [], car: null, follow: true, lastFit: 0 };
    RT.maps[k] = h;
    if (mode === 'exec') {
      map.on('dragstart', () => { h.follow = false; const b = el.closest('.rt-exec') && el.closest('.rt-exec').querySelector('.rt-recenter'); if (b) b.hidden = false; });
    }
    mapPaint(h);
    // La capa entra deslizando (rxIn .34 s) y la hoja sube (rxUp .34 s): Leaflet midió
    // a medio camino. Se vuelve a medir al terminar y se encuadra.
    setTimeout(() => { if (RT.maps[k] === h) { map.invalidateSize(); mapFit(h); } }, 60);
    setTimeout(() => { if (RT.maps[k] === h) { map.invalidateSize(); mapFit(h); } }, 380);
    loadRoads(v).then(() => { if (RT.maps[k] === h) mapPaint(h); });
  }
  function mapDrop(k) {
    const h = RT.maps[k]; if (!h) return;
    try { h.map.remove(); } catch (e) { /* ya no está */ }
    delete RT.maps[k];
  }
  // Tramos por carretera entre paradas consecutivas (OSRM), una vez por vuelta.
  async function loadRoads(v) {
    if (v._roads) return v._roads;
    v._roads = (async () => {
      const out = [];
      for (let i = 1; i < v.legs.length; i++) {
        const a = legPt(v.legs[i - 1]), b = legPt(v.legs[i]);
        out[i] = a && b ? (await road(a, b)) || [a, b] : null;
      }
      v._roadPaths = out;
      return out;
    })();
    return v._roads;
  }
  function mapPaint(h) {
    const { map, v, mode } = h;
    const s = S(v);
    const scope = h.el.closest('.rt-scr, .rt-big-map, .rx-phone') || h.el;
    const toneC = cssVar(scope, '--tone', '#F26522');
    const text3 = cssVar(scope, '--r-text-3', '#A1A1AA');
    const roadC = cssVar(scope, '--rx-road', '#FFFFFF');
    h.layers.forEach((ly) => { try { map.removeLayer(ly); } catch (e) { /* */ } });
    h.layers = [];
    const plan = mode !== 'exec' && !s.started;
    const live = s.started && !s.done && !plan;
    const cur = live ? s.idx : s.done ? 99 : -1;
    const paths = v._roadPaths || [];
    // Tramo i = de la parada i-1 a la i (en el diseño, el segmento que llega a la parada i).
    const segs = [];
    for (let i = 1; i < v.legs.length; i++) {
      const a = legPt(v.legs[i - 1]), b = legPt(v.legs[i]);
      if (!a || !b) continue;
      segs.push({ i, pts: paths[i] || [a, b] });
    }
    // Primer tramo de una vuelta en curso: del carro (GPS real) a la parada 1.
    if (live && cur === 0 && RT.lastPos) {
      const b = legPt(v.legs[0]);
      if (b) segs.unshift({ i: 0, pts: h.carPath || [RT.lastPos, b] });
    }
    segs.forEach((sg) => h.layers.push(L.polyline(sg.pts, { color: roadC, weight: 12, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map)));
    segs.forEach((sg) => {
      const st = plan ? 'plan' : sg.i < cur ? 'done' : sg.i === cur ? 'now' : 'next';
      const o = st === 'done' ? { color: text3, weight: 5, opacity: 0.55 }
        : st === 'next' ? { color: toneC, weight: 5, opacity: 0.8, dashArray: '0.1 13' }
          : { color: toneC, weight: 7, opacity: 1 };
      h.layers.push(L.polyline(sg.pts, Object.assign({ lineCap: 'round', lineJoin: 'round', interactive: false }, o)).addTo(map));
    });
    // Varios tripulantes del mismo conjunto caen en el mismo punto: los pines se abren
    // en abanico (30 px entre uno y otro) para que se lea cada número.
    const grupos = {};
    v.legs.forEach((st, i) => { const pt = legPt(st); if (pt) (grupos[pt[0].toFixed(4) + ',' + pt[1].toFixed(4)] = grupos[pt[0].toFixed(4) + ',' + pt[1].toFixed(4)] || []).push(i); });
    v.legs.forEach((st, i) => {
      const pt = legPt(st); if (!pt) return;
      const g = grupos[pt[0].toFixed(4) + ',' + pt[1].toFixed(4)];
      const dx = g.length > 1 ? (g.indexOf(i) - (g.length - 1) / 2) * 30 : 0;
      const ps = plan ? 'next' : pinState(v, i), apt = st.k === 'apt';
      const txt = apt ? '✈' : ps === 'done' ? '✓' : ps === 'no' ? '×' : String(legNum(v, i));
      // En un grupo, un solo letrero (en el último pin) con todos los nombres.
      const label = mode !== 'big' ? '' : apt ? 'JMC'
        : g.length > 1 ? (g.indexOf(i) === g.length - 1 ? g.map((k) => first(v.legs[k].name)).join(', ') : '') : first(st.name);
      h.layers.push(L.marker(pt, { icon: pinIcon(txt, ps, apt, label, dx), interactive: false, zIndexOffset: ps === 'cur' ? 500 : 0 }).addTo(map));
    });
    if (RT.lastPos && (live || mode === 'big')) {
      const enPunto = live && s.phase === 'at' && mode !== 'big';
      h.car = L.marker(RT.lastPos, { icon: carIcon(mode === 'big', enPunto), interactive: false, zIndexOffset: 1000 }).addTo(map);
      h.layers.push(h.car);
    } else h.car = null;
    // Lo que el mapa dibuja, legible desde afuera (las líneas van en un canvas).
    h.el.dataset.trazos = String(segs.length);
    h.el.dataset.pines = String(v.legs.filter(legPt).length);
    h.el.dataset.carro = h.car ? '1' : '0';
  }
  // Encuadre. Ejecución: el tramo que viene, dentro de la franja visible sobre la hoja.
  function mapFit(h) {
    const { map, v, mode, el } = h;
    if (!map || !el.isConnected) return;
    const all = v.legs.map(legPt).filter(Boolean);
    if (RT.lastPos && mode === 'big') all.push(RT.lastPos);
    h.lastFit = Date.now();
    try {
      if (mode !== 'exec') { if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [mode === 'big' ? 46 : 28, mode === 'big' ? 46 : 28], maxZoom: 15 }); return; }
      const s = S(v), st = v.legs[s.idx];
      const here = legPt(st || {});
      let focus = [];
      if (s.phase === 'at') focus = here ? [here] : [];
      else {
        const prev = s.idx > 0 ? legPt(v.legs[s.idx - 1]) : null;
        focus = [RT.lastPos || prev, here].filter(Boolean);
      }
      if (!focus.length) focus = all;
      if (!focus.length) return;
      const scr = el.closest('.rt-exec');
      const top = scr && scr.querySelector('.rt-x-top'), xs = scr && scr.querySelector('.rt-xs');
      const H = el.clientHeight || 600;
      const padTop = top ? Math.round(top.getBoundingClientRect().bottom - el.getBoundingClientRect().top) + 18 : 90;
      const padBot = xs ? Math.round(el.getBoundingClientRect().bottom - xs.getBoundingClientRect().top) + 18 : Math.round(H * 0.55);
      const safeBot = Math.min(padBot, H - padTop - 80);
      map.fitBounds(L.latLngBounds(focus), { paddingTopLeft: [40, padTop], paddingBottomRight: [40, Math.max(40, safeBot)], maxZoom: s.phase === 'at' ? 16 : 16 });
    } catch (e) { /* mapa sin tamaño todavía */ }
  }

  // ── GPS ───────────────────────────────────────────────────────────────────────
  function gpsStart() {
    if (RT.watchId != null || !navigator.geolocation) { liveBadges(); return; }
    try {
      RT.watchId = navigator.geolocation.watchPosition(onPos, () => { RT.sharing = false; liveBadges(); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    } catch (e) { RT.watchId = null; }
  }
  function gpsStop() {
    if (RT.watchId != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(RT.watchId); } catch (e) { /* */ } }
    RT.watchId = null; RT.sharing = false;
    liveBadges();
  }
  function onPos(p) {
    const c = p && p.coords; if (!c || !isFinite(c.latitude)) return;
    const wasSharing = RT.sharing;
    RT.lastPos = [c.latitude, c.longitude];
    RT.sharing = true;
    if (!wasSharing) liveBadges();
    const v = active();
    // Mapas: el carro se mueve; la Ejecución lo sigue (si no lo arrastró).
    Object.values(RT.maps).forEach((h) => {
      if (h.car) h.car.setLatLng(RT.lastPos); else if (h.mode === 'exec' || h.mode === 'big') mapPaint(h);
      if (h.mode === 'exec' && h.follow && Date.now() - h.lastFit > 5000) mapFit(h);
    });
    if (v) {
      // Primer tramo real (del carro a la primera parada), una vez.
      const s = S(v);
      if (s.idx === 0 && s.phase === 'road' && !v._carPathAsked) {
        v._carPathAsked = true;
        const b = legPt(v.legs[0]);
        if (b) road(RT.lastPos, b).then((pts) => { Object.values(RT.maps).forEach((h) => { if (h.v === v && pts) { h.carPath = pts; mapPaint(h); } }); });
      }
      liveText(v);
      near(v);
      ping(v, c);
    }
    flushQueue();
  }
  function ping(v, c) {
    if (RT.source !== 'live' || !RT.driverProfileId || !(window.Api && Api.sendDriverLocation)) return;
    const now = Date.now();
    if (now - RT.lastPingAt < PING_MS) return;
    RT.lastPingAt = now;
    Api.sendDriverLocation(RT.driverProfileId, c.latitude, c.longitude, {
      routeAssignmentId: v && v.assignmentId,
      heading: c.heading,
      speedKmh: isFinite(c.speed) && c.speed != null ? c.speed * 3.6 : undefined,
    }).catch(() => { /* el ancla por evento (0045) es la red de seguridad */ });
  }
  // «Estoy cerca» (la base avisa al tripulante; 0097 también lo detecta sola).
  function near(v) {
    if (RT.source !== 'live') return;
    const st = v.legs[S(v).idx];
    if (!st || st.k !== 'pick' || !st.rid || st._near || st.lat == null) return;
    if (hav(RT.lastPos, [st.lat, st.lng]) < 0.3 && window.Api && Api.driverNearStop) {
      st._near = true;
      Api.driverNearStop(st.rid).catch(() => { st._near = false; });
    }
  }
  function liveBadges() {
    uiqa('.rt-live').forEach((b) => {
      const on = RT.sharing && !!active();
      b.classList.toggle('off', !on);
      b.innerHTML = '<i></i>' + (on ? 'Compartiendo ubicación' : 'Ubicación off');
    });
    uiqa('.rt-x-live').forEach((b) => {
      b.classList.toggle('off', !RT.sharing);
      b.innerHTML = '<i></i>' + (RT.sharing ? 'En vivo' : 'Sin GPS');
    });
    uiqa('.rt-nowbar .rt-nb-tx > em').forEach((e) => {
      const v = active(); if (v) e.innerHTML = '<i></i>' + esc(`${v.n} en curso · ${RT.sharing ? 'ubicación activa' : 'sin GPS'}`);
    });
  }
  // Distancia en vivo (y la llegada estimada a MDE) sin repintar la hoja.
  function liveText(v) {
    const d = liveDist(v);
    uiqa('.rt-exec .rt-eb .dist').forEach((e) => { e.textContent = d; });
    const s = S(v), st = v.legs[s.idx];
    if (st && st.k === 'apt' && v.type === 'salida' && s.phase === 'road') {
      const el = uiq('.rt-exec .rt-big > span');
      const eta = etaApt(v);
      if (el && eta) { const line = aptLine(v, eta); el.className = line.ok ? 'ok' : ''; el.textContent = line.txt; }
    }
  }

  // Reloj de espera y «No se presentó · 4:12» cada segundo, sin repintar.
  function tick() {
    if (!RT.open) return;
    const L0 = RT.stack[RT.stack.length - 1];
    if (!L0 || L0.id !== 'exec') return;
    const v = vById(L0.vid); if (!v) return;
    const s = S(v), st = v.legs[s.idx];
    if (!st || st.k !== 'pick' || s.phase !== 'at') return;
    const el = layerEl(L0.key); if (!el) return;
    const left = waitLeft(v), f = first(st.name), pres = present(v);
    const w = el.querySelector('.rt-wait');
    if (w) {
      const okNow = left <= 0;
      const wasOk = w.classList.contains('ok');
      w.classList.toggle('ok', okNow);
      const pr = w.querySelector('.pr');
      const C = 2 * Math.PI * 31;
      if (pr) pr.style.strokeDashoffset = String(C * (1 - Math.max(0, left) / waitSec()));
      const b = w.querySelector('.rt-ring > b');
      if (b && (!okNow || !wasOk)) b.innerHTML = okNow ? ic('Check', 24) : fmtSec(left);
      const t = w.querySelector(':scope > div:not(.rt-ring) > b'), sp = w.querySelector(':scope > div:not(.rt-ring) > span');
      if (t) t.textContent = okNow ? 'Espera cumplida' : 'Espera acordada';
      if (sp) sp.textContent = okNow ? `Si ${f} no aparece, ya puedes seguir.` : `${f} ve este mismo reloj en su app.${pres ? ` Presentación ${pres}.` : ''}`;
    }
    const ns = el.querySelector('.rt-link.err[data-rt="noshow"]');
    if (ns) {
      if (left > 0) { ns.disabled = true; ns.innerHTML = ic('Lock', 13) + esc(`No se presentó · ${fmtSec(left)}`); }
      else if (ns.disabled) { ns.disabled = false; ns.textContent = 'No se presentó'; }
    }
  }

  // Estado de los vuelos (0099): el chip aparece cuando llega el dato.
  async function loadFlights() {
    try {
      if (!window.RendioVuelos || !RT.vueltas.length) return;
      const days = [...new Set(RT.vueltas.map((v) => v.day).filter(Boolean))];
      await RendioVuelos.cargar(days);
      if (RT.open && RT.vueltas.some((v) => crew(v).some((l) => l.flight))) refreshVisible();
    } catch (e) { /* sin vuelos */ }
  }

  // ── Eventos (un solo listener delegado) ───────────────────────────────────────
  function bindOnce() {
    if (RT.bound) return;
    const root = host(); if (!root) return;
    RT.bound = true;
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-rt]'); if (!el || !root.contains(el)) return;
      const a = el.dataset.rt, vid = el.dataset.v, rid = el.dataset.rid;
      if (el.disabled) return;
      if (a === 'close') { rtClose(); return; }
      if (a === 'pop') { pop(); return; }
      if (a === 'popall') { popAll(); return; }
      if (a === 'detail') { push('detail', vid); return; }
      if (a === 'done') { push('done', vid); return; }
      if (a === 'exec') { const v = vById(vid); if (v && S(v).started && !S(v).done) swapExec('exec', vid); return; }
      if (a === 'nextv') { reset([{ id: 'detail', vid }]); return; }
      if (a === 'start') { start(vid); return; }
      if (a === 'arrive') { arrive(vid, false); return; }
      if (a === 'arrive-force') { closeSheet(); arrive(vid, true); return; }
      if (a === 'board') {
        const v = vById(vid); if (!v) return;
        const leg = v.legs[S(v).idx];
        board(v, leg, null, true);
        return;
      }
      if (a === 'focus-code') { const i = root.querySelector('.rt-code .rt-boxes input'); if (i) i.focus(); return; }
      if (a === 'nc') { RT.nc[rid] = true; refreshVisible(); return; }
      if (a === 'nc-off') { delete RT.nc[rid]; refreshVisible(); const L0 = RT.stack[RT.stack.length - 1]; const el2 = L0 && layerEl(L0.key); if (el2) focusCode(el2); return; }
      if (a === 'drop') { drop(vid); return; }
      if (a === 'finish') { finish(vid); return; }
      if (a === 'leave') { leaveApt(vid); return; }
      if (a === 'noshow') { noShow(vid); return; }
      if (a === 'noshow-yes') { noShowYes(vid); return; }
      if (a === 'ask') { RT.ask[rid] = el.dataset.ask; refreshVisible(); return; }
      if (a === 'ask-no') { delete RT.ask[rid]; refreshVisible(); return; }
      if (a === 'ask-yes') { const val = RT.ask[rid]; setRes(vid, rid, val); return; }
      if (a === 'undo') { setRes(vid, rid, undefined); return; }
      if (a === 'nav') {
        const v = vById(vid); const st = v && v.legs[S(v).idx]; const pt = st && legPt(st);
        if (pt) window.open(`https://waze.com/ul?ll=${pt[0]},${pt[1]}&navigate=yes`, '_blank');
        toast('Abriendo Waze…', 'Nav');
        return;
      }
      if (a === 'chat') { chatOpen(vid, rid); return; }
      if (a === 'qr') { chatSend(el.dataset.q); return; }
      if (a === 'send') { const i = document.getElementById('rt-chat-in'); if (i) chatSend(i.value); return; }
      if (a === 'push-tap') { document.getElementById('rt-push-host').innerHTML = ''; if (vid && rid) chatOpen(vid, rid); return; }
      if (a === 'report') { reportOpen(vid, false); return; }
      if (a === 'sos') { reportOpen(vid, true); return; }
      if (a === 'rep-k') { const r = RT.report; if (!r) return; r.k = el.dataset.x; r.a = null; r.b = null; reportPaint(); return; }
      if (a === 'rep-a') { if (RT.report) { RT.report.a = el.dataset.x; reportPaint(); } return; }
      if (a === 'rep-b') { if (RT.report) { RT.report.b = el.dataset.x; reportPaint(); } return; }
      if (a === 'rep-send') { reportSend(); return; }
      if (a === 'bigmap') { bigMapOpen(vid); return; }
      if (a === 'recenter') { const L0 = RT.stack[RT.stack.length - 1]; const h = L0 && RT.maps[L0.key]; if (h) { h.follow = true; mapFit(h); } el.hidden = true; return; }
      if (a === 'sheet-close') { closeSheet(); return; }
    });
  }
})();
