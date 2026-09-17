// Verificación de 0066 (avisos de madrugada).
//
// El escenario de prueba se monta DENTRO DE UNA TRANSACCIÓN QUE SE DESHACE: no
// deja una sola fila en la base. Es la única forma honesta de probar detectores
// que dependen de rutas en curso cuando en dev no hay ninguna.
//
//   set -a; source .env.dev; set +a; node scripts/_verify-0066.mjs
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
const fns = (await q(`SELECT proname FROM pg_proc WHERE proname IN
  ('detect_ops_events','enqueue_incident_alert','drain_notification_outbox','ops_alert_health','ops_alert_recipients')`)).map(r => r.proname);
check('las 5 funciones', fns.length === 5, fns.join(', '));
const ext = (await q(`SELECT extname FROM pg_extension WHERE extname='pg_net'`)).length;
check('pg_net instalado', ext === 1);
const jobs = (await q(`SELECT jobname, schedule FROM cron.job WHERE jobname IN ('detect-ops-events','drain-notification-outbox') ORDER BY jobname`));
check('los 2 relojes programados', jobs.length === 2, JSON.stringify(jobs));
const st = (await q(`SELECT route_risk_incident_min, aux_noshow_alert_min, route_risk_threshold_min, aux_wait_minutes FROM public.app_settings WHERE id='singleton'`))[0];
check('parámetros nuevos en Ajustes', st.route_risk_incident_min != null && st.aux_noshow_alert_min != null, JSON.stringify(st));
check('el umbral de eventualidad es MAYOR que el de riesgo',
  st.route_risk_incident_min > st.route_risk_threshold_min,
  `incidente=${st.route_risk_incident_min} riesgo=${st.route_risk_threshold_min}`);

console.log('\n2. Hay a quién avisarle');
const dest = await q(`SELECT * FROM public.ops_alert_recipients()`);
check('la lista de destinatarios no está vacía', dest.length > 0, `${dest.length} admins`);
const marcados = (await q(`SELECT count(*)::int n FROM public.profiles WHERE role='admin' AND receives_ops_alerts`))[0].n;
console.log(`    (${marcados} marcados en Personal; con 0 marcados caen todos los admins — así no se queda muda)`);

console.log('\n3. El detector, con un escenario de prueba que se deshace al final');
await c.query('BEGIN');
try {
  const org = (await q(`SELECT id FROM public.organizations LIMIT 1`))[0];
  const aux = (await q(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap LIMIT 1`))[0];
  const veh = (await q(`SELECT id FROM public.vehicles LIMIT 1`))[0];
  const drv = (await q(`SELECT id FROM public.driver_profiles LIMIT 1`))[0];

  // Reserva + ruta EN CURSO + parada donde el carro ya llegó y nadie bajó.
  const res = (await q(`
    INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a,
      pickup_address, pickup_latitude, pickup_longitude, required_arrival_at)
    VALUES ($1,'home_to_airport','at_pickup','PRUEBA 0066', 6.15, -75.39, now() + interval '1 hour')
    RETURNING id`, [aux.id]))[0];
  const ra = (await q(`
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
    VALUES ($1,$2,'home_to_airport','in_progress', now() - interval '30 minutes') RETURNING id`, [drv.id, veh.id]))[0];
  const rs = (await q(`
    INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status, actual_arrival_at)
    VALUES ($1,$2,1,'arrived', now() - interval '30 minutes') RETURNING id`, [ra.id, res.id]))[0];

  const antes = (await q(`SELECT count(*)::int n FROM public.notification_outbox`))[0].n;
  const nuevas = (await q(`SELECT public.detect_ops_events() AS n`))[0].n;
  check('detectó el tripulante que no bajó', nuevas >= 1, `devolvió ${nuevas}`);

  const inc = (await q(`SELECT id, category, severity, description, dedupe_key, notified_at, source, reporter_id
                        FROM public.incidents WHERE route_stop_id = $1`, [rs.id]))[0];
  check('creó la eventualidad', !!inc, 'no apareció');
  if (inc) {
    check('categoría aux_not_ready', inc.category === 'aux_not_ready', inc.category);
    check('la escribió el sistema, sin humano', inc.source === 'system' && inc.reporter_id === null);
    check('el texto es entendible', /no ha bajado/.test(inc.description), inc.description);
    check('selló notified_at', !!inc.notified_at);
  }

  const enc = (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE incident_id = $1`, [inc?.id]))[0].n;
  check('encoló un aviso por destinatario', enc === dest.length, `${enc} avisos vs ${dest.length} destinatarios`);
  const av = (await q(`SELECT title, body, url FROM public.notification_outbox WHERE incident_id = $1 LIMIT 1`, [inc?.id]))[0];
  if (av) {
    check('el aviso lleva enlace a ESA eventualidad', av.url === '/#/eventualidades?ev=' + inc.id, av.url);
    console.log(`    título: "${av.title}"`);
    console.log(`    cuerpo: "${av.body}"`);
  }

  // Correrlo otra vez NO puede duplicar nada.
  await q(`SELECT public.detect_ops_events()`);
  const dup = (await q(`SELECT count(*)::int n FROM public.incidents WHERE route_stop_id = $1`, [rs.id]))[0].n;
  check('correrlo de nuevo no duplica la eventualidad', dup === 1, `${dup} filas`);
  const dupAv = (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE incident_id = $1`, [inc.id]))[0].n;
  check('ni duplica el aviso', dupAv === dest.length, `${dupAv} avisos`);

  // El tripulante sube → la eventualidad se cierra sola.
  await q(`UPDATE public.route_stops SET status='picked_up' WHERE id=$1`, [rs.id]);
  await q(`SELECT public.detect_ops_events()`);
  const cerrada = (await q(`SELECT status, resolved_at, resolution_notes FROM public.incidents WHERE id=$1`, [inc.id]))[0];
  check('se cierra sola cuando el tripulante sube', cerrada.status === 'resolved' && !!cerrada.resolved_at, JSON.stringify(cerrada));
  console.log(`    nota: "${cerrada.resolution_notes}"`);

  const salud = (await q(`SELECT public.ops_alert_health() AS h`))[0].h;
  check('ops_alert_health responde', !!salud && salud.pendientes != null, JSON.stringify(salud));
  console.log('    salud:', JSON.stringify(salud));

  console.log(`    (avisos en la bandeja durante la prueba: ${antes} → ${(await q(`SELECT count(*)::int n FROM public.notification_outbox`))[0].n})`);
} finally {
  await c.query('ROLLBACK');
}

console.log('\n4. Nada quedó escrito');
const resto = (await q(`SELECT
  (SELECT count(*)::int FROM public.reservations WHERE pickup_address='PRUEBA 0066') AS reservas,
  (SELECT count(*)::int FROM public.incidents WHERE source='system') AS incidentes_sistema,
  (SELECT count(*)::int FROM public.notification_outbox) AS avisos`))[0];
check('sin reservas de prueba', resto.reservas === 0, `${resto.reservas}`);
check('sin eventualidades del sistema', resto.incidentes_sistema === 0, `${resto.incidentes_sistema}`);
check('bandeja de salida vacía', resto.avisos === 0, `${resto.avisos}`);

console.log('\n5. El despacho (lo único que falta desplegar)');
const drain = (await q(`SELECT public.drain_notification_outbox() AS r`))[0].r;
console.log(`    drain_notification_outbox(): "${drain}"`);
check('el disparo responde sin reventar', typeof drain === 'string');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
await c.end();
process.exit(fail === 0 ? 0 : 1);
