// admin-whatsapp.js — El plan del día, en el formato de WhatsApp del jefe.
//
// POR QUÉ EXISTE. Julián (jefe de operación) recibe y devuelve la programación
// de rutas en texto plano de WhatsApp. El formato está escrito en
// rendio-backend/scripts/planes-jefe/FORMATO.md y el backend ya lo escribe
// (rendio-backend/scripts/plan-a-whatsapp.mjs, a partir del JSON de
// plan-del-dia.mjs). Esto hace lo mismo desde la pantalla de Asignación: lo que
// está en el tablero, tal cual, listo para pegar en el chat. Transcribir la
// pantalla a mano es justo lo que no tiene que pasar.
//
// CONTRATO (window.RendioWhatsApp):
//   · texto({ carros })  → string con el plan cargado en Asignación, o '' si no
//                          hay plan. `carros: true` antepone «[R01] » a la primera
//                          línea de cada vuelta (= plan-a-whatsapp.mjs --carros).
//   · abrir()            → modal con el texto (solo lectura), «Copiar» y
//                          «Abrir WhatsApp». Sin plan, el modal dice por qué.
//   · cerrar()
//   · plan()             → el plan con la MISMA forma del JSON de plan-del-dia.mjs
//                          (null si no hay). La prueba se lo pasa al generador
//                          del backend para comprobar que los dos dicen lo mismo.
//   · formatear(plan, { carros }) → el texto de un plan con esa forma.
//
// DE DÓNDE LEE. Del estado en memoria de admin-rutas.js (`rt`, ámbito global
// compartido), nunca de la BD:
//   rt.day, rt.cars[].id, rt.aux{id → n, zona, dl, type, vuelo, hotel, tierra},
//   rt.lanes[] (id, car, vuelta, type, start), rt.order[lane.id] (las paradas EN
//   ORDEN), rt.pool (sin rutear), rt.AIRPORT_BUFFER y rt.diaLentoNombre /
//   esDiaLento / HOLIDAY_SHIFT.
//   La hora de cada parada y el «deben estar» NO se recalculan aquí: salen de
//   rtCarCompute(), la misma función que pinta el tablero (stops[].eta y
//   hardDL), y se arman con la misma receta de plan-del-dia.mjs. Si el solver
//   cambia, el mensaje cambia con él: el papel dice lo mismo que la pantalla.
//
// LO QUE NO SE ESCRIBE: «Va a hotel». En el tablero `hotel` es la PERNOCTA
// (reservations.is_overnight: duerme fuera de Rionegro), no el destino. El
// generador del backend tampoco lo escribe por eso mismo —Julián ya lo cazó:
// "no sé por qué puso que iba a hotel, Juan Martínez LLEGA"—. El modal sí
// avisa a quiénes el tablero pinta «Hotel», para que él lo agregue si va.
//
// Botón: #rt-waBtn en la barra de Asignación (index.html). La v2 de esa
// pantalla llama RendioWhatsApp.abrir() desde el suyo.
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  // FORMATO — port fiel de rendio-backend/scripts/plan-a-whatsapp.mjs.
  // Los porqués de cada regla están allá, con fecha y caso; aquí solo lo
  // indispensable. Si se cambia una regla, se cambia en los dos lados
  // (_smoke-whatsapp-dom.mjs compara la salida de ambos).
  // ════════════════════════════════════════════════════════════════════
  const rwaMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
  // Hora como la escribe él: 3:10, no 03:10. Envuelve en 24 h (un «deben estar»
  // de las 00:05 menos el colchón es 23:55, no "-1:55").
  const rwaHM = (t) => { const x = ((t % 1440) + 1440) % 1440; return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
  // Recogida: múltiplo de 5 hacia ABAJO, la misma hora que muestra y publica el
  // tablero (rtCita en admin-rutas.js; el porqué está allá).
  const rwaSuave = (hm) => rwaHM(Math.floor(rwaMin(hm) / 5) * 5);
  // La hora de un suelto: en una salida la recogida estimada, redonda como las
  // demás; en una llegada (o sin estimación) la hora tal cual.
  const rwaHoraSuelto = (v) => (v.eta ? rwaSuave(v.eta) : rwaCrudo(v.dl));
  // Hora exacta (vuelos, sin carro): solo se le quita el cero de la izquierda.
  const rwaCrudo = (hm) => `${Number(String(hm).split(':')[0]) % 24}:${String(hm).split(':')[1]}`;
  // «Deben estar» = presentación − colchón del aeropuerto, hacia ABAJO a múltiplo
  // de 5 (Julián, 17-ago: "presentación 15:55, el vehículo por más tardar debe
  // llegar 15:45").
  const rwaDeben = (hm, colchon) => rwaHM(Math.floor((rwaMin(hm) - colchon) / 5) * 5);

  // La sigla de la aerolínea: el jefe siempre escribe AV/JA/P5.
  //   1xxx · 2xxx · 8xxx · 9xxx → AV · 5xxx → JA · 7xxx → P5 · 2-3 dígitos → AV
  // «Reserva» / «No aplica» no son vuelos (null). «J6» es como la tripulación
  // teclea JetSmart: se escribe JA.
  function rwaSigla(v) {
    if (!v) return 'Aero';
    const s = String(v).trim();
    if (/^[a-z]/i.test(s)) {
      if (/^reserva/i.test(s) || /^n\s*\/?\s*a$|^no\s*aplica/i.test(s) || /^ningun/i.test(s)) return null;
      const j6 = s.replace(/\s+/g, '').match(/^j6\s*(\d{4})$/i);
      if (j6) return 'JA' + j6[1];
      return s.toUpperCase().replace(/\s+/g, '');
    }
    const n = s.replace(/^0+(?=\d)/, '');
    if (!/^\d{2,4}$/.test(n)) return n;
    if (n.length <= 3) return 'AV' + n;
    return (n[0] === '7' ? 'P5' : n[0] === '5' ? 'JA' : 'AV') + n;
  }

  // "Erika, Jolene y Juanita" — el nombre tal como lo escribió la persona; solo
  // se limpian los espacios de más.
  const rwaLimpio = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
  const rwaListar = (ns0) => {
    const ns = ns0.map(rwaLimpio);
    return ns.length === 1 ? ns[0] : ns.slice(0, -1).join(', ') + ' y ' + ns[ns.length - 1];
  };

  // Orden del mensaje: la PRIMERA hora que va a leer quien lo recibe (en una
  // llegada, el vuelo más temprano; en una salida, la primera recogida; un
  // suelto, la hora que se imprime).
  const rwaOrden = (v) => v.sinCarro ? rwaMin(v.tipo === 'lle' ? v.dl : (v.eta || v.dl))
    : v.tipo === 'lle'
      ? Math.min(...v.paradas.flatMap((p) => p.personas.map((q) => rwaMin(q.dl))))
      : rwaMin(v.paradas[0].eta);

  function rwaFormatear(plan, opts) {
    if (!plan) return '';
    const conCarro = !!(opts && opts.carros);
    const L = [];
    // Los que no caben van DENTRO del itinerario, en la hora que les toca, con
    // el paréntesis que pidió él ("que nos ponga un paréntesis de que quizás no
    // haya carro").
    const sueltos = (plan.sinRutear || []).map((s) => Object.assign({}, s, { sinCarro: true }));
    const bloques = [...(plan.vueltas || []), ...sueltos].sort((a, b) => rwaOrden(a) - rwaOrden(b));
    const nCarros = (plan.carros || []).length;

    L.push(`Programación ${plan.dia} · ${plan.traslados} traslados (${plan.salidas} salidas + ${plan.llegadas} llegadas) · ${nCarros} carros`);
    if (plan.diaLento) L.push(plan.diaLentoShift
      ? `${plan.diaLento} — se recoge ${plan.diaLentoShift} min más tarde de lo normal`
      : `${plan.diaLento} — programado como día normal (falta definir cuánto más tarde sacarlos)`);
    L.push('');

    // Madrugada (20-oct-2026): lo que arranca antes del corte (02:00) es el cierre
    // del turno PM del día anterior; él lo escribe al final de ESE día. Aquí vive
    // en el plan de hoy, así que va primero pero con su rótulo, para que no se
    // lea como la primera vuelta del día. Sin corte en el plan, como siempre.
    const corte = plan.corteMadrugada;
    const esMad = (v) => corte != null && (v.sinCarro ? rwaOrden(v) : rwaMin(v.sale)) < corte;
    const hayMad = bloques.some(esMad), hayDia = bloques.some((v) => !esMad(v));
    if (hayMad) L.push(`— Madrugada: cierre del turno PM del ${plan.diaAnterior || 'día anterior'} —`, '');
    let rotuloDia = !hayMad || !hayDia;
    for (const v of bloques) {
      if (!rotuloDia && !esMad(v)) { L.push(`— ${plan.diaNombre || 'El día'} desde las ${rwaCrudo(rtToHM(corte))} —`, ''); rotuloDia = true; }
      const etiqueta = conCarro ? `[${v.carro}] ` : '';
      if (v.sinCarro) {
        // Salida: la hora de RECOGIDA estimada (eta), no la presentación.
        L.push(`${rwaHoraSuelto(v)} ${v.n} (${v.zona}) (QUIZÁS NO HAYA CARRO)`);
        L.push('');
        continue;
      }
      if (v.tipo === 'lle') {
        // LLEGADA: una línea por VUELO (hora de aterrizaje + número); los del
        // mismo vuelo y la misma hora van juntos. Los de reserva sin vuelo, «Aero R».
        const porVuelo = new Map();
        for (const p of v.paradas) for (const q of p.personas) {
          const sg = q.vuelo ? rwaSigla(q.vuelo) : null;
          const donde = sg || (q.hotel ? 'Aero R' : 'Aero');
          const k = `${q.dl}|${donde}`;
          if (!porVuelo.has(k)) porVuelo.set(k, { hora: q.dl, vuelo: donde, gente: [] });
          porVuelo.get(k).gente.push(q.n);
        }
        let primera = true;
        for (const { hora, vuelo, gente } of [...porVuelo.values()].sort((a, b) => rwaMin(a.hora) - rwaMin(b.hora))) {
          L.push(`${etiqueta && primera ? etiqueta : ''}${rwaCrudo(hora)} ${rwaListar(gente)} (${vuelo})`);
          primera = false;
        }
      } else {
        // SALIDA: una línea por parada con la hora de recogida, y el deadline.
        let primera = true;
        let pax = 0;
        for (const p of v.paradas) {
          const gente = p.personas.map((q) => q.n);
          pax += gente.length;
          L.push(`${etiqueta && primera ? etiqueta : ''}${rwaSuave(p.eta)} ${rwaListar(gente)} (${p.zona})`);
          primera = false;
        }
        const colchon = plan.ajustes && plan.ajustes.colchonAeropuerto != null ? plan.ajustes.colchonAeropuerto : 10;
        L.push(`${pax > 1 ? 'Deben' : 'Debe'} estar ${rwaDeben(v.presentacion, colchon)}`);
      }
      L.push('');
    }

    if (plan.sinRutear && plan.sinRutear.length) {
      L.push(`(${plan.sinRutear.length} marcados "quizás no haya carro" — con ${nCarros} carros no alcanzan)`);
    }
    // Los que el generador del formulario no pudo programar (el tablero no los
    // produce, pero el formato es el mismo y se respeta entero).
    const pendientes = [];
    if (plan.faltaPin && plan.faltaPin.length) pendientes.push(`Sin programar, nos falta la coordenada de la casa: ${plan.faltaPin.join(' · ')}`);
    if (plan.sinCasa && plan.sinCasa.length) pendientes.push(`Sin programar, no sabemos dónde vive: ${plan.sinCasa.join(' · ')}`);
    if (plan.ambiguos && plan.ambiguos.length) pendientes.push(`Sin programar, no sabemos quién es (el nombre empata con dos personas): ${plan.ambiguos.join(' · ')}`);
    if (plan.habituales && plan.habituales.length) pendientes.push(`Suelen ir y hoy el formulario no los trae — ¿van?: ${plan.habituales.join(' · ')}`);
    if (pendientes.length) { L.push(''); pendientes.forEach((l) => L.push(l)); }
    return L.join('\n').replace(/\s+$/, '');
  }

  // ════════════════════════════════════════════════════════════════════
  // LECTURA DEL TABLERO — `rt` de admin-rutas.js → plan con la forma del JSON
  // de plan-del-dia.mjs (misma receta, línea por línea).
  // ════════════════════════════════════════════════════════════════════
  const rwaHay = () => typeof rt !== 'undefined' && rt && typeof rtCarCompute === 'function'
    && typeof rtStopKey === 'function' && typeof rtToHM === 'function' && typeof rtToMin === 'function';

  function rwaVuelta(l) {
    const c = rtCarCompute(l.id);
    const paradas = [];
    c.stops.forEach((s) => {
      const a = rt.aux[s.id];
      if (!a) return;
      const ult = paradas[paradas.length - 1];
      const k = rtStopKey(s.id);
      const p = { n: a.n, dl: a.dl, vuelo: a.vuelo || '', hotel: !!a.hotel, tierra: !!a.tierra };
      // Los de la misma portería son UNA parada: "Sofía y José (Cámbulo)".
      if (ult && ult.key === k) { ult.personas.push(p); return; }
      paradas.push({ key: k, zona: a.zona, eta: rtToHM(s.eta), personas: [p] });
    });
    // Las vueltas que nacen vacías (rtLoad) o armadas a mano no traen `type`:
    // rtCarCompute las trata como salida, y aquí también.
    const tipo = l.type === 'lle' ? 'lle' : 'sal';
    return {
      id: l.id, carro: l.car, vuelta: l.vuelta, tipo, sale: l.start || '00:00',
      presentacion: tipo === 'sal' && c.hardDL != null && isFinite(c.hardDL) ? rtToHM(c.hardDL) : null,
      paradas,
    };
  }

  // Hora de recogida ESTIMADA de alguien sin carro, con el mismo modelo de las
  // vueltas (como plan-desde-formulario.mjs). Sin esto el renglón llevaba la
  // presentación: "puso a Jolene a las 15:04 de recogida, y a esa hora tiene
  // que estar en el aeropuerto" (Julián, 18-ago).
  function rwaEtaSuelto(a, id) {
    if (a.type !== 'sal') return null;
    try {
      const { dur, hastaUltima } = rtTripParts([id], null);
      const llegar = rtToMin(a.dl) - (Number(rt.AIRPORT_BUFFER) || 10);
      return rtToHM(Math.max(0, llegar - rtDurProg([id], llegar, dur, hastaUltima)));
    } catch (_) { return null; }
  }

  // → { plan, motivo, sinRutear, hotel, total }
  //   motivo: null | 'sin-tablero' | 'sin-carros' | 'sin-traslados' | 'sin-armar' | 'error'
  function rwaLeer() {
    if (!rwaHay()) return { plan: null, motivo: 'sin-tablero', sinRutear: [], hotel: [], total: 0 };
    const aux = rt.aux || {};
    const ids = Object.keys(aux);
    const hotel = ids.filter((id) => aux[id] && aux[id].hotel).map((id) => rwaLimpio(aux[id].n));
    if (!ids.length) {
      return { plan: null, motivo: rt.emptyReason === 'vehiculos' ? 'sin-carros' : 'sin-traslados', sinRutear: [], hotel, total: 0 };
    }
    const order = rt.order || {};
    const conParadas = (rt.lanes || []).filter((l) => (order[l.id] || []).length);
    // Nadie en ningún carro = el plan no está armado. Imprimir a todos con
    // «QUIZÁS NO HAYA CARRO» diría que faltan carros cuando lo que falta es
    // pulsar Optimizar.
    if (!conParadas.length) return { plan: null, motivo: 'sin-armar', sinRutear: [], hotel, total: ids.length };
    try {
      const vueltas = conParadas.map(rwaVuelta).filter((v) => v.paradas.length)
        .sort((a, b) => rtToMin(a.sale) - rtToMin(b.sale));
      // Sin rutear = todo el que no va en un carro, en el orden del pool. Se mira
      // contra las vueltas y no solo contra rt.pool: que alguien se caiga del
      // mensaje en silencio es peor que dejarlo sin carro.
      const enCarro = new Set(conParadas.flatMap((l) => order[l.id]));
      const pool = [];
      (rt.pool || []).concat(ids).forEach((id) => {
        if (aux[id] && !enCarro.has(id) && !pool.includes(id)) pool.push(id);
      });
      const sinRutear = pool.map((id) => {
        const a = aux[id];
        return { n: a.n, zona: a.zona, dl: a.dl, eta: rwaEtaSuelto(a, id), tipo: a.type === 'lle' ? 'lle' : 'sal' };
      });
      const salidas = ids.filter((id) => aux[id].type !== 'lle').length;
      const plan = {
        dia: rt.day || '',
        // Para rotular la madrugada (cierre del turno PM del día anterior).
        corteMadrugada: typeof rtCut === 'function' ? rtCut() : null,
        diaAnterior: typeof rtDiaAnterior === 'function' ? rtDiaAnterior() : null,
        diaNombre: rwaDiaNombre(rt.day),
        traslados: ids.length, salidas, llegadas: ids.length - salidas,
        carros: (rt.cars || []).map((c) => ({ id: c.id, cupo: c.capacity || rt.CAP })),
        ajustes: { colchonAeropuerto: rt.AIRPORT_BUFFER != null ? Number(rt.AIRPORT_BUFFER) : 10 },
        diaLento: rt.diaLentoNombre || null,
        diaLentoShift: rt.esDiaLento ? (Number(rt.HOLIDAY_SHIFT) || 0) : 0,
        vueltas, sinRutear,
      };
      return { plan, motivo: null, sinRutear, hotel, total: ids.length };
    } catch (e) {
      return { plan: null, motivo: 'error', error: (e && e.message) || String(e), sinRutear: [], hotel, total: ids.length };
    }
  }

  function rwaDiaNombre(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    if (!m) return null;
    return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  }
  const rwaTexto = (opts) => { const r = rwaLeer(); return r.plan ? rwaFormatear(r.plan, opts) : ''; };

  // ════════════════════════════════════════════════════════════════════
  // MODAL
  // ════════════════════════════════════════════════════════════════════
  // Ícono monocromo (burbuja + auricular), dibujado aquí: sin logo de marca.
  const RWA_ICONO = '<svg class="rwa-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3.5 20.5l1.2-4.3A8.4 8.4 0 1 1 8 19.4z"/>'
    + '<path fill="currentColor" stroke="none" d="M9.1 7.6c.3-.3.8-.3 1 .1l.9 1.6c.2.3.1.7-.1 1l-.6.6c.6 1.3 1.6 2.3 2.9 2.9l.6-.6c.3-.2.7-.3 1-.1l1.6.9c.4.2.4.7.1 1l-.7.7c-.6.6-1.5.8-2.3.5-2.4-.9-4.3-2.8-5.2-5.2-.3-.8-.1-1.7.5-2.3z"/></svg>';
  const RWA_X = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const RWA_COPIA = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const RWA_MAX_LISTA = 6;   // «lista corta» de sin rutear; el resto, «y N más»

  const rwaEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rwaFecha = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    try {
      const s = new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) { return iso; }
  };
  const RWA_MOTIVO = {
    'sin-tablero': 'La pantalla de Asignación todavía no ha cargado el día. Ábrela y vuelve a intentarlo.',
    'sin-carros': 'No hay vehículos en la flota: sin carros no hay vueltas que mandar.',
    'sin-traslados': 'No hay traslados cargados en Asignación para este día.',
    'error': 'No se pudo leer el tablero. Recarga la pantalla de Asignación y vuelve a intentarlo.',
  };

  let rwaFocoPrevio = null, rwaTimer = null;

  function rwaMontar() {
    let ovl = document.getElementById('rwa-ovl');
    if (ovl) return ovl;
    ovl = document.createElement('div');
    ovl.id = 'rwa-ovl';
    ovl.className = 'rwa-ovl';
    ovl.innerHTML = `<div class="rwa-box" role="dialog" aria-modal="true" aria-labelledby="rwa-titulo">
      <div class="rwa-h">
        <span class="rwa-hic">${RWA_ICONO}</span>
        <div class="rwa-ht"><b id="rwa-titulo">Plan para WhatsApp</b><span id="rwa-sub"></span></div>
        <button type="button" class="rwa-x" data-rwa-cerrar aria-label="Cerrar" title="Cerrar">${RWA_X}</button>
      </div>
      <div class="rwa-b" id="rwa-cuerpo"></div>
      <div class="rwa-f">
        <label class="rwa-chk" id="rwa-chkWrap"><input type="checkbox" id="rwa-carros"> Marcar el carro de cada vuelta</label>
        <span class="rwa-ok" id="rwa-ok" role="status" aria-live="polite"></span>
        <button type="button" class="rwa-btn ghost" id="rwa-copiar">${RWA_COPIA}Copiar</button>
        <a class="rwa-btn wa" id="rwa-wa" target="_blank" rel="noopener noreferrer">${RWA_ICONO}Abrir WhatsApp</a>
      </div>
    </div>`;
    document.body.appendChild(ovl);
    ovl.addEventListener('click', (e) => {
      if (e.target === ovl || e.target.closest('[data-rwa-cerrar]')) { rwaCerrar(); return; }
      if (e.target.closest('#rwa-copiar')) { rwaAccionCopiar(); return; }
      const wa = e.target.closest('#rwa-wa');
      if (wa && wa.getAttribute('aria-disabled') === 'true') e.preventDefault();
    });
    ovl.addEventListener('change', (e) => { if (e.target && e.target.id === 'rwa-carros') rwaPintar(); });
    // Escape cierra; Tab no se escapa del modal.
    ovl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); rwaCerrar(); return; }
      if (e.key !== 'Tab') return;
      const f = [...ovl.querySelectorAll('button:not([disabled]), a[href], input, textarea')].filter((x) => !x.closest('[hidden]'));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
    return ovl;
  }

  function rwaListaSinRutear(lista) {
    const orden = lista.map((s) => Object.assign({}, s, { sinCarro: true })).sort((a, b) => rwaOrden(a) - rwaOrden(b));
    const filas = orden.slice(0, RWA_MAX_LISTA).map((s) =>
      `<li><span class="rwa-hr">${rwaEsc(rwaHoraSuelto(s))}</span>${rwaEsc(rwaLimpio(s.n))} <span class="rwa-z">(${rwaEsc(s.zona)}) · ${s.tipo === 'lle' ? 'llegada' : 'salida'}</span></li>`).join('');
    const resto = orden.length > RWA_MAX_LISTA ? `<li class="rwa-mas">y ${orden.length - RWA_MAX_LISTA} más</li>` : '';
    return `<div class="rwa-nota warn" id="rwa-sinRutear"><b>${orden.length} sin carro.</b> Van en el mensaje con «QUIZÁS NO HAYA CARRO»: revísalos antes de mandar.<ul>${filas}${resto}</ul></div>`;
  }

  function rwaPintar() {
    const ovl = rwaMontar();
    const conCarro = !!(ovl.querySelector('#rwa-carros') || {}).checked;
    const r = rwaLeer();
    const txt = r.plan ? rwaFormatear(r.plan, { carros: conCarro }) : '';
    const cuerpo = ovl.querySelector('#rwa-cuerpo');
    const copiar = ovl.querySelector('#rwa-copiar');
    const wa = ovl.querySelector('#rwa-wa');
    const sub = ovl.querySelector('#rwa-sub');
    ovl.querySelector('#rwa-chkWrap').hidden = !txt;
    rwaAviso('');

    if (!txt) {
      const motivo = r.motivo === 'sin-armar'
        ? `Hay ${r.total} traslado${r.total === 1 ? '' : 's'} pero todavía no van en ningún carro. Pulsa «Optimizar» (o arrástralos a los carros) y vuelve a abrir esto.`
        : (RWA_MOTIVO[r.motivo] || RWA_MOTIVO['sin-traslados']);
      sub.textContent = rwaFecha(typeof rt !== 'undefined' && rt ? rt.day : '');
      cuerpo.innerHTML = `<div class="rwa-vacio" id="rwa-vacio"><b>No hay plan para copiar</b><p>${rwaEsc(motivo)}</p></div>`;
      copiar.disabled = true;
      wa.removeAttribute('href');
      wa.setAttribute('aria-disabled', 'true');
      wa.classList.add('off');
      return;
    }

    const nV = r.plan.vueltas.length;
    sub.textContent = [rwaFecha(r.plan.dia), `${nV} vuelta${nV === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    const notas = [];
    if (r.sinRutear.length) notas.push(rwaListaSinRutear(r.sinRutear));
    if (r.hotel.length) {
      notas.push(`<div class="rwa-nota" id="rwa-hotel">Con «Hotel» en el tablero: <b>${rwaEsc(r.hotel.join(', '))}</b>. Ese dato es la pernocta, no dice si va al hotel, así que el mensaje no escribe «Va a hotel»: si alguno va, agrégalo antes de mandar.</div>`);
    }
    cuerpo.innerHTML = notas.join('')
      + '<textarea class="rwa-ta" id="rwa-ta" readonly spellcheck="false" aria-label="Texto del plan para WhatsApp"></textarea>';
    cuerpo.querySelector('#rwa-ta').value = txt;
    copiar.disabled = false;
    wa.setAttribute('href', 'https://wa.me/?text=' + encodeURIComponent(txt));
    wa.removeAttribute('aria-disabled');
    wa.classList.remove('off');
  }

  function rwaAviso(msg, ok) {
    const el = document.getElementById('rwa-ok');
    if (!el) return;
    clearTimeout(rwaTimer);
    el.textContent = msg || '';
    el.classList.toggle('err', !!msg && !ok);
    el.classList.toggle('show', !!msg);
    if (msg && ok) rwaTimer = setTimeout(() => { el.textContent = ''; el.classList.remove('show'); }, 2500);
  }

  // Portapapeles con respaldo: navigator.clipboard pide contexto seguro y
  // permiso; si no está, se selecciona el textarea y se usa execCommand. Si
  // tampoco, el texto queda seleccionado para copiarlo a mano.
  async function rwaCopiar(texto, ta) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(texto);
        return true;
      }
    } catch (_) { /* sin permiso: respaldo */ }
    if (!ta) return false;
    try {
      // iOS no selecciona un textarea de solo lectura: se suelta un instante.
      ta.readOnly = false;
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (_) {}
      return !!(document.execCommand && document.execCommand('copy'));
    } catch (_) { return false; } finally { ta.readOnly = true; }
  }

  async function rwaAccionCopiar() {
    const ta = document.getElementById('rwa-ta');
    if (!ta || !ta.value) return;
    const ok = await rwaCopiar(ta.value, ta);
    rwaAviso(ok ? 'Copiado' : 'No se pudo copiar: el texto quedó seleccionado, cópialo a mano.', ok);
  }

  function rwaAbrir() {
    const ovl = rwaMontar();
    rwaFocoPrevio = document.activeElement;
    rwaPintar();
    ovl.classList.add('show');
    const copiar = ovl.querySelector('#rwa-copiar');
    (copiar && !copiar.disabled ? copiar : ovl.querySelector('.rwa-x')).focus();
  }

  function rwaCerrar() {
    const ovl = document.getElementById('rwa-ovl');
    if (!ovl || !ovl.classList.contains('show')) return;
    ovl.classList.remove('show');
    rwaAviso('');
    if (rwaFocoPrevio && typeof rwaFocoPrevio.focus === 'function' && document.contains(rwaFocoPrevio)) rwaFocoPrevio.focus();
    rwaFocoPrevio = null;
  }

  // El botón de la barra de Asignación. Delegado en document: no toca los
  // manejadores de admin-rutas.js (rtBindOnce) ni depende de cuándo se pinte.
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('#rt-waBtn')) { e.preventDefault(); rwaAbrir(); }
  });

  window.RendioWhatsApp = {
    texto: rwaTexto,
    abrir: rwaAbrir,
    cerrar: rwaCerrar,
    plan: () => rwaLeer().plan,
    formatear: rwaFormatear,
  };
})();
