// admin-operacion.js — Admin: Operación en vivo — mapa OSM (Leaflet) + OSRM + monitoreo de carros.
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ====================================================================
  // OPERACIÓN EN VIVO — mapa real OSM (Leaflet) + monitoreo de carros.
  // Plan de Rutas: mapa OSM (gratis) + ETAs OSRM (gratis). Tráfico (Google/
  // TomTom) y vuelos (AeroDataBox) quedan STUBBEADOS (requieren API key).
  // Las posiciones reales saldrían de driver_locations (GPS de la app del
  // conductor); mientras no haya GPS, se usa data DEMO con coords reales.
  // ====================================================================
  const OP_MDE = { lat: 6.1645, lng: -75.4231 }; // Aeropuerto JMC (Rionegro)
  const OP_COLORS = { ontime: '#16936A', tight: '#C9810F', late: '#D6473B', done: '#9D998F' };
  const OP_STLABEL = { ontime: ['A tiempo', 'i-check'], tight: ['Ajustado', 'i-clock'], late: ['Va tarde', 'i-warn'], done: ['Completó', 'i-check'] };
  const OP_VAN_SVG = '<svg viewBox="0 0 24 24"><path d="M3 13V7a1 1 0 0 1 1-1h9l4 4h3a1 1 0 0 1 1 1v2"/><path d="M3 13h19v4H3z"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>';
  // DEMO con coordenadas reales del Oriente antioqueño → MDE. Los auxiliares
  // viven en Rionegro y alrededores; los viajes son recogida local → aeropuerto.
  const OP_DEMO_CARS = [
    { id: 'RD-01', driver: 'Carlos Roldán', dc: '#2563A8', pax: 3, cap: 4, state: 'ontime', next: 'Mariana R. · San Antonio', etaNext: '05:18', arrival: '05:28', pres: '05:50', flight: 'AV8120', status: 'En ruta', pos: [6.1490, -75.3590] }, // San Antonio de Pereira (Rionegro)
    { id: 'RD-02', driver: 'Jefferson Cardona', dc: '#7C5CD6', pax: 4, cap: 4, state: 'tight', next: 'Aeropuerto MDE', etaNext: '05:31', arrival: '05:31', pres: '05:40', flight: 'LA4011', status: 'A bordo · llegando', pos: [6.1480, -75.4080] }, // Llanogrande
    { id: 'RD-03', driver: 'Daniel Álvarez', dc: '#16936A', pax: 2, cap: 4, state: 'late', next: 'Valentina C. · Marinilla', etaNext: '05:26', arrival: '05:48', pres: '05:40', flight: 'AV8432', status: 'Recogiendo', pos: [6.1736, -75.3376] }, // Marinilla
    { id: 'RD-04', driver: 'Juan Mery', dc: '#0EA5E9', pax: 0, cap: 4, state: 'done', next: 'Turno completado', etaNext: '—', arrival: '05:02', pres: '—', flight: '—', status: 'Disponible', pos: [6.1645, -75.4231] }, // ya en MDE
  ];
  const OP_DEMO_FEED = [
    { k: 'bad', t: '05:11', h: '<b>RD-03</b> proyecta atraso de 8 min para el vuelo AV8432.' },
    { k: 'ok', t: '05:09', h: '<b>RD-01</b> recogió a Andrés F. en San Antonio de Pereira. 3/4 a bordo.' },
    { k: 'info', t: '05:04', h: '<b>RD-02</b> va camino al aeropuerto con 4/4.' },
    { k: 'ok', t: '05:02', h: '<b>RD-04</b> completó su ruta y queda disponible.' },
    { k: 'warn', t: '04:58', h: 'Tráfico moderado en la vía Llanogrande–Aeropuerto <i>(demo — tráfico en vivo pendiente de API key)</i>.' },
  ];
  const opState = { map: null, routeLayer: null, markerLayer: null, markers: {}, cars: [], feed: [], sel: 'RD-03', clockT: 0, timers: [], bound: false };

  const opIni = (n) => { const p = (n || '').trim().split(/\s+/); return ((p[0] || '')[0] + ((p[1] || p[0] || '')[0] || '')).toUpperCase(); };
  const opToSec = (s) => { const [h, m, sec] = s.split(':').map(Number); return h * 3600 + m * 60 + (sec || 0); };
  const opFmt = (sec) => { const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60, s = sec % 60; return [h, m, s].map(x => String(x).padStart(2, '0')).join(':'); };

  function renderOperacion() {
    if (!opState.cars.length) opState.cars = OP_DEMO_CARS.map(c => ({ ...c, pos: c.pos.slice(), path: null, prog: 0 }));
    if (!opState.feed.length) opState.feed = OP_DEMO_FEED.slice();
    if (!opState.clockT) opState.clockT = opToSec('05:12:04');
    initOperMap();
    renderOperCars();
    renderOperFeed();
    syncOperDelay();
    bindOperOnce();
    startOperTimers();
    // Dónde se conectaría el dato real cuando exista GPS del conductor:
    // tryLoadRealOps();  // leería driver_locations / route_assignments activas.
  }

  function initOperMap() {
    const el = document.getElementById('oper-map');
    if (!el) return;
    if (typeof L === 'undefined') {
      el.innerHTML = '<div style="padding:24px;color:#5F5B55;font-size:13px">No se pudo cargar el mapa (Leaflet sin conexión).</div>';
      return;
    }
    if (!opState.map) {
      const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: true }).setView([6.155, -75.39], 12); // Rionegro / Oriente → MDE
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.marker([OP_MDE.lat, OP_MDE.lng], {
        icon: L.divIcon({ className: '', html: `<div class="op-mk-air"><svg viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(map).bindTooltip('Aeropuerto MDE · Rionegro');
      opState.routeLayer = L.layerGroup().addTo(map);
      opState.markerLayer = L.layerGroup().addTo(map);
      opState.map = map;
      fetchOperRoutes(); // rutas reales por carretera (OSRM, best-effort)
    }
    // El panel estaba oculto al crear el mapa → recalcular tamaño al mostrarse.
    setTimeout(() => { try { opState.map && opState.map.invalidateSize(); } catch (e) {} }, 80);
    renderOperMarkers();
  }

  function renderOperMarkers() {
    if (!opState.map) return;
    opState.markerLayer.clearLayers();
    opState.markers = {};
    opState.cars.forEach(c => {
      if (c.state === 'done') return;
      const col = OP_COLORS[c.state];
      const selCss = c.id === opState.sel ? 'outline:3px solid #E2551A;outline-offset:2px;' : '';
      const html = `<div class="op-marker ${c.state}"><div class="op-mk-body" style="background:${col};${selCss}">${OP_VAN_SVG}</div></div>`;
      const m = L.marker(c.pos, { icon: L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: c.state === 'late' ? 1000 : 0 })
        .addTo(opState.markerLayer).bindTooltip(`${c.id} · ${c.driver} · llega ${c.arrival}`);
      m.on('click', () => { opState.sel = c.id; renderOperCars(); renderOperMarkers(); });
      opState.markers[c.id] = m;
    });
  }

  async function fetchOperRoutes() {
    for (const c of opState.cars) {
      if (c.state === 'done') continue;
      const col = OP_COLORS[c.state];
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${c.pos[1]},${c.pos[0]};${OP_MDE.lng},${OP_MDE.lat}?overview=full&geometries=geojson`;
        const j = await (await fetch(url)).json();
        const coords = j.routes[0].geometry.coordinates.map(p => [p[1], p[0]]); // [lat,lng]
        c.path = coords; c.prog = 0;
        L.polyline(coords, { color: col, weight: 3.5, opacity: 0.6, dashArray: '7 8' }).addTo(opState.routeLayer);
      } catch (e) {
        // Sin OSRM: línea recta como respaldo (la ETA real necesitaría el router).
        c.path = [c.pos.slice(), [OP_MDE.lat, OP_MDE.lng]];
        try { L.polyline(c.path, { color: col, weight: 3, opacity: 0.45, dashArray: '4 9' }).addTo(opState.routeLayer); } catch (_) {}
      }
    }
  }

  function opCarCard(c) {
    const [lab, ic] = OP_STLABEL[c.state];
    const etaCls = c.state === 'late' ? 'late' : c.state === 'tight' ? 'tight' : '';
    const next = c.state !== 'done'
      ? `<div class="op-cc-next"><svg class="icon"><use href="#i-pin"/></svg><span>Próx: <b>${c.next}</b></span><span class="eta ${etaCls}">${c.etaNext}</span></div>`
      : `<div class="op-cc-next"><svg class="icon"><use href="#i-check"/></svg><span>Llegó ${c.arrival} · sin pendientes</span></div>`;
    return `<div class="op-cc ${c.state} ${c.id === opState.sel ? 'sel' : ''}" data-car="${c.id}">
      <div class="op-cc-top">
        <span class="op-cc-dot" style="background:${c.dc}"><svg class="icon"><use href="#i-van"/></svg></span>
        <span class="op-cc-id">${c.id}<span>${c.status}</span></span>
        <span class="op-cc-state ${c.state}"><svg class="icon"><use href="#${ic}"/></svg>${lab}</span>
      </div>
      <div class="op-cc-body">
        <div class="op-cc-drv"><span class="av" style="background:${c.dc}">${opIni(c.driver)}</span><b>${c.driver}</b></div>
        <span class="op-cc-pax"><svg class="icon"><use href="#i-users"/></svg>${c.pax}/${c.cap}</span>
      </div>
      ${next}
    </div>`;
  }

  function renderOperCars() {
    const list = document.getElementById('oper-carlist');
    if (!list) return;
    list.innerHTML = opState.cars.map(opCarCard).join('');
    const on = opState.cars.filter(c => c.state === 'ontime').length;
    const risk = opState.cars.filter(c => c.state === 'late' || c.state === 'tight').length;
    const done = opState.cars.filter(c => c.state === 'done').length;
    const set = (id, n) => { const e = document.querySelector(`#${id} b`); if (e) e.textContent = n; };
    set('oper-kOn', on); set('oper-kLate', risk); set('oper-kDone', done);
    const lateN = opState.cars.filter(c => c.state === 'late').length;
    const kl = document.getElementById('oper-kLate'); if (kl) kl.className = 'op-kpi ' + (lateN ? 'bad' : risk ? 'warn' : 'ok');
  }

  function renderOperFeed() {
    const f = document.getElementById('oper-feed');
    if (!f) return;
    f.innerHTML = opState.feed.map(e => `<div class="op-ev ${e.k}"><span class="op-evdot"></span><div class="op-evtx"><p>${e.h}</p><div class="op-evt">${e.t}</div></div></div>`).join('');
  }
  function opPushFeed(k, h) {
    const now = (document.getElementById('oper-clock')?.textContent || '05:12:00').slice(0, 5);
    opState.feed.unshift({ k, t: now, h });
    renderOperFeed();
  }

  function syncOperDelay() {
    const late = opState.cars.find(c => c.state === 'late');
    const box = document.getElementById('oper-delay');
    if (!box) return;
    if (late) {
      const t = document.getElementById('oper-delayTitle'); if (t) t.textContent = `${late.id} va tarde para el vuelo ${late.flight}`;
      const s = document.getElementById('oper-delaySub'); if (s) s.textContent = `Llegaría ${late.arrival} · presentación ${late.pres} — 8 min tarde para ${late.next.split(' · ')[0]}`;
      box.classList.add('show');
    } else box.classList.remove('show');
  }

  function resolveOperLate(method) {
    const late = opState.cars.find(c => c.state === 'late');
    if (!late) return;
    late.state = 'tight'; late.arrival = '05:38'; late.etaNext = '05:24';
    renderOperCars(); renderOperMarkers(); syncOperDelay();
    if (method === 'reopt') { opPushFeed('ok', `Re-optimización: <b>${late.id}</b> ahora llega 05:38 — a tiempo para ${late.flight}.`); toast('Rutas re-optimizadas. RD-03 ya llega a tiempo.'); }
    if (method === 'reassign') { opPushFeed('info', `Parada de Valentina C. reasignada a <b>RD-01</b>. Holgura recuperada.`); toast('Parada reasignada a RD-01.'); }
    if (method === 'call') { opPushFeed('info', `Llamada al conductor de <b>${late.id}</b> para priorizar la última recogida.`); toast('Llamando a Daniel Álvarez…'); }
  }

  function startOperTimers() {
    stopOperTimers();
    const clk = setInterval(() => {
      if (state.activeTab !== 'oper') { stopOperTimers(); return; }
      opState.clockT += 1;
      const el = document.getElementById('oper-clock'); if (el) el.textContent = opFmt(opState.clockT);
    }, 1000);
    const mv = setInterval(() => {
      if (state.activeTab !== 'oper') { stopOperTimers(); return; }
      let moved = false;
      opState.cars.forEach(c => {
        if (c.state === 'done' || !c.path || c.path.length < 2) return;
        const step = (c.path.length - 1) / 90; // recorre la ruta en ~90 ticks
        c.prog = (c.prog || 0) + step;
        let seg = Math.floor(c.prog);
        if (seg >= c.path.length - 1) { c.pos = c.path[c.path.length - 1].slice(); return; }
        const f = c.prog - seg, a = c.path[seg], b = c.path[seg + 1];
        c.pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        const m = opState.markers[c.id]; if (m) m.setLatLng(c.pos);
        moved = true;
      });
      if (!moved) { /* todos llegaron */ }
    }, 1100);
    opState.timers = [clk, mv];
  }
  function stopOperTimers() {
    (opState.timers || []).forEach(t => clearInterval(t));
    opState.timers = [];
  }

  function bindOperOnce() {
    if (opState.bound) return;
    const root = document.getElementById('oper-ui');
    if (!root) return;
    opState.bound = true;
    root.addEventListener('click', (e) => {
      const cc = e.target.closest('[data-car]');
      if (cc) { opState.sel = cc.dataset.car; renderOperCars(); renderOperMarkers(); return; }
      if (e.target.closest('#oper-delayClose')) { document.getElementById('oper-delay').classList.remove('show'); return; }
      if (e.target.closest('#oper-actReopt')) { resolveOperLate('reopt'); return; }
      if (e.target.closest('#oper-actReassign')) { resolveOperLate('reassign'); return; }
      if (e.target.closest('#oper-actCall')) { resolveOperLate('call'); return; }
    });
  }

