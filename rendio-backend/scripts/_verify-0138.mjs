// Verificación de 0138 («Vueltas para tomar»: los sin cuenta se ven y nadie toma dos
// a la vez) contra la base LOCAL. Pone la base al día hasta 0136 y aplica 0138 en una
// transacción que se deshace.
//
//   cd rendio-backend/scripts && node _verify-0138.mjs
//
// Qué prueba:
//   1. driver_open_routes: una vuelta con Laura + Kriss (sin cuenta) trae a las dos,
//      con su lugar; una solo con Kriss dice «1 persona»; una cancelada no sale.
//   2. 'cruza': true si el conductor ya tiene una vuelta a esa hora; false si no.
//   3. driver_take_route: la que se cruza se niega («se cruza con tu vuelta de las
//      5:00»); la que no, se toma y avisa a Laura; otro conductor ya no la puede tomar;
//      la delegada da su mensaje de siempre.
//   4. El down las deja EXACTAMENTE como en 0126 (huella md5).
//
// NO cubre: la pantalla del conductor (_smoke-vueltas-tomar-dom.mjs).
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
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
const huella = async (fn) => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [fn])).h;

await c.query('BEGIN');
try {
  await cadenaHasta0136(c);
  const h0126 = { o: await huella('driver_open_routes'), t: await huella('driver_take_route') };
  await c.query(migracion('0138_vueltas_para_tomar'));
  await c.query(migracion('0138_vueltas_para_tomar'));
  check('0138 se aplica encima de 0136 (y se puede volver a correr)', true);
  check('cambian driver_open_routes y driver_take_route', (await huella('driver_open_routes')) !== h0126.o && (await huella('driver_take_route')) !== h0126.t);

  const fx = await fixtures(c);
  const drv2User = await user(c, fx.org, 'driver', 'Miguel Peña prueba 0138');
  const drv2 = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [drv2User])).id;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${man}T${hm}:00-05:00`;
  const res = async (aux, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', $5) RETURNING id`,
    [aux, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar])).id;
  const vuelta = async (dir, start, stops, o = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, pool, organization_id, delegated_at)
        VALUES ($1, $2, 'planned', $3::timestamptz, $4, $5, $6) RETURNING id`,
      [o.driver || null, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', start, !!o.pool, fx.org, o.delegada ? new Date().toISOString() : null])).id;
    for (let i = 0; i < stops.length; i++) {
      const [x, hora] = stops[i];
      if (x && x.guest) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, guest_name, guest_place, guest_residence_id, stop_order, estimated_arrival_at) VALUES ($1, NULL, $2, $3, $4, $5, $6)`, [ra, x.guest, x.place || null, x.res || null, i + 1, hora]);
      else await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4)`, [ra, x, i + 1, hora]);
    }
    return ra;
  };
  const como = async (u, fn) => { await asUser(c, u, 'driver'); try { return await fn(); } finally { await asDb(); } };
  const abiertas = (u = fx.drvUser) => como(u, async () => (await one(`SELECT public.driver_open_routes() j`)).j);
  const tomar = (ra, u = fx.drvUser) => como(u, async () => {
    await c.query('SAVEPOINT sp_t');
    try { const r = (await one(`SELECT public.driver_take_route($1) j`, [ra])).j; await c.query('RELEASE SAVEPOINT sp_t'); return { ok: r }; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_t'); return { err: e }; }
  });

  // ── 1. Los sin cuenta se ven ────────────────────────────────────────────────
  console.log('\n1. driver_open_routes con o sin cuenta');
  // Su propia vuelta de las 5:00 (para el 'cruza').
  const rMia = await res(fx.vecino, 'sal', at('06:00'));
  await vuelta('sal', at('05:00'), [[rMia, at('05:10')]], { driver: fx.driver });
  const rL = await res(fx.aux, 'sal', at('10:00'));
  const raLK = await vuelta('sal', at('09:00'), [[rL, at('09:10')], [{ guest: 'Kriss Prueba', place: 'Campus Reservado' }, at('09:20')]], { pool: true });
  const raK = await vuelta('lle', at('13:00'), [[{ guest: 'Kriss Prueba', res: fx.llano }, at('13:40')]], { pool: true });
  const rCan = await res(fx.aux, 'sal', at('16:00'));
  const raCan = await vuelta('sal', at('15:00'), [[rCan, at('15:10')]], { pool: true });
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rCan]);
  const rX = await res(fx.vecino, 'sal', at('05:45'));
  const raCruza = await vuelta('sal', at('05:05'), [[rX, at('05:15')]], { pool: true });
  const lista = await abiertas();
  const de = (ra) => (lista || []).find((x) => x.id === ra);
  const v1 = de(raLK);
  check('la vuelta de Laura + Kriss trae a las dos', v1 && v1.stops.length === 2 && v1.stops[0].name === 'Laura Gómez' && v1.stops[1].name === 'Kriss Prueba', v1 && v1.stops);
  check('Kriss sale marcada sin cuenta y con su lugar escrito', v1 && v1.stops[1].guest === true && v1.stops[1].place === 'Campus Reservado' && v1.stops[0].guest === false, v1 && v1.stops[1]);
  const v2 = de(raK);
  check('la vuelta solo con Kriss: 1 persona, con el conjunto del catálogo', v2 && v2.stops.length === 1 && v2.stops[0].place === 'Quintas de Llanogrande', v2);
  check('la de una reserva cancelada no trae a nadie', de(raCan) && de(raCan).stops.length === 0, de(raCan));

  // ── 2. 'cruza' ──────────────────────────────────────────────────────────────
  console.log('\n2. cruza');
  check('la de las 5:05 se cruza con su vuelta de las 5:00', de(raCruza) && de(raCruza).cruza === true, de(raCruza));
  check('la de las 9:00 no', v1 && v1.cruza === false, v1 && v1.cruza);
  const lista2 = await abiertas(drv2User);
  check('para otro conductor (sin vueltas) la de las 5:05 no se cruza', (lista2.find((x) => x.id === raCruza) || {}).cruza === false);

  // ── 3. Tomar ────────────────────────────────────────────────────────────────
  console.log('\n3. driver_take_route');
  const t1 = await tomar(raCruza);
  check('la que se cruza se niega', !!t1.err && /se cruza con tu vuelta de las 5:00/.test(t1.err.message) && t1.err.hint === 'se_cruza', t1.err && [t1.err.message, t1.err.hint]);
  check('… y sigue libre', (await one(`SELECT driver_profile_id FROM public.route_assignments WHERE id = $1`, [raCruza])).driver_profile_id === null);
  const t2 = await tomar(raLK);
  check('la de las 9:00 sí se toma', !!t2.ok && t2.ok.id === raLK, t2.err && t2.err.message);
  const av = await q(`SELECT profile_id, title FROM public.notification_outbox WHERE dedupe_key LIKE $1`, ['take:' + raLK + ':%']);
  check('a Laura le llega «Carlos te recoge 🚗» (a Kriss no: no tiene app)', av.length === 1 && av[0].profile_id === fx.auxUser && av[0].title === 'Carlos te recoge 🚗', av);
  const t3 = await tomar(raLK, drv2User);
  check('otro conductor ya no la puede tomar', !!t3.err && /ya la tomó otro conductor/.test(t3.err.message), t3.err && t3.err.message);
  const t4 = await tomar(raCruza, drv2User);
  check('la de las 5:05 sí la toma otro conductor que está libre', !!t4.ok, t4.err && t4.err.message);
  const rD = await res(fx.vecino, 'sal', at('20:00'));
  const raDel = await vuelta('sal', at('19:00'), [[rD, at('19:10')]], { pool: true, delegada: true });
  const t5 = await tomar(raDel);
  check('la delegada: «la hace alguien de afuera»', !!t5.err && /alguien de afuera/.test(t5.err.message), t5.err && t5.err.message);
  check('la delegada no sale en la lista', !(await abiertas()).some((x) => x.id === raDel));
  const t6 = await tomar(raK);
  check('la llegada solo con Kriss (13:00) se toma', !!t6.ok, t6.err && t6.err.message);
  check('… y ya no sale en la lista', !(await abiertas()).some((x) => x.id === raK));

  // ── 4. Down ─────────────────────────────────────────────────────────────────
  console.log('\n4. Down');
  await c.query(reversa('0138_vueltas_para_tomar'));
  check('el down deja las dos EXACTAMENTE como en 0126', (await huella('driver_open_routes')) === h0126.o && (await huella('driver_take_route')) === h0126.t);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
