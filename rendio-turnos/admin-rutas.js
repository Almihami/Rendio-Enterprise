// admin-rutas.js — Admin: Asignación de rutas de auxiliares + asignador real (sectores, cupo, deadline).
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ---------------- ASIGNACIÓN (planeación de rutas) ----------------
  // Base de los carros y aeropuerto (coords reales del Oriente antioqueño).
  const RT_DEPOT = { lat: 6.1553, lng: -75.3739 };   // Rionegro centro (base)
  const RT_AIRPORT = { lat: 6.1645, lng: -75.4231 };  // MDE (José María Córdova)
  // DEMO con SECTORES REALES de Rionegro y coordenadas reales. Diseñado para que
  // se vea la lógica del asignador: racimos por sector (3 en San Antonio + 1
  // cercano = un carro de 4), respetando cupo y eligiendo el mejor orden.
  const RT_DEMO_AUX = {
    // San Antonio de Pereira (3) — racimo grande
    a1: { n: 'Mariana Rojas', zona: 'San Antonio de Pereira', lat: 6.1492, lng: -75.3585, dl: '05:15', pax: 1, type: 'sal' },
    a2: { n: 'Nicolás Herrera', zona: 'San Antonio de Pereira', lat: 6.1476, lng: -75.3602, dl: '05:15', pax: 1, type: 'sal' },
    a3: { n: 'Valentina Castro', zona: 'San Antonio de Pereira', lat: 6.1508, lng: -75.3569, dl: '05:25', pax: 1, type: 'sal' },
    // Cuatro Esquinas (1) — cerca de San Antonio → completa ese carro
    a4: { n: 'Daniela Restrepo', zona: 'Cuatro Esquinas', lat: 6.1445, lng: -75.3760, dl: '05:25', pax: 1, type: 'sal' },
    // Llanogrande (2)
    a5: { n: 'Mateo Arango', zona: 'Llanogrande', lat: 6.1480, lng: -75.4080, dl: '05:35', pax: 1, type: 'sal' },
    a6: { n: 'Sara Lucía Gómez', zona: 'Llanogrande', lat: 6.1506, lng: -75.4039, dl: '05:35', pax: 1, type: 'sal' },
    // Gualanday (1)
    a7: { n: 'Andrés F. Mora', zona: 'Gualanday', lat: 6.1700, lng: -75.4050, dl: '05:40', pax: 1, type: 'sal' },
    // El Porvenir (1) — más temprano
    a8: { n: 'Juan Camilo Díaz', zona: 'El Porvenir', lat: 6.1635, lng: -75.3850, dl: '05:05', pax: 1, type: 'sal' },
    // Marinilla (1) — lejos, al nororiente
    a9: { n: 'Laura Vélez', zona: 'Marinilla', lat: 6.1736, lng: -75.3376, dl: '05:45', pax: 1, type: 'sal' },
    // Fontibón (1)
    a10: { n: 'Camila Ortiz', zona: 'Fontibón', lat: 6.1380, lng: -75.3950, dl: '05:25', pax: 1, type: 'sal' },
    // Abreo (1)
    a11: { n: 'Diego Marín', zona: 'Abreo', lat: 6.1360, lng: -75.3520, dl: '05:15', pax: 1, type: 'sal' },
  };
  const RT_DEMO_COLORS = { a1: '#3B82F6', a2: '#0EA5A0', a3: '#8B5CF6', a4: '#2563A8', a5: '#16936A', a6: '#7C5CD6', a7: '#D98A12', a8: '#0EA5E9', a9: '#E2551A', a10: '#DB4B7A', a11: '#5B8A2B' };
  const RT_DEMO_CARS = [
    // Horas de salida realistas para el modelo honesto (manejo ×1.25 + 4 min/
    // parada + 10 min de entrega): RD-03 sale tarde a propósito para mostrar
    // la alerta y la reparación por deadline.
    { id: 'RD-01', start: '03:55', driver: null, capacity: 4 },
    { id: 'RD-02', start: '04:10', driver: null, capacity: 4 },
    { id: 'RD-03', start: '03:50', driver: null, capacity: 4 },
  ];
  const RT_DEMO_DRIVERS = [
    { id: 'd1', n: 'Carlos Roldán', turno: 'Mañana', c: '#2563A8' },
    { id: 'd2', n: 'Jefferson Cardona', turno: 'Mañana', c: '#7C5CD6' },
    { id: 'd3', n: 'Daniel Álvarez', turno: 'Mañana', c: '#16936A' },
    { id: 'd4', n: 'Juan Mery', turno: 'Mañana', c: '#0EA5E9' },
  ];

  const rt = {
    aux: {}, colors: {}, cars: [], drivers: [], plan: {},
    order: {}, pool: [], optimized: false, drawerCar: null, pendingDriver: null,
    tripType: 'sal', source: 'demo', bound: false, demoToasted: false,
    CAP: 4, AIRPORT_LEG: 16, MARGIN_TIGHT: 15, dragId: null, dragSrc: null,
    // ---- Modelo de tiempos (todo parametrizable desde Ajustes/app_settings) ----
    SERVICE_MIN: 4,      // min por parada: frenar, timbrar, subir gente y maletas
    AIRPORT_BUFFER: 10,  // min de colchón al entregar: bajar maletas + entrar a tiempo
    TRAFFIC_FACTOR: 1.25,// multiplica el tiempo de manejo (OSRM da flujo libre, sin tráfico)
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
    rt.order = {}; rt.cars.forEach(c => { rt.order[c.id] = []; });
    rt.pool = Object.keys(rt.aux);
    rt.optimized = false;
    rt.M = null;
  }

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

  function rtCarCompute(cid) {
    const car = rt.cars.find(c => c.id === cid);
    let t = rtToMin(car.start), prev = 'depot', stops = [], pax = 0, hardDL = Infinity;
    rt.order[cid].forEach(id => {
      t += rtLegMin(prev, id); pax += rt.aux[id].pax;
      stops.push({ id, eta: Math.round(t) }); // ETA = cuando el carro LLEGA a la parada
      t += rt.SERVICE_MIN; // subir gente + maletas antes de arrancar al siguiente
      hardDL = Math.min(hardDL, rtToMin(rt.aux[id].dl));
      prev = id;
    });
    const arrival = rt.order[cid].length ? Math.round(t + rtLegMin(prev, 'airport')) : null;
    // Holgura contra el deadline DESCONTANDO el colchón de entrega (bajar
    // maletas + entrar): llegar "justo" a la hora de presentación ES tarde.
    const holg = arrival != null ? hardDL - arrival - rt.AIRPORT_BUFFER : null;
    let status = 'empty';
    if (arrival != null) status = holg < 0 ? 'late' : (holg < rt.MARGIN_TIGHT ? 'tight' : 'ontime');
    // Hora de salida recomendada: lo más tarde que puede arrancar el carro y
    // aún entregar con colchón. Los carros ruedan ~24h — la hora de salida es
    // la palanca del despachador, no un dato fijo.
    const depart = arrival != null ? hardDL - rt.AIRPORT_BUFFER - (arrival - rtToMin(car.start)) : null;
    return { stops, pax, arrival, hardDL, holg, status, depart };
  }

  function rtDayStats() {
    let rut = 0, onTime = 0, routes = 0, late = 0;
    rt.cars.forEach(c => { const r = rtCarCompute(c.id); rut += rt.order[c.id].length; if (r.status !== 'empty') { routes++; if (r.status !== 'late') onTime++; else late++; } });
    return { rut, onTime, routes, late };
  }

  // Heurístico greedy para datos reales (sin plan precargado): ordena por
  // deadline y reparte respetando capacidad. El solver fino (OSRM/VROOM) lo afina.
  function rtComputePlan() {
    const ids = Object.keys(rt.aux).sort((a, b) => rtToMin(rt.aux[a].dl) - rtToMin(rt.aux[b].dl));
    const plan = {}; rt.cars.forEach(c => { plan[c.id] = []; });
    ids.forEach(id => {
      let best = null;
      rt.cars.forEach(c => {
        const used = plan[c.id].reduce((s, x) => s + rt.aux[x].pax, 0);
        if (used + rt.aux[id].pax <= rtCapOf(c) && (!best || plan[c.id].length < plan[best].length)) best = c.id;
      });
      if (best) plan[best].push(id);
    });
    return plan;
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

  // Distancia (min) entre dos racimos = tramo más corto entre sus paradas.
  function rtClusterDist(idsA, idsB) {
    let m = Infinity;
    idsA.forEach(x => idsB.forEach(y => { const d = rtLegMin(x, y); if (d < m) m = d; }));
    return m;
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
  function rtBestOrder(ids) {
    if (ids.length <= 1) return ids.slice();
    const scored = rtPermutations(ids).map(perm => {
      let t = 0, prev = 'depot';
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
  function rtRouteEval(carStart, ids) {
    if (!ids.length) return { arrival: null, minDL: Infinity, late: 0 };
    const ord = rtBestOrder(ids);
    let t = carStart, prev = 'depot';
    ord.forEach(id => { t += rtLegMin(prev, id) + rt.SERVICE_MIN; prev = id; });
    const arrival = t + rtLegMin(prev, 'airport');
    const minDL = Math.min(...ids.map(id => rtToMin(rt.aux[id].dl)));
    // "Tarde" = no alcanza el deadline con el colchón de entrega incluido.
    return { arrival, minDL, late: Math.max(0, arrival + rt.AIRPORT_BUFFER - minDL) };
  }
  const rtPaxOf = (ids) => ids.reduce((s, id) => s + rt.aux[id].pax, 0);
  const rtTotalLate = (cars) => cars.reduce((s, c) => s + rtRouteEval(rtToMin(c.start), c.ids).late, 0);

  // Asignador: agrupa por sector, empaca en carros respetando el cupo (rellena
  // con el sector MÁS CERCANO), y luego REPARA por deadline (prioridad #1: nunca
  // tarde) intercambiando paradas urgentes de un carro atrasado por paradas
  // holgadas de un carro a tiempo. Finalmente ordena cada carro por la mejor ruta.
  function rtSolve() {
    // 1) racimos por sector (los grandes primero; desempata por deadline)
    const byZona = {};
    Object.keys(rt.aux).forEach(id => { const z = rt.aux[id].zona; (byZona[z] = byZona[z] || []).push(id); });
    const clusters = Object.entries(byZona).map(([zona, ids]) => ({
      zona, ids: ids.slice(), pax: rtPaxOf(ids),
    })).sort((a, b) => b.pax - a.pax || rt.aux[a.ids[0]].dl.localeCompare(rt.aux[b.ids[0]].dl));
    const remaining = clusters.slice();
    const cars = rt.cars.map(c => ({ id: c.id, start: c.start, cap: rtCapOf(c), ids: [] }));
    // 2) empacar: cada carro arranca con el racimo más grande que quepa y se
    //    rellena con los sectores/paradas más cercanos hasta el cupo.
    cars.forEach(car => {
      const idx = remaining.findIndex(cl => cl.pax <= car.cap);
      if (idx < 0) return;
      car.ids.push(...remaining.splice(idx, 1)[0].ids);
      while (rtPaxOf(car.ids) < car.cap && remaining.length) {
        let best = -1, bestD = Infinity;
        remaining.forEach((cl, k) => { if (rtPaxOf(car.ids) + cl.pax > car.cap) return; const d = rtClusterDist(car.ids, cl.ids); if (d < bestD) { bestD = d; best = k; } });
        if (best < 0) break;
        car.ids.push(...remaining.splice(best, 1)[0].ids);
      }
    });
    // 3) si sobró demanda (más pasajeros que cupos), métela donde quepa
    remaining.forEach(cl => cl.ids.forEach(id => { const car = cars.find(c => rtPaxOf(c.ids) < c.cap); if (car) car.ids.push(id); }));
    // 4) REPARACIÓN por deadline: mientras un carro llegue tarde, intercambia su
    //    parada más urgente por una menos urgente de un carro a tiempo, si baja el atraso.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const lateCars = cars.filter(c => rtRouteEval(rtToMin(c.start), c.ids).late > 0)
        .sort((a, b) => rtRouteEval(rtToMin(b.start), b.ids).late - rtRouteEval(rtToMin(a.start), a.ids).late);
      for (const lc of lateCars) {
        const urgent = lc.ids.slice().sort((a, b) => rtToMin(rt.aux[a].dl) - rtToMin(rt.aux[b].dl))[0];
        const before = rtTotalLate(cars);
        for (const oc of cars) {
          if (oc.id === lc.id) continue;
          let done = false;
          for (const cand of oc.ids) {
            if (rtToMin(rt.aux[cand].dl) <= rtToMin(rt.aux[urgent].dl)) continue; // cand debe ser menos urgente
            const lcNew = lc.ids.filter(x => x !== urgent).concat(cand);
            const ocNew = oc.ids.filter(x => x !== cand).concat(urgent);
            if (rtPaxOf(lcNew) > lc.cap || rtPaxOf(ocNew) > oc.cap) continue;
            const after = rtTotalLate(cars.map(c => c.id === lc.id ? { ...c, ids: lcNew } : c.id === oc.id ? { ...c, ids: ocNew } : c));
            if (after < before) { lc.ids = lcNew; oc.ids = ocNew; changed = true; done = true; break; }
          }
          if (done) break;
        }
        if (changed) break;
      }
      if (!changed) break;
    }
    // 5) ordenar cada carro por la mejor ruta
    const plan = {};
    cars.forEach(car => { plan[car.id] = rtBestOrder(car.ids); });
    return plan;
  }

  function rtAuxCard(id) {
    const a = rt.aux[id];
    const tt = a.hotel ? 'hotel' : a.type;
    const ttl = a.hotel ? 'Hotel' : (a.type === 'sal' ? 'Salida' : 'Llegada');
    return `<div class="aux" draggable="true" data-aux="${id}" data-src="pool">
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
    return `<div class="stop ${overDL ? 'over-dl' : ''}" draggable="true" data-aux="${s.id}" data-src="${cid}">
      <div class="s-top"><span class="s-n">${idx + 1}</span><span class="s-av" style="background:${rt.colors[s.id] || '#888'}">${rtIni(a.n)}</span><span class="s-nm">${p[0]} ${p[1] ? p[1][0] + '.' : ''}</span></div>
      <div class="s-meta"><span class="s-zona">${a.zona}</span><span class="s-eta">${rtToHM(s.eta)}</span></div>
      <div class="s-dl"><svg class="icon" style="width:10px;height:10px"><use href="#i-clock"/></svg>pres. ${a.dl}${a.pax > 1 ? ' · ×' + a.pax : ''}</div>
    </div>`;
  }

  function rtLaneHTML(car) {
    const r = rtCarCompute(car.id);
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
    if (!rt.order[car.id].length) {
      body = `<div class="lane-empty" data-drop="${car.id}"><svg class="icon"><use href="#i-arrow"/></svg>Arrastra auxiliares aquí para armar la ruta de ${car.id}.</div>`;
    } else {
      const stops = r.stops.map((s, i) => rtStopHTML(car.id, s, i)).join('<span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span>');
      const apt = `<span class="arrow"><svg class="icon"><use href="#i-arrow"/></svg></span><div class="airport ${st}"><svg class="icon"><use href="#i-plane"/></svg><b>MDE</b><span class="arr">${rtToHM(r.arrival)}</span></div>`;
      body = `<div class="seq" data-drop="${car.id}">${stops}${apt}</div>`;
    }
    const assignBtn = rt.order[car.id].length
      ? `<button class="assignbtn ${!car.driver ? 'cta' : ''}" data-assign="${car.id}"><svg class="icon" style="width:14px;height:14px"><use href="#i-user"/></svg>${car.driver ? 'Cambiar conductor' : 'Asignar conductor'}</button>`
      : '';
    return `<div class="lane ${st}" data-lane="${car.id}">
      <div class="lane-h">
        <div class="car"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
          <div class="cinfo"><b>${car.id}</b>${drvHTML}</div></div>
        <div class="cap ${capFull ? 'full' : ''}"><span class="pips">${pips}</span>${r.pax}/${rtCapOf(car)}</div>
        <div class="sema">${sema}${assignBtn}</div>
      </div>
      ${body}
    </div>`;
  }

  function rtRenderLanes() { $('#rt-laneWrap').innerHTML = rt.cars.map(rtLaneHTML).join(''); }

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
    const plan = rtSolve(); // sectores + cupo + mejor orden
    clearInterval(iv); $('#rt-ovl').classList.remove('show');
    rt.order = {};
    rt.cars.forEach(c => { rt.order[c.id] = (plan[c.id] || []).slice(); });
    const placed = Object.values(rt.order).flat();
    rt.pool = Object.keys(rt.aux).filter(id => !placed.includes(id));
    rt.optimized = true;
    $('#rt-optBtn').innerHTML = '<svg class="icon"><use href="#i-bolt"/></svg>Re-optimizar';
    rtRenderAll();
    const s = rtDayStats();
    const how = src === 'osrm' ? 'tiempos reales OSRM' : 'distancia estimada';
    toast(s.late ? `Rutas optimizadas (${how}) — ${s.late} ajustada, revísala.` : `Rutas óptimas por sector y cercanía (${how}). Todas llegan a tiempo.`);
  }

  function rtOpenDrawer(cid) {
    rt.drawerCar = cid;
    const car = rt.cars.find(c => c.id === cid);
    rt.pendingDriver = car.driver;
    const r = rtCarCompute(cid);
    const semaPill = r.status === 'late' ? `<span class="spill late"><svg class="icon"><use href="#i-warn"/></svg>No llega</span>`
      : r.status === 'tight' ? `<span class="spill tight"><svg class="icon"><use href="#i-clock"/></svg>Ajustado</span>`
      : `<span class="spill ontime"><svg class="icon"><use href="#i-check"/></svg>A tiempo</span>`;
    $('#rt-drawer').innerHTML = `
      <div class="dr-h"><span class="cav"><svg class="icon"><use href="#i-van"/></svg></span>
        <div><b>${car.id}</b><span>Ruta en ${car.driver ? 'borrador con conductor' : 'borrador · sin conductor'}</span></div>
        <button class="x" data-rtclose><svg class="icon"><use href="#i-x"/></svg></button></div>
      <div class="dr-b">
        <div class="dsec"><h3>Resumen de la ruta</h3>
          <div class="sumcard">
            <div class="sumrow"><span class="k">Paradas</span><span class="v">${r.stops.length} · ${r.pax}/${rtCapOf(car)} pax</span></div>
            <div class="sumrow"><span class="k">Salida</span><span class="v mono">${car.start}</span></div>
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
        const car = rt.cars.find(c => c.id === cid);
        const cap = rtCapOf(car);
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
      const as = e.target.closest('[data-assign]'); if (as) { rtOpenDrawer(as.dataset.assign); return; }
      if (e.target === $('#rt-scrim') || e.target.closest('[data-rtclose]')) { rtCloseDrawer(); return; }
      const dv = e.target.closest('[data-rtdrv]'); if (dv) { rt.pendingDriver = dv.dataset.rtdrv; $('#rt-drawer').querySelectorAll('.drv-opt').forEach(o => o.classList.toggle('sel', o === dv)); return; }
      if (e.target.closest('[data-rtconfirm]')) {
        if (!rt.pendingDriver) { toast('Elige un conductor para confirmar.'); return; }
        const car = rt.cars.find(c => c.id === rt.drawerCar); if (car) car.driver = rt.pendingDriver;
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
        const bad = rt.cars.find(c => rtCarCompute(c.id).status === 'late');
        if (bad) { const el = root.querySelector(`[data-lane="${bad.id}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); toast(`${bad.id} no llega: mueve su última parada a un carro “A tiempo”.`); }
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
