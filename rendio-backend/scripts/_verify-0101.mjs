// Verificación de 0101: al publicar con conductor la reserva queda «asignada».
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0101.mjs
import { localClient, fixtures } from './_local-fixtures.mjs';
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const res = async (dir) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at)
    VALUES ($1, $2::public.trip_direction, CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
            CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END, now() + interval '1 day') RETURNING id`, [fx.aux, dir])).id;
  const st = async (id) => one(`SELECT status_h2a::text h, status_a2h::text a FROM public.reservations WHERE id = $1`, [id]);
  const s1 = await res('home_to_airport'), l1 = await res('airport_to_home');
  const sinCond = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at) VALUES ('home_to_airport', 'planned', now()) RETURNING id`)).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [sinCond, s1]);
  check('ruta SIN conductor: sigue «pedido»', (await st(s1)).h === 'requested');
  await q(`DELETE FROM public.route_stops WHERE route_assignment_id = $1`, [sinCond]);
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'home_to_airport', 'planned', now()) RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, s1]);
  check('publicar con conductor: salida → assigned', (await st(s1)).h === 'assigned', (await st(s1)).h);
  const rl = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', now()) RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [rl, l1]);
  check('llegada → driver_assigned', (await st(l1)).a === 'driver_assigned', (await st(l1)).a);
  // Re-publicar: se borran las paradas y se vuelven a crear (como saveRoutePlan).
  await q(`DELETE FROM public.route_stops WHERE route_assignment_id = $1`, [ra]);
  check('sale del plan → vuelve a «pedido»', (await st(s1)).h === 'requested', (await st(s1)).h);
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, s1]);
  check('vuelve a entrar → assigned', (await st(s1)).h === 'assigned');
  const n = await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [`trip:${s1}:%`]);
  check('asignar NO manda avisos (solo los de 0097)', n.n === 0, n.n);
  // No pisa estados de avance.
  await q(`UPDATE public.reservations SET status_h2a = 'en_route' WHERE id = $1`, [s1]);
  await q(`DELETE FROM public.route_stops WHERE route_assignment_id = $1`, [ra]);
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, s1]);
  check('nunca pisa «en camino»', (await st(s1)).h === 'en_route', (await st(s1)).h);
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
