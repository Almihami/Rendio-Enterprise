// auxiliar.js — Rol Auxiliar (pasajero): "Mis viajes" + pedir traslado.
// Módulo nuevo 2026-07-13. Comparte scope global con los demás (core carga primero).
// Diseño portado de /Visual/ (aux-booking + auxiliar-screens), aterrizado a Rionegro→MDE.
// Decisiones: login correo+contraseña · dirección con pin ajustable · sin propina
// (servicio mensual) · calificación ligera · datos DEMO por ahora (sin escribir a BD).

  // Coord del terminal de pasajeros MDE (misma que el motor de rutas).
  const AUX_MDE = { lat: 6.1715, lng: -75.4270 };

  // Viajes demo (reemplazan lo que vendría de `reservations`).
  const AUX_DEMO_TRIPS = [
    { id: 't1', type: 'sal', flight: 'AV-9412', date: '2026-07-14', time: '05:10',
      address: 'Cra 51 #49-06, Centro, Rionegro', lat: 6.1529, lng: -75.3752,
      isPernocta: false, isReserva: true, notes: '', status: 'assigned',
      driver: { name: 'Carlos Roldán', plate: 'RD-01', rating: 4.9, eta: '04:05' } },
    { id: 't2', type: 'lle', flight: 'AV-9527', date: '2026-07-12', time: '21:10',
      address: 'Calle 43 #55-20, San Nicolás, Rionegro', lat: 6.1473, lng: -75.3778,
      isPernocta: false, isReserva: true, notes: 'Portería, torre 2', status: 'done',
      driver: { name: 'Daniel Álvarez', plate: 'RD-02', rating: 4.8 } },
  ];

  const auxState = {
    profile: null, view: 'home', step: 1, form: {}, trips: [], editingTrip: null,
    map: null, marker: null, geoTimer: null, geoReq: 0, bound: false,
  };

  window.Auxiliar = { init: auxInit };

  function auxInit(profile) {
    auxState.profile = profile;
    auxState.trips = AUX_DEMO_TRIPS.map(t => ({ ...t }));
    auxState.view = 'home';
    auxBindOnce();
    auxRender();
  }

  // ---------- helpers ----------
  const auxRoot = () => document.getElementById('auxiliar-ui');
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
    if (auxState.view === 'form') { root.innerHTML = auxFormHTML(); auxAfterFormRender(); return; }
    if (auxState.view === 'trip') { root.innerHTML = auxTripHTML(); return; }
    root.innerHTML = auxHomeHTML();
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
      done:     { cls: 'muted',label: 'Completado' },
    })[s] || { cls: 'muted', label: s };
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

  // ---------- confirmar → agrega el viaje ----------
  function auxSubmit() {
    const f = auxState.form;
    const trip = {
      id: 't' + (auxState.trips.length + 1) + '_' + f.flight,
      type: f.type, flight: f.flight, date: f.date, time: f.time,
      address: f.address, lat: f.lat, lng: f.lng,
      isPernocta: !!f.isPernocta, isReserva: f.isReserva !== false, notes: f.notes || '',
      status: 'pending', driver: null,
    };
    auxState.trips.unshift(trip);
    auxState.view = 'home'; auxState.step = 1; auxState.form = {};
    auxRender();
    toast('¡Traslado solicitado! Te avisamos cuando asignen conductor.');
  }

  // ---------- detalle del viaje ----------
  function auxTripHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    const m = auxTypeMeta(t.type), st = auxStatusMeta(t.status);
    return `
      <div class="ax-form-head">
        <button class="ax-icbtn" data-ax="home"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>Detalle del viaje</b><span></span>
      </div>
      <div class="ax-body">
        <div class="ax-trip-hero ${m.cls}">
          <span class="ax-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label}</span>
          <div class="ax-status ${st.cls}">${st.label}</div>
        </div>
        <div class="ax-sum">
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Recogen en' : 'Destino'}</span><b>${t.type === 'lle' ? 'MDE' : 'MDE'}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Te dejan en' : 'Te recogen en'}</span><b>${auxShortAddr(t.address)}</b></div>
          <div class="ax-sum-row"><span>Vuelo</span><b>${t.flight}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Aterriza' : 'Presentación'}</span><b>${auxDateES(t.date)} · ${auxHM(t.time)}</b></div>
          ${t.notes ? `<div class="ax-sum-row"><span>Notas</span><b>${t.notes}</b></div>` : ''}
        </div>
        ${t.driver ? `
          <div class="ax-sec">Tu conductor</div>
          <div class="ax-driver">
            <span class="ax-driver-av">${(t.driver.name[0] || 'C')}</span>
            <div><b>${t.driver.name}</b><span>Carro ${t.driver.plate} · ★ ${t.driver.rating}</span></div>
            ${t.driver.eta ? `<span class="ax-eta">recogida<br><b>${t.driver.eta}</b></span>` : ''}
          </div>` : `<div class="ax-hint"><svg class="icon"><use href="#i-clock"/></svg>Aún no asignan conductor. Te avisamos apenas suceda.</div>`}
        <div class="ax-spacer"></div>
      </div>`;
  }

  // ---------- eventos ----------
  function auxBindOnce() {
    if (auxState.bound) return;
    const root = auxRoot(); if (!root) return;
    auxState.bound = true;

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ax]'); if (!el) return;
      const a = el.dataset.ax;
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
      else if (a === 'trip') { auxState.editingTrip = el.dataset.id; auxState.view = 'trip'; auxRender(); }
      else if (a === 'tab') { if (el.dataset.tab !== 'inicio') toast('Sección "' + el.dataset.tab + '" — próximamente.'); }
      else if (a === 'profile') { toast('Perfil — próximamente.'); }
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
