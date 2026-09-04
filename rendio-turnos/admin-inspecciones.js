// admin-inspecciones.js — Admin: inspecciones (cola, detalle, checklist configurable, novedades).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Inspecciones (admin) — revisión/aprobación + checklist configurable
  // ====================================================================
  const inspState = { items: [], filter: 'pending', current: null, checklist: [], vehicles: [], autoVehicleId: null, autoItems: [], adminPhoto: null,
    novItems: [], novFilter: 'open', novCurrent: null, openIncidents: 0 };
  const INSP_SEV = {
    leve:  { cls: 'leve',  label: 'Leve',  text: 'Leve · informativo',       color: 'var(--green)' },
    media: { cls: 'media', label: 'Media', text: 'Media · con cuidado',       color: 'var(--amber)' },
    grave: { cls: 'grave', label: 'Grave', text: 'Grave · requiere atención', color: 'var(--red)' },
  };
  const INSP_ST = { pending: ['pend', 'Pendiente', 'i-warn'], approved: ['appr', 'Aprobada', 'i-check'], rejected: ['rej', 'Rechazada', 'i-x'] };
  const PHOTO_LABELS = { front: 'Frontal', rear: 'Trasera', left: 'Lat. izq.', right: 'Lat. der.', dashboard: 'Tablero', glovebox: 'Guantera', door_left: 'Puerta cond.', door_right: 'Puerta pas.', damage: 'Golpe/daño', extra: 'Adicional' };
  const PHOTO_ORDER = ['front', 'rear', 'left', 'right', 'dashboard', 'glovebox', 'door_left', 'door_right'];

  function inspShowView(v) {
    $$('#inspections-ui .view').forEach(s => s.classList.toggle('on', s.id === 'insp-v-' + v));
    window.scrollTo(0, 0);
  }
  function inspChecklistOf(insp) {
    const c = insp && insp.checklist;
    return (c && Array.isArray(c.items)) ? c.items : [];
  }
  function inspSeverityOf(insp) {
    const c = insp && insp.checklist;
    return (c && c.severity) || 'media';
  }
  function inspFallas(insp) { return inspChecklistOf(insp).filter(i => i.result === 'issue').length; }
  function inspDriverName(insp) {
    return (insp.driver_profiles && insp.driver_profiles.profiles && insp.driver_profiles.profiles.full_name) || '—';
  }
  function inspDriverProfileId(insp) {
    return insp.driver_profiles && insp.driver_profiles.profiles && insp.driver_profiles.profiles.id;
  }
  function inspWhen(insp) {
    try {
      return new Date(insp.performed_at).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
    } catch (e) { return ''; }
  }
  function inspCounts() {
    const c = { pending: 0, approved: 0, rejected: 0, all: inspState.items.length };
    inspState.items.forEach(i => { if (c[i.review_status] != null) c[i.review_status]++; });
    return c;
  }

  // El badge de la pestaña suma inspecciones pendientes + novedades ABIERTAS, para
  // que una novedad reportada sí llame la atención del admin (antes era invisible).
  async function refreshInspectionsBadge() {
    const b = $('#inspections-badge'); if (!b) return;
    try {
      const pend = inspState.items.length ? inspCounts().pending : (await Api.listInspectionsForReview('pending')).length;
      // 'flota' = solo lo del vehículo. Las eventualidades de traslado tienen su
      // propia bandeja y su propio badge; si no se filtrara, este contador se
      // llenaría de trancones y fallas de ruta que no se atienden desde aquí.
      let open = 0; try { open = await Api.countOpenIncidents('flota'); inspState.openIncidents = open; } catch (e) { /* */ }
      const n = pend + open;
      b.textContent = n; b.classList.toggle('hidden', !n);
    } catch (e) { /* */ }
  }

  async function renderInspections() {
    bindInspections();
    inspShowView('cola');
    const list = $('#insp-list');
    if (list) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      inspState.items = await Api.listInspectionsForReview(); // todas las iniciales (limpias + con novedad)
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las inspecciones.</p>';
      return;
    }
    try { inspState.openIncidents = await Api.countOpenIncidents('flota'); } catch (e) { /* */ }
    updateNovCount();
    renderInspList();
  }

  // Refresca el contador del botón "Novedades" (novedades abiertas).
  function updateNovCount() {
    const el = $('#insp-nov-ct'); if (!el) return;
    el.textContent = inspState.openIncidents || 0;
    el.classList.toggle('hidden', !inspState.openIncidents);
  }

  // ---------- Novedades reportadas (incidents) dentro de la pestaña Inspecciones ----------
  const NOV_ST = {
    open:        { label: 'Abierta',    color: 'var(--amber)', icon: 'i-warn' },
    in_progress: { label: 'En proceso', color: '#2563A8',      icon: 'i-clock' },
    resolved:    { label: 'Resuelta',   color: 'var(--green)', icon: 'i-check' },
  };
  const NOV_SEV = {
    low:    { label: 'Leve',  color: 'var(--green)' },
    medium: { label: 'Media', color: 'var(--amber)' },
    high:   { label: 'Grave', color: 'var(--red)' },
  };
  // Las llaves son los valores REALES del enum incident_category (0001 + 0062).
  // Antes había tres —`delay`, `accident`, `fuel`— que nunca existieron en la base:
  // no rompían nada porque abajo hay un fallback al nombre crudo, pero cualquier
  // categoría de verdad se veía en inglés y en snake_case.
  const NOV_CAT = {
    vehicle_problem: 'Problema del vehículo',
    cant_leave_on_time: 'No puede salir a tiempo',
    address_change: 'Cambio de dirección',
    wrong_address: 'Dirección equivocada',
    driver_late: 'Conductor demorado',
    flight_delay: 'Vuelo retrasado',
    flight_advanced: 'Vuelo adelantado',
    terminal_change: 'Cambio de terminal',
    missed_flight: 'Perdió el vuelo',
    traffic: 'Trancón',
    aux_not_responding: 'Tripulante no responde',
    aux_not_ready: 'Tripulante no estaba listo',
    aux_emergency: 'Emergencia del tripulante',
    late_booking: 'Reserva tardía',
    needs_third_vehicle: 'Necesita un tercer vehículo',
    other: 'Otra',
  };
  const novWhen = (iso) => { try { return new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
  const novMediaPaths = (it) => Array.isArray(it.photo_paths) ? it.photo_paths.filter(p => typeof p === 'string') : [];
  const novIsVideo = (p) => /\.(mp4|mov|webm|m4v)$/i.test(p);

  async function renderNovedades() {
    bindInspections();
    inspShowView('novedades');
    renderNovShell();
    const list = $('#nov-list');
    if (list) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      inspState.novItems = await Api.listIncidents(null, 'flota');
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las novedades.</p>';
      return;
    }
    inspState.openIncidents = inspState.novItems.filter(i => i.status === 'open').length;
    updateNovCount();
    renderNovList();
  }

  function renderNovShell() {
    const el = $('#insp-v-novedades'); if (!el) return;
    el.innerHTML = `
      <button class="back" data-nov-back><svg class="icon"><use href="#i-back"/></svg>Volver a inspecciones</button>
      <div class="phead">
        <div><h1>Novedades reportadas</h1><p>Lo que los conductores reportan al iniciar o cerrar el turno. Ábrelas para ver el detalle, la evidencia y marcar el seguimiento.</p></div>
      </div>
      <div class="seg" id="nov-filter">
        <button data-nf="open" class="on"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Abiertas <span class="n" data-nc="open">0</span></button>
        <button data-nf="in_progress">En proceso <span class="n" data-nc="in_progress">0</span></button>
        <button data-nf="resolved">Resueltas <span class="n" data-nc="resolved">0</span></button>
        <button data-nf="all">Todas <span class="n" data-nc="all">0</span></button>
      </div>
      <div id="nov-list"></div>`;
  }

  function renderNovList() {
    const items = inspState.novItems || [];
    const counts = { open: 0, in_progress: 0, resolved: 0, all: items.length };
    items.forEach(i => { if (counts[i.status] != null) counts[i.status]++; });
    $$('#nov-filter .n').forEach(n => { n.textContent = counts[n.dataset.nc] != null ? counts[n.dataset.nc] : 0; });
    $$('#nov-filter button').forEach(b => b.classList.toggle('on', b.dataset.nf === inspState.novFilter));
    const shown = items.filter(it => inspState.novFilter === 'all' ? true : it.status === inspState.novFilter);
    const list = $('#nov-list'); if (!list) return;
    list.innerHTML = shown.length ? shown.map(novCardHtml).join('')
      : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Nada por aquí</h3><p>No hay novedades en este filtro.</p></div>`;
  }

  function novCardHtml(it) {
    const sev = NOV_SEV[it.severity] || NOV_SEV.medium;
    const stm = NOV_ST[it.status] || NOV_ST.open;
    const v = it.vehicles || {};
    const veh = `${escapeHtml(v.internal_code || '—')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}`;
    const who = (it.reporter && it.reporter.full_name) || '—';
    const nMedia = novMediaPaths(it).length;
    return `<div class="icard ${it.status === 'open' && it.severity === 'high' ? 'grave' : ''}">
      <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(who))}</span>
      <div class="who"><b>${escapeHtml(who)}</b>
        <div class="sub"><span class="veh">${veh}</span> <span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${escapeHtml(novWhen(it.created_at))}</span></div>
        <div class="novdesc">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="right">
        <div class="chips">
          <span class="chip" style="color:${sev.color}"><svg><use href="#i-warn"/></svg>${sev.label}</span>
          ${nMedia ? `<span class="chip"><svg><use href="#i-cam"/></svg>${nMedia}</span>` : ''}
        </div>
        <div class="qactions"><span class="chip" style="color:${stm.color};font-weight:700"><svg><use href="#${stm.icon}"/></svg>${stm.label}</span><button class="btn dark sm" data-nov-open="${it.id}">Ver <svg class="icon" style="width:14px;height:14px"><use href="#i-chev"/></svg></button></div>
      </div>
    </div>`;
  }

  async function openNovedadDetail(id) {
    const it = (inspState.novItems || []).find(x => x.id === id);
    if (!it) return;
    inspState.novCurrent = it;
    inspShowView('novedades');
    const el = $('#insp-v-novedades');
    if (el) el.innerHTML = `<button class="back" data-nov-list><svg class="icon"><use href="#i-back"/></svg>Volver a novedades</button><div class="card"><p style="color:var(--ink2);font-size:13px">Cargando evidencia…</p></div>`;
    let urls = {};
    const paths = novMediaPaths(it);
    if (paths.length) { try { urls = await Api.signedInspectionPhotoUrls(paths); } catch (e) { console.error(e); } }
    renderNovedadDetail(it, urls);
  }

  function renderNovedadDetail(it, urls) {
    const el = $('#insp-v-novedades'); if (!el) return;
    const sev = NOV_SEV[it.severity] || NOV_SEV.medium;
    const stm = NOV_ST[it.status] || NOV_ST.open;
    const v = it.vehicles || {};
    const who = (it.reporter && it.reporter.full_name) || '—';
    const paths = novMediaPaths(it);
    const mediaHtml = paths.length ? paths.map(p => {
      const url = urls[p];
      if (!url) return `<div class="photo"><svg class="icon"><use href="#i-cam"/></svg><span class="plabel">Evidencia</span></div>`;
      if (novIsVideo(p)) return `<div class="photo" style="cursor:default"><video src="${url}" controls preload="metadata" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;background:#000"></video><span class="plabel">Video</span></div>`;
      return `<div class="photo" data-insp-photo="${url}"><img src="${url}" alt="Evidencia"><span class="plabel">Foto</span></div>`;
    }).join('') : '<p style="color:var(--ink2);font-size:13px">Sin evidencia adjunta.</p>';
    const fmtDT = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const actions = it.status === 'resolved'
      ? `<div class="abar" style="margin-top:12px"><button class="btn ghost" data-nov-status="open"><svg class="icon"><use href="#i-back"/></svg>Reabrir novedad</button></div>`
      : `<label>Nota de resolución (opcional)</label>
         <textarea id="nov-resolve-note" placeholder="Ej: Se revisó el golpe, autorizado para operar. / Enviado a taller.">${escapeHtml(it.resolution_notes || '')}</textarea>
         <div class="abar" style="margin-top:12px">
           ${it.status === 'open' ? '<button class="btn ghost" data-nov-status="in_progress"><svg class="icon"><use href="#i-clock"/></svg>Marcar en proceso</button>' : ''}
           <button class="rbtn ok" data-nov-status="resolved"><svg><use href="#i-check"/></svg>Marcar resuelta</button>
         </div>`;
    el.innerHTML = `
      <button class="back" data-nov-list><svg class="icon"><use href="#i-back"/></svg>Volver a novedades</button>
      <div class="card">
        <div class="dhead">
          <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(who))}</span>
          <div class="grow">
            <h2>${escapeHtml(who)}</h2>
            <div class="who"><div class="sub"><span class="veh">${escapeHtml(v.internal_code || '—')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}</span> ${escapeHtml([v.brand, v.model].filter(Boolean).join(' '))} · ${escapeHtml(fmtDT(it.created_at))}</div></div>
          </div>
          <span class="chip" style="color:${sev.color}"><svg><use href="#i-warn"/></svg>${sev.label}</span>
          <span class="chip" style="color:${stm.color};font-weight:700"><svg><use href="#${stm.icon}"/></svg>${stm.label}</span>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-info"/></svg>Novedad</h2>
        <div class="kv"><span class="k">Tipo</span><span class="v">${escapeHtml(NOV_CAT[it.category] || it.category || '—')}</span></div>
        <div style="margin-top:12px"><div class="note">${escapeHtml(it.description || '—')}</div></div>
        ${it.resolved_at ? `<div class="kv" style="margin-top:10px"><span class="k">Resuelta</span><span class="v">${escapeHtml(fmtDT(it.resolved_at))}</span></div>` : ''}
        ${(it.resolution_notes && it.status === 'resolved') ? `<div style="margin-top:10px"><div class="note"><b>Resolución:</b> ${escapeHtml(it.resolution_notes)}</div></div>` : ''}
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-cam"/></svg>Evidencia</h2>
        <p class="csub">Fotos y videos que adjuntó el conductor. Toca una foto para ampliar.</p>
        <div class="pgrid">${mediaHtml}</div>
      </div>
      <div class="card" id="nov-decision" style="margin-top:16px">
        <h2>Seguimiento</h2>
        <p class="csub">Marca el avance de esta novedad para llevar control.</p>
        ${actions}
      </div>`;
  }

  async function novChangeStatus(id, status) {
    const it = (inspState.novItems || []).find(x => x.id === id) || inspState.novCurrent;
    let notes = null;
    if (status === 'resolved') { const t = $('#nov-resolve-note'); notes = t ? t.value.trim() : null; }
    try {
      await Api.updateIncidentStatus(id, status, notes);
      if (it) {
        it.status = status;
        it.resolved_at = status === 'resolved' ? new Date().toISOString() : null;
        if (status === 'resolved' && notes != null) it.resolution_notes = notes;
      }
      inspState.openIncidents = (inspState.novItems || []).filter(x => x.status === 'open').length;
      updateNovCount();
      toast(status === 'resolved' ? 'Novedad marcada como resuelta.' : status === 'in_progress' ? 'Novedad en proceso.' : 'Novedad reabierta.');
      openNovedadDetail(id);
    } catch (e) { console.error(e); toast('No se pudo actualizar la novedad.'); }
  }

  function renderInspList() {
    const counts = inspCounts();
    if ($('#insp-count')) $('#insp-count').textContent = counts.pending;
    $$('#insp-filter .n').forEach(n => { n.textContent = counts[n.dataset.c] != null ? counts[n.dataset.c] : 0; });
    const b = $('#inspections-badge'); if (b) { const n = counts.pending + (inspState.openIncidents || 0); b.textContent = n; b.classList.toggle('hidden', !n); }
    const autosBar = $('#insp-autos-bar');
    if (inspState.filter === 'autos') { renderAutosView(); return; }
    if (autosBar) autosBar.classList.add('hidden');
    const shown = inspState.items.filter(it => inspState.filter === 'all' ? true : it.review_status === inspState.filter);
    const list = $('#insp-list');
    list.innerHTML = shown.length ? shown.map(inspCardHtml).join('')
      : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Nada por aquí</h3><p>No hay inspecciones en este filtro.</p></div>`;
  }

  // --- Filtro "Autos": elige un vehículo y ve todas sus inspecciones ---
  async function renderAutosView() {
    const bar = $('#insp-autos-bar');
    if (bar) bar.classList.remove('hidden');
    if (!inspState.vehicles.length) {
      try { inspState.vehicles = await Api.listVehiclesForShift(); } catch (e) { console.error(e); }
    }
    const opts = inspState.vehicles.map(v =>
      `<option value="${v.id}"${v.id === inspState.autoVehicleId ? ' selected' : ''}>${escapeHtml(v.internal_code || v.license_plate || 'Auto')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}</option>`
    ).join('');
    if (bar) bar.innerHTML = `<div class="autosel"><label>Auto</label><select id="insp-auto-sel"><option value="">Elige un auto…</option>${opts}</select></div>`;
    $('#insp-auto-sel')?.addEventListener('change', (e) => { inspState.autoVehicleId = e.target.value || null; loadAutoList(); });
    loadAutoList();
  }

  async function loadAutoList() {
    const list = $('#insp-list');
    if (!list) return;
    if (!inspState.autoVehicleId) {
      list.innerHTML = `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-list"/></svg></div><h3>Elige un auto</h3><p>Selecciona un vehículo arriba para ver sus inspecciones.</p></div>`;
      return;
    }
    list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try { inspState.autoItems = await Api.listInspectionsByVehicle(inspState.autoVehicleId); }
    catch (e) { console.error(e); list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las inspecciones.</p>'; return; }
    list.innerHTML = inspState.autoItems.length ? inspState.autoItems.map(inspCardHtml).join('')
      : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Sin registros</h3><p>Este auto aún no tiene inspecciones.</p></div>`;
  }

  function inspFindItem(id) {
    return inspState.items.find(x => x.id === id) || inspState.autoItems.find(x => x.id === id) || (inspState.current && inspState.current.id === id ? inspState.current : null);
  }

  function inspThumbsHtml() {
    return `<div class="thumbs">${PHOTO_ORDER.map(() => `<span class="thumb"><svg class="icon"><use href="#i-cam"/></svg></span>`).join('')}</div>`;
  }
  function inspCardHtml(it) {
    const sev = INSP_SEV[inspSeverityOf(it)] || INSP_SEV.media;
    const st = INSP_ST[it.review_status] || INSP_ST.pending;
    const fallas = inspFallas(it);
    const v = it.vehicles || {};
    const veh = `${escapeHtml(v.internal_code || '—')} · ${escapeHtml(v.license_plate || '')}`;
    const vehname = escapeHtml([v.brand, v.model].filter(Boolean).join(' '));
    const actions = it.review_status === 'pending'
      ? `<div class="qactions"><button class="rbtn no" data-insp-rej="${it.id}"><svg><use href="#i-x"/></svg>Rechazar</button><button class="rbtn ok" data-insp-ok="${it.id}"><svg><use href="#i-check"/></svg>Aprobar</button><button class="btn dark sm" data-insp-open="${it.id}">Revisar <svg class="icon" style="width:14px;height:14px"><use href="#i-chev"/></svg></button></div>`
      : `<div class="qactions"><span class="st ${st[0]}"><svg><use href="#${st[2]}"/></svg>${st[1]}</span><button class="btn ghost sm" data-insp-open="${it.id}">Ver</button></div>`;
    const chips = it.has_damage
      ? `<span class="chip ${sev.cls}"><svg><use href="#i-warn"/></svg>${sev.label}</span><span class="chip fallas">${fallas} ${fallas === 1 ? 'falla' : 'fallas'}</span>`
      : `<span class="chip"><svg><use href="#i-check"/></svg>Sin novedad</span>`;
    return `<div class="icard ${it.has_damage && inspSeverityOf(it) === 'grave' ? 'grave' : ''}">
      <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(inspDriverName(it)))}</span>
      <div class="who"><b>${escapeHtml(inspDriverName(it))}</b><div class="sub"><span class="veh">${veh}</span> ${vehname} <span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${escapeHtml(inspWhen(it))}</span></div></div>
      <div class="right">
        <div class="chips">${chips}</div>
        ${inspThumbsHtml()}
        ${actions}
      </div>
    </div>`;
  }

  async function openInspectionDetail(id) {
    bindInspections();
    if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
    inspState.adminPhoto = null;
    const view = $('#insp-v-detalle');
    view.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    inspShowView('detalle');
    let insp;
    try { insp = await Api.getInspectionDetail(id); }
    catch (e) { console.error(e); view.innerHTML = '<button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver</button><div class="card">No se pudo cargar la inspección.</div>'; return; }
    inspState.current = insp;
    // Cierre del mismo turno (inspección final + comprobantes de tanqueo) para
    // anexarlo a esta tarjeta y dar el ciclo completo del turno al admin.
    let closeData = null;
    try {
      if (insp.shift_id) {
        const [byShift, receipts, fuel] = await Promise.all([
          Api.listInspectionsByShift(insp.shift_id).catch(() => []),
          Api.listFuelReceiptsForShift(insp.shift_id).catch(() => []),
          (Api.getShiftFuelStatus ? Api.getShiftFuelStatus(insp.shift_id) : Promise.resolve(null)).catch(() => null),
        ]);
        const final = (byShift || []).find(i => i.kind === 'final') || null;
        // `fuel` cuenta también: un turno que dice "no pude tanquear" no tiene
        // recibos, y sin esto la tarjeta de cierre no se armaría y el motivo
        // —lo único que el jefe quería ver— no se pintaría en ningún lado.
        if (final || (receipts && receipts.length) || fuel) closeData = { final, receipts: receipts || [], fuel };
      }
    } catch (e) { console.error(e); }
    const paths = (insp.inspection_photos || []).map(p => p.storage_path);
    if (closeData) (closeData.receipts || []).forEach(r => paths.push(r.storage_path));
    let urls = {};
    try { urls = await Api.signedInspectionPhotoUrls(paths); } catch (e) { console.error(e); }
    renderInspectionDetail(insp, urls, closeData);
  }

  function renderInspectionDetail(insp, urls, closeData) {
    const v = insp.vehicles || {};
    const sev = INSP_SEV[inspSeverityOf(insp)] || INSP_SEV.media;
    const st = INSP_ST[insp.review_status] || INSP_ST.pending;
    const items = inspChecklistOf(insp);
    const fallas = items.filter(i => i.result === 'issue').length;
    // Orden: los 5 ángulos fijos primero (en orden), luego golpe y adicionales.
    const photoRank = (t) => { const i = PHOTO_ORDER.indexOf(t); return i === -1 ? 99 : i; };
    const photos = (insp.inspection_photos || []).slice().sort((a, b) => photoRank(a.photo_type) - photoRank(b.photo_type));
    const photosHtml = photos.length ? photos.map(p => {
      const url = urls[p.storage_path];
      const label = escapeHtml(PHOTO_LABELS[p.photo_type] || p.photo_type);
      const inner = url ? `<img src="${url}" alt="${label}">` : `<svg class="icon"><use href="#i-cam"/></svg>`;
      return `<div class="photo"${url ? ` data-insp-photo="${url}"` : ''}>${inner}<span class="plabel">${label}</span></div>`;
    }).join('') : '<p style="color:var(--ink2);font-size:13px">Sin fotos.</p>';
    const checklistHtml = items.length ? items.map(it => {
      const bad = it.result === 'issue';
      return `<div class="ckrow ${bad ? 'issue' : 'ok'}"><svg class="icon ci"><use href="#${bad ? 'i-warn' : 'i-check'}"/></svg><div><div class="lbl">${escapeHtml(it.label || '')}</div>${it.hint ? `<div class="hint">${escapeHtml(it.hint)}</div>` : ''}</div><span class="badge">${bad ? 'Con falla' : 'OK'}</span></div>`;
    }).join('') : '<div class="ckrow ok"><span class="lbl" style="color:var(--ink2)">Sin checklist registrado.</span></div>';
    const nextMaint = (v.last_maintenance_km != null && v.maintenance_interval_km) ? Math.max(0, (v.last_maintenance_km + v.maintenance_interval_km) - (v.current_km || 0)) : null;
    const vehLine = `${v.status === 'available' ? 'Disponible' : (VEH_STATUS_ES[v.status] || v.status || '—')}${nextMaint != null ? ` · cambio de aceite en ${nextMaint.toLocaleString('es-CO')} km` : ''}`;
    const fmtDT = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const decision = insp.review_status === 'pending'
      ? `<div class="card" id="insp-decision">
           <h2>Resolver inspección</h2>
           <p class="csub">Deja una nota con la solución y, si hace falta, adjunta una foto. Luego aprueba o rechaza.</p>
           <label>Nota / solución (la verá el conductor)</label>
           <textarea id="insp-resolve-note" placeholder="Ej: Se revisó el golpe, autorizado para operar. / Llevar a taller antes de seguir."></textarea>
           <div class="adminphoto">
             <button class="btn ghost sm" id="insp-admin-photo-btn" type="button"><svg class="icon"><use href="#i-cam"/></svg>Adjuntar foto (opcional)</button>
             <input id="insp-admin-photo-input" type="file" accept="image/*" class="hidden">
             <div id="insp-admin-photo-preview"></div>
           </div>
           <div class="abar" style="margin-top:12px">
             <button class="rbtn no" id="insp-reject-btn"><svg><use href="#i-x"/></svg>Rechazar</button>
             <button class="rbtn ok" id="insp-approve-btn"><svg><use href="#i-check"/></svg>Aprobar</button>
           </div>
           <div class="snapnote"><svg><use href="#i-info"/></svg><span>La nota y la foto quedan guardadas en la inspección. Al <b>rechazar</b> se notifica al conductor y se abre una novedad (el rechazo exige nota).</span></div>
         </div>`
      : `<div class="card"><h2>Revisión</h2>
           <div class="kv"><span class="k">Estado</span><span class="v" style="color:${insp.review_status === 'approved' ? 'var(--green)' : 'var(--red)'}">${st[1]}</span></div>
           ${insp.reviewed_at ? `<div class="kv"><span class="k">Revisada</span><span class="v">${escapeHtml(fmtDT(insp.reviewed_at))}</span></div>` : ''}
           ${insp.review_notes ? `<div style="margin-top:10px"><div class="note"><b>Nota del admin:</b> ${escapeHtml(insp.review_notes)}</div></div>` : ''}</div>`;
    $('#insp-v-detalle').innerHTML = `
      <button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver a la cola</button>
      <div class="card">
        <div class="dhead">
          <span class="avt" style="background:${colorOfId(insp.id)}">${escapeHtml(initialsOf(inspDriverName(insp)))}</span>
          <div class="grow">
            <h2>${escapeHtml(inspDriverName(insp))}</h2>
            <div class="who"><div class="sub"><span class="veh">${escapeHtml(v.internal_code || '—')} · ${escapeHtml(v.license_plate || '')}</span> ${escapeHtml([v.brand, v.model].filter(Boolean).join(' '))} · ${escapeHtml(inspWhen(insp))}</div></div>
          </div>
          <span class="chip ${sev.cls}"><svg><use href="#i-warn"/></svg>Novedad ${sev.label.toLowerCase()}</span>
          <span class="st ${st[0]}"><svg><use href="#${st[2]}"/></svg>${st[1]}</span>
        </div>
      </div>
      <div class="cols">
        <div class="card" style="margin-bottom:0">
          <h2><svg class="icon"><use href="#i-cam"/></svg>Fotos de la inspección</h2>
          <p class="csub">Capturadas por el conductor. Toca una para ampliar.</p>
          <div class="pgrid">${photosHtml}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <h2><svg class="icon"><use href="#i-info"/></svg>Datos</h2>
          <div style="margin-top:6px">
            <div class="kv"><span class="k">Kilometraje de salida</span><span class="v mono">${insp.odometer_km != null ? insp.odometer_km.toLocaleString('es-CO') : '—'} km</span></div>
            <div class="kv"><span class="k">Severidad reportada</span><span class="v" style="color:${sev.color}">${sev.text}</span></div>
            ${insp.is_apt != null ? `<div class="kv"><span class="k">Estado del vehículo</span><span class="v" style="color:${insp.is_apt ? 'var(--green)' : 'var(--red)'};font-weight:800">${insp.is_apt ? 'APTO PARA OPERAR' : 'NO APTO PARA OPERAR'}</span></div>` : ''}
            <div class="kv"><span class="k">Vehículo</span><span class="v">${escapeHtml(vehLine)}</span></div>
            ${insp.signed_name ? `<div class="kv"><span class="k">Firma (conductor)</span><span class="v">${escapeHtml(insp.signed_name)}</span></div>` : ''}
          </div>
          ${insp.notes ? `<div style="margin-top:13px"><div class="note"><b>Nota del conductor:</b> ${escapeHtml(insp.notes)}</div></div>` : ''}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-check"/></svg>Checklist <span style="color:var(--ink3);font-weight:600;font-size:13px">(${items.length} ítems · ${fallas} con falla)</span></h2>
        <p class="csub">Lo que el conductor revisó. En rojo, lo que marcó con problema.</p>
        <div class="cklist">${checklistHtml}</div>
      </div>
      ${closeCardHtml(insp, urls, closeData)}
      ${decision}`;
  }

  // Tarjeta de CIERRE de turno anexada al detalle (km final, novedad, comprobantes
  // de tanqueo con foto ampliable). Vacía mientras el turno no se haya cerrado.
  function closeCardHtml(insp, urls, closeData) {
    if (!closeData) {
      return `<div class="card" style="margin-top:16px"><h2><svg class="icon"><use href="#i-clock"/></svg>Cierre de turno</h2>
        <p class="csub">El turno aún no se ha cerrado. Aquí aparecerán el kilometraje final, las novedades y los comprobantes de tanqueo cuando el conductor cierre.</p></div>`;
    }
    const f = closeData.final;
    const receipts = closeData.receipts || [];
    const total = receipts.reduce((s, r) => s + (Number(r.amount_cop) || 0), 0);
    const driven = (f && f.odometer_km != null && insp.odometer_km != null) ? (f.odometer_km - insp.odometer_km) : null;
    const fmtDT2 = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const kmRows = `
      <div class="kv"><span class="k">Kilometraje final</span><span class="v mono">${f && f.odometer_km != null ? f.odometer_km.toLocaleString('es-CO') : '—'} km</span></div>
      <div class="kv"><span class="k">Km recorridos</span><span class="v mono" style="color:var(--green)">${driven != null ? '+' + driven.toLocaleString('es-CO') : '—'} km</span></div>
      ${f && f.performed_at ? `<div class="kv"><span class="k">Cerrado</span><span class="v">${escapeHtml(fmtDT2(f.performed_at))}</span></div>` : ''}
      ${f && f.notes ? `<div style="margin-top:10px"><div class="note"><b>Novedad de cierre:</b> ${escapeHtml(f.notes)}</div></div>` : ''}`;
    const receiptsHtml = receipts.length ? `
      <div style="margin-top:14px">
        <div class="kv"><span class="k">Comprobantes de tanqueo</span><span class="v mono" style="font-weight:800">$${total.toLocaleString('es-CO')}</span></div>
        <div class="pgrid" style="margin-top:8px">
          ${receipts.map(r => { const u = urls[r.storage_path]; return `<div class="photo"${u ? ` data-insp-photo="${u}"` : ''}>${u ? `<img src="${u}" alt="comprobante">` : `<svg class="icon"><use href="#i-cam"/></svg>`}<span class="plabel">$${(Number(r.amount_cop) || 0).toLocaleString('es-CO')}</span></div>`; }).join('')}
        </div>
      </div>`
      // TRES CASOS, NO DOS (0077). Antes cualquier turno sin recibos decía "Sin
      // comprobantes de tanqueo", que ahora sería mentir a medias: no distingue
      // al que avisó que no pudo del que simplemente no adjuntó nada. Y saber
      // POR QUÉ no se tanqueó es justo lo que pidió el jefe.
      : (closeData.fuel && closeData.fuel.fueled === false)
        ? `<div class="note" style="margin-top:12px;background:var(--amber-50,#fffbeb);border-color:var(--amber,#f59e0b)">
             <b>No se pudo tanquear.</b> ${escapeHtml(closeData.fuel.no_fuel_reason || 'Sin motivo registrado.')}
           </div>`
        : (closeData.fuel && closeData.fuel.fueled === true)
          ? '<p class="csub" style="margin-top:10px">Dijo que sí tanqueó, pero no adjuntó comprobantes.</p>'
          : '<p class="csub" style="margin-top:10px">Sin comprobantes de tanqueo.</p>';
    return `<div class="card" style="margin-top:16px">
      <h2><svg class="icon"><use href="#i-check"/></svg>Cierre de turno</h2>
      <p class="csub">Información registrada por el conductor al cerrar el turno.</p>
      <div style="margin-top:6px">${kmRows}</div>
      ${receiptsHtml}
    </div>`;
  }

  async function inspDoReview(id, status, notes) {
    try {
      await Api.reviewInspection(id, status, notes);
      if (status === 'rejected') {
        const pid = inspState.current ? inspDriverProfileId(inspState.current) : null;
        if (pid) { try { await notify([pid], 'Inspección rechazada', notes || 'Tu inspección de inicio de turno fue rechazada.', '/'); } catch (e) {} }
      }
      const it = inspState.items.find(x => x.id === id);
      if (it) { it.review_status = status; it.review_notes = notes || null; }
      toast(status === 'approved' ? 'Inspección aprobada.' : 'Inspección rechazada.');
      renderInspList();
      inspShowView('cola');
    } catch (e) {
      console.error(e);
      toast('No se pudo guardar la revisión.');
    }
  }

  // Comprime una imagen a JPEG (máx 1280px) para no pasar el límite del bucket.
  async function compressImage(file, maxDim = 1280, quality = 0.8) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) throw new Error('No se pudo comprimir');
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }

  async function onAdminPhotoPicked(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await compressImage(file);
      if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
      inspState.adminPhoto = { blob, url: URL.createObjectURL(blob), size: blob.size };
      const prev = $('#insp-admin-photo-preview');
      if (prev) prev.innerHTML = `<div class="adminphoto-prev"><img src="${inspState.adminPhoto.url}" alt="Foto del admin"><button class="x" id="insp-admin-photo-rm" type="button">✕</button></div>`;
      $('#insp-admin-photo-rm')?.addEventListener('click', () => {
        if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
        inspState.adminPhoto = null;
        if (prev) prev.innerHTML = '';
      });
    } catch (e) { console.error(e); toast('No se pudo procesar la foto.'); }
  }

  // Resolver una inspección pendiente: nota (review_notes) + foto opcional del admin.
  async function resolveInspection(status) {
    const insp = inspState.current;
    if (!insp) return;
    const note = (($('#insp-resolve-note') && $('#insp-resolve-note').value) || '').trim();
    if (status === 'rejected' && !note) { toast('Escribe el motivo del rechazo.'); return; }
    const btn = status === 'approved' ? $('#insp-approve-btn') : $('#insp-reject-btn');
    if (btn) btn.disabled = true;
    try {
      // 1) Subir la foto del admin (si adjuntó) y enlazarla a la inspección.
      if (inspState.adminPhoto) {
        const org = state.profile.organization_id;
        const today = new Date().toISOString().slice(0, 10);
        const path = `${org}/${insp.vehicle_id}/${today}/${insp.id}/admin-${Date.now()}.jpg`;
        await Api.uploadInspectionPhoto(path, inspState.adminPhoto.blob);
        await Api.addInspectionPhotos([{ inspection_id: insp.id, organization_id: org, photo_type: 'admin', storage_path: path, size_bytes: inspState.adminPhoto.size }]);
        if (inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
        inspState.adminPhoto = null;
      }
      // 2) Aprobar/rechazar con la nota (notifica al conductor si se rechaza).
      await inspDoReview(insp.id, status, note || null);
    } catch (e) {
      console.error(e);
      if (btn) btn.disabled = false;
      toast('No se pudo resolver: ' + (e.message || 'error'));
    }
  }

  async function openInspChecklist() {
    bindInspections();
    const view = $('#insp-v-config');
    view.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    inspShowView('config');
    // true al final: aquí sí se muestran los ítems de nivel preventivo (0073),
    // para que el admin pueda verlos y editarlos aunque no salgan a diario.
    try { inspState.checklist = await Api.listChecklistItems(false, true); }
    catch (e) { console.error(e); view.innerHTML = '<button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver</button><div class="card">No se pudo cargar el checklist.</div>'; return; }
    renderInspChecklist();
  }

  const CHECKLIST_CATEGORIES = ['Exterior', 'Llantas', 'Niveles y motor', 'Seguridad', 'Operación', 'Documentación'];

  function renderInspChecklist() {
    const items = inspState.checklist;
    const itemRow = (it, i) => `<div class="crow ${it.is_active ? '' : 'off'}" data-insp-ci="${it.id}">
      <span class="grip">⠿</span>
      <div class="ctxt"><b>${escapeHtml(it.label)}</b>${it.hint ? `<span>${escapeHtml(it.hint)}</span>` : ''}</div>
      <button class="cfgbtn" title="Subir" data-insp-cmove="up"${i === 0 ? ' disabled' : ''}><svg class="icon" style="width:15px;height:15px;transform:rotate(-90deg)"><use href="#i-chev"/></svg></button>
      <button class="cfgbtn" title="Bajar" data-insp-cmove="down"${i === items.length - 1 ? ' disabled' : ''}><svg class="icon" style="width:15px;height:15px;transform:rotate(90deg)"><use href="#i-chev"/></svg></button>
      <button class="tg ${it.is_active ? 'on' : ''}" title="Activar/desactivar" data-insp-ctoggle></button>
      <button class="cfgbtn" title="Editar" data-insp-cedit><svg class="icon" style="width:15px;height:15px"><use href="#i-edit"/></svg></button>
      <button class="cfgbtn danger" title="Eliminar" data-insp-cdel><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    // Agrupar por sección, conservando el orden global (índice i para reordenar).
    const order = [], byCat = new Map();
    items.forEach((it, i) => {
      const cat = it.category || 'Sin sección';
      if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
      byCat.get(cat).push(itemRow(it, i));
    });
    const rows = order.map(cat =>
      `<p class="csub" style="font-weight:800;color:var(--ink);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em;font-size:11px">${escapeHtml(cat)}</p>${byCat.get(cat).join('')}`
    ).join('');
    const catOptions = CHECKLIST_CATEGORIES.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    $('#insp-v-config').innerHTML = `
      <button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver a la cola</button>
      <div class="phead"><div><h1>Configurar checklist</h1><p>Define qué revisa el conductor al iniciar turno, agrupado por sección. Agrega, edita, reordena o desactiva ítems. Aplica a toda la flota.</p></div></div>
      <div class="card">
        <h2><svg class="icon"><use href="#i-list"/></svg>Ítems de la inspección</h2>
        <p class="csub">Usa las flechas para reordenar. Desactiva los que no apliquen sin perder el historial.</p>
        <div id="insp-citems">${rows || '<p style="color:var(--ink2);font-size:13px">Sin ítems. Agrega el primero abajo.</p>'}</div>
        <div class="additem">
          <div class="f"><label>Nuevo ítem</label><input id="insp-new-label" placeholder="Ej: Estado de la carrocería"></div>
          <div class="f"><label>Sección</label><input id="insp-new-cat" list="insp-cat-list" placeholder="Ej: Exterior"><datalist id="insp-cat-list">${catOptions}</datalist></div>
          <div class="f"><label>Pista / ayuda (opcional)</label><input id="insp-new-hint" placeholder="Ej: Rayones, golpes visibles"></div>
          <button class="btn sm" id="insp-add"><svg class="icon" style="width:15px;height:15px"><use href="#i-plus"/></svg>Agregar</button>
        </div>
        <div class="snapnote" style="margin-top:16px"><svg><use href="#i-info"/></svg><span><b>Auditoría:</b> cada inspección guarda una copia de los ítems tal como estaban ese día. Si cambias el checklist, las inspecciones viejas no se alteran.</span></div>
      </div>`;
  }

  function bindInspections() {
    const root = $('#inspections-ui');
    if (!root || root._inspBound) return;
    root._inspBound = true;
    root.addEventListener('click', async (e) => {
      const fb = e.target.closest('#insp-filter button');
      if (fb) { inspState.filter = fb.dataset.f; $$('#insp-filter button').forEach(b => b.classList.toggle('on', b === fb)); renderInspList(); return; }
      if (e.target.closest('#insp-to-config')) { openInspChecklist(); return; }
      if (e.target.closest('#insp-to-novedades')) { renderNovedades(); return; }
      if (e.target.closest('[data-insp-back]')) { renderInspections(); return; }
      // --- Novedades (incidents) ---
      if (e.target.closest('[data-nov-back]')) { renderInspections(); return; }
      if (e.target.closest('[data-nov-list]')) { renderNovedades(); return; }
      const nf = e.target.closest('#nov-filter button'); if (nf) { inspState.novFilter = nf.dataset.nf; renderNovList(); return; }
      const novOpen = e.target.closest('[data-nov-open]'); if (novOpen) { openNovedadDetail(novOpen.dataset.novOpen); return; }
      const novSt = e.target.closest('[data-nov-status]'); if (novSt) { const cur = inspState.novCurrent; if (cur) novChangeStatus(cur.id, novSt.dataset.novStatus); return; }
      const open = e.target.closest('[data-insp-open]'); if (open) { openInspectionDetail(open.dataset.inspOpen); return; }
      const ok = e.target.closest('[data-insp-ok]'); if (ok) { inspState.current = inspFindItem(ok.dataset.inspOk); inspDoReview(ok.dataset.inspOk, 'approved', null); return; }
      const rej = e.target.closest('[data-insp-rej]'); if (rej) { openInspectionDetail(rej.dataset.inspRej); return; }
      if (e.target.closest('#insp-admin-photo-btn')) { $('#insp-admin-photo-input')?.click(); return; }
      if (e.target.closest('#insp-approve-btn')) { resolveInspection('approved'); return; }
      if (e.target.closest('#insp-reject-btn')) { resolveInspection('rejected'); return; }
      const ph = e.target.closest('[data-insp-photo]'); if (ph) { const img = $('#insp-lbx-img'); if (img) { img.src = ph.dataset.inspPhoto; $('#insp-lbx').classList.add('show'); } return; }
      const tg = e.target.closest('[data-insp-ctoggle]');
      if (tg) { const row = tg.closest('[data-insp-ci]'); const it = inspState.checklist.find(x => x.id === row.dataset.inspCi); if (it) { const nv = !it.is_active; try { await Api.updateChecklistItem(it.id, { is_active: nv }); it.is_active = nv; renderInspChecklist(); } catch (err) { console.error(err); toast('No se pudo actualizar.'); } } return; }
      const del = e.target.closest('[data-insp-cdel]');
      if (del) { const row = del.closest('[data-insp-ci]'); const id = row.dataset.inspCi; if (!confirm('¿Eliminar este ítem del checklist?')) return; try { await Api.deleteChecklistItem(id); inspState.checklist = inspState.checklist.filter(x => x.id !== id); renderInspChecklist(); toast('Ítem eliminado.'); } catch (err) { console.error(err); toast('No se pudo eliminar.'); } return; }
      const ed = e.target.closest('[data-insp-cedit]');
      if (ed) {
        const row = ed.closest('[data-insp-ci]');
        const it = inspState.checklist.find(x => x.id === row.dataset.inspCi);
        if (!it) return;
        // Edición completa: nombre, sección y ayuda (Cancelar en el nombre aborta).
        const nv = prompt('Nombre del ítem:', it.label);
        if (nv === null) return;
        const label = nv.trim() || it.label;
        const nc = prompt('Sección (' + CHECKLIST_CATEGORIES.join(', ') + '):', it.category || '');
        const category = nc === null ? (it.category || null) : (nc.trim() || null);
        const nh = prompt('Pista / ayuda (opcional):', it.hint || '');
        const hint = nh === null ? (it.hint || null) : (nh.trim() || null);
        const fields = {};
        if (label !== it.label) fields.label = label;
        if (category !== (it.category || null)) fields.category = category;
        if (hint !== (it.hint || null)) fields.hint = hint;
        if (!Object.keys(fields).length) return;
        try { await Api.updateChecklistItem(it.id, fields); Object.assign(it, fields); renderInspChecklist(); toast('Ítem actualizado.'); }
        catch (err) { console.error(err); toast('No se pudo editar.'); }
        return;
      }
      const mv = e.target.closest('[data-insp-cmove]');
      if (mv) { const row = mv.closest('[data-insp-ci]'); const idx = inspState.checklist.findIndex(x => x.id === row.dataset.inspCi); const j = idx + (mv.dataset.inspCmove === 'up' ? -1 : 1); if (j < 0 || j >= inspState.checklist.length) return; const arr = inspState.checklist; const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp; renderInspChecklist(); try { await Api.reorderChecklistItems(arr.map(x => x.id)); } catch (err) { console.error(err); toast('No se pudo reordenar.'); } return; }
      if (e.target.closest('#insp-add')) { const label = (($('#insp-new-label') && $('#insp-new-label').value) || '').trim(); if (!label) { toast('Escribe el nombre del ítem.'); return; } const hint = (($('#insp-new-hint') && $('#insp-new-hint').value) || '').trim(); const category = (($('#insp-new-cat') && $('#insp-new-cat').value) || '').trim() || null; try { const created = await Api.createChecklistItem({ organizationId: state.profile.organization_id, label, hint, category, sortOrder: inspState.checklist.length + 1 }); inspState.checklist.push(created); renderInspChecklist(); toast('Ítem agregado.'); } catch (err) { console.error(err); toast('No se pudo agregar.'); } return; }
    });
    // Foto que adjunta el admin al resolver (input file → cambia, no click).
    root.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'insp-admin-photo-input') onAdminPhotoPicked(e.target);
    });
    const lbx = $('#insp-lbx');
    if (lbx) lbx.addEventListener('click', (e) => { if (e.target.id === 'insp-lbx' || e.target.id === 'insp-lbx-close') lbx.classList.remove('show'); });
  }

  async function refreshPendingBadge() {
    if (state.profile?.role !== 'admin') return;
    try {
      const ids = new Set(state.drivers.map(d => d.id));
      const pending = await Api.listPendingApprovals(state.currentWeek);
      const count = pending.filter(p => p.state === 'pending' && ids.has(p.profile_id)).length;
      const badge = $('#pending-badge');
      if (badge) {
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
      }
      updateAdminGreeting(count);
    } catch (e) { /* silent */ }
  }

