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
  // DE DÓNDE SALE cada uno en una llegada (27-oct-2026, Camilo y la profa: «está
  // como si estuviera al revés»). Como lo escribe el jefe en su lista: «12:00
  // Jessica (av9563)», «11:30 Lau (hotel)», «16:00 Kris (Aero)». `par` va entre
  // paréntesis junto al nombre; `desde` abre el trayecto «desde → casa».
  const salidaLle = (a) => {
    const P = resP(a);
    if (P) return P.hotel ? { par: P.name, desde: P.name } : { par: 'Reserva JMC', desde: 'JMC (reserva)' };
    if (a && a.tierra) return { par: 'tierra', desde: 'JMC (tierra)' };
    const v = a && a.vuelo ? String(a.vuelo).replace(/[\s-]/g, '').toUpperCase() : '';
    return v ? { par: v, desde: `JMC (${v})`, vuelo: a.vuelo } : { par: '', desde: 'JMC' };
  };
  // El hotel de la vuelta si TODOS van/vienen del mismo (para el renglón final).
  const hotelDe = (ids) => { const ps = ids.map((id) => resP(aux(id))); return ps.length && ps.every((P) => P && P.hotel && P.key === ps[0].key) ? ps[0] : null; };
  const algunHotel = (ids) => { const P = ids.map((id) => resP(aux(id))).find((x) => x && x.hotel); return P || null; };
  const fijaDe = (laneId) => (rt.rv2Fijas && rt.rv2Fijas[laneId]) || null;
  const atendida = (id) => !!(rt.rv2Atendidas && rt.rv2Atendidas[id]);
  // Cómo terminó una vuelta publicada (26-oct-2026, Api._opResultado): la base
  // nunca la cierra, así que se deduce de sus paradas al releer el plan.
  const resultadoDe = (laneId) => (rt.rv2Fin && rt.rv2Fin[laneId]) || null;
  const lanesDeCarro = (carId) => rt.lanes.filter((l) => l.car === carId && (rt.order[l.id] || []).length).sort((a, b) => a.vuelta - b.vuelta);

  // EL PASAJERO SIN CUENTA EN EL TABLERO (0133 · 26-oct-2026). Kriss no pidió por
  // la app, pero el jefe la pone en su ruta: va en la vuelta como una parada más,
  // con su nombre y su conjunto. Vive en rt.aux con `guest` (sin reserva) y
  // saveRoutePlan la publica así. No le llegan avisos.
  //   g: { name, place, phone, residence_id, lat, lng, zona, vuelo, stopId }
  //   dlMin: en una llegada, la hora a la que la recogen; en una salida, el «Deben
  //   estar» del jefe (sin él, una hora después de recogerla: no tiene presentación).
  function auxSinCuenta(g, type, dlMin) {
    const lle = type === 'lle';
    return {
      n: g.name, zona: g.place || '—', resId: g.residence_id || null, zonaJefe: g.zona || null, sector: '',
      dir: g.place || '', lat: g.lat != null ? g.lat : null, lng: g.lng != null ? g.lng : null,
      dl: rtToHM(((Math.round(dlMin) % 1440) + 1440) % 1440), pax: 1, type: lle ? 'lle' : 'sal',
      reservationId: null, auxId: null, tel: g.phone || '', vuelo: g.vuelo || '',
      // Sin vuelo la hora del jefe es la de recogerla en JMC o en el hotel: sin desembarque.
      tierra: lle && !g.vuelo, notas: 'Sin cuenta en la app: no le llegan avisos.',
      reserva: null, hotel: false, pernocta: false,
      guest: { name: g.name, place: g.place || null, phone: g.phone || null, residence_id: g.residence_id || null,
        lat: g.lat != null ? g.lat : null, lng: g.lng != null ? g.lng : null, stopId: g.stopId || null },
    };
  }
  // El sin cuenta de una vuelta publicada (rearmarPublicado): su llave sale de la parada.
  function sinCuentaPublicado(s, v) {
    const k = 'g' + String(s.stopId || '').slice(0, 8);
    if (rt.aux[k]) return k;
    const min = (iso) => { const x = iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5) : null; return x ? rtToMin(x) : null; };
    const lle = v.type === 'lle';
    const dl = lle ? min(v.startAt) : (min(v.deadlineAt) ?? ((min(s.etaAt) ?? min(v.startAt) ?? 0) + 60));
    rt.aux[k] = auxSinCuenta({ name: s.name, place: s.address || null, phone: s.guestPhone || null, residence_id: s.resId || null,
      lat: s.lat, lng: s.lng, stopId: s.stopId }, v.type, dl == null ? 0 : dl);
    if (rt.colors && !rt.colors[k]) rt.colors[k] = '#8895a7';
    return k;
  }

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
    // 27-oct: con horas puestas (las del jefe o las ya publicadas) se respetan.
    if (conservarHoras(lane)) return;
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

  // HORAS QUE SE RESPETAN AL MOVER (27-oct-2026). Camilo: «cuando los permite mover
  // el sistema no respeta las horas sino que les aumenta 30 minutos a una hora». Una
  // vuelta tocada volvía al modelo: en una salida, a «lo más tarde que aún entrega»
  // (reprogramar), que corría la hora del jefe hasta media hora. Ahora, si la vuelta
  // tenía horas (rt.horasPub: las que pegó el jefe o las ya publicadas):
  //   · salida: cada uno conserva su hora; al que llega se le calcula la suya en su
  //     puesto del recorrido, y el de después se corre SOLO si el carro no alcanza.
  //   · llegada: sale de JMC a la misma hora, aunque el que llega aterrice después.
  //     Camilo (27-oct, 9 a. m.): «que me deje meter a una persona en un combo de
  //     recogida en puerto sin que me afecte horas»: él sabe si ya salió.
  // Devuelve false si no hay horas que respetar (la vuelta va con el modelo).
  function conservarHoras(lane) {
    const pub = rt.horasPub && rt.horasPub[lane.id];
    const ids = rt.order[lane.id] || [];
    if (!pub || !ids.length) return false;
    if (lane.type === 'lle') {
      lane.landing = rtToHM(horaVuelta(ids));
      lane.start = pub.start;
      rt.horasPub[lane.id] = { start: lane.start, sig: ids.join(','), etas: {} };
      return true;
    }
    const etas0 = pub.etas || {};
    const j = ids.findIndex((id) => etas0[id] != null);
    if (j < 0) return false;
    // Del primero hasta el primero con hora: cuánto tarda el carro (paradas + tramos).
    const tramo = (a, b) => (rtStopKey(a) === rtStopKey(b) ? 0 : rt.SERVICE_MIN + rtLegMin(a, b));
    let t0 = etas0[ids[j]];
    for (let i = j; i > 0; i--) t0 -= tramo(ids[i - 1], ids[i]);
    const etas = {};
    let prev = null, t = null;
    ids.forEach((id) => {
      const minimo = prev == null ? t0 : t + tramo(prev, id);
      const suya = etas0[id] != null && !(prev && rtStopKey(prev) === rtStopKey(id));
      t = suya ? Math.max(etas0[id], minimo) : minimo;
      // La hora nueva se da redonda hacia abajo, como siempre (rtCita): queda lista
      // antes de que llegue el carro. La que ya tenía se queda tal cual.
      etas[id] = suya && etas0[id] >= minimo ? etas0[id] : (prev && rtStopKey(prev) === rtStopKey(id) ? etas[prev] : rtCita(Math.round(t)));
      prev = id;
    });
    lane.start = rtToHM(Math.max(0, etas[ids[0]]));
    rt.horasPub[lane.id] = { start: lane.start, sig: ids.join(','), etas };
    return true;
  }
  // Dónde meter a uno en una salida con horas, sin mover a los demás: el puesto que
  // menos alarga el recorrido (antes del primero, entre dos, o al final antes de JMC).
  function meterSinReordenar(ids, id, origin) {
    let mejor = null;
    for (let i = 0; i <= ids.length; i++) {
      const prov = ids.slice(0, i).concat([id], ids.slice(i));
      let dur = 0, prev = origin || null;
      prov.forEach((x) => { if (prev) dur += rtLegMin(prev, x); prev = x; });
      dur += rtLegMin(prev, 'airport');
      if (!mejor || dur < mejor.dur) mejor = { dur, prov };
    }
    return mejor ? mejor.prov : ids.concat([id]);
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
    else if (!driverId && !lane.deleg && !lane.tomar) status = 'nodriver';   // 0126: la delegada no pide conductor · 0151: la para tomar tampoco
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
      delegName: lane.deleg ? (lane.delegName || null) : null,   // 0131: a quién
      delegPhone: lane.deleg ? (lane.delegPhone || null) : null,
      tomar: lane.tomar === true,       // 0151: dejada para que un conductor la tome
      // Pendientes de los jefes (26-oct): «está saliendo al revés, primero las
      // llegadas y después las salidas; que lo organice en orden de horas como se ha
      // hecho siempre». La lista se ordenaba por la llegada a JMC de cada salida, que
      // es 30-40 min después de su primera recogida: la salida de las 9:05 quedaba
      // detrás de la llegada de las 9:10. Ahora manda la PRIMERA hora que se lee,
      // como en el WhatsApp de Julián (rwaOrden): la recogida en una salida, el
      // aterrizaje en una llegada. 27-oct: la llegada ya se lee desde la recogida
      // en JMC (horas), así que manda esa. La de las 23:45 que recoge a las 00:05
      // queda al final del día («después de medianoche»), no arriba.
      orden: pickup,
      hora: pickup < 0 ? ((Math.floor(pickup / 60) % 24) + 24) % 24 : Math.floor(pickup / 60),
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
      crew[id] = { id, name: a.n, phone: a.tel || '', barrio: a.zona || '', sector: a.sector || a.zonaJefe || '', presentation: a.type === 'lle' || a.guest ? null : a.dl, type: a.type };
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
  // Pegar la ruta del jefe (meterPegado) también pone horas (rt.horasPub), carros
  // y pasajeros sin cuenta (rt.aux): «Deshacer» los quita. Desde que pegar REARMA
  // el día (27-oct-2026, 2ª) también saca sin cuenta y trae pedidos nuevos: la foto
  // guarda las llaves de rt.aux y los sin cuenta enteros, para devolverlos.
  const foto = () => {
    const sinCuenta = {};
    Object.keys(rt.aux || {}).forEach((k) => { if (rt.aux[k].guest) sinCuenta[k] = clone(rt.aux[k]); });
    return { lanes: clone(rt.lanes), order: clone(rt.order), pool: rt.pool.slice(), drv: rt.cars.map((c) => [c.driverAM || null, c.driverPM || null, c.driverMad || null]), optimized: rt.optimized, fijas: clone(rt.rv2Fijas || {}), auto: clone(rt.rv2Auto || {}),
      horas: clone(rt.horasPub || {}), fin: clone(rt.rv2Fin || {}), nCars: rt.cars.length, llaves: Object.keys(rt.aux || {}), sinCuenta };
  };
  function restaurar(f) {
    rt.lanes = clone(f.lanes); rt.order = clone(f.order); rt.pool = f.pool.slice(); rt.optimized = f.optimized;
    rt.rv2Fijas = clone(f.fijas || {}); rt.rv2Auto = clone(f.auto || {});
    if (f.horas) rt.horasPub = clone(f.horas);
    if (f.fin) rt.rv2Fin = clone(f.fin);   // 27-oct: «Deshacer» un re-optimizar perdía cómo terminó cada vuelta
    if (f.nCars != null && rt.cars.length > f.nCars) rt.cars.length = f.nCars;
    if (f.llaves) { const ya = new Set(f.llaves); Object.keys(rt.aux || {}).forEach((k) => { if (!ya.has(k)) delete rt.aux[k]; }); }
    if (f.sinCuenta) Object.keys(f.sinCuenta).forEach((k) => { rt.aux[k] = clone(f.sinCuenta[k]); });
    rt.cars.forEach((c, i) => { const d = f.drv[i] || [null, null, null]; c.driverAM = d[0]; c.driverPM = d[1]; c.driverMad = d[2] || null; });
  }
  function aplicarMovida(crewId, fromId, toId) {
    const to = rtLaneOf(toId);
    const from = fromId ? rtLaneOf(fromId) : null;
    if (from) rt.order[fromId] = (rt.order[fromId] || []).filter((x) => x !== crewId);
    else rt.pool = rt.pool.filter((x) => x !== crewId);
    const ids = (rt.order[toId] || []).concat([crewId]);
    // 27-oct: una salida con horas (del jefe o publicadas) no se reordena: el que
    // llega entra donde menos alarga y los demás conservan su puesto y su hora.
    const hp = rt.horasPub && rt.horasPub[toId];
    const conHoras = to.type !== 'lle' && !!hp && (rt.order[toId] || []).some((k) => hp.etas && hp.etas[k] != null);
    // Mismo orden que pondría el solver: barrido de afuera hacia MDE en las
    // salidas, reparto desde MDE en las llegadas.
    rt.order[toId] = to.type === 'lle' ? rtBestOrder(ids, 'airport', false)
      : conHoras ? meterSinReordenar(rt.order[toId] || [], crewId, to.origin) : rtBestOrder(ids, to.origin);
    encadenar(to.car);
    if (from && from.car !== to.car) encadenar(from.car);
    reprogramar(to);
    if (from) reprogramar(from);
    // El orden se eligió con el origen viejo; si encadenar lo cambió, se vuelve a ordenar.
    if (to.type !== 'lle' && !conHoras) rt.order[toId] = rtBestOrder(rt.order[toId], to.origin);
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
  // cargando: el día no está listo (se está trayendo, o falló: entonces
  // falloCarga = { dia, motivo }). diaPedido: el día que se está trayendo.
  const ui = { q: '', sel: null, moving: null, todas: false, cargando: false, falloCarga: null, diaPedido: null, dia: null, publicando: false, optimizando: false, drag: null, verHechas: false, avisosAbiertos: false };
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
    // 28-oct-2026 (Camilo, video y audios): el detalle con el mapa ya NO va fijo a la
    // derecha en ningún ancho. «Antes cuando uno presionaba desplegaba esto como una
    // pestañita al lado»: eso es el cajón, que sale al tocar la vuelta; así la lista
    // (y Conductores) usan todo el ancho y queda un solo scroll, el de la página.
    const lado = false;
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
  // 27-oct-2026 (Camilo): «arriba debería decir la hora que debe recoger en
  // aeropuerto». La llegada se lee desde la recogida, no desde el aterrizaje
  // (el aterrizaje de cada uno va junto a su nombre).
  const horas = (r) => (r.type === 'llegada' ? `${hhmm(r.pickup)} → ${hhmm(ultima(r))}` : `${hhmm(r.pickup)} → ${hhmm(r.arrival)}`);
  const turnoTxt = (b) => 'Turno ' + rtBandName(b);   // «Turno AM», «Turno PM del lunes»

  function renderBar() {
    // Mientras carga, el día que se pidió (antes seguía la fecha vieja puesta).
    const day = (ui.cargando && ui.diaPedido) || rt.day || ui.dia;
    el.dayLabel.textContent = dayLabel(day);
    const rel = relDia(day);
    el.dayLabel.title = rel ? `${rel} · ${day}` : (day || '');
    el.dayLabel.setAttribute('aria-label', `Día: ${dayLabel(day)}${rel ? ' (' + rel.toLowerCase() + ')' : ''}`);
    // Mientras carga no se sabe: el chip era del día anterior y salía junto a la fecha nueva.
    const pub = publicado() && !ui.cargando;
    el.pubChip.hidden = !pub;
    el.pubChip.classList.toggle('is-changed', pub && conCambios());
    el.pubChip.textContent = pub ? (conCambios() ? 'Publicado · con cambios' : 'Publicado') : '';
    el.pubChip.title = pub ? (conCambios() ? 'Hay un plan publicado; lo que ves tiene cambios que los conductores todavía no tienen.' : 'Este es el plan que ya tienen los conductores.') : '';
    const live = rt.source === 'live';
    el.reopt.disabled = !live || ui.cargando || ui.optimizando;
    el.reoptLabel.textContent = hayVueltas() ? 'Re-optimizar' : 'Optimizar';
    if (el.enrutar) { el.enrutar.disabled = !live || ui.cargando || ui.optimizando || !hayVueltas(); el.enrutar.hidden = !hayVueltas() && !ui.cargando; }
    // ‹ › siempre se pueden usar, también a mitad de una carga o si falló: la
    // carga vieja se descarta (cargarDia). Antes se apagaban y una consulta
    // colgada dejaba al jefe atrapado en ese día hasta recargar la página.
    $$('[data-act="nav"]', root()).forEach((b) => { b.disabled = false; });
  }

  // Lo que hay que resolver antes de publicar, en palabras. Nada más: lo que
  // está bien no se anuncia («Ajustada» y «Lista» dejaron de ser estados).
  function avisosDe() {
    if (!D || ui.cargando || rt.source !== 'live') return [];
    const out = [];
    (rt.pool || []).filter((id) => aux(id)).sort((a, b) => rtToMin(aux(a).dl) - rtToMin(aux(b).dl)).forEach((id) => {
      const a = aux(id);
      const cuando = (a.type === 'lle' ? `${a.reserva ? 'Termina la asignación' : (a.tierra ? 'Sale del terminal' : 'Aterriza')} ${a.dl}` : `Presentación ${a.dl}`)
        + (resTxt(a) ? ` · ${resTxt(a)}` : '')
        + (rtToMin(a.dl) < rtCut() ? ` (madrugada, turno PM del ${rtDiaAnterior()})` : '');
      out.push({ k: 'unrouted', html: `<b>${esc(a.n)}</b> no tiene carro<small>${a.type === 'lle' ? 'Llegada' : 'Salida'} · ${esc(cuando)} · ${esc(lugar(id))}</small>`, btn: 'Ubicar', act: `data-act="route" data-crew="${esc(id)}"` });
    });
    // 0137: lo que ya bajó de la lista (terminada, pasó su hora) no pide nada.
    D.routes.filter((r) => r.status === 'risk' && !ocultaFila(r)).sort((a, b) => a.arrival - b.arrival).forEach((r) => {
      out.push({ k: 'risk', html: `<b>${esc(r.vehicle)}</b> de las ${hhmm(r.pickup)} llega <b>${Math.abs(r.margin)} min tarde</b><small>Llega a JMC ${hhmm(r.arrival)} · presentación ${hhmm(r.pres)} · con ${BUF()} min de entrega</small>`, btn: 'Ver', act: `data-act="ver" data-id="${esc(r.id)}"` });
    });
    D.routes.filter((r) => r.type === 'llegada' && r.fija !== 'completed' && !ocultaFila(r) && (r.wait || 0) > LLE_ESPERA_LARGA).forEach((r) => {
      out.push({ k: 'wait', html: `En <b>${esc(r.vehicle)}</b> esperan <b>${r.wait} min</b> el carro en JMC<small>Aterrizan ${hhmm(r.arrival)} · el carro los recoge ${hhmm(r.pickup)}</small>`, btn: 'Ver', act: `data-act="ver" data-id="${esc(r.id)}"` });
    });
    slotsSinConductor().forEach((r, k) => {
      const [carId, b] = k.split('|');
      out.push({ k: 'nodriver', html: `<b>${esc(carId)}</b> no tiene conductor · ${esc(turnoTxt(b))}<small>${horarioDe(b) ? 'No queda nadie libre en ese turno según el horario publicado' : 'No hay horario publicado para ese turno'}</small>`, btn: 'Elegir', act: `data-act="assignslot" data-car="${esc(carId)}" data-shift="${esc(b)}"` });
    });
    // Se le quitó el conductor SOLO a una vuelta: el botón abre la hoja de esa vuelta.
    D.routes.filter((r) => r.propio && !r.driverId && !r.delegada && !r.tomar && r.fija !== 'completed' && !ocultaFila(r)).forEach((r) => {
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
    // …y con una vuelta de la ruta de Julián que tomó (o que el jefe le asignó).
    choquesConPegadas().forEach(({ id, a, b, cruza, llega, tarde }) => {
      const n = esc(conductor(id).name);
      const nom = (x) => (x.julian ? `la de Julián de las ${hhmm(x.ini)}` : `${esc(x.r.vehicle)} de las ${hhmm(x.ini)}`);
      const html = cruza
        ? `<b>${n}</b> tiene dos vueltas a la vez<small>${nom(a)} (hasta las ${hhmm(a.fin)}) y ${nom(b)}</small>`
        : `<b>${n}</b> no alcanza a llegar a ${nom(b)}<small>Termina ${nom(a)} ${a.julian ? (a.julian.type === 'llegada' ? 'en la última casa' : 'en JMC') : (a.r.type === 'llegada' ? 'en la última casa' : 'en JMC')} hacia las ${hhmm(a.fin)}: llegaría a las ${hhmm(llega)}, ${tarde} min tarde</small>`;
      // Se cambia la del tablero si no ha arrancado; si no, se va a la pegada (sus botones están en la lista).
      const tab = [b, a].find((x) => !x.julian && !x.fija);
      const peg = (b.julian && !b.fija ? b : a).julian;
      out.push(tab ? { k: 'drv', html, btn: 'Cambiar', act: `data-act="assign" data-id="${esc(tab.r.id)}"` }
        : { k: 'drv', html, btn: 'Ver', act: `data-act="verjulian" data-ra="${esc(peg.v.id)}"` });
    });
    return out;
  }

  function renderSay(av) {
    const live = rt.source === 'live' && !ui.cargando;
    const total = Object.keys(rt.aux || {}).length;
    const conCarro = total - (rt.pool || []).length;
    let txt, ok = false;
    if (ui.falloCarga) txt = 'No se pudo cargar el día · <a href="#" data-act="reintentar">Reintentar</a>';
    else if (ui.cargando) txt = 'Cargando el día…';
    else if (!live) txt = '';
    else if (!hayVueltas()) txt = `${plural((rt.pool || []).length, 'tripulante sin carro', 'tripulantes sin carro')}. Optimiza el día para armar las vueltas.`;
    else if (av.length) txt = `Antes de publicar, <a href="#" data-act="avisos">revisa ${plural(av.length, 'aviso', 'avisos')}</a>.`;
    else { txt = '<b>Todo listo.</b> Revisa lo que quieras y publica.'; ok = true; }
    el.say.hidden = !txt;
    el.say.classList.toggle('is-ok', ok);
    // Día mezclado: lo pegado se cuenta aparte (sus tripulantes no están en el tablero).
    const peg = ui.manual && ui.manual.mixto ? ` · además ${plural(ui.manual.vueltas.length, 'vuelta', 'vueltas')} de la ruta de Julián` : '';
    el.say.innerHTML = txt ? `<i aria-hidden="true"></i><span>${txt}</span>${live && hayVueltas() ? `<small>${plural(D.routes.length, 'vuelta', 'vueltas')} · ${conCarro} de ${total} tripulantes con carro${peg}</small>` : ''}` : '';
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
    el.avisos.classList.add('rv2-avcard');
    if (!av.length) { el.avisos.innerHTML = '<h2>Avisos</h2><ul class="rv2-al"><li class="is-ok">Nadie se queda sin carro y todos llegan a tiempo.</li></ul>'; return; }
    // 27-oct (Camilo): «reduce el tamaño del cuadro de avisos, para que no me ocupe
    // tanto campo». Sin el subtítulo y con renglones más bajos (admin-rutas-v2.css).
    // 28-oct (Camilo, audio): «que no aparezcan todos los avisos, sino que sea una
    // barrita pequeña con la cantidad de avisos, y yo le doy clic». Plegada hasta que
    // la toque; abierta, la lista entera, sin barra de desplazamiento propia.
    const abierto = !!ui.avisosAbiertos;
    el.avisos.innerHTML = `<button type="button" class="rv2-avbar" data-act="avtoggle" aria-expanded="${abierto}" aria-controls="rv2-al">`
      + `<h2>Avisos <span class="n">${av.length}</span></h2><span class="rv2-avbar-q">${avisosQ(abierto, av.length)}</span>`
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>'
      + `<ul class="rv2-al" id="rv2-al"${abierto ? '' : ' hidden'}>`
      + av.map((a) => `<li data-k="${a.k}"><span class="t">${a.html}</span><button class="rv2-btn rv2-btn--sm" ${a.act}>${a.btn}</button></li>`).join('') + '</ul>';
  }
  const avisosQ = (abierto, n) => (abierto ? 'Ocultar' : n === 1 ? 'Ver el aviso' : `Ver los ${n}`);
  function abrirAvisos(si) {
    ui.avisosAbiertos = si;
    const b = el.avisos && el.avisos.querySelector('.rv2-avbar'), ul = el.avisos && el.avisos.querySelector('.rv2-al');
    if (!b || !ul) return;
    ul.hidden = !si; b.setAttribute('aria-expanded', String(si));
    const q = b.querySelector('.rv2-avbar-q'); if (q) q.textContent = avisosQ(si, ul.children.length);
  }

  function renderDrivers() {
    if (rt.source !== 'live' || ui.cargando || !hayVueltas()) { el.drivers.innerHTML = ''; return; }
    const cells = {};
    D.routes.forEach((r) => { if (r.fija === 'completed') return; const k = r.vehicle + '|' + r.shift; const c = (cells[k] = cells[k] || { n: 0, otros: 0, deleg: 0, tomar: 0 }); if (r.delegada) c.deleg++; else if (r.tomar && !r.driverId) c.tomar++; else if (r.propio) c.otros++; else c.n++; });
    const bands = RT_BANDS.filter((b) => Object.keys(cells).some((k) => k.endsWith('|' + b)));
    const todos = (rt.cars || []).filter((c) => bands.some((b) => cells[c.id + '|' + b]));
    // 28-oct-2026 (la profa): «que solo quede Carro 1, Carro 2 y Carro Apoyo». Los
    // carros que el tablero agrega cuando una vuelta no cabe (Carro 3, Carro 4, el
    // «Carro» de una para tomar) van en UNA fila. Solo es cómo se ve: cada vuelta
    // sigue en su carro.
    const cars = todos.filter((c) => !c.apoyo), apoyo = todos.filter((c) => c.apoyo);
    const cuentaTxt = (c) => [c.n ? plural(c.n, 'vuelta', 'vueltas') : '', c.otros ? (c.n ? `${c.otros} con otro conductor` : `${plural(c.otros, 'vuelta', 'vueltas')} con otro conductor`) : '', c.deleg ? (c.deleg === 1 ? '1 delegada' : `${c.deleg} delegadas`) : '', c.tomar ? `${c.tomar} para tomar` : ''].filter(Boolean).join(' · ');
    // 27-oct (Camilo): sin la descripción, para que la tarjeta no ocupe tanto.
    let h = '<h2>Conductores</h2>' +
      `<div class="rv2-dgrid" style="grid-template-columns: 66px repeat(${bands.length}, minmax(0, 1fr))"><span></span>` +
      bands.map((b) => `<span class="hd">${esc(turnoTxt(b))}</span>`).join('');
    cars.forEach((car) => {
      // 0132: «Carro 1» se toca para elegir el carro de la flota.
      h += `<button class="car carbtn" data-act="plancar" data-car="${esc(car.id)}" aria-label="${esc(`${car.id}: ${car.planPlate ? 'es ' + car.planPlate : 'sin carro elegido'}. Elegir el carro`)}"><b>${esc(car.id)}</b><small>${car.planPlate ? esc(car.planPlate) : 'Elegir'}</small></button>`;
      bands.forEach((b) => {
        const k = car.id + '|' + b; const c = cells[k];
        if (!c) { h += '<span class="cell none">Sin vueltas</span>'; return; }
        const id = rtCarDrv(car, b); const d = conductor(id);
        const auto = !!id && !!rt.rv2Auto && rt.rv2Auto[k] === id;
        // 0124: la placa sale del turno. Hoy: la del turno abierto, o «sin iniciar turno».
        const placa = id ? placaDeTurno(id) : null;
        const enTurno = placa ? ' · en ' + esc(placa) : (id && Array.isArray(rt.activos) ? ' · sin iniciar turno' : '');
        h += `<button class="cell${id ? '' : ' need'}" data-act="assignslot" data-car="${esc(car.id)}" data-shift="${b}" aria-label="${esc(`${car.id}, ${turnoTxt(b)}: ${d ? d.name : 'sin conductor'}${placa ? ', en ' + placa : ''}. Cambiar`)}">` +
          `<b>${d ? esc(shortName(d.name)) : 'Sin conductor'}</b><small>${cuentaTxt(c)}${id ? (auto ? ' · automático' : ' · elegido') : ''}${enTurno}</small></button>`;
      });
    });
    if (apoyo.length) {
      // Sin «Elegir» placa: el de apoyo no es un carro de la flota.
      h += `<span class="car">${APOYO_TXT}</span>`;
      bands.forEach((b) => {
        const enB = apoyo.filter((car) => cells[car.id + '|' + b]);
        if (!enB.length) { h += '<span class="cell none">Sin vueltas</span>'; return; }
        const c = { n: 0, otros: 0, deleg: 0, tomar: 0 };
        enB.forEach((car) => { const x = cells[car.id + '|' + b]; Object.keys(c).forEach((f) => { c[f] += x[f]; }); });
        const ids = [...new Set(enB.map((car) => rtCarDrv(car, b)).filter(Boolean))];
        // Rojo si no hay nadie, o si a uno le faltan vueltas que siguen al carro
        // (las que solo tienen «para tomar» o delegadas no piden conductor).
        const falta = !ids.length || enB.some((car) => !rtCarDrv(car, b) && cells[car.id + '|' + b].n > 0);
        const solo = ids.length === 1 ? ids[0] : null;
        const auto = !!solo && !!rt.rv2Auto && enB.every((car) => rtCarDrv(car, b) !== solo || rt.rv2Auto[car.id + '|' + b] === solo);
        const placa = solo ? placaDeTurno(solo) : null;
        const enTurno = placa ? ' · en ' + esc(placa) : (solo && Array.isArray(rt.activos) ? ' · sin iniciar turno' : '');
        const nombres = ids.map((id) => shortName(conductor(id).name));
        h += `<button class="cell${falta ? ' need' : ''}" data-act="assignslot" data-car="${APOYO}" data-shift="${b}" aria-label="${esc(`${APOYO_TXT}, ${turnoTxt(b)}: ${nombres.length ? nombres.join(' y ') : 'sin conductor'}. Cambiar`)}">` +
          `<b>${nombres.length ? esc(nombres.join(' · ')) : 'Sin conductor'}</b><small>${cuentaTxt(c)}${solo ? (auto ? ' · automático' : ' · elegido') : ''}${enTurno}</small></button>`;
      });
    }
    el.drivers.innerHTML = h + '</div>' + libresHTML(todos, bands, cells);
  }
  // Los carros de apoyo de un turno con vueltas sin terminar (la fila «Carro Apoyo»).
  const APOYO = '__apoyo', APOYO_TXT = 'Carro Apoyo';
  const apoyoEn = (b) => (rt.cars || []).filter((c) => c.apoyo && D && D.routes.some((r) => r.vehicle === c.id && r.shift === b && r.fija !== 'completed'));
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
    // Quien tomó una vuelta de la ruta de Julián tampoco está «sin vueltas».
    pegadasLista(false).forEach((p) => { if (p.v.driverProfileId && !p.v.delegated && p.fija !== 'completed') usados.add(p.v.driverProfileId); });
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

  // 'ok' | 'bad' para una terminada, 'sinmarcar' si pasó su hora sin marcas (o la
  // delegada que pasó su hora: nadie la marca); '' si no.
  function finFila(r) {
    if (r.fija === 'completed') return r.fin && r.fin.estado === 'bad' ? 'bad' : 'ok';
    return r.fin && (r.fin.estado === 'sinmarcar' || r.fin.estado === 'delegada') ? 'sinmarcar' : '';
  }
  // 0137 (pendientes de los jefes, 26-oct): «que una vez finalice el servicio a los
  // 10 minutos desaparezca del listado». Baja al renglón de abajo la terminada 10 min
  // después de su última entrega, la delegada a su hora y la que pasó sin marcar
  // (Api._opResultado → fin.ocultaDesde, con los minutos de Calibración).
  function ocultaFila(r) {
    const d = r.fin && r.fin.ocultaDesde;
    if (d) return Date.now() >= d;
    // Sin la hora (un resultado viejo, sin 0137 en la pantalla): como antes, la
    // terminada baja de una.
    return r.fija === 'completed';
  }

  function rowHTML(r) {
    const d = conductor(r.driverId);
    const lle = r.type === 'llegada';
    const Hr = lle ? hotelDe(r.stops.map((s) => s.crewId)) : null;
    const sub = lle ? `${Hr ? 'Recoge en el ' + esc(Hr.name) : 'Recoge en JMC'} → última entrega` : 'Recoge → llega a JMC';
    let estado;
    // Terminada (verde o roja) o pasada sin marcar (gris): la fila va degradada.
    const fin = finFila(r);
    if (r.fija === 'completed') estado = fin === 'bad'
      ? `<small class="late">Terminada · ${esc(r.fin.motivos.join(' · '))}</small>`
      : `<small class="done">Terminada${r.fin && r.fin.at ? ' ' + esc(r.fin.at) : ''}${r.fin ? ' · sin novedad' : ''}</small>`;
    else if (fin === 'sinmarcar' && r.fin.estado === 'delegada') estado = `<small>Delegada${r.delegName ? ' · ' + esc(r.delegName) : ''} · ya pasó su hora</small>`;
    else if (fin === 'sinmarcar') estado = `<small>Pasó su hora · ${plural(r.fin.faltan, 'parada', 'paradas')} sin marcar</small>`;
    else if (r.status === 'risk') estado = `<small class="late">${Math.abs(r.margin)} min tarde · presentación ${hhmm(r.pres)}</small>`;
    else if (r.type === 'llegada' && (r.wait || 0) > LLE_ESPERA_LARGA) estado = `<small class="late">Esperan ${r.wait} min el carro</small>`;
    else if (lle) {
      const tierra = r.stops.every((s) => aux(s.crewId) && aux(s.crewId).tierra);
      const reserva = tierra && r.stops.every((s) => aux(s.crewId).reserva);
      estado = `<small>${reserva ? 'Termina la asignación' : (tierra ? 'Salen del terminal' : 'Aterriza')} ${hhmm(r.arrival)}</small>`;
    } else estado = `<small>Presentación ${hhmm(r.pres)}</small>`;
    // «en curso» solo mientras de verdad puede ir en curso: la que pasó su hora sin
    // marcar no lo dice (antes se quedaba «en curso» horas después de terminar).
    const enCurso = r.fija === 'in_progress' && !finFila(r) ? ' <span class="tag">en curso</span>' : '';
    const chips = r.stops.map((st) => {
      const a = aux(st.crewId) || {};
      const fijo = atendida(st.crewId) || r.fija === 'completed';
      const attrs = fijo ? 'disabled title="Ya atendido: no se mueve"' : `draggable="true" data-drag="${esc(st.crewId)}" data-act="move" data-crew="${esc(st.crewId)}" data-from="${esc(r.id)}" title="Arrástralo a otra vuelta o tócalo para moverlo"`;
      // Llegada (27-oct, Camilo: «¿al lado del nombre esa hora es la de aterrizaje?»):
      // la hora de la izquierda ES la de aterrizaje (o la del hotel), con el vuelo
      // entre paréntesis como en la lista del jefe, y a la derecha a dónde va.
      // Antes era la hora de entrega en la casa y nadie sabía qué era.
      if (lle) {
        const o = salidaLle(a);
        return `<button class="rv2-p rv2-p--lle" ${attrs}><span class="mono">${esc(a.dl || '—')}</span><span class="nm">${hl(a.n || 'Tripulante')}</span>` +
          `${o.par ? `<span class="org">(${hl(o.par)})</span>` : ''}<span class="pl">→ ${hl(a.zona || '—')}</span></button>`;
      }
      return `<button class="rv2-p" ${attrs}><span class="mono">${hhmm(st.time)}</span><span class="nm">${hl(a.n || 'Tripulante')}</span><span class="pl">${hl(a.zona || '')}</span></button>`;
    }).join('');
    const aria = `${r.vehicle}, ${TYPE[r.type]}, ${horas(r)}${r.status === 'risk' ? ', llega tarde' : ''}, ${r.stops.map((s) => nombre(s.crewId)).join(', ')}`;
    return `<div class="rv2-row" role="button" tabindex="0" data-id="${esc(r.id)}" data-s="${r.status}"${fin ? ` data-fin="${fin}"` : ''}${ui.sel === r.id ? ' aria-current="true"' : ''} aria-label="${esc(aria)}">` +
      `<div class="when"><b class="mono">${horas(r)}</b><small>${sub}</small>${estado}</div>` +
      `<div class="main"><div class="l1"><span class="rv2-pill ${r.type}">${TYPE[r.type]}</span><b class="car">${hl(r.vehicle)}</b>` +
      (r.delegada
        ? `<span class="drv deleg" title="La hace alguien de afuera: ningún conductor la ve">Delegada${r.delegName ? ' · ' + hl(r.delegName) : ''}</span>`
        : r.tomar
        ? (d ? `<span class="drv">${hl(d.name)}</span> <span class="tag tomar" title="La dejaste para tomar y este conductor la tomó">la tomó</span>`
          : '<span class="drv tomar" title="La ven los conductores del turno en «Vueltas para tomar»">Para tomar · nadie la ha tomado</span>')
        : `<span class="drv${d ? '' : ' none'}">${d ? hl(d.name) : 'Sin conductor'}</span>${r.propio ? ' <span class="tag own" title="Conductor puesto solo a esta vuelta">solo esta vuelta</span>' : ''}`) +
      `${enCurso}${horaEditable(r) ? `<button class="rv2-btn rv2-btn--sm rv2-hbtn" data-act="hora" data-id="${esc(r.id)}" aria-label="Cambiar la hora de ${esc(r.vehicle)} de las ${horas(r)}">Cambiar hora</button>` : ''}</div><div class="people">${chips}</div></div></div>`;
  }

  function emptyHTML() {
    if (ui.falloCarga) {
      return `<div class="rv2-empty" role="alert"><b>No se pudo cargar ${ui.falloCarga.dia ? esc(dayLabel(ui.falloCarga.dia)) : 'el día'}</b>${esc(ui.falloCarga.motivo)}`
        + '<br>Puedes reintentar o usar ‹ › para ver otro día.<br><button class="rv2-btn rv2-btn--cta" data-act="reintentar">Reintentar</button>'
        + (ui.falloCarga.detalle ? `<br><small style="display:block;margin-top:12px;font-size:11px;opacity:.75;word-break:break-word">Detalle técnico (mándale una captura a soporte): ${esc(ui.falloCarga.detalle)}</small>` : '')
        + '</div>';
    }
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
  // Las vueltas pegadas (r.julian, pegadasLista) van en su hora junto a las del
  // tablero. Una hora 24 o más es la madrugada siguiente que Julián pegó con este día.
  function horasHTML(rows) {
    const groups = new Map();
    rows.forEach((r) => { if (!groups.has(r.hora)) groups.set(r.hora, []); groups.get(r.hora).push(r); });
    let html = '';
    [...groups.keys()].sort((a, b) => a - b).forEach((h) => {
      const g = groups.get(h).sort((a, b) => a.orden - b.orden || a.arrival - b.arrival);
      const malas = g.filter((r) => r.status === 'risk' || (r.type === 'llegada' && (r.wait || 0) > LLE_ESPERA_LARGA)).length;
      html += `<div class="rv2-gwrap"><div class="rv2-hour"><strong>${pad(h % 24)}:00 – ${pad((h + 1) % 24)}:00</strong>${h >= 24 ? ' · después de medianoche' : ''} · ${plural(g.length, 'vuelta', 'vueltas')}${malas ? ` · <span class="t-risk">${plural(malas, 'con aviso', 'con aviso')}</span>` : ''}</div>`;
      g.forEach((r) => { html += r.julian ? filaPegada(r) : rowHTML(r); });
      html += '</div>';
    });
    return html;
  }
  // 0134: las vueltas para tomar que armó el sistema ese día (cambios de vuelo).
  function solasHTML() {
    const vs = rt.rv2Solas || [];
    if (!vs.length) return '';
    return `<div class="rv2-madsig rv2-solas" data-k="solas"><div><b>↻ ${plural(vs.length, 'vuelta para tomar que armó el sistema', 'vueltas para tomar que armó el sistema')}</b>` +
      `<small>${vs.map((v) => `${esc(v.hora)} ${esc(v.tipo)} · ${esc(v.quienes || '—')} · ${v.conductor ? 'la tomó ' + esc(v.conductor) : 'sin tomar'}`).join(' · ')}. ` +
      'Alguien cambió de vuelo y no cabía en otra vuelta: los conductores la ven en «Vueltas para tomar» y si nadie la toma les suena a los jefes.</small></div></div>';
  }
  function madSigHTML() {
    const m = ui.madSig;
    const sig = sumarDias(rt.day || ui.dia, 1);
    const pend = (pegadoPendiente[sig] || []).length;
    if (!pend && (!m || m.dia !== sig || !(m.vueltas || m.reservas))) return '';
    const que = pend
      ? `${plural(pend, 'vuelta pegada espera', 'vueltas pegadas esperan')}: entran al tablero de ese día cuando lo abras, y ahí se publican`
      : m.vueltas
        ? `${plural(m.vueltas, 'vuelta', 'vueltas')}${m.sinConductor ? ` (${m.sinConductor} sin conductor)` : ''}`
        : `${plural(m.reservas, 'tripulante', 'tripulantes')}, todavía sin plan publicado`;
    return `<div class="rv2-madsig"><div><b>☾ Sigue después de medianoche · madrugada del ${esc(dayLabel(sig).toLowerCase())}</b>` +
      `<small>${esc(que)}. De 00:00 a ${rtHHc()} también son de este turno PM, pero se planean y publican en el día siguiente.</small></div>` +
      `<button class="rv2-btn rv2-btn--sm" data-act="nav" data-dir="1">Ver la madrugada</button></div>`;
  }
  // Lista de los jefes (26-oct-2026): «a medida que se vayan terminando los
  // servicios que los quite del listado del día, para así tener mejor
  // visualización». Las terminadas (verdes o rojas) salen de la lista y quedan
  // en un renglón al final que las muestra si se toca; las que pasaron su hora
  // SIN marcar se quedan arriba, porque piden que alguien mire. Buscando a
  // alguien se ven todas: la búsqueda tiene que encontrarlo aunque ya llegó.
  function hechasHTML(hechas) {
    if (!hechas.length) return '';
    const malas = hechas.filter((r) => finFila(r) === 'bad').length;
    // 0137: también bajan las que pasaron su hora sin marcar y las delegadas pasadas.
    const sinMarcar = hechas.filter((r) => r.fin && r.fin.estado === 'sinmarcar').length;
    const delegadas = hechas.filter((r) => r.fin && r.fin.estado === 'delegada').length;
    const term = hechas.length - sinMarcar - delegadas;
    const titulo = [term ? `✓ ${plural(term, 'vuelta terminada', 'vueltas terminadas')}` : '',
      sinMarcar ? plural(sinMarcar, 'pasó sin marcar', 'pasaron sin marcar') : '',
      delegadas ? plural(delegadas, 'delegada', 'delegadas') : ''].filter(Boolean).join(' · ');
    return `<div class="rv2-hechas"><button class="rv2-hechas-b" data-act="hechas" aria-expanded="${ui.verHechas}">` +
      `<b>${titulo}</b>` +
      `<small>${malas ? `${plural(malas, 'con novedad', 'con novedad')} · ` : ''}${ui.verHechas ? 'Ocultar' : 'Ver'}</small></button>` +
      (ui.verHechas ? horasHTML(hechas) : '') + '</div>';
  }
  // Día mezclado (26-oct-2026). Primero la ruta pegada iba arriba de la lista, en
  // un recuadro aparte; los jefes (audios de las 4:22 p. m.) la quieren «en el
  // listado normal completo, organizado por horas». Ahora arriba queda solo la barra
  // (Volver a pegar, Excel del día, Quitar la ruta) y cada vuelta pegada va en la
  // lista, en su hora, con la etiqueta «Ruta de Julián» y sus botones (conductor,
  // Delegar, Cambiar hora: admin-ruta-julian.js · filaLista).
  const hayPegadas = () => !!(ui.manual && ui.manual.mixto && !ui.cargando && window.RendioRutaJulian && typeof window.RendioRutaJulian.filaLista === 'function');
  const minDelDia = (iso) => (Date.parse(iso) - Date.parse((rt.day || ui.dia) + 'T00:00:00-05:00')) / 60000;
  // Quien va en una vuelta pegada salió de rt.aux (rearmarPublicado): su pedido está en rt.rv2AuxPegadas.
  function auxPegada(rid) {
    if (!rid) return null;
    const ks = [rt.rv2AuxPegadas || {}, rt.aux || {}];
    for (const m of ks) { const k = Object.keys(m).find((x) => m[x].reservationId === rid); if (k) return m[k]; }
    return null;
  }
  function pegadaCoincide(v, q) {
    return [...(v.pendientes || []), ...(v.atendidas || [])].some((g) => norm(g.name).includes(q) || norm((auxPegada(g.rid) || {}).zona).includes(q))
      || (v.driverProfileId && norm(v.conductor).includes(q)) || (v.delegateName && norm(v.delegateName).includes(q)) || norm('ruta de julian').includes(q);
  }
  // Cada vuelta pegada como fila de la lista. El orden es el del tablero (pendientes
  // de los jefes, 26-oct): manda la PRIMERA hora que se lee, la primera recogida en
  // una salida y la salida de JMC en una llegada. En una salida el «Deben estar» hace
  // de llegada a JMC (para los choques del conductor).
  function pegadasLista(buscando) {
    if (!hayPegadas()) return [];
    const q = norm(ui.q);
    return ui.manual.vueltas.filter((v) => !buscando || pegadaCoincide(v, q)).map((v) => {
      const g = [...(v.atendidas || []), ...(v.pendientes || [])].sort((a, b) => a.order - b.order);
      const lle = v.type === 'lle';
      const pickup = minDelDia(lle ? v.startAt : ((g[0] && g[0].etaAt) || v.startAt));
      const ultima = lle ? pickup : Math.max(...g.map((x) => (x.etaAt ? minDelDia(x.etaAt) : pickup)), pickup);
      const arrival = lle ? pickup : (v.deadlineAt ? minDelDia(v.deadlineAt) : ultima + 20);
      const hecha = v.status === 'completed' || (v.fin && (v.fin.estado === 'ok' || v.fin.estado === 'bad'));
      return { julian: true, id: 'jl:' + v.id, v, type: lle ? 'llegada' : 'salida', pickup, arrival, orden: pickup, hora: Math.floor(pickup / 60),
        shift: pickup < rtCut() ? 'mad' : 'dia', fija: hecha ? 'completed' : null, fin: v.fin || null, stops: [] };
    });
  }
  function filaPegada(p) {
    return window.RendioRutaJulian.filaLista(p.v, { hl, aux: auxPegada, fin: finFila(p) });
  }
  function barraPegadas(buscando) {
    return !buscando && hayPegadas() && typeof window.RendioRutaJulian.barraHTML === 'function'
      ? window.RendioRutaJulian.barraHTML(ui.manual.vueltas, ui.dia) : '';
  }
  function renderList() {
    const vacio = emptyHTML();
    const buscando = !!(ui.q && ui.q.trim());
    const peg = barraPegadas(buscando);
    const pegs = vacio ? [] : pegadasLista(buscando);
    if (vacio) { el.list.innerHTML = peg + vacio + (ui.cargando ? '' : solasHTML() + madSigHTML()); return; }
    const todas = D.routes.filter(matchesQ).concat(pegs);
    if (!todas.length) { el.list.innerHTML = `<div class="rv2-empty"><b>Sin resultados para «${esc(ui.q)}»</b>Prueba con otro nombre, carro o conjunto.</div>`; return; }
    const hechas = buscando ? [] : todas.filter(ocultaFila);
    const rows = todas.filter((r) => !hechas.includes(r));
    if (!rows.length) { el.list.innerHTML = peg + `<div class="rv2-empty"><b>Ya terminaron todas las vueltas de ${esc(dayLabel(rt.day || ui.dia).toLowerCase())}</b>Quedan abajo, por si quieres revisarlas.</div>` + hechasHTML(hechas) + madSigHTML(); return; }
    const mad = rows.filter((r) => r.shift === 'mad'), resto = rows.filter((r) => r.shift !== 'mad');
    let html = peg + (buscando ? '' : solasHTML());
    if (mad.length) {
      html += `<section class="rv2-mad" aria-label="Madrugada, turno PM del ${esc(rtDiaAnterior())}"><div class="rv2-madh"><b>☾ Madrugada · cierre del turno PM del ${esc(rtDiaAnterior())}</b>` +
        `<small>De 00:00 a ${rtHHc()} las hace el conductor de la tarde del ${esc(rtDiaAnterior())}. El día ${esc(dayLabel(rt.day || ui.dia).toLowerCase())} arranca a las ${rtHHc()}.</small></div>` +
        horasHTML(mad) + '</section>';
      if (resto.length) html += `<div class="rv2-dayh">${esc(dayLabel(rt.day || ui.dia))} · desde las ${rtHHc()}</div>`;
    }
    el.list.innerHTML = html + horasHTML(resto) + hechasHTML(hechas) + madSigHTML();
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
        : (a.guest ? ' · sin cuenta' : (a.dl ? ' · pres. ' + esc(a.dl) : '')) + (resTxt(a) ? ' · ' + esc(resTxt(a)) : '') + (a.vuelo ? chipVuelo(a.vuelo, 'sal') : '');
      const at = atendida(st.crewId);
      const tel = a.tel ? `<a class="rv2-ic" href="${esc(telHref(a.tel))}" aria-label="Llamar a ${esc(a.n)}">${IC.phone}</a>`
        : `<button class="rv2-ic" disabled aria-label="${esc(a.n)} no tiene teléfono registrado" title="Sin teléfono registrado">${IC.phone}</button>`;
      const mv = (at || fija)
        ? `<button class="rv2-btn rv2-btn--sm rv2-mv" disabled title="Ya atendido: no se puede mover">Atendido</button>`
        : `<button class="rv2-btn rv2-btn--sm rv2-mv" data-act="move" data-crew="${esc(st.crewId)}" data-from="${esc(r.id)}" aria-label="Mover a ${esc(a.n)}">Mover</button>`;
      // En la llegada la hora de la izquierda es cuando lo deja en la casa; sin
      // decirlo, los jefes la leían como la hora que había puesto el tripulante
      // (audio del 14-oct-2026: «¿por qué salen dos horas?»).
      // 27-oct-2026 (Camilo): «dice llega a casa · Origen · Hotel, debería ser hotel ·
      // Origen · llega a casa». Se lee como se recorre: de dónde sale (el vuelo, el
      // hotel o JMC) → a dónde va, y al final qué es la hora de la izquierda.
      const o = r.type === 'llegada' ? salidaLle(a) : null;
      const que = o
        ? `${esc(o.desde)}${o.vuelo ? chipVuelo(o.vuelo, 'lle') : ''} → ${esc(lugar(st.crewId))} · llega a casa`
        : `${esc(lugar(st.crewId))}${extra}`;
      // 27-oct (Camilo): «cambio de hora y datos … para editar manual si es necesario»:
      // la ficha del tripulante (conjunto, apartamento) sin salir de Asignación.
      const datos = a.profileId && typeof window.openEditarDatos === 'function'
        ? `<button class="rv2-btn rv2-btn--sm rv2-mv" data-act="datos" data-crew="${esc(st.crewId)}" aria-label="Datos de ${esc(a.n)}">Datos</button>` : '';
      return `<li draggable="${at || fija ? 'false' : 'true'}"${at || fija ? '' : ` data-drag="${esc(st.crewId)}" data-from="${esc(r.id)}"`}><span class="mono">${hhmm(st.time)}</span><div><b>${esc(a.n)}</b>${que}${at ? ' · ya atendido' : ''}</div>${tel}${datos}${mv}</li>`;
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
    const fijaTxt = r.fija === 'completed' ? ' · terminada' : finFila(r) === 'sinmarcar' ? ' · pasó su hora' : r.fija === 'in_progress' ? ' · en curso' : '';
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
    const quien = r.tomar
      ? (d ? `<b>${esc(d.name)}</b>La tomó de «Vueltas para tomar»` : '<b>Para tomar</b>La ven los conductores del turno en su app. Si nadie la toma, te avisamos 60 min antes')
      : r.delegada
      ? (r.delegName
        ? `<b>Delegada a ${esc(r.delegName)}</b>${r.delegPhone ? esc(r.delegPhone) + ' · ' : ''}al tripulante le llega «Te recogerá ${esc(r.delegName.split(' ')[0])}» con este número`
        : '<b>Delegada</b>La hace alguien de afuera. Ningún conductor la ve; al publicar, al tripulante le llega que lo contactan por WhatsApp')
      : r.propio
      ? (d ? `<b>${esc(d.name)}</b>Conductor solo de esta vuelta` : '<b>Sin conductor</b>Se le quitó solo a esta vuelta')
      : (d ? `<b>${esc(d.name)}</b>Conductor · turno ${turno}${auto ? ' · automático' : ''}` : `<b>Sin conductor</b>Turno ${turno} de ${esc(r.vehicle)}`);
    const drvHTML = `<div class="rv2-drv"><span class="rv2-av">${d ? esc(initials(d.name)) : r.delegada ? '↗' : '?'}</span><div>${quien}</div>` +
      (d && d.phone ? `<a class="rv2-ic" href="${esc(telHref(d.phone))}" aria-label="Llamar a ${esc(d.name)}">${IC.phone}</a>` : '') +
      (r.delegada && r.delegPhone ? `<a class="rv2-ic" href="${esc(telHref(r.delegPhone))}" aria-label="Llamar a ${esc(r.delegName || 'quien la hace')}">${IC.phone}</a>` : '') +
      (r.fija === 'completed' ? '' : `<button class="rv2-btn ${d || r.delegada ? '' : 'rv2-btn--soft'} rv2-btn--sm" data-act="assign" data-id="${esc(r.id)}">${d || r.delegada ? 'Cambiar' : 'Asignar'}</button>`) + '</div>';
    el.dtop.innerHTML = `<p class="rv2-alert rv2-alert--${alertCls(r)}">${esc(alertTxt(r))}</p>${sugHTML}`;
    el.dbot.innerHTML = `${drvHTML}<div class="rv2-caprow"><h3 class="rv2-cap">Paradas · orden de ${r.type === 'llegada' ? 'entrega' : 'recogida'}</h3>`
      + `${horaEditable(r) ? `<button class="rv2-btn rv2-btn--sm" data-act="hora" data-id="${esc(r.id)}">Cambiar hora</button>` : ''}</div><ol class="rv2-stops">${stopsHTML(r)}</ol>`;
    dibujarMapa(r);
  }

  // «CAMBIAR HORA» EN CUALQUIER VUELTA (27-oct-2026). Camilo: «el botón de cambio
  // de hora … solo aparece cuando uno monta la ruta por la opción de pegar ruta
  // Julián. Debería aparecer siempre en el listado en todos los servicios de cada
  // TC. Para editar manual si es necesario». Las horas que se ponen aquí quedan
  // como las del jefe (rt.horasPub): se ven, se respetan al mover a alguien
  // (conservarHoras) y salen con «Publicar», como cualquier cambio del tablero.
  // Salida: la hora de cada recogida (mover la primera corre las que no se hayan
  // tocado). Llegada: cuándo sale el carro de JMC (o del hotel) a recogerlos.
  const horaEditable = (r) => !!r && !r.fija && finFila(r) !== 'sinmarcar' && rt.source === 'live';
  const aHM = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  // «04:40» → minutos, lo más cerca de `ref` (la madrugada no salta de día).
  const deHM = (v, ref) => {
    const x = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); if (!x) return null;
    let m = Number(x[1]) * 60 + Number(x[2]);
    if (ref != null) { while (m - ref > 720) m -= 1440; while (ref - m > 720) m += 1440; }
    return m;
  };
  function openHora(laneId) {
    const lane = rtLaneOf(laneId); const r = D && D.byId[laneId];
    if (!lane || !horaEditable(r)) return;
    const lle = r.type === 'llegada';
    const fila = (attrs, txt, min) => `<label class="rj-h-p"><input type="time" class="rj-h-in" ${attrs} value="${aHM(min)}"><span>${txt}</span></label>`;
    const quienes = r.stops.map((s) => esc(nombre(s.crewId))).join(', ');
    const cuerpo = lle
      ? fila(`data-h="start" data-orig="${r.pickup}"`, `Sale a recogerlos · ${quienes}`, r.pickup)
      : r.stops.map((s, i) => fila(`data-h="stop" data-i="${i}" data-crew="${esc(s.crewId)}" data-orig="${s.time}"`, `<b>${esc(nombre(s.crewId))}</b> · ${esc(lugar(s.crewId))}`, s.time)).join('');
    openSheet(sheetHead(`Cambiar hora · ${esc(r.vehicle)}`, `${esc(TYPE[r.type])} de las ${hhmm(inicioDe(r).at)} · ${lle
      ? 'la hora en que el carro sale a recogerlos.'
      : 'si mueves la primera recogida, las demás se corren igual (las que no hayas tocado).'} Queda en el tablero: con «Publicar» le llega a cada uno su hora nueva.`)
      + `<div class="rv2-sh-body rj-hora">${cuerpo}<p class="rj-warn" id="rv2-h-msg" hidden></p></div>`
      + '<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-h-ok">Guardar en el tablero</button></div>');
    setLabel();
    const sh = el.sheet;
    const ins = () => [...sh.querySelectorAll('.rj-h-in')];
    sh.querySelectorAll('.rj-h-in').forEach((inp) => inp.addEventListener('input', () => {
      inp.setAttribute('data-tocado', '1');
      if (!(inp.getAttribute('data-h') === 'stop' && inp.getAttribute('data-i') === '0')) return;
      const o = Number(inp.getAttribute('data-orig')), n = deHM(inp.value, o);
      if (n == null) return;
      ins().forEach((x) => { if (x !== inp && x.getAttribute('data-tocado') !== '1') x.value = aHM(Number(x.getAttribute('data-orig')) + (n - o)); });
    }));
    $('#rv2-h-ok').addEventListener('click', () => {
      const msg = $('#rv2-h-msg');
      const decir = (t) => { msg.textContent = t; msg.hidden = !t; };
      const ids = rt.order[laneId] || [];
      if (lle) {
        const x = ins()[0], m = x ? deHM(x.value, Number(x.getAttribute('data-orig'))) : null;
        if (m == null) return decir('Pon la hora en que sale el carro.');
        snapshot('hora');
        lane.start = aHM(m);
        rt.horasPub[laneId] = { start: lane.start, sig: ids.join(','), etas: {} };
      } else {
        const etas = {};
        for (const x of ins()) {
          const m = deHM(x.value, Number(x.getAttribute('data-orig')));
          if (m == null) return decir('Cada recogida necesita su hora.');
          etas[x.getAttribute('data-crew')] = m;
        }
        const enOrden = ids.map((k) => etas[k]);
        if (enOrden.some((m, i) => i && m < enOrden[i - 1])) return decir('Las horas van en el orden del recorrido: una recogida no puede quedar antes de la anterior. Para cambiar el orden, mueve a la persona.');
        snapshot('hora');
        lane.start = aHM(enOrden[0]);
        rt.horasPub = rt.horasPub || {};
        rt.horasPub[laneId] = { start: lane.start, sig: ids.join(','), etas };
      }
      closeSheet();
      commit(`Horas de ${r.vehicle} de las ${hhmm(inicioDe(r).at)} cambiadas · se avisan al publicar`);
    });
  }
  function abrirDatos(crewId) {
    const a = aux(crewId);
    if (!a || !a.profileId || typeof window.openEditarDatos !== 'function') return;
    // Al guardar se vuelve a leer el día: el conjunto nuevo cambia la parada.
    window.openEditarDatos(a.profileId, () => { if (rt.day) cargarDia(rt.day); });
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
      ((r.stops || []).length > 1 ? `<button class="rv2-opt rv2-opt--sola" data-act="sola" data-crew="${esc(crew)}" data-from="${esc(r.id)}"><span class="t"><b>Pasar a una vuelta sola</b></span><small>Una vuelta nueva solo con ${esc(String(a.n || '').split(' ')[0] || 'ella')}, en un carro libre a esa hora. Después le pones el conductor.</small></button>` : '') +
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

  // El día va SOLO con la ruta de Julián (sin vueltas del tablero). Si además hay
  // tablero (día mezclado, 26-oct-2026) se ve el tablero entero con la ruta pegada arriba.
  const soloJulian = () => !!(ui.manual && !ui.manual.mixto);
  const T_JULIAN = 'Este día va con la ruta de Julián';
  function render() {
    if (!root()) return;
    if (ui.falloCarga) { pintarFallo(); return; }
    if (soloJulian() && !ui.cargando && window.RendioRutaJulian) { renderManual(); return; }
    // Lo que dejó un día solo de Julián (el título de los botones apagados).
    [el.publish, el.publishM, el.reopt, el.enrutar].forEach((b) => { if (b && b.title === T_JULIAN) b.title = ''; });
    if (!ui.cargando) autoLlenar();
    D = armarDia();
    if (ui.sel && !D.byId[ui.sel]) { ui.sel = null; ui.moving = null; }
    const av = avisosDe();
    renderBar(); renderSay(av); renderAvisos(av); renderDrivers(); pintarEntregas(); renderList(); renderDetail();
  }
  // El día no se pudo cargar o mostrar (26-oct-2026): se pinta el aviso SIN armar
  // el día (armarDia, avisos, conductores), porque pudo ser justo eso lo que falló.
  function pintarFallo() {
    try { renderBar(); } catch (_) { /* la barra con ‹ › es lo último que se pierde */ }
    el.say.hidden = false; el.say.classList.remove('is-ok');
    el.say.innerHTML = '<i aria-hidden="true"></i><span>No se pudo cargar el día · <a href="#" data-act="reintentar">Reintentar</a></span>';
    el.pending.hidden = true;
    el.summary.hidden = true; el.avisos.innerHTML = ''; el.drivers.innerHTML = '';
    try { pintarEntregas(); } catch (_) { /* sin entregas */ }
    el.list.innerHTML = emptyHTML();
    [el.publish, el.publishM, el.reopt, el.enrutar].forEach((b) => { if (b) b.disabled = true; });
    if (el.dhead) { el.dhead.innerHTML = ''; el.dtop.innerHTML = ''; el.dbot.innerHTML = ''; el.mapwrap.hidden = true; }
  }
  // Para el aviso: qué falló y dónde (en Safari «armarDia@…/admin-rutas-v2.js:812:33»).
  function detalleDe(e) {
    const msg = e ? `${e.name || 'Error'}: ${e.message || e}` : 'Error desconocido';
    const pila = String((e && e.stack) || '').split('\n').map((x) => x.trim()).filter((x) => x && x !== msg).slice(0, 3).join(' ← ');
    return (msg + (pila ? ' · ' + pila : '')).slice(0, 400);
  }
  // 0140: «Entregas de turno» (admin-entregas.js) del día que se ve.
  function pintarEntregas() {
    // 0153: el botón «Cambios» de los tripulantes (admin-cambios.js) va con el día que se ve.
    if (window.RendioCambios && rt.source === 'live' && !ui.cargando && (rt.day || ui.dia)) { try { window.RendioCambios.pintar(rt.day || ui.dia); } catch (_) { /* el botón es lo de menos */ } }
    if (!el.entregas || !window.RendioEntregas) return;
    window.RendioEntregas.pintar(el.entregas, rt.source === 'live' && !ui.cargando ? (rt.day || ui.dia) : null);
  }

  // 0125: el día va con la ruta de Julián. El tablero (Avisos, Conductores, mover,
  // Publicar, Re-optimizar) no aplica: los conductores toman las vueltas.
  function renderManual() {
    D = armarDia();
    renderBar();
    el.summary.hidden = true; el.avisos.innerHTML = ''; el.drivers.innerHTML = '';
    pintarEntregas();
    el.say.hidden = false; el.say.classList.add('is-ok');
    el.say.innerHTML = '<i aria-hidden="true"></i><span><b>Este día va con la ruta de Julián.</b> Los conductores toman las vueltas en su app; aquí ves cuáles faltan.</span>';
    el.list.innerHTML = window.RendioRutaJulian.diaHTML(ui.manual.vueltas, ui.dia, ui.manual.otras);
    ui.sel = null;
    if (el.detail) { el.detail.classList.remove('is-open'); if (el.dhead) el.dhead.innerHTML = ''; if (el.dtop) el.dtop.innerHTML = ''; if (el.dbot) el.dbot.innerHTML = ''; if (el.mapwrap) el.mapwrap.hidden = true; }
    [el.publish, el.publishM, el.reopt, el.enrutar].forEach((b) => { if (b) { b.disabled = true; b.title = T_JULIAN; } });
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

  // UNA VUELTA EN UN CARRO (27-oct-2026). Lo que pegar y «Pasar a una vuelta sola»
  // comparten: el primer carro que esté libre a esa hora; si ninguno, uno más (los
  // planes del jefe piden un tercero en el pico). El conductor lo pone el turno del
  // carro (autoLlenar), y se cambia con «Cambiar», como en cualquier vuelta.
  //   n: { type, ids, start: 'HH:MM', landing?: min, horas?: { llave: min } }
  const renumerarCarro = (carId) => {
    rt.lanes.filter((l) => l.car === carId && (rt.order[l.id] || []).length)
      .sort((a, b) => rtToMin(a.start) - rtToMin(b.start) || a.vuelta - b.vuelta)
      .forEach((l, i) => { l.vuelta = i + 1; });
    encadenar(carId);
  };
  // Cuándo tiene que estar libre el carro: en una llegada, a la salida de JMC; en
  // una salida, la primera recogida menos lo que tarda en llegar ahí.
  const hacePorLaFalta = (l) => {
    if (l.type === 'lle') return rtToMin(l.start);
    const ids = rt.order[l.id] || [];
    const s0 = (rtCarCompute(l.id).stops || [])[0];
    return s0 ? s0.eta - (l.origin && ids[0] ? rtLegMin(l.origin, ids[0]) : 0) : rtToMin(l.start);
  };
  const cabeEnCarro = (lane) => {
    const l0 = libreDe(lane);
    if (l0 != null && l0 > hacePorLaFalta(lane) + TOL_CHOQUE) return false;
    const sig = siguienteDe(lane.id);
    const l1 = sig ? libreDe(sig) : null;
    return !(sig && l1 != null && l1 > hacePorLaFalta(sig) + TOL_CHOQUE);
  };
  const idLibreDe = (carId) => { let i = 1; while (rt.order[`${carId}·V${i}`] || rt.lanes.some((l) => l.id === `${carId}·V${i}`)) i++; return `${carId}·V${i}`; };
  function ubicarVuelta(n, nuevosCarros) {
    const lane = { id: null, car: null, vuelta: 0, type: n.type, start: n.start, origin: n.type === 'lle' ? 'airport' : null };
    if (n.type === 'lle' && n.landing != null) lane.landing = rtToHM(n.landing);
    const poner = (car) => {
      lane.car = car.id; lane.id = idLibreDe(car.id);
      rt.lanes.push(lane); rt.order[lane.id] = n.ids.slice();
      if (n.horas) rt.horasPub[lane.id] = { start: lane.start, sig: n.ids.join(','), etas: n.type === 'lle' ? {} : Object.assign({}, n.horas) };
      renumerarCarro(car.id);
    };
    const quitar = () => {
      rt.lanes = rt.lanes.filter((l) => l !== lane);
      delete rt.order[lane.id]; delete rt.horasPub[lane.id]; renumerarCarro(lane.car);
    };
    let car = rt.cars.find((c) => { poner(c); if (cabeEnCarro(lane)) return true; quitar(); return false; });
    if (!car) {
      let i = rt.cars.length + 1, id; do { id = 'Carro ' + i++; } while (rt.cars.some((c) => c.id === id));
      // 28-oct: un carro de más se ve en Conductores dentro de «Carro Apoyo».
      car = { id, avail0: '00:00', driver: null, capacity: rt.CAP, vehicleId: null, apoyo: true };
      rt.cars.push(car); if (nuevosCarros) nuevosCarros.push(id);
      poner(car);
    }
    return lane;
  }

  // «PASAR A UNA VUELTA SOLA» (27-oct-2026, la profa: «tomar un tripulante de una
  // vuelta, quitarlo y pasarlo a estar solo para asignarle un conductor»). Hasta hoy
  // Mover y Ubicar solo ofrecían vueltas que ya existían: la de Manuela con Daniel se
  // hizo por script. Sale de su vuelta (que se reprograma sin ella) a una vuelta
  // NUEVA solo con ella, y queda abierta para ponerle conductor.
  //   Salida: conserva la hora a la que la recogían (o la del modelo si no tenía).
  //   Llegada: sale de JMC cuando ella ya salió (su vuelo + desembarque).
  function pasarASola(crewId, fromId) {
    const a = aux(crewId); if (!a) return null;
    const from = fromId ? rtLaneOf(fromId) : null;
    if (from && (fijaDe(from.id) || atendida(crewId))) { toast(`${nombre(crewId)} va en una vuelta que ya arrancó: no se puede sacar.`); return null; }
    if (from && (rt.order[fromId] || []).length === 1) { toast(`${nombre(crewId)} ya va sola en esa vuelta.`); return null; }
    const r0 = from ? ruta(from) : null;
    const st = r0 ? r0.stops.find((s) => s.crewId === crewId) : null;
    snapshot('sola');
    if (from) rt.order[fromId] = (rt.order[fromId] || []).filter((x) => x !== crewId);
    rt.pool = rt.pool.filter((x) => x !== crewId);
    rt.horasPub = rt.horasPub || {};
    const n = { type: a.type === 'lle' ? 'lle' : 'sal', ids: [crewId] };
    if (n.type === 'lle') {
      n.landing = horaVuelta([crewId]);
      n.start = rtInicioLle(n.landing + rtDeplaneOf([crewId], n.landing));
    } else if (st && st.time != null) {
      n.start = rtToHM(st.time); n.horas = { [crewId]: st.time };
    } else {
      // Sin hora todavía (estaba sin carro): la del modelo, como si saliera de su casa.
      const pres = rtToMin(a.dl);
      const t = pres - (rt.AIRPORT_BUFFER || 10) - rtLegMin(crewId, 'airport') - (rt.SERVICE_MIN || 4);
      n.start = rtToHM(Math.max(0, rtRedondea5(t - 2)));
    }
    const lane = ubicarVuelta(n, []);
    if (!n.horas) reprogramar(lane);
    if (from) {
      if (!(rt.order[fromId] || []).length) { rt.lanes = rt.lanes.filter((l) => l.id !== fromId); delete rt.order[fromId]; delete rt.horasPub[fromId]; renumerarCarro(from.car); }
      else { encadenar(from.car); reprogramar(from); }
    }
    ui.moving = null; ui.sel = lane.id;
    const r = ruta(lane);
    commit(`${nombre(crewId)} pasó a una vuelta sola en ${lane.car} (${r ? hhmm(r.pickup) : lane.start}) · el conductor se cambia con «Cambiar»`);
    verRuta(lane.id);   // queda abierta: ahí está «Cambiar» para el conductor
    return lane;
  }

  // PEGAR = LLENAR EL TABLERO (27-oct-2026). La profa: «lo único que debería
  // cambiar es cuando alguien suba». La ruta que pega el jefe (admin-ruta-julian.js)
  // era otra clase de vuelta: otra tarjeta, sin trayecto, sin mapa, otra forma de
  // publicar y de avisar. Ahora cada bloque del WhatsApp entra como una vuelta del
  // tablero, igual que si la hubiera armado el optimizador. Lo único suyo son LAS
  // HORAS: las del jefe, con la regla de lo publicado (rt.horasPub: mientras nadie
  // toque la vuelta se ve y se publica esa hora; si se toca, vuelve al modelo).
  //   Carro: el primero que esté libre a esa hora; si ninguno, uno más (sus planes
  //   piden un tercero en el pico). Conductor: el del turno de ese carro
  //   (autoLlenar). Se publica con «Publicar», como siempre.
  //   vueltas: [{ type: 'sal'|'lle', deadline: min|null,
  //               stops: [{ rid, min } | { guest: { name, place, residence_id, lat, lng, zona, vuelo }, min }] }]
  //   min = minutos del día del tablero (su madrugada va de 0 al corte).
  // Quien va en una vuelta que ya arrancó se queda donde va (enCurso).
  //
  // REARMAR EL DÍA (27-oct-2026, 2ª). La profa: «al pegar la actualización… debería
  // armar de nuevo el tablero con la actualización y no dejar duplicidad». Antes
  // solo se movía a la gente del texto: quien ya no estaba (o el sin cuenta escrito
  // distinto) se quedaba en su vuelta vieja y el día salía repetido. Con
  // opts.rearmar el texto MANDA: toda vuelta que no ha arrancado se rehace con él;
  // quien pidió por la app y no está en el texto queda sin carro (en Avisos) y el sin
  // cuenta que ya no está, sale. La vuelta que sigue IGUAL (misma gente, mismo
  // sentido) se queda con su carro, su conductor y su delegado: solo toma las horas
  // del texto, y si no cambiaron, al publicar no le llega nada a nadie.
  //   opts.rearmar: true = el texto es el día entero · false = solo esas vueltas.
  //   opts.nuevos: { aux, colors } de una lectura fresca de los pedidos: quien pidió
  //   después de abrir el día también se puede pegar.
  function meterPegado(vueltas, opts = {}) {
    if (!Array.isArray(vueltas) || !vueltas.length || !rt.cars || !rt.aux) return null;
    snapshot('pegar');
    rt.lanes = rt.lanes || []; rt.order = rt.order || {}; rt.pool = rt.pool || []; rt.horasPub = rt.horasPub || {};
    const porReserva = {};
    Object.keys(rt.aux).forEach((k) => { const r = rt.aux[k].reservationId; if (r) porReserva[r] = k; });
    const frescos = (opts.nuevos && opts.nuevos.aux) || {};
    const enPegadas = new Set(Object.values(rt.rv2AuxPegadas || {}).map((a) => a && a.reservationId).filter(Boolean));
    const nuevosPedidos = [];
    const traerPedido = (rid) => {
      const k0 = Object.keys(frescos).find((k) => frescos[k] && frescos[k].reservationId === rid);
      if (!k0 || enPegadas.has(rid)) return null;
      let k = k0; while (rt.aux[k]) k += 'n';
      rt.aux[k] = clone(frescos[k0]);
      if (rt.colors && !rt.colors[k]) rt.colors[k] = (opts.nuevos.colors && opts.nuevos.colors[k0]) || '#8895a7';
      porReserva[rid] = k; nuevosPedidos.push(k);
      return k;
    };
    const laneDe = (k) => rt.lanes.find((l) => (rt.order[l.id] || []).includes(k)) || null;
    // Quieta (como en Re-optimizar, vueltasQuietas): arrancó, terminó o ya pasó sin
    // que el conductor la marcara. Su gente se queda ahí aunque venga en el texto.
    const quieta = (l) => !!(l && (fijaDe(l.id) || esSinMarcar(l)));
    const enCurso = [], nuevas = [];
    let sinCuenta = 0, gN = 0;
    // El sin cuenta que ya iba en el tablero es el mismo: se mueve. También si Julián
    // lo escribió un poco distinto («Lesli» / «Leslie»), si es del mismo sentido y a
    // una hora parecida: así no queda dos veces.
    const yaUsados = new Set();
    const llaveSinCuenta = (g, type, min) => {
      const n = norm(g.name).trim(), n1 = n.split(/\s+/)[0] || '';
      const libres = Object.keys(rt.aux).filter((k) => rt.aux[k].guest && rt.aux[k].type === type && !yaUsados.has(k));
      const dif = (k) => Math.abs(rtToMin(rt.aux[k].dl) - min);
      const cerca = (k) => { const m1 = norm(rt.aux[k].n).trim().split(/\s+/)[0] || ''; return n1.length >= 3 && m1.length >= 3 && (m1.startsWith(n1) || n1.startsWith(m1)) && dif(k) <= 120; };
      const ya = libres.filter((k) => norm(rt.aux[k].n).trim() === n).sort((a, b) => dif(a) - dif(b))[0]
        || libres.filter(cerca).sort((a, b) => dif(a) - dif(b))[0];
      let k = ya;
      if (!k) do { k = 'gp' + (++gN); } while (rt.aux[k]);
      yaUsados.add(k);
      return k;
    };
    vueltas.forEach((v) => {
      const type = v.type === 'lle' ? 'lle' : 'sal';
      const ids = [], horas = {};
      (v.stops || []).forEach((s) => {
        if (s.min == null || !isFinite(s.min)) return;
        let k = null;
        if (s.rid) k = porReserva[s.rid] || traerPedido(s.rid);
        else if (s.guest && s.guest.name) {
          k = llaveSinCuenta(s.guest, type, s.min);
          const de = laneDe(k);
          if (!(de && (quieta(de) || atendida(k)))) {
            const stopId = rt.aux[k] && rt.aux[k].guest ? rt.aux[k].guest.stopId : null;
            rt.aux[k] = auxSinCuenta(Object.assign({}, s.guest, { stopId }), type,
              type === 'lle' ? s.min : (v.deadline != null ? v.deadline : s.min + 60));
            if (rt.colors && !rt.colors[k]) rt.colors[k] = '#8895a7';
            sinCuenta++;
          }
        }
        if (!k || ids.includes(k) || nuevas.some((x) => x.ids.includes(k))) return;
        const de = laneDe(k);
        if (de && (quieta(de) || atendida(k))) { enCurso.push(nombre(k)); return; }
        ids.push(k); horas[k] = s.min;
      });
      if (ids.length) nuevas.push({ type, ids, horas });
    });
    if (!nuevas.length) { const h = hist.pop(); if (h) restaurar(h.f); return { vueltas: 0, iguales: 0, carros: [], nuevosCarros: [], enCurso, sinCuenta: 0, sinCarro: [], nuevosPedidos: 0 }; }
    // Las horas del jefe. Salida: la primera recogida (y cada recogida la suya).
    // Llegada: sale de JMC cuando ya salió el último (su hora + desembarque), la
    // misma cuenta del tablero (reprogramar), y reparte en el orden del tablero.
    nuevas.forEach((n) => {
      if (n.type === 'lle') {
        n.ids = rtBestOrder(n.ids, 'airport', false);
        n.landing = Math.max(...n.ids.map((k) => n.horas[k]));
        n.t = n.landing + rtDeplaneOf(n.ids, n.landing);
        n.start = rtInicioLle(n.t);
      } else {
        n.t = Math.min(...n.ids.map((k) => n.horas[k]));
        n.start = rtToHM(n.t);
      }
    });
    // La vuelta que sigue igual (misma gente y sentido, sin arrancar) se queda.
    const pegados = new Set(nuevas.flatMap((n) => n.ids));
    const misma = (l, n) => { const a = rt.order[l.id] || []; return l.type === n.type && a.length === n.ids.length && n.ids.every((k) => a.includes(k)); };
    nuevas.forEach((n) => { n.lane = rt.lanes.find((l) => !quieta(l) && !nuevas.some((m) => m.lane === l) && misma(l, n)) || null; });
    // Lo que sale de las demás vueltas sin arrancar: con rearmar, todos; si no, solo
    // los del texto. Quien no está en el texto queda sin carro; el sin cuenta, sale.
    // La delegada (o la «para tomar» que alguien ya tomó) la puso Coordinación en el
    // tablero: solo se toca si su gente viene en el texto.
    const tocadas = new Set(), sinCarro = [];
    rt.lanes.slice().forEach((l) => {
      if (quieta(l) || nuevas.some((n) => n.lane === l)) return;
      const ids = rt.order[l.id] || [];
      const aparte = l.deleg === true || (l.tomar === true && !!l.drv);
      const salen = ids.filter((k) => (opts.rearmar && !aparte ? !atendida(k) : pegados.has(k)));
      if (!salen.length) return;
      rt.order[l.id] = ids.filter((k) => !salen.includes(k));
      salen.forEach((k) => {
        if (pegados.has(k)) return;
        if (rt.aux[k] && rt.aux[k].guest) { delete rt.aux[k]; return; }
        if (!rt.pool.includes(k)) rt.pool.push(k);
        sinCarro.push(nombre(k));
      });
      tocadas.add(l.id);
    });
    rt.pool = rt.pool.filter((k) => !pegados.has(k) && rt.aux[k]);
    // La vuelta del tablero que se quedó sin nadie sobra.
    [...tocadas].forEach((id) => {
      if ((rt.order[id] || []).length || quieta(rtLaneOf(id))) return;
      rt.lanes = rt.lanes.filter((l) => l.id !== id);
      delete rt.order[id]; delete rt.horasPub[id]; tocadas.delete(id);
    });
    // Las que siguen iguales toman el orden y las horas del texto. Si con la hora
    // nueva ya no le cabe a su carro, se ubica como una nueva.
    nuevas.filter((n) => n.lane).forEach((n) => {
      const l = n.lane;
      rt.order[l.id] = n.ids.slice();
      l.start = n.start; if (n.type === 'lle') l.landing = rtToHM(n.landing);
      rt.horasPub[l.id] = { start: l.start, sig: n.ids.join(','), etas: n.type === 'lle' ? {} : Object.assign({}, n.horas) };
    });
    [...new Set(nuevas.filter((n) => n.lane).map((n) => n.lane.car))].forEach(renumerarCarro);
    nuevas.filter((n) => n.lane).sort((a, b) => a.t - b.t).forEach((n) => {
      if (cabeEnCarro(n.lane)) return;
      const l = n.lane;
      rt.lanes = rt.lanes.filter((x) => x !== l); delete rt.order[l.id]; delete rt.horasPub[l.id];
      renumerarCarro(l.car); n.lane = null;
    });
    const nuevosCarros = [], carros = new Set();
    nuevas.filter((n) => n.lane).forEach((n) => carros.add(n.lane.car));
    const iguales = nuevas.filter((n) => n.lane).length;
    nuevas.filter((n) => !n.lane).sort((a, b) => a.t - b.t).forEach((n) => { carros.add(ubicarVuelta(n, nuevosCarros).car); });
    // Las del tablero que perdieron gente se reprograman, como al mover a alguien.
    tocadas.forEach((id) => { const l = rtLaneOf(id); if (l) reprogramar(l); });
    // Un día que iba solo con la ruta pegada (0125) ya tiene tablero.
    if (ui.manual && !ui.manual.mixto) { ui.manual.mixto = true; rt.manualDia = false; }
    rt.optimized = true;
    ui.sel = null; ui.moving = null;
    render();
    return { vueltas: nuevas.length, iguales, carros: [...carros], nuevosCarros, enCurso, sinCuenta, sinCarro, nuevosPedidos: nuevosPedidos.length };
  }
  // Para la hoja de la ruta de Julián: quién del día sigue por mover (sin carro o en
  // una vuelta que no ha arrancado). Si el texto trae a la mayoría, es el día entero.
  function pendientesDelTablero() {
    return Object.keys(rt.aux || {}).filter((k) => {
      const a = rt.aux[k]; if (!a || !a.reservationId || atendida(k)) return false;
      const l = (rt.lanes || []).find((x) => (rt.order[x.id] || []).includes(k));
      return !(l && (fijaDe(l.id) || esSinMarcar(l)));
    }).map((k) => rt.aux[k].reservationId);
  }
  // La vuelta que ya pasó y el conductor no marcó (finFila, la de Re-optimizar).
  const esSinMarcar = (l) => !!(l && D && D.byId && D.byId[l.id] && finFila(D.byId[l.id]) === 'sinmarcar');
  // La madrugada del día siguiente que el jefe pega con este día (después de la
  // noche) es del plan de ESE día: queda aquí y entra sola cuando se abre ese día.
  const pegadoPendiente = {};
  function guardarPegado(dia, vueltas) {
    if (!dia || !Array.isArray(vueltas) || !vueltas.length) return;
    pegadoPendiente[dia] = (pegadoPendiente[dia] || []).concat(vueltas);
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

  // Día mezclado (26-oct-2026): un conductor que tomó una vuelta de la ruta de Julián
  // también está ocupado a esa hora. El tablero no la veía (no es suya) y le podía
  // cruzar otra sin avisar. Aquí se mide cada par en que al menos una es pegada; los
  // pares del tablero solo los sigue midiendo choquesDeConductor.
  const legC = (a, b, aero) => (typeof rtHaversineMin === 'function' ? rtHaversineMin(a, b) : 8) * (rt.TRAFFIC_FACTOR || 1) * (aero ? (rt.AIRPORT_FACTOR || 1) : 1);
  const AERO = () => (typeof RT_AIRPORT !== 'undefined' ? RT_AIRPORT : null);
  function tramoTablero(r) {
    const i = inicioDe(r), f = finDe(r);
    const c = (k) => (typeof rtCoordsOf === 'function' ? rtCoordsOf(k) : null);
    return { r, driverId: r.driverId, ini: i.at, iniLoc: c(i.loc), fin: f.at, finLoc: c(f.loc), colchon: f.colchon, fija: !!r.fija };
  }
  function tramosPegados() {
    const xy = (g) => (g && g.lat != null ? { lat: g.lat, lng: g.lng } : null);
    return pegadasLista(false).filter((p) => p.v.driverProfileId && !p.v.delegated && p.fija !== 'completed').map((p) => {
      const g = [...(p.v.atendidas || []), ...(p.v.pendientes || [])].sort((a, b) => a.order - b.order);
      const fija = p.v.status === 'in_progress' || (p.v.atendidas || []).length > 0;
      if (p.type === 'llegada') {
        // Sale de JMC y reparte: lo que tarda, con el tiempo de respaldo (no hay ruta del tablero).
        let t = p.pickup, at = AERO();
        g.forEach((x, i) => { const c = xy(x); t += legC(at, c, i === 0) + 2; at = c || at; });
        return { julian: p, driverId: p.v.driverProfileId, ini: p.pickup, iniLoc: AERO(), fin: Math.round(t), finLoc: at, colchon: 2, fija };
      }
      return { julian: p, driverId: p.v.driverProfileId, ini: p.pickup, iniLoc: xy(g[0]), fin: p.arrival, finLoc: AERO(), colchon: rt.TURNAROUND || 8, fija };
    });
  }
  function choquesConPegadas() {
    const peg = tramosPegados();
    if (!peg.length) return [];
    const por = {}, out = [];
    peg.forEach((x) => (por[x.driverId] = por[x.driverId] || []).push(x));
    D.routes.forEach((r) => { if (r.driverId && por[r.driverId]) por[r.driverId].push(tramoTablero(r)); });
    Object.keys(por).forEach((id) => {
      const xs = por[id].sort((a, b) => a.ini - b.ini);
      for (let i = 1; i < xs.length; i++) {
        const a = xs[i - 1], b = xs[i];
        if ((!a.julian && !b.julian) || (a.fija && b.fija)) continue;
        const cruza = b.ini < a.fin;
        const llega = Math.round(a.fin + a.colchon + legC(a.finLoc, b.iniLoc, a.finLoc === AERO() || b.iniLoc === AERO()));
        if (cruza || llega - b.ini > TOL_CHOQUE) out.push({ id, a, b, cruza, llega, tarde: llega - b.ini });
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
  // 28-oct: «Carro Apoyo» en Conductores = todos los carros de apoyo de ese turno.
  // El conductor va a todos; si manejaba Carro 1 o 2, se intercambia como arriba.
  function asignarApoyo(grupo, shift, driverId) {
    if (!grupo.length) return;
    const otro = (rt.cars || []).find((c) => !grupo.includes(c) && rtCarDrv(c, shift) === driverId) || null;
    snapshot('conductor');
    const mio = grupo.map((c) => rtCarDrv(c, shift)).find(Boolean) || null;
    if (otro) rtSetCarDrv(otro, shift, mio);
    grupo.forEach((c) => rtSetCarDrv(c, shift, driverId));
    commit(`${conductor(driverId).name} ${otro ? 'pasa' : 'asignado'} a ${APOYO_TXT}${otro && mio ? ` y ${conductor(mio).name} a ${otro.id}` : ''} · turno ${rtBandName(shift)}`);
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

  // 27-oct-2026 (Camilo): «cuando doy optimizar en sistema, el me toma la
  // programación completa de todo el día, incluyendo servicios que ya se
  // finalizaron. Debería optimizarse solo todo lo del día que está pendiente por
  // hacer». Se quedan QUIETAS, con su carro, sus horas, su conductor y su resultado,
  // las vueltas terminadas, en curso, las que pasaron su hora sin marcar y las
  // delegadas. El optimizador arma lo demás con cada carro libre DESPUÉS de lo que
  // ya hizo o está haciendo.
  function vueltasQuietas() {
    return (rt.lanes || []).filter((l) => (rt.order[l.id] || []).length
      && (fijaDe(l.id) || l.deleg === true || !!(D && D.byId[l.id] && finFila(D.byId[l.id]) === 'sinmarcar')));
  }
  async function reoptimizar() {
    if (soloJulian()) { toast('Este día va con la ruta de Julián: quítala para volver al tablero.'); return; }
    if (rt.source !== 'live' || ui.cargando || ui.optimizando || typeof rtOptimize !== 'function') return;
    const quietas = vueltasQuietas();
    const guardadas = quietas.map((l) => ({ lane: l, order: rt.order[l.id].slice(), horas: rt.horasPub && rt.horasPub[l.id], fija: fijaDe(l.id), fin: resultadoDe(l.id) }));
    const fuera = new Set(guardadas.flatMap((g) => g.order));
    const solo = new Set(Object.keys(rt.aux || {}).filter((id) => !fuera.has(id)));
    if (quietas.length && !solo.size) { toast('No hay nada pendiente para optimizar: todo está terminado, en curso o delegado.'); return; }
    // Desde cuándo está libre cada carro: al terminar su última vuelta quieta.
    const libre = {};
    guardadas.forEach((g) => {
      if (g.lane.deleg === true) return;   // la hace alguien de afuera: no ocupa el carro
      const c = rtCarCompute(g.lane.id);
      if (!c || c.arrival == null) return;
      const fin = g.lane.type === 'lle' ? c.arrival + 2 : c.arrival + rt.TURNAROUND;
      libre[g.lane.car] = Math.max(libre[g.lane.car] || 0, fin);
    });
    snapshot('reoptimizar');
    ui.optimizando = true; renderBar();
    let msg = '';
    try {
      await rtOptimize(Object.assign({ toast: (m) => { msg = m; } }, quietas.length ? { solo, libre } : {}));
      volverAPoner(guardadas);
      toast(msg + (quietas.length ? ` · ${plural(quietas.length, 'vuelta', 'vueltas')} ya ${quietas.length === 1 ? 'hecha, en curso o delegada se quedó' : 'hechas, en curso o delegadas se quedaron'} como ${quietas.length === 1 ? 'estaba' : 'estaban'}` : ''), true);
    } catch (e) {
      hist.pop();
      toast('No se pudo optimizar: ' + ((e && e.message) || 'error'));
    } finally { ui.optimizando = false; }
    ui.sel = null; ui.moving = null; render(); autoSelect();
  }
  // ── 28-oct · «Enrutar»: solo los conductores ─────────────────────────────────
  // Camilo (7:49 a. m.): «otro botón en asignación que sea de enrutar, que uno le dé
  // click y re optimice solo la asignación de conductor sin cambiar nada del
  // tablero». Las vueltas, su gente, sus horas y su carro quedan iguales: solo se
  // decide QUIÉN hace cada vuelta que todavía no arranca (lane.drv, «conductor de
  // esta vuelta»), con la misma cuenta de «alcanza / no alcanza» de la hoja del
  // conductor (enlace: fin + 8 min en JMC o 2 en una casa + el tramo).
  // Quietas, con su conductor: terminadas, en curso, pasadas sin marcar, delegadas,
  // para tomar y las que ya debían haber arrancado (hora pasada).
  // Cómo reparte, en orden de hora: si el que la tiene llega a tiempo, se queda con
  // ella (cada cambio es un aviso al tripulante y a dos conductores: solo se cambia
  // lo que no cuadra). Si no llega, o la vuelta no tiene conductor, el del turno que
  // llega a tiempo y queda MENOS rato esperando (así los demás quedan libres para lo
  // que sigue). Si nadie alcanza, el que llega menos tarde, y se dice cuál.
  function ahoraEnDia() {
    if (!rt.day) return -Infinity;
    return Math.round((Date.now() - Date.parse(rt.day + 'T00:00:00-05:00')) / 60000);
  }
  function planEnrutar() {
    const dia = armarDia();
    const yaDebia = ahoraEnDia() + 5;
    const movible = (r) => r.stops.length && !r.fija && !r.delegada && !r.tomar && finFila(r) !== 'sinmarcar' && inicioDe(r).at > yaDebia;
    const movibles = dia.routes.filter(movible).sort((a, b) => inicioDe(a).at - inicioDe(b).at || a.id.localeCompare(b.id));
    const agenda = {};   // conductor → sus vueltas (las quietas primero; se van sumando las que se le dan)
    const poner = (id, r) => { (agenda[id] = agenda[id] || []).push(r); };
    dia.routes.filter((r) => !movible(r) && r.driverId && !r.delegada).forEach((r) => poner(r.driverId, r));
    const cambios = [], tarde = [], sinTurno = [];
    movibles.forEach((r) => {
      const pool = poolTurno(r.shift).map((d) => d.id);
      if (!pool.length) { if (r.driverId) poner(r.driverId, r); sinTurno.push(r); return; }
      const ini = inicioDe(r).at, fin = finDe(r).at;
      const opciones = pool.map((id) => {
        const suyas = (agenda[id] || []).slice().sort((x, y) => inicioDe(x).at - inicioDe(y).at);
        if (suyas.some((x) => inicioDe(x).at < fin && ini < finDe(x).at)) return { id, peor: Infinity, espera: Infinity };
        const antes = suyas.filter((x) => inicioDe(x).at <= ini).pop() || null;
        const despues = suyas.find((x) => inicioDe(x).at > ini) || null;
        const a = antes ? enlace(antes, r) : null, d = despues ? enlace(r, despues) : null;
        const peor = Math.max(a ? a.tarde : -Infinity, d ? d.tarde : -Infinity);
        return { id, peor, espera: a ? Math.max(0, ini - a.llega) : 24 * 60 };
      });
      const llegan = opciones.filter((o) => o.peor <= TOL_CHOQUE).sort((x, y) => x.espera - y.espera);
      let elegido;
      if (llegan.length) {
        elegido = llegan.find((o) => o.id === r.driverId) || llegan[0];
      } else {
        const menos = opciones.filter((o) => o.peor < Infinity).sort((x, y) => x.peor - y.peor)[0];
        const actual = opciones.find((o) => o.id === r.driverId && o.peor < Infinity);
        elegido = actual && menos && actual.peor <= menos.peor ? actual : (menos || null);
        if (elegido) tarde.push({ r, id: elegido.id, min: Math.round(elegido.peor) });
        else { if (r.driverId) poner(r.driverId, r); tarde.push({ r, id: r.driverId, min: null }); return; }
      }
      poner(elegido.id, r);
      if (elegido.id !== r.driverId) cambios.push({ r, de: r.driverId, a: elegido.id });
    });
    return { movibles, cambios, tarde, sinTurno };
  }
  function enrutar() {
    if (soloJulian()) { toast('Este día va con la ruta de Julián: quítala para volver al tablero.'); return; }
    if (rt.source !== 'live' || ui.cargando || ui.optimizando) return;
    if (!hayVueltas()) { toast('Todavía no hay vueltas: arma el día (Ruta de Julián u Optimizar) y luego enruta.'); return; }
    const p = planEnrutar();
    if (!p.movibles.length) { toast('No hay vueltas por enrutar: todo está terminado, en curso, delegado o para tomar.'); return; }
    const malas = p.tarde.map((x) => `${x.r.vehicle} ${hhmm(inicioDe(x.r).at)}${x.id ? ` (${conductor(x.id).name.split(' ')[0]}${x.min != null ? `, ${x.min} min tarde` : ''})` : ' (nadie del turno puede)'}`);
    if (!p.cambios.length) {
      toast(`Ya estaba bien enrutado: ${plural(p.movibles.length, 'vuelta', 'vueltas')} por hacer, nadie cambia de conductor${malas.length ? ` · ojo, nadie llega a tiempo a: ${malas.join(', ')} (delégala o córrele la hora)` : ''}.`, true);
      return;
    }
    snapshot('enrutar');
    p.cambios.forEach(({ r, a }) => {
      const lane = rtLaneOf(r.id); if (!lane) return;
      const car = rt.cars.find((c) => c.id === lane.car);
      const delCarro = car ? rtCarDrv(car, rtBandOf(lane)) : null;
      if (a === delCarro) delete lane.drv; else lane.drv = a;
    });
    const porQuien = {};
    p.cambios.forEach(({ a }) => { const n = conductor(a).name.split(' ')[0]; porQuien[n] = (porQuien[n] || 0) + 1; });
    commit(`Enrutado: ${plural(p.cambios.length, 'vuelta cambia', 'vueltas cambian')} de conductor (${Object.entries(porQuien).map(([n, k]) => `${k} a ${n}`).join(', ')}). Las horas, la gente y los carros no cambiaron`
      + (malas.length ? ` · nadie llega a tiempo a: ${malas.join(', ')} (delégala o córrele la hora)` : '')
      + (p.sinTurno.length ? ` · ${plural(p.sinTurno.length, 'vuelta', 'vueltas')} sin conductores en el horario: quedan como estaban` : '')
      + '. Revisa y dale Publicar');
  }

  // Después de optimizar lo pendiente: las vueltas quietas vuelven tal cual. Las
  // nuevas no pueden llamarse como una quieta (el optimizador numera desde V1), y
  // cada carro se numera otra vez en orden de hora.
  function volverAPoner(guardadas) {
    rt.rv2Fijas = {}; rt.rv2Fin = {};
    if (!guardadas.length) return;
    rt.horasPub = rt.horasPub || {};
    const reservadas = new Set(guardadas.map((g) => g.lane.id));
    rt.lanes.forEach((l) => {
      if (!reservadas.has(l.id)) return;
      const usadas = new Set(rt.lanes.map((x) => x.id).concat(Object.keys(rt.order)));
      let i = 1, id; do { id = `${l.car}·V${i++}`; } while (usadas.has(id) || reservadas.has(id));
      rt.order[id] = rt.order[l.id]; delete rt.order[l.id]; l.id = id;
    });
    guardadas.forEach((g) => {
      rt.lanes.push(g.lane); rt.order[g.lane.id] = g.order;
      if (g.horas) rt.horasPub[g.lane.id] = g.horas;
      if (g.fija) rt.rv2Fijas[g.lane.id] = g.fija;
      if (g.fin) rt.rv2Fin[g.lane.id] = g.fin;
    });
    [...new Set(rt.lanes.map((l) => l.car))].forEach((car) => {
      rt.lanes.filter((l) => l.car === car && (rt.order[l.id] || []).length)
        .sort((a, b) => rtToMin(a.start) - rtToMin(b.start) || a.vuelta - b.vuelta)
        .forEach((l, i) => { l.vuelta = i + 1; });
      encadenar(car);
    });
  }

  async function publicar() {
    if (ui.publicando || typeof rtSavePlan !== 'function') return;
    ui.publicando = true; renderSay(avisosDe());
    let res = null;
    // 0154: si el sistema corrió una vuelta en el último minuto, se publica con eso.
    let previas = [];
    try { previas = await sincronizarAntesDePublicar(); } catch (_) { previas = []; }
    const aviso = avisoSincronia(previas);
    try { res = await rtSavePlan({ toast: (m) => toast(aviso ? `${m} ${aviso}` : m) }); }
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
      `<label class="rv2-search" style="width:100%;height:44px">${IC.search}<input id="rv2-optq" type="search" placeholder="Buscar otra vuelta o carro" autocomplete="off" aria-label="Buscar otra vuelta o carro"></label>` +
      `<button class="rv2-opt rv2-opt--sola" data-act="sola" data-crew="${esc(crewId)}"><span class="t"><b>En una vuelta sola</b></span><small>Una vuelta nueva solo con ${esc(String(a.n || '').split(' ')[0] || 'ella')}, en un carro libre a esa hora. Después le pones el conductor.</small></button></div>` +
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
    // 0131: luego se elige A QUIÉN (libreta o a mano) y el tripulante ve «Te recogerá X».
    extra.push(`<button class="rv2-opt rv2-opt--deleg" role="radio" aria-checked="false" data-pick="__deleg"><span class="t"><b>${r.delegada ? 'Cambiar a quién se delegó' : 'Delegar esta vuelta'}</b></span><small>${r.delegada
      ? (r.delegName ? `Hoy la hace ${esc(r.delegName)}${r.delegPhone ? ' · ' + esc(r.delegPhone) : ''}.` : 'Hoy está delegada sin nombre: al tripulante le dice que lo contactan por WhatsApp.') + ' Elige a otra persona o escribe una nueva.'
      : 'La hace alguien de afuera (tu carro, un Uber). Ningún conductor la ve. Después eliges a quién (de la libreta o a mano) y al tripulante le llega «Te recogerá… su número de contacto es…».'}</small></button>`);
    // 0151 (Camilo, 27-oct): «que los servicios de llegada queden sin conductor, en una
    // lista que verán los conductores… y ellos mismos se lo asignan». Coordinación elige cuáles.
    extra.push(`<button class="rv2-opt" role="radio" aria-checked="false" data-pick="__tomar"><span class="t"><b>${r.tomar ? 'Sigue para tomar' : 'Dejarla para tomar'}</b></span><small>${r.tomar && r.driverId
      ? `Hoy la tiene ${esc(conductor(r.driverId).name)}, que la tomó. Elige esta opción para que siga en la lista.`
      : 'Sale sin conductor y la ven los conductores del turno en «Vueltas para tomar». Si a uno se le cruza, la toma igual y te avisamos. Si nadie la toma, te avisamos 60 min antes.'}</small></button>`);
    if (cur) extra.push(`<button class="rv2-opt rv2-opt--drop" role="radio" aria-checked="false" data-pick="__none"><span class="t"><b>Quitar el conductor de esta vuelta</b></span><small>Queda sin conductor y nadie la ve hasta que le pongas uno.</small></button>`);
    let sel = null;
    // 0129: una vuelta ya publicada que no ha arrancado se puede publicar sola.
    const lane = rtLaneOf(r.id);
    const sePublica = (p) => !!(lane && lane.raId && !r.fija && rt.source === 'live' && window.Api && Api.setVueltaDriver
      && p !== '__tomar'   // 0151: para tomar va con «Publicar» (crea su fila de la lista)
      && !(p === '__deleg' && lane.raStatus !== 'planned'));
    const conPub = sePublica(null);
    openSheet(sheetHead('Conductor de esta vuelta', `${esc(r.vehicle)} · ${esc(TYPE[r.type])} de las ${hhmm(inicioDe(r).at)}${r.delegada ? ' · hoy está delegada' : ''} · solo cambia esta vuelta: las demás y sus horas quedan igual`) +
      `<div class="rv2-sh-body"><h3 class="rv2-cap">${esc(nota)}</h3><div id="rv2-dopts" role="radiogroup" aria-label="Conductor de esta vuelta" style="display:flex;flex-direction:column;gap:8px">` +
      (pool.length ? pool.map((d) => opt(d, false)).join('') : `<p class="rv2-impact">Nadie en turno ${esc(turno)} ese día en el horario publicado. Puedes elegir otro conductor abajo.</p>`) +
      (cargado && otros.length ? `<h3 class="rv2-cap" style="margin-top:6px">Otros conductores</h3>` + otros.map((d) => opt(d, true)).join('') : '') +
      (extra.length ? `<h3 class="rv2-cap" style="margin-top:6px">O bien</h3>` + extra.join('') : '') +
      `</div><button class="rv2-linkbtn rv2-linkbtn--ink" data-act="assignslot" data-car="${esc(r.vehicle)}" data-shift="${esc(r.shift)}">Cambiar el conductor de todas las vueltas de ${esc(r.vehicle)} en el turno ${esc(turno)}</button>` +
      (conPub ? `<p class="rv2-impact rv2-pubone">«Guardar y publicar» cambia solo esta vuelta en la app y avisa al conductor nuevo, al que la tenía y a sus tripulantes. El resto del día no se toca.</p>` : '') +
      `</div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button>` +
      (conPub
        ? `<button class="rv2-btn" id="rv2-doAssign" disabled>Solo en el tablero</button><button class="rv2-btn rv2-btn--cta" id="rv2-doPub" disabled>Elige un conductor</button>`
        : `<button class="rv2-btn rv2-btn--cta" id="rv2-doAssign" disabled>Elige un conductor</button>`) + `</div>`);
    setLabel();
    const btn = $('#rv2-doAssign'), pub = $('#rv2-doPub');
    $('#rv2-dopts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; sel = b.dataset.pick;
      $$('#rv2-dopts [data-pick]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.pick === sel)));
      btn.disabled = !sel;
      if (pub) {
        pub.disabled = !sel || !sePublica(sel);
        pub.textContent = !sel ? 'Elige un conductor' : sePublica(sel) ? 'Guardar y publicar' : sel === '__tomar' ? 'Para tomar: publica el plan' : 'Delegar: publica el plan';
      } else btn.textContent = sel === '__none' ? 'Quitar de esta vuelta' : sel === '__deleg' ? 'Delegar esta vuelta' : sel === '__tomar' ? 'Dejarla para tomar' : 'Asignar a esta vuelta';
    });
    // 0131: «Delegar» sigue en la hoja «Delegar a…» (a quién), en el tablero o publicando.
    btn.addEventListener('click', () => { if (!sel) return; const s = sel; closeSheet(); if (s === '__deleg') return delegarVuelta(r.id, false); setVueltaDriver(r.id, s); });
    if (pub) pub.addEventListener('click', () => { if (!sel || !sePublica(sel)) return; const s = sel; closeSheet(); if (s === '__deleg') return delegarVuelta(r.id, true); publicarVuelta(r.id, s); });
  }

  // ── 0131 · «Delegar a…»: a quién (de la libreta o a mano) ───────────────────
  // Lista de los jefes (26-oct): «si se va a delegar se pueda seleccionar DELEGAR,
  // y aparezca una opción de seleccionar el conductor inscrito o de manera manual
  // colocar nombre y teléfono, y que al tripulante le aparezca: Te recogerá tal
  // conductor, su número de contacto es…». La libreta la guarda la base (0131).
  // opts: { titulo, sub, actual: {name, phone}, publicar: (name, phone) => promesa | null, tablero: (name, phone) => void | null }
  // 27-oct (Camilo): «debería haber una opción para uno registrar los conductores de
  // confianza que uno ponga en una lista y eso se verá al momento de dar en
  // delegar. Si es un conductor que no está en la lista, uno llena los datos
  // manual, pero que el sistema no guarde eso». La libreta es «Conductores de
  // confianza»: se le agrega a alguien marcando la casilla, y se le quita con
  // «Quitar». Escrito a mano sin la casilla, NO queda guardado.
  async function openDelegar(opts) {
    let lista = null;
    try { lista = window.Api && Api.listDelegateContacts ? await Api.listDelegateContacts() : null; } catch (_) { lista = null; }
    const act = opts.actual || {};
    const dig = (x) => String(x || '').replace(/\D/g, '');
    const puedeQuitar = !!(window.Api && Api.removeDelegateContact);
    const fila = (c, i) => `<div class="rv2-dlg-row"><button class="rv2-opt" role="radio" aria-checked="false" data-dpick="${i}"><span class="t"><b>${esc(c.name)}</b></span>`
      + (act.phone && dig(act.phone) === dig(c.phone) ? '<span class="st st--ok">Hoy</span>' : '') + `<small>${esc(c.phone)}</small></button>`
      + (puedeQuitar ? `<button class="rv2-btn rv2-btn--sm" data-dquitar="${i}" aria-label="${esc('Quitar a ' + c.name + ' de los conductores de confianza')}">Quitar</button>` : '') + '</div>';
    const hay = !!(lista && lista.length);
    openSheet(sheetHead(opts.titulo, opts.sub || '')
      + '<div class="rv2-sh-body"><div id="rv2-dlg" role="radiogroup" aria-label="A quién se delega" style="display:flex;flex-direction:column;gap:8px">'
      + (hay ? '<h3 class="rv2-cap">Conductores de confianza</h3>' + lista.map(fila).join('') : '')
      + `<h3 class="rv2-cap" style="margin-top:6px">${hay ? 'O alguien que no está en la lista' : 'Quién la hace'}</h3>`
      + `<button class="rv2-opt" role="radio" aria-checked="${hay ? 'false' : 'true'}" data-dpick="nuevo"><span class="t"><b>Escribir nombre y teléfono</b></span><small>Solo para esta vuelta, salvo que marques «Guardarlo en mis conductores de confianza».</small></button>`
      + '<div class="rv2-dlg-form" id="rv2-dlg-form"' + (hay ? ' hidden' : '') + '>'
      + `<label class="rv2-cap" for="rv2-dlg-n">Nombre</label><input id="rv2-dlg-n" class="rv2-inp" type="text" autocomplete="off" maxlength="80" placeholder="Carlos Uber" value="${esc(hay ? '' : (act.name || ''))}">`
      + `<label class="rv2-cap" for="rv2-dlg-p">Teléfono</label><input id="rv2-dlg-p" class="rv2-inp" type="tel" inputmode="tel" autocomplete="off" maxlength="20" placeholder="300 123 4567" value="${esc(hay ? '' : (act.phone || ''))}">`
      + (lista !== null ? '<label class="rv2-dlg-save"><input type="checkbox" id="rv2-dlg-g"> Guardarlo en mis conductores de confianza</label>' : '')
      + '</div>'
      + (lista === null ? '<p class="rv2-impact">La libreta todavía no está en esta base: escribe nombre y teléfono.</p>' : '')
      + '<p class="rv2-impact" id="rv2-dlg-msg" hidden></p></div></div>'
      + '<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button>'
      + `<button class="rv2-btn rv2-btn--cta" id="rv2-dlg-ok" disabled>${opts.publicar ? 'Delegar y avisar' : 'Delegar en el tablero'}</button></div>`);
    setLabel();
    let elegido = lista && lista.length ? null : 'nuevo';
    const okb = $('#rv2-dlg-ok'), form = $('#rv2-dlg-form'), n = $('#rv2-dlg-n'), ph = $('#rv2-dlg-p'), msg = $('#rv2-dlg-msg'), gd = $('#rv2-dlg-g');
    const enLista = new Set((lista || []).map((c) => dig(c.phone)));   // antes de delegar
    const valor = () => {
      if (elegido === 'nuevo') return { name: (n.value || '').trim().replace(/\s+/g, ' '), phone: (ph.value || '').trim() };
      const c = lista && lista[Number(elegido)]; return c ? { name: c.name, phone: c.phone } : { name: '', phone: '' };
    };
    const valido = () => { const v = valor(); return v.name.length >= 2 && dig(v.phone).length >= 7 && dig(v.phone).length <= 15; };
    const sync = () => { okb.disabled = !elegido || !valido(); };
    $('#rv2-dlg').addEventListener('click', async (e) => {
      const qb = e.target.closest('[data-dquitar]');
      if (qb) {
        const c = lista && lista[Number(qb.dataset.dquitar)]; if (!c) return;
        if (typeof window.confirm === 'function' && !window.confirm(`¿Quitar a ${c.name} de los conductores de confianza? Las vueltas que ya tiene no cambian.`)) return;
        qb.disabled = true;
        try { await Api.removeDelegateContact(c.id); const row = qb.closest('.rv2-dlg-row'); if (row) row.remove(); enLista.delete(dig(c.phone)); if (elegido === qb.dataset.dquitar) { elegido = null; sync(); } }
        catch (err) { qb.disabled = false; msg.hidden = false; msg.textContent = 'No se pudo quitar: ' + ((err && err.message) || 'error'); }
        return;
      }
      const b = e.target.closest('[data-dpick]'); if (!b) return;
      elegido = b.dataset.dpick;
      $$('#rv2-dlg [data-dpick]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.dpick === elegido)));
      form.hidden = elegido !== 'nuevo';
      if (elegido === 'nuevo') setTimeout(() => n.focus(), 30);
      sync();
    });
    [n, ph].forEach((x) => x.addEventListener('input', sync));
    sync();
    // Lo escrito a mano: se guarda en la libreta SOLO con la casilla. Delegar ya
    // publicada (0131, admin_route_delegate) lo anota siempre; si no se pidió, se
    // quita después (solo si no estaba antes en la lista).
    const libreta = async (v) => {
      if (elegido !== 'nuevo' || !window.Api) return;
      const guardar = !!(gd && gd.checked);
      try {
        if (guardar && Api.saveDelegateContact) await Api.saveDelegateContact(v.name, v.phone);
        else if (!guardar && opts.publicar && !enLista.has(dig(v.phone)) && Api.listDelegateContacts && Api.removeDelegateContact) {
          const c = ((await Api.listDelegateContacts()) || []).find((x) => dig(x.phone) === dig(v.phone));
          if (c) await Api.removeDelegateContact(c.id);
        }
      } catch (_) { /* la vuelta ya quedó delegada; la libreta es lo de menos */ }
    };
    okb.addEventListener('click', async () => {
      if (!valido()) return;
      const v = valor();
      if (opts.publicar) {
        okb.disabled = true; okb.textContent = 'Delegando…';
        try { await opts.publicar(v.name, v.phone); await libreta(v); closeSheet(); }
        catch (e) { msg.hidden = false; msg.textContent = 'No se pudo delegar: ' + ((e && e.message) || 'error') + '. No cambió nada.'; okb.disabled = false; okb.textContent = 'Delegar y avisar'; }
      } else { await libreta(v); closeSheet(); if (opts.tablero) opts.tablero(v.name, v.phone); }
    });
  }
  // La vuelta del tablero: publicando (vuelta ya publicada) o solo en el tablero.
  function delegarVuelta(laneId, publicando) {
    const lane = rtLaneOf(laneId); const r = D && D.byId[laneId]; if (!lane || !r) return;
    const quienes = r.stops.map((s) => nombre(s.crewId).split(' ')[0]).join(', ');
    openDelegar({
      titulo: 'Delegar a…',
      sub: `${esc(TYPE[r.type])} de las ${hhmm(inicioDe(r).at)}${quienes ? ' · ' + esc(quienes) : ''} · ${publicando ? 'se publica ya y se le avisa a cada tripulante' : 'queda en el tablero: se avisa al publicar'}`,
      actual: lane.deleg ? { name: lane.delegName || '', phone: lane.delegPhone || '' } : null,
      publicar: publicando ? (name, phone) => publicarVuelta(laneId, '__deleg', { name, phone }, true) : null,
      tablero: publicando ? null : (name, phone) => { setVueltaDriver(laneId, '__deleg', false, { name, phone }); },
    });
  }
  // 0129: «Guardar y publicar» desde la hoja de la vuelta. Cambia SOLO esa fila en
  // la base (admin_route_set_driver, o admin_route_set_delegated para delegar) y
  // después el tablero. Si el día estaba publicado sin otros cambios, sigue
  // publicado; si había otros cambios pendientes, esos siguen pendientes.
  let publicandoVuelta = false;
  // quien (0131): {name, phone} al delegar. lanzar: que el error suba (la hoja
  // «Delegar a…» lo muestra y se queda abierta) en vez de quedar en el aviso.
  async function publicarVuelta(laneId, pick, quien, lanzar) {
    const lane = rtLaneOf(laneId); if (!lane || !lane.raId || publicandoVuelta) return;
    const car = rt.cars.find((c) => c.id === lane.car);
    const delCarro = car ? rtCarDrv(car, rtBandOf(lane)) : null;
    const limpio = publicado() && firmaActual() === rt.firmaPublicada;
    publicandoVuelta = true;
    toast('Publicando esta vuelta…');
    try {
      const enviar = () => (pick === '__deleg' && quien && quien.name && Api.delegateRoute) ? Api.delegateRoute(lane.raId, quien.name, quien.phone)
        : pick === '__deleg' ? Api.setRouteDelegated(lane.raId, true)
          : Api.setVueltaDriver(lane.raId, pick === '__none' ? null : pick === '__carro' ? delCarro : pick);
      let resp;
      try { resp = await enviar(); }
      catch (e) {
        // 28-oct (Camilo): «Esa vuelta no existe». Otro jefe (u otro equipo) publicó
        // el día y la vuelta se volvió a crear con otro id: se busca la misma (misma
        // gente, mismo sentido) y se intenta una vez más.
        if (!noExiste(e)) throw e;
        const id = await filaDeLaVuelta(lane);
        if (!id || id === lane.raId) throw new Error('esa vuelta ya no está publicada así: vuelve a publicar el día');
        lane.raId = id;
        resp = await enviar();
      }
      const msg = setVueltaDriver(laneId, pick, true, resp && resp.name ? { name: resp.name, phone: resp.phone } : quien);
      if (resp && resp.status) lane.raStatus = resp.status;
      if (limpio) rt.firmaPublicada = firmaActual();
      // «Deshacer» volvería el tablero a una foto con el conductor anterior y la
      // base ya tiene el nuevo: al re-publicar se desharía a escondidas. Lo
      // publicado se corrige con otro cambio, no con Deshacer.
      hist.length = 0;
      render();
      const n = resp && typeof resp.notified === 'number' ? resp.notified : 0;
      const base = msg.replace(/ · (las demás no cambian|al publicar se le avisa al tripulante)$/, '');
      toast(resp && resp.unchanged ? `Ya estaba así en la app: ${base}.`
        : `Publicado: ${base}${n ? ` · se avisó a ${plural(n, 'tripulante', 'tripulantes')}` : ''}. El resto del día no se tocó.`, true);
    } catch (e) {
      if (lanzar) { publicandoVuelta = false; throw e; }
      toast('No se pudo publicar esta vuelta: ' + ((e && e.message) || 'error') + '. No cambió nada.');
    } finally { publicandoVuelta = false; }
  }
  const noExiste = (e) => !!e && (e.code === 'P0002' || /vuelta no existe/i.test(e.message || ''));
  // La fila publicada de una vuelta del tablero, buscada por su gente (las reservas)
  // y su sentido. null si no hay una sola que cuadre.
  async function filaDeLaVuelta(lane) {
    if (!window.Api || typeof Api.getPublishedPlan !== 'function' || !rt.day) return null;
    const mias = (rt.order[lane.id] || []).map((k) => rt.aux[k] && rt.aux[k].reservationId).filter(Boolean);
    if (!mias.length) return null;
    let plan = null;
    try { plan = await Api.getPublishedPlan(rt.day, { estados: ESTADOS_PLAN }); } catch (_) { return null; }
    const tipo = lane.type === 'lle' ? 'lle' : 'sal';
    const gente = (v) => [...(v.pendientes || []), ...(v.atendidas || [])].map((x) => x.rid).filter(Boolean);
    const igual = ((plan && plan.vueltas) || []).filter((v) => (v.type === 'lle' ? 'lle' : 'sal') === tipo
      && v.status !== 'completed' && (!v.pool || v.paraTomar) && gente(v).length === mias.length && mias.every((r) => gente(v).includes(r)));
    return igual.length === 1 ? igual[0].id : null;
  }
  // Pone (o quita) el conductor de UNA vuelta. No re-encadena ni re-programa
  // nada: las otras vueltas y las horas de todas quedan como estaban.
  function setVueltaDriver(laneId, pick, callado, quien) {
    const lane = rtLaneOf(laneId); if (!lane) return '';
    const r = D.byId[laneId];
    const car = rt.cars.find((c) => c.id === lane.car);
    const delCarro = car ? rtCarDrv(car, rtBandOf(lane)) : null;
    // Lo publicado ya está en la base: «Deshacer» no lo devolvería (ver publicarVuelta).
    if (!callado) snapshot('conductor de una vuelta');
    const cual = `la vuelta de las ${hhmm(r ? inicioDe(r).at : rtToMin(lane.start))} de ${lane.car}`;
    let msg;
    delete lane.deleg; delete lane.tomar;   // 0151
    if (pick !== '__deleg') { delete lane.delegName; delete lane.delegPhone; }
    if (pick === '__carro') { delete lane.drv; msg = `${cual} vuelve a ${delCarro ? conductor(delCarro).name : 'quedar sin conductor, como el carro'}`; }
    else if (pick === '__none') { lane.drv = false; msg = `${cual} quedó sin conductor · las demás no cambian`; }
    else if (pick === '__tomar') {   // 0151: Coordinación la deja para que un conductor la tome
      lane.drv = false; lane.tomar = true;
      msg = `${cual} queda para tomar · al publicar la ven los conductores del turno en su app`;
    }
    else if (pick === '__deleg') {
      lane.drv = false; lane.deleg = true;
      if (quien && quien.name) { lane.delegName = quien.name; lane.delegPhone = quien.phone || ''; }
      msg = `${cual} queda delegada${lane.delegName ? ' a ' + lane.delegName : ''} · al publicar se le avisa al tripulante`;
    }
    else { if (pick === delCarro) delete lane.drv; else lane.drv = pick; msg = `${conductor(pick).name} hace ${cual} · las demás no cambian`; }
    if (callado) return msg;
    commit(msg.charAt(0).toUpperCase() + msg.slice(1));
    return msg;
  }
  // La flota ya vino con las reservas (rtLoad → rt.flota): no se vuelve a pedir.
  // Solo si no está (otra puerta de entrada) se lee, con plazo.
  async function placasDelPlan(vigente) {
    const faltan = (rt.cars || []).filter((c) => c.planVehicleId && !c.planPlate);
    if (!faltan.length) return;
    let flota = Array.isArray(rt.flota) && rt.flota.length ? rt.flota : null;
    if (!flota) {
      if (!window.Api || !Api.listVehiclesForShift) return;
      try { flota = await aTiempo(Api.listVehiclesForShift(), 'la flota'); } catch (_) { return; /* sin la flota, «Carro 1» sin placa */ }
      if (vigente && !vigente()) return;
    }
    faltan.forEach((c) => { const v = (flota || []).find((x) => x.id === c.planVehicleId); c.planPlate = v ? (v.license_plate || v.internal_code || null) : null; });
  }
  // ── 0132 · «¿Qué carro es Carro 1?» ─────────────────────────────────────────
  // Lista de los jefes (26-oct): «al hacer click en carro 1 o 2, despliegue el
  // listado de carros para uno seleccionar qué carro se le asigna a cada conductor
  // según la programación». Es la INDICACIÓN: al conductor le sale primero al
  // iniciar turno; si inicia en otro, manda la inspección (0124) y a los jefes les
  // llega el aviso (0132). Con el día publicado se guarda al momento, sin
  // re-publicar (no le avisa a nadie).
  async function openPlanCar(carId) {
    const car = rt.cars.find((c) => c.id === carId); if (!car) return;
    let flota = null;
    try { flota = window.Api && Api.listVehiclesForShift ? await Api.listVehiclesForShift() : null; } catch (_) { flota = null; }
    if (!flota || !flota.length) { toast('No se pudo leer la flota (o no hay carros registrados).'); return; }
    const nom = (v) => v.license_plate || v.internal_code || 'Carro';
    const de = (vid) => rt.cars.find((c) => c.id !== carId && c.planVehicleId === vid);
    const ST = { available: '', in_use: 'En uso', maintenance: 'En taller', blocked: 'Bloqueado', reserved: 'Reservado' };
    const opt = (v) => {
      const otro = de(v.id);
      const st = ST[v.status] || '';
      return `<button class="rv2-opt" role="radio" aria-checked="${car.planVehicleId === v.id}" data-pcar="${esc(v.id)}"><span class="t"><b>${esc(nom(v))}</b></span>`
        + (car.planVehicleId === v.id ? '<span class="st st--ok">Hoy</span>' : otro ? `<span class="st st--off">Es ${esc(otro.id)}</span>` : st ? `<span class="st st--adj">${esc(st)}</span>` : '')
        + `<small>${esc([[v.brand, v.model].filter(Boolean).join(' '), v.capacity ? v.capacity + ' pasajeros' : '', v.internal_code && v.license_plate && v.internal_code !== v.license_plate ? v.internal_code : '', otro ? 'si lo eliges, ' + otro.id + ' queda sin carro elegido' : ''].filter(Boolean).join(' · '))}</small></button>`;
    };
    openSheet(sheetHead(`¿Qué carro es ${esc(carId)}?`, `${esc(dayLabel(rt.day || ui.dia))} · al conductor le sale primero al iniciar turno; si inicia en otro, manda la inspección y te avisamos`)
      + `<div class="rv2-sh-body"><div id="rv2-pcars" role="radiogroup" aria-label="Carro de la flota para ${esc(carId)}" style="display:flex;flex-direction:column;gap:8px">`
      + flota.map(opt).join('')
      + `<h3 class="rv2-cap" style="margin-top:6px">O bien</h3><button class="rv2-opt" role="radio" aria-checked="${!car.planVehicleId}" data-pcar=""><span class="t"><b>Sin definir</b></span><small>El carro sale de la inspección, como hasta ahora.</small></button>`
      + '</div></div>'
      + `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-pcar-ok">${car.planVehicleId ? 'Cambiar' : 'Elegir'}</button></div>`);
    setLabel();
    let sel = car.planVehicleId || '';
    $('#rv2-pcars').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pcar]'); if (!b) return; sel = b.dataset.pcar;
      $$('#rv2-pcars [data-pcar]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.pcar === sel)));
    });
    $('#rv2-pcar-ok').addEventListener('click', async () => {
      const vid = sel || null;
      const v = flota.find((x) => x.id === vid) || null;
      const otro = vid ? de(vid) : null;
      const limpio = publicado() && firmaActual() === rt.firmaPublicada;
      const publicadas = (rt.lanes || []).some((l) => l.car === carId && l.raId);
      if (publicado() && publicadas && window.Api && Api.setPlanCarVehicle) {
        try {
          await Api.setPlanCarVehicle(rt.day, carId, vid);
          if (otro) await Api.setPlanCarVehicle(rt.day, otro.id, null);
        } catch (e) { toast('No se pudo guardar: ' + ((e && e.message) || 'error') + '. No cambió nada.'); return; }
      }
      closeSheet();
      if (otro) { otro.planVehicleId = null; otro.planPlate = null; }
      car.planVehicleId = vid; car.planPlate = v ? nom(v) : null;
      if (publicado() && publicadas && limpio) rt.firmaPublicada = firmaActual();
      render();
      toast(vid ? `${carId} es ${nom(v)}${otro ? ` · ${otro.id} queda sin carro elegido` : ''}${publicado() && publicadas ? ' · guardado (no se re-publicó nada)' : ' · se guarda al publicar'}.`
        : `${carId} queda sin carro elegido: sale de la inspección.`);
    });
  }

  function openAssignSlot(carId, shift) {
    // 28-oct: la fila «Carro Apoyo» de Conductores son todos los carros de apoyo del turno.
    const grupo = carId === APOYO ? apoyoEn(shift) : null;
    const car = grupo ? grupo[0] : rt.cars.find((c) => c.id === carId); if (!car) return;
    const nom = grupo ? APOYO_TXT : carId;
    const cur = grupo ? (grupo.map((c) => rtCarDrv(c, shift)).find(Boolean) || null) : rtCarDrv(car, shift);
    const otroDe = (id) => (grupo ? (rt.cars || []).find((c) => !grupo.includes(c) && rtCarDrv(c, shift) === id) || null : usadoEn(shift, id, car.id));
    // En el grupo, el que ya está en uno puede quedar en todos.
    const yaEsta = (id) => (grupo ? grupo.every((c) => rtCarDrv(c, shift) === id) : id === cur);
    const pool = poolTurno(shift);
    const opts = pool.map((d) => ({ d, otro: otroDe(d.id) }));
    // El jefe manda (13-oct-2026): además de los del turno, cualquier otro
    // conductor, por si hace falta cubrir con alguien que no estaba programado.
    const enPool = new Set(pool.map((d) => d.id));
    const otros = (rt.drivers || []).filter((d) => !enPool.has(d.id)).map((d) => ({ d, otro: otroDe(d.id) }));
    let sel = cur || (opts.find((o) => !o.otro) || {}).d?.id || null;
    const slots = slotsSinConductor();
    const cargado = shift === 'mad' ? rt.shiftPrevLoaded : rt.shiftLoaded;
    const nota = cargado
      ? (shift === 'mad' ? `En turno PM del ${rtDiaAnterior()} según el horario publicado (las vueltas antes de las ${rtHHc()})` : `En turno ${rtBandName(shift)} según el horario publicado`)
      : 'Sin horario publicado para ese día: se muestran todos los conductores';
    const curName = cur ? conductor(cur).name : null;
    const auto = cur && rt.rv2Auto && rt.rv2Auto[(grupo ? (grupo.find((c) => rtCarDrv(c, shift) === cur) || car).id : carId) + '|' + shift] === cur;
    const optBtn = ({ d, otro }, fuera) => {
      const full = (rt.drivers || []).find((x) => x.id === d.id) || {};
      const pill = d.id === cur ? '<span class="st st--ok">Actual</span>' : otro ? `<span class="st st--off">Maneja ${esc(otro.id)}</span>` : fuera ? '<span class="st st--adj">Fuera de turno</span>' : '<span class="st st--ok">Libre</span>';
      const small = [full.tel || '', otro ? `si lo eliges, ${curName ? esc(curName) + ' pasa a ' + esc(otro.id) : esc(otro.id) + ' queda sin conductor'}` : (d.id === cur ? 'asignado a este carro' : fuera ? 'no está en este turno en el horario' : 'sin carro en este turno')].filter(Boolean).join(' · ');
      return `<button class="rv2-opt" role="radio" aria-checked="${d.id === sel}" data-pick="${esc(d.id)}"><span class="t"><b>${esc(d.n)}</b></span>${pill}<small>${small}</small></button>`;
    };
    const propias = (D && D.routes ? D.routes : []).filter((x) => (grupo ? grupo.some((c) => c.id === x.vehicle) : x.vehicle === carId) && x.shift === shift && x.propio).length;
    openSheet(sheetHead(`Conductor para ${esc(nom)}`, `Turno ${rtBandName(shift)} · aplica a todas sus vueltas de ese turno${propias ? ` (menos ${propias === 1 ? 'la que tiene' : `las ${propias} que tienen`} conductor propio)` : ''}${curName ? ' · hoy: ' + esc(curName) + (auto ? ' (automático)' : '') : ''}`) +
      `<div class="rv2-sh-body"><h3 class="rv2-cap">${esc(nota)}</h3><div id="rv2-dopts" role="radiogroup" aria-label="Conductores disponibles" style="display:flex;flex-direction:column;gap:8px">` +
      (opts.length ? opts.map((o) => optBtn(o, false)).join('') : `<p class="rv2-impact">Nadie en turno ${rtBandName(shift)} ese día en el horario publicado. Puedes elegir otro conductor abajo.</p>`) +
      (cargado && otros.length ? `<h3 class="rv2-cap" style="margin-top:6px">Otros conductores</h3>` + otros.map((o) => optBtn(o, true)).join('') : '') +
      `</div>${slots.size > 1 ? `<button class="rv2-btn" data-act="autoassign" style="margin-top:4px">Autoasignar todos los carros sin conductor (${slots.size})</button>` : ''}</div>` +
      `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn rv2-btn--cta" id="rv2-doAssign"${sel && !yaEsta(sel) ? '' : ' disabled'}>Asignar</button></div>`);
    setLabel();
    $('#rv2-dopts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; sel = b.dataset.pick;
      $$('#rv2-dopts [data-pick]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.pick === sel)));
      $('#rv2-doAssign').disabled = !sel || yaEsta(sel);
    });
    $('#rv2-doAssign').addEventListener('click', () => { if (!sel) return; const s = sel; closeSheet(); if (grupo) asignarApoyo(grupo, shift, s); else swapDriver(car.id, shift, s); });
  }

  function openPublish() {
    if (soloJulian()) { toast('Este día va con la ruta de Julián: los conductores toman las vueltas.'); return; }
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
    // Día mezclado (26-oct-2026): lo pegado no cambia al publicar el tablero.
    const nPeg = ui.manual && ui.manual.mixto ? ui.manual.vueltas.length : 0;
    const julian = nPeg
      ? `<p class="rv2-impact" data-k="julian">La ruta de Julián de este día (${plural(nPeg, 'vuelta pegada', 'vueltas pegadas')}) <b>no se toca</b>: publicar solo cambia las vueltas del tablero, y a sus tripulantes no se les mueve nada.</p>`
      : '';
    const forzarItems = [c.risk ? plural(c.risk, 'vuelta que llega tarde a la presentación', 'vueltas que llegan tarde a la presentación') : '',
      c.nodriver ? plural(c.nodriver, 'vuelta sin conductor (queda en borrador, nadie la ve)', 'vueltas sin conductor (quedan en borrador, nadie las ve)') : '',
      unr ? plural(unr, 'tripulante sin carro', 'tripulantes sin carro') : ''].filter(Boolean);
    openSheet(sheetHead(yaPub ? (conCambios() ? 'Publicar cambios' : 'Volver a publicar') : 'Publicar plan', `${plural(c.all, 'vuelta', 'vueltas')} · se avisa a ${plural(conductoresConVuelta, 'conductor', 'conductores')} y a los tripulantes`) +
      `<div class="rv2-sh-body">${aviso}${julian}` +
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
    $$('.rv2-row[data-id]', root()).forEach((row) => { if (row.dataset.id === id) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
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
  // Ir a una vuelta pegada de la lista (desde Avisos): se busca y se marca un momento.
  function verPegada(id) {
    if (ui.q) { ui.q = ''; if (el.q) el.q.value = ''; renderList(); }
    const row = $$('.rv2-row--julian', root()).find((x) => x.dataset.julian === id);
    if (!row) return;
    if (row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('is-flash');
    setTimeout(() => row.classList.remove('is-flash'), 1600);
  }
  function autoSelect() {
    if (esCajon() || ui.sel || !D) return;
    // Las terminadas van recogidas al final: se abre la primera que todavía falta
    // (0137: tampoco una que ya bajó por pasar su hora sin marcar).
    const vivas = D.routes.filter((r) => r.fija !== 'completed' && !ocultaFila(r));
    const base = vivas.length ? vivas : D.routes;
    const first = base.filter((r) => r.status === 'risk').sort((a, b) => a.arrival - b.arrival)[0]
      || base.slice().sort((a, b) => a.pickup - b.pickup)[0];
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
    // Las vueltas pegadas (sin data-id) no reciben: no son del tablero.
    $$('.rv2-row[data-id]', root()).forEach((row) => row.classList.toggle('is-drop', puedeRecibir(row.dataset.id, crewId, fromId)));
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
  // opts.plan (26-oct-2026): la lectura de lo publicado ya en camino (cargarDia la
  // lanza a la vez que las reservas); si no viene, se pide aquí. Primero se lee y
  // DESPUÉS se toca `rt`, y solo si opts.vigente() sigue diciendo que sí. Si lo
  // publicado no responde a tiempo, el error sube (cargarDia lo dice en pantalla):
  // mostrar el día «sin publicar» invitaría a re-optimizar encima del plan real.
  // Cualquier otro error, como siempre: el día se ve sin lo publicado.
  async function rearmarPublicado(opts = {}) {
    const vigente = typeof opts.vigente === 'function' ? opts.vigente : () => true;
    const puede = rt.source === 'live' && rt.day && window.Api && typeof Api.getPublishedPlan === 'function';
    let plan = null, fallo = false;
    if (puede) {
      try { plan = await aTiempo(opts.plan || Api.getPublishedPlan(rt.day, { estados: ESTADOS_PLAN }), 'el plan publicado'); }
      catch (e) { if (e && e.vencida) throw e; fallo = true; }
    }
    if (!vigente()) return false;
    // Los sin carro (rt.pool) se arman en rtLoad con TODO rt.aux, y aquí se sacan
    // de rt.aux los sin cuenta, la madrugada de otro día y la gente de la ruta
    // pegada. Si el día sale antes de rearmar el tablero (sin vueltas del tablero),
    // rt.pool quedaba con llaves que ya no existen y Asignación no abría el día:
    // «undefined is not an object (evaluating 't.split')» (miércoles 28-oct-2026).
    const podarPool = () => { rt.pool = (rt.pool || []).filter((k) => rt.aux && rt.aux[k]); return false; };
    rt.firmaPublicada = null; rt.rv2Fijas = {}; rt.rv2Atendidas = {}; rt.rv2Auto = {}; rt.horasPub = {}; rt.rv2Fin = {};
    ui.manual = null; rt.manualDia = false; rt.rv2Solas = []; rt.rv2AuxPegadas = {}; rt.rv2Ajenas = []; rt.rv2EnSolas = [];
    // Los sin cuenta salen de las vueltas publicadas: se vuelven a leer de ahí.
    Object.keys(rt.aux || {}).forEach((k) => { if (rt.aux[k] && rt.aux[k].guest) delete rt.aux[k]; });
    if (!puede || fallo) return podarPool();
    const todas = (plan && plan.vueltas) || [];
    // 0125: las vueltas que pegó Julián (pool) no entran al tablero: el día se
    // muestra con su ruta y los conductores las toman (admin-ruta-julian.js).
    const deEste = (v) => !v.manualDay || v.manualDay === rt.day;
    // 0134: la vuelta para tomar que armó el sistema (alguien cambió de vuelo y no
    // cabía en otra) NO pasa el día a «ruta de Julián»: se cuenta aparte y sus
    // personas ya van en una vuelta, así que el tablero no las vuelve a rutear.
    const solas = todas.filter((v) => v.pool && v.autoCreated && !v.paraTomar);
    const hmSola = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (_) { return ''; } };
    rt.rv2Solas = solas.map((v) => ({
      hora: hmSola(v.type === 'lle' ? v.startAt : ((v.pendientes || [])[0] || {}).etaAt || v.startAt),
      tipo: v.type === 'lle' ? 'Llegada' : 'Salida',
      quienes: [...(v.pendientes || []), ...(v.atendidas || [])].map((x) => String(x.name || '').split(' ')[0]).filter(Boolean).join(', '),
      conductor: v.driverProfileId ? v.conductor : null,
    }));
    // 0151: la «para tomar» del tablero ES del tablero (pool solo para que la tomen).
    const pegadas = todas.filter((v) => v.pool && !v.autoCreated && !v.paraTomar && deEste(v));
    const vueltas = todas.filter((v) => !v.pool || v.paraTomar);
    const genteDe = (v) => [...(v.pendientes || []), ...(v.atendidas || [])].map((x) => x.rid).filter(Boolean);
    // La madrugada que Julián pegó con el día ANTERIOR cae en esta ventana: esas
    // personas ya van en una vuelta suya, así que el tablero no las vuelve a rutear.
    const ajenas = new Set(todas.filter((v) => v.pool && !v.paraTomar && (v.autoCreated || !deEste(v))).flatMap(genteDe));
    if (ajenas.size) Object.keys(rt.aux).forEach((k) => { if (ajenas.has(rt.aux[k].reservationId)) delete rt.aux[k]; });
    rt.rv2Ajenas = [...ajenas];   // la hoja de la ruta de Julián no las vuelve a ofrecer
    // 28-oct: …salvo las de las vueltas que armó el sistema: si el jefe las pega,
    // es su pedido de verdad (no un «sin cuenta» de más) y al publicar salen de la
    // vuelta para tomar (saveRoutePlan, enSola).
    rt.rv2EnSolas = solas.flatMap(genteDe);
    // Día mezclado (26-oct-2026): quien va en una vuelta pegada de ESTE día tampoco
    // se rutea en el tablero (saldría «sin carro» y Re-optimizar lo metería en otra
    // vuelta; saveRoutePlan igual lo saltaría). Salvo que ya vaya en una vuelta del
    // tablero que arrancó: ahí va de verdad. Se guarda aparte para «Volver a pegar»
    // y el Excel del día (admin-ruta-julian.js), que sí lo necesitan.
    const arranco = (v) => v.status === 'in_progress' || v.status === 'completed' || (v.atendidas || []).length > 0;
    const enCurso = new Set(vueltas.filter(arranco).flatMap(genteDe));
    const deJulian = new Set(pegadas.flatMap(genteDe).filter((r) => !enCurso.has(r)));
    if (deJulian.size) Object.keys(rt.aux).forEach((k) => { if (deJulian.has(rt.aux[k].reservationId)) { rt.rv2AuxPegadas[k] = rt.aux[k]; delete rt.aux[k]; } });
    ui.manual = pegadas.length ? { vueltas: pegadas, otras: vueltas.length, mixto: false } : null;
    rt.manualDia = !!ui.manual;
    if (!vueltas.length) return podarPool();
    const porReserva = {};
    Object.keys(rt.aux).forEach((k) => { const r = rt.aux[k].reservationId; if (r) porReserva[r] = k; });
    const lanes = [], order = {}, usados = new Set(), nCarro = {}, fijas = {}, atendidas = {}, horas = {}, guardado = {}, fines = {}, delegQuien = {}, tomarDe = {};
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
        car = { id, avail0: '00:00', driver: null, capacity: v.cap || rt.CAP, vehicleId: null, apoyo: true };   // 28-oct: «Carro Apoyo»
        rt.cars.push(car);
        if (!v.planCar && v.vehicleId) porPlaca[v.vehicleId] = car.id;
      }
      // 0132: «Carro 1 = PRW443» (lo que decía el plan publicado).
      if (v.planVehicleId && !car.planVehicleId) car.planVehicleId = v.planVehicleId;
      const stops = [...(v.atendidas || []), ...(v.pendientes || [])].sort((a, b) => a.order - b.order);
      // 0133: el sin cuenta (Kriss) es una parada más de la vuelta (auxSinCuenta).
      const keyDe = (s) => (s.rid ? porReserva[s.rid] : (s.guest ? sinCuentaPublicado(s, v) : null));
      const ids = stops.map(keyDe).filter((k) => k && !usados.has(k));
      if (!ids.length) return;
      ids.forEach((k) => usados.add(k));
      (v.atendidas || []).forEach((s) => { const k = keyDe(s); if (k) atendidas[k] = s.status; });
      const n = (nCarro[car.id] || 0) + 1; nCarro[car.id] = n;
      const lane = { id: `${car.id}·V${n}`, car: car.id, vuelta: n, type: v.type === 'lle' ? 'lle' : 'sal', start: hm(v.startAt), origin: null };
      // 0129: la fila publicada de esta vuelta, para «Guardar y publicar» solo ella.
      lane.raId = v.id; lane.raStatus = v.status;
      // 0154: la hora y el conductor que tenía en la base al abrir el día (ver sincronizarConBase).
      lane.raStart = v.startAt; lane.raDbDrv = v.driverProfileId || null;
      if (lane.type === 'lle') { lane.origin = 'airport'; lane.landing = rtToHM(horaVuelta(ids)); }
      lanes.push(lane); order[lane.id] = ids;
      guardado[lane.id] = v.delegated ? 'deleg' : (v.driverProfileId || null);
      if (v.paraTomar) tomarDe[lane.id] = true;   // 0151
      if (v.delegated && v.delegateName) delegQuien[lane.id] = { name: v.delegateName, phone: v.delegatePhone || '' };   // 0131
      // La hora guardada (rtHorasPub, admin-rutas.js): en una salida la de cada
      // parada; en una llegada basta el arranque (la salida de JMC).
      const etas = {};
      if (lane.type !== 'lle') stops.forEach((s) => { const k = keyDe(s); if (k && s.etaAt) etas[k] = rtToMin(hm(s.etaAt)); });
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
        // 0151: quien tomó una «para tomar» no pasa a ser el conductor del carro.
        if (!v.paraTomar) rtSetCarDrv(car, banda, rtCarDrv(car, banda) || v.driverProfileId);
      }
    });
    if (!lanes.length) return podarPool();
    // Día mezclado: hay tablero, así que se ve y se publica como siempre; la ruta
    // pegada va arriba de la lista con sus botones (renderList → pegadasHTML).
    // Publicar no la toca: saveRoutePlan no borra vueltas pool ni re-mete a su gente.
    if (ui.manual) { ui.manual.mixto = true; rt.manualDia = false; }
    // Conductor propio (26-oct-2026): una vuelta guardada con otro conductor que
    // el de su carro en ese turno (o sin conductor, y el carro sí tiene) vuelve
    // con ESE conductor. Si no, se vería el del carro y al re-publicar se perdería
    // el cambio de una sola vuelta.
    lanes.forEach((l) => {
      const car = rt.cars.find((c) => c.id === l.car);
      const g = guardado[l.id], delCarro = car ? rtCarDrv(car, rtBandOf(l)) : null;
      if (g === 'deleg') { l.drv = false; l.deleg = true; if (delegQuien[l.id]) { l.delegName = delegQuien[l.id].name; l.delegPhone = delegQuien[l.id].phone; } return; }   // 0126 · 0131
      if (tomarDe[l.id]) { l.tomar = true; l.drv = g || false; return; }   // 0151: para tomar (y quién la tomó)
      if (g && g !== delCarro) l.drv = g;
      else if (!g && delCarro) l.drv = false;
    });
    rt.lanes = lanes; rt.order = order; rt.horasPub = horas;
    rt.pool = Object.keys(rt.aux).filter((k) => !usados.has(k));
    rt.rv2Fijas = fijas; rt.rv2Atendidas = atendidas; rt.rv2Fin = fines;
    rt.cars.forEach((c) => encadenar(c.id));
    marcarComoEnLaBase(rt.lanes);
    rt.optimized = true;
    rt.firmaPublicada = firmaActual();
    return true;
  }

  // ── 0154 · Lo que el SISTEMA cambió en una vuelta publicada ──────────────────
  // El acomodo (0135/0154) le corre la hora a una llegada cuyo vuelo viene tarde, o se
  // la pasa a otro conductor. El tablero no se enteraba: seguía mostrando la hora de
  // antes y, al publicar, se la devolvía. El 28-oct a Fernando el sistema le corrió la
  // vuelta tres veces (2:10, 2:20 y 2:30 p. m.) y a Juan le llegó el aviso tres veces.
  // Ahora, cada minuto (refrescarFines) y justo antes de publicar, si la base cambió
  // una vuelta y el jefe NO la tocó en la pantalla (misma hora y mismo conductor que
  // al abrirla), el tablero toma la hora y el conductor de la base. Si el jefe sí la
  // tocó, manda lo del jefe.
  const hmIso = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5);
  function marcarComoEnLaBase(lanes) {
    (lanes || []).forEach((l) => { if (l.raId) { l.raHm = l.start; l.raDrv = rtDriverOf(l) || null; l.raTomar = l.tomar === true; } });
  }
  function sincronizarConBase(porId) {
    const cambiadas = [];
    const porReserva = {};
    Object.keys(rt.aux || {}).forEach((k) => { const x = rt.aux[k].reservationId; if (x) porReserva[x] = k; });
    (rt.lanes || []).forEach((l) => {
      if (!l.raId || !l.raStart || fijaDe(l.id) || l.deleg === true) return;
      const v = porId.get(l.raId); if (!v || v.delegated || v.status === 'completed') return;
      const sola = v.pool && !v.paraTomar && !v.driverProfileId;   // el sistema la dejó para tomar
      const drvBase = v.driverProfileId || null;
      const cambioBase = hmIso(v.startAt) !== hmIso(l.raStart) || drvBase !== l.raDbDrv || (sola && !l.tomar);
      if (!cambioBase) return;
      const tocoJefe = l.start !== l.raHm || (rtDriverOf(l) || null) !== l.raDrv || (l.tomar === true) !== l.raTomar;
      if (tocoJefe) return;   // lo del jefe manda (y el acomodo lo vuelve a mirar)
      const antes = l.start;
      l.start = hmIso(v.startAt);
      const ids = rt.order[l.id] || [];
      rt.horasPub = rt.horasPub || {};
      if (l.type === 'lle') rt.horasPub[l.id] = { start: l.start, sig: ids.join(','), etas: {} };
      else {
        const etas = {};
        [...(v.atendidas || []), ...(v.pendientes || [])].forEach((st) => { const k = porReserva[st.rid]; if (k && st.etaAt) etas[k] = rtToMin(hmIso(st.etaAt)); });
        rt.horasPub[l.id] = { start: l.start, sig: ids.join(','), etas };
      }
      const car = rt.cars.find((c) => c.id === l.car);
      const delCarro = car ? rtCarDrv(car, rtBandOf(l)) : null;
      if (sola) { l.drv = false; l.tomar = true; }
      else if (v.paraTomar) { l.tomar = true; l.drv = drvBase || false; }   // 0151: la tomó un conductor (sigue para tomar)
      else if (drvBase !== (rtDriverOf(l) || null)) { delete l.tomar; if (drvBase && drvBase === delCarro) delete l.drv; else l.drv = drvBase || false; }
      l.raStart = v.startAt; l.raDbDrv = drvBase; l.raStatus = v.status;
      cambiadas.push({ lane: l, antes, sola, drv: drvBase });
    });
    if (cambiadas.length) marcarComoEnLaBase(cambiadas.map((x) => x.lane));
    return cambiadas;
  }
  // El aviso, en palabras: «El sistema corrió 1 vuelta (vuelo tarde): V-01 11:37 → 12:05 con Juan».
  function avisoSincronia(cambiadas) {
    if (!cambiadas.length) return '';
    const una = (x) => `${x.lane.car} ${x.antes} → ${x.lane.start}${x.sola ? ' (para tomar)' : x.drv ? ` con ${conductor(x.drv).name.split(' ')[0]}` : ''}`;
    return `El sistema ${cambiadas.length === 1 ? 'cambió 1 vuelta' : `cambió ${cambiadas.length} vueltas`} (vuelo que viene tarde): ${cambiadas.slice(0, 3).map(una).join(' · ')}${cambiadas.length > 3 ? '…' : ''}. El tablero ya lo tiene.`;
  }
  // Antes de publicar: se lee la base otra vez (lo del último minuto) y se toma.
  async function sincronizarAntesDePublicar() {
    if (rt.source !== 'live' || !rt.day || !window.Api || typeof Api.getPublishedPlan !== 'function') return [];
    let plan = null;
    try { plan = await Api.getPublishedPlan(rt.day, { estados: ESTADOS_PLAN }); } catch (_) { return []; }
    return sincronizarConBase(new Map(((plan && plan.vueltas) || []).map((v) => [v.id, v])));
  }

  // 0137 · CÓMO VA CADA VUELTA, SIN RECARGAR. Asignación solo leía el día al
  // entrar: una vuelta que terminaba seguía en la lista hasta que el jefe recargaba
  // («aún veo servicios de la mañana»). Cada minuto, si el jefe no está moviendo
  // nada, se vuelve a leer el resultado de lo publicado (terminada, sin marcar,
  // quién va a bordo) y se repinta. El tablero (vueltas, horas, conductores) no se
  // toca: lo que el jefe tenga sin publicar queda igual.
  let finTimer = null;
  async function refrescarFines() {
    const r = root();
    if (!r || r.hidden || (typeof document !== 'undefined' && document.hidden)) return false;
    if (ui.cargando || ui.publicando || ui.optimizando || ui.drag || ui.moving) return false;
    if (el.sheet && el.sheet.hidden === false) return false;   // una hoja abierta (mover, asignar, publicar…)
    if (rt.source !== 'live' || !rt.day || !window.Api || typeof Api.getPublishedPlan !== 'function') return false;
    const dia = rt.day;
    let plan = null;
    try { plan = await Api.getPublishedPlan(dia, { estados: ESTADOS_PLAN }); } catch (_) { return false; }
    if (rt.day !== dia || ui.cargando || ui.moving || ui.drag) return false;   // cambió algo mientras se leía
    const porId = new Map(((plan && plan.vueltas) || []).map((v) => [v.id, v]));
    if (ui.manual && Array.isArray(ui.manual.vueltas)) ui.manual.vueltas = ui.manual.vueltas.map((v) => porId.get(v.id) || v);
    const porReserva = {};
    Object.keys(rt.aux || {}).forEach((k) => { const x = rt.aux[k].reservationId; if (x) porReserva[x] = k; });
    rt.rv2Fin = rt.rv2Fin || {}; rt.rv2Fijas = rt.rv2Fijas || {}; rt.rv2Atendidas = rt.rv2Atendidas || {};
    (rt.lanes || []).forEach((l) => {
      const v = l.raId && porId.get(l.raId); if (!v) return;
      if (v.fin) rt.rv2Fin[l.id] = v.fin;
      (v.atendidas || []).forEach((st) => { const k = porReserva[st.rid]; if (k) rt.rv2Atendidas[k] = st.status; });
      if (v.fin && (v.fin.estado === 'ok' || v.fin.estado === 'bad')) rt.rv2Fijas[l.id] = 'completed';
      else if (!rt.rv2Fijas[l.id] && (v.atendidas || []).length) rt.rv2Fijas[l.id] = 'in_progress';
    });
    // 0154: lo que el sistema le cambió a una vuelta que el jefe no ha tocado.
    const limpio = publicado() && firmaActual() === rt.firmaPublicada;
    const cambiadas = sincronizarConBase(porId);
    if (cambiadas.length) {
      if (limpio) rt.firmaPublicada = firmaActual();
      toast(avisoSincronia(cambiadas), true);
    }
    // Con una vuelta abierta no se rehace el detalle (el mapa parpadearía): solo la lista.
    if (ui.sel && !ui.manual) { D = armarDia(); renderList(); renderDrivers(); pintarEntregas(); }
    else render();
    return true;
  }
  function arrancarRefresco() {
    if (finTimer || typeof setInterval !== 'function') return;
    finTimer = setInterval(() => { refrescarFines().catch(() => {}); }, 60000);
  }

  // ── Plazo de cada etapa de la carga (26-oct-2026) ──────────────────────────
  // supabase-js y fetch esperan sin fin. Ese día, en producción, una consulta
  // colgada dejó Asignación más de 10 min en «Cargando el día…», con la fecha
  // vieja puesta y ‹ › apagados: el jefe tuvo que recargar la página. Ahora cada
  // etapa tiene su plazo; vencido, la pantalla lo dice («No se pudo cargar el día
  // · Reintentar») y lo que llegue tarde se descarta.
  let PLAZO_CARGA_MS = 20000;
  function aTiempo(p, que) {
    let t = null;
    const vence = new Promise((_, no) => {
      t = setTimeout(() => {
        const e = new Error(`La conexión tardó más de ${Math.round(PLAZO_CARGA_MS / 1000)} s trayendo ${que}.`);
        e.vencida = true; no(e);
      }, PLAZO_CARGA_MS);
    });
    return Promise.race([Promise.resolve(p), vence]).finally(() => clearTimeout(t));
  }
  // Cada carga lleva su número y solo la última pinta: si el jefe cambia de día a
  // mitad de una carga, la vieja sigue sola hasta terminar, sin tocar nada.
  let cargaN = 0;

  async function cargarDia(day) {
    const n = ++cargaN;
    let vencida = false;   // venció un plazo: lo que esta carga traiga después, se bota
    const vigente = () => n === cargaN && !vencida;
    ui.cargando = true; ui.falloCarga = null; ui.diaPedido = day || null;
    ui.sel = null; ui.moving = null; hist.length = 0;
    if (el.detail) el.detail.classList.remove('is-open');
    try { if (root() && !root().hidden) render(); } catch (_) { /* lo que se veía antes; la carga sigue */ }
    // Con el día pedido, lo publicado se lee A LA VEZ que las reservas: no depende
    // de ellas (antes esperaba a que terminara todo lo demás).
    const leerPlan = (d) => { let p; try { p = Promise.resolve(Api.getPublishedPlan(d, { estados: ESTADOS_PLAN })); } catch (e) { p = Promise.reject(e); } p.catch(() => {}); return p; };
    let pPlan = day && window.Api && typeof Api.getPublishedPlan === 'function' ? leerPlan(day) : null;
    let fallo = null;
    try {
      await aTiempo(rtLoad(day || undefined, { vigente }), 'las reservas');
      if (!vigente()) return;
      ui.dia = rt.day || day || hoyBog();
      rt.rv2Auto = {};
      if (pPlan && rt.day !== day) pPlan = null;   // el día salió otro: rearmarPublicado pide el que es
      const hay = await rearmarPublicado({ vigente, plan: pPlan });
      if (!vigente()) return;
      // 0132: la placa del carro del plan, para que «Carro 1» diga «PRW443».
      if (hay) await placasDelPlan(vigente);
      if (!vigente()) return;
      // Sin tiempos por carretera las ETAs saldrían en línea recta. Para LEER
      // lo publicado no se gasta TomTom (cobra por celda): caché si la hay, si
      // no OSRM. Re-optimizar sí pide tráfico, como siempre. Si no llegan a
      // tiempo, línea recta, como con cualquier error (no tumba la carga).
      if (hay && typeof rtBuildMatrix === 'function') {
        let tarde = false, src = null;
        try { src = await aTiempo(rtBuildMatrix({ sinTrafico: true, vigente: () => vigente() && !tarde }), 'los tiempos por carretera'); }
        catch (_) { tarde = true; /* cae a línea recta */ }
        if (!vigente()) return;
        if (!tarde) rt.etaSource = src;
      }
    } catch (e) {
      if (n !== cargaN) return;   // ya hay otra carga: esta no dice nada
      vencida = true; fallo = e;
    }
    if (fallo) {
      // ui.cargando sigue en true (el día no está cargado: nada de lista, avisos
      // ni Publicar); ‹ › y «Reintentar» sí sirven.
      ui.falloCarga = { dia: day || null, motivo: (fallo && fallo.vencida && fallo.message) || 'Falló al traer el día.', detalle: fallo && fallo.vencida ? '' : detalleDe(fallo) };
      if (!fallo.vencida && window.console) console.error('[Asignación] falló al traer el día', fallo);
      if (window.Api && typeof Api.limpiarCacheCorta === 'function') Api.limpiarCacheCorta();
      if (root() && !root().hidden) pintarFallo();
      return;
    }
    ui.cargando = false; ui.diaPedido = null;
    try {
      pintarDia(n);
      // La madrugada que se pegó con el día anterior (guardarPegado) entra ahora.
      const pend = rt.source === 'live' && pegadoPendiente[ui.dia];
      if (pend) {
        delete pegadoPendiente[ui.dia];
        const r = meterPegado(pend);
        if (r && r.vueltas) toast(`Entró la madrugada que pegaste con el día anterior: ${plural(r.vueltas, 'vuelta', 'vueltas')}. Revísala y publica.`, true);
      }
    }
    catch (e) {
      // Un error al PINTAR el día (no al traerlo) dejaba la pantalla en «Cargando
      // el día…» para siempre, sin decir nada: lo último que alcanzó a dibujar.
      if (n !== cargaN) return;
      ui.cargando = true; ui.diaPedido = day || rt.day || null;
      ui.falloCarga = { dia: day || rt.day || null, motivo: 'Los datos llegaron, pero falló al mostrar el día.', detalle: detalleDe(e) };
      if (window.console) console.error('[Asignación] falló al mostrar el día', e);
      if (root() && !root().hidden) pintarFallo();
    }
  }
  // Lo que se hace con el día ya cargado: rótulos, lo que llega después y pintar.
  function pintarDia(n) {
    rotularVieja();
    // La madrugada del día siguiente (es de este turno PM): llega después, como los vuelos.
    const diaPedido = ui.dia;
    if (window.Api && Api.getMadrugadaSiguiente) {
      Api.getMadrugadaSiguiente(diaPedido, rtCut())
        .then((m) => { if (ui.dia !== diaPedido || n !== cargaN) return; ui.madSig = m; if (root() && !root().hidden) pintarSeguro(n); })
        .catch(() => {});
    }
    // Los vuelos del día (si la integración está encendida) llegan después y
    // solo agregan el chip en el detalle.
    if (window.RendioVuelos) window.RendioVuelos.cargar(ui.dia).then(() => { if (n === cargaN && !ui.cargando && root() && !root().hidden) pintarSeguro(n); }).catch(() => {});
    if (root() && !root().hidden) { render(); autoSelect(); }
    else if (typeof rtRenderAll === 'function') { rtRenderAll(); syncVieja(); }
  }
  // Repintar con lo que llega después (madrugada, vuelos): si falla, se dice.
  function pintarSeguro(n) {
    try { render(); }
    catch (e) {
      if (n !== cargaN) return;
      ui.cargando = true; ui.diaPedido = rt.day || ui.dia || null;
      ui.falloCarga = { dia: rt.day || ui.dia || null, motivo: 'Los datos llegaron, pero falló al mostrar el día.', detalle: detalleDe(e) };
      if (window.console) console.error('[Asignación] falló al mostrar el día', e);
      pintarFallo();
    }
  }
  function reintentar() {
    const dia = ui.falloCarga ? ui.falloCarga.dia : (ui.diaPedido || rt.day || ui.dia || null);
    if (window.Api && typeof Api.limpiarCacheCorta === 'function') Api.limpiarCacheCorta();
    return cargarDia(dia);
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
    // A mitad de una carga (o si falló) se cuenta desde el día que se pidió y no
    // se pregunta: los cambios del día de antes ya se dejaron al salir de él.
    const base = (ui.cargando && ui.diaPedido) || rt.day || ui.dia || hoyBog();
    if (!ui.cargando && cambiosPropios() && !window.confirm(`Hay cambios sin publicar en ${dayLabel(base)}. Si cambias de día se pierden. ¿Cambiar de todos modos?`)) return;
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
    if (ui.cargando && !ui.falloCarga) { render(); return; }   // ya hay una carga en curso
    if (ui.falloCarga) return reintentar();               // la última carga falló: se vuelve a intentar
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
      avisos: $('#rv2-avisos'), drivers: $('#rv2-drivers'), say: $('#rv2-say'), entregas: $('#rv2-entregas'),
      scrim: $('#rv2-scrim'), sheet: $('#rv2-sheet'), toast: $('#rv2-toast'),
      dayLabel: $('#rv2-dayLabel'), pubChip: $('#rv2-pubChip'), reopt: $('#rv2-reopt'), reoptLabel: $('#rv2-reoptLabel'), enrutar: $('#rv2-enrutar'),
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
    if (el.enrutar) el.enrutar.addEventListener('click', enrutar);   // 28-oct
    $('#rv2-wa').addEventListener('click', abrirWhatsApp);
    // 0125: la ruta de Julián y el Excel del día (con la estructura del Formulario).
    if ($('#rv2-julian')) $('#rv2-julian').addEventListener('click', () => { if (window.RendioRutaJulian) window.RendioRutaJulian.abrir(); });
    // 27-oct: pregunta de qué día si el de la pantalla no es el de mañana (elegirExcel).
    if ($('#rv2-xlsx')) $('#rv2-xlsx').addEventListener('click', () => { const J = window.RendioRutaJulian; if (J) (J.elegirExcel || J.excel)(); });
    document.addEventListener('keydown', onKey);
    arrancarRefresco();   // 0137
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
      if (a === 'hora') return openHora(act.dataset.id);          // 27-oct: cualquier vuelta
      if (a === 'datos') return abrirDatos(act.dataset.crew);     // 27-oct: la ficha del tripulante
      if (a === 'assignslot') return openAssignSlot(act.dataset.car, act.dataset.shift);
      if (a === 'plancar') return openPlanCar(act.dataset.car);
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
      if (a === 'sola') { if (!el.sheet.hidden) closeSheet(); return pasarASola(act.dataset.crew, act.dataset.from || null); }
      if (a === 'apply') return moveCrew(act.dataset.crew, act.dataset.from, act.dataset.to);
      if (a === 'autoassign') { closeSheet(); return autoAssign(); }
      if (a === 'ver') return verRuta(act.dataset.id);
      if (a === 'verjulian') return verPegada(act.dataset.ra);
      if (a === 'avtoggle') return abrirAvisos(!ui.avisosAbiertos);
      if (a === 'avisos') { e.preventDefault(); abrirAvisos(true); if (el.avisos.scrollIntoView) el.avisos.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (a === 'sclose') return closeSheet();
      if (a === 'close') return closeDetail();
      if (a === 'undo') { el.toast.hidden = true; return undo(); }
      if (a === 'reopt') return reoptimizar();
      if (a === 'goto') {
        closeSheet();
        const k = act.dataset.k;
        if (k === 'risk' || k === 'wait') { const r = D.routes.find((x) => (k === 'risk' ? x.status === 'risk' : x.type === 'llegada' && (x.wait || 0) > LLE_ESPERA_LARGA)); if (r) verRuta(r.id); return; }
        const box = k === 'nodriver' ? el.drivers : el.avisos;
        if (box === el.avisos) abrirAvisos(true);
        if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (a === 'hechas') { ui.verHechas = !ui.verHechas; return renderList(); }
      if (a === 'nav') return cambiarDia(Number(act.dataset.dir) || 0);
      if (a === 'reintentar') { e.preventDefault(); return reintentar(); }
      if (a === 'vista') return aVista(act.dataset.v);
      return;
    }
    // Una vuelta pegada (sin data-id) no se abre en el detalle: sus botones son suyos.
    const row = t.closest('.rv2-row[data-id]');
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
    const row = ae.closest && ae.closest('.rv2-row[data-id]');
    if (row && ae === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(row.dataset.id); return; }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !el.detail.classList.contains('is-open')) {
      const rows = $$('.rv2-row[data-id]', r); if (!rows.length) return;
      e.preventDefault();
      let i = rows.findIndex((x) => x.dataset.id === ui.sel);
      i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      const id = rows[i].dataset.id;
      select(id, { open: false });
      const nr = $$('.rv2-row[data-id]', r).find((x) => x.dataset.id === id); if (nr) { nr.focus(); if (nr.scrollIntoView) nr.scrollIntoView({ block: 'nearest' }); }
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
    delegar: openDelegar,   // 0131: «Delegar a…» (lo usa la ruta de Julián)
    enrutar, _planEnrutar: planEnrutar,   // 28-oct
    // 0152: «Ver otras opciones» de la tarjeta del detector de cadena: la hoja
    // «Conductor de esta vuelta» de la vuelta publicada (raId), si está en el día cargado.
    abrirVuelta: (raId) => {
      if (!D || !D.byId || !raId) return false;
      const r = Object.values(D.byId).find((x) => { const l = x && rtLaneOf(x.id); return l && l.raId === raId; });
      if (!r) return false;
      openAssignVuelta(r.id);
      return true;
    },
    // 0152: «Pasar a X» desde la tarjeta ya publicó esa vuelta en la base: el tablero
    // abierto lo refleja como lo hace «Guardar y publicar» (publicarVuelta), para que
    // un «Publicar» después no le devuelva la vuelta al conductor de antes.
    reflejar: (raId, pid) => {
      if (!D || !D.byId || !raId || !pid) return false;
      const r = Object.values(D.byId).find((x) => { const l = x && rtLaneOf(x.id); return l && l.raId === raId; });
      if (!r) return false;
      const limpio = publicado() && firmaActual() === rt.firmaPublicada;
      setVueltaDriver(r.id, pid, true);
      if (limpio) rt.firmaPublicada = firmaActual();
      hist.length = 0;
      render();
      return true;
    },
    pegadas: () => (ui.manual && ui.manual.vueltas) || [],   // 0145: «Cambiar hora» busca aquí su vuelta
    // 27-oct-2026: la ruta pegada entra al tablero (meterPegado) y se publica con la hoja de siempre.
    meterPegado, guardarPegado, abrirPublicar: () => openPublish(), _pegadoPendiente: pegadoPendiente,
    pendientesDelTablero, pasarASola,   // 27-oct-2026 (2ª): rearmar el día al pegar · una vuelta sola
    _ui: ui, _hist: hist, dia: () => D, medir, sugerencia: (id) => sugerencia(D && D.byId[id]), candidatas, _mover: moveCrew,
    _avisos: () => avisosDe(), _sacar: sacarDeRuta,
    _refrescarFines: refrescarFines,   // 0137 (pruebas)
    _plazoCarga: (ms) => { PLAZO_CARGA_MS = ms; },   // pruebas: el plazo de cada etapa de la carga
  };
})();
