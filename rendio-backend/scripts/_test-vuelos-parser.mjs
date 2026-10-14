// Prueba del adaptador de AeroDataBox (supabase/functions/flight-status/aerodatabox.mjs)
// con los fixtures de la función (respuestas con la forma real del proveedor).
//
// Comprueba: el tramo que llega a MDE / sale de MDE (también en un número de
// varios tramos y con código compartido), programada/estimada/real, retraso,
// estado (programado, retrasado, en vuelo, aterrizó, cancelado, desviado,
// desconocido), los formatos de hora, la URL y los headers, qué hacer con cada
// HTTP, las fechas a preguntar y el modo prueba (fixture corrido a la reserva).
//
// LO QUE NO CUBRE: una llamada real al proveedor (no hay llave), Deno ni la
// Edge Function entera (index.ts), la base.
//
//   cd rendio-backend && node scripts/_test-vuelos-parser.mjs
import { readFileSync } from 'node:fs';
import * as adb from '../supabase/functions/flight-status/aerodatabox.mjs';

const FX = new URL('../supabase/functions/flight-status/fixtures/', import.meta.url).pathname;
const llegada = JSON.parse(readFileSync(FX + 'aerodatabox-llegada.json', 'utf8'));
const salida = JSON.parse(readFileSync(FX + 'aerodatabox-salida.json', 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

const LLE = { organization_id: 'org', flight_code: 'AV9563', flight_date: '2026-10-11', direction: 'airport_to_home', ref_at: '2026-10-11T19:10:00.000Z' };
const SAL = { organization_id: 'org', flight_code: 'LA4025', flight_date: '2026-10-11', direction: 'home_to_airport', ref_at: '2026-10-11T19:50:00.000Z' };

console.log('\n── Horas ──');
eq('"2026-10-11 19:10Z"', adb.parseTime('2026-10-11 19:10Z'), Date.parse('2026-10-11T19:10:00Z'));
eq('"2026-10-11 14:10-05:00" = 19:10 UTC', adb.parseTime('2026-10-11 14:10-05:00'), Date.parse('2026-10-11T19:10:00Z'));
eq('ISO con T y segundos', adb.parseTime('2026-10-11T19:10:30.000Z'), Date.parse('2026-10-11T19:10:30Z'));
eq('offset sin dos puntos (-0500)', adb.parseTime('2026-10-11 14:10-0500'), Date.parse('2026-10-11T19:10:00Z'));
eq('basura → null', adb.parseTime('mañana'), null);
eq('null → null', adb.parseTime(null), null);

console.log('\n── Llegada (fixture AV 9563 BOG→MDE, en vuelo, 25 min tarde) ──');
{
  const p = adb.parseFlightStatus(llegada, LLE);
  t('encuentra el tramo que llega a MDE', p.found === true);
  eq('programada = 14:10 Bogotá', p.sched_at, '2026-10-11T19:10:00.000Z');
  eq('estimada = 14:35 Bogotá (revisedTime, no predictedTime)', p.estimated_at, '2026-10-11T19:35:00.000Z');
  eq('sin hora real todavía', p.actual_at, null);
  eq('25 min tarde', p.delay_min, 25);
  eq('estado: en vuelo', p.status, 'in_air');
  eq('terminal y puerta del lado MDE', [p.terminal, p.gate], ['1', '12']);
  t('raw = el tramo elegido', p.raw && p.raw.number === 'AV 9563');
}

console.log('\n── Llegada: aterrizó (runwayTime = toque de pista) ──');
{
  const b = clone(llegada);
  b[0].status = 'Arrived';
  b[0].arrival.runwayTime = { utc: '2026-10-11 19:31Z', local: '2026-10-11 14:31-05:00' };
  b[0].arrival.revisedTime = { utc: '2026-10-11 19:38Z', local: '2026-10-11 14:38-05:00' };
  const p = adb.parseFlightStatus(b, LLE);
  eq('estado: aterrizó', p.status, 'landed');
  eq('real = 14:31 (pista, no la puerta)', p.actual_at, '2026-10-11T19:31:00.000Z');
  eq('retraso con la real: 21 min', p.delay_min, 21);
  const b2 = clone(b); delete b2[0].arrival.runwayTime;
  eq('sin runwayTime, la real es revisedTime', adb.parseFlightStatus(b2, LLE).actual_at, '2026-10-11T19:38:00.000Z');
}

console.log('\n── Llegada: cancelado, desviado, solo horario, retrasado en tierra ──');
{
  const c = clone(llegada); c[0].status = 'Canceled';
  let p = adb.parseFlightStatus(c, LLE);
  eq('Canceled → cancelled, sin retraso ni estimada', [p.status, p.delay_min, p.estimated_at], ['cancelled', null, null]);
  c[0].status = 'CanceledUncertain';
  eq('CanceledUncertain → cancelled', adb.parseFlightStatus(c, LLE).status, 'cancelled');
  const d = clone(llegada); d[0].status = 'Diverted';
  eq('Diverted → diverted', adb.parseFlightStatus(d, LLE).status, 'diverted');
  const s = clone(llegada); s[0].status = 'Expected'; delete s[0].arrival.revisedTime; s[0].arrival.quality = ['Basic'];
  p = adb.parseFlightStatus(s, LLE);
  eq('solo horario → scheduled, sin retraso (no se sabe)', [p.status, p.delay_min, p.estimated_at], ['scheduled', null, null]);
  const e = clone(llegada); e[0].status = 'Expected';
  eq('Expected con 25 min en revisedTime → delayed', adb.parseFlightStatus(e, LLE).status, 'delayed');
  const e2 = clone(llegada); e2[0].status = 'Expected'; e2[0].arrival.revisedTime = { utc: '2026-10-11 19:18Z', local: '2026-10-11 14:18-05:00' };
  p = adb.parseFlightStatus(e2, LLE);
  eq('Expected con 8 min → scheduled (bajo el umbral de 15), delay 8', [p.status, p.delay_min], ['scheduled', 8]);
  const g = clone(llegada); g[0].status = 'Delayed'; g[0].arrival.revisedTime = { utc: '2026-10-11 19:15Z', local: '2026-10-11 14:15-05:00' };
  eq('Delayed del proveedor manda aunque sean 5 min', adb.parseFlightStatus(g, LLE).status, 'delayed');
  const a = clone(llegada); a[0].arrival.revisedTime = { utc: '2026-10-11 18:58Z', local: '2026-10-11 13:58-05:00' };
  eq('adelantado: -12 min', adb.parseFlightStatus(a, LLE).delay_min, -12);
}

console.log('\n── Varios tramos con el mismo número ──');
{
  // MDE→MIA con el mismo número: tiene MDE pero en la SALIDA. Y otro BOG→MDE de
  // la mañana (mismo número, otra hora).
  const sigue = clone(llegada[0]);
  sigue.departure = clone(llegada[0].arrival); delete sigue.departure.baggageBelt;
  sigue.departure.scheduledTime = { utc: '2026-10-11 20:30Z', local: '2026-10-11 15:30-05:00' };
  sigue.arrival = { airport: { icao: 'KMIA', iata: 'MIA', name: 'Miami', timeZone: 'America/New_York' }, scheduledTime: { utc: '2026-10-12 00:10Z', local: '2026-10-11 20:10-04:00' }, quality: ['Basic'] };
  const manana = clone(llegada[0]);
  manana.arrival.scheduledTime = { utc: '2026-10-11 12:10Z', local: '2026-10-11 07:10-05:00' };
  manana.arrival.revisedTime = { utc: '2026-10-11 12:12Z', local: '2026-10-11 07:12-05:00' };
  manana.status = 'Arrived';
  const body = [manana, sigue, clone(llegada[0])];
  let p = adb.parseFlightStatus(body, LLE);
  eq('LLEGADA: el tramo que aterriza en MDE más cerca de la reserva (14:10, no el de las 07:10)', [p.sched_at, p.status], ['2026-10-11T19:10:00.000Z', 'in_air']);
  p = adb.parseFlightStatus(body, { ...LLE, direction: 'home_to_airport', ref_at: '2026-10-11T19:00:00.000Z' });
  eq('SALIDA con el mismo número: el tramo que sale de MDE (15:30)', p.sched_at, '2026-10-11T20:30:00.000Z');
  const cs = clone(llegada[0]); cs.codeshareStatus = 'IsCodeshared'; cs.number = 'UA 6321'; cs.arrival.gate = 'X';
  p = adb.parseFlightStatus([cs, clone(llegada[0])], LLE);
  eq('código compartido con las mismas horas: gana el operador', p.gate, '12');
  p = adb.parseFlightStatus([manana], { ...LLE, ref_at: '2026-10-12T00:30:00.000Z' });
  eq('un tramo a más de 12 h de la reserva no se toma (otro día del número)', [p.found, p.status], [false, 'unknown']);
}

console.log('\n── Salida (fixture LA 4025 MDE→BOG, retrasada) ──');
{
  let p = adb.parseFlightStatus(salida, SAL);
  t('encuentra el tramo que sale de MDE', p.found);
  eq('programada 16:20, estimada 16:50, 30 min tarde, delayed', [p.sched_at, p.estimated_at, p.delay_min, p.status],
    ['2026-10-11T21:20:00.000Z', '2026-10-11T21:50:00.000Z', 30, 'delayed']);
  eq('puerta 7', p.gate, '7');
  const dep = clone(salida); dep[0].status = 'Departed'; dep[0].departure.runwayTime = { utc: '2026-10-11 22:01Z', local: '2026-10-11 17:01-05:00' };
  p = adb.parseFlightStatus(dep, SAL);
  eq('despegó: in_air con la hora real de pista', [p.status, p.actual_at, p.delay_min], ['in_air', '2026-10-11T22:01:00.000Z', 41]);
  p = adb.parseFlightStatus(salida, { ...SAL, direction: 'airport_to_home' });
  t('el mismo fixture como LLEGADA no sirve (aterriza en BOG)', p.found === false);
  // Presentación 23:15; el de las 00:30 de HOY (ya se fue, 23 h antes) no es.
  const viejo = clone(salida);
  viejo[0].departure.scheduledTime = { utc: '2026-10-11 05:30Z', local: '2026-10-11 00:30-05:00' };
  p = adb.parseFlightStatus(viejo, { ...SAL, ref_at: '2026-10-12T04:15:00.000Z' });
  t('salida: no toma el despegue de la madrugada anterior a la presentación', p.found === false);
}

console.log('\n── Respuestas vacías ──');
{
  for (const [n, b] of [['arreglo vacío', []], ['null (204)', null], ['texto', 'x']]) {
    const p = adb.parseFlightStatus(b, LLE);
    eq(n + ' → unknown sin horas', [p.found, p.status, p.sched_at, p.delay_min], [false, 'unknown', null, null]);
  }
  eq('un objeto suelto se acepta como un tramo', adb.parseFlightStatus(llegada[0], LLE).status, 'in_air');
}

console.log('\n── Petición, HTTP, fechas ──');
{
  const rq = adb.buildRequest('av-9563', '2026-10-11', { apiKey: 'K' });
  eq('URL de RapidAPI', rq.url, 'https://aerodatabox.p.rapidapi.com/flights/number/AV9563/2026-10-11?dateLocalRole=Both&withAircraftImage=false&withLocation=false');
  eq('headers X-RapidAPI-Key / X-RapidAPI-Host', [rq.headers['X-RapidAPI-Key'], rq.headers['X-RapidAPI-Host']], ['K', 'aerodatabox.p.rapidapi.com']);
  eq('HTTP → acción', [200, 204, 404, 401, 403, 429, 500, 0].map(adb.classifyHttp), ['ok', 'empty', 'empty', 'auth', 'auth', 'rate', 'retry', 'retry']);
  eq('se puede consultar: AV9563, J65417, LA4025; no 5116', ['AV9563', 'J65417', 'la 4025', '5116', ''].map(adb.isQueryable), [true, true, true, false, false]);
  eq('llegada: solo su día', adb.queryDates(LLE), ['2026-10-11']);
  eq('salida de día: solo su día', adb.queryDates(SAL), ['2026-10-11']);
  eq('salida con presentación 22:30 Bogotá: también el día siguiente', adb.queryDates({ ...SAL, ref_at: '2026-10-12T03:30:00.000Z' }), ['2026-10-11', '2026-10-12']);
  eq('fin de mes', adb.addDays('2026-10-31', 1), '2026-11-01');
}

console.log('\n── Modo prueba: fixture corrido a la reserva ──');
{
  const tgt = { ...LLE, flight_code: 'JA5116', ref_at: '2026-11-02T06:40:00.000Z' };
  const b = adb.mockBody(tgt, llegada);
  const p = adb.parseFlightStatus(b, tgt);
  eq('número del vuelo consultado', b[0].number, 'JA 5116');
  eq('aterrizaje programado = hora de la reserva; sigue 25 min tarde', [p.sched_at, p.delay_min, p.status], ['2026-11-02T06:40:00.000Z', 25, 'in_air']);
  eq('la hora local conserva su -05:00', b[0].arrival.scheduledTime.local, '2026-11-02 01:40-05:00');
  t('no toca el fixture original', llegada[0].number === 'AV 9563' && llegada[0].arrival.scheduledTime.utc === '2026-10-11 19:10Z');
  const ts = { ...SAL, ref_at: '2026-11-02T10:00:00.000Z' };
  const ps = adb.parseFlightStatus(adb.mockBody(ts, salida), ts);
  eq('salida: despegue programado = presentación + 90 min', ps.sched_at, '2026-11-02T11:30:00.000Z');
  const rec = adb.toRecord(tgt, p, 'mock', 200);
  eq('toRecord: la fila para flight_status_record', [rec.flight_code, rec.flight_date, rec.direction, rec.source, rec.raw._http, rec.status],
    ['JA5116', '2026-10-11', 'airport_to_home', 'mock', 200, 'in_air']);
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
