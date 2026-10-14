// Verificación de 0097: avisos del traslado desde el servidor y código de 2 dígitos.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0097.mjs
//
// LO QUE NO CUBRE: que el push llegue al teléfono (eso es dispatch-notifications
// + el servicio de push del navegador); aquí se comprueba lo que entra a la
// bandeja (a quién, qué dice, que no se repite). El despacho inmediato
// (trip_kick → pg_net) queda dentro de la transacción y se deshace con ella.
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message, hint: e.hint }; }
}
const avisos = async (profile) => q(`SELECT title, body, url, dedupe_key FROM public.notification_outbox WHERE profile_id = $1 ORDER BY created_at, title`, [profile]);
const comoConductor = async (fx, fn) => { await como(fx.drvUser); try { return await fn(); } finally { await comoDb(); } };

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  await q(`UPDATE public.profiles SET full_name = 'Carlos Mejía' WHERE id = $1`, [fx.drvUser]);
  await q(`UPDATE public.vehicles SET internal_code = 'V-03' WHERE id = $1`, [fx.vehicle]);
  // Que no haya ruido de otras pruebas en la bandeja de estos perfiles.
  const ts = async (min) => (await one(`SELECT now() + ($1 || ' minutes')::interval AS t`, [String(min)])).t;
  const res = async (aux, dir, arrival, extra = {}) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, residence_id, pickup_latitude, pickup_longitude, meeting_point)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      $3, $4, 6.1523, -75.3781, $5) RETURNING id, meet_code`, [aux, dir, arrival, fx.olivar, extra.meet || null]));
  const ruta = async (dir, start) => (await one(`INSERT INTO public.route_assignments
      (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, $3, 'planned', $4) RETURNING id`,
      [fx.driver, fx.vehicle, dir, start])).id;
  const parada = async (ra, resId, order, eta) => q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, $3, $4)`, [ra, resId, order, eta]);

  console.log('\n1. Código de encuentro de 2 dígitos');
  const s1 = await res(fx.aux, 'home_to_airport', await ts(90), { meet: 'Portería 2' });
  check('la base genera 2 dígitos', /^[0-9]{2}$/.test(s1.meet_code || ''), s1.meet_code);
  const viejo = await intenta(`UPDATE public.reservations SET meet_code = '1234' WHERE id = $1`, [s1.id]);
  check('un código viejo de 4 dígitos sigue siendo válido', !viejo.err, viejo.err);
  const malo = await intenta(`UPDATE public.reservations SET meet_code = '123' WHERE id = $1`, [s1.id]);
  check('3 dígitos no pasa el CHECK', !!malo.err);
  await q(`UPDATE public.reservations SET meet_code = '27' WHERE id = $1`, [s1.id]);

  console.log('\n2. Avisos por estado (salida)');
  const r1 = await ruta('home_to_airport', await ts(5));
  await parada(r1, s1.id, 1, await ts(8));
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'en_route')`, [s1.id]));
  let a = await avisos(fx.auxUser);
  const enCamino = a.find(x => x.dedupe_key === `trip:${s1.id}:en_route`);
  check('«Eres el siguiente» al tripulante', !!enCamino, JSON.stringify(a.map(x => x.title)));
  check('dice quién va, el carro y el código', enCamino && /Carlos/.test(enCamino.body) && /V-03/.test(enCamino.body) && /27/.test(enCamino.body), enCamino && enCamino.body);
  check('el enlace abre ESE viaje', enCamino && enCamino.url === `/#/viaje?r=${s1.id}`, enCamino && enCamino.url);
  // Tocar otra vez «Iniciar ruta» no repite el aviso.
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'en_route')`, [s1.id]));
  check('re-tocar «en camino» no lo repite', (await avisos(fx.auxUser)).filter(x => /en_route$/.test(x.dedupe_key)).length === 1);
  // Aunque ya haya salido (sent_at), la misma clave no vuelve a entrar.
  await q(`UPDATE public.notification_outbox SET sent_at = now() WHERE dedupe_key = $1`, [`trip:${s1.id}:en_route`]);
  await q(`UPDATE public.reservations SET status_h2a = 'assigned' WHERE id = $1`, [s1.id]);
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'en_route')`, [s1.id]));
  check('ni después de enviado', (await avisos(fx.auxUser)).filter(x => /en_route$/.test(x.dedupe_key)).length === 1);

  console.log('\n3. Por llegar (GPS del teléfono y del detector)');
  const cerca = await comoConductor(fx, () => one(`SELECT public.driver_near_stop($1) AS ok`, [s1.id]));
  check('driver_near_stop encola «por llegar»', cerca.ok === true);
  const cerca2 = await comoConductor(fx, () => one(`SELECT public.driver_near_stop($1) AS ok`, [s1.id]));
  check('una sola vez', cerca2.ok === false);
  const near = (await avisos(fx.auxUser)).find(x => /:near$/.test(x.dedupe_key));
  check('el texto pide salir con el código', near && /código: 27/.test(near.body), near && near.body);

  console.log('\n4. Llegó y abordar con código');
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'at_pickup')`, [s1.id]));
  const llego = (await avisos(fx.auxUser)).find(x => /:at_pickup$/.test(x.dedupe_key));
  check('«¡Tu conductor llegó!» con espera y punto', llego && /Te espera \d+ min/.test(llego.body) && /Portería 2/.test(llego.body), llego && llego.body);
  const mal = await comoConductor(fx, () => intenta(`SELECT public.driver_board_with_code($1, '72')`, [s1.id]));
  check('código equivocado → error legible', mal.err && /no coincide/.test(mal.err) && mal.hint === 'codigo_incorrecto', mal.err);
  let st = await one(`SELECT status_h2a::text s, boarding_check FROM public.reservations WHERE id = $1`, [s1.id]);
  check('y NO lo sube', st.s === 'at_pickup', st.s);
  const vacio = await comoConductor(fx, () => intenta(`SELECT public.driver_board_with_code($1, '')`, [s1.id]));
  check('sin escribir nada → pide el código', vacio.err && vacio.hint === 'codigo_vacio', vacio.err);
  const bien = await comoConductor(fx, () => one(`SELECT public.driver_board_with_code($1, ' 2-7 ') AS r`, [s1.id]));
  check('código correcto (con espacios/guiones) → a bordo', bien.r && bien.r.ok === true && bien.r.verificado === true, JSON.stringify(bien.r));
  st = await one(`SELECT r.status_h2a::text s, r.boarding_check, rs.status rs FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id WHERE r.id = $1`, [s1.id]);
  check('estado on_board + parada picked_up + registrado «codigo»', st.s === 'on_board' && st.rs === 'picked_up' && st.boarding_check === 'codigo', JSON.stringify(st));

  console.log('\n5. Sin código y no se presentó');
  const s2 = await res(fx.vecino, 'home_to_airport', await ts(90));
  await parada(r1, s2.id, 2, await ts(12));
  const sin = await comoConductor(fx, () => one(`SELECT public.driver_board_with_code($1, NULL, true) AS r`, [s2.id]));
  st = await one(`SELECT status_h2a::text s, boarding_check FROM public.reservations WHERE id = $1`, [s2.id]);
  check('«Sin código» sube y queda registrado', sin.r.verificado === false && st.s === 'on_board' && st.boarding_check === 'sin_codigo', JSON.stringify(st));
  const terUser = await user(c, fx.org, 'auxiliar', 'Tercera');
  const ter = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [terUser, fx.llano])).id;
  const s3 = await res(ter, 'home_to_airport', await ts(90));
  await parada(r1, s3.id, 3, await ts(15));
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'no_show')`, [s3.id]));
  const ns = (await avisos(terUser)).find(x => /:no_show$/.test(x.dedupe_key));
  check('«No pudimos recogerte»', ns && /esperó \d+ min/.test(ns.body), ns && ns.body);

  console.log('\n6. Otro conductor no puede');
  const otroUser = await user(c, fx.org, 'driver', 'Otro Conductor');
  await q(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1)`, [otroUser]);
  await como(otroUser);
  const ajeno = await intenta(`SELECT public.driver_board_with_code($1, '27')`, [s1.id]);
  await comoDb();
  check('board de una reserva ajena revienta', !!ajeno.err, ajeno.err);
  await como(fx.auxUser);
  const tripu = await intenta(`SELECT public.driver_near_stop($1)`, [s1.id]);
  await comoDb();
  check('un tripulante no puede llamar driver_near_stop', !!tripu.err);

  console.log('\n7. Llegadas (MDE → casa)');
  const l1 = await res(fx.aux, 'airport_to_home', await ts(30), { meet: 'Salida nacional, puerta 3' });
  const l2 = await res(fx.vecino, 'airport_to_home', await ts(30));
  const r2 = await ruta('airport_to_home', await ts(50));
  await parada(r2, l1.id, 1, await ts(70));
  await parada(r2, l2.id, 2, await ts(80));
  const n = await comoConductor(fx, () => one(`SELECT public.driver_mark_airport_arrival($1) AS n`, [r2]));
  check('«Llegué al aeropuerto» marca las 2 paradas', n.n === 2, n.n);
  const apt = (await avisos(fx.auxUser)).find(x => x.dedupe_key === `trip:${l1.id}:apt_arrived`);
  check('aviso al tripulante con punto y código', apt && /Salida nacional, puerta 3/.test(apt.body) && new RegExp(l1.meet_code).test(apt.body), apt && apt.body);
  const ancla = await one(`SELECT count(*)::int n FROM public.driver_locations WHERE route_assignment_id = $1 AND source = 'anchor'`, [r2]);
  check('deja el ancla del carro en el aeropuerto', ancla.n === 1, ancla.n);
  const rs2 = await q(`SELECT status FROM public.route_stops WHERE route_assignment_id = $1`, [r2]);
  check('paradas en «arrived»', rs2.every(x => x.status === 'arrived'), JSON.stringify(rs2));
  const sal = await comoConductor(fx, () => intenta(`SELECT public.driver_mark_airport_arrival($1)`, [r1]));
  check('en una salida no aplica', !!sal.err);
  await comoConductor(fx, () => q(`SELECT public.driver_airport_no_show($1)`, [l2.id]));
  const lns = (await avisos(fx.vecinoUser)).find(x => x.dedupe_key === `trip:${l2.id}:apt_no_show`);
  const lrs = await one(`SELECT status FROM public.route_stops WHERE reservation_id = $1`, [l2.id]);
  check('«No te encontramos en el aeropuerto» + parada no_show', lns && lrs.status === 'no_show', lrs.status);
  const ok1 = await comoConductor(fx, () => one(`SELECT public.driver_board_with_code($1, $2) AS r`, [l1.id, l1.meet_code]));
  const l1s = await one(`SELECT status_a2h::text s FROM public.reservations WHERE id = $1`, [l1.id]);
  check('en llegada, el código lo deja «picked_up»', ok1.r.ok && l1s.s === 'picked_up', l1s.s);

  console.log('\n8. Detector del minuto');
  // (a) recordatorio 10 min antes de la recogida publicada.
  const cuartaUser = await user(c, fx.org, 'auxiliar', 'Cuarta Persona');
  const cuarta = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [cuartaUser, fx.olivar])).id;
  const s4 = await res(cuarta, 'home_to_airport', await ts(60));
  const r3 = await ruta('home_to_airport', await ts(5));
  await parada(r3, s4.id, 1, await ts(8));
  await q(`UPDATE public.reservations SET calculated_pickup_at = now() + interval '8 minutes' WHERE id = $1`, [s4.id]);
  const lejos = await res(cuarta, 'home_to_airport', await ts(300));
  const r4 = await ruta('home_to_airport', await ts(200));
  await parada(r4, lejos.id, 1, await ts(240));
  await q(`UPDATE public.reservations SET calculated_pickup_at = now() + interval '240 minutes' WHERE id = $1`, [lejos.id]);
  let d = await one(`SELECT public.detect_trip_reminders() AS t`);
  const rem = (await avisos(cuartaUser)).filter(x => /:remind:/.test(x.dedupe_key));
  check('recordatorio solo para la recogida de los próximos 10 min', rem.length === 1 && rem[0].dedupe_key.startsWith(`trip:${s4.id}:remind:`), JSON.stringify(rem.map(x => x.dedupe_key)));
  check('dice la hora', rem[0] && /^Te recogen a las \d{1,2}:\d{2} (a|p)\. m\./.test(rem[0].title), rem[0] && rem[0].title);
  await one(`SELECT public.detect_trip_reminders()`);
  check('el siguiente minuto no lo repite', (await avisos(cuartaUser)).filter(x => /:remind:/.test(x.dedupe_key)).length === 1);
  // Si republican con otra hora, la nueva hora tiene su propio recordatorio.
  await q(`UPDATE public.reservations SET calculated_pickup_at = now() + interval '6 minutes' WHERE id = $1`, [s4.id]);
  await one(`SELECT public.detect_trip_reminders()`);
  check('hora nueva → recordatorio nuevo', (await avisos(cuartaUser)).filter(x => /:remind:/.test(x.dedupe_key)).length === 2);
  // (c) al conductor, 20 min antes de la vuelta.
  const drv = (await avisos(fx.drvUser)).filter(x => x.dedupe_key && x.dedupe_key.startsWith(`drv:${r3}:start:`));
  check('el conductor recibe «Tu vuelta arranca a las…»', drv.length === 1 && /Iniciar ruta/.test(drv[0].body) && /Cuarta/.test(drv[0].body), JSON.stringify(drv));
  const drvLejos = (await avisos(fx.drvUser)).filter(x => x.dedupe_key && x.dedupe_key.startsWith(`drv:${r4}:`));
  check('no para la vuelta de dentro de 3 h', drvLejos.length === 0);
  // (b) por llegar con el GPS guardado.
  const quinta = await user(c, fx.org, 'auxiliar', 'Quinta Persona');
  const qa = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [quinta, fx.olivar])).id;
  const s5 = await res(qa, 'home_to_airport', await ts(60));
  const r5 = await ruta('home_to_airport', await ts(2));
  await parada(r5, s5.id, 1, await ts(9));
  await comoConductor(fx, () => q(`SELECT public.driver_set_reservation_status($1, 'en_route')`, [s5.id]));
  await q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
           VALUES ($1, $2, 6.1530, -75.3790, 'gps', now())`, [fx.driver, r5]);  // ~120 m
  d = await one(`SELECT public.detect_trip_reminders() AS t`);
  check('GPS a ~120 m → «por llegar» del detector', (await avisos(quinta)).some(x => x.dedupe_key === `trip:${s5.id}:near`), d.t);
  check('el cron quedó agendado cada minuto', !!(await one(`SELECT 1 FROM cron.job WHERE jobname = 'detect-trip-reminders' AND schedule = '* * * * *'`)));

  console.log('\n9. Permisos');
  const g = await one(`SELECT has_function_privilege('anon', 'public.driver_board_with_code(uuid,text,boolean)', 'EXECUTE') AS anon,
                               has_function_privilege('authenticated', 'public.trip_notify(uuid,text,text,text,text)', 'EXECUTE') AS tn,
                               has_function_privilege('authenticated', 'public.detect_trip_reminders()', 'EXECUTE') AS det`);
  check('anon no aborda; nadie de la app escribe a la bandeja ni corre el detector', !g.anon && !g.tn && !g.det, JSON.stringify(g));
} catch (e) {
  fail++; console.error('ERROR', e);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
