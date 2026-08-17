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
// más en LEVELS y una etiqueta más en el enum de 0069.
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
  // Cuando el jefe confirme el kit, se agregan aquí y aparecen solas.
  const INCLUYE = [
    { ic: 'i-van',   t: 'El carro es solo tuyo',   d: 'No se recoge a nadie más en el camino.' },
    { ic: 'i-route', t: 'Derecho a tu destino',    d: 'Sin desvíos por otros sectores.' },
    { ic: 'i-zzz',   t: 'Silencio si quieres',     d: 'Puedes pedir que no te hablen y dormir el trayecto.' },
    { ic: 'i-bolt',  t: 'Cargador a bordo',        d: 'USB-C y Lightning.' },
  ];

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

  // ── El paso: Compartido o Privado ─────────────────────────────────────────
  function stepHTML(f) {
    if (!enabled()) return null;   // el paso no existe si no hay privado que dar
    const sel = f.level === 'private' ? 'private' : 'shared';
    const p = money(price());
    const ocupada = st.cupo === 'ocupada';
    const dudoso = st.cupo === 'error';

    const compartido = `
      <button class="axp-lvl${sel === 'shared' ? ' on' : ''}" data-ax="lvl" data-v="shared">
        <span class="axp-lvl-head">
          <span class="axp-lvl-ic sh"><svg class="icon"><use href="#i-users"/></svg></span>
          <span class="axp-lvl-t"><b>Compartido</b><span>Vas con tu tripulación</span></span>
          <span class="axp-lvl-p"><b>Incluido</b><span>Sin costo para ti</span></span>
        </span>
        <span class="axp-lvl-li">Ruta agrupada por sector · paradas en el camino</span>
      </button>`;

    const privado = `
      <button class="axp-lvl${sel === 'private' ? ' on' : ''}${ocupada ? ' off' : ''}"
              data-ax="lvl" data-v="private"${ocupada ? ' disabled' : ''}>
        <span class="axp-lvl-head">
          <span class="axp-lvl-ic pv"><svg class="icon"><use href="#i-van"/></svg></span>
          <span class="axp-lvl-t"><b>Privado</b><span>La camioneta es solo tuya</span></span>
          <span class="axp-lvl-p"><b>${p || '—'}</b><span>por trayecto</span></span>
        </span>
        <span class="axp-lvl-li">Vehículo exclusivo · derecho a tu destino</span>
        ${ocupada ? `<span class="axp-lvl-no">Ya está comprometida a esa hora. Puedes pedirla para otro horario.</span>` : ''}
      </button>`;

    return `
      <p class="ax-lead">Los dos te llevan. Elige con cuál vas.</p>
      ${compartido}
      ${privado}
      ${dudoso ? `<div class="ax-hint"><svg class="icon"><use href="#i-info"/></svg>No pudimos confirmar si la camioneta está libre a esa hora. Puedes pedirla igual: si no alcanza, tu traslado sale en compartido y lo verás aquí.</div>` : ''}
      <button class="axp-more" data-ax="lvl-info"><svg class="icon"><use href="#i-info"/></svg>Qué incluye el privado</button>
      ${sel === 'private' ? `
        <div class="axp-note">
          <svg class="icon"><use href="#i-clock"/></svg>
          <div><b>Lo tiene que aprobar coordinación</b>
          <span>Es un vehículo dedicado, así que un jefe lo confirma antes. <b>La respuesta la vas a ver aquí mismo</b>, en tu traslado; y si tienes las notificaciones activadas, además te llega un aviso. Si no se puede, tu traslado sale en compartido y no se cobra nada.</span></div>
        </div>` : ''}`;
  }

  // ── La portada: qué es el privado ─────────────────────────────────────────
  function introHTML() {
    const p = money(price());
    return `
      <div class="ax-form-head">
        <button class="ax-icbtn" data-ax="lvl-close"><svg class="icon"><use href="#i-back"/></svg></button>
        <b>Traslado privado</b><span></span>
      </div>
      <div class="ax-body axp-intro">
        <div class="axp-hero">
          <span class="axp-hero-ic"><svg class="icon"><use href="#i-van"/></svg></span>
          <h1>La camioneta, solo para ti</h1>
          <p>El mismo servicio de siempre, en un vehículo dedicado que no recoge a nadie más.</p>
          ${p ? `<div class="axp-hero-p"><b>${p}</b><span>por trayecto · no se cobra en la app</span></div>` : ''}
        </div>
        <div class="axp-inc">
          ${INCLUYE.map(x => `
            <div class="axp-inc-row">
              <span class="axp-inc-ic"><svg class="icon"><use href="#${x.ic}"/></svg></span>
              <div><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>
            </div>`).join('')}
        </div>
        <div class="axp-fine">
          <b>Antes de pedirlo</b>
          <span>Hay una sola camioneta, así que no siempre está disponible: depende de la hora que necesites. Un jefe confirma cada solicitud. Si no se puede, tu traslado sale en compartido y no se cobra nada.</span>
        </div>
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar">
        <button class="ax-btn ax-btn-primary" data-ax="lvl-close">Entendido</button>
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
    enabled, price, money, stepHTML, introHTML, statusHTML, chipHTML,
    askCupo, resetCupo, cupo: () => st.cupo, INCLUYE,
  };
})();
