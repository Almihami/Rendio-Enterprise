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
// No hay checkout, ni medio de pago, ni recibo. Se MUESTRA la tarifa y el cobro
// se liquida por fuera. Rendio no tiene ninguna tabla de cobros y media pasarela
// no le sirve a nadie. Decisión de la profa, 2026-08-17.

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
    { ic: 'i-zzz',   t: 'Silencio si quieres',     d: 'Puedes pedir que no te hablen y dormir el trayecto.' },
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
  // El privado se ofrece solo si el jefe lo encendió Y eligió camioneta Y hay
  // tarifa. Si falta cualquiera de las tres, el auxiliar sencillamente no ve el
  // paso: es mejor no existir que existir roto.
  function enabled() {
    const s = cfg();
    return !!(s.aux_private_enabled && s.aux_private_vehicle_id && s.aux_private_price_cop > 0);
  }
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
    if (!enabled()) return null;   // el paso no existe si no hay privado que dar
    const sel = f.level === 'private' ? 'private' : 'shared';
    const p = money(price());
    const ocupada = st.cupo === 'ocupada';
    const dudoso = st.cupo === 'error';

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
            <span class="axp-lvl-pnote">Sin costo para ti</span>
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
      <button class="axp-lvl vip${sel === 'private' ? ' on' : ''}${ocupada ? ' off' : ''}"
              data-ax="lvl" data-v="private" aria-pressed="${sel === 'private' ? 'true' : 'false'}"${ocupada ? ' aria-disabled="true"' : ''}>
        <span class="axp-lvl-main">
          <span class="axp-lvl-ic"><svg class="icon"><use href="#i-van"/></svg></span>
          <span class="axp-lvl-t">
            ${eyebrow('Rendio Select', 'lt')}
            <span class="axp-lvl-row"><b class="axp-lvl-name">Privado</b><span class="axp-lvl-price">${p || '—'}</span></span>
            <span class="axp-lvl-tag">La camioneta es solo tuya</span>
            ${lista(INCLUYE.map(x => x.t))}
            <span class="axp-lvl-pnote">por trayecto</span>
          </span>
          ${sel === 'private' ? `<span class="axp-lvl-chk">${chulo()}</span>` : ''}
        </span>
        <span class="axp-lvl-foot">
          <span class="axp-lvl-avail">${availText()}</span>
          <span class="axp-lvl-more" data-ax="lvl-info">Ver qué incluye <svg class="icon"><use href="#i-chev"/></svg></span>
        </span>
      </button>`;

    return `
      <p class="ax-lead">Los dos te llevan. Elige con cuál vas.</p>
      ${compartido}
      ${privado}
      ${dudoso ? `<div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>No pudimos confirmar si la camioneta está libre a esa hora. Puedes pedirla igual: si no alcanza, tu traslado sale en compartido y lo verás aquí.</div>` : ''}
      ${sel === 'private' ? `
        <div class="axp-note">
          <svg class="icon"><use href="#i-clock"/></svg>
          <div><b>Lo tiene que aprobar coordinación</b>
          <span>Es un vehículo dedicado, así que un jefe lo confirma antes. <b>La respuesta la vas a ver aquí mismo</b>, en tu traslado; y si tienes las notificaciones activadas, además te llega un aviso. Si no se puede, tu traslado sale en compartido y no se cobra nada.</span></div>
        </div>` : ''}
      <p class="axp-under">Coordinación confirma cada privado. Si no se puede, sales en compartido y no se cobra nada.</p>`;
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
    const p = money(price());
    const ocupada = st.cupo === 'ocupada';
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
          <span>No siempre está disponible: depende de la hora que necesites. Un jefe confirma cada solicitud; si no se puede, tu traslado sale en compartido y no se cobra nada.</span></div>
        </div>
        <div class="axp-shared">Tu viaje compartido sigue igual: mismo servicio, mismos conductores, sin costo. Select es una opción para las noches en que quieres llegar directo.</div>
        <div class="ax-spacer"></div>
      </div>
      <div class="axp-foot">
        <div class="axp-fare"><span>Tarifa</span><b>${p || '—'}</b></div>
        <div class="axp-fare-note">por trayecto · no se cobra en la app</div>
        <button class="axp-btn" data-ax="lvl-choose"${ocupada ? ' disabled' : ''}>${ocupada ? 'Comprometida a esa hora' : 'Pedir en privado'}</button>
        <button class="axp-btn ghost" data-ax="lvl-close">Volver</button>
      </div>`;
  }

  // ── La franja del resumen ─────────────────────────────────────────────────
  // Debajo de la tarjeta «Revisa y confirma» cuando se eligió el privado. Dice
  // las tres cosas que el tripulante tiene que saber antes de tocar el botón:
  // cuánto, quién lo confirma y que aquí no se cobra. Vacío en compartido.
  function sumHTML(f) {
    if (!f || f.level !== 'private' || !enabled()) return '';
    const p = money(price());
    return `
      <div class="axp-sum-vip">
        ${eyebrow('Rendio Select', 'lt')}
        <b>La camioneta, solo para ti</b>
        <span>${p ? p + ' por trayecto · ' : ''}lo confirma coordinación · no se cobra en la app</span>
      </div>`;
  }

  // ── El estado de la solicitud, dentro del viaje ───────────────────────────
  // Se pinta en el detalle del traslado. Es lo que responde "¿me lo aprobaron?"
  // sin que el auxiliar tenga que preguntarle a nadie.
  function statusHTML(t) {
    if (!t || t.level !== 'private' || !t.privateStatus) return '';
    const p = money(t.price);
    if (t.privateStatus === 'requested') {
      return `<div class="axp-st wait">
        <span class="axp-st-ic"><svg class="icon"><use href="#i-clock"/></svg></span>
        <div><b>Privado · esperando confirmación</b>
        <span>Coordinación está revisando si la camioneta está libre a esa hora. Vuelve a esta pantalla para ver la respuesta.${p ? ' Tarifa: ' + p + '.' : ''}</span></div>
      </div>`;
    }
    if (t.privateStatus === 'approved') {
      return `<div class="axp-st ok">
        <span class="axp-st-ic"><svg class="icon"><use href="#i-check"/></svg></span>
        <div><b>Privado confirmado</b>
        <span>La camioneta es tuya para este trayecto.${p ? ' Tarifa acordada: ' + p + '.' : ''}</span></div>
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
    const cls = t.privateStatus === 'approved' ? 'ok' : t.privateStatus === 'rejected' ? 'no' : 'wait';
    const txt = t.privateStatus === 'approved' ? 'Privado' : t.privateStatus === 'rejected' ? 'Privado no' : 'Privado ·';
    return `<span class="axp-chip ${cls}"><svg class="icon"><use href="#i-van"/></svg>${txt}</span>`;
  }

  window.AuxPrivado = {
    enabled, price, money, stepHTML, introHTML, sumHTML, statusHTML, chipHTML,
    askCupo, resetCupo, cupo: () => st.cupo, INCLUYE,
  };
})();
