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
  const fijaDe = (laneId) => (rt.rv2Fijas && rt.rv2Fijas[laneId]) || null;
  const atendida = (id) => !!(rt.rv2Atendidas && rt.rv2Atendidas[id]);
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
      lane.start = rtToHM(rtRedondea5Arr(Math.max(ideal, piso)));
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
    const retraso = d > TOL_CHOQUE ? Math.round(d) : 0;
    const fija = fijaDe(lane.id);
    const stops = c.stops.map((s) => ({ crewId: s.id, time: s.eta + retraso }));
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
    let status;
    if (fija === 'completed') status = 'ok';
    else if (margin != null && margin < 0) status = 'risk';
    else if (!driverId) status = 'nodriver';
    else if ((margin != null && margin < ADJ_MIN) || (wait != null && wait > LLE_ESPERA_LARGA)) status = 'adj';
    else status = 'ok';
    const pickup = lle ? start + retraso : stops[0].time;
    return {
      id: lane.id, lane, vuelta: lane.vuelta, vehicle: car.id, cap: rtCapOf(car), type,
      depart: start + retraso, pickup, arrival, end, pres, margin, wait, retraso,
      stops, pax: c.pax, driverId, shift, status, fija, etaSource: rt.etaSource || null,
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
  const sinPublicar = () => rt.source === 'live' && hayVueltas() && firmaActual() !== rt.firmaPublicada;

  /* ---------- 3. Mover / simular (con el modelo de tiempos real) ---------- */
  const foto = () => ({ lanes: clone(rt.lanes), order: clone(rt.order), pool: rt.pool.slice(), drv: rt.cars.map((c) => [c.driverAM || null, c.driverPM || null, c.driverMad || null]), optimized: rt.optimized, fijas: clone(rt.rv2Fijas || {}) });
  function restaurar(f) {
    rt.lanes = clone(f.lanes); rt.order = clone(f.order); rt.pool = f.pool.slice(); rt.optimized = f.optimized;
    rt.rv2Fijas = clone(f.fijas || {});
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
  const ui = { filter: 'all', type: '', q: '', view: 'lista', sel: null, groupOpen: {}, showOk: new Set(), cargando: false, dia: null, publicando: false, optimizando: false };
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
    const det = C >= 1500 ? 420 : 380;
    const L = lado ? C - 34 - 16 - det : C - 34;
    r.dataset.lay = lado ? 'lado' : 'cajon';
    r.dataset.det = String(det);
    r.dataset.fila = L >= 1000 ? 'xl' : L >= 860 ? 'md' : L >= 600 ? 'sm' : 'tarjeta';
  }

  /* ---------- 5. Render ---------- */
  const visibleBase = () => D.routes.filter((r) => !ui.type || r.type === ui.type);

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

  function renderStatus() {
    const base = visibleBase(); const c = counts(base);
    el.readyN.textContent = c.ok;
    el.totalN.textContent = c.all;
    el.fill.style.width = (c.all ? (c.ok / c.all) * 100 : 0) + '%';
    const chip = (k, label, n) => `<button class="rv2-chip" data-k="${k}" aria-pressed="${ui.filter === k}">${label} <b>${n}</b></button>`;
    el.chips.innerHTML = chip('all', 'Todas', c.all) + chip('risk', 'En riesgo', c.risk) + chip('nodriver', 'Sin conductor', c.nodriver) +
      chip('adj', 'Ajustadas', c.adj) + chip('ok', 'Listas', c.ok) + chip('unrouted', 'Sin rutear', c.unrouted + ' aux.');
    const allC = counts(D.routes);
    const blocking = allC.risk + allC.nodriver + allC.unrouted;
    const pend = blocking + allC.adj;
    el.pending.textContent = pend;
    el.pending.hidden = pend === 0;
    el.pending.setAttribute('aria-label', `${pend} pendientes`);
    const pubLabel = publicado() && !conCambios() ? 'Publicado' : publicado() ? 'Publicar cambios' : 'Publicar plan';
    el.publishLabel.textContent = ui.publicando ? 'Publicando…' : pubLabel;
    const can = rt.source === 'live' && hayVueltas() && !ui.cargando && !ui.publicando;
    el.publish.disabled = !can;
    el.publishM.disabled = !can;
    el.publishM.innerHTML = ui.publicando ? 'Publicando…' : publicado() && !conCambios() ? 'Plan publicado' : `${pubLabel} · <span>${pend}</span> pendientes`;
    renderHist(base);
  }

  function renderHist(base) {
    const per = Array.from({ length: 24 }, () => ({ n: 0, risk: false }));
    base.forEach((r) => { per[r.hora].n++; if (r.status === 'risk') per[r.hora].risk = true; });
    const max = Math.max(...per.map((p) => p.n), 1);
    const sr = ui.sel && D.byId[ui.sel];
    const selH = sr ? sr.hora : -1;
    el.hist.innerHTML = per.map((p, h) => {
      const hgt = Math.round((p.n / max) * 46);
      return `<button class="rv2-hb${h === selH ? ' on' : ''}" data-hour="${h}" aria-label="${pad(h)}:00, ${plural(p.n, 'ruta', 'rutas')}${p.risk ? ', con rutas en riesgo' : ''}">` +
        (p.risk ? `<span class="dot" style="bottom:${hgt + 21}px" aria-hidden="true"></span>` : '') +
        `<i style="height:${Math.max(hgt, p.n ? 3 : 2)}px"></i><span>${h % 2 === 0 ? pad(h) : ''}</span></button>`;
    }).join('');
  }

  function namesOf(r) { return r.stops.map((st) => nombre(st.crewId)); }
  function rowHTML(r) {
    const s = r.status; const m = r.margin; const d = conductor(r.driverId);
    const names = namesOf(r);
    const shown = names.slice(0, 3).map(hl).join(' · ') + (names.length > 3 ? ` <span class="more">+${names.length - 3}</span>` : '');
    let mgTxt, mgCls, mgTitle;
    if (m == null) {
      const w = r.wait || 0;
      mgTxt = w > LLE_ESPERA_LARGA ? `esp. ${w}` : '—';
      mgCls = w > LLE_ESPERA_LARGA ? 'adj' : 'ok';
      mgTitle = w > 0 ? `El tripulante espera ${w} min en JMC` : 'No aplica para llegadas';
    } else {
      mgTxt = signed(m); mgCls = m < 0 ? 'neg' : m < ADJ_MIN ? 'adj' : 'ok';
      mgTitle = `Margen contra la hora de presentación, ya descontados ${BUF()} min de entrega`;
    }
    const aria = `${r.vehicle}, ${LABEL[s]}, ${timeSpan(r)}, ${names.join(', ')}`;
    return `<div class="rv2-row" role="button" tabindex="0" data-id="${esc(r.id)}" data-s="${s}"${ui.sel === r.id ? ' aria-current="true"' : ''} aria-label="${esc(aria)}">` +
      `<span class="st st--${s}">${LABEL[s]}</span>` +
      `<span class="time">${timeSpan(r)}</span>` +
      `<span class="car"><b>${hl(r.vehicle)}</b> <span>· ${TYPE[r.type]}</span></span>` +
      `<span class="names">${shown}</span>` +
      `<span class="mg ${mgCls}" title="${esc(mgTitle)}">${mgTxt}</span>` +
      (d ? `<span class="drv">${hl(d.name)}</span>`
        : `<span class="drv"><button class="rv2-btn rv2-btn--soft rv2-btn--sm" data-act="assign" data-id="${esc(r.id)}">+ Asignar</button></span>`) +
      `</div>`;
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
      return `<div class="rv2-empty"><b>${plural(n, 'tripulante sin rutear', 'tripulantes sin rutear')}</b>Todavía no hay rutas para este día.<br><button class="rv2-btn rv2-btn--cta" data-act="reopt">${IC.zap}Optimizar el día</button></div>`;
    }
    return null;
  }

  function renderList() {
    el.listwrap.hidden = ui.view !== 'lista';
    el.carros.hidden = ui.view !== 'carros';
    if (ui.view === 'carros') return renderCarros();
    if (ui.filter === 'unrouted') return renderUnrouted();
    const vacio = emptyHTML();
    if (vacio) { el.list.innerHTML = vacio; return; }
    const filtering = ui.filter !== 'all' || !!ui.q;
    const rows = visibleBase().filter((r) => (ui.filter === 'all' || r.status === ui.filter) && matchesQ(r));
    if (!rows.length) {
      el.list.innerHTML = `<div class="rv2-empty"><b>${ui.q ? 'Sin resultados para «' + esc(ui.q) + '»' : 'Nada por aquí'}</b>${ui.filter === 'risk' ? 'Ninguna ruta llega tarde a presentación.' : ui.filter === 'nodriver' ? 'Todos los carros tienen conductor.' : 'Prueba con otro filtro.'}</div>`;
      return;
    }
    const groups = new Map();
    rows.forEach((r) => { if (!groups.has(r.hora)) groups.set(r.hora, []); groups.get(r.hora).push(r); });
    let html = '';
    [...groups.keys()].sort((a, b) => a - b).forEach((h) => {
      const g = groups.get(h).sort((a, b) => PRIO[a.status] - PRIO[b.status] || a.arrival - b.arrival);
      const c = counts(g);
      const exc = g.filter((r) => r.status !== 'ok'); const okRows = g.filter((r) => r.status === 'ok');
      const open = filtering ? true : (ui.groupOpen[h] ?? exc.length > 0);
      const parts = [plural(g.length, 'ruta', 'rutas')];
      if (c.risk) parts.push(`<span class="t-risk">${c.risk} en riesgo</span>`);
      if (c.nodriver) parts.push(`<span class="t-nod">${c.nodriver} sin conductor</span>`);
      if (c.adj) parts.push(`<span class="t-adj">${c.adj} ajustada${c.adj > 1 ? 's' : ''}</span>`);
      if (!exc.length) parts.push('<span class="t-ok">todas listas</span>');
      // Cada franja va en su propio bloque: así su encabezado «sticky» solo se
      // queda pegado mientras se ven SUS filas (si no, todos se apilan arriba).
      html += `<div class="rv2-gwrap"><button class="rv2-group" data-group="${h}" aria-expanded="${open}"><span class="car" aria-hidden="true">▸</span><strong>${pad(h)}:00 – ${pad((h + 1) % 24)}:00</strong> · ${parts.join(' · ')}</button>`;
      if (open) {
        const showAll = filtering || ui.showOk.has(h) || !exc.length;
        (showAll ? g : exc).forEach((r) => { html += rowHTML(r); });
        if (!showAll && okRows.length) html += `<button class="rv2-more" data-more="${h}">Ver ${okRows.length} ruta${okRows.length === 1 ? '' : 's'} lista${okRows.length === 1 ? '' : 's'} más de esta franja ▾</button>`;
      }
      html += '</div>';
    });
    el.list.innerHTML = html;
  }

  function renderUnrouted() {
    if (ui.cargando || rt.source === 'empty') { el.list.innerHTML = emptyHTML(); return; }
    const ids = (rt.pool || []).filter((id) => !ui.q || norm(nombre(id)).includes(norm(ui.q)) || norm(lugar(id)).includes(norm(ui.q)));
    if (!(rt.pool || []).length) { el.list.innerHTML = '<div class="rv2-empty"><b>Todos ruteados</b>Cada tripulante está en un carro.</div>'; return; }
    if (!ids.length) { el.list.innerHTML = `<div class="rv2-empty"><b>Sin resultados para «${esc(ui.q)}»</b>Prueba con otro nombre.</div>`; return; }
    el.list.innerHTML = ids.slice().sort((a, b) => rtToMin(aux(a).dl) - rtToMin(aux(b).dl)).map((id) => {
      const a = aux(id);
      const when = a.type === 'lle' ? `${a.tierra ? 'Sale del terminal' : 'Aterriza'} ${esc(a.dl)}` : `Presentación ${esc(a.dl)}`;
      return `<div class="rv2-crew"><span class="rv2-av" style="background:${esc((rt.colors && rt.colors[id]) || '#3D86F2')}">${esc(initials(a.n))}</span>` +
        `<div><b>${hl(a.n)}</b><small>${hl(lugar(id))} · ${a.type === 'lle' ? 'Llegada' : 'Salida'}</small></div>` +
        `<span class="when"><span class="st st--auto st--risk">${when}</span></span>` +
        `<button class="rv2-btn rv2-btn--cta rv2-btn--sm" data-act="route" data-crew="${esc(id)}">Rutear</button></div>`;
    }).join('');
  }

  function renderCarros() {
    const vacio = emptyHTML();
    if (vacio) { el.carros.innerHTML = vacio; return; }
    const base = visibleBase().filter(matchesQ);
    const hours = Array.from({ length: 24 }, (_, h) => `<span style="left:calc(${h} * var(--hw))">${pad(h)}:00</span>`).join('');
    let html = `<div class="rv2-tl" role="list" aria-label="Vueltas por carro"><div class="rv2-tl-head"><div class="lab"></div><div class="rv2-tl-hours">${hours}</div></div>`;
    (rt.cars || []).forEach((car) => {
      const rs = base.filter((r) => r.vehicle === car.id);
      if (ui.q && !rs.length) return;
      // Una sola línea al lado del carro: si le falta conductor en algún turno
      // con vueltas, eso es lo que se dice (es lo que pide acción); si no, los
      // conductores de sus turnos. El detalle completo va en el title.
      const bands = [...new Set(rs.map((r) => r.shift))].sort((a, b) => RT_BANDS.indexOf(a) - RT_BANDS.indexOf(b));
      const faltan = bands.filter((b) => !rtCarDrv(car, b));
      const nombres = bands.map((b) => { const id = rtCarDrv(car, b); return id ? `${rtBandName(b)} ${conductor(id).name}` : `${rtBandName(b)} sin conductor`; });
      const lab = !rs.length ? '<span>Sin vueltas</span>'
        : faltan.length ? `<span class="none" title="${esc(nombres.join(' · '))}">Sin conductor ${faltan.map((b) => rtBandName(b)).join(" / ")}</span>`
        : `<span title="${esc(nombres.join(' · '))}">${bands.map((b) => esc(shortName((conductor(rtCarDrv(car, b)) || {}).name || '—'))).join(' / ')}</span>`;
      html += `<div class="rv2-tl-row" role="listitem"><div class="rv2-tl-lab"><b>${esc(car.id)}</b>${lab}</div><div class="rv2-tl-track">` +
        `<i class="rv2-tl-pm" style="left:calc(14 * var(--hw))" title="Relevo AM → PM (14:00)"></i>` +
        rs.map((r) => {
          const names = r.stops.map((st) => shortName(nombre(st.crewId))).join(', ');
          const ini = Math.max(0, r.depart); const fin = Math.min(1440, Math.max(r.end, ini + 12));
          return `<button class="rv2-blk ${r.type} ${r.status}" data-id="${esc(r.id)}"${ui.sel === r.id ? ' aria-current="true"' : ''} style="left:calc(${ini / 60} * var(--hw));width:calc(${(fin - ini) / 60} * var(--hw))" title="${esc(r.vehicle + ' · ' + timeSpan(r) + ' · ' + names + ' · ' + LABEL[r.status])}" aria-label="${esc(r.vehicle + ', vuelta ' + r.vuelta + ', ' + LABEL[r.status] + ', ' + timeSpan(r))}">${r.status === 'risk' ? '! ' : ''}${r.pax} pax</button>`;
        }).join('') + '</div></div>';
    });
    el.carros.innerHTML = html + '</div>';
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
        ? (a.tierra ? ' · tierra' : (a.vuelo ? ' · vuelo ' + esc(a.vuelo) + chipVuelo(a.vuelo, 'lle') : ''))
        : (a.dl ? ' · pres. ' + esc(a.dl) : '') + (a.vuelo ? chipVuelo(a.vuelo, 'sal') : '');
      const at = atendida(st.crewId);
      const tel = a.tel ? `<a class="rv2-ic" href="${esc(telHref(a.tel))}" aria-label="Llamar a ${esc(a.n)}">${IC.phone}</a>`
        : `<button class="rv2-ic" disabled aria-label="${esc(a.n)} no tiene teléfono registrado" title="Sin teléfono registrado">${IC.phone}</button>`;
      const mv = (at || fija)
        ? `<button class="rv2-ic" disabled aria-label="${esc(a.n)} ya fue atendido" title="Ya atendido: no se puede mover">${IC.move}</button>`
        : `<button class="rv2-ic" data-act="move" data-crew="${esc(st.crewId)}" data-from="${esc(r.id)}" aria-label="Mover a ${esc(a.n)}">${IC.move}</button>`;
      return `<li><span class="mono">${hhmm(st.time)}</span><div><b>${esc(a.n)}</b>${esc(lugar(st.crewId))}${extra}${at ? ' · ya atendido' : ''}</div>${tel}${mv}</li>`;
    }).join('');
    const m = r.margin;
    let end;
    if (r.type === 'llegada') {
      const tierra = r.stops.every((s) => aux(s.crewId) && aux(s.crewId).tierra);
      end = `<li class="end"><span class="mono">${hhmm(r.pickup)}</span><div><b>Recogida en JMC</b>${tierra ? 'Salen del terminal' : 'Aterriza'} ${hhmm(r.arrival)}${r.wait ? ` · <span class="${r.wait > LLE_ESPERA_LARGA ? 't-adj' : ''}">espera ${r.wait} min</span>` : ''}</div></li>`;
    } else {
      end = `<li class="end"><span class="mono${m < 0 ? ' neg' : ''}">${hhmm(r.arrival)}</span><div><b>Llegada JMC</b>Presentación ${hhmm(r.pres)} · ${BUF()} min de entrega · <span class="${m < 0 ? 't-risk' : m < ADJ_MIN ? 't-adj' : 't-ok'}">${m < 0 ? Math.abs(m) + ' min tarde' : m + ' min de margen'}</span></div></li>`;
    }
    return r.type === 'llegada' ? end + stops : stops + end;
  }

  function alertTxt(r) {
    const m = r.margin; const B = BUF();
    const choque = r.retraso ? ` · el carro termina su vuelta anterior ${r.retraso} min tarde` : '';
    if (r.fija === 'completed') return 'Terminada · el conductor ya la cerró';
    if (r.status === 'risk') return `En riesgo · llega ${hhmm(r.arrival)}; con ${B} min de entrega no alcanza la presentación (${hhmm(r.pres)}): ${Math.abs(m)} min tarde${choque}`;
    if (r.status === 'nodriver') return `Sin conductor para el turno ${rtBandName(r.shift)} de ${r.vehicle}`;
    if (r.status === 'adj') {
      if (r.type === 'llegada') return `Ajustada · el tripulante esperaría ${r.wait} min en JMC${choque}`;
      return `Ajustada · llega ${hhmm(r.arrival)}; con ${B} min de entrega le quedan ${m} min a la presentación (${hhmm(r.pres)})${choque}`;
    }
    if (r.type === 'llegada') return `Lista · aterrizaje ${hhmm(r.arrival)}, última entrega ${hhmm(r.end)}`;
    return `Lista · llega ${hhmm(r.arrival)}; con ${B} min de entrega le sobran ${m} min para la presentación`;
  }

  function renderDetail() {
    const r = ui.sel && D.byId[ui.sel];
    if (!r) {
      el.detail.innerHTML = `<div class="rv2-dempty">${hayVueltas() ? 'Selecciona una ruta para ver paradas, conductor y sugerencias.' : 'Cuando haya rutas, aquí ves sus paradas, el conductor y las sugerencias.'}</div>`;
      return;
    }
    const d = conductor(r.driverId);
    const sug = sugerencia(r);
    const sugHTML = sug ? `<div class="rv2-sug"><h3>${IC.zap}Sugerencia de Rendio</h3>` +
      `<p>Mover a <b>${esc(nombre(sug.crewId))}</b> a <b>${esc(sug.vehicle)}</b> (la recoge a las ${hhmm(sug.pickup)}). ${esc(r.vehicle)} queda en <b>${signed(sug.src)}</b> y ${esc(sug.vehicle)} en <b>${signed(sug.dst)}</b>.</p>` +
      `<div class="acts"><button class="rv2-btn rv2-btn--cta rv2-btn--sm" data-act="apply" data-crew="${esc(sug.crewId)}" data-from="${esc(r.id)}" data-to="${esc(sug.to)}">Aplicar</button>` +
      `<button class="rv2-btn rv2-btn--sm" data-act="move" data-crew="${esc(sug.crewId)}" data-from="${esc(r.id)}">Ver otras opciones</button></div></div>`
      : (r.status === 'risk' && r.type !== 'llegada' && !r.fija ? '<p class="rv2-note">Rendio no encontró a quién mover sin dejar otra ruta tarde. Prueba «Mover auxiliar», Re-optimizar o, si no hay cómo, publícala de todos modos.</p>' : '');
    const turno = rtBandName(r.shift);
    const drvHTML = `<div class="rv2-drv"><span class="rv2-av">${d ? esc(initials(d.name)) : '?'}</span><div>${d ? `<b>${esc(d.name)}</b>Conductor · turno ${turno}` : `<b>Sin conductor</b>Turno ${turno} de ${esc(r.vehicle)}`}</div>` +
      (d && d.phone ? `<a class="rv2-ic" href="${esc(telHref(d.phone))}" aria-label="Llamar a ${esc(d.name)}">${IC.phone}</a>` : '') +
      (r.fija === 'completed' ? '' : `<button class="rv2-btn ${d ? '' : 'rv2-btn--soft'} rv2-btn--sm" data-act="assign" data-id="${esc(r.id)}">${d ? 'Cambiar' : 'Asignar'}</button>`) + '</div>';
    const dur = Math.max(0, Math.round(r.end - r.pickup));
    const fijaTxt = r.fija === 'in_progress' ? ' · en curso' : r.fija === 'completed' ? ' · terminada' : '';
    el.detail.innerHTML =
      `<div class="rv2-dhead"><button class="rv2-ic rv2-back" data-act="close" aria-label="Volver a la lista">${IC.back}</button>` +
      `<div><h2>${esc(r.vehicle)} · Vuelta ${r.vuelta}</h2><p>${TYPE_LONG[r.type]} · ${r.pax} pax · ${dur} min${fijaTxt}</p></div>` +
      `<button class="rv2-ic x" data-act="close" aria-label="Cerrar detalle">${IC.x}</button></div>` +
      `<div class="rv2-dbody"><p class="rv2-alert rv2-alert--${r.status}">${esc(alertTxt(r))}</p>${sugHTML}${drvHTML}` +
      `<h3 class="rv2-cap">Paradas · orden de ${r.type === 'llegada' ? 'entrega' : 'recogida'}</h3><ol class="rv2-stops">${stopsHTML(r)}</ol></div>` +
      `<div class="rv2-dfoot"><button class="rv2-btn" data-act="map" data-id="${esc(r.id)}">Ver mapa</button>` +
      `<button class="rv2-btn rv2-btn--cta" data-act="pickmove" data-id="${esc(r.id)}"${r.fija === 'completed' ? ' disabled' : ''}>Mover auxiliar</button>` +
      `<button class="rv2-btn" data-act="assign" data-id="${esc(r.id)}"${r.fija === 'completed' ? ' disabled' : ''}>Conductor</button></div>`;
  }

  function render() {
    if (!root()) return;
    D = armarDia();
    if (ui.sel && !D.byId[ui.sel]) ui.sel = null;
    renderBar(); renderStatus(); renderList(); renderDetail();
  }

  /* ---------- 6. Acciones ---------- */
  function snapshot(label) { hist.push({ label, f: foto() }); if (hist.length > 20) hist.shift(); }
  function undo() {
    const h = hist.pop(); if (!h) return;
    // Si quedan pasos, el aviso trae otra vez «Deshacer» (se puede volver
    // hasta 20 pasos atrás, README §5).
    restaurar(h.f); render(); toast(hist.length ? `Cambio deshecho · quedan ${hist.length}` : 'Cambio deshecho', true);
  }
  function commit(msg) { render(); toast(msg, true); }

  function moveCrew(crewId, fromId, toId) {
    const to = rtLaneOf(toId); if (!to) return;
    snapshot('mover');
    aplicarMovida(crewId, fromId, toId);
    if (fromId && ui.sel === fromId && !(rt.order[fromId] || []).length) ui.sel = toId;
    commit(`${nombre(crewId)} quedó en ${to.car}`);
  }

  function slotsSinConductor() {
    const slots = new Map();
    D.routes.forEach((r) => { if (!r.driverId && r.fija !== 'completed') { const k = r.vehicle + '|' + r.shift; if (!slots.has(k)) slots.set(k, r); } });
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
    if (rt.source !== 'live' || ui.optimizando || typeof rtOptimize !== 'function') return;
    const enCurso = Object.keys(rt.rv2Fijas || {}).length;
    if (enCurso && !window.confirm(`Hay ${plural(enCurso, 'vuelta', 'vueltas')} en curso o terminada${enCurso > 1 ? 's' : ''}. Re-optimizar arma el día desde cero; lo que el conductor ya atendió no se mueve al publicar. ¿Seguir?`)) return;
    snapshot('reoptimizar');
    ui.optimizando = true; renderBar();
    try {
      await rtOptimize({ toast: (m) => toast(m, true) });
      rt.rv2Fijas = {};
    } catch (e) {
      hist.pop();
      toast('No se pudo optimizar: ' + ((e && e.message) || 'error'));
    } finally { ui.optimizando = false; }
    ui.sel = null; render(); autoSelect();
  }

  async function publicar() {
    if (ui.publicando || typeof rtSavePlan !== 'function') return;
    ui.publicando = true; renderStatus();
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

  function abrirMapa(id) {
    const r = D.byId[id];
    if (!r) return;
    if (typeof L === 'undefined' || typeof rtOpenMap !== 'function') { toast('El mapa no está disponible en este momento.'); return; }
    rtOpenMap(id);
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

  function openPickMove(routeId) {
    const r = D.byId[routeId]; if (!r) return;
    openSheet(sheetHead('¿A quién vas a mover?', `${esc(r.vehicle)} · ${timeSpan(r)}`) +
      `<div class="rv2-sh-body">${r.stops.map((s) => {
        const at = atendida(s.crewId);
        return `<button class="rv2-opt" data-act="move" data-crew="${esc(s.crewId)}" data-from="${esc(r.id)}"${at ? ' disabled' : ''}><span class="t"><b>${esc(nombre(s.crewId))}</b> · ${hhmm(s.time)}</span>${at ? '<span class="st st--off">Ya atendido</span>' : ''}<small>${esc(lugar(s.crewId))}</small></button>`;
      }).join('')}</div>`);
    setLabel();
  }

  function pillDe(sim) {
    const dst = sim.dst; if (!dst) return { s: 'risk', txt: 'no cabe' };
    if (sim.choque) return { s: 'risk', txt: `choca con su vuelta de las ${hhmm(sim.choque.at)}` };
    if (dst.margin == null) {
      const w = dst.wait || 0;
      return w > LLE_ESPERA_LARGA ? { s: 'adj', txt: `espera ${w} min` } : { s: 'ok', txt: 'deja ' + hhmm(sim.pickup) };
    }
    const m = dst.margin;
    return { s: m < 0 ? 'risk' : m < ADJ_MIN ? 'adj' : 'ok', txt: `${signed(m)} · ${m < 0 ? 'tarde' : m < ADJ_MIN ? 'ajustada' : 'a tiempo'}` };
  }
  function optHTML({ lane, sim, mismo }, checked) {
    const p = pillDe(sim);
    const others = (rt.order[lane.id] || []).map(nombre).join(' · ');
    const tipo = lane.type === 'lle' ? 'entrega' : 'recoge';
    const sinDrv = sim.dst && !sim.dst.driverId ? ' · sin conductor' : '';
    return `<button class="rv2-opt" role="radio" aria-checked="${checked}" data-pick="${esc(lane.id)}"><span class="t"><b>${esc(lane.car)}</b> · vuelta ${lane.vuelta} · ${tipo} ${hhmm(sim.pickup)}</span><span class="st st--${p.s}">${esc(p.txt)}</span><small>Con ${esc(others)}${mismo ? ' · mismo sector' : ''}${sim.extra ? ` · +${sim.extra} min de recorrido` : ''}${sinDrv}</small></button>`;
  }

  function openMove(crewId, fromId) {
    const a = aux(crewId); if (!a) return;
    const from = fromId ? D.byId[fromId] : null;
    const sugeridas = candidatas(crewId, fromId);
    const sug = from ? sugerencia(from) : null;
    let sel = (sug && sug.crewId === crewId && sug.to) || (sugeridas[0] && sugeridas[0].lane.id) || null;
    const fromStop = from && from.stops.find((s) => s.crewId === crewId);
    const sub = from ? `${esc(lugar(crewId))} · hoy en ${esc(from.vehicle)} (${hhmm(fromStop ? fromStop.time : null)})`
      : `${esc(lugar(crewId))} · ${a.type === 'lle' ? (a.tierra ? 'sale del terminal' : 'aterriza') : 'presentación'} ${esc(a.dl)}`;
    let impact = '';
    if (from) {
      const rem = simular(crewId, fromId, null);
      impact = rem.srcEmpty ? `<p class="rv2-impact">${esc(from.vehicle)} queda sin pasajeros y esta vuelta se elimina.</p>`
        : rem.src && rem.src.margin == null ? `<p class="rv2-impact">${esc(from.vehicle)} adelanta sus entregas (termina ${hhmm(rem.src.end)}).</p>`
        : rem.src ? `<p class="rv2-impact${rem.src.margin < 0 ? ' is-warn' : ''}">${esc(from.vehicle)} queda en <b>${signed(rem.src.margin)}</b>.</p>` : '';
    }
    let mostradas = [];
    const draw = (q = '') => {
      if (q) {
        const nq = norm(q);
        mostradas = candidatas(crewId, fromId, { todas: true }).filter(({ lane }) => norm(lane.car + ' ' + (rt.order[lane.id] || []).map(nombre).join(' ')).includes(nq)).slice(0, 8);
      } else mostradas = sugeridas.slice(0, 3);
      if (sel && !mostradas.some((o) => o.lane.id === sel) && !q) sel = mostradas[0] ? mostradas[0].lane.id : null;
      $('#rv2-opts').innerHTML = mostradas.length ? mostradas.map((o) => optHTML(o, o.lane.id === sel)).join('')
        : `<p class="rv2-impact">${q ? 'No hay rutas compatibles con ese criterio.' : `No hay ${a.type === 'lle' ? 'llegadas' : 'salidas'} con cupo cerca de esa hora. Busca otro carro o re-optimiza el día.`}</p>`;
      $('#rv2-optsCap').textContent = q ? 'Resultados' : 'Sugeridas · mismo sector primero';
    };
    openSheet(sheetHead(`${from ? 'Mover' : 'Rutear'} a ${esc(a.n)}`, sub) +
      `<div class="rv2-sh-body">${impact}<h3 class="rv2-cap" id="rv2-optsCap"></h3><div id="rv2-opts" role="radiogroup" aria-label="Rutas destino" style="display:flex;flex-direction:column;gap:8px"></div>` +
      `<label class="rv2-search" style="width:100%;height:44px">${IC.search}<input id="rv2-optq" type="search" placeholder="Buscar otra ruta o carro" autocomplete="off" aria-label="Buscar otra ruta o carro"></label></div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-doMove">Mover</button></div>`);
    setLabel();
    const btn = $('#rv2-doMove');
    const sync = () => { const l = sel && rtLaneOf(sel); btn.disabled = !l; btn.textContent = l ? `Mover a ${l.car}` : 'Elige una ruta'; };
    draw(); sync();
    const fc = $('#rv2-opts [aria-checked="true"]') || $('#rv2-opts .rv2-opt'); if (fc) fc.focus();
    $('#rv2-opts').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; sel = b.dataset.pick; draw($('#rv2-optq').value.trim()); sync(); const n = $$('#rv2-opts [data-pick]').find((x) => x.dataset.pick === sel); if (n) n.focus(); });
    let t = null;
    $('#rv2-optq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value.trim()), 120); });
    btn.addEventListener('click', () => { if (!sel) return; const to = sel; closeSheet(); moveCrew(crewId, fromId, to); });
  }

  function openAssign(routeId) {
    const r = D.byId[routeId]; if (!r) return;
    const shift = r.shift; const car = rt.cars.find((c) => c.id === r.vehicle); if (!car) return;
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
      ? (shift === 'mad' ? `En turno PM del día anterior según el horario publicado (las vueltas antes de las ${rtHHc()})` : `En turno ${rtBandName(shift)} según el horario publicado`)
      : 'Sin horario publicado para ese día: se muestran todos los conductores';
    const curName = cur ? conductor(cur).name : null;
    const optBtn = ({ d, otro }, fuera) => {
      const full = (rt.drivers || []).find((x) => x.id === d.id) || {};
      const pill = d.id === cur ? '<span class="st st--ok">Actual</span>' : otro ? `<span class="st st--off">Maneja ${esc(otro.id)}</span>` : fuera ? '<span class="st st--adj">Fuera de turno</span>' : '<span class="st st--ok">Libre</span>';
      const small = [full.tel || '', otro ? 'ya tiene carro en este turno' : (d.id === cur ? 'asignado a este carro' : fuera ? 'no está en este turno en el horario' : 'sin carro en este turno')].filter(Boolean).join(' · ');
      return `<button class="rv2-opt" role="radio" aria-checked="${d.id === sel}" data-pick="${esc(d.id)}"${otro ? ' disabled' : ''}><span class="t"><b>${esc(d.n)}</b></span>${pill}<small>${esc(small)}</small></button>`;
    };
    openSheet(sheetHead(`Conductor para ${esc(r.vehicle)}`, `Turno ${rtBandName(shift)} · aplica a todas sus vueltas de ese turno${curName ? ' · hoy: ' + esc(curName) : ''}`) +
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
    $('#rv2-doAssign').addEventListener('click', () => { if (!sel) return; const s = sel; closeSheet(); assignDriver(car.id, shift, s); });
  }

  function openPublish() {
    if (!hayVueltas()) { toast('No hay rutas para publicar todavía.'); return; }
    const c = counts(D.routes);
    const unr = (rt.pool || []).length;
    const item = (ok, warn, title, sub, k) => `<div class="rv2-check"><span class="ico ${ok ? 'ok' : warn ? 'warn' : 'bad'}" aria-hidden="true">${ok ? '✓' : warn ? '!' : '✕'}</span><div>${title}<small>${sub}</small></div>${ok ? '' : `<button class="rv2-btn rv2-btn--sm" data-act="goto" data-k="${k}">Ver</button>`}</div>`;
    const blocking = c.risk + c.nodriver + unr;
    const conductoresConVuelta = new Set(D.routes.map((r) => r.driverId).filter(Boolean)).size;
    const yaPub = publicado();
    const aviso = yaPub
      ? `<p class="rv2-impact">Este plan ya está publicado: <b>los conductores ya lo tienen</b>. Si publicas otra vez reciben la versión nueva y el aviso «Ruta asignada»; a los tripulantes solo se les avisa si les cambió el conductor. Lo que un conductor ya atendió no se mueve.</p>`
      : '';
    const forzarItems = [c.risk ? plural(c.risk, 'ruta en riesgo (puede no llegar a la presentación)', 'rutas en riesgo (pueden no llegar a la presentación)') : '',
      c.nodriver ? plural(c.nodriver, 'ruta sin conductor (queda en borrador, nadie la ve)', 'rutas sin conductor (quedan en borrador, nadie las ve)') : '',
      unr ? plural(unr, 'tripulante sin rutear (no tendrá carro)', 'tripulantes sin rutear (no tendrán carro)') : ''].filter(Boolean);
    openSheet(sheetHead(yaPub ? (conCambios() ? 'Publicar cambios' : 'Volver a publicar') : 'Publicar plan', `${plural(c.all, 'ruta', 'rutas')} · se avisa a ${plural(conductoresConVuelta, 'conductor', 'conductores')} y a los tripulantes`) +
      `<div class="rv2-sh-body">${aviso}` +
      item(!c.risk, false, c.risk ? `${plural(c.risk, 'ruta', 'rutas')} en riesgo` : 'Ninguna ruta en riesgo', 'Todas deben llegar antes de la hora de presentación.', 'risk') +
      item(!c.nodriver, false, c.nodriver ? `${plural(c.nodriver, 'ruta', 'rutas')} sin conductor` : 'Todos los carros con conductor', 'Cada carro necesita conductor en cada turno con vueltas.', 'nodriver') +
      item(!unr, false, unr ? `${plural(unr, 'tripulante', 'tripulantes')} sin rutear` : 'Todos los tripulantes ruteados', 'Nadie puede quedar sin carro.', 'unrouted') +
      item(!c.adj, true, c.adj ? `${plural(c.adj, 'ruta ajustada', 'rutas ajustadas')}` : 'Ninguna ruta ajustada', `Llegan con menos de ${ADJ_MIN} min de margen (o el tripulante espera más de ${LLE_ESPERA_LARGA} min en JMC). No bloquea.`, 'adj') +
      (c.adj ? `<label class="rv2-ack"><input type="checkbox" id="rv2-ack"> Revisé las rutas ajustadas</label>` : '') +
      (blocking ? `<button class="rv2-linkbtn" id="rv2-forceOpen" aria-expanded="false" aria-controls="rv2-force">Publicar de todos modos…</button>` +
        `<div class="rv2-force" id="rv2-force" hidden><p>Vas a publicar con:</p><ul>${forzarItems.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` +
        ((c.risk || c.nodriver) ? `<label class="rv2-ack"><input type="checkbox" id="rv2-forceRisk"> Entiendo que ${c.risk && c.nodriver ? 'hay rutas en riesgo y sin conductor' : c.risk ? 'hay rutas en riesgo' : 'hay rutas sin conductor'} y publico así.</label>` : '') +
        (unr ? `<label class="rv2-ack"><input type="checkbox" id="rv2-forceUnr"> Entiendo que ${plural(unr, 'tripulante queda', 'tripulantes quedan')} sin carro.</label>` : '') +
        `</div>` : '') +
      `</div><div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button>` +
      `<button class="rv2-btn rv2-btn--cta" id="rv2-doPublish" disabled>${blocking ? `Faltan ${blocking} pendiente${blocking > 1 ? 's' : ''}` : yaPub ? 'Publicar de nuevo' : 'Publicar'}</button>` +
      (blocking ? `<button class="rv2-btn rv2-btn--danger" id="rv2-doForce" hidden disabled>Publicar de todos modos</button>` : '') + `</div>`);
    setLabel();
    const btn = $('#rv2-doPublish'); const ack = $('#rv2-ack');
    const fOpen = $('#rv2-forceOpen'); const fBox = $('#rv2-force'); const fBtn = $('#rv2-doForce');
    const fRisk = $('#rv2-forceRisk'); const fUnr = $('#rv2-forceUnr');
    const sync = () => {
      const ackOk = !c.adj || (ack && ack.checked);
      btn.disabled = !!blocking || !ackOk;
      if (fBtn) fBtn.disabled = !(ackOk && (!fRisk || fRisk.checked) && (!fUnr || fUnr.checked));
    };
    sync();
    [ack, fRisk, fUnr].forEach((x) => { if (x) x.addEventListener('change', sync); });
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
  function select(id, { open = true } = {}) {
    ui.sel = id; renderList(); renderDetail(); renderHist(visibleBase());
    if (open && esCajon()) {
      el.detail.classList.add('is-open'); el.scrim.hidden = false;
      const b = el.detail.querySelector('[data-act="close"]'); if (b) b.focus();
    }
  }
  function closeDetail() {
    el.detail.classList.remove('is-open');
    if (el.sheet.hidden) el.scrim.hidden = true;
    const row = ui.sel && $$('.rv2-row', root()).find((r) => r.dataset.id === ui.sel); if (row) row.focus();
  }
  function autoSelect() {
    if (esCajon() || ui.sel) return;
    const first = D.routes.filter((r) => r.status === 'risk').sort((a, b) => a.arrival - b.arrival)[0];
    if (first) { ui.sel = first.id; renderList(); renderDetail(); renderHist(visibleBase()); }
  }
  function syncSeg() { $$('.rv2-seg [data-view]', root()).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === ui.view))); }

  /* ---------- 8. Carga del día, vistas y eventos ---------- */
  // Rearma en rt lo que ya está publicado para ese día (route_assignments),
  // para que la pantalla muestre EL PLAN QUE TIENEN LOS CONDUCTORES y no un
  // tablero vacío con todos «sin rutear». Mismas reglas que rtSolveDay para el
  // número de vuelta, el origen y la hora de aterrizaje.
  async function rearmarPublicado() {
    rt.firmaPublicada = null; rt.rv2Fijas = {}; rt.rv2Atendidas = {};
    if (rt.source !== 'live' || !rt.day || !window.Api || typeof Api.getPublishedPlan !== 'function') return false;
    let plan = null;
    try { plan = await Api.getPublishedPlan(rt.day, { estados: ESTADOS_PLAN }); } catch (_) { return false; }
    const vueltas = (plan && plan.vueltas) || [];
    if (!vueltas.length) return false;
    const porReserva = {};
    Object.keys(rt.aux).forEach((k) => { const r = rt.aux[k].reservationId; if (r) porReserva[r] = k; });
    const lanes = [], order = {}, usados = new Set(), nCarro = {}, fijas = {}, atendidas = {};
    const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5);
    vueltas.slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).forEach((v) => {
      let car = rt.cars.find((c) => c.vehicleId && c.vehicleId === v.vehicleId);
      if (!car) {
        let id = v.carro || 'Carro'; while (rt.cars.some((c) => c.id === id)) id += '·';
        car = { id, avail0: '00:00', driver: null, capacity: v.cap || rt.CAP, vehicleId: v.vehicleId };
        rt.cars.push(car);
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
      // Arrancada = 'in_progress' o con paradas ya atendidas (nada en la app pasa una
      // ruta a 'in_progress'; la que el conductor va haciendo sigue en 'planned').
      if (v.status === 'in_progress' || v.status === 'completed') fijas[lane.id] = v.status;
      else if ((v.atendidas || []).length) fijas[lane.id] = 'in_progress';
      if (v.driverProfileId) {
        if (!(rt.drivers || []).some((d) => d.id === v.driverProfileId)) rt.drivers.push({ id: v.driverProfileId, n: v.conductor || 'Conductor', c: '#8895a7' });
        const banda = rtBandOf(lane);
        rtSetCarDrv(car, banda, rtCarDrv(car, banda) || v.driverProfileId);
      }
    });
    if (!lanes.length) return false;
    rt.lanes = lanes; rt.order = order;
    rt.pool = Object.keys(rt.aux).filter((k) => !usados.has(k));
    rt.rv2Fijas = fijas; rt.rv2Atendidas = atendidas;
    rt.cars.forEach((c) => encadenar(c.id));
    rt.optimized = true;
    rt.firmaPublicada = firmaActual();
    return true;
  }

  async function cargarDia(day) {
    ui.cargando = true; ui.sel = null; hist.length = 0;
    if (el.detail) el.detail.classList.remove('is-open');
    if (root() && !root().hidden) render();
    try {
      await rtLoad(day || undefined);
      ui.dia = rt.day || day || hoyBog();
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
    // Los vuelos del día (si la integración está encendida) llegan después y
    // solo agregan el chip en el detalle.
    if (window.RendioVuelos) window.RendioVuelos.cargar(ui.dia).then(() => { if (root() && !root().hidden) render(); }).catch(() => {});
    if (root() && !root().hidden) { render(); autoSelect(); }
    else if (typeof rtRenderAll === 'function') { rtRenderAll(); syncVieja(); }
  }

  async function cambiarDia(delta) {
    if (ui.cargando) return;
    const base = rt.day || ui.dia || hoyBog();
    if (sinPublicar() && !window.confirm(`Hay cambios sin publicar en ${dayLabel(base)}. Si cambias de día se pierden. ¿Cambiar de todos modos?`)) return;
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
    if (typeof rtBindOnce === 'function') rtBindOnce();   // el mapa y el overlay viven en la vista anterior
    el.sheet.hidden = true; el.scrim.hidden = true; el.detail.classList.remove('is-open');
    if (ui.cargando) { render(); return; }               // ya hay una carga en curso
    // Volver a la pestaña no borra lo que se estaba armando: si hay cambios sin
    // publicar del mismo día se quedan (y se dice de cuándo son los datos, por
    // si entró una reserva después). Si no, se carga fresco.
    if (rt.day && sinPublicar()) {
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
    // La vista anterior pudo armar o cambiar el plan: se respeta. Solo se
    // recarga si no hay nada en memoria.
    if (rt.cargadoEn && (rt.optimized || rt.source === 'empty')) { ui.dia = rt.day || ui.dia; render(); autoSelect(); }
    else await cargarDia(rt.day || ui.dia || null);
  }

  function bind() {
    if (bound) return;
    const r = root(); if (!r) return;
    bound = true;
    Object.assign(el, {
      chips: $('#rv2-chips'), list: $('#rv2-list'), listwrap: $('#rv2-listwrap'), carros: $('#rv2-carros'), detail: $('#rv2-detail'),
      hist: $('#rv2-hist-bars'), scrim: $('#rv2-scrim'), sheet: $('#rv2-sheet'), toast: $('#rv2-toast'),
      dayLabel: $('#rv2-dayLabel'), pubChip: $('#rv2-pubChip'), reopt: $('#rv2-reopt'), reoptLabel: $('#rv2-reoptLabel'),
      publish: $('#rv2-publish'), publishLabel: $('#rv2-publishLabel'), pending: $('#rv2-pending'), publishM: $('#rv2-publishM'),
      readyN: $('#rv2-readyN'), totalN: $('#rv2-totalN'), fill: $('#rv2-fill'), q: $('#rv2-q'), type: $('#rv2-type'),
    });
    const panel = r.closest('section[data-panel]') || document;
    panel.addEventListener('click', onClick);
    el.q.addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = e.target.value.trim(); renderList(); }, 120); });
    el.type.addEventListener('change', (e) => { ui.type = e.target.value; render(); });
    el.publish.addEventListener('click', openPublish);
    el.publishM.addEventListener('click', openPublish);
    el.reopt.addEventListener('click', reoptimizar);
    $('#rv2-wa').addEventListener('click', abrirWhatsApp);
    document.addEventListener('keydown', onKey);
    if (typeof ResizeObserver === 'function') {
      let last = '';
      new ResizeObserver(() => {
        const antes = r.dataset.lay; medir();
        const k = `${r.dataset.lay}|${r.dataset.fila}|${r.dataset.det}`;
        if (k === last) return; last = k;
        if (antes !== r.dataset.lay) { el.detail.classList.remove('is-open'); if (el.sheet.hidden) el.scrim.hidden = true; if (r.dataset.lay === 'lado') autoSelect(); }
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
      if (a === 'move') { if (!el.sheet.hidden) closeSheet(); return openMove(act.dataset.crew, act.dataset.from); }
      if (a === 'pickmove') return openPickMove(act.dataset.id);
      if (a === 'route') return openMove(act.dataset.crew, null);
      if (a === 'apply') return moveCrew(act.dataset.crew, act.dataset.from, act.dataset.to);
      if (a === 'autoassign') { closeSheet(); return autoAssign(); }
      if (a === 'sclose') return closeSheet();
      if (a === 'close') return closeDetail();
      if (a === 'undo') { el.toast.hidden = true; return undo(); }
      if (a === 'map') return abrirMapa(act.dataset.id);
      if (a === 'reopt') return reoptimizar();
      if (a === 'goto') { closeSheet(); ui.filter = act.dataset.k; ui.view = 'lista'; syncSeg(); return render(); }
      if (a === 'nav') return cambiarDia(Number(act.dataset.dir) || 0);
      if (a === 'vista') return aVista(act.dataset.v);
      return;
    }
    const chip = t.closest('.rv2-chip');
    if (chip) { ui.filter = ui.filter === chip.dataset.k && chip.dataset.k !== 'all' ? 'all' : chip.dataset.k; if (ui.view === 'carros' && ui.filter === 'unrouted') { ui.view = 'lista'; syncSeg(); } return render(); }
    const grp = t.closest('.rv2-group');
    if (grp) { const h = +grp.dataset.group; ui.groupOpen[h] = grp.getAttribute('aria-expanded') !== 'true'; return renderList(); }
    const more = t.closest('.rv2-more');
    if (more) { ui.showOk.add(+more.dataset.more); return renderList(); }
    const hb = t.closest('.rv2-hb');
    if (hb) {
      const h = +hb.dataset.hour; ui.view = 'lista'; ui.groupOpen[h] = true; ui.filter = 'all'; syncSeg(); render();
      const g = $(`.rv2-group[data-group="${h}"]`, root()); if (g && g.scrollIntoView) g.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const row = t.closest('.rv2-row, .rv2-blk');
    if (row) return select(row.dataset.id);
    const seg = t.closest('.rv2-seg [data-view]');
    if (seg && !seg.disabled) {
      ui.view = seg.dataset.view; if (ui.view === 'carros' && ui.filter === 'unrouted') ui.filter = 'all';
      syncSeg(); render();
      if (ui.view === 'carros') { const tl = $('.rv2-tl', root()); if (tl) el.carros.scrollLeft = 3 * (parseFloat(getComputedStyle(tl).getPropertyValue('--hw')) || 72); }
      return;
    }
    if (t === el.scrim) { if (!el.sheet.hidden) closeSheet(); else closeDetail(); }
  }

  function onKey(e) {
    const r = root(); if (!r || r.hidden) return;
    const panel = r.closest('section[data-panel]');
    if (panel && panel.classList.contains('hidden')) return;
    const mapa = $('#rt-mapOvl.show');
    if (mapa) { if (e.key === 'Escape' && typeof rtCloseMap === 'function') rtCloseMap(); return; }
    const ae = document.activeElement || document.body;
    const typing = /INPUT|SELECT|TEXTAREA/.test(ae.tagName);
    if (e.key === 'Escape') {
      if (!el.sheet.hidden) { e.preventDefault(); return closeSheet(); }
      if (el.detail.classList.contains('is-open')) { e.preventDefault(); return closeDetail(); }
      if (ae === el.q) { el.q.value = ''; ui.q = ''; renderList(); }
      return;
    }
    if (!el.sheet.hidden) return;
    if (e.key === '/' && !typing) { e.preventDefault(); el.q.focus(); return; }
    const row = ae.closest && ae.closest('.rv2-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(row.dataset.id); return; }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && ui.view === 'lista' && !el.detail.classList.contains('is-open')) {
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
    _ui: ui, _hist: hist, dia: () => D, medir, sugerencia: (id) => sugerencia(D && D.byId[id]), candidatas, _mover: moveCrew,
  };
})();
