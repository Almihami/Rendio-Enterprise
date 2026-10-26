// Verificación de 0141 (una vuelta que armó el sistema solo NO publica el día)
// contra la base LOCAL (127.0.0.1:54322). Aplica 0124–0136 y 0141 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0141.mjs        (antes de las 9 p. m.)
//
// El caso de producción del 26-oct-2026 (HOY = el día publicado, MAÑANA sin plan):
//   A. Con 0127/0135 (lo que corría): Paula llega hoy 23:59 sin carro → el acomodo
//      le arma una vuelta que sale 00:xx de MAÑANA → mañana «parece publicado» →
//      «no tiene carro» a todos los de mañana, el acomodo les arma vueltas sueltas
//      y un pedido nuevo de mañana también. (La prueba exige que el código viejo
//      FALLE así: si no, no está probando nada.)
//   B. Con 0141: lo mismo, pero mañana sigue sin plan: 0 avisos, 0 vueltas, el
//      pedido nuevo no se toca. Paula sí se acomoda (hoy sí está publicado).
//   C. Con 0141, la madrugada pegada por Julián (pool, manual_day = hoy, sale 00:30
//      de mañana) tampoco publica mañana.
//   D. Con 0141, mañana CON plan de verdad (vuelta del tablero con conductor):
//      el «no tiene carro» sí avisa y el pedido nuevo sí entra solo (0127/0135 igual).
//   E. Las huellas: lo de antes de 0141 es idéntico a producción; el down vuelve a ellas.
//
// NO cubre: la pantalla, la push de verdad, el pg_cron de verdad (se llama la
// función a mano), ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async (sig) => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig]))?.h || null;
const DET = 'public.detect_late_bookings()', RR = 'public.reubicar_reserva(uuid,timestamptz,text)';
// Producción y dev el 26-oct-2026 a las 4:30 p. m. (las mismas en los dos).
const PROD = { det: 'cfd8c22d60b87b40561568fdb6073cbc', rr: '5a62cc628808a4aedb03855f42a3e40f' };

const hora = (await one(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int h`)).h;
if (hora >= 21) { console.log('Correr antes de las 9 p. m. (la llegada de las 11:59 p. m. tiene que estar por delante).'); process.exit(2); }

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0127_aviso_sin_carro_espera', '0128_aviso_vuelta_terminada',
    '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta',
    '0134_reubicar_al_cambiar', '0135_acomodar_eventualidades', '0136_aviso_vuelta_iniciada']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const antes = { det: await huella(DET), rr: await huella(RR) };
  check('lo de antes de 0141 es idéntico a producción (detector de 0127, reubicar de 0135)', antes.det === PROD.det && antes.rr === PROD.rr, antes);

  await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);   // armar el día de prueba sin que el disparador actúe
  const fx = await fixtures(c);
  const JUAN = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [await user(c, fx.org, 'driver', 'Juan Ospina prueba')])).id;
  const jefe = await user(c, fx.org, 'admin', 'Christian prueba');
  const COORD = { [fx.olivar]: [6.1523, -75.3781], [fx.llano]: [6.1175, -75.4152] };
  let n = 0;
  const trip = async (name, resid) => {
    const u = await user(c, fx.org, 'auxiliar', `${name} ${++n}`);
    return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, resid])).id, resid };
  };
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, h) => `${d}T${h}:00-05:00`;
  const res = async (X, dir, whenIso) => {
    const [lat, lng] = COORD[X.resid];
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes)
      VALUES ($1, $2, $3, $4::timestamptz, 'Rionegro', $5, $6, $7, $8) RETURNING id`,
      [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, lat, lng, X.resid,
        dir === 'lle' ? 'Vuelo AV9563.' : null])).id;
  };
  const vuelta = async (dp, dir, startIso, rid, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, pool, organization_id, manual_day)
      VALUES ($1, $2, 'planned', $3::timestamptz, 'Carro 1', $4, $5, $6::date) RETURNING id`,
      [dp, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', startIso, !!extra.pool, fx.org, extra.dia || null])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, rid]);
    return ra;
  };
  // Pasa el tiempo: las anotaciones y las vueltas «envejecen» (now() no corre dentro de la transacción).
  const pasan = async (min) => {
    await q(`UPDATE public.late_booking_candidates SET created_at = created_at - make_interval(mins => $1)`, [min]);
    await q(`UPDATE public.route_assignments SET created_at = created_at - make_interval(mins => $1)`, [min]);
  };
  const dosPasadas = async () => { await pasan(10); await q(`SELECT public.detect_late_bookings()`); await pasan(10); await q(`SELECT public.detect_late_bookings()`); };
  const barrer = async () => (await one(`SELECT public.acomodar_eventualidades() r`)).r;
  const abierta = async (rid) => !!(await one(`SELECT 1 FROM public.incidents WHERE reservation_id = $1 AND category = 'late_booking' AND NOT coalesce((details->>'auto')::boolean, false)`, [rid]));
  const vueltaDe = async (rid) => one(`SELECT ra.id, ra.auto_created, ra.manual_day::text dia, (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date::text cal
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1 AND ra.status IN ('planned','in_progress')`, [rid]);
  const enSavepoint = async (fn) => { await c.query('SAVEPOINT sp'); try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sp'); } };

  // HOY publicado (tablero, con conductor). MAÑANA sin nada.
  const A = await trip('Ana', fx.olivar), P = await trip('Paula', fx.llano);
  const Y1 = await trip('Sebastian', fx.olivar), Y2 = await trip('Josmar', fx.llano), Z = await trip('Jennifer', fx.olivar), M = await trip('Moisés', fx.llano);
  const rA = await res(A, 'sal', at(hoy, '23:30'));
  await vuelta(JUAN, 'sal', at(hoy, '22:40'), rA);
  const rP = await res(P, 'lle', at(hoy, '23:59'));
  const rY1 = await res(Y1, 'sal', at(man, '10:00')), rY2 = await res(Y2, 'lle', at(man, '15:00'));

  // El escenario de hoy. Devuelve lo que pasó con los de mañana.
  const escenario = async () => {
    await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await dosPasadas();
    const pAviso = await abierta(rP);
    const r1 = await barrer();
    const vP = await vueltaDe(rP);
    await dosPasadas();
    const avisosMan = (await abierta(rY1) ? 1 : 0) + (await abierta(rY2) ? 1 : 0);
    const r2 = await barrer();
    const vueltasMan = (await vueltaDe(rY1) ? 1 : 0) + (await vueltaDe(rY2) ? 1 : 0);
    await q(`SELECT set_config('rendio.no_acomodar', '', true)`);
    const rZ = await res(Z, 'sal', at(man, '12:00'));
    const zEntro = !!(await vueltaDe(rZ));
    return { pAviso, vP, avisosMan, vueltasMan, zEntro, r1, r2 };
  };

  // A. Lo que corría (0127 + 0135): tiene que reproducir la cascada.
  const viejo = await enSavepoint(escenario);
  check('A. (código viejo) Paula, sin carro hoy, avisa', viejo.pAviso, viejo);
  check('A. (código viejo) su vuelta automática sale el día de MAÑANA por calendario, con manual_day = hoy',
    viejo.vP && viejo.vP.auto_created && viejo.vP.cal === man && viejo.vP.dia === hoy, viejo.vP);
  check('A. (código viejo) reproduce la cascada: avisa a los 2 de mañana, les arma vuelta y el pedido nuevo entra solo',
    viejo.avisosMan === 2 && viejo.vueltasMan === 2 && viejo.zEntro, viejo);

  // B. Con 0141.
  await c.query(strip('../supabase/migrations/0141_sin_carro_dia_del_plan.sql'));
  await c.query(strip('../supabase/migrations/0141_sin_carro_dia_del_plan.sql'));
  check('0141 se aplica encima de 0136 (y se puede volver a correr)', true);
  const nuevo = await enSavepoint(escenario);
  check('B. Paula (hoy SÍ está publicado) avisa igual', nuevo.pAviso, nuevo);
  check('B. y el sistema la acomoda igual (vuelta automática, día del plan = hoy)', nuevo.vP && nuevo.vP.auto_created && nuevo.vP.dia === hoy, nuevo.vP);
  check('B. mañana sigue sin plan: 0 «no tiene carro» para los de mañana', nuevo.avisosMan === 0, nuevo);
  check('B. 0 vueltas sueltas armadas para mañana', nuevo.vueltasMan === 0, nuevo);
  check('B. el pedido nuevo de mañana no se toca (entra cuando se publique)', nuevo.zEntro === false, nuevo);
  check('B. nada quedó anotado de mañana en late_booking_candidates', (await enSavepoint(async () => { await escenario();
    return (await one(`SELECT count(*)::int n FROM public.late_booking_candidates WHERE reservation_id = ANY($1)`, [[rY1, rY2]])).n; })) === 0);

  // C. La madrugada pegada por Julián (manual_day = hoy, sale 00:30 de mañana) no publica mañana.
  const pegada = await enSavepoint(async () => {
    const rM = await res(M, 'sal', at(man, '00:55'));
    await vuelta(null, 'sal', at(man, '00:30'), rM, { pool: true, dia: hoy });
    await dosPasadas();
    return { y: (await abierta(rY1) ? 1 : 0) + (await abierta(rY2) ? 1 : 0), dia: (await one(`SELECT public.dia_del_plan($1::date, $2::timestamptz)::text d`, [hoy, at(man, '00:30')])).d };
  });
  check('C. la madrugada pegada cuenta para el día de su plan (hoy), no para mañana', pegada.dia === hoy, pegada);
  check('C. y no hace sonar a los de mañana', pegada.y === 0, pegada);

  // D. Mañana CON plan de verdad: todo funciona como antes.
  const real = await enSavepoint(async () => {
    const B = await trip('Beto', fx.olivar);
    const rB = await res(B, 'sal', at(man, '06:30'));
    await vuelta(JUAN, 'sal', at(man, '05:45'), rB);
    await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await dosPasadas();
    const avisos = (await abierta(rY1) ? 1 : 0) + (await abierta(rY2) ? 1 : 0);
    await q(`SELECT set_config('rendio.no_acomodar', '', true)`);
    const rZ = await res(Z, 'sal', at(man, '12:00'));
    return { avisos, zEntro: !!(await vueltaDe(rZ)) };
  });
  check('D. mañana publicado por el tablero: «no tiene carro» sí avisa a los 2', real.avisos === 2, real);
  check('D. y el pedido nuevo de mañana sí entra solo', real.zEntro, real);
  // Una vuelta DELEGADA (0126) de mañana también publica el día.
  const deleg = await enSavepoint(async () => {
    const B = await trip('Beto', fx.olivar);
    const rB = await res(B, 'sal', at(man, '06:30'));
    const ra = await vuelta(null, 'sal', at(man, '05:45'), rB);
    await q(`UPDATE public.route_assignments SET delegated_at = now() WHERE id = $1`, [ra]);
    await dosPasadas();
    return (await abierta(rY1) ? 1 : 0) + (await abierta(rY2) ? 1 : 0);
  }).catch((e) => ({ error: e.message }));
  check('D. una vuelta delegada de mañana también cuenta como publicado', deleg === 2, deleg);

  // E. Permisos y el down.
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.dia_del_plan(date, timestamptz)', 'EXECUTE') a,
    has_function_privilege('anon', 'public.dia_del_plan(date, timestamptz)', 'EXECUTE') b,
    has_function_privilege('authenticated', '${RR}', 'EXECUTE') c2, has_function_privilege('service_role', '${DET}', 'EXECUTE') d`);
  check('permisos: dia_del_plan y reubicar_reserva cerradas a anon/authenticated; el detector abierto a service_role', !perm.a && !perm.b && !perm.c2 && perm.d, perm);
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0141_sin_carro_dia_del_plan.down.sql'));
  const tras = { det: await huella(DET), rr: await huella(RR), dia: await one(`SELECT to_regprocedure('public.dia_del_plan(date,timestamptz)') IS NULL AS ok`) };
  check('E. el down vuelve exactamente a lo de producción y quita dia_del_plan', tras.det === PROD.det && tras.rr === PROD.rr && tras.dia.ok, tras);
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok}/${ok + fail} ${fail ? '✗' : '✓'}`);
process.exit(fail ? 1 : 0);
