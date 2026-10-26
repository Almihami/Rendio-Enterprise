// vuelos-ui.js — el chip de estado de un vuelo (0099) y su caché. window.RendioVuelos.
//
// CONTRATO (para conectarlo en Reservas, la pantalla del conductor y Asignación):
//
//   await RendioVuelos.cargar(day | [days], {force})  → [estado, …]
//       Trae (Api.listFlightStatuses) y guarda en caché los estados de esos días
//       de Bogotá ('AAAA-MM-DD'), 2 min. Si la integración está apagada
//       (app_settings.flight_api_enabled = false, o 0099 sin aplicar) devuelve []
//       y la caché queda vacía: no se pinta nada. Nunca lanza.
//
//   RendioVuelos.para(code, day, dir?)  → estado | null      (síncrono, de la caché)
//       day = día de Bogotá de la RESERVA (required_arrival_at); dir = 'lle' |
//       'sal' | 'airport_to_home' | 'home_to_airport'. Llamar después de cargar().
//
//   RendioVuelos.chip(estado)  → HTML ('' si no hay estado o es 'unknown')
//       <span class="rvu-chip rvu-chip--{ok|warn|bad|info|muted}" data-rvu-status=…
//             title="detalle">✈ AV9563 · 25 min tarde · 14:35</span>
//       Textos:  «AV9563 · a tiempo» · «· 25 min tarde · 14:35» · «· 10 min antes · 14:00»
//                «· en vuelo · 14:35» · «· aterrizó 14:31» · «· despegó 16:58» (salidas)
//                «· programado 14:10» (solo horario, sin dato en vivo) · «· retrasado · 14:12»
//                (el proveedor lo marca retrasado y la hora casi no se movió) · «· cancelado» · «· desviado»
//       El color acompaña al texto, nunca lo reemplaza. Si el dato viene del modo
//       prueba (source 'mock') lo dice: «· prueba». Si la integración dejó de
//       actualizar (más de 3 h sin consultar un vuelo que no ha terminado) lo
//       dice: «· sin actualizar desde 11:05».
//
//   RendioVuelos.texto(estado)  → el mismo texto, plano (sin ✈ ni HTML).
//   RendioVuelos.describir(estado, now) → {text, tone, title} | null (lo que pinta chip).
//   RendioVuelos.habilitada()   → true | false | null (null = todavía no se sabe).
//   RendioVuelos.limpiar()      → vacía la caché (p. ej. al cerrar sesión).
//
// DÓNDE VA EL AVIÓN (26-oct-2026: lo usan Rutas › Vuelos del jefe y el «Ver
// avión» del conductor; antes vivía solo en admin-vuelos.js):
//   RendioVuelos.posicion(estado, now) → {lat, lon, rumbo, frac, en:'aire'|'tierra'|'jmc', real, llegaMs} | null
//       ESTIMADA: con la hora de despegue y la ETA de FR24 se calcula qué tanto
//       del camino lleva, sobre el círculo máximo entre su aeropuerto y JMC; si
//       FR24 dio una posición real hace menos de 40 min, arranca desde ahí.
//       estado = { status, originIcao, departedAt, estimatedAt, actualAt, live:{lat, lon, timestamp} }.
//   RendioVuelos.aeropuerto(icao) → {code, city, iata, lat, lon} | null
//   RendioVuelos.aerolinea(code)  → 'Avianca' | … | ''
//   RendioVuelos.enCamino(a, b, f) → el punto a la fracción f del círculo máximo
//   RendioVuelos.JMC
//
// «estado» es el objeto de Api.listFlightStatuses (api-vuelos.js).
// Los estilos viven en vuelos.css. IIFE: solo exporta window.RendioVuelos.
(function () {
  'use strict';

  const TTL_MS = 2 * 60 * 1000;
  const FLAG_TTL_MS = 5 * 60 * 1000;
  const STALE_MS = 3 * 60 * 60 * 1000;
  const cache = new Map();   // día → { at, rows }
  let flag = { at: 0, value: null };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normCode = (c) => String(c || '').replace(/[\s-]/g, '').toUpperCase();
  const normDir = (d) => (d === 'lle' || d === 'airport_to_home') ? 'airport_to_home'
    : (d === 'sal' || d === 'home_to_airport') ? 'home_to_airport' : null;
  const hhmm = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try { return d.toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch (_) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  };

  // Bandera de la app ya cargada (state.settings) si la trae; si no, se pregunta.
  async function enabled(force) {
    if (!force && flag.value != null && Date.now() - flag.at < FLAG_TTL_MS) return flag.value;
    let v = null;
    try {
      const s = (typeof state !== 'undefined' && state && state.settings) || null;
      if (s && typeof s.flight_api_enabled === 'boolean') v = s.flight_api_enabled;
    } catch (_) { /* sin state global */ }
    if (v == null && window.Api && typeof Api.flightApiEnabled === 'function') {
      try { v = await Api.flightApiEnabled(); } catch (_) { v = false; }
    }
    flag = { at: Date.now(), value: v === true };
    return flag.value;
  }

  async function cargar(day, opts) {
    const force = !!(opts && opts.force);
    const days = [...new Set((Array.isArray(day) ? day : [day]).map(d => String(d || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
    if (!days.length) return [];
    if (!(await enabled(force))) { days.forEach(d => cache.set(d, { at: Date.now(), rows: [] })); return []; }
    const faltan = days.filter(d => force || !cache.has(d) || Date.now() - cache.get(d).at > TTL_MS);
    if (faltan.length && window.Api && typeof Api.listFlightStatuses === 'function') {
      let rows = [];
      try { rows = await Api.listFlightStatuses(faltan); } catch (_) { rows = []; }
      const now = Date.now();
      faltan.forEach(d => cache.set(d, { at: now, rows: rows.filter(r => r.day === d) }));
    }
    return days.flatMap(d => (cache.get(d) || { rows: [] }).rows);
  }

  function para(code, day, dir) {
    const c = normCode(code), d = String(day || '').slice(0, 10), dr = normDir(dir);
    if (!c || !d) return null;
    const hit = cache.get(d);
    if (!hit) return null;
    return hit.rows.find(r => r.code === c && (!dr || r.direction === dr)) || null;
  }

  const FINAL = ['landed', 'cancelled', 'diverted'];

  // {text, tone, title} de un estado. null = no se pinta nada.
  function describir(st, now) {
    if (!st || !st.code || !st.status || st.status === 'unknown') return null;
    const sal = st.direction === 'home_to_airport';
    const d = st.delayMin;
    const best = st.actualAt || st.estimatedAt || st.schedAt;
    let parts, tone;
    if (st.status === 'cancelled') { parts = ['cancelado']; tone = 'bad'; }
    else if (st.status === 'diverted') { parts = ['desviado']; tone = 'bad'; }
    else if (sal && (st.status === 'in_air' || st.status === 'landed')) { parts = ['despegó ' + hhmm(st.actualAt || best)]; tone = 'ok'; }
    else if (st.status === 'landed') { parts = ['aterrizó ' + hhmm(best)]; tone = 'ok'; }
    else if (d != null && d >= 5) { parts = [d + ' min tarde', hhmm(best)]; tone = d >= 30 ? 'bad' : 'warn'; }
    else if (d != null && d <= -5) { parts = [(-d) + ' min antes', hhmm(best)]; tone = 'info'; }
    else if (st.status === 'in_air') { parts = ['en vuelo', hhmm(best)]; tone = 'info'; }
    // El proveedor lo marca retrasado aunque la hora todavía no se mueva.
    else if (st.status === 'delayed') { parts = ['retrasado', hhmm(best)]; tone = 'warn'; }
    else if (d != null) { parts = ['a tiempo']; tone = 'ok'; }
    else { parts = ['programado ' + hhmm(st.schedAt)]; tone = 'muted'; }
    parts = parts.map(p => p.trim()).filter(Boolean);

    const fetched = st.fetchedAt ? new Date(st.fetchedAt).getTime() : null;
    const stale = fetched != null && !FINAL.includes(st.status) && !(sal && st.status === 'in_air') && (now - fetched) > STALE_MS;
    if (st.source === 'mock') parts.push('prueba');
    if (stale) parts.push('sin actualizar desde ' + hhmm(st.fetchedAt));

    const det = [
      'Vuelo ' + st.code + (sal ? ' · salida de JMC' : ' · llegada a JMC'),
      st.schedAt ? 'programada ' + hhmm(st.schedAt) : '',
      st.estimatedAt && !st.actualAt ? 'estimada ' + hhmm(st.estimatedAt) : '',
      st.actualAt ? (sal ? 'despegó ' : 'aterrizó ') + hhmm(st.actualAt) : '',
      st.terminal ? 'terminal ' + st.terminal : '',
      st.gate ? 'puerta ' + st.gate : '',
      st.fetchedAt ? 'actualizado ' + hhmm(st.fetchedAt) : '',
      st.source === 'mock' ? 'DATO DE PRUEBA (no es el vuelo real)' : st.source === 'aerodatabox' ? 'fuente: AeroDataBox' : '',
    ].filter(Boolean).join(' · ');
    return { text: st.code + ' · ' + parts.join(' · '), tone, title: det };
  }

  function texto(st) {
    const x = describir(st, Date.now());
    return x ? x.text : '';
  }

  function chip(st) {
    const x = describir(st, Date.now());
    if (!x) return '';
    return `<span class="rvu-chip rvu-chip--${x.tone}" data-rvu-status="${esc(st.status)}" data-rvu-code="${esc(st.code)}" title="${esc(x.title)}"><span aria-hidden="true">✈</span> ${esc(x.text)}</span>`;
  }

  function limpiar() { cache.clear(); flag = { at: 0, value: null }; }
  function habilitada() { return flag.value; }

  // ── Dónde va el avión (estimado) ────────────────────────────────────────────
  const MIN = 60000, HORA = 60 * MIN;
  const JMC = { code: 'SKRG', iata: 'MDE', city: 'JMC · Rionegro', lat: 6.1645, lon: -75.4231 };
  // Aeropuertos de donde llegan vuelos a JMC (ICAO → ciudad, IATA, coordenada
  // aproximada). Un origen que no esté aquí sale en el tablero pero no en el mapa.
  const AEROPUERTOS = {
    SKRG: ['JMC · Rionegro', 'MDE', 6.1645, -75.4231],
    SKBO: ['Bogotá', 'BOG', 4.7016, -74.1469], SKCG: ['Cartagena', 'CTG', 10.4424, -75.5130],
    SKBQ: ['Barranquilla', 'BAQ', 10.8896, -74.7808], SKSM: ['Santa Marta', 'SMR', 11.1196, -74.2306],
    SKCL: ['Cali', 'CLO', 3.5432, -76.3816], SKCC: ['Cúcuta', 'CUC', 7.9276, -72.5115],
    SKBG: ['Bucaramanga', 'BGA', 7.1265, -73.1848], SKPE: ['Pereira', 'PEI', 4.8127, -75.7395],
    SKAR: ['Armenia', 'AXM', 4.4528, -75.7664], SKMR: ['Montería', 'MTR', 8.8237, -75.8258],
    SKSP: ['San Andrés', 'ADZ', 12.5836, -81.7112], SKLT: ['Leticia', 'LET', -4.1935, -69.9432],
    SKRH: ['Riohacha', 'RCH', 11.5262, -72.9260], SKVP: ['Valledupar', 'VUP', 10.4350, -73.2495],
    SKPS: ['Pasto', 'PSO', 1.3962, -77.2915], SKNV: ['Neiva', 'NVA', 2.9502, -75.2940],
    SKVV: ['Villavicencio', 'VVC', 4.1679, -73.6138], SKYP: ['Yopal', 'EYP', 5.3191, -72.3840],
    SKUI: ['Quibdó', 'UIB', 5.6908, -76.6412], SKEJ: ['Barrancabermeja', 'EJA', 7.0243, -73.8068],
    SKIB: ['Ibagué', 'IBE', 4.4216, -75.1333], SKMZ: ['Manizales', 'MZL', 5.0296, -75.4647],
    SKCZ: ['Corozal', 'CZU', 9.3327, -75.2856], SKAS: ['Puerto Asís', 'PUU', 0.5053, -76.5008],
    SKMD: ['Medellín (Olaya Herrera)', 'EOH', 6.2205, -75.5906], SKPV: ['Providencia', 'PVA', 13.3569, -81.3583],
    MPTO: ['Panamá', 'PTY', 9.0714, -79.3835], SPJC: ['Lima', 'LIM', -12.0219, -77.1143],
    MDPC: ['Punta Cana', 'PUJ', 18.5674, -68.3634], MDSD: ['Santo Domingo', 'SDQ', 18.4297, -69.6689],
    MMUN: ['Cancún', 'CUN', 21.0365, -86.8771], MMMX: ['Ciudad de México', 'MEX', 19.4363, -99.0721],
    KMIA: ['Miami', 'MIA', 25.7959, -80.2870], KFLL: ['Fort Lauderdale', 'FLL', 26.0726, -80.1527],
    KMCO: ['Orlando', 'MCO', 28.4312, -81.3081], KJFK: ['Nueva York', 'JFK', 40.6413, -73.7781],
    KEWR: ['Newark', 'EWR', 40.6895, -74.1745], KATL: ['Atlanta', 'ATL', 33.6407, -84.4277],
    KIAH: ['Houston', 'IAH', 29.9902, -95.3368], KDFW: ['Dallas', 'DFW', 32.8998, -97.0403],
    LEMD: ['Madrid', 'MAD', 40.4983, -3.5676], LEBL: ['Barcelona', 'BCN', 41.2974, 2.0833],
    SVMI: ['Caracas', 'CCS', 10.6031, -66.9906], TNCA: ['Aruba', 'AUA', 12.5014, -70.0152],
    TNCC: ['Curazao', 'CUR', 12.1889, -68.9598], SEQM: ['Quito', 'UIO', -0.1292, -78.3575],
    SEGU: ['Guayaquil', 'GYE', -2.1574, -79.8837], MROC: ['San José', 'SJO', 9.9939, -84.2088],
    MSLP: ['San Salvador', 'SAL', 13.4409, -89.0557], MGGT: ['Guatemala', 'GUA', 14.5833, -90.5275],
    MUHA: ['La Habana', 'HAV', 22.9892, -82.4091], SBGR: ['São Paulo', 'GRU', -23.4356, -46.4731],
    SCEL: ['Santiago de Chile', 'SCL', -33.3930, -70.7858], SAEZ: ['Buenos Aires', 'EZE', -34.8222, -58.5358],
  };
  function aeropuerto(icao) {
    const a = AEROPUERTOS[String(icao || '').toUpperCase()];
    return a ? { code: String(icao).toUpperCase(), city: a[0], iata: a[1], lat: a[2], lon: a[3] } : null;
  }
  const AEROLINEA = { AV: 'Avianca', LA: 'LATAM', JA: 'JetSmart', J6: 'JetSmart', P5: 'Wingo', CM: 'Copa', QT: 'Avianca Cargo', '9R': 'Satena', VE: 'Clic' };
  const aerolinea = (code) => AEROLINEA[String(code || '').slice(0, 2)] || '';

  const tms = (v) => (v == null || v === '' ? null : (typeof v === 'number' ? v : Date.parse(v)));
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  function distKm(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Punto a la fracción f del círculo máximo entre a y b.
  function enCamino(a, b, f) {
    const p1 = rad(a.lat), l1 = rad(a.lon), p2 = rad(b.lat), l2 = rad(b.lon);
    const d = distKm(a, b) / 6371;
    if (d < 1e-6) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    return { lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)) };
  }
  function rumbo(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function posicion(e, now) {
    if (!e) return null;
    const origen = aeropuerto(e.originIcao);
    if (e.status === 'scheduled') return origen ? { lat: origen.lat, lon: origen.lon, rumbo: rumbo(origen, JMC), frac: 0, en: 'tierra', real: false, llegaMs: null } : null;
    if (e.status === 'landed') return { lat: JMC.lat, lon: JMC.lon, rumbo: 0, frac: 1, en: 'jmc', real: false, llegaMs: tms(e.actualAt) };
    if (e.status !== 'in_air') return null;
    // Arranque: la posición real de FR24 si es de hace menos de 40 min; si no, el
    // aeropuerto de origen a la hora de despegue.
    const pv = e.live || {};
    const pts = tms(pv.timestamp);
    let ini = null, t0 = null, real = false;
    if (Number.isFinite(Number(pv.lat)) && Number.isFinite(Number(pv.lon)) && pts && now - pts < 40 * MIN && now >= pts) {
      ini = { lat: Number(pv.lat), lon: Number(pv.lon) }; t0 = pts; real = true;
    } else if (origen && tms(e.departedAt)) {
      ini = origen; t0 = tms(e.departedAt);
    }
    if (!ini) return null;
    // Llegada: la ETA de FR24; sin ella, el despegue + la distancia a 780 km/h + 10 min.
    let t1 = tms(e.estimatedAt);
    if (!t1 || t1 <= t0) t1 = t0 + (distKm(ini, JMC) / 780) * HORA + 10 * MIN;
    const frac = Math.max(0, Math.min(0.985, (now - t0) / (t1 - t0)));
    const p = enCamino(ini, JMC, frac);
    return { lat: p.lat, lon: p.lon, rumbo: rumbo(p, JMC), frac, en: 'aire', real, llegaMs: t1 };
  }

  window.RendioVuelos = { cargar, para, chip, texto, describir, habilitada, limpiar, posicion, aeropuerto, aerolinea, enCamino, JMC };
})();
