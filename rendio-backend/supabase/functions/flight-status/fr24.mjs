// fr24.mjs — lector PURO de Flightradar24 (FR24 API) para flight-status (0118).
//
// Sin APIs de Deno ni de Node: funciones que reciben datos y devuelven datos, y
// un orquestador (run) al que se le pasa el «fetch» por parámetro. Lo importa la
// Edge Function (index.ts, Deno) y lo prueba node (scripts/_test-vuelos-fr24.mjs
// con los fixtures de ./fixtures, y scripts/_verify-0118.mjs contra la base con
// el calendario real de flight_status_targets).
//
// PROVEEDOR: FR24 API, https://fr24api.flightradar24.com/api (especificación
// OpenAPI oficial: /documentation/Flightradar24-API.yaml, revisada el
// 25-oct-2026). Headers obligatorios: Accept-Version: v1 · Authorization: Bearer.
//
//   GET /flight-summary/light   ?flights=AV9563,LA4025 (máx. 15)
//                               &flight_datetime_from=…Z&flight_datetime_to=…Z
//                               (filtran por first_seen; máx. 14 días)
//                               o ?flight_ids=<fr24_id>,… (máx. 15; sin fechas)
//       → {data:[{fr24_id, flight, callsign, orig_icao, datetime_takeoff,
//                 dest_icao, dest_icao_actual, datetime_landed, first_seen,
//                 last_seen, flight_ended, …}]}      SIN ETA · 1 crédito por vuelo
//   GET /live/flight-positions/full ?flights=… (máx. 15)
//       → {data:[{fr24_id, flight, lat, lon, alt, gspeed, timestamp, orig_icao,
//                 dest_iata, dest_icao, eta, …}]}    CON ETA · 8 créditos por vuelo
//   Una respuesta vacía cuesta 1 crédito. Explorer: 10 peticiones por minuto y
//   20 resultados por respuesta.
//
// LO QUE FR24 NO TIENE: horarios ni cancelaciones. Un vuelo existe en la API solo
// cuando el avión transmite. Por eso la hora «programada» (sched_at) es la de la
// RESERVA —en una llegada, la hora de aterrizaje que escribió el tripulante— y el
// retraso es ETA (o aterrizaje real) − esa hora. Un vuelo que no aparece queda
// «unknown»: nunca se inventa un estado.
//
// TÉRMINOS: prohibido mezclar o rellenar estos datos con otro proveedor (aquí no
// hay respaldo con AeroDataBox) y guardarlos más de 30 días (la base los purga,
// 0118).
//
// EL CALENDARIO lo decide la base (flight_status_targets, 0118): cada vuelo llega
// con su `mode`:
//   summary → «¿ya despegó?» antes del despegue, y «¿ya aterrizó?» cuando la ETA
//             ya llegó. Si se conoce su fr24_id se pregunta por flight_ids.
//   live    → en el aire: leer la ETA.
// Si en live el vuelo ya no aparece (o está en tierra), en la MISMA corrida se
// confirma con un summary (1 crédito) si aterrizó o se desvió.

export const API_HOST = 'https://fr24api.flightradar24.com';
export const MDE = Object.freeze({ iata: 'MDE', icao: 'SKRG' });
// Créditos (plan Explorer, 25-oct-2026).
export const COSTO = Object.freeze({ summary: 1, live: 8, vacia: 1 });
export const MAX_VUELOS_POR_PETICION = 15;
export const MAX_PETICIONES_POR_MIN = 10;
export const MAX_RESULTADOS = 20;
// Pausa entre una petición y la siguiente en la misma corrida. 25-oct, con el
// token real: dos peticiones seguidas pasaron y la quinta en ~2 min dio 429.
// 6,5 s = 10 por minuto parejas; una corrida de 9 peticiones tarda ~1 min.
export const MIN_GAP_MS = 6500;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// "av-9563" → "AV9563". Igual que flight_code_normalize (0099) en la base.
export function normalizeCode(code) {
  return String(code || '').replace(/[\s-]/g, '').toUpperCase();
}

// Necesita la sigla de la aerolínea: un «5116» pelado no identifica ningún vuelo.
export function isQueryable(code) {
  return /^[A-Z]{1,3}[0-9]{2,5}$/.test(normalizeCode(code));
}

// FR24 da las horas en UTC ISO ("2026-10-11T19:35:00Z"). Sin zona, se toma UTC.
export function parseTime(s) {
  if (s == null || s === '') return null;
  let t = String(s).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += 'Z';
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// ms → "AAAA-MM-DDTHH:MM:SSZ" (el formato que piden flight_datetime_from/_to).
export function fmtTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// ── Alias de siglas (app_settings.flight_code_aliases, 0118) ──────────────────
// {"JA": ["J6"]} = una reserva JA5116 se le pregunta a FR24 como J65116.
// {"JA": ["JA", "J6"]} = se preguntan las dos en la misma petición (se cobra por
// vuelo devuelto, no por número pedido). Sin alias se pregunta lo que escribió el
// tripulante. Las llaves van de 1 a 3 caracteres; la más larga que calce gana.
export function parseAliases(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeCode(k);
    if (!/^[A-Z0-9]{1,3}$/.test(key)) continue;
    const list = (Array.isArray(v) ? v : [v]).map(normalizeCode).filter(x => /^[A-Z0-9]{1,3}$/.test(x));
    if (list.length) out[key] = [...new Set(list)];
  }
  return out;
}

export function candidatesFor(code, aliases) {
  const c = normalizeCode(code);
  const map = parseAliases(aliases);
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const rest = c.slice(k.length);
    if (c.startsWith(k) && /^\d{1,5}$/.test(rest)) return [...new Set(map[k].map(p => p + rest))];
  }
  return [c];
}

// ── Petición ──────────────────────────────────────────────────────────────────
// req = {kind:'summary', flights:[…], from, to} | {kind:'summary', ids:[…]}
//     | {kind:'live', flights:[…]}
// sandbox: FR24 tiene un ambiente de prueba con datos FIJOS y llave propia; se
// llama agregando «sandbox» a la ruta (/api/sandbox/…). Confirmar la ruta exacta
// en el portal (Key management) la primera vez.
export function buildRequest(req, { token, sandbox = false, host = API_HOST } = {}) {
  const base = `${host}/api${sandbox ? '/sandbox' : ''}`;
  const lista = (xs) => xs.map(x => encodeURIComponent(x)).join(',');
  let url;
  if (req.kind === 'live') {
    url = `${base}/live/flight-positions/full?flights=${lista(req.flights)}`;
  } else if (req.ids && req.ids.length) {
    url = `${base}/flight-summary/light?flight_ids=${lista(req.ids)}`;
  } else {
    url = `${base}/flight-summary/light?flights=${lista(req.flights)}`
      + `&flight_datetime_from=${encodeURIComponent(fmtTime(req.from))}`
      + `&flight_datetime_to=${encodeURIComponent(fmtTime(req.to))}`;
  }
  return {
    url,
    headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${token || ''}` },
  };
}

// Qué hacer con cada respuesta HTTP.
//   ok      → leer                 empty → no encontró nada (404)
//   bad     → 400, la petición estaba mal: no se guarda nada, queda en errores
//   auth    → 401/403: el token no sirve — se para TODA la corrida
//   credits → 402: se acabaron los créditos del plan — se para la corrida
//   rate    → 429: más de 10 por minuto — se para la corrida
//   retry   → falla pasajera (5xx, red): no se guarda nada, la próxima vuelta reintenta
export function classifyHttp(status) {
  if (status === 200) return 'ok';
  if (status === 204 || status === 404) return 'empty';
  if (status === 400) return 'bad';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 429) return 'rate';
  return 'retry';
}

export function itemsOf(body) {
  if (body && Array.isArray(body.data)) return body.data;
  if (Array.isArray(body)) return body;
  return [];
}

// ── Lectura de un resultado ───────────────────────────────────────────────────
const up = (s) => (s == null ? '' : String(s).toUpperCase());
const esMde = (s) => s === MDE.icao || s === MDE.iata;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function legOf(item) {
  const it = item || {};
  return {
    fr24Id: it.fr24_id || null,
    code: normalizeCode(it.flight),
    orig: up(it.orig_icao || it.orig_iata) || null,
    dest: up(it.dest_icao || it.dest_iata) || null,
    destActual: up(it.dest_icao_actual || it.dest_iata_actual) || null,
    takeoff: parseTime(it.datetime_takeoff),
    landed: parseTime(it.datetime_landed),
    firstSeen: parseTime(it.first_seen),
    lastSeen: parseTime(it.last_seen),
    ended: it.flight_ended === true,
    eta: parseTime(it.eta),
    alt: num(it.alt),
    gspeed: num(it.gspeed),
    ts: parseTime(it.timestamp),
    item: it,
  };
}

const vaAMde = (l) => esMde(l.dest) || esMde(l.destActual);
// Iba para MDE y FR24 ya marca otro destino real.
const desviado = (l) => esMde(l.dest) && !!l.destActual && !esMde(l.destActual);

// Entre los resultados con un número que pedimos para este vuelo y que van (o
// iban) a MDE, el más cercano a la hora de la reserva. Fuera de rango = otro día
// u otro tramo del mismo número:
//   aterrizó / terminó → entre 3 h antes y 8 h después de la reserva;
//   en el aire con ETA → igual, con la ETA;
//   sin ETA (summary)  → visto por primera vez entre 16 h antes y 8 h después.
export function pickLeg(items, target, cands) {
  const ref = Date.parse(target && target.ref_at);
  const set = new Set((cands && cands.length ? cands : [target && target.flight_code]).map(normalizeCode));
  const own = normalizeCode(target && target.flight_code);
  let best = null, bestScore = Infinity;
  for (const it of Array.isArray(items) ? items : []) {
    const l = legOf(it);
    if (!set.has(l.code) || !vaAMde(l)) continue;
    let anchor, lo, hi;
    if (l.landed != null || l.ended) { anchor = l.landed ?? l.lastSeen; lo = -3 * HOUR; hi = 8 * HOUR; }
    else if (l.eta != null) { anchor = l.eta; lo = -3 * HOUR; hi = 8 * HOUR; }
    else { anchor = l.firstSeen ?? l.takeoff ?? l.ts; lo = -16 * HOUR; hi = 8 * HOUR; }
    let score;
    if (!Number.isFinite(ref) || anchor == null) score = 1e15;
    else {
      const d = anchor - ref;
      if (d < lo || d > hi) continue;
      score = Math.abs(d);
    }
    if (l.code !== own) score += 1;   // a igualdad, el número tal como lo escribió el tripulante
    if (score < bestScore) { best = l; bestScore = score; }
  }
  return best;
}

// En tierra según la posición en vivo (0 pies, casi quieto).
const enTierra = (l) => l.alt != null && l.alt <= 0 && (l.gspeed == null || l.gspeed < 50);

// Un vuelo visto en tierra que lleva más de esto «visto» sin hora de despegue se
// da por despegado (FR24 a veces no capta el despegue si la cobertura empieza en
// el aire). Ningún rodaje en el origen dura tanto.
export const TAKEOFF_INFER_MIN = 40;

// Estado a partir de un summary.
export function fromSummary(l, now) {
  if (l.landed != null || l.ended) {
    if (desviado(l)) return { status: 'diverted', departed: l.takeoff, actual: null };
    return {
      status: 'landed', departed: l.takeoff, actual: l.landed,
      motivo: l.landed == null ? 'el vuelo terminó sin hora de aterrizaje' : null,
    };
  }
  let departed = l.takeoff, inferido = false;
  if (departed == null && l.firstSeen != null && now - l.firstSeen > TAKEOFF_INFER_MIN * MIN) {
    departed = l.firstSeen;
    inferido = true;
  }
  if (departed != null) return desviado(l) ? { status: 'diverted', departed, actual: null } : { status: 'in_air', departed, inferido };
  return { status: 'scheduled' };   // el avión transmite en el origen, todavía en tierra
}

// Lo que se guarda (flight_status_record) para un vuelo, a partir de lo que se
// leyó. `st` = fromSummary(...) o {status:'in_air', eta} de live, o null = no
// apareció. El target trae lo último que la base sabía (departed_at,
// estimated_at, provider_ref): FR24 en summary no trae ETA, así que la última ETA
// se conserva (es dato del mismo proveedor).
export function toRecord(target, st, { leg = null, kind = 'summary', now, credits = 0, http = null, source = 'flightradar24' } = {}) {
  const ref = Date.parse(target.ref_at);
  const prevEst = parseTime(target.estimated_at);
  const prevDep = parseTime(target.departed_at);
  const base = {
    organization_id: target.organization_id,
    flight_code: normalizeCode(target.flight_code),
    flight_date: target.flight_date,
    direction: target.direction,
    sched_at: Number.isFinite(ref) ? iso(ref) : null,
    terminal: null, gate: null,
    source, poll_mode: kind, credits,
    fetched_at: iso(now),
  };
  if (!st) {
    return Object.assign(base, {
      status: 'unknown', estimated_at: null, actual_at: null, departed_at: null, delay_min: null,
      origin_icao: null, provider_ref: null, eta: null,
      raw: { motivo: 'FR24 no tiene ese vuelo ahora (todavía no transmite, o el número no es el que usa FR24)', pedido: kind, _http: http },
    });
  }
  const departed = st.departed ?? prevDep ?? null;
  let estimated = null;
  if (st.status === 'in_air') estimated = st.eta ?? prevEst;
  else if (st.status === 'landed') estimated = prevEst;
  const actual = st.status === 'landed' ? (st.actual ?? null) : null;
  const best = actual ?? estimated;
  const delay = (st.status === 'diverted' || best == null || !Number.isFinite(ref)) ? null : Math.round((best - ref) / MIN);
  return Object.assign(base, {
    status: st.status,
    estimated_at: iso(estimated), actual_at: iso(actual), departed_at: iso(departed),
    delay_min: delay,
    origin_icao: (leg && leg.orig) || null,
    provider_ref: (leg && leg.fr24Id) || target.provider_ref || null,
    eta: st.status === 'in_air' && st.eta != null ? iso(st.eta) : null,
    raw: Object.assign({ pedido: kind, _http: http }, leg ? { vuelo: leg.item } : {},
      st.inferido ? { despegue_inferido: true } : {}, st.motivo ? { motivo: st.motivo } : {}),
  });
}

// ── Orquestador de una corrida ────────────────────────────────────────────────
// targets: filas de flight_status_targets (0118): {organization_id, flight_code,
//   flight_date, direction, ref_at, mode, provider_ref, departed_at, estimated_at}
// opts.fetch(req) → {http, body, error?}   (req = buildRequest-able, ver arriba)
// Devuelve {rows, llamadas, creditos, errores, abortado}.
export async function run(targets, opts = {}) {
  const {
    fetch: doFetch,
    now = Date.now(),
    aliases = {},
    batch = MAX_VUELOS_POR_PETICION,
    maxRequests = MAX_PETICIONES_POR_MIN - 1,
    perMinute = MAX_PETICIONES_POR_MIN,
    minGapMs = 0,   // la Edge Function pasa MIN_GAP_MS; las pruebas, 0
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    clock = () => Date.now(),
    source = 'flightradar24',
  } = opts;
  const size = Math.max(1, Math.min(batch, MAX_VUELOS_POR_PETICION));
  const lista = (Array.isArray(targets) ? targets : []).filter(t => t && t.direction === 'airport_to_home' && isQueryable(t.flight_code));
  const out = { rows: [], llamadas: 0, creditos: 0, errores: [], abortado: null };
  const cands = new Map(lista.map(t => [t, candidatesFor(t.flight_code, aliases)]));
  const credit = new Map(lista.map(t => [t, 0]));
  const done = new Set();
  const sent = [];   // horas de las peticiones (para no pasar de 10 por minuto)

  let topado = false;
  async function pedir(req) {
    if (out.abortado) return null;
    if (out.llamadas >= maxRequests) {
      if (!topado) out.errores.push({ tope: `más de ${maxRequests} peticiones en una corrida; el resto queda para la próxima` });
      topado = true;
      return null;
    }
    const ultima = sent[sent.length - 1];
    if (ultima != null && minGapMs > 0 && clock() - ultima < minGapMs) await sleep(minGapMs - (clock() - ultima));
    const t0 = clock();
    const recientes = sent.filter(x => t0 - x < 60000);
    if (recientes.length >= perMinute) await sleep(60000 - (t0 - recientes[0]) + 200);
    sent.push(clock());
    out.llamadas++;
    let res;
    try { res = await doFetch(req); } catch (e) { res = { http: 0, body: null, error: String((e && e.message) || e) }; }
    const kind = classifyHttp(res.http);
    if (kind === 'auth') out.abortado = `FR24 rechazó el token (HTTP ${res.http})`;
    else if (kind === 'credits') out.abortado = 'Se acabaron los créditos del plan de FR24 (HTTP 402)';
    else if (kind === 'rate') out.abortado = 'Más de 10 peticiones por minuto a FR24 (HTTP 429)';
    const items = (kind === 'ok') ? itemsOf(res.body) : [];
    if (kind === 'ok' || kind === 'empty') out.creditos += items.length ? items.length * COSTO[req.kind] : COSTO.vacia;
    if (kind === 'bad' || kind === 'retry') out.errores.push({ pedido: req.kind, vuelos: req.flights || req.ids, http: res.http, error: res.error || null });
    const truncado = items.length >= MAX_RESULTADOS;
    if (truncado) out.errores.push({ pedido: req.kind, vuelos: req.flights || req.ids, aviso: `${items.length} resultados: puede venir cortada (máximo ${MAX_RESULTADOS} por respuesta)` });
    return { kind, items, http: res.http, truncado };
  }

  // Cada resultado cobra en el primer vuelo que lo pidió (dos organizaciones con
  // el mismo vuelo = una sola consulta, un solo cobro).
  function cobrar(grupo, items, kindReq) {
    for (const it of items) {
      const code = normalizeCode(it && it.flight);
      const t = grupo.find(x => cands.get(x).includes(code));
      if (t) credit.set(t, credit.get(t) + COSTO[kindReq]);
    }
  }

  // Parte la lista en peticiones de hasta `size` números (los candidatos de un
  // mismo vuelo van juntos; un mismo número se pide una vez).
  function chunks(grupo, keyOf) {
    const res = [];
    let cur = { targets: [], keys: [] };
    for (const t of grupo) {
      const ks = keyOf(t).filter(k => !cur.keys.includes(k));
      if (cur.keys.length && cur.keys.length + ks.length > size) { res.push(cur); cur = { targets: [], keys: [] }; }
      cur.targets.push(t);
      for (const k of keyOf(t)) if (!cur.keys.includes(k)) cur.keys.push(k);
    }
    if (cur.targets.length) res.push(cur);
    return res;
  }

  const emit = (t, st, extra) => {
    out.rows.push(toRecord(t, st, Object.assign({ now, credits: credit.get(t), source }, extra)));
    done.add(t);
  };

  // 1. En el aire → la ETA.
  const live = lista.filter(t => t.mode === 'live');
  const seguir = [];   // los que en live no aparecen (o están en tierra): se confirma con summary
  for (const ch of chunks(live, t => cands.get(t))) {
    const r = await pedir({ kind: 'live', flights: ch.keys });
    if (!r || r.kind === 'auth' || r.kind === 'credits' || r.kind === 'rate' || r.kind === 'bad' || r.kind === 'retry') continue;
    cobrar(ch.targets, r.items, 'live');
    for (const t of ch.targets) {
      const l = pickLeg(r.items, t, cands.get(t));
      if (l && !enTierra(l)) emit(t, { status: 'in_air', eta: l.eta }, { leg: l, kind: 'live', http: r.http });
      else seguir.push(t);
    }
  }

  // 2. «¿Ya despegó?» / «¿ya aterrizó?»: por fr24_id si se conoce; si no, por número.
  const summary = lista.filter(t => t.mode !== 'live').concat(seguir).filter(t => !done.has(t));
  const porId = summary.filter(t => t.provider_ref);
  const porNumero = summary.filter(t => !t.provider_ref);
  const procesar = (ch, r) => {
    cobrar(ch.targets, r.items, 'summary');
    for (const t of ch.targets) {
      const l = pickLeg(r.items, t, cands.get(t));
      if (l) emit(t, fromSummary(l, now), { leg: l, kind: 'summary', http: r.http });
      // Respuesta posiblemente cortada: no se anota «no apareció» (sería falso).
      else if (!r.truncado) emit(t, null, { kind: 'summary', http: r.http });
    }
  };
  for (const ch of chunks(porId, t => [t.provider_ref])) {
    const r = await pedir({ kind: 'summary', ids: ch.keys });
    if (!r || !(r.kind === 'ok' || r.kind === 'empty')) continue;
    // Un fr24_id que ya no devuelve nada (raro): se vuelve a buscar por número.
    const sinDato = ch.targets.filter(t => !pickLeg(r.items, t, cands.get(t)));
    procesar({ targets: ch.targets.filter(t => !sinDato.includes(t)) }, r);
    porNumero.push(...sinDato);
  }
  for (const ch of chunks(porNumero, t => cands.get(t))) {
    // first_seen del vuelo: entre unos minutos antes de despegar y ahora. 14 h
    // antes de la reserva alcanza para un Madrid–Rionegro y deja fuera el de ayer.
    const refs = ch.targets.map(t => Date.parse(t.ref_at)).filter(Number.isFinite);
    const to = now + 5 * MIN;
    const from = Math.min((refs.length ? Math.min(...refs) : now) - 14 * HOUR, to - HOUR);
    const r = await pedir({ kind: 'summary', flights: ch.keys, from, to });
    if (!r || !(r.kind === 'ok' || r.kind === 'empty')) continue;
    procesar(ch, r);
  }

  return out;
}

// ── Modo prueba (FLIGHT_STATUS_MOCK=1) ───────────────────────────────────────
// Un vuelo inventado por reserva, con la forma real de FR24 (fixtures), que
// avanza con el reloj: visto en tierra 15 min antes de despegar, despega, vuela
// `block` minutos con su ETA y aterriza. Por defecto despega 25 min tarde
// (block 60 → aterriza 25 min después de la hora de la reserva). Así se prueba
// la cadena entera —calendario, consulta, guardado, aviso— sin token ni créditos.
//   perfil: {block, delay, etaError (min de error de la ETA al despegar, se
//            achica hasta 0 al aterrizar), divert: 'SKBO', never: true,
//            noTakeoff: true (FR24 no capta el despegue)}
export const MOCK_DEFAULT = Object.freeze({ block: 60, delay: 25 });

function hash8(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function mockTimeline(target, perfil) {
  const p = Object.assign({}, MOCK_DEFAULT, perfil || {});
  const ref = Date.parse(target.ref_at);
  const takeoff = ref - p.block * MIN + p.delay * MIN;
  return {
    p, ref, takeoff,
    firstSeen: takeoff - 15 * MIN,
    landing: takeoff + p.block * MIN,
    fr24Id: hash8(`${normalizeCode(target.flight_code)}|${target.flight_date}`),
  };
}

// fetch falso: responde lo que FR24 respondería en `now` para estos targets.
// fixtures = {summary, live} (los JSON de ./fixtures). perfiles = {código: perfil}.
export function mockFetch(targets, { now = Date.now(), fixtures = {}, perfiles = {}, aliases = {} } = {}) {
  const tplS = itemsOf(fixtures.summary)[0] || {};
  const tplL = itemsOf(fixtures.live)[0] || {};
  const vuelos = (Array.isArray(targets) ? targets : []).map(t => ({ t, tl: mockTimeline(t, perfiles[normalizeCode(t.flight_code)]), cands: candidatesFor(t.flight_code, aliases) }));
  const callsign = (code) => String(tplS.operating_as || '') + code.replace(/^\D+/, '');
  return async (req) => {
    const data = [];
    for (const v of vuelos) {
      const { t, tl } = v;
      // El número con que FR24 lo conoce: el candidato pedido (alias incluido).
      const code = req.ids ? v.cands[0] : (req.flights || []).map(normalizeCode).find(f => v.cands.includes(f));
      const pedido = req.ids ? req.ids.includes(tl.fr24Id) : !!code;
      if (!pedido || tl.p.never) continue;
      if (req.kind === 'summary' && req.from != null && (tl.firstSeen < req.from || tl.firstSeen > req.to)) continue;
      if (now < tl.firstSeen) continue;
      const aterrizado = now >= tl.landing;
      const enAire = now >= tl.takeoff && !aterrizado;
      const destActual = tl.p.divert && now >= tl.takeoff + (tl.p.block / 2) * MIN ? tl.p.divert : 'SKRG';
      if (req.kind === 'live') {
        if (!(now >= tl.takeoff && now < tl.landing + 5 * MIN)) continue;
        const restante = Math.max(0, tl.landing - now);
        const etaErr = (tl.p.etaError || 0) * MIN * Math.min(1, restante / (tl.p.block * MIN));
        data.push(Object.assign({}, tplL, {
          fr24_id: tl.fr24Id, flight: code, callsign: callsign(code),
          alt: aterrizado ? 0 : 21000, gspeed: aterrizado ? 12 : 410,
          timestamp: fmtTime(now), dest_icao: destActual, dest_iata: destActual === 'SKRG' ? 'MDE' : null,
          eta: aterrizado ? null : fmtTime(tl.landing + etaErr),
        }));
      } else {
        data.push(Object.assign({}, tplS, {
          fr24_id: tl.fr24Id, flight: code, callsign: callsign(code),
          first_seen: fmtTime(tl.firstSeen),
          datetime_takeoff: (enAire || aterrizado) && !tl.p.noTakeoff ? fmtTime(tl.takeoff) : null,
          datetime_landed: aterrizado ? fmtTime(tl.landing) : null,
          last_seen: fmtTime(aterrizado ? tl.landing + 3 * MIN : now),
          flight_ended: aterrizado,
          dest_icao: 'SKRG', dest_icao_actual: destActual,
        }));
      }
    }
    return { http: 200, body: { data } };
  };
}
