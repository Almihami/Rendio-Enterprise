// aux-rx-viaje.js — P4 · Viaje en vivo y calificar (rediseño del auxiliar, 27-sep-2026).
//
// Pinta las pantallas «trip» (viaje en vivo) y «rate» (calificar) del rediseño
// sobre el shell (AuxShell) con el marcado y las clases del diseño
// (rx-trip.jsx: RxTrip y RxRate). La LÓGICA no vive aquí: el rastreo, el HUD, el
// chat, la alarma, cancelar, confirmar y calificar son de auxiliar.js (PL) y se
// disparan con los mismos data-ax de siempre (§2.4). Este módulo solo:
//   · arma el HTML (ids fijos de §2.4 incluidos: ax-track-map, ax-eta-*, ax-count,
//     ax-wait, ax-late-wrap, ax-track-fresh, ax-onboard-badge, ax-chat*, ax-meet,
//     ax-phase, ax-alarm-text, ax-cancel-reason);
//   · resuelve por patch() lo que cambia SIN tumbar el mapa: la alarma y cancelar
//     (hojas en .rx-sheet-host), el chat, datos nuevos (conductor, carro, hora,
//     código), estrellas y etiquetas;
//   · devuelve false en patch() cuando cambia el estado del viaje: el shell
//     repinta y re-arranca el rastreo, y aquí se RECREA .rx-trip-big (key={st}
//     del diseño) para que su entrada corra otra vez.
//
// Estado honesto (plan final §3.7 y §1.6): nada inventado. Sin posición no hay
// carro; la ★ solo con 10 o más calificaciones; la hora de recogida solo si está
// publicada; cancelar no promete puntos ni reglas de horas; «Coordinación» sin
// nombre ni presencia.
//
// Contrato (lo que otros usan, siempre con guarda):
//   window.AuxRxViaje = {
//     chatHTML(t)            → el panel #ax-chat (oculto salvo que el chat esté abierto)
//     alarmHTML(t)           → el contenido de la hoja del botón rojo (#ax-alarm-text)
//     cancelHTML(t)          → el contenido de la hoja de cancelar (#ax-cancel-reason)
//     bubblesHTML(msgs, me)  → burbujas rx-bub (el admin como «Coordinación»)
//     setUnread(n)           → el globo del botón «Mensaje», sin repintar
//     tripHTML(t), rateHTML(t) → las pantallas (para pruebas y vistas previas)
//   }
// Pantallas registradas: 'trip', 'rate' y 'rate-sent' (gracias, capa completa).
// Acción data-rx registrada: 'rate-open' (data-id) → calificar ese viaje.
(function () {
  'use strict';

  const W = window;
  const UI = () => W.AuxRxUI || null;
  const AX = () => W.Auxiliar || null;
  const ST = () => (W.Auxiliar && W.Auxiliar.state) || {};

  // Tiempos del diseño (ANIMACIONES §4/§5): pop + push encadenados a los 280 ms.
  const T_CHAIN = 280;

  const CLOSED = ['done', 'cancelled', 'noshow'];
  // Los tres motivos del botón rojo: los mismos ids y textos de auxiliar.js
  // (AUX_ALARM), que es quien los envía.
  const ALARM = [
    { id: 'medica', label: 'Emergencia médica a bordo', icon: 'AlertTriangle' },
    { id: 'desembarque', label: 'Se va a demorar el desembarque', icon: 'Plane' },
    { id: 'otra', label: 'Otra cosa que me va a retrasar', icon: 'Clock' },
  ];
  // RxRate: etiquetas por calificación y el texto bajo las estrellas.
  const TAGS_OK = ['Puntual', 'Manejo seguro', 'Carro limpio', 'Amable', 'Buena música'];
  const TAGS_BAD = ['Llegó tarde', 'Manejo brusco', 'Carro sucio', 'No encontré el carro', 'Otro'];
  const RATE_L = ['', 'Muy mal', 'Mal', 'Regular', 'Bien', '¡Excelente!'];

  // Estado propio del módulo (nada de datos: solo qué está pintado).
  const M = {
    sheets: { alarm: null, cancel: null },     // hojas propias montadas en .rx-sheet-host
    chat: { trip: null, seen: new Set(), tmp: new Map(), pop: new Map(), wasOpen: false },
    last: { id: null, st: null },               // último viaje/estado pintado (key={st})
    prevSig: null,                              // firmas de bloques antes de un repintado
    rateSent: null,                             // {id, stars} al tocar «Enviar calificación»
  };

  // ── Utilidades ──────────────────────────────────────────────────────────────
  function esc(s) {
    const u = UI();
    if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s, cls, style) => { const u = UI(); return u && u.ic ? u.ic(n, s, cls, style) : ''; };
  const hm = (v) => { const u = UI(); return u && u.hm ? u.hm(v) : ''; };
  const dayLabel = (v) => { const u = UI(); try { return u && u.dayLabel ? u.dayLabel(v) : ''; } catch (_) { return ''; } };
  const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';
  const hasDrv = (t) => !!(t && t.driver && t.driver.name);
  const drvFirst = (t) => (hasDrv(t) ? (t.driver.first || firstOf(t.driver.name)) : '');
  const auxFirst = () => { const p = ST().profile; return firstOf(p && p.full_name); };
  const isLive = (t) => !!t && (t.status === 'onway' || t.status === 'onboard');
  const isClosed = (t) => !!t && CLOSED.includes(t.status);
  function btn(label, o) {
    const u = UI();
    return u && u.btn ? u.btn(label, o) : `<button type="button">${esc(label)}</button>`;
  }
  function attrsOf(o) {
    return Object.keys(o || {}).map(k => (o[k] == null ? '' : ` ${k}="${esc(o[k])}"`)).join('');
  }
  // «Hoy», «Mañana» o «El jue 15 oct» (día en Bogotá) para «… te recogemos».
  function dayWord(v) {
    const dl = dayLabel(v); if (!dl) return '';
    const i = dl.indexOf(' · ');
    return i > 0 ? dl.slice(0, i) : 'El ' + dl.charAt(0).toLowerCase() + dl.slice(1);
  }
  const joinDot = (...p) => p.filter(Boolean).join(' · ');
  // La placa real ('—' es el «sin dato» de lo heredado).
  function plateOf(t) {
    const p = (t && t.vehicle && t.vehicle.plate) || (t && t.driver && t.driver.plate) || '';
    return p && p !== '—' ? String(p) : '';
  }
  // «Marca Modelo · Color», omitiendo lo que no venga.
  function carText(t) {
    const v = (t && t.vehicle) || {};
    return [[v.brand, v.model].filter(Boolean).join(' '), v.color].filter(Boolean).join(' · ');
  }
  // ★ solo con 10 o más calificaciones (el servidor ya manda rating null si no).
  function hasStar(d) {
    return !!d && d.rating != null && d.rating !== '' && isFinite(Number(d.rating)) && Number(d.ratingN || 0) >= 10;
  }
  const fmtRating = (r) => Number(r).toFixed(1).replace('.', ',');
  // ¿El conductor ya llegó a mi punto? Lo último que dijo el rastreo manda.
  function arrivedNow(t) {
    const i = t && t._info;
    const s = i && i.stop_status != null ? i.stop_status : (t && t.stopStatus);
    return s === 'arrived';
  }
  function phasesOf(t) {
    const a = AX();
    try { if (a && typeof a.phases === 'function') return a.phases(t) || { steps: [], current: null, index: -1 }; } catch (_) {}
    return { steps: [], current: null, index: -1 };
  }
  function shortPlace(addr) { return String(addr || '').split(/\s*[·,]\s*/)[0] || 'Casa'; }

  // ── Viaje en vivo: bloques ──────────────────────────────────────────────────
  // La hora grande (valor inicial por estado; en camino/a bordo la actualiza el
  // HUD de auxiliar.js sin repintar).
  function heroOf(t) {
    const lle = t.type === 'lle', s = t.status, first = drvFirst(t) || 'Tu conductor';
    if (s === 'pending') {
      return ['Pedido', joinDot(dayLabel(t.date), t.time ? (lle ? 'aterrizas a las ' : 'en MDE a las ') + hm(t.time) : '')];
    }
    if (s === 'assigned') {
      if (t.pickupAt && hm(t.pickupAt)) return [hm(t.pickupAt), `${dayWord(t.pickupAt)} te recogemos${lle ? ' en MDE' : ''}`];
      return ['Por confirmar', 'Te avisamos cuando armemos tu ruta'];
    }
    if (s === 'onway') return arrivedNow(t) ? ['Llegó', `${first} te espera afuera`] : ['En camino', `${first} va por ti`];
    if (s === 'onboard') return ['En ruta', lle ? 'Vas a casa' : 'Vas al aeropuerto'];
    if (s === 'done') { const f = auxFirst(); return ['Llegaste', lle ? 'Ya estás en casa' : (f ? `Buen vuelo, ${f}` : 'Buen vuelo')]; }
    if (s === 'cancelled') return ['Cancelado', joinDot(dayLabel(t.date), hm(t.time))];
    if (s === 'noshow') return ['No abordaste', joinDot(dayLabel(t.date), hm(t.time))];
    return ['—', ''];
  }
  function bigHTML(t) {
    const [b, l] = heroOf(t);
    return `<div class="rx-trip-big"><b id="ax-eta-min"${b.length > 11 ? ' class="sm"' : ''}>${esc(b)}</b><span id="ax-eta-label">${esc(l)}</span></div>`;
  }
  // Lo que el HUD llena en cada tic. Arranca oculto/vacío: sin dato no hay nada.
  function hudHTML() {
    return '<div class="rx-trip-hud">'
      + '<div class="rx-trip-ob" id="ax-onboard-badge"></div>'
      + '<div class="rx-trip-eta hidden" id="ax-eta"></div>'
      + '<div class="rx-trip-count hidden" id="ax-count"></div>'
      + '<div class="ax-wait hidden" id="ax-wait"></div>'
      + '<div class="rx-trip-fresh" id="ax-track-fresh"></div>'
      + '</div>';
  }
  function lateHTML(t) {
    const a = AX(); let h = '';
    try { h = a && typeof a.lateHTML === 'function' ? (a.lateHTML(t) || '') : ''; } catch (_) { h = ''; }
    return `<div class="rx-trip-late" id="ax-late-wrap">${h}</div>`;
  }
  // Fases (#ax-phase): 6 en salida, 5 en llegada. El HUD mueve .done/.now.
  function phaseHTML(t) {
    if (t.status === 'cancelled' || t.status === 'noshow') return '';
    const ph = phasesOf(t);
    if (!ph.steps || !ph.steps.length) return '';
    return `<div class="rx-tl" id="ax-phase" data-now="${esc(ph.current || '')}" style="grid-template-columns:repeat(${ph.steps.length},1fr)">`
      + ph.steps.map((s, i) => `<div class="rx-tl-s${i < ph.index ? ' done' : i === ph.index ? ' now' : ''}" data-ph="${esc(s.key)}"><i></i><span>${esc(s.label)}</span></div>`).join('')
      + '</div>';
  }
  function tagText(t) {
    if (isLive(t)) return 'En vivo';
    if (t.status === 'cancelled') return 'Cancelado';
    if (t.status === 'noshow') return 'No abordaste';
    const ph = phasesOf(t);
    const cur = ph.steps && ph.index >= 0 ? ph.steps[ph.index] : null;
    return cur ? cur.label : '';
  }
  function tagHTML(t) {
    return `<span class="rx-live-tag glass">${isClosed(t) ? '' : '<i></i>'}${esc(tagText(t))}</span>`;
  }
  // Compartir: solo asignado con hora publicada, en camino o a bordo, y solo si
  // Auxiliar.shareText tiene algo cierto que contar.
  function shareOK(t) {
    const a = AX();
    if (!a || typeof a.shareText !== 'function') return false;
    const s = t.status;
    if (!(s === 'onway' || s === 'onboard' || (s === 'assigned' && t.pickupAt))) return false;
    try { return !!a.shareText(t); } catch (_) { return false; }
  }
  function shareHTML(t) {
    return shareOK(t)
      ? `<button type="button" class="rx-ib glass" data-ax="share-eta" aria-label="Compartir">${ic('Share', 19)}</button>`
      : '<span class="rx-ib-ph" aria-hidden="true"></span>';
  }
  // Código de encuentro: se pinta si meetVisible; el HUD lo resalta al «llegó».
  function meetSig(t) {
    const a = AX();
    let v = false;
    try { v = !!(t.meetCode && a && typeof a.meetVisible === 'function' && a.meetVisible(t, t._info)); } catch (_) { v = false; }
    return v ? `${t.meetCode}|${drvFirst(t)}` : '';
  }
  function meetHTML(t) {
    if (!meetSig(t)) return '';
    const on = arrivedNow(t);
    const digits = String(t.meetCode).split('').map((c, i) => `<b style="--k:${i}">${esc(c)}</b>`).join('');
    return `<div class="rx-meet rx-in${on ? ' is-arrived' : ''}" id="ax-meet" data-arrived="${on ? 1 : 0}">`
      + `<span>Código de encuentro</span><div class="rx-meet-c">${digits}</div>`
      + `<em>Díselo a ${esc(drvFirst(t) || 'tu conductor')} antes de subir</em></div>`;
  }
  function drvHTML(t) {
    if (t.status === 'cancelled' || t.status === 'noshow') return '';
    if (hasDrv(t)) {
      const d = t.driver, u = UI();
      const car = carText(t), plate = plateOf(t);
      const ini = d.initials || (u && u.initials ? u.initials(d.name) : '');
      const av = u && u.av ? u.av(ini, 'lg', null, { src: d.avatarUrl || null }) : '';
      return `<div class="rx-drv rx-in" style="--d:1">${av}`
        + `<div class="rx-drv-tx"><b>${esc(d.name)}</b>${car ? `<span>${esc(car)}</span>` : ''}${plate ? `<span class="rx-plate">${esc(plate)}</span>` : ''}</div>`
        + (hasStar(d) ? `<div class="rx-drv-r"><span class="rx-drv-st">${ic('Star', 13)}${fmtRating(d.rating)}</span></div>` : '')
        + '</div>';
    }
    if (isClosed(t)) return '';
    return '<div class="rx-assign rx-in"><span class="rx-pass-wait"><i></i></span>'
      + '<div><b>Estamos armando tu ruta</b><span>Te avisamos quién te recoge y a qué hora.</span></div></div>';
  }
  const unreadBadge = (n) => (n > 0 ? `<i class="rx-trip-unread">${n > 9 ? '9+' : n}</i>` : '');
  function actsHTML(t, n) {
    if (!hasDrv(t) || isClosed(t)) return '';
    return '<div class="rx-drv-acts rx-in" style="--d:2">'
      + `<button type="button" data-ax="call">${ic('Phone', 19)}Llamar</button>`
      + `<button type="button" data-ax="chat">${ic('MessageCircle', 19)}Mensaje${unreadBadge(n || 0)}</button>`
      + `<button type="button" data-rx="open-coord" data-id="${esc(t.id)}">${ic('Headset', 19)}Coordinación</button>`
      + '</div>';
  }
  // VUELO · EN MDE / ATERRIZA · NIVEL · MALETAS, sin celdas vacías.
  function infoHTML(t) {
    const lle = t.type === 'lle', cells = [];
    if (t.flight) cells.push(['Vuelo', t.flight]);
    if (t.time && hm(t.time)) cells.push([lle ? 'Aterriza' : 'En MDE', hm(t.time)]);
    const lv = t.level === 'private' ? 'Privado' : t.level === 'shared' ? 'Compartido' : '';
    if (lv) cells.push(['Nivel', lv]);
    if (t.bags != null && t.bags !== '') cells.push(['Maletas', String(t.bags)]);
    if (!cells.length) return '';
    return `<div class="rx-trip-info rx-in" style="--d:3;grid-template-columns:repeat(${cells.length},1fr)">`
      + cells.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') + '</div>';
  }
  function privHTML(t) {
    try { return W.AuxPrivado && typeof W.AuxPrivado.statusHTML === 'function' ? (W.AuxPrivado.statusHTML(t) || '') : ''; }
    catch (_) { return ''; }
  }
  function notesHTML(t) {
    const s = t.status;
    if (s === 'onboard') return `<div class="rx-note">${ic('Shield', 15)}<span>Tu viaje se comparte en vivo con Coordinación hasta que llegues.</span></div>`;
    if (s === 'cancelled') {
      return `<div class="rx-note">${ic('Info', 15)}<span>Este traslado fue cancelado.${t.cancelReason ? ` Motivo: <b>${esc(t.cancelReason)}</b>` : ''}</span></div>`;
    }
    if (s === 'noshow') {
      return `<div class="rx-note">${ic('Info', 15)}<span>El conductor te esperó en el punto y no pudo recogerte. Si fue un error, escríbele a Coordinación.</span></div>`
        + btn('Escribir a Coordinación', { kind: 'sec', icon: 'Headset', attrs: { 'data-rx': 'open-coord', 'data-id': t.id } });
    }
    return '';
  }
  // Pie: confirmar (o «sin novedad» en llegadas) + el botón rojo. Misma regla
  // que auxiliar.js: con conductor, o asignado sin confirmar.
  function ctaHTML(t) {
    if (isClosed(t)) return '';
    const lle = t.type === 'lle';
    const can = t.status === 'assigned' && !t.readyAt;
    if (!can && !hasDrv(t)) return '';
    const first = drvFirst(t);
    let left = '';
    if (can) left = btn(lle ? 'Sin novedad, bajo a tiempo' : 'Confirmar mi recogida', { icon: 'Check', attrs: { 'data-ax': 'confirm-pickup' } });
    else if (t.readyAt && t.status === 'assigned') {
      left = `<div class="rx-note">${ic('Check', 15)}<span>Ya confirmaste que estarás listo.${first ? ` ${esc(first)} lo ve en su ruta.` : ''}</span></div>`;
    }
    const alarm = left
      ? `<button type="button" class="rx-trip-alarm" data-ax="alarm" aria-label="Tengo una novedad" title="Tengo una novedad">${ic('AlertTriangle', 22)}</button>`
      : btn('Tengo una novedad', { kind: 'danger', icon: 'AlertTriangle', cls: 'rx-trip-alarm-w', attrs: { 'data-ax': 'alarm' } });
    return `<div class="rx-trip-cta rx-in" style="--d:4">${left}${alarm}</div>`;
  }
  function rateBtnHTML(t) {
    if (t.status !== 'done' || !hasDrv(t)) return '';
    if (t.rated) return `<div class="rx-note">${ic('Star', 15)}<span>Ya calificaste este viaje.</span></div>`;
    return btn('Calificar a ' + (drvFirst(t) || 'tu conductor'), { icon: 'Star', attrs: { 'data-rx': 'rate-open', 'data-id': t.id } });
  }
  function cancelBtnHTML(t) {
    return !isClosed(t) && ['pending', 'assigned', 'onway'].includes(t.status)
      ? '<button type="button" class="rx-cancel" data-ax="cancel-trip">Cancelar traslado</button>' : '';
  }

  // ── Chat con el conductor (#ax-chat, 0052/0067) ─────────────────────────────
  function chatHTML(t) {
    if (!t) return '';
    const d = t.driver || {};
    const plate = plateOf(t);
    const open = !!ST().chatOpen;
    return `<div class="rx-trip-chat${open ? '' : ' hidden'}" id="ax-chat" role="dialog" aria-label="Chat con tu conductor">`
      + '<div class="rx-head"><div class="rx-head-row">'
      + `<button type="button" class="rx-ib" data-ax="chat-close" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`
      + `<div class="rx-head-c">${plate ? `<span>Carro ${esc(plate)}</span>` : ''}<b>${esc(d.name || 'Tu conductor')}</b></div>`
      + `<div class="rx-head-r"><button type="button" class="rx-ib" data-ax="call" aria-label="Llamar">${ic('Phone', 19)}</button></div>`
      + '</div></div>'
      + '<div class="rx-body rx-chat" id="ax-chat-body" data-rx-scroll></div>'
      + '<div class="rx-trip-chat-foot">'
      + '<div class="rx-input"><input id="ax-chat-input" type="text" maxlength="500" placeholder="Escribe un mensaje…" autocomplete="off"></div>'
      + `<button type="button" class="rx-trip-send" data-ax="chat-send" aria-label="Enviar">${ic('Send', 19)}</button>`
      + '</div></div>';
  }
  function chatEmptyHTML() {
    return `<div class="rx-empty rx-trip-chat-empty">${ic('MessageCircle', 26)}<b>Escríbele a tu conductor</b>`
      + '<span>Sirve para lo que conviene que quede escrito: «portería 3, torre B», «salgo en 2 minutos». Si hay afán, llámalo.</span></div>';
  }
  // Burbujas del hilo. Al abrir el chat entran todas con .pop (como el diseño al
  // montar); después, solo las nuevas: el hilo se vuelve a pintar cada 5 s y las
  // que ya estaban no pueden volver a saltar.
  // auxiliar.js rehace TODO el hilo (innerHTML) justo después de abrirlo y al
  // confirmar un envío: una burbuja cuyo salto (rxBub .35 s) seguía en curso
  // se recrea con .pop y un animation-delay NEGATIVO igual a lo ya corrido, así
  // la animación continúa donde iba en vez de cortarse o repetirse.
  const BUB_MS = 350;
  const nowMs = () => ((W.performance && W.performance.now) ? W.performance.now() : Date.now());
  function bubblesHTML(msgs, me) {
    const ch = M.chat;
    const list = Array.isArray(msgs) ? msgs : [];
    const all = !ch.wasOpen;
    ch.wasOpen = true;
    if (!list.length) return chatEmptyHTML();
    const now = nowMs();
    const out = list.map(m => {
      const role = m && m.sender_role;
      const mine = role ? role === 'auxiliar' : !!(me && m && m.sender_id && m.sender_id === me);
      const coord = role === 'admin';
      const id = m && m.id != null ? String(m.id) : '';
      const sig = (role || '') + '|' + (m && m.body != null ? m.body : '');
      const tmp = id.indexOf('tmp') === 0;
      // La copia del servidor de una burbuja optimista hereda su salto.
      if (!tmp && id && !ch.pop.has(id) && ch.tmp.has(sig)) ch.pop.set(id, ch.tmp.get(sig));
      const fresh = all || (!ch.seen.has(id) && !(!tmp && ch.tmp.has(sig)));
      if (fresh && id) ch.pop.set(id, now);
      if (id) ch.seen.add(id);
      if (tmp) ch.tmp.set(sig, ch.pop.get(id) != null ? ch.pop.get(id) : now); else ch.tmp.delete(sig);
      const t0 = id ? ch.pop.get(id) : (fresh ? now : null);
      const run = t0 != null ? now - t0 : Infinity;
      const popping = run < BUB_MS;
      const delay = popping && run > 0 ? ` style="animation-delay:-${Math.round(run)}ms"` : '';
      const at = m && m.created_at ? hm(m.created_at) : '';
      return `<div class="rx-bub ${mine ? 'out' : 'in'}${popping ? ' pop rx-anim' : ''}"${delay}>`
        + (coord ? '<b>Coordinación</b>' : '')
        + `<span class="rx-bub-x">${esc(m && m.body)}</span>`
        + (at ? `<em class="rx-bub-t">${esc(at)}</em>` : '')
        + '</div>';
    });
    ch.pop.forEach((v, k) => { if (now - v > BUB_MS * 4) ch.pop.delete(k); });
    return out.join('');
  }
  // El globo del botón «Mensaje» sin repintar la pantalla.
  function setUnread(n) {
    n = Math.max(0, Number(n) || 0);
    document.querySelectorAll('#auxiliar-ui .rx-trip [data-ax="chat"]').forEach(b => {
      const i = b.querySelector('.rx-trip-unread');
      if (!n) { if (i) i.remove(); return; }
      const txt = n > 9 ? '9+' : String(n);
      if (i) { if (i.textContent !== txt) i.textContent = txt; }
      else b.insertAdjacentHTML('beforeend', unreadBadge(n));
    });
    // Con el chat cerrado, al volver a abrirlo las burbujas entran de nuevo. Con
    // el chat abierto (patch) no se toca: si no, el próximo sondeo de 5 s haría
    // saltar otra vez todo el hilo.
    if (!ST().chatOpen) M.chat.wasOpen = false;
  }

  // ── Hojas: botón rojo y cancelar (en .rx-sheet-host, por patch) ─────────────
  function alarmHTML(t) {
    const a = ST().alarm || {};
    const first = drvFirst(t);
    return '<div class="rx-sh rx-trip-alarm-sh">'
      + '<h3>¿Qué está pasando?</h3>'
      + `<p>Esto le llega de una vez a Coordinación${first ? ' y a ' + esc(first) : ''}.</p>`
      + '<div class="rx-trip-opts">' + ALARM.map(o => `<button type="button" class="rx-opt${a.motivo === o.id ? ' on' : ''}" data-ax="alarm-pick" data-v="${o.id}">`
        + `<span class="rx-opt-ic">${ic(o.icon, 18)}</span><span class="rx-opt-tx"><b>${esc(o.label)}</b></span><span class="rx-radio"><i></i></span></button>`).join('') + '</div>'
      + `<div class="rx-input rx-trip-ta"><textarea id="ax-alarm-text" rows="2" maxlength="400" placeholder="¿Algo más que debamos saber? (opcional)">${esc(a.text || '')}</textarea></div>`
      + btn(a.sending ? 'Enviando…' : 'Avisar ahora', { kind: 'danger', disabled: !!a.sending, attrs: { 'data-ax': 'alarm-send' } })
      + btn('Volver', { kind: 'ghost', attrs: { 'data-ax': 'alarm-close' } })
      + '</div>';
  }
  function cancelHTML() {
    return '<div class="rx-sh rx-trip-cancel-sh">'
      + '<h3>¿Cancelar este traslado?</h3>'
      + '<p>Si ya hay conductor asignado, le avisamos y sale de su ruta. No se puede deshacer.</p>'
      + '<div class="rx-input"><input id="ax-cancel-reason" type="text" maxlength="200" autocomplete="off" placeholder="Motivo (opcional): vuelo cancelado, cambio de horario…"></div>'
      + btn('Sí, cancelar', { kind: 'danger', attrs: { 'data-ax': 'cancel-do' } })
      + btn('Mantener mi traslado', { kind: 'ghost', attrs: { 'data-ax': 'cancel-abort' } })
      + '</div>';
  }
  const sheetHost = () => document.querySelector('#auxiliar-ui .rx-sheet-host');
  function mountSheet(kind, t) {
    const host = sheetHost(), u = UI();
    if (!host || !u || !u.sheet) return null;
    const box = document.createElement('div');
    box.innerHTML = u.sheet(kind === 'alarm' ? alarmHTML(t) : cancelHTML(t), { cls: 'rx-trip-sh' });
    const bg = box.firstElementChild;
    if (!bg) return null;
    bg.setAttribute('data-rx-own', kind);
    // Tocar el fondo = cerrar, por el MISMO camino que «Volver»: el estado de
    // auxiliar.js manda y patch() cierra la hoja con su animación.
    bg.addEventListener('click', (e) => { if (e.target === bg) dismissSheet(kind); });
    host.appendChild(bg);
    return bg;
  }
  function dismissSheet(kind) {
    const a = AX(), st = ST();
    if (!a) return;
    if (kind === 'alarm') {
      if (!st.alarm || st.alarm.sending) return;
      st.alarm = null;
    } else {
      if (!st.confirmingCancel) return;
      st.confirmingCancel = false;
    }
    if (typeof a.rerender === 'function') a.rerender();
  }
  function closeSheet(kind) {
    const bg = M.sheets[kind];
    M.sheets[kind] = null;
    if (!bg || !bg.isConnected) return;
    const u = UI();
    if (u && u.sheetClose) u.sheetClose(bg); else bg.remove();
  }
  const closeAllSheets = () => { closeSheet('alarm'); closeSheet('cancel'); };
  function updAlarm(bg) {
    const a = ST().alarm || {};
    bg.querySelectorAll('[data-ax="alarm-pick"]').forEach(b => {
      const on = b.getAttribute('data-v') === a.motivo;
      if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
    });
    const send = bg.querySelector('[data-ax="alarm-send"]');
    if (send) {
      send.disabled = !!a.sending;
      const txt = a.sending ? 'Enviando…' : 'Avisar ahora';
      if (send.textContent !== txt) send.textContent = txt;
    }
  }
  function syncSheets(t) {
    const st = ST();
    const want = { alarm: !!(t && st.alarm), cancel: !!(t && st.confirmingCancel && !isClosed(t)) };
    ['alarm', 'cancel'].forEach(kind => {
      let bg = M.sheets[kind];
      if (bg && (!bg.isConnected || bg.__rxClosing)) { M.sheets[kind] = bg = null; }
      if (!want[kind]) { if (bg) closeSheet(kind); return; }
      if (!bg) { M.sheets[kind] = mountSheet(kind, t); return; }
      if (kind === 'alarm') updAlarm(bg);
    });
  }

  // ── Pantalla del viaje ──────────────────────────────────────────────────────
  // Bloques que cambian con los datos sin cambiar de estado. Cada uno vive en un
  // contenedor .rx-blk (display:contents: no agrega caja ni hueco al flex), así
  // patch() puede cambiar uno sin tocar el resto ni lo que llena el HUD.
  const BLK = {
    tag: tagHTML, share: shareHTML, meet: meetHTML, drv: drvHTML,
    acts: (t) => actsHTML(t, Number(ST().chatUnread) || 0),
    info: infoHTML, priv: privHTML, notes: notesHTML, cta: ctaHTML, rate: rateBtnHTML, cancel: cancelBtnHTML,
    chat: (t) => (hasDrv(t) && !isClosed(t) ? chatHTML(t) : ''),
  };
  // Firma de cada bloque: su HTML, salvo el código (lo resalta el HUD) y el
  // globo de no leídos (setUnread) y el chat (se abre y cierra por clase).
  function blockSigs(t) {
    const s = {};
    Object.keys(BLK).forEach(k => {
      if (k === 'meet') s[k] = meetSig(t);
      else if (k === 'acts') s[k] = actsHTML(t, 0);
      else if (k === 'chat') s[k] = hasDrv(t) && !isClosed(t) ? `${t.driver.name}|${plateOf(t)}` : '';
      else s[k] = BLK[k](t);
    });
    return s;
  }
  const blk = (name, t, tag) => `<${tag || 'div'} class="rx-blk" data-rx-blk="${name}">${BLK[name](t)}</${tag || 'div'}>`;

  function tripHTML(t) {
    if (!t) {
      const u = UI();
      return '<div class="rx-scr">' + (u && u.head ? u.head({ title: 'Traslado' }) : '')
        + `<div class="rx-empty">${ic('Calendar', 26)}<b>No tienes un traslado activo</b></div></div>`;
    }
    const closed = isClosed(t);
    return `<div class="rx-scr rx-trip" data-rx-trip="${esc(t.id)}" data-st="${esc(t.status)}" data-type="${esc(t.type || '')}">`
      // Mapa: el Leaflet de auxiliar.js monta en #ax-track-map (en camino y a
      // bordo). Sin posición: el aviso honesto, hasta que aparezca el carro.
      + `<div class="rx-trip-map${closed ? ' is-closed' : ''}">`
      + (closed ? '' : `<div id="ax-track-map" class="rx-trip-lf"></div><div class="rx-trip-nopos">${ic('MapPin', 15)}<span>Sin ubicación todavía</span></div>`)
      + '</div>'
      + '<div class="rx-trip-top">'
      + `<button type="button" class="rx-ib glass" data-rx="rx-pop" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`
      + blk('tag', t, 'span') + blk('share', t, 'span')
      + '</div>'
      + '<div class="rx-trip-sheet" data-rx-scroll>'
      + '<div class="rx-grab"></div>'
      + bigHTML(t)
      + (closed ? '' : hudHTML() + lateHTML(t))
      + phaseHTML(t)
      + blk('meet', t) + blk('drv', t) + blk('acts', t) + blk('info', t) + blk('priv', t)
      + blk('notes', t) + blk('cta', t) + blk('rate', t) + blk('cancel', t)
      + '</div>'
      + blk('chat', t)
      + '</div>';
  }

  // Cambia solo los bloques cuya firma cambió. Un bloque que conserva su tipo de
  // elemento (rx-drv → rx-drv) entra quieto, como en React; uno que aparece o
  // cambia de tipo (rx-assign → rx-drv) entra con su animación.
  function syncBlocks(root, t) {
    const old = root.__rxSig || {};
    const now = blockSigs(t);
    Object.keys(BLK).forEach(name => {
      if (old[name] === now[name]) return;
      const el = root.querySelector(`[data-rx-blk="${name}"]`);
      if (!el) return;
      if (name === 'chat') {
        const p = el.querySelector('#ax-chat');
        if (p && !p.classList.contains('hidden')) return;   // abierto: no se le quita el campo
      }
      const prev = el.firstElementChild ? el.firstElementChild.className.split(' ')[0] : '';
      el.innerHTML = BLK[name](t);
      const nx = el.firstElementChild;
      if (nx) nx.classList.add(prev && nx.className.split(' ')[0] === prev ? 'rx-noanim' : 'rx-anim');
      old[name] = now[name];
    });
    root.__rxSig = old;
    setUnread(Number(ST().chatUnread) || 0);
    // La hora grande fuera de «en vivo» es de esta pantalla (el HUD no la toca):
    // si llega la hora publicada, se actualiza en su lugar.
    if (!isLive(t)) {
      const [b, l] = heroOf(t);
      const be = root.querySelector('#ax-eta-min'), le = root.querySelector('#ax-eta-label');
      if (be && be.textContent !== b) { be.textContent = b; be.classList.toggle('sm', b.length > 11); }
      if (le && le.textContent !== l) le.textContent = l;
    }
  }

  function tripPatch(ctx) {
    const t = ctx.trip;
    const root = ctx.host && ctx.host.querySelector('.rx-trip');
    if (!t || !root) return false;
    // Otro viaje u otro estado: repintado completo (el shell re-arranca el rastreo).
    if (root.getAttribute('data-rx-trip') !== String(t.id) || root.getAttribute('data-st') !== t.status) return false;
    if (!ST().chatOpen) M.chat.wasOpen = false;
    syncBlocks(root, t);
    syncSheets(t);
    return true;
  }
  function tripAfter(ctx) {
    const t = ctx.trip;
    const root = ctx.host && ctx.host.querySelector('.rx-trip');
    if (!t || !root) { closeAllSheets(); M.last = { id: null, st: null }; return; }
    const prevSig = M.prevSig; M.prevSig = null;
    root.__rxSig = blockSigs(t);
    if (M.chat.trip !== t.id) M.chat = { trip: t.id, seen: new Set(), tmp: new Map(), pop: new Map(), wasOpen: false };
    if (!ST().chatOpen) M.chat.wasOpen = false;
    // key={st}: el estado cambió con la pantalla a la vista → la hora grande se
    // RECREA (su rxRise corre otra vez) y lo que no estaba entra con su animación.
    if (ctx.reason === 'repaint' && M.last.id === t.id && M.last.st && M.last.st !== t.status) {
      const u = UI();
      const big = root.querySelector('.rx-trip-big');
      if (big && u && u.remount) u.remount(big);
      if (prevSig && u && u.remount) {
        Object.keys(BLK).forEach(k => {
          if (k === 'chat' || prevSig[k] || !root.__rxSig[k]) return;
          const el = root.querySelector(`[data-rx-blk="${k}"]`);
          const first = el && el.firstElementChild;
          if (first) u.remount(first);
        });
      }
    }
    M.last = { id: t.id, st: t.status };
    const a = AX();
    if (a && typeof a.afterTrip === 'function') { try { a.afterTrip(); } catch (e) { console.error('[AuxRxViaje] afterTrip falló:', e); } }
    syncSheets(t);
  }

  // ── Calificar (RxRate) ──────────────────────────────────────────────────────
  function canRate(t) {
    const a = AX();
    if (!t) return false;
    try { if (a && typeof a.showRate === 'function') return !!a.showRate(t); } catch (_) {}
    return t.status === 'done' && !t.rated && hasDrv(t);
  }
  function chipsHTML(s, tags, anim) {
    const TG = s >= 4 ? TAGS_OK : TAGS_BAD;
    return `<div class="rx-chips center rx-in${anim ? ' rx-anim' : ''}" data-rx-set="${s >= 4 ? 'ok' : 'bad'}">`
      + TG.map(x => `<button type="button"${tags.includes(x) ? ' class="on"' : ''} data-ax="tag" data-tag="${esc(x)}">${esc(x)}</button>`).join('')
      + '</div>';
  }
  function rateHTML(t) {
    const u = UI();
    if (!t || !u) return tripHTML(t);
    const d = t.driver || {};
    const st = ST();
    const s = Number(st.ratingSel) || 0;
    const tags = Array.isArray(st.ratingTags) ? st.ratingTags : [];
    const lle = t.type === 'lle';
    const home = shortPlace(t.address);
    const route = `${lle ? 'MDE' : home} → ${lle ? home : 'MDE'}${t.droppedAt && hm(t.droppedAt) ? ' · llegaste a las ' + hm(t.droppedAt) : ''}`;
    return `<div class="rx-scr rx-rate-scr" data-rx-trip="${esc(t.id)}" data-s="${s}">`
      + u.head({ back: false, right: '<button type="button" class="rx-link" data-ax="rate-skip">Ahora no</button>' })
      + '<div class="rx-body rx-rate">'
      + u.av(d.initials || u.initials(d.name), 'xl', null, { src: d.avatarUrl || null })
      + `<h1>¿Cómo te fue con ${esc(drvFirst(t) || 'tu conductor')}?</h1>`
      + `<p>${esc(route)}</p>`
      + '<div class="rx-stars">' + [1, 2, 3, 4, 5].map(k => `<button type="button"${k <= s ? ' class="on"' : ''} style="--k:${k}" data-ax="star" data-n="${k}" aria-label="${k} de 5">${ic('Star', 38)}</button>`).join('') + '</div>'
      + `<div class="rx-rate-l">${esc(RATE_L[s] || 'Toca una estrella')}</div>`
      + (s > 0 ? chipsHTML(s, tags, false) : '')
      + '</div>'
      + `<div class="rx-foot">${btn('Enviar calificación', { disabled: !s, attrs: { 'data-ax': 'rate-send' } })}</div>`
      + '</div>';
  }
  function ratePatch(ctx) {
    const t = ctx.trip, u = UI();
    const root = ctx.host && ctx.host.querySelector('.rx-rate-scr');
    if (!t || !root || !u || root.getAttribute('data-rx-trip') !== String(t.id)) return false;
    const st = ST();
    const s = Number(st.ratingSel) || 0;
    const tags = Array.isArray(st.ratingTags) ? st.ratingTags : [];
    // Estrellas: la que se enciende salta (rxStar con su --k); las que ya
    // estaban encendidas no vuelven a saltar, como en React.
    root.querySelectorAll('.rx-stars [data-n]').forEach(b => {
      const on = Number(b.getAttribute('data-n')) <= s;
      if (b.classList.contains('on') === on) return;
      if (on) { b.classList.add('on', 'rx-anim'); } else { b.classList.remove('on', 'rx-anim'); }
    });
    // key={s}: el texto bajo las estrellas se RECREA.
    if (root.getAttribute('data-s') !== String(s)) {
      const l = root.querySelector('.rx-rate-l');
      if (l) u.remount(l, esc(RATE_L[s] || 'Toca una estrella'));
    }
    const body = root.querySelector('.rx-rate');
    let chips = root.querySelector('.rx-chips');
    const set = s >= 4 ? 'ok' : 'bad';
    if (s > 0 && !chips && body) {
      body.insertAdjacentHTML('beforeend', chipsHTML(s, tags, true));
    } else if (s > 0 && chips && chips.getAttribute('data-rx-set') !== set) {
      const tpl = document.createElement('div');
      tpl.innerHTML = chipsHTML(s, tags, false);
      chips.innerHTML = tpl.firstElementChild.innerHTML;
      chips.setAttribute('data-rx-set', set);
    } else if (s === 0 && chips) chips.remove();
    chips = root.querySelector('.rx-chips');
    if (chips) chips.querySelectorAll('[data-tag]').forEach(b => b.classList.toggle('on', tags.includes(b.getAttribute('data-tag'))));
    const send = root.querySelector('[data-ax="rate-send"]');
    if (send) send.disabled = !s;
    root.setAttribute('data-s', String(s));
    return true;
  }
  // Gracias (el «sent» de RxRate): capa completa encima de Inicio, texto honesto.
  function rateSentHTML() {
    const u = UI();
    const f = auxFirst();
    return '<div class="rx-scr rx-center">'
      + (u && u.check ? u.check('ok') : '')
      + `<h1 class="rx-c-h">${esc(f ? `Gracias, ${f}` : 'Gracias')}</h1>`
      + '<p class="rx-c-p">Tu calificación le llega a la operación.</p>'
      + `<div class="rx-foot abs">${btn('Volver al inicio', { attrs: { 'data-rx': 'rx-tab', 'data-tab': 'inicio' } })}</div>`
      + '</div>';
  }
  // «Calificar a {first}» / «Calificar» desde otra pantalla (data-rx="rate-open").
  // Con el viaje abierto, como el diseño: se cierra y a los 280 ms entra Calificar.
  function rateOpen(el) {
    const a = AX(); if (!a || typeof a.openTrip !== 'function') return;
    const st = ST();
    const id = (el && el.getAttribute && el.getAttribute('data-id')) || st.editingTrip;
    if (!id) return;
    if (st.view === 'trip' && st.editingTrip === id && typeof a.back === 'function') {
      a.back();
      setTimeout(() => a.openTrip(id, { rate: true }), T_CHAIN);
      return;
    }
    a.openTrip(id, { rate: true });
  }

  // ── Registro en el shell ────────────────────────────────────────────────────
  // 'trip' y 'rate' comparten definición: 'rate' pinta el viaje si ya no toca
  // calificar («Ahora no» o ya calificado), con su botón «Calificar a {first}».
  function modeOf(ctx) { return ctx.id === 'rate' && canRate(ctx.trip) ? 'rate' : 'trip'; }
  function paintedOf(ctx) {
    const h = ctx.host;
    if (!h) return 'none';
    if (h.querySelector('.rx-rate-scr')) return 'rate';
    if (h.querySelector('.rx-trip')) return 'trip';
    return 'none';
  }
  function watchRateSend(ctx) {
    const el = ctx.el;
    if (!el || el.__rxRateWatch) return;
    el.__rxRateWatch = true;
    // Antes que el oyente de auxiliar.js (está en la raíz): se anota que la
    // persona envió, para mostrar el «gracias» cuando la capa se vaya.
    el.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-ax="rate-send"]') : null;
      if (!b || b.hasAttribute('disabled')) return;
      const tripEl = el.querySelector('.rx-rate-scr');
      M.rateSent = tripEl ? { id: tripEl.getAttribute('data-rx-trip'), stars: Number(ST().ratingSel) || 0 } : null;
    });
  }
  function makeDef(id) {
    return {
      render(ctx) { return modeOf(ctx) === 'rate' ? rateHTML(ctx.trip) : tripHTML(ctx.trip); },
      after(ctx) {
        if (modeOf(ctx) === 'rate') { closeAllSheets(); watchRateSend(ctx); return; }
        tripAfter(ctx);
      },
      patch(ctx) {
        const m = modeOf(ctx);
        if (m !== paintedOf(ctx)) return false;
        return m === 'rate' ? ratePatch(ctx) : tripPatch(ctx);
      },
      destroy(ctx) {
        const root = ctx.host && ctx.host.querySelector('.rx-trip');
        if (ctx.reason !== 'leave') {
          // Repintado: las hojas se quedan (after() las pone al día) y se guardan
          // las firmas para animar lo que aparezca con el nuevo estado.
          M.prevSig = root && root.__rxSig ? Object.assign({}, root.__rxSig) : null;
          return;
        }
        closeAllSheets();
        M.chat.wasOpen = false;
        if (id === 'rate' && M.rateSent) {
          const sent = M.rateSent; M.rateSent = null;
          const t = (ST().trips || []).find(x => x && String(x.id) === String(sent.id));
          const sh = W.AuxShell;
          if (t && t.rated && sh && typeof sh.push === 'function') {
            setTimeout(() => { try { sh.push('rate-sent', { tripId: sent.id, stars: sent.stars }); } catch (_) {} }, 0);
          }
        }
      },
    };
  }

  W.AuxRxViaje = { chatHTML, alarmHTML, cancelHTML, bubblesHTML, setUnread, tripHTML, rateHTML };

  const SH = W.AuxShell;
  if (SH && typeof SH.register === 'function') {
    SH.register('trip', makeDef('trip'));
    SH.register('rate', makeDef('rate'));
    SH.register('rate-sent', { layer: 'full', render: rateSentHTML });
    if (typeof SH.action === 'function') SH.action('rate-open', rateOpen);
  }
})();
