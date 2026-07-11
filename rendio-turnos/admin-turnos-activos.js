// admin-turnos-activos.js — Admin: turnos activos (red de seguridad, forzar cierre).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Turnos activos (admin) — red de seguridad: forzar cierre de un turno
  // colgado (libera el vehículo). El cierre normal del conductor (Etapa 2)
  // aún no existe; mientras tanto, el auto-cierre por cron + este botón evitan
  // que un turno quede activo para siempre.
  // ====================================================================
  const shiftsState = { items: [] };
  const SHIFT_ST_ES = {
    vehicle_selected: 'Eligiendo vehículo',
    inspection_in_progress: 'Inspección en curso',
    active: 'Activo',
    closing: 'Cerrando',
  };

  function shiftDriverName(s) {
    return (s.driver_profiles && s.driver_profiles.profiles && s.driver_profiles.profiles.full_name) || 'Conductor';
  }
  function shiftHoursActive(s) {
    if (!s.start_at) return 0;
    return (Date.now() - new Date(s.start_at).getTime()) / 3600000;
  }
  function fmtShiftAgo(s) {
    const h = shiftHoursActive(s);
    if (h < 1) return `${Math.max(0, Math.round(h * 60))} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${Math.round(h / 24)} días`;
  }
  function shiftWhen(s) {
    try {
      return new Date(s.start_at).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
    } catch (e) { return ''; }
  }
  function staleThreshold() {
    return (state.settings && state.settings.auto_close_hours != null) ? state.settings.auto_close_hours : 14;
  }

  // Badge "!" en la pestaña Ajustes: alerta (no número) cuando hay al menos un
  // vehículo con cambio de aceite pendiente (bloqueado o desbloqueado por conductor).
  function setOilBadge(vehs) {
    const b = $('#oil-badge');
    if (!b) return;
    const pending = (vehs || []).some(v => v.status === 'blocked' || v.oil_override_at);
    b.classList.toggle('hidden', !pending);
  }
  async function refreshOilBadge() {
    if (state.profile?.role !== 'admin') return;
    try { setOilBadge(await Api.listVehiclesForShift()); } catch (e) { /* silencioso: solo el badge */ }
  }

  async function refreshShiftsBadge() {
    if (state.profile?.role !== 'admin') return;
    try {
      const rows = await Api.listActiveShifts();
      shiftsState.items = rows;
      const stale = rows.filter(s => shiftHoursActive(s) >= staleThreshold()).length;
      const b = $('#shifts-badge');
      if (b) { b.textContent = String(stale); b.classList.toggle('hidden', !stale); }
    } catch (e) { /* silencioso: es solo el badge */ }
  }

  async function renderShifts() {
    bindShifts();
    const list = $('#shifts-list');
    if (list) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      shiftsState.items = await Api.listActiveShifts();
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar los turnos.</p>';
      return;
    }
    renderShiftsList();
  }

  function renderShiftsList() {
    const list = $('#shifts-list');
    if (!list) return;
    const thr = staleThreshold();
    const items = shiftsState.items;
    if ($('#shifts-count')) $('#shifts-count').textContent = items.length;
    const stale = items.filter(s => shiftHoursActive(s) >= thr).length;
    const b = $('#shifts-badge'); if (b) { b.textContent = String(stale); b.classList.toggle('hidden', !stale); }
    if (!items.length) {
      list.innerHTML = `<div class="sh-empty"><svg class="icon"><use href="#i-check"/></svg><h3>Sin turnos abiertos</h3><p>No hay turnos en curso ahora mismo.</p></div>`;
      return;
    }
    list.innerHTML = items.map(s => {
      const v = s.vehicles || {};
      const veh = `${escapeHtml(v.internal_code || '—')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}`;
      const isStale = shiftHoursActive(s) >= thr;
      const st = SHIFT_ST_ES[s.status] || escapeHtml(s.status);
      return `<div class="shift-row${isStale ? ' stale' : ''}" data-shift-row="${s.id}">
        <div class="shift-main">
          <b>${escapeHtml(shiftDriverName(s))}</b>
          <div class="shift-sub">${veh} · <span class="shift-st">${st}</span></div>
          <div class="shift-meta">Inicio ${escapeHtml(shiftWhen(s))} · activo hace ${escapeHtml(fmtShiftAgo(s))}${isStale ? ' <span class="shift-flag">⚠ colgado</span>' : ''}</div>
        </div>
        <button class="set-btn dark" data-shift-close="${s.id}">Forzar cierre</button>
      </div>`;
    }).join('');
  }

  function bindShifts() {
    const root = $('#shifts-ui');
    if (!root || root._shiftsBound) return;
    root._shiftsBound = true;
    root.addEventListener('click', async (e) => {
      if (e.target.closest('#shifts-refresh')) { renderShifts(); return; }
      const cb = e.target.closest('[data-shift-close]');
      if (cb) {
        const id = cb.dataset.shiftClose;
        const s = shiftsState.items.find(x => x.id === id);
        const who = s ? shiftDriverName(s) : 'este conductor';
        if (!confirm(`¿Forzar el cierre del turno de ${who}? Se cerrará el turno y el vehículo quedará disponible.`)) return;
        cb.disabled = true;
        try {
          await Api.forceCloseShift(id, 'Cierre manual desde Turnos activos');
          toast('Turno cerrado y vehículo liberado.');
          shiftsState.items = shiftsState.items.filter(x => x.id !== id);
          renderShiftsList();
        } catch (err) {
          console.error(err);
          cb.disabled = false;
          alert('No se pudo cerrar el turno: ' + (err.message || 'error'));
        }
        return;
      }
    });
  }

