// core.js — Boot, sesión/login, estado global, tabs y helpers base.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
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
    driverTab: 'home',
    driverNavRevealed: false, // la barra inferior aparece al entrar a un módulo
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
    $('#balance-xlsx')?.addEventListener('click', onDownloadBalanceXlsx);
    $('#download-schedule-btn')?.addEventListener('click', onDownloadScheduleXlsx);
    $('#save-btn').addEventListener('click', () => onSaveSchedule(false));
    $('#publish-btn').addEventListener('click', () => onSaveSchedule(true));
    $('#clear-schedule-btn').addEventListener('click', onClearSchedule);

    $('#save-settings-btn').addEventListener('click', onSaveSettings);

    $('#new-driver-gen-pw')?.addEventListener('click', onGenerateDriverPassword);
    $('#new-driver-create-btn')?.addEventListener('click', onCreateDriver);

    $('#new-veh-create-btn')?.addEventListener('click', onCreateVehicle);
    $('#vehicles-list')?.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-veh-edit]'); if (ed) { onEditVehicle(ed.dataset.vehEdit); return; }
      const oc = e.target.closest('[data-veh-oilchange]'); if (oc) { onRegisterOilChange(oc.dataset.vehOilchange); return; }
      const r = e.target.closest('[data-veh-restore]'); if (r) { onRestoreVehicle(r.dataset.vehRestore); return; }
      const d = e.target.closest('[data-veh-del]'); if (d) { onDeleteVehicle(d.dataset.vehDel); return; }
    });

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

    // Solicitudes (paleta limpia): filtro Todas / Conflictos / Singletons.
    $('#solic-filter')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]'); if (!b) return;
      state._solicFilter = b.dataset.f;
      $('#solic-filter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      refreshApprovals();
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
    $('#driver-availability-card')?.addEventListener('click', showDriverAvailability);
    $('#driver-back-home')?.addEventListener('click', showDriverHome);
    $('#driver-nav')?.addEventListener('click', (e) => { const b = e.target.closest('[data-dtab]'); if (b) setDriverTab(b.dataset.dtab); });
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
      refreshInspectionsBadge();
      refreshShiftsBadge();
      refreshOilBadge();
    } else {
      $('#admin-nav').classList.add('hidden');
      $('#admin-greeting-block').classList.add('hidden');
      $('#driver-tabs-root')?.classList.remove('hidden');
      // La barra inferior NO se muestra al inicio: aparece al entrar a un módulo.
      state.driverNavRevealed = false;
      $('#driver-nav')?.classList.remove('show');
      $('#driver-tabs-root')?.classList.remove('nav-on');
      await refreshDriverView();
      setDriverTab('home'); // arranca en las 2 tarjetas
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
    $('#driver-tabs-root')?.classList.add('hidden');
    $('#driver-nav')?.classList.remove('show');
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
    if (name === 'inspections') renderInspections();
    if (name === 'shifts') renderShifts();
    if (name === 'rewards') renderRewardsAdmin();
  }

