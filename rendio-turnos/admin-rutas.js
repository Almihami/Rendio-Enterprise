// admin-rutas.js — Admin: Asignación de rutas de auxiliares + asignador real (sectores, cupo, deadline).
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ---------------- ASIGNACIÓN (planeación de rutas) ----------------
  // Base de los carros y aeropuerto (coords reales del Oriente antioqueño).
  const RT_DEPOT = { lat: 6.1537, lng: -75.3738 };   // Plaza de la Libertad, Rionegro (base)
  // OJO: la coord del "aeropuerto" debe ser la ROTONDA DEL TERMINAL DE PASAJEROS
  // (acceso occidental). El punto geocodificado genérico caía del lado oriental
  // de la pista y OSRM ruteaba por la zona de carga/CACOM 5 (prohibida).
  // 10-ago-2026: pin de la profa, el punto donde de verdad para el carro. Está
  // 126 m al sur del que había; sigue siendo el acceso occidental (comprobado:
  // OSRM rutea igual de bien, Río Vivo→MDE 28.0 min vs 28.5 del punto anterior).
  // Mismo valor en la BD (airports, migración 0059).
  const RT_AIRPORT = { lat: 6.170795254426601, lng: -75.42788741654356 }; // MDE · terminal de pasajeros
  // 2026-07-25: se eliminaron RT_DEMO_AUX / RT_DEMO_CARS / RT_DEMO_DRIVERS
  // (25 auxiliares, 2 carros y 4 conductores inventados). Servían para enseñar
  // el tablero antes de que hubiera reservas reales, pero con la app en pruebas
  // mentían: se podía "planear" y hasta creer que se publicó un plan de gente
  // que no existe. Ver [feedback-no-inventar-datos]. Sin reservas reales el
  // tablero ahora queda vacío y dice qué falta.
  const RT_PALETTE = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#E2551A', '#DB4B7A', '#5B8A2B', '#B45309', '#4F46E5', '#0D9488', '#9D174D'];

  const rt = {
    aux: {}, colors: {}, cars: [], drivers: [], plan: {},
    // MULTI-VIAJE: cada carro hace varias vueltas al día. Un "lane" = un viaje
    // (carro + vuelta + hora de salida + origen). rt.order se indexa por lane.id.
    lanes: [], order: {}, pool: [], optimized: false, drawerCar: null,
    shift: null, shiftLoaded: false, pendingAM: null, pendingPM: null,
    expandedLane: null, _dragging: false, // UI: vuelta expandida en la tarjeta del carro / drag activo
    tripType: 'sal', source: 'empty', bound: false, emptyReason: 'reservas',
    CAP: 4, AIRPORT_LEG: 16, MARGIN_TIGHT: 15, dragId: null, dragSrc: null,
    // ---- Modelo de tiempos (todo parametrizable desde Ajustes/app_settings) ----
    SERVICE_MIN: 4,      // min por parada: frenar, timbrar, subir gente y maletas
    AIRPORT_BUFFER: 10,  // min de colchón al entregar: bajar maletas + entrar a tiempo
    TRAFFIC_FACTOR: 1.25,// multiplica el tiempo de manejo (OSRM da flujo libre, sin tráfico)
    // Corrección SOLO del tramo a/desde MDE. Medido contra 99 vueltas reales del
    // jefe (6 mensajes de WhatsApp): entre casa y casa OSRM acierta —él deja 8.5
    // min donde OSRM dice 5.8, y esos 2.7 de más son el tiempo de subir gente—,
    // pero en el corredor a MDE OSRM sobreestima: él promete 20 min desde Olivar,
    // Río Vivo o Cerezos donde OSRM dice 27.5, y la operación cumple todos los
    // días. Por eso NO se corrige con TRAFFIC_FACTOR (dañaría los pasos entre
    // casas, que están bien): el tramo al aeropuerto lleva su propio factor.
    // 1 = comportamiento de antes. Ver scripts/comparar-con-jefe.mjs.
    AIRPORT_FACTOR: 1,
    // Techo de lo que el PRIMERO recogido va montado antes de presentarse. Es una
    // regla del jefe medida sobre 99 vueltas suyas: nunca la pasa (máximos reales
    // 45 y 60). El 60 en las dos horas pico —6-9 a.m. y 12-6 p.m.— es su modelo de
    // tráfico, aprendido en terreno. 0 = sin techo (comportamiento anterior).
    MAX_WAIT: 0, MAX_WAIT_PEAK: 0,
    TURNAROUND: 8,       // min en MDE entre entregar y arrancar la siguiente vuelta
    DEPLANE: 20,         // min entre que el vuelo aterriza y el pasajero sale (migración+maletas)
    CUSHION: 15,         // min extra de margen al programar la salida de cada vuelta
    MERGE_WINDOW: 0,     // min de ventana para juntar oleadas cercanas (0 = no juntar)
    etaSource: null,     // 'tomtom' | 'osrm' | 'haversine' — de dónde salieron los tiempos
    M: null, // matriz de tiempos reales (min) entre depot/aeropuerto/paradas
    // Cuando los tiempos vienen de TomTom YA traen el tráfico de la hora en que
    // se va a rodar: aplicarles además el TRAFFIC_FACTOR sería contarlo dos veces.
    mHasTraffic: false,
    trafficDelay: 0,     // min de demora por tráfico en la peor pareja (para avisar)
    _mCache: null,       // última matriz de TomTom {key, at, data} — ver rtBuildMatrix
    trafficMode: null,   // 'live' | 'historical' — con qué tráfico se calculó
  };

  function rtCfg() {
    const s = state.settings || {};
    rt.CAP = Number(s.route_default_capacity) || 4;
    rt.AIRPORT_LEG = Number(s.route_airport_leg_min) || 16;
    rt.MARGIN_TIGHT = Number(s.route_margin_tight_min) || 15;
    rt.SERVICE_MIN = Number(s.route_service_min) || 4;
    rt.AIRPORT_BUFFER = Number(s.route_airport_buffer_min) || 10;
    rt.TRAFFIC_FACTOR = Number(s.route_traffic_factor) || 1.25;
    rt.AIRPORT_FACTOR = Number(s.route_airport_factor) || 1;
    // 0 es un valor válido ("sin techo"), así que no se usa `|| default`.
    rt.MAX_WAIT = s.route_max_wait_min != null ? Number(s.route_max_wait_min) : 0;
    rt.MAX_WAIT_PEAK = s.route_max_wait_peak_min != null ? Number(s.route_max_wait_peak_min) : 0;
    rt.TURNAROUND = Number(s.route_turnaround_min) || 8;
    rt.DEPLANE = Number(s.route_deplane_min) || 20;
    // Desembarque por aerolínea (0058). Si la migración no está, cada uno cae al
    // respaldo y el tablero se comporta como antes.
    rt.DEPLANE_TABLE = {
      avNac: Number(s.route_deplane_av_nac_min) || rt.DEPLANE,
      avInt: Number(s.route_deplane_av_int_min) || rt.DEPLANE,
      jsNac: Number(s.route_deplane_js_nac_min) || rt.DEPLANE,
      jsInt: Number(s.route_deplane_js_int_min) || rt.DEPLANE,
      wingo: Number(s.route_deplane_wingo_min) || rt.DEPLANE,
    };
    rt.CUSHION = Number(s.route_depart_cushion_min) || 15;
    // Ventana para fusionar oleadas cercanas. 0 = no fusionar (comportamiento
    // anterior, agrupando solo por hora exacta). Si la columna no existe todavía
    // (main sin la 0056) queda en 0 y el tablero se comporta como siempre.
    rt.MERGE_WINDOW = s.route_merge_window_min != null ? Number(s.route_merge_window_min) : 0;
  }

  async function rtLoad() {
    rtCfg();
    let loaded = null;
    try { if (Api.listRoutePlanning) loaded = await Api.listRoutePlanning('all'); }
    catch (e) { loaded = null; }
    if (loaded && loaded.aux && Object.keys(loaded.aux).length) {
      rt.aux = loaded.aux; rt.colors = loaded.colors || {}; rt.cars = loaded.cars || [];
      rt.drivers = loaded.drivers || []; rt.plan = loaded.plan || {}; rt.source = 'live';
      rt.day = loaded.day || null; // día operativo real (para persistir el plan)
    } else {
      // Sin reservas reales para el próximo día operativo: tablero VACÍO.
      // `reason` explica qué falta (reservas o vehículos), no se inventa nada.
      rt.aux = {}; rt.colors = {}; rt.cars = []; rt.drivers = [];
      rt.plan = {}; rt.source = 'empty'; rt.day = null;
      rt.emptyReason = (loaded && loaded.noVehicles) ? 'vehiculos' : 'reservas';
    }
    // Estado inicial: una vuelta vacía por carro; todos los auxiliares en el pool.
    rt.lanes = rt.cars.map(c => ({ id: `${c.id}·V1`, car: c.id, vuelta: 1, start: c.avail0 || '02:00', origin: null }));
    rt.order = {}; rt.lanes.forEach(l => { rt.order[l.id] = []; });
    rt.pool = Object.keys(rt.aux);
    rt.optimized = false;
    rt.M = null;
    // Conductores EN TURNO por franja (del horario publicado) para asignar AM/PM.
    rt.shift = null; rt.shiftLoaded = false;
    if (rt.source === 'live' && rt.day && Api.listDriversOnShift) {
      try {
        const sh = await Api.listDriversOnShift(rt.day);
        if (sh) {
          const byId = {}; rt.drivers.forEach(d => { byId[d.id] = d; });
          const enr = arr => (arr || []).map(x => ({ id: x.id, n: x.n, c: (byId[x.id] && byId[x.id].c) || '#8895a7' }));
          rt.shift = { am: enr(sh.am), pm: enr(sh.pm), coordAm: enr(sh.coordAm), coordPm: enr(sh.coordPm) };
          rt.shiftLoaded = true;
        }
      } catch (e) { /* sin horario → fallback a todos */ }
    }
  }
  const rtCarOf = (lane) => rt.cars.find(c => c.id === lane.car);
  const rtLaneOf = (laneId) => rt.lanes.find(l => l.id === laneId);

  const rtCapOf = (car) => (car && car.capacity) || rt.CAP;

  // ---- Asignación por franja de turno (AM 02:30–14:00 / PM 14:00–01:30) ----
  // Una vuelta pertenece a AM u PM según su hora de arranque. El relevo es ~14:00;
  // las horas de 00:00–02:30 caen en el turno PM (que corre hasta 01:30).
  function rtBandOf(lane) { const m = rtToMin((lane && lane.start) || '00:00'); return (m >= 150 && m < 840) ? 'am' : 'pm'; }
  // Conductores EN TURNO de una franja ese día (horario publicado). Sin horario
  // publicado (demo o semana sin publicar) → todos, como fallback.
  function rtPoolFor(band) {
    if (rt.shiftLoaded && rt.shift) return (band === 'am' ? rt.shift.am : rt.shift.pm) || [];
    return rt.drivers;
  }
  // Conductor asignado a una vuelta, según SU franja (driverAM o driverPM del carro).
  function rtDriverOf(lane) { const car = rtCarOf(lane); if (!car) return null; return rtBandOf(lane) === 'am' ? car.driverAM : car.driverPM; }
  // Franjas que realmente cubre un carro (por sus vueltas con paradas).
  function rtBandsOfCar(carId) { return [...new Set(rt.lanes.filter(l => l.car === carId && rt.order[l.id] && rt.order[l.id].length).map(rtBandOf))].sort(); }
  const rtBandLabel = (b) => b === 'am' ? '02:30–14:00' : '14:00–01:30';
  const rtBandIcon = (b) => b === 'am' ? '☀' : '☾';

  // ---- Desembarque: cuánto tarda el pasajero en salir del terminal ----
  // No es un número solo. La operación mide entre 15 y 35 minutos según la
  // aerolínea y si el vuelo es nacional o internacional (ver 0058). Se saca del
  // código de vuelo, que es lo único que tenemos.
  //
  // OJO con los vuelos SIN SIGLA: el formulario pide "vuelo de llegada" en texto
  // libre y dos de cada tres tripulantes escriben solo los dígitos ("5116"). Lo
  // que sigue es INFERENCIA, no dato: los 4 dígitos que empiezan por 5 se toman
  // como JetSmart porque el mismo vuelo llegó escrito de las dos formas el 7-ago
  // (Fernando puso "JA5116" y Paulina "5116"). Si algún día Avianca opera un
  // 5xxx, aquí es donde se corrige — o mejor, se arregla el formulario para que
  // pida la sigla y esto deje de ser adivinanza.
  function rtDeplaneVuelo(v) {
    const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) return null;
    const T = rt.DEPLANE_TABLE || {};
    const sigla = ['JEC', 'JA', 'AV', 'P5'].find(p => s.startsWith(p)) || '';
    const num = s.slice(sigla.length);
    if (!/^\d+$/.test(num)) return null;
    if (sigla === 'P5') return T.wingo;
    if (sigla === 'JEC' || sigla === 'JA') return num.startsWith('58') ? T.jsInt : T.jsNac;
    if (sigla === 'AV') return num.length <= 3 ? T.avInt : T.avNac;
    // Sin sigla: se deduce por la forma del número.
    if (num.length <= 3) return T.avInt;                      // 033, 231, 43
    if (num.length === 4 && num.startsWith('58')) return T.jsInt;
    if (num.length === 4 && num.startsWith('5')) return T.jsNac;
    return T.avNac;
  }
  // Desembarque de un GRUPO: manda el que más tarda. El carro no se puede ir con
  // medio grupo, y en una vuelta fusionada conviven vuelos de aerolíneas
  // distintas. Sin ningún vuelo clasificable, el respaldo de Ajustes.
  function rtDeplaneOf(ids) {
    let mx = null;
    (ids || []).forEach(id => {
      const d = rtDeplaneVuelo(rt.aux[id] && rt.aux[id].vuelo);
      if (d != null && (mx == null || d > mx)) mx = d;
    });
    return mx == null ? rt.DEPLANE : mx;
  }

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
    const real = rt.M && rt.M[aKey] && rt.M[aKey][bKey] != null;
    const raw = real ? rt.M[aKey][bKey] : rtHaversineMin(rtCoordsOf(aKey), rtCoordsOf(bKey));
    // Con tiempos de TomTom el tráfico ya está dentro; el factor solo corrige a
    // OSRM/haversine, que calculan como si la vía estuviera libre. Si el valor
    // salió del respaldo haversine (celda sin datos), sí lleva factor.
    if (rt.mHasTraffic && real) return raw;
    // El corredor a MDE lleva ADEMÁS su propio factor: OSRM lo sobreestima ahí y
    // no entre casas (ver AIRPORT_FACTOR). Con tiempos de TomTom no se toca
    // ninguno de los dos: esos ya vienen medidos de la vía.
    const aero = (aKey === 'airport' || bKey === 'airport') ? rt.AIRPORT_FACTOR : 1;
    return raw * rt.TRAFFIC_FACTOR * aero;
  }

  // Evalúa una VUELTA (lane): ETAs por parada, llegada a MDE, holgura y estado.
  function rtCarCompute(laneId) {
    const lane = rtLaneOf(laneId);
    if (lane.type === 'lle') return rtCarComputeLle(lane);
    let t = rtToMin(lane.start), prev = lane.origin, stops = [], pax = 0, hardDL = Infinity;
    let prevKey = null, eta = Math.round(t);
    rt.order[laneId].forEach(id => {
      const k = rtStopKey(id);
      if (k !== prevKey) {                  // portería nueva: manejar y frenar
        if (prev) t += rtLegMin(prev, id);
        eta = Math.round(t);                // ETA = cuando el carro LLEGA a la parada
        t += rt.SERVICE_MIN;                // subir gente + maletas antes de arrancar
        prev = id; prevKey = k;
      }
      // Los de la misma portería comparten el frenazo y la misma ETA.
      pax += rt.aux[id].pax;
      stops.push({ id, eta });
      hardDL = Math.min(hardDL, rtToMin(rt.aux[id].dl));
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
    let prevKey = null, eta = Math.round(t);
    rt.order[lane.id].forEach(id => {
      const k = rtStopKey(id);
      if (k !== prevKey) {                  // se deja a varios en la misma portería de una
        t += rtLegMin(prev, id);
        eta = Math.round(t);
        t += rt.SERVICE_MIN;
        prev = id; prevKey = k;
      }
      pax += rt.aux[id].pax;
      stops.push({ id, eta });
    });
    const arrival = rt.order[lane.id].length ? Math.round(t) : null; // termina en la última casa
    const ideal = rtToMin(lane.landing) + rtDeplaneOf(rt.order[lane.id]); // cuándo sale la gente del terminal
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

  // Si la vuelta sale dentro de menos de esto, se pide tráfico EN VIVO: a menos
  // de una hora lo que está pasando en la vía pesa más que el patrón histórico.
  const RT_LIVE_WINDOW_MIN = 60;

  // La hora para la que hay que pedir el tráfico: la salida MÁS TEMPRANA que se
  // está planeando, no "ahora". Ese es todo el punto — a las 4pm preguntar cómo
  // va a estar la vía a las 5pm, para saber antes de salir si la vuelta cuadra.
  // Si esa hora ya pasó (se está replaneando sobre la marcha) se devuelve null y
  // TomTom usa su histórico general.
  function rtDepartAtISO() {
    if (!rt.day) return null;
    const mins = rt.lanes.map(l => rtToMin(l.start || '00:00')).filter(n => !isNaN(n));
    if (!mins.length) return null;
    const m = Math.min(...mins);
    const iso = `${rt.day}T${rtToHM(m)}:00-05:00`;   // Colombia (sin horario de verano)
    const t = new Date(iso).getTime();
    if (isNaN(t) || t < Date.now() + 5 * 60000) return null;  // ya pasó o es inminente
    return iso;
  }

  // ---- Solver real: matriz de tiempos + agrupar por sector + mejor orden ----
  // Construye la matriz de tiempos (min) entre depot, aeropuerto y todas las
  // paradas, en cascada de mejor a peor:
  //   1) TomTom  → tiempos CON tráfico para la hora en que se va a rodar. Es lo
  //      que permite ver a las 4pm que la vuelta de las 5pm ya no cuadra.
  //   2) OSRM    → tiempos reales por carretera, pero de vía libre.
  //   3) haversine → línea recta ×1.4. Último recurso.
  // Los niveles 2 y 3 se corrigen con TRAFFIC_FACTOR; el 1 no (ver rtLegMin).
  async function rtBuildMatrix() {
    const keys = ['depot', 'airport', ...Object.keys(rt.aux)];
    const pts = keys.map(rtCoordsOf);
    rt.mHasTraffic = false; rt.trafficDelay = 0;

    // 1) TomTom, vía Edge Function (la llave vive en el servidor, no en la PWA).
    //
    // CACHÉ, y no es un lujo: TomTom cobra por CELDA, no por llamada — con más
    // de 5 puntos son max(orígenes,destinos)×5 transacciones, o sea 410 en un
    // día de 80 traslados. Como el admin re-optimiza varias veces mientras
    // acomoda el día, sin caché una sola sesión de planeación gastaría miles.
    // El tráfico previsto para una hora dada no cambia entre un clic y otro:
    // mismos puntos + misma hora = misma respuesta, se reusa por 10 minutos.
    if (window.Api && Api.trafficMatrix) {
      try {
        const departAt = rtDepartAtISO();
        // Vivo vs histórico: el histórico dice "esta vía suele estar así a esta
        // hora" y sirve para planear mañana, pero NO ve un accidente de hace
        // diez minutos. Medido en el corredor Rionegro→MDE durante un choque
        // real: histórico 16 min, en vivo 36. Planear con el histórico en ese
        // momento habría hecho perder el vuelo por 20 minutos.
        // Por eso: si la salida es inminente (o ya pasó), manda el tráfico real.
        const mins = departAt ? (new Date(departAt).getTime() - Date.now()) / 60000 : 0;
        const mode = (!departAt || mins <= RT_LIVE_WINDOW_MIN) ? 'live' : 'historical';
        const coords = pts.map(p => ({ lat: p.lat, lng: p.lng }));
        const ck = coords.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|')
          + '#' + (mode === 'live' ? 'live' : (departAt || 'any'));
        const hit = rt._mCache;
        // El tráfico en vivo cambia solo: se cachea 3 minutos, no 10.
        const ttl = (mode === 'live' ? 3 : 10) * 60000;
        const r = (hit && hit.key === ck && Date.now() - hit.at < ttl)
          ? hit.data
          : await Api.trafficMatrix(coords, departAt, mode);
        rt.trafficMode = mode;
        if (r && Array.isArray(r.durations)) {
          rt._mCache = { key: ck, at: (hit && hit.key === ck) ? hit.at : Date.now(), data: r };
          const M = {};
          let peor = 0, celdas = 0;
          keys.forEach((ka, i) => {
            M[ka] = {};
            keys.forEach((kb, jx) => {
              const v = r.durations[i] ? r.durations[i][jx] : null;
              // Celda que TomTom no resolvió: se rellena con haversine y esa SÍ
              // lleva factor de tráfico (rtLegMin lo distingue).
              M[ka][kb] = (v == null) ? rtHaversineMin(pts[i], pts[jx]) : v;
              if (v != null) celdas++;
              const d = r.delays && r.delays[i] ? r.delays[i][jx] : 0;
              if (typeof d === 'number' && d > peor) peor = d;
            });
          });
          // Si TomTom resolvió menos de la mitad, no vale la pena: mejor OSRM
          // completo que una matriz con huecos rellenados a ojo.
          if (celdas >= keys.length * keys.length / 2) {
            rt.M = M; rt.mHasTraffic = true; rt.trafficDelay = peor;
            return 'tomtom';
          }
        }
      } catch (e) { /* sin tráfico: cae a OSRM */ }
    }

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
  // ---- Una PORTERÍA = una parada ----
  // Nicol y Cata Rico viven las dos en el Edificio Cámbulo: el carro para UNA
  // vez y suben las dos. Antes cada reserva era una parada distinta — se cobraba
  // el servicio dos veces y la fuerza bruta permutaba el orden entre ellas, que
  // es un orden que no existe. La llave sale del catálogo de residencias (0055);
  // si la reserva no tiene residencia (pin manual) cae a la coordenada.
  function rtStopKey(id) {
    const a = rt.aux[id];
    if (!a) return id;
    if (a.resId) return 'r:' + a.resId;
    return (a.lat != null && a.lng != null) ? `c:${a.lat.toFixed(5)},${a.lng.toFixed(5)}` : 'i:' + id;
  }
  // Agrupa ids por portería conservando el orden de aparición.
  function rtGroupByStop(ids) {
    const g = new Map();
    ids.forEach(id => { const k = rtStopKey(id); if (!g.has(k)) g.set(k, []); g.get(k).push(id); });
    return [...g.values()];
  }
  const rtPaxOf = (ids) => ids.reduce((s, id) => s + ((rt.aux[id] && rt.aux[id].pax) || 1), 0);

  // Techo de espera del PRIMERO recogido, por franja de la hora de presentación.
  // Las dos horas pico (6-9 a.m. y 12-6 p.m.) son las del jefe, no las nuestras:
  // es su modelo de tráfico y aguanta más espera ahí. 0 = sin techo.
  function rtTechoEspera(dlMin) {
    const h = Math.floor(dlMin / 60) % 24;
    const pico = (h >= 6 && h < 9) || (h >= 12 && h < 18);
    return pico ? (rt.MAX_WAIT_PEAK || rt.MAX_WAIT) : rt.MAX_WAIT;
  }
  // Lo que va montado el primero de una salida: el recorrido completo más el
  // colchón de entrega. En una llegada no aplica —ahí nadie espera dentro del
  // carro, el pasajero sale del terminal y arranca.
  const rtEsperaDe = (tipo, ids) => tipo === 'lle' ? 0 : rtTripDur(ids, null) + rt.AIRPORT_BUFFER;
  // La operación habla en múltiplos de 5: "recoge a las 3:15", no "a las 3:13".
  // El lado seguro depende del tipo: en una SALIDA salir antes es gratis, así que
  // va hacia abajo; en una LLEGADA adelantarse es plantarse en el terminal antes
  // de que el pasajero salga, así que va hacia arriba.
  const rtRedondea5 = (m) => Math.floor(m / 5) * 5;
  const rtRedondea5Arr = (m) => Math.ceil(m / 5) * 5;
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
  // Permuta PORTERÍAS, no pasajeros: con 4 personas en 2 conjuntos son 2
  // permutaciones, no 24 — y el resultado deja juntos a los de la misma puerta.
  function rtBestOrder(ids, origin = null, endAtAirport = true) {
    if (ids.length <= 1) return ids.slice();
    const groups = rtGroupByStop(ids);
    if (groups.length === 1) return groups[0].slice();
    const scored = rtPermutations(groups).map(perm => {
      let t = 0, prev = origin;
      perm.forEach(g => { if (prev) t += rtLegMin(prev, g[0]); prev = g[0]; });
      if (endAtAirport) t += rtLegMin(prev, 'airport');
      return { perm, t, flat: perm.flat() };
    });
    const best = Math.min(...scored.map(s => s.t));
    const tol = Math.max(2, best * 0.06);
    // Desempates (en orden): 1) no zigzaguear entre sectores; 2) "fluir hacia
    // el destino" — terminar en la parada más cercana al aeropuerto; 3) tiempo.
    const finalLeg = (perm) => rtLegMin(perm[perm.length - 1][0], 'airport');
    return scored
      .filter(s => s.t <= best + tol)
      .sort((a, b) => (rtZoneReentries(a.flat) - rtZoneReentries(b.flat))
        || (finalLeg(a.perm) - finalLeg(b.perm))
        || (a.t - b.t))[0].flat;
  }
  // Evalúa un carro (lista de paradas): mejor ruta → llegada al aeropuerto,
  // deadline más exigente y minutos de atraso (0 si llega a tiempo).
  function rtRouteEval(carStart, ids, origin = null) {
    if (!ids.length) return { arrival: null, minDL: Infinity, late: 0 };
    const ord = rtBestOrder(ids, origin);
    let t = carStart, prev = origin, prevKey = null;
    ord.forEach(id => {
      const k = rtStopKey(id);
      if (k === prevKey) return;            // misma portería: un solo frenazo
      if (prev) t += rtLegMin(prev, id);
      t += rt.SERVICE_MIN; prev = id; prevKey = k;
    });
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
    let t = 0, prev = 'airport', last = 'airport', prevKey = null;
    ord.forEach(id => {
      const k = rtStopKey(id);
      if (k === prevKey) return;            // misma portería: ya se paró ahí
      t += rtLegMin(prev, id) + rt.SERVICE_MIN;
      prev = id; last = id; prevKey = k;
    });
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
    const capMax = Math.max(...rt.cars.map(rtCapOf));

    // 1.b) FUSIÓN DE OLEADAS CERCANAS.
    // Los jefes no despachan por hora exacta. Si a las 03:50 se presentan dos y
    // a las 04:00 otros dos, y viven del mismo lado, los montan en UN carro y
    // los dejan a todos a las 03:40. El código agrupaba por minuto exacto, así
    // que 03:50 y 04:00 eran oleadas distintas que jamás se cruzaban: salían dos
    // carros con dos pasajeros cada uno.
    //
    // Regla de fusión, que es la económica: se fusiona solo si UN carro haciendo
    // las dos tarda MENOS que dos carros haciendo una cada uno. Eso solo se
    // cumple cuando el desvío es corto, y rechaza por sí mismo los casos caros
    // (pegarle Marinilla a una vuelta de Rionegro cuesta +50 min → no fusiona).
    // El deadline no corre riesgo: manda el MÁS APRETADO del grupo, y los de
    // hora más tarde simplemente llegan antes — que es lo que hacen ellos.
    //
    // Con route_merge_window_min = 0 no fusiona nada: comportamiento idéntico al
    // anterior. Es la palanca para apagar esto sin tocar código.
    const durDe = (tipo, ids) => tipo === 'lle' ? rtHomesPlan(ids).dur : rtTripDur(ids, null);
    const fusionables = (tipo, base, extra, dlMin) => {
      const cand = base.concat(extra);
      if (rtPaxOf(cand) > capMax) return false;
      // TECHO DE ESPERA, como límite duro MIENTRAS arma y no solo verificado al
      // final: juntar dos oleadas alarga el recorrido, y al primero que sube le
      // toca todo. Antes esto se revisaba cuando ya estaba armado, y salían
      // vueltas de 67 min montado — cosa que el jefe no hace nunca.
      if (rtTechoEspera(dlMin) && rtEsperaDe(tipo, cand) > rtTechoEspera(dlMin)) return false;
      // ¿un carro sale más barato que dos? (comparten el tramo al aeropuerto)
      //
      // Se probó añadir un segundo freno —"el desvío no puede costar más que la
      // ventana"— para evitar la vuelta tarde de las 13:00. MEDIDO: empeora.
      // Bloquea fusiones que sí servían, los carros quedan más ocupados y los
      // tarde suben de 0 a 3. La prueba económica sola es mejor freno.
      return durDe(tipo, cand) <= durDe(tipo, base) + durDe(tipo, extra);
    };
    // MISMA PORTERÍA, MISMO CARRO. Lo cazó el jefe revisando el plan del 11-ago:
    // Josmar y Jessica viven los dos en Solare y salieron en vueltas distintas
    // con diez minutos de diferencia. Pasó porque sus oleadas (3:50 y 4:00) no se
    // fusionaron —juntas daban 5 pax y el cupo es 4— y el reparto por portería
    // del paso 2 solo mira DENTRO de una oleada, así que nunca las vio juntas.
    //
    // Si comparten portería se fusionan igual, sin exigir cupo ni prueba
    // económica: el paso 2 parte por cupo AGRUPANDO por portería, de modo que la
    // pareja termina en el mismo carro y lo que se desplaza es un tercero.
    // Mandar dos carros a la misma puerta con diez minutos de diferencia no lo
    // hace nadie en la operación.
    const mismaPorteria = (a, b) => {
      const ka = new Set(a.map(rtStopKey));
      return b.some(id => ka.has(rtStopKey(id)));
    };
    const W = rt.MERGE_WINDOW;
    const pend = waves.slice();
    const oleadas = [];
    while (pend.length) {
      const base = pend.shift();
      const g = { type: base.type, dlMin: base.dlMin, ids: base.ids.slice() };
      // El corte natural está donde se ABRE UN HUECO entre hora y hora, no a una
      // distancia fija de la primera. Mirando el día: 3:30 · 3:30 · 3:40 · 3:50 ·
      // 4:00 · 4:00 son saltos de 10 min —un solo racimo, que el cupo parte en
      // 4+2— y el corte de verdad viene en 4:00 → 4:30. Midiendo desde la primera
      // hora, Jesús Taborda (3:50) quedaba a 20 min de Juan Martínez (3:30) y se
      // caía del grupo que la operación arma sin pensarlo.
      let ultimo = g.dlMin;                          // hora de la última absorbida
      if (W > 0) {
        for (let i = 0; i < pend.length; i++) {
          const w = pend[i];
          if (w.dlMin - ultimo > W) break;           // hueco: aquí corta el racimo
          if (w.type !== g.type) continue;
          // En una LLEGADA el carro no puede recoger antes de que aterricen TODOS,
          // así que el que aterrizó primero espera esa diferencia. Se acota con el
          // mismo margen que ya define "ajustado" en el resto del tablero.
          if (g.type === 'lle' && w.dlMin - g.dlMin > Math.min(W, rt.MARGIN_TIGHT)) continue;
          if (!mismaPorteria(g.ids, w.ids) && !fusionables(g.type, g.ids, w.ids, g.dlMin)) continue;
          g.ids = g.ids.concat(w.ids);
          ultimo = w.dlMin;                          // el racimo sigue desde aquí
          // La llegada se rige por el ÚLTIMO que aterriza; la salida, por el
          // primero que debe presentarse (ya es dlMin, no cambia).
          if (g.type === 'lle') g.dlMin = Math.max(g.dlMin, w.dlMin);
          pend.splice(i, 1); i--;
        }
      }
      oleadas.push(g);
    }

    // 2) VIAJES: partir oleadas más grandes que el cupo (agrupando por portería,
    //    para no separar a dos personas de la misma puerta en carros distintos).
    const trips = [];
    oleadas.forEach(w => {
      // Un viaje cabe si NO se pasa del cupo y NO se pasa del techo de espera.
      // El techo importa aquí y no solo al fusionar: una oleada de 4 personas
      // regadas por todo Rionegro cabe de sobra en el carro y aun así deja al
      // primero 67 min montado. Antes esta rama se devolvía de una por caber en
      // cupo y nadie miraba el recorrido.
      const techo = rtTechoEspera(w.dlMin);
      const cabe = (ids) => rtPaxOf(ids) <= capMax && (!techo || rtEsperaDe(w.type, ids) <= techo);
      if (cabe(w.ids)) { trips.push({ type: w.type, dlMin: w.dlMin, ids: w.ids.slice() }); return; }
      let actual = [];
      rtGroupByStop(w.ids).forEach(porteria => {
        let resto = porteria.slice();
        if (actual.length && !cabe(actual.concat(resto))) { trips.push({ type: w.type, dlMin: w.dlMin, ids: actual }); actual = []; }
        // Una portería con más gente que el cupo se parte igual (no cabe de otra forma).
        while (rtPaxOf(resto) > capMax) { trips.push({ type: w.type, dlMin: w.dlMin, ids: resto.slice(0, capMax) }); resto = resto.slice(capMax); }
        actual = actual.concat(resto);
      });
      if (actual.length) trips.push({ type: w.type, dlMin: w.dlMin, ids: actual });
    });
    // 3) ASIGNAR cada viaje (cronológico) al mejor carro. El carro tiene POSICIÓN
    //    (null = aún no sale; 'airport' = en MDE; id de parada = última casa de
    //    una llegada) — el tramo desde donde quedó SÍ cuenta.
    const cs = rt.cars.map(c => ({ car: c, avail: rtToMin(c.avail0 || '01:30'), vuelta: 0, pos: null }));
    const lanes = [], order = {}, unassigned = [];
    // rtCarCompute busca la vuelta en rt.lanes: se apunta al arreglo que se está
    // llenando para poder evaluar una vuelta apenas queda armada (ver el ajuste
    // de la hora de salida más abajo). El llamador los vuelve a asignar al final.
    rt.lanes = lanes; rt.order = order;
    trips.forEach(tr => {
      let best = null;
      if (tr.type === 'lle') {
        // LLEGADA: hay que ESTAR en MDE cuando salgan (aterriza + desembarque).
        const idealPickup = tr.dlMin + rtDeplaneOf(tr.ids);
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
        const lane = { id: `${s.car.id}·V${s.vuelta}`, car: s.car.id, vuelta: s.vuelta, type: 'lle', start: rtToHM(rtRedondea5Arr(best.pickup)), origin: 'airport', landing: rtToHM(tr.dlMin) };
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
      // Hora redonda, como la maneja la operación: las 46 horas del plan manual
      // de Julián son múltiplos de 5. Se redondea HACIA ABAJO — salir un par de
      // minutos antes es gratis, salir después se come la holgura.
      const lane = { id: `${s.car.id}·V${s.vuelta}`, car: s.car.id, vuelta: s.vuelta, type: 'sal', start: rtToHM(rtRedondea5(best.depart)), origin: best.origin };
      lanes.push(lane);
      order[lane.id] = rtBestOrder(tr.ids, best.origin);
      // AJUSTE DE LA HORA DE SALIDA. La hora se eligió con una estimación hecha
      // ANTES de fijar el orden de las paradas; con la ruta ya armada el recorrido
      // suele salir más corto, y entonces el carro arrancaba antes de lo necesario.
      // Eso no lo paga el carro: lo paga montado el primero que sube. Medido en el
      // día del 11-ago, hasta 19 minutos de más. Se recalcula con la ruta de verdad
      // y se retrasa la salida lo que se pueda — nunca antes de que el carro esté
      // libre, nunca más tarde de lo que aguanta la hora de presentación.
      const real = rtCarCompute(lane.id);
      if (real.depart != null) {
        const tarde = rtRedondea5(Math.max(s.avail, real.depart - rt.CUSHION));
        if (tarde > rtToMin(lane.start)) lane.start = rtToHM(tarde);
      }
      // tras entregar queda en MDE, disponible para la siguiente vuelta
      const fin = rtCarCompute(lane.id);
      s.avail = (fin.arrival != null ? fin.arrival : rtToMin(lane.start)) + rt.TURNAROUND;
      s.pos = 'airport';
    });
    return { lanes, order, unassigned };
  }

  // Tarjeta del pool. Antes solo decía nombre + zona + hora: para saber de qué
  // vuelo era, a qué teléfono llamar o qué pidió el auxiliar había que irse a
  // Reservas. Ahora el dato está donde se toma la decisión.
  function rtAuxCard(id) {
    const a = rt.aux[id];
    const tt = a.hotel ? 'hotel' : a.type;
    const ttl = a.hotel ? 'Hotel' : (a.type === 'sal' ? 'Salida' : 'Llegada');
    const tip = [a.dir || a.zona, a.vuelo && ('Vuelo ' + a.vuelo), a.tel, a.notas].filter(Boolean).join(' · ');
    return `<div class="aux" draggable="true" data-aux="${id}" data-src="pool" title="${rtEsc(tip)}">
      <span class="pax">${a.pax > 1 ? '×' + a.pax : ''}</span>
      <div class="a-top"><span class="a-av" style="background:${rt.colors[id] || '#888'}">${rtIni(a.n)}</span>
        <div class="a-nm"><b>${a.n}</b><span>${rtEsc(a.dir || a.zona)}</span></div></div>
      <div class="a-meta">
        <span class="triptype ${tt}"><svg class="icon"><use href="#${a.hotel ? 'i-home' : (a.type === 'lle' ? 'i-down' : 'i-up')}"/></svg>${ttl}</span>
        ${a.vuelo ? `<span class="a-flight">${rtEsc(a.vuelo)}</span>` : ''}
        <span class="dl hard"><svg class="icon"><use href="#i-clock"/></svg>${a.dl}</span>
      </div>
      ${a.notas ? `<div class="a-note" title="${rtEsc(a.notas)}"><svg class="icon"><use href="#i-info"/></svg>${rtEsc(a.notas)}</div>` : ''}
      ${a.tel ? `<a class="a-tel" href="tel:${rtEsc(a.tel)}" draggable="false"><svg class="icon"><use href="#i-phone"/></svg>${rtEsc(a.tel)}</a>` : ''}
    </div>`;
  }

  function rtRenderPool() {
    // Todos ruteados → la columna se oculta (reaparece al arrastrar una parada).
    const stage = $('#routes-ui .stage');
    if (stage) stage.classList.toggle('nopool', rt.optimized && !rt.pool.length && !rt._dragging);
    $('#rt-poolCount').textContent = rt.pool.length;
    $('#rt-dsTotal').textContent = Object.keys(rt.aux).length;
    const list = $('#rt-poolList');
    if (rt.source === 'empty') {
      // Estado vacío honesto: se dice qué falta. Antes aquí salían 25
      // auxiliares inventados y se podía "planear" un día que no existe.
      list.innerHTML = rt.emptyReason === 'vehiculos'
        ? `<div class="pool-empty"><div class="circle"><svg class="icon"><use href="#i-warn"/></svg></div><b>No hay vehículos</b><span>Registra la flota en Ajustes → Vehículos para poder armar rutas.</span></div>`
        : `<div class="pool-empty"><div class="circle"><svg class="icon"><use href="#i-clock"/></svg></div><b>Sin traslados por rutear</b><span>Aquí aparecen los auxiliares cuando piden su traslado desde la app. Puedes verlos uno por uno en Reservas.</span></div>`;
    }
    else if (!rt.pool.length) list.innerHTML = `<div class="pool-empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><b>Todos ruteados</b><span>Cada auxiliar está en un carro.</span></div>`;
    else list.innerHTML = rt.pool.map(rtAuxCard).join('');
  }

  function rtStopHTML(cid, s, idx) {
    const a = rt.aux[s.id];
    const overDL = s.eta > rtToMin(a.dl);
    const p = a.n.split(' ');
    // El title carga el detalle completo: en una parada estrecha no cabe, pero el
    // admin necesita poder consultarlo sin abrir Reservas.
    const tip = [a.n, a.dir || a.zona, a.vuelo && ('Vuelo ' + a.vuelo), a.tel, a.notas].filter(Boolean).join('\n');
    return `<div class="stop ${overDL ? 'over-dl' : ''}" draggable="true" data-aux="${s.id}" data-src="${cid}" title="${rtEsc(tip)}">
      <div class="s-top"><span class="s-n">${idx + 1}</span><span class="s-av" style="background:${rt.colors[s.id] || '#888'}">${rtIni(a.n)}</span><span class="s-nm">${rtEsc(p[0] + ' ' + (p[1] ? p[1][0] + '.' : ''))}</span></div>
      <div class="s-meta"><span class="s-zona">${rtEsc(a.zona)}</span><span class="s-eta">${rtToHM(s.eta)}</span></div>
      <div class="s-dl"><svg class="icon" style="width:10px;height:10px"><use href="#i-clock"/></svg>pres. ${a.dl}${a.vuelo ? ' · ' + rtEsc(a.vuelo) : ''}${a.hotel ? ' · hotel' : ''}${a.pax > 1 ? ' · ×' + a.pax : ''}</div>
      ${a.notas ? `<div class="s-note"><svg class="icon" style="width:10px;height:10px"><use href="#i-info"/></svg>${rtEsc(a.notas)}</div>` : ''}
    </div>`;
  }

  function rtLaneHTML(lane) {
    const car = rtCarOf(lane);
    const r = rtCarCompute(lane.id);
    const st = r.status;
    const capFull = r.pax >= rtCapOf(car);
    const pips = Array.from({ length: rtCapOf(car) }, (_, i) => `<span class="pip ${i < r.pax ? 'f' : ''}"></span>`).join('');
    const dId = rtDriverOf(lane);
    const drv = dId ? rt.drivers.find(d => d.id === dId) : null;
    const drvHTML = drv
      ? `<span class="drv set">${rtBandIcon(rtBandOf(lane))} <span class="av" style="background:${drv.c}">${rtIni(drv.n)}</span>${drv.n}</span>`
      : `<span class="drv none">${rtBandIcon(rtBandOf(lane))} <svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Sin conductor ${rtBandOf(lane).toUpperCase()} (borrador)</span>`;
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
      const bands = rtBandsOfCar(car.id);
      const drvHTML = (bands.length ? bands : []).map(b => {
        const id = b === 'am' ? car.driverAM : car.driverPM;
        const d = id ? rt.drivers.find(x => x.id === id) : null;
        return d
          ? `<span class="drv set">${rtBandIcon(b)} <span class="av" style="background:${d.c}">${rtIni(d.n)}</span>${d.n}</span>`
          : `<span class="drv none">${rtBandIcon(b)} <svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Sin conductor ${b.toUpperCase()}</span>`;
      }).join('') || `<span class="drv none">Sin vueltas</span>`;
      const allAssigned = bands.length && bands.every(b => (b === 'am' ? car.driverAM : car.driverPM));
      const paxTotal = lanes.reduce((t, l) => t + rtCarCompute(l.id).pax, 0);
      const rows = lanes.length
        ? lanes.map(l => rt.expandedLane === l.id ? rtLaneHTML(l) : rtTripRowHTML(l)).join('')
        : `<div class="lane-empty" data-drop="${car.id}·V1">Sin vueltas — pulsa Optimizar o arrastra auxiliares.</div>`;
      const assignBtn = lanes.length
        ? `<button class="assignbtn ${!allAssigned ? 'cta' : ''}" data-assign="${lanes[0].id}"><svg class="icon" style="width:14px;height:14px"><use href="#i-user"/></svg>${allAssigned ? 'Cambiar conductores' : 'Asignar conductor'}</button>`
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
      else if (rt.etaSource === 'tomtom') {
        // El único caso en que los tiempos ya traen el trancón: se dice, porque
        // cambia cuánta confianza merece el plan. Y se distingue en vivo de
        // previsto: "hay un choque ahora" no es lo mismo que "suele congestionarse".
        const vivo = rt.trafficMode === 'live';
        de.querySelector('b').textContent = vivo ? 'En vivo' : 'Tráfico';
        de.title = vivo
          ? `Tiempos con el tráfico REAL de este momento (TomTom, incluye accidentes y cierres)`
            + ` + ${rt.SERVICE_MIN} min/parada + ${rt.AIRPORT_BUFFER} min entrega.`
            + ` No se aplica el factor ×${rt.TRAFFIC_FACTOR}: el tráfico ya está contado.`
          : `Tiempos CON tráfico previsto para la hora de salida (TomTom)`
          + `${rt.trafficDelay ? ` · hasta ${rt.trafficDelay} min de demora por trancón en el tramo más cargado` : ''}`
          + ` + ${rt.SERVICE_MIN} min/parada + ${rt.AIRPORT_BUFFER} min entrega. No se aplica el factor ×${rt.TRAFFIC_FACTOR}: el tráfico ya está contado.`;
        de.className = 'ds ok';
      }
      else if (rt.etaSource === 'osrm') { de.querySelector('b').textContent = 'OSRM'; de.title = `Tiempos por carretera real (OSRM), SIN tráfico en vivo: ${modelo}.`; de.className = 'ds ok'; }
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
    rt.etaSource = src; // 'tomtom' = con tráfico | 'osrm' = carretera real | 'haversine' = línea recta
    const day = rtSolveDay(); // oleadas → vueltas encadenadas entre los carros
    clearInterval(iv); $('#rt-ovl').classList.remove('show');
    rt.lanes = day.lanes;
    rt.order = day.order;
    rt.pool = day.unassigned.slice();
    rt.optimized = true;
    $('#rt-optBtn').innerHTML = '<svg class="icon"><use href="#i-bolt"/></svg>Re-optimizar';
    // "Publicar plan" solo con reservas reales (para que el conductor lo vea).
    const saveBtn = $('#rt-saveBtn'); if (saveBtn) saveBtn.style.display = (rt.source === 'live' && rt.day) ? '' : 'none';
    rtRenderAll();
    const s = rtDayStats();
    const how = src === 'tomtom' ? 'tiempos con tráfico previsto'
      : src === 'osrm' ? 'tiempos reales OSRM' : 'distancia estimada';
    const vueltas = rt.lanes.length;
    toast(s.late ? `${vueltas} vueltas programadas (${how}) — ${s.late} ajustada, revísala.` : `${vueltas} vueltas programadas entre ${rt.cars.length} carros (${how}). Todas llegan a tiempo.`);
  }

  // Persiste el plan del día: cada vuelta → route_assignment + route_stops.
  // Las vueltas con conductor asignado quedan visibles para ese conductor.
  async function rtSavePlan() {
    if (rt.source !== 'live' || !rt.day) { toast('Solo se publica con reservas reales.'); return; }
    const lanes = rt.lanes.filter(l => rt.order[l.id] && rt.order[l.id].length).map(l => {
      const car = rt.cars.find(c => c.id === l.car);
      return {
        vehicleId: car ? car.vehicleId : null,
        driverProfileId: rtDriverOf(l), // conductor de la FRANJA de esta vuelta (AM/PM)
        type: l.type || 'sal',
        startAt: rt.day + 'T' + (l.start || '04:00') + ':00-05:00',
        stops: rt.order[l.id].map(k => rt.aux[k] && rt.aux[k].reservationId).filter(Boolean),
      };
    });
    const withDriver = lanes.filter(l => l.driverProfileId).length;
    $('#rt-saveBtn').innerHTML = '<svg class="icon"><use href="#i-save"/></svg>Publicando…';
    try {
      const r = await Api.saveRoutePlan(rt.day, lanes);
      toast(withDriver
        ? `Plan publicado: ${r.saved} vueltas (${withDriver} con conductor asignado)${r.kept ? ` · ${r.kept} paradas ya en curso quedaron intactas` : ''}. Los conductores ya lo ven.`
        : `Plan publicado (${r.saved} vueltas). Asigna conductores para que los vean en su turno.`);
      // Push a los auxiliares cuya asignación CAMBIÓ de verdad. Antes se le
      // avisaba a todos en cada republicación, así que quien ya tenía conductor
      // recibía "Conductor asignado 🚗" otra vez — y a quien SÍ le cambiaron el
      // conductor le llegaba el mismo texto, sin decirle que había cambiado.
      try {
        const fresh = (r.notify || []).filter(n => !n.changed).map(n => n.reservationId);
        const moved = (r.notify || []).filter(n => n.changed).map(n => n.reservationId);
        if (fresh.length && Api.auxiliarUserIdsForReservations && Api.sendPush) {
          const ids = await Api.auxiliarUserIdsForReservations(fresh);
          if (ids.length) await Api.sendPush({ profileIds: ids,
            title: 'Conductor asignado 🚗',
            body: 'Ya tienes conductor para tu traslado. Ábrelo para seguirlo en vivo.', url: '/' });
        }
        if (moved.length && Api.auxiliarUserIdsForReservations && Api.sendPush) {
          const ids = await Api.auxiliarUserIdsForReservations(moved);
          if (ids.length) await Api.sendPush({ profileIds: ids,
            title: 'Te cambiamos el conductor 🔄',
            body: 'Tu traslado sigue en pie, pero lo atiende otro conductor. Ábrelo para ver quién es.', url: '/' });
        }
      } catch (_) {}
      // Push "ruta asignada" al CONDUCTOR de cada vuelta con conductor. Su
      // driverProfileId aquí es el id de PERFIL (lo que indexa las suscripciones
      // push), no el de driver_profiles. Best-effort, igual que el de arriba.
      try {
        const driverIds = [...new Set(lanes.map(l => l.driverProfileId).filter(Boolean))];
        if (driverIds.length && Api.sendPush) await Api.sendPush({
          profileIds: driverIds,
          title: 'Ruta asignada 🗺️',
          body: 'Se te asignó una ruta de traslados para tu turno. La verás al iniciar tu turno.',
          url: '/',
        });
      } catch (_) {}
    } catch (e) { toast('No se pudo publicar: ' + (e.message || 'error')); }
    $('#rt-saveBtn').innerHTML = '<svg class="icon"><use href="#i-save"/></svg>Publicar plan';
  }

  function rtOpenDrawer(laneId) {
    rt.drawerCar = laneId;
    const lane = rtLaneOf(laneId);
    const car = rtCarOf(lane);
    rt.pendingAM = car.driverAM || null;
    rt.pendingPM = car.driverPM || null;
    const hasDrv = car.driverAM || car.driverPM;
    // Franjas que cubre este carro; el drawer muestra un selector por cada una.
    const bands = rtBandsOfCar(car.id); if (!bands.length) bands.push(rtBandOf(lane));
    const pend = (b) => b === 'am' ? rt.pendingAM : rt.pendingPM;
    const driverSecs = bands.map(b => {
      const pool = rtPoolFor(b);
      const nota = rt.shiftLoaded ? `en turno ${b.toUpperCase()} (horario publicado)` : `turno ${b.toUpperCase()}`;
      const opts = pool.length
        ? pool.map(d => `<div class="drv-opt ${pend(b) === d.id ? 'sel' : ''}" data-rtdrv="${d.id}" data-rtband="${b}">
            <span class="av" style="background:${d.c || '#8895a7'}">${rtIni(d.n)}</span>
            <div class="info"><b>${d.n}</b><span>En ${nota}</span></div>
            <span class="tick"><svg class="icon" style="width:13px;height:13px"><use href="#i-check"/></svg></span>
          </div>`).join('')
        : `<p style="font-size:12.5px;color:var(--ink2)">Nadie en turno ${b.toUpperCase()} ese día en el horario publicado. Publica/ajusta el horario o cambia la hora de la vuelta.</p>`;
      return `<div class="dsec"><h3>${rtBandIcon(b)} Conductor ${b.toUpperCase()} · ${rtBandLabel(b)}</h3>${opts}</div>`;
    }).join('');
    const r = rtCarCompute(laneId);
    const semaPill = r.status === 'late' ? `<span class="spill late"><svg class="icon"><use href="#i-warn"/></svg>No llega</span>`
      : r.status === 'tight' ? `<span class="spill tight"><svg class="icon"><use href="#i-clock"/></svg>Ajustado</span>`
      : `<span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`;
    $('#rt-drawer').innerHTML = `
      <div class="dr-h"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
        <div><b>${car.id} · Vuelta ${lane.vuelta}</b><span>Ruta en ${hasDrv ? 'borrador con conductor' : 'borrador · sin conductor'}</span></div>
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
        ${driverSecs}
      </div>
      <div class="dr-f">
        <button class="btn ghost" data-rtclose>Cancelar</button>
        <button class="btn" data-rtconfirm><svg class="icon"><use href="#i-check"/></svg>${hasDrv ? 'Actualizar' : 'Confirmar ruta'}</button>
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
      if (e.target.closest('#rt-saveBtn')) { rtSavePlan(); return; }
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
      const dv = e.target.closest('[data-rtdrv]'); if (dv) {
        const band = dv.dataset.rtband;
        // toca de nuevo al ya seleccionado → lo quita (deja esa franja sin conductor)
        const cur = band === 'am' ? rt.pendingAM : rt.pendingPM;
        const val = (cur === dv.dataset.rtdrv) ? null : dv.dataset.rtdrv;
        if (band === 'am') rt.pendingAM = val; else rt.pendingPM = val;
        $('#rt-drawer').querySelectorAll(`.drv-opt[data-rtband="${band}"]`).forEach(o => o.classList.toggle('sel', val && o === dv));
        return;
      }
      if (e.target.closest('[data-rtconfirm]')) {
        const lane = rtLaneOf(rt.drawerCar); const car = lane && rtCarOf(lane);
        if (!car) { rtCloseDrawer(); return; }
        const bands = rtBandsOfCar(car.id);
        if (!bands.some(b => (b === 'am' ? rt.pendingAM : rt.pendingPM))) { toast('Elige al menos un conductor de una franja.'); return; }
        car.driverAM = rt.pendingAM || null; car.driverPM = rt.pendingPM || null;
        const names = bands.map(b => { const id = b === 'am' ? car.driverAM : car.driverPM; const d = id && rt.drivers.find(x => x.id === id); return d ? `${b.toUpperCase()} ${d.n.split(' ')[0]}` : null; }).filter(Boolean).join(' · ');
        rtCloseDrawer(); rtRenderAll(); toast(`${car.id} confirmada (${names || 'sin conductor'}).`); return;
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
    // Optimizar no tiene sentido sin nada que rutear.
    const opt = $('#rt-optBtn'); if (opt) opt.disabled = rt.source === 'empty';
  }
