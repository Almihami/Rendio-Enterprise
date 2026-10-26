// fixtures/rutas-v2-dia.js — un día de PRUEBA para Rutas › Asignación v2.
//
// Se evalúa DENTRO de la ventana (jsdom: window.eval(texto); Playwright:
// page.addInitScript({ path })) y deja window.RV2Fixture. NO es dato real:
// nombres, teléfonos y horas son inventados, y solo existen en las pruebas
// (_smoke-rutas-v2-dom.mjs y _capturas-rutas-v2.mjs). La app nunca lo carga.
//
// Los TIEMPOS están controlados para que cada estado salga a propósito:
// cada punto está a `x` minutos del aeropuerto sobre una línea, y el tramo
// entre dos puntos dura |xa − xb| + 2 min. Esa matriz se entrega por los dos
// caminos de rtBuildMatrix: Api.trafficMatrix (TomTom, al optimizar) y un
// fetch falso de la tabla de OSRM (al leer lo publicado, que no gasta TomTom).
// Para que salgan iguales, la prueba pone route_traffic_factor = 1.
// Con SERVICE_MIN 4 y AIRPORT_BUFFER 10 (los de siempre):
//
//   vuelta      tipo     sale   llega   pres.  margen  estado
//   V-01·V1     salida   03:45  04:37   05:00   +13    Lista (terminada)
//   V-01·V2     salida   04:45  06:39   06:30   −19    EN RIESGO
//   V-01·V3     llegada  15:20  aterriza 15:00   —     SIN CONDUCTOR (PM)
//   V-02·V1     salida   04:35  05:26   06:00   +24    Lista
//   V-02·V2     hotel    06:45  07:23   07:40    +7    Ajustada
//   V-02·V3     salida   10:00  11:04   11:30   +16    Lista
//   V-03·V1     salida   07:00  07:26   08:00   +24    Lista (en curso, Paula ya recogida)
//   V-03·V2     salida   07:40  08:44   09:00    +6    Ajustada
//   V-03·V3     llegada  16:30  aterriza 16:10   —     Lista
//   sin rutear: Manuela Franco (salida 09:10) y Kevin Uribe (llegada 15:05)
//
// La sugerencia esperada para V-01·V2: mover a Camila Ortiz a V-02 (la recoge
// 04:45): V-01 queda en +2 y V-02 en +3.
(function () {
  'use strict';
  const DAY = '2026-10-12';
  const AIRPORT = { lat: 6.170795254426601, lng: -75.42788741654356 };
  const DEPOT = { lat: 6.1537, lng: -75.3738 };

  // [clave, nombre, x (min a MDE), tipo, hora, conjunto, sector, teléfono, extras]
  const CREW = [
    ['A', 'Laura Gómez', 40, 'sal', '05:00', 'Olivar Apartamentos', 'Llanogrande', '3001110001'],
    ['B', 'Andrés Ruiz', 30, 'sal', '05:00', 'Río Vivo', 'Llanogrande', ''],
    ['C', 'José Ñáñez', 20, 'sal', '06:30', 'Cerezos', 'Rionegro', '3001110003'],
    ['D', 'Camila Ortiz', 50, 'sal', '06:30', 'Ébano', 'Marinilla', '3001110004'],
    ['E', 'Valentina Ríos', 45, 'sal', '06:00', 'Solare', 'Marinilla', '3001110005'],
    ['G', 'Sergio Molina', 10, 'sal', '07:40', 'Hotel Sandiego', 'Rionegro', '', { hotel: true }],
    ['H', 'Daniela Cano', 12, 'sal', '07:40', 'Piedemonte', 'Rionegro', '3001110008'],
    ['P', 'Paula Henao', 20, 'sal', '08:00', 'Fontibón', 'El Porvenir', '3001110009'],
    ['I', 'Mateo Zapata', 25, 'sal', '09:00', 'Cámbulo', 'El Porvenir', ''],
    ['J', 'Juliana Ossa', 23, 'sal', '09:00', 'Aurora', 'El Porvenir', '3001110011'],
    ['M', 'Felipe Vélez', 28, 'sal', '11:30', 'Altos del Lago', 'Llanogrande', '3001110012'],
    ['F', 'Natalia Duque', 25, 'lle', '15:00', 'Mirador', 'Rionegro', '3001110013', { vuelo: 'AV9412' }],
    ['K', 'Tomás Arias', 15, 'lle', '16:00', 'Guayacanes', 'Rionegro', '', { vuelo: 'AV9420' }],
    ['L', 'Sara Torres', 18, 'lle', '16:10', 'Arrayanes', 'Rionegro', '3001110015', { vuelo: 'AV9420' }],
    ['N', 'Manuela Franco', 24, 'sal', '09:10', 'Mangle', 'El Porvenir', '3001110016'],
    ['O', 'Kevin Uribe', 26, 'lle', '15:05', 'Laureles', 'Rionegro', '3001110017', { vuelo: 'AV9414' }],
  ];
  const PALETA = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9'];
  const key = (k) => 'r' + k;
  const rid = (k) => 'res-' + k;

  function crew() {
    const aux = {}, colors = {};
    CREW.forEach(([k, n, x, type, dl, zona, sector, tel, extra], i) => {
      aux[key(k)] = Object.assign({
        n, zona, sector, resId: null, zonaJefe: null, dir: zona + ', Rionegro',
        lat: 6 + x / 1000, lng: -75.4 - i * 0.0001, dl, pax: 1, type, reservationId: rid(k),
        tel, vuelo: '', tierra: false, notas: '', hotel: false,
      }, extra || {});
      colors[key(k)] = PALETA[i % PALETA.length];
    });
    return { aux, colors };
  }
  const CARS = () => [
    { id: 'V-01', avail0: '01:30', driver: null, capacity: 4, vehicleId: 'veh-1' },
    { id: 'V-02', avail0: '01:30', driver: null, capacity: 4, vehicleId: 'veh-2' },
    { id: 'V-03', avail0: '01:30', driver: null, capacity: 4, vehicleId: 'veh-3' },
  ];
  const DRIVERS = () => [
    { id: 'd1', n: 'Jorge Pérez', c: '#3B82F6', tel: '3015550101' },
    { id: 'd2', n: 'Luis Arango', c: '#0EA5A0', tel: '' },
    { id: 'd3', n: 'Carlos Mejía', c: '#8B5CF6', tel: '3015550103' },
    { id: 'd4', n: 'Diego Salazar', c: '#2563A8', tel: '3015550104' },
    { id: 'd5', n: 'Rubén Díaz', c: '#16936A', tel: '3015550105' },
  ];
  const SHIFT = () => ({
    am: [{ id: 'd1', n: 'Jorge Pérez' }, { id: 'd2', n: 'Luis Arango' }, { id: 'd3', n: 'Carlos Mejía' }],
    pm: [{ id: 'd4', n: 'Diego Salazar' }, { id: 'd5', n: 'Rubén Díaz' }],
    coordAm: [], coordPm: [],
  });
  // [carro, tipo, sale, paradas, conductor, estado de la ruta, atendidas]
  const VUELTAS = [
    ['V-01', 'sal', '03:45', ['A', 'B'], 'd1', 'completed', { A: 'picked_up', B: 'picked_up' }],
    ['V-01', 'sal', '04:45', ['D', 'C'], 'd1', 'planned'],
    ['V-01', 'lle', '15:20', ['F'], null, 'draft'],
    ['V-02', 'sal', '04:35', ['E'], 'd2', 'planned'],
    ['V-02', 'sal', '06:45', ['H', 'G'], 'd2', 'planned'],
    ['V-02', 'sal', '10:00', ['M'], 'd2', 'planned'],
    ['V-03', 'sal', '07:00', ['P'], 'd3', 'in_progress', { P: 'picked_up' }],
    ['V-03', 'sal', '07:40', ['I', 'J'], 'd3', 'planned'],
    ['V-03', 'lle', '16:30', ['K', 'L'], 'd4', 'planned'],
  ];
  // horas = { 'ra-N': { start: 'HH:MM', etas: { K: 'HH:MM' } } }: el plan quedó
  // publicado con ESAS horas (puestas a mano), no con las del modelo.
  function vueltas(horas = {}) {
    const drv = DRIVERS();
    return VUELTAS.map(([car, type, start, stops, d, status, hechas], i) => {
      const h = horas['ra-' + (i + 1)] || {};
      const map = (k, j) => ({ stopId: 'st-' + i + '-' + j, rid: rid(k), order: j + 1, status: (hechas && hechas[k]) || 'pending',
        etaAt: h.etas && h.etas[k] ? `${DAY}T${h.etas[k]}:00-05:00` : null });
      const todas = stops.map(map);
      return {
        id: 'ra-' + (i + 1), type, status, startAt: `${DAY}T${h.start || start}:00-05:00`,
        vehicleId: 'veh-' + car.slice(-1), carro: car, cap: 4,
        driverProfileId: d, conductor: d ? drv.find((x) => x.id === d).n : 'Sin conductor',
        pendientes: todas.filter((s) => s.status === 'pending'), atendidas: todas.filter((s) => s.status !== 'pending'),
      };
    });
  }
  // x de cada coordenada: el aeropuerto es 0, la base 10, los demás salen de la latitud.
  function xDe(p) {
    if (Math.abs(p.lat - AIRPORT.lat) < 1e-4 && Math.abs(p.lng - AIRPORT.lng) < 1e-4) return 0;
    if (Math.abs(p.lat - DEPOT.lat) < 1e-4) return 10;
    return Math.round((p.lat - 6) * 1000);
  }
  function matriz(coords) {
    const xs = coords.map(xDe);
    return { durations: xs.map((a, i) => xs.map((b, j) => (i === j ? 0 : Math.abs(a - b) + 2))), delays: [] };
  }
  // La tabla de OSRM (segundos) para las mismas coordenadas; lo demás, sin red.
  function osrm(url) {
    const m = String(url).match(/\/table\/v1\/driving\/([^?]+)/);
    if (!m) return null;
    const coords = m[1].split(';').map((p) => { const [lng, lat] = p.split(',').map(Number); return { lat, lng }; });
    return { code: 'Ok', durations: matriz(coords).durations.map((r) => r.map((v) => v * 60)) };
  }
  function instalarFetch(win) {
    const orig = win.fetch;
    win.fetch = async (url, o) => {
      const r = osrm(url);
      if (r) return { ok: true, json: async () => r };
      if (orig) return orig.call(win, url, o);
      throw new Error('sin red');
    };
  }

  // Reemplaza en `Api` SOLO lo que lee Asignación (todo en memoria). Devuelve
  // el registro de llamadas. opts.publicado = false → el día no tiene plan.
  function instalar(Api, opts = {}) {
    const log = { planning: [], publicados: [], saved: [], push: [], tomtom: 0 };
    const publicado = opts.publicado !== false;
    const dias = opts.dias || {};
    Api.listRoutePlanning = async (tipo, day) => {
      log.planning.push(day === undefined ? null : day);
      const d = day || DAY;
      if (d in dias && dias[d] === null) return null;
      if (d !== DAY) return null;
      const { aux, colors } = crew();
      return { aux, colors, cars: CARS(), drivers: DRIVERS(), plan: {}, source: 'live', day: DAY };
    };
    Api.getRouteTables = async () => null;
    Api.listDriversOnShift = async () => SHIFT();
    Api.getPublishedPlan = async (day, o) => {
      log.publicados.push({ day, estados: o && o.estados });
      if (!publicado || day !== DAY) return { day, vueltas: [], publicado: false };
      return { day, vueltas: vueltas(opts.horas), publicado: true };
    };
    Api.trafficMatrix = async (coords) => { log.tomtom++; return matriz(coords); };
    // Como el real (api.js · saveRoutePlan): «notify» trae solo las reservas que
    // cambiaron de conductor desde la publicación anterior, con el conductor nuevo.
    const antes = {};
    Api.saveRoutePlan = async (day, lanes) => {
      log.saved.push({ day, lanes: JSON.parse(JSON.stringify(lanes)) });
      const notify = [];
      lanes.forEach((l) => (l.stops || []).forEach((rid) => {
        if (l.driverProfileId && antes[rid] !== l.driverProfileId) notify.push({ reservationId: rid, changed: !!antes[rid], driverProfileId: l.driverProfileId });
        antes[rid] = l.driverProfileId || null;
      }));
      return { saved: lanes.length, skipped: 0, kept: 0, failed: 0, failMsg: '', notify };
    };
    Api.auxiliarUserIdsForReservations = async () => [];
    Api.sendPush = async (p) => { log.push.push(p); };
    return log;
  }

  window.RV2Fixture = { DAY, crew, CARS, DRIVERS, SHIFT, vueltas, matriz, instalar, instalarFetch, key };
})();
