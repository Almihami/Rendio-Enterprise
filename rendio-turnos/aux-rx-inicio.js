// aux-rx-inicio.js — P3 · Inicio del rediseño del auxiliar (27-sep-2026).
//
// Porta RxHome, RxPass y RxLive de rx-home.jsx con el MISMO marcado y las
// MISMAS clases (rx-home-h, rx-bell, rx-body home, rx-in --d, rx-pass*,
// rx-live*, rx-rate-card, rx-qa, rx-select-teaser, rx-strip, rx-empty-trip).
// Lo que el diseño no trae (nota del pase, código pequeño, «Ver tus N»,
// mapa real del RxLive) va en rx-aux-inicio.css.
//
// Datos: solo lo que trae el viaje T (ApiAux.mapTrip / listMyReservations) y el
// rastreo I. Nada inventado (plan final §3.2–§3.4, D7, D12, D14, D15, D21):
//   · «Te recogemos HH:MM» SOLO con pickupAt publicado; si no, «Estar en MDE» +
//     la hora del vuelo, y la nota «te avisamos cuando armemos tu ruta».
//   · Nunca «Presentación», nunca «Trayecto», nunca un ETA (no hay OSRM aquí).
//   · El carro del mapa solo se pinta con I.pos real (D14).
//   · Un solo anzuelo (home.hook), nunca con un viaje en curso (D15).
//
// Contrato: window.AuxRxInicio = { passHTML(t,{scale,tag}), liveHTML(t),
//   homeHTML(), isLive(t), isPublished(t), conjunto(t),
//   pickupOrder(t) → {pos,total,text,label}|null, canChangeFlight(t) }.
//
// Pedido del 29-sep-2026: MDE lleva debajo «JMC» y «Rionegro» en dos líneas; el
// orden en el carro («Recogida 2/3», «Parada 1/1») solo con la ruta publicada;
// en un traslado de tierra (groundOps) no hay celda «Vuelo» y en la llegada la
// hora grande es «Sales del aeropuerto».
// Registra: AuxShell.register('home'), el enganche 'home.hook' de Select
// (prioridad 10) y las acciones data-rx «rate-trip» e «inicio-share».
//
// Tiempos del diseño: entradas .rx-in con --d (60 ms por paso, del CSS), el
// globo de la campana se RECREA cuando cambia el número (key={unread}).
(function () {
  'use strict';

  const TZ = 'America/Bogota';
  // El mismo punto del aeropuerto que usa auxiliar.js (AUX_MDE).
  const MDE = { lat: 6.1715, lng: -75.4270 };
  // Rastreo del RxLive mientras Inicio está arriba (el viaje abierto usa 6 s).
  const LIVE_POLL_MS = 10000;
  const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

  const UI = () => window.AuxRxUI || null;
  const AX = () => window.Auxiliar || null;
  const SH = () => window.AuxShell || null;

  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ic(n, s) {
    const u = UI(); if (u && u.ic) return u.ic(n, s);
    const sh = SH(); return sh && sh.ic ? sh.ic(n, s) : '';
  }
  function hm(v) {
    const u = UI(); if (u && u.hm) return u.hm(v);
    if (!v) return '';
    try { return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(v)); }
    catch (_) { return ''; }
  }
  function dayLabel(d) { const u = UI(); return u && u.dayLabel ? u.dayLabel(d) : String(d || ''); }
  function initials(n, fb) { const u = UI(); return u && u.initials ? u.initials(n, fb) : (String(n || '').trim().charAt(0).toUpperCase() || fb); }

  // ── El viaje T ───────────────────────────────────────────────────────────
  const auxSt = () => { const a = AX(); return (a && a.state) || {}; };
  const trips = () => (Array.isArray(auxSt().trips) ? auxSt().trips : []);
  // Ajustes de la operación (el global `state` de core.js; en pruebas, window.state).
  function settings() {
    // eslint-disable-next-line no-undef
    try { if (typeof state !== 'undefined' && state && state.settings) return state.settings; } catch (_) { /* */ }
    return (window.state && window.state.settings) || {};
  }
  const findTrip = (id) => trips().find(t => t && String(t.id) === String(id)) || null;
  const info = (t) => (t && t._info) || null;
  function whenTs(t) {
    if (!t) return null;
    if (t.requiredAt) { const x = Date.parse(t.requiredAt); if (!isNaN(x)) return x; }
    if (!t.date || !t.time) return null;
    const x = new Date(t.date + 'T' + t.time + ':00-05:00').getTime();
    return isNaN(x) ? null : x;
  }
  function arrived(t) {
    const i = info(t);
    return !!((i && i.stop_status === 'arrived') || (t && t.stopStatus === 'arrived'));
  }
  // En curso: va por ti, ya llegó o vas a bordo (§3.2 RxLive).
  function isLive(t) {
    if (!t) return false;
    if (t.status === 'onway' || t.status === 'onboard') return true;
    return t.status === 'assigned' && arrived(t);
  }
  // Publicado: lo dice ApiAux (0087). Con el respaldo (listMyReservations) no
  // viene el dato: cuenta como publicado si ya hay hora o conductor asignado.
  function isPublished(t) {
    if (!t) return false;
    if (t.published === true) return true;
    if (t.published === false) return false;
    return !!t.pickupAt || ['assigned', 'onway', 'onboard', 'done'].includes(t.status);
  }
  const pickupISO = (t) => (t && t.pickupAt && isPublished(t) && hm(t.pickupAt) ? t.pickupAt : null);
  function upcoming() { const a = AX(); return a && typeof a.upcoming === 'function' ? safe(() => a.upcoming(), []) || [] : []; }
  function inCourse() { return upcoming().some(isLive); }

  // Nombre del conjunto: el del catálogo (cabecera) si el viaje salió de ahí;
  // si no, la primera parte de la dirección.
  function conjunto(t) {
    const h = AX() && AX().header;
    if (h && t && t.residenceId) {
      if (h.residenceId === t.residenceId && h.residence && h.residence.name) return h.residence.name;
      if (h.residenceId2 === t.residenceId && h.residence2 && h.residence2.name) return h.residence2.name;
    }
    const a = String((t && t.address) || '').split(/[,·]/)[0].trim();
    if (a) return a;
    return (h && h.residence && h.residence.name) || 'Casa';
  }
  function levelOf(t) {
    if (t && t.level === 'private') {
      if (t.privateStatus === 'approved') return { name: 'Privado', tone: 'plus', vip: true };
      if (t.privateStatus === 'rejected') return { name: 'Compartido', tone: 'n', vip: false };
      return { name: 'Privado · por confirmar', tone: 'plus', vip: false, asked: true };
    }
    return { name: 'Compartido', tone: 'n', vip: false };
  }
  const firstOf = (t) => {
    const d = t && t.driver;
    return (d && (d.first || String(d.name || '').trim().split(/\s+/)[0])) || '';
  };
  const plateOf = (t) => (t && ((t.vehicle && t.vehicle.plate) || (t.driver && t.driver.plate) || (info(t) && info(t).plate))) || '';
  function vehLine(t) {
    const v = (t && t.vehicle) || {};
    return [[v.brand, v.model].filter(Boolean).join(' '), v.color, plateOf(t)].filter(Boolean).join(' · ');
  }
  function codeOf(t) { return String((t && t.meetCode) || (info(t) && info(t).meet_code) || ''); }

  // Mi lugar en el carro (0093, «2/3»): SOLO con la ruta publicada (published
  // === true, el k.pub de auxiliar_my_trips) y los dos números enteros y
  // coherentes. Sin eso, null: no se pinta nada (ni un «por confirmar»).
  // Salida: orden de recogida. Llegada: el orden en que los dejan (el carro
  // recoge a todos juntos en MDE), por eso «Parada».
  function pickupOrder(t) {
    if (!t || t.published !== true || t.pickupPos == null || t.pickupTotal == null) return null;
    const p = Number(t.pickupPos), n = Number(t.pickupTotal);
    if (!Number.isInteger(p) || !Number.isInteger(n) || p < 1 || n < p) return null;
    return { pos: p, total: n, text: p + '/' + n, label: t.type === 'lle' ? 'Parada' : 'Recogida' };
  }
  // «Solo por tierra» (0092/0093): operación del aeropuerto sin vuelo.
  const isGround = (t) => !!t && t.groundOps === true;
  // ¿Se le puede cambiar el vuelo / la hora? La MISMA regla con la que Inicio
  // ofrece «Cambió mi vuelo» (y la que usa la hoja del viaje para su botón):
  // próximo, pedido o asignado, y el conductor todavía no llegó por él.
  function canChangeFlight(t) {
    if (!t || (t.status !== 'pending' && t.status !== 'assigned') || arrived(t)) return false;
    const a = AX();
    return !(a && typeof a.isUpcoming === 'function') || !!safe(() => a.isUpcoming(t), false);
  }

  // ── RxPass (§3.3) ─────────────────────────────────────────────────────────
  // passHTML(t, {scale, tag:'button'|'div'}) — scale para mostrarlo reducido
  // (p. ej. en «booked»); tag 'div' lo deja sin toque.
  // El aeropuerto va en tres líneas: «MDE» grande y debajo «JMC» y «Rionegro».
  const APT_SUB = ['JMC', 'Rionegro'];
  function ptHTML(p, right) {
    return '<div class="rx-pass-pt' + (right ? ' r' : '') + '"><b>' + esc(p[0]) + '</b>'
      + p[1].map(s => '<span>' + esc(s) + '</span>').join('') + '</div>';
  }
  function passHTML(t, o) {
    o = o || {};
    if (!t) return '';
    const u = UI();
    const lle = t.type === 'lle';
    const ground = isGround(t);
    const L = levelOf(t);
    const pub = isPublished(t);
    const pk = pickupISO(t);
    const home = conjunto(t);
    const from = lle ? ['MDE', APT_SUB] : ['CASA', [home]];
    const to = lle ? ['CASA', [home]] : ['MDE', APT_SUB];
    let bigL, bigV;
    if (pk) { bigL = lle ? 'Te esperamos en MDE' : 'Te recogemos'; bigV = hm(pk); }
    else { bigL = lle ? (ground ? 'Sales del aeropuerto' : 'Aterrizas') : 'Estar en MDE'; bigV = t.time || '--:--'; }
    const note = !pub ? 'Hora de recogida: te avisamos cuando armemos tu ruta'
      : (!pk ? 'Conductor asignado · hora por confirmar' : '');
    // Grilla: nunca «Trayecto» ni «Presentación». La hora del vuelo solo si la
    // grande es la recogida (si no, ya es la grande). En tierra no hay vuelo.
    const cells = [];
    if (!lle) {
      if (pk && t.time) cells.push(['En MDE', t.time]);
      if (t.flight && !ground) cells.push(['Vuelo', t.flight]);
    } else {
      if (t.flight && !ground) cells.push(['Vuelo', t.flight]);
      if (pk && t.time) cells.push([ground ? 'Sales' : 'Aterriza', t.time]);
    }
    if (t.bags != null && t.bags !== '') cells.push(['Maletas', String(t.bags)]);
    // El orden en el carro va último, en la fila de Maletas y pegado a la
    // derecha (rx-pass-ord). Con cuatro celdas la grilla pasa a cuatro columnas.
    const ord = pickupOrder(t);
    const cols = ord ? Math.max(3, cells.length + 1) : 3;
    const cell = (c, cls) => '<div' + (cls ? ' class="' + cls + '"' : '') + '><span>' + esc(c[0]) + '</span><b>' + esc(c[1]) + '</b></div>';
    // Pie: conductor real, o lo que falta dicho de frente.
    const d = t.driver;
    let bot;
    if (d && d.name) {
      const veh = vehLine(t);
      const avatar = u && u.av ? u.av(d.initials || initials(d.name, 'C'), 'sm', 'lt', { src: d.avatarUrl || '' }) : '';
      bot = avatar + '<span class="rx-pass-drv"><b>' + esc(d.name) + '</b>' + (veh ? '<span>' + esc(veh) + '</span>' : '') + '</span>';
    } else if (L.asked) {
      bot = '<span class="rx-pass-wait"><i></i></span><span class="rx-pass-drv"><b>Coordinación confirma tu privado</b></span>';
    } else if (pub) {
      bot = '<span class="rx-pass-wait">' + ic('Car', 16) + '</span><span class="rx-pass-drv"><b>Conductor asignado</b><span>Toca para ver el detalle</span></span>';
    } else {
      bot = '<span class="rx-pass-wait"><i></i></span><span class="rx-pass-drv"><b>Asignando conductor</b></span>';
    }
    const code = codeOf(t);
    const showCode = !!code && !!safe(() => AX().meetVisible(t, info(t)), false);
    const tag = o.tag === 'div' ? 'div' : 'button';
    const style = o.scale && Number(o.scale) !== 1 ? ' style="--rx-pass-scale:' + Number(o.scale) + '"' : '';
    const act = tag === 'button' ? ' type="button" data-ax="trip" data-id="' + esc(t.id) + '"' : '';
    return '<' + tag + act + ' class="rx-pass' + (L.vip ? ' vip' : '') + (style ? ' rx-pass-scaled' : '') + '"' + style + '>'
      + '<div class="rx-pass-top"><span class="rx-pass-day">' + esc(dayLabel(t.date)) + '</span>'
      + '<span class="rx-pass-lv t-' + esc(L.tone) + '">' + esc(L.name) + '</span></div>'
      + '<div class="rx-pass-main">'
      + ptHTML(from, false)
      + '<div class="rx-pass-mid"><i></i><span class="rx-pass-plane">' + ic(lle ? 'Plane' : 'Car', 16) + '</span><i></i></div>'
      + ptHTML(to, true)
      + '</div>'
      + '<div class="rx-pass-time"><span>' + esc(bigL) + '</span><b>' + esc(bigV) + '</b></div>'
      + (note ? '<div class="rx-pass-note">' + ic('Clock', 14) + '<span>' + esc(note) + '</span></div>' : '')
      + (cells.length || ord ? '<div class="rx-pass-grid"' + (cols > 3 ? ' style="grid-template-columns:repeat(' + cols + ',1fr)"' : '') + '>'
        + cells.map(c => cell(c)).join('') + (ord ? cell([ord.label, ord.text], 'rx-pass-ord') : '') + '</div>' : '')
      + '<div class="rx-pass-perf"><i></i><span></span><i></i></div>'
      + '<div class="rx-pass-bot">' + bot
      + (showCode ? '<span class="rx-pass-code">Código <b>' + esc(code) + '</b></span>' : '')
      + (tag === 'button' ? ic('ChevronRight', 18) : '')
      + '</div>'
      + '</' + tag + '>';
  }

  // ── RxLive (§3.4) ─────────────────────────────────────────────────────────
  function waitUntil(t) {
    const i = info(t);
    const at = (i && i.arrived_at) || t.arrivedAt;
    let w = i && i.wait_minutes;
    if (w == null) w = settings().aux_wait_minutes;
    const ms = at ? Date.parse(at) : NaN;
    if (isNaN(ms) || w == null || isNaN(Number(w))) return '';
    return hm(new Date(ms + Number(w) * 60000).toISOString());
  }
  function freshText(t) {
    const i = info(t);
    if (!i) return '';
    const f = safe(() => AX().freshLabel(i.pos), null);
    return (f && f.text) || '';
  }
  function onwaySub(t) { return [plateOf(t), freshText(t)].filter(Boolean).join(' · '); }
  function liveParts(t, sig) {
    const lle = t.type === 'lle';
    if (t.status === 'onboard') {
      const late = !lle ? safe(() => AX().lateness(t), null) : null;
      const sub = !lle ? ((late && late.text) || '') : [firstOf(t), plateOf(t)].filter(Boolean).join(' · ');
      return { kind: 'onboard', title: 'A bordo · rumbo a ' + (lle ? 'casa' : 'MDE'), sub: esc(sub) };
    }
    if (arrived(t)) {
      const code = codeOf(t);
      const until = waitUntil(t);
      return {
        kind: 'arrived', title: 'Llegó por ti',
        sub: code ? 'Código de encuentro <b class="rx-code-inline">' + esc(code) + '</b>' : esc(plateOf(t)),
        sub2: until ? 'Te espera hasta las ' + esc(until) : '',
      };
    }
    const first = firstOf(t);
    // La frescura del GPS cambia en cada consulta: la pone al día liveTick en
    // su lugar; la firma (sig) la deja fuera para no rehacer el mapa por ella.
    return { kind: 'onway', title: (first ? first : 'Tu conductor') + ' va por ti', sub: '<span class="rx-live-fresh">' + (sig ? '' : esc(onwaySub(t))) + '</span>' };
  }
  function liveHTML(t, o) {
    if (!t) return '';
    const p = liveParts(t, !!(o && o.sig));
    return '<button type="button" class="rx-live" data-ax="trip" data-id="' + esc(t.id) + '">'
      + '<div class="rx-live-map"><div class="rx-live-lf" data-id="' + esc(t.id) + '"><span class="rx-live-ph">' + ic('MapPin', 22) + '</span></div></div>'
      + '<div class="rx-live-b">'
      + '<span class="rx-live-tag"><i></i>En vivo</span>'
      + '<div class="rx-live-t">' + esc(p.title) + '</div>'
      + (p.sub ? '<div class="rx-live-s">' + p.sub + '</div>' : '')
      + (p.sub2 ? '<div class="rx-live-s rx-live-wait">' + p.sub2 + '</div>' : '')
      + '</div></button>';
  }

  // ── Mapa real del RxLive ─────────────────────────────────────────────────
  // Sin Leaflet queda el fondo de mapa con un pin (sin carro inventado). Con
  // Leaflet: la casa (pin), el aeropuerto (apt) y el carro SOLO con I.pos.
  // Consulta el rastreo solo mientras Inicio está arriba y la app visible.
  let live = null;
  function lfMarker(kind, ll) {
    const u = UI();
    const opt = u && u.lfIcon ? u.lfIcon(kind) : null;
    return L.marker(ll, opt ? { icon: L.divIcon(opt), interactive: false, keyboard: false } : { interactive: false });
  }
  function fitLive(lv) {
    if (!lv.map) return;
    const pts = lv.pts.slice();
    if (lv.car) { try { pts.push(lv.car.getLatLng()); } catch (_) { /* */ } }
    try {
      if (pts.length > 1) lv.map.fitBounds(L.latLngBounds(pts), { padding: [26, 26], maxZoom: 16 });
      else lv.map.setView(pts[0] || [MDE.lat, MDE.lng], 13);
    } catch (_) { /* */ }
  }
  function placeCar(lv, t) {
    if (!lv.map) return;
    const i = info(t);
    const pos = i && i.pos && i.pos.lat != null && i.pos.lng != null ? [+i.pos.lat, +i.pos.lng] : null;
    if (pos) {
      if (lv.car) { try { lv.car.setLatLng(pos); } catch (_) { /* */ } }
      else { lv.car = lfMarker('car', pos).addTo(lv.map); fitLive(lv); }
    } else if (lv.car) {
      try { lv.car.remove(); } catch (_) { /* */ }
      lv.car = null;
    }
  }
  function mountLive(root) {
    unmountLive();
    const box = root && root.querySelector('.rx-live-lf[data-id]');
    if (!box) return;
    const id = box.getAttribute('data-id');
    const t = findTrip(id); if (!t) return;
    const lv = live = { id, box, map: null, car: null, pts: [], timer: null, busy: false };
    if (typeof window.L !== 'undefined' && window.L && typeof L.map === 'function') {
      try {
        const map = L.map(box, {
          zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
          doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, tap: false,
        });
        L.tileLayer(OSM, { maxZoom: 19 }).addTo(map);
        lv.map = map;
        if (t.lat != null && t.lng != null && !isNaN(+t.lat) && !isNaN(+t.lng)) {
          const pt = [+t.lat, +t.lng]; lfMarker('pin', pt).addTo(map); lv.pts.push(pt);
        }
        const apt = [MDE.lat, MDE.lng]; lfMarker('apt', apt).addTo(map); lv.pts.push(apt);
        placeCar(lv, t);
        fitLive(lv);
        box.classList.add('on');
        const ph = box.querySelector('.rx-live-ph'); if (ph) ph.remove();
        // Leaflet midió antes de que la pestaña terminara de entrar: se vuelve a
        // medir (y a encuadrar) al rato y al terminar la entrada.
        [60, 400].forEach(ms => setTimeout(() => {
          if (live === lv && lv.map) { try { lv.map.invalidateSize(); fitLive(lv); } catch (_) { /* */ } }
        }, ms));
      } catch (e) { lv.map = null; }
    }
    lv.timer = setInterval(() => liveTick(lv), LIVE_POLL_MS);
    liveTick(lv);
  }
  function unmountLive() {
    const lv = live; live = null;
    if (!lv) return;
    if (lv.timer) clearInterval(lv.timer);
    if (lv.map) { try { lv.map.remove(); } catch (_) { /* */ } }
  }
  const RAW_UI = {
    en_route: 'onway', at_pickup: 'onway', on_board: 'onboard', picked_up: 'onboard', en_route_home: 'onboard',
    delivered: 'done', cancelled: 'cancelled', no_show: 'noshow',
  };
  async function liveTick(lv) {
    if (live !== lv || lv.busy) return;
    const sh = SH();
    const cur = sh && typeof sh.current === 'function' ? sh.current() : null;
    if (!cur || cur.id !== 'home') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!window.Api || typeof Api.trackReservation !== 'function') return;
    lv.busy = true;
    let i = null;
    try { i = await Api.trackReservation(lv.id); } catch (_) { i = null; }
    lv.busy = false;
    if (live !== lv || !i) return;
    const t = findTrip(lv.id); if (!t) return;
    const wasArrived = arrived(t);
    t._info = i;
    placeCar(lv, t);
    // Texto en su lugar (sin repintar): placa + frescura del GPS.
    const fr = lv.box && lv.box.closest('.rx-live') && lv.box.closest('.rx-live').querySelector('.rx-live-fresh');
    if (fr && t.status === 'onway' && !arrived(t)) fr.textContent = onwaySub(t);
    // Cambio de fase: el estado de la reserva lo trae el refresco del shell;
    // «llegó» (parada) se repinta aquí.
    const ui = i.cancelled ? 'cancelled' : RAW_UI[i.raw_status];
    if (ui && ui !== t.status && sh && typeof sh.refreshTrips === 'function') sh.refreshTrips();
    else if (arrived(t) !== wasArrived && sh && typeof sh.render === 'function') sh.render();
  }

  // ── Piezas de Inicio ─────────────────────────────────────────────────────
  function greet() {
    let h = NaN;
    try { h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10); } catch (_) { /* */ }
    if (isNaN(h)) h = new Date(Date.now() - 5 * 3600e3).getUTCHours();
    if (h >= 5 && h <= 11) return 'Buenos días';
    if (h >= 12 && h <= 18) return 'Buenas tardes';
    return 'Buenas noches';
  }
  function coordUnread() {
    const c = window.AuxRxCoord;
    if (!c || typeof c.unread !== 'function') return 0;
    const v = safe(() => c.unread(), 0);
    return typeof v === 'number' && v > 0 ? v : 0;
  }
  function bellCount() {
    const av = window.AuxRxAvisos;
    const n = av && typeof av.unseen === 'function' ? Number(safe(() => av.unseen(), 0)) || 0 : 0;
    return n + coordUnread();
  }
  const badge = (n) => (n > 99 ? '99+' : String(n));

  // Calificar (§3.2): el último entregado con conductor, sin calificar, sin
  // «Ahora no», entregado hace menos de 24 h.
  function rateTrip() {
    const a = AX(); if (!a) return null;
    const now = Date.now();
    let best = null, bestTs = -Infinity;
    trips().forEach(t => {
      if (!t || t.status !== 'done' || !t.driver || t.rated) return;
      if (typeof a.showRate === 'function' ? !safe(() => a.showRate(t), false) : safe(() => a.rateSkipped(t.id), false)) return;
      const d = t.droppedAt ? Date.parse(t.droppedAt) : whenTs(t);
      if (d == null || isNaN(d) || now - d > 24 * 3600e3 || now - d < -3600e3) return;
      if (d > bestTs) { best = t; bestTs = d; }
    });
    return best;
  }
  function rateHTML(t) {
    const first = firstOf(t) || 'tu conductor';
    const lle = t.type === 'lle';
    // «Llegaste a MDE a las 04:26 · 34 min de margen» (rx-home.jsx:91), solo
    // con la hora REAL de entrega; el margen contra la hora en MDE, si sobró.
    let sub;
    if (t.droppedAt && hm(t.droppedAt)) {
      sub = 'Llegaste ' + (lle ? 'a casa' : 'a MDE') + ' a las ' + hm(t.droppedAt);
      const req = whenTs(t), drop = Date.parse(t.droppedAt);
      // Al minuto que se muestra (HH:MM): con segundos, el mismo viaje daba 9 o 10 min.
      const m = !lle && req != null && !isNaN(drop) ? Math.round((req - Math.floor(drop / 60000) * 60000) / 60000) : 0;
      if (m > 0) sub += ' · ' + m + ' min de margen';
    } else {
      sub = dayLabel(t.date) + ' · ' + (lle ? 'Llegada' : 'Salida') + (t.flight ? ' · ' + t.flight : '');
    }
    return '<button type="button" class="rx-rate-card" data-rx="rate-trip" data-id="' + esc(t.id) + '">'
      + '<div><b>¿Cómo te fue con ' + esc(first) + '?</b><span>' + esc(sub) + '</span></div>'
      + '<div class="rx-stars sm">' + [1, 2, 3, 4, 5].map(() => ic('Star', 22)).join('') + '</div>'
      + '</button>';
  }
  function stripHTML(tone, icon, title, sub, attrs, tag) {
    const tg = tag || 'div';
    return '<' + tg + (tg === 'button' ? ' type="button"' : '') + ' class="rx-strip t-' + tone + '"' + (attrs || '') + '>'
      + ic(icon, 18) + '<span><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span>'
      + (tg === 'button' ? ic('ChevronRight', 16) : '')
      + '</' + tg + '>';
  }
  function hookOut(h, c) {
    try {
      const f = typeof h.render === 'function' ? h.render : (typeof h.html === 'function' ? h.html : null);
      const out = f ? f.call(h, c) : (typeof h.html === 'string' ? h.html : '');
      return out == null ? '' : String(out);
    } catch (e) { console.error('[AuxRxInicio] el enganche «' + ((h && h.id) || '?') + '» falló:', e); return ''; }
  }
  function hooksOf(name, c) {
    const sh = SH();
    if (!sh || typeof sh.hooks !== 'function') return [];
    return safe(() => sh.hooks(name, c), []) || [];
  }
  function qaHTML(up, live, suspended) {
    const a = AX();
    const items = [];
    const last = a && typeof a.lastTrip === 'function' ? safe(() => a.lastTrip(), null) : null;
    if (last && !suspended) {
      const lbl = (safe(() => a.typeMeta(last), null) || {}).label || (last.type === 'lle' ? 'Llegada' : 'Salida');
      items.push(['Refresh', 'Repetir último', lbl + ' · ' + conjunto(last), ' data-ax="repeat"']);
    }
    const ft = up.find(canChangeFlight);
    if (ft) {
      const t2 = (!isPublished(ft) && ft.level !== 'private') ? 'Actualizamos tu traslado' : 'Coordinación te confirma';
      items.push(['Plane', 'Cambió mi vuelo', t2, ' data-rx="open-flight" data-id="' + esc(ft.id) + '"']);
    }
    const cu = coordUnread();
    items.push(['Headset', 'Coordinación', cu > 0 ? (cu === 1 ? '1 sin leer' : cu + ' sin leer') : 'Escríbenos', ' data-rx="open-coord"']);
    if (live && (live.status === 'onway' || live.status === 'onboard') && a && typeof a.shareText === 'function' && safe(() => a.shareText(live), null)) {
      items.push(['Share', 'Compartir viaje', 'Con quien quieras', ' data-rx="inicio-share" data-id="' + esc(live.id) + '"']);
    }
    return '<div class="rx-qa rx-in" style="--d:1;--n:' + items.length + '">'
      + items.map(([i, t1, t2, at]) => '<button type="button" class="rx-qa-b"' + at + '><span>' + ic(i, 20) + '</span><b>' + esc(t1) + '</b><em>' + esc(t2) + '</em></button>').join('')
      + '</div>';
  }

  // Estado del permiso de notificaciones (lo decide after(), es asíncrono).
  let pushNeed = null;

  // homeHTML({sig}) — sig:true deja fuera lo que cambia solo (globo y
  // frescura del GPS) para decidir si hace falta repintar.
  function homeHTML(o) {
    o = o || {};
    const a = AX();
    const S = auxSt();
    const u = UI();
    const prof = S.profile || {};
    const full = String(prof.full_name || '').trim();
    const first = full.split(/\s+/)[0] || 'Auxiliar';
    const n = o.sig ? 0 : bellCount();
    const up = upcoming();
    const live = up.find(isLive) || null;
    const next = up.find(t => t !== live && (t.status === 'pending' || t.status === 'assigned')) || null;
    const err = S.source === 'error';
    const suspended = !!(a && typeof a.suspended === 'function' && safe(() => a.suspended(), false));
    const hctx = { state: S, shell: SH(), inCourse: !!live, live, upcoming: up, d: 2 };

    let h = '<div class="rx-scr">'
      + '<div class="rx-home-h">'
      + '<button type="button" class="rx-home-av" data-rx="rx-tab" data-tab="perfil" aria-label="Perfil">' + (u && u.av ? u.av(initials(full, 'A')) : '') + '</button>'
      + '<div class="rx-home-g"><span>' + esc(greet()) + '</span><b>' + esc(first) + '</b></div>'
      + '<button type="button" class="rx-bell" data-rx="open-notifs" aria-label="Notificaciones">' + ic('Bell', 21) + (n > 0 ? '<span>' + badge(n) + '</span>' : '') + '</button>'
      + '</div>'
      + '<div class="rx-body home">';

    // Franjas: cobro (enganche), configuración sin leer, suspensión.
    hooksOf('home.strip', hctx).forEach(k => { h += hookOut(k, hctx); });
    if (a && typeof a.settingsWarnHTML === 'function' && safe(() => a.settingsWarnHTML(), '')) {
      h += stripHTML('error', 'AlertTriangle', 'No pudimos leer la configuración', 'Pueden faltarte opciones. Suele ser la sesión: vuelve a entrar.');
    }
    if (suspended) {
      const why = prof.suspended_reason ? 'Motivo: ' + prof.suspended_reason + '. ' : '';
      h += stripHTML('block', 'Lock', 'Tu cuenta está suspendida', 'No puedes pedir traslados nuevos; los que ya pediste siguen en pie. ' + why + 'Habla con tu jefe para reactivarla.');
    }

    // Bloque principal (--d:0).
    let main = '';
    if (err) {
      main += '<div class="rx-empty-trip">'
        + '<div class="rx-empty-ic">' + ic('CloudOff', 26) + '</div>'
        + '<b>No pudimos cargar tus viajes</b>'
        + '<span>Lo que ya pediste está guardado en nuestros servidores, no en el teléfono. Revisa tu conexión y reintenta.</span>'
        + (u && u.btn ? u.btn('Reintentar', { icon: 'Refresh', attrs: { 'data-ax': 'reload' } }) : '<button type="button" class="rx-btn pri" data-ax="reload">Reintentar</button>')
        + '</div>';
    } else {
      const rate = rateTrip();
      if (live) main += liveHTML(live, { sig: o.sig });
      if (rate) main += rateHTML(rate);
      if (next) {
        main += '<div class="rx-home-next"><div class="rx-sec-h"><b>Tu próximo traslado</b><span>'
          + (next.status === 'assigned' ? 'Confirmado' : 'Pedido') + '</span></div>' + passHTML(next) + '</div>';
      }
      if (up.length > 1) {
        main += '<button type="button" class="rx-home-more" data-rx="rx-tab" data-tab="viajes"><span>Ver tus ' + up.length + ' traslados</span>' + ic('ChevronRight', 16) + '</button>';
      }
      if (!up.length) {
        main += '<div class="rx-empty-trip">'
          + '<div class="rx-empty-ic">' + ic('Plane', 26) + '</div>'
          + '<b>No tienes traslados programados</b>'
          + '<span>Pídelo y armamos tu ruta: la hora de recogida te la confirmamos cuando esté lista.</span>'
          + (u && u.btn ? u.btn('Pedir traslado', { icon: 'Plus', attrs: { 'data-ax': 'new' } }) : '<button type="button" class="rx-btn pri" data-ax="new">Pedir traslado</button>')
          + '</div>';
      }
    }
    h += '<div class="rx-in rx-home-main" style="--d:0">' + main + '</div>';

    // Accesos rápidos (--d:1).
    h += qaHTML(err ? [] : up, err ? null : live, suspended);

    // Anzuelo: uno solo y nunca con un viaje en curso (D15).
    if (!live && !err) {
      const hk = hooksOf('home.hook', hctx)[0];
      if (hk) h += hookOut(hk, hctx);
    }

    // Notificaciones del teléfono (sin el id reservado #ax-pwa-bar: la base no
    // puede traer ids de §2.4). La muestra after() cuando sabe que faltan.
    // Sin .rx-in: la franja entra con su propia rxRise (.rx-strip del diseño).
    h += '<button type="button" class="rx-strip t-info rx-home-push' + (pushNeed === true ? '' : ' is-off') + '" data-ax="enable-push">'
      + ic('Bell', 18) + '<span><b>Activa las notificaciones</b><span>Así te enteras al momento de los cambios de tu traslado.</span></span>' + ic('ChevronRight', 16) + '</button>';

    h += '</div></div>';
    return h;
  }

  // ── Globo de la campana ──────────────────────────────────────────────────
  let lastBell = null;
  function paintBell(root, animate) {
    const bell = root && root.querySelector('.rx-bell');
    if (!bell) return;
    const n = bellCount();
    const cur = bell.querySelector('span');
    const changed = lastBell !== null && n !== lastBell;
    if (n <= 0) { if (cur) cur.remove(); }
    else if (!cur) {
      const s = document.createElement('span');
      s.textContent = badge(n);
      if (changed || animate) s.classList.add('rx-anim');
      bell.appendChild(s);
    } else if (cur.textContent !== badge(n) || (changed && animate)) {
      // key={unread}: se RECREA para que rxPop corra otra vez.
      const s = document.createElement('span');
      s.textContent = badge(n);
      s.classList.add('rx-anim');
      cur.replaceWith(s);
    }
    lastBell = n;
  }
  function homeRoot() {
    const ui = document.getElementById('auxiliar-ui');
    return ui ? ui.querySelector('.rx-tabview[data-scr="home"]') : null;
  }
  // Para los módulos que cambian el conteo (Avisos al marcar vistos, Coordinación).
  function refreshBell() { const r = homeRoot(); if (r) paintBell(r, true); }

  // ── Permiso de notificaciones ────────────────────────────────────────────
  async function pushCheck() {
    let need = false;
    try {
      // eslint-disable-next-line no-undef
      const sup = typeof pushSupported === 'function' ? pushSupported() : false;
      if (sup && typeof Notification !== 'undefined' && Notification.permission !== 'denied' && navigator.serviceWorker) {
        const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
        if (reg && reg.pushManager) need = !(await reg.pushManager.getSubscription());
      }
    } catch (_) { need = false; }
    pushNeed = need;
    const r = homeRoot();
    const el = r && r.querySelector('.rx-home-push');
    if (el) el.classList.toggle('is-off', !need);
    return need;
  }
  function watchPushClick(root) {
    const el = root && root.querySelector('.rx-home-push');
    if (!el || el._rxWatch) return;
    el._rxWatch = true;
    // auxiliar.js atiende data-ax="enable-push"; aquí solo se vuelve a mirar
    // (el permiso lo contesta la persona, sin plazo fijo).
    el.addEventListener('click', () => { [1500, 4000, 9000, 20000].forEach(ms => setTimeout(pushCheck, ms)); });
  }

  // ── Pantalla «home» ──────────────────────────────────────────────────────
  let lastSig = null;
  const screen = {
    render() {
      lastSig = homeHTML({ sig: true });
      return homeHTML();
    },
    after(ctx) {
      const root = (ctx && (ctx.host || ctx.el)) || homeRoot();
      if (!root) return;
      paintBell(root, ctx && ctx.reason !== 'enter');
      watchPushClick(root);
      pushCheck();
      mountLive(root);
      const av = window.AuxRxAvisos;
      if (av && typeof av.refresh === 'function') {
        Promise.resolve(safe(() => av.refresh(), null)).then(() => refreshBell()).catch(() => {});
      }
    },
    // Mismo Inicio arriba: si no cambió nada que se vea, no se toca el DOM
    // (el mapa en vivo sigue montado); solo se pone al día el globo.
    patch(ctx) {
      if (homeHTML({ sig: true }) !== lastSig) return false;
      const root = (ctx && (ctx.host || ctx.el)) || homeRoot();
      if (root) paintBell(root, true);
      return true;
    },
    destroy() { unmountLive(); },
  };

  // ── Acciones ─────────────────────────────────────────────────────────────
  function rateTripAct(el) {
    const id = el && el.getAttribute('data-id');
    const a = AX();
    if (id && a && typeof a.openTrip === 'function') a.openTrip(id, { rate: true });
  }
  function shareAct(el) {
    const t = findTrip(el && el.getAttribute('data-id'));
    const a = AX();
    if (t && a && typeof a.share === 'function') a.share(t);
  }

  // ── Anzuelo de Select (D15) ─────────────────────────────────────────────
  // Se ve si existe el traslado privado (encendido o en primicia) y no hay un
  // viaje en curso. Sin cifras, sin «kit» (D1, D3).
  const selectHook = {
    id: 'select', priority: 10,
    when(c) { return !!window.AuxPrivado && !(c && c.inCourse) && !inCourse(); },
    // --d:4 como en rx-home.jsx:108 (en el diseño van antes la billetera --d:2
    // y el bono --d:3; con Puntos apagado el retraso se conserva igual).
    render() {
      return '<button type="button" class="rx-select-teaser rx-in" style="--d:4" data-rx="open-select" data-from="home">'
        + '<span class="rx-st-e">Rendio</span><span class="rx-st-t">Select</span>'
        + '<span class="rx-st-s">El carro solo para ti, derecho a tu destino.</span>'
        + '<span class="rx-st-c">Conocer ' + ic('ArrowRight', 15) + '</span>'
        + '</button>';
    },
  };

  window.AuxRxInicio = {
    passHTML, liveHTML, homeHTML,
    isLive, isPublished, conjunto, levelOf, arrived, whenTs, refreshBell,
    // Pedido del 29-sep: el orden en el carro y la regla de «Cambió mi vuelo»
    // (la hoja del viaje las reutiliza para no inventar otra).
    pickupOrder, canChangeFlight,
    // Para pruebas: el estado del mapa en vivo.
    _live: () => live,
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('home', screen);
    sh.hook('home.hook', selectHook);
    sh.action('rate-trip', rateTripAct);
    sh.action('inicio-share', shareAct);
  }
})();
