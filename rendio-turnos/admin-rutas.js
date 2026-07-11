// admin-rutas.js — Admin: Asignación de rutas de auxiliares + asignador real (sectores, cupo, deadline).
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ---------------- ASIGNACIÓN (planeación de rutas) ----------------
  // Base de los carros y aeropuerto (coords reales del Oriente antioqueño).
  const RT_DEPOT = { lat: 6.1537, lng: -75.3738 };   // Plaza de la Libertad, Rionegro (base)
  // OJO: la coord del "aeropuerto" debe ser la ROTONDA DEL TERMINAL DE PASAJEROS
  // (acceso occidental). El punto geocodificado genérico caía del lado oriental
  // de la pista y OSRM ruteaba por la zona de carga/CACOM 5 (prohibida).
  const RT_AIRPORT = { lat: 6.1715, lng: -75.4270 }; // MDE · terminal de pasajeros (verificado vs OSRM)
  // DEMO: día completo de trabajo (~02:00 → ~23:00), 2 carros, 12 oleadas.
  // Direcciones EXACTAS de Rionegro (nomenclatura real de barrios/vías; datos
  // inventados para la demo — con reservas reales cada dirección se geocodifica).
  const RT_DEMO_AUX = {
    // ---- deben estar 03:10 ----
    b1: { n: 'Laura G.', zona: 'Centro', dir: 'Cra 51 #49-06, Centro', lat: 6.1529, lng: -75.3752, dl: '03:10', pax: 1, type: 'sal' },
    b2: { n: 'Andrés P.', zona: 'El Porvenir', dir: 'Calle 47 #59-33, B. El Porvenir', lat: 6.1468, lng: -75.3849, dl: '03:10', pax: 1, type: 'sal' },
    // ---- deben estar 04:00 ----
    b3: { n: 'Camila R.', zona: 'Cuatro Esquinas', dir: 'Cra 62 #42-18, B. Cuatro Esquinas', lat: 6.1512, lng: -75.3628, dl: '04:00', pax: 1, type: 'sal' },
    b4: { n: 'Óscar D.', zona: 'El Faro', dir: 'Calle 41 #63-27, B. El Faro', lat: 6.1489, lng: -75.3672, dl: '04:00', pax: 1, type: 'sal' },
    b5: { n: 'Melisa V.', zona: 'San Nicolás', dir: 'Cra 55 #44-12, B. San Nicolás', lat: 6.1470, lng: -75.3781, dl: '04:00', pax: 1, type: 'sal' },
    // ---- deben estar 04:40 ----
    b6: { n: 'Julio C.', zona: 'San Antonio', dir: 'Calle 24 #45-80, San Antonio de Pereira', lat: 6.1310, lng: -75.3795, dl: '04:40', pax: 1, type: 'sal' },
    b7: { n: 'Paula E.', zona: 'San Antonio', dir: 'Cra 47 #21-35, San Antonio de Pereira', lat: 6.1281, lng: -75.3811, dl: '04:40', pax: 1, type: 'sal' },
    // ---- deben estar 05:30 ----
    b8: { n: 'Marcos L.', zona: 'Llanogrande', dir: 'Vía Llanogrande km 7, P. Cerrada Los Cedros', lat: 6.1268, lng: -75.4155, dl: '05:30', pax: 1, type: 'sal' },
    b9: { n: 'Diana F.', zona: 'Llanogrande', dir: 'Calle 10B #36-44, Llanogrande', lat: 6.1249, lng: -75.4198, dl: '05:30', pax: 1, type: 'sal' },
    b10: { n: 'Simón T.', zona: 'Llanogrande', dir: 'Vía San Nicolás–La Ceja km 2', lat: 6.1180, lng: -75.4210, dl: '05:30', pax: 1, type: 'sal' },
    // ---- deben estar 06:40 ----
    b11: { n: 'Verónica S.', zona: 'Alto del Medio', dir: 'Cra 50 #58-11, B. Alto del Medio', lat: 6.1618, lng: -75.3708, dl: '06:40', pax: 1, type: 'sal' },
    b12: { n: 'Héctor M.', zona: 'Santa Ana', dir: 'Calle 62 #54-09, B. Santa Ana', lat: 6.1685, lng: -75.3745, dl: '06:40', pax: 1, type: 'sal' },
    // ---- debe estar 08:00 ----
    b13: { n: 'Natalia B.', zona: 'Centro', dir: 'Cra 48 #50-45, Centro', lat: 6.1545, lng: -75.3730, dl: '08:00', pax: 1, type: 'sal' },
    // ---- deben estar 09:20 ----
    b14: { n: 'Iván Q.', zona: 'Gualanday', dir: 'Vía Gualanday km 1', lat: 6.1620, lng: -75.3985, dl: '09:20', pax: 1, type: 'sal' },
    b15: { n: 'Rosa H.', zona: 'La Colina', dir: 'Cra 70 #38-22, B. La Colina', lat: 6.1435, lng: -75.3900, dl: '09:20', pax: 1, type: 'sal' },
    b16: { n: 'Fabián N.', zona: 'Centro', dir: 'Calle 52 #47-60, Centro', lat: 6.1560, lng: -75.3722, dl: '09:20', pax: 1, type: 'sal' },
    // ---- deben estar 11:00 ----
    b17: { n: 'Tatiana W.', zona: 'Vía Aeropuerto', dir: 'Vía Aeropuerto km 2, C. Res. Sajonia', lat: 6.1600, lng: -75.4120, dl: '11:00', pax: 1, type: 'sal' },
    b18: { n: 'Germán A.', zona: 'San Antonio', dir: 'Calle 29 #52-14, San Antonio de Pereira', lat: 6.1330, lng: -75.3790, dl: '11:00', pax: 1, type: 'sal' },
    // ---- debe estar 13:30 ----
    b19: { n: 'Lucía Z.', zona: 'San Nicolás', dir: 'Cra 56 #43-05, B. San Nicolás', lat: 6.1462, lng: -75.3790, dl: '13:30', pax: 1, type: 'sal' },
    // ---- deben estar 16:00 ----
    b20: { n: 'Ramiro J.', zona: 'Vía Llanogrande', dir: 'Vía Llanogrande km 5, P. Cerrada Guayabales', lat: 6.1310, lng: -75.4080, dl: '16:00', pax: 1, type: 'sal' },
    b21: { n: 'Claudia K.', zona: 'El Porvenir', dir: 'Calle 45 #66-30, B. El Porvenir', lat: 6.1455, lng: -75.3870, dl: '16:00', pax: 1, type: 'sal' },
    // ---- deben estar 19:30 ----
    b22: { n: 'Ernesto U.', zona: 'Centro', dir: 'Cra 51 #45-77, Centro', lat: 6.1502, lng: -75.3741, dl: '19:30', pax: 1, type: 'sal' },
    b23: { n: 'Sofía X.', zona: 'Cuatro Esquinas', dir: 'Calle 38 #58-90, B. Cuatro Esquinas', lat: 6.1500, lng: -75.3640, dl: '19:30', pax: 1, type: 'sal' },
    // ---- deben estar 22:50 (van a hotel) ----
    b24: { n: 'Bernardo Y.', zona: 'Llanogrande', dir: 'Vía Llanogrande km 9, Hotel campestre', lat: 6.1235, lng: -75.4235, dl: '22:50', pax: 1, type: 'sal', hotel: true },
    b25: { n: 'Adriana Ñ.', zona: 'Alto del Medio', dir: 'Cra 43 #61-02, B. Alto del Medio', lat: 6.1635, lng: -75.3690, dl: '22:50', pax: 1, type: 'sal', hotel: true },
    // ---- LLEGADAS (dl = hora en que ATERRIZA el vuelo; recogen en MDE → casa) ----
    l1: { n: 'Patricia D.', zona: 'San Nicolás', dir: 'Calle 43 #55-20, B. San Nicolás', lat: 6.1473, lng: -75.3778, dl: '10:40', pax: 1, type: 'lle' },
    l2: { n: 'Álvaro C.', zona: 'Centro', dir: 'Cra 51 #50-12, Centro', lat: 6.1535, lng: -75.3748, dl: '10:40', pax: 1, type: 'lle' },
    l3: { n: 'Renata O.', zona: 'San Antonio', dir: 'Calle 25 #46-11, San Antonio de Pereira', lat: 6.1315, lng: -75.3800, dl: '14:50', pax: 1, type: 'lle' },
    l4: { n: 'Gustavo M.', zona: 'Llanogrande', dir: 'Vía Llanogrande km 6', lat: 6.1290, lng: -75.4130, dl: '21:10', pax: 1, type: 'lle' },
    l5: { n: 'Elena R.', zona: 'Centro', dir: 'Cra 47 #52-30, Centro', lat: 6.1548, lng: -75.3739, dl: '21:10', pax: 1, type: 'lle' },
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
    expandedLane: null, _dragging: false, // UI: vuelta expandida en la tarjeta del carro / drag activo
    tripType: 'sal', source: 'demo', bound: false, demoToasted: false,
    CAP: 4, AIRPORT_LEG: 16, MARGIN_TIGHT: 15, dragId: null, dragSrc: null,
    // ---- Modelo de tiempos (todo parametrizable desde Ajustes/app_settings) ----
    SERVICE_MIN: 4,      // min por parada: frenar, timbrar, subir gente y maletas
    AIRPORT_BUFFER: 10,  // min de colchón al entregar: bajar maletas + entrar a tiempo
    TRAFFIC_FACTOR: 1.25,// multiplica el tiempo de manejo (OSRM da flujo libre, sin tráfico)
    TURNAROUND: 8,       // min en MDE entre entregar y arrancar la siguiente vuelta
    DEPLANE: 20,         // min entre que el vuelo aterriza y el pasajero sale (migración+maletas)
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
    rt.DEPLANE = Number(s.route_deplane_min) || 20;
    rt.CUSHION = Number(s.route_depart_cushion_min) || 15;
  }

  async function rtLoad() {
    rtCfg();
    let loaded = null;
    try { if (Api.listRoutePlanning) loaded = await Api.listRoutePlanning('all'); }
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
    rt.lanes = rt.cars.map(c => ({ id: `${c.id}·V1`, car: c.id, vuelta: 1, start: c.avail0 || '02:00', origin: null }));
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
    if (lane.type === 'lle') return rtCarComputeLle(lane);
    let t = rtToMin(lane.start), prev = lane.origin, stops = [], pax = 0, hardDL = Infinity;
    rt.order[laneId].forEach(id => {
      if (prev) t += rtLegMin(prev, id); pax += rt.aux[id].pax;
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

  // Vuelta de LLEGADA: recoge en MDE cuando el vuelo suelta a la gente y
  // reparte a las casas. El semáforo mide cuánto ESPERARÍA el pasajero.
  function rtCarComputeLle(lane) {
    let t = rtToMin(lane.start), prev = 'airport', stops = [], pax = 0;
    rt.order[lane.id].forEach(id => {
      t += rtLegMin(prev, id); pax += rt.aux[id].pax;
      stops.push({ id, eta: Math.round(t) });
      t += rt.SERVICE_MIN;
      prev = id;
    });
    const arrival = rt.order[lane.id].length ? Math.round(t) : null; // termina en la última casa
    const ideal = rtToMin(lane.landing) + rt.DEPLANE; // cuándo sale la gente del terminal
    const wait = Math.max(0, rtToMin(lane.start) - ideal);
    let status = 'empty';
    if (arrival != null) status = wait > 15 ? 'late' : (wait > 5 ? 'tight' : 'ontime');
    return { stops, pax, arrival, hardDL: ideal, holg: -wait, status, depart: ideal, wait, lle: true };
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
  // origin: 'airport' (encadenada, sale de MDE), o null → la vuelta arranca EN
  // la primera recogida (el punto de partida del conductor se define en SU
  // módulo, no aquí — decisión de la operación 2026-07-10).
  function rtBestOrder(ids, origin = null, endAtAirport = true) {
    if (ids.length <= 1) return ids.slice();
    const scored = rtPermutations(ids).map(perm => {
      let t = 0, prev = origin;
      perm.forEach(id => { if (prev) t += rtLegMin(prev, id); prev = id; });
      if (endAtAirport) t += rtLegMin(prev, 'airport');
      return { perm, t };
    });
    const best = Math.min(...scored.map(s => s.t));
    const tol = Math.max(2, best * 0.06);
    // Desempates (en orden): 1) no zigzaguear entre sectores; 2) "fluir hacia
    // el destino" — terminar en la parada más cercana al aeropuerto; 3) tiempo.
    const finalLeg = (perm) => rtLegMin(perm[perm.length - 1], 'airport');
    return scored
      .filter(s => s.t <= best + tol)
      .sort((a, b) => (rtZoneReentries(a.perm) - rtZoneReentries(b.perm))
        || (finalLeg(a.perm) - finalLeg(b.perm))
        || (a.t - b.t))[0].perm;
  }
  // Evalúa un carro (lista de paradas): mejor ruta → llegada al aeropuerto,
  // deadline más exigente y minutos de atraso (0 si llega a tiempo).
  function rtRouteEval(carStart, ids, origin = null) {
    if (!ids.length) return { arrival: null, minDL: Infinity, late: 0 };
    const ord = rtBestOrder(ids, origin);
    let t = carStart, prev = origin;
    ord.forEach(id => { if (prev) t += rtLegMin(prev, id); t += rt.SERVICE_MIN; prev = id; });
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
  // Vuelta de LLEGADA: arranca en MDE y reparte a las casas (no vuelve al aeropuerto).
  function rtHomesPlan(ids) {
    const ord = rtBestOrder(ids, 'airport', false);
    let t = 0, prev = 'airport', last = 'airport';
    ord.forEach(id => { t += rtLegMin(prev, id) + rt.SERVICE_MIN; prev = id; last = id; });
    return { ord, dur: t, last };
  }

  function rtSolveDay() {
    // TABLERO GENERAL: salidas y llegadas conviven — el carro que deja en el
    // puerto ahí mismo recoge. 1) OLEADAS: agrupar por tipo + hora (salidas:
    // "deben estar"; llegadas: hora en que aterriza el vuelo), cronológico.
    const byKey = {};
    Object.keys(rt.aux).forEach(id => { const a = rt.aux[id]; const k = a.type + '|' + a.dl; (byKey[k] = byKey[k] || []).push(id); });
    const waves = Object.entries(byKey).map(([k, ids]) => ({ type: k.split('|')[0], dlMin: rtToMin(k.split('|')[1]), ids }))
      .sort((a, b) => a.dlMin - b.dlMin);
    // 2) VIAJES: partir oleadas más grandes que el cupo (agrupando por sector).
    const capMax = Math.max(...rt.cars.map(rtCapOf));
    const trips = [];
    waves.forEach(w => {
      const ids = w.ids.slice().sort((a, b) => rt.aux[a].zona.localeCompare(rt.aux[b].zona));
      for (let i = 0; i < ids.length; i += capMax) trips.push({ type: w.type, dlMin: w.dlMin, ids: ids.slice(i, i + capMax) });
    });
    // 3) ASIGNAR cada viaje (cronológico) al mejor carro. El carro tiene POSICIÓN
    //    (null = aún no sale; 'airport' = en MDE; id de parada = última casa de
    //    una llegada) — el tramo desde donde quedó SÍ cuenta.
    const cs = rt.cars.map(c => ({ car: c, avail: rtToMin(c.avail0 || '01:30'), vuelta: 0, pos: null }));
    const lanes = [], order = {}, unassigned = [];
    trips.forEach(tr => {
      let best = null;
      if (tr.type === 'lle') {
        // LLEGADA: hay que ESTAR en MDE cuando salgan (aterriza + desembarque).
        const idealPickup = tr.dlMin + rt.DEPLANE;
        cs.forEach(s => {
          const goLeg = (s.pos && s.pos !== 'airport') ? rtLegMin(s.pos, 'airport') : 0;
          const readyAtMDE = s.avail + goLeg;
          const wait = Math.max(0, readyAtMDE - idealPickup); // min que esperaría el pasajero
          const key = wait * 100000 + s.vuelta * 1000 + s.avail;
          if (!best || key < best.key) best = { key, s, wait, pickup: Math.max(idealPickup, readyAtMDE) };
        });
        if (!best || best.wait > 15) { unassigned.push(...tr.ids); return; }
        const s = best.s; s.vuelta++;
        const plan = rtHomesPlan(tr.ids);
        const lane = { id: `${s.car.id}·V${s.vuelta}`, car: s.car.id, vuelta: s.vuelta, type: 'lle', start: rtToHM(best.pickup), origin: 'airport', landing: rtToHM(tr.dlMin) };
        lanes.push(lane);
        order[lane.id] = plan.ord;
        s.avail = best.pickup + plan.dur + 2; // termina en la última casa
        s.pos = plan.last;
        return;
      }
      // SALIDA (casa → MDE), como siempre — pero el origen es donde QUEDÓ el carro.
      cs.forEach(s => {
        const origin = s.pos; // null = arranca en la 1ª recogida; 'airport' o casa = tramo real
        const dur = rtTripDur(tr.ids, origin);
        const salmax = tr.dlMin - rt.AIRPORT_BUFFER - dur;
        const depart = Math.max(s.avail, salmax - rt.CUSHION);
        const late = Math.max(0, depart - salmax);
        const key = late * 100000 + s.vuelta * 1000 + s.avail; // factible → balance → quien lleve más rato libre
        if (!best || key < best.key) best = { key, s, origin, depart, late, dur };
      });
      if (!best || best.late > 15) { unassigned.push(...tr.ids); return; }
      const s = best.s; s.vuelta++;
      const lane = { id: `${s.car.id}·V${s.vuelta}`, car: s.car.id, vuelta: s.vuelta, type: 'sal', start: rtToHM(best.depart), origin: best.origin };
      lanes.push(lane);
      order[lane.id] = rtBestOrder(tr.ids, best.origin);
      // tras entregar queda en MDE, disponible para la siguiente vuelta
      s.avail = best.depart + best.dur + rt.TURNAROUND;
      s.pos = 'airport';
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
    // Todos ruteados → la columna se oculta (reaparece al arrastrar una parada).
    const stage = $('#routes-ui .stage');
    if (stage) stage.classList.toggle('nopool', rt.optimized && !rt.pool.length && !rt._dragging);
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
    const sema = r.lle
      ? (st === 'ontime'
        ? `<div class="holg"><div class="big" style="color:var(--green)">al bajar</div><div class="sm">aterriza ${lane.landing} · recoge ${lane.start} · termina ${rtToHM(r.arrival)}</div></div><span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`
        : `<div class="holg"><div class="big" style="color:${st === 'late' ? 'var(--red)' : 'var(--amber)'}">espera ${r.wait} min</div><div class="sm">aterriza ${lane.landing} · recoge ${lane.start} · termina ${rtToHM(r.arrival)}</div></div><span class="spill ${st}"><svg class="icon"><use href="#${st === 'late' ? 'i-warn' : 'i-clock'}"/></svg>${st === 'late' ? 'Espera larga' : 'Ajustado'}</span>`)
      : st === 'empty'
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
      // Llegadas: el chip de MDE va AL INICIO (ahí recoge); salidas: al final (ahí entrega).
      const apt = r.lle
        ? `<div class="airport lle ${st}"><svg class="icon"><use href="#i-plane"/></svg><b>MDE</b><span class="arr">${lane.start}</span></div><span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span>`
        : `<span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span><div class="airport ${st}"><svg class="icon"><use href="#i-plane"/></svg><b>MDE</b><span class="arr">${rtToHM(r.arrival)}</span></div>`;
      body = r.lle
        ? `<div class="seq" data-drop="${lane.id}">${apt}${stops}</div>`
        : `<div class="seq" data-drop="${lane.id}">${stops}${apt}</div>`;
    }
    const assignBtn = rt.order[lane.id].length
      ? `<button class="mapbtn" data-map="${lane.id}" title="Ver el trayecto real por carretera"><svg class="icon" style="width:14px;height:14px"><use href="#i-route"/></svg>Trayecto</button>
         <button class="mapbtn" data-expand="${lane.id}" title="Colapsar esta vuelta"><svg class="icon" style="width:14px;height:14px"><use href="#i-collapse"/></svg></button>`
      : '';
    // Etiqueta de la vuelta: carro · Vn · sale HH:MM (desde base o desde MDE).
    const salida = lane.type === 'lle' ? `recoge en MDE ${lane.start}` : (lane.origin === 'airport' ? `sale ${lane.start} desde MDE` : `1ª recogida ${lane.start}`);
    return `<div class="lane ${st}" data-lane="${lane.id}">
      <div class="lane-h">
        <div class="car"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
          <div class="cinfo"><b>${car.id} · Vuelta ${lane.vuelta} <span style="font-weight:600;color:var(--ink3);font-size:12px">· ${salida}</span></b>${drvHTML}</div></div>
        <div class="cap ${capFull ? 'full' : ''}"><span class="pips">${pips}</span>${r.pax}/${rtCapOf(car)}</div>
        <div class="sema">${sema}${assignBtn}</div>
      </div>
      ${body}
    </div>`;
  }

  // Fila compacta de un trayecto dentro de la tarjeta del vehículo.
  function rtTripRowHTML(lane) {
    const r = rtCarCompute(lane.id);
    const hotel = r.stops.some(x => rt.aux[x.id].hotel);
    const tipo = lane.type === 'lle' ? 'lle' : (hotel ? 'hotel' : 'sal');
    const ruta = lane.type === 'lle'
      ? `MDE ${lane.start} → ${r.stops.length} casa${r.stops.length > 1 ? 's' : ''} (${rtToHM(r.arrival)})`
      : `${lane.start} → MDE ${rtToHM(r.arrival)}`;
    const sema = r.status === 'late'
      ? `<span class="spill late"><svg class="icon"><use href="#i-warn"/></svg>${r.lle ? 'Espera larga' : 'No llega'}</span>`
      : r.status === 'tight'
        ? `<span class="spill tight"><svg class="icon"><use href="#i-clock"/></svg>Ajustado</span>`
        : `<span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`;
    const zonas = [...new Set(r.stops.map(s => rt.aux[s.id].zona))].slice(0, 3).join(', ');
    return `<div class="triprow ${r.status}" data-drop="${lane.id}" data-expand="${lane.id}" title="Toca para ver y editar las paradas">
      <span class="tr-dot ${tipo}"></span><b class="tr-v">V${lane.vuelta}</b>
      <span class="tr-time">${ruta}</span>
      <span class="tr-info">${r.stops.length}p · ${r.pax} pax · ${zonas}</span>
      ${sema}
      <button class="mapbtn sm" data-map="${lane.id}" title="Ver trayecto en el mapa"><svg class="icon" style="width:13px;height:13px"><use href="#i-route"/></svg></button>
      <svg class="icon tr-chev"><use href="#i-chev"/></svg>
    </div>`;
  }
  // Una tarjeta por VEHÍCULO: su ruta completa del día (lista de trayectos).
  function rtRenderLanes() {
    const wrap = $('#rt-laneWrap');
    wrap.innerHTML = rt.cars.map(car => {
      const lanes = rt.lanes.filter(l => l.car === car.id);
      const drv = car.driver ? rt.drivers.find(d => d.id === car.driver) : null;
      const drvHTML = drv
        ? `<span class="drv set"><span class="av" style="background:${drv.c}">${rtIni(drv.n)}</span>${drv.n}</span>`
        : `<span class="drv none"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Sin conductor</span>`;
      const paxTotal = lanes.reduce((t, l) => t + rtCarCompute(l.id).pax, 0);
      const rows = lanes.length
        ? lanes.map(l => rt.expandedLane === l.id ? rtLaneHTML(l) : rtTripRowHTML(l)).join('')
        : `<div class="lane-empty" data-drop="${car.id}·V1">Sin vueltas — pulsa Optimizar o arrastra auxiliares.</div>`;
      const assignBtn = lanes.length
        ? `<button class="assignbtn ${!car.driver ? 'cta' : ''}" data-assign="${lanes[0].id}"><svg class="icon" style="width:14px;height:14px"><use href="#i-user"/></svg>${car.driver ? 'Cambiar conductor' : 'Asignar conductor'}</button>`
        : '';
      return `<div class="carcard">
        <div class="cc-h">
          <span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
          <div class="cc-t"><b>${car.id}</b>${drvHTML}</div>
          <span class="cc-n">${lanes.length} vuelta${lanes.length === 1 ? '' : 's'} · ${paxTotal} pax</span>
          ${assignBtn}
        </div>
        <div class="cc-b">${rows}</div>
      </div>`;
    }).join('');
  }

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

  function rtRenderAll() { rtRenderPool(); rtRenderLanes(); rtRenderStats(); rtRenderClock(); }

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
            <div class="sumrow"><span class="k">${lane.origin === 'airport' ? 'Sale de MDE' : 'Primera recogida'}</span><span class="v mono">${lane.start}</span></div>
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

  // ---- RELOJ 24h DUAL (diseño /Visual/admin-clock.jsx — propuesta ganadora) ----
  // Un anillo por carro; cada vuelta es un arco (salida→llegada a MDE). Línea
  // radial = ahora. Click en un arco baja al carril de esa vuelta.
  const RT_TYPE_COLOR = { sal: '#F26522', lle: '#10B981', hotel: '#F59E0B' };
  const rtHourAngle = (min) => -Math.PI / 2 + (min / 1440) * Math.PI * 2; // 00h arriba
  let rtScrubMin = null; // aguja: null = hora actual; número = minuto "visitado" por el admin
  function rtArcPath(cx, cy, rO, rI, a1, a2) {
    const large = a2 - a1 > Math.PI ? 1 : 0;
    const p = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return `M ${p(rO, a1)} A ${rO} ${rO} 0 ${large} 1 ${p(rO, a2)} L ${p(rI, a2)} A ${rI} ${rI} 0 ${large} 0 ${p(rI, a1)} Z`;
  }
  function rtRenderClock() {
    const host = $('#rt-clock'); if (!host) return;
    const size = 560, cx = 280, cy = 280;
    const RINGS = [{ rO: 250, rI: 212 }, { rO: 202, rI: 164 }, { rO: 154, rI: 122 }]; // hasta 3 carros
    let s = `<svg viewBox="0 0 ${size} ${size}" style="width:100%;max-width:420px;overflow:visible" role="img" aria-label="Día completo de rutas">`;
    // rejilla horaria
    for (let h = 0; h < 24; h++) {
      const a = rtHourAngle(h * 60), q = h % 6 === 0;
      const r1 = 112, r2 = 258;
      s += `<line x1="${cx + r1 * Math.cos(a)}" y1="${cy + r1 * Math.sin(a)}" x2="${cx + r2 * Math.cos(a)}" y2="${cy + r2 * Math.sin(a)}" stroke="var(--line2)" stroke-width="${q ? 1.2 : 0.5}" opacity="${q ? 1 : 0.6}"/>`;
    }
    [0, 3, 6, 9, 12, 15, 18, 21].forEach(h => {
      const a = rtHourAngle(h * 60), r = 271;
      s += `<text x="${cx + r * Math.cos(a)}" y="${cy + r * Math.sin(a)}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="600" fill="var(--ink3)" font-family="var(--mono)">${String(h).padStart(2, '0')}</text>`;
    });
    // pistas de fondo (una por carro) con placa
    rt.cars.forEach((c, i) => {
      const ring = RINGS[i]; if (!ring) return;
      const rm = (ring.rO + ring.rI) / 2;
      s += `<circle cx="${cx}" cy="${cy}" r="${rm}" fill="none" stroke="var(--panel2)" stroke-width="${ring.rO - ring.rI}"/>`;
      s += `<text x="${cx}" y="${cy - rm + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--ink3)" font-family="var(--mono)" letter-spacing="1">${c.id}</text>`;
    });
    // arcos: una vuelta = salida → llegada a MDE. Si la aguja está "visitando"
    // una hora, se resaltan solo las vueltas activas en ese momento.
    const scrub = rtScrubMin;
    rt.lanes.forEach(l => {
      const i = rt.cars.findIndex(c => c.id === l.car);
      const ring = RINGS[i]; if (!ring) return;
      const r = rtCarCompute(l.id);
      if (!r.stops.length) return;
      const dep = rtToMin(l.start);
      const a1 = rtHourAngle(dep), a2 = rtHourAngle(r.arrival);
      const hotel = r.stops.some(x => rt.aux[x.id].hotel);
      const color = hotel ? RT_TYPE_COLOR.hotel : RT_TYPE_COLOR[l.type || 'sal'];
      const late = r.status === 'late';
      const activa = scrub == null || (scrub >= dep && scrub <= r.arrival);
      s += `<path d="${rtArcPath(cx, cy, ring.rO - 3, ring.rI + 3, a1, a2)}" fill="${color}" opacity="${activa ? 0.9 : 0.18}" data-arc="${l.id}" style="cursor:pointer;transition:opacity .15s">` +
           `<title>${l.car} · Vuelta ${l.vuelta} · sale ${l.start} → MDE ${rtToHM(r.arrival)} · ${r.stops.length} parada${r.stops.length > 1 ? 's' : ''} · pres. ${rtToHM(r.hardDL)}${late ? ' · NO LLEGA' : ''}</title></path>`;
      if (late) s += `<path d="${rtArcPath(cx, cy, ring.rO - 1, ring.rI + 1, a1, a2)}" fill="none" stroke="#EF4444" stroke-width="2" stroke-dasharray="4 3" pointer-events="none" transform-origin="center"/>`;
    });
    // AGUJA: por defecto marca AHORA; el admin puede ARRASTRARLA para recorrer
    // el día (resalta las vueltas activas a esa hora). Doble clic = volver a ahora.
    const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
    const needleMin = scrub != null ? scrub : nowMin;
    const na = rtHourAngle(needleMin);
    const needleColor = scrub != null ? '#F26522' : 'var(--ink)';
    s += `<line x1="${cx + 112 * Math.cos(na)}" y1="${cy + 112 * Math.sin(na)}" x2="${cx + 262 * Math.cos(na)}" y2="${cy + 262 * Math.sin(na)}" stroke="${needleColor}" stroke-width="2" stroke-linecap="round" pointer-events="none"/>`;
    s += `<circle cx="${cx + 262 * Math.cos(na)}" cy="${cy + 262 * Math.sin(na)}" r="7" fill="${needleColor}" pointer-events="none"/>`;
    // zona de agarre invisible y generosa sobre la aguja
    s += `<line x1="${cx + 100 * Math.cos(na)}" y1="${cy + 100 * Math.sin(na)}" x2="${cx + 274 * Math.cos(na)}" y2="${cy + 274 * Math.sin(na)}" stroke="rgba(0,0,0,0)" stroke-width="26" data-needle="1" style="cursor:grab"/>`;
    // centro: hora + resumen del día
    const st = rtDayStats();
    const paxTotal = rt.lanes.reduce((t, l) => t + rtCarCompute(l.id).pax, 0);
    s += `<circle cx="${cx}" cy="${cy}" r="104" fill="var(--panel)" stroke="var(--line2)"/>`;
    s += `<text x="${cx}" y="${cy - 34}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1.5" fill="${scrub != null ? '#F26522' : 'var(--ink3)'}">${scrub != null ? 'VIENDO · doble clic: ahora' : 'AHORA'}</text>`;
    s += `<text x="${cx}" y="${cy + 2}" text-anchor="middle" font-size="34" font-weight="700" fill="var(--ink)" font-family="var(--mono)">${rtToHM(needleMin)}</text>`;
    s += rt.optimized
      ? `<text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="11.5" fill="var(--ink2)">${rt.lanes.length} vueltas · ${paxTotal} aux</text>` +
        `<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-size="11.5" fill="${st.late ? '#EF4444' : '#16936A'}">${st.late ? st.late + ' no llega' : 'todas a tiempo'}</text>`
      : `<text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="11.5" fill="var(--ink3)">Pulsa Optimizar</text>` +
        `<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-size="11.5" fill="var(--ink3)">para planear el día</text>`;
    s += '</svg>';
    host.innerHTML = s;
  }

  // ---- Previsualización del trayecto (mapa Leaflet + geometría real OSRM) ----
  const rtMap = { map: null, layer: null };
  function rtCloseMap() { $('#rt-mapOvl')?.classList.remove('show'); }
  async function rtOpenMap(laneId) {
    const r = rtCarCompute(laneId);
    if (!r.stops.length || typeof L === 'undefined') return;
    const ovl = $('#rt-mapOvl'); if (!ovl) return;
    const lane = rtLaneOf(laneId);
    $('#rt-mapTitle').textContent = `Trayecto ${lane.car} · Vuelta ${lane.vuelta}`;
    $('#rt-mapSub').textContent = lane.type === 'lle'
      ? `aterriza ${lane.landing} · recoge en MDE ${lane.start} · ${r.stops.length} paradas · termina ${rtToHM(r.arrival)}`
      : `${lane.origin === 'airport' ? 'sale de MDE ' + lane.start : '1ª recogida ' + lane.start} · ${r.stops.length} paradas · llega a MDE ${rtToHM(r.arrival)} (pres. ${rtToHM(r.hardDL)})`;
    ovl.classList.add('show');
    // Mapa una sola vez; capa de ruta se redibuja por carro.
    if (!rtMap.map) {
      rtMap.map = L.map('rt-mapCanvas', { zoomControl: true, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(rtMap.map);
    }
    if (rtMap.layer) { rtMap.layer.remove(); rtMap.layer = null; }
    const layer = rtMap.layer = L.layerGroup().addTo(rtMap.map);
    // La previsualización verifica LA RUTA. Salidas: paradas → MDE (el punto de
    // partida del conductor no se dibuja). Llegadas: MDE → casas.
    const pts = r.lle ? [RT_AIRPORT, ...r.stops.map(s => rtCoordsOf(s.id))] : [...r.stops.map(s => rtCoordsOf(s.id)), RT_AIRPORT];
    // Marcadores: base, paradas numeradas (con dirección y ETA) y aeropuerto.
    const mk = (p, html, pop) => { const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(layer); if (pop) m.bindPopup(pop); return m; };
    const pin = (bg, tx) => `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font:800 12px Inter,sans-serif;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)">${tx}</div>`;
    const stopColor = r.lle ? '#10B981' : '#E2551A';
    r.stops.forEach((s, i) => { const a = rt.aux[s.id]; mk(rtCoordsOf(s.id), pin(stopColor, String(i + 1)), `<b>${i + 1}. ${a.n}</b><br>${a.dir || a.zona}<br>${r.lle ? 'Lo dejan' : 'ETA'} ${rtToHM(s.eta)}${r.lle ? '' : ' · pres. ' + a.dl}`); });
    mk(RT_AIRPORT, pin('#16936A', '✈'), r.lle ? `<b>MDE</b> · recoge ${lane.start} (aterriza ${lane.landing})` : `<b>MDE</b> · José María Córdova<br>Llega ${rtToHM(r.arrival)} · pres. ${rtToHM(r.hardDL)}`);
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
      rt._dragging = true; $('#routes-ui .stage')?.classList.remove('nopool'); // el pool reaparece para poder soltar ahí
      el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text', rt.dragId); } catch (_) {}
    });
    root.addEventListener('dragend', (e) => {
      const el = e.target.closest('[data-aux]'); if (el) el.classList.remove('dragging');
      root.querySelectorAll('.dragover').forEach(x => x.classList.remove('dragover'));
      rt._dragging = false; rtRenderPool();
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
        const lane = rtLaneOf(cid);
        if ((lane.type || 'sal') !== rt.aux[rt.dragId].type) { toast('No se mezclan salidas y llegadas en la misma vuelta.'); rt.dragId = null; return; }
        const cur = rtCarCompute(cid);
        const cap = rtCapOf(rtCarOf(lane));
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

    // Aguja del reloj arrastrable: recorre el día y resalta las vueltas activas.
    const clockMinAt = (ev) => {
      const svg = $('#rt-clock svg'); if (!svg) return null;
      const b = svg.getBoundingClientRect();
      const x = (ev.clientX - b.left) / b.width * 560 - 280;
      const y = (ev.clientY - b.top) / b.height * 560 - 280;
      let a = Math.atan2(y, x) + Math.PI / 2; // 00h arriba
      if (a < 0) a += Math.PI * 2;
      return Math.round((a / (Math.PI * 2)) * 1440 / 5) * 5 % 1440; // pasos de 5 min
    };
    let needleDrag = false, needleRaf = null;
    root.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-needle]')) return;
      needleDrag = true; e.preventDefault();
      document.addEventListener('pointermove', onNeedleMove);
      document.addEventListener('pointerup', onNeedleUp, { once: true });
    });
    function onNeedleMove(e) {
      if (!needleDrag || needleRaf) return;
      needleRaf = requestAnimationFrame(() => {
        needleRaf = null;
        const m = clockMinAt(e); if (m == null) return;
        rtScrubMin = m; rtRenderClock();
      });
    }
    function onNeedleUp() { needleDrag = false; document.removeEventListener('pointermove', onNeedleMove); }

    root.addEventListener('click', (e) => {
      if (e.target.closest('#rt-optBtn')) { rtOptimize(); return; }
      const mp = e.target.closest('[data-map]'); if (mp) { rtOpenMap(mp.dataset.map); return; }
      const ex = e.target.closest('[data-expand]'); if (ex) {
        rt.expandedLane = rt.expandedLane === ex.dataset.expand ? null : ex.dataset.expand;
        rtRenderLanes(); return;
      }
      const arc = e.target.closest('[data-arc]'); if (arc) {
        rt.expandedLane = arc.dataset.arc; rtRenderLanes();
        const el = root.querySelector(`[data-lane="${arc.dataset.arc}"]`);
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
        return;
      }
      // clic en el dial = mover la aguja a esa hora; clic en el centro = volver a AHORA
      if (e.target.closest('#rt-clock')) {
        const svg = $('#rt-clock svg');
        if (svg) {
          const b = svg.getBoundingClientRect();
          const x = (e.clientX - b.left) / b.width * 560 - 280;
          const y = (e.clientY - b.top) / b.height * 560 - 280;
          const rad = Math.hypot(x, y);
          if (rad <= 104) { if (rtScrubMin != null) { rtScrubMin = null; rtRenderClock(); } }
          else if (rad <= 292) { const m = clockMinAt(e); if (m != null) { rtScrubMin = m; rtRenderClock(); } }
        }
        return;
      }
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
      if (e.target.closest('#rt-alertFix')) {
        const bad = rt.lanes.find(l => rtCarCompute(l.id).status === 'late');
        if (bad) { rt.expandedLane = bad.id; rtRenderLanes(); const el = root.querySelector(`[data-lane="${bad.id}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); toast(`${bad.id} no llega: sal más temprano (ver "sal máx") o mueve una parada a otra vuelta.`); }
        return;
      }
      if (e.target.closest('#rt-dayprev') || e.target.closest('#rt-daynext')) { toast('Navegación de día disponible al conectar reservas reales.'); return; }
    });
  }

  async function renderRoutes() {
    await rtLoad();
    $('#rt-optBtn').innerHTML = '<svg class="icon"><use href="#i-bolt"/></svg>Optimizar';
    $('#rt-h1').textContent = 'Rutas del día';
    rtRenderAll();
    rtBindOnce();
    if (rt.source === 'demo' && !rt.demoToasted) { rt.demoToasted = true; toast('Mostrando datos de ejemplo. Conecta reservas reales (mig. 0040 + seed) para planear de verdad.'); }
  }
