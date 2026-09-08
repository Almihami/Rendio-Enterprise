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
  // Las tres escenas. Cada una es un DIBUJO PROPIO que se anima, no un icono de
  // 30 px dentro de un cuadrado — que era lo que había, y lo que la profa
  // resumió el 7-sep-2026 como «muy estáticas, no están centradas, no muestran
  // nada nuevo». El dibujo cuenta lo mismo que el título: la ruta se traza sola
  // (nadie la coordina), el pin cae y queda verificado, el carro llega con
  // nombre y placa.
  //
  // Todo es SVG en línea + keyframes de CSS: sin librerías, sin GIF, sin red.
  // Pesa ~2 kB y arranca al primer cuadro, que es lo que importa en un teléfono
  // de gama media a las 3 de la mañana. Quien tenga «reducir movimiento» activo
  // ve el estado final quieto (rc-auxiliar.css lo apaga entero).
  const SLIDES = [
    {
      art: 'ruta',
      h: 'Pide tu traslado, no lo coordines',
      p: 'Dinos el vuelo y de dónde sales. Nosotros armamos la ruta, elegimos el carro y te asignamos conductor. No tienes que llamar a nadie.',
    },
    {
      art: 'punto',
      h: 'Ya sabemos dónde queda tu portería',
      p: 'Tenemos ubicadas las porterías de los conjuntos de Rionegro con la coordenada medida a mano. Eliges la tuya de una lista: no escribes direcciones ni arrastras pines.',
    },
    {
      art: 'conductor',
      h: 'Vas a saber quién te recoge',
      p: 'Cuando te asignen conductor te avisamos con su nombre y la placa. El día del viaje puedes escribirle o llamarlo desde la app.',
    },
  ];

  // ── Las escenas ───────────────────────────────────────────────────────────
  // Sin texto real adentro: son formas. Un nombre o una placa dibujados aquí
  // serían un dato inventado, y en la primera pantalla de la app eso es
  // exactamente lo que no se debe hacer.
  const ART = {
    // La ruta se traza sola desde la tarjeta del pedido hasta el avión.
    ruta: `
      <svg class="axo-scene axo-ruta" viewBox="0 0 280 190" fill="none" aria-hidden="true">
        <defs><radialGradient id="axo-glow" cx="50%" cy="50%" r="50%">
          <stop class="ax-g0" offset="0"/><stop class="ax-g1" offset="1"/>
        </radialGradient></defs>
        <ellipse class="ax-glow" cx="140" cy="96" rx="98" ry="74"/>
        <g class="ax-card">
          <path class="ax-bub" d="M30 106H106a14 14 0 0 1 14 14v18a14 14 0 0 1-14 14H46l-14 13v-13h-2a14 14 0 0 1-14-14v-18a14 14 0 0 1 14-14z"/>
          <rect class="ax-l1" x="30" y="118" width="50" height="7" rx="3.5"/>
          <rect class="ax-l2" x="30" y="131" width="72" height="7" rx="3.5"/>
          <rect class="ax-l3" x="30" y="144" width="34" height="7" rx="3.5"/>
        </g>
        <path class="ax-track" d="M44 100C92 96 130 76 168 40"/>
        <path class="ax-route" d="M44 100C92 96 130 76 168 40"/>
        <circle class="ax-dot" cx="44" cy="100" r="5"/>
        <g class="ax-plane">
          <path d="M21 0 4-3-2-15h-5l2 12-9 0-3-7h-3l1 7-2 3 2 3-1 7h3l3-7 9 0-2 12h5l6-12z"/>
        </g>
      </svg>`,

    // El pin cae sobre el plano y la portería queda marcada como verificada.
    punto: `
      <svg class="axo-scene axo-punto" viewBox="0 0 280 190" fill="none" aria-hidden="true">
        <defs><radialGradient id="axo-glow" cx="50%" cy="50%" r="50%">
          <stop class="ax-g0" offset="0"/><stop class="ax-g1" offset="1"/>
        </radialGradient></defs>
        <ellipse class="ax-glow" cx="140" cy="104" rx="96" ry="66"/>
        <g class="ax-map">
          <rect x="42" y="52" width="196" height="112" rx="18"/>
          <path class="ax-st" d="M42 96h196M42 132h196M104 52v112M176 52v112"/>
          <rect class="ax-blk" x="52" y="104" width="40" height="20" rx="5"/>
          <rect class="ax-blk" x="188" y="62" width="40" height="26" rx="5"/>
        </g>
        <circle class="ax-ring" cx="140" cy="118" r="16"/>
        <circle class="ax-ring ax-ring2" cx="140" cy="118" r="16"/>
        <g class="ax-pin">
          <path d="M140 78c-11 0-20 9-20 20 0 14 20 34 20 34s20-20 20-34c0-11-9-20-20-20z"/>
          <circle class="ax-pin-hole" cx="140" cy="98" r="7"/>
        </g>
        <g class="ax-ok">
          <circle cx="188" cy="82" r="15"/>
          <path class="ax-tick" d="M181 82l5 5 10-11"/>
        </g>
      </svg>`,
    // El carro llega y aparece la ficha de quien maneja.
    conductor: `
      <svg class="axo-scene axo-cond" viewBox="0 0 280 190" fill="none" aria-hidden="true">
        <defs><radialGradient id="axo-glow" cx="50%" cy="50%" r="50%">
          <stop class="ax-g0" offset="0"/><stop class="ax-g1" offset="1"/>
        </radialGradient></defs>
        <ellipse class="ax-glow" cx="140" cy="98" rx="98" ry="70"/>
        <path class="ax-road" d="M14 150h252"/>
        <path class="ax-dashes" d="M22 162h26M62 162h26M102 162h26M142 162h26M182 162h26M222 162h26"/>
        <g class="ax-car">
          <path class="ax-body" d="M46 138v-20c0-6 4-10 10-10h20l16-20c3-4 7-6 12-6h44c5 0 9 2 12 6l16 20h20c6 0 10 4 10 10v20z"/>
          <path class="ax-win" d="M96 108l12-16c2-3 4-4 7-4h50c3 0 5 1 7 4l12 16z"/>
          <circle class="ax-wheel" cx="82" cy="138" r="13"/>
          <circle class="ax-wheel" cx="188" cy="138" r="13"/>
        </g>
        <g class="ax-chip">
          <rect x="76" y="20" width="128" height="46" rx="14"/>
          <circle class="ax-av" cx="102" cy="43" r="14"/>
          <rect class="ax-l1" x="126" y="32" width="56" height="8" rx="4"/>
          <rect class="ax-l2" x="126" y="47" width="38" height="8" rx="4"/>
        </g>
      </svg>`,
  };

  // LA MARCA ES POR PERSONA, NO POR NAVEGADOR (7-sep-2026).
  //
  // Estaba en una sola llave, `rendio.aux.onboarded`, así que el navegador
  // entero quedaba «ya presentado»: quien creara una cuenta nueva en un aparato
  // donde alguien ya había entrado NO veía la bienvenida. Se descubrió probando
  // en producción con un tripulante recién registrado, que es justo el caso al
  // que va dirigida la pantalla.
  //
  // Se guarda por id de perfil. La llave VIEJA se ignora a propósito: estas tres
  // pantallas se rehicieron enteras el 7-sep-2026 (otras escenas, otro texto,
  // movimiento), así que quien vio las de antes no ha visto estas. Se le muestran
  // una vez y ya. Heredarle la marca vieja a la primera cuenta que entrara era
  // peor: dejaba sin bienvenida justo al tripulante recién creado, que es el
  // caso que destapó todo esto.
  function quien() {
    try {
      const p = (window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.profile) || null;
      return p && p.id ? String(p.id) : null;
    } catch (_) { return null; }
  }
  function onboarded() {
    try {
      const id = quien();
      if (!id) return localStorage.getItem(KEY_ONB) === '1';   // sin perfil, lo de antes
      return localStorage.getItem(KEY_ONB + '.' + id) === '1';
    } catch (_) { return true; }
  }
  function markOnboarded() {
    try {
      const id = quien();
      localStorage.setItem(id ? KEY_ONB + '.' + id : KEY_ONB, '1');
      if (id) localStorage.removeItem(KEY_ONB);   // la llave de todo el navegador ya no manda
    } catch (_) {}
  }
  // Para volver a verla desde Perfil: se borra la marca de ESTA cuenta.
  function resetOnboarding() {
    try {
      const id = quien();
      if (id) localStorage.removeItem(KEY_ONB + '.' + id);
      localStorage.removeItem(KEY_ONB);
    } catch (_) {}
  }

  // La pantalla. Tres cambios sobre lo que había:
  //  · CENTRADA. Antes el contenido se pegaba arriba a la izquierda y el botón
  //    al fondo, con un hueco muerto en medio — que es lo que se veía como
  //    «no está centrada».
  //  · La escena manda: ocupa el bloque de arriba y se anima al entrar.
  //  · Se puede DESLIZAR entre pantallas y tocar los puntos para saltar. El
  //    número de pantalla se dice también en texto, para quien no vea los puntos.
  function slideHTML(i) {
    const s = SLIDES[i]; if (!s) return '';
    const last = i === SLIDES.length - 1;
    return `
      <div class="axo axo-slide" data-onb-slide="${i}">
        <div class="axo-top">
          <span class="axo-count">${i + 1} de ${SLIDES.length}</span>
          <button class="axo-skip" data-ax="onb-skip">Saltar</button>
        </div>
        <div class="axo-stage">
          ${ART[s.art] || ''}
        </div>
        <div class="axo-copy">
          <h1>${s.h}</h1>
          <p>${s.p}</p>
        </div>
        <div class="axo-dots">${SLIDES.map((_, n) => `<button class="axo-dot${n === i ? ' on' : ''}${n < i ? ' seen' : ''}" data-ax="onb-go" data-i="${n}" aria-label="Pantalla ${n + 1}"></button>`).join('')}</div>
        <div class="axo-acts">
          <button class="ax-btn ax-btn-primary" data-ax="onb-next">${last ? 'Entendido' : 'Siguiente'}<svg class="icon"><use href="#i-arrow"/></svg></button>
        </div>
      </div>`;
  }

  // Deslizar entre pantallas. Se ata al contenedor recién pintado (auxiliar.js
  // rehace el HTML en cada paso, así que no hay nada que desatar).
  // El umbral son 40 px: menos que eso es un toque tembloroso, no un gesto.
  function bindSwipe(root, onNext, onPrev) {
    const el = root && root.querySelector('.axo-slide'); if (!el) return;
    let x0 = null, y0 = null;
    el.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      // Horizontal de verdad: si el dedo bajó más de lo que corrió, era scroll.
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) onNext(); else onPrev();
    }, { passive: true });
  }

  // El permiso con motivo. Antes se pedía con el diálogo del navegador a secas,
  // que es la forma más segura de que digan "No" para siempre: una vez denegado,
  // el navegador no vuelve a preguntar y no hay forma de avisarle a esa persona
  // que su conductor está afuera.
  function notifyHTML() {
    return `
      <div class="axo axo-ask">
        <div class="axo-top"><span class="axo-count">Último paso</span><span></span></div>
        <div class="axo-stage axo-stage-sm">
          <svg class="axo-scene axo-bell" viewBox="0 0 280 150" fill="none" aria-hidden="true">
            <defs><radialGradient id="axo-glow" cx="50%" cy="50%" r="50%">
          <stop class="ax-g0" offset="0"/><stop class="ax-g1" offset="1"/>
        </radialGradient></defs>
        <ellipse class="ax-glow" cx="140" cy="78" rx="80" ry="54"/>
            <g class="ax-bell">
              <path d="M140 34c-16 0-28 12-28 28 0 22-6 30-12 36h80c-6-6-12-14-12-36 0-16-12-28-28-28z"/>
              <path class="ax-clap" d="M131 106a9 9 0 0 0 18 0"/>
              <circle class="ax-top" cx="140" cy="28" r="5"/>
            </g>
            <path class="ax-wave ax-w1" d="M186 52a34 34 0 0 1 0 42"/>
            <path class="ax-wave ax-w2" d="M94 52a34 34 0 0 0 0 42"/>
          </svg>
        </div>
        <div class="axo-copy">
          <h1>¿Te avisamos?</h1>
          <p>Son tres avisos, y todos son del día de tu viaje. Nada de promociones.</p>
        </div>
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
    onboarded, markOnboarded, resetOnboarding, slideHTML, notifyHTML, bindSwipe, slideCount: SLIDES.length,
    // estados
    offlineHTML, supportHTML,
  };
})();
