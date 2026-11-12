// PRUEBA EN VIVO DEL DESPACHO DE LLEGADAS — SOLO DEV, con las cuentas de prueba.
//
//   cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_prueba-despacho-dev.mjs <orden>
//
//   armar      deja el escenario: 2 conductores con turno abierto (Julián en JMC, Juan en
//              Rionegro) y 3 llegadas EN ESPERA cuyos vuelos «aterrizan» en los próximos minutos
//   latido     refresca el GPS de los conductores que siguen libres (cadena_libre pide < 15 min)
//   ver        cómo va: cada llegada, a qué hora sale, quién la tiene, y el rastro del despacho
//   vuelo <AV99xx> <±min>   mueve la hora de un vuelo (FlightRadar «cambió de opinión»)
//   mover <julian|juan> <jmc|rionegro|carmen>   pone a un conductor en otro lado
//   limpiar    borra todo lo de la prueba (pedidos, vueltas, vuelos, turnos, GPS)
import pg from 'pg';
const DEV = 'lxlphbafhtphulanhzlp';
if ((process.env.SUPABASE_PROJECT_REF || '') !== DEV || !(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORT: esto es solo para dev'); process.exit(2); }
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + DEV, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const orden = process.argv[2] || 'ver';
const LUGAR = { jmc: [6.1715, -75.4270], rionegro: [6.1537, -75.3738], carmen: [6.0837, -75.3341] };
const COND = { julian: 'julian.lopez@rendio.com', juan: 'juan.franco@rendio.co', apoyo: 'demo-conductor@rendio.demo' };
// `armar` = 3 llegadas espaciadas. `armar pico` = EL CASO CRÍTICO: 6 llegadas que salen en 16 min,
// con 2 carros fijos (uno en JMC, otro en Rionegro) y un conductor con el apoyo parqueado en JMC.
const PICO = process.argv.includes('pico');
const TODOS = ['prueba.valeria@rendio.demo', 'prueba.camila@rendio.demo', 'prueba.mateo@rendio.demo', 'laura.gomez@rendio.demo', 'mateo.cardona@rendio.demo', 'manuela.gil@rendio.demo', 'sara.quintero@rendio.demo'];
const TRIP = PICO
  ? [['prueba.valeria@rendio.demo', 'AV9901', -8], ['prueba.camila@rendio.demo', 'AV9902', -6], ['laura.gomez@rendio.demo', 'AV9903', -5], ['mateo.cardona@rendio.demo', 'AV9904', -2], ['manuela.gil@rendio.demo', 'AV9905', 4], ['sara.quintero@rendio.demo', 'AV9906', 8]]
  : [['prueba.valeria@rendio.demo', 'AV9901', -6], ['prueba.camila@rendio.demo', 'AV9902', 8], ['prueba.mateo@rendio.demo', 'AV9903', 22]];   // aterriza en N min
const VUELOS = ['AV9901', 'AV9902', 'AV9903', 'AV9904', 'AV9905', 'AV9906'];
const hm = (d) => new Date(d).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });

const cond = async (k) => one(`SELECT dp.id, dp.profile_id, p.full_name, p.organization_id org FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [COND[k]]);
const jefe = async () => one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
const trips = async (solo) => q(`SELECT p.email, p.full_name, ap.id aux, ap.profile_id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email = ANY($1)`, [solo ? TRIP.map((t) => t[0]) : TODOS]);

async function limpiar() {
  const A = await cond('julian'), B = await cond('juan'), T = await trips();
  await c.query(`SELECT set_config('rendio.no_acomodar', 'on', false)`);
  const res = (await q(`SELECT id FROM public.reservations WHERE auxiliar_profile_id = ANY($1) AND required_arrival_at > now() - interval '200 days'`, [T.map((t) => t.aux)])).map((r) => r.id);
  const ras = (await q(`SELECT DISTINCT route_assignment_id id FROM public.route_stops WHERE reservation_id = ANY($1)`, [res])).map((r) => r.id);
  await c.query(`DELETE FROM public.arrival_dispatch_log WHERE route_assignment_id = ANY($1)`, [ras]);
  await c.query(`DELETE FROM public.route_stops WHERE reservation_id = ANY($1)`, [res]);
  await c.query(`DELETE FROM public.route_assignments ra WHERE ra.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id)`, [ras]);
  await c.query(`DELETE FROM public.incidents WHERE reservation_id = ANY($1)`, [res]).catch(() => {});
  await c.query(`DELETE FROM public.notification_outbox WHERE dedupe_key LIKE 'desp%' AND created_at > now() - interval '1 day'`);
  await c.query(`DELETE FROM public.reservations WHERE id = ANY($1)`, [res]);
  await c.query(`DELETE FROM public.flight_statuses WHERE flight_code = ANY($1)`, [VUELOS]);
  await c.query(`DELETE FROM public.driver_locations WHERE driver_profile_id IN ($1, $2) AND recorded_at > now() - interval '1 day'`, [A.id, B.id]);
  await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE driver_id IN ($1, $2) AND status::text <> 'closed' AND notes = 'PRUEBA despacho'`, [A.id, B.id]);
  const AP = await cond('apoyo');
  if (AP) {
    await c.query(`DELETE FROM public.driver_locations WHERE driver_profile_id = $1 AND recorded_at > now() - interval '1 day'`, [AP.id]);
    await c.query(`DELETE FROM public.support_duty WHERE driver_profile_id = $1 AND day >= current_date - 1`, [AP.id]).catch(() => {});
  }
  console.log(`limpio: ${res.length} pedidos, ${ras.length} vueltas, vuelos de prueba, GPS y turnos de la prueba`);
}
// Los jefes de verdad con cuenta en dev tienen el teléfono registrado: durante la prueba
// los avisos de operación van SOLO al jefe de prueba. Lo que tenían se guarda y se devuelve.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const GUARDA = new URL('./.prueba-despacho-avisos.json', import.meta.url).pathname;
async function silenciar() {
  if (existsSync(GUARDA)) return;
  const J = await jefe();
  const antes = await q(`SELECT id, receives_ops_alerts r FROM public.profiles WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL`, [J.org]);
  writeFileSync(GUARDA, JSON.stringify(antes));
  await c.query(`UPDATE public.profiles SET receives_ops_alerts = (id = $2) WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL`, [J.org, J.id]);
  console.log(`avisos de operación: solo al jefe de prueba (guardé cómo estaban ${antes.length} jefes)`);
}
async function devolverAvisos() {
  if (!existsSync(GUARDA)) return;
  for (const a of JSON.parse(readFileSync(GUARDA, 'utf8'))) await c.query(`UPDATE public.profiles SET receives_ops_alerts = $2 WHERE id = $1`, [a.id, a.r]);
  unlinkSync(GUARDA); console.log('avisos de operación: devueltos a como estaban');
}
const gps = async (dp, donde) => c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, $2, $3, now())`, [dp, ...LUGAR[donde]]);

if (orden === 'limpiar') { await limpiar(); await devolverAvisos(); }
else if (orden === 'armar') {
  await limpiar();
  await silenciar();
  const J = await jefe(), A = await cond('julian'), B = await cond('juan'), T = await trips();
  const TT = await trips(true);
  if (!J || !A || !B || TT.length !== TRIP.length) { console.error('faltan cuentas de prueba', { jefe: !!J, julian: !!A, juan: !!B, tripulantes: T.length }); process.exit(1); }
  const org = A.org;
  const vehs = await q(`SELECT id, coalesce(license_plate, internal_code) placa FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL AND status::text <> 'inactive' ORDER BY internal_code DESC LIMIT 2`, [org]);
  // Turnos de la prueba (los que ya tuvieran abiertos estos dos se cierran; son cuentas de prueba).
  await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE driver_id IN ($1, $2) AND status::text <> 'closed'`, [A.id, B.id]);
  for (const [d, v] of [[A, vehs[0]], [B, vehs[1]]]) await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, notes) VALUES ($1, $2, $3, 'active', now() - interval '1 hour', 'PRUEBA despacho')`, [org, d.id, v.id]);
  await gps(A.id, 'jmc'); await gps(B.id, 'rionegro');
  const base = (await one(`SELECT date_trunc('minute', now()) b`)).b;
  for (const [email, vuelo, enMin] of TRIP) {
    const t = TT.find((x) => x.email === email);
    const prog = new Date(Date.parse(base) + (enMin + 10) * 60000).toISOString();     // programado: 10 min después de lo que dice FlightRadar (viene adelantado)
    const real = new Date(Date.parse(base) + enMin * 60000).toISOString();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: J.id, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
    const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, $3, NULL, false) id`, [t.aux, prog, vuelo])).id;
    await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`);
    await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
    const dep = (await one(`SELECT coalesce(public.flight_deplane_min($1), 20) m`, [vuelo])).m;
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, driver_profile_id, organization_id, pool, para_tomar)
       VALUES ('airport_to_home', 'planned', $1::timestamptz + make_interval(mins => $2), NULL, $3, true, true) RETURNING id`, [prog, dep, org])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + make_interval(mins => $4 + 20))`, [ra, rid, prog, dep]);
    await c.query(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source, fetched_at)
       VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'America/Bogota')::date, 'airport_to_home', $3, $4, 'in_air', -10, 'flightradar24', now())
       ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET sched_at = EXCLUDED.sched_at, estimated_at = EXCLUDED.estimated_at, actual_at = NULL, delay_min = -10, status = 'in_air', fetched_at = now()`, [org, vuelo, prog, real]);
    await c.query('COMMIT');
    console.log(`  ${t.full_name.padEnd(16)} ${vuelo} · programado ${hm(prog)} · FlightRadar dice ${hm(real)} · sale ~${hm(Date.parse(real) + dep * 60000)} · EN ESPERA`);
  }
  console.log(`conductores: ${A.full_name} en JMC (${vehs[0].placa}) · ${B.full_name} en Rionegro (${vehs[1].placa})`);
  if (PICO) {
    // El que tiene el apoyo: sin turno abierto, con el carro parqueado en JMC.
    const AP = await cond('apoyo');
    await c.query(`INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id)
       SELECT $1, CASE WHEN l::time < time '02:00' THEN l::date - 1 ELSE l::date END, CASE WHEN l::time >= time '02:00' AND l::time < time '14:00' THEN 'am' ELSE 'pm' END, $2
         FROM (SELECT now() AT TIME ZONE 'America/Bogota' AS l) x
       ON CONFLICT (organization_id, day, band) DO UPDATE SET driver_profile_id = EXCLUDED.driver_profile_id`, [org, AP.id]);
    await gps(AP.id, 'jmc');
    console.log(`apoyo: ${AP.full_name}, parqueado en JMC, sin turno abierto`);
  }
} else if (orden === 'latido') {
  for (const k of ['julian', 'juan', 'apoyo']) {
    const d = await cond(k); if (!d) continue;
    const u = await one(`SELECT latitude, longitude FROM public.driver_locations WHERE driver_profile_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [d.id]);
    const ocupado = await one(`SELECT 1 x FROM public.route_assignments ra WHERE ra.driver_profile_id = $1 AND ra.status = 'planned' AND ra.planned_start_at > now() - interval '2 hours'`, [d.id]);
    if (u && !ocupado) await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, $2, $3, now())`, [d.id, u.latitude, u.longitude]);
  }
  console.log('GPS refrescado (los libres)');
} else if (orden === 'vuelo') {
  const [, , , code, delta] = process.argv;
  const r = await one(`UPDATE public.flight_statuses SET estimated_at = estimated_at + make_interval(mins => $2), delay_min = coalesce(delay_min, 0) + $2, status = CASE WHEN $2 > 0 THEN 'delayed' ELSE status END, fetched_at = now() WHERE flight_code = $1 RETURNING estimated_at`, [code, Number(delta)]);
  console.log(r ? `${code}: FlightRadar ahora dice ${hm(r.estimated_at)}` : 'no existe ese vuelo');
} else if (orden === 'mover') {
  const [, , , k, donde] = process.argv; const d = await cond(k); await gps(d.id, donde); console.log(`${d.full_name} → ${donde}`);
}
if (orden !== 'limpiar') {
  const T = await trips();
  const filas = await q(`SELECT p.full_name quien, r.flight_code vuelo, ra.planned_start_at ini, pd.full_name conductor, v.license_plate placa, r.status_a2h::text estado,
       public.reub_baja(ra.organization_id, r.flight_code, r.required_arrival_at) baja, public.flight_deplane_min(r.flight_code) dep, ra.planned_start_at ini2
     FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
     JOIN public.route_stops rs ON rs.reservation_id = r.id JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
     LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id LEFT JOIN public.profiles pd ON pd.id = dp.profile_id LEFT JOIN public.vehicles v ON v.id = ra.vehicle_id
     WHERE r.auxiliar_profile_id = ANY($1) AND r.required_arrival_at > now() - interval '3 hours' ORDER BY r.required_arrival_at`, [T.map((t) => t.aux)]);
  const ahora = (await one(`SELECT now() n`)).n;
  console.log(`\nAHORA ${hm(ahora)}`);
  filas.forEach((f) => console.log(`  ${f.quien.padEnd(16)} ${f.vuelo} · sale ~${f.baja ? hm(Date.parse(f.baja) + f.dep * 60000) : '?'} · ${f.conductor ? 'ASIGNADA a ' + f.conductor + ' · recoge ' + hm(f.ini2) : 'EN ESPERA'}`));
  const log = await q(`SELECT l.created_at, l.kind, l.who, l.wait_min, l.pickup_at, pd.full_name conductor FROM public.arrival_dispatch_log l LEFT JOIN public.driver_profiles dp ON dp.id = l.driver_profile_id LEFT JOIN public.profiles pd ON pd.id = dp.profile_id WHERE l.created_at > now() - interval '3 hours' ORDER BY l.created_at`);
  if (log.length) { console.log('RASTRO DEL DESPACHO'); log.forEach((l) => console.log(`  ${hm(l.created_at)} · ${l.kind === 'asignada' ? `asignó ${l.who} a ${l.conductor}, recoge ${l.pickup_at ? hm(l.pickup_at) : '?'}, espera ${l.wait_min} min` : `AVISO a jefes: ${l.who} ${l.kind === 'sin_carro' ? 'sin carro' : 'esperaría ' + l.wait_min + ' min'}`}`)); }
}
await c.end();
