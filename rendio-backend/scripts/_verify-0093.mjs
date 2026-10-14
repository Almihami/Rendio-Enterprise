// Verificación de 0093: pickup_pos / pickup_total / ground_ops en
// auxiliar_my_trips y el vuelo vacío en auxiliar_change_flight (tierra).
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0093.mjs
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const misViajes = async (uid) => { await como(uid); const r = await one(`SELECT public.auxiliar_my_trips(30) v`); await comoDb(); return r.v || []; };
const viaje = async (uid, id) => (await misViajes(uid)).find(x => x.id === id);
const pos = (t) => (t && t.pickup_pos != null ? `${t.pickup_pos}/${t.pickup_total}` : 'nada');
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message }; }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const terUser = await user(c, fx.org, 'auxiliar', 'Tercera de Llanogrande');
  const ter = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [terUser, fx.llano])).id;
  const cuartaUser = await user(c, fx.org, 'auxiliar', 'Cuarta sola');
  const cuarta = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [cuartaUser, fx.olivar])).id;

  // Hora de Bogotá: día + d a las HH:MM.
  const ts = async (d, hhmm) => (await one(`SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Bogota') + ($1 || ' days')::interval + $2::time) AT TIME ZONE 'America/Bogota') AS t`, [String(d), hhmm])).t;
  const res = async (aux, dir, when, extra = {}) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, residence_id, ground_ops)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      $3, $4, $5) RETURNING id`, [aux, dir, when, fx.olivar, !!extra.ground])).id;
  const ruta = async (dir, start, status = 'planned') => (await one(`INSERT INTO public.route_assignments
      (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fx.driver, fx.vehicle, dir, status, start])).id;
  const parada = async (ra, resId, order, eta) => q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, $3, $4)`, [ra, resId, order, eta]);

  console.log('\n1. Ruta publicada con 3 (salida, día +1)');
  const a1 = await res(fx.aux, 'home_to_airport', await ts(1, '05:10'));
  const a2 = await res(fx.vecino, 'home_to_airport', await ts(1, '05:10'));
  const a3 = await res(ter, 'home_to_airport', await ts(1, '05:10'));
  const r1 = await ruta('home_to_airport', await ts(1, '03:40'));
  await parada(r1, a2, 1, await ts(1, '03:50'));
  await parada(r1, a1, 2, await ts(1, '04:00'));
  await parada(r1, a3, 3, await ts(1, '04:20'));
  check('la vecina (1ª parada) ve 1/3', pos(await viaje(fx.vecinoUser, a2)) === '1/3', pos(await viaje(fx.vecinoUser, a2)));
  check('Laura (2ª) ve 2/3', pos(await viaje(fx.auxUser, a1)) === '2/3', pos(await viaje(fx.auxUser, a1)));
  check('la tercera ve 3/3', pos(await viaje(terUser, a3)) === '3/3', pos(await viaje(terUser, a3)));

  console.log('\n2. Se cancela la primera');
  await q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE id = $1`, [a2]);
  check('Laura pasa a 1/2', pos(await viaje(fx.auxUser, a1)) === '1/2', pos(await viaje(fx.auxUser, a1)));
  check('la tercera pasa a 2/2', pos(await viaje(terUser, a3)) === '2/2', pos(await viaje(terUser, a3)));

  console.log('\n3. Sin publicar y sola');
  const b1 = await res(cuarta, 'home_to_airport', await ts(2, '06:00'));
  let t = await viaje(cuartaUser, b1);
  check('sin ruta: no hay orden (ni placeholder)', t && t.pickup_pos == null && t.pickup_total == null, JSON.stringify(t && [t.pickup_pos, t.pickup_total]));
  const r2 = await ruta('home_to_airport', await ts(2, '04:30'));
  await parada(r2, b1, 1, await ts(2, '04:45'));
  check('publicada y sola: 1/1', pos(await viaje(cuartaUser, b1)) === '1/1', pos(await viaje(cuartaUser, b1)));

  console.log('\n4. Carro en curso + pasajera nueva en otra ruta del mismo carro (día +3)');
  const c1 = await res(fx.aux, 'home_to_airport', await ts(3, '05:10'));
  const c2 = await res(fx.vecino, 'home_to_airport', await ts(3, '05:10'));
  const c3 = await res(ter, 'home_to_airport', await ts(3, '05:10'));
  const r3 = await ruta('home_to_airport', await ts(3, '03:40'), 'in_progress');
  await parada(r3, c1, 1, await ts(3, '03:50'));
  await parada(r3, c2, 2, await ts(3, '04:00'));
  const r4 = await ruta('home_to_airport', await ts(3, '03:55'));
  await parada(r4, c3, 1, await ts(3, '04:15'));
  check('Laura 1/3', pos(await viaje(fx.auxUser, c1)) === '1/3', pos(await viaje(fx.auxUser, c1)));
  check('la vecina 2/3', pos(await viaje(fx.vecinoUser, c2)) === '2/3', pos(await viaje(fx.vecinoUser, c2)));
  check('la nueva 3/3 (no «1/1»)', pos(await viaje(terUser, c3)) === '3/3', pos(await viaje(terUser, c3)));

  console.log('\n5. La vuelta siguiente del mismo carro no se junta');
  const d1 = await res(cuarta, 'home_to_airport', await ts(3, '09:00'));
  const r5 = await ruta('home_to_airport', await ts(3, '07:40'));
  await parada(r5, d1, 1, await ts(3, '07:55'));
  check('la de las 9:00 ve 1/1', pos(await viaje(cuartaUser, d1)) === '1/1', pos(await viaje(cuartaUser, d1)));
  check('y Laura sigue en 1/3', pos(await viaje(fx.auxUser, c1)) === '1/3', pos(await viaje(fx.auxUser, c1)));

  console.log('\n6. Tierra');
  const g1 = await res(fx.aux, 'airport_to_home', await ts(4, '15:00'), { ground: true });
  t = await viaje(fx.auxUser, g1);
  check('ground_ops = true en Mis viajes', t && t.ground_ops === true, t && t.ground_ops);
  check('un viaje normal trae ground_ops = false', (await viaje(fx.auxUser, a1)).ground_ops === false);
  await como(fx.auxUser);
  let r = await intenta(`SELECT public.auxiliar_change_flight($1, NULL, $2) v`, [g1, await ts(4, '16:00')]);
  await comoDb();
  check('llegada de tierra: cambiar la hora SIN vuelo funciona', !r.err, r.err || JSON.stringify(r.rows[0].v));
  const n1 = await res(fx.aux, 'airport_to_home', await ts(5, '15:00'));
  await como(fx.auxUser);
  r = await intenta(`SELECT public.auxiliar_change_flight($1, NULL, $2) v`, [n1, await ts(5, '16:00')]);
  await comoDb();
  check('llegada normal sin vuelo: sigue exigiendo vuelo', !!r.err, JSON.stringify(r.rows && r.rows[0]));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: el tablero real que publica (saveRoutePlan), ni pantallas.');
process.exit(fail ? 1 : 0);
