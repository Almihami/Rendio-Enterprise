// driver-rutas.js — Conductor: Ruta del día + ejecución paso a paso.
// Sección nueva dentro de la app de conductor (aparece tras iniciar turno).
// Decisiones: NO toca el inicio de turno · ve TODAS sus vueltas del día ·
// navega delegando a Waze/Google · comparte ubicación en vivo. DEMO por ahora.

  const DR_MDE = { lat: 6.1715, lng: -75.4270, name: 'Aeropuerto MDE', addr: 'Terminal de pasajeros · José María Córdova' };

  // Vueltas demo del día para ESTE conductor (las genera el motor de rutas).
  // leg.kind: 'pickup' (recoger en casa) | 'airport' (entregar/recoger en MDE) | 'dropoff' (dejar en casa)
  const DR_DEMO_VUELTAS = [
    { id: 'V1', type: 'sal', start: '04:00', done: false, legs: [
      { name: 'Laura G.', addr: 'Cra 51 #49-06, Centro', lat: 6.1529, lng: -75.3752, phone: '+57 310 555 0142', flight: 'AV-9412 · 05:10', dl: '05:10', kind: 'pickup' },
      { name: 'Andrés P.', addr: 'Calle 47 #59-33, El Porvenir', lat: 6.1468, lng: -75.3849, phone: '+57 311 555 0233', flight: 'AV-9412 · 05:10', dl: '05:10', kind: 'pickup' },
      { name: DR_MDE.name, addr: DR_MDE.addr, lat: DR_MDE.lat, lng: DR_MDE.lng, kind: 'airport' },
    ] },
    { id: 'V2', type: 'sal', start: '05:20', done: false, legs: [
      { name: 'Camila R.', addr: 'Cra 62 #42-18, Cuatro Esquinas', lat: 6.1512, lng: -75.3628, phone: '+57 314 555 0481', flight: 'AV-9520 · 06:30', dl: '06:30', kind: 'pickup' },
      { name: 'Melisa V.', addr: 'Cra 55 #44-12, San Nicolás', lat: 6.1470, lng: -75.3781, phone: '+57 312 555 0612', flight: 'AV-9520 · 06:30', dl: '06:30', kind: 'pickup' },
      { name: DR_MDE.name, addr: DR_MDE.addr, lat: DR_MDE.lat, lng: DR_MDE.lng, kind: 'airport' },
    ] },
    { id: 'V3', type: 'lle', start: '10:40', done: false, legs: [
      { name: DR_MDE.name, addr: 'Recoger en MDE · llegadas', lat: DR_MDE.lat, lng: DR_MDE.lng, kind: 'airport' },
      { name: 'Patricia D.', addr: 'Calle 43 #55-20, San Nicolás', lat: 6.1473, lng: -75.3778, phone: '+57 313 555 0777', flight: 'AV-9527', kind: 'dropoff' },
    ] },
  ];

  const drState = {
    vueltas: [], view: 'overview', activeId: null, legIdx: 0, legState: 'en_camino',
    map: null, watchId: null, sharing: false, bound: false,
  };

  window.DriverRutas = { render: drRender, stop: drTeardown };

  function drRender() {
    drState.vueltas = drState.vueltas.length ? drState.vueltas : DR_DEMO_VUELTAS.map(v => ({ ...v, legs: v.legs.map(l => ({ ...l })) }));
    drBindOnce();
    const host = document.querySelector('#driver-tabs-root [data-dtab="ruta"]'); if (!host) return;
    host.innerHTML = drState.view === 'exec' ? drExecHTML() : drOverviewHTML();
    if (drState.view === 'exec') drAfterExec();
  }
  function drTeardown() {
    if (drState.map) { drState.map.remove(); drState.map = null; }
    drStopGps();
  }

  const drTypeMeta = (t) => t === 'lle'
    ? { cls: 'lle', label: 'Llegada', color: '#10B981', ic: 'i-down' }
    : { cls: 'sal', label: 'Salida', color: '#F26522', ic: 'i-up' };
  const drVuelta = () => drState.vueltas.find(v => v.id === drState.activeId);

  // ---------- OVERVIEW: todas las vueltas del día ----------
  function drOverviewHTML() {
    const vs = drState.vueltas;
    const pend = vs.filter(v => !v.done).length;
    const pax = vs.reduce((n, v) => n + v.legs.filter(l => l.kind !== 'airport').length, 0);
    return `
      <div id="driver-ruta-ui">
        <div class="dr-hd">
          <div><h2>Mi ruta de hoy</h2><p>${vs.length} vueltas · ${pax} auxiliares · ${pend} pendientes</p></div>
          <span class="dr-live ${drState.sharing ? 'on' : ''}" id="dr-live-badge"><span class="dot"></span>${drState.sharing ? 'Compartiendo ubicación' : 'Ubicación off'}</span>
        </div>
        ${vs.map(drVueltaCard).join('')}
        <div style="height:80px"></div>
      </div>`;
  }
  function drVueltaCard(v) {
    const m = drTypeMeta(v.type);
    const stops = v.legs.filter(l => l.kind !== 'airport');
    const last = v.legs[v.legs.length - 1];
    const done = v.done;
    return `<button class="dr-vcard ${done ? 'done' : ''}" data-dr="open" data-id="${v.id}">
      <div class="dr-vc-top">
        <span class="dr-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label} · ${v.id}</span>
        <span class="dr-vc-time">sale ${v.start}</span>
      </div>
      <div class="dr-vc-route">${v.type === 'lle' ? 'MDE' : drShort(stops[0]?.addr)} <svg class="icon dr-ar"><use href="#i-arrow"/></svg> ${v.type === 'lle' ? drShort(last.addr) : 'MDE'}</div>
      <div class="dr-vc-bot">
        <span>${stops.length} ${v.type === 'lle' ? 'entregas' : 'recogidas'}</span>
        <span class="dr-vc-cta">${done ? '✓ Completada' : 'Ver ruta →'}</span>
      </div>
    </button>`;
  }
  const drShort = (a) => (a || '').split(',')[0];

  // ---------- EJECUCIÓN: paso a paso ----------
  function drExecHTML() {
    const v = drVuelta(); if (!v) { drState.view = 'overview'; return drOverviewHTML(); }
    const leg = v.legs[drState.legIdx];
    const total = v.legs.length;
    const m = drTypeMeta(v.type);
    const isLast = drState.legIdx === total - 1;
    // acción principal según estado de la parada
    let primary;
    if (drState.legState === 'en_camino') primary = { label: 'Llegué', act: 'arrived', ic: 'i-pin' };
    else if (leg.kind === 'airport') primary = { label: v.type === 'lle' ? 'Auxiliares a bordo' : 'Auxiliares entregados', act: 'next', ic: 'i-check' };
    else if (leg.kind === 'dropoff') primary = { label: `${leg.name.split(' ')[0]} entregado`, act: 'next', ic: 'i-check' };
    else primary = { label: `${leg.name.split(' ')[0]} a bordo`, act: 'next', ic: 'i-check' };
    return `
      <div id="driver-ruta-ui" class="exec">
        <div class="dr-ex-top">
          <button class="dr-icbtn" data-dr="back"><svg class="icon"><use href="#i-back"/></svg></button>
          <div class="dr-ex-progress"><b>${v.id} · ${m.label}</b><span>Parada ${drState.legIdx + 1} de ${total}</span></div>
          <span class="dr-live ${drState.sharing ? 'on' : ''}"><span class="dot"></span></span>
        </div>
        <div id="dr-ex-map" class="dr-ex-map"></div>
        <div class="dr-ex-sheet">
          <div class="dr-ex-kind ${m.cls}">${leg.kind === 'airport' ? '✈ Aeropuerto' : leg.kind === 'dropoff' ? 'Dejar en casa' : 'Recoger'}</div>
          <h2 class="dr-ex-name">${leg.name}</h2>
          <p class="dr-ex-addr">${leg.addr}</p>
          ${leg.flight ? `<div class="dr-ex-meta"><svg class="icon"><use href="#i-plane"/></svg>${leg.flight}${leg.dl ? ' · pres. ' + leg.dl : ''}</div>` : ''}
          <div class="dr-ex-acts">
            <button class="dr-btn ghost" data-dr="nav" data-lat="${leg.lat}" data-lng="${leg.lng}"><svg class="icon"><use href="#i-route"/></svg>Navegar</button>
            ${leg.phone ? `<button class="dr-btn ghost" data-dr="call2" data-phone="${leg.phone}"><svg class="icon"><use href="#i-phone"/></svg>Llamar</button>` : ''}
          </div>
          <button class="dr-btn primary" data-dr="${primary.act}"><svg class="icon"><use href="#${primary.ic}"/></svg>${primary.label}</button>
          ${(drState.legState === 'llegue' && leg.kind === 'pickup') ? `<button class="dr-link" data-dr="noshow">No se presenta</button>` : ''}
        </div>
      </div>`;
  }

  function drAfterExec() {
    const v = drVuelta(); if (!v) return;
    const leg = v.legs[drState.legIdx];
    const el = document.getElementById('dr-ex-map'); if (!el || typeof L === 'undefined' || leg.lat == null) return;
    if (drState.map) { drState.map.remove(); drState.map = null; }
    const map = drState.map = L.map(el, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    map.setView([leg.lat, leg.lng], 15);
    const m = drTypeMeta(v.type);
    L.circleMarker([leg.lat, leg.lng], { radius: 9, color: m.color, fillColor: m.color, fillOpacity: 1, weight: 3 }).addTo(map);
    setTimeout(() => map.invalidateSize(), 60);
  }

  // ---------- GPS en vivo (compartir ubicación) ----------
  function drStartGps() {
    if (drState.sharing || !navigator.geolocation) { drState.sharing = !!navigator.geolocation; return; }
    try {
      drState.watchId = navigator.geolocation.watchPosition(
        (pos) => { drState.sharing = true; drUpdateLiveBadge();
          // TODO(BD): Api.sendDriverLocation(pos.coords) → tabla driver_locations (mig 0003).
        },
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
    document.querySelectorAll('#driver-ruta-ui .dr-live').forEach(b => {
      b.classList.toggle('on', drState.sharing);
      const tx = b.childNodes[b.childNodes.length - 1];
      if (tx && tx.nodeType === 3) tx.textContent = drState.sharing ? 'Compartiendo ubicación' : 'Ubicación off';
    });
  }

  // ---------- eventos ----------
  function drBindOnce() {
    if (drState.bound) return;
    const root = document.querySelector('#driver-tabs-root [data-dtab="ruta"]'); if (!root) return;
    drState.bound = true;
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-dr]'); if (!el) return;
      const a = el.dataset.dr;
      if (a === 'open') {
        drState.activeId = el.dataset.id; drState.legIdx = 0; drState.legState = 'en_camino'; drState.view = 'exec';
        drStartGps(); drRender();
      }
      else if (a === 'back') { drTeardown(); drState.view = 'overview'; drRender(); }
      else if (a === 'nav') {
        const lat = el.dataset.lat, lng = el.dataset.lng;
        // Delega a Waze; si no, Google Maps. Sin navegación propia (gratis).
        window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
      }
      else if (a === 'call2') { window.open('tel:' + el.dataset.phone.replace(/\s/g, '')); }
      else if (a === 'arrived') { drState.legState = 'llegue'; drRender(); }
      else if (a === 'noshow') { toast('Marcado: no se presentó.'); drAdvance(); }
      else if (a === 'next') { drAdvance(); }
    });
  }
  function drAdvance() {
    const v = drVuelta(); if (!v) return;
    if (drState.legIdx < v.legs.length - 1) {
      drState.legIdx++; drState.legState = 'en_camino'; drRender();
    } else {
      v.done = true; drStopGps();
      const nextV = drState.vueltas.find(x => !x.done);
      drState.view = 'overview'; drRender();
      toast(nextV ? `¡Vuelta ${v.id} completa! Tu siguiente vuelta sale ${nextV.start}.` : `¡Vuelta ${v.id} completa! Terminaste tus rutas de hoy. 🎉`);
    }
  }
