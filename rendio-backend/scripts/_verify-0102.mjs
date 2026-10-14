// Verificación de 0102: «Deshacer» en la lista del aeropuerto (driver_airport_undo).
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0102.mjs
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
// Llama una RPC como el conductor dentro de un savepoint: si revienta, devuelve el error.
async function rpc(userId, sql, params) {
  await c.query('SAVEPOINT s');
  try { await asUser(c, userId, 'driver'); const r = await one(sql, params); await asAdminDb(c); await c.query('RELEASE SAVEPOINT s'); return { r }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return { e }; }
}
await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const res = async (dir, code) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, meet_code)
    VALUES ($1, $2::public.trip_direction, CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
            CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END, now() + interval '2 hours', $3) RETURNING id`, [fx.aux, dir, code])).id;
  const A = await res('airport_to_home', '47'), B = await res('airport_to_home', '12');
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', now()) RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1), ($1, $3, 2)`, [ra, A, B]);
  const est = async (id) => one(`SELECT r.status_a2h::text a, r.boarding_check b, r.boarding_checked_at bt, rs.status s, rs.actual_pickup_at p
                                    FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [id]);

  const llego = await rpc(fx.drvUser, `SELECT public.driver_mark_airport_arrival($1) n`, [ra]);
  check('«Llegué al aeropuerto»: las 2 paradas quedan «llegó»', !llego.e && llego.r.n === 2 && (await est(A)).s === 'arrived', llego.e && llego.e.message);

  const nada = await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [A]);
  check('deshacer algo sin resolver: lo dice (nada_que_deshacer)', nada.e && /no está resuelta/.test(nada.e.message), nada.e ? nada.e.message : JSON.stringify(nada.r));

  await rpc(fx.drvUser, `SELECT public.driver_board_with_code($1, '47', false) r`, [A]);
  const a1 = await est(A);
  check('A a bordo con su código', a1.s === 'picked_up' && a1.a === 'picked_up' && a1.b === 'codigo', JSON.stringify(a1));
  const u1 = await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [A]);
  const a2 = await est(A);
  check('deshacer «a bordo»: devuelve picked_up y la parada vuelve a «llegó»', !u1.e && u1.r.r === 'picked_up' && a2.s === 'arrived' && !a2.p, u1.e ? u1.e.message : JSON.stringify(a2));
  check('…la reserva vuelve a «conductor asignado» y pierde la marca de abordaje', a2.a === 'driver_assigned' && a2.b === null && a2.bt === null, JSON.stringify(a2));
  check('deshacer «a bordo» no le avisa nada al tripulante', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key = $1`, [`trip:${A}:apt_undo`])).n === 0);

  await rpc(fx.drvUser, `SELECT public.driver_airport_no_show($1) r`, [B]);
  check('B «No llegó»', (await est(B)).s === 'no_show');
  const u2 = await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [B]);
  check('deshacer «No llegó»: devuelve no_show y la parada vuelve a «llegó»', !u2.e && u2.r.r === 'no_show' && (await est(B)).s === 'arrived', u2.e && u2.e.message);
  const av = await one(`SELECT title, body FROM public.notification_outbox WHERE dedupe_key = $1`, [`trip:${B}:apt_undo`]);
  check('…y al tripulante le llega «Tu conductor todavía te espera» con su código', av && /todavía te espera/.test(av.title) && /12/.test(av.body), JSON.stringify(av));
  await rpc(fx.drvUser, `SELECT public.driver_airport_no_show($1) r`, [B]);
  await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [B]);
  check('el aviso de «todavía te espera» no se repite (dedupe)', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key = $1`, [`trip:${B}:apt_undo`])).n === 1);

  // Ya salió del aeropuerto: no se deshace.
  await rpc(fx.drvUser, `SELECT public.driver_board_with_code($1, '47', false) r`, [A]);
  await rpc(fx.drvUser, `SELECT public.driver_set_reservation_status($1, 'en_route_home') r`, [A]);
  const u3 = await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [A]);
  check('rumbo a casa: ya no se deshace (ya_salio)', u3.e && /ya salió/.test(u3.e.message), u3.e ? u3.e.message : JSON.stringify(u3.r));

  // Otro conductor no puede.
  const otroUser = await user(c, fx.org, 'driver', 'Otro Conductor');
  await q(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1)`, [otroUser]);
  const u4 = await rpc(otroUser, `SELECT public.driver_airport_undo($1) r`, [B]);
  check('otro conductor: no es su ruta', u4.e && /no está en una ruta activa/.test(u4.e.message), u4.e ? u4.e.message : JSON.stringify(u4.r));

  // Salida: no aplica.
  const S = await res('home_to_airport', '33');
  const rs = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'home_to_airport', 'planned', now()) RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [rs, S]);
  const u5 = await rpc(fx.drvUser, `SELECT public.driver_airport_undo($1) r`, [S]);
  check('en una salida no aplica', u5.e && /solo en una llegada/.test(u5.e.message), u5.e ? u5.e.message : JSON.stringify(u5.r));

  // Permisos: anon no la puede llamar.
  const g = await one(`SELECT has_function_privilege('anon', 'public.driver_airport_undo(uuid)', 'EXECUTE') a, has_function_privilege('authenticated', 'public.driver_airport_undo(uuid)', 'EXECUTE') u`);
  check('anon no la ejecuta; authenticated sí (el guardián valida al conductor)', g.a === false && g.u === true, JSON.stringify(g));
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
