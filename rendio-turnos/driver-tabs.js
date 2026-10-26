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
    // En semana cerrada (o cuenta suspendida) ya no hay nada que confirmar:
    // el empujón diría «Cierra el sábado…» sobre un corte que ya pasó.
    if (!faltan || !avEditable()) { box.innerHTML = ''; return; }
    const cut = avDeadline();
    // Desde el 2026-09-15 la semana nace propuesta en "Puedo": lo que falta ya no es
    // marcarla jornada por jornada, es confirmarla.
    box.innerHTML = `
      <div class="rc-sechd">Próxima semana</div>
      <button class="rc-card rc-nudge rc-in d3" id="dh-nudge-btn" type="button">
        <span style="display:flex;align-items:center;gap:12px">
          <span class="rc-nudge-ic">${avIcon('calendar', 18, 1.6)}</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-size:14.5px;font-weight:650;color:var(--r-warn)">Tu semana todavía no está confirmada</span>
            <span style="display:block;font-size:12.5px;color:var(--r-warn);opacity:.82;margin-top:2px">Cierra ${cut.when} a las ${cut.time}</span>
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
    // Si quedó una vuelta en curso (la app se cerró o se recargó), la ubicación vuelve
    // a compartirse sin tener que entrar a la ruta (ruta v2, cambio 1 de la entrega).
    if (window.DriverRutas && DriverRutas.background) DriverRutas.background(state.profile, vueltas);
    // Llegó desde el aviso de un mensaje (#/viaje?r=…): abre ese chat en la ruta.
    if (window.DriverRutas && DriverRutas.deepLink) DriverRutas.deepLink(state.profile);

    // La primera vuelta sin terminar lleva su «Iniciar ruta» aquí mismo: un toque
    // abre la ruta en ejecución y la base le avisa al primer tripulante (0097).
    // Antes eran 3–4 toques (Ruta → la vuelta → Iniciar ruta).
    const primera = vueltas.find(v => !v.done);
    const tarjeta = (v) => {
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
          <span style="display:block;font-size:16px;font-weight:650;letter-spacing:-.3px">${salida ? 'Casas → Aeropuerto JMC' : 'Aeropuerto JMC → Casas'}</span>
          <span style="display:block;font-size:13px;color:var(--r-text-2);margin-top:3px">
            ${n} auxiliar${n === 1 ? '' : 'es'}${v.start ? ` · sale ${escapeHtml(v.start)}` : ''}${v.opDay && v.day && v.day !== v.opDay ? ' · madrugada del día siguiente' : ''}
          </span>
          <span style="display:flex;align-items:center;gap:6px;margin-top:11px;font-size:13px;font-weight:600;color:var(--r-accent)">
            Ver la vuelta ${avIcon('chevronRight', 15)}
          </span>
        </button>${v === primera && v.assignmentId ? `
        <button class="rc-btn-primary rc-in d2" data-vuelta-start="${escapeHtml(v.assignmentId)}" type="button"
                style="width:100%;height:52px;border:none;border-radius:14px;background:var(--r-accent);color:#fff;font:inherit;font-size:16px;font-weight:650;display:flex;align-items:center;justify-content:center;gap:8px;margin:-2px 0 14px;cursor:pointer">
          ${avIcon('car', 18, 1.8)}${(v.legs || []).some(l => l.stopStatus && l.stopStatus !== 'pending') ? 'Seguir ruta' : 'Iniciar ruta'}${v.start ? ` · ${escapeHtml(v.start)}` : ''}
        </button>` : ''}`;
    };
    // Las que ya hizo se guardan (26-oct-2026, pedido de la profa): arriba queda lo
    // que falta, y las hechas aparecen con un toque. Cada vez que se entra a Inicio
    // vuelven a estar guardadas.
    const pendientes = vueltas.filter(v => !v.done), hechas = vueltas.filter(v => v.done);
    const pintar = (verHechas) => {
      box.innerHTML = `<div class="rc-sechd">Tu día</div>`
        + (pendientes.length ? pendientes.map(tarjeta).join('')
          : `<div class="rc-empty rc-in d2" style="margin-bottom:8px"><span class="rc-empty-ic">${avIcon('check', 20, 1.8)}</span><b>Terminaste tus vueltas de hoy</b></div>`)
        + (hechas.length ? `
        <button type="button" class="rc-link-row rc-in d2" data-vuelta-hechas aria-expanded="${verHechas}" style="margin:2px 0 ${verHechas ? '10px' : '0'}">
          <span class="rc-link-ic" style="background:var(--r-a2h-soft);color:var(--r-a2h)">${avIcon('check', 15, 1.8)}</span>
          <span class="t"><b>${hechas.length} ${hechas.length === 1 ? 'vuelta hecha' : 'vueltas hechas'}</b><span>${verHechas ? 'Toca para ocultarlas' : 'Toca para verlas'}</span></span>
          <span class="rc-link-chev" style="transform:rotate(${verHechas ? -90 : 90}deg)">${avIcon('chevronRight', 16)}</span>
        </button>${verHechas ? hechas.map(tarjeta).join('') : ''}` : '');
      box.querySelector('[data-vuelta-hechas]')?.addEventListener('click', () => pintar(!verHechas));
      box.querySelectorAll('[data-vuelta]').forEach(b => {
        b.addEventListener('click', () => { if (window.DriverRutas) DriverRutas.open(state.profile); });
      });
      box.querySelectorAll('[data-vuelta-start]').forEach(b => {
        b.addEventListener('click', () => { if (window.DriverRutas) DriverRutas.open(state.profile, { startAssignment: b.dataset.vueltaStart }); });
      });
    };
    pintar(false);
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
