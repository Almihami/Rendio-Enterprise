// admin-rutas.js — Admin: Asignación de rutas de auxiliares + asignador real (sectores, cupo, deadline).
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ---------------- ASIGNACIÓN (planeación de rutas) ----------------
  // Base de los carros y aeropuerto (coords reales del Oriente antioqueño).
  const RT_DEPOT = { lat: 6.1537, lng: -75.3738 };   // Plaza de la Libertad, Rionegro (base)
  const RT_AIRPORT = { lat: 6.1659, lng: -75.4239 }; // MDE José María Córdova (geocodificado OSM)
  // DEMO = ESCENARIO REAL de un día completo (dado por la operación, 2026-07-10):
  // 2 carros, oleadas de ~2am a ~11pm. Cada oleada comparte un "deben estar"
  // (deadline). Coords: lugares reales OSM donde existen; los condominios que
  // OSM no conoce llevan coordenadas aproximadas del corredor (marcadas ±).
  // Las oleadas de la tarde/noche (13:40+) son inventadas para cubrir el día.
  const RT_DEMO_AUX = {
    // ---- deben estar 03:05 (van a hotel y aeropuerto) ----
    b1: { n: 'Cami Vélez', zona: 'Marinilla', dir: 'Parque principal de Marinilla', lat: 6.1736, lng: -75.3347, dl: '03:05', pax: 1, type: 'sal' },
    b2: { n: 'Yerly', zona: 'Manzanillos', dir: 'Manzanillos, vía Marinilla ±', lat: 6.1680, lng: -75.3550, dl: '03:05', pax: 1, type: 'sal', hotel: true },
    // ---- deben estar 03:50 ----
    b3: { n: 'Ana Lucía', zona: 'El Plantío', dir: 'Cond. El Plantío, Llanogrande ±', lat: 6.1330, lng: -75.4010, dl: '03:50', pax: 1, type: 'sal' },
    b4: { n: 'Gaitán', zona: 'Arándanos', dir: 'Cond. Arándanos, Llanogrande ±', lat: 6.1290, lng: -75.4120, dl: '03:50', pax: 1, type: 'sal' },
    b5: { n: 'Ana Upe', zona: 'Solare', dir: 'Solare, vía aeropuerto ±', lat: 6.1580, lng: -75.4180, dl: '03:50', pax: 1, type: 'sal' },
    // ---- deben estar 04:10 ----
    b6: { n: 'Tapias', zona: 'Santa Teresa', dir: 'Cond. Santa Teresa ±', lat: 6.1450, lng: -75.3900, dl: '04:10', pax: 1, type: 'sal' },
    b7: { n: 'Yolanda', zona: 'Comando', dir: 'Comando de Policía · Calle 44 (OSM)', lat: 6.1504, lng: -75.3905, dl: '04:10', pax: 1, type: 'sal' },
    b8: { n: 'Daniela Hin', zona: 'El Tejo', dir: 'Cond. El Tejo ±', lat: 6.1500, lng: -75.3660, dl: '04:10', pax: 1, type: 'sal' },
    // ---- debe estar 04:50 ----
    b9: { n: 'Rico', zona: 'Cámbulos', dir: 'Cond. Cámbulos, vía Llanogrande ±', lat: 6.1360, lng: -75.4060, dl: '04:50', pax: 1, type: 'sal' },
    // ---- deben estar 06:24 ----
    b10: { n: 'Sara Londoño', zona: 'Olivar', dir: 'Cond. Olivar, Llanogrande ±', lat: 6.1310, lng: -75.4160, dl: '06:24', pax: 1, type: 'sal' },
    b11: { n: 'Sara Jara', zona: 'Quintas', dir: 'Cond. Quintas ±', lat: 6.1600, lng: -75.3760, dl: '06:24', pax: 1, type: 'sal' },
    b12: { n: 'Nicol', zona: 'Cámbulos', dir: 'Cond. Cámbulos, vía Llanogrande ±', lat: 6.1365, lng: -75.4055, dl: '06:24', pax: 1, type: 'sal' },
    // ---- deben estar 06:50 ----
    b13: { n: 'Angelly', zona: 'Olivar', dir: 'Cond. Olivar, Llanogrande ±', lat: 6.1305, lng: -75.4165, dl: '06:50', pax: 1, type: 'sal' },
    b14: { n: 'Lady', zona: 'Solare', dir: 'Solare, vía aeropuerto ±', lat: 6.1585, lng: -75.4175, dl: '06:50', pax: 1, type: 'sal' },
    // ---- debe estar 07:50 ----
    b15: { n: 'Ana Vélez', zona: 'El Rosal', dir: 'Vereda El Rosal (OSM)', lat: 6.1412, lng: -75.3640, dl: '07:50', pax: 1, type: 'sal' },
    // ---- debe estar 09:00 ----
    b16: { n: 'Kriss', zona: 'Campus', dir: 'Universidad Católica de Oriente (OSM)', lat: 6.1508, lng: -75.3666, dl: '09:00', pax: 1, type: 'sal' },
    // ---- deben estar 09:30 ----
    b17: { n: 'Sara Valencia', zona: 'Av. 33', dir: 'Avenida 33, centro ±', lat: 6.1560, lng: -75.3720, dl: '09:30', pax: 1, type: 'sal' },
    b18: { n: 'Cami R', zona: 'Arándanos', dir: 'Cond. Arándanos, Llanogrande ±', lat: 6.1292, lng: -75.4118, dl: '09:30', pax: 1, type: 'sal' },
    b19: { n: 'Michel', zona: 'Riovivo', dir: 'Cond. Riovivo, Llanogrande ±', lat: 6.1230, lng: -75.4180, dl: '09:30', pax: 1, type: 'sal' },
    // ---- debe estar 10:30 ----
    b20: { n: 'Núñez', zona: 'Vía Llanogrande', dir: 'Finca P-57615, vía Llanogrande ±', lat: 6.1350, lng: -75.4230, dl: '10:30', pax: 1, type: 'sal' },
    // ---- deben estar 11:10 (van a hotel) ----
    b21: { n: 'Jesús Taborda', zona: 'Llanogrande', dir: 'Mall Llanogrande (OSM)', lat: 6.1257, lng: -75.4191, dl: '11:10', pax: 1, type: 'sal', hotel: true },
    b22: { n: 'Polo', zona: 'Guayacán', dir: 'Cond. Guayacán, Llanogrande ±', lat: 6.1280, lng: -75.4090, dl: '11:10', pax: 1, type: 'sal', hotel: true },
    // ---- TARDE/NOCHE (inventadas para cubrir hasta las 11pm) ----
    b23: { n: 'Valeria O.', zona: 'San Antonio de Pereira', dir: 'Estación San Antonio · Calle 24 (OSM)', lat: 6.1303, lng: -75.3803, dl: '13:40', pax: 1, type: 'sal' },
    b24: { n: 'Pablo H.', zona: 'Comfama', dir: 'Parque Recreativo Comfama (OSM)', lat: 6.1383, lng: -75.3807, dl: '13:40', pax: 1, type: 'sal' },
    b25: { n: 'Mónica T.', zona: 'Olivar', dir: 'Cond. Olivar, Llanogrande ±', lat: 6.1308, lng: -75.4162, dl: '16:20', pax: 1, type: 'sal' },
    b26: { n: 'Julián V.', zona: 'Arándanos', dir: 'Cond. Arándanos, Llanogrande ±', lat: 6.1288, lng: -75.4122, dl: '16:20', pax: 1, type: 'sal' },
    b27: { n: 'Rosa M.', zona: 'Cuatro Esquinas', dir: 'Estación Cuatro Esquinas · Calle 42 (OSM)', lat: 6.1532, lng: -75.3630, dl: '16:20', pax: 1, type: 'sal' },
    b28: { n: 'Esteban R.', zona: 'Quintas', dir: 'Cond. Quintas ±', lat: 6.1602, lng: -75.3758, dl: '19:15', pax: 1, type: 'sal' },
    b29: { n: 'Carol D.', zona: 'El Tejo', dir: 'Cond. El Tejo ±', lat: 6.1498, lng: -75.3662, dl: '19:15', pax: 1, type: 'sal' },
    b30: { n: 'Óscar L.', zona: 'Solare', dir: 'Solare, vía aeropuerto ±', lat: 6.1582, lng: -75.4178, dl: '22:40', pax: 1, type: 'sal', hotel: true },
    b31: { n: 'Diana C.', zona: 'Marinilla', dir: 'Parque principal de Marinilla', lat: 6.1736, lng: -75.3349, dl: '22:40', pax: 1, type: 'sal', hotel: true },
  };
  const RT_PALETTE = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#E2551A', '#DB4B7A', '#5B8A2B', '#B45309', '#4F46E5', '#0D9488', '#9D174D'];
  const RT_DEMO_COLORS = {};
  Object.keys(RT_DEMO_AUX).forEach((id, i) => { RT_DEMO_COLORS[id] = RT_PALETTE[i % RT_PALETTE.length]; });
  const RT_DEMO_CARS = [
    // Escenario real: 2 carros corriendo todo el día (disponibles desde la 01:30).
    { id: 'RD-01', avail0: '01:30', driver: null, capacity: 4 },
    { id: 'RD-02', avail0: '01:30', driver: null, capacity: 4 },
  ];
  const RT_DEMO_DRIVERS = [
    { id: 'd1', n: 'Carlos Roldán', turno: 'Mañana', c: '#2563A8' },
    { id: 'd2', n: 'Jefferson Cardona', turno: 'Mañana', c: '#7C5CD6' },
    { id: 'd3', n: 'Daniel Álvarez', turno: 'Mañana', c: '#16936A' },
    { id: 'd4', n: 'Juan Mery', turno: 'Mañana', c: '#0EA5E9' },
  ];

  const rt = {
    aux: {}, colors: {}, cars: [], drivers: [], plan: {},
    // MULTI-VIAJE: cada carro hace varias vueltas al día. Un "lane" = un viaje
    // (carro + vuelta + hora de salida + origen). rt.order se indexa por lane.id.
    lanes: [], order: {}, pool: [], optimized: false, drawerCar: null, pendingDriver: null,
    tripType: 'sal', source: 'demo', bound: false, demoToasted: false,
    CAP: 4, AIRPORT_LEG: 16, MARGIN_TIGHT: 15, dragId: null, dragSrc: null,
    // ---- Modelo de tiempos (todo parametrizable desde Ajustes/app_settings) ----
    SERVICE_MIN: 4,      // min por parada: frenar, timbrar, subir gente y maletas
    AIRPORT_BUFFER: 10,  // min de colchón al entregar: bajar maletas + entrar a tiempo
    TRAFFIC_FACTOR: 1.25,// multiplica el tiempo de manejo (OSRM da flujo libre, sin tráfico)
    TURNAROUND: 8,       // min en MDE entre entregar y arrancar la siguiente vuelta
    CUSHION: 15,         // min extra de margen al programar la salida de cada vuelta
    etaSource: null,     // 'osrm' | 'haversine' — de dónde salieron los tiempos
    M: null, // matriz de tiempos reales (min) entre depot/aeropuerto/paradas (OSRM o haversine)
  };

  function rtCfg() {
    const s = state.settings || {};
    rt.CAP = Number(s.route_default_capacity) || 4;
    rt.AIRPORT_LEG = Number(s.route_airport_leg_min) || 16;
    rt.MARGIN_TIGHT = Number(s.route_margin_tight_min) || 15;
    rt.SERVICE_MIN = Number(s.route_service_min) || 4;
    rt.AIRPORT_BUFFER = Number(s.route_airport_buffer_min) || 10;
    rt.TRAFFIC_FACTOR = Number(s.route_traffic_factor) || 1.25;
    rt.TURNAROUND = Number(s.route_turnaround_min) || 8;
    rt.CUSHION = Number(s.route_depart_cushion_min) || 15;
  }

  async function rtLoad() {
    rtCfg();
    let loaded = null;
    try { if (Api.listRoutePlanning) loaded = await Api.listRoutePlanning(rt.tripType); }
    catch (e) { loaded = null; }
    if (loaded && loaded.aux && Object.keys(loaded.aux).length) {
      rt.aux = loaded.aux; rt.colors = loaded.colors || {}; rt.cars = loaded.cars || [];
      rt.drivers = loaded.drivers || []; rt.plan = loaded.plan || {}; rt.source = 'live';
    } else {
      rt.aux = JSON.parse(JSON.stringify(RT_DEMO_AUX)); rt.colors = RT_DEMO_COLORS;
      rt.cars = JSON.parse(JSON.stringify(RT_DEMO_CARS)); rt.drivers = RT_DEMO_DRIVERS;
      rt.plan = {}; rt.source = 'demo';
    }
    // Estado inicial: una vuelta vacía por carro; todos los auxiliares en el pool.
    rt.lanes = rt.cars.map(c => ({ id: `${c.id}·V1`, car: c.id, vuelta: 1, start: c.avail0 || '02:00', origin: 'depot' }));
    rt.order = {}; rt.lanes.forEach(l => { rt.order[l.id] = []; });
    rt.pool = Object.keys(rt.aux);
    rt.optimized = false;
    rt.M = null;
  }
  const rtCarOf = (lane) => rt.cars.find(c => c.id === lane.car);
  const rtLaneOf = (laneId) => rt.lanes.find(l => l.id === laneId);

  const rtCapOf = (car) => (car && car.capacity) || rt.CAP;

  // Coordenadas de un punto (depot / aeropuerto / parada).
  function rtCoordsOf(key) {
    if (key === 'depot') return RT_DEPOT;
    if (key === 'airport') return RT_AIRPORT;
    const a = rt.aux[key];
    return (a && a.lat != null) ? { lat: a.lat, lng: a.lng } : null;
  }
  // Tiempo aprox por carretera (min) entre 2 coords (respaldo si no hay OSRM).
  function rtHaversineMin(a, b) {
    if (!a || !b) return 8;
    const R = 6371, toR = x => x * Math.PI / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(s)) * 1.4; // ×1.4 factor de desvío de vías
    return Math.max(2, km / 30 * 60); // ~30 km/h promedio en el Oriente
  }
  // Tiempo de un tramo: usa la matriz real (OSRM) si está; si no, haversine.
  // Se multiplica por TRAFFIC_FACTOR: OSRM devuelve flujo libre (sin tráfico,
  // sin lluvia, sin madrugada); el factor lo aterriza. Prioridad #1 = nunca tarde.
  function rtLegMin(aKey, bKey) {
    const raw = (rt.M && rt.M[aKey] && rt.M[aKey][bKey] != null)
      ? rt.M[aKey][bKey]
      : rtHaversineMin(rtCoordsOf(aKey), rtCoordsOf(bKey));
    return raw * rt.TRAFFIC_FACTOR;
  }

  // Evalúa una VUELTA (lane): ETAs por parada, llegada a MDE, holgura y estado.
  function rtCarCompute(laneId) {
    const lane = rtLaneOf(laneId);
    let t = rtToMin(lane.start), prev = lane.origin, stops = [], pax = 0, hardDL = Infinity;
    rt.order[laneId].forEach(id => {
      t += rtLegMin(prev, id); pax += rt.aux[id].pax;
      stops.push({ id, eta: Math.round(t) }); // ETA = cuando el carro LLEGA a la parada
      t += rt.SERVICE_MIN; // subir gente + maletas antes de arrancar al siguiente
      hardDL = Math.min(hardDL, rtToMin(rt.aux[id].dl));
      prev = id;
    });
    const arrival = rt.order[laneId].length ? Math.round(t + rtLegMin(prev, 'airport')) : null;
    // Holgura contra el deadline DESCONTANDO el colchón de entrega (bajar
    // maletas + entrar): llegar "justo" a la hora de presentación ES tarde.
    const holg = arrival != null ? hardDL - arrival - rt.AIRPORT_BUFFER : null;
    let status = 'empty';
    if (arrival != null) status = holg < 0 ? 'late' : (holg < rt.MARGIN_TIGHT ? 'tight' : 'ontime');
    // Hora de salida recomendada: lo más tarde que puede arrancar esta vuelta
    // y aún entregar con colchón — la palanca del despachador.
    const depart = arrival != null ? hardDL - rt.AIRPORT_BUFFER - (arrival - rtToMin(lane.start)) : null;
    return { stops, pax, arrival, hardDL, holg, status, depart };
  }

  function rtDayStats() {
    let rut = 0, onTime = 0, routes = 0, late = 0;
    rt.lanes.forEach(l => { const r = rtCarCompute(l.id); rut += rt.order[l.id].length; if (r.status !== 'empty') { routes++; if (r.status !== 'late') onTime++; else late++; } });
    return { rut, onTime, routes, late };
  }

  // ---- Solver real: matriz de tiempos + agrupar por sector + mejor orden ----
  // Construye la matriz de tiempos (min) entre depot, aeropuerto y todas las
  // paradas. Intenta OSRM (tiempos reales por carretera); si falla, haversine.
  async function rtBuildMatrix() {
    const keys = ['depot', 'airport', ...Object.keys(rt.aux)];
    const pts = keys.map(rtCoordsOf);
    try {
      const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
      const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
      const j = await (await fetch(url)).json();
      if (j.code === 'Ok' && j.durations) {
        const M = {};
        keys.forEach((ka, i) => { M[ka] = {}; keys.forEach((kb, jx) => { const s = j.durations[i][jx]; M[ka][kb] = (s == null) ? rtHaversineMin(pts[i], pts[jx]) : Math.max(1, s / 60); }); });
        rt.M = M; return 'osrm';
      }
    } catch (e) { /* cae a haversine */ }
    const M = {};
    keys.forEach((ka, i) => { M[ka] = {}; keys.forEach((kb, jx) => { M[ka][kb] = (i === jx) ? 0 : rtHaversineMin(pts[i], pts[jx]); }); });
    rt.M = M; return 'haversine';
  }

  // Todas las permutaciones (paradas ≤4 → ≤24, trivial).
  function rtPermutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => { const rest = arr.slice(0, i).concat(arr.slice(i + 1)); rtPermutations(rest).forEach(p => out.push([x, ...p])); });
    return out;
  }
  // Coherencia geográfica: cuántas veces la ruta SALE de un sector y luego
  // VUELVE a él (San Antonio → Abreo → San Antonio = 1 reentrada). A igualdad
  // práctica de tiempo, la ruta que no zigzaguea es más clara para el
  // conductor y más robusta ante tráfico real.
  function rtZoneReentries(perm) {
    const runs = []; let prev = null;
    perm.forEach(id => { const z = rt.aux[id].zona; if (z !== prev) { runs.push(z); prev = z; } });
    const seen = {}; let re = 0;
    runs.forEach(z => { seen[z] = (seen[z] || 0) + 1; if (seen[z] > 1) re++; });
    return re;
  }
  // Mejor orden de recogida de un carro (fuerza bruta = exacto para ≤4 paradas):
  // 1º minimiza el tiempo depot → paradas → aeropuerto; 2º entre órdenes
  // empatadas en la práctica (≤2 min o 6% del mejor), gana la de MENOS
  // reentradas de sector — el cronómetro no distingue 6 segundos, la operación sí.
  // El tiempo de servicio por parada es constante (mismas paradas en toda
  // permutación), así que no afecta cuál orden gana — no se suma aquí.
  function rtBestOrder(ids, origin = 'depot') {
    if (ids.length <= 1) return ids.slice();
    const scored = rtPermutations(ids).map(perm => {
      let t = 0, prev = origin;
      perm.forEach(id => { t += rtLegMin(prev, id); prev = id; });
      t += rtLegMin(prev, 'airport');
      return { perm, t };
    });
    const best = Math.min(...scored.map(s => s.t));
    const tol = Math.max(2, best * 0.06);
    return scored
      .filter(s => s.t <= best + tol)
      .sort((a, b) => (rtZoneReentries(a.perm) - rtZoneReentries(b.perm)) || (a.t - b.t))[0].perm;
  }
  // Evalúa un carro (lista de paradas): mejor ruta → llegada al aeropuerto,
  // deadline más exigente y minutos de atraso (0 si llega a tiempo).
  function rtRouteEval(carStart, ids, origin = 'depot') {
    if (!ids.length) return { arrival: null, minDL: Infinity, late: 0 };
    const ord = rtBestOrder(ids, origin);
    let t = carStart, prev = origin;
    ord.forEach(id => { t += rtLegMin(prev, id) + rt.SERVICE_MIN; prev = id; });
    const arrival = t + rtLegMin(prev, 'airport');
    const minDL = Math.min(...ids.map(id => rtToMin(rt.aux[id].dl)));
    // "Tarde" = no alcanza el deadline con el colchón de entrega incluido.
    return { arrival, minDL, late: Math.max(0, arrival + rt.AIRPORT_BUFFER - minDL) };
  }
  // ---- Solver MULTI-VIAJE ----
  // La unidad real de trabajo es la OLEADA: un grupo con el mismo "deben estar".
  // Cada carro hace varias vueltas al día; el solver asigna cada viaje al carro
  // disponible que pueda salir a tiempo, balanceando la carga entre los dos.
  function rtTripDur(ids, origin) {
    // duración del viaje (manejo + servicio por parada), independiente de la hora
    return rtRouteEval(0, ids, origin).arrival;
  }
  function rtSolveDay() {
    // 1) OLEADAS: agrupar por deadline ("deben estar"), en orden cronológico.
    const byDL = {};
    Object.keys(rt.aux).forEach(id => { (byDL[rt.aux[id].dl] = byDL[rt.aux[id].dl] || []).push(id); });
    const waves = Object.entries(byDL).map(([dl, ids]) => ({ dlMin: rtToMin(dl), ids }))
      .sort((a, b) => a.dlMin - b.dlMin);
    // 2) VIAJES: partir oleadas más grandes que el cupo (agrupando por sector).
    const capMax = Math.max(...rt.cars.map(rtCapOf));
    const trips = [];
    waves.forEach(w => {
      const ids = w.ids.slice().sort((a, b) => rt.aux[a].zona.localeCompare(rt.aux[b].zona));
      for (let i = 0; i < ids.length; i += capMax) trips.push({ dlMin: w.dlMin, ids: ids.slice(i, i + capMax) });
    });
    // 3) ASIGNAR cada viaje (cronológico) al mejor carro:
    //    - factible primero (puede salir a más tardar en "sal máx")
    //    - entre factibles, el que MENOS vueltas lleva (balancea la carga)
    const cs = rt.cars.map(c => ({ car: c, avail: rtToMin(c.avail0 || '01:30'), vuelta: 0, atMDE: false }));
    const lanes = [], order = {}, unassigned = [];
    trips.forEach(tr => {
      let best = null;
      cs.forEach(s => {
        const origin = s.atMDE ? 'airport' : 'depot';
        const dur = rtTripDur(tr.ids, origin);
        const salmax = tr.dlMin - rt.AIRPORT_BUFFER - dur;
        const depart = Math.max(s.avail, salmax - rt.CUSHION);
        const late = Math.max(0, depart - salmax);
        const key = late * 100000 + s.vuelta * 1000 + s.avail; // factible → balance → quien lleve más rato libre
        if (!best || key < best.key) best = { key, s, origin, depart, late, dur };
      });
      if (!best || best.late > 15) { unassigned.push(...tr.ids); return; }
      const s = best.s; s.vuelta++;
      const lane = { id: `${s.car.id}·V${s.vuelta}`, car: s.car.id, vuelta: s.vuelta, start: rtToHM(best.depart), origin: best.origin };
      lanes.push(lane);
      order[lane.id] = rtBestOrder(tr.ids, best.origin);
      // tras entregar queda en MDE, disponible para la siguiente vuelta
      s.avail = best.depart + best.dur + rt.TURNAROUND;
      s.atMDE = true;
    });
    return { lanes, order, unassigned };
  }

  function rtAuxCard(id) {
    const a = rt.aux[id];
    const tt = a.hotel ? 'hotel' : a.type;
    const ttl = a.hotel ? 'Hotel' : (a.type === 'sal' ? 'Salida' : 'Llegada');
    return `<div class="aux" draggable="true" data-aux="${id}" data-src="pool" title="${a.dir || a.zona}">
      <span class="pax">${a.pax > 1 ? '×' + a.pax : ''}</span>
      <div class="a-top"><span class="a-av" style="background:${rt.colors[id] || '#888'}">${rtIni(a.n)}</span>
        <div class="a-nm"><b>${a.n}</b><span>${a.zona}</span></div></div>
      <div class="a-meta">
        <span class="triptype ${tt}"><svg class="icon"><use href="#${a.hotel ? 'i-home' : 'i-up'}"/></svg>${ttl}</span>
        <span class="dl hard"><svg class="icon"><use href="#i-clock"/></svg>${a.dl}</span>
      </div></div>`;
  }

  function rtRenderPool() {
    $('#rt-poolCount').textContent = rt.pool.length;
    $('#rt-dsTotal').textContent = Object.keys(rt.aux).length;
    const list = $('#rt-poolList');
    if (!rt.pool.length) list.innerHTML = `<div class="pool-empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><b>Todos ruteados</b><span>Cada auxiliar está en un carro.</span></div>`;
    else list.innerHTML = rt.pool.map(rtAuxCard).join('');
  }

  function rtStopHTML(cid, s, idx) {
    const a = rt.aux[s.id];
    const overDL = s.eta > rtToMin(a.dl);
    const p = a.n.split(' ');
    return `<div class="stop ${overDL ? 'over-dl' : ''}" draggable="true" data-aux="${s.id}" data-src="${cid}" title="${a.dir || a.zona}">
      <div class="s-top"><span class="s-n">${idx + 1}</span><span class="s-av" style="background:${rt.colors[s.id] || '#888'}">${rtIni(a.n)}</span><span class="s-nm">${p[0]} ${p[1] ? p[1][0] + '.' : ''}</span></div>
      <div class="s-meta"><span class="s-zona">${a.zona}</span><span class="s-eta">${rtToHM(s.eta)}</span></div>
      <div class="s-dl"><svg class="icon" style="width:10px;height:10px"><use href="#i-clock"/></svg>pres. ${a.dl}${a.pax > 1 ? ' · ×' + a.pax : ''}</div>
    </div>`;
  }

  function rtLaneHTML(lane) {
    const car = rtCarOf(lane);
    const r = rtCarCompute(lane.id);
    const st = r.status;
    const capFull = r.pax >= rtCapOf(car);
    const pips = Array.from({ length: rtCapOf(car) }, (_, i) => `<span class="pip ${i < r.pax ? 'f' : ''}"></span>`).join('');
    const drv = car.driver ? rt.drivers.find(d => d.id === car.driver) : null;
    const drvHTML = drv
      ? `<span class="drv set"><span class="av" style="background:${drv.c}">${rtIni(drv.n)}</span>${drv.n}</span>`
      : `<span class="drv none"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Sin conductor (borrador)</span>`;
    const sema = st === 'empty'
      ? `<span class="spill empty">Vacío</span>`
      : st === 'late'
        ? `<div class="holg"><div class="big" style="color:var(--red)">${Math.abs(Math.round(r.holg))} min tarde</div><div class="sm">llega ${rtToHM(r.arrival)} · pres. ${rtToHM(r.hardDL)} · <b>sal ${rtToHM(r.depart)}</b></div></div><span class="spill late"><svg class="icon"><use href="#i-warn"/></svg>No llega</span>`
        : st === 'tight'
          ? `<div class="holg"><div class="big" style="color:var(--amber)">+${Math.round(r.holg)} min</div><div class="sm">llega ${rtToHM(r.arrival)} · pres. ${rtToHM(r.hardDL)} · sal máx ${rtToHM(r.depart)}</div></div><span class="spill tight"><svg class="icon"><use href="#i-clock"/></svg>Ajustado</span>`
          : `<div class="holg"><div class="big" style="color:var(--green)">+${Math.round(r.holg)} min</div><div class="sm">llega ${rtToHM(r.arrival)} · pres. ${rtToHM(r.hardDL)} · sal máx ${rtToHM(r.depart)}</div></div><span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`;
    let body;
    if (!rt.order[lane.id].length) {
      body = `<div class="lane-empty" data-drop="${lane.id}"><svg class="icon"><use href="#i-arrow"/></svg>Arrastra auxiliares aquí para armar la ruta de ${car.id}.</div>`;
    } else {
      const stops = r.stops.map((s, i) => rtStopHTML(lane.id, s, i)).join('<span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span>');
      const apt = `<span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span><div class="airport ${st}"><svg class="icon"><use href="#i-plane"/></svg><b>MDE</b><span class="arr">${rtToHM(r.arrival)}</span></div>`;
      body = `<div class="seq" data-drop="${lane.id}">${stops}${apt}</div>`;
    }
    const assignBtn = rt.order[lane.id].length
      ? `<button class="mapbtn" data-map="${lane.id}" title="Ver el trayecto real por carretera"><svg class="icon" style="width:14px;height:14px"><use href="#i-route"/></svg>Trayecto</button>
         <button class="assignbtn ${!car.driver ? 'cta' : ''}" data-assign="${lane.id}"><svg class="icon" style="width:14px;height:14px"><use href="#i-user"/></svg>${car.driver ? 'Cambiar conductor' : 'Asignar conductor'}</button>`
      : '';
    // Etiqueta de la vuelta: carro · Vn · sale HH:MM (desde base o desde MDE).
    const origen = lane.origin === 'airport' ? 'desde MDE' : 'desde base';
    return `<div class="lane ${st}" data-lane="${lane.id}">
      <div class="lane-h">
        <div class="car"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
          <div class="cinfo"><b>${car.id} · Vuelta ${lane.vuelta} <span style="font-weight:600;color:var(--ink3);font-size:12px">· sale ${lane.start} ${origen}</span></b>${drvHTML}</div></div>
        <div class="cap ${capFull ? 'full' : ''}"><span class="pips">${pips}</span>${r.pax}/${rtCapOf(car)}</div>
        <div class="sema">${sema}${assignBtn}</div>
      </div>
      ${body}
    </div>`;
  }

  function rtRenderLanes() { $('#rt-laneWrap').innerHTML = rt.lanes.map(rtLaneHTML).join(''); }

  function rtRenderStats() {
    const s = rtDayStats();
    $('#rt-dsRut').querySelector('b').textContent = s.rut;
    const dt = $('#rt-dsTime');
    dt.querySelector('b').textContent = s.routes ? `${s.onTime}/${s.routes}` : '—';
    dt.className = 'ds ' + (s.routes ? (s.late ? 'bad' : (s.onTime === s.routes ? 'ok' : 'warn')) : 'ok');
    const al = $('#rt-alert');
    if (s.late > 0) { al.classList.add('show'); $('#rt-alertTx').textContent = s.late === 1 ? 'Una ruta no llega a tiempo a la hora de presentación. Reequilibra moviendo una parada a un carro con holgura.' : `${s.late} rutas no llegan a tiempo. Reequilibra moviendo paradas a carros con holgura.`; }
    else al.classList.remove('show');
    // Transparencia del modelo: de dónde salen los tiempos y con qué colchones.
    const de = $('#rt-dsEta');
    if (de) {
      const modelo = `manejo ×${rt.TRAFFIC_FACTOR} tráfico + ${rt.SERVICE_MIN} min/parada + ${rt.AIRPORT_BUFFER} min entrega`;
      if (!rt.etaSource) { de.querySelector('b').textContent = '—'; de.title = 'Pulsa Optimizar para calcular tiempos reales.'; de.className = 'ds'; }
      else if (rt.etaSource === 'osrm') { de.querySelector('b').textContent = 'OSRM'; de.title = `Tiempos por carretera real (OSRM): ${modelo}.`; de.className = 'ds ok'; }
      else { de.querySelector('b').textContent = 'Estimado'; de.title = `Sin conexión a OSRM — estimado por distancia (30 km/h, ×1.4 vías): ${modelo}.`; de.className = 'ds warn'; }
    }
  }

  function rtRenderAll() { rtRenderPool(); rtRenderLanes(); rtRenderStats(); }

  const RT_STEPS = ['Leyendo sectores de Rionegro…', 'Calculando tiempos reales por carretera…', 'Agrupando por sector y cercanía…', 'Eligiendo el mejor orden de cada carro…'];
  async function rtOptimize() {
    $('#rt-ovl').classList.add('show');
    let i = 0; $('#rt-ovlStep').textContent = RT_STEPS[0];
    const iv = setInterval(() => { i++; if (i < RT_STEPS.length) $('#rt-ovlStep').textContent = RT_STEPS[i]; }, 480);
    // Tiempos reales (OSRM) + un piso de ~900ms para que se vea el proceso.
    const [src] = await Promise.all([rtBuildMatrix(), new Promise(r => setTimeout(r, 900))]);
    rt.etaSource = src; // 'osrm' = carretera real | 'haversine' = estimado en línea recta
    const day = rtSolveDay(); // oleadas → vueltas encadenadas entre los carros
    clearInterval(iv); $('#rt-ovl').classList.remove('show');
    rt.lanes = day.lanes;
    rt.order = day.order;
    rt.pool = day.unassigned.slice();
    rt.optimized = true;
    $('#rt-optBtn').innerHTML = '<svg class="icon"><use href="#i-bolt"/></svg>Re-optimizar';
    rtRenderAll();
    const s = rtDayStats();
    const how = src === 'osrm' ? 'tiempos reales OSRM' : 'distancia estimada';
    const vueltas = rt.lanes.length;
    toast(s.late ? `${vueltas} vueltas programadas (${how}) — ${s.late} ajustada, revísala.` : `${vueltas} vueltas programadas entre ${rt.cars.length} carros (${how}). Todas llegan a tiempo.`);
  }

  function rtOpenDrawer(laneId) {
    rt.drawerCar = laneId;
    const lane = rtLaneOf(laneId);
    const car = rtCarOf(lane);
    rt.pendingDriver = car.driver;
    const r = rtCarCompute(laneId);
    const semaPill = r.status === 'late' ? `<span class="spill late"><svg class="icon"><use href="#i-warn"/></svg>No llega</span>`
      : r.status === 'tight' ? `<span class="spill tight"><svg class="icon"><use href="#i-clock"/></svg>Ajustado</span>`
      : `<span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`;
    $('#rt-drawer').innerHTML = `
      <div class="dr-h"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
        <div><b>${car.id} · Vuelta ${lane.vuelta}</b><span>Ruta en ${car.driver ? 'borrador con conductor' : 'borrador · sin conductor'}</span></div>
        <button class="x" data-rtclose><svg class="icon"><use href="#i-x"/></svg></button></div>
      <div class="dr-b">
        <div class="dsec"><h3>Resumen de la ruta</h3>
          <div class="sumcard">
            <div class="sumrow"><span class="k">Paradas</span><span class="v">${r.stops.length} · ${r.pax}/${rtCapOf(car)} pax</span></div>
            <div class="sumrow"><span class="k">Salida</span><span class="v mono">${lane.start} ${lane.origin === 'airport' ? '(desde MDE)' : '(desde base)'}</span></div>
            <div class="sumrow"><span class="k">Llegada a MDE</span><span class="v mono">${rtToHM(r.arrival)}</span></div>
            <div class="sumrow"><span class="k">Presentación más temprana</span><span class="v mono">${rtToHM(r.hardDL)}</span></div>
            <div class="sumrow hl"><span class="k">Holgura</span><span class="v">${semaPill}</span></div>
          </div>
        </div>
        <div class="dsec"><h3>Paradas en orden</h3>
          <div class="stoplist">${r.stops.map((s, i) => { const a = rt.aux[s.id]; return `<div class="sl"><span class="n">${i + 1}</span><span class="av" style="background:${rt.colors[s.id] || '#888'}">${rtIni(a.n)}</span><div class="nm"><b>${a.n}</b><span>${a.zona} · pres. ${a.dl}</span></div><span class="eta">${rtToHM(s.eta)}</span></div>`; }).join('')}</div>
        </div>
        <div class="dsec"><h3>Conductor del turno</h3>
          ${rt.drivers.length ? rt.drivers.map(d => `<div class="drv-opt ${rt.pendingDriver === d.id ? 'sel' : ''}" data-rtdrv="${d.id}">
            <span class="av" style="background:${d.c}">${rtIni(d.n)}</span>
            <div class="info"><b>${d.n}</b><span>Disponible · turno ${d.turno || 'mañana'}</span></div>
            <span class="tick"><svg class="icon" style="width:13px;height:13px"><use href="#i-check"/></svg></span>
          </div>`).join('') : '<p style="font-size:12.5px;color:var(--ink2)">No hay conductores cargados.</p>'}
        </div>
      </div>
      <div class="dr-f">
        <button class="btn ghost" data-rtclose>Cancelar</button>
        <button class="btn" data-rtconfirm><svg class="icon"><use href="#i-check"/></svg>${car.driver ? 'Actualizar' : 'Confirmar ruta'}</button>
      </div>`;
    $('#rt-scrim').classList.add('show');
    $('#rt-drawer').classList.add('show');
  }
  function rtCloseDrawer() { $('#rt-scrim').classList.remove('show'); $('#rt-drawer').classList.remove('show'); rt.drawerCar = null; }

  // ---- Previsualización del trayecto (mapa Leaflet + geometría real OSRM) ----
  const rtMap = { map: null, layer: null };
  function rtCloseMap() { $('#rt-mapOvl')?.classList.remove('show'); }
  async function rtOpenMap(laneId) {
    const r = rtCarCompute(laneId);
    if (!r.stops.length || typeof L === 'undefined') return;
    const ovl = $('#rt-mapOvl'); if (!ovl) return;
    const lane = rtLaneOf(laneId);
    $('#rt-mapTitle').textContent = `Trayecto ${lane.car} · Vuelta ${lane.vuelta}`;
    $('#rt-mapSub').textContent = `sale ${lane.start} ${lane.origin === 'airport' ? 'desde MDE' : 'desde base'} · ${r.stops.length} paradas · llega a MDE ${rtToHM(r.arrival)} (pres. ${rtToHM(r.hardDL)})`;
    ovl.classList.add('show');
    // Mapa una sola vez; capa de ruta se redibuja por carro.
    if (!rtMap.map) {
      rtMap.map = L.map('rt-mapCanvas', { zoomControl: true, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(rtMap.map);
    }
    if (rtMap.layer) { rtMap.layer.remove(); rtMap.layer = null; }
    const layer = rtMap.layer = L.layerGroup().addTo(rtMap.map);
    const originPt = lane.origin === 'airport' ? RT_AIRPORT : RT_DEPOT;
    const pts = [originPt, ...r.stops.map(s => rtCoordsOf(s.id)), RT_AIRPORT];
    // Marcadores: base, paradas numeradas (con dirección y ETA) y aeropuerto.
    const mk = (p, html, pop) => { const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(layer); if (pop) m.bindPopup(pop); return m; };
    const pin = (bg, tx) => `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font:800 12px Inter,sans-serif;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)">${tx}</div>`;
    mk(originPt, pin('#1F2937', lane.origin === 'airport' ? '✈' : 'B'), lane.origin === 'airport' ? `<b>MDE</b> · sale de entregar la vuelta anterior<br>Sale ${lane.start}` : `<b>Base</b> · Plaza de la Libertad<br>Sale ${lane.start}`);
    r.stops.forEach((s, i) => { const a = rt.aux[s.id]; mk(rtCoordsOf(s.id), pin('#E2551A', String(i + 1)), `<b>${i + 1}. ${a.n}</b><br>${a.dir || a.zona}<br>ETA ${rtToHM(s.eta)} · pres. ${a.dl}`); });
    mk(RT_AIRPORT, pin('#16936A', '✈'), `<b>MDE</b> · José María Córdova<br>Llega ${rtToHM(r.arrival)} · pres. ${rtToHM(r.hardDL)}`);
    // Geometría real por carretera (OSRM route). Si falla → línea recta punteada.
    let drew = false;
    try {
      const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
      const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)).json();
      if (j.code === 'Ok' && j.routes && j.routes[0]) {
        const line = j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        L.polyline(line, { color: '#E2551A', weight: 5, opacity: 0.85 }).addTo(layer);
        const km = (j.routes[0].distance / 1000).toFixed(1);
        $('#rt-mapSub').textContent += ` · ${km} km por carretera`;
        drew = true;
      }
    } catch (e) { /* sin red → respaldo */ }
    if (!drew) {
      L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#E2551A', weight: 4, dashArray: '8 8', opacity: 0.7 }).addTo(layer);
      $('#rt-mapSub').textContent += ' · trayecto estimado (sin OSRM)';
    }
    rtMap.map.invalidateSize();
    rtMap.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [36, 36] });
  }

  function rtBindOnce() {
    if (rt.bound) return;
    const root = $('#routes-ui');
    if (!root) return;
    rt.bound = true;

    root.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-aux]'); if (!el) return;
      rt.dragId = el.dataset.aux; rt.dragSrc = el.dataset.src;
      el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text', rt.dragId); } catch (_) {}
    });
    root.addEventListener('dragend', (e) => {
      const el = e.target.closest('[data-aux]'); if (el) el.classList.remove('dragging');
      root.querySelectorAll('.dragover').forEach(x => x.classList.remove('dragover'));
    });
    root.addEventListener('dragover', (e) => {
      if (!rt.dragId) return;
      const dz = e.target.closest('[data-drop]') || e.target.closest('.pool-list');
      if (dz) { e.preventDefault(); root.querySelectorAll('.dragover').forEach(x => { if (x !== dz) x.classList.remove('dragover'); }); dz.classList.add('dragover'); }
    });
    root.addEventListener('drop', (e) => {
      if (!rt.dragId) return;
      e.preventDefault();
      root.querySelectorAll('.dragover').forEach(x => x.classList.remove('dragover'));
      const poolDrop = e.target.closest('.pool-list');
      const laneDrop = e.target.closest('[data-drop]');
      const stopTarget = e.target.closest('.stop[data-aux]');
      const removeFromSrc = () => { if (rt.dragSrc === 'pool') rt.pool = rt.pool.filter(x => x !== rt.dragId); else rt.order[rt.dragSrc] = rt.order[rt.dragSrc].filter(x => x !== rt.dragId); };
      if (poolDrop) { if (rt.dragSrc !== 'pool') { removeFromSrc(); rt.pool.push(rt.dragId); } }
      else if (laneDrop) {
        const cid = laneDrop.dataset.drop;
        const cur = rtCarCompute(cid);
        const cap = rtCapOf(rtCarOf(rtLaneOf(cid)));
        const incoming = rt.aux[rt.dragId].pax;
        const already = rt.order[cid].includes(rt.dragId);
        if (!already && cur.pax + incoming > cap) { toast(`${cid} llegaría a ${cur.pax + incoming}/${cap} — supera la capacidad.`); rt.dragId = null; return; }
        removeFromSrc();
        if (stopTarget && stopTarget.dataset.src === cid) {
          const idx = rt.order[cid].indexOf(stopTarget.dataset.aux);
          rt.order[cid].splice(idx < 0 ? rt.order[cid].length : idx, 0, rt.dragId);
        } else { rt.order[cid].push(rt.dragId); }
      }
      rt.dragId = null; rt.dragSrc = null;
      rtRenderAll();
    });

    root.addEventListener('click', (e) => {
      if (e.target.closest('#rt-optBtn')) { rtOptimize(); return; }
      const mp = e.target.closest('[data-map]'); if (mp) { rtOpenMap(mp.dataset.map); return; }
      if (e.target.closest('[data-mapclose]') || e.target === $('#rt-mapOvl')) { rtCloseMap(); return; }
      const as = e.target.closest('[data-assign]'); if (as) { rtOpenDrawer(as.dataset.assign); return; }
      if (e.target === $('#rt-scrim') || e.target.closest('[data-rtclose]')) { rtCloseDrawer(); return; }
      const dv = e.target.closest('[data-rtdrv]'); if (dv) { rt.pendingDriver = dv.dataset.rtdrv; $('#rt-drawer').querySelectorAll('.drv-opt').forEach(o => o.classList.toggle('sel', o === dv)); return; }
      if (e.target.closest('[data-rtconfirm]')) {
        if (!rt.pendingDriver) { toast('Elige un conductor para confirmar.'); return; }
        const lane = rtLaneOf(rt.drawerCar); const car = lane && rtCarOf(lane); if (car) car.driver = rt.pendingDriver;
        const dn = ((rt.drivers.find(d => d.id === rt.pendingDriver) || {}).n || '').split(' ')[0];
        const cid = rt.drawerCar;
        if (rt.source === 'live' && Api.saveRouteAssignment) { Api.saveRouteAssignment(car, rt.order[cid], rt.pendingDriver).catch(() => {}); }
        rtCloseDrawer(); rtRenderAll(); toast(`${cid} confirmada con ${dn}.`); return;
      }
      const seg = e.target.closest('#rt-tripSeg button'); if (seg) {
        $('#rt-tripSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === seg));
        rt.tripType = seg.dataset.trip; renderRoutes();
        if (rt.tripType === 'lle') toast('Llegadas (aeropuerto→casa): hora aproximada según vuelo.');
        return;
      }
      if (e.target.closest('#rt-alertFix')) {
        const bad = rt.lanes.find(l => rtCarCompute(l.id).status === 'late');
        if (bad) { const el = root.querySelector(`[data-lane="${bad.id}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); toast(`${bad.id} no llega: sal más temprano (ver "sal máx") o mueve una parada a otra vuelta.`); }
        return;
      }
      if (e.target.closest('#rt-dayprev') || e.target.closest('#rt-daynext')) { toast('Navegación de día disponible al conectar reservas reales.'); return; }
    });
  }

  async function renderRoutes() {
    await rtLoad();
    $('#rt-optBtn').innerHTML = '<svg class="icon"><use href="#i-bolt"/></svg>Optimizar';
    $('#rt-h1').textContent = rt.tripType === 'sal' ? 'Salida matinal' : 'Llegadas del día';
    rtRenderAll();
    rtBindOnce();
    if (rt.source === 'demo' && !rt.demoToasted) { rt.demoToasted = true; toast('Mostrando datos de ejemplo. Conecta reservas reales (mig. 0040 + seed) para planear de verdad.'); }
  }
