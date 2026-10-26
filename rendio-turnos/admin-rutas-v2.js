// admin-rutas-v2.js — Rutas › Asignación v2 (entrega del UX, 10-oct-2026).
//
// Pinta la pestaña «Asignación» con el diseño nuevo
// (Visual/entrega-asignacion-v2-2026-10-10) SOBRE el estado y las funciones de
// admin-rutas.js. No hay un segundo solver ni un segundo guardado:
//   · cargar      → rtLoad(día) + Api.getPublishedPlan (se rearma lo publicado)
//   · tiempos     → rtCarCompute / rtBuildMatrix (el modelo de tiempos de siempre)
//   · re-optimizar→ rtOptimize (con su overlay «Optimizando…»)
//   · publicar    → rtSavePlan (Api.saveRoutePlan + push a tripulantes y conductores)
//   · mapa        → rtOpenMap
// Lo único nuevo es la pantalla y las acciones con botón (mover, asignar,
// deshacer), que cambian rt.order / rt.lanes / car.driverAM|PM en memoria hasta
// publicar, exactamente como lo hacía arrastrar y soltar.
//
// Vive en un IIFE: nada de lo de aquí sale al ámbito global salvo
// window.RendioRutasV2 (lo usa renderRoutes de admin-rutas.js).
(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  /* ---------- 1. Utilidades e íconos ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (m) => { if (m == null || !isFinite(m)) return '—'; m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n) + ' min';
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
  const shortName = (name) => { const p = String(name || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mq = (q) => { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (_) { return false; } };
  const telHref = (t) => 'tel:' + String(t || '').replace(/[^\d+]/g, '');
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  const IC = {
    phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    move: svg('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>'),
    zap: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    back: svg('<path d="m15 18-6-6 6-6"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  };

  /* ---------- 2. Reglas de negocio (README §4) ---------- */
  // Umbral de «Ajustada»: 10 min (decisión de la profa, 10-oct).
  const ADJ_MIN = 10;
  // Llegadas: el margen no aplica (README), pero el modelo de siempre ya mide
  // cuánto esperaría el tripulante en MDE y pasado 15 min lo llama «Espera
  // larga». No se esconde: esa vuelta sale «Ajustada» (no bloquea, pide revisar).
  const LLE_ESPERA_LARGA = 15;
  // El solver redondea la salida a múltiplos de 5 hacia abajo, así que una
  // vuelta encadenada puede quedar hasta 4 min antes de que el carro esté libre
  // sin que eso sea un choque de verdad. Pasado eso, sí: el carro llega tarde.
  const TOL_CHOQUE = 4;
  const LABEL = { risk: 'En riesgo', nodriver: 'Sin conductor', adj: 'Ajustada', ok: 'Lista' };
  const TYPE = { salida: 'Salida', llegada: 'Llegada', hotel: 'Hotel' };
  const TYPE_LONG = { salida: 'Salida casa → JMC', llegada: 'Llegada JMC → casa', hotel: 'Salida con hotel → JMC' };
  const PRIO = { risk: 0, nodriver: 1, adj: 2, ok: 3 };
  const KEY_VISTA = 'rendio.rutas.vista';
  const ESTADOS_PLAN = ['draft', 'planned', 'in_progress', 'completed'];

  const BUF = () => (typeof rt !== 'undefined' && rt.AIRPORT_BUFFER) || 10;
  const aux = (id) => (rt.aux && rt.aux[id]) || null;
  const nombre = (id) => (aux(id) && aux(id).n) || 'Tripulante';
  const sectorDe = (id) => { const a = aux(id); return a ? (a.sector || a.zonaJefe || '') : ''; };
  const lugar = (id) => { const a = aux(id); if (!a) return ''; const s = a.sector && a.sector !== a.zona ? ' · ' + a.sector : ''; return (a.zona || '—') + s; };
  // De reserva (0121): el lugar ('Hotel Movich', 'Reserva JMC') o ''. `tierra`
  // viene en true también con reserva (misma lógica de llegadas): los textos
  // miran esto primero.
  const resP = (a) => (a && a.reserva && typeof Api !== 'undefined' && Api && typeof Api.reservePlace === 'function' ? Api.reservePlace(a.reserva) : null);
  const resTxt = (a) => { const P = resP(a); return P ? (P.hotel ? P.name : 'Reserva JMC') : ''; };
  const horaTxt = (a) => (a.reserva ? 'termina la asignación' : (a.tierra ? 'sale del terminal' : 'aterriza'));
  // El hotel de la vuelta si TODOS van/vienen del mismo (para el renglón final).
  const hotelDe = (ids) => { const ps = ids.map((id) => resP(aux(id))); return ps.length && ps.every((P) => P && P.hotel && P.key === ps[0].key) ? ps[0] : null; };
  const algunHotel = (ids) => { const P = ids.map((id) => resP(aux(id))).find((x) => x && x.hotel); return P || null; };
  const fijaDe = (laneId) => (rt.rv2Fijas && rt.rv2Fijas[laneId]) || null;
  const atendida = (id) => !!(rt.rv2Atendidas && rt.rv2Atendidas[id]);
  // Cómo terminó una vuelta publicada (26-oct-2026, Api._opResultado): la base
  // nunca la cierra, así que se deduce de sus paradas al releer el plan.
  const resultadoDe = (laneId) => (rt.rv2Fin && rt.rv2Fin[laneId]) || null;
  const lanesDeCarro = (carId) => rt.lanes.filter((l) => l.car === carId && (rt.order[l.id] || []).length).sort((a, b) => a.vuelta - b.vuelta);

  // Cuándo puede empezar el carro ESTA vuelta, con la misma cuenta que el
  // solver (rtSolveDay, paso 3): tras una salida queda en MDE + TURNAROUND;
  // tras una llegada queda en la última casa (+2) y, si lo que sigue es otra
  // llegada, tiene que volver a MDE.
  // La PRIMERA vuelta del carro no tiene con qué chocar: devuelve null. (El
  // solver arranca los carros a la medianoche: lo que sale antes del corte de
  // Calibración lo hace el turno PM del día anterior; marcarla «tarde» sería falso.)
  function libreDe(lane) {
    const lanes = lanesDeCarro(lane.car);
    const i = lanes.findIndex((l) => l.id === lane.id);
    if (i <= 0) return null;
    const prev = lanes[i - 1];
    const pc = rtCarCompute(prev.id);
    if (pc.arrival == null) return null;
    if (prev.type === 'lle') {
      const fin = pc.arrival + 2;
      if (lane.type === 'lle') { const ult = rt.order[prev.id][rt.order[prev.id].length - 1]; return fin + rtLegMin(ult, 'airport'); }
      return fin;
    }
    return pc.arrival + rt.TURNAROUND;
  }
  // El origen de cada salida depende de dónde quedó el carro en su vuelta
  // anterior (misma regla que rtSolveDay). Al mover gente entre vueltas cambia
  // la última casa de una llegada, o una vuelta queda vacía: se vuelve a
  // encadenar el carro para que el tramo inicial sea el real.
  function encadenar(carId) {
    let prev = null;
    lanesDeCarro(carId).forEach((l) => {
      if (l.type === 'lle') l.origin = 'airport';
      else l.origin = prev ? (prev.type === 'lle' ? rt.order[prev.id][rt.order[prev.id].length - 1] : 'airport') : null;
      prev = l;
    });
  }
  // La hora de una vuelta de llegada: la del último vuelo (los de tierra, 0092,
  // solo si todos son de tierra). Es la misma regla que horaVuelta en rtSolveDay.
  function horaVuelta(ids) {
    const vuelo = ids.filter((id) => !(aux(id) && aux(id).tierra));
    return Math.max(...(vuelo.length ? vuelo : ids).map((id) => rtToMin(aux(id).dl)));
  }
  // Vuelve a programar la hora de UNA vuelta tocada por una acción, con las
  // fórmulas del solver: salida = lo más tarde que aún entrega con colchón
  // (rtCarCompute.depart), nunca antes de que el carro esté libre; llegada =
  // cuando ya salieron todos del terminal (rtDeplaneOf), redondeado hacia arriba.
  // Una vuelta en curso o terminada no se toca.
  function reprogramar(lane) {
    if (!lane || fijaDe(lane.id)) return;
    const ids = rt.order[lane.id] || [];
    if (!ids.length) return;
    const libre = libreDe(lane);
    // Piso: cuando el carro está libre; en la primera vuelta, la medianoche
    // (rtToHM no sabe escribir horas negativas).
    const piso = libre == null ? 0 : libre;
    if (lane.type === 'lle') {
      const landing = horaVuelta(ids);
      lane.landing = rtToHM(landing);
      const ideal = landing + rtDeplaneOf(ids, landing);
      lane.start = rtInicioLle(Math.max(ideal, piso));
    } else {
      const r = rtCarCompute(lane.id);
      if (r.depart == null) return;
      lane.start = rtToHM(Math.max(0, rtRedondea5(Math.max(piso, r.depart))));
    }
  }

  function conductor(id) {
    if (!id) return null;
    const d = (rt.drivers || []).find((x) => x.id === id);
    if (d) return { id, name: d.n || 'Conductor', phone: d.tel || '' };
    const s = [...((rt.shift && rt.shift.am) || []), ...((rt.shift && rt.shift.pm) || []), ...((rt.shiftPrev && rt.shiftPrev.pm) || [])].find((x) => x.id === id);
    return { id, name: (s && s.n) || 'Conductor', phone: '' };
  }

  // Una RUTA del contrato del README (§6) a partir de una vuelta de rt.
  function ruta(lane) {
    const ids = (rt.order && rt.order[lane.id]) || [];
    if (!ids.length) return null;
    const car = rtCarOf(lane) || { id: lane.car };
    const c = rtCarCompute(lane.id);
    if (!c || c.arrival == null) return null;
    const lle = lane.type === 'lle';
    const type = lle ? 'llegada' : (ids.some((id) => aux(id) && aux(id).hotel) ? 'hotel' : 'salida');
    const start = rtToMin(lane.start);
    const libre = libreDe(lane);
    const d = libre != null ? libre - start : 0;
    // Publicada y sin tocar (rtHorasPub): se muestra la hora guardada, la que
    // tienen el conductor y el tripulante, aunque el carro venga de otra vuelta.
    const fijaPub = typeof rtHorasPub === 'function' && !!rtHorasPub(lane.id);
    const retraso = !fijaPub && d > TOL_CHOQUE ? Math.round(d) : 0;
    const fija = fijaDe(lane.id);
    // En una salida la hora de cada parada es la REDONDA que se le da al
    // tripulante (rtCita, admin-rutas.js), corrida si el carro viene atrasado.
    const stops = c.stops.map((s) => ({ crewId: s.id, time: s.cita != null ? (fijaPub ? s.cita : rtCita(s.eta + retraso)) : s.eta + retraso }));
    let arrival, end, pres = null, margin = null, wait = null;
    if (lle) {
      arrival = rtToMin(lane.landing || lane.start);          // aterrizaje (README §6)
      end = c.arrival + retraso;
      wait = Math.max(0, Math.round(Math.max(c.wait || 0, start + retraso - (c.depart != null ? c.depart : start))));
    } else {
      arrival = c.arrival + retraso;                         // ETA a JMC
      end = arrival;
      pres = c.hardDL;
      // Margen = presentación − (llegada a MDE + colchón de entrega). Es la
      // holgura del modelo de siempre: «llegar justo a la presentación ES tarde».
      margin = Math.round(c.holg - retraso);
    }
    const driverId = rtDriverOf(lane) || null;
    const shift = rtBandOf(lane);
    // El resultado vale mientras la vuelta siga como se publicó: la terminada no
    // se puede tocar (fija), y una «sin marcar» que se reacomoda ya es otra.
    const fin = fija === 'completed' || fijaPub ? resultadoDe(lane.id) : null;
    let status;
    if (fija === 'completed') status = 'ok';
    else if (margin != null && margin < 0) status = 'risk';
    else if (!driverId && !lane.deleg) status = 'nodriver';   // 0126: la delegada no pide conductor
    else if ((margin != null && margin < ADJ_MIN) || (wait != null && wait > LLE_ESPERA_LARGA)) status = 'adj';
    else status = 'ok';
    // En una llegada recoge cuando la gente ya salió: la vuelta de las 23:59 de
    // un vuelo que suelta a las 00:05 recoge a las 00:05 (rtInicioLle).
    const pickup = lle ? Math.max(start + retraso, c.depart != null ? c.depart : start) : stops[0].time;
    return {
      id: lane.id, lane, vuelta: lane.vuelta, vehicle: car.id, cap: rtCapOf(car), type,
      depart: start + retraso, pickup, arrival, end, pres, margin, wait, retraso,
      stops, pax: c.pax, driverId, shift, status, fija, fin, etaSource: rt.etaSource || null,
      propio: lane.drv !== undefined,   // conductor puesto solo a esta vuelta (rtDriverOf)
      delegada: lane.deleg === true,    // 0126: la hace alguien de afuera (sin conductor a propósito)
      hora: ((Math.floor(arrival / 60) % 24) + 24) % 24,
    };
  }

  // El «día» del contrato del README (§6), armado con lo que ya hay en rt.
  function armarDia() {
    const routes = [];
    (rt.lanes || []).forEach((l) => { const r = ruta(l); if (r) routes.push(r); });
    const byId = {}; routes.forEach((r) => { byId[r.id] = r; });
    const crew = {};
    Object.keys(rt.aux || {}).forEach((id) => {
      const a = rt.aux[id];
      crew[id] = { id, name: a.n, phone: a.tel || '', barrio: a.zona || '', sector: a.sector || a.zonaJefe || '', presentation: a.type === 'lle' ? null : a.dl, type: a.type };
    });
    return {
      date: rt.day || ui.dia,
      published: !!rt.firmaPublicada,
      vehicles: (rt.cars || []).map((c) => ({ id: c.id, am: c.driverAM || null, pm: c.driverPM || null, mad: c.driverMad || null, capacity: rtCapOf(c) })),
      drivers: (rt.drivers || []).map((d) => ({ id: d.id, name: d.n, phone: d.tel || '' })),
      crew, routes, byId,
      unrouted: (rt.pool || []).slice(),
    };
  }

  function counts(list) {
    const c = { all: list.length, risk: 0, nodriver: 0, adj: 0, ok: 0, unrouted: (rt.pool || []).length };
    list.forEach((r) => { c[r.status]++; });
    return c;
  }
  const timeSpan = (r) => (r.type === 'llegada' ? `JMC ${hhmm(r.arrival)} → ${hhmm(r.end)}` : `${hhmm(r.pickup)} → ${hhmm(r.arrival)}`);
  const hayVueltas = () => (rt.lanes || []).some((l) => (rt.order[l.id] || []).length);
  const firmaActual = () => (typeof rtFirmaPlan === 'function' ? rtFirmaPlan() : '');
  const publicado = () => !!rt.firmaPublicada;
  const conCambios = () => publicado() && firmaActual() !== rt.firmaPublicada;

  /* ---------- 3. Mover / simular (con el modelo de tiempos real) ---------- */
  const foto = () => ({ lanes: clone(rt.lanes), order: clone(rt.order), pool: rt.pool.slice(), drv: rt.cars.map((c) => [c.driverAM || null, c.driverPM || null, c.driverMad || null]), optimized: rt.optimized, fijas: clone(rt.rv2Fijas || {}), auto: clone(rt.rv2Auto || {}) });
  function restaurar(f) {
    rt.lanes = clone(f.lanes); rt.order = clone(f.order); rt.pool = f.pool.slice(); rt.optimized = f.optimized;
    rt.rv2Fijas = clone(f.fijas || {}); rt.rv2Auto = clone(f.auto || {});
    rt.cars.forEach((c, i) => { const d = f.drv[i] || [null, null, null]; c.driverAM = d[0]; c.driverPM = d[1]; c.driverMad = d[2] || null; });
  }
  function aplicarMovida(crewId, fromId, toId) {
    const to = rtLaneOf(toId);
    const from = fromId ? rtLaneOf(fromId) : null;
    if (from) rt.order[fromId] = (rt.order[fromId] || []).filter((x) => x !== crewId);
    else rt.pool = rt.pool.filter((x) => x !== crewId);
    const ids = (rt.order[toId] || []).concat([crewId]);
    // Mismo orden que pondría el solver: barrido de afuera hacia MDE en las
    // salidas, reparto desde MDE en las llegadas.
    rt.order[toId] = to.type === 'lle' ? rtBestOrder(ids, 'airport', false) : rtBestOrder(ids, to.origin);
    encadenar(to.car);
    if (from && from.car !== to.car) encadenar(from.car);
    reprogramar(to);
    if (from) reprogramar(from);
    // El orden se eligió con el origen viejo; si encadenar lo cambió, se vuelve a ordenar.
    if (to.type !== 'lle') rt.order[toId] = rtBestOrder(rt.order[toId], to.origin);
    reprogramar(to);
  }
  function siguienteDe(laneId) {
    const l = rtLaneOf(laneId); if (!l) return null;
    const lanes = lanesDeCarro(l.car); const i = lanes.findIndex((x) => x.id === laneId);
    return i >= 0 ? lanes[i + 1] || null : null;
  }
  // Prueba una movida sin quedarse con ella: devuelve cómo quedarían la ruta
  // de origen, la de destino y la vuelta siguiente del carro de destino.
  function simular(crewId, fromId, toId) {
    const f = foto();
    try {
      const antes = toId ? ruta(rtLaneOf(toId)) : null;
      const sig0 = toId ? siguienteDe(toId) : null;
      const rs0 = sig0 ? ruta(sig0) : null;
      if (toId) aplicarMovida(crewId, fromId, toId);
      else if (fromId) { rt.order[fromId] = rt.order[fromId].filter((x) => x !== crewId); encadenar(rtLaneOf(fromId).car); reprogramar(rtLaneOf(fromId)); }
      const dst = toId ? ruta(rtLaneOf(toId)) : null;
      const src = fromId ? ruta(rtLaneOf(fromId)) : null;
      const sig = toId ? siguienteDe(toId) : null;
      const rs = sig ? ruta(sig) : null;
      const st = dst && dst.stops.find((s) => s.crewId === crewId);
      return {
        dst, src, srcEmpty: !!fromId && !src,
        // La vuelta siguiente del carro de destino queda esperando al carro
        // (y no lo estaba antes): eso también es llegar tarde.
        choque: rs && rs.retraso > ((rs0 && rs0.retraso) || 0) ? { vehicle: rs.vehicle, at: rs.depart - rs.retraso, retraso: rs.retraso } : null,
        pickup: st ? st.time : null,
        extra: dst && antes ? Math.max(0, Math.round((dst.end - dst.pickup) - (antes.end - antes.pickup))) : 0,
      };
    } finally { restaurar(f); }
  }
  const okSim = (s) => s.dst && s.dst.status !== 'risk' && !s.choque;
  // Rutas a las que puede ir un tripulante. Se filtra por tipo, cupo y hora
  // (±60 min de presentación en salidas: es el tope de madrugada del jefe,
  // route_max_early_min; ±45 min de aterrizaje en llegadas) y se simula cada
  // una con el modelo real. Orden: las que no quedan tarde, luego mismo sector,
  // luego la que menos se alarga (eso sí lo mide la matriz de tiempos, el
  // sector es solo la etiqueta del conjunto), luego la de más margen.
  function candidatas(crewId, fromId, { todas = false, max = Infinity } = {}) {
    const a = aux(crewId); if (!a) return [];
    const dl = rtToMin(a.dl); const pax = a.pax || 1;
    const sec = sectorDe(crewId);
    const out = [];
    rt.lanes.forEach((l) => {
      if (l.id === fromId || (l.type || 'sal') !== a.type || fijaDe(l.id)) return;
      const ids = rt.order[l.id] || []; if (!ids.length) return;
      if (rtPaxOf(ids) + pax > rtCapOf(rtCarOf(l))) return;
      if (!todas) {
        if (a.type === 'lle') { if (Math.abs(rtToMin(l.landing || l.start) - dl) > 45) return; }
        else { const c = rtCarCompute(l.id); if (Math.abs(c.hardDL - dl) > 60) return; }
      }
      out.push(l);
    });
    return out.map((l) => {
      const sim = simular(crewId, fromId, l.id);
      const mismo = !!sec && (rt.order[l.id] || []).some((id) => sectorDe(id) === sec);
      return { lane: l, sim, mismo };
    }).sort((x, y) => (okSim(y.sim) - okSim(x.sim)) || (y.mismo - x.mismo) || (x.sim.extra - y.sim.extra)
      || (((y.sim.dst && y.sim.dst.margin) ?? 0) - ((x.sim.dst && x.sim.dst.margin) ?? 0))).slice(0, max);
  }
  // Sugerencia para una ruta en riesgo: sacar a una persona que deje la ruta a
  // tiempo y meterla en otra que también quede a tiempo. Gana la que deja a las
  // dos con más margen (el peor de los dos).
  function sugerencia(r) {
    if (!r || r.status !== 'risk' || r.type === 'llegada' || r.fija) return null;
    let best = null;
    r.stops.slice().reverse().forEach((s) => {
      if (atendida(s.crewId)) return;
      const rem = simular(s.crewId, r.id, null);
      if (rem.srcEmpty || !rem.src || rem.src.margin == null || rem.src.margin < 0) return;
      candidatas(s.crewId, r.id, { max: 6 }).forEach(({ lane, sim }) => {
        if (!okSim(sim) || sim.dst.margin == null || sim.dst.margin < 0 || !sim.src || sim.src.margin < 0) return;
        const score = Math.min(sim.src.margin, sim.dst.margin);
        if (!best || score > best.score) best = { score, crewId: s.crewId, to: lane.id, src: sim.src.margin, dst: sim.dst.margin, pickup: sim.pickup, vehicle: sim.dst.vehicle };
      });
    });
    return best;
  }

  /* ---------- 4. Estado de la interfaz ---------- */
  // Asignación SIMPLE (15-oct-2026). La profa, con 50 reservas de prueba: «no
  // me parece nada intuitivo, debería ser fácil de manejar y reasignar; veo
  // muchos modos, motivos». Se quitaron los chips de estado, el filtro por tipo,
  // la barra de horas y las vistas Lista/Carros. Ahora:
  //   · una frase dice qué falta para publicar;
  //   · «Avisos»: solo lo que hay que resolver (sin carro, llega tarde, espera
  //     larga en JMC, carro sin conductor), en palabras y con un botón;
  //   · «Conductores»: carro × turno, puestos SOLOS con el horario publicado;
  //   · cada vuelta lista sus tripulantes con nombre: se arrastran a otra vuelta
  //     (PC) o se tocan para «Mover»;
  //   · el detalle trae el mapa del recorrido y, al mover, la vista previa de
  //     cada opción en ese mismo mapa.
  // El motor (tiempos, simular, sugerencia, publicar, deshacer) es el de arriba.
  // Prototipo aprobado: Visual/prototipo-asignacion-simple-2026-10-14.
  const ui = { q: '', sel: null, moving: null, todas: false, cargando: false, dia: null, publicando: false, optimizando: false, drag: null };
  const hist = [];
  let D = null;           // último «día» armado
  let bound = false;
  const el = {};
  const root = () => $('#routes-v2');
  const esCajon = () => { const r = root(); return !!r && r.dataset.lay === 'cajon'; };

  function medir() {
    const r = root(); if (!r || r.hidden) return;
    const C = r.clientWidth;
    if (mq('(max-width: 767px)')) { r.dataset.lay = 'cajon'; r.dataset.fila = 'tarjeta'; r.dataset.det = ''; return; }
    if (!C) return;
    const lado = C >= 1100;
    const det = C >= 1500 ? 440 : 400;
    const L = lado ? C - 34 - 16 - det : C - 34;
    r.dataset.lay = lado ? 'lado' : 'cajon';
    r.dataset.det = String(det);
    r.dataset.fila = L >= 600 ? 'fila' : 'tarjeta';
  }

  /* ---------- Conductores automáticos ---------- */
  // Cada carro × turno con vueltas y sin conductor se llena SOLO con alguien en
  // turno según el horario PUBLICADO (rtPoolFor) que no maneje otro carro en ese
  // turno. Sin horario publicado para ese turno no se adivina: queda sin
  // conductor y sale en Avisos. Lo que el jefe elija a mano manda: solo se
  // llenan los vacíos. rt.rv2Auto recuerda cuáles puso la app.
  const horarioDe = (band) => (band === 'mad' ? !!rt.shiftPrevLoaded : !!rt.shiftLoaded);
  function autoLlenar() {
    if (!rt.cars || !rt.lanes || rt.source !== 'live') return;
    rt.rv2Auto = rt.rv2Auto || {};
    Object.keys(rt.rv2Auto).forEach((k) => {
      const [carId, b] = k.split('|'); const car = rt.cars.find((c) => c.id === carId);
      if (!car || rtCarDrv(car, b) !== rt.rv2Auto[k]) delete rt.rv2Auto[k];
    });
    const slots = [];
    rt.lanes.forEach((l) => {
      if (!(rt.order[l.id] || []).length || fijaDe(l.id) === 'completed' || l.drv !== undefined) return;
      const b = rtBandOf(l); const k = l.car + '|' + b;
      if (!slots.some((s) => s.k === k)) slots.push({ k, carId: l.car, b, t: rtToMin(l.start) });
    });
    slots.sort((x, y) => x.t - y.t).forEach(({ k, carId, b }) => {
      const car = rt.cars.find((c) => c.id === carId);
      if (!car || rtCarDrv(car, b) || !horarioDe(b)) return;
      const d = poolTurno(b).find((x) => !usadoEn(b, x.id, carId));
      if (d) { rtSetCarDrv(car, b, d.id); rt.rv2Auto[k] = d.id; }
    });
  }

  /* ---------- 5. Render ---------- */
  function hl(text) {
    const s = String(text == null ? '' : text);
    const q = norm(ui.q);
    if (!q) return esc(s);
    let ns = ''; const map = [];
    for (let i = 0; i < s.length; i++) { for (const ch of norm(s[i])) { ns += ch; map.push(i); } }
    const k = ns.indexOf(q);
    if (k < 0) return esc(s);
    const a = map[k], b = map[k + q.length - 1] + 1;
    return esc(s.slice(0, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>' + esc(s.slice(b));
  }
  function matchesQ(r) {
    if (!ui.q) return true;
    const q = norm(ui.q); const d = conductor(r.driverId);
    return norm(r.vehicle).includes(q) || (d && norm(d.name).includes(q)) ||
      r.stops.some((s) => { const a = aux(s.crewId) || {}; return norm(a.n).includes(q) || norm(a.zona).includes(q) || norm(a.sector).includes(q); });
  }

  function dayLabel(day) {
    if (!day) return '—';
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${DIAS[dt.getUTCDay()]} ${d} ${MESES[m - 1]}`;
  }
  const hoyBog = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const sumarDias = (day, n) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  function relDia(day) {
    if (!day) return '';
    const h = hoyBog();
    if (day === h) return 'Hoy';
    if (day === sumarDias(h, 1)) return 'Mañana';
    if (day === sumarDias(h, -1)) return 'Ayer';
    return '';
  }
  // La última entrega de una llegada es la hora de la última parada (r.end le
  // suma el rato de bajarse: daba 10:52 contra un 10:50 en la lista).
  const ultima = (r) => (r.stops.length ? Math.max(...r.stops.map((s) => s.time)) : r.end);
  const horas = (r) => (r.type === 'llegada' ? `${hhmm(r.arrival)} → ${hhmm(ultima(r))}` : `${hhmm(r.pickup)} → ${hhmm(r.arrival)}`);
  const turnoTxt = (b) => 'Turno ' + rtBandName(b);   // «Turno AM», «Turno PM del lunes»

  function renderBar() {
    const day = rt.day || ui.dia;
    el.dayLabel.textContent = dayLabel(day);
    const rel = relDia(day);
    el.dayLabel.title = rel ? `${rel} · ${day}` : (day || '');
    el.dayLabel.setAttribute('aria-label', `Día: ${dayLabel(day)}${rel ? ' (' + rel.toLowerCase() + ')' : ''}`);
    const pub = publicado();
    el.pubChip.hidden = !pub;
    el.pubChip.classList.toggle('is-changed', pub && conCambios());
    el.pubChip.textContent = pub ? (conCambios() ? 'Publicado · con cambios' : 'Publicado') : '';
    el.pubChip.title = pub ? (conCambios() ? 'Hay un plan publicado; lo que ves tiene cambios que los conductores todavía no tienen.' : 'Este es el plan que ya tienen los conductores.') : '';
    const live = rt.source === 'live';
    el.reopt.disabled = !live || ui.cargando || ui.optimizando;
    el.reoptLabel.textContent = hayVueltas() ? 'Re-optimizar' : 'Optimizar';
    $$('[data-act="nav"]', root()).forEach((b) => { b.disabled = ui.cargando; });
  }

  // Lo que hay que resolver antes de publicar, en palabras. Nada más: lo que
  // está bien no se anuncia («Ajustada» y «Lista» dejaron de ser estados).
  function avisosDe() {
    if (!D || ui.cargando || rt.source !== 'live') return [];
    const out = [];
    (rt.pool || []).slice().sort((a, b) => rtToMin((aux(a) || {}).dl) - rtToMin((aux(b) || {}).dl)).forEach((id) => {
      const a = aux(id); if (!a) return;
      const cuando = (a.type === 'lle' ? `${a.reserva ? 'Termina la asignación' : (a.tierra ? 'Sale del terminal' : 'Aterriza')} ${a.dl}` : `Presentación ${a.dl}`)
        + (resTxt(a) ? ` · ${resTxt(a)}` : '')
        + (rtToMin(a.dl) < rtCut() ? ` (madrugada, turno PM del ${rtDiaAnterior()})` : '');
      out.push({ k: 'unrouted', html: `<b>${esc(a.n)}</b> no tiene carro<small>${a.type === 'lle' ? 'Llegada' : 'Salida'} · ${esc(cuando)} · ${esc(lugar(id))}</small>`, btn: 'Ubicar', act: `data-act="route" data-crew="${esc(id)}"` });
    });
    D.routes.filter((r) => r.status === 'risk').sort((a, b) => a.arrival - b.arrival).forEach((r) => {
      out.push({ k: 'risk', html: `<b>${esc(r.vehicle)}</b> de las ${hhmm(r.pickup)} llega <b>${Math.abs(r.margin)} min tarde</b><small>Llega a JMC ${hhmm(r.arrival)} · presentación ${hhmm(r.pres)} · con ${BUF()} min de entrega</small>`, btn: 'Ver', act: `data-act="ver" data-id="${esc(r.id)}"` });
    });
    D.routes.filter((r) => r.type === 'llegada' && r.fija !== 'completed' && (r.wait || 0) > LLE_ESPERA_LARGA).forEach((r) => {
      out.push({ k: 'wait', html: `En <b>${esc(r.vehicle)}</b> esperan <b>${r.wait} min</b> el carro en JMC<small>Aterrizan ${hhmm(r.arrival)} · el carro los recoge ${hhmm(r.pickup)}</small>`, btn: 'Ver', act: `data-act="ver" data-id="${esc(r.id)}"` });
    });
    slotsSinConductor().forEach((r, k) => {
      const [carId, b] = k.split('|');
      out.push({ k: 'nodriver', html: `<b>${esc(carId)}</b> no tiene conductor · ${esc(turnoTxt(b))}<small>${horarioDe(b) ? 'No queda nadie libre en ese turno según el horario publicado' : 'No hay horario publicado para ese turno'}</small>`, btn: 'Elegir', act: `data-act="assignslot" data-car="${esc(carId)}" data-shift="${esc(b)}"` });
    });
    // Se le quitó el conductor SOLO a una vuelta: el botón abre la hoja de esa vuelta.
    D.routes.filter((r) => r.propio && !r.driverId && !r.delegada && r.fija !== 'completed').forEach((r) => {
      out.push({ k: 'nodriver', html: `La vuelta de <b>${esc(r.vehicle)}</b> de las ${hhmm(inicioDe(r).at)} no tiene conductor<small>Se le quitó solo a esa vuelta · ${esc(turnoTxt(r.shift))}</small>`, btn: 'Elegir', act: `data-act="assign" data-id="${esc(r.id)}"` });
    });
    // Un conductor con dos vueltas que se cruzan, o que no alcanza a llegar de una
    // a la siguiente (26-oct-2026). Con el conductor por vuelta se puede armar sin
    // querer; y en un plan con las horas del jefe (rt.horasPub) el tablero no lo
    // veía: Julián dejaba a alguien en JMC a las 04:02 y tenía que recoger en
    // Bosques del Norte a las 04:15. No bloquea publicar: el jefe decide.
    choquesDeConductor().forEach(({ id, a, b, cruza, e, cambiar }) => {
      const n = esc(conductor(id).name);
      const html = cruza
        ? `<b>${n}</b> tiene dos vueltas a la vez<small>${esc(a.vehicle)} de las ${hhmm(inicioDe(a).at)} (hasta las ${hhmm(finDe(a).at)}) y ${esc(b.vehicle)} de las ${hhmm(inicioDe(b).at)}</small>`
        : `<b>${n}</b> no alcanza a llegar a la vuelta de las ${hhmm(inicioDe(b).at)} de ${esc(b.vehicle)}<small>Termina la de las ${hhmm(inicioDe(a).at)} ${a.type === 'llegada' ? 'en la última casa' : 'en JMC'} a las ${hhmm(finDe(a).at)}: llegaría a las ${hhmm(e.llega)}, ${e.tarde} min tarde</small>`;
      out.push({ k: 'drv', html, btn: 'Cambiar', act: `data-act="assign" data-id="${esc(cambiar.id)}"` });
    });
    return out;
  }

  function renderSay(av) {
    const live = rt.source === 'live' && !ui.cargando;
    const total = Object.keys(rt.aux || {}).length;
    const conCarro = total - (rt.pool || []).length;
    let txt, ok = false;
    if (ui.cargando) txt = 'Cargando el día…';
    else if (!live) txt = '';
    else if (!hayVueltas()) txt = `${plural((rt.pool || []).length, 'tripulante sin carro', 'tripulantes sin carro')}. Optimiza el día para armar las vueltas.`;
    else if (av.length) txt = `Antes de publicar, <a href="#" data-act="avisos">revisa ${plural(av.length, 'aviso', 'avisos')}</a>.`;
    else { txt = '<b>Todo listo.</b> Revisa lo que quieras y publica.'; ok = true; }
    el.say.hidden = !txt;
    el.say.classList.toggle('is-ok', ok);
    el.say.innerHTML = txt ? `<i aria-hidden="true"></i><span>${txt}</span>${live && hayVueltas() ? `<small>${plural(D.routes.length, 'vuelta', 'vueltas')} · ${conCarro} de ${total} tripulantes con carro</small>` : ''}` : '';
    el.pending.textContent = av.length;
    el.pending.hidden = av.length === 0;
    el.pending.setAttribute('aria-label', `${av.length} ${av.length === 1 ? 'aviso' : 'avisos'}`);
    const pubLabel = publicado() && !conCambios() ? 'Publicado' : publicado() ? 'Publicar cambios' : 'Publicar plan';
    el.publishLabel.textContent = ui.publicando ? 'Publicando…' : pubLabel;
    const can = rt.source === 'live' && hayVueltas() && !ui.cargando && !ui.publicando;
    el.publish.disabled = !can;
    el.publishM.disabled = !can;
    el.publishM.innerHTML = ui.publicando ? 'Publicando…' : publicado() && !conCambios() ? 'Plan publicado' : `${pubLabel}${av.length ? ` · <span>${plural(av.length, 'aviso', 'avisos')}</span>` : ''}`;
  }

  function renderAvisos(av) {
    const show = rt.source === 'live' && !ui.cargando && hayVueltas();
    el.summary.hidden = !show;
    if (!show) { el.avisos.innerHTML = ''; return; }
    if (!av.length) { el.avisos.innerHTML = '<h2>Avisos</h2><ul class="rv2-al"><li class="is-ok">Nadie se queda sin carro y todos llegan a tiempo.</li></ul>'; return; }
    el.avisos.innerHTML = `<h2>Avisos <span class="n">${av.length}</span></h2><p class="sub">Solo lo que hay que resolver antes de publicar.</p><ul class="rv2-al">` +
      av.map((a) => `<li data-k="${a.k}"><span class="t">${a.html}</span><button class="rv2-btn rv2-btn--sm" ${a.act}>${a.btn}</button></li>`).join('') + '</ul>';
  }

  function renderDrivers() {
    if (rt.source !== 'live' || ui.cargando || !hayVueltas()) { el.drivers.innerHTML = ''; return; }
    const cells = {};
    D.routes.forEach((r) => { if (r.fija === 'completed') return; const k = r.vehicle + '|' + r.shift; const c = (cells[k] = cells[k] || { n: 0, otros: 0, deleg: 0 }); if (r.delegada) c.deleg++; else if (r.propio) c.otros++; else c.n++; });
    const bands = RT_BANDS.filter((b) => Object.keys(cells).some((k) => k.endsWith('|' + b)));
    const cars = (rt.cars || []).filter((c) => bands.some((b) => cells[c.id + '|' + b]));
    let h = `<h2>Conductores</h2><p class="sub">Se ponen solos con el horario publicado: uno por carro y turno, para todas sus vueltas. La placa sale del carro con que cada uno inicia turno. Toca uno para cambiarlo en todo el turno; para cambiar una sola vuelta, ábrela y toca «Cambiar».</p>` +
      `<div class="rv2-dgrid" style="grid-template-columns: 52px repeat(${bands.length}, minmax(0, 1fr))"><span></span>` +
      bands.map((b) => `<span class="hd">${esc(turnoTxt(b))}</span>`).join('');
    cars.forEach((car) => {
      h += `<span class="car">${esc(car.id)}</span>`;
      bands.forEach((b) => {
        const k = car.id + '|' + b; const c = cells[k];
        if (!c) { h += '<span class="cell none">Sin vueltas</span>'; return; }
        const id = rtCarDrv(car, b); const d = conductor(id);
        const auto = !!id && !!rt.rv2Auto && rt.rv2Auto[k] === id;
        // 0124: la placa sale del turno. Hoy: la del turno abierto, o «sin iniciar turno».
        const placa = id ? placaDeTurno(id) : null;
        const enTurno = placa ? ' · en ' + esc(placa) : (id && Array.isArray(rt.activos) ? ' · sin iniciar turno' : '');
        h += `<button class="cell${id ? '' : ' need'}" data-act="assignslot" data-car="${esc(car.id)}" data-shift="${b}" aria-label="${esc(`${car.id}, ${turnoTxt(b)}: ${d ? d.name : 'sin conductor'}${placa ? ', en ' + placa : ''}. Cambiar`)}">` +
          `<b>${d ? esc(shortName(d.name)) : 'Sin conductor'}</b><small>${[c.n ? plural(c.n, 'vuelta', 'vueltas') : '', c.otros ? (c.n ? `${c.otros} con otro conductor` : `${plural(c.otros, 'vuelta', 'vueltas')} con otro conductor`) : '', c.deleg ? (c.deleg === 1 ? '1 delegada' : `${c.deleg} delegadas`) : ''].filter(Boolean).join(' · ')}${id ? (auto ? ' · automático' : ' · elegido') : ''}${enTurno}</small></button>`;
      });
    });
    el.drivers.innerHTML = h + '</div>' + libresHTML(cars, bands, cells);
  }
  // 0124: la placa del turno abierto de un conductor (solo si el día es hoy), o null.
  function placaDeTurno(id) {
    const a = (rt.activos || []).find((x) => x.id === id);
    return a && a.car ? a.car : null;
  }
  // 25-oct-2026: la tarjeta va por carro con vueltas, así que quien está en turno
  // sin ninguna no salía («¿y Daniel?»). Del horario publicado de los turnos que
  // tienen vueltas y, si el día es hoy, de los turnos abiertos (con el carro en
  // que lo abrió: así se ve si el carro del plan lo tiene otro).
  function libresHTML(cars, bands, cells) {
    const usados = new Set();
    cars.forEach((car) => bands.forEach((b) => { if (cells[car.id + '|' + b]) { const id = rtCarDrv(car, b); if (id) usados.add(id); } }));
    D.routes.forEach((r) => { if (r.driverId && r.fija !== 'completed') usados.add(r.driverId); });
    const libres = new Map();
    // El nombre de la lista de conductores; si no está ahí, el del horario o el del turno.
    const nom = (id, n) => { const d = (rt.drivers || []).find((x) => x.id === id); return (d && d.n) || n || 'Conductor'; };
    bands.forEach((b) => {
      const cargado = b === 'mad' ? rt.shiftPrevLoaded : rt.shiftLoaded;
      if (!cargado) return;
      poolTurno(b).forEach((d) => { if (!usados.has(d.id) && !libres.has(d.id)) libres.set(d.id, { n: nom(d.id, d.n), car: null }); });
    });
    (rt.activos || []).forEach((a) => {
      if (usados.has(a.id)) return;
      const x = libres.get(a.id) || { n: nom(a.id, a.n), car: null };
      x.car = a.car;
      libres.set(a.id, x);
    });
    if (!libres.size) return '';
    return '<p class="sub rv2-dfree" data-k="libres">También en turno, sin vueltas: '
      + [...libres.values()].map((x) => '<b>' + esc(x.n) + '</b>' + (x.car ? ' (turno abierto en ' + esc(x.car) + ')' : '')).join(', ') + '.</p>';
  }

  // 'ok' | 'bad' para una terminada, 'sinmarcar' si pasó su hora sin marcas; '' si no.
  function finFila(r) {
    if (r.fija === 'completed') return r.fin && r.fin.estado === 'bad' ? 'bad' : 'ok';
    return r.fin && r.fin.estado === 'sinmarcar' ? 'sinmarcar' : '';
  }

  function rowHTML(r) {
    const d = conductor(r.driverId);
    const sub = r.type === 'llegada' ? 'Aterriza → última entrega' : 'Recoge → llega a JMC';
    let estado;
    // Terminada (verde o roja) o pasada sin marcar (gris): la fila va degradada.
    const fin = finFila(r);
    if (r.fija === 'completed') estado = fin === 'bad'
      ? `<small class="late">Terminada · ${esc(r.fin.motivos.join(' · '))}</small>`
      : `<small class="done">Terminada${r.fin && r.fin.at ? ' ' + esc(r.fin.at) : ''}${r.fin ? ' · sin novedad' : ''}</small>`;
    else if (fin === 'sinmarcar') estado = `<small>Pasó su hora · ${plural(r.fin.faltan, 'parada', 'paradas')} sin marcar</small>`;
    else if (r.status === 'risk') estado = `<small class="late">${Math.abs(r.margin)} min tarde · presentación ${hhmm(r.pres)}</small>`;
    else if (r.type === 'llegada' && (r.wait || 0) > LLE_ESPERA_LARGA) estado = `<small class="late">Esperan ${r.wait} min el carro</small>`;
    else estado = r.type === 'llegada' ? `<small>Recoge en JMC ${hhmm(r.pickup)}</small>` : `<small>Presentación ${hhmm(r.pres)}</small>`;
    const enCurso = r.fija === 'in_progress' ? ' <span class="tag">en curso</span>' : '';
    const chips = r.stops.map((st) => {
      const a = aux(st.crewId) || {};
      const fijo = atendida(st.crewId) || r.fija === 'completed';
      const attrs = fijo ? 'disabled title="Ya atendido: no se mueve"' : `draggable="true" data-drag="${esc(st.crewId)}" data-act="move" data-crew="${esc(st.crewId)}" data-from="${esc(r.id)}" title="Arrástralo a otra vuelta o tócalo para moverlo"`;
      return `<button class="rv2-p" ${attrs}><span class="mono">${hhmm(st.time)}</span><span class="nm">${hl(a.n || 'Tripulante')}</span><span class="pl">${hl(a.zona || '')}</span></button>`;
    }).join('');
    const aria = `${r.vehicle}, ${TYPE[r.type]}, ${horas(r)}${r.status === 'risk' ? ', llega tarde' : ''}, ${r.stops.map((s) => nombre(s.crewId)).join(', ')}`;
    return `<div class="rv2-row" role="button" tabindex="0" data-id="${esc(r.id)}" data-s="${r.status}"${fin ? ` data-fin="${fin}"` : ''}${ui.sel === r.id ? ' aria-current="true"' : ''} aria-label="${esc(aria)}">` +
      `<div class="when"><b class="mono">${horas(r)}</b><small>${sub}</small>${estado}</div>` +
      `<div class="main"><div class="l1"><span class="rv2-pill ${r.type}">${TYPE[r.type]}</span><b class="car">${hl(r.vehicle)}</b>` +
      (r.delegada
        ? '<span class="drv deleg" title="La hace alguien de afuera: ningún conductor la ve">Delegada</span>'
        : `<span class="drv${d ? '' : ' none'}">${d ? hl(d.name) : 'Sin conductor'}</span>${r.propio ? ' <span class="tag own" title="Conductor puesto solo a esta vuelta">solo esta vuelta</span>' : ''}`) +
      `${enCurso}</div><div class="people">${chips}</div></div></div>`;
  }

  function emptyHTML() {
    if (ui.cargando) return '<div class="rv2-empty"><b>Cargando el día…</b>Trayendo reservas, carros y el plan publicado.</div>';
    if (rt.source === 'empty') {
      return rt.emptyReason === 'vehiculos'
        ? '<div class="rv2-empty"><b>No hay vehículos</b>Registra la flota en Turnos › Revisión › Flota para poder armar rutas.</div>'
        : `<div class="rv2-empty"><b>Sin traslados para ${esc(dayLabel(rt.day || ui.dia))}</b>Aquí aparecen los tripulantes cuando piden su traslado desde la app. Usa ‹ › para ver otro día.</div>`;
    }
    if (!hayVueltas()) {
      const n = (rt.pool || []).length;
      return `<div class="rv2-empty"><b>${plural(n, 'tripulante sin carro', 'tripulantes sin carro')}</b>Todavía no hay vueltas para este día.<br><button class="rv2-btn rv2-btn--cta" data-act="reopt">${IC.zap}Optimizar el día</button></div>`;
    }
    return null;
  }

  // El turno PM pasa la medianoche (20-oct-2026). Lo que arranca antes del corte
  // (0107, 02:00) es el CIERRE del turno PM del día anterior: antes salía como la
  // primera hora del día, igual a las demás, y parecía la primera ruta de este
  // día. Ahora va aparte y con su nombre; y al final del día se avisa de la
  // madrugada siguiente, que es de este turno PM pero vive en el plan de mañana.
  function horasHTML(rows) {
    const groups = new Map();
    rows.forEach((r) => { if (!groups.has(r.hora)) groups.set(r.hora, []); groups.get(r.hora).push(r); });
    let html = '';
    [...groups.keys()].sort((a, b) => a - b).forEach((h) => {
      const g = groups.get(h).sort((a, b) => a.arrival - b.arrival || a.pickup - b.pickup);
      const malas = g.filter((r) => r.status === 'risk' || (r.type === 'llegada' && (r.wait || 0) > LLE_ESPERA_LARGA)).length;
      html += `<div class="rv2-gwrap"><div class="rv2-hour"><strong>${pad(h)}:00 – ${pad((h + 1) % 24)}:00</strong> · ${plural(g.length, 'vuelta', 'vueltas')}${malas ? ` · <span class="t-risk">${plural(malas, 'con aviso', 'con aviso')}</span>` : ''}</div>`;
      g.forEach((r) => { html += rowHTML(r); });
      html += '</div>';
    });
    return html;
  }
  function madSigHTML() {
    const m = ui.madSig;
    if (!m || m.dia !== sumarDias(rt.day || ui.dia, 1) || !(m.vueltas || m.reservas)) return '';
    const que = m.vueltas
      ? `${plural(m.vueltas, 'vuelta', 'vueltas')}${m.sinConductor ? ` (${m.sinConductor} sin conductor)` : ''}`
      : `${plural(m.reservas, 'tripulante', 'tripulantes')}, todavía sin plan publicado`;
    return `<div class="rv2-madsig"><div><b>☾ Sigue después de medianoche · madrugada del ${esc(dayLabel(m.dia).toLowerCase())}</b>` +
      `<small>${esc(que)}. De 00:00 a ${rtHHc()} también son de este turno PM, pero se planean y publican en el día siguiente.</small></div>` +
      `<button class="rv2-btn rv2-btn--sm" data-act="nav" data-dir="1">Ver la madrugada</button></div>`;
  }
  function renderList() {
    const vacio = emptyHTML();
    if (vacio) { el.list.innerHTML = vacio + (ui.cargando ? '' : madSigHTML()); return; }
    const rows = D.routes.filter(matchesQ);
    if (!rows.length) { el.list.innerHTML = `<div class="rv2-empty"><b>Sin resultados para «${esc(ui.q)}»</b>Prueba con otro nombre, carro o conjunto.</div>`; return; }
    const mad = rows.filter((r) => r.shift === 'mad'), resto = rows.filter((r) => r.shift !== 'mad');
    let html = '';
    if (mad.length) {
      html += `<section class="rv2-mad" aria-label="Madrugada, turno PM del ${esc(rtDiaAnterior())}"><div class="rv2-madh"><b>☾ Madrugada · cierre del turno PM del ${esc(rtDiaAnterior())}</b>` +
        `<small>De 00:00 a ${rtHHc()} las hace el conductor de la tarde del ${esc(rtDiaAnterior())}. El día ${esc(dayLabel(rt.day || ui.dia).toLowerCase())} arranca a las ${rtHHc()}.</small></div>` +
        horasHTML(mad) + '</section>';
      if (resto.length) html += `<div class="rv2-dayh">${esc(dayLabel(rt.day || ui.dia))} · desde las ${rtHHc()}</div>`;
    }
    el.list.innerHTML = html + horasHTML(resto) + madSigHTML();
  }

  // Estado del vuelo (0099). Apagado o sin dato → nada (sin inventar).
  function chipVuelo(code, dir) {
    try {
      if (!code || !window.RendioVuelos) return '';
      const st = window.RendioVuelos.para(code, rt.day || ui.dia, dir);
      return st ? ' ' + window.RendioVuelos.chip(st) : '';
    } catch (_) { return ''; }
  }
  function stopsHTML(r) {
    const fija = r.fija === 'completed';
    const stops = r.stops.map((st) => {
      const a = aux(st.crewId) || {};
      const extra = r.type === 'llegada'
        ? (a.tierra ? ' · ' + esc(resTxt(a) || 'tierra') : (a.vuelo ? ' · vuelo ' + esc(a.vuelo) + chipVuelo(a.vuelo, 'lle') : ''))
        : (a.dl ? ' · pres. ' + esc(a.dl) : '') + (resTxt(a) ? ' · ' + esc(resTxt(a)) : '') + (a.vuelo ? chipVuelo(a.vuelo, 'sal') : '');
      const at = atendida(st.crewId);
      const tel = a.tel ? `<a class="rv2-ic" href="${esc(telHref(a.tel))}" aria-label="Llamar a ${esc(a.n)}">${IC.phone}</a>`
        : `<button class="rv2-ic" disabled aria-label="${esc(a.n)} no tiene teléfono registrado" title="Sin teléfono registrado">${IC.phone}</button>`;
      const mv = (at || fija)
        ? `<button class="rv2-btn rv2-btn--sm rv2-mv" disabled title="Ya atendido: no se puede mover">Atendido</button>`
        : `<button class="rv2-btn rv2-btn--sm rv2-mv" data-act="move" data-crew="${esc(st.crewId)}" data-from="${esc(r.id)}" aria-label="Mover a ${esc(a.n)}">Mover</button>`;
      // En la llegada la hora de la izquierda es cuando lo deja en la casa; sin
      // decirlo, los jefes la leían como la hora que había puesto el tripulante
      // (audio del 14-oct-2026: «¿por qué salen dos horas?»).
      const casa = r.type === 'llegada' ? 'Llega a casa · ' : '';
      return `<li draggable="${at || fija ? 'false' : 'true'}"${at || fija ? '' : ` data-drag="${esc(st.crewId)}" data-from="${esc(r.id)}"`}><span class="mono">${hhmm(st.time)}</span><div><b>${esc(a.n)}</b>${casa}${esc(lugar(st.crewId))}${extra}${at ? ' · ya atendido' : ''}</div>${tel}${mv}</li>`;
    }).join('');
    const m = r.margin;
    let end;
    if (r.type === 'llegada') {
      const tierra = r.stops.every((s) => aux(s.crewId) && aux(s.crewId).tierra);
      const reserva = tierra && r.stops.every((s) => aux(s.crewId).reserva);
      const salir = Math.round(r.pickup - r.arrival);
      // De reserva (0121): si todos salen del mismo hotel, la recogida es ahí;
      // si se mezclan, se dice que además pasa por el hotel.
      const ids = r.stops.map((s) => s.crewId), H = hotelDe(ids), h1 = H ? null : algunHotel(ids);
      const donde = H ? `Recogida en el ${esc(H.name)}` : `Recogida en JMC${h1 ? ' y en el ' + esc(h1.name) : ''}`;
      end = `<li class="end"><span class="mono">${hhmm(r.pickup)}</span><div><b>${donde}</b>${reserva ? 'Termina la asignación' : (tierra ? 'Salen del terminal' : 'Aterriza')} ${hhmm(r.arrival)}${!tierra && salir > 0 ? ` · ${salir} min para salir del aeropuerto` : ''}${r.wait ? ` · <span class="${r.wait > LLE_ESPERA_LARGA ? 't-risk' : ''}">espera ${r.wait} min</span>` : ''}</div></li>`;
    } else {
      const ids = r.stops.map((s) => s.crewId), H = hotelDe(ids), h1 = H ? null : algunHotel(ids);
      const llega = H ? `Llegada al ${esc(H.name)}` : `Llegada JMC${h1 ? ' y después el ' + esc(h1.name) : ''}`;
      end = `<li class="end"><span class="mono${m < 0 ? ' neg' : ''}">${hhmm(r.arrival)}</span><div><b>${llega}</b>Presentación ${hhmm(r.pres)} · ${BUF()} min de entrega · <span class="${m < 0 ? 't-risk' : 't-ok'}">${m < 0 ? Math.abs(m) + ' min tarde' : 'a tiempo'}</span></div></li>`;
    }
    return r.type === 'llegada' ? end + stops : stops + end;
  }

  function alertTxt(r) {
    const m = r.margin; const B = BUF();
    const choque = r.retraso ? ` · el carro termina su vuelta anterior ${r.retraso} min tarde` : '';
    if (r.fija === 'completed') {
      if (r.fin && r.fin.estado === 'bad') return `Terminada con novedad · ${r.fin.motivos.join(' · ')}`;
      return r.fin ? `Terminada${r.fin.at ? ' a las ' + r.fin.at : ''} · todos entregados, sin novedad` : 'Terminada · el conductor ya la cerró';
    }
    if (finFila(r) === 'sinmarcar') return `Pasó su hora y quedaron ${plural(r.fin.faltan, 'parada', 'paradas')} sin marcar: no se sabe si se hizo`;
    if (r.status === 'risk') return `Llega tarde · llega ${hhmm(r.arrival)}; con ${B} min de entrega no alcanza la presentación (${hhmm(r.pres)}): ${Math.abs(m)} min tarde${choque}`;
    if (r.status === 'nodriver') return `Sin conductor para el turno ${rtBandName(r.shift)} de ${r.vehicle}`;
    if (r.type === 'llegada') {
      if ((r.wait || 0) > LLE_ESPERA_LARGA) return `Esperan ${r.wait} min el carro en JMC${choque}`;
      return `A tiempo · aterrizaje ${hhmm(r.arrival)}, última entrega ${hhmm(ultima(r))}`;
    }
    return `A tiempo · llega ${hhmm(r.arrival)} a JMC; presentación ${hhmm(r.pres)}`;
  }
  const alertCls = (r) => (r.fija === 'completed' ? (finFila(r) === 'bad' ? 'risk' : 'ok') : finFila(r) === 'sinmarcar' ? 'sinmarcar' : r.status === 'risk' || (r.type === 'llegada' && (r.wait || 0) > LLE_ESPERA_LARGA) ? 'risk' : r.status === 'nodriver' ? 'nodriver' : 'ok');

  // Lo que dice cada opción de «Mover», en palabras (15-oct: sin «±0 min · ajustada»).
  function pillDe(sim) {
    const dst = sim.dst; if (!dst) return { s: 'risk', txt: 'no cabe' };
    if (sim.choque) return { s: 'risk', txt: `choca con su vuelta de las ${hhmm(sim.choque.at)}` };
    if (dst.margin == null) {
      const w = dst.wait || 0;
      return w > LLE_ESPERA_LARGA ? { s: 'risk', txt: `esperarían ${w} min` } : { s: 'ok', txt: `a tiempo · deja ${hhmm(sim.pickup)}` };
    }
    const m = dst.margin;
    return m < 0 ? { s: 'risk', txt: `llegaría ${Math.abs(m)} min tarde` } : { s: 'ok', txt: `a tiempo · recoge ${hhmm(sim.pickup)}` };
  }
  function optHTML({ lane, sim, mismo }, extra = '') {
    const p = pillDe(sim);
    // La hora ya va en el título de la opción: la píldora dice solo «a tiempo» (o el problema).
    if (p.s === 'ok') p.txt = 'a tiempo';
    const others = (rt.order[lane.id] || []).map(nombre).join(' · ');
    const tipo = lane.type === 'lle' ? 'entrega' : 'recoge';
    const sinDrv = sim.dst && !sim.dst.driverId ? ' · sin conductor' : '';
    return `<button class="rv2-opt" ${extra} data-pick="${esc(lane.id)}"><span class="t"><b>${esc(lane.car)}</b> · vuelta ${lane.vuelta} · ${tipo} ${hhmm(sim.pickup)}</span><span class="st st--${p.s}">${esc(p.txt)}</span><small>Con ${esc(others)}${mismo ? ' · mismo sector' : ''}${sim.extra ? ` · +${sim.extra} min de recorrido` : ''}${sinDrv}</small></button>`;
  }

  function impactoDe(crewId, from) {
    if (!from) return '';
    const rem = simular(crewId, from.id, null);
    return rem.srcEmpty ? `<p class="rv2-impact">${esc(from.vehicle)} queda sin pasajeros y esta vuelta se elimina.</p>`
      : rem.src && rem.src.margin == null ? `<p class="rv2-impact">Sin ${esc(nombre(crewId))}, ${esc(from.vehicle)} adelanta sus entregas (termina ${hhmm(ultima(rem.src))}).</p>`
      : rem.src ? `<p class="rv2-impact${rem.src.margin < 0 ? ' is-warn' : ''}">Sin ${esc(nombre(crewId))}, ${esc(from.vehicle)} ${rem.src.margin < 0 ? `sigue llegando ${Math.abs(rem.src.margin)} min tarde` : 'llega a tiempo'}.</p>` : '';
  }

  function renderDetail() {
    const r = ui.sel && D.byId[ui.sel];
    if (!r) {
      ui.moving = null;
      el.dhead.innerHTML = '';
      el.dtop.innerHTML = `<div class="rv2-dempty">${hayVueltas() ? 'Toca una vuelta para ver su recorrido en el mapa.' : 'Cuando haya vueltas, aquí ves su recorrido, el conductor y las paradas.'}</div>`;
      el.dbot.innerHTML = ''; el.mapwrap.hidden = true;
      return;
    }
    el.mapwrap.hidden = false;
    const fijaTxt = r.fija === 'in_progress' ? ' · en curso' : r.fija === 'completed' ? ' · terminada' : '';
    const dur = Math.max(0, Math.round((r.type === 'llegada' ? ultima(r) : r.end) - r.pickup));
    el.dhead.innerHTML = `<button class="rv2-ic rv2-back" data-act="close" aria-label="Volver a la lista">${IC.back}</button>` +
      `<div><h2>${esc(r.vehicle)} · Vuelta ${r.vuelta}</h2><p>${TYPE_LONG[r.type]} · ${horas(r)} · ${plural(r.pax, 'persona', 'personas')} · ${dur} min${fijaTxt}</p></div>` +
      `<button class="rv2-ic x" data-act="close" aria-label="Cerrar detalle">${IC.x}</button>`;
    const mv = ui.moving;
    if (mv && mv.from === r.id && r.stops.some((s) => s.crewId === mv.crew)) return renderMover(r);
    ui.moving = null; ui.todas = false;
    const d = conductor(r.driverId);
    const sug = sugerencia(r);
    const sugHTML = sug ? `<div class="rv2-sug"><h3>${IC.zap}Sugerencia de Rendio</h3>` +
      `<p>Mover a <b>${esc(nombre(sug.crewId))}</b> a <b>${esc(sug.vehicle)}</b> (la recoge a las ${hhmm(sug.pickup)}). Así las dos vueltas llegan a tiempo.</p>` +
      `<div class="acts"><button class="rv2-btn rv2-btn--cta rv2-btn--sm" data-act="apply" data-crew="${esc(sug.crewId)}" data-from="${esc(r.id)}" data-to="${esc(sug.to)}">Aplicar</button>` +
      `<button class="rv2-btn rv2-btn--sm" data-act="move" data-crew="${esc(sug.crewId)}" data-from="${esc(r.id)}">Ver otras opciones</button></div></div>`
      : (r.status === 'risk' && r.type !== 'llegada' && !r.fija ? '<p class="rv2-note">Rendio no encontró a quién mover sin dejar otra vuelta tarde. Mueve a alguien a mano, Re-optimiza o, si no hay cómo, publícala de todos modos.</p>' : '');
    const turno = rtBandName(r.shift);
    const auto = d && rt.rv2Auto && rt.rv2Auto[r.vehicle + '|' + r.shift] === r.driverId;
    const quien = r.delegada
      ? '<b>Delegada</b>La hace alguien de afuera. Ningún conductor la ve; al publicar, al tripulante le llega que lo contactan por WhatsApp'
      : r.propio
      ? (d ? `<b>${esc(d.name)}</b>Conductor solo de esta vuelta` : '<b>Sin conductor</b>Se le quitó solo a esta vuelta')
      : (d ? `<b>${esc(d.name)}</b>Conductor · turno ${turno}${auto ? ' · automático' : ''}` : `<b>Sin conductor</b>Turno ${turno} de ${esc(r.vehicle)}`);
    const drvHTML = `<div class="rv2-drv"><span class="rv2-av">${d ? esc(initials(d.name)) : r.delegada ? '↗' : '?'}</span><div>${quien}</div>` +
      (d && d.phone ? `<a class="rv2-ic" href="${esc(telHref(d.phone))}" aria-label="Llamar a ${esc(d.name)}">${IC.phone}</a>` : '') +
      (r.fija === 'completed' ? '' : `<button class="rv2-btn ${d || r.delegada ? '' : 'rv2-btn--soft'} rv2-btn--sm" data-act="assign" data-id="${esc(r.id)}">${d || r.delegada ? 'Cambiar' : 'Asignar'}</button>`) + '</div>';
    el.dtop.innerHTML = `<p class="rv2-alert rv2-alert--${alertCls(r)}">${esc(alertTxt(r))}</p>${sugHTML}`;
    el.dbot.innerHTML = `${drvHTML}<h3 class="rv2-cap">Paradas · orden de ${r.type === 'llegada' ? 'entrega' : 'recogida'}</h3><ol class="rv2-stops">${stopsHTML(r)}</ol>`;
    dibujarMapa(r);
  }

  // «Mover» dentro del detalle: el mapa se queda a la vista y cada opción se
  // previsualiza en él (al pasar el cursor o con el teclado). Tocar = mover.
  function renderMover(r) {
    const { crew } = ui.moving; const a = aux(crew) || {};
    const ops = candidatas(crew, r.id, { todas: ui.todas, max: ui.todas ? 12 : 5 });
    const st = r.stops.find((s) => s.crewId === crew);
    el.dtop.innerHTML = `<div class="rv2-mvhead"><div><h3>Mover a ${esc(a.n)} a…</h3><p>${esc(lugar(crew))} · ${a.type === 'lle' ? horaTxt(a) : 'presentación'} ${esc(a.dl)} · hoy en ${esc(r.vehicle)} (${hhmm(st ? st.time : null)})</p></div>` +
      `<button class="rv2-btn rv2-btn--sm" data-act="mvcancel">Cancelar</button></div>${impactoDe(crew, r)}`;
    el.dbot.innerHTML = `<h3 class="rv2-cap">${ui.todas ? 'Todas las vueltas con cupo' : 'Vueltas con cupo cerca de esa hora'}</h3>` +
      `<div class="rv2-mvopts" id="rv2-mvopts">${ops.length ? ops.map((o) => optHTML(o, `data-act="moveto" data-crew="${esc(crew)}" data-from="${esc(r.id)}" data-to="${esc(o.lane.id)}"`)).join('')
        : `<p class="rv2-impact">No hay ${a.type === 'lle' ? 'llegadas' : 'salidas'} con cupo ${ui.todas ? 'ese día' : 'cerca de esa hora'}.</p>`}</div>` +
      (ui.todas ? '' : '<button class="rv2-linkbtn" data-act="mvtodas">Ver todas las vueltas con cupo</button>') +
      `<button class="rv2-opt rv2-opt--drop" data-act="unroute" data-crew="${esc(crew)}" data-from="${esc(r.id)}"><span class="t"><b>Dejar sin carro</b></span><small>Queda en Avisos para ubicarlo después.</small></button>`;
    dibujarMapa(r, { note: mq('(hover: hover)') ? 'Pasa el cursor por una opción para verla en el mapa.' : '' });
  }
  function previsualizar(b) {
    const sim = simular(b.dataset.crew, b.dataset.from, b.dataset.to);
    if (!sim.dst) return;
    const p = pillDe(sim);
    dibujarMapa(sim.dst, { preview: true, focus: b.dataset.crew, note: `Vista previa: así quedaría ${sim.dst.vehicle} (${horas(sim.dst)}) con ${nombre(b.dataset.crew)} · ${p.txt}` });
  }

  /* ---------- Mapa de la vuelta (Leaflet + OSRM, como «Ver mapa» de siempre) ---------- */
  const mapa = { m: null, layer: null, tok: 0, cache: {}, actual: null };
  function dibujarMapa(r, o = {}) {
    if (!el.map) return;
    if (!o.preview) mapa.actual = r;
    el.mapNote.textContent = o.note || '';
    el.mapNote.classList.toggle('is-prev', !!o.preview);
    if (typeof L === 'undefined' || !r || typeof rtCoordsOf !== 'function') { el.map.innerHTML = '<div class="rv2-nomap">El mapa no está disponible en este momento.</div>'; mapa.m = null; return; }
    const coords = r.stops.map((s) => ({ s, p: rtCoordsOf(s.crewId) })).filter((x) => x.p && isFinite(x.p.lat) && isFinite(x.p.lng));
    const pts = r.type === 'llegada' ? [RT_AIRPORT, ...coords.map((x) => x.p)] : [...coords.map((x) => x.p), RT_AIRPORT];
    try {
      if (!mapa.m) {
        el.map.innerHTML = '';
        mapa.m = L.map(el.map, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa.m);
        mapa.layer = L.layerGroup().addTo(mapa.m);
      }
      const tok = ++mapa.tok;
      mapa.layer.clearLayers();
      const color = r.type === 'llegada' ? '#1BB07E' : '#E2551A';
      const recta = L.polyline(pts.map((p) => [p.lat, p.lng]), { color, weight: 3, opacity: 0.5, dashArray: '4 8' }).addTo(mapa.layer);
      const key = pts.map((p) => `${(+p.lng).toFixed(5)},${(+p.lat).toFixed(5)}`).join(';');
      const pinta = (g) => {
        if (tok !== mapa.tok || !g) return;
        mapa.layer.removeLayer(recta);
        L.polyline(g, { color, weight: 5, opacity: o.preview ? 0.65 : 0.9, dashArray: o.preview ? '10 8' : null }).addTo(mapa.layer);
      };
      if (key in mapa.cache) pinta(mapa.cache[key]);
      else if (pts.length >= 2) {
        fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`)
          .then((x) => x.json())
          .then((j) => { mapa.cache[key] = (j && j.code === 'Ok' && j.routes && j.routes[0]) ? j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]) : null; pinta(mapa.cache[key]); })
          .catch(() => { mapa.cache[key] = null; });
      }
      const pin = (cls, tx) => L.divIcon({ className: '', html: `<div class="rv2-mk ${cls}">${tx}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      L.marker([RT_AIRPORT.lat, RT_AIRPORT.lng], { icon: L.divIcon({ className: '', html: '<div class="rv2-mk jmc">JMC</div>', iconSize: [40, 24], iconAnchor: [20, 12] }) }).addTo(mapa.layer);
      // Dos tripulantes del mismo conjunto son UNA parada (un número, los dos nombres).
      const paradas = [];
      coords.forEach(({ s, p }) => {
        const k = (+p.lat).toFixed(5) + ',' + (+p.lng).toFixed(5);
        const ya = paradas.find((x) => x.k === k);
        if (ya) ya.ids.push(s.crewId); else paradas.push({ k, p, t: s.time, ids: [s.crewId] });
      });
      paradas.forEach((x, i) => {
        const nuevo = o.focus && x.ids.includes(o.focus);
        L.marker([x.p.lat, x.p.lng], { icon: pin(`${r.type === 'llegada' ? 'lle' : 'sal'}${nuevo ? ' new' : ''}`, String(i + 1)) })
          .bindTooltip(`<b>${hhmm(x.t)}</b> · ${x.ids.map((id) => esc(nombre(id))).join(', ')}<br>${esc(lugar(x.ids[0]))}`, { direction: 'top', offset: [0, -12] })
          .addTo(mapa.layer);
      });
      mapa.m.invalidateSize();
      if (pts.length) mapa.m.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [28, 28], animate: false });
    } catch (_) { /* sin mapa: la lista de paradas sigue diciendo todo */ }
  }
  function refrescarMapa() { if (mapa.m) { try { mapa.m.invalidateSize(); } catch (_) { /* */ } if (mapa.actual) dibujarMapa(mapa.actual); } }

  function render() {
    if (!root()) return;
    if (ui.manual && !ui.cargando && window.RendioRutaJulian) { renderManual(); return; }
    if (!ui.cargando) autoLlenar();
    D = armarDia();
    if (ui.sel && !D.byId[ui.sel]) { ui.sel = null; ui.moving = null; }
    const av = avisosDe();
    renderBar(); renderSay(av); renderAvisos(av); renderDrivers(); renderList(); renderDetail();
  }

  // 0125: el día va con la ruta de Julián. El tablero (Avisos, Conductores, mover,
  // Publicar, Re-optimizar) no aplica: los conductores toman las vueltas.
  function renderManual() {
    D = armarDia();
    renderBar();
    el.summary.hidden = true; el.avisos.innerHTML = ''; el.drivers.innerHTML = '';
    el.say.hidden = false; el.say.classList.add('is-ok');
    el.say.innerHTML = '<i aria-hidden="true"></i><span><b>Este día va con la ruta de Julián.</b> Los conductores toman las vueltas en su app; aquí ves cuáles faltan.</span>';
    el.list.innerHTML = window.RendioRutaJulian.diaHTML(ui.manual.vueltas, ui.dia, ui.manual.otras);
    ui.sel = null;
    if (el.detail) { el.detail.classList.remove('is-open'); if (el.dhead) el.dhead.innerHTML = ''; if (el.dtop) el.dtop.innerHTML = ''; if (el.dbot) el.dbot.innerHTML = ''; if (el.mapwrap) el.mapwrap.hidden = true; }
    [el.publish, el.publishM, el.reopt].forEach((b) => { if (b) { b.disabled = true; b.title = 'Este día va con la ruta de Julián'; } });
    el.publishLabel.textContent = 'Ruta de Julián publicada'; el.pending.hidden = true;
    el.publishM.textContent = 'Ruta de Julián publicada';
  }

  /* ---------- 6. Acciones ---------- */
  function snapshot(label) { hist.push({ label, f: foto() }); if (hist.length > 20) hist.shift(); }
  function undo() {
    const h = hist.pop(); if (!h) return;
    // Si quedan pasos, el aviso trae otra vez «Deshacer» (hasta 20 pasos atrás).
    restaurar(h.f); ui.moving = null; render(); toast(hist.length ? `Cambio deshecho · quedan ${hist.length}` : 'Cambio deshecho', true);
  }
  function commit(msg) { render(); toast(msg, true); }

  function moveCrew(crewId, fromId, toId, efecto) {
    const to = rtLaneOf(toId); if (!to) return;
    snapshot('mover');
    aplicarMovida(crewId, fromId, toId);
    ui.moving = null;
    if (fromId && ui.sel === fromId && !(rt.order[fromId] || []).length) ui.sel = toId;
    commit(`${nombre(crewId)} quedó en ${to.car}${efecto ? ' · ' + efecto : ''}`);
  }
  // «Dejar sin carro»: vuelve a los sin carro (y a Avisos) y la vuelta de origen
  // se reprograma sin esa persona.
  function sacarDeRuta(crewId, fromId) {
    const from = rtLaneOf(fromId); if (!from) return;
    snapshot('sin carro');
    rt.order[fromId] = (rt.order[fromId] || []).filter((x) => x !== crewId);
    if (!rt.pool.includes(crewId)) rt.pool.push(crewId);
    encadenar(from.car); reprogramar(from);
    ui.moving = null;
    commit(`${nombre(crewId)} quedó sin carro · aparece en Avisos`);
  }

  // Las vueltas seguidas de un mismo conductor que no cuadran: se cruzan, o la
  // siguiente empieza antes de que alcance a llegar (mismos tiempos de enlace()).
  // Si las dos ya arrancaron no se marca: ahí no hay nada que cambiar. Si solo
  // una arrancó, el aviso apunta a la otra (`cambiar`).
  function choquesDeConductor() {
    const out = [], por = {};
    D.routes.forEach((r) => { if (r.driverId) (por[r.driverId] = por[r.driverId] || []).push(r); });
    Object.keys(por).forEach((id) => {
      const rs = por[id].sort((x, y) => inicioDe(x).at - inicioDe(y).at);
      for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1], b = rs[i];
        if (a.fija && b.fija) continue;
        const cruza = inicioDe(b).at < finDe(a).at;
        const e = cruza ? null : enlace(a, b);
        if (cruza || e.tarde > TOL_CHOQUE) out.push({ id, a, b, cruza, e, cambiar: b.fija ? a : b });
      }
    });
    return out;
  }

  function slotsSinConductor() {
    const slots = new Map();
    D.routes.forEach((r) => { if (!r.driverId && !r.propio && r.fija !== 'completed') { const k = r.vehicle + '|' + r.shift; if (!slots.has(k)) slots.set(k, r); } });
    return slots;
  }
  const usadoEn = (shift, driverId, exceptCar) => (rt.cars || []).find((c) => c.id !== exceptCar && rtCarDrv(c, shift) === driverId) || null;
  function poolTurno(shift) { return (typeof rtPoolFor === 'function' ? rtPoolFor(shift) : rt.drivers) || []; }

  function assignDriver(carId, shift, driverId) {
    const car = rt.cars.find((c) => c.id === carId); if (!car) return;
    const otro = usadoEn(shift, driverId, carId);
    if (otro) { toast(`${conductor(driverId).name} ya maneja ${otro.id} en el turno ${rtBandName(shift)}: no puede estar en dos carros a la vez.`); return; }
    snapshot('conductor');
    rtSetCarDrv(car, shift, driverId);
    commit(`${conductor(driverId).name} asignado a ${carId} · turno ${rtBandName(shift)}`);
  }
  // Cambiar a alguien que ya maneja otro carro en el mismo turno = intercambiarlos.
  function swapDriver(carId, shift, driverId) {
    const car = rt.cars.find((c) => c.id === carId); const otro = usadoEn(shift, driverId, carId);
    if (!car || !otro) return assignDriver(carId, shift, driverId);
    snapshot('conductor');
    const mio = rtCarDrv(car, shift) || null;
    rtSetCarDrv(otro, shift, mio); rtSetCarDrv(car, shift, driverId);
    commit(`${conductor(driverId).name} pasa a ${carId}${mio ? ` y ${conductor(mio).name} a ${otro.id}` : ''} · turno ${rtBandName(shift)}`);
  }

  function autoAssign() {
    const slots = [...slotsSinConductor().entries()].sort((a, b) => a[1].depart - b[1].depart);
    snapshot('autoasignar');
    let n = 0;
    slots.forEach(([k]) => {
      const [carId, shift] = k.split('|');
      const car = rt.cars.find((c) => c.id === carId); if (!car) return;
      const d = poolTurno(shift).find((x) => !usadoEn(shift, x.id, null));
      if (d) { rtSetCarDrv(car, shift, d.id); n++; }
    });
    if (!n) { hist.pop(); render(); toast('No hay conductores libres en el turno para asignar'); return; }
    const faltan = slots.length - n;
    commit(`${n} conductor${n > 1 ? 'es' : ''} asignado${n > 1 ? 's' : ''} automáticamente${faltan ? ` · ${faltan} sin conductor libre` : ''}`);
  }

  async function reoptimizar() {
    if (ui.manual) { toast('Este día va con la ruta de Julián: quítala para volver al tablero.'); return; }
    if (rt.source !== 'live' || ui.optimizando || typeof rtOptimize !== 'function') return;
    const enCurso = Object.keys(rt.rv2Fijas || {}).length;
    if (enCurso && !window.confirm(`Hay ${plural(enCurso, 'vuelta', 'vueltas')} en curso o terminada${enCurso > 1 ? 's' : ''}. Re-optimizar arma el día desde cero; lo que el conductor ya atendió no se mueve al publicar. ¿Seguir?`)) return;
    snapshot('reoptimizar');
    ui.optimizando = true; renderBar();
    try {
      await rtOptimize({ toast: (m) => toast(m, true) });
      rt.rv2Fijas = {}; rt.rv2Fin = {};
    } catch (e) {
      hist.pop();
      toast('No se pudo optimizar: ' + ((e && e.message) || 'error'));
    } finally { ui.optimizando = false; }
    ui.sel = null; ui.moving = null; render(); autoSelect();
  }

  async function publicar() {
    if (ui.publicando || typeof rtSavePlan !== 'function') return;
    ui.publicando = true; renderSay(avisosDe());
    let res = null;
    try { res = await rtSavePlan({ toast: (m) => toast(m) }); }
    catch (e) { toast('No se pudo publicar: ' + ((e && e.message) || 'error')); }
    finally { ui.publicando = false; }
    render();
    return res;
  }

  function abrirWhatsApp() {
    const W = window.RendioWhatsApp;
    if (W && typeof W.abrir === 'function') { try { W.abrir(); } catch (e) { toast('No se pudo abrir: ' + ((e && e.message) || 'error')); } return; }
    toast('Aún no disponible');
  }

  /* ---------- 7. Hojas ---------- */
  let lastFocus = null;
  function openSheet(html) {
    lastFocus = document.activeElement;
    el.sheet.innerHTML = '<div class="rv2-handle" aria-hidden="true"></div>' + html;
    el.sheet.hidden = false; el.scrim.hidden = false;
    const f = el.sheet.querySelector('[aria-checked="true"]:not(:disabled), .rv2-opt:not(:disabled), .rv2-sh-foot .rv2-btn--cta:not(:disabled), button:not([data-act="sclose"]):not(:disabled)');
    if (f) f.focus();
  }
  function closeSheet() {
    el.sheet.hidden = true; el.sheet.innerHTML = '';
    if (!(esCajon() && el.detail.classList.contains('is-open'))) el.scrim.hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  const sheetHead = (title, sub) => `<div class="rv2-sh-head"><div><h2 id="rv2-shTitle">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button class="rv2-ic" data-act="sclose" aria-label="Cerrar">${IC.x}</button></div>`;
  const setLabel = () => el.sheet.setAttribute('aria-labelledby', 'rv2-shTitle');

  // Ubicar a alguien SIN carro (desde Avisos): hoja con las vueltas posibles.
  // Mover a alguien que ya va en una vuelta se hace en el detalle (con el mapa).
  function openMove(crewId) {
    const a = aux(crewId); if (!a) return;
    const sugeridas = candidatas(crewId, null);
    let sel = (sugeridas[0] && sugeridas[0].lane.id) || null;
    const sub = `${esc(lugar(crewId))} · ${a.type === 'lle' ? horaTxt(a) : 'presentación'} ${esc(a.dl)}`;
    let mostradas = [];
    const draw = (q = '') => {
      if (q) {
        const nq = norm(q);
        mostradas = candidatas(crewId, null, { todas: true }).filter(({ lane }) => norm(lane.car + ' ' + (rt.order[lane.id] || []).map(nombre).join(' ')).includes(nq)).slice(0, 8);
      } else mostradas = sugeridas.slice(0, 3);
      if (sel && !mostradas.some((o) => o.lane.id === sel) && !q) sel = mostradas[0] ? mostradas[0].lane.id : null;
      $('#rv2-opts').innerHTML = mostradas.length ? mostradas.map((o) => optHTML(o, `role="radio" aria-checked="${o.lane.id === sel}"`)).join('')
        : `<p class="rv2-impact">${q ? 'No hay vueltas compatibles con ese criterio.' : `No hay ${a.type === 'lle' ? 'llegadas' : 'salidas'} con cupo cerca de esa hora. Busca otro carro o re-optimiza el día.`}</p>`;
      $('#rv2-optsCap').textContent = q ? 'Resultados' : 'Sugeridas · mismo sector primero';
    };
    openSheet(sheetHead(`Ubicar a ${esc(a.n)}`, sub) +
      `<div class="rv2-sh-body"><h3 class="rv2-cap" id="rv2-optsCap"></h3><div id="rv2-opts" role="radiogroup" aria-label="Vueltas destino" style="display:flex;flex-direction:column;gap:8px"></div>` +
      `<label class="rv2-search" style="width:100%;height:44px">${IC.search}<input id="rv2-optq" type="search" placeholder="Buscar otra vuelta o carro" autocomplete="off" aria-label="Buscar otra vuelta o carro"></label></div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-doMove">Mover</button></div>`);
    setLabel();
    const btn = $('#rv2-doMove');
    const sync = () => { const l = sel && rtLaneOf(sel); btn.disabled = !l; btn.textContent = l ? `Mover a ${l.car}` : 'Elige una vuelta'; };
    draw(); sync();
    const fc = $('#rv2-opts [aria-checked="true"]') || $('#rv2-opts .rv2-opt'); if (fc) fc.focus();
    $('#rv2-opts').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; sel = b.dataset.pick; draw($('#rv2-optq').value.trim()); sync(); const n = $$('#rv2-opts [data-pick]').find((x) => x.dataset.pick === sel); if (n) n.focus(); });
    let t = null;
    $('#rv2-optq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value.trim()), 120); });
    btn.addEventListener('click', () => { if (!sel) return; const to = sel; const fx = pillDe(simular(crewId, null, to)).txt; closeSheet(); moveCrew(crewId, null, to, fx); });
  }

  // «Cambiar» en una vuelta = el conductor de ESA vuelta (26-oct-2026). Antes
  // abría la hoja del carro, que cambia todas sus vueltas del turno: la profa
  // quiso darle una sola a otro conductor y se le movió toda la programación.
  function openAssign(routeId) { return openAssignVuelta(routeId); }

  // Dónde y cuándo empieza y termina una vuelta, para saber si un conductor
  // alcanza a llegar de una a otra. Misma cuenta que libreDe: tras una salida
  // queda en JMC + TURNAROUND; tras una llegada, en la última casa (+2).
  const inicioDe = (r) => (r.type === 'llegada' || !r.stops.length
    ? { at: r.pickup, loc: 'airport' }
    : { at: r.stops[0].time, loc: r.stops[0].crewId });
  const finDe = (r) => (r.type === 'llegada'
    ? { at: r.end, loc: r.stops.length ? r.stops[r.stops.length - 1].crewId : 'airport', colchon: 2 }
    : { at: r.arrival, loc: 'airport', colchon: rt.TURNAROUND || 8 });
  const tramoMin = (a, b) => (a === b ? 0 : (typeof rtLegMin === 'function' ? rtLegMin(a, b) : 0));
  // De la vuelta `a` a la `b`: a qué hora llegaría y cuántos minutos tarde (≤ 0 = alcanza).
  function enlace(a, b) {
    const f = finDe(a), i = inicioDe(b);
    const llega = Math.round(f.at + f.colchon + tramoMin(f.loc, i.loc));
    return { llega, tarde: llega - i.at };
  }
  // Las otras vueltas de un conductor alrededor de `r`: la que se cruza, la de
  // antes y la de después.
  function alcanceDe(driverId, r) {
    const suyas = D.routes.filter((x) => x.id !== r.id && x.driverId === driverId).sort((x, y) => inicioDe(x).at - inicioDe(y).at);
    const ini = inicioDe(r).at, fin = finDe(r).at;
    const choque = suyas.find((x) => inicioDe(x).at < fin && ini < finDe(x).at) || null;
    const antes = suyas.filter((x) => finDe(x).at <= ini).pop() || null;
    const despues = suyas.find((x) => inicioDe(x).at >= fin) || null;
    return { choque, antes, despues, a: antes ? enlace(antes, r) : null, d: despues ? enlace(r, despues) : null };
  }
  function alcanceTxt(al) {
    const de = (x) => `${x.type === 'llegada' ? 'su llegada' : 'su vuelta'} de las ${hhmm(inicioDe(x).at)}`;
    if (al.choque) return { cls: 'st--risk', pill: 'Ocupado', txt: `tiene ${de(al.choque)} (hasta las ${hhmm(finDe(al.choque).at)})` };
    const partes = []; let peor = 0;
    if (al.a) {
      partes.push(al.a.tarde > TOL_CHOQUE ? `viene de ${de(al.antes)}: llegaría a las ${hhmm(al.a.llega)}, ${al.a.tarde} min tarde` : `viene de ${de(al.antes)} y alcanza (llega a las ${hhmm(al.a.llega)})`);
      peor = Math.max(peor, al.a.tarde);
    }
    if (al.d) {
      partes.push(al.d.tarde > TOL_CHOQUE ? `no alcanza ${de(al.despues)} (${al.d.tarde} min tarde)` : `alcanza ${de(al.despues)}`);
      peor = Math.max(peor, al.d.tarde);
    }
    if (!partes.length) partes.push('no tiene otras vueltas ese día');
    return peor > TOL_CHOQUE ? { cls: 'st--adj', pill: 'No alcanza', txt: partes.join(' · ') } : { cls: 'st--ok', pill: 'Alcanza', txt: partes.join(' · ') };
  }

  function openAssignVuelta(routeId) {
    const r = D.byId[routeId]; if (!r) return;
    const car = rt.cars.find((c) => c.id === r.vehicle);
    const cur = r.driverId || null;
    const delCarro = car ? rtCarDrv(car, r.shift) : null;
    const pool = poolTurno(r.shift);
    const enPool = new Set(pool.map((d) => d.id));
    const otros = (rt.drivers || []).filter((d) => !enPool.has(d.id));
    const cargado = r.shift === 'mad' ? rt.shiftPrevLoaded : rt.shiftLoaded;
    const nota = cargado
      ? (r.shift === 'mad' ? `En turno PM del ${rtDiaAnterior()} según el horario publicado (las vueltas antes de las ${rtHHc()})` : `En turno ${rtBandName(r.shift)} según el horario publicado`)
      : 'Sin horario publicado para ese día: se muestran todos los conductores';
    const turno = rtBandName(r.shift);
    const opt = (d, fuera) => {
      const full = (rt.drivers || []).find((x) => x.id === d.id) || {};
      if (d.id === cur) return `<button class="rv2-opt" role="radio" aria-checked="false" data-pick="${esc(d.id)}" disabled><span class="t"><b>${esc(d.n)}</b></span><span class="st st--ok">Actual</span><small>${esc(['hace esta vuelta', full.tel || ''].filter(Boolean).join(' · '))}</small></button>`;
      const al = alcanceTxt(alcanceDe(d.id, r));
      const small = [al.txt, fuera ? 'no está en este turno en el horario' : '', full.tel || ''].filter(Boolean).join(' · ');
      return `<button class="rv2-opt" role="radio" aria-checked="false" data-pick="${esc(d.id)}"><span class="t"><b>${esc(d.n)}</b></span><span class="st ${al.cls}">${esc(al.pill)}</span><small>${esc(small)}</small></button>`;
    };
    const extra = [];
    if (r.propio) extra.push(`<button class="rv2-opt" role="radio" aria-checked="false" data-pick="__carro"><span class="t"><b>Como el resto de ${esc(r.vehicle)}</b></span><small>${delCarro ? esc(conductor(delCarro).name) + ', el conductor de ' + esc(r.vehicle) + ' en el turno ' + esc(turno) : esc(r.vehicle) + ' no tiene conductor en el turno ' + esc(turno)}</small></button>`);
    // 0126: la hace alguien de afuera (el carro del jefe, un Uber).
    if (!r.delegada) extra.push(`<button class="rv2-opt rv2-opt--deleg" role="radio" aria-checked="false" data-pick="__deleg"><span class="t"><b>Delegar esta vuelta</b></span><small>La hace alguien de afuera (tu carro, un Uber). Ningún conductor la ve; al publicar, al tripulante le llega «Tu servicio fue delegado, te contactaremos por WhatsApp».</small></button>`);
    if (cur) extra.push(`<button class="rv2-opt rv2-opt--drop" role="radio" aria-checked="false" data-pick="__none"><span class="t"><b>Quitar el conductor de esta vuelta</b></span><small>Queda sin conductor y nadie la ve hasta que le pongas uno.</small></button>`);
    let sel = null;
    openSheet(sheetHead('Conductor de esta vuelta', `${esc(r.vehicle)} · ${esc(TYPE[r.type])} de las ${hhmm(inicioDe(r).at)}${r.delegada ? ' · hoy está delegada' : ''} · solo cambia esta vuelta: las demás y sus horas quedan igual`) +
      `<div class="rv2-sh-body"><h3 class="rv2-cap">${esc(nota)}</h3><div id="rv2-dopts" role="radiogroup" aria-label="Conductor de esta vuelta" style="display:flex;flex-direction:column;gap:8px">` +
      (pool.length ? pool.map((d) => opt(d, false)).join('') : `<p class="rv2-impact">Nadie en turno ${esc(turno)} ese día en el horario publicado. Puedes elegir otro conductor abajo.</p>`) +
      (cargado && otros.length ? `<h3 class="rv2-cap" style="margin-top:6px">Otros conductores</h3>` + otros.map((d) => opt(d, true)).join('') : '') +
      (extra.length ? `<h3 class="rv2-cap" style="margin-top:6px">O bien</h3>` + extra.join('') : '') +
      `</div><button class="rv2-linkbtn rv2-linkbtn--ink" data-act="assignslot" data-car="${esc(r.vehicle)}" data-shift="${esc(r.shift)}">Cambiar el conductor de todas las vueltas de ${esc(r.vehicle)} en el turno ${esc(turno)}</button></div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-doAssign" disabled>Elige un conductor</button></div>`);
    setLabel();
    const btn = $('#rv2-doAssign');
    $('#rv2-dopts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; sel = b.dataset.pick;
      $$('#rv2-dopts [data-pick]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.pick === sel)));
      btn.disabled = !sel;
      btn.textContent = sel === '__none' ? 'Quitar de esta vuelta' : sel === '__deleg' ? 'Delegar esta vuelta' : 'Asignar a esta vuelta';
    });
    btn.addEventListener('click', () => { if (!sel) return; const s = sel; closeSheet(); setVueltaDriver(r.id, s); });
  }
  // Pone (o quita) el conductor de UNA vuelta. No re-encadena ni re-programa
  // nada: las otras vueltas y las horas de todas quedan como estaban.
  function setVueltaDriver(laneId, pick) {
    const lane = rtLaneOf(laneId); if (!lane) return;
    const r = D.byId[laneId];
    const car = rt.cars.find((c) => c.id === lane.car);
    const delCarro = car ? rtCarDrv(car, rtBandOf(lane)) : null;
    snapshot('conductor de una vuelta');
    const cual = `la vuelta de las ${hhmm(r ? inicioDe(r).at : rtToMin(lane.start))} de ${lane.car}`;
    let msg;
    delete lane.deleg;
    if (pick === '__carro') { delete lane.drv; msg = `${cual} vuelve a ${delCarro ? conductor(delCarro).name : 'quedar sin conductor, como el carro'}`; }
    else if (pick === '__none') { lane.drv = false; msg = `${cual} quedó sin conductor · las demás no cambian`; }
    else if (pick === '__deleg') { lane.drv = false; lane.deleg = true; msg = `${cual} queda delegada · al publicar se le avisa al tripulante`; }
    else { if (pick === delCarro) delete lane.drv; else lane.drv = pick; msg = `${conductor(pick).name} hace ${cual} · las demás no cambian`; }
    commit(msg.charAt(0).toUpperCase() + msg.slice(1));
  }
  function openAssignSlot(carId, shift) {
    const car = rt.cars.find((c) => c.id === carId); if (!car) return;
    const cur = rtCarDrv(car, shift);
    const pool = poolTurno(shift);
    const opts = pool.map((d) => ({ d, otro: usadoEn(shift, d.id, car.id) }));
    // El jefe manda (13-oct-2026): además de los del turno, cualquier otro
    // conductor, por si hace falta cubrir con alguien que no estaba programado.
    const enPool = new Set(pool.map((d) => d.id));
    const otros = (rt.drivers || []).filter((d) => !enPool.has(d.id)).map((d) => ({ d, otro: usadoEn(shift, d.id, car.id) }));
    let sel = cur || (opts.find((o) => !o.otro) || {}).d?.id || null;
    const slots = slotsSinConductor();
    const cargado = shift === 'mad' ? rt.shiftPrevLoaded : rt.shiftLoaded;
    const nota = cargado
      ? (shift === 'mad' ? `En turno PM del ${rtDiaAnterior()} según el horario publicado (las vueltas antes de las ${rtHHc()})` : `En turno ${rtBandName(shift)} según el horario publicado`)
      : 'Sin horario publicado para ese día: se muestran todos los conductores';
    const curName = cur ? conductor(cur).name : null;
    const auto = cur && rt.rv2Auto && rt.rv2Auto[carId + '|' + shift] === cur;
    const optBtn = ({ d, otro }, fuera) => {
      const full = (rt.drivers || []).find((x) => x.id === d.id) || {};
      const pill = d.id === cur ? '<span class="st st--ok">Actual</span>' : otro ? `<span class="st st--off">Maneja ${esc(otro.id)}</span>` : fuera ? '<span class="st st--adj">Fuera de turno</span>' : '<span class="st st--ok">Libre</span>';
      const small = [full.tel || '', otro ? `si lo eliges, ${curName ? esc(curName) + ' pasa a ' + esc(otro.id) : esc(otro.id) + ' queda sin conductor'}` : (d.id === cur ? 'asignado a este carro' : fuera ? 'no está en este turno en el horario' : 'sin carro en este turno')].filter(Boolean).join(' · ');
      return `<button class="rv2-opt" role="radio" aria-checked="${d.id === sel}" data-pick="${esc(d.id)}"><span class="t"><b>${esc(d.n)}</b></span>${pill}<small>${small}</small></button>`;
    };
    const propias = (D && D.routes ? D.routes : []).filter((x) => x.vehicle === carId && x.shift === shift && x.propio).length;
    openSheet(sheetHead(`Conductor para ${esc(carId)}`, `Turno ${rtBandName(shift)} · aplica a todas sus vueltas de ese turno${propias ? ` (menos ${propias === 1 ? 'la que tiene' : `las ${propias} que tienen`} conductor propio)` : ''}${curName ? ' · hoy: ' + esc(curName) + (auto ? ' (automático)' : '') : ''}`) +
      `<div class="rv2-sh-body"><h3 class="rv2-cap">${esc(nota)}</h3><div id="rv2-dopts" role="radiogroup" aria-label="Conductores disponibles" style="display:flex;flex-direction:column;gap:8px">` +
      (opts.length ? opts.map((o) => optBtn(o, false)).join('') : `<p class="rv2-impact">Nadie en turno ${rtBandName(shift)} ese día en el horario publicado. Puedes elegir otro conductor abajo.</p>`) +
      (cargado && otros.length ? `<h3 class="rv2-cap" style="margin-top:6px">Otros conductores</h3>` + otros.map((o) => optBtn(o, true)).join('') : '') +
      `</div>${slots.size > 1 ? `<button class="rv2-btn" data-act="autoassign" style="margin-top:4px">Autoasignar todos los carros sin conductor (${slots.size})</button>` : ''}</div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-doAssign"${sel && sel !== cur ? '' : ' disabled'}>Asignar</button></div>`);
    setLabel();
    $('#rv2-dopts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; sel = b.dataset.pick;
      $$('#rv2-dopts [data-pick]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.pick === sel)));
      $('#rv2-doAssign').disabled = !sel || sel === cur;
    });
    $('#rv2-doAssign').addEventListener('click', () => { if (!sel) return; const s = sel; closeSheet(); swapDriver(car.id, shift, s); });
  }

  function openPublish() {
    if (ui.manual) { toast('Este día va con la ruta de Julián: los conductores toman las vueltas.'); return; }
    if (!hayVueltas()) { toast('No hay vueltas para publicar todavía.'); return; }
    const c = counts(D.routes);
    const unr = (rt.pool || []).length;
    const espera = D.routes.filter((r) => r.type === 'llegada' && r.fija !== 'completed' && (r.wait || 0) > LLE_ESPERA_LARGA).length;
    const delegadas = D.routes.filter((r) => r.delegada && r.fija !== 'completed').length;
    const item = (ok, warn, title, sub, k) => `<div class="rv2-check"><span class="ico ${ok ? 'ok' : warn ? 'warn' : 'bad'}" aria-hidden="true">${ok ? '✓' : warn ? '!' : '✕'}</span><div>${title}<small>${sub}</small></div>${ok ? '' : `<button class="rv2-btn rv2-btn--sm" data-act="goto" data-k="${k}">Ver</button>`}</div>`;
    const blocking = c.risk + c.nodriver + unr;
    const conductoresConVuelta = new Set(D.routes.map((r) => r.driverId).filter(Boolean)).size;
    const yaPub = publicado();
    const aviso = yaPub
      ? `<p class="rv2-impact">Este plan ya está publicado: <b>los conductores ya lo tienen</b>. Si publicas otra vez reciben la versión nueva y el aviso «Ruta asignada»; a los tripulantes solo se les avisa si les cambió el conductor. Lo que un conductor ya atendió no se mueve.</p>`
      : '';
    const forzarItems = [c.risk ? plural(c.risk, 'vuelta que llega tarde a la presentación', 'vueltas que llegan tarde a la presentación') : '',
      c.nodriver ? plural(c.nodriver, 'vuelta sin conductor (queda en borrador, nadie la ve)', 'vueltas sin conductor (quedan en borrador, nadie las ve)') : '',
      unr ? plural(unr, 'tripulante sin carro', 'tripulantes sin carro') : ''].filter(Boolean);
    openSheet(sheetHead(yaPub ? (conCambios() ? 'Publicar cambios' : 'Volver a publicar') : 'Publicar plan', `${plural(c.all, 'vuelta', 'vueltas')} · se avisa a ${plural(conductoresConVuelta, 'conductor', 'conductores')} y a los tripulantes`) +
      `<div class="rv2-sh-body">${aviso}` +
      item(!c.risk, false, c.risk ? `${plural(c.risk, 'vuelta llega', 'vueltas llegan')} tarde` : 'Todas llegan a tiempo', 'Deben llegar antes de la hora de presentación.', 'risk') +
      item(!c.nodriver, false, c.nodriver ? `${plural(c.nodriver, 'vuelta', 'vueltas')} sin conductor` : 'Todos los carros con conductor', 'Cada carro necesita conductor en cada turno con vueltas.', 'nodriver') +
      item(!unr, false, unr ? `${plural(unr, 'tripulante', 'tripulantes')} sin carro` : 'Todos los tripulantes con carro', 'Nadie puede quedar sin carro.', 'unrouted') +
      (espera ? item(false, true, `${plural(espera, 'llegada', 'llegadas')} con espera larga en JMC`, `Esperan más de ${LLE_ESPERA_LARGA} min el carro. No bloquea.`, 'wait') : '') +
      (delegadas ? item(true, false, `${plural(delegadas, 'vuelta delegada', 'vueltas delegadas')}`, 'Ningún conductor las ve. A sus tripulantes les llega «Tu servicio fue delegado, te contactaremos por WhatsApp».', 'deleg') : '') +
      (blocking ? `<button class="rv2-linkbtn" id="rv2-forceOpen" aria-expanded="false" aria-controls="rv2-force">Publicar de todos modos…</button>` +
        `<div class="rv2-force" id="rv2-force" hidden><p>Vas a publicar con:</p><ul>${forzarItems.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` +
        ((c.risk || c.nodriver) ? `<label class="rv2-ack"><input type="checkbox" id="rv2-forceRisk"> Entiendo que ${c.risk && c.nodriver ? 'hay vueltas tarde y sin conductor' : c.risk ? 'hay vueltas que llegan tarde' : 'hay vueltas sin conductor'} y publico así.</label>` : '') +
        (unr ? `<label class="rv2-ack"><input type="checkbox" id="rv2-forceUnr"> Entiendo que ${plural(unr, 'tripulante queda', 'tripulantes quedan')} sin carro.</label>` : '') +
        `</div>` : '') +
      `</div><div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button>` +
      `<button class="rv2-btn rv2-btn--cta" id="rv2-doPublish"${blocking ? ' disabled' : ''}>${blocking ? `Faltan ${blocking} pendiente${blocking > 1 ? 's' : ''}` : yaPub ? 'Publicar de nuevo' : 'Publicar'}</button>` +
      (blocking ? `<button class="rv2-btn rv2-btn--danger" id="rv2-doForce" hidden disabled>Publicar de todos modos</button>` : '') + `</div>`);
    setLabel();
    const btn = $('#rv2-doPublish');
    const fOpen = $('#rv2-forceOpen'); const fBox = $('#rv2-force'); const fBtn = $('#rv2-doForce');
    const fRisk = $('#rv2-forceRisk'); const fUnr = $('#rv2-forceUnr');
    const sync = () => { if (fBtn) fBtn.disabled = !((!fRisk || fRisk.checked) && (!fUnr || fUnr.checked)); };
    sync();
    [fRisk, fUnr].forEach((x) => { if (x) x.addEventListener('change', sync); });
    if (fOpen) fOpen.addEventListener('click', () => {
      const abrir = fBox.hidden; fBox.hidden = !abrir; fBtn.hidden = !abrir; btn.hidden = abrir;
      fOpen.setAttribute('aria-expanded', String(abrir));
      fOpen.textContent = abrir ? 'No, mejor lo reviso' : 'Publicar de todos modos…';
      sync(); if (abrir) (fRisk || fUnr || fBtn).focus();
    });
    const go = async () => { closeSheet(); await publicar(); };
    btn.addEventListener('click', () => { if (!btn.disabled) go(); });
    if (fBtn) fBtn.addEventListener('click', () => { if (!fBtn.disabled) go(); });
  }

  /* ---------- Avisos y selección ---------- */
  let toastTimer = null;
  function toast(msg, withUndo = false) {
    if (!el.toast) return;
    el.toast.innerHTML = `<span>${esc(msg)}</span>${withUndo && hist.length ? '<button data-act="undo">Deshacer</button>' : ''}`;
    el.toast.hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, withUndo ? 6000 : 3200);
  }
  function select(id, { open = true, moving = null } = {}) {
    ui.sel = id; ui.moving = moving; ui.todas = false;
    $$('.rv2-row', root()).forEach((row) => { if (row.dataset.id === id) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
    renderDetail();
    if (open && esCajon()) {
      el.detail.classList.add('is-open'); el.scrim.hidden = false;
      const b = el.detail.querySelector('[data-act="close"]'); if (b) b.focus();
      setTimeout(refrescarMapa, 280);   // el cajón termina de entrar: Leaflet mide de nuevo
    }
  }
  function verRuta(id) {
    select(id);
    if (!esCajon()) { const row = $$('.rv2-row', root()).find((x) => x.dataset.id === id); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function closeDetail() {
    el.detail.classList.remove('is-open');
    if (el.sheet.hidden) el.scrim.hidden = true;
    const row = ui.sel && $$('.rv2-row', root()).find((r) => r.dataset.id === ui.sel); if (row) row.focus();
  }
  // En PC el detalle se abre solo con la primera vuelta que llega tarde (o la
  // primera del día): el mapa nunca queda vacío.
  function autoSelect() {
    if (esCajon() || ui.sel || !D) return;
    const first = D.routes.filter((r) => r.status === 'risk').sort((a, b) => a.arrival - b.arrival)[0]
      || D.routes.slice().sort((a, b) => a.pickup - b.pickup)[0];
    if (first) select(first.id, { open: false });
  }

  /* ---------- Arrastrar un tripulante a otra vuelta (PC) ---------- */
  function puedeRecibir(laneId, crewId, fromId) {
    if (!laneId || laneId === fromId || fijaDe(laneId)) return false;
    const l = rtLaneOf(laneId); const a = aux(crewId);
    if (!l || !a || (l.type || 'sal') !== a.type) return false;
    return rtPaxOf(rt.order[l.id] || []) + (a.pax || 1) <= rtCapOf(rtCarOf(l));
  }
  function finDrag() {
    ui.drag = null;
    const r = root(); if (r) r.classList.remove('is-dragging');
    $$('.rv2-row.is-drop, .rv2-row.is-over', root()).forEach((x) => x.classList.remove('is-drop', 'is-over'));
  }
  function onDragStart(e) {
    const p = e.target.closest && e.target.closest('[data-drag]'); if (!p) return;
    const crewId = p.dataset.drag; const fromId = p.dataset.from || null;
    if (!aux(crewId)) return;
    ui.drag = { crewId, fromId };
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', crewId); } catch (_) { /* */ }
    root().classList.add('is-dragging');
    $$('.rv2-row', root()).forEach((row) => row.classList.toggle('is-drop', puedeRecibir(row.dataset.id, crewId, fromId)));
  }
  function onDragOver(e) {
    if (!ui.drag) return;
    const row = e.target.closest && e.target.closest('.rv2-row.is-drop');
    $$('.rv2-row.is-over', root()).forEach((x) => { if (x !== row) x.classList.remove('is-over'); });
    if (!row) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* */ }
    row.classList.add('is-over');
  }
  function onDrop(e) {
    if (!ui.drag) return;
    const row = e.target.closest && e.target.closest('.rv2-row.is-drop');
    const { crewId, fromId } = ui.drag;
    finDrag();
    if (!row) return;
    e.preventDefault();
    const fx = pillDe(simular(crewId, fromId, row.dataset.id)).txt;
    moveCrew(crewId, fromId, row.dataset.id, fx);
  }

  /* ---------- 8. Carga del día, vistas y eventos ---------- */
  // Rearma en rt lo que ya está publicado para ese día (route_assignments),
  // para que la pantalla muestre EL PLAN QUE TIENEN LOS CONDUCTORES y no un
  // tablero vacío con todos «sin rutear». Mismas reglas que rtSolveDay para el
  // número de vuelta, el origen y la hora de aterrizaje.
  async function rearmarPublicado() {
    rt.firmaPublicada = null; rt.rv2Fijas = {}; rt.rv2Atendidas = {}; rt.rv2Auto = {}; rt.horasPub = {}; rt.rv2Fin = {};
    ui.manual = null; rt.manualDia = false;
    if (rt.source !== 'live' || !rt.day || !window.Api || typeof Api.getPublishedPlan !== 'function') return false;
    let plan = null;
    try { plan = await Api.getPublishedPlan(rt.day, { estados: ESTADOS_PLAN }); } catch (_) { return false; }
    const todas = (plan && plan.vueltas) || [];
    // 0125: las vueltas que pegó Julián (pool) no entran al tablero: el día se
    // muestra con su ruta y los conductores las toman (admin-ruta-julian.js).
    const deEste = (v) => !v.manualDay || v.manualDay === rt.day;
    const pegadas = todas.filter((v) => v.pool && deEste(v));
    const vueltas = todas.filter((v) => !v.pool);
    // La madrugada que Julián pegó con el día ANTERIOR cae en esta ventana: esas
    // personas ya van en una vuelta suya, así que el tablero no las vuelve a rutear.
    const ajenas = new Set(todas.filter((v) => v.pool && !deEste(v))
      .flatMap((v) => [...(v.pendientes || []), ...(v.atendidas || [])].map((x) => x.rid)));
    if (ajenas.size) Object.keys(rt.aux).forEach((k) => { if (ajenas.has(rt.aux[k].reservationId)) delete rt.aux[k]; });
    ui.manual = pegadas.length ? { vueltas: pegadas, otras: vueltas.length } : null;
    rt.manualDia = !!ui.manual;
    if (!vueltas.length) return false;
    const porReserva = {};
    Object.keys(rt.aux).forEach((k) => { const r = rt.aux[k].reservationId; if (r) porReserva[r] = k; });
    const lanes = [], order = {}, usados = new Set(), nCarro = {}, fijas = {}, atendidas = {}, horas = {}, guardado = {}, fines = {};
    const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5);
    // 0124: cada vuelta vuelve a su carro del plan («Carro 1»). Las publicadas
    // antes de 0124 no lo traen: se reparten por placa en los carros del plan
    // que estén libres (la misma placa, el mismo carro), y solo si no queda
    // ninguno se agrega uno con su placa.
    const porPlaca = {};
    const libreParaPlaca = () => rt.cars.find((c) => !Object.values(porPlaca).includes(c.id)
      && !vueltas.some((x) => x.planCar === c.id));
    vueltas.slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).forEach((v) => {
      let car = v.planCar ? rt.cars.find((c) => c.id === v.planCar) : null;
      if (!car && !v.planCar && v.vehicleId) car = rt.cars.find((c) => c.vehicleId && c.vehicleId === v.vehicleId) || null;
      if (!car && !v.planCar && v.vehicleId) {
        if (!porPlaca[v.vehicleId]) { const c = libreParaPlaca(); if (c) porPlaca[v.vehicleId] = c.id; }
        car = rt.cars.find((c) => c.id === porPlaca[v.vehicleId]) || null;
      }
      if (!car) {
        let id = v.planCar || v.carro || 'Carro'; while (rt.cars.some((c) => c.id === id)) id += '·';
        car = { id, avail0: '00:00', driver: null, capacity: v.cap || rt.CAP, vehicleId: null };
        rt.cars.push(car);
        if (!v.planCar && v.vehicleId) porPlaca[v.vehicleId] = car.id;
      }
      const stops = [...(v.atendidas || []), ...(v.pendientes || [])].sort((a, b) => a.order - b.order);
      const ids = stops.map((s) => porReserva[s.rid]).filter((k) => k && !usados.has(k));
      if (!ids.length) return;
      ids.forEach((k) => usados.add(k));
      (v.atendidas || []).forEach((s) => { const k = porReserva[s.rid]; if (k) atendidas[k] = s.status; });
      const n = (nCarro[car.id] || 0) + 1; nCarro[car.id] = n;
      const lane = { id: `${car.id}·V${n}`, car: car.id, vuelta: n, type: v.type === 'lle' ? 'lle' : 'sal', start: hm(v.startAt), origin: null };
      if (lane.type === 'lle') { lane.origin = 'airport'; lane.landing = rtToHM(horaVuelta(ids)); }
      lanes.push(lane); order[lane.id] = ids;
      guardado[lane.id] = v.delegated ? 'deleg' : (v.driverProfileId || null);
      // La hora guardada (rtHorasPub, admin-rutas.js): en una salida la de cada
      // parada; en una llegada basta el arranque (la salida de JMC).
      const etas = {};
      if (lane.type !== 'lle') stops.forEach((s) => { const k = porReserva[s.rid]; if (k && s.etaAt) etas[k] = rtToMin(hm(s.etaAt)); });
      horas[lane.id] = { start: lane.start, sig: ids.join(','), etas };
      // Arrancada = 'in_progress' o con paradas ya atendidas (nada en la app pasa una
      // ruta a 'in_progress'; la que el conductor va haciendo sigue en 'planned').
      if (v.status === 'in_progress' || v.status === 'completed') fijas[lane.id] = v.status;
      else if ((v.atendidas || []).length) fijas[lane.id] = 'in_progress';
      // Todas sus paradas resueltas = terminada, aunque la base la deje 'planned'.
      if (v.fin && (v.fin.estado === 'ok' || v.fin.estado === 'bad')) fijas[lane.id] = 'completed';
      if (v.fin) fines[lane.id] = v.fin;
      if (v.driverProfileId) {
        if (!(rt.drivers || []).some((d) => d.id === v.driverProfileId)) rt.drivers.push({ id: v.driverProfileId, n: v.conductor || 'Conductor', c: '#8895a7' });
        const banda = rtBandOf(lane);
        rtSetCarDrv(car, banda, rtCarDrv(car, banda) || v.driverProfileId);
      }
    });
    if (!lanes.length) return false;
    // Conductor propio (26-oct-2026): una vuelta guardada con otro conductor que
    // el de su carro en ese turno (o sin conductor, y el carro sí tiene) vuelve
    // con ESE conductor. Si no, se vería el del carro y al re-publicar se perdería
    // el cambio de una sola vuelta.
    lanes.forEach((l) => {
      const car = rt.cars.find((c) => c.id === l.car);
      const g = guardado[l.id], delCarro = car ? rtCarDrv(car, rtBandOf(l)) : null;
      if (g === 'deleg') { l.drv = false; l.deleg = true; return; }   // 0126
      if (g && g !== delCarro) l.drv = g;
      else if (!g && delCarro) l.drv = false;
    });
    rt.lanes = lanes; rt.order = order; rt.horasPub = horas;
    rt.pool = Object.keys(rt.aux).filter((k) => !usados.has(k));
    rt.rv2Fijas = fijas; rt.rv2Atendidas = atendidas; rt.rv2Fin = fines;
    rt.cars.forEach((c) => encadenar(c.id));
    rt.optimized = true;
    rt.firmaPublicada = firmaActual();
    return true;
  }

  async function cargarDia(day) {
    ui.cargando = true; ui.sel = null; ui.moving = null; hist.length = 0;
    if (el.detail) el.detail.classList.remove('is-open');
    if (root() && !root().hidden) render();
    try {
      await rtLoad(day || undefined);
      ui.dia = rt.day || day || hoyBog();
      rt.rv2Auto = {};
      const hay = await rearmarPublicado();
      // Sin tiempos por carretera las ETAs saldrían en línea recta. Para LEER
      // lo publicado no se gasta TomTom (cobra por celda): caché si la hay, si
      // no OSRM. Re-optimizar sí pide tráfico, como siempre.
      if (hay && typeof rtBuildMatrix === 'function') {
        try { rt.etaSource = await rtBuildMatrix({ sinTrafico: true }); } catch (_) { /* cae a línea recta */ }
      }
    } catch (e) {
      toast('No se pudo cargar el día: ' + ((e && e.message) || 'error'));
    } finally { ui.cargando = false; }
    rotularVieja();
    // La madrugada del día siguiente (es de este turno PM): llega después, como los vuelos.
    const diaPedido = ui.dia;
    if (window.Api && Api.getMadrugadaSiguiente) {
      Api.getMadrugadaSiguiente(diaPedido, rtCut())
        .then((m) => { if (ui.dia !== diaPedido) return; ui.madSig = m; if (root() && !root().hidden) render(); })
        .catch(() => {});
    }
    // Los vuelos del día (si la integración está encendida) llegan después y
    // solo agregan el chip en el detalle.
    if (window.RendioVuelos) window.RendioVuelos.cargar(ui.dia).then(() => { if (root() && !root().hidden) render(); }).catch(() => {});
    if (root() && !root().hidden) { render(); autoSelect(); }
    else if (typeof rtRenderAll === 'function') { rtRenderAll(); syncVieja(); }
  }

  // Lo que la app puso SOLA (conductores automáticos) no cuenta como «cambio sin
  // publicar» para preguntar al cambiar de día ni para quedarse con lo que hay al
  // volver a la pestaña: al recargar se vuelve a poner igual.
  function firmaSinAuto() {
    const auto = Object.keys(rt.rv2Auto || {});
    if (!auto.length) return firmaActual();
    const antes = auto.map((k) => { const [carId, b] = k.split('|'); const car = rt.cars.find((c) => c.id === carId); const v = car ? rtCarDrv(car, b) : null; if (car && v === rt.rv2Auto[k]) rtSetCarDrv(car, b, null); return [car, b, v]; });
    const f = firmaActual();
    antes.forEach(([car, b, v]) => { if (car) rtSetCarDrv(car, b, v); });
    return f;
  }
  const cambiosPropios = () => rt.source === 'live' && hayVueltas() && firmaSinAuto() !== rt.firmaPublicada;

  async function cambiarDia(delta) {
    if (ui.cargando) return;
    const base = rt.day || ui.dia || hoyBog();
    if (cambiosPropios() && !window.confirm(`Hay cambios sin publicar en ${dayLabel(base)}. Si cambias de día se pierden. ¿Cambiar de todos modos?`)) return;
    await cargarDia(sumarDias(base, delta));
  }

  function rotularVieja() {
    const lab = $('#rt-dayLabel');
    const day = rt.day || ui.dia;
    if (lab && day) { const rel = relDia(day); lab.textContent = rel ? `${rel} · ${dayLabel(day)}` : dayLabel(day); }
  }
  // Botones de la vista anterior que dependen del estado (los pinta ella misma
  // al optimizar; al llegar desde la v2 hay que ponerlos a mano).
  function syncVieja() {
    const opt = $('#rt-optBtn'); if (opt) { opt.disabled = rt.source === 'empty'; opt.innerHTML = `<svg class="icon"><use href="#i-bolt"/></svg>${rt.optimized ? 'Re-optimizar' : 'Optimizar'}`; }
    const save = $('#rt-saveBtn'); if (save) save.style.display = (rt.source === 'live' && rt.day && hayVueltas()) ? '' : 'none';
  }

  // La vista anterior ya no se ofrece en pantalla (15-oct: un solo modo). Sigue
  // en el código y se puede volver a ella con RendioRutasV2.aVista('v1').
  const pref = () => { try { return localStorage.getItem(KEY_VISTA) === 'v1' ? 'v1' : 'v2'; } catch (_) { return 'v2'; } };
  const setPref = (v) => { try { localStorage.setItem(KEY_VISTA, v); } catch (_) { /* sin almacenamiento: la elección dura la sesión */ } ui.vista = v; };
  const disponible = () => !!(root() && $('#routes-ui') && typeof rt !== 'undefined');
  const activa = () => disponible() && (ui.vista || pref()) !== 'v1';

  function mostrar(v) {
    bind();
    const r = root(); const old = $('#routes-ui'); if (!r || !old) return;
    const nueva = v !== 'v1';
    r.hidden = !nueva;
    old.classList.toggle('rv2-fuera', nueva);
    const link = $('#rt-vistaNueva'); if (link) link.hidden = nueva;
    if (!nueva && el.sheet) { el.sheet.hidden = true; el.scrim.hidden = true; el.toast.hidden = true; el.detail.classList.remove('is-open'); }
  }
  function ocultar() { mostrar('v1'); }

  async function entrar() {
    bind();
    mostrar('v2');
    medir();
    if (typeof rtBindOnce === 'function') rtBindOnce();   // el overlay «Optimizando…» vive en la vista anterior
    el.sheet.hidden = true; el.scrim.hidden = true; el.detail.classList.remove('is-open');
    if (ui.cargando) { render(); return; }               // ya hay una carga en curso
    // Volver a la pestaña no borra lo que se estaba armando: si hay cambios sin
    // publicar del mismo día se quedan (y se dice de cuándo son los datos, por
    // si entró una reserva después). Si no, se carga fresco.
    if (rt.day && cambiosPropios()) {
      render(); autoSelect();
      const hora = rt.cargadoEn ? new Date(rt.cargadoEn).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      toast(`Tus cambios sin publicar siguen aquí${hora ? ` · datos de las ${hora}` : ''}. Para recargar, cambia de día y vuelve.`);
      return;
    }
    await cargarDia(ui.dia || null);
  }

  async function aVista(v) {
    setPref(v);
    if (v === 'v1') {
      mostrar('v1');
      if (typeof rtBindOnce === 'function') rtBindOnce();
      if (rt.cargadoEn) { rotularVieja(); rtRenderAll(); syncVieja(); }
      else if (typeof renderRoutes === 'function') await renderRoutes();
      return;
    }
    bind(); mostrar('v2'); medir();
    if (rt.cargadoEn && (rt.optimized || rt.source === 'empty')) { ui.dia = rt.day || ui.dia; render(); autoSelect(); }
    else await cargarDia(rt.day || ui.dia || null);
  }

  function bind() {
    if (bound) return;
    const r = root(); if (!r) return;
    bound = true;
    Object.assign(el, {
      list: $('#rv2-list'), listwrap: $('#rv2-listwrap'), detail: $('#rv2-detail'), summary: $('#rv2-summary'),
      avisos: $('#rv2-avisos'), drivers: $('#rv2-drivers'), say: $('#rv2-say'),
      scrim: $('#rv2-scrim'), sheet: $('#rv2-sheet'), toast: $('#rv2-toast'),
      dayLabel: $('#rv2-dayLabel'), pubChip: $('#rv2-pubChip'), reopt: $('#rv2-reopt'), reoptLabel: $('#rv2-reoptLabel'),
      publish: $('#rv2-publish'), publishLabel: $('#rv2-publishLabel'), pending: $('#rv2-pending'), publishM: $('#rv2-publishM'),
      q: $('#rv2-q'),
    });
    // Esqueleto del detalle: el mapa queda fijo (Leaflet no se rearma en cada
    // cambio); arriba y abajo se repintan.
    el.detail.innerHTML = '<div class="rv2-dhead" id="rv2-dhead"></div><div class="rv2-dbody"><div class="rv2-dtop" id="rv2-dtop"></div>' +
      '<div class="rv2-mapwrap" id="rv2-mapwrap" hidden><p class="rv2-mapnote" id="rv2-mapNote" aria-live="polite"></p><div class="rv2-map" id="rv2-map" role="img" aria-label="Mapa del recorrido de la vuelta"></div></div>' +
      '<div class="rv2-dbot" id="rv2-dbot"></div></div>';
    Object.assign(el, { dhead: $('#rv2-dhead'), dtop: $('#rv2-dtop'), dbot: $('#rv2-dbot'), mapwrap: $('#rv2-mapwrap'), map: $('#rv2-map'), mapNote: $('#rv2-mapNote') });
    const panel = r.closest('section[data-panel]') || document;
    panel.addEventListener('click', onClick);
    el.q.addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = e.target.value.trim(); renderList(); }, 120); });
    el.publish.addEventListener('click', openPublish);
    el.publishM.addEventListener('click', openPublish);
    el.reopt.addEventListener('click', reoptimizar);
    $('#rv2-wa').addEventListener('click', abrirWhatsApp);
    // 0125: la ruta de Julián y el Excel del día (con la estructura del Formulario).
    if ($('#rv2-julian')) $('#rv2-julian').addEventListener('click', () => { if (window.RendioRutaJulian) window.RendioRutaJulian.abrir(); });
    if ($('#rv2-xlsx')) $('#rv2-xlsx').addEventListener('click', () => { if (window.RendioRutaJulian) window.RendioRutaJulian.excel(); });
    document.addEventListener('keydown', onKey);
    r.addEventListener('dragstart', onDragStart);
    r.addEventListener('dragover', onDragOver);
    r.addEventListener('drop', onDrop);
    r.addEventListener('dragend', finDrag);
    // Vista previa en el mapa al pasar por una opción de «Mover» (o con el teclado).
    const prev = (e) => {
      const b = e.target.closest && e.target.closest('[data-act="moveto"]');
      if (b) { if (ui.prevDe !== b) { ui.prevDe = b; previsualizar(b); } return; }
      if (ui.prevDe && !(e.target.closest && e.target.closest('#rv2-mvopts'))) { ui.prevDe = null; if (mapa.actual) dibujarMapa(mapa.actual, { note: mq('(hover: hover)') && ui.moving ? 'Pasa el cursor por una opción para verla en el mapa.' : '' }); }
    };
    el.detail.addEventListener('mouseover', prev);
    el.detail.addEventListener('focusin', prev);
    if (typeof ResizeObserver === 'function') {
      let last = '';
      new ResizeObserver(() => {
        const antes = r.dataset.lay; medir();
        const k = `${r.dataset.lay}|${r.dataset.fila}|${r.dataset.det}`;
        if (k === last) return; last = k;
        if (antes !== r.dataset.lay) { el.detail.classList.remove('is-open'); if (el.sheet.hidden) el.scrim.hidden = true; if (r.dataset.lay === 'lado') autoSelect(); }
        refrescarMapa();
      }).observe(r);
    }
  }
  let qTimer = null;

  function onClick(e) {
    const t = e.target;
    if (!t.closest('#routes-v2, #rv2-sheet, #rv2-scrim, #rv2-toast')) return;
    const act = t.closest('[data-act]');
    if (act) {
      if (act.disabled) return;
      const a = act.dataset.act; e.stopPropagation();
      if (a === 'assign') return openAssign(act.dataset.id);
      if (a === 'assignslot') return openAssignSlot(act.dataset.car, act.dataset.shift);
      if (a === 'move') {
        if (!el.sheet.hidden) closeSheet();
        if (!act.dataset.from) return openMove(act.dataset.crew);
        return select(act.dataset.from, { moving: { crew: act.dataset.crew, from: act.dataset.from } });
      }
      if (a === 'route') return openMove(act.dataset.crew);
      if (a === 'moveto') { ui.prevDe = null; return moveCrew(act.dataset.crew, act.dataset.from, act.dataset.to, pillDe(simular(act.dataset.crew, act.dataset.from, act.dataset.to)).txt); }
      if (a === 'mvcancel') { ui.moving = null; return renderDetail(); }
      if (a === 'mvtodas') { ui.todas = true; return renderDetail(); }
      if (a === 'unroute') return sacarDeRuta(act.dataset.crew, act.dataset.from);
      if (a === 'apply') return moveCrew(act.dataset.crew, act.dataset.from, act.dataset.to);
      if (a === 'autoassign') { closeSheet(); return autoAssign(); }
      if (a === 'ver') return verRuta(act.dataset.id);
      if (a === 'avisos') { e.preventDefault(); if (el.avisos.scrollIntoView) el.avisos.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (a === 'sclose') return closeSheet();
      if (a === 'close') return closeDetail();
      if (a === 'undo') { el.toast.hidden = true; return undo(); }
      if (a === 'reopt') return reoptimizar();
      if (a === 'goto') {
        closeSheet();
        const k = act.dataset.k;
        if (k === 'risk' || k === 'wait') { const r = D.routes.find((x) => (k === 'risk' ? x.status === 'risk' : x.type === 'llegada' && (x.wait || 0) > LLE_ESPERA_LARGA)); if (r) verRuta(r.id); return; }
        const box = k === 'nodriver' ? el.drivers : el.avisos;
        if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (a === 'nav') return cambiarDia(Number(act.dataset.dir) || 0);
      if (a === 'vista') return aVista(act.dataset.v);
      return;
    }
    const row = t.closest('.rv2-row');
    if (row) return select(row.dataset.id);
    if (t === el.scrim) { if (!el.sheet.hidden) closeSheet(); else closeDetail(); }
  }

  function onKey(e) {
    const r = root(); if (!r || r.hidden) return;
    const panel = r.closest('section[data-panel]');
    if (panel && panel.classList.contains('hidden')) return;
    const mapaOvl = $('#rt-mapOvl.show');
    if (mapaOvl) { if (e.key === 'Escape' && typeof rtCloseMap === 'function') rtCloseMap(); return; }
    const ae = document.activeElement || document.body;
    const typing = /INPUT|SELECT|TEXTAREA/.test(ae.tagName);
    if (e.key === 'Escape') {
      if (!el.sheet.hidden) { e.preventDefault(); return closeSheet(); }
      if (ui.moving) { e.preventDefault(); ui.moving = null; return renderDetail(); }
      if (el.detail.classList.contains('is-open')) { e.preventDefault(); return closeDetail(); }
      if (ae === el.q) { el.q.value = ''; ui.q = ''; renderList(); }
      return;
    }
    if (!el.sheet.hidden) return;
    if (e.key === '/' && !typing) { e.preventDefault(); el.q.focus(); return; }
    const row = ae.closest && ae.closest('.rv2-row');
    if (row && ae === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(row.dataset.id); return; }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !el.detail.classList.contains('is-open')) {
      const rows = $$('.rv2-row', r); if (!rows.length) return;
      e.preventDefault();
      let i = rows.findIndex((x) => x.dataset.id === ui.sel);
      i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      const id = rows[i].dataset.id;
      select(id, { open: false });
      const nr = $$('.rv2-row', r).find((x) => x.dataset.id === id); if (nr) { nr.focus(); if (nr.scrollIntoView) nr.scrollIntoView({ block: 'nearest' }); }
    }
  }

  // La vista anterior trae el enlace «Vista nueva» escondido: solo se muestra
  // si este archivo cargó (si no, la vista anterior sigue siendo la única).
  function init() {
    const link = $('#rt-vistaNueva');
    if (link) link.addEventListener('click', () => aVista('v2'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.RendioRutasV2 = {
    activa, entrar, ocultar, mostrar, aVista, cambiarDia, cargarDia, rotularVieja, render,
    // Para las pruebas y para depurar desde la consola (no lo usa la app).
    // 0125: la ruta de Julián (admin-ruta-julian.js) usa la hoja, el aviso y el día.
    _sheet: { open: openSheet, close: closeSheet, head: sheetHead }, toast, diaActual: () => ui.dia,
    _ui: ui, _hist: hist, dia: () => D, medir, sugerencia: (id) => sugerencia(D && D.byId[id]), candidatas, _mover: moveCrew,
    _avisos: () => avisosDe(), _sacar: sacarDeRuta,
  };
})();
