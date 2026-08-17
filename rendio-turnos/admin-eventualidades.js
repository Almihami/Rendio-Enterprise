// admin-eventualidades.js — Admin: bandeja de eventualidades de la operación.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // EVENTUALIDADES (admin) — lo que pasa cuando la realidad se mueve.
  //
  // Es la contraparte de "Novedades" (pestaña Inspecciones): aquella es del
  // VEHÍCULO en inicio/cierre de turno; esta es de un TRASLADO en curso y casi
  // siempre pide una decisión ya. Las dos viven en `incidents` y se separan por
  // la columna `scope` (migración 0063).
  //
  // Esta pantalla se diseña pensando en un celular a oscuras, no en el escritorio:
  // el push de las 4 de la mañana aterriza justo aquí y se opera con una mano.
  // ====================================================================
  const evtState = { items: [], filter: 'open', expanded: null, focusId: null, timer: null };

  const EVT_POLL_MS = 25000; // no hay Realtime en toda la app; polling, como Operación

  // Cada categoría con su cara: qué se le dice al jefe y qué tan fuerte se ve.
  // `tone` = color del punto: red (atender ya) · amber (vigilar) · info (enterarse).
  const EVT_CAT = {
    vehicle_problem:     { label: 'Falla mecánica',            icon: 'i-warn',  tone: 'red' },
    aux_emergency:       { label: 'Emergencia del tripulante', icon: 'i-warn',  tone: 'red' },
    traffic:             { label: 'Trancón',                   icon: 'i-route',  tone: 'amber' },
    driver_late:         { label: 'El carro va atrasado',      icon: 'i-clock',  tone: 'amber' },
    aux_not_ready:       { label: 'El tripulante no bajó',     icon: 'i-clock',  tone: 'amber' },
    aux_not_responding:  { label: 'El tripulante no responde', icon: 'i-clock',  tone: 'amber' },
    wrong_address:       { label: 'Dirección equivocada',      icon: 'i-pin',    tone: 'amber' },
    address_change:      { label: 'Cambio de dirección',       icon: 'i-pin',    tone: 'info' },
    cant_leave_on_time:  { label: 'No puede salir a tiempo',   icon: 'i-clock',  tone: 'amber' },
    flight_delay:        { label: 'Vuelo retrasado',           icon: 'i-clock',  tone: 'amber' },
    flight_advanced:     { label: 'Vuelo adelantado',          icon: 'i-clock',  tone: 'amber' },
    terminal_change:     { label: 'Cambio de terminal',        icon: 'i-pin',    tone: 'info' },
    missed_flight:       { label: 'Perdió el vuelo',           icon: 'i-warn',  tone: 'red' },
    late_booking:        { label: 'Reserva tardía',            icon: 'i-clock',  tone: 'info' },
    needs_third_vehicle: { label: 'Necesita un tercer vehículo', icon: 'i-warn', tone: 'red' },
    other:               { label: 'Otra novedad',              icon: 'i-info',   tone: 'info' },
  };
  const EVT_SEV = { low: 'Leve', medium: 'Media', high: 'Grave' };
  const EVT_ST  = { open: 'Abierta', in_progress: 'En curso', resolved: 'Resuelta' };
  const EVT_SRC = { driver: 'el conductor', auxiliar: 'el tripulante', admin: 'un administrador', system: 'el sistema', flight_api: 'la aerolínea' };

  const evtMeta = (c) => EVT_CAT[c] || { label: c || 'Novedad', icon: 'i-info', tone: 'info' };

  function evtWhen(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
    } catch (e) { return ''; }
  }
  // "hace 8 min" pesa más que una hora exacta cuando se está decidiendo si salir.
  function evtAgo(iso) {
    if (!iso) return '';
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return 'ahora mismo';
    if (min < 60) return `hace ${min} min`;
    const h = min / 60;
    if (h < 48) return `hace ${h.toFixed(h < 10 ? 1 : 0)} h`;
    return `hace ${Math.round(h / 24)} días`;
  }

  const evtPax = (it) => {
    const p = it.reservations && it.reservations.auxiliar_profiles && it.reservations.auxiliar_profiles.profiles;
    return p || null;
  };
  const evtVeh = (it) => {
    const v = it.vehicles;
    if (!v) return '';
    return `${v.internal_code || ''}${v.license_plate ? ' · ' + v.license_plate : ''}`.trim();
  };
  // El detalle del trancón: lo que el conductor alcanzó a contestar en dos toques.
  function evtDetailChips(it) {
    const d = it.details || {};
    const chips = [];
    if (d.movimiento) chips.push(d.movimiento === 'detenido' ? 'Detenido' : 'Avanza lento');
    if (d.causa) chips.push(d.causa === 'accidente' ? 'Accidente' : 'Tráfico habitual');
    return chips;
  }

  // Un canal de avisos caído se ve IGUAL que un día tranquilo: en los dos casos
  // no suena nada. Esto es lo que separa las dos cosas. Si la bandeja de salida
  // se está represando, se dice acá arriba antes de que alguien se entere el día
  // que una falla mecánica no le sonó.
  async function revisarSaludDeAvisos() {
    const box = $('#evt-health'); if (!box) return;
    if (!window.Api?.opsAlertHealth) { box.classList.remove('show'); return; }
    let h = null;
    try { h = await Api.opsAlertHealth(); } catch (e) { /* 0066 sin aplicar */ }
    if (!h) { box.classList.remove('show'); return; }
    const represado = (h.mas_viejo_min || 0) >= 10 || (h.atascados || 0) > 0;
    const sinDestino = (h.destinatarios || 0) === 0;
    if (!represado && !sinDestino) { box.classList.remove('show'); return; }
    box.querySelector('span').textContent = sinDestino
      ? 'Nadie está marcado para recibir alertas y no hay administradores activos: los avisos de madrugada no le van a llegar a nadie. Revísalo en Personal.'
      : `Los avisos no están saliendo: hay ${h.pendientes} en cola, el más viejo de hace ${h.mas_viejo_min} min. Mientras esto siga así, una eventualidad de madrugada no va a sonar en ningún celular.`;
    box.classList.add('show');
  }

  async function refreshEventsBadge() {
    if (state.profile?.role !== 'admin') return;
    const b = $('#events-badge'); if (!b) return;
    try {
      const n = await Api.countOpenEventualidades();
      b.textContent = String(n); b.classList.toggle('hidden', !n);
    } catch (e) { /* silencioso: es solo el badge */ }
  }

  async function renderEventualidades() {
    bindEventualidades();
    const list = $('#evt-list');
    if (list && !evtState.items.length) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      evtState.items = await Api.listEventualidades();
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las eventualidades.</p>';
      return;
    }
    revisarSaludDeAvisos();
    // Si llegamos desde un push, se abre directamente la que motivó el aviso.
    if (evtState.focusId) {
      const hit = evtState.items.find(x => x.id === evtState.focusId);
      if (hit) {
        evtState.expanded = hit.id;
        if (hit.status !== 'open') evtState.filter = 'all';
      }
      evtState.focusId = null;
    }
    renderEvtList();
    startEvtTimer();
  }

  function startEvtTimer() {
    stopEvtTimer();
    evtState.timer = setInterval(async () => {
      // Si el admin se fue a otra pestaña, el intervalo se apaga solo.
      const panel = document.querySelector('section[data-panel="eventualidades"]');
      if (!panel || panel.classList.contains('hidden')) { stopEvtTimer(); return; }
      try {
        evtState.items = await Api.listEventualidades();
        renderEvtList();
      } catch (e) { /* sin red: se queda lo último que se vio */ }
    }, EVT_POLL_MS);
  }
  function stopEvtTimer() {
    if (evtState.timer) { clearInterval(evtState.timer); evtState.timer = null; }
  }

  function renderEvtList() {
    const list = $('#evt-list'); if (!list) return;
    const items = evtState.items;
    const abiertas = items.filter(i => i.status === 'open').length;

    if ($('#evt-count')) $('#evt-count').textContent = String(abiertas);
    const b = $('#events-badge'); if (b) { b.textContent = String(abiertas); b.classList.toggle('hidden', !abiertas); }
    $$('#evt-bar button').forEach(btn => btn.classList.toggle('on', btn.dataset.evtF === evtState.filter));
    const cnt = (f) => f === 'all' ? items.length : items.filter(i => i.status === f).length;
    $$('#evt-bar button').forEach(btn => { const i = btn.querySelector('i'); if (i) i.textContent = cnt(btn.dataset.evtF); });

    const shown = evtState.filter === 'all' ? items : items.filter(i => i.status === evtState.filter);

    // "Sin acusar" es lo primero que hay que ver: significa que el aviso salió y
    // nadie lo ha mirado todavía.
    const sinAcusar = items.filter(i => i.status === 'open' && !i.acknowledged_at).length;
    const aviso = $('#evt-unack');
    if (aviso) {
      aviso.classList.toggle('show', sinAcusar > 0);
      aviso.querySelector('span').textContent = sinAcusar === 1
        ? '1 eventualidad abierta que nadie ha visto todavía.'
        : `${sinAcusar} eventualidades abiertas que nadie ha visto todavía.`;
    }

    if (!shown.length) {
      list.innerHTML = `<div class="evt-empty"><svg class="icon"><use href="#i-check"/></svg><h3>Todo en orden</h3><p>${
        evtState.filter === 'open' ? 'No hay eventualidades abiertas ahora mismo.' : 'No hay nada en este filtro.'}</p></div>`;
      return;
    }
    list.innerHTML = shown.map(evtRow).join('');
  }

  function evtRow(it) {
    const m = evtMeta(it.category);
    const abierta = it.status === 'open';
    const grave = it.severity === 'high';
    const open = evtState.expanded === it.id;
    const pax = evtPax(it);
    const veh = evtVeh(it);
    const quien = (it.reporter && it.reporter.full_name) || EVT_SRC[it.source] || 'el sistema';
    const chips = evtDetailChips(it);

    const meta = [];
    if (veh) meta.push(escapeHtml(veh));
    if (pax && pax.full_name) meta.push(escapeHtml(pax.full_name));
    meta.push(escapeHtml(evtWhen(it.occurred_at || it.created_at)));

    const acuse = abierta && !it.acknowledged_at
      ? '<span class="evt-flag">sin ver</span>'
      : (it.acknowledged_at ? '<span class="evt-seen">vista</span>' : '');

    const mapa = (it.latitude != null && it.longitude != null)
      ? `<a class="evt-btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${it.latitude},${it.longitude}"><svg class="icon"><use href="#i-pin"/></svg>Dónde fue</a>`
      : '';
    const tel = (pax && pax.phone)
      ? `<a class="evt-btn ghost" href="tel:${String(pax.phone).replace(/\s/g, '')}"><svg class="icon"><use href="#i-phone"/></svg>Llamar</a>`
      : '';

    const acciones = it.status === 'resolved'
      ? `<button class="evt-btn ghost" data-evt-st="open" data-evt-id="${it.id}">Reabrir</button>`
      : `${abierta ? `<button class="evt-btn ghost" data-evt-st="in_progress" data-evt-id="${it.id}">La estoy atendiendo</button>` : ''}
         <button class="evt-btn dark" data-evt-st="resolved" data-evt-id="${it.id}">Resolver</button>`;

    const cuerpo = open ? `
      <div class="evt-body">
        <p class="evt-desc">${escapeHtml(it.description || '')}</p>
        ${chips.length ? `<div class="evt-chips">${chips.map(c => `<span>${escapeHtml(c)}</span>`).join('')}</div>` : ''}
        <div class="evt-kv">
          <div><span>Reportó</span><b>${escapeHtml(quien)}</b></div>
          <div><span>Gravedad</span><b>${EVT_SEV[it.severity] || it.severity}</b></div>
          <div><span>Estado</span><b>${EVT_ST[it.status] || it.status}</b></div>
          ${it.acknowledged_at ? `<div><span>Vista</span><b>${escapeHtml(evtWhen(it.acknowledged_at))}</b></div>` : ''}
        </div>
        ${it.resolution_notes ? `<p class="evt-note">${escapeHtml(it.resolution_notes)}</p>` : ''}
        <div class="evt-actions">${mapa}${tel}${acciones}</div>
      </div>` : '';

    return `<div class="evt-row ${m.tone}${grave ? ' grave' : ''}${open ? ' open' : ''}" data-evt-row="${it.id}">
      <button class="evt-head" data-evt-toggle="${it.id}">
        <span class="evt-ic"><svg class="icon"><use href="#${m.icon}"/></svg></span>
        <span class="evt-txt">
          <b>${escapeHtml(m.label)}${grave ? ' <i class="evt-grave">grave</i>' : ''}</b>
          <span class="evt-sub">${escapeHtml((it.description || '').slice(0, 90))}${(it.description || '').length > 90 ? '…' : ''}</span>
          <span class="evt-meta">${meta.join(' · ')} · ${escapeHtml(evtAgo(it.occurred_at || it.created_at))} ${acuse}</span>
        </span>
      </button>
      ${cuerpo}
    </div>`;
  }

  function bindEventualidades() {
    const root = $('#evt-ui');
    if (!root || root._evtBound) return;
    root._evtBound = true;

    root.addEventListener('click', async (e) => {
      if (e.target.closest('#evt-refresh')) { renderEventualidades(); return; }

      const f = e.target.closest('#evt-bar button');
      if (f) { evtState.filter = f.dataset.evtF; renderEvtList(); return; }

      const t = e.target.closest('[data-evt-toggle]');
      if (t) {
        const id = t.dataset.evtToggle;
        const abriendo = evtState.expanded !== id;
        evtState.expanded = abriendo ? id : null;
        renderEvtList();
        // Abrirla ES verla. El acuse se sella solo: pedirle al jefe un toque más
        // a las 4am para decir "la vi" es un toque que no va a dar.
        if (abriendo) {
          const it = evtState.items.find(x => x.id === id);
          if (it && !it.acknowledged_at) {
            it.acknowledged_at = new Date().toISOString();
            renderEvtList();
            try { await Api.acknowledgeIncident(id); } catch (err) { console.error(err); }
          }
        }
        return;
      }

      const st = e.target.closest('[data-evt-st]');
      if (st) {
        const id = st.dataset.evtId, nuevo = st.dataset.evtSt;
        let nota = null;
        if (nuevo === 'resolved') {
          nota = prompt('¿Cómo se resolvió? (opcional)');
          if (nota === null) return; // canceló el diálogo
        }
        st.disabled = true;
        try {
          await Api.updateIncidentStatus(id, nuevo, nota || undefined);
          const it = evtState.items.find(x => x.id === id);
          if (it) {
            it.status = nuevo;
            it.resolved_at = nuevo === 'resolved' ? new Date().toISOString() : null;
            if (nuevo === 'resolved' && nota) it.resolution_notes = nota;
          }
          toast(nuevo === 'resolved' ? 'Eventualidad resuelta.' : nuevo === 'open' ? 'Eventualidad reabierta.' : 'Marcada como en curso.');
          renderEvtList();
          refreshEventsBadge();
        } catch (err) {
          console.error(err);
          st.disabled = false;
          alert('No se pudo actualizar: ' + (err.message || 'error'));
        }
        return;
      }
    });
  }
