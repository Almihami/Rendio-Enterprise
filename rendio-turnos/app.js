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
    $('#balance-csv')?.addEventListener('click', onDownloadBalanceCsv);
    $('#download-schedule-btn')?.addEventListener('click', onDownloadScheduleXlsx);
    $('#save-btn').addEventListener('click', () => onSaveSchedule(false));
    $('#publish-btn').addEventListener('click', () => onSaveSchedule(true));
    $('#clear-schedule-btn').addEventListener('click', onClearSchedule);

    $('#save-settings-btn').addEventListener('click', onSaveSettings);

    $('#new-driver-gen-pw')?.addEventListener('click', onGenerateDriverPassword);
    $('#new-driver-create-btn')?.addEventListener('click', onCreateDriver);

    $('#new-veh-create-btn')?.addEventListener('click', onCreateVehicle);
    $('#vehicles-list')?.addEventListener('click', (e) => {
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

  // ====================================================================
  // Inspecciones (admin) — revisión/aprobación + checklist configurable
  // ====================================================================
  const inspState = { items: [], filter: 'pending', current: null, checklist: [], vehicles: [], autoVehicleId: null, autoItems: [], adminPhoto: null };
  const INSP_SEV = {
    leve:  { cls: 'leve',  label: 'Leve',  text: 'Leve · informativo',       color: 'var(--green)' },
    media: { cls: 'media', label: 'Media', text: 'Media · con cuidado',       color: 'var(--amber)' },
    grave: { cls: 'grave', label: 'Grave', text: 'Grave · requiere atención', color: 'var(--red)' },
  };
  const INSP_ST = { pending: ['pend', 'Pendiente', 'i-warn'], approved: ['appr', 'Aprobada', 'i-check'], rejected: ['rej', 'Rechazada', 'i-x'] };
  const PHOTO_LABELS = { front: 'Frontal', rear: 'Trasera', left: 'Lat. izq.', right: 'Lat. der.', dashboard: 'Tablero', damage: 'Golpe/daño', extra: 'Adicional' };
  const PHOTO_ORDER = ['front', 'rear', 'left', 'right', 'dashboard'];

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

  function refreshInspectionsBadge() {
    const setBadge = (n) => { const b = $('#inspections-badge'); if (!b) return; b.textContent = n; b.classList.toggle('hidden', !n); };
    if (inspState.items.length) { setBadge(inspCounts().pending); return; }
    Api.listInspectionsForReview('pending').then(rows => setBadge(rows.length)).catch(() => {});
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
    renderInspList();
  }

  function renderInspList() {
    const counts = inspCounts();
    if ($('#insp-count')) $('#insp-count').textContent = counts.pending;
    $$('#insp-filter .n').forEach(n => { n.textContent = counts[n.dataset.c] != null ? counts[n.dataset.c] : 0; });
    const b = $('#inspections-badge'); if (b) { b.textContent = counts.pending; b.classList.toggle('hidden', !counts.pending); }
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
        const [byShift, receipts] = await Promise.all([
          Api.listInspectionsByShift(insp.shift_id).catch(() => []),
          Api.listFuelReceiptsForShift(insp.shift_id).catch(() => []),
        ]);
        const final = (byShift || []).find(i => i.kind === 'final') || null;
        if (final || (receipts && receipts.length)) closeData = { final, receipts: receipts || [] };
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
    const vehLine = `${v.status === 'available' ? 'Disponible' : (v.status || '—')}${nextMaint != null ? ` · mtto en ${nextMaint.toLocaleString('es-CO')} km` : ''}`;
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
      </div>` : '<p class="csub" style="margin-top:10px">Sin comprobantes de tanqueo.</p>';
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
    try { inspState.checklist = await Api.listChecklistItems(false); }
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
      if (e.target.closest('[data-insp-back]')) { renderInspections(); return; }
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
  const BOARD_GROUP_LABEL = { am: 'Mañana', pm: 'Tarde', co: 'Líder' };
  const laneShift = (kind) => (kind === 'morning' || kind === 'coord_am') ? 'am' : 'pm';
  const laneLabel = (lane) => ({ morning: 'Mañana', afternoon: 'Tarde', coord_am: 'Líder AM', coord_pm: 'Líder PM' }[lane.kind] || lane.kind);
  const laneShortLabel = (lane) => lane.group === 'am' ? 'AM' : lane.group === 'pm' ? 'PM' : (lane.kind === 'coord_am' ? 'Líder AM' : 'Líder PM');
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
      <div class="k ${coordDays < 7 ? 'warn' : 'ok'}"><div class="tx"><em>Liderazgo</em><b>${coordDays}/7</b><span>días con líder</span></div></div>
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
        : (isFlex ? 'Lidera (flex)' : d.can_coordinate ? 'Lidera' : 'Disponible');
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
          const subtxt = hard ? '⚠ ' + hardLabel(hard) : (isCoordKind(lane.kind) ? 'Lidera' : BOARD_GROUP_LABEL[lane.group]);
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
      flashBoard('Solo líderes de turno (admin o Daniel) pueden ir en Líder de turno.');
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
      settings: { morningSlots: state.settings.morning_slots, afternoonSlots: state.settings.afternoon_slots, coordSlots: state.settings.coord_slots || 1 },
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
    return { morning: 'Mañana', afternoon: 'Tarde', rest: 'Descanso', coord_am: 'Líder de turno AM', coord_pm: 'Líder de turno PM' }[k] || k;
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
    const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    container.innerHTML = '<div class="sol-empty"><p>Cargando…</p></div>';
    try {
      const driversById = {};
      state.drivers.forEach(d => { driversById[d.id] = d; });
      // Ignora solicitudes huérfanas (conductor borrado/suspendido o no vigente).
      const items = (await Api.listPendingApprovals(state.currentWeek))
        .filter(r => driversById[r.profile_id]);

      const TOTAL = state.drivers.length;
      const cupoOf = (shift) => ((shift === 'am' ? (state.settings && state.settings.morning_slots) : (state.settings && state.settings.afternoon_slots)) || 2);

      // Agrupa por slot (día-jornada) y deriva el tipo según el cupo real:
      // puedes liberar = (total - descansos fijos) - cupo. Si piden más → conflicto.
      const map = {};
      items.forEach(r => {
        const key = `${r.day_of_week}-${r.shift}`;
        (map[key] = map[key] || { key, day_of_week: r.day_of_week, shift: r.shift, items: [] }).items.push(r);
      });
      const groups = Object.values(map).map(g => {
        const dayKey = Scheduler.DAYS[g.day_of_week];
        const pend = g.items.filter(i => i.state === 'pending');
        let fixed = 0;
        state.drivers.forEach(d => { try { if (Scheduler.ruleBlocked(d, dayKey, g.shift)) fixed++; } catch (e) { /* */ } });
        const cupo = cupoOf(g.shift);
        const maxGrant = Math.max(0, (TOTAL - fixed) - cupo);
        const atWheel = Math.max(cupo, TOTAL - fixed - pend.length);
        let kind = 'single';
        if (pend.length > maxGrant) kind = 'conflict';
        else if (pend.length > 1) kind = 'review';
        return { ...g, dayKey, pend, maxGrant, atWheel, kind };
      }).filter(g => g.pend.length > 0)
        .sort((a, b) => a.day_of_week - b.day_of_week || a.shift.localeCompare(b.shift));

      const allPend = groups.reduce((a, g) => a + g.pend.length, 0);
      const nConf = groups.filter(g => g.kind === 'conflict').reduce((a, g) => a + g.pend.length, 0);
      const nSingle = groups.filter(g => g.kind === 'single').reduce((a, g) => a + g.pend.length, 0);
      setT('#solic-count', allPend); setT('#solic-n-all', allPend); setT('#solic-n-conf', nConf); setT('#solic-n-single', nSingle);

      if (allPend === 0) {
        container.innerHTML = `<div class="sol-empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Todo al día</h3><p>No hay solicitudes pendientes esta semana.</p></div>`;
        refreshPendingBadge();
        return;
      }

      const filter = state._solicFilter || 'all';
      const shown = groups.filter(g => filter === 'all' ? true : g.kind === filter);
      container.innerHTML = shown.length
        ? shown.map(g => approvalGroupHtml(g, driversById)).join('')
        : `<div class="sol-empty"><h3>Sin solicitudes en este filtro</h3><p>Cambia de pestaña para ver el resto.</p></div>`;

      container.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => onApprovalAction(btn)));
      container.querySelectorAll('button[data-gok]').forEach(btn => btn.addEventListener('click', () => onApproveSlot(btn)));
    } catch (e) {
      container.innerHTML = `<div class="sol-empty"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
    refreshPendingBadge();
  }

  function approvalGroupHtml(g, driversById) {
    const dayLabel = Scheduler.DAY_LABELS_ES[g.dayKey] || '';
    const tag = g.kind === 'conflict'
      ? `<span class="sol-gtag conflict"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Conflicto · sobran ${g.pend.length - g.maxGrant}</span>`
      : g.kind === 'single'
        ? `<span class="sol-gtag single"><svg class="icon" style="width:13px;height:13px"><use href="#i-check"/></svg>Singleton</span>`
        : `<span class="sol-gtag review">${g.pend.length} pendientes</span>`;
    const ga = g.kind === 'conflict' ? ''
      : `<div class="sol-gactions"><button class="sol-minibtn green" data-gok="${g.key}" data-ids="${g.pend.map(r => r.id).join(',')}"><svg class="icon"><use href="#i-check"/></svg>Aprobar slot</button></div>`;
    return `<div class="sol-group ${g.kind === 'conflict' ? 'conflict' : ''}">
      <div class="sol-ghead">
        <span class="sol-slot"><b>${dayLabel}</b><span class="band ${g.shift}">${g.shift.toUpperCase()}</span></span>
        <span class="sol-cupoinfo">Piden <b>${g.pend.length}</b> · puedes liberar <b>${g.maxGrant}</b> · quedan <b>${g.atWheel}</b> al volante</span>
        ${tag}${ga}
      </div>
      ${g.items.map(r => approvalRowHtml(r, driversById)).join('')}
    </div>`;
  }

  function approvalRowHtml(r, driversById) {
    const d = driversById[r.profile_id];
    const name = (d && d.name) || 'Conductor eliminado';
    const reasonTxt = r.kind === 'unavailable' ? (r.reason || '(sin texto)') : 'Descanso';
    const avt = `<span class="sol-avt" style="background:${colorOfId(r.profile_id)}">${escapeHtml(initialsOf(name))}</span>`;
    if (r.state !== 'pending') {
      const ok = r.state === 'approved';
      return `<div class="sol-req done">${avt}
        <div class="sol-who"><b>${escapeHtml(name)}</b><div class="meta"><span class="rsn">${escapeHtml(reasonTxt)}</span></div></div>
        <span class="sol-resolved ${ok ? 'ok' : 'no'}"><svg class="icon"><use href="#${ok ? 'i-check' : 'i-x'}"/></svg>${ok ? 'Aprobado' : 'Rechazado'}</span>
      </div>`;
    }
    const prio = (d && d.priority) || 1;
    const senior = `<span class="sol-senior s${prio}"><span class="dot"></span>${prio} · ${SR_LABELS[prio] || ''}</span>`;
    const note = r.admin_note ? `<span class="rsn" style="color:var(--ink2);font-weight:400">· ${escapeHtml(r.admin_note)}</span>` : '';
    return `<div class="sol-req">${avt}
      <div class="sol-who"><b>${escapeHtml(name)}</b><div class="meta"><span class="rsn">${escapeHtml(reasonTxt)}</span>${note}</div></div>
      ${senior}
      <div class="sol-ractions">
        <button class="sol-rbtn ok" data-action="approve" data-id="${r.id}"><svg class="icon"><use href="#i-check"/></svg>Aprobar</button>
        <button class="sol-rbtn no" data-action="reject" data-id="${r.id}"><svg class="icon"><use href="#i-x"/></svg>Rechazar</button>
      </div>
    </div>`;
  }

  async function onApproveSlot(btn) {
    const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
    if (!ids.length) return;
    btn.disabled = true;
    try {
      for (const id of ids) await Api.resolveApproval(id, 'approved', null);
      await refreshApprovals();
      toast(`${ids.length} descanso(s) aprobado(s).`);
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
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
      const role = d.can_coordinate ? 'Líder de turno' : 'Conductor';
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
        strikes: strikeCounts.get(d.id) || 0, suspWeek: weekSusp.has(d.id),
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
    if ($('#setting-coord-slots')) $('#setting-coord-slots').value = state.settings.coord_slots != null ? state.settings.coord_slots : 1;
    if ($('#setting-shift-hours')) $('#setting-shift-hours').value = state.settings.shift_hours != null ? state.settings.shift_hours : 12;
    if ($('#setting-auto-close-hours')) $('#setting-auto-close-hours').value = state.settings.auto_close_hours != null ? state.settings.auto_close_hours : 14;
    renderPriorityList();
    renderRulesEditor();
    renderVehiclesSettings();
  }

  // --- Vehículos (admin) — alta/baja de la flota desde Ajustes ---
  const VEH_STATUS_ES = { available: 'Disponible', in_use: 'En uso', reserved: 'Reservado', maintenance: 'Mantenimiento', blocked: 'Bloqueado' };
  async function renderVehiclesSettings() {
    const box = $('#vehicles-list');
    if (!box) return;
    box.innerHTML = '<p class="set-hint">Cargando…</p>';
    let vehs = [];
    try { vehs = await Api.listVehiclesForShift(); }
    catch (e) { console.error(e); box.innerHTML = '<p class="set-hint">No se pudieron cargar los vehículos.</p>'; return; }
    if (!vehs.length) { box.innerHTML = '<p class="set-hint">Aún no hay vehículos. Agrega el primero abajo.</p>'; return; }
    box.innerHTML = vehs.map(v => {
      const offService = v.status === 'maintenance' || v.status === 'blocked';
      const restoreBtn = offService
        ? `<button class="set-btn dark" data-veh-restore="${v.id}" title="Regresar a servicio">Regresar a servicio</button>`
        : '';
      return `<div class="veh-row" data-veh="${v.id}">
      <div class="veh-info"><b>${escapeHtml(v.internal_code || v.license_plate || 'Auto')}</b><span>${escapeHtml(v.license_plate || '')} · ${escapeHtml([v.brand, v.model].filter(Boolean).join(' ') || '—')} · ${v.capacity} pas · ${(v.current_km || 0).toLocaleString('es-CO')} km</span></div>
      <span class="veh-stat st-${v.status}">${VEH_STATUS_ES[v.status] || escapeHtml(v.status || '')}</span>
      ${restoreBtn}
      <button class="veh-del" data-veh-del="${v.id}" title="Eliminar vehículo"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    }).join('');
  }

  async function onCreateVehicle() {
    const code = ($('#new-veh-code') && $('#new-veh-code').value || '').trim();
    const plate = ($('#new-veh-plate') && $('#new-veh-plate').value || '').trim();
    if (!code || !plate) { toast('Código interno y placa son obligatorios.'); return; }
    const km = Math.max(0, parseInt($('#new-veh-km').value, 10) || 0);
    const veh = {
      organization_id: state.profile.organization_id,
      internal_code: code,
      license_plate: plate.toUpperCase(),
      brand: ($('#new-veh-brand').value || '').trim() || null,
      model: ($('#new-veh-model').value || '').trim() || null,
      capacity: Math.min(4, Math.max(1, parseInt($('#new-veh-capacity').value, 10) || 4)),
      current_km: km,
      // Baseline de mantenimiento = odómetro actual al darlo de alta. Si se deja
      // en 0 (default), el vehículo se bloquearía al primer cierre de turno con km
      // real (bug 4). start_shift también lo inicializa como red de seguridad.
      last_maintenance_km: km,
      soat_expires_at: $('#new-veh-soat').value || null,
      tecnomec_expires_at: $('#new-veh-tecno').value || null,
    };
    const btn = $('#new-veh-create-btn'); const st = $('#new-veh-state');
    btn.disabled = true; if (st) st.textContent = 'Creando…';
    try {
      await Api.createVehicle(veh);
      ['code', 'plate', 'brand', 'model'].forEach(f => { const el = $('#new-veh-' + f); if (el) el.value = ''; });
      $('#new-veh-capacity').value = '4'; $('#new-veh-km').value = '0';
      $('#new-veh-soat').value = ''; $('#new-veh-tecno').value = '';
      if (st) st.textContent = '';
      toast('Vehículo agregado.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      if (st) st.textContent = '';
      const msg = /unique|duplicate/i.test(e.message || '') ? 'Ya existe un vehículo con ese código o placa.' : (e.message || 'error');
      alert('No se pudo agregar: ' + msg);
    } finally { btn.disabled = false; }
  }

  async function onDeleteVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    if (v && v.status === 'in_use' && !confirm('Este vehículo está EN USO en un turno activo. ¿Eliminarlo igual? Mejor espera a que el turno cierre.')) return;
    if (!confirm('¿Eliminar este vehículo? Dejará de aparecer para los conductores. El historial de turnos e inspecciones se conserva.')) return;
    try { await Api.softDeleteVehicle(id); toast('Vehículo eliminado.'); renderVehiclesSettings(); }
    catch (e) { console.error(e); alert('No se pudo eliminar: ' + (e.message || 'error')); }
  }

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
      return { id, name, email: liveMail[id] || '', role, am, pm, co, total, horas: total * ((state.settings && state.settings.shift_hours) || 12) };
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
    const TH = (state.settings && state.settings.shift_hours) || 12;
    const totHoras = totTurnos * TH;
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
        <div class="bal-rhead"><svg class="icon"><use href="#i-doc"/></svg><h2>Detalle por persona</h2><span class="period">${escapeHtml(fromV)} → ${escapeHtml(toV)} · ${agg.weeks} sem · turno = ${TH} h</span></div>
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
    const TH = (state.settings && state.settings.shift_hours) || 12;
    const lines = [
      `Balance de turnos;${bd.fromV} a ${bd.toV};${bd.weeks} semanas publicadas`,
      ['Nombre', 'Email', 'Rol', 'AM', 'PM', 'Liderazgo', 'Total turnos', `Horas (x${TH})`].join(';'),
      ...bd.list.map(r => [r.name, r.email, r.role, r.am, r.pm, r.co, r.total, r.horas].map(esc).join(';')),
      ['Total', '', '', tot('am'), tot('pm'), tot('co'), tot('total'), tot('total') * TH].map(esc).join(';'),
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

  // ---- Navegación del conductor: pestañas inferiores (home/avail/schedule/requests) ----

  // Muestra la barra inferior (la primera vez que el conductor entra a un módulo).
  function revealDriverNav() {
    if (state.driverNavRevealed) return;
    state.driverNavRevealed = true;
    $('#driver-nav')?.classList.add('show');
    $('#driver-tabs-root')?.classList.add('nav-on');
  }

  function setDriverTab(name) {
    state.driverTab = name;
    if (name !== 'home') revealDriverNav(); // entrar a un módulo revela la barra
    $$('#driver-tabs-root .driver-panel').forEach(p => p.classList.toggle('hidden', p.dataset.dtab !== name));
    $$('#driver-nav .dnav-btn').forEach(b => b.classList.toggle('active', b.dataset.dtab === name));
    // Barra de semana: solo en Disponibilidad y Mi horario.
    $('#driver-week-bar')?.classList.toggle('hidden', !(name === 'avail' || name === 'schedule'));
    // Barra de Guardar: solo en Disponibilidad.
    $('#driver-save-bar')?.classList.toggle('hidden', name !== 'avail');
    if (name === 'home') updateDriverHome();
    if (name === 'perfil') renderDriverProfile();
    window.scrollTo(0, 0);
  }

  // Aliases para llamadas existentes.
  function showDriverHome() { setDriverTab('home'); }
  function showDriverAvailability() { setDriverTab('avail'); }

  // ====================================================================
  // Admin: Recompensas (diseño UX/UI) — solicitudes + catálogo + agregar/editar
  // (km por conductor vive ahora en Personal)
  // ====================================================================
  const rewardsAdminState = { editId: null, data: { rewards: [], redemptions: [] } };
  const RW_LEVELS = { plata: { label: 'Plata', icon: 'i-medal' }, oro: { label: 'Oro', icon: 'i-medal' }, diamante: { label: 'Diamante', icon: 'i-gem' } };
  function rwTierEmblem(level, sm) { const L = RW_LEVELS[level] || RW_LEVELS.plata; return `<span class="tier ${level}${sm ? ' sm' : ''}"><svg class="icon"><use href="#${L.icon}"/></svg></span>`; }
  function rwInitials(n) { const p = (n || '').trim().split(/\s+/); return (((p[0] || '')[0] || '') + ((p[1] || p[0] || '')[0] || '')).toUpperCase() || '·'; }

  async function renderRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    box.innerHTML = '<p style="padding:24px;color:var(--ink2)">Cargando…</p>';
    let rewards = [], redemptions = [];
    try {
      [rewards, redemptions] = await Promise.all([
        Api.listAllRewards().catch(() => []),
        Api.listRedemptionsAdmin().catch(() => []),
      ]);
    } catch (e) { console.error(e); }
    rewardsAdminState.data = { rewards, redemptions };
    drawRewardsAdmin();
  }

  function drawRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    const { rewards, redemptions } = rewardsAdminState.data;
    const esc = escapeHtml;
    const fmtWhen = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };

    // --- Solicitudes de redención ---
    const pend = (redemptions || []).filter(r => r.status === 'pending').length;
    const redListHtml = (redemptions || []).length ? (redemptions || []).map(r => {
      const prof = r.driver_profiles && r.driver_profiles.profiles;
      const who = (prof && prof.full_name) || '—';
      const rw = r.rewards || { title: '—', tier: 'plata', km_threshold: 0 };
      const color = colorOfId((prof && prof.id) || r.id);
      if (r.status !== 'pending') {
        const isOk = r.status === 'delivered' || r.status === 'approved';
        return `<div class="redrow done">
          <span class="avt" style="background:${color}">${esc(rwInitials(who))}</span>
          <div class="rwho"><b>${esc(who)}</b><div class="meta"><span class="rw">${rwTierEmblem(rw.tier, true)}${esc(rw.title)}</span></div></div>
          <span class="kmtag">${(rw.km_threshold || 0).toLocaleString('es-CO')} km</span>
          <span class="resolved ${isOk ? 'ok' : 'no'}"><svg class="icon"><use href="#${isOk ? 'i-check' : 'i-x'}"/></svg>${isOk ? 'Entregado' : 'Rechazado'} <button class="undo" data-undo="${r.id}">Deshacer</button></span>
        </div>`;
      }
      return `<div class="redrow">
        <span class="avt" style="background:${color}">${esc(rwInitials(who))}</span>
        <div class="rwho"><b>${esc(who)}</b><div class="meta"><span class="rw">${rwTierEmblem(rw.tier, true)}${esc(rw.title)}</span><span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${esc(fmtWhen(r.requested_at))}</span></div></div>
        <span class="kmtag">${(rw.km_threshold || 0).toLocaleString('es-CO')} km</span>
        <div class="ractions">
          <button class="rbtn no" data-red="rejected" data-id="${r.id}"><svg><use href="#i-x"/></svg>Rechazar</button>
          <button class="rbtn ok" data-red="delivered" data-id="${r.id}"><svg><use href="#i-check"/></svg>Entregar</button>
        </div>
      </div>`;
    }).join('') : `<div class="emptyrow"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><b>No hay solicitudes de redención</b><span>Cuando un conductor pida canjear un premio, aparecerá aquí.</span></div>`;

    // --- Catálogo ---
    const sorted = [...(rewards || [])].sort((a, b) => a.km_threshold - b.km_threshold);
    const ed = rewardsAdminState.editId ? (rewards || []).find(r => r.id === rewardsAdminState.editId) : null;
    const catHtml = sorted.length ? sorted.map(c => `<div class="rwd ${c.active ? '' : 'off'}">
        ${rwTierEmblem(c.tier)}
        <div class="rinfo"><div class="rtop"><b>${esc(c.title)}</b><span class="levelchip ${c.tier}">${(RW_LEVELS[c.tier] || {}).label || c.tier}</span><span class="km">${(c.km_threshold || 0).toLocaleString('es-CO')} km</span></div><div class="desc">${esc(c.description || '')}</div></div>
        <div class="rctl">
          <span class="tglabel ${c.active ? 'on' : ''}">${c.active ? 'Activa' : 'Off'}</span>
          <button class="tg ${c.active ? 'on' : ''}" data-tg="${c.id}" title="Activar / desactivar"></button>
          <button class="cfgbtn" data-edit="${c.id}" title="Editar"><svg class="icon" style="width:15px;height:15px"><use href="#i-edit"/></svg></button>
          <button class="cfgbtn danger" data-del="${c.id}" title="Eliminar"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
        </div>
      </div>`).join('') : `<div class="emptyrow"><div class="circle" style="background:var(--orange-soft);color:var(--orange)"><svg class="icon"><use href="#i-gift"/></svg></div><b>Aún no hay recompensas</b><span>Crea la primera abajo.</span></div>`;

    box.innerHTML = `
      <div class="phead"><h1>Recompensas</h1><p>Define los premios por kilometraje y atiende las solicitudes de redención de los conductores.</p></div>

      <div class="card">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-inbox"/></svg></div><div><h2>Solicitudes de redención</h2><p>Premios que un conductor pidió canjear. Entrégalos o recházalos.</p></div><span class="count${pend ? ' alert' : ''}">${pend}</span></div>
        <div class="cbody flush">${redListHtml}</div>
      </div>

      <div class="card">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-gift"/></svg></div><div><h2>Catálogo de recompensas</h2><p>Premios disponibles, ordenados por kilometraje. Desactiva sin perder el historial.</p></div><span class="count">${(rewards || []).filter(c => c.active).length} activas</span></div>
        <div class="cbody flush">${catHtml}</div>
      </div>

      <div class="card" style="margin-bottom:0">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-plus"/></svg></div><div><h2>${ed ? 'Editar recompensa' : 'Agregar recompensa'}</h2><p>${ed ? 'Modifica el premio y guarda los cambios.' : 'Crea un nuevo premio. Aparece de inmediato en la app del conductor.'}</p></div></div>
        <div class="cbody">
          <div class="grid2">
            <div class="field"><label>Título</label><input class="input" id="rw-title" placeholder="Ej: Bono de gasolina" value="${ed ? esc(ed.title) : ''}"></div>
            <div class="field"><label>Km para desbloquear</label><input class="input mono" id="rw-km" type="number" min="0" step="500" placeholder="5000" value="${ed ? ed.km_threshold : ''}"></div>
          </div>
          <div class="grid2" style="margin-top:14px">
            <div class="field"><label>Nivel</label><div class="selwrap"><select class="sel" id="rw-tier">
              <option value="plata"${ed && ed.tier === 'plata' ? ' selected' : ''}>Plata</option>
              <option value="oro"${ed && ed.tier === 'oro' ? ' selected' : ''}>Oro</option>
              <option value="diamante"${ed && ed.tier === 'diamante' ? ' selected' : ''}>Diamante</option>
            </select><span class="chev"><svg class="icon"><use href="#i-chev"/></svg></span></div></div>
            <div class="field"><label>Descripción</label><input class="input" id="rw-desc" placeholder="Ej: $50.000 en combustible" value="${ed ? esc(ed.description || '') : ''}"></div>
          </div>
          <div class="formfoot"><button class="btn" id="rw-save"><svg class="icon"><use href="#i-plus"/></svg>${ed ? 'Guardar cambios' : 'Agregar recompensa'}</button>${ed ? '<button class="btn ghost" id="rw-cancel">Cancelar</button>' : ''}<span id="rw-state" style="font-size:12px;color:var(--ink2)"></span></div>
        </div>
      </div>`;
    bindRewardsAdmin();
  }

  function bindRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    box.querySelectorAll('[data-red]').forEach(b => b.addEventListener('click', () => resolveRedeem(b.dataset.id, b.dataset.red)));
    box.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', () => resolveRedeem(b.dataset.undo, 'pending')));
    box.querySelectorAll('[data-tg]').forEach(b => b.addEventListener('click', () => onToggleReward(b.dataset.tg)));
    box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { rewardsAdminState.editId = b.dataset.edit; drawRewardsAdmin(); }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => onDeleteReward(b.dataset.del)));
    $('#rw-save')?.addEventListener('click', onSaveReward);
    $('#rw-cancel')?.addEventListener('click', () => { rewardsAdminState.editId = null; drawRewardsAdmin(); });
  }

  async function onSaveReward() {
    const title = ($('#rw-title')?.value || '').trim();
    const km = parseInt($('#rw-km')?.value, 10);
    const tier = $('#rw-tier')?.value || 'plata';
    const desc = ($('#rw-desc')?.value || '').trim() || null;
    const st = $('#rw-state');
    if (!title) { if (st) st.textContent = 'Escribe un título.'; return; }
    if (!(km >= 0)) { if (st) st.textContent = 'Indica los km para desbloquear.'; return; }
    try {
      if (rewardsAdminState.editId) {
        await Api.updateReward(rewardsAdminState.editId, { title, km_threshold: km, tier, description: desc });
        rewardsAdminState.editId = null;
        toast('Recompensa actualizada.');
      } else {
        await Api.createReward({ organization_id: state.profile.organization_id, title, km_threshold: km, tier, description: desc });
        toast('“' + title + '” agregada al catálogo.');
      }
      renderRewardsAdmin();
    } catch (e) { console.error(e); if (st) st.textContent = 'No se pudo guardar: ' + (e.message || 'error'); }
  }
  async function onDeleteReward(id) {
    if (!confirm('¿Eliminar esta recompensa? Las solicitudes ya hechas se conservan.')) return;
    try { await Api.deleteReward(id); toast('Recompensa eliminada.'); renderRewardsAdmin(); }
    catch (e) { console.error(e); toast('No se pudo eliminar: ' + (e.message || 'error')); }
  }
  async function onToggleReward(id) {
    const r = (rewardsAdminState.data.rewards || []).find(x => x.id === id); if (!r) return;
    try { await Api.updateReward(id, { active: !r.active }); toast(r.title + (r.active ? ' desactivada.' : ' activada.')); renderRewardsAdmin(); }
    catch (e) { console.error(e); toast('No se pudo cambiar el estado.'); }
  }
  async function resolveRedeem(id, status) {
    if (status !== 'pending') {
      const label = status === 'delivered' ? 'marcar como ENTREGADA' : 'RECHAZAR';
      if (!confirm(`¿${label} esta solicitud?`)) return;
    }
    try { await Api.resolveRedemption(id, status, null); renderRewardsAdmin(); }
    catch (e) { console.error(e); toast('No se pudo actualizar: ' + (e.message || 'error')); }
  }

  // ====================================================================
  // Perfil del conductor (Fase B/C/D): datos, foto, strikes, recompensas
  // ====================================================================
  const TIER_META = { plata: { label: 'Plata', emoji: '🥈' }, oro: { label: 'Oro', emoji: '🥇' }, diamante: { label: 'Diamante', emoji: '💎' } };

  function nextWeekMondayISO() {
    const d = new Date();
    const dow = (d.getDay() + 6) % 7;          // 0 = lunes
    d.setDate(d.getDate() - dow + 7);          // lunes de la próxima semana
    return d.toISOString().slice(0, 10);
  }
  function kmDrivenOf(sh) { return Math.max(0, (sh.closing_km || 0) - (sh.opening_km || 0)); }

  async function renderDriverProfile() {
    const box = $('#driver-profile-container'); if (!box) return;
    if (!state.profileView) state.profileView = 'main';
    box.innerHTML = '<p class="text-sm text-slate-500 p-4">Cargando perfil…</p>';
    try {
      if (!state.driverId) { try { state.driverId = await Api.getMyDriverProfileId(state.profile.id); } catch (e) { /* */ } }
      const did = state.driverId;
      const [prof, strikes, closed, rewards, redemptions, openShift, susp] = await Promise.all([
        Api.getMyFullProfile().catch(() => state.profile),
        Api.listDriverStrikes(state.profile.id).catch(() => []),
        did ? Api.listMyClosedShifts(did).catch(() => []) : Promise.resolve([]),
        Api.listRewards().catch(() => []),
        did ? Api.listMyRedemptions(did).catch(() => []) : Promise.resolve([]),
        did ? Api.getMyOpenShift(did).catch(() => null) : Promise.resolve(null),
        Api.getMyWeekSuspension(state.profile.id, nextWeekMondayISO()).catch(() => null),
      ]);
      const activeStrikes = (strikes || []).filter(s => !s.voided_at && !s.consumed_at);
      const kmTotal = (closed || []).reduce((s, sh) => s + kmDrivenOf(sh), 0);
      state.profileData = { prof: prof || state.profile, strikes: strikes || [], activeStrikes, closed: closed || [], rewards: rewards || [], redemptions: redemptions || [], openShift, susp, kmTotal };
      drawProfileView();
    } catch (e) {
      console.error(e);
      box.innerHTML = '<p class="text-sm text-rose-500 p-4">No se pudo cargar el perfil.</p>';
    }
  }

  function drawProfileView() {
    const box = $('#driver-profile-container'); if (!box) return;
    const v = state.profileView || 'main';
    box.innerHTML = v === 'rewards' ? rewardsViewHtml() : v === 'strikes' ? strikesViewHtml() : profileMainHtml();
    bindProfile();
    box.scrollTop = 0; window.scrollTo(0, 0);
  }

  function profileMainHtml() {
    const d = state.profileData; const p = d.prof; const dp = p.driver || {};
    const av = p.avatar_url;
    const lic = dp.license_number ? `${escapeHtml(dp.license_number)}${dp.license_expires_at ? ' · vence ' + new Date(dp.license_expires_at).getFullYear() : ''}` : '—';
    const sc = d.activeStrikes.length;
    const strikeCard = strikeCardHtml(sc, d.susp);
    const next = d.rewards.find(r => r.km_threshold > d.kmTotal);
    const faltan = next ? next.km_threshold - d.kmTotal : 0;
    const ov = d.openShift && d.openShift.vehicles ? d.openShift.vehicles : null;
    return `
      <div class="pt-1 pb-2"><h2 class="text-[22px] font-extrabold text-ink leading-tight">Perfil</h2></div>
      <div class="space-y-5 pb-6">
        <div class="flex items-center gap-4">
          <button id="pf-avatar-btn" class="relative w-20 h-20 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white text-2xl font-extrabold flex items-center justify-center shadow-brand ring-4 ring-white overflow-hidden active:scale-95">
            ${av ? `<img src="${escapeHtml(av)}" class="w-full h-full object-cover">` : escapeHtml(initialsOf(p.full_name || 'Conductor'))}
            <span class="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-white text-brand-600 border-2 border-white flex items-center justify-center text-[11px]">✎</span>
          </button>
          <input id="pf-avatar-input" type="file" accept="image/*" class="hidden">
          <div>
            <p class="text-xl font-extrabold text-ink">${escapeHtml(p.full_name || 'Conductor')}</p>
            <p class="text-sm text-slate-500">Conductor${p.home_base ? ' · ' + escapeHtml(p.home_base) : ''}</p>
            ${p.is_active === false ? '<p class="text-[11px] text-rose-600 font-bold mt-1">Cuenta suspendida</p>' : '<p class="text-[11px] text-emerald-600 font-bold mt-1 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Activo</p>'}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          ${pfField('Cédula', p.document_id || '—')}
          ${pfField('Teléfono', p.phone || '—')}
          ${pfField('Licencia', lic)}
          ${pfField('Base', p.home_base || '—')}
        </div>

        ${strikeCard}

        <button id="pf-rewards-btn" class="sheen w-full text-left rounded-2xl p-5 bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-brand active:scale-[.99] transition">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-white/85">🎁 Recompensas</span>
            ${currentTier(d.kmTotal, d.rewards) ? `<span class="text-[10px] font-bold bg-white/20 rounded-full px-2 py-0.5">Nivel ${TIER_META[currentTier(d.kmTotal, d.rewards)].label}</span>` : ''}
          </div>
          <p class="text-3xl font-extrabold mt-2 tabular-nums">${d.kmTotal.toLocaleString('es-CO')} <span class="text-base font-bold text-white/80">km</span></p>
          <p class="text-[12px] text-white/85 mt-2">${next ? `Te faltan ${faltan.toLocaleString('es-CO')} km para ${escapeHtml(next.title)}` : (d.rewards.length ? '¡Todo desbloqueado!' : 'Aún no hay recompensas configuradas')}</p>
          <span class="inline-flex items-center gap-1 mt-3 text-sm font-bold">Ver recompensas →</span>
        </button>

        <div class="rounded-2xl bg-white border border-slate-200 shadow-card flex items-center gap-3 px-4 py-3.5">
          <span class="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-lg shrink-0">🚐</span>
          <div class="flex-1"><p class="text-sm font-semibold text-ink">Vehículo actual</p><p class="text-[11px] text-slate-400">${ov ? escapeHtml((ov.internal_code || ov.license_plate || '') + ' · ' + [ov.brand, ov.model].filter(Boolean).join(' ')) : 'Sin turno activo'}</p></div>
        </div>

        <button id="pf-logout" class="w-full text-center text-sm font-bold text-rose-500 py-2">Cerrar sesión</button>
      </div>`;
  }
  function pfField(label, val) {
    return `<div class="rounded-2xl bg-white border border-slate-200 p-3.5"><p class="text-[10px] text-slate-400 font-bold uppercase tracking-wide">${escapeHtml(label)}</p><p class="text-sm font-bold text-ink mt-0.5">${escapeHtml(String(val))}</p></div>`;
  }
  function currentTier(km, rewards) {
    const unlocked = rewards.filter(r => km >= r.km_threshold);
    if (!unlocked.length) return null;
    const top = unlocked[unlocked.length - 1];
    return top.tier in TIER_META ? top.tier : null;
  }
  function strikeCardHtml(count, susp) {
    let cls, icon, titleCol, title, sub;
    if (susp) { cls = 'bg-rose-50 border-2 border-rose-300'; icon = '🚫'; titleCol = 'text-rose-700'; title = 'Suspendido la próxima semana'; sub = 'Por acumular 3 strikes'; }
    else if (count >= 2) { cls = 'bg-rose-50 border-2 border-rose-200'; icon = '🚨'; titleCol = 'text-rose-700'; title = `${count} de 3 strikes`; sub = '¡Cuidado! Un strike más y te suspenden'; }
    else if (count === 1) { cls = 'bg-amber-50 border-2 border-amber-200'; icon = '⚠️'; titleCol = 'text-amber-700'; title = '1 de 3 strikes'; sub = 'Revisa el motivo y cuida tu operación'; }
    else { cls = 'bg-white border border-slate-200 shadow-card'; icon = '✅'; titleCol = 'text-emerald-700'; title = 'Sin strikes'; sub = 'Buen historial — sigue así'; }
    const dotCol = count >= 2 || susp ? 'bg-rose-500' : (count === 1 ? 'bg-amber-500' : 'bg-emerald-500');
    const dots = [1, 2, 3].map(i => `<div class="w-6 h-1.5 rounded-full ${i <= count ? dotCol : 'bg-slate-200'}"></div>`).join('');
    return `<button id="pf-strikes-btn" class="w-full text-left rounded-2xl p-4 ${cls} active:scale-[.99] transition">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-xl shrink-0 shadow-sm">${icon}</div>
        <div class="flex-1 min-w-0"><p class="text-sm font-extrabold ${titleCol}">${title}</p><p class="text-xs text-slate-500">${sub}</p></div>
        <span class="${titleCol} font-bold">›</span>
      </div>
      <div class="flex gap-1.5 mt-3">${dots}</div>
    </button>`;
  }

  function strikesViewHtml() {
    const d = state.profileData;
    const susp = d.susp;
    // Detalle: strikes no anulados (incluye los "consumidos" del ciclo que generó
    // la suspensión, para que un conductor suspendido vea por qué).
    const shown = (d.strikes || []).filter(s => !s.voided_at);
    const count = susp ? 3 : d.activeStrikes.length;
    const fmtD = (s) => { try { return new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return s; } };
    const list = shown.slice(0, 3).map((s, i) => `<div class="rounded-2xl bg-white border border-slate-200 p-4 flex gap-3">
        <div class="w-8 h-8 rounded-full bg-rose-100 text-rose-700 font-extrabold flex items-center justify-center shrink-0 text-sm">${Math.min(shown.length, 3) - i}</div>
        <div class="flex-1 min-w-0"><p class="text-sm font-bold text-ink">${escapeHtml(s.reason || 'Strike')}</p><p class="text-[11px] text-slate-400 mt-1">Semana ${escapeHtml(fmtD(s.week_start_date))} · asignado por el administrador</p></div>
      </div>`).join('') || '<p class="text-sm text-slate-500">No tienes strikes activos. 🎉</p>';
    const suspBlock = susp ? `<div class="rounded-3xl bg-gradient-to-br from-rose-600 to-rose-700 text-white p-6 text-center shadow-lg mb-4">
        <div class="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center text-3xl mx-auto mb-3">🚫</div>
        <p class="text-xl font-extrabold">Suspensión activa</p>
        <p class="text-sm text-white/85 mt-1.5">La próxima semana no podrás iniciar turnos ni marcar disponibilidad. La levanta tu administrador.</p>
      </div>` : '';
    return `
      <button id="pf-back" class="flex items-center gap-1 text-sm font-bold text-slate-600 py-2 mb-1">‹ Volver al perfil</button>
      <h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Strikes</h2>
      ${suspBlock}
      <div class="rounded-3xl bg-white border-2 ${count >= 2 || susp ? 'border-rose-200' : count === 1 ? 'border-amber-200' : 'border-emerald-200'} p-5 text-center shadow-card mb-4">
        <p class="text-[11px] font-bold uppercase tracking-wider ${count >= 2 || susp ? 'text-rose-600' : count === 1 ? 'text-amber-600' : 'text-emerald-600'}">Strikes acumulados</p>
        <p class="text-5xl font-extrabold text-ink mt-1">${count}<span class="text-2xl text-slate-300"> / 3</span></p>
      </div>
      <div class="rounded-2xl bg-slate-100 p-4 mb-4"><p class="text-sm font-bold text-ink">¿Qué pasa al llegar a 3 strikes?</p><p class="text-xs text-slate-500 mt-1">Tu cuenta se suspende la semana siguiente: no podrás iniciar turnos ni marcar disponibilidad hasta que el administrador lo resuelva.</p></div>
      <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500 mb-2">Detalle</h3>
      <div class="space-y-2.5 pb-6">${list}</div>`;
  }

  function rewardsViewHtml() {
    const d = state.profileData;
    const km = d.kmTotal;
    const next = d.rewards.find(r => r.km_threshold > km);
    const faltan = next ? next.km_threshold - km : 0;
    const base = (() => { const prev = [...d.rewards].reverse().find(r => r.km_threshold <= km); return prev ? prev.km_threshold : 0; })();
    const pct = next ? Math.min(100, Math.round((km - base) / (next.km_threshold - base) * 100)) : 100;
    const redByReward = {}; (d.redemptions || []).forEach(r => { if (!redByReward[r.reward_id] || r.status !== 'rejected') redByReward[r.reward_id] = r; });
    const cards = d.rewards.length ? d.rewards.map(r => {
      const unlocked = km >= r.km_threshold;
      const red = redByReward[r.id];
      const requested = red && red.status !== 'rejected';
      const tm = TIER_META[r.tier] || { label: r.tier, emoji: '🎁' };
      const foot = !unlocked
        ? `<div class="mt-3"><div class="h-2 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-brand-300 rounded-full" style="width:${Math.min(100, Math.round(km / r.km_threshold * 100))}%"></div></div><p class="text-[11px] text-slate-400 mt-1.5 text-center">🔒 Faltan ${(r.km_threshold - km).toLocaleString('es-CO')} km</p></div>`
        : requested
          ? `<button disabled class="mt-3 w-full bg-emerald-50 text-emerald-700 font-bold py-2.5 rounded-xl text-sm">${red.status === 'delivered' ? '✓ Entregado' : '⏳ Solicitado'}</button>`
          : `<button data-redeem="${r.id}" class="mt-3 w-full bg-brand text-white font-bold py-2.5 rounded-xl shadow-brand active:scale-[.98] text-sm">Redimir</button>`;
      return `<div class="snap-start shrink-0 w-[240px] rounded-2xl bg-white border-2 overflow-hidden flex flex-col ${unlocked && !requested ? 'border-emerald-200 shadow-card' : 'border-slate-200'}">
          <div class="h-24 flex items-center justify-center text-5xl ${unlocked ? 'bg-gradient-to-br from-brand-50 to-brand-100' : 'bg-slate-100 grayscale opacity-70'}">${tm.emoji}</div>
          <div class="p-4 flex-1 flex flex-col">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${unlocked ? (requested ? 'text-slate-500 bg-slate-100' : 'text-emerald-700 bg-emerald-50') : 'text-slate-400 bg-slate-100'}">${unlocked ? (requested ? 'Solicitado' : 'Disponible') : 'Bloqueado'}</span>
              <span class="text-[11px] font-bold text-slate-400">${r.km_threshold.toLocaleString('es-CO')} km</span>
            </div>
            <p class="text-[15px] font-extrabold text-ink mt-2 leading-tight">${escapeHtml(r.title)}</p>
            <p class="text-xs text-slate-500 mt-0.5 flex-1">${escapeHtml(r.description || '')}</p>
            ${foot}
          </div>
        </div>`;
    }).join('') : '<div class="px-1 text-sm text-slate-500">Aún no hay recompensas configuradas. Tu administrador las definirá pronto.</div>';
    const hist = d.closed.length ? d.closed.map(sh => {
      const k = kmDrivenOf(sh); const veh = sh.vehicles ? (sh.vehicles.internal_code || sh.vehicles.license_plate || '') : '';
      const date = sh.end_at ? new Date(sh.end_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';
      return `<div class="flex items-center justify-between px-4 py-3 border-b border-slate-100 last:border-0">
          <div class="flex items-center gap-3"><div class="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center text-sm">🚐</div><div><p class="text-sm font-semibold text-ink">${escapeHtml(date)}</p><p class="text-[11px] text-slate-400">${escapeHtml(veh || 'Turno')}</p></div></div>
          <span class="text-sm font-bold tabular-nums text-emerald-600">+${k.toLocaleString('es-CO')} km</span>
        </div>`;
    }).join('') : '<div class="px-4 py-4 text-sm text-slate-500">Aún no has cerrado turnos.</div>';
    return `
      <button id="pf-back" class="flex items-center gap-1 text-sm font-bold text-slate-600 py-2 mb-1">‹ Volver al perfil</button>
      <h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Recompensas</h2>
      <div class="rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 text-white p-5 shadow-brand">
        <p class="text-xs uppercase tracking-wider text-white/80 font-bold">Kilómetros acumulados</p>
        <p class="text-4xl font-extrabold mt-1 tabular-nums">${km.toLocaleString('es-CO')} <span class="text-lg font-bold text-white/80">km</span></p>
        <div class="mt-4">
          <div class="flex justify-between text-[11px] font-semibold text-white/85 mb-1.5"><span>${next ? 'Próxima: ' + escapeHtml(next.title) : '¡Todo desbloqueado!'}</span><span>${next ? next.km_threshold.toLocaleString('es-CO') + ' km' : ''}</span></div>
          <div class="h-2.5 rounded-full bg-white/25 overflow-hidden"><div class="h-full bg-white rounded-full transition-all" style="width:${pct}%"></div></div>
          ${next ? `<p class="text-[11px] text-white/85 mt-1.5">Te faltan ${faltan.toLocaleString('es-CO')} km</p>` : ''}
        </div>
      </div>
      <div class="flex items-center justify-between pt-5 mb-3"><h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500">Canjea tus kilómetros</h3><span class="text-[11px] font-semibold text-slate-400">desliza →</span></div>
      <div class="flex gap-3 overflow-x-auto pb-1 snap-x" style="scrollbar-width:none">${cards}</div>
      <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500 pt-6 mb-2">Mi kilometraje</h3>
      <div class="rounded-2xl bg-white border border-slate-200 shadow-card overflow-hidden mb-2"><div class="flex items-center justify-between px-4 py-3 bg-slate-50"><span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Turnos cerrados</span><span class="text-sm font-extrabold text-ink">${d.closed.length}</span></div>${hist}</div>
      <p class="text-[11px] text-slate-400 text-center mt-3 pb-6">Acumulado total: <strong class="text-ink">${km.toLocaleString('es-CO')} km</strong></p>`;
  }

  function bindProfile() {
    const box = $('#driver-profile-container'); if (!box) return;
    $('#pf-rewards-btn')?.addEventListener('click', () => { state.profileView = 'rewards'; drawProfileView(); });
    $('#pf-strikes-btn')?.addEventListener('click', () => { state.profileView = 'strikes'; drawProfileView(); });
    $('#pf-back')?.addEventListener('click', () => { state.profileView = 'main'; drawProfileView(); });
    $('#pf-logout')?.addEventListener('click', onLogout);
    $('#pf-avatar-btn')?.addEventListener('click', () => $('#pf-avatar-input')?.click());
    $('#pf-avatar-input')?.addEventListener('change', onPickAvatar);
    box.querySelectorAll('[data-redeem]').forEach(b => b.addEventListener('click', () => onRedeem(b.dataset.redeem)));
  }

  async function onPickAvatar(input) {
    const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    try {
      toast('Subiendo foto…');
      const blob = await compressImage(file, 512, 0.85);
      const url = await Api.uploadMyAvatar(blob);
      if (state.profile) state.profile.avatar_url = url;
      if (state.profileData && state.profileData.prof) state.profileData.prof.avatar_url = url;
      drawProfileView();
      toast('Foto actualizada.');
    } catch (e) { console.error(e); toast('No se pudo subir la foto.'); }
  }

  async function onRedeem(rewardId) {
    const d = state.profileData; const r = d.rewards.find(x => x.id === rewardId);
    if (!r) return;
    if (!confirm(`¿Redimir "${r.title}"? Se enviará una solicitud a tu administrador.`)) return;
    try {
      await Api.redeemReward({ rewardId, organizationId: state.profile.organization_id, driverId: state.driverId, kmAtRequest: d.kmTotal });
      toast('¡Solicitud enviada! Tu administrador la revisará.');
      await renderDriverProfile();
    } catch (e) { console.error(e); toast('No se pudo redimir: ' + (e.message || 'error')); }
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
      if ((day.coord_am || []).includes(meId)) myShifts.push({ d, shift: 'AM', kind: 'Líder de turno' });
      if ((day.coord_pm || []).includes(meId)) myShifts.push({ d, shift: 'PM', kind: 'Líder de turno' });
    });
    if (summaryBox) {
      if (!myShifts.length) {
        summaryBox.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-sm text-slate-500 mt-1">No tienes turnos asignados esta semana.</p>
        </div>`;
      } else {
        const horas = myShifts.length * ((state.settings && state.settings.shift_hours) || 12);
        const items = myShifts.map(s => `<li class="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5">
          <span class="text-sm text-ink">${s.d.label} ${s.d.dayNum}</span>
          <span class="text-xs font-semibold text-slate-600">${s.shift}${s.kind === 'Líder de turno' ? ' · Líder' : ''}</span>
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

    // Contenedor según el rol (conductor: dentro de la pestaña Inicio).
    const host = state.profile.role === 'admin'
      ? document.getElementById('app-shell')
      : document.querySelector('#driver-tabs-root [data-dtab="home"]');
    if (!host) return;
    if (existing) return; // ya está
    const bar = document.createElement('div');
    bar.id = 'enable-push-bar';
    bar.className = 'push-bar';
    bar.innerHTML = `<span>🔔 Activa las notificaciones para enterarte de cambios de turno, strikes y horarios.</span>
      <button id="enable-push-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Activar</button>`;
    // Admin: arriba del shell. Conductor: al final del Inicio (debajo de las 2 tarjetas).
    if (state.profile.role === 'admin') host.insertBefore(bar, host.firstChild);
    else host.appendChild(bar);
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
