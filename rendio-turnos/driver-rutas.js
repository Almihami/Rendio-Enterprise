// driver-rutas.js — Conductor: Ruta del día + ejecución paso a paso.
// Diseño UX portado FIEL de /Visual/route-screens.jsx (tokens --r-*, bottom-sheet,
// lista de paradas con conector, pills flotantes, colores salida/llegada). Ver
// [feedback-seguir-diseno-ux]. Cableado técnico intacto: ruta REAL asignada
// (listMyVueltasForDriver), estados que persisten (Pieza 1: driverSetStopStatus),
// mapa Leaflet real, navegar→Waze, llamar→tel:, GPS en vivo.

  const DR_MDE = { lat: 6.1715, lng: -75.4270, name: 'Aeropuerto MDE', addr: 'Terminal de pasajeros · José María Córdova' };

  // Vueltas demo (fallback si no hay ruta real). kind: pickup|dropoff|airport.
  const DR_DEMO_VUELTAS = [
    { id: 'V1', type: 'sal', start: '04:00', done: false, legs: [
      { name: 'Laura Gómez', addr: 'Cra 51 #49-06, Centro', lat: 6.1529, lng: -75.3752, phone: '+57 310 555 0142', flight: 'AV-9412 · 05:10', dl: '05:10', kind: 'pickup', notes: 'Portón negro, timbre del 201.' },
      { name: 'Andrés Peña', addr: 'Calle 47 #59-33, El Porvenir', lat: 6.1468, lng: -75.3849, phone: '+57 311 555 0233', flight: 'AV-9412 · 05:10', dl: '05:10', kind: 'pickup', notes: 'Frente a la tienda, casa de dos pisos.' },
      { name: DR_MDE.name, addr: DR_MDE.addr, lat: DR_MDE.lat, lng: DR_MDE.lng, kind: 'airport' },
    ] },
    { id: 'V2', type: 'lle', start: '10:40', done: false, legs: [
      { name: DR_MDE.name, addr: 'Recoger en MDE · llegadas', lat: DR_MDE.lat, lng: DR_MDE.lng, kind: 'airport' },
      { name: 'Patricia Díaz', addr: 'Calle 43 #55-20, San Nicolás', lat: 6.1473, lng: -75.3778, phone: '+57 313 555 0777', flight: 'AV-9527', dl: '10:40', kind: 'dropoff' },
    ] },
  ];

  const drState = {
    profile: null, source: 'demo', driverProfileId: null,
    vueltas: [], view: 'overview', activeId: null, legIdx: 0, legState: 'en_camino',
    map: null, watchId: null, sharing: false, bound: false, _lastDone: null,
    lastPingAt: 0,
  };
  // Cada cuánto se escribe la posición. Cada carro tiene su propio celular con
  // cargador (no hay que cuidar batería), así que se reporta seguido: a 6s y
  // 60 km/h son ~100 m entre puntos, y el admin los une con una animación que
  // se ve continua. La retención de 7 días (mig 0046) le pone techo a la tabla.
  const DR_PING_MS = 6000;

  window.DriverRutas = { open: drOpen, close: drClose };
  const drHost = () => document.getElementById('driver-ruta-root');

  // Abre la ruta del día (pantalla completa). Lee la ruta REAL asignada; si no hay → demo.
  async function drOpen(profile) {
    drState.profile = profile;
    drState.view = 'overview'; drState.activeId = null;
    const root = drHost(); if (!root) return;
    root.classList.remove('hidden');
    root.innerHTML = '<div id="driver-ruta-ui"><div class="dr-loading">Cargando tu ruta…</div></div>';
    let vueltas = null;
    try { if (window.Api && Api.listMyVueltasForDriver && profile && profile.id) vueltas = await Api.listMyVueltasForDriver(profile.id); } catch (e) {}
    drState.source = (vueltas && vueltas.length) ? 'live' : 'demo';
    drState.vueltas = (vueltas && vueltas.length)
      ? vueltas
      : DR_DEMO_VUELTAS.map(v => ({ ...v, legs: v.legs.map(l => ({ ...l })) }));
    // driver_locations referencia driver_profiles(id), no profiles(id).
    drState.driverProfileId = null;
    if (drState.source === 'live' && window.Api && Api.getMyDriverProfileId) {
      try { drState.driverProfileId = await Api.getMyDriverProfileId(profile.id); } catch (e) {}
    }
    drBindOnce();
    drRender();
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
  }
  function drTeardown() {
    if (drState.map) { try { drState.map.remove(); } catch (e) {} drState.map = null; }
    drStopGps();
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
    const done = vs.filter(v => v.done).length;
    const pax = vs.reduce((n, v) => n + drStopsOf(v).length, 0);
    const pct = vs.length ? Math.round(done / vs.length * 100) : 0;
    const dateStr = drFmtDate(vs[0] && vs[0].day);
    return `<div id="driver-ruta-ui">
      <div class="dr-topbar">
        <button class="dr-icbtn" data-dr="close" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>Ruta del día</b>
        ${drState.source === 'demo' ? '<span class="dr-demo-tag">demo</span>' : ''}
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
      const time = isApt ? v.start : (l.dl || '');
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
      <div class="dr-map" id="dr-route-map"><div class="dr-map-chip">${stops.length} paradas · ${v.type === 'lle' ? 'llegada' : 'salida'}</div></div>
      <div class="dr-seclabel" style="margin-left:24px">Paradas en orden</div>
      <div class="dr-stops">${rows}</div>
      <div class="dr-bottom">
        <button class="dr-btn-primary" data-dr="start"><svg class="icon"><use href="#i-bolt"/></svg>Iniciar ruta</button>
      </div>
    </div>`;
  }
  async function drRouteMap() {
    const el = document.getElementById('dr-route-map');
    if (!el || typeof L === 'undefined') return;
    if (drState.map) { try { drState.map.remove(); } catch (e) {} drState.map = null; }
    const v = drVuelta(); if (!v) return;
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    if (!pts.length) return;
    const map = drState.map = L.map(el, { zoomControl: false, attributionControl: false, tap: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    v.legs.forEach(l => {
      if (l.lat == null) return;
      const color = l.kind === 'airport' ? '#10B981' : '#F26522';
      L.circleMarker([l.lat, l.lng], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map);
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
    const contacts = (!isApt && leg.phone) ? `<div class="dr-aux-btns">
        <a class="dr-cbtn msg" href="sms:${leg.phone.replace(/\s/g, '')}" aria-label="Mensaje"><svg class="icon" style="width:19px;height:19px"><use href="#i-send"/></svg></a>
        <a class="dr-cbtn tel" href="tel:${leg.phone.replace(/\s/g, '')}" aria-label="Llamar"><svg class="icon" style="width:19px;height:19px"><use href="#i-phone"/></svg></a>
      </div>` : '';
    const footLinks = `<span class="links">${(!enCamino && leg.kind === 'pickup') ? '<button data-dr="noshow">No se presentó</button>' : ''}<button data-dr="report">Reportar novedad</button></span>`;

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
      <div class="dr-sheet">
        <div class="dr-sheet-h"><i></i></div>
        <div class="dr-sheet-b">
          <div class="dr-aux">
            <div class="dr-aux-av ${tone}">${isApt ? '✈' : drIni(leg.name)}</div>
            <div class="dr-aux-t"><div class="nm">${isApt ? 'Aeropuerto MDE' : leg.name}</div><div class="ad">${leg.addr || ''}</div></div>
            ${contacts}
          </div>
          ${mid}
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
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx];
    const pts = v.legs.filter(l => l.lat != null).map(l => [l.lat, l.lng]);
    const map = drState.map = L.map(el, { zoomControl: false, attributionControl: false });
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
  function drMarkEnRoute() {
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx]; if (!leg) return;
    if (leg.kind === 'pickup') drPushStatus(leg.reservationId, 'en_route');
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
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-dr]'); if (!el) return;
      const a = el.dataset.dr;
      if (a === 'close') { drClose(); return; }
      if (a === 'overview') { drTeardown(); drState.view = 'overview'; drState.activeId = null; drRender(); return; }
      if (a === 'openroute') { drTeardown(); drState.activeId = el.dataset.id; drState.view = 'route'; drRender(); return; }
      if (a === 'start') { drTeardown(); drState.legIdx = 0; drState.legState = 'en_camino'; drState.view = 'exec'; drMarkEnRoute(); drStartGps(); drRender(); return; }
      if (a === 'back') { drBack(); return; }
      if (a === 'nav') { window.open(`https://waze.com/ul?ll=${el.dataset.lat},${el.dataset.lng}&navigate=yes`, '_blank'); return; }
      if (a === 'call2') { const p = el.dataset.phone || ''; if (p) window.open('tel:' + p.replace(/\s/g, '')); return; }
      if (a === 'arrived') {
        const v = drVuelta(); const leg = v && v.legs[drState.legIdx];
        if (leg && leg.kind === 'pickup') drPushStatus(leg.reservationId, 'at_pickup');
        drState.legState = 'llegue'; drRender(); return;
      }
      if (a === 'noshow') {
        const v = drVuelta(); const leg = v && v.legs[drState.legIdx];
        if (leg) drPushStatus(leg.reservationId, 'no_show');
        toast('Marcado: no se presentó.'); drAdvance(); return;
      }
      if (a === 'next') { drApplyNext(); drAdvance(); return; }
      if (a === 'report') { toast('Reportar novedad — próximamente.'); return; }
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
