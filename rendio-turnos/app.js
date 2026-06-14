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

    // Disponibilidad (paleta limpia): búsqueda, filtro y navegación de semana.
    $('#avail-search')?.addEventListener('input', renderAvailability);
    $('#avail-filter')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]'); if (!b) return;
      state._availFilter = b.dataset.f;
      $('#avail-filter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderAvailability();
    });
    $('#avail-summary')?.addEventListener('click', (e) => {
      if (!e.target.closest('[data-jump="pending"]')) return;
      state._availFilter = 'pending';
      $('#avail-filter')?.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.f === 'pending'));
      renderAvailability();
    });
    $('#avail-prev-week')?.addEventListener('click', () => { setCurrentWeekManual(Scheduler.addDays(state.currentWeek, -7)); refreshAvailabilityMatrix(); });
    $('#avail-next-week')?.addEventListener('click', () => { setCurrentWeekManual(Scheduler.addDays(state.currentWeek, 7)); refreshAvailabilityMatrix(); });

    $('#cell-editor-cancel').addEventListener('click', closeCellEditor);
    $('#cell-editor-save').addEventListener('click', saveCellEditor);
    $('#cell-editor').addEventListener('click', (e) => {
      if (e.target.id === 'cell-editor') closeCellEditor();
    });

    $('#driver-prev-week').addEventListener('click', () => navigateDriverWeek(-7));
    $('#driver-next-week').addEventListener('click', () => navigateDriverWeek(7));
    $('#driver-save-btn').addEventListener('click', onDriverSave);
    $('#driver-mark-all-available').addEventListener('click', onMarkAllAvailable);
    $('#driver-availability-card')?.addEventListener('click', showDriverAvailability);
    $('#driver-back-home')?.addEventListener('click', showDriverHome);
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
      await refreshDriverView();
      showDriverHome(); // arranca en la home de 2 tarjetas, no en la disponibilidad
      // Inicio de turno (Etapa 1 módulo conductor) — card + wizard.
      if (window.ShiftFlow) ShiftFlow.init(state.profile).catch(e => console.error(e));
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

  // Calcula quién queda FUERA del pool del board: no llenó disponibilidad (corte
  // pasado) o está suspendido esta semana. Se guarda en state para que renderPool
  // lo lea síncrono. Fail-safe: si una consulta falla, no excluye a nadie.
  async function refreshExclusions() {
    state._excludedIds = new Set();
    state._suspendedIds = new Set();
    try {
      if (weekAvailClosed(state.currentWeek)) {
        const submitted = await Api.listSubmittedDriverIds(state.currentWeek);
        state.drivers.forEach(d => { if (!submitted.has(d.id)) state._excludedIds.add(d.id); });
      }
    } catch (e) { state._excludedIds = new Set(); }
    try {
      const susp = await Api.getWeekSuspensions(state.currentWeek);
      if (susp && susp.size) state.drivers.forEach(d => { if (susp.has(d.id)) state._suspendedIds.add(d.id); });
    } catch (e) { /* fail-safe */ }
  }

  async function refreshScheduleData() {
    $('#week-start-input').value = state.currentWeek;
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const sch = await Api.getSchedule(state.currentWeek);
    state.schedule = sch ? sch.data : null;
    $('#published-pill').classList.toggle('hidden', !sch?.published);
    await refreshExclusions();
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

  // ====================================================================
  // Admin: Horario — Tablero v4 (board drag & drop)
  // El board reemplaza la tabla. Misma lógica/datos (state.schedule); solo
  // cambia la presentación. Generar autollena; arrastrar ajusta a mano. La
  // persistencia sigue siendo manual (Guardar/Publicar).
  // ====================================================================

  let boardDrag = null;        // { id, src }  src = "day-kind-index" | "pool"
  let boardJustPlaced = null;  // "day-kind-index": anima el último drop
  let boardBound = false;      // bind de listeners una sola vez
  let boardBadgeT = null;

  // Carriles del board derivados de settings + 2 de coordinación.
  function boardLanes() {
    const s = state.settings || { morning_slots: 2, afternoon_slots: 2 };
    const lanes = [];
    for (let i = 0; i < (s.morning_slots || 0); i++) lanes.push({ kind: 'morning', index: i, group: 'am' });
    for (let i = 0; i < (s.afternoon_slots || 0); i++) lanes.push({ kind: 'afternoon', index: i, group: 'pm' });
    lanes.push({ kind: 'coord_am', index: 0, group: 'co' });
    lanes.push({ kind: 'coord_pm', index: 0, group: 'co' });
    return lanes;
  }
  const BOARD_GROUP_LABEL = { am: 'Mañana', pm: 'Tarde', co: 'Coord' };
  const laneShift = (kind) => (kind === 'morning' || kind === 'coord_am') ? 'am' : 'pm';
  const laneLabel = (lane) => ({ morning: 'Mañana', afternoon: 'Tarde', coord_am: 'Coord AM', coord_pm: 'Coord PM' }[lane.kind] || lane.kind);
  const laneShortLabel = (lane) => lane.group === 'am' ? 'AM' : lane.group === 'pm' ? 'PM' : (lane.kind === 'coord_am' ? 'Coord AM' : 'Coord PM');
  const hardLabel = (k) => ({ unavailable: 'no disp.', rule: 'descanso fijo', double: 'doble turno' }[k] || 'conflicto');

  const isExcluded = (id) => !!(state._excludedIds && state._excludedIds.has(id));
  const isSuspendedId = (id) => !!(state._suspendedIds && state._suspendedIds.has(id));

  function initialsOf(name) {
    const p = String(name || '—').trim().split(/\s+/);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }
  function firstTwo(name) {
    const p = String(name || '—').trim().split(/\s+/);
    return p[0] + (p[1] ? ' ' + p[1][0] + '.' : '');
  }
  function colorOfId(id) {
    const palette = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#DB4B3F', '#F26522'];
    let h = 0; const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // Carga semanal (manejo + coordinación) de un id sobre state.schedule.
  function boardLoadOf(id) {
    if (!state.schedule) return 0;
    let n = 0;
    Scheduler.DAYS.forEach(day => {
      const d = state.schedule[day]; if (!d) return;
      ['morning', 'afternoon', 'coord_am', 'coord_pm'].forEach(k => { if ((d[k] || []).includes(id)) n++; });
    });
    return n;
  }

  // Conflicto DURO al tener `id` en day/kind: no disponible / descanso fijo / doble turno.
  function dayConflict(day, id, kind) {
    if (!id) return null;
    const shift = laneShift(kind);
    try { if (Scheduler.getState(state.availability, id, day, shift) === 'unavailable') return 'unavailable'; } catch (e) { /* */ }
    const who = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
    try { if (who && Scheduler.ruleBlocked(who, day, shift)) return 'rule'; } catch (e) { /* */ }
    const d = state.schedule?.[day] || {};
    if (kind === 'morning' && (d.afternoon || []).includes(id)) return 'double';
    if (kind === 'afternoon' && (d.morning || []).includes(id)) return 'double';
    return null;
  }
  // Conflicto SUAVE: pidió descanso esa jornada (ámbar, no bloquea).
  function daySoft(day, id, kind) {
    if (!id || isCoordKind(kind)) return false;
    try { return Scheduler.getState(state.availability, id, day, laneShift(kind)) === 'prefer_rest'; } catch (e) { return false; }
  }
  function conflictMsg(key, id, day) {
    const nm = (nameOf(id) || '').split(' ')[0];
    const dl = (Scheduler.DAY_LABELS_ES[day] || day).toLowerCase();
    const why = { unavailable: 'no está disponible', rule: 'tiene descanso fijo', double: 'quedaría con doble turno' }[key] || 'tiene un conflicto';
    return `${nm} ${why} el ${dl}. Queda marcado en rojo.`;
  }

  function dayCoverage(dayKey) {
    const lanes = boardLanes();
    const d = state.schedule?.[dayKey];
    let filled = 0;
    lanes.forEach(l => { if (d?.[l.kind]?.[l.index]) filled++; });
    return { filled, total: lanes.length };
  }

  // ---- Render principal (reemplaza la tabla anterior) ----
  function renderSchedule() {
    renderBoardChrome();
    renderKPIs();
    renderPool();
    renderBoardGrid();
    renderWorkerSummary();
    bindBoard();
  }

  function renderBoardChrome() {
    let saved = null;
    try { saved = localStorage.getItem('rendio-board-theme'); } catch (e) { /* */ }
    applyBoardTheme(saved === 'dark' ? 'dark' : 'light');

    const week = Scheduler.weekDates(state.currentWeek);
    const lbl = $('#board-week-label');
    if (lbl) {
      let mon = '';
      try { mon = new Date(state.currentWeek + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' }).replace('.', ''); } catch (e) { /* */ }
      lbl.textContent = `${String(week[0].dayNum).padStart(2, '0')} – ${String(week[6].dayNum).padStart(2, '0')} ${mon}`.trim();
    }
    const chip = $('#board-cutoff-chip');
    if (chip) {
      const info = reopenInfo(state.currentWeek);
      if (info.active) { chip.textContent = `Reabierta hasta ${hhmmCO(info.until)}`; chip.className = 'chip ok'; }
      else if (weekAvailClosed(state.currentWeek)) { chip.textContent = 'Corte cerrado'; chip.className = 'chip'; }
      else { chip.textContent = 'Disponibilidad abierta'; chip.className = 'chip ok'; }
    }
  }

  function renderKPIs() {
    const el = $('#kpis'); if (!el) return;
    const week = Scheduler.weekDates(state.currentWeek);
    let filled = 0, total = 0, coordDays = 0, conf = 0;
    week.forEach(d => {
      const cov = dayCoverage(d.key);
      filled += cov.filled; total += cov.total;
      const day = state.schedule?.[d.key];
      if (day?.coord_am?.[0] && day?.coord_pm?.[0]) coordDays++;
      boardLanes().forEach(l => {
        const id = day?.[l.kind]?.[l.index];
        if (id && dayConflict(d.key, id, l.kind)) conf++;
      });
    });
    const huecos = total - filled;
    const pct = total ? Math.round(filled / total * 100) : 0;
    const loads = state.drivers.map(d => ({ id: d.id, l: boardLoadOf(d.id) }));
    const maxL = loads.reduce((m, x) => Math.max(m, x.l), 0);
    const top = loads.filter(x => x.l === maxL && maxL > 0).map(x => (nameOf(x.id) || '').split(' ')[0]);
    const low = loads.filter(x => !isExcluded(x.id) && !isSuspendedId(x.id) && x.l <= 2).map(x => (nameOf(x.id) || '').split(' ')[0]);
    const rc = pct >= 90 ? 'var(--green)' : pct >= 75 ? 'var(--amber)' : 'var(--red)';
    const covClass = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'alert';
    const dots = (n, cls) => { const k = Math.min(n, 7); return k ? Array.from({ length: k }).map(() => `<i class="${cls}"></i>`).join('') : '<i></i>'; };
    el.innerHTML = `
      <div class="k ${covClass}">
        <div class="ring" style="--p:${pct};--rc:${rc}"><b>${pct}</b></div>
        <div class="tx"><em>Cobertura</em><b>${filled}/${total}</b><span>cupos cubiertos</span></div>
      </div>
      <div class="k ${huecos ? 'warn' : 'ok'}"><div class="tx"><em>Huecos</em><b>${huecos}</b><span>${huecos ? 'por cubrir' : 'todo cubierto'}</span><div class="dotrow">${dots(huecos, 'w')}</div></div></div>
      <div class="k ${conf ? 'alert' : 'ok'}"><div class="tx"><em>Conflictos</em><b>${conf}</b><span>${conf ? 'revisa el rojo' : 'sin conflictos'}</span><div class="dotrow">${dots(conf, 'e')}</div></div></div>
      <div class="k ${coordDays < 7 ? 'warn' : 'ok'}"><div class="tx"><em>Coordinación</em><b>${coordDays}/7</b><span>días con guía</span></div></div>
      <div class="k ${maxL >= 5 ? 'warn' : ''}"><div class="tx"><em>Balance</em><b>${top[0] || '—'}${maxL ? ' ' + maxL + '/5' : ''}</b><span>${low.length ? 'Carga baja: ' + low.slice(0, 2).join(', ') : 'reparto equilibrado'}</span></div></div>`;
  }

  function renderPool() {
    const list = $('#plist'); if (!list) return;
    const filter = (state._poolFilter || '').toLowerCase();
    list.innerHTML = state.drivers.map(d => {
      const out = isExcluded(d.id) || isSuspendedId(d.id);
      const l = boardLoadOf(d.id);
      const pct = Math.min(l / 5 * 100, 100);
      const cls = out ? 'out' : l >= 5 ? 'hi' : l <= 2 ? 'lo' : '';
      const mc = l >= 5 ? 'hi' : l <= 2 ? 'lo' : '';
      const isFlex = (d.email || '').toLowerCase() === FLEX_COORD_EMAIL;
      const sub = out ? (isSuspendedId(d.id) ? 'Suspendido' : 'Fuera del corte')
        : (isFlex ? 'Coordina (flex)' : d.can_coordinate ? 'Coordina' : 'Disponible');
      const hidden = filter && !(d.name || '').toLowerCase().includes(filter) ? ' hidden' : '';
      return `<div class="pcard ${cls}"${out ? '' : ' draggable="true"'} data-driver="${d.id}" data-src="pool"${hidden}>
        <span class="av" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span>
        <div class="nm"><b>${escapeHtml(d.name)}</b><span>${escapeHtml(sub)}</span></div>
        <div class="load"><b>${out ? '—' : l + '/5'}</b><div class="meter ${mc}"><i style="width:${out ? 0 : pct}%"></i></div></div>
      </div>`;
    }).join('');
    const cnt = $('#poolcount');
    if (cnt) cnt.textContent = String(state.drivers.filter(d => !isExcluded(d.id) && !isSuspendedId(d.id)).length);
  }

  function renderBoardGrid() {
    const weekEl = $('#week'); if (!weekEl) return;
    const week = Scheduler.weekDates(state.currentWeek);
    const lanes = boardLanes();
    const sched = state.schedule;
    let todayISO = '';
    try { todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); } catch (e) { /* */ }

    weekEl.style.gridTemplateRows = `auto ${lanes.map(() => 'minmax(46px,auto)').join(' ')}`;

    let monAbbr = '';
    try { monAbbr = new Date(state.currentWeek + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' }).replace('.', '').toUpperCase(); } catch (e) { /* */ }
    let h = `<div class="corner">${escapeHtml(monAbbr)}</div>`;

    week.forEach(d => {
      const cov = dayCoverage(d.key);
      const pct = cov.total ? Math.round(cov.filled / cov.total * 100) : 0;
      const cls = cov.filled < cov.total ? (cov.total - cov.filled >= 2 ? 'alert' : 'warn') : '';
      const today = d.date === todayISO ? 'today' : '';
      h += `<div class="dhead ${cls} ${today}">
          <div class="drow"><span class="dnum">${String(d.dayNum).padStart(2, '0')}</span><span class="dow">${escapeHtml(String(d.label).slice(0, 3))}</span></div>
          <div class="cvbar"><i style="width:${pct}%"></i></div>
          <div class="cvtx">${cov.filled}/${cov.total} cupos</div>
        </div>`;
    });

    lanes.forEach(lane => {
      h += `<div class="bl">${escapeHtml(laneLabel(lane))}</div>`;
      week.forEach((d, di) => {
        const wknd = di >= 5 ? 'wknd' : '';
        const id = sched?.[d.key]?.[lane.kind]?.[lane.index] || null;
        let inner;
        if (id) {
          const hard = dayConflict(d.key, id, lane.kind);
          const soft = !hard && daySoft(d.key, id, lane.kind);
          const cardCls = [
            isCoordKind(lane.kind) ? 'coord' : '',
            hard ? 'conf' : '',
            soft ? 'soft' : '',
            boardJustPlaced === `${d.key}-${lane.kind}-${lane.index}` ? 'just' : '',
          ].filter(Boolean).join(' ');
          const nm = nameOf(id);
          const subtxt = hard ? '⚠ ' + hardLabel(hard) : (isCoordKind(lane.kind) ? 'Coordina' : BOARD_GROUP_LABEL[lane.group]);
          inner = `<div class="asg ${cardCls}" draggable="true" data-driver="${id}" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}">
              <span class="av" style="background:${colorOfId(id)}">${escapeHtml(initialsOf(nm))}</span>
              <div class="nm"><b>${escapeHtml(firstTwo(nm))}</b><span>${escapeHtml(subtxt)}</span></div>
              <span class="x" data-remove="${d.key}-${lane.kind}-${lane.index}" title="Quitar"><svg class="icon" style="width:13px;height:13px"><use href="#i-x"/></svg></span>
            </div>`;
        } else {
          inner = `<div class="drop" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}">+ asignar<small>${escapeHtml(laneShortLabel(lane))}</small></div>`;
        }
        h += `<div class="zone ${wknd}" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}"><div class="slot">${inner}</div></div>`;
      });
    });
    weekEl.innerHTML = h;
    boardJustPlaced = null;
  }

  // ---- Mutación del board (en memoria; persiste con Guardar/Publicar) ----
  function ensureScheduleShape() {
    state.schedule = state.schedule || Scheduler.emptySchedule();
    Scheduler.DAYS.forEach(d => {
      state.schedule[d] = state.schedule[d] || {};
      ['morning', 'afternoon', 'rest', 'coord_am', 'coord_pm'].forEach(k => {
        state.schedule[d][k] = state.schedule[d][k] || [];
      });
    });
  }
  function boardRemoveFrom(src) {
    if (!src || src === 'pool' || !state.schedule) return;
    const [day, kind, index] = src.split('-');
    if (state.schedule[day] && state.schedule[day][kind]) {
      state.schedule[day][kind][+index] = null;
      if (!isCoordKind(kind)) rebuildRestRow(day);
    }
  }
  function boardPlaceInto(day, kind, index, id, src) {
    ensureScheduleShape();
    if (isCoordKind(kind) && !coordPeople().some(p => p.id === id)) {
      flashBoard('Solo coordinadores (admin o Daniel) pueden ir en Coordinación.');
      return;
    }
    const scope = isCoordKind(kind) ? COORD_KINDS : ['morning', 'afternoon', 'rest'];
    scope.forEach(k => { state.schedule[day][k] = (state.schedule[day][k] || []).filter(x => x !== id); });
    if (src && src !== 'pool') boardRemoveFrom(src);
    while (state.schedule[day][kind].length <= index) state.schedule[day][kind].push(null);
    state.schedule[day][kind][index] = id;
    if (!isCoordKind(kind)) rebuildRestRow(day);
    boardJustPlaced = `${day}-${kind}-${index}`;
    renderSchedule();
    const c = dayConflict(day, id, kind);
    if (c) flashBoard(conflictMsg(c, id, day));
  }

  function flashBoard(msg) {
    const b = $('#badge'), t = $('#badgetx');
    if (!b || !t) return;
    t.textContent = msg;
    b.classList.add('show');
    clearTimeout(boardBadgeT);
    boardBadgeT = setTimeout(() => b.classList.remove('show'), 3200);
  }

  function applyBoardTheme(theme) {
    const b = $('#schedule-board'); if (!b) return;
    b.setAttribute('data-theme', theme);
    const use = b.querySelector('#board-theme-toggle .icon use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }
  function toggleBoardTheme() {
    const b = $('#schedule-board'); if (!b) return;
    const next = b.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyBoardTheme(next);
    try { localStorage.setItem('rendio-board-theme', next); } catch (e) { /* */ }
  }

  // Listeners delegados en #schedule-board, una sola vez.
  function bindBoard() {
    if (boardBound) return;
    const board = $('#schedule-board'); if (!board) return;
    boardBound = true;

    board.addEventListener('dragstart', e => {
      const c = e.target.closest('[data-driver]'); if (!c) return;
      if (c.classList.contains('out')) { e.preventDefault(); return; }
      boardDrag = { id: c.dataset.driver, src: c.dataset.src || `${c.dataset.day}-${c.dataset.kind}-${c.dataset.index}` };
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', boardDrag.id); } catch (_) { /* */ }
    });
    board.addEventListener('dragend', () => {
      board.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
      board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over'));
      $('#poolzone')?.classList.remove('drophere');
      boardDrag = null;
    });
    board.addEventListener('dragover', e => {
      if (e.target.closest('.zone') || e.target.closest('#poolzone')) e.preventDefault();
    });
    board.addEventListener('dragenter', e => {
      const z = e.target.closest('.zone');
      if (z) { board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over')); z.classList.add('over'); $('#poolzone')?.classList.remove('drophere'); return; }
      if (e.target.closest('#poolzone')) { $('#poolzone')?.classList.add('drophere'); board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over')); }
    });
    board.addEventListener('drop', e => {
      if (!boardDrag) return;
      const z = e.target.closest('.zone'), p = e.target.closest('#poolzone');
      if (z) {
        e.preventDefault();
        boardPlaceInto(z.dataset.day, z.dataset.kind, +z.dataset.index, boardDrag.id, boardDrag.src);
      } else if (p) {
        e.preventDefault();
        if (boardDrag.src && boardDrag.src !== 'pool') { boardRemoveFrom(boardDrag.src); renderSchedule(); }
      }
    });
    // Click: X = quitar; celda = editor (también fallback táctil en móvil).
    board.addEventListener('click', e => {
      const x = e.target.closest('[data-remove]');
      if (x) { e.stopPropagation(); boardRemoveFrom(x.dataset.remove); renderSchedule(); return; }
      const cell = e.target.closest('.asg, .drop');
      if (cell && cell.dataset.day) openCellEditor(cell);
    });

    $('#board-theme-toggle')?.addEventListener('click', toggleBoardTheme);
    $('#pool-search')?.addEventListener('input', e => { state._poolFilter = e.target.value; renderPool(); });
    $('#board-week-label')?.addEventListener('click', () => {
      const inp = $('#week-start-input'); if (!inp) return;
      if (inp.showPicker) { try { inp.showPicker(); return; } catch (_) { /* */ } }
      inp.focus();
    });
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
    // El pool del board atenúa a los excluidos/suspendidos de esta generación.
    state._excludedIds = new Set(excluded.map(d => d.id));
    state._suspendedIds = new Set(suspendedThisWeek.map(d => d.id));
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
    renderAvailability();
    refreshPendingBadge();
  }

  // Estado visual de un slot (paleta limpia) a partir del estado crudo +
  // la solicitud de aprobación + el bloqueo por parametrización.
  //   avail = trabaja · req = descanso pedido · off = aprobado · rej = rechazado · lock = fijo
  function availVisual(av, shift, blocked) {
    if (blocked) return 'lock';
    if ((av[shift] || 'available') === 'available') return 'avail';
    const req = av[`${shift}_request`];
    if (req && req.state === 'approved') return 'off';
    if (req && req.state === 'rejected') return 'rej';
    return 'req';
  }

  // Render del matriz de disponibilidad (sin fetch). Lo llama
  // refreshAvailabilityMatrix (tras traer datos) y los filtros/búsqueda.
  function renderAvailability() {
    const head = $('#avail-head'), body = $('#avail-body');
    if (!head || !body) return;
    const week = Scheduler.weekDates(state.currentWeek);
    const WKND = [5, 6];
    const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const lbl = $('#avail-week-label');
    if (lbl && week.length) {
      const m0 = new Date(week[0].date + 'T00:00:00').getMonth();
      const m6 = new Date(week[6].date + 'T00:00:00').getMonth();
      lbl.textContent = m0 === m6
        ? `${week[0].dayNum} – ${week[6].dayNum} ${MON[m6]}`
        : `${week[0].dayNum} ${MON[m0]} – ${week[6].dayNum} ${MON[m6]}`;
    }
    const cupoAm = (state.settings && state.settings.morning_slots) || 2;
    const cupoPm = (state.settings && state.settings.afternoon_slots) || 2;

    // Mapa visual por driver/día/jornada.
    const vis = {};
    state.drivers.forEach(d => {
      vis[d.id] = {};
      week.forEach(day => {
        const av = state.availability[d.id]?.[day.key] || { am: 'available', pm: 'available' };
        vis[d.id][day.key] = {
          am: availVisual(av, 'am', Scheduler.ruleBlocked(d, day.key, 'am')),
          pm: availVisual(av, 'pm', Scheduler.ruleBlocked(d, day.key, 'pm')),
        };
      });
    });

    // Resumen.
    let nReq = 0, nOff = 0, nLock = 0;
    state.drivers.forEach(d => week.forEach(day => ['am', 'pm'].forEach(b => {
      const v = vis[d.id][day.key][b];
      if (v === 'req') nReq++; else if (v === 'off') nOff++; else if (v === 'lock') nLock++;
    })));
    const working = (dayKey, b) => state.drivers.filter(d => {
      const v = vis[d.id][dayKey][b]; return v === 'avail' || v === 'rej';
    }).length;
    let underCupo = 0;
    week.forEach(day => { if (working(day.key, 'am') < cupoAm) underCupo++; if (working(day.key, 'pm') < cupoPm) underCupo++; });
    const sum = $('#avail-summary');
    if (sum) sum.innerHTML = `
      <div class="av-scard" data-jump="pending"><div class="ic blue"><svg class="icon"><use href="#i-clock"/></svg></div><div><div class="n">${nReq}</div><div class="l">Descansos pedidos</div></div></div>
      <div class="av-scard"><div class="ic rest"><svg class="icon"><use href="#i-zzz"/></svg></div><div><div class="n">${nOff}</div><div class="l">Descansos aprobados</div></div></div>
      <div class="av-scard"><div class="ic lock"><svg class="icon"><use href="#i-lock"/></svg></div><div><div class="n">${nLock}</div><div class="l">Descansos fijos</div></div></div>
      <div class="av-scard"><div class="ic warn"><svg class="icon"><use href="#i-warn"/></svg></div><div><div class="n">${underCupo}</div><div class="l">Slots bajo cupo</div></div></div>`;

    // Cabecera.
    head.innerHTML = `<tr><th class="namehead">Conductor</th>${week.map((d, i) => `<th><div class="dcell${WKND.includes(i) ? ' wknd' : ''}"><div class="dow">${d.label.slice(0, 3)}</div><div class="dnum">${d.dayNum}</div></div></th>`).join('')}</tr>`;

    // Filtro + búsqueda.
    const filter = state._availFilter || 'all';
    const q = ($('#avail-search') && $('#avail-search').value || '').toLowerCase().trim();
    const isVisible = d => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      let change = false, pend = false;
      week.forEach(day => ['am', 'pm'].forEach(b => { const v = vis[d.id][day.key][b]; if (v !== 'avail') change = true; if (v === 'req') pend = true; }));
      return filter === 'changes' ? change : pend;
    };
    const rows = state.drivers.filter(isVisible);

    // Fila de cobertura + filas de conductores.
    const pip = (n, cupo) => { const cls = n < cupo ? (n === 0 ? 'bad' : 'warn') : ''; return `<span class="covpip ${cls}"><span class="d"></span>${n}</span>`; };
    let html = `<tr class="covrow"><td class="namehead2">Al volante / cupo</td>${week.map(d => `<td><div class="covcell">${pip(working(d.key, 'am'), cupoAm)}${pip(working(d.key, 'pm'), cupoPm)}</div></td>`).join('')}</tr>`;
    if (!rows.length) html += `<tr><td class="name">—</td><td colspan="7" class="av-none">Sin coincidencias.</td></tr>`;
    const ICON = { req: 'i-clock', off: 'i-zzz', rej: 'i-x', lock: 'i-lock' };
    rows.forEach(d => {
      const role = d.can_coordinate ? 'Coordina' : 'Conductor';
      html += `<tr><td class="name"><div class="person"><span class="av-avt" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span><div><b>${escapeHtml(d.name)}</b><span>${role}</span></div></div></td>`;
      week.forEach((day, i) => {
        const av = state.availability[d.id]?.[day.key] || { am: 'available', pm: 'available' };
        const cell = (b) => {
          const v = vis[d.id][day.key][b];
          const blocked = v === 'lock';
          const rawState = blocked ? 'blocked' : (av[b] || 'available');
          const reason = av[`${b}_reason`];
          const ic = ICON[v] ? `<svg class="icon ic"><use href="#${ICON[v]}"/></svg>` : '';
          const tip = blocked ? ' title="Descanso fijo (parametrización)"' : (reason ? ` title="${escapeAttr(reason)}"` : '');
          return `<button class="av-slot ${v}" data-id="${d.id}" data-day="${day.key}" data-shift="${b}" data-state="${rawState}"${blocked ? ' data-blocked="1"' : ''}${tip}>${ic}<span class="lbl">${b.toUpperCase()}</span></button>`;
        };
        html += `<td class="daycell${WKND.includes(i) ? ' wknd' : ''}"><span class="slots">${cell('am')}${cell('pm')}</span></td>`;
      });
      html += '</tr>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.av-slot').forEach(btn => btn.addEventListener('click', () => rotateAvailPill(btn)));
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
    let admins, drivers, strikeCounts, weekSusp, rulesRows, sched;
    try {
      [admins, drivers, strikeCounts, weekSusp, rulesRows, sched] = await Promise.all([
        Api.listAdmins(), Api.listAllDriversForAdmin(),
        Api.getActiveStrikeCounts().catch(() => new Map()),
        Api.getWeekSuspensions(state.currentWeek).catch(() => new Map()),
        Api.listDriverRules().catch(() => []),
        Api.getSchedule(state.currentWeek).catch(() => null),
      ]);
    } catch (e) {
      list.innerHTML = `<p class="text-sm text-rose-600">Error cargando personal: ${escapeHtml(e.message)}</p>`;
      return;
    }
    state._strikeCounts = strikeCounts;
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
        strikes: strikeCounts.get(d.id) || 0, suspWeek: weekSusp.has(d.id),
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
              ${p.coord ? '<span class="statechip coord">★ Coordina</span>' : ''}
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
            <div class="ruleitem"><span class="t">Puede coordinar</span><span class="v">${p.coord ? 'Sí' : 'No'}</span></div>
            <div class="ruleitem"><span class="t">Descanso fijo</span><span class="v ${p.rest ? 'lock' : ''}">${p.rest ? '🔒 ' + escapeHtml(p.rest) : '—'}</span></div>
            ${p.suspWeek ? '<div class="ruleitem"><span class="t">Esta semana</span><span class="v">Suspendido</span></div>' : ''}
          </div>
          <div class="dblock full">
            <h3>Confiabilidad — strikes (${p.strikes}/3)</h3>
            ${adm ? '<p style="font-size:13px;color:var(--pc-ink2)">No aplica a administradores.</p>'
              : (p.strikes === 0 ? '<p style="font-size:13px;color:var(--pc-ink2)">Sin strikes registrados. Historial limpio.</p>'
                 : `<div style="display:flex;align-items:center;gap:12px">${strikesEl(p)}<span style="font-size:13px;color:var(--pc-ink2)">${p.strikes}/3 activos. Abre el historial para el detalle.</span></div>`)}
          </div>
        </div>
        <div class="dactions">
          <button class="pc-btn ${p.coord ? 'on' : ''}" data-act="${adm ? (p.coord ? 'coord-off' : 'coord-on') : (p.coord ? 'dcoord-off' : 'dcoord-on')}" data-id="${p.id}" data-name="${nm}">${p.coord ? '✓ Coordina' : '✕ No coordina'}</button>
          ${adm ? '' : `<button class="pc-btn" data-act="strike" data-id="${p.id}" data-name="${nm}">⚠ Strike</button>
          <button class="pc-btn" data-act="strikes-history" data-id="${p.id}" data-name="${nm}">Historial</button>
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

  // Prioridad por antigüedad (1=nuevo, 2=con tiempo, 3=antiguo). Influye SUAVE
  // en la generación: ver scheduler.js (desempate por prioridad).
  const SR_LABELS = { 1: 'Nuevo', 2: 'Con tiempo', 3: 'Antiguo' };
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
      const segs = [1, 2, 3].map(n =>
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
        const morning = new Set(day.morning || []);
        const afternoon = new Set(day.afternoon || []);
        const coord = new Set([...(day.coord_am || []), ...(day.coord_pm || [])]);
        new Set([...morning, ...afternoon, ...coord]).forEach(id => {
          agg[id] = agg[id] || { am: 0, pm: 0, co: 0 };
          // 1 turno por día: manejar (AM/PM) tiene prioridad sobre coordinar.
          if (morning.has(id)) agg[id].am++;
          else if (afternoon.has(id)) agg[id].pm++;
          else if (coord.has(id)) agg[id].co++;
        });
      });
    });
    const adminIds = new Set((state.admins || []).map(a => a.id));
    const driverIds = new Set((state.drivers || []).map(d => d.id));
    const liveName = {}, liveMail = {};
    (state.drivers || []).forEach(d => { liveName[d.id] = d.name; liveMail[d.id] = d.email || ''; });
    (state.admins || []).forEach(a => { liveName[a.id] = liveName[a.id] || a.name; liveMail[a.id] = liveMail[a.id] || a.email || ''; });
    const list = Object.keys(agg).map(id => {
      const { am, pm, co } = agg[id];
      const total = am + pm + co;
      const name = liveName[id] || merged[id] || '(eliminado)';
      const role = adminIds.has(id) ? 'Admin' : (driverIds.has(id) ? 'Conductor' : '—');
      return { id, name, email: liveMail[id] || '', role, am, pm, co, total, horas: total * 12 };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { weeks: rows.length, list };
  }

  async function onGenerateBalance() {
    const fromV = $('#balance-from').value, toV = $('#balance-to').value;
    const box = $('#balance-table'), sum = $('#balance-summary');
    if (!fromV || !toV) { sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><h3>Elige el rango</h3><p>Selecciona Desde y Hasta para generar el informe.</p></div>'; return; }
    const fromWk = Scheduler.startOfWeekISO(fromV), toWk = Scheduler.startOfWeekISO(toV);
    sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><p>Calculando…</p></div>';
    let rows;
    try { rows = await Api.listPublishedSchedules(fromWk, toWk); }
    catch (e) { box.innerHTML = `<div class="bal-empty"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`; return; }
    const agg = aggregateBalance(rows);
    state.balanceData = { ...agg, fromV, toV };
    if (!agg.list.length) {
      box.innerHTML = '<div class="bal-empty"><h3>Sin datos</h3><p>No hay horarios publicados en ese rango.</p></div>';
      return;
    }
    const r = agg.list;
    const totAm = r.reduce((a, x) => a + x.am, 0);
    const totPm = r.reduce((a, x) => a + x.pm, 0);
    const totCo = r.reduce((a, x) => a + x.co, 0);
    const totTurnos = totAm + totPm + totCo;
    const totHoras = totTurnos * 12;
    const maxH = Math.max(...r.map(x => x.horas), 1);
    const avg = Math.round(totHoras / r.length);
    sum.innerHTML = `
      <div class="bal-scard accent"><div class="n">${totTurnos}</div><div class="l">Turnos publicados</div></div>
      <div class="bal-scard"><div class="n">${totHoras}<s> h</s></div><div class="l">Horas totales</div></div>
      <div class="bal-scard"><div class="n">${r.length}</div><div class="l">Personas con turno</div></div>
      <div class="bal-scard"><div class="n">${avg}<s> h</s></div><div class="l">Promedio por persona</div></div>`;
    const pill = (v, cls) => `<span class="bal-pill ${v ? cls : 'z'}">${v}</span>`;
    box.innerHTML = `
      <div class="bal-report">
        <div class="bal-rhead"><svg class="icon"><use href="#i-doc"/></svg><h2>Detalle por persona</h2><span class="period">${escapeHtml(fromV)} → ${escapeHtml(toV)} · ${agg.weeks} sem · turno = 12 h</span></div>
        <table class="bal-bt">
          <thead><tr><th>Persona</th><th class="num">AM</th><th class="num">PM</th><th class="num">Coord</th><th class="num">Turnos</th><th class="num" style="width:210px">Horas</th></tr></thead>
          <tbody>${r.map(p => `<tr>
            <td><div class="person"><span class="bal-avt" style="background:${colorOfId(p.id)}">${escapeHtml(initialsOf(p.name))}</span><div><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.email || p.role)}</span></div></div></td>
            <td class="num">${pill(p.am, 'am')}</td>
            <td class="num">${pill(p.pm, 'pm')}</td>
            <td class="num">${pill(p.co, 'co')}</td>
            <td class="num"><b>${p.total}</b></td>
            <td class="num"><div class="bal-hrs"><span class="bar"><i style="width:${Math.round(p.horas / maxH * 100)}%"></i></span><b>${p.horas} h</b></div></td>
          </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td>Total · ${r.length} personas</td>
            <td class="num">${totAm}</td><td class="num">${totPm}</td><td class="num">${totCo}</td>
            <td class="num">${totTurnos}</td><td class="num">${totHoras} h</td>
          </tr></tfoot>
        </table>
      </div>`;
  }

  function onDownloadBalanceCsv() {
    const bd = state.balanceData;
    if (!bd || !bd.list.length) { toast('Genera primero un informe con datos.'); return; }
    const esc = v => { v = String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const tot = k => bd.list.reduce((a, x) => a + x[k], 0);
    const lines = [
      `Balance de turnos;${bd.fromV} a ${bd.toV};${bd.weeks} semanas publicadas`,
      ['Nombre', 'Email', 'Rol', 'AM', 'PM', 'Coordinacion', 'Total turnos', 'Horas (x12)'].join(';'),
      ...bd.list.map(r => [r.name, r.email, r.role, r.am, r.pm, r.co, r.total, r.horas].map(esc).join(';')),
      ['Total', '', '', tot('am'), tot('pm'), tot('co'), tot('total'), tot('total') * 12].map(esc).join(';'),
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
    updateDriverHome(); // mantiene fresco el sub de la tarjeta de disponibilidad en la home
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

  // ---- Navegación del conductor: home (2 tarjetas) ↔ disponibilidad ----

  function showDriverHome() {
    $('#screen-driver-home')?.classList.remove('hidden');
    $('#screen-driver').classList.add('hidden');
    $('#driver-save-bar').classList.add('hidden'); // la barra de Guardar solo aplica en disponibilidad
    updateDriverHome();
    window.scrollTo(0, 0);
  }

  function showDriverAvailability() {
    $('#screen-driver-home')?.classList.add('hidden');
    $('#screen-driver').classList.remove('hidden');
    $('#driver-save-bar').classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // Saludo de la home ("Carlos · Martes 10 de junio") + estado de la tarjeta de disponibilidad.
  function updateDriverHome() {
    const sub = $('#driver-home-sub');
    if (sub && state.profile) {
      const name = firstNameOf(state.profile);
      const today = new Date().toLocaleDateString('es-CO',
        { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
      sub.textContent = `${name} · ${today.charAt(0).toUpperCase()}${today.slice(1)}`;
    }
    const cardSub = $('#driver-availability-card-sub');
    if (cardSub) cardSub.textContent = availabilitySummaryText();
  }

  function availabilitySummaryText() {
    const own = state.ownAvail || {};
    const week = Scheduler.weekDates(state.currentWeek);
    const marked = week.filter(d => !!own[d.key]).length;
    const total = week.length;
    const range = weekLabelES(state.currentWeek);
    if (marked === 0) return `Marca tus turnos para la semana del ${range}. El admin asigna y confirma.`;
    if (marked < total) {
      const missing = total - marked;
      return `Te falta${missing === 1 ? '' : 'n'} ${missing} día${missing === 1 ? '' : 's'} por marcar para la semana del ${range}.`;
    }
    return `Disponibilidad lista para la semana del ${range}. Puedes ajustarla.`;
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
      : document.getElementById('screen-driver-home');
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
