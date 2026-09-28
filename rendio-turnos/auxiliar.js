// auxiliar.js — Rol Auxiliar (pasajero): "Mis viajes" + pedir traslado.
// Módulo nuevo 2026-07-13. Comparte scope global con los demás (core carga primero).
// Diseño portado de /Visual/ (aux-booking + auxiliar-screens), aterrizado a Rionegro→MDE.
// Decisiones: login correo+contraseña · dirección con pin ajustable · sin propina
// (servicio mensual) · calificación ligera. Lee/escribe reservas REALES en dev
// (Api.listMyReservations/createReservation). Sin fallback: si no hay sesión o
// falla la consulta, se le dice al usuario en vez de inventarle viajes.

  // Coord del terminal de pasajeros MDE (misma que el motor de rutas).
  const AUX_MDE = { lat: 6.1715, lng: -75.4270 };

  // 2026-07-25: se eliminaron AUX_DEMO_TRIPS y toda la simulación de seguimiento
  // (el carrito que se deslizaba de A a B en 9 s con un ETA inventado, y el
  // "conductor asignado" que aparecía solo a los 6 s). Ver
  // [feedback-no-inventar-datos]. Ahora el auxiliar solo ve sus reservas reales;
  // si no hay sesión o falla la consulta, se lo decimos.

  const auxState = {
    profile: null, view: 'home', step: 1, form: {}, trips: [], editingTrip: null,
    // Botón rojo (0062/0063): hoja abierta con el motivo elegido, o null.
    alarm: null,
    map: null, marker: null, geoTimer: null, geoReq: 0, bound: false,
    trackMap: null, ratingSel: 0, ratingTags: [], source: 'live',
    // Seguimiento EN VIVO (source==='live'): polling del RPC + tween del carro.
    trackPoll: null, trackTween: null, trackCar: null, trackLine: null,
    trackLast: null, trackDestPt: null, trackDestMk: null,
    // Paradas que faltan por visitar: capa de marcadores + firma para no
    // repintarla en cada tick de 6 s (solo cuando de verdad cambia el recorrido).
    stopLayer: null, stopSig: null,
    // Vía REAL por carretera (OSRM) en vez de la línea recta que se veía antes.
    routePath: null, routeFrom: null, routeDestKey: null, routeAt: 0,
    // Hora estimada de llegada: segundos que faltaban y CUÁNDO se calcularon
    // (para descontar lo corrido entre recálculos).
    etaSecs: null, etaAt: 0, etaKind: null,
    // Chat con el conductor (0052). El botón de llamar NO se va: el chat es para
    // lo que conviene que quede escrito, la llamada para cuando no hay datos.
    chatOpen: false, chatMsgs: [], chatPoll: null, chatUnread: 0, chatSending: false,
    riskAt: 0,   // última consulta del vigilante de demoras (0053)
    chatWarned: false,  // ya se avisó que el otro no tiene notificaciones
    // Pestaña activa del nav inferior + cancelación en 2 toques (sin confirm() nativo).
    tab: 'inicio', confirmingCancel: false, cancelTimer: null,
    // Espera en el punto de recogida: cuenta regresiva REAL desde que el
    // conductor marcó "llegué" (arrived_at) durante wait_minutes de Ajustes.
    waitTick: null, waitFrom: null, waitMin: 5,
    // Entrega 2026-08-17 (bloque A): primer ingreso y hoja de soporte.
    // onbStep: 0..N-1 = pantallas de bienvenida · N = el permiso con motivo.
    onbStep: 0, supportOpen: false,
    // Siglas de aerolínea para el prefijo del número de vuelo (11-sep-2026).
    // `airlines` es el catálogo de la base (null mientras no llegue: se pinta
    // con el respaldo de AUX_AEROLINEAS) y `myIata` la sigla de la aerolínea
    // del tripulante, '' si no la sabemos.
    airlines: null, airLoading: false, myIata: '',
    // ── Lógica del rediseño (PL, 27-sep-2026) ──
    // Dirección del último cambio de paso del pedido ('fwd' | 'bwd'): el diseño
    // anima distinto avanzar (rxStepF) que retroceder (rxStepB), así que la
    // pantalla necesita saber hacia dónde se movió, no solo el número.
    stepDir: 'fwd', typeTimer: null,
    // Refresco de viajes (§2.7): uno a la vez, y los avisos ya mostrados.
    reloading: null, bannerSeen: {}, lastChanges: [],
    // Viaje cuyo ETA de OSRM está en etaSecs: compartir solo usa un ETA que
    // sea de ESE viaje (#19). Fase que pintó el HUD por última vez.
    etaTrip: null, hudPhase: null,
    // Viaje para el que el tripulante pidió calificar a propósito (desde el
    // historial), aunque antes hubiera dicho «Ahora no».
    rateOpen: null,
  };

  // Además de init, se exponen tres ayudas para los módulos de la entrega
  // (aux-residencias, aux-presentacion): los constructores de campo y toggle,
  // para que no repitan el marcado, y un repintado para cuando terminan una
  // operación asíncrona propia.
  window.Auxiliar = {
    init: auxInit,
    // Estado del rol, expuesto a propósito: sirve para depurar desde la consola
    // del navegador (el auxiliar corre fuera del shell y no hay panel donde
    // mirarlo) y para que el arnés de pruebas pueda montar escenarios.
    state: auxState,
    rerender: () => auxRender(),
    // Con el shell encendido, el marcado del campo y del interruptor es el del
    // rediseño (AuxRxPedir, mismo contrato); apagado, el de siempre.
    fieldHTML: (label, key, value, ph, type, attrs) => auxField(label, key, value, ph, type, attrs),
    toggleHTML: (label, key, on, hint) => auxToggle(label, key, on, hint),
    // Los pasos se resuelven por NOMBRE (15-sep-2026): el del punto de recogida
    // ya no es siempre el 3, así que los módulos preguntan «¿en qué paso está?»
    // y no «¿está en el 3?».
    stepKind: () => auxStepKind(auxState.step),
    kinds: () => auxStepKinds(),

    // ── Contrato del rediseño (plan final §2.9, 27-sep-2026) ──────────────────
    // P0 dejó los nombres; PL (Ola 1a) llenó los cuerpos. Las pantallas nuevas
    // (aux-rx-*.js) solo usan esto, nunca las funciones aux* sueltas.
    //
    // Pedir. El audio de la celebración solo se desbloquea DENTRO del gesto
    // (iOS): el deslizador llama a AuxCelebracion.prime() en el mismo
    // pointerup/click y pasa {primed:true}; cualquier otro camino lo hace aquí,
    // todavía sincrónico, antes del primer await.
    submit: (opts) => {
      if (!(opts && opts.primed) && window.AuxCelebracion) AuxCelebracion.prime();
      return auxSubmit();
    },
    // Ir a un paso por NOMBRE («Cambiar» del resumen). Pasa por la MISMA
    // entrada al paso que «Continuar» y que «atrás» (#18): al caer en 'nivel'
    // queda un nivel elegido y se pregunta el cupo de la camioneta.
    goStep: (kind) => {
      const i = auxStepKinds().indexOf(kind);
      if (i < 0) return false;
      auxEnterStep(i + 1);
      auxRender();
      return true;
    },
    // El pie del pedido sin rehacer los campos (#17). Con el shell: el de
    // AuxRxPedir (solo disabled/aria). Sin él: el pie de siempre.
    syncCta: (el) => auxSyncCta(el),
    // Estado del pie del pedido, para que la pantalla lo pinte sin repetir la
    // regla: { kind, disabled, label, private, bad }.
    ctaState: () => auxCtaState(),
    // Los avisos del paso del vuelo como DATO (la pantalla elige el marcado):
    //   timeHint()      → {level:'bad'|'warn'|'ok', text} | null
    //   flightAviso(k)  → {level:'bad'|'info', text} | null   (k = 'flight' | 'backFlight')
    timeHint: () => auxTimeHint(),
    flightAviso: (key) => auxFlightAvisoData(key || 'flight'),
    // Abrir un viaje. {rate:true} = el tripulante quiere calificarlo ahora
    // (p. ej. «Calificar» del historial), aunque antes dijera «Ahora no».
    openTrip: (id, opts) => {
      if (!id) return;
      auxState.editingTrip = id; auxState.view = 'trip';
      auxState.ratingSel = 0; auxState.ratingTags = []; auxState.confirmingCancel = false;
      auxState.alarm = null;
      auxState.rateOpen = (opts && opts.rate) ? id : null;
      if (opts && opts.rate) auxRateUnskip(id);
      auxRender();
    },
    // Lo mismo que el botón «Pedir traslado» (data-ax="new"), candados incluidos
    // (suspensión del jefe y pausa por no pago). Devuelve si abrió el pedido.
    newTrip: () => {
      if (auxLockCheck()) return false;
      auxStartNew();
      return true;
    },
    goTab: (tab) => auxGoTab(tab),
    // Atrás de a UNA cosa (plan §2.5). Devuelve true si cerró algo.
    back: () => auxBack(),
    // Pide los viajes otra vez y los FUNDE sobre los mismos objetos (§2.7).
    // opts.silent: sin avisos (lo usa el shell cuando el aviso ya lo dio el push).
    // Devuelve siempre el arreglo de viajes (el mismo de Auxiliar.state.trips).
    reloadTrips: (opts) => auxReloadTrips(opts),
    stopTrack: () => auxStopTrack(),
    afterForm: () => auxAfterFormRender(),
    afterTrip: () => auxAfterTripRender(),
    setupPwa: () => auxSetupPwa(),
    upcoming: () => auxUpcoming(),
    past: () => auxPast(),
    // El criterio ÚNICO de «próximo» (#20): Inicio, Viajes y el soporte usan este.
    isUpcoming: (t) => auxIsUpcoming(t),
    // Pendiente o asignado cuya hora pasó hace más de 6 h sin moverse: va al
    // historial con el chip «Sin realizar».
    expired: (t) => auxExpired(t),
    lastTrip: () => auxLastTrip(),
    typeMeta: (t) => auxTypeMeta(t && typeof t === 'object' ? t.type : t),
    statusMeta: (s) => auxStatusMeta(s),
    lateHTML: (t) => auxLateHTML(t, t && t._info),
    // La demora como dato ({level, text, sub} | null) para pintarla con el aspecto nuevo.
    lateness: (t) => auxLateness(t, t && t._info),
    leadCheck: (f) => auxLeadCheck(f || auxState.form),
    whenISO: (f) => auxWhenISO(f || auxState.form),
    settingsWarnHTML: () => auxSettingsWarnHTML(),
    freshLabel: (pos) => auxFreshLabel(pos),
    // Compartir con el viaje EXPLÍCITO y un texto por fase (#19, §3.7).
    // shareText(t) → el texto o null si en esa fase no hay nada que compartir
    // (la pantalla lo usa para decidir si pinta el botón).
    share: (t) => auxShareEta(t || auxCurTrip()),
    shareText: (t) => auxShareText(t),
    // Regla por defecto de §3.7: sin código no hay nada que mostrar.
    //   salida  → desde «en camino» hasta subir (y «llegó», que es el caso);
    //   llegada → con conductor, el día del viaje (Bogotá), hasta subir.
    meetVisible: (t, info) => auxMeetVisible(t, info),
    // Fases del viaje para #ax-phase (§3.7): {steps:[{key,label}], current, index}.
    // Salida (6): booked · assigned · enroute · arrived · onboard · done.
    // Llegada (5): booked · assigned · onboard · homebound · done.
    phases: (t, info) => auxPhases(t, info || (t && t._info)),
    // ¿Toca la pantalla de calificar para este viaje? (entregado, con
    // conductor, sin calificar y sin «Ahora no», salvo que lo pidiera).
    showRate: (t) => auxShowRate(t),
    // «Ahora no» guardado en el teléfono (localStorage['rendio.aux.rateSkip']).
    rateSkipped: (id) => auxRateSkipped(id),
    suspended: () => typeof auxSuspendido === 'function' && auxSuspendido(),
    // Pausa por no pago (Facturario): solo si AuxPagos existe y lo dice.
    paused: () => auxPagosPausado(),
    // Api.getMyAuxHeader(): aerolínea, desde cuándo, residencias, nivel
    // preferido y punto de encuentro. Lo llena auxInit; null sin dato.
    header: null,
  };

  async function auxInit(profile) {
    auxState.profile = profile;
    auxState.view = 'home';
    auxBindOnce();
    // LOS AJUSTES SE VUELVEN A LEER AQUÍ. core.js los lee UNA vez al entrar a la
    // app y nadie más los refresca en este rol: si el jefe enciende el traslado
    // privado mientras el tripulante tiene la PWA abierta —que es lo normal, no
    // se cierra nunca—, sin esto no lo ve hasta reiniciarla del todo. Y como
    // «Reintentar» vuelve a pasar por auxInit, ese botón ahora sí arregla lo que
    // promete. Si falla, se sigue con lo que ya había: no se pierde nada.
    try {
      if (window.Api?.getSettings && typeof state !== 'undefined') {
        state.settings = await Api.getSettings();
      }
    } catch (_) {}
    // Las siglas de aerolínea van en segundo plano, sin await: la pantalla no
    // puede quedarse esperando por un chip de dos letras. Si llegan tarde, el
    // chip se actualiza solo; si no llegan, está el respaldo.
    auxLoadAerolineas();
    // Modo nocturno antes de pintar: si se aplicara después, la primera pantalla
    // aparece en claro y da un fogonazo blanco a las 3 de la mañana.
    if (window.AuxPresentacion) {
      AuxPresentacion.applyTheme();
      AuxPresentacion.watchTheme();
    }
    // Datos REALES desde dev (reservas del auxiliar); si no hay sesión/BD → demo.
    // La cabecera del rediseño (Auxiliar.header) va en paralelo con los viajes:
    // no agrega espera. Si falla o no existe, queda null y las pantallas lo dicen.
    const pHeader = (window.Api && typeof Api.getMyAuxHeader === 'function')
      ? Promise.resolve().then(() => Api.getMyAuxHeader()).catch(() => null)
      : Promise.resolve(null);
    // Los viajes pasan por la MISMA fusión que el refresco (§2.7): «Reintentar»
    // con la pantalla de un viaje abierta ya no bota el conductor que el
    // rastreo había traído.
    const trips = await auxFetchTrips();
    window.Auxiliar.header = await pHeader;
    // trips === null → no hay sesión de auxiliar o falló la consulta. No se
    // rellena con nada: la pantalla lo dice y ofrece reintentar.
    if (Array.isArray(trips)) { auxMergeTrips(trips); auxState.source = 'live'; }
    else { auxState.trips.length = 0; auxState.source = 'error'; }
    // El refresco cada minuto, al volver a la app y al llegar un push lo lleva
    // el shell (AuxShell.refreshTrips → Auxiliar.reloadTrips). Sin el rediseño
    // no hay refresco solo, como siempre.
    // Primer ingreso: solo si los datos cargaron. Si la app está sin señal, lo
    // primero que tiene que ver es que no hay señal, no un tour de bienvenida.
    // La EXCEPCIÓN es la vista previa local (#preview-auxiliar en localhost, la
    // que arma core.js sin cuenta): ahí nunca hay datos, así que con la regla de
    // arriba las pantallas de bienvenida no se podían ver ni para revisarlas.
    // En vista previa se muestran siempre, aunque ya se hayan visto.
    const enPreview = String(auxState.profile?.id || '').startsWith('preview-');
    if (window.AuxPresentacion && (enPreview || (auxState.source === 'live' && !AuxPresentacion.onboarded()))) {
      auxState.view = 'onboarding'; auxState.onbStep = 0;
    }
    auxRender();
    // El catálogo de residencias se precarga en segundo plano: cuando llegue al
    // paso del punto la lista ya está, sin spinner (y con una sola unidad ese
    // paso ni aparece: el punto se pone solo). Si falla, cae al camino manual.
    if (window.AuxResidencias) AuxResidencias.load();
  }

  // ---------- helpers ----------
  const auxRoot = () => document.getElementById('auxiliar-ui');
  const auxCurTrip = () => auxState.trips.find(x => x.id === auxState.editingTrip);
  const auxFirstName = () => (auxState.profile?.full_name || 'Auxiliar').split(' ')[0];

  // ¿Pinta el rediseño? (bandera de aux-shell.js). Mientras aux-shell.js sea el
  // stub vacío, o la bandera esté en '0', todo va por el camino de siempre.
  function auxShellOn() {
    try { return !!(window.AuxShell && typeof AuxShell.on === 'function' && AuxShell.on()); }
    catch (_) { return false; }
  }
  // Un mensaje corto. Con el rediseño, el toast del shell (1800 ms, rxToast);
  // sin él, el toast de core.js de siempre.
  function auxToast(msg, icon) {
    if (auxShellOn() && typeof AuxShell.toast === 'function') {
      try { AuxShell.toast(msg, icon || 'Check'); return; } catch (_) {}
    }
    if (typeof toast === 'function') toast(msg);
  }

  // ---------- candados para pedir: suspensión (0081) y pausa por no pago ----------
  // La pausa la decide el Facturario (AuxPagos, P12). Sin ese módulo no hay pausa.
  function auxPagosPausado() {
    try { return !!(window.AuxPagos && typeof AuxPagos.paused === 'function' && AuxPagos.paused()); }
    catch (_) { return false; }
  }
  const AUX_SUSP_TXT = 'Tu cuenta está suspendida: no puedes pedir traslados nuevos. Habla con tu jefe.';
  const AUX_PAUSA_TXT = 'Tus reservas están pausadas por un pago pendiente. Revisa Pagos.';
  // La hoja del candado. Con el shell es una hoja (RxSheet del diseño: .rx-sh
  // con su ícono, título, texto y botones) y no un toast que se va en dos
  // segundos: el tripulante tiene que entender por qué no puede pedir. Sin el
  // shell, el toast de siempre. AuxShell.sheet recibe el HTML y {after(el)}.
  function auxLockNotice(kind) {
    const esc = (v) => auxEsc(v);
    const icono = (n) => { try { return window.AuxShell && typeof AuxShell.ic === 'function' ? AuxShell.ic(n, 26) : ''; } catch (_) { return ''; } };
    let html, pagos = false;
    if (kind === 'paused') {
      const s = (() => { try { return window.AuxPagos && AuxPagos.summary ? AuxPagos.summary() : null; } catch (_) { return null; } })();
      // Solo lo que diga el Facturario: sin monto o sin fecha, no se nombran.
      const monto = s && s.amountCOP > 0 ? ` (${auxMoney(s.amountCOP)})` : '';
      const vence = s && s.dueISO ? ` venció el ${auxDateES(String(s.dueISO).slice(0, 10)).replace(',', '')}` : ' está vencido';
      pagos = true;
      html = `<div class="rx-sh">
        <div class="rx-sh-ic blk">${icono('Lock')}</div>
        <h3>Tus reservas están pausadas</h3>
        <p>Tu cobro${esc(monto)}${esc(vence)}. Apenas aprobemos tu comprobante vuelves a reservar. Lo que ya pediste sigue en pie.</p>
        <button class="rx-btn pri" data-pl-lock="pay">Ir a pagos</button>
        <button class="rx-btn ghost" data-pl-lock="close">Ahora no</button>
      </div>`;
    } else {
      const m = auxState.profile && auxState.profile.suspended_reason;
      html = `<div class="rx-sh">
        <div class="rx-sh-ic blk">${icono('Lock')}</div>
        <h3>Tu cuenta está suspendida</h3>
        <p>Los que ya pediste siguen en pie.${m ? ' Motivo: <b>' + esc(m) + '</b>.' : ''} Habla con tu jefe para reactivarla.</p>
        <button class="rx-btn ghost" data-pl-lock="close">Entendido</button>
      </div>`;
    }
    if (auxShellOn() && typeof AuxShell.sheet === 'function') {
      try {
        const el = AuxShell.sheet(html, {
          after: (sh) => sh.addEventListener('click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('[data-pl-lock]') : null;
            if (!b) return;
            auxCloseSheet();
            // Mismo encadenado del diseño (rx-app.jsx): cierra y a los 230 ms cambia de pestaña.
            if (b.getAttribute('data-pl-lock') === 'pay' && pagos) setTimeout(() => auxGoTab('pagos'), 230);
          }),
        });
        if (el) return;
      } catch (_) {}
    }
    auxToast(kind === 'paused' ? AUX_PAUSA_TXT : AUX_SUSP_TXT, 'Lock');
  }
  function auxCloseSheet() {
    try { if (window.AuxShell && typeof AuxShell.closeSheet === 'function') AuxShell.closeSheet(); } catch (_) {}
  }
  // true = había candado (y ya se avisó): quien llama no abre el pedido.
  function auxLockCheck() {
    if (auxSuspendido()) { auxLockNotice('suspended'); return true; }
    if (auxPagosPausado()) { auxLockNotice('paused'); return true; }
    return false;
  }
  function auxMoney(v) {
    try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v); }
    catch (_) { return '$ ' + v; }
  }
  // `from`/`to` y sus iconos (15-sep-2026, profa): el paso 1 y el resumen dicen
  // «Casa → Aeropuerto» con dibujos, no solo «Salida». `label` corto se queda
  // para los chips de las tarjetas y el «Tu salida quedó…», donde no cabe más.
  function auxTypeMeta(type) {
    return type === 'lle'
      ? { cls: 'a2h', label: 'Llegada', ic: 'i-down', desc: 'Del aeropuerto a casa',
          from: 'Aeropuerto', to: 'Casa', icFrom: 'i-plane', icTo: 'i-home' }
      : { cls: 'h2a', label: 'Salida', ic: 'i-up', desc: 'De casa al aeropuerto',
          from: 'Casa', to: 'Aeropuerto', icFrom: 'i-home', icTo: 'i-plane' };
  }
  // La ruta con iconos: casa → avión (salida) o avión → casa (llegada). Es un
  // <span> inline para poder vivir dentro del <b> del título de la tarjeta.
  function auxRouteHTML(m) {
    return `<span class="ax-route"><svg class="icon"><use href="#${m.icFrom}"/></svg>${m.from}`
      + `<svg class="icon ax-route-arw"><use href="#i-arrow"/></svg>`
      + `<svg class="icon"><use href="#${m.icTo}"/></svg>${m.to}</span>`;
  }
  const auxHM = (t) => t || '--:--';
  function auxDateES(iso) {
    try { return new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (_) { return iso; }
  }
  // AQUÍ VIVÍA auxSuggestPickup (presentación − 1 h). Se eliminó el 3-sep-2026:
  // era la única fuente de las dos horas de recogida que la app prometía antes
  // de que existiera ruta. No se vuelve a poner sin una hora que venga del
  // asignador.

  // ---------- render raíz ----------
  function auxRender() {
    // Un nivel que se puso SOLO (preferencia del perfil) no puede quedar en
    // privado si la camioneta resultó comprometida a esa hora.
    auxNivelFix();
    // REDISEÑO 27-sep-2026 (estrangulador con bandera): con el shell nuevo
    // encendido, pinta él y decide si desmonta el rastreo (por eso va ANTES de
    // auxStopTrack). Apagado —o sin aux-shell.js— todo sigue exactamente igual.
    if (auxShellOn()) { AuxShell.render(); return; }
    const root = auxRoot(); if (!root) return;
    auxStopTrack(); // limpia animaciones de mapa al cambiar de vista
    // Primer ingreso: ocupa la pantalla entera, sin nav ni encabezado.
    if (auxState.view === 'onboarding') {
      const P = window.AuxPresentacion;
      root.innerHTML = !P ? '' : (auxState.onbStep >= P.slideCount ? P.notifyHTML() : P.slideHTML(auxState.onbStep));
      // Deslizar entre pantallas. Se ata aquí porque el HTML se acaba de rehacer.
      if (P && P.bindSwipe) {
        P.bindSwipe(root,
          () => { auxState.onbStep = Math.min(P.slideCount, auxState.onbStep + 1); auxRender(); },
          () => { if (auxState.onbStep > 0) { auxState.onbStep--; auxRender(); } });
      }
      return;
    }
    if (auxState.view === 'form') { root.innerHTML = auxFormHTML(); auxAfterFormRender(); return; }
    if (auxState.view === 'confirm') {
      root.innerHTML = auxConfirmHTML();
      // El sonido del aterrizaje se programa DESPUÉS de pintar: la escena ya
      // está en el DOM y el módulo decide (por id) si este traslado ya sonó.
      if (window.AuxCelebracion) AuxCelebracion.afterRender(auxCurTrip());
      return;
    }
    if (auxState.view === 'trip') { root.innerHTML = auxTripHTML(); auxAfterTripRender(); return; }
    if (auxState.view === 'viajes') { root.innerHTML = auxViajesHTML(); return; }
    if (auxState.view === 'perfil') { root.innerHTML = auxPerfilHTML(); auxSetupPwa(); return; }
    if (auxState.view === 'privado') {
      root.innerHTML = window.AuxPrivado ? AuxPrivado.introHTML(auxState.form) : '';
      return;
    }
    if (auxState.view === 'support') {
      root.innerHTML = window.AuxPresentacion
        ? AuxPresentacion.supportHTML(auxUpcoming().length > 0) : '';
      return;
    }
    root.innerHTML = auxHomeHTML();
    auxSetupPwa();
  }

  // Botones PWA del auxiliar (su UI va aparte del shell admin/conductor, así que el
  // setupPushUI del core NO lo cubre): muestra "Instalar app" si es instalable y
  // "Activar notificaciones" si el push está soportado y aún no se ha suscrito.
  async function auxSetupPwa() {
    const bar = document.getElementById('ax-pwa-bar'); if (!bar) return;
    const ins = bar.querySelector('[data-ax="install"]');
    const psh = bar.querySelector('[data-ax="enable-push"]');
    const canInstall = !!window.rendioInstall; // solo existe si NO está ya instalada (standalone)
    if (ins) ins.classList.toggle('hidden', !canInstall);
    let showPush = false;
    try {
      if (typeof pushSupported === 'function' && pushSupported() && Notification.permission !== 'denied') {
        const reg = await navigator.serviceWorker.ready;
        showPush = !(await reg.pushManager.getSubscription());
      }
    } catch (e) {}
    if (psh) psh.classList.toggle('hidden', !showPush);
    bar.classList.toggle('hidden', !canInstall && !showPush);
  }

  // ---------- HOME (Mis viajes) ----------
  // Un viaje está CERRADO si terminó, lo cancelaron o no se presentó: esos van
  // al historial, no a "próximos" (antes un cancelado seguía saliendo arriba).
  const AUX_CLOSED = ['done', 'cancelled', 'noshow'];
  // UN SOLO criterio de «próximo» (#20, 27-sep-2026). Antes era «no cerrado»,
  // así que un pedido de hace tres días que nadie ruteó seguía saliendo como
  // «Próximo viaje» en Inicio para siempre. Ahora es próximo si no está
  // cerrado Y (va en curso, o su hora no pasó hace más de 6 h). Las 6 h dan
  // aire a un vuelo que se atrasó o a un conductor que marca tarde.
  const AUX_UPCOMING_GRACE_MS = 6 * 3600000;
  function auxIsUpcoming(t) {
    if (!t || AUX_CLOSED.includes(t.status)) return false;
    if (t.status === 'onway' || t.status === 'onboard') return true;
    const ts = auxWhenTs(t);
    // Sin fecha/hora no se puede decir que venció: se deja como próximo.
    return ts == null || ts >= Date.now() - AUX_UPCOMING_GRACE_MS;
  }
  // Ni cerrado ni próximo: se quedó sin realizar (va al historial).
  const auxExpired = (t) => !!t && !AUX_CLOSED.includes(t.status) && !auxIsUpcoming(t);
  // Orden estable por hora. Los que no tienen hora van al final en los dos casos.
  function auxSortByTime(list, desc) {
    const key = (t) => { const v = auxWhenTs(t); return v == null ? null : v; };
    return list.map((t, i) => [t, key(t), i]).sort((a, b) => {
      if (a[1] == null || b[1] == null) return (a[1] == null) - (b[1] == null) || a[2] - b[2];
      return (desc ? b[1] - a[1] : a[1] - b[1]) || a[2] - b[2];
    }).map(x => x[0]);
  }
  // Próximos del más cercano al más lejano (un pedido recién hecho entra
  // adelante en el arreglo aunque sea para la otra semana: se ordena por hora).
  const auxUpcoming = () => auxSortByTime(auxState.trips.filter(auxIsUpcoming), false);
  // Historial del más reciente al más viejo.
  const auxPast = () => auxSortByTime(auxState.trips.filter(t => !auxIsUpcoming(t)), true);

  // La app no pudo leer la configuración de la operación (app_settings). Pasa
  // sin sesión: la consulta responde cero filas por RLS y api.js cae a los
  // valores de arranque, entre ellos «privado apagado». Sin este aviso, el
  // tripulante ve una app COMPLETA a la que le faltan opciones en silencio —
  // que fue justo lo que pasó al probar el flujo el 7-sep-2026: el paso del
  // traslado privado no salía y nada decía por qué.
  function auxSettingsWarnHTML() {
    const s = (typeof state !== 'undefined') ? state.settings : null;
    if (!s || s._loaded !== false) return '';
    return `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>
      No pudimos leer la configuración de la operación, así que la app está mostrando lo mínimo:
      pueden faltarte opciones (por ejemplo, el traslado privado). Suele ser la sesión — vuelve a entrar.</div>`;
  }

  // Suspendido por el jefe (0081): entra y ve sus viajes, pero no pide nuevos.
  // Los que ya pidió se respetan (C8). La base también lo frena.
  function auxSuspendido() { return !!(auxState.profile && auxState.profile.is_active === false); }
  function auxSuspendidoHTML() {
    if (!auxSuspendido()) return '';
    const m = auxState.profile.suspended_reason;
    return `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>
      <span>Tu cuenta está suspendida: no puedes pedir traslados nuevos. Los que ya pediste siguen en pie.
      ${m ? `<br>Motivo: ${escapeHtml(m)}` : ''}<br>Habla con tu jefe para reactivarla.</span></div>`;
  }

  function auxHomeHTML() {
    const upcoming = auxUpcoming();
    const past = auxPast();
    const next = upcoming[0];
    return `
      <div class="ax-head">
        <div>
          <p class="ax-hi">Hola, ${auxFirstName()} 👋</p>
          <h1>Mis viajes</h1>
        </div>
        <button class="ax-avatar" data-ax="profile" title="Perfil">${(auxFirstName()[0] || 'A').toUpperCase()}</button>
      </div>
      <div class="ax-body">
        <div id="ax-pwa-bar" class="ax-pwa hidden">
          <button class="ax-pwa-btn hidden" data-ax="install">📲 Instalar app</button>
          <button class="ax-pwa-btn hidden" data-ax="enable-push">🔔 Activar notificaciones</button>
        </div>
        ${auxSettingsWarnHTML()}
        ${auxSuspendidoHTML()}
        ${auxState.source === 'error' ? `
          <div class="ax-empty">
            <div class="ax-empty-ic"><svg class="icon"><use href="#i-info"/></svg></div>
            <b>No pudimos cargar tus viajes</b><span>Lo que ya pediste está guardado en nuestros servidores, no en el teléfono: no se perdió. Revisa tu conexión y reintenta. Si sigue igual, avisa a coordinación: puede que tu usuario aún no esté registrado como auxiliar.</span>
            <button class="ax-btn ax-btn-ghost" data-ax="reload"><svg class="icon"><use href="#i-refresh"/></svg>Reintentar</button>
          </div>`
        : next ? `<div class="ax-next-label">Próximo viaje</div>${auxTripCard(next, true)}` : `
          <div class="ax-empty">
            <div class="ax-empty-ic"><svg class="icon"><use href="#i-plane"/></svg></div>
            <b>Pide tu primer traslado</b><span>Dinos el vuelo y de dónde sales. Nosotros armamos la ruta y te asignamos conductor.</span>
          </div>`}
        ${auxSuspendido() ? '' : auxRepeatHTML()}
        ${upcoming.length > 1 ? `<div class="ax-sec">Más próximos</div>${upcoming.slice(1).map(t => auxTripCard(t)).join('')}` : ''}
        ${past.length ? `<div class="ax-sec">Anteriores</div>${past.slice(0, 3).map(t => auxTripCard(t)).join('')}` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar with-tabs">
        <button class="ax-btn ax-btn-primary" data-ax="new" ${auxSuspendido() ? 'disabled' : ''}><svg class="icon"><use href="#i-plus"/></svg>Pedir traslado</button>
      </div>
      ${auxTabsHTML('inicio')}`;
  }

  // «Repetir el de siempre» (pilar I de la entrega: anticipar).
  //
  // Honesto sobre qué repite y qué no: el TIPO y el PUNTO se repiten, porque son
  // los que casi nunca cambian. El vuelo, la fecha y la hora NO se adivinan —
  // son distintos cada vez y equivocarlos manda un carro un día que no es. Así
  // que esto no crea la reserva de un toque: salta al paso 2 con lo estable ya
  // puesto. Ahorra dos pasos de cinco, sin inventar ninguno.
  function auxLastTrip() {
    // El ÚLTIMO por hora, no por posición en el arreglo (el orden del arreglo
    // cambia cuando se pide uno nuevo o llega un refresco).
    let last = null, lastTs = -Infinity;
    auxState.trips.forEach(t => {
      if (t.status !== 'done') return;
      const ts = auxWhenTs(t); const v = ts == null ? -Infinity : ts;
      if (!last || v >= lastTs) { last = t; lastTs = v; }
    });
    return last;
  }
  // Lo que se copia al repetir: solo lo que escribió el tripulante.
  // Un solo helper en todo el front (fase 0.10): Api.notesUser. El cuerpo de
  // abajo queda solo de respaldo si api.js no cargó (misma expresión).
  function auxRepeatNotes(n) {
    if (window.Api && typeof Api.notesUser === 'function') return Api.notesUser(n);
    return String(n || '')
      .replace(/^\s*vuelo\s*:?\s*[A-Za-z]{0,3}\s*-?\s*\d{2,5}\.\s*/i, '')
      .replace(/\s*·\s*Regreso del mismo día\s*$/i, '')
      .trim();
  }
  function auxRepeatHTML() {
    const t = auxLastTrip(); if (!t) return '';
    const m = auxTypeMeta(t.type);
    return `
      <div class="ax-sec">Más rápido</div>
      <button class="axq" data-ax="repeat">
        <span class="axq-ic"><svg class="icon"><use href="#${m.ic}"/></svg></span>
        <span class="axq-txt">
          <b>Repetir el de siempre</b>
          <span>${m.label} · ${auxShortAddr(t.address)}</span>
        </span>
        <svg class="icon axr-chev"><use href="#i-chev"/></svg>
      </button>`;
  }

  // ---------- VIAJES (pestaña 2): historial completo ----------
  function auxViajesHTML() {
    const upcoming = auxUpcoming(), past = auxPast();
    return `
      <div class="ax-head"><div><p class="ax-hi">Tu historial</p><h1>Viajes</h1></div></div>
      <div class="ax-body">
        ${upcoming.length ? `<div class="ax-sec">Próximos</div>${upcoming.map(t => auxTripCard(t)).join('')}` : ''}
        ${past.length ? `<div class="ax-sec">Anteriores</div>${past.map(t => auxTripCard(t)).join('')}` : ''}
        ${!upcoming.length && !past.length ? `
          <div class="ax-empty">
            <div class="ax-empty-ic"><svg class="icon"><use href="#i-list"/></svg></div>
            <b>Todavía no hay nada</b><span>Cuando pidas un traslado aparecerá aquí.</span>
          </div>` : ''}
        <div class="ax-spacer"></div>
      </div>
      ${auxTabsHTML('viajes')}`;
  }

  // ---------- PERFIL (pestaña 3): datos, notificaciones y CERRAR SESIÓN ----------
  // Hasta ahora el auxiliar no tenía ninguna forma de salir de la app: su UI va
  // fuera del shell admin/conductor, así que no heredaba el botón de logout.
  function auxPerfilHTML() {
    const p = auxState.profile || {};
    const done = auxState.trips.filter(t => t.status === 'done').length;
    return `
      <div class="ax-head"><div><p class="ax-hi">Tu cuenta</p><h1>Perfil</h1></div></div>
      <div class="ax-body">
        <div class="ax-prof-card">
          <span class="ax-driver-av lg">${(auxFirstName()[0] || 'A').toUpperCase()}</span>
          <div><b>${p.full_name || 'Auxiliar'}</b><span>${p.email || ''}</span></div>
        </div>
        <div class="ax-sum">
          ${p.phone ? `<div class="ax-sum-row"><span>Teléfono</span><b>${p.phone}</b></div>` : ''}
          <div class="ax-sum-row"><span>Viajes completados</span><b>${done}</b></div>
          <div class="ax-sum-row"><span>Rol</span><b>Auxiliar de vuelo</b></div>
        </div>
        <div class="ax-sec">Apariencia</div>
        ${window.AuxPresentacion ? AuxPresentacion.themeHTML() : ''}
        ${window.AuxPresentacion ? `
        <button class="axs-ch" data-ax="onb-again">
          <span class="axs-ch-ic"><svg class="icon"><use href="#i-play"/></svg></span>
          <span class="axs-ch-txt"><b>Ver la bienvenida otra vez</b><span>Las tres pantallas del primer día.</span></span>
          <svg class="icon axr-chev"><use href="#i-chev"/></svg>
        </button>` : ''}
        <div class="ax-sec">App</div>
        <div id="ax-pwa-bar" class="ax-pwa hidden">
          <button class="ax-pwa-btn hidden" data-ax="install">📲 Instalar app</button>
          <button class="ax-pwa-btn hidden" data-ax="enable-push">🔔 Activar notificaciones</button>
        </div>
        <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Con las notificaciones activadas te avisamos cuando te asignen conductor y cuando esté por llegar.</div>
        <div class="ax-sec">Ayuda</div>
        <button class="axs-ch" data-ax="support">
          <span class="axs-ch-ic"><svg class="icon"><use href="#i-info"/></svg></span>
          <span class="axs-ch-txt"><b>Algo no va bien</b><span>Qué hacer según lo que esté pasando.</span></span>
          <svg class="icon axr-chev"><use href="#i-chev"/></svg>
        </button>
        <div class="ax-sec">Cuenta</div>
        <button class="axs-ch" data-ax="change-pw">
          <span class="axs-ch-ic"><svg class="icon"><use href="#i-lock"/></svg></span>
          <span class="axs-ch-txt"><b>Cambiar mi contraseña</b><span>Te pedimos la actual.</span></span>
          <svg class="icon axr-chev"><use href="#i-chev"/></svg>
        </button>
        <button class="ax-btn ax-btn-ghost ax-danger" data-ax="logout"><svg class="icon"><use href="#i-exit"/></svg>Cerrar sesión</button>
        <div class="ax-spacer"></div>
      </div>
      ${auxTabsHTML('perfil')}`;
  }

  function auxTripCard(t, hero) {
    const m = auxTypeMeta(t.type);
    // Un pendiente que ya pasó no está «Sin rutear»: se quedó sin realizar.
    const st = auxExpired(t) ? { cls: 'muted', label: 'Sin realizar' } : auxStatusMeta(t.status);
    return `<button class="ax-trip ${hero ? 'hero' : ''}" data-ax="trip" data-id="${t.id}">
      <div class="ax-trip-top">
        <span class="ax-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label}</span>
        ${window.AuxPrivado ? AuxPrivado.chipHTML(t) : ''}
        <span class="ax-status ${st.cls}">${st.label}</span>
      </div>
      <div class="ax-trip-mid">
        <div class="ax-trip-route">
          <b>${t.type === 'lle' ? 'MDE' : auxShortAddr(t.address)}</b>
          <svg class="icon ax-arrow"><use href="#i-arrow"/></svg>
          <b>${t.type === 'lle' ? auxShortAddr(t.address) : 'MDE'}</b>
        </div>
      </div>
      <div class="ax-trip-bot">
        <span><svg class="icon"><use href="#i-clock"/></svg>${auxDateES(t.date)} · ${t.type === 'lle' ? 'llega' : 'en MDE'} ${auxHM(t.time)}</span>
        <span class="ax-flight">${t.flight || ''}</span>
      </div>
    </button>`;
  }
  function auxShortAddr(a) { return (a || '').split(',')[0]; }
  function auxStatusMeta(s) {
    return ({
      pending:  { cls: 'warn', label: 'Sin rutear' },
      assigned: { cls: 'ok',   label: 'Conductor asignado' },
      onway:    { cls: 'ok',   label: 'En camino' },
      onboard:  { cls: 'ok',   label: 'A bordo' },
      done:     { cls: 'muted',label: 'Completado' },
      cancelled:{ cls: 'muted',label: 'Cancelado' },
      noshow:   { cls: 'warn', label: 'No te presentaste' },
    })[s] || { cls: 'muted', label: s };
  }
  // Estado crudo de la reserva (BD) → estado simple de la UI. Espejo de
  // api.js/_auxTripStatus; lo usa el rastreo en vivo para avanzar de pantalla.
  const AUX_ORDER = { pending: 0, assigned: 1, onway: 2, onboard: 3, done: 4 };
  function auxUiStatus(raw) {
    if (['assigned', 'driver_assigned', 'ready'].includes(raw)) return 'assigned';
    if (['en_route', 'at_pickup'].includes(raw)) return 'onway';
    if (['on_board', 'picked_up', 'en_route_home'].includes(raw)) return 'onboard';
    if (raw === 'delivered') return 'done';
    return 'pending';
  }

  // ¿El viaje va tarde? SIN ETA de OSRM (decisión de la profa): usamos la regla
  // operativa real (recogida ~1h antes de la presentación en salidas) + el estado
  // real de la parada. Es honesto: mide contra el horario, no inventa un ETA vivo.
  // B2 · La escala de demora, medida contra la PRESENTACIÓN.
  //
  // El cambio de la entrega: «El retraso del carro no es su problema: su problema
  // es el vuelo». Antes esta función decía "el conductor va sobre el tiempo de
  // recogida", que es un dato de la operación, no del pasajero — a él le sirve
  // saber si alcanza o no, con un número.
  //
  // Cuatro niveles con el umbral del diseñador (≥20 / 10–19 / <10 / negativo).
  // El MARGEN solo se pinta cuando es un dato real:
  //   · a bordo y con ETA de OSRM al destino → margen exacto. Es el momento en
  //     que la pregunta importa y el único en que tenemos la llegada estimada.
  //   · con el vigilante (0053) diciendo cuántos minutos va demorado el carro →
  //     se informa el retraso, sin inventar un margen: no tenemos guardado con
  //     cuánta holgura se planeó cada traslado.
  //   · sin ninguno de los dos → solo el reloj, como antes, pero apuntando a la
  //     presentación y sin prometer un número.
  //
  // PENDIENTE del lado de la operación (no es de esta pantalla): la regla del
  // diseñador de «no empujar aviso por debajo de 10 min de retraso real» vive en
  // el vigilante de 0053, que es quien manda el push. Aquí solo se muestra.
  const AUX_MARGIN_OK = 20, AUX_MARGIN_TIGHT = 10;

  function auxMarginLevel(min) {
    if (min < 0) return 'miss';
    if (min < AUX_MARGIN_TIGHT) return 'tight';
    if (min < AUX_MARGIN_OK) return 'margin';
    return 'ok';
  }
  // Segundos que faltan para llegar AL DESTINO según el último cálculo de OSRM,
  // descontando lo corrido desde entonces. null si no hay ETA vivo al destino
  // (solo existe a bordo: yendo a recogerte el ETA es hasta tu puerta, no hasta
  // el aeropuerto). Va aparte para poder probar la escala sin un mapa andando.
  function auxLiveEtaSecs() {
    if (auxState.etaKind !== 'dest' || !auxState.etaSecs || !auxState.etaAt) return null;
    return auxState.etaSecs - (Date.now() - auxState.etaAt) / 1000;
  }
  function auxLateness(t, info) {
    if (!t || !['assigned', 'onway', 'onboard'].includes(t.status)) return null;
    const t0 = new Date(t.date + 'T' + (t.time || '00:00') + ':00-05:00').getTime();
    if (isNaN(t0)) return null;
    const now = Date.now(), MIN = 60000;

    // ── 1. Margen exacto: a bordo, rumbo al aeropuerto, con ETA vivo ──
    const restan = (t.type === 'sal' && t.status === 'onboard') ? auxLiveEtaSecs() : null;
    if (restan != null) {
      const margen = Math.round((t0 - (now + restan * 1000)) / MIN);
      const level = auxMarginLevel(margen);
      if (level === 'miss') {
        return { level, text: 'No alcanzas tu hora en el aeropuerto.',
          sub: 'Coordinación ya está en esto y va a contactarte.' };
      }
      const cuanto = `${margen} min antes de tu hora en el aeropuerto`;
      if (level === 'tight') return { level, text: 'Vas muy justo, pero llegas', sub: cuanto + '.' };
      if (level === 'margin') return { level, text: 'Vas justo, pero llegas', sub: cuanto + '.' };
      return { level: 'ok', text: 'Vas a tiempo', sub: 'Llegas ' + cuanto + '.' };
    }

    if (info && info.stop_status === 'picked_up' && t.status !== 'onboard') return null;

    // ── 2. El vigilante (0053): retraso real del carro, sin margen inventado ──
    if (t._risk && t._risk.minutes_late > 0) {
      const m = t._risk.minutes_late;
      const level = m >= AUX_MARGIN_OK ? 'miss' : m >= AUX_MARGIN_TIGHT ? 'tight' : 'margin';
      return {
        level,
        text: `Tu conductor va ~${m} min demorado`,
        sub: level === 'miss'
          ? 'Coordinación ya está en esto y va a contactarte.'
          : 'Ya lo sabemos y estamos pendientes de que alcances tu vuelo.',
      };
    }

    // ── 3. Solo el reloj ──
    if (t.type === 'sal') {
      // Con la hora de recogida PUBLICADA (0085) se mide contra ella; sin plan,
      // la regla operativa de siempre (~1 h antes de la hora en MDE).
      const pub = t.pickupAt ? Date.parse(t.pickupAt) : NaN;
      const pickupBy = !isNaN(pub) ? pub : t0 - 60 * MIN;
      if (now > t0)       return { level: 'miss',   text: 'Pasó la hora a la que querías estar en el aeropuerto.', sub: 'Si sigues sin salir, avisa a coordinación.' };
      if (now > pickupBy) return { level: 'tight',  text: 'Vas sobre el tiempo.', sub: 'Deberías estar saliendo ya hacia el aeropuerto.' };
      if (now > pickupBy - 15 * MIN) return { level: 'margin', text: 'Se acerca tu recogida.', sub: 'Mantente atento: falta poco.' };
      return { level: 'ok', text: 'Vas a tiempo.' };
    }
    // llegada: ya aterrizaste; el conductor viene a recogerte. No hay
    // presentación que perder, así que no hay margen que medir.
    if (now > t0 + 15 * MIN) return { level: 'margin', text: 'El conductor va en camino a recogerte.' };
    return { level: 'ok', text: 'A tiempo.' };
  }
  function auxLateHTML(t, info) {
    const l = auxLateness(t, info); if (!l) return '';
    const ic = l.level === 'ok' ? 'i-check' : l.level === 'miss' ? 'i-warn' : 'i-info';
    return `<div class="ax-late ${l.level}"><svg class="icon"><use href="#${ic}"/></svg><span>${l.text}${
      l.sub ? `<span class="ax-late-sub">${l.sub}</span>` : ''}</span></div>`;
  }
  function auxRefreshLate(t) {
    const el = document.getElementById('ax-late-wrap'); if (el) el.innerHTML = auxLateHTML(t, t._info);
  }

  // ---------- tabs inferiores ----------
  function auxTabsHTML(active) {
    const tab = (id, ic, label) => `<button class="ax-tab ${active === id ? 'on' : ''}" data-ax="tab" data-tab="${id}">
      <svg class="icon"><use href="#${ic}"/></svg><span>${label}</span></button>`;
    return `<nav class="ax-tabs">${tab('inicio', 'i-home', 'Inicio')}${tab('viajes', 'i-list', 'Viajes')}${tab('perfil', 'i-user', 'Perfil')}</nav>`;
  }

  // ---------- FORMULARIO (3 a 5 pasos) ----------
  // ¿Hace falta preguntar dónde? (profa, 15-sep-2026: «Dónde te recogemos» SOLO
  // si hay dos unidades). Con una sola, el punto del registro se pone solo y el
  // paso no existe: preguntarle a 64 de los 102 tripulantes algo que ya
  // contestaron al registrarse era el paso que más sobraba del pedido.
  // Sigue existiendo cuando de verdad hay algo que decidir o que decir:
  function auxNeedsDonde(f) {
    const R = window.AuxResidencias;
    if (!R) return true;
    if (f.manualAddr || f.dondeForced) return true;      // camino manual o el tripulante pidió cambiar
    if (R.loading() || !R.hasCatalog()) return true;     // sin catálogo: el paso avisa y ofrece reintentar
    if (R.hasTwoUnits()) return true;                    // dos unidades → elige él
    R.autofill(f);                                       // una unidad: el punto se pone solo
    return !f.residenceId;                               // sin punto guardado no hay de dónde sacarlo → se pregunta
  }
  // La lista de pasos, por NOMBRE. Se recalcula cada vez porque depende del
  // formulario (dos unidades, camino manual) y de Ajustes (el privado, 0069):
  // sin privado, el paso de nivel no existe — no se le muestra a nadie una
  // elección de un solo elemento.
  function auxStepKinds() {
    const k = ['tipo', 'vuelo'];
    if (auxNeedsDonde(auxState.form)) k.push('donde');
    // El paso del nivel existe aunque el privado todavía no se pueda pedir: en
    // ese caso la tarjeta va apagada y sirve de primicia (ver aux-privado.js).
    if (window.AuxPrivado && AuxPrivado.stepHTML) k.push('nivel');
    k.push('revisar');
    return k;
  }
  function auxSteps() { return auxStepKinds().length; }
  // Qué pide el paso `s`. Fuera de rango cae en 'revisar': el número del último
  // paso cambia y nunca puede quedar un paso «vacío».
  function auxStepKind(s) { return auxStepKinds()[s - 1] || 'revisar'; }
  function auxFormHTML() {
    const n = auxSteps();
    // Si un paso desapareció por debajo (el catálogo llegó y puso el punto solo
    // mientras se miraba el spinner), el número se acomoda al último que hay.
    if (auxState.step > n) auxState.step = n;
    const s = auxState.step, kind = auxStepKind(s);
    const isLle = auxState.form.type === 'lle';
    const titles = {
      tipo: '¿Qué necesitas?', vuelo: 'Datos del vuelo',
      donde: isLle ? 'Dónde te dejamos' : 'Dónde te recogemos',
      nivel: '¿Cómo quieres viajar?', revisar: 'Revisa y confirma',
    };
    const dots = [];
    for (let i = 1; i <= n; i++) dots.push(`<span class="ax-dot ${i <= s ? 'on' : ''}"></span>`);
    const cuerpo = kind === 'tipo' ? auxStep1()
      : kind === 'vuelo' ? auxStep2()
      : kind === 'donde' ? auxStep3()
      : kind === 'nivel' ? (window.AuxPrivado ? (AuxPrivado.stepHTML(auxState.form) || '') : '')
      : auxStep4();
    return `
      <div class="ax-form-head">
        <button class="ax-icbtn" data-ax="${s === 1 ? 'cancel' : 'back'}"><svg class="icon"><use href="#${s === 1 ? 'i-x' : 'i-back'}"/></svg></button>
        <div class="ax-steps">${dots.join('')}</div>
        <span class="ax-step-n">${s}/${n}</span>
      </div>
      <div class="ax-body">
        <h1 class="ax-form-title">${titles[kind]}</h1>
        ${cuerpo}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">${auxFormCTA()}</div>`;
  }

  function auxStep1() {
    const opt = (type) => {
      const m = auxTypeMeta(type);
      const sel = auxState.form.type === type;
      // El tile pinta A DÓNDE va (avión en la salida, casa en la llegada) y el
      // título la ruta entera con iconos; el subtítulo sigue diciendo lo mismo
      // de siempre, que es lo que de verdad distingue los dos.
      return `<button class="ax-opt ${m.cls} ${sel ? 'sel' : ''}" data-ax="type" data-type="${type}">
        <span class="ax-opt-ic"><svg class="icon"><use href="#${m.icTo}"/></svg></span>
        <div><b>${auxRouteHTML(m)}</b><span>${type === 'lle' ? 'Vengo aterrizando de un vuelo' : 'Voy al aeropuerto a operar un vuelo'}</span></div>
        <span class="ax-radio">${sel ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
      </button>`;
    };
    return `<p class="ax-lead">Elige el tipo de traslado.</p>${opt('sal')}${opt('lle')}
      <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Si tu vuelo incluye pernocta, lo marcas en el siguiente paso, con los datos del vuelo.</div>`;
  }

  // Momento del vuelo en hora de Colombia (o null si aún falta un dato).
  function auxWhenTs(f) {
    if (!f.date || !f.time) return null;
    const t = new Date(f.date + 'T' + f.time + ':00-05:00').getTime();
    return isNaN(t) ? null : t;
  }
  // El momento comprometido en ISO, que es como lo espera el servidor para
  // preguntar si la camioneta está libre en esa franja.
  function auxWhenISO(f) {
    const ts = auxWhenTs(f);
    return ts == null ? null : new Date(ts).toISOString();
  }
  // Reglas de tiempo del pedido. Antes no había ninguna: se podía pedir un
  // traslado para ayer, o para dentro de 10 minutos, y la app contestaba
  // "quedó en la planeación del día" tan tranquila.
  //   pasado  → se bloquea (es un error, no una urgencia)
  //   corto   → se avisa pero se PERMITE: la operación real tiene urgencias.
  function auxLeadCheck(f) {
    const ts = auxWhenTs(f); if (ts == null) return null;
    // `state` es un const de script (no vive en window): se lee directo.
    const lead = (typeof state !== 'undefined' && state.settings?.aux_min_lead_hours != null)
      ? state.settings.aux_min_lead_hours : 6;
    const hrs = (ts - Date.now()) / 3600000;
    if (hrs < 0) return { level: 'bad', text: 'Esa fecha y hora ya pasaron. Revísalas.' };
    if (lead > 0 && hrs < lead) return { level: 'warn', text: `Estás pidiendo con menos de ${lead} h de anticipación. Lo recibimos, pero puede que no alcance a entrar en la planeación — avisa también al coordinador.` };
    return null;
  }
  function auxTodayISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  }
  // Un día corrido en hora de Colombia (0 = hoy, 1 = mañana...). Se cuenta sobre
  // el ISO de Bogotá, no sobre el reloj del teléfono: un tripulante que aterriza
  // de un internacional trae el aparato en otra zona y "mañana" no es el mismo.
  function auxDayISO(n) {
    const [y, m, d] = auxTodayISO().split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }
  // LA FECHA ARRANCA EN MAÑANA (profa, 7-sep-2026): "esto lo llena diariamente,
  // debería autoasignarse al día siguiente". El pedido normal es para el vuelo
  // de mañana — y el de hoy casi siempre viola las 6 h de anticipación, así que
  // dejar el campo vacío obligaba a escribir todos los días la única fecha que
  // la app podía haber puesto sola. Sigue siendo un campo editable: los atajos
  // de abajo y el calendario nativo cambian el día en un toque.
  const auxDefaultDate = () => auxDayISO(1);
  // Los tres días que cubren casi todos los pedidos, más el calendario para el
  // resto. El elegido se pinta encendido, así que la fecha puesta por defecto
  // se VE (si se pusiera calladamente, el auxiliar no sabría que va a pedir
  // para mañana hasta el resumen del último paso).
  function auxDateChips(f) {
    const hoy = auxTodayISO();
    const dias = [
      { iso: hoy, label: 'Hoy' },
      { iso: auxDayISO(1), label: 'Mañana' },
      { iso: auxDayISO(2), label: 'Pasado' },
    ];
    const otro = f.date && !dias.some(d => d.iso === f.date);
    return `
      <div class="ax-daychips">
        ${dias.map(d => `<button class="ax-daychip${f.date === d.iso ? ' on' : ''}" data-ax="date" data-iso="${d.iso}">
          <b>${d.label}</b><span>${auxDateCorto(d.iso)}</span></button>`).join('')}
        ${otro ? `<span class="ax-daychip on otro"><b>Otro día</b><span>${auxDateCorto(f.date)}</span></span>` : ''}
      </div>`;
  }
  function auxDateCorto(iso) {
    try { return new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }); }
    catch (_) { return iso; }
  }

  function auxStep2() {
    const isLle = auxState.form.type === 'lle';
    const f = auxState.form;
    return `
      ${/* SOLO EL VUELO DE LLEGADA (Julián, 25-ago-2026): "omitir ese primer
           número de vuelo, realmente solo nos interesa saber el vuelo de
           llegada". En una salida el número de ida no se usa para nada — lo que
           manda es a qué hora tiene que estar en MDE. En una llegada este mismo
           campo SÍ es el vuelo que aterriza, y ahí es obligatorio: es el que se
           rastrea cuando el avión se retrasa. */ ''}
      ${isLle ? auxFlightField('Número de vuelo', 'flight', '9412') : ''}
      ${auxField('Fecha del vuelo', 'date', f.date || '', '', 'date', `min="${auxTodayISO()}"`)}
      ${auxDateChips(f)}
      ${auxField(isLle ? 'Hora de aterrizaje' : 'Hora en que quieres estar en el aeropuerto',
        'time', f.time || '', isLle ? '06:18' : '05:10', 'time')}
      ${isLle ? '' : `<div class="ax-geo-hint">No es tu hora de presentación: es a qué hora quieres estar allá. Nosotros calculamos a qué hora pasa el carro.</div>`}
      <div id="ax-time-hints">${auxTimeHints()}</div>
      ${isLle ? '' : `
        <div class="ax-sec">El regreso</div>
        ${auxToggle('Regreso el mismo día', 'sameDayBack', f.sameDayBack,
          'Si vuelves hoy mismo, lo dejamos pedido de una vez y no tienes que volver a entrar.')}
        ${f.sameDayBack ? `
          ${auxField('Hora a la que aterrizas de vuelta', 'backTime', f.backTime || '', '19:40', 'time')}
          ${auxFlightField('Número del vuelo con el que aterrizas', 'backFlight', '9413')}
          <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Quedan dos traslados: el de ida y el de regreso. Puedes cancelar cualquiera por separado.</div>`
          : ''}`}
      ${/* La pernocta y la reserva en firme vivían en el paso del punto de
           recogida. Ese paso ya no lo ve todo el mundo (15-sep-2026), y son
           datos del VIAJE, no de la dirección: van aquí, con el vuelo. */ ''}
      <div class="ax-sec">Sobre el viaje</div>
      <div class="ax-toggles">
        ${auxToggle('¿Es una pernocta?', 'isPernocta', f.isPernocta, 'Pasas la noche entre vuelos (hotel).')}
        ${auxToggle('¿Es una reserva en firme?', 'isReserva', f.isReserva !== false, 'Confírmanos que el viaje va.')}
      </div>`;
  }
  // Va en su propio contenedor porque se repinta en cada tecla (junto con el
  // CTA) sin remontar los inputs — si no, el botón se deshabilitaba sin decir
  // por qué y el auxiliar se quedaba trancado sin entender.
  // El mismo aviso como DATO, para que el rediseño lo pinte con su aspecto.
  function auxTimeHint() {
    const f = auxState.form, isLle = f.type === 'lle';
    const lead = auxLeadCheck(f);
    if (lead) return { level: lead.level, text: lead.text };
    if (!f.time) return null;
    return { level: 'ok', text: isLle ? 'Te esperamos al bajar del avión.' : 'Te dejamos en MDE a la hora que pediste. La hora de recogida te la confirmamos cuando armemos la ruta del día.' };
  }
  // Repinta #ax-time-hints sin remontar los campos. Con el rediseño lo pinta
  // AuxRxPedir.timeHintsHTML(dato) si existe.
  function auxPaintTimeHints() {
    const hints = document.getElementById('ax-time-hints'); if (!hints) return;
    hints.innerHTML = (auxShellOn() && window.AuxRxPedir && typeof AuxRxPedir.timeHintsHTML === 'function')
      ? AuxRxPedir.timeHintsHTML(auxTimeHint()) : auxTimeHints();
  }
  function auxTimeHints() {
    const f = auxState.form, isLle = f.type === 'lle';
    const lead = auxLeadCheck(f);
    if (lead) return `<div class="ax-hint ${lead.level === 'bad' ? 'bad' : ''}"><svg class="icon"><use href="#i-info"/></svg>${lead.text}</div>`;
    if (!f.time) return '';
    // NO SE DA HORA DE RECOGIDA AQUÍ (Julián, 25-ago-2026). Antes decía
    // "Recogida estimada 09:30", sacada de presentación − 1 h clavada. Esa hora
    // se pinta ANTES de que exista ruta, así que la app comprometía algo que
    // nadie había decidido — y encima el margen no daba: su tabla cobra 50 min
    // desde Olivar en franja 12–19, o sea 10 de sobra sobre la hora que
    // prometíamos. Él pidió un rango con 20 min de gabela y "a espera de
    // confirmación"; la decisión fue más simple: no prometer hora.
    return `<div class="ax-hint ok"><svg class="icon"><use href="#i-clock"/></svg>${isLle ? 'Te esperamos al bajar del avión.' : 'Te dejamos en MDE a la hora que pediste. La hora de recogida te la confirmamos cuando armemos la ruta del día.'}</div>`;
  }

  // El paso del punto ('donde'). Desde la entrega del 17-ago el camino PRINCIPAL
  // es elegir el conjunto del catálogo verificado (0055) — lo pinta
  // aux-residencias.js. Lo de abajo, escribir la dirección y arrastrar el pin,
  // pasa a ser la EXCEPCIÓN: se llega ahí solo si el auxiliar lo pide ("Mi
  // punto no está en la lista") o si el catálogo no cargó. Desde el 15-sep el
  // paso solo aparece cuando hay algo que elegir (ver auxNeedsDonde).
  function auxStep3() {
    const f = auxState.form;
    const isLle = f.type === 'lle';
    if (window.AuxResidencias) {
      // Punto del registro ya puesto: el caso normal es no tener que elegir nada.
      AuxResidencias.autofill(f);
      const cat = AuxResidencias.html(f);
      if (cat != null) return cat;
    }
    // ── camino de excepción: texto libre + pin ──
    const volver = (window.AuxResidencias && AuxResidencias.hasCatalog() && f.manualAddr)
      ? `<button class="axr-back-cat" data-ax="res-catalog"><svg class="icon"><use href="#i-back"/></svg>Volver a la lista de conjuntos</button>`
      : '';
    // ANTES ESTE CAMINO SE TOMABA EN SILENCIO. Si el catálogo no llegaba, el
    // paso pedía la dirección a mano como si eso fuera lo normal, y el auxiliar
    // —que ya había dejado su punto en el registro— se preguntaba por qué se la
    // volvían a pedir. Es exactamente lo que pasa al abrir la app SIN SESIÓN: la
    // RLS de `residences` responde cero filas sin error. Ahora se dice.
    const sinCatalogo = !f.manualAddr && window.AuxResidencias && AuxResidencias.unavailable();
    const aviso = sinCatalogo ? `
      <div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>
        No pudimos cargar tus puntos de recogida guardados, así que toca escribir la dirección.
        Si acabas de abrir la app, reintenta; si sigue igual, avisa a coordinación.</div>
      <button class="ax-btn ax-btn-ghost" data-ax="res-retry"><svg class="icon"><use href="#i-refresh"/></svg>Reintentar</button>` : '';
    return `
      ${volver}
      ${aviso}
      ${auxField(isLle ? 'Dirección donde te dejamos' : 'Dirección de recogida', 'address', f.address || '', 'Cra 51 #49-06, Centro')}
      <div class="ax-geo-hint">${isLle ? 'Casa, hotel o donde te quedes.' : 'Casa, hotel o donde estés esa noche.'}</div>
      <div id="ax-map" class="ax-map ${f.address ? '' : 'hidden'}"></div>
      <div id="ax-pin-row" class="ax-pin-row ${f.locConfirmed ? 'ok' : ''} ${f.address ? '' : 'hidden'}">
        ${f.locConfirmed
          ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-ax="pin-edit">Ajustar</button>`
          : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`}
      </div>
      ${!f.locConfirmed && f.address ? `<button class="ax-btn ax-btn-ghost" data-ax="pin-confirm"><svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación</button>` : ''}`;
  }

  function auxStep4() {
    const f = auxState.form;
    const m = auxTypeMeta(f.type);
    // `extra` es un botón al lado del valor (el «Cambiar» del punto).
    const row = (k, v, extra) => `<div class="ax-sum-row"><span>${k}</span><b>${v}</b>${extra || ''}</div>`;
    // Con una sola unidad el punto se puso solo y el paso 'donde' no se vio: el
    // resumen es el único sitio donde el tripulante puede decir «hoy no salgo
    // de ahí». Sin catálogo no hay lista que abrir, así que el botón no va.
    const cambiar = (window.AuxResidencias && AuxResidencias.hasCatalog())
      ? `<button class="ax-link" data-ax="donde-cambiar">Cambiar</button>` : '';
    return `
      <div class="ax-sum">
        <div class="ax-sum-head ${m.cls}">${auxRouteHTML(m)}</div>
        ${f.flight ? row('Vuelo', f.flight) : ''}
        ${row('Fecha', f.date ? auxDateES(f.date) : '—')}
        ${row(f.type === 'lle' ? 'Aterriza' : 'Estar en el aeropuerto', auxHM(f.time))}
        ${f.type !== 'lle' && f.sameDayBack && f.backTime
          ? row('Regreso (aterriza)', auxHM(f.backTime) + (f.backFlight ? ' · ' + f.backFlight : ''))
          : ''}
        ${row(f.residenceId ? (f.type === 'lle' ? 'Te dejamos en' : 'Te recogemos en') : 'Dirección', auxShortAddr(f.address), cambiar)}
        ${f.residenceUnit ? row('Unidad', f.residenceUnit) : ''}
        ${f.residenceId ? `<div class="ax-sum-row"><span>Ubicación</span><b class="axr-ok">Verificada</b></div>` : ''}
        ${window.AuxPrivado && AuxPrivado.enabled()
          ? row('Servicio', f.level === 'private'
              ? 'Privado · con costo'
              : 'Compartido · incluido')
          : ''}
        ${f.isPernocta ? row('Pernocta', 'Sí (hotel)') : ''}
        ${f.isReserva === false ? row('Reserva', 'Tentativa (sin confirmar)') : ''}
      </div>
      ${/* Con el privado elegido, la franja Select: cuánto, quién lo confirma y
           que aquí no se cobra. aux-privado devuelve '' en compartido. */ ''}
      ${window.AuxPrivado && AuxPrivado.sumHTML ? AuxPrivado.sumHTML(f) : ''}
      ${/* Las notas se escriben AQUÍ (15-sep-2026), no en el paso del punto,
           que ya no ve todo el mundo. Van debajo del resumen y no dentro: el
           campo se teclea en vivo y el resumen no se repinta por tecla (ver el
           listener de input), así que una fila «Notas» ahí quedaría vieja. */ ''}
      ${auxField('Notas para el conductor (opcional)', 'notes', f.notes || '', 'Ej: portería 3, timbre 302', 'textarea')}
      <div class="ax-hint ok"><svg class="icon"><use href="#i-info"/></svg>Al confirmar, tu traslado entra a la planeación del día. Cuando le asignen conductor, lo verás en tu traslado.</div>
      ${auxPolicyHTML()}`;
  }

  // B3 · La política, ANTES de confirmar.
  //
  // Las dos reglas que más fricción generan el día del viaje estaban en ningún
  // lado: la espera en el punto se descubría cuando el carro ya se había ido, y
  // que se puede cancelar sin consecuencias no se decía nunca — y no decirlo es
  // lo que produce las cancelaciones tardías, que son las que rompen la ruta.
  //
  // Los minutos salen de Ajustes (aux_wait_minutes), no de un número escrito
  // aquí: si el jefe los cambia, este texto cambia solo.
  function auxPolicyHTML() {
    const wait = (typeof state !== 'undefined' && state.settings?.aux_wait_minutes != null)
      ? state.settings.aux_wait_minutes : 5;
    return `
      <div class="ax-sec">Antes de confirmar</div>
      <div class="axp">
        <div class="axp-row"><svg class="icon"><use href="#i-clock"/></svg>
          <div><b>El carro espera ${wait} minutos</b>
          <span>Se cuentan desde que llega al punto. Vas a ver la cuenta regresiva en la app.</span></div></div>
        <div class="axp-row"><svg class="icon"><use href="#i-x"/></svg>
          <div><b>Puedes cancelar</b>
          <span>Mientras no te hayan recogido. Si ya hay conductor asignado, le avisamos y sale de su ruta.</span></div></div>
        <div class="axp-row"><svg class="icon"><use href="#i-users"/></svg>
          <div><b>Puedes ir acompañado de otros tripulantes</b>
          <span>Si alguien más sale a una hora parecida y cerca de ti, el carro hace una sola parada.</span></div></div>
      </div>`;
  }

  // La regla del pie del pedido, como DATO (#17). La usan el pie de siempre
  // (auxFormCTA) y el del rediseño (AuxRxPedir.syncCta/el deslizador), así que
  // «¿se puede continuar?» se decide en un solo lugar.
  function auxCtaState() {
    const s = auxState.step, f = auxState.form, kind = auxStepKind(s);
    const badDate = auxLeadCheck(f)?.level === 'bad';
    // Paso 'donde': con conjunto elegido no hay pin que confirmar (la coord la
    // puso la operación a mano), así que la condición la decide el módulo.
    const paso3Listo = window.AuxResidencias
      ? AuxResidencias.ready(f) : !!(f.address && f.locConfirmed);
    // auxIataCorta: la sigla escrita a mano que quedó en UNA letra. No se deja
    // pasar —"A9412" no lo sabe leer ni el tablero ni nosotros— y el porqué se
    // dice en el aviso de debajo del campo, que se repinta en el mismo teclazo.
    const disabled = (kind === 'tipo' && !f.type)
      || (kind === 'vuelo' && ((f.type === 'lle' && (!f.flight || auxIataCorta('flight')))
            || !f.date || !f.time || badDate
            || (f.sameDayBack && (!f.backTime || !f.backFlight || auxIataCorta('backFlight')))))
      || (kind === 'donde' && !paso3Listo)
      || (kind === 'nivel' && !f.level)
      || (kind === 'revisar' && badDate);
    const priv = kind === 'revisar' && f.level === 'private';
    const label = kind !== 'revisar' ? 'Continuar'
      : (priv ? 'Solicitar traslado privado' : 'Confirmar traslado');
    return { kind, disabled: !!disabled, label, private: priv, bad: !!badDate };
  }
  function auxFormCTA() {
    const c = auxCtaState();
    // El privado se pide en latón (piel Select, 15-sep-2026): el botón dice lo
    // mismo que la franja del resumen y se ve del mismo módulo.
    const brass = c.private ? ' ax-btn-brass' : '';
    return `<button class="ax-btn ax-btn-primary${brass}" data-ax="next" ${c.disabled ? 'disabled' : ''}>${c.label}${c.kind !== 'revisar' ? '<svg class="icon"><use href="#i-arrow"/></svg>' : ''}</button>`;
  }
  // Actualiza el pie del pedido sin tocar los campos (#17). Con el rediseño lo
  // hace AuxRxPedir.syncCta(el) (solo disabled/aria: el deslizador no se
  // remonta a media tecla). Si esa función aún no existe, se ajusta el
  // `disabled` de lo que haya en el pie. Sin el rediseño, el pie de siempre.
  function auxSyncCta(el) {
    if (auxState.view !== 'form') return;
    const bar = auxRoot() && auxRoot().querySelector('.ax-cta-bar');
    if (auxShellOn()) {
      if (window.AuxRxPedir && typeof AuxRxPedir.syncCta === 'function') { AuxRxPedir.syncCta(el); return; }
      if (!bar) return;
      const c = auxCtaState();
      bar.querySelectorAll('[data-ax="next"], .rx-slide').forEach(b => {
        if ('disabled' in b) b.disabled = c.disabled;
        b.classList.toggle('off', c.disabled);
        b.setAttribute('aria-disabled', c.disabled ? 'true' : 'false');
      });
      return;
    }
    if (bar) bar.innerHTML = auxFormCTA();
  }

  // ---------- campos ----------
  // Con el rediseño encendido y AuxRxPedir cargado, el marcado es el suyo
  // (mismo contrato: data-field / data-ax="toggle" data-key). Si no, el de siempre.
  function auxField(label, key, value, ph, type, attrs) {
    if (auxShellOn() && window.AuxRxPedir && typeof AuxRxPedir.fieldHTML === 'function') {
      return AuxRxPedir.fieldHTML(label, key, value, ph, type, attrs);
    }
    const input = type === 'textarea'
      ? `<textarea class="ax-input" data-field="${key}" rows="2" placeholder="${ph || ''}">${value}</textarea>`
      : `<input class="ax-input" data-field="${key}" type="${type || 'text'}" value="${value}" placeholder="${ph || ''}" ${attrs || ''} />`;
    return `<label class="ax-label">${label}${input}</label>`;
  }
  function auxToggle(label, key, on, hint) {
    if (auxShellOn() && window.AuxRxPedir && typeof AuxRxPedir.toggleHTML === 'function') {
      return AuxRxPedir.toggleHTML(label, key, on, hint);
    }
    return `<button class="ax-toggle ${on ? 'on' : ''}" data-ax="toggle" data-key="${key}">
      <div><b>${label}</b><span>${hint}</span></div>
      <span class="ax-switch"><span class="ax-knob"></span></span>
    </button>`;
  }

  // ---------- el número de vuelo: la sigla en un chip, los dígitos aparte ----------
  //
  // (11-sep-2026) «Que al agendar un vuelo ya traiga las iniciales de la
  // aerolínea». Hasta hoy esto era UN campo de texto libre con placeholder
  // "Ej: AV-9412" y cero validación, y en `reservations.notes` quedaron las
  // tres formas del mismo vuelo: "AV-9412", "av9412" y "9412" pelado. No es
  // cosmético: de la sigla sale el TIEMPO DE DESEMBARQUE (admin-rutas,
  // rtDeplaneVuelo), o sea la hora a la que el carro sale por la persona. Sin
  // sigla el tablero la adivinaba por la forma del número —"los de 4 dígitos
  // que empiezan por 5 son JetSmart"— y eso es exactamente lo que se acaba.
  //
  // Ahora son dos cosas pegadas: un chip con la sigla, que entra puesta en la
  // aerolínea del perfil, y un campo que SOLO admite dígitos. El tripulante
  // teclea cuatro números y ya.
  //
  // SE PUEDE CAMBIAR, y no es un adorno: el de Avianca vuela a veces en otra
  // (posicionamiento, un chárter, un código compartido). El chip abre las cuatro
  // del catálogo y una salida «Otra» para escribirla a mano — quedar trancado a
  // las 4 a.m. sin poder pedir el carro es mucho peor que guardar una sigla rara.

  // Respaldo del catálogo: son las cuatro filas activas de `airlines` con su
  // mismo orden (sort_order 10/20/30/40), escritas aquí para el día en que la
  // consulta no pase. La RLS de esa tabla no es cosa de este módulo, y un chip
  // vacío dejaría al tripulante sin poder elegir. Si la consulta sí pasa, manda
  // la base y esta lista no se usa.
  const AUX_AEROLINEAS = [
    { iata: 'AV', name: 'Avianca' },
    { iata: 'JA', name: 'JetSMART' },
    { iata: 'P5', name: 'Wingo' },
    { iata: 'LA', name: 'LATAM' },
  ];
  // Siglas que el PEGADO reconoce además de las del catálogo. Son las que la
  // operación ve en los itinerarios de JetSmart y que admin-rutas ya entendía
  // (J65417, JEC123). Sin esto, pegar "J65417" dejaría la 'J' suelta —una letra
  // sola no es sigla, se bota— y el vuelo quedaría "JA65417": otra aerolínea y
  // otro tiempo de desembarque.
  const AUX_IATA_EXTRA = ['JEC', 'J6', 'JE'];

  const auxAerolineas = () => auxState.airlines || AUX_AEROLINEAS;
  // La sigla puesta en el campo `key`. Mientras el tripulante no toque el chip
  // es la de su perfil; desde que lo toca manda lo que él eligió. La comparación
  // es contra null y no un `||` a propósito: '' es una elección suya («sin
  // sigla»), no un «todavía no ha elegido».
  function auxFlightIata(key) {
    const v = auxState.form[key + 'Iata'];
    return String(v != null ? v : (auxState.myIata || '')).toUpperCase();
  }
  const auxIataLimpia = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  // Una letra sola no es una sigla (las IATA son dos, a veces tres).
  const auxIataCorta = (key) => auxFlightIata(key).length === 1;

  // EL VALOR QUE SE GUARDA: SIGLA+DÍGITOS en mayúscula y SIN GUION. Sin guion a
  // propósito — los lectores de api.js limpian espacios y guiones antes de
  // comparar, así que lo que se guarde hoy y las filas viejas ("AV-9412") se
  // leen igual. Vacío si no hay dígitos: una sigla sola no es un vuelo, y de eso
  // justamente se agarra el CTA para saber si el campo está lleno.
  function auxFlightSync(key) {
    const num = String(auxState.form[key + 'Num'] || '').replace(/\D/g, '');
    auxState.form[key] = num ? (auxFlightIata(key) + num) : '';
  }
  const auxFlightSyncAll = () => { auxFlightSync('flight'); auxFlightSync('backFlight'); };

  // Lo que el tripulante escribe —o PEGA— en el campo de dígitos. El pegado
  // completo no es el caso raro: es EL caso. El que copia "AV-9412" del correo
  // de la aerolínea y lo suelta aquí no está haciendo nada malo, así que en vez
  // de rechazárselo se le parte: las letras se van al chip, los dígitos se
  // quedan. Devuelve los dígitos y deja la sigla puesta como efecto.
  //   "AV-9412" → chip AV · campo 9412   pegado completo, con guion
  //   "av9412"  → chip AV · campo 9412   minúscula
  //   "P57433"  → chip P5 · campo 7433   la sigla lleva un dígito adentro: por
  //                                      eso se compara primero contra el
  //                                      catálogo y no se parte por "la letra"
  //   "CM123"   → chip CM · campo 123    sigla desconocida: se respeta igual
  //   "9412"    → el chip como estaba · campo 9412
  //   "A"       → se bota: una letra suelta no es una sigla
  function auxFlightTyped(key, raw) {
    const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const conocidas = auxAerolineas().map(a => a.iata).concat(AUX_IATA_EXTRA)
      .sort((a, b) => b.length - a.length); // la más larga primero, como en admin-rutas
    const sig = conocidas.find(p => s.startsWith(p) && /^\d{2,}$/.test(s.slice(p.length)));
    if (sig) { auxState.form[key + 'Iata'] = sig; return s.slice(sig.length).slice(0, 5); }
    const letras = s.replace(/[^A-Z]/g, '');
    if (letras.length >= 2) auxState.form[key + 'Iata'] = letras.slice(0, 3);
    return s.replace(/\D/g, '').slice(0, 5);
  }

  // El aviso de debajo del campo. Va en su propio contenedor con id porque se
  // repinta en cada teclazo sin remontar el input: si se remontara, el teclado
  // del teléfono se cierra y el cursor salta.
  // El aviso como DATO (el rediseño lo pinta con su aspecto).
  function auxFlightAvisoData(key) {
    if (auxIataCorta(key)) {
      return { level: 'bad', text: 'La sigla va de dos o tres letras (AV, JA, P5, LA). Complétala o elige la aerolínea en el botón.' };
    }
    if (!auxFlightIata(key)) {
      return { level: 'info', text: 'No tenemos guardada tu aerolínea: toca el botón de la izquierda y elige la sigla. Si la dejas vacía mandamos solo el número, y en coordinación les toca adivinar de qué vuelo hablas.' };
    }
    return null;
  }
  function auxFlightAviso(key) {
    const a = auxFlightAvisoData(key);
    if (auxShellOn() && window.AuxRxPedir && typeof AuxRxPedir.flightAvisoHTML === 'function') {
      return AuxRxPedir.flightAvisoHTML(a, key);
    }
    if (!a) return '';
    return a.level === 'bad'
      ? `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>
        ${a.text}</div>`
      : `<div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>
        ${a.text}</div>`;
  }
  // Repintado mínimo del chip (la sigla puede cambiar sin que el tripulante lo
  // toque: por un pegado, o porque la consulta de su aerolínea llegó tarde).
  function auxFlightChipSync(key) {
    const el = document.getElementById('ax-fl-chip-' + key);
    if (!el) return;
    const sig = auxFlightIata(key);
    el.textContent = sig || 'Sigla';
    el.style.color = sig ? '' : 'var(--a-t3)';
    // Si el selector está abierto en «Otra», su cajita también dice la sigla: un
    // pegado de "LA-1234" en el campo de al lado la cambia sin que él toque esta.
    // No se pisa mientras tiene el foco, que es cuando el que escribe es él.
    const inp = auxRoot() && auxRoot().querySelector('[data-field="' + key + 'Iata"]');
    if (inp && document.activeElement !== inp) inp.value = sig;
  }

  // El campo completo. Los estilos van en línea y con los tokens --a-* (no con
  // clases nuevas) porque esto se arma sobre lo que ya existe: .ax-input para
  // la caja y .ax-daychips/.ax-daychip para el selector, que ya están resueltos
  // en claro y en nocturno. Un color escrito a mano aquí sería el octavo parche
  // luminoso sobre negro que rc-auxiliar.css lleva meses recogiendo.
  // El color de marca del chip sale del MISMO mapa que pinta las tarjetas del
  // registro (aux-registro.js lo publica en window.MarcasAerolinea, y carga
  // antes que este archivo). Un solo mapa a propósito: con dos, Wingo termina
  // siendo morado de un tono en el registro y de otro aquí, y eso se nota.
  // Si el mapa no estuviera —otro orden de carga, un archivo que no bajó— esto
  // devuelve null y el chip se queda como estaba. Un color es un adorno; que el
  // tripulante no pueda pedir el carro a las 4 a.m. no lo es.
  function auxMarcaDe(sigla) {
    const M = window.MarcasAerolinea;
    if (!M || !sigla) return null;
    // Solo las conocidas se pintan. Una sigla escrita a mano ("CM") se queda
    // neutra en vez de salir gris pizarra: el gris de repuesto tiene sentido en
    // una tarjeta grande del registro, pero en un chip de dos letras se lee como
    // «deshabilitado», justo lo contrario de lo que pasa.
    return M.mapa[sigla] || null;
  }

  function auxFlightField(label, key, ph) {
    const f = auxState.form;
    const sig = auxFlightIata(key);
    const num = String(f[key + 'Num'] || '').replace(/\D/g, '');
    const cat = auxAerolineas();
    // «Otra» queda encendida también cuando la sigla puesta no es de las cuatro
    // (la trajo un pegado, o la escribió él): si no, el chip mostraría "J6" con
    // ninguna opción marcada, que se lee como que el selector está roto.
    const otra = f.flOtra === key || (!!sig && !cat.some(a => a.iata === sig));
    const abierto = f.flPick === key;
    const marca = otra ? null : auxMarcaDe(sig);
    const chips = cat.map(a => `
        <button class="ax-daychip${(!otra && sig === a.iata) ? ' on' : ''}" data-ax="fl-set" data-k="${key}" data-iata="${a.iata}"
          style="position:relative;overflow:hidden">
          ${(m => m ? `<i style="position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,${m.c1},${m.c2})"></i>` : '')(auxMarcaDe(a.iata))}
          <b>${a.iata}</b><span>${escapeHtml(a.name)}</span></button>`).join('');
    return `
      <div class="ax-label">${label}</div>
      <div style="display:flex;gap:8px;align-items:stretch;margin-top:7px">
        <button type="button" class="ax-input" data-ax="fl-pick" data-k="${key}"
          aria-label="Aerolínea del vuelo"
          style="margin-top:0;width:auto;flex:0 0 auto;display:flex;align-items:center;gap:7px;cursor:pointer;font-weight:800;letter-spacing:.03em;${abierto ? 'border-color:var(--a-accent);' : ''}${marca ? `background:linear-gradient(135deg,${marca.c1},${marca.c2});border-color:${marca.c2};color:${marca.tinta}` : ''}">
          <span id="ax-fl-chip-${key}" style="${sig ? '' : 'color:var(--a-t3)'}">${sig || 'Sigla'}</span>
          <svg class="icon" style="width:13px;height:13px;color:${marca ? marca.tinta : 'var(--a-t2)'};opacity:${marca ? '.8' : '1'};flex:0 0 auto"><use href="#i-chev"/></svg>
        </button>
        <input class="ax-input" data-field="${key}Num" type="text" inputmode="numeric" autocomplete="off"
          value="${num}" placeholder="${ph}" aria-label="Número del vuelo, solo dígitos"
          style="margin-top:0;flex:1 1 auto;min-width:0" />
      </div>
      ${abierto ? `
        <div class="ax-daychips" style="margin:8px 0 0">${chips}
          <button class="ax-daychip${otra ? ' on' : ''}" data-ax="fl-other" data-k="${key}"><b>Otra</b><span>La escribo</span></button>
        </div>
        ${otra ? `<input class="ax-input" data-field="${key}Iata" type="text" autocomplete="off"
            value="${sig}" placeholder="Ej: CM" maxlength="3" aria-label="Sigla de la aerolínea"
            style="margin-top:8px;text-transform:uppercase;letter-spacing:.06em;font-weight:700" />` : ''}` : ''}
      <div id="ax-fl-aviso-${key}">${auxFlightAviso(key)}</div>`;
  }

  // Un teclazo (o un pegado) en cualquiera de los dos campos del vuelo: el de
  // dígitos y el de la sigla escrita a mano.
  function auxFlightInput(k, el) {
    const esNum = k.slice(-3) === 'Num';
    const base = esNum ? k.slice(0, -3) : k.slice(0, -4);
    const v = esNum ? auxFlightTyped(base, el.value) : auxIataLimpia(el.value);
    // Solo se reescribe la caja si de verdad cambió: tocar `value` manda el
    // cursor al final, y hacerlo en cada tecla es insoportable.
    if (v !== el.value) el.value = v;
    auxState.form[k] = v;
    auxFlightSync(base);
    auxFlightChipSync(base);
    const av = document.getElementById('ax-fl-aviso-' + base);
    if (av) av.innerHTML = auxFlightAviso(base);
  }

  // El catálogo de siglas y la aerolínea del tripulante. Los dos van sueltos y
  // sin bloquear nada: si `airlines` no se deja leer queda el respaldo, y si el
  // perfil no trae aerolínea el chip sale vacío y el formulario se comporta como
  // el de ayer (número pelado), que es lo que la base ya tiene en 102 perfiles.
  async function auxLoadAerolineas() {
    if (auxState.airLoading) return;
    if (auxState.airlines && auxState.myIata) return;
    auxState.airLoading = true;
    try {
      if (!auxState.airlines) {
        let list = null;
        try { if (window.Api?.listAirlines) list = await Api.listAirlines(); } catch (_) {}
        const limpio = (list || [])
          .map(a => ({ iata: auxIataLimpia(a.iata_code), name: a.name || '' }))
          .filter(a => a.iata.length >= 2);
        if (limpio.length) auxState.airlines = limpio;
      }
      if (!auxState.myIata) {
        try { if (window.Api?.getMyAirlineIata) auxState.myIata = auxIataLimpia(await Api.getMyAirlineIata()); } catch (_) {}
      }
    } finally { auxState.airLoading = false; }
    // Si esto llega cuando el tripulante ya está en el paso del vuelo, se le
    // pone la sigla SIN repintar el paso: remontar el input mientras escribe le
    // cierra el teclado y le tira el cursor al principio.
    if (auxState.view !== 'form') return;
    auxFlightSyncAll();
    auxFlightChipSync('flight'); auxFlightChipSync('backFlight');
    auxSyncCta();
  }

  // ---------- mapa + geocodificación (pin ajustable REAL) ----------
  function auxAfterFormRender() {
    const kind = auxStepKind(auxState.step);
    // Al paso del nivel se llega casi siempre por «Continuar» (que ya pregunta
    // el cupo). Pero desde el 15-sep también se puede CAER en él: el catálogo
    // llega mientras se mira el spinner del punto, lo pone solo, el paso
    // 'donde' desaparece y el número que era 'donde' pasa a ser 'nivel'. Para
    // que la camioneta no quede «por confirmar» se pregunta acá también —
    // askCupo no repite la consulta si ya la hizo para esa misma hora.
    if (kind === 'nivel') auxNivelEnter();
    if (kind !== 'donde') return;
    const f = auxState.form;
    // Con conjunto elegido el mapa lo monta aux-residencias (pin FIJO). El de
    // abajo es el del camino manual, con pin arrastrable.
    if (window.AuxResidencias && !f.manualAddr && AuxResidencias.hasCatalog()) {
      AuxResidencias.afterRender(f);
      return;
    }
    if (f.address && f.lat != null) auxMountMap(f.lat, f.lng);
  }
  function auxMountMap(lat, lng) {
    const el = document.getElementById('ax-map'); if (!el || typeof L === 'undefined') return;
    el.classList.remove('hidden');
    if (auxState.map) { auxState.map.remove(); auxState.map = null; }
    const map = auxState.map = L.map(el, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    map.setView([lat, lng], 16);
    const marker = auxState.marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      auxState.form.lat = p.lat; auxState.form.lng = p.lng;
      auxState.form.locConfirmed = false; // movió el pin → hay que reconfirmar
      auxRefreshPinRow();
    });
    setTimeout(() => map.invalidateSize(), 60);
  }
  function auxRefreshPinRow() {
    // Re-render liviano del paso del punto (camino manual) sin remontar el mapa.
    auxSyncCta();
    // Con el rediseño, la fila del pin la repinta su pantalla (si sabe).
    if (auxShellOn() && window.AuxRxPedir && typeof AuxRxPedir.refreshPinRow === 'function') {
      AuxRxPedir.refreshPinRow(auxState.form); return;
    }
    const row = document.getElementById('ax-pin-row'); if (!row) return;
    const f = auxState.form;
    row.className = 'ax-pin-row ' + (f.locConfirmed ? 'ok' : '');
    row.innerHTML = f.locConfirmed
      ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-ax="pin-edit">Ajustar</button>`
      : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`;
    // botón confirmar (aparece solo si falta)
    let btn = auxRoot().querySelector('[data-ax="pin-confirm"]');
    if (!f.locConfirmed && !btn) {
      const b = document.createElement('button');
      b.className = 'ax-btn ax-btn-ghost'; b.setAttribute('data-ax', 'pin-confirm');
      b.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación';
      row.after(b);
    } else if (f.locConfirmed && btn) { btn.remove(); }
  }
  async function auxGeocode(q) {
    const my = ++auxState.geoReq;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q=${encodeURIComponent(q + ', Rionegro, Antioquia')}`;
      const r = await (await fetch(url, { headers: { 'Accept-Language': 'es' } })).json();
      if (my !== auxState.geoReq) return; // llegó una búsqueda más nueva
      if (r && r[0]) {
        auxState.form.lat = parseFloat(r[0].lat); auxState.form.lng = parseFloat(r[0].lon);
      } else {
        // sin resultado: cae al centro de Rionegro para que igual pueda mover el pin
        auxState.form.lat = 6.1537; auxState.form.lng = -75.3738;
        auxToast('No ubicamos la dirección exacta — mueve el pin al punto correcto.');
      }
      auxState.form.locConfirmed = false;
      auxMountMap(auxState.form.lat, auxState.form.lng);
      auxRefreshPinRow();
    } catch (e) { /* silencioso: el usuario puede reintentar */ }
  }

  // ---------- confirmar → crea la reserva (BD real o demo) → confirmación ----------
  // Construye el traslado en memoria a partir del formulario. Se saca aparte
  // porque desde 2026-08-25 un mismo pedido puede producir DOS: la ida y el
  // regreso del mismo día.
  //
  // OJO CON EL NOMBRE: auxTripCard() ya existe y es OTRA cosa — la que PINTA la
  // tarjeta. Llamar a esta igual la pisaba (gana la última declaración) y toda
  // la pantalla de viajes salía «[object Object]».
  function auxNuevoTrip(f) {
    const priv = f.level === 'private';
    return {
      id: 't' + Date.now() + Math.random().toString(36).slice(2, 6),
      type: f.type, flight: f.flight, date: f.date, time: f.time,
      address: f.address, lat: f.lat, lng: f.lng,
      residenceId: f.residenceId || null,
      residenceUnit: f.residenceUnit || null,
      // 0069. El estado y el precio los pone el SERVIDOR; acá se guardan solo
      // para pintar la pantalla mientras llega el siguiente refresco.
      level: priv ? 'private' : 'shared',
      privateStatus: priv ? 'requested' : null,
      price: priv && window.AuxPrivado ? AuxPrivado.price() : null,
      isPernocta: !!f.isPernocta, isReserva: f.isReserva !== false, notes: f.notes || '',
      notesUser: f.notes || '',
      // La misma forma T que trae el servidor (§3.1). Lo que decide la
      // operación (hora de recogida, código, carro) nace en null: nunca se
      // adelanta en el teléfono.
      bags: f.bags != null && f.bags !== '' ? Math.max(0, Math.min(3, Number(f.bags) || 0)) : null,
      quiet: priv && !!f.quietRide,
      pickupAt: null, meetCode: null, vehicle: null, published: false,
      createdAt: new Date().toISOString(),
      status: 'pending', driver: null, rated: false,
    };
  }

  // ---------- entrar a un paso del pedido (#18) ----------
  // Un solo camino para «Continuar», «atrás», «Cambiar» (goStep), «Repetir» y
  // el avance solo del paso 1. Antes goStep ponía el número y listo, así que
  // caer en 'nivel' desde el resumen dejaba el nivel sin elegir y la
  // camioneta sin consultar.
  function auxEnterStep(n, dir) {
    const total = auxSteps();
    n = Math.max(1, Math.min(total, n | 0 || 1));
    auxState.stepDir = dir || (n >= auxState.step ? 'fwd' : 'bwd');
    auxState.step = n;
    if (auxStepKind(n) === 'nivel') auxNivelEnter();
    return n;
  }
  // Entrar al paso del nivel: siempre sale con un nivel elegido y, si el
  // privado se puede pedir, con la pregunta del cupo en camino (askCupo no
  // repite la consulta para la misma hora).
  // D19: si el tripulante guardó «privado» como preferido y el privado está
  // encendido, entra preseleccionado. Queda marcado como automático para
  // soltarlo si la camioneta resulta comprometida (auxNivelFix).
  function auxNivelEnter() {
    if (!window.AuxPrivado) return;
    const f = auxState.form;
    if (!f.level) {
      const H = window.Auxiliar && window.Auxiliar.header;
      const quiere = !!(H && H.preferredLevel === 'private' && AuxPrivado.enabled && AuxPrivado.enabled());
      f.level = quiere ? 'private' : 'shared';
      f.levelAuto = true;
    }
    // En primicia no hay nada que preguntarle al servidor: no se puede pedir.
    if (!AuxPrivado.primicia || !AuxPrivado.primicia()) AuxPrivado.askCupo(auxWhenISO(f));
  }
  function auxNivelFix() {
    const f = auxState.form;
    if (!f || !f.levelAuto || f.level !== 'private' || !window.AuxPrivado || typeof AuxPrivado.cupo !== 'function') return;
    if (AuxPrivado.cupo() === 'ocupada' || (AuxPrivado.enabled && !AuxPrivado.enabled())) {
      f.level = 'shared'; f.quietRide = false;
    }
  }
  // «Continuar» del pedido (o enviar en el último paso).
  function auxGoNext(el) {
    if (auxState.step < auxSteps()) { auxEnterStep(auxState.step + 1, 'fwd'); auxRender(); return; }
    // El audio de la celebración se desbloquea AQUÍ, dentro del clic:
    // auxSubmit es async y en iOS el gesto ya no cuenta cuando vuelve.
    window.Auxiliar.submit({ primed: false });
  }

  async function auxSubmit() {
    const f = auxState.form;
    // Último apretón de tuercas: el canónico SIGLA+DÍGITOS se rearma en cada
    // teclazo, pero la sigla del perfil viaja en una consulta aparte y podría
    // haber llegado después del último. Rearmarlo aquí cuesta nada.
    auxFlightSyncAll();
    const trip = auxNuevoTrip(f);
    // Persistir en dev si hay sesión real; si falla, no se inventa nada.
    try { trip.id = await Api.createReservation(f); }
    catch (e) {
      // La suspensión la frena la base aunque la pantalla no se haya enterado
      // (el jefe la suspendió con la app abierta): se dice eso, no «revisa la conexión».
      if (/suspendida/i.test(e.message || '')) {
        if (auxState.profile) auxState.profile.is_active = false;
        auxState.view = 'home'; auxState.tab = 'inicio'; auxRender();
        if (auxShellOn()) auxLockNotice('suspended'); else auxToast(e.message);
        return;
      }
      // La pausa por no pago (Facturario) también la frena la base, con su
      // propio texto. Se muestra la hoja de la pausa, no un error de red.
      if (/pausad/i.test(e.message || '')) {
        auxState.view = 'home'; auxState.tab = 'inicio'; auxRender();
        if (auxShellOn()) auxLockNotice('paused'); else auxToast(e.message);
        return;
      }
      auxToast('No se pudo guardar tu traslado. Revisa la conexión e intenta otra vez.', 'Alert'); return;
    }
    auxState.trips.unshift(trip);

    // ── El regreso del mismo día ──
    // Son DOS reservas y no una con dos horas: el asignador rutea por momento
    // comprometido, y la ida y el regreso caen en oleadas distintas, con carros
    // distintos. Guardarlo como un solo registro obligaría a partirlo después.
    //
    // La ida ya quedó guardada. Si el regreso falla, NO se deshace la ida — se
    // le dice qué pasó y qué le falta. Perder el traslado que sí quedó, porque
    // el segundo no pasó, sería peor que quedar a medias sabiéndolo.
    if (f.type !== 'lle' && f.sameDayBack && f.backTime) {
      const back = {
        ...f, type: 'lle',
        time: f.backTime,
        flight: f.backFlight || f.flight,
        // Marcarlo como pernocta al regreso no tiene sentido: la pernocta es
        // del viaje de ida.
        isPernocta: false,
        // El regreso es siempre compartido: el privado se pide para un tramo
        // concreto y se aprueba uno a uno (0069).
        level: 'shared',
        notes: ((f.notes || '') + ' · Regreso del mismo día').trim(),
      };
      try {
        const bt = auxNuevoTrip(back);
        bt.id = await Api.createReservation(back);
        auxState.trips.unshift(bt);
      } catch (e) {
        auxToast('Guardamos tu ida, pero el regreso no quedó. Pídelo aparte desde «Pedir traslado».');
      }
    }

    auxState.step = 1; auxState.stepDir = 'fwd'; auxState.form = {};
    if (window.AuxResidencias) AuxResidencias.newTrip();
    auxState.editingTrip = trip.id; auxState.view = 'confirm';
    auxRender();
  }
  // ---------- P1: confirmación (justo tras reservar) ----------
  function auxConfirmHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    const m = auxTypeMeta(t.type);
    const timeline = [
      { t: 'Ahora', label: 'Traslado solicitado', done: true },
      // Un privado aún no está aprobado: prometerle «conductor en minutos»
      // contradice el lead de esta misma pantalla.
      t.level === 'private'
        ? { t: 'Lo confirma coordinación', label: 'Camioneta por confirmar', done: false }
        : { t: 'En minutos', label: 'Asignamos tu conductor', done: false },
      { t: t.type === 'lle' ? auxHM(t.time) : 'Te confirmamos la hora', label: t.type === 'lle' ? 'Recogida en el aeropuerto' : 'Recogida en tu dirección', done: false },
    ];
    // La escena del avión (aux-celebracion.js) reemplaza al círculo con chulo
    // de antes; si el módulo no cargó queda el círculo, que sigue siendo cierto.
    const vip = t.level === 'private';
    const scene = window.AuxCelebracion
      ? AuxCelebracion.sceneHTML(t)
      : '<div class="ax-success"><svg class="icon"><use href="#i-check"/></svg></div>';
    // Ningún texto promete una notificación (3 de 102 auxiliares las tienen
    // activas): la respuesta —conductor asignado, privado aprobado— vive en la
    // pantalla del traslado. El privado además NO está confirmado: lo pidió.
    const title = vip ? 'Solicitud enviada' : '¡Traslado confirmado!';
    const lead = vip
      ? 'Tu privado quedó pedido. Coordinación confirma si la camioneta está libre a esa hora; la respuesta la verás en tu traslado.'
      : `Tu ${m.label.toLowerCase()} quedó en la planeación del día. Cuando le asignen conductor, lo verás en tu traslado.`;
    return `
      <div class="ax-body ax-center">
        ${scene}
        <h1 class="ax-big axc-in">${title}</h1>
        <p class="ax-lead ax-tc axc-in">${lead}</p>
        <div class="ax-timeline">
          ${timeline.map(x => `<div class="ax-tl-row ${x.done ? 'done' : ''}"><span class="ax-tl-dot"></span><div><b>${x.label}</b><span>${x.t}</span></div></div>`).join('')}
        </div>
      </div>
      <div class="ax-cta-bar"><button class="ax-btn ax-btn-primary" data-ax="home">Ver mis viajes</button></div>`;
  }

  // ---------- detalle / seguimiento del viaje (despacha por estado) ----------
  function auxTripHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    if (t.status === 'onway') return auxTrackOnWay(t);   // P3
    if (t.status === 'onboard') return auxTrackOnBoard(t); // P4
    if (auxShowRate(t)) return auxRating(t); // P5
    return auxTripDetail(t); // pending / assigned (P2) / cancelado / no-show / done
  }

  // ---------- «Ahora no» al calificar (§2.7) ----------
  // Antes «Ahora no» marcaba el viaje como calificado SOLO en memoria: al
  // recargar la app volvía a salir la pantalla de calificar. Ahora se guarda
  // en el teléfono (es una comodidad suya, no un dato de la operación) y el
  // viaje sigue sin calificación en el servidor, que es la verdad.
  const AUX_RATE_SKIP_KEY = 'rendio.aux.rateSkip';
  function auxRateSkipList() {
    try { const v = JSON.parse(localStorage.getItem(AUX_RATE_SKIP_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function auxRateSkipped(id) { return !!id && auxRateSkipList().includes(id); }
  function auxRateSkip(id) {
    if (!id) return;
    try {
      const l = auxRateSkipList().filter(x => x !== id); l.push(id);
      localStorage.setItem(AUX_RATE_SKIP_KEY, JSON.stringify(l.slice(-50)));
    } catch (_) {}
  }
  function auxRateUnskip(id) {
    try { localStorage.setItem(AUX_RATE_SKIP_KEY, JSON.stringify(auxRateSkipList().filter(x => x !== id))); } catch (_) {}
  }
  function auxShowRate(t) {
    if (!t || t.status !== 'done' || t.rated || !t.driver) return false;
    return auxState.rateOpen === t.id || !auxRateSkipped(t.id);
  }

  function auxTripHead(title) {
    return `<div class="ax-form-head"><button class="ax-icbtn" data-ax="home"><svg class="icon"><use href="#i-back"/></svg></button><b>${title}</b><span></span></div>`;
  }
  function auxDriverCard(d, showEta) {
    d = d || {};
    const meta = 'Carro ' + (d.plate || '—') + (d.rating ? ' · ★ ' + d.rating : '');
    const n = auxState.chatUnread;
    return `<div class="ax-driver">
      <span class="ax-driver-av">${(d.name || 'C')[0]}</span>
      <div><b>${d.name || 'Tu conductor'}</b><span>${meta}</span></div>
      <div class="ax-driver-acts">
        <button class="ax-icbtn sm ax-chat-btn" data-ax="chat" title="Escribirle"><svg class="icon"><use href="#i-chat"/></svg>${n ? `<span class="ax-badge">${n > 9 ? '9+' : n}</span>` : ''}</button>
        <button class="ax-icbtn sm" data-ax="call" title="Llamar"><svg class="icon"><use href="#i-phone"/></svg></button>
        ${showEta && d.eta ? `<span class="ax-eta">recogida<br><b>${d.eta}</b></span>` : ''}
      </div>
    </div>`;
  }

  // ---------- CHAT con el conductor (0052) ----------
  // Va como panel encima de la pantalla del viaje, no como vista aparte: si
  // fuera una vista, entrar al chat mataría el rastreo del mapa y al salir habría
  // que remontarlo entero.
  function auxChatHTML(t) {
    if (auxShellOn() && window.AuxRxViaje && typeof AuxRxViaje.chatHTML === 'function') return AuxRxViaje.chatHTML(t);
    const d = t.driver || {};
    return `<div class="ax-chat hidden" id="ax-chat">
      <div class="ax-chat-head">
        <button class="ax-icbtn sm" data-ax="chat-close" aria-label="Cerrar"><svg class="icon"><use href="#i-back"/></svg></button>
        <div class="ax-chat-who"><b>${d.name || 'Tu conductor'}</b><span>Carro ${d.plate || '—'}</span></div>
        <button class="ax-icbtn sm" data-ax="call" title="Llamar"><svg class="icon"><use href="#i-phone"/></svg></button>
      </div>
      <div class="ax-chat-body" id="ax-chat-body"></div>
      <div class="ax-chat-foot">
        <input id="ax-chat-input" type="text" maxlength="500" placeholder="Escribe un mensaje…" autocomplete="off">
        <button class="ax-chat-send" data-ax="chat-send" aria-label="Enviar"><svg class="icon"><use href="#i-send"/></svg></button>
      </div>
    </div>`;
  }
  function auxChatBubbles() {
    const el = document.getElementById('ax-chat-body'); if (!el) return;
    const msgs = auxState.chatMsgs || [];
    // Con el rediseño, las burbujas rx-bub las arma su pantalla (mismos datos).
    if (auxShellOn() && window.AuxRxViaje && typeof AuxRxViaje.bubblesHTML === 'function') {
      el.innerHTML = AuxRxViaje.bubblesHTML(msgs, auxState.profile?.id || null);
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (!msgs.length) {
      el.innerHTML = `<div class="ax-chat-empty">
        <svg class="icon"><use href="#i-chat"/></svg>
        <b>Escríbele a tu conductor</b>
        <span>Sirve para lo que conviene que quede escrito: "portería 3, torre B", "salgo en 2 minutos". Si hay afán, llámalo.</span>
      </div>`;
      return;
    }
    const hora = (iso) => {
      try { return new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }
      catch (_) { return ''; }
    };
    // Desde 0067 el hilo tiene tres puntas. Un mensaje de Rendio no se puede ver
    // igual que uno del conductor: quien lo lee tiene que saber quién le habla.
    // Sale como «Coordinación» (D11, 27-sep-2026): así se llama en toda la app.
    el.innerHTML = msgs.map(m => `<div class="ax-msg ${m.sender_role === 'auxiliar' ? 'mine' : 'their'}${m.sender_role === 'admin' ? ' rendio' : ''}">
      ${m.sender_role === 'admin' ? '<em>Coordinación</em>' : ''}
      <p>${auxEsc(m.body)}</p><span>${hora(m.created_at)}</span>
    </div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  const auxEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function auxChatSync(markRead) {
    const t = auxCurTrip(); if (!t || !window.Api?.listReservationMessages) return;
    const msgs = await Api.listReservationMessages(t.id);
    // Pudo cerrarse el chat o cambiarse de viaje mientras respondía el servidor.
    if (auxCurTrip() !== t) return;
    const abierto = auxState.chatOpen;
    auxState.chatMsgs = msgs;
    // Sin leer PARA MÍ: con tres puntas en el hilo, que el conductor haya abierto
    // un mensaje de Rendio no significa que yo lo haya visto (0067).
    const yo = auxState.profile?.id || null;
    const sinLeer = (m) => window.Api?.chatUnreadFor ? Api.chatUnreadFor(m, yo)
      : (Array.isArray(m.read_by) ? !yo || !m.read_by.includes(yo) : !m.read_at);
    auxState.chatUnread = abierto ? 0 : msgs.filter(m => m.sender_role !== 'auxiliar' && sinLeer(m)).length;
    if (abierto) {
      auxChatBubbles();
      if (markRead && Api.markReservationMessagesRead) { try { await Api.markReservationMessagesRead(t.id); } catch (_) {} }
    } else if (auxShellOn() && window.AuxRxViaje && typeof AuxRxViaje.setUnread === 'function') {
      // El globo del botón «Mensaje» del rediseño lo pinta su pantalla.
      AuxRxViaje.setUnread(auxState.chatUnread);
    } else {
      // Repinta solo el badge del botón, sin tocar el resto de la pantalla.
      const btn = document.querySelector('#auxiliar-ui .ax-chat-btn');
      if (btn) {
        const b = btn.querySelector('.ax-badge');
        if (!auxState.chatUnread) { if (b) b.remove(); }
        else if (b) b.textContent = auxState.chatUnread > 9 ? '9+' : auxState.chatUnread;
        else btn.insertAdjacentHTML('beforeend', `<span class="ax-badge">${auxState.chatUnread > 9 ? '9+' : auxState.chatUnread}</span>`);
      }
    }
  }
  function auxChatOpen() {
    const p = document.getElementById('ax-chat'); if (!p) return;
    auxState.chatOpen = true;
    p.classList.remove('hidden');
    auxChatBubbles();
    auxChatSync(true);
    if (auxState.chatPoll) clearInterval(auxState.chatPoll);
    auxState.chatPoll = setInterval(() => auxChatSync(true), 5000);
    const i = document.getElementById('ax-chat-input'); if (i) i.focus();
  }
  function auxChatClose() {
    auxState.chatOpen = false;
    const p = document.getElementById('ax-chat'); if (p) p.classList.add('hidden');
    if (auxState.chatPoll) { clearInterval(auxState.chatPoll); auxState.chatPoll = null; }
  }
  async function auxChatSend() {
    const i = document.getElementById('ax-chat-input'); if (!i) return;
    const body = i.value.trim();
    if (!body || auxState.chatSending) return;
    const t = auxCurTrip(); if (!t) return;
    auxState.chatSending = true;
    i.value = '';
    // Optimista: la burbuja aparece de una. Si el envío falla se quita y se
    // devuelve el texto al campo, para que no se pierda lo que escribió.
    const temp = { id: 'tmp' + Date.now(), sender_role: 'auxiliar', body, created_at: new Date().toISOString() };
    auxState.chatMsgs = (auxState.chatMsgs || []).concat([temp]);
    auxChatBubbles();
    try {
      const r = await Api.sendReservationMessage(t.id, body, { title: 'Mensaje de tu pasajero' });
      // Si al conductor no le suena, hay que decirlo: si no, uno se queda
      // esperando una respuesta que no va a llegar hasta que él abra la app.
      if (r && r.notified === false && !auxState.chatWarned) {
        auxState.chatWarned = true;
        auxToast('Enviado. Tu conductor no tiene notificaciones activadas: lo verá al abrir la app.');
      }
      await auxChatSync(true);
    } catch (e) {
      auxState.chatMsgs = auxState.chatMsgs.filter(m => m.id !== temp.id);
      auxChatBubbles();
      i.value = body;
      auxToast((e && e.message) ? e.message : 'No se pudo enviar el mensaje.');
    } finally { auxState.chatSending = false; }
  }

  // P2 (assigned) + pending + cancelado + no-show + done
  function auxTripDetail(t) {
    const m = auxTypeMeta(t.type), st = auxStatusMeta(t.status);
    const closed = AUX_CLOSED.includes(t.status);
    // Se puede cancelar mientras no te hayan recogido ni sea un viaje cerrado.
    const canCancel = !closed && ['pending', 'assigned', 'onway'].includes(t.status);
    return `
      ${auxTripHead('Tu viaje')}
      <div class="ax-body">
        <div class="ax-trip-hero ${m.cls}">
          <span class="ax-chip ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label}</span>
          <div class="ax-status ${st.cls}">${st.label}</div>
        </div>
        ${t.status === 'cancelled' ? `<div class="ax-late warn"><svg class="icon"><use href="#i-info"/></svg>Este traslado fue cancelado${t.cancelReason ? ' — ' + t.cancelReason : ''}.</div>` : ''}
        ${t.status === 'noshow' ? `<div class="ax-late late"><svg class="icon"><use href="#i-info"/></svg>El conductor te esperó en el punto y no pudo recogerte. Si fue un error, avisa al coordinador.</div>` : ''}
        ${window.AuxPrivado ? AuxPrivado.statusHTML(t) : ''}
        ${!closed ? `<div id="ax-late-wrap">${auxLateHTML(t, t._info)}</div>` : ''}
        <div class="ax-sum">
          <div class="ax-sum-row"><span>Te recogen en</span><b>${t.type === 'lle' ? 'MDE' : auxShortAddr(t.address)}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Te dejan en' : 'Destino'}</span><b>${t.type === 'lle' ? auxShortAddr(t.address) : 'MDE'}</b></div>
          <div class="ax-sum-row"><span>Vuelo</span><b>${t.flight || '—'}</b></div>
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Aterriza' : 'Estar en MDE'}</span><b>${auxDateES(t.date)} · ${auxHM(t.time)}</b></div>
          ${t.isPernocta ? `<div class="ax-sum-row"><span>Pernocta</span><b>Sí (hotel)</b></div>` : ''}
          ${t.isReserva === false ? `<div class="ax-sum-row"><span>Reserva</span><b>Tentativa</b></div>` : ''}
          ${t.notes ? `<div class="ax-sum-row"><span>Notas</span><b>${t.notes}</b></div>` : ''}
        </div>
        ${closed ? (t.status === 'done'
            ? `<div class="ax-hint ok"><svg class="icon"><use href="#i-check"/></svg>Viaje completado. ¡Gracias por viajar con Rendio!</div>`
            : '')
          : t.driver ? `<div class="ax-sec">Tu conductor</div>${auxDriverCard(t.driver, true)}
              ${t.readyAt ? `<div class="ax-hint ok"><svg class="icon"><use href="#i-check"/></svg>Ya confirmaste que estarás listo. ${t.driver.name.split(' ')[0]} lo ve en su ruta.</div>`
                          : `<div class="ax-hint ok"><svg class="icon"><use href="#i-info"/></svg>Te avisaremos cuando ${t.driver.name.split(' ')[0]} esté en camino. No tienes que estar pendiente.</div>`}`
            : `<div class="ax-hint"><svg class="icon"><use href="#i-clock"/></svg>Buscando conductor… te avisamos apenas asignen.</div>`}
        ${canCancel ? auxCancelBlock(t) : ''}
        <div class="ax-spacer"></div>
      </div>
      ${auxCtaBar(t, closed)}
      ${t.driver && !closed ? auxChatHTML(t) : ''}
      ${auxState.alarm ? auxAlarmHTML(t) : ''}`;
  }

  // Barra de acción del viaje. Dos botones que resuelven la eventualidad #4:
  //
  //  · "Sin novedad" — en un viaje de LLEGADA es literalmente lo que pidió la
  //    operación: el tripulante confirma que los tiempos estimados se van a
  //    cumplir. No estrena backend: es el mismo RPC `auxiliar_confirm_ready`
  //    (0050) que ya usaba "Confirmar mi recogida", con otro texto. Y a
  //    propósito NO crea una eventualidad: son ~80 al día y llenarían la bandeja
  //    del jefe hasta volverla inútil. Un "sin novedad" sirve para CALLAR, no
  //    para avisar.
  //
  //  · El botón rojo — eso sí despierta a alguien.
  function auxCtaBar(t, closed) {
    if (closed) return '';
    const isLle = t.type === 'lle';
    const puedeConfirmar = t.status === 'assigned' && !t.readyAt;
    if (!puedeConfirmar && !t.driver) return '';
    const confirmar = puedeConfirmar
      ? `<button class="ax-btn ax-btn-primary" data-ax="confirm-pickup"><svg class="icon"><use href="#i-check"/></svg>${
          isLle ? 'Sin novedad, bajo a tiempo' : 'Confirmar mi recogida'}</button>`
      : '';
    // El botón rojo aparece desde que hay traslado en pie: la emergencia no
    // espera a que asignen conductor.
    const alarma = `<button class="ax-btn ax-alarm-btn" data-ax="alarm" aria-label="Tengo una novedad"><svg class="icon"><use href="#i-warn"/></svg></button>`;
    return `<div class="ax-cta-bar">${confirmar}${alarma}</div>`;
  }

  // Hoja del botón rojo. Tres motivos y listo: quien lo aprieta está de afán.
  const AUX_ALARM = [
    { id: 'medica',      label: 'Emergencia médica a bordo', sev: 'high' },
    { id: 'desembarque', label: 'Se va a demorar el desembarque', sev: 'medium' },
    { id: 'otra',        label: 'Otra cosa que me va a retrasar', sev: 'medium' },
  ];
  function auxAlarmHTML(t) {
    if (auxShellOn() && window.AuxRxViaje && typeof AuxRxViaje.alarmHTML === 'function') return AuxRxViaje.alarmHTML(t);
    const a = auxState.alarm || {};
    return `<div class="ax-alarm" id="ax-alarm">
      <div class="ax-alarm-card">
        <div class="ax-alarm-head">
          <b>¿Qué está pasando?</b>
          <button class="ax-icbtn" data-ax="alarm-close" aria-label="Cerrar"><svg class="icon"><use href="#i-x"/></svg></button>
        </div>
        <p class="ax-alarm-lead">Esto le llega de una vez a coordinación${t.driver ? ' y a ' + t.driver.name.split(' ')[0] : ''}.</p>
        <div class="ax-alarm-opts">
          ${AUX_ALARM.map(o => `<button class="ax-alarm-opt${a.motivo === o.id ? ' on' : ''}" data-ax="alarm-pick" data-v="${o.id}">${o.label}</button>`).join('')}
        </div>
        <textarea class="ax-input" id="ax-alarm-text" rows="2" maxlength="400" placeholder="¿Algo más que debamos saber? (opcional)">${a.text || ''}</textarea>
        <div class="ax-alarm-acts">
          <button class="ax-btn ax-btn-ghost" data-ax="alarm-close">Volver</button>
          <button class="ax-btn ax-btn-danger" data-ax="alarm-send"${a.sending ? ' disabled' : ''}>${a.sending ? 'Enviando…' : 'Avisar ahora'}</button>
        </div>
      </div>
    </div>`;
  }

  // Cancelar en dos toques (no usamos confirm() nativo: bloquea la PWA y se ve
  // como un error del navegador, no como una decisión de la app).
  function auxCancelBlock(t) {
    if (!auxState.confirmingCancel) {
      return `<button class="ax-link ax-cancel-link" data-ax="cancel-trip">Cancelar este traslado</button>`;
    }
    return `<div class="ax-cancel-box">
      <b>¿Cancelar tu traslado?</b>
      <span>${t.driver ? 'Le avisamos a ' + t.driver.name.split(' ')[0] + ' y sale de su ruta.' : 'Sale de la planeación del día.'} No se puede deshacer: tendrías que pedirlo otra vez.</span>
      <input class="ax-input" id="ax-cancel-reason" type="text" placeholder="Motivo (opcional): vuelo cancelado, cambio de horario…" />
      <div class="ax-cancel-acts">
        <button class="ax-btn ax-btn-ghost" data-ax="cancel-abort">No, seguir</button>
        <button class="ax-btn ax-btn-danger" data-ax="cancel-do">Sí, cancelar</button>
      </div>
    </div>`;
  }

  // P3: conductor en camino — mapa en vivo
  function auxTrackOnWay(t) {
    return `
      ${auxTripHead('Conductor en camino')}
      <div id="ax-track-map" class="ax-track-map"></div>
      <div class="ax-track-sheet">
        <div class="ax-eta-hero"><span id="ax-eta-label">Tu conductor</span><b id="ax-eta-min">En camino</b></div>
        <div class="ax-etaline hidden" id="ax-eta"></div>
        <div class="ax-count hidden" id="ax-count"></div>
        <div class="ax-wait hidden" id="ax-wait"></div>
        <div id="ax-late-wrap">${auxLateHTML(t, t._info)}</div>
        ${auxDriverCard(t.driver, false)}
        <div class="ax-track-fresh" id="ax-track-fresh"></div>
        <button class="ax-btn ax-btn-ghost" data-ax="share-eta"><svg class="icon"><use href="#i-send"/></svg>Compartir mi ETA</button>
      </div>
      ${auxChatHTML(t)}`;
  }
  // P4: a bordo. OJO: "a bordo" no significa "ya vamos al destino" — el carro
  // puede tener casas por delante. El badge lo dice en vez de darlo por hecho.
  function auxOnBoardBadge(t, info) {
    const falta = auxPendingAhead(t, info);
    const dest = t.type === 'lle' ? auxShortAddr(t.address) : 'Aeropuerto MDE';
    if (falta > 0) {
      const quien = falta === 1 ? 'un compañero' : `${falta} compañeros`;
      const txt = t.type === 'lle'
        ? `Dejamos a ${quien} antes que a ti`
        : `Recogemos a ${quien} antes de ir al aeropuerto`;
      return `<svg class="icon"><use href="#i-clock"/></svg>${txt}`;
    }
    return `<svg class="icon"><use href="#i-check"/></svg>En camino a ${dest}`;
  }
  function auxTrackOnBoard(t) {
    return `
      ${auxTripHead('A bordo')}
      <div id="ax-track-map" class="ax-track-map"></div>
      <div class="ax-track-sheet">
        <div class="ax-onboard-badge${auxPendingAhead(t, t._info) > 0 ? ' wait' : ''}" id="ax-onboard-badge">${auxOnBoardBadge(t, t._info)}</div>
        <!-- Aquí es donde la escala de demora dice algo de verdad: a bordo y con
             ETA vivo al aeropuerto se puede dar el margen exacto contra la
             presentación, que es la única pregunta que el pasajero tiene. -->
        <div id="ax-late-wrap">${auxLateHTML(t, t._info)}</div>
        <div class="ax-eta-hero"><span id="ax-eta-label">${t.type === 'lle' ? 'Vas a casa' : 'Vas al aeropuerto'}</span><b id="ax-eta-min">En ruta</b></div>
        <div class="ax-etaline hidden" id="ax-eta"></div>
        <div class="ax-count" id="ax-count"></div>
        ${auxDriverCard(t.driver, false)}
        <div class="ax-track-fresh" id="ax-track-fresh"></div>
      </div>
      ${auxChatHTML(t)}`;
  }
  // P5: calificación (sin propina — servicio mensual)
  function auxRating(t) {
    const r = auxState.ratingSel || 0;
    const goodTags = ['Puntual', 'Carro limpio', 'Conducción suave', 'Amable'];
    const badTags = ['Llegó tarde', 'Carro sucio', 'Conducción brusca', 'Otro'];
    const tags = r >= 4 ? goodTags : r > 0 ? badTags : [];
    return `
      ${auxTripHead('Califica tu viaje')}
      <div class="ax-body ax-center">
        <div class="ax-driver-av lg">${t.driver.name[0] || 'C'}</div>
        <h1 class="ax-big">¿Cómo estuvo con ${t.driver.name.split(' ')[0]}?</h1>
        <p class="ax-lead ax-tc">Tu opinión ayuda a mejorar el servicio. Es opcional.</p>
        <div class="ax-stars">
          ${[1, 2, 3, 4, 5].map(n => `<button class="ax-star ${n <= r ? 'on' : ''}" data-ax="star" data-n="${n}"><svg class="icon"><use href="#i-check"/></svg>★</button>`).join('')}
        </div>
        ${r > 0 ? `<div class="ax-tags">${tags.map(t => `<button class="ax-tag ${(auxState.ratingTags || []).includes(t) ? 'on' : ''}" data-ax="tag" data-tag="${t}">${t}</button>`).join('')}</div>` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">
        <button class="ax-btn ax-btn-primary" data-ax="rate-send" ${r === 0 ? 'disabled' : ''}>${r === 0 ? 'Toca una estrella' : 'Enviar calificación'}</button>
        <button class="ax-link ax-skip" data-ax="rate-skip">Ahora no</button>
      </div>`;
  }

  // ---------- seguimiento del viaje ----------
  // En vivo (source==='live') → posición REAL del conductor vía RPC.
  // Demo (presentaciones)      → la animación de siempre.
  function auxAfterTripRender() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) return;
    // Desde 'pending' ya seguimos: la pantalla avanza sola cuando el admin
    // publica el plan (→ conductor) y cuando el conductor arranca (→ mapa).
    if (['pending', 'assigned', 'onway', 'onboard'].includes(t.status)) auxStartLiveTrack(t);
    // El chat vive dentro de esta pantalla y el render la rehace entera: si
    // estaba abierto (p. ej. el viaje pasó a "a bordo" mientras escribía), se
    // vuelve a abrir en vez de cerrarse en la cara del usuario.
    if (t.driver && document.getElementById('ax-chat')) {
      if (auxState.chatOpen) auxChatOpen();
      else auxChatSync(false);        // trae el badge de no leídos
    }
  }
  function auxStopTrack() {
    if (auxState.chatPoll) { clearInterval(auxState.chatPoll); auxState.chatPoll = null; }
    if (auxState.trackPoll) { clearInterval(auxState.trackPoll); auxState.trackPoll = null; }
    if (auxState.trackTween) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    if (auxState.waitTick) { clearInterval(auxState.waitTick); auxState.waitTick = null; }
    if (auxState.trackMap) { auxState.trackMap.remove(); auxState.trackMap = null; }
    auxState.trackCar = null; auxState.trackLine = null; auxState.trackLast = null; auxState.trackDestPt = null;
    auxState.trackDestMk = null; auxState.stopLayer = null; auxState.stopSig = null;
    auxState.waitFrom = null;
    // Estado de la vía real: al cambiar de vista se recalcula desde cero.
    auxState.routePath = null; auxState.routeFrom = null; auxState.routeDestKey = null; auxState.routeAt = 0;
    auxState.etaSecs = null; auxState.etaAt = 0; auxState.etaKind = null; auxState.etaTrip = null;
    auxState.hudPhase = null;
  }

  // ---------- espera en el punto de recogida ----------
  // El "máx. 3 min" era un letrero fijo: no contaba nada y al vencerse no pasaba
  // nada. Ahora es un reloj real que arranca en la hora en que el conductor
  // marcó "llegué" (route_stops.actual_arrival_at) y dura los minutos que diga
  // Ajustes — el MISMO número que habilita el "no se presentó" del conductor.
  function auxStartWait(arrivedAtISO, minutes) {
    const from = new Date(arrivedAtISO).getTime();
    if (isNaN(from)) return;
    if (auxState.waitFrom === from && auxState.waitTick) return; // ya corriendo
    auxState.waitFrom = from;
    auxState.waitMin = minutes || 5;
    if (auxState.waitTick) clearInterval(auxState.waitTick);
    auxPaintWait();
    auxState.waitTick = setInterval(auxPaintWait, 1000);
  }
  function auxPaintWait() {
    const el = document.getElementById('ax-wait');
    if (!el || auxState.waitFrom == null) return;
    const left = Math.round((auxState.waitFrom + auxState.waitMin * 60000 - Date.now()) / 1000);
    el.classList.remove('hidden');
    if (left > 0) {
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
      el.className = 'ax-wait';
      el.innerHTML = `<span>Tu conductor te espera</span><b>${mm}:${ss}</b>`;
    } else {
      el.className = 'ax-wait over';
      el.innerHTML = `<span>Tiempo de espera cumplido</span><b>Sal ya o llámalo</b>`;
      if (auxState.waitTick) { clearInterval(auxState.waitTick); auxState.waitTick = null; }
    }
  }
  function auxStopWait() {
    if (auxState.waitTick) { clearInterval(auxState.waitTick); auxState.waitTick = null; }
    auxState.waitFrom = null;
    const el = document.getElementById('ax-wait');
    if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  }

  // ---------- seguimiento EN VIVO (datos reales) ----------
  // Paradas que el carro todavía no ha visitado, en orden de visita (RPC 0051).
  // De los compañeros solo llega sector + coordenada redondeada: nunca su nombre
  // ni su dirección.
  function auxPendingStops(t, info) {
    if (!info || !Array.isArray(info.next_stops)) return [];
    // En una salida, una vez a bordo mi parada ya está hecha aunque el RPC me la
    // mande (la manda siempre para poder ubicarme en el recorrido).
    const mineDone = t.type === 'sal' && t.status === 'onboard';
    return info.next_stops.filter(s => s && s.lat != null && !(mineDone && s.mine));
  }
  // Cuántas paradas de OTROS me faltan por delante. Es lo que hace que "ya vamos
  // al aeropuerto" sea mentira cuando uno se monta de segundo en un carro de tres.
  //   salida  → los que faltan por recoger después de mí (remaining_after)
  //   llegada → los que dejan antes que a mí (remaining_before)
  function auxPendingAhead(t, info) {
    if (!info) return 0;
    const n = t.type === 'lle' ? info.remaining_before : info.remaining_after;
    return typeof n === 'number' && n > 0 ? n : 0;
  }
  // A dónde va el carro AHORA MISMO (para pintar el punto destino y la línea).
  // Antes esto saltaba directo al destino final del viaje; si quedaban casas por
  // visitar, el mapa dibujaba una vía al aeropuerto que el carro no iba a tomar.
  // La siguiente parada real es la pendiente de menor orden — sirve para las dos
  // direcciones: en salida son recogidas, en llegada son entregas.
  function auxTrackDest(t, info) {
    const pend = auxPendingStops(t, info);
    if (t.status === 'onboard' && pend.length) return { lat: pend[0].lat, lng: pend[0].lng };
    if (t.type === 'lle') return t.status === 'onboard' ? { lat: t.lat, lng: t.lng } : AUX_MDE;
    return t.status === 'onboard' ? AUX_MDE : { lat: t.lat, lng: t.lng };
  }
  function auxDistM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Frescura del punto: no le creemos ciegamente a un GPS viejo.
  function auxFreshLabel(pos) {
    if (!pos || pos.at == null) return { text: 'Esperando señal del conductor…', stale: true };
    const secs = Math.max(0, Math.round((Date.now() - new Date(pos.at).getTime()) / 1000));
    const ago = secs < 10 ? 'ahora' : secs < 60 ? `hace ${secs} s` : `hace ${Math.round(secs / 60)} min`;
    const src = pos.source === 'anchor' ? 'última parada' : 'GPS';
    return { text: `${src} · ${ago}`, stale: secs > 120 };
  }

  function auxStartLiveTrack(t) {
    auxState.trackLast = null;
    auxTrackTick(t);                                       // primer tick inmediato
    auxState.trackPoll = setInterval(() => auxTrackTick(t), 6000);
  }
  async function auxTrackTick(t) {
    if (auxState.view !== 'trip' || auxState.editingTrip !== t.id) return;
    let info = null;
    try { if (window.Api?.trackReservation) info = await Api.trackReservation(t.id); } catch (_) {}
    // El await pudo tardar: si el usuario cambió de vista/viaje, abortamos.
    if (auxState.view !== 'trip' || auxState.editingTrip !== t.id) return;
    if (!info) return;
    t._info = info;                                   // para el banner "va tarde"

    // Cancelada mientras la miraba (la canceló el admin, u otro dispositivo suyo):
    // antes el RPC devolvía NULL y el auxiliar se quedaba viendo "en camino".
    if (info.cancelled) {
      if (t.status !== 'cancelled') { t.status = 'cancelled'; auxRender(); }
      return;
    }

    // ¿Recién llega el dato del conductor? Al recargar la app ya "en camino", la
    // tarjeta se pintó genérica ("Tu conductor / Carro —") antes de este primer
    // dato; hay que re-hidratarla aunque el estado no cambie.
    const driverJustArrived = !!(info.driver && info.driver.name) && !(t.driver && t.driver.name);
    // FUSIONA, no reemplaza (#6, 27-sep-2026). Antes cada tic de 6 s dejaba
    // t.driver = {name, plate, phone, rating:null}: borraba la foto, la
    // calificación y el teléfono que hubiera traído la lista de viajes.
    const nuevos = auxMergeTrack(t, info);
    // Avance real → estado UI. 'assigned' lo marca info.assigned (la reserva quedó
    // en una ruta con conductor), aunque el estado crudo siga en 'scheduled'/
    // 'requested'. El estado crudo solo AGREGA progresión (en camino/a bordo/entregado).
    let ui;
    if (info.assigned) {
      const prog = auxUiStatus(info.raw_status);
      ui = AUX_ORDER[prog] > AUX_ORDER.assigned ? prog : 'assigned';
    } else {
      ui = auxUiStatus(info.raw_status);
    }
    // Solo AVANZA (nunca retrocede), para no dar tumbos de pantalla. Un viaje
    // cancelado o «no se presentó» es final: el rastreo no lo revive.
    if (t.status !== 'cancelled' && t.status !== 'noshow' && AUX_ORDER[ui] > (AUX_ORDER[t.status] || 0)) {
      t.status = ui;
      auxRender();          // cambia de pantalla; el nuevo render re-arranca el rastreo
      return;
    }
    // Escala de demora contra la presentación. Se refresca en cada tic del
    // rastreo (6 s), así que a bordo el margen baja en vivo con el ETA.
    auxRefreshLate(t);
    // Hidrata la tarjeta del conductor la 1ª vez que llega su dato, en CUALQUIER
    // pantalla que la muestre (asignado/en camino/a bordo), no solo al cambiar de
    // estado — arregla el caso de recargar la app con el viaje ya en curso.
    // Con el rediseño, lo mismo cuando aparece por primera vez algo que la
    // pantalla pinta (hora publicada, código, carro, foto): el shell lo
    // resuelve por patch sin tumbar el mapa.
    if ((driverJustArrived || (nuevos && auxShellOn())) && ['assigned', 'onway', 'onboard'].includes(t.status)) {
      auxRender();
      return;
    }
    // Fase «llegó» y código de encuentro, sin repintar (§3.7, #5).
    auxPaintPhase(t, info);
    auxPaintMeet(t, info);
    if (t.status === 'onway' || t.status === 'onboard') {
      auxPlotDriver(t, info);
    }
    // Mensajes nuevos del conductor con la pantalla abierta: el push avisa
    // cuando la app está cerrada, esto mantiene el globito al día mientras mira.
    if (t.driver && !auxState.chatOpen) auxChatSync(false);
    // ¿El vigilante marcó este traslado como demorado? Se consulta cada ~30 s
    // (el vigilante corre cada 5 min, no tiene sentido preguntar más seguido).
    if (window.Api?.getReservationRisk && Date.now() - (auxState.riskAt || 0) > 30000) {
      auxState.riskAt = Date.now();
      Api.getReservationRisk(t.id).then(r => {
        const antes = t._risk ? t._risk.minutes_late : 0;
        t._risk = r;
        if ((r ? r.minutes_late : 0) !== antes) auxRefreshLate(t);
      }).catch(() => {});
    }
  }

  // ---------- fusión del rastreo sobre el viaje (#6) ----------
  // Lo que trae auxiliar_track_reservation (v4 hoy; v5 con 0087) se SUMA a lo
  // que el viaje ya sabía. Nunca borra con un vacío. Si cambió el conductor (lo
  // reasignaron), su ficha se arma de cero: la foto o el teléfono del anterior
  // no pueden quedar pegados al nuevo.
  // Devuelve true si apareció algo que antes no estaba (para repintar una vez).
  function auxMergeTrack(t, info) {
    let nuevo = false;
    const d = info.driver;
    if (d && d.name) {
      const mismo = !!(t.driver && t.driver.name === d.name);
      const base = mismo ? t.driver : {};
      const drv = Object.assign({}, base, {
        name: d.name,
        first: String(d.name).trim().split(/\s+/)[0] || '',
        initials: auxInitials(d.name),
        phone: d.phone || base.phone || '',
        // La placa sigue en driver.plate para lo heredado ('—' = sin dato).
        plate: info.plate || base.plate || '—',
      });
      if (!('rating' in drv)) drv.rating = null;
      if (d.avatar_url && d.avatar_url !== base.avatarUrl) { drv.avatarUrl = d.avatar_url; nuevo = true; }
      if (d.rating != null) drv.rating = d.rating;
      if (d.rating_n != null) drv.ratingN = d.rating_n;
      if (!mismo && t.driver && t.driver.name) nuevo = true;   // lo reasignaron
      t.driver = drv;
    }
    const v = info.vehicle || null;
    if (info.plate || (v && (v.brand || v.model || v.color))) {
      const veh = Object.assign({}, t.vehicle || {});
      if (info.plate) { if (veh.plate && veh.plate !== info.plate) nuevo = true; veh.plate = info.plate; }
      ['brand', 'model', 'color'].forEach(k => {
        if (v && v[k] && v[k] !== veh[k]) { veh[k] = v[k]; nuevo = true; }
      });
      t.vehicle = veh;
    }
    if (info.pickup_at && info.pickup_at !== t.pickupAt) { t.pickupAt = info.pickup_at; nuevo = true; }
    if (info.meet_code && info.meet_code !== t.meetCode) { t.meetCode = String(info.meet_code); nuevo = true; }
    if (info.stop_status) t.stopStatus = info.stop_status;
    if (info.arrived_at) t.arrivedAt = info.arrived_at;
    return nuevo;
  }
  function auxInitials(name) {
    const p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '')[0] || '').toUpperCase() + ((p.length > 1 ? p[p.length - 1][0] : '') || '').toUpperCase();
  }

  // ---------- fases del viaje (#ax-phase, §3.7) ----------
  // Las del diseño (RX_TRIP_STEPS) con sus mismas claves. «Llegó por ti» NO
  // es un estado de AUX_ORDER (cambiaría el avance y _auxTripStatus): sale del
  // estado de la parada que reporta el rastreo (stop_status === 'arrived').
  const AUX_PH_SAL = [['booked', 'Pedido'], ['assigned', 'Conductor asignado'], ['enroute', 'En camino'],
    ['arrived', 'Llegó por ti'], ['onboard', 'A bordo'], ['done', 'En el aeropuerto']];
  const AUX_PH_LLE = [['booked', 'Pedido'], ['assigned', 'Conductor asignado'], ['onboard', 'A bordo'],
    ['homebound', 'Rumbo a casa'], ['done', 'En casa']];
  function auxPhaseKey(t, info) {
    if (!t) return null;
    const s = t.status;
    if (s === 'cancelled' || s === 'noshow') return null;
    const llego = !!((info && info.stop_status === 'arrived') || t.stopStatus === 'arrived');
    if (t.type === 'lle') {
      if (s === 'done') return 'done';
      // A bordo mientras dejan a otros antes que a mí; «rumbo a casa» cuando
      // la siguiente parada es la mía.
      if (s === 'onboard') return auxPendingAhead(t, info) > 0 ? 'onboard' : 'homebound';
      if (s === 'assigned' || s === 'onway') return 'assigned';
      return 'booked';
    }
    if (s === 'done') return 'done';
    if (s === 'onboard') return 'onboard';
    if (s === 'onway') return llego ? 'arrived' : 'enroute';
    if (s === 'assigned') return llego ? 'arrived' : 'assigned';
    return 'booked';
  }
  function auxPhases(t, info) {
    const list = (t && t.type === 'lle') ? AUX_PH_LLE : AUX_PH_SAL;
    const current = auxPhaseKey(t, info);
    return { steps: list.map(([key, label]) => ({ key, label })), current, index: list.findIndex(x => x[0] === current) };
  }
  // Marca la fase actual en #ax-phase sin repintar: cada paso lleva
  // data-ph="<clave>" y la clase rx-tl-s; queda .done antes y .now en la actual
  // (las mismas clases del diseño).
  function auxPaintPhase(t, info) {
    const box = document.getElementById('ax-phase'); if (!box) return;
    const ph = auxPhases(t, info);
    const keys = ph.steps.map(s => s.key);
    box.querySelectorAll('[data-ph]').forEach(el => {
      const i = keys.indexOf(el.getAttribute('data-ph'));
      el.classList.toggle('done', ph.index >= 0 && i >= 0 && i < ph.index);
      el.classList.toggle('now', ph.index >= 0 && i === ph.index);
    });
    box.setAttribute('data-now', ph.current || '');
  }

  // ---------- código de encuentro (§3.7) ----------
  function auxMeetVisible(t, info) {
    if (!t || !t.meetCode || AUX_CLOSED.includes(t.status) || t.status === 'onboard') return false;
    if (t.type === 'lle') return !!t.driver && ['assigned', 'onway'].includes(t.status) && t.date === auxTodayISO();
    return t.status === 'onway' || !!((info && info.stop_status === 'arrived') || t.stopStatus === 'arrived');
  }
  // Resalta #ax-meet cuando el conductor llegó (la pantalla ya lo pintó si
  // meetVisible). Al pasar a «llegó» se RECREAN los dígitos (.rx-meet-c) para
  // que la animación rxFlip corra otra vez, como el re-montaje del diseño.
  function auxPaintMeet(t, info) {
    const el = document.getElementById('ax-meet'); if (!el) return;
    const llego = !!(info && info.stop_status === 'arrived');
    const antes = el.classList.contains('is-arrived');
    el.classList.toggle('is-arrived', llego);
    el.setAttribute('data-arrived', llego ? '1' : '0');
    if (llego && !antes) {
      const c = el.querySelector('.rx-meet-c');
      if (c) c.replaceWith(c.cloneNode(true));
    }
  }

  // Pinta el mapa: destino fijo + carro que se desliza ENTRE dos reportes reales.
  // No extrapola: al llegar al último punto conocido, se queda quieto.
  function auxPlotDriver(t, info) {
    auxUpdateTrackHUD(t, info);
    const el = document.getElementById('ax-track-map');
    if (!el || typeof L === 'undefined') return;
    const d = auxTrackDest(t, info);
    const destPt = [d.lat, d.lng];
    const driverPt = info.pos ? [info.pos.lat, info.pos.lng] : null;

    // Primer montaje de esta fase.
    if (!auxState.trackMap) {
      const map = auxState.trackMap = L.map(el, { zoomControl: false, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      auxState.trackDestPt = destPt;
      auxState.trackDestMk = auxShellOn()
        // Rediseño: el destino es un pin del sistema rx (§1.5). Aeropuerto o casa
        // según a dónde va el carro AHORA (la siguiente parada es otra cosa).
        ? L.marker(destPt, { icon: auxLfIcon(auxDestIsApt(t, info) ? 'apt' : 'pin'), interactive: false }).addTo(map)
        : L.circleMarker(destPt, { radius: 8, color: '#F26522', fillColor: '#F26522', fillOpacity: 1, weight: 3 }).addTo(map);
      auxPlotStops(t, info);
      if (driverPt) { auxMountCar(t, info, driverPt, destPt); map.fitBounds([driverPt, destPt], { padding: [55, 55] }); }
      else { map.setView(destPt, 14); }
      setTimeout(() => map.invalidateSize(), 60);
      // La capa del viaje entra deslizando (rxIn .34s): Leaflet midió el
      // contenedor a medio camino, así que se vuelve a medir al terminar.
      if (auxShellOn()) setTimeout(() => { if (auxState.trackMap === map) map.invalidateSize(); }, 360);
      return;
    }
    // El carro terminó una parada y arrancó para la siguiente: el destino cambia
    // sin cambiar de pantalla, así que hay que moverlo (antes quedaba clavado en
    // el punto del primer montaje y la vía apuntaba a donde el carro ya no iba).
    if (auxState.trackDestPt && auxDistM(auxState.trackDestPt, destPt) > 30) {
      auxState.trackDestPt = destPt;
      if (auxState.trackDestMk) auxState.trackDestMk.setLatLng(destPt);
      if (driverPt) auxState.trackMap.fitBounds([driverPt, destPt], { padding: [55, 55] });
    }
    auxPlotStops(t, info);
    if (!driverPt) return;                                 // aún sin ping: dejamos el destino
    if (!auxState.trackCar) {                              // el carro apareció tras el montaje
      auxMountCar(t, info, driverPt, destPt);
      auxState.trackMap.fitBounds([driverPt, destPt], { padding: [55, 55] });
      return;
    }
    const last = auxState.trackLast;
    if (last && auxDistM(last, driverPt) > 2000) {
      // Salto grande (señal perdida): no inventamos el trayecto — saltamos.
      auxState.trackCar.setLatLng(driverPt);
      if (auxState.trackLine && !auxState.routePath) auxState.trackLine.setLatLngs([driverPt, auxState.trackDestPt]);
    } else if (!last || auxDistM(last, driverPt) > 3) {
      auxTweenCar(last || driverPt, driverPt);
    }
    auxState.trackLast = driverPt;
    // Redibuja la vía real desde donde va el carro (con freno: ver auxSyncRoute).
    auxSyncRoute(t, info, driverPt, destPt);
  }
  // Dibuja lo que FALTA del recorrido: cada parada pendiente numerada en orden de
  // visita y el destino final (MDE o tu casa). Antes el mapa solo tenía el carro y
  // un punto, así que el que iba a bordo no veía por qué el viaje seguía dando vueltas.
  function auxPlotStops(t, info) {
    const map = auxState.trackMap; if (!map) return;
    const pend = t.status === 'onboard' ? auxPendingStops(t, info) : [];
    // Firma del recorrido pendiente: si no cambió, no se repinta (tick de 6 s).
    const sig = pend.map(s => `${s.order}:${s.lat},${s.lng}`).join('|');
    if (sig === auxState.stopSig) return;
    auxState.stopSig = sig;
    if (auxState.stopLayer) { map.removeLayer(auxState.stopLayer); auxState.stopLayer = null; }
    // Sin paradas pendientes, el punto naranja de destino vuelve a ser el protagonista.
    const dmk = auxState.trackDestMk;
    if (dmk) {
      if (typeof dmk.setStyle === 'function') dmk.setStyle(pend.length ? { opacity: 0, fillOpacity: 0 } : { opacity: 1, fillOpacity: 1 });
      else if (typeof dmk.setOpacity === 'function') dmk.setOpacity(pend.length ? 0 : 1);
    }
    if (!pend.length) return;
    const layer = auxState.stopLayer = L.layerGroup().addTo(map);
    const rx = auxShellOn();
    pend.forEach((s, i) => {
      const mine = !!s.mine;
      const cls = `${rx ? 'rx-lf-stop' : 'ax-stop'}${i === 0 ? ' next' : ''}${mine ? ' mine' : ''}`;
      const icon = L.divIcon({ className: '', html: `<div class="${cls}">${mine ? '★' : i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      // De los compañeros solo se nombra el sector: nunca quién es ni dónde vive.
      const label = mine ? 'Tu parada' : (s.sector ? `Recogida · ${s.sector}` : 'Otra recogida');
      L.marker([s.lat, s.lng], { icon }).addTo(layer).bindTooltip(label, { direction: 'top', offset: [0, -14] });
    });
    // Destino final. En una llegada mi casa YA es una de las paradas: no se repite.
    if (t.type !== 'sal' && pend.some(s => s.mine)) return;
    const isApt = t.type === 'sal';
    const finalPt = isApt ? [AUX_MDE.lat, AUX_MDE.lng] : [t.lat, t.lng];
    if (finalPt[0] == null) return;
    const fIcon = rx ? auxLfIcon(isApt ? 'apt' : 'pin')
      : L.divIcon({ className: '', html: `<div class="ax-stop end">${isApt ? '✈' : '🏠'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(finalPt, { icon: fIcon }).addTo(layer).bindTooltip(isApt ? 'Aeropuerto MDE' : 'Tu casa', { direction: 'top', offset: [0, -14] });
  }

  // Marcadores Leaflet del rediseño (§1.5): L.divIcon con las clases rx-lf-*
  // que estiliza rx-aux-app.css (P1). El dibujo va con el sprite rx (#rx-*) si
  // AuxRxUI está; si no, el contenedor vacío (lo pinta el CSS).
  //   car → <div class="rx-lf-car">…</div>   apt → rx-lf-apt   pin → rx-lf-pin
  function auxLfIcon(kind) {
    const ICN = { car: 'Car', apt: 'Plane', pin: 'Home' };
    let inner = '';
    try { if (window.AuxRxUI && typeof AuxRxUI.ic === 'function') inner = AuxRxUI.ic(ICN[kind] || 'MapPin', kind === 'car' ? 16 : 14); } catch (_) {}
    const size = kind === 'car' ? 34 : 30;
    return L.divIcon({ className: '', html: `<div class="rx-lf-${kind}">${inner}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  // ¿El destino inmediato del carro es el aeropuerto? (salida a bordo sin más
  // paradas, o llegada con el carro yendo a MDE por mí).
  function auxDestIsApt(t, info) {
    const pend = auxPendingStops(t, info);
    if (t.status === 'onboard' && pend.length) return false;
    return t.type === 'lle' ? t.status !== 'onboard' : t.status === 'onboard';
  }
  // El color de la vía: el acento del sistema rx si está definido.
  function auxRouteColor() {
    if (!auxShellOn()) return '#F4791F';
    try {
      const v = getComputedStyle(auxRoot()).getPropertyValue('--r-accent').trim();
      return v || '#F26522';
    } catch (_) { return '#F26522'; }
  }

  function auxMountCar(t, info, driverPt, destPt) {
    const carIcon = auxShellOn() ? auxLfIcon('car')
      : L.divIcon({ className: '', html: '<div class="ax-car">🚗</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
    // Arranca como línea recta punteada (es lo único cierto mientras OSRM
    // responde) y auxSyncRoute la reemplaza por la vía real en cuanto llega.
    auxState.trackLine = L.polyline([driverPt, destPt], { color: auxRouteColor(), weight: 4, opacity: .45, dashArray: '6 8' }).addTo(auxState.trackMap);
    auxState.trackCar = L.marker(driverPt, { icon: carIcon }).addTo(auxState.trackMap);
    auxState.trackLast = driverPt;
    auxSyncRoute(t, info, driverPt, destPt);
  }

  // ---------- trayecto REAL por carretera (OSRM) ----------
  // El auxiliar veía una línea recta del carro a su casa, que cruzaba potreros y
  // no decía nada del camino real. El conductor y el admin ya pintaban la vía
  // (OSRM); esto le da lo mismo al pasajero.
  //
  // OSRM es el servidor público de demo y pide uso ligero: solo se vuelve a
  // pedir si el carro se movió de verdad (>250 m), si cambió el destino (cambio
  // de fase del viaje) o si pasó un minuto. Mismo criterio que admin-operacion.
  const AUX_OSRM_MOVE_M = 250;
  const AUX_OSRM_MAX_MS = 60000;
  // Lo que tarda cada recogida (parar, subir a alguien con maleta, arrancar).
  // Mismo estimado que ya usa el tablero del admin para calcular las vueltas.
  const AUX_STOP_MIN = 3;

  // El camino que le QUEDA al carro, en orden, y cuál de esos puntos es el que a
  // mí me importa: mi recogida si todavía no me he montado, o mi destino si ya
  // voy adentro. En una llegada mi destino es mi casa aunque después dejen a más
  // gente — mi hora no es la del final de la ruta.
  function auxRouteAhead(t, info, driverPt) {
    const pts = [driverPt];
    if (t.type === 'lle' && t.status !== 'onboard') {
      // Llegada y aún no me monto: el carro va al aeropuerto por mí.
      return { pts: pts.concat([[AUX_MDE.lat, AUX_MDE.lng]]), target: 1 };
    }
    const pend = auxPendingStops(t, info);
    let target = -1;
    if (!pend.length && t.status !== 'onboard' && t.lat != null) {
      // Sin detalle de paradas (RPC viejo): al menos sé a dónde vienen por mí.
      return { pts: pts.concat([[t.lat, t.lng]]), target: 1 };
    }
    pend.forEach(s => { pts.push([s.lat, s.lng]); if (s.mine) target = pts.length - 1; });
    if (t.type === 'sal') {
      pts.push([AUX_MDE.lat, AUX_MDE.lng]);        // una salida siempre termina en MDE
      if (target < 0) target = pts.length - 1;     // ya me recogieron → me importa el aeropuerto
    } else if (target < 0 && t.lat != null) {
      pts.push([t.lat, t.lng]); target = pts.length - 1;
    }
    return { pts, target: target < 0 ? pts.length - 1 : target };
  }

  async function auxSyncRoute(t, info, driverPt, destPt) {
    if (!auxState.trackLine || !driverPt || !destPt) return;
    const ahead = auxRouteAhead(t, info, driverPt);
    // La clave incluye TODAS las paradas: si el conductor cierra una, el camino
    // que falta cambia aunque el destino inmediato siga siendo el mismo.
    const destKey = ahead.pts.slice(1).map(p => p.join(',')).join('|') + '#' + ahead.target;
    const movio = !auxState.routeFrom || auxDistM(auxState.routeFrom, driverPt) > AUX_OSRM_MOVE_M;
    const otroDestino = auxState.routeDestKey !== destKey;
    const viejo = Date.now() - (auxState.routeAt || 0) > AUX_OSRM_MAX_MS;
    if (!movio && !otroDestino && !viejo) return;
    // Se marca ANTES de pedir: si no, cada tick de 6 s dispara otra petición.
    auxState.routeFrom = driverPt; auxState.routeDestKey = destKey; auxState.routeAt = Date.now();

    const r = await auxRoadRoute(ahead.pts);
    // Pudo cambiar de vista/viaje mientras OSRM respondía.
    if (!auxState.trackLine || auxState.routeDestKey !== destKey) return;
    const path = r && r.path;
    if (path && path.length > 1) {
      auxState.routePath = path;
      auxState.trackLine.setLatLngs(path);
      auxState.trackLine.setStyle({ dashArray: null, opacity: .75, weight: 5 });
    } else {
      // Sin respuesta de OSRM se deja la recta, pero PUNTEADA: el punteado dice
      // "esto es la dirección, no el camino". No se finge una vía que no sabemos.
      auxState.routePath = null;
      auxState.trackLine.setStyle({ dashArray: '6 8', opacity: .45, weight: 4 });
    }
    // Hora estimada: suma de los tramos hasta MI punto + lo que toma cada
    // recogida intermedia. Si OSRM no contestó, no se muestra nada: es mejor no
    // decir hora que decir una inventada.
    const legs = r && r.legs;
    if (legs && legs.length >= ahead.target && ahead.target > 0) {
      let secs = 0;
      for (let i = 0; i < ahead.target; i++) secs += legs[i] || 0;
      secs += AUX_STOP_MIN * 60 * Math.max(0, ahead.target - 1);
      auxState.etaSecs = secs;
      auxState.etaAt = Date.now();
      auxState.etaKind = (t.status === 'onboard') ? 'dest' : 'pickup';
      auxState.etaTrip = t.id;
    } else {
      auxState.etaSecs = null; auxState.etaAt = 0; auxState.etaTrip = null;
    }
    auxRenderEta(t, info);
  }
  // OSRM con N puntos: devuelve la vía completa y la duración de cada tramo.
  async function auxRoadRoute(pts) {
    if (!pts || pts.length < 2) return null;
    try {
      const coords = pts.map(p => `${p[1]},${p[0]}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      const j = await (await fetch(url)).json();
      const r = j && j.code === 'Ok' && j.routes && j.routes[0];
      if (!r) return null;
      const c = r.geometry && r.geometry.coordinates;
      return { path: c ? c.map(p => [p[1], p[0]]) : null, legs: (r.legs || []).map(l => l.duration) };
    } catch (_) { return null; }
  }
  // "¿A qué hora llego?" era la pregunta que la app no contestaba: la pantalla
  // de a bordo tenía un "Llegada estimada — min" que nunca se llenó. La hora sale
  // de la duración real por carretera que ya devolvía OSRM (solo se botaba).
  //
  // Reglas para no mentir:
  //  · sin respuesta de OSRM → no se muestra nada.
  //  · con el punto del conductor viejo (>2 min) → tampoco: sería una hora
  //    calculada desde donde el carro YA NO está.
  //  · ya llegó o está a menos de 300 m → sobra la hora, se dice lo que pasa.
  //  · siempre con "~": es un estimado, y así se lee.
  function auxRenderEta(t, info) {
    const el = document.getElementById('ax-eta');
    if (!el) return;
    const hide = () => { el.textContent = ''; el.classList.add('hidden'); };
    if (!auxState.etaSecs || !auxState.etaAt) return hide();
    if (info && auxFreshLabel(info.pos).stale) return hide();
    if (info && info.stop_status === 'arrived') return hide();
    // Descuenta lo corrido desde el cálculo (se recalcula máximo cada minuto).
    const secs = auxState.etaSecs - (Date.now() - auxState.etaAt) / 1000;
    const dest = auxState.etaKind === 'dest'
      ? (t.type === 'lle' ? 'Llegas a casa' : 'Llegas a MDE')
      : (t.type === 'lle' ? 'Te recogemos en MDE' : 'Te recogemos');
    if (secs < 60) {
      el.textContent = `${dest} en menos de un minuto`;
      el.classList.remove('hidden');
      return;
    }
    const min = Math.round(secs / 60);
    const cuanto = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
    let hora = '';
    try {
      hora = new Date(Date.now() + secs * 1000)
        .toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
    } catch (_) {}
    el.innerHTML = `${dest} <b>~${hora}</b> · en ${cuanto}`;
    el.classList.remove('hidden');
  }
  // "Compartir mi ETA" anunciaba "enlace de seguimiento copiado" y no copiaba
  // nada — ese enlace no existe. Ahora comparte el texto con la hora real, y si
  // todavía no hay hora calculada lo dice en vez de inventarla.
  //
  // 27-sep-2026 (#19): con el viaje EXPLÍCITO y un texto por FASE. Antes
  // compartía siempre «Voy en camino…», también cuando el conductor apenas
  // salía a buscarlo o el viaje era de mañana, y tomaba el ETA de lo que
  // hubiera en memoria aunque fuera de otro viaje.
  //   asignado sin hora → «Tengo traslado a MDE el {día}; debo estar allá a las {hora}.»
  //   asignado con hora → «Me recogen el {día} a las {HH:MM}{, carro {placa}}.»
  //   en camino         → «Mi conductor va por mí{, llega sobre las HH:MM (estimado)}.»
  //   a bordo           → «Voy en camino {destino}{, llego sobre las HH:MM (estimado)}{. Carro {placa}}.»
  // Pendiente, cerrado o sin viaje → null (no hay nada cierto que contar).
  function auxShareText(t) {
    if (!t) return null;
    const lle = t.type === 'lle';
    const placa = auxPlate(t);
    const eta = (kind) => {
      if (auxState.etaTrip !== t.id || auxState.etaKind !== kind || !auxState.etaSecs || !auxState.etaAt) return '';
      const secs = auxState.etaSecs - (Date.now() - auxState.etaAt) / 1000;
      return secs > 0 ? auxHMBog(new Date(Date.now() + secs * 1000)) : '';
    };
    if (t.status === 'assigned') {
      const pub = t.pickupAt ? new Date(t.pickupAt) : null;
      if (pub && !isNaN(pub.getTime())) {
        const dia = auxDiaTexto(pub.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
        return `Me recogen${lle ? ' en MDE' : ''} ${dia} a las ${auxHMBog(pub)}${placa ? `, carro ${placa}` : ''}.`;
      }
      if (!t.date || !t.time) return null;
      const dia = auxDiaTexto(t.date);
      return lle
        ? `Tengo traslado del aeropuerto a casa ${dia}; aterrizo a las ${t.time}.`
        : `Tengo traslado a MDE ${dia}; debo estar allá a las ${t.time}.`;
    }
    if (t.status === 'onway') {
      const h = eta('pickup');
      return `Mi conductor va por mí${h ? `, llega sobre las ${h} (estimado)` : ''}.`;
    }
    if (t.status === 'onboard') {
      const h = eta('dest');
      return `Voy en camino ${lle ? 'a casa' : 'al aeropuerto MDE'}${h ? `, llego sobre las ${h} (estimado)` : ''}${placa ? `. Carro ${placa}` : ''}.`;
    }
    return null;
  }
  async function auxShareEta(t) {
    const txt = auxShareText(t);
    if (!txt) return false;
    try {
      if (navigator.share) { await navigator.share({ text: txt }); return true; }
      await navigator.clipboard.writeText(txt);
      auxToast('Texto copiado para compartir.', 'Copy');
      return true;
    } catch (_) { return false; /* el usuario canceló el compartir: no es un error */ }
  }
  // La placa real del viaje ('—' es el «sin dato» de lo heredado).
  function auxPlate(t) {
    const p = (t && t.vehicle && t.vehicle.plate) || (t && t.driver && t.driver.plate) || '';
    return p && p !== '—' ? p : '';
  }
  // HH:MM en hora de Bogotá, 24 h.
  function auxHMBog(d) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    } catch (_) { return ''; }
  }
  // «hoy», «mañana» o «el vie 16 de oct» (día en hora de Bogotá).
  function auxDiaTexto(iso) {
    if (!iso) return '';
    if (iso === auxTodayISO()) return 'hoy';
    if (iso === auxDayISO(1)) return 'mañana';
    return 'el ' + auxDateES(iso).replace(',', '');
  }
  function auxTweenCar(from, to) {
    if (auxState.trackTween) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    const car = auxState.trackCar, line = auxState.trackLine, dest = auxState.trackDestPt;
    if (!car) return;
    const A = from, B = to, START = Date.now(), DUR = 1400;
    auxState.trackTween = setInterval(() => {
      const k = Math.min(1, (Date.now() - START) / DUR);
      const lat = A[0] + (B[0] - A[0]) * k, lng = A[1] + (B[1] - A[1]) * k;
      car.setLatLng([lat, lng]);
      // Con vía real dibujada, la línea NO se toca: es el camino por carretera,
      // no un cordel atado al carro. Sin ella, se mantiene el comportamiento
      // viejo (la recta sigue al carro) para no dejar el mapa sin referencia.
      if (line && dest && !auxState.routePath) line.setLatLngs([[lat, lng], dest]);
      if (k >= 1) { clearInterval(auxState.trackTween); auxState.trackTween = null; }
    }, 60);
  }
  // El valor del hero va en 34px monospace: un texto largo se sale de pantalla en
  // un móvil angosto, así que baja de tamaño en vez de desbordar.
  function auxHero(labelEl, valEl, label, val) {
    labelEl.textContent = label;
    valEl.textContent = val;
    valEl.classList.toggle('sm', val.length > 11);
  }
  // La hora grande del rediseño (.rx-trip-big: <b id="ax-eta-min"> + <span
  // id="ax-eta-label">). Mismos datos que lo heredado, con los textos del
  // diseño y sin emojis. Nada inventado: los minutos solo si OSRM respondió y
  // el punto del conductor está fresco; si no, lo que se sabe (cuántos faltan).
  // Cuando cambia la fase, el bloque se RECREA para que rxRise corra otra vez
  // (en el diseño es key={st}).
  function auxHeroRx(t, info, labelEl, valEl, s) {
    const first = (t.driver && (t.driver.first || String(t.driver.name || '').split(' ')[0])) || '';
    const quien = first || 'Tu conductor';
    let etaMin = null, etaHM = '';
    if (auxState.etaTrip === t.id && auxState.etaSecs && auxState.etaAt && !(info && auxFreshLabel(info.pos).stale)) {
      const secs = auxState.etaSecs - (Date.now() - auxState.etaAt) / 1000;
      if (secs > 0) { etaMin = Math.max(1, Math.round(secs / 60)); etaHM = auxHMBog(new Date(Date.now() + secs * 1000)); }
    }
    let big, label;
    if (t.status === 'onway') {
      if (s.arrived)                   { big = 'Llegó'; label = `${quien} te espera afuera`; }
      else if (s.near)                 { big = 'Ya casi'; label = `${quien} está por llegar`; }
      else if (etaMin != null && auxState.etaKind === 'pickup') { big = `${etaMin} min`; label = `${quien} va por ti`; }
      else if (s.before > 0)           { big = `${s.before} antes`; label = s.before === 1 ? 'Recoge a 1 compañero antes de ti' : `Recoge a ${s.before} compañeros antes de ti`; }
      else if (s.before === 0)         { big = 'Eres el siguiente'; label = `${quien} va por ti`; }
      else                             { big = 'En camino'; label = `${quien} va por ti`; }
    } else {
      const falta = auxPendingAhead(t, info);
      const lle = t.type === 'lle';
      if (falta > 0) {
        big = lle ? `Dejan a ${falta}` : `Recoge a ${falta}`;
        label = lle ? 'Antes de llegar a tu casa' : 'Antes de ir al aeropuerto';
      } else if (etaHM && auxState.etaKind === 'dest') {
        big = etaHM; label = lle ? 'Llegada estimada a tu casa' : 'Llegada estimada a MDE';
      } else {
        big = 'En ruta'; label = lle ? 'Vas a casa' : 'Vas al aeropuerto';
      }
    }
    const fase = auxPhaseKey(t, info);
    const box = valEl.closest('.rx-trip-big');
    if (box && auxState.hudPhase && auxState.hudPhase !== fase) {
      // Re-montaje: nodo nuevo con los textos nuevos → la entrada vuelve a correr.
      const nuevo = box.cloneNode(true);
      const v2 = nuevo.querySelector('#ax-eta-min'), l2 = nuevo.querySelector('#ax-eta-label');
      if (v2) { v2.textContent = big; v2.classList.toggle('sm', big.length > 11); }
      if (l2) l2.textContent = label;
      box.replaceWith(nuevo);
    } else {
      auxHero(labelEl, valEl, label, big);
    }
    auxState.hudPhase = fase;
  }

  // Textos honestos (sin ETA inventado): estado + frescura del punto.
  function auxUpdateTrackHUD(t, info) {
    const arrived = info.stop_status === 'arrived';
    const labelEl = document.getElementById('ax-eta-label');
    const valEl = document.getElementById('ax-eta-min');
    const countEl = document.getElementById('ax-count');
    const freshEl = document.getElementById('ax-track-fresh');
    // ¿Está cerca? Distancia REAL del conductor a mi punto (sin ETA inventado).
    let near = false;
    if (info.pos && info.pickup && info.pickup.lat != null) {
      near = auxDistM([info.pos.lat, info.pos.lng], [info.pickup.lat, info.pickup.lng]) < 300;
    }
    const before = (typeof info.remaining_before === 'number') ? info.remaining_before : null;
    // Cuenta regresiva de espera: solo cuando ya llegó y sabemos desde cuándo.
    if (arrived && info.arrived_at) auxStartWait(info.arrived_at, info.wait_minutes);
    else auxStopWait();
    if (labelEl && valEl && auxShellOn()) {
      auxHeroRx(t, info, labelEl, valEl, { arrived, near, before });
    } else if (labelEl && valEl) {
      if (t.status === 'onway') {
        // Protagonista: "Faltan X antes de ti" → "Eres el siguiente" → "Está por llegar" → "Llegó".
        if (arrived)           auxHero(labelEl, valEl, 'Tu conductor', '¡Llegó! 📍');
        else if (near)         auxHero(labelEl, valEl, 'Tu conductor', '¡Está por llegar!');
        else if (before === 0) auxHero(labelEl, valEl, 'Eres el', 'siguiente 🔜');
        else if (before > 0)   auxHero(labelEl, valEl, 'Faltan', `${before} antes de ti`);
        else                   auxHero(labelEl, valEl, 'Tu conductor', 'En camino');
      } else {
        // A bordo. Antes decía SIEMPRE "Vas al aeropuerto / En ruta", así que el
        // que se montaba de segundo en un carro de tres leía que ya iban para el
        // aeropuerto mientras el conductor seguía recogiendo gente.
        const falta = auxPendingAhead(t, info);
        if (falta > 0 && t.type === 'lle') {
          auxHero(labelEl, valEl, 'Antes de ti', falta === 1 ? 'dejan a 1' : `dejan a ${falta}`);
        } else if (falta > 0) {
          auxHero(labelEl, valEl, 'Falta recoger', falta === 1 ? 'a 1 más' : `a ${falta} más`);
        } else {
          auxHero(labelEl, valEl, t.type === 'lle' ? 'Vas a casa' : 'Vas al aeropuerto', 'Sin paradas');
        }
      }
    }
    // El badge de la pantalla "A bordo" se pinta una vez al render, pero el
    // recorrido cambia debajo: se refresca en cada tick como el resto del HUD.
    const badgeEl = document.getElementById('ax-onboard-badge');
    if (badgeEl) {
      badgeEl.innerHTML = auxOnBoardBadge(t, info);
      badgeEl.classList.toggle('wait', auxPendingAhead(t, info) > 0);
    }
    // La hora se recalcula como mucho cada minuto (OSRM público), pero el
    // "en X min" se repinta en cada tick para que vaya bajando de verdad.
    // Esperando: si ya está a la vuelta, la hora sobra ("está por llegar" dice
    // más). A bordo NO se aplica: recién montado el carro sigue en mi punto y
    // taparía justo la hora de llegada, que es lo que quiero ver ahí.
    if (t.status === 'onway' && near) {
      const e = document.getElementById('ax-eta');
      if (e) { e.textContent = ''; e.classList.add('hidden'); }
    } else {
      auxRenderEta(t, info);
    }
    if (countEl) {
      const so = info.stop_order, tot = info.total_stops;
      let txt = (so && tot) ? `Vas ${so} de ${tot}` : '';
      if (info.route_start) {
        try { const h = new Date(info.route_start).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); txt += (txt ? ' · ' : '') + 'Sale ' + h; } catch (_) {}
      }
      countEl.textContent = txt;
      countEl.classList.toggle('hidden', !txt);
    }
    if (freshEl) {
      // El "máx. 3 min" salía de aquí como texto fijo; ahora vive en #ax-wait
      // con un reloj de verdad, así que esta línea vuelve a ser solo frescura.
      const f = auxFreshLabel(info.pos);
      freshEl.textContent = f.text;
      freshEl.classList.toggle('stale', !!f.stale);
    }
  }
  // ---------- navegación, salida y cancelación ----------
  // Pestañas: inicio · viajes · pagos · perfil. auxState.view es 'viajes' o
  // 'perfil' para esas dos y 'home' para inicio Y para pagos (la pestaña la
  // dice auxState.tab; así lo lee aux-shell.js). Sin el rediseño no hay
  // pestaña de pagos: 'home' pinta Inicio.
  const AUX_TABS = ['inicio', 'viajes', 'pagos', 'perfil'];
  const auxTabView = (tab) => (tab === 'viajes' || tab === 'perfil') ? tab : 'home';
  const auxIsTabView = (v) => v === 'home' || v === 'viajes' || v === 'perfil';
  function auxGoTab(tab) {
    auxState.tab = AUX_TABS.includes(tab) ? tab : 'inicio';
    auxState.view = auxTabView(auxState.tab);
    auxState.confirmingCancel = false;
    auxState.alarm = null;
    auxRender();
  }

  // ATRÁS de a UNA cosa (plan §2.5), en este orden. Devuelve true si cerró
  // algo; false en Inicio sin nada abierto.
  // La hoja del shell y su pila propia NO se tocan aquí: el popstate del shell
  // (backOne) las cierra antes de llamar a esto, y AuxShell.pop() llama a esta
  // función cuando su pila está vacía — llamarla desde aquí sería un bucle.
  function auxBack() {
    const shell = auxShellOn();
    // 2-4. alarma, confirmación de cancelar, chat (sin rehacer la capa: patch)
    if (auxState.alarm) { auxState.alarm = null; auxRender(); return true; }
    if (auxState.confirmingCancel) { auxState.confirmingCancel = false; auxRender(); return true; }
    if (auxState.chatOpen) { auxChatClose(); if (shell) auxRender(); return true; }
    // 5. un paso atrás en el pedido, por la misma entrada al paso (#18)
    if (auxState.view === 'form' && auxState.step > 1) { auxEnterStep(auxState.step - 1, 'bwd'); auxRender(); return true; }
    // 6. la portada del privado que se abrió desde el pedido
    if (auxState.view === 'privado') { auxState.view = 'form'; auxRender(); return true; }
    // (7. la pila propia del shell: la saca el shell antes de llegar aquí)
    // 8. soporte vuelve a Perfil
    if (auxState.view === 'support') { auxGoTab('perfil'); return true; }
    // 9. bienvenida: la diapositiva anterior
    if (auxState.view === 'onboarding') {
      if (auxState.onbStep > 0) { auxState.onbStep--; auxRender(); return true; }
      return false;
    }
    // 10. el pedido en su paso 1 se cierra (como la X)
    if (auxState.view === 'form') { auxState.view = auxTabView(auxState.tab); auxState.step = 1; auxState.form = {}; auxRender(); return true; }
    // el viaje vuelve a la pestaña desde la que se abrió
    if (auxState.view === 'trip') {
      auxState.confirmingCancel = false;
      auxState.view = auxTabView(auxState.tab); auxRender(); return true;
    }
    // una pestaña que no es Inicio (o cualquier otra vista) → Inicio
    if (auxState.view !== 'home' || (auxState.tab && auxState.tab !== 'inicio')) { auxGoTab('inicio'); return true; }
    return false;
  }
  async function auxLogout() {
    try { if (window.Api?.signOut) await Api.signOut(); } catch (e) {}
    try { if (typeof state !== 'undefined') state.profile = null; } catch (e) {}
    location.reload();
  }
  // Cancela de verdad: RPC (saca la reserva de la ruta activa) + push al
  // conductor afectado, que el propio RPC nos dice quién es.
  // Envía la alarma del tripulante (eventualidad #4).
  //
  // Dos destinos, por dos caminos que YA funcionan:
  //  · A los jefes, por push directo — es a quienes les toca decidir.
  //  · Al conductor, por el chat del traslado (0052), que de por sí le manda
  //    push a la otra punta y además deja el aviso escrito en el hilo.
  //
  // Antes esto se intentaba solo si ya había conductor, porque el RPC del chat
  // reventaba cuando no lo había — y el catch se comía el 🚨 en silencio, justo
  // en el caso más grave. Desde 0067 el mensaje se guarda igual y el aviso les
  // llega a los jefes, así que ya no hace falta el candado.
  async function auxAlarmSend(btn) {
    const a = auxState.alarm; if (!a || a.sending) return;
    const t = auxCurTrip(); if (!t) return;
    const ta = document.getElementById('ax-alarm-text');
    if (ta) a.text = ta.value;
    if (!a.motivo) { auxToast('Dinos qué está pasando.'); return; }
    if (!window.Api?.reportIncident) { auxToast('No se pudo enviar. Intenta de nuevo.'); return; }

    const opt = AUX_ALARM.find(o => o.id === a.motivo) || AUX_ALARM[2];
    const desc = `${opt.label}${a.text && a.text.trim() ? ' — ' + a.text.trim() : ''}`;
    a.sending = true; auxRender();

    try {
      const id = await Api.reportIncident({
        category: 'aux_emergency',
        description: desc,
        severity: opt.sev,
        reservationId: t.id,
        details: { motivo: a.motivo },
      });
      const quien = (auxState.profile?.full_name || 'Un tripulante');
      if (typeof notifyOps === 'function') {
        notifyOps(opt.sev === 'high' ? '🚨 Emergencia de un tripulante' : 'Novedad de un tripulante',
          `${quien}: ${desc}`.slice(0, 200), id);
      }
      if (window.Api?.sendReservationMessage) {
        try { await Api.sendReservationMessage(t.id, `🚨 ${desc}`); } catch (_) { /* el aviso principal ya salió */ }
      }
      auxState.alarm = null;
      auxRender();
      auxToast('Listo, ya avisamos a coordinación.');
    } catch (e) {
      console.error(e);
      a.sending = false; auxRender();
      auxToast('No se pudo enviar: ' + (e.message || 'revisa la señal'));
    }
  }

  async function auxDoCancel(btn) {
    const t = auxCurTrip(); if (!t) return;
    const reason = (document.getElementById('ax-cancel-reason')?.value || '').trim();
    btn.disabled = true; btn.textContent = 'Cancelando…';
    // La cancelación es del servidor o no es: no se marca cancelado en pantalla
    // si la reserva sigue viva en la BD y el conductor sigue yendo por él.
    if (!window.Api?.cancelMyReservation) {
      btn.disabled = false; btn.textContent = 'Sí, cancelar';
      auxToast('No se pudo cancelar. Intenta de nuevo.');
      return;
    }
    try {
      const r = await Api.cancelMyReservation(t.id, reason);
      if (r && r.driver_profile_id && typeof notify === 'function') {
        notify([r.driver_profile_id], 'Traslado cancelado',
          `${(auxState.profile?.full_name || 'Un auxiliar').split(' ')[0]} canceló su traslado. Ya no está en tu ruta.`, '/');
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Sí, cancelar';
      auxToast(e.message && e.message.includes('en curso')
        ? 'El viaje ya está en curso: no se puede cancelar.'
        : 'No se pudo cancelar. Intenta de nuevo.');
      return;
    }
    t.status = 'cancelled'; t.cancelledAt = new Date().toISOString(); t.cancelReason = reason;
    auxState.confirmingCancel = false;
    auxStopTrack();
    auxToast('Traslado cancelado.');
    auxState.view = 'home'; auxState.tab = 'inicio';
    auxRender();
  }

  // Arranca un pedido nuevo. Lo usan el botón «Pedir traslado» (data-ax="new")
  // y Auxiliar.newTrip(); el candado de suspensión va ANTES, en quien lo llama.
  function auxStartNew() {
    if (auxState.typeTimer) { clearTimeout(auxState.typeTimer); auxState.typeTimer = null; }
    auxState.view = 'form'; auxState.step = 1; auxState.stepDir = 'fwd';
    auxState.form = { isReserva: true, date: auxDefaultDate() };
    // El catálogo se pide ya, para que el paso del punto no muestre spinner
    // (y para que con una unidad ni aparezca). Las siglas también: si la
    // primera vez no llegaron (app abierta sin señal, perfil recién creado),
    // este es el momento natural de reintentarlo. El form nace sin
    // `dondeForced`: un pedido nuevo no arrastra el «Cambiar» del anterior.
    auxLoadAerolineas();
    if (window.AuxResidencias) { AuxResidencias.newTrip(); AuxResidencias.load(); }
    if (window.AuxPrivado) AuxPrivado.resetCupo();
    auxRender();
  }

  // ---------- refresco de los viajes (§2.7, #4) ----------
  // Los viajes del servidor: primero la RPC nueva (0087, P9) y, si no está o
  // no hay sesión, la consulta de siempre. null = no se pudo (nunca inventa).
  async function auxFetchTrips() {
    let list = null;
    try {
      if (window.ApiAux && typeof ApiAux.listMyTrips === 'function') list = await ApiAux.listMyTrips();
    } catch (_) { list = null; }
    if (!Array.isArray(list)) {
      try { if (window.Api?.listMyReservations) list = await Api.listMyReservations(); } catch (_) { list = null; }
    }
    return Array.isArray(list) ? list : null;
  }

  // Lo que el rastreo o el teléfono saben y la lista del servidor puede traer
  // vacío (la consulta vieja no trae conductor): un null del servidor no lo borra.
  const AUX_KEEP_IF_NULL = ['driver', 'vehicle', '_info', '_risk', 'readyAt'];
  const AUX_FINAL = ['cancelled', 'noshow'];

  // FUNDE la lista del servidor sobre los MISMOS objetos (§2.7). Antes, cada
  // recarga reemplazaba el arreglo entero: el rastreo seguía con el objeto
  // viejo (el que su intervalo tiene agarrado) y la pantalla con el nuevo, sin
  // conductor. Reglas:
  //   · por id, Object.assign sobre el viejo; los de AUX_KEEP_IF_NULL no se
  //     borran con null; conductor y carro se funden campo a campo (salvo que
  //     el conductor cambie: entonces manda el nuevo entero);
  //   · `rated` ya en true no vuelve a false;
  //   · el estado NUNCA retrocede por AUX_ORDER, salvo a cancelado o no se
  //     presentó, que son finales (y un final no se deshace);
  //   · los nuevos se agregan; los que el servidor ya no trae se quitan, salvo
  //     el viaje abierto en pantalla.
  // El arreglo queda en el orden del servidor (por hora) y es el MISMO arreglo.
  // Devuelve la lista de cambios [{t, kind}] para los avisos.
  function auxMergeTrips(list, opts) {
    const byId = new Map(auxState.trips.map(t => [t.id, t]));
    const out = [], cambios = [];
    list.forEach(n => {
      if (!n || n.id == null) return;
      const o = byId.get(n.id);
      if (!o) { out.push(n); byId.delete(n.id); return; }
      byId.delete(n.id);
      const antes = { status: o.status, privateStatus: o.privateStatus, pickupAt: o.pickupAt,
        stopStatus: o.stopStatus, driverName: o.driver && o.driver.name };
      Object.keys(n).forEach(k => {
        const v = n[k];
        if (v == null && AUX_KEEP_IF_NULL.includes(k)) return;
        if (k === 'status') return;              // se decide abajo
        if (k === 'rated') { if (o.rated) return; }
        if (k === 'rating' && o.rated && !n.rated) return;   // la que se acaba de mandar
        if ((k === 'driver' || k === 'vehicle') && v && o[k] && typeof v === 'object') {
          const mismo = k !== 'driver' || !o.driver.name || !v.name || o.driver.name === v.name;
          if (mismo) {
            const m = Object.assign({}, o[k]);
            Object.keys(v).forEach(kk => { if (v[kk] != null && v[kk] !== '') m[kk] = v[kk]; });
            o[k] = m; return;
          }
        }
        o[k] = v;
      });
      // El estado: solo avanza; lo final gana y no se deshace.
      const ns = n.status;
      if (ns && ns !== o.status) {
        if (AUX_FINAL.includes(o.status)) { /* final: se queda */ }
        else if (AUX_FINAL.includes(ns)) o.status = ns;
        else if ((AUX_ORDER[ns] ?? -1) > (AUX_ORDER[o.status] ?? -1)) o.status = ns;
      }
      if (o.status !== antes.status) cambios.push({ t: o, kind: 'status', from: antes.status });
      if (o.privateStatus !== antes.privateStatus && o.privateStatus) cambios.push({ t: o, kind: 'private', from: antes.privateStatus });
      if (o.pickupAt && o.pickupAt !== antes.pickupAt) cambios.push({ t: o, kind: 'pickup', from: antes.pickupAt });
      if (o.stopStatus === 'arrived' && antes.stopStatus !== 'arrived') cambios.push({ t: o, kind: 'arrived' });
      out.push(o);
    });
    // El que está abierto en pantalla no desaparece de golpe aunque el
    // servidor ya no lo traiga (se va al cerrar el viaje).
    const abierto = auxState.editingTrip != null ? byId.get(auxState.editingTrip) : null;
    if (abierto) out.push(abierto);
    auxState.trips.length = 0;
    out.forEach(t => auxState.trips.push(t));
    return cambios;
  }

  // Un solo refresco a la vez: si ya va uno, se espera ese.
  // NO repinta por su cuenta: quien lo llama decide. El shell
  // (AuxShell.refreshTrips) aplica las reglas de §2.7 y los avisos de cambio
  // de estado. opts.repaint = true aplica aquí esas mismas reglas (para quien
  // llame sin shell). opts.silent = sin avisos.
  function auxReloadTrips(opts) {
    if (auxState.reloading) return auxState.reloading;
    auxState.reloading = (async () => {
      try {
        const list = await auxFetchTrips();
        // Falla un refresco de fondo: se queda lo que había (era real) y nada
        // cambia en pantalla. El aviso de «no pudimos cargar» es del arranque.
        if (!list) return auxState.trips;
        const abiertoAntes = auxCurTrip();
        const estadoAntes = abiertoAntes ? abiertoAntes.status : null;
        const cambios = auxMergeTrips(list);
        auxState.source = 'live';
        auxState.lastChanges = cambios.map(c => ({ id: c.t.id, kind: c.kind, from: c.from == null ? null : c.from }));
        if (!(opts && opts.silent)) auxBannersFor(cambios);
        if (opts && opts.repaint) auxAfterReload(abiertoAntes, estadoAntes);
        return auxState.trips;
      } finally { auxState.reloading = null; }
    })();
    return auxState.reloading;
  }

  // ¿Se repinta después de un refresco? Solo:
  //   · en una pestaña (inicio, viajes, pagos, perfil) y sin un campo con foco
  //     (repintar le cerraría el teclado a media palabra);
  //   · en el viaje abierto, si cambió SU estado (el shell lo resuelve por patch).
  // Nunca en el pedido, la confirmación ni la bienvenida.
  function auxAfterReload(abiertoAntes, estadoAntes) {
    const v = auxState.view;
    if (v === 'form' || v === 'confirm' || v === 'onboarding') return;
    if (auxIsTabView(v)) {
      const ae = document.activeElement;
      const escribiendo = ae && auxRoot() && auxRoot().contains(ae)
        && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
      if (!escribiendo) auxRender();
      return;
    }
    if (v === 'trip') {
      const t = auxCurTrip();
      if (t && abiertoAntes === t && t.status !== estadoAntes) auxRender();
    }
  }

  // ---------- avisos en la app por cambios del refresco (§2.6, fuente 2) ----------
  // El shell ya avisa los cambios de ESTADO (asignado, en camino, llegaste,
  // cancelado). Aquí van solo los que él no ve porque no son un estado:
  //   · el privado aprobado o rechazado;
  //   · la hora de recogida publicada o cambiada (con el viaje ya asignado);
  //   · «llegó por ti» (estado de la parada, con el código si toca);
  //   · no se presentó.
  // Solo con el rediseño, la app a la vista y SIN otro aviso en pantalla (no
  // se pisa el de un push que acaba de llegar). Cada cambio se avisa UNA vez
  // (id:tipo:valor). Textos con datos reales: sin nombre si no lo hay, sin
  // hora si no está publicada.
  const AUX_BANNER_KINDS = ['private', 'pickup', 'arrived'];
  function auxBannersFor(cambios) {
    if (!cambios || !cambios.length || !auxShellOn() || typeof AuxShell.banner !== 'function') return;
    if (document.visibilityState === 'hidden') return;
    if (auxRoot() && auxRoot().querySelector('.rx-push-host .rx-push')) return;
    let dado = false;
    cambios.forEach(c => {
      if (dado) return;                        // uno a la vez: el banner es uno solo
      const propio = AUX_BANNER_KINDS.includes(c.kind) || (c.kind === 'status' && c.t.status === 'noshow');
      if (!propio) return;
      const b = auxBannerFor(c, cambios);
      if (!b) return;
      const key = `${c.t.id}:${c.kind}:${c.kind === 'status' ? c.t.status : c.kind === 'private' ? c.t.privateStatus : c.kind === 'pickup' ? c.t.pickupAt : 'arrived'}`;
      if (auxState.bannerSeen[key]) return;
      auxState.bannerSeen[key] = 1;
      try { AuxShell.banner(b); dado = true; } catch (_) {}
    });
  }
  function auxBannerFor(c, lote) {
    const t = c.t;
    const first = (t.driver && (t.driver.first || String(t.driver.name || '').split(' ')[0])) || '';
    const placa = auxPlate(t);
    const abrir = (rate) => () => window.Auxiliar.openTrip(t.id, rate ? { rate: true } : undefined);
    if (c.kind === 'status') {
      if (t.status === 'assigned') {
        const pub = t.pickupAt ? new Date(t.pickupAt) : null;
        const cuando = pub && !isNaN(pub.getTime())
          ? `Te recogemos ${auxDiaTexto(pub.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }))} a las ${auxHMBog(pub)}.`
          : 'Te avisamos la hora de recogida cuando armemos tu ruta.';
        return { icon: 'Car', title: 'Ya tienes conductor', body: [first && placa ? `${first} · ${placa}.` : '', cuando].filter(Boolean).join(' '), go: abrir() };
      }
      if (t.status === 'onway') return { icon: 'Nav', title: first ? `${first} va en camino` : 'Tu conductor va en camino', body: placa ? `Carro ${placa}.` : '', go: abrir() };
      if (t.status === 'onboard') return null;   // el tripulante acaba de subirse: ya lo sabe
      if (t.status === 'done') {
        return { icon: 'Star', title: t.type === 'lle' ? 'Llegaste a casa' : 'Llegaste a MDE',
          body: first ? `¿Cómo te fue con ${first}?` : '', go: abrir(!!t.driver) };
      }
      if (t.status === 'cancelled') return { icon: 'X', title: 'Tu traslado fue cancelado', body: t.cancelReason || '', go: abrir() };
      if (t.status === 'noshow') return { icon: 'Alert', title: 'El conductor no pudo recogerte', body: 'Si fue un error, escríbele a Coordinación.', go: abrir() };
      return null;
    }
    if (c.kind === 'private') {
      if (t.privateStatus === 'approved') return { icon: 'Check', title: 'Tu privado quedó confirmado', body: '', go: abrir() };
      if (t.privateStatus === 'rejected') return { icon: 'Info', title: 'Tu privado no se pudo confirmar', body: 'Viajas en compartido.', go: abrir() };
      return null;
    }
    if (c.kind === 'pickup') {
      // Si en el MISMO refresco quedó asignado, la hora ya va en ese aviso.
      if (c.from == null && (lote || []).some(x => x.t === t && x.kind === 'status' && t.status === 'assigned')) return null;
      const pub = new Date(t.pickupAt);
      if (isNaN(pub.getTime())) return null;
      return { icon: 'Clock', title: c.from ? 'Cambió tu hora de recogida' : 'Ya tienes hora de recogida',
        body: `Te recogemos ${auxDiaTexto(pub.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }))} a las ${auxHMBog(pub)}.`, go: abrir() };
    }
    if (c.kind === 'arrived') {
      const code = auxMeetVisible(t, { stop_status: 'arrived' }) ? t.meetCode : '';
      return { icon: 'MapPin', title: first ? `${first} llegó por ti` : 'Tu conductor llegó por ti',
        body: code ? `Tu código de encuentro es ${code}.` : '', go: abrir() };
    }
    return null;
  }

  // ---------- eventos ----------
  // Lo que escribe en el pedido (auxState.form) SOLO vale dentro del pedido
  // (#9). Con el rediseño, la pantalla del pedido va marcada data-scr="book";
  // Coordinación, «Cambió mi vuelo», el punto de encuentro o la residencia
  // del perfil tienen sus propios campos (data-rx-field) y estado.
  function auxEnPedido(el) {
    if (!auxShellOn()) return true;
    if (!el || !el.closest) return false;
    if (el.closest('[data-scr="book"]')) return true;
    // Si la pantalla no está marcada con data-scr, se acepta mientras el
    // pedido esté abierto (no hay otra pantalla con la que confundirse).
    return auxState.view === 'form' && !el.closest('[data-scr]');
  }
  const AUX_FORM_ACTS = ['type', 'date', 'fl-pick', 'fl-set', 'fl-other', 'toggle', 'next', 'back',
    'donde-cambiar', 'pin-confirm', 'pin-edit'];

  function auxBindOnce() {
    if (auxState.bound) return;
    const root = auxRoot(); if (!root) return;
    auxState.bound = true;

    // Enter envía el mensaje del chat (el input se recrea con cada render, por
    // eso el listener va delegado en la raíz y no en el campo).
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target || e.target.id !== 'ax-chat-input') return;
      e.preventDefault();
      auxChatSend();
    });

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ax]'); if (!el) return;
      const a = el.dataset.ax;
      // Con el rediseño, lo que escribe en el pedido solo cuenta dentro de él (#9).
      if (AUX_FORM_ACTS.includes(a) && !auxEnPedido(el)) return;
      if ((a === 'lvl' || a === 'lvl-choose') && auxShellOn() && auxState.view !== 'form' && auxState.view !== 'privado') return;
      if (a === 'install') { if (window.rendioInstall) window.rendioInstall.prompt(); return; }
      if (a === 'enable-push') { if (typeof enablePush === 'function') Promise.resolve(enablePush()).then(() => auxSetupPwa()); return; }
      // Candados para pedir: suspensión del jefe (0081) y pausa por no pago.
      // Con el rediseño es una hoja que explica; sin él, el toast de siempre.
      if ((a === 'new' || a === 'repeat') && auxLockCheck()) return;
      if (a === 'change-pw') { if (typeof openCambiarMiClave === 'function') openCambiarMiClave(); return; }
      if (a === 'new') {
        auxStartNew();
      }
      // ---- «Repetir el de siempre»: arranca en el paso 2, no en el 1 ----
      else if (a === 'repeat') {
        const last = auxLastTrip(); if (!last) return;
        if (auxState.typeTimer) { clearTimeout(auxState.typeTimer); auxState.typeTimer = null; }
        auxState.view = 'form'; auxState.step = 1;
        auxState.form = {
          isReserva: true, type: last.type,
          date: auxDefaultDate(),
          // Las notas guardadas llevan pegados el vuelo de ESA vez («Vuelo AV9412. »,
          // createReservation) y la marca del regreso. Repetirlos metía un vuelo viejo
          // en el pedido nuevo: el admin lo leía como el de hoy (_flightFromNotes).
          notes: auxRepeatNotes(last.notes),
          residenceId: last.residenceId || null,
          residenceUnit: last.residenceUnit || null,
        };
        auxLoadAerolineas();
        if (window.AuxResidencias) { AuxResidencias.newTrip(); AuxResidencias.load(); }
        // Si el traslado anterior salió de un conjunto del catálogo, se repite
        // el conjunto (con una unidad el paso del punto se salta; con dos, se
        // muestra con la unidad de la vez anterior ya marcada). Si venía del
        // camino manual (sin residencia) NO se repite la dirección: repetir una
        // dirección escrita a mano repetiría también su pin, y ese es justo el
        // dato que el catálogo vino a dejar de adivinar. Con una unidad se pone
        // el conjunto del registro (y «Cambiar» en el resumen abre el catálogo);
        // sin conjunto guardado, el paso del punto se pide normal.
        if (auxState.form.residenceId) {
          auxState.form.address = last.address; auxState.form.lat = last.lat;
          auxState.form.lng = last.lng; auxState.form.locConfirmed = true;
        }
        auxEnterStep(2, 'fwd');
        auxRender();
      }
      // ---- 0069 · nivel de servicio (aux-privado.js) ----
      else if (a === 'lvl') {
        // La tarjeta privada comprometida va `.off` y NO `disabled`: con
        // `disabled` el navegador se traga también el clic de «Ver qué
        // incluye», que vive dentro de ella, y la portada quedaba inalcanzable
        // justo cuando el tripulante quiere saber qué se perdió.
        if (el.hasAttribute('disabled') || el.classList.contains('off')) return;
        auxState.form.level = el.dataset.v;
        auxState.form.levelAuto = false;   // lo eligió él: ya no se suelta solo
        if (auxState.form.level !== 'private') auxState.form.quietRide = false;
        auxRender();
      }
      else if (a === 'lvl-info') { auxState.view = 'privado'; auxRender(); }
      else if (a === 'lvl-close') { auxState.view = 'form'; auxRender(); }
      // «Pedir en privado» desde la portada: elige el nivel y vuelve al paso.
      // Deshabilitado cuando la camioneta está comprometida a esa hora.
      else if (a === 'lvl-choose') {
        if (el.hasAttribute('disabled')) return;
        auxState.form.level = 'private'; auxState.form.levelAuto = false; auxState.view = 'form'; auxRender();
      }
      // ---- «Cambiar» el punto desde el resumen (15-sep-2026) ----
      // Con una unidad el paso 'donde' no existió; este botón lo hace existir:
      // `dondeForced` lo mete en la lista de pasos (y lo deja ahí aunque vuelva
      // atrás) y forcePick vacía el punto para que el catálogo se abra en vez de
      // volver a ponérselo solo. Con dos unidades abre el selector de las dos.
      else if (a === 'donde-cambiar') {
        if (!window.AuxResidencias) return;
        auxState.form.dondeForced = true;
        AuxResidencias.forcePick(auxState.form);
        auxEnterStep(auxStepKinds().indexOf('donde') + 1, 'bwd');
        auxRender();
      }
      // ---- §7 · catálogo de residencias (aux-residencias.js) ----
      else if (a && a.indexOf('res-') === 0 && window.AuxResidencias) {
        // El selector de la residencia del PERFIL tiene su propio estado: sus
        // res-* no pueden escribir en el pedido (#9).
        if (!auxEnPedido(el)) return;
        const r = AuxResidencias.handle(a, el, auxState.form);
        if (r === true) auxRender();
        return;
      }
      // ---- A5 · tema del módulo (Automático · Claro · Nocturno) ----
      else if (a === 'theme') {
        if (window.AuxPresentacion) AuxPresentacion.setThemePref(el.dataset.v);
        auxRender();
      }
      // ---- A2/A3 · primer ingreso ----
      else if (a === 'onb-next') {
        auxState.onbStep++;
        auxRender();
      }
      // Tocar un punto salta a esa pantalla (y deslizar hace lo mismo: ver
      // bindSwipe). No se deja pasar del permiso, que es el final del camino.
      else if (a === 'onb-go') {
        const n = parseInt(el.dataset.i, 10);
        if (!isNaN(n)) { auxState.onbStep = Math.max(0, n); auxRender(); }
      }
      else if (a === 'onb-skip') {
        // Saltar salta el tour, pero NO el permiso: es lo único de las cuatro
        // pantallas que cambia si le llega o no un aviso a las 3 a.m.
        const P = window.AuxPresentacion;
        auxState.onbStep = P ? P.slideCount : 0;
        auxRender();
      }
      else if (a === 'onb-allow') {
        if (window.AuxPresentacion) AuxPresentacion.markOnboarded();
        el.disabled = true;
        const fin = () => { auxState.view = 'home'; auxRender(); };
        if (typeof enablePush === 'function') Promise.resolve(enablePush()).then(fin, fin);
        else fin();
      }
      // Volver a ver la bienvenida desde Perfil. Sirve para el que se la saltó
      // —y para probarla sin tener que borrar el almacenamiento del navegador.
      else if (a === 'onb-again') {
        auxState.view = 'onboarding'; auxState.onbStep = 0; auxRender();
      }
      else if (a === 'onb-later') {
        if (window.AuxPresentacion) AuxPresentacion.markOnboarded();
        auxState.view = 'home'; auxRender();
      }
      // ---- A7 · soporte ----
      else if (a === 'support') { auxState.view = 'support'; auxRender(); }
      else if (a === 'sup-close') { auxGoTab('perfil'); }
      else if (a === 'sup-trip') {
        const t = auxUpcoming()[0];
        if (t) { auxState.editingTrip = t.id; auxState.view = 'trip'; auxState.confirmingCancel = false; auxRender(); }
      }
      else if (a === 'sup-push') { auxGoTab('perfil'); }
      else if (a === 'cancel' || a === 'home') {
        if (auxState.typeTimer) { clearTimeout(auxState.typeTimer); auxState.typeTimer = null; }
        auxState.view = 'home'; auxState.tab = 'inicio'; auxState.step = 1; auxState.form = {}; auxRender();
      }
      else if (a === 'back') { auxEnterStep(auxState.step - 1, 'bwd'); auxRender(); }
      else if (a === 'next') {
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
        // Al entrar al paso del nivel se le pregunta al servidor si la
        // camioneta está libre a esa hora (auxEnterStep). En el último paso
        // envía, y el audio se desbloquea dentro de este mismo clic.
        auxGoNext(el);
      }
      else if (a === 'type') {
        const tipo = el.dataset.type;
        auxState.form.type = tipo; auxRender();
        // Rediseño: el paso 1 avanza solo a los 260 ms (como rx-book.jsx). Sin
        // él, el «Continuar» de siempre.
        if (auxShellOn()) {
          if (auxState.typeTimer) clearTimeout(auxState.typeTimer);
          auxState.typeTimer = setTimeout(() => {
            auxState.typeTimer = null;
            if (auxState.view === 'form' && auxStepKind(auxState.step) === 'tipo' && auxState.form.type === tipo) {
              auxEnterStep(auxState.step + 1, 'fwd'); auxRender();
            }
          }, 260);
        }
      }
      else if (a === 'date') { auxState.form.date = el.dataset.iso; auxRender(); }
      // ---- la sigla de la aerolínea del vuelo (11-sep-2026) ----
      else if (a === 'fl-pick') {
        const k = el.dataset.k;
        auxState.form.flPick = auxState.form.flPick === k ? null : k;
        auxRender();
      }
      else if (a === 'fl-set') {
        const k = el.dataset.k;
        auxState.form[k + 'Iata'] = el.dataset.iata;
        auxState.form.flOtra = null; auxState.form.flPick = null;
        auxFlightSync(k); auxRender();
      }
      else if (a === 'fl-other') {
        // El selector NO se cierra: la sigla hay que escribirla y el campo
        // aparece justo debajo. Se le deja el foco con el texto seleccionado,
        // así escribir encima reemplaza la sigla anterior de un solo gesto.
        const k = el.dataset.k;
        auxState.form.flOtra = k; auxRender();
        const inp = auxRoot() && auxRoot().querySelector('[data-field="' + k + 'Iata"]');
        if (inp) { try { inp.focus(); inp.select(); } catch (_) {} }
      }
      else if (a === 'toggle') { const k = el.dataset.key; auxState.form[k] = !auxState.form[k]; auxRender(); }
      else if (a === 'pin-confirm') { auxState.form.locConfirmed = true; auxRefreshPinRow(); auxToast('Ubicación confirmada.'); }
      else if (a === 'pin-edit') { auxState.form.locConfirmed = false; auxRefreshPinRow(); }
      else if (a === 'trip') { window.Auxiliar.openTrip(el.dataset.id); }
      else if (a === 'tab') { auxGoTab(el.dataset.tab); }
      else if (a === 'profile') { auxGoTab('perfil'); }
      else if (a === 'logout') { auxLogout(); }
      else if (a === 'reload') { el.disabled = true; auxInit(auxState.profile); }
      // --- seguimiento del viaje ---
      // Confirmar recogida: ahora PERSISTE (RPC auxiliar_confirm_ready). Antes
      // solo cambiaba el estado en memoria y el siguiente refresco lo pisaba,
      // así que el auxiliar creía haber confirmado algo que nadie recibía.
      else if (a === 'confirm-pickup') {
        const t = auxCurTrip(); if (!t) return;
        el.disabled = true;
        // Sin la API no se "confirma" nada en local: sería el mismo engaño que
        // se acaba de arreglar, solo que en otra rama.
        if (!window.Api?.confirmReservationReady) { el.disabled = false; auxToast('No se pudo confirmar. Intenta de nuevo.'); return; }
        Api.confirmReservationReady(t.id)
          .then(() => { t.readyAt = new Date().toISOString(); auxToast('Listo — le avisamos a tu conductor.'); auxRender(); })
          .catch(() => { el.disabled = false; auxToast('No se pudo confirmar. Intenta de nuevo.'); });
      }
      // --- botón rojo: algo se salió del plan (eventualidad #4) ---
      else if (a === 'alarm') { auxState.alarm = { motivo: null, text: '', sending: false }; auxRender(); }
      else if (a === 'alarm-close') { auxState.alarm = null; auxRender(); }
      else if (a === 'alarm-pick') {
        const ta = document.getElementById('ax-alarm-text');
        if (ta) auxState.alarm.text = ta.value;
        auxState.alarm.motivo = el.dataset.v; auxRender();
      }
      else if (a === 'alarm-send') { auxAlarmSend(el); }
      // --- cancelar el traslado ---
      else if (a === 'cancel-trip') { auxState.confirmingCancel = true; auxRender(); }
      else if (a === 'cancel-abort') { auxState.confirmingCancel = false; auxRender(); }
      else if (a === 'cancel-do') { auxDoCancel(el); }
      else if (a === 'call') {
        const ph = auxCurTrip()?.driver?.phone;
        if (ph) { try { window.location.href = 'tel:' + ph.replace(/[^\d+]/g, ''); } catch (_) {} }
        else auxToast('Aún no hay teléfono del conductor.');
      }
      else if (a === 'share-eta') { auxShareEta(auxCurTrip()); }
      // --- chat con el conductor ---
      // Con el rediseño se avisa al shell (render → patch): el chat abierto
      // cuenta para el botón atrás. Sin él, el panel se abre como siempre.
      else if (a === 'chat') { auxChatOpen(); if (auxShellOn()) auxRender(); }
      else if (a === 'chat-close') { auxChatClose(); if (auxShellOn()) auxRender(); }
      else if (a === 'chat-send') { auxChatSend(); }
      // --- calificación ---
      else if (a === 'star') { auxState.ratingSel = Number(el.dataset.n); auxState.ratingTags = []; auxRender(); }
      else if (a === 'tag') { const tg = el.dataset.tag; const s = new Set(auxState.ratingTags); s.has(tg) ? s.delete(tg) : s.add(tg); auxState.ratingTags = [...s]; auxRender(); }
      else if (a === 'rate-send') {
        if (el.hasAttribute('disabled')) return;
        const t = auxCurTrip();
        if (t) { t.rated = true; t.rating = auxState.ratingSel; }
        // Persiste en dev (optimista); en demo se queda local.
        if (auxState.source === 'live' && t && window.Api?.rateReservation) {
          Api.rateReservation(t.id, auxState.ratingSel, auxState.ratingTags)
            .catch(() => auxToast('No se pudo guardar la calificación en el servidor.'));
        }
        auxState.rateOpen = null;
        auxToast('¡Gracias por tu calificación!', 'Star'); auxState.view = 'home'; auxState.tab = 'inicio'; auxRender();
      }
      // «Ahora no»: queda guardado en el teléfono y el viaje sigue SIN
      // calificar en el servidor (antes se marcaba calificado en memoria y al
      // recargar la app volvía a salir).
      else if (a === 'rate-skip') {
        const t = auxCurTrip();
        if (t) auxRateSkip(t.id);
        auxState.rateOpen = null;
        auxState.view = 'home'; auxState.tab = 'inicio'; auxRender();
      }
    });

    root.addEventListener('input', (e) => {
      // Guarda del rediseño (#9): solo los campos DEL PEDIDO escriben en
      // auxState.form. Los demás formularios (data-rx-field) los maneja su módulo.
      if (!auxEnPedido(e.target)) return;
      // Buscador del catálogo: repinta SOLO la lista. Si repintáramos el paso
      // entero se remonta el input y el cursor salta al final en cada tecla.
      if (e.target && e.target.id === 'axr-q') {
        if (window.AuxResidencias) AuxResidencias.onQuery(e.target.value, auxState.form);
        return;
      }
      const el = e.target.closest('[data-field]'); if (!el) return;
      const k = el.dataset.field;
      // El vuelo no se guarda tal cual se teclea: el campo solo admite dígitos y
      // la sigla vive aparte, en el chip. Se normaliza ACÁ, en el mismo evento,
      // para que el pegado de "AV-9412" se parta delante de los ojos del
      // tripulante y no en silencio al guardar.
      if (k === 'flightNum' || k === 'backFlightNum' || k === 'flightIata' || k === 'backFlightIata') {
        auxFlightInput(k, el);
        auxSyncCta(el);
        return;
      }
      auxState.form[k] = el.value;
      if (k === 'address') {
        auxState.form.locConfirmed = false;
        clearTimeout(auxState.geoTimer);
        const q = el.value.trim();
        if (q.length >= 6) auxState.geoTimer = setTimeout(() => auxGeocode(q), 700);
      }
      // habilita/inhabilita el CTA sin remontar (no perder foco del input);
      // con el rediseño sin innerHTML: el deslizador no se rehace a media tecla.
      auxSyncCta(el);
      // …y con él, el aviso de fecha/antelación: si no, el botón se apagaba mudo.
      if (k === 'date' || k === 'time') auxPaintTimeHints();
    });
  }
