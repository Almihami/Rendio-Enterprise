// driver-home.js — Conductor: tarjetas de horario (vista home).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
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
    rcApplyTheme();
    renderDriverDays();
    bindDriverSolicFilter();
    await renderDriverRequests();
    await renderDriverPublishedSchedule();
    await renderDriverSwaps();
    applyDriverSolicFilter();
    updateDriverHome(); // saludo + "Tu día" + aviso de jornadas por marcar
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

  // Muestra la barra inferior.
  //
  // ANTES SOLO APARECÍA AL ENTRAR A UN MÓDULO, y eso dejaba al conductor
  // encerrado en Inicio: la barra era el único camino a Mi horario, Solicitudes
  // y Perfil, y la barra no salía hasta haber ido a uno de ellos. El único
  // atajo era el aviso de "te faltan jornadas por marcar", que desaparece en
  // cuanto marca la semana (driver-tabs.js, renderDriverHomeNudge).
  //
  // Lo reportó la profa el 4-sep-2026 mirando la app de Daniel en PRODUCCIÓN:
  // turno en curso, disponibilidad ya marcada, y sin barra. Sin salida.
  function revealDriverNav() {
    if (state.driverNavRevealed) return;
    state.driverNavRevealed = true;
    $('#driver-nav')?.classList.add('show');
    $('#driver-tabs-root')?.classList.add('nav-on');
  }

  function setDriverTab(name) {
    state.driverTab = name;
    revealDriverNav();   // siempre: Inicio también es una pestaña de la barra
    $$('#driver-tabs-root .driver-panel').forEach(p => p.classList.toggle('hidden', p.dataset.dtab !== name));
    $$('#driver-nav .dnav-btn').forEach(b => b.classList.toggle('active', b.dataset.dtab === name));
    // Barra de semana: solo en Mi horario. Disponibilidad trae la suya dentro
    // de la cabecera pegajosa desde el rediseño 2026-08-16, junto al medidor.
    $('#driver-week-bar')?.classList.toggle('hidden', name !== 'schedule');
    if (name === 'home') updateDriverHome();
    if (name === 'perfil') renderDriverProfile();
    window.scrollTo(0, 0);
  }

  // Aliases para llamadas existentes.
  function showDriverHome() { setDriverTab('home'); }
  function showDriverAvailability() { setDriverTab('avail'); }

