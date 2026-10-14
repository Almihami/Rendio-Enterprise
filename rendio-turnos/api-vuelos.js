// api-vuelos.js — estado de vuelos (0099, AeroDataBox). Extiende window.Api.
//
// Va DESPUÉS de api.js (index.html): le agrega a Api, sin tocar api.js:
//
//   Api.flightApiEnabled()            → true | false
//       app_settings.flight_api_enabled. false también si la migración 0099 no
//       está (la columna no existe): sin integración no se pinta nada.
//
//   Api.listFlightStatuses(day)       → [estado, …]
//       day = 'AAAA-MM-DD' (día de Bogotá) o un arreglo de días. Lo que la RLS
//       deje ver: jefes y conductores, todos los de su organización; el
//       tripulante, solo los de sus reservas. Error o tabla ausente → [].
//
//   Api.flightStatusFor(code, day, dir?) → estado | null
//       dir = 'lle' | 'sal' | 'airport_to_home' | 'home_to_airport' (opcional).
//
// «estado» (normalizado, en camelCase):
//   { code:'AV9563', day:'2026-10-11', direction:'airport_to_home', type:'lle',
//     status:'scheduled'|'delayed'|'in_air'|'landed'|'cancelled'|'diverted'|'unknown',
//     schedAt, estimatedAt, actualAt (ISO o null), delayMin (número o null),
//     terminal, gate, source:'aerodatabox'|'mock'|'manual', fetchedAt }
//   schedAt es la hora del lado MDE: aterrizaje en una llegada, despegue en una
//   salida. day es el día de Bogotá de la RESERVA (required_arrival_at): así
//   casa con la reserva, no con el vuelo.
//
// IIFE: no deja nombres globales (solo agrega a window.Api). `window.sb` se lee
// en cada llamada.
(function () {
  'use strict';

  const COLS = 'flight_code, flight_date, direction, sched_at, estimated_at, actual_at, status, delay_min, terminal, gate, source, fetched_at';

  const normCode = (c) => String(c || '').replace(/[\s-]/g, '').toUpperCase();
  const normDir = (d) => (d === 'lle' || d === 'airport_to_home') ? 'airport_to_home'
    : (d === 'sal' || d === 'home_to_airport') ? 'home_to_airport' : null;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

  function mapRow(r) {
    if (!r || !r.flight_code) return null;
    return {
      code: normCode(r.flight_code),
      day: String(r.flight_date || '').slice(0, 10),
      direction: r.direction,
      type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
      status: r.status || 'unknown',
      schedAt: r.sched_at || null,
      estimatedAt: r.estimated_at || null,
      actualAt: r.actual_at || null,
      delayMin: num(r.delay_min),
      terminal: r.terminal || null,
      gate: r.gate || null,
      source: r.source || null,
      fetchedAt: r.fetched_at || null,
    };
  }

  async function flightApiEnabled() {
    const cli = window.sb;
    if (!cli || typeof cli.from !== 'function') return false;
    try {
      const { data, error } = await cli.from('app_settings').select('flight_api_enabled').eq('id', 'singleton').maybeSingle();
      if (error || !data) return false;
      return data.flight_api_enabled === true;
    } catch (_) { return false; }
  }

  async function listFlightStatuses(day) {
    const days = (Array.isArray(day) ? day : [day]).map(d => String(d || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const cli = window.sb;
    if (!days.length || !cli || typeof cli.from !== 'function') return [];
    try {
      const { data, error } = await cli.from('flight_statuses').select(COLS).in('flight_date', [...new Set(days)]);
      if (error || !Array.isArray(data)) return [];
      return data.map(mapRow).filter(Boolean);
    } catch (_) { return []; }
  }

  async function flightStatusFor(code, day, dir) {
    const c = normCode(code), d = normDir(dir);
    if (!c) return null;
    const rows = await listFlightStatuses(day);
    return rows.find(r => r.code === c && (!d || r.direction === d)) || null;
  }

  // api.js carga antes (index.html). Sin él no hay a quién colgarle nada.
  if (!window.Api) { console.warn('api-vuelos.js: window.Api no existe (¿api.js no cargó?)'); return; }
  Object.assign(window.Api, { flightApiEnabled, listFlightStatuses, flightStatusFor });
})();
