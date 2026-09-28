// Verificación de 0086: datos del viaje (maletas, silencio, código y punto de
// encuentro, nivel preferido, color del carro) y notes_without_flight.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0086.mjs
//
// Con 0086 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
import { readFileSync } from 'node:fs';
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
// Actuar como un usuario (RLS) y volver a postgres SIN arrastrar los claims.
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };

// El helper del front, leído del archivo de verdad (paridad JS ↔ SQL).
const apiSrc = readFileSync(new URL('../../rendio-turnos/api.js', import.meta.url), 'utf8');
const m = apiSrc.match(/function notesUser\(n\) \{[\s\S]*?\n  \}/);
const notesUserJS = m ? new Function(m[0] + '\nreturn notesUser;')() : null;

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0086');

  console.log('\n0. Estructura');
  const cols = await q(`SELECT table_name||'.'||column_name AS k, udt_name FROM information_schema.columns
     WHERE table_schema='public' AND ((table_name='reservations' AND column_name IN ('quiet_ride','bags','meet_code','meeting_point'))
       OR (table_name='auxiliar_profiles' AND column_name IN ('preferred_service_level','meeting_point'))
       OR (table_name='vehicles' AND column_name='color'))`);
  check('las 7 columnas nuevas existen', cols.length === 7, cols.map(x => x.k).join(','));
  const psl = cols.find(x => x.k === 'auxiliar_profiles.preferred_service_level');
  check('preferred_service_level es del enum service_level', psl && psl.udt_name === 'service_level', psl && psl.udt_name);
  const cons = await q(`SELECT conname FROM pg_constraint WHERE conname IN ('reservations_bags_range','reservations_meet_code_format',
     'reservations_meeting_point_len','reservations_quiet_only_private','auxiliar_profiles_meeting_point_len','vehicles_color_len')`);
  check('los 6 CHECK existen', cons.length === 6, cons.map(x => x.conname).join(','));
  const fn = await one(`SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.notes_without_flight(text)')`);
  check('notes_without_flight(text) existe y es IMMUTABLE', fn && fn.provolatile === 'i', fn ? fn.provolatile : 'no existe');
  const trg = await q(`SELECT 1 FROM pg_trigger WHERE tgname = 'tr_reservations_trip_extras' AND NOT tgisinternal`);
  check('trigger tr_reservations_trip_extras existe', trg.length === 1);
  const ord = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.reservations'::regclass AND NOT tgisinternal
     AND tgname IN ('tr_reservations_fill_pickup','tr_reservations_trip_extras') ORDER BY tgname`);
  check('dispara DESPUÉS de fill_pickup (orden alfabético)', ord.map(x => x.tgname).join() === 'tr_reservations_fill_pickup,tr_reservations_trip_extras');
  const priv = await one(`SELECT has_function_privilege('authenticated', 'public.reservation_trip_extras()', 'EXECUTE') a`).catch(() => ({ a: null }));
  check('la función del trigger no la ejecuta authenticated', priv.a === false, priv.a);

  console.log('\n1. notes_without_flight = Api.notesUser (api.js)');
  check('encontré notesUser en api.js', !!notesUserJS);
  const muestras = ['Vuelo AV9412. Llevo perro', 'Vuelo AV-9412. x', 'vuelo: ja 5116. hola', 'Vuelo 5116.', null, '',
    'Nota · Regreso del mismo día', 'Vuelo AV1. x', '  espacios  ', 'Vuelo LA2345. nota · Regreso del mismo día',
    'Vuelo P51234. portería 2', 'Sin vuelo. Vuelo AV9412. al final', 'VUELO av 9412.   Maleta'];
  for (const s of muestras) {
    const sql = (await one(`SELECT public.notes_without_flight($1) v`, [s])).v;
    const js = notesUserJS ? notesUserJS(s) : '(sin JS)';
    check(`«${s}» → «${sql}»`, sql === js, `JS dice «${js}»`);
  }

  console.log('\n2. El código de encuentro lo pone la base');
  await como(fx.auxUser);
  const r1 = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id, bags, meet_code)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', $2, 2, 'abcd') RETURNING id, meet_code, bags, quiet_ride`, [fx.aux, fx.olivar]);
  check('tripulante: el código sale de 4 dígitos (ignora el que mandó)', /^[0-9]{4}$/.test(r1.meet_code), r1.meet_code);
  check('bags se guarda', r1.bags === 2, r1.bags);
  check('quiet_ride por defecto false', r1.quiet_ride === false, r1.quiet_ride);
  let e = await debeFallar(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, bags)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', 4)`, [fx.aux]);
  check('bags = 4 → rechazado', e && /bags_range/.test(e), e);
  e = await debeFallar(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, quiet_ride)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', true)`, [fx.aux]);
  check('silencio en un compartido → rechazado', e && /quiet_only_private/.test(e), e);
  const rp = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, service_level, quiet_ride)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', 'private', true) RETURNING quiet_ride, private_status`, [fx.aux]);
  check('silencio en un privado → aceptado', rp.quiet_ride === true && rp.private_status === 'requested', JSON.stringify(rp));
  await comoDb();
  const rj = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, meet_code)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', '0420') RETURNING meet_code`, [fx.aux]);
  check('un script o el jefe que trae un código válido lo conserva', rj.meet_code === '0420', rj.meet_code);

  console.log('\n3. Preferencias del tripulante (policy update_own) y punto heredado');
  await como(fx.auxUser);
  let u = await c.query(`UPDATE public.auxiliar_profiles SET preferred_service_level = 'private', meeting_point = 'Portería 2' WHERE profile_id = $1`, [fx.auxUser]);
  check('el tripulante guarda su nivel preferido y su punto', u.rowCount === 1, u.rowCount);
  u = await c.query(`UPDATE public.auxiliar_profiles SET meeting_point = 'hackeado' WHERE id = $1`, [fx.vecino]);
  check('no puede tocar el perfil de otro', u.rowCount === 0, u.rowCount);
  e = await debeFallar(`UPDATE public.auxiliar_profiles SET meeting_point = repeat('x', 121) WHERE profile_id = $1`, [fx.auxUser]);
  check('punto de encuentro de 121 → rechazado', e && /meeting_point_len/.test(e), e);
  const h1 = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '3 days', $2) RETURNING meeting_point`, [fx.aux, fx.olivar]);
  check('desde SU conjunto principal hereda «Portería 2»', h1.meeting_point === 'Portería 2', h1.meeting_point);
  const h2 = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '3 days', $2) RETURNING meeting_point`, [fx.aux, fx.llano]);
  check('desde otro conjunto NO hereda', h2.meeting_point === null, h2.meeting_point);
  const h3 = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id, meeting_point)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '3 days', $2, '  Torre 3  ') RETURNING meeting_point`, [fx.aux, fx.olivar]);
  check('el que trae el pedido gana (y se recorta)', h3.meeting_point === 'Torre 3', h3.meeting_point);
  const h4 = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_latitude, pickup_longitude, pickup_address)
     VALUES ($1, 'home_to_airport', 'requested', now() + interval '3 days', 6.14, -75.37, 'Casa de mi mamá') RETURNING meeting_point, residence_id`, [fx.aux]);
  check('pin manual (sin conjunto) NO hereda', h4.meeting_point === null && h4.residence_id === null, JSON.stringify(h4));

  console.log('\n4. Color del carro: lo carga el jefe');
  await comoDb(); await como(jefe);
  u = await c.query(`UPDATE public.vehicles SET color = 'Blanco' WHERE id = $1`, [fx.vehicle]);
  check('el jefe guarda el color', u.rowCount === 1, u.rowCount);
  e = await debeFallar(`UPDATE public.vehicles SET color = repeat('x', 31) WHERE id = $1`, [fx.vehicle]);
  check('color de 31 → rechazado', e && /color_len/.test(e), e);
  await comoDb(); await como(fx.auxUser);
  u = await c.query(`UPDATE public.vehicles SET color = 'Rosado' WHERE id = $1`, [fx.vehicle]);
  check('el tripulante no puede', u.rowCount === 0, u.rowCount);
  await comoDb();

  console.log('\n5. Relleno del código');
  const ids = {};
  for (const [k, when, canc] of [['futura', "now() + interval '1 day'", false], ['vieja', "now() - interval '3 days'", false], ['cancelada', "now() + interval '1 day'", true]]) {
    ids[k] = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, cancelled_at)
       VALUES ($1, 'home_to_airport', 'requested', ${when}, ${canc ? 'now()' : 'NULL'}) RETURNING id`, [fx.aux])).id;
  }
  await q(`UPDATE public.reservations SET meet_code = NULL WHERE id = ANY($1)`, [Object.values(ids)]);
  const sql = readFileSync(new URL('../supabase/migrations/0086_aux_datos_del_viaje.sql', import.meta.url), 'utf8');
  const i0 = sql.indexOf('-- RELLENO:INICIO'), i1 = sql.indexOf('-- RELLENO:FIN');
  if (i0 < 0 || i1 < 0) throw new Error('no encuentro el bloque RELLENO en la migración');
  await c.query(sql.slice(sql.indexOf('\n', i0) + 1, i1));
  const rr = Object.fromEntries((await q(`SELECT id, meet_code FROM public.reservations WHERE id = ANY($1)`, [Object.values(ids)])).map(x => [x.id, x.meet_code]));
  check('futura no cancelada → recibe código', /^[0-9]{4}$/.test(rr[ids.futura] || ''), rr[ids.futura]);
  check('la de hace 3 días → no', rr[ids.vieja] === null, rr[ids.vieja]);
  check('la cancelada → no', rr[ids.cancelada] === null, rr[ids.cancelada]);
} catch (err) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + err.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
