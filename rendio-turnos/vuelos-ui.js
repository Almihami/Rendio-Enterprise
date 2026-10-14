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
//   RendioVuelos.habilitada()   → true | false | null (null = todavía no se sabe).
//   RendioVuelos.limpiar()      → vacía la caché (p. ej. al cerrar sesión).
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

  window.RendioVuelos = { cargar, para, chip, texto, habilitada, limpiar };
})();
