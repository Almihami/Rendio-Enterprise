(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const isSuspended = () => state.profile && state.profile.is_active === false;

  let lastAutoWeek = Scheduler.defaultWeekISO(new Date());

  const state = {
    profile: null,
    drivers: [],
    admins: [],
    settings: null,
    currentWeek: lastAutoWeek,
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
        if (!profile) {
          await Api.signOut();
          nextAction = () => showLogin('Tu cuenta no tiene perfil asociado.');
        } else {
          // Suspendido: lo dejamos entrar a ver el banner; el módulo se bloquea.
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
    // Auto-cambio de semana: si el usuario deja la app abierta y cruza la
    // medianoche del lunes (o el viernes, según defaultWeekISO), salta solo
    // a la semana correcta. Si el usuario navegó manualmente a otra semana
    // se respeta su elección (no se pisa).
    setInterval(checkWeekDrift, 5 * 60 * 1000);
  }

  function checkWeekDrift() {
    if (!state.profile) return;
    if (state.currentWeek !== lastAutoWeek) return; // el usuario eligió otra
    const expected = Scheduler.defaultWeekISO(new Date());
    if (expected === state.currentWeek) return;
    state.currentWeek = expected;
    lastAutoWeek = expected;
    if (state.profile.role === 'admin') {
      if (state.activeTab === 'schedule') refreshScheduleData();
      else if (state.activeTab === 'availability') refreshAvailabilityMatrix();
      else if (state.activeTab === 'approvals') refreshApprovals();
    } else {
      refreshDriverView();
    }
    toast(`Cambiamos a la semana del ${weekLabelES(expected)}`);
  }

  // navegación manual: cualquier prev/next/picker actualiza lastAutoWeek
  // para mantener el timer "armado" (no piso al usuario si él eligió).
  function setCurrentWeekManual(weekISO) {
    state.currentWeek = weekISO;
    lastAutoWeek = weekISO;
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
      setCurrentWeekManual(Scheduler.startOfWeekISO(e.target.value));
      refreshScheduleData();
    });
    $('#generate-btn').addEventListener('click', onGenerate);
    $('#reopen-avail-btn')?.addEventListener('click', onReopenAvailability);
    $('#balance-generate')?.addEventListener('click', onGenerateBalance);
    $('#balance-month')?.addEventListener('click', balanceThisMonth);
    $('#balance-csv')?.addEventListener('click', onDownloadBalanceCsv);
    $('#download-schedule-btn')?.addEventListener('click', onDownloadScheduleXlsx);
    $('#save-btn').addEventListener('click', () => onSaveSchedule(false));
    $('#publish-btn').addEventListener('click', () => onSaveSchedule(true));
    $('#clear-schedule-btn').addEventListener('click', onClearSchedule);

    $('#save-settings-btn').addEventListener('click', onSaveSettings);

    $('#new-driver-gen-pw')?.addEventListener('click', onGenerateDriverPassword);
    $('#new-driver-create-btn')?.addEventListener('click', onCreateDriver);

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
    if (isSuspended()) {
      toast('Tu cuenta está suspendida. Habla con tu admin para reactivarla.');
      return;
    }
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
    await loadRules();

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
    setupPushUI();
  }

  // Carga las reglas (descansos fijos) desde la BD y las inyecta al scheduler.
  // Si la tabla 0020 aún no está aplicada, deja el fallback hardcode por email.
  async function loadRules() {
    try {
      const rows = await Api.listDriverRules();
      state.rules = rows;
      Scheduler.setRules(Api.rulesToMap(rows));
    } catch (e) {
      state.rules = null;
      Scheduler.setRules(null); // fallback: hardcode por email en scheduler.js
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
    if (name === 'balance') renderBalance();
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
    // Aviso de cambios de turno aceptados entre conductores (post-publicación).
    try {
      const swaps = sch?.published ? await Api.listAcceptedSwaps(state.currentWeek) : [];
      const box = $('#schedule-warnings');
      if (swaps.length && box) {
        const names = (sch.data && sch.data._names) || {};
        const lbl = (d, s) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[d]]} ${s.toUpperCase()}`;
        box.innerHTML = `<p class="text-indigo-700 font-semibold">🔄 ${swaps.length} cambio(s) de turno aceptado(s) entre conductores:</p>
          <ul class="list-disc pl-5 mt-1">${swaps.map(s =>
            `<li>${escapeHtml(names[s.requester_id] || '—')} (${lbl(s.from_day, s.from_shift)}) ⇄ ${escapeHtml(names[s.target_id] || '—')} (${lbl(s.to_day, s.to_shift)})</li>`).join('')}</ul>
          <p class="text-xs text-slate-500 mt-1">Se reflejan en la vista de los conductores. Si regeneras y publicas, se reinician.</p>`;
        box.classList.remove('hidden');
      }
    } catch (e) { /* sin aviso si falla */ }
  }

  function navigateWeek(deltaDays) {
    setCurrentWeekManual(Scheduler.addDays(state.currentWeek, deltaDays));
    refreshScheduleData();
  }

  function nameOf(id) {
    const w = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
    return w ? w.name : '—';
  }

  const COORD_KINDS = ['coord_am', 'coord_pm'];
  const isCoordKind = (k) => COORD_KINDS.includes(k);
  // --- Reapertura temporal de disponibilidad (admin reabre una semana 2h) ---
  // Devuelve {active, until} si esa semana está reabierta y vigente.
  function reopenInfo(weekStartISO) {
    const s = state.settings || {};
    if (s.reopen_week_start === weekStartISO && s.reopen_until) {
      const until = new Date(s.reopen_until).getTime();
      if (Date.now() < until) return { active: true, until };
    }
    return { active: false, until: 0 };
  }
  // Cerrada = pasó el corte del domingo Y NO hay reapertura vigente.
  function weekAvailClosed(weekStartISO) {
    if (!Scheduler.availabilityClosed(weekStartISO)) return false;
    return !reopenInfo(weekStartISO).active;
  }
  const hhmmCO = ts => new Date(ts).toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true,
  });

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

  async function onReopenAvailability() {
    const wk = state.currentWeek;
    const info = reopenInfo(wk);
    try {
      if (info.active) {
        if (!confirm(`La disponibilidad de esta semana está reabierta hasta las ${hhmmCO(info.until)}. ¿Cerrarla ahora?`)) return;
        await Api.setAvailabilityReopen(wk, null);
        state.settings = { ...state.settings, reopen_week_start: null, reopen_until: null };
        toast('Reapertura cerrada.');
      } else {
        if (!confirm('¿Reabrir la disponibilidad de ESTA semana por 2 horas para TODOS los conductores? Podrán entrar a corregir/llenar; al vencerse vuelve a cerrarse.')) return;
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        await Api.setAvailabilityReopen(wk, until);
        state.settings = { ...state.settings, reopen_week_start: wk, reopen_until: until };
        toast(`Disponibilidad reabierta hasta las ${hhmmCO(until)} (2 h). Avisa a los conductores.`);
      }
    } catch (e) {
      alert('No se pudo cambiar la reapertura: ' + e.message + '\n(¿Falta aplicar la migración 0014?)');
    }
  }

  async function onGenerate() {
    // El admin decide al PUBLICAR: las solicitudes quedan PENDIENTES hasta entonces.
    // El generador respeta lo que pidió cada conductor (pending o approved). Si
    // queda un cupo sin cubrir (todos pidieron descanso/unavailable), aparece en
    // las "Advertencias" para que el admin edite manualmente o cierre solicitudes
    // desde la pestaña Solicitudes.
    try { state.settings = await Api.getSettings(); } catch (e) { /* usa cacheado */ }
    await doGenerate();
  }

  async function doGenerate() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);

    // Regla domingo 2:00 PM (hora Colombia): si el corte ya pasó, el conductor
    // que NO guardó disponibilidad para esta semana queda FUERA del generador
    // (no maneja, no descansa, no coordina). El admin lo puede rescatar
    // llenándole la disponibilidad consolidada (no tiene candado).
    let pool = state.drivers;
    let excluded = [];
    if (weekAvailClosed(state.currentWeek)) {
      try {
        const submitted = await Api.listSubmittedDriverIds(state.currentWeek);
        excluded = state.drivers.filter(d => !submitted.has(d.id));
        pool = state.drivers.filter(d => submitted.has(d.id));
      } catch (e) {
        pool = state.drivers; excluded = []; // si la consulta falla, no excluir (fail-safe)
      }
    }

    // Suspendidos esta semana (por 3 strikes o manual): fuera del generador.
    let suspendedThisWeek = [];
    try {
      const susp = await Api.getWeekSuspensions(state.currentWeek);
      if (susp.size) {
        suspendedThisWeek = pool.filter(d => susp.has(d.id));
        pool = pool.filter(d => !susp.has(d.id));
      }
    } catch (e) { /* fail-safe: no excluir por suspensión si falla */ }

    // Regla PM→AM entre semanas: quien cerró el DOMINGO PM de la semana
    // anterior (manejo + coordinación) no puede madrugar el lunes de esta.
    // Sembramos esos ids para que el generador los excluya del AM del lunes.
    let seedPmIds = [];
    try {
      const prevWeek = Scheduler.addDays(state.currentWeek, -7);
      const prev = await Api.getSchedule(prevWeek);
      const sun = prev?.data?.sun;
      if (sun) {
        seedPmIds = [...(sun.afternoon || []), ...(sun.coord_pm || [])].filter(Boolean);
      }
    } catch (e) { /* sin semana previa: no se siembra (fail-safe) */ }

    const flexCand = flexCoordinator();
    const flexId = (flexCand && pool.some(d => d.id === flexCand.id)) ? flexCand.id : null;
    // Pool de coordinadores = admins con is_coordinator + conductores con
    // can_coordinate (Daniel queda fuera: tiene su garantía dura aparte).
    const coordPool = [
      ...coordinatorAdmins(),
      ...pool.filter(d => d.can_coordinate && d.id !== flexId),
    ];
    const { schedule, warnings } = Scheduler.generateSchedule({
      drivers: pool,
      admins: coordPool,
      settings: { morningSlots: state.settings.morning_slots, afternoonSlots: state.settings.afternoon_slots },
      availability: state.availability,
      flexCoordinatorId: flexId,
      weekStart: state.currentWeek,
      // Nonce nuevo por clic: cada "Generar" baraja distinto (siempre válido).
      // Lo que el admin elija se fija al Guardar/Publicar.
      nonce: Date.now() + '-' + Math.random(),
      seedPmIds,
    });
    state.schedule = schedule;
    const box = $('#schedule-warnings');
    const exclMsg = excluded.length
      ? `<p class="text-rose-700 font-semibold">⛔ ${excluded.length} conductor(es) fuera por no llenar disponibilidad antes del domingo 2:00 PM: ${excluded.map(d => escapeHtml(d.name)).join(', ')}</p>`
      : '';
    const suspMsg = suspendedThisWeek.length
      ? `<p class="text-amber-700 font-semibold">🚫 ${suspendedThisWeek.length} conductor(es) suspendido(s) esta semana (3 strikes / manual): ${suspendedThisWeek.map(d => escapeHtml(d.name)).join(', ')}</p>`
      : '';
    if (warnings.length || exclMsg || suspMsg) {
      box.innerHTML = exclMsg + suspMsg + (warnings.length
        ? '<strong>Advertencias:</strong><ul class="list-disc pl-5 mt-1">' +
          warnings.map(w => `<li>${w}</li>`).join('') + '</ul>'
        : '');
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
    renderSchedule();
    toast('Horario generado. Guardar / Publicar para persistir.');
  }

  // ====================================================================
  // Publicar: reconcilia solicitudes pending → approved/rejected según el
  // horario final. Si el conductor quedó descansando ese día/jornada (no en
  // morning/afternoon ni en coord_*), su pending pasa a APPROVED; si quedó
  // trabajando o coordinando, pasa a REJECTED. El admin firma con su acción
  // de "Publicar" — antes no se toca ninguna solicitud.
  // ====================================================================

  async function reconcilePendingApprovals() {
    const all = await Api.listPendingApprovals(state.currentWeek);
    const ids = new Set(state.drivers.map(d => d.id));
    const pending = all.filter(r => r.state === 'pending' && ids.has(r.profile_id));
    if (!pending.length) return 0;
    const sched = state.schedule || {};
    let resolved = 0;
    for (const r of pending) {
      const day = Scheduler.DAYS[r.day_of_week];
      const slot = r.shift === 'am' ? 'morning' : 'afternoon';
      const coord = r.shift === 'am' ? 'coord_am' : 'coord_pm';
      const working = (sched[day]?.[slot] || []).includes(r.profile_id)
                   || (sched[day]?.[coord] || []).includes(r.profile_id);
      const decision = working ? 'rejected' : 'approved';
      const note = working
        ? 'Rechazado al publicar: la cobertura del día requería tu jornada.'
        : 'Aprobado al publicar: el horario final respeta tu solicitud.';
      try {
        await Api.resolveApproval(r.id, decision, note);
        resolved++;
      } catch (e) { /* ignora una y sigue con las demás */ }
    }
    return resolved;
  }

  async function onSaveSchedule(publish) {
    if (!state.schedule) { toast('Genera o edita el horario primero.'); return; }
    try {
      if (publish) {
        const n = await reconcilePendingApprovals();
        if (n) toast(`${n} solicitud(es) resueltas al publicar.`);
      }
      await Api.saveSchedule(state.currentWeek, state.schedule, { published: publish, drivers: [...state.drivers, ...state.admins] });
      $('#published-pill').classList.toggle('hidden', !publish);
      refreshPendingBadge();
      if (publish) {
        notify(state.drivers.map(d => d.id), 'Horario publicado',
          `Ya está disponible el horario de la semana del ${weekLabelES(state.currentWeek)}.`, '/');
      }
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
          // Bloqueo por parametrización: se muestra 🔒 y NO se puede editar.
          const amBlocked = Scheduler.ruleBlocked(d, day.key, 'am');
          const pmBlocked = Scheduler.ruleBlocked(d, day.key, 'pm');
          const amState = amBlocked ? 'blocked' : av.am;
          const pmState = pmBlocked ? 'blocked' : av.pm;
          const amTip = amBlocked ? ' title="Bloqueado por parametrización (descanso fijo)"' : (av.am_reason ? ` title="${escapeAttr(av.am_reason)}"` : '');
          const pmTip = pmBlocked ? ' title="Bloqueado por parametrización (descanso fijo)"' : (av.pm_reason ? ` title="${escapeAttr(av.pm_reason)}"` : '');
          const amBadge = amBlocked ? ' 🔒' : miniBadge(av.am_request);
          const pmBadge = pmBlocked ? ' 🔒' : miniBadge(av.pm_request);
          return `<td class="p-1">
            <div class="flex gap-1 justify-center items-center">
              <button data-id="${d.id}" data-day="${day.key}" data-shift="am" data-state="${amState}"${amBlocked ? ' data-blocked="1"' : ''} class="avail-pill"${amTip}>AM${amBadge}</button>
              <button data-id="${d.id}" data-day="${day.key}" data-shift="pm" data-state="${pmState}"${pmBlocked ? ' data-blocked="1"' : ''} class="avail-pill"${pmTip}>PM${pmBadge}</button>
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
    if (btn.dataset.blocked === '1') {
      toast('Bloqueado por parametrización. Se edita en las reglas del conductor.');
      return;
    }
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
        shift_pref: state.availability[id][day].shift_pref || 'any',
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
      ${opts.badges ? `<div class="worker-badges">${opts.badges}</div>` : ''}
      ${opts.actions || ''}
    </div>`;
  }

  async function renderWorkers() {
    const list = $('#workers-list');
    list.innerHTML = '<p class="text-sm text-slate-500">Cargando…</p>';
    let admins, drivers, strikeCounts, weekSusp;
    try {
      [admins, drivers, strikeCounts, weekSusp] = await Promise.all([
        Api.listAdmins(), Api.listAllDriversForAdmin(),
        Api.getActiveStrikeCounts().catch(() => new Map()),
        Api.getWeekSuspensions(state.currentWeek).catch(() => new Map()),
      ]);
    } catch (e) {
      list.innerHTML = `<p class="text-sm text-rose-600">Error cargando personal: ${escapeHtml(e.message)}</p>`;
      return;
    }
    state._strikeCounts = strikeCounts;
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

    const activeCards = activeDrivers.map(d => {
      const dcoord = d.can_coordinate === true;
      const strikes = strikeCounts.get(d.id) || 0;
      const isSuspWeek = weekSusp.has(d.id);
      const strikeBadge = strikes > 0
        ? `<span class="wk-strike-badge" title="Strikes activos">⚠ ${strikes}/3</span>` : '';
      const suspBadge = isSuspWeek
        ? `<span class="wk-susp-badge" title="Suspendido esta semana">🚫 Suspendido (esta semana)</span>` : '';
      return workerCardHtml(d, {
        kind: 'driver',
        badges: strikeBadge + suspBadge,
        actions: `<div class="worker-actions">
          <button data-act="${dcoord ? 'dcoord-off' : 'dcoord-on'}" data-id="${d.id}" data-name="${escapeHtml(d.name)}"
            class="wk-btn ${dcoord ? 'wk-coord-on' : 'wk-coord-off'}">
            ${dcoord ? '✓ Coordina' : '✕ No coordina'}</button>
          <button data-act="strike" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-strike">⚠ Strike</button>
          <button data-act="strikes-history" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-history">Historial</button>
          <button data-act="suspend" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-suspend">Suspender</button>
          <button data-act="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" class="wk-btn wk-delete">Eliminar</button>
        </div>`,
      });
    }).join('') || '<p class="text-sm text-slate-500">No hay conductores activos.</p>';

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

    if (act === 'delete' && !confirm(`¿Eliminar a ${name}? Desaparece del sistema y de la generación. Los horarios pasados donde aparece NO se borran.`)) return;
    if (act === 'suspend' && !confirm(`¿Suspender a ${name}? Saldrá de la generación de horarios hasta que lo reactives.`)) return;
    btn.disabled = true;
    const msg = {
      suspend: 'Conductor suspendido.', reactivate: 'Conductor reactivado.',
      delete: 'Conductor eliminado.',
      'coord-off': `${name} ya no entra en Coordinación.`, 'coord-on': `${name} ahora entra en Coordinación.`,
      'dcoord-off': `${name} ya no entra en Coordinación.`, 'dcoord-on': `${name} ahora puede coordinar.`,
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
          ${(!s.voided_at && !s.consumed_at) ? `<button data-void-id="${s.id}" class="wk-btn wk-strike-void">Anular</button>` : ''}
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
        if (!confirm('¿Anular este strike? No contará para la suspensión (queda en historial).')) return;
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
    renderPriorityList();
    renderRulesEditor();
  }

  // --- Editor de parametrización: descansos fijos por conductor (Fase 4) ---
  // Se inyecta dentro del panel de Ajustes, tras la lista de prioridad.
  function renderRulesEditor() {
    const prioBox = $('#priority-list');
    if (!prioBox) return;
    let box = document.getElementById('rules-editor');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rules-editor';
      box.className = 'mt-6';
      // Lo colocamos como hermano del contenedor de prioridad.
      (prioBox.closest('section, div') || prioBox.parentNode).appendChild(box);
    }
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) { box.innerHTML = ''; return; }
    if (!state._rulesDriverId || !drivers.some(d => d.id === state._rulesDriverId)) {
      state._rulesDriverId = drivers[0].id;
    }
    const sel = state._rulesDriverId;
    const rulesFor = new Set((state.rules || [])
      .filter(r => r.profile_id === sel)
      .map(r => `${r.day_of_week}-${r.shift}`));

    const opts = drivers.map(d => `<option value="${d.id}"${d.id === sel ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
    const rows = Scheduler.DAYS.map((dayKey, di) => {
      const label = Scheduler.DAY_LABELS_ES[dayKey];
      const cell = (shift) => {
        const on = rulesFor.has(`${di}-${shift}`);
        return `<button class="rule-cell ${on ? 'rule-on' : ''}" data-rule-day="${di}" data-rule-shift="${shift}">${shift.toUpperCase()}${on ? ' 🔒' : ''}</button>`;
      };
      return `<div class="rule-row"><span class="rule-day">${label}</span>${cell('am')}${cell('pm')}</div>`;
    }).join('');

    box.innerHTML = `
      <h3 class="text-sm font-bold text-ink mb-1">Descansos fijos (parametrización)</h3>
      <p class="text-xs text-slate-500 mb-3">Marca los días/jornadas que un conductor tiene SIEMPRE de descanso. Saldrán 🔒 bloqueados en el horario y en su vista.</p>
      <select id="rules-driver-select" class="border border-slate-300 rounded-lg px-2 py-1.5 text-sm mb-3 w-full max-w-xs">${opts}</select>
      <div class="rules-grid">${rows}</div>`;

    box.querySelector('#rules-driver-select').addEventListener('change', e => {
      state._rulesDriverId = e.target.value;
      renderRulesEditor();
    });
    box.querySelectorAll('.rule-cell').forEach(b => {
      b.addEventListener('click', () => onToggleRule(sel, parseInt(b.dataset.ruleDay, 10), b.dataset.ruleShift, b));
    });
  }

  async function onToggleRule(profileId, dayOfWeek, shift, btn) {
    const wasOn = btn.classList.contains('rule-on');
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
  // Balance de turnos (informe para los jefes)
  // ====================================================================

  function monthRangeDefault() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return {
      from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`,
      to: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    };
  }

  function renderBalance() {
    const f = $('#balance-from'), t = $('#balance-to');
    if (f && !f.value) { const r = monthRangeDefault(); f.value = r.from; t.value = r.to; }
    onGenerateBalance();
  }

  function balanceThisMonth() {
    const r = monthRangeDefault();
    $('#balance-from').value = r.from;
    $('#balance-to').value = r.to;
    onGenerateBalance();
  }

  // Cuenta, por persona: días de manejo + días de coordinación (= turnos de 12h).
  // Un mismo día cuenta 1 sola vez (maneja XOR coordina, como genera el sistema).
  function aggregateBalance(rows) {
    const merged = {}, agg = {};
    rows.forEach(r => {
      const dataObj = r.data || {};
      Object.assign(merged, dataObj._names || {});
      Scheduler.DAYS.forEach(dk => {
        const day = dataObj[dk];
        if (!day) return;
        const drive = new Set([...(day.morning || []), ...(day.afternoon || [])]);
        const coord = new Set([...(day.coord_am || []), ...(day.coord_pm || [])]);
        new Set([...drive, ...coord]).forEach(id => {
          agg[id] = agg[id] || { manejo: 0, coord: 0 };
          if (drive.has(id)) agg[id].manejo++;
          else if (coord.has(id)) agg[id].coord++;
        });
      });
    });
    const adminIds = new Set((state.admins || []).map(a => a.id));
    const liveName = {};
    (state.drivers || []).forEach(d => { liveName[d.id] = d.name; });
    (state.admins || []).forEach(a => { liveName[a.id] = liveName[a.id] || a.name; });
    const driverIds = new Set((state.drivers || []).map(d => d.id));
    const list = Object.keys(agg).map(id => {
      const manejo = agg[id].manejo, coord = agg[id].coord, total = manejo + coord;
      const name = liveName[id] || merged[id] || '(eliminado)';
      const role = adminIds.has(id) ? 'Admin' : (driverIds.has(id) ? 'Conductor' : '—');
      return { id, name, role, manejo, coord, total, horas: total * 12 };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { weeks: rows.length, list };
  }

  async function onGenerateBalance() {
    const fromV = $('#balance-from').value, toV = $('#balance-to').value;
    const box = $('#balance-table'), sum = $('#balance-summary');
    if (!fromV || !toV) { sum.textContent = 'Elige el rango (Desde / Hasta).'; box.innerHTML = ''; return; }
    const fromWk = Scheduler.startOfWeekISO(fromV), toWk = Scheduler.startOfWeekISO(toV);
    sum.textContent = 'Calculando…'; box.innerHTML = '';
    let rows;
    try { rows = await Api.listPublishedSchedules(fromWk, toWk); }
    catch (e) { sum.textContent = 'Error: ' + e.message; return; }
    const agg = aggregateBalance(rows);
    state.balanceData = { ...agg, fromV, toV };
    sum.textContent = `Período ${fromV} → ${toV} · ${agg.weeks} semana(s) publicada(s) · ${agg.list.length} persona(s). Cada turno = 12 h.`;
    if (!agg.list.length) {
      box.innerHTML = '<p class="text-sm text-slate-500 py-4">No hay horarios publicados en ese rango.</p>';
      return;
    }
    box.innerHTML = `<table class="w-full text-sm border-collapse">
      <thead><tr class="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
        <th class="py-2 pr-3">Nombre</th><th class="py-2 pr-3">Rol</th>
        <th class="py-2 pr-3 text-right">Manejo</th><th class="py-2 pr-3 text-right">Coord.</th>
        <th class="py-2 pr-3 text-right">Total turnos</th><th class="py-2 text-right">Horas</th></tr></thead>
      <tbody>${agg.list.map(r => `<tr class="border-b border-slate-100">
        <td class="py-2 pr-3 font-medium text-ink">${escapeHtml(r.name)}</td>
        <td class="py-2 pr-3 text-slate-500">${r.role}</td>
        <td class="py-2 pr-3 text-right">${r.manejo}</td>
        <td class="py-2 pr-3 text-right">${r.coord}</td>
        <td class="py-2 pr-3 text-right font-semibold">${r.total}</td>
        <td class="py-2 text-right font-semibold">${r.horas} h</td></tr>`).join('')}</tbody></table>`;
  }

  function onDownloadBalanceCsv() {
    const bd = state.balanceData;
    if (!bd || !bd.list.length) { toast('Genera primero un informe con datos.'); return; }
    const esc = v => { v = String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [
      `Balance de turnos;${bd.fromV} a ${bd.toV};${bd.weeks} semanas publicadas`,
      ['Nombre', 'Rol', 'Turnos manejo', 'Dias coordinacion', 'Total turnos', 'Horas (x12)'].join(';'),
      ...bd.list.map(r => [r.name, r.role, r.manejo, r.coord, r.total, r.horas].map(esc).join(';')),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `balance_${bd.fromV}_a_${bd.toV}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Descarga el horario de la semana en Excel respetando el formato de
  // "TURNOS CONDUCTORES.xlsx": hoja única "TURNOS SEMANALES", título mergeado,
  // filas Mañana (2 cupos), Tarde (2 cupos), Coordinación AM/PM,
  // Suspensión temporal (suspendidos esa semana) y Descanso (todos los que
  // descansan ese día, una fila por persona).
  async function onDownloadScheduleXlsx() {
    if (!state.schedule) { toast('Genera o guarda el horario primero.'); return; }
    if (typeof ExcelJS === 'undefined') {
      alert('No se pudo cargar la librería de Excel. Revisa tu conexión y reintenta.');
      return;
    }
    const week = Scheduler.weekDates(state.currentWeek);
    const labelOf = id => {
      if (!id) return '';
      const w = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
      return (w ? w.name : '').toUpperCase();
    };

    // Suspendidos esa semana = conductores con is_active=false (a futuro
    // podríamos cruzar con una columna de "suspendido por semana", pero hoy
    // is_active es global).
    let suspendedNames = [];
    try {
      const all = await Api.listAllDriversForAdmin();
      suspendedNames = all.filter(d => !d.active).map(d => d.name.toUpperCase());
    } catch (e) { /* si falla, fila queda vacía */ }

    // Por día, lista de conductores que descansan. Se obtiene del schedule.rest
    // de cada día (excluyendo admins).
    const driverIdSet = new Set(state.drivers.map(d => d.id));
    const restByDay = week.map(d => {
      const ids = state.schedule[d.key]?.rest || [];
      return ids.filter(id => driverIdSet.has(id)).map(labelOf);
    });
    const maxRest = Math.max(1, ...restByDay.map(r => r.length));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('TURNOS SEMANALES', {
      views: [{ showGridLines: false }],
    });

    // Anchos de columna similares al formato original.
    ws.columns = [
      { width: 2.8 },   // A: margen
      { width: 29 },    // B: label
      { width: 4.2 },   // C: sub-label (AM/PM en coord)
      { width: 26 },    // D: LUN
      { width: 26 },    // E: MAR
      { width: 26 },    // F: MIÉ
      { width: 26 },    // G: JUE
      { width: 26 },    // H: VIE
      { width: 26 },    // I: SÁB
      { width: 26 },    // J: DOM
    ];

    // Helpers de estilo.
    const border = { style: 'thin', color: { argb: 'FFBFBFBF' } };
    const allBorders = { top: border, bottom: border, left: border, right: border };
    const titleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4791F' } };
    const morningFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEAF6' } };
    const afternoonFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE5D6' } };
    const coordFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
    const suspFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
    const restFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const centerWrap = { horizontal: 'center', vertical: 'middle', wrapText: true };

    // Título: HORARIO SEMANAL (B2:J2)
    ws.mergeCells('B2:J2');
    const t = ws.getCell('B2');
    t.value = 'HORARIO SEMANAL';
    t.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    t.fill = titleFill;
    t.alignment = centerWrap;
    ws.getRow(2).height = 32;

    // Encabezado: FRANJA DE SERVICIO + días (fila 4)
    ws.mergeCells('B4:C4');
    const head = ws.getCell('B4');
    head.value = 'FRANJA DE SERVICIO';
    head.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = headerFill;
    head.alignment = centerWrap;
    head.border = allBorders;
    const dayCols = ['D', 'E', 'F', 'G', 'H', 'I', 'J'];
    week.forEach((d, i) => {
      const cell = ws.getCell(`${dayCols[i]}4`);
      cell.value = `${d.label} ${d.dayNum}`;
      cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = headerFill;
      cell.alignment = centerWrap;
      cell.border = allBorders;
    });
    ws.getRow(4).height = 22;

    // Filas MAÑANA (cupos), TARDE (cupos)
    const morningSlots = state.settings.morning_slots;
    const afternoonSlots = state.settings.afternoon_slots;
    let row = 5;
    // MAÑANA
    const morningStart = row;
    for (let i = 0; i < morningSlots; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = labelOf(state.schedule[d.key]?.morning?.[i]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = morningFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 26;
    }
    const morningEnd = row - 1;
    ws.mergeCells(`B${morningStart}:C${morningEnd}`);
    const mLabel = ws.getCell(`B${morningStart}`);
    mLabel.value = `MAÑANA (${state.settings.morning_label})`;
    mLabel.font = { name: 'Arial', size: 12, bold: true };
    mLabel.fill = morningFill;
    mLabel.alignment = centerWrap;
    mLabel.border = allBorders;

    // TARDE
    const afternoonStart = row;
    for (let i = 0; i < afternoonSlots; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = labelOf(state.schedule[d.key]?.afternoon?.[i]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = afternoonFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 26;
    }
    const afternoonEnd = row - 1;
    ws.mergeCells(`B${afternoonStart}:C${afternoonEnd}`);
    const aLabel = ws.getCell(`B${afternoonStart}`);
    aLabel.value = `TARDE (${state.settings.afternoon_label})`;
    aLabel.font = { name: 'Arial', size: 12, bold: true };
    aLabel.fill = afternoonFill;
    aLabel.alignment = centerWrap;
    aLabel.border = allBorders;

    // COORDINACIÓN (AM + PM): 2 filas, label en B mergeado, subcat AM/PM en C
    const coordAmRow = row;
    const coordPmRow = row + 1;
    ws.mergeCells(`B${coordAmRow}:B${coordPmRow}`);
    const cLabel = ws.getCell(`B${coordAmRow}`);
    cLabel.value = 'COORDINACIÓN';
    cLabel.font = { name: 'Arial', size: 12, bold: true };
    cLabel.fill = coordFill;
    cLabel.alignment = centerWrap;
    cLabel.border = allBorders;
    ['AM', 'PM'].forEach((sub, idx) => {
      const r = coordAmRow + idx;
      const subCell = ws.getCell(`C${r}`);
      subCell.value = sub;
      subCell.font = { name: 'Arial', size: 11, bold: true };
      subCell.fill = coordFill;
      subCell.alignment = centerWrap;
      subCell.border = allBorders;
      const kind = idx === 0 ? 'coord_am' : 'coord_pm';
      week.forEach((d, di) => {
        const cell = ws.getCell(`${dayCols[di]}${r}`);
        cell.value = labelOf(state.schedule[d.key]?.[kind]?.[0]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = coordFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(r).height = 24;
    });
    row = coordPmRow + 1;

    // Fila vacía pequeña (separador, como en el original).
    ws.getRow(row).height = 6; row++;

    // SUSPENSIÓN TEMPORAL: una fila con los nombres separados por coma.
    const suspRow = row;
    ws.mergeCells(`B${suspRow}:C${suspRow}`);
    const sLabel = ws.getCell(`B${suspRow}`);
    sLabel.value = 'SUSPENSIÓN TEMPORAL';
    sLabel.font = { name: 'Arial', size: 12, bold: true };
    sLabel.fill = suspFill;
    sLabel.alignment = centerWrap;
    sLabel.border = allBorders;
    // Una sola celda mergeada para mostrar todos los nombres.
    ws.mergeCells(`D${suspRow}:J${suspRow}`);
    const sCell = ws.getCell(`D${suspRow}`);
    sCell.value = suspendedNames.length ? suspendedNames.join(', ') : '—';
    sCell.font = { name: 'Arial', size: 11 };
    sCell.fill = suspFill;
    sCell.alignment = centerWrap;
    sCell.border = allBorders;
    ws.getRow(suspRow).height = 28;
    row++;

    // Fila vacía pequeña (separador).
    ws.getRow(row).height = 6; row++;

    // DESCANSO: una fila por persona; label en B mergeado verticalmente.
    const restStart = row;
    for (let i = 0; i < maxRest; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = restByDay[idx][i] || '';
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = restFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 22;
    }
    const restEnd = row - 1;
    ws.mergeCells(`B${restStart}:C${restEnd}`);
    const rLabel = ws.getCell(`B${restStart}`);
    rLabel.value = 'DESCANSO';
    rLabel.font = { name: 'Arial', size: 12, bold: true };
    rLabel.fill = restFill;
    rLabel.alignment = centerWrap;
    rLabel.border = allBorders;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `horario_${state.currentWeek}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ====================================================================
  // Driver view — cards mobile-first
  // ====================================================================

  async function refreshDriverView() {
    updateDriverWeekLabel();
    // Refrescar settings: así el conductor ve si el jefe reabrió la semana.
    try { state.settings = await Api.getSettings(); } catch (e) { /* usa el cacheado */ }
    state.ownAvail = await Api.getMyWeeklyAvailability(state.profile.id, state.currentWeek);
    try { state.weekSuspension = await Api.getMyWeekSuspension(state.profile.id, state.currentWeek); }
    catch (e) { state.weekSuspension = null; }
    renderDriverDays();
    await renderDriverRequests();
    await renderDriverPublishedSchedule();
    await renderDriverSwaps();
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
    setCurrentWeekManual(Scheduler.addDays(state.currentWeek, deltaDays));
    refreshDriverView();
  }

  function renderDriverDays() {
    const week = Scheduler.weekDates(state.currentWeek);
    const todayISO = new Date().toISOString().slice(0,10);
    const wrap = $('#driver-days');
    const reopen = reopenInfo(state.currentWeek);
    const suspended = isSuspended();
    const locked = suspended || weekAvailClosed(state.currentWeek);
    const soon = !locked && !reopen.active && Scheduler.availabilityClosingSoon(state.currentWeek);
    const banner = suspended
      ? `<div class="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 font-semibold">🚫 Tu cuenta está suspendida. No puedes marcar disponibilidad ni hacer solicitudes hasta que tu admin te reactive.</div>`
      : (reopen.active
      ? `<div class="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 font-semibold">✅ El jefe reabrió esta semana hasta las ${hhmmCO(reopen.until)}. Corrige y guarda antes de esa hora.</div>`
      : (locked
      ? `<div class="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 font-semibold">🔒 La disponibilidad de esta semana cerró el domingo 2:00 PM. Habla con tu jefe.</div>`
      : (soon
        ? `<div class="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 font-semibold">⚠ La disponibilidad de esta semana cierra HOY a las 2:00 PM. Guarda antes.</div>`
        : `<div class="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 font-semibold">ℹ️ Tienes hasta el domingo 2:00 PM para guardar la disponibilidad de esta semana.</div>`)));
    const suspWeekBanner = state.weekSuspension
      ? `<div class="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 font-semibold">🚫 Estás suspendido esta semana${state.weekSuspension.source === 'strikes' ? ' por acumular 3 strikes' : ''}. No entras en la generación de turnos. Habla con tu jefe.</div>`
      : '';
    wrap.innerHTML = banner + suspWeekBanner + week.map(d => {
      const av = state.ownAvail[d.key] || { am: 'available', pm: 'available', shift_pref: 'any' };
      const isWeekend = d.key === 'sat' || d.key === 'sun';
      const isToday = d.date === todayISO;
      const cls = ['day-card'];
      if (isWeekend) cls.push('is-weekend');
      if (isToday) cls.push('is-today');
      // Bloqueo por parametrización del propio conductor: 🔒, solo lectura.
      const amBlocked = Scheduler.ruleBlocked(state.profile, d.key, 'am');
      const pmBlocked = Scheduler.ruleBlocked(state.profile, d.key, 'pm');
      // El selector AM/PM/Indistinto solo aparece si AM Y PM están disponibles
      // (si pediste descanso/no disponible o hay bloqueo, la preferencia no aplica).
      const bothAvailable = av.am === 'available' && av.pm === 'available' && !amBlocked && !pmBlocked;
      const pref = av.shift_pref || 'any';
      const prefBtn = (val, label) => `<button class="pref-btn ${pref === val ? 'pref-on' : ''}" data-pref-day="${d.key}" data-pref-val="${val}">${label}</button>`;
      const prefRow = bothAvailable ? `<div class="day-pref-row">
        <span class="day-pref-label">Prefiero:</span>
        ${prefBtn('any', 'Indistinto')}
        ${prefBtn('am', 'AM')}
        ${prefBtn('pm', 'PM')}
      </div>` : '';
      const shiftBtn = (shift, label, blocked, state) => blocked
        ? `<button class="shift-btn shift-btn-blocked" data-day="${d.key}" data-shift="${shift}" data-state="blocked" data-blocked="1" disabled title="Tu jefe configuró este día/jornada como descanso fijo">
            <span class="shift-btn-label">${label}</span>
            <span class="shift-btn-state">🔒 Bloqueado</span>
          </button>`
        : `<button class="shift-btn" data-day="${d.key}" data-shift="${shift}" data-state="${state}">
            <span class="shift-btn-label">${label}</span>
            <span class="shift-btn-state">${stateLabelShort(state)} ${approvalBadgeHtml(shift === 'am' ? av.am_request : av.pm_request)}</span>
          </button>`;
      const fixedNote = (amBlocked || pmBlocked)
        ? `<p class="day-fixed-note">🔒 Descanso fijo configurado por tu jefe.</p>` : '';
      return `<div class="${cls.join(' ')}">
        <div class="day-card-header">
          <div>
            <p class="day-card-day">${d.label}</p>
            <p class="day-card-date">${d.dayNum} ${monthShort(d.date)} ${isToday ? '· HOY' : ''}</p>
          </div>
        </div>
        <div class="day-card-actions">
          ${shiftBtn('am', 'MAÑANA', amBlocked, av.am)}
          ${shiftBtn('pm', 'TARDE', pmBlocked, av.pm)}
        </div>
        ${fixedNote}
        ${prefRow}
        ${(amBlocked && pmBlocked) ? '' : `<button class="day-all-btn" data-day="${d.key}" data-shift="whole">Todo el día</button>`}
      </div>`;
    }).join('');

    wrap.querySelectorAll('.shift-btn, .day-all-btn, .pref-btn').forEach(btn => {
      if (suspended) btn.disabled = true;
    });
    wrap.querySelectorAll('.shift-btn, .day-all-btn').forEach(btn => {
      btn.addEventListener('click', () => openStatePicker(btn.dataset.day, btn.dataset.shift));
    });
    wrap.querySelectorAll('.pref-btn').forEach(btn => {
      btn.addEventListener('click', () => setDayPref(btn.dataset.prefDay, btn.dataset.prefVal));
    });
    const saveBtn = $('#driver-save-btn');
    if (saveBtn) saveBtn.disabled = locked;
    const markBtn = $('#driver-mark-all-available');
    if (markBtn) markBtn.disabled = suspended;
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

  function setDayPref(day, value) {
    if (isSuspended()) {
      toast('Tu cuenta está suspendida. Habla con tu admin para reactivarla.');
      return;
    }
    if (weekAvailClosed(state.currentWeek)) {
      toast('La disponibilidad de esta semana ya cerró.');
      return;
    }
    state.ownAvail[day] = state.ownAvail[day] || { am: 'available', pm: 'available' };
    state.ownAvail[day].shift_pref = value;
    renderDriverDays();
    flashSaveState('Cambios sin guardar', 'amber');
  }

  // State picker -------------------------------------------------------

  let pickerContext = null;

  function shiftBlockedForMe(day, shift) {
    return Scheduler.ruleBlocked(state.profile, day, shift);
  }

  function openStatePicker(day, shift) {
    if (isSuspended()) {
      toast('Tu cuenta está suspendida. Habla con tu admin para reactivarla.');
      return;
    }
    if (weekAvailClosed(state.currentWeek)) {
      toast('La disponibilidad de esta semana ya cerró (domingo 2:00 PM). Habla con tu jefe.');
      return;
    }
    // Jornada con descanso fijo: no editable por el conductor.
    if (shift !== 'whole' && shiftBlockedForMe(day, shift)) {
      toast('Esta jornada es un descanso fijo configurado por tu jefe.');
      return;
    }
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
      if (!shiftBlockedForMe(day, 'am')) { state.ownAvail[day].am = value; state.ownAvail[day].am_reason = null; }
      if (!shiftBlockedForMe(day, 'pm')) { state.ownAvail[day].pm = value; state.ownAvail[day].pm_reason = null; }
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
      if (!shiftBlockedForMe(day, 'am')) { state.ownAvail[day].am = 'unavailable'; state.ownAvail[day].am_reason = reason; }
      if (!shiftBlockedForMe(day, 'pm')) { state.ownAvail[day].pm = 'unavailable'; state.ownAvail[day].pm_reason = reason; }
    } else {
      state.ownAvail[day][shift] = 'unavailable';
      state.ownAvail[day][`${shift}_reason`] = reason;
    }
    closeReasonModal();
    renderDriverDays();
  }

  async function onDriverSave() {
    if (isSuspended()) {
      $('#driver-save-state').textContent = 'Suspendido: no puedes guardar. Habla con tu admin.';
      $('#driver-save-state').className = 'text-xs text-rose-600 flex-1';
      return;
    }
    if (weekAvailClosed(state.currentWeek)) {
      $('#driver-save-state').textContent = 'Cerrado: la disponibilidad de esta semana cerró el domingo 2:00 PM.';
      $('#driver-save-state').className = 'text-xs text-rose-600 flex-1';
      return;
    }
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

      // Descansos entre semana sin solicitud formal: se muestran como
      // "Pendiente — se confirma al publicar" para que el conductor sepa que
      // su intención está registrada (el scheduler la respeta) pero el admin
      // decide al publicar el horario.
      const haveReq = new Set(reqs.map(r => `${r.day_of_week}-${r.shift}`));
      const pendingCards = [];
      Scheduler.DAYS.forEach((dayKey, idx) => {
        const cell = state.ownAvail && state.ownAvail[dayKey];
        if (!cell) return;
        ['am', 'pm'].forEach(sh => {
          if (cell[sh] === 'prefer_rest' && !haveReq.has(`${idx}-${sh}`)) {
            const dayLabel = Scheduler.DAY_LABELS_ES[dayKey] || '—';
            pendingCards.push(`<div class="request-card" data-state="pending">
              <div class="request-card-icon">⏳</div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-ink">${dayLabel} · ${sh.toUpperCase()}</p>
                <p class="text-xs text-slate-600">Descanso · <strong>Pendiente</strong></p>
                <p class="text-xs text-slate-500 mt-1">Se confirma cuando el admin publique el horario.</p>
              </div>
            </div>`);
          }
        });
      });

      box.innerHTML = (reqCards + pendingCards.join('')) ||
        '<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4 text-center">No tienes solicitudes esta semana.</p>';
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-rose-600 p-3">Error: ${e.message}</p>`;
    }
  }

  async function renderDriverPublishedSchedule() {
    const container = $('#driver-schedule-container');
    const summaryBox = $('#driver-week-summary');
    const sch = await Api.getSchedule(state.currentWeek);
    if (!sch || !sch.published) {
      container.innerHTML = '<p class="p-6 text-sm text-slate-500 text-center">Esta semana no tiene horario publicado todavía.</p>';
      if (summaryBox) {
        summaryBox.innerHTML = `<div class="rounded-xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-sm text-slate-600 mt-1.5">Tu horario aún no está publicado para esta semana.</p>
        </div>`;
      }
      return;
    }
    // Overlay de swaps aceptados: el conductor ve el horario YA con los cambios.
    try {
      const accepted = await Api.listAcceptedSwaps(state.currentWeek);
      if (accepted.length) sch.data = Scheduler.applySwaps(sch.data, accepted);
    } catch (e) { /* sin overlay si falla */ }

    const driverNames = sch.data._names || {};
    if (!driverNames[state.profile.id]) driverNames[state.profile.id] = state.profile.full_name;
    // Guardado para la sección de cambios de turno (swaps).
    state.pubSched = sch.data;
    state.pubNames = driverNames;

    const week = Scheduler.weekDates(state.currentWeek);

    // --- Mi semana: lista corta de mis turnos + totales ---
    const myShifts = [];
    week.forEach(d => {
      const day = sch.data[d.key] || {};
      const meId = state.profile.id;
      if ((day.morning || []).includes(meId)) myShifts.push({ d, shift: 'AM', kind: 'Manejo' });
      if ((day.afternoon || []).includes(meId)) myShifts.push({ d, shift: 'PM', kind: 'Manejo' });
      if ((day.coord_am || []).includes(meId)) myShifts.push({ d, shift: 'AM', kind: 'Coordinación' });
      if ((day.coord_pm || []).includes(meId)) myShifts.push({ d, shift: 'PM', kind: 'Coordinación' });
    });
    if (summaryBox) {
      if (!myShifts.length) {
        summaryBox.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-sm text-slate-500 mt-1">No tienes turnos asignados esta semana.</p>
        </div>`;
      } else {
        const horas = myShifts.length * 12;
        const items = myShifts.map(s => `<li class="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5">
          <span class="text-sm text-ink">${s.d.label} ${s.d.dayNum}</span>
          <span class="text-xs font-semibold text-slate-600">${s.shift}${s.kind === 'Coordinación' ? ' · Coord.' : ''}</span>
        </li>`).join('');
        summaryBox.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-xs text-slate-500 mt-0.5 mb-2">${myShifts.length} turno${myShifts.length === 1 ? '' : 's'} · ${horas} h aprox.</p>
          <ul>${items}</ul>
        </div>`;
      }
    }

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
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
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
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    }
    [['coord_am', 'COORDINACIÓN AM'], ['coord_pm', 'COORDINACIÓN PM']].forEach(([kind, label]) => {
      html += '<tr class="row-coord"><td class="cell-label">' + label + '</td>';
      week.forEach(d => {
        const id = sch.data[d.key]?.[kind]?.[0];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ====================== Cambios de turno entre conductores (Fase 3) ======================

  const SHIFT_ES = { am: 'Mañana', pm: 'Tarde' };

  // Turnos de MANEJO (morning/afternoon) de un conductor en el horario publicado.
  function drivingShiftsOf(data, profileId) {
    const out = [];
    Scheduler.DAYS.forEach((day, di) => {
      const d = data[day] || {};
      if ((d.morning || []).includes(profileId)) out.push({ day, di, shift: 'am' });
      if ((d.afternoon || []).includes(profileId)) out.push({ day, di, shift: 'pm' });
    });
    return out;
  }

  function swapStateLabel(s) {
    return { pending: 'Pendiente', accepted: 'Aceptado', rejected: 'Rechazado', cancelled: 'Cancelado' }[s] || s;
  }

  async function renderDriverSwaps() {
    // Contenedor (se inyecta antes del horario si no existe en el HTML).
    let box = document.getElementById('driver-swaps-container');
    if (!box) {
      const schedWrap = document.getElementById('driver-schedule-container');
      if (!schedWrap || !schedWrap.parentNode) return;
      box = document.createElement('div');
      box.id = 'driver-swaps-container';
      box.className = 'mb-4';
      schedWrap.parentNode.insertBefore(box, schedWrap);
    }
    const data = state.pubSched;
    if (!data) { box.innerHTML = ''; return; }
    const meId = state.profile.id;

    let mySwaps = [];
    try { mySwaps = await Api.listMySwaps(meId, state.currentWeek); } catch (e) { /* vacío */ }
    const names = state.pubNames || {};
    const label = (di, shift) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[di]]} · ${SHIFT_ES[shift]}`;

    // Entrantes (yo soy el destinatario y está pendiente).
    const incoming = mySwaps.filter(s => s.target_id === meId && s.state === 'pending');
    const incomingHtml = incoming.map(s => `
      <div class="swap-card" data-state="pending">
        <p class="swap-card-title">${escapeHtml(names[s.requester_id] || 'Un compañero')} te propone un cambio</p>
        <p class="swap-card-detail">Te daría: <strong>${label(s.from_day, s.from_shift)}</strong><br>A cambio de tu: <strong>${label(s.to_day, s.to_shift)}</strong></p>
        ${s.note ? `<p class="swap-card-note">"${escapeHtml(s.note)}"</p>` : ''}
        <div class="swap-card-actions">
          <button data-swap-accept="${s.id}" class="wk-btn wk-coord-on">Aceptar</button>
          <button data-swap-reject="${s.id}" class="wk-btn">Rechazar</button>
        </div>
      </div>`).join('');

    // Salientes / historial (yo solicité, o ya resueltas).
    const others = mySwaps.filter(s => !(s.target_id === meId && s.state === 'pending'));
    const othersHtml = others.map(s => {
      const mine = s.requester_id === meId;
      const who = mine ? (names[s.target_id] || 'Compañero') : (names[s.requester_id] || 'Compañero');
      return `<div class="swap-card" data-state="${s.state}">
        <p class="swap-card-title">${mine ? 'Pediste a' : 'Te pidió'} ${escapeHtml(who)} · <strong>${swapStateLabel(s.state)}</strong></p>
        <p class="swap-card-detail">${label(s.from_day, s.from_shift)} ⇄ ${label(s.to_day, s.to_shift)}</p>
        ${(mine && s.state === 'pending') ? `<div class="swap-card-actions"><button data-swap-cancel="${s.id}" class="wk-btn">Cancelar</button></div>` : ''}
      </div>`;
    }).join('');

    const canPropose = drivingShiftsOf(data, meId).length > 0 && !state.weekSuspension;
    box.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-ink">Cambios de turno</h3>
        ${canPropose ? '<button id="swap-propose-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">+ Proponer cambio</button>' : ''}
      </div>
      ${incomingHtml || ''}
      ${othersHtml || ''}
      ${(!incoming.length && !others.length) ? '<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-3 text-center">No tienes cambios de turno esta semana.</p>' : ''}`;

    document.getElementById('swap-propose-btn')?.addEventListener('click', openSwapModal);
    box.querySelectorAll('[data-swap-accept]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapAccept, 'accepted', b)));
    box.querySelectorAll('[data-swap-reject]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapReject, 'rejected', b)));
    box.querySelectorAll('[data-swap-cancel]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapCancel, 'cancelled', b)));
  }

  // Al aceptar: re-validar con el horario actual y el email del que acepta.
  async function onSwapDecision(id, decision, btn) {
    if (decision === 'cancelled' && !confirm('¿Cancelar esta solicitud de cambio?')) return;
    if (decision === 'rejected' && !confirm('¿Rechazar este cambio?')) return;
    btn.disabled = true;
    try {
      if (decision === 'accepted') {
        const swaps = await Api.listMySwaps(state.profile.id, state.currentWeek);
        const sw = swaps.find(s => s.id === id);
        if (!sw) throw new Error('La solicitud ya no existe.');
        // Validar de nuevo contra el horario actual (incluye ambas partes por id).
        const fresh = await Api.getSchedule(state.currentWeek);
        const dById = {
          [sw.requester_id]: { id: sw.requester_id, name: (state.pubNames || {})[sw.requester_id] },
          [state.profile.id]: { id: state.profile.id, name: state.profile.full_name, email: state.profile.email },
        };
        const v = Scheduler.validateSwap(fresh?.data || {}, sw, dById);
        if (!v.ok) { alert('No se puede aceptar: ' + v.reason); btn.disabled = false; return; }
      }
      await Api.decideSwap(id, decision);
      // Avisar al solicitante el resultado (si yo soy el destinatario que decide).
      if (decision === 'accepted' || decision === 'rejected') {
        const swaps2 = await Api.listMySwaps(state.profile.id, state.currentWeek).catch(() => []);
        const sw2 = swaps2.find(s => s.id === id);
        if (sw2 && sw2.requester_id !== state.profile.id) {
          notify([sw2.requester_id], 'Cambio de turno',
            `${state.profile.full_name} ${decision === 'accepted' ? 'aceptó' : 'rechazó'} tu cambio.`, '/');
        }
      }
      await refreshDriverView();
      toast({ accepted: 'Cambio aceptado.', rejected: 'Cambio rechazado.', cancelled: 'Solicitud cancelada.' }[decision]);
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  // Modal para proponer un cambio: elijo MI turno y el turno de un compañero.
  function openSwapModal() {
    document.getElementById('swap-modal')?.remove();
    const data = state.pubSched, names = state.pubNames || {}, meId = state.profile.id;
    const myShifts = drivingShiftsOf(data, meId);
    // Turnos de los DEMÁS conductores (posibles destinos).
    const otherShifts = [];
    Scheduler.DAYS.forEach((day, di) => {
      const d = data[day] || {};
      (d.morning || []).forEach(id => { if (id && id !== meId) otherShifts.push({ id, di, shift: 'am' }); });
      (d.afternoon || []).forEach(id => { if (id && id !== meId) otherShifts.push({ id, di, shift: 'pm' }); });
    });
    const lbl = (di, shift) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[di]]} · ${SHIFT_ES[shift]}`;
    const myOpts = myShifts.map((s, i) => `<option value="${i}">${lbl(s.di, s.shift)}</option>`).join('');
    const otherOpts = otherShifts.map((s, i) => `<option value="${i}">${escapeHtml(names[s.id] || 'Compañero')} — ${lbl(s.di, s.shift)}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.id = 'swap-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h3 class="modal-title">Proponer cambio de turno</h3>
          <p class="modal-subtitle">Tu turno se intercambia con el de un compañero. Él debe aceptar.</p>
        </div>
        <label class="swap-field"><span>Cedo mi turno</span>
          <select id="swap-from">${myOpts}</select></label>
        <label class="swap-field"><span>A cambio del turno de</span>
          <select id="swap-to">${otherOpts}</select></label>
        <label class="swap-field"><span>Mensaje (opcional)</span>
          <input id="swap-note" type="text" maxlength="140" placeholder="Ej: tengo una cita ese día"></label>
        <div class="modal-actions">
          <button id="swap-cancel-btn" class="wk-btn">Cancelar</button>
          <button id="swap-send-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Enviar propuesta</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#swap-cancel-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#swap-send-btn').addEventListener('click', async () => {
      const fi = parseInt(overlay.querySelector('#swap-from').value, 10);
      const ti = parseInt(overlay.querySelector('#swap-to').value, 10);
      const mine = myShifts[fi], theirs = otherShifts[ti];
      if (!mine || !theirs) { alert('Elige los dos turnos.'); return; }
      const swap = {
        requester_id: meId, target_id: theirs.id,
        from_day: mine.di, from_shift: mine.shift, to_day: theirs.di, to_shift: theirs.shift,
      };
      const dById = {
        [meId]: { id: meId, name: state.profile.full_name, email: state.profile.email },
        [theirs.id]: { id: theirs.id, name: names[theirs.id] },
      };
      const v = Scheduler.validateSwap(data, swap, dById);
      if (!v.ok) { alert('Ese cambio no es válido: ' + v.reason); return; }
      const btn = overlay.querySelector('#swap-send-btn');
      btn.disabled = true;
      try {
        await Api.createSwap({
          requesterId: meId, targetId: theirs.id, weekStart: state.currentWeek,
          fromDay: mine.di, fromShift: mine.shift, toDay: theirs.di, toShift: theirs.shift,
          note: overlay.querySelector('#swap-note').value.trim() || null,
        });
        notify([theirs.id], 'Cambio de turno', `${state.profile.full_name} te propone un cambio de turno.`, '/');
        overlay.remove();
        await refreshDriverView();
        toast('Propuesta enviada. Tu compañero debe aceptarla.');
      } catch (e) { alert('Error al enviar: ' + e.message); btn.disabled = false; }
    });
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

  // ====================================================================
  // Web Push (Fase 5)
  // ====================================================================

  const VAPID_PUBLIC_KEY = (window.RENDIO_CONFIG && window.RENDIO_CONFIG.VAPID_PUBLIC_KEY) || '';

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC_KEY;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Suscribe el dispositivo y guarda la suscripción en la BD.
  async function enablePush() {
    if (!pushSupported()) { toast('Las notificaciones no están disponibles en este dispositivo.'); return; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('No autorizaste las notificaciones.'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const json = sub.toJSON();
      await Api.savePushSubscription({
        profileId: state.profile.id,
        endpoint: sub.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        userAgent: navigator.userAgent,
      });
      toast('🔔 Notificaciones activadas.');
      setupPushUI(); // oculta el botón
    } catch (e) {
      toast('No se pudieron activar las notificaciones.');
      console.error(e);
    }
  }

  // Inyecta el botón "Activar notificaciones" si aplica (no soportado / ya
  // suscrito / permiso denegado → no se muestra).
  async function setupPushUI() {
    const existing = document.getElementById('enable-push-bar');
    if (!pushSupported() || Notification.permission === 'denied') { existing?.remove(); return; }
    let alreadySub = false;
    try {
      const reg = await navigator.serviceWorker.ready;
      alreadySub = !!(await reg.pushManager.getSubscription());
    } catch (e) { /* ignore */ }
    if (alreadySub) { existing?.remove(); return; }

    // Contenedor según el rol.
    const host = state.profile.role === 'admin'
      ? document.getElementById('app-shell')
      : document.getElementById('screen-driver');
    if (!host) return;
    if (existing) return; // ya está
    const bar = document.createElement('div');
    bar.id = 'enable-push-bar';
    bar.className = 'push-bar';
    bar.innerHTML = `<span>🔔 Activa las notificaciones para enterarte de cambios de turno, strikes y horarios.</span>
      <button id="enable-push-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Activar</button>`;
    host.insertBefore(bar, host.firstChild);
    document.getElementById('enable-push-btn').addEventListener('click', enablePush);
  }

  // Notificación best-effort (si la Edge Function no está desplegada, ignora).
  async function notify(profileIds, title, body, url) {
    if (!profileIds || !profileIds.length) return;
    try { await Api.sendPush({ profileIds, title, body, url: url || '/' }); }
    catch (e) { /* push opcional: nunca rompe el flujo principal */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
