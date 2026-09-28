// Verificación de 0085: la hora de recogida publicada llega a la reserva, y el
// tripulante ya no puede hacer UPDATE directo a su reserva.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend && node scripts/_verify-0085.mjs
//
// Con 0085 aplicada sale en verde. Con el down aplicado tiene que FALLAR (así se
// comprueba que la prueba de verdad mira lo que la migración hace).
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };

// ¿calculated_pickup_at de la reserva es igual a la expresión SQL dada?
async function pickupEs(resId, exprSql, params = []) {
  const r = await one(`SELECT (calculated_pickup_at IS NOT DISTINCT FROM (${exprSql})) AS ok,
      coalesce(calculated_pickup_at::text, 'NULL') AS v FROM public.reservations WHERE id = $1`, [resId, ...params]);
  return r;
}
// Corre una sentencia que DEBE fallar, sin tumbar la transacción.
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0085');
  const reserva = async (dir = 'home_to_airport', offset = "interval '1 day'") => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      now() + ${offset}) RETURNING id`, [fx.aux, dir])).id;

  console.log('\n0. Estructura');
  const fn = await one(`SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.sync_calculated_pickup(uuid)')`);
  check('existe sync_calculated_pickup(uuid) y es SECURITY DEFINER', fn && fn.prosecdef === true, fn ? 'no es definer' : 'no existe');
  if (fn) {
    const priv = await one(`SELECT has_function_privilege('authenticated', 'public.sync_calculated_pickup(uuid)', 'EXECUTE') AS a,
                                   has_function_privilege('anon', 'public.sync_calculated_pickup(uuid)', 'EXECUTE') AS b`);
    check('authenticated NO puede ejecutarla', priv.a === false, priv.a);
    check('anon NO puede ejecutarla', priv.b === false, priv.b);
  }
  const trg = await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('tr_route_stops_sync_pickup','tr_route_assignments_sync_pickup')`);
  check('los dos triggers existen', trg.length === 2, trg.map(t => t.tgname).join(','));
  const pol = await q(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reservations' AND policyname = 'p_reservations_update_aux'`);
  check('la policy p_reservations_update_aux ya no existe', pol.length === 0);
  const rpcs = await q(`SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('auxiliar_cancel_reservation','auxiliar_confirm_ready','auxiliar_rate_reservation')`);
  check('cancelar/confirmar/calificar siguen por RPC SECURITY DEFINER (3)', rpcs.length === 3 && rpcs.every(r => r.prosecdef), JSON.stringify(rpcs));

  console.log('\n1. Salida publicada por la jefa (como authenticated, pasando por RLS)');
  const s1 = await reserva('home_to_airport');
  await asUser(c, jefe, 'admin');
  const ra1 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '1 day' - interval '2 hours') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '1 day' - interval '90 minutes')`, [ra1, s1]);
  await asAdminDb(c);
  let r = await one(`SELECT (r.calculated_pickup_at IS NOT DISTINCT FROM rs.estimated_arrival_at) AS ok, coalesce(r.calculated_pickup_at::text,'NULL') v
      FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [s1]);
  check('calculated_pickup_at = ETA de su parada', r.ok, r.v);

  console.log('\n2. La ETA de la parada cambia');
  await asUser(c, jefe, 'admin');
  await q(`UPDATE public.route_stops SET estimated_arrival_at = estimated_arrival_at + interval '12 minutes' WHERE reservation_id = $1`, [s1]);
  await asAdminDb(c);
  r = await one(`SELECT (r.calculated_pickup_at IS NOT DISTINCT FROM rs.estimated_arrival_at) AS ok, coalesce(r.calculated_pickup_at::text,'NULL') v
      FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [s1]);
  check('se mueve con la ETA', r.ok, r.v);

  console.log('\n3. Llegada: la hora es la salida del carro de MDE');
  const l1 = await reserva('airport_to_home');
  const ra2 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'airport_to_home', 'planned', now() + interval '1 day' + interval '20 minutes') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '1 day' + interval '70 minutes')`, [ra2, l1]);
  r = await pickupEs(l1, `SELECT planned_start_at FROM public.route_assignments WHERE id = $2`, [ra2]);
  check('llegada: calculated_pickup_at = planned_start_at (no la ETA de la casa)', r.ok, r.v);
  await q(`UPDATE public.route_assignments SET planned_start_at = planned_start_at + interval '15 minutes' WHERE id = $1`, [ra2]);
  r = await pickupEs(l1, `SELECT planned_start_at FROM public.route_assignments WHERE id = $2`, [ra2]);
  check('mover la salida del carro la mueve', r.ok, r.v);

  console.log('\n4. Borrador sin conductor: no publica hora');
  const s2 = await reserva('home_to_airport');
  const ra3 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES (NULL, $1, 'home_to_airport', 'draft', now() + interval '1 day' - interval '2 hours') RETURNING id`, [fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '1 day' - interval '100 minutes')`, [ra3, s2]);
  r = await pickupEs(s2, 'NULL');
  check('borrador → NULL', r.ok, r.v);
  await q(`UPDATE public.route_assignments SET driver_profile_id = $2, status = 'planned' WHERE id = $1`, [ra3, fx.driver]);
  r = await one(`SELECT (r.calculated_pickup_at IS NOT DISTINCT FROM rs.estimated_arrival_at) AS ok, coalesce(r.calculated_pickup_at::text,'NULL') v
      FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [s2]);
  check('al asignarle conductor y publicar → toma la ETA', r.ok, r.v);
  await q(`UPDATE public.route_assignments SET driver_profile_id = NULL, status = 'draft' WHERE id = $1`, [ra3]);
  r = await pickupEs(s2, 'NULL');
  check('al quitarle el conductor → vuelve a NULL', r.ok, r.v);

  console.log('\n5. Ciclo de vida de la ruta');
  await q(`UPDATE public.route_assignments SET status = 'in_progress' WHERE id = $1`, [ra1]);
  r = await pickupEs(s1, 'NULL');
  check('en curso: la hora sigue (no es NULL)', !r.ok, r.v);
  const antes = r.v;
  await q(`UPDATE public.route_assignments SET status = 'completed' WHERE id = $1`, [ra1]);
  r = await one(`SELECT coalesce(calculated_pickup_at::text,'NULL') v FROM public.reservations WHERE id = $1`, [s1]);
  check('completed: la hora SE CONSERVA', r.v === antes && r.v !== 'NULL', `${antes} → ${r.v}`);
  await q(`UPDATE public.route_assignments SET status = 'cancelled' WHERE id = $1`, [ra2]);
  r = await pickupEs(l1, 'NULL');
  check('ruta cancelada (despublicar) → NULL', r.ok, r.v);
  await q(`UPDATE public.route_assignments SET status = 'planned' WHERE id = $1`, [ra2]);
  r = await pickupEs(l1, `SELECT planned_start_at FROM public.route_assignments WHERE id = $2`, [ra2]);
  check('re-publicar → vuelve la hora', r.ok, r.v);
  // Así borra el tablero lo que no ha arrancado (saveRoutePlan): la ruta entera,
  // y las paradas se van en cascada.
  await asUser(c, jefe, 'admin');
  await q(`DELETE FROM public.route_assignments WHERE id = $1`, [ra2]);
  await asAdminDb(c);
  r = await pickupEs(l1, 'NULL');
  check('borrar la ruta (paradas en cascada) → NULL', r.ok, r.v);

  console.log('\n6. Relleno de lo que ya estaba publicado');
  const s3 = await reserva('home_to_airport');
  const ra4 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '1 day' - interval '3 hours') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '1 day' - interval '150 minutes')`, [ra4, s3]);
  // Simula el estado de antes de 0085: la columna nunca escrita.
  await q(`UPDATE public.reservations SET calculated_pickup_at = NULL WHERE id = ANY($1)`, [[s1, s3]]);
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../supabase/migrations/0085_hora_de_recogida_publicada.sql', import.meta.url), 'utf8');
  const i0 = sql.indexOf('-- RELLENO:INICIO'), i1 = sql.indexOf('-- RELLENO:FIN');
  if (i0 < 0 || i1 < 0) throw new Error('no encuentro el bloque RELLENO en la migración');
  await c.query(sql.slice(sql.indexOf('\n', i0) + 1, i1));
  r = await one(`SELECT (r.calculated_pickup_at IS NOT DISTINCT FROM rs.estimated_arrival_at) AS ok, coalesce(r.calculated_pickup_at::text,'NULL') v
      FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [s3]);
  check('relleno: ruta publicada → toma la ETA', r.ok, r.v);
  r = await one(`SELECT coalesce(calculated_pickup_at::text,'NULL') v FROM public.reservations WHERE id = $1`, [s1]);
  check('relleno: ruta ya completada → también (se conserva lo hecho)', r.v !== 'NULL', r.v);

  console.log('\n7. El tripulante ya no hace UPDATE directo');
  await asUser(c, fx.auxUser, 'auxiliar');
  const vis = await q(`SELECT id FROM public.reservations WHERE id = $1`, [s3]);
  check('la sigue VIENDO (select intacto)', vis.length === 1);
  const upd = await c.query(`UPDATE public.reservations SET status_h2a = 'delivered', notes = 'hackeada' WHERE id = $1`, [s3]);
  check('UPDATE directo no toca ninguna fila', upd.rowCount === 0, upd.rowCount);
  await asAdminDb(c);
  const st = await one(`SELECT status_h2a::text s, notes FROM public.reservations WHERE id = $1`, [s3]);
  check('el estado quedó como estaba', st.s === 'requested' && st.notes == null, JSON.stringify(st));

  console.log('\n8. Efecto documentado: la regla de 2 h de la función vieja');
  // Traslado en 3 h con la recogida publicada en 1 h: dentro de las 2 h.
  const s4 = await reserva('home_to_airport', "interval '3 hours'");
  const ra5 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '50 minutes') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '1 hour')`, [ra5, s4]);
  await asUser(c, fx.auxUser, 'auxiliar');
  const err = await debeFallar(`SELECT public.cancel_reservation($1, 'prueba')`, [s4]);
  check('cancel_reservation (0005, el front NO la usa) ahora sí aplica sus 2 h', err && /2 horas/.test(err), err || 'no falló');
  const okCancel = await one(`SELECT public.auxiliar_cancel_reservation($1, 'prueba') AS r`, [s4]);
  check('auxiliar_cancel_reservation (0050, la que usa el front) cancela igual', okCancel.r && okCancel.r.ok === true, JSON.stringify(okCancel.r));
  await asAdminDb(c);
  r = await pickupEs(s4, 'NULL');
  check('la cancelada sale de la ruta y pierde la hora', r.ok, r.v);
} catch (e) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
