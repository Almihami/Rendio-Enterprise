// Verificación de 0098 (set_my_phone: cada quien guarda su celular) contra la
// base LOCAL (127.0.0.1:54322), con 0081 y 0098 aplicadas.
//
//   cd rendio-backend && node scripts/_verify-0098.mjs
//
// Todo corre dentro de UNA transacción que se deshace (cada caso de error en su
// SAVEPOINT): no queda nada en la base. Nunca apunta a dev ni a producción
// (_local-fixtures se niega).
//
// Qué prueba:
//   0. Estructura: la función existe, es SECURITY DEFINER con search_path fijo,
//      authenticated la puede ejecutar y anon / public no.
//   1. Normaliza: «300 123 4567», «+57 300-123-4567», «(+57) 310.555.1234» y
//      «573105551234» → 10 dígitos; devuelve lo guardado.
//   2. Bitácora: phone_changed en audit_events con actor = quien llama, from/to;
//      escribir el mismo número de otra forma NO deja otra fila.
//   3. Rechaza: empieza por 2, 9 u 11 dígitos, otro indicativo (+1), letras,
//      vacío, solo espacios, null — con el mensaje en español y sin tocar el
//      número que ya estaba.
//   4. Solo el propio: el conductor no toca el teléfono de la vecina; el
//      tripulante y el jefe guardan el suyo; ninguna otra columna del perfil
//      cambia (el guard de 0081 no se salta para nada más).
//   5. Sin sesión (sin sub) → «Sin sesión»; cuenta eliminada → «no tiene perfil»;
//      el rol anon no puede ni llamarla.
//
// NO cubre: PostgREST/supabase-js de verdad (que el nombre del parámetro p_phone
// llegue así; eso lo mira el smoke de la ventana del celular con un sb falso) ni
// la app.
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};

const c = await localClient();
const one = async (sql, p) => (await c.query(sql, p)).rows[0];
// Llama como `uid` (rol authenticated) y devuelve { v } o { err }.
async function llamar(uid, role, phone) {
  await c.query('SAVEPOINT s');
  try {
    if (uid) await asUser(c, uid, role);
    else { await c.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true)`); await c.query('SET LOCAL ROLE authenticated'); }
    const r = await one('SELECT public.set_my_phone($1) AS v', [phone]);
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return { v: r.v };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    await asAdminDb(c);
    return { err: e.message, code: e.code };
  }
}
const telDe = async (id) => (await one('SELECT phone FROM public.profiles WHERE id = $1', [id])).phone;
const auditDe = async (id) => (await c.query(
  `SELECT actor_profile_id, entity_id, entity_type, payload FROM public.audit_events
    WHERE event_type = 'phone_changed' AND entity_id = $1 ORDER BY id`, [id])).rows;

try {
  await c.query('BEGIN');
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de Prueba');
  // Punto de partida conocido: nadie tiene celular.
  await c.query('UPDATE public.profiles SET phone = NULL WHERE id = ANY($1)', [[fx.drvUser, fx.auxUser, fx.vecinoUser, jefe]]);
  await c.query(`UPDATE public.profiles SET phone = '3110000000' WHERE id = $1`, [fx.vecinoUser]);

  console.log('\n── 0 · estructura ──');
  const f = await one(`SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS res
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_my_phone'`);
  check('existe public.set_my_phone(text) → text', !!f && f.res === 'text', f);
  check('es SECURITY DEFINER', f && f.prosecdef === true);
  check('con search_path fijo (public, pg_temp)', f && (f.proconfig || []).some(x => /search_path=public, pg_temp/.test(x)), f && f.proconfig);
  const priv = await one(`SELECT has_function_privilege('authenticated', 'public.set_my_phone(text)', 'EXECUTE') AS a,
    has_function_privilege('anon', 'public.set_my_phone(text)', 'EXECUTE') AS n`);
  check('authenticated la puede ejecutar', priv.a === true);
  check('anon NO la puede ejecutar', priv.n === false);
  const pub = await one(`SELECT count(*)::int AS n FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'set_my_phone' AND grantee = 'PUBLIC'`);
  check('PUBLIC no tiene EXECUTE', pub.n === 0, pub);

  console.log('\n── 1 · normaliza y guarda ──');
  const antes = await one('SELECT to_jsonb(p) AS j FROM public.profiles p WHERE id = $1', [fx.drvUser]);
  let r = await llamar(fx.drvUser, 'driver', '300 123 4567');
  check('«300 123 4567» → 3001234567', r.v === '3001234567', r);
  check('queda en profiles.phone', (await telDe(fx.drvUser)) === '3001234567');
  let a = await auditDe(fx.drvUser);
  check('bitácora: 1 fila phone_changed, actor = el conductor, from null → to 3001234567',
    a.length === 1 && a[0].actor_profile_id === fx.drvUser && a[0].entity_type === 'profile'
    && a[0].payload.from === null && a[0].payload.to === '3001234567', a);
  r = await llamar(fx.drvUser, 'driver', '+57 300-123-4567');
  check('«+57 300-123-4567» → el mismo número', r.v === '3001234567', r);
  check('mismo número escrito distinto: NO deja otra fila en la bitácora', (await auditDe(fx.drvUser)).length === 1);
  r = await llamar(fx.drvUser, 'driver', '(+57) 310.555.1234');
  check('«(+57) 310.555.1234» → 3105551234', r.v === '3105551234', r);
  a = await auditDe(fx.drvUser);
  check('cambiar el número sí deja fila (from 3001234567 → to 3105551234)', a.length === 2 && a[1].payload.from === '3001234567' && a[1].payload.to === '3105551234', a);
  r = await llamar(fx.drvUser, 'driver', '573105551234');
  check('«573105551234» (57 sin +) → 3105551234', r.v === '3105551234', r);
  r = await llamar(fx.drvUser, 'driver', '  3105551234  ');
  check('espacios alrededor → se recortan', r.v === '3105551234', r);
  const despues = await one('SELECT to_jsonb(p) AS j FROM public.profiles p WHERE id = $1', [fx.drvUser]);
  const sinTel = (j) => { const o = { ...j }; delete o.phone; delete o.updated_at; return JSON.stringify(o); };
  check('ninguna otra columna del perfil cambió', sinTel(antes.j) === sinTel(despues.j));

  console.log('\n── 2 · rechaza ──');
  const MALOS = [
    ['2001234567', /empezar por 3/], ['300123456', /10 dígitos/], ['30012345678', /10 dígitos/],
    ['+1 3001234567', /10 dígitos/], ['300abc4567', /solo lleva números/], ['', /Escribe tu celular/],
    ['    ', /Escribe tu celular/], [null, /Escribe tu celular/], ['+57 2001234567', /empezar por 3/],
    ['0573001234567', /10 dígitos/], ['300 123 4567 ext 2', /solo lleva números/],
  ];
  for (const [txt, re] of MALOS) {
    r = await llamar(fx.drvUser, 'driver', txt);
    check(`rechaza ${JSON.stringify(txt)} con «${re.source}»`, !!r.err && re.test(r.err) && r.code === '22023', r);
  }
  check('después de los rechazos el número sigue siendo 3105551234', (await telDe(fx.drvUser)) === '3105551234');
  check('…y la bitácora no creció', (await auditDe(fx.drvUser)).length === 2);

  console.log('\n── 3 · solo el propio ──');
  check('la vecina (tripulante) conserva su número', (await telDe(fx.vecinoUser)) === '3110000000');
  check('la vecina no tiene filas en la bitácora', (await auditDe(fx.vecinoUser)).length === 0);
  r = await llamar(fx.auxUser, 'auxiliar', '320 999 8877');
  check('el tripulante guarda el suyo', r.v === '3209998877' && (await telDe(fx.auxUser)) === '3209998877', r);
  check('…y el del conductor no se movió', (await telDe(fx.drvUser)) === '3105551234');
  const aAux = await auditDe(fx.auxUser);
  check('bitácora del tripulante con actor = el tripulante', aAux.length === 1 && aAux[0].actor_profile_id === fx.auxUser, aAux);
  r = await llamar(jefe, 'admin', '3157654321');
  check('el jefe guarda el suyo', r.v === '3157654321' && (await telDe(jefe)) === '3157654321', r);

  console.log('\n── 4 · sin sesión, eliminado, anon ──');
  r = await llamar(null, 'authenticated', '3001234567');
  check('sin sub en el token → «Sin sesión»', !!r.err && /Sin sesión/.test(r.err) && r.code === '42501', r);
  await c.query('UPDATE public.profiles SET deleted_at = now() WHERE id = $1', [fx.vecinoUser]);
  r = await llamar(fx.vecinoUser, 'auxiliar', '3001112233');
  check('cuenta eliminada → «Tu cuenta no tiene perfil»', !!r.err && /no tiene perfil/.test(r.err), r);
  check('…y su número no cambió', (await telDe(fx.vecinoUser)) === '3110000000');
  await c.query('SAVEPOINT anon');
  let anonErr = null;
  try {
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: fx.drvUser, role: 'anon' })]);
    await c.query('SET LOCAL ROLE anon');
    await c.query(`SELECT public.set_my_phone('3001234567')`);
  } catch (e) { anonErr = e; }
  await c.query('ROLLBACK TO SAVEPOINT anon');
  await asAdminDb(c);
  check('el rol anon no puede llamarla (permission denied)', !!anonErr && /permission denied/i.test(anonErr.message), anonErr && anonErr.message);
} catch (e) {
  fail++;
  console.log('  ✗ ERROR INESPERADO → ' + (e && e.stack ? e.stack : e));
} finally {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  await c.end();
}

console.log(`\n${ok}/${ok + fail} pasaron${fail ? ` · ${fail} FALLARON` : ''}`);
process.exit(fail ? 1 : 0);
