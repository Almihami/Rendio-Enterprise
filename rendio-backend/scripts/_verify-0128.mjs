// Verificación de 0128 (aviso a los jefes cuando un conductor termina una vuelta)
// contra la base LOCAL (127.0.0.1:54322). Aplica lo que falte (0117, 0124–0126) y
// 0128 dentro de una transacción que se deshace: no queda nada. Nunca apunta a dev
// ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0128.mjs
//
// Qué prueba:
//   1. Salida de 2: marcar a uno «a bordo» o «no se presentó» no avisa; la última
//      entrega sí. Le llega SOLO al jefe marcado en Personal (ni al otro ni al de
//      otra organización), con 2 min de gracia, enlace a Operación y el texto
//      «⚠️ Carlos Mejía terminó una vuelta · Salida de las 4:30 · … en el
//      aeropuerto · No se presentó: …». Tocar dos veces no repite. Ya enviado, una
//      marca corregida no lo vuelve a mandar.
//   2. Llegada: «No llegó» la termina (⚠️); «Deshacer» (0102) borra el aviso que no
//      había salido; al entregarla en la casa sale de nuevo, ahora ✅ «entregó a».
//   3. Una reserva cancelada que sigue en la vuelta no la deja abierta ni sale en
//      el texto. Sin nadie marcado en Personal, avisa a todos los jefes activos.
//   4. Si armar el aviso falla, la marca del conductor se guarda igual.
//   5. Una vuelta con todas sus reservas canceladas no avisa.
//   6. El down quita el disparador y la función.
//
// NO cubre: dos marcas de la misma vuelta en dos conexiones a la vez (el candado
// pg_advisory_xact_lock no se puede probar dentro de una sola transacción), la push
// de verdad, el reloj de despacho ni dev/producción.
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
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.hm_bog(timestamptz)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_delegated(uuid,boolean)')`))) await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  await c.query(strip('../supabase/migrations/0128_aviso_vuelta_terminada.sql'));
  await c.query(strip('../supabase/migrations/0128_aviso_vuelta_terminada.sql'));
  check('0128 se aplica encima de 0126 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefeA = await user(c, fx.org, 'admin', 'Camilo prueba 0128');
  const jefeB = await user(c, fx.org, 'admin', 'Christian prueba 0128');
  await q(`UPDATE public.profiles SET receives_ops_alerts = (id = $1) WHERE id = ANY($2)`, [jefeA, [jefeA, jefeB]]);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0128', 'otra-0128-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtro = await user(c, otraOrg, 'admin', 'Jefe de otra org 0128');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefeOtro]);

  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, hm) => `${d}T${hm}:00-05:00`;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LAURA = { u: fx.auxUser, a: fx.aux }, VECI = { u: fx.vecinoUser, a: fx.vecino };
  const SARA = await trip('Sara Ríos prueba'), HENRY = await trip('Henry Cano prueba');
  const res = async (X, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar])).id;
  const vuelta = async (dir, start, stops) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
        VALUES ($1, $2, $3, 'planned', $4::timestamptz) RETURNING id`, [fx.driver, fx.vehicle, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', start])).id;
    for (let i = 0; i < stops.length; i++) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, stops[i][0], i + 1, stops[i][1]]);
    return ra;
  };
  const marca = async (rid, st) => { await asUser(c, fx.drvUser, 'driver'); try { await q(`SELECT public.driver_set_reservation_status($1, $2)`, [rid, st]); } finally { await asDb(); } };
  const avisos = async (ra) => { await asDb(); return q(`SELECT profile_id, title, body, url, sent_at, extract(epoch FROM (send_after - now()))::int AS gracia FROM public.notification_outbox WHERE dedupe_key LIKE $1 ORDER BY created_at`, ['fin:' + ra + ':%']); };

  // ── 1. Salida de dos ──────────────────────────────────────────────────────
  console.log('\n1. Salida: avisa al terminar, solo al jefe marcado');
  const rL = await res(LAURA, 'sal', at(man, '06:00')), rV = await res(VECI, 'sal', at(man, '06:00'));
  const raS = await vuelta('sal', at(man, '04:20'), [[rL, at(man, '04:30')], [rV, at(man, '04:40')]]);
  await marca(rL, 'on_board');
  await marca(rV, 'no_show');
  check('a bordo uno y «no se presentó» el otro: todavía no avisa', (await avisos(raS)).length === 0, await avisos(raS));
  await marca(rL, 'delivered');
  const a1 = await avisos(raS);
  check('al entregar al último en el aeropuerto: UN aviso', a1.length === 1, a1);
  check('solo al jefe marcado en Personal (ni al otro ni al de otra organización)', a1.length === 1 && a1[0].profile_id === jefeA, a1.map((x) => x.profile_id));
  check('título «⚠️ Carlos Mejía terminó una vuelta» (hubo un no se presentó)', a1[0] && a1[0].title === '⚠️ Carlos Mejía terminó una vuelta', a1[0] && a1[0].title);
  check('cuerpo «Salida de las 4:30 · Laura Gómez en el aeropuerto · No se presentó: Vecina De»', a1[0] && a1[0].body === 'Salida de las 4:30 · Laura Gómez en el aeropuerto · No se presentó: Vecina De', a1[0] && a1[0].body);
  check('sale con 2 min de gracia y abre Operación', a1[0] && a1[0].gracia >= 100 && a1[0].gracia <= 125 && a1[0].url === '/#/operacion', a1[0] && [a1[0].gracia, a1[0].url]);
  await marca(rL, 'delivered');
  check('el conductor toca dos veces: no se repite', (await avisos(raS)).length === 1);
  const st1 = await one(`SELECT status FROM public.route_stops WHERE reservation_id = $1`, [rL]);
  check('la parada quedó entregada (el aviso no estorba la marca)', st1.status === 'delivered', st1);
  await q(`UPDATE public.notification_outbox SET sent_at = now() WHERE dedupe_key LIKE $1`, ['fin:' + raS + ':%']);
  await q(`UPDATE public.route_stops SET status = 'picked_up' WHERE reservation_id = $1`, [rL]);
  check('ya enviado, la vuelta se «abre» de nuevo: el enviado no se borra', (await avisos(raS)).length === 1);
  await q(`UPDATE public.route_stops SET status = 'delivered' WHERE reservation_id = $1`, [rL]);
  check('y al volver a terminarla no sale otro', (await avisos(raS)).length === 1, await avisos(raS));

  // ── 2. Llegada: «No llegó», «Deshacer» y entrega ──────────────────────────
  console.log('\n2. Llegada: el «Deshacer» borra el aviso que no había salido');
  const rS = await res(SARA, 'lle', at(man, '12:00'));
  const raL = await vuelta('lle', at(man, '12:00'), [[rS, at(man, '12:40')]]);
  await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [raL]);
  await q(`UPDATE public.route_stops SET status = 'no_show' WHERE route_assignment_id = $1`, [raL]);
  const a2 = await avisos(raL);
  check('«No llegó» al único: la vuelta terminó → aviso ⚠️ «Llegada de las 12:00 · No se presentó: Sara Ríos»', a2.length === 1 && a2[0].title.startsWith('⚠️') && a2[0].body === 'Llegada de las 12:00 · No se presentó: Sara Ríos', a2);
  await asUser(c, fx.drvUser, 'driver');
  const undo = (await one(`SELECT public.driver_airport_undo($1) r`, [rS])).r;
  await asDb();
  check('el conductor toca «Deshacer» (0102): el aviso que no había salido se borra', undo === 'no_show' && (await avisos(raL)).length === 0, { undo, a: await avisos(raL) });
  await marca(rS, 'picked_up');
  check('a bordo: todavía no avisa', (await avisos(raL)).length === 0);
  await marca(rS, 'delivered');
  const a3 = await avisos(raL);
  check('entregada en su casa: sale de nuevo, ahora ✅ «Llegada de las 12:00 · entregó a Sara Ríos»', a3.length === 1 && a3[0].title === '✅ Carlos Mejía terminó una vuelta' && a3[0].body === 'Llegada de las 12:00 · entregó a Sara Ríos', a3);

  // ── 3. Cancelada en la vuelta + nadie marcado ─────────────────────────────
  console.log('\n3. Reserva cancelada y jefes sin marcar');
  await q(`UPDATE public.profiles SET receives_ops_alerts = false WHERE id = $1`, [jefeA]);
  const rH = await res(HENRY, 'sal', at(man, '09:00')), rS2 = await res(SARA, 'sal', at(man, '09:00'));
  const raC = await vuelta('sal', at(man, '07:50'), [[rH, at(man, '08:00')], [rS2, at(man, '08:10')]]);
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rS2]);
  await marca(rH, 'on_board');
  await marca(rH, 'delivered');
  const a4 = await avisos(raC);
  check('la cancelada que quedó en la vuelta no la deja abierta: avisa al entregar a Henry', a4.length >= 1, a4);
  check('y no sale en el texto: «Salida de las 8:00 · Henry Cano en el aeropuerto»', a4[0] && a4[0].body === 'Salida de las 8:00 · Henry Cano en el aeropuerto', a4[0] && a4[0].body);
  check('sin nadie marcado en Personal: a los dos jefes activos (no al de otra organización)', a4.length === 2 && a4.every((x) => [jefeA, jefeB].includes(x.profile_id)), a4.map((x) => x.profile_id));

  // ── 4. Si el aviso falla, la marca se guarda ──────────────────────────────
  console.log('\n4. Nunca frena al conductor');
  const rL2 = await res(LAURA, 'sal', at(man, '15:00'));
  const raF = await vuelta('sal', at(man, '13:50'), [[rL2, at(man, '14:00')]]);
  await marca(rL2, 'on_board');
  await q(`ALTER TABLE public.notification_outbox RENAME TO notification_outbox_0128`);
  let err = null;
  try { await marca(rL2, 'delivered'); } catch (e) { err = e; }
  await q(`ALTER TABLE public.notification_outbox_0128 RENAME TO notification_outbox`);
  const st2 = await one(`SELECT status FROM public.route_stops WHERE reservation_id = $1`, [rL2]);
  check('sin bandeja de avisos, «entregado» se guarda igual y no da error', !err && st2.status === 'delivered', err ? err.message : st2);
  check('(y no queda aviso a medias)', (await avisos(raF)).length === 0);

  // ── 5. Toda cancelada ─────────────────────────────────────────────────────
  console.log('\n5. Vuelta sin nadie');
  const rX = await res(HENRY, 'sal', at(man, '18:00'));
  const raX = await vuelta('sal', at(man, '16:50'), [[rX, at(man, '17:00')]]);
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rX]);
  await q(`UPDATE public.route_stops SET status = 'no_show' WHERE route_assignment_id = $1`, [raX]);
  check('una vuelta con todas sus reservas canceladas no es un servicio terminado: no avisa', (await avisos(raX)).length === 0);

  // ── 6. Permisos y down ────────────────────────────────────────────────────
  console.log('\n6. Permisos y reversa');
  const pub = await one(`SELECT has_function_privilege('authenticated', 'public.route_finished_alert()', 'EXECUTE') a, has_function_privilege('anon', 'public.route_finished_alert()', 'EXECUTE') b`);
  check('la función del disparador no la puede llamar la app', !pub.a && !pub.b, pub);
  await c.query(strip('../down_migrations/0128_aviso_vuelta_terminada.down.sql'));
  const quedan = await one(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'tr_route_stops_finished_alert')::int t, to_regprocedure('public.route_finished_alert()') f`);
  check('el down quita el disparador y la función', quedan.t === 0 && quedan.f === null, quedan);
  const rH2 = await res(HENRY, 'sal', at(man, '20:00'));
  const raD = await vuelta('sal', at(man, '19:50'), [[rH2, at(man, '20:00')]]);
  await marca(rH2, 'on_board'); await marca(rH2, 'delivered');
  check('sin 0128 terminar una vuelta no avisa (como antes)', (await avisos(raD)).length === 0);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
