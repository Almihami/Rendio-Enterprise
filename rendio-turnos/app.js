(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const state = {
    profile: null,
    drivers: [],
    admins: [],
    settings: null,
    currentWeek: Scheduler.startOfWeekISO(new Date()),
    availability: {},
    schedule: null,
    activeTab: 'schedule',
    ownAvail: null,
  };

  // ====================================================================
  // Boot
  // ====================================================================

  async function boot() {
    // Safety net: el splash se quita siempre a los 5s, pase lo que pase.
    setTimeout(dismissSplash, 5000);

    bindGlobalEvents();
    setupInstallPrompt();

    const splashHold = new Promise((r) => setTimeout(r, 2500));

    let nextAction = () => showLogin();
    try {
      const session = await Api.getSession();
      if (session) {
        const profile = await Api.getCurrentProfile();
        if (!profile || profile.is_active === false) {
          await Api.signOut();
          nextAction = () => showLogin('Cuenta inactiva o sin perfil. Contacta a tu admin.');
        } else {
          state.profile = profile;
          nextAction = () => enterApp();
        }
      }
    } catch (e) {
      console.error(e);
      nextAction = () => showLogin('No pudimos verificar tu sesión. Inicia sesión de nuevo.');
    }

    await splashHold;
    const result = nextAction();
    dismissSplash();
    if (result && typeof result.then === 'function') {
      result.catch((e) => console.error(e));
    }
  }

  function dismissSplash() {
    const splash = document.getElementById('screen-splash');
    if (!splash) return;
    splash.classList.add('fade-out');
    setTimeout(() => splash.classList.add('hidden'), 700);
  }

  function bindGlobalEvents() {
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#logout-btn').addEventListener('click', onLogout);
    $('#logout-btn-mobile').addEventListener('click', onLogout);

    $('#auto-resolve-btn').addEventListener('click', onAutoResolve);

    $('#reason-modal-cancel').addEventListener('click', closeReasonModal);
    $('#reason-modal-save').addEventListener('click', saveReasonModal);
    $('#reason-modal').addEventListener('click', (e) => {
      if (e.target.id === 'reason-modal') closeReasonModal();
    });

    $('#state-picker-cancel').addEventListener('click', closeStatePicker);
    $('#state-picker').addEventListener('click', (e) => {
      if (e.target.id === 'state-picker') closeStatePicker();
    });
    $$('#state-picker .state-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => pickState(btn.dataset.pick));
    });

    $$('#admin-nav .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });

    $('#prev-week').addEventListener('click', () => navigateWeek(-7));
    $('#next-week').addEventListener('click', () => navigateWeek(7));
    $('#week-start-input').addEventListener('change', (e) => {
      state.currentWeek = Scheduler.startOfWeekISO(e.target.value);
      refreshScheduleData();
    });
    $('#generate-btn').addEventListener('click', onGenerate);
    $('#save-btn').addEventListener('click', () => onSaveSchedule(false));
    $('#publish-btn').addEventListener('click', () => onSaveSchedule(true));
    $('#clear-schedule-btn').addEventListener('click', onClearSchedule);

    $('#save-settings-btn').addEventListener('click', onSaveSettings);

    $('#conflict-cancel').addEventListener('click', closeConflictModal);
    $('#conflict-apply').addEventListener('click', applyConflictsAndGenerate);
    $('#conflict-modal').addEventListener('click', (e) => {
      if (e.target.id === 'conflict-modal') closeConflictModal();
    });

    $('#cell-editor-cancel').addEventListener('click', closeCellEditor);
    $('#cell-editor-save').addEventListener('click', saveCellEditor);
    $('#cell-editor').addEventListener('click', (e) => {
      if (e.target.id === 'cell-editor') closeCellEditor();
    });

    $('#driver-prev-week').addEventListener('click', () => navigateDriverWeek(-7));
    $('#driver-next-week').addEventListener('click', () => navigateDriverWeek(7));
    $('#driver-save-btn').addEventListener('click', onDriverSave);
    $('#driver-mark-all-available').addEventListener('click', onMarkAllAvailable);
  }

  function onMarkAllAvailable() {
    const week = Scheduler.weekDates(state.currentWeek);
    let dirtyCount = 0;
    for (const d of week) {
      const av = state.ownAvail[d.key];
      if (!av) continue;
      if (av.am !== 'available') dirtyCount++;
      if (av.pm !== 'available') dirtyCount++;
    }
    if (dirtyCount === 0) {
      flashSaveState('✓ Ya estás disponible toda la semana', 'emerald');
      return;
    }
    const msg = dirtyCount === 1
      ? 'Vas a quitar 1 marcación de descanso o no-disponibilidad de esta semana. ¿Continuar?'
      : `Vas a quitar ${dirtyCount} marcaciones de descanso o no-disponibilidad de esta semana. ¿Continuar?`;
    if (!confirm(msg)) return;
    for (const d of week) {
      state.ownAvail[d.key] = {
        am: 'available',
        pm: 'available',
        am_reason: null,
        pm_reason: null,
        am_request: state.ownAvail[d.key]?.am_request || null,
        pm_request: state.ownAvail[d.key]?.pm_request || null,
      };
    }
    renderDriverDays();
    flashSaveState('Cambios sin guardar', 'amber');
  }

  function getGreetingPrefix() {
    const h = new Date().getHours();
    if (h >= 5  && h < 12) return 'Buenos días';
    if (h >= 12 && h < 19) return 'Buenas tardes';
    if (h >= 19 && h < 24) return 'Buenas noches';
    return 'Hola';
  }

  function firstNameOf(profile) {
    if (!profile) return '';
    const fn = (profile.full_name || '').trim().split(/\s+/)[0];
    return fn || profile.email || '';
  }

  function weekLabelES(startISO) {
    const m = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    const a = new Date(startISO + 'T00:00:00');
    const b = new Date(startISO + 'T00:00:00'); b.setDate(b.getDate() + 6);
    return `${a.getDate()} ${m[a.getMonth()]} al ${b.getDate()} ${m[b.getMonth()]}`;
  }

  function updateDriverGreeting() {
    const name = firstNameOf(state.profile);
    $('#driver-greeting').textContent = `${getGreetingPrefix()}, ${name}`;
    const week = Scheduler.weekDates(state.currentWeek);
    const marked = week.filter(d => !!state.ownAvail[d.key]).length;
    const total = week.length;
    const range = weekLabelES(state.currentWeek);
    let sub;
    if (marked === 0) {
      sub = `Marca tu disponibilidad para la semana del ${range}.`;
    } else if (marked < total) {
      const missing = total - marked;
      sub = `Te falta${missing === 1 ? '' : 'n'} ${missing} día${missing === 1 ? '' : 's'} por marcar para la semana del ${range}.`;
    } else {
      sub = `Tu disponibilidad para la semana del ${range} está lista. Puedes ajustarla si lo necesitas.`;
    }
    $('#driver-greeting-sub').textContent = sub;
  }

  function updateAdminGreeting(pendingCount) {
    const name = firstNameOf(state.profile);
    $('#admin-greeting').textContent = `${getGreetingPrefix()}, ${name}`;
    let sub;
    if (typeof pendingCount === 'number' && pendingCount > 0) {
      sub = `Tienes ${pendingCount} solicitud${pendingCount === 1 ? '' : 'es'} pendiente${pendingCount === 1 ? '' : 's'} de revisar.`;
    } else {
      sub = 'Aquí gestionas horarios, disponibilidad, solicitudes y personal.';
    }
    $('#admin-greeting-sub').textContent = sub;
  }

  function flashSaveState(text, tone) {
    const el = $('#driver-save-state');
    const toneCls = {
      emerald: 'text-xs text-emerald-600 font-semibold flex-1',
      amber:   'text-xs text-amber-600 font-semibold flex-1',
      rose:    'text-xs text-rose-600 flex-1',
    }[tone] || 'text-xs text-slate-500 flex-1';
    el.textContent = text;
    el.className = toneCls;
  }

  function showLogin(err) {
    $('#screen-login').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
    const errBox = $('#login-error');
    if (err) { errBox.textContent = err; errBox.classList.remove('hidden'); }
    else { errBox.classList.add('hidden'); }
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    const btn = $('#login-submit');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    try {
      await Api.signIn(email, password);
      const profile = await Api.getCurrentProfile();
      if (!profile) throw new Error('Tu cuenta no tiene perfil asociado.');
      state.profile = profile;
      await enterApp();
    } catch (err) {
      showLogin(err.message || 'Error iniciando sesión');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  }

  async function onLogout() {
    await Api.signOut();
    state.profile = null;
    location.reload();
  }

  async function enterApp() {
    $('#screen-login').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    $('#role-label').textContent = state.profile.role === 'admin' ? 'Administrador' : 'Conductor';
    $('#role-label-mobile').textContent = state.profile.role === 'admin' ? 'Admin' : 'Conductor';

    state.settings = await Api.getSettings();

    if (state.profile.role === 'admin') {
      $('#admin-nav').classList.remove('hidden');
      $('#admin-greeting-block').classList.remove('hidden');
      // Admins gestionan desde PC: el botón Instalar (PWA) no aplica para ellos.
      $('#install-btn')?.classList.add('hidden');
      $('#install-btn-mobile')?.classList.add('hidden');
      updateAdminGreeting();
      state.drivers = await Api.listDrivers();
      state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false }));
      setTab('schedule');
      $('#driver-save-bar').classList.add('hidden');
    } else {
      $('#admin-nav').classList.add('hidden');
      $('#admin-greeting-block').classList.add('hidden');
      $('#screen-driver').classList.remove('hidden');
      $('#driver-save-bar').classList.remove('hidden');
      await refreshDriverView();
    }
  }

  // ====================================================================
  // Tabs (admin)
  // ====================================================================

  function setTab(name) {
    state.activeTab = name;
    $('#screen-driver').classList.add('hidden');
    $$('#admin-nav .tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    $$('section[data-panel]').forEach(s => {
      s.classList.toggle('hidden', s.dataset.panel !== name);
    });
    // El saludo "Buenas… (Admin)" solo en Horario; el resto ya tiene su propia descripción.
    $('#admin-greeting-block')?.classList.toggle('hidden', name !== 'schedule');
    if (name === 'schedule') refreshScheduleData();
    if (name === 'availability') refreshAvailabilityMatrix();
    if (name === 'approvals') refreshApprovals();
    if (name === 'workers') renderWorkers();
    if (name === 'settings') renderSettings();
  }

  async function refreshPendingBadge() {
    if (state.profile?.role !== 'admin') return;
    try {
      const ids = new Set(state.drivers.map(d => d.id));
      const pending = await Api.listPendingApprovals(state.currentWeek);
      const count = pending.filter(p => p.state === 'pending' && ids.has(p.profile_id)).length;
      const badge = $('#pending-badge');
      badge.textContent = String(count);
      badge.classList.toggle('hidden', count === 0);
      updateAdminGreeting(count);
    } catch (e) { /* silent */ }
  }

  // ====================================================================
  // Admin: schedule
  // ====================================================================

  async function refreshScheduleData() {
    $('#week-start-input').value = state.currentWeek;
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const sch = await Api.getSchedule(state.currentWeek);
    state.schedule = sch ? sch.data : null;
    $('#published-pill').classList.toggle('hidden', !sch?.published);
    renderSchedule();
    refreshPendingBadge();
  }

  function navigateWeek(deltaDays) {
    state.currentWeek = Scheduler.addDays(state.currentWeek, deltaDays);
    refreshScheduleData();
  }

  function nameOf(id) {
    const w = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
    return w ? w.name : '—';
  }

  const COORD_KINDS = ['coord_am', 'coord_pm'];
  const isCoordKind = (k) => COORD_KINDS.includes(k);
  const coordinatorAdmins = () => state.admins.filter(a => a.is_coordinator);
  // Daniel: conductor que también coordina (≥1 jornada/semana; ese día no conduce).
  const FLEX_COORD_EMAIL = 'daniel.alvarez@rendio.co'; // Daniel Alvarez Torres
  const flexCoordinator = () => state.drivers.find(d => (d.email || '').toLowerCase() === FLEX_COORD_EMAIL) || null;
  const coordPeople = () => {
    const fc = flexCoordinator();
    return fc ? [...coordinatorAdmins(), fc] : coordinatorAdmins();
  };

  function renderSchedule() {
    const week = Scheduler.weekDates(state.currentWeek);
    const header = $('#schedule-header');
    header.innerHTML = '<th class="cell-label">FRANJA DE SERVICIO</th>' +
      week.map(d => `<th>${d.label} ${d.dayNum}</th>`).join('');

    const settings = state.settings;
    const sched = state.schedule;
    const body = $('#schedule-body');
    body.innerHTML = '';

    for (let i = 0; i < settings.morning_slots; i++) {
      const tr = document.createElement('tr');
      tr.className = 'row-morning';
      if (i === 0) {
        tr.innerHTML = `<td class="cell-label" rowspan="${settings.morning_slots}">MAÑANA (${settings.morning_label})</td>` +
          week.map(d => cellHtml(sched, d.key, 'morning', i)).join('');
      } else {
        tr.innerHTML = week.map(d => cellHtml(sched, d.key, 'morning', i)).join('');
      }
      body.appendChild(tr);
    }

    for (let i = 0; i < settings.afternoon_slots; i++) {
      const tr = document.createElement('tr');
      tr.className = 'row-afternoon';
      if (i === 0) {
        tr.innerHTML = `<td class="cell-label" rowspan="${settings.afternoon_slots}">TARDE (${settings.afternoon_label})</td>` +
          week.map(d => cellHtml(sched, d.key, 'afternoon', i)).join('');
      } else {
        tr.innerHTML = week.map(d => cellHtml(sched, d.key, 'afternoon', i)).join('');
      }
      body.appendChild(tr);
    }

    // Coordinación (admins) — 1 fila AM + 1 fila PM
    [['coord_am', 'COORDINACIÓN AM'], ['coord_pm', 'COORDINACIÓN PM']].forEach(([kind, label]) => {
      const tr = document.createElement('tr');
      tr.className = 'row-coord';
      tr.innerHTML = `<td class="cell-label">${label}</td>` +
        week.map(d => cellHtml(sched, d.key, kind, 0)).join('');
      body.appendChild(tr);
    });

    const restCount = Math.max(1, state.drivers.length - settings.morning_slots - settings.afternoon_slots);
    for (let i = 0; i < restCount; i++) {
      const tr = document.createElement('tr');
      tr.className = 'row-rest';
      if (i === 0) {
        tr.innerHTML = `<td class="cell-label" rowspan="${restCount}">DESCANSO</td>` +
          week.map(d => cellHtml(sched, d.key, 'rest', i)).join('');
      } else {
        tr.innerHTML = week.map(d => cellHtml(sched, d.key, 'rest', i)).join('');
      }
      body.appendChild(tr);
    }

    body.querySelectorAll('.shift-cell').forEach(cell => {
      cell.addEventListener('click', () => openCellEditor(cell));
    });

    renderWorkerSummary();
  }

  function cellHtml(sched, day, kind, index) {
    if (!sched) return `<td class="shift-cell text-slate-300" data-day="${day}" data-kind="${kind}" data-index="${index}">—</td>`;
    const arr = sched[day]?.[kind];
    const id = arr?.[index];
    const label = id ? nameOf(id).toUpperCase() : '—';
    return `<td class="shift-cell" data-day="${day}" data-kind="${kind}" data-index="${index}">${label}</td>`;
  }

  function renderWorkerSummary() {
    const box = $('#worker-summary');
    if (!state.schedule) { box.innerHTML = '<p class="text-slate-500 text-xs">Aún no se ha generado un horario.</p>'; return; }
    const counts = {};
    state.drivers.forEach(d => counts[d.id] = { m: 0, t: 0, r: 0 });
    Scheduler.DAYS.forEach(key => {
      const day = state.schedule[key];
      if (!day) return;
      (day.morning || []).forEach(id => counts[id] && counts[id].m++);
      (day.afternoon || []).forEach(id => counts[id] && counts[id].t++);
      (day.rest || []).forEach(id => counts[id] && counts[id].r++);
    });
    box.innerHTML = state.drivers.map(d => {
      const c = counts[d.id];
      const total = c.m + c.t;
      return `<div class="flex justify-between border-b border-slate-100 py-1">
        <span>${d.name}</span>
        <span class="text-slate-600 text-xs">${total} turnos · ${c.m}M / ${c.t}T · ${c.r} descansos</span>
      </div>`;
    }).join('');
  }

  // Descansos ("prefer_rest") agrupados por día+jornada cuyo grupo tiene
  // cobertura suficiente (mustWork === 0): se pueden aprobar solos, sin admin.
  // Misma fórmula de cobertura que usa el modal de conflictos.
  function restRequestIdsWithCoverage(restPending) {
    const groups = {};
    restPending.forEach(r => {
      const key = `${r.day_of_week}-${r.shift}`;
      (groups[key] = groups[key] || { day_of_week: r.day_of_week, shift: r.shift, items: [] }).items.push(r);
    });
    const okIds = [];
    Object.values(groups).forEach(g => {
      const dayKey = Scheduler.DAYS[g.day_of_week];
      const slots = g.shift === 'am' ? state.settings.morning_slots : state.settings.afternoon_slots;
      const groupIds = new Set(g.items.map(i => i.profile_id));
      const othersCanWork = state.drivers.filter(d =>
        !groupIds.has(d.id) &&
        Scheduler.getRawState(state.availability, d.id, dayKey, g.shift) !== 'unavailable'
      ).length;
      const mustWork = Math.max(0, slots - othersCanWork);
      if (mustWork === 0) g.items.forEach(r => okIds.push(r.id));
    });
    return okIds;
  }

  async function onGenerate() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const ids = new Set(state.drivers.map(d => d.id));
    let all = [];
    try {
      all = await Api.listPendingApprovals(state.currentWeek);
    } catch (e) {
      conflictState = { allRequests: [] };
      await doGenerate();
      return;
    }
    let pending = all.filter(r => r.state === 'pending' && ids.has(r.profile_id));

    // 1) "Descanso" sin conflicto de cobertura → se aprueba solo (sin admin).
    //    Lo forzado (mustWork>0) y "No disponible" NO se tocan: van al admin.
    const autoIds = restRequestIdsWithCoverage(pending.filter(r => r.kind === 'prefer_rest'));
    if (autoIds.length) {
      for (const id of autoIds) {
        await Api.resolveApproval(id, 'approved', 'Aprobado automático: hay cobertura suficiente');
      }
      all = await Api.listPendingApprovals(state.currentWeek);
      pending = all.filter(r => r.state === 'pending' && ids.has(r.profile_id));
    }
    conflictState = { allRequests: all };

    // 2) Lo que queda (descansos sin cobertura + "No disponible") → el admin decide.
    if (pending.length) {
      openConflictModal(pending);
      return;
    }
    await doGenerate();
  }

  async function doGenerate() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const { schedule, warnings } = Scheduler.generateSchedule({
      drivers: state.drivers,
      admins: coordinatorAdmins(),
      settings: { morningSlots: state.settings.morning_slots, afternoonSlots: state.settings.afternoon_slots },
      availability: state.availability,
      flexCoordinatorId: flexCoordinator()?.id || null,
      weekStart: state.currentWeek,
      // Nonce nuevo por clic: cada "Generar" baraja distinto (siempre válido).
      // Lo que el admin elija se fija al Guardar/Publicar.
      nonce: Date.now() + '-' + Math.random(),
    });
    state.schedule = schedule;
    const box = $('#schedule-warnings');
    if (warnings.length) {
      box.innerHTML = '<strong>Advertencias:</strong><ul class="list-disc pl-5 mt-1">' +
        warnings.map(w => `<li>${w}</li>`).join('') + '</ul>';
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
    renderSchedule();
    toast('Horario generado. Guardar / Publicar para persistir.');
  }

  // ====================================================================
  // Modal de conflictos previo a "Generar"
  // ====================================================================

  let conflictState = null;

  function openConflictModal(pending) {
    const driversById = {};
    state.drivers.forEach(d => { driversById[d.id] = d; });

    // Descansos ya aprobados esta semana, para repartir con equidad.
    const approvedRestByDriver = {};
    (conflictState.allRequests || []).forEach(r => {
      if (r.state === 'approved') approvedRestByDriver[r.profile_id] = (approvedRestByDriver[r.profile_id] || 0) + 1;
    });

    // Agrupar pendientes por día + jornada.
    const groups = {};
    pending.forEach(r => {
      const key = `${r.day_of_week}-${r.shift}`;
      (groups[key] = groups[key] || { day_of_week: r.day_of_week, shift: r.shift, items: [] }).items.push(r);
    });

    const decisions = {};
    const rendered = Object.values(groups)
      .sort((a, b) => a.day_of_week - b.day_of_week || a.shift.localeCompare(b.shift))
      .map(g => {
        const dayKey = Scheduler.DAYS[g.day_of_week];
        const slots = g.shift === 'am' ? state.settings.morning_slots : state.settings.afternoon_slots;
        const groupIds = new Set(g.items.map(i => i.profile_id));
        // Conductores que SÍ pueden cubrir esa jornada (no marcados "No disponible") y no están pidiendo descanso aquí.
        const othersCanWork = state.drivers.filter(d =>
          !groupIds.has(d.id) &&
          Scheduler.getRawState(state.availability, d.id, dayKey, g.shift) !== 'unavailable'
        ).length;
        const mustWork = Math.max(0, slots - othersCanWork);
        const canApprove = Math.max(0, g.items.length - mustWork);
        const forced = mustWork > 0;

        // Sugerencia equitativa: descansa primero quien menos descansos lleva.
        const ordered = [...g.items].sort((a, b) =>
          (approvedRestByDriver[a.profile_id] || 0) - (approvedRestByDriver[b.profile_id] || 0)
        );
        ordered.forEach((r, idx) => { decisions[r.id] = idx < canApprove ? 'approved' : 'rejected'; });

        const rows = g.items.map(r => {
          const nm = driversById[r.profile_id]?.name || 'Conductor eliminado';
          const kind = r.kind === 'unavailable' ? 'No disponible' : 'Descanso';
          const reason = r.reason ? ` · <span class="text-slate-500">${escapeHtml(r.reason)}</span>` : '';
          return `<div class="conflict-row" data-req="${r.id}">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-ink truncate">${escapeHtml(nm)}</p>
              <p class="text-xs text-slate-500">${kind}${reason}</p>
            </div>
            <div class="flex gap-1.5 shrink-0">
              <button data-req="${r.id}" data-dec="approved" class="conf-dec text-xs px-3 py-1.5 rounded-lg border font-semibold">Descansa</button>
              <button data-req="${r.id}" data-dec="rejected" class="conf-dec text-xs px-3 py-1.5 rounded-lg border font-semibold">Trabaja</button>
            </div>
          </div>`;
        }).join('');

        const note = forced
          ? `<p class="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 mt-1">⚠ Conflicto forzado: al menos ${mustWork} debe(n) seguir trabajando — no hay con quién cubrir los ${slots} cupos.</p>`
          : `<p class="text-xs text-emerald-700 mt-1">Hay cobertura suficiente: puedes aprobar todos los descansos.</p>`;

        return `<div class="conflict-group ${forced ? 'is-forced' : ''}">
          <div class="flex items-center justify-between">
            <h4 class="font-bold text-sm text-ink">${Scheduler.DAY_LABELS_ES[dayKey]} · ${g.shift.toUpperCase()}</h4>
            <span class="text-[10px] uppercase font-bold tracking-wide ${forced ? 'text-rose-600' : 'text-emerald-600'}">${forced ? 'Forzado' : 'Libre'}</span>
          </div>
          ${note}
          <div class="mt-2 space-y-1.5">${rows}</div>
        </div>`;
      }).join('');

    conflictState.decisions = decisions;
    $('#conflict-list').innerHTML = rendered;
    syncConflictButtons();
    $('#conflict-list').querySelectorAll('.conf-dec').forEach(btn => {
      btn.addEventListener('click', () => {
        conflictState.decisions[btn.dataset.req] = btn.dataset.dec;
        syncConflictButtons();
      });
    });
    $('#conflict-modal').classList.remove('hidden');
  }

  function syncConflictButtons() {
    $('#conflict-list').querySelectorAll('.conf-dec').forEach(btn => {
      const sel = conflictState.decisions[btn.dataset.req];
      const on = sel === btn.dataset.dec;
      btn.classList.toggle('conf-dec-on', on);
      if (btn.dataset.dec === 'approved') {
        btn.classList.toggle('conf-rest', on);
      } else {
        btn.classList.toggle('conf-work', on);
      }
    });
  }

  function closeConflictModal() {
    $('#conflict-modal').classList.add('hidden');
  }

  async function applyConflictsAndGenerate() {
    const btn = $('#conflict-apply');
    btn.disabled = true;
    btn.textContent = 'Aplicando…';
    try {
      const entries = Object.entries(conflictState.decisions);
      for (const [id, dec] of entries) {
        await Api.resolveApproval(id, dec, dec === 'rejected' ? 'Resuelto al generar el horario' : null);
      }
      closeConflictModal();
      await doGenerate();
      refreshPendingBadge();
      toast(`${entries.length} solicitud(es) resueltas. Horario generado.`);
    } catch (e) {
      alert('Error aplicando decisiones: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Aplicar y generar';
    }
  }

  async function onSaveSchedule(publish) {
    if (!state.schedule) { toast('Genera o edita el horario primero.'); return; }
    try {
      await Api.saveSchedule(state.currentWeek, state.schedule, { published: publish, drivers: [...state.drivers, ...state.admins] });
      $('#published-pill').classList.toggle('hidden', !publish);
      toast(publish ? 'Horario publicado.' : 'Horario guardado.');
    } catch (e) {
      alert('Error al guardar: ' + e.message);
    }
  }

  async function onClearSchedule() {
    if (!confirm('¿Borrar el horario guardado de esta semana?')) return;
    try {
      await Api.deleteSchedule(state.currentWeek);
      state.schedule = null;
      $('#published-pill').classList.add('hidden');
      renderSchedule();
      toast('Horario eliminado.');
    } catch (e) {
      alert('Error al borrar: ' + e.message);
    }
  }

  // ====================================================================
  // Admin: cell editor
  // ====================================================================

  let editingCell = null;

  function openCellEditor(cell) {
    editingCell = cell;
    const kind = cell.dataset.kind;
    const day = cell.dataset.day;
    $('#cell-editor-title').textContent =
      `Editar ${kindLabel(kind)} · ${Scheduler.DAY_LABELS_ES[day]}`;
    const select = $('#cell-editor-select');
    const options = ['<option value="">— vacío —</option>'];
    const people = isCoordKind(kind) ? coordPeople() : state.drivers;
    people.forEach(p => options.push(`<option value="${p.id}">${p.name}</option>`));
    select.innerHTML = options.join('');
    if (state.schedule) {
      const idx = parseInt(cell.dataset.index, 10);
      const id = state.schedule[day]?.[kind]?.[idx];
      if (id) select.value = id;
    }
    $('#cell-editor').classList.remove('hidden');
  }

  function kindLabel(k) {
    return { morning: 'Mañana', afternoon: 'Tarde', rest: 'Descanso', coord_am: 'Coordinación AM', coord_pm: 'Coordinación PM' }[k] || k;
  }

  function closeCellEditor() {
    editingCell = null;
    $('#cell-editor').classList.add('hidden');
  }

  function saveCellEditor() {
    if (!editingCell) return;
    const kind = editingCell.dataset.kind;
    const day = editingCell.dataset.day;
    const index = parseInt(editingCell.dataset.index, 10);
    const id = $('#cell-editor-select').value || null;

    state.schedule = state.schedule || Scheduler.emptySchedule();
    const sched = state.schedule;
    Scheduler.DAYS.forEach(d => {
      sched[d] = sched[d] || {};
      ['morning', 'afternoon', 'rest', 'coord_am', 'coord_pm'].forEach(k => {
        sched[d][k] = sched[d][k] || [];
      });
    });

    // Las celdas de coordinación (admins) son independientes de las de conductores.
    const scope = isCoordKind(kind) ? COORD_KINDS : ['morning', 'afternoon', 'rest'];

    if (id) {
      scope.forEach(k => {
        sched[day][k] = (sched[day][k] || []).filter(x => x !== id);
      });
    }

    while (sched[day][kind].length <= index) sched[day][kind].push(null);
    sched[day][kind][index] = id;

    if (!isCoordKind(kind)) rebuildRestRow(day);
    closeCellEditor();
    renderSchedule();
  }

  function rebuildRestRow(day) {
    const sched = state.schedule[day];
    const used = new Set([...(sched.morning || []), ...(sched.afternoon || [])].filter(Boolean));
    sched.rest = state.drivers.filter(d => !used.has(d.id)).map(d => d.id);
  }

  // ====================================================================
  // Admin: approvals tab
  // ====================================================================

  async function refreshApprovals() {
    const container = $('#approvals-container');
    container.innerHTML = '<p class="text-sm text-slate-500 p-4">Cargando…</p>';
    try {
      const driversById = {};
      state.drivers.forEach(d => { driversById[d.id] = d; });
      // Ignora solicitudes huérfanas (conductor borrado/suspendido o no vigente).
      const items = (await Api.listPendingApprovals(state.currentWeek))
        .filter(r => driversById[r.profile_id]);

      const groups = {};
      items.forEach(r => {
        const key = `${r.day_of_week}-${r.shift}`;
        groups[key] = groups[key] || { day_of_week: r.day_of_week, shift: r.shift, items: [] };
        groups[key].items.push(r);
      });

      const sortedKeys = Object.keys(groups).sort((a, b) => {
        const ga = groups[a], gb = groups[b];
        if (ga.day_of_week !== gb.day_of_week) return ga.day_of_week - gb.day_of_week;
        return ga.shift.localeCompare(gb.shift);
      });

      if (!sortedKeys.length) {
        container.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl p-8 text-center shadow-card">
          <p class="text-slate-400 text-3xl mb-2">✓</p>
          <p class="text-sm text-slate-600 font-medium">No hay solicitudes pendientes esta semana.</p>
        </div>`;
        refreshPendingBadge();
        return;
      }

      container.innerHTML = sortedKeys.map(k => {
        const g = groups[k];
        const dayLabel = Scheduler.DAY_LABELS_ES[Scheduler.DAYS[g.day_of_week]] || '';
        const pendingCount = g.items.filter(i => i.state === 'pending').length;
        const conflict = pendingCount >= 2;
        return `<div class="approval-card ${conflict ? 'has-conflict' : ''}">
          <div class="flex items-center justify-between mb-1">
            <h3 class="font-bold text-base text-ink">${dayLabel} · ${g.shift.toUpperCase()}</h3>
            ${conflict ? '<span class="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-1 rounded-full">CONFLICTO</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 mb-2">${pendingCount} pendiente${pendingCount !== 1 ? 's' : ''}</p>
          ${g.items.map(i => approvalRowHtml(i, driversById)).join('')}
        </div>`;
      }).join('');

      container.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => onApprovalAction(btn));
      });
    } catch (e) {
      container.innerHTML = `<p class="text-sm text-rose-600 p-3">Error cargando solicitudes: ${e.message}</p>`;
    }
    refreshPendingBadge();
  }

  function approvalRowHtml(r, driversById) {
    const name = driversById[r.profile_id]?.name || 'Conductor eliminado';
    const kindLabel = r.kind === 'unavailable' ? 'No disponible' : 'Descanso';
    const stateBadge = approvalBadgeHtml(r);
    const reasonLine = r.kind === 'unavailable'
      ? `<p class="text-xs text-slate-700 mt-1"><strong>Razón:</strong> ${escapeHtml(r.reason || '(sin texto)')}</p>`
      : '';
    const adminNoteLine = r.admin_note ? `<p class="text-xs text-slate-500 mt-1 italic">Nota: ${escapeHtml(r.admin_note)}</p>` : '';
    const actions = r.state === 'pending' ? `
      <div class="flex gap-1.5 shrink-0 ml-2">
        <button data-id="${r.id}" data-action="approve"
                class="text-xs px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-semibold">Aprobar</button>
        <button data-id="${r.id}" data-action="reject"
                class="text-xs px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 font-semibold">Rechazar</button>
      </div>` : '';
    return `<div class="approval-row">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-ink">${escapeHtml(name)} ${stateBadge}</p>
        <p class="text-xs text-slate-500">${kindLabel}</p>
        ${reasonLine}
        ${adminNoteLine}
      </div>
      ${actions}
    </div>`;
  }

  async function onApprovalAction(btn) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    let note = null;
    if (action === 'reject') {
      note = prompt('Nota para el conductor (opcional):') || null;
    }
    btn.disabled = true;
    try {
      await Api.resolveApproval(id, action === 'approve' ? 'approved' : 'rejected', note);
      await refreshApprovals();
      toast(action === 'approve' ? '✓ Aprobada' : '✗ Rechazada');
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  async function onAutoResolve() {
    if (!confirm('¿Auto-aprobar solicitudes de fin de semana que sean singleton (1 solo conductor)?')) return;
    try {
      const n = await Api.runAutoResolve();
      toast(`${n} auto-aprobada(s)`);
      await refreshApprovals();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  function approvalBadgeHtml(req) {
    if (!req) return '';
    const label = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }[req.state] || req.state;
    return `<span class="approval-badge" data-state="${req.state}">${label}</span>`;
  }

  // ====================================================================
  // Admin: availability matrix
  // ====================================================================

  async function refreshAvailabilityMatrix() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const week = Scheduler.weekDates(state.currentWeek);
    const header = $('#availability-header');
    header.innerHTML = '<th class="text-left p-2">Conductor</th>' +
      week.map(d => `<th class="p-2">${d.label.slice(0,3)} ${d.dayNum}</th>`).join('');
    const body = $('#availability-body');
    body.innerHTML = '';
    state.drivers.forEach(d => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="font-medium p-2">${escapeHtml(d.name)}</td>` +
        week.map(day => {
          const av = state.availability[d.id]?.[day.key] || { am: 'available', pm: 'available' };
          const amTip = av.am_reason ? ` title="${escapeAttr(av.am_reason)}"` : '';
          const pmTip = av.pm_reason ? ` title="${escapeAttr(av.pm_reason)}"` : '';
          const amBadge = miniBadge(av.am_request);
          const pmBadge = miniBadge(av.pm_request);
          return `<td class="p-1">
            <div class="flex gap-1 justify-center items-center">
              <button data-id="${d.id}" data-day="${day.key}" data-shift="am" data-state="${av.am}" class="avail-pill"${amTip}>AM${amBadge}</button>
              <button data-id="${d.id}" data-day="${day.key}" data-shift="pm" data-state="${av.pm}" class="avail-pill"${pmTip}>PM${pmBadge}</button>
            </div>
          </td>`;
        }).join('');
      body.appendChild(tr);
    });

    body.querySelectorAll('.avail-pill').forEach(btn => {
      btn.addEventListener('click', () => rotateAvailPill(btn));
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function miniBadge(req) {
    if (!req) return '';
    const dot = { pending: '🟦', approved: '✅', rejected: '✖' }[req.state] || '';
    return ` ${dot}`;
  }

  async function rotateAvailPill(btn) {
    const order = ['available', 'prefer_rest', 'unavailable'];
    const next = order[(order.indexOf(btn.dataset.state) + 1) % order.length];
    const id = btn.dataset.id;
    const day = btn.dataset.day;
    const shift = btn.dataset.shift;
    state.availability[id] = state.availability[id] || {};
    state.availability[id][day] = state.availability[id][day] || { am: 'available', pm: 'available' };

    const existingReq = state.availability[id][day][`${shift}_request`];
    if (existingReq && (existingReq.state === 'approved' || existingReq.state === 'rejected')) {
      const verb = existingReq.state === 'approved' ? 'aprobada' : 'rechazada';
      if (!confirm(`Esta jornada ya tiene una solicitud ${verb}. Cambiarla la reabrirá como pendiente y se perderá la decisión y la nota del admin. ¿Continuar?`)) return;
    }

    let reason = state.availability[id][day][`${shift}_reason`] || null;
    if (next === 'unavailable') {
      reason = prompt('Razón de "No disponible" (admin):', reason || '');
      if (!reason || !reason.trim()) return;
    } else {
      reason = null;
    }
    state.availability[id][day][shift] = next;
    state.availability[id][day][`${shift}_reason`] = reason;

    try {
      await Api.upsertAvailabilityRow({
        profileId: id, weekStart: state.currentWeek, day,
        am: state.availability[id][day].am,
        pm: state.availability[id][day].pm,
        am_reason: state.availability[id][day].am_reason,
        pm_reason: state.availability[id][day].pm_reason,
      });
      await refreshAvailabilityMatrix();
      refreshPendingBadge();
    } catch (e) {
      alert('Error al guardar disponibilidad: ' + e.message);
      await refreshAvailabilityMatrix();
    }
  }

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
      ${opts.actions || ''}
    </div>`;
  }

  async function renderWorkers() {
    const list = $('#workers-list');
    list.innerHTML = '<p class="text-sm text-slate-500">Cargando…</p>';
    let admins, drivers;
    try {
      [admins, drivers] = await Promise.all([Api.listAdmins(), Api.listAllDriversForAdmin()]);
    } catch (e) {
      list.innerHTML = `<p class="text-sm text-rose-600">Error cargando personal: ${escapeHtml(e.message)}</p>`;
      return;
    }
    const activeDrivers = drivers.filter(d => d.active);
    const suspended = drivers.filter(d => !d.active);

    const adminCards = admins.map(a => {
      const coord = a.is_coordinator !== false;
      return workerCardHtml({ name: a.full_name, email: a.email }, {
        kind: 'admin',
        actions: `<div class="worker-actions">
          <button data-act="${coord ? 'coord-off' : 'coord-on'}" data-id="${a.id}" data-name="${escapeHtml(a.full_name)}"
            class="wk-btn ${coord ? 'wk-coord-on' : 'wk-coord-off'}">
            ${coord ? '✓ Coordina' : '✕ No coordina'}</button>
        </div>`,
      });
    }).join('');

    const activeCards = activeDrivers.map(d => workerCardHtml(d, {
      kind: 'driver',
      actions: `<div class="worker-actions">
        <button data-act="suspend" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-suspend">Suspender</button>
        <button data-act="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-delete">Eliminar</button>
      </div>`,
    })).join('') || '<p class="text-sm text-slate-500">No hay conductores activos.</p>';

    const suspendedSection = suspended.length ? `
      <div>
        <h3 class="text-sm font-bold text-ink mb-2 mt-4">Suspendidos <span class="text-slate-400">(${suspended.length})</span></h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${suspended.map(d => workerCardHtml(d, {
            kind: 'suspended',
            actions: `<div class="worker-actions">
              <button data-act="reactivate" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-reactivate">Reactivar</button>
              <button data-act="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-delete">Eliminar</button>
            </div>`,
          })).join('')}
        </div>
      </div>` : '';

    list.innerHTML = `
      <div>
        <h3 class="text-sm font-bold text-ink mb-2">Administradores</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${adminCards}</div>
      </div>
      <div>
        <h3 class="text-sm font-bold text-ink mb-2 mt-4">Conductores activos <span class="text-slate-400">(${activeDrivers.length})</span></h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${activeCards}</div>
      </div>
      ${suspendedSection}`;

    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => onWorkerAction(btn));
    });
  }

  async function onWorkerAction(btn) {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const act = btn.dataset.act;
    if (act === 'delete' && !confirm(`¿Eliminar a ${name}? Desaparece del sistema y de la generación. Los horarios pasados donde aparece NO se borran.`)) return;
    if (act === 'suspend' && !confirm(`¿Suspender a ${name}? Saldrá de la generación de horarios hasta que lo reactives.`)) return;
    btn.disabled = true;
    const msg = {
      suspend: 'Conductor suspendido.', reactivate: 'Conductor reactivado.',
      delete: 'Conductor eliminado.',
      'coord-off': `${name} ya no entra en Coordinación.`, 'coord-on': `${name} ahora entra en Coordinación.`,
    };
    try {
      if (act === 'suspend') await Api.setProfileActive(id, false);
      else if (act === 'reactivate') await Api.setProfileActive(id, true);
      else if (act === 'delete') await Api.softDeleteProfile(id);
      else if (act === 'coord-off') await Api.setAdminCoordinator(id, false);
      else if (act === 'coord-on') await Api.setAdminCoordinator(id, true);
      state.drivers = await Api.listDrivers();
      state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false }));
      await renderWorkers();
      toast(msg[act] || 'Hecho.');
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  function renderSettings() {
    $('#setting-morning-label').value = state.settings.morning_label;
    $('#setting-afternoon-label').value = state.settings.afternoon_label;
    $('#setting-morning-slots').value = state.settings.morning_slots;
    $('#setting-afternoon-slots').value = state.settings.afternoon_slots;
    renderPriorityList();
  }

  // Prioridad por antigüedad (1=nuevo, 2=con tiempo, 3=antiguo). Influye SUAVE
  // en la generación: ver scheduler.js (desempate por prioridad).
  function renderPriorityList() {
    const box = $('#priority-list');
    if (!box) return;
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) {
      box.innerHTML = '<p class="text-sm text-slate-500">No hay conductores activos.</p>';
      return;
    }
    box.innerHTML = drivers.map(d => {
      const p = d.priority || 1;
      return `<div class="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink truncate">${escapeHtml(d.name)}</p>
          <p class="text-xs text-slate-500 truncate">${escapeHtml(d.email || '')}</p>
        </div>
        <select data-prio-id="${d.id}" class="shrink-0 border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100 outline-none">
          <option value="1"${p === 1 ? ' selected' : ''}>1 · Nuevo</option>
          <option value="2"${p === 2 ? ' selected' : ''}>2 · Con tiempo</option>
          <option value="3"${p === 3 ? ' selected' : ''}>3 · Antiguo</option>
        </select>
      </div>`;
    }).join('');
    box.querySelectorAll('select[data-prio-id]').forEach(sel => {
      sel.addEventListener('change', () => onChangePriority(sel));
    });
  }

  async function onChangePriority(sel) {
    const id = sel.dataset.prioId;
    const value = parseInt(sel.value, 10) || 1;
    sel.disabled = true;
    try {
      await Api.setDriverPriority(id, value);
      const d = state.drivers.find(x => x.id === id);
      if (d) d.priority = value;
      toast('Prioridad actualizada.');
    } catch (e) {
      alert('Error al guardar prioridad: ' + e.message);
    } finally {
      sel.disabled = false;
    }
  }

  async function onSaveSettings() {
    const next = {
      morning_label: $('#setting-morning-label').value,
      afternoon_label: $('#setting-afternoon-label').value,
      morning_slots: Math.max(1, parseInt($('#setting-morning-slots').value, 10) || 2),
      afternoon_slots: Math.max(1, parseInt($('#setting-afternoon-slots').value, 10) || 2),
    };
    try {
      await Api.saveSettings(next);
      state.settings = { ...state.settings, ...next };
      toast('Ajustes guardados.');
    } catch (e) {
      alert('Error al guardar ajustes: ' + e.message);
    }
  }

  // ====================================================================
  // Driver view — cards mobile-first
  // ====================================================================

  async function refreshDriverView() {
    updateDriverWeekLabel();
    state.ownAvail = await Api.getMyWeeklyAvailability(state.profile.id, state.currentWeek);
    renderDriverDays();
    await renderDriverRequests();
    await renderDriverPublishedSchedule();
  }

  function updateDriverWeekLabel() {
    const start = new Date(state.currentWeek + 'T00:00:00');
    const end = new Date(state.currentWeek + 'T00:00:00');
    end.setDate(end.getDate() + 6);
    const m = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    $('#driver-week-label').textContent =
      `${start.getDate()} ${m[start.getMonth()]} — ${end.getDate()} ${m[end.getMonth()]}`;
    $('#driver-week-input').value = state.currentWeek;
  }

  function navigateDriverWeek(deltaDays) {
    state.currentWeek = Scheduler.addDays(state.currentWeek, deltaDays);
    refreshDriverView();
  }

  function renderDriverDays() {
    const week = Scheduler.weekDates(state.currentWeek);
    const todayISO = new Date().toISOString().slice(0,10);
    const wrap = $('#driver-days');
    wrap.innerHTML = week.map(d => {
      const av = state.ownAvail[d.key] || { am: 'available', pm: 'available' };
      const isWeekend = d.key === 'sat' || d.key === 'sun';
      const isToday = d.date === todayISO;
      const cls = ['day-card'];
      if (isWeekend) cls.push('is-weekend');
      if (isToday) cls.push('is-today');
      return `<div class="${cls.join(' ')}">
        <div class="day-card-header">
          <div>
            <p class="day-card-day">${d.label}</p>
            <p class="day-card-date">${d.dayNum} ${monthShort(d.date)} ${isToday ? '· HOY' : ''}</p>
          </div>
        </div>
        <div class="day-card-actions">
          <button class="shift-btn" data-day="${d.key}" data-shift="am" data-state="${av.am}">
            <span class="shift-btn-label">MAÑANA</span>
            <span class="shift-btn-state">${stateLabelShort(av.am)} ${approvalBadgeHtml(av.am_request)}</span>
          </button>
          <button class="shift-btn" data-day="${d.key}" data-shift="pm" data-state="${av.pm}">
            <span class="shift-btn-label">TARDE</span>
            <span class="shift-btn-state">${stateLabelShort(av.pm)} ${approvalBadgeHtml(av.pm_request)}</span>
          </button>
        </div>
        <button class="day-all-btn" data-day="${d.key}" data-shift="whole">Todo el día</button>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.shift-btn, .day-all-btn').forEach(btn => {
      btn.addEventListener('click', () => openStatePicker(btn.dataset.day, btn.dataset.shift));
    });
    $('#driver-save-state').textContent = '';
    updateDriverGreeting();
  }

  function monthShort(iso) {
    const m = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
    return m[new Date(iso + 'T00:00:00').getMonth()];
  }

  function stateLabelShort(s) {
    return { available: 'Disponible', prefer_rest: 'Descanso', unavailable: 'No disponible' }[s] || s;
  }

  // State picker -------------------------------------------------------

  let pickerContext = null;

  function openStatePicker(day, shift) {
    pickerContext = { day, shift };
    const dayLabel = Scheduler.DAY_LABELS_ES[day];
    const shiftLabel = shift === 'whole' ? 'todo el día' : (shift === 'am' ? 'Mañana' : 'Tarde');
    $('#state-picker-title').textContent = `${dayLabel} · ${shiftLabel}`;
    $('#state-picker-subtitle').textContent = 'Elige una opción para esta jornada.';
    $('#state-picker').classList.remove('hidden');
  }

  function closeStatePicker() {
    pickerContext = null;
    $('#state-picker').classList.add('hidden');
  }

  function pickState(value) {
    if (!pickerContext) return;
    const { day, shift } = pickerContext;
    if (value === 'unavailable') {
      const current = shift === 'whole'
        ? (state.ownAvail[day]?.am_reason || state.ownAvail[day]?.pm_reason)
        : state.ownAvail[day]?.[`${shift}_reason`];
      closeStatePicker();
      openReasonModal({ day, shift, currentReason: current || '' });
      return;
    }
    state.ownAvail[day] = state.ownAvail[day] || { am: 'available', pm: 'available' };
    if (shift === 'whole') {
      state.ownAvail[day].am = value;
      state.ownAvail[day].pm = value;
      state.ownAvail[day].am_reason = null;
      state.ownAvail[day].pm_reason = null;
    } else {
      state.ownAvail[day][shift] = value;
      state.ownAvail[day][`${shift}_reason`] = null;
    }
    closeStatePicker();
    renderDriverDays();
  }

  // Reason modal --------------------------------------------------------

  let reasonContext = null;

  function openReasonModal({ day, shift, currentReason }) {
    reasonContext = { day, shift };
    const dayLabel = Scheduler.DAY_LABELS_ES[day];
    const shiftLabel = shift === 'whole' ? 'todo el día' : (shift === 'am' ? 'Mañana' : 'Tarde');
    $('#reason-modal-title').textContent = `Razón — ${dayLabel} (${shiftLabel})`;
    $('#reason-modal-text').value = currentReason || '';
    $('#reason-modal').classList.remove('hidden');
    setTimeout(() => $('#reason-modal-text').focus(), 50);
  }

  function closeReasonModal() {
    reasonContext = null;
    $('#reason-modal').classList.add('hidden');
  }

  function saveReasonModal() {
    if (!reasonContext) return;
    const reason = $('#reason-modal-text').value.trim();
    if (!reason) { alert('La razón no puede estar vacía.'); return; }
    const { day, shift } = reasonContext;
    state.ownAvail[day] = state.ownAvail[day] || { am: 'available', pm: 'available' };
    if (shift === 'whole') {
      state.ownAvail[day].am = 'unavailable';
      state.ownAvail[day].pm = 'unavailable';
      state.ownAvail[day].am_reason = reason;
      state.ownAvail[day].pm_reason = reason;
    } else {
      state.ownAvail[day][shift] = 'unavailable';
      state.ownAvail[day][`${shift}_reason`] = reason;
    }
    closeReasonModal();
    renderDriverDays();
  }

  async function onDriverSave() {
    const btn = $('#driver-save-btn');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await Api.saveDriverWeekAvailability(state.profile.id, state.currentWeek, state.ownAvail);
      await refreshDriverView();
      $('#driver-save-state').textContent = '✓ Guardado';
      $('#driver-save-state').className = 'text-xs text-emerald-600 font-semibold flex-1';
      setTimeout(() => { $('#driver-save-state').textContent = ''; }, 2500);
    } catch (e) {
      $('#driver-save-state').textContent = 'Error: ' + e.message;
      $('#driver-save-state').className = 'text-xs text-rose-600 flex-1';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  }

  async function renderDriverRequests() {
    const box = $('#driver-requests-container');
    try {
      const reqs = await Api.listMyApprovalRequests(state.profile.id, state.currentWeek);
      const icons = { pending: '⏳', approved: '✓', rejected: '✗' };
      const reqCards = reqs.map(r => {
        const dayLabel = Scheduler.DAY_LABELS_ES[Scheduler.DAYS[r.day_of_week]] || '—';
        const kindLabel = r.kind === 'unavailable' ? 'No disponible' : 'Descanso';
        const stateLabel = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }[r.state] || r.state;
        return `<div class="request-card" data-state="${r.state}">
          <div class="request-card-icon">${icons[r.state] || '?'}</div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-ink">${dayLabel} · ${r.shift.toUpperCase()}</p>
            <p class="text-xs text-slate-600">${kindLabel} · <strong>${stateLabel}</strong></p>
            ${r.reason ? `<p class="text-xs text-slate-500 mt-1">${escapeHtml(r.reason)}</p>` : ''}
            ${r.admin_note ? `<p class="text-xs text-slate-500 mt-1 italic">Nota admin: ${escapeHtml(r.admin_note)}</p>` : ''}
          </div>
        </div>`;
      }).join('');

      // Descansos entre semana sin conflicto: NO generan solicitud, pero el
      // sistema los acepta (hay con quién cubrir). Se muestran para que el
      // conductor no piense que se perdieron.
      const haveReq = new Set(reqs.map(r => `${r.day_of_week}-${r.shift}`));
      const autoCards = [];
      Scheduler.DAYS.forEach((dayKey, idx) => {
        const cell = state.ownAvail && state.ownAvail[dayKey];
        if (!cell) return;
        ['am', 'pm'].forEach(sh => {
          if (cell[sh] === 'prefer_rest' && !haveReq.has(`${idx}-${sh}`)) {
            const dayLabel = Scheduler.DAY_LABELS_ES[dayKey] || '—';
            autoCards.push(`<div class="request-card" data-state="approved">
              <div class="request-card-icon">✓</div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-ink">${dayLabel} · ${sh.toUpperCase()}</p>
                <p class="text-xs text-slate-600">Descanso · <strong>Aceptado automáticamente</strong></p>
                <p class="text-xs text-slate-500 mt-1">No requiere aprobación: hay con quién cubrir.</p>
              </div>
            </div>`);
          }
        });
      });

      box.innerHTML = (reqCards + autoCards.join('')) ||
        '<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4 text-center">No tienes solicitudes esta semana.</p>';
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-rose-600 p-3">Error: ${e.message}</p>`;
    }
  }

  async function renderDriverPublishedSchedule() {
    const container = $('#driver-schedule-container');
    const sch = await Api.getSchedule(state.currentWeek);
    if (!sch || !sch.published) {
      container.innerHTML = '<p class="p-6 text-sm text-slate-500 text-center">Esta semana no tiene horario publicado todavía.</p>';
      return;
    }
    const driverNames = sch.data._names || {};
    if (!driverNames[state.profile.id]) driverNames[state.profile.id] = state.profile.full_name;

    const week = Scheduler.weekDates(state.currentWeek);
    let html = '<table class="w-full text-xs" id="schedule-table">';
    html += '<caption class="text-base font-bold py-3">HORARIO SEMANAL</caption>';
    html += '<thead><tr><th class="cell-label">FRANJA</th>' +
      week.map(d => `<th>${d.label.slice(0,3)} ${d.dayNum}</th>`).join('') + '</tr></thead><tbody>';
    for (let i = 0; i < state.settings.morning_slots; i++) {
      html += '<tr class="row-morning">';
      if (i === 0) html += `<td class="cell-label" rowspan="${state.settings.morning_slots}">MAÑANA (${state.settings.morning_label})</td>`;
      week.forEach(d => {
        const id = sch.data[d.key]?.morning?.[i];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell text-brand font-bold' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    }
    for (let i = 0; i < state.settings.afternoon_slots; i++) {
      html += '<tr class="row-afternoon">';
      if (i === 0) html += `<td class="cell-label" rowspan="${state.settings.afternoon_slots}">TARDE (${state.settings.afternoon_label})</td>`;
      week.forEach(d => {
        const id = sch.data[d.key]?.afternoon?.[i];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell text-brand font-bold' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    }
    [['coord_am', 'COORDINACIÓN AM'], ['coord_pm', 'COORDINACIÓN PM']].forEach(([kind, label]) => {
      html += '<tr class="row-coord"><td class="cell-label">' + label + '</td>';
      week.forEach(d => {
        const id = sch.data[d.key]?.[kind]?.[0];
        const name = (driverNames[id] || '—').toUpperCase();
        html += `<td class="shift-cell">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ====================================================================
  // UI helpers
  // ====================================================================

  // ====================================================================
  // PWA install prompt
  // ====================================================================

  let deferredInstallPrompt = null;

  function setupInstallPrompt() {
    const btn = $('#install-btn');
    const btnMobile = $('#install-btn-mobile');
    const iosModal = $('#ios-install-modal');
    const iosClose = $('#ios-install-close');

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isStandalone) return; // ya instalado

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (state.profile?.role === 'admin') return; // admins gestionan desde PC
      btn.classList.remove('hidden');
      btnMobile.classList.remove('hidden');
    });

    if (isIos && state.profile?.role !== 'admin') {
      // iOS Safari nunca dispara beforeinstallprompt; mostramos botón con instrucciones.
      btn.classList.remove('hidden');
      btnMobile.classList.remove('hidden');
    }

    const onClick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          btn.classList.add('hidden');
          btnMobile.classList.add('hidden');
        }
        deferredInstallPrompt = null;
      } else if (isIos) {
        iosModal.classList.remove('hidden');
      }
    };
    btn.addEventListener('click', onClick);
    btnMobile.addEventListener('click', onClick);
    iosClose.addEventListener('click', () => iosModal.classList.add('hidden'));
    iosModal.addEventListener('click', (e) => {
      if (e.target.id === 'ios-install-modal') iosModal.classList.add('hidden');
    });

    window.addEventListener('appinstalled', () => {
      btn.classList.add('hidden');
      btnMobile.classList.add('hidden');
      toast('¡App instalada!');
    });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
