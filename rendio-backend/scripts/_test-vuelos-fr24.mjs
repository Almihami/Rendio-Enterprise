// Prueba del lector de Flightradar24 (supabase/functions/flight-status/fr24.mjs)
// con los fixtures de la función (respuestas con la forma de la especificación
// oficial) y un «fetch» falso.
//
// Comprueba: horas, URL y headers (summary por número / por fr24_id, live,
// sandbox), qué hacer con cada HTTP (401/402/429/500), alias de siglas (JetSmart),
// el resultado correcto entre varios (destino MDE, otro tramo del mismo número,
// alias), los estados (en tierra, en el aire, despegue inferido, aterrizó,
// terminó sin hora, desviado, no aparece), retraso = ETA − hora de la reserva, y
// la corrida entera: agrupar hasta 15 números, un número pedido una sola vez para
// dos organizaciones, confirmar con summary el que ya no está en vivo, no pasar
// de 10 peticiones por minuto, tope por corrida, respuesta cortada, cobro de
// créditos; y el modo prueba (un vuelo falso que avanza con el reloj).
//
// LO QUE NO CUBRE: una llamada real a FR24 (no hay token), Deno ni la Edge
// Function entera (index.ts), la base (eso es _verify-0118.mjs).
//
//   cd rendio-backend && node scripts/_test-vuelos-fr24.mjs
import { readFileSync } from 'node:fs';
import * as fr from '../supabase/functions/flight-status/fr24.mjs';

const FX = new URL('../supabase/functions/flight-status/fixtures/', import.meta.url).pathname;
const summaryFx = JSON.parse(readFileSync(FX + 'fr24-summary-light.json', 'utf8'));
const liveFx = JSON.parse(readFileSync(FX + 'fr24-live-full.json', 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const MIN = 60000;

let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

// AV9563 BOG→MDE, la reserva dice que aterriza a las 14:10 Bogotá (19:10Z).
const REF = '2026-10-11T19:10:00.000Z';
const NOW = Date.parse('2026-10-11T19:06:00Z');
const LLE = { organization_id: 'org', flight_code: 'AV9563', flight_date: '2026-10-11', direction: 'airport_to_home', ref_at: REF, mode: 'live', provider_ref: null, departed_at: null, estimated_at: null };
const S = (o) => ({ data: [Object.assign(clone(summaryFx.data[0]), o || {})] });

console.log('\n── Horas ──');
eq('ISO con Z', fr.parseTime('2026-10-11T19:35:00Z'), Date.parse('2026-10-11T19:35:00Z'));
eq('sin zona = UTC', fr.parseTime('2026-10-11T19:35:00'), Date.parse('2026-10-11T19:35:00Z'));
eq('con espacio', fr.parseTime('2026-10-11 19:35:00Z'), Date.parse('2026-10-11T19:35:00Z'));
eq('null / vacío / basura → null', [fr.parseTime(null), fr.parseTime(''), fr.parseTime('mañana')], [null, null, null]);
eq('fmtTime sin milisegundos (lo que pide flight_datetime_from)', fr.fmtTime(Date.parse('2026-10-11T05:10:00.123Z')), '2026-10-11T05:10:00Z');

console.log('\n── Petición y HTTP ──');
{
  const from = Date.parse('2026-10-11T05:10:00Z'), to = Date.parse('2026-10-11T19:11:00Z');
  let rq = fr.buildRequest({ kind: 'summary', flights: ['AV9563', 'LA4025'], from, to }, { token: 'T' });
  eq('summary por número', rq.url, 'https://fr24api.flightradar24.com/api/flight-summary/light?flights=AV9563,LA4025&flight_datetime_from=2026-10-11T05%3A10%3A00Z&flight_datetime_to=2026-10-11T19%3A11%3A00Z');
  eq('headers: Accept-Version v1 + Bearer', [rq.headers['Accept-Version'], rq.headers.Authorization, rq.headers.Accept], ['v1', 'Bearer T', 'application/json']);
  rq = fr.buildRequest({ kind: 'summary', ids: ['3b4f1a2c', '39aa0001'] }, { token: 'T' });
  eq('summary por fr24_id (sin fechas)', rq.url, 'https://fr24api.flightradar24.com/api/flight-summary/light?flight_ids=3b4f1a2c,39aa0001');
  rq = fr.buildRequest({ kind: 'live', flights: ['AV9563'] }, { token: 'T' });
  eq('live full', rq.url, 'https://fr24api.flightradar24.com/api/live/flight-positions/full?flights=AV9563');
  rq = fr.buildRequest({ kind: 'live', flights: ['AV9563'] }, { token: 'S', sandbox: true });
  eq('sandbox: /api/sandbox/…', rq.url, 'https://fr24api.flightradar24.com/api/sandbox/live/flight-positions/full?flights=AV9563');
  eq('HTTP → acción', [200, 204, 404, 400, 401, 403, 402, 429, 500, 0].map(fr.classifyHttp),
    ['ok', 'empty', 'empty', 'bad', 'auth', 'auth', 'credits', 'rate', 'retry', 'retry']);
  eq('se puede consultar: AV9563, J65417, JA5116; no 5116', ['AV9563', 'J65417', 'ja 5116', '5116', ''].map(fr.isQueryable), [true, true, true, false, false]);
  eq('itemsOf: {data:[…]}, arreglo, basura', [fr.itemsOf({ data: [1, 2] }).length, fr.itemsOf([1]).length, fr.itemsOf(null).length, fr.itemsOf({ message: 'x' }).length], [2, 1, 0, 0]);
}

console.log('\n── Alias de siglas (JetSmart) ──');
eq('sin alias: se pregunta lo que escribió el tripulante', fr.candidatesFor('JA5116', {}), ['JA5116']);
eq('{"JA":["J6"]} → J65116', fr.candidatesFor('JA5116', { JA: ['J6'] }), ['J65116']);
eq('{"JA":["JA","J6"]} → las dos', fr.candidatesFor('ja-5116', { JA: ['JA', 'J6'] }), ['JA5116', 'J65116']);
eq('la llave más larga gana (J6 antes que J)', fr.candidatesFor('J65417', { J: ['XX'], J6: ['JA'] }), ['JA5417']);
eq('un texto suelto vale como lista', fr.candidatesFor('JA5116', { JA: 'J6' }), ['J65116']);
eq('otra aerolínea no cambia', fr.candidatesFor('AV9563', { JA: ['J6'] }), ['AV9563']);
eq('alias: se normalizan y la basura se ignora', fr.parseAliases({ 'j a': ['j6 ', 'J6'], '': ['X'], TOOLONG: ['J6'], AV: ['', '!!'] }), { JA: ['J6'] });
eq('null / arreglo → {}', [fr.parseAliases(null), fr.parseAliases(['JA'])], [{}, {}]);

console.log('\n── El resultado correcto ──');
{
  const l = fr.pickLeg(summaryFx.data, LLE, ['AV9563']);
  t('fixture: AV9563 que va a SKRG', l && l.fr24Id === '3b4f1a2c' && l.orig === 'SKBO');
  const aBog = Object.assign(clone(summaryFx.data[0]), { fr24_id: 'otro', dest_icao: 'SKBO', dest_icao_actual: 'SKBO' });
  eq('el mismo número hacia BOG no sirve', fr.pickLeg([aBog], LLE, ['AV9563']), null);
  const manana = Object.assign(clone(summaryFx.data[0]), { fr24_id: 'manana', first_seen: '2026-10-11T11:20:00Z', datetime_takeoff: '2026-10-11T11:35:00Z', datetime_landed: '2026-10-11T12:12:00Z', flight_ended: true });
  eq('entre el de la mañana (aterrizó 07:12) y el de ahora: el de ahora', fr.pickLeg([manana, clone(summaryFx.data[0])], LLE, ['AV9563']).fr24Id, '3b4f1a2c');
  eq('solo el de la mañana: no se toma (7 h antes de la reserva)', fr.pickLeg([manana], LLE, ['AV9563']), null);
  const ayer = Object.assign(clone(summaryFx.data[0]), { fr24_id: 'ayer', first_seen: '2026-10-10T18:17:40Z' });
  eq('el de ayer a la misma hora no se toma', fr.pickLeg([ayer], LLE, ['AV9563']), null);
  const js = Object.assign(clone(summaryFx.data[0]), { flight: 'J65116', fr24_id: 'js' });
  const tJs = Object.assign({}, LLE, { flight_code: 'JA5116' });
  eq('alias: J65116 sirve para la reserva JA5116 si se pidió', fr.pickLeg([js], tJs, ['JA5116', 'J65116']).fr24Id, 'js');
  eq('…y no si no se pidió', fr.pickLeg([js], tJs, ['JA5116']), null);
  const lejos = Object.assign(clone(liveFx.data[0]), { eta: '2026-10-12T05:00:00Z' });
  eq('una ETA a 10 h de la reserva es otro vuelo', fr.pickLeg([lejos], LLE, ['AV9563']), null);
}

console.log('\n── Estados ──');
{
  const leg = (o) => fr.legOf(S(o).data[0]);
  let st = fr.fromSummary(leg(), NOW);
  eq('fixture (despegó 13:35, sin aterrizar): en el aire', [st.status, new Date(st.departed).toISOString()], ['in_air', '2026-10-11T18:35:12.000Z']);
  st = fr.fromSummary(leg({ datetime_landed: '2026-10-11T19:31:40Z', flight_ended: true }), NOW);
  eq('aterrizó: landed con la hora real', [st.status, new Date(st.actual).toISOString()], ['landed', '2026-10-11T19:31:40.000Z']);
  st = fr.fromSummary(leg({ flight_ended: true }), NOW);
  eq('terminó sin hora de aterrizaje: landed, sin hora, con motivo', [st.status, st.actual, !!st.motivo], ['landed', null, true]);
  st = fr.fromSummary(leg({ dest_icao_actual: 'SKBO' }), NOW);
  eq('iba a SKRG y FR24 marca SKBO: desviado', st.status, 'diverted');
  st = fr.fromSummary(leg({ dest_icao_actual: 'SKCL', datetime_landed: '2026-10-11T19:40:00Z', flight_ended: true }), NOW);
  eq('aterrizó en Cali: desviado (no «aterrizó»)', st.status, 'diverted');
  st = fr.fromSummary(leg({ datetime_takeoff: null, first_seen: '2026-10-11T18:56:00Z' }), NOW);
  eq('visto hace 10 min sin despegar: en tierra en el origen (scheduled)', st.status, 'scheduled');
  st = fr.fromSummary(leg({ datetime_takeoff: null, first_seen: '2026-10-11T18:16:00Z' }), NOW);
  eq('visto hace 50 min sin hora de despegue: se da por despegado (inferido)', [st.status, st.inferido], ['in_air', true]);
  st = fr.fromSummary(leg({ dest_icao_actual: null }), NOW);
  eq('sin dest_icao_actual no es desvío', st.status, 'in_air');

  // toRecord: retraso = ETA − reserva; sched_at = la reserva.
  const l = fr.legOf(liveFx.data[0]);
  let r = fr.toRecord(LLE, { status: 'in_air', eta: l.eta }, { leg: l, kind: 'live', now: NOW, credits: 8, http: 200 });
  eq('live: ETA 14:35, reserva 14:10 → 25 min tarde', [r.status, r.sched_at, r.estimated_at, r.delay_min, r.eta], ['in_air', REF, '2026-10-11T19:35:00.000Z', 25, '2026-10-11T19:35:00.000Z']);
  eq('…con origen, fr24_id, créditos, modo, fuente', [r.origin_icao, r.provider_ref, r.credits, r.poll_mode, r.source, r.raw._http], ['SKBO', '3b4f1a2c', 8, 'live', 'flightradar24', 200]);
  t('…raw = el vuelo de FR24 (se purga a los 30 días)', r.raw.vuelo && r.raw.vuelo.fr24_id === '3b4f1a2c');
  const prev = Object.assign({}, LLE, { estimated_at: '2026-10-11T19:35:00Z', departed_at: '2026-10-11T18:35:12Z', provider_ref: '3b4f1a2c' });
  r = fr.toRecord(prev, { status: 'in_air' }, { leg: fr.legOf(summaryFx.data[0]), kind: 'summary', now: NOW });
  eq('summary sin ETA: conserva la última ETA (25 min) y no la vuelve a anotar', [r.estimated_at, r.delay_min, r.eta], ['2026-10-11T19:35:00.000Z', 25, null]);
  r = fr.toRecord(prev, { status: 'landed', actual: Date.parse('2026-10-11T19:31:40Z'), departed: Date.parse('2026-10-11T18:35:12Z') }, { now: NOW });
  eq('aterrizó 14:31:40 → 22 min tarde, con despegue', [r.status, r.actual_at, r.delay_min, r.departed_at], ['landed', '2026-10-11T19:31:40.000Z', 22, '2026-10-11T18:35:12.000Z']);
  r = fr.toRecord(LLE, { status: 'diverted', departed: 1 }, { now: NOW });
  eq('desviado: sin retraso', [r.status, r.delay_min], ['diverted', null]);
  r = fr.toRecord(LLE, { status: 'scheduled' }, { now: NOW });
  eq('en tierra en el origen: sin horas ni retraso', [r.status, r.estimated_at, r.delay_min], ['scheduled', null, null]);
  r = fr.toRecord(LLE, null, { now: NOW, credits: 0, http: 200 });
  eq('no apareció: unknown, con motivo', [r.status, r.delay_min, !!r.raw.motivo, r.fetched_at], ['unknown', null, true, new Date(NOW).toISOString()]);
}

// ── fetch falso ──
function fake(handler) {
  const calls = [];
  const f = async (req) => { calls.push(req); return handler(req, calls.length); };
  f.calls = calls;
  return f;
}
const tgt = (code, o) => Object.assign({}, LLE, { flight_code: code }, o || {});

console.log('\n── Corrida: en el aire ──');
{
  let f = fake(() => ({ http: 200, body: clone(liveFx) }));
  let r = await fr.run([LLE], { fetch: f, now: NOW });
  eq('una petición live, una fila en el aire con 25 min', [f.calls.length, f.calls[0].kind, r.rows.length, r.rows[0].status, r.rows[0].delay_min], [1, 'live', 1, 'in_air', 25]);
  eq('8 créditos (1 vuelo en live full)', [r.creditos, r.rows[0].credits], [8, 8]);

  // Ya no está en vivo → summary por fr24_id en la misma corrida → aterrizó.
  const prev = tgt('AV9563', { provider_ref: '3b4f1a2c', departed_at: '2026-10-11T18:35:12Z', estimated_at: '2026-10-11T19:35:00Z' });
  f = fake((req) => req.kind === 'live' ? { http: 200, body: { data: [] } }
    : { http: 200, body: S({ datetime_landed: '2026-10-11T19:33:00Z', flight_ended: true }) });
  r = await fr.run([prev], { fetch: f, now: NOW + 40 * MIN });
  eq('live vacío → summary por fr24_id → aterrizó 14:33 (23 min tarde)', [f.calls.map(c => c.kind + (c.ids ? ':id' : '')).join(','), r.rows[0].status, r.rows[0].delay_min], ['live,summary:id', 'landed', 23]);
  eq('créditos: 1 (live vacío) + 1 (summary)', r.creditos, 2);

  // En tierra en MDE (0 pies): también se confirma con summary.
  f = fake((req) => req.kind === 'live' ? { http: 200, body: { data: [Object.assign(clone(liveFx.data[0]), { alt: 0, gspeed: 14, eta: null })] } }
    : { http: 200, body: S({ datetime_landed: '2026-10-11T19:33:00Z', flight_ended: true }) });
  r = await fr.run([prev], { fetch: f, now: NOW + 40 * MIN });
  eq('en vivo pero en tierra → summary → aterrizó', [f.calls.length, r.rows[0].status], [2, 'landed']);

  // En vivo pero hacia otro destino (se desvió en el aire) → summary → desviado.
  f = fake((req) => req.kind === 'live' ? { http: 200, body: { data: [Object.assign(clone(liveFx.data[0]), { dest_icao: 'SKBO', dest_iata: 'BOG' })] } }
    : { http: 200, body: S({ dest_icao_actual: 'SKBO' }) });
  r = await fr.run([prev], { fetch: f, now: NOW });
  eq('en vivo hacia SKBO → summary → desviado', r.rows[0].status, 'diverted');
}

console.log('\n── Corrida: ¿ya despegó? ──');
{
  const pre = tgt('AV9563', { mode: 'summary' });
  let f = fake(() => ({ http: 200, body: { data: [] } }));
  let r = await fr.run([pre], { fetch: f, now: NOW - 100 * MIN });
  eq('todavía no transmite: unknown y 1 crédito (respuesta vacía)', [r.rows[0].status, r.creditos], ['unknown', 1]);
  const c0 = f.calls[0];
  eq('ventana: desde la reserva − 14 h hasta ahora + 5 min', [fr.fmtTime(c0.from), fr.fmtTime(c0.to)], ['2026-10-11T05:10:00Z', fr.fmtTime(NOW - 95 * MIN)]);
  f = fake(() => ({ http: 200, body: clone(summaryFx) }));
  r = await fr.run([pre], { fetch: f, now: NOW });
  eq('despegó: in_air con despegue y fr24_id, sin ETA todavía', [r.rows[0].status, r.rows[0].departed_at, r.rows[0].provider_ref, r.rows[0].delay_min], ['in_air', '2026-10-11T18:35:12.000Z', '3b4f1a2c', null]);
  f = fake(() => ({ http: 404, body: { message: 'Not found' } }));
  r = await fr.run([pre], { fetch: f, now: NOW });
  eq('404: unknown, 1 crédito', [r.rows[0].status, r.creditos], ['unknown', 1]);
}

console.log('\n── Corrida: grupos, alias, organizaciones ──');
{
  const codes = Array.from({ length: 20 }, (_, i) => 'AV' + (9000 + i));
  const lista = codes.map(c => tgt(c, { mode: 'summary' }));
  let f = fake(() => ({ http: 200, body: { data: [] } }));
  let r = await fr.run(lista, { fetch: f, now: NOW });
  eq('20 vuelos → 2 peticiones (15 + 5)', f.calls.map(c => c.flights.length), [15, 5]);
  eq('…y 20 filas', r.rows.length, 20);

  const otraOrg = tgt('AV9563', { organization_id: 'org2', mode: 'summary' });
  f = fake(() => ({ http: 200, body: clone(summaryFx) }));
  r = await fr.run([tgt('AV9563', { mode: 'summary' }), otraOrg], { fetch: f, now: NOW });
  eq('el mismo vuelo en dos organizaciones: se pide una vez, dos filas', [f.calls[0].flights, r.rows.map(x => x.organization_id + ':' + x.status)], [['AV9563'], ['org:in_air', 'org2:in_air']]);
  eq('…y se cobra una vez', [r.creditos, r.rows[0].credits + r.rows[1].credits], [1, 1]);

  const js = tgt('JA5116', { mode: 'summary' });
  f = fake((req) => ({ http: 200, body: S({ flight: 'J65116', fr24_id: 'js1' }) }));
  r = await fr.run([js], { fetch: f, now: NOW, aliases: { JA: ['JA', 'J6'] } });
  eq('alias JA→[JA, J6]: pide los dos, guarda en JA5116 lo que FR24 llama J65116', [f.calls[0].flights, r.rows[0].flight_code, r.rows[0].status, r.rows[0].provider_ref], [['JA5116', 'J65116'], 'JA5116', 'in_air', 'js1']);

  const sal = tgt('LA4025', { direction: 'home_to_airport', mode: 'summary' });
  const pelado = tgt('5116', { mode: 'summary' });
  f = fake(() => ({ http: 200, body: { data: [] } }));
  r = await fr.run([sal, pelado], { fetch: f, now: NOW });
  eq('salidas y vuelos sin sigla: no se pregunta nada', [f.calls.length, r.rows.length], [0, 0]);
}

console.log('\n── Corrida: errores y límites ──');
{
  const lista = Array.from({ length: 31 }, (_, i) => tgt('AV' + (8000 + i), { mode: 'summary' }));
  let f = fake(() => ({ http: 401, body: { message: 'Unauthenticated.' } }));
  let r = await fr.run(lista, { fetch: f, now: NOW });
  eq('401: para toda la corrida, sin guardar nada', [f.calls.length, r.rows.length, /token/.test(r.abortado)], [1, 0, true]);
  f = fake(() => ({ http: 402, body: { message: 'Forbidden', details: 'Credit limit reached.' } }));
  r = await fr.run(lista, { fetch: f, now: NOW });
  eq('402: «se acabaron los créditos»', [f.calls.length, /créditos/.test(r.abortado)], [1, true]);
  f = fake(() => ({ http: 429, body: {} }));
  r = await fr.run(lista, { fetch: f, now: NOW });
  eq('429: para', [f.calls.length, /10 peticiones/.test(r.abortado)], [1, true]);
  f = fake((req, n) => n === 1 ? { http: 503, body: null } : { http: 200, body: { data: [] } });
  r = await fr.run(lista, { fetch: f, now: NOW });
  eq('503 en la primera: esos 15 no se guardan, los demás sí', [f.calls.length, r.rows.length, r.errores.length, r.abortado], [3, 16, 1, null]);
  f = fake(() => { throw new Error('se cayó la red'); });
  r = await fr.run([tgt('AV1', { mode: 'summary' })].map(x => Object.assign(x, { flight_code: 'AV1111' })), { fetch: f, now: NOW });
  eq('la red se cae: error anotado, nada guardado', [r.rows.length, r.errores[0].http, r.errores[0].error], [0, 0, 'se cayó la red']);

  // 20 resultados = puede venir cortada: los que no salieron no se anotan «unknown».
  const veinte = { data: Array.from({ length: 20 }, (_, i) => Object.assign(clone(summaryFx.data[0]), { fr24_id: 'x' + i, flight: 'AV' + (8000 + i) })) };
  f = fake(() => ({ http: 200, body: veinte }));
  r = await fr.run(lista.slice(0, 15), { fetch: f, now: NOW });
  eq('respuesta de 20: 15 encontrados guardados; aviso de posible corte', [r.rows.length, r.rows.every(x => x.status === 'in_air'), r.errores.some(e => /cortada/.test(e.aviso || ''))], [15, true, true]);
  const veinteOtros = { data: Array.from({ length: 20 }, (_, i) => Object.assign(clone(summaryFx.data[0]), { fr24_id: 'y' + i, flight: 'AV' + (8000 + (i % 5)) })) };
  f = fake(() => ({ http: 200, body: veinteOtros }));
  r = await fr.run(lista.slice(0, 15), { fetch: f, now: NOW });
  eq('…y los 10 que no salieron en la respuesta cortada no se anotan', r.rows.length, 5);

  // 10 por minuto: con un tope de 2 por minuto, la tercera espera.
  let reloj = 0; const esperas = [];
  f = fake(() => ({ http: 200, body: { data: [] } }));
  r = await fr.run(lista, { fetch: f, now: NOW, perMinute: 2, batch: 15, sleep: async (ms) => { esperas.push(ms); reloj += ms; }, clock: () => reloj });
  eq('3 peticiones con tope 2/min: espera una vez ~60 s', [f.calls.length, esperas.length, esperas[0] >= 60000], [3, 1, true]);
  f = fake(() => ({ http: 200, body: { data: [] } }));
  r = await fr.run(lista, { fetch: f, now: NOW, maxRequests: 2 });
  eq('tope de 2 peticiones por corrida: el tercer grupo queda para la próxima', [f.calls.length, r.rows.length, r.errores.filter(e => e.tope).length], [2, 30, 1]);
}

console.log('\n── Modo prueba: un vuelo que avanza con el reloj ──');
{
  const R = Date.parse(REF);
  const fx = { summary: summaryFx, live: liveFx };
  const pre = tgt('AV9563', { mode: 'summary' });
  const at = async (min, target) => (await fr.run([target], { fetch: fr.mockFetch([target], { now: R + min * MIN, fixtures: fx }), now: R + min * MIN })).rows[0];
  // Por defecto: despega 35 min antes de la reserva (25 tarde), aterriza 25 después.
  eq('2 h antes: no aparece', (await at(-120, pre)).status, 'unknown');
  eq('45 min antes: en tierra en el origen', (await at(-45, pre)).status, 'scheduled');
  const desp = await at(-20, pre);
  eq('20 min antes: en el aire, despegó 35 min antes de la reserva', [desp.status, desp.departed_at], ['in_air', new Date(R - 35 * MIN).toISOString()]);
  const enAire = tgt('AV9563', { mode: 'live', provider_ref: desp.provider_ref, departed_at: desp.departed_at });
  const viva = await at(-15, enAire);
  eq('live: ETA = 25 min después de la reserva', [viva.status, viva.delay_min], ['in_air', 25]);
  const fin = await at(30, Object.assign({}, enAire, { estimated_at: viva.estimated_at }));
  eq('después de aterrizar: live vacío → summary → aterrizó 25 min tarde', [fin.status, fin.delay_min, fin.actual_at], ['landed', 25, new Date(R + 25 * MIN).toISOString()]);
  const nunca = await (async () => (await fr.run([pre], { fetch: fr.mockFetch([pre], { now: R, fixtures: fx, perfiles: { AV9563: { never: true } } }), now: R })).rows[0])();
  eq('perfil «never»: nunca aparece', nunca.status, 'unknown');
  const al = tgt('JA5116', { mode: 'summary' });
  const ali = (await fr.run([al], { fetch: fr.mockFetch([al], { now: R, fixtures: fx, aliases: { JA: ['J6'] } }), now: R, aliases: { JA: ['J6'] } })).rows[0];
  eq('con alias: el modo prueba contesta como J65116 y se guarda en JA5116', [ali.flight_code, ali.status, ali.raw.vuelo && ali.raw.vuelo.flight], ['JA5116', 'in_air', 'J65116']);
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
