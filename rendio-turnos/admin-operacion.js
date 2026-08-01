// admin-operacion.js — Admin: Operación en vivo — mapa OSM (Leaflet) + OSRM + monitoreo de carros.
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ====================================================================
  // OPERACIÓN EN VIVO — mapa real OSM (Leaflet) + monitoreo de carros.
  // Plan de Rutas: mapa OSM (gratis) + ETAs OSRM (gratis). Tráfico (Google/
  // TomTom) y vuelos (AeroDataBox) quedan STUBBEADOS (requieren API key).
  // Las posiciones salen de driver_locations (GPS de la app del conductor) y de
  // las anclas por evento (mig 0045). Desde 2026-07-25 NO hay data de ejemplo:
  // sin operación real la pantalla queda vacía y explica qué falta.
  // ====================================================================
  // Rotonda del TERMINAL DE PASAJEROS (acceso occidental) — la coord genérica
  // del aeropuerto ruteaba por la zona de carga/CACOM 5, que es prohibida.
  const OP_MDE = { lat: 6.1715, lng: -75.4270 }; // MDE · terminal de pasajeros
  const OP_COLORS = { ontime: '#16936A', tight: '#C9810F', late: '#D6473B', done: '#9D998F' };
  // Color por carro (identidad en el mapa y en la tarjeta), en orden estable.
  const OP_CAR_COLORS = ['#2563A8', '#7C5CD6', '#16936A', '#0EA5E9', '#E2551A', '#8B5CF6'];
  const OP_STLABEL = { ontime: ['A tiempo', 'i-check'], tight: ['Ajustado', 'i-clock'], late: ['Va tarde', 'i-warn'], done: ['Completó', 'i-check'] };
  const OP_VAN_SVG = '<svg viewBox="0 0 24 24"><path d="M3 13V7a1 1 0 0 1 1-1h9l4 4h3a1 1 0 0 1 1 1v2"/><path d="M3 13h19v4H3z"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>';
  // 2026-07-25: se eliminaron OP_DEMO_CARS y OP_DEMO_FEED (4 carros y 5 eventos
  // inventados que se pintaban cuando no había operación real). Servían para
  // enseñar la pantalla antes de que existiera el GPS, pero con la app en
  // pruebas reales mentían: mostraban carros rodando y conductores por nombre
  // que no existían. Ver [feedback-no-inventar-datos]. Sin datos reales la
  // pantalla ahora lo DICE y no pinta nada.
  const opState = { map: null, routeLayer: null, markerLayer: null, markers: {}, cars: [], feed: [], sel: null, clockT: 0, timers: [], bound: false, source: 'empty', day: null, loading: false, tweens: {}, raf: null };
  // Cada cuánto se relee la operación real. La posición llega por polling: la
  // tabla driver_locations se diseñó para Realtime, pero el polling es suficiente
  // para una flota de 3-4 carros y no exige habilitar replicación.
  const OP_POLL_MS = 5000;
  // El marcador se desliza entre DOS reportes REALES (no extrapola: al llegar al
  // último punto conocido, se queda ahí). Si el hueco entre reportes es mayor que
  // esto, no sabemos por dónde fue → salta en vez de inventar el trayecto.
  const OP_TWEEN_MAX_GAP_MS = 30000;
  // Margen antes de la presentación para considerar la vuelta "ajustada".
  const OP_TIGHT_MIN = 10;
  // A partir de aquí un GPS se considera viejo y manda el ancla por evento.
  const OP_STALE_MS = 2 * 60 * 1000;
  // El carro brinca de un reporte al siguiente (no interpolamos), pero no hace
  // falta recalcular ruta/ETA en cada brinco: OSRM es el servidor público de
  // demo y pide uso ligero. Solo se rehace si el carro se movió de verdad, si
  // cambió de destino, o si pasó un minuto.
  const OP_OSRM_MOVE_M = 250;
  const OP_OSRM_MAX_MS = 60000;

  const opIni = (n) => { const p = (n || '').trim().split(/\s+/); return ((p[0] || '')[0] + ((p[1] || p[0] || '')[0] || '')).toUpperCase(); };
  const opToSec = (s) => { const [h, m, sec] = s.split(':').map(Number); return h * 3600 + m * 60 + (sec || 0); };
  const opFmt = (sec) => { const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60, s = sec % 60; return [h, m, s].map(x => String(x).padStart(2, '0')).join(':'); };

  function renderOperacion() {
    // El reloj arranca en la hora REAL de Colombia (antes en un 05:12:04 fijo).
    // Se pinta ya: si se deja al intervalo, el primer segundo muestra "--:--:--".
    opState.clockT = opNowSec();
    const clkEl = document.getElementById('oper-clock');
    if (clkEl) clkEl.textContent = opFmt(opState.clockT);
    initOperMap();
    renderOperCars();
    renderOperFeed();
    syncOperDelay();
    bindOperOnce();
    startOperTimers();
    loadRealOps(); // única fuente: rutas publicadas + GPS/anclas reales
  }

  // ---------------------------------------------------------------------------
  // DATO REAL — route_assignments activas + driver_locations.
  // ---------------------------------------------------------------------------

  // Reloj real en hora Colombia (el demo corría un contador falso desde 05:12).
  const opNowSec = () => {
    const s = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false });
    return opToSec(s);
  };

  async function loadRealOps() {
    if (opState.loading || !(window.Api && Api.listLiveOperation)) return;
    opState.loading = true;
    try {
      const data = await Api.listLiveOperation();
      // Sin plan publicado o sin carros rodando: la pantalla queda VACÍA y lo
      // dice. Antes se quedaba el demo y parecía que había operación en curso.
      if (!data || data.source !== 'live' || !data.cars.length) {
        if (opState.cars.length) { opState.cars = []; opState.sel = null; opStopRaf(); }
        opState.source = 'empty';
        renderOperCars(); renderOperFeed(); syncOperDelay(); renderOperMarkers();
        return;
      }
      const first = opState.source !== 'live';
      opState.source = 'live';
      opState.day = data.day;
      opState.clockT = opNowSec();
      const prevById = {};
      opState.cars.forEach(c => { prevById[c.id] = c; });
      opState.cars = data.cars.map((c, i) => {
        const prev = prevById[c.id];
        const stale = opNeedsOsrm(c, prev); // ¿se movió lo bastante para rehacer ruta/ETA?
        return {
          ...c,
          dc: OP_CAR_COLORS[i % OP_CAR_COLORS.length],
          // Sin dato nuevo de OSRM, conservamos el semáforo anterior en vez de
          // parpadear a 'ontime' en cada refresco.
          state: prev ? prev.state : 'ontime',
          arrival: prev ? prev.arrival : '—',
          etaNext: prev ? prev.etaNext : '—',
          lateMin: prev ? prev.lateMin : null,
          path: prev ? prev.path : null,
          _osrmFrom: prev ? prev._osrmFrom : null,
          _osrmDest: prev ? prev._osrmDest : null,
          _osrmAt: prev ? prev._osrmAt : 0,
          _needsOsrm: stale,
        };
      });
      opState.feed = data.feed.length ? data.feed : [{ k: 'info', t: opFmt(opState.clockT).slice(0, 5), h: 'Sin eventos todavía. El feed se llena cuando el conductor marca su avance.' }];
      // Demoras que detectó el vigilante mientras nadie miraba la pantalla
      // (corre en la base cada 5 min, también de madrugada). Van ARRIBA del feed:
      // es lo primero que el jefe tiene que ver al abrir en la mañana.
      try {
        if (window.Api?.listOpenRouteRisks) {
          const risks = await Api.listOpenRouteRisks();
          risks.slice(0, 8).reverse().forEach(r => {
            const hora = (() => { try { return new Date(r.at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } })();
            // El feed se pinta con innerHTML: el nombre viene de la base y va escapado.
            const nom = String(r.aux || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            opState.feed.unshift({ k: 'warn', t: hora,
              h: `<b>${nom}</b> — el carro no alcanzaba su recogida por ~${r.minutesLate} min${r.km ? ` (estaba a ${r.km} km)` : ''}.` });
          });
        }
      } catch (_) { /* sin vigilante: el feed queda como estaba */ }
      if (first || !opState.cars.some(c => c.id === opState.sel)) opState.sel = opState.cars[0].id;
      await opComputeStates();
      renderOperCars(); renderOperFeed(); syncOperDelay();

      // Las animaciones se deciden ANTES de pintar: renderOperMarkers saltaría
      // el marcador al destino y la animación arrancaría desde donde termina.
      opState.cars.forEach(c => {
        const prev = prevById[c.id];
        const m = opState.markers[c.id];
        if (!m || !c.pos || !prev || !prev.pos || !prev.posAt || !c.posAt) return;
        if (String(prev.pos) === String(c.pos)) return;      // no reportó nada nuevo
        const gap = new Date(c.posAt) - new Date(prev.posAt);
        if (gap <= 0 || gap > OP_TWEEN_MAX_GAP_MS) return;    // hueco largo: no sabemos el trayecto → que salte
        if (c.posSource === 'anchor') return;                 // el ancla es un salto cierto, no un recorrido
        // Arranca desde donde el marcador está pintado ahora (puede venir a
        // mitad de la animación anterior), no desde el reporte viejo.
        const ll = m.getLatLng();
        opTween(c.id, [ll.lat, ll.lng], c.pos.slice(), OP_POLL_MS);
      });
      renderOperMarkers();
      // La ruta punteada tiene que salir de donde está el carro AHORA; si solo se
      // dibujara al principio, el carro se despegaría de su propio trayecto.
      if (opState.cars.some(c => c._needsOsrm)) fetchOperRoutes();
      if (first) startOperTimers(); // en vivo: sin animación, solo polling
    } catch (e) {
      // Sin red o sin permisos: se queda lo que haya (demo o el último dato).
    } finally {
      opState.loading = false;
    }
  }

  // Semáforo REAL: ETA por carretera (OSRM) desde donde está el carro hasta el
  // aeropuerto, contra la hora de presentación del vuelo más próximo.
  // Solo aplica a las SALIDAS: en una llegada los pasajeros ya aterrizaron y no
  // hay vuelo que perder, así que no inventamos una alarma.
  async function opComputeStates() {
    for (const c of opState.cars) {
      if (c.done) { c.state = 'done'; c.arrival = c.posAt ? opHHMM(c.posAt) : '—'; continue; }
      if (!c.pos) { c.state = 'ontime'; c.arrival = '—'; c.etaNext = '—'; continue; }
      if (!c._needsOsrm) continue; // no se movió lo bastante: vale el cálculo anterior
      const etaSec = await opEtaSec(c.pos, [OP_MDE.lat, OP_MDE.lng]);
      c._osrmAt = Date.now();
      if (etaSec == null || c.type === 'lle' || !c.presAt) {
        c.state = 'ontime';
        c.arrival = etaSec != null ? opFmt((opNowSec() + etaSec) % 86400).slice(0, 5) : '—';
        c.etaNext = c.arrival;
        continue;
      }
      const arrSec = opNowSec() + etaSec;
      const presSec = opToSec(opHHMM(c.presAt));
      c.arrival = opFmt(arrSec % 86400).slice(0, 5);
      c.etaNext = c.arrival;
      const holgura = (presSec - arrSec) / 60;
      c.lateMin = Math.max(0, Math.round(-holgura));
      c.state = holgura < 0 ? 'late' : holgura <= OP_TIGHT_MIN ? 'tight' : 'ontime';
    }
  }

  const opHHMM = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5);

  // Metros entre dos [lat,lng] (haversine). Para decidir si el carro se movió
  // lo bastante como para valer una llamada a OSRM.
  function opDistM(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ---------- Movimiento continuo entre dos reportes REALES ----------
  // El carro reportó en A y luego en B: estuvo de verdad en el medio, así que
  // deslizarlo de A a B no inventa nada — dibuja la transición. Lo que NO se
  // hace es seguir moviéndolo después de B (eso sí sería adivinar): al llegar
  // al último punto conocido se queda quieto hasta el siguiente reporte.
  //
  // A 6s entre pings, los puntos quedan a ~100 m: la línea recta entre ellos es
  // indistinguible de la vía, así que no hace falta rutear cada tramo.
  function opTween(id, from, to, dur) {
    opState.tweens[id] = { from, to, t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()), dur: Math.max(400, dur) };
    opStartRaf();
  }
  function opStartRaf() {
    if (opState.raf) return;
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let vivos = 0;
      Object.keys(opState.tweens).forEach(id => {
        const tw = opState.tweens[id];
        const m = opState.markers[id];
        if (!m) { delete opState.tweens[id]; return; }
        const k = Math.min(1, (now - tw.t0) / tw.dur);
        m.setLatLng([tw.from[0] + (tw.to[0] - tw.from[0]) * k, tw.from[1] + (tw.to[1] - tw.from[1]) * k]);
        if (k >= 1) delete opState.tweens[id]; else vivos++;
      });
      opState.raf = vivos ? requestAnimationFrame(step) : null;
    };
    opState.raf = requestAnimationFrame(step);
  }
  function opStopRaf() {
    if (opState.raf) cancelAnimationFrame(opState.raf);
    opState.raf = null;
    opState.tweens = {};
  }

  // ¿Vale la pena rehacer ruta y ETA de este carro?
  function opNeedsOsrm(c, prev) {
    if (!c.pos) return false;
    if (!prev || !prev._osrmFrom) return true;
    if (String(prev._osrmDest) !== String(c.nextPos)) return true; // cambió de parada
    if (Date.now() - (prev._osrmAt || 0) > OP_OSRM_MAX_MS) return true;
    return opDistM(prev._osrmFrom, c.pos) > OP_OSRM_MOVE_M;
  }

  // Segundos de viaje por carretera entre dos puntos. null si OSRM no responde
  // (preferimos no mostrar semáforo a mostrar uno inventado con línea recta).
  async function opEtaSec(from, to) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`;
      const j = await (await fetch(url)).json();
      return j.routes && j.routes[0] ? Math.round(j.routes[0].duration) : null;
    } catch (e) { return null; }
  }

  // Frescura de la posición: el admin tiene que saber si ve un dato vivo o una
  // foto vieja. Un punto de hace 20 min no es "dónde está", es "dónde estuvo".
  function opFreshness(c) {
    if (!c.pos || !c.posAt) return { txt: 'sin ubicación aún', cls: 'stale' };
    const age = Date.now() - new Date(c.posAt).getTime();
    const min = Math.floor(age / 60000);
    const rel = age < 45000 ? 'ahora' : min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h`;
    const src = c.posSource === 'anchor' ? 'última parada' : 'GPS';
    return { txt: `${src} · ${rel}`, cls: age > OP_STALE_MS ? 'stale' : 'fresh' };
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
    const vivos = {};
    opState.cars.forEach(c => {
      if (c.state === 'done') return;
      // Sin posición reportada no hay marcador: un carro puesto "por si acaso"
      // en un punto cualquiera es peor que un carro ausente.
      if (!c.pos) return;
      vivos[c.id] = true;
      const col = OP_COLORS[c.state];
      const selCss = c.id === opState.sel ? 'outline:3px solid #E2551A;outline-offset:2px;' : '';
      const stale = opState.source === 'live' && opFreshness(c).cls === 'stale' ? ' stale' : '';
      const html = `<div class="op-marker ${c.state}${stale}"><div class="op-mk-body" style="background:${col};${selCss}">${OP_VAN_SVG}</div></div>`;
      const tip = opState.source === 'live'
        ? `${c.id} · ${c.driver} · ${opFreshness(c).txt}`
        : `${c.id} · ${c.driver} · llega ${c.arrival}`;
      const icon = L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] });

      // Si el marcador ya existe se MUEVE, no se recrea: recrearlo en cada
      // refresco hace parpadear el mapa y cierra el tooltip abierto.
      const ex = opState.markers[c.id];
      if (ex) {
        // Si hay animación en curso, la posición la maneja el rAF: pisarla aquí
        // teletransportaría el carro al destino y mataría el deslizamiento.
        if (!opState.tweens[c.id]) ex.setLatLng(c.pos);
        if (ex._opHtml !== html) { ex.setIcon(icon); ex._opHtml = html; }
        ex.setZIndexOffset(c.state === 'late' ? 1000 : 0);
        ex.setTooltipContent(tip);
        return;
      }
      const m = L.marker(c.pos, { icon, zIndexOffset: c.state === 'late' ? 1000 : 0 })
        .addTo(opState.markerLayer).bindTooltip(tip);
      m._opHtml = html;
      m.on('click', () => { opState.sel = c.id; renderOperCars(); renderOperMarkers(); });
      opState.markers[c.id] = m;
    });
    // Carros que ya no van en el mapa (terminaron o perdieron posición).
    Object.keys(opState.markers).forEach(id => {
      if (vivos[id]) return;
      try { opState.markerLayer.removeLayer(opState.markers[id]); } catch (_) {}
      delete opState.markers[id];
    });
  }

  async function fetchOperRoutes() {
    // En vivo se redibujan TODAS las líneas (la capa es una sola), pero solo se
    // vuelve a pedir a OSRM la de los carros que se movieron.
    if (opState.source === 'live' && opState.routeLayer) opState.routeLayer.clearLayers();
    for (const c of opState.cars) {
      if (c.state === 'done' || !c.pos) continue;
      const col = OP_COLORS[c.state];
      // El trayecto que importa es hacia donde va: la próxima parada si la hay,
      // el aeropuerto si ya no quedan recogidas.
      const dest = (opState.source === 'live' && c.nextPos) ? c.nextPos : [OP_MDE.lat, OP_MDE.lng];
      if (opState.source === 'live' && !c._needsOsrm && c.path) {
        try { L.polyline(c.path, { color: col, weight: 3.5, opacity: 0.6, dashArray: '7 8' }).addTo(opState.routeLayer); } catch (_) {}
        continue;
      }
      c._osrmFrom = c.pos.slice(); c._osrmDest = dest;
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${c.pos[1]},${c.pos[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson`;
        const j = await (await fetch(url)).json();
        const coords = j.routes[0].geometry.coordinates.map(p => [p[1], p[0]]); // [lat,lng]
        c.path = coords; c.prog = 0;
        L.polyline(coords, { color: col, weight: 3.5, opacity: 0.6, dashArray: '7 8' }).addTo(opState.routeLayer);
      } catch (e) {
        // Sin OSRM: línea recta como respaldo (la ETA real necesitaría el router).
        c.path = [c.pos.slice(), dest.slice()];
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
    // En vivo mostramos de dónde salió el punto y qué tan viejo es.
    const fr = opState.source === 'live' ? opFreshness(c) : null;
    const fresh = fr ? `<div class="op-cc-fresh ${fr.cls}"><span class="op-cc-freshdot"></span>${fr.txt}</div>` : '';
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
      ${fresh}
    </div>`;
  }

  function renderOperCars() {
    const list = document.getElementById('oper-carlist');
    if (!list) return;
    if (!opState.cars.length) {
      // Estado vacío honesto: se dice POR QUÉ no hay nada y qué falta para que
      // aparezca. Antes aquí se pintaban 4 carros inventados rodando.
      list.innerHTML = `<div class="op-empty">
        <svg class="icon"><use href="#i-route"/></svg>
        <b>No hay carros en operación</b>
        <span>Aparecen aquí cuando hay un plan de rutas publicado con conductor asignado y ese conductor inicia su ruta desde la app.</span>
      </div>`;
      ['oper-kOn', 'oper-kLate', 'oper-kDone'].forEach(id => { const e = document.querySelector(`#${id} b`); if (e) e.textContent = '0'; });
      const kl0 = document.getElementById('oper-kLate'); if (kl0) kl0.className = 'op-kpi ok';
      return;
    }
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
    if (!opState.feed.length) {
      f.innerHTML = `<div class="op-empty sm"><span>Sin eventos. El feed se llena con lo que marcan los conductores en su ruta.</span></div>`;
      return;
    }
    f.innerHTML = opState.feed.map(e => `<div class="op-ev ${e.k}"><span class="op-evdot"></span><div class="op-evtx"><p>${e.h}</p><div class="op-evt">${e.t}</div></div></div>`).join('');
  }
  function opPushFeed(k, h) {
    const now = opFmt(opNowSec()).slice(0, 5);   // hora real, no un 05:12 fijo
    opState.feed.unshift({ k, t: now, h });
    renderOperFeed();
  }

  function syncOperDelay() {
    const late = opState.cars.find(c => c.state === 'late');
    const box = document.getElementById('oper-delay');
    if (!box) return;
    if (late) {
      const t = document.getElementById('oper-delayTitle'); if (t) t.textContent = `${late.id} va tarde para el vuelo ${late.flight}`;
      const s = document.getElementById('oper-delaySub');
      // El atraso sale de la ETA real, no de un número escrito a mano.
      const mins = late.lateMin != null ? late.lateMin : 8;
      if (s) s.textContent = `Llegaría ${late.arrival} · presentación ${late.pres} — ${mins} min tarde para ${late.next.split(' · ')[0]}`;
      box.classList.add('show');
    } else box.classList.remove('show');
  }

  // Acciones sobre un carro atrasado. Solo hay operación REAL, así que se quitó
  // la rama que "resolvía" el atraso moviendo números de la demo (llegaba 05:38,
  // reasignaba a Valentina C., llamaba a Daniel Álvarez — todo escrito a mano).
  // Llamar al conductor sí funciona; re-optimizar y reasignar aún no están
  // conectados, y decirlo es mejor que fingir que se hizo algo.
  function resolveOperLate(method) {
    const late = opState.cars.find(c => c.state === 'late');
    if (!late) return;
    if (method === 'call') {
      const tel = (late.driverPhone || '').replace(/\s/g, '');
      if (tel) { window.open('tel:' + tel); opPushFeed('info', `Llamada al conductor de <b>${late.id}</b> (${late.driver}).`); }
      else toast('Ese conductor no tiene teléfono registrado.');
      return;
    }
    toast(method === 'reopt'
      ? 'Re-optimizar en vivo todavía no está conectado.'
      : 'Reasignar una parada en vivo todavía no está conectado.');
  }

  // Se eliminó el intervalo que deslizaba los carros de la demo por su ruta
  // (`mv`): sin operación real no hay nada que mover, y con operación real el
  // carro se queda donde de verdad reportó. El reloj siempre marca hora de
  // Colombia (antes, en demo, corría un contador inventado hacia adelante).
  function startOperTimers() {
    stopOperTimers();
    const clk = setInterval(() => {
      if (state.activeTab !== 'oper') { stopOperTimers(); return; }
      opState.clockT = opNowSec();
      const el = document.getElementById('oper-clock'); if (el) el.textContent = opFmt(opState.clockT);
    }, 1000);
    opState.timers = [clk];

    // Relee la operación real. Se hace SIEMPRE (no solo cuando ya hay carros):
    // así la pantalla se prende sola en cuanto un conductor arranca su ruta.
    opState.timers.push(setInterval(() => {
      if (state.activeTab !== 'oper') { stopOperTimers(); return; }
      loadRealOps();
    }, OP_POLL_MS));
    // Refresca solo las etiquetas de frescura entre polls.
    opState.timers.push(setInterval(() => {
      if (state.activeTab !== 'oper') { stopOperTimers(); return; }
      renderOperCars();
    }, 20000));
  }
  function stopOperTimers() {
    (opState.timers || []).forEach(t => clearInterval(t));
    opState.timers = [];
    opStopRaf();
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

