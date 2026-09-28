// Verificación de 0091 · Rendio Points: interruptor apagado por defecto,
// acreditación por la BASE (primer viaje entregado del referido, vecino ×2,
// cancelar con ≥ 2 h, calificar), idempotencia, canjes, privacidad y RLS.
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0091.mjs
//
// Con 0091 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };

// Corre una sentencia que DEBE fallar, sin tumbar la transacción. Devuelve el mensaje.
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}
// Igual que q() pero actuando como un usuario, y vuelve a postgres al final.
async function como(uid, role, sql, params) {
  await asUser(c, uid, role);
  try { return await q(sql, params); } finally { await asAdminDb(c); }
}
async function comoFalla(uid, role, sql, params) {
  await asUser(c, uid, role);
  try { return await debeFallar(sql, params); } finally { await asAdminDb(c); }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0091');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefe]);

  // Tripulante nuevo: conjunto (id) o, sin conjunto, un pin.
  const nuevoAux = async (nombre, residencia, org = fx.org) => {
    const uid = await user(c, org, 'auxiliar', nombre);
    const aux = residencia
      ? (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [uid, residencia])).id
      : (await one(`INSERT INTO public.auxiliar_profiles (profile_id, home_latitude, home_longitude) VALUES ($1, 6.15, -75.37) RETURNING id`, [uid])).id;
    return { uid, aux };
  };
  const reserva = async (aux, offset = "interval '1 day'", dir = 'home_to_airport') => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      now() + ${offset}) RETURNING id`, [aux, dir])).id;
  // Publica la reserva en una ruta con conductor; la recogida a `eta`.
  const publicar = async (res, eta = "interval '1 day' - interval '90 minutes'") => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
        SELECT $1, $2, r.direction, 'planned', now() + ${eta} - interval '20 minutes' FROM public.reservations r WHERE r.id = $3
        RETURNING id`, [fx.driver, fx.vehicle, res])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
        VALUES ($1, $2, 1, now() + ${eta})`, [ra, res]);
    return ra;
  };
  // Entrega por el camino REAL: el conductor con su RPC.
  const entregar = async (res) => {
    await asUser(c, fx.drvUser, 'driver');
    try { await q(`SELECT public.driver_set_reservation_status($1, 'delivered')`, [res]); } finally { await asAdminDb(c); }
  };
  const viajeEntregado = async (aux) => { const r = await reserva(aux); await publicar(r); await entregar(r); return r; };
  const saldo = async (aux) => (await one(`SELECT coalesce(sum(points),0)::int AS s FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1`, [aux])).s;
  const movs = async (aux, kind) => (await one(`SELECT count(*)::int AS n FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1 AND ($2::text IS NULL OR kind = $2)`, [aux, kind ?? null])).n;
  const encender = (on) => q(`UPDATE public.app_settings SET aux_points_enabled = $1 WHERE id = 'singleton'`, [on]);

  const laura = { uid: fx.auxUser, aux: fx.aux };           // Laura Gómez · El Olivar
  const vecina = { uid: fx.vecinoUser, aux: fx.vecino };    // Vecina de El Olivar · El Olivar

  // ----------------------------------------------------------------------------
  console.log('\n0. Estructura');
  const tablas = await q(`SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('aux_points_rewards','aux_referral_codes','aux_referrals','aux_points_redemptions','aux_points_ledger')`);
  check('las 5 tablas existen', tablas.length === 5, tablas.map(t => t.relname).join(','));
  check('las 5 con RLS encendida', tablas.length === 5 && tablas.every(t => t.relrowsecurity));
  const cols = await q(`SELECT table_name, array_agg(column_name::text) AS c FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('aux_points_rewards','aux_referral_codes','aux_referrals','aux_points_redemptions','aux_points_ledger') GROUP BY 1`);
  const tiene = (tb, col) => (cols.find(x => x.table_name === tb)?.c || []).includes(col);
  check('todas con created_at; las editables con updated_at + trigger (el libro y los códigos son de solo inserción)',
    ['aux_points_rewards', 'aux_referral_codes', 'aux_referrals', 'aux_points_redemptions', 'aux_points_ledger'].every(tb => tiene(tb, 'created_at'))
    && ['aux_points_rewards', 'aux_referrals', 'aux_points_redemptions'].every(tb => tiene(tb, 'updated_at'))
    && (await q(`SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('tr_aux_points_rewards_updated_at','tr_aux_referrals_updated_at','tr_aux_points_redemptions_updated_at')`)).length === 3,
    JSON.stringify(cols));
  const set = await one(`SELECT * FROM public.app_settings WHERE id = 'singleton'`);
  check('hay fila de ajustes', !!set);
  const def = await one(`SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='aux_points_enabled'`);
  check('aux_points_enabled nace en false', def && def.column_default === 'false', def && def.column_default);
  check('valores por defecto 40/80/20/2 h/5', set && set.aux_points_invite === 40 && set.aux_points_neighbor === 80
    && set.aux_points_cancel === 20 && set.aux_points_cancel_lead_hours === 2 && set.aux_points_rate === 5,
    set && JSON.stringify([set.aux_points_invite, set.aux_points_neighbor, set.aux_points_cancel, set.aux_points_cancel_lead_hours, set.aux_points_rate]));
  await encender(false);
  const rw = await q(`SELECT id, cost, soon, kind FROM public.aux_points_rewards ORDER BY sort`);
  check('vitrina: colega 180, directo 320 «Pronto», mensual 400, privado 600',
    JSON.stringify(rw.map(r => [r.id, r.cost, r.soon])) === JSON.stringify([['colega', 180, false], ['directo', 320, true], ['mensual', 400, false], ['privado', 600, false]]),
    JSON.stringify(rw));
  const plata = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name LIKE 'aux_points%' AND column_name ~* '(cop|price|peso|money|valor)'`);
  check('puntos no son plata: ninguna columna de pesos en las tablas de puntos', plata.length === 0, JSON.stringify(plata));
  const internas = ['aux_points_ensure_code(uuid)', 'aux_points_add(uuid,integer,text,text,uuid,text,uuid,uuid,uuid)',
    'aux_points_balance(uuid)', 'aux_points_on()', 'aux_points_display_name(text)', 'tg_aux_points_reservation()', 'tg_aux_points_stash_pickup()'];
  const privs = await q(`SELECT f, has_function_privilege('authenticated', ('public.' || f)::regprocedure, 'EXECUTE') AS a
      FROM unnest($1::text[]) f`, [internas]);
  check('las funciones internas NO las ejecuta authenticated', privs.every(p => p.a === false), JSON.stringify(privs.filter(p => p.a)));
  const publicas = ['aux_points_my_summary()', 'aux_points_my_code()', 'aux_points_my_referrals()', 'aux_points_claim_referral(text)',
    'aux_points_my_goal()', 'aux_points_redeem(text,text)', 'aux_points_admin_redemptions(text)',
    'aux_points_admin_decide(uuid,text,text)', 'aux_points_admin_adjust(uuid,integer,text)', 'aux_points_admin_balances()'];
  const pp = await q(`SELECT f, has_function_privilege('authenticated', ('public.' || f)::regprocedure, 'EXECUTE') AS a,
      has_function_privilege('anon', ('public.' || f)::regprocedure, 'EXECUTE') AS b FROM unnest($1::text[]) f`, [publicas]);
  check('las 10 RPC: authenticated sí, anon no', pp.length === 10 && pp.every(p => p.a && !p.b), JSON.stringify(pp.filter(p => !p.a || p.b)));
  const trg = await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('tr_aux_points_reservation','tr_aux_points_stash_pickup')`);
  check('los dos triggers existen', trg.length === 2, trg.map(t => t.tgname).join(','));

  // ----------------------------------------------------------------------------
  console.log('\n1. Apagado (por defecto): nada acredita, nada se reclama, nada se canjea');
  let r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`);
  check('mi código con el programa apagado → NULL (no se crea)', r[0].c === null, r[0].c);
  let err = await comoFalla(vecina.uid, 'auxiliar', `SELECT public.aux_points_claim_referral('LAURA-OLV')`);
  check('reclamar código apagado → error', err && /no está activo/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega')`);
  check('canjear apagado → error', err && /no está activo/.test(err), err);
  // Una referida guardada a mano (como si se hubiera reclamado antes de apagar).
  await q(`INSERT INTO public.aux_referrals (referred_aux_id, referrer_aux_id, code) VALUES ($1, $2, 'LAURA-OLV')`, [vecina.aux, laura.aux]);
  await viajeEntregado(vecina.aux);
  check('entrega del referido con el programa apagado → Laura sigue en 0', await saldo(laura.aux) === 0, await saldo(laura.aux));
  r = await one(`SELECT credited_at FROM public.aux_referrals WHERE referred_aux_id = $1`, [vecina.aux]);
  check('…y la referida queda sin acreditar', r.credited_at === null);
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_summary() AS s`);
  check('mi resumen apagado → enabled=false y saldo 0', r[0].s && r[0].s.enabled === false && r[0].s.balance === 0, JSON.stringify(r[0].s));

  await encender(true);

  // ----------------------------------------------------------------------------
  console.log('\n2. Código de referido');
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`);
  check('Laura Gómez en El Olivar → LAURA-OLV', r[0].c === 'LAURA-OLV', r[0].c);
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`);
  check('pedirlo otra vez devuelve el mismo', r[0].c === 'LAURA-OLV', r[0].c);
  const laura2 = await nuevoAux('Laura Restrepo Díaz', fx.olivar);
  r = await como(laura2.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`);
  check('otra Laura del mismo conjunto → LAURA-OLV2 (sin choque)', r[0].c === 'LAURA-OLV2', r[0].c);
  const andres = await nuevoAux('Andrés Cano Ruiz', null);
  r = await como(andres.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`);
  check('sin conjunto → primer apellido (ANDRES-CAN)', r[0].c === 'ANDRES-CAN', r[0].c);

  // ----------------------------------------------------------------------------
  console.log('\n3. Primer viaje ENTREGADO del referido (vecino = ×2), sin doble crédito');
  await viajeEntregado(vecina.aux);
  check('la vecina (mismo conjunto) entrega → Laura +80', await saldo(laura.aux) === 80, await saldo(laura.aux));
  r = await one(`SELECT kind, note, referred_aux_id FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1`, [laura.aux]);
  check('movimiento referral_neighbor con «cuenta doble»', r.kind === 'referral_neighbor' && /cuenta doble/.test(r.note) && r.referred_aux_id === vecina.aux, JSON.stringify(r));
  await viajeEntregado(vecina.aux);
  check('otra entrega de la vecina → NO acredita de nuevo', await saldo(laura.aux) === 80 && await movs(laura.aux) === 1, await saldo(laura.aux));
  r = await one(`SELECT credited_points, neighbor FROM public.aux_referrals WHERE referred_aux_id = $1`, [vecina.aux]);
  check('la referida queda acreditada (80, vecino)', r.credited_points === 80 && r.neighbor === true, JSON.stringify(r));
  const rep = await one(`SELECT public.aux_points_add($1, 80, 'referral', 'ref:' || $2::text) AS x`, [laura.aux, vecina.aux]);
  check('aux_points_add con la misma dedupe_key → false (idempotente)', rep.x === false, rep.x);

  // ----------------------------------------------------------------------------
  console.log('\n4. Reclamar un código');
  const diana = await nuevoAux('Diana Restrepo Mejía', fx.llano);
  r = await como(diana.uid, 'auxiliar', `SELECT public.aux_points_claim_referral(' laura-olv ') AS x`);
  check('Diana reclama « laura-olv » (minúsculas, espacios) → ok', r[0].x && r[0].x.ok === true, JSON.stringify(r[0].x));
  err = await comoFalla(diana.uid, 'auxiliar', `SELECT public.aux_points_claim_referral('LAURA-OLV2')`);
  check('reclamar dos veces → error', err && /Ya registraste/.test(err), err);
  const juan = await nuevoAux('Juan Pablo Ríos Gómez', fx.llano);
  const codJuan = (await como(juan.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`))[0].c;
  err = await comoFalla(juan.uid, 'auxiliar', `SELECT public.aux_points_claim_referral($1)`, [codJuan]);
  check('mi propio código → error', err && /propio código/.test(err), err);
  const codDiana = (await como(diana.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`))[0].c;
  check('Diana Restrepo en Quintas de Llanogrande → DIANA-LLN', codDiana === 'DIANA-LLN', codDiana);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_claim_referral($1)`, [codDiana]);
  check('«yo te invito, tú me invitas» → error', err && /invitaste a esa persona/.test(err), err);
  const sara = await nuevoAux('Sara Mejía Soto', fx.olivar);
  await viajeEntregado(sara.aux);
  err = await comoFalla(sara.uid, 'auxiliar', `SELECT public.aux_points_claim_referral('LAURA-OLV')`);
  check('quien ya tiene un viaje entregado → error', err && /primer viaje/.test(err), err);
  err = await comoFalla(juan.uid, 'auxiliar', `SELECT public.aux_points_claim_referral('NADIE-XYZ')`);
  check('código que no existe → error', err && /no existe/.test(err), err);
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra org', 'otra-' || substr(md5(random()::text),1,6)) RETURNING id`)).id;
  const res2 = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'Torres del Bosque', 6.15, -75.38, 'Rionegro') RETURNING id`, [org2])).id;
  const foraneo = await nuevoAux('Pedro Otra Org', res2, org2);
  const codFor = (await como(foraneo.uid, 'auxiliar', `SELECT public.aux_points_my_code() AS c`))[0].c;
  err = await comoFalla(juan.uid, 'auxiliar', `SELECT public.aux_points_claim_referral($1)`, [codFor]);
  check('código de otra organización → «no existe»', err && /no existe/.test(err), err);
  err = await comoFalla(jefe, 'admin', `SELECT public.aux_points_claim_referral('LAURA-OLV')`);
  check('el jefe no puede reclamar códigos', err && /Solo un tripulante/.test(err), err);

  await viajeEntregado(diana.aux);
  check('Diana (otro conjunto) entrega → Laura +40', await saldo(laura.aux) === 120, await saldo(laura.aux));
  r = await one(`SELECT kind, note FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1 AND referred_aux_id = $2`, [laura.aux, diana.aux]);
  check('movimiento referral con «Diana R.» y sin «cuenta doble»', r.kind === 'referral' && r.note === 'Diana R.', JSON.stringify(r));
  await como(andres.uid, 'auxiliar', `SELECT public.aux_points_claim_referral('LAURA-OLV')`);

  // ----------------------------------------------------------------------------
  console.log('\n5. «Invitaste a»: solo quien usó MI código, nombre + inicial');
  r = await como(laura.uid, 'auxiliar', `SELECT * FROM public.aux_points_my_referrals()`);
  const nombres = r.map(x => x.display_name).sort();
  check('Laura ve exactamente a sus 3 invitados', JSON.stringify(nombres) === JSON.stringify(['Andrés C.', 'Diana R.', 'Vecina E.']), JSON.stringify(nombres));
  check('Diana: ok +40 · Vecina: ok +80 · Andrés: wait',
    r.find(x => x.display_name === 'Diana R.')?.status === 'ok' && r.find(x => x.display_name === 'Diana R.')?.points === 40
    && r.find(x => x.display_name === 'Vecina E.')?.points === 80 && r.find(x => x.display_name === 'Andrés C.')?.status === 'wait',
    JSON.stringify(r));
  check('iniciales DR', r.find(x => x.display_name === 'Diana R.')?.initials === 'DR', r.find(x => x.display_name === 'Diana R.')?.initials);
  const keys = Object.keys(r[0] || {}).sort().join(',');
  check('no trae id, correo ni teléfono', keys === 'claimed_at,credited_at,display_name,initials,neighbor,points,status', keys);
  r = await como(diana.uid, 'auxiliar', `SELECT * FROM public.aux_points_my_referrals()`);
  check('Diana (referida, no invitó a nadie) ve 0', r.length === 0, r.length);
  r = await como(laura2.uid, 'auxiliar', `SELECT * FROM public.aux_points_my_referrals()`);
  check('la otra Laura no ve los invitados de Laura', r.length === 0, r.length);

  // ----------------------------------------------------------------------------
  console.log('\n6. RLS: nadie ve el saldo ni los movimientos de otro');
  r = await como(vecina.uid, 'auxiliar', `SELECT count(*)::int n FROM public.aux_points_ledger`);
  check('la vecina no ve los movimientos de Laura', r[0].n === 0, r[0].n);
  r = await como(laura.uid, 'auxiliar', `SELECT count(*)::int n, count(*) FILTER (WHERE auxiliar_profile_id <> $1)::int ajenos FROM public.aux_points_ledger`, [laura.aux]);
  check('Laura ve solo los suyos', r[0].n === await movs(laura.aux) && r[0].ajenos === 0, JSON.stringify(r[0]));
  r = await como(vecina.uid, 'auxiliar', `SELECT count(*)::int n FROM public.aux_referral_codes`);
  check('la vecina no ve códigos ajenos', r[0].n === 0, r[0].n);
  r = await como(laura.uid, 'auxiliar', `SELECT count(*)::int n FROM public.aux_referrals`);
  check('quien invita NO lee la tabla de referidos (solo por la RPC)', r[0].n === 0, r[0].n);
  r = await como(diana.uid, 'auxiliar', `SELECT count(*)::int n FROM public.aux_referrals`);
  check('la referida ve SU fila', r[0].n === 1, r[0].n);
  r = await como(vecina.uid, 'auxiliar', `SELECT public.aux_points_my_summary() AS s`);
  check('el resumen de la vecina es el suyo (0)', r[0].s.balance === 0 && r[0].s.enabled === true, JSON.stringify(r[0].s));
  err = await comoFalla(laura.uid, 'auxiliar', `INSERT INTO public.aux_points_ledger (auxiliar_profile_id, points, kind, dedupe_key) VALUES ($1, 9999, 'adjust', 'hack')`, [laura.aux]);
  check('INSERT directo al libro → denegado', err && /permission denied/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `UPDATE public.aux_points_ledger SET points = 9999 WHERE auxiliar_profile_id = $1`, [laura.aux]);
  check('UPDATE directo al libro → denegado', err && /permission denied/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `INSERT INTO public.aux_referrals (referred_aux_id, referrer_aux_id, code) VALUES ($1, $2, 'X')`, [laura2.aux, laura.aux]);
  check('INSERT directo a referidos → denegado', err && /permission denied/.test(err), err);
  r = await como(laura.uid, 'auxiliar', `WITH u AS (UPDATE public.aux_points_rewards SET cost = 1 WHERE id = 'colega' RETURNING 1) SELECT count(*)::int n FROM u`);
  check('el tripulante no cambia la vitrina (0 filas)', r[0].n === 0, r[0].n);
  const jefe2 = await user(c, org2, 'admin', 'Jefe de otra org');
  r = await como(jefe2, 'admin', `SELECT count(*)::int n FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1`, [laura.aux]);
  check('el jefe de otra organización no ve el libro de Laura', r[0].n === 0, r[0].n);
  r = await como(jefe, 'admin', `SELECT count(*)::int n FROM public.aux_points_ledger WHERE auxiliar_profile_id = $1`, [laura.aux]);
  check('la jefa de su organización sí', r[0].n === await movs(laura.aux), r[0].n);
  err = await debeFallar(`SET LOCAL ROLE anon; SELECT public.aux_points_my_summary()`);
  await asAdminDb(c);
  check('anon no ejecuta mi resumen', err && /permission denied/.test(err), err);

  // ----------------------------------------------------------------------------
  console.log('\n7. Avisar a tiempo (cancelar con ≥ 2 h de la recogida publicada)');
  let antes = await saldo(laura.aux);
  const rc1 = await reserva(laura.aux); await publicar(rc1);   // recogida mañana
  r = await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_cancel_reservation($1, 'ya no viajo') AS x`, [rc1]);
  check('cancelación por la RPC real → ok', r[0].x && r[0].x.ok === true);
  check('…+20', await saldo(laura.aux) === antes + 20, `${antes} → ${await saldo(laura.aux)}`);
  r = await one(`SELECT l.note, rv.calculated_pickup_at FROM public.aux_points_ledger l JOIN public.reservations rv ON rv.id = l.reservation_id WHERE l.dedupe_key = 'cancel:' || $1::text`, [rc1]);
  check('nota «Con N h de anticipación» (y la reserva ya perdió la hora: por eso el stash)', r && /^Con \d+ h de anticipación$/.test(r.note) && r.calculated_pickup_at === null, JSON.stringify(r));
  antes = await saldo(laura.aux);
  const rc2 = await reserva(laura.aux, "interval '3 hours'"); await publicar(rc2, "interval '1 hour'");
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_cancel_reservation($1, NULL)`, [rc2]);
  check('recogida en 1 h → NO suma', await saldo(laura.aux) === antes, await saldo(laura.aux));
  const rc3 = await reserva(laura.aux, "interval '2 days'");
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_cancel_reservation($1, NULL)`, [rc3]);
  check('sin hora publicada (no hay asiento que liberar) → NO suma', await saldo(laura.aux) === antes, await saldo(laura.aux));
  const rc4 = await reserva(laura.aux); await publicar(rc4);
  await como(jefe, 'admin', `UPDATE public.reservations SET cancelled_at = now(), cancelled_by = $2, status_h2a = 'cancelled' WHERE id = $1`, [rc4, jefe]);
  check('la cancela el jefe → NO suma para el tripulante', await saldo(laura.aux) === antes, await saldo(laura.aux));

  // ----------------------------------------------------------------------------
  console.log('\n8. Calificar (primera calificación de un viaje entregado)');
  antes = await saldo(laura.aux);
  const rr1 = await viajeEntregado(laura.aux);
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_rate_reservation($1, 5::smallint, ARRAY['Puntual'])`, [rr1]);
  check('califica un viaje entregado → +5', await saldo(laura.aux) === antes + 5, `${antes} → ${await saldo(laura.aux)}`);
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_rate_reservation($1, 4::smallint, NULL)`, [rr1]);
  check('re-calificar el mismo → NO suma otra vez', await saldo(laura.aux) === antes + 5, await saldo(laura.aux));
  const rr2 = await reserva(laura.aux);
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_rate_reservation($1, 5::smallint, NULL)`, [rr2]);
  check('calificar un viaje NO entregado → no suma', await saldo(laura.aux) === antes + 5, await saldo(laura.aux));

  // ----------------------------------------------------------------------------
  console.log('\n9. Canjear (descuenta ya, queda pendiente; el jefe cumple o rechaza)');
  const s0 = await saldo(laura.aux);   // 80 + 40 + 20 + 5 = 145
  check('saldo de Laura hasta aquí = 145', s0 === 145, s0);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega')`);
  check('no alcanza (145 < 180) → «Te faltan 35 pts»', err && /Te faltan 35 pts/.test(err), err);
  err = await comoFalla(jefe, 'admin', `SELECT public.aux_points_admin_adjust($1, 100, '  ')`, [laura.aux]);
  check('ajuste sin nota → error', err && /por qué/.test(err), err);
  err = await comoFalla(jefe, 'admin', `SELECT public.aux_points_admin_adjust($1, -1000, 'quitar')`, [laura.aux]);
  check('ajuste que deja el saldo en negativo → error', err && /negativo/.test(err), err);
  err = await comoFalla(jefe2, 'admin', `SELECT public.aux_points_admin_adjust($1, 100, 'regalo')`, [laura.aux]);
  check('ajuste del jefe de otra organización → error', err && /no existe/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_admin_adjust($1, 100, 'yo mismo')`, [laura.aux]);
  check('el tripulante no se ajusta a sí mismo', err && /Solo el jefe/.test(err), err);
  r = await como(jefe, 'admin', `SELECT public.aux_points_admin_adjust($1, 100, 'Bono de bienvenida') AS x`, [laura.aux]);
  check('ajuste del jefe +100 → 245', r[0].x.balance === 245 && await saldo(laura.aux) === 245, JSON.stringify(r[0].x));
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('directo')`);
  check('Directo («Pronto») no se canjea', err && /pronto/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('no-existe')`);
  check('un canje que no existe → error', err && /no está disponible/.test(err), err);
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [laura.uid]);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega')`);
  check('suspendida no canjea', err && /suspendida/.test(err), err);
  await q(`UPDATE public.profiles SET is_active = true WHERE id = $1`, [laura.uid]);
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega', 'para mi compañera') AS x`);
  const can1 = r[0].x.redemption_id;
  check('canje colega → ok, saldo 65', r[0].x.ok && r[0].x.balance === 65 && await saldo(laura.aux) === 65, JSON.stringify(r[0].x));
  r = await one(`SELECT status, cost, reward_title FROM public.aux_points_redemptions WHERE id = $1`, [can1]);
  check('queda pendiente con su título y costo', r.status === 'pending' && r.cost === 180 && r.reward_title === 'Traer a un colega gratis', JSON.stringify(r));
  r = await q(`SELECT profile_id, url, body FROM public.notification_outbox WHERE dedupe_key LIKE 'pts-redeem:' || $1::text || ':%'`, [can1]);
  check('aviso a la jefa en notification_outbox (/#/puntos)', r.length === 1 && r[0].profile_id === jefe && r[0].url === '/#/puntos' && /Laura G\./.test(r[0].body), JSON.stringify(r));
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega')`);
  check('segundo canje sin saldo → error (nunca negativo)', err && /Te faltan/.test(err), err);
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_summary() AS s`);
  check('mi resumen: 65 pts y 1 canje por cumplir', r[0].s.balance === 65 && r[0].s.pending_count === 1 && r[0].s.invited_count === 3 && r[0].s.invited_done === 2, JSON.stringify(r[0].s));

  r = await como(jefe, 'admin', `SELECT * FROM public.aux_points_admin_redemptions()`);
  check('la jefa ve el canje pendiente con nombre y saldo', r.length === 1 && r[0].id === can1 && r[0].full_name === 'Laura Gómez' && r[0].balance === 65 && r[0].reward_kind === 'guest_seat', JSON.stringify(r[0]));
  r = await como(jefe2, 'admin', `SELECT * FROM public.aux_points_admin_redemptions()`);
  check('el jefe de otra organización no lo ve', r.length === 0, r.length);
  err = await comoFalla(jefe2, 'admin', `SELECT public.aux_points_admin_decide($1, 'fulfill')`, [can1]);
  check('…ni lo decide', err && /no existe/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_admin_redemptions()`);
  check('el tripulante no lista canjes del jefe', err && /Solo el jefe/.test(err), err);
  err = await comoFalla(laura.uid, 'auxiliar', `SELECT public.aux_points_admin_decide($1, 'fulfill')`, [can1]);
  check('el tripulante no decide su canje', err && /Solo el jefe/.test(err), err);
  err = await comoFalla(jefe, 'admin', `SELECT public.aux_points_admin_decide($1, 'reject', '')`, [can1]);
  check('rechazar sin motivo → error', err && /motivo/.test(err), err);
  r = await como(jefe, 'admin', `SELECT public.aux_points_admin_decide($1, 'reject', 'Ese día no hay cupo') AS x`, [can1]);
  check('rechazar con motivo → devuelve los puntos (245)', r[0].x.status === 'rejected' && await saldo(laura.aux) === 245, JSON.stringify(r[0].x));
  r = await one(`SELECT kind, points, note FROM public.aux_points_ledger WHERE dedupe_key = 'refund:' || $1::text`, [can1]);
  check('movimiento redeem_refund +180 con el motivo', r && r.kind === 'redeem_refund' && r.points === 180 && /no hay cupo/.test(r.note), JSON.stringify(r));
  err = await comoFalla(jefe, 'admin', `SELECT public.aux_points_admin_decide($1, 'fulfill')`, [can1]);
  check('decidir dos veces → error', err && /ya estaba decidido/.test(err), err);
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_redeem('colega') AS x`);
  const can2 = r[0].x.redemption_id;
  r = await como(jefe, 'admin', `SELECT public.aux_points_admin_decide($1, 'fulfill') AS x`, [can2]);
  check('cumplir → fulfilled, el saldo no cambia (65)', r[0].x.status === 'fulfilled' && await saldo(laura.aux) === 65, JSON.stringify(r[0].x));
  r = await como(laura.uid, 'auxiliar', `SELECT status, decision_note FROM public.aux_points_redemptions ORDER BY requested_at`);
  check('Laura ve sus canjes (rechazado con motivo, cumplido)', r.length === 2 && r.some(x => x.status === 'rejected' && x.decision_note === 'Ese día no hay cupo') && r.some(x => x.status === 'fulfilled'), JSON.stringify(r));
  r = await como(jefe, 'admin', `SELECT * FROM public.aux_points_admin_balances()`);
  const fila = r.find(x => x.auxiliar_profile_id === laura.aux);
  check('saldos del jefe: Laura 65, 3 invitados (2 hechos), su código', fila && fila.balance === 65 && fila.invited === 3 && fila.invited_done === 2 && fila.code === 'LAURA-OLV', JSON.stringify(fila));
  check('saldos del jefe: nadie de otra organización', !r.some(x => x.auxiliar_profile_id === foraneo.aux));

  // ----------------------------------------------------------------------------
  console.log('\n10. Meta anónima del conjunto');
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_goal() AS g`);
  check('sin meta cargada → NULL (no hay tarjeta)', r[0].g === null, JSON.stringify(r[0].g));
  await q(`UPDATE public.app_settings SET aux_points_goal_target = 10, aux_points_goal_text = 'Entre más vecinos, más fácil armar tu ruta' WHERE id = 'singleton'`);
  const esperados = (await one(`SELECT count(*)::int n FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
      WHERE ap.residence_id = $1 AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false`, [fx.olivar])).n;
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_goal() AS g`);
  check(`con meta: El Olivar · ${esperados} de 10 + el texto del jefe`, r[0].g && r[0].g.residence_name === 'El Olivar' && r[0].g.count === esperados && r[0].g.target === 10 && /más vecinos/.test(r[0].g.text), JSON.stringify(r[0].g));
  check('la meta es solo un número (sin nombres)', r[0].g && Object.keys(r[0].g).sort().join(',') === 'count,residence_name,target,text', Object.keys(r[0].g || {}).join(','));
  r = await como(andres.uid, 'auxiliar', `SELECT public.aux_points_my_goal() AS g`);
  check('sin conjunto → NULL', r[0].g === null);

  // ----------------------------------------------------------------------------
  console.log('\n11. Ajustes: rangos');
  err = await debeFallar(`UPDATE public.app_settings SET aux_points_invite = -1 WHERE id = 'singleton'`);
  check('puntos negativos en ajustes → rechazado', err && /aux_points_values_range/.test(err), err);
  err = await debeFallar(`UPDATE public.app_settings SET aux_points_goal_text = repeat('x', 200) WHERE id = 'singleton'`);
  check('texto de meta de más de 160 → rechazado', err && /aux_points_goal_range/.test(err), err);
  r = await como(jefe, 'admin', `WITH u AS (UPDATE public.aux_points_rewards SET cost = 200 WHERE id = 'colega' RETURNING cost) SELECT cost FROM u`);
  check('la jefa cambia el costo de la vitrina', r.length === 1 && r[0].cost === 200, JSON.stringify(r));
  err = await comoFalla(jefe, 'admin', `UPDATE public.aux_points_rewards SET soon = false WHERE id = 'directo'`);
  check('…pero no quita el «Pronto» de Directo (columna sin permiso)', err && /permission denied/.test(err), err);

  // ----------------------------------------------------------------------------
  console.log('\n12. Apagar de nuevo: se conserva lo ganado y deja de acreditar');
  await encender(false);
  const antesOff = await saldo(laura.aux);
  await viajeEntregado(andres.aux);
  check('el invitado pendiente entrega con el programa apagado → no suma', await saldo(laura.aux) === antesOff, await saldo(laura.aux));
  const rr3 = await viajeEntregado(laura.aux);
  await como(laura.uid, 'auxiliar', `SELECT public.auxiliar_rate_reservation($1, 5::smallint, NULL)`, [rr3]);
  check('calificar apagado → no suma', await saldo(laura.aux) === antesOff, await saldo(laura.aux));
  r = await como(laura.uid, 'auxiliar', `SELECT public.aux_points_my_summary() AS s`);
  check('mi resumen apagado conserva el saldo', r[0].s.enabled === false && r[0].s.balance === antesOff, JSON.stringify(r[0].s));
  await encender(true);
  await viajeEntregado(andres.aux);
  check('al volver a encender, la siguiente entrega del pendiente sí acredita (+40)', await saldo(laura.aux) === antesOff + 40, await saldo(laura.aux));
} catch (e) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
