// admin-personal.js — Admin: personal (workers) + ajustes/reglas.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: workers + settings
  // ====================================================================

  function workerCardHtml(w, opts) {
    const initial = (w.name || w.email).slice(0, 1).toUpperCase();
    const roleColor = opts.kind === 'admin' ? 'bg-brand' : (opts.kind === 'suspended' ? 'bg-slate-400' : 'bg-slate-200');
    const roleLabel = opts.kind === 'admin' ? 'Administrador' : (opts.kind === 'suspended' ? 'Suspendido' : 'Conductor');
    const roleTxt = opts.kind === 'admin' ? 'text-brand' : (opts.kind === 'suspended' ? 'text-amber-600' : 'text-slate-500');
    return `<div class="worker-card ${opts.kind === 'admin' ? 'coordinator' : ''} ${opts.kind === 'suspended' ? 'is-suspended' : ''}">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full ${roleColor} text-white font-bold flex items-center justify-center text-sm">${initial}</div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-ink truncate">${escapeHtml(w.name)}</p>
          <p class="text-xs text-slate-500 truncate">${escapeHtml(w.email)}</p>
          <p class="text-[10px] uppercase font-bold tracking-wider ${roleTxt} mt-0.5">${roleLabel}</p>
        </div>
      </div>
      ${opts.badges ? `<div class="worker-badges">${opts.badges}</div>` : ''}
      ${opts.actions || ''}
    </div>`;
  }

  async function renderWorkers() {
    const list = $('#workers-list');
    list.innerHTML = '<p class="text-sm text-slate-500">Cargando…</p>';
    let admins, drivers, strikeCounts, weekSusp, rulesRows, sched, closedShifts;
    try {
      [admins, drivers, strikeCounts, weekSusp, rulesRows, sched, closedShifts] = await Promise.all([
        Api.listAdmins(), Api.listAllDriversForAdmin(),
        Api.getActiveStrikeCounts().catch(() => new Map()),
        Api.getWeekSuspensions(state.currentWeek).catch(() => new Map()),
        Api.listDriverRules().catch(() => []),
        Api.getSchedule(state.currentWeek).catch(() => null),
        Api.listClosedShiftsAdmin().catch(() => []),
      ]);
    } catch (e) {
      list.innerHTML = `<p class="text-sm text-rose-600">Error cargando personal: ${escapeHtml(e.message)}</p>`;
      return;
    }
    state._strikeCounts = strikeCounts;
    // Km acumulado por persona (profile_id) desde los turnos cerrados.
    const kmByProfile = new Map();
    (closedShifts || []).forEach(s => {
      const pid = s.driver_profiles && s.driver_profiles.profile_id;
      if (!pid) return;
      const km = Math.max(0, (s.closing_km || 0) - (s.opening_km || 0));
      const cur = kmByProfile.get(pid) || { km: 0, turns: 0 };
      cur.km += km; cur.turns += 1; kmByProfile.set(pid, cur);
    });
    // ---- Reskin dirección C (maestro-detalle). VISUAL ONLY: reusa onWorkerAction y Api.* ----
    const rulesMap = Api.rulesToMap(rulesRows);              // { profileId: Set('day-shift') }
    const DAYS = Scheduler.DAYS;                              // mon..sun
    const DLABEL = { mon: 'Lun', tue: 'Mar', wed: 'Mié', thu: 'Jue', fri: 'Vie', sat: 'Sáb', sun: 'Dom' };

    // Carga de la semana (solo lectura, desde el horario guardado si existe).
    const loadOf = {};
    const bump = (id, k) => { const o = loadOf[id] = loadOf[id] || { am: 0, pm: 0, co: 0, total: 0 }; o[k]++; if (k !== 'co') o.total++; };
    if (sched && sched.data) DAYS.forEach(day => {
      const d = sched.data[day]; if (!d) return;
      (d.morning   || []).forEach(id => bump(id, 'am'));
      (d.afternoon || []).forEach(id => bump(id, 'pm'));
      (d.coord_am  || []).forEach(id => bump(id, 'co'));
      (d.coord_pm  || []).forEach(id => bump(id, 'co'));
    });

    const restText = (id) => {
      const set = rulesMap[id]; if (!set || !set.size) return '';
      const byDay = {};
      [...set].forEach(k => { const [day, sh] = k.split('-'); (byDay[day] = byDay[day] || []).push(sh); });
      return DAYS.filter(d => byDay[d]).map(d => {
        const sh = byDay[d].sort(); const both = sh.includes('am') && sh.includes('pm');
        return DLABEL[d] + (both ? '' : ' ' + sh.map(s => s.toUpperCase()).join('/'));
      }).join(' · ');
    };

    const people = [
      ...admins.map(a => ({ id: a.id, name: a.full_name, email: a.email, role: 'admin',
        coord: a.is_coordinator !== false, active: true, strikes: 0, suspWeek: false, rest: '',
        load: { am: 0, pm: 0, co: 0, total: 0 } })),
      ...drivers.map(d => ({ id: d.id, name: d.name, email: d.email, role: 'driver',
        coord: d.can_coordinate === true, active: d.active !== false,
        strikes: strikeCounts.get(d.id) || 0, suspWeek: weekSusp.has(d.id), suspRow: weekSusp.get(d.id) || null,
        km: (kmByProfile.get(d.id) || {}).km || 0, turns: (kmByProfile.get(d.id) || {}).turns || 0,
        rest: restText(d.id), load: loadOf[d.id] || { am: 0, pm: 0, co: 0, total: 0 } })),
    ];
    if (!state._pcSel || !people.find(p => p.id === state._pcSel)) state._pcSel = people[0] ? people[0].id : null;

    const PAL = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#9A8D7A'];
    const colorOf = (p) => { if (p.role === 'admin') return '#F26522';
      let h = 0; for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0; return PAL[h % PAL.length]; };
    const initials = (n) => { const a = (n || '').trim().split(/\s+/); return (((a[0] || '')[0] || '') + ((a[1] || '')[0] || '')).toUpperCase() || '·'; };
    const loadCls = (t) => t >= 5 ? 'hi' : t <= 2 ? 'lo' : '';
    const statusInfo = (p) => !p.active ? { cls: 'sus', dot: 'sus', label: 'Suspendido' }
      : p.suspWeek ? { cls: 'warn', dot: 'warn', label: 'Susp. esta semana' }
      : p.strikes >= 3 ? { cls: 'risk', dot: 'risk', label: 'En riesgo' }
      : { cls: '', dot: 'ok', label: 'Activo' };
    const strikesEl = (p) => { const risk = p.strikes >= 3 ? 'risk' : ''; let d = '';
      for (let i = 0; i < 3; i++) d += `<i class="${i < p.strikes ? 'f' : ''}"></i>`; return `<span class="strikes ${risk}">${d}</span>`; };
    const SI = '<svg class="pc-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

    list.classList.add('pc');
    list.innerHTML = `<div class="md">
      <div class="mdlist">
        <div class="lh"><div class="pc-search">${SI}<input id="pc-q" placeholder="Buscar persona…" autocomplete="off"></div></div>
        <div id="pc-rows"></div>
      </div>
      <div id="pc-detail"></div>
    </div>`;
    const rowsEl = list.querySelector('#pc-rows');
    const detEl = list.querySelector('#pc-detail');

    const rowHtml = (p) => {
      const si = statusInfo(p);
      return `<div class="mrow ${p.id === state._pcSel ? 'on' : ''} ${!p.active ? 'sus' : ''}" data-sel="${p.id}">
        <span class="av" style="background:${colorOf(p)}">${initials(p.name)}</span>
        <div class="nm"><b>${escapeHtml(p.name)}</b><span>${p.role === 'admin' ? 'Administrador' : (p.rest ? 'Descanso: ' + escapeHtml(p.rest) : 'Conductor')}</span></div>
        ${p.role === 'admin'
          ? `<span class="sdot ${si.dot}"></span>`
          : `<span class="mini ${loadCls(p.load.total)}"><i style="width:${Math.min(p.load.total / 5 * 100, 100)}%"></i></span>`}
      </div>`;
    };

    const detailHtml = (p) => {
      if (!p) return '';
      const si = statusInfo(p); const adm = p.role === 'admin'; const L = p.load;
      const nm = escapeAttr(p.name);
      return `<div class="detail">
        <div class="dhead">
          <span class="av" style="background:${colorOf(p)}">${initials(p.name)}</span>
          <div style="flex:1;min-width:0">
            <h2>${escapeHtml(p.name)}</h2><div class="mail">${escapeHtml(p.email || '')}</div>
            <div class="chips">
              <span class="statechip ${si.cls}"><span class="sdot ${si.dot}"></span>${si.label}</span>
              ${p.coord ? '<span class="statechip coord">★ Líder</span>' : ''}
              <span class="statechip role">${adm ? 'Administrador' : 'Conductor'}</span>
            </div>
          </div>
        </div>
        <div class="dbody">
          <div class="dblock">
            <h3>Carga de la semana</h3>
            ${adm ? '<p style="font-size:13px;color:var(--pc-ink2)">Los administradores no entran al reparto de turnos.</p>'
              : `<div class="bigload ${loadCls(L.total)}"><span class="num">${L.total}<s>/5</s></span><span class="bar"><i style="width:${Math.min(L.total / 5 * 100, 100)}%"></i></span></div>
                 <div class="breakdown"><div><b>${L.am}</b>AM</div><div><b>${L.pm}</b>PM</div><div><b>${L.co}</b>Coord</div></div>
                 ${!sched ? '<p style="font-size:11px;color:var(--pc-ink3);margin-top:10px">Sin horario guardado esta semana.</p>' : ''}`}
          </div>
          <div class="dblock">
            <h3>Reglas</h3>
            <div class="ruleitem"><span class="t">Puede liderar</span><span class="v">${p.coord ? 'Sí' : 'No'}</span></div>
            <div class="ruleitem"><span class="t">Descanso fijo</span><span class="v ${p.rest ? 'lock' : ''}">${p.rest ? '🔒 ' + escapeHtml(p.rest) : '—'}</span></div>
            ${p.suspWeek ? '<div class="ruleitem"><span class="t">Esta semana</span><span class="v">Suspendido</span></div>' : ''}
          </div>
          <div class="dblock full">
            <h3>Confiabilidad — strikes (${p.strikes}/3)</h3>
            ${adm ? '<p style="font-size:13px;color:var(--pc-ink2)">No aplica a administradores.</p>'
              : (p.strikes === 0 ? '<p style="font-size:13px;color:var(--pc-ink2)">Sin strikes registrados. Historial limpio.</p>'
                 : `<div style="display:flex;align-items:center;gap:12px">${strikesEl(p)}<span style="font-size:13px;color:var(--pc-ink2)">${p.strikes}/3 activos. Abre el historial para el detalle.</span></div>`)}
          </div>
          ${adm ? '' : `<div class="dblock full">
            <h3>Kilometraje acumulado</h3>
            <div style="display:flex;align-items:baseline;gap:10px">
              <span style="font-size:24px;font-weight:800;color:var(--pc-ink)">${(p.km || 0).toLocaleString('es-CO')}<span style="font-size:13px;font-weight:600;color:var(--pc-ink2)"> km</span></span>
              <span style="font-size:13px;color:var(--pc-ink2)">· ${p.turns || 0} turno(s) cerrado(s)</span>
            </div>
          </div>`}
        </div>
        <div class="dactions">
          <button class="pc-btn ${p.coord ? 'on' : ''}" data-act="${adm ? (p.coord ? 'coord-off' : 'coord-on') : (p.coord ? 'dcoord-off' : 'dcoord-on')}" data-id="${p.id}" data-name="${nm}">${p.coord ? '✓ Lidera' : '✕ No lidera'}</button>
          ${adm ? '' : `<button class="pc-btn" data-act="strike" data-id="${p.id}" data-name="${nm}">⚠ Strike</button>
          <button class="pc-btn" data-act="strikes-history" data-id="${p.id}" data-name="${nm}">Historial</button>
          ${p.suspWeek ? `<button class="pc-btn" data-act="lift-susp" data-id="${p.id}" data-name="${nm}" data-susp-id="${p.suspRow ? p.suspRow.id : ''}">✓ Levantar suspensión</button>` : ''}
          <div class="spacer"></div>
          <button class="pc-btn" data-act="${p.active ? 'suspend' : 'reactivate'}" data-id="${p.id}" data-name="${nm}">${p.active ? 'Suspender' : 'Reactivar'}</button>
          <button class="pc-btn danger" data-act="delete" data-id="${p.id}" data-name="${nm}">Eliminar</button>`}
        </div>
      </div>`;
    };

    const paint = () => {
      const q = (list.querySelector('#pc-q')?.value || '').toLowerCase().trim();
      const match = (p) => !q || p.name.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
      const adminRows = people.filter(p => p.role === 'admin' && match(p)).map(rowHtml).join('');
      const drvRows = people.filter(p => p.role === 'driver' && match(p)).map(rowHtml).join('');
      rowsEl.innerHTML =
        ((adminRows ? `<div class="pc-secth">Administradores</div>${adminRows}` : '') +
         (drvRows ? `<div class="pc-secth">Conductores</div>${drvRows}` : '')) ||
        '<div style="padding:16px;color:var(--pc-ink3);font-size:13px">Sin coincidencias.</div>';
      detEl.innerHTML = detailHtml(people.find(p => p.id === state._pcSel));
      detEl.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', () => onWorkerAction(btn)));
    };

    rowsEl.addEventListener('click', (e) => {
      const r = e.target.closest('[data-sel]'); if (!r) return;
      state._pcSel = r.dataset.sel; paint();
    });
    list.querySelector('#pc-q').addEventListener('input', paint);
    paint();
  }

  async function onWorkerAction(btn) {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const act = btn.dataset.act;

    // --- Strikes (Fase 2) ---
    if (act === 'strike') {
      const reason = prompt(`Razón del strike para ${name} (queda en el historial):`, '');
      if (reason === null) return;
      if (!reason.trim()) { toast('El strike necesita una razón.'); return; }
      btn.disabled = true;
      try {
        const before = state._strikeCounts?.get(id) || 0;
        await Api.addStrike({ profileId: id, reason: reason.trim(), weekStart: state.currentWeek, createdBy: state.profile.id });
        const reaching3 = before + 1 >= 3;
        notify([id], reaching3 ? 'Suspendido la próxima semana' : 'Recibiste un strike',
          reaching3 ? 'Acumulaste 3 strikes: quedas suspendido la próxima semana.' : `Motivo: ${reason.trim()}`, '/');
        await renderWorkers();
        // Si era el 3º, el trigger ya creó la suspensión de la próxima semana.
        if (reaching3) {
          alert(`⚠ ${name} llegó a 3 strikes. Quedó SUSPENDIDO automáticamente la semana siguiente. Los strikes se reinician.`);
        } else {
          toast(`Strike registrado (${before + 1}/3).`);
        }
      } catch (e) {
        alert('Error al registrar el strike: ' + e.message);
        btn.disabled = false;
      }
      return;
    }
    if (act === 'strikes-history') {
      btn.disabled = true;
      try {
        const strikes = await Api.listDriverStrikes(id);
        openStrikesModal(name, id, strikes);
      } catch (e) {
        alert('Error al cargar el historial: ' + e.message);
      }
      btn.disabled = false;
      return;
    }
    // Levantar la suspensión semanal (la que arma el 3º strike o una manual).
    if (act === 'lift-susp') {
      const suspId = btn.dataset.suspId;
      if (!suspId) { toast('No encuentro la suspensión de esta semana.'); return; }
      if (!confirm(`¿Levantar la suspensión de esta semana de ${name}? Volverá a entrar en la generación de turnos y podrá operar.`)) return;
      btn.disabled = true;
      try {
        await Api.liftSuspension(suspId, state.profile.id);
        notify([id], 'Suspensión levantada', 'Tu suspensión de esta semana fue levantada. Ya puedes operar normalmente.', '/');
        await renderWorkers();
        toast('Suspensión levantada.');
      } catch (e) {
        alert('Error al levantar la suspensión: ' + e.message);
        btn.disabled = false;
      }
      return;
    }

    if (act === 'delete' && !confirm(`¿Eliminar a ${name}? Desaparece del sistema y de la generación. Los horarios pasados donde aparece NO se borran.`)) return;
    if (act === 'suspend' && !confirm(`¿Suspender a ${name}? Saldrá de la generación de horarios hasta que lo reactives.`)) return;
    btn.disabled = true;
    const msg = {
      suspend: 'Conductor suspendido.', reactivate: 'Conductor reactivado.',
      delete: 'Conductor eliminado.',
      'coord-off': `${name} ya no entra como Líder de turno.`, 'coord-on': `${name} ahora entra como Líder de turno.`,
      'dcoord-off': `${name} ya no entra como Líder de turno.`, 'dcoord-on': `${name} ahora puede liderar.`,
    };
    try {
      if (act === 'suspend') await Api.setProfileActive(id, false);
      else if (act === 'reactivate') await Api.setProfileActive(id, true);
      else if (act === 'delete') await Api.softDeleteProfile(id);
      else if (act === 'coord-off') await Api.setAdminCoordinator(id, false);
      else if (act === 'coord-on') await Api.setAdminCoordinator(id, true);
      else if (act === 'dcoord-off') await Api.setDriverCanCoordinate(id, false);
      else if (act === 'dcoord-on') await Api.setDriverCanCoordinate(id, true);
      state.drivers = await Api.listDrivers();
      state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false }));
      await renderWorkers();
      toast(msg[act] || 'Hecho.');
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  // Modal de historial de strikes (inyectado al vuelo).
  function openStrikesModal(name, profileId, strikes) {
    document.getElementById('strikes-modal')?.remove();
    const fmt = iso => { try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };
    const statusOf = s => s.voided_at ? '<span class="strike-tag strike-tag-void">Anulado</span>'
      : s.consumed_at ? '<span class="strike-tag strike-tag-consumed">Consumido</span>'
      : '<span class="strike-tag strike-tag-active">Activo</span>';
    const rows = strikes.length ? strikes.map(s => `
      <div class="strike-item">
        <div class="strike-item-main">
          <p class="strike-item-reason">${escapeHtml(s.reason)}</p>
          <p class="strike-item-meta">${fmt(s.created_at)} · semana ${s.week_start_date}</p>
        </div>
        <div class="strike-item-side">
          ${statusOf(s)}
          ${!s.voided_at ? `<button data-void-id="${s.id}" data-consumed="${s.consumed_at ? '1' : ''}" class="wk-btn wk-strike-void">Anular</button>` : ''}
        </div>
      </div>`).join('') : '<p class="text-sm text-slate-500">Sin strikes registrados.</p>';
    const active = strikes.filter(s => !s.voided_at && !s.consumed_at).length;
    const overlay = document.createElement('div');
    overlay.id = 'strikes-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h3 class="modal-title">Strikes — ${escapeHtml(name)}</h3>
          <p class="modal-subtitle">Activos: <strong>${active}/3</strong></p>
        </div>
        <div class="strikes-list">${rows}</div>
        <div class="modal-actions">
          <button id="strikes-modal-close" class="wk-btn">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#strikes-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-void-id]').forEach(b => {
      b.addEventListener('click', async () => {
        const consumed = b.dataset.consumed === '1';
        const msg = consumed
          ? '¿Anular este strike YA consumido? Queda marcado en el historial, pero esto NO levanta una suspensión ya aplicada. Para desbloquear al conductor usa “Levantar suspensión” en su ficha.'
          : '¿Anular este strike? No contará para la suspensión (queda en historial).';
        if (!confirm(msg)) return;
        b.disabled = true;
        try {
          await Api.voidStrike(b.dataset.voidId, state.profile.id);
          overlay.remove();
          await renderWorkers();
          toast('Strike anulado.');
        } catch (e) { alert('Error: ' + e.message); b.disabled = false; }
      });
    });
  }

  function renderSettings() {
    $('#setting-morning-label').value = state.settings.morning_label;
    $('#setting-afternoon-label').value = state.settings.afternoon_label;
    $('#setting-morning-slots').value = state.settings.morning_slots;
    $('#setting-afternoon-slots').value = state.settings.afternoon_slots;
    if ($('#setting-coord-slots')) $('#setting-coord-slots').value = state.settings.coord_slots != null ? state.settings.coord_slots : 1;
    if ($('#setting-shift-hours')) $('#setting-shift-hours').value = state.settings.shift_hours != null ? state.settings.shift_hours : 12;
    if ($('#setting-auto-close-hours')) $('#setting-auto-close-hours').value = state.settings.auto_close_hours != null ? state.settings.auto_close_hours : 14;
    if ($('#setting-reservation-idle')) $('#setting-reservation-idle').value = state.settings.reservation_idle_minutes != null ? state.settings.reservation_idle_minutes : 60;
    if ($('#setting-strike-limit')) $('#setting-strike-limit').value = state.settings.strike_limit != null ? state.settings.strike_limit : 3;
    if ($('#setting-fast-start-enabled')) $('#setting-fast-start-enabled').checked = state.settings.fast_start_enabled !== false;
    if ($('#setting-fast-start-from')) $('#setting-fast-start-from').value = state.settings.fast_start_from_hour != null ? state.settings.fast_start_from_hour : 12;
    if ($('#setting-fast-start-to')) $('#setting-fast-start-to').value = state.settings.fast_start_to_hour != null ? state.settings.fast_start_to_hour : 16;
    if ($('#setting-inspection-grace')) $('#setting-inspection-grace').value = state.settings.inspection_grace_minutes != null ? state.settings.inspection_grace_minutes : 90;
    if ($('#setting-aux-wait')) $('#setting-aux-wait').value = state.settings.aux_wait_minutes != null ? state.settings.aux_wait_minutes : 5;
    if ($('#setting-aux-lead')) $('#setting-aux-lead').value = state.settings.aux_min_lead_hours != null ? state.settings.aux_min_lead_hours : 6;
    const S = state.settings;
    if ($('#setting-route-merge')) $('#setting-route-merge').value = S.route_merge_window_min != null ? S.route_merge_window_min : 30;
    if ($('#setting-route-service')) $('#setting-route-service').value = S.route_service_min != null ? S.route_service_min : 3;
    if ($('#setting-route-traffic')) $('#setting-route-traffic').value = S.route_traffic_factor != null ? S.route_traffic_factor : 1.05;
    if ($('#setting-route-buffer')) $('#setting-route-buffer').value = S.route_airport_buffer_min != null ? S.route_airport_buffer_min : 10;
    renderPriorityList();
    renderRulesEditor();
    renderVehiclesSettings();
  }

  // --- Vehículos (admin) — alta/baja/edición de la flota desde Ajustes ---
  const VEH_STATUS_ES = { available: 'Disponible', in_use: 'En uso', reserved: 'Reservado', maintenance: 'En revisión', blocked: 'Cambio de aceite' };
  let vehiclesEditId = null;       // si está editando un vehículo existente
  let vehiclesCache = [];          // para poblar el form al editar
  async function renderVehiclesSettings() {
    const box = $('#vehicles-list');
    if (!box) return;
    box.innerHTML = '<p class="set-hint">Cargando…</p>';
    let vehs = [];
    try { vehs = await Api.listVehiclesForShift(); }
    catch (e) { console.error(e); box.innerHTML = '<p class="set-hint">No se pudieron cargar los vehículos.</p>'; return; }
    vehiclesCache = vehs;
    setOilBadge(vehs);   // refresca el "!" de Ajustes con la lista ya cargada
    if (!vehs.length) { box.innerHTML = '<p class="set-hint">Aún no hay vehículos. Agrega el primero abajo.</p>'; return; }
    box.innerHTML = vehs.map(v => {
      const overridden = !!v.oil_override_at;               // conductor lo desbloqueó
      const oilPending = v.status === 'blocked' || overridden; // aceite vencido (con o sin override)
      // Botón "Cambio de aceite hecho": para carros bloqueados por aceite Y para
      // los que el conductor desbloqueó (siguen disponibles pero con aceite pendiente).
      const oilBtn = oilPending
        ? `<button class="set-btn dark" data-veh-oilchange="${v.id}" title="Registrar cambio de aceite">Cambio de aceite hecho</button>`
        : '';
      // 'maintenance' (NO APTO) se regresa a servicio por la vía normal.
      const restoreBtn = (v.status === 'maintenance')
        ? `<button class="set-btn dark" data-veh-restore="${v.id}" title="Regresar a servicio">Regresar a servicio</button>`
        : '';
      const oilAlert = oilPending
        ? `<span style="display:block;margin-top:3px;color:#dc2626;font-weight:800;font-size:11px">🛢️ Cambio de aceite pendiente${overridden ? ' · desbloqueado por conductor' : ''}</span>`
        : '';
      const intv = v.maintenance_interval_km ? ` · aceite c/${(v.maintenance_interval_km).toLocaleString('es-CO')} km` : '';
      return `<div class="veh-row" data-veh="${v.id}">
      <div class="veh-info"><b>${escapeHtml(v.internal_code || v.license_plate || 'Auto')}</b><span>${escapeHtml(v.license_plate || '')} · ${escapeHtml([v.brand, v.model].filter(Boolean).join(' ') || '—')} · ${v.capacity} pas · ${(v.current_km || 0).toLocaleString('es-CO')} km${intv}</span>${oilAlert}</div>
      <span class="veh-stat st-${v.status}">${VEH_STATUS_ES[v.status] || escapeHtml(v.status || '')}</span>
      ${oilBtn}${restoreBtn}
      <button class="set-btn ghost" data-veh-edit="${v.id}" title="Editar" style="height:34px">Editar</button>
      <button class="veh-del" data-veh-del="${v.id}" title="Eliminar vehículo"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    }).join('');
  }

  function onEditVehicle(id) {
    const v = vehiclesCache.find(x => x.id === id); if (!v) return;
    vehiclesEditId = id;
    const set = (f, val) => { const el = $('#new-veh-' + f); if (el) el.value = val != null ? val : ''; };
    set('code', v.internal_code); set('plate', v.license_plate); set('brand', v.brand); set('model', v.model);
    set('capacity', v.capacity || 4); set('km', v.current_km || 0);
    set('interval', v.maintenance_interval_km || 7000); set('lastmaint', v.last_maintenance_km != null ? v.last_maintenance_km : '');
    set('soat', v.soat_expires_at || ''); set('tecno', v.tecnomec_expires_at || '');
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Guardar cambios';
    const st = $('#new-veh-state'); if (st) st.textContent = `Editando ${v.internal_code || v.license_plate || ''}…`;
    $('#new-veh-code')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function resetVehicleForm() {
    vehiclesEditId = null;
    ['code', 'plate', 'brand', 'model', 'soat', 'tecno', 'lastmaint'].forEach(f => { const el = $('#new-veh-' + f); if (el) el.value = ''; });
    if ($('#new-veh-capacity')) $('#new-veh-capacity').value = '4';
    if ($('#new-veh-km')) $('#new-veh-km').value = '0';
    if ($('#new-veh-interval')) $('#new-veh-interval').value = '7000';
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-plus"/></svg>Agregar vehículo';
    const st = $('#new-veh-state'); if (st) st.textContent = '';
  }

  async function onCreateVehicle() {
    const code = ($('#new-veh-code') && $('#new-veh-code').value || '').trim();
    const plate = ($('#new-veh-plate') && $('#new-veh-plate').value || '').trim();
    if (!code || !plate) { toast('Código interno y placa son obligatorios.'); return; }
    const km = Math.max(0, parseInt($('#new-veh-km').value, 10) || 0);
    const interval = Math.max(500, parseInt($('#new-veh-interval') && $('#new-veh-interval').value, 10) || 7000);
    const lastRaw = ($('#new-veh-lastmaint') && $('#new-veh-lastmaint').value) || '';
    // Baseline de mantto: si lo dejan vacío, usa el km actual (evita bug 4).
    const lastMaint = (lastRaw !== '' && !isNaN(parseInt(lastRaw, 10))) ? Math.max(0, parseInt(lastRaw, 10)) : km;
    const veh = {
      organization_id: state.profile.organization_id,
      internal_code: code,
      license_plate: plate.toUpperCase(),
      brand: ($('#new-veh-brand').value || '').trim() || null,
      model: ($('#new-veh-model').value || '').trim() || null,
      capacity: Math.min(4, Math.max(1, parseInt($('#new-veh-capacity').value, 10) || 4)),
      current_km: km,
      last_maintenance_km: lastMaint,
      maintenance_interval_km: interval,
      soat_expires_at: $('#new-veh-soat').value || null,
      tecnomec_expires_at: $('#new-veh-tecno').value || null,
    };
    const btn = $('#new-veh-create-btn'); const st = $('#new-veh-state');
    const editing = !!vehiclesEditId;
    btn.disabled = true; if (st) st.textContent = editing ? 'Guardando…' : 'Creando…';
    try {
      if (editing) {
        const { organization_id, ...patch } = veh;   // no se cambia la organización
        await Api.updateVehicle(vehiclesEditId, patch);
        toast('Vehículo actualizado.');
      } else {
        await Api.createVehicle(veh);
        toast('Vehículo agregado.');
      }
      resetVehicleForm();
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      if (st) st.textContent = '';
      const msg = /unique|duplicate/i.test(e.message || '') ? 'Ya existe un vehículo con ese código o placa.' : (e.message || 'error');
      alert((editing ? 'No se pudo actualizar: ' : 'No se pudo agregar: ') + msg);
    } finally { btn.disabled = false; }
  }

  async function onDeleteVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    if (v && v.status === 'in_use' && !confirm('Este vehículo está EN USO en un turno activo. ¿Eliminarlo igual? Mejor espera a que el turno cierre.')) return;
    if (!confirm('¿Eliminar este vehículo? Dejará de aparecer para los conductores. El historial de turnos e inspecciones se conserva.')) return;
    try { await Api.softDeleteVehicle(id); toast('Vehículo eliminado.'); renderVehiclesSettings(); }
    catch (e) { console.error(e); alert('No se pudo eliminar: ' + (e.message || 'error')); }
  }

  // 'maintenance' (p. ej. NO APTO): regresar a servicio sin tocar el contador.
  // El caso 'blocked'/override por aceite va por onRegisterOilChange (0041).
  async function onRestoreVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    if (!confirm(`¿Regresar ${label} a servicio? Quedará Disponible para los conductores.`)) return;
    try {
      await Api.returnVehicleToService(id, 'Regreso a servicio desde Ajustes');
      toast('Vehículo disponible.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      const msg = /VEHICLE_HAS_ACTIVE_SHIFT/.test(e.message || '')
        ? 'Hay un turno en curso con ese vehículo. Ciérralo primero en Turnos activos.'
        : (e.message || 'error');
      alert('No se pudo regresar a servicio: ' + msg);
    }
  }
  // Admin registra el cambio de aceite (0041): reinicia el contador, limpia el
  // override del conductor y regresa a servicio si estaba bloqueado.
  async function onRegisterOilChange(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    const wasOverride = v && v.oil_override_at;
    const msg = wasOverride
      ? `¿Registrar el cambio de aceite de ${label}? Un conductor lo desbloqueó y sigue pendiente. Se reinicia el contador de km.`
      : `¿Registrar el cambio de aceite de ${label}? Quedará Disponible y se reinicia el contador de km.`;
    if (!confirm(msg)) return;
    try {
      await Api.registerOilChange(id, 'Cambio de aceite registrado desde Ajustes');
      toast('Cambio de aceite registrado.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      alert('No se pudo registrar el cambio de aceite: ' + (e.message || 'error'));
    }
  }

  async function safeVehicles() { try { return await Api.listVehiclesForShift(); } catch (e) { return []; } }

  // --- Editor de parametrización: descansos fijos por conductor (Fase 4) ---
  // Pinta sobre los elementos estáticos del panel de Ajustes (paleta limpia):
  // <select #rules-driver-select> + grilla <div #rules-grid>.
  function renderRulesEditor() {
    const sel = $('#rules-driver-select');
    const grid = $('#rules-grid');
    if (!sel || !grid) return;
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) {
      sel.innerHTML = '';
      grid.innerHTML = '<p class="set-hint">No hay conductores activos.</p>';
      return;
    }
    if (!state._rulesDriverId || !drivers.some(d => d.id === state._rulesDriverId)) {
      state._rulesDriverId = drivers[0].id;
    }
    const cur = state._rulesDriverId;

    sel.innerHTML = drivers.map(d => `<option value="${d.id}"${d.id === cur ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
    sel.onchange = (e) => { state._rulesDriverId = e.target.value; renderRulesEditor(); };

    const rulesFor = new Set((state.rules || [])
      .filter(r => r.profile_id === cur)
      .map(r => `${r.day_of_week}-${r.shift}`));
    grid.innerHTML = Scheduler.DAYS.map((dayKey, di) => {
      const label = Scheduler.DAY_LABELS_ES[dayKey];
      const wknd = di >= 5 ? ' wknd' : '';
      const cell = (shift) => {
        const on = rulesFor.has(`${di}-${shift}`);
        const lock = on ? '<svg class="icon"><use href="#i-lock"/></svg>' : '';
        return `<button class="set-tg${on ? ' on' : ''}" data-rule-day="${di}" data-rule-shift="${shift}">${lock}${shift.toUpperCase()}</button>`;
      };
      return `<div class="set-drow${wknd}"><span class="set-dname">${label}</span><div class="set-twin">${cell('am')}${cell('pm')}</div></div>`;
    }).join('');

    grid.querySelectorAll('.set-tg').forEach(b => {
      b.addEventListener('click', () => onToggleRule(cur, parseInt(b.dataset.ruleDay, 10), b.dataset.ruleShift, b));
    });
  }

  async function onToggleRule(profileId, dayOfWeek, shift, btn) {
    const wasOn = btn.classList.contains('on');
    btn.disabled = true;
    try {
      if (wasOn) await Api.deleteDriverRule({ profileId, dayOfWeek, shift });
      else await Api.addDriverRule({ profileId, dayOfWeek, shift, createdBy: state.profile.id });
      await loadRules();          // recarga state.rules + Scheduler.setRules
      renderRulesEditor();
      // Si la consolidada está visible, refrescarla para reflejar el cambio.
      if (state.activeTab === 'availability') refreshAvailabilityMatrix();
      toast(wasOn ? 'Bloqueo quitado.' : 'Bloqueo agregado.');
    } catch (e) {
      alert('Error al guardar la regla: ' + e.message);
      btn.disabled = false;
    }
  }

  // Prioridad por antigüedad. 1=nuevo, 2=con tiempo, 3=antiguo (desempate SUAVE);
  // 4=máxima (Julián): prioridad DURA, entra siempre primero (ver scheduler.js).
  const SR_LABELS = { 1: 'Nuevo', 2: 'Con tiempo', 3: 'Antiguo', 4: 'Máxima' };
  function renderPriorityList() {
    const box = $('#priority-list');
    if (!box) return;
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) {
      box.innerHTML = '<p class="set-hint">No hay conductores activos.</p>';
      return;
    }
    box.innerHTML = drivers.map(d => {
      const p = d.priority || 1;
      const segs = [1, 2, 3, 4].map(n =>
        `<button data-srval="${n}" class="${p === n ? 'on s' + n : ''}"><span class="num">${n}</span>${p === n ? SR_LABELS[n] : ''}</button>`
      ).join('');
      return `<div class="set-prow">
        <span class="set-avt" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span>
        <div class="set-pinfo"><b>${escapeHtml(d.name)}</b><span>${escapeHtml(d.email || '')}</span></div>
        <div class="set-seg3" data-prio-id="${d.id}">${segs}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.set-seg3').forEach(seg => {
      seg.querySelectorAll('button[data-srval]').forEach(btn => {
        btn.addEventListener('click', () => onChangePriority(seg.dataset.prioId, parseInt(btn.dataset.srval, 10)));
      });
    });
  }

  async function onChangePriority(id, rawValue) {
    const value = parseInt(rawValue, 10) || 1;
    const d = state.drivers.find(x => x.id === id);
    if (d && d.priority === value) return;            // ya está en ese valor
    const seg = document.querySelector(`.set-seg3[data-prio-id="${id}"]`);
    if (seg) seg.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      await Api.setDriverPriority(id, value);
      if (d) d.priority = value;
      renderPriorityList();
      toast('Prioridad actualizada.');
    } catch (e) {
      alert('Error al guardar prioridad: ' + e.message);
      renderPriorityList();
    }
  }

  // --- Crear conductor desde Ajustes ---
  // Caracteres seguros (sin O/0, l/I/1) para que el conductor no se confunda
  // al teclear la contraseña.
  function generateReadablePassword(len = 10) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  function onGenerateDriverPassword() {
    $('#new-driver-password').value = generateReadablePassword(10);
  }

  async function onCreateDriver() {
    const btn = $('#new-driver-create-btn');
    const stateEl = $('#new-driver-state');
    const name = $('#new-driver-name').value.trim();
    const email = $('#new-driver-email').value.trim().toLowerCase();
    const password = $('#new-driver-password').value;
    const priority = parseInt($('#new-driver-priority').value, 10) || 1;
    const canCoord = $('#new-driver-can-coord').checked;

    const setState = (text, tone) => {
      stateEl.textContent = text;
      stateEl.className = {
        ok: 'text-xs text-emerald-700 font-semibold',
        err: 'text-xs text-rose-600 font-semibold',
        info: 'text-xs text-slate-500',
      }[tone] || 'text-xs text-slate-500';
    };

    if (!name) { setState('Falta el nombre completo.', 'err'); return; }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setState('Email inválido.', 'err'); return; }
    if (!password || password.length < 8) { setState('Contraseña mínimo 8 caracteres.', 'err'); return; }

    btn.disabled = true;
    btn.textContent = 'Creando…';
    setState('Creando cuenta en Supabase…', 'info');
    try {
      const created = await Api.createDriver({
        email, password, full_name: name,
        priority, can_coordinate: canCoord,
      });
      // Refresca la lista de conductores en memoria para que aparezca al instante.
      state.drivers = await Api.listDrivers();
      // Mensaje copiable con las credenciales.
      const credLine = `${email} / ${password}`;
      setState(`✓ Creado. Credenciales: ${credLine}`, 'ok');
      toast(`Conductor "${name}" creado. Pásale: ${credLine}`);
      // Limpia el form (deja el toast/cred visible).
      $('#new-driver-name').value = '';
      $('#new-driver-email').value = '';
      $('#new-driver-password').value = '';
      $('#new-driver-priority').value = '1';
      $('#new-driver-can-coord').checked = false;
      // Si está la vista Personal abierta, también refrescarla.
      if (state.activeTab === 'workers') await renderWorkers();
      renderPriorityList();
    } catch (e) {
      setState(`✗ ${e.message || 'Error creando conductor'}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear conductor';
    }
  }

  async function onSaveSettings() {
    const next = {
      morning_label: $('#setting-morning-label').value,
      afternoon_label: $('#setting-afternoon-label').value,
      morning_slots: Math.max(1, parseInt($('#setting-morning-slots').value, 10) || 2),
      afternoon_slots: Math.max(1, parseInt($('#setting-afternoon-slots').value, 10) || 2),
      coord_slots: Math.max(1, parseInt($('#setting-coord-slots') && $('#setting-coord-slots').value, 10) || 1),
      shift_hours: Math.max(1, parseInt($('#setting-shift-hours') && $('#setting-shift-hours').value, 10) || 12),
      auto_close_hours: Math.min(72, Math.max(1, parseInt($('#setting-auto-close-hours') && $('#setting-auto-close-hours').value, 10) || 14)),
      reservation_idle_minutes: Math.min(240, Math.max(5, parseInt($('#setting-reservation-idle') && $('#setting-reservation-idle').value, 10) || 60)),
      strike_limit: Math.min(10, Math.max(1, parseInt($('#setting-strike-limit') && $('#setting-strike-limit').value, 10) || 3)),
      fast_start_enabled: !!($('#setting-fast-start-enabled') && $('#setting-fast-start-enabled').checked),
      fast_start_from_hour: Math.min(23, Math.max(0, parseInt($('#setting-fast-start-from') && $('#setting-fast-start-from').value, 10) || 12)),
      fast_start_to_hour: Math.min(24, Math.max(1, parseInt($('#setting-fast-start-to') && $('#setting-fast-start-to').value, 10) || 16)),
      inspection_grace_minutes: Math.min(480, Math.max(15, parseInt($('#setting-inspection-grace') && $('#setting-inspection-grace').value, 10) || 90)),
      aux_wait_minutes: Math.min(60, Math.max(1, parseInt($('#setting-aux-wait') && $('#setting-aux-wait').value, 10) || 5)),
      // 0 = sin anticipación mínima. `|| 6` lo pisaría, así que se valida aparte.
      aux_min_lead_hours: (() => {
        const n = parseInt($('#setting-aux-lead') && $('#setting-aux-lead').value, 10);
        return isNaN(n) ? 6 : Math.min(72, Math.max(0, n));
      })(),
      // Optimizador. Igual que aux_min_lead_hours, 0 es un valor VÁLIDO
      // (0 = no juntar oleadas), así que `|| default` lo pisaría.
      route_merge_window_min: (() => {
        const n = parseInt($('#setting-route-merge') && $('#setting-route-merge').value, 10);
        return isNaN(n) ? 30 : Math.min(120, Math.max(0, n));
      })(),
      route_service_min: (() => {
        const n = parseInt($('#setting-route-service') && $('#setting-route-service').value, 10);
        return isNaN(n) ? 3 : Math.min(20, Math.max(0, n));
      })(),
      route_traffic_factor: (() => {
        const n = parseFloat($('#setting-route-traffic') && $('#setting-route-traffic').value);
        return isNaN(n) ? 1.05 : Math.min(2, Math.max(1, n));
      })(),
      route_airport_buffer_min: (() => {
        const n = parseInt($('#setting-route-buffer') && $('#setting-route-buffer').value, 10);
        return isNaN(n) ? 10 : Math.min(45, Math.max(0, n));
      })(),
    };
    try {
      await Api.saveSettings(next);
      state.settings = { ...state.settings, ...next };
      const saved = $('#set-saved-params');
      if (saved) { saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1800); }
      toast('Ajustes guardados.');
    } catch (e) {
      alert('Error al guardar ajustes: ' + e.message);
    }
  }

