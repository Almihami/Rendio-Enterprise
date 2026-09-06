// core.js — Boot, sesión/login, estado global, tabs y helpers base.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const isSuspended = () => state.profile && state.profile.is_active === false;

  // El admin de escritorio y el admin de celular no son el mismo usuario: el
  // primero planea, el segundo recibe alertas de operación a las 4 de la mañana.
  // Varias decisiones de UI (instalar la PWA, activar notificaciones) dependen de
  // distinguirlos.
  // 768px NO es un número al azar: es el MISMO corte con el que styles.css pasa el
  // admin a una columna y convierte el sidebar en cajón deslizante. Estuvo en 820
  // y los dos umbrales se contradecían: entre 769 y 820 la app se creía celular
  // mientras el layout seguía siendo el de escritorio. En esa franja —donde cae un
  // computador con el zoom del navegador subido— el aviso de notificaciones se
  // pintaba encima del sidebar. Si se cambia este número, cámbiese el del CSS.
  const adminOnPhone = () => window.matchMedia('(max-width: 768px)').matches;

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

    // --- Vista previa SOLO LOCAL (para probar UI sin cuenta real) ---
    // Se activa únicamente en localhost + hash explícito. Nunca en producción.
    const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname);
    if (isLocal && location.hash.startsWith('#preview-')) {
      const role = location.hash.replace('#preview-', '');
      const demo = { admin: 'Admin Demo', auxiliar: 'María Gómez', driver: 'Conductor Demo' };
      if (demo[role]) {
        state.profile = { role, full_name: demo[role], id: 'preview-' + role };
        dismissSplash();
        return enterApp();
      }
    }

    const splashHold = new Promise((r) => setTimeout(r, 2500));

    let nextAction = () => showLogin();
    try {
      const session = await Api.getSession();
      if (session) {
        const profile = await Api.getCurrentProfile();
        if (!profile) {
          // Un tripulante que verificó su correo y cerró la app antes de
          // terminar el paso 3 cae exactamente aquí: tiene sesión y no tiene
          // perfil. Antes se le cerraba la sesión y se le decía «tu cuenta no
          // tiene perfil asociado», que para él es una pared. Ahora se le
          // retoma el registro donde iba.
          const pend = session.user?.user_metadata?.pending_role === 'auxiliar';
          if (pend && window.AuxRegistro) {
            nextAction = () => AuxRegistro.resume(session.user);
          } else {
            await Api.signOut();
            nextAction = () => showLogin('Tu cuenta no tiene perfil asociado.');
          }
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
    // Si la app YA está abierta cuando toca la notificación, el service worker
    // solo cambia el hash de la ventana existente: no hay recarga y por lo tanto
    // no vuelve a pasar por enterApp(). Sin este oyente, el push abriría la app
    // pero no la eventualidad.
    window.addEventListener('hashchange', () => { try { applyDeepLink(); } catch (e) { /* */ } });

    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#login-signup')?.addEventListener('click', () => {
      if (window.AuxRegistro) AuxRegistro.start();
    });
    $('#logout-btn').addEventListener('click', onLogout);
    $('#logout-btn-mobile').addEventListener('click', onLogout);

    $('#auto-resolve-btn').addEventListener('click', onAutoResolve);

    // El modal de motivo y el selector de estado del conductor desaparecieron con
    // el rediseño 2026-08-16. La hoja de motivo (#av-sheet) se cablea sola en
    // driver-disponibilidad.js; acá solo queda cerrar tocando el velo.
    $('#av-back')?.addEventListener('click', () => avCloseSheet(false));

    // La navegación admin se cablea en bindAdminSidebar() (sidebar por capas).

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
    $('#save-route-tables-btn')?.addEventListener('click', saveRouteTables);

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
    // Guardar y "Disponible toda la semana" ya no son botones fijos del shell:
    // viven dentro de la pantalla y los cablea driver-disponibilidad.js.
    $('#driver-availability-card')?.addEventListener('click', showDriverAvailability);
    $('#driver-back-home')?.addEventListener('click', showDriverHome);
    $('#driver-nav')?.addEventListener('click', (e) => { const b = e.target.closest('[data-dtab]'); if (b) setDriverTab(b.dataset.dtab); });
  }

  // onMarkAllAvailable() se eliminó con el rediseño 2026-08-16: el atajo de
  // semana completa ahora es el botón "Toda la semana: Puedo" dentro de la
  // grilla, y no necesita confirm() porque "Limpiar" deshace al instante.

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

  // Título accesible de la pestaña Disponibilidad. Desde el rediseño 2026-08-16
  // va en .sr-only: en pantalla el estado lo comunica el medidor de 14 jornadas,
  // pero un lector de pantalla necesita el resumen en texto.
  function updateDriverGreeting() {
    const h2 = $('#driver-greeting');
    const sub = $('#driver-greeting-sub');
    if (!h2 || !sub) return;
    h2.textContent = `Disponibilidad · ${getGreetingPrefix()}, ${firstNameOf(state.profile)}`;
    sub.textContent = availabilitySummaryText();
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

  // flashSaveState() se eliminó con el rediseño 2026-08-16: escribía en
  // #driver-save-state, el texto de la barra fija de Guardar que ya no existe.
  // Su equivalente es la nota bajo el botón "Guardar mi semana", que la pinta
  // avSaveBlockHtml() en driver-disponibilidad.js.

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

  // Entrada directa con un perfil ya resuelto. La usa el registro del tripulante
  // al terminar: recargar la página funcionaría, pero se ve como si la app se
  // hubiera caído justo cuando acaba de crear su cuenta.
  window.enterAppAs = async function (profile) {
    if (!profile) { location.reload(); return; }
    state.profile = profile;
    document.getElementById('auxiliar-root')?.classList.add('hidden');
    const ui = document.getElementById('auxiliar-ui');
    if (ui) ui.innerHTML = '';
    await enterApp();
  };

  async function enterApp() {
    $('#screen-login').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    $('#role-label').textContent = state.profile.role === 'admin' ? 'Administrador' : 'Conductor';
    $('#role-label-mobile').textContent = state.profile.role === 'admin' ? 'Admin' : 'Conductor';

    state.settings = await Api.getSettings();
    await loadRules();

    // Auxiliar (pasajero): pantalla propia full-screen, fuera del shell admin/conductor.
    if (state.profile.role === 'auxiliar') {
      $('#app-shell').classList.add('hidden');
      $('#auxiliar-root').classList.remove('hidden');
      if (window.Auxiliar) Auxiliar.init(state.profile);
      return;
    }

    if (state.profile.role === 'admin') {
      // Shell admin: sidebar de navegación por capas (reemplaza la barra de pestañas).
      $('#app-shell').classList.add('admin-shell');
      $('#admin-side').classList.remove('hidden');
      $('#admin-mhead').classList.remove('hidden');
      $('#admin-greeting-block').classList.remove('hidden');
      // El admin de escritorio sigue sin botón de Instalar (decisión de jun-2026:
      // "los admins gestionan desde PC"). Pero el admin en el CELULAR es otra
      // cosa: sin la PWA instalada en la pantalla de inicio, iOS no entrega
      // notificaciones push — y sin push no hay aviso de madrugada, que es la
      // razón de ser de las eventualidades. Por eso se muestra solo ahí.
      if (!adminOnPhone()) {
        $('#install-btn')?.classList.add('hidden');
        $('#install-btn-mobile')?.classList.add('hidden');
      }
      updateAdminGreeting();
      state.drivers = await Api.listDrivers();
      state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false }));
      bindAdminSidebar();
      renderAdminSidebar();
      // Si venimos de tocar una notificación, se abre esa eventualidad en vez de
      // la consola.
      if (!applyDeepLink()) setTab('consola');
      // (Antes acá se escondía #driver-save-bar; esa barra desapareció con el
      // rediseño de Disponibilidad del 2026-08-16.)
      refreshInspectionsBadge();
      refreshShiftsBadge();
      refreshOilBadge();
      refreshEventsBadge();
    } else {
      $('#app-shell').classList.remove('admin-shell');
      $('#admin-side')?.classList.add('hidden');
      $('#admin-mhead')?.classList.add('hidden');
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
    // Si el módulo vive en el otro espacio de trabajo, cambia el switcher
    // y vuelve a pintar el sidebar antes de marcar el activo.
    if (name !== 'consola') {
      const found = findModuleByTab(name);
      if (found && found.ws !== cnWs) { cnWs = found.ws; renderAdminSidebar(); }
    }
    markSidebarActive();
    updateBreadcrumb(name);
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
    if (name === 'parts') renderParts();
    if (name === 'shifts') renderShifts();
    if (name === 'rewards') renderRewardsAdmin();
    if (name === 'consola') renderConsola();
    if (name === 'routes') renderRoutes();
    if (name === 'reservas') renderReservas();
    if (name === 'privados') renderPrivados();
    if (name === 'tripulantes') renderTripulantes();
    if (name === 'eventualidades') renderEventualidades();
    else stopEvtTimer(); // al salir de la bandeja, frena su polling
    if (name === 'oper') renderOperacion();
    else stopOperTimers(); // al salir de Operación, frena el reloj/simulación
  }

  // Enlace profundo desde una notificación push: `#/eventualidades?ev=<id>` abre
  // la bandeja YA en la eventualidad que motivó el aviso.
  //
  // Sin esto el push era casi inútil: el service worker navega a `data.url`
  // (sw.js) pero la app no tenía ruteo, así que un jefe que tocaba "Falla
  // mecánica · Carro 2" a las 4am aterrizaba en Horario y tenía que buscarla.
  function applyDeepLink() {
    if (state.profile?.role !== 'admin') return false;
    const h = String(location.hash || '');
    const m = h.match(/^#\/([a-z-]+)(?:\?(.*))?$/i);
    if (!m) return false;
    // `#/reservas?chat=<reservation_id>` (0067) abre Reservas con el hilo de ESE
    // traslado ya abierto. Es a donde apunta el aviso de "un tripulante escribió
    // y no tiene carro asignado": ese mensaje NO crea una eventualidad, así que
    // mandarlo a la bandeja sería mandarlo a una pantalla donde no está.
    const tab = m[1] === 'eventualidades' ? 'eventualidades'
      : m[1] === 'reservas' ? 'reservas' : null;
    if (!tab) return false;
    const params = new URLSearchParams(m[2] || '');
    const ev = params.get('ev');
    if (ev) evtState.focusId = ev;
    const chat = params.get('chat');
    if (chat) rvState.focusChatId = chat;
    // Se limpia el hash para que un refresco no vuelva a abrir lo mismo.
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* */ }
    setTab(tab);
    return true;
  }

