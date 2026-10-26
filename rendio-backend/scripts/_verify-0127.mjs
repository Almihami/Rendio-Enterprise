// Verificación de 0127 («X no tiene carro» ya no suena mientras el jefe
// re-publica) contra la base LOCAL (127.0.0.1:54322). Todo va dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0127.mjs
//
// El escenario es el del lunes 26-oct-2026, 9:00 a. m.: un día con una vuelta ya
// en curso y 59 reservas en 37 vueltas; el jefe vuelve a publicar desde
// Asignación, que hace lo mismo que saveRoutePlan (api.js): BORRA las vueltas que
// no han arrancado y las vuelve a crear una por una (la vuelta y después sus
// paradas: 1 + 37 × 2 = 75 pasos). El reloj puede caer entre cualquier par de
// pasos, así que se prueban los 76 puntos de corte.
//
//   1. Con el detector de HOY (0068, el de producción) se reproduce la tormenta:
//      59 eventualidades y 177 push (59 × 3 jefes) si el reloj cae justo después
//      del borrado.
//   2. Con 0127: en los 76 cortes, 0 eventualidades y 0 push; la pasada
//      siguiente (5 min después) tampoco; el disparador limpia la anotación en
//      cuanto la reserva entra a su vuelta.
//   3. Una reserva que DE VERDAD quedó sin carro sí avisa, en la pasada
//      siguiente, una sola vez, a los 3 jefes; y se cierra sola al acomodarla.
//   4. …también si en medio hubo una re-publicación.
//   5. Dos re-publicaciones seguidas con el reloj cayendo en medio de las dos.
//   6. Una publicación lenta (más de 4 min): no suena mientras se publica; la
//      que de verdad quedó por fuera avisa cuando termina.
//   7. La anotación se olvida si cancelan la reserva o el día queda sin plan.
//   8. Permisos, idempotencia, reversa (devuelve la huella exacta de antes).
//   9. Con 0125 (vuelta pegada, pool) y una columna delegated_at como la de 0126.
//
// El reloj se simula: dentro de una transacción now() no avanza, así que «pasan
// 5 minutos» = correr hacia atrás created_at de las anotaciones y de las vueltas
// del día.
//
// NO cubre: pg_cron de verdad, la push de verdad (send-push), la pantalla de
// Asignación (se replican sus pasos, no se corre el navegador), ni dev/producción.
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
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async () => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE proname = 'detect_late_bookings'`)).h;
const tieneCol = async (col) => (await one(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = $1) ok`, [col])).ok;
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
const H68 = 'a10a56bb5b6187f67b328f9c0191effa';   // detect_late_bookings de 0068 (la de producción el 26-oct)

// ── Qué bloquea aplicar 0127 (en su propia transacción, que se deshace) ───────
console.log('\n0. Qué bloquea aplicarla');
await c.query('BEGIN');
try {
  await c.query(strip('../supabase/migrations/0127_aviso_sin_carro_espera.sql'));
  const locks = await q(`SELECT relation::regclass::text rel, mode FROM pg_locks
    WHERE pid = pg_backend_pid() AND locktype = 'relation'
      AND relation IN ('public.reservations'::regclass, 'public.route_stops'::regclass, 'public.route_assignments'::regclass,
                       'public.incidents'::regclass, 'public.notification_outbox'::regclass, 'public.profiles'::regclass)`);
  check('de las tablas de la operación solo toma route_stops, con un candado que no frena lecturas (ShareRowExclusive)',
    locks.length === 1 && locks[0].rel === 'route_stops' && locks[0].mode === 'ShareRowExclusiveLock', locks);
} finally { await c.query('ROLLBACK'); }

await c.query('BEGIN');
try {
  // La prueba deja cambios de esquema abiertos ~30 s. El pg_cron de la base local
  // corre el detector cada 5 min y lee estas tablas: si cae en medio, Postgres
  // corta por bloqueo mutuo. Tomándolas todas de entrada, el reloj solo espera.
  await c.query(`LOCK TABLE public.reservations, public.route_stops, public.route_assignments, public.incidents,
    public.notification_outbox, public.shifts, public.profiles IN ACCESS EXCLUSIVE MODE`);
  // ── La base como producción: 0117 (avisos por organización) y 0124 ──────────
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await tieneCol('plan_car'))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  console.log('\n   La base de partida');
  check('el detector es el de 0068 (el de producción)', (await huella()) === H68, await huella());

  const fx = await fixtures(c);
  const jefes = [];
  for (const n of ['Christian prueba 0127', 'Camilo prueba 0127', 'Julián prueba 0127']) jefes.push(await user(c, fx.org, 'admin', n));
  const nJefes = (await one(`SELECT count(*)::int n FROM public.ops_alert_recipients_of($1)`, [fx.org])).n;
  check('3 jefes reciben los avisos de operación', nJefes === 3, nJefes);
  const drv2u = await user(c, fx.org, 'driver', 'Juan Andrés prueba 0127');
  const DRV = [fx.driver, (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [drv2u])).id];

  // El día: el de dentro de 4 horas (Bogotá); las horas, repartidas dentro de la
  // ventana del detector (más de 1 h y menos de 35 h) y dentro de ese día.
  const t0 = await one(`WITH d AS (SELECT ((now() + interval '4 hours') AT TIME ZONE 'America/Bogota')::date dia)
    SELECT dia::text dia,
           greatest(now() + interval '1 hour', (dia + time '00:30') AT TIME ZONE 'America/Bogota') ini,
           least((dia + time '23:30') AT TIME ZONE 'America/Bogota', now() + interval '35 hours') fin FROM d`);
  const DIA = t0.dia, d0 = DIA + 'T00:00:00-05:00', d1 = DIA + 'T23:59:59-05:00';
  const ini = new Date(t0.ini).getTime(), fin = new Date(t0.fin).getTime();
  const hora = (i, total) => new Date(ini + (fin - ini) * (i + 1) / (total + 1)).toISOString();
  const N = 59, TOTAL = N + 3;
  let nTrip = 0;
  const reserva = async (when) => {
    const u = await user(c, fx.org, 'auxiliar', `Tripulante ${++nTrip} prueba 0127`);
    const a = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id;
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at,
        pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'PRUEBA 0127', 6.1523, -75.3781, $3) RETURNING id`, [a, when, fx.olivar])).id;
  };

  // La vuelta que ya arrancó (no se borra al re-publicar): mantiene el día «publicado».
  const R0 = await reserva(hora(0, TOTAL));
  const enCurso = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
    VALUES ($1, $2, 'home_to_airport', 'in_progress', $3::timestamptz - interval '5 minutes') RETURNING id`, [DRV[0], fx.vehicle, hora(0, TOTAL)])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status) VALUES ($1, $2, 1, 'picked_up')`, [enCurso, R0]);

  // 59 reservas en 37 vueltas (22 de dos y 15 de una), como el lunes.
  const S = [];
  for (let i = 0; i < N; i++) S.push({ id: await reserva(hora(i + 1, TOTAL)), at: hora(i + 1, TOTAL) });
  const lanes = [];
  for (let i = 0, j = 0; j < 37; j++) {
    const n = j < 22 ? 2 : 1, st = S.slice(i, i + n); i += n;
    lanes.push({ dp: DRV[j % 2], stops: st.map((s) => s.id), startAt: new Date(new Date(st[0].at).getTime() - 10 * 60000).toISOString() });
  }
  const tAt = hora(N + 1, TOTAL), t2At = hora(N + 2, TOTAL);
  const MIAS = [R0, ...S.map((s) => s.id)];

  // Lo que hace saveRoutePlan al publicar, paso por paso (cada paso = una petición).
  const conPool = async () => tieneCol('pool');
  const pasosPublicar = async () => {
    const pool = await conPool();
    const pasos = [async () => {
      const arr = (await q(`SELECT ra.id FROM public.route_assignments ra
        WHERE ra.planned_start_at BETWEEN $1 AND $2
          AND (ra.status IN ('in_progress', 'completed')
               OR EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = ra.id AND s.status <> 'pending'))`, [d0, d1])).map((r) => r.id);
      await q(`DELETE FROM public.route_assignments WHERE status IN ('draft', 'planned')
        AND planned_start_at BETWEEN $1 AND $2 ${pool ? 'AND pool = false' : ''} AND NOT (id = ANY ($3::uuid[]))`, [d0, d1, arr]);
    }];
    let raId;
    for (const l of lanes) {
      pasos.push(async () => { raId = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
        VALUES ($1, $2, 'home_to_airport', 'planned', $3) RETURNING id`, [l.dp, fx.vehicle, l.startAt])).id; });
      pasos.push(async () => { await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order)
        SELECT $1, r, o FROM unnest($2::uuid[]) WITH ORDINALITY AS t(r, o)`, [raId, l.stops]); });
    }
    return pasos;
  };
  const publicar = async (desde = 0, hasta = Infinity, pasos = null) => {
    pasos = pasos || await pasosPublicar();
    for (let k = desde; k < Math.min(hasta, pasos.length); k++) await pasos[k]();
    return pasos;
  };
  const PASOS = 1 + lanes.length * 2;

  const pasada = async () => (await one(`SELECT public.detect_late_bookings() n`)).n;
  const hayTabla = async () => (await one(`SELECT to_regclass('public.late_booking_candidates') IS NOT NULL ok`)).ok;
  const conteo = async (ids = MIAS) => {
    const r = await one(`SELECT
      (SELECT count(*)::int FROM public.incidents WHERE category = 'late_booking' AND reservation_id = ANY ($1)) inc,
      (SELECT count(*)::int FROM public.notification_outbox o JOIN public.incidents i ON i.id = o.incident_id
        WHERE i.category = 'late_booking' AND i.reservation_id = ANY ($1)) push`, [ids]);
    r.anot = (await hayTabla()) ? (await one(`SELECT count(*)::int n FROM public.late_booking_candidates WHERE reservation_id = ANY ($1)`, [ids])).n : null;
    return r;
  };
  // «Pasan N minutos»: todo lo anotado y todas las vueltas del día se corren hacia atrás.
  const pasan = async (min) => {
    if (await hayTabla()) await q(`UPDATE public.late_booking_candidates SET created_at = created_at - make_interval(mins => $1)`, [min]);
    await q(`UPDATE public.route_assignments SET created_at = created_at - make_interval(mins => $1)
      WHERE planned_start_at BETWEEN $2 AND $3`, [min, d0, d1]);
  };
  const enSavepoint = async (fn) => { await c.query('SAVEPOINT sp_e'); try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sp_e'); } };

  await publicar();          // el plan del día, ya publicado…
  await pasan(60);           // …hace una hora

  // ── 1. El detector de hoy: la tormenta ──────────────────────────────────────
  console.log('\n1. Con el detector de HOY (0068): el jefe re-publica y el reloj cae en medio');
  await pasada();
  check('con el plan completo no abre nada', (await conteo()).inc === 0);
  const curva = [];
  for (let k = 0; k <= PASOS; k++) curva.push(await enSavepoint(async () => { await publicar(0, k); await pasada(); return conteo(); }));
  const peor = curva.reduce((m, r, k) => (r.inc > curva[m].inc ? k : m), 0);
  check('se reproduce la tormenta: justo después del borrado, 59 eventualidades', curva[1].inc === 59, curva[1]);
  check('…y 177 push (59 × 3 jefes), como el lunes', curva[1].push === 177, curva[1]);
  console.log(`    avisos falsos según dónde cae el reloj: antes de empezar ${curva[0].inc} · tras borrar ${curva[1].inc} · a mitad (paso ${PASOS >> 1}) ${curva[PASOS >> 1].inc} · al final ${curva[PASOS].inc}; peor = paso ${peor}; ${curva.filter((r) => r.inc > 0).length} de ${PASOS + 1} cortes suenan`);

  // ── 2. Con 0127 ─────────────────────────────────────────────────────────────
  console.log('\n2. Con 0127, en los mismos 76 cortes');
  await c.query('SAVEPOINT sin0125');
  await c.query(strip('../supabase/migrations/0127_aviso_sin_carro_espera.sql'));
  await c.query(strip('../supabase/migrations/0127_aviso_sin_carro_espera.sql'));
  check('0127 se aplica (y se puede volver a correr)', true);
  const H127 = await huella();
  check('el detector cambió', H127 !== H68);
  const trig = await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'tr_route_stops_late_booking_reset' AND tgrelid = 'public.route_stops'::regclass`);
  check('el disparador de route_stops existe (una sola vez)', trig.n === 1, trig.n);
  const job = await one(`SELECT command FROM cron.job WHERE jobname = 'detect-ops-events'`);
  check('el reloj no cambió: sigue llamando a los dos detectores', !!job && /detect_ops_events\(\).*detect_late_bookings\(\)/.test(job.command), job && job.command);

  await pasada();
  const r0 = await conteo();
  check('primera pasada con el plan completo: nada abierto ni anotado', r0.inc === 0 && r0.anot === 0, r0);

  const corte = [];
  for (let k = 0; k <= PASOS; k++) corte.push(await enSavepoint(async () => {
    const pasos = await publicar(0, k);
    await pasada();
    const enMedio = await conteo();
    await publicar(k, Infinity, pasos);
    const alTerminar = await conteo();
    await pasan(5);
    await pasada();
    return { enMedio, alTerminar, despues: await conteo() };
  }));
  check('en los 76 cortes: 0 eventualidades y 0 push en la pasada que cae en medio',
    corte.every((r) => r.enMedio.inc === 0 && r.enMedio.push === 0), corte.map((r, k) => [k, r.enMedio.inc]).filter(([, n]) => n));
  check('el detector sí las vio: tras el borrado anotó las 59 (espera, no ignora)', corte[1].enMedio.anot === 59, corte[1].enMedio);
  check('al terminar de publicar, el disparador ya las borró todas (sin esperar al reloj)',
    corte.every((r) => r.alTerminar.anot === 0), corte.map((r, k) => [k, r.alTerminar.anot]).filter(([, n]) => n));
  check('la pasada siguiente (5 min después): 0 eventualidades, 0 push, 0 anotadas',
    corte.every((r) => r.despues.inc === 0 && r.despues.push === 0 && r.despues.anot === 0), corte.map((r, k) => [k, r.despues]).filter(([, x]) => x.inc || x.anot));

  console.log('\n   Permisos');
  await asUser(c, jefes[0], 'admin');
  const e1 = await debeFallar(`SELECT count(*) FROM public.late_booking_candidates`);
  const e2 = await debeFallar(`SELECT public.detect_late_bookings()`);
  await asDb();
  check('un jefe (authenticated) no puede leer las anotaciones', !!e1 && /permission denied/i.test(e1.message), e1 && e1.message);
  check('ni correr el detector', !!e2 && /permission denied/i.test(e2.message), e2 && e2.message);

  // ── 3. La que de verdad quedó sin carro ─────────────────────────────────────
  console.log('\n3. Una reserva que DE VERDAD quedó sin carro');
  await enSavepoint(async () => {
    const T = await reserva(tAt);
    await pasada();
    let r = await conteo([T]);
    check('primera pasada: todavía no avisa, la anota', r.inc === 0 && r.anot === 1, r);
    await pasan(5);
    await pasada();
    r = await conteo([T]);
    check('pasada siguiente (5 min): abre UNA eventualidad', r.inc === 1, r);
    check('…con un push a cada uno de los 3 jefes', r.push === 3, r);
    const inc = await one(`SELECT id, severity, description, source, notified_at,
        (EXTRACT(EPOCH FROM ($2::timestamptz - now())) / 3600) < 6 AS grave
      FROM public.incidents WHERE reservation_id = $1 AND category = 'late_booking'`, [T, tAt]);
    check('el mismo texto de siempre («no tiene carro»), del sistema, con notified_at',
      /no tiene carro: el plan del día ya está publicado/.test(inc.description) && inc.source === 'system' && !!inc.notified_at, inc);
    check(`la gravedad de siempre (${inc.grave ? 'grave: faltan menos de 6 h' : 'media: faltan 6 h o más'})`, inc.severity === (inc.grave ? 'high' : 'medium'), inc.severity);
    console.log(`    texto: "${inc.description}"`);
    await pasada(); await pasan(5); await pasada();
    r = await conteo([T]);
    check('dos pasadas más: no repite (1 eventualidad, 3 push)', r.inc === 1 && r.push === 3, r);
    // La acomodan en una vuelta.
    const ra = (await one(`SELECT id FROM public.route_assignments WHERE planned_start_at BETWEEN $1 AND $2 AND status = 'planned' ORDER BY planned_start_at DESC LIMIT 1`, [d0, d1])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 4)`, [ra, T]);
    check('al entrar a la vuelta, la anotación se borra en el acto', (await conteo([T])).anot === 0);
    await pasada();
    const cerr = await one(`SELECT status, resolution_notes FROM public.incidents WHERE id = $1`, [inc.id]);
    check('y la eventualidad se cierra sola en la pasada siguiente', cerr.status === 'resolved' && /ya quedó en una ruta/.test(cerr.resolution_notes), cerr);
  });

  // ── 4. …aunque en medio se haya re-publicado ───────────────────────────────
  console.log('\n4. La que quedó por fuera avisa aunque en medio el jefe re-publique');
  await enSavepoint(async () => {
    const T = await reserva(tAt);
    const pasos = await publicar(0, 1);          // borra…
    await pasada();                              // …el reloj cae aquí
    let r = await conteo([...MIAS, T]);
    check('en medio: 0 avisos, 60 anotadas (las 59 + la de verdad)', r.inc === 0 && r.anot === 60, r);
    await publicar(1, Infinity, pasos);
    r = await conteo([...MIAS, T]);
    check('al terminar de publicar solo queda anotada la que no entró', r.anot === 1 && (await conteo([T])).anot === 1, r);
    await pasan(5);
    await pasada();
    check('pasada siguiente: avisa SOLO por ella (1 eventualidad, 3 push)', JSON.stringify(await conteo([T])) === JSON.stringify({ inc: 1, push: 3, anot: 1 }), await conteo([T]));
    check('…y por ninguna de las 59', (await conteo()).inc === 0);
  });

  // ── 5. Dos re-publicaciones seguidas, el reloj en medio de las dos ──────────
  console.log('\n5. Dos re-publicaciones seguidas con el reloj cayendo en medio de ambas');
  for (const k2 of [1, 2, 3, PASOS >> 1]) await enSavepoint(async () => {
    const p1 = await publicar(0, 1); await pasada(); await publicar(1, Infinity, p1);
    await pasan(5);
    const p2 = await publicar(0, k2); await pasada();
    const r = await conteo();
    check(`la segunda cae en el paso ${k2}${k2 === 1 ? ' (recién borrado: no hay ninguna vuelta nueva)' : ''}: 0 avisos`, r.inc === 0 && r.push === 0, r);
    await publicar(k2, Infinity, p2); await pasan(5); await pasada();
    const r2 = await conteo();
    if (k2 === 1) check('y la pasada siguiente tampoco; nada anotado', r2.inc === 0 && r2.anot === 0, r2);
  });

  // ── 6. Publicación lenta ───────────────────────────────────────────────────
  console.log('\n6. Una publicación lenta (más de 4 minutos)');
  await enSavepoint(async () => {
    const T = await reserva(tAt);
    const pasos = await publicar(0, 1); await pasada();          // pasada A: tras el borrado
    await publicar(1, 21, pasos);                                // 10 vueltas…
    await pasan(5);                                              // …y se demora
    await publicar(21, 23, pasos);                               // otra vuelta, recién creada
    await pasada();                                              // pasada B: sigue publicando
    let r = await conteo([...MIAS, T]);
    check('pasada B (5 min después, todavía publicando): 0 avisos, ni la de verdad', r.inc === 0, r);
    check('…aunque las que faltan ya llevan 5 min anotadas', (await conteo(lanes.slice(11).flatMap((l) => l.stops))).anot === lanes.slice(11).reduce((n, l) => n + l.stops.length, 0));
    await publicar(23, Infinity, pasos);
    await pasan(3);                                              // terminó hace 3 min
    await pasada();
    r = await conteo([T]);
    check('terminó hace 3 min: ahora sí avisa por la que quedó por fuera (1 · 3 push)', r.inc === 1 && r.push === 3, r);
    check('…y por ninguna de las 59', (await conteo()).inc === 0);
  });

  // ── 7. La anotación se olvida ──────────────────────────────────────────────
  console.log('\n7. La anotación se olvida sola');
  await enSavepoint(async () => {
    const T = await reserva(tAt), T2 = await reserva(t2At);
    await pasada();
    check('las dos quedan anotadas', (await conteo([T, T2])).anot === 2);
    await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [T]);
    await pasan(5); await pasada();
    let r = await conteo([T]);
    check('si la cancelan: se borra y no avisa', r.anot === 0 && r.inc === 0, r);
    check('(la otra sí avisó: sigue sin carro)', (await conteo([T2])).inc === 1);
  });
  await enSavepoint(async () => {
    const T = await reserva(tAt);
    await pasada();
    await q(`DELETE FROM public.route_assignments WHERE planned_start_at BETWEEN $1 AND $2`, [d0, d1]);
    await pasan(5); await pasada();
    const r = await conteo([T]);
    check('si el día queda sin plan (se quitan todas las vueltas): se borra y no avisa', r.anot === 0 && r.inc === 0, r);
  });
  await enSavepoint(async () => {
    const T = await reserva(tAt);
    await pasada();
    await q(`DELETE FROM public.reservations WHERE id = $1`, [T]);
    check('si BORRAN la reserva: se puede (no hay FK) y la anotación queda huérfana…', (await conteo([T])).anot === 1);
    await pasada();
    check('…hasta la pasada siguiente, que la borra', (await conteo([T])).anot === 0);
  });

  // ── 8. Reversa ──────────────────────────────────────────────────────────────
  console.log('\n8. La reversa');
  await c.query(strip('../down_migrations/0127_aviso_sin_carro_espera.down.sql'));
  check('devuelve el detector EXACTO de 0068 (misma huella)', (await huella()) === H68, await huella());
  const quedan = await one(`SELECT to_regclass('public.late_booking_candidates') t,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_route_stops_late_booking_reset') g,
    to_regprocedure('public.late_booking_candidates_reset()') f`);
  check('quita la tabla, el disparador y su función', !quedan.t && quedan.g === 0 && !quedan.f, quedan);
  await c.query(strip('../supabase/migrations/0127_aviso_sin_carro_espera.sql'));
  check('y 0127 se puede volver a aplicar después', (await huella()) === H127);
  await c.query('ROLLBACK TO SAVEPOINT sin0125');

  // ── 9. Con 0125 (pegada) y delegated_at (como 0126) ────────────────────────
  console.log('\n9. Encima de 0125 (la ruta de Julián) y con delegated_at como la de 0126');
  await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  const H125 = await huella();
  await c.query(strip('../supabase/migrations/0127_aviso_sin_carro_espera.sql'));
  check('0127 se aplica encima de 0125', (await huella()) === H127);
  const corte125 = [];
  for (const k of [0, 1, 2, 3, PASOS >> 1, PASOS]) corte125.push(await enSavepoint(async () => {
    const pasos = await publicar(0, k); await pasada(); const m = await conteo();
    await publicar(k, Infinity, pasos); await pasan(5); await pasada();
    return [m, await conteo()];
  }));
  check('re-publicar (con el filtro pool de saveRoutePlan): 0 avisos en medio ni después', corte125.every(([m, d]) => m.inc === 0 && d.inc === 0 && d.anot === 0), corte125);
  const soloUna = async (cols, vals) => {
    await q(`DELETE FROM public.route_assignments WHERE planned_start_at BETWEEN $1 AND $2`, [d0, d1]);
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, ${cols})
      VALUES ('home_to_airport', 'planned', $1, ${vals.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING id`, [lanes[0].startAt, ...vals])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, S[0].id]);
    await pasan(60);
  };
  await enSavepoint(async () => {
    await soloUna('pool, organization_id', [true, fx.org]);
    const T = await reserva(tAt);
    await pasada(); await pasan(5); await pasada();
    check('un día publicado SOLO con una vuelta pegada (pool) cuenta: avisa en la 2.ª pasada', (await conteo([T])).inc === 1, await conteo([T]));
  });
  await enSavepoint(async () => {
    await soloUna('pool', [false]);
    const T = await reserva(tAt);
    await pasada(); await pasan(5); await pasada();
    const r = await conteo([T]);
    check('una vuelta sin conductor que no es pegada (borrador) no cuenta como publicada', r.inc === 0 && r.anot === 0, r);
  });
  await enSavepoint(async () => {
    await q(`ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS delegated_at timestamptz`);
    await soloUna('pool, delegated_at', [false, new Date().toISOString()]);
    const T = await reserva(tAt);
    await pasada(); await pasan(5); await pasada();
    check('con delegated_at (0126): un día publicado solo con una vuelta delegada cuenta', (await conteo([T])).inc === 1, await conteo([T]));
  });
  await enSavepoint(async () => {
    await c.query(strip('../down_migrations/0127_aviso_sin_carro_espera.down.sql'));
    check('la reversa encima de 0125 devuelve EXACTO el detector de 0125', (await huella()) === H125, await huella());
  });
  await enSavepoint(async () => {
    await q(`ALTER TABLE public.route_assignments ADD COLUMN IF NOT EXISTS delegated_at timestamptz`);
    await c.query(strip('../down_migrations/0127_aviso_sin_carro_espera.down.sql'));
    // Huella de la copia de 0126 (rama feat/delegado-0126, c18d4eb), calculada en la base local.
    check('…y con delegated_at, EXACTO el de 0126 (pegada + delegada)', (await huella()) === 'cb66e2e1e4c5c9d7dea16867ca8264e8', await huella());
  });
} finally {
  await c.query('ROLLBACK');
}

console.log('\n10. Nada quedó escrito');
const resto = await one(`SELECT (SELECT count(*)::int FROM public.reservations WHERE pickup_address = 'PRUEBA 0127') reservas,
  to_regclass('public.late_booking_candidates') tabla, (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'detect_late_bookings') h`);
check('sin reservas de prueba', resto.reservas === 0, resto.reservas);
check('la base local sigue sin 0127 (detector de 0068, sin tabla)', !resto.tabla && resto.h === H68, resto);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
await c.end();
process.exit(fail === 0 ? 0 : 1);
