// Verificación de 0104 («Olvidé mi contraseña»: un pedido a Coordinación) contra
// la base LOCAL (127.0.0.1:54322), con 0063/0066/0081 y 0104 aplicadas.
//
//   cd rendio-backend && node scripts/_verify-0104.mjs
//
// Todo corre dentro de UNA transacción que se deshace (cada llamada en su
// SAVEPOINT): no queda nada en la base. Nunca apunta a dev ni a producción
// (_local-fixtures se niega).
//
// Qué prueba:
//   0. Estructura: la función es SECURITY DEFINER con search_path fijo; anon y
//      authenticated la ejecutan, PUBLIC no; la tabla con RLS; anon sin ningún
//      permiso sobre la tabla; authenticated lee y solo actualiza `status`.
//   1. Contacto desconocido, mal escrito, vacío o null → la MISMA respuesta
//      neutra y nada en la base (ni pedido ni aviso).
//   2. Correo conocido (con mayúsculas y espacios), llamando como anon → la
//      respuesta neutra, UN pedido pendiente (contacto normalizado, la persona y
//      su organización) y UN aviso en la bandeja por jefe de su organización,
//      con el título, el cuerpo («Laura no puede entrar…») y el enlace a SU
//      pantalla (0110: tripulante → Rutas › Tripulantes; jefe/conductor → Personal).
//      Un jefe de OTRA organización no recibe nada.
//   3. Repetir en menos de 30 min (también por celular) → ni pedido ni aviso.
//   4. Celular (+57, espacios, guiones) contra profiles.phone → pedido.
//   5. Ya resuelto, se puede volver a pedir; tope de 5 al día por contacto.
//   6. Cuenta eliminada → nada.
//   7. RLS: el jefe lee los de su organización; el tripulante, el conductor y el
//      jefe de otra organización no ven nada; anon no puede ni leer.
//   8. El jefe marca «done»/«dismissed»: la base sella resolved_at y
//      resolved_by = el jefe (aunque el cliente no los mande); el tripulante no
//      puede; nadie cambia el contacto (permiso de columna).
//   9. admin_set_password (0081) cierra los pendientes de esa persona, con
//      resolved_by = el jefe que la restableció.
//  10. Un jefe que olvidó la suya no se avisa a sí mismo.
//
// NO cubre: PostgREST/supabase-js de verdad (que el parámetro p_contact llegue
// así; eso lo mira el smoke del login con un Api falso), el despacho del push
// (dispatch-notifications) ni la app.
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};

const c = await localClient();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// Pide como anon (el login no tiene sesión). Devuelve { v } o { err }.
async function pedir(contact) {
  await c.query('SAVEPOINT s');
  try {
    await c.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await c.query('SET LOCAL ROLE anon');
    const r = await one('SELECT public.request_password_reset($1) AS v', [contact]);
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return { v: r.v };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    await asAdminDb(c);
    return { err: e.message, code: e.code };
  }
}
// Corre `fn` como `uid` (rol authenticated) y vuelve a postgres.
async function como(uid, role, fn) {
  await c.query('SAVEPOINT s');
  try {
    await asUser(c, uid, role);
    const v = await fn();
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return { v };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    await asAdminDb(c);
    return { err: e.message, code: e.code };
  }
}
const NEUTRA = JSON.stringify({ ok: true });
const esNeutra = (r) => !!r && !r.err && JSON.stringify(r.v) === NEUTRA;

try {
  await c.query('BEGIN');
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de Prueba');
  const jefe2 = await user(c, fx.org, 'admin', 'Jefe Dos');
  // Otra organización con su jefe: no debe ver ni recibir nada.
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtra = await user(c, org2, 'admin', 'Jefe de Otra Org');
  // Destinatarios conocidos: ops_alert_recipients() mira a TODA la base (si
  // alguien está marcado, solo los marcados), así que se marcan los tres.
  await c.query('UPDATE public.profiles SET receives_ops_alerts = true WHERE id = ANY($1)', [[jefe, jefe2, jefeOtra]]);
  const correoAux = (await one('SELECT email FROM auth.users WHERE id = $1', [fx.auxUser])).email;
  await c.query(`UPDATE public.profiles SET phone = '+57 311 222 3344' WHERE id = $1`, [fx.vecinoUser]);
  await c.query(`UPDATE public.profiles SET phone = NULL WHERE id = $1`, [fx.auxUser]);
  const pedidos = async () => q(`SELECT * FROM public.password_reset_requests WHERE organization_id = ANY($1) ORDER BY created_at, id`, [[fx.org, org2]]);
  const avisos = async () => q(`SELECT * FROM public.notification_outbox WHERE dedupe_key LIKE 'pwreset:%' ORDER BY created_at, id`);

  console.log('\n── 0 · estructura ──');
  const f = await one(`SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS res
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'request_password_reset'`);
  check('existe public.request_password_reset(text) → jsonb', !!f && f.res === 'jsonb', f);
  check('es SECURITY DEFINER con search_path fijo', f && f.prosecdef === true && (f.proconfig || []).some(x => /search_path=public, pg_temp/.test(x)), f && f.proconfig);
  const priv = await one(`SELECT has_function_privilege('anon', 'public.request_password_reset(text)', 'EXECUTE') AS an,
    has_function_privilege('authenticated', 'public.request_password_reset(text)', 'EXECUTE') AS au`);
  check('anon y authenticated la pueden ejecutar (el login no tiene sesión)', priv.an === true && priv.au === true, priv);
  const pub = await one(`SELECT count(*)::int AS n FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'request_password_reset' AND grantee = 'PUBLIC'`);
  check('PUBLIC no tiene EXECUTE', pub.n === 0, pub);
  const rls = await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.password_reset_requests'::regclass`);
  check('la tabla tiene RLS encendida', rls.relrowsecurity === true);
  const tp = await one(`SELECT
      has_table_privilege('anon', 'public.password_reset_requests', 'SELECT') AS an_s,
      has_table_privilege('anon', 'public.password_reset_requests', 'INSERT') AS an_i,
      has_table_privilege('authenticated', 'public.password_reset_requests', 'SELECT') AS au_s,
      has_table_privilege('authenticated', 'public.password_reset_requests', 'INSERT') AS au_i,
      has_table_privilege('authenticated', 'public.password_reset_requests', 'DELETE') AS au_d,
      has_column_privilege('authenticated', 'public.password_reset_requests', 'status', 'UPDATE') AS au_u_status,
      has_column_privilege('authenticated', 'public.password_reset_requests', 'contact', 'UPDATE') AS au_u_contact,
      has_column_privilege('authenticated', 'public.password_reset_requests', 'resolved_by', 'UPDATE') AS au_u_by`);
  check('anon: ni leer ni insertar', tp.an_s === false && tp.an_i === false, tp);
  check('authenticated: lee, no inserta ni borra, y solo actualiza status',
    tp.au_s === true && tp.au_i === false && tp.au_d === false && tp.au_u_status === true && tp.au_u_contact === false && tp.au_u_by === false, tp);

  console.log('\n── 1 · desconocido o mal escrito: respuesta neutra y nada en la base ──');
  for (const x of ['nadie@prueba.local', 'NADIE@PRUEBA.LOCAL', '300 999 0000', '+57 300 999 0000', 'no-es-un-correo@', 'hola', '2001234567',
    '300abc4567', '', '   ', null, 'x'.repeat(300) + '@a.co']) {
    const r = await pedir(x);
    check(`${JSON.stringify(x && x.length > 40 ? x.slice(0, 20) + '…' : x)} → neutra`, esNeutra(r), r);
  }
  check('…y ningún pedido ni aviso', (await pedidos()).length === 0 && (await avisos()).length === 0);

  console.log('\n── 2 · correo conocido ──');
  let r = await pedir('  ' + correoAux.toUpperCase() + ' ');
  check('la respuesta es la MISMA neutra', esNeutra(r), r);
  let P = await pedidos();
  check('UN pedido pendiente de Laura, con el correo en minúsculas y su organización',
    P.length === 1 && P[0].profile_id === fx.auxUser && P[0].contact === correoAux.toLowerCase() && P[0].status === 'pending'
    && P[0].organization_id === fx.org && P[0].resolved_at === null && P[0].resolved_by === null, P);
  let A = await avisos();
  const para = A.map(a => a.profile_id).sort();
  check('un aviso por jefe de SU organización (los dos), ninguno al de la otra', A.length === 2 && JSON.stringify(para) === JSON.stringify([jefe, jefe2].sort()), A.map(a => a.profile_id));
  check('título «Pidieron restablecer una contraseña»', A.every(a => a.title === 'Pidieron restablecer una contraseña'), A.map(a => a.title));
  check('cuerpo «Laura no puede entrar. Restablécela desde Rutas › Tripulantes.» (0110)', A.every(a => a.body === 'Laura no puede entrar. Restablécela desde Rutas › Tripulantes.'), A.map(a => a.body));
  check('enlace a Tripulantes (0110) y sin enviar todavía', A.every(a => a.url === '/#/tripulantes' && a.sent_at === null && a.incident_id === null));

  console.log('\n── 3 · repetir en menos de 30 min ──');
  r = await pedir(correoAux);
  check('respuesta neutra', esNeutra(r), r);
  check('…sin pedido nuevo ni aviso nuevo', (await pedidos()).length === 1 && (await avisos()).length === 2);

  console.log('\n── 4 · por celular ──');
  r = await pedir('+57 311-222-3344');
  P = await pedidos();
  const pv = P.filter(p => p.profile_id === fx.vecinoUser);
  check('«+57 311-222-3344» encuentra a la vecina por profiles.phone («+57 311 222 3344»)', esNeutra(r) && pv.length === 1 && pv[0].contact === '3112223344', P.map(p => [p.profile_id, p.contact]));
  check('…y les avisa (2 avisos más)', (await avisos()).length === 4);
  r = await pedir('311 222 3344');
  check('el mismo celular otra vez, en menos de 30 min: nada nuevo', esNeutra(r) && (await pedidos()).length === 2);

  console.log('\n── 5 · ya resuelto se puede volver a pedir; tope de 5 al día ──');
  await c.query(`UPDATE public.password_reset_requests SET status = 'done' WHERE profile_id = $1`, [fx.vecinoUser]);
  r = await pedir('3112223344');
  check('resuelto el anterior, un pedido nuevo entra', esNeutra(r) && (await pedidos()).filter(p => p.profile_id === fx.vecinoUser).length === 2);
  // Cinco en las últimas 24 h para ese contacto (los de antes + relleno resuelto).
  await c.query(`UPDATE public.password_reset_requests SET status = 'done' WHERE profile_id = $1`, [fx.vecinoUser]);
  await c.query(`INSERT INTO public.password_reset_requests (organization_id, profile_id, contact, status, created_at)
    SELECT $1, $2, '3112223344', 'dismissed', now() - make_interval(hours => g) FROM generate_series(1, 3) g`, [fx.org, fx.vecinoUser]);
  const n5 = (await one(`SELECT count(*)::int n FROM public.password_reset_requests WHERE contact = '3112223344' AND created_at > now() - interval '1 day'`)).n;
  const av0 = (await avisos()).length;
  r = await pedir('3112223344');
  check(`con ${n5} en el día, el siguiente no entra ni avisa (respuesta neutra igual)`, n5 === 5 && esNeutra(r)
    && (await one(`SELECT count(*)::int n FROM public.password_reset_requests WHERE contact = '3112223344'`)).n === 5 && (await avisos()).length === av0);
  await c.query(`UPDATE public.password_reset_requests SET created_at = now() - interval '25 hours' WHERE contact = '3112223344'`);
  r = await pedir('3112223344');
  check('pasado el día, vuelve a entrar', esNeutra(r) && (await one(`SELECT count(*)::int n FROM public.password_reset_requests WHERE contact = '3112223344'`)).n === 6);

  console.log('\n── 6 · cuenta eliminada ──');
  const borrado = await user(c, fx.org, 'driver', 'Conductor Eliminado');
  await c.query(`UPDATE public.profiles SET deleted_at = now(), phone = '3207778899' WHERE id = $1`, [borrado]);
  const correoBorrado = (await one('SELECT email FROM auth.users WHERE id = $1', [borrado])).email;
  const antes6 = (await pedidos()).length;
  r = await pedir(correoBorrado);
  const r6b = await pedir('3207778899');
  check('ni por correo ni por celular: neutra y sin pedido', esNeutra(r) && esNeutra(r6b) && (await pedidos()).length === antes6);

  console.log('\n── 7 · quién los ve ──');
  const ver = (uid, role) => como(uid, role, async () => (await q(`SELECT id, organization_id FROM public.password_reset_requests`)).filter(x => x.organization_id === fx.org).length);
  const total = (await pedidos()).filter(p => p.organization_id === fx.org).length;
  let v = await ver(jefe, 'admin');
  check(`el jefe de la organización lee los ${total}`, v.v === total && total > 0, v);
  v = await ver(fx.auxUser, 'auxiliar');
  check('el tripulante no ve ninguno (ni el suyo)', v.v === 0, v);
  v = await ver(fx.drvUser, 'driver');
  check('el conductor no ve ninguno', v.v === 0, v);
  v = await como(jefeOtra, 'admin', async () => (await q(`SELECT count(*)::int n FROM public.password_reset_requests WHERE organization_id = $1`, [fx.org]))[0].n);
  check('el jefe de otra organización no ve los de esta', v.v === 0, v);
  await c.query('SAVEPOINT an');
  let anonErr = null;
  try {
    await c.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await c.query('SET LOCAL ROLE anon');
    await c.query('SELECT * FROM public.password_reset_requests');
  } catch (e) { anonErr = e; }
  await c.query('ROLLBACK TO SAVEPOINT an');
  await asAdminDb(c);
  check('anon no puede leer la tabla (permission denied)', !!anonErr && /permission denied/i.test(anonErr.message), anonErr && anonErr.message);

  console.log('\n── 8 · el jefe lo resuelve ──');
  const pl = (await pedidos()).find(p => p.profile_id === fx.auxUser && p.status === 'pending');
  v = await como(fx.auxUser, 'auxiliar', async () => (await c.query(`UPDATE public.password_reset_requests SET status = 'dismissed' WHERE id = $1`, [pl.id])).rowCount);
  check('el tripulante no puede marcarlo (0 filas)', v.v === 0, v);
  v = await como(jefe, 'admin', async () => c.query(`UPDATE public.password_reset_requests SET contact = 'otro@x.co' WHERE id = $1`, [pl.id]));
  check('nadie cambia el contacto (permiso de columna)', !!v.err && /permission denied/i.test(v.err), v);
  v = await como(jefe, 'admin', async () => (await c.query(`UPDATE public.password_reset_requests SET status = 'dismissed' WHERE id = $1`, [pl.id])).rowCount);
  let fila = await one('SELECT * FROM public.password_reset_requests WHERE id = $1', [pl.id]);
  check('el jefe lo descarta: la base sella resolved_at y resolved_by = el jefe', v.v === 1 && fila.status === 'dismissed' && fila.resolved_at && fila.resolved_by === jefe, fila);
  v = await como(jefe2, 'admin', async () => (await c.query(`UPDATE public.password_reset_requests SET status = 'pending' WHERE id = $1`, [pl.id])).rowCount);
  fila = await one('SELECT * FROM public.password_reset_requests WHERE id = $1', [pl.id]);
  check('volverlo a pendiente limpia el sello', v.v === 1 && fila.status === 'pending' && fila.resolved_at === null && fila.resolved_by === null, fila);
  v = await como(jefe, 'admin', async () => c.query(`UPDATE public.password_reset_requests SET status = 'quizas' WHERE id = $1`, [pl.id]));
  check('un estado desconocido lo rechaza el CHECK', !!v.err && /password_reset_requests_status_chk/.test(v.err), v);

  console.log('\n── 9 · restablecer cierra los pendientes ──');
  v = await como(jefe2, 'admin', async () => c.query(`SELECT public.admin_set_password($1, 'Temporal2026x', true)`, [fx.auxUser]));
  fila = await one('SELECT * FROM public.password_reset_requests WHERE id = $1', [pl.id]);
  check('admin_set_password deja el pedido «done» con resolved_by = quien la restableció', !v.err && fila.status === 'done' && fila.resolved_by === jefe2 && !!fila.resolved_at, v.err || fila);
  const otros = (await pedidos()).filter(p => p.profile_id === fx.vecinoUser && p.status === 'pending').length;
  check('…y no toca los pedidos de otra persona', otros === 1, otros);

  console.log('\n── 10 · un jefe que olvidó la suya ──');
  const correoJefe = (await one('SELECT email FROM auth.users WHERE id = $1', [jefe])).email;
  r = await pedir(correoJefe);
  // Todo corre con el mismo now(): los avisos de ESTE pedido se buscan por su id.
  const pj = (await pedidos()).find(p => p.profile_id === jefe);
  A = pj ? (await avisos()).filter(a => a.dedupe_key.startsWith('pwreset:' + pj.id + ':')) : [];
  check('le avisa al otro jefe, no a sí misma', esNeutra(r) && A.length === 1 && A[0].profile_id === jefe2 && A[0].body === 'Jefa no puede entrar. Restablécela desde Turnos › Personal.' && A[0].url === '/#/workers', A);
} catch (e) {
  fail++;
  console.log('  ✗ ERROR INESPERADO → ' + (e && e.stack ? e.stack : e));
} finally {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  await c.end();
}

console.log(`\n${ok}/${ok + fail} pasaron${fail ? ` · ${fail} FALLARON` : ''}`);
process.exit(fail ? 1 : 0);
