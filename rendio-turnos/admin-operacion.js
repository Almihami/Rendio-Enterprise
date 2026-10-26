// admin-operacion.js — Admin: Operación en vivo — mapa OSM (Leaflet) + OSRM + monitoreo de carros.
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ====================================================================
  // OPERACIÓN EN VIVO — mapa real OSM (Leaflet) + monitoreo de carros.
  // Plan de Rutas: mapa OSM (gratis) + ETAs OSRM (gratis). Tráfico (Google/
  // TomTom) y vuelos (AeroDataBox) quedan STUBBEADOS (requieren API key).
  // Vuelos: la integración vive en 0099 + vuelos-ui.js (RendioVuelos), apagada
  // por defecto; esta pantalla todavía no la pinta.
  // Las posiciones salen de driver_locations (GPS de la app del conductor) y de
  // las anclas por evento (mig 0045). Desde 2026-07-25 NO hay data de ejemplo:
  // sin operación real la pantalla queda vacía y explica qué falta.
  // ====================================================================
  // Rotonda del TERMINAL DE PASAJEROS (acceso occidental) — la coord genérica
  // del aeropuerto ruteaba por la zona de carga/CACOM 5, que es prohibida.
  const OP_MDE = { lat: 6.1715, lng: -75.4270 }; // JMC · terminal de pasajeros
  // idle = con turno pero entre vueltas (o sin iniciar): sin semáforo, porque
  // no hay nada que pueda llegar tarde todavía.
  const OP_COLORS = { ontime: '#16936A', tight: '#C9810F', late: '#D6473B', done: '#9D998F', idle: '#6B7A90' };
  // Color por carro (identidad en el mapa y en la tarjeta), en orden estable.
  const OP_CAR_COLORS = ['#2563A8', '#7C5CD6', '#16936A', '#0EA5E9', '#E2551A', '#8B5CF6'];
  const OP_STLABEL = { ontime: ['A tiempo', 'i-check'], tight: ['Ajustado', 'i-clock'], late: ['Va tarde', 'i-warn'], done: ['Terminó', 'i-check'], idle: ['En espera', 'i-clock'] };
  // Cómo terminó cada vuelta (Api._opResultado), en palabras.
  const OP_VT_TXT = { ok: 'Hecha', bad: 'Con novedad', sinmarcar: 'Sin marcar', curso: 'En curso', falta: 'Pendiente' };
  const OP_VAN_SVG = '<svg viewBox="0 0 24 24"><path d="M3 13V7a1 1 0 0 1 1-1h9l4 4h3a1 1 0 0 1 1 1v2"/><path d="M3 13h19v4H3z"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>';
  // 2026-07-25: se eliminaron OP_DEMO_CARS y OP_DEMO_FEED (4 carros y 5 eventos
  // inventados que se pintaban cuando no había operación real). Servían para
  // enseñar la pantalla antes de que existiera el GPS, pero con la app en
  // pruebas reales mentían: mostraban carros rodando y conductores por nombre
  // que no existían. Ver [feedback-no-inventar-datos]. Sin datos reales la
  // pantalla ahora lo DICE y no pinta nada.
  // open = la tarjeta abierta (su detalle); feedAll = carros con toda su actividad a la vista;
  // vista = la pestaña del teléfono (cars / map / feed), ver opVista.
  const opState = { map: null, routeLayer: null, markerLayer: null, markers: {}, cars: [], feed: [], risks: [], sel: null, open: null, feedAll: {}, vista: 'cars', clockT: 0, timers: [], bound: false, source: 'empty', day: null, loading: false, tweens: {}, raf: null };
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
      // La actividad va POR CARRO (cada tarjeta trae la suya, c.feed); aquí solo
      // quedan las demoras que detectó el vigilante mientras nadie miraba la
      // pantalla (corre en la base cada 5 min, también de madrugada). Van ARRIBA:
      // es lo primero que el jefe tiene que ver al abrir en la mañana.
      opState.feed = data.feed;
      const avisos = [];
      try {
        if (window.Api?.listOpenRouteRisks) {
          const risks = await Api.listOpenRouteRisks();
          risks.slice(0, 8).forEach(r => {
            const hora = (() => { try { return new Date(r.at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } })();
            // El feed se pinta con innerHTML: el nombre viene de la base y va escapado.
            avisos.push({ k: 'warn', t: hora,
              h: `<b>${opEsc(r.aux || '')}</b> — el carro no alcanzaba su recogida por ~${r.minutesLate} min${r.km ? ` (estaba a ${r.km} km)` : ''}.` });
          });
        }
      } catch (_) { /* sin vigilante: no hay avisos que mostrar */ }
      opState.risks = avisos;
      if (first || !opState.cars.some(c => c.id === opState.sel)) opState.sel = opState.cars[0].id;
      // La tarjeta abierta se sigue por su llave (sigue abierta aunque tome la
      // placa al iniciar turno); si desapareció, se cierra.
      if (opState.open && !opState.cars.some(c => c.key === opState.open)) opState.open = null;
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
      // Entre vueltas o sin iniciar turno: sin semáforo (antes salía «A tiempo»
      // un carro que ni había arrancado).
      if (c.enCurso === false) { c.state = 'idle'; c.arrival = '—'; c.etaNext = '—'; c.lateMin = null; continue; }
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
      const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: true }).setView([6.155, -75.39], 12); // Rionegro / Oriente → JMC
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.marker([OP_MDE.lat, OP_MDE.lng], {
        icon: L.divIcon({ className: '', html: `<div class="op-mk-air"><svg viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(map).bindTooltip('Aeropuerto JMC · Rionegro');
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
      m.on('click', () => opAbrir(c.key, true));
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
      // Entre vueltas no hay trayecto que dibujar.
      if (c.state === 'done' || c.state === 'idle' || !c.pos) continue;
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

  // Los nombres, lugares y placas vienen de la base y se pintan con innerHTML.
  const opEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Una tarjeta por CARRO (26-oct-2026): placa, quién lo lleva, qué está
  // haciendo en una frase y una tira con todas sus vueltas del día (verde =
  // hecha, rojo = con novedad, gris = sin marcar). Al tocarla se abre el detalle.
  function opCarCard(c) {
    let [lab, ic] = OP_STLABEL[c.state] || OP_STLABEL.idle;
    // Entre vueltas la píldora dice POR QUÉ espera (y no se repite al lado de la placa).
    const espera = c.state === 'idle' || c.state === 'done';
    if (c.state === 'idle') lab = c.status === 'Sin iniciar turno' ? 'Sin turno' : c.status;
    const aviso = c.state === 'idle' && c.status === 'Sin marcar' ? ' warn' : '';
    const etaCls = c.state === 'late' ? 'late' : c.state === 'tight' ? 'tight' : '';
    const open = c.key === opState.open;
    // En vivo mostramos de dónde salió el punto y qué tan viejo es.
    const fr = opState.source === 'live' && c.turno !== 'sin' ? opFreshness(c) : null;
    const fresh = fr && !c.done ? `<div class="op-cc-fresh ${fr.cls}"><span class="op-cc-freshdot"></span>${fr.txt}</div>` : '';
    const eta = c.enCurso && c.etaNext && c.etaNext !== '—' ? `<span class="eta ${etaCls}" title="Llegada estimada a JMC">${opEsc(c.etaNext)}</span>` : '';
    const r = c.resumen || { hechas: 0, conNovedad: 0, sinMarcar: 0, faltan: 0 };
    const tira = (c.vueltas || []).map(v => `<i class="op-vd ${v.estado}" title="${opEsc(v.hora)} · ${v.type === 'lle' ? 'llegada' : 'salida'} · ${opEsc(OP_VT_TXT[v.estado] || '')}"></i>`).join('');
    const cuenta = [`${r.hechas} de ${(c.vueltas || []).length} hechas`]
      .concat(r.conNovedad ? [`<b class="bad">${r.conNovedad} con novedad</b>`] : [])
      .concat(r.sinMarcar ? [`${r.sinMarcar} sin marcar`] : []).join(' · ');
    return `<div class="op-cc ${c.state} ${c.id === opState.sel ? 'sel' : ''} ${open ? 'open' : ''}" data-car="${opEsc(c.id)}" data-key="${opEsc(c.key)}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="op-cc-top">
        <span class="op-cc-dot" style="background:${c.dc}"><svg class="icon"><use href="#i-van"/></svg></span>
        <span class="op-cc-id">${c.plate ? opEsc(c.plate) : 'Sin placa'}${espera ? '' : `<span>${opEsc(c.status)}</span>`}</span>
        <span class="op-cc-state ${c.state}${aviso}"><svg class="icon"><use href="#${ic}"/></svg>${opEsc(lab)}</span>
      </div>
      <div class="op-cc-body">
        <div class="op-cc-drv"><span class="av" style="background:${c.dc}">${opEsc(opIni(c.driver))}</span><b>${opEsc(c.driver)}</b></div>
        ${c.enCurso ? `<span class="op-cc-pax"><svg class="icon"><use href="#i-users"/></svg>${c.pax}/${c.cap}</span>` : ''}
      </div>
      <div class="op-cc-now"><svg class="icon"><use href="#i-pin"/></svg><span>${opEsc(c.ahora || '')}</span>${eta}</div>
      ${tira ? `<div class="op-cc-strip"><span class="op-vds">${tira}</span><span class="op-cc-cuenta">${cuenta}</span></div>` : ''}
      ${fresh}
      ${open ? opCarDetail(c) : ''}
    </div>`;
  }

  // Una parada en palabras: dónde y qué pasó (sin «a/o»: es un sustantivo).
  function opParadaTxt(p, type) {
    if (p.status === 'delivered') return (p.recogio ? `recogida ${p.recogio} · ` : '') + `entrega ${p.entrego}`;
    if (p.status === 'no_show') return 'no se presentó';
    if (p.status === 'picked_up') return `a bordo · recogida ${p.recogio}`;
    if (p.status === 'arrived') return type === 'lle' ? 'el carro está en el aeropuerto' : 'el carro ya llegó';
    return type === 'lle' ? 'por recoger en el aeropuerto' : (p.cita ? `pendiente · al aeropuerto ${p.cita}` : 'pendiente');
  }

  function opCarDetail(c) {
    // Abiertas persona por persona: la que va, la siguiente y las que dejaron
    // algo por revisar. Las demás en una línea, para que lo de ahora se vea.
    const siguiente = (c.vueltas || []).find(v => v.estado === 'falta');
    const vts = (c.vueltas || []).map(v => {
      const abierta = v.estado === 'curso' || v.estado === 'bad' || v.estado === 'sinmarcar' || v === siguiente;
      const tipo = v.type === 'lle' ? 'Llegada' : 'Salida';
      const otro = v.conductor && v.conductor !== c.driver ? ` · ${opEsc(v.conductor)}` : '';
      let st = OP_VT_TXT[v.estado] || '';
      if (v.estado === 'ok' && v.fin) st = `Hecha ${opEsc(v.fin)}`;
      if (v.estado === 'sinmarcar') st = `Sin marcar · faltan ${v.faltan}`;
      const motivos = v.motivos && v.motivos.length && (v.estado === 'bad' || v.estado === 'sinmarcar' || v.estado === 'curso')
        ? `<div class="op-vt-why">${v.motivos.map(opEsc).join(' · ')}</div>` : '';
      // Cada persona en su línea, con su lugar: nada cortado.
      const ps = abierta
        ? `<ul class="op-vps">${(v.paradas || []).map(p => `<li class="op-vp ${p.status}"><b>${opEsc(p.nombre)}</b><span>${v.type === 'lle' ? 'a ' : 'en '}${opEsc(p.lugar)} · ${opEsc(opParadaTxt(p, v.type))}</span></li>`).join('')}</ul>`
        : `<div class="op-vt-n">${(v.paradas || []).map(p => `${opEsc(p.nombre)} <span>(${opEsc(p.lugar)})</span>`).join(' · ')}</div>`;
      return `<li class="op-vt ${v.estado}${abierta ? ' abierta' : ''}">
        <div class="op-vt-l"><b>${opEsc(v.hora)}</b><span class="op-vt-tipo">${tipo}${otro}</span><span class="op-vt-st">${st}</span></div>
        ${motivos}
        ${ps}
      </li>`;
    }).join('');
    const evs = (c.feed || []).slice(0, 6).map(e => `<li class="${e.k}"><span class="op-evdot"></span><span class="t">${opEsc(e.t)}</span><span>${opEsc(e.h)}</span></li>`).join('');
    const tel = (c.driverPhone || '').replace(/\s/g, '');
    const lectura = c.novedadesLeidas === false ? '<p class="op-det-note">No se pudieron leer los reportes de hoy: el rojo solo cuenta los no-show y las llegadas tarde.</p>' : '';
    // «Ver en el mapa» solo se muestra en el teléfono (CSS): ahí el mapa está en
    // otra pestaña. En pantalla grande está al lado y el carro ya sale marcado.
    const mapa = c.pos && c.state !== 'done' ? `<button class="op-det-call op-det-map" data-op-mapa="${opEsc(c.key)}"><svg class="icon"><use href="#i-pin"/></svg>Ver en el mapa</button>` : '';
    const llamar = tel ? `<button class="op-det-call" data-op-call="${opEsc(c.key)}"><svg class="icon"><use href="#i-phone"/></svg>Llamar a ${opEsc(c.driver.split(/\s+/)[0])}</button>` : '';
    return `<div class="op-cc-det">
      <div class="op-det-h">Vueltas de hoy</div>
      <ol class="op-vts">${vts}</ol>
      ${lectura}
      ${evs ? `<div class="op-det-h">Lo último que marcó</div><ul class="op-det-ev">${evs}</ul>` : ''}
      ${mapa || llamar ? `<div class="op-det-acts">${mapa}${llamar}</div>` : ''}
    </div>`;
  }

  function opAbrir(key, desdeFuera) {
    const c = opState.cars.find(x => x.key === key);
    if (!c) return;
    opState.sel = c.id;
    // Desde el mapa o la actividad se abre; desde la tarjeta, alterna.
    opState.open = desdeFuera ? key : (opState.open === key ? null : key);
    // En el teléfono el mapa y la actividad son otra pestaña: se vuelve a Carros
    // para que se vea la tarjeta que se acaba de abrir.
    if (desdeFuera) opVista('cars');
    renderOperCars(); renderOperMarkers(); renderOperFeed();
    if (desdeFuera) {
      // Arriba de la lista, no «lo más cerca»: abierta mide más que la lista, y
      // con 'nearest' quedaba a la vista el final del detalle y no la placa.
      const el = document.querySelector(`#oper-carlist [data-key="${key}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // Pestañas del teléfono (≤768 px): Carros, Mapa o Actividad, una a la vez. En
  // pantalla grande el atributo no hace nada (las tres columnas están a la vista).
  function opVista(v) {
    opState.vista = v;
    const root = document.getElementById('oper-ui');
    if (!root) return;
    root.dataset.opVista = v;
    root.querySelectorAll('[data-op-tab]').forEach(b => {
      const on = b.dataset.opTab === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // El mapa oculto conserva su tamaño, pero si el teléfono se giró mientras
    // tanto Leaflet tiene que volver a medir (si no, quedan franjas sin cuadros).
    if (v === 'map') setTimeout(() => { try { opState.map && opState.map.invalidateSize(); } catch (e) {} }, 30);
  }

  // Desde el detalle de una tarjeta (teléfono): a la pestaña del mapa, centrado en ese carro.
  function opVerMapa(key) {
    const c = opState.cars.find(x => x.key === key);
    opVista('map');
    if (!c || !c.pos || !opState.map) return;
    try { opState.map.setView(c.pos, Math.max(opState.map.getZoom(), 14)); } catch (e) {}
  }

  function opCall(key) {
    const c = opState.cars.find(x => x.key === key);
    const tel = c ? (c.driverPhone || '').replace(/\s/g, '') : '';
    if (tel) window.open('tel:' + tel);
    else toast('Ese conductor no tiene teléfono registrado.');
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
      const tn0 = document.getElementById('oper-tabN'); if (tn0) tn0.textContent = '';
      const kl0 = document.getElementById('oper-kLate'); if (kl0) kl0.className = 'op-kpi ok';
      return;
    }
    // Repintar con innerHTML no debe mover la lista mientras se lee el detalle.
    const top = list.scrollTop;
    list.innerHTML = opState.cars.map(opCarCard).join('');
    list.scrollTop = top;
    const on = opState.cars.filter(c => c.state === 'ontime').length;
    const risk = opState.cars.filter(c => c.state === 'late' || c.state === 'tight').length;
    const done = opState.cars.filter(c => c.state === 'done').length;
    const set = (id, n) => { const e = document.querySelector(`#${id} b`); if (e) e.textContent = n; };
    set('oper-kOn', on); set('oper-kLate', risk); set('oper-kDone', done);
    const lateN = opState.cars.filter(c => c.state === 'late').length;
    const kl = document.getElementById('oper-kLate'); if (kl) kl.className = 'op-kpi ' + (lateN ? 'bad' : risk ? 'warn' : 'ok');
    const tn = document.getElementById('oper-tabN'); if (tn) tn.textContent = opState.cars.length;
  }

  // La actividad SEPARADA POR CARRO (26-oct-2026): un bloque por placa, en el
  // mismo orden que las tarjetas, con el nombre completo y el lugar. Antes era
  // una sola lista mezclada de 12 eventos con «Sebastian V..» (el apellido
  // abreviado más el punto de la frase).
  const OP_FEED_N = 8;
  function renderOperFeed() {
    const f = document.getElementById('oper-feed');
    if (!f) return;
    const top = f.scrollTop;
    const avisos = (opState.risks || []).length
      ? `<section class="op-fs warn"><div class="op-fs-h"><svg class="icon"><use href="#i-warn"/></svg><b>Avisos del vigilante</b></div>${opState.risks.map(opEvHTML).join('')}</section>` : '';
    const bloques = opState.cars.map(c => {
      const evs = c.feed || [];
      const todos = !!opState.feedAll[c.key];
      const vis = todos ? evs : evs.slice(0, OP_FEED_N);
      const cuerpo = vis.length
        ? vis.map(e => opEvHTML({ k: e.k, t: e.t, h: opEsc(e.h) })).join('')
        : `<div class="op-fs-empty">${c.turno === 'sin' ? 'Todavía no inicia turno.' : 'Sin marcas todavía.'}</div>`;
      const mas = evs.length > OP_FEED_N
        ? `<button class="op-fs-more" data-op-more="${opEsc(c.key)}">${todos ? 'Ver menos' : `Ver ${evs.length - OP_FEED_N} más`}</button>` : '';
      return `<section class="op-fs ${c.key === opState.open || c.id === opState.sel ? 'sel' : ''} ${c.done ? 'done' : ''}">
        <button class="op-fs-h" data-op-fs="${opEsc(c.key)}" title="Ver este carro"><span class="op-fs-dot" style="background:${c.dc}"></span><b>${c.plate ? opEsc(c.plate) : 'Sin placa'}</b><span>${opEsc(c.driver)}</span></button>
        ${cuerpo}${mas}
      </section>`;
    }).join('');
    f.innerHTML = avisos + bloques || `<div class="op-empty sm"><span>Sin eventos. El feed se llena con lo que marcan los conductores en su ruta.</span></div>`;
    f.scrollTop = top;
  }
  function opEvHTML(e) {
    return `<div class="op-ev ${e.k}"><span class="op-evdot"></span><div class="op-evtx"><p>${e.h}</p><div class="op-evt">${e.t}</div></div></div>`;
  }
  // La actividad es la de la base (por carro): lo que hace el jefe en esta
  // pantalla se le confirma con un aviso, no se mezcla con lo que marcan ellos.
  function opPushFeed(k, h) {
    toast(String(h || '').replace(/<[^>]+>/g, ''));
  }

  function syncOperDelay() {
    const late = opState.cars.find(c => c.state === 'late');
    // En el teléfono la alerta vive en la pestaña del mapa: la pestaña lleva un
    // punto rojo para que se note desde Carros o Actividad.
    const tabMapa = document.querySelector('#oper-ui [data-op-tab="map"]');
    if (tabMapa) {
      tabMapa.classList.toggle('alerta', !!late);
      if (late) tabMapa.setAttribute('aria-label', 'Mapa: un carro va tarde'); else tabMapa.removeAttribute('aria-label');
    }
    const box = document.getElementById('oper-delay');
    if (!box) return;
    if (late) {
      // En tierra (0092) no hay vuelo que perder: la hora es la de llegar a su
      // turno. Sin vuelo conocido tampoco se escribe «el vuelo —».
      const t = document.getElementById('oper-delayTitle');
      if (t) {
        t.textContent = late.flight === 'Tierra' ? `${late.id} va tarde (trabajo en tierra)`
          : (late.flight && late.flight !== '—') ? `${late.id} va tarde para el vuelo ${late.flight}`
          : `${late.id} va tarde para la presentación`;
      }
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
    // "Reasignar" ya no es un letrero: pregunta dónde cabe la parada que este
    // carro no alcanza, sobre el plan que está corriendo (bloque D). El motor es
    // el mismo de la bandeja — admin-acomodar.js — no una copia.
    if (method === 'reassign') {
      const rid = late.nextReservationId;
      if (!rid) { toast('Ese carro no tiene una parada pendiente que reacomodar.'); return; }
      acAbrir(rid);
      return;
    }
    // Re-optimizar el día entero sigue SIN conectar, y es a propósito: el solver
    // replanea desde cero (arranca en el depósito a las 01:30) y no sabe qué se
    // atendió ya. A esta hora eso propondría un día que no existe. La pregunta
    // que sí se responde bien es la de UNA parada, que es el botón de al lado.
    toast('Re-optimizar el día entero no está conectado: a esta hora replanearía un día que ya va a medias. Usa "Reasignar" para mover una parada.');
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
      const tab = e.target.closest('[data-op-tab]');
      if (tab) { opVista(tab.dataset.opTab); return; }
      const call = e.target.closest('[data-op-call]');
      if (call) { opCall(call.dataset.opCall); return; }
      const verMapa = e.target.closest('[data-op-mapa]');
      if (verMapa) { opVerMapa(verMapa.dataset.opMapa); return; }
      const more = e.target.closest('[data-op-more]');
      if (more) { const k = more.dataset.opMore; opState.feedAll[k] = !opState.feedAll[k]; renderOperFeed(); return; }
      const fs = e.target.closest('[data-op-fs]');
      if (fs) { opAbrir(fs.dataset.opFs, true); return; }
      // Tocar la tarjeta abre su detalle (qué hace ahora, sus vueltas, su
      // actividad); tocarla otra vez lo cierra. Dentro del detalle no se cierra.
      if (e.target.closest('.op-cc-det')) return;
      const cc = e.target.closest('[data-car]');
      if (cc) { opAbrir(cc.dataset.key, false); return; }
      if (e.target.closest('#oper-delayClose')) { document.getElementById('oper-delay').classList.remove('show'); return; }
      if (e.target.closest('#oper-actReopt')) { resolveOperLate('reopt'); return; }
      if (e.target.closest('#oper-actReassign')) { resolveOperLate('reassign'); return; }
      if (e.target.closest('#oper-actCall')) { resolveOperLate('call'); return; }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cc = e.target.closest && e.target.closest('.op-cc[data-key]');
      if (!cc || e.target !== cc) return;
      e.preventDefault();
      opAbrir(cc.dataset.key, false);
    });
  }

