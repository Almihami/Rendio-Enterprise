// admin-vuelos.js — Rutas › Planeación › Vuelos (0118 + 0122, 25-oct-2026).
//
// LAS LLEGADAS DEL DÍA, EN UNA PANTALLA
//   1. Tablero: una fila por vuelo de llegada — hora prevista, quiénes vienen,
//      de dónde, qué dice Flightradar24 (en tierra, en el aire, aterrizó) y el
//      retraso contra la hora prevista.
//   2. Mapa: dónde viene cada avión. La posición es ESTIMADA: con la hora de
//      despegue y la hora estimada de llegada que da FR24 se calcula qué tanto
//      del camino lleva, sobre la línea recta (círculo máximo) entre su
//      aeropuerto y JMC. Cuando FR24 trae una posición real (en las consultas en
//      vivo), se arranca desde ahí. El avión real no va en línea recta: la
//      pantalla lo dice.
//   3. Pegar la ruta: el plan del jefe tal como va por WhatsApp
//      («18:35 Paula londoño (JA5987)»). Se leen solo las llegadas (las que
//      traen un vuelo entre paréntesis) y quedan en flight_watches (0122): FR24
//      las sigue igual que una reserva y los jefes reciben el aviso si se mueven.
//
// De dónde sale cada cosa:
//   · flight_statuses (0099/0118): lo que guardó la Edge Function flight-status.
//   · flight_watches (0122): los vuelos pegados. Sin la migración, la parte de
//     pegar se apaga y lo demás sigue.
//   · Api.listReservationsAdmin: quién viene en cada vuelo según las reservas.
// No gasta créditos de FR24: el mapa se calcula aquí, con lo que ya está guardado.
//
// Módulo cerrado (IIFE): exporta window.renderVuelos y window.stopVuelosTimer
// (core.js → setTab). Para las pruebas: renderVuelos._leerPlan, ._posicion,
// ._aeropuerto, ._st.
(function () {
  'use strict';

  const MIN = 60000;
  const HORA = 60 * MIN;
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
  const aerolinea = (code) => AEROLINEA[String(code).slice(0, 2)] || '';

  const st = {
    dia: 'hoy',                 // 'hoy' | 'manana'
    vuelos: null,               // la lista armada (ver armar)
    flag: null, sin0122: false, err: null, cargando: false,
    cargadoEn: 0,
    mapa: null, capaRutas: null, capaAviones: null, encuadre: '',
    timerMapa: null, timerDatos: null,
    pegar: { abierto: false, texto: '', leidos: null, guardando: false, msg: '', err: false },
    sel: null,
  };

  // ── utilidades ───────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normCode = (c) => String(c || '').replace(/[\s-]/g, '').toUpperCase();
  const tms = (v) => (v == null || v === '' ? null : (typeof v === 'number' ? v : Date.parse(v)));
  // Colombia: -05:00 todo el año.
  const diaBog = (ms) => new Date(ms - 5 * HORA).toISOString().slice(0, 10);
  const hhmm = (ms) => (ms == null ? '—' : new Date(ms - 5 * HORA).toISOString().slice(11, 16));
  const sumarDias = (dia, n) => { const [y, m, d] = dia.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const diaSel = () => (st.dia === 'manana' ? sumarDias(diaBog(Date.now()), 1) : diaBog(Date.now()));
  const $r = () => document.getElementById('vu-root');

  // ── Leer el plan del jefe ───────────────────────────────────────────────────
  // «18:35 Paula londoño (JA5987)» → {hora, quién, vuelo}. Solo las llegadas: las
  // que traen un vuelo entre paréntesis. «21:10 Guillermo (Terra)» es una salida
  // (un conjunto) y «Debe estar 21:30» es su deadline: no se siguen.
  // Tolera los dedazos del WhatsApp (18;35, 13.45), el vuelo en minúscula o con
  // espacio (av 9563) y Wingo sin el 5 (P7617 → P57617). En una llegada, la hora
  // de la izquierda es la de ATERRIZAJE (scripts/planes-jefe/FORMATO.md).
  // Una hora antes de las 4 a. m. en un plan que también trae horas de la tarde es
  // de la madrugada siguiente (los turnos van de 2 a 2).
  function leerPlan(texto, dia) {
    const lineas = String(texto || '').split(/\r?\n/);
    const crudos = [];
    let salidas = 0, deadlines = 0;
    const raras = [];
    for (const l0 of lineas) {
      const l = l0.trim();
      if (!l) continue;
      if (/^(deben?\s+estar|estar)\b/i.test(l)) { deadlines++; continue; }
      const m = /^(\d{1,2})\s*[:;.,h]\s*(\d{2})\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$/i.exec(l);
      if (!m) { if (/^\d{1,2}\s*[:;.,]\s*\d{2}/.test(l)) raras.push(l); continue; }
      const h = Number(m[1]), mi = Number(m[2]);
      if (h > 23 || mi > 59) { raras.push(l); continue; }
      let code = normCode(m[4]);
      if (/^P\d{4}$/.test(code)) code = 'P5' + code.slice(1);
      // Lo mismo que la base puede consultar (flight_status_targets): sigla + número.
      if (!/^[A-Z]{1,3}[0-9]{2,5}$/.test(code)) { salidas++; continue; }
      crudos.push({ h, mi, quien: m[3].replace(/\s+/g, ' ').trim(), code });
    }
    const hayTarde = crudos.some((x) => x.h >= 12);
    const porCodigo = new Map();
    for (const x of crudos) {
      const d = (x.h < 4 && hayTarde) ? sumarDias(dia, 1) : dia;
      const ms = Date.parse(`${d}T${String(x.h).padStart(2, '0')}:${String(x.mi).padStart(2, '0')}:00-05:00`);
      const k = x.code + '|' + d;
      const ya = porCodigo.get(k);
      if (ya) {
        if (!ya.quienes.includes(x.quien)) ya.quienes.push(x.quien);
        if (ms < ya.ms) ya.ms = ms;
      } else porCodigo.set(k, { code: x.code, ms, dia: d, quienes: [x.quien] });
    }
    const vuelos = [...porCodigo.values()].sort((a, b) => a.ms - b.ms)
      .map((v) => ({ code: v.code, ms: v.ms, dia: v.dia, hora: hhmm(v.ms), label: v.quienes.join(', ').slice(0, 200) }));
    return { vuelos, salidas, deadlines, raras };
  }

  // ── Dónde va el avión (estimado) ────────────────────────────────────────────
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
  // v = un vuelo armado (ver armar). Devuelve null si no se puede ubicar.
  //   {lat, lon, rumbo, frac, en:'aire'|'tierra'|'jmc', real:boolean, llegaMs}
  function posicion(v, now) {
    const s = v.st;
    if (!s) return null;
    const origen = aeropuerto(s.origin_icao);
    if (s.status === 'scheduled') return origen ? { lat: origen.lat, lon: origen.lon, rumbo: rumbo(origen, JMC), frac: 0, en: 'tierra', real: false, llegaMs: null } : null;
    if (s.status === 'landed') return { lat: JMC.lat, lon: JMC.lon, rumbo: 0, frac: 1, en: 'jmc', real: false, llegaMs: tms(s.actual_at) };
    if (s.status !== 'in_air') return null;
    // Arranque: la posición real de FR24 si es de hace menos de 40 min; si no, el
    // aeropuerto de origen a la hora de despegue.
    const pv = (s.raw && s.raw.vuelo) || {};
    const pts = tms(pv.timestamp);
    let ini = null, t0 = null, real = false;
    if (Number.isFinite(Number(pv.lat)) && Number.isFinite(Number(pv.lon)) && pts && now - pts < 40 * MIN && now >= pts) {
      ini = { lat: Number(pv.lat), lon: Number(pv.lon) }; t0 = pts; real = true;
    } else if (origen && tms(s.departed_at)) {
      ini = origen; t0 = tms(s.departed_at);
    }
    if (!ini) return null;
    // Llegada: la ETA de FR24; sin ella, el despegue + la distancia a 780 km/h + 10 min.
    let t1 = tms(s.estimated_at);
    if (!t1 || t1 <= t0) t1 = t0 + (distKm(ini, JMC) / 780) * HORA + 10 * MIN;
    const frac = Math.max(0, Math.min(0.985, (now - t0) / (t1 - t0)));
    const p = enCamino(ini, JMC, frac);
    return { lat: p.lat, lon: p.lon, rumbo: rumbo(p, JMC), frac, en: 'aire', real, llegaMs: t1 };
  }

  // ── Los datos ───────────────────────────────────────────────────────────────
  async function leerEstados(dia) {
    const cli = window.sb;
    if (!cli || typeof cli.from !== 'function') return [];
    const base = 'flight_code, flight_date, direction, sched_at, estimated_at, actual_at, status, delay_min, source, fetched_at';
    const q = (cols) => cli.from('flight_statuses').select(cols).eq('direction', 'airport_to_home').eq('flight_date', dia);
    let { data, error } = await q(base + ', departed_at, origin_icao, poll_mode, raw');
    if (error) ({ data, error } = await q(base));   // sin 0118
    return error || !Array.isArray(data) ? [] : data;
  }
  async function leerPegados(dia) {
    const cli = window.sb;
    if (!cli || typeof cli.from !== 'function') return { rows: [], falta: true };
    const { data, error } = await cli.from('flight_watches').select('id, flight_code, flight_date, sched_at, label, source').eq('flight_date', dia).order('sched_at');
    if (error) return { rows: [], falta: /flight_watches|does not exist|schema cache/i.test(error.message || '') };
    return { rows: data || [], falta: false };
  }
  async function leerReservas(dia) {
    if (!window.Api || typeof Api.listReservationsAdmin !== 'function') return [];
    let rows = null;
    try { rows = await Api.listReservationsAdmin(1, 2); } catch (_) { rows = null; }
    return (rows || []).filter((r) => r.type === 'lle' && !r.cancelledAt && r.flight && diaBog(tms(r.when)) === dia);
  }

  // Una fila por vuelo: lo que dicen las reservas, los pegados y FR24 juntos.
  // «Paula Londoño» (la reserva) y «Paula londoño» (el plan) son la misma persona.
  const claveNombre = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const agregarNombre = (lista, n) => { if (n && !lista.some((x) => claveNombre(x) === claveNombre(n))) lista.push(n); };

  function armar(estados, pegados, reservas) {
    const m = new Map();
    const de = (code) => {
      const k = normCode(code);
      if (!m.has(k)) m.set(k, { code: k, ref: null, quienes: [], reservas: 0, pegado: null, st: null });
      return m.get(k);
    };
    for (const r of reservas) {
      const v = de(r.flight); v.reservas++;
      agregarNombre(v.quienes, r.name);
      const t = tms(r.when); if (t && (v.ref == null || t < v.ref)) v.ref = t;
    }
    for (const w of pegados) {
      const v = de(w.flight_code); v.pegado = w;
      if (w.label) w.label.split(/\s*,\s*/).forEach((q) => agregarNombre(v.quienes, q));
      const t = tms(w.sched_at); if (t && (v.ref == null || t < v.ref)) v.ref = t;
    }
    for (const s of estados) {
      const v = de(s.flight_code); v.st = s;
      if (v.ref == null) v.ref = tms(s.sched_at);
    }
    return [...m.values()].sort((a, b) => (a.ref || 0) - (b.ref || 0) || a.code.localeCompare(b.code));
  }

  async function cargar(silencio) {
    if (st.cargando) return;
    st.cargando = true; st.err = null;
    if (!silencio) pintar();
    try {
      st.flag = (window.Api && typeof Api.flightApiEnabled === 'function') ? await Api.flightApiEnabled() : null;
      const dia = diaSel();
      const [estados, peg, reservas] = await Promise.all([leerEstados(dia), leerPegados(dia), leerReservas(dia)]);
      st.sin0122 = peg.falta;
      st.vuelos = armar(estados, peg.rows, reservas);
      st.cargadoEn = Date.now();
    } catch (e) {
      st.err = 'No se pudieron leer los vuelos: ' + ((e && e.message) || e);
    } finally {
      st.cargando = false;
      pintar();
    }
  }

  // ── Cómo va cada vuelo (texto y color) ──────────────────────────────────────
  // tono: ok · warn · bad · info · muted (los del chip de vuelos.css).
  function estado(v, now) {
    const s = v.st, ref = v.ref;
    const origen = s && aeropuerto(s.origin_icao);
    const desde = origen ? origen.city : (s && s.origin_icao) || '';
    if (!s) {
      if (ref && now < ref - 2 * HORA) return { txt: 'Se empieza a seguir a las ' + hhmm(ref - 2 * HORA), tono: 'muted', grupo: 'pendiente' };
      if (ref && now > ref + 3 * HORA) return { txt: 'FR24 no lo vio', tono: 'bad', grupo: 'sindato' };
      return { txt: 'Esperando a Flightradar24', tono: 'muted', grupo: 'pendiente' };
    }
    if (s.status === 'unknown') {
      if (ref && now > ref + 3 * HORA) return { txt: 'No apareció en Flightradar24', tono: 'bad', grupo: 'sindato' };
      return { txt: 'FR24 todavía no lo ve', tono: 'muted', grupo: 'sindato' };
    }
    if (s.status === 'scheduled') return { txt: 'En tierra' + (desde ? ' en ' + desde : ''), tono: 'info', grupo: 'tierra' };
    if (s.status === 'diverted') return { txt: 'Desviado', tono: 'bad', grupo: 'desviado' };
    if (s.status === 'landed') return { txt: 'Aterrizó ' + hhmm(tms(s.actual_at)), tono: 'ok', grupo: 'aterrizo' };
    if (s.status === 'in_air') {
      const eta = tms(s.estimated_at);
      return { txt: 'En el aire' + (eta ? ' · llega ' + hhmm(eta) : ''), tono: 'info', grupo: 'aire' };
    }
    return { txt: s.status, tono: 'muted', grupo: 'otro' };
  }
  function retraso(v) {
    const d = v.st && v.st.delay_min;
    if (d == null || !v.st || v.st.status === 'diverted' || v.st.status === 'unknown') return null;
    if (d >= 15) return { txt: '+' + d + ' min', tono: d >= 30 ? 'bad' : 'warn', tarde: true };
    if (d <= -10) return { txt: (-d) + ' min antes', tono: 'info', tarde: false };
    return { txt: 'a tiempo', tono: 'ok', tarde: false };
  }
  const chip = (txt, tono) => `<span class="rvu-chip rvu-chip--${tono}">${esc(txt)}</span>`;

  // ── Pintar ──────────────────────────────────────────────────────────────────
  function esqueleto(root) {
    root.innerHTML = `
      <div class="set-card" id="vu-card">
        <div class="set-ch">
          <div class="set-ci"><svg class="icon"><use href="#m-vuelos"/></svg></div>
          <div class="vu-ch-tx">
            <h2>Llegadas del día</h2>
            <p id="vu-resumen">Cargando…</p>
          </div>
          <div class="set-seg3" id="vu-dias" role="tablist" aria-label="Qué día ver">
            <button data-vu="dia" data-dia="hoy" role="tab">Hoy</button>
            <button data-vu="dia" data-dia="manana" role="tab">Mañana</button>
          </div>
        </div>
        <div class="set-cb">
          <div id="vu-aviso"></div>
          <div class="vu-grid">
            <div class="vu-mapcol">
              <div class="zn-map vu-map" id="vu-map"></div>
              <p class="set-hint vu-maphint">Posición <b>estimada</b>: sale de la hora de despegue y la hora estimada de llegada que da Flightradar24, sobre la línea recta hasta JMC. El avión real no va en línea recta. <span id="vu-act"></span></p>
            </div>
            <div class="vu-listcol">
              <div id="vu-lista"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="set-card" id="vu-pegar-card">
        <div class="set-ch">
          <div class="set-ci"><svg class="icon"><use href="#i-doc"/></svg></div>
          <div class="vu-ch-tx">
            <h2>Pegar la ruta</h2>
            <p>Los vuelos del plan de WhatsApp que no están como reserva en la app. Se siguen igual: desde 2 h antes de su hora, y los jefes reciben el aviso si se mueven 15 min o más.</p>
          </div>
          <button class="set-btn sm ghost" data-vu="pegar-toggle" id="vu-pegar-toggle">Pegar</button>
        </div>
        <div class="set-cb" id="vu-pegar"></div>
      </div>`;
  }

  function pintar() {
    const root = $r(); if (!root) return;
    if (!root.querySelector('#vu-card')) esqueleto(root);
    root.querySelectorAll('#vu-dias button').forEach((b) => b.classList.toggle('on', b.dataset.dia === st.dia));
    const now = Date.now();
    const aviso = root.querySelector('#vu-aviso');
    const lista = root.querySelector('#vu-lista');
    const resumen = root.querySelector('#vu-resumen');
    const act = root.querySelector('#vu-act');

    aviso.innerHTML = st.flag === false
      ? `<div class="vu-banner">El seguimiento de vuelos está <b>apagado</b> (app_settings.flight_api_enabled): no se consulta Flightradar24 y no sale ningún aviso. Lo que se ve aquí es lo último que se guardó.</div>`
      : st.err ? `<div class="vu-banner err">${esc(st.err)}</div>` : '';

    if (!st.vuelos) {
      resumen.textContent = st.cargando ? 'Cargando…' : '—';
      lista.innerHTML = `<div class="vu-vacio">${st.cargando ? 'Cargando los vuelos…' : ''}</div>`;
    } else {
      const vs = st.vuelos;
      const g = vs.map((v) => ({ v, e: estado(v, now), r: retraso(v) }));
      const n = (fn) => g.filter(fn).length;
      const partes = [
        `${vs.length} ${vs.length === 1 ? 'llegada' : 'llegadas'}`,
        n((x) => x.e.grupo === 'aire') ? `${n((x) => x.e.grupo === 'aire')} en el aire` : '',
        n((x) => x.e.grupo === 'aterrizo') ? `${n((x) => x.e.grupo === 'aterrizo')} aterrizaron` : '',
        n((x) => x.r && x.r.tarde) ? `${n((x) => x.r && x.r.tarde)} con retraso` : '',
        n((x) => x.e.grupo === 'sindato') ? `${n((x) => x.e.grupo === 'sindato')} sin dato` : '',
      ].filter(Boolean);
      resumen.textContent = (st.dia === 'manana' ? 'Mañana · ' : 'Hoy · ') + partes.join(' · ');
      lista.innerHTML = vs.length ? g.map(({ v, e, r }) => fila(v, e, r)).join('') : `<div class="vu-vacio">No hay llegadas con vuelo para ${st.dia === 'manana' ? 'mañana' : 'hoy'}: ni reservas en la app ni vuelos pegados.<br><button class="set-btn sm" data-vu="pegar-abrir">Pegar la ruta</button></div>`;
    }
    const ult = (st.vuelos || []).map((v) => tms(v.st && v.st.fetched_at)).filter(Boolean).sort((a, b) => b - a)[0];
    act.textContent = ult ? 'Último dato de Flightradar24: ' + hhmm(ult) + '.' : '';
    pintarMapa(now);
    pintarPegar();
  }

  function fila(v, e, r) {
    const s = v.st;
    const origen = s && aeropuerto(s.origin_icao);
    const real = s && s.status === 'landed' ? tms(s.actual_at) : s && s.status === 'in_air' ? tms(s.estimated_at) : null;
    const quienes = v.quienes.length ? v.quienes.join(', ') : '—';
    const marca = [v.reservas ? `${v.reservas} ${v.reservas === 1 ? 'reserva' : 'reservas'}` : '', v.pegado ? 'pegado' : ''].filter(Boolean).join(' · ');
    return `<div class="vu-row${st.sel === v.code ? ' sel' : ''}${r && r.tarde ? ' tarde' : ''}" data-vu="sel" data-code="${esc(v.code)}">
      <div class="vu-hora"><b>${hhmm(v.ref)}</b><span>prevista</span></div>
      <div class="vu-main">
        <div class="vu-l1"><b class="vu-code">${esc(v.code)}</b><span class="vu-air">${esc(aerolinea(v.code))}</span>${origen ? `<span class="vu-orig">desde ${esc(origen.city)}</span>` : (s && s.origin_icao ? `<span class="vu-orig">desde ${esc(s.origin_icao)}</span>` : '')}</div>
        <div class="vu-l2">${esc(quienes)}</div>
        <div class="vu-l3">${chip(e.txt, e.tono)}${r ? chip(r.txt, r.tono) : ''}${real ? `<span class="vu-real">${s.status === 'landed' ? 'real' : 'estimada'} ${hhmm(real)}</span>` : ''}</div>
      </div>
      <div class="vu-side">
        <span class="vu-src">${esc(marca)}</span>
        ${v.pegado ? `<button class="vu-x" data-vu="quitar" data-id="${esc(v.pegado.id)}" title="Dejar de seguir este vuelo pegado" aria-label="Quitar ${esc(v.code)}">×</button>` : ''}
      </div>
    </div>`;
  }

  // ── El mapa ─────────────────────────────────────────────────────────────────
  function iniciarMapa() {
    if (st.mapa) return true;
    const el = document.getElementById('vu-map');
    if (!el) return false;
    if (typeof L === 'undefined') { el.innerHTML = '<div class="zn-mapa-falla">No se pudo cargar el mapa (sin conexión).</div>'; return false; }
    const map = L.map(el, { scrollWheelZoom: true, worldCopyJump: true }).setView([6.5, -75], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(map);
    st.capaRutas = L.layerGroup().addTo(map);
    st.capaAviones = L.layerGroup().addTo(map);
    L.marker([JMC.lat, JMC.lon], { icon: L.divIcon({ className: 'vu-jmc', html: '<span>JMC</span>', iconSize: [44, 22], iconAnchor: [22, 11] }), zIndexOffset: 500, keyboard: false })
      .bindTooltip('Aeropuerto José María Córdova · Rionegro').addTo(map);
    st.mapa = map;
    return true;
  }
  const AVION = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
  function iconoAvion(v, p, tono) {
    // El dibujo apunta al norte: se gira con el rumbo.
    return L.divIcon({
      className: 'vu-plane vu-plane--' + tono + (p.en === 'tierra' ? ' quieto' : ''),
      html: `<span class="vu-plane-ic" style="transform:rotate(${Math.round(p.rumbo)}deg)">${AVION}</span><span class="vu-plane-tx">${esc(v.code)}</span>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
  }
  function pintarMapa(now) {
    if (!iniciarMapa()) return;
    st.capaRutas.clearLayers();
    st.capaAviones.clearLayers();
    // Encuadre: los aviones en el aire y JMC. Un origen lejano (Lima, Madrid) no
    // entra: alejaría tanto el mapa que los aviones quedarían encima de JMC; su
    // línea punteada sí se ve salir del mapa. Sin aviones en el aire, los que están
    // en tierra en su aeropuerto.
    const enAire = [], enTierra = [];
    for (const v of st.vuelos || []) {
      const s = v.st; if (!s) continue;
      const p = posicion(v, now);
      const e = estado(v, now), r = retraso(v);
      const origen = aeropuerto(s.origin_icao);
      if (origen && (s.status === 'in_air' || s.status === 'scheduled')) {
        const linea = []; for (let i = 0; i <= 32; i++) { const q = enCamino(origen, JMC, i / 32); linea.push([q.lat, q.lon]); }
        L.polyline(linea, { color: '#475569', weight: 2, opacity: 0.6, dashArray: '5 7', interactive: false }).addTo(st.capaRutas);
        L.circleMarker([origen.lat, origen.lon], { radius: 3, color: '#64748B', weight: 1, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(st.capaRutas);
      }
      if (!p || p.en === 'jmc') continue;
      const tono = r && r.tarde ? r.tono : (p.en === 'tierra' ? 'muted' : 'info');
      const det = [`<b>${esc(v.code)}</b> ${esc(aerolinea(v.code))}`, origen ? 'desde ' + esc(origen.city) : '', esc(e.txt), r ? esc(r.txt) : '',
        'prevista ' + hhmm(v.ref), v.quienes.length ? esc(v.quienes.join(', ')) : '',
        p.en === 'aire' ? (p.real ? 'posición real de FR24 de hace poco, proyectada' : 'posición estimada') : ''].filter(Boolean).join('<br>');
      L.marker([p.lat, p.lon], { icon: iconoAvion(v, p, tono), zIndexOffset: st.sel === v.code ? 900 : 600, keyboard: false })
        .bindTooltip(det, { direction: 'top', offset: [0, -10] })
        .on('click', () => { st.sel = v.code; pintar(); const el = document.querySelector(`#vu-lista [data-code="${CSS.escape(v.code)}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); })
        .addTo(st.capaAviones);
      (p.en === 'aire' ? enAire : enTierra).push([p.lat, p.lon]);
    }
    // Solo cuando cambia QUÉ hay en el mapa (no a cada movimiento): así el jefe
    // puede acercarse o moverlo sin que se le devuelva cada 20 s.
    const puntos = [[JMC.lat, JMC.lon]].concat(enAire.length ? enAire : enTierra);
    const clave = st.dia + '|' + enAire.length + '|' + enTierra.length;
    if (clave !== st.encuadre) {
      st.encuadre = clave;
      if (puntos.length > 1) st.mapa.fitBounds(puntos, { padding: [40, 40], maxZoom: 8 });
      else st.mapa.setView([JMC.lat, JMC.lon], 6);
    }
  }
  function ajustarMapa() { setTimeout(() => { try { st.mapa && st.mapa.invalidateSize(); } catch (_) { /* */ } }, 80); }

  // ── Pegar la ruta ───────────────────────────────────────────────────────────
  function pintarPegar() {
    const box = document.getElementById('vu-pegar');
    const tg = document.getElementById('vu-pegar-toggle');
    if (!box) return;
    const p = st.pegar;
    if (st.sin0122) {
      if (tg) tg.hidden = true;
      box.innerHTML = '<p class="set-hint">Falta la migración 0122 en esta base: todavía no se pueden pegar vuelos.</p>';
      return;
    }
    if (tg) { tg.hidden = false; tg.textContent = p.abierto ? 'Cerrar' : 'Pegar'; }
    const pegados = (st.vuelos || []).filter((v) => v.pegado);
    const lista = pegados.length
      ? `<p class="vu-sub">Pegados para ${st.dia === 'manana' ? 'mañana' : 'hoy'}: ${pegados.map((v) => `<b>${esc(v.code)}</b> ${hhmm(tms(v.pegado.sched_at))}`).join(' · ')}</p>`
      : '';
    const msg = p.msg ? `<p class="vu-msg${p.err ? ' err' : ''}">${esc(p.msg)}</p>` : '';
    if (!p.abierto) { box.innerHTML = msg + lista; box.hidden = !(msg || lista); return; }
    box.hidden = false;
    const leido = p.leidos;
    const prev = leido ? (leido.vuelos.length
      ? `<div class="vu-prev">
          <div class="vu-prev-h">${leido.vuelos.length} ${leido.vuelos.length === 1 ? 'vuelo' : 'vuelos'} de llegada${leido.salidas ? ` · ${leido.salidas} ${leido.salidas === 1 ? 'salida ignorada' : 'salidas ignoradas'}` : ''}</div>
          ${leido.vuelos.map((v) => `<div class="vu-prev-r"><b>${esc(v.hora)}</b><span class="vu-code">${esc(v.code)}</span><span>${esc(v.label)}</span>${v.dia !== diaSel() ? `<span class="vu-src">${v.dia === sumarDias(diaSel(), 1) ? 'madrugada siguiente' : esc(v.dia)}</span>` : ''}</div>`).join('')}
          ${leido.raras.length ? `<p class="set-hint">No entendí ${leido.raras.length === 1 ? 'esta línea' : 'estas líneas'}: ${leido.raras.map((x) => '«' + esc(x) + '»').join(', ')}</p>` : ''}
        </div>`
      : `<p class="set-hint err">No encontré ninguna llegada. Las llegadas van así: <b>18:35 Paula londoño (JA5987)</b> — la hora, quién, y el vuelo entre paréntesis.</p>`) : '';
    box.innerHTML = `
      <label class="vu-lbl" for="vu-texto">El plan de ${st.dia === 'manana' ? 'mañana' : 'hoy'}, tal como va por WhatsApp</label>
      <textarea id="vu-texto" class="set-input vu-texto" rows="7" placeholder="18:35 Paula londoño (JA5987)&#10;18:40 Leslie (AV9563)&#10;&#10;21:10 Guillermo (Terra)&#10;Debe estar 21:30">${esc(p.texto)}</textarea>
      <div class="vu-acts">
        <button class="set-btn ghost" data-vu="leer"${p.guardando ? ' disabled' : ''}>Leer</button>
        <button class="set-btn" data-vu="guardar"${!leido || !leido.vuelos.length || p.guardando ? ' disabled' : ''}>${p.guardando ? 'Guardando…' : leido && leido.vuelos.length ? `Seguir ${leido.vuelos.length} ${leido.vuelos.length === 1 ? 'vuelo' : 'vuelos'}` : 'Seguir'}</button>
      </div>
      ${prev}
      ${msg}
      ${lista}`;
  }

  async function guardarPegados() {
    const p = st.pegar;
    const vs = (p.leidos && p.leidos.vuelos) || [];
    if (!vs.length || !window.sb) return;
    p.guardando = true; p.msg = ''; p.err = false; pintarPegar();
    try {
      const rows = vs.map((v) => ({ flight_code: v.code, sched_at: new Date(v.ms).toISOString(), label: v.label || null, source: 'pegado' }));
      const { error } = await window.sb.from('flight_watches').upsert(rows, { onConflict: 'organization_id,flight_code,flight_date' });
      if (error) throw error;
      p.msg = `Listo: ${vs.length} ${vs.length === 1 ? 'vuelo' : 'vuelos'}. Flightradar24 los sigue desde 2 h antes de su hora.`;
      p.leidos = null; p.texto = ''; p.abierto = false;
      await cargar(true);
    } catch (e) {
      p.err = true; p.msg = 'No se pudieron guardar: ' + ((e && e.message) || e);
    } finally {
      p.guardando = false; pintarPegar();
    }
  }

  async function quitar(id) {
    if (!id || !window.sb) return;
    const { error } = await window.sb.from('flight_watches').delete().eq('id', id);
    if (error) { st.err = 'No se pudo quitar: ' + error.message; pintar(); return; }
    await cargar(true);
  }

  // ── Eventos ─────────────────────────────────────────────────────────────────
  let enlazado = false;
  function enlazar(root) {
    if (enlazado) return;
    enlazado = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-vu]'); if (!b || !root.contains(b)) return;
      const a = b.dataset.vu;
      if (a === 'dia' && b.dataset.dia !== st.dia) { st.dia = b.dataset.dia; st.vuelos = null; st.encuadre = ''; st.sel = null; cargar(); }
      else if (a === 'pegar-toggle') { st.pegar.abierto = !st.pegar.abierto; st.pegar.msg = ''; pintarPegar(); if (st.pegar.abierto) setTimeout(() => document.getElementById('vu-texto')?.focus(), 30); }
      else if (a === 'pegar-abrir') { st.pegar.abierto = true; pintarPegar(); document.getElementById('vu-pegar-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => document.getElementById('vu-texto')?.focus(), 300); }
      else if (a === 'leer') { const t = document.getElementById('vu-texto'); st.pegar.texto = t ? t.value : ''; st.pegar.leidos = leerPlan(st.pegar.texto, diaSel()); st.pegar.msg = ''; pintarPegar(); }
      else if (a === 'guardar') guardarPegados();
      else if (a === 'quitar') { e.stopPropagation(); quitar(b.dataset.id); }
      else if (a === 'sel') {
        st.sel = st.sel === b.dataset.code ? null : b.dataset.code;
        const v = (st.vuelos || []).find((x) => x.code === b.dataset.code);
        const p = v && posicion(v, Date.now());
        if (st.sel && p && st.mapa) st.mapa.panTo([p.lat, p.lon]);
        pintar();
      }
    });
    root.addEventListener('input', (e) => { if (e.target.id === 'vu-texto') { st.pegar.texto = e.target.value; } });
  }

  // ── Relojes: el mapa se mueve cada 20 s; los datos se releen cada 2 min ────────
  function arrancarRelojes() {
    pararRelojes();
    st.timerMapa = setInterval(() => { if (document.getElementById('vu-map') && st.vuelos) pintarMapa(Date.now()); }, 20000);
    st.timerDatos = setInterval(() => { if ($r() && !document.hidden) cargar(true); }, 120000);
  }
  function pararRelojes() {
    if (st.timerMapa) clearInterval(st.timerMapa);
    if (st.timerDatos) clearInterval(st.timerDatos);
    st.timerMapa = st.timerDatos = null;
  }

  async function renderVuelos() {
    const root = $r(); if (!root) return;
    if (!root.querySelector('#vu-card')) esqueleto(root);
    enlazar(root);
    pintar();
    ajustarMapa();
    arrancarRelojes();
    await cargar(!!st.vuelos);
    ajustarMapa();
  }

  window.renderVuelos = renderVuelos;
  window.stopVuelosTimer = pararRelojes;
  // Para las pruebas (node / jsdom).
  window.renderVuelos._leerPlan = leerPlan;
  window.renderVuelos._posicion = posicion;
  window.renderVuelos._aeropuerto = aeropuerto;
  window.renderVuelos._armar = armar;
  window.renderVuelos._estado = estado;
  window.renderVuelos._st = st;
})();
