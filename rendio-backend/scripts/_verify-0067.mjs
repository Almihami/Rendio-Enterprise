// Verificación de 0067 (el jefe entra al hilo del traslado).
//
// Todo el escenario se monta DENTRO DE UNA TRANSACCIÓN QUE SE DESHACE: no deja
// una sola fila. Se prueba suplantando a cada participante con set_config de
// request.jwt.claims, que es de donde salen auth.uid() y current_user_role().
//
//   set -a; source .env.dev; set +a; node scripts/_verify-0067.mjs
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

// Suplanta a alguien: es lo que hace PostgREST con el JWT de la sesión. El rol
// NO se pone en el claim a propósito — así current_user_role() cae al fallback
// que lee profiles, que es el camino real de esta app (0010).
const comoUsuario = async (profileId) => {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: profileId, role: 'authenticated' })]);
};
const enviar = async (rid, texto) => (await q(`SELECT public.send_reservation_message($1,$2) AS r`, [rid, texto]))[0].r;

console.log('\n1. El schema quedó como toca');
const chk = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
  WHERE conname = 'reservation_messages_role_valid'`))[0];
check("el CHECK admite 'admin'", chk && /admin/.test(chk.d), chk ? chk.d : 'no existe');
const col = (await q(`SELECT data_type, is_nullable FROM information_schema.columns
  WHERE table_name='reservation_messages' AND column_name='read_by'`))[0];
check('la columna read_by existe', !!col, 'no existe');

console.log('\n2. Las tres puntas del hilo, con un traslado de prueba');
await c.query('BEGIN');
try {
  const aux = (await q(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap
    JOIN public.profiles p ON p.id = ap.profile_id WHERE p.deleted_at IS NULL LIMIT 1`))[0];
  const drv = (await q(`SELECT dp.id, dp.profile_id FROM public.driver_profiles dp
    JOIN public.profiles p ON p.id = dp.profile_id WHERE p.deleted_at IS NULL LIMIT 1`))[0];
  const adm = (await q(`SELECT id FROM public.profiles WHERE role='admin' AND deleted_at IS NULL LIMIT 1`))[0];
  const veh = (await q(`SELECT id FROM public.vehicles LIMIT 1`))[0];
  if (!aux || !drv || !adm) { console.error('faltan perfiles en dev para la prueba'); process.exit(2); }

  // Reserva SIN ruta todavía: es el caso que hoy revienta.
  const res = (await q(`
    INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a,
      pickup_address, pickup_latitude, pickup_longitude, required_arrival_at)
    VALUES ($1,'home_to_airport','requested','PRUEBA 0067', 6.15, -75.39, now() + interval '2 hours')
    RETURNING id`, [aux.id]))[0];

  console.log('\n  2a. El tripulante escribe y TODAVÍA NO HAY CARRO');
  await comoUsuario(aux.profile_id);
  let r = null, err = null;
  try { r = await enviar(res.id, 'Estoy en la portería 3, torre B'); } catch (e) { err = e.message; }
  check('el mensaje NO revienta por no haber conductor', !!r, err || 'sin resultado');
  if (r) {
    check("el rol quedó 'auxiliar'", r.sender_role === 'auxiliar', r.sender_role);
    check('el aviso se redirigió a los jefes', r.to_admins === true, JSON.stringify(r.to_admins));
    check('hay al menos un destinatario', (r.recipient_profile_ids || []).length > 0, JSON.stringify(r.recipient_profile_ids));
  }

  console.log('\n  2b. Ahora sí hay carro: el conductor entra al hilo');
  const ra = (await q(`
    INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
    VALUES ($1,$2,'home_to_airport','in_progress', now()) RETURNING id`, [drv.id, veh.id]))[0];
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status)
           VALUES ($1,$2,1,'pending')`, [ra.id, res.id]);

  await comoUsuario(drv.profile_id);
  const rd = await enviar(res.id, 'Voy llegando, 5 minutos');
  check("el conductor escribe con rol 'driver'", rd.sender_role === 'driver', rd.sender_role);
  check('le avisa al tripulante', (rd.recipient_profile_ids || [])[0] === aux.profile_id, JSON.stringify(rd.recipient_profile_ids));

  console.log('\n  2c. El jefe escribe — lo que antes era imposible');
  await comoUsuario(adm.id);
  const ra2 = await enviar(res.id, 'Hay trancón en la Variante, van 20 minutos tarde');
  check("el jefe escribe con rol 'admin'", ra2.sender_role === 'admin', ra2.sender_role);
  const dest = (ra2.recipient_profile_ids || []);
  check('le llega al tripulante Y al conductor', dest.length === 2
    && dest.includes(aux.profile_id) && dest.includes(drv.profile_id), JSON.stringify(dest));

  const hilo = await q(`SELECT sender_role, body FROM public.reservation_messages
    WHERE reservation_id=$1 ORDER BY created_at`, [res.id]);
  check('el hilo tiene los 3 mensajes en orden', hilo.length === 3
    && hilo.map(h => h.sender_role).join(',') === 'auxiliar,driver,admin',
    hilo.map(h => h.sender_role).join(','));

  console.log('\n  2d. Quien NO participa sigue afuera');
  const otro = (await q(`SELECT ap.profile_id FROM public.auxiliar_profiles ap
    WHERE ap.profile_id <> $1 LIMIT 1`, [aux.profile_id]))[0];
  if (otro) {
    // El RAISE del RPC aborta la transacción entera; con un savepoint se deshace
    // solo el intento fallido y la prueba puede seguir.
    await c.query('SAVEPOINT intruso');
    await comoUsuario(otro.profile_id);
    let bloqueado = false;
    try { await enviar(res.id, 'me colé'); } catch (e) { bloqueado = /No participas/.test(e.message); }
    await c.query('ROLLBACK TO SAVEPOINT intruso');
    check('un tripulante ajeno no puede escribir en este hilo', bloqueado);
  }

  console.log('\n3. "Leído" es por lector, no un solo interruptor');
  // El tripulante abre el hilo: lee lo del conductor y lo del jefe.
  await comoUsuario(aux.profile_id);
  const n1 = (await q(`SELECT public.mark_reservation_messages_read($1) AS n`, [res.id]))[0].n;
  check('el tripulante marcó 2 leídos', n1 === 2, `${n1}`);

  const delJefe = (await q(`SELECT read_at, read_by FROM public.reservation_messages
    WHERE reservation_id=$1 AND sender_role='admin'`, [res.id]))[0];
  check('el mensaje del jefe quedó leído por el tripulante',
    (delJefe.read_by || []).includes(aux.profile_id), JSON.stringify(delJefe.read_by));
  check('el conductor NO aparece como que lo leyó',
    !(delJefe.read_by || []).includes(drv.profile_id), JSON.stringify(delJefe.read_by));
  check('read_at quedó sellado (el primero que lo leyó)', !!delJefe.read_at);

  // Esto es lo que antes se rompía: el conductor abre y todavía tiene 1 sin leer.
  await comoUsuario(drv.profile_id);
  const n2 = (await q(`SELECT public.mark_reservation_messages_read($1) AS n`, [res.id]))[0].n;
  check('el conductor todavía tenía sin leer los suyos (auxiliar + jefe)', n2 === 2, `${n2}`);
  const delJefe2 = (await q(`SELECT read_by FROM public.reservation_messages
    WHERE reservation_id=$1 AND sender_role='admin'`, [res.id]))[0];
  check('ahora sí los leyeron los dos', (delJefe2.read_by || []).length === 2, JSON.stringify(delJefe2.read_by));

  console.log('\n4. El jefe lee pero NO marca leído');
  const antesJefe = (await q(`SELECT read_by FROM public.reservation_messages
    WHERE reservation_id=$1 AND sender_role='auxiliar'`, [res.id]))[0];
  await comoUsuario(adm.id);
  const n3 = (await q(`SELECT public.mark_reservation_messages_read($1) AS n`, [res.id]))[0].n;
  check('marcar leído desde el admin no toca nada', n3 === 0, `${n3}`);
  const despuesJefe = (await q(`SELECT read_by FROM public.reservation_messages
    WHERE reservation_id=$1 AND sender_role='auxiliar'`, [res.id]))[0];
  check('read_by del mensaje del tripulante quedó igual',
    JSON.stringify(antesJefe.read_by) === JSON.stringify(despuesJefe.read_by),
    JSON.stringify(despuesJefe.read_by));
} finally {
  await c.query('ROLLBACK');
  await c.query(`SELECT set_config('request.jwt.claims', '', false)`);
}

console.log('\n5. Nada quedó escrito');
const resto = (await q(`SELECT
  (SELECT count(*)::int FROM public.reservations WHERE pickup_address='PRUEBA 0067') AS reservas,
  (SELECT count(*)::int FROM public.reservation_messages WHERE sender_role='admin') AS del_jefe`))[0];
check('sin reservas de prueba', resto.reservas === 0, `${resto.reservas}`);
console.log(`    (mensajes de admin que quedan en dev: ${resto.del_jefe})`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
await c.end();
process.exit(fail === 0 ? 0 : 1);
