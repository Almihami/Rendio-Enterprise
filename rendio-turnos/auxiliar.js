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
    fieldHTML: (label, key, value, ph, type, attrs) => auxField(label, key, value, ph, type, attrs),
    toggleHTML: (label, key, on, hint) => auxToggle(label, key, on, hint),
  };

  async function auxInit(profile) {
    auxState.profile = profile;
    auxState.view = 'home';
    auxBindOnce();
    // Modo nocturno antes de pintar: si se aplicara después, la primera pantalla
    // aparece en claro y da un fogonazo blanco a las 3 de la mañana.
    if (window.AuxPresentacion) {
      AuxPresentacion.applyTheme();
      AuxPresentacion.watchTheme();
    }
    // Datos REALES desde dev (reservas del auxiliar); si no hay sesión/BD → demo.
    let trips = null;
    try { if (window.Api?.listMyReservations) trips = await Api.listMyReservations(); } catch (e) {}
    // trips === null → no hay sesión de auxiliar o falló la consulta. No se
    // rellena con nada: la pantalla lo dice y ofrece reintentar.
    auxState.trips = Array.isArray(trips) ? trips : [];
    auxState.source = Array.isArray(trips) ? 'live' : 'error';
    // Primer ingreso: solo si los datos cargaron. Si la app está sin señal, lo
    // primero que tiene que ver es que no hay señal, no un tour de bienvenida.
    if (auxState.source === 'live' && window.AuxPresentacion && !AuxPresentacion.onboarded()) {
      auxState.view = 'onboarding'; auxState.onbStep = 0;
    }
    auxRender();
    // El catálogo de residencias se precarga en segundo plano: cuando llegue al
    // paso 3 la lista ya está, sin spinner. Si falla, el paso 3 cae al camino
    // manual de siempre.
    if (window.AuxResidencias) AuxResidencias.load();
  }

  // ---------- helpers ----------
  const auxRoot = () => document.getElementById('auxiliar-ui');
  const auxCurTrip = () => auxState.trips.find(x => x.id === auxState.editingTrip);
  const auxFirstName = () => (auxState.profile?.full_name || 'Auxiliar').split(' ')[0];
  function auxTypeMeta(type) {
    return type === 'lle'
      ? { cls: 'a2h', label: 'Llegada', ic: 'i-down', desc: 'Del aeropuerto a casa' }
      : { cls: 'h2a', label: 'Salida', ic: 'i-up', desc: 'De casa al aeropuerto' };
  }
  const auxHM = (t) => t || '--:--';
  function auxDateES(iso) {
    try { return new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (_) { return iso; }
  }
  // Recogida estimada = 1h antes de la presentación (salida) — solo referencia visual.
  function auxSuggestPickup(time) {
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return '--:--';
    let [h, m] = time.split(':').map(Number); h = (h + 23) % 24;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  // ---------- render raíz ----------
  function auxRender() {
    const root = auxRoot(); if (!root) return;
    auxStopTrack(); // limpia animaciones de mapa al cambiar de vista
    // Primer ingreso: ocupa la pantalla entera, sin nav ni encabezado.
    if (auxState.view === 'onboarding') {
      const P = window.AuxPresentacion;
      root.innerHTML = !P ? '' : (auxState.onbStep >= P.slideCount ? P.notifyHTML() : P.slideHTML(auxState.onbStep));
      return;
    }
    if (auxState.view === 'form') { root.innerHTML = auxFormHTML(); auxAfterFormRender(); return; }
    if (auxState.view === 'confirm') { root.innerHTML = auxConfirmHTML(); return; }
    if (auxState.view === 'trip') { root.innerHTML = auxTripHTML(); auxAfterTripRender(); return; }
    if (auxState.view === 'viajes') { root.innerHTML = auxViajesHTML(); return; }
    if (auxState.view === 'perfil') { root.innerHTML = auxPerfilHTML(); auxSetupPwa(); return; }
    if (auxState.view === 'privado') {
      root.innerHTML = window.AuxPrivado ? AuxPrivado.introHTML() : '';
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
  const auxUpcoming = () => auxState.trips.filter(t => !AUX_CLOSED.includes(t.status));
  const auxPast = () => auxState.trips.filter(t => AUX_CLOSED.includes(t.status));

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
        ${auxRepeatHTML()}
        ${upcoming.length > 1 ? `<div class="ax-sec">Más próximos</div>${upcoming.slice(1).map(t => auxTripCard(t)).join('')}` : ''}
        ${past.length ? `<div class="ax-sec">Anteriores</div>${past.slice(0, 3).map(t => auxTripCard(t)).join('')}` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">
        <button class="ax-btn ax-btn-primary" data-ax="new"><svg class="icon"><use href="#i-plus"/></svg>Pedir traslado</button>
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
    const hechos = auxState.trips.filter(t => t.status === 'done');
    return hechos.length ? hechos[hechos.length - 1] : null;
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
        <button class="ax-btn ax-btn-ghost ax-danger" data-ax="logout"><svg class="icon"><use href="#i-exit"/></svg>Cerrar sesión</button>
        <div class="ax-spacer"></div>
      </div>
      ${auxTabsHTML('perfil')}`;
  }

  function auxTripCard(t, hero) {
    const m = auxTypeMeta(t.type);
    const st = auxStatusMeta(t.status);
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
        <span><svg class="icon"><use href="#i-clock"/></svg>${auxDateES(t.date)} · ${t.type === 'lle' ? 'llega' : 'pres.'} ${auxHM(t.time)}</span>
        <span class="ax-flight">${t.flight}</span>
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
        return { level, text: 'No alcanzas la presentación.',
          sub: 'Coordinación ya está en esto y va a contactarte.' };
      }
      const cuanto = `${margen} min antes de tu presentación`;
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
      const pickupBy = t0 - 60 * MIN;                 // recogida ~1h antes de presentación
      if (now > t0)       return { level: 'miss',   text: 'Pasó tu hora de presentación.', sub: 'Si sigues sin salir, avisa a coordinación.' };
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

  // ---------- FORMULARIO (4 pasos) ----------
  // Cuántos pasos tiene el pedido. Son 5 solo si el jefe encendió el traslado
  // privado (0069): sin él, el paso de nivel no existe — no se le muestra a
  // nadie una elección de un solo elemento.
  function auxSteps() {
    return (window.AuxPrivado && AuxPrivado.enabled()) ? 5 : 4;
  }
  // Qué pide cada paso. Se resuelve por NOMBRE y no por número, porque el número
  // del último paso cambia según haya privado o no.
  function auxStepKind(s) {
    if (s === 1) return 'tipo';
    if (s === 2) return 'vuelo';
    if (s === 3) return 'donde';
    if (auxSteps() === 5) return s === 4 ? 'nivel' : 'revisar';
    return 'revisar';
  }
  function auxFormHTML() {
    const s = auxState.step, n = auxSteps(), kind = auxStepKind(s);
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
      return `<button class="ax-opt ${m.cls} ${sel ? 'sel' : ''}" data-ax="type" data-type="${type}">
        <span class="ax-opt-ic"><svg class="icon"><use href="#${m.ic}"/></svg></span>
        <div><b>${m.label}</b><span>${type === 'lle' ? 'Vengo aterrizando de un vuelo' : 'Voy al aeropuerto a operar un vuelo'}</span></div>
        <span class="ax-radio">${sel ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
      </button>`;
    };
    return `<p class="ax-lead">Elige el tipo de traslado.</p>${opt('sal')}${opt('lle')}
      <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Si tu vuelo incluye pernocta, lo marcas en el paso de dirección.</div>`;
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

  function auxStep2() {
    const isLle = auxState.form.type === 'lle';
    const f = auxState.form;
    return `
      ${auxField('Número de vuelo', 'flight', f.flight || '', 'Ej: AV-9412')}
      ${auxField('Fecha del vuelo', 'date', f.date || '', '', 'date', `min="${auxTodayISO()}"`)}
      ${auxField(isLle ? 'Hora de aterrizaje' : 'Hora de presentación', 'time', f.time || '', isLle ? '06:18' : '05:10', 'time')}
      <div id="ax-time-hints">${auxTimeHints()}</div>`;
  }
  // Va en su propio contenedor porque se repinta en cada tecla (junto con el
  // CTA) sin remontar los inputs — si no, el botón se deshabilitaba sin decir
  // por qué y el auxiliar se quedaba trancado sin entender.
  function auxTimeHints() {
    const f = auxState.form, isLle = f.type === 'lle';
    const lead = auxLeadCheck(f);
    if (lead) return `<div class="ax-hint ${lead.level === 'bad' ? 'bad' : ''}"><svg class="icon"><use href="#i-info"/></svg>${lead.text}</div>`;
    if (!f.time) return '';
    return `<div class="ax-hint ok"><svg class="icon"><use href="#i-clock"/></svg>${isLle ? 'Te esperamos al bajar del avión.' : `Recogida estimada <b>${auxSuggestPickup(f.time)}</b> · te dejamos en MDE antes de tu presentación.`}</div>`;
  }

  // Paso 3. Desde la entrega del 17-ago el camino PRINCIPAL es elegir el
  // conjunto del catálogo verificado (0055) — lo pinta aux-residencias.js. Lo de
  // abajo, escribir la dirección y arrastrar el pin, pasa a ser la EXCEPCIÓN:
  // se llega ahí solo si el auxiliar lo pide ("Mi punto no está en la lista") o
  // si el catálogo no cargó.
  function auxStep3() {
    const f = auxState.form;
    const isLle = f.type === 'lle';
    if (window.AuxResidencias) {
      const cat = AuxResidencias.html(f);
      if (cat != null) return cat;
    }
    // ── camino de excepción: texto libre + pin ──
    const volver = (window.AuxResidencias && AuxResidencias.hasCatalog() && f.manualAddr)
      ? `<button class="axr-back-cat" data-ax="res-catalog"><svg class="icon"><use href="#i-back"/></svg>Volver a la lista de conjuntos</button>`
      : '';
    return `
      ${volver}
      ${auxField(isLle ? 'Dirección donde te dejamos' : 'Dirección de recogida', 'address', f.address || '', 'Cra 51 #49-06, Centro')}
      <div class="ax-geo-hint">${isLle ? 'Casa, hotel o donde te quedes.' : 'Casa, hotel o donde estés esa noche.'}</div>
      <div id="ax-map" class="ax-map ${f.address ? '' : 'hidden'}"></div>
      <div id="ax-pin-row" class="ax-pin-row ${f.locConfirmed ? 'ok' : ''} ${f.address ? '' : 'hidden'}">
        ${f.locConfirmed
          ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-ax="pin-edit">Ajustar</button>`
          : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`}
      </div>
      ${!f.locConfirmed && f.address ? `<button class="ax-btn ax-btn-ghost" data-ax="pin-confirm"><svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación</button>` : ''}
      <div class="ax-toggles">
        ${auxToggle('¿Es una pernocta?', 'isPernocta', f.isPernocta, 'Pasas la noche entre vuelos (hotel).')}
        ${auxToggle('¿Es una reserva en firme?', 'isReserva', f.isReserva !== false, 'Confírmanos que el viaje va.')}
      </div>
      ${auxField('Notas para el conductor (opcional)', 'notes', f.notes || '', 'Ej: portería, torre 3', 'textarea')}`;
  }

  function auxStep4() {
    const f = auxState.form;
    const m = auxTypeMeta(f.type);
    const row = (k, v) => `<div class="ax-sum-row"><span>${k}</span><b>${v}</b></div>`;
    return `
      <div class="ax-sum">
        <div class="ax-sum-head ${m.cls}"><svg class="icon"><use href="#${m.ic}"/></svg>${m.label} · ${m.desc}</div>
        ${row('Vuelo', f.flight || '—')}
        ${row('Fecha', f.date ? auxDateES(f.date) : '—')}
        ${row(f.type === 'lle' ? 'Aterriza' : 'Presentación', auxHM(f.time))}
        ${row(f.residenceId ? (f.type === 'lle' ? 'Te dejamos en' : 'Te recogemos en') : 'Dirección', auxShortAddr(f.address))}
        ${f.residenceId ? `<div class="ax-sum-row"><span>Ubicación</span><b class="axr-ok">Verificada</b></div>` : ''}
        ${window.AuxPrivado && AuxPrivado.enabled()
          ? row('Servicio', f.level === 'private'
              ? 'Privado · ' + (AuxPrivado.money(AuxPrivado.price()) || '—')
              : 'Compartido · incluido')
          : ''}
        ${f.isPernocta ? row('Pernocta', 'Sí (hotel)') : ''}
        ${f.isReserva === false ? row('Reserva', 'Tentativa (sin confirmar)') : ''}
        ${f.notes ? row('Notas', f.notes) : ''}
      </div>
      <div class="ax-hint ok"><svg class="icon"><use href="#i-info"/></svg>Al confirmar, tu traslado entra a la planeación del día. Te avisamos cuando asignen conductor.</div>
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

  function auxFormCTA() {
    const s = auxState.step, f = auxState.form, kind = auxStepKind(s);
    const badDate = auxLeadCheck(f)?.level === 'bad';
    // Paso 3: con conjunto elegido no hay pin que confirmar (la coord la puso la
    // operación a mano), así que la condición la decide el módulo.
    const paso3Listo = window.AuxResidencias
      ? AuxResidencias.ready(f) : !!(f.address && f.locConfirmed);
    const disabled = (kind === 'tipo' && !f.type)
      || (kind === 'vuelo' && (!f.flight || !f.date || !f.time || badDate))
      || (kind === 'donde' && !paso3Listo)
      || (kind === 'nivel' && !f.level)
      || (kind === 'revisar' && badDate);
    const label = kind !== 'revisar' ? 'Continuar'
      : (f.level === 'private' ? 'Solicitar traslado privado' : 'Confirmar traslado');
    return `<button class="ax-btn ax-btn-primary" data-ax="next" ${disabled ? 'disabled' : ''}>${label}${kind !== 'revisar' ? '<svg class="icon"><use href="#i-arrow"/></svg>' : ''}</button>`;
  }

  // ---------- campos ----------
  function auxField(label, key, value, ph, type, attrs) {
    const input = type === 'textarea'
      ? `<textarea class="ax-input" data-field="${key}" rows="2" placeholder="${ph || ''}">${value}</textarea>`
      : `<input class="ax-input" data-field="${key}" type="${type || 'text'}" value="${value}" placeholder="${ph || ''}" ${attrs || ''} />`;
    return `<label class="ax-label">${label}${input}</label>`;
  }
  function auxToggle(label, key, on, hint) {
    return `<button class="ax-toggle ${on ? 'on' : ''}" data-ax="toggle" data-key="${key}">
      <div><b>${label}</b><span>${hint}</span></div>
      <span class="ax-switch"><span class="ax-knob"></span></span>
    </button>`;
  }

  // ---------- mapa + geocodificación (pin ajustable REAL) ----------
  function auxAfterFormRender() {
    if (auxState.step !== 3) return;
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
    // Re-render liviano del paso 3 sin remontar el mapa.
    const cta = auxRoot().querySelector('.ax-cta-bar'); if (cta) cta.innerHTML = auxFormCTA();
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
        toast('No ubicamos la dirección exacta — mueve el pin al punto correcto.');
      }
      auxState.form.locConfirmed = false;
      auxMountMap(auxState.form.lat, auxState.form.lng);
      auxRefreshPinRow();
    } catch (e) { /* silencioso: el usuario puede reintentar */ }
  }

  // ---------- confirmar → crea la reserva (BD real o demo) → confirmación ----------
  async function auxSubmit() {
    const f = auxState.form;
    const trip = {
      id: 't' + Date.now(),
      type: f.type, flight: f.flight, date: f.date, time: f.time,
      address: f.address, lat: f.lat, lng: f.lng,
      residenceId: f.residenceId || null,
      // 0069. El estado y el precio los pone el SERVIDOR; acá se guardan solo
      // para pintar la pantalla mientras llega el siguiente refresco.
      level: f.level === 'private' ? 'private' : 'shared',
      privateStatus: f.level === 'private' ? 'requested' : null,
      price: f.level === 'private' && window.AuxPrivado ? AuxPrivado.price() : null,
      isPernocta: !!f.isPernocta, isReserva: f.isReserva !== false, notes: f.notes || '',
      status: 'pending', driver: null, rated: false,
    };
    // Persistir en dev si hay sesión real; si falla, sigue como demo local.
    try { trip.id = await Api.createReservation(f); }
    catch (e) { toast('No se pudo guardar tu traslado. Revisa la conexión e intenta otra vez.'); return; }
    auxState.trips.unshift(trip);
    auxState.step = 1; auxState.form = {};
    auxState.editingTrip = trip.id; auxState.view = 'confirm';
    auxRender();
  }
  // ---------- P1: confirmación (justo tras reservar) ----------
  function auxConfirmHTML() {
    const t = auxState.trips.find(x => x.id === auxState.editingTrip); if (!t) { auxState.view = 'home'; return auxHomeHTML(); }
    const m = auxTypeMeta(t.type);
    const timeline = [
      { t: 'Ahora', label: 'Traslado solicitado', done: true },
      { t: 'En minutos', label: 'Asignamos tu conductor', done: false },
      { t: t.type === 'lle' ? auxHM(t.time) : auxSuggestPickup(t.time), label: t.type === 'lle' ? 'Recogida en el aeropuerto' : 'Recogida en tu dirección', done: false },
    ];
    return `
      <div class="ax-body ax-center">
        <div class="ax-success"><svg class="icon"><use href="#i-check"/></svg></div>
        <h1 class="ax-big">¡Traslado confirmado!</h1>
        <p class="ax-lead ax-tc">Tu ${m.label.toLowerCase()} quedó en la planeación del día. Te avisaremos cuando asignen conductor.</p>
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
    if (t.status === 'done' && !t.rated && t.driver) return auxRating(t); // P5
    return auxTripDetail(t); // pending / assigned (P2) / cancelado / no-show / done
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
    el.innerHTML = msgs.map(m => `<div class="ax-msg ${m.sender_role === 'auxiliar' ? 'mine' : 'their'}${m.sender_role === 'admin' ? ' rendio' : ''}">
      ${m.sender_role === 'admin' ? '<em>Rendio</em>' : ''}
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
        toast('Enviado. Tu conductor no tiene notificaciones activadas: lo verá al abrir la app.');
      }
      await auxChatSync(true);
    } catch (e) {
      auxState.chatMsgs = auxState.chatMsgs.filter(m => m.id !== temp.id);
      auxChatBubbles();
      i.value = body;
      toast((e && e.message) ? e.message : 'No se pudo enviar el mensaje.');
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
          <div class="ax-sum-row"><span>${t.type === 'lle' ? 'Aterriza' : 'Presentación'}</span><b>${auxDateES(t.date)} · ${auxHM(t.time)}</b></div>
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
    auxState.etaSecs = null; auxState.etaAt = 0; auxState.etaKind = null;
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
    let driverJustArrived = false;
    if (info.driver && info.driver.name) {
      driverJustArrived = !(t.driver && t.driver.name);
      t.driver = { name: info.driver.name, plate: info.plate || '—', phone: info.driver.phone || '', rating: null };
    }
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
    // Solo AVANZA (nunca retrocede), para no dar tumbos de pantalla.
    if (AUX_ORDER[ui] > (AUX_ORDER[t.status] || 0)) {
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
    if (driverJustArrived && ['assigned', 'onway', 'onboard'].includes(t.status)) {
      auxRender();
      return;
    }
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
      auxState.trackDestMk = L.circleMarker(destPt, { radius: 8, color: '#F26522', fillColor: '#F26522', fillOpacity: 1, weight: 3 }).addTo(map);
      auxPlotStops(t, info);
      if (driverPt) { auxMountCar(t, info, driverPt, destPt); map.fitBounds([driverPt, destPt], { padding: [55, 55] }); }
      else { map.setView(destPt, 14); }
      setTimeout(() => map.invalidateSize(), 60);
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
    if (auxState.trackDestMk) {
      auxState.trackDestMk.setStyle(pend.length ? { opacity: 0, fillOpacity: 0 } : { opacity: 1, fillOpacity: 1 });
    }
    if (!pend.length) return;
    const layer = auxState.stopLayer = L.layerGroup().addTo(map);
    pend.forEach((s, i) => {
      const mine = !!s.mine;
      const cls = `ax-stop${i === 0 ? ' next' : ''}${mine ? ' mine' : ''}`;
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
    const fIcon = L.divIcon({ className: '', html: `<div class="ax-stop end">${isApt ? '✈' : '🏠'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(finalPt, { icon: fIcon }).addTo(layer).bindTooltip(isApt ? 'Aeropuerto MDE' : 'Tu casa', { direction: 'top', offset: [0, -14] });
  }

  function auxMountCar(t, info, driverPt, destPt) {
    const carIcon = L.divIcon({ className: '', html: '<div class="ax-car">🚗</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
    // Arranca como línea recta punteada (es lo único cierto mientras OSRM
    // responde) y auxSyncRoute la reemplaza por la vía real en cuanto llega.
    auxState.trackLine = L.polyline([driverPt, destPt], { color: '#F4791F', weight: 4, opacity: .45, dashArray: '6 8' }).addTo(auxState.trackMap);
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
    } else {
      auxState.etaSecs = null; auxState.etaAt = 0;
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
  async function auxShareEta() {
    const t = auxCurTrip(); if (!t) return;
    const destino = t.type === 'lle' ? 'a casa' : 'al aeropuerto MDE';
    let txt = `Voy en camino ${destino}.`;
    if (auxState.etaSecs && auxState.etaAt) {
      const secs = auxState.etaSecs - (Date.now() - auxState.etaAt) / 1000;
      if (secs > 0) {
        try {
          const hora = new Date(Date.now() + secs * 1000)
            .toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
          txt = auxState.etaKind === 'dest'
            ? `Voy en camino ${destino}, llego sobre las ${hora} (estimado).`
            : `Me recogen sobre las ${hora} (estimado) y voy ${destino}.`;
        } catch (_) {}
      }
    }
    if (t.driver && t.driver.plate && t.driver.plate !== '—') txt += ` Carro ${t.driver.plate}.`;
    try {
      if (navigator.share) { await navigator.share({ text: txt }); return; }
      await navigator.clipboard.writeText(txt);
      toast('Texto copiado para compartir.');
    } catch (_) { /* el usuario canceló el compartir: no es un error */ }
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
    if (labelEl && valEl) {
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
  function auxGoTab(tab) {
    auxState.tab = tab || 'inicio';
    auxState.view = (tab === 'viajes' || tab === 'perfil') ? tab : 'home';
    auxState.confirmingCancel = false;
    auxRender();
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
    if (!a.motivo) { toast('Dinos qué está pasando.'); return; }
    if (!window.Api?.reportIncident) { toast('No se pudo enviar. Intenta de nuevo.'); return; }

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
      toast('Listo, ya avisamos a coordinación.');
    } catch (e) {
      console.error(e);
      a.sending = false; auxRender();
      toast('No se pudo enviar: ' + (e.message || 'revisa la señal'));
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
      toast('No se pudo cancelar. Intenta de nuevo.');
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
      toast(e.message && e.message.includes('en curso')
        ? 'El viaje ya está en curso: no se puede cancelar.'
        : 'No se pudo cancelar. Intenta de nuevo.');
      return;
    }
    t.status = 'cancelled'; t.cancelledAt = new Date().toISOString(); t.cancelReason = reason;
    auxState.confirmingCancel = false;
    auxStopTrack();
    toast('Traslado cancelado.');
    auxState.view = 'home'; auxState.tab = 'inicio';
    auxRender();
  }

  // ---------- eventos ----------
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
      if (a === 'install') { if (window.rendioInstall) window.rendioInstall.prompt(); return; }
      if (a === 'enable-push') { if (typeof enablePush === 'function') Promise.resolve(enablePush()).then(() => auxSetupPwa()); return; }
      if (a === 'new') {
        auxState.view = 'form'; auxState.step = 1; auxState.form = { isReserva: true };
        // El catálogo se pide ya, para que el paso 3 no muestre spinner.
        if (window.AuxResidencias) AuxResidencias.load();
        if (window.AuxPrivado) AuxPrivado.resetCupo();
        auxRender();
      }
      // ---- «Repetir el de siempre»: arranca en el paso 2, no en el 1 ----
      else if (a === 'repeat') {
        const last = auxLastTrip(); if (!last) return;
        auxState.view = 'form'; auxState.step = 2;
        auxState.form = {
          isReserva: true, type: last.type,
          notes: last.notes || '',
          residenceId: last.residenceId || null,
        };
        if (window.AuxResidencias) AuxResidencias.load();
        // Si el traslado anterior salió de un conjunto del catálogo, se repite
        // el conjunto. Si venía del camino manual (sin residencia), el paso 3 se
        // pide normal: repetir una dirección escrita a mano repetiría también su
        // pin, y ese es justo el dato que el catálogo vino a dejar de adivinar.
        if (auxState.form.residenceId) {
          auxState.form.address = last.address; auxState.form.lat = last.lat;
          auxState.form.lng = last.lng; auxState.form.locConfirmed = true;
        }
        auxRender();
      }
      // ---- 0069 · nivel de servicio (aux-privado.js) ----
      else if (a === 'lvl') {
        if (el.hasAttribute('disabled')) return;
        auxState.form.level = el.dataset.v;
        auxRender();
      }
      else if (a === 'lvl-info') { auxState.view = 'privado'; auxRender(); }
      else if (a === 'lvl-close') { auxState.view = 'form'; auxRender(); }
      // ---- §7 · catálogo de residencias (aux-residencias.js) ----
      else if (a && a.indexOf('res-') === 0 && window.AuxResidencias) {
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
      else if (a === 'cancel' || a === 'home') { auxState.view = 'home'; auxState.step = 1; auxState.form = {}; auxRender(); }
      else if (a === 'back') { auxState.step = Math.max(1, auxState.step - 1); auxRender(); }
      else if (a === 'next') {
        if (el.hasAttribute('disabled')) return;
        if (auxState.step < auxSteps()) {
          auxState.step++;
          // Al entrar al paso del nivel se le pregunta al servidor si la
          // camioneta está libre a esa hora. No se puede saber en el cliente.
          if (auxStepKind(auxState.step) === 'nivel' && window.AuxPrivado) {
            if (!auxState.form.level) auxState.form.level = 'shared';
            AuxPrivado.askCupo(auxWhenISO(auxState.form));
          }
          auxRender();
        } else auxSubmit();
      }
      else if (a === 'type') { auxState.form.type = el.dataset.type; auxRender(); }
      else if (a === 'toggle') { const k = el.dataset.key; auxState.form[k] = !auxState.form[k]; auxRender(); }
      else if (a === 'pin-confirm') { auxState.form.locConfirmed = true; auxRefreshPinRow(); toast('Ubicación confirmada.'); }
      else if (a === 'pin-edit') { auxState.form.locConfirmed = false; auxRefreshPinRow(); }
      else if (a === 'trip') { auxState.editingTrip = el.dataset.id; auxState.view = 'trip'; auxState.ratingSel = 0; auxState.ratingTags = []; auxState.confirmingCancel = false; auxRender(); }
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
        if (!window.Api?.confirmReservationReady) { el.disabled = false; toast('No se pudo confirmar. Intenta de nuevo.'); return; }
        Api.confirmReservationReady(t.id)
          .then(() => { t.readyAt = new Date().toISOString(); toast('Listo — le avisamos a tu conductor.'); auxRender(); })
          .catch(() => { el.disabled = false; toast('No se pudo confirmar. Intenta de nuevo.'); });
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
        else toast('Aún no hay teléfono del conductor.');
      }
      else if (a === 'share-eta') { auxShareEta(); }
      // --- chat con el conductor ---
      else if (a === 'chat') { auxChatOpen(); }
      else if (a === 'chat-close') { auxChatClose(); }
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
            .catch(() => toast('No se pudo guardar la calificación en el servidor.'));
        }
        toast('¡Gracias por tu calificación!'); auxState.view = 'home'; auxRender();
      }
      else if (a === 'rate-skip') { const t = auxCurTrip(); if (t) t.rated = true; auxState.view = 'home'; auxRender(); }
    });

    root.addEventListener('input', (e) => {
      // Buscador del catálogo: repinta SOLO la lista. Si repintáramos el paso
      // entero se remonta el input y el cursor salta al final en cada tecla.
      if (e.target && e.target.id === 'axr-q') {
        if (window.AuxResidencias) AuxResidencias.onQuery(e.target.value, auxState.form);
        return;
      }
      const el = e.target.closest('[data-field]'); if (!el) return;
      const k = el.dataset.field;
      auxState.form[k] = el.value;
      if (k === 'address') {
        auxState.form.locConfirmed = false;
        clearTimeout(auxState.geoTimer);
        const q = el.value.trim();
        if (q.length >= 6) auxState.geoTimer = setTimeout(() => auxGeocode(q), 700);
      }
      // habilita/inhabilita el CTA sin remontar (no perder foco del input)
      const cta = auxRoot().querySelector('.ax-cta-bar'); if (cta) cta.innerHTML = auxFormCTA();
      // …y con él, el aviso de fecha/antelación: si no, el botón se apagaba mudo.
      if (k === 'date' || k === 'time') {
        const hints = document.getElementById('ax-time-hints');
        if (hints) hints.innerHTML = auxTimeHints();
      }
    });
  }
