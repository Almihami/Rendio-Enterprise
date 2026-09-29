// aux-privado.js — Traslado privado: la camioneta, no un carro más.
//
// QUÉ ES
// El segundo nivel de servicio del auxiliar. El COMPARTIDO es el servicio
// incluido: se agrupa por sector y sale en la flota. El PRIVADO va en un
// vehículo dedicado — la camioneta —, no se agrupa con nadie, tiene tarifa y lo
// aprueba un jefe antes de comprometerse.
//
// EL NIVEL "DIRECTO" NO ESTÁ, y no es un olvido: la operación no lo ha definido
// (decisión de la profa, 2026-08-17). Cuando se defina, entra como una tarjeta
// más en el paso y una etiqueta más en el enum de 0069.
//
// TRES REGLAS DEL BRIEF QUE ESTE ARCHIVO NO PUEDE ROMPER
//  1. El compartido NUNCA se ve castigado. No es "el básico": es el servicio
//     incluido, y se describe en positivo (vas con tu tripulación). Prohibido el
//     lenguaje comparativo peyorativo — van compañeros de la misma tripulación
//     en los dos, y si el compartido se siente de segunda clase eso genera
//     resentimiento y la aerolínea lo va a oír.
//  2. El privado NO se promete siempre disponible. Hay UNA camioneta: si está
//     comprometida en esa franja, se dice, y no se ofrece.
//  3. Paleta fija, sin modo nocturno. Es el único bloque del rol que no se
//     apaga de noche, a propósito ("papel y tinta", decisión del diseñador).
//
// LA PIEL «RENDIO SELECT» (15-sep-2026)
// La profa pidió que el privado «se sienta distinto», y el diseñador ya lo
// había resuelto en aux-service-levels.jsx (LevelCard, rama vip) y aux-vip.jsx
// (VipIntro): espresso + latón + serif, no un negro de modo oscuro. Aquí se
// sigue ESA guía en lo visual y se adapta en lo que la maqueta inventaba y la
// operación no tiene: sin kit de consumibles, sin códigos de encuentro, sin
// cupos numéricos, con el precio real de Ajustes y con la aprobación del jefe.
// Las variables --vip-* viven en rc-auxiliar.css; los textos, aquí.
//
// POR QUÉ NINGÚN TEXTO DE AQUÍ PROMETE UNA NOTIFICACIÓN
// Se comprobó contra dev: de 102 auxiliares, **3** tienen un dispositivo con
// notificaciones activadas. Decirle a alguien "te avisamos apenas responda" es
// prometer un canal que 99 de cada 102 no tienen. Así que la respuesta vive
// SIEMPRE en la pantalla del traslado, y el push es un extra que se menciona
// como condicional. Cuando la operación logre que la gente instale la PWA, el
// texto sigue siendo cierto — solo que además suena.
//
// LO QUE NO SE COBRA AQUÍ
// No hay checkout, ni medio de pago, ni recibo. El cobro se liquida por fuera:
// Rendio no tiene ninguna tabla de cobros y media pasarela no le sirve a nadie.
// Decisión de la profa, 2026-08-17.
//
// Y DESDE EL 17-sep-2026 LA CIFRA TAMPOCO SE MUESTRA (profa). El número que
// había en Ajustes nunca fue una tarifa acordada —era un valor provisional— y
// una cifra en la pantalla del tripulante se lee como precio pactado. Lo que sí
// se dice, porque callarlo sería peor, es que el privado TIENE COSTO y que la
// tarifa se la confirma coordinación antes de aprobarlo. El número sigue en
// Ajustes y en la cola del jefe: lo que se quitó es la vitrina, no el dato.

(function () {
  'use strict';

  // ── Lo que incluye ────────────────────────────────────────────────────────
  // OJO: esto es una PROMESA a un pasajero. Si la operación no la puede
  // sostener un martes a las 3 a.m., se quita de esta lista — es más barato
  // prometer menos que quedar mal una vez.
  //
  // El kit del diseñador traía además botella de agua, pantuflas desechables y
  // un cojín lumbar masajeador. Los tres se dejaron FUERA: son consumibles que
  // hay que reponer carro por carro y viaje por viaje, y el diseñador mismo
  // marcó el cojín como "pendiente de validación operativa (higiene)". Lo que
  // queda son hechos del vehículo, que no dependen de que alguien recargue nada.
  // Cuando el jefe confirme el kit, se agregan aquí y aparecen solas: en la
  // tarjeta del paso (lista con chulos) y en la portada (pilares numerados).
  const INCLUYE = [
    { ic: 'i-van',   t: 'El carro es solo tuyo',   d: 'No se recoge a nadie más en el camino.' },
    { ic: 'i-route', t: 'Derecho a tu destino',    d: 'Sin desvíos por otros sectores.' },
    // D4 (27-sep-2026): el silencio ya es un DATO del pedido (reservations.quiet_ride,
    // 0086): el interruptor «Prefiero silencio» sale en el paso del nivel cuando se
    // elige el privado, y el conductor lo ve en su ruta. Por eso el texto lo dice así.
    { ic: 'i-zzz',   t: 'En silencio si quieres',  d: 'Lo pides al hacer el pedido y tu conductor lo ve en su ruta.' },
    { ic: 'i-bolt',  t: 'Cargador a bordo',        d: 'USB-C y Lightning.' },
  ];
  // Numerales de la portada. Si INCLUYE crece más allá de esto, el pilar sale
  // con su número arábigo: mejor eso que inventar romanos a mano cada vez.
  const ROMANOS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Pesos colombianos, sin decimales: "$ 150.000".
  function money(v) {
    if (v == null) return null;
    try { return '$ ' + Number(v).toLocaleString('es-CO', { maximumFractionDigits: 0 }); }
    catch (_) { return '$ ' + v; }
  }

  const cfg = () => (typeof state !== 'undefined' && state.settings) ? state.settings : {};
  // El privado se PUEDE PEDIR solo si el jefe lo encendió Y eligió camioneta Y
  // hay tarifa. Las tres, o no se puede prometer un vehículo dedicado.
  function enabled() {
    const s = cfg();
    return !!(s.aux_private_enabled && s.aux_private_vehicle_id && s.aux_private_price_cop > 0);
  }
  // PERO SE VE IGUAL (profa, 17-sep-2026). Antes, faltando una de las tres, el
  // paso entero desaparecía y el tripulante no se enteraba de que el servicio
  // existe. Ahora se muestra como PRIMICIA: la tarjeta está ahí, apagada y sin
  // poder elegirse, y la portada se puede abrir y leer completa. Es la forma
  // honesta de enseñar algo que todavía no se puede dar: se ve, se entiende y
  // no se promete. El día que el jefe complete las tres en Ajustes, la misma
  // tarjeta se enciende y se puede pedir, sin tocar una línea de código.
  const primicia = () => !enabled();
  const price = () => cfg().aux_private_price_cop || null;

  // ── Estado del cupo ───────────────────────────────────────────────────────
  // null = no se ha preguntado · 'libre' · 'ocupada' · 'error'
  const st = { cupo: null, forWhen: null, asking: false };

  function resetCupo() { st.cupo = null; st.forWhen = null; st.asking = false; }

  // Pregunta al servidor si la camioneta está comprometida en esa franja. No se
  // puede resolver en el cliente: el auxiliar no ve las reservas de los demás.
  async function askCupo(whenISO) {
    if (!enabled() || !whenISO) return;
    if (st.asking || st.forWhen === whenISO) return;
    st.asking = true; st.forWhen = whenISO;
    try {
      const busy = await Api.privateBusyAt(whenISO);
      st.cupo = busy ? 'ocupada' : 'libre';
    } catch (_) {
      // Sin respuesta NO se asume que hay cupo: se dice que no se pudo saber y
      // se deja pedir. Prometer una camioneta que no está es peor que dudar.
      st.cupo = 'error';
    } finally {
      st.asking = false;
      if (window.Auxiliar?.rerender) window.Auxiliar.rerender();
    }
  }

  // La píldora del pie de la tarjeta privada. Dice lo que se SABE del cupo y
  // nada más: sin números («2 cupos») porque hay una camioneta y el dato que
  // tenemos es si está comprometida a esa hora o no.
  function availText() {
    if (st.cupo === 'libre') return 'Disponible a esa hora';
    if (st.cupo === 'ocupada') return 'Comprometida a esa hora';
    if (st.cupo === 'error') return 'Sin confirmar la hora';
    return 'Cupo por confirmar';
  }

  // ¿El rediseño está pintando? (AuxShell de P2 + la bandera). Con él apagado
  // todo lo de este archivo devuelve el marcado de siempre (axp-*).
  const shellOn = () => {
    try { return !!(window.AuxShell && typeof AuxShell.on === 'function' && AuxShell.on()); }
    catch (_) { return false; }
  };
  // ¿Tiene cuenta de cobro? (P12, AJUSTES §5). Con ella, lo que el compartido
  // decía «sin costo» pasa a «incluido en tu mensualidad». Sin dato → como hoy.
  function hasBilling() {
    try {
      if (window.ApiCobro && typeof ApiCobro.hasAccount === 'function' && ApiCobro.hasAccount()) return true;
      if (window.AuxPagos && typeof AuxPagos.summary === 'function' && AuxPagos.summary()) return true;
    } catch (_) { /* sin cobro: el texto de siempre */ }
    return false;
  }
  const includedText = () => hasBilling() ? 'Incluido en tu mensualidad' : 'Sin costo para ti';

  // D4 · el interruptor «Prefiero silencio» en el camino heredado (bandera
  // apagada). Mismo contrato que el resto del pedido: data-ax="toggle"
  // data-key="quietRide" (auxiliar.js lo invierte y createReservation lo manda
  // solo con el privado).
  function quietLegacyHTML(f) {
    if (!enabled() || !window.Auxiliar || typeof Auxiliar.toggleHTML !== 'function') return '';
    return Auxiliar.toggleHTML('Prefiero silencio', 'quietRide', !!(f && f.quietRide), 'Tu conductor lo ve en su ruta.');
  }

  const eyebrow = (txt, cls) => `<span class="axp-eyebrow${cls ? ' ' + cls : ''}">${txt}</span>`;
  const chulo = () => '<svg class="icon"><use href="#i-check"/></svg>';

  // ── El paso: Compartido o Privado ─────────────────────────────────────────
  // Las DOS tarjetas siguen a LevelCard del diseñador: tile 40, nombre y precio
  // en la misma línea, tagline, lista con chulos y el check redondo cuando está
  // elegida. La compartida sale de los tokens del rol (se apaga de noche como
  // todo lo demás); la privada lleva la piel Select, fija. Dentro de un
  // <button> todo son <span>: un <div> ahí es HTML inválido y el navegador lo
  // saca del botón por su cuenta.
  function stepHTML(f) {
    // Con el rediseño, el paso lo pinta levelsHTML (RxLevelCard del diseño).
    if (shellOn()) return levelsHTML(f || {}, { mode: 'book' });
    const prev = primicia();
    // En primicia el nivel elegido es SIEMPRE el compartido: la tarjeta de al
    // lado se mira, no se toca.
    const sel = (!prev && f.level === 'private') ? 'private' : 'shared';
    const ocupada = !prev && st.cupo === 'ocupada';
    const dudoso = !prev && st.cupo === 'error';

    const lista = (items) => `<span class="axp-lvl-inc">${
      items.map(x => `<span>${chulo()}${esc(x)}</span>`).join('')}</span>`;

    const compartido = `
      <button class="axp-lvl sh${sel === 'shared' ? ' on' : ''}" data-ax="lvl" data-v="shared"
              aria-pressed="${sel === 'shared' ? 'true' : 'false'}">
        <span class="axp-lvl-main">
          <span class="axp-lvl-ic"><svg class="icon"><use href="#i-users"/></svg></span>
          <span class="axp-lvl-t">
            <span class="axp-lvl-row"><b class="axp-lvl-name">Compartido</b><span class="axp-lvl-price">Incluido</span></span>
            <span class="axp-lvl-tag">Vas con tu tripulación</span>
            ${lista(['Ruta agrupada por sector', 'Paradas en el camino'])}
            <span class="axp-lvl-pnote">${esc(includedText())}</span>
          </span>
          ${sel === 'shared' ? `<span class="axp-lvl-chk">${chulo()}</span>` : ''}
        </span>
      </button>`;

    // El pie de la tarjeta privada lleva la disponibilidad a la izquierda y el
    // enlace a la portada a la derecha. El enlace es un <span data-ax> y no un
    // botón porque ya estamos dentro de uno; el despachador lo encuentra antes
    // que a la tarjeta (closest) y abre la portada sin cambiar el nivel.
    // Comprometida: `.off` + aria-disabled, NUNCA el atributo `disabled` — con
    // él el navegador tampoco despacha el clic de «Ver qué incluye» y la
    // portada queda inalcanzable; el despachador de auxiliar.js ignora el
    // toque sobre una tarjeta `.off`.
    const privado = `
      <button class="axp-lvl vip${sel === 'private' ? ' on' : ''}${ocupada ? ' off' : ''}${prev ? ' primicia' : ''}"
              data-ax="${prev ? 'lvl-info' : 'lvl'}" data-v="private"
              ${prev ? 'aria-disabled="true"' : `aria-pressed="${sel === 'private' ? 'true' : 'false'}"`}${ocupada ? ' aria-disabled="true"' : ''}>
        <span class="axp-lvl-main">
          <span class="axp-lvl-ic"><svg class="icon"><use href="#i-van"/></svg></span>
          <span class="axp-lvl-t">
            ${eyebrow('Rendio Select', 'lt')}
            <span class="axp-lvl-row"><b class="axp-lvl-name">Privado</b><span class="axp-lvl-price">${prev ? 'Pronto' : 'Con costo'}</span></span>
            <span class="axp-lvl-tag">La camioneta es solo tuya</span>
            ${lista(INCLUYE.map(x => x.t))}
            <span class="axp-lvl-pnote">${prev ? 'Te lo mostramos antes de tenerlo listo' : 'Coordinación te confirma la tarifa'}</span>
          </span>
          ${sel === 'private' ? `<span class="axp-lvl-chk">${chulo()}</span>` : ''}
        </span>
        <span class="axp-lvl-foot">
          <span class="axp-lvl-avail">${prev ? 'Todavía no se puede pedir' : availText()}</span>
          <span class="axp-lvl-more" data-ax="lvl-info">Ver qué incluye <svg class="icon"><use href="#i-chev"/></svg></span>
        </span>
      </button>`;

    return `
      <p class="ax-lead">Los dos te llevan. Elige con cuál vas.</p>
      ${compartido}
      ${privado}
      ${dudoso ? `<div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>No pudimos confirmar si la camioneta está libre a esa hora. Puedes pedirla igual: si no alcanza, tu traslado sale en compartido y lo verás aquí.</div>` : ''}
      ${sel === 'private' ? quietLegacyHTML(f) : ''}
      ${sel === 'private' ? `
        <div class="axp-note">
          <svg class="icon"><use href="#i-clock"/></svg>
          <div><b>Lo tiene que aprobar coordinación</b>
          <span>Es un vehículo dedicado, así que un jefe lo confirma antes. <b>La respuesta la vas a ver aquí mismo</b>, en tu traslado; y si tienes las notificaciones activadas, además te llega un aviso. Si no se puede, tu traslado sale en compartido y no se cobra nada.</span></div>
        </div>` : ''}
      <p class="axp-under">${prev
        ? 'El privado todavía no está disponible: te lo mostramos para que sepas de qué se trata. Tu traslado sale en compartido, como siempre.'
        : 'Coordinación confirma cada privado. Si no se puede, sales en compartido y no se cobra nada.'}</p>`;
  }

  // ── La portada: qué es el privado ─────────────────────────────────────────
  // VipIntro del diseñador, con lo que existe: la parte de arriba en espresso
  // (la única pieza aspiracional del rol), el cuerpo en pergamino con los
  // pilares numerados que salen de INCLUYE, la disponibilidad dicha de frente y
  // el pie con la tarifa real. Se pinta directo en la raíz (tres hijos de la
  // columna flex: cabecera fija, cuerpo que desplaza, pie fijo).
  // `f` es el formulario del pedido: el párrafo dice a dónde va ESTE viaje
  // (la portada se abre igual desde una salida que desde una llegada).
  function introHTML(f) {
    // Con el rediseño, la portada es la pantalla Select (el shell la registra).
    if (shellOn()) return selectHTML({ from: 'form', form: f });
    const prev = primicia();
    const ocupada = !prev && st.cupo === 'ocupada';
    const salida = !!(f && f.type === 'sal');
    const pilares = INCLUYE.map((x, i) => `
      <div class="axp-pillar">
        <span class="axp-pillar-n">${ROMANOS[i] || (i + 1)}</span>
        <div><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>
      </div>`).join('<div class="axp-rule-ln"></div>');
    return `
      <div class="axp-ink">
        <div class="axp-bar">
          <button class="axp-back" data-ax="lvl-close" aria-label="Volver"><svg class="icon"><use href="#i-back"/></svg></button>
          ${eyebrow('Traslado privado', 't2')}
          <span class="axp-bar-gap"></span>
        </div>
        <div class="axp-hero">
          ${eyebrow('Rendio', 'lt')}
          <div class="axp-wordmark">Select</div>
          <div class="axp-rule"></div>
          <h1>Llega antes.<br>Llega descansado.</h1>
          <p>${salida
            ? 'Para los turnos que empiezan de madrugada: la camioneta reservada a tu nombre, directo al aeropuerto, sin paradas en el camino.'
            : 'Para los turnos que terminan tarde: la camioneta reservada a tu nombre, directo a tu casa, sin paradas en el camino.'}</p>
        </div>
      </div>
      <div class="ax-body axp-intro">
        <div class="axp-pillars">${pilares}</div>
        <div class="axp-avail">
          <svg class="icon"><use href="#i-clock"/></svg>
          <div><b>Una sola camioneta</b>
          <span>${prev
            ? 'Por eso no va a estar siempre: cuando abra, un jefe confirma cada solicitud y, si no se puede, tu traslado sale en compartido.'
            : 'No siempre está disponible: depende de la hora que necesites. Un jefe confirma cada solicitud; si no se puede, tu traslado sale en compartido y no se cobra nada.'}</span></div>
        </div>
        <div class="axp-shared">Tu viaje compartido sigue igual: mismo servicio, mismos conductores, sin costo. Select es una opción para las noches en que quieres llegar directo.</div>
        <div class="ax-spacer"></div>
      </div>
      <div class="axp-foot">
        <div class="axp-fare-note">${prev
          ? 'Todavía no se puede pedir: estamos terminando de montarlo. Cuando esté, aparece aquí mismo.'
          : 'Tiene costo. Coordinación te confirma la tarifa antes de aprobarlo, y no se cobra en la app.'}</div>
        <button class="axp-btn" data-ax="lvl-choose"${(ocupada || prev) ? ' disabled' : ''}>${
          prev ? 'Muy pronto' : ocupada ? 'Comprometida a esa hora' : 'Pedir en privado'}</button>
        <button class="axp-btn ghost" data-ax="lvl-close">Volver</button>
      </div>`;
  }

  // ── La franja del resumen ─────────────────────────────────────────────────
  // Debajo de la tarjeta «Revisa y confirma» cuando se eligió el privado. Dice
  // las tres cosas que el tripulante tiene que saber antes de tocar el botón:
  // cuánto, quién lo confirma y que aquí no se cobra. Vacío en compartido.
  function sumHTML(f) {
    if (!f || f.level !== 'private' || !enabled()) return '';
    if (shellOn()) return rxSumHTML(f);
    return `
      <div class="axp-sum-vip">
        ${eyebrow('Rendio Select', 'lt')}
        <b>La camioneta, solo para ti</b>
        <span>Coordinación confirma la camioneta y la tarifa · no se cobra en la app</span>
      </div>`;
  }

  // ── El estado de la solicitud, dentro del viaje ───────────────────────────
  // Se pinta en el detalle del traslado. Es lo que responde "¿me lo aprobaron?"
  // sin que el auxiliar tenga que preguntarle a nadie.
  function statusHTML(t) {
    if (!t || t.level !== 'private' || !t.privateStatus) return '';
    if (shellOn()) return rxStatusHTML(t);
    if (t.privateStatus === 'requested') {
      return `<div class="axp-st wait">
        <span class="axp-st-ic"><svg class="icon"><use href="#i-clock"/></svg></span>
        <div><b>Privado · esperando confirmación</b>
        <span>Coordinación está revisando si la camioneta está libre a esa hora. Vuelve a esta pantalla para ver la respuesta.</span></div>
      </div>`;
    }
    if (t.privateStatus === 'approved') {
      return `<div class="axp-st ok">
        <span class="axp-st-ic"><svg class="icon"><use href="#i-check"/></svg></span>
        <div><b>Privado confirmado</b>
        <span>La camioneta es tuya para este trayecto.</span></div>
      </div>`;
    }
    return `<div class="axp-st no">
      <span class="axp-st-ic"><svg class="icon"><use href="#i-info"/></svg></span>
      <div><b>No alcanzó la camioneta</b>
      <span>${t.privateReason ? esc(t.privateReason) + ' ' : ''}Tu traslado sigue en pie en compartido, y no se te cobra nada.</span></div>
    </div>`;
  }

  // Etiqueta para la tarjeta del viaje en la lista.
  function chipHTML(t) {
    if (!t || t.level !== 'private') return '';
    if (shellOn()) return rxChipHTML(t);
    const cls = t.privateStatus === 'approved' ? 'ok' : t.privateStatus === 'rejected' ? 'no' : 'wait';
    const txt = t.privateStatus === 'approved' ? 'Privado' : t.privateStatus === 'rejected' ? 'Privado no' : 'Privado ·';
    return `<span class="axp-chip ${cls}"><svg class="icon"><use href="#i-van"/></svg>${txt}</span>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REDISEÑO (27-sep-2026) · P6 · Niveles y Select
  // ══════════════════════════════════════════════════════════════════════════
  // Con la bandera del rediseño encendida (AuxShell.on()), el nivel y la portada
  // se pintan con el marcado del diseñador: RxLevelCard (rx-onboard.jsx) y
  // RxSelect (rx-me.jsx), clases rx-lv / rx-sel / rx-cupo tal cual, el mismo
  // `--d` de la entrada escalonada (.rx-in) y los mismos nodos que React
  // mantiene (el radio <i> transiciona al elegir; syncLevels lo respeta).
  // Lo que el diseño inventaba y aquí NO sale (plan §1.6):
  //   · «$ XX.XXX» → Privado «Con costo» + «Coordinación te confirma la tarifa»;
  //     Directo «Pronto», apagado (D1, D2). Ninguna cifra en pantalla.
  //   · el kit de confort y el pilar de la temperatura → fuera; los pilares
  //     salen de INCLUYE (D3).
  //   · «En silencio» → interruptor «Prefiero silencio» (quietRide) (D4).
  //   · los cupos inventados → nada en Compartido; en Privado, availText() (D5).
  const rxUI = () => (window.AuxRxUI && typeof AuxRxUI.ic === 'function') ? AuxRxUI : null;
  function rxIc(n, s) {
    const U = rxUI();
    if (U) { try { const h = U.ic(n, s); if (h) return h; } catch (_) { /* respaldo */ } }
    if (window.AuxShell && typeof AuxShell.ic === 'function') {
      try { return AuxShell.ic(n, s) || ''; } catch (_) { /* sin ícono */ }
    }
    return '';
  }
  function rxToast(msg, icon) {
    if (window.AuxShell && typeof AuxShell.toast === 'function') { AuxShell.toast(msg, icon); return; }
    if (typeof window.toast === 'function') window.toast(msg);
  }
  const auxHeader = () => (window.Auxiliar && window.Auxiliar.header) || null;
  const lvlName = (v) => v === 'private' ? 'Privado' : 'Compartido';

  // La píldora del cupo del privado: verde solo cuando se SABE que está libre;
  // en ámbar lo que no está confirmado (el mismo `low` del diseño); gris cuando
  // todavía no se puede pedir.
  function cupoCls() {
    if (primicia()) return 'off';
    return st.cupo === 'libre' ? '' : 'low';
  }
  const cupoPill = (txt, cls) => `<span class="rx-cupo${cls ? ' ' + cls : ''}">${esc(txt)}</span>`;

  // RxLevelCard, marcado del diseño. `attrs` va tal cual (lo arma levelsHTML).
  // Dentro de un <button> todo son <span> (HTML válido; el navegador saca los
  // <div> del botón por su cuenta).
  function lvCard(c) {
    const cls = ['rx-lv', 'rx-in', c.vip && 'vip', c.on && 'on', c.off && 'off', c.prim && 'primicia']
      .filter(Boolean).join(' ');
    const foot = (c.cupo || c.more)
      ? `<span class="rx-lv-f">${c.cupo ? cupoPill(c.cupo, c.cupoCls) : ''}${c.more || ''}</span>` : '';
    return `<button type="button" class="${cls}" style="--d:${c.d}" data-lv="${c.id}" data-rx-key="lv:${c.id}" ${c.attrs}>`
      + `<span class="rx-lv-ic t-${c.tone}">${rxIc(c.ic, 20)}</span>`
      + `<span class="rx-lv-tx">`
      + `<span class="rx-lv-h"><b>${esc(c.name)}</b><em>${esc(c.price)}</em></span>`
      + `<span class="rx-lv-t">${esc(c.tag)}</span>`
      + `<span class="rx-lv-inc">${c.inc.map(x => `<span>${rxIc('Check', 13)}${esc(x)}</span>`).join('')}</span>`
      + (c.pn ? `<span class="rx-lv-pn">${esc(c.pn)}</span>` : '')
      + foot
      + `</span>`
      + `<span class="rx-radio"><i></i></span>`
      + `</button>`;
  }

  // Las tres tarjetas del nivel (RX_LEVELS del diseño, con los datos reales).
  //   mode 'book'  → el paso «nivel» del pedido: data-ax="lvl" (auxiliar.js),
  //                  «Ver qué incluye» (lvl-info), el interruptor «Prefiero
  //                  silencio» y las notas. `f` = auxState.form.
  //   mode 'pref'  → la hoja «Nivel preferido» del Perfil (P7):
  //                  data-rx="pref-level" data-v. `f` = null; manda
  //                  Auxiliar.header.preferredLevel.
  //   mode otro    → solo las tarjetas, con `o.pickAttrs(v)` (p. ej. el
  //                  registro de P11).
  // o.selected ('shared'|'private') fuerza la elegida. En primicia la elegida
  // es SIEMPRE la compartida: la privada se mira, no se toca.
  function levelsHTML(f, o) {
    o = o || {};
    const mode = o.mode || 'book';
    const book = mode === 'book';
    const prev = primicia();
    const H = auxHeader();
    const want = o.selected || (f ? f.level : (H && H.preferredLevel)) || 'shared';
    const sel = (!prev && want === 'private') ? 'private' : 'shared';
    const ocupada = book && !prev && st.cupo === 'ocupada';
    const dudoso = book && !prev && st.cupo === 'error';
    const pick = (v) => {
      if (typeof o.pickAttrs === 'function') return String(o.pickAttrs(v) || '');
      return book ? `data-ax="lvl" data-v="${v}"` : `data-rx="pref-level" data-v="${v}"`;
    };
    const pressed = (v) => `aria-pressed="${sel === v ? 'true' : 'false'}"`;

    const compartido = lvCard({
      id: 'shared', d: 0, tone: 'a2h', ic: 'Users', on: sel === 'shared',
      name: 'Compartido', price: 'Incluido', tag: 'Vas con tu tripulación',
      inc: ['Ruta agrupada por sector', 'Paradas en el camino'],
      attrs: `${pick('shared')} ${pressed('shared')}`,
    });
    // Directo: la operación no lo ha definido (D2). Se ve, apagado, «Pronto»,
    // sin acción: tocarlo no hace nada. Sin reglas inventadas (el «máximo 1
    // acompañante» del diseño no está decidido) ni cupos.
    const directo = lvCard({
      id: 'direct', d: 1, tone: 'h2a', ic: 'ArrowRight', off: true,
      name: 'Directo', price: 'Pronto', tag: 'Sin desvíos: llegas antes',
      inc: ['Va derecho a tu destino'],
      cupo: 'Todavía no se puede pedir', cupoCls: 'off',
      attrs: 'aria-disabled="true"',
    });
    // Privado · Select. Comprometida: `.off` + aria-disabled, NUNCA el atributo
    // `disabled` (el navegador tampoco despacharía el clic de «Ver qué
    // incluye»); auxiliar.js ignora el toque sobre una tarjeta `.off`.
    // En primicia, en el pedido, tocarla abre la portada (lvl-info) y nada más.
    let privAttrs;
    if (prev) privAttrs = book ? 'data-ax="lvl-info" data-v="private" aria-disabled="true"' : 'aria-disabled="true"';
    else privAttrs = `${pick('private')} ${pressed('private')}${ocupada ? ' aria-disabled="true"' : ''}`;
    const privado = lvCard({
      id: 'private', d: 2, tone: 'plus', ic: 'Sparkle', vip: true, on: sel === 'private',
      off: ocupada, prim: prev,
      name: 'Privado · Select', price: prev ? 'Pronto' : 'Con costo',
      tag: 'La camioneta es solo tuya',
      inc: INCLUYE.map(x => x.t),
      pn: prev ? 'Te lo mostramos antes de tenerlo listo' : 'Coordinación te confirma la tarifa',
      cupo: prev ? 'Todavía no se puede pedir' : (book ? availText() : ''),
      cupoCls: cupoCls(),
      // En el pedido abre la portada SOBRE el pedido (lvl-info → vista
      // 'privado'); fuera de él (o.more), la pila del shell (open-select).
      more: book ? '<span class="rx-lv-more" data-ax="lvl-info">Ver qué incluye</span>'
        : o.more ? `<span class="rx-lv-more" data-rx="open-select" data-from="${esc(o.from || 'me')}">Ver qué incluye</span>` : '',
      attrs: privAttrs,
    });

    const cards = compartido + directo + privado;
    if (!book) return `<div class="rx-lvls" data-mode="${esc(mode)}">${cards}</div>`;
    return `<div class="rx-lvls" data-mode="book">${cards}</div>`
      + `<div class="rx-lvls-x">${levelsExtraHTML(f || {}, { sel, prev, dudoso })}</div>`;
  }

  // Lo que va debajo de las tarjetas en el pedido. Aparte para que syncLevels
  // lo pueda reponer sin recrear las tarjetas. Cada bloque lleva data-rx-key:
  // el parche de P5 (morph por key) y syncLevels lo tratan como la key de React
  // (lo que aparece nuevo se monta y su .rx-in corre; lo demás se queda).
  // La nota «Compartido va con tu tripulación…» del diseño la pone P5 debajo
  // (es de RxBook); su texto con el cobro está en AuxPrivado.sharedNoteText().
  function levelsExtraHTML(f, k) {
    const out = [];
    if (k.dudoso) {
      out.push(`<div class="rx-note" data-rx-key="lv-dudoso">${rxIc('Info', 15)}<span>No pudimos confirmar si la camioneta está libre a esa hora. Puedes pedirla igual: si no alcanza, tu traslado sale en compartido y lo verás aquí.</span></div>`);
    }
    if (k.sel === 'private' && enabled()) {
      // D4: el silencio es un dato del pedido (reservations.quiet_ride) y el
      // conductor lo ve en su ruta. Mismo contrato y mismo marcado que los
      // demás interruptores del pedido (AuxRxPedir.toggleHTML de P5):
      // data-ax="toggle" data-key="quietRide".
      out.push(`<div class="rx-card rx-in rx-lv-quiet" style="--d:3" data-rx-key="quiet">${quietToggleHTML(!!f.quietRide)}</div>`);
      out.push(`<div class="rx-note" data-rx-key="lv-aprob">${rxIc('Clock', 15)}<span><b>Lo tiene que aprobar coordinación.</b> Es un vehículo dedicado, así que un jefe lo confirma antes. La respuesta la ves aquí mismo, en tu traslado. Si no se puede, sales en compartido y no se cobra nada.</span></div>`);
    }
    if (k.prev) {
      out.push(`<div class="rx-note" data-rx-key="lv-prim">${rxIc('Sparkle', 15)}<span>El privado todavía no está disponible: te lo mostramos para que sepas de qué se trata. Tu traslado sale en compartido, como siempre.</span></div>`);
    }
    return out.join('');
  }
  function quietToggleHTML(on) {
    const label = 'Prefiero silencio', hint = 'Tu conductor lo ve en su ruta.';
    if (window.AuxRxPedir && typeof AuxRxPedir.toggleHTML === 'function') {
      try { const h = AuxRxPedir.toggleHTML(label, 'quietRide', on, hint); if (h) return h; } catch (_) { /* el nuestro */ }
    }
    const U = rxUI();
    const tg = (U && typeof U.toggle === 'function')
      ? U.toggle(on, { 'data-ax': 'toggle', 'data-key': 'quietRide', 'aria-label': label })
      : `<button type="button" class="rx-tg${on ? ' on' : ''}" data-ax="toggle" data-key="quietRide" aria-pressed="${on ? 'true' : 'false'}" aria-label="${label}"><i></i></button>`;
    return `<div class="rx-set" data-rx-key="tg:quietRide"><span><b>${label}</b><span>${hint}</span></span>${tg}</div>`;
  }
  // El texto de la nota del compartido, con la cuenta de cobro (AJUSTES §5).
  const sharedNoteText = () => hasBilling()
    ? 'Compartido va con tu tripulación y está incluido en tu mensualidad.'
    : 'Compartido va con tu tripulación y no tiene costo.';

  // Actualiza EN SU LUGAR el paso del nivel ya pintado (sin recrear las
  // tarjetas): en React elegir otra tarjeta cambia la clase del MISMO nodo, así
  // que el borde, el fondo y el punto del radio transicionan (.2s / .3s). P5
  // puede llamarlo desde su patch() del pedido: devuelve true si lo resolvió,
  // false si no encontró el paso (y entonces se repinta como siempre).
  function syncLevels(scope, f) {
    const root = scope && scope.querySelector ? scope : null;
    const box = root && root.querySelector('.rx-lvls[data-mode="book"]');
    if (!box) return false;
    const tpl = document.createElement('template');
    tpl.innerHTML = levelsHTML(f || {}, { mode: 'book' });
    const nb = tpl.content.querySelector('.rx-lvls');
    const nx = tpl.content.querySelector('.rx-lvls-x');
    const olds = [...box.querySelectorAll(':scope > .rx-lv')];
    const news = nb ? [...nb.querySelectorAll(':scope > .rx-lv')] : [];
    if (!news.length || olds.length !== news.length
      || olds.some((c, i) => c.getAttribute('data-lv') !== news[i].getAttribute('data-lv'))) return false;
    olds.forEach((c, i) => {
      const n = news[i];
      if (c.className !== n.className) c.className = n.className;
      // Atributos (data-ax, aria-*): los que sobran se quitan, los nuevos se ponen.
      for (const a of [...c.attributes]) if (a.name !== 'class' && !n.hasAttribute(a.name)) c.removeAttribute(a.name);
      for (const a of [...n.attributes]) if (a.name !== 'class' && c.getAttribute(a.name) !== a.value) c.setAttribute(a.name, a.value);
      const ct = c.querySelector(':scope > .rx-lv-tx'), nt = n.querySelector(':scope > .rx-lv-tx');
      if (ct && nt && ct.innerHTML !== nt.innerHTML) ct.innerHTML = nt.innerHTML;
    });
    const ox = root.querySelector('.rx-lvls-x');
    if (ox && nx && ox.innerHTML !== nx.innerHTML) {
      // Por key, como React: lo que sigue se queda (el interruptor se mueve en
      // su lugar y su transición corre), lo nuevo se monta y ANIMA (.rx-anim,
      // aunque la capa esté en .rx-noanim), lo que ya no va se quita.
      const viejos = new Map([...ox.children].map(n => [n.getAttribute('data-rx-key'), n]));
      const nuevos = [...nx.children];
      const U = rxUI();
      const lista = nuevos.map(n => {
        const k = n.getAttribute('data-rx-key');
        const o = k ? viejos.get(k) : null;
        if (!o) { if (n.classList.contains('rx-in')) n.classList.add('rx-anim'); return n; }
        viejos.delete(k);
        const otg = o.querySelector('[data-key="quietRide"]'), ntg = n.querySelector('[data-key="quietRide"]');
        if (otg && ntg) {
          const on = ntg.classList.contains('on');
          if (U && typeof U.toggleSet === 'function') U.toggleSet(otg, on);
          else { otg.classList.toggle('on', on); otg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        } else if (o.innerHTML !== n.innerHTML) o.innerHTML = n.innerHTML;
        return o;
      });
      viejos.forEach(n => n.remove());
      // Solo se mueve lo que no está ya en su sitio: mover un nodo lo saca del
      // documento y cortaría la transición del interruptor.
      lista.forEach((n, i) => { const aqui = ox.children[i] || null; if (aqui !== n) ox.insertBefore(n, aqui); });
    }
    return true;
  }

  // ── Select (RxSelect de rx-me.jsx) ────────────────────────────────────────
  // from: 'form' (se abrió desde el pedido: la vista 'privado' de auxiliar.js,
  // que el shell apila SOBRE el pedido), 'home' o 'me'.
  //   · Cerrar: desde el pedido `lvl-close` (auxiliar.js vuelve al paso); si no,
  //     `rx-pop` (la pila del shell).
  //   · Pie: desde el pedido, la disponibilidad + «Pedir en privado»
  //     (lvl-choose); desde Inicio o Perfil, «Quiero mi próximo traslado en
  //     Select» (select-pref → ApiAux.saveMyPrefs), apagado en primicia.
  function selectHTML(o) {
    o = o || {};
    const from = o.from || 'home';
    const enPedido = from === 'form';
    const A = window.Auxiliar;
    const f = enPedido ? (o.form || (A && A.state && A.state.form) || {}) : null;
    const prev = primicia();
    const ocupada = enPedido && !prev && st.cupo === 'ocupada';
    const parrafo = f && f.type === 'sal'
      ? 'Para los turnos que empiezan de madrugada: la camioneta reservada a tu nombre, directo al aeropuerto, sin paradas en el camino.'
      : f && f.type === 'lle'
        ? 'Para los turnos que terminan tarde: la camioneta reservada a tu nombre, directo a tu casa, sin paradas en el camino.'
        : 'Para las noches de vuelo largo: la camioneta reservada a tu nombre, directo a tu destino, sin paradas en el camino.';
    const cerrar = enPedido ? 'data-ax="lvl-close"' : 'data-rx="rx-pop"';
    const pilares = INCLUYE.map((x, i) =>
      `<div class="rx-in" style="--d:${i}"><em>${ROMANOS[i] || (i + 1)}</em><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>`).join('');
    // Donde el diseño tenía el kit a bordo (D3: fuera) va lo que el tripulante
    // tiene que saber antes de pedirlo, con la misma entrada escalonada.
    const como = prev
      ? ['Todavía no se puede pedir: estamos terminando de montarlo. Cuando esté, aparece aquí mismo.',
        'Hay una sola camioneta: cuando abra, un jefe confirma cada solicitud y, si no se puede, tu traslado sale en compartido.']
      : ['Hay una sola camioneta: no siempre está disponible, depende de la hora que necesites.',
        'Tiene costo. Coordinación te confirma la tarifa antes de aprobarlo, y no se cobra en la app.',
        'Si no se puede, tu traslado sale en compartido y no se cobra nada.'];
    const n = INCLUYE.length;
    const comoHTML = `<div class="rx-sel-how rx-in" style="--d:${n}"><span class="rx-sel-l">${prev ? 'Muy pronto' : 'Cómo funciona'}</span>`
      + como.map(p => `<p>${esc(p)}</p>`).join('') + `</div>`;

    let pill, boton;
    const U = rxUI();
    const btn = (label, attrs, dis) => (U && typeof U.btn === 'function')
      ? U.btn(label, { kind: 'brass', attrs, disabled: dis })
      : `<button type="button" class="rx-btn brass"${dis ? ' disabled' : ''} ${Object.keys(attrs).map(k => `${k}="${esc(attrs[k])}"`).join(' ')}>${esc(label)}</button>`;
    if (enPedido) {
      pill = prev ? cupoPill('Todavía no se puede pedir', 'off') : cupoPill(availText(), cupoCls());
      boton = btn(prev ? 'Muy pronto' : ocupada ? 'Comprometida a esa hora' : 'Pedir en privado',
        { 'data-ax': 'lvl-choose' }, prev || ocupada);
    } else {
      const H = auxHeader();
      const ya = !prev && !!(H && H.preferredLevel === 'private');
      pill = prev ? cupoPill('Todavía no se puede pedir', 'off')
        : ya ? cupoPill('Select ya es tu nivel preferido', '')
          : cupoPill('Sujeto a disponibilidad', 'low');
      boton = btn('Quiero mi próximo traslado en Select', { 'data-rx': 'select-pref' }, prev || ya);
    }

    return `<div class="rx-scr rx-sel" data-from="${esc(from)}">`
      + `<div class="rx-sel-top"><button type="button" class="rx-ib glass dk" ${cerrar} aria-label="Volver">${rxIc('ChevronLeft', 22)}</button></div>`
      + `<div class="rx-body sel">`
      + `<div class="rx-sel-hero"><span class="rx-sel-e">Rendio</span><h1>Select</h1><p>${esc(parrafo)}</p></div>`
      + `<div class="rx-sel-pil">${pilares}</div>`
      + comoHTML
      + `<div class="rx-sel-note">Tu viaje compartido sigue igual. Select es una opción, no un reemplazo.</div>`
      + `</div>`
      + `<div class="rx-foot sel">${pill}${boton}</div>`
      + `</div>`;
  }

  // La tarjeta de Select en Inicio (rx-select-teaser de rx-home.jsx), por si P3
  // la quiere tal cual: abre la portada con open-select. Sin kit (D3).
  function teaserHTML(o) {
    o = o || {};
    const d = o.d == null ? 4 : o.d;
    const sub = primicia()
      ? 'Muy pronto: la camioneta solo para ti, directo y sin paradas.'
      : 'La camioneta solo para ti, directo y en silencio si quieres.';
    return `<button type="button" class="rx-select-teaser rx-in" style="--d:${d}" data-rx="open-select" data-from="${esc(o.from || 'home')}">`
      + `<span class="rx-st-e">Rendio</span><span class="rx-st-t">Select</span>`
      + `<span class="rx-st-s">${esc(sub)}</span>`
      + `<span class="rx-st-c">Conocer ${rxIc('ArrowRight', 15)}</span>`
      + `</button>`;
  }

  // ── Franja del resumen, estado y etiqueta con el rediseño ─────────────────
  function rxSumHTML(f) {
    return `<div class="rx-sel-sum">`
      + `<span class="rx-sel-e">Rendio Select</span>`
      + `<b>La camioneta, solo para ti</b>`
      + `<span>Coordinación confirma la camioneta y la tarifa · no se cobra en la app</span>`
      + (f && f.quietRide ? `<span>Pediste silencio: tu conductor lo ve en su ruta.</span>` : '')
      + `</div>`;
  }
  function rxStatusHTML(t) {
    const quiet = t.quiet ? ' Pediste silencio: tu conductor lo ve en su ruta.' : '';
    const box = (cls, icon, title, body) => `<div class="rx-sel-st ${cls}">`
      + `<span class="rx-sel-st-ic">${rxIc(icon, 19)}</span>`
      + `<span class="rx-sel-st-tx"><b>${esc(title)}</b><span>${esc(body)}</span></span></div>`;
    if (t.privateStatus === 'requested') {
      return box('wait', 'Clock', 'Privado · esperando confirmación',
        'Coordinación está revisando si la camioneta está libre a esa hora. Vuelve a esta pantalla para ver la respuesta.' + quiet);
    }
    if (t.privateStatus === 'approved') {
      return box('ok', 'Check', 'Privado confirmado', 'La camioneta es tuya para este trayecto.' + quiet);
    }
    return box('no', 'Info', 'No alcanzó la camioneta',
      (t.privateReason ? String(t.privateReason) + ' ' : '') + 'Tu traslado sigue en pie en compartido, y no se te cobra nada.');
  }
  function rxChipHTML(t) {
    const cls = t.privateStatus === 'approved' ? 'ok' : t.privateStatus === 'rejected' ? 'no' : 'wait';
    const txt = t.privateStatus === 'approved' ? 'Privado' : t.privateStatus === 'rejected' ? 'Privado no' : 'Privado · por confirmar';
    return `<span class="rx-sel-chip ${cls}">${rxIc('Sparkle', 12)}${txt}</span>`;
  }

  // ── Acciones del shell (data-rx) ──────────────────────────────────────────
  // «Quiero mi próximo traslado en Select» (desde Inicio o Perfil). Solo con el
  // privado encendido; guarda la preferencia (D19: el próximo pedido entra con
  // el privado marcado) y vuelve, como el diseño.
  let savingPref = false;
  async function savePref(el) {
    if (savingPref || !enabled() || (el && el.disabled)) return;
    if (!window.ApiAux || typeof ApiAux.saveMyPrefs !== 'function') {
      rxToast('No pudimos guardar tu preferencia. Inténtalo más tarde.', 'Info');
      return;
    }
    savingPref = true;
    if (el) el.disabled = true;
    let r = null, err = null;
    try { r = await ApiAux.saveMyPrefs({ preferredLevel: 'private' }); } catch (e) { err = e; }
    savingPref = false;
    if (r === true) {
      const H = auxHeader(); if (H) H.preferredLevel = 'private';
      if (window.AuxShell && typeof AuxShell.pop === 'function') AuxShell.pop();
      rxToast('Tu próximo pedido arranca en Privado', 'Sparkle');
      return;
    }
    if (el && el.isConnected) el.disabled = false;
    rxToast(err && err.message ? err.message : 'No pudimos guardar tu preferencia. Inténtalo de nuevo.', 'Info');
  }

  // Tocar una tarjeta en la hoja «Nivel preferido» (P7 puede reemplazar esta
  // acción con la suya: AuxShell.action('pref-level', …) registrada después).
  // La tarjeta se marca EN SU LUGAR (la transición del radio corre), se guarda
  // y la hoja se cierra con el toast del diseño.
  let savingLvl = false;
  async function prefLevel(el) {
    const v = el && el.getAttribute('data-v');
    if (savingLvl || (v !== 'shared' && v !== 'private')) return;
    if (el.getAttribute('aria-disabled') === 'true' || el.classList.contains('off')) return;
    if (v === 'private' && !enabled()) return;
    const box = el.closest('.rx-lvls');
    const marcar = (cual) => {
      if (!box) return;
      box.querySelectorAll(':scope > .rx-lv[data-rx="pref-level"]').forEach(c => {
        const on = c.getAttribute('data-v') === cual;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    const H = auxHeader();
    const antes = (H && H.preferredLevel) || 'shared';
    marcar(v);
    if (!window.ApiAux || typeof ApiAux.saveMyPrefs !== 'function') {
      marcar(antes);
      rxToast('No pudimos guardar tu preferencia. Inténtalo más tarde.', 'Info');
      return;
    }
    savingLvl = true;
    let r = null, err = null;
    try { r = await ApiAux.saveMyPrefs({ preferredLevel: v }); } catch (e) { err = e; }
    savingLvl = false;
    if (r === true) {
      if (H) H.preferredLevel = v;
      if (window.AuxShell && typeof AuxShell.closeSheet === 'function') AuxShell.closeSheet();
      rxToast(`Ahora pides en ${lvlName(v)}`);
      if (window.Auxiliar && typeof Auxiliar.rerender === 'function') Auxiliar.rerender();
      return;
    }
    marcar(antes);
    rxToast(err && err.message ? err.message : 'No pudimos guardar tu preferencia. Inténtalo de nuevo.', 'Info');
  }

  // Registro en el shell al evaluarse (index.html carga aux-shell.js antes;
  // register() acepta registros tardíos). dark: la cabecera va sobre tinta.
  function rxRegister() {
    const S = window.AuxShell;
    if (!S || typeof S.register !== 'function') return;
    S.register('select', {
      dark: true,
      render: (ctx) => selectHTML({
        from: (ctx && ctx.props && ctx.props.from) || 'home',
        form: ctx && ctx.state ? ctx.state.form : null,
      }),
    });
    if (typeof S.action === 'function') {
      S.action('select-pref', (el) => { savePref(el); });
      S.action('pref-level', (el) => { prefLevel(el); });
    }
  }
  rxRegister();

  window.AuxPrivado = {
    enabled, primicia, price, money, stepHTML, introHTML, sumHTML, statusHTML, chipHTML,
    askCupo, resetCupo, cupo: () => st.cupo, INCLUYE,
    // rediseño (P6)
    levelsHTML, syncLevels, selectHTML, teaserHTML, availText, sharedNoteText,
  };
})();
