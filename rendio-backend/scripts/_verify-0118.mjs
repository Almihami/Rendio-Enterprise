// 0118 · Vuelos con Flightradar24: solo llegadas, calendario por fase, purga a 30 días.
//
//   cd rendio-backend/scripts && node _verify-0118.mjs                 (base LOCAL)
//   set -a; source ../.env.dev; set +a; node _verify-0118.mjs --dev    (base de DEV)
//
// Todo dentro de una transacción que se deshace: aplica 0118, arma sus propias
// filas (una organización de prueba con su jefa, Laura, su vecina, Carlos y su
// carro) y comprueba
//   1. el esquema: 'flightradar24' en el CHECK, columnas nuevas, alias vacío;
//   2. el calendario (flight_status_targets): solo llegadas; desde 2 h antes de la
//      reserva; summary antes de despegar y cuando la ETA llegó, live en el aire;
//      cada 15 min, cada 30 si el vuelo se atrasó en el origen, cada hora si la ETA
//      está lejos; se rinde; no pregunta lo terminado ni si el tripulante ya está
//      con el conductor; dos reservas = un vuelo; bandera apagada = nada;
//   3. flight_status_record: créditos que se suman, eta_log (máx. 40), un
//      «unknown» no borra lo bueno del mismo proveedor, otro proveedor se pisa
//      entero (no mezclar), el despegue ya sabido no se pierde;
//   4. los avisos de 0107 con filas de FR24 (texto, retraso contra la reserva,
//      desviado) y que required_arrival_at no se toca;
//   5. la purga (28 días, nunca más de 30, también los avisos de vuelo) y su reloj;
//   6. el informe de exactitud de la ETA;
//   7. permisos y el disparo (poll_flight_status, 2 min de espera);
//   8. SIMULACIÓN: el lector real (fr24.mjs, con su modo prueba) contra este
//      calendario, una vuelta del cron cada 15 min durante 9 h, con un nacional a
//      tiempo, uno que sale 40 min tarde, uno largo, uno que FR24 no capta al
//      despegar, uno desviado, uno que nunca aparece y JetSmart con alias:
//      estados finales, avisos, créditos por vuelo y por mes, peticiones por vuelta.
//
// NO CUBRE: FR24 de verdad (sin token: el modo prueba imita su forma, no sus
// datos ni su cobertura en el Oriente), la Edge Function en Deno (index.ts), pg_net
// de verdad (la petición queda en cola y se deshace con el ROLLBACK), el push.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';
import * as fr from '../supabase/functions/flight-status/fr24.mjs';

const DEV = process.argv.includes('--dev');
async function conectar() {
  if (!DEV) return localClient();
  const DEV_REF = 'lxlphbafhtphulanhzlp';
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
  const cli = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
    user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
  await cli.connect();
  return cli;
}

const c = await conectar();
c.on('notice', () => {});
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); } };
const SQL = readFileSync(new URL('../supabase/migrations/0118_vuelos_flightradar24.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const FX = new URL('../supabase/functions/flight-status/fixtures/', import.meta.url).pathname;
const fixturesFr24 = {
  summary: JSON.parse(readFileSync(FX + 'fr24-summary-light.json', 'utf8')),
  live: JSON.parse(readFileSync(FX + 'fr24-live-full.json', 'utf8')),
};
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows, count: r.rowCount }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message }; }
}
const como = async (quien, rol, sql, params) => {
  await c.query('SAVEPOINT s');
  try { await asUser(c, quien, rol); const r = await q(sql, params); await asAdminDb(c); await c.query('RELEASE SAVEPOINT s'); return [r, null]; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return [null, e.message]; }
};
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const MIN = 60000;

console.log(`0118 contra la base ${DEV ? 'de DEV' : 'LOCAL'} (todo se deshace al final)`);
await c.query('BEGIN');
try {
  await c.query(SQL);
  await q(`INSERT INTO public.app_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true, flight_code_aliases = '{}'::jsonb, route_deplane_min = 19,
             route_deplane_av_nac_min = 15, route_deplane_av_int_min = 20, route_deplane_js_nac_min = 25,
             route_deplane_js_int_min = 30, route_deplane_wingo_min = 22 WHERE id = 'singleton'`);
  const fx = await fixtures(c);
  const jefa = await user(c, fx.org, 'admin', 'Jefa Vuelos 0118');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefa]);
  const T0 = new Date((await one(`SELECT now() AS t`)).t).getTime();
  const iso = (ms) => new Date(ms).toISOString();

  let nAux = 0;
  // Una reserva por tripulante nuevo (ninguna regla de «una por día» estorba).
  const reserva = async (dir, refMs, flight, extra = {}) => {
    const u = await user(c, fx.org, 'auxiliar', 'Tripulante 0118 #' + (++nAux));
    const aux = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id;
    return one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, residence_id, notes, ground_ops)
      VALUES ($1, $2::public.trip_direction,
        CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
        CASE WHEN $2 = 'airport_to_home' THEN coalesce($6, 'scheduled')::public.reservation_status_a2h END,
        $3, $4, $5, $7) RETURNING id, flight_code, required_arrival_at`,
      [aux, dir, iso(refMs), fx.olivar, `Vuelo ${flight}.`, extra.status || null, !!extra.ground]);
  };
  const dia = async (ms) => (await one(`SELECT ($1::timestamptz AT TIME ZONE 'America/Bogota')::date::text d`, [iso(ms)])).d;
  const targets = async (pNow) => q(`SELECT t.* FROM public.flight_status_targets($1::timestamptz, 200) t WHERE t.organization_id = $2 ORDER BY t.flight_code`, [iso(pNow ?? T0), fx.org]);
  const rec = async (rows) => Number((await one(`SELECT public.flight_status_record($1::jsonb) n`, [JSON.stringify(rows)])).n);
  const fsRow = async (code) => one(`SELECT * FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = $2`, [fx.org, code]);
  const fila = (code, d, o = {}) => Object.assign({ organization_id: fx.org, flight_code: code, flight_date: d, direction: 'airport_to_home', source: 'flightradar24', raw: { prueba: true } }, o);
  const codes = (rows) => rows.map(r => r.flight_code);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n1. Esquema');
  const src = await one(`SELECT column_default FROM information_schema.columns WHERE table_name = 'flight_statuses' AND column_name = 'source'`);
  check('source nace en flightradar24', /flightradar24/.test(src.column_default || ''), src.column_default);
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flight_statuses'`)).map(r => r.column_name);
  check('columnas nuevas: departed_at, origin_icao, provider_ref, poll_mode, provider_credits, eta_log',
    ['departed_at', 'origin_icao', 'provider_ref', 'poll_mode', 'provider_credits', 'eta_log'].every(x => cols.includes(x)));
  const dX = await dia(T0);
  const malo = await intenta(`SELECT public.flight_status_record($1::jsonb)`, [JSON.stringify([fila('AV1111', dX, { source: 'otro' })])]);
  check('una fuente inventada se rechaza', !!malo.err);
  const modoMalo = await intenta(`SELECT public.flight_status_record($1::jsonb)`, [JSON.stringify([fila('AV1112', dX, { poll_mode: 'radar' })])]);
  check('un poll_mode inventado se rechaza', !!modoMalo.err);
  const ali = await one(`SELECT column_default FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'flight_code_aliases'`);
  check('flight_code_aliases nace vacío ({}): se pregunta lo que escribió el tripulante', /'\{\}'/.test(ali.column_default || ''), ali.column_default);
  const aliMalo = await intenta(`UPDATE public.app_settings SET flight_code_aliases = '["J6"]'::jsonb WHERE id = 'singleton'`);
  check('…y tiene que ser un objeto (un arreglo se rechaza)', !!aliMalo.err);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n2. El calendario');
  const A = await reserva('airport_to_home', T0 + 110 * MIN, 'AV9563');
  const A2 = await reserva('airport_to_home', T0 + 115 * MIN, 'AV 9563');
  await reserva('airport_to_home', T0 + 130 * MIN, 'AV1001');                          // aún lejos
  await reserva('home_to_airport', T0 + 60 * MIN, 'LA4025');                           // salida
  await reserva('airport_to_home', T0 + 30 * MIN, 'JA5116', { status: 'picked_up' });  // ya con el conductor
  await reserva('airport_to_home', T0 + 30 * MIN, 'JA5117', { status: 'disembarking' });
  await reserva('airport_to_home', T0 + 30 * MIN, 'AV2002', { ground: true });         // personal de tierra
  await reserva('airport_to_home', T0 + 30 * MIN, '5116');                              // sin sigla
  let T = await targets();
  check('solo llegadas, desde 2 h antes: AV9563 (dos reservas = un vuelo)', JSON.stringify(codes(T)) === '["AV9563"]', codes(T));
  const tA = T[0];
  check('…con 2 reservas, la hora más temprana, modo summary («¿ya despegó?»)', tA && tA.reservations === 2 && new Date(tA.ref_at).getTime() === new Date(A.required_arrival_at).getTime() && tA.mode === 'summary', tA && [tA.reservations, tA.mode]);
  T = await targets(T0 + 20 * MIN);
  check('20 min después entra AV1001 (le faltan 110)', codes(T).includes('AV1001'), codes(T));
  const dA = await dia(A.required_arrival_at);

  // Sin despegar: cada 15 min.
  await rec([fila('AV9563', dA, { status: 'unknown', sched_at: A.required_arrival_at, fetched_at: iso(T0 - 10 * MIN) })]);
  T = await targets();
  check('preguntado hace 10 min (no aparece): espera', !codes(T).includes('AV9563'));
  await q(`UPDATE public.flight_statuses SET fetched_at = $2 WHERE id = (SELECT id FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = 'AV9563')`, [fx.org, iso(T0 - 13 * MIN)]);
  T = await targets();
  check('…hace 13 min: vuelve a tocar (cada vuelta del cron)', codes(T).includes('AV9563'));

  // Se atrasó en el origen: pasó la hora de la reserva sin despegar.
  const at = (min) => T0 + min * MIN;
  const Bx = await reserva('airport_to_home', at(-40), 'AV3003');
  const Cx = await reserva('airport_to_home', at(-90), 'AV3004');
  const Dx = await reserva('airport_to_home', at(-200), 'AV3005');
  await rec([fila('AV3003', await dia(Bx.required_arrival_at), { status: 'scheduled', sched_at: Bx.required_arrival_at, fetched_at: iso(at(-13)) }),
             fila('AV3004', await dia(Cx.required_arrival_at), { status: 'scheduled', sched_at: Cx.required_arrival_at, fetched_at: iso(at(-20)) }),
             fila('AV3005', await dia(Dx.required_arrival_at), { status: 'unknown', sched_at: Dx.required_arrival_at, fetched_at: iso(at(-60)) })]);
  T = await targets();
  check('reserva hace 40 min, sin despegar, preguntado hace 13: toca (cada 15 min la primera hora)', codes(T).includes('AV3003'), codes(T));
  check('reserva hace 90 min, preguntado hace 20: espera (cada 30 min)', !codes(T).includes('AV3004'));
  await q(`UPDATE public.flight_statuses SET fetched_at = $2 WHERE organization_id = $1 AND flight_code = 'AV3004'`, [fx.org, iso(at(-28))]);
  T = await targets();
  check('…preguntado hace 28: toca', codes(T).includes('AV3004'));
  check('reserva hace 3 h 20 sin despegar nunca: se rinde', !codes(T).includes('AV3005'));

  // En el aire.
  const E = await reserva('airport_to_home', at(100), 'AV4004');
  const dE = await dia(E.required_arrival_at);
  await rec([fila('AV4004', dE, { status: 'in_air', sched_at: E.required_arrival_at, departed_at: iso(at(-60)), estimated_at: iso(at(120)), delay_min: 20, provider_ref: 'aaaa0001', fetched_at: iso(at(-20)) })]);
  T = await targets();
  let tE = T.find(x => x.flight_code === 'AV4004');
  check('en el aire con la ETA a 2 h, preguntado hace 20 min: espera (cada hora)', !tE);
  await q(`UPDATE public.flight_statuses SET fetched_at = $2 WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(-58))]);
  tE = (await targets()).find(x => x.flight_code === 'AV4004');
  check('…hace 58 min: toca, modo live, con fr24_id, despegue y ETA', tE && tE.mode === 'live' && tE.provider_ref === 'aaaa0001' && tE.departed_at && tE.estimated_at, tE);
  await q(`UPDATE public.flight_statuses SET estimated_at = $2, fetched_at = $3 WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(75)), iso(at(-13))]);
  check('ETA a 75 min, preguntado hace 13: espera (cada 15 min solo en la última hora)', !codes(await targets()).includes('AV4004'));
  await q(`UPDATE public.flight_statuses SET estimated_at = $2 WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(55))]);
  tE = (await targets()).find(x => x.flight_code === 'AV4004');
  check('ETA a 55 min, preguntado hace 13: live en cada vuelta', tE && tE.mode === 'live', tE && tE.mode);
  await q(`UPDATE public.flight_statuses SET estimated_at = NULL WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org]);
  tE = (await targets()).find(x => x.flight_code === 'AV4004');
  check('recién despegado, sin ETA todavía: live en la vuelta siguiente', tE && tE.mode === 'live', tE && tE.mode);
  await q(`UPDATE public.flight_statuses SET estimated_at = $2 WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(3))]);
  tE = (await targets()).find(x => x.flight_code === 'AV4004');
  check('la ETA ya llegó (en 3 min): summary («¿ya aterrizó?»), 1 crédito en vez de 8', tE && tE.mode === 'summary', tE && tE.mode);
  await q(`UPDATE public.flight_statuses SET estimated_at = $2 WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(-130))]);
  check('ETA de hace 2 h 10 sin confirmar aterrizaje: se rinde', !codes(await targets()).includes('AV4004'));
  await q(`UPDATE public.flight_statuses SET estimated_at = $2, status = 'landed' WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org, iso(at(10))]);
  check('aterrizó: no se pregunta más', !codes(await targets()).includes('AV4004'));
  await q(`UPDATE public.flight_statuses SET status = 'diverted' WHERE organization_id = $1 AND flight_code = 'AV4004'`, [fx.org]);
  check('desviado: tampoco', !codes(await targets()).includes('AV4004'));

  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  check('bandera apagada: nada que consultar', (await targets()).length === 0);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);
  await q(`DELETE FROM public.reservations WHERE auxiliar_profile_id IN (SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id WHERE p.organization_id = $1)`, [fx.org]);
  await q(`DELETE FROM public.flight_statuses WHERE organization_id = $1`, [fx.org]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n3. Guardar');
  const F = await reserva('airport_to_home', at(90), 'AV5005');
  const dF = await dia(F.required_arrival_at);
  await rec([fila('AV5005', dF, { status: 'in_air', sched_at: F.required_arrival_at, departed_at: iso(at(-30)), origin_icao: 'SKBO', provider_ref: 'bbbb0002', estimated_at: iso(at(95)), eta: iso(at(95)), delay_min: 5, credits: 1, poll_mode: 'summary', fetched_at: iso(at(-15)) })]);
  await rec([fila('AV5005', dF, { status: 'in_air', sched_at: F.required_arrival_at, estimated_at: iso(at(110)), eta: iso(at(110)), delay_min: 20, credits: 8, poll_mode: 'live', fetched_at: iso(at(0)) })]);
  let f = await fsRow('AV5005');
  check('créditos se suman (1 + 8 = 9)', f.provider_credits === 9, f.provider_credits);
  check('eta_log anota las dos ETA, en orden', f.eta_log.length === 2 && new Date(f.eta_log[1].eta).getTime() === at(110) && new Date(f.eta_log[0].at).getTime() === at(-15), f.eta_log);
  check('el despegue, el origen y el fr24_id ya sabidos no se pierden (la 2ª fila no los traía)', f.departed_at && f.origin_icao === 'SKBO' && f.provider_ref === 'bbbb0002', [f.departed_at, f.origin_icao, f.provider_ref]);
  check('modo y retraso de la última consulta', f.poll_mode === 'live' && f.delay_min === 20, [f.poll_mode, f.delay_min]);
  await rec([fila('AV5005', dF, { status: 'unknown', credits: 1, poll_mode: 'summary', fetched_at: iso(at(15)), raw: { motivo: 'no lo encontré' } })]);
  f = await fsRow('AV5005');
  check('un «unknown» de FR24 después de un dato bueno de FR24 no lo borra…', f.status === 'in_air' && f.delay_min === 20 && f.estimated_at && !f.raw.motivo, [f.status, f.delay_min]);
  check('…pero anota la consulta y sus créditos', new Date(f.fetched_at).getTime() === at(15) && f.provider_credits === 10, [f.fetched_at, f.provider_credits]);
  const muchas = Array.from({ length: 45 }, (_, i) => fila('AV5005', dF, { status: 'in_air', sched_at: F.required_arrival_at, estimated_at: iso(at(100 + i)), eta: iso(at(100 + i)), fetched_at: iso(at(20 + i)) }));
  for (const m of muchas) await rec([m]);
  f = await fsRow('AV5005');
  check('eta_log se queda con las últimas 40', f.eta_log.length === 40 && new Date(f.eta_log[39].eta).getTime() === at(144) && new Date(f.eta_log[0].eta).getTime() === at(105), [f.eta_log.length, f.eta_log[0] && f.eta_log[0].eta]);

  // Otro proveedor: se pisa entero.
  const G = await reserva('airport_to_home', at(80), 'AV6006');
  const dG = await dia(G.required_arrival_at);
  await rec([fila('AV6006', dG, { source: 'aerodatabox', status: 'delayed', sched_at: G.required_arrival_at, estimated_at: iso(at(120)), delay_min: 40, terminal: '1', gate: '12', raw: { adb: true } })]);
  await rec([fila('AV6006', dG, { status: 'unknown', credits: 1, fetched_at: iso(at(1)) })]);
  let g = await fsRow('AV6006');
  check('fila de AeroDataBox + «unknown» de FR24: se pisa entera (no se mezclan proveedores)', g.source === 'flightradar24' && g.status === 'unknown' && g.estimated_at === null && g.gate === null && g.delay_min === null && !g.raw.adb, [g.source, g.status, g.gate, g.delay_min]);
  await rec([fila('AV6006', dG, { source: 'aerodatabox', status: 'delayed', sched_at: G.required_arrival_at, departed_at: iso(at(-5)), estimated_at: iso(at(120)), delay_min: 40, gate: '12' })]);
  await rec([fila('AV6006', dG, { status: 'in_air', sched_at: G.required_arrival_at, estimated_at: iso(at(85)), eta: iso(at(85)), delay_min: 5, fetched_at: iso(at(2)) })]);
  g = await fsRow('AV6006');
  check('…y uno bueno de FR24 tampoco hereda nada (ni el despegue de AeroDataBox)', g.source === 'flightradar24' && g.departed_at === null && g.gate === null && g.eta_log.length === 1, [g.departed_at, g.gate, g.eta_log.length]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n4. Avisos (0107) con filas de FR24');
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', $3) RETURNING id`, [fx.driver, fx.vehicle, iso(at(80))])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, F.id]);
  await q(`DELETE FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = 'AV5005'`, [fx.org]);
  const etaF = at(90 + 25);
  await rec([fila('AV5005', dF, { status: 'in_air', sched_at: F.required_arrival_at, departed_at: iso(at(-30)), estimated_at: iso(etaF), eta: iso(etaF), delay_min: 25, credits: 8, poll_mode: 'live' })]);
  const fF = await fsRow('AV5005');
  const bandeja = async (kind) => q(`SELECT profile_id, title, body, url FROM public.notification_outbox WHERE dedupe_key LIKE 'flt:' || $1::text || ':' || $2 || '%' ORDER BY profile_id`, [fF.id, kind]);
  await one(`SELECT public.flight_delay_alerts() n`);
  let ob = await bandeja('delay:25');
  const esperado = `Vuelo AV5005 aterriza ${hhmm(etaF)} (25 min tarde). Recogida sugerida ${hhmm(etaF + 15 * MIN)}`;
  check('ETA 25 min después de la hora de la reserva → «' + esperado + '»', ob.length === 2 && ob.every(r => r.body === esperado), ob.map(r => r.body));
  check('…a la jefa marcada y al conductor de la ruta publicada', JSON.stringify(ob.map(r => r.profile_id).sort()) === JSON.stringify([jefa, fx.drvUser].sort()), ob.map(r => r.profile_id));
  await q(`UPDATE public.flight_statuses SET status = 'landed', actual_at = $1, delay_min = 42 WHERE id = $2`, [iso(at(132)), fF.id]);
  await one(`SELECT public.flight_delay_alerts() n`);
  ob = await bandeja('delay:42');
  check('aterrizó 42 min tarde (cambió 17): «aterrizó …»', ob.length === 2 && ob.every(r => / aterrizó \d{2}:\d{2} \(42 min tarde\)/.test(r.body)), ob[0] && ob[0].body);
  await q(`UPDATE public.flight_statuses SET status = 'diverted', actual_at = NULL, delay_min = NULL WHERE id = $1`, [fF.id]);
  await one(`SELECT public.flight_delay_alerts() n`);
  ob = await bandeja('diverted');
  check('desviado: «Vuelo desviado … JMC»', ob.length === 2 && ob.every(r => r.title === 'Vuelo desviado' && /JMC/.test(r.body)), ob[0] && ob[0].body);
  const sigue = await one(`SELECT required_arrival_at FROM public.reservations WHERE id = $1`, [F.id]);
  check('required_arrival_at NO se tocó', new Date(sigue.required_arrival_at).getTime() === new Date(F.required_arrival_at).getTime());

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n5. Purga a 28 días (FR24 permite 30)');
  const viejo = await one(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, status, source, raw)
      VALUES ($1, 'AV7007', (now() AT TIME ZONE 'America/Bogota')::date - 35, 'airport_to_home', 'landed', 'flightradar24', '{"x":1}') RETURNING id`, [fx.org]);
  const viejoCreado = await one(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, status, source, created_at, fetched_at)
      VALUES ($1, 'AV7008', (now() AT TIME ZONE 'America/Bogota')::date - 2, 'airport_to_home', 'landed', 'flightradar24', now() - interval '29 days', now() - interval '29 days') RETURNING id`, [fx.org]);
  const nuevo = await one(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, status, source)
      VALUES ($1, 'AV7009', (now() AT TIME ZONE 'America/Bogota')::date - 20, 'airport_to_home', 'landed', 'flightradar24') RETURNING id`, [fx.org]);
  const obV = await one(`INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, created_at) VALUES ($1, 'Vuelo retrasado', 'Vuelo AV7007 aterriza 14:35', '/', 'flt:prueba-0118-viejo:' || gen_random_uuid(), now() - interval '40 days') RETURNING id`, [jefa]);
  const obN = await one(`INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, created_at) VALUES ($1, 'Vuelo retrasado', 'Vuelo AV7009 aterriza 14:35', '/', 'flt:prueba-0118-nuevo:' || gen_random_uuid(), now() - interval '3 days') RETURNING id`, [jefa]);
  const obO = await one(`INSERT INTO public.notification_outbox (profile_id, title, body, url, dedupe_key, created_at) VALUES ($1, 'Otro aviso', 'No es de vuelos', '/', 'otro:prueba-0118:' || gen_random_uuid(), now() - interval '40 days') RETURNING id`, [jefa]);
  const txt = (await one(`SELECT public.purge_flight_statuses() t`)).t;
  const quedan = (await q(`SELECT id FROM public.flight_statuses WHERE id = ANY($1::uuid[])`, [[viejo.id, viejoCreado.id, nuevo.id]])).map(r => r.id);
  check('borra el vuelo de hace 35 días y el guardado hace 29; deja el de hace 20', JSON.stringify(quedan) === JSON.stringify([nuevo.id]), quedan);
  const obq = (await q(`SELECT id FROM public.notification_outbox WHERE id = ANY($1::uuid[])`, [[obV.id, obN.id, obO.id]])).map(r => r.id).sort();
  check('de la bandeja: el aviso de vuelo de hace 40 días sí; el reciente y los que no son de vuelos no', JSON.stringify(obq) === JSON.stringify([obN.id, obO.id].sort()), obq);
  check('dice lo que hizo: «' + txt + '»', /vuelos borrados [1-9]\d* · avisos de vuelo borrados [1-9]/.test(txt), txt);
  const txt90 = (await one(`SELECT public.purge_flight_statuses(90) t`)).t;
  check('pedirle 90 días no la estira más de 30', /más de 30 días/.test(txt90), txt90);
  const jobP = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'purge-flight-statuses'`);
  check('pg_cron: purge-flight-statuses a diario', jobP && jobP.schedule === '20 8 * * *' && /purge_flight_statuses\(\)/.test(jobP.command), jobP);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n6. Informe de exactitud de la ETA');
  const aterr = at(200);
  const log = [[-70, 8], [-35, 4], [-20, -2], [-5, 0]].map(([a, e]) => ({ at: iso(aterr + a * MIN), eta: iso(aterr + e * MIN) }));
  const H = await one(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, status, source, sched_at, departed_at, actual_at, origin_icao, eta_log, provider_credits)
      VALUES ($1, 'AV8008', $2, 'airport_to_home', 'landed', 'flightradar24', $3, $4, $5, 'SKBO', $6::jsonb, 34) RETURNING id`,
    [fx.org, await dia(aterr), iso(aterr - 30 * MIN), iso(aterr - 90 * MIN), iso(aterr), JSON.stringify(log)]);
  const rep = await one(`SELECT * FROM public.flight_eta_report() WHERE flight_code = 'AV8008'`);
  check('retraso real 30 min; error de la ETA a 60/30/15 min: +8 / +4 / −2', rep && rep.retraso_min === 30 && rep.eta_60_err_min === 8 && rep.eta_30_err_min === 4 && rep.eta_15_err_min === -2, rep);
  check('…con origen, cuántas ETA y créditos', rep && rep.origen === 'SKBO' && rep.etas === 4 && rep.creditos === 34, rep);
  await q(`DELETE FROM public.flight_statuses WHERE id = $1`, [H.id]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n7. Permisos y el disparo');
  const fnPriv = async (role, sig) => (await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') a`, [role, sig])).a;
  const sigs = ['public.flight_status_targets(timestamptz, integer)', 'public.flight_status_record(jsonb)', 'public.purge_flight_statuses(integer)', 'public.flight_eta_report(integer)', 'public.poll_flight_status()'];
  const nadie = [];
  for (const s of sigs) for (const r of ['anon', 'authenticated']) if (await fnPriv(r, s)) nadie.push(`${r}:${s}`);
  check('ninguna se llama desde la app (anon / authenticated)', nadie.length === 0, nadie);
  check('la Edge Function (service_role) sí llama targets y record', (await fnPriv('service_role', sigs[0])) && (await fnPriv('service_role', sigs[1])));
  const [, errJ] = await como(jefa, 'admin', `SELECT public.purge_flight_statuses()`);
  check('ni la jefa purga desde la app', !!errJ, errJ);
  const [filasJ, errL] = await como(jefa, 'admin', `SELECT flight_code FROM public.flight_statuses WHERE organization_id = $1`, [fx.org]);
  check('la jefa sigue leyendo los vuelos de su organización (RLS de 0099)', !errL && filasJ.length >= 1, errL || filasJ.length);
  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  let p = (await one(`SELECT public.poll_flight_status() v`)).v;
  check('poll con la bandera apagada: «apagado…»', /^apagado/.test(p), p);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);
  const def = (await one(`SELECT pg_get_functiondef('public.poll_flight_status()'::regprocedure) d`)).d;
  check('poll le da 2 min a pg_net (una corrida con varias peticiones a FR24)', /timeout_milliseconds\s*:=\s*120000/.test(def));
  const job = await one(`SELECT schedule FROM cron.job WHERE jobname = 'poll-flight-status'`);
  check('el reloj de 0099 sigue: cada 15 min', job && job.schedule === '*/15 * * * *', job);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n8. Simulación: el lector real contra este calendario (una vuelta cada 15 min, 9 h)');
  await q(`DELETE FROM public.route_stops WHERE route_assignment_id = $1`, [ra]);
  await q(`DELETE FROM public.reservations WHERE auxiliar_profile_id IN (SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id WHERE p.organization_id = $1)`, [fx.org]);
  await q(`DELETE FROM public.flight_statuses WHERE organization_id = $1`, [fx.org]);
  await q(`UPDATE public.app_settings SET flight_code_aliases = '{"JA": ["J6"]}'::jsonb WHERE id = 'singleton'`);
  // El cron corre en :00/:15/:30/:45; la reserva cae a cualquier minuto.
  const S0 = Math.ceil(T0 / (15 * MIN)) * 15 * MIN;
  const vuelos = [
    { code: 'AV9563', ref: 150, perfil: { block: 60, delay: 0, etaError: 6 }, fin: 'landed', que: 'nacional a tiempo' },
    { code: 'AV9412', ref: 157, perfil: { block: 55, delay: 40, etaError: 8 }, fin: 'landed', que: 'nacional, sale 40 min tarde' },
    { code: 'AV19', ref: 241, perfil: { block: 195, delay: 10, etaError: 12 }, fin: 'landed', que: 'largo (Miami, 3 h 15)' },
    { code: 'LA4321', ref: 175, perfil: { block: 65, delay: 5, noTakeoff: true }, fin: 'landed', que: 'FR24 no capta el despegue' },
    { code: 'P57400', ref: 205, perfil: { block: 70, delay: 0, divert: 'SKBO' }, fin: 'diverted', que: 'desviado a Bogotá' },
    { code: 'AV7777', ref: 190, perfil: { never: true }, fin: 'unknown', que: 'nunca aparece (número que FR24 no tiene)' },
    { code: 'JA5116', ref: 222, perfil: { block: 60, delay: 12 }, fin: 'landed', que: 'JetSmart (alias JA→J6)' },
  ];
  const ras = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', $3) RETURNING id`, [fx.driver, fx.vehicle, iso(S0 + 140 * MIN)])).id;
  let orden = 0;
  for (const v of vuelos) {
    v.res = await reserva('airport_to_home', S0 + v.ref * MIN + 3 * MIN, v.code);   // a los 3 min de la vuelta
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, $3)`, [ras, v.res.id, ++orden]);
  }
  const perfiles = Object.fromEntries(vuelos.map(v => [v.code, v.perfil]));
  const aliases = (await one(`SELECT flight_code_aliases a FROM public.app_settings WHERE id = 'singleton'`)).a;
  let creditosRun = 0, maxPeticiones = 0, vueltas = 0, peticiones = 0;
  const pedidos = [];
  for (let step = 0; step <= 36; step++) {
    const now = S0 + step * 15 * MIN + 1000;   // el cron arranca un segundo después
    const tg = await targets(now);
    if (!tg.length) { await one(`SELECT public.flight_delay_alerts($1::timestamptz)`, [iso(now)]); continue; }
    vueltas++;
    const fetch = fr.mockFetch(tg, { now, fixtures: fixturesFr24, perfiles, aliases });
    const espiado = async (req) => { pedidos.push(Object.assign({ paso: step }, req)); return fetch(req); };
    const r = await fr.run(tg, { fetch: espiado, now: now + 2000, aliases });
    if (r.abortado || r.errores.length) check(`vuelta ${step}: sin errores`, false, r);
    creditosRun += r.creditos; peticiones += r.llamadas;
    maxPeticiones = Math.max(maxPeticiones, r.llamadas);
    if (r.rows.length) await rec(r.rows);
    await one(`SELECT public.flight_delay_alerts($1::timestamptz)`, [iso(now + 3000)]);
  }
  const finales = Object.fromEntries((await q(`SELECT * FROM public.flight_statuses WHERE organization_id = $1`, [fx.org])).map(r => [r.flight_code, r]));
  const filaTabla = [];
  for (const v of vuelos) {
    const fsv = finales[v.code];
    const ref = new Date(v.res.required_arrival_at).getTime();
    filaTabla.push(`     ${v.code.padEnd(7)} ${String(fsv ? fsv.status : '—').padEnd(9)} retraso ${String(fsv && fsv.delay_min != null ? fsv.delay_min : '—').padStart(3)}  créditos ${String(fsv ? fsv.provider_credits : 0).padStart(3)}  ETAs ${String(fsv ? fsv.eta_log.length : 0).padStart(2)}   ${v.que}`);
    check(`${v.que}: termina «${v.fin}»`, (fsv ? fsv.status : 'unknown') === v.fin, fsv && [fsv.status, fsv.delay_min]);
    if (v.fin === 'landed' && !v.perfil.never) {
      const tl = fr.mockTimeline({ flight_code: v.code, flight_date: fsv.flight_date, ref_at: iso(ref) }, v.perfil);
      const esp = Math.round((tl.landing - ref) / MIN);
      check(`${v.code}: hora real de aterrizaje y retraso contra la reserva (${esp} min)`, fsv.actual_at && new Date(fsv.actual_at).getTime() === tl.landing && fsv.delay_min === esp, [fsv.actual_at, fsv.delay_min]);
    }
  }
  console.log('   ' + 'resultado por vuelo:\n' + filaTabla.join('\n'));
  const tarde = await q(`SELECT o.profile_id, o.body FROM public.notification_outbox o JOIN public.flight_statuses f ON o.dedupe_key LIKE 'flt:' || f.id::text || ':%' WHERE f.organization_id = $1 AND f.flight_code = 'AV9412' ORDER BY o.created_at, o.profile_id`, [fx.org]);
  check('el que sale 40 min tarde: la jefa y el conductor reciben «… (40 min tarde)» antes de que aterrice', tarde.some(r => r.profile_id === jefa && /aterriza \d{2}:\d{2} \(4\d min tarde\)/.test(r.body)) && tarde.some(r => r.profile_id === fx.drvUser), tarde.map(r => r.body));
  const aTiempo = await q(`SELECT 1 FROM public.notification_outbox o JOIN public.flight_statuses f ON o.dedupe_key LIKE 'flt:' || f.id::text || ':%' WHERE f.organization_id = $1 AND f.flight_code = 'AV9563'`, [fx.org]);
  check('el nacional a tiempo no avisa nada', aTiempo.length === 0, aTiempo.length);
  const desv = await q(`SELECT o.title FROM public.notification_outbox o JOIN public.flight_statuses f ON o.dedupe_key LIKE 'flt:' || f.id::text || ':%' WHERE f.organization_id = $1 AND f.flight_code = 'P57400'`, [fx.org]);
  check('el desviado avisa «Vuelo desviado»', desv.some(r => r.title === 'Vuelo desviado'), desv);
  const jsPed = pedidos.filter(x => (x.flights || []).some(y => /5116$/.test(y)));
  check('JetSmart: a FR24 se le pregunta J65116, nunca JA5116; se guarda en JA5116', jsPed.length > 0 && jsPed.every(x => x.flights.includes('J65116') && !x.flights.includes('JA5116')) && finales.JA5116, jsPed.length);
  check('LA4321 (sin hora de despegue en FR24): se da por despegado y alcanza a leer la ETA', finales.LA4321 && finales.LA4321.raw && finales.LA4321.eta_log.length > 0, finales.LA4321 && finales.LA4321.eta_log.length);

  const nVuelos = vuelos.length;
  const reales = vuelos.filter(v => !v.perfil.never).map(v => finales[v.code].provider_credits);
  const atribuidos = Object.values(finales).reduce((s, r) => s + r.provider_credits, 0);
  const porVuelo = creditosRun / nVuelos;
  const mes = Math.round(porVuelo * 25 * 30);
  console.log(`   créditos de la simulación: ${creditosRun} en total (${atribuidos} cargados a vuelos + ${creditosRun - atribuidos} de respuestas vacías), ${peticiones} peticiones en ${vueltas} vueltas`);
  console.log(`   ≈ ${porVuelo.toFixed(1)} créditos por llegada → con 25 llegadas al día ≈ ${mes.toLocaleString('es-CO')} al mes (Explorer: 30.000; 60.000 hasta el 31-dic)`);
  check('ningún vuelo pasa de 45 créditos (presupuesto ~37; el que sale 40 min tarde cuesta más)', Math.max(...reales) <= 45, reales);
  check('promedio por llegada ≤ 37 créditos', porVuelo <= 37, porVuelo.toFixed(1));
  check('25 llegadas al día caben en los 30.000 créditos del Explorer', mes <= 30000, mes);
  check(`nunca más de 9 peticiones por vuelta (límite 10/min); máximo ${maxPeticiones}`, maxPeticiones <= 9, maxPeticiones);
  const rep2 = await q(`SELECT * FROM public.flight_eta_report() WHERE flight_code = ANY($1::text[])`, [vuelos.map(v => v.code)]);
  check('el informe de la ETA ya trae los que aterrizaron (con error a 30 min)', rep2.length >= 4 && rep2.some(r => r.eta_30_err_min != null), rep2.map(r => [r.flight_code, r.eta_60_err_min, r.eta_30_err_min, r.eta_15_err_min]));
} catch (e) {
  fail++; console.log('  ✗ excepción:', e.message, e.stack && e.stack.split('\n')[1]);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
