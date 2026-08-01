// driver-rutas.js — Conductor: Ruta del día + ejecución paso a paso.
// Diseño UX portado FIEL de /Visual/route-screens.jsx (tokens --r-*, bottom-sheet,
// lista de paradas con conector, pills flotantes, colores salida/llegada). Ver
// [feedback-seguir-diseno-ux]. Cableado técnico intacto: ruta REAL asignada
// (listMyVueltasForDriver), estados que persisten (Pieza 1: driverSetStopStatus),
// mapa Leaflet real, navegar→Waze, llamar→tel:, GPS en vivo.

  // 2026-07-25: se eliminó DR_DEMO_VUELTAS (2 vueltas con "Laura Gómez",
  // "Andrés Peña" y "Patricia Díaz", con teléfono y todo). Un conductor SIN ruta
  // asignada veía esas paradas como si fueran suyas y podía arrancar a
  // recogerlas. Ver [feedback-no-inventar-datos]. Ahora, sin ruta real, la
  // pantalla lo dice y no hay nada que ejecutar.

  const drState = {
    profile: null, source: 'empty', driverProfileId: null,
    vueltas: [], view: 'overview', activeId: null, legIdx: 0, legState: 'en_camino',
    map: null, watchId: null, sharing: false, bound: false, _lastDone: null,
    lastPingAt: 0,
    // Nivel 1 (nav in-app): mi posición en vivo + seguir. Popup mapa grande. Reanudar.
    meMarker: null, lastPos: null, follow: true, bigMap: null,
    // Mapa grande: marcador "estás aquí" + tramo destacado hasta la próxima parada.
    bigMeMk: null, bigLegLine: null,
    // Chat con el auxiliar de una parada (0052) + sin leer por reserva.
    chat: null, chatMsgs: [], chatPoll: null, chatSending: false, unread: {}, unreadPoll: null,
    // Espera en el punto: desde que marca "Llegué" corre el reloj y solo al
    // vencerse se habilita "No se presentó" (antes se podía marcar al segundo 1).
    waitTick: null,
  };
  // Minutos de espera configurados en Ajustes (0050). Default 5.
  // `state` es un const de script (no vive en window): se lee directo.
  const drWaitMin = () => (typeof state !== 'undefined' && state.settings?.aux_wait_minutes != null)
    ? state.settings.aux_wait_minutes : 5;
  // Cada cuánto se escribe la posición. Cada carro tiene su propio celular con
  // cargador (no hay que cuidar batería), así que se reporta seguido: a 6s y
  // 60 km/h son ~100 m entre puntos, y el admin los une con una animación que
  // se ve continua. La retención de 7 días (mig 0046) le pone techo a la tabla.
  const DR_PING_MS = 6000;

  window.DriverRutas = { open: drOpen, close: drClose };
  const drHost = () => document.getElementById('driver-ruta-root');

  // Abre la ruta del día (pantalla completa). Solo ruta REAL asignada; si no hay,
  // la pantalla lo dice (ya no existe fallback a datos de ejemplo).
  async function drOpen(profile) {
    drState.profile = profile;
    drState.view = 'overview'; drState.activeId = null;
    const root = drHost(); if (!root) return;
    root.classList.remove('hidden');
    root.innerHTML = '<div id="driver-ruta-ui"><div class="dr-loading">Cargando tu ruta…</div></div>';
    let vueltas = null;
    try { if (window.Api && Api.listMyVueltasForDriver && profile && profile.id) vueltas = await Api.listMyVueltasForDriver(profile.id); } catch (e) {}
    drState.source = (vueltas && vueltas.length) ? 'live' : 'empty';
    drState.vueltas = (vueltas && vueltas.length) ? vueltas : [];
    // driver_locations referencia driver_profiles(id), no profiles(id).
    drState.driverProfileId = null;
    if (drState.source === 'live' && window.Api && Api.getMyDriverProfileId) {
      try { drState.driverProfileId = await Api.getMyDriverProfileId(profile.id); } catch (e) {}
    }
    drBindOnce();
    // Reanuda la ruta en curso sin re-tocar "Iniciar ruta" (tras salir/volver a la app).
    if (drRestoreProgress()) drStartGps();
    drRender();
    // Mensajes sin leer de sus paradas: cada 15 s basta (el push es el que
    // avisa de verdad; esto solo mantiene el contador al día con la app abierta).
    drSyncUnread();
    if (drState.unreadPoll) clearInterval(drState.unreadPoll);
    drState.unreadPoll = setInterval(drSyncUnread, 15000);
  }
  function drClose() {
    drTeardown();
    drHost() && drHost().classList.add('hidden');
    if (window.setDriverTab) try { setDriverTab('home'); } catch (e) {}
  }
  function drRender() {
    const host = drHost(); if (!host) return;
    host.innerHTML = drState.view === 'exec' ? drExecHTML()
      : drState.view === 'route' ? drRouteHTML()
      : drState.view === 'done' ? drDoneHTML()
      : drOverviewHTML();
    if (drState.view === 'route') drRouteMap();
    else if (drState.view === 'exec') drExecMap();
    drSyncWait();       // reloj de espera en el punto (solo tras marcar "Llegué")
    drSaveProgress();   // persiste el avance de la ruta (o lo limpia si ya no estamos en ella)
    // El chat vive dentro del HTML que se acaba de rehacer: si estaba abierto,
    // se vuelve a montar en vez de desaparecer.
    if (drState.chat) {
      const host = document.getElementById('driver-ruta-ui');
      if (host) { host.insertAdjacentHTML('beforeend', drChatHTML()); drChatBubbles(); }
    }
  }
  function drTeardown() {
    if (drState.unreadPoll) { clearInterval(drState.unreadPoll); drState.unreadPoll = null; }
    if (drState.chatPoll) { clearInterval(drState.chatPoll); drState.chatPoll = null; }
    drState.chat = null;
    if (drState.map) { try { drState.map.remove(); } catch (e) {} drState.map = null; }
    drStopWait();
    drStopGps();
  }

  // ---------- espera en el punto de recogida ----------
  // Regla: al marcar "Llegué" arranca un reloj de `aux_wait_minutes` (Ajustes).
  // Mientras corre, "No se presentó" está bloqueado; al vencerse se habilita.
  // El auxiliar ve el MISMO reloj en su app (arranca en actual_arrival_at).
  function drSyncWait() {
    const v = drVuelta();
    const leg = v && v.legs[drState.legIdx];
    const active = drState.view === 'exec' && drState.legState === 'llegue'
      && leg && leg.kind === 'pickup' && leg._arrivedAt;
    if (!active) { drStopWait(); return; }
    if (!drState.waitTick) drState.waitTick = setInterval(drPaintWait, 1000);
    drPaintWait();
  }
  function drPaintWait() {
    const box = document.getElementById('dr-wait');
    const btn = document.getElementById('dr-noshow');
    const v = drVuelta();
    const leg = v && v.legs[drState.legIdx];
    if (!box || !leg || !leg._arrivedAt) { drStopWait(); return; }
    const left = Math.round((leg._arrivedAt + drWaitMin() * 60000 - Date.now()) / 1000);
    if (left > 0) {
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
      box.className = 'dr-wait';
      box.innerHTML = `<span>Espera acordada</span><b>${mm}:${ss}</b>`;
      if (btn) { btn.disabled = true; btn.textContent = `No se presentó (${mm}:${ss})`; }
    } else {
      box.className = 'dr-wait over';
      box.innerHTML = `<span>Espera cumplida</span><b>Puedes seguir</b>`;
      if (btn) { btn.disabled = false; btn.textContent = 'No se presentó'; }
      if (drState.waitTick) { clearInterval(drState.waitTick); drState.waitTick = null; }
    }
  }
  function drStopWait() {
    if (drState.waitTick) { clearInterval(drState.waitTick); drState.waitTick = null; }
  }

  const drTypeMeta = (t) => t === 'lle' ? { cls: 'lle', label: 'Llegada' } : t === 'hotel' ? { cls: 'hotel', label: 'Hotel' } : { cls: 'sal', label: 'Salida' };
  const drVuelta = () => drState.vueltas.find(v => v.id === drState.activeId);
  const drStopsOf = (v) => v.legs.filter(l => l.kind !== 'airport');
  const drShort = (a) => (a || '').split(',')[0];
  const drIni = (n) => ((n || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '·').toUpperCase();
  // Fecha "MAR 13 JUL" desde YYYY-MM-DD.
  function drFmtDate(day) {
    if (!day) return 'HOY';
    try { return new Date(day + 'T12:00:00-05:00').toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'America/Bogota' }).replace(/\./g, '').toUpperCase(); } catch (e) { return 'HOY'; }
  }
  function drHav(a, b) {
    const R = 6371, toR = x => x * Math.PI / 180;
    const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Duración aprox de una vuelta (min): distancia por carretera estimada + servicio.
  function drKmMin(v) {
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    let km = 0; for (let i = 1; i < pts.length; i++) km += drHav(pts[i - 1], pts[i]) * 1.4;
    return Math.max(8, Math.round(km / 30 * 60 + drStopsOf(v).length * 3));
  }
  // Trayecto REAL por carretera (OSRM) para los puntos en orden → [[lat,lng],…] o null.
  async function drRoadPath(pts) {
    if (!pts || pts.length < 2) return null;
    try {
      const coords = pts.map(p => `${p[1]},${p[0]}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      const j = await (await fetch(url)).json();
      if (j.code === 'Ok' && j.routes && j.routes[0]) return j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    } catch (e) {}
    return null;
  }

  // ---------- OVERVIEW: "Mi día" (maqueta route-screens.jsx) ----------
  function drOverviewHTML() {
    const vs = drState.vueltas;
    // Sin ruta asignada no se inventa una: se dice y ya. Antes aquí aparecían
    // dos vueltas de mentira que el conductor podía arrancar a ejecutar.
    if (!vs.length) {
      return `<div id="driver-ruta-ui">
        <div class="dr-topbar">
          <button class="dr-icbtn" data-dr="close" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
          <b>Ruta del día</b>
        </div>
        <div class="dr-empty">
          <div class="dr-empty-ic"><svg class="icon"><use href="#i-route"/></svg></div>
          <h1>No tienes ruta asignada</h1>
          <p>Cuando coordinación publique el plan del día con tu nombre, tus vueltas aparecen aquí y te llega una notificación.</p>
          <button class="close" data-dr="close"><svg class="icon" style="width:18px;height:18px"><use href="#i-back"/></svg>Volver</button>
        </div>
      </div>`;
    }
    const done = vs.filter(v => v.done).length;
    const pax = vs.reduce((n, v) => n + drStopsOf(v).length, 0);
    const pct = vs.length ? Math.round(done / vs.length * 100) : 0;
    const dateStr = drFmtDate(vs[0] && vs[0].day);
    return `<div id="driver-ruta-ui">
      <div class="dr-topbar">
        <button class="dr-icbtn" data-dr="close" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>Ruta del día</b>
      </div>
      <div class="dr-hd">
        <div class="dr-eyebrow">Rutas · ${dateStr}</div>
        <div class="dr-title">Mi día</div>
        <div class="dr-sub">${vs.length} vuelta${vs.length === 1 ? '' : 's'} · ${pax} auxiliares · MDE</div>
        <div class="dr-progress">
          <div class="dr-pbar"><i style="width:${pct}%"></i></div>
          <span class="dr-pnum">${done}/${vs.length}</span>
          <span class="dr-share ${drState.sharing ? 'on' : ''}" id="dr-live-badge"><span class="dot"></span>${drState.sharing ? 'Compartiendo ubicación' : 'Ubicación off'}</span>
        </div>
      </div>
      <div class="dr-body">
        ${vs.map((v, i) => drVueltaCard(v, i, vs)).join('')}
      </div>
    </div>`;
  }
  function drVueltaCard(v, i, vs) {
    const m = drTypeMeta(v.type);
    const stops = drStopsOf(v);
    const last = v.legs[v.legs.length - 1];
    const first = v.legs[0];
    const from = v.type === 'lle' ? 'Aeropuerto MDE' : drShort(first && first.addr);
    const to = v.type === 'lle' ? drShort(last.addr) : 'Aeropuerto MDE';
    const firstPend = vs.findIndex(x => !x.done);
    const badge = v.done ? '<span class="dr-vc-badge">✓ Completada</span>'
      : (i === firstPend ? '<span class="dr-vc-badge curso">En curso</span>' : '<span class="dr-vc-badge">Próxima</span>');
    const when = v.type === 'lle' ? `recoge ${v.start} en MDE` : `salida · llega ${(stops[0] && stops[0].dl) || '—'}`;
    return `<button class="dr-vcard ${m.cls} ${v.done ? 'done' : ''}" data-dr="openroute" data-id="${v.id}">
      <div class="dr-vc-h">
        <span class="dr-vc-type">${m.label} · ${v.id}</span>
        ${badge}
      </div>
      <div class="dr-vc-time2">${v.start}</div>
      <div class="dr-vc-when">${when}</div>
      <div class="dr-vc-route2">${from} → ${to}</div>
      <div class="dr-vc-meta">
        <span><svg class="icon"><use href="#i-users"/></svg>${stops.length} aux.</span>
        <span><svg class="icon"><use href="#i-pin"/></svg>${v.legs.length} paradas</span>
        <span><svg class="icon"><use href="#i-clock"/></svg>${drKmMin(v)} min</span>
        <svg class="icon chev"><use href="#i-arrow"/></svg>
      </div>
    </button>`;
  }

  // ---------- ROUTE: preview de una vuelta (mapa + paradas con conector) ----------
  function drRouteHTML() {
    const v = drVuelta(); if (!v) { drState.view = 'overview'; return drOverviewHTML(); }
    const m = drTypeMeta(v.type);
    const stops = drStopsOf(v);
    let n = 0;
    const rows = v.legs.map((l, i) => {
      const isApt = l.kind === 'airport';
      const cls = isApt ? 'apt' : (i === 0 ? 'first' : '');
      const badge = isApt ? '<svg class="icon" style="width:18px;height:18px"><use href="#i-pin"/></svg>' : (++n);
      // Hora por parada, según el tipo de vuelta:
      //  - llegada: el aeropuerto es la RECOGIDA (v.start); las casas, su entrega (l.dl)
      //  - salida:  la 1ª casa es la RECOGIDA (v.start); el aeropuerto, la PRESENTACIÓN
      //    (l.dl de las paradas, que comparten hora); las paradas intermedias no
      //    tienen ETA propia calculada, así que van sin hora.
      const time = v.type === 'lle'
        ? (isApt ? v.start : (l.dl || ''))
        : (isApt ? ((stops[0] && stops[0].dl) || '') : (i === 0 ? v.start : ''));
      return `<div class="dr-stop">
        <div class="dr-stop-n ${cls}">${badge}</div>
        <div class="dr-stop-b">
          <div class="r1"><span class="nm">${isApt ? 'Aeropuerto MDE' : l.name}</span>${time ? `<span class="eta">${time}</span>` : ''}</div>
          <div class="ad">${l.addr || ''}</div>
        </div>
      </div>`;
    }).join('');
    return `<div id="driver-ruta-ui">
      <div class="dr-topbar">
        <button class="dr-icbtn" data-dr="back" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>${m.label} · ${v.id}</b>
        <span class="dr-live ${drState.sharing ? 'on' : ''}"><span class="dot"></span></span>
      </div>
      <div class="dr-hd">
        <div class="dr-eyebrow">${v.type === 'lle' ? 'Recoges en el aeropuerto' : 'Recoges en casa · destino MDE'}</div>
        <div class="dr-title">${stops.length} ${v.type === 'lle' ? 'entregas' : 'auxiliares'}</div>
        <div class="dr-sub">${v.type === 'lle' ? 'Del aeropuerto a los domicilios' : 'Salida ' + v.start + ' · presentación en MDE'}</div>
      </div>
      <div class="dr-map" id="dr-route-map"><div class="dr-map-chip">${stops.length} paradas · ${v.type === 'lle' ? 'llegada' : 'salida'}</div><button class="dr-map-expand" data-dr="mapbig" aria-label="Ampliar mapa">⤢</button></div>
      <div class="dr-seclabel" style="margin-left:24px">Paradas en orden</div>
      <div class="dr-stops">${rows}</div>
      <div class="dr-bottom">
        <button class="dr-btn-primary" data-dr="start"><svg class="icon"><use href="#i-bolt"/></svg>Iniciar ruta</button>
      </div>
      ${drMapModalHTML()}
    </div>`;
  }
  // Popup: mapa a (casi) pantalla completa con la ruta.
  function drMapModalHTML() {
    return `<div class="dr-modal hidden" id="dr-map-modal">
      <div class="dr-modal-head"><b id="dr-map-title">Ruta completa</b><button class="dr-icbtn" data-dr="mapbigclose" aria-label="Cerrar"><svg class="icon"><use href="#i-back"/></svg></button></div>
      <div class="dr-modal-map" id="dr-map-big"></div>
    </div>`;
  }
  // ---------- CHAT con el auxiliar de una parada (0052) ----------
  // Mismo hilo que ve el auxiliar. Va como panel encima para no desmontar el
  // mapa de ejecución que está corriendo debajo con el GPS.
  const drEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function drChatHTML() {
    const c = drState.chat; if (!c) return '';
    return `<div class="dr-chat" id="dr-chat">
      <div class="dr-chat-head">
        <button class="dr-icbtn" data-dr="chat-close" aria-label="Cerrar"><svg class="icon"><use href="#i-back"/></svg></button>
        <div class="dr-chat-who"><b>${drEsc(c.name || 'Auxiliar')}</b><span>Mensajes de este traslado</span></div>
        ${c.phone ? `<a class="dr-icbtn" href="tel:${c.phone.replace(/\s/g, '')}" aria-label="Llamar"><svg class="icon"><use href="#i-phone"/></svg></a>` : ''}
      </div>
      <div class="dr-chat-body" id="dr-chat-body"></div>
      <div class="dr-chat-foot">
        <input id="dr-chat-input" type="text" maxlength="500" placeholder="Escribe un mensaje…" autocomplete="off">
        <button class="dr-chat-send" data-dr="chat-send" aria-label="Enviar"><svg class="icon"><use href="#i-send"/></svg></button>
      </div>
    </div>`;
  }
  function drChatBubbles() {
    const el = document.getElementById('dr-chat-body'); if (!el) return;
    const msgs = drState.chatMsgs || [];
    if (!msgs.length) {
      el.innerHTML = `<div class="dr-chat-empty"><svg class="icon"><use href="#i-chat"/></svg>
        <b>Sin mensajes</b><span>Escríbele si no lo encuentras o si vas retrasado. Queda registro del traslado.</span></div>`;
      return;
    }
    const hora = (iso) => {
      try { return new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }
      catch (_) { return ''; }
    };
    el.innerHTML = msgs.map(m => `<div class="dr-msg ${m.sender_role === 'driver' ? 'mine' : 'their'}">
      <p>${drEsc(m.body)}</p><span>${hora(m.created_at)}</span></div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  async function drChatSync() {
    const c = drState.chat; if (!c || !window.Api?.listReservationMessages) return;
    const msgs = await Api.listReservationMessages(c.rid);
    if (!drState.chat || drState.chat.rid !== c.rid) return;   // cerró o cambió de parada
    drState.chatMsgs = msgs;
    drChatBubbles();
    if (Api.markReservationMessagesRead) { try { await Api.markReservationMessagesRead(c.rid); } catch (_) {} }
    drState.unread[c.rid] = 0;
  }
  function drChatOpen(rid, name, phone) {
    if (!rid) return;
    drState.chat = { rid, name, phone };
    drState.chatMsgs = [];
    const host = document.getElementById('driver-ruta-ui') || document.body;
    const old = document.getElementById('dr-chat'); if (old) old.remove();
    host.insertAdjacentHTML('beforeend', drChatHTML());
    drChatBubbles();
    drChatSync();
    if (drState.chatPoll) clearInterval(drState.chatPoll);
    drState.chatPoll = setInterval(drChatSync, 5000);
    const i = document.getElementById('dr-chat-input'); if (i) i.focus();
  }
  function drChatClose() {
    drState.chat = null; drState.chatMsgs = [];
    if (drState.chatPoll) { clearInterval(drState.chatPoll); drState.chatPoll = null; }
    const el = document.getElementById('dr-chat'); if (el) el.remove();
    drRender();                       // repinta el badge de la parada
  }
  async function drChatSend() {
    const i = document.getElementById('dr-chat-input'); if (!i) return;
    const body = i.value.trim();
    const c = drState.chat;
    if (!body || !c || drState.chatSending) return;
    drState.chatSending = true;
    i.value = '';
    const temp = { id: 'tmp' + Date.now(), sender_role: 'driver', body, created_at: new Date().toISOString() };
    drState.chatMsgs = (drState.chatMsgs || []).concat([temp]);
    drChatBubbles();
    try {
      await Api.sendReservationMessage(c.rid, body, { title: 'Mensaje de tu conductor' });
      await drChatSync();
    } catch (e) {
      drState.chatMsgs = drState.chatMsgs.filter(m => m.id !== temp.id);
      drChatBubbles();
      i.value = body;
      if (typeof toast === 'function') toast((e && e.message) ? e.message : 'No se pudo enviar el mensaje.');
    } finally { drState.chatSending = false; }
  }
  // Sin leer de TODAS las paradas de la vuelta, para los badges.
  async function drSyncUnread() {
    const v = drVuelta(); if (!v || !window.Api?.countUnreadMessages) return;
    const ids = v.legs.map(l => l.reservationId).filter(Boolean);
    if (!ids.length) return;
    const counts = await Api.countUnreadMessages(ids, 'auxiliar');
    const cambio = ids.some(id => (drState.unread[id] || 0) !== (counts[id] || 0));
    drState.unread = counts;
    if (cambio && !drState.chat) drRender();
  }

  // Marcador redondo con el MISMO número que la lista "Paradas en orden": el
  // conductor lee "3" en la lista y busca el "3" en el mapa.
  function drStopIcon(html, cls) {
    // El icono se ancla en su centro: si el div encoge (.sm) el marco tiene que
    // encoger igual, o el número queda corrido del punto que señala.
    const s = /\bsm\b/.test(cls || '') ? 22 : 30;
    return L.divIcon({ className: '', html: `<div class="dr-mk ${cls}">${html}</div>`, iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  }
  // El mapa grande mostraba la vuelta entera encuadrada de lejos y con puntos
  // iguales sin número: no servía para lo único que se pregunta al abrirlo, que
  // es "¿por dónde arranco y a quién recojo primero?". Ahora encuadra el tramo
  // que viene (dónde estoy → siguiente parada) y numera a cada auxiliar.
  async function drOpenBigMap() {
    const v = drVuelta(); if (!v) return;
    const modal = document.getElementById('dr-map-modal'), el = document.getElementById('dr-map-big');
    if (!modal || !el || typeof L === 'undefined') return;
    modal.classList.remove('hidden');
    if (drState.bigMap) { try { drState.bigMap.remove(); } catch (e) {} drState.bigMap = null; }
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    const map = drState.bigMap = L.map(el, { attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

    const idx = Math.min(drState.legIdx || 0, v.legs.length - 1);
    const next = v.legs[idx] && v.legs[idx].lat != null ? v.legs[idx] : null;
    let n = 0;
    v.legs.forEach((l, i) => {
      const isApt = l.kind === 'airport';
      const num = isApt ? null : ++n;                     // el aeropuerto no lleva número
      if (l.lat == null) return;
      const cls = isApt ? 'apt' : (i < idx ? 'done' : (i === idx ? 'next' : ''));
      const tip = isApt ? 'Aeropuerto MDE'
        : `${num}. ${l.name || 'Auxiliar'}${l.addr ? ' · ' + l.addr : ''}`;
      L.marker([l.lat, l.lng], { icon: drStopIcon(isApt ? '✈' : num, cls) })
        .addTo(map).bindTooltip(tip, { direction: 'top', offset: [0, -16] });
    });

    // Resto de la vuelta, tenue: contexto de a dónde se va después.
    if (pts.length > 1) L.polyline(pts, { color: '#A1A1AA', weight: 3, opacity: .45, dashArray: '6 8' }).addTo(map);

    const title = document.getElementById('dr-map-title');
    if (title) title.textContent = next ? (next.kind === 'airport' ? 'Hacia el aeropuerto' : `Hacia ${(next.name || '').split(' ')[0] || 'la parada'}`) : 'Ruta completa';

    drBigFocus(map, drState.lastPos, next, pts);
    setTimeout(() => map.invalidateSize(), 60);
    // Sin GPS todavía (pasa en el preview, antes de "Iniciar ruta"): se pide la
    // posición una vez para poder trazar el tramo desde donde está parado.
    if (!drState.lastPos && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (drState.bigMap !== map) return;
          drState.lastPos = [p.coords.latitude, p.coords.longitude];
          drBigFocus(map, drState.lastPos, next, pts);
          drBigLeg(map, drState.lastPos, next);
        },
        () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
    }
    await drBigLeg(map, drState.lastPos, next);
  }
  // Encuadre: el tramo que viene, no la vuelta entera (que deja todo diminuto).
  function drBigFocus(map, here, next, pts) {
    const focus = [];
    if (here) focus.push(here);
    if (next) focus.push([next.lat, next.lng]);
    if (focus.length >= 2) map.fitBounds(L.latLngBounds(focus).pad(0.35));
    else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2));
  }
  // Tramo actual destacado: vía real desde donde está hasta la siguiente parada.
  async function drBigLeg(map, here, next) {
    if (!here || !next) return;
    if (drState.bigMeMk) { try { map.removeLayer(drState.bigMeMk); } catch (e) {} }
    drState.bigMeMk = L.marker(here, { icon: drStopIcon('🚐', 'me') })
      .addTo(map).bindTooltip('Estás aquí', { direction: 'top', offset: [0, -16] });
    const to = [next.lat, next.lng];
    const road = await drRoadPath([here, to]);
    if (drState.bigMap !== map) return;
    if (drState.bigLegLine) { try { map.removeLayer(drState.bigLegLine); } catch (e) {} }
    drState.bigLegLine = L.polyline(road || [here, to], { color: '#F26522', weight: 5, opacity: .95 }).addTo(map);
  }
  function drCloseBigMap() {
    if (drState.bigMap) { try { drState.bigMap.remove(); } catch (e) {} drState.bigMap = null; }
    drState.bigMeMk = null; drState.bigLegLine = null;   // vivían en el mapa que se acaba de destruir
    const modal = document.getElementById('dr-map-modal'); if (modal) modal.classList.add('hidden');
  }
  async function drRouteMap() {
    const el = document.getElementById('dr-route-map');
    if (!el || typeof L === 'undefined') return;
    if (drState.map) { try { drState.map.remove(); } catch (e) {} drState.map = null; }
    const v = drVuelta(); if (!v) return;
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    if (!pts.length) return;
    const map = drState.map = L.map(el, { zoomControl: false, attributionControl: false, tap: false });
    map.on('click', () => drOpenBigMap());   // tap al mapa → previsualización grande
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    // Mismos números que la lista de abajo y que el mapa grande.
    let n = 0;
    v.legs.forEach(l => {
      const isApt = l.kind === 'airport';
      const num = isApt ? null : ++n;
      if (l.lat == null) return;
      L.marker([l.lat, l.lng], { icon: drStopIcon(isApt ? '✈' : num, `sm${isApt ? ' apt' : ''}`) }).addTo(map);
    });
    map.fitBounds(L.latLngBounds(pts).pad(0.25));
    setTimeout(() => map.invalidateSize(), 60);
    // Trayecto REAL por carretera (OSRM); si falla, línea directa.
    const road = await drRoadPath(pts);
    if (drState.map !== map) return; // cambió de pantalla mientras cargaba
    L.polyline(road || pts, { color: '#F26522', weight: 4, opacity: .9 }).addTo(map);
    map.fitBounds(L.latLngBounds(road || pts).pad(0.2));
  }

  // ---------- EXEC: mapa de fondo + bottom-sheet (maqueta route-screens.jsx) ----------
  function drExecHTML() {
    const v = drVuelta(); if (!v) { drState.view = 'overview'; return drOverviewHTML(); }
    const leg = v.legs[drState.legIdx];
    const total = drStopsOf(v).length;
    const onboard = v.legs.slice(0, drState.legIdx).filter(l => l.kind !== 'airport').length;
    const isApt = leg.kind === 'airport';
    const m = drTypeMeta(v.type);
    const tone = m.cls === 'lle' ? 'lle' : 'sal';
    const chipTxt = isApt ? '✈ Aeropuerto MDE' : `Parada ${onboard + 1} de ${total}`;
    const enCamino = drState.legState === 'en_camino';
    const first = (leg.name || '').split(' ')[0];
    const prev = drState.legIdx > 0 ? v.legs[drState.legIdx - 1] : null;
    const km = (prev && prev.lat != null && leg.lat != null) ? drHav([prev.lat, prev.lng], [leg.lat, leg.lng]) * 1.4 : null;
    const kmTxt = km != null ? `${km.toFixed(1)} km` : '';

    const primary = enCamino
      ? { cls: '', label: isApt ? 'Llegué al aeropuerto' : (leg.kind === 'dropoff' ? 'Llegué a la casa' : 'Llegué'), act: 'arrived', ic: 'i-pin' }
      : { cls: 'go', label: isApt ? (v.type === 'lle' ? 'Auxiliares a bordo' : 'Auxiliares entregados') : (leg.kind === 'dropoff' ? `${first} entregado · siguiente` : `${first} a bordo · siguiente`), act: 'next', ic: 'i-check' };

    let mid = '';
    if (!isApt) {
      if (enCamino) {
        mid = (leg.notes ? `<div class="dr-notes"><svg class="icon"><use href="#i-info"/></svg><span>${leg.notes}</span></div>` : '')
          + `<div class="dr-eta"><svg class="icon" style="width:16px;height:16px"><use href="#i-pin"/></svg><span>Llegada estimada · <b>${leg.dl || '—'}</b></span>${kmTxt ? `<span class="km">${kmTxt}</span>` : ''}</div>`;
      } else {
        mid = `<div class="dr-eta"><svg class="icon" style="width:16px;height:16px"><use href="#i-pin"/></svg><span>Llega <b>${leg.dl || '—'}</b>${leg.notes ? ' · ' + leg.notes : ''}</span></div>`;
      }
    }
    // Chat de la app en vez de SMS: gratis, le llega como notificación aunque
    // tenga la app cerrada, y queda registro si después hay un reclamo. El de
    // llamar se queda — es lo único que sirve cuando no hay datos.
    const unread = drState.unread[leg.reservationId] || 0;
    const contacts = !isApt ? `<div class="dr-aux-btns">
        ${leg.reservationId ? `<button class="dr-cbtn msg" data-dr="chat" data-rid="${leg.reservationId}" data-name="${(leg.name || '').replace(/"/g, '&quot;')}" data-phone="${leg.phone || ''}" aria-label="Escribir"><svg class="icon" style="width:19px;height:19px"><use href="#i-chat"/></svg>${unread ? `<span class="dr-badge">${unread > 9 ? '9+' : unread}</span>` : ''}</button>` : ''}
        ${leg.phone ? `<a class="dr-cbtn tel" href="tel:${leg.phone.replace(/\s/g, '')}" aria-label="Llamar"><svg class="icon" style="width:19px;height:19px"><use href="#i-phone"/></svg></a>` : ''}
      </div>` : '';
    // "No se presentó" solo después de cumplir la espera pactada. El botón
    // arranca deshabilitado y drPaintWait() lo suelta cuando el reloj llega a 0.
    const waiting = !enCamino && leg.kind === 'pickup';
    const footLinks = `<span class="links">${waiting ? '<button data-dr="noshow" id="dr-noshow" disabled>No se presentó</button>' : ''}<button data-dr="report">Reportar novedad</button></span>`;
    const waitBox = waiting ? `<div class="dr-wait" id="dr-wait"></div>` : '';

    return `<div id="driver-ruta-ui" class="exec">
      <div class="dr-ex-map" id="dr-ex-map"></div>
      <div class="dr-ex-topbar">
        <button class="dr-icbtn" data-dr="back" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
        <div class="dr-ex-pill">
          <svg class="icon" style="width:16px;height:16px;color:var(--r-text-2)"><use href="#i-users"/></svg>
          <span><b>${onboard}/${total}</b></span>
          <span style="color:var(--r-text-3)">·</span>
          <span style="color:var(--r-text-2)">${m.label} · sale ${v.start}</span>
        </div>
      </div>
      <div class="dr-ex-chips">
        <div class="dr-ex-chip ${tone}">${chipTxt}</div>
        <div class="dr-ex-share ${drState.sharing ? 'on' : ''}"><span class="dot"></span>${drState.sharing ? 'Compartiendo ubicación' : 'Ubicación off'}</div>
      </div>
      <button class="dr-recenter hidden" data-dr="recenter" aria-label="Centrarme"><svg class="icon" style="width:20px;height:20px"><use href="#i-pin"/></svg></button>
      <div class="dr-sheet">
        <div class="dr-sheet-h"><i></i></div>
        <div class="dr-sheet-b">
          <div class="dr-aux">
            <div class="dr-aux-av ${tone}">${isApt ? '✈' : drIni(leg.name)}</div>
            <div class="dr-aux-t"><div class="nm">${isApt ? 'Aeropuerto MDE' : leg.name}</div><div class="ad">${leg.addr || ''}</div></div>
            ${contacts}
          </div>
          ${mid}
          ${waitBox}
          <div class="dr-btnrow">
            ${!isApt ? `<button class="nav" data-dr="nav" data-lat="${leg.lat}" data-lng="${leg.lng}"><svg class="icon"><use href="#i-route"/></svg>Navegar</button>` : ''}
            <button class="dr-cta ${primary.cls}" data-dr="${primary.act}"><svg class="icon" style="width:18px;height:18px"><use href="#${primary.ic}"/></svg>${primary.label}</button>
          </div>
          ${!isApt ? `<div class="dr-foot"><span>${leg.flight ? '✈ ' + leg.flight : ''}</span>${footLinks}</div>` : ''}
        </div>
      </div>
    </div>`;
  }
  async function drExecMap() {
    const el = document.getElementById('dr-ex-map');
    if (!el || typeof L === 'undefined') return;
    if (drState.map) { try { drState.map.remove(); } catch (e) {} drState.map = null; }
    drState.meMarker = null;   // vivía en el mapa viejo; el próximo ping (o lastPos) lo re-crea
    drState.follow = true;     // cada parada re-centra en mí (el botón "centrarme" arranca oculto)
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx];
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    const map = drState.map = L.map(el, { zoomControl: false, attributionControl: false });
    // Si el conductor arrastra el mapa, deja de seguirlo y aparece el botón "centrarme".
    map.on('dragstart', () => { drState.follow = false; drToggleRecenter(true); });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    v.legs.forEach((l, i) => {
      if (l.lat == null) return;
      const active = i === drState.legIdx;
      const fill = active ? '#F26522' : (i < drState.legIdx ? (l.kind === 'airport' ? '#10B981' : '#F26522') : '#A1A1AA');
      L.circleMarker([l.lat, l.lng], { radius: active ? 10 : 6, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1 }).addTo(map);
    });
    setTimeout(() => {
      map.invalidateSize();
      if (leg && leg.lat != null) { map.setView([leg.lat, leg.lng], 14); map.panBy([0, -80], { animate: false }); }
      else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }, 80);
    const road = await drRoadPath(pts);
    if (drState.map !== map) return;
    L.polyline(road || pts, { color: '#F26522', weight: 4, opacity: .85 }).addTo(map);
    // Re-pinta mi posición (si ya la teníamos) tras re-crear el mapa.
    if (drState.lastPos) drUpdateMe({ latitude: drState.lastPos[0], longitude: drState.lastPos[1] });
  }

  // ---------- Nivel 1: navegación in-app (mi posición en vivo, seguir, distancia) ----------
  // Pinta/actualiza mi punto azul en el mapa de ejecución y, si "follow" está activo,
  // recentra el mapa dejándome arriba del bottom-sheet. Funciona en demo y en vivo.
  function drUpdateMe(c) {
    if (!c || c.latitude == null || !isFinite(c.latitude)) return;
    drState.lastPos = [c.latitude, c.longitude];
    if (drState.view !== 'exec' || !drState.map || typeof L === 'undefined') return;
    const here = drState.lastPos;
    if (!drState.meMarker) {
      const ic = L.divIcon({ className: '', html: '<div class="dr-me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
      drState.meMarker = L.marker(here, { icon: ic, zIndexOffset: 1000, interactive: false }).addTo(drState.map);
    } else drState.meMarker.setLatLng(here);
    if (drState.follow !== false) {
      const z = Math.max(drState.map.getZoom(), 15);
      const pt = drState.map.project(here, z).add([0, 90]); // centro 90px abajo → yo quedo arriba del sheet
      drState.map.setView(drState.map.unproject(pt, z), z, { animate: true, duration: 0.5 });
    }
    drUpdateDistHUD(here);
  }
  // Distancia a la próxima parada, en el chip superior.
  function drUpdateDistHUD(here) {
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx]; if (!leg || leg.lat == null) return;
    const km = drHav(here, [leg.lat, leg.lng]) * 1.35; // factor por carretera
    const txt = km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} m` : `${km.toFixed(1)} km`;
    const chip = document.querySelector('#driver-ruta-ui .dr-ex-chip'); if (!chip) return;
    let d = chip.querySelector('.dr-dist');
    if (!d) { d = document.createElement('span'); d.className = 'dr-dist'; chip.appendChild(d); }
    d.textContent = ' · ' + txt;
  }
  function drToggleRecenter(show) {
    const b = document.querySelector('#driver-ruta-ui .dr-recenter');
    if (b) b.classList.toggle('hidden', !show);
  }

  // ---------- Reanudar la ruta tras salir/volver a la app ----------
  const DR_PKEY = () => 'rendio-dr-progress-' + ((drState.profile && drState.profile.id) || 'anon');
  function drSaveProgress() {
    try {
      if (drState.view === 'exec' && drState.activeId) {
        const v = drVuelta();
        localStorage.setItem(DR_PKEY(), JSON.stringify({ day: (v && v.day) || null, activeId: drState.activeId, legIdx: drState.legIdx, legState: drState.legState, ts: Date.now() }));
      } else localStorage.removeItem(DR_PKEY());
    } catch (e) {}
  }
  function drRestoreProgress() {
    try {
      const raw = localStorage.getItem(DR_PKEY()); if (!raw) return false;
      const s = JSON.parse(raw);
      const v = drState.vueltas.find(x => x.id === s.activeId);
      if (!v || v.done) { localStorage.removeItem(DR_PKEY()); return false; }
      // Solo reanuda del mismo día operativo (no revive rutas viejas).
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      if (s.day && v.day && v.day !== today) { localStorage.removeItem(DR_PKEY()); return false; }
      drState.activeId = s.activeId;
      drState.legIdx = Math.min(s.legIdx || 0, v.legs.length - 1);
      drState.legState = s.legState || 'en_camino';
      drState.view = 'exec';
      return true;
    } catch (e) { return false; }
  }

  // ---------- DONE ----------
  function drDoneHTML() {
    const next = drState.vueltas.find(x => !x.done);
    return `<div id="driver-ruta-ui"><div class="dr-done">
      <div class="dr-done-ic"><svg class="icon"><use href="#i-check"/></svg></div>
      <h1>¡Vuelta completa!</h1>
      <p>${next ? `Tu siguiente vuelta sale ${next.start}. El admin ya vio el avance.` : 'Terminaste tus rutas de hoy. El admin ya fue notificado. 🎉'}</p>
      <button class="close" data-dr="overview"><svg class="icon" style="width:18px;height:18px"><use href="#i-back"/></svg>${next ? 'Ver mis vueltas' : 'Volver a mi ruta'}</button>
    </div></div>`;
  }

  // ---------- GPS en vivo ----------
  // Cada ping alimenta el mapa del admin. Es best-effort a propósito: si el GPS
  // falla o el insert no entra, el ancla por evento (mig 0045) sigue moviendo el
  // carro cuando el conductor marca "llegué"/"a bordo".
  function drPushGps(p) {
    drState.sharing = true;
    drUpdateLiveBadge();
    if (p && p.coords) { drUpdateMe(p.coords); drCheckNear([p.coords.latitude, p.coords.longitude]); } // Nivel 1 + "por llegar"
    if (drState.source !== 'live' || !drState.driverProfileId) return;
    if (!(window.Api && Api.sendDriverLocation)) return;
    const now = Date.now();
    if (now - drState.lastPingAt < DR_PING_MS) return;
    drState.lastPingAt = now;
    const c = p && p.coords; if (!c) return;
    const v = drVuelta();
    Api.sendDriverLocation(drState.driverProfileId, c.latitude, c.longitude, {
      routeAssignmentId: v && v.assignmentId,
      heading: c.heading,
      // La API del navegador da m/s; la tabla guarda km/h.
      speedKmh: isFinite(c.speed) && c.speed != null ? c.speed * 3.6 : undefined,
    }).catch(() => {});
  }
  function drStartGps() {
    if (drState.sharing || !navigator.geolocation) { drState.sharing = !!navigator.geolocation && drState.sharing; return; }
    try {
      drState.watchId = navigator.geolocation.watchPosition(
        drPushGps,
        () => { drState.sharing = false; drUpdateLiveBadge(); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
      drState.sharing = true;
    } catch (e) { drState.sharing = false; }
    drUpdateLiveBadge();
  }
  function drStopGps() {
    if (drState.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(drState.watchId);
    drState.watchId = null; drState.sharing = false;
  }
  function drUpdateLiveBadge() {
    document.querySelectorAll('#driver-ruta-ui .dr-share, #driver-ruta-ui .dr-ex-share').forEach(b => {
      b.classList.toggle('on', drState.sharing);
      const tx = b.childNodes[b.childNodes.length - 1];
      if (tx && tx.nodeType === 3) tx.textContent = drState.sharing ? 'Compartiendo ubicación' : 'Ubicación off';
    });
  }

  // ---------- Estados que persisten (Pieza 1) ----------
  function drPushStatus(reservationId, status) {
    if (drState.source !== 'live' || !reservationId || !(window.Api && Api.driverSetStopStatus)) return;
    Api.driverSetStopStatus(reservationId, status).catch(() => {});
  }
  // Push al auxiliar: su conductor va en camino / llegó al punto (best-effort, solo en vivo).
  function drNotifyAux(leg, kind) {
    if (drState.source !== 'live' || !leg || !leg.auxProfileId || typeof notify !== 'function') return;
    const who = ((drState.profile && drState.profile.full_name) || 'Tu conductor').split(' ')[0];
    if (kind === 'en_route') notify([leg.auxProfileId], 'Eres el siguiente 🔜', `${who} va hacia ti para recogerte.`, '/');
    else if (kind === 'arrived') notify([leg.auxProfileId], '¡Tu conductor llegó! 📍', `${who} está en el punto de recogida. Te espera ${drWaitMin()} min.`, '/');
    // Antes el "no se presentó" no le llegaba: el auxiliar se quedaba con la
    // pantalla en "en camino" para siempre, sin push y sin explicación.
    else if (kind === 'no_show') notify([leg.auxProfileId], 'No pudimos recogerte',
      `${who} esperó ${drWaitMin()} min en el punto y siguió su ruta. Si fue un error, avisa al coordinador.`, '/');
  }
  // Push "está por llegar" cuando el conductor está a <300 m de la recogida actual
  // (distancia REAL, una sola vez por parada).
  function drCheckNear(here) {
    if (drState.source !== 'live') return;
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx];
    if (!leg || leg.kind !== 'pickup' || !leg.auxProfileId || leg._nearNotified || leg.lat == null) return;
    if (drHav(here, [leg.lat, leg.lng]) < 0.3 && typeof notify === 'function') {
      leg._nearNotified = true;
      const who = ((drState.profile && drState.profile.full_name) || 'Tu conductor').split(' ')[0];
      notify([leg.auxProfileId], 'Tu conductor está por llegar 📍', `${who} está muy cerca de tu punto de recogida.`, '/');
    }
  }
  function drMarkEnRoute() {
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx]; if (!leg) return;
    if (leg.kind === 'pickup') { drPushStatus(leg.reservationId, 'en_route'); drNotifyAux(leg, 'en_route'); }
    else if (leg.kind === 'dropoff') drPushStatus(leg.reservationId, 'en_route_home');
  }
  function drApplyNext() {
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx]; if (!leg) return;
    if (leg.kind === 'pickup') drPushStatus(leg.reservationId, 'on_board');
    else if (leg.kind === 'dropoff') drPushStatus(leg.reservationId, 'delivered');
    else if (leg.kind === 'airport') {
      const st = v.type === 'lle' ? 'picked_up' : 'delivered';
      v.legs.filter(l => l.kind !== 'airport').forEach(l => drPushStatus(l.reservationId, st));
    }
  }

  // ---------- eventos ----------
  function drBindOnce() {
    if (drState.bound) return;
    const root = drHost(); if (!root) return;
    drState.bound = true;
    // Enter envía (el campo se recrea con cada render, por eso va delegado).
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target || e.target.id !== 'dr-chat-input') return;
      e.preventDefault();
      drChatSend();
    });
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-dr]'); if (!el) return;
      const a = el.dataset.dr;
      if (a === 'close') { drClose(); return; }
      if (a === 'overview') { drTeardown(); drState.view = 'overview'; drState.activeId = null; drRender(); return; }
      if (a === 'openroute') { drTeardown(); drState.activeId = el.dataset.id; drState.view = 'route'; drRender(); return; }
      if (a === 'start') { drTeardown(); drState.legIdx = 0; drState.legState = 'en_camino'; drState.view = 'exec'; drMarkEnRoute(); drStartGps(); drRender(); return; }
      if (a === 'back') { drBack(); return; }
      if (a === 'nav') { window.open(`https://waze.com/ul?ll=${el.dataset.lat},${el.dataset.lng}&navigate=yes`, '_blank'); return; }
      if (a === 'mapbig') { drOpenBigMap(); return; }
      if (a === 'mapbigclose') { drCloseBigMap(); return; }
      if (a === 'recenter') { drState.follow = true; drToggleRecenter(false); if (drState.lastPos) drUpdateMe({ latitude: drState.lastPos[0], longitude: drState.lastPos[1] }); return; }
      if (a === 'call2') { const p = el.dataset.phone || ''; if (p) window.open('tel:' + p.replace(/\s/g, '')); return; }
      if (a === 'arrived') {
        const v = drVuelta(); const leg = v && v.legs[drState.legIdx];
        if (leg && leg.kind === 'pickup') {
          leg._arrivedAt = Date.now();   // arranca el reloj de espera
          drPushStatus(leg.reservationId, 'at_pickup'); drNotifyAux(leg, 'arrived');
        }
        drState.legState = 'llegue'; drRender(); return;
      }
      if (a === 'noshow') {
        if (el.hasAttribute('disabled')) return;   // aún no cumple la espera
        const v = drVuelta(); const leg = v && v.legs[drState.legIdx];
        if (leg) { drPushStatus(leg.reservationId, 'no_show'); drNotifyAux(leg, 'no_show'); }
        toast('Marcado: no se presentó.'); drAdvance(); return;
      }
      if (a === 'next') { drApplyNext(); drAdvance(); return; }
      if (a === 'report') { toast('Reportar novedad — próximamente.'); return; }
      if (a === 'chat') { drChatOpen(el.dataset.rid, el.dataset.name, el.dataset.phone); return; }
      if (a === 'chat-close') { drChatClose(); return; }
      if (a === 'chat-send') { drChatSend(); return; }
    });
  }
  function drBack() {
    drTeardown();
    if (drState.view === 'exec') drState.view = 'route';
    else if (drState.view === 'route') { drState.view = 'overview'; drState.activeId = null; }
    else { drClose(); return; }
    drRender();
  }
  function drAdvance() {
    const v = drVuelta(); if (!v) return;
    if (drState.legIdx < v.legs.length - 1) {
      drState.legIdx++; drState.legState = 'en_camino'; drMarkEnRoute(); drRender();
    } else {
      v.done = true; drState._lastDone = v.id; drTeardown();
      drState.view = 'done'; drRender();
      const nextV = drState.vueltas.find(x => !x.done);
      toast(nextV ? `¡Vuelta ${v.id} completa!` : `¡Terminaste tus rutas de hoy! 🎉`);
    }
  }
