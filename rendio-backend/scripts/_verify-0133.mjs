// Verificación de 0133 (pasajeros sin cuenta en la ruta de Julián: Kriss) contra la
// base LOCAL (127.0.0.1:54322). Aplica lo que falte (0117, 0124–0126, 0128) y 0133
// dentro de una transacción que se deshace: no queda nada.
//
//   cd rendio-backend/scripts && node _verify-0133.mjs
//
// Qué prueba:
//   1. admin_manual_route_publish cambia y el down la deja EXACTAMENTE como en 0125.
//   2. Pegar «4:15 Luz · 4:25 Kriss (Campus Reservado)»: UNA vuelta con 2 paradas;
//      Kriss sin reserva, con nombre, lugar y el punto del conjunto; a Luz le llega
//      su hora; a nadie más. Una llegada solo con un sin cuenta también se crea.
//   3. Volver a pegar igual conserva la vuelta (y su conductor) y no duplica a
//      Kriss; cambiarle el nombre la cambia.
//   4. El conductor que la tomó marca a Kriss (llegó → a bordo → «Deshacer» →
//      a bordo → entregado) y la vuelta termina: a los jefes «terminó una vuelta» (0128).
//   5. Reglas: otro conductor no la marca; una parada con reserva no se marca por
//      aquí; un estado raro no; la parada es reserva O nombre (CHECK).
//   6. driver_open_routes sigue funcionando con la vuelta del sin cuenta.
//   7. El down borra las paradas sin cuenta (y la vuelta que quede vacía) y deja
//      reservation_id obligatorio otra vez.
//
// NO cubre: las pantallas (_smoke-ruta-julian-dom.mjs, _smoke-guest-conductor-dom.mjs),
// la push de verdad, dev/producción.
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
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;
const huella = async () => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'admin_manual_route_publish'`)).h;

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.hm_bog(timestamptz)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_delegated(uuid,boolean)')`))) await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  if (!(await existe(`to_regprocedure('public.route_finished_alert()')`))) await c.query(strip('../supabase/migrations/0128_aviso_vuelta_terminada.sql'));
  const h0125 = await huella();
  await c.query(strip('../supabase/migrations/0133_pasajero_sin_cuenta.sql'));
  await c.query(strip('../supabase/migrations/0133_pasajero_sin_cuenta.sql'));
  check('0133 se aplica (y se puede volver a correr)', true);
  check('admin_manual_route_publish cambia (la copia con los sin cuenta)', h0125 && (await huella()) !== h0125);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0133');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefe]);
  const campus = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'Campus Reservado', 6.1401, -75.3902, 'Rionegro') RETURNING id`, [fx.org])).id;
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0133'), DANI = await drv('Daniel Alvarez prueba 0133');
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LUZ = await trip('Luz Bomba prueba');
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${man}T${hm}:00-05:00`;
  const rLuz = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $3) RETURNING id`, [LUZ.a, at('05:30'), fx.olivar])).id;
  const pegar = async (bloques) => { await asUser(c, jefe, 'admin'); try { return (await one(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb) r`, [man, JSON.stringify(bloques)])).r; } finally { await asDb(); } };
  const KRISS = (nombre = 'Kriss') => ({ guest: { name: nombre, place: 'Campus Reservado', residence_id: campus, phone: '300 555 0101' }, at: at('04:25') });
  const RUTA = (nombre) => [
    { type: 'sal', deadline_at: at('05:30'), stops: [{ reservation_id: rLuz, at: at('04:15') }, KRISS(nombre)] },
    { type: 'lle', flight: 'AV9563', stops: [{ guest: { name: 'Papá de Yalimar', place: 'Riovivo' }, at: at('12:00') }] },
  ];
  const vueltas = async () => { await asDb(); return q(`SELECT ra.id, ra.direction::text dir, ra.driver_profile_id d,
      (SELECT json_agg(json_build_object('o', rs.stop_order, 'rid', rs.reservation_id, 'g', rs.guest_name, 'p', rs.guest_place, 'ph', rs.guest_phone, 'lat', rs.guest_lat, 'at', rs.estimated_arrival_at, 'id', rs.id) ORDER BY rs.stop_order) FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id) stops
      FROM public.route_assignments ra WHERE ra.pool AND ra.organization_id = $1 AND ra.manual_day = $2::date ORDER BY ra.planned_start_at`, [fx.org, man]); };

  // ── 2. Pegar con Kriss ────────────────────────────────────────────────────
  console.log('\n2. Pegar la ruta con un pasajero sin cuenta');
  const p1 = await pegar(RUTA('Kriss'));
  const v1 = await vueltas();
  check('dos vueltas: la salida (Luz + Kriss) y la llegada (solo el sin cuenta)', p1.created === 2 && v1.length === 2 && v1[0].stops.length === 2 && v1[1].stops.length === 1, { p1, v1: v1.map((v) => v.stops.length) });
  const k = v1[0].stops[1];
  check('Kriss: sin reserva, con nombre, lugar, teléfono y el punto del conjunto, a las 4:25', k.rid === null && k.g === 'Kriss' && k.p === 'Campus Reservado' && k.ph === '300 555 0101' && Math.abs(k.lat - 6.1401) < 1e-6 && Date.parse(k.at) === Date.parse(at('04:25')), k);
  check('Luz va primero y le llega su hora; el aviso es solo para ella (1)', v1[0].stops[0].rid === rLuz && p1.notified === 1, p1);
  check('la llegada con un sin cuenta sin conjunto: su lugar en texto, sin punto', v1[1].stops[0].g === 'Papá de Yalimar' && v1[1].stops[0].p === 'Riovivo' && v1[1].stops[0].lat === null && v1[1].dir === 'airport_to_home', v1[1].stops[0]);

  // ── 3. Volver a pegar ─────────────────────────────────────────────────────
  console.log('\n3. Volver a pegar');
  await asUser(c, JUAN.u, 'driver'); await q(`SELECT public.driver_take_route($1)`, [v1[0].id]); await asDb();
  const p2 = await pegar(RUTA('Kriss'));
  const v2 = await vueltas();
  check('igual: conserva las dos vueltas (la de Juan sigue con Juan) y no duplica a Kriss', p2.created === 0 && v2.length === 2 && v2[0].id === v1[0].id && v2[0].d === JUAN.dp && v2[0].stops.length === 2, { p2, v2: v2.map((v) => [v.id === v1[0].id, v.d, v.stops.length]) });
  const p3 = await pegar(RUTA('Kris Castaño'));
  const v3 = await vueltas();
  check('con otro nombre la vuelta es otra (la de antes se quita)', p3.created === 1 && p3.removed === 1 && v3.length === 2 && v3[0].stops[1].g === 'Kris Castaño', { p3, n: v3.length });
  await pegar(RUTA('Kriss'));
  const v4 = await vueltas();
  await asUser(c, DANI.u, 'driver'); await q(`SELECT public.driver_take_route($1)`, [v4[0].id]); await asDb();

  // ── 4. El conductor la marca ──────────────────────────────────────────────
  console.log('\n4. El conductor marca al sin cuenta');
  const kid = (await vueltas())[0].stops.find((s) => s.g === 'Kriss').id;
  const marcaG = async (st, D = DANI) => { await asUser(c, D.u, 'driver'); try { await q(`SELECT public.driver_set_guest_stop_status($1, $2)`, [kid, st]); } finally { await asDb(); } };
  const marcaR = async (rid, st) => { await asUser(c, DANI.u, 'driver'); try { await q(`SELECT public.driver_set_reservation_status($1, $2)`, [rid, st]); } finally { await asDb(); } };
  const kst = async () => one(`SELECT status, actual_arrival_at a, actual_pickup_at p, actual_dropoff_at d FROM public.route_stops WHERE id = $1`, [kid]);
  await marcaR(rLuz, 'on_board');
  await marcaG('at_pickup');
  check('«llegó»: la parada queda arrived con la hora', (await kst()).status === 'arrived' && !!(await kst()).a);
  await marcaG('on_board');
  check('«a bordo»: picked_up con la hora', (await kst()).status === 'picked_up' && !!(await kst()).p);
  await marcaG('at_pickup');
  check('«Deshacer» la devuelve a «llegó» y borra la hora de abordar', (await kst()).status === 'arrived' && (await kst()).p === null);
  await marcaG('en_route');
  check('«en camino» no la mueve', (await kst()).status === 'arrived');
  await marcaG('on_board');
  await marcaR(rLuz, 'delivered');
  check('Luz entregada y Kriss a bordo: la vuelta todavía no termina', (await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE $1`, ['fin:' + v4[0].id + ':%'])).length === 0);
  await marcaG('delivered');
  const fin = await q(`SELECT title, body FROM public.notification_outbox WHERE dedupe_key LIKE $1`, ['fin:' + v4[0].id + ':%']);
  check('entregada Kriss: la vuelta TERMINA y a los jefes «terminó una vuelta» (0128)', fin.length === 1 && /terminó una vuelta/.test(fin[0].title) && /Luz Bomba/.test(fin[0].body), fin);

  // ── 5. Reglas ─────────────────────────────────────────────────────────────
  console.log('\n5. Reglas');
  await asUser(c, JUAN.u, 'driver');
  const e1 = await debeFallar(`SELECT public.driver_set_guest_stop_status($1, 'delivered')`, [kid]);
  await asDb();
  check('otro conductor no la marca', e1 && /no está en una vuelta activa tuya/.test(e1.message), e1 && e1.message);
  const luzStop = (await vueltas())[0].stops.find((s) => s.rid === rLuz).id;
  await asUser(c, DANI.u, 'driver');
  const e2 = await debeFallar(`SELECT public.driver_set_guest_stop_status($1, 'delivered')`, [luzStop]);
  const e3 = await debeFallar(`SELECT public.driver_set_guest_stop_status($1, 'volando')`, [kid]);
  await asDb();
  check('una parada CON reserva no se marca por aquí', e2 && /no está en una vuelta activa tuya/.test(e2.message), e2 && e2.message);
  check('un estado raro no', e3 && /estado no válido/.test(e3.message), e3 && e3.message);
  await asUser(c, LUZ.u, 'auxiliar');
  const e4 = await debeFallar(`SELECT public.driver_set_guest_stop_status($1, 'delivered')`, [kid]);
  await asDb();
  check('un tripulante no puede', e4 && /solo un conductor/.test(e4.message), e4 && e4.message);
  const e5 = await debeFallar(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, NULL, 50)`, [v4[0].id]);
  const e6 = await debeFallar(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, guest_name) VALUES ($1, $2, 51, 'Doble')`, [v4[0].id, rLuz]);
  check('la parada es reserva O nombre: sin ninguno no', e5 && /route_stops_reserva_o_sin_cuenta/.test(e5.message), e5 && e5.message);
  check('…ni con los dos', e6 && /route_stops_reserva_o_sin_cuenta|route_stops_reservation_unique/.test(e6.message), e6 && e6.message);

  // ── 6. driver_open_routes ─────────────────────────────────────────────────
  console.log('\n6. Vueltas para tomar');
  await asUser(c, JUAN.u, 'driver');
  const abiertas = (await one(`SELECT public.driver_open_routes() l`)).l || [];
  await asDb();
  check('driver_open_routes funciona y trae la llegada del sin cuenta para tomar', Array.isArray(abiertas) && abiertas.some((v) => v.id === v4[1].id), abiertas.map((v) => v.id));

  // ── 7. Down ───────────────────────────────────────────────────────────────
  console.log('\n7. Reversa');
  await c.query(strip('../down_migrations/0133_pasajero_sin_cuenta.down.sql'));
  check('el down deja admin_manual_route_publish EXACTAMENTE como en 0125', (await huella()) === h0125);
  const d = await one(`SELECT (SELECT count(*)::int FROM public.route_assignments WHERE id = $1) llegada, (SELECT count(*)::int FROM public.route_stops WHERE route_assignment_id = $2) salida,
      (SELECT is_nullable FROM information_schema.columns WHERE table_name = 'route_stops' AND column_name = 'reservation_id') nul,
      to_regprocedure('public.driver_set_guest_stop_status(uuid,text)') f`, [v4[1].id, v4[0].id]);
  check('…borra las paradas sin cuenta (la llegada que quedó vacía se va; la salida sigue con Luz) y reservation_id vuelve a ser obligatorio', d.llegada === 0 && d.salida === 1 && d.nul === 'NO' && d.f === null, d);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
