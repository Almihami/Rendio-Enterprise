// driver-tabs.js — Inicio, Mi horario y Solicitudes del conductor con el
// sistema visual del rediseño (entrega rc-tabs.jsx, 2026-08-16).
//
// Acá vive SOLO lo que es propio de estas pestañas: el saludo y las tarjetas de
// Inicio, la cabecera de Mi horario, el filtro de Solicitudes y el tema
// claro/oscuro. Los datos los siguen trayendo las funciones de siempre
// (shift-flow.js, driver-perfil.js, driver-rutas.js): esto es revestimiento.
//
// Regla que pidió la profa: lo que la BD todavía no tiene NO se dibuja ni se
// inventa. Los huecos (hora de la jornada, placa del horario publicado) quedan
// como ranuras vacías y aparecen solos el día que el dato exista.
//
// Comparte scope global con los demás módulos; el orden de carga está en index.html.

  // ====================================================================
  // Tema claro / oscuro — solo las pestañas del conductor
  // ====================================================================
  // Se aplica en #driver-tabs-root, no en <html>: el wizard de inicio de turno y
  // toda la vista admin siguen en claro, y no queremos una app a medio pintar.
  const RC_THEME_KEY = 'rendio.driver.theme';

  function rcTheme() {
    try { return localStorage.getItem(RC_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function rcSetTheme(v) {
    try { localStorage.setItem(RC_THEME_KEY, v); } catch (e) { /* modo privado */ }
    rcApplyTheme();
  }
  function rcApplyTheme() {
    document.getElementById('driver-tabs-root')?.setAttribute('data-theme', rcTheme());
  }

  // ====================================================================
  // Inicio
  // ====================================================================

  async function renderDriverInicio() {
    rcApplyTheme();
    const greet = $('#driver-home-greet');
    const sub = $('#driver-home-sub');
    if (greet) greet.textContent = `${getGreetingPrefix()}, ${firstNameOf(state.profile)}`;
    if (sub) {
      const hoy = new Date().toLocaleDateString('es-CO',
        { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
      // La placa solo si hay turno abierto con vehículo: si no, no se inventa.
      const v = (typeof sf !== 'undefined' && sf.activeShift && sf.activeShift.vehicles) || null;
      const placa = v ? (v.internal_code || v.license_plate || '') : '';
      sub.textContent = hoy.charAt(0).toUpperCase() + hoy.slice(1) + (placa ? ` · ${placa}` : '');
    }
    renderDriverHomeNudge();
    await renderDriverHomeRuta();
  }

  // "Próxima semana": solo aparece si de verdad quedan jornadas sin marcar.
  function renderDriverHomeNudge() {
    const box = $('#driver-home-nudge');
    if (!box) return;
    const { faltan } = avCounts();
    if (!faltan) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="rc-sechd">Próxima semana</div>
      <button class="rc-card rc-nudge rc-in d3" id="dh-nudge-btn" type="button">
        <span style="display:flex;align-items:center;gap:12px">
          <span class="rc-nudge-ic">${avIcon('calendar', 18, 1.6)}</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-size:14.5px;font-weight:650;color:var(--r-warn)">Te falta${faltan === 1 ? '' : 'n'} ${faltan} jornada${faltan === 1 ? '' : 's'} por marcar</span>
            <span style="display:block;font-size:12.5px;color:var(--r-warn);opacity:.82;margin-top:2px">Cierra el domingo a las 2:00 p.m.</span>
          </span>
          <span style="color:var(--r-warn);display:flex">${avIcon('chevronRight', 17)}</span>
        </span>
      </button>`;
    $('#dh-nudge-btn')?.addEventListener('click', () => setDriverTab('avail'));
  }

  // "Tu día": la vuelta asignada de hoy. Sin vuelta, la sección no existe.
  async function renderDriverHomeRuta() {
    const box = $('#driver-home-ruta');
    if (!box) return;
    box.innerHTML = '';
    let vueltas = null;
    try {
      if (window.Api && Api.listMyVueltasForDriver) vueltas = await Api.listMyVueltasForDriver(state.profile.id);
    } catch (e) { /* sin ruta: la sección simplemente no aparece */ }
    if (!vueltas || !vueltas.length) return;

    box.innerHTML = `<div class="rc-sechd">Tu día</div>` + vueltas.map((v, i) => {
      const salida = v.type !== 'lle';
      const tono = salida ? 'var(--r-h2a)' : 'var(--r-a2h)';
      const fondo = salida ? 'var(--r-h2a-soft)' : 'var(--r-a2h-soft)';
      // Las paradas de auxiliares son las legs que no son el aeropuerto.
      const n = (v.legs || []).filter(l => l.kind !== 'airport').length;
      return `
        <button class="rc-card rc-in d2" data-vuelta="${escapeHtml(v.id)}" type="button"
                style="border-left:4px solid ${tono};margin-bottom:8px">
          <span style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:11.5px;font-weight:700;color:${tono};letter-spacing:.5px;text-transform:uppercase">${salida ? 'Salida' : 'Llegada'}</span>
            <span style="margin-left:auto;font-size:11px;font-weight:600;padding:3px 9px;border-radius:100px;background:${fondo};color:${tono}">${v.done ? 'Terminada' : 'Asignada'}</span>
          </span>
          <span style="display:block;font-size:16px;font-weight:650;letter-spacing:-.3px">${salida ? 'Casas → Aeropuerto MDE' : 'Aeropuerto MDE → Casas'}</span>
          <span style="display:block;font-size:13px;color:var(--r-text-2);margin-top:3px">
            ${n} auxiliar${n === 1 ? '' : 'es'}${v.start ? ` · sale ${escapeHtml(v.start)}` : ''}
          </span>
          <span style="display:flex;align-items:center;gap:6px;margin-top:11px;font-size:13px;font-weight:600;color:var(--r-accent)">
            Ver la vuelta ${avIcon('chevronRight', 15)}
          </span>
        </button>`;
    }).join('');

    box.querySelectorAll('[data-vuelta]').forEach(b => {
      b.addEventListener('click', () => { if (window.DriverRutas) DriverRutas.open(state.profile); });
    });
  }

  // ====================================================================
  // Mi horario — cabecera (la lista la pinta renderDriverPublishedSchedule)
  // ====================================================================

  function renderDriverHorarioHead(nTurnos) {
    const box = $('#driver-horario-head');
    if (!box) return;
    const m = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const a = new Date(state.currentWeek + 'T00:00:00');
    const b = new Date(state.currentWeek + 'T00:00:00'); b.setDate(b.getDate() + 6);
    const rango = a.getMonth() === b.getMonth()
      ? `${a.getDate()} — ${b.getDate()} de ${m[b.getMonth()]}`
      : `${a.getDate()} de ${m[a.getMonth()]} — ${b.getDate()} de ${m[b.getMonth()]}`;
    const sub = nTurnos == null
      ? 'Tu semana, cuando tu jefe la publique.'
      : (nTurnos === 0
        ? 'No tienes turnos asignados esta semana.'
        : `${nTurnos} turno${nTurnos === 1 ? '' : 's'} asignado${nTurnos === 1 ? '' : 's'} esta semana. Lo publicó tu jefe.`);
    box.innerHTML = `
      <div class="rc-sticky">
        <div class="rc-weeknav">
          <button class="r-icon-btn" id="dh-prev" type="button" aria-label="Semana anterior">${avIcon('chevronLeft', 19)}</button>
          <div class="rc-weeknav-mid">
            <div class="rc-eyebrow" style="font-size:10px">Ya programada</div>
            <div class="rc-weeknav-label">${rango}</div>
          </div>
          <button class="r-icon-btn" id="dh-next" type="button" aria-label="Semana siguiente">${avIcon('chevronRight', 19)}</button>
        </div>
      </div>
      <div style="margin-top:12px" class="rc-in">
        <h1 class="rc-h">Mi horario</h1>
        <p class="rc-sub" style="margin-left:0;max-width:none">${sub}</p>
      </div>`;
    $('#dh-prev')?.addEventListener('click', () => navigateDriverWeek(-7));
    $('#dh-next')?.addEventListener('click', () => navigateDriverWeek(7));
  }

  // ====================================================================
  // Solicitudes — filtro Todas / Permisos / Cambios
  // ====================================================================

  function bindDriverSolicFilter() {
    const bar = $('#driver-solic-filter');
    if (!bar || bar.dataset.bound) return;
    bar.dataset.bound = '1';
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      state.driverSolicFilter = b.dataset.f;
      bar.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      applyDriverSolicFilter();
    });
  }

  // Los dos contenedores ya están pintados; el filtro solo los muestra u oculta.
  function applyDriverSolicFilter() {
    const f = state.driverSolicFilter || 'todas';
    const reqs = $('#driver-requests-container');
    const swaps = $('#driver-swaps-container');
    if (reqs) reqs.style.display = (f === 'cambios') ? 'none' : '';
    if (swaps) swaps.style.display = (f === 'permisos') ? 'none' : '';
  }
