// 0117 · Los avisos a los jefes salen del servidor y send-push deja de mandar a cualquiera.
//
//   cd rendio-backend/scripts && node _verify-0117.mjs                 (base LOCAL)
//   set -a; source ../.env.dev; set +a; node _verify-0117.mjs --dev    (base de DEV)
//
// Todo dentro de una transacción que se deshace: aplica 0117, arma sus propias
// filas (una organización de prueba con sus jefes, Laura, Carlos y su carro) y
// comprueba
//   · el conductor reporta una falla → queda UN aviso en la bandeja para el jefe
//     marcado de SU organización, con «🚨 Falla mecánica», el carro, su nombre y
//     el del tripulante; notified_at sellado;
//   · sin nadie marcado en la organización → a todos sus jefes activos, aunque en
//     otra organización sí haya marcados; nunca al inactivo ni al de otra;
//   · el botón rojo del tripulante → «🚨 Emergencia de Laura Gómez» / «Novedad de…»;
//   · lo que reporta el jefe y lo de flota (inicio/cierre de turno) NO suenan;
//   · si encolar falla, el reporte se guarda igual (y notified_at queda vacío);
//   · los detectores siguen igual, y llamar dos veces no duplica;
//   · «Cambió mi vuelo» sigue diciendo a cuántos avisó, sin aviso doble;
//   · cancelar le encola el aviso al conductor;
//   · push_allowed_recipients: el jefe a su organización; conductor y tripulante a
//     sí mismos, a los jefes y a la otra punta de un traslado o cambio de turno
//     vigente — y lo que devuelven el chat y Coordinación pasa entero;
//   · permisos: nadie de la app llama a enqueue_incident_alert.
//
// NO CUBRE: send-push y dispatch-notifications de verdad (Deno, VAPID, el
// teléfono): aquí solo se prueba lo que queda en la bandeja y la regla que
// send-push le pregunta a la base.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const DEV = process.argv.includes('--dev');
async function conectar() {
  if (!DEV) return localClient();
  const DEV_REF = 'lxlphbafhtphulanhzlp';
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
  const cli = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
    user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
  await cli.connect();
  return cli;
}

const c = await conectar();
c.on('notice', () => {}); // el RAISE WARNING del disparador roto (punto 6) es a propósito
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + JSON.stringify(det) : ''}`); } };
const mismo = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
const SQL = readFileSync(new URL('../supabase/migrations/0117_avisos_desde_el_servidor.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

// Corre `sql` como `quien`/`rol`; devuelve [filas, mensaje de error].
const como = async (quien, rol, sql, params) => {
  await c.query('SAVEPOINT s');
  try {
    await asUser(c, quien, rol);
    const r = await q(sql, params);
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return [r, null];
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return [null, e.message]; }
};
const bandeja = (incId) => q(`SELECT profile_id::text, title, body, url, dedupe_key, sent_at, attempts
  FROM public.notification_outbox WHERE incident_id = $1 ORDER BY title, profile_id`, [incId]);
const permitidos = async (quien, rol, ids) => {
  const [r, e] = await como(quien, rol, `SELECT public.push_allowed_recipients($1::uuid[])::text[] AS a`, [ids]);
  if (e) throw new Error('push_allowed_recipients: ' + e);
  return r[0].a || [];
};

console.log(`0117 contra la base ${DEV ? 'de DEV' : 'LOCAL'} (todo se deshace al final)`);
await c.query('BEGIN');
try {
  await c.query(SQL);
  const fx = await fixtures(c); // Laura Gómez (tripulante), su vecina, Carlos Mejía (conductor), el carro P-01
  const julian = await user(c, fx.org, 'admin', 'Julián Prueba Ríos 0117');
  const daniela = await user(c, fx.org, 'admin', 'Daniela Prueba 0117');
  const inactivo = await user(c, fx.org, 'admin', 'Admin Inactivo 0117');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id IN ($1, $2)`, [julian, inactivo]);
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [inactivo]);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug)
    VALUES ('Otra 0117', 'otra-0117-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const intruso = await user(c, otraOrg, 'admin', 'Jefe De Otra 0117');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [intruso]);
  const pedroU = await user(c, fx.org, 'driver', 'Pedro Otro 0117');
  const pedro = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [pedroU])).id;

  const reserva = async (aux, horas = 3) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude)
    VALUES ($1, 'home_to_airport', 'requested', now() + make_interval(hours => $2::int), 'PRUEBA 0117', 6.1523, -75.3781)
    RETURNING id`, [aux, horas])).id;
  const ruta = async (driver, resIds) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '2 hours') RETURNING id`, [driver, fx.vehicle])).id;
    for (const [i, r] of resIds.entries()) {
      await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, $3)`, [ra, r, i + 1]);
    }
    return ra;
  };
  const resL = await reserva(fx.aux);         // la de Laura, publicada con Carlos
  const raL = await ruta(fx.driver, [resL]);
  const resSin = await reserva(fx.aux, 30);   // otra de Laura, sin plan todavía
  // Carlos en turno con el P-01: report_incident le adjunta el carro solo.
  await q(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status) VALUES ($1, $2, $3, 'vehicle_selected')`,
    [fx.org, fx.driver, fx.vehicle]);

  console.log('\n1. Carlos (conductor) reporta una falla mecánica grave');
  let [rows, err] = await como(fx.drvUser, 'driver',
    `SELECT public.report_incident('vehicle_problem', 'El carro no prende', 'high', $1) AS id`, [resL]);
  const inc1 = rows && rows[0].id;
  check('el reporte se guarda', !!inc1, err);
  let b = await bandeja(inc1);
  check('queda UN aviso, para Julián (el único marcado y activo de la organización)', b.length === 1 && b[0].profile_id === julian, b.map(x => x.profile_id));
  check('…ni a Daniela (sin marcar), ni al jefe inactivo, ni al de otra organización', !b.some(x => [daniela, inactivo, intruso].includes(x.profile_id)));
  check('título «🚨 Falla mecánica»', b[0] && b[0].title === '🚨 Falla mecánica', b[0] && b[0].title);
  check('cuerpo con el carro, quién reporta y el tripulante', b[0] && b[0].body === 'P-01 · Carlos Mejía: El carro no prende (Laura)', b[0] && b[0].body);
  check('al tocarlo abre esa eventualidad', b[0] && b[0].url === '/#/eventualidades?ev=' + inc1, b[0] && b[0].url);
  check('llave inc:<id>:<jefe> (la misma de los detectores)', b[0] && b[0].dedupe_key === `inc:${inc1}:${julian}`, b[0] && b[0].dedupe_key);
  check('queda pendiente para dispatch-notifications (sin enviar, 0 intentos)', b[0] && b[0].sent_at === null && b[0].attempts === 0);
  check('notified_at sellado', !!(await one(`SELECT notified_at FROM public.incidents WHERE id = $1`, [inc1])).notified_at);

  console.log('\n2. Nadie marcado en la organización');
  await q(`UPDATE public.profiles SET receives_ops_alerts = false WHERE id IN ($1, $2)`, [julian, inactivo]);
  [rows, err] = await como(fx.drvUser, 'driver',
    `SELECT public.report_incident('traffic', 'Trancón en la glorieta', 'medium', $1) AS id`, [resL]);
  b = await bandeja(rows && rows[0].id);
  check('le suena a todos los jefes activos de la organización (Julián y Daniela)', mismo(b.map(x => x.profile_id), [julian, daniela]), b.map(x => x.profile_id) || err);
  check('…aunque en otra organización sí haya marcados (no se queda muda)', b.length === 2);
  check('…y nunca al inactivo ni al de otra organización', !b.some(x => [inactivo, intruso].includes(x.profile_id)));
  check('no grave: «Trancón reportado» sin 🚨', b.every(x => x.title === 'Trancón reportado'), b.map(x => x.title));
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [julian]);

  [rows, err] = await como(fx.drvUser, 'driver',
    `SELECT public.report_incident('wrong_address', 'No veo la portería', 'medium', NULL) AS id`);
  b = await bandeja(rows && rows[0].id);
  check('«No encuentra la dirección» (antes caía en «Novedad en la operación»)', b.length === 1 && b[0].title === 'No encuentra la dirección'
    && b[0].body === 'P-01 · Carlos Mejía: No veo la portería', b[0] || err);

  console.log('\n3. El botón rojo de Laura (tripulante)');
  [rows, err] = await como(fx.auxUser, 'auxiliar',
    `SELECT public.report_incident('aux_emergency', 'Me siento en riesgo — Va muy rápido', 'high', $1, '{"motivo":"inseguro"}'::jsonb) AS id`, [resL]);
  b = await bandeja(rows && rows[0].id);
  check('grave: «🚨 Emergencia de Laura Gómez», a Julián', b.length === 1 && b[0].profile_id === julian && b[0].title === '🚨 Emergencia de Laura Gómez', b[0] || err);
  check('…el cuerpo es lo que eligió, sin repetir su nombre', b[0] && b[0].body === 'Me siento en riesgo — Va muy rápido', b[0] && b[0].body);
  [rows, err] = await como(fx.auxUser, 'auxiliar',
    `SELECT public.report_incident('aux_emergency', 'Estoy esperando mi equipaje', 'medium', $1) AS id`, [resL]);
  b = await bandeja(rows && rows[0].id);
  check('no grave: «Novedad de Laura Gómez»', b.length === 1 && b[0].title === 'Novedad de Laura Gómez', b[0] || err);

  console.log('\n4. Lo que NO suena');
  [rows, err] = await como(julian, 'admin',
    `SELECT public.report_incident('other', 'Nota del jefe', 'medium', $1) AS id`, [resL]);
  const incJefe = rows && rows[0].id;
  check('lo que reporta el jefe no le suena a nadie (es él mismo)', !!incJefe && (await bandeja(incJefe)).length === 0, err);
  check('…y su notified_at queda vacío', incJefe && (await one(`SELECT notified_at FROM public.incidents WHERE id = $1`, [incJefe])).notified_at === null);
  const flota = (await one(`INSERT INTO public.incidents (organization_id, reporter_id, vehicle_id, category, severity, description)
    VALUES ($1, $2, $3, 'vehicle_problem', 'high', 'Golpe en la puerta (cierre de turno)') RETURNING id`, [fx.org, fx.drvUser, fx.vehicle])).id;
  check('lo de flota (inicio/cierre de turno, scope flota) tampoco', (await bandeja(flota)).length === 0);

  console.log('\n5. Los detectores siguen igual');
  const sys = (await one(`INSERT INTO public.incidents (organization_id, vehicle_id, category, severity, status, description, scope, source, dedupe_key, occurred_at)
    VALUES ($1, $2, 'driver_late', 'high', 'open', 'va 25 min atrasado', 'operacion', 'system', 'risk:prueba-0117', now()) RETURNING id`, [fx.org, fx.vehicle])).id;
  check('una del sistema no la encola el disparador (la encola su detector)', (await bandeja(sys)).length === 0);
  const e1 = (await one(`SELECT public.enqueue_incident_alert($1) AS n`, [sys])).n;
  const e2 = (await one(`SELECT public.enqueue_incident_alert($1) AS n`, [sys])).n;
  b = await bandeja(sys);
  check('el detector la encola: «🚨 Un carro va muy atrasado» a Julián', e1 === 1 && b.length === 1 && b[0].title === '🚨 Un carro va muy atrasado' && b[0].body === 'P-01 · va 25 min atrasado', { e1, b });
  check('llamarla otra vez da el mismo número y no duplica', e2 === 1 && b.length === 1, { e2, n: b.length });

  console.log('\n6. Si encolar falla, el reporte no se pierde');
  await c.query('SAVEPOINT rompe');
  await c.query(`CREATE OR REPLACE FUNCTION public.enqueue_incident_alert(p_incident_id uuid) RETURNS integer
    LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'bandeja caída'; END $f$`);
  [rows, err] = await como(fx.drvUser, 'driver',
    `SELECT public.report_incident('vehicle_problem', 'Llanta pinchada', 'medium', $1) AS id`, [resL]);
  const incRoto = rows && rows[0].id;
  check('el reporte se guarda igual', !!incRoto, err);
  check('…y notified_at queda vacío: se ve que no avisó', incRoto && (await one(`SELECT notified_at FROM public.incidents WHERE id = $1`, [incRoto])).notified_at === null);
  await c.query('ROLLBACK TO SAVEPOINT rompe');

  console.log('\n7. «Cambió mi vuelo» (reporta y encola: 0093)');
  [rows, err] = await como(fx.auxUser, 'auxiliar',
    `SELECT public.auxiliar_change_flight($1, 'AV9412', now() + interval '5 hours') AS r`, [resL]);
  const cf = rows && rows[0].r;
  check('publicado → pasa por los jefes', cf && cf.mode === 'needs_ops', cf || err);
  check('…y sigue diciendo a cuántos avisó (1), aunque el disparador ya lo había encolado', cf && cf.notified === 1, cf);
  b = await bandeja(cf && cf.incident_id);
  check('…un solo aviso, con su título de vuelo', b.length === 1 && b[0].title === 'Vuelo retrasado: hay que mover una recogida', b);

  console.log('\n8. send-push: a quién se le puede mandar (push_allowed_recipients)');
  const fantasma = '00000000-0000-4000-8000-000000000117';
  let a = await permitidos(julian, 'admin', [fx.auxUser, fx.drvUser, intruso, fantasma]);
  check('el jefe: a los de su organización (no al de otra, no a un id que no existe)', mismo(a, [fx.auxUser, fx.drvUser]), a);
  a = await permitidos(inactivo, 'admin', [fx.auxUser, julian]);
  check('un jefe desactivado no manda nada', a.length === 0, a);
  const todos = [fx.drvUser, julian, daniela, inactivo, fx.auxUser, fx.vecinoUser, pedroU, intruso];
  a = await permitidos(fx.drvUser, 'driver', todos);
  check('Carlos: a sí mismo, a los jefes activos y a Laura (va en su ruta)', mismo(a, [fx.drvUser, julian, daniela, fx.auxUser]), a);
  check('…no a la vecina (no va en su ruta), ni a otro conductor, ni al jefe inactivo, ni al de otra organización',
    !a.includes(fx.vecinoUser) && !a.includes(pedroU) && !a.includes(inactivo) && !a.includes(intruso));
  a = await permitidos(fx.auxUser, 'auxiliar', [fx.drvUser, pedroU, fx.vecinoUser, julian, fx.auxUser]);
  check('Laura: a su conductor, a los jefes y a sí misma (la prueba)', mismo(a, [fx.drvUser, julian, fx.auxUser]), a);
  a = await permitidos(fx.vecinoUser, 'auxiliar', [fx.drvUser, fx.auxUser]);
  check('la vecina (sin traslado con Carlos): ni a Carlos ni a Laura', a.length === 0, a);
  a = await permitidos(fx.drvUser, 'driver', []);
  check('lista vacía → nada', a.length === 0);
  let errAnon = null;
  await c.query('SAVEPOINT anon');
  try {
    await c.query(`SET LOCAL ROLE anon`);
    await c.query(`SELECT public.push_allowed_recipients(ARRAY[$1]::uuid[])`, [julian]);
  } catch (e) { errAnon = e.message; }
  await c.query('ROLLBACK TO SAVEPOINT anon'); await asAdminDb(c);
  check('anon no la puede llamar', !!errAnon && /permission denied/i.test(errAnon), errAnon);

  console.log('\n   …el chat del traslado y Coordinación no se rompen');
  [rows, err] = await como(fx.drvUser, 'driver', `SELECT public.send_reservation_message($1, 'Ya llegué, estoy afuera') AS r`, [resL]);
  let to = rows && rows[0].r.recipient_profile_ids;
  a = await permitidos(fx.drvUser, 'driver', to || []);
  check('chat Carlos → Laura: lo que devuelve el chat pasa entero', !!to && to.length === 1 && mismo(a, to), { to, a, err });
  [rows, err] = await como(fx.auxUser, 'auxiliar', `SELECT public.send_reservation_message($1, 'Ya bajo') AS r`, [resL]);
  to = rows && rows[0].r.recipient_profile_ids;
  a = await permitidos(fx.auxUser, 'auxiliar', to || []);
  check('chat Laura → Carlos: pasa entero', !!to && mismo(to, [fx.drvUser]) && mismo(a, to), { to, a, err });
  [rows, err] = await como(fx.auxUser, 'auxiliar', `SELECT public.send_reservation_message($1, 'Mi vuelo cambió') AS r`, [resSin]);
  to = (rows && rows[0].r.recipient_profile_ids) || [];
  a = await permitidos(fx.auxUser, 'auxiliar', to);
  check('chat sin conductor → a los jefes: los de su organización pasan (Julián)', rows && rows[0].r.to_admins === true && a.includes(julian), { to, a, err });
  check('…y si la lista trajera jefes de otra organización, esos no', a.every(id => [julian, daniela].includes(id)), a);
  [rows, err] = await como(fx.auxUser, 'auxiliar', `SELECT public.crew_send_message('Hola, una pregunta') AS r`);
  to = (rows && rows[0].r.recipient_profile_ids) || [];
  a = await permitidos(fx.auxUser, 'auxiliar', to);
  check('Coordinación Laura → jefes: pasa entero', to.length > 0 && mismo(a, to), { to, a, err });
  [rows, err] = await como(julian, 'admin', `SELECT public.crew_send_message('Ya te llamamos', $1) AS r`, [fx.aux]);
  to = (rows && rows[0].r.recipient_profile_ids) || [];
  a = await permitidos(julian, 'admin', to);
  check('Coordinación jefe → Laura: pasa entero', mismo(to, [fx.auxUser]) && mismo(a, to), { to, a, err });

  console.log('\n   …lo vigente');
  await q(`UPDATE public.route_assignments SET planned_start_at = now() - interval '30 hours' WHERE id = $1`, [raL]);
  a = await permitidos(fx.drvUser, 'driver', [fx.auxUser]);
  const a2 = await permitidos(fx.auxUser, 'auxiliar', [fx.drvUser]);
  check('ruta de hace más de 24 h (nadie las cierra): ya no se avisan entre ellos', a.length === 0 && a2.length === 0, { a, a2 });
  await q(`UPDATE public.route_assignments SET planned_start_at = now() + interval '2 hours' WHERE id = $1`, [raL]);
  const sw = (await one(`INSERT INTO public.shift_swaps (requester_id, target_id, week_start_date, from_day, from_shift, to_day, to_shift)
    VALUES ($1, $2, current_date, 0, 'am', 1, 'pm') RETURNING id`, [fx.drvUser, pedroU])).id;
  a = await permitidos(fx.drvUser, 'driver', [pedroU]);
  const a3 = await permitidos(pedroU, 'driver', [fx.drvUser]);
  check('cambio de turno recién propuesto: Carlos → Pedro y Pedro → Carlos', mismo(a, [pedroU]) && mismo(a3, [fx.drvUser]), { a, a3 });
  await q(`DELETE FROM public.shift_swaps WHERE id = $1`, [sw]);
  await q(`INSERT INTO public.shift_swaps (requester_id, target_id, week_start_date, from_day, from_shift, to_day, to_shift, created_at, updated_at)
    VALUES ($1, $2, current_date - 7, 0, 'am', 1, 'pm', now() - interval '3 days', now() - interval '3 days')`, [fx.drvUser, pedroU]);
  a = await permitidos(fx.drvUser, 'driver', [pedroU]);
  check('uno de hace 3 días ya no habilita', a.length === 0, a);

  console.log('\n9. Laura cancela: el aviso a Carlos sale de la base');
  [rows, err] = await como(fx.auxUser, 'auxiliar', `SELECT public.auxiliar_cancel_reservation($1, 'Cambio de programación') AS r`, [resL]);
  const rc = rows && rows[0].r;
  check('cancela y dice a quién avisó', rc && rc.ok === true && rc.driver_profile_id === fx.drvUser && rc.driver_notified === true, rc || err);
  const avisoC = await q(`SELECT profile_id::text, title, body, url FROM public.notification_outbox WHERE dedupe_key = $1`, [`cancel:${resL}:${fx.drvUser}`]);
  check('en la bandeja: «Traslado cancelado» para Carlos', avisoC.length === 1 && avisoC[0].profile_id === fx.drvUser && avisoC[0].title === 'Traslado cancelado'
    && avisoC[0].body === 'Laura canceló su traslado. Ya no está en tu ruta.' && avisoC[0].url === '/', avisoC);
  a = await permitidos(fx.auxUser, 'auxiliar', [fx.drvUser]);
  check('…y desde el celular ya no podría (la parada se borró): por eso va por la bandeja', a.length === 0, a);
  [rows, err] = await como(fx.auxUser, 'auxiliar', `SELECT public.auxiliar_cancel_reservation($1, NULL) AS r`, [resSin]);
  const rs = rows && rows[0].r;
  check('sin plan publicado no hay conductor a quién avisar', rs && rs.driver_profile_id === null && rs.driver_notified === false
    && (await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [`cancel:${resSin}:%`])).length === 0, rs || err);

  console.log('\n10. Piezas y permisos');
  const tg = await one(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tr_incidents_avisar_jefes' AND tgrelid = 'public.incidents'::regclass`);
  check('el disparador está y está prendido', tg && tg.tgenabled === 'O', tg);
  const priv = await one(`SELECT
      has_function_privilege('authenticated', 'public.enqueue_incident_alert(uuid)', 'execute') AS enq_auth,
      has_function_privilege('anon', 'public.enqueue_incident_alert(uuid)', 'execute') AS enq_anon,
      has_function_privilege('authenticated', 'public.ops_alert_recipients_of(uuid)', 'execute') AS rec_auth,
      has_function_privilege('authenticated', 'public.push_allowed_recipients(uuid[])', 'execute') AS pa_auth,
      has_function_privilege('anon', 'public.push_allowed_recipients(uuid[])', 'execute') AS pa_anon`);
  check('nadie de la app puede encolar avisos a mano (antes cualquiera podía re-disparar una eventualidad)', !priv.enq_auth && !priv.enq_anon, priv);
  check('ni leer la lista de jefes', !priv.rec_auth, priv);
  check('push_allowed_recipients: sí para quien tiene sesión, no para anon', priv.pa_auth && !priv.pa_anon, priv);
  await q(`SELECT set_config('request.jwt.claims', '', true)`);
  const sinSesion = (await one(`SELECT public.push_allowed_recipients(ARRAY[$1]::uuid[])::text[] AS a`, [julian])).a;
  check('sin sesión (auth.uid() vacío) → nadie', Array.isArray(sinSesion) && sinSesion.length === 0, sinSesion);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗ (todo se deshizo: la base ${DEV ? 'de dev' : 'local'} quedó igual)`);
console.log('NO cubre: send-push ni dispatch-notifications de verdad (Deno, VAPID, el teléfono que suena).');
process.exit(fail ? 1 : 0);
