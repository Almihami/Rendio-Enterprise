// aux-celebracion.js — La escena de «¡Traslado confirmado!»: el avión recorre
// la ruta UNA vez, aterriza, cae el sello y suena.
//
// POR QUÉ EXISTE
// Hasta el 15-sep-2026 la confirmación era un círculo verde con un chulo: la
// misma pantalla para quien pidió su primer traslado y para quien lleva cien.
// La profa pidió que el momento se sintiera como lo que es —quedó pedido, ya
// puedes soltar el teléfono— con el avión de la presentación recorriendo la
// ruta y un sonido corto al aterrizar. Es el único punto del rol con sonido, a
// propósito: es el cierre de la tarea, no un adorno más.
//
// LA TÉCNICA ES LA DE aux-presentacion.js / .axo-ruta (rc-auxiliar.css)
// El avión va PEGADO a la curva con offset-path y la estela se dibuja detrás
// con stroke-dashoffset. Las dos animaciones solo van juntas si comparten
// duración, retardo, curva de tiempo y porcentajes; el CSS lo explica. Aquí la
// diferencia es que el viaje ocurre UNA vez (no en bucle) y termina en un sello.
//
// EL SONIDO Y iOS
// Safari en iPhone solo deja crear o reanudar un AudioContext DENTRO de un
// gesto del usuario. Confirmar es `async` (espera a la BD), así que para cuando
// se pinta esta pantalla el gesto ya pasó y el audio quedaría mudo. Por eso
// prime() se llama SINCRÓNICAMENTE en el clic de «Confirmar traslado» (el
// handler `next` de auxiliar.js, justo antes de auxSubmit) y afterRender() solo
// usa el contexto que ya quedó desbloqueado. Sin AudioContext (jsdom,
// navegadores viejos) no pasa nada: todo va en try/catch.
//
// LO QUE NO HACE
// No repite el sonido si la pantalla se repinta (guarda el id del último
// traslado celebrado) y no suena ni se mueve para quien pidió menos movimiento
// (prefers-reduced-motion): ahí se muestra el estado final, quieto.

(function () {
  'use strict';

  // La silueta del avión es la misma de aux-presentacion.js (ART.ruta): la
  // nariz apunta a +x, así offset-rotate:auto la orienta sola con la curva.
  const PLANE = 'M21 0 4-3-2-15h-5l2 12-9 0-3-7h-3l1 7-2 3 2 3-1 7h3l3-7 9 0-2 12h5l6-12z';
  // La curva de la ruta. Su largo (201,8) está ESCRITO en rc-auxiliar.css: si
  // se cambia aquí hay que volver a medirlo allá o la estela se desincroniza.
  const CURVE = 'M44 104C110 100 160 80 236 46';
  const FROM = { x: 44, y: 104 };
  const TO = { x: 236, y: 46 };

  // ── Los glifos de los extremos ────────────────────────────────────────────
  // Sin texto: la casa es el trazo de i-home y el avión la misma silueta, más
  // pequeña e inclinada como despegando. Cada uno va sobre una «loseta» redonda
  // para que la ruta nazca y muera en un borde, no en el vacío.
  function glyph(what, p) {
    if (what === 'home') {
      return `<g class="axc-glyph" transform="translate(${p.x - 12} ${p.y - 12})">
          <path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>
        </g>`;
    }
    return `<g class="axc-glyph-fill" transform="translate(${p.x} ${p.y}) rotate(-35) scale(.6) translate(-3 0)">
        <path d="${PLANE}"/>
      </g>`;
  }
  function stop(cls, side, what, p) {
    return `<g class="${cls}" data-side="${side}" data-what="${what}">
        <circle class="axc-pad" cx="${p.x}" cy="${p.y}" r="18"/>
        ${glyph(what, p)}
      </g>`;
  }

  // ── La escena ─────────────────────────────────────────────────────────────
  // En la salida la casa queda a la izquierda y el avión-destino a la derecha;
  // en la llegada al revés. El avión viajero siempre va de izquierda a derecha:
  // lo que cambia es de dónde sale y a dónde llega.
  function sceneHTML(t) {
    const lle = !!t && t.type === 'lle';
    const vip = !!t && t.level === 'private';
    const fromWhat = lle ? 'plane' : 'home';
    const toWhat = lle ? 'home' : 'plane';
    return `<div class="axc${vip ? ' vip' : ''}">
      <svg class="axc-scene" viewBox="0 0 280 150" fill="none" aria-hidden="true">
        <path class="axc-track" d="${CURVE}"/>
        <path class="axc-route" d="${CURVE}"/>
        ${stop('axc-from', 'left', fromWhat, FROM)}
        ${stop('axc-to', 'right', toWhat, TO)}
        <g class="axc-plane"><path d="${PLANE}"/></g>
        <g class="axc-ok">
          <circle cx="${TO.x + 13}" cy="${TO.y - 13}" r="12"/>
          <path class="axc-tick" d="M${TO.x + 7.5} ${TO.y - 12.5}l4 4 7.5-7.5"/>
        </g>
      </svg>
    </div>`;
  }

  // ── Menos movimiento ──────────────────────────────────────────────────────
  // Se comprueba por typeof: en jsdom no hay matchMedia y no queremos que la
  // celebración explote en las pruebas.
  function reduced() {
    try {
      return typeof window.matchMedia === 'function'
        && !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  // ── Sonido ────────────────────────────────────────────────────────────────
  let ctx = null;   // el AudioContext, uno para toda la sesión
  let lastId = null; // id del último traslado que ya sonó

  function prime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      // Un contexto creado fuera del gesto nace 'suspended'; reanudarlo aquí,
      // dentro del clic, es lo que lo desbloquea en iOS.
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (e) { /* sin audio no pasa nada */ }
  }

  // Dos notas suaves de seno (Mi5 → La5), ~0,45 s en total, ganancia máxima
  // 0,12 con ataque y caída exponenciales: un «ding» de aviso, no una alarma.
  function ding() {
    try {
      if (!ctx || ctx.state === 'closed') return;
      const t0 = ctx.currentTime;
      const note = (freq, at, dur) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(at);
        o.stop(at + dur + 0.02);
      };
      note(659.25, t0, 0.22);       // Mi5
      note(880, t0 + 0.2, 0.25);    // La5
    } catch (e) { /* sin audio no pasa nada */ }
  }

  function vibrate() {
    try {
      if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate([30, 60, 30]);
    } catch (e) { /* algunos navegadores lo rechazan sin gesto: da igual */ }
  }

  // Se llama después de pintar la pantalla de confirmación. El aterrizaje
  // ocurre a ~1,6 s (ver rc-auxiliar.css): el sonido y la vibración van ahí.
  function afterRender(t) {
    try {
      if (!t || reduced()) return;
      const key = String(t.id == null ? '' : t.id);
      if (key === lastId) return;
      lastId = key;
      setTimeout(() => {
        // Si ya se fue de la pantalla (tocó «Ver mis viajes» en ese segundo y
        // medio) no suena nada: el sonido es del aterrizaje, no del tiempo.
        try { if (!document.querySelector('#auxiliar-ui .axc-scene')) return; } catch (e) { return; }
        ding();
        vibrate();
      }, 1500);
    } catch (e) { /* nunca debe tumbar el render */ }
  }

  window.AuxCelebracion = { sceneHTML, afterRender, prime };
})();
