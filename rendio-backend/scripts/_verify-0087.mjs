// Verificación de 0087: auxiliar_my_trips, auxiliar_my_stats,
// driver_rating_summary (interna), auxiliar_track_reservation v5 (pos solo en
// estado activo) y la policy endurecida de driver_locations.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0087.mjs
//
// Con 0087 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const misViajes = async (uid, dias) => { await como(uid); const r = await one(dias ? `SELECT public.auxiliar_my_trips($1) v` : `SELECT public.auxiliar_my_trips() v`, dias ? [dias] : []); await comoDb(); return r.v; };
const track = async (uid, id) => { await como(uid); const r = await one(`SELECT public.auxiliar_track_reservation($1) v`, [id]); await comoDb(); return r.v; };

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  await q(`UPDATE public.profiles SET phone = '3001234567', avatar_url = 'https://x.test/a.jpg' WHERE id = $1`, [fx.drvUser]);
  await q(`UPDATE public.vehicles SET brand = 'Chevrolet', model = 'Spark', color = 'Gris' WHERE id = $1`, [fx.vehicle]);

  // Traslado mañana a las 20:30 de Bogotá (#15: no debe caer en el día siguiente).
  const noche = (await one(`SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '1 day 20 hours 30 minutes') AT TIME ZONE 'America/Bogota') AS ts,
      to_char(date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '1 day', 'YYYY-MM-DD') AS d`));
  const res = async (aux, dir, when, extra = {}) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, notes, residence_id)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      $3, $4, $5) RETURNING id, meet_code`, [aux, dir, when, extra.notes || null, fx.olivar]));
  const ruta = async (dir, start, driver = fx.driver, status = 'planned') => (await one(`INSERT INTO public.route_assignments
      (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [driver, fx.vehicle, dir, status, start])).id;
  const parada = async (ra, resId, order, eta) => (await one(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, $3, $4) RETURNING id`, [ra, resId, order, eta])).id;

  console.log('\n0. Estructura y permisos');
  for (const f of ['auxiliar_my_trips(int)', 'auxiliar_my_stats()', 'driver_rating_summary(uuid)', 'auxiliar_track_reservation(uuid)']) {
    const p = await one(`SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.${f}')`);
    check(`${f} existe y es SECURITY DEFINER`, p && p.prosecdef === true, p ? 'no definer' : 'no existe');
  }
  const pr = await one(`SELECT has_function_privilege('authenticated', 'public.driver_rating_summary(uuid)', 'EXECUTE') a,
      has_function_privilege('anon', 'public.driver_rating_summary(uuid)', 'EXECUTE') b,
      has_function_privilege('authenticated', 'public.auxiliar_my_trips(int)', 'EXECUTE') c,
      has_function_privilege('anon', 'public.auxiliar_my_trips(int)', 'EXECUTE') d,
      has_function_privilege('authenticated', 'public.auxiliar_my_stats()', 'EXECUTE') e`).catch(() => ({}));
  check('driver_rating_summary: authenticated NO', pr.a === false, pr.a);
  check('driver_rating_summary: anon NO', pr.b === false, pr.b);
  check('auxiliar_my_trips: authenticated sí, anon no', pr.c === true && pr.d === false, `${pr.c}/${pr.d}`);
  check('auxiliar_my_stats: authenticated sí', pr.e === true, pr.e);
  await como(fx.auxUser);
  let e = await debeFallar(`SELECT * FROM public.driver_rating_summary($1)`, [fx.driver]);
  check('llamarla como tripulante → permiso denegado', e && /permission denied/.test(e), e);
  await comoDb();

  console.log('\n1. Sin traslados y sin sesión de tripulante');
  let v = await misViajes(fx.auxUser);
  check('sin reservas → []', Array.isArray(v) && v.length === 0, JSON.stringify(v));
  v = await misViajes(fx.drvUser);
  check('un conductor recibe NULL (no es tripulante)', v === null, JSON.stringify(v));

  console.log('\n2. Pendiente sin plan (20:30 de Bogotá)');
  const s1 = await res(fx.aux, 'home_to_airport', noche.ts, { notes: 'Vuelo AV9412. Llevo maleta grande' });
  v = await misViajes(fx.auxUser);
  let t = v && v.find(x => x.id === s1.id);
  check('aparece', !!t);
  check(`date = ${noche.d} (Bogotá, no UTC)`, t && t.date === noche.d, t && t.date);
  check('time = 20:30', t && t.time === '20:30', t && t.time);
  check('notes_user sin el vuelo', t && t.notes_user === 'Llevo maleta grande', t && t.notes_user);
  check('published = false', t && t.published === false, t && t.published);
  check('sin plan: pickup_at y meet_code NULL', t && t.pickup_at === null && t.meet_code === null, t && `${t.pickup_at}/${t.meet_code}`);
  check('sin plan: driver y vehicle NULL', t && t.driver === null && t.vehicle === null);
  check('raw_status requested', t && t.raw_status === 'requested', t && t.raw_status);

  console.log('\n3. Borrador sin conductor: sigue sin publicar');
  const raDraft = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES (NULL, $1, 'home_to_airport', 'draft', $2::timestamptz - interval '2 hours') RETURNING id`, [fx.vehicle, noche.ts])).id;
  await parada(raDraft, s1.id, 1, new Date(Date.parse(noche.ts) - 100 * 60000));
  t = (await misViajes(fx.auxUser)).find(x => x.id === s1.id);
  check('borrador → published false, sin driver', t.published === false && t.driver === null, JSON.stringify({ p: t.published, d: t.driver }));
  await q(`DELETE FROM public.route_assignments WHERE id = $1`, [raDraft]);

  console.log('\n4. Publicado (ruta con conductor)');
  const ra1 = await ruta('home_to_airport', new Date(Date.parse(noche.ts) - 2 * 3600e3));
  await parada(ra1, s1.id, 1, new Date(Date.parse(noche.ts) - 95 * 60000));
  t = (await misViajes(fx.auxUser)).find(x => x.id === s1.id);
  const cp = (await one(`SELECT calculated_pickup_at FROM public.reservations WHERE id = $1`, [s1.id])).calculated_pickup_at;
  check('published = true', t.published === true);
  check('pickup_at = la hora publicada (0085)', t.pickup_at && Date.parse(t.pickup_at) === cp.getTime(), `${t.pickup_at} vs ${cp && cp.toISOString()}`);
  check('meet_code = el de la reserva', t.meet_code === s1.meet_code && /^[0-9]{4}$/.test(t.meet_code || ''), `${t.meet_code} vs ${s1.meet_code}`);
  check('driver: nombre, foto y teléfono', t.driver && t.driver.name && t.driver.avatar_url && t.driver.phone === '3001234567', JSON.stringify(t.driver));
  check('vehicle: placa, marca, modelo y color', t.vehicle && t.vehicle.plate === 'RDO481' && t.vehicle.brand === 'Chevrolet' && t.vehicle.model === 'Spark' && t.vehicle.color === 'Gris', JSON.stringify(t.vehicle));
  check('stop_status pending', t.stop_status === 'pending', t.stop_status);

  console.log('\n5. Calificación del conductor: solo con 10 o más');
  // 9 viajes calificados (de la vecina) en rutas completadas del mismo conductor.
  const raOld = await ruta('home_to_airport', new Date(Date.now() - 20 * 86400e3), fx.driver, 'completed');
  for (let i = 0; i < 9; i++) {
    const r = await res(fx.vecino, 'home_to_airport', new Date(Date.now() - (20 * 86400e3) + i * 60000));
    await q(`UPDATE public.reservations SET status_h2a = 'delivered', rating = 5 WHERE id = $1`, [r.id]);
    await parada(raOld, r.id, i + 1, null);
  }
  t = (await misViajes(fx.auxUser)).find(x => x.id === s1.id);
  check('con 9: rating NULL y rating_n = 9', t.driver.rating === null && t.driver.rating_n === 9, JSON.stringify(t.driver));
  const r10 = await res(fx.vecino, 'home_to_airport', new Date(Date.now() - 19 * 86400e3));
  await q(`UPDATE public.reservations SET status_h2a = 'delivered', rating = 4 WHERE id = $1`, [r10.id]);
  await parada(raOld, r10.id, 10, null);
  t = (await misViajes(fx.auxUser)).find(x => x.id === s1.id);
  check('con 10: rating = 4.9', Number(t.driver.rating) === 4.9 && t.driver.rating_n === 10, JSON.stringify(t.driver));

  console.log('\n6. A no ve lo de B');
  const idsA = (await misViajes(fx.auxUser)).map(x => x.id);
  const idsB = (await misViajes(fx.vecinoUser, 60)).map(x => x.id);
  check('A solo ve lo suyo (1)', idsA.length === 1 && idsA[0] === s1.id, idsA.length);
  check('B ve sus 10, ninguno de A', idsB.length === 10 && !idsB.includes(s1.id), idsB.length);

  console.log('\n7. Ventana de días');
  const viejaCerrada = await res(fx.aux, 'home_to_airport', new Date(Date.now() - 100 * 86400e3));
  await q(`UPDATE public.reservations SET status_h2a = 'delivered' WHERE id = $1`, [viejaCerrada.id]);
  const viejaAbierta = await res(fx.aux, 'home_to_airport', new Date(Date.now() - 100 * 86400e3));
  v = await misViajes(fx.auxUser);
  check('cerrada de hace 100 días: fuera por defecto (60)', !v.some(x => x.id === viejaCerrada.id));
  check('ABIERTA de hace 100 días: dentro (no se esconde)', v.some(x => x.id === viejaAbierta.id));
  v = await misViajes(fx.auxUser, 120);
  check('con p_days_back = 120 aparece la cerrada', v.some(x => x.id === viejaCerrada.id));
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [viejaAbierta.id]);

  console.log('\n8. Rastreo v5: la posición solo en estado activo (D14)');
  await q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
      VALUES ($1, $2, 6.15, -75.38, 'gps', now())`, [fx.driver, ra1]);
  let i = await track(fx.auxUser, s1.id);
  check('asignado (requested): pos NULL aunque haya GPS', i && i.assigned === true && i.pos === null, JSON.stringify(i && i.pos));
  check('trae pickup_at y meet_code', i && i.pickup_at && i.meet_code === s1.meet_code, `${i && i.pickup_at}/${i && i.meet_code}`);
  check('trae vehicle con color y sigue trayendo plate arriba', i && i.vehicle && i.vehicle.color === 'Gris' && i.plate === 'RDO481', JSON.stringify(i && i.vehicle));
  check('driver con avatar_url, rating y rating_n', i && i.driver && i.driver.avatar_url && Number(i.driver.rating) === 4.9 && i.driver.rating_n === 10, JSON.stringify(i && i.driver));
  check('claves de 0054 intactas', i && ['stop_order', 'total_stops', 'remaining_before', 'remaining_after', 'next_stops', 'route_start', 'pickup', 'wait_minutes'].every(k => k in i));
  await q(`UPDATE public.reservations SET status_h2a = 'assigned' WHERE id = $1`, [s1.id]);
  i = await track(fx.auxUser, s1.id);
  check('assigned: pos NULL', i.pos === null);
  await q(`UPDATE public.reservations SET status_h2a = 'en_route' WHERE id = $1`, [s1.id]);
  i = await track(fx.auxUser, s1.id);
  check('en_route: pos presente', i.pos && i.pos.lat === 6.15 && i.pos.source === 'gps', JSON.stringify(i.pos));
  await q(`UPDATE public.reservations SET status_h2a = 'on_board' WHERE id = $1`, [s1.id]);
  i = await track(fx.auxUser, s1.id);
  check('on_board: pos presente', !!i.pos);

  console.log('\n9. Policy de driver_locations (RLS directa)');
  const leer = async () => { await como(fx.auxUser); const r = await q(`SELECT id FROM public.driver_locations WHERE route_assignment_id = $1`, [ra1]); await comoDb(); return r.length; };
  check('on_board: la lee', (await leer()) === 1);
  await q(`UPDATE public.reservations SET status_h2a = 'assigned' WHERE id = $1`, [s1.id]);
  check('assigned: NO la lee', (await leer()) === 0);
  await q(`UPDATE public.reservations SET status_h2a = 'en_route' WHERE id = $1`, [s1.id]);
  check('en_route: la lee', (await leer()) === 1);
  await como(fx.vecinoUser);
  const deB = (await q(`SELECT id FROM public.driver_locations WHERE route_assignment_id = $1`, [ra1])).length;
  await comoDb();
  check('B (sin reserva en esa ruta) NO la lee', deB === 0, deB);

  console.log('\n10. Llegada: el carro aparece desde «recogí»');
  const l1 = await res(fx.aux, 'airport_to_home', new Date(Date.now() + 2 * 86400e3));
  const ra2 = await ruta('airport_to_home', new Date(Date.now() + 2 * 86400e3 + 20 * 60000));
  await parada(ra2, l1.id, 1, null);
  await q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
      VALUES ($1, $2, 6.17, -75.42, 'gps', now() + interval '1 second')`, [fx.driver, ra2]);
  await q(`UPDATE public.reservations SET status_a2h = 'driver_assigned' WHERE id = $1`, [l1.id]);
  i = await track(fx.auxUser, l1.id);
  check('driver_assigned: pos NULL', i.pos === null);
  await q(`UPDATE public.reservations SET status_a2h = 'picked_up' WHERE id = $1`, [l1.id]);
  i = await track(fx.auxUser, l1.id);
  check('picked_up: pos presente', !!i.pos);
  t = (await misViajes(fx.auxUser)).find(x => x.id === l1.id);
  const ps2 = (await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [ra2])).planned_start_at;
  check('llegada: pickup_at = salida del carro de MDE (planned_start_at)', t.pickup_at && Date.parse(t.pickup_at) === ps2.getTime(), `${t.pickup_at} vs ${ps2.toISOString()}`);

  console.log('\n11. Cerrado: el teléfono del conductor se va');
  await q(`UPDATE public.reservations SET status_h2a = 'delivered' WHERE id = $1`, [s1.id]);
  t = (await misViajes(fx.auxUser)).find(x => x.id === s1.id);
  check('mis viajes: entregado → phone NULL (nombre sigue)', t.driver && t.driver.phone === null && !!t.driver.name, JSON.stringify(t.driver));
  i = await track(fx.auxUser, s1.id);
  check('rastreo: entregado → phone NULL y pos NULL', i.driver.phone === null && i.pos === null, JSON.stringify({ ph: i.driver.phone, pos: i.pos }));
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [l1.id]);
  i = await track(fx.auxUser, l1.id);
  check('rastreo de una cancelada: {cancelled:true}', i && i.cancelled === true);
  t = (await misViajes(fx.auxUser)).find(x => x.id === l1.id);
  check('mis viajes de una cancelada: sin teléfono', t && (!t.driver || t.driver.phone === null), JSON.stringify(t && t.driver));

  console.log('\n12. Mis cifras');
  let st = async (uid) => { await como(uid); const r = (await one(`SELECT public.auxiliar_my_stats() v`)).v; await comoDb(); return r; };
  let s = await st(fx.auxUser);
  // A: s1 entregado pero sin hora de entrega + la vieja cerrada.
  check('done cuenta los entregados (2)', s && s.done === 2, JSON.stringify(s));
  check('sin horas de entrega: on_time_n 0 y pct NULL', s && s.on_time_n === 0 && s.on_time_pct === null, JSON.stringify(s));
  // 4 a tiempo + 1 tarde.
  const raSt = await ruta('home_to_airport', new Date(Date.now() - 5 * 86400e3), fx.driver, 'completed');
  for (let k = 0; k < 5; k++) {
    const when = new Date(Date.now() - 5 * 86400e3 + k * 3600e3);
    const r = await res(fx.aux, 'home_to_airport', when);
    await q(`UPDATE public.reservations SET status_h2a = 'delivered' WHERE id = $1`, [r.id]);
    const sid = await parada(raSt, r.id, k + 1, null);
    await q(`UPDATE public.route_stops SET actual_dropoff_at = $2 WHERE id = $1`, [sid, new Date(when.getTime() + (k === 4 ? 10 : -15) * 60000)]);
  }
  s = await st(fx.auxUser);
  check('5 salidas medidas: 80 % a tiempo', s.on_time_n === 5 && s.on_time_pct === 80 && s.done === 7, JSON.stringify(s));
  await q(`UPDATE public.route_stops SET actual_dropoff_at = NULL WHERE route_assignment_id = $1 AND stop_order = 5`, [raSt]);
  s = await st(fx.auxUser);
  check('con 4 medidas: pct NULL (n < 5)', s.on_time_n === 4 && s.on_time_pct === null, JSON.stringify(s));
  s = await st(fx.drvUser);
  check('un conductor recibe NULL', s === null, JSON.stringify(s));
} catch (err) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + err.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
