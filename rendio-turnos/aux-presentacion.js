// aux-presentacion.js — Bloque A de la entrega: presentación + modo nocturno.
//
// POR QUÉ
// Palabras del diseñador: son «los bordes que delataban software interno». La
// app del pasajero ya hacía bien lo difícil (pedir, seguir, chatear, calificar)
// y fallaba en lo que se ve primero: no había primer minuto, el permiso de
// notificaciones se pedía a secas, y quedarse sin señal era una pantalla en
// blanco. Nada de esto reemplaza una pantalla existente: se añade.
//
// Y el modo nocturno, que es lo único de aquí que toca todas las pantallas: la
// mitad de los traslados arrancan entre 3 y 5 de la mañana.

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // A5 · Modo nocturno
  // ═══════════════════════════════════════════════════════════════════════════
  // Automático 19:00–05:59 hora de Colombia, con override manual. La decisión de
  // que sea automático POR DEFECTO es del diseñador y tiene razón operativa:
  // quien sale a las 3 a.m. no va a entrar a Ajustes a cambiar el tema; y quien
  // lo odie lo apaga una vez y queda.
  const KEY_THEME = 'rendio.aux.night';   // 'auto' | 'light' | 'night'
  const KEY_ONB   = 'rendio.aux.onboarded';

  function pref() {
    try { return localStorage.getItem(KEY_THEME) || 'auto'; } catch (_) { return 'auto'; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY_THEME, v); } catch (_) {}
    apply();
  }
  // Hora de Colombia, no la del dispositivo: un tripulante que aterriza de un
  // vuelo internacional puede traer el teléfono en otra zona.
  function bogotaHour() {
    try {
      return Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Bogota', hour: '2-digit', hour12: false,
      }).format(new Date()));
    } catch (_) { return new Date().getHours(); }
  }
  function isNight() {
    const p = pref();
    if (p === 'night') return true;
    if (p === 'light') return false;
    const h = bogotaHour();
    return h >= 19 || h < 6;
  }
  function apply() {
    const el = document.getElementById('auxiliar-ui'); if (!el) return;
    const on = isNight();
    el.setAttribute('data-ax-night', on ? 'on' : 'off');
    // data-theme se conserva en 'light' a propósito: el dark genérico del
    // sistema es para consola de escritorio y no es el que queremos aquí.
    el.setAttribute('data-theme', 'light');
  }
  // Con 'auto' el tema tiene que cambiar solo si la app queda abierta cruzando
  // las 7 p.m. o las 6 a.m. Se revisa cada 10 min: no vale la pena más fino.
  let tick = null;
  function watch() {
    if (tick) return;
    tick = setInterval(() => { if (pref() === 'auto') apply(); }, 600000);
  }

  // Control en Perfil
  function themeHTML() {
    const p = pref();
    const opt = (v, ic, label) => `<button class="axn-opt${p === v ? ' on' : ''}" data-ax="theme" data-v="${v}">
      <svg class="icon"><use href="#${ic}"/></svg>${label}</button>`;
    return `
      <div class="axn-theme">
        ${opt('auto', 'i-clock', 'Automático')}
        ${opt('light', 'i-sun', 'Claro')}
        ${opt('night', 'i-moon', 'Nocturno')}
      </div>
      <div class="axn-note">En automático se pone oscuro entre 7 p.m. y 6 a.m., hora de Colombia. Está pensado para leer dentro de un carro de noche, no para ahorrar batería.</div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A2 · Primer ingreso (3 pantallas) + A3 · el permiso, con motivo
  // ═══════════════════════════════════════════════════════════════════════════
  // Se muestra UNA vez. No pide datos ni promete nada que la app no haga: las
  // tres pantallas cuentan lo que sí existe hoy.
  const SLIDES = [
    {
      ic: 'i-plane',
      h: 'Pide tu traslado, no lo coordines',
      p: 'Dinos el vuelo y de dónde sales. Nosotros armamos la ruta, elegimos el carro y te asignamos conductor. No tienes que llamar a nadie.',
    },
    {
      ic: 'i-pin',
      h: 'Ya sabemos dónde queda tu portería',
      p: 'Tenemos ubicadas las porterías de los conjuntos de Rionegro con la coordenada medida a mano. Eliges la tuya de una lista: no escribes direcciones ni arrastras pines.',
    },
    {
      ic: 'i-users',
      h: 'Vas a saber quién te recoge',
      p: 'Cuando te asignen conductor te avisamos con su nombre y la placa. El día del viaje puedes escribirle o llamarlo desde la app.',
    },
  ];

  function onboarded() {
    try { return localStorage.getItem(KEY_ONB) === '1'; } catch (_) { return true; }
  }
  function markOnboarded() {
    try { localStorage.setItem(KEY_ONB, '1'); } catch (_) {}
  }

  function slideHTML(i) {
    const s = SLIDES[i]; if (!s) return '';
    const last = i === SLIDES.length - 1;
    return `
      <div class="axo">
        <div class="axo-dots">${SLIDES.map((_, n) => `<span class="axo-dot${n <= i ? ' on' : ''}"></span>`).join('')}</div>
        <div class="axo-art"><svg class="icon"><use href="#${s.ic}"/></svg></div>
        <h1>${s.h}</h1>
        <p>${s.p}</p>
        <div class="axo-acts">
          <button class="ax-btn ax-btn-primary" data-ax="onb-next">${last ? 'Entendido' : 'Siguiente'}<svg class="icon"><use href="#i-arrow"/></svg></button>
          <button class="axo-skip" data-ax="onb-skip">Saltar</button>
        </div>
      </div>`;
  }

  // El permiso con motivo. Antes se pedía con el diálogo del navegador a secas,
  // que es la forma más segura de que digan "No" para siempre: una vez denegado,
  // el navegador no vuelve a preguntar y no hay forma de avisarle a esa persona
  // que su conductor está afuera.
  function notifyHTML() {
    return `
      <div class="axo">
        <div class="axo-art"><svg class="icon"><use href="#i-info"/></svg></div>
        <h1>¿Te avisamos?</h1>
        <p>Son tres avisos, y todos son del día de tu viaje. Nada de promociones.</p>
        <div class="axo-why">
          <div class="axo-why-row"><svg class="icon"><use href="#i-user"/></svg>
            <div><b>Cuando te asignen conductor</b><span>Con su nombre y la placa del carro.</span></div></div>
          <div class="axo-why-row"><svg class="icon"><use href="#i-van"/></svg>
            <div><b>Cuando salga hacia tu punto</b><span>Para que sepas cuánto falta sin estar mirando la app.</span></div></div>
          <div class="axo-why-row"><svg class="icon"><use href="#i-warn"/></svg>
            <div><b>Si algo cambia</b><span>Un retraso que te afecte, o un cambio de carro.</span></div></div>
        </div>
        <div class="axo-acts">
          <button class="ax-btn ax-btn-primary" data-ax="onb-allow"><svg class="icon"><use href="#i-check"/></svg>Sí, avísenme</button>
          <button class="axo-skip" data-ax="onb-later">Ahora no</button>
        </div>
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A6 · Estados adversos · A7 · Soporte
  // ═══════════════════════════════════════════════════════════════════════════
  function offlineHTML() {
    return `
      <div class="axs">
        <div class="axs-ic"><svg class="icon"><use href="#i-info"/></svg></div>
        <h2>Sin conexión</h2>
        <p>Tu traslado sigue en pie: lo que ya pediste está guardado en nuestros servidores, no en el teléfono. Vuelve a intentar cuando tengas señal.</p>
        <button class="ax-btn ax-btn-primary" data-ax="reload"><svg class="icon"><use href="#i-refresh"/></svg>Reintentar</button>
      </div>`;
  }

  // Soporte. Sin WhatsApp: el diseñador lo sacó a propósito en esta entrega
  // porque la app ya tiene chat propio con el conductor y botón de llamar, y
  // meter un tercer canal fuera de la app es perder el rastro de lo que se dijo.
  // El botón rojo NO se duplica acá: ese vive en la pantalla del viaje, que es
  // donde tiene contexto de cuál traslado se está rompiendo.
  function supportHTML(hasTrip) {
    return `
      <div class="ax-form-head">
        <button class="ax-icbtn" data-ax="sup-close"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>Algo no va bien</b><span></span>
      </div>
      <div class="ax-body">
        <p class="ax-lead">Dependiendo de qué sea, hay un camino más rápido que otro.</p>
        ${hasTrip ? `
          <button class="axs-ch" data-ax="sup-trip">
            <span class="axs-ch-ic"><svg class="icon"><use href="#i-warn"/></svg></span>
            <span class="axs-ch-txt"><b>Algo va a retrasar mi viaje de hoy</b>
              <span>Abre tu traslado y avisa desde ahí — le llega a coordinación y a tu conductor.</span></span>
            <svg class="icon axr-chev"><use href="#i-chev"/></svg>
          </button>` : ''}
        <button class="axs-ch" data-ax="sup-push">
          <span class="axs-ch-ic"><svg class="icon"><use href="#i-info"/></svg></span>
          <span class="axs-ch-txt"><b>No me llegan los avisos</b>
            <span>Revisa si están activadas las notificaciones de la app.</span></span>
          <svg class="icon axr-chev"><use href="#i-chev"/></svg>
        </button>
        <div class="ax-sec">Si es otra cosa</div>
        <div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>Escríbele a tu coordinador de tripulación. Tu cuenta la creó la operación: cambios de correo, de teléfono o de conjunto los hace un administrador, no se editan desde aquí.</div>
        <div class="ax-spacer"></div>
      </div>`;
  }

  window.AuxPresentacion = {
    // tema
    applyTheme: apply, watchTheme: watch, themeHTML, themePref: pref, setThemePref: setPref, isNight,
    // primer ingreso
    onboarded, markOnboarded, slideHTML, notifyHTML, slideCount: SLIDES.length,
    // estados
    offlineHTML, supportHTML,
  };
})();
