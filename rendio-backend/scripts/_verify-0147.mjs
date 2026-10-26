// Verificación de 0147 (el aviso del regreso de reserva dice dónde lo recogen)
// contra la base LOCAL (127.0.0.1:54322). Arma la cadena hasta 0136 y aplica 0138,
// 0141, 0143, 0145 y 0147 dentro de una transacción que se deshace: no queda nada.
// Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0147.mjs
//
// Qué prueba:
//   1. Las cinco funciones que 0147 reemplaza tienen, antes, la huella md5 que
//      exige _aplicar-0147 (las de 0143, 0138, 0129, 0131 y 0145).
//   2. Pegar la ruta: Lesmes (reserva en el Hotel Río Verde) recibe «Te recogemos
//      en el Hotel Río Verde (sale hacia las 18:15)»; Andrea (reserva en JMC) y Kris
//      (tierra), «Te recogemos en JMC…»; Natalia (vuelo) el texto de siempre, igual
//      letra por letra; la salida de Paula, igual.
//   3. Tomar la vuelta (conductor), ponerle conductor (jefe) y delegarla: «Te espera
//      en el Hotel Río Verde», «…en JMC», y el de vuelo igual que antes.
//   4. «Cambiar hora» (0145) a una llegada de tierra: «Te recogemos en JMC hacia…».
//   5. lugar_del_regreso no se puede llamar desde la app.
//   6. El down devuelve las cinco funciones a su huella de antes y quita la ayuda.
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';
import { cadenaHasta0136, migracion } from './_local-cadena-0136.mjs';
import { readFileSync } from 'node:fs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const down = () => readFileSync(new URL('../down_migrations/0147_aviso_regreso_hotel.down.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const F = { pub: 'public.admin_manual_route_publish(date,jsonb,jsonb)', take: 'public.driver_take_route(uuid)',
  setd: 'public.admin_route_set_driver(uuid,uuid)', deleg: 'public.admin_route_delegate(uuid,text,text)',
  st: 'public.admin_manual_route_set_times(uuid,jsonb,timestamptz,timestamptz)' };
// Las de hoy (26-oct, 5:25 p. m.): 0143, 0138, 0129, 0131, 0145. Las mismas que exige _aplicar-0147.
const H = { pub: '178cf9abee03eafe497992613ce90895', take: '94dda6282a594af63c9e2e3c8b1ef4ee', setd: '8013ea64c63d3302dd837731e4edd493',
  deleg: '206286b1bc80309f319ec6673904eb65', st: '8d7ae14b06d8de2d32b4802b3cb0aa82' };
const huellas = async () => { const o = {}; for (const [k, sig] of Object.entries(F)) o[k] = ((await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig])) || {}).h; return o; };

await c.query('BEGIN');
try {
  await cadenaHasta0136(c);
  for (const m of ['0138_vueltas_para_tomar', '0141_sin_carro_dia_del_plan', '0143_pegar_no_borra_automaticas', '0145_cambiar_hora_pegada']) await c.query(migracion(m));
  const h0 = await huellas();
  check('antes: las cinco funciones son las de 0143, 0138, 0129, 0131 y 0145 (las huellas que exige _aplicar-0147)', JSON.stringify(h0) === JSON.stringify(H), h0);
  await c.query(migracion('0147_aviso_regreso_hotel'));
  await c.query(migracion('0147_aviso_regreso_hotel'));
  const h1 = await huellas();
  check('0147 se aplica (y se puede volver a correr) y cambia las cinco', Object.keys(F).every((k) => h1[k] && h1[k] !== H[k]), h1);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0147');
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LES = await trip('Lesmes prueba 0147'), AND = await trip('Andrea Núñez prueba 0147'), KRI = await trip('Kris prueba 0147'),
    NAT = await trip('Natalia Duque prueba 0147'), PAU = await trip('Paula Londoño prueba 0147');
  const DIA = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${DIA}T${hm}:00-05:00`;
  const lle = async (X, fin, o = {}) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, required_arrival_at, pickup_address, residence_id, reserve_place, ground_ops)
      VALUES ($1, 'airport_to_home', 'scheduled', $2::timestamptz, 'El Olivar, Rionegro', $3, $4, $5) RETURNING id`, [X.a, fin, fx.olivar, o.lugar || null, !!o.tierra])).id;
  const rLes = await lle(LES, at('18:00'), { lugar: 'rio_verde' }), rAnd = await lle(AND, at('16:20'), { lugar: 'aero' });
  const rKri = await lle(KRI, at('19:00'), { tierra: true }), rNat = await lle(NAT, at('15:00'));
  const rPau = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'El Olivar, Rionegro', $3) RETURNING id`, [PAU.a, at('17:40'), fx.olivar])).id;
  const avisos = async (prof, like = '%') => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND dedupe_key LIKE $2 ORDER BY created_at, title`, [prof, like]); };
  const lleB = (rid, hm) => ({ type: 'lle', stops: [{ reservation_id: rid, at: at(hm) }], deadline_at: null, note: null, flight: null });

  // ── 2. Pegar ─────────────────────────────────────────────────────────────
  console.log('\n2. Pegar la ruta');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb)`, [DIA, JSON.stringify([
    lleB(rLes, '18:00'), lleB(rAnd, '16:20'), lleB(rKri, '19:00'), lleB(rNat, '15:00'),
    { type: 'sal', stops: [{ reservation_id: rPau, at: at('16:40') }], deadline_at: at('17:20'), note: null, flight: null }])]);
  await asDb();
  const pub = async (X) => (await avisos(X.u, 'manual:%')).map((a) => a.body).join(' | ');
  // La hora de salida es la que puso publicar (llegada + desembarque, flight_deplane_min).
  const sale = async (rid) => (await one(`SELECT public.hm_bog(ra.planned_start_at) h FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1`, [rid])).h;
  const [sLes, sAnd, sKri, sNat] = [await sale(rLes), await sale(rAnd), await sale(rKri), await sale(rNat)];
  check(`Lesmes (reserva en el Río Verde): «Te recogemos en el Hotel Río Verde (sale hacia las ${sLes}). Te avisamos quién te recoge.»`, (await pub(LES)) === `Te recogemos en el Hotel Río Verde (sale hacia las ${sLes}). Te avisamos quién te recoge.`, await pub(LES));
  check(`Andrea (reserva en JMC): «Te recogemos en JMC (sale hacia las ${sAnd})…»`, (await pub(AND)) === `Te recogemos en JMC (sale hacia las ${sAnd}). Te avisamos quién te recoge.`, await pub(AND));
  check(`Kris (personal de tierra): «Te recogemos en JMC (sale hacia las ${sKri})…»`, (await pub(KRI)) === `Te recogemos en JMC (sale hacia las ${sKri}). Te avisamos quién te recoge.`, await pub(KRI));
  check('Natalia (vuelo): el texto de siempre, igual letra por letra', (await pub(NAT)) === `Cuando aterrices te esperamos en JMC (sale hacia las ${sNat}). Te avisamos quién te recoge.`, await pub(NAT));
  check('la salida de Paula, igual que antes', (await pub(PAU)) === 'Te recogemos a las 16:40 para estar en JMC a las 17:20. Te avisamos quién te recoge.', await pub(PAU));

  // ── 3. Tomar, poner conductor, delegar ──────────────────────────────────
  console.log('\n3. Tomarla, ponerle conductor y delegarla');
  // Las vueltas se buscan como la base (el conductor, por RLS, no las ve todas).
  const deRes = async (rid) => { await asDb(); return (await one(`SELECT route_assignment_id id FROM public.route_stops WHERE reservation_id = $1`, [rid])).id; };
  const [vLes, vNat, vAnd, vKri] = [await deRes(rLes), await deRes(rNat), await deRes(rAnd), await deRes(rKri)];
  await asUser(c, fx.drvUser, 'driver');
  await q(`SELECT public.driver_take_route($1)`, [vLes]);
  await q(`SELECT public.driver_take_route($1)`, [vNat]);
  await asDb();
  const toma = async (X) => (await avisos(X.u, 'take:%')).map((a) => `${a.title} · ${a.body}`).join(' | ');
  check('el conductor toma la de Lesmes: «Carlos te recoge 🚗 · Te espera en el Hotel Río Verde.»', (await toma(LES)) === 'Carlos te recoge 🚗 · Te espera en el Hotel Río Verde.', await toma(LES));
  check('…y la de Natalia (vuelo): «Te espera en JMC cuando aterrices.», como antes', (await toma(NAT)) === 'Carlos te recoge 🚗 · Te espera en JMC cuando aterrices.', await toma(NAT));
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_route_set_driver($1, $2)`, [vAnd, fx.driver]);
  await asDb();
  const setd = async (X) => (await avisos(X.u, 'setdrv:%')).map((a) => a.body).join(' | ');
  check('el jefe le pone conductor a la de Andrea: «Te espera en JMC.» (sin «cuando aterrices»)', (await setd(AND)) === 'Te espera en JMC.', await setd(AND));
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_route_delegate($1, $2, $3)`, [vKri, 'Uber de Camilo', '3112223344']);
  await asDb();
  const dlg = async (X) => (await avisos(X.u, 'delegto:%')).map((a) => a.body).join(' | ');
  check('delegar la de Kris (tierra): «Uber te espera en JMC. Su número de contacto es 3112223344.»', /^Uber .*te espera en JMC\. Su número de contacto es 3112223344\.$/.test(await dlg(KRI)), await dlg(KRI));

  // ── 4. Cambiar hora (0145) ──────────────────────────────────────────────
  console.log('\n4. «Cambiar hora» a una llegada de tierra');
  await asUser(c, jefe, 'admin');
  // La de Kris quedó delegada; se mueve igual (0145 deja mover la delegada).
  await q(`SELECT public.admin_manual_route_set_times($1, '[]'::jsonb, $2::timestamptz, NULL)`, [vKri, at('19:30')]);
  await asDb();
  const hora = async (X) => (await avisos(X.u, 'manualhora:%')).map((a) => a.body).join(' | ');
  check('Kris: «Te recogemos en JMC hacia las 19:30.» (antes, «Cuando aterrices…»)', (await hora(KRI)) === 'Te recogemos en JMC hacia las 19:30.', await hora(KRI));

  // ── 5. Permisos ─────────────────────────────────────────────────────────
  console.log('\n5. Permisos');
  const p = await one(`SELECT has_function_privilege('authenticated', 'public.lugar_del_regreso(uuid)', 'EXECUTE') a,
      has_function_privilege('anon', 'public.lugar_del_regreso(uuid)', 'EXECUTE') b,
      has_function_privilege('authenticated', '${F.pub}', 'EXECUTE') c1, has_function_privilege('authenticated', '${F.take}', 'EXECUTE') c2,
      has_function_privilege('authenticated', '${F.setd}', 'EXECUTE') c3, has_function_privilege('authenticated', '${F.deleg}', 'EXECUTE') c4,
      has_function_privilege('authenticated', '${F.st}', 'EXECUTE') c5, has_function_privilege('anon', '${F.take}', 'EXECUTE') d`);
  check('lugar_del_regreso cerrada para la app; las cinco siguen abiertas para la sesión (y no para anon)', !p.a && !p.b && p.c1 && p.c2 && p.c3 && p.c4 && p.c5 && !p.d, p);

  // ── 6. Down ─────────────────────────────────────────────────────────────
  console.log('\n6. El down');
  await c.query(down());
  const h2 = await huellas();
  check('devuelve las cinco funciones a su huella de antes', JSON.stringify(h2) === JSON.stringify(H), h2);
  check('y quita lugar_del_regreso', (await one(`SELECT to_regprocedure('public.lugar_del_regreso(uuid)') IS NULL ok`)).ok);
} catch (e) {
  fail++;
  console.log('  ✗ error: ' + (e && e.message) + (e && e.where ? ' · ' + e.where : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok}/${ok + fail} pasaron (base local, transacción deshecha)`);
process.exit(fail ? 1 : 0);
