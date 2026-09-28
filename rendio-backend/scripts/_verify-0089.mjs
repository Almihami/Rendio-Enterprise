// Verificación de 0089: auxiliar_change_flight («Cambió mi vuelo») y los
// títulos nuevos de enqueue_incident_alert.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0089.mjs
//
// Con 0089 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
// Llama la RPC como `uid`; devuelve el jsonb o {__err}.
async function cambiar(uid, resId, flight, whenSql) {
  await como(uid);
  await c.query('SAVEPOINT sp1');
  try {
    const r = (await c.query(`SELECT public.auxiliar_change_flight($1, $2, ${whenSql}) v`, [resId, flight])).rows[0].v;
    await c.query('RELEASE SAVEPOINT sp1'); return r;
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp1'); return { __err: e.message }; }
  finally { await comoDb(); }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const A = fx.auxUser;
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0089');
  // Solo esta jefa recibe los avisos (ops_alert_recipients prefiere a los marcados).
  await q(`UPDATE public.profiles SET receives_ops_alerts = (id = $1) WHERE role = 'admin'`, [jefe]);
  const lead = (await one(`SELECT coalesce(aux_min_lead_hours, 6) h FROM public.app_settings WHERE id = 'singleton'`)).h;
  const res = async (dir, whenSql, extra = {}) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, notes, service_level, private_status)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      ${whenSql}, $3, $4::public.service_level,
      CASE WHEN $4 = 'private' THEN 'requested'::public.private_status END) RETURNING id, required_arrival_at`, [extra.aux || fx.aux, dir, extra.notes || null, extra.level || 'shared']));
  const leer = async (id) => one(`SELECT required_arrival_at, notes, flight_id FROM public.reservations WHERE id = $1`, [id]);
  const incidentes = async (id) => q(`SELECT id, category::text, source, severity::text, description, details FROM public.incidents WHERE reservation_id = $1 ORDER BY created_at`, [id]);

  console.log('\n0. Estructura');
  const p = await one(`SELECT p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.auxiliar_change_flight(uuid,text,timestamptz)')`);
  check('auxiliar_change_flight: definer, authenticated sí, anon no', p && p.prosecdef && p.au && !p.an, JSON.stringify(p));
  const src = await one(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.enqueue_incident_alert(uuid)')`);
  check('enqueue_incident_alert titula flight_delay y flight_advanced', src && /Vuelo retrasado/.test(src.prosrc) && /Vuelo adelantado/.test(src.prosrc));

  console.log('\n1. Sin plan: se actualiza sola');
  const s1 = await res('home_to_airport', "now() + interval '3 days'", { notes: 'Vuelo AV9412. Llevo perro · Regreso del mismo día' });
  let r = await cambiar(A, s1.id, 'av 9500', "now() + interval '3 days 2 hours'");
  check('mode = updated', r && r.mode === 'updated', JSON.stringify(r));
  let x = await leer(s1.id);
  check('la hora cambió', Math.abs(x.required_arrival_at.getTime() - (s1.required_arrival_at.getTime() + 2 * 3600e3)) < 5000, x.required_arrival_at.toISOString());
  check('notas: vuelo nuevo + lo suyo + la marca de regreso', x.notes === 'Vuelo AV9500. Llevo perro · Regreso del mismo día', x.notes);
  const nwf = (await one(`SELECT public.notes_without_flight($1) v`, [x.notes])).v;
  check('ida y vuelta: notes_without_flight devuelve lo suyo', nwf === 'Llevo perro', nwf);
  check('sin eventualidad', (await incidentes(s1.id)).length === 0);

  const s2 = await res('home_to_airport', "now() + interval '4 days'", { notes: 'Vuelo JA5116. hola' });
  r = await cambiar(A, s2.id, '', "now() + interval '4 days 1 hour'");
  x = await leer(s2.id);
  check('salida sin vuelo nuevo: conserva las notas y cambia la hora', r.mode === 'updated' && x.notes === 'Vuelo JA5116. hola', JSON.stringify({ r, n: x.notes }));
  r = await cambiar(A, s2.id, 'JA5116', "(SELECT required_arrival_at FROM public.reservations WHERE id = '" + s2.id + "')");
  check('mismo vuelo y misma hora → unchanged', r.mode === 'updated' && r.unchanged === true, JSON.stringify(r));

  console.log('\n2. Llegada: el vuelo es obligatorio');
  const l1 = await res('airport_to_home', "now() + interval '3 days'", { notes: 'Vuelo AV8520.' });
  r = await cambiar(A, l1.id, '  ', "now() + interval '3 days 1 hour'");
  check('llegada sin vuelo → rechazado', r.__err && /número de vuelo/.test(r.__err), JSON.stringify(r));
  r = await cambiar(A, l1.id, 'AV8522', "now() + interval '3 days 1 hour'");
  x = await leer(l1.id);
  check('llegada con vuelo → updated, notas «Vuelo AV8522.»', r.mode === 'updated' && x.notes === 'Vuelo AV8522.', JSON.stringify({ r, n: x.notes }));

  console.log('\n3. Publicado: pasa por los jefes y NO toca la reserva');
  const s3 = await res('home_to_airport', "now() + interval '3 days'", { notes: 'Vuelo AV9412.' });
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '3 days' - interval '2 hours') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, now() + interval '3 days' - interval '90 minutes')`, [ra, s3.id]);
  r = await cambiar(A, s3.id, 'AV9500', "now() + interval '3 days 3 hours'");
  check('más tarde → needs_ops con incident_id', r && r.mode === 'needs_ops' && r.incident_id, JSON.stringify(r));
  x = await leer(s3.id);
  check('la reserva quedó igual (hora y notas)', x.required_arrival_at.getTime() === s3.required_arrival_at.getTime() && x.notes === 'Vuelo AV9412.', JSON.stringify(x));
  let inc = await incidentes(s3.id);
  check('eventualidad flight_delay, del tripulante, media', inc.length === 1 && inc[0].category === 'flight_delay' && inc[0].source === 'auxiliar' && inc[0].severity === 'medium', JSON.stringify(inc));
  check('describe salida, hora vieja → nueva y el vuelo', inc[0] && /^Cambió su vuelo \(salida\): \d\d\/\d\d \d\d:\d\d → \d\d\/\d\d \d\d:\d\d · vuelo AV9500$/.test(inc[0].description), inc[0] && inc[0].description);
  check('details con old/new', inc[0] && inc[0].details.kind === 'aux_change_flight' && inc[0].details.new_flight === 'AV9500' && inc[0].details.published === true, JSON.stringify(inc[0] && inc[0].details));
  const ob = await q(`SELECT profile_id, title, url FROM public.notification_outbox WHERE incident_id = $1`, [r.incident_id]);
  check('aviso encolado a la jefa con el título nuevo', ob.length === 1 && ob[0].profile_id === jefe && ob[0].title === 'Vuelo retrasado: hay que mover una recogida', JSON.stringify(ob));
  check('el aviso lleva a la eventualidad', ob[0] && ob[0].url === '/#/eventualidades?ev=' + r.incident_id, ob[0] && ob[0].url);
  r = await cambiar(A, s3.id, 'AV9500', "now() + interval '2 days 22 hours'");
  inc = await incidentes(s3.id);
  const adel = inc.find(i => i.id === r.incident_id);
  check('más temprano → flight_advanced', r.mode === 'needs_ops' && inc.length === 2 && adel && adel.category === 'flight_advanced', JSON.stringify(inc.map(i => i.category)));
  const ob2 = await one(`SELECT title FROM public.notification_outbox WHERE incident_id = $1`, [r.incident_id]);
  check('título «Vuelo adelantado…»', ob2 && ob2.title === 'Vuelo adelantado: hay que mover una recogida', JSON.stringify(ob2));
  r = await cambiar(A, s3.id, 'AV9600', "(SELECT required_arrival_at FROM public.reservations WHERE id = '" + s3.id + "')");
  x = await leer(s3.id);
  check('publicado pero solo cambia el número → se anota sin molestar a los jefes', r.mode === 'updated' && x.notes === 'Vuelo AV9600.' && (await incidentes(s3.id)).length === 2, JSON.stringify({ r, n: x.notes }));

  console.log('\n4. Privado y plazo mínimo: también pasan por los jefes');
  const s4 = await res('home_to_airport', "now() + interval '3 days'", { level: 'private' });
  r = await cambiar(A, s4.id, 'AV1234', "now() + interval '3 days 1 hour'");
  check('privado pedido → needs_ops', r.mode === 'needs_ops', JSON.stringify(r));
  const s5 = await res('home_to_airport', "now() + interval '3 days'");
  r = await cambiar(A, s5.id, 'AV1234', `now() + interval '${Math.max(1, lead - 1)} hours'`);
  check(`hora nueva dentro del plazo (${lead} h) → needs_ops`, r.mode === 'needs_ops', JSON.stringify(r));
  const s6 = await res('home_to_airport', `now() + interval '${Math.max(1, lead - 1)} hours'`);
  r = await cambiar(A, s6.id, 'AV1234', "now() + interval '3 days'");
  check('hora VIEJA dentro del plazo → needs_ops', r.mode === 'needs_ops', JSON.stringify(r));

  console.log('\n5. Validaciones');
  const sB = await res('home_to_airport', "now() + interval '3 days'", { aux: fx.vecino });
  r = await cambiar(A, sB.id, 'AV1', "now() + interval '3 days'");
  check('la reserva de otro → rechazado', r.__err && /no es tuyo/.test(r.__err), JSON.stringify(r));
  r = await cambiar(fx.drvUser, s1.id, 'AV9412', "now() + interval '3 days'");
  check('un conductor → rechazado', !!r.__err, JSON.stringify(r));
  r = await cambiar(A, s1.id, 'XYZ', "now() + interval '3 days'");
  check('vuelo ilegible → rechazado', r.__err && /no se entiende/.test(r.__err), JSON.stringify(r));
  r = await cambiar(A, s1.id, 'AV9412', "now() - interval '1 hour'");
  check('hora pasada → rechazado', r.__err && /ya pasó/.test(r.__err), JSON.stringify(r));
  r = await cambiar(A, s1.id, 'AV9412', "now() + interval '15 days'");
  check('más de 14 días → rechazado', r.__err && /14 días/.test(r.__err), JSON.stringify(r));
  await q(`UPDATE public.reservations SET status_h2a = 'en_route' WHERE id = $1`, [s2.id]);
  r = await cambiar(A, s2.id, 'AV9412', "now() + interval '5 days'");
  check('en camino → rechazado («ya está en curso»)', r.__err && /en curso/.test(r.__err), JSON.stringify(r));
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [l1.id]);
  r = await cambiar(A, l1.id, 'AV9412', "now() + interval '5 days'");
  check('cancelada → rechazado', r.__err && /cancelado/.test(r.__err), JSON.stringify(r));

  console.log('\n6. Suspendido: sí puede cambiar su vuelo');
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [A]);
  r = await cambiar(A, s1.id, 'AV9501', "now() + interval '3 days 4 hours'");
  check('suspendido → updated', r && r.mode === 'updated', JSON.stringify(r));

  console.log('\n7. Registro de flights con otro número: se suelta');
  const fl = (await one(`INSERT INTO public.flights (airport_id, flight_number, direction, scheduled_at) VALUES ($1, 'AV7000', 'home_to_airport', now() + interval '6 days') RETURNING id`, [fx.airport])).id;
  const s7 = await res('home_to_airport', "now() + interval '6 days'");
  await q(`UPDATE public.reservations SET flight_id = $2 WHERE id = $1`, [s7.id, fl]);
  r = await cambiar(A, s7.id, 'AV7100', "now() + interval '6 days 1 hour'");
  x = await leer(s7.id);
  check('flight_id = NULL y las notas dicen AV7100', r.mode === 'updated' && x.flight_id === null && x.notes === 'Vuelo AV7100.', JSON.stringify(x));
} catch (err) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + err.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
