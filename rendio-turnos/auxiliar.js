// auxiliar.js — Rol Auxiliar (pasajero): "Mis viajes" + pedir traslado.
// Módulo nuevo 2026-07-13. Comparte scope global con los demás (core carga primero).
// Diseño portado de /Visual/ (aux-booking + auxiliar-screens), aterrizado a Rionegro→MDE.
// Decisiones: login correo+contraseña · dirección con pin ajustable · sin propina
// (servicio mensual) · calificación ligera. Lee/escribe reservas REALES en dev
// (Api.listMyReservations/createReservation); si no hay sesión/BD → fallback DEMO.

  // Coord del terminal de pasajeros MDE (misma que el motor de rutas).
  const AUX_MDE = { lat: 6.1715, lng: -75.4270 };

  // Viajes demo (reemplazan lo que vendría de `reservations`).
  const AUX_DEMO_TRIPS = [
    { id: 't1', type: 'sal', flight: 'AV-9412', date: '2026-07-14', time: '05:10',
      address: 'Cra 51 #49-06, Centro, Rionegro', lat: 6.1529, lng: -75.3752,
      isPernocta: false, isReserva: true, notes: '', status: 'assigned',
      driver: { name: 'Carlos Roldán', plate: 'RD-01', rating: 4.9, eta: '04:05', lat: 6.1725, lng: -75.3560 } },
    { id: 't2', type: 'lle', flight: 'AV-9527', date: '2026-07-12', time: '21:10',
      address: 'Calle 43 #55-20, San Nicolás, Rionegro', lat: 6.1473, lng: -75.3778,
      isPernocta: false, isReserva: true, notes: 'Portería, torre 2', status: 'done',
      driver: { name: 'Daniel Álvarez', plate: 'RD-02', rating: 4.8 } },
  ];

  const auxState = {
    profile: null, view: 'home', step: 1, form: {}, trips: [], editingTrip: null,
    map: null, marker: null, geoTimer: null, geoReq: 0, bound: false,
    trackTimer: null, trackMap: null, ratingSel: 0, ratingTags: [], source: 'demo',
    // Seguimiento EN VIVO (source==='live'): polling del RPC + tween del carro.
    trackPoll: null, trackTween: null, trackCar: null, trackLine: null,
    trackLast: null, trackDestPt: null,
  };

  window.Auxiliar = { init: auxInit };

  async function auxInit(profile) {
    auxState.profile = profile;
    auxState.view = 'home';
    auxBindOnce();
    // Datos REALES desde dev (reservas del auxiliar); si no hay sesión/BD → demo.
    let trips = null;
    try { if (window.Api?.listMyReservations) trips = await Api.listMyReservations(); } catch (e) {}
    auxState.trips = (trips && trips.length !== undefined) ? trips : AUX_DEMO_TRIPS.map(t => ({ ...t }));
    auxState.source = trips ? 'live' : 'demo';
    auxRender();
  }

  // ---------- helpers ----------
  const auxRoot = () => document.getElementById('auxiliar-ui');
  const auxCurTrip = () => auxState.trips.find(x => x.id === auxState.editingTrip);
  const auxFirstName = () => (auxState.profile?.full_name || 'Auxiliar').split(' ')[0];
  function auxTypeMeta(type) {
    return type === 'lle'
      ? { cls: 'a2h', label: 'Llegada', ic: 'i-down', desc: 'Del aeropuerto a casa' }
      : { cls: 'h2a', label: 'Salida', ic: 'i-up', desc: 'De casa al aeropuerto' };
  }
  const auxHM = (t) => t || '--:--';
  function auxDateES(iso) {
    try { return new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (_) { return iso; }
  }
  // Recogida estimada = 1h antes de la presentación (salida) — solo referencia visual.
  function auxSuggestPickup(time) {
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return '--:--';
    let [h, m] = time.split(':').map(Number); h = (h + 23) % 24;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  // ---------- render raíz ----------
  function auxRender() {
    const root = auxRoot(); if (!root) return;
    auxStopTrack(); // limpia animaciones de mapa al cambiar de vista
    if (auxState.view === 'form') { root.innerHTML = auxFormHTML(); auxAfterFormRender(); return; }
    if (auxState.view === 'confirm') { root.innerHTML = auxConfirmHTML(); return; }
    if (auxState.view === 'trip') { root.innerHTML = auxTripHTML(); auxAfterTripRender(); return; }
    root.innerHTML = auxHomeHTML();
    auxSetupPwa();
  }

  // Botones PWA del auxiliar (su UI va aparte del shell admin/conductor, así que el
  // setupPushUI del core NO lo cubre): muestra "Instalar app" si es instalable y
  // "Activar notificaciones" si el push está soportado y aún no se ha suscrito.
  async function auxSetupPwa() {
    const bar = document.getElementById('ax-pwa-bar'); if (!bar) return;
    const ins = bar.querySelector('[data-ax="install"]');
    const psh = bar.querySelector('[data-ax="enable-push"]');
    const canInstall = !!window.rendioInstall; // solo existe si NO está ya instalada (standalone)
    if (ins) ins.classList.toggle('hidden', !canInstall);
    let showPush = false;
    try {
      if (typeof pushSupported === 'function' && pushSupported() && Notification.permission !== 'denied') {
        const reg = await navigator.serviceWorker.ready;
        showPush = !(await reg.pushManager.getSubscription());
      }
    } catch (e) {}
    if (psh) psh.classList.toggle('hidden', !showPush);
    bar.classList.toggle('hidden', !canInstall && !showPush);
  }

  // ---------- HOME (Mis viajes) ----------
  function auxHomeHTML() {
    const upcoming = auxState.trips.filter(t => t.status !== 'done');
    const past = auxState.trips.filter(t => t.status === 'done');
    const next = upcoming[0];
    return `
      <div class="ax-head">
        <div>
          <p class="ax-hi">Hola, ${auxFirstName()} 👋</p>
          <h1>Mis viajes</h1>
        </div>
        <button class="ax-avatar" data-ax="profile" title="Perfil">${(auxFirstName()[0] || 'A').toUpperCase()}</button>
      </div>
      <div class="ax-body">
        <div id="ax-pwa-bar" class="ax-pwa hidden">
          <button class="ax-pwa-btn hidden" data-ax="install">📲 Instalar app</button>
          <button class="ax-pwa-btn hidden" data-ax="enable-push">🔔 Activar notificaciones</button>
        </div>
        ${next ? `<div class="ax-next-label">Próximo viaje</div>${auxTripCard(next, true)}` : `
          <div class="ax-empty">
            <div class="ax-empty-ic"><svg class="icon"><use href="#i-plane"/></svg></div>
            <b>Aún no tienes viajes</b><span>Pide tu traslado y aquí lo verás.</span>
          </div>`}
        ${upcoming.length > 1 ? `<div class="ax-sec">Más próximos</div>${upcoming.slice(1).map(t => auxTripCard(t)).join('')}` : ''}
        ${past.length ? `<div class="ax-sec">Anteriores</div>${past.map(t => auxTripCard(t)).join('')}` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">
        <button class="ax-btn ax-btn-primary" data-ax="new"><svg class="icon"><use href="#i-plus"/></svg>Pedir traslado</button>
      </div>
      ${auxTabsHTML('inicio')}`;
  }

  function auxTripCard(t, hero) {
    const m = auxTypeMeta(t.type);
    const st = auxStatusMeta(t.status);
    return `<button class="ax-trip ${hero ? 'hero' : ''}" data-ax="trip" data-id="${t.id}">
      <div class="ax-trip-top">
        <span class="ax-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label}</span>
        <span class="ax-status ${st.cls}">${st.label}</span>
      </div>
      <div class="ax-trip-mid">
        <div class="ax-trip-route">
          <b>${t.type === 'lle' ? 'MDE' : auxShortAddr(t.address)}</b>
          <svg class="icon ax-arrow"><use href="#i-arrow"/></svg>
          <b>${t.type === 'lle' ? auxShortAddr(t.address) : 'MDE'}</b>
        </div>
      </div>
      <div class="ax-trip-bot">
        <span><svg class="icon"><use href="#i-clock"/></svg>${auxDateES(t.date)} · ${t.type === 'lle' ? 'llega' : 'pres.'} ${auxHM(t.time)}</span>
        <span class="ax-flight">${t.flight}</span>
      </div>
    </button>`;
  }
  function auxShortAddr(a) { return (a || '').split(',')[0]; }
  function auxStatusMeta(s) {
    return ({
      pending:  { cls: 'warn', label: 'Sin rutear' },
      assigned: { cls: 'ok',   label: 'Conductor asignado' },
      onway:    { cls: 'ok',   label: 'En camino' },
      onboard:  { cls: 'ok',   label: 'A bordo' },
      done:     { cls: 'muted',label: 'Completado' },
    })[s] || { cls: 'muted', label: s };
  }
  // Estado crudo de la reserva (BD) → estado simple de la UI. Espejo de
  // api.js/_auxTripStatus; lo usa el rastreo en vivo para avanzar de pantalla.
  const AUX_ORDER = { pending: 0, assigned: 1, onway: 2, onboard: 3, done: 4 };
  function auxUiStatus(raw) {
    if (['assigned', 'driver_assigned', 'ready'].includes(raw)) return 'assigned';
    if (['en_route', 'at_pickup'].includes(raw)) return 'onway';
    if (['on_board', 'picked_up', 'en_route_home'].includes(raw)) return 'onboard';
    if (raw === 'delivered') return 'done';
    return 'pending';
  }

  // ¿El viaje va tarde? SIN ETA de OSRM (decisión de la profa): usamos la regla
  // operativa real (recogida ~1h antes de la presentación en salidas) + el estado
  // real de la parada. Es honesto: mide contra el horario, no inventa un ETA vivo.
  function auxLateness(t, info) {
    if (!t || !['assigned', 'onway'].includes(t.status)) return null; // solo con conductor
    const t0 = new Date(t.date + 'T' + (t.time || '00:00') + ':00-05:00').getTime();
    if (isNaN(t0)) return null;
    if (info && info.stop_status === 'picked_up') return null; // ya lo recogieron
    const now = Date.now(), MIN = 60000;
    if (t.type === 'sal') {
      const pickupBy = t0 - 60 * MIN;                 // recogida ~1h antes de presentación
      if (now > t0)       return { level: 'late', text: 'Vas retrasado para tu presentación.' };
      if (now > pickupBy) return { level: 'late', text: 'El conductor va sobre el tiempo de recogida.' };
      if (now > pickupBy - 15 * MIN) return { level: 'warn', text: 'Vas justo de tiempo — mantente atento.' };
      return { level: 'ok', text: 'Vas a tiempo.' };
    }
    // llegada: ya aterrizaste; el conductor viene a recogerte.
    if (now > t0 + 15 * MIN) return { level: 'warn', text: 'El conductor va en camino a recogerte.' };
    return { level: 'ok', text: 'A tiempo.' };
  }
  function auxLateHTML(t, info) {
    const l = auxLateness(t, info); if (!l) return '';
    return `<div class="ax-late ${l.level}"><svg class="icon"><use href="#${l.level === 'ok' ? 'i-check' : 'i-info'}"/></svg>${l.text}</div>`;
  }
  function auxRefreshLate(t) {
    const el = document.getElementById('ax-late-wrap'); if (el) el.innerHTML = auxLateHTML(t, t._info);
  }

  // ---------- tabs inferiores ----------
  function auxTabsHTML(active) {
    const tab = (id, ic, label) => `<button class="ax-tab ${active === id ? 'on' : ''}" data-ax="tab" data-tab="${id}">
      <svg class="icon"><use href="#${ic}"/></svg><span>${label}</span></button>`;
    return `<nav class="ax-tabs">${tab('inicio', 'i-home', 'Inicio')}${tab('viajes', 'i-list', 'Viajes')}${tab('perfil', 'i-user', 'Perfil')}</nav>`;
  }

  // ---------- FORMULARIO (4 pasos) ----------
  function auxFormHTML() {
    const s = auxState.step;
    const titles = { 1: '¿Qué necesitas?', 2: 'Datos del vuelo', 3: 'Dónde te recogemos', 4: 'Revisa y confirma' };
    const sub = auxState.form.type === 'lle' ? 'Dónde te dejamos' : 'Dónde te recogemos';
    return `
      <div class="ax-form-head">
        <button class="ax-icbtn" data-ax="${s === 1 ? 'cancel' : 'back'}"><svg class="icon"><use href="#${s === 1 ? 'i-x' : 'i-back'}"/></svg></button>
        <div class="ax-steps">${[1, 2, 3, 4].map(n => `<span class="ax-dot ${n <= s ? 'on' : ''}"></span>`).join('')}</div>
        <span class="ax-step-n">${s}/4</span>
      </div>
      <div class="ax-body">
        <h1 class="ax-form-title">${s === 3 ? (auxState.form.type === 'lle' ? 'Dónde te dejamos' : 'Dónde te recogemos') : titles[s]}</h1>
        ${s === 1 ? auxStep1() : s === 2 ? auxStep2() : s === 3 ? auxStep3() : auxStep4()}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">${auxFormCTA()}</div>`;
  }

  function auxStep1() {
    const opt = (type) => {
      const m = auxTypeMeta(type);
      const sel = auxState.form.type === type;
      return `<button class="ax-opt ${m.cls} ${sel ? 'sel' : ''}" data-ax="type" data-type="${type}">
        <span class="ax-opt-ic"><svg class="icon"><use href="#${m.ic}"/></svg></span>
        <div><b>${m.label}</b><span>${type === 'lle' ? 'Vengo aterrizando de un vuelo' : 'Voy al aeropuerto a operar un vuelo'}</span></div>
        <span class="ax-radio">${sel ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
      </button>`;
    };
    return `<p class="ax-lead">Elige el tipo de traslado.</p>${opt('sal')}${opt('lle')}
      <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Si tu vuelo incluye pernocta, lo marcas en el paso de dirección.</div>`;
  }

  function auxStep2() {
    const isLle = auxState.form.type === 'lle';
    const f = auxState.form;
    return `
      ${auxField('Número de vuelo', 'flight', f.flight || '', 'Ej: AV-9412')}
      ${auxField('Fecha del vuelo', 'date', f.date || '', '', 'date')}
      ${auxField(isLle ? 'Hora de aterrizaje' : 'Hora de presentación', 'time', f.time || '', isLle ? '06:18' : '05:10', 'time')}
      ${f.time ? `<div class="ax-hint ok"><svg class="icon"><use href="#i-clock"/></svg>${isLle ? 'Te esperamos al bajar del avión.' : `Recogida estimada <b>${auxSuggestPickup(f.time)}</b> · te dejamos en MDE antes de tu presentación.`}</div>` : ''}`;
  }

  function auxStep3() {
    const f = auxState.form;
    const isLle = f.type === 'lle';
    return `
      ${auxField(isLle ? 'Dirección donde te dejamos' : 'Dirección de recogida', 'address', f.address || '', 'Cra 51 #49-06, Centro')}
      <div class="ax-geo-hint">${isLle ? 'Casa, hotel o donde te quedes.' : 'Casa, hotel o donde estés esa noche.'}</div>
      <div id="ax-map" class="ax-map ${f.address ? '' : 'hidden'}"></div>
      <div id="ax-pin-row" class="ax-pin-row ${f.locConfirmed ? 'ok' : ''} ${f.address ? '' : 'hidden'}">
        ${f.locConfirmed
          ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-ax="pin-edit">Ajustar</button>`
          : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`}
      </div>
      ${!f.locConfirmed && f.address ? `<button class="ax-btn ax-btn-ghost" data-ax="pin-confirm"><svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación</button>` : ''}
      <div class="ax-toggles">
        ${auxToggle('¿Es una pernocta?', 'isPernocta', f.isPernocta, 'Pasas la noche entre vuelos (hotel).')}
        ${auxToggle('¿Es una reserva en firme?', 'isReserva', f.isReserva !== false, 'Confírmanos que el viaje va.')}
      </div>
      ${auxField('Notas para el conductor (opcional)', 'notes', f.notes || '', 'Ej: portería, torre 3', 'textarea')}`;
  }

  function auxStep4() {
    const f = auxState.form;
    const m = auxTypeMeta(f.type);
    const row = (k, v) => `<div class="ax-sum-row"><span>${k}</span><b>${v}</b></div>`;
    return `
      <div class="ax-sum">
        <div class="ax-sum-head ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label} · ${m.desc}</div>
        ${row('Vuelo', f.flight || '—')}
        ${row('Fecha', f.date ? auxDateES(f.date) : '—')}
        ${row(f.type === 'lle' ? 'Aterriza' : 'Presentación', auxHM(f.time))}
        ${row('Dirección', auxShortAddr(f.address))}
        ${f.isPernocta ? row('Pernocta', 'Sí (hotel)') : ''}
        ${f.notes ? row('Notas', f.notes) : ''}
      </div>
      <div class="ax-hint ok"><svg class="icon"><use href="#i-info"/></svg>Al confirmar, tu traslado entra a la planeación del día. Te avisamos cuando asignen conductor.</div>`;
  }

  function auxFormCTA() {
    const s = auxState.step, f = auxState.form;
    const disabled = (s === 1 && !f.type) || (s === 2 && (!f.flight || !f.date || !f.time)) || (s === 3 && (!f.address || !f.locConfirmed));
    const label = s < 4 ? 'Continuar' : 'Confirmar traslado';
    return `<button class="ax-btn ax-btn-primary" data-ax="next" ${disabled ? 'disabled' : ''}>${label}${s < 4 ? '<svg class="icon"><use href="#i-arrow"/></svg>' : ''}</button>`;
  }

  // ---------- campos ----------
  function auxField(label, key, value, ph, type) {
    const input = type === 'textarea'
      ? `<textarea class="ax-input" data-field="${key}" rows="2" placeholder="${ph || ''}">${value}</textarea>`
      : `<input class="ax-input" data-field="${key}" type="${type || 'text'}" value="${value}" placeholder="${ph || ''}" />`;
    return `<label class="ax-label">${label}${input}</label>`;
  }
  function auxToggle(label, key, on, hint) {
    return `<button class="ax-toggle ${on ? 'on' : ''}" data-ax="toggle" data-key="${key}">
      <div><b>${label}</b><span>${hint}</span></div>
      <span class="ax-switch"><span class="ax-knob"></span></span>
    </button>`;
  }

  // ---------- mapa + geocodificación (pin ajustable REAL) ----------
  function auxAfterFormRender() {
    if (auxState.step !== 3) return;
    const f = auxState.form;
    if (f.address && f.lat != null) auxMountMap(f.lat, f.lng);
  }
  function auxMountMap(lat, lng) {
    const el = document.getElementById('ax-map'); if (!el || typeof L === 'undefined') return;
    el.classList.remove('hidden');
    if (auxState.map) { auxState.map.remove(); auxState.map = null; }
    const map = auxState.map = L.map(el, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    map.setView([lat, lng], 16);
    const marker = auxState.marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      auxState.form.lat = p.lat; auxState.form.lng = p.lng;
      auxState.form.locConfirmed = false; // movió el pin → hay que reconfirmar
      auxRefreshPinRow();
    });
    setTimeout(() => map.invalidateSize(), 60);
  }
  function auxRefreshPinRow() {
    // Re-render liviano del paso 3 sin remontar el mapa.
    const cta = auxRoot().querySelector('.ax-cta-bar'); if (cta) cta.innerHTML = auxFormCTA();
    const row = document.getElementById('ax-pin-row'); if (!row) return;
    const f = auxState.form;
    row.className = 'ax-pin-row ' + (f.locConfirmed ? 'ok' : '');
    row.innerHTML = f.locConfirmed
      ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-ax="pin-edit">Ajustar</button>`
      : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`;
    // botón confirmar (aparece solo si falta)
    let btn = auxRoot().querySelector('[data-ax="pin-confirm"]');
    if (!f.locConfirmed && !btn) {
      const b = document.createElement('button');
      b.className = 'ax-btn ax-btn-ghost'; b.setAttribute('data-ax', 'pin-confirm');
      b.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación';
      row.after(b);
    } else if (f.locConfirmed && btn) { btn.remove(); }
  }
  async function auxGeocode(q) {
    const my = ++auxState.geoReq;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q=${encodeURIComponent(q + ', Rionegro, Antioquia')}`;
      const r = await (await fetch(url, { headers: { 'Accept-Language': 'es' } })).json();
      if (my !== auxState.geoReq) return; // llegó una búsqueda más nueva
      if (r && r[0]) {
        auxState.form.lat = parseFloat(r[0].lat); auxState.form.lng = parseFloat(r[0].lon);
      } else {
        // sin resultado: cae al centro de Rionegro para que igual pueda mover el pin
        auxState.form.lat = 6.1537; auxState.form.lng = -75.3738;
        toast('No ubicamos la dirección exacta — mueve el pin al punto correcto.');
      }
      auxState.form.locConfirmed = false;
      auxMountMap(auxState.form.lat, auxState.form.lng);
      auxRefreshPinRow();
    } catch (e) { /* silencioso: el usuario puede reintentar */ }
  }

  // ---------- confirmar → crea la reserva (BD real o demo) → confirmación ----------
  async function auxSubmit() {
    const f = auxState.form;
    const trip = {
      id: 't' + Date.now(),
      type: f.type, flight: f.flight, date: f.date, time: f.time,
      address: f.address, lat: f.lat, lng: f.lng,
      isPernocta: !!f.isPernocta, isReserva: f.isReserva !== false, notes: f.notes || '',
      status: 'pending', driver: null, rated: false,
    };
    // Persistir en dev si hay sesión real; si falla, sigue como demo local.
    if (auxState.source === 'live' && window.Api?.createReservation) {
      try { trip.id = await Api.createReservation(f); }
      catch (e) { toast('No se pudo guardar en el servidor; queda local.'); }
    } else {
      setTimeout(() => auxDemoAssign(trip.id), 6000); // demo: asigna solo
    }
    auxState.trips.unshift(trip);
    auxState.step = 1; auxState.form = {};
    auxState.editingTrip = trip.id; auxState.view = 'confirm';
    auxRender();
  }
  // DEMO: asigna un conductor y avisa (sustituye al push real "conductor asignado").
  function auxDemoAssign(tripId) {
    const t = auxState.trips.find(x => x.id === tripId); if (!t || t.status !== 'pending') return;
    t.status = 'assigned';
    t.driver = { name: 'Carlos Roldán', plate: 'RD-01', rating: 4.9, eta: auxSuggestPickup(t.time),
      lat: t.lat + 0.022, lng: t.lng - 0.018 }; // arranca a ~2.5 km
    toast('🚗 ¡Te asignamos conductor! Carlos Roldán · RD-01');
    if (auxState.view === 'home' || (auxState.view === 'trip' && auxState.editingTrip === tripId)) auxRender();
  }

  // ---------- P1: confirmación (justo tras reservar) ----------
  function auxConfirmHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    const m = auxTypeMeta(t.type);
    const timeline = [
      { t: 'Ahora', label: 'Traslado solicitado', done: true },
      { t: 'En minutos', label: 'Asignamos tu conductor', done: false },
      { t: t.type === 'lle' ? auxHM(t.time) : auxSuggestPickup(t.time), label: t.type === 'lle' ? 'Recogida en el aeropuerto' : 'Recogida en tu dirección', done: false },
    ];
    return `
      <div class="ax-body ax-center">
        <div class="ax-success"><svg class="icon"><use href="#i-check"/></svg></div>
        <h1 class="ax-big">¡Traslado confirmado!</h1>
        <p class="ax-lead ax-tc">Tu ${m.label.toLowerCase()} quedó en la planeación del día. Te avisaremos cuando asignen conductor.</p>
        <div class="ax-timeline">
          ${timeline.map(x => `<div class="ax-tl-row ${x.done ? 'done' : ''}"><span class="ax-tl-dot"></span><div><b>${x.label}</b><span>${x.t}</span></div></div>`).join('')}
        </div>
      </div>
      <div class="ax-cta-bar"><button class="ax-btn ax-btn-primary" data-ax="home">Ver mis viajes</button></div>`;
  }

  // ---------- detalle / seguimiento del viaje (despacha por estado) ----------
  function auxTripHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    if (t.status === 'onway') return auxTrackOnWay(t);   // P3
    if (t.status === 'onboard') return auxTrackOnBoard(t); // P4
    if (t.status === 'done' && !t.rated) return auxRating(t); // P5
    return auxTripDetail(t); // pending / assigned (P2) / done ya calificado
  }

  function auxTripHead(title) {
    return `<div class="ax-form-head"><button class="ax-icbtn" data-ax="home"><svg class="icon"><use href="#i-back"/></svg></button><b>${title}</b><span></span></div>`;
  }
  function auxDriverCard(d, showEta) {
    d = d || {};
    const meta = 'Carro ' + (d.plate || '—') + (d.rating ? ' · ★ ' + d.rating : '');
    return `<div class="ax-driver">
      <span class="ax-driver-av">${(d.name || 'C')[0]}</span>
      <div><b>${d.name || 'Tu conductor'}</b><span>${meta}</span></div>
      <div class="ax-driver-acts">
        <button class="ax-icbtn sm" data-ax="call" title="Llamar"><svg class="icon"><use href="#i-phone"/></svg></button>
        ${showEta && d.eta ? `<span class="ax-eta">recogida<br><b>${d.eta}</b></span>` : ''}
      </div>
    </div>`;
  }

  // P2 (assigned) + pending + done-ya-calificado
  function auxTripDetail(t) {
    const m = auxTypeMeta(t.type), st = auxStatusMeta(t.status);
    return `
      ${auxTripHead('Tu viaje')}
      <div class="ax-body">
        <div class="ax-trip-hero ${m.cls}">
          <span class="ax-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label}</span>
          <div class="ax-status ${st.cls}">${st.label}</div>
        </div>
        <div id="ax-late-wrap">${auxLateHTML(t, t._info)}</div>
        <div class="ax-sum">
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Te recogen en' : 'Te recogen en'}</span><b>${t.type === 'lle' ? 'MDE' : auxShortAddr(t.address)}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Te dejan en' : 'Destino'}</span><b>${t.type === 'lle' ? auxShortAddr(t.address) : 'MDE'}</b></div>
          <div class="ax-sum-row"><span>Vuelo</span><b>${t.flight}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Aterriza' : 'Presentación'}</span><b>${auxDateES(t.date)} · ${auxHM(t.time)}</b></div>
          ${t.notes ? `<div class="ax-sum-row"><span>Notas</span><b>${t.notes}</b></div>` : ''}
        </div>
        ${t.driver ? `<div class="ax-sec">Tu conductor</div>${auxDriverCard(t.driver, true)}
          <div class="ax-hint ok"><svg class="icon"><use href="#i-info"/></svg>Te avisaremos cuando ${t.driver.name.split(' ')[0]} esté en camino. No tienes que estar pendiente.</div>`
        : t.status === 'done'
          ? `<div class="ax-hint ok"><svg class="icon"><use href="#i-check"/></svg>Viaje completado. ¡Gracias por viajar con Rendio!</div>`
          : `<div class="ax-hint"><svg class="icon"><use href="#i-clock"/></svg>Buscando conductor… te avisamos apenas asignen.</div>`}
        <div class="ax-spacer"></div>
      </div>
      ${t.status === 'assigned' ? `<div class="ax-cta-bar"><button class="ax-btn ax-btn-primary" data-ax="confirm-pickup"><svg class="icon"><use href="#i-check"/></svg>Confirmar mi recogida</button></div>` : ''}`;
  }

  // P3: conductor en camino — mapa en vivo
  function auxTrackOnWay(t) {
    return `
      ${auxTripHead('Conductor en camino')}
      <div id="ax-track-map" class="ax-track-map"></div>
      <div class="ax-track-sheet">
        <div class="ax-eta-hero"><span id="ax-eta-label">Llega en</span><b id="ax-eta-min">— min</b></div>
        <div id="ax-late-wrap">${auxLateHTML(t, t._info)}</div>
        ${auxDriverCard(t.driver, false)}
        <div class="ax-track-fresh" id="ax-track-fresh"></div>
        <button class="ax-btn ax-btn-ghost" data-ax="share-eta"><svg class="icon"><use href="#i-send"/></svg>Compartir mi ETA</button>
      </div>`;
  }
  // P4: a bordo, camino al aeropuerto (o a casa si es llegada)
  function auxTrackOnBoard(t) {
    const dest = t.type === 'lle' ? auxShortAddr(t.address) : 'Aeropuerto MDE';
    return `
      ${auxTripHead('A bordo')}
      <div id="ax-track-map" class="ax-track-map"></div>
      <div class="ax-track-sheet">
        <div class="ax-onboard-badge"><svg class="icon"><use href="#i-check"/></svg>En camino a ${dest}</div>
        <div class="ax-eta-hero"><span id="ax-eta-label">Llegada estimada</span><b id="ax-eta-min">— min</b></div>
        ${auxDriverCard(t.driver, false)}
        <div class="ax-track-fresh" id="ax-track-fresh"></div>
      </div>`;
  }
  // P5: calificación (sin propina — servicio mensual)
  function auxRating(t) {
    const r = auxState.ratingSel || 0;
    const goodTags = ['Puntual', 'Carro limpio', 'Conducción suave', 'Amable'];
    const badTags = ['Llegó tarde', 'Carro sucio', 'Conducción brusca', 'Otro'];
    const tags = r >= 4 ? goodTags : r > 0 ? badTags : [];
    return `
      ${auxTripHead('Califica tu viaje')}
      <div class="ax-body ax-center">
        <div class="ax-driver-av lg">${t.driver.name[0] || 'C'}</div>
        <h1 class="ax-big">¿Cómo estuvo con ${t.driver.name.split(' ')[0]}?</h1>
        <p class="ax-lead ax-tc">Tu opinión ayuda a mejorar el servicio. Es opcional.</p>
        <div class="ax-stars">
          ${[1, 2, 3, 4, 5].map(n => `<button class="ax-star ${n <= r ? 'on' : ''}" data-ax="star" data-n="${n}"><svg class="icon"><use href="#i-check"/></svg>★</button>`).join('')}
        </div>
        ${r > 0 ? `<div class="ax-tags">${tags.map(t => `<button class="ax-tag ${(auxState.ratingTags || []).includes(t) ? 'on' : ''}" data-ax="tag" data-tag="${t}">${t}</button>`).join('')}</div>` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">
        <button class="ax-btn ax-btn-primary" data-ax="rate-send" ${r === 0 ? 'disabled' : ''}>${r === 0 ? 'Toca una estrella' : 'Enviar calificación'}</button>
        <button class="ax-link ax-skip" data-ax="rate-skip">Ahora no</button>
      </div>`;
  }

  // ---------- seguimiento del viaje ----------
  // En vivo (source==='live') → posición REAL del conductor vía RPC.
  // Demo (presentaciones)      → la animación de siempre.
  function auxAfterTripRender() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) return;
    if (auxState.source === 'live') {
      // Desde 'pending' ya seguimos: la pantalla avanza sola cuando el admin
      // publica el plan (→ conductor) y cuando el conductor arranca (→ mapa).
      if (['pending', 'assigned', 'onway', 'onboard'].includes(t.status)) auxStartLiveTrack(t);
      return;
    }
    if (t.status === 'onway') auxRunTrack(t, t.driver, { lat: t.lat, lng: t.lng }, 'pickup');
    if (t.status === 'onboard') auxRunTrack(t, { lat: t.lat, lng: t.lng }, AUX_MDE, 'airport');
  }
  function auxStopTrack() {
    if (auxState.trackTimer) { clearInterval(auxState.trackTimer); auxState.trackTimer = null; }
    if (auxState.trackPoll) { clearInterval(auxState.trackPoll); auxState.trackPoll = null; }
    if (auxState.trackTween) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    if (auxState.trackMap) { auxState.trackMap.remove(); auxState.trackMap = null; }
    auxState.trackCar = null; auxState.trackLine = null; auxState.trackLast = null; auxState.trackDestPt = null;
  }

  // ---------- seguimiento EN VIVO (datos reales) ----------
  // A dónde va el carro en esta fase (para pintar el punto destino y la línea):
  //   sal onway    → a tu dirección · sal onboard   → a MDE
  //   lle onway    → a MDE (te recoge) · lle onboard → a tu dirección
  function auxTrackDest(t) {
    if (t.type === 'lle') return t.status === 'onboard' ? { lat: t.lat, lng: t.lng } : AUX_MDE;
    return t.status === 'onboard' ? AUX_MDE : { lat: t.lat, lng: t.lng };
  }
  function auxDistM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Frescura del punto: no le creemos ciegamente a un GPS viejo.
  function auxFreshLabel(pos) {
    if (!pos || pos.at == null) return { text: 'Esperando señal del conductor…', stale: true };
    const secs = Math.max(0, Math.round((Date.now() - new Date(pos.at).getTime()) / 1000));
    const ago = secs < 10 ? 'ahora' : secs < 60 ? `hace ${secs} s` : `hace ${Math.round(secs / 60)} min`;
    const src = pos.source === 'anchor' ? 'última parada' : 'GPS';
    return { text: `${src} · ${ago}`, stale: secs > 120 };
  }

  function auxStartLiveTrack(t) {
    auxState.trackLast = null;
    auxTrackTick(t);                                       // primer tick inmediato
    auxState.trackPoll = setInterval(() => auxTrackTick(t), 6000);
  }
  async function auxTrackTick(t) {
    if (auxState.view !== 'trip' || auxState.editingTrip !== t.id) return;
    let info = null;
    try { if (window.Api?.trackReservation) info = await Api.trackReservation(t.id); } catch (_) {}
    // El await pudo tardar: si el usuario cambió de vista/viaje, abortamos.
    if (auxState.view !== 'trip' || auxState.editingTrip !== t.id) return;
    if (!info) return;
    t._info = info;                                   // para el banner "va tarde"

    // ¿Recién llega el dato del conductor? Al recargar la app ya "en camino", la
    // tarjeta se pintó genérica ("Tu conductor / Carro —") antes de este primer
    // dato; hay que re-hidratarla aunque el estado no cambie.
    let driverJustArrived = false;
    if (info.driver && info.driver.name) {
      driverJustArrived = !(t.driver && t.driver.name);
      t.driver = { name: info.driver.name, plate: info.plate || '—', phone: info.driver.phone || '', rating: null };
    }
    // Avance real → estado UI. 'assigned' lo marca info.assigned (la reserva quedó
    // en una ruta con conductor), aunque el estado crudo siga en 'scheduled'/
    // 'requested'. El estado crudo solo AGREGA progresión (en camino/a bordo/entregado).
    let ui;
    if (info.assigned) {
      const prog = auxUiStatus(info.raw_status);
      ui = AUX_ORDER[prog] > AUX_ORDER.assigned ? prog : 'assigned';
    } else {
      ui = auxUiStatus(info.raw_status);
    }
    // Solo AVANZA (nunca retrocede), para no dar tumbos de pantalla.
    if (AUX_ORDER[ui] > (AUX_ORDER[t.status] || 0)) {
      t.status = ui;
      auxRender();          // cambia de pantalla; el nuevo render re-arranca el rastreo
      return;
    }
    auxRefreshLate(t);      // banner "va tarde" (assigned/onway)
    // Hidrata la tarjeta del conductor la 1ª vez que llega su dato, en CUALQUIER
    // pantalla que la muestre (asignado/en camino/a bordo), no solo al cambiar de
    // estado — arregla el caso de recargar la app con el viaje ya en curso.
    if (driverJustArrived && ['assigned', 'onway', 'onboard'].includes(t.status)) {
      auxRender();
      return;
    }
    if (t.status === 'onway' || t.status === 'onboard') {
      auxPlotDriver(t, info);
    }
  }

  // Pinta el mapa: destino fijo + carro que se desliza ENTRE dos reportes reales.
  // No extrapola: al llegar al último punto conocido, se queda quieto.
  function auxPlotDriver(t, info) {
    auxUpdateTrackHUD(t, info);
    const el = document.getElementById('ax-track-map');
    if (!el || typeof L === 'undefined') return;
    const d = auxTrackDest(t);
    const destPt = [d.lat, d.lng];
    const driverPt = info.pos ? [info.pos.lat, info.pos.lng] : null;

    // Primer montaje de esta fase.
    if (!auxState.trackMap) {
      const map = auxState.trackMap = L.map(el, { zoomControl: false, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      auxState.trackDestPt = destPt;
      L.circleMarker(destPt, { radius: 8, color: '#F26522', fillColor: '#F26522', fillOpacity: 1, weight: 3 }).addTo(map);
      if (driverPt) { auxMountCar(driverPt, destPt); map.fitBounds([driverPt, destPt], { padding: [55, 55] }); }
      else { map.setView(destPt, 14); }
      setTimeout(() => map.invalidateSize(), 60);
      return;
    }
    if (!driverPt) return;                                 // aún sin ping: dejamos el destino
    if (!auxState.trackCar) {                              // el carro apareció tras el montaje
      auxMountCar(driverPt, destPt);
      auxState.trackMap.fitBounds([driverPt, destPt], { padding: [55, 55] });
      return;
    }
    const last = auxState.trackLast;
    if (last && auxDistM(last, driverPt) > 2000) {
      // Salto grande (señal perdida): no inventamos el trayecto — saltamos.
      auxState.trackCar.setLatLng(driverPt);
      if (auxState.trackLine) auxState.trackLine.setLatLngs([driverPt, auxState.trackDestPt]);
    } else if (!last || auxDistM(last, driverPt) > 3) {
      auxTweenCar(last || driverPt, driverPt);
    }
    auxState.trackLast = driverPt;
  }
  function auxMountCar(driverPt, destPt) {
    const carIcon = L.divIcon({ className: '', html: '<div class="ax-car">🚗</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
    auxState.trackLine = L.polyline([driverPt, destPt], { color: '#F4791F', weight: 4, opacity: .5, dashArray: '6 8' }).addTo(auxState.trackMap);
    auxState.trackCar = L.marker(driverPt, { icon: carIcon }).addTo(auxState.trackMap);
    auxState.trackLast = driverPt;
  }
  function auxTweenCar(from, to) {
    if (auxState.trackTween) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    const car = auxState.trackCar, line = auxState.trackLine, dest = auxState.trackDestPt;
    if (!car) return;
    const A = from, B = to, START = Date.now(), DUR = 1400;
    auxState.trackTween = setInterval(() => {
      const k = Math.min(1, (Date.now() - START) / DUR);
      const lat = A[0] + (B[0] - A[0]) * k, lng = A[1] + (B[1] - A[1]) * k;
      car.setLatLng([lat, lng]);
      if (line && dest) line.setLatLngs([[lat, lng], dest]);
      if (k >= 1) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    }, 60);
  }
  // Textos honestos (sin ETA inventado): estado + frescura del punto.
  function auxUpdateTrackHUD(t, info) {
    const arrived = info.stop_status === 'arrived';
    const labelEl = document.getElementById('ax-eta-label');
    const valEl = document.getElementById('ax-eta-min');
    const freshEl = document.getElementById('ax-track-fresh');
    if (labelEl && valEl) {
      if (t.status === 'onway') {
        labelEl.textContent = 'Tu conductor';
        valEl.textContent = arrived ? '¡Llegó!' : 'En camino';
      } else {
        labelEl.textContent = t.type === 'lle' ? 'Vas a casa' : 'Vas al aeropuerto';
        valEl.textContent = 'En ruta';
      }
    }
    if (freshEl) {
      const f = auxFreshLabel(info.pos);
      freshEl.textContent = (arrived ? 'Te espera máx. 3 min · ' : '') + f.text;
      freshEl.classList.toggle('stale', !!f.stale);
    }
  }
  function auxRunTrack(t, from, to, phase) {
    const el = document.getElementById('ax-track-map'); if (!el || typeof L === 'undefined') return;
    // Blindaje: sin coords válidas no animamos (evita crash de Leaflet).
    if (!from || from.lat == null || !to || to.lat == null) {
      const etaEl = document.getElementById('ax-eta-min'); if (etaEl) etaEl.textContent = 'en camino';
      return;
    }
    const map = auxState.trackMap = L.map(el, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    const A = [from.lat, from.lng], B = [to.lat, to.lng];
    map.fitBounds([A, B], { padding: [50, 50] });
    L.circleMarker(B, { radius: 8, color: '#F26522', fillColor: '#F26522', fillOpacity: 1, weight: 3 }).addTo(map);
    const line = L.polyline([A, B], { color: '#F4791F', weight: 4, opacity: .5, dashArray: '6 8' }).addTo(map);
    const carIcon = L.divIcon({ className: '', html: '<div class="ax-car">🚗</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
    const car = L.marker(A, { icon: carIcon }).addTo(map);
    setTimeout(() => map.invalidateSize(), 60);
    // interpola A→B en ~9s, actualiza ETA, y al llegar avanza de fase
    const TOTAL = 9000, START = Date.now();
    auxState.trackTimer = setInterval(() => {
      const k = Math.min(1, (Date.now() - START) / TOTAL);
      const lat = A[0] + (B[0] - A[0]) * k, lng = A[1] + (B[1] - A[1]) * k;
      car.setLatLng([lat, lng]);
      line.setLatLngs([[lat, lng], B]);
      const etaEl = document.getElementById('ax-eta-min');
      if (etaEl) etaEl.textContent = k >= 1 ? '¡Llegó!' : Math.max(1, Math.round((1 - k) * (phase === 'airport' ? 18 : 6))) + ' min';
      if (k >= 1) {
        clearInterval(auxState.trackTimer); auxState.trackTimer = null;
        setTimeout(() => auxTrackArrived(t, phase), 900);
      }
    }, 300);
  }
  function auxTrackArrived(t, phase) {
    if (auxState.view !== 'trip' || auxState.editingTrip !== t.id) return;
    if (phase === 'pickup') { t.status = 'onboard'; toast('Tu conductor llegó. ¡Buen viaje!'); auxRender(); }
    else { t.status = 'done'; auxRender(); } // llegó al destino → calificar
  }

  // ---------- eventos ----------
  function auxBindOnce() {
    if (auxState.bound) return;
    const root = auxRoot(); if (!root) return;
    auxState.bound = true;

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ax]'); if (!el) return;
      const a = el.dataset.ax;
      if (a === 'install') { if (window.rendioInstall) window.rendioInstall.prompt(); return; }
      if (a === 'enable-push') { if (typeof enablePush === 'function') Promise.resolve(enablePush()).then(() => auxSetupPwa()); return; }
      if (a === 'new') { auxState.view = 'form'; auxState.step = 1; auxState.form = { isReserva: true }; auxRender(); }
      else if (a === 'cancel' || a === 'home') { auxState.view = 'home'; auxState.step = 1; auxState.form = {}; auxRender(); }
      else if (a === 'back') { auxState.step = Math.max(1, auxState.step - 1); auxRender(); }
      else if (a === 'next') {
        if (el.hasAttribute('disabled')) return;
        if (auxState.step < 4) { auxState.step++; auxRender(); } else auxSubmit();
      }
      else if (a === 'type') { auxState.form.type = el.dataset.type; auxRender(); }
      else if (a === 'toggle') { const k = el.dataset.key; auxState.form[k] = !auxState.form[k]; auxRender(); }
      else if (a === 'pin-confirm') { auxState.form.locConfirmed = true; auxRefreshPinRow(); toast('Ubicación confirmada.'); }
      else if (a === 'pin-edit') { auxState.form.locConfirmed = false; auxRefreshPinRow(); }
      else if (a === 'trip') { auxState.editingTrip = el.dataset.id; auxState.view = 'trip'; auxState.ratingSel = 0; auxState.ratingTags = []; auxRender(); }
      else if (a === 'tab') { if (el.dataset.tab !== 'inicio') toast('Sección "' + el.dataset.tab + '" — próximamente.'); }
      else if (a === 'profile') { toast('Perfil — próximamente.'); }
      // --- seguimiento del viaje ---
      else if (a === 'confirm-pickup') { const t = auxCurTrip(); if (t) { t.status = 'onway'; auxRender(); } }
      else if (a === 'call') {
        const ph = auxCurTrip()?.driver?.phone;
        if (ph) { try { window.location.href = 'tel:' + ph.replace(/[^\d+]/g, ''); } catch (_) {} }
        else toast('Aún no hay teléfono del conductor.');
      }
      else if (a === 'share-eta') { toast('Enlace de seguimiento copiado para compartir.'); }
      // --- calificación ---
      else if (a === 'star') { auxState.ratingSel = Number(el.dataset.n); auxState.ratingTags = []; auxRender(); }
      else if (a === 'tag') { const tg = el.dataset.tag; const s = new Set(auxState.ratingTags); s.has(tg) ? s.delete(tg) : s.add(tg); auxState.ratingTags = [...s]; auxRender(); }
      else if (a === 'rate-send') {
        if (el.hasAttribute('disabled')) return;
        const t = auxCurTrip();
        if (t) { t.rated = true; t.rating = auxState.ratingSel; }
        // Persiste en dev (optimista); en demo se queda local.
        if (auxState.source === 'live' && t && window.Api?.rateReservation) {
          Api.rateReservation(t.id, auxState.ratingSel, auxState.ratingTags)
            .catch(() => toast('No se pudo guardar la calificación en el servidor.'));
        }
        toast('¡Gracias por tu calificación!'); auxState.view = 'home'; auxRender();
      }
      else if (a === 'rate-skip') { const t = auxCurTrip(); if (t) t.rated = true; auxState.view = 'home'; auxRender(); }
    });

    root.addEventListener('input', (e) => {
      const el = e.target.closest('[data-field]'); if (!el) return;
      const k = el.dataset.field;
      auxState.form[k] = el.value;
      if (k === 'address') {
        auxState.form.locConfirmed = false;
        clearTimeout(auxState.geoTimer);
        const q = el.value.trim();
        if (q.length >= 6) auxState.geoTimer = setTimeout(() => auxGeocode(q), 700);
      }
      // habilita/inhabilita el CTA sin remontar (no perder foco del input)
      const cta = auxRoot().querySelector('.ax-cta-bar'); if (cta) cta.innerHTML = auxFormCTA();
    });
  }
