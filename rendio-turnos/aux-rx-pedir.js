// aux-rx-pedir.js — P5 · Pedir y punto (rediseño del auxiliar, 27-sep-2026).
//
// La pantalla «book» (pedir un traslado, pasos dinámicos) y «booked» (traslado
// pedido) con el marcado del diseñador (rx-book.jsx: RxBook, RxSlide), sobre la
// lógica de siempre (window.Auxiliar). Aquí NO se decide nada del pedido: qué
// pasos hay (Auxiliar.kinds), si se puede seguir (Auxiliar.ctaState), qué avisos
// salen (timeHint, flightAviso, leadCheck) y cómo se guarda (Auxiliar.submit)
// viven en auxiliar.js. Esta capa solo pinta y engancha gestos.
//
// CONTRATO (plan final §3.8):
//   window.AuxRxPedir = {
//     fieldHTML(label, key, value, ph, type, attrs)   mismo contrato que Auxiliar.fieldHTML (data-field)
//     toggleHTML(label, key, on, hint)                 data-ax="toggle" data-key
//     flightField(label, key, ph)                      contrato fl-* (fl-pick/fl-set/fl-other, data-field {key}Num/{key}Iata)
//     syncCta(el)                                      pie del pedido: solo disabled/aria (nunca innerHTML)
//     timeHintsHTML(hint)                              #ax-time-hints (leadCheck)
//     flightAvisoHTML(aviso, key)                      #ax-fl-aviso-{key}
//     refreshPinRow(form)                              #ax-pin-row del camino manual
//     screenHTML()                                     la pantalla entera (lo usa render)
//   }
//   Pantallas registradas en AuxShell: 'book' (capa modal) y 'booked' (pantalla completa).
//   Acciones data-rx: goto-step (data-step=<paso>), bags-dec, bags-inc.
//
// ANIMACIONES (ANIMACIONES-2026-09-27 §4-§5, con total lineamiento):
//   · paso = key={step}: al cambiar de paso el nodo .rx-step se RECREA con fwd/bwd
//     (state.stepDir). Repintar el mismo paso NO anima: se parchea en su lugar
//     (morph), como hace React con la misma key — así corren las transiciones
//     (.rx-chips button, .rx-type, .rx-tg, .rx-radio, rayas del encabezado).
//   · rx-calc = key: se recrea cuando cambia la hora (rxPop de .rx-calc-t).
//   · maletas = key={f.bags}: AuxRxUI.stepCtlSet recrea el número (rxPop).
//   · deslizador: arrastre con pointer capture y sin transición; confirma al
//     pasar el 82 % y dispara a los 380 ms; un toque sin arrastre también.
//   · paso 1: al tocar un tipo avanza a los 260 ms (lo hace auxiliar.js).
(function () {
  'use strict';

  const U = () => window.AuxRxUI;
  const A = () => window.Auxiliar || null;
  const S = () => { const a = A(); return (a && a.state) || null; };
  const F = () => { const s = S(); return (s && s.form) || {}; };
  const shellOn = () => {
    try { return !!(window.AuxShell && typeof AuxShell.on === 'function' && AuxShell.on()); }
    catch (_) { return false; }
  };
  const esc = (s) => (U() ? U().esc(s) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  const ic = (n, s, cls, style) => (U() ? U().ic(n, s, cls, style) : '');
  const root = () => document.getElementById('auxiliar-ui');
  // La capa del pedido que está en pantalla: la que sale (.out, 270 ms) no cuenta.
  const bookEl = () => {
    const r = root(); if (!r) return null;
    const all = r.querySelectorAll('[data-scr="book"]:not(.out) .rx-book');
    return all.length ? all[all.length - 1] : null;
  };
  const cfg = () => (typeof state !== 'undefined' && state && state.settings) ? state.settings : {};

  // Tiempos del diseño (rx-book.jsx).
  const T_SLIDE = 380;     // setTimeout(onDone, 380)
  const K_SLIDE = 0.82;    // x > max() * .82

  // Estado propio de la pantalla (no del pedido).
  const pv = {
    step: null, kind: null, n: null,   // lo último pintado: para saber si el paso cambió
    slide: null,                       // arrastre en curso {el, knob, start, x, max, id, moved}
    okTimer: null,                     // los 380 ms entre confirmar y enviar
    suppressUntil: 0,                  // el clic que sigue a un arrastre no confirma
  };

  // ── Tipos (RX_TYPES del diseño, sin Hotel: D22) ─────────────────────────────
  const TYPES = {
    sal: { t: 'Casa → Aeropuerto', s: 'Te recogemos para tu vuelo', ic: 'Plane', tone: 'h2a', from: 'CASA', to: 'MDE' },
    lle: { t: 'Aeropuerto → Casa', s: 'Te esperamos al aterrizar', ic: 'Home', tone: 'a2h', from: 'MDE', to: 'CASA' },
  };

  // ── Días (hora de Bogotá, nunca el reloj del teléfono) ──────────────────────
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function today() {
    try { if (U()) return U().bogDay(new Date()); } catch (_) { /* */ }
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  }
  function addDay(day, n) {
    const p = day.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10);
  }
  function wdOf(day) {
    const p = day.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay();
  }
  // 'jue 16' — los chips con nombre del diseño.
  const chipDay = (day) => WD[wdOf(day)] + ' ' + Number(day.slice(8, 10));
  // 'lun 5 oct' — el día elegido en el calendario.
  const longDay = (day) => chipDay(day) + ' ' + MO[Number(day.slice(5, 7)) - 1];
  function dayLabel(day) {
    if (!day) return '';
    try { if (U()) return U().dayLabel(day); } catch (_) { /* */ }
    return longDay(day);
  }
  const hm = (v) => (v ? (U() ? U().hm(v) : String(v).slice(0, 5)) : '');

  // ── Campos (mismo contrato que auxiliar.js: data-field / data-ax="toggle") ──
  // attrs puede traer min/max/etc. como texto, igual que el campo de siempre.
  function field(label, key, value, ph, type, attrs, o) {
    o = o || {};
    const d = o.d != null ? ` rx-in" style="--d:${o.d}` : '';
    const v = value == null ? '' : value;
    if (type === 'textarea') {
      return `<label class="rx-field rx-pd-area${d}"><span>${esc(label)}</span>`
        + `<textarea data-field="${esc(key)}" rows="2" placeholder="${esc(ph || '')}"${attrs ? ' ' + attrs : ''}>${esc(v)}</textarea></label>`;
    }
    const icon = o.icon || (type === 'time' ? 'Clock' : type === 'date' ? 'Calendar' : null);
    return `<label class="rx-field${d}"><span>${esc(label)}</span>`
      + `<span class="rx-input">${icon ? ic(icon, 20) : ''}`
      + `<input data-field="${esc(key)}" type="${esc(type || 'text')}" value="${esc(v)}" placeholder="${esc(ph || '')}"${attrs ? ' ' + attrs : ''} />`
      + `</span></label>`;
  }
  function fieldHTML(label, key, value, ph, type, attrs) { return field(label, key, value, ph, type, attrs); }

  // El interruptor del diseño (RxToggle) dentro de una fila .rx-set. La fila
  // lleva key: si otra fila entra antes, esta se recrea en vez de mutar en otra.
  function toggleHTML(label, key, on, hint) {
    const sw = U() ? U().toggle(!!on, { 'data-ax': 'toggle', 'data-key': key, 'aria-label': label })
      : `<button type="button" class="rx-tg${on ? ' on' : ''}" data-ax="toggle" data-key="${esc(key)}" aria-pressed="${on ? 'true' : 'false'}"><i></i></button>`;
    return `<div class="rx-set" data-rx-key="tg:${esc(key)}"><span><b>${esc(label)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</span>${sw}</div>`;
  }

  // ── El número de vuelo (contrato fl-*, igual que auxFlightField) ────────────
  // La sigla en un botón (la de la aerolínea del perfil, cambiable) y solo los
  // dígitos en el campo. auxiliar.js reescribe #ax-fl-chip-{key} y
  // #ax-fl-aviso-{key} en cada tecla sin repintar el paso.
  const AEROLINEAS_RESPALDO = [
    { iata: 'AV', name: 'Avianca' }, { iata: 'JA', name: 'JetSMART' },
    { iata: 'P5', name: 'Wingo' }, { iata: 'LA', name: 'LATAM' },
  ];
  const aerolineas = () => { const s = S(); return (s && s.airlines && s.airlines.length) ? s.airlines : AEROLINEAS_RESPALDO; };
  function sigla(key) {
    const f = F(), s = S();
    const v = f[key + 'Iata'];
    return String(v != null ? v : ((s && s.myIata) || '')).toUpperCase();
  }
  function marca(sig) {
    const M = window.MarcasAerolinea;
    return (M && M.mapa && sig && M.mapa[sig]) || null;
  }
  function flightAvisoHTML(a) {
    if (!a) return '';
    return `<div class="rx-note ${a.level === 'bad' ? 'bad' : 'info'}">${ic(a.level === 'bad' ? 'AlertTriangle' : 'Info', 15)}<span>${esc(a.text)}</span></div>`;
  }
  // o.compact: dentro de la tarjeta de opciones (el vuelo del regreso).
  function flightField(label, key, ph, o) {
    o = o || {};
    const f = F();
    const sig = sigla(key);
    const num = String(f[key + 'Num'] || '').replace(/\D/g, '');
    const cat = aerolineas();
    const otra = f.flOtra === key || (!!sig && !cat.some(a => a.iata === sig));
    const abierto = f.flPick === key;
    const m = otra ? null : marca(sig);
    const tinte = m ? ` style="background:linear-gradient(135deg,${m.c1},${m.c2});color:${m.tinta}"` : '';
    // El gris de «Sigla» va en línea en el <span>, como en el campo de siempre:
    // auxiliar.js (auxFlightChipSync) lo quita o lo pone en cada tecla.
    const chip = `<button type="button" class="rx-pd-sig${abierto ? ' open' : ''}" data-ax="fl-pick" data-k="${esc(key)}" aria-label="Aerolínea del vuelo" aria-expanded="${abierto ? 'true' : 'false'}"${tinte}>`
      + `<span id="ax-fl-chip-${esc(key)}"${sig ? '' : ' style="color:var(--a-t3)"'}>${esc(sig || 'Sigla')}</span>${ic('ChevronDown', 14)}</button>`;
    const input = `<input data-field="${esc(key)}Num" type="text" inputmode="numeric" autocomplete="off" value="${esc(num)}" placeholder="${esc(ph || '')}" aria-label="Número del vuelo, solo dígitos" />`;
    const d = o.d != null ? ` rx-in" style="--d:${o.d}` : '';
    const caja = o.compact
      ? `<div class="rx-set col rx-pd-fl" data-rx-key="fl:${esc(key)}"><b>${esc(label)}</b><div class="rx-pd-fl-row">${chip}${input}</div></div>`
      : `<div class="rx-field${d}" data-rx-key="fl:${esc(key)}"><span>${esc(label)}</span><div class="rx-input big rx-pd-fl-box">${ic('Plane', 20)}${chip}${input}</div></div>`;
    const lista = !abierto ? '' : `<div class="rx-list rx-pd-fl-list" data-rx-key="flpick:${esc(key)}">`
      + cat.map((a, i) => {
        const on = !otra && sig === a.iata;
        return `<button type="button" class="rx-fl rx-in${on ? ' on' : ''}" style="--d:${i}" data-ax="fl-set" data-k="${esc(key)}" data-iata="${esc(a.iata)}">`
          + `<span class="rx-fl-code">${esc(a.iata)}</span><span class="rx-fl-r"><b>${esc(a.name)}</b></span><span class="rx-radio"><i></i></span></button>`;
      }).join('')
      + `<button type="button" class="rx-fl rx-in${otra ? ' on' : ''}" style="--d:${cat.length}" data-ax="fl-other" data-k="${esc(key)}">`
      + `<span class="rx-fl-code">…</span><span class="rx-fl-r"><b>Otra</b><span>La escribo</span></span><span class="rx-radio"><i></i></span></button>`
      + (otra ? `<span class="rx-input rx-pd-iata"><input data-field="${esc(key)}Iata" type="text" autocomplete="off" value="${esc(sig)}" placeholder="Ej: CM" maxlength="3" aria-label="Sigla de la aerolínea" /></span>` : '')
      + `</div>`;
    const a = A() && typeof A().flightAviso === 'function' ? A().flightAviso(key) : null;
    return caja + lista + `<div id="ax-fl-aviso-${esc(key)}" data-rx-key="flav:${esc(key)}">${flightAvisoHTML(a, key)}</div>`;
  }

  // ── Avisos de hora (#ax-time-hints = leadCheck) ──────────────────────────────
  // El «ok» ya lo dice la tarjeta de la hora (rx-calc): aquí solo lo que frena
  // (fecha pasada) o lo que advierte (menos de N h de anticipación).
  function timeHintsHTML(h) {
    if (!h || h.level === 'ok') return '';
    return `<div class="rx-note ${h.level === 'bad' ? 'bad' : 'warn'}">${ic(h.level === 'bad' ? 'AlertTriangle' : 'Clock', 15)}<span>${esc(h.text)}</span></div>`;
  }

  // ── La tarjeta de la hora (rx-calc, key = la hora) ───────────────────────────
  // D7/D21: la hora de recogida NO se inventa. Se dice la hora que el
  // tripulante puso (estar en MDE o aterrizar) y que la recogida se confirma
  // con la ruta.
  function calcKey(f) { return 'calc:' + (f.type || '') + ':' + (f.time || ''); }
  // Como en el diseño, sin --d: al re-montarse corren rxRise y rxPop.
  // En tierra (0092) la llegada no aterriza: sale del aeropuerto a esa hora.
  function calcHTML(f) {
    if (!f.time) return `<div class="rx-pd-calc-slot" data-rx-key="calc:"></div>`;
    const lle = f.type === 'lle';
    return `<div class="rx-calc rx-in" data-rx-key="${esc(calcKey(f))}">`
      + `<span class="rx-calc-l">${lle ? (f.groundOps ? 'Sales de MDE' : 'Aterrizas') : 'Estar en MDE'}</span>`
      + `<b class="rx-calc-t">${esc(hm(f.time))}</b>`
      + `<span class="rx-calc-s">La hora de recogida te la confirmamos cuando armemos tu ruta.</span></div>`;
  }

  // ── Encabezado: X o atrás, N rayas y {s}/{N} ─────────────────────────────────
  function headHTML(s, n) {
    let rayas = '';
    for (let k = 1; k <= n; k++) rayas += `<i class="${k < s ? 'done' : k === s ? 'now' : ''}"></i>`;
    // X = rx.pop() del diseño: por la pila del shell vuelve a la pestaña de la
    // que se vino (Auxiliar.back cierra el pedido en su paso 1). Atrás = el
    // paso anterior (data-ax="back", por la misma entrada al paso, #18).
    const first = s <= 1;
    const act = first ? 'data-rx="rx-pop"' : 'data-ax="back"';
    return `<div class="rx-book-h">`
      + `<button type="button" class="rx-ib" ${act} aria-label="${first ? 'Cerrar' : 'Atrás'}">${ic(first ? 'X' : 'ChevronLeft', 22)}</button>`
      + `<div class="rx-book-steps" style="--n:${n}">${rayas}</div>`
      + `<span class="rx-step-n">${s}/${n}</span></div>`;
  }

  // ── Pasos ────────────────────────────────────────────────────────────────────
  function titleOf(kind, f) {
    const lle = f.type === 'lle';
    if (kind === 'tipo') return '¿A dónde vas?';
    // En tierra (0092) no hay vuelo por el que preguntar.
    if (kind === 'vuelo' && f.groundOps) return lle ? '¿A qué hora sales?' : '¿Cuándo vas al aeropuerto?';
    if (kind === 'vuelo') return lle ? '¿Cuál es tu vuelo?' : '¿Cuándo es tu vuelo?';
    if (kind === 'donde') return lle ? '¿A dónde te llevamos?' : '¿Dónde te recogemos?';
    if (kind === 'nivel') return '¿Cómo quieres ir?';
    return 'Revisa tu traslado';
  }

  // Quien trabaja en tierra (0092; el pedido arranca como su último traslado)
  // no va «para su vuelo» ni «aterriza»: el subtítulo lo dice sin avión, y la
  // pista de la pernocta (noche entre vuelos) no le aplica.
  const TYPES_TIERRA = { sal: 'Te llevamos al aeropuerto', lle: 'Te recogemos al salir del aeropuerto' };
  function tipoHTML(f) {
    const tierra = !!f.groundOps;
    const btn = (type, i) => {
      const t = TYPES[type];
      return `<button type="button" class="rx-type rx-in t-${t.tone}${f.type === type ? ' on' : ''}" style="--d:${i}" data-ax="type" data-type="${type}">`
        + `<span class="rx-type-ic">${ic(t.ic, 24)}</span>`
        + `<span class="rx-type-tx"><b>${esc(t.t)}</b><span>${esc(tierra ? TYPES_TIERRA[type] : t.s)}</span></span>`
        + `<span class="rx-type-code">${t.from}${ic('ArrowRight', 13)}${t.to}</span></button>`;
    };
    return btn('sal', 0) + btn('lle', 1)
      + (tierra ? '' : `<div class="rx-note rx-in" style="--d:2">${ic('Info', 15)}<span>Si tu vuelo incluye pernocta, lo marcas en el siguiente paso, con los datos del vuelo.</span></div>`);
  }

  function chipsHTML(f) {
    const hoy = today();
    const dias = [
      { iso: hoy, label: 'Hoy' },
      { iso: addDay(hoy, 1), label: 'Mañana' },
      { iso: addDay(hoy, 2), label: chipDay(addDay(hoy, 2)) },
      { iso: addDay(hoy, 3), label: chipDay(addDay(hoy, 3)) },
    ];
    const otro = !!f.date && !dias.some(d => d.iso === f.date);
    return `<div class="rx-chips rx-in" data-rx-key="chips">`
      + dias.map(d => `<button type="button" class="${f.date === d.iso ? 'on' : ''}" data-ax="date" data-iso="${d.iso}">${esc(d.label)}</button>`).join('')
      + `<label class="rx-pd-otro${otro ? ' on' : ''}">${ic('Calendar', 15)}<span class="rx-pd-otro-t">${otro ? esc(longDay(f.date)) : 'Otro día'}</span>`
      + `<input type="date" data-field="date" value="${esc(f.date || '')}" min="${hoy}" aria-label="Otro día" /></label>`
      + `</div>`;
  }

  // Los textos del trabajo en tierra salen de auxiliar.js (una sola fuente con
  // la pantalla de siempre); este respaldo solo corre si no cargó.
  const TIERRA_RESPALDO = {
    label: 'Trabajo en tierra (sin vuelo)',
    hint: 'Operaciones del aeropuerto: vas a MDE sin tomar un vuelo.',
    salNote: 'Es a qué hora quieres estar allá. Nosotros calculamos a qué hora pasa el carro.',
    lleNote: 'Es la hora a la que sales del terminal. Como no vienes en un vuelo, no le sumamos tiempo de desembarque.',
  };
  const tierraTx = () => (A() && A().tierra) || TIERRA_RESPALDO;

  function vueloHTML(f) {
    const lle = f.type === 'lle';
    // Trabajo en tierra (0092): arriba del paso, en su tarjeta. Encendido, la
    // llegada no pide vuelo y su hora es la de salir del aeropuerto (sin
    // desembarque); la salida queda igual. La pernocta y el vuelo del regreso
    // se esconden: no tienen sentido sin avión.
    const tierra = !!f.groundOps;
    const TX = tierraTx();
    let d = 1;
    let h = `<div class="rx-card rx-in" style="--d:0" data-rx-key="ground">${toggleHTML(TX.label, 'groundOps', tierra, TX.hint)}</div>`;
    h += chipsHTML(f);
    if (lle && !tierra) h += flightField('Número de vuelo', 'flight', '9412', { d: d++ });
    const lbl = lle ? (tierra ? 'Hora en que sales del aeropuerto' : 'Hora de aterrizaje') : 'Hora en que quieres estar en el aeropuerto';
    h += field(lbl, 'time', f.time || '', lle ? (tierra ? '17:00' : '06:18') : '05:10', 'time', '', { d: d++ });
    // La nota lleva key propia: al encender el interruptor cambia de texto en el
    // mismo nodo, y en la llegada aparece o se va sin mover a las demás.
    const nota = lle ? (tierra ? TX.lleNote : '')
      : (tierra ? TX.salNote : 'No es tu hora de presentación: es a qué hora quieres estar allá. Nosotros calculamos a qué hora pasa el carro.');
    if (nota) h += `<div class="rx-note rx-in" style="--d:${d++}" data-rx-key="timenote">${ic('Info', 15)}<span>${esc(nota)}</span></div>`;
    h += calcHTML(f);
    const hint = A() && typeof A().timeHint === 'function' ? A().timeHint() : null;
    h += `<div id="ax-time-hints" data-rx-key="hints">${timeHintsHTML(hint)}</div>`;
    // La tarjeta de opciones: regreso del mismo día (solo salida), pernocta y
    // reserva en firme. Son datos del VIAJE: van con el vuelo.
    let card = '';
    if (!lle) {
      card += toggleHTML('Regreso el mismo día', 'sameDayBack', f.sameDayBack,
        'Si vuelves hoy mismo, lo dejamos pedido de una vez.');
      if (f.sameDayBack) {
        // En tierra el regreso es solo la hora de salir del aeropuerto.
        card += `<label class="rx-set col" data-rx-key="backTime"><b>${tierra ? 'Hora en que sales del aeropuerto' : 'Hora a la que aterrizas de vuelta'}</b>`
          + `<input data-field="backTime" type="time" value="${esc(f.backTime || '')}" placeholder="${tierra ? '17:00' : '19:40'}" /></label>`;
        if (!tierra) card += flightField('Número del vuelo con el que aterrizas', 'backFlight', '9413', { compact: true });
        card += `<div class="rx-set rx-pd-set-note" data-rx-key="backNote"><span class="rx-note">${ic('Info', 15)}<span>Quedan dos traslados: el de ida y el de regreso. Puedes cancelar cualquiera por separado.</span></span></div>`;
      }
    }
    if (!tierra) card += toggleHTML('¿Es una pernocta?', 'isPernocta', f.isPernocta, 'Pasas la noche entre vuelos (hotel).');
    card += toggleHTML('¿Es una reserva en firme?', 'isReserva', f.isReserva !== false, 'Confírmanos que el viaje va.');
    h += `<div class="rx-card rx-in" style="--d:${d++}" data-rx-key="opts">${card}</div>`;
    return h;
  }

  // Camino manual (texto + pin), con el aspecto rx. Es la excepción: se llega
  // aquí si el tripulante lo pide o si el catálogo no cargó (y se dice).
  function pinRowInner(f) {
    return f.locConfirmed
      ? `${ic('Check', 15)}<span>Ubicación confirmada</span><button type="button" class="rx-pd-link" data-ax="pin-edit">Ajustar</button>`
      : `${ic('MapPin', 15)}<span>Mueve el pin al punto exacto y confirma.</span>`;
  }
  function manualHTML(f) {
    const R = window.AuxResidencias;
    const lle = f.type === 'lle';
    let h = '';
    if (R && R.hasCatalog() && f.manualAddr) {
      h += `<button type="button" class="rx-opt dashed rx-in" style="--d:0" data-ax="res-catalog"><span class="rx-opt-ic">${ic('ChevronLeft', 18)}</span><span class="rx-opt-tx"><b>Volver a la lista de conjuntos</b><span>Elegir mi punto verificado</span></span></button>`;
    }
    if (!f.manualAddr && R && R.unavailable()) {
      h += `<div class="rx-note bad rx-in" style="--d:0">${ic('AlertTriangle', 15)}<span>No pudimos cargar tus puntos de recogida guardados, así que toca escribir la dirección. Si acabas de abrir la app, reintenta; si sigue igual, avisa a coordinación.</span></div>`;
      h += U() ? U().btn('Reintentar', { kind: 'ghost', icon: 'Refresh', attrs: { 'data-ax': 'res-retry' } }) : '';
    }
    h += field(lle ? 'Dirección donde te dejamos' : 'Dirección de recogida', 'address', f.address || '', 'Cra 51 #49-06, Centro', 'text', 'autocomplete="off"', { d: 1, icon: 'MapPin' });
    h += `<div class="rx-note">${ic('Info', 15)}<span>${lle ? 'Casa, hotel o donde te quedes.' : 'Casa, hotel o donde estés esa noche.'}</span></div>`;
    h += `<div id="ax-map" class="rx-pd-map ${f.address ? '' : 'hidden'}" data-rx-keep="1"></div>`;
    h += `<div id="ax-pin-row" class="rx-note rx-pd-pin ${f.locConfirmed ? 'ok' : ''} ${f.address ? '' : 'hidden'}">${pinRowInner(f)}</div>`;
    if (!f.locConfirmed && f.address) {
      h += U() ? U().btn('Confirmar ubicación', { kind: 'sec', icon: 'Check', attrs: { 'data-ax': 'pin-confirm' } }) : '';
    }
    return h;
  }
  function refreshPinRow(f) {
    f = f || F();
    const b = bookEl(); if (!b) return;
    const row = b.querySelector('#ax-pin-row'); if (!row) return;
    row.className = 'rx-note rx-pd-pin' + (f.locConfirmed ? ' ok' : '') + (f.address ? '' : ' hidden');
    row.innerHTML = pinRowInner(f);
    const btn = b.querySelector('[data-ax="pin-confirm"]');
    if (!f.locConfirmed && f.address && !btn && U()) {
      row.insertAdjacentHTML('afterend', U().btn('Confirmar ubicación', { kind: 'sec', icon: 'Check', attrs: { 'data-ax': 'pin-confirm' } }));
    } else if (f.locConfirmed && btn) btn.remove();
    const map = b.querySelector('#ax-map');
    if (map && f.address) map.classList.remove('hidden');
  }

  function dondeHTML(f) {
    const R = window.AuxResidencias;
    if (R) {
      R.autofill(f);
      const cat = R.html(f);
      if (cat != null) return cat;
    }
    return manualHTML(f);
  }

  function nivelHTML(f) {
    const P = window.AuxPrivado;
    if (!P) return '';
    let h = typeof P.levelsHTML === 'function' ? (P.levelsHTML(f, { mode: 'book' }) || '')
      : (typeof P.stepHTML === 'function' ? (P.stepHTML(f) || '') : '');
    // D4 · «Prefiero silencio» con el privado elegido (si el módulo del nivel
    // no lo trae ya).
    if (f.level === 'private' && P.enabled && P.enabled() && h.indexOf('data-key="quietRide"') < 0) {
      h += `<div class="rx-card rx-in" style="--d:3" data-rx-key="quiet">${toggleHTML('Prefiero silencio', 'quietRide', !!f.quietRide, 'Tu conductor lo ve en su ruta.')}</div>`;
    }
    // La nota del diseño (RxBook paso 3); con cuenta de cobro, el texto lo da P6.
    const nota = typeof P.sharedNoteText === 'function' ? P.sharedNoteText() : 'Compartido va con tu tripulación y no tiene costo.';
    h += `<div class="rx-note" data-rx-key="lvnote">${ic('Info', 15)}<span>${esc(nota)}</span></div>`;
    return h;
  }

  // La política, ANTES de confirmar (B3). Los minutos salen de Ajustes.
  function policyHTML(d) {
    const wait = cfg().aux_wait_minutes != null ? cfg().aux_wait_minutes : 5;
    return `<div class="rx-pd-pol rx-in" style="--d:${d}" data-rx-key="policy">`
      + `<div class="rx-lbl">Antes de confirmar</div>`
      + `<div class="rx-note">${ic('Clock', 15)}<span><b>El carro espera ${esc(wait)} minutos.</b> Se cuentan desde que llega al punto. Vas a ver la cuenta regresiva en la app.</span></div>`
      + `<div class="rx-note">${ic('X', 15)}<span><b>Puedes cancelar</b> mientras no te hayan recogido. Si ya hay conductor asignado, le avisamos y sale de su ruta.</span></div>`
      + `<div class="rx-note">${ic('Users', 15)}<span><b>Puedes ir acompañado de otros tripulantes.</b> Si alguien más sale a una hora parecida y cerca de ti, el carro hace una sola parada.</span></div>`
      + `</div>`;
  }

  function shortAddr(a) { return String(a || '').split(',')[0]; }

  // Vacaciones (0094, 30-sep: «si reserva más viajes de los que declaró, se le
  // cobra la diferencia»): si este viaje (o la ida y el regreso del mismo día)
  // supera lo que declaró en ese cobro, se le dice cuánto se suma ANTES de
  // confirmar. No bloquea. Lo calcula AuxPagos con lo que da la base (su cuenta);
  // sin ese dato, no se pinta nada.
  function vacExtraHTML(f) {
    const PG = window.AuxPagos;
    if (!PG || typeof PG.vacExtraFor !== 'function' || !f || !f.date) return '';
    const n = 1 + (f.type !== 'lle' && f.sameDayBack && f.backTime ? 1 : 0);
    let x = null;
    try { x = PG.vacExtraFor(f.date, n); } catch (_) { x = null; }
    if (!x || !x.text) return '';
    return `<div class="rx-note warn rx-in" style="--d:2" data-rx-key="vacextra">${ic('Sun', 15)}<span>${esc(x.text)}</span></div>`;
  }

  function revisarHTML(f) {
    const lle = f.type === 'lle';
    const kinds = A() && typeof A().kinds === 'function' ? A().kinds() : [];
    const R = window.AuxResidencias;
    const P = window.AuxPrivado;
    // Lo que se ve es lo que se manda: las maletas arrancan en 0 (el de mano no cuenta).
    if (f.bags == null || f.bags === '') f.bags = 0;
    const row = (icn, k, v, attrs) => attrs
      ? `<button type="button" class="rx-rv-row" ${attrs}>${ic(icn, 17)}<span>${esc(k)}</span><b>${esc(v)}</b><em>Cambiar</em></button>`
      : `<div class="rx-rv-row static">${ic(icn, 17)}<span>${esc(k)}</span><b>${esc(v)}</b><em></em></div>`;
    const goVuelo = 'data-rx="goto-step" data-step="vuelo"';
    let rows = '';
    // El día y la hora ya van grandes arriba: la fila dice el vuelo (llegada)
    // o para qué es la hora (salida).
    const tierra = !!f.groundOps;
    if (tierra) {
      // En tierra (0092) la fila dice eso, no un vuelo (tampoco uno que haya
      // quedado escrito antes de encender el interruptor: ese no viaja).
      const cuando = f.time ? (lle ? 'sales ' : 'estar en MDE ') + hm(f.time) : '';
      rows += row('Briefcase', 'Trabajo', ['En tierra', cuando].filter(Boolean).join(' · '), goVuelo);
    } else {
      const vuelo = lle ? [f.flight, f.time ? 'aterriza ' + hm(f.time) : ''].filter(Boolean).join(' · ')
        : (f.time ? 'Estar en MDE ' + hm(f.time) : '');
      rows += row('Plane', 'Vuelo', vuelo || '—', goVuelo);
    }
    const place = [shortAddr(f.address), f.residenceUnit].filter(Boolean).join(' · ') || '—';
    rows += row('MapPin', lle ? 'Destino' : 'Recogida', place, (R && R.hasCatalog()) ? 'data-ax="donde-cambiar"' : '');
    if (kinds.indexOf('nivel') >= 0) {
      const priv = f.level === 'private';
      rows += row(priv ? 'Sparkle' : 'Users', 'Nivel', priv ? 'Privado · Con costo' : 'Compartido · Incluido', 'data-rx="goto-step" data-step="nivel"');
    }
    if (!lle && f.sameDayBack && f.backTime) {
      rows += row('RotateCcw', 'Regreso', tierra ? 'Sales de MDE ' + hm(f.backTime)
        : 'Aterriza ' + hm(f.backTime) + (f.backFlight ? ' · ' + f.backFlight : ''), goVuelo);
    }
    if (f.isPernocta && !tierra) rows += row('Moon', 'Pernocta', 'Sí (hotel)', goVuelo);
    if (f.isReserva === false) rows += row('Calendar', 'Reserva', 'Tentativa (sin confirmar)', goVuelo);

    const bags = Math.max(0, Math.min(3, Number(f.bags) || 0));
    const ctl = U() ? U().stepCtl(bags) : '';
    return `<div class="rx-review rx-in" data-rx-key="review">`
      + `<div class="rx-rv-time"><span>${esc(dayLabel(f.date) || '—')}</span><b>${esc(hm(f.time) || '--:--')}</b>`
      + `<span>${lle ? (tierra ? 'sales de MDE' : 'aterrizas') : 'estar en MDE'}</span>`
      + `<span class="rx-pd-rv-sub">La recogida te la confirmamos cuando armemos tu ruta.</span></div>`
      + rows + `</div>`
      + `<div class="rx-card rx-in" style="--d:1" data-rx-key="extras">`
      + `<div class="rx-set"><span><b>Maletas</b><span>Carry-on no cuenta</span></span>${ctl}</div>`
      + `<label class="rx-set col"><b>Nota para el conductor</b><input data-field="notes" type="text" value="${esc(f.notes || '')}" placeholder="Ej. salgo por la portería de visitantes" /></label>`
      + `</div>`
      + ((P && typeof P.sumHTML === 'function') ? `<div class="rx-pd-sum" data-rx-key="sum">${P.sumHTML(f) || ''}</div>` : '')
      + vacExtraHTML(f)
      + policyHTML(2);
  }

  function stepBodyHTML(kind, f) {
    const cuerpo = kind === 'tipo' ? tipoHTML(f)
      : kind === 'vuelo' ? vueloHTML(f)
      : kind === 'donde' ? dondeHTML(f)
      : kind === 'nivel' ? nivelHTML(f)
      : revisarHTML(f);
    return `<h1 class="rx-book-t">${esc(titleOf(kind, f))}</h1>${cuerpo}`;
  }
  function stepHTML(s, kind, dir, anim) {
    return `<div class="rx-body rx-step ${dir === 'bwd' ? 'bwd' : 'fwd'}${anim ? ' rx-anim' : ''}" data-rx-step="${s}:${kind}">`
      + stepBodyHTML(kind, F()) + `</div>`;
  }

  // ── Pie: «Continuar» o el deslizador ────────────────────────────────────────
  function ctaState() {
    const a = A();
    return (a && typeof a.ctaState === 'function') ? a.ctaState() : { kind: 'tipo', disabled: true, label: 'Continuar', private: false, bad: false };
  }
  function slideHTML(c) {
    const label = c.private ? 'Desliza para solicitar' : 'Desliza para pedir';
    return `<div class="rx-slide${c.disabled ? ' off' : ''}" aria-disabled="${c.disabled ? 'true' : 'false'}">`
      + `<div class="rx-slide-fill" style="width:56px"></div>`
      + `<span class="rx-slide-l" style="opacity:1">${esc(label)}</span>`
      + `<button type="button" class="rx-slide-k" style="transform:translateX(0px)" aria-label="${esc(c.label)}"${c.disabled ? ' disabled aria-disabled="true"' : ''}>${ic('ArrowRight', 22)}</button>`
      + `</div>`;
  }
  function footInner(kind) {
    const c = ctaState();
    if (kind === 'tipo') return '';
    if (kind === 'revisar') return slideHTML(c);
    return U() ? U().btn('Continuar', { attrs: { 'data-ax': 'next', 'aria-disabled': c.disabled ? 'true' : 'false' }, disabled: c.disabled }) : '';
  }

  // Número y nombre del paso actuales (el número se acomoda si un paso
  // desapareció por debajo, como en auxFormHTML).
  function where() {
    const s0 = S(), a = A();
    const kinds = (a && typeof a.kinds === 'function') ? a.kinds() : ['tipo', 'vuelo', 'revisar'];
    const n = kinds.length;
    if (s0 && s0.step > n) s0.step = n;
    const s = s0 ? Math.max(1, s0.step || 1) : 1;
    return { s, n, kind: kinds[s - 1] || 'revisar', dir: (s0 && s0.stepDir) || 'fwd' };
  }

  function screenHTML() {
    const w = where();
    pv.step = w.s; pv.kind = w.kind; pv.n = w.n;
    return `<div class="rx-scr rx-book" data-kind="${w.kind}">`
      + headHTML(w.s, w.n)
      + stepHTML(w.s, w.kind, w.dir, false)
      + `<div class="rx-foot ax-cta-bar">${footInner(w.kind)}</div>`
      + `</div>`;
  }

  // ── Parche en su lugar (misma key = mismo nodo, como React) ─────────────────
  function frag(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content;
  }
  function one(html) { return frag(html).firstElementChild; }
  const keyOf = (n) => (n.nodeType === 1 ? (n.getAttribute('data-rx-key') || (n.id ? '#' + n.id : null)) : null);
  function same(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    return a.tagName === b.tagName && keyOf(a) === keyOf(b);
  }
  function keep(a) { return a.nodeType === 1 && a.hasAttribute('data-rx-keep'); }
  function syncAttrs(a, b) {
    // .rx-anim es del nodo montado (no del marcado): se conserva, para no
    // cortarle la entrada a media animación.
    if (a.classList && a.classList.contains('rx-anim') && b.classList && !b.classList.contains('rx-anim')) b.classList.add('rx-anim');
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of [...b.attributes]) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    const tag = a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const focused = a.ownerDocument.activeElement === a;
      const want = tag === 'TEXTAREA' ? b.textContent : (b.getAttribute('value') || '');
      if (!focused && a.value !== want) a.value = want;
      if (tag === 'INPUT' && (a.type === 'checkbox' || a.type === 'radio')) a.checked = b.hasAttribute('checked');
    }
  }
  function morph(a, b) {
    if (keep(a)) return;
    syncAttrs(a, b);
    if (a.tagName === 'TEXTAREA') return;
    morphKids(a, b);
  }
  function morphKids(a, b) {
    const x = [...a.childNodes], y = [...b.childNodes];
    const len = Math.max(x.length, y.length);
    for (let i = 0; i < len; i++) {
      const p = x[i], q = y[i];
      if (!q) { p.remove(); continue; }
      if (!p) { a.appendChild(mounted(q)); continue; }
      if (same(p, q)) {
        if (p.nodeType === 1) morph(p, q);
        else if (p.nodeValue !== q.nodeValue) p.nodeValue = q.nodeValue;
      } else {
        a.replaceChild(mounted(q), p);
      }
    }
  }
  // Un nodo que ENTRA en un parche es un montaje nuevo (key nueva en React): si
  // trae entrada (.rx-in) se marca .rx-anim para que anime aunque la capa haya
  // quedado con .rx-noanim de un repintado anterior.
  function mounted(n) {
    if (n.nodeType === 1 && (n.classList.contains('rx-in') || n.querySelector('.rx-in'))) n.classList.add('rx-anim');
    return n;
  }

  function patchBook(ctx) {
    const scr = ctx && ctx.host ? ctx.host.querySelector('.rx-book') : bookEl();
    if (!scr) return false;
    const w = where();
    const head = scr.querySelector('.rx-book-h');
    const body = scr.querySelector('.rx-step');
    const foot = scr.querySelector('.ax-cta-bar');
    if (!head || !body || !foot) return false;
    morph(head, one(headHTML(w.s, w.n)));
    scr.setAttribute('data-kind', w.kind);
    if (pv.step !== w.s || pv.kind !== w.kind) {
      // Paso nuevo (key={step}): el nodo se RECREA con la dirección del cambio.
      if (pv.kind === 'donde' && w.kind !== 'donde' && window.AuxResidencias) AuxResidencias.destroyMap();
      const html = stepHTML(w.s, w.kind, w.dir, true);
      if (window.AuxShell && typeof AuxShell.rekey === 'function') AuxShell.rekey(body, html);
      else body.replaceWith(one(html));
      cancelSlide();
    } else {
      // Mismo paso: se parchea en su lugar, sin re-montar nada.
      morphKids(body, one(stepHTML(w.s, w.kind, w.dir, false)));
    }
    // El deslizador que ya está en pantalla no se rehace (puede estar a medio
    // arrastre o en sus 380 ms): su estado lo pone syncCta. Lo demás, parche.
    if (w.kind === 'revisar' && foot.querySelector('.rx-slide')) syncCta();
    else morph(foot, one(`<div class="rx-foot ax-cta-bar">${footInner(w.kind)}</div>`));
    pv.step = w.s; pv.kind = w.kind; pv.n = w.n;
    return true;
  }

  // ── syncCta: el pie sin innerHTML (#17) ──────────────────────────────────────
  // Solo disabled/aria del «Continuar» y del deslizador. Además, si la tecla
  // fue en la fecha o la hora, se acomodan los chips del día y la tarjeta de la
  // hora (clases y la key del rx-calc), también sin repintar el paso.
  function syncCta(el) {
    const b = bookEl(); if (!b) return;
    const c = ctaState();
    b.querySelectorAll('.ax-cta-bar [data-ax="next"]').forEach(x => {
      x.disabled = c.disabled;
      x.setAttribute('aria-disabled', c.disabled ? 'true' : 'false');
    });
    const sl = b.querySelector('.ax-cta-bar .rx-slide');
    if (sl && !pv.okTimer) {
      sl.classList.toggle('off', c.disabled);
      sl.setAttribute('aria-disabled', c.disabled ? 'true' : 'false');
      const k = sl.querySelector('.rx-slide-k');
      if (k) {
        k.disabled = c.disabled;
        if (c.disabled) k.setAttribute('aria-disabled', 'true'); else k.removeAttribute('aria-disabled');
        k.setAttribute('aria-label', c.label);
      }
    }
    const key = el && el.getAttribute ? el.getAttribute('data-field') : null;
    if (key === 'date') syncDateChips(b);
    if (key === 'date' || key === 'time') syncCalc(b);
  }
  function syncDateChips(b) {
    const chips = b.querySelector('.rx-chips'); if (!chips) return;
    const f = F();
    let alguno = false;
    chips.querySelectorAll('button[data-iso]').forEach(x => {
      const on = x.getAttribute('data-iso') === f.date;
      if (on) alguno = true;
      x.classList.toggle('on', on);
    });
    const otro = chips.querySelector('.rx-pd-otro');
    if (otro) {
      const on = !!f.date && !alguno;
      otro.classList.toggle('on', on);
      const t = otro.querySelector('.rx-pd-otro-t');
      if (t) t.textContent = on ? longDay(f.date) : 'Otro día';
    }
  }
  function syncCalc(b) {
    const cur = b.querySelector('.rx-step [data-rx-key^="calc:"]'); if (!cur) return;
    const f = F();
    const want = f.time ? calcKey(f) : 'calc:';
    if (cur.getAttribute('data-rx-key') === want) return;
    // key={…}: se recrea para que rxRise y rxPop vuelvan a correr.
    const n = one(calcHTML(f));
    n.classList.add('rx-anim');
    cur.replaceWith(n);
  }

  // ── El deslizador (RxSlide), delegado en #auxiliar-ui ───────────────────────
  function slideMax(sl) {
    const w = sl ? sl.offsetWidth : 0;
    return w > 60 ? w - 60 : 260;
  }
  function paintSlide(sl, x, drag) {
    const max = slideMax(sl);
    const fill = sl.querySelector('.rx-slide-fill');
    const lab = sl.querySelector('.rx-slide-l');
    const k = sl.querySelector('.rx-slide-k');
    const r = max ? x / max : 0;
    if (fill) { fill.style.width = (x + 56) + 'px'; fill.style.transition = drag ? 'none' : ''; }
    if (lab) lab.style.opacity = String(1 - r * 1.4);
    if (k) { k.style.transform = 'translateX(' + x + 'px)'; k.style.transition = drag ? 'none' : ''; }
  }
  function slideOf(t) {
    const sl = t && t.closest ? t.closest('.rx-slide') : null;
    if (!sl || !sl.closest('[data-scr="book"]:not(.out)')) return null;
    return sl;
  }
  function slideDisabled(sl) {
    if (!sl) return true;
    if (sl.classList.contains('off') || sl.getAttribute('aria-disabled') === 'true') return true;
    return !!ctaState().disabled;
  }
  function cancelSlide() {
    if (pv.okTimer) { clearTimeout(pv.okTimer); pv.okTimer = null; }
    pv.slide = null; pv.suppressUntil = 0;
  }
  // Confirmar: EN EL MISMO EVENTO se desbloquea el audio (iOS) y luego, a los
  // 380 ms del diseño, se envía con {primed:true}.
  function confirmSlide(sl) {
    if (pv.okTimer || slideDisabled(sl)) return false;
    try { if (window.AuxCelebracion && typeof AuxCelebracion.prime === 'function') AuxCelebracion.prime(); } catch (_) { /* */ }
    const max = slideMax(sl);
    sl.classList.add('ok');
    sl.setAttribute('data-rx-keep', '1');
    paintSlide(sl, max, false);
    const k = sl.querySelector('.rx-slide-k');
    if (k) k.innerHTML = ic('Check', 22);
    pv.okTimer = setTimeout(() => {
      const a = A();
      let p = null;
      try { p = a && typeof a.submit === 'function' ? a.submit({ primed: true }) : null; } catch (_) { p = null; }
      Promise.resolve(p).catch(() => {}).then(() => {
        pv.okTimer = null;
        // Si el pedido no salió (error, sin conexión), el deslizador vuelve.
        const s = S();
        if (s && s.view === 'form') resetSlide(sl);
      });
    }, T_SLIDE);
    return true;
  }
  function resetSlide(sl) {
    if (!sl || !sl.isConnected) return;
    sl.classList.remove('ok');
    sl.removeAttribute('data-rx-keep');
    const k = sl.querySelector('.rx-slide-k');
    if (k) k.innerHTML = ic('ArrowRight', 22);
    paintSlide(sl, 0, false);
    syncCta();
  }
  function onDown(e) {
    const sl = slideOf(e.target); if (!sl) return;
    const k = e.target.closest('.rx-slide-k'); if (!k) return;
    if (pv.okTimer || slideDisabled(sl)) return;
    pv.slide = { el: sl, knob: k, start: e.clientX, x: 0, moved: false, id: e.pointerId };
    pv.suppressUntil = 0;
    sl.setAttribute('data-rx-keep', '1');
    try { if (k.setPointerCapture && e.pointerId != null) k.setPointerCapture(e.pointerId); } catch (_) { /* */ }
    paintSlide(sl, 0, true);
  }
  function onMove(e) {
    const d = pv.slide; if (!d) return;
    const max = slideMax(d.el);
    const x = Math.max(0, Math.min(max, e.clientX - d.start));
    if (Math.abs(e.clientX - d.start) > 6) d.moved = true;
    d.x = x;
    paintSlide(d.el, x, true);
  }
  function onUp() {
    const d = pv.slide; if (!d) return;
    pv.slide = null;
    const max = slideMax(d.el);
    // El clic que el navegador manda justo después del pointerup no cuenta si
    // hubo arrastre: ni el que ya confirmó ni uno corto que no llegó (el toque
    // sin arrastre sí confirma: es el respaldo del diseño).
    if (d.x > max * K_SLIDE) { confirmSlide(d.el); pv.suppressUntil = Date.now() + 500; return; }
    d.el.removeAttribute('data-rx-keep');
    paintSlide(d.el, 0, false);
    pv.suppressUntil = d.moved ? Date.now() + 500 : 0;
  }
  function onClick(e) {
    const t = e.target;
    // «Otro día»: abre el calendario nativo también en escritorio.
    if (t && t.matches && t.matches('[data-scr="book"] .rx-pd-otro input[type="date"]')) {
      try { if (typeof t.showPicker === 'function') t.showPicker(); } catch (_) { /* */ }
      return;
    }
    const sl = slideOf(t); if (!sl) return;
    if (!t.closest('.rx-slide-k')) return;
    if (pv.suppressUntil && Date.now() < pv.suppressUntil) { pv.suppressUntil = 0; return; }
    if (pv.slide) return;
    confirmSlide(sl);
  }
  function bindOnce() {
    const r = root(); if (!r || r.__rxPedirBound) return;
    r.__rxPedirBound = true;
    r.addEventListener('pointerdown', onDown);
    r.addEventListener('pointermove', onMove);
    r.addEventListener('pointerup', onUp);
    r.addEventListener('pointercancel', onUp);
    r.addEventListener('click', onClick);
  }

  // ── Traslado pedido (booked) ─────────────────────────────────────────────────
  function bookedHTML(t) {
    if (!t) {
      return `<div class="rx-scr rx-center rx-booked"><h1 class="rx-c-h">Traslado pedido</h1>`
        + `<p class="rx-c-p">Lo verás en tus viajes.</p>`
        + `<div class="rx-foot abs">${U() ? U().btn('Listo', { attrs: { 'data-ax': 'home' } }) : ''}</div></div>`;
    }
    const vip = t.level === 'private';
    const lle = t.type === 'lle';
    const scene = window.AuxCelebracion ? AuxCelebracion.sceneHTML(t) : (U() ? U().check() : '');
    const title = vip ? 'Solicitud enviada' : '¡Traslado pedido!';
    const lead = vip
      ? 'Tu privado quedó pedido. Coordinación confirma si la camioneta está libre a esa hora; la respuesta la verás en tu traslado.'
      : `Tu ${lle ? 'llegada' : 'salida'} quedó en la planeación del día. Cuando le asignen conductor, lo verás en tu traslado.`;
    let pass = '';
    try { if (window.AuxRxInicio && typeof AuxRxInicio.passHTML === 'function') pass = AuxRxInicio.passHTML(t) || ''; } catch (_) { pass = ''; }
    return `<div class="rx-scr rx-center rx-booked">`
      + scene
      + `<h1 class="rx-c-h axc-in">${esc(title)}</h1>`
      + `<p class="rx-c-p axc-in">${esc(lead)}</p>`
      + (pass ? `<div class="rx-booked-pass">${pass}</div>` : '')
      + `<div class="rx-foot abs">${U() ? U().btn('Listo', { attrs: { 'data-ax': 'home' } }) : ''}</div>`
      + `</div>`;
  }

  // ── Registro en el shell ─────────────────────────────────────────────────────
  function register() {
    const Sh = window.AuxShell;
    if (!Sh || typeof Sh.register !== 'function') return;
    Sh.register('book', {
      layer: 'modal',
      render() { return screenHTML(); },
      after() {
        bindOnce();
        const a = A();
        if (a && typeof a.afterForm === 'function') a.afterForm();
      },
      patch(ctx) {
        const ok = patchBook(ctx);
        if (ok) { const a = A(); if (a && typeof a.afterForm === 'function') a.afterForm(); }
        return ok;
      },
      destroy(ctx) {
        if (ctx && ctx.reason === 'leave') {
          cancelSlide();
          pv.step = null; pv.kind = null; pv.n = null;
          if (window.AuxResidencias) AuxResidencias.destroyMap();
        } else {
          pv.slide = null;
        }
      },
    });
    Sh.register('booked', {
      layer: 'full',
      render(ctx) { return bookedHTML(ctx && ctx.trip); },
      after(ctx) {
        bindOnce();
        try { if (window.AuxCelebracion && ctx && ctx.trip) AuxCelebracion.afterRender(ctx.trip); } catch (_) { /* */ }
      },
    });
    if (typeof Sh.action === 'function') {
      // «Cambiar» del resumen: por la misma entrada al paso que «Continuar» (#18).
      Sh.action('goto-step', (el) => {
        const a = A(); if (!a || typeof a.goStep !== 'function') return;
        a.goStep(el.getAttribute('data-step'));
      });
      const bags = (delta) => (el) => {
        const f = F();
        const v = Math.max(0, Math.min(3, (Number(f.bags) || 0) + delta));
        if (v === (Number(f.bags) || 0) && f.bags != null) return;
        f.bags = v;
        if (U()) U().stepCtlSet(el, v);
      };
      Sh.action('bags-dec', bags(-1));
      Sh.action('bags-inc', bags(1));
    }
  }
  register();

  window.AuxRxPedir = {
    fieldHTML, toggleHTML, flightField, syncCta, timeHintsHTML, flightAvisoHTML, refreshPinRow,
    screenHTML, bookedHTML,
    // Para pruebas y depuración: el último paso pintado.
    painted: () => ({ step: pv.step, kind: pv.kind, n: pv.n }),
  };
})();
