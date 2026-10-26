// Verificación de 0125 (la ruta de Julián: se pega, se avisa y los conductores la
// toman) contra la base LOCAL (127.0.0.1:54322). Aplica 0124 y 0125 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0125.mjs
//
// Qué prueba (el día de la ruta es MAÑANA en Bogotá):
//   1. Publicar: dos vueltas (salida de 2 con «Deben estar», llegada con vuelo), sin
//      conductor, del día; la hora de recogida queda en la reserva (la llegada =
//      aterrizaje + desembarque), las reservas siguen «pedidas», a cada tripulante
//      le llega su hora y a los conductores «Hay vueltas para tomar»; el apodo se
//      aprende.
//   2. El tripulante: publicada, con hora, sin conductor (driver_pending).
//   3. El conductor ve las dos; Juan toma la salida → es suya, con el carro de su
//      turno (0124), las reservas pasan a «asignada», al tripulante le llega «Juan te
//      recoge»; Daniel ya no la ve y si la intenta tomar, «ya la tomó otro».
//   4. Volver a pegar igual: no crea nada, no repite avisos, Juan la conserva.
//      Cambiar solo la hora: la conserva y avisa la hora nueva. Cambiar las personas:
//      la vuelta vieja se va (a Juan le llega «cambió una vuelta») y nace otra libre.
//   5. Soltar: vuelve a estar libre, las reservas a «pedida», aviso a los jefes y a
//      los demás conductores. Con una parada atendida ya no se puede.
//   6. Nadie la tomó y falta menos de una hora: aviso a los jefes, una sola vez.
//   7. Reserva tardía: con la ruta pegada publicada, un pedido nuevo sin vuelta abre
//      la eventualidad.
//   8. Quitar la ruta del día. Permisos (tripulante y conductor no publican; un jefe
//      no toma vueltas; internas cerradas).
//
// NO cubre: la pantalla (el lector del WhatsApp y el emparejamiento de nombres son
// de admin-ruta-julian.js: _smoke-ruta-julian-dom.mjs), la push de verdad, pg_cron
// real ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const outbox = async (prof, like) => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at`, [prof, like]); };
const iso = (x) => (x instanceof Date ? x.toISOString() : x);

await c.query('BEGIN');
try {
  // 0117 (avisos a los jefes) está en dev y producción; la base local puede no tenerla.
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  check('0125 se aplica (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Julián prueba 0125');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0125'), DANI = await drv('Daniel Alvarez prueba 0125');
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const ISA = await trip('Isabela Rivera prueba'), KAROL = await trip('Karol Lozada prueba'), JESS = await trip('Jessica Mora prueba'), TARDE = await trip('Tardía Pérez prueba');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, hm) => `${d}T${hm}:00-05:00`;
  const res = async (X, dir, d, hm) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', at(d, hm), fx.olivar])).id;
  const rIsa = await res(ISA, 'sal', man, '03:45'), rKarol = await res(KAROL, 'sal', man, '03:50'), rJess = await res(JESS, 'lle', man, '12:00');
  // Juan tiene turno abierto mañana desde la 01:30 en el carro de los datos de prueba.
  await q(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', $4::timestamptz)`, [fx.org, JUAN.dp, fx.vehicle, at(man, '01:30')]);

  const salida = (stops, dead) => ({ type: 'sal', deadline_at: dead ? at(man, dead) : null, stops: stops.map(([r, hm]) => ({ reservation_id: r, at: at(man, hm) })) });
  const llegada = (r, hm, flight) => ({ type: 'lle', flight, stops: [{ reservation_id: r, at: at(man, hm) }] });
  const publicar = async (blocks, aliases = []) => { await asUser(c, jefe, 'admin'); const r = (await one(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, $3::jsonb) AS r`, [man, JSON.stringify(blocks), JSON.stringify(aliases)])).r; await asDb(); return r; };
  const vueltas = async () => { await asDb(); return q(`SELECT ra.*, (SELECT array_agg(rs.reservation_id ORDER BY rs.stop_order) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id) ids
      FROM public.route_assignments ra WHERE ra.pool AND ra.organization_id = $1 ORDER BY ra.planned_start_at`, [fx.org]); };
  const reserva = async (id) => { await asDb(); return one(`SELECT status_h2a::text h2a, status_a2h::text a2h, calculated_pickup_at FROM public.reservations WHERE id = $1`, [id]); };

  // El tablero ya había publicado a Jessica en una vuelta (antes de la ruta de Julián).
  const raTablero = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car) VALUES ($1, 'airport_to_home', 'planned', $2::timestamptz, 'Carro 1') RETURNING id`, [DANI.dp, at(man, '12:20')])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [raTablero, rJess]);

  // ── 1. Publicar ───────────────────────────────────────────────────────────
  console.log('\n1. Julián pega su ruta');
  const p1 = await publicar([salida([[rIsa, '03:10'], [rKarol, '03:15']], '03:40'), llegada(rJess, '12:00', 'AV9563')], [{ alias: 'Karol L', auxiliar_profile_id: KAROL.a }]);
  const nDrv = (await one(`SELECT count(*)::int n FROM public.profiles WHERE organization_id = $1 AND role = 'driver'`, [fx.org])).n;
  check('crea 2 vueltas y avisa a los 3 tripulantes y a todos los conductores (' + nDrv + ')', p1.created === 2 && p1.notified === 3 && p1.drivers === nDrv, p1);
  let V = await vueltas();
  const vSal = V.find((v) => v.direction === 'home_to_airport'), vLle = V.find((v) => v.direction === 'airport_to_home');
  check('las dos: del día de mañana, publicadas (planned) y SIN conductor', V.length === 2 && V.every((v) => v.status === 'planned' && v.driver_profile_id === null && iso(v.manual_day).slice(0, 10) !== '' ), V.map((v) => [v.status, v.driver_profile_id]));
  check('la salida en el orden del jefe (Isa, Karol), con «Deben estar 3:40»', JSON.stringify(vSal.ids) === JSON.stringify([rIsa, rKarol]) && new Date(vSal.deadline_at).getTime() === Date.parse(at(man, '03:40')));
  check('la salida arranca con la primera recogida (3:10)', new Date(vSal.planned_start_at).getTime() === Date.parse(at(man, '03:10')));
  check('la llegada sale de JMC con el desembarque de Avianca (12:00 + 15 = 12:15)', new Date(vLle.planned_start_at).getTime() === Date.parse(at(man, '12:15')), vLle.planned_start_at);
  const rI = await reserva(rIsa), rK = await reserva(rKarol), rJ = await reserva(rJess);
  check('la hora de recogida quedó en cada reserva (Isa 3:10, Karol 3:15, Jessica 12:15)',
    new Date(rI.calculated_pickup_at).getTime() === Date.parse(at(man, '03:10')) && new Date(rK.calculated_pickup_at).getTime() === Date.parse(at(man, '03:15'))
    && new Date(rJ.calculated_pickup_at).getTime() === Date.parse(at(man, '12:15')), [rI.calculated_pickup_at, rK.calculated_pickup_at, rJ.calculated_pickup_at]);
  check('siguen «pedidas» (nadie las ha tomado)', rI.h2a === 'requested' && rJ.a2h === 'scheduled', [rI.h2a, rJ.a2h]);
  check('a Isa: «Te recogemos a las 3:10 para estar en JMC a las 3:40»', (await outbox(ISA.u, '%Te recogemos a las 3:10 para estar en JMC a las 3:40%')).length === 1);
  check('a Jessica: «Cuando aterrices te esperamos en JMC»', (await outbox(JESS.u, '%Cuando aterrices te esperamos en JMC%')).length === 1);
  check('a los conductores: «Hay vueltas para tomar»', (await outbox(JUAN.u, 'Hay vueltas para tomar')).length === 1 && (await outbox(DANI.u, 'Hay vueltas para tomar')).length === 1);
  check('lo de Julián manda: Jessica salió de la vuelta del tablero, que quedó vacía y se fue', p1.from_board === 1 && !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [raTablero])), p1);
  check('el apodo «Karol L» quedó aprendido (en minúsculas)', !!(await one(`SELECT 1 FROM public.crew_aliases WHERE organization_id = $1 AND alias_norm = 'karol l' AND auxiliar_profile_id = $2`, [fx.org, KAROL.a])));

  // ── 2. El tripulante ──────────────────────────────────────────────────────
  console.log('\n2. Lo que ve el tripulante');
  await asUser(c, ISA.u, 'auxiliar');
  const misI = (await one(`SELECT public.auxiliar_my_trips(30) j`)).j.find((x) => x.id === rIsa);
  check('publicada, con su hora y sin conductor todavía (driver_pending)', misI && misI.published === true && misI.driver === null && misI.driver_pending === true && !!misI.pickup_at, misI && [misI.published, misI.driver_pending, misI.pickup_at]);
  check('su lugar en el carro: 1 de 2', misI && misI.pickup_pos === 1 && misI.pickup_total === 2, misI && [misI.pickup_pos, misI.pickup_total]);
  await asDb();

  // ── 3. Los conductores ────────────────────────────────────────────────────
  console.log('\n3. Los conductores toman');
  await asUser(c, JUAN.u, 'driver');
  const lista = (await one(`SELECT public.driver_open_routes() j`)).j;
  check('Juan ve las 2 vueltas disponibles, con nombres y lugar', lista.length === 2 && lista[0].stops.length === 2 && lista[0].stops[0].name === 'Isabela Rivera' && lista[0].stops[0].place === 'El Olivar', lista[0] && lista[0].stops);
  const t1 = (await one(`SELECT public.driver_take_route($1) j`, [vSal.id])).j;
  await asDb();
  V = await vueltas();
  const vSal2 = V.find((v) => v.id === vSal.id);
  check('la salida es de Juan, con el carro de su turno (0124)', vSal2.driver_profile_id === JUAN.dp && vSal2.vehicle_id === fx.vehicle && t1.plate === 'RDO481', [vSal2.driver_profile_id === JUAN.dp, vSal2.vehicle_id, t1]);
  check('Isa y Karol quedaron «asignadas»', (await reserva(rIsa)).h2a === 'assigned' && (await reserva(rKarol)).h2a === 'assigned');
  check('a Isa le llegó «Juan te recoge · a las 3:10 en el carro RDO481»', (await outbox(ISA.u, '%Te recoge a las 3:10 en el carro RDO481%')).length === 1);
  await asUser(c, DANI.u, 'driver');
  const listaD = (await one(`SELECT public.driver_open_routes() j`)).j;
  check('Daniel ya solo ve la llegada', listaD.length === 1 && listaD[0].id === vLle.id);
  const eTomada = await debeFallar(`SELECT public.driver_take_route($1)`, [vSal.id]);
  check('si Daniel intenta tomar la de Juan: «ya la tomó otro conductor»', eTomada && /ya la tomó otro conductor/.test(eTomada.message), eTomada && eTomada.message);
  await asDb();

  // ── 4. Volver a pegar ─────────────────────────────────────────────────────
  console.log('\n4. Julián vuelve a pegar');
  const nIsa0 = (await outbox(ISA.u, '%')).length;
  const p2 = await publicar([salida([[rIsa, '03:10'], [rKarol, '03:15']], '03:40'), llegada(rJess, '12:00', 'AV9563')]);
  check('igual: no crea ni quita nada y no repite avisos', p2.created === 0 && p2.kept === 2 && p2.removed === 0 && p2.notified === 0 && (await outbox(ISA.u, '%')).length === nIsa0, p2);
  check('…y Juan conserva su vuelta', (await vueltas()).find((v) => v.id === vSal.id).driver_profile_id === JUAN.dp);
  const p3 = await publicar([salida([[rIsa, '03:05'], [rKarol, '03:15']], '03:40'), llegada(rJess, '12:00', 'AV9563')]);
  check('solo cambia la hora de Isa: la conserva (con Juan) y le avisa la hora nueva', p3.kept === 2 && p3.created === 0 && (await vueltas()).find((v) => v.id === vSal.id).driver_profile_id === JUAN.dp
    && (await outbox(ISA.u, '%Te recogemos a las 3:05%')).length === 1, p3);
  const p4 = await publicar([salida([[rIsa, '03:05']], '03:30'), salida([[rKarol, '03:20']], '03:45'), llegada(rJess, '12:00', 'AV9563')]);
  V = await vueltas();
  check('cambian las personas: la vuelta de Juan se va y nacen dos libres', p4.removed === 1 && p4.created === 2 && !V.some((v) => v.id === vSal.id) && V.filter((v) => v.direction === 'home_to_airport').every((v) => v.driver_profile_id === null), p4);
  check('a Juan le llega «Cambió una vuelta que tomaste»', (await outbox(JUAN.u, 'Cambió una vuelta que tomaste')).length === 1);
  check('Isa y Karol vuelven a «pedidas» (nadie las tiene)', (await reserva(rIsa)).h2a === 'requested' && (await reserva(rKarol)).h2a === 'requested');

  // ── 5. Soltar ─────────────────────────────────────────────────────────────
  console.log('\n5. Soltar una vuelta');
  const vIsa = V.find((v) => JSON.stringify(v.ids) === JSON.stringify([rIsa]));
  await asUser(c, DANI.u, 'driver');
  await q(`SELECT public.driver_take_route($1)`, [vIsa.id]);
  await q(`SELECT public.driver_release_route($1)`, [vIsa.id]);
  await asDb();
  check('Daniel la soltó: libre otra vez y sin carro', (await one(`SELECT driver_profile_id d, vehicle_id v FROM public.route_assignments WHERE id = $1`, [vIsa.id])).d === null);
  check('Isa vuelve a «pedida»', (await reserva(rIsa)).h2a === 'requested');
  check('a los jefes: «Soltaron una vuelta»; a Juan: «Hay una vuelta libre»', (await outbox(jefe, 'Soltaron una vuelta')).length === 1 && (await outbox(JUAN.u, 'Hay una vuelta libre')).length === 1);
  await asUser(c, DANI.u, 'driver');
  await q(`SELECT public.driver_take_route($1)`, [vIsa.id]);
  await asDb();
  await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [vIsa.id]);
  await asUser(c, DANI.u, 'driver');
  const eSoltar = await debeFallar(`SELECT public.driver_release_route($1)`, [vIsa.id]);
  check('con una parada atendida ya no se puede soltar', eSoltar && /ya arrancó o no es tuya/.test(eSoltar.message), eSoltar && eSoltar.message);
  await asDb();

  // ── 6. Nadie la tomó ──────────────────────────────────────────────────────
  console.log('\n6. Nadie la tomó y falta menos de una hora');
  const rHoy = await res(TARDE, 'sal', hoy, '23:59');
  const ya = (await one(`SELECT (now() + interval '30 minutes') t`)).t;
  const raPronto = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, pool, organization_id, manual_day) VALUES ('home_to_airport', 'planned', $1, true, $2, $3::date) RETURNING id`, [ya, fx.org, hoy])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3)`, [raPronto, rHoy, ya]);
  const a1 = (await one(`SELECT public.pool_unclaimed_alerts() n`)).n;
  const a2 = (await one(`SELECT public.pool_unclaimed_alerts() n`)).n;
  check('aviso a los jefes «Nadie ha tomado una vuelta», una sola vez', a1 >= 1 && a2 === 0 && (await outbox(jefe, 'Nadie ha tomado una vuelta%')).length === 1, [a1, a2]);

  // ── 7. Reserva tardía ─────────────────────────────────────────────────────
  console.log('\n7. Pedido tardío con la ruta pegada');
  const rLate = await res(TARDE, 'sal', man, '09:00');
  await q(`SELECT public.detect_late_bookings()`);
  check('abre la eventualidad de reserva tardía', !!(await one(`SELECT 1 FROM public.incidents WHERE dedupe_key = 'late:' || $1::text`, [rLate])));

  // ── 8. Quitar y permisos ──────────────────────────────────────────────────
  console.log('\n8. Quitar la ruta del día y permisos');
  await asUser(c, jefe, 'admin');
  const quitadas = (await one(`SELECT public.admin_manual_route_clear($1::date) n`, [man])).n;
  await asDb();
  check('quitar la ruta: se van las que no arrancaron (la de Isa, con parada atendida, se queda)', quitadas >= 2 && +(await one(`SELECT count(*) n FROM public.route_assignments WHERE pool AND manual_day = $1::date`, [man])).n === 1, quitadas);
  await asUser(c, ISA.u, 'auxiliar');
  const e1 = await debeFallar(`SELECT public.admin_manual_route_publish($1::date, '[]'::jsonb)`, [man]);
  await asUser(c, JUAN.u, 'driver');
  const e2 = await debeFallar(`SELECT public.admin_manual_route_publish($1::date, '[]'::jsonb)`, [man]);
  await asUser(c, jefe, 'admin');
  const e3 = await debeFallar(`SELECT public.driver_take_route($1)`, [vLle.id]);
  const e4 = await debeFallar(`SELECT public.pool_unclaimed_alerts()`);
  check('ni el tripulante ni el conductor publican; un jefe no toma vueltas; la interna no se llama',
    e1 && /Solo un jefe/.test(e1.message) && e2 && /Solo un jefe/.test(e2.message) && e3 && /Solo un conductor/.test(e3.message) && e4 && /permission/i.test(e4.message),
    [e1, e2, e3, e4].map((e) => e && e.message));
  await asUser(c, JUAN.u, 'driver');
  check('un conductor no lee los apodos', (await q(`SELECT * FROM public.crew_aliases`)).length === 0);
  await asDb();
} catch (e) {
  fail++;
  console.error('  ✗ ERROR:', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
console.log('NO cubre: la pantalla (lector del WhatsApp y emparejamiento), la push de verdad, pg_cron real ni dev/producción.');
process.exit(fail ? 1 : 0);
