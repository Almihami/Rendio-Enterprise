// Verificación de 0136 (aviso a los jefes cuando un conductor INICIA una vuelta)
// contra la base LOCAL (127.0.0.1:54322). Aplica lo que falte (0117, 0124–0126,
// 0128, 0133) y 0136 dentro de una transacción que se deshace: no queda nada.
// Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0136.mjs
//
// Qué prueba:
//   1. Salida: «Iniciar ruta» (driver_route_started) avisa YA, solo al jefe marcado
//      en Personal, «🚗 Carlos Mejía inició una vuelta · Salida de las 4:30 · recoge
//      a …». Tocar otra vez, «en camino» y «llegué» no lo repiten. Al terminar sale
//      también el de 0128: los dos avisos de la misma vuelta.
//   2. Llegada con la app vieja (sin RPC): «Llegué al aeropuerto» marca todas las
//      paradas a la vez y sale UN aviso por jefe, «… recoge a … en el aeropuerto».
//   3. Salida con la app vieja: «en camino» no avisa (no mueve la parada); «llegué»
//      a la primera casa sí.
//   4. Una vuelta que ya iba a medias (alguien a bordo) no manda un «inició» tarde,
//      ni por la marca ni por el botón.
//   5. La vuelta de otro conductor o ya terminada: false, sin aviso. Un tripulante no
//      puede llamarla. La app no puede llamar la función que arma el aviso.
//   6. Canceladas fuera del texto; toda cancelada no avisa; el pasajero sin cuenta
//      (0133) sí sale. Sin nadie marcado en Personal, a todos los jefes activos.
//   7. Si armar el aviso falla, la RPC devuelve false y la marca se guarda igual.
//   8. El down quita todo.
//
// NO cubre: dos marcas en dos conexiones a la vez (el candado no se prueba en una
// sola transacción), la push de verdad, el reloj de despacho ni dev/producción. La
// llamada desde la app (driver-rutas.js) la cubre _smoke-aviso-inicio-dom.mjs.
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
  if (!(await existe(`to_regprocedure('public.route_finished_alert()')`))) await c.query(strip('../supabase/migrations/0128_aviso_vuelta_terminada.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_stops' AND column_name = 'guest_name')`))) await c.query(strip('../supabase/migrations/0133_pasajero_sin_cuenta.sql'));
  await c.query(strip('../supabase/migrations/0136_aviso_vuelta_iniciada.sql'));
  await c.query(strip('../supabase/migrations/0136_aviso_vuelta_iniciada.sql'));
  check('0136 se aplica encima de 0128/0133 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefeA = await user(c, fx.org, 'admin', 'Camilo prueba 0136');
  const jefeB = await user(c, fx.org, 'admin', 'Christian prueba 0136');
  await q(`UPDATE public.profiles SET receives_ops_alerts = (id = $1) WHERE id = ANY($2)`, [jefeA, [jefeA, jefeB]]);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0136', 'otra-0136-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtro = await user(c, otraOrg, 'admin', 'Jefe de otra org 0136');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefeOtro]);
  const drv2User = await user(c, fx.org, 'driver', 'Miguel Peña prueba 0136');
  await q(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1)`, [drv2User]);

  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, hm) => `${d}T${hm}:00-05:00`;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LAURA = { u: fx.auxUser, a: fx.aux }, VECI = { u: fx.vecinoUser, a: fx.vecino };
  const SARA = await trip('Sara Ríos prueba'), HENRY = await trip('Henry Cano prueba');
  const res = async (X, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar])).id;
  // stops: [reservation_id, hora] o [{ guest: 'Nombre' }, hora]
  const vuelta = async (dir, start, stops) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
        VALUES ($1, $2, $3, 'planned', $4::timestamptz) RETURNING id`, [fx.driver, fx.vehicle, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', start])).id;
    for (let i = 0; i < stops.length; i++) {
      const [x, hora] = stops[i];
      if (x && x.guest) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, guest_name, stop_order, estimated_arrival_at) VALUES ($1, NULL, $2, $3, $4::timestamptz)`, [ra, x.guest, i + 1, hora]);
      else await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, x, i + 1, hora]);
    }
    return ra;
  };
  const comoConductor = async (fn, u = fx.drvUser) => { await asUser(c, u, 'driver'); try { return await fn(); } finally { await asDb(); } };
  const marca = (rid, st) => comoConductor(() => q(`SELECT public.driver_set_reservation_status($1, $2)`, [rid, st]));
  const inicia = async (ra, u) => (await comoConductor(() => one(`SELECT public.driver_route_started($1) r`, [ra]), u)).r;
  const avisos = async (ra, pref = 'ini') => { await asDb(); return q(`SELECT profile_id, title, body, url, sent_at, extract(epoch FROM (send_after - now()))::int AS gracia FROM public.notification_outbox WHERE dedupe_key LIKE $1 ORDER BY created_at`, [pref + ':' + ra + ':%']); };

  // ── 1. Salida con «Iniciar ruta» ─────────────────────────────────────────────
  console.log('\n1. Salida: «Iniciar ruta» avisa ya, una sola vez');
  const rL = await res(LAURA, 'sal', at(man, '06:00')), rV = await res(VECI, 'sal', at(man, '06:00'));
  const raS = await vuelta('sal', at(man, '04:20'), [[rL, at(man, '04:30')], [rV, at(man, '04:40')]]);
  check('antes de tocar nada: ningún aviso', (await avisos(raS)).length === 0);
  const r1 = await inicia(raS);
  const a1 = await avisos(raS);
  check('«Iniciar ruta» devuelve true y deja UN aviso', r1 === true && a1.length === 1, { r1, a1 });
  check('solo al jefe marcado en Personal (ni al otro ni al de otra organización)', a1.length === 1 && a1[0].profile_id === jefeA, a1.map((x) => x.profile_id));
  check('título «🚗 Carlos Mejía inició una vuelta»', a1[0] && a1[0].title === '🚗 Carlos Mejía inició una vuelta', a1[0] && a1[0].title);
  check('cuerpo «Salida de las 4:30 · recoge a Laura Gómez, Vecina De»', a1[0] && a1[0].body === 'Salida de las 4:30 · recoge a Laura Gómez, Vecina De', a1[0] && a1[0].body);
  check('sale ya (sin gracia) y abre Operación', a1[0] && a1[0].gracia <= 1 && a1[0].url === '/#/operacion', a1[0] && [a1[0].gracia, a1[0].url]);
  const r1b = await inicia(raS);
  check('tocar «Iniciar ruta» otra vez: false y no se repite', r1b === false && (await avisos(raS)).length === 1, r1b);
  await marca(rL, 'en_route');
  await marca(rL, 'at_pickup');
  check('«en camino» y «llegué» a la primera casa no lo repiten', (await avisos(raS)).length === 1, await avisos(raS));
  const st0 = await one(`SELECT status FROM public.route_stops WHERE reservation_id = $1`, [rL]);
  check('la parada quedó «llegué» (el aviso no estorba la marca)', st0.status === 'arrived', st0);
  await q(`UPDATE public.notification_outbox SET sent_at = now() WHERE dedupe_key LIKE $1`, ['ini:' + raS + ':%']);
  await marca(rL, 'on_board'); await marca(rV, 'at_pickup'); await marca(rV, 'on_board');
  await marca(rL, 'delivered'); await marca(rV, 'delivered');
  const f1 = await avisos(raS, 'fin');
  check('al terminar sale el de 0128 («terminó una vuelta») y el de inicio sigue siendo uno', f1.length === 1 && f1[0].title === '✅ Carlos Mejía terminó una vuelta' && (await avisos(raS)).length === 1, { f1, ini: await avisos(raS) });

  // ── 2. Llegada con la app vieja ─────────────────────────────────────────────
  console.log('\n2. Llegada sin «Iniciar ruta» (app vieja): avisa con «Llegué al aeropuerto»');
  const rS = await res(SARA, 'lle', at(man, '12:00')), rH = await res(HENRY, 'lle', at(man, '12:00'));
  const raL = await vuelta('lle', at(man, '12:00'), [[rS, at(man, '12:40')], [rH, at(man, '12:50')]]);
  const n = await comoConductor(async () => (await one(`SELECT public.driver_mark_airport_arrival($1) n`, [raL])).n);
  const a2 = await avisos(raL);
  check('marca las 2 paradas a la vez y sale UN aviso (no uno por parada)', n === 2 && a2.length === 1, { n, a2 });
  check('cuerpo «Llegada de las 12:00 · recoge a Sara Ríos, Henry Cano en el aeropuerto»', a2[0] && a2[0].body === 'Llegada de las 12:00 · recoge a Sara Ríos, Henry Cano en el aeropuerto', a2[0] && a2[0].body);
  check('y el botón después ya no lo repite (llegaría tarde, a media espera)', (await inicia(raL)) === false && (await avisos(raL)).length === 1);

  // ── 3. Salida con la app vieja ──────────────────────────────────────────────
  console.log('\n3. Salida sin «Iniciar ruta»: avisa con la primera llegada a una casa');
  const rL3 = await res(LAURA, 'sal', at(man, '09:00'));
  const raS3 = await vuelta('sal', at(man, '07:50'), [[rL3, at(man, '08:00')]]);
  await marca(rL3, 'en_route');
  check('«en camino» solo (no mueve la parada): todavía no avisa', (await avisos(raS3)).length === 0);
  await marca(rL3, 'at_pickup');
  const a3 = await avisos(raS3);
  check('«llegué» a la primera casa: avisa una vez', a3.length === 1 && a3[0].body === 'Salida de las 8:00 · recoge a Laura Gómez', a3);

  // ── 4. Vuelta que ya iba a medias ───────────────────────────────────────────
  console.log('\n4. A media vuelta no avisa (las que van en curso al aplicar esto)');
  const rL4 = await res(LAURA, 'sal', at(man, '15:00')), rV4 = await res(VECI, 'sal', at(man, '15:00'));
  const raM = await vuelta('sal', at(man, '13:50'), [[rL4, at(man, '14:00')], [rV4, at(man, '14:10')]]);
  await q(`ALTER TABLE public.route_stops DISABLE TRIGGER tr_route_stops_started_alert`);
  await marca(rL4, 'at_pickup'); await marca(rL4, 'on_board');   // marcado antes de 0136
  await q(`ALTER TABLE public.route_stops ENABLE TRIGGER tr_route_stops_started_alert`);
  await marca(rV4, 'at_pickup');
  check('Laura ya a bordo: «llegué» donde la segunda no manda un «inició» tarde', (await avisos(raM)).length === 0, await avisos(raM));
  check('ni el botón (reinstaló la app y lo tocó de nuevo)', (await inicia(raM)) === false && (await avisos(raM)).length === 0);
  const rS4 = await res(SARA, 'sal', at(man, '17:00'));
  const raN = await vuelta('sal', at(man, '15:50'), [[rS4, at(man, '16:00')]]);
  await marca(rS4, 'no_show');
  check('pendiente → «no se presentó» de una (la primera marca): sí avisa', (await avisos(raN)).length === 1, await avisos(raN));

  // ── 5. Permisos ─────────────────────────────────────────────────────────────
  console.log('\n5. De quién es la vuelta');
  const rH5 = await res(HENRY, 'sal', at(man, '19:00'));
  const raO = await vuelta('sal', at(man, '17:50'), [[rH5, at(man, '18:00')]]);
  check('otro conductor la inicia: false y sin aviso', (await inicia(raO, drv2User)) === false && (await avisos(raO)).length === 0);
  await q(`UPDATE public.route_assignments SET status = 'completed' WHERE id = $1`, [raO]);
  check('una vuelta ya terminada: false', (await inicia(raO)) === false && (await avisos(raO)).length === 0);
  let errAux = null;
  await asUser(c, fx.auxUser, 'auxiliar');
  try { await q(`SAVEPOINT s5`); await q(`SELECT public.driver_route_started($1)`, [raO]); } catch (e) { errAux = e; await q(`ROLLBACK TO SAVEPOINT s5`); } finally { await asDb(); }
  check('un tripulante no puede: «solo un conductor puede iniciar una vuelta»', errAux && /solo un conductor/.test(errAux.message), errAux && errAux.message);
  const priv = await one(`SELECT has_function_privilege('authenticated', 'public.driver_route_started(uuid)', 'EXECUTE') rpc,
      has_function_privilege('anon', 'public.driver_route_started(uuid)', 'EXECUTE') rpc_anon,
      has_function_privilege('authenticated', 'public.route_started_alert_enqueue(uuid,uuid)', 'EXECUTE') enq,
      has_function_privilege('anon', 'public.route_started_alert_enqueue(uuid,uuid)', 'EXECUTE') enq_anon,
      has_function_privilege('authenticated', 'public.route_started_alert()', 'EXECUTE') trg`);
  check('la app (authenticated) llama la RPC; anon no; nadie llama la que arma el aviso ni la del disparador', priv.rpc && !priv.rpc_anon && !priv.enq && !priv.enq_anon && !priv.trg, priv);

  // ── 6. Canceladas, sin cuenta y jefes sin marcar ────────────────────────────
  console.log('\n6. Quién sale en el texto y a quién le llega');
  await q(`UPDATE public.profiles SET receives_ops_alerts = false WHERE id = $1`, [jefeA]);
  const rL6 = await res(LAURA, 'sal', at(man, '21:00')), rS6 = await res(SARA, 'sal', at(man, '21:00'));
  const raC = await vuelta('sal', at(man, '19:40'), [[rL6, at(man, '19:50')], [{ guest: 'Kriss' }, at(man, '19:55')], [rS6, at(man, '20:00')]]);
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rS6]);
  await inicia(raC);
  const a6 = await avisos(raC);
  check('la cancelada no sale; el pasajero sin cuenta sí: «… recoge a Laura Gómez, Kriss»', a6[0] && a6[0].body === 'Salida de las 19:50 · recoge a Laura Gómez, Kriss', a6[0] && a6[0].body);
  check('sin nadie marcado en Personal: a los dos jefes activos (no al de otra organización)', a6.length === 2 && a6.every((x) => [jefeA, jefeB].includes(x.profile_id)), a6.map((x) => x.profile_id));
  const rX = await res(HENRY, 'sal', at(man, '23:00'));
  const raX = await vuelta('sal', at(man, '21:50'), [[rX, at(man, '22:00')]]);
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rX]);
  check('toda cancelada: no es un servicio, no avisa', (await inicia(raX)) === false && (await avisos(raX)).length === 0);

  // ── 7. Si el aviso falla ────────────────────────────────────────────────────
  console.log('\n7. Nunca frena al conductor');
  const rL7 = await res(LAURA, 'lle', at(man, '14:00'));
  const raF = await vuelta('lle', at(man, '14:00'), [[rL7, at(man, '14:40')]]);
  await q(`ALTER TABLE public.notification_outbox RENAME TO notification_outbox_0136`);
  let err = null, rF = null;
  try { rF = await inicia(raF); } catch (e) { err = e; }
  check('sin bandeja de avisos: la RPC devuelve false sin error', !err && rF === false, err ? err.message : rF);
  // (driver_mark_airport_arrival de 0097 escribe en la bandeja por su cuenta; aquí
  // se prueba que el disparador de 0136 no frena una marca de parada.)
  let err2 = null;
  try { await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [raF]); } catch (e) { err2 = e; }
  await q(`ALTER TABLE public.notification_outbox_0136 RENAME TO notification_outbox`);
  const stF = await one(`SELECT status FROM public.route_stops WHERE route_assignment_id = $1`, [raF]);
  check('y la marca de la parada se guarda igual (el disparador se traga el error)', !err2 && stF.status === 'arrived', err2 ? err2.message : stF);
  check('(y no queda aviso a medias)', (await avisos(raF)).length === 0);

  // ── 8. Down ─────────────────────────────────────────────────────────────────
  console.log('\n8. Reversa');
  await c.query(strip('../down_migrations/0136_aviso_vuelta_iniciada.down.sql'));
  const quedan = await one(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'tr_route_stops_started_alert')::int t,
      to_regprocedure('public.route_started_alert()') f, to_regprocedure('public.driver_route_started(uuid)') r,
      to_regprocedure('public.route_started_alert_enqueue(uuid,uuid)') e,
      (SELECT count(*) FROM pg_trigger WHERE tgname = 'tr_route_stops_finished_alert')::int fin`);
  check('el down quita el disparador y las tres funciones (0128 se queda)', quedan.t === 0 && !quedan.f && !quedan.r && !quedan.e && quedan.fin === 1, quedan);
  const rH8 = await res(HENRY, 'sal', at(man, '05:00'));
  const raD = await vuelta('sal', at(man, '03:50'), [[rH8, at(man, '04:00')]]);
  await marca(rH8, 'at_pickup');
  check('sin 0136 iniciar una vuelta no avisa (como antes)', (await avisos(raD)).length === 0);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
