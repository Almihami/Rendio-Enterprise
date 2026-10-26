// Verificación de 0145 («Cambiar hora» en UNA vuelta de la ruta de Julián) contra
// la base LOCAL (127.0.0.1:54322). Aplica lo que falte (0124–0126, 0133, el hm_bog
// de 0135 y el «pegar» de 0143) y 0145 dentro de una transacción que se deshace: no
// queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0145.mjs
//
// Qué prueba:
//   1. Una salida pegada (Paula, Jesús y un sin cuenta) que tomó Juan: correr las
//      tres recogidas y el «Deben estar». Cambian las paradas, la vuelta arranca con
//      la primera, la hora del tripulante en su app (calculated_pickup_at), avisa a
//      Paula y a Jesús su hora nueva y a Juan que la vuelta se movió; el sin cuenta
//      no recibe nada (no tiene la app); Juan la sigue teniendo.
//   2. Mandar lo mismo otra vez: «sin cambios», nadie recibe nada.
//   3. Solo el «Deben estar»: avisa a los dos (va en el aviso); a Juan, que cambió.
//   4. Solo Jesús: le llega solo a él.
//   5. Volver a una hora que ya tuvo (16:50 → 16:40 → 16:50): avisa cada vez (el
//      «una vez por hora» de publicar se la tragaba).
//   6. «Deben estar» antes de la última recogida: no deja.
//   7. Llegadas de reserva (0121): en JMC («Te recogemos en JMC hacia las …») y en
//      el Hotel Río Verde; la hora del tripulante es la salida del carro.
//   8. Lo que no deja: vuelta que arrancó, vuelta del tablero, parada de otra
//      vuelta, llegada sin hora, jefe de otra organización, un conductor.
//   9. Delegada: se mueve y no hay conductor a quien avisar.
//  10. Volver a pegar después: la misma vuelta (mismas personas) se conserva con
//      Juan y toma las horas de lo pegado.
//  11. El down quita la función.
//
// NO cubre: dos jefes moviendo la misma vuelta a la vez (el FOR UPDATE no se prueba
// en una sola conexión), la push de verdad ni dev/producción. La pantalla («Cambiar
// hora» en Rutas del día) la cubre _smoke-ruta-julian-dom.mjs.
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
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function debeFallar(fn) {
  await c.query('SAVEPOINT sp_f');
  try { await fn(); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
  finally { await asDb(); }
}
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;

await c.query('BEGIN');
try {
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.hm_bog(timestamptz)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_delegated(uuid,boolean)')`))) await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_stops' AND column_name = 'guest_name')`))) await c.query(strip('../supabase/migrations/0133_pasajero_sin_cuenta.sql'));
  // El hm_bog de 0135 («0:10», no «:10»): solo esa función, no toda 0135.
  const m0135 = fs.readFileSync(new URL('../supabase/migrations/0135_acomodar_eventualidades.sql', import.meta.url), 'utf8');
  await c.query(/CREATE OR REPLACE FUNCTION public\.hm_bog[\s\S]*?\$\$;/.exec(m0135)[0]);
  // El «pegar» de hoy es el de 0143 (no borra las vueltas que armó el sistema): solo
  // esa función, con la columna de 0134 que lee.
  await c.query(`ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS auto_created boolean NOT NULL DEFAULT false`);
  const m0143 = fs.readFileSync(new URL('../supabase/migrations/0143_pegar_no_borra_automaticas.sql', import.meta.url), 'utf8');
  await c.query(/CREATE OR REPLACE FUNCTION public\.admin_manual_route_publish[\s\S]*?\$\$;/.exec(m0143)[0]);
  await c.query(strip('../supabase/migrations/0145_cambiar_hora_pegada.sql'));
  await c.query(strip('../supabase/migrations/0145_cambiar_hora_pegada.sql'));
  check('0145 se aplica encima de 0133 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0145');
  const juan = await user(c, fx.org, 'driver', 'Lennin Vanegas prueba');
  const JUAN = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [juan])).id;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const PAULA = await trip('Paula Londoño prueba'), JESUS = await trip('Jesús Taborda prueba'), ANDREA = await trip('Andrea Núñez prueba'), LESMES = await trip('Lesmes prueba'), MAR = await trip('Margy Ruiz prueba');
  const DIA = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${DIA}T${hm}:00-05:00`;
  const sal = async (X, pres) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $3) RETURNING id`, [X.a, pres, fx.olivar])).id;
  const lle = async (X, fin, lugar) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, reserve_place)
      VALUES ($1, 'airport_to_home', 'scheduled', $2::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $3, $4) RETURNING id`, [X.a, fin, fx.olivar, lugar])).id;
  const rPau = await sal(PAULA, at('17:30')), rJes = await sal(JESUS, at('17:30'));
  const rAnd = await lle(ANDREA, at('16:20'), 'aero'), rLes = await lle(LESMES, at('18:00'), 'rio_verde');

  // Si falla, el rol lo deshace el ROLLBACK TO SAVEPOINT de debeFallar (en una
  // transacción abortada ni RESET ROLE corre: taparía el error de verdad).
  const comoJefe = async (sql, p, quien = jefe, rol = 'admin') => { await asUser(c, quien, rol); const r = (await one(sql, p)).r; await asDb(); return r; };
  const mover = (ra, stops, start = null, dead = null, quien, rol) => comoJefe(`SELECT public.admin_manual_route_set_times($1, $2::jsonb, $3::timestamptz, $4::timestamptz) r`,
    [ra, JSON.stringify(stops || []), start, dead], quien, rol);
  const publicar = (blocks) => comoJefe(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb) r`, [DIA, JSON.stringify(blocks)]);
  const BLOQUES = (h) => [
    { type: 'sal', stops: [{ reservation_id: rPau, at: at(h[0]) }, { reservation_id: rJes, at: at(h[1]) }, { guest: { name: 'Kriss', place: 'El Olivar' }, at: at(h[2]) }], deadline_at: at(h[3]), note: null, flight: null },
    { type: 'lle', stops: [{ reservation_id: rAnd, at: at('16:20') }], deadline_at: null, note: null, flight: null },
    { type: 'lle', stops: [{ reservation_id: rLes, at: at('18:00') }], deadline_at: null, note: null, flight: null },
  ];
  await publicar(BLOQUES(['16:40', '16:45', '16:50', '17:20']));
  const vueltas = await q(`SELECT ra.id, ra.direction::text dir FROM public.route_assignments ra WHERE ra.pool AND ra.manual_day = $1::date ORDER BY ra.planned_start_at`, [DIA]);
  const deRes = async (rid) => (await one(`SELECT route_assignment_id id FROM public.route_stops WHERE reservation_id = $1`, [rid])).id;
  const raS = await deRes(rPau), raA = await deRes(rAnd), raL = await deRes(rLes);
  check('publicar arma las 3 vueltas pegadas (una salida, dos llegadas)', vueltas.length === 3 && raS && raA && raL, vueltas);
  await q(`UPDATE public.route_assignments SET driver_profile_id = $1 WHERE id = $2`, [JUAN, raS]);   // Juan la tomó
  const paradas = async (ra) => q(`SELECT rs.id, rs.reservation_id rid, rs.guest_name g, public.hm_bog(rs.estimated_arrival_at) h FROM public.route_stops rs WHERE rs.route_assignment_id = $1 ORDER BY rs.stop_order`, [ra]);
  const vuelta = async (ra) => one(`SELECT public.hm_bog(planned_start_at) ini, public.hm_bog(deadline_at) dl, driver_profile_id d, status FROM public.route_assignments WHERE id = $1`, [ra]);
  const hora = async (rid) => (await one(`SELECT public.hm_bog(calculated_pickup_at) h FROM public.reservations WHERE id = $1`, [rid])).h;
  // En una sola transacción todos los avisos tienen el mismo created_at: el orden lo da
  // el sello del final de la llave (la hora de cada cambio, con milisegundos).
  const avisos = async (prof) => q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND dedupe_key LIKE 'manualhora:%' ORDER BY right(dedupe_key, 17)`, [prof]);
  const st = await paradas(raS);
  const sid = (x) => st.find((s) => s.rid === x || s.g === x).id;
  const P = (pau, jes, kri) => [{ stop_id: sid(rPau), at: at(pau) }, { stop_id: sid(rJes), at: at(jes) }, { stop_id: sid('Kriss'), at: at(kri) }];

  // ── 1 ───────────────────────────────────────────────────────────────────
  console.log('\n1. Correr la salida 10 minutos (las tres paradas y el «Deben estar»)');
  const r1 = await mover(raS, P('16:50', '16:55', '17:00'), null, at('17:30'));
  const st1 = await paradas(raS), v1 = await vuelta(raS);
  check('las paradas quedan 16:50 · 16:55 · 17:00 (también la del sin cuenta)', st1.map((s) => s.h).join() === '16:50,16:55,17:00', st1);
  check('la vuelta arranca con la primera recogida y «Deben estar» 17:30', v1.ini === '16:50' && v1.dl === '17:30', v1);
  check('Juan la sigue teniendo, publicada', v1.d === JUAN && v1.status === 'planned', v1);
  check('la hora en la app de Paula y de Jesús (calculated_pickup_at)', (await hora(rPau)) === '16:50' && (await hora(rJes)) === '16:55');
  const aP = await avisos(PAULA.u);
  check('a Paula: «Cambió tu hora de recogida 🕒 · Ahora te recogemos a las 16:50 para estar en JMC a las 17:30.»', aP.length === 1 && aP[0].title === 'Cambió tu hora de recogida 🕒' && aP[0].body === 'Ahora te recogemos a las 16:50 para estar en JMC a las 17:30.', aP);
  check('a Jesús, con la suya (16:55)', (await avisos(JESUS.u)).map((a) => a.body).join() === 'Ahora te recogemos a las 16:55 para estar en JMC a las 17:30.');
  const aJ = await avisos(juan);
  check('a Juan: «Cambió la hora de una vuelta que tomaste 🕒 · La salida de las 16:40 ahora es a las 16:50. Revísala en Ruta.»', aJ.length === 1 && aJ[0].title === 'Cambió la hora de una vuelta que tomaste 🕒' && aJ[0].body === 'La salida de las 16:40 ahora es a las 16:50. Revísala en Ruta.', aJ);
  check('responde a cuántos tripulantes avisó (2: el sin cuenta no tiene la app)', r1.notified === 2 && r1.driver_notified === true, r1);
  check('a los de las llegadas no les llega nada', (await avisos(ANDREA.u)).length === 0 && (await avisos(LESMES.u)).length === 0);

  // ── 2 ───────────────────────────────────────────────────────────────────
  console.log('\n2. Lo mismo otra vez');
  const r2 = await mover(raS, P('16:50', '16:55', '17:00'), null, at('17:30'));
  check('«sin cambios» y nadie recibe nada', r2.unchanged === true && (await avisos(PAULA.u)).length === 1 && (await avisos(juan)).length === 1, r2);

  // ── 3 ───────────────────────────────────────────────────────────────────
  console.log('\n3. Solo el «Deben estar»');
  await mover(raS, [], null, at('17:40'));
  check('queda 17:40 y las paradas no se mueven', (await vuelta(raS)).dl === '17:40' && (await paradas(raS)).map((s) => s.h).join() === '16:50,16:55,17:00');
  check('avisa a los dos (el «Deben estar» va en el aviso)', (await avisos(PAULA.u)).length === 2 && (await avisos(JESUS.u))[1].body === 'Ahora te recogemos a las 16:55 para estar en JMC a las 17:40.');
  const aJ3 = await avisos(juan);
  check('a Juan: «Cambió una vuelta que tomaste 🕒» (la salida sigue a las 16:50)', aJ3.length === 2 && aJ3[1].title === 'Cambió una vuelta que tomaste 🕒' && /de las 16:50/.test(aJ3[1].body), aJ3);

  // ── 4 ───────────────────────────────────────────────────────────────────
  console.log('\n4. Solo Jesús');
  await mover(raS, [{ stop_id: sid(rJes), at: at('17:05') }]);
  check('le llega solo a Jesús; a Paula no', (await avisos(JESUS.u)).length === 3 && (await avisos(PAULA.u)).length === 2);
  check('la vuelta sigue arrancando con Paula (16:50)', (await vuelta(raS)).ini === '16:50');

  // ── 5 ───────────────────────────────────────────────────────────────────
  console.log('\n5. Volver a una hora que ya tuvo');
  await mover(raS, [{ stop_id: sid(rPau), at: at('16:40') }]);
  await mover(raS, [{ stop_id: sid(rPau), at: at('16:50') }]);
  const aP5 = await avisos(PAULA.u);
  check('16:50 → 16:40 → 16:50: Paula recibe las dos (la última dice 16:50)', aP5.length === 4 && /a las 16:50 /.test(aP5[3].body), aP5.map((a) => a.body));
  check('y la vuelta arranca 16:40 → 16:50 con ella', (await vuelta(raS)).ini === '16:50');

  // ── 6 ───────────────────────────────────────────────────────────────────
  console.log('\n6. «Deben estar» antes de la última recogida');
  const e6 = await debeFallar(() => mover(raS, [], null, at('17:00')));
  check('no deja: «“Deben estar” (17:00) queda antes de la última recogida (17:05)»', e6 && /queda antes de la última recogida \(17:05\)/.test(e6.message), e6 && e6.message);
  check('y no cambió nada', (await vuelta(raS)).dl === '17:40');

  // ── 7 ───────────────────────────────────────────────────────────────────
  console.log('\n7. Llegadas de reserva');
  const iniA = (await vuelta(raA)).ini;
  const r7 = await mover(raA, [], at('16:50'));
  check(`la llegada de Andrea (en JMC) sale a las 16:50 (antes ${iniA})`, (await vuelta(raA)).ini === '16:50' && r7.notified === 1, r7);
  check('su hora en la app es la salida del carro', (await hora(rAnd)) === '16:50');
  check('a Andrea: «Cambió la hora de tu regreso 🕒 · Te recogemos en JMC hacia las 16:50.»', JSON.stringify(await avisos(ANDREA.u)) === JSON.stringify([{ title: 'Cambió la hora de tu regreso 🕒', body: 'Te recogemos en JMC hacia las 16:50.' }]), await avisos(ANDREA.u));
  await mover(raL, [], at('18:30'));
  check('a Lesmes (Río Verde): «Te recogemos en el Hotel Río Verde hacia las 18:30.»', (await avisos(LESMES.u)).map((a) => a.body).join() === 'Te recogemos en el Hotel Río Verde hacia las 18:30.', await avisos(LESMES.u));
  await mover(raL, [], at('00:10').replace(DIA, (await one(`SELECT ($1::date + 1)::text d`, [DIA])).d));
  check('pasada la medianoche dice «0:10» (hm_bog de 0135)', /hacia las 0:10\./.test((await avisos(LESMES.u))[1].body), await avisos(LESMES.u));

  // ── 8 ───────────────────────────────────────────────────────────────────
  console.log('\n8. Lo que no deja');
  const e8a = await debeFallar(() => mover(raA, []));
  check('una llegada sin hora: «Falta la hora de salida»', e8a && /Falta la hora de salida/.test(e8a.message), e8a && e8a.message);
  const ajena = (await paradas(raA))[0].id;
  const e8b = await debeFallar(() => mover(raS, [{ stop_id: ajena, at: at('16:00') }]));
  check('una parada de otra vuelta: «Esa parada no es de esta vuelta»', e8b && /no es de esta vuelta/.test(e8b.message), e8b && e8b.message);
  const tablero = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at) VALUES ($1, 'home_to_airport', 'planned', $2::timestamptz) RETURNING id`, [JUAN, at('10:00')])).id;
  const e8c = await debeFallar(() => mover(tablero, [], null, at('10:40')));
  check('una vuelta del tablero: «Esa vuelta no es de la ruta de Julián»', e8c && /no es de la ruta de Julián/.test(e8c.message), e8c && e8c.message);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtro = await user(c, otraOrg, 'admin', 'Jefe de otra org');
  const e8d = await debeFallar(() => mover(raS, [], null, at('17:50'), jefeOtro, 'admin'));
  check('un jefe de otra organización no la ve', e8d && /no es de la ruta de Julián/.test(e8d.message), e8d && e8d.message);
  const e8e = await debeFallar(() => mover(raS, [], null, at('17:50'), juan, 'driver'));
  check('un conductor no puede (42501)', e8e && e8e.code === '42501', e8e && e8e.message);
  await q(`UPDATE public.route_stops SET status = 'picked_up' WHERE id = $1`, [sid(rPau)]);
  const e8f = await debeFallar(() => mover(raS, [{ stop_id: sid(rJes), at: at('17:10') }]));
  check('una vuelta que arrancó (Paula ya va a bordo): «ya arrancó»', e8f && /ya arrancó/.test(e8f.message), e8f && e8f.message);
  await q(`UPDATE public.route_stops SET status = 'pending' WHERE id = $1`, [sid(rPau)]);

  // ── 9 ───────────────────────────────────────────────────────────────────
  console.log('\n9. Delegada');
  const rMar = await sal(MAR, at('20:00'));
  const raD = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, pool, organization_id, manual_day, delegated_at, deadline_at)
      VALUES ('home_to_airport', 'planned', $1::timestamptz, true, $2, $3::date, now(), $4::timestamptz) RETURNING id`, [at('19:00'), fx.org, DIA, at('19:40')])).id;
  const sD = (await one(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz) RETURNING id`, [raD, rMar, at('19:00')])).id;
  const r9 = await mover(raD, [{ stop_id: sD, at: at('19:10') }], null, at('19:50'));
  check('se mueve, le avisa a Margy y no hay conductor a quien avisar', (await vuelta(raD)).ini === '19:10' && r9.notified === 1 && r9.driver_notified === false, r9);

  // ── 10 ──────────────────────────────────────────────────────────────────
  console.log('\n10. Volver a pegar después');
  await publicar(BLOQUES(['16:30', '16:35', '16:40', '17:10']));
  const v10 = await vuelta(raS);
  check('la misma vuelta (mismas personas) sigue con Juan y toma las horas de lo pegado', v10.d === JUAN && v10.ini === '16:30' && v10.dl === '17:10' && (await paradas(raS)).map((s) => s.h).join() === '16:30,16:35,16:40', v10);

  // ── 11 ──────────────────────────────────────────────────────────────────
  console.log('\n11. El down');
  await c.query(strip('../down_migrations/0145_cambiar_hora_pegada.down.sql'));
  check('quita la función', !(await existe(`to_regprocedure('public.admin_manual_route_set_times(uuid,jsonb,timestamptz,timestamptz)')`)));
} catch (e) {
  fail++;
  console.log('  ✗ error: ' + (e && e.message) + (e && e.where ? ' · ' + e.where : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok}/${ok + fail} pasaron (base local, transacción deshecha)`);
process.exit(fail ? 1 : 0);
