// Verificación de 0068 (la reserva que quedó sin carro).
//
// Todo el escenario va DENTRO DE UNA TRANSACCIÓN QUE SE DESHACE: no deja una
// sola fila. Se prueba lo que de verdad importa — que abra cuando debe, que NO
// abra cuando no debe, y que se cierre sola por los tres caminos.
//
//   set -a; source .env.dev; set +a; node scripts/_verify-0068.mjs
import pg from 'pg';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det ? ' → ' + det : ''}`); } };

console.log('\n1. Las piezas existen');
const fn = (await q(`SELECT proname FROM pg_proc WHERE proname = 'detect_late_bookings'`)).length;
check('la función detect_late_bookings existe', fn === 1);
const job = (await q(`SELECT command FROM cron.job WHERE jobname = 'detect-ops-events'`))[0];
check('el reloj de 5 min la llama', !!job && /detect_late_bookings/.test(job.command), job ? job.command : 'sin job');
check('y sigue llamando al detector de 0066', !!job && /detect_ops_events/.test(job.command));

console.log('\n2. El escenario, con un día que SÍ tiene plan publicado');
await c.query('BEGIN');
try {
  const aux = (await q(`SELECT ap.id FROM public.auxiliar_profiles ap
    JOIN public.profiles p ON p.id = ap.profile_id WHERE p.deleted_at IS NULL LIMIT 1`))[0];
  const drv = (await q(`SELECT id FROM public.driver_profiles LIMIT 1`))[0];
  const veh = (await q(`SELECT id FROM public.vehicles LIMIT 1`))[0];

  // El servicio es dentro de 4 horas (grave: ya no hay noche de por medio).
  const mkRes = async (horas, dir = 'home_to_airport') => (await q(`
    INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a,
      pickup_address, pickup_latitude, pickup_longitude, required_arrival_at)
    VALUES ($1,$2,'requested','PRUEBA 0068', 6.15, -75.39, now() + make_interval(hours => $3::int))
    RETURNING id`, [aux.id, dir, horas]))[0];

  console.log('\n  2a. Sin plan publicado NO debe avisar');
  const r0 = await mkRes(4);
  let n = (await q(`SELECT public.detect_late_bookings() AS n`))[0].n;
  const abierta0 = (await q(`SELECT count(*)::int n FROM public.incidents
    WHERE reservation_id = $1 AND category='late_booking' AND resolved_at IS NULL`, [r0.id]))[0].n;
  check('no abre eventualidad si el día no tiene plan', abierta0 === 0, `${abierta0} abiertas`);

  console.log('\n  2b. Con plan publicado SÍ avisa');
  // Plan publicado = una route_assignment de ESE día con conductor.
  const ra = (await q(`
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
    VALUES ($1,$2,'home_to_airport','planned',
      (SELECT required_arrival_at - interval '2 hours' FROM public.reservations WHERE id = $3))
    RETURNING id`, [drv.id, veh.id, r0.id]))[0];

  n = (await q(`SELECT public.detect_late_bookings() AS n`))[0].n;
  check('detectó la reserva sin carro', n >= 1, `devolvió ${n}`);
  const inc = (await q(`SELECT id, category, severity, status, description, source, reporter_id,
                               dedupe_key, notified_at, details
                        FROM public.incidents WHERE reservation_id = $1 AND category='late_booking'`, [r0.id]))[0];
  check('creó la eventualidad', !!inc, 'no apareció');
  if (inc) {
    check('la escribió el sistema, sin humano', inc.source === 'system' && inc.reporter_id === null);
    check('es GRAVE porque faltan menos de 6 h', inc.severity === 'high', inc.severity);
    check('el texto dice el problema real', /no tiene carro/.test(inc.description), inc.description);
    check('selló notified_at (encoló el aviso)', !!inc.notified_at);
    check('el dedupe va por reserva', inc.dedupe_key === 'late:' + r0.id, inc.dedupe_key);
    console.log(`    texto: "${inc.description}"`);
  }

  console.log('\n  2c. No duplica');
  await q(`SELECT public.detect_late_bookings()`);
  await q(`SELECT public.detect_late_bookings()`);
  const dup = (await q(`SELECT count(*)::int n FROM public.incidents
    WHERE reservation_id=$1 AND category='late_booking'`, [r0.id]))[0].n;
  check('correrlo 3 veces deja UNA sola', dup === 1, `${dup} filas`);
  const avisos = (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE incident_id=$1`, [inc.id]))[0].n;
  const dest = (await q(`SELECT count(*)::int n FROM public.ops_alert_recipients()`))[0].n;
  check('un aviso por destinatario, sin repetir', avisos === dest, `${avisos} avisos vs ${dest} destinatarios`);

  console.log('\n  2d. La severidad baja cuando hay tiempo');
  const r2 = await mkRes(20);
  await q(`UPDATE public.route_assignments SET planned_start_at =
             (SELECT required_arrival_at - interval '2 hours' FROM public.reservations WHERE id=$1)
           WHERE id=$2`, [r2.id, ra.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const inc2 = (await q(`SELECT severity FROM public.incidents WHERE reservation_id=$1`, [r2.id]))[0];
  check('con 20 h por delante es media, no grave', inc2 && inc2.severity === 'medium', inc2 ? inc2.severity : 'no abrió');

  console.log('\n3. Se cierra sola por los tres caminos');
  // (a) la acomodaron
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status)
           VALUES ($1,$2,99,'pending')`, [ra.id, r0.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const cerr1 = (await q(`SELECT status, resolved_at, resolution_notes FROM public.incidents WHERE id=$1`, [inc.id]))[0];
  check('(a) se cierra cuando entra a una ruta', cerr1.status === 'resolved' && !!cerr1.resolved_at, JSON.stringify(cerr1));
  console.log(`    nota: "${cerr1.resolution_notes}"`);

  // (b) la cancelaron
  const r3 = await mkRes(4);
  await q(`UPDATE public.route_assignments SET planned_start_at =
             (SELECT required_arrival_at - interval '2 hours' FROM public.reservations WHERE id=$1)
           WHERE id=$2`, [r3.id, ra.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const inc3 = (await q(`SELECT id FROM public.incidents WHERE reservation_id=$1`, [r3.id]))[0];
  check('abrió la de la reserva que después se cancela', !!inc3);
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id=$1`, [r3.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const cerr2 = (await q(`SELECT status, resolution_notes FROM public.incidents WHERE id=$1`, [inc3.id]))[0];
  check('(b) se cierra cuando cancelan la reserva', cerr2.status === 'resolved', JSON.stringify(cerr2));
  console.log(`    nota: "${cerr2.resolution_notes}"`);

  // (c) ya pasó la hora
  const r4 = await mkRes(4);
  await q(`UPDATE public.route_assignments SET planned_start_at =
             (SELECT required_arrival_at - interval '2 hours' FROM public.reservations WHERE id=$1)
           WHERE id=$2`, [r4.id, ra.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const inc4 = (await q(`SELECT id FROM public.incidents WHERE reservation_id=$1`, [r4.id]))[0];
  check('abrió la de la reserva que se va a vencer', !!inc4);
  await q(`UPDATE public.reservations SET required_arrival_at = now() - interval '10 minutes' WHERE id=$1`, [r4.id]);
  await q(`SELECT public.detect_late_bookings()`);
  const cerr3 = (await q(`SELECT status, resolution_notes FROM public.incidents WHERE id=$1`, [inc4.id]))[0];
  check('(c) se cierra cuando la hora ya pasó', cerr3.status === 'resolved', JSON.stringify(cerr3));
  console.log(`    nota: "${cerr3.resolution_notes}"`);

  console.log('\n4. Lo que NO debe hacer');
  const conEtiqueta = (await q(`SELECT count(*)::int n FROM public.incidents
    WHERE category = 'needs_third_vehicle' AND source = 'system'`))[0].n;
  check('la base NUNCA pone "necesita un tercer vehículo"', conEtiqueta === 0,
    `${conEtiqueta} — ese cálculo es del tablero, no de la BD`);
} finally {
  await c.query('ROLLBACK');
}

console.log('\n5. Nada quedó escrito');
const resto = (await q(`SELECT
  (SELECT count(*)::int FROM public.reservations WHERE pickup_address='PRUEBA 0068') AS reservas,
  (SELECT count(*)::int FROM public.incidents WHERE category='late_booking') AS eventualidades`))[0];
check('sin reservas de prueba', resto.reservas === 0, `${resto.reservas}`);
check('sin eventualidades de prueba', resto.eventualidades === 0, `${resto.eventualidades}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
await c.end();
process.exit(fail === 0 ? 0 : 1);
