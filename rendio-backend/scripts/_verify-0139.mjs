// Verificación de 0139 (externos sin app y pedidos que hace el jefe) contra la base
// LOCAL. Pone la base al día hasta 0136 y aplica 0139 en una transacción que se deshace.
//
//   cd rendio-backend/scripts && node _verify-0139.mjs
//
// Qué prueba:
//   1. admin_create_external: crea la cuenta (sin contraseña, entrada bloqueada), el
//      perfil de tripulante de la organización (bienvenida ya vista) y el tripulante
//      con external = true en su conjunto. El mismo nombre otra vez devuelve el mismo.
//   2. Reglas: solo un jefe; nombre de 3+ letras; teléfono válido; conjunto de SU
//      organización y obligatorio.
//   3. admin_create_reservation: salida y llegada a nombre del externo (y de una
//      tripulante con app); la recogida sale del conjunto; «Vuelo AV9563.» en las
//      notas y flight_code AV9563; el jefe la ve en Reservas (RLS); no deja dos del
//      mismo tipo a menos de 3 h; ni de otra organización; ni en el pasado; solo jefe.
//   4. Cobro: a un externo no se le abre cuenta; a una tripulante con app sí.
//   5. El down quita las funciones, la marca y el candado (el externo creado queda).
//
// NO cubre: la pantalla de Reservas (_smoke-externos-dom.mjs), el inicio de sesión real
// (GoTrue no corre aquí: se comprueba que no tiene contraseña y está bloqueada).
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';
import { cadenaHasta0136, migracion, reversa } from './_local-cadena-0136.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const intento = async (u, role, sql, params) => {
  await asUser(c, u, role);
  await c.query('SAVEPOINT sp_i');
  try { const r = await one(sql, params); await c.query('RELEASE SAVEPOINT sp_i'); return { ok: r }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_i'); return { err: e }; }
  finally { await asDb(); }
};

await c.query('BEGIN');
try {
  await cadenaHasta0136(c);
  await c.query(migracion('0139_externos_sin_app'));
  await c.query(migracion('0139_externos_sin_app'));
  check('0139 se aplica encima de 0136 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0139');
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0139', 'otra-0139-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtro = await user(c, otraOrg, 'admin', 'Jefe de otra org 0139');
  const resOtra = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, 'Conjunto de otra org', 6.15, -75.38) RETURNING id`, [otraOrg])).id;
  const crear = (u, role, nombre, tel, res, apto) => intento(u, role, `SELECT public.admin_create_external($1, $2, $3, $4) j`, [nombre, tel, res, apto]);
  const pedir = (u, aux, tipo, cuando, vuelo, nota) => intento(u, 'admin', `SELECT public.admin_create_reservation($1, $2, $3::timestamptz, $4, $5) id`, [aux, tipo, cuando, vuelo, nota]);

  // ── 1. Crear al externo ─────────────────────────────────────────────────────
  console.log('\n1. admin_create_external');
  const e1 = await crear(jefe, 'admin', '  kriss   Montoya ', '300 123 4567', fx.olivar, 'Torre 2 · 504');
  const k = e1.ok && e1.ok.j;
  check('lo crea', !!k && k.existed === false && !!k.auxiliar_profile_id, e1.err && e1.err.message);
  const au = await one(`SELECT email, encrypted_password, banned_until, raw_app_meta_data FROM auth.users WHERE id = $1`, [k.profile_id]);
  check('la cuenta: sin contraseña, entrada bloqueada, correo que no existe', au && au.encrypted_password === null && String(au.banned_until).includes('Infinity') && /@sin-app\.invalid$/.test(au.email) && au.raw_app_meta_data.externo === true, au);
  const pr = await one(`SELECT organization_id, role, full_name, phone, welcome_seen_at FROM public.profiles WHERE id = $1`, [k.profile_id]);
  check('el perfil: tripulante de la organización, nombre limpio, teléfono, bienvenida vista', pr && pr.organization_id === fx.org && pr.role === 'auxiliar' && pr.full_name === 'kriss Montoya' && pr.phone === '3001234567' && !!pr.welcome_seen_at, pr);
  const ap = await one(`SELECT external, residence_id, residence_unit FROM public.auxiliar_profiles WHERE id = $1`, [k.auxiliar_profile_id]);
  check('el tripulante: external = true en su conjunto y apto', ap && ap.external === true && ap.residence_id === fx.olivar && ap.residence_unit === 'Torre 2 · 504', ap);
  const e2 = await crear(jefe, 'admin', 'Kriss montoya', null, fx.olivar, null);
  check('el mismo nombre otra vez devuelve el mismo (no duplica)', e2.ok && e2.ok.j.existed === true && e2.ok.j.auxiliar_profile_id === k.auxiliar_profile_id, e2.ok || (e2.err && e2.err.message));
  const aud = await one(`SELECT count(*)::int n FROM public.audit_events WHERE event_type = 'external_created' AND entity_id = $1`, [k.auxiliar_profile_id]);
  check('queda en audit_events', aud.n === 1, aud);

  // ── 2. Reglas ───────────────────────────────────────────────────────────────
  console.log('\n2. Reglas');
  check('un conductor no puede', /Solo un jefe/.test(((await crear(fx.drvUser, 'driver', 'Pepe Pérez', null, fx.olivar, null)).err || {}).message || ''));
  check('nombre de 2 letras: no', /nombre/.test(((await crear(jefe, 'admin', 'Al', null, fx.olivar, null)).err || {}).message || ''));
  check('teléfono raro: no', /teléfono/.test(((await crear(jefe, 'admin', 'Pepe Pérez', '12', fx.olivar, null)).err || {}).message || ''));
  check('sin conjunto: no', /conjunto/.test(((await crear(jefe, 'admin', 'Pepe Pérez', null, null, null)).err || {}).message || ''));
  check('conjunto de otra organización: no', /conjunto/.test(((await crear(jefe, 'admin', 'Pepe Pérez', null, resOtra, null)).err || {}).message || ''));

  // ── 3. Pedidos del jefe ─────────────────────────────────────────────────────
  console.log('\n3. admin_create_reservation');
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${man}T${hm}:00-05:00`;
  const p1 = await pedir(jefe, k.auxiliar_profile_id, 'sal', at('06:00'), null, 'Lleva una maleta grande');
  check('salida a nombre del externo', !!(p1.ok && p1.ok.id), p1.err && p1.err.message);
  const r1 = await one(`SELECT direction, status_h2a, required_arrival_at, residence_id, residence_unit, pickup_latitude, pickup_longitude, pickup_address, notes, is_firm, is_overnight FROM public.reservations WHERE id = $1`, [p1.ok.id]);
  check('la recogida sale de su conjunto (coordenadas y dirección del catálogo)', r1.residence_id === fx.olivar && Math.abs(r1.pickup_latitude - 6.1523) < 1e-6 && /El Olivar/.test(r1.pickup_address) && r1.residence_unit === 'Torre 2 · 504', r1);
  check('estado «requested», firme, sin pernocta, la nota y «(Pedido por Coordinación.)»', r1.status_h2a === 'requested' && r1.is_firm === true && r1.is_overnight === false && r1.notes === 'Lleva una maleta grande (Pedido por Coordinación.)', r1);
  const p2 = await pedir(jefe, k.auxiliar_profile_id, 'lle', at('18:40'), 'av 9563', null);
  const r2 = p2.ok && await one(`SELECT direction, status_a2h, notes, flight_code FROM public.reservations WHERE id = $1`, [p2.ok.id]);
  check('llegada con vuelo: «Vuelo AV9563.» en las notas y flight_code AV9563', r2 && r2.status_a2h === 'scheduled' && r2.notes === 'Vuelo AV9563. (Pedido por Coordinación.)' && r2.flight_code === 'AV9563', r2 || (p2.err && p2.err.message));
  const p3 = await pedir(jefe, fx.aux, 'sal', at('08:00'), null, null);
  check('también a nombre de una tripulante con app (Laura)', !!(p3.ok && p3.ok.id), p3.err && p3.err.message);
  await asUser(c, jefe, 'admin');
  const vis = await q(`SELECT id FROM public.reservations WHERE id = ANY($1)`, [[p1.ok.id, p2.ok.id, p3.ok.id]]);
  await asDb();
  check('el jefe las ve (RLS de Reservas)', vis.length === 3, vis.length);
  const p4 = await pedir(jefe, k.auxiliar_profile_id, 'sal', at('07:30'), null, null);
  check('otra salida a menos de 3 h: no («Ya tiene una salida a esa hora»)', !!p4.err && /Ya tiene una salida/.test(p4.err.message), p4.err && p4.err.message);
  const p5 = await pedir(jefe, k.auxiliar_profile_id, 'lle', at('07:30'), null, null);
  check('una llegada a esa hora sí (otro tipo)', !!(p5.ok && p5.ok.id), p5.err && p5.err.message);
  const p6 = await pedir(jefeOtro, k.auxiliar_profile_id, 'sal', at('12:00'), null, null);
  check('un jefe de otra organización: no', !!p6.err && /no es de tu organización/.test(p6.err.message), p6.err && p6.err.message);
  const p7 = await pedir(jefe, k.auxiliar_profile_id, 'sal', new Date(Date.now() - 5 * 3600e3).toISOString(), null, null);
  check('en el pasado: no', !!p7.err && /hoy en adelante/.test(p7.err.message), p7.err && p7.err.message);
  const p8 = await pedir(jefe, k.auxiliar_profile_id, 'xx', at('12:00'), null, null);
  check('tipo raro: no', !!p8.err && /salida o llegada/.test(p8.err.message));
  const p9 = await pedir(jefe, k.auxiliar_profile_id, 'lle', at('22:00'), 'AV-9!', null);
  check('vuelo raro: no', !!p9.err && /vuelo/.test(p9.err.message), p9.err && p9.err.message);
  const p10 = await intento(fx.drvUser, 'driver', `SELECT public.admin_create_reservation($1, 'sal', $2::timestamptz, NULL, NULL) id`, [k.auxiliar_profile_id, at('15:00')]);
  check('un conductor no puede pedir a nombre de otro', !!p10.err && /Solo un jefe/.test(p10.err.message));

  // ── 4. Cobro ────────────────────────────────────────────────────────────────
  console.log('\n4. Cobro');
  const b1 = await intento(jefe, 'admin', `SELECT public.admin_billing_save_account($1, 150000) j`, [k.auxiliar_profile_id]);
  check('a un externo no se le abre cuenta de cobro', !!b1.err && /no se le cobra/.test(b1.err.message), b1.err ? b1.err.message : b1.ok);
  const b2 = await intento(jefe, 'admin', `SELECT public.admin_billing_save_account($1, 150000) j`, [fx.aux]);
  check('a Laura (con app) sí', !!b2.ok, b2.err && b2.err.message);

  // ── 5. Down ─────────────────────────────────────────────────────────────────
  console.log('\n5. Down');
  await c.query(reversa('0139_externos_sin_app'));
  const d = await one(`SELECT to_regprocedure('public.admin_create_external(text,text,uuid,text)') a,
      to_regprocedure('public.admin_create_reservation(uuid,text,timestamptz,text,text)') b,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'auxiliar_profiles' AND column_name = 'external')::int col,
      (SELECT count(*) FROM pg_trigger WHERE tgname = 'tr_auxiliar_billing_no_external')::int trg,
      (SELECT count(*) FROM public.auxiliar_profiles WHERE id = $1)::int queda`, [k.auxiliar_profile_id]);
  check('el down quita funciones, marca y candado; el externo y sus reservas quedan', !d.a && !d.b && d.col === 0 && d.trg === 0 && d.queda === 1, d);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
