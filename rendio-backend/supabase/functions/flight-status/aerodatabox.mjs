// aerodatabox.mjs — adaptador PURO del proveedor de estado de vuelos (0099).
//
// Sin APIs de Deno ni de Node: solo funciones que reciben datos y devuelven
// datos. Lo importa la Edge Function (index.ts, Deno) y lo prueba node
// (scripts/_test-vuelos-parser.mjs) con los fixtures de ./fixtures. Si algún día
// se cambia de proveedor, este es el único archivo que cambia.
//
// PROVEEDOR: AeroDataBox vía RapidAPI.
//   GET https://aerodatabox.p.rapidapi.com/flights/number/{número}/{AAAA-MM-DD}
//       ?dateLocalRole=Both&withAircraftImage=false&withLocation=false
//   Headers: X-RapidAPI-Key, X-RapidAPI-Host: aerodatabox.p.rapidapi.com
//   (operationId GetFlight_FlightOnSpecificDate, «Flight Status (single day) /
//   TIER 2», especificación OpenAPI oficial: doc.aerodatabox.com →
//   openapi-rapidapi-v1.yaml, revisada el 11-oct-2026.)
//   dateLocal = fecha LOCAL de salida o de llegada; con dateLocalRole=Both (el
//   valor que el proveedor recomienda) trae el vuelo que salga O llegue ese día.
//   Respuesta 200 = ARREGLO de FlightContract (un número puede tener varios
//   tramos el mismo día, o venir repetido como código compartido). 204/404 = no
//   lo encontró.
//
//   FlightContract (lo que se usa):
//     number "AV 9563" · status (Unknown, Expected, EnRoute, CheckIn, Boarding,
//     GateClosed, Departed, Delayed, Approaching, Arrived, Canceled, Diverted,
//     CanceledUncertain) · codeshareStatus (Unknown, IsOperator, IsCodeshared)
//     departure / arrival: FlightAirportMovementContract
//       airport {icao, iata, name, timeZone, …}
//       scheduledTime · revisedTime («actual/estimada»; si hay runwayTime, es la
//       de la puerta) · predictedTime (experimental, NO se usa) · runwayTime
//       — cada una {utc, local}
//       terminal · gate · baggageBelt · quality [Basic | Live | Approximate]
//
//   OJO con el formato de las horas: la especificación solo dice «date-time».
//   Lo que el proveedor devuelve en la práctica es "2026-10-11 19:10Z" (utc) y
//   "2026-10-11 14:10-05:00" (local), que es lo que traen los fixtures; parseTime
//   acepta además la forma ISO con «T» y segundos, por si acaso. La primera
//   llamada real con la llave debe confirmarlo (docs/VUELOS.md).

export const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
export const MDE = Object.freeze({ iata: 'MDE', icao: 'SKRG' });

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Colombia no tiene horario de verano desde 1993: -05:00 todo el año.
const BOGOTA_OFFSET_MIN = -5 * 60;

// "av-9563" → "AV9563". Igual que flight_code_normalize (0099) en la base.
export function normalizeCode(code) {
  return String(code || '').replace(/[\s-]/g, '').toUpperCase();
}

// ¿Se le puede preguntar al proveedor? Necesita la sigla de la aerolínea:
// un «5116» pelado (reservas viejas) no identifica ningún vuelo.
export function isQueryable(code) {
  return /^[A-Z]{1,3}[0-9]{2,5}$/.test(normalizeCode(code));
}

export function buildRequest(code, dateLocal, { apiKey, host = RAPIDAPI_HOST } = {}) {
  const n = encodeURIComponent(normalizeCode(code));
  const d = encodeURIComponent(String(dateLocal || ''));
  return {
    url: `https://${host}/flights/number/${n}/${d}?dateLocalRole=Both&withAircraftImage=false&withLocation=false`,
    headers: { 'X-RapidAPI-Key': apiKey || '', 'X-RapidAPI-Host': host, Accept: 'application/json' },
  };
}

// Qué hacer con cada respuesta HTTP.
//   ok    → parsear       empty → el proveedor no tiene ese vuelo (se anota «unknown»)
//   auth  → la llave no sirve o el plan no incluye la API: se para TODA la corrida
//   rate  → se acabó la cuota o el límite por segundo: se para la corrida
//   retry → falla pasajera (5xx, red): no se guarda nada, la próxima vuelta reintenta
export function classifyHttp(status) {
  if (status === 200) return 'ok';
  if (status === 204 || status === 404 || status === 400 || status === 451) return 'empty';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  return 'retry';
}

// "2026-10-11 19:10Z" · "2026-10-11 14:10-05:00" · "2026-10-11T19:10:00.000Z" → ms
// Sin zona: se toma como UTC (solo se usa con el campo utc).
export function parseTime(s) {
  if (s == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(String(s).trim());
  if (!m) return null;
  let tz = (m[4] || 'Z').toUpperCase();
  if (tz !== 'Z' && !tz.includes(':')) tz = tz.slice(0, 3) + ':' + tz.slice(3);
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}${tz}`);
  return Number.isFinite(ms) ? ms : null;
}

// Una hora del proveedor ({utc, local}) → ms. Prefiere utc.
function timeOf(mv, key) {
  const t = mv && mv[key];
  if (!t) return null;
  if (typeof t === 'string') return parseTime(t);
  return parseTime(t.utc) ?? parseTime(t.local);
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function isMde(ap) {
  if (!ap) return false;
  return String(ap.iata || '').toUpperCase() === MDE.iata || String(ap.icao || '').toUpperCase() === MDE.icao;
}

// El lado del vuelo que nos importa: en una LLEGADA, la llegada a MDE; en una
// SALIDA, la salida de MDE.
export const sideOf = (direction) => (direction === 'airport_to_home' ? 'arrival' : 'departure');

// Entre los tramos que tocan MDE por el lado correcto, el más cercano a la hora
// de la reserva. En una salida, la reserva es la hora de PRESENTACIÓN (antes de
// despegar), así que se prefiere el que sale después de ella. Nada a más de 12 h:
// es otro día del mismo número.
export function pickLeg(legs, direction, refAt) {
  const side = sideOf(direction);
  const ref = typeof refAt === 'number' ? refAt : (refAt ? Date.parse(refAt) : null);
  const cands = (Array.isArray(legs) ? legs : []).filter(l => l && l[side] && isMde(l[side].airport));
  if (!cands.length) return null;
  let best = null, bestScore = Infinity;
  for (const l of cands) {
    const sched = timeOf(l[side], 'scheduledTime') ?? timeOf(l[side], 'revisedTime');
    let score;
    if (ref == null || !Number.isFinite(ref) || sched == null) score = 1e15;
    else {
      const diff = sched - ref;
      if (Math.abs(diff) > 12 * HOUR) continue;
      score = side === 'departure'
        ? (diff >= -60 * MIN ? diff : 1e13 + Math.abs(diff))
        : Math.abs(diff);
    }
    // El código compartido trae las mismas horas: a igualdad, el operador.
    if (l.codeshareStatus === 'IsCodeshared') score += 1;
    if (score < bestScore) { best = l; bestScore = score; }
  }
  return best;
}

// Lo que se guarda en flight_statuses a partir de la respuesta del proveedor.
// target: {flight_code, flight_date, direction, ref_at} (fila de flight_status_targets).
export function parseFlightStatus(body, target) {
  const legs = Array.isArray(body) ? body : (body && typeof body === 'object' && body.departure ? [body] : []);
  const dir = target && target.direction;
  const side = sideOf(dir);
  const leg = pickLeg(legs, dir, target && target.ref_at);
  if (!leg) {
    return {
      found: false, status: 'unknown', sched_at: null, estimated_at: null, actual_at: null,
      delay_min: null, terminal: null, gate: null,
      raw: { motivo: legs.length ? 'ningún tramo de ese número pasa por MDE a esa hora' : 'el proveedor no tiene ese vuelo ese día', tramos: legs.length },
    };
  }
  const mv = leg[side] || {};
  const st = String(leg.status || '').toLowerCase();
  const sched = timeOf(mv, 'scheduledTime');
  const revised = timeOf(mv, 'revisedTime');
  const runway = timeOf(mv, 'runwayTime');

  const cancelled = st === 'canceled' || st === 'cancelled' || st === 'canceleduncertain';
  const diverted = st === 'diverted';
  const arrived = st === 'arrived';
  const airborne = st === 'departed' || st === 'enroute' || st === 'approaching';

  // Lo REAL: en una llegada, solo cuando aterrizó; en una salida, cuando despegó.
  let actual = null;
  if (side === 'arrival' && arrived) actual = runway ?? revised;
  if (side === 'departure' && (airborne || arrived)) actual = runway ?? revised;
  const estimated = (cancelled || diverted) ? null : revised;
  const bestTime = actual ?? estimated;
  const delay = (cancelled || diverted || bestTime == null || sched == null) ? null : Math.round((bestTime - sched) / MIN);

  let status;
  if (cancelled) status = 'cancelled';
  else if (diverted) status = 'diverted';
  else if (arrived) status = 'landed';
  else if (airborne) status = 'in_air';
  else if (st === 'delayed' || (delay != null && delay >= 15)) status = 'delayed';
  else status = 'scheduled';

  return {
    found: true, status,
    sched_at: iso(sched), estimated_at: iso(estimated), actual_at: iso(actual),
    delay_min: delay,
    terminal: mv.terminal || null, gate: mv.gate || null,
    raw: leg,
  };
}

// La fila para public.flight_status_record(p_rows).
export function toRecord(target, parsed, source, http) {
  return {
    organization_id: target.organization_id,
    flight_code: normalizeCode(target.flight_code),
    flight_date: target.flight_date,
    direction: target.direction,
    sched_at: parsed.sched_at, estimated_at: parsed.estimated_at, actual_at: parsed.actual_at,
    status: parsed.status, delay_min: parsed.delay_min,
    terminal: parsed.terminal, gate: parsed.gate,
    source: source || 'aerodatabox',
    raw: Object.assign({}, parsed.raw || {}, http != null ? { _http: http } : {}),
  };
}

// AAAA-MM-DD + n días
export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Qué fechas preguntar. La reserva de una SALIDA es la presentación: con
// presentación a las 23:15 el vuelo puede despegar a las 00:30 del día siguiente,
// así que de noche (desde las 20:00) se pregunta también el día siguiente si el
// primero no trae el tramo.
export function queryDates(target) {
  const day = target.flight_date;
  if (target.direction === 'home_to_airport' && target.ref_at) {
    const ref = Date.parse(target.ref_at);
    const hourLocal = new Date(ref + BOGOTA_OFFSET_MIN * MIN).getUTCHours();
    if (hourLocal >= 20) return [day, addDays(day, 1)];
  }
  return [day];
}

// ── Modo prueba (FLIGHT_STATUS_MOCK=1) ─────────────────────────────────────
// Toma el fixture (respuesta real del proveedor, en ./fixtures) y lo corre en el
// tiempo para que su lado MDE caiga donde cae la reserva: en una llegada, el
// aterrizaje PROGRAMADO = la hora de la reserva (y el fixture trae 25 min de
// retraso); en una salida, el despegue programado = presentación + 90 min. Le
// pone el número del vuelo consultado. Así se prueba toda la cadena —consulta,
// guardado, aviso— sin llave y sin gastar cuota.
const pad = (n) => String(n).padStart(2, '0');
function fmtWith(ms, offMin) {
  const d = new Date(ms + offMin * MIN);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (offMin === 0) return base + 'Z';
  const s = offMin < 0 ? '-' : '+', a = Math.abs(offMin);
  return `${base}${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function offsetOf(local) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(local || '').trim());
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : BOGOTA_OFFSET_MIN;
}
function shiftTimes(node, deltaMs) {
  if (Array.isArray(node)) return node.map(x => shiftTimes(x, deltaMs));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.utc === 'string' && typeof node.local === 'string') {
    const u = parseTime(node.utc);
    if (u == null) return node;
    return { utc: fmtWith(u + deltaMs, 0), local: fmtWith(u + deltaMs, offsetOf(node.local)) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === 'lastUpdatedUtc' ? v : shiftTimes(v, deltaMs);
  return out;
}
export function mockBody(target, fixture) {
  const legs = JSON.parse(JSON.stringify(fixture || []));
  const side = sideOf(target.direction);
  const leg = legs.find(l => l && l[side] && isMde(l[side].airport));
  if (!leg) return legs;
  const sched = timeOf(leg[side], 'scheduledTime');
  const ref = Date.parse(target.ref_at);
  if (sched == null || !Number.isFinite(ref)) return legs;
  const want = side === 'arrival' ? ref : ref + 90 * MIN;
  const code = normalizeCode(target.flight_code);
  const m = /^([A-Z]{1,3})(\d+)$/.exec(code);
  return shiftTimes(legs, want - sched).map(l => Object.assign(l, { number: m ? `${m[1]} ${m[2]}` : code }));
}
