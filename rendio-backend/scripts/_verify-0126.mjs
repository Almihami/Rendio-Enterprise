// Verificación de 0126 (la vuelta DELEGADA: la hace alguien de afuera) contra la
// base LOCAL (127.0.0.1:54322). Aplica 0124, 0125 y 0126 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0126.mjs
//
// Qué prueba (el día de la ruta es MAÑANA en Bogotá):
//   1. Tablero: una vuelta publicada delegada (como la guarda saveRoutePlan: sin
//      conductor, planned, delegated_at) → la reserva conserva su hora y sigue
//      «pedida»; el tripulante la ve publicada, delegada, sin conductor y SIN
//      driver_pending; no se le puede poner conductor (CHECK).
//   2. Ruta pegada (0125): Juan toma la salida; el jefe la delega → sin conductor,
//      la reserva vuelve a «pedida» con su hora, a cada tripulante le llega «Tu
//      servicio fue delegado» con la hora y a Juan «Ya no haces una vuelta». Ningún
//      conductor la ve ni la puede tomar. Delegar otra vez no repite nada.
//   3. Nadie la tomó y falta menos de una hora: la delegada NO suena; la otra sí.
//   4. Devolverla: vuelve a la lista de los conductores, aviso «vuelve con Rendio»,
//      el tripulante otra vez con driver_pending.
//   5. Con la ruta delegada publicada: cambiar la hora pasa por Coordinación y un
//      pedido nuevo sin vuelta abre la reserva tardía (cuenta como publicada).
//   6. Lo que ya arrancó no se delega. Permisos: ni tripulante ni conductor delegan;
//      anónimo no; la función es de la app solo para jefes.
//   7. El down deja las funciones EXACTAMENTE como en 0125.
//
// NO cubre: la pantalla (tablero y ruta pegada: _smoke-rutas-v2-dom.mjs), la push
// de verdad, pg_cron real ni dev/producción.
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
const FUNCS = ['sync_calculated_pickup', 'auxiliar_my_trips', 'auxiliar_change_flight', 'detect_late_bookings', 'driver_open_routes', 'driver_take_route', 'pool_unclaimed_alerts'];
const huellas = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [FUNCS])).map((r) => [r.proname, r.h]));

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  const h0125 = await huellas();
  await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  check('0126 se aplica encima de 0125 (y se puede volver a correr)', true);
  const h0126 = await huellas();
  check('cambian las 7 copias de 0125 (y solo ellas)', FUNCS.every((f) => h0125[f] && h0126[f] && h0125[f] !== h0126[f]), { h0125, h0126 });

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Julián prueba 0126');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0126'), DANI = await drv('Daniel Alvarez prueba 0126');
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LUZ = await trip('Luz Bomba prueba'), LAURA = await trip('Laura Yalanda prueba'), SARA = await trip('Sara Villegas prueba'), JESS = await trip('Jessica Mora prueba'), TARDE = await trip('Tardía Pérez prueba');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, hm) => `${d}T${hm}:00-05:00`;
  const res = async (X, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar])).id;
  const reserva = async (id) => { await asDb(); return one(`SELECT status_h2a::text h2a, status_a2h::text a2h, calculated_pickup_at FROM public.reservations WHERE id = $1`, [id]); };
  const mis = async (X, rid) => { await asUser(c, X.u, 'auxiliar'); const j = (await one(`SELECT public.auxiliar_my_trips(30) j`)).j; await asDb(); return (j || []).find((x) => x.id === rid); };
  const abiertas = async (D) => { await asUser(c, D.u, 'driver'); const l = (await one(`SELECT public.driver_open_routes() l`)).l; await asDb(); return l || []; };
  const delegar = async (ra, on, quien = jefe, rol = 'admin') => { await asUser(c, quien, rol); try { return (await one(`SELECT public.admin_route_set_delegated($1, $2) r`, [ra, on])).r; } finally { await asDb(); } };

  // ── 1. Tablero: vuelta publicada delegada ──────────────────────────────────
  console.log('\n1. Tablero: una vuelta delegada al publicar');
  const rSara = await res(SARA, 'sal', at(man, '05:00'));
  const raT = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, plan_car, delegated_at)
      VALUES (NULL, NULL, 'home_to_airport', 'planned', $1::timestamptz, 'Carro 2', now()) RETURNING id`, [at(man, '04:25')])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz)`, [raT, rSara, at(man, '04:30')]);
  const rs1 = await reserva(rSara);
  check('la reserva conserva su hora de recogida (4:30) y sigue «pedida»', rs1.calculated_pickup_at && new Date(rs1.calculated_pickup_at).getTime() === Date.parse(at(man, '04:30')) && rs1.h2a === 'requested', rs1);
  const m1 = await mis(SARA, rSara);
  check('el tripulante: publicada, delegada, sin conductor y SIN driver_pending, con su hora', m1 && m1.published === true && m1.delegated === true && m1.driver_pending === false && m1.driver === null && !!m1.pickup_at, m1 && { pub: m1.published, deleg: m1.delegated, pend: m1.driver_pending, drv: m1.driver, at: m1.pickup_at });
  const e1 = await debeFallar(`UPDATE public.route_assignments SET driver_profile_id = $1 WHERE id = $2`, [JUAN.dp, raT]);
  check('a una delegada no se le puede poner conductor (CHECK)', e1 && /route_assignments_delegada_sin_conductor/.test(e1.message), e1 && e1.message);
  check('una vuelta del tablero delegada no sale en «Vueltas para tomar»', !(await abiertas(DANI)).some((v) => v.id === raT));

  // ── 2. Ruta pegada: Juan la toma y el jefe la delega ──────────────────────
  console.log('\n2. Ruta pegada: delegar una vuelta que ya tomó un conductor');
  const rLuz = await res(LUZ, 'sal', at(man, '05:00')), rLaura = await res(LAURA, 'sal', at(man, '05:00')), rJess = await res(JESS, 'lle', at(man, '12:00'));
  await asUser(c, jefe, 'admin');
  const p1 = (await one(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb) r`, [man, JSON.stringify([
    { type: 'sal', deadline_at: at(man, '05:00'), stops: [{ reservation_id: rLuz, at: at(man, '04:15') }, { reservation_id: rLaura, at: at(man, '04:25') }] },
    { type: 'lle', flight: 'AV9563', stops: [{ reservation_id: rJess, at: at(man, '12:00') }] }])])).r;
  await asDb();
  const pegadas = await q(`SELECT ra.id, ra.direction FROM public.route_assignments ra WHERE ra.pool AND ra.organization_id = $1 ORDER BY planned_start_at`, [fx.org]);
  const vSal = pegadas.find((v) => v.direction === 'home_to_airport').id, vLle = pegadas.find((v) => v.direction === 'airport_to_home').id;
  check('el jefe pega 2 vueltas', p1.created === 2, p1);
  await asUser(c, JUAN.u, 'driver'); await q(`SELECT public.driver_take_route($1)`, [vSal]); await asDb();
  check('Juan tomó la salida: las reservas quedan «asignadas»', (await reserva(rLuz)).h2a === 'assigned');
  const d1 = await delegar(vSal, true);
  const ra1 = await one(`SELECT driver_profile_id, vehicle_id, delegated_at, delegated_by, status FROM public.route_assignments WHERE id = $1`, [vSal]);
  check('delegarla: sin conductor ni carro, con la marca y quién la delegó, sigue publicada', ra1.driver_profile_id === null && ra1.vehicle_id === null && !!ra1.delegated_at && ra1.delegated_by === jefe && ra1.status === 'planned', ra1);
  check('responde a quién avisó (2 tripulantes) y que le quitó la vuelta a un conductor', d1.delegated === true && d1.notified === 2 && d1.driver_removed === true, d1);
  const rl = await reserva(rLuz);
  check('las reservas vuelven a «pedida» y conservan la hora (4:15)', rl.h2a === 'requested' && new Date(rl.calculated_pickup_at).getTime() === Date.parse(at(man, '04:15')), rl);
  check('a Luz: «Tu servicio fue delegado 🤝» · «…por WhatsApp para coordinar tu recogida de las 4:15»', (await outbox(LUZ.u, 'Tu servicio fue delegado%')).some((x) => /WhatsApp para coordinar tu recogida de las 4:15/.test(x.body)), await outbox(LUZ.u, '%delegado%'));
  check('a Juan: «Ya no haces una vuelta» (la de las 4:15)', (await outbox(JUAN.u, 'Ya no haces una vuelta')).some((x) => /4:15/.test(x.body)));
  const mL = await mis(LUZ, rLuz);
  check('Luz la ve delegada, sin conductor y sin driver_pending', mL && mL.delegated === true && mL.driver === null && mL.driver_pending === false, mL && [mL.delegated, mL.driver, mL.driver_pending]);
  check('ningún conductor la ve en «Vueltas para tomar» (la llegada sí)', !(await abiertas(DANI)).some((v) => v.id === vSal) && (await abiertas(DANI)).some((v) => v.id === vLle));
  await asUser(c, DANI.u, 'driver');
  const e2 = await debeFallar(`SELECT public.driver_take_route($1)`, [vSal]);
  await asDb();
  check('si Daniel la intenta tomar: «la hace alguien de afuera»', e2 && /alguien de afuera/.test(e2.message), e2 && e2.message);
  const n0 = (await outbox(LUZ.u, 'Tu servicio fue delegado%')).length;
  const d2 = await delegar(vSal, true);
  check('delegarla otra vez no cambia nada ni repite avisos', d2.unchanged === true && (await outbox(LUZ.u, 'Tu servicio fue delegado%')).length === n0, d2);

  // ── 3. «Nadie la tomó» ────────────────────────────────────────────────────
  console.log('\n3. El reloj de «nadie la tomó»');
  const rPronto1 = await res(TARDE, 'sal', new Date(Date.now() + 70 * 60000).toISOString());
  const rPronto2 = await res(JESS, 'sal', new Date(Date.now() + 75 * 60000).toISOString());
  const pronto = async (rid, delegada) => {
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, pool, organization_id, manual_day, delegated_at)
        VALUES ('home_to_airport', 'planned', now() + interval '30 minutes', true, $1, $2::date, $3) RETURNING id`, [fx.org, hoy, delegada ? new Date().toISOString() : null])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, now() + interval '30 minutes')`, [ra, rid]);
    return ra;
  };
  const raD = await pronto(rPronto1, true), raL = await pronto(rPronto2, false);
  const nAv = (await one(`SELECT public.pool_unclaimed_alerts() n`)).n;
  const avJ = await outbox(jefe, 'Nadie ha tomado una vuelta%');
  check('suena por la que nadie tomó, NO por la delegada', nAv >= 1 && avJ.length === 1 && /Jessica/.test(avJ[0].body) && !/Tardía/.test(avJ.map((x) => x.body).join(' ')), avJ);
  await q(`DELETE FROM public.route_assignments WHERE id = ANY($1)`, [[raD, raL]]);

  // ── 4. Devolverla ─────────────────────────────────────────────────────────
  console.log('\n4. Devolver la vuelta');
  const d3 = await delegar(vSal, false);
  check('devuelta: sin la marca, otra vez en «Vueltas para tomar»', d3.delegated === false && !(await one(`SELECT delegated_at FROM public.route_assignments WHERE id = $1`, [vSal])).delegated_at && (await abiertas(DANI)).some((v) => v.id === vSal), d3);
  check('a Luz: «Tu traslado vuelve con Rendio»', (await outbox(LUZ.u, 'Tu traslado vuelve con Rendio%')).length === 1);
  const mL2 = await mis(LUZ, rLuz);
  check('Luz: otra vez driver_pending, ya no delegada', mL2 && mL2.driver_pending === true && mL2.delegated === false, mL2 && [mL2.driver_pending, mL2.delegated]);
  await delegar(vSal, true);

  // ── 5. Cuenta como ruta publicada ─────────────────────────────────────────
  console.log('\n5. La delegada cuenta como publicada');
  await asUser(c, SARA.u, 'auxiliar');
  const cf = (await one(`SELECT public.auxiliar_change_flight($1, NULL, $2::timestamptz, NULL) r`, [rSara, at(man, '06:00')])).r;
  await asDb();
  check('cambiar la hora de Sara (vuelta del tablero delegada) pasa por Coordinación', cf && cf.mode === 'needs_ops', cf);
  // Un día que SOLO tiene una vuelta delegada: un pedido nuevo sin vuelta es reserva tardía.
  await q(`DELETE FROM public.route_assignments ra WHERE ra.organization_id = $1 OR ra.id = $2`, [fx.org, raT]);
  const pasado = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota') + interval '20 hours')::date::text d`)).d;
  const rSola = await res(LAURA, 'sal', new Date(Date.now() + 22 * 3600000).toISOString());
  const raSola = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, delegated_at) VALUES ('home_to_airport', 'planned', $1::timestamptz, now()) RETURNING id`, [new Date(Date.now() + 21 * 3600000).toISOString()])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [raSola, rSola]);
  const rNueva = await res(TARDE, 'sal', new Date(Date.now() + 22 * 3600000 + 10 * 60000).toISOString());
  await c.query('SAVEPOINT tarde');
  await q(`SELECT public.detect_late_bookings()`);
  const inc = await one(`SELECT count(*)::int n FROM public.incidents WHERE dedupe_key = 'late:' || $1::text`, [rNueva]);
  await c.query('ROLLBACK TO SAVEPOINT tarde');
  check(`con solo una vuelta delegada publicada ese día (${pasado}), un pedido nuevo sin vuelta abre la reserva tardía`, inc.n === 1, inc);

  // ── 6. Lo que no se puede ─────────────────────────────────────────────────
  console.log('\n6. Lo que no se puede');
  await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [raSola]);
  // Lo que debe fallar se prueba en su SAVEPOINT; el rol se limpia DESPUÉS de deshacerlo.
  const delegarFalla = async (ra, on, quien, rol) => {
    await c.query('SAVEPOINT sp_d');
    await asUser(c, quien, rol);
    try { await q(`SELECT public.admin_route_set_delegated($1, $2)`, [ra, on]); await c.query('RELEASE SAVEPOINT sp_d'); await asDb(); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_d'); await asDb(); return e; }
  };
  const e3 = await delegarFalla(raSola, false, jefe, 'admin');
  check('una vuelta que ya arrancó no se delega ni se devuelve', e3 && /ya arrancó/.test(e3.message), e3 && e3.message);
  for (const [X, rol] of [[LUZ.u, 'auxiliar'], [JUAN.u, 'driver']]) {
    const e = await delegarFalla(raSola, true, X, rol);
    check(`un ${rol === 'auxiliar' ? 'tripulante' : 'conductor'} no delega`, e && e.code === '42501', e && e.message);
  }
  const pr = await one(`SELECT has_function_privilege('anon', 'public.admin_route_set_delegated(uuid,boolean)', 'EXECUTE') anon,
                               has_function_privilege('authenticated', 'public.admin_route_set_delegated(uuid,boolean)', 'EXECUTE') auth`);
  check('anónimo no la puede llamar; la app (autenticada) sí', pr.anon === false && pr.auth === true, pr);

  // ── 7. El down ────────────────────────────────────────────────────────────
  console.log('\n7. El down');
  await c.query('SAVEPOINT down');
  await q(`DELETE FROM public.route_assignments WHERE delegated_at IS NOT NULL`);
  await c.query(strip('../../rendio-backend/down_migrations/0126_vuelta_delegada.down.sql'));
  const hDown = await huellas();
  const col = await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name IN ('delegated_at', 'delegated_by')`);
  check('el down deja las 7 funciones EXACTAMENTE como en 0125 y quita las columnas', FUNCS.every((f) => hDown[f] === h0125[f]) && col.n === 0 && !(await one(`SELECT to_regprocedure('public.admin_route_set_delegated(uuid,boolean)') IS NOT NULL ok`)).ok, { hDown, col });
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la pantalla (tablero y ruta pegada), la push de verdad, pg_cron real ni dev/producción.');
process.exit(fail ? 1 : 0);
