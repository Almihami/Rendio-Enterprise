// Verificación de 0088: canal de Coordinación (crew_messages + RPC) y el
// teléfono/horario de Coordinación en app_settings.
//
// RLS probada con DOS tripulantes (A no ve el hilo de B) y con un jefe de OTRA
// organización (no ve nada de esta).
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0088.mjs
//
// Con 0088 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
// Corre `sql` como `uid` y devuelve la primera fila (o {__err}).
async function como1(uid, sql, params) {
  await como(uid);
  await c.query('SAVEPOINT sp1');
  try { const r = (await c.query(sql, params)).rows[0]; await c.query('RELEASE SAVEPOINT sp1'); return r; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp1'); return { __err: e.message }; }
  finally { await comoDb(); }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const A = fx.auxUser, B = fx.vecinoUser;
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0088');
  // Otra organización, con su jefe y su tripulante.
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra org', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefe2 = await user(c, org2, 'admin', 'Jefe de otra org');
  const auxCUser = await user(c, org2, 'auxiliar', 'Tripulante de otra org');
  const auxC = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, home_address, home_latitude, home_longitude) VALUES ($1, 'Casa', 6.15, -75.37) RETURNING id`, [auxCUser])).id;
  const resA = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at)
      VALUES ($1, 'home_to_airport', 'requested', now() + interval '1 day') RETURNING id`, [fx.aux])).id;
  const resB = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at)
      VALUES ($1, 'home_to_airport', 'requested', now() + interval '1 day') RETURNING id`, [fx.vecino])).id;

  console.log('\n0. Estructura');
  const t = await one(`SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.crew_messages')`);
  check('tabla crew_messages con RLS encendida', t && t.relrowsecurity === true, t ? 'RLS apagada' : 'no existe');
  const pols = await q(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'crew_messages'`);
  check('solo policies de SELECT (2)', pols.length === 2 && pols.every(p => p.cmd === 'SELECT'), JSON.stringify(pols));
  const colp = await one(`SELECT has_column_privilege('authenticated', 'public.crew_messages', 'sender_profile_id', 'SELECT') a,
      has_column_privilege('authenticated', 'public.crew_messages', 'body', 'SELECT') b,
      has_table_privilege('authenticated', 'public.crew_messages', 'INSERT') i,
      has_table_privilege('anon', 'public.crew_messages', 'SELECT') n`).catch(() => ({}));
  check('authenticated NO lee sender_profile_id', colp.a === false, colp.a);
  check('authenticated sí lee body', colp.b === true, colp.b);
  check('authenticated NO inserta directo', colp.i === false, colp.i);
  check('anon no lee nada', colp.n === false, colp.n);
  for (const f of ['crew_send_message(text,uuid,uuid)', 'crew_list_messages(uuid,int)', 'crew_mark_read(uuid)', 'crew_unread()', 'crew_threads_admin()']) {
    const p = await one(`SELECT p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an
       FROM pg_proc p WHERE p.oid = to_regprocedure('public.${f}')`);
    check(`${f}: definer, authenticated sí, anon no`, p && p.prosecdef && p.au && !p.an, JSON.stringify(p));
  }
  const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name IN ('ops_contact_phone','ops_contact_hours')`);
  check('app_settings.ops_contact_phone/hours existen', cols.length === 2);

  console.log('\n1. A le escribe a Coordinación');
  let r = await como1(A, `SELECT public.crew_send_message('No encuentro al conductor') v`);
  check('envía', r && r.v && r.v.id && r.v.sender_role === 'auxiliar', JSON.stringify(r));
  const to = (r && r.v && r.v.recipient_profile_ids) || [];
  check('destinatarios: la jefa de SU org', to.includes(jefe), JSON.stringify(to));
  check('…y NO el jefe de la otra org', !to.includes(jefe2));
  r = await como1(A, `SELECT public.crew_send_message('Sobre mi traslado', NULL, $1) v`, [resA]);
  check('con su reserva como contexto: ok', r && r.v && r.v.reservation_id === resA, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_send_message('Sobre el de B', NULL, $1) v`, [resB]);
  check('con la reserva de B → rechazado', r.__err && /no es de este tripulante/.test(r.__err), JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_send_message('En el hilo de B', $1) v`, [fx.vecino]);
  check('en el hilo de B → rechazado', r.__err && /propio hilo/.test(r.__err), JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_send_message('   ') v`);
  check('vacío → rechazado', !!r.__err, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_send_message(repeat('x', 501)) v`);
  check('501 caracteres → rechazado', !!r.__err, JSON.stringify(r));
  r = await como1(fx.drvUser, `SELECT public.crew_send_message('Soy conductor') v`);
  check('un conductor no puede', r.__err && /no puede usar Coordinación/.test(r.__err), JSON.stringify(r));

  console.log('\n2. RLS directa: A no ve lo de B');
  r = await como1(B, `SELECT public.crew_send_message('Hola, soy B') v`);
  check('B envía el suyo', r && r.v && r.v.id);
  r = await como1(A, `SELECT count(*)::int n FROM public.crew_messages`);
  check('A ve sus 2', r.n === 2, JSON.stringify(r));
  r = await como1(B, `SELECT count(*)::int n, bool_and(auxiliar_profile_id = $1) solo FROM public.crew_messages`, [fx.vecino]);
  check('B ve solo el suyo (1)', r.n === 1 && r.solo === true, JSON.stringify(r));
  r = await como1(auxCUser, `SELECT count(*)::int n FROM public.crew_messages`);
  check('C (otra org, sin mensajes) ve 0', r.n === 0, JSON.stringify(r));
  r = await como1(A, `SELECT sender_profile_id FROM public.crew_messages LIMIT 1`);
  check('A no puede leer sender_profile_id', r.__err && /permission denied/.test(r.__err), JSON.stringify(r));
  r = await como1(A, `INSERT INTO public.crew_messages (organization_id, auxiliar_profile_id, sender_profile_id, sender_role, body)
      VALUES ($1, $2, $3, 'admin', 'falso jefe') RETURNING id`, [fx.org, fx.aux, A]);
  check('A no puede insertar directo (ni hacerse pasar por jefe)', r.__err && /permission denied/.test(r.__err), JSON.stringify(r));
  r = await como1(A, `UPDATE public.crew_messages SET body = 'editado' RETURNING id`);
  check('A no puede editar', r.__err && /permission denied/.test(r.__err), JSON.stringify(r));
  r = await como1(jefe, `SELECT count(*)::int n FROM public.crew_messages`);
  check('la jefa ve los 3 de su org', r.n === 3, JSON.stringify(r));
  r = await como1(jefe2, `SELECT count(*)::int n FROM public.crew_messages`);
  check('el jefe de la otra org ve 0', r.n === 0, JSON.stringify(r));

  console.log('\n3. Leer el hilo por RPC');
  r = await como1(A, `SELECT public.crew_list_messages() v`);
  const la = (r && r.v) || [];
  check('A lista sus 2, en orden', la.length === 2 && la[0].body === 'No encuentro al conductor', JSON.stringify(la.map(m => m.body)));
  check('sin sender_profile_id en ningún mensaje', la.every(m => !('sender_profile_id' in m)));
  check('mine = true en lo suyo', la.every(m => m.mine === true));
  check('el contexto de la reserva viene con fecha y hora de Bogotá', la[1] && la[1].reservation && la[1].reservation.id === resA && /^\d{4}-\d{2}-\d{2}$/.test(la[1].reservation.date) && /^\d{2}:\d{2}$/.test(la[1].reservation.time), JSON.stringify(la[1] && la[1].reservation));
  r = await como1(A, `SELECT public.crew_list_messages($1) v`, [fx.vecino]);
  check('A pidiendo el hilo de B → NULL', r.v === null, JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_list_messages($1) v`, [fx.aux]);
  check('la jefa lee el hilo de A', r.v && r.v.length === 2, JSON.stringify(r));
  r = await como1(jefe2, `SELECT public.crew_list_messages($1) v`, [fx.aux]);
  check('el jefe de otra org → NULL', r.v === null, JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_list_messages() v`);
  check('la jefa sin tripulante → NULL', r.v === null, JSON.stringify(r));

  console.log('\n4. La jefa responde');
  r = await como1(jefe, `SELECT public.crew_send_message('Ya te llamamos', $1) v`, [fx.aux]);
  check('responde en el hilo de A; destinatario = A', r.v && r.v.sender_role === 'admin' && JSON.stringify(r.v.recipient_profile_ids) === JSON.stringify([A]), JSON.stringify(r));
  r = await como1(jefe2, `SELECT public.crew_send_message('Intruso', $1) v`, [fx.aux]);
  check('el jefe de otra org no puede escribirle a A', r.__err && /organización/.test(r.__err), JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_send_message('Sin hilo') v`);
  check('la jefa sin tripulante → rechazado', !!r.__err, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_list_messages() v`);
  const ult = r.v[r.v.length - 1];
  check('A ve la respuesta como «admin», mine=false, sin saber qué jefe', ult.sender_role === 'admin' && ult.mine === false && !('sender_profile_id' in ult) && !('sender_name' in ult), JSON.stringify(ult));

  console.log('\n5. Sin leer');
  r = await como1(A, `SELECT public.crew_unread() v`);
  check('A: 1 sin leer (la respuesta)', r.v === 1, JSON.stringify(r));
  r = await como1(B, `SELECT public.crew_unread() v`);
  check('B: 0', r.v === 0, JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_unread() v`);
  check('la jefa: 3 de tripulantes sin leer', r.v === 3, JSON.stringify(r));
  r = await como1(jefe2, `SELECT public.crew_unread() v`);
  check('el jefe de otra org: 0', r.v === 0, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_mark_read() v`);
  check('A marca leído (1)', r.v === 1, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_unread() v`);
  check('A: 0 sin leer', r.v === 0, JSON.stringify(r));
  r = await como1(A, `SELECT public.crew_mark_read($1) v`, [fx.vecino]);
  check('A no puede marcar el hilo de B', r.v === 0, JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_mark_read($1) v`, [fx.aux]);
  check('la jefa marca el hilo de A (2)', r.v === 2, JSON.stringify(r));
  r = await como1(jefe, `SELECT public.crew_unread() v`);
  check('la jefa: queda 1 (el de B)', r.v === 1, JSON.stringify(r));
  r = await como1(jefe2, `SELECT public.crew_mark_read($1) v`, [fx.vecino]);
  check('el jefe de otra org no marca nada', r.v === 0, JSON.stringify(r));

  console.log('\n6. Bandeja del jefe');
  r = await como1(jefe, `SELECT public.crew_threads_admin() v`);
  const th = (r && r.v) || [];
  check('2 hilos (A y B)', th.length === 2, JSON.stringify(th.map(x => x.name)));
  const tA = th.find(x => x.auxiliar_profile_id === fx.aux), tB = th.find(x => x.auxiliar_profile_id === fx.vecino);
  check('hilo de A: último = la respuesta, 0 sin leer, 3 en total, con conjunto', tA && tA.last_role === 'admin' && tA.unread === 0 && tA.total === 3 && tA.residence === 'El Olivar' && tA.profile_id === A, JSON.stringify(tA));
  check('hilo de B: 1 sin leer', tB && tB.unread === 1, JSON.stringify(tB));
  check('ordenados por el último mensaje', th[0].auxiliar_profile_id === fx.aux, th[0] && th[0].name);
  r = await como1(A, `SELECT public.crew_threads_admin() v`);
  check('un tripulante → NULL', r.v === null, JSON.stringify(r));
  r = await como1(jefe2, `SELECT public.crew_threads_admin() v`);
  check('el jefe de otra org → []', Array.isArray(r.v) && r.v.length === 0, JSON.stringify(r));

  console.log('\n7. Teléfono y horario de Coordinación');
  r = await como1(jefe, `UPDATE public.app_settings SET ops_contact_phone = '6045551234', ops_contact_hours = 'Todos los días · 3:00 a. m. a 11:00 p. m.' WHERE id = 'singleton' RETURNING ops_contact_phone`);
  check('la jefa los guarda', r && r.ops_contact_phone === '6045551234', JSON.stringify(r));
  r = await como1(A, `SELECT ops_contact_phone, ops_contact_hours FROM public.app_settings WHERE id = 'singleton'`);
  check('el tripulante los lee', r && r.ops_contact_phone === '6045551234' && /3:00/.test(r.ops_contact_hours), JSON.stringify(r));
  r = await como1(A, `UPDATE public.app_settings SET ops_contact_phone = '3000000000' WHERE id = 'singleton' RETURNING id`);
  check('el tripulante no los cambia', !r || r.__err || r.id == null, JSON.stringify(r));
  const e = await debeFallar(`UPDATE public.app_settings SET ops_contact_phone = repeat('9', 31) WHERE id = 'singleton'`);
  check('teléfono de 31 → rechazado', e && /phone_len/.test(e), e);

  console.log('\n8. Borrar la reserva deja el mensaje (contexto a NULL)');
  await q(`DELETE FROM public.reservations WHERE id = $1`, [resA]);
  const m = await one(`SELECT count(*)::int n, count(reservation_id)::int conres FROM public.crew_messages WHERE auxiliar_profile_id = $1`, [fx.aux]);
  check('los 3 mensajes siguen, ninguno con reserva', m.n === 3 && m.conres === 0, JSON.stringify(m));
} catch (err) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + err.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
